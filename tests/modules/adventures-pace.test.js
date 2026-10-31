'use strict';

// The pace of an adventures run: how soon the next pass follows one, the holds
// that give a lagging read its time, and the bar menu that is shown only while
// a run is Running or Paused.
//
// scheduler.wake is replaced by a recorder and queue.isModuleBusy by a switch,
// because the kernel stub captures queue.add and so never shows queue work.
// W.tick does not move the clock: a test that waits moves w.t itself, by one
// jump with no pass in between.

var t = require('../runner');
var AC = require('../stubs/actions');
var W = require('../stubs/adventures');

var assert = t.assert;

var ZONE = W.ZONE;
var RUN_FILE = W.RUN_FILE;
var LOADOUT = W.LOADOUT;
var WAVE = 'C:/b/w1.txt';
var PACK_KEYS = { '1.1': true, '1.2': true, '1.5': true };

var tick = W.tick;
var play = W.play;
var startRun = W.startRun;
var stepName = W.stepName;
var writeJson = W.writeJson;

// ---- worlds -----------------------------------------------------------------

function files(w) {
    writeJson(w.fs, LOADOUT, {
        '1.1': { grid: 10, army: { Rifle: 5 } },
        '1.2': { grid: 20, army: { Rifle: 3 } }
    });
    writeJson(w.fs, WAVE, {
        '1.1': { grid: 10, target: 100, army: { Rifle: 5 }, order: 1, name: 'Anna' },
        '1.2': { grid: 20, target: 200, army: { Rifle: 3 }, order: 2, name: 'Bert' }
    });
}

function spy(w) {
    w.wakes = [];
    w.busy = false;
    w.S.kernel.scheduler.wake = function (id, ms) { w.wakes.push([id, ms]); return true; };
    w.S.kernel.queue.isModuleBusy = function () { return w.busy; };
    return w;
}

// Viewing the island, Anna and Bert on their grids with their armies.
function islandWorld(extra) {
    var g1 = AC.general({ uid: '1.1', name: 'Anna', grid: 10, army: { Rifle: 5 } });
    var g2 = AC.general({ uid: '1.2', name: 'Bert', grid: 20, army: { Rifle: 3 } });
    var w = W.world({ generals: [g1, g2].concat(extra || []) });
    files(w);
    w.g1 = g1;
    w.g2 = g2;
    return spy(w);
}

// Viewing home, Anna and Bert empty on their grids.
function homeWorld() {
    var g1 = AC.general({ uid: '1.1', name: 'Anna', grid: 10 });
    var g2 = AC.general({ uid: '1.2', name: 'Bert', grid: 20 });
    var w = W.world({ home: true, generals: [g1, g2], free: { Rifle: 20, Bow: 0 } });
    files(w);
    w.g1 = g1;
    w.g2 = g2;
    w.gi = w.H.host.game.gi;
    return spy(w);
}

function onIsland(w, generals, free) {
    w.adventures = [{ adventureName: 'BlackKnights', zoneID: ZONE }];
    w.lists[W.HOME].length = 0;
    generals.forEach(function (g) { w.place(g, ZONE); });
    w.frees[ZONE] = free || {};
    w.gi.visitZone(ZONE);
}

// A carrier and two generals at the star on the island.
function packWorld(grid1, grid2) {
    var w = homeWorld();
    w.g1 = AC.general({ uid: '1.1', name: 'Anna', grid: grid1 || 0, maxUnits: 4 });
    w.g2 = AC.general({ uid: '1.2', name: 'Bert', grid: grid2 || 0, maxUnits: 2 });
    w.c = AC.general({ uid: '1.5', name: 'Cara', grid: 30, carrier: true, maxUnits: 10 });
    onIsland(w, [w.g1, w.g2, w.c], { Rifle: 16 });
    w.quests = [{ key: 'q9', name: 'Final', finished: true, last: true }];
    w.landing([500, 501]);
    return w;
}

