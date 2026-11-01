'use strict';

// A line whose camp was already beaten earlier in the run is dropped instead of
// blocking the wave. The wave files are the record of what the run fought over
// (r.lines is emptied at each Confirm), so a camp counts as beaten when an
// earlier wave file, or an earlier line of this wave that went out, named it.
// A camp no file of the run named stays a blocker, and an unreadable building
// list never reads as a win.

var t = require('../runner');
var W = require('../stubs/adventures');
var AC = require('../stubs/actions');

var assert = t.assert;

var RUN_FILE = W.RUN_FILE;

var world = W.world;
var tick = W.tick;
var runOut = W.runOut;
var startRun = W.startRun;
var stepName = W.stepName;
var writeJson = W.writeJson;

// Past this much quiet time Settle pauses Unreachable; read from the module.
function quietMs(w) { return w.ex.SETTLE_QUIET_MS; }

function attacksOf(w, key) {
    return w.orders.filter(function (o) { return o.code === w.code.attack && (!key || o.key === key); });
}

function movesOf(w, key) {
    return w.orders.filter(function (o) { return o.code === w.code.move && (!key || o.key === key); });
}

function assertHandedOver(w) {
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Running, 'status ' + r.status + (r.pause ? ' (' + r.pause.message + ')' : ''));
    assert.strictEqual(r.step, w.S.RunStep.PackStar, 'step ' + stepName(w));
}

// Two generals in place with matching armies. Wave 1 names camp 100; wave 2
// names 100 again (line 1.1) and 200 (line 1.2). Camp 100 is beaten by the time
// wave 2 runs. The run is at wave 2.
function twoWaveWorld(o) {
    o = o || {};
    var g1 = AC.general({ uid: '1.1', name: 'Anna', grid: o.g1Grid || 10, army: o.g1Army || { Rifle: 5 } });
    var g2 = AC.general({ uid: '1.2', name: 'Bert', grid: 20, army: { Rifle: 3 } });
    var w = world({
        generals: [g1, g2],
        camps: o.camps || { 200: true },
        free: o.free
    });
    writeJson(w.fs, 'C:/b/w1.txt', {
        '1.1': { grid: 10, target: 100, army: { Rifle: 5 }, order: 1, name: 'Anna' }
    });
    writeJson(w.fs, 'C:/b/w2.txt', {
        '1.1': { grid: 10, target: 100, army: { Rifle: 5 }, order: 1, name: 'Anna' },
        '1.2': { grid: 20, target: 200, army: { Rifle: 3 }, order: 2, time: 60000, name: 'Bert' }
    });
    w.g1 = g1;
    w.g2 = g2;
    return w;
}

// ---- dropped at Gate -------------------------------------------------------

t.test('Gate: a line whose camp is gone and was named by an earlier wave is dropped, the other goes on', function () {
    var w = twoWaveWorld();
    startRun(w, ['C:/b/w1.txt', 'C:/b/w2.txt'], { waveIndex: 1 });
    tick(w);
    var rec = w.st.run().lines['1.1'];
    assert.ok(rec, 'a record for the dropped line');
    assert.strictEqual(rec.seen, true);
    assert.strictEqual(rec.sentAt, null, 'no send time');
    assert.notStrictEqual(rec.sentOnce, true, 'never sent');
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
    runOut(w);
    assertHandedOver(w);
    assert.strictEqual(attacksOf(w, '1.1').length, 0, 'the beaten camp is not attacked');
    assert.strictEqual(attacksOf(w, '1.2').length, 1);
    assert.strictEqual(attacksOf(w, '1.2')[0].grid, 200);
});

t.test('Gate: the dropped line\'s general is not moved or loaded and his troops serve the other line', function () {
    // Anna stands off her grid with the wrong army; Bert has nothing and the free
    // pool is empty. Anna is outside the wave once dropped, so her troops are a
    // donor's and nothing is done to her as a line holder.
    var w = twoWaveWorld({ g1Grid: 15, g1Army: { Rifle: 4 }, free: { Rifle: 0, Bow: 0 } });
    w.g2.state.army = {};
    startRun(w, ['C:/b/w1.txt', 'C:/b/w2.txt'], { waveIndex: 1 });
    runOut(w);
    assertHandedOver(w);
    assert.strictEqual(movesOf(w, '1.1').length, 0, 'not moved to her grid');
    assert.strictEqual(w.raises.indexOf('1.1'), -1, 'not raised to her line army');
    assert.strictEqual(attacksOf(w, '1.1').length, 0);
    assert.strictEqual(attacksOf(w, '1.2').length, 1, 'Bert attacked');
    assert.ok(w.unloads.indexOf('1.1') >= 0, 'her troops were taken as a donor');
    assert.deepStrictEqual(w.g2.state.army, { Rifle: 3 }, 'Bert holds his line army');
});

