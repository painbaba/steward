'use strict';

var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');
var A = require('../stubs/army');

var assert = t.assert;

var DIR = 'C:/client/steward/adventures/templates';

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function setup(armyOpts) {
    var fs = airfs.make();
    var H = harness.boot({ host: { air: fs.air } });
    if (armyOpts) A.install(H, armyOpts);
    var S = H.Steward;
    return {
        fs: fs,
        H: H,
        S: S,
        tpl: S.modules.adventures.templates,
        dry: S.modules.adventures.dryrun
    };
}

function record(over) {
    var r = {
        label: 'Black Knights',
        adventure: 'BlackKnights',
        loadout: 'C:/battles/loadout.json',
        waves: ['C:/battles/w1.json', 'C:/battles/w2.json'],
        speedBuff: 'SpeedBuffDefault'
    };
    for (var k in over) r[k] = over[k];
    return r;
}

function codes(problems) {
    return plain(problems.map(function (p) { return p.code; }));
}

function tmpFiles(fs) {
    return Object.keys(fs.disk).filter(function (k) { return /\.tmp$/.test(k); });
}

// A battle file with one attack line per entry of `armies` (key -> army).
function battleText(armies) {
    var obj = {};
    var order = 1;
    for (var key in armies) {
        obj[key] = {
            name: 'General ' + key, grid: 5, target: 77, targetName: 'Camp',
            army: armies[key], time: 5000, order: order++
        };
    }
    return JSON.stringify(obj);
}

var UNITS = A.unitCatalogue(['EliteRifle'], ['Rifle', 'Sabre']);

// ---- module ---------------------------------------------------------------

t.test('adventures registers with a one-item Adventures menu and no ui', function () {
    var s = setup();
    var mod = s.H.module('adventures');
    assert.ok(mod, 'registered');
    assert.strictEqual(mod.ui, null);
    assert.strictEqual(mod.menu.title, 'Adventures');
    assert.strictEqual(mod.menu.items.length, 1);
});

t.test('boot seeds defaults once and does not overwrite later values', function () {
    var s = setup();
    assert.strictEqual(s.H.settings.read('adventures'), null);
    s.H.module('adventures').boot();
    var seeded = s.H.settings.read('adventures');
    assert.strictEqual(seeded.defaultSpeedBuff, 'GeneralSpeedBuff_Bronze');
    assert.strictEqual(seeded.lastDir, '');
    s.tpl.setLastDir('C:/battles');
    s.H.module('adventures').boot();
    assert.strictEqual(s.H.settings.read('adventures').lastDir, 'C:/battles');
});

t.test('setDefaultSpeedBuff keeps lastDir and setLastDir keeps the default', function () {
    var s = setup({ buffs: [], buffDefs: { GeneralSpeedBuff_A: {} } });
    s.H.module('adventures').boot();
    assert.strictEqual(s.tpl.setDefaultSpeedBuff('GeneralSpeedBuff_A'), true);
    s.tpl.setLastDir('C:/x');
    assert.strictEqual(s.tpl.defaultSpeedBuff(), 'GeneralSpeedBuff_A');
    assert.strictEqual(s.tpl.lastDir(), 'C:/x');
    assert.strictEqual(s.tpl.setDefaultSpeedBuff('SpeedBuffNone'), true);
    assert.strictEqual(s.tpl.lastDir(), 'C:/x');
    assert.strictEqual(s.tpl.setDefaultSpeedBuff('Nonsense'), false);
    assert.strictEqual(s.tpl.defaultSpeedBuff(), 'SpeedBuffNone');
});

// ---- validate -----------------------------------------------------------------

t.test('validate: missing label, adventure and loadout are reported by field', function () {
    var s = setup();
    var fields = s.tpl.validate(s.tpl.normalize(record({ label: ' ', adventure: '', loadout: '' })))
        .map(function (p) { return p.field; });
    assert.deepStrictEqual(plain(fields), ['label', 'adventure', 'loadout']);
});