function template(w) {
    w.stock.push({ type: 'Adventure', resource: 'BlackKnights', amount: 3, uid: 'map' });
    w.H.ctx.prompt = function (text, def) { return def; };
    w.H.ctx.confirm = function () { return true; };
    return w.S.modules.adventures.templates.save({
        label: 'Black Knights', adventure: 'BlackKnights', loadout: LOADOUT, waves: [WAVE],
        speedBuff: 'SpeedBuffDefault'
    }, 1000).id;
}

function ld(w) { return w.S.modules.adventures.loader; }
function lag(w) { return ld(w).READ_LAG_MS; }

// A pass of a part that does nothing, so the cadence alone shows.
function quietPart(w, name) {
    w.S.modules.adventures[name].plan = function () {};
}

function planOnce(w) {
    w.wakes.length = 0;
    w.S.kernel._currentModule = 'adventures';
    try { w.mod.plan({}); }
    finally { w.S.kernel._currentModule = null; }
}

function assertStep(w, name) {
    var r = w.st.run();
    assert.strictEqual(stepName(w), name, 'step ' + stepName(w) + (r.pause ? ' (' + r.pause.message + ')' : ''));
    assert.strictEqual(r.status, w.S.RunStatus.Running, 'status ' + r.status + (r.pause ? ': ' + r.pause.message : ''));
}

// ---- cadence ----------------------------------------------------------------

t.test('cadence: a step that moved wakes at the floor', function () {
    var w = islandWorld();
    w.g2.state.army = { Rifle: 1 };
    startRun(w, [WAVE], { step: w.S.WaveStep.Supply });
    w.wakes.length = 0;
    tick(w);
    assert.strictEqual(stepName(w), 'Load');
    assert.deepStrictEqual(w.wakes, [['adventures', 0]]);
});

t.test('cadence: a same-step re-entry counts as moved when the clock moved', function () {
    var w = islandWorld();
    startRun(w, [WAVE], { step: w.S.WaveStep.Gate });
    w.S.modules.adventures.executor.plan = function () {
        var r = w.st.run();
        w.st.go(r.step, 'again');
    };
    w.t += 1000;
    planOnce(w);
    assert.deepStrictEqual(w.wakes, [['adventures', 0]]);
});

t.test('cadence: a pass that left queue work wakes at the floor', function () {
    var w = islandWorld();
    startRun(w, [WAVE], { step: w.S.WaveStep.Gate });
    quietPart(w, 'executor');
    w.busy = true;
    planOnce(w);
    assert.deepStrictEqual(w.wakes, [['adventures', 0]]);
    w.busy = false;
    planOnce(w);
    assert.deepStrictEqual(w.wakes, [['adventures', 2000]]);
});

t.test('cadence: Gate with a busy general is a short wait', function () {
    var w = islandWorld();
    w.g1.state.task = { type: w.code.attack };
    startRun(w, [WAVE], { step: w.S.WaveStep.Gate });
    w.wakes.length = 0;
    tick(w);
    assertStep(w, 'Gate');
    assert.deepStrictEqual(w.wakes, [['adventures', 2000]]);
});

t.test('cadence: Position with a general on the way is a short wait', function () {
    var w = islandWorld();
    w.g2.state.grid = 21;
    startRun(w, [WAVE], { step: w.S.WaveStep.Position });
    w.wakes.length = 0;
    tick(w);
    assertStep(w, 'Position');
    assert.strictEqual(w.wakes.length, 1);
    assert.strictEqual(w.wakes[0][0], 'adventures');
    assert.ok(w.wakes[0][1] === 0 || w.wakes[0][1] === 2000, String(w.wakes[0][1]));
    w.wakes.length = 0;
    tick(w);
    assert.deepStrictEqual(w.wakes, [['adventures', 2000]]);
});