t.test('Gate: every line dropped counts the wave done and the run goes on', function () {
    var w = twoWaveWorld();
    writeJson(w.fs, 'C:/b/w2.txt', {
        '1.1': { grid: 10, target: 100, army: { Rifle: 5 }, order: 1, name: 'Anna' }
    });
    startRun(w, ['C:/b/w1.txt', 'C:/b/w2.txt'], { waveIndex: 1 });
    runOut(w);
    assertHandedOver(w);
    assert.strictEqual(w.orders.length, 0, 'nothing sent');
    assert.strictEqual(w.st.run().waveIndex, 2, 'the wave counted');
});

t.test('Gate: a camp no file named is no win, Settle pauses Unreachable at the quiet limit', function () {
    var w = twoWaveWorld();
    // Wave 1 does not name camp 100 here, so nothing says it was beaten.
    writeJson(w.fs, 'C:/b/w1.txt', {
        '1.1': { grid: 10, target: 300, army: { Rifle: 5 }, order: 1, name: 'Anna' }
    });
    startRun(w, ['C:/b/w1.txt', 'C:/b/w2.txt'], { waveIndex: 1 });
    var limit = quietMs(w);
    for (var i = 0; i < 6 && stepName(w) !== 'Settle'; i++) tick(w);
    assert.strictEqual(stepName(w), 'Settle');
    assert.strictEqual(w.st.run().lines['1.1'] && w.st.run().lines['1.1'].seen, undefined);
    W.ticksFor(w, limit - 30000);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running, 'still waiting before the limit');
    W.ticksFor(w, 40000);
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Paused);
    assert.strictEqual(r.pause.reason, w.S.RunPause.Unreachable);
    assert.strictEqual(r.pause.target, 100);
    assert.ok(/target missing/.test(r.pause.message), r.pause.message);
    assert.strictEqual(w.orders.length, 0);
});

// ---- an unreadable building list --------------------------------------------

t.test('Gate: an unreadable building list drops nothing; a readable one drops the line from Settle', function () {
    var w = twoWaveWorld();
    w.campsUnreadable = true;
    startRun(w, ['C:/b/w1.txt', 'C:/b/w2.txt'], { waveIndex: 1 });
    for (var i = 0; i < 8 && stepName(w) !== 'Settle'; i++) tick(w);
    assert.strictEqual(stepName(w), 'Settle', 'the missing camp cannot be judged');
    assert.ok(!w.st.run().lines['1.1'] || !w.st.run().lines['1.1'].seen, 'not dropped');
    W.ticksFor(w, 60000);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
    assert.ok(!w.st.run().lines['1.1'] || !w.st.run().lines['1.1'].seen, 'still not dropped');
    assert.strictEqual(attacksOf(w).length, 0);
    w.campsUnreadable = false;
    runOut(w);
    assertHandedOver(w);
    assert.strictEqual(attacksOf(w, '1.1').length, 0);
    assert.strictEqual(attacksOf(w, '1.2').length, 1);
});

t.test('Gate: the run\'s zone id over a view not yet an adventure drops nothing; once it is, the gone camp drops', function () {
    // The id can flip first on a return from home, and the home island's list
    // holds no camp of the adventure.
    var w = twoWaveWorld();
    var player = w.H.host.game.gi.mCurrentPlayer;
    player.mIsAdventureZone = false;
    var r = startRun(w, ['C:/b/w1.txt', 'C:/b/w2.txt'], { waveIndex: 1 });
    assert.strictEqual(w.S.core.zone.id(), r.zoneId, 'the id already reads the run\'s zone');
    assert.strictEqual(w.S.core.buildings.byGrid(100), null, 'the camp reads as gone');
    for (var i = 0; i < 8 && stepName(w) !== 'Settle'; i++) tick(w);
    assert.strictEqual(stepName(w), 'Settle', 'the missing camp cannot be judged');
    W.ticksFor(w, 60000);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running, 'no pause');
    assert.ok(!w.st.run().lines['1.1'] || !w.st.run().lines['1.1'].seen, 'not dropped');
    assert.strictEqual(attacksOf(w).length, 0);
    player.mIsAdventureZone = true;
    runOut(w);
    assertHandedOver(w);
    assert.strictEqual(w.st.run().waveIndex, 2);
    assert.strictEqual(attacksOf(w, '1.1').length, 0, 'the beaten camp is not attacked');
    assert.strictEqual(attacksOf(w, '1.2').length, 1);
});

