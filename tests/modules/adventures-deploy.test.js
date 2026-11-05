'use strict';

// The Deploy step of the adventures run: a loadout general standing in the
// star menu at home is placed back on the home grid the run remembered for
// him, and the run waits with no limit, never pausing, when it cannot place
// him. Runs without a star general never see the step. The home world of
// tests/stubs/adventures.js ({ home: true }) is the same as in
// adventures-run.test.js.

var t = require('../runner');
var AC = require('../stubs/actions');
var W = require('../stubs/adventures');

var assert = t.assert;

var HOME = W.HOME;
var LOADOUT = W.LOADOUT;
var WAVE = 'C:/b/w1.txt';
var KEYS = { '1.1': true, '1.2': true };

// A wait with no limit is held far past every limit it used to have.
var LONG_MS = 3600000;
var PASS_MS = 10000;

var plain = W.plain;
var writeJson = W.writeJson;
var tick = W.tick;
var play = W.play;
var stepName = W.stepName;

// ---- world ------------------------------------------------------------------

function gen(uid, name, grid, army) {
    return AC.general({ uid: uid, name: name, grid: grid, army: army || {} });
}

// Anna (1.1) on grid 10 and Bert (1.2) on grid 20 at home; o.grid1 puts Anna
// elsewhere, 0 being the star menu.
function homeWorld(o) {
    o = o || {};
    var g1 = gen('1.1', 'Anna', typeof o.grid1 === 'number' ? o.grid1 : 10);
    var g2 = gen('1.2', 'Bert', typeof o.grid2 === 'number' ? o.grid2 : 20);
    var w = W.world({ home: true, generals: [g1, g2], free: { Rifle: 20, Bow: 0 } });
    w.g1 = g1;
    w.g2 = g2;
    writeJson(w.fs, LOADOUT, {
        '1.1': { grid: 10, army: { Rifle: 5 } },
        '1.2': { grid: 20, army: { Rifle: 3 } }
    });
    writeJson(w.fs, WAVE, {
        '1.1': { grid: 10, target: 100, army: { Rifle: 5 }, order: 1, name: 'Anna' },
        '1.2': { grid: 20, target: 200, army: { Rifle: 3 }, order: 2, name: 'Bert' }
    });
    w.gi = w.H.host.game.gi;
    return w;
}

// A run of the series at o.step (default Validate); o.run: run fields set
// after newRun.
function series(w, o) {
    o = o || {};
    var r = w.st.newRun({
        id: o.id || 42, templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights', zoneId: null,
        paths: [WAVE], loadoutPath: LOADOUT, loadoutKeys: KEYS, waveIndex: 0, speedBuff: '',
        step: o.step || w.S.RunStep.Validate
    });
    var k;
    for (k in (o.run || {})) if (Object.prototype.hasOwnProperty.call(o.run, k)) r[k] = o.run[k];
    w.st.begin({
        templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights', count: o.count || 1, ended: false,
        requested: w.t, finished: 0, closedAt: null
    }, r);
    return w.st.run();
}

function pass(w) {
    tick(w);
    play(w);
    w.t += 1000;
}

// Passes over this much clock, each with its queue played.
function passesFor(w, ms) {
    var end = w.t + ms;
    while (w.t < end) {
        W.ticksFor(w, Math.min(PASS_MS, end - w.t));
        play(w);
    }
}

// Passes until the step is name, at most max of them.
function until(w, name, max) {
    for (var i = 0; i < (max || 60) && stepName(w) !== name; i++) pass(w);
}

function assertStep(w, name) {
    var r = w.st.run();
    assert.strictEqual(stepName(w), name, 'step ' + stepName(w) + (r.pause ? ' (' + r.pause.message + ')' : ''));
    assert.strictEqual(r.status, w.S.RunStatus.Running, 'status ' + r.status + (r.pause ? ': ' + r.pause.message : ''));
}

function waiting(w, re) {
    var b = w.st.current().busy;
    assert.ok(b && re.test(b.text), b ? b.text : 'no wait');
}

function linesOf(w, re) {
    return w.H.logs().filter(function (l) {
        return l.category === 'adventures' && re.test(l.args.join(' '));
    });
}

function logged(w, re) {
    return linesOf(w, re).length > 0;
}

function movesOf(w) {
    return w.orders.filter(function (o) { return o.code === w.code.move; });
}

function steps(w) {
    var out = [];
    linesOf(w, /^[^:]+: \w+ -> \w+/).forEach(function (l) {
        var m = /^[^:]+: (\w+) -> (\w+)/.exec(l.args.join(' '));
        out.push(m[1] + '>' + m[2]);
    });
    return out;
}

