'use strict';

// The ~Adventures~ bar menu of the adventures module: the rows folded from the steps
// table, their marks and details, the run controls and the row-set signature.
// Runs are built in the home world of tests/stubs/adventures.js and put at the
// step a test is about; the menu only reads memory, so no game traffic is
// needed.

var t = require('../runner');
var W = require('../stubs/adventures');

var assert = t.assert;

var WAVES = ['C:/b/w1.txt', 'C:/b/w2.txt', 'C:/b/w3.txt', 'C:/b/w4.txt'];

// The value of a step named by its key: 'Pack' is a run step, 'wave Supply' a
// wave step (Supply, Load and Verify exist in both tables).
function stepValue(w, key) {
    var m = /^wave (\w+)$/.exec(key);
    return m ? w.S.WaveStep[m[1]] : w.S.RunStep[key];
}

// o.waves: wave file count (default 2); o.step: a key for stepValue; o.waveIndex; o.count and
// o.finished: the request; o.paused pauses the run at its step;
// o.run: run fields set after newRun.
function setup(o) {
    o = o || {};
    var w = W.world({ home: true });
    w.run = w.S.modules.adventures.run;
    w.rm = w.S.modules.adventures.runmenu;
    if (o.none) return w;
    // Retraining is a module setting; o.run.retrain stands for it and never lands on the run.
    w.S.kernel.settings.write('adventures', { retrain: !(o.run && o.run.retrain === false) });
    var r = w.st.newRun({
        id: 42, templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights', zoneId: null,
        paths: WAVES.slice(0, o.waves || 2), loadoutPath: W.LOADOUT, loadoutKeys: {},
        waveIndex: o.waveIndex || 0, speedBuff: o.speedBuff || 'SpeedBuffDefault',
        step: w.S.RunStep.Muster
    });
    // After newRun, which starts a wave step's run at Gate.
    r.step = stepValue(w, o.step || 'Muster');
    var k;
    for (k in (o.run || {})) {
        if (k !== 'retrain' && Object.prototype.hasOwnProperty.call(o.run, k)) r[k] = o.run[k];
    }
    w.st.begin({
        templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights', count: o.count || 1, ended: false,
        requested: w.t, finished: o.finished || 0, closedAt: null
    }, r);
    if (o.paused) w.st.pause(w.S.RunPause.User, 'paused by you');
    return w;
}

// The run's island, viewed: the zone the steps after Pack run on.
function onIsland(w) {
    w.st.run().zoneId = W.ZONE;
    w.H.host.game.gi.visitZone(W.ZONE);
}

function plain(v) { return JSON.parse(JSON.stringify(v)); }

// Rows of every group in order: [{ group, label, file, mark, detail }].
function flat(w) {
    var out = [];
    var groups = w.rm.rows();
    for (var g = 0; g < groups.length; g++) {
        for (var n = 0; n < groups[g].rows.length; n++) {
            var row = groups[g].rows[n];
            out.push({ group: groups[g].label, label: row.label, file: row.file, mark: row.mark, detail: row.detail });
        }
    }
    return out;
}

function row(w, label) {
    var list = flat(w);
    for (var i = 0; i < list.length; i++) if (list[i].label === label) return list[i];
    throw new Error('no row ' + label);
}

function marks(w) {
    return flat(w).map(function (r) { return r.mark; });
}

function labelOf(item, pass) {
    if (item.separator) return '---';
    return typeof item.label === 'function' ? item.label(pass) : item.label;
}

function enabledOf(item, pass) {
    return typeof item.enabled === 'function' ? item.enabled(pass) : item.enabled !== false;
}

function labels(w) {
    var pass = {};
    return w.rm.items().map(function (it) { return labelOf(it, pass); });
}

function itemByLabel(w, label) {
    var items = w.rm.items();
    for (var i = 0; i < items.length; i++) if (!items[i].separator && items[i].label === label) return items[i];
    throw new Error('no item ' + label);
}

var CONTROLS = [['Pause run', 'pause'], ['Resume run', 'resume'], ['End repetition', 'endRepetition'],
    ['Stop run', 'stop']];

// The enabled flags of the four controls, in menu order, in one pass.
function enabledFlags(w) {
    var pass = {};
    return CONTROLS.map(function (c) { return enabledOf(itemByLabel(w, c[0]), pass); });
}

// ---- table --------------------------------------------------------------------