// ---- a camp that falls after Gate -------------------------------------------

t.test('Reach: a camp that falls between Gate and Reach is dropped at Reach', function () {
    var w = twoWaveWorld({ camps: { 100: true, 200: true } });
    startRun(w, ['C:/b/w1.txt', 'C:/b/w2.txt'], { waveIndex: 1 });
    for (var i = 0; i < 12 && stepName(w) !== 'Reach'; i++) tick(w);
    assert.strictEqual(stepName(w), 'Reach');
    assert.ok(!w.st.run().lines['1.1'] || !w.st.run().lines['1.1'].seen, 'standing at Gate: kept');
    delete w.camps[100];
    runOut(w);
    assertHandedOver(w);
    assert.strictEqual(w.st.run().waveIndex, 2);
    assert.strictEqual(attacksOf(w, '1.1').length, 0);
    assert.strictEqual(attacksOf(w, '1.2').length, 1);
});

// ---- the gap to the next line -------------------------------------------------

t.test('Pace: the gap to the next line counts from a real send; a dropped line has no send time', function () {
    var g1 = AC.general({ uid: '1.1', name: 'Anna', grid: 10, army: { Rifle: 5 } });
    var g2 = AC.general({ uid: '1.2', name: 'Bert', grid: 20, army: { Rifle: 3 } });
    var g3 = AC.general({ uid: '1.3', name: 'Cora', grid: 30, army: { Rifle: 2 } });
    var w = world({ generals: [g1, g2, g3], camps: { 100: true, 300: true } });
    writeJson(w.fs, 'C:/b/w1.txt', {
        '1.2': { grid: 20, target: 200, army: { Rifle: 3 }, order: 1, name: 'Bert' }
    });
    writeJson(w.fs, 'C:/b/w2.txt', {
        '1.1': { grid: 10, target: 100, army: { Rifle: 5 }, order: 1, name: 'Anna' },
        '1.2': { grid: 20, target: 200, army: { Rifle: 3 }, order: 2, time: 1000, name: 'Bert' },
        '1.3': { grid: 30, target: 300, army: { Rifle: 2 }, order: 3, time: 5000, name: 'Cora' }
    });
    startRun(w, ['C:/b/w1.txt', 'C:/b/w2.txt'], { waveIndex: 1, step: w.S.WaveStep.Gate });
    runOut(w);
    assertHandedOver(w);
    assert.strictEqual(w.st.run().waveIndex, 2);
    assert.strictEqual(attacksOf(w, '1.2').length, 0, 'camp 200 was beaten earlier');
    var a = attacksOf(w, '1.1');
    var c = attacksOf(w, '1.3');
    assert.strictEqual(a.length, 1);
    assert.strictEqual(c.length, 1);
    assert.ok(c[0].t - a[0].t >= 5000, 'Cora waits her 5 s after Anna\'s real send, got ' + (c[0].t - a[0].t));
});

t.test('Pace: a dropped line first in the wave lets the next one go at once', function () {
    var w = twoWaveWorld();
    startRun(w, ['C:/b/w1.txt', 'C:/b/w2.txt'], { waveIndex: 1 });
    var t0 = w.t;
    runOut(w);
    assertHandedOver(w);
    var b = attacksOf(w, '1.2');
    assert.strictEqual(b.length, 1);
    // Her gap is 60 s after the previous send; there is none.
    assert.ok(b[0].t - t0 < 60000, 'sent after ' + (b[0].t - t0) + ' ms');
});

// ---- Resume ---------------------------------------------------------------------

// The wave file paths of the live run: eleven waves, the last two camps of the
// run named by waves 9 and 10.
var LIVE_PATHS = [];
for (var n = 0; n < 11; n++) LIVE_PATHS.push('C:/b/live' + (n + 1) + '.txt');

function liveWorld(o) {
    var g1 = AC.general({ uid: '1.1', name: 'Anna', grid: 10, army: { Rifle: 5 } });
    var g2 = AC.general({ uid: '1.2', name: 'Bert', grid: 20, army: { Rifle: 3 } });
    var w = world({ fs: o.fs, generals: [g1, g2], camps: o.camps });
    w.g1 = g1;
    w.g2 = g2;
    return w;
}

