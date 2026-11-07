'use strict';

// Wave executor of the adventures module: run state file, executor steps,
// attack pacer, quest watcher, start command and scheduler wiring. The world
// (tests/stubs/adventures.js) applies the effect of each order the way the
// client would, and play() runs the queued entries with a test clock. After
// the last wave the run hands over to the end of the map (RunStep.PackStar),
// which these tests stop at.

var t = require('../runner');
var harness = require('../harness');
var A = require('../stubs/army');
var AC = require('../stubs/actions');
var W = require('../stubs/adventures');

var assert = t.assert;

var ZONE = W.ZONE;
var RUN_FILE = W.RUN_FILE;
var LOADOUT = W.LOADOUT;

var plain = W.plain;
var writeJson = W.writeJson;
var patchCore = W.patchCore;
var world = W.world;
var drain = W.drain;
var tick = W.tick;
var play = W.play;
var runOut = W.runOut;
var startRun = W.startRun;
var stepName = W.stepName;

// The last wave is confirmed: the run goes on to the end of the map.
function assertHandedOver(w) {
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Running, 'status ' + r.status);
    assert.strictEqual(r.step, w.S.RunStep.PackStar, 'step ' + stepName(w));
}

function attacksOf(w, key) {
    return w.orders.filter(function (o) { return o.code === w.code.attack && (!key || o.key === key); });
}

// Two attack lines (the second 5 s after the first), a buff 2 s after that.
function attackWorld(o) {
    o = o || {};
    var g1 = AC.general({ uid: '1.1', name: 'Anna', grid: 10, army: { Rifle: 5 } });
    var g2 = AC.general({ uid: '1.2', name: 'Bert', grid: 20, army: { Rifle: 3 } });
    var w = world({ generals: [g1, g2].concat(o.extra || []) });
    var wave = {
        '1.1': { grid: 10, target: 100, army: { Rifle: 5 }, order: 1, name: 'Anna' },
        '1.2': { grid: 20, target: 200, army: { Rifle: 3 }, order: 2, time: 5000, name: 'Bert' },
        buff_fire: { type: 'buff', name: 'Fire', target: 300, order: 3, time: 2000 }
    };
    writeJson(w.fs, 'C:/b/w1.txt', wave);
    writeJson(w.fs, 'C:/b/w2.txt', wave);
    w.g1 = g1;
    w.g2 = g2;
    return w;
}

// ---- state ------------------------------------------------------------------

t.test('state: a run round-trips through a fresh boot on the same disk', function () {
    var w = attackWorld();
    var r = startRun(w, ['C:/b/w1.txt', 'C:/b/w2.txt'], { waveIndex: 1, step: w.S.WaveStep.Load });
    r.lines['1.1'] = { sentAt: 5, seen: true, sentOnce: true };
    w.st.save();
    var before = plain(r);

    var w2 = world({ fs: w.fs });
    assert.strictEqual(w2.st.run(), null);
    w2.mod.boot();
    assert.deepStrictEqual(plain(w2.st.run()), before);
    assert.strictEqual(w2.st.current().request.label, 'Black Knights');
    assert.strictEqual(w2.st.current().loaded, true);
});

t.test('state: clear() writes run null and request null with no stale keys', function () {
    var w = attackWorld();
    startRun(w, ['C:/b/w1.txt']);
    w.st.clear();
    var data = JSON.parse(w.fs.disk[RUN_FILE]);
    assert.deepStrictEqual(Object.keys(data).sort(), ['request', 'run', 'version']);
    assert.strictEqual(data.run, null);
    assert.strictEqual(data.request, null);
    assert.strictEqual(data.version, w.st.FILE_VERSION);
});

t.test('state: an unknown step loads as Gate', function () {
    var w = attackWorld();
    var r = startRun(w, ['C:/b/w1.txt']);
    r.step = 'WaveBogus';
    w.st.save();
    var w2 = world({ fs: w.fs });
    w2.st.load();
    assert.strictEqual(w2.st.run().step, w2.S.WaveStep.Gate);
    assert.strictEqual(w2.st.run().status, w2.S.RunStatus.Running);
});

t.test('state: status text for Running, Paused and Done', function () {
    var w = attackWorld();
    startRun(w, ['C:/b/w1.txt', 'C:/b/w2.txt'], { step: w.S.WaveStep.Supply });
    assert.strictEqual(w.st.status(), 'Running: Black Knights, run 1/1, wave 1/2, Supply');
    w.st.pause(w.S.RunPause.User, 'paused by you');
    assert.strictEqual(w.st.status(), 'Paused: Black Knights, run 1/1, wave 1/2, Supply: paused by you');
    w.st.resume();
    w.st.current().request.count = 3;
    w.st.current().request.finished = 1;
    w.st.go(w.S.RunStep.Clear, 'test');
    assert.strictEqual(w.st.status(), 'Running: Black Knights, run 2/3, Clear');
    w.st.current().request.finished = 3;
    w.st.done();
    assert.strictEqual(w.st.status(), 'Done: Black Knights, 3 run(s)');
    w.st.clear();
    assert.strictEqual(w.st.status(), 'No run requested');
});

t.test('state: a run file without loadoutKeys loads Paused WaveFile', function () {
    var w = attackWorld();
    var r = startRun(w, ['C:/b/w1.txt']);
    delete r.loadoutKeys;
    w.st.save();
    var w2 = world({ fs: w.fs });
    w2.st.load();
    var r2 = w2.st.run();
    assert.strictEqual(r2.status, w2.S.RunStatus.Paused);
    assert.strictEqual(r2.pause.reason, w2.S.RunPause.WaveFile);
    assert.ok(/no loadout keys/.test(r2.pause.message), r2.pause.message);
});

t.test('state: loadoutKeys survive a restart; a wave key outside them then pauses WaveFile', function () {
    var w = attackWorld();
    var keys = { '1.1': true, '1.2': true };
    startRun(w, ['C:/b/w1.txt', 'C:/b/w3.txt'], { loadoutKeys: keys });
    writeJson(w.fs, 'C:/b/w3.txt', { '1.9': { grid: 10, target: 100, army: { Rifle: 1 }, order: 1 } });

    var w2 = world({ fs: w.fs, generals: [w.g1, w.g2] });
    w2.mod.boot();
    assert.deepStrictEqual(plain(w2.st.run().loadoutKeys), keys);
    w2.st.run().waveIndex = 1;
    tick(w2);
    var r = w2.st.run();
    assert.strictEqual(r.status, w2.S.RunStatus.Paused);
    assert.strictEqual(r.pause.reason, w2.S.RunPause.WaveFile);
    assert.ok(/1\.9/.test(r.pause.message) && /not in the loadout/.test(r.pause.message), r.pause.message);
});

t.test('state: an existing { request: null } runState gains run: null', function () {
    var w = attackWorld();
    w.S.modules.adventures.runState = { request: null };
    var H2 = harness.reload(w.H);
    var rs = H2.Steward.modules.adventures.runState;
    assert.ok(Object.prototype.hasOwnProperty.call(rs, 'run'));
    assert.strictEqual(rs.run, null);
    assert.strictEqual(rs.request, null);
});

t.test('state: every newRun field survives a fresh boot', function () {
    var w = attackWorld();
    var r = startRun(w, ['C:/b/w1.txt', 'C:/b/w2.txt'], { waveIndex: 1 });
    var w2 = world({ fs: w.fs });
    w2.mod.boot();
    var loaded = w2.st.run();
    assert.deepStrictEqual(Object.keys(loaded).sort(), Object.keys(w2.st.newRun()).sort());
    assert.deepStrictEqual(plain(loaded), plain(r));
    assert.strictEqual(loaded.templateId, 't1');
    assert.strictEqual(loaded.loadoutPath, LOADOUT);
    assert.deepStrictEqual(plain(loaded.paths), ['C:/b/w1.txt', 'C:/b/w2.txt']);
    assert.strictEqual(loaded.waveIndex, 1);
});

t.test('state: the retrain key of a run file is ignored on load (no retrain field)', function () {
    var w = attackWorld();
    startRun(w, ['C:/b/w1.txt']);
    w.st.save();
    assert.ok(!Object.prototype.hasOwnProperty.call(JSON.parse(w.fs.disk[RUN_FILE]).run, 'retrain'));
    var data = JSON.parse(w.fs.disk[RUN_FILE]);
    data.run.retrain = false;
    writeJson(w.fs, RUN_FILE, data);
    var w2 = world({ fs: w.fs });
    w2.mod.boot();
    assert.ok(w2.st.run());
    assert.ok(!Object.prototype.hasOwnProperty.call(w2.st.run(), 'retrain'));
});

t.test('state: transit and transitBase round-trip through the run file; malformed entries drop', function () {
    var w = attackWorld();
    var r = startRun(w, ['C:/b/w1.txt']);
    var until = w.st.now() + 1000000;
    r.transit = [{ from: 3, army: { Rifle: 8 }, until: until }];
    r.transitBase = { Rifle: 10 };
    w.st.save();
    var w2 = world({ fs: w.fs });
    w2.mod.boot();
    assert.deepStrictEqual(plain(w2.st.run().transit), [{ from: 3, army: { Rifle: 8 }, until: until }]);
    assert.deepStrictEqual(plain(w2.st.run().transitBase), { Rifle: 10 });
    var data = JSON.parse(w.fs.disk[RUN_FILE]);
    data.run.transit = [
        { from: 3, army: { Rifle: 8 }, until: until },
        { from: 'x', army: { Rifle: 1 }, until: until },
        { from: 4, army: { Rifle: 1 }, until: 'soon' },
        { from: 5, army: null, until: until },
        null, 7
    ];
    data.run.transitBase = 'bad';
    writeJson(w.fs, RUN_FILE, data);
    var w3 = world({ fs: w.fs });
    w3.mod.boot();
    assert.strictEqual(w3.st.run().transit.length, 1);
    assert.strictEqual(w3.st.run().transit[0].from, 3);
    assert.strictEqual(w3.st.run().transitBase, null);
    data.run.transit = 'bad';
    writeJson(w.fs, RUN_FILE, data);
    var w4 = world({ fs: w.fs });
    w4.mod.boot();
    assert.deepStrictEqual(plain(w4.st.run().transit), []);
});