['Gate', 'Position'].forEach(function (name) {
    t.test('cadence: a busy wait polls at 2 s for a minute, then stays on the tick, and never wakes at 0: ' + name, function () {
        var w = islandWorld();
        w.g1.state.task = { type: w.code.attack };
        startRun(w, [WAVE], { step: w.S.WaveStep[name] });
        w.wakes.length = 0;
        tick(w);
        assertStep(w, name);
        assert.deepStrictEqual(w.wakes, [['adventures', 2000]]);
        w.wakes.length = 0;
        w.t += w.st.BUSY_FAST_MS - 1;
        tick(w);
        assert.deepStrictEqual(w.wakes, [['adventures', 2000]]);
        w.wakes.length = 0;
        w.t += 1;
        tick(w);
        assertStep(w, name);
        assert.deepStrictEqual(w.wakes, []);
        w.t += 600000;
        tick(w);
        assert.deepStrictEqual(w.wakes, []);
    });
});

t.test('cadence: Arrive with a busy general stays on the tick', function () {
    var w = homeWorld();
    onIsland(w, [w.g1, w.g2]);
    w.g1.state.task = { type: w.code.move };
    startRun(w, [WAVE], { step: w.S.RunStep.Arrive });
    w.wakes.length = 0;
    tick(w);
    assertStep(w, 'Arrive');
    assert.deepStrictEqual(w.wakes, []);
});

t.test('cadence: Muster, Arrive, Clear and ArriveHome wait long, a short step does not', function () {
    var w = homeWorld();
    var cases = [
        [w.S.RunStep.Muster, 'home', false],
        [w.S.RunStep.ArriveHome, 'home', false],
        [w.S.RunStep.Arrive, 'away', false],
        [w.S.RunStep.Clear, 'away', false],
        [w.S.RunStep.Depart, 'home', true],
        [w.S.RunStep.PackStar, 'away', true]
    ];
    cases.forEach(function (c) {
        startRun(w, [WAVE], { step: c[0] });
        quietPart(w, c[1]);
        planOnce(w);
        assert.deepStrictEqual(w.wakes, c[2] ? [['adventures', 2000]] : [], c[0]);
    });
});

t.test('cadence: a blocker stops the chain, whatever the step', function () {
    var w = homeWorld();
    var r = startRun(w, [WAVE], { step: w.S.RunStep.Supply });
    quietPart(w, 'home');
    planOnce(w);
    assert.deepStrictEqual(w.wakes, [['adventures', 2000]]);
    r.blocker = { key: '', general: null, target: null, reason: 'waiting for production' };
    planOnce(w);
    assert.deepStrictEqual(w.wakes, []);
});

t.test('cadence: Settle on a blocker polls on the tick', function () {
    var w = islandWorld();
    w.g2.state.grid = 55;
    w.sent.placeable = 3;
    startRun(w, [WAVE], { step: w.S.WaveStep.Position });
    w.wakes.length = 0;
    tick(w);
    assertStep(w, 'Settle');
    assert.deepStrictEqual(w.wakes, [['adventures', 0]]);
    w.wakes.length = 0;
    tick(w);
    assertStep(w, 'Settle');
    assert.deepStrictEqual(w.wakes, []);
});

t.test('cadence: a paused or done run, and a pause inside the pass wake nothing', function () {
    var w = islandWorld();
    startRun(w, [WAVE], { step: w.S.WaveStep.Gate });
    w.S.modules.adventures.executor.plan = function () { w.st.pause(w.S.RunPause.User, 'x'); };
    planOnce(w);
    assert.deepStrictEqual(w.wakes, []);

    w.st.resume();
    quietPart(w, 'executor');
    w.S.modules.adventures.run.pause();
    planOnce(w);
    assert.deepStrictEqual(w.wakes, []);

    w.st.done();
    quietPart(w, 'executor');
    planOnce(w);
    assert.deepStrictEqual(w.wakes, []);
});

