'use strict';

// The zone trip and the zone guard of the adventures run. A step on the island
// that has watched a wait for the stuckMinutes setting goes home, stays
// RESOLVE_HOME_MS, goes back and enters its step again; after RESOLVE_MAX
// trips at the same wave the run pauses Stuck. Every step acts only while its
// own zone is viewed, and a queued order does not go out once the view has
// changed. The home world of tests/stubs/adventures.js ({ home: true }) has a
// home island and the adventure island with their own lists and travel.

var t = require('../runner');
var AC = require('../stubs/actions');
var W = require('../stubs/adventures');

var assert = t.assert;

var HOME = W.HOME;
var ZONE = W.ZONE;
var LOADOUT = W.LOADOUT;
var WAVE = 'C:/b/w1.txt';
var KEYS = { '1.1': true, '1.2': true };
var MIN = 60000;
var PASS_MS = 10000;

var plain = W.plain;
var writeJson = W.writeJson;
var tick = W.tick;
var play = W.play;
var stepName = W.stepName;

// ---- world ------------------------------------------------------------------

function gen(uid, name, grid, army, more) {
    var o = { uid: uid, name: name, grid: grid, army: army || {} };
    var k;
    for (k in (more || {})) if (Object.prototype.hasOwnProperty.call(more, k)) o[k] = more[k];
    return AC.general(o);
}

function countVisits(w) {
    var visit = w.gi.visitZone;
    w.visits = w.visits || [];
    w.gi.visitZone = function (id) {
        w.visits.push({ id: id, t: w.t });
        return visit.apply(this, arguments);
    };
}

// Runs fn(id) after every zone visit, the way the client changes the island
// once it is viewed again.
function onVisit(w, fn) {
    var visit = w.gi.visitZone;
    w.gi.visitZone = function (id) {
        var out = visit.apply(this, arguments);
        fn(id);
        return out;
    };
}

// Anna (1.1) and Bert (1.2) at home; the wave attacks camps 100 and 200.
function homeWorld(o) {
    o = o || {};
    var g1 = gen('1.1', 'Anna', 10);
    var g2 = gen('1.2', 'Bert', 20);
    var opts = { home: true, generals: [g1, g2], free: { Rifle: 20, Bow: 0 } };
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) opts[k] = o[k];
    var w = W.world(opts);
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
    countVisits(w);
    return w;
}

function series(w, o) {
    o = o || {};
    var r = w.st.newRun({
        id: 42, templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights',
        zoneId: o.zoneId === undefined ? null : o.zoneId,
        paths: [WAVE], loadoutPath: LOADOUT, loadoutKeys: KEYS,
        waveIndex: 0, speedBuff: '', step: o.step || w.S.RunStep.Muster
    });
    var k;
    for (k in (o.run || {})) if (Object.prototype.hasOwnProperty.call(o.run, k)) r[k] = o.run[k];
    w.st.begin({
        templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights', count: 1, ended: false,
        requested: w.t, finished: 0, closedAt: null
    }, r);
    return w.st.run();
}

// The run on the island: viewing it, the map open, the generals there.
function onIsland(w, generals) {
    w.adventures = [{ adventureName: 'BlackKnights', zoneID: ZONE }];
    w.lists[HOME].length = 0;
    (generals || [w.g1, w.g2]).forEach(function (g) { w.place(g, ZONE); });
    w.frees[ZONE] = {};
    w.gi.visitZone(ZONE);
    w.visits.length = 0;
}

// The hang: wave 1 at Gate on the island, Anna's attack task never ends.
function hangWorld(o) {
    var w = homeWorld(o);
    onIsland(w);
    w.g1.state.task = { type: w.code.attack };
    series(w, { step: w.S.WaveStep.Gate, zoneId: ZONE });
    return w;
}

function visitsTo(w, id) {
    return w.visits.filter(function (v) { return v.id === id; }).length;
}

function logs(w) {
    return w.H.logs().filter(function (l) { return l.category === 'adventures'; })
        .map(function (l) { return l.args.join(' '); });
}

function logCount(w, re) {
    return logs(w).filter(function (s) { return re.test(s); }).length;
}

// Ticks every PASS_MS until pred() holds or maxMs passed; true when it held.
function tickUntil(w, pred, maxMs) {
    var end = w.t + maxMs;
    while (w.t < end) {
        w.t += PASS_MS;
        tick(w);
        if (pred()) return true;
    }
    return false;
}

