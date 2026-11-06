/*
 * Quest watcher for the adventures module, and the island's map objects.
 *
 * While a run is Running on its own island, every plan() of the module
 * first claims at most one finished quest of that adventure. It never acts
 * at home or on another zone, and not while the run's step belongs at home:
 * the quest pool read there is not the run's. Claiming a quest can
 * unlock the next part of the map, so the executor's Settle step waits
 * until no claimable quest is left (pending() returns []) before it calls
 * a target unreachable.
 *
 * The adventure's last quest is never claimed here: claiming it closes the
 * adventure, so the end-of-map step claims it itself once the free troops
 * are packed. claim() is called without allowLast, so core/quests.js
 * refuses it here as well.
 *
 * A failed or refused claim never pauses the run; the quest is retried
 * after QUEST_RETRY_MS. The retry times live in runState.questRetry, which
 * is memory only: after a client restart every finished quest is simply
 * tried again.
 *
 * One claim per plan() call keeps the module inside the scheduler's busy
 * contract: plan() runs only when no adventures queue entry is pending, so
 * a claim is never started while the previous one is still in flight.
 *
 * The island's map objects are read here as well, for the steps that wait
 * on them. This file never clicks them: the collect module does, and
 * patterns() reads its stored settings to know whether it picks up on an
 * adventure at all. Missing settings mean it does not, so no wait is ever
 * built on a pick-up that nobody makes. objects() lists the quest objects
 * still waiting to be clicked, or null when the map cannot be read.
 *
 * Bundle slot: module file; top level only assigns
 * S.modules.adventures.watcher; all else at call time.
 */

(function (S) {

    if (!S.modules.adventures) S.modules.adventures = {};

    var QUEST_RETRY_MS = 60000;

    function stateApi() {
        return S.modules.adventures.state;
    }

    // Retry table on the working copy; state.load() and clear() reset it.
    function retries() {
        var rs = stateApi().current();
        if (!rs.questRetry || typeof rs.questRetry !== 'object') rs.questRetry = {};
        return rs.questRetry;
    }

    // Finished quests that may be claimed (never the last one); null when the
    // quest pool cannot be read, so a caller never mistakes an unreadable pool
    // for "nothing left to claim".
    function pending() {
        var all;
        try {
            all = S.core.quests.finished();
        } catch (e) {
            S.kernel.warn('adventures', 'finished quests read threw:', e);
            return null;
        }
        if (all === null || all === undefined) return null;
        var out = [];
        for (var i = 0; i < all.length; i++) {
            if (all[i] && !all[i].last) out.push(all[i]);
        }
        return out;
    }

    function claimable(list, table, t) {
        for (var i = 0; i < list.length; i++) {
            var until = table[list[i].key];
            if (typeof until !== 'number' || t >= until) return list[i];
        }
        return null;
    }

    // Claims the first pending quest that is not waiting for a retry.
    function plan() {
        var st = stateApi();
        var r = st.run();
        if (!r || r.status !== S.RunStatus.Running) return;
        if (typeof r.zoneId !== 'number' || S.core.zone.id() !== r.zoneId) return;
        if (st.partOf(r.step) === 'home') return;

        var list = pending();
        if (!list || list.length === 0) return;

        var table = retries();
        var q = claimable(list, table, st.now());
        if (!q) return;

        var key = q.key;
        var name = q.name || key;
        var started = false;
        try {
            started = S.core.actions.attempt(S.core.quests.claim(key), function (result) {
                // Read at callback time: a stop or reload may have replaced the table.
                var t = retries();
                if (result && result.status === S.ActionResult.Verified) {
                    delete t[key];
                    S.kernel.log('adventures', 'quest ' + name + ' claimed');
                } else {
                    t[key] = stateApi().now() + QUEST_RETRY_MS;
                }
            }) === true;
        } catch (e) {
            S.kernel.warn('adventures', 'quest ' + name + ': claim threw:', e);
        }
        if (!started) table[key] = st.now() + QUEST_RETRY_MS;
    }

    // Quest objects on the viewed island an open quest still waits to have
    // clicked; null when the zone, the map or the quest pool cannot be read,
    // so an unreadable map is never taken for an empty one.
    function objects() {
        try {
            return S.core.pickups.targets({ quests: true });
        } catch (e) {
            S.kernel.warn('adventures', 'quest objects read threw:', e);
            return null;
        }
    }

    // The collectible patterns collect picks up on an adventure, or null when
    // it does not pick up there (no settings, off, or the adventure side off).
    // A raw settings read: the adventures module never calls into collect.
    function patterns() {
        var s = S.kernel.settings.read('collect');
        if (!s || !s.enabled || s.adventureZones !== true) return null;
        return S.core.pickups.patterns(s.namePatterns || []);
    }

    // 'name xN' per name in first-seen order, e.g. 'crates x3, barrel x2'.
    function pickupText(list) {
        var names = [];
        var counts = {};
        for (var i = 0; i < list.length; i++) {
            var n = list[i].name;
            if (!Object.prototype.hasOwnProperty.call(counts, n)) {
                counts[n] = 0;
                names.push(n);
            }
            counts[n]++;
        }
        var out = [];
        for (var j = 0; j < names.length; j++) out.push(names[j] + ' x' + counts[names[j]]);
        return out.join(', ');
    }

    S.modules.adventures.watcher = {
        QUEST_RETRY_MS: QUEST_RETRY_MS,
        pending:        pending,
        objects:        objects,
        patterns:       patterns,
        pickupText:     pickupText,
        plan:           plan
    };

}(Steward));