t.test('every run step falls in exactly one stage row with a group and a label', function () {
    var w = setup({ none: true });
    var rows = w.st.stepRows();
    Object.keys(w.S.RunStep).forEach(function (key) {
        var pos = w.st.position(w.S.RunStep[key]);
        assert.ok(pos >= 0, key + ' has a position');
        var hits = rows.filter(function (r) { return pos >= r.first && pos <= r.last; });
        assert.strictEqual(hits.length, 1, key + ' falls in ' + hits.length + ' rows');
        assert.strictEqual(hits[0].waves, false, key + ' is a stage row');
        assert.ok(hits[0].group !== '' && hits[0].label !== '', key + ' has a group and a label');
    });
    Object.keys(w.S.WaveStep).forEach(function (key) {
        var pos = w.st.position(w.S.WaveStep[key]);
        var hits = rows.filter(function (r) { return pos >= r.first && pos <= r.last; });
        assert.strictEqual(hits.length, 1, key + ' falls in ' + hits.length + ' rows');
        assert.strictEqual(hits[0].waves, true, key + ' is in the waves row');
    });
});

t.test('wave steps sit between the Horseshoe row and Place carriers', function () {
    var w = setup({ none: true });
    var rows = w.st.stepRows();
    var names = rows.map(function (r) { return r.waves ? 'waves' : r.label; });
    var i = names.indexOf('waves');
    assert.ok(i > 0, 'a waves row exists');
    assert.strictEqual(names[i - 1], 'Horseshoe');
    assert.strictEqual(names[i + 1], 'Place carriers');
    var p = w.st.position(w.S.WaveStep.Gate);
    assert.ok(p > rows[i - 1].last && p < rows[i + 1].first, 'position ' + p);
});

// ---- marks and details -----------------------------------------------------------

t.test('marks: Muster', function () {
    var w = setup({ step: 'Muster' });
    var list = flat(w);
    assert.strictEqual(list[0].label, 'Check generals and files');
    assert.strictEqual(list[0].mark, 'now');
    list.slice(1).forEach(function (r) { assert.strictEqual(r.mark, 'todo', r.label); });
});

t.test('marks: wave 3 Attack with 2 of 4 sent', function () {
    var w = setup({ waves: 4, waveIndex: 2, step: 'wave Attack' });
    var r = w.st.run();
    assert.strictEqual(r.step, w.S.WaveStep.Attack);
    var A = w.S.BattleLine.Attack;
    w.st.current().cache = {
        runId: r.id, waveIndex: 2, path: WAVES[2],
        lines: [{ key: 'a', kind: A }, { key: 'b', kind: A }, { key: 'c', kind: A }, { key: 'd', kind: A }]
    };
    r.lines = { a: { sentAt: 5, seen: false }, b: { sentAt: null, seen: true }, c: { sentAt: null, seen: false } };
    assert.strictEqual(row(w, 'Wave 1').mark, 'done');
    assert.strictEqual(row(w, 'Wave 2').mark, 'done');
    assert.strictEqual(row(w, 'Wave 3').mark, 'now');
    assert.strictEqual(row(w, 'Wave 3').detail, 'Attack 2/4');
    assert.strictEqual(row(w, 'Wave 3').file, 'w3.txt');
    assert.strictEqual(row(w, 'Wave 4').mark, 'todo');
    assert.strictEqual(row(w, 'Horseshoe').mark, 'done');
    assert.strictEqual(row(w, 'Place carriers').mark, 'todo');
    var text = labels(w).filter(function (l) { return l.indexOf(w.rm.MARK.now) === 0; })[0];
    assert.strictEqual(text, w.rm.MARK.now + '  Wave 3  w3.txt   Attack 2/4');
});

t.test('marks: paused at wave 2 Supply', function () {
    var w = setup({ waves: 3, waveIndex: 1, step: 'wave Supply', paused: true });
    assert.strictEqual(row(w, 'Wave 1').mark, 'done');
    assert.strictEqual(row(w, 'Wave 2').mark, 'paused');
    assert.strictEqual(row(w, 'Wave 2').detail, 'Supply');
    assert.strictEqual(row(w, 'Wave 3').mark, 'todo');
    var text = labels(w).filter(function (l) { return /Wave 2/.test(l); })[0];
    assert.strictEqual(text.indexOf(w.rm.MARK.paused + '  Wave 2'), 0, text);
});

