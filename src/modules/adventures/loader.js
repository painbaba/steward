/*
 * Shared action rounds, troop loading and send markers of an adventure run.
 *
 * The wave executor and the home and away steps all act the same way: a
 * step starts a batch of S.core.actions attempts (a "round"), the next
 * plan() call reads the round's results and the game, and a step retries
 * once before it pauses. The round helpers and the Supply -> Unload ->
 * Load -> Verify flow live here once, so the load at home before the map
 * and the load of each wave on the island are the same code.
 *
 * A round remembers the zone it was started on. A callback writes its
 * result only while that round is still the current one of the same run
 * and that zone is still viewed, so a pause, a step change, a newer run or
 * a zone change turns a late callback into a no-op. On the island this is
 * the run's zone; at home it is the home zone.
 *
 * The load steps take their step values from the caller ({ supply, unload,
 * load, verify, done }), built at call time, so the waves move through the
 * wave steps and the home load through the run steps.
 *
 * Send markers ("marks", persisted on run.marks with the same record shape
 * as run.lines) cover every order that must not go out twice: the marker
 * is written and saved before the packet goes out, so a reload right after
 * a send still knows it was sent. A marked attempt uses the mark name as
 * its round key. A marked order is never sent again on its own: the action's
 * retry is off, and a mark sent but never seen waits ORDER_WAIT_MS for the
 * step's own observation, after which the step pauses until the user has
 * looked.
 *
 * The game may show a verified effect some seconds after the verify. A pass
 * can come right after a round ends, so a step that would count, retry or
 * pause on such a read waits READ_LAG_MS first, and the last round of a step
 * waits ORDER_WAIT_MS before it counts. Only those paths wait; a read that
 * already shows the effect moves on at once.
 *
 * The per-general helpers that the home and away steps share (read waits,
 * loadout key order, names, the departure test) live here as well. A wait
 * names what it waits for and has no limit of its own: waitBusy() is the one
 * wait for a general or an order, and waitRead() the one for a read that
 * failed. hold() is the deadline for a fact that only the user can fix.
 * quietClock() sums the time of a wait that does end in a pause, counting only
 * the passes that really watched the island. Each caller names its own memory
 * slot, so two clocks of one step never share a record.
 *
 * A round's attempts refuse to send once another zone than the round's own is
 * viewed (ZONE_CHANGED); such a refusal sent nothing, like an unreadable one.
 *
 * A specialist list that lost entries says nothing about what it does not
 * show. listHold() holds a step on such a read with no limit, missingLong()
 * lets a general that a clean read lacks stay gone for a while before anyone
 * pauses, and unreadable() tells a refusal over such a read from a real one.
 * All three work from memory only and survive no restart: a new client reads
 * afresh.
 *
 * A wave that is short may only look short: troops can sit with a general
 * who is fighting or walking, and they reach the pool when he is done. So the
 * wave's Supply waits, with no limit, while the plan cannot cover and any own
 * general or carrier on the island is busy, and calls the troops short only
 * with everyone idle and nothing left to unload. The load at home keeps its
 * pause: nothing there brings troops back by itself.
 *
 * Bundle slot: module file; top level only assigns
 * S.modules.adventures.loader; state and every core are read at call time.
 */