t.test('cadence: no run and a wrong zone start no chain', function () {
    var w = islandWorld();
    planOnce(w);
    assert.deepStrictEqual(w.wakes, []);
    var h = homeWorld();
    startRun(h, [WAVE], { step: h.S.WaveStep.Gate });
    h.wakes.length = 0;
    assert.strictEqual(tick(h), false);
    assert.deepStrictEqual(h.wakes, []);
});

// ---- Start, Resume and Pause ------------------------------------------------

t.test('wake: Start on the island, Start at home and Resume wake once; Pause does not', function () {
    var w = islandWorld();
    var id = template(w);
    var run = w.S.modules.adventures.run;
    w.wakes.length = 0;
    assert.strictEqual(run.start(id), true);
    assert.deepStrictEqual(w.wakes, [['adventures', 0]]);

    w.wakes.length = 0;
    assert.strictEqual(run.pause(), true);
    assert.deepStrictEqual(w.wakes, []);
    assert.strictEqual(run.resume(), true);
    assert.deepStrictEqual(w.wakes, [['adventures', 0]]);

    var h = homeWorld();
    var hid = template(h);
    h.wakes.length = 0;
    assert.strictEqual(h.S.modules.adventures.run.start(hid), true);
    assert.strictEqual(h.st.run().step, h.S.RunStep.Muster);
    assert.deepStrictEqual(h.wakes, [['adventures', 0]]);
});

// ---- settleRound ------------------------------------------------------------

function verifiedRound(w, step) {
    var r = w.st.run();
    var round = ld(w).startRound(r, step, ['1.1']);
    round.results['1.1'] = { status: w.S.ActionResult.Verified, reason: '' };
    round.doneAt = w.t;
    return round;
}

t.test('settleRound: a verified round without effect waits inside the hold, then counts', function () {
    var w = islandWorld();
    var r = startRun(w, [WAVE], { step: w.S.WaveStep.Position });
    verifiedRound(w, w.S.WaveStep.Position);
    var failed = 0;
    var onFail = function () { failed++; };
    assert.strictEqual(ld(w).settleRound(r, w.S.WaveStep.Position, onFail, 'x'), 'wait');
    assert.strictEqual(r.rounds, 0);
    w.t += lag(w) - 1;
    assert.strictEqual(ld(w).settleRound(r, w.S.WaveStep.Position, onFail, 'x'), 'wait');
    w.t += 1;
    assert.strictEqual(ld(w).settleRound(r, w.S.WaveStep.Position, onFail, 'x'), 'new');
    assert.strictEqual(r.rounds, 1);
    assert.strictEqual(failed, 0);
});

t.test('settleRound: a failed round pauses at once', function () {
    var w = islandWorld();
    var r = startRun(w, [WAVE], { step: w.S.WaveStep.Position });
    var round = verifiedRound(w, w.S.WaveStep.Position);
    round.results['1.1'] = { status: w.S.ActionResult.Failed, reason: 'refused' };
    var failed = 0;
    assert.strictEqual(ld(w).settleRound(r, w.S.WaveStep.Position, function () { failed++; }, 'x'), 'paused');
    assert.strictEqual(failed, 1);
    assert.strictEqual(r.rounds, 1);
});

// ---- verify -----------------------------------------------------------------

t.test('verify: a mismatch inside the hold neither retries nor counts, a failed round holds too', function () {
    [false, true].forEach(function (failedRound) {
        var w = islandWorld();
        w.auto.raise = false;
        w.g2.state.army = { Rifle: 1 };
        var r = startRun(w, [WAVE], { step: w.S.WaveStep.Load });
        tick(w);
        play(w);
        if (failedRound) {
            var round = w.st.current().round;
            round.results['1.2'] = { status: w.S.ActionResult.Failed, reason: 'refused' };
        }
        tick(w);
        assert.strictEqual(stepName(w), 'Verify');
        assert.strictEqual(r.rounds, 0);
        assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
        w.t += lag(w);
        tick(w);
        assert.strictEqual(stepName(w), 'Load');
        assert.strictEqual(r.rounds, 1);
    });
});

// ---- supply -----------------------------------------------------------------