function sends(w) {
    return { orders: w.orders.length, raises: w.raises.length, unloads: w.unloads.length, zoneSends: w.zoneSends.length };
}

function noTrip(w) {
    w.S.kernel.settings.write('adventures', { lastDir: '', stuckMinutes: 0 });
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---- the hang ---------------------------------------------------------------

t.test('hang: a Gate wait watched past 45 min goes home, waits 5 min, comes back and goes on', function () {
    var w = hangWorld();
    var before = sends(w);
    W.ticksFor(w, 44 * MIN);
    assert.strictEqual(w.visits.length, 0, 'no visit before the limit');
    assert.strictEqual(w.st.run().resolve, null);
    assert.strictEqual(stepName(w), 'Gate');
    W.ticksFor(w, 2 * MIN);
    assert.strictEqual(visitsTo(w, HOME), 1, 'one trip home');
    assert.strictEqual(w.st.run().resolve.phase, 'wait');
    assert.strictEqual(w.st.run().stuck.trips, 1);
    assert.strictEqual(logCount(w, /Gate waited 45 min \(Anna \(1\.1\) busy\); zone trip 1\/2: going home/), 1);
    W.ticksFor(w, 4 * MIN);
    assert.strictEqual(visitsTo(w, ZONE), 0, 'still at home inside the 5 min');
    // Viewing the island again gives a fresh read: the battle is over.
    onVisit(w, function (id) { if (id === ZONE) w.g1.state.task = null; });
    var ok = tickUntil(w, function () { return logCount(w, /Gate -> Position \(generals ready\)/) > 0; }, 5 * MIN);
    assert.ok(ok, 'the wave goes on: ' + logs(w).slice(-6).join(' | '));
    var r = w.st.run();
    assert.strictEqual(visitsTo(w, ZONE), 1, 'one trip back');
    assert.strictEqual(visitsTo(w, HOME), 1);
    assert.strictEqual(r.resolve, null);
    assert.strictEqual(r.stuck.trips, 1, 'the count stays for the same wave');
    assert.ok(logCount(w, /zone trip done/) === 1);
    assert.deepStrictEqual(sends(w), before, 'the trip sent no order');
    assert.strictEqual(r.marks.resolveHome, undefined);
    assert.strictEqual(r.marks.resolveBack, undefined);
    assert.strictEqual(r.status, w.S.RunStatus.Running);
});

t.test('hang: the busy log names the task, and "none" for a general held only by the in-use flag', function () {
    var w = hangWorld();
    W.ticksFor(w, 2 * MIN);
    var re = new RegExp('busy, waited \\d+ min.*, task ' + escapeRe(w.S.GeneralTask.Attack));
    assert.ok(logCount(w, re) > 0, logs(w).join(' | '));
    w.g1.state.task = null;
    w.g1.state.inUse = true;
    W.ticksFor(w, 2 * MIN);
    assert.ok(logCount(w, /busy, waited \d+ min.*, task none/) > 0, logs(w).slice(-4).join(' | '));
});

t.test('hang: time on another zone is not counted, and one log line marks each end of the zone wait', function () {
    var w = hangWorld();
    W.ticksFor(w, 30 * MIN);
    w.gi.visitZone(HOME);
    W.ticksFor(w, 60 * MIN);
    assert.strictEqual(w.st.run().resolve, null, 'no trip while the user is away');
    assert.strictEqual(logCount(w, /waiting for the right zone/), 1);
    w.gi.visitZone(ZONE);
    w.t += PASS_MS;
    tick(w);
    assert.strictEqual(logCount(w, /zone viewed again, run continues/), 1);
    assert.strictEqual(w.st.run().resolve, null, 'no trip on the first pass back');
    W.ticksFor(w, 14 * MIN);
    assert.strictEqual(w.st.run().resolve, null, 'the 30 min watched before count, the hour away does not');
    W.ticksFor(w, 2 * MIN);
    assert.notStrictEqual(w.st.run().resolve, null, 'the trip fires at 45 watched min');
});

t.test('hang: after 2 trips that change nothing the run pauses Stuck', function () {
    var w = hangWorld();
    tickUntil(w, function () { return w.st.run().status !== w.S.RunStatus.Running; }, 170 * MIN);
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Paused);
    assert.strictEqual(r.pause.reason, w.S.RunPause.Stuck);
    assert.ok(/after 2 zone trips: .*busy/.test(r.pause.message), r.pause.message);
    assert.strictEqual(visitsTo(w, HOME), 2, 'no third trip');
    assert.strictEqual(visitsTo(w, ZONE), 2);
    W.ticksFor(w, 60 * MIN);
    assert.strictEqual(visitsTo(w, HOME), 2, 'nothing travels while paused');
});