t.test('state: a 0.6.0 run file loads Running at its step with the new fields defaulted', function () {
    var fs = world().fs;
    writeJson(fs, RUN_FILE, {
        version: 1,
        request: { templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights', count: 2, ended: false, requested: 5 },
        run: {
            id: 42, templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights', zoneId: ZONE,
            paths: ['C:/b/w1.txt'], loadoutPath: LOADOUT, loadoutKeys: { '1.1': true }, waveIndex: 0,
            step: 'WaveAttack', status: 'RunRunning', since: 7, rounds: 0, cycles: 0, settleFrom: null,
            settled: 1, blocker: null, donors: [], lines: { '1.1': { sentAt: 9, seen: true, sentOnce: true } },
            pause: null
        }
    });
    var w = world({ fs: fs });
    w.mod.boot();
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Running);
    assert.strictEqual(r.step, w.S.WaveStep.Attack);
    assert.strictEqual(r.zoneId, ZONE);
    assert.deepStrictEqual(plain(r.lines['1.1']), { sentAt: 9, seen: true, sentOnce: true });
    assert.strictEqual(r.speedBuff, '');
    assert.strictEqual(r.snapshot, null);
    assert.deepStrictEqual(plain(r.marks), {});
    assert.strictEqual(r.waitUntil, null);
    assert.strictEqual(r.popBase, null);
    var q = w.st.current().request;
    assert.strictEqual(q.count, 2);
    assert.strictEqual(q.finished, 0);
    assert.strictEqual(q.closedAt, null);
    assert.strictEqual(w.st.status(), 'Running: Black Knights, run 1/2, wave 1/1, Attack');
});

// ---- Gate -------------------------------------------------------------------

t.test('Gate: a missing field general waits, then pauses GeneralMissing', function () {
    var w = attackWorld();
    w.fighters.splice(1, 1);                       // 1.2 not on the island
    startRun(w, ['C:/b/w1.txt'], { loadoutKeys: { '1.1': true, '1.2': true } });
    tick(w);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
    assert.strictEqual(stepName(w), 'Gate');
    W.ticksFor(w, w.ex.GATE_MISSING_MS - 1);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
    w.t += 2;
    tick(w);
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Paused);
    assert.strictEqual(r.pause.reason, w.S.RunPause.GeneralMissing);
    assert.ok(/1\.2/.test(r.pause.general), r.pause.general);
    assert.strictEqual(r.pause.target, 200);
    assert.strictEqual(w.orders.length, 0);
});

t.test('Gate: a Star line whose general is absent does not block Gate', function () {
    var w = attackWorld();
    writeJson(w.fs, 'C:/b/s1.txt', {
        '1.1': { grid: 10, target: 100, army: { Rifle: 5 }, order: 1 },
        '1.3': { grid: 0, army: {}, order: 2 }
    });
    startRun(w, ['C:/b/s1.txt'], { loadoutKeys: { '1.1': true, '1.3': true } });
    tick(w);
    assert.strictEqual(stepName(w), 'Position');
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
});

t.test('Gate: a busy field general waits with no limit', function () {
    var w = attackWorld();
    w.g1.state.task = { type: w.code.attack };
    startRun(w, ['C:/b/w1.txt']);
    tick(w);
    w.t += 3600000;
    tick(w);
    assert.strictEqual(stepName(w), 'Gate');
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
    w.g1.state.task = null;
    tick(w);
    assert.strictEqual(stepName(w), 'Position');
});

// ---- Position ---------------------------------------------------------------

t.test('Position: only off-grid field lines get a move', function () {
    var w = attackWorld();
    w.g2.state.grid = 55;
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Position });
    tick(w);
    play(w);
    var moves = w.orders.filter(function (o) { return o.code === w.code.move; });
    assert.deepStrictEqual(moves.map(function (o) { return [o.key, o.grid]; }), [['1.2', 20]]);
    tick(w);
    assert.strictEqual(stepName(w), 'Supply');
});

t.test('Position: a general on its grid that is not idle yet holds the step; idle goes to Supply', function () {
    var w = attackWorld();
    w.g1.state.inUse = true;                       // shows the new grid while still walking
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Position });
    tick(w);
    play(w);
    tick(w);
    assert.strictEqual(stepName(w), 'Position');
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
    assert.strictEqual(w.orders.length, 0);
    w.g1.state.inUse = false;
    tick(w);
    assert.strictEqual(stepName(w), 'Supply');
});

t.test('Position: not placeable goes to Settle without a send, quiet for SETTLE_QUIET_MS pauses NotPlaceable', function () {
    var w = attackWorld();
    w.g2.state.grid = 55;
    w.sent.placeable = 3;
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Position });
    tick(w);
    var r = w.st.run();
    assert.strictEqual(stepName(w), 'Settle');
    assert.strictEqual(r.settleFrom, w.S.WaveStep.Position);
    assert.strictEqual(r.blocker.key, '1.2');
    assert.strictEqual(w.H.queued().length + w.pending.length, 0);
    tick(w);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
    assert.strictEqual(w.st.run().settledAt, w.t);
    W.ticksFor(w, 20000);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running, 'the old 20 s limit is gone');
    W.ticksFor(w, w.ex.SETTLE_QUIET_MS - 30000);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
    W.ticksFor(w, 20000);
    r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Paused);
    assert.strictEqual(r.pause.reason, w.S.RunPause.NotPlaceable);
    assert.strictEqual(r.pause.target, 20);
    assert.strictEqual(w.orders.length, 0);
});

t.test('Position: a star general that leaves the list is done; Resume passes Gate and Position without a send', function () {
    var w = attackWorld();
    var g3 = AC.general({ uid: '1.3', name: 'Cleo', grid: 30 });
    w.fighters.push(g3);
    writeJson(w.fs, 'C:/b/s1.txt', {
        '1.1': { grid: 10, target: 100, army: { Rifle: 5 }, order: 1 },
        '1.3': { grid: 0, army: {}, order: 2 }
    });
    startRun(w, ['C:/b/s1.txt'], { step: w.S.WaveStep.Position });
    tick(w);
    play(w);
    var stars = w.orders.filter(function (o) { return o.code === w.code.star; });
    assert.deepStrictEqual(stars.map(function (o) { return o.key; }), ['1.3']);
    assert.strictEqual(w.byKey('1.3'), null);
    tick(w);
    assert.strictEqual(stepName(w), 'Supply');
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);

    w.S.modules.adventures.run.pause();
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Paused);
    w.S.modules.adventures.run.resume();
    assert.strictEqual(stepName(w), 'Gate');
    var sends = w.orders.length;
    tick(w);
    play(w);
    assert.strictEqual(stepName(w), 'Position');
    tick(w);
    play(w);
    assert.strictEqual(stepName(w), 'Supply');
    assert.strictEqual(w.orders.length, sends);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
});

t.test('Position: a walking general waits with no limit', function () {
    var w = attackWorld();
    w.g2.state.grid = 55;
    w.auto.walk = true;
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Position });
    tick(w);
    play(w);
    tick(w);
    w.t += 3600000;
    tick(w);
    assert.strictEqual(stepName(w), 'Position');
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
    assert.ok(logged(w, /Bert \(1\.2\) walking to its grid/), 'the wait is logged');
    w.endWalks();
    tick(w);
    assert.strictEqual(stepName(w), 'Supply');
    assert.deepStrictEqual(moveText(w), ['1.2->20']);
});

// ---- Position from the star -------------------------------------------------

// Anna and Bert at the star. grids: the map's landing fields.
function starWorld(grids) {
    var w = attackWorld();
    w.g1.state.grid = 0;
    w.g2.state.grid = 0;
    if (grids) w.landing(grids);
    return w;
}

function moveText(w) {
    return w.orders.filter(function (o) { return o.code === w.code.move; })
        .map(function (o) { return o.key + '->' + o.grid; });
}

function starsOf(w) {
    return w.orders.filter(function (o) { return o.code === w.code.star; }).map(function (o) { return o.key; });
}

function logged(w, re) {
    return w.H.logs().some(function (l) { return re.test(l.args.join(' ')); });
}

function settled(w) {
    return logged(w, /-> Settle/);
}

// Passes, with the time a read may lag in between, until the run left
// Position. between runs after each pass.
function throughPosition(w, between) {
    var lag = w.S.modules.adventures.loader.READ_LAG_MS;
    for (var i = 0; i < 12 && stepName(w) === 'Position' && w.st.run().status === w.S.RunStatus.Running; i++) {
        tick(w);
        play(w);
        if (between) between();
        w.t += lag;
    }
}

function assertSupply(w) {
    var r = w.st.run();
    assert.strictEqual(stepName(w), 'Supply', 'step ' + stepName(w) + (r.pause ? ' (' + r.pause.message + ')' : ''));
    assert.strictEqual(r.status, w.S.RunStatus.Running);
}