t.test('marks: Pack', function () {
    var w = setup({ step: 'Pack' });
    assert.strictEqual(row(w, 'Place carriers').mark, 'done');
    assert.strictEqual(row(w, 'Pack leftover troops').mark, 'now');
    assert.strictEqual(row(w, 'Wait for last quest').mark, 'todo');
    assert.strictEqual(row(w, 'Wave 2').mark, 'done');
    assert.strictEqual(row(w, 'Return home').mark, 'todo');
});

t.test('marks: Done marks every row done, the not-used ones stay skipped', function () {
    var w = setup({ step: 'Next', run: { retrain: false } });
    w.st.done();
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Done);
    flat(w).forEach(function (r) {
        if (r.label === 'Count lost troops' || r.label === 'Retrain') assert.strictEqual(r.mark, 'skip', r.label);
        else assert.strictEqual(r.mark, 'done', r.label);
    });
});

t.test('a stopped run shows Stopped and the rows after its step stay todo', function () {
    var w = setup({ step: 'Pack', finished: 1 });
    w.st.stop('troops short: 5 Rifle');
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Done);
    assert.strictEqual(labels(w)[1].indexOf('Stopped:'), 0, 'the status line is the second item');
    assert.strictEqual(w.st.status().indexOf('Stopped:'), 0);
    assert.strictEqual(row(w, 'Place carriers').mark, 'done');
    assert.strictEqual(row(w, 'Pack leftover troops').mark, 'paused');
    assert.strictEqual(row(w, 'Wait for last quest').mark, 'todo');
    assert.strictEqual(row(w, 'Return home').mark, 'todo');
});

t.test('marks: no run gives no rows', function () {
    var w = setup({ none: true });
    assert.strictEqual(w.rm.rows().length, 0);
    assert.strictEqual(flat(w).length, 0);
});

t.test('Verify with an open round shows Load', function () {
    var w = setup({ waveIndex: 0, step: 'wave Verify' });
    var r = w.st.run();
    var round = { runId: r.id, waveIndex: 0, step: w.S.WaveStep.Load, zoneId: 7,
        expected: { a: true, b: true }, results: { a: { status: 'ok' } } };
    w.st.current().round = round;
    assert.strictEqual(row(w, 'Wave 1').detail, 'Load 1/2');
    round.results.b = { status: 'ok' };
    assert.strictEqual(row(w, 'Wave 1').detail, 'Verify 2/2');
});

t.test('backward step Clear to PackStar reopens the row', function () {
    var w = setup({ step: 'Clear' });
    assert.strictEqual(row(w, 'Place carriers').mark, 'done');
    assert.strictEqual(row(w, 'Wait for last quest').mark, 'now');
    w.st.go(w.S.RunStep.PackStar, 'test');
    assert.strictEqual(row(w, 'Place carriers').mark, 'now');
    assert.strictEqual(row(w, 'Pack leftover troops').mark, 'todo');
    assert.strictEqual(row(w, 'Wait for last quest').mark, 'todo');
    assert.strictEqual(row(w, 'Wave 1').mark, 'done');
});

t.test('horseshoe None and retrain off show not used', function () {
    var w = setup({ speedBuff: 'SpeedBuffNone', run: { retrain: false }, step: 'Muster' });
    ['Horseshoe', 'Count lost troops', 'Retrain'].forEach(function (label) {
        assert.strictEqual(row(w, label).mark, 'skip', label);
        assert.strictEqual(row(w, label).detail, 'not used', label);
    });
    var text = labels(w).filter(function (l) { return /Horseshoe/.test(l); })[0];
    assert.strictEqual(text, w.rm.MARK.skip + '  Horseshoe   not used');
    assert.notStrictEqual(row(w, 'Send generals').mark, 'skip');
    var on = setup({ run: { retrain: true } });
    assert.notStrictEqual(row(on, 'Horseshoe').mark, 'skip');
    assert.notStrictEqual(row(on, 'Retrain').detail, 'not used');
});

t.test('a run started on an open map shows retraining not used', function () {
    var w = setup({ step: 'Validate', run: { snapshot: null } });
    assert.notStrictEqual(row(w, 'Retrain').mark, 'skip', 'still before the snapshot step');
    w.st.go(w.S.RunStep.Jump, 'test');
    assert.strictEqual(row(w, 'Count lost troops').mark, 'skip');
    assert.strictEqual(row(w, 'Retrain').detail, 'not used');
    var snap = setup({ step: 'Jump', run: { snapshot: { Rifle: 5 } } });
    assert.notStrictEqual(row(snap, 'Retrain').mark, 'skip');
});

