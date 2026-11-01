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
 * console.log rotates by size, by day, or both, and at most keepRotated old
 * files stay beside it. Rotation is driven by the writes themselves with no
 * timer, so a quiet log rotates at its first line after midnight, and a failed
 * rotation only delays: the line is still written and history stays on disk.
 *
 * Stored settings are applied when the bundle loads (kernel/70_lifecycle.js),
 * before the first file write, so size, day and fileEnabled hold from the very
 * first line. With nothing stored, the defaults in state are the configuration.
 *
 * Failures inside the logger never throw — kernel-tick code must be able to
 * call this from anywhere without a try/catch.
 */

(function (S) {

    var LEVEL = S.LogLevel;

    var LOG_NAME = 'console.log';
    var ASIDE_NAME = LOG_NAME + '.rotating';   // the current file during a rotation

    var state = {
        enabled:        true,
        debugEnabled:   false,    // DEBUG-level lines are dropped unless this is true
        fileEnabled:    true,     // write to disk by default; configure() can flip off
        categories:     {},       // {} means "all enabled"
        maxFileSizeKB:  S.kernel.LIMITS.LOG_FILE_MAX_KB_DEFAULT,
        keepRotated:    S.kernel.LIMITS.LOG_KEEP_ROTATED_DEFAULT,
        rotateDaily:    S.kernel.LIMITS.LOG_ROTATE_DAILY_DEFAULT,
        fileBytes:      null,     // size of console.log; null until read from disk
        lastWriteDay:   null,     // dayKey of the last write; null when unknown
        rotateRetryAt:  0,        // ms; no rotation attempt before this time
        rotating:       false,    // recursion guard: file helpers log their failures
        rotatePending:  false,    // a rotation started and has not moved the file aside
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
            state.logFile = r.dir.resolvePath(LOG_NAME);
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

    function dayKey(d) {
        return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    }

    function rotatedName(n) { return LOG_NAME + '.' + n; }

    // Numbered rotated files, highest number first. Only a pure number counts,
    // so console.log.1.5, console.log.bak and the aside file are never touched.
    function rotatedFiles() {
        var prefix = LOG_NAME + '.';
        var entries = S.kernel.files.list(state.logDir.nativePath, '');
        var out = [];
        for (var i = 0; i < entries.length; i++) {
            var name = entries[i].name;
            if (name.indexOf(prefix) !== 0) continue;
            var rest = name.substring(prefix.length);
            if (!/^\d+$/.test(rest)) continue;
            out.push({ n: Number(rest), name: name, path: entries[i].path });
        }
        out.sort(function (a, b) { return b.n - a.n; });
        return out;
    }

    // Deletes numbered files above limit. False when one could not be deleted.
    function pruneRotated(limit) {
        var files = rotatedFiles();
        var ok = true;
        for (var i = 0; i < files.length; i++) {
            if (files[i].n > limit && !S.kernel.files.remove(files[i].path)) ok = false;
        }
        return ok;
    }

    function readDisk() {
        var f = S.kernel.files.info(state.logFile.nativePath);
        // info reports failure as null. Throw, so the caller lands in the
        // back-off and never rotates on stale values.
        if (!f) throw new Error('could not read ' + LOG_NAME);
        if (!f.exists) {
            state.fileBytes = 0;
            state.lastWriteDay = null;
            return;
        }
        state.fileBytes = f.size;
        // During an unfinished rotation the date is our own appended lines, not
        // a sign that another profile rotated, so it must not clear the due day.
        if (!state.rotatePending) {
            state.lastWriteDay = f.modified === null ? null : dayKey(new Date(f.modified));
        }
    }

    function rotationDue(today) {
        if (state.fileBytes === 0) return false;
        if (state.maxFileSizeKB > 0 && state.fileBytes >= state.maxFileSizeKB * 1024) return true;
        return state.rotateDaily && state.lastWriteDay !== null && state.lastWriteDay !== today;
    }

    // The current file holds today's lines only from here on, or nothing was due.
    function markCurrent(today) {
        state.lastWriteDay = today;
        state.rotatePending = false;
    }

    // The current file moves aside first: a failed first move changes nothing,
    // and a later failure leaves every file on disk under some name. Moves never
    // overwrite, so a surprise target aborts instead of destroying history.
    function rotateFiles(today) {
        var dir = state.logDir;
        state.rotatePending = true;
        // A leftover from a rotation that died here goes through the chain first;
        // the current file then stays due, with rotatePending still set, and
        // rotates on the next line.
        if (!dir.resolvePath(ASIDE_NAME).exists) {
            dir.resolvePath(LOG_NAME).moveTo(dir.resolvePath(ASIDE_NAME), false);
            state.fileBytes = 0;
            markCurrent(today);
        }
        if (!pruneRotated(state.keepRotated - 1)) throw new Error('could not delete an old rotated file');
        var files = rotatedFiles();
        for (var i = 0; i < files.length; i++) {
            dir.resolvePath(files[i].name).moveTo(dir.resolvePath(rotatedName(files[i].n + 1)), false);
        }
        if (state.keepRotated > 0) dir.resolvePath(ASIDE_NAME).moveTo(dir.resolvePath(rotatedName(1)), false);
        else dir.resolvePath(ASIDE_NAME).deleteFile();
    }

    // Returns a line for the log when rotation failed, else null. Catches
    // everything, so a rotation failure can never stop the line being written.
    function rotateIfNeeded() {
        if (state.rotating) return null;
        var now = new Date();
        state.rotating = true;
        try {
            var today = dayKey(now);
            if (state.fileBytes === null) readDisk();
            if (!rotationDue(today)) {
                markCurrent(today);
                return null;
            }
            if (now.getTime() < state.rotateRetryAt) return null;
            // A second profile or an outside truncation may have changed the
            // file since the counter was seeded.
            readDisk();
            if (!rotationDue(today)) {
                markCurrent(today);
                return null;
            }
            rotateFiles(today);
            return null;
        } catch (e) {
            var retryMs = S.kernel.TIMEOUTS.LOG_ROTATE_RETRY_MS;
            state.rotateRetryAt = now.getTime() + retryMs;
            var note = format(LEVEL.Warn, 'logger', 'rotation failed, retry in ' + (retryMs / 1000) + ' s: ' + e);
            emitToConsole(LEVEL.Warn, note);
            return note;
        } finally {
            state.rotating = false;
        }
    }

    function emitToFile(line) {
        if (!state.fileEnabled) return;
        try {
            var f = ensureLogFile();
            if (!f) return;
            var note = rotateIfNeeded();
            var text = (note ? note + '\n' : '') + line + '\n';
            var stream = new air.FileStream();
            stream.open(f, air.FileMode.APPEND);
            stream.writeUTFBytes(text);
            stream.close();
            // Characters, not bytes: non-ASCII lines run slightly past the cap
            // and the disk confirm before a rotation covers the real size.
            if (state.fileBytes !== null) state.fileBytes += text.length;
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

    function validCount(value) {
        return typeof value === 'number' && isFinite(value) && value >= 0;
    }

    log.configure = function (cfg) {
        if (!cfg) return;
        if (typeof cfg.enabled === 'boolean')        state.enabled       = cfg.enabled;
        if (typeof cfg.debugEnabled === 'boolean')   state.debugEnabled  = cfg.debugEnabled;
        if (typeof cfg.fileEnabled === 'boolean')    state.fileEnabled   = cfg.fileEnabled;
        if (typeof cfg.rotateDaily === 'boolean')    state.rotateDaily   = cfg.rotateDaily;
        if (validCount(cfg.maxFileSizeKB))           state.maxFileSizeKB = Math.floor(cfg.maxFileSizeKB);
        if (cfg.categories && typeof cfg.categories === 'object') state.categories = cfg.categories;
        if (validCount(cfg.keepRotated)) {
            state.keepRotated = Math.floor(cfg.keepRotated);
            if (state.fileEnabled) {
                // Lowering keep must not wait for the next rotation to free the
                // disk. The guard stops a failed delete re-entering the logger
                // from rotating in the middle of this.
                state.rotating = true;
                try {
                    if (ensureLogFile()) pruneRotated(state.keepRotated);
                } catch (e) { /* swallow */ }
                finally { state.rotating = false; }
            }
        }
    };

    // What is in force now: the single source for the Settings screen.
    log.effective = function () {
        return {
            debugEnabled:  state.debugEnabled,
            fileEnabled:   state.fileEnabled,
            maxFileSizeKB: state.maxFileSizeKB,
            keepRotated:   state.keepRotated,
            rotateDaily:   state.rotateDaily
        };
    };

    S.kernel.debug = debug;
    S.kernel.log   = log;
    S.kernel.warn  = warn;
    S.kernel.error = error;

}(Steward));