// Pauses once the island has been quiet long enough.
function assertNotPlaceable(w, re) {
    W.ticksFor(w, w.ex.SETTLE_QUIET_MS - 30000);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running, 'still waiting just before the quiet time');
    W.ticksFor(w, 60000);
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Paused, 'status ' + r.status + ' at ' + stepName(w));
    assert.strictEqual(r.pause.reason, w.S.RunPause.NotPlaceable, r.pause.reason + ': ' + r.pause.message);
    assert.ok(re.test(r.pause.message), r.pause.message);
}

[false, true].forEach(function (walk) {
    t.test('Position: a star general reaches its line grid through a landing field' + (walk ? ', walking' : ''), function () {
        var w = starWorld([500, 501]);
        w.auto.walk = walk;
        startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Position });
        throughPosition(w, function () {
            if (!w.g1.state.task) return;
            tick(w);
            assert.strictEqual(stepName(w), 'Position');
            w.endWalks();
        });
        assertSupply(w);
        assert.deepStrictEqual(moveText(w), ['1.1->500', '1.2->501', '1.1->10', '1.2->20']);
        assert.ok(!settled(w), 'no Settle');
        assert.ok(logged(w, /2 hop\(s\): 1\.1 -> 500, 1\.2 -> 501 \(landing fields 500, 501\)/), 'the hop names the fields');
        assert.ok(logged(w, /Position -> Position \(on the landing field\)/));
    });
});

t.test('Position: a line grid that is a free landing field moves directly', function () {
    var w = starWorld([10, 20]);
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Position });
    throughPosition(w);
    assertSupply(w);
    assert.deepStrictEqual(moveText(w), ['1.1->10', '1.2->20']);
    assert.ok(!logged(w, /hop\(s\)/), 'no hop');
});

t.test('Position: a hop never takes a landing field another line needs', function () {
    var w = starWorld([20, 500]);
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Position });
    throughPosition(w);
    assertSupply(w);
    assert.deepStrictEqual(moveText(w), ['1.2->20', '1.1->500', '1.1->10']);
});

t.test('Position: fewer landing fields than star generals ends without a rounds pause', function () {
    var w = starWorld([500]);
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Position });
    throughPosition(w);
    assertSupply(w);
    assert.deepStrictEqual(moveText(w), ['1.1->500', '1.1->10', '1.2->500', '1.2->20']);
    assert.ok(!settled(w), 'no Settle');
});

t.test('Position: no free landing field at all goes to Settle and pauses NotPlaceable', function () {
    var w = starWorld();
    var wakes = [];
    w.S.kernel.scheduler.wake = function (id, ms) { wakes.push(ms); return true; };
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Position });
    tick(w);
    assert.strictEqual(stepName(w), 'Settle');
    assert.strictEqual(w.st.run().blocker.reason, 'no free landing field');
    wakes.length = 0;
    tick(w);
    assert.strictEqual(stepName(w), 'Settle');
    assertNotPlaceable(w, /no free landing field/);
    assert.ok(wakes.indexOf(0) < 0, 'no wake at 0: ' + wakes.join());
    assert.strictEqual(w.H.logs().filter(function (l) { return /-> Settle/.test(l.args.join(' ')); }).length, 1, 'no spin');
    assert.strictEqual(w.orders.length, 0);
});

t.test('Position: a failed hop pauses PositionFailed', function () {
    var w = starWorld([500, 501]);
    w.auto.move = false;
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Position });
    runOut(w, 20);
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Paused, 'status ' + r.status);
    assert.strictEqual(r.pause.reason, w.S.RunPause.PositionFailed, r.pause.reason + ': ' + r.pause.message);
    assert.ok(!settled(w), 'no Settle');
});

t.test('Position: a hop not shown on the map stays bounded: the last round waits ORDER_WAIT_MS, then pauses', function () {
    var w = starWorld([500, 501]);
    w.auto.walk = true;
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Position });
    for (var i = 0; i < 2; i++) {
        tick(w);
        play(w);
        // The move verified, but both still read at the star, idle.
        w.g1.state.task = null;
        w.g2.state.task = null;
        w.t += w.S.modules.adventures.loader.READ_LAG_MS;
    }
    tick(w);
    var wait = ldr(w).ORDER_WAIT_MS;
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Running, 'the last round waits for its effect, status ' + r.status);
    assert.ok(/positioning sent, waiting to see it/.test(w.st.current().busy.text), w.st.current().busy.text);
    W.ticksFor(w, wait - 30000);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running, 'still waiting just before ORDER_WAIT_MS');
    W.ticksFor(w, 60000);
    r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Paused, 'status ' + r.status);
    assert.strictEqual(r.pause.reason, w.S.RunPause.NotObserved, r.pause.reason + ': ' + r.pause.message);
    assert.ok(/positioning verified but not observed after 2 rounds/.test(r.pause.message), r.pause.message);
    assert.deepStrictEqual(moveText(w), ['1.1->500', '1.2->501', '1.1->500', '1.2->501']);
    assert.ok(!settled(w), 'no Settle');
});

t.test('Position: a general on the map whose line is a free landing field is starred, then placed', function () {
    var w = attackWorld();
    w.auto.starKeep = true;
    w.g2.state.grid = 55;
    w.landing([20]);
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Position });
    throughPosition(w);
    assertSupply(w);
    assert.deepStrictEqual(starsOf(w), ['1.2']);
    assert.deepStrictEqual(moveText(w), ['1.2->20']);
    assert.strictEqual(w.g2.state.grid, 20);
});

t.test('Position: that retreat onto a field that still refuses pauses NotPlaceable and sends one star only', function () {
    var w = attackWorld();
    w.auto.starKeep = true;
    w.g2.state.grid = 55;
    w.landing([20]);
    w.blocked[20] = true;
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Position });
    throughPosition(w);
    assert.strictEqual(stepName(w), 'Settle');
    assertNotPlaceable(w, /not placeable at 20 \(code 1\)/);
    assert.deepStrictEqual(starsOf(w), ['1.2']);
    assert.deepStrictEqual(moveText(w), []);
});

t.test('Position: a landing line grid an own fighter stands on is blocked, no star', function () {
    var g3 = AC.general({ uid: '1.3', name: 'Cleo', grid: 20 });
    var w = attackWorld({ extra: [g3] });
    w.g2.state.grid = 55;
    w.landing([20]);
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Position });
    tick(w);
    assert.strictEqual(stepName(w), 'Settle');
    assert.deepStrictEqual(starsOf(w), []);
    assert.ok(/not placeable at 20/.test(w.st.run().blocker.reason), w.st.run().blocker.reason);
});

t.test('Position: a garrisoned general refused off a landing field keeps the code in the reason', function () {
    var w = attackWorld();
    w.g2.state.grid = 55;
    w.sent.placeable = 3;
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Position });
    tick(w);
    assert.strictEqual(stepName(w), 'Settle');
    assert.ok(/code 3/.test(w.st.run().blocker.reason), w.st.run().blocker.reason);
});

// ---- Position on swaps and rings --------------------------------------------

// Anna and Bert stand on each other's line grid. The client refuses a grid
// an own fighter stands on, so a straight move is impossible.
[false, true].forEach(function (walk) {
    t.test('Position: a swap sends one general to the star, then both reach their grids' + (walk ? ', walking' : ''), function () {
        var w = attackWorld();
        w.auto.taken = true;
        w.auto.starKeep = true;
        w.auto.walk = walk;
        w.g1.state.grid = 20;
        w.g2.state.grid = 10;
        w.landing([500]);
        startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Position });
        throughPosition(w, walk ? function () { w.endWalks(); } : null);
        assertSupply(w);
        assert.deepStrictEqual(starsOf(w), ['1.1']);
        assert.deepStrictEqual(moveText(w), ['1.2->20', '1.1->500', '1.1->10']);
        assert.ok(!settled(w), 'no Settle');
        assert.strictEqual(w.g1.state.grid, 10);
        assert.strictEqual(w.g2.state.grid, 20);
    });
});

t.test('Position: a ring of three sends one general to the star and settles all of them', function () {
    var g3 = AC.general({ uid: '1.3', name: 'Cleo', grid: 20, army: { Rifle: 2 } });
    var w = attackWorld({ extra: [g3] });
    writeJson(w.fs, 'C:/b/w1.txt', {
        '1.1': { grid: 10, target: 100, army: { Rifle: 5 }, order: 1, name: 'Anna' },
        '1.2': { grid: 20, target: 200, army: { Rifle: 3 }, order: 2, name: 'Bert' },
        '1.3': { grid: 30, target: 300, army: { Rifle: 2 }, order: 3, name: 'Cleo' }
    });
    w.auto.taken = true;
    w.auto.starKeep = true;
    w.landing([500]);
    w.g1.state.grid = 30;
    w.g2.state.grid = 10;
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Position });
    throughPosition(w);
    assertSupply(w);
    assert.deepStrictEqual(starsOf(w), ['1.1']);
    assert.ok(!settled(w), 'no Settle');
    assert.strictEqual(w.g1.state.grid, 10);
    assert.strictEqual(w.g2.state.grid, 20);
    assert.strictEqual(g3.state.grid, 30);
});

t.test('Position: a line whose target is held by a general leaving it waits and needs no star', function () {
    var w = attackWorld();
    w.auto.taken = true;
    w.g1.state.grid = 30;
    w.g2.state.grid = 10;
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Position });
    throughPosition(w);
    assertSupply(w);
    assert.deepStrictEqual(moveText(w), ['1.2->20', '1.1->10']);
    assert.deepStrictEqual(starsOf(w), []);
    assert.ok(!settled(w), 'no Settle');
});