t.test('validate: no waves and a bad horseshoe are reported; duplicate waves are fine', function () {
    var s = setup();
    var none = s.tpl.validate(s.tpl.normalize(record({ waves: [] })));
    assert.deepStrictEqual(plain(none.map(function (p) { return p.field; })), ['waves']);
    var bad = s.tpl.validate(s.tpl.normalize(record({ speedBuff: 'Horse' })));
    assert.deepStrictEqual(plain(bad.map(function (p) { return p.field; })), ['speedBuff']);
    var dup = s.tpl.validate(s.tpl.normalize(record({ waves: ['a.json', 'a.json'] })));
    assert.strictEqual(dup.length, 0);
});

// ---- store --------------------------------------------------------------------

t.test('save writes <id>.json with version 1, no id, ordered waves and no .tmp', function () {
    var s = setup();
    var r = s.tpl.save(record({ waves: ['b.json', 'a.json', 'b.json'] }), 1000);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.id, 't1000');
    var text = s.fs.disk[DIR + '/t1000.json'];
    assert.ok(text, 'file written');
    var data = JSON.parse(text);
    assert.strictEqual(data.version, 1);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(data, 'id'), false);
    assert.deepStrictEqual(data.waves, ['b.json', 'a.json', 'b.json']);
    assert.strictEqual(data.saved, 1000);
    assert.strictEqual(tmpFiles(s.fs).length, 0);
});

t.test('save of a record without an id appends -2 when the id is taken', function () {
    var s = setup();
    assert.strictEqual(s.tpl.save(record({}), 1000).id, 't1000');
    assert.strictEqual(s.tpl.save(record({}), 1000).id, 't1000-2');
    assert.ok(s.fs.disk[DIR + '/t1000-2.json']);
});

t.test('re-saving with fewer waves leaves the shorter list in the file', function () {
    var s = setup();
    var id = s.tpl.save(record({}), 1000).id;
    var rec = s.tpl.get(id);
    assert.deepStrictEqual(plain(rec.waves), ['C:/battles/w1.json', 'C:/battles/w2.json']);
    rec.waves = ['C:/battles/w1.json'];
    var again = s.tpl.save(rec, 2000);
    assert.strictEqual(again.id, id);
    assert.deepStrictEqual(JSON.parse(s.fs.disk[DIR + '/' + id + '.json']).waves, ['C:/battles/w1.json']);
    assert.strictEqual(tmpFiles(s.fs).length, 0);
});

t.test('save of an invalid record returns the problems and writes nothing', function () {
    var s = setup();
    var r = s.tpl.save(record({ label: '' }), 1000);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.problems[0].field, 'label');
    assert.deepStrictEqual(Object.keys(s.fs.disk).filter(function (k) { return k.indexOf(DIR) === 0; }), []);
});

t.test('list: sorted by label, id from the file name, hand-dropped files accepted', function () {
    var s = setup();
    s.tpl.save(record({ label: 'beta' }), 1000);
    s.tpl.save(record({ label: 'Alpha' }), 2000);
    // Stored id must be ignored; the file name wins.
    s.fs.disk[DIR + '/black_knights.json'] = JSON.stringify({
        id: 'other', label: 'Charlie', adventure: 'X', loadout: 'l.json', waves: ['w.json', 5]
    });
    s.fs.disk[DIR + '/notes.txt'] = 'hello';
    s.fs.disk[DIR + '/bad name!.json'] = '{}';
    s.fs.disk[DIR + '/broken.json'] = '{ nope';
    var list = s.tpl.list();
    assert.deepStrictEqual(plain(list.map(function (r) { return r.id; })),
        ['t2000', 't1000', 'black_knights', 'broken']);
    assert.deepStrictEqual(plain(list[2].waves), ['w.json']);
    assert.strictEqual(list[2].speedBuff, 'SpeedBuffDefault');
    assert.ok(list[3].error !== undefined, 'broken entry carries an error');
    assert.strictEqual(s.tpl.get('broken'), null);
    assert.strictEqual(s.tpl.get('other'), null);
});

