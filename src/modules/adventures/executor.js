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
 * defs. Results of one batch of attempts (a "round") are kept in memory on
 * runState.round; a callback writes its result only while that same round is
 * current and the run's zone is still viewed, so a pause, a step change, a
 * newer run or a zone change turns a late callback into a no-op.
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
 *
 * Bundle slot: module file; top level assigns S.modules.adventures.executor
 * and registers the pacer queue action; state, watcher and every core are
 * read at call time.
 */

(function (S) {

    if (!S.modules.adventures) S.modules.adventures = {};

    var PACE_ACTION = 'adventures.attack';

    // Starting values, to be tuned in game.
    var GATE_MISSING_MS   = 60000;     // a field general absent this long pauses
    var GATE_BUSY_MS      = 1800000;   // a field general busy this long pauses
    var SETTLE_TICKS      = 2;         // settled plan() calls before a blocker pauses
    var SETTLE_MAX_MS     = 900000;    // Settle gives up after this long
    var MAX_ROUNDS        = 2;         // action rounds per step before a pause
    var MAX_UNLOAD_CYCLES = 2;         // Supply -> Unload -> Supply cycles per wave
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

    function stepName(step) {
        return st().nameOf(S.WaveStep, step);
    }

    // ---- Wave lines ---------------------------------------------------------

    // Parsed lines of the run's current wave, cached for the wave. The loadout
    // keys come from the run (persisted at start), never from a reload of the
    // loadout file, so a file edited mid-run cannot widen the general set.
    function linesFor(r) {
        var rs = st().current();
        var c = rs.cache;
        if (c && c.runId === r.id && c.waveIndex === r.waveIndex && c.lines) return { ok: true, lines: c.lines };
        var path = r.paths[r.waveIndex];
        if (typeof path !== 'string' || !path) return { ok: false, message: 'wave ' + (r.waveIndex + 1) + ' has no file' };
        var ld = S.core.battles.load(path);
        if (!ld.ok) {
            var msg = 'wave file cannot be used';
            for (var i = 0; i < ld.problems.length; i++) {
                if (ld.problems[i].fatal) { msg = ld.problems[i].message; break; }
            }
            return { ok: false, message: msg };
        }
        var extra = S.core.battles.notInLoadout(ld.lines, r.loadoutKeys || {});
        if (extra.length) return { ok: false, message: extra[0].message };
        rs.cache = { runId: r.id, waveIndex: r.waveIndex, lines: ld.lines };
        S.kernel.log(CATEGORY, st().waveLabel() + ': wave file read, ' + ld.lines.length + ' lines: ' + path);
        return { ok: true, lines: ld.lines };
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
        return inv && inv.byKey && has(inv.byKey, key) ? inv.byKey[key] : null;
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

    // ---- Rounds -------------------------------------------------------------

    function startRound(r, step, keys) {
        var round = { runId: r.id, waveIndex: r.waveIndex, step: step, expected: {}, results: {} };
        for (var i = 0; i < keys.length; i++) round.expected[keys[i]] = true;
        st().current().round = round;
        return round;
    }

    function currentRound(r, step) {
        var round = st().current().round;
        if (round && round.runId === r.id && round.waveIndex === r.waveIndex && round.step === step) return round;
        return null;
    }

    function complete(round) {
        for (var k in round.expected) {
            if (has(round.expected, k) && !has(round.results, k)) return false;
        }
        return true;
    }

    // First Refused or Failed result: { key, status, reason } or null.
    function firstFailure(round) {
        for (var k in round.expected) {
            if (!has(round.expected, k) || !has(round.results, k)) continue;
            if (round.results[k].status !== S.ActionResult.Verified) {
                return { key: k, status: round.results[k].status, reason: round.results[k].reason };
            }
        }
        return null;
    }

    function resultOf(round, key) {
        return round && has(round.results, key) ? round.results[key] : null;
    }

    // onDone for an attempt of this round. The result counts only while the
    // round is still the current one of the same run and the run's zone is
    // viewed; a result that spans a zone change says nothing about this map.
    function record(round, key, after) {
        return function (result) {
            var rs = st().current();
            var r = rs.run;
            if (rs.round !== round || !r || r.id !== round.runId) return;
            if (S.core.zone.id() !== r.zoneId) return;
            round.results[key] = { status: result.status, reason: result.reason || '' };
            if (after) after(result, r);
        };
    }

    function attempt(round, key, def, after) {
        round.expected[key] = true;
        if (!S.core.actions.attempt(def, record(round, key, after))) {
            round.results[key] = { status: S.ActionResult.Failed, reason: 'attempt not started' };
        }
    }

    // ---- Pause helpers --------------------------------------------------------

    function pause(reason, message, line, inv) {
        st().pause(reason, message, line ? { general: who(line, inv), target: line.target !== null ? line.target : line.grid } : null);
    }

    // A round finished without any Refused/Failed result but the effect is
    // still not seen: counts the round and pauses after MAX_ROUNDS. Returns
    // true when it paused.
    function roundsExhausted(r, what) {
        if (r.rounds < MAX_ROUNDS) return false;
        st().pause(S.RunPause.NotObserved, what + ' verified but not observed after ' + r.rounds + ' rounds');
        return true;
    }

    // Shared round handling of an acting step. Returns 'new' when the caller
    // should start a new round, 'paused' when it paused.
    function settleRound(r, step, onFailure, what) {
        var round = currentRound(r, step);
        if (!round || !complete(round)) return 'new';     // none yet, or dropped by a reset
        r.rounds++;
        st().save();
        var f = firstFailure(round);
        if (f) {
            onFailure(f);
            return 'paused';
        }
        if (roundsExhausted(r, what)) return 'paused';
        return 'new';
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
            if (waited > GATE_MISSING_MS) {
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
        var next = settleRound(r, S.WaveStep.Position, function (f) {
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
        var round = startRound(r, S.WaveStep.Position, []);
        for (i = 0; i < moves.length; i++) {
            attempt(round, moves[i].key, S.core.specialists.orders.move(moves[i].key, moves[i].grid));
        }
        for (i = 0; i < stars.length; i++) {
            attempt(round, stars[i].key, S.core.specialists.orders.star(stars[i].key));
        }
        S.kernel.log(CATEGORY, st().waveLabel() + ': positioning, ' + moves.length + ' move(s), ' +
            stars.length + ' star(s)');
    }

    function supply(r, w, inv) {
        var p = S.core.army.planSupply(w.supply, inv);
        if (p.missing.length) {
            st().pause(S.RunPause.GeneralMissing, p.missing[0] + ' is not on the island', { general: p.missing[0] });
            return;
        }
        if (!p.covered) {
            st().pause(S.RunPause.TroopsShort, 'troops short: ' + S.core.army.text(p.shortAfter));
            return;
        }
        if (p.donors.length) {
            var keys = [];
            for (var i = 0; i < p.donors.length; i++) keys.push(p.donors[i].key);
            r.donors = keys;
            r.cycles++;
            if (r.cycles > MAX_UNLOAD_CYCLES) {
                st().pause(S.RunPause.TroopsShort, 'donors unloaded but the free pool is still short: ' +
                    S.core.army.text(p.shortBefore));
                return;
            }
            st().go(S.WaveStep.Unload, 'unload ' + keys.join(', '));
            return;
        }
        st().go(S.WaveStep.Load, 'troops covered');
    }

    function unload(r, w, inv) {
        var pending = [];
        var donors = r.donors || [];
        for (var i = 0; i < donors.length; i++) {
            var g = gen(inv, donors[i]);
            if (!g) {
                st().pause(S.RunPause.GeneralMissing, 'donor ' + donors[i] + ' is not on the island', { general: donors[i] });
                return;
            }
            if (S.core.army.total(g.army) > 0) pending.push(donors[i]);
        }
        if (!pending.length) {
            st().go(S.WaveStep.Supply, 'donors unloaded');
            return;
        }
        var next = settleRound(r, S.WaveStep.Unload, function (f) {
            st().pause(S.RunPause.UnloadFailed, 'unload of ' + f.key + ' failed: ' + f.reason, { general: f.key });
        }, 'unload');
        if (next !== 'new') return;
        var round = startRound(r, S.WaveStep.Unload, []);
        for (i = 0; i < pending.length; i++) attempt(round, pending[i], S.core.army.unload(pending[i]));
    }

    // First supply line whose general's army differs or whose general is
    // gone (missing: true), or null.
    function firstMismatch(w, inv) {
        for (var i = 0; i < w.supply.length; i++) {
            var g = gen(inv, w.supply[i].key);
            if (!g) return { key: w.supply[i].key, missing: true };
            if (!S.core.army.matches(g.army, w.supply[i].army)) return { key: w.supply[i].key, missing: false };
        }
        return null;
    }

    // Only supply lines (Attack and Move) are loaded; a Star line holds no
    // troops. Unloads go first so the troops they free are in the pool before
    // a raise checks it.
    function load(r, w, inv) {
        var empties = [];
        var raises = [];
        for (var i = 0; i < w.supply.length; i++) {
            var s = w.supply[i];
            var g = gen(inv, s.key);
            if (!g) {
                st().pause(S.RunPause.GeneralMissing, s.key + ' is not on the island', { general: s.key });
                return;
            }
            if (S.core.army.matches(g.army, s.army)) continue;
            if (S.core.army.total(s.army) === 0) empties.push(s);
            else raises.push(s);
        }
        if (!empties.length && !raises.length) {
            st().go(S.WaveStep.Reach, 'all armies match');
            return;
        }
        var round = startRound(r, S.WaveStep.Load, []);
        for (i = 0; i < empties.length; i++) attempt(round, empties[i].key, S.core.army.unload(empties[i].key));
        for (i = 0; i < raises.length; i++) attempt(round, raises[i].key, S.core.army.raise(raises[i].key, raises[i].army));
        st().go(S.WaveStep.Verify, 'loading ' + (empties.length + raises.length) + ' general(s)', { keepRounds: true });
    }

    function verify(r, w, inv) {
        var m = firstMismatch(w, inv);
        if (!m) {
            st().go(S.WaveStep.Reach, 'all armies match');
            return;
        }
        if (m.missing) {
            st().pause(S.RunPause.GeneralMissing, m.key + ' is not on the island', { general: m.key });
            return;
        }
        var round = currentRound(r, S.WaveStep.Load);
        if (!round || !complete(round)) {
            st().go(S.WaveStep.Load, 'load round dropped, load again', { keepRounds: true });
            return;
        }
        r.rounds++;
        if (r.rounds < MAX_ROUNDS) {
            st().go(S.WaveStep.Load, 'mismatch, retry once', { keepRounds: true });
            return;
        }
        var f = firstFailure(round);
        var g = gen(inv, m.key);
        st().pause(S.RunPause.LoadMismatch, ((g && g.name) ? g.name + ' ' : '') + '(' + m.key +
            ') army does not match the wave' + (f ? ': ' + f.key + ' ' + f.reason : ''), { general: m.key });
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
        var fighters = S.core.army.fighters();
        for (var i = 0; i < fighters.length; i++) {
            if (S.core.specialists.orders.taskKind(fighters[i]) === S.GeneralTask.Attack) return false;
        }
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
        var round = currentRound(r, S.WaveStep.Attack);
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
            var res = resultOf(round, l.key);
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
        var round = currentRound(r, S.WaveStep.Attack);
        var all = true;
        for (var i = 0; i < w.seq.length; i++) {
            var l = w.seq[i];
            if (isSent(r, l.key)) continue;
            all = false;
            var res = resultOf(round, l.key);
            if (res) {
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
        // round's recorded refusals were read.
        if (round && !complete(round)) st().dropRound('attempt no longer queued');
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
            st().done();
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
    // zone is viewed. A throw leaves the step as it is for the next call.
    function plan() {
        var r = st().run();
        if (!r || r.status !== S.RunStatus.Running) return;
        if (S.core.zone.id() !== r.zoneId) return;
        if (r.waveIndex >= r.paths.length) {
            st().done();
            return;
        }
        var step = r.step;
        try {
            var ld = linesFor(r);
            if (!ld.ok) {
                st().pause(S.RunPause.WaveFile, ld.message);
                return;
            }
            var fn = stepFn(step);
            if (!fn) {
                st().go(S.WaveStep.Gate, 'unknown step ' + step);
                return;
            }
            fn(r, view(r, ld.lines), S.core.army.inventory());
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
        if (!c || c.runId !== r.id || c.waveIndex !== r.waveIndex || !c.lines) return;

        var seq = view(r, c.lines).seq;
        var i;
        for (i = 0; i < seq.length; i++) {
            if (!isSent(r, seq[i].key)) break;
        }
        if (i >= seq.length) return;
        var line = seq[i];

        var round = currentRound(r, S.WaveStep.Attack);
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

        if (!round) round = startRound(r, S.WaveStep.Attack, []);
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
        attempt(round, key, def, function (result, cur) {
            if (result.status !== S.ActionResult.Verified) return;
            lineRec(cur, key).seen = true;
            st().save();
        });
        if (i < seq.length - 1) repace(params);
    }

    // ---- Start check ----------------------------------------------------------

    function fighterCtx(inv) {
        var fighters = {};
        var byKey = (inv && inv.byKey) || {};
        for (var k in byKey) {
            if (!has(byKey, k)) continue;
            var g = byKey[k];
            fighters[k] = { name: g.name, cls: g.cls, capacity: g.capacity, army: g.army };
        }
        return {
            fighters: fighters,
            isElite:  S.core.army.isElite,
            classOf:  function (a) { return S.core.army.classOf(a); },
            total:    S.core.army.total,
            // The caller starts a run only while the template's map is viewed,
            // so camps are looked up on this zone.
            camp: function (grid) {
                var b = S.core.buildings.byGrid(grid);
                return b ? { enemy: S.core.buildings.isEnemy(b) } : null;
            }
        };
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
    // loadoutKeys }; loadoutKeys is null when the loadout cannot be read.
    function check(rec) {
        var out = { ok: false, problems: [], warnings: [], loadoutKeys: null };
        var inv = S.core.army.inventory();
        S.core.buildings.invalidate();
        var ctx = fighterCtx(inv);

        var lo = S.core.battles.load(rec.loadout);
        sortProblems(out, 'loadout', lo.problems);
        if (lo.ok) {
            sortProblems(out, 'loadout', S.core.battles.validate(lo.lines, ctx));
            out.loadoutKeys = S.core.battles.loadoutKeys(lo.lines);
        }

        var waves = rec.waves || [];
        if (!waves.length) {
            out.problems.push({ code: S.BattleProblem.Empty, fatal: true, key: null, file: 'template',
                message: 'template: no wave files' });
        }
        for (var w = 0; w < waves.length; w++) {
            var label = 'wave ' + (w + 1);
            var ld = S.core.battles.load(waves[w]);
            sortProblems(out, label, ld.problems);
            if (!ld.ok) continue;
            sortProblems(out, label, S.core.battles.validate(ld.lines, ctx));
            if (out.loadoutKeys) sortProblems(out, label, S.core.battles.notInLoadout(ld.lines, out.loadoutKeys));
        }

        out.ok = out.problems.length === 0 && out.loadoutKeys !== null;
        S.kernel.log(CATEGORY, 'start check "' + rec.label + '": ' + (waves.length + 1) + ' files, ' +
            out.problems.length + ' fatal, ' + out.warnings.length + ' warnings');
        return out;
    }

    S.modules.adventures.executor = {
        PACE_ACTION:       PACE_ACTION,
        GATE_MISSING_MS:   GATE_MISSING_MS,
        GATE_BUSY_MS:      GATE_BUSY_MS,
        SETTLE_TICKS:      SETTLE_TICKS,
        SETTLE_MAX_MS:     SETTLE_MAX_MS,
        MAX_ROUNDS:        MAX_ROUNDS,
        MAX_UNLOAD_CYCLES: MAX_UNLOAD_CYCLES,
        PACE_MS:           PACE_MS,
        check:             check,
        plan:              plan,
        pace:              pace,
        linesFor:          linesFor
    };

    // The kernel queue file runs before every module on each load, so this
    // registers into a fresh action table and never replaces a handler.
    S.kernel.queue.action(PACE_ACTION, pace);

}(Steward));