t.test('Position: a holder outside the wave is a real blocker; the free line still moves first', function () {
    var g3 = AC.general({ uid: '1.3', name: 'Cleo', grid: 10 });
    var w = attackWorld({ extra: [g3] });
    w.auto.taken = true;
    w.g1.state.grid = 55;
    w.g2.state.grid = 65;
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Position, loadoutKeys: { '1.1': true, '1.2': true } });
    throughPosition(w);
    assert.strictEqual(stepName(w), 'Settle');
    assert.deepStrictEqual(moveText(w), ['1.2->20']);
    assertNotPlaceable(w, /not placeable at 10/);
});

t.test('Position: a grid the client refuses with no holder pauses NotPlaceable after the free line moved', function () {
    var w = attackWorld();
    w.auto.taken = true;
    w.g1.state.grid = 55;
    w.g2.state.grid = 65;
    w.blocked[10] = true;
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Position });
    throughPosition(w);
    assert.strictEqual(stepName(w), 'Settle');
    assert.deepStrictEqual(moveText(w), ['1.2->20']);
    assertNotPlaceable(w, /not placeable at 10/);
});

t.test('Position: a Star line general standing on a line grid is sent to the star first', function () {
    var g3 = AC.general({ uid: '1.3', name: 'Cleo', grid: 10 });
    var w = attackWorld({ extra: [g3] });
    writeJson(w.fs, 'C:/b/s1.txt', {
        '1.1': { grid: 10, target: 100, army: { Rifle: 5 }, order: 1, name: 'Anna' },
        '1.3': { grid: 0, army: {}, order: 2 }
    });
    w.auto.taken = true;
    w.auto.starKeep = true;
    w.g1.state.grid = 55;
    startRun(w, ['C:/b/s1.txt'], { step: w.S.WaveStep.Position, loadoutKeys: { '1.1': true, '1.3': true } });
    throughPosition(w);
    assertSupply(w);
    assert.deepStrictEqual(starsOf(w), ['1.3']);
    assert.deepStrictEqual(moveText(w), ['1.1->10']);
    assert.ok(!settled(w), 'no Settle');
});

t.test('Gate: a recovering field general waits and is logged by name, not as a raw code', function () {
    var w = attackWorld();
    w.g1.state.task = { type: w.code.recover };
    startRun(w, ['C:/b/w1.txt']);
    tick(w);
    w.t += 3600000;
    tick(w);
    assert.strictEqual(stepName(w), 'Gate');
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
    assert.ok(logged(w, /task GeneralTaskRecovering/), 'named');
    assert.ok(!logged(w, /raw 6/), 'not raw');
});

// ---- Supply / Load ----------------------------------------------------------

t.test('Supply/Load: covered raises once per differing line and none for a matching one', function () {
    var w = attackWorld();
    w.g2.state.army = { Rifle: 1 };
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Supply });
    tick(w);
    assert.strictEqual(stepName(w), 'Load');
    tick(w);
    assert.strictEqual(stepName(w), 'Verify');
    play(w);
    assert.deepStrictEqual(w.raises, ['1.2']);
    assert.deepStrictEqual(plain(w.g2.state.army), { Rifle: 3 });
    tick(w);
    assert.strictEqual(stepName(w), 'Reach');
    assert.strictEqual(w.unloads.length, 0);
});

t.test('Supply: short with an idle donor outside the wave unloads only that donor, then Load', function () {
    var donor = AC.general({ uid: '1.4', name: 'Dora', grid: 40, army: { Rifle: 6 } });
    var useless = AC.general({ uid: '1.5', name: 'Emil', grid: 50, army: { Bow: 9 } });
    var w = attackWorld({ extra: [donor, useless] });
    w.free = {};
    w.g2.state.army = {};
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Supply });
    tick(w);
    assert.strictEqual(stepName(w), 'Unload');
    assert.deepStrictEqual(plain(w.st.run().donors), ['1.4']);
    tick(w);
    play(w);
    assert.deepStrictEqual(w.unloads, ['1.4']);
    tick(w);
    assert.strictEqual(stepName(w), 'Supply');
    tick(w);
    assert.strictEqual(stepName(w), 'Load');
    assert.deepStrictEqual(w.unloads, ['1.4']);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
});

t.test('Supply: short on the whole island pauses TroopsShort listing units, with no send', function () {
    var w = attackWorld();
    w.free = { Rifle: 1 };
    w.g2.state.army = {};
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Supply });
    tick(w);
    // A short read inside the hold may be lag: nothing is paused yet.
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
    w.t += w.S.modules.adventures.loader.READ_LAG_MS;
    tick(w);
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Paused);
    assert.strictEqual(r.pause.reason, w.S.RunPause.TroopsShort);
    assert.ok(r.pause.message.indexOf(w.S.core.army.text({ Rifle: 2 })) >= 0, r.pause.message);
    assert.strictEqual(w.raises.length + w.unloads.length + w.orders.length, 0);
    assert.strictEqual(w.pending.length, 0);
});

t.test('Verify: a mismatch twice pauses LoadMismatch', function () {
    var w = attackWorld();
    w.auto.raise = false;
    w.g2.state.army = { Rifle: 1 };
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Load });
    tick(w);
    play(w);
    // Inside the hold a mismatch neither retries nor counts.
    tick(w);
    assert.strictEqual(stepName(w), 'Verify');
    assert.strictEqual(w.st.run().rounds, 0);
    w.t += w.S.modules.adventures.loader.READ_LAG_MS;
    tick(w);
    assert.strictEqual(stepName(w), 'Load');
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
    tick(w);
    play(w);
    w.t += w.S.modules.adventures.loader.READ_LAG_MS;
    tick(w);
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Paused);
    assert.strictEqual(r.pause.reason, w.S.RunPause.LoadMismatch);
    assert.ok(/1\.2/.test(r.pause.message), r.pause.message);
    // Two rounds of one raise, each sent at most twice by the attempt runner.
    assert.ok(w.raises.length >= 2 && w.raises.length <= 4, String(w.raises.length));
});


// ---- Supply: a wave waits for troops that are still in the game --------------

function ldr(w) { return w.S.modules.adventures.loader; }

function busyOn(g, w) { g.state.task = { type: w.code.attack }; }

// A wave short by 3 Rifle on the whole island: the free pool is empty and
// Bert holds nothing. extra lists further generals; opts goes to startRun.
function shortWorld(extra, opts) {
    var w = attackWorld({ extra: extra || [] });
    w.free = {};
    w.g2.state.army = {};
    startRun(w, ['C:/b/w1.txt'], Object.assign({ step: w.S.WaveStep.Supply }, opts || {}));
    return w;
}

// Turns the stuck step limit off, for tests that watch a Supply wait past it:
// they cover the wait itself, not the zone trip it would start.
function noTrip(w) {
    w.S.kernel.settings.write('adventures', { lastDir: '', stuckMinutes: 0 });
}

function otherGeneral(uid, name, army, o) {
    return AC.general(Object.assign({ uid: uid, name: name, grid: 40, army: army }, o || {}));
}

function assertWaiting(w) {
    assertSupply(w);
    assert.ok(w.st.current().busy, 'a busy record');
    assert.strictEqual(w.raises.length + w.unloads.length + w.orders.length, 0);
}

function assertTroopsShort(w) {
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Paused, 'status ' + r.status + ' at ' + stepName(w));
    assert.strictEqual(r.pause.reason, w.S.RunPause.TroopsShort, r.pause.reason + ': ' + r.pause.message);
}

t.test('Supply: short with a busy donor waits past any window, unloads once idle', function () {
    var donor = otherGeneral('1.4', 'Dora', { Rifle: 6 });
    var w = shortWorld([donor]);
    noTrip(w);
    busyOn(donor, w);
    tick(w);
    assertWaiting(w);
    assert.ok(logged(w, /Dora \(1\.4\) busy, troops short: .*, waited /), 'the wait is logged');
    W.ticksFor(w, 4 * 3600000);
    assertWaiting(w);
    assert.ok(w.t >= 4 * 3600000 + ldr(w).READ_MAX_MS);
    donor.state.task = null;
    tick(w);
    assert.strictEqual(stepName(w), 'Unload');
    assert.ok(!logged(w, /every general idle/), 'a covering donor needs no re-arm');
    tick(w);
    play(w);
    assert.deepStrictEqual(w.unloads, ['1.4']);
    tick(w);
    assert.strictEqual(stepName(w), 'Supply');
    tick(w);
    assert.strictEqual(stepName(w), 'Load');
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
});

t.test('Supply: a busy general holding no short type still waits, then TroopsShort after the hold', function () {
    var other = otherGeneral('1.5', 'Emil', { Bow: 9 });
    var w = shortWorld([other]);
    noTrip(w);
    busyOn(other, w);
    tick(w);
    assertWaiting(w);
    W.ticksFor(w, 3 * 3600000);
    assertWaiting(w);
    other.state.task = null;
    tick(w);
    assert.ok(logged(w, /Supply -> Supply \(every general idle\)/), 'the wait ended and re-armed');
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
    tick(w);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running, 'the first idle read is inside the hold');
    w.t += ldr(w).READ_LAG_MS;
    tick(w);
    assertTroopsShort(w);
});