t.test('rows read no file', function () {
    var w = setup({ waves: 3, waveIndex: 1, step: 'wave Attack' });
    var reads = 0;
    var files = w.S.kernel.files;
    var readText = files.readText;
    files.readText = function () { reads++; return readText.apply(this, arguments); };
    var load = w.S.core.battles.load;
    w.S.core.battles.load = function () { reads++; return load.apply(this, arguments); };
    w.rm.rows();
    labels(w);
    enabledFlags(w);
    assert.strictEqual(reads, 0);
    assert.ok(Object.keys(w.fs.disk).length > 0);
});

// ---- busy wait -------------------------------------------------------------------

// A memory-only busy record for the run's current step, started `ago` ms back.
function setBusy(w, ago, step) {
    var r = w.st.run();
    w.st.current().busy = { runId: r.id, step: step === undefined ? r.step : step, key: 'g1',
        text: 'The Smuggler (325505.0) busy', since: w.t - ago, noted: null };
}

t.test('busy: the stage row shows who and how long, ahead of the round count', function () {
    var w = setup({ step: 'Arrive' });
    var r = w.st.run();
    w.st.current().round = { runId: r.id, waveIndex: 0, step: r.step, zoneId: 7,
        expected: { a: true, b: true }, results: { a: { status: 'ok' } } };
    setBusy(w, 1000);
    assert.strictEqual(row(w, 'Wait for all generals').detail, 'The Smuggler (325505.0) busy');
    setBusy(w, 150000);
    assert.strictEqual(row(w, 'Wait for all generals').detail, 'The Smuggler (325505.0) busy, 2 min');
    w.st.current().busy = null;
    assert.notStrictEqual(row(w, 'Wait for all generals').detail.indexOf('busy'), 0);
});

t.test('busy: the wave row shows it after the step name', function () {
    var w = setup({ waves: 2, waveIndex: 0, step: 'wave Gate' });
    setBusy(w, 61000);
    assert.strictEqual(row(w, 'Wave 1').detail, 'Gate, The Smuggler (325505.0) busy, 1 min');
    assert.strictEqual(row(w, 'Wave 2').detail, '');
});

t.test('busy: the status line picks it up', function () {
    var w = setup({ step: 'Arrive' });
    onIsland(w);
    setBusy(w, 120000);
    assert.strictEqual(labels(w)[1], 'Now: Wait for all generals, The Smuggler (325505.0) busy, 2 min');
});

t.test('busy: a record of another step shows nothing', function () {
    var w = setup({ step: 'Arrive' });
    setBusy(w, 120000, w.S.RunStep.Muster);
    assert.ok(row(w, 'Wait for all generals').detail.indexOf('busy') < 0);
    var r = w.st.run();
    w.st.current().busy = { runId: r.id + 1, step: r.step, key: 'g1', text: 'x busy', since: w.t, noted: null };
    assert.ok(row(w, 'Wait for all generals').detail.indexOf('busy') < 0);
    delete w.st.current().busy;
    assert.doesNotThrow(function () { labels(w); });
});

// ---- view hint ------------------------------------------------------------------

t.test('hint: a step that runs on the island names it when home is viewed', function () {
    var w = setup({ step: 'Arrive' });
    assert.strictEqual(labels(w)[1], 'Now: Wait for all generals, view the island');
    w = setup({ waves: 2, waveIndex: 1, step: 'wave Attack' });
    assert.strictEqual(labels(w)[1], 'Now: Wave 2, Attack, view the island');
});

t.test('hint: the hint follows the busy text', function () {
    var w = setup({ step: 'Arrive' });
    setBusy(w, 120000);
    assert.strictEqual(labels(w)[1], 'Now: Wait for all generals, The Smuggler (325505.0) busy, 2 min, view the island');
});

t.test('hint: a home step viewed on the island says go home', function () {
    var w = setup({ step: 'Muster' });
    onIsland(w);
    assert.ok(/, go home$/.test(labels(w)[1]), labels(w)[1]);
});

