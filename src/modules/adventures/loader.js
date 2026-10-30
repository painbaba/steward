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
 * its round key. A mark sent but never seen is never sent again on its
 * own: it waits a settle time for the step's own observation and then the
 * step pauses until the user has looked.
 *
 * The per-general helpers that the home and away steps share (read waits,
 * loadout key order, names, the departure test) live here as well.
 *
 * Bundle slot: module file; top level only assigns
 * S.modules.adventures.loader; state and every core are read at call time.
 */

(function (S) {

    if (!S.modules.adventures) S.modules.adventures = {};

    // Starting values, to be tuned in game.
    var MAX_ROUNDS        = 2;         // action rounds per step before a pause
    var MAX_UNLOAD_CYCLES = 2;         // Supply -> Unload -> Supply cycles per load
    var READ_MAX_MS       = 60000;     // an unreadable read pauses after this long
    var MARK_SETTLE_MS    = 30000;     // a sent, unseen mark waits this long for its effect
    var REMAINING_MAX_MS  = 3600000;   // clamp of one remaining-time reading
    var TRAVEL_SLACK_MS   = 60000;     // added to the longest remaining travel time
    var TRAVEL_CAP_MS     = 1800000;   // travel wait when no remaining time is readable

    var CATEGORY = 'adventures';

    // Prefix of the blocker reason while a load waits for queued troops; the
    // blocker is cleared again only when it is this one.
    var WAIT_PREFIX = 'waiting for production: ';

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

    // An unreadable read holds the step, and pauses NotObserved once the step
    // has waited READ_MAX_MS since r.since.
    function waitRead(r, what) {
        if (now() - r.since > READ_MAX_MS) {
            st().pause(S.RunPause.NotObserved, what + ' not readable after ' +
                Math.round(READ_MAX_MS / 1000) + ' s');
        }
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

    // Whether any own fighter on the viewed zone has an Attack task; the wave
    // settle and the Clear step both need the island quiet.
    function anyAttacking() {
        var list = S.core.army.fighters();
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
    // round is still the current one of the same run and the zone it was
    // started on is viewed; a result that spans a zone change says nothing
    // about the zone the step observes.
    function record(round, key, after) {
        return function (result) {
            var rs = st().current();
            var r = rs.run;
            if (rs.round !== round || !r || r.id !== round.runId) return;
            if (S.core.zone.id() !== round.zoneId) return;
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
    // should start a new round, 'paused' when it paused.
    function settleRound(r, step, onFailure, what) {
        dropOrphan(r);
        var round = currentRound(r, step);
        if (!round || !complete(round)) return 'new';     // none yet, or dropped above
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

    // True when every unit still short is already queued in at least the
    // short amount, so the troops arrive without a new order.
    function shortQueued(shortAfter) {
        for (var u in shortAfter) {
            if (!has(shortAfter, u) || !(shortAfter[u] > 0)) continue;
            var q = S.core.production.queued(u);
            if (typeof q !== 'number' || q < shortAfter[u]) return false;
        }
        return true;
    }

    function isWaitBlocker(b) {
        return !!b && b.key === '' && typeof b.reason === 'string' && b.reason.indexOf(WAIT_PREFIX) === 0;
    }

    // opts: { waitQueued, waitMaxMs }, optional. With waitQueued, troops
    // that are short but already in production are waited for (up to
    // waitMaxMs since the step began) instead of pausing at once.
    function supply(r, lines, inv, steps, opts) {
        var p = S.core.army.planSupply(lines, inv);
        if (p.missing.length) {
            st().pause(S.RunPause.GeneralMissing, p.missing[0] + ' is not on the island', { general: p.missing[0] });
            return;
        }
        if (!p.covered) {
            var shortText = S.core.army.text(p.shortAfter);
            if (opts && opts.waitQueued && shortQueued(p.shortAfter)) {
                if (now() - r.since > opts.waitMaxMs) {
                    st().pause(S.RunPause.TroopsShort, 'troops short: ' + shortText + ' (still in production after ' +
                        Math.round(opts.waitMaxMs / 60000) + ' min)');
                    return;
                }
                var reason = WAIT_PREFIX + shortText;
                if (!r.blocker || r.blocker.reason !== reason) {
                    r.blocker = { key: '', general: null, target: null, reason: reason };
                    S.kernel.log(CATEGORY, st().label() + ': ' + reason);
                    st().save();
                }
                return;
            }
            st().pause(S.RunPause.TroopsShort, 'troops short: ' + shortText);
            return;
        }
        if (isWaitBlocker(r.blocker)) r.blocker = null;
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

    function verify(r, lines, inv, steps) {
        var m = firstMismatch(lines, inv);
        if (!m) {
            st().go(steps.done, 'all armies match');
            return;
        }
        if (m.missing) {
            st().pause(S.RunPause.GeneralMissing, m.key + ' is not on the island', { general: m.key });
            return;
        }
        var round = currentRound(r, steps.load);
        if (!round || !complete(round)) {
            st().go(steps.load, 'load round dropped, load again', { keepRounds: true });
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
        return def;
    }

    // Whether a mark sent but not seen blocks a new send: null when there is
    // nothing to wait for (no mark, not sent, seen, or the current round that
    // expects it decides through settleRound), 'wait' within settleMs of the
    // send, 'stale' after it. An orphaned round is dropped first, so a send
    // whose round was lost always waits and then goes stale; it is never
    // sent again without a Resume.
    function staleMark(r, name, settleMs) {
        dropOrphan(r);
        var rec = marked(r, name);
        if (!rec || typeof rec.sentAt !== 'number' || rec.seen) return null;
        var round = currentRound(r, r.step);
        if (round && has(round.expected, name)) return null;
        return now() - rec.sentAt < settleMs ? 'wait' : 'stale';
    }

    S.modules.adventures.loader = {
        MAX_ROUNDS:        MAX_ROUNDS,
        MAX_UNLOAD_CYCLES: MAX_UNLOAD_CYCLES,
        READ_MAX_MS:       READ_MAX_MS,
        MARK_SETTLE_MS:    MARK_SETTLE_MS,
        REMAINING_MAX_MS:  REMAINING_MAX_MS,
        TRAVEL_SLACK_MS:   TRAVEL_SLACK_MS,
        TRAVEL_CAP_MS:     TRAVEL_CAP_MS,
        now:               now,
        gen:               gen,
        waitRead:          waitRead,
        keysOf:            keysOf,
        who:               who,
        seenOnVerified:    seenOnVerified,
        leaving:           leaving,
        anyAttacking:      anyAttacking,
        startRound:        startRound,
        currentRound:      currentRound,
        complete:          complete,
        firstFailure:      firstFailure,
        resultOf:          resultOf,
        record:            record,
        attempt:           attempt,
        roundsExhausted:   roundsExhausted,
        dropOrphan:        dropOrphan,
        settleRound:       settleRound,
        linesOf:           linesOf,
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