t.test('remove deletes the file; an invalid id returns false', function () {
    var s = setup();
    var id = s.tpl.save(record({}), 1000).id;
    assert.strictEqual(s.tpl.remove('bad id!'), false);
    assert.strictEqual(s.tpl.remove(id), true);
    assert.strictEqual(s.fs.disk[DIR + '/' + id + '.json'], undefined);
    assert.strictEqual(s.tpl.list().length, 0);
});

t.test('a write fault on save reports a file problem and keeps the old content', function () {
    var s = setup();
    var id = s.tpl.save(record({}), 1000).id;
    var path = DIR + '/' + id + '.json';
    var before = s.fs.disk[path];
    s.fs.fail.move[path] = true;
    var rec = s.tpl.get(id);
    rec.label = 'Changed';
    var r = s.tpl.save(rec, 2000);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.problems[0].field, 'file');
    assert.strictEqual(s.fs.disk[path], before);
});

// ---- horseshoe ------------------------------------------------------------------

t.test('resolveSpeedBuff: Default follows the setting, None and explicit are direct', function () {
    var s = setup();
    var r = s.tpl.resolveSpeedBuff;
    assert.strictEqual(r({ speedBuff: 'SpeedBuffDefault' }, 'GeneralSpeedBuff_A'), 'GeneralSpeedBuff_A');
    assert.strictEqual(r({ speedBuff: 'SpeedBuffDefault' }, 'SpeedBuffNone'), null);
    assert.strictEqual(r({ speedBuff: 'SpeedBuffNone' }, 'GeneralSpeedBuff_A'), null);
    assert.strictEqual(r({ speedBuff: 'GeneralSpeedBuff_B' }, 'GeneralSpeedBuff_A'), 'GeneralSpeedBuff_B');
});

t.test('speedBuffChoice: empty, missing and non-string fall back to Default; None and a name pass through', function () {
    var s = setup();
    var c = s.tpl.speedBuffChoice;
    assert.strictEqual(c({ speedBuff: '' }), 'SpeedBuffDefault');
    assert.strictEqual(c({}), 'SpeedBuffDefault');
    assert.strictEqual(c(null), 'SpeedBuffDefault');
    assert.strictEqual(c({ speedBuff: 5 }), 'SpeedBuffDefault');
    assert.strictEqual(c({ speedBuff: 'SpeedBuffNone' }), 'SpeedBuffNone');
    assert.strictEqual(c({ speedBuff: 'GeneralSpeedBuff_B' }), 'GeneralSpeedBuff_B');
});

t.test('buffLabel: label when listed, name otherwise', function () {
    var s = setup();
    var buffs = [{ name: 'GeneralSpeedBuff_A', label: 'Bronze horseshoe' }, { name: 'GeneralSpeedBuff_B' }];
    assert.strictEqual(s.tpl.buffLabel(buffs, 'GeneralSpeedBuff_A'), 'Bronze horseshoe');
    assert.strictEqual(s.tpl.buffLabel(buffs, 'GeneralSpeedBuff_B'), 'GeneralSpeedBuff_B');
    assert.strictEqual(s.tpl.buffLabel(buffs, 'GeneralSpeedBuff_Gone'), 'GeneralSpeedBuff_Gone');
});

