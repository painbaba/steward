'use strict';

var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');

var assert = t.assert;

// Objects built inside the vm context have that realm's prototypes, so
// deepStrictEqual compares a plain copy.
function plain(v) { return JSON.parse(JSON.stringify(v)); }

function setup(fsOpts, hostOpts) {
    var fs = airfs.make(fsOpts || {});
    var host = hostOpts || {};
    host.air = fs.air;
    var H = harness.boot({ sections: ['kernel'], host: host });
    return { fs: fs, H: H, files: H.Steward.kernel.files, S: H.Steward };
}

function hasLog(H, level, re) {
    var logs = H.logs();
    for (var i = 0; i < logs.length; i++) {
        if (logs[i].level === level && re.test(String(logs[i].args.join(' ')))) return true;
    }
    return false;
}

function keysEndingWith(map, suffix) {
    return Object.keys(map).filter(function (k) {
        return k.length >= suffix.length && k.substr(k.length - suffix.length) === suffix;
    });
}

// ---- enums ----------------------------------------------------------------

t.test('S.FileError and S.SpeedBuffChoice values exist and the new slots are objects', function () {
    var s = setup();
    assert.strictEqual(s.S.FileError.Missing, 'FileMissing');
    assert.strictEqual(s.S.FileError.Unreadable, 'FileUnreadable');
    assert.strictEqual(s.S.FileError.Unwritable, 'FileUnwritable');
    assert.strictEqual(s.S.FileError.Unavailable, 'FileUnavailable');
    assert.strictEqual(s.S.SpeedBuffChoice.Default, 'SpeedBuffDefault');
    assert.strictEqual(s.S.SpeedBuffChoice.None, 'SpeedBuffNone');
    assert.strictEqual(typeof s.S.TroopClass, 'object');
    assert.strictEqual(typeof s.S.BattleLine, 'object');
    assert.strictEqual(typeof s.S.BattleProblem, 'object');
});

t.test('LogLevel values are the printed log tags', function () {
    var s = setup();
    assert.strictEqual(s.S.LogLevel.Debug, 'DEBUG');
    assert.strictEqual(s.S.LogLevel.Log, 'LOG');
    assert.strictEqual(s.S.LogLevel.Warn, 'WARN');
    assert.strictEqual(s.S.LogLevel.Error, 'ERROR');
    assert.strictEqual(s.S.FileLocation.Application, 'FileLocationApplication');
    assert.strictEqual(s.S.FileLocation.Storage, 'FileLocationStorage');
    assert.strictEqual(s.S.FileLocation.Documents, 'FileLocationDocuments');
});

// ---- low level ------------------------------------------------------------

t.test('appFile round trip drops the app-content flag', function () {
    var s = setup();
    var air = s.fs.air;
    // Directly through applicationDirectory: AIR refuses the write.
    assert.throws(function () {
        air.File.applicationDirectory.resolvePath('steward').createDirectory();
    }, /fileWriteResource/);
    var f = s.files.appFile('steward');
    assert.strictEqual(f.nativePath, 'C:/client/steward');
    f.createDirectory();
    assert.strictEqual(s.fs.dirs['C:/client/steward'], true);
});

t.test('ensureDir creates nested parents', function () {
    var s = setup();
    var dir = s.fs.file('C:/store/a/b/c');
    assert.strictEqual(s.files.ensureDir(dir), true);
    assert.strictEqual(s.fs.dirs['C:/store/a'], true);
    assert.strictEqual(s.fs.dirs['C:/store/a/b'], true);
    assert.strictEqual(s.fs.dirs['C:/store/a/b/c'], true);
});

t.test('writableDir prefers the client install directory', function () {
    var s = setup();
    var notes = [];
    var r = s.files.writableDir('steward/x', function (lvl, msg) { notes.push(lvl + ' ' + msg); });
    assert.strictEqual(r.where, s.S.FileLocation.Application);
    assert.strictEqual(r.dir.nativePath, 'C:/client/steward/x');
    assert.strictEqual(notes.length, 0);
});

t.test('writableDir falls back to storage and notes why', function () {
    var s = setup({ appReadOnly: true });
    var notes = [];
    var r = s.files.writableDir('steward/x', function (lvl, msg) { notes.push(lvl + ' ' + msg); });
    assert.strictEqual(r.where, s.S.FileLocation.Storage);
    assert.strictEqual(r.dir.nativePath, 'C:/store/steward/x');
    assert.ok(notes.length >= 1);
    assert.ok(/createDirectory failed/.test(notes[0]));
});