t.test('Supply: a busy general outside the loadout counts, a foreign one does not', function () {
    var keys = { loadoutKeys: { '1.1': true, '1.2': true } };
    var cases = [
        ['fighting', {}, function (g, w) { busyOn(g, w); }, true],
        ['travelling', { travelling: true }, function () {}, true],
        ['moving', {}, function (g, w) { g.state.task = { type: w.code.move, newGrid: 5 }; }, true],
        ['foreign', { playerId: 2 }, function (g, w) { busyOn(g, w); }, false]
    ];
    cases.forEach(function (c) {
        var x = otherGeneral('1.6', 'Frieda', {}, c[1]);
        var w = shortWorld([x], keys);
        c[2](x, w);
        tick(w);
        if (c[3]) {
            assertWaiting(w);
            assert.ok(logged(w, /Frieda \(1\.6\) busy/), c[0]);
        } else {
            assert.ok(!w.st.current().busy, c[0] + ': no wait');
            w.t += ldr(w).READ_LAG_MS;
            tick(w);
            assertTroopsShort(w);
        }
    });
});

t.test('Supply: a partial idle donor is not unloaded while a general is busy', function () {
    var part = otherGeneral('1.4', 'Dora', { Rifle: 1 });
    var other = otherGeneral('1.5', 'Emil', {});
    var w = shortWorld([part, other]);
    noTrip(w);
    busyOn(other, w);
    tick(w);
    W.ticksFor(w, 3600000);
    assertWaiting(w);
    assert.strictEqual(w.unloads.length, 0);
    assert.deepStrictEqual(plain(part.state.army), { Rifle: 1 });
    other.state.task = null;
    tick(w);
    tick(w);
    assert.strictEqual(stepName(w), 'Unload', 'with everyone idle the partial donor goes');
});

t.test('Supply: partial donors with all idle unload, then TroopsShort names the rest', function () {
    var part = otherGeneral('1.4', 'Dora', { Rifle: 1 });
    var w = shortWorld([part]);
    tick(w);
    assert.strictEqual(stepName(w), 'Unload');
    tick(w);
    play(w);
    assert.deepStrictEqual(w.unloads, ['1.4']);
    tick(w);
    assert.strictEqual(stepName(w), 'Supply');
    tick(w);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running, 'inside the read lag');
    w.t += ldr(w).READ_LAG_MS;
    tick(w);
    assertTroopsShort(w);
    assert.ok(w.st.run().pause.message.indexOf(w.S.core.army.text({ Rifle: 2 })) >= 0, w.st.run().pause.message);
});

t.test('Supply: an idle donor that covers unloads at once while another is busy', function () {
    var donor = otherGeneral('1.4', 'Dora', { Rifle: 6 });
    var other = otherGeneral('1.5', 'Emil', {});
    var w = shortWorld([donor, other]);
    busyOn(other, w);
    tick(w);
    assert.strictEqual(stepName(w), 'Unload');
    assert.deepStrictEqual(plain(w.st.run().donors), ['1.4']);
    assert.ok(!w.st.current().busy);
});

t.test('Supply: past MAX_UNLOAD_CYCLES a wave keeps unloading while a donor is left', function () {
    var donor = otherGeneral('1.4', 'Dora', { Rifle: 6 });
    var w = shortWorld([donor]);
    w.st.run().cycles = ldr(w).MAX_UNLOAD_CYCLES;
    w.t += ldr(w).READ_LAG_MS;
    tick(w);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
    assert.strictEqual(stepName(w), 'Unload');
    assert.strictEqual(w.st.run().cycles, ldr(w).MAX_UNLOAD_CYCLES + 1);
    tick(w);
    play(w);
    assert.deepStrictEqual(w.unloads, ['1.4']);
});

t.test('Supply: a general back with no troops ends in TroopsShort, and so does one gone from the list', function () {
    var back = otherGeneral('1.4', 'Dora', { Rifle: 6 });
    var w = shortWorld([back]);
    busyOn(back, w);
    tick(w);
    assertWaiting(w);
    back.state.task = null;
    back.state.army = {};
    tick(w);
    tick(w);
    w.t += ldr(w).READ_LAG_MS;
    tick(w);
    assertTroopsShort(w);

    var lost = otherGeneral('1.4', 'Dora', { Rifle: 6 });
    var w2 = shortWorld([lost]);
    busyOn(lost, w2);
    tick(w2);
    assertWaiting(w2);
    w2.fighters.splice(w2.fighters.indexOf(lost), 1);
    tick(w2);
    tick(w2);
    w2.t += ldr(w2).READ_LAG_MS;
    tick(w2);
    assertTroopsShort(w2);
});

t.test('Supply: a general idle then busy again inside the hold causes no pause', function () {
    var other = otherGeneral('1.5', 'Emil', {});
    var w = shortWorld([other]);
    busyOn(other, w);
    tick(w);
    assertWaiting(w);
    other.state.task = null;
    tick(w);
    assert.ok(logged(w, /every general idle/));
    busyOn(other, w);
    tick(w);
    assertWaiting(w);
    W.ticksFor(w, 2 * ldr(w).READ_LAG_MS);
    assertWaiting(w);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
});

t.test('Supply: short on an unreadable free pool holds with no limit until the read is back', function () {
    var w = attackWorld();
    w.g2.state.army = {};
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Supply });
    var zone = w.H.host.game.zone;
    var army = zone.GetArmy;
    zone.GetArmy = function () { return null; };
    tick(w);
    assertSupply(w);
    W.ticksFor(w, ldr(w).READ_MAX_MS / 2);
    assertSupply(w);
    zone.GetArmy = army;
    tick(w);
    assert.strictEqual(stepName(w), 'Load', 'a read back in time clears it');

    var w2 = attackWorld();
    w2.g2.state.army = {};
    startRun(w2, ['C:/b/w1.txt'], { step: w2.S.WaveStep.Supply });
    var army2 = w2.H.host.game.zone.GetArmy;
    w2.H.host.game.zone.GetArmy = function () { return null; };
    tick(w2);
    W.ticksFor(w2, 3 * ldr(w2).READ_MAX_MS);
    var r = w2.st.run();
    assert.strictEqual(r.status, w2.S.RunStatus.Running, 'no pause over a bad read: ' + (r.pause && r.pause.reason));
    assert.strictEqual(w2.st.run().step, w2.S.WaveStep.Supply);
    assert.ok(/not readable/.test(w2.st.current().busy.text), w2.st.current().busy.text);
    assert.strictEqual(w2.raises.length + w2.unloads.length + w2.orders.length, 0, 'nothing sent while blind');
    w2.H.host.game.zone.GetArmy = army2;
    tick(w2);
    assert.strictEqual(stepName(w2), 'Load', 'the read back moves it on');
});

t.test('Supply: a wave general\'s surplus is unloaded and the wave loads', function () {
    var w = attackWorld();
    w.free = {};
    w.g1.state.army = { Rifle: 10 };
    w.g2.state.army = {};
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Supply });
    for (var i = 0; i < 12 && stepName(w) !== 'Reach' && w.st.run().status === w.S.RunStatus.Running; i++) {
        tick(w);
        play(w);
        w.t += ldr(w).READ_LAG_MS;
    }
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running, JSON.stringify(w.st.run().pause));
    assert.strictEqual(stepName(w), 'Reach');
    assert.deepStrictEqual(w.unloads, ['1.1']);
    assert.strictEqual(w.g1.state.army.Rifle, 5);
});

t.test('Verify: short with a busy general goes back to Supply and waits, no LoadMismatch', function () {
    var other = otherGeneral('1.5', 'Emil', {});
    var w = attackWorld({ extra: [other] });
    w.free = {};
    w.g2.state.army = { Rifle: 1 };
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Load });
    busyOn(other, w);
    tick(w);
    play(w);
    tick(w);
    assert.strictEqual(stepName(w), 'Verify');
    w.t += ldr(w).READ_LAG_MS;
    tick(w);
    assert.strictEqual(stepName(w), 'Supply');
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
    tick(w);
    assertWaiting(w);
    other.state.task = null;
    tick(w);
    tick(w);
    w.t += ldr(w).READ_LAG_MS;
    tick(w);
    assertTroopsShort(w);
});

t.test('Resume of a TroopsShort with a general still busy waits', function () {
    var other = otherGeneral('1.5', 'Emil', {});
    var w = shortWorld([other]);
    tick(w);
    w.t += ldr(w).READ_LAG_MS;
    tick(w);
    assertTroopsShort(w);
    busyOn(other, w);
    w.st.resume();
    for (var i = 0; i < 6 && !w.st.current().busy; i++) {
        tick(w);
        play(w);
    }
    assertSupply(w);
    var b = w.st.current().busy;
    assert.ok(b, 'a busy record');
    assert.strictEqual(b.step, w.st.run().step);
    assert.strictEqual(b.key, '1.5');
});

// ---- Reach / Settle ---------------------------------------------------------

t.test('Settle: unreachable while a fighter attacks stays in Settle', function () {
    var fighting = AC.general({ uid: '1.6', grid: 60 });
    var w = attackWorld({ extra: [fighting] });
    fighting.state.task = { type: w.code.attack };
    w.sent.pathLen = 0;
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Reach });
    tick(w);
    assert.strictEqual(stepName(w), 'Settle');
    for (var i = 0; i < 5; i++) tick(w);
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Running);
    assert.strictEqual(stepName(w), 'Settle');
    assert.strictEqual(r.settledAt, null);
    assert.strictEqual(r.settleFrom, w.S.WaveStep.Reach);
});