t.test('speedBuffOptions: Default and None first, zero stock warns, stored unknown appended', function () {
    var s = setup();
    var buffs = [
        { name: 'GeneralSpeedBuff_A', label: 'A', amount: 3, effect: '' },
        { name: 'GeneralSpeedBuff_B', label: 'B', amount: 0, effect: '' }
    ];
    var opts = s.tpl.speedBuffOptions(buffs, 'GeneralSpeedBuff_A', 'GeneralSpeedBuff_Gone');
    assert.deepStrictEqual(plain(opts.map(function (o) { return o.value; })),
        ['SpeedBuffDefault', 'SpeedBuffNone', 'GeneralSpeedBuff_A', 'GeneralSpeedBuff_B', 'GeneralSpeedBuff_Gone']);
    assert.strictEqual(opts[0].label, 'Default (A)');
    assert.strictEqual(opts[2].warn, false);
    assert.strictEqual(opts[3].warn, true);
    assert.strictEqual(opts[4].warn, true);
    // A stored name that is listed, or a choice token, adds nothing.
    assert.strictEqual(s.tpl.speedBuffOptions(buffs, 'SpeedBuffNone', 'GeneralSpeedBuff_B').length, 4);
    assert.strictEqual(s.tpl.speedBuffOptions(buffs, 'SpeedBuffNone', 'SpeedBuffDefault').length, 4);
    // The default row has no Default entry and keeps an unlisted current value.
    var d = s.tpl.defaultOptions(buffs, 'GeneralSpeedBuff_Gone');
    assert.deepStrictEqual(plain(d.map(function (o) { return o.value; })),
        ['SpeedBuffNone', 'GeneralSpeedBuff_A', 'GeneralSpeedBuff_B', 'GeneralSpeedBuff_Gone']);
});

// ---- dry run, assemble with fake deps ------------------------------------------

function fakeDeps(files, over) {
    var deps = {
        load: function (path) {
            if (!Object.prototype.hasOwnProperty.call(files, path)) {
                return { ok: false, path: path, lines: [], problems: [{
                    code: 'FileNotFound', fatal: true, key: null, message: 'file not found: ' + path
                }] };
            }
            return files[path];
        },
        ctx: {
            fighters: {
                'g1.0': { name: 'Hans', cls: 0, capacity: 0, army: { Rifle: 5 } },
                'g2.0': { name: 'Franz', cls: 0, capacity: 0, army: {} }
            },
            isElite: function () { return false; },
            classOf: function () { return 'Base'; },
            total: function (a) {
                var n = 0;
                for (var k in a) n += a[k];
                return n;
            },
            camp: function () { return { enemy: true }; }
        },
        inv: {
            free: { Rifle: 10 },
            byKey: {
                'g1.0': { key: 'g1.0', name: 'Hans', army: { Rifle: 5 }, donorOk: false },
                'g2.0': { key: 'g2.0', name: 'Franz', army: {}, donorOk: false }
            }
        },
        buffAmount: function () { return 0; },
        defaultSpeedBuff: 'GeneralSpeedBuff_A',
        zoneAdventure: 'BlackKnights',
        onTemplateMap: true
    };
    for (var k in over) deps[k] = over[k];
    return deps;
}

function line(key, kind, army, name) {
    return { key: key, kind: kind, name: name || key, grid: 5, target: 77, targetName: 'Camp',
        army: army, timeMs: 5000 };
}

function parsed(lines) {
    return { ok: true, lines: lines, problems: [] };
}

