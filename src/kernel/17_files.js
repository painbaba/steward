/*
 * Kernel file API.
 *
 * Bundle place: 17_, after the enums (S.FileError, S.LogLevel,
 * S.FileLocation) and before the logger, because the logger resolves its own
 * log file through the path helpers below the first time it writes. At load time this file only assigns
 * Steward.kernel.files: no timer, no IO, and no state, so a script reload
 * needs nothing from it.
 *
 * AIR facts encoded here:
 *   - `air.File.applicationDirectory.resolvePath(...)` returns a File that AIR
 *     classifies as read-only application content; writing to it, or creating
 *     a directory through it, raises `SecurityError: fileWriteResource`.
 *     Round-tripping through `.nativePath` and `new air.File(path)` drops the
 *     classification. autoTSO (user_auto.js:163) and the host's user-script
 *     manager (0-manager.js:131) use the same trick; it was confirmed on the
 *     live AIR runtime with a path probe. Children resolved from the
 *     round-tripped File stay writable.
 *   - `air.File.createDirectory()` does not recurse: creating a/b/c while a/
 *     is missing throws, so ensureDir walks the parents first.
 *
 * Two levels:
 *   - Low level (appFile, ensureDir, writableDir) never calls
 *     Steward.kernel.log/warn/error, because the logger calls them while it is
 *     still resolving the file it would write to. They report through an
 *     optional note(level, message) callback (level: a Steward.LogLevel
 *     value) and never throw.
 *   - High level (stewardDir, info, readText, writeText, list, remove, browse;
 *     browse filters come from the caller) logs under category 'files' and is
 *     used by core and modules.
 *
 * Write semantics: writeText writes the whole text to `<path>.tmp` and then
 * moves it over the target with overwrite, so a failed write leaves the
 * previous file untouched. Residual risk: if AIR has already removed the
 * target when moveTo fails, the previous content is gone; the temp file is
 * deleted either way so it never shows up as a stray entry.
 */

