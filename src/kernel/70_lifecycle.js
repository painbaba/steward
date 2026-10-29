/*
 * Lifecycle.
 *
 * Steward.kernel.lifecycle.boot() runs once after the bundle finishes loading.
 * Sequence:
 *   1. Load settings from disk
 *   2. Configure logger from settings
 *   3. Run each registered module's boot() hook
 *   4. Initialize UI shell
 *   5. Start the scheduler
 *
 * Boot is auto-scheduled at the end of this file via a deferred setTimeout —
 * by the time the timer fires, every other source file in the bundle (kernel,
 * core, modules) has finished its IIFE and registered itself.
 *
 * Steward.kernel.lifecycle.shutdown() stops the scheduler, resets the queue,
 * disposes the UI shell (status interval) and flushes settings. It is used
 * when the host reloads userscripts into the same page: the next bundle calls
 * it before replacing the kernel, so the old instance stops acting.
 */

(function (S) {

    var booted = false;
    // Set by shutdown(). A reload can land inside the boot defer below; the
    // stale timer must then not boot an instance that was already torn down.
    var disposed = false;

    function applyLoggerSettings() {
        var s = S.kernel.settings.read('logger');
        if (s) S.kernel.log.configure(s);
    }

    function applySchedulerSettings() {
        var s = S.kernel.settings.read('scheduler');
        if (s && S.kernel.scheduler.configure) S.kernel.scheduler.configure(s);
    }

    function readPausedFlag() {
        var s = S.kernel.settings.read('kernel');
        return !!(s && s.paused);
    }

    function runModuleBoots() {
        var mods = S.kernel.registry.list();
        for (var i = 0; i < mods.length; i++) {
            var m = mods[i];
            if (!m.boot) continue;
            // Tag any queue.add calls inside boot() with this module's id
            // so cancelByModule can clean them up later.
            S.kernel._currentModule = m.id;
            try {
                m.boot();
                S.kernel.log('lifecycle', 'boot hook ran for', m.id);
            } catch (e) {
                S.kernel.error('lifecycle', m.id, 'boot threw:', e);
            }
            S.kernel._currentModule = null;
        }
    }

    function boot() {
        if (booted || disposed) return;
        booted = true;

        S.kernel.log('lifecycle', 'boot starting');
        try { S.kernel.settings.load(); } catch (e) {
            S.kernel.error('lifecycle', 'settings.load threw:', e);
        }

        applyLoggerSettings();
        applySchedulerSettings();

        runModuleBoots();

        // Honour persisted master-pause state. Seed the UI's flag *before*
        // ui.init() so the menu's pause toggle renders with the right label,
        // then conditionally start the scheduler.
        var startPaused = readPausedFlag();
        if (startPaused && S.kernel.ui && typeof S.kernel.ui.seedPaused === 'function') {
            S.kernel.ui.seedPaused(true);
        }

        try {
            if (S.kernel.ui && S.kernel.ui.init) S.kernel.ui.init();
        } catch (e) {
            S.kernel.error('lifecycle', 'ui.init threw:', e);
        }

        if (startPaused) {
            S.kernel.log('lifecycle', 'boot honouring persisted pause — scheduler not started');
        } else {
            try {
                S.kernel.scheduler.start();
            } catch (e) {
                S.kernel.error('lifecycle', 'scheduler.start threw:', e);
            }
        }

        S.kernel.log('lifecycle', 'boot complete — modules:', S.kernel.registry.count(),
                     '— state:', startPaused ? 'paused' : 'active');
    }

    // Calls obj[name]() if it exists. Returns true only when the call ran
    // without throwing, so shutdown can fall back to an older entry point and
    // a failing step never stops the remaining ones.
    function callIf(obj, name) {
        if (!obj || typeof obj[name] !== 'function') return false;
        try {
            obj[name]();
            return true;
        } catch (e) {
            return false;
        }
    }

    // The single teardown sequence: scheduler, queue, status interval, then a
    // settings flush. Shutdown reaches the kernel through the shared Steward
    // global at call time, so on a script reload it must run before the next
    // bundle replaces those slots; the next bundle's 05_reload.js calls it
    // first thing for that reason. It changes no setting (the flush only
    // persists pending writes), so the persisted pause survives the reload.
    // A second call is a no-op.
    function shutdown() {
        if (disposed) return;
        disposed = true;
        var k = S.kernel;
        callIf(k.scheduler, 'stop');
        // Same stop + reset pairing as pausing: queued work of this instance
        // must not be picked up by anything after it.
        callIf(k.queue, 'reset');
        if (!callIf(k.ui, 'dispose')) callIf(k.ui, 'stopStatusUpdater');
        callIf(k.settings, 'flush');
        try { k.log('lifecycle', 'shutdown complete'); } catch (e) { /* logger gone */ }
    }

    S.kernel.lifecycle = {
        boot:     boot,
        shutdown: shutdown,
        booted:   function () { return booted; }
    };

    // Defer boot until the bundle finishes loading. setTimeout(0) would fire
    // after the current synchronous run completes; we use a small extra delay
    // to give the host client time to finish its own init.
    setTimeout(boot, S.kernel.TIMEOUTS.BOOT_DEFER_MS);

}(Steward));
