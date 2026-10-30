/*
 * Wave executor of an adventure run.
 *
 * Takes the waves of a started run one after the other through
 * Gate -> Position -> Supply (-> Unload -> Supply) -> Load -> Verify ->
 * Reach (-> Settle -> Reach) -> Attack -> Confirm. plan() does one step per
 * call. The scheduler only calls it while no adventures queue entry is
 * pending, so every attempt a step started has finished (or was dropped by a
 * queue reset) when the next step runs. Each step therefore observes the game
 * first and never relies on a callback having fired.
 *
 * Every order runs through S.core.actions.attempt with the existing core
 * defs. The round handling (results kept in memory on runState.round, late
 * callbacks dropped) and the Supply -> Unload -> Load -> Verify flow are
 * shared with the load at home and live in the loader; this file passes
 * the wave steps to them.
 *
 * Attacks and camp buffs are paced by the 'adventures.attack' queue action.
 * The battle window sends the first line at once and each later line its own
 * time after the previous send. The kernel delay is a gap after an entry, so
 * the pacer re-enqueues itself and compares wall time instead. The sent
 * marker of a line is persisted before its packet goes out, so a gap is
 * always measured from a real send and a reload never sends a line twice: a
 * line sent but not seen pauses the run until the user has looked.
 *
 * A wave is never skipped. Every failed check or timeout pauses with the
 * wave, general, target and reason; Resume re-enters Gate of the same wave.
 * After the last wave is confirmed the run hands over to the end of the
 * map (RunStep.PackStar); the series steps run elsewhere.
 *
 * Bundle slot: module file; top level assigns S.modules.adventures.executor
 * and registers the pacer queue action; state, loader, watcher and every
 * core are read at call time.
 */