t.test('writableDir notes use Steward.LogLevel values', function () {
    var s = setup({ appReadOnly: true });
    var levels = [];
    s.files.writableDir('steward/x', function (lvl) { levels.push(lvl); });
    var known = Object.keys(s.S.LogLevel).map(function (k) { return s.S.LogLevel[k]; });
    assert.ok(levels.length >= 1);
    levels.forEach(function (lvl) { assert.ok(known.indexOf(lvl) >= 0, 'unknown level ' + lvl); });
    // The refused createDirectory on the install directory is the error that
    // sends writableDir to storage.
    assert.ok(levels.indexOf(s.S.LogLevel.Error) >= 0);
});

t.test('writableDir is null without air.File', function () {
    var H = harness.boot({ sections: ['kernel'], host: { air: { Introspector: { Console: {} } } } });
    assert.strictEqual(H.Steward.kernel.files.writableDir('steward/x'), null);
});

t.test('stewardDir resolves under <client>/steward', function () {
    var s = setup();
    var r = s.files.stewardDir('adventures/templates');
    assert.strictEqual(r.dir.nativePath, 'C:/client/steward/adventures/templates');
    assert.strictEqual(s.fs.dirs['C:/client/steward/adventures/templates'], true);
});

// ---- logger on the shared helpers ------------------------------------------

t.test('log.filePath is under the client install directory', function () {
    var s = setup();
    assert.strictEqual(s.S.kernel.log.filePath(), 'C:/client/steward/logs/console.log');
});

t.test('log.filePath falls back to storage when the install directory is read-only', function () {
    var s = setup({ appReadOnly: true });
    assert.strictEqual(s.S.kernel.log.filePath(), 'C:/store/steward/logs/console.log');
});

// ---- readText -------------------------------------------------------------

t.test('readText of a missing file is FileMissing', function () {
    var s = setup();
    var r = s.files.readText('C:/docs/none.txt');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'FileMissing');
});

t.test('readText returns the text and strips one BOM', function () {
    var s = setup();
    s.fs.disk['C:/docs/a.txt'] = 'hello';
    s.fs.disk['C:/docs/b.txt'] = '\uFEFF{"x":1}';
    assert.deepStrictEqual(plain(s.files.readText('C:/docs/a.txt')), { ok: true, text: 'hello' });
    assert.deepStrictEqual(plain(s.files.readText('C:/docs/b.txt')), { ok: true, text: '{"x":1}' });
    assert.ok(s.fs.stats.opens >= 2);
    assert.strictEqual(s.fs.stats.closes, s.fs.stats.opens);
});

t.test('readText fault is FileUnreadable and the stream is still closed', function () {
    var s = setup();
    s.fs.disk['C:/docs/a.txt'] = 'hello';
    s.fs.fail.read['C:/docs/a.txt'] = true;
    var r = s.files.readText('C:/docs/a.txt');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'FileUnreadable');
    // Compared as a pair: with DEBUG_LOG the logger appends through the same stub.
    assert.ok(s.fs.stats.opens >= 1);
    assert.strictEqual(s.fs.stats.closes, s.fs.stats.opens);
});

// ---- writeText ------------------------------------------------------------

t.test('writeText creates parents and the file and leaves no .tmp', function () {
    var s = setup();
    var r = s.files.writeText('C:/client/steward/t/a.json', '{"a":1}');
    assert.deepStrictEqual(plain(r), { ok: true, path: 'C:/client/steward/t/a.json' });
    assert.strictEqual(s.fs.disk['C:/client/steward/t/a.json'], '{"a":1}');
    assert.deepStrictEqual(keysEndingWith(s.fs.disk, '.tmp'), []);
});

t.test('writeText replaces an existing file', function () {
    var s = setup();
    s.fs.dirs['C:/store/t'] = true;
    s.fs.disk['C:/store/t/a.json'] = 'old';
    var r = s.files.writeText('C:/store/t/a.json', 'new');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(s.fs.disk['C:/store/t/a.json'], 'new');
    assert.deepStrictEqual(keysEndingWith(s.fs.disk, '.tmp'), []);
});

t.test('writeText write fault is FileUnwritable, keeps the old file, leaves no .tmp', function () {
    var s = setup();
    s.fs.dirs['C:/store/t'] = true;
    s.fs.disk['C:/store/t/a.json'] = 'old';
    s.fs.fail.write['C:/store/t/a.json.tmp'] = true;
    var r = s.files.writeText('C:/store/t/a.json', 'new');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'FileUnwritable');
    assert.strictEqual(s.fs.disk['C:/store/t/a.json'], 'old');
    assert.deepStrictEqual(keysEndingWith(s.fs.disk, '.tmp'), []);
    assert.strictEqual(s.fs.stats.closes, s.fs.stats.opens);
    assert.ok(hasLog(s.H, 'error', /write failed/));
});