t.test('supply: TroopsShort only after the hold', function () {
    var w = islandWorld();
    w.free = { Rifle: 1 };
    w.g2.state.army = {};
    startRun(w, [WAVE], { step: w.S.WaveStep.Supply });
    tick(w);
    assertStep(w, 'Supply');
    w.t += lag(w) - 1;
    tick(w);
    assertStep(w, 'Supply');
    w.t += 1;
    tick(w);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Paused);
    assert.strictEqual(w.st.run().pause.reason, w.S.RunPause.TroopsShort);
});

t.test('supply: a further donor waits for the hold after an unload, the first goes at once', function () {
    var donor = AC.general({ uid: '1.4', name: 'Dora', grid: 40, army: { Rifle: 6 } });
    var w = islandWorld([donor]);
    w.free = {};
    w.g2.state.army = {};
    var r = startRun(w, [WAVE], { step: w.S.WaveStep.Supply });
    r.cycles = 1;
    tick(w);
    assertStep(w, 'Supply');
    assert.strictEqual(r.cycles, 1);
    w.t += lag(w);
    tick(w);
    assertStep(w, 'Unload');
    assert.strictEqual(r.cycles, 2);

    var f = islandWorld([AC.general({ uid: '1.4', name: 'Dora', grid: 40, army: { Rifle: 6 } })]);
    f.free = {};
    f.g2.state.army = {};
    startRun(f, [WAVE], { step: f.S.WaveStep.Supply });
    tick(f);
    assertStep(f, 'Unload');
    assert.strictEqual(f.st.run().cycles, 1);
});

t.test('supply: covered goes at once', function () {
    var w = islandWorld();
    w.g2.state.army = { Rifle: 1 };
    startRun(w, [WAVE], { step: w.S.WaveStep.Supply });
    tick(w);
    assertStep(w, 'Load');
});

// ---- pack -------------------------------------------------------------------

t.test('pack: a verified round on a lagging pool sends no second raise inside the hold', function () {
    var w = packWorld(10, 20);
    var gens = [w.g1, w.g2, w.c];
    var armies = gens.map(function (g) { return JSON.stringify(g.state.army); });
    var pool = JSON.stringify(w.free);
    startRun(w, [WAVE], { step: w.S.RunStep.Pack, loadoutKeys: PACK_KEYS });
    tick(w);
    play(w);
    var sent = w.raises.length;
    assert.ok(sent > 0, 'the first round raised');
    // The raises went out and verified, but the lists still read the old troops.
    Object.keys(w.free).forEach(function (u) { delete w.free[u]; });
    var old = JSON.parse(pool);
    Object.keys(old).forEach(function (u) { w.free[u] = old[u]; });
    gens.forEach(function (g, i) { g.state.army = JSON.parse(armies[i]); });
    tick(w);
    play(w);
    assertStep(w, 'Pack');
    assert.strictEqual(w.raises.length, sent, 'nothing sent inside the hold');
    w.t += lag(w);
    tick(w);
    play(w);
    tick(w);
    play(w);
    assert.ok(w.raises.length > sent, 'a plan after the hold raises again');
});

// ---- Settle -----------------------------------------------------------------

function settleWorld(extra) {
    var w = islandWorld(extra);
    w.g2.state.grid = 55;
    w.sent.placeable = 3;
    startRun(w, [WAVE], { step: w.S.WaveStep.Position });
    tick(w);
    assertStep(w, 'Settle');
    return w;
}

t.test('Settle: pauses after 20 s of quiet and not after 10', function () {
    var w = settleWorld();
    tick(w);
    assert.strictEqual(typeof w.st.run().settledAt, 'number');
    W.ticksFor(w, 10000);
    assertStep(w, 'Settle');
    W.ticksFor(w, 10000);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Paused);
    assert.strictEqual(w.st.run().pause.reason, w.S.RunPause.NotPlaceable);
});