function writeLiveFiles(fs) {
    // Waves 9 and 10 (indexes 8 and 9) fought camps 1305 and 964.
    writeJson(fs, LIVE_PATHS[8], {
        '1.1': { grid: 10, target: 1305, army: { Rifle: 5 }, order: 1, name: 'Anna' },
        '1.2': { grid: 20, target: 964, army: { Rifle: 3 }, order: 2, time: 5000, name: 'Bert' }
    });
    writeJson(fs, LIVE_PATHS[9], {
        '1.2': { grid: 20, target: 964, army: { Rifle: 3 }, order: 1, name: 'Bert' }
    });
    writeJson(fs, LIVE_PATHS[10], {
        '1.1': { grid: 10, target: 1305, army: { Rifle: 5 }, order: 1, name: 'Anna' },
        '1.2': { grid: 20, target: 964, army: { Rifle: 3 }, order: 2, time: 5000, name: 'Bert' }
    });
}

// What the v0.7.6 client left: wave 11 of 11 paused at Settle from Reach, with
// no line records because Confirm emptied them, on the first run of the series.
function pausedV076(camps) {
    var base = world({});
    writeLiveFiles(base.fs);
    var g1 = AC.general({ uid: '1.1', name: 'Anna', grid: 10, army: { Rifle: 5 } });
    var g2 = AC.general({ uid: '1.2', name: 'Bert', grid: 20, army: { Rifle: 3 } });
    var w = world({ fs: base.fs, generals: [g1, g2], camps: camps });
    var r = startRun(w, LIVE_PATHS, { waveIndex: 10, step: w.S.WaveStep.Settle });
    r.settleFrom = w.S.WaveStep.Reach;
    r.blocker = { key: '1.1', general: 'Anna (1.1)', target: 1305, reason: 'target missing (1305)' };
    r.lines = {};
    w.st.pause(w.S.RunPause.Unreachable, 'Anna (1.1): target missing (1305)');
    w.g1 = g1;
    w.g2 = g2;
    var data = JSON.parse(w.fs.disk[RUN_FILE]);
    assert.strictEqual(data.run.status, w.S.RunStatus.Paused);
    assert.strictEqual(data.run.waveIndex, 10);
    assert.deepStrictEqual(data.run.lines, {});
    return { fs: w.fs, g1: g1, g2: g2 };
}

function reload(old, camps) {
    var w = world({ fs: old.fs, generals: [old.g1, old.g2], camps: camps });
    w.mod.boot();
    w.g1 = old.g1;
    w.g2 = old.g2;
    return w;
}

t.test('Resume of a v0.7.6 run at wave 11 of 11: camp 1305 gone, 964 standing drops one line and attacks the other', function () {
    var old = pausedV076({ 964: true });
    var w = reload(old, { 964: true });
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Paused);
    assert.strictEqual(w.S.modules.adventures.run.resume(), true);
    runOut(w);
    assertHandedOver(w);
    assert.strictEqual(w.st.run().pause, null);
    assert.strictEqual(attacksOf(w, '1.1').length, 0, '1305 is not attacked again');
    var b = attacksOf(w, '1.2');
    assert.strictEqual(b.length, 1, '964 is attacked');
    assert.strictEqual(b[0].grid, 964);
});

t.test('Resume of a v0.7.6 run at wave 11 of 11: both camps gone drops both lines and ends the wave', function () {
    var old = pausedV076({ 964: true });
    var w = reload(old, {});
    assert.strictEqual(w.S.modules.adventures.run.resume(), true);
    runOut(w);
    assertHandedOver(w);
    assert.strictEqual(w.orders.length, 0, 'nothing sent');
    assert.strictEqual(w.st.run().waveIndex, 11);
});

t.test('Resume after a reload keeps the drop: the dropped line is never attacked and the other goes once', function () {
    var old = pausedV076({ 964: true });
    var w1 = reload(old, { 964: true });
    assert.strictEqual(w1.S.modules.adventures.run.resume(), true);
    tick(w1);
    assert.strictEqual(w1.st.run().lines['1.1'].seen, true, 'dropped at Gate');
    // The user pauses right after the drop and the client restarts.
    w1.st.pause(w1.S.RunPause.User, 'paused by you');
    var w2 = reload(old, { 964: true });
    assert.strictEqual(w2.st.run().lines['1.1'].seen, true, 'the drop is on disk');
    assert.strictEqual(w2.st.run().lines['1.1'].sentAt, null);
    assert.strictEqual(w2.S.modules.adventures.run.resume(), true);
    runOut(w2);
    assertHandedOver(w2);
    assert.strictEqual(attacksOf(w2, '1.1').length, 0);
    assert.strictEqual(attacksOf(w2, '1.2').length, 1);
    assert.strictEqual(attacksOf(w1, '1.1').length + attacksOf(w1, '1.2').length, 0, 'the first client sent nothing');
});