t.test('writeText move fault is FileUnwritable, keeps the old file, leaves no .tmp', function () {
    var s = setup();
    s.fs.dirs['C:/store/t'] = true;
    s.fs.disk['C:/store/t/a.json'] = 'old';
    s.fs.fail.move['C:/store/t/a.json'] = true;
    var r = s.files.writeText('C:/store/t/a.json', 'new');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'FileUnwritable');
    assert.strictEqual(s.fs.disk['C:/store/t/a.json'], 'old');
    assert.deepStrictEqual(keysEndingWith(s.fs.disk, '.tmp'), []);
});

t.test('writeText without air.File is FileUnavailable', function () {
    var H = harness.boot({ sections: ['kernel'], host: { air: { Introspector: { Console: {} } } } });
    var r = H.Steward.kernel.files.writeText('C:/x.json', 'x');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'FileUnavailable');
});

// ---- list / remove / info ----------------------------------------------------

t.test('list filters by suffix, skips directories and .tmp, sorts by name', function () {
    var s = setup();
    s.fs.dirs['C:/store/t'] = true;
    s.fs.dirs['C:/store/t/sub.json'] = true;
    s.fs.disk['C:/store/t/b.json'] = '1';
    s.fs.disk['C:/store/t/a.json'] = '2';
    s.fs.disk['C:/store/t/c.json.tmp'] = '3';
    s.fs.disk['C:/store/t/d.txt'] = '4';
    s.fs.disk['C:/store/other.json'] = '5';
    assert.deepStrictEqual(plain(s.files.list('C:/store/t', '.json')), [
        { name: 'a.json', path: 'C:/store/t/a.json' },
        { name: 'b.json', path: 'C:/store/t/b.json' }
    ]);
    assert.deepStrictEqual(plain(s.files.list('C:/store/missing', '.json')), []);
});

t.test('remove deletes an existing file and is false for a missing one', function () {
    var s = setup();
    s.fs.disk['C:/store/a.json'] = 'x';
    assert.strictEqual(s.files.remove('C:/store/a.json'), true);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(s.fs.disk, 'C:/store/a.json'), false);
    assert.strictEqual(s.files.remove('C:/store/a.json'), false);
});

t.test('info reports file and directory fields', function () {
    var s = setup();
    s.fs.disk['C:/store/a.json'] = 'abc';
    var i = s.files.info('C:/store/a.json');
    assert.strictEqual(i.exists, true);
    assert.strictEqual(i.isDirectory, false);
    assert.strictEqual(i.size, 3);
    assert.strictEqual(typeof i.modified, 'number');
    assert.strictEqual(i.name, 'a.json');
    assert.strictEqual(i.parent, 'C:/store');
    assert.strictEqual(i.nativePath, 'C:/store/a.json');
    var d = s.files.info('C:/store');
    assert.strictEqual(d.exists, true);
    assert.strictEqual(d.isDirectory, true);
    var m = s.files.info('C:/store/none');
    assert.strictEqual(m.exists, false);
    assert.strictEqual(m.size, 0);
    assert.strictEqual(m.modified, null);
});

// ---- browse ---------------------------------------------------------------

t.test('browse single fires onPick with the chosen path and removes listeners', function () {
    var s = setup();
    s.fs.dirs['C:/docs/battles'] = true;
    var picked = null;
    var ok = s.files.browse({
        title: 'Pick',
        startDir: 'C:/docs/battles',
        filters: [{ label: 'Battle files', pattern: '*.txt' }, { label: 'All files', pattern: '*.*' }]
    }, function (p) { picked = p; });
    assert.strictEqual(ok, true);
    assert.strictEqual(s.fs.browses.length, 1);
    var b = s.fs.browses[0];
    assert.strictEqual(b.multiple, false);
    assert.strictEqual(b.title, 'Pick');
    assert.strictEqual(b.file.nativePath, 'C:/docs/battles');
    assert.strictEqual(b.filters.length, 2);
    assert.strictEqual(b.filters[0].description, 'Battle files');
    assert.strictEqual(b.filters[0].extension, '*.txt');
    assert.strictEqual(b.filters[1].description, 'All files');
    assert.strictEqual(b.filters[1].extension, '*.*');
    s.fs.fire(b.file, 'select', { target: s.fs.file('C:/docs/battles/w1.txt') });
    assert.deepStrictEqual(plain(picked), ['C:/docs/battles/w1.txt']);
    assert.strictEqual(b.file.listenerCount('select'), 0);
    assert.strictEqual(b.file.listenerCount('cancel'), 0);
});