t.test('hint: no hint on the right zone, on an any-zone step, paused or done', function () {
    var w = setup({ step: 'Arrive' });
    onIsland(w);
    assert.ok(!/view the island|go home/.test(labels(w)[1]), labels(w)[1]);
    w = setup({ step: 'Muster' });
    assert.ok(!/view the island|go home/.test(labels(w)[1]), labels(w)[1]);
    w = setup({ step: 'Arrive', paused: true });
    assert.strictEqual(labels(w)[1], 'paused by you');
    w.st.resume();
    w.st.done();
    assert.strictEqual(labels(w)[1], 'Series done; use Stop run to clear');
});

// ---- controls --------------------------------------------------------------------

// The states of the investigation's table: [name, setup options, mutate, can()].
var STATES = [
    ['no request', { none: true }, null, [false, false, false, false]],
    ['request without a run', { count: 3 }, function (w) { w.st.current().run = null; }, [false, false, false, true]],
    ['running, one run', { count: 1 }, null, [true, false, false, true]],
    ['running, run 1 of 3', { count: 3 }, null, [true, false, true, true]],
    ['running, last of 3', { count: 3, finished: 2 }, null, [true, false, false, true]],
    ['paused, run 1 of 3', { count: 3, paused: true }, null, [false, true, true, true]],
    ['paused, one run', { count: 1, paused: true }, null, [false, true, false, true]],
    ['done', { count: 1 }, function (w) { w.st.done(); }, [false, false, false, true]]
];

function fresh(state) {
    var w = setup(state[1]);
    if (state[2]) state[2](w);
    return w;
}

t.test('can table', function () {
    STATES.forEach(function (state) {
        var w = fresh(state);
        var can = w.run.can();
        assert.deepStrictEqual(Object.keys(can).sort(), ['endRepetition', 'pause', 'resume', 'stop'], state[0]);
        var got = CONTROLS.map(function (c) { return can[c[1]]; });
        assert.deepStrictEqual(got, state[3], state[0]);
        got.forEach(function (v) { assert.strictEqual(typeof v, 'boolean', state[0]); });
        assert.deepStrictEqual(enabledFlags(w), state[3], state[0] + ' menu flags');
    });
});

t.test('a control enabled by can() runs its command', function () {
    STATES.forEach(function (state) {
        CONTROLS.forEach(function (c) {
            var name = c[1];
            var w = fresh(state);
            var rs = w.st.current();
            // A request without a run can still be ended, the one place the
            // table is stricter than the command: the control stays grey.
            if (name === 'endRepetition' && rs.request && !rs.run) return;
            var enabled = w.run.can()[name];
            var result = w.run[name]();
            assert.strictEqual(result, enabled, state[0] + ': ' + name);
        });
    });
    var w = fresh(STATES[1]);
    assert.strictEqual(w.run.can().endRepetition, false);
    assert.strictEqual(w.run.endRepetition(), true);
});

t.test('controls exist once', function () {
    var w = setup({ count: 3 });
    var calls = [];
    CONTROLS.forEach(function (c) {
        w.run[c[1]] = function () { calls.push(c[1]); return true; };
    });
    var items = w.rm.items();
    CONTROLS.forEach(function (c) {
        var found = items.filter(function (it) { return it.label === c[0]; });
        assert.strictEqual(found.length, 1, c[0]);
        assert.strictEqual(typeof found[0].onSelect, 'function', c[0]);
        found[0].onSelect();
    });
    assert.deepStrictEqual(calls, ['pause', 'resume', 'endRepetition', 'stop']);
    assert.strictEqual(items.filter(function (it) { return typeof it.onSelect === 'function'; }).length, 4);
});

// ---- title and status line ------------------------------------------------------------

t.test('title per status', function () {
    var w = setup({ none: true });
    assert.strictEqual(labels(w)[0], 'No run');
    w = setup({ count: 3, finished: 1 });
    assert.strictEqual(labels(w)[0], 'Running: Black Knights, run 2/3');
    w.st.pause(w.S.RunPause.User, 'paused by you');
    assert.strictEqual(labels(w)[0], 'Paused: Black Knights, run 2/3');
    w.st.resume();
    w.st.done();
    assert.strictEqual(labels(w)[0], w.st.status());
    assert.ok(/^Done: /.test(labels(w)[0]), labels(w)[0]);
});

t.test('status line paused, running and done', function () {
    var w = setup({ waves: 2, waveIndex: 1, step: 'wave Attack' });
    onIsland(w);
    assert.strictEqual(labels(w)[1], 'Now: Wave 2, Attack');
    w.st.pause(w.S.RunPause.User, 'paused by you');
    assert.strictEqual(labels(w)[1], 'paused by you');
    w.st.resume();
    w.st.done();
    assert.strictEqual(labels(w)[1], 'Series done; use Stop run to clear');
});