(function (S) {

    if (!S.modules.adventures) S.modules.adventures = {};

    var PACE_ACTION = 'adventures.attack';

    // Starting values, to be tuned in game.
    var GATE_MISSING_MS   = 60000;     // a field general absent this long pauses
    var GATE_BUSY_MS      = 1800000;   // a field general busy this long pauses
    var SETTLE_TICKS      = 2;         // settled plan() calls before a blocker pauses
    var SETTLE_MAX_MS     = 900000;    // Settle gives up after this long
    var PACE_MS           = 500;       // pacer poll gap

    var CATEGORY = 'adventures';

    function has(obj, key) {
        return Object.prototype.hasOwnProperty.call(obj, key);
    }

    function st() {
        return S.modules.adventures.state;
    }

    function now() {
        return S.modules.adventures.state.now();
    }

    // loader.js loads after this file in name order.
    function ld() {
        return S.modules.adventures.loader;
    }

    function stepName(step) {
        return st().stepName(step);
    }

    // ---- Wave lines ---------------------------------------------------------

    // Parsed lines of the run's current wave, cached for the wave by the
    // loader together with the loadout check against the run's keys.
    function linesFor(r) {
        return ld().linesOf(r, r.paths[r.waveIndex], r.waveIndex, 'wave');
    }

    // The run's record of a line; created on first use. sentOnce stays set
    // when Resume clears sentAt, so a camp that vanished after the line went
    // out can still be counted as this line's win.
    function lineRec(r, key) {
        if (!r.lines) r.lines = {};
        if (!has(r.lines, key)) r.lines[key] = { sentAt: null, seen: false, sentOnce: false };
        return r.lines[key];
    }

    // A line that went out once and whose target camp is gone from the map
    // it was sent on: the attack (or a later one on the same camp) won, so
    // it is marked seen instead of blocking Reach or being sent again.
    // Returns true when it marked the line.
    function goneAfterSend(r, l, inv) {
        if (!r.lines || !has(r.lines, l.key)) return false;
        var rec = r.lines[l.key];
        if (rec.seen || rec.sentOnce !== true) return false;
        S.core.buildings.invalidate();
        if (S.core.zone.id() !== r.zoneId || S.core.buildings.byGrid(l.target)) return false;
        rec.seen = true;
        st().save();
        S.kernel.warn(CATEGORY, st().waveLabel() + ': camp ' + targetText(l) + ' of ' + who(l, inv) +
            ' gone after an earlier send; counted as seen');
        return true;
    }

    function isSeen(r, key) {
        return !!(r.lines && has(r.lines, key) && r.lines[key].seen === true);
    }

    function isSent(r, key) {
        if (!r.lines || !has(r.lines, key)) return false;
        return r.lines[key].seen === true || r.lines[key].sentAt !== null;
    }

    function isSeqKind(line) {
        return line.kind === S.BattleLine.Attack || line.kind === S.BattleLine.Buff;
    }

    // Attack and buff lines of a wave file, and how many of them went out.
    // Exported so a progress display shares the executor's own tests.
    function attackCount(r, lines) {
        var out = { sent: 0, total: 0 };
        for (var i = 0; i < lines.length; i++) {
            if (!isSeqKind(lines[i])) continue;
            out.total++;
            if (isSent(r, lines[i].key)) out.sent++;
        }
        return out;
    }

    // The views every step works on. open: lines still to act on (a speed
    // buff line never is, the template horseshoe applies instead; an attack
    // or buff already seen is done). seq: every attack and buff line in
    // parsed order, seen or not, so a line verified early never shifts the
    // gap base of a later one.
    function view(r, lines) {
        var L = S.BattleLine;
        var w = { all: lines, open: [], field: [], stars: [], seq: [], supply: null };
        for (var i = 0; i < lines.length; i++) {
            var l = lines[i];
            if (l.kind === L.Star) w.stars.push(l);
            if (isSeqKind(l)) w.seq.push(l);
            if (l.kind === L.SpeedBuff) continue;
            if (isSeqKind(l) && isSeen(r, l.key)) continue;
            w.open.push(l);
            // Attack and Move lines carry troops and must stand on their grid.
            if (l.kind === L.Attack || l.kind === L.Move) w.field.push(l);
        }
        w.supply = S.core.battles.supplyWave(w.open);
        return w;
    }

    function gen(inv, key) {
        return ld().gen(inv, key);
    }

    function who(line, inv) {
        var g = gen(inv, line.key);
        var name = (g && g.name) || line.name || '';
        return (name ? name + ' ' : '') + '(' + line.key + ')';
    }

    function targetText(line) {
        return line.targetName ? line.targetName + ' (' + line.target + ')' : String(line.target);
    }

    // orders.star counts a general that left the list as success, and the
    // inventory lists only the viewed map's generals, so absence after a star
    // is the expected end state.
    function starDone(line, inv) {
        var g = gen(inv, line.key);
        return !g || !(typeof g.grid === 'number' && g.grid > 0);
    }

    function spec(key) {
        return S.core.specialists.refind(key).spec;
    }

    function attacking(key) {
        var s = spec(key);
        return !!s && S.core.specialists.orders.taskKind(s) === S.GeneralTask.Attack;
    }

    // ---- Pause helpers --------------------------------------------------------

    function pause(reason, message, line, inv) {
        st().pause(reason, message, line ? { general: who(line, inv), target: line.target !== null ? line.target : line.grid } : null);
    }

    // ---- Steps ----------------------------------------------------------------

    function gate(r, w, inv) {
        var missing = null;
        var busy = null;
        for (var i = 0; i < w.field.length; i++) {
            var g = gen(inv, w.field[i].key);
            if (!g) { if (!missing) missing = w.field[i]; }
            else if (!(g.idle && !g.travelling)) { if (!busy) busy = w.field[i]; }
        }
        var waited = now() - r.since;
        if (missing) {
            // Called on every pass, so the grace runs even while waited is
            // already over its limit, which it is on a re-entered Gate.
            var gone = ld().missingLong(r, missing.key);
            if (gone && waited > GATE_MISSING_MS) {
                pause(S.RunPause.GeneralMissing, who(missing, inv) + ' is not on the island', missing, inv);
            }
            return;
        }
        if (busy) {
            if (waited > GATE_BUSY_MS) {
                pause(S.RunPause.GeneralBusy, who(busy, inv) + ' has been busy for ' +
                    Math.round(waited / 60000) + ' min', busy, inv);
            }
            return;
        }
        st().go(S.WaveStep.Position, 'generals ready');
    }

    // Field lines whose general is off its grid but cannot be placed there.
    function notPlaceable(w, inv) {
        for (var i = 0; i < w.field.length; i++) {
            var l = w.field[i];
            var g = gen(inv, l.key);
            if (!g || g.grid === l.grid) continue;
            var s = spec(l.key);
            if (s && !S.core.specialists.orders.isPlaceable(s, l.grid)) {
                return { key: l.key, general: who(l, inv), target: l.grid, reason: 'not placeable at ' + l.grid };
            }
        }
        return null;
    }

    function position(r, w, inv) {
        var i, l, g;
        var moves = [];
        var stars = [];
        var moving = null;
        for (i = 0; i < w.field.length; i++) {
            l = w.field[i];
            g = gen(inv, l.key);
            if (!g) {
                if (!ld().missingLong(r, l.key)) return;
                pause(S.RunPause.GeneralMissing, who(l, inv) + ' is not on the island', l, inv);
                return;
            }
            if (g.grid === l.grid) continue;
            moves.push(l);
            if (!(g.idle && !g.travelling) && !moving) moving = l;
        }
        for (i = 0; i < w.stars.length; i++) {
            l = w.stars[i];
            if (starDone(l, inv)) continue;
            stars.push(l);
            g = gen(inv, l.key);
            if (!(g.idle && !g.travelling) && !moving) moving = l;
        }
        if (!moves.length && !stars.length) {
            st().go(S.WaveStep.Supply, 'generals on their grids');
            return;
        }
        // A verified move only means the walk began; wait for it to end
        // rather than order a busy general again.
        if (moving) {
            if (now() - r.since > GATE_BUSY_MS) {
                pause(S.RunPause.GeneralBusy, who(moving, inv) + ' did not reach its grid', moving, inv);
            }
            return;
        }
        var next = ld().settleRound(r, S.WaveStep.Position, function (f) {
            st().pause(S.RunPause.PositionFailed, 'order for ' + f.key + ' failed: ' + f.reason, { general: f.key });
        }, 'positioning');
        if (next !== 'new') return;

        var blocked = notPlaceable(w, inv);
        if (blocked) {
            r.settleFrom = S.WaveStep.Position;
            r.blocker = blocked;
            st().go(S.WaveStep.Settle, blocked.general + ' ' + blocked.reason);
            return;
        }
        var round = ld().startRound(r, S.WaveStep.Position, []);
        for (i = 0; i < moves.length; i++) {
            ld().attempt(round, moves[i].key, S.core.specialists.orders.move(moves[i].key, moves[i].grid));
        }
        for (i = 0; i < stars.length; i++) {
            ld().attempt(round, stars[i].key, S.core.specialists.orders.star(stars[i].key));
        }
        S.kernel.log(CATEGORY, st().waveLabel() + ': positioning, ' + moves.length + ' move(s), ' +
            stars.length + ' star(s)');
    }

    // Wave step values for the shared load flow, built at call time:
    // state.js fills S.WaveStep after this file loads.
    function waveSteps() {
        var W = S.WaveStep;
        return { supply: W.Supply, unload: W.Unload, load: W.Load, verify: W.Verify, done: W.Reach };
    }

    function supply(r, w, inv) {
        ld().supply(r, w.supply, inv, waveSteps());
    }

    function unload(r, w, inv) {
        ld().unload(r, inv, waveSteps());
    }

    function load(r, w, inv) {
        ld().load(r, w.supply, inv, waveSteps());
    }

    function verify(r, w, inv) {
        ld().verify(r, w.supply, inv, waveSteps());
    }

    // First open Attack or Buff line that cannot be attacked now, as a
    // blocker, or null. A missing camp of a line sent before is that line's
    // win, not a blocker.
    function reachBlock(r, w, inv) {
        S.core.buildings.invalidate();
        for (var i = 0; i < w.open.length; i++) {
            var l = w.open[i];
            if (!isSeqKind(l)) continue;
            var reason = null;
            var b = S.core.buildings.byGrid(l.target);
            if (!b && goneAfterSend(r, l, inv)) continue;
            if (!b) reason = 'target missing';
            else if (!S.core.buildings.isEnemy(b)) reason = 'target not enemy';
            else if (l.kind === S.BattleLine.Attack) {
                var s = spec(l.key);
                if (!s) reason = 'general missing';
                else if (!S.core.specialists.orders.hasPath(s, l.target)) reason = 'no path';
            }
            if (reason) {
                return {
                    key:     l.key,
                    general: l.kind === S.BattleLine.Attack ? who(l, inv) : (l.name || l.key),
                    target:  l.target,
                    reason:  reason + ' (' + targetText(l) + ')'
                };
            }
        }
        return null;
    }

    function reach(r, w, inv) {
        var blocked = reachBlock(r, w, inv);
        if (!blocked) {
            st().go(S.WaveStep.Attack, 'all targets reachable');
            return;
        }
        r.settleFrom = S.WaveStep.Reach;
        r.blocker = blocked;
        st().go(S.WaveStep.Settle, blocked.general + ': ' + blocked.reason);
    }

    // No own fighter in battle and no claimable quest waiting. An unreadable
    // quest list (null) or a missing watcher is not settled.
    function islandSettled() {
        if (ld().anyAttacking()) return false;
        var watcher = S.modules.adventures.watcher;
        var pending = watcher && watcher.pending ? watcher.pending() : null;
        return !!pending && pending.length === 0;
    }

    function settle(r, w, inv) {
        var fromPosition = r.settleFrom === S.WaveStep.Position;
        var back = fromPosition ? S.WaveStep.Position : S.WaveStep.Reach;
        var was = r.blocker;
        var blocked = fromPosition ? notPlaceable(w, inv) : reachBlock(r, w, inv);
        if (!blocked) {
            r.settleFrom = null;
            r.blocker = null;
            st().go(back, 'settled: ' + (was ? was.general + ' ' + was.reason + ' cleared' : 'blocker cleared'));
            return;
        }
        r.blocker = blocked;
        if (islandSettled()) r.settled++;
        else r.settled = 0;
        st().save();
        if (r.settled >= SETTLE_TICKS) {
            st().pause(fromPosition ? S.RunPause.NotPlaceable : S.RunPause.Unreachable,
                blocked.general + ': ' + blocked.reason + ' with no battle running and no quest waiting' +
                ' (it may be a bug in the wave file)', { general: blocked.general, target: blocked.target });
            return;
        }
        if (now() - r.since > SETTLE_MAX_MS) {
            st().pause(S.RunPause.SettleTimeout, blocked.general + ': ' + blocked.reason + ' still after ' +
                Math.round(SETTLE_MAX_MS / 60000) + ' min', { general: blocked.general, target: blocked.target });
        }
    }

    // Lines sent but not seen when no attempt is running any more (its
    // callback was dropped by a reload, or it ended without seeing the
    // effect). Never re-sent automatically. Returns true when it paused.
    function resolveSent(r, w, inv) {
        var round = ld().currentRound(r, S.WaveStep.Attack);
        for (var i = 0; i < w.seq.length; i++) {
            var l = w.seq[i];
            if (!r.lines || !has(r.lines, l.key)) continue;
            var rec = r.lines[l.key];
            if (rec.seen) continue;
            // Resume cleared the marker but the line went out before: a gone
            // camp is its win; otherwise the pacer sends it again.
            if (rec.sentAt === null) {
                goneAfterSend(r, l, inv);
                continue;
            }
            var res = ld().resultOf(round, l.key);
            var isAttack = l.kind === S.BattleLine.Attack;
            if (isAttack && attacking(l.key)) {
                rec.seen = true;
                st().save();
                S.kernel.log(CATEGORY, st().waveLabel() + ': attack of ' + who(l, inv) + ' seen');
                continue;
            }
            if (!isAttack) {
                pause(S.RunPause.BuffFailed, 'buff ' + (l.name || l.key) + ' on ' + targetText(l) +
                    ' not seen: ' + (res ? res.reason || res.status : 'sent before a reload'), l, inv);
                return true;
            }
            if (res && res.status !== S.ActionResult.Verified) {
                pause(S.RunPause.AttackNotSeen, 'attack of ' + who(l, inv) + ' on ' + targetText(l) +
                    ' not seen: ' + res.reason, l, inv);
                return true;
            }
            S.core.buildings.invalidate();
            if (S.core.zone.id() === r.zoneId && !S.core.buildings.byGrid(l.target)) {
                rec.seen = true;
                st().save();
                S.kernel.warn(CATEGORY, st().waveLabel() + ': camp ' + targetText(l) + ' of ' + who(l, inv) +
                    ' gone after a send before reload; counted as seen');
                continue;
            }
            pause(S.RunPause.AttackUnconfirmed, 'attack of ' + who(l, inv) + ' on ' + targetText(l) +
                ' was sent before a reload and is not seen; check the map, then Resume', l, inv);
            return true;
        }
        return false;
    }

    function attackStep(r, w, inv) {
        if (resolveSent(r, w, inv)) return;
        var round = ld().currentRound(r, S.WaveStep.Attack);
        var all = true;
        var retry = false;
        for (var i = 0; i < w.seq.length; i++) {
            var l = w.seq[i];
            if (isSent(r, l.key)) continue;
            all = false;
            var res = ld().resultOf(round, l.key);
            if (res) {
                if (ld().unreadable(res)) {
                    retry = true;
                    continue;
                }
                if (l.kind === S.BattleLine.Attack) {
                    pause(S.RunPause.AttackRefused, 'attack of ' + who(l, inv) + ' on ' + targetText(l) +
                        ' refused: ' + res.reason, l, inv);
                } else {
                    pause(S.RunPause.BuffFailed, 'buff ' + (l.name || l.key) + ' on ' + targetText(l) +
                        ' failed: ' + res.reason, l, inv);
                }
                return;
            }
        }
        if (all) {
            st().go(S.WaveStep.Confirm, 'every line sent', { keepRounds: true });
            return;
        }
        // plan() runs only while the module has no queue work, so an attempt
        // of this round without a result is no longer queued: a kernel Pause
        // or turning the module off dropped it. The pacer would wait for it
        // for ever. A line that went out was already settled above from its
        // sent marker and is not sent again; a line that never went out is
        // sent by the pacer in a fresh round. Dropped only here, after the
        // round's recorded refusals were read. A line refused because its
        // general could not be read never went out, and the pacer stops at
        // a line with a result, so that round goes the same way.
        if (round && (retry || !ld().complete(round))) {
            st().dropRound(retry ? 'general not readable' : 'attempt no longer queued');
        }
        // Added inside plan(), so the entry carries the module tag.
        S.kernel.queue.add(PACE_ACTION, [r.id, r.waveIndex], PACE_MS);
    }

    function confirm(r, w, inv) {
        if (resolveSent(r, w, inv)) return;
        for (var i = 0; i < w.seq.length; i++) {
            if (!isSeen(r, w.seq[i].key)) {
                // Only an unsent line can be left here; Attack sends it.
                st().go(S.WaveStep.Attack, w.seq[i].key + ' not sent');
                return;
            }
        }
        S.kernel.log(CATEGORY, st().waveLabel() + ' confirmed');
        r.waveIndex++;
        r.lines = {};
        r.cycles = 0;
        r.donors = [];
        if (r.waveIndex >= r.paths.length) {
            st().go(S.RunStep.PackStar, 'last wave confirmed');
            return;
        }
        st().go(S.WaveStep.Gate, 'next wave');
    }

    // Built at call time: state.js fills S.WaveStep and loads after this
    // file in name order.
    function stepFn(step) {
        var W = S.WaveStep;
        if (step === W.Gate)     return gate;
        if (step === W.Position) return position;
        if (step === W.Supply)   return supply;
        if (step === W.Unload)   return unload;
        if (step === W.Load)     return load;
        if (step === W.Verify)   return verify;
        if (step === W.Reach)    return reach;
        if (step === W.Settle)   return settle;
        if (step === W.Attack)   return attackStep;
        if (step === W.Confirm)  return confirm;
        return null;
    }

    // One step of the running wave. Holds (no send, no pause) while another
    // zone is viewed or the specialist list lost entries, because the steps
    // read a general absent from the list as a fact. A throw leaves the step
    // as it is for the next call.
    function plan() {
        var r = st().run();
        if (!r || r.status !== S.RunStatus.Running) return;
        // Series steps before and after the waves are run by their own part.
        if (!st().isWaveStep(r.step)) return;
        if (S.core.zone.id() !== r.zoneId) return;
        if (r.waveIndex >= r.paths.length) {
            st().go(S.RunStep.PackStar, 'last wave confirmed');
            return;
        }
        var step = r.step;
        try {
            var file = linesFor(r);
            if (!file.ok) {
                st().pause(S.RunPause.WaveFile, file.message);
                return;
            }
            var fn = stepFn(step);
            if (!fn) {
                st().go(S.WaveStep.Gate, 'unknown step ' + step);
                return;
            }
            var inv = S.core.army.inventory();
            if (ld().listHold(r, inv)) return;
            fn(r, view(r, file.lines), inv);
        } catch (e) {
            S.kernel.error(CATEGORY, st().waveLabel() + ': step ' + stepName(step) + ' threw:', e);
        }
    }

    // ---- Attack pacer -------------------------------------------------------

    function repace(params) {
        S.kernel.queue.add(PACE_ACTION, params, PACE_MS);
    }

    function lineDef(l) {
        if (l.kind === S.BattleLine.Buff) return S.core.buffs.camp(l.buffName, l.target);
        return S.core.specialists.orders.attack(l.key, l.target, l.grid);
    }

    // Queue action: sends the next attack or buff line of the wave once its
    // time after the previous send has passed. params: [runId, waveIndex].
    function pace(params) {
        try {
            paceStep(params || []);
        } catch (e) {
            S.kernel.error(CATEGORY, 'attack pacer threw:', e);
        }
    }

    function paceStep(params) {
        var rs = st().current();
        var r = rs.run;
        if (!r || r.id !== params[0] || r.waveIndex !== params[1]) return;
        if (r.status !== S.RunStatus.Running || r.step !== S.WaveStep.Attack) return;
        if (S.core.zone.id() !== r.zoneId) return;
        var c = rs.cache;
        if (!c || c.runId !== r.id || c.waveIndex !== r.waveIndex || c.path !== r.paths[r.waveIndex] || !c.lines) return;

        var seq = view(r, c.lines).seq;
        var i;
        for (i = 0; i < seq.length; i++) {
            if (!isSent(r, seq[i].key)) break;
        }
        if (i >= seq.length) return;
        var line = seq[i];

        var round = ld().currentRound(r, S.WaveStep.Attack);
        if (round && has(round.expected, line.key)) {
            // Refused or failed before its send: the Attack step pauses.
            if (has(round.results, line.key)) return;
            // Its send step has not run yet; never start it twice.
            repace(params);
            return;
        }

        var base = null;
        for (var j = i - 1; j >= 0; j--) {
            var prev = r.lines && has(r.lines, seq[j].key) ? r.lines[seq[j].key] : null;
            if (prev && prev.sentAt !== null) { base = prev.sentAt; break; }
        }
        var gapMs = typeof line.timeMs === 'number' ? line.timeMs : 0;
        if (base !== null && now() < base + gapMs) {
            repace(params);
            return;
        }

        if (!round) round = ld().startRound(r, S.WaveStep.Attack, []);
        var def = lineDef(line);
        var send = def.send;
        var runId = r.id;
        var key = line.key;
        // The marker is saved before the packet goes out, so a reload right
        // after the send still knows the line went out.
        def.send = function (b) {
            var cur = st().run();
            if (cur && cur.id === runId) {
                var rec = lineRec(cur, key);
                if (rec.sentAt === null) {
                    rec.sentAt = now();
                    rec.sentOnce = true;
                    st().save();
                    S.kernel.log(CATEGORY, 'attack line ' + key + ' sent ' +
                        (base === null ? 'first' : (rec.sentAt - base) + ' ms after the previous') +
                        ' (file: ' + line.timeMs + ')');
                }
            }
            return send(b);
        };
        ld().attempt(round, key, def, function (result, cur) {
            if (result.status !== S.ActionResult.Verified) return;
            lineRec(cur, key).seen = true;
            st().save();
        });
        if (i < seq.length - 1) repace(params);
    }

    // ---- Start check ----------------------------------------------------------

    // withCamps: camps are looked up on the viewed zone, which is right only
    // while the template's map is viewed; without them validate skips the
    // camp checks.
    function fighterCtx(inv, withCamps) {
        var fighters = {};
        var byKey = (inv && inv.byKey) || {};
        for (var k in byKey) {
            if (!has(byKey, k)) continue;
            var g = byKey[k];
            fighters[k] = { name: g.name, cls: g.cls, capacity: g.capacity, army: g.army };
        }
        var ctx = {
            fighters: fighters,
            isElite:  S.core.army.isElite,
            classOf:  function (a) { return S.core.army.classOf(a); },
            total:    S.core.army.total
        };
        if (withCamps) {
            ctx.camp = function (grid) {
                var b = S.core.buildings.byGrid(grid);
                return b ? { enemy: S.core.buildings.isEnemy(b) } : null;
            };
        }
        return ctx;
    }

    function sortProblems(out, label, problems) {
        for (var i = 0; i < problems.length; i++) {
            var p = problems[i];
            var copy = { code: p.code, fatal: p.fatal, key: p.key, file: label, message: label + ': ' + p.message };
            if (p.fatal) out.problems.push(copy);
            else out.warnings.push(copy);
        }
    }

    // Reads the template's loadout and waves fresh and checks them against
    // the island as it is now. Returns { ok, problems (fatal), warnings,
    // loadoutKeys, listOk }; loadoutKeys is null when the loadout cannot be
    // read. listOk false means the specialist list lost entries, so the
    // general problems of this check are not facts.
    // opts (optional): camps === false leaves out the camp checks (the map
    // is not viewed); fighters === false also skips the general checks (the
    // generals may be away), so only the files and the loadout keys count.
    function check(rec, opts) {
        var o = opts || {};
        var fighters = o.fighters !== false;
        var camps = fighters && o.camps !== false;
        var out = { ok: false, problems: [], warnings: [], loadoutKeys: null, listOk: true };
        var inv = S.core.army.inventory();
        out.listOk = !fighters || inv.listOk !== false;
        if (camps) S.core.buildings.invalidate();
        var ctx = fighterCtx(inv, camps);

        var lo = S.core.battles.load(rec.loadout);
        sortProblems(out, 'loadout', lo.problems);
        if (lo.ok) {
            if (fighters) sortProblems(out, 'loadout', S.core.battles.validate(lo.lines, ctx));
            out.loadoutKeys = S.core.battles.loadoutKeys(lo.lines);
        }

        var waves = rec.waves || [];
        if (!waves.length) {
            out.problems.push({ code: S.BattleProblem.Empty, fatal: true, key: null, file: 'template',
                message: 'template: no wave files' });
        }
        for (var w = 0; w < waves.length; w++) {
            var label = 'wave ' + (w + 1);
            var file = S.core.battles.load(waves[w]);
            sortProblems(out, label, file.problems);
            if (!file.ok) continue;
            if (fighters) sortProblems(out, label, S.core.battles.validate(file.lines, ctx));
            if (out.loadoutKeys) sortProblems(out, label, S.core.battles.notInLoadout(file.lines, out.loadoutKeys));
        }

        out.ok = out.problems.length === 0 && out.loadoutKeys !== null;
        var mode = !fighters ? 'files only' : (camps ? 'generals and camps' : 'generals, no camps');
        S.kernel.log(CATEGORY, 'start check "' + rec.label + '" (' + mode + '): ' + (waves.length + 1) +
            ' files, ' + out.problems.length + ' fatal, ' + out.warnings.length + ' warnings');
        return out;
    }

    S.modules.adventures.executor = {
        PACE_ACTION:       PACE_ACTION,
        GATE_MISSING_MS:   GATE_MISSING_MS,
        GATE_BUSY_MS:      GATE_BUSY_MS,
        SETTLE_TICKS:      SETTLE_TICKS,
        SETTLE_MAX_MS:     SETTLE_MAX_MS,
        PACE_MS:           PACE_MS,
        check:             check,
        plan:              plan,
        pace:              pace,
        linesFor:          linesFor,
        attackCount:       attackCount
    };

    // The kernel queue file runs before every module on each load, so this
    // registers into a fresh action table and never replaces a handler.
    S.kernel.queue.action(PACE_ACTION, pace);

}(Steward));
