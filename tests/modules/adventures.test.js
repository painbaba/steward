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
        tpl: S.modules.adventures.templates
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

function tmpFiles(fs) {
    return Object.keys(fs.disk).filter(function (k) { return /\.tmp$/.test(k); });
}

// ---- module ---------------------------------------------------------------

function labelOf(item, pass) {
    if (item.separator) return '---';
    return typeof item.label === 'function' ? item.label(pass || {}) : item.label;
}

function menuLabels(s) {
    var pass = {};
    return plain(s.H.module('adventures').menu.items().map(function (it) { return labelOf(it, pass); }));
}

t.test('adventures registers with a function menu and a misc settings section', function () {
    var s = setup();
    var mod = s.H.module('adventures');
    assert.ok(mod, 'registered');
    assert.strictEqual(mod.ui.tab, 'misc');
    assert.strictEqual(mod.ui.section.id, 'adventures');
    assert.strictEqual(mod.menu.title, 'Adventures');
    assert.strictEqual(typeof mod.menu.items, 'function');
});

t.test('menu without templates lists the fixed rows and a placeholder', function () {
    var s = setup({ buffs: [] });
    assert.deepStrictEqual(menuLabels(s), ['Run templates…', '---', 'No run requested', 'Pause run',
        'Resume run', 'End repetition', 'Stop run', '---', 'No templates yet']);
    var items = s.H.module('adventures').menu.items();
    assert.strictEqual(items[2].enabled, false);
    assert.strictEqual(items[8].enabled, false);
});

t.test('menu lists templates in label order with their map counts', function () {
    var s = setup({ buffs: [
        { type: 'Adventure', resource: 'BlackKnights', amount: 2 },
        { type: 'Adventure', resource: 'BlackKnights', amount: 1, uid: 'b' }
    ] });
    s.tpl.save(record({}), 1000);
    s.tpl.save(record({ label: 'Alpha', adventure: 'Other' }), 2000);
    var labels = menuLabels(s);
    assert.deepStrictEqual(labels.slice(8), ['Alpha ×0', 'Black Knights ×3']);
});