(function (S) {

    if (!S.modules.adventures) S.modules.adventures = {};

    // Starting values, to be tuned in game.
    var MAX_ROUNDS        = 2;         // action rounds per step before a pause
    var MAX_UNLOAD_CYCLES = 2;         // Supply -> Unload -> Supply cycles per load at home
    var READ_LAG_MS       = 10000;     // a verified effect may read this late; the old gap between two looks
    var READ_MAX_MS       = 60000;     // a hold pauses after this long
    var MISSING_GRACE_MS  = READ_MAX_MS;  // a general stays gone this long before a pause
    var MISSING_GAP_MS    = 30000;     // a longer silence restarts that grace and is not counted as watched time
    var MARK_SETTLE_MS    = 30000;     // a step that closes the adventure waits this long before it sends
    var ORDER_WAIT_MS     = 180000;    // a marked order or a last round waits this long to show its effect
    var BUSY_LOG_MS       = 60000;     // a wait logs this seldom

    var CATEGORY = 'adventures';

    // Prefix of the blocker reason while a load waits for queued troops; the
    // blocker is cleared again only when it is this one.
    var WAIT_PREFIX = 'waiting for production: ';

    // Refusal reason of a round's attempt whose zone is no longer viewed.
    var ZONE_CHANGED = 'viewed zone changed';

    function has(obj, key) {
        return Object.prototype.hasOwnProperty.call(obj, key);
    }

    function st() {
        return S.modules.adventures.state;
    }

    function now() {
        return S.modules.adventures.state.now();
    }

    function gen(inv, key) {
        return inv && inv.byKey && has(inv.byKey, key) ? inv.byKey[key] : null;
    }

    // ---- Shared step helpers ------------------------------------------------

    // A general that can take an order now: present, idle and not travelling.
    function ready(g) {
        return !!g && g.idle && !g.travelling;
    }

    // Key of the first general or carrier of this read that is not ready, in
    // key order, or null. inv.byKey is every own fighter on the viewed zone,
    // whether the loadout holds him or not and whatever he carries.
    function firstBusy(inv) {
        var keys = [];
        for (var k in inv.byKey) if (has(inv.byKey, k)) keys.push(k);
        keys.sort();
        for (var i = 0; i < keys.length; i++) {
            if (!ready(inv.byKey[keys[i]])) return keys[i];
        }
        return null;
    }

    // A hold on the step's own deadline (r.waitUntil), set on the first pass.
    // Only for a fact that the user alone can fix: every other wait ends by
    // itself, so it has no business with a deadline.
    function hold(r, text) {
        keepBusy();
        if (typeof r.waitUntil !== 'number') {
            r.waitUntil = now() + READ_MAX_MS;
            st().save();
            return;
        }
        if (now() > r.waitUntil) st().pause(S.RunPause.NotObserved, text);
    }

    function clearHold(r) {
        if (r.waitUntil === null || r.waitUntil === undefined) return;
        r.waitUntil = null;
        st().save();
    }

    // This pass says nothing about a busy wait (a read failed or lacks a
    // general), so it must not end it. Otherwise a read that flaps restarts the
    // record, logs every other pass and falls back to the fast polls.
    function keepBusy() {
        st().current().busySeen = true;
    }

    // The one wait for a general or an order: no limit, it ends when a pass no
    // longer waits. It neither moves the step nor saves, so
    // r.since stays put, the next pass does not read the wait as progress and
    // the run file is not rewritten each pass. One record per run and step: a
    // change of general keeps since and noted, so the log stays at one line a
    // minute whatever the generals do. The game's remaining time is logged
    // only: it runs short, so nothing may be built on it.
    function waitBusy(r, key, text) {
        var rs = st().current();
        var t = now();
        var b = st().busyOf(r);
        if (!b) {
            b = { runId: r.id, step: r.step, key: key, text: text, since: t, noted: null };
            rs.busy = b;
        }
        b.key = key;
        b.text = text;
        b.read = false;
        keepBusy();
        if (b.noted !== null && t - b.noted < BUSY_LOG_MS) return;
        b.noted = t;
        var spec = key ? S.core.specialists.lookup(key).spec : null;
        var rem = spec ? S.core.specialists.orders.remaining(spec) : null;
        S.kernel.log(CATEGORY, st().label() + ': ' + text + ', waited ' +
            Math.round((t - b.since) / 60000) + ' min' +
            (typeof rem === 'number' ? ', remaining ' + rem + ' (raw)' : '') +
            (spec ? ', task ' + taskText(spec) : ''));
    }

    // What holds a busy general: the task kind, else the raw task code, else
    // 'none'. A busy general with no task means the in-use flag holds him.
    function taskText(spec) {
        var orders = S.core.specialists.orders;
        var kind = orders.taskKind(spec);
        if (kind !== null && kind !== undefined) return kind;
        var raw = orders.rawTaskType(spec);
        return raw !== null && raw !== undefined ? 'raw ' + raw : 'none';
    }

    // A read that failed holds the step with no limit: the wait is the read
    // itself, and only a good read can tell what to do next. No save and no
    // step change. Reads are mostly momentary, so a new record holds its first
    // log line back for BUSY_LOG_MS, and a passing bad read leaves a busy text
    // and its since alone. A read that stays bad takes the record over, because
    // the menu must name the real cause and the log must keep its line a
    // minute; since stays, and a later real wait restores its text. The shared
    // noted keeps the log to one line a minute across those changes.
    function waitRead(r, what) {
        var text = what + ' not readable';
        var rs = st().current();
        var t = now();
        var b = st().busyOf(r);
        if (!b) {
            rs.busy = { runId: r.id, step: r.step, key: null, text: text, since: t, noted: t, read: true };
            keepBusy();
            return;
        }
        if (!b.read && t - b.noted < BUSY_LOG_MS) {
            keepBusy();
            return;
        }
        waitBusy(r, null, text);
        rs.busy.read = true;
    }

    // The one wording of an order that went out and waits for its effect.
    function waitSent(r, what) {
        waitBusy(r, null, what + ' sent, waiting to see it');
    }

    // Holds the step, with no limit, on a read that lost entries or found no
    // list at all: either way absence means nothing, so no step may act on it.
    // Sends nothing and saves nothing.
    function listHold(r, inv) {
        if (!inv || (inv.listOk !== false && inv.listRead !== false)) return false;
        waitRead(r, inv.listRead === false ? 'specialist list' : 'complete specialist list');
        return true;
    }

    // Summed time of a wait, from the runState slot named by slot (default
    // 'quiet'): { ms, gap }. ms grows only while quiet is true. Passes stop
    // while another zone is viewed, so a bare difference would count that time
    // and pause on the return; a silence over gapMs() is reported as gap and
    // not counted. A new step starts a new record, and its first pass is a gap
    // too. Memory only: a restart gives a fresh window, which errs to waiting.
    function quietClock(r, quiet, slot) {
        var name = slot || 'quiet';
        var rs = st().current();
        var t = now();
        var q = rs[name];
        if (!q || q.since !== r.since) {
            rs[name] = { since: r.since, last: t, ms: 0 };
            return { ms: 0, gap: true };
        }
        var gap = t - q.last > gapMs();
        if (quiet && !gap) q.ms += t - q.last;
        q.last = t;
        return { ms: q.ms, gap: gap };
    }

    // Longest silence between two passes that still counts as watched time.
    // Passes come once a scheduler tick, so a tick the user raised must not
    // turn every pass into a gap and stop the clock.
    function gapMs() {
        var s = S.kernel.scheduler && S.kernel.scheduler.state;
        var tick = s && typeof s.tickIntervalMs === 'number' ? s.tickIntervalMs : 0;
        return Math.max(MISSING_GAP_MS, 3 * tick);
    }

    // Whether a general that a read lacks has now been gone long enough to
    // pause over: false until reports have run for MISSING_GRACE_MS. A longer
    // gap than MISSING_GAP_MS between two reports means the general was seen,
    // or nobody looked, in between, so the time starts again. The record is
    // kept after a true result: a Resume with the general still gone pauses
    // on the next report. A script reload keeps runState without going
    // through resetMemory, so the map may be absent.
    function missingLong(r, key) {
        keepBusy();
        var rs = st().current();
        if (!rs.missing) rs.missing = {};
        var t = now();
        var rec = has(rs.missing, key) ? rs.missing[key] : null;
        if (!rec || t - rec.last > MISSING_GAP_MS) {
            rs.missing[key] = { since: t, last: t };
            return false;
        }
        rec.last = t;
        return t - rec.since >= MISSING_GRACE_MS;
    }

    // Every pass treats the generals in the same order.
    function keysOf(r) {
        var keys = [];
        var lk = r.loadoutKeys || {};
        for (var k in lk) if (has(lk, k)) keys.push(k);
        keys.sort();
        return keys;
    }

    function who(inv, key) {
        var g = gen(inv, key);
        return g && g.name ? g.name + ' (' + key + ')' : key;
    }

    // The onDone follow-up of a marked attempt: a verified result marks it
    // seen, so a later pass moves on without sending again.
    function seenOnVerified(name) {
        return function (result, cur) {
            if (result && result.status === S.ActionResult.Verified) markSeen(cur, name);
        };
    }

    // A general is leaving its zone while it travels or while its task is
    // TravelToZone.
    function leaving(g, key) {
        if (g.travelling) return true;
        return S.core.specialists.orders.taskKind(S.core.specialists.lookup(key).spec) ===
            S.GeneralTask.TravelToZone;
    }

    // A raise needs the general's garrison, which only a general on a map
    // grid has. A general at the star reads grid 0.
    function onMap(g) {
        return !!g && typeof g.grid === 'number' && g.grid > 0;
    }

    // The first loadout key whose general is walking to a grid, or null. A
    // key that cannot be looked up does not count as walking.
    function movingKey(r) {
        var keys = keysOf(r);
        for (var i = 0; i < keys.length; i++) {
            var spec = S.core.specialists.lookup(keys[i]).spec;
            if (spec && S.core.specialists.orders.taskKind(spec) === S.GeneralTask.Move) return keys[i];
        }
        return null;
    }

    // A general resting after a lost battle takes no order until the rest
    // ends, and he goes home with the map, so the map-end steps do not wait
    // on him. A key that cannot be looked up does not count as recovering,
    // so an unreadable general is still waited on.
    function recovering(key) {
        var spec = S.core.specialists.lookup(key).spec;
        return !!spec && S.core.specialists.orders.taskKind(spec) === S.GeneralTask.Recovering;
    }

    // A free placeable grid for each key. Landing fields are the only grids a
    // general at the star can be placed on, and the vector also lists other
    // players' fields, so the client's own placeable test decides; the move's
    // precheck runs it again before the packet. Never a grid an own fighter
    // stands on, one already chosen or one in the optional avoid array.
    // Returns { moves, missing, blocked, tried }; missing or blocked names the
    // first key without a spec or without a grid, and moves holds what was
    // chosen before it.
    function chooseGrids(inv, keys, avoid) {
        var cands = S.core.zone.landingGrids();
        var taken = {};
        for (var k in inv.byKey) {
            if (has(inv.byKey, k) && onMap(inv.byKey[k])) taken[String(inv.byKey[k].grid)] = true;
        }
        if (avoid) {
            for (var a = 0; a < avoid.length; a++) taken[String(avoid[a])] = true;
        }
        var out = { moves: [], missing: null, blocked: null, tried: cands.length };
        for (var i = 0; i < keys.length; i++) {
            var spec = S.core.specialists.lookup(keys[i]).spec;
            if (!spec) {
                out.missing = keys[i];
                return out;
            }
            var chosen = null;
            for (var j = 0; j < cands.length; j++) {
                if (has(taken, String(cands[j]))) continue;
                if (S.core.specialists.orders.isPlaceable(spec, cands[j])) {
                    chosen = cands[j];
                    break;
                }
            }
            if (chosen === null) {
                out.blocked = keys[i];
                return out;
            }
            taken[String(chosen)] = true;
            out.moves.push({ key: keys[i], grid: chosen });
        }
        return out;
    }

    // Whether any own fighter on the viewed zone has an Attack task; the wave
    // settle and the Clear step both need the island quiet. A read that lost
    // entries cannot show quiet, so it counts as not quiet.
    function anyAttacking() {
        var rf = S.core.army.readFighters();
        if (!rf.complete) return true;
        var list = rf.list;
        for (var i = 0; i < list.length; i++) {
            if (S.core.specialists.orders.taskKind(list[i]) === S.GeneralTask.Attack) return true;
        }
        return false;
    }

    // ---- Rounds -------------------------------------------------------------

    function startRound(r, step, keys) {
        var round = { runId: r.id, waveIndex: r.waveIndex, step: step, zoneId: S.core.zone.id(),
            expected: {}, results: {} };
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

    // Whether a finished round is still inside the time its effect may take
    // to read. doneAt lives in memory like the round, so a reload forgets it
    // together with the round.
    function roundSettling(round) {
        return typeof round.doneAt === 'number' && now() - round.doneAt < READ_LAG_MS;
    }

    // Whether a result is a first-step refusal that sent nothing: the general
    // could not be read, or the round's zone was no longer viewed. Either way
    // the round had no effect. A ZONE_CHANGED result is normally already
    // discarded by record() (its zone differs from the round's), so this branch
    // is a defence for a result that still arrives. Only this exact form counts. A Failed 'retry
    // refused: ...' went out once, and taking it for no effect would send a
    // marked order again.
    function unreadable(res) {
        return !!res && res.status === S.ActionResult.Refused &&
            (res.reason === S.core.specialists.UNREADABLE || res.reason === ZONE_CHANGED);
    }

    // First Refused or Failed result: { key, status, reason } or null. A
    // refusal that sent nothing (unreadable, or the zone changed) is no
    // failure: its round counts as one without effect, which settleRound and
    // roundsExhausted bound. A marked order that
    // was not observed in time is none either: nothing refused it, and the
    // mark decides how long it may still show.
    function firstFailure(round) {
        for (var k in round.expected) {
            if (!has(round.expected, k) || !has(round.results, k)) continue;
            if (unreadable(round.results[k]) || round.results[k].unseen) continue;
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
    // round is still the current one of the same run and the zone it was
    // started on is viewed; a result that spans a zone change says nothing
    // about the zone the step observes. unseen stays only on a marked round:
    // the mark is what bounds its wait. Without one nothing would end it, and a
    // raise never seen would read as packed and go out again for ever, so an
    // unmarked round keeps its failure.
    function record(round, key, after) {
        return function (result) {
            var rs = st().current();
            var r = rs.run;
            if (rs.round !== round || !r || r.id !== round.runId) return;
            if (S.core.zone.id() !== round.zoneId) return;
            var stored = { status: result.status, reason: result.reason || '' };
            if (result.unseen === true && marked(r, key)) stored.unseen = true;
            round.results[key] = stored;
            // A later attempt added to this round writes this again when it ends.
            if (complete(round)) round.doneAt = now();
            if (after) after(result, r);
        };
    }

    // A queued order never goes out on another zone than the one its round
    // started on, at home and on the island alike: the queue may run it after
    // the user switched, and the step's read no longer holds there.
    function attempt(round, key, def, after) {
        round.expected[key] = true;
        if (def && typeof def === 'object') {
            var pre = def.precheck;
            var zoneId = round.zoneId;
            def.precheck = function (arg) {
                if (S.core.zone.id() !== zoneId) return ZONE_CHANGED;
                return typeof pre === 'function' ? pre.call(def, arg) : null;
            };
        }
        if (!S.core.actions.attempt(def, record(round, key, after))) {
            round.results[key] = { status: S.ActionResult.Failed, reason: 'attempt not started' };
        }
    }

    // A round finished without any Refused/Failed result but the effect is
    // still not seen: counts the round and pauses after MAX_ROUNDS. Returns
    // true when it paused.
    function roundsExhausted(r, what) {
        if (r.rounds < MAX_ROUNDS) return false;
        st().pause(S.RunPause.NotObserved, what + ' verified but not observed after ' + r.rounds + ' rounds');
        return true;
    }

    // plan() runs only while the module has no queue work, so a round of this
    // run that is still incomplete when a step runs lost its attempts to a
    // kernel Pause (queue reset) or a module disable (queue cancel), and its
    // sends may already have gone out. Dropping it keeps a step from taking it
    // for a round still running or from reading it as a reason to send again.
    function dropOrphan(r) {
        var rs = st().current();
        if (rs.round && rs.round.runId === r.id && !complete(rs.round)) st().dropRound('attempt no longer queued');
    }

    // Shared round handling of an acting step. Returns 'new' when the caller
    // should start a new round, 'paused' when it paused, 'wait' while a round
    // without failure may still show its effect late: counting it now could
    // send the same order twice or end in a false rounds pause. The round that
    // would end the step waits ORDER_WAIT_MS in the same way. A failed round
    // has no effect to wait for and pauses at once. doneAt is memory, so a
    // restart forgets the wait together with the round and the step re-plans.
    function settleRound(r, step, onFailure, what) {
        dropOrphan(r);
        var round = currentRound(r, step);
        if (!round || !complete(round)) return 'new';     // none yet, or dropped above
        var f = firstFailure(round);
        if (!f && roundSettling(round)) return 'wait';
        if (!f && r.rounds + 1 >= MAX_ROUNDS && typeof round.doneAt === 'number' &&
                now() - round.doneAt < ORDER_WAIT_MS) {
            waitSent(r, what);
            return 'wait';
        }
        r.rounds++;
        st().save();
        if (f) {
            onFailure(f);
            return 'paused';
        }
        if (roundsExhausted(r, what)) return 'paused';
        return 'new';
    }

    // Takes a finished round out of settleRound's count when it has no failure
    // and none of its orders is still open. A step that sends as generals get
    // ready starts many rounds, and each order of this one took effect, so it
    // has nothing left to count, nothing to send again and no reason to wait
    // the settling time. open lists the mark names of the generals that still
    // read as here and not on their way. r.rounds and the step stay as they
    // are, so a count from a round that truly did not show is kept and the
    // busy wait goes on.
    function dropShown(r, step, open) {
        var round = currentRound(r, step);
        if (!round || !complete(round) || firstFailure(round)) return;
        for (var i = 0; i < open.length; i++) {
            if (has(round.expected, open[i])) return;
        }
        st().dropRound('orders shown');
    }

    // ---- Battle files -------------------------------------------------------

    // Parsed lines of one battle file of the run, cached until another file
    // or wave is read. The loadout keys come from the run (persisted at
    // start), never from a reload of the loadout file, so a file edited
    // mid-run cannot widen the general set. waveIndex < 0 names a file that
    // is not a wave (the loadout); tag then labels the log line.
    function linesOf(r, path, waveIndex, tag) {
        var rs = st().current();
        var c = rs.cache;
        if (c && c.runId === r.id && c.path === path && c.waveIndex === waveIndex && c.lines) {
            return { ok: true, lines: c.lines };
        }
        var label = waveIndex >= 0 ? 'wave ' + (waveIndex + 1) : tag;
        if (typeof path !== 'string' || !path) return { ok: false, message: label + ' has no file' };
        var ld = S.core.battles.load(path);
        if (!ld.ok) {
            var msg = label + ' file cannot be used';
            for (var i = 0; i < ld.problems.length; i++) {
                if (ld.problems[i].fatal) { msg = ld.problems[i].message; break; }
            }
            return { ok: false, message: msg };
        }
        var extra = S.core.battles.notInLoadout(ld.lines, r.loadoutKeys || {});
        if (extra.length) return { ok: false, message: extra[0].message };
        rs.cache = { runId: r.id, path: path, waveIndex: waveIndex, lines: ld.lines };
        S.kernel.log(CATEGORY, (waveIndex >= 0 ? st().waveLabel() : tag) + ': file read, ' +
            ld.lines.length + ' lines: ' + path);
        return { ok: true, lines: ld.lines };
    }

    // Grids of the attack and buff targets of the waves before end (all waves
    // without it), deduped, with a label. A file that no longer loads adds
    // nothing.
    function campsOf(r, end) {
        var out = [];
        var seenGrid = {};
        var L = S.BattleLine;
        var stop = typeof end === 'number' ? Math.min(end, r.paths.length) : r.paths.length;
        for (var i = 0; i < stop; i++) {
            var f = S.core.battles.load(r.paths[i]);
            if (!f || !f.ok) continue;
            for (var j = 0; j < f.lines.length; j++) {
                var l = f.lines[j];
                if (l.kind !== L.Attack && l.kind !== L.Buff) continue;
                if (typeof l.target !== 'number' || has(seenGrid, String(l.target))) continue;
                seenGrid[String(l.target)] = true;
                out.push({ grid: l.target, text: l.targetName ? l.targetName + ' (' + l.target + ')' : String(l.target) });
            }
        }
        return out;
    }

    // ---- Loading ------------------------------------------------------------

    // First supply line whose general's army differs or whose general is
    // gone (missing: true), or null.
    function firstMismatch(supply, inv) {
        for (var i = 0; i < supply.length; i++) {
            var g = gen(inv, supply[i].key);
            if (!g) return { key: supply[i].key, missing: true };
            if (!S.core.army.matches(g.army, supply[i].army)) return { key: supply[i].key, missing: false };
        }
        return null;
    }

    // True when every unit still short is already queued, together with the
    // extra troops (those on the way home), in at least the short amount, so
    // the troops arrive without a new order. An unreadable queue never counts
    // as covered.
    function shortQueued(shortAfter, extra) {
        for (var u in shortAfter) {
            if (!has(shortAfter, u) || !(shortAfter[u] > 0)) continue;
            var q = S.core.production.queued(u);
            if (typeof q !== 'number') return false;
            var x = extra && has(extra, u) && typeof extra[u] === 'number' ? extra[u] : 0;
            if (q + x < shortAfter[u]) return false;
        }
        return true;
    }

    // What of a short read cannot be trusted, or null: the free pool, else the
    // production queue of the first short unit in name order. A source that
    // cannot be read must never look empty, so a caller that would end the
    // series on this read waits for it instead.
    function unreadableShort(inv, shortAfter) {
        if (!inv.ok) return 'troops';
        var units = [];
        for (var u in shortAfter) {
            if (has(shortAfter, u) && shortAfter[u] > 0) units.push(u);
        }
        units.sort();
        for (var i = 0; i < units.length; i++) {
            if (typeof S.core.production.queued(units[i]) !== 'number') return 'production queue of ' + units[i];
        }
        return null;
    }

    // The one way supply() gives up on short troops. Without opts.onShort it
    // pauses TroopsShort. With it the caller decides what a short means, but
    // only on a read where the pool and every short unit's queue are known.
    function shortStop(r, inv, shortAfter, opts, message) {
        if (!opts || typeof opts.onShort !== 'function') {
            st().pause(S.RunPause.TroopsShort, message);
            return;
        }
        var what = unreadableShort(inv, shortAfter);
        if (what) {
            waitRead(r, what);
            return;
        }
        opts.onShort(message);
    }

    function isWaitBlocker(b) {
        return !!b && b.key === '' && typeof b.reason === 'string' && b.reason.indexOf(WAIT_PREFIX) === 0;
    }

    // The one plan of Supply and Verify: both must agree on what is short. A
    // wave's own generals may donate their surplus only with untilIdle.
    function planOf(lines, inv, opts) {
        return S.core.army.planSupply(lines, inv, { surplus: !!(opts && opts.untilIdle) });
    }

    // Holds a wave's Supply that the plan cannot cover; true when the step
    // holds this pass. An unreadable source only lowers what is available, so
    // a short plan may be false on such a read, while a covered one never is.
    // A wait that just ended moves to the same step: r.since is old by then,
    // so this gives the first idle read its READ_LAG_MS and lets a general who
    // turns busy again be waited for, instead of pausing on that one read.
    function holdShort(r, inv, steps, shortText) {
        if (!inv.ok) {
            waitRead(r, 'troops');
            return true;
        }
        var key = firstBusy(inv);
        if (key) {
            waitBusy(r, key, who(inv, key) + ' busy, troops short: ' + shortText);
            return true;
        }
        if (!st().busyOf(r)) return false;
        st().go(steps.supply, 'every general idle');
        return true;
    }

    // opts: { waitQueued, waitMaxMs, untilIdle, transit, onShort }, optional.
    // With waitQueued, troops that are short but already in production are
    // waited for (up to waitMaxMs since the step began) instead of pausing at
    // once. transit is an army map of troops on the way home, which count like
    // queued ones for that wait. onShort(message) replaces the TroopsShort
    // pause of a plain short and of exhausted unload cycles; it is called only
    // on a readable free pool and readable queues of every short unit, and an
    // unreadable one waits for the read. The production wait limit still
    // pauses.
    //
    // untilIdle is the wave's Supply. A plan that cannot cover then goes, in
    // this order: an unreadable read holds; a busy general is waited for; a
    // wait that just ended re-arms the step; donors are unloaded, partial
    // ones too, since with everyone idle nothing else can add troops; the
    // read lag passes; TroopsShort. MAX_UNLOAD_CYCLES does not apply to a
    // wave: no raise happens inside the Supply -> Unload loop and each cycle
    // empties at least one donor, so the loop ends by itself.
    function supply(r, lines, inv, steps, opts) {
        var untilIdle = !!(opts && opts.untilIdle);
        var p = planOf(lines, inv, opts);
        if (p.missing.length) {
            if (!missingLong(r, p.missing[0])) return;
            st().pause(S.RunPause.GeneralMissing, p.missing[0] + ' is not on the island', { general: p.missing[0] });
            return;
        }
        var settling = now() - r.since < READ_LAG_MS;
        if (!p.covered) {
            var shortText = S.core.army.text(p.shortAfter);
            var transit = opts ? opts.transit : null;
            if (opts && opts.waitQueued && shortQueued(p.shortAfter, transit)) {
                if (now() - r.since > opts.waitMaxMs) {
                    st().pause(S.RunPause.TroopsShort, 'troops short: ' + shortText + ' (still in production after ' +
                        Math.round(opts.waitMaxMs / 60000) + ' min)');
                    return;
                }
                var reason = WAIT_PREFIX + shortText + (!S.core.army.isEmpty(transit) ? ' (part on the way home)' : '');
                if (!r.blocker || r.blocker.reason !== reason) {
                    r.blocker = { key: '', general: null, target: null, reason: reason };
                    S.kernel.log(CATEGORY, st().label() + ': ' + reason);
                    st().save();
                }
                return;
            }
            if (untilIdle && holdShort(r, inv, steps, shortText)) return;
            if (!untilIdle || !p.donors.length) {
                if (settling) return;
                shortStop(r, inv, p.shortAfter, opts, 'troops short: ' + shortText);
                return;
            }
        }
        if (isWaitBlocker(r.blocker)) r.blocker = null;
        if (p.donors.length) {
            // Unload verifies the general's army and not the pool, so right
            // after an Unload a short read may be lag, and acting on it would
            // empty a further donor. With no unload cycle yet there is nothing
            // to lag, so that Supply keeps its speed.
            if (r.cycles > 0 && settling) return;
            var keys = [];
            for (var i = 0; i < p.donors.length; i++) keys.push(p.donors[i].key);
            r.donors = keys;
            r.cycles++;
            if (!untilIdle && r.cycles > MAX_UNLOAD_CYCLES) {
                shortStop(r, inv, p.shortBefore, opts, 'donors unloaded but the free pool is still short: ' +
                    S.core.army.text(p.shortBefore));
                return;
            }
            st().go(steps.unload, 'unload ' + keys.join(', '));
            return;
        }
        st().go(steps.load, 'troops covered');
    }

    function unload(r, inv, steps) {
        var pending = [];
        var donors = r.donors || [];
        for (var i = 0; i < donors.length; i++) {
            var g = gen(inv, donors[i]);
            if (!g) {
                if (!missingLong(r, donors[i])) return;
                st().pause(S.RunPause.GeneralMissing, 'donor ' + donors[i] + ' is not on the island', { general: donors[i] });
                return;
            }
            if (S.core.army.total(g.army) > 0) pending.push(donors[i]);
        }
        if (!pending.length) {
            st().go(steps.supply, 'donors unloaded');
            return;
        }
        var next = settleRound(r, steps.unload, function (f) {
            st().pause(S.RunPause.UnloadFailed, 'unload of ' + f.key + ' failed: ' + f.reason, { general: f.key });
        }, 'unload');
        if (next !== 'new') return;
        var round = startRound(r, steps.unload, []);
        for (i = 0; i < pending.length; i++) attempt(round, pending[i], S.core.army.unload(pending[i]));
    }

    // Only supply lines (Attack and Move) are loaded; a Star line holds no
    // troops. Unloads go first so the troops they free are in the pool before
    // a raise checks it.
    function load(r, lines, inv, steps) {
        var empties = [];
        var raises = [];
        for (var i = 0; i < lines.length; i++) {
            var s = lines[i];
            var g = gen(inv, s.key);
            if (!g) {
                if (!missingLong(r, s.key)) return;
                st().pause(S.RunPause.GeneralMissing, s.key + ' is not on the island', { general: s.key });
                return;
            }
            if (S.core.army.matches(g.army, s.army)) continue;
            if (S.core.army.total(s.army) === 0) empties.push(s);
            else raises.push(s);
        }
        if (!empties.length && !raises.length) {
            st().go(steps.done, 'all armies match');
            return;
        }
        var round = startRound(r, steps.load, []);
        for (i = 0; i < empties.length; i++) attempt(round, empties[i].key, S.core.army.unload(empties[i].key));
        for (i = 0; i < raises.length; i++) attempt(round, raises[i].key, S.core.army.raise(raises[i].key, raises[i].army));
        st().go(steps.verify, 'loading ' + (empties.length + raises.length) + ' general(s)', { keepRounds: true });
    }

    function verify(r, lines, inv, steps, opts) {
        var m = firstMismatch(lines, inv);
        if (!m) {
            st().go(steps.done, 'all armies match');
            return;
        }
        if (m.missing) {
            if (!missingLong(r, m.key)) return;
            st().pause(S.RunPause.GeneralMissing, m.key + ' is not on the island', { general: m.key });
            return;
        }
        var round = currentRound(r, steps.load);
        if (!round || !complete(round)) {
            st().go(steps.load, 'load round dropped, load again', { keepRounds: true });
            return;
        }
        // Whatever the round's results: this step retries a failed round too,
        // and a raise refused on a pool that lags after an unload needs the
        // time before the retry can succeed.
        if (roundSettling(round)) return;
        // A retry cannot succeed on this pool, and Supply decides whether to
        // wait, unload or pause.
        if (opts && opts.untilIdle && !S.core.army.isEmpty(planOf(lines, inv, opts).shortBefore)) {
            st().go(steps.supply, 'troops short, supply again');
            return;
        }
        r.rounds++;
        if (r.rounds < MAX_ROUNDS) {
            st().go(steps.load, 'mismatch, retry once', { keepRounds: true });
            return;
        }
        var f = firstFailure(round);
        var g = gen(inv, m.key);
        st().pause(S.RunPause.LoadMismatch, ((g && g.name) ? g.name + ' ' : '') + '(' + m.key +
            ') army does not match the battle file' + (f ? ': ' + f.key + ' ' + f.reason : ''), { general: m.key });
    }

    // ---- Send markers -------------------------------------------------------

    // The run's record of a mark; created on first use. sentOnce stays set
    // when Resume clears sentAt, so a step can still tell that the order
    // went out once.
    function mark(r, name) {
        if (!r.marks) r.marks = {};
        if (!has(r.marks, name)) r.marks[name] = { sentAt: null, seen: false, sentOnce: false };
        return r.marks[name];
    }

    function marked(r, name) {
        return r.marks && has(r.marks, name) ? r.marks[name] : null;
    }

    function markSeen(r, name) {
        mark(r, name).seen = true;
        st().save();
    }

    function dropMark(r, name) {
        if (!r.marks || !has(r.marks, name)) return;
        delete r.marks[name];
        st().save();
    }

    // def with its send wrapped: the mark is written and saved before the
    // packet goes out, so a reload right after the send still knows it went
    // out. Written on the current run only while it is still the same run.
    // This is the one place for "must not go out twice", so the action's own
    // retry goes off here: a slow effect would otherwise be sent again.
    function wrapSend(r, name, def) {
        if (!def || typeof def.send !== 'function') return def;
        var send = def.send;
        var runId = r.id;
        def.send = function (b) {
            var cur = st().run();
            if (cur && cur.id === runId) {
                var rec = mark(cur, name);
                rec.sentAt = now();
                rec.sentOnce = true;
                st().save();
                S.kernel.log(CATEGORY, st().label() + ': ' + name + ' sent');
            }
            return send(b);
        };
        def.retries = 0;
        return def;
    }

    // Whether a mark sent but not seen blocks a new send: null when there is
    // nothing to wait for (no mark, not sent, seen, or the round that expects
    // it failed and decides through settleRound), 'wait' for ORDER_WAIT_MS from
    // the send, 'stale' after it. what names the order in the wait. opts.seen
    // counts a seen mark too, for an order whose effect only a later read can
    // show; a seen mark from before the step's start is not counted, because
    // Resume keeps seen marks and must be able to send. An orphaned round is
    // dropped first, so a send whose round was lost always waits and then goes
    // stale; it is never sent again without a Resume.
    function staleMark(r, name, what, opts) {
        dropOrphan(r);
        var rec = marked(r, name);
        if (!rec || typeof rec.sentAt !== 'number') return null;
        if (rec.seen && !(opts && opts.seen && rec.sentAt >= r.since)) return null;
        var round = currentRound(r, r.step);
        if (round && has(round.expected, name) && (!complete(round) || firstFailure(round))) return null;
        if (now() - rec.sentAt >= ORDER_WAIT_MS) return 'stale';
        waitSent(r, what);
        return 'wait';
    }

    S.modules.adventures.loader = {
        MAX_ROUNDS:        MAX_ROUNDS,
        MAX_UNLOAD_CYCLES: MAX_UNLOAD_CYCLES,
        READ_LAG_MS:       READ_LAG_MS,
        READ_MAX_MS:       READ_MAX_MS,
        MISSING_GRACE_MS:  MISSING_GRACE_MS,
        MARK_SETTLE_MS:    MARK_SETTLE_MS,
        ORDER_WAIT_MS:     ORDER_WAIT_MS,
        BUSY_LOG_MS:       BUSY_LOG_MS,
        ZONE_CHANGED:      ZONE_CHANGED,
        now:               now,
        gen:               gen,
        ready:             ready,
        firstBusy:         firstBusy,
        waitRead:          waitRead,
        hold:              hold,
        clearHold:         clearHold,
        keepBusy:          keepBusy,
        waitBusy:          waitBusy,
        waitSent:          waitSent,
        listHold:          listHold,
        quietClock:        quietClock,
        missingLong:       missingLong,
        keysOf:            keysOf,
        who:               who,
        seenOnVerified:    seenOnVerified,
        leaving:           leaving,
        onMap:             onMap,
        movingKey:         movingKey,
        recovering:        recovering,
        chooseGrids:       chooseGrids,
        anyAttacking:      anyAttacking,
        startRound:        startRound,
        currentRound:      currentRound,
        complete:          complete,
        roundSettling:     roundSettling,
        firstFailure:      firstFailure,
        unreadable:        unreadable,
        resultOf:          resultOf,
        record:            record,
        attempt:           attempt,
        roundsExhausted:   roundsExhausted,
        dropOrphan:        dropOrphan,
        settleRound:       settleRound,
        dropShown:         dropShown,
        linesOf:           linesOf,
        campsOf:           campsOf,
        firstMismatch:     firstMismatch,
        supply:            supply,
        unload:            unload,
        load:              load,
        verify:            verify,
        mark:              mark,
        marked:            marked,
        markSeen:          markSeen,
        dropMark:          dropMark,
        wrapSend:          wrapSend,
        staleMark:         staleMark
    };

}(Steward));
