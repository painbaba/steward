/*
 * Quest watcher for the adventures module.
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

    S.modules.adventures.watcher = {
        QUEST_RETRY_MS: QUEST_RETRY_MS,
        pending:        pending,
        plan:           plan
    };

}(Steward));
