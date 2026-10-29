/*
 * Run-template store for the adventures module.
 *
 * Storage layout: one JSON file per template in
 * <steward folder>/adventures/templates/<id>.json, where the steward folder
 * is the one the logger writes to (S.kernel.files.stewardDir applies the
 * single location policy). Templates are shared across game profiles: a
 * record holds only paths and names, and the general uid keys live in the
 * user's battle files.
 *
 * The file name is the id. The id is never written into the file, so the
 * two can never disagree, and a stored `id` field in a hand-edited file is
 * ignored. Any file in the folder whose base name matches ID_RE and ends in
 * EXT is a template, so a file shared by someone else can simply be dropped
 * in. File format: JSON.stringify of
 *   { version, label, adventure, loadout, waves, speedBuff, saved }
 * indented, so it stays readable and shareable.
 *
 * A file that cannot be read or parsed is listed as a broken entry
 * { id, path, error } instead of being skipped, so the user sees it and can
 * delete it.
 *
 * Write safety comes from S.kernel.files.writeText (temp file, then move):
 * a failed save leaves the previous file intact.
 *
 * Wave files are referenced by path and read fresh at every dry run; their
 * content is never copied into a template.
 *
 * The two module settings (default horseshoe, last picker folder) are read
 * and written only through the helpers below.
 */

