/*
 * Action queue.
 *
 * Modules call Steward.kernel.queue.add(name, params, delay) from their plan()
 * functions. Actions are registered once per name via queue.action(name, fn).
 *
 * drain() runs from the scheduler at the end of each tick and of each wake.
 * Each entry carries its own delay (default QUEUE_ACTION_GAP_MS), which holds
 * the queue after that action runs: the next action never fires sooner than one
 * entry delay after the previous one, however often drain() is called.
 */

(function (S) {

    var actions = {};                  // { name: fn(params) }
    var queue = [];                    // [{ name, params, delay, moduleId }]
    var draining = false;
    var currentlyRunningModule = null; // moduleId of the action currently executing

    function action(name, fn) {
        if (!name || typeof name !== 'string') {
            S.kernel.error('queue', 'action: name must be a non-empty string');
            return false;
        }
        if (typeof fn !== 'function') {
            S.kernel.error('queue', 'action:', name, 'requires a function');
            return false;
        }
        if (actions[name]) {
            S.kernel.warn('queue', 'action:', name, 'replacing previous handler');
        }
        actions[name] = fn;
        return true;
    }

    function add(name, params, delay) {
        if (!actions[name]) {
            S.kernel.warn('queue', 'add: unknown action', name, '— dropping');
            return false;
        }
        // moduleId is the id of the module currently inside its plan() / boot()
        // call. Tracked by the scheduler / lifecycle via S.kernel._currentModule.
        // Entries added while a tagged action runs inherit that action's tag, so
        // an action that re-enqueues itself (a send-then-verify loop) keeps its
        // module busy and stays cancellable with it. Standalone calls (e.g. from
        // event handlers) get null.
        var moduleId = S.kernel._currentModule || currentlyRunningModule || null;
        queue.push({
            name:     name,
            params:   params || [],
            delay:    typeof delay === 'number' ? delay : S.kernel.TIMEOUTS.QUEUE_ACTION_GAP_MS,
            moduleId: moduleId
        });
        if (queue.length > S.kernel.LIMITS.QUEUE_DEPTH_WARN) {
            S.kernel.warn('queue', 'depth=' + queue.length, 'exceeds threshold');
        }
        return true;
    }

    function cancelByModule(targetModuleId) {
        if (!targetModuleId) return 0;
        var kept = [];
        var removed = 0;
        for (var i = 0; i < queue.length; i++) {
            if (queue[i].moduleId === targetModuleId) removed++;
            else kept.push(queue[i]);
        }
        queue = kept;
        if (removed > 0) S.kernel.log('queue', 'cancelled', removed, 'pending action(s) for module', targetModuleId);
        return removed;
    }

    function depthByModule(targetModuleId) {
        if (!targetModuleId) return 0;
        var n = 0;
        for (var i = 0; i < queue.length; i++) {
            if (queue[i].moduleId === targetModuleId) n++;
        }
        return n;
    }

    // A module is "busy" while it has any pending or in-flight queue work.
    // The scheduler consults this before invoking plan() — a busy module is
    // skipped so it can't pile new actions on top of unfinished ones. See
    // docs/SCHEDULER.md "Module busy contract".
    function isModuleBusy(targetModuleId) {
        if (!targetModuleId) return false;
        if (currentlyRunningModule === targetModuleId) return true;
        return depthByModule(targetModuleId) > 0;
    }

    function runningModule() { return currentlyRunningModule; }

    function isHostModalVisible() {
        try {
            // Bootstrap modals (used by host's Modal class and userscripts) carry
            // role="dialog". We treat any visible one as a "user has a window
            // open" signal and defer to avoid taking it away from them.
            if (typeof $ !== 'undefined' && $.fn && $.fn.length !== undefined) {
                return $('div[role="dialog"]:visible').length > 0;
            }
        } catch (e) { /* fall through */ }
        return false;
    }

    function runOne() {
        if (queue.length === 0) {
            draining = false;
            return;
        }
        // Modal guard — defer (do NOT consume) while a host modal is visible.
        // The user has a window open; firing SelectBuilding / similar would
        // close it. Re-poll on a short cadence; resume the moment they close.
        if (isHostModalVisible()) {
            setTimeout(runOne, S.kernel.TIMEOUTS.QUEUE_MODAL_RECHECK_MS);
            return;
        }
        var entry = queue.shift();
        currentlyRunningModule = entry.moduleId || null;
        try {
            actions[entry.name](entry.params);
        } catch (e) {
            S.kernel.error('queue', entry.name, 'threw:', e);
        }
        currentlyRunningModule = null;
        // Schedule next after this action's delay.
        setTimeout(runOne, entry.delay);
    }

    function drain() {
        if (draining) return;        // a previous drain is still pacing
        if (queue.length === 0) return;
        draining = true;
        runOne();
    }

    function depth() { return queue.length; }

    function reset() {
        queue = [];
        draining = false;
        // Note: currentlyRunningModule is intentionally NOT cleared here.
        // If reset() is called while an action is mid-execution, that action
        // will finish and clear the flag itself.
    }

    S.kernel.queue = {
        action:         action,
        add:            add,
        drain:          drain,
        depth:          depth,
        reset:          reset,
        cancelByModule: cancelByModule,
        depthByModule:  depthByModule,
        isModuleBusy:   isModuleBusy,
        runningModule:  runningModule
    };

}(Steward));
