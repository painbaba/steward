/*
 * Kernel-wide constants.
 *
 * Scheduler/queue timings, limits and the release version live here so call
 * sites never carry magic numbers and a single edit changes them everywhere.
 */

(function (S) {

    // Release version. The build (and the test harness) replace this literal
    // with package.json's version; assigned unconditionally so a script reload
    // shows the new bundle's version.
    S.kernel.VERSION = '__STEWARD_VERSION__';

    S.kernel.TIMEOUTS = {
        TICK_INTERVAL_MS:        10000,    // Steward.scheduler default tick interval
        WAKE_MIN_MS:             250,      // floor of a module wake; bounds a wake chain to 4 plans a second
        WAKE_BUSY_RECHECK_MS:    500,      // re-check of a wake that found its module busy; reads no game state
        QUEUE_ACTION_GAP_MS:     1500,     // default delay between queued actions
        QUEUE_MODAL_RECHECK_MS:  2000,     // re-poll cadence while a host modal is open
        BOOT_DEFER_MS:           100,      // how long after script load we wait before boot()
        UI_INIT_RETRY_MS:        1000,     // retry interval if window.nativeWindow not yet available
        UI_INIT_MAX_ATTEMPTS:    30,       // give up after this many retries (~30s)
        STATUS_UPDATE_MS:        5000,     // cadence for refreshing the in-menu status label
        SETTINGS_SAVE_DEBOUNCE_MS: 500,    // throttle disk writes when many writes hit at once
        LOG_ROTATE_RETRY_MS:     60000,    // delay before a failed log rotation is tried again
        TICK_INTERVAL_MIN_MS:    10000     // lowest tick the Settings screen accepts
    };

    S.kernel.LIMITS = {
        QUEUE_DEPTH_WARN:        500,      // log a warning beyond this — module is misbehaving
        LOG_FILE_MAX_KB_DEFAULT: 5120,     // rotate console.log at 5 MB
        LOG_KEEP_ROTATED_DEFAULT: 7,       // numbered old files kept beside console.log
        LOG_ROTATE_DAILY_DEFAULT: true     // rotate at the first write after midnight
    };

}(Steward));