// ---- tests --------------------------------------------------------------------

t.test('Deploy: a star general with a remembered grid is moved there once, then Snapshot', function () {
    var w = homeWorld({ grid1: 0 });
    w.auto.walk = true;
    series(w, { run: { homeGrids: { '1.1': 10 } } });
    pass(w);
    assertStep(w, 'Deploy');
    assert.ok(steps(w).indexOf('Validate>Deploy') >= 0, steps(w).join(', '));
    pass(w);
    assert.strictEqual(movesOf(w).length, 1);
    assert.strictEqual(movesOf(w)[0].key, '1.1');
    assert.strictEqual(movesOf(w)[0].grid, 10);
    assert.ok(logged(w, /placing 1 general\(s\) from the star menu: 1\.1 -> 10/));
    for (var i = 0; i < 10; i++) pass(w);
    assertStep(w, 'Deploy');
    waiting(w, /Anna \(1\.1\) walking to his grid/);
    assert.strictEqual(movesOf(w).length, 1, 'no second move while walking');
    w.endWalks();
    until(w, 'Snapshot');
    assertStep(w, 'Snapshot');
    assert.strictEqual(movesOf(w).length, 1);
    assert.strictEqual(w.g1.state.grid, 10);
    assert.ok(!logged(w, /run paused/));
});

t.test('Deploy: no remembered grid waits with no limit for the user and sends nothing', function () {
    var w = homeWorld({ grid1: 0 });
    series(w);
    pass(w);
    assertStep(w, 'Deploy');
    passesFor(w, LONG_MS);
    assertStep(w, 'Deploy');
    waiting(w, /Anna \(1\.1\) is in the star menu; place him on the island \(no grid\)/);
    assert.ok(logged(w, /in the star menu; place him on the island/));
    assert.ok(!logged(w, /run paused/));
    assert.strictEqual(w.orders.length, 0);
    // The user places him by hand.
    w.g1.state.grid = 12;
    until(w, 'Snapshot');
    assertStep(w, 'Snapshot');
    assert.strictEqual(w.orders.length, 0);
});

t.test('Deploy: a grid the client refuses waits, sends nothing and never pauses', function () {
    var w = homeWorld({ grid1: 0 });
    w.blocked[10] = true;
    series(w, { run: { homeGrids: { '1.1': 10 } } });
    pass(w);
    assertStep(w, 'Deploy');
    passesFor(w, LONG_MS);
    assertStep(w, 'Deploy');
    waiting(w, /in the star menu; place him on the island \(not placeable at 10\)/);
    assert.strictEqual(w.orders.length, 0);
    assert.ok(!logged(w, /run paused/));
    w.blocked = {};
    until(w, 'Snapshot');
    assertStep(w, 'Snapshot');
    assert.strictEqual(movesOf(w).length, 1);
});

t.test('Deploy: a refused move does not pause and is tried again only after DEPLOY_RETRY_MS', function () {
    var w = homeWorld({ grid1: 0 });
    var retryMs = w.S.modules.adventures.home.DEPLOY_RETRY_MS;
    assert.ok(retryMs > 0, 'home exports DEPLOY_RETRY_MS');
    series(w, { step: w.S.RunStep.Deploy, run: { homeGrids: { '1.1': 10 } } });
    tick(w);
    // Refused by the queued precheck, after the step saw the grid placeable.
    w.blocked[10] = true;
    play(w);
    w.blocked = {};
    assert.strictEqual(movesOf(w).length, 0);
    var round = w.st.current().round;
    assert.ok(round && typeof round.doneAt === 'number', 'the round finished');
    passesFor(w, round.doneAt + retryMs - 1 - w.t);
    assertStep(w, 'Deploy');
    waiting(w, /Anna \(1\.1\) could not be placed \(not placeable at 10\); place him on the island/);
    assert.strictEqual(movesOf(w).length, 0, 'no retry before DEPLOY_RETRY_MS');
    passesFor(w, 2 * PASS_MS);
    assert.strictEqual(movesOf(w).length, 1, 'one retry after it');
    until(w, 'Snapshot');
    assertStep(w, 'Snapshot');
    assert.strictEqual(movesOf(w).length, 1);
    assert.strictEqual(w.st.run().rounds, 0, 'r.rounds untouched');
    assert.ok(!logged(w, /run paused/));
});

t.test('homeGrids: written at Muster, keeping the grid of a star general', function () {
    var w = homeWorld({ grid1: 0 });
    series(w, { step: w.S.RunStep.Muster, run: { homeGrids: { '1.1': 10 } } });
    pass(w);
    assertStep(w, 'Validate');
    assert.deepStrictEqual(plain(w.st.run().homeGrids), { '1.1': 10, '1.2': 20 });
});