t.test('hang: a tick raised to 60 s still lets the clock grow', function () {
    var w = hangWorld();
    var sch = w.S.kernel.scheduler.state;
    var was = sch.tickIntervalMs;
    sch.tickIntervalMs = 60000;
    try {
        var t0 = w.t;
        var firedAt = null;
        for (var i = 0; i < 60 && firedAt === null; i++) {
            w.t += 60000;
            tick(w);
            if (w.st.run().resolve) firedAt = w.t;
        }
        assert.ok(firedAt !== null, 'the trip fired');
        var mins = (firedAt - t0) / MIN;
        assert.ok(mins >= 45 && mins <= 47, 'fired after ' + mins + ' min');
    } finally {
        sch.tickIntervalMs = was;
    }
});

// ---- where the trip does not fire ------------------------------------------

t.test('excluded: a home step and the long Arrive step never take the trip', function () {
    var w = homeWorld();
    w.g1.state.task = { type: w.code.attack };
    series(w, { step: w.S.RunStep.Muster });
    W.ticksFor(w, 60 * MIN);
    assert.strictEqual(w.visits.length, 0, 'Muster: no visit');
    assert.strictEqual(w.st.run().resolve, null, 'Muster: no trip');

    var w2 = homeWorld();
    onIsland(w2);
    w2.g2.state.travelling = true;
    w2.g2.state.task = { type: w2.code.travel, remaining: 1000 };
    series(w2, { step: w2.S.RunStep.Arrive, zoneId: ZONE });
    W.ticksFor(w2, 60 * MIN);
    assert.strictEqual(stepName(w2), 'Arrive');
    assert.strictEqual(w2.st.run().resolve, null, 'Arrive: no trip');
    assert.strictEqual(w2.visits.length, 0);
});

t.test('setting 0 turns the trip off', function () {
    var w = hangWorld();
    noTrip(w);
    W.ticksFor(w, 60 * MIN);
    assert.strictEqual(w.st.run().resolve, null);
    assert.strictEqual(w.visits.length, 0);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
});

t.test('setting: default 45 over an old stored file, a misc section and its summary', function () {
    var w = homeWorld();
    var a = w.S.modules.adventures;
    w.S.kernel.settings.write('adventures', { lastDir: '' });
    assert.strictEqual(a.templates.settings().stuckMinutes, 45);
    assert.strictEqual(a.resolve.limitMs(), 2700000);
    var misc = w.S.kernel.registry.byTab('misc').filter(function (m) { return m.id === 'adventures'; });
    assert.strictEqual(misc.length, 1, 'adventures has a misc section');
    assert.strictEqual(a.settingsSummary(), 'stuck limit 45 min, retrain off');
    noTrip(w);
    assert.strictEqual(a.settingsSummary(), 'stuck limit off, retrain off');
    assert.strictEqual(a.resolve.limitMs(), 0);
    w.S.kernel.settings.write('adventures', { stuckMinutes: 45, retrain: true });
    assert.strictEqual(a.settingsSummary(), 'stuck limit 45 min, retrain on');
    w.S.kernel.settings.write('adventures', { stuckMinutes: 45, retrain: true, retrainSettlersOnly: true });
    assert.strictEqual(a.settingsSummary(), 'stuck limit 45 min, retrain on, settlers only');
});

// ---- persistence, pause and resume ----------------------------------------

t.test('reload mid-trip: the run carries on in the wait phase and goes back once', function () {
    var w = hangWorld();
    W.ticksFor(w, 46 * MIN);
    assert.strictEqual(w.st.run().resolve.phase, 'wait');
    var at = w.st.run().resolve.at;

    var w2 = W.world({ home: true, fs: w.fs, generals: [] });
    w2.gi = w2.H.host.game.gi;
    countVisits(w2);
    w2.t = w.t;
    w2.adventures = [{ adventureName: 'BlackKnights', zoneID: ZONE }];
    w2.place(gen('1.1', 'Anna', 10), ZONE);
    w2.place(gen('1.2', 'Bert', 20), ZONE);
    w2.mod.boot();
    var r = w2.st.run();
    assert.strictEqual(r.resolve.phase, 'wait');
    assert.strictEqual(r.resolve.at, at);
    assert.strictEqual(r.stuck.trips, 1);
    tickUntil(w2, function () { return w2.st.run().resolve === null; }, 6 * MIN);
    assert.strictEqual(visitsTo(w2, ZONE), 1, 'one trip back');
    assert.strictEqual(visitsTo(w2, HOME), 0, 'no trip home after the reboot');
    assert.strictEqual(w2.st.run().resolve, null);
    assert.ok(w2.t - at >= w2.S.modules.adventures.resolve.RESOLVE_HOME_MS, 'the home stay was kept');
});