t.test('assemble: loadout then waves in order, duplicates evaluated twice, NotInLoadout, totals', function () {
    var s = setup();
    var L = s.S.BattleLine;
    var files = {
        'lo.json': parsed([line('g1.0', L.Star, {})]),
        'w1.json': parsed([line('g1.0', L.Attack, { Rifle: 5 })]),
        'w2.json': parsed([line('g2.0', L.Attack, { Rifle: 3 })])
    };
    var tpl = { label: 'T', adventure: 'BlackKnights', loadout: 'lo.json',
        waves: ['w1.json', 'w2.json', 'w1.json'], speedBuff: 'SpeedBuffDefault' };
    var d = s.dry.assemble(tpl, fakeDeps(files));
    assert.deepStrictEqual(plain(d.files.map(function (f) { return f.role + ':' + f.index; })),
        ['loadout:null', 'wave:1', 'wave:2', 'wave:3']);
    assert.strictEqual(d.files[1].path, 'w1.json');
    assert.strictEqual(d.files[3].path, 'w1.json');
    assert.deepStrictEqual(codes(d.files[1].problems), []);
    assert.deepStrictEqual(codes(d.files[2].problems), ['ProblemNotInLoadout']);
    assert.strictEqual(d.fatal, 1);
    assert.strictEqual(d.warn, 0);
    assert.strictEqual(d.files[1].lines[0].matches, true);
    assert.strictEqual(d.files[2].lines[0].matches, false);
    // Supply is planned per wave file against the same island.
    assert.ok(d.files[1].supply, 'supply attached');
    assert.ok(d.files[2].supply, 'supply attached');
});

t.test('assemble: a fatal and a warning from validation are counted separately', function () {
    var s = setup();
    var L = s.S.BattleLine;
    var files = {
        'lo.json': parsed([line('g1.0', L.Star, {}), line('g2.0', L.Star, {})]),
        'w1.json': parsed([line('g9.0', L.Attack, { Rifle: 1 }), line('sb', L.SpeedBuff, {})])
    };
    var tpl = { label: 'T', adventure: 'BlackKnights', loadout: 'lo.json', waves: ['w1.json'],
        speedBuff: 'SpeedBuffDefault' };
    var d = s.dry.assemble(tpl, fakeDeps(files));
    // g9.0: NotInLoadout (fatal) and MissingGeneral (fatal); speed buff line: a warning.
    assert.strictEqual(d.fatal, 2);
    assert.strictEqual(d.warn, 1);
});

t.test('assemble: speed buff note at zero stock, in stock and for none', function () {
    var s = setup();
    var L = s.S.BattleLine;
    var files = { 'lo.json': parsed([line('g1.0', L.Star, {})]) };
    var tpl = { label: 'T', adventure: 'X', loadout: 'lo.json', waves: [], speedBuff: 'SpeedBuffDefault' };
    var zero = s.dry.assemble(tpl, fakeDeps(files));
    assert.strictEqual(zero.speedBuff.name, 'GeneralSpeedBuff_A');
    assert.ok(zero.speedBuff.note.indexOf('none in stock') === 0);
    var stocked = s.dry.assemble(tpl, fakeDeps(files, { buffAmount: function () { return 4; } }));
    assert.strictEqual(stocked.speedBuff.amount, 4);
    assert.strictEqual(stocked.speedBuff.note, '');
    var none = s.dry.assemble({ label: 'T', adventure: 'X', loadout: 'lo.json', waves: [],
        speedBuff: 'SpeedBuffNone' }, fakeDeps(files));
    assert.strictEqual(none.speedBuff.name, null);
    assert.strictEqual(none.speedBuff.note, 'no horseshoe');
});

t.test('assemble: camp checks are skipped when ctx.camp is null', function () {
    var s = setup();
    var L = s.S.BattleLine;
    var files = {
        'lo.json': parsed([line('g1.0', L.Star, {})]),
        'w1.json': parsed([line('g1.0', L.Attack, { Rifle: 5 })])
    };
    var tpl = { label: 'T', adventure: 'X', loadout: 'lo.json', waves: ['w1.json'], speedBuff: 'SpeedBuffNone' };
    var gone = fakeDeps(files);
    gone.ctx.camp = function () { return null; };
    assert.deepStrictEqual(codes(s.dry.assemble(tpl, gone).files[1].problems), ['ProblemTargetMissing']);
    var skipped = fakeDeps(files, { onTemplateMap: false });
    skipped.ctx.camp = null;
    var d = s.dry.assemble(tpl, skipped);
    assert.deepStrictEqual(codes(d.files[1].problems), []);
    assert.strictEqual(d.onTemplateMap, false);
});