t.test('watcher: a finished non-last quest is claimed, the last never', function () {
    var w = attackWorld();
    w.sent.pathLen = 0;
    w.quests = [
        { key: 'q1', name: 'Scout', finished: true, last: false },
        { key: 'q9', name: 'Final', finished: true, last: true },
        { key: 'q2', name: 'Open', finished: false, last: false }
    ];
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Reach });
    for (var i = 0; i < 4; i++) { tick(w); play(w); }
    assert.deepStrictEqual(w.claims.map(function (c) { return c.key; }), ['q1']);
    assert.ok(!w.claims[0].opts || !w.claims[0].opts.allowLast);
    assert.ok(w.H.logs().some(function (l) { return /quest Scout claimed/.test(l.args.join(' ')); }));
});

t.test('watcher: claims nothing while the viewed zone is not the run island', function () {
    var w = attackWorld();
    w.sent.pathLen = 0;
    w.quests = [{ key: 'q1', name: 'Scout', finished: true, last: false }];
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Reach });
    w.H.host.game.gi.mCurrentViewedZoneID = ZONE + 1;
    // The plan runs directly: the scheduler would not even call it here.
    w.S.kernel._currentModule = 'adventures';
    w.mod.plan({});
    w.S.kernel._currentModule = null;
    play(w);
    // A step that runs on any zone is ticked off the island as well.
    w.st.go(w.S.RunStep.LastQuest, 'test');
    for (var i = 0; i < 3; i++) { tick(w); play(w); }
    assert.deepStrictEqual(w.claims.map(function (c) { return c.key; }), []);
    // Back on the island the same quest is claimed.
    w.H.host.game.gi.mCurrentViewedZoneID = ZONE;
    w.st.go(w.S.WaveStep.Reach, 'test');
    tick(w);
    play(w);
    assert.deepStrictEqual(w.claims.map(function (c) { return c.key; }), ['q1']);
});

function readKeys(w) {
    return w.reads.map(function (r) { return r.key; });
}

t.test('watcher: an unread quest is read before any claim', function () {
    var w = attackWorld();
    w.sent.pathLen = 0;
    w.quests = [
        { key: 'q1', name: 'Scout', unread: true, finished: false, last: false },
        { key: 'q2', name: 'Open', finished: true, last: false }
    ];
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Reach });
    tick(w);
    play(w);
    assert.deepStrictEqual(readKeys(w), ['q1']);
    assert.strictEqual(w.claims.length, 0, 'one action per plan: the read goes first');
    for (var i = 0; i < 4; i++) { tick(w); play(w); }
    assert.deepStrictEqual(readKeys(w), ['q1']);
    assert.deepStrictEqual(w.claims.map(function (c) { return c.key; }), ['q2']);
    assert.ok(w.H.logs().some(function (l) { return /quest Scout read/.test(l.args.join(' ')); }));
});

t.test('watcher: an unread last quest is read', function () {
    var w = attackWorld();
    w.sent.pathLen = 0;
    w.quests = [{ key: 'q9', name: 'Final', unread: true, finished: false, last: true }];
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Reach });
    for (var i = 0; i < 3; i++) { tick(w); play(w); }
    assert.deepStrictEqual(readKeys(w), ['q9']);
    assert.strictEqual(w.claims.length, 0);
});

t.test('watcher: a failed read retries after QUEST_RETRY_MS and never pauses', function () {
    var w = attackWorld();
    w.sent.pathLen = 0;
    w.auto.readFails = true;
    w.quests = [{ key: 'q1', name: 'Scout', unread: true, finished: false, last: false }];
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Reach });
    tick(w);
    play(w);
    assert.strictEqual(w.reads.length, 1);
    // Below the retry time no second read goes out.
    var retry = w.S.modules.adventures.watcher.QUEST_RETRY_MS;
    W.ticksFor(w, retry - 20000);
    play(w);
    assert.strictEqual(w.reads.length, 1, 'still waiting for the retry');
    W.ticksFor(w, retry + 60000);
    play(w);
    assert.ok(w.reads.length >= 2, 'read again after the retry time: ' + w.reads.length);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
});

t.test('watcher: a quest that turns unread later is read on a later plan', function () {
    var w = attackWorld();
    w.sent.pathLen = 0;
    w.quests = [{ key: 'q1', name: 'Scout', unread: false, finished: false, last: false }];
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Reach });
    for (var i = 0; i < 2; i++) { tick(w); play(w); }
    assert.strictEqual(w.reads.length, 0);
    w.quests[0].unread = true;
    tick(w);
    play(w);
    assert.deepStrictEqual(readKeys(w), ['q1']);
});

t.test('watcher: reads nothing while the viewed zone is not the run island', function () {
    var w = attackWorld();
    w.sent.pathLen = 0;
    w.quests = [{ key: 'q1', name: 'Scout', unread: true, finished: false, last: false }];
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Reach });
    w.H.host.game.gi.mCurrentViewedZoneID = ZONE + 1;
    w.S.kernel._currentModule = 'adventures';
    w.mod.plan({});
    w.S.kernel._currentModule = null;
    play(w);
    w.st.go(w.S.RunStep.LastQuest, 'test');
    for (var i = 0; i < 3; i++) { tick(w); play(w); }
    assert.deepStrictEqual(readKeys(w), []);
    w.H.host.game.gi.mCurrentViewedZoneID = ZONE;
    w.st.go(w.S.WaveStep.Reach, 'test');
    tick(w);
    play(w);
    assert.deepStrictEqual(readKeys(w), ['q1']);
});

t.test('Settle: an unread quest keeps the island unsettled', function () {
    var w = attackWorld();
    w.sent.pathLen = 0;
    w.S.modules.adventures.watcher.unread = function () { return [{ key: 'q1' }]; };
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Reach });
    tick(w);
    assert.strictEqual(stepName(w), 'Settle');
    for (var i = 0; i < 4; i++) tick(w);
    assert.strictEqual(stepName(w), 'Settle');
    assert.strictEqual(w.st.run().settledAt, null);

    var w2 = attackWorld();
    w2.sent.pathLen = 0;
    w2.S.modules.adventures.watcher.unread = function () { return []; };
    startRun(w2, ['C:/b/w1.txt'], { step: w2.S.WaveStep.Reach });
    tick(w2);
    tick(w2);
    assert.strictEqual(typeof w2.st.run().settledAt, 'number');
});

t.test('Settle: a path that appears goes back to Reach and on to Attack', function () {
    var fighting = AC.general({ uid: '1.6', grid: 60 });
    var w = attackWorld({ extra: [fighting] });
    fighting.state.task = { type: w.code.attack };
    w.sent.pathLen = 0;
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Reach });
    tick(w);
    tick(w);
    assert.strictEqual(stepName(w), 'Settle');
    w.sent.pathLen = 1;
    tick(w);
    assert.strictEqual(stepName(w), 'Reach');
    assert.strictEqual(w.st.run().blocker, null);
    tick(w);
    assert.strictEqual(stepName(w), 'Attack');
});

t.test('Settle: still unreachable after SETTLE_QUIET_MS of quiet pauses Unreachable naming line, general and target', function () {
    var w = attackWorld();
    w.sent.pathLen = 0;
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Reach });
    tick(w);
    tick(w);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
    W.ticksFor(w, 20000);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running, 'the old 20 s limit is gone');
    W.ticksFor(w, w.ex.SETTLE_QUIET_MS - 30000);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
    W.ticksFor(w, 20000);
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Paused);
    assert.strictEqual(r.pause.reason, w.S.RunPause.Unreachable);
    assert.ok(/Anna/.test(r.pause.general) && /1\.1/.test(r.pause.general), r.pause.general);
    assert.strictEqual(r.pause.target, 100);
    assert.ok(/no path/.test(r.pause.message), r.pause.message);
    assert.strictEqual(w.orders.length, 0);
});

t.test('Settle: a battle that runs never pauses, however long it lasts', function () {
    var fighting = AC.general({ uid: '1.6', grid: 60 });
    var w = attackWorld({ extra: [fighting] });
    fighting.state.task = { type: w.code.attack };
    w.sent.pathLen = 0;
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Reach });
    tick(w);
    assert.strictEqual(stepName(w), 'Settle');
    W.ticksFor(w, 2 * w.ex.SETTLE_MAX_MS);
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Running, 'status ' + r.status + ' after 30 min of battle');
    assert.strictEqual(stepName(w), 'Settle');
    assert.strictEqual(r.settledAt, null);
    // The battle ends: the quiet time counts from there, not from the start.
    fighting.state.task = null;
    W.ticksFor(w, w.ex.SETTLE_QUIET_MS - 30000);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running, 'quiet time restarted at the end of the battle');
    W.ticksFor(w, 60000);
    assert.strictEqual(w.st.run().pause.reason, w.S.RunPause.Unreachable);
});

t.test('Settle: a quest that stays pending ends SettleTimeout after SETTLE_MAX_MS with no battle', function () {
    var w = attackWorld();
    w.sent.pathLen = 0;
    // A claim that fails for ever: the watcher keeps one quest pending.
    w.S.modules.adventures.watcher.pending = function () { return [{ key: 'q1' }]; };
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Reach });
    tick(w);
    assert.strictEqual(stepName(w), 'Settle');
    W.ticksFor(w, w.ex.SETTLE_QUIET_MS + 60000);
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Running, 'a pending quest is not a settled island: ' + (r.pause && r.pause.reason));
    assert.strictEqual(r.settledAt, null);
    W.ticksFor(w, w.ex.SETTLE_MAX_MS - w.ex.SETTLE_QUIET_MS - 120000);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running, 'still inside 15 quiet minutes');
    W.ticksFor(w, 120000);
    r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Paused, 'status ' + r.status);
    assert.strictEqual(r.pause.reason, w.S.RunPause.SettleTimeout, r.pause.reason + ': ' + r.pause.message);
    assert.ok(/still after 15 min with no battle/.test(r.pause.message), r.pause.message);
});