t.test('homeGrids: written at ArriveHome from where the generals stand', function () {
    var w = homeWorld({ grid1: 15 });
    series(w, { step: w.S.RunStep.ArriveHome, run: { homeGrids: { '1.1': 10 } } });
    tick(w);
    assertStep(w, 'Account');
    assert.deepStrictEqual(plain(w.st.run().homeGrids), { '1.1': 15, '1.2': 20 });
});

t.test('homeGrids: a run kept in memory without the field is given one at Muster', function () {
    var w = homeWorld();
    var r = series(w, { step: w.S.RunStep.Muster });
    delete r.homeGrids;
    tick(w);
    assertStep(w, 'Validate');
    assert.deepStrictEqual(plain(w.st.run().homeGrids), { '1.1': 10, '1.2': 20 });
});

t.test('homeGrids: carried into the next run by nextRun', function () {
    var w = homeWorld();
    var r1 = series(w, { step: w.S.RunStep.Next, count: 2, run: { homeGrids: { '1.1': 77 } } });
    var id1 = r1.id;
    tick(w);
    var r = w.st.run();
    assert.notStrictEqual(r.id, id1, 'run 2 began');
    assert.strictEqual(r.step, w.S.RunStep.Muster);
    assert.deepStrictEqual(plain(r.homeGrids), { '1.1': 77 });
});

t.test('homeGrids: survive save and load; junk values are dropped', function () {
    var w = homeWorld();
    series(w, { run: { homeGrids: { '1.1': 10, '1.2': 20 } } });
    w.st.save();
    var w2 = W.world({ home: true, fs: w.fs, generals: [w.g1, w.g2], free: { Rifle: 20 } });
    w2.mod.boot();
    assert.ok(w2.st.run(), 'the run came back from the file');
    assert.deepStrictEqual(plain(w2.st.run().homeGrids), { '1.1': 10, '1.2': 20 });

    var data = JSON.parse(w.fs.disk[W.RUN_FILE]);
    data.run.homeGrids = { '1.1': 10, '1.2': 0, '1.3': -4, '1.4': 'x', '1.5': null };
    w.fs.disk[W.RUN_FILE] = JSON.stringify(data);
    var w3 = W.world({ home: true, fs: w.fs, generals: [w.g1, w.g2], free: { Rifle: 20 } });
    w3.mod.boot();
    assert.deepStrictEqual(plain(w3.st.run().homeGrids), { '1.1': 10 });
});

t.test('Deploy: the probe line is logged once per run and key', function () {
    var w = homeWorld({ grid1: 0, grid2: 0 });
    series(w, { run: { homeGrids: { '1.2': 20 } } });
    w.blocked[20] = true;
    pass(w);
    assertStep(w, 'Deploy');
    passesFor(w, 10 * PASS_MS);
    var anna = linesOf(w, /star menu at home: Anna \(1\.1\); home grid unknown, placeCode n\/a; landing grids 0$/);
    var bert = linesOf(w, /star menu at home: Bert \(1\.2\); home grid 20, placeCode 1; landing grids 0$/);
    assert.strictEqual(anna.length, 1, 'Anna once');
    assert.strictEqual(bert.length, 1, 'Bert once');
    assert.strictEqual(linesOf(w, /star menu at home: /).length, 2);
    assert.strictEqual(w.orders.length, 0);
});

t.test('Deploy: a run without a star general goes Validate -> Snapshot', function () {
    var w = homeWorld();
    series(w);
    pass(w);
    assertStep(w, 'Snapshot');
    assert.ok(steps(w).indexOf('Validate>Snapshot') >= 0, steps(w).join(', '));
    steps(w).forEach(function (s) { assert.ok(!/Deploy/.test(s), s); });
    assert.strictEqual(w.orders.length, 0);
    assert.ok(!logged(w, /star menu at home/));
});

t.test('Deploy: S.RunStep.Deploy sits between Validate and Snapshot', function () {
    var w = homeWorld();
    var RS = w.S.RunStep;
    assert.strictEqual(RS.Deploy, 'RunDeploy');
    assert.strictEqual(w.st.stepName(RS.Deploy), 'Deploy');
    assert.strictEqual(w.st.isWaveStep(RS.Deploy), false);
    assert.ok(w.st.position(RS.Validate) < w.st.position(RS.Deploy), 'after Validate');
    assert.ok(w.st.position(RS.Deploy) < w.st.position(RS.Snapshot), 'before Snapshot');
    assert.strictEqual(w.S.core.zone.id(), HOME);
});