t.test('boot seeds lastDir only and ignores an old stored default horseshoe', function () {
    var s = setup();
    assert.strictEqual(s.H.settings.read('adventures'), null);
    s.H.module('adventures').boot();
    var seeded = s.H.settings.read('adventures');
    assert.strictEqual(seeded.lastDir, '');
    assert.strictEqual(seeded.defaultSpeedBuff, undefined);
    s.tpl.setLastDir('C:/battles');
    s.H.module('adventures').boot();
    assert.strictEqual(s.H.settings.read('adventures').lastDir, 'C:/battles');
    s.H.settings.write('adventures', { lastDir: 'C:/y', defaultSpeedBuff: 'GeneralSpeedBuff_A' });
    assert.deepStrictEqual(plain(s.tpl.settings()), { lastDir: 'C:/y', stuckMinutes: 45, retrain: false, retrainSettlersOnly: false });
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

var STOCK = [
    { name: 'GeneralSpeedBuff_A', label: 'A', amount: 0, effect: '' },
    { name: 'GeneralSpeedBuff_B', label: 'B', amount: 3, effect: '' },
    { name: 'GeneralSpeedBuff_C', label: 'C', amount: 5, effect: '' }
];

t.test('firstAvailable skips zero stock and returns null when none', function () {
    var s = setup();
    assert.strictEqual(s.tpl.firstAvailable(STOCK), 'GeneralSpeedBuff_B');
    assert.strictEqual(s.tpl.firstAvailable([STOCK[0]]), null);
    assert.strictEqual(s.tpl.firstAvailable([]), null);
});

t.test('initialSpeedBuff: Default takes the first in stock, else None; explicit choices are kept', function () {
    var s = setup();
    var f = s.tpl.initialSpeedBuff;
    assert.strictEqual(f({ speedBuff: 'SpeedBuffDefault' }, STOCK), 'GeneralSpeedBuff_B');
    assert.strictEqual(f({ speedBuff: 'SpeedBuffDefault' }, [STOCK[0]]), 'SpeedBuffNone');
    assert.strictEqual(f({ speedBuff: 'GeneralSpeedBuff_C' }, STOCK), 'GeneralSpeedBuff_C');
    assert.strictEqual(f({ speedBuff: 'SpeedBuffNone' }, STOCK), 'SpeedBuffNone');
});

t.test('resolveSpeedBuff: Default is the first in stock, None is null, explicit is kept', function () {
    var s = setup();
    var r = s.tpl.resolveSpeedBuff;
    assert.strictEqual(r({ speedBuff: 'SpeedBuffDefault' }, STOCK), 'GeneralSpeedBuff_B');
    assert.strictEqual(r({ speedBuff: 'SpeedBuffDefault' }, [STOCK[0]]), null);
    assert.strictEqual(r({ speedBuff: 'SpeedBuffNone' }, STOCK), null);
    assert.strictEqual(r({ speedBuff: 'GeneralSpeedBuff_A' }, STOCK), 'GeneralSpeedBuff_A');
});

t.test('autoLabel fills an empty or auto-filled label and keeps typed text', function () {
    var s = setup();
    var f = s.tpl.autoLabel;
    assert.strictEqual(f('', 'Old', 'New'), 'New');
    assert.strictEqual(f('Old', 'Old', 'New'), 'New');
    assert.strictEqual(f('My run', 'Old', 'New'), null);
    assert.strictEqual(f('   ', 'Old', 'New'), 'New');
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

t.test('speedBuffOptions: no None and no Default, zero stock warns, stored unknown kept', function () {
    var s = setup();
    var opts = s.tpl.speedBuffOptions(STOCK, 'GeneralSpeedBuff_Gone');
    assert.deepStrictEqual(plain(opts.map(function (o) { return o.value; })),
        ['GeneralSpeedBuff_A', 'GeneralSpeedBuff_B', 'GeneralSpeedBuff_C', 'GeneralSpeedBuff_Gone']);
    assert.strictEqual(opts.length, 4);
    assert.strictEqual(opts[0].warn, true);
    assert.strictEqual(opts[1].warn, false);
    assert.strictEqual(opts[3].warn, true);
    assert.strictEqual(s.tpl.speedBuffOptions(STOCK, 'SpeedBuffNone').length, 3);
    assert.strictEqual(s.tpl.speedBuffOptions(STOCK, 'GeneralSpeedBuff_B').length, 3);
});

t.test('enabledSpeedBuff: last, first in stock, first listed, None', function () {
    var s = setup();
    var f = s.tpl.enabledSpeedBuff;
    assert.strictEqual(f('GeneralSpeedBuff_C', STOCK), 'GeneralSpeedBuff_C', 'the last choice wins');
    assert.strictEqual(f('GeneralSpeedBuff_Gone', STOCK), 'GeneralSpeedBuff_Gone', 'even one out of stock');
    assert.strictEqual(f(null, STOCK), 'GeneralSpeedBuff_B', 'first in stock');
    assert.strictEqual(f('SpeedBuffNone', STOCK), 'GeneralSpeedBuff_B', 'None is not a choice to restore');
    assert.strictEqual(f('', STOCK), 'GeneralSpeedBuff_B');
    assert.strictEqual(f(null, [STOCK[0]]), 'GeneralSpeedBuff_A', 'first listed when none is in stock');
    assert.strictEqual(f(null, []), 'SpeedBuffNone');
    assert.strictEqual(f(null, undefined), 'SpeedBuffNone');
});

t.test('fileName both separators', function () {
    var s = setup();
    assert.strictEqual(s.tpl.fileName('C:\\b\\w1.txt'), 'w1.txt');
    assert.strictEqual(s.tpl.fileName('C:/b/w1.txt'), 'w1.txt');
    assert.strictEqual(s.tpl.fileName('C:/b\\w2.txt'), 'w2.txt');
    assert.strictEqual(s.tpl.fileName('w3.txt'), 'w3.txt');
    assert.strictEqual(s.tpl.fileName(null), '');
});

t.test('toFile writes no retrain key; an old file with retrain false loads, normalize has no retrain field', function () {
    var s = setup();
    var saved = s.tpl.save(record({ retrain: false }), 1000);
    assert.ok(!Object.prototype.hasOwnProperty.call(JSON.parse(s.fs.disk[DIR + '/t1000.json']), 'retrain'));
    assert.ok(!Object.prototype.hasOwnProperty.call(s.tpl.get(saved.id), 'retrain'));
    s.fs.disk[DIR + '/old.json'] = JSON.stringify({
        version: 1, label: 'Old', adventure: 'BlackKnights', loadout: 'l.json', waves: ['w.json'],
        speedBuff: 'SpeedBuffDefault', retrain: false
    });
    var old = s.tpl.get('old');
    assert.strictEqual(old.label, 'Old');
    assert.ok(!Object.prototype.hasOwnProperty.call(old, 'retrain'));
    assert.ok(!Object.prototype.hasOwnProperty.call(s.tpl.normalize({ label: 'x', retrain: false }), 'retrain'));
});

// ---- wave order ---------------------------------------------------------------------

t.test('reorderWaves moves a wave and keeps duplicates', function () {
    var s = setup();
    var waves = ['a', 'b', 'a'];
    var next = s.tpl.reorderWaves(waves, [2, 0, 1]);
    assert.deepStrictEqual(plain(next), ['a', 'a', 'b']);
    assert.deepStrictEqual(plain(waves), ['a', 'b', 'a']);
    assert.notStrictEqual(next, waves);
    assert.deepStrictEqual(plain(s.tpl.reorderWaves(['x', 'y'], [1, 0])), ['y', 'x']);
    assert.deepStrictEqual(plain(s.tpl.reorderWaves([], [])), []);
});

t.test('reorderWaves rejects a wrong length, a repeat, an out-of-range or non-integer index', function () {
    var s = setup();
    var waves = ['a', 'b', 'c'];
    assert.strictEqual(s.tpl.reorderWaves(waves, [0, 1]), null);
    assert.strictEqual(s.tpl.reorderWaves(waves, [0, 1, 2, 0]), null);
    assert.strictEqual(s.tpl.reorderWaves(waves, [0, 0, 1]), null);
    assert.strictEqual(s.tpl.reorderWaves(waves, [0, 1, 3]), null);
    assert.strictEqual(s.tpl.reorderWaves(waves, [0, 1, -1]), null);
    assert.strictEqual(s.tpl.reorderWaves(waves, [0, 1.5, 2]), null);
    assert.strictEqual(s.tpl.reorderWaves(waves, [0, NaN, 2]), null);
    assert.strictEqual(s.tpl.reorderWaves(waves, [0, '1', 2]), null);
    assert.strictEqual(s.tpl.reorderWaves(waves, null), null);
    assert.deepStrictEqual(plain(waves), ['a', 'b', 'c']);
});

// ---- run request ------------------------------------------------------------------

// A booted setup with a saved Black Knights template and `maps` maps in stock.
// prompt/confirm are host globals the harness does not provide, so each test
// installs its own and the alerts are captured through showGameAlert.
function runSetup(maps, extra) {
    var alerts = [];
    var fs = airfs.make();
    var H = harness.boot({ host: { air: fs.air, showGameAlert: function (m) { alerts.push(m); } } });
    var buffs = maps > 0 ? [{ type: 'Adventure', resource: 'BlackKnights', amount: maps }] : [];
    A.install(H, { buffs: buffs });
    var S = H.Steward;
    var id = S.modules.adventures.templates.save(record({}), 1000).id;
    var prompts = [];
    var s = { fs: fs, H: H, S: S, id: id, alerts: alerts, prompts: prompts, confirms: [], run: S.modules.adventures.run };
    H.ctx.prompt = function (text, def) {
        prompts.push({ text: text, def: def });
        return s.answer === undefined ? def : s.answer;
    };
    H.ctx.confirm = function (text) { s.confirms.push(text); return s.agree === true; };
    if (extra && extra.open) {
        var prev = H.host.game.def;
        H.host.game.def = function (name) {
            if (name === 'com.bluebyte.tso.adventure.logic::AdventureManager') {
                return { getInstance: function () { return {
                    getAdventures: function () { return [{ adventureName: 'BlackKnights' }]; },
                    isMyAdventure: function () { return true; }
                }; } };
            }
            return prev(name);
        };
    }
    // The executor's file check needs battle files on disk; the tests stand in
    // for it (opts.realCheck keeps the real one). `checks` records the options
    // each call got, `problems` makes the stand-in report fatal problems.
    s.checks = [];
    s.problems = [];
    if (!(extra && extra.realCheck)) {
        S.modules.adventures.executor.check = function (rec, opts) {
            s.checks.push(opts);
            return {
                ok: s.problems.length === 0,
                problems: s.problems,
                warnings: [],
                loadoutKeys: { a: 1 }
            };
        };
    }
    H.clearQueued();
    return s;
}

t.test('countFrom: cancel, invalid, clamp and trimmed numbers', function () {
    var s = setup();
    var f = s.S.modules.adventures.run.countFrom;
    assert.deepStrictEqual(plain(f(null, 5)), { ok: false, reason: 'cancel' });
    assert.deepStrictEqual(plain(f('x', 5)), { ok: false, reason: 'invalid' });
    assert.deepStrictEqual(plain(f('0', 5)), { ok: false, reason: 'invalid' });
    assert.deepStrictEqual(plain(f('9', 5)), { ok: true, count: 5 });
    assert.deepStrictEqual(plain(f(' 3 ', 5)), { ok: true, count: 3 });
});

t.test('statusText: no request, a request and an ended one', function () {
    var s = setup();
    var f = s.S.modules.adventures.run.statusText;
    assert.strictEqual(f(null), 'No run requested');
    assert.strictEqual(f({ label: 'Witch', count: 5, ended: false }), 'Requested: Witch ×5');
    assert.strictEqual(f({ label: 'Witch', count: 1, ended: true }), 'Requested: Witch ×1, repetition ended');
});

t.test('status: a started run shows its run number out of the count and its step', function () {
    var s = runSetup(3);
    s.answer = '3';
    s.run.start(s.id);
    var st = s.S.modules.adventures.state;
    assert.strictEqual(st.status(), 'Running: Black Knights, run 1/3, ' + st.stepName(s.S.RunStep.Muster));
    s.run.current().finished = 1;
    assert.ok(/^Running: Black Knights, run 2\/3, /.test(st.status()), st.status());
    s.run.pause();
    assert.ok(/^Paused: Black Knights, run 2\/3, .*: paused by you$/.test(st.status()), st.status());
});

t.test('start at home with the map not open stores a Muster run with no zone and queues nothing', function () {
    var s = runSetup(3);
    s.answer = '10';
    assert.strictEqual(s.run.start(s.id), true);
    var run = s.S.modules.adventures.state.run();
    assert.strictEqual(run.step, s.S.RunStep.Muster);
    assert.strictEqual(run.zoneId, null);
    assert.strictEqual(run.speedBuff, 'SpeedBuffDefault');
    assert.strictEqual(run.waveIndex, 0);
    assert.deepStrictEqual(plain(run.paths), ['C:/battles/w1.json', 'C:/battles/w2.json']);
    assert.deepStrictEqual(plain(run.loadoutKeys), { a: 1 });
    var req = s.run.current();
    assert.strictEqual(req.count, 3);
    assert.strictEqual(req.ended, false);
    assert.strictEqual(req.finished, 0);
    assert.strictEqual(req.closedAt, null);
    assert.strictEqual(req.templateId, s.id);
    assert.strictEqual(s.prompts.length, 1);
    assert.strictEqual(s.prompts[0].def, '3');
    assert.deepStrictEqual(plain(s.checks), [{ camps: false, fighters: false }]);
    assert.strictEqual(s.H.queued().length, 0);
});

t.test('start at home stores the template horseshoe choice', function () {
    var s = runSetup(3);
    s.S.modules.adventures.templates.save(record({ label: 'Pinned', speedBuff: 'GeneralSpeedBuff_B' }), 2000);
    s.answer = '1';
    assert.strictEqual(s.run.start('t2000'), true);
    assert.strictEqual(s.S.modules.adventures.state.run().speedBuff, 'GeneralSpeedBuff_B');
});

t.test('start at home with the map open stores the zone and counts one more', function () {
    var s = runSetup(3, { open: true });
    s.S.core.adventures.zoneIdOf = function () { return 7; };
    assert.strictEqual(s.run.start(s.id), true);
    var run = s.S.modules.adventures.state.run();
    assert.strictEqual(run.zoneId, 7);
    assert.strictEqual(run.step, s.S.RunStep.Muster);
    assert.strictEqual(s.prompts[0].def, '4');
    assert.strictEqual(s.run.current().count, 4);
    assert.strictEqual(s.H.queued().length, 0);
});

t.test('start on the open map stores a run at Gate of the chosen wave', function () {
    var s = runSetup(3, { open: true });
    s.S.core.adventures.zoneIdOf = function () { return 7; };
    s.S.core.zone.id = function () { return 7; };
    s.H.host.game.gi.isOnHomzone = function () { return false; };
    s.answer = '2';
    assert.strictEqual(s.run.start(s.id), true);
    var run = s.S.modules.adventures.state.run();
    assert.strictEqual(run.step, s.S.WaveStep.Gate);
    assert.strictEqual(run.zoneId, 7);
    assert.strictEqual(run.waveIndex, 1);
    assert.strictEqual(run.speedBuff, 'SpeedBuffDefault');
    assert.strictEqual(s.prompts.length, 2);
    assert.strictEqual(s.checks.length, 1);
    assert.strictEqual(s.checks[0], undefined);
});

t.test('start elsewhere alerts and stores nothing', function () {
    var s = runSetup(3);
    s.S.core.adventures.zoneIdOf = function () { return 7; };
    s.S.core.zone.id = function () { return 1; };
    s.H.host.game.gi.isOnHomzone = function () { return false; };
    s.answer = '2';
    assert.strictEqual(s.run.start(s.id), false);
    assert.strictEqual(s.run.current(), null);
    assert.strictEqual(s.S.modules.adventures.state.run(), null);
    assert.strictEqual(s.checks.length, 0);
    assert.strictEqual(s.alerts.length, 1);
    assert.ok(/Go home or view the .* island, then choose the template again/.test(s.alerts[0]), s.alerts[0]);
    assert.strictEqual(s.H.queued().length, 0);
});

t.test('a fatal file problem at home stores nothing', function () {
    var s = runSetup(3);
    s.problems = [{ message: 'wave 1: file not found', fatal: true }];
    s.answer = '2';
    assert.strictEqual(s.run.start(s.id), false);
    assert.strictEqual(s.run.current(), null);
    assert.strictEqual(s.S.modules.adventures.state.run(), null);
    assert.strictEqual(s.alerts.length, 1);
    assert.ok(/cannot start: 1 problem/.test(s.alerts[0]), s.alerts[0]);
    assert.ok(/file not found/.test(s.alerts[0]), s.alerts[0]);
});

t.test('the real file check at home stores nothing when the battle files are missing', function () {
    var s = runSetup(3, { realCheck: true });
    s.answer = '2';
    assert.strictEqual(s.run.start(s.id), false);
    assert.strictEqual(s.run.current(), null);
    assert.strictEqual(s.S.modules.adventures.state.run(), null);
    assert.ok(/cannot start/.test(s.alerts[0]), s.alerts[0]);
});

t.test('start with no maps alerts and stores nothing', function () {
    var s = runSetup(0);
    assert.strictEqual(s.run.start(s.id), false);
    assert.strictEqual(s.prompts.length, 0);
    assert.strictEqual(s.run.current(), null);
    assert.strictEqual(s.alerts.length, 1);
    assert.strictEqual(s.H.queued().length, 0);
});

t.test('start of an unreadable template alerts and stores nothing', function () {
    var s = runSetup(2);
    assert.strictEqual(s.run.start('missing'), false);
    assert.strictEqual(s.run.current(), null);
    assert.strictEqual(s.alerts.length, 1);
});

t.test('a cancelled or invalid prompt stores nothing', function () {
    var s = runSetup(3);
    s.answer = null;
    assert.strictEqual(s.run.start(s.id), false);
    assert.strictEqual(s.run.current(), null);
    assert.strictEqual(s.alerts.length, 0);
    s.answer = 'abc';
    assert.strictEqual(s.run.start(s.id), false);
    assert.strictEqual(s.run.current(), null);
    assert.strictEqual(s.alerts.length, 1);
    assert.strictEqual(s.H.queued().length, 0);
});

t.test('replacing a request needs confirm; declined keeps the old one', function () {
    var s = runSetup(5);
    s.answer = '2';
    s.run.start(s.id);
    s.answer = '4';
    s.agree = false;
    assert.strictEqual(s.run.start(s.id), false);
    assert.strictEqual(s.confirms.length, 1);
    assert.strictEqual(s.run.current().count, 2);
    s.agree = true;
    assert.strictEqual(s.run.start(s.id), true);
    assert.strictEqual(s.run.current().count, 4);
    assert.strictEqual(s.H.queued().length, 0);
});

t.test('endRepetition sets count to finished + 1 and ended; nothing to end alerts', function () {
    var s = runSetup(5);
    assert.strictEqual(s.run.endRepetition(), false);
    assert.strictEqual(s.alerts.length, 1);
    s.answer = '4';
    s.run.start(s.id);
    s.alerts.length = 0;
    assert.strictEqual(s.run.endRepetition(), true);
    assert.strictEqual(s.run.current().count, 1);
    assert.strictEqual(s.run.current().ended, true);
    assert.strictEqual(s.alerts.length, 1);
    assert.strictEqual(s.run.endRepetition(), false);
    assert.strictEqual(s.alerts.length, 2);
    assert.strictEqual(s.H.queued().length, 0);
});

t.test('endRepetition after finished runs keeps those and ends after the one in progress', function () {
    var s = runSetup(5);
    s.answer = '5';
    s.run.start(s.id);
    s.run.current().finished = 2;
    assert.strictEqual(s.run.endRepetition(), true);
    assert.strictEqual(s.run.current().count, 3);
    assert.strictEqual(s.run.current().ended, true);
    var saved = JSON.parse(s.fs.disk['C:/client/steward/adventures/run.json']).request;
    assert.strictEqual(saved.count, 3);
    assert.strictEqual(saved.ended, true);
    s.alerts.length = 0;
    assert.strictEqual(s.run.endRepetition(), false);
    assert.strictEqual(s.run.current().count, 3);
    assert.strictEqual(s.alerts.length, 1);
});

t.test('endRepetition follows the state counter rule for malformed counters', function () {
    var s = runSetup(5);
    s.answer = '5';
    s.run.start(s.id);
    s.alerts.length = 0;
    // A non-numeric count reads as one requested run, so there is nothing to end.
    s.run.current().count = 'x';
    s.run.current().finished = 0;
    assert.strictEqual(s.run.endRepetition(), false);
    assert.strictEqual(s.alerts.length, 1);
    // A fractional finished count is floored to 1, so the series ends after two runs.
    s.run.current().count = 3;
    s.run.current().finished = 1.7;
    assert.strictEqual(s.run.endRepetition(), true);
    assert.strictEqual(s.run.current().count, 2);
    assert.strictEqual(s.run.current().ended, true);
});

t.test('stop removes the request and queued module entries; stopping again alerts', function () {
    var s = runSetup(5);
    s.answer = '2';
    s.run.start(s.id);
    s.alerts.length = 0;
    assert.strictEqual(s.run.stop(), true);
    assert.strictEqual(s.run.current(), null);
    assert.strictEqual(s.run.stop(), false);
    assert.strictEqual(s.alerts.length, 2);
    assert.strictEqual(s.H.queued().length, 0);
});

t.test('the request lives on the namespace and in the run file', function () {
    var s = runSetup(5);
    s.answer = '2';
    s.run.start(s.id);
    assert.strictEqual(s.S.modules.adventures.runState.request.count, 2);
    var files = Object.keys(s.fs.disk).filter(function (k) { return /run.json$/.test(k); });
    assert.strictEqual(files.length, 1);
    assert.strictEqual(JSON.parse(s.fs.disk[files[0]]).request.count, 2);
    s.S.modules.adventures.runState.request = null;
    assert.strictEqual(s.S.modules.adventures.run.current(), null);
});

// ---- menu sync ----------------------------------------------------------------------

t.test('menu sync rebuilds only when the template set changed', function () {
    var s = setup({ buffs: [] });
    var calls = [];
    s.S.kernel.ui.refreshModuleMenu = function (id) { calls.push(id); return true; };
    var menu = s.S.modules.adventures.menu;
    menu.items();
    assert.strictEqual(menu.sync(), false);
    assert.strictEqual(calls.length, 0);
    var id = s.tpl.save(record({}), 1000).id;
    assert.strictEqual(menu.sync(), true);
    assert.deepStrictEqual(plain(calls), ['adventures']);
    menu.items();
    assert.strictEqual(menu.sync(), false);
    var rec = s.tpl.get(id);
    rec.label = 'Renamed';
    s.tpl.save(rec, 2000);
    assert.strictEqual(menu.sync(), true);
    assert.strictEqual(calls.length, 2);
});