t.test('Settle: a view elsewhere restarts settledAt and the time away does not count', function () {
    var w = attackWorld();
    w.sent.pathLen = 0;
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Reach });
    tick(w);
    tick(w);
    var first = w.st.run().settledAt;
    assert.strictEqual(typeof first, 'number');
    // Nobody looked for a whole quiet time: the passes stop in another zone.
    w.H.host.game.gi.mCurrentViewedZoneID = ZONE + 1;
    w.t += w.ex.SETTLE_QUIET_MS + 10000;
    w.H.host.game.gi.mCurrentViewedZoneID = ZONE;
    tick(w);
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Running, 'status ' + r.status);
    assert.strictEqual(r.settledAt, w.t, 'restarted at the first pass back');
    assert.ok(r.settledAt > first);
    W.ticksFor(w, w.ex.SETTLE_QUIET_MS - 30000);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
    W.ticksFor(w, 60000);
    assert.strictEqual(w.st.run().pause.reason, w.S.RunPause.Unreachable);
});

// ---- Attack -----------------------------------------------------------------

t.test('Attack: lines go out in parsed order, each gap at least its time, buff to its camp, tagged entries', function () {
    var w = attackWorld();
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Attack });
    var t0 = w.t;
    tick(w);
    assert.strictEqual(w.pending.length, 1);
    assert.strictEqual(w.pending[0].name, w.ex.PACE_ACTION);
    play(w);
    var sends = attacksOf(w).map(function (o) { return { key: o.key, t: o.t, grid: o.grid }; });
    assert.deepStrictEqual(sends.map(function (s) { return s.key; }), ['1.1', '1.2']);
    assert.deepStrictEqual(sends.map(function (s) { return s.grid; }), [100, 200]);
    assert.strictEqual(w.buffs.length, 1);
    assert.strictEqual(w.buffs[0].grid, 300);
    assert.strictEqual(w.buffs[0].name, 'Fire');
    var r = w.st.run();
    assert.strictEqual(r.lines['1.1'].sentAt, sends[0].t);
    // At once: one pacer gap plus the attempt runner's step before the send.
    assert.ok(sends[0].t - t0 <= w.ex.PACE_MS + w.S.kernel.TIMEOUTS.QUEUE_ACTION_GAP_MS, 'first line at once');
    assert.ok(sends[1].t >= r.lines['1.1'].sentAt + 5000, 'second gap');
    assert.ok(w.buffs[0].t >= r.lines['1.2'].sentAt + 2000, 'buff gap');
    assert.ok(w.buffs[0].t > sends[1].t);
    var paces = w.entries.filter(function (e) { return e.name === w.ex.PACE_ACTION; });
    assert.ok(paces.length > 3, 'pacer re-enqueued itself');
    w.entries.forEach(function (e) { assert.strictEqual(e.moduleId, 'adventures', e.name); });
    tick(w);
    assert.strictEqual(stepName(w), 'Confirm');
    tick(w);
    assertHandedOver(w);
});

t.test('Attack: line 1 seen early still holds line 2 until line1.sentAt + time', function () {
    var w = attackWorld();
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Attack });
    tick(w);
    var seenAt = null;
    play(w, function () {
        if (seenAt === null && w.st.run().lines['1.1'] && w.st.run().lines['1.1'].seen) seenAt = w.t;
        return attacksOf(w, '1.2').length > 0;
    });
    var r = w.st.run();
    assert.ok(seenAt !== null && seenAt < r.lines['1.1'].sentAt + 5000, 'line 1 verified inside the gap');
    assert.ok(attacksOf(w, '1.2')[0].t >= r.lines['1.1'].sentAt + 5000);
});

t.test('Attack: a pacer run while line 2 is in flight starts no second attempt', function () {
    var w = attackWorld();
    var r = startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Attack });
    tick(w);
    // Stop as soon as line 2's attempt is queued but has not run.
    play(w, function () {
        return w.pending.some(function (e) {
            return e.name === 'core.attempt' && /1\.2/.test(e.params[0].def.label) && e.params[0].sends === 0;
        });
    });
    var attempts = function () {
        return w.pending.filter(function (e) { return e.name === 'core.attempt'; }).length;
    };
    var before = attempts();
    w.S.kernel._currentModule = 'adventures';
    w.ex.pace([r.id, r.waveIndex]);
    w.S.kernel._currentModule = null;
    drain(w);
    assert.strictEqual(attempts(), before);
    play(w);
    assert.strictEqual(attacksOf(w, '1.2').length, 1);
});

// ---- Confirm ----------------------------------------------------------------

t.test('Confirm: every line seen moves to Gate of the next wave; the last wave hands over to PackStar', function () {
    var w = attackWorld();
    startRun(w, ['C:/b/w1.txt', 'C:/b/w2.txt'], { step: w.S.WaveStep.Attack });
    tick(w);
    play(w);
    tick(w);
    assert.strictEqual(stepName(w), 'Confirm');
    tick(w);
    var r = w.st.run();
    assert.strictEqual(r.waveIndex, 1);
    assert.strictEqual(stepName(w), 'Gate');
    assert.deepStrictEqual(plain(r.lines), {});
    // The first battles are over: both generals are idle for wave 2.
    w.g1.state.task = null;
    w.g2.state.task = null;
    runOut(w);
    assertHandedOver(w);
    assert.strictEqual(attacksOf(w).length, 4);
});

t.test('Confirm: an attack not observed pauses AttackNotSeen; Resume re-enters Gate without resending seen lines', function () {
    var w = attackWorld();
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Attack });
    // Line 2's attack is never observed.
    var orig = w.S.core.specialists.orders.attack;
    w.S.core.specialists.orders.attack = function (key, target, grid) {
        w.auto.attack = key !== '1.2';
        return orig(key, target, grid);
    };
    tick(w);
    play(w);
    tick(w);
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Paused);
    assert.strictEqual(r.pause.reason, w.S.RunPause.AttackNotSeen);
    assert.ok(/1\.2/.test(r.pause.general), r.pause.general);
    assert.strictEqual(r.pause.target, 200);
    assert.strictEqual(r.lines['1.1'].seen, true);

    w.S.core.specialists.orders.attack = orig;
    w.auto.attack = true;
    w.S.modules.adventures.run.resume();
    assert.strictEqual(stepName(w), 'Gate');
    assert.strictEqual(w.st.run().lines['1.2'].sentAt, null);
    runOut(w);
    assertHandedOver(w);
    assert.strictEqual(attacksOf(w, '1.1').length, 1);
    assert.ok(attacksOf(w, '1.2').length >= 2);
});

// ---- Reload -----------------------------------------------------------------

// A script reload: the same files run again into the same context. The
// module namespace (run state, memory-only round) survives, the queue does
// not, and the test's handles are re-pointed at the new bundle.
function reloadBundle(w) {
    w.H = harness.reload(w.H);
    w.H.clearQueued();
    w.pending = [];
    w.S = w.H.Steward;
    w.st = w.S.modules.adventures.state;
    w.ex = w.S.modules.adventures.executor;
    w.mod = w.H.module('adventures');
    w.st.now = function () { return w.t; };
    patchCore(w);
}

// Plays the attack until line 1 went out, then reloads the script and leaves
// dropping the round to the bundle load.
function reloadAfterLine1(w) {
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Attack });
    tick(w);
    play(w, function () { return attacksOf(w, '1.1').length === 1; });
    reloadBundle(w);
    assert.strictEqual(w.st.current().round, null);
    assert.ok(w.st.run().lines['1.1'].sentAt !== null);
    assert.strictEqual(w.st.run().lines['1.1'].seen, false);
}

t.test('Reload: a line with sentAt is never resent; attacking now counts as seen', function () {
    var w = attackWorld();
    reloadAfterLine1(w);
    tick(w);
    assert.strictEqual(w.st.run().lines['1.1'].seen, true);
    runOut(w);
    assertHandedOver(w);
    assert.strictEqual(attacksOf(w, '1.1').length, 1);
    assert.strictEqual(attacksOf(w, '1.2').length, 1);
});

t.test('Reload: idle with the camp still there pauses AttackUnconfirmed', function () {
    var w = attackWorld();
    w.auto.attack = false;
    reloadAfterLine1(w);
    tick(w);
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Paused);
    assert.strictEqual(r.pause.reason, w.S.RunPause.AttackUnconfirmed);
    assert.strictEqual(r.pause.target, 100);
    assert.strictEqual(attacksOf(w).length, 1);
    assert.strictEqual(w.pending.length, 0);
});

t.test('Reload: idle with the camp gone counts as seen with a warning', function () {
    var w = attackWorld();
    w.auto.attack = false;
    reloadAfterLine1(w);
    delete w.camps[100];
    tick(w);
    assert.strictEqual(w.st.run().lines['1.1'].seen, true);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
    assert.ok(w.H.logs().some(function (l) { return l.level === 'warn' && /gone after a send before reload/.test(l.args.join(' ')); }));
    assert.strictEqual(attacksOf(w, '1.1').length, 1);
});

// Plays until line 2's attempt is queued but has not run (no send marker yet).
function playToLine2InFlight(w) {
    play(w, function () {
        return w.pending.some(function (e) {
            return e.name === 'core.attempt' && /1\.2/.test(e.params[0].def.label) && e.params[0].sends === 0;
        });
    });
}