t.test('pause during a trip keeps it; resume ends it and clears the count', function () {
    var w = hangWorld();
    W.ticksFor(w, 46 * MIN);
    w.st.pause(w.S.RunPause.User, 'paused by you');
    assert.strictEqual(w.st.run().resolve.phase, 'wait', 'pause keeps the trip');
    W.ticksFor(w, 10 * MIN);
    assert.strictEqual(visitsTo(w, ZONE), 0, 'nothing travels while paused');
    w.st.resume();
    var r = w.st.run();
    assert.strictEqual(r.resolve, null);
    assert.strictEqual(r.stuck, null);
    assert.strictEqual(stepName(w), 'Gate');
});

t.test('normRun: resolve and stuck round-trip; bad shapes load as null', function () {
    var w = hangWorld();
    var r = w.st.run();
    r.resolve = { phase: 'wait', at: 123 };
    r.stuck = { step: w.S.WaveStep.Gate, wave: 0, trips: 1 };
    w.st.save();
    var w2 = W.world({ home: true, fs: w.fs });
    w2.st.load();
    assert.deepStrictEqual(plain(w2.st.run().resolve), { phase: 'wait', at: 123 });
    assert.deepStrictEqual(plain(w2.st.run().stuck), { step: w.S.WaveStep.Gate, wave: 0, trips: 1 });

    var data = JSON.parse(w.fs.disk[W.RUN_FILE]);
    data.run.resolve = { phase: 'x' };
    data.run.stuck = { step: 'nope' };
    w.fs.disk[W.RUN_FILE] = JSON.stringify(data);
    var w3 = W.world({ home: true, fs: w.fs });
    w3.st.load();
    assert.strictEqual(w3.st.run().resolve, null);
    assert.strictEqual(w3.st.run().stuck, null);
});

t.test('trip out of Settle: the blocker, settleFrom and cycles go, Gate waits like a fresh one', function () {
    // Camp 100 is gone, so line 1.1 blocks Reach; Cora's battle keeps Settle
    // from ever pausing, and the wait lasts.
    var w = homeWorld({ camps: { 200: true } });
    var g3 = gen('1.3', 'Cora', 30);
    onIsland(w, [w.g1, w.g2, g3]);
    g3.state.task = { type: w.code.attack };
    series(w, { step: w.S.WaveStep.Settle, zoneId: ZONE, run: { settleFrom: w.S.WaveStep.Reach, cycles: 1 } });
    w.t += PASS_MS;
    tick(w);
    assert.strictEqual(stepName(w), 'Settle');
    assert.notStrictEqual(w.st.run().blocker, null, 'Settle holds a blocker');
    var ok = tickUntil(w, function () { return logCount(w, /zone trip done/) > 0; }, 60 * MIN);
    assert.ok(ok, logs(w).slice(-6).join(' | '));
    var r = w.st.run();
    assert.strictEqual(stepName(w), 'Gate');
    assert.strictEqual(r.blocker, null);
    assert.strictEqual(r.settleFrom, null);
    assert.strictEqual(r.cycles, 0);

    var c = homeWorld();
    onIsland(c);
    var rc = series(c, { step: c.S.WaveStep.Gate, zoneId: ZONE });
    assert.strictEqual(w.st.waitsLong(r), c.st.waitsLong(rc), 'no stale blocker keeps the slow poll');
});

t.test('resume still re-enters at Gate and resets the attempt and the trip', function () {
    var w = hangWorld();
    var r = w.st.run();
    r.step = w.S.WaveStep.Supply;
    r.blocker = { key: '1.1', general: 'Anna', target: 100, reason: 'x' };
    r.settleFrom = w.S.WaveStep.Reach;
    r.cycles = 2;
    r.resolve = { phase: 'wait', at: w.t };
    r.stuck = { step: w.S.WaveStep.Supply, wave: 0, trips: 1 };
    w.st.pause(w.S.RunPause.User, 'paused by you');
    w.st.resume();
    r = w.st.run();
    assert.ok(logCount(w, /-> Gate \(resumed\)/) === 1, logs(w).slice(-3).join(' | '));
    assert.strictEqual(r.blocker, null);
    assert.strictEqual(r.settleFrom, null);
    assert.strictEqual(r.cycles, 0);
    assert.strictEqual(r.resolve, null);
    assert.strictEqual(r.stuck, null);
    assert.strictEqual(r.status, w.S.RunStatus.Running);
});