t.test('Settle: a battle in between restarts the quiet time', function () {
    var fighter = AC.general({ uid: '1.6', grid: 60 });
    var w = settleWorld([fighter]);
    tick(w);
    W.ticksFor(w, 10000);
    fighter.state.task = { type: w.code.attack };
    W.ticksFor(w, 10000);
    assert.strictEqual(w.st.run().settledAt, null);
    assertStep(w, 'Settle');
    fighter.state.task = null;
    tick(w);
    assert.strictEqual(w.st.run().settledAt, w.t);
    W.ticksFor(w, 10000);
    assertStep(w, 'Settle');
    W.ticksFor(w, 10000);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Paused);
});

// ---- run file ---------------------------------------------------------------

t.test('state: a run file with settled loads with settledAt null; settledAt round-trips', function () {
    var w = islandWorld();
    var r = startRun(w, [WAVE], { step: w.S.WaveStep.Settle });
    r.settledAt = 123456;
    w.st.save();
    var w2 = W.world({ fs: w.fs });
    w2.mod.boot();
    assert.strictEqual(w2.st.run().settledAt, 123456);

    var data = JSON.parse(w.fs.disk[RUN_FILE]);
    delete data.run.settledAt;
    data.run.settled = 1;
    w.fs.disk[RUN_FILE] = JSON.stringify(data);
    var w3 = W.world({ fs: w.fs });
    w3.mod.boot();
    assert.strictEqual(w3.st.run().settledAt, null);
    assert.ok(!Object.prototype.hasOwnProperty.call(w3.st.run(), 'settled'));
});

// ---- bar menu ---------------------------------------------------------------

t.test('runmenu: visible per status', function () {
    var w = islandWorld();
    var rm = w.S.modules.adventures.runmenu;
    assert.strictEqual(rm.visible(), false);
    startRun(w, [WAVE], { step: w.S.WaveStep.Gate });
    assert.strictEqual(rm.visible(), true);
    w.st.pause(w.S.RunPause.User, 'x');
    assert.strictEqual(rm.visible(), true);
    w.st.resume();
    w.st.done();
    assert.strictEqual(rm.visible(), false);
    w.st.clear();
    assert.strictEqual(rm.visible(), false);
});

t.test('runmenu: Done hides without a rebuild, the next map of a series neither rebuilds nor moves the entry', function () {
    var w = homeWorld();
    var rebuilds = [];
    var shown = [];
    w.S.kernel.ui = w.S.kernel.ui || {};
    w.S.kernel.ui.refreshBarMenu = function (id) { rebuilds.push(id); return true; };
    w.S.kernel.ui.showBarMenu = function (id, show) { shown.push(show); return true; };
    var req = { templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights', count: 2, ended: false,
        requested: w.t, finished: 0, closedAt: null };
    var mk = function (id) {
        return w.st.newRun({
            id: id, templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights', zoneId: null,
            paths: [WAVE], loadoutPath: LOADOUT, loadoutKeys: {}, step: w.S.RunStep.Muster
        });
    };
    w.st.begin(req, mk(42));
    assert.strictEqual(rebuilds.length, 1);
    assert.deepStrictEqual(shown, [true]);
    w.S.modules.adventures.runmenu.items();

    req.finished = 1;
    w.st.begin(req, mk(43));
    assert.strictEqual(rebuilds.length, 1, 'no rebuild');
    assert.ok(shown.every(function (s) { return s === true; }), 'entry stays in the bar');

    shown.length = 0;
    w.st.done();
    assert.strictEqual(rebuilds.length, 1, 'no rebuild on Done');
    assert.strictEqual(shown[shown.length - 1], false);
});

t.test('runmenu: a saved Running run reads visible after a boot', function () {
    var w = islandWorld();
    startRun(w, [WAVE], { step: w.S.WaveStep.Gate });
    w.st.save();
    var w2 = W.world({ fs: w.fs });
    w2.mod.boot();
    assert.strictEqual(w2.S.modules.adventures.runmenu.visible(), true);
});