t.test('Reload: with line 2 in flight the pacer does not stall and line 2 goes out once', function () {
    var w = attackWorld();
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Attack });
    tick(w);
    playToLine2InFlight(w);
    assert.ok(w.st.current().round, 'a round exists');
    reloadBundle(w);
    assert.strictEqual(w.st.current().round, null);
    runOut(w);
    assertHandedOver(w);
    assert.strictEqual(attacksOf(w, '1.1').length, 1);
    assert.strictEqual(attacksOf(w, '1.2').length, 1);
});

// The kernel drops queue entries without any adventures code running: Steward
// Pause empties the whole queue (queue.reset), turning the module off removes
// only its own entries (queue.cancelByModule). The kernel queue is stubbed to
// capture entries, so both are applied to the captured and pending entries.
function kernelReset(w) {
    w.kernelPause();
}

function kernelCancelByModule(w, moduleId) {
    drain(w);
    w.pending = w.pending.filter(function (e) { return e.moduleId !== moduleId; });
}

// Line 2's attempt is dropped by the kernel; no reload and no dropRound run,
// so the executor itself must notice the orphaned round.
function assertOrphanedRoundRecovers(w) {
    var before = w.entries.length;
    runOut(w, 20);
    var paces = w.entries.slice(before).filter(function (e) { return e.name === w.ex.PACE_ACTION; }).length;
    assert.ok(paces < 100, 'pacer entries after the drop: ' + paces);
    assertHandedOver(w);
    assert.strictEqual(attacksOf(w, '1.1').length, 1);
    assert.strictEqual(attacksOf(w, '1.2').length, 1);
}

t.test('Kernel pause: a queue reset with line 2 in flight does not stall; each line goes out once', function () {
    var w = attackWorld();
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Attack });
    tick(w);
    playToLine2InFlight(w);
    assert.ok(w.st.current().round, 'a round exists');
    kernelReset(w);
    assert.ok(w.st.current().round, 'the kernel leaves the round in place');
    assertOrphanedRoundRecovers(w);
});

t.test('Module disable: cancelling the module queue with line 2 in flight does not stall; each line goes out once', function () {
    var w = attackWorld();
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Attack });
    tick(w);
    playToLine2InFlight(w);
    assert.ok(w.st.current().round, 'a round exists');
    kernelCancelByModule(w, 'adventures');
    assert.strictEqual(w.pending.length, 0, 'every pending entry belongs to the module');
    assert.ok(w.st.current().round, 'the kernel leaves the round in place');
    assertOrphanedRoundRecovers(w);
});

t.test('Replace: an aborted replace drops the round; the old run still sends the in-flight line once', function () {
    var w = startWorld();
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Attack });
    tick(w);
    playToLine2InFlight(w);
    assert.ok(w.st.current().round, 'a round exists');
    // The user agrees to replace, then cancels the count prompt.
    w.H.ctx.confirm = function () { return true; };
    w.H.ctx.prompt = function () { return null; };
    assert.strictEqual(w.S.modules.adventures.run.start(w.tplId), false);
    assert.strictEqual(w.st.current().round, null);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
    runOut(w);
    assertHandedOver(w);
    assert.strictEqual(attacksOf(w, '1.1').length, 1);
    assert.strictEqual(attacksOf(w, '1.2').length, 1);
});

t.test('Resume: a pause after a sent and won attack resumes without an Unreachable pause', function () {
    var w = attackWorld();
    startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Attack });
    tick(w);
    play(w, function () { return attacksOf(w, '1.1').length === 1; });
    // The camp fell to that attack; the user pauses before it was confirmed.
    delete w.camps[100];
    w.g1.state.task = null;
    w.st.pause(w.S.RunPause.User, 'paused by you');
    assert.strictEqual(w.S.modules.adventures.run.resume(), true);
    assert.strictEqual(w.st.run().lines['1.1'].sentAt, null);
    assert.strictEqual(w.st.run().lines['1.1'].sentOnce, true);
    runOut(w);
    var r = w.st.run();
    assert.notStrictEqual(r.pause && r.pause.reason, w.S.RunPause.Unreachable);
    assertHandedOver(w);
    assert.strictEqual(attacksOf(w, '1.1').length, 1);
    assert.strictEqual(attacksOf(w, '1.2').length, 1);
});

// ---- Zone -------------------------------------------------------------------

t.test('Zone: isReady is false off the run zone', function () {
    var w = attackWorld();
    startRun(w, ['C:/b/w1.txt']);
    assert.strictEqual(w.mod.isReady({ zone: { id: ZONE } }), true);
    assert.strictEqual(w.mod.isReady({ zone: { id: ZONE + 1 } }), false);
    w.H.host.game.gi.mCurrentViewedZoneID = ZONE + 1;
    assert.strictEqual(tick(w), false);
    assert.strictEqual(stepName(w), 'Gate');
});

t.test('Zone: the pacer returns without re-enqueue off the run zone', function () {
    var w = attackWorld();
    var r = startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Attack });
    tick(w);
    w.pending = [];
    w.H.host.game.gi.mCurrentViewedZoneID = ZONE + 1;
    w.S.kernel._currentModule = 'adventures';
    w.ex.pace([r.id, r.waveIndex]);
    w.S.kernel._currentModule = null;
    assert.strictEqual(w.H.queued().length, 0);
    assert.strictEqual(w.orders.length + w.buffs.length, 0);
});

// ---- Start ------------------------------------------------------------------

// A saved template of two waves; prompt answers come from w.answers in order.
function startWorld(waveTwo) {
    var w = attackWorld();
    var H = w.H;
    writeJson(w.fs, LOADOUT, {
        '1.1': { grid: 10, army: { Rifle: 5 } },
        '1.2': { grid: 20, army: { Rifle: 3 } }
    });
    if (waveTwo) writeJson(w.fs, 'C:/b/w2.txt', waveTwo);
    H.host.game.gi.mCurrentPlayer.getAvailableBuffs_vector = function () {
        return [A.buffEntry({ type: 'Adventure', resource: 'BlackKnights', amount: 3 })];
    };
    w.tplId = w.S.modules.adventures.templates.save({
        label: 'Black Knights', adventure: 'BlackKnights', loadout: LOADOUT,
        waves: ['C:/b/w1.txt', 'C:/b/w2.txt'], speedBuff: 'SpeedBuffDefault'
    }, 1000).id;
    w.answers = [];
    w.prompts = [];
    H.ctx.prompt = function (text, def) {
        w.prompts.push({ text: text, def: def });
        return w.answers.length ? w.answers.shift() : def;
    };
    H.ctx.confirm = function () { return true; };
    return w;
}

t.test('Start: a viewed open map asks the start wave and stores a run at its Gate', function () {
    var w = startWorld();
    w.answers = ['2', '2'];
    assert.strictEqual(w.S.modules.adventures.run.start(w.tplId), true);
    assert.strictEqual(w.prompts.length, 2);
    assert.ok(/Start at which wave of "Black Knights"\? 1\.\.2/.test(w.prompts[1].text), w.prompts[1].text);
    assert.strictEqual(w.prompts[1].def, '1');
    var r = w.st.run();
    assert.strictEqual(r.waveIndex, 1);
    assert.strictEqual(r.step, w.S.WaveStep.Gate);
    assert.strictEqual(r.status, w.S.RunStatus.Running);
    assert.strictEqual(r.zoneId, ZONE);
    assert.deepStrictEqual(plain(r.paths), ['C:/b/w1.txt', 'C:/b/w2.txt']);
    assert.strictEqual(r.loadoutPath, LOADOUT);
    assert.deepStrictEqual(plain(r.loadoutKeys), { '1.1': true, '1.2': true });
    assert.strictEqual(w.st.current().request.count, 2);
    assert.strictEqual(JSON.parse(w.fs.disk[RUN_FILE]).run.waveIndex, 1);
    assert.strictEqual(w.H.queued().length, 0);
});

t.test('Start: an invalid start wave stores nothing', function () {
    var w = startWorld();
    w.answers = ['1', '3'];
    assert.strictEqual(w.S.modules.adventures.run.start(w.tplId), false);
    assert.strictEqual(w.st.run(), null);
    assert.strictEqual(w.st.current().request, null);
    assert.ok(w.alerts.some(function (a) { return /Not a wave number/.test(a); }));
});

t.test('Start: a fatal start check stores nothing', function () {
    var w = startWorld({ '1.7': { grid: 10, target: 100, army: { Rifle: 1 }, order: 1 } });
    w.answers = ['1', '1'];
    assert.strictEqual(w.S.modules.adventures.run.start(w.tplId), false);
    assert.strictEqual(w.st.run(), null);
    assert.strictEqual(w.st.current().request, null);
    assert.ok(w.alerts.some(function (a) { return /cannot start/.test(a) && /1\.7/.test(a); }), w.alerts.join(' | '));
});

// ---- wiring -----------------------------------------------------------------

t.test('wiring: isReady is false with no run and with a paused run', function () {
    var w = attackWorld();
    assert.strictEqual(w.mod.isReady({ zone: { id: ZONE } }), false);
    startRun(w, ['C:/b/w1.txt']);
    assert.strictEqual(w.mod.isReady({ zone: { id: ZONE } }), true);
    w.st.pause(w.S.RunPause.User, 'paused by you');
    assert.strictEqual(w.mod.isReady({ zone: { id: ZONE } }), false);
});
