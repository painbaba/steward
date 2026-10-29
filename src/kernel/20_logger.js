/*
 * Steward logger.
 *
 * One entry point: Steward.kernel.log(category, ...values). Writes to:
 *   1. The host JS console (air.Introspector.Console if present, or debug()).
 *   2. A rotating file at <client install>/steward/logs/console.log
 *      (next to the AIR client binaries — predictable / easy to find).
 *
 * Path resolution: the AIR path plumbing (the applicationDirectory
 * round trip, recursive directory creation and the storage / documents
 * fallback chain) lives in kernel/17_files.js as writableDir, so the log and
 * every other file steward writes follow one location policy. The logger
 * only picks the 'steward/logs' folder and reports where it landed.
 * log.filePath() returns the native path of the current log file (or null).
 *
 * The logger boots in a "console only, all categories enabled" mode. Once
 * Steward.kernel.settings.load() runs, configure() picks up persisted prefs.
 *
 * Failures inside the logger never throw — kernel-tick code must be able to
 * call this from anywhere without a try/catch.
 */

(function (S) {

    var LEVEL = S.LogLevel;

    var state = {
        enabled:        true,
        debugEnabled:   false,    // DEBUG-level lines are dropped unless this is true
        fileEnabled:    true,     // write to disk by default; configure() can flip off
        categories:     {},       // {} means "all enabled"
        maxFileSizeKB:  S.kernel.LIMITS.LOG_FILE_MAX_KB_DEFAULT,
        keepRotated:    S.kernel.LIMITS.LOG_KEEP_ROTATED_DEFAULT,
        logDir:         null,
        logFile:        null,
        consoleSink:    null
    };

    function pad2(n) { return n < 10 ? '0' + n : '' + n; }

    function timestamp() {
        var d = new Date();
        return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
               ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    }

    function joinArgs(args, fromIdx) {
        var parts = [];
        for (var i = fromIdx; i < args.length; i++) {
            var a = args[i];
            if (a === null) { parts.push('null'); continue; }
            if (a === undefined) { parts.push('undefined'); continue; }
            if (typeof a === 'object') {
                try { parts.push(JSON.stringify(a)); }
                catch (e) { parts.push('[unstringifiable]'); }
            } else {
                parts.push(String(a));
            }
        }
        return parts.join(' ');
    }

    function format(level, category, message) {
        return '[' + level + '] [' + timestamp() + '] [' + category + '] ' + message;
    }

    function emitToConsole(level, line) {
        try {
            if (!state.consoleSink) {
                if (typeof air !== 'undefined' && air.Introspector && air.Introspector.Console) {
                    state.consoleSink = air.Introspector.Console;
                } else if (typeof debug === 'function') {
                    state.consoleSink = { log: debug, warn: debug, error: debug };
                } else {
                    state.consoleSink = false;
                }
            }
            if (!state.consoleSink) return;
            if (level === LEVEL.Error && state.consoleSink.error) state.consoleSink.error(line);
            else if (level === LEVEL.Warn && state.consoleSink.warn) state.consoleSink.warn(line);
            else if (state.consoleSink.log) state.consoleSink.log(line);
        } catch (e) { /* never propagate */ }
    }

    // Path resolution and the location fallback live in kernel/17_files.js
    // (writableDir), shared with every other file steward writes. Its notes
    // go straight to the console sink: the log file is what is being
    // resolved, so emitToFile cannot be used here.
    function consoleNote(level, message) {
        emitToConsole(level, format(level, 'logger', message));
    }

    function ensureLogFile() {
        if (state.logFile) return state.logFile;
        if (typeof air === 'undefined' || !air.File) return null;

        var r = null;
        try {
            r = S.kernel.files.writableDir('steward/logs', consoleNote);
        } catch (e) { r = null; }

        if (!r) {
            emitToConsole(LEVEL.Error,
                format(LEVEL.Error, 'logger', 'no writable log location — file output disabled'));
            state.fileEnabled = false;
            return null;
        }

        try {
            state.logDir  = r.dir;
            state.logFile = r.dir.resolvePath('console.log');
        } catch (e) {
            state.logDir  = null;
            state.logFile = null;
            emitToConsole(LEVEL.Error,
                format(LEVEL.Error, 'logger', 'log file resolve threw: ' + e + ' — file output disabled'));
            state.fileEnabled = false;
            return null;
        }

        if (r.where === S.FileLocation.Application) {
            emitToConsole(LEVEL.Log,
                format(LEVEL.Log, 'logger', 'writing to ' + state.logFile.nativePath));
        } else if (r.where === S.FileLocation.Storage) {
            emitToConsole(LEVEL.Warn,
                format(LEVEL.Warn, 'logger', 'applicationDirectory unavailable, using applicationStorageDirectory ' +
                    state.logFile.nativePath));
        } else {
            emitToConsole(LEVEL.Warn,
                format(LEVEL.Warn, 'logger', 'storage dir unavailable, using documents fallback ' +
                    state.logFile.nativePath));
        }
        return state.logFile;
    }

    function rotateIfNeeded() {
        try {
            var maxBytes = state.maxFileSizeKB * 1024;
            if (maxBytes <= 0) return;
            var f = ensureLogFile();
            if (!f || !f.exists || f.size < maxBytes) return;

            // Drop the oldest, then shift each rotated file up by one suffix.
            for (var i = state.keepRotated; i >= 1; i--) {
                var older = state.logDir.resolvePath('console.log.' + i);
                if (i === state.keepRotated) {
                    if (older.exists) older.deleteFile();
                } else {
                    if (older.exists) {
                        var renamed = state.logDir.resolvePath('console.log.' + (i + 1));
                        if (renamed.exists) renamed.deleteFile();
                        older.moveTo(renamed, true);
                    }
                }
            }
            // Move current to .1
            var dotOne = state.logDir.resolvePath('console.log.1');
            if (dotOne.exists) dotOne.deleteFile();
            f.moveTo(dotOne, true);
            // Recreate fresh file by clearing the cached reference
            state.logFile = null;
        } catch (e) { /* swallow */ }
    }

    function emitToFile(line) {
        if (!state.fileEnabled) return;
        try {
            rotateIfNeeded();
            var f = ensureLogFile();
            if (!f) return;
            var stream = new air.FileStream();
            stream.open(f, air.FileMode.APPEND);
            stream.writeUTFBytes(line + '\n');
            stream.close();
        } catch (e) { /* swallow */ }
    }

    function shouldEmit(category) {
        if (!state.enabled) return false;
        if (!category) return true;
        if (state.categories[category] === false) return false;
        return true;
    }

    function emit(level, args) {
        var category = args[0] || 'kernel';
        // DEBUG-level is gated by an explicit master switch — these messages
        // are dropped silently when debugEnabled is false (default).
        if (level === LEVEL.Debug && !state.debugEnabled) return;
        if (!shouldEmit(category)) return;
        var line = format(level, category, joinArgs(args, 1));
        emitToConsole(level, line);
        emitToFile(line);
    }

    function debug() { emit(LEVEL.Debug, arguments); }
    function log()   { emit(LEVEL.Log,   arguments); }
    function warn()  { emit(LEVEL.Warn,  arguments); }
    function error() { emit(LEVEL.Error, arguments); }

    log.isEnabled = function (category) {
        return shouldEmit(category);
    };

    debug.isEnabled = function (category) {
        return state.debugEnabled && shouldEmit(category);
    };

    // Native path of the log file, resolving it on first use; null when no
    // writable location exists.
    log.filePath = function () {
        try {
            var f = ensureLogFile();
            return f ? f.nativePath : null;
        } catch (e) {
            return null;
        }
    };

    log.configure = function (cfg) {
        if (!cfg) return;
        if (typeof cfg.enabled === 'boolean')        state.enabled       = cfg.enabled;
        if (typeof cfg.debugEnabled === 'boolean')   state.debugEnabled  = cfg.debugEnabled;
        if (typeof cfg.fileEnabled === 'boolean')    state.fileEnabled   = cfg.fileEnabled;
        if (typeof cfg.maxFileSizeKB === 'number')   state.maxFileSizeKB = cfg.maxFileSizeKB;
        if (typeof cfg.keepRotated === 'number')     state.keepRotated   = cfg.keepRotated;
        if (cfg.categories && typeof cfg.categories === 'object') state.categories = cfg.categories;
    };

    S.kernel.debug = debug;
    S.kernel.log   = log;
    S.kernel.warn  = warn;
    S.kernel.error = error;

}(Steward));