// ---- zone guard -------------------------------------------------------------

// The island world: Anna off her grid, so Position orders a move.
function islandWorld() {
    var g1 = AC.general({ uid: '1.1', name: 'Anna', grid: 15, army: { Rifle: 5 } });
    var g2 = AC.general({ uid: '1.2', name: 'Bert', grid: 20, army: { Rifle: 3 } });
    var w = W.world({ generals: [g1, g2] });
    writeJson(w.fs, WAVE, {
        '1.1': { grid: 10, target: 100, army: { Rifle: 5 }, order: 1, name: 'Anna' },
        '1.2': { grid: 20, target: 200, army: { Rifle: 3 }, order: 2, name: 'Bert' }
    });
    w.g1 = g1;
    w.gi = w.H.host.game.gi;
    return w;
}

function movesOf(w, key) {
    return w.orders.filter(function (o) { return o.code === w.code.move && o.key === key; });
}

t.test('zone guard: the island id alone is not enough, the view must be an adventure', function () {
    var w = islandWorld();
    var r = W.startRun(w, [WAVE], { step: w.S.WaveStep.Position });
    w.gi.mCurrentPlayer.mIsAdventureZone = false;
    assert.strictEqual(w.S.core.zone.id(), r.zoneId);
    assert.strictEqual(w.st.readyOn(r, null), false);
    assert.strictEqual(tick(w), false, 'isReady is false');
    W.ticksFor(w, MIN);
    play(w);
    assert.strictEqual(w.orders.length + w.raises.length + w.unloads.length, 0, 'nothing sent');
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running, 'no pause');
    w.gi.mCurrentPlayer.mIsAdventureZone = true;
    assert.strictEqual(w.st.readyOn(r, null), true, 'the same run is ready on the adventure');
});

t.test('zone guard: a queued order does not go out after the view changed, and goes once back', function () {
    var w = islandWorld();
    W.startRun(w, [WAVE], { step: w.S.WaveStep.Position });
    tick(w);
    assert.ok(w.pending.some(function (e) { return e.name === 'core.attempt'; }), 'a move is queued');
    w.gi.mCurrentViewedZoneID = HOME;
    play(w);
    assert.strictEqual(w.orders.length + w.raises.length, 0, 'nothing reached the host');
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running, 'no pause');
    assert.strictEqual(stepName(w), 'Position');
    w.gi.mCurrentViewedZoneID = ZONE;
    for (var i = 0; i < 10 && movesOf(w, '1.1').length === 0; i++) {
        w.t += PASS_MS;
        tick(w);
        play(w);
    }
    assert.strictEqual(movesOf(w, '1.1').length, 1, 'sent once back on the island');
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
});

// ---- single reader and busy ownership ----------------------------------------

t.test('a bad stored limit falls back to the default for both the trip and the summary', function () {
    var w = homeWorld();
    var a = w.S.modules.adventures;
    [-5, 'abc', null].forEach(function (v) {
        w.S.kernel.settings.write('adventures', { lastDir: '', stuckMinutes: v });
        assert.strictEqual(a.stuckMinutes(), 45, 'stored ' + v);
        assert.strictEqual(a.resolve.limitMs(), 2700000, 'stored ' + v);
        assert.strictEqual(a.settingsSummary(), 'stuck limit 45 min, retrain off', 'stored ' + v);
    });
    w.S.kernel.settings.write('adventures', { lastDir: '', stuckMinutes: 30 });
    assert.strictEqual(a.stuckMinutes(), 30);
    assert.strictEqual(a.resolve.limitMs(), 1800000);
    assert.strictEqual(a.settingsSummary(), 'stuck limit 30 min, retrain off');
});

t.test('busyOf returns only the record of the run\'s step', function () {
    var w = hangWorld();
    var r = w.st.run();
    assert.strictEqual(w.st.busyOf(r), null, 'no busy record before the first wait');
    W.ticksFor(w, 2 * MIN);
    var b = w.st.busyOf(r);
    assert.ok(b && /busy/.test(b.text), 'the watched wait has its record: ' + (b && b.text));
    w.st.go(w.S.WaveStep.Position, 'test: another step');
    assert.strictEqual(w.st.busyOf(w.st.run()), null, 'another step reads no busy record');
});