t.test('assemble: a missing file is reported as NotFound and has no supply', function () {
    var s = setup();
    var tpl = { label: 'T', adventure: 'X', loadout: 'gone.json', waves: ['gone2.json'], speedBuff: 'SpeedBuffNone' };
    var d = s.dry.assemble(tpl, fakeDeps({}));
    assert.strictEqual(d.files[0].ok, false);
    assert.strictEqual(d.files[0].supply, null);
    assert.strictEqual(d.files[1].ok, false);
    assert.strictEqual(d.fatal, 2);
});

t.test('assemble: supply donors carry the inventory name', function () {
    var s = setup();
    var L = s.S.BattleLine;
    var files = {
        'lo.json': parsed([line('g1.0', L.Star, {})]),
        'w1.json': parsed([line('g1.0', L.Attack, { Rifle: 5 })])
    };
    var tpl = { label: 'T', adventure: 'X', loadout: 'lo.json', waves: ['w1.json'], speedBuff: 'SpeedBuffNone' };
    var deps = fakeDeps(files, {
        inv: {
            free: { Rifle: 2 },
            byKey: {
                'g1.0': { key: 'g1.0', name: 'Hans', army: {}, donorOk: false },
                'g9.0': { key: 'g9.0', name: 'Idle Ida', army: { Rifle: 4 }, donorOk: true }
            }
        }
    });
    var d = s.dry.assemble(tpl, deps);
    var donors = d.files[1].supply.donors;
    assert.strictEqual(donors.length, 1);
    assert.strictEqual(donors[0].key, 'g9.0');
    assert.strictEqual(donors[0].name, 'Idle Ida');
});

// ---- report -----------------------------------------------------------------------

t.test('report on a broken entry returns { broken } without assembling', function () {
    var s = setup();
    var entry = { id: 'x', path: 'p', error: 'not valid JSON' };
    var r = s.dry.report(entry);
    assert.strictEqual(r.broken, entry);
    assert.strictEqual(r.files, undefined);
});

t.test('report on a saved template reads the wave files from disk and enqueues nothing', function () {
    var s = setup({
        units: UNITS,
        free: { Rifle: 10 },
        fighters: [
            A.fighter({ uid: '1.0', name: 'Hans', army: { Rifle: 5 } }),
            A.fighter({ uid: '2.0', name: 'Franz', army: {} })
        ],
        buffs: [{ type: 'GeneralSpeedBuff_A', amount: 2 }],
        buffDefs: { GeneralSpeedBuff_A: {} }
    });
    s.fs.disk['C:/battles/loadout.json'] = battleText({ '1.0': {}, '2.0': {} });
    s.fs.disk['C:/battles/w1.json'] = battleText({ '1.0': { Rifle: 5 } });
    s.fs.disk['C:/battles/w2.json'] = battleText({ '2.0': { Rifle: 4 } });
    var saved = s.tpl.save(record({ speedBuff: 'GeneralSpeedBuff_A' }), 1000);
    assert.strictEqual(saved.ok, true);
    s.H.clearQueued();

    var data = s.dry.report(s.tpl.get(saved.id));
    assert.strictEqual(data.files.length, 3);
    assert.strictEqual(data.files[1].ok, true);
    assert.strictEqual(data.files[1].lines[0].matches, true);
    assert.strictEqual(data.files[2].lines[0].matches, false);
    assert.strictEqual(data.speedBuff.name, 'GeneralSpeedBuff_A');
    assert.strictEqual(data.speedBuff.amount, 2);
    assert.strictEqual(data.onTemplateMap, false);
    assert.strictEqual(s.H.queued().length, 0);
});

t.test('liveDeps without a template has no camp check and is not on the template map', function () {
    var s = setup({ units: UNITS, fighters: [] });
    var d = s.dry.liveDeps();
    assert.strictEqual(d.onTemplateMap, false);
    assert.strictEqual(d.ctx.camp, null);
});