t.test('browse without filters offers one all-files filter', function () {
    var s = setup();
    s.files.browse({}, function () {});
    var b = s.fs.browses[0];
    assert.strictEqual(b.filters.length, 1);
    assert.strictEqual(b.filters[0].description, 'All files');
    assert.strictEqual(b.filters[0].extension, '*.*');
});

t.test('browse skips malformed filter entries', function () {
    var s = setup();
    s.files.browse({
        filters: [null, { label: 'No pattern' }, { pattern: '*.x' }, { label: 'Text', pattern: '*.txt' }, 7]
    }, function () {});
    var b = s.fs.browses[0];
    assert.strictEqual(b.filters.length, 1);
    assert.strictEqual(b.filters[0].description, 'Text');
    assert.strictEqual(b.filters[0].extension, '*.txt');

    var s2 = setup();
    s2.files.browse({ filters: [{ label: 1, pattern: 2 }] }, function () {});
    assert.strictEqual(s2.fs.browses[0].filters.length, 1);
    assert.strictEqual(s2.fs.browses[0].filters[0].extension, '*.*');
});

t.test('browse multiple fires onPick with paths in order', function () {
    var s = setup();
    var picked = null;
    s.files.browse({ multiple: true, startDir: 'C:/nowhere' }, function (p) { picked = p; });
    var b = s.fs.browses[0];
    assert.strictEqual(b.multiple, true);
    assert.strictEqual(b.file.nativePath, 'C:/docs');
    s.fs.fire(b.file, 'selectMultiple', {
        files: [s.fs.file('C:/docs/b.txt'), s.fs.file('C:/docs/a.txt'), s.fs.file('C:/docs/b.txt')]
    });
    assert.deepStrictEqual(plain(picked), ['C:/docs/b.txt', 'C:/docs/a.txt', 'C:/docs/b.txt']);
    assert.strictEqual(b.file.listenerCount('selectMultiple'), 0);
    assert.strictEqual(b.file.listenerCount('cancel'), 0);
});

t.test('browse cancel calls nothing and removes listeners', function () {
    var s = setup();
    var calls = 0;
    s.files.browse({}, function () { calls++; });
    var b = s.fs.browses[0];
    s.fs.fire(b.file, 'cancel', {});
    assert.strictEqual(calls, 0);
    assert.strictEqual(b.file.listenerCount('select'), 0);
    assert.strictEqual(b.file.listenerCount('cancel'), 0);
});

t.test('browse without air.File returns false', function () {
    var H = harness.boot({ sections: ['kernel'], host: { air: { Introspector: { Console: {} } } } });
    assert.strictEqual(H.Steward.kernel.files.browse({}, function () {}), false);
});

// ---- battleTemplateDir ------------------------------------------------------

// Host settings with the real host semantics: read(key, ns), namespace
// defaulting to 'global', null for a missing or empty value.
function hostSettings(global) {
    var store = { global: global || {} };
    return {
        read: function (key, ns) {
            ns = ns || 'global';
            if (!store[ns] || (key && !store[ns][key])) return null;
            return key ? store[ns][key] : store[ns];
        }
    };
}

function templateDir(global, mainSettings) {
    var s = setup({}, { settings: hostSettings(global), mainSettings: mainSettings });
    return s.S.kernel.host.battleTemplateDir();
}

t.test('battleTemplateDir uses battlelastDir', function () {
    assert.strictEqual(templateDir({ battlelastDir: 'C:/docs/Gen' }, { shortcutsDir: 'C:/sc/' }), 'C:/docs/Gen');
});

t.test('battleTemplateDir makes a relative lastDir absolute with shortcutsDir', function () {
    assert.strictEqual(
        templateDir({ battlelastDir: 'Gen/ToK' }, { shortAsGlobalRelative: true, shortcutsDir: 'C:/sc/' }),
        'C:/sc/Gen/ToK');
});

t.test('battleTemplateDir falls back to shortcutsDir', function () {
    assert.strictEqual(templateDir({}, { shortcutsDir: 'C:/sc' }), 'C:/sc');
});

t.test('battleTemplateDir is null when nothing is set', function () {
    assert.strictEqual(templateDir({}, { shortcutsDir: '' }), null);
    assert.strictEqual(templateDir({}, {}), null);
});