(function (S) {

    if (!S.modules.adventures) S.modules.adventures = {};

    var SUBDIR = 'adventures/templates';
    var EXT = '.json';
    var FORMAT_VERSION = 1;
    var ID_RE = /^[A-Za-z0-9_-]+$/;

    function isArray(v) {
        return Object.prototype.toString.call(v) === '[object Array]';
    }

    function isPlainObject(v) {
        return v !== null && typeof v === 'object' && Object.prototype.toString.call(v) === '[object Object]';
    }

    function str(v) {
        return typeof v === 'string' ? v : '';
    }

    function validId(id) {
        return typeof id === 'string' && ID_RE.test(id);
    }

    // ---- Location ---------------------------------------------------------

    function dir() {
        return S.kernel.files.stewardDir(SUBDIR);
    }

    function dirPath() {
        var d = dir();
        return d && d.dir ? d.dir.nativePath : null;
    }

    // Resolved through AIR rather than joined by hand, so the separator is
    // always the platform's.
    function pathOf(id) {
        if (!validId(id)) return null;
        var d = dir();
        if (!d || !d.dir) return null;
        try {
            return d.dir.resolvePath(id + EXT).nativePath;
        } catch (e) {
            S.kernel.warn('adventures', 'cannot resolve template path for', id, ':', e);
            return null;
        }
    }

    // ---- Module settings ----------------------------------------------------

    function settings() {
        var defs = S.modules.adventures.defaultSettings || {};
        var stored = S.kernel.settings.read('adventures') || {};
        var out = {};
        for (var k in defs) {
            if (!Object.prototype.hasOwnProperty.call(defs, k)) continue;
            out[k] = Object.prototype.hasOwnProperty.call(stored, k) ? stored[k] : defs[k];
        }
        return out;
    }

    function setKey(key, value) {
        var whole = settings();
        whole[key] = value;
        return S.kernel.settings.write('adventures', whole);
    }

    function defaultSpeedBuff() {
        return settings().defaultSpeedBuff;
    }

    // The default itself cannot be "Default": it is None or a horseshoe name.
    function setDefaultSpeedBuff(v) {
        if (v !== S.SpeedBuffChoice.None && !S.core.buffs.isSpeedBuff(v)) return false;
        return setKey('defaultSpeedBuff', v);
    }

    function lastDir() {
        return str(settings().lastDir);
    }

    function setLastDir(path) {
        return setKey('lastDir', str(path));
    }

    // ---- Records --------------------------------------------------------------

    function normalize(rec) {
        rec = rec || {};
        var waves = [];
        if (isArray(rec.waves)) {
            for (var i = 0; i < rec.waves.length; i++) {
                if (typeof rec.waves[i] === 'string') waves.push(rec.waves[i]);
            }
        }
        return {
            id:        rec.id === undefined ? null : rec.id,
            label:     str(rec.label).replace(/^\s+|\s+$/g, ''),
            adventure: str(rec.adventure),
            loadout:   str(rec.loadout),
            waves:     waves,
            speedBuff: speedBuffChoice(rec),
            saved:     typeof rec.saved === 'number' ? rec.saved : null
        };
    }

    function broken(id, path, error) {
        return { id: id, path: path, error: error };
    }

    // Pure. The id always comes from the file name.
    function fromFile(id, path, text) {
        var data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            return broken(id, path, 'not valid JSON: ' + e);
        }
        if (!isPlainObject(data)) return broken(id, path, 'not a template: top level is not an object');
        var rec = normalize({
            label:     data.label,
            adventure: data.adventure,
            loadout:   data.loadout,
            waves:     data.waves,
            speedBuff: data.speedBuff,
            saved:     data.saved
        });
        rec.id = id;
        return rec;
    }

    // Pure.
    function toFile(rec) {
        return JSON.stringify({
            version:   FORMAT_VERSION,
            label:     rec.label,
            adventure: rec.adventure,
            loadout:   rec.loadout,
            waves:     rec.waves,
            speedBuff: rec.speedBuff,
            saved:     rec.saved
        }, null, 2);
    }

    function baseName(name) {
        return name.substr(0, name.length - EXT.length);
    }

    // Template files in the folder: { id, path } for each base name that is a
    // valid id. Null when there is no writable steward folder.
    function entries() {
        var p = dirPath();
        if (!p) return null;
        var files = S.kernel.files.list(p, EXT);
        var out = [];
        for (var i = 0; i < files.length; i++) {
            var id = baseName(files[i].name);
            if (validId(id)) out.push({ id: id, path: files[i].path });
        }
        return out;
    }

    function readEntry(e) {
        var r = S.kernel.files.readText(e.path);
        if (!r.ok) return broken(e.id, e.path, r.message);
        return fromFile(e.id, e.path, r.text);
    }

    // Records sorted by label (case-insensitive), then broken entries by id.
    function list() {
        var es = entries();
        if (es === null) {
            S.kernel.warn('adventures', 'no writable steward folder: template list is empty');
            return [];
        }
        var recs = [];
        var bad = [];
        for (var i = 0; i < es.length; i++) {
            var r = readEntry(es[i]);
            if (r.error !== undefined) bad.push(r);
            else recs.push(r);
        }
        recs.sort(function (a, b) {
            var x = a.label.toLowerCase(), y = b.label.toLowerCase();
            if (x !== y) return x < y ? -1 : 1;
            return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
        });
        bad.sort(function (a, b) {
            return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
        });
        return recs.concat(bad);
    }

    function ids() {
        var es = entries() || [];
        var out = [];
        for (var i = 0; i < es.length; i++) out.push(es[i].id);
        return out;
    }

    // The record, or null when the id is invalid, missing or broken.
    function get(id) {
        var path = pathOf(id);
        if (!path) return null;
        var info = S.kernel.files.info(path);
        if (!info || !info.exists) return null;
        var r = readEntry({ id: id, path: path });
        return r.error !== undefined ? null : r;
    }

    function validate(rec) {
        var out = [];
        if (!rec.label) out.push({ field: 'label', message: 'Label is empty' });
        if (!rec.adventure) out.push({ field: 'adventure', message: 'No adventure chosen' });
        if (!rec.loadout) out.push({ field: 'loadout', message: 'No loadout file chosen' });
        if (!isArray(rec.waves) || rec.waves.length === 0) {
            out.push({ field: 'waves', message: 'No wave files' });
        } else {
            // Duplicates are valid: the same wave file may run more than once.
            for (var i = 0; i < rec.waves.length; i++) {
                if (typeof rec.waves[i] !== 'string' || rec.waves[i] === '') {
                    out.push({ field: 'waves', message: 'Wave ' + (i + 1) + ' has no file' });
                }
            }
        }
        var sb = rec.speedBuff;
        if (sb !== S.SpeedBuffChoice.Default && sb !== S.SpeedBuffChoice.None &&
            !S.core.buffs.isSpeedBuff(sb)) {
            out.push({ field: 'speedBuff', message: 'Unknown horseshoe ' + sb });
        }
        return out;
    }

    // Pure. 't' + timestamp, suffixed -2, -3, ... while taken.
    function newId(now, existing) {
        existing = existing || [];
        var base = 't' + now;
        var id = base;
        var n = 2;
        while (existing.indexOf(id) !== -1) {
            id = base + '-' + n;
            n++;
        }
        return id;
    }

    function save(rec, now) {
        var r = normalize(rec);
        var problems = validate(r);
        if (problems.length) return { ok: false, problems: problems };

        if (dirPath() === null) {
            return { ok: false, problems: [{ field: 'file', message: 'No writable steward folder' }] };
        }
        var id = validId(r.id) ? r.id : newId(now, ids());
        r.id = id;
        r.saved = now;
        var path = pathOf(id);
        if (!path) {
            return { ok: false, problems: [{ field: 'file', message: 'No writable steward folder' }] };
        }
        var w = S.kernel.files.writeText(path, toFile(r));
        if (!w.ok) return { ok: false, problems: [{ field: 'file', message: w.message }] };
        return { ok: true, id: id, path: w.path };
    }

    function remove(id) {
        var path = pathOf(id);
        if (!path) return false;
        return S.kernel.files.remove(path);
    }

    // ---- Horseshoe --------------------------------------------------------------

    // Pure. A record's horseshoe choice: its own speedBuff, or Default when
    // that is missing, empty or not a string. The only place the
    // empty-means-Default rule lives, so records, runs and reports agree.
    function speedBuffChoice(rec) {
        return rec && typeof rec.speedBuff === 'string' && rec.speedBuff !== ''
            ? rec.speedBuff : S.SpeedBuffChoice.Default;
    }

    // Pure. The horseshoe name a run would use, or null for none.
    function resolveSpeedBuff(rec, defaultName) {
        var choice = speedBuffChoice(rec);
        if (choice === S.SpeedBuffChoice.None) return null;
        if (choice === S.SpeedBuffChoice.Default) {
            if (!defaultName || defaultName === S.SpeedBuffChoice.None) return null;
            return defaultName;
        }
        return choice;
    }

    function buffOption(b) {
        var amount = typeof b.amount === 'number' ? b.amount : 0;
        var label = (b.label || b.name) + ' (' + amount + ')' + (b.effect ? ': ' + b.effect : '');
        var warn = amount === 0;
        if (warn) label += ' — none in stock';
        return { value: b.name, label: label, amount: amount, warn: warn };
    }

    function buffLabel(buffs, name) {
        for (var i = 0; i < buffs.length; i++) {
            if (buffs[i].name === name) return buffs[i].label || name;
        }
        return name;
    }

    // One option per buff, plus `keep` appended (amount 0, warn) when it is a
    // stored horseshoe name no longer in the list, so editing a template never
    // silently changes its choice.
    function buffOptions(buffs, keep) {
        var out = [];
        var seen = false;
        for (var i = 0; i < buffs.length; i++) {
            out.push(buffOption(buffs[i]));
            if (buffs[i].name === keep) seen = true;
        }
        if (!seen && typeof keep === 'string' && keep !== '' &&
            keep !== S.SpeedBuffChoice.Default && keep !== S.SpeedBuffChoice.None) {
            out.push(buffOption({ name: keep, label: keep, amount: 0, effect: '' }));
        }
        return out;
    }

    // Pure over `buffs` as from S.core.buffs.speedBuffs(). `stored` is the
    // edited record's current choice.
    function speedBuffOptions(buffs, defaultName, stored) {
        buffs = buffs || [];
        var defLabel = !defaultName || defaultName === S.SpeedBuffChoice.None
            ? 'none' : buffLabel(buffs, defaultName);
        var out = [
            { value: S.SpeedBuffChoice.Default, label: 'Default (' + defLabel + ')', amount: null, warn: false },
            { value: S.SpeedBuffChoice.None, label: 'None', amount: null, warn: false }
        ];
        return out.concat(buffOptions(buffs, stored));
    }

    // For the default-horseshoe row: no Default entry. `current` is the
    // stored default, kept when it is no longer listed.
    function defaultOptions(buffs, current) {
        var out = [{ value: S.SpeedBuffChoice.None, label: 'None', amount: null, warn: false }];
        return out.concat(buffOptions(buffs || [], current));
    }

    S.modules.adventures.templates = {
        SUBDIR:              SUBDIR,
        EXT:                 EXT,
        FORMAT_VERSION:      FORMAT_VERSION,
        ID_RE:               ID_RE,
        dir:                 dir,
        dirPath:             dirPath,
        pathOf:              pathOf,
        settings:            settings,
        defaultSpeedBuff:    defaultSpeedBuff,
        setDefaultSpeedBuff: setDefaultSpeedBuff,
        lastDir:             lastDir,
        setLastDir:          setLastDir,
        normalize:           normalize,
        fromFile:            fromFile,
        toFile:              toFile,
        list:                list,
        ids:                 ids,
        get:                 get,
        validate:            validate,
        newId:               newId,
        save:                save,
        remove:              remove,
        speedBuffChoice:     speedBuffChoice,
        resolveSpeedBuff:    resolveSpeedBuff,
        buffLabel:           buffLabel,
        speedBuffOptions:    speedBuffOptions,
        defaultOptions:      defaultOptions
    };

}(Steward));