(function (S) {

    // ---- Shared helpers ------------------------------------------------

    function hasFileApi() {
        return typeof air !== 'undefined' && !!air && !!air.File;
    }

    // Wraps an optional caller callback so a throwing or missing note never
    // escapes the low-level helpers.
    function noter(note) {
        return function (level, message) {
            if (typeof note !== 'function') return;
            try { note(level, message); } catch (e) { /* never propagate */ }
        };
    }

    // Note callback for the high-level functions: forwards to the logger,
    // resolved at call time so the test capture wrappers see it.
    function logNote(level, message) {
        try {
            if (level === S.LogLevel.Error) S.kernel.error('files', message);
            else if (level === S.LogLevel.Warn) S.kernel.warn('files', message);
            else S.kernel.log('files', message);
        } catch (e) { /* logging must not break file IO */ }
    }

    function pathOf(file) {
        return file && file.nativePath ? file.nativePath : '?';
    }

    function deleteQuietly(file) {
        try {
            if (file && file.exists) file.deleteFile();
        } catch (e) {
            logNote(S.LogLevel.Warn, 'could not delete ' + pathOf(file) + ': ' + e);
        }
    }

    function endsWith(name, suffix) {
        if (!suffix) return true;
        return name.length >= suffix.length &&
               name.substr(name.length - suffix.length) === suffix;
    }

    // ---- Low level: path plumbing ---------------------------------------

    // Writable File for a path relative to the client install directory
    // (see the round trip in the header). Null on any failure.
    function appFile(relPath, note) {
        var say = noter(note);
        if (!hasFileApi()) return null;
        try {
            var resolved = air.File.applicationDirectory.resolvePath(relPath);
            if (!resolved || !resolved.nativePath) {
                say(S.LogLevel.Warn, 'round-trip resolve gave no native path for ' + relPath);
                return null;
            }
            return new air.File(resolved.nativePath);
        } catch (e) {
            say(S.LogLevel.Warn, 'round-trip resolve threw for ' + relPath + ': ' + e);
            return null;
        }
    }

    // Creates dir and every missing parent. True when dir exists afterwards.
    function ensureDir(dir, note) {
        var say = noter(note);
        if (!dir) return false;
        try {
            if (dir.exists) return true;
            var parent = dir.parent;
            if (parent && !parent.exists) {
                if (!ensureDir(parent, note)) return false;
            }
            dir.createDirectory();
            return !!dir.exists;
        } catch (e) {
            say(S.LogLevel.Error, 'createDirectory failed for ' + pathOf(dir) + ': ' + e);
            return false;
        }
    }

    // One location policy for everything steward writes: the client install
    // directory (predictable, next to the client binaries), then the per-app
    // storage directory (buried in AppData but always writable), then the
    // user's documents as a last resort. Returns { dir, where } or null, where
    // `where` is the Steward.FileLocation value of the fallback that worked.
    function writableDir(relDir, note) {
        var say = noter(note);
        if (!hasFileApi()) return null;

        try {
            var primary = appFile(relDir, note);
            if (primary && ensureDir(primary, note)) {
                return { dir: primary, where: S.FileLocation.Application };
            }
        } catch (e) {
            say(S.LogLevel.Warn, 'applicationDirectory round-trip failed: ' + e);
        }

        try {
            var storage = air.File.applicationStorageDirectory.resolvePath(relDir);
            if (ensureDir(storage, note)) {
                return { dir: storage, where: S.FileLocation.Storage };
            }
        } catch (e) {
            say(S.LogLevel.Error, 'storage dir resolve threw: ' + e);
        }

        try {
            var docs = air.File.documentsDirectory.resolvePath(relDir);
            if (ensureDir(docs, note)) {
                return { dir: docs, where: S.FileLocation.Documents };
            }
        } catch (e) {
            say(S.LogLevel.Error, 'documents fallback threw: ' + e);
        }

        return null;
    }

    // ---- High level -----------------------------------------------------

    // A directory under steward's own folder, e.g. stewardDir('adventures/templates').
    function stewardDir(sub) {
        return writableDir('steward/' + sub, logNote);
    }

    function info(path) {
        if (!hasFileApi()) return null;
        try {
            var f = new air.File(path);
            var exists = !!f.exists;
            var isDir = exists ? !!f.isDirectory : false;
            var modified = null;
            if (exists && f.modificationDate && typeof f.modificationDate.getTime === 'function') {
                modified = f.modificationDate.getTime();
            }
            return {
                exists:      exists,
                isDirectory: isDir,
                // AIR throws on size of a missing file.
                size:        exists && !isDir ? f.size : 0,
                modified:    modified,
                name:        f.name,
                parent:      f.parent ? f.parent.nativePath : null,
                nativePath:  f.nativePath
            };
        } catch (e) {
            logNote(S.LogLevel.Warn, 'info failed for ' + path + ': ' + e);
            return null;
        }
    }

    function fail(error, message) {
        return { ok: false, error: error, message: message };
    }

    function readText(path) {
        if (!hasFileApi()) return fail(S.FileError.Unavailable, 'air.File unavailable');
        var f;
        try {
            f = new air.File(path);
            if (!f.exists) return fail(S.FileError.Missing, 'not found: ' + path);
        } catch (e) {
            logNote(S.LogLevel.Warn, 'read failed for ' + path + ': ' + e);
            return fail(S.FileError.Unreadable, String(e));
        }

        var stream = null;
        var opened = false;
        var text = null;
        var readError = null;
        try {
            stream = new air.FileStream();
            stream.open(f, air.FileMode.READ);
            opened = true;
            text = stream.readUTFBytes(stream.bytesAvailable);
        } catch (e) {
            readError = e;
        } finally {
            if (opened) {
                try { stream.close(); } catch (e2) { /* the read result stands */ }
            }
        }
        if (readError) {
            logNote(S.LogLevel.Warn, 'read failed for ' + path + ': ' + readError);
            return fail(S.FileError.Unreadable, String(readError));
        }

        text = text === null || text === undefined ? '' : String(text);
        // Editors on Windows often save UTF-8 with a byte order mark.
        if (text.length && text.charCodeAt(0) === 0xFEFF) text = text.substr(1);
        return { ok: true, text: text };
    }

    function writeText(path, text) {
        if (!hasFileApi()) {
            logNote(S.LogLevel.Error, 'write failed for ' + path + ': air.File unavailable');
            return fail(S.FileError.Unavailable, 'air.File unavailable');
        }
        var target;
        var tmp;
        try {
            target = new air.File(path);
            if (!ensureDir(target.parent, logNote)) {
                logNote(S.LogLevel.Error, 'write failed for ' + path + ': cannot create its folder');
                return fail(S.FileError.Unwritable, 'cannot create folder for ' + path);
            }
            tmp = new air.File(target.nativePath + '.tmp');
        } catch (e) {
            logNote(S.LogLevel.Error, 'write failed for ' + path + ': ' + e);
            return fail(S.FileError.Unwritable, String(e));
        }

        var stream = null;
        var opened = false;
        var writeError = null;
        try {
            stream = new air.FileStream();
            stream.open(tmp, air.FileMode.WRITE);
            opened = true;
            stream.writeUTFBytes(text === null || text === undefined ? '' : String(text));
        } catch (e) {
            writeError = e;
        } finally {
            if (opened) {
                // close() flushes, so its failure means the temp file is incomplete.
                try { stream.close(); } catch (e2) { if (!writeError) writeError = e2; }
            }
        }
        if (writeError) {
            deleteQuietly(tmp);
            logNote(S.LogLevel.Error, 'write failed for ' + path + ': ' + writeError);
            return fail(S.FileError.Unwritable, String(writeError));
        }

        try {
            tmp.moveTo(target, true);
        } catch (e) {
            deleteQuietly(tmp);
            logNote(S.LogLevel.Error, 'replace failed for ' + path + ': ' + e);
            return fail(S.FileError.Unwritable, String(e));
        }
        return { ok: true, path: target.nativePath };
    }

    // Files (not directories) in dirPath whose name ends with suffix, sorted
    // by name. `x.json.tmp` never matches '.json', so a write in progress is
    // never listed.
    function list(dirPath, suffix) {
        if (!hasFileApi()) return [];
        try {
            var dir = new air.File(dirPath);
            if (!dir.exists || !dir.isDirectory) return [];
            var entries = dir.getDirectoryListing() || [];
            var out = [];
            for (var i = 0; i < entries.length; i++) {
                var e = entries[i];
                if (!e || e.isDirectory) continue;
                if (!endsWith(String(e.name), suffix)) continue;
                out.push({ name: String(e.name), path: e.nativePath });
            }
            out.sort(function (a, b) {
                return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
            });
            return out;
        } catch (e) {
            logNote(S.LogLevel.Warn, 'list failed for ' + dirPath + ': ' + e);
            return [];
        }
    }

    function remove(path) {
        if (!hasFileApi()) return false;
        try {
            var f = new air.File(path);
            if (!f.exists) return false;
            f.deleteFile();
            return true;
        } catch (e) {
            logNote(S.LogLevel.Error, 'delete failed for ' + path + ': ' + e);
            return false;
        }
    }

    // Turns the caller's [{ label, pattern }] into AIR file filters. The kernel
    // knows no file types, so callers name their own; entries without a string
    // label and pattern are skipped, and when none remain the picker offers all
    // files rather than an empty filter list.
    function pickerFilters(list) {
        var out = [];
        if (list && typeof list.length === 'number') {
            for (var i = 0; i < list.length; i++) {
                var f = list[i];
                if (f && typeof f.label === 'string' && typeof f.pattern === 'string') {
                    out.push(new air.FileFilter(f.label, f.pattern));
                }
            }
        }
        if (out.length === 0) out.push(new air.FileFilter('All files', '*.*'));
        return out;
    }

    // Opens the native file picker. opts = { title, multiple, startDir,
    // filters }, filters being [{ label, pattern }] chosen by the caller.
    // onPick(paths) is called with the chosen native paths (in the picker's
    // order when multiple); a cancel calls nothing. Returns false when the
    // picker could not be opened.
    function browse(opts, onPick) {
        opts = opts || {};
        if (!hasFileApi()) {
            logNote(S.LogLevel.Error, 'browse failed: air.File unavailable');
            return false;
        }
        var start = null;
        var multiple = !!opts.multiple;
        var selectType = null;

        function cleanup() {
            try {
                start.removeEventListener(selectType, onSelect);
                start.removeEventListener(air.Event.CANCEL, onCancel);
            } catch (e) { /* listeners are gone with the File anyway */ }
        }

        function onSelect(ev) {
            cleanup();
            var paths = [];
            try {
                if (multiple) {
                    var files = (ev && ev.files) || [];
                    for (var i = 0; i < files.length; i++) paths.push(files[i].nativePath);
                } else {
                    paths.push((ev && ev.target ? ev.target : start).nativePath);
                }
                if (typeof onPick === 'function') onPick(paths);
            } catch (e) {
                logNote(S.LogLevel.Error, 'browse selection handler threw: ' + e);
            }
        }

        function onCancel() {
            cleanup();
        }

        try {
            if (typeof opts.startDir === 'string' && opts.startDir !== '') {
                var i0 = info(opts.startDir);
                if (i0 && i0.exists) start = new air.File(opts.startDir);
            }
            // A fresh File, so the listeners never sit on a shared directory object.
            if (!start) start = new air.File(air.File.documentsDirectory.nativePath);

            var filters = pickerFilters(opts.filters);
            var title = opts.title || 'Open';
            selectType = multiple ? air.FileListEvent.SELECT_MULTIPLE : air.Event.SELECT;
            start.addEventListener(selectType, onSelect);
            start.addEventListener(air.Event.CANCEL, onCancel);
            if (multiple) start.browseForOpenMultiple(title, filters);
            else start.browseForOpen(title, filters);
            return true;
        } catch (e) {
            if (start && selectType) cleanup();
            logNote(S.LogLevel.Error, 'browse failed: ' + e);
            return false;
        }
    }

    S.kernel.files = {
        appFile:     appFile,
        ensureDir:   ensureDir,
        writableDir: writableDir,
        stewardDir:  stewardDir,
        info:        info,
        readText:    readText,
        writeText:   writeText,
        list:        list,
        remove:      remove,
        browse:      browse
    };

}(Steward));