// ---- item set ------------------------------------------------------------------------

t.test('idle items are title and controls only', function () {
    var w = setup({ none: true });
    assert.deepStrictEqual(plain(labels(w)), ['No run', '---', 'Pause run', 'Resume run', 'End repetition', 'Stop run']);
    assert.strictEqual(w.rm.signature(), 'idle');
});

t.test('row count follows the wave count', function () {
    var two = setup({ waves: 2 });
    var four = setup({ waves: 4 });
    assert.strictEqual(two.rm.signature(), 'waves:2');
    assert.strictEqual(four.rm.signature(), 'waves:4');
    assert.strictEqual(four.rm.items().length - two.rm.items().length, 2);
    // Title, status line, a separator and the controls come first; then each
    // group adds a separator and a head, and each row an item.
    var expected = 7;
    four.rm.rows().forEach(function (g) { expected += 2 + g.rows.length; });
    assert.strictEqual(four.rm.items().length, expected);
});

t.test('sync does not rebuild across a series, rebuilds on start and only hides on stop', function () {
    var w = setup({ none: true });
    var calls = [];
    w.S.kernel.ui = w.S.kernel.ui || {};
    w.S.kernel.ui.refreshBarMenu = function (id) { calls.push(id); return true; };
    var shown = [];
    w.S.kernel.ui.showBarMenu = function (id, show) { shown.push([id, show]); return true; };
    w.rm.items();
    assert.strictEqual(w.rm.sync(), false);
    assert.strictEqual(calls.length, 0, 'no run builds nothing');
    assert.deepStrictEqual(shown, [['adventures', false]]);

    var r = w.st.newRun({
        id: 42, templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights', zoneId: null,
        paths: WAVES.slice(0, 2), loadoutPath: W.LOADOUT, loadoutKeys: {}, step: w.S.RunStep.Muster
    });
    var req = { templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights', count: 2, ended: false,
        requested: w.t, finished: 0, closedAt: null };
    w.st.begin(req, r);
    assert.deepStrictEqual(calls, ['adventures'], 'start rebuilds');
    assert.deepStrictEqual(shown[shown.length - 1], ['adventures', true], 'and shows');
    w.rm.items();
    shown.length = 0;

    // The next run of the series has the same wave count.
    req.finished = 1;
    w.st.begin(req, w.st.newRun({
        id: 43, templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights', zoneId: null,
        paths: WAVES.slice(0, 2), loadoutPath: W.LOADOUT, loadoutKeys: {}, step: w.S.RunStep.Muster
    }));
    assert.strictEqual(calls.length, 1, 'a series rebuilds nothing');
    assert.ok(shown.every(function (s) { return s[1] === true; }), 'and never hides');

    shown.length = 0;
    w.st.clear();
    assert.strictEqual(calls.length, 1, 'stop rebuilds nothing');
    assert.deepStrictEqual(shown[shown.length - 1], ['adventures', false], 'it hides the entry');
});

t.test('no label throws with the core buffs throwing', function () {
    var w = setup({ waves: 2, waveIndex: 1, step: 'wave Attack' });
    w.S.core.buffs.speedBuffs = function () { throw new Error('game not loaded'); };
    var list;
    assert.doesNotThrow(function () { list = labels(w); });
    assert.ok(list.length > 6);
    assert.doesNotThrow(function () { enabledFlags(w); });
    assert.strictEqual(row(w, 'Horseshoe').detail, '');
    assert.deepStrictEqual(plain(marks(w)).length, flat(w).length);
});

t.test('the todo mark is two no-break spaces', function () {
    var w = setup({ waves: 2 });
    assert.strictEqual(w.rm.MARK.todo, '  ');
    assert.strictEqual(w.rm.MARK.todo.length, 2);
});

t.test('both menus take the four run commands from one table', function () {
    var w = setup({ waves: 2 });
    var table = w.S.modules.adventures.menu.COMMANDS;
    assert.deepStrictEqual(plain(table.map(function (c) { return c.name; })),
        ['pause', 'resume', 'endRepetition', 'stop']);
    table.forEach(function (c) {
        assert.ok(itemByLabel(w, c.label), c.label);
    });
});
