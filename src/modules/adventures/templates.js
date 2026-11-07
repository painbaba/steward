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
 * indented, so it stays readable and shareable. An older file may carry a
 * `retrain` key; it is ignored, because retraining is a module setting.
 *
 * A file that cannot be read or parsed is listed as a broken entry
 * { id, path, error } instead of being skipped, so the user sees it and can
 * delete it.
 *
 * Write safety comes from S.kernel.files.writeText (temp file, then move):
 * a failed save leaves the previous file intact.
 *
 * Wave files are referenced by path and read fresh when used; their
 * content is never copied into a template.
 *
 * The one module setting (last picker folder) is read and written only
 * through the helpers below.
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

    // Pure. Battle files come from pickers and from hand-edited templates, so
    // either separator can appear whatever the platform.
    function fileName(path) {
        var p = String(path || '');
        var cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
        return cut === -1 ? p : p.substring(cut + 1);
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
    // Default means "the first speed buff in stock at use"; it exists for
    // template files written before the module-wide default was dropped.
    function speedBuffChoice(rec) {
        return rec && typeof rec.speedBuff === 'string' && rec.speedBuff !== ''
            ? rec.speedBuff : S.SpeedBuffChoice.Default;
    }

    // Pure over `buffs` as from S.core.buffs.speedBuffs(), which is already
    // sorted by name, so this is the first speed buff in stock alphabetically.
    // Null when none is in stock.
    function firstAvailable(buffs) {
        for (var i = 0; i < buffs.length; i++) {
            if (typeof buffs[i].amount === 'number' && buffs[i].amount > 0) return buffs[i].name;
        }
        return null;
    }

    // Pure. The horseshoe name a run would use, or null for none.
    function resolveSpeedBuff(rec, buffs) {
        var choice = speedBuffChoice(rec);
        if (choice === S.SpeedBuffChoice.None) return null;
        if (choice === S.SpeedBuffChoice.Default) return firstAvailable(buffs || []);
        return choice;
    }

    // Pure. The concrete choice the editor starts with: a Default record
    // turns into the first speed buff in stock (None when nothing is), so the
    // next save stores an explicit name.
    function initialSpeedBuff(rec, buffs) {
        var choice = speedBuffChoice(rec);
        if (choice !== S.SpeedBuffChoice.Default) return choice;
        return firstAvailable(buffs || []) || S.SpeedBuffChoice.None;
    }

    // Pure. The choice for a horseshoe switch turned on: the buff it held
    // before it went off, else the first in stock, else the first listed, so
    // a template can name a horseshoe that is not in stock yet. None only when
    // the game lists no speed buff at all.
    function enabledSpeedBuff(last, buffs) {
        if (typeof last === 'string' && last !== '' && last !== S.SpeedBuffChoice.None) return last;
        var list = buffs || [];
        var first = firstAvailable(list);
        if (first !== null) return first;
        return list.length ? list[0].name : S.SpeedBuffChoice.None;
    }

    // Pure. The label to put in the editor after the adventure changed from
    // prev to next, or null to keep the current text. A label that is empty
    // or still equal to the previous adventure's name was not typed by the
    // user, so it follows the adventure.
    function autoLabel(current, prevAdventureLabel, nextAdventureLabel) {
        var cur = str(current).replace(/^\s+|\s+$/g, '');
        if (cur === '' || cur === str(prevAdventureLabel)) return str(nextAdventureLabel);
        return null;
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
    // edited record's current choice. None is not an option: it is the off
    // state of the editor's horseshoe switch.
    function speedBuffOptions(buffs, stored) {
        return buffOptions(buffs || [], stored);
    }

    // Pure. The waves in drag order: `order` lists the old indices in their new
    // positions. Anything but a permutation of 0..n-1 returns null, so a stale
    // or half-read DOM order can never drop or duplicate a wave. Duplicate
    // paths are fine: a wave file may be run more than once.
    function reorderWaves(waves, order) {
        if (!waves || typeof waves.length !== 'number') return null;
        if (!order || typeof order.length !== 'number' || order.length !== waves.length) return null;
        var n = waves.length;
        var seen = {};
        var out = [];
        for (var i = 0; i < n; i++) {
            var at = order[i];
            if (typeof at !== 'number' || at !== Math.floor(at) || at < 0 || at >= n) return null;
            if (seen[at]) return null;
            seen[at] = true;
            out.push(waves[at]);
        }
        return out;
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
        firstAvailable:      firstAvailable,
        resolveSpeedBuff:    resolveSpeedBuff,
        initialSpeedBuff:    initialSpeedBuff,
        enabledSpeedBuff:    enabledSpeedBuff,
        fileName:            fileName,
        autoLabel:           autoLabel,
        buffLabel:           buffLabel,
        speedBuffOptions:    speedBuffOptions,
        reorderWaves:        reorderWaves
    };

}(Steward));
