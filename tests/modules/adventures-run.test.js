'use strict';

// The run series of the adventures module: from home through the map and back
// home, repeated. The home world of tests/stubs/adventures.js ({ home: true })
// has a home island and the adventure island with their own specialist lists
// and free pools, travel between them, map and population buffs and the
// production queues; play() runs the queued entries with a test clock.
//
// drive() ticks and plays one pass at a time and helps the world the way the
// game would between passes: travelling generals arrive, attacks end, and the
// map's last quest finishes once the waves are over. Each test starts the run
// at the step it is about, with the run fields that step reads.

var t = require('../runner');
var harness = require('../harness');
var AC = require('../stubs/actions');
var W = require('../stubs/adventures');

var assert = t.assert;

var HOME = W.HOME;
var ZONE = W.ZONE;
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

function gen(uid, name, grid, army, more) {
    var o = { uid: uid, name: name, grid: grid, army: army || {} };
    var k;
    for (k in (more || {})) if (Object.prototype.hasOwnProperty.call(more, k)) o[k] = more[k];
    return AC.general(o);
}

// Anna (1.1) carries 5 Rifle and Bert (1.2) 3 Rifle; the wave attacks two
// camps. o: world options; o.generals replaces the two at home, o.loadout and
// o.wave replace the files. Retraining is on unless o.settings says otherwise,
// so the tests of the home steps see the retrain path.
function homeWorld(o) {
    o = o || {};
    var g1 = gen('1.1', 'Anna', 10);
    var g2 = gen('1.2', 'Bert', 20);
    var opts = { home: true, generals: [g1, g2], free: { Rifle: 20, Bow: 0 }, settings: o.settings || { retrain: true } };
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) opts[k] = o[k];
    var w = W.world(opts);
    w.g1 = g1;
    w.g2 = g2;
    writeJson(w.fs, LOADOUT, o.loadout || {
        '1.1': { grid: 10, army: { Rifle: 5 } },
        '1.2': { grid: 20, army: { Rifle: 3 } }
    });
    writeJson(w.fs, WAVE, o.wave || {
        '1.1': { grid: 10, target: 100, army: { Rifle: 5 }, order: 1, name: 'Anna' },
        '1.2': { grid: 20, target: 200, army: { Rifle: 3 }, order: 2, name: 'Bert' }
    });
    w.gi = w.H.host.game.gi;
    countVisits(w);
    return w;
}

function countVisits(w) {
    var visit = w.gi.visitZone;
    w.visits = w.visits || [];
    w.gi.visitZone = function (id) {
        w.visits.push({ id: id, t: w.t });
        return visit.apply(this, arguments);
    };
}

// A run of the series at o.step (default Muster), a series of o.count maps.
// o.run: run fields set after newRun (snapshot, marks, ...).
function series(w, o) {
    o = o || {};
    var r = w.st.newRun({
        id: o.id || 42, templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights',
        zoneId: o.zoneId === undefined ? null : o.zoneId,
        paths: [WAVE], loadoutPath: LOADOUT, loadoutKeys: o.keys || KEYS,
        waveIndex: o.waveIndex || 0, speedBuff: o.speedBuff || '',
        step: o.step || w.S.RunStep.Muster
    });
    var k;
    for (k in (o.run || {})) if (Object.prototype.hasOwnProperty.call(o.run, k)) r[k] = o.run[k];
    w.st.begin({
        templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights', count: o.count || 1, ended: false,
        requested: w.t, finished: o.finished || 0, closedAt: o.closedAt === undefined ? null : o.closedAt
    }, r);
    return w.st.run();
}

// The run on the island: viewing it, the map open, the generals there.
function onIsland(w, generals, free) {
    w.adventures = [{ adventureName: 'BlackKnights', zoneID: ZONE }];
    w.lists[HOME].length = 0;
    (generals || [w.g1, w.g2]).forEach(function (g) { w.place(g, ZONE); });
    w.frees[ZONE] = free || {};
    w.gi.visitZone(ZONE);
    w.visits.length = 0;
}

function lastQuest(w) {
    var list = w.quests || [];
    for (var i = 0; i < list.length; i++) if (list[i].last) return list[i];
    return null;
}

// What the game does between two passes without being asked.
function help(w, name) {
    if (name === 'Arrive' || name === 'ArriveHome') w.arrive();
    if (name === 'Confirm' || name === 'Clear') {
        Object.keys(w.lists).forEach(function (id) {
            w.lists[id].forEach(function (g) {
                if (g.state.task && g.state.task.type === w.code.attack) g.state.task = null;
            });
        });
    }
    if (name === 'Clear' && w.quests) {
        var q = lastQuest(w);
        if (!q) w.quests.push({ key: 'q' + w.st.run().id, name: 'Final', finished: true, last: true });
        else q.finished = true;
    }
}

// Ticks and plays pass by pass until the run is no longer Running or
// o.until(w, name) holds. o.on(w, name) runs before each pass; o.help false
// leaves the world alone; o.dt is the clock step per pass (default 1 s).
// Returns the number of passes.
function drive(w, o) {
    o = o || {};
    var max = o.max || 400;
    for (var i = 0; i < max; i++) {
        var r = w.st.run();
        if (!r || r.status !== w.S.RunStatus.Running) return i;
        var name = stepName(w);
        if (o.until && o.until(w, name)) return i;
        if (o.help !== false) help(w, name);
        if (o.on) o.on(w, name);
        tick(w);
        play(w);
        w.t += typeof o.dt === 'number' ? o.dt : 1000;
    }
    return i;
}

function at(name) {
    return function (w, n) { return n === name; };
}

// Passes over this much clock, each with its queue played, so an order sent
// during a wait reaches the world and its count.
function passesFor(w, ms) {
    var end = w.t + ms;
    while (w.t < end) {
        W.ticksFor(w, Math.min(PASS_MS, end - w.t));
        play(w);
    }
}

// The wait the run menu names.
function waiting(w, re) {
    var b = w.st.current().busy;
    assert.ok(b && re.test(b.text), b ? b.text : 'no wait');
}

function assertStep(w, name) {
    var r = w.st.run();
    assert.strictEqual(stepName(w), name, 'step ' + stepName(w) + (r.pause ? ' (' + r.pause.message + ')' : ''));
    assert.strictEqual(r.status, w.S.RunStatus.Running, 'status ' + r.status + (r.pause ? ': ' + r.pause.message : ''));
}

function assertPaused(w, reason, re) {
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Paused, 'status ' + r.status + ' at ' + stepName(w));
    assert.strictEqual(r.pause.reason, reason, 'reason ' + r.pause.reason + ': ' + r.pause.message);
    if (re) assert.ok(re.test(r.pause.message), r.pause.message);
}

function logged(w, re, level) {
    return w.H.logs().some(function (l) {
        return l.category === 'adventures' && (!level || l.level === level) && re.test(l.args.join(' '));
    });
}

// Series transitions logged by state.go(): [{ from, to }] in order.
function transitions(w) {
    var out = [];
    w.H.logs().forEach(function (l) {
        if (l.category !== 'adventures' || l.level !== 'log') return;
        var m = /^([^:]+): (\w+) -> (\w+)/.exec(l.args.join(' '));
        if (m) out.push({ wave: /^wave /.test(m[1]), from: m[2], to: m[3], text: l.args.join(' ') });
    });
    return out;
}

function mapStarts(w) {
    return w.buffActions.filter(function (b) { return b.type === 'Adventure'; });
}

function popBuffs(w) {
    return w.buffActions.filter(function (b) { return b.type === 'AddResource'; })
        .map(function (b) { return b.amount; });
}

function sendsOf(w, key) {
    return w.zoneSends.filter(function (s) { return s.key === key; });
}

function claimsOf(w, key) {
    return w.claims.filter(function (c) { return c.key === key; });
}

// The send went out and its verify is still queued: the moment a reload,
// restart or kernel Pause loses it.
function inFlight(w) {
    assert.ok(w.pending.length > 0, 'the verify is still queued');
    assert.ok(w.st.current().round, 'a round is in flight');
}

// ---- reload and restart -------------------------------------------------------

// A script reload: the same files run again into the same context. The run
// state and the memory-only round survive in the module namespace, the queue
// does not. The stored settings survive too, as the client keeps them.
function reload(w) {
    var settings = w.S.kernel.settings.read('adventures');
    w.H = harness.reload(w.H);
    if (settings) w.H.Steward.kernel.settings.write('adventures', settings);
    w.H.clearQueued();
    w.pending = [];
    w.S = w.H.Steward;
    w.st = w.S.modules.adventures.state;
    w.ex = w.S.modules.adventures.executor;
    w.mod = w.H.module('adventures');
    w.st.now = function () { return w.t; };
    W.patchCore(w);
}

// A client restart: a fresh boot on the same disk. The game keeps what it
// holds (generals, pools, adventures, menu stock, queues, quests); the run
// comes back from its file, and the stored settings survive the fresh boot. The
// record arrays are shared, so counts span the restart.
var SHARED = ['orders', 'raises', 'unloads', 'buffs', 'claims', 'zoneSends', 'buffActions', 'productionOrders',
    'closes', 'visits'];
var CARRIED = ['t', 'adventures', 'stock', 'queues', 'pop', 'popNoEffect', 'quests', 'camps', 'auto',
    'travelMs', 'resources', 'costs', 'blocked', 'pickups'];

function restart(w) {
    var viewed = w.gi.mCurrentViewedZoneID;
    var w2 = W.world({
        home: true, fs: w.fs, generals: w.lists[HOME], away: w.lists[ZONE],
        free: w.frees[HOME], awayFree: w.frees[ZONE],
        settings: w.S.kernel.settings.read('adventures') || {}
    });
    w2.g1 = w.g1;
    w2.g2 = w.g2;
    w2.gi = w2.H.host.game.gi;
    CARRIED.forEach(function (k) { w2[k] = w[k]; });
    Object.keys(w.lists).forEach(function (id) {
        if (Number(id) !== HOME && Number(id) !== ZONE) w2.lists[id] = w.lists[id];
    });
    w2.gi.visitZone(viewed);
    SHARED.forEach(function (k) { w2[k] = w[k]; });
    countVisits(w2);
    w2.mod.boot();
    assert.ok(w2.st.run(), 'the run came back from the file');
    return w2;
}

// ---- 1. full series -----------------------------------------------------------

t.test('series: x2 from home runs every step once, in order, with no pause; map 2 waits GAP_MS', function () {
    var w = homeWorld();
    w.landing([500, 501]);
    series(w, { count: 2 });
    var closed1 = null;
    var ids = [];
    drive(w, { max: 1500, on: function (w2, name) {
        var r = w2.st.run();
        if (ids.indexOf(r.id) < 0) ids.push(r.id);
        if (closed1 === null && w2.st.current().request.finished === 1) closed1 = w2.st.current().request.closedAt;
    } });
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Done, 'status ' + r.status + ' at ' + stepName(w) +
        (r.pause ? ': ' + r.pause.message : ''));
    assert.strictEqual(w.st.current().request.finished, 2);
    assert.strictEqual(ids.length, 2, 'two runs: ' + ids.join(', '));
    assert.ok(!logged(w, /run paused/), 'no pause');

    // Split the log into the two runs at Next -> Muster of run 2 (begin
    // logs no transition, so run 2 starts at its Muster -> Validate).
    var all = transitions(w);
    var runs = null;
    for (var i = 1; i < all.length && !runs; i++) {
        if (all[i].from === 'Muster') runs = [all.slice(0, i), all.slice(i)];
    }
    assert.ok(runs, 'run 2 starts at Muster');
    assert.ok(!all.some(function (x) { return x.from === 'Next'; }), 'no transition leaves Next');
    var order = ['Muster', 'Validate', 'Snapshot', 'Supply', 'Load', 'StartMap', 'Depart', 'Jump', 'Arrive',
        'Pickups', 'StarAll', 'wave Horseshoe', 'wave Gate', 'wave Confirm', 'PackStar', 'Pack', 'Clear', 'LastQuest',
        'Close', 'Recall',
        'JumpHome', 'ArriveHome', 'Account', 'Population'];
    runs.forEach(function (list, n) {
        var seen = {};
        for (var j = 0; j < list.length; j++) {
            var pair = (list[j].wave ? 'wave ' : '') + list[j].from + '->' + list[j].to;
            assert.ok(!seen[pair], 'run ' + (n + 1) + ' logs ' + pair + ' twice');
            seen[pair] = true;
            if (j > 0) assert.strictEqual(list[j].from, list[j - 1].to, 'chain at ' + list[j].text);
        }
        assert.strictEqual(list[0].from, 'Muster');
        assert.strictEqual(list[list.length - 1].to, 'Next');
        var names = list.map(function (x) { return x.wave ? 'wave ' + x.from : x.from; });
        var last = -1;
        order.forEach(function (s) {
            var p = names.indexOf(s);
            assert.ok(p > last, 'run ' + (n + 1) + ': ' + s + ' in order (' + names.join(' ') + ')');
            last = p;
        });
    });

    var maps = mapStarts(w);
    assert.strictEqual(maps.length, 2);
    assert.ok(typeof closed1 === 'number', 'run 1 stored closedAt');
    assert.ok(maps[1].t >= closed1 + w.S.modules.adventures.home.GAP_MS,
        'map 2 at ' + maps[1].t + ', run 1 closed at ' + closed1);
    assert.strictEqual(w.closes.length, 2);
    assert.strictEqual(sendsOf(w, '1.1').length, 4, 'there and back twice');
    assert.strictEqual(sendsOf(w, '1.2').length, 4);
});

// ---- 2. Muster ------------------------------------------------------------------

t.test('Muster: a general on another zone waits with no limit, named, and goes on once he is home', function () {
    var w = homeWorld();
    w.lists[HOME].splice(w.lists[HOME].indexOf(w.g2), 1);
    w.place(w.g2, 9);
    series(w);
    tick(w);
    W.ticksFor(w, LONG_MS);
    assertStep(w, 'Muster');
    waiting(w, /1\.2 not here yet/);
    assert.ok(logged(w, /1\.2 not here yet, waited 60 min/), 'the wait is logged');
    w.lists[9].length = 0;
    w.place(w.g2, HOME);
    tick(w);
    assertStep(w, 'Validate');
});

t.test('Muster: a busy general never pauses', function () {
    var w = homeWorld();
    var r = series(w);
    w.g2.state.task = { type: w.code.move, remaining: 5000 };
    tick(w);
    assert.ok(logged(w, /Bert \(1\.2\) busy, waited 0 min, remaining 5000/), 'the busy general is logged');
    w.t = r.since + LONG_MS;
    tick(w);
    assertStep(w, 'Muster');
    w.g2.state.task = null;
    tick(w);
    assertStep(w, 'Validate');
});

t.test('Muster: generals home and idle go on to Validate', function () {
    var w = homeWorld();
    series(w);
    tick(w);
    assertStep(w, 'Validate');
});

t.test('gather: one unreadable list after a long busy wait keeps the wait and does not pause', function () {
    var w = homeWorld();
    series(w);
    w.g2.state.task = { type: w.code.move };
    tick(w);
    w.t += LONG_MS;
    tick(w);
    var zone = w.gi.mCurrentPlayerZone;
    var list = zone.GetSpecialists_vector;
    zone.GetSpecialists_vector = function () { return null; };
    tick(w);
    assertStep(w, 'Muster');
    waiting(w, /Bert \(1\.2\) busy/);
    assert.strictEqual(w.st.run().waitUntil, null, 'a read wait has no window');
    zone.GetSpecialists_vector = list;
    tick(w);
    assertStep(w, 'Muster');
    waiting(w, /Bert \(1\.2\) busy/);
    w.g2.state.task = null;
    tick(w);
    assertStep(w, 'Validate');
});

// ---- 3. Validate ----------------------------------------------------------------

t.test('Validate: a wave file edited to a fatal problem pauses WaveFile; Resume after the fix continues', function () {
    var w = homeWorld();
    series(w, { step: w.S.RunStep.Validate });
    var good = w.fs.disk[WAVE];
    writeJson(w.fs, WAVE, { '1.7': { grid: 10, target: 100, army: { Rifle: 1 }, order: 1 } });
    tick(w);
    assertPaused(w, w.S.RunPause.WaveFile, /1\.7/);
    w.fs.disk[WAVE] = good;
    assert.strictEqual(w.S.modules.adventures.run.resume(), true);
    assertStep(w, 'Validate');
    tick(w);
    assertStep(w, 'Snapshot');
});

t.test('Validate: a general gone since Muster waits with no pause, and goes on when he is back', function () {
    var w = homeWorld();
    series(w, { step: w.S.RunStep.Validate });
    w.lists[HOME].splice(w.lists[HOME].indexOf(w.g2), 1);
    for (var i = 0; i < 4; i++) {
        tick(w);
        assertStep(w, 'Validate');
        W.ticksFor(w, PASS_MS);
    }
    waiting(w, /1\.2 not here yet/);
    assert.ok(!logged(w, /start check/), 'a wait does not run the check');
    w.lists[HOME].push(w.g2);
    tick(w);
    assertStep(w, 'Snapshot');
});

t.test('Validate: a general leaving between the read and the check waits', function () {
    var w = homeWorld();
    series(w, { step: w.S.RunStep.Validate });
    w.afterRead(function () { w.lists[HOME].splice(w.lists[HOME].indexOf(w.g2), 1); });
    tick(w);
    assertStep(w, 'Validate');
    waiting(w, /Bert \(1\.2\) not here yet/);
    w.lists[HOME].push(w.g2);
    tick(w);
    assertStep(w, 'Snapshot');
});

t.test('Validate: a real fault beside an absent general still pauses', function () {
    var w = homeWorld();
    series(w, { step: w.S.RunStep.Validate });
    writeJson(w.fs, WAVE, { '1.7': { grid: 10, target: 100, army: { Rifle: 1 }, order: 1 } });
    w.afterRead(function () { w.lists[HOME].splice(w.lists[HOME].indexOf(w.g2), 1); });
    tick(w);
    assertPaused(w, w.S.RunPause.WaveFile, /1\.7/);
    // Both problems are about 1.7; the absent general adds none.
    assert.ok(/\(2 problem\(s\)\)/.test(w.st.run().pause.message), w.st.run().pause.message);
    assert.ok(!/1\.2/.test(w.st.run().pause.message), w.st.run().pause.message);
});

// ---- 4. Snapshot ----------------------------------------------------------------

t.test('Snapshot: total plus queued per loadout unit; units outside the loadout are left out', function () {
    var w = homeWorld({ free: { Rifle: 20, Bow: 7 } });
    w.g1.state.army = { Rifle: 2 };
    w.queues[0].entries.push({ type: 'Rifle', amount: 4 });
    series(w, { step: w.S.RunStep.Snapshot });
    tick(w);
    assertStep(w, 'Supply');
    assert.deepStrictEqual(plain(w.st.run().snapshot), { Rifle: 26 });
    assert.ok(logged(w, /snapshot: /));
});

t.test('Snapshot: held with no limit while the queue is unreadable, counted once it reads', function () {
    var w = homeWorld();
    var zone = w.gi.mCurrentPlayerZone;
    var queue = zone.GetProductionQueue;
    zone.GetProductionQueue = function () { return null; };
    series(w, { step: w.S.RunStep.Snapshot });
    tick(w);
    assertStep(w, 'Snapshot');
    W.ticksFor(w, LONG_MS);
    assertStep(w, 'Snapshot');
    waiting(w, /production queue of Rifle not readable/);
    assert.strictEqual(w.st.run().snapshot, null);
    zone.GetProductionQueue = queue;
    tick(w);
    assertStep(w, 'Supply');
    assert.ok(w.st.run().snapshot, 'counted');
});

// ---- 5. Home load ---------------------------------------------------------------

t.test('Home load: a donor outside the loadout is unloaded and named, then the loadout is loaded', function () {
    var g3 = gen('1.3', 'Cora', 30, { Rifle: 10 });
    var w = homeWorld({ free: { Rifle: 0 } });
    w.place(g3, HOME);
    series(w, { step: w.S.RunStep.Supply, run: { snapshot: { Rifle: 10 } } });
    drive(w, { until: at('StartMap') });
    assertStep(w, 'StartMap');
    assert.deepStrictEqual(w.unloads, ['1.3']);
    assert.ok(logged(w, /Supply -> Unload \(unload 1\.3\)/), 'the donor is named');
    assert.deepStrictEqual(plain(w.g1.state.army), { Rifle: 5 });
    assert.deepStrictEqual(plain(w.g2.state.army), { Rifle: 3 });
});

t.test('Home load: short but covered by the queue waits without a pause, then loads', function () {
    var w = homeWorld({ free: { Rifle: 4 } });
    w.queues[0].entries.push({ type: 'Rifle', amount: 10 });
    series(w, { step: w.S.RunStep.Supply, run: { snapshot: { Rifle: 14 } } });
    for (var i = 0; i < 5; i++) { tick(w); play(w); w.t += 60000; }
    assertStep(w, 'Supply');
    assert.ok(/^waiting for production: /.test(w.st.run().blocker.reason), w.st.run().blocker.reason);
    assert.strictEqual(w.raises.length, 0);
    w.produce();
    drive(w, { until: at('StartMap') });
    assertStep(w, 'StartMap');
    assert.strictEqual(w.st.run().blocker, null);
});

t.test('Home load: short and not covered pauses TroopsShort', function () {
    var w = homeWorld({ free: { Rifle: 4 } });
    series(w, { step: w.S.RunStep.Supply, run: { snapshot: { Rifle: 4 } } });
    tick(w);
    assertStep(w, 'Supply');
    w.t += w.S.modules.adventures.loader.READ_LAG_MS;
    tick(w);
    assertPaused(w, w.S.RunPause.TroopsShort, /troops short: /);
    assert.strictEqual(w.raises.length, 0);
});

t.test('Home load: short with a busy general outside the loadout still pauses TroopsShort after the hold', function () {
    var w = homeWorld({ free: { Rifle: 4 } });
    w.place(gen('1.3', 'Cora', 30, {}, { task: { type: w.code.attack } }), HOME);
    series(w, { step: w.S.RunStep.Supply, run: { snapshot: { Rifle: 4 } } });
    tick(w);
    assertStep(w, 'Supply');
    assert.ok(!logged(w, /busy, troops short/), 'no wait at home');
    w.t += w.S.modules.adventures.loader.READ_LAG_MS;
    tick(w);
    assertPaused(w, w.S.RunPause.TroopsShort, /troops short: /);
    assert.strictEqual(w.unloads.length, 0);
});

t.test('Home load: donors over the cycle cap still pause', function () {
    var l = null;
    var w = homeWorld({ free: { Rifle: 0 } });
    l = w.S.modules.adventures.loader;
    w.place(gen('1.3', 'Cora', 30, { Rifle: 10 }), HOME);
    series(w, { step: w.S.RunStep.Supply, run: { snapshot: { Rifle: 10 }, cycles: l.MAX_UNLOAD_CYCLES } });
    tick(w);
    assertStep(w, 'Supply');
    w.t += l.READ_LAG_MS;
    tick(w);
    assertPaused(w, w.S.RunPause.TroopsShort, /donors unloaded/);
    assert.strictEqual(w.unloads.length, 0);
});

t.test('Home load: partial donors still pause without an unload', function () {
    var w = homeWorld({ free: { Rifle: 0 } });
    w.place(gen('1.3', 'Cora', 30, { Rifle: 2 }), HOME);
    series(w, { step: w.S.RunStep.Supply, run: { snapshot: { Rifle: 2 } } });
    tick(w);
    assertStep(w, 'Supply');
    w.t += w.S.modules.adventures.loader.READ_LAG_MS;
    tick(w);
    assertPaused(w, w.S.RunPause.TroopsShort, /troops short: /);
    assert.deepStrictEqual(w.unloads, []);
});

// ---- 6. StartMap ----------------------------------------------------------------

t.test('StartMap: an open map is taken as it is, with zoneId from own(), and no start is sent', function () {
    var w = homeWorld({ mapOpen: true });
    series(w, { step: w.S.RunStep.StartMap });
    tick(w);
    assertStep(w, 'Depart');
    assert.strictEqual(w.st.run().zoneId, ZONE);
    assert.strictEqual(mapStarts(w).length, 0);
});

t.test('StartMap: one map start is sent and the listed map gives the zoneId', function () {
    var w = homeWorld();
    series(w, { step: w.S.RunStep.StartMap });
    drive(w, { until: at('Depart') });
    assertStep(w, 'Depart');
    assert.strictEqual(mapStarts(w).length, 1);
    assert.strictEqual(w.st.run().zoneId, ZONE);
    assert.strictEqual(w.st.run().marks.map.seen, true);
});

t.test('StartMap: a reload after the send and before the verify sends no second start', function () {
    var w = homeWorld();
    w.auto.map = false;
    series(w, { step: w.S.RunStep.StartMap });
    tick(w);
    play(w, function () { return mapStarts(w).length === 1; });
    inFlight(w);
    reload(w);
    for (var i = 0; i < 5; i++) { tick(w); play(w); w.t += 5000; }
    assertStep(w, 'StartMap');
    w.adventures.push({ adventureName: 'BlackKnights', zoneID: ZONE });
    tick(w);
    assertStep(w, 'Depart');
    assert.strictEqual(mapStarts(w).length, 1);
});

// ---- 7. Depart ------------------------------------------------------------------

t.test('Depart: one sendToZone per general, then Jump with no arrival deadline', function () {
    var w = homeWorld({ mapOpen: true });
    series(w, { step: w.S.RunStep.Depart, zoneId: ZONE });
    var passes = drive(w, { until: at('Jump') });
    assertStep(w, 'Jump');
    assert.ok(passes > 0);
    assert.strictEqual(sendsOf(w, '1.1').length, 1);
    assert.strictEqual(sendsOf(w, '1.2').length, 1);
    assert.strictEqual(w.zoneSends[0].zoneId, ZONE);
    assert.strictEqual(w.st.run().marks.arrive, undefined, 'travel time sets no deadline');
});

t.test('Depart: a reload mid-send sends no second sendToZone', function () {
    var w = homeWorld({ mapOpen: true });
    series(w, { step: w.S.RunStep.Depart, zoneId: ZONE });
    tick(w);
    play(w, function () { return w.zoneSends.length === 1; });
    inFlight(w);
    reload(w);
    drive(w, { until: at('Jump') });
    assertStep(w, 'Jump');
    assert.strictEqual(sendsOf(w, '1.1').length, 1);
    assert.strictEqual(sendsOf(w, '1.2').length, 1);
});

t.test('Depart: a general gone from home without a mark pauses GeneralMissing', function () {
    var w = homeWorld({ mapOpen: true });
    w.lists[HOME].splice(w.lists[HOME].indexOf(w.g2), 1);
    series(w, { step: w.S.RunStep.Depart, zoneId: ZONE });
    tick(w);
    W.ticksFor(w, w.S.modules.adventures.loader.MISSING_GRACE_MS - 1);
    assertStep(w, 'Depart');
    w.t += 1;
    tick(w);
    assertPaused(w, w.S.RunPause.GeneralMissing, /1\.2 left home without being sent/);
    assert.strictEqual(w.zoneSends.length, 0);
});

t.test('Depart: idle generals leave while one is busy; Jump only once he has gone too', function () {
    var w = homeWorld({ mapOpen: true });
    w.g2.state.task = { type: w.code.move };
    series(w, { step: w.S.RunStep.Depart, zoneId: ZONE });
    tick(w);
    play(w);
    assert.strictEqual(sendsOf(w, '1.1').length, 1);
    assert.strictEqual(sendsOf(w, '1.2').length, 0);
    w.t += 3600000;
    tick(w);
    play(w);
    assertStep(w, 'Depart');
    w.g2.state.task = null;
    drive(w, { until: at('Jump') });
    assertStep(w, 'Jump');
    assert.strictEqual(sendsOf(w, '1.1').length, 1);
    assert.strictEqual(sendsOf(w, '1.2').length, 1);
});

var THREE = { '1.1': true, '1.2': true, '1.3': true };

// Anna is ready, Bert and Cora are busy and get ready one pass after the
// other, with the time a read may lag in between. No finished round may count.
function oneAtATime(w, g3) {
    var lag = loaderOf(w).READ_LAG_MS;
    function pass() {
        tick(w);
        play(w);
        w.t += lag;
        assert.strictEqual(w.st.run().rounds, 0);
    }
    w.g2.state.task = { type: w.code.move };
    g3.state.task = { type: w.code.move };
    pass();
    w.g2.state.task = null;
    pass();
    g3.state.task = null;
    pass();
    tick(w);
}

t.test('Depart: three generals ready one at a time never pause', function () {
    var w = homeWorld({ mapOpen: true });
    var g3 = w.place(gen('1.3', 'Cora', 30), HOME);
    series(w, { step: w.S.RunStep.Depart, zoneId: ZONE, keys: THREE });
    oneAtATime(w, g3);
    assertStep(w, 'Jump');
    Object.keys(THREE).forEach(function (k) {
        assert.strictEqual(sendsOf(w, k).length, 1, k);
    });
});

t.test('Depart: a verified send that never shows stays one send and pauses NotObserved after ORDER_WAIT_MS', function () {
    var w = homeWorld({ mapOpen: true });
    series(w, { step: w.S.RunStep.Depart, zoneId: ZONE });
    // The send verified, then a later read shows him at home and idle.
    function back(g) {
        var list = w.lists[ZONE];
        list.splice(list.indexOf(g), 1);
        w.lists[HOME].push(g);
        g.state.task = null;
        g.state.travelling = false;
    }
    tick(w);
    play(w);
    back(w.g1);
    back(w.g2);
    var end = w.st.run().marks['depart:1.1'].sentAt + loaderOf(w).ORDER_WAIT_MS;
    passesFor(w, end - 1 - w.t);
    assertStep(w, 'Depart');
    waiting(w, /departure of 1\.1 sent, waiting to see it/);
    w.t = end;
    tick(w);
    assertPaused(w, w.S.RunPause.NotObserved, /departure of 1\.1 sent but not seen/);
    assert.strictEqual(w.st.run().pause.general, '1.1');
    assert.strictEqual(w.st.run().rounds, 0);
    assert.strictEqual(sendsOf(w, '1.1').length, 1);
    assert.strictEqual(sendsOf(w, '1.2').length, 1);
});

t.test('Depart: a failed send still pauses DepartFailed while another general is ready', function () {
    var w = homeWorld({ mapOpen: true });
    var orders = w.S.core.specialists.orders;
    var send = orders.sendToZone;
    orders.sendToZone = function (key) {
        var def = send.apply(orders, arguments);
        if (key !== '1.1') return def;
        return { label: def.label, timeoutMs: 15000,
            send: function () { return false; }, check: function () { return false; } };
    };
    w.g2.state.task = { type: w.code.move };
    series(w, { step: w.S.RunStep.Depart, zoneId: ZONE });
    tick(w);
    play(w);
    w.g2.state.task = null;
    tick(w);
    play(w);
    assertPaused(w, w.S.RunPause.DepartFailed, /send 1\.1 failed/);
    assert.strictEqual(sendsOf(w, '1.2').length, 0);
});

// The bridge sometimes lists the specialists for one read with a general
// left out. None of these reads may end in a pause.

function specialistLogged(w, re) {
    return w.H.logs().some(function (l) { return l.category === 'specialists' && re.test(l.args.join(' ')); });
}

// Wraps lib[fn] so that the def it builds for key hides g from one list read
// (w.hideReads mode), once: before its precheck runs, or with o.after right
// after a precheck that passed. Returns a counter of the hides armed.
function hideAtPrecheck(w, lib, fn, key, g, o) {
    o = o || {};
    var make = lib[fn];
    var armed = { n: 0 };
    lib[fn] = function (k) {
        var def = make.apply(lib, arguments);
        if (k !== key) return def;
        var pre = def.precheck;
        def.precheck = function () {
            if (!o.after && !armed.n) {
                armed.n++;
                w.hideReads(g, 1, o.mode);
            }
            var why = pre.apply(def, arguments);
            if (o.after && why === null && !armed.n) {
                armed.n++;
                w.hideReads(g, 1, o.mode);
            }
            return why;
        };
        return def;
    };
    return armed;
}

t.test('Depart: a general hidden from the read after his precheck is sent once, verified, no pause', function () {
    var w = homeWorld({ mapOpen: true });
    var armed = hideAtPrecheck(w, w.S.core.specialists.orders, 'sendToZone', '1.1', w.g1, { after: true });
    series(w, { step: w.S.RunStep.Depart, zoneId: ZONE });
    drive(w, { until: at('Jump') });
    assertStep(w, 'Jump');
    assert.strictEqual(armed.n, 1, 'the read after the precheck was hidden');
    assert.strictEqual(sendsOf(w, '1.1').length, 1);
    assert.strictEqual(sendsOf(w, '1.2').length, 1);
    assert.strictEqual(w.st.run().marks['depart:1.1'].seen, true, 'verified');
    assert.ok(!logged(w, /run paused/));
});

t.test('Depart: a general hidden from his precheck read is found again; he leaves with no pause', function () {
    var w = homeWorld({ mapOpen: true });
    var armed = hideAtPrecheck(w, w.S.core.specialists.orders, 'sendToZone', '1.1', w.g1);
    series(w, { step: w.S.RunStep.Depart, zoneId: ZONE });
    tick(w);
    play(w);
    if (!sendsOf(w, '1.1').length) {
        w.t += 1000;
        tick(w);
        play(w);
    }
    assert.strictEqual(armed.n, 1, 'the precheck read was hidden');
    assert.strictEqual(sendsOf(w, '1.1').length, 1, 'sent on that pass or the next');
    assert.ok(specialistLogged(w, /lookup 1\.1 found on read 2 of /), 'the re-read found him');
    drive(w, { until: at('Jump') });
    assertStep(w, 'Jump');
    assert.strictEqual(sendsOf(w, '1.1').length, 1);
    assert.strictEqual(sendsOf(w, '1.2').length, 1);
    assert.ok(!logged(w, /run paused/));
});

t.test('Depart: a general hidden from the step read after the inventory still leaves with no pause', function () {
    var w = homeWorld({ mapOpen: true });
    series(w, { step: w.S.RunStep.Depart, zoneId: ZONE });
    w.afterRead(function () { w.hideReads(w.g1, 1); });
    drive(w, { until: at('Jump') });
    assertStep(w, 'Jump');
    assert.strictEqual(sendsOf(w, '1.1').length, 1);
    assert.strictEqual(sendsOf(w, '1.2').length, 1);
    assert.ok(!logged(w, /run paused/));
});

t.test('Depart: a null slot in place of a general at his precheck holds without a pause', function () {
    var w = homeWorld({ mapOpen: true });
    var armed = hideAtPrecheck(w, w.S.core.specialists.orders, 'sendToZone', '1.1', w.g1, { mode: 'falsy' });
    series(w, { step: w.S.RunStep.Depart, zoneId: ZONE });
    tick(w);
    play(w);
    assert.strictEqual(armed.n, 1, 'the precheck read had a null slot');
    assert.strictEqual(sendsOf(w, '1.1').length, 0, 'the unreadable read sent nothing');
    assert.strictEqual(sendsOf(w, '1.2').length, 1);
    assertStep(w, 'Depart');
    drive(w, { until: at('Jump') });
    assertStep(w, 'Jump');
    assert.strictEqual(sendsOf(w, '1.1').length, 1);
    assert.strictEqual(sendsOf(w, '1.2').length, 1);
    assert.ok(!logged(w, /run paused/));
});

t.test('Load: a loadout general hidden from his raise precheck read is raised, with no LoadMismatch', function () {
    var smuggler = gen('1.1', 'The Smuggler', 10);
    var w = homeWorld({ generals: [smuggler, gen('1.2', 'Bert', 20)] });
    var armed = hideAtPrecheck(w, w.S.core.army, 'raise', '1.1', smuggler);
    series(w, { step: w.S.RunStep.Supply, run: { snapshot: { Rifle: 20 } } });
    drive(w, { until: at('StartMap') });
    assertStep(w, 'StartMap');
    assert.strictEqual(armed.n, 1, 'the precheck read was hidden');
    assert.deepStrictEqual(w.raises.filter(function (k) { return k === '1.1'; }), ['1.1'], 'one raise');
    assert.deepStrictEqual(plain(smuggler.state.army), { Rifle: 5 });
    assert.ok(specialistLogged(w, /lookup 1\.1 found on read 2 of /), 'the re-read found him');
    assert.ok(!logged(w, /run paused/));
});

// ---- 8. Jump and Arrive -----------------------------------------------------------

t.test('Jump: a zone that does not load is visited again at JUMP_MS, then JUMP_RETRY_MS; only a gone adventure pauses', function () {
    var w = homeWorld({ mapOpen: true });
    var away = w.S.modules.adventures.away;
    w.auto.visit = false;
    series(w, { step: w.S.RunStep.Jump, zoneId: ZONE });
    tick(w);
    assert.strictEqual(w.visits.length, 1);
    w.t += away.JUMP_MS;
    tick(w);
    assert.strictEqual(w.visits.length, 1);
    w.t += 1;
    tick(w);
    assert.strictEqual(w.visits.length, 2);
    assert.ok(logged(w, /visiting again/));
    w.t += away.JUMP_RETRY_MS;
    tick(w);
    assert.strictEqual(w.visits.length, 2);
    w.t += 1;
    tick(w);
    assert.strictEqual(w.visits.length, 3);
    W.ticksFor(w, LONG_MS);
    assertStep(w, 'Jump');
    waiting(w, /zone 7 not loaded/);
    w.adventures = [];
    tick(w);
    W.ticksFor(w, loaderOf(w).MISSING_GRACE_MS - 1);
    assertStep(w, 'Jump');
    w.t += 1;
    tick(w);
    assertPaused(w, w.S.RunPause.JumpFailed, /adventure no longer open/);
});

t.test('Jump: a zone that loads goes on to Arrive', function () {
    var w = homeWorld({ mapOpen: true });
    series(w, { step: w.S.RunStep.Jump, zoneId: ZONE });
    tick(w);
    tick(w);
    assertStep(w, 'Arrive');
    assert.strictEqual(w.visits.length, 1);
});

t.test('Arrive: waits per general key, not by count', function () {
    var w = homeWorld();
    var g4 = gen('1.4', 'Dora', 40);
    onIsland(w, [w.g1, g4]);
    series(w, { step: w.S.RunStep.Arrive, zoneId: ZONE });
    for (var i = 0; i < 3; i++) { tick(w); w.t += 60000; }
    assertStep(w, 'Arrive');
    w.place(w.g2, ZONE);
    tick(w);
    assertStep(w, 'Pickups');
});

t.test('Arrive: a general still missing waits with no limit, past a stale arrive mark, and goes on once he is here', function () {
    var w = homeWorld();
    onIsland(w, [w.g1]);
    var r = series(w, { step: w.S.RunStep.Arrive, zoneId: ZONE });
    r.marks.arrive = { sentAt: w.t + 5000, seen: false, sentOnce: false };
    tick(w);
    assertStep(w, 'Arrive');
    W.ticksFor(w, LONG_MS);
    assertStep(w, 'Arrive');
    waiting(w, /1\.2 not here yet/);
    w.place(w.g2, ZONE);
    tick(w);
    assertStep(w, 'Pickups');
});

t.test('arrival: an unread main quest is read during Arrive, before StarAll', function () {
    var w = homeWorld();
    onIsland(w, null, {});
    w.quests = [{ key: 'm1', name: 'Main', unread: true, last: false }];
    series(w, { step: w.S.RunStep.Arrive, zoneId: ZONE });
    drive(w, { until: at('StarAll') });
    assertStep(w, 'StarAll');
    assert.deepStrictEqual(w.reads.map(function (r) { return r.key; }), ['m1']);
    var logs = w.H.logs().map(function (l) { return l.args.join(' '); });
    var readAt = -1;
    var starAt = -1;
    logs.forEach(function (text, i) {
        if (/quest Main read/.test(text) && readAt < 0) readAt = i;
        if (/-> StarAll/.test(text) && starAt < 0) starAt = i;
    });
    assert.ok(readAt >= 0, 'the read is logged');
    assert.ok(starAt > readAt, 'the read comes before the transition into StarAll');
});

t.test('Arrive: a listed busy general far past the deadline stays Running, then goes to Pickups', function () {
    var w = homeWorld();
    onIsland(w);
    w.g2.state.travelling = true;
    w.g2.state.task = { type: w.code.travel, remaining: 1000 };
    var r = series(w, { step: w.S.RunStep.Arrive, zoneId: ZONE });
    r.marks.arrive = { sentAt: w.t + 5000, seen: false, sentOnce: false };
    tick(w);
    w.t += LONG_MS;
    tick(w);
    assertStep(w, 'Arrive');
    w.arrive();
    tick(w);
    assertStep(w, 'Pickups');
});

t.test('Arrive: a missing general next to a busy one waits with no limit and the wait names him', function () {
    var w = homeWorld();
    onIsland(w, [w.g1]);
    w.g1.state.task = { type: w.code.move };
    var r = series(w, { step: w.S.RunStep.Arrive, zoneId: ZONE });
    r.marks.arrive = { sentAt: w.t + 5000, seen: false, sentOnce: false };
    tick(w);
    W.ticksFor(w, LONG_MS);
    assertStep(w, 'Arrive');
    waiting(w, /1\.2 not here yet/);
    w.g1.state.task = null;
    w.place(w.g2, ZONE);
    tick(w);
    assertStep(w, 'Pickups');
});

t.test('Arrive: nothing busy, armies unreadable holds with no limit and goes on once they read', function () {
    var w = homeWorld();
    onIsland(w);
    var zone = w.H.host.game.zone;
    var army = zone.GetArmy;
    zone.GetArmy = function () { return null; };
    var r = series(w, { step: w.S.RunStep.Arrive, zoneId: ZONE });
    r.marks.arrive = { sentAt: w.t + 5000, seen: false, sentOnce: false };
    tick(w);
    W.ticksFor(w, LONG_MS);
    assertStep(w, 'Arrive');
    waiting(w, /armies not readable/);
    zone.GetArmy = army;
    tick(w);
    assertStep(w, 'Pickups');
});

// ---- 9. StarAll -----------------------------------------------------------------

t.test('StarAll: every general is starred and verified empty at the star', function () {
    var w = homeWorld();
    w.g1.state.army = { Rifle: 5 };
    onIsland(w);
    series(w, { step: w.S.RunStep.StarAll, zoneId: ZONE });
    drive(w, { until: at('Horseshoe') });
    assertStep(w, 'Horseshoe');
    var stars = w.orders.filter(function (o) { return o.code === w.code.star; });
    assert.deepStrictEqual(stars.map(function (o) { return o.key; }).sort(), ['1.1', '1.2']);
    assert.strictEqual(w.g1.state.grid, 0);
    assert.deepStrictEqual(plain(w.g1.state.army), {});
    assert.strictEqual(w.frees[ZONE].Rifle, 5);
});

t.test('StarAll: a general that keeps its army at the star pauses StarFailed or NotObserved', function () {
    var w = homeWorld();
    w.g1.state.army = { Rifle: 5 };
    onIsland(w);
    var send = w.gi.SendServerAction;
    w.gi.SendServerAction = function (id, p1) {
        send.apply(this, arguments);
        if (p1 === w.code.star) w.g1.state.army = { Rifle: 5 };
    };
    series(w, { step: w.S.RunStep.StarAll, zoneId: ZONE });
    drive(w, { max: 300 });
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Paused, 'status ' + r.status + ' at ' + stepName(w));
    assert.strictEqual(stepName(w), 'StarAll');
    assert.ok(r.pause.reason === w.S.RunPause.StarFailed || r.pause.reason === w.S.RunPause.NotObserved,
        r.pause.reason + ': ' + r.pause.message);
});

t.test('StarAll: an unlisted general with an unreadable inventory is not counted as starred and holds with no limit (M1)', function () {
    var w = homeWorld();
    w.g1.state.grid = 0;
    onIsland(w, [w.g1]);
    var zone = w.H.host.game.zone;
    var army = zone.GetArmy;
    zone.GetArmy = function () { return null; };
    series(w, { step: w.S.RunStep.StarAll, zoneId: ZONE });
    tick(w);
    W.ticksFor(w, LONG_MS);
    assertStep(w, 'StarAll');
    waiting(w, /generals not readable/);
    assert.strictEqual(w.orders.filter(function (o) { return o.code === w.code.star; }).length, 0);
    zone.GetArmy = army;
    tick(w);
    assertStep(w, 'Horseshoe');
});

// ---- 10. Horseshoe ----------------------------------------------------------------

t.test('Horseshoe: none in stock only warns and goes on to Gate', function () {
    var w = homeWorld();
    onIsland(w);
    series(w, { step: w.S.RunStep.Horseshoe, zoneId: ZONE, speedBuff: 'SpeedBuffDefault' });
    tick(w);
    assertStep(w, 'Gate');
    assert.ok(logged(w, /no horseshoe in stock/, 'warn'));
});

t.test('Horseshoe: a reload after the send sends it at most once', function () {
    var w = homeWorld();
    onIsland(w);
    w.stock.push({ type: 'GeneralSpeedBuff_A', resource: '', amount: 2, uid: 'spd' });
    series(w, { step: w.S.RunStep.Horseshoe, zoneId: ZONE, speedBuff: 'GeneralSpeedBuff_A' });
    function speeds() { return w.buffActions.filter(function (b) { return b.type === 'GeneralSpeedBuff_A'; }); }
    tick(w);
    play(w, function () { return speeds().length === 1; });
    inFlight(w);
    reload(w);
    tick(w);
    assertStep(w, 'Gate');
    assert.ok(logged(w, /horseshoe already sent/));
    assert.strictEqual(speeds().length, 1);
});

// ---- 11. Waves and the watcher ---------------------------------------------------

t.test('waves: hand over to PackStar and reach Clear; the watcher claims a non-last quest and never the last', function () {
    var w = homeWorld();
    w.g1.state.grid = 0;
    w.g2.state.grid = 0;
    w.landing([500, 501]);
    onIsland(w, null, { Rifle: 8 });
    w.quests = [
        { key: 'q1', name: 'Side', finished: true, last: false },
        { key: 'q9', name: 'Final', finished: true, last: true }
    ];
    series(w, { step: w.S.WaveStep.Gate, zoneId: ZONE });
    drive(w, { help: false, until: at('Clear'), on: function (w2, name) {
        if (name === 'Confirm') help(w2, name);
    } });
    assertStep(w, 'Clear');
    var names = transitions(w).map(function (x) { return (x.wave ? 'wave ' : '') + x.from + '->' + x.to; });
    assert.ok(names.indexOf('wave Confirm->PackStar') >= 0, names.join(', '));
    assert.ok(names.indexOf('Pack->Clear') >= 0, names.join(', '));
    assert.strictEqual(claimsOf(w, 'q1').length, 1);
    assert.ok(!(claimsOf(w, 'q1')[0].opts && claimsOf(w, 'q1')[0].opts.allowLast), 'the watcher never allows the last');
    assert.strictEqual(claimsOf(w, 'q9').length, 0);
    assert.strictEqual(w.orders.filter(function (o) { return o.code === w.code.attack; }).length, 2);
});

t.test('watcher: claims nothing while home is viewed', function () {
    var w = homeWorld({ mapOpen: true });
    w.quests = [
        { key: 'q1', name: 'Side', finished: true, last: false },
        { key: 'q2', name: 'Main', unread: true, last: false }
    ];
    series(w, { step: w.S.RunStep.Jump, zoneId: ZONE });
    w.auto.visit = false;
    for (var i = 0; i < 3; i++) { tick(w); play(w); }
    assert.strictEqual(w.claims.length, 0);
    assert.strictEqual(w.reads.length, 0);
    series(w, { step: w.S.RunStep.LastQuest, zoneId: ZONE });
    for (i = 0; i < 3; i++) { tick(w); play(w); }
    assert.strictEqual(w.claims.length, 0);
    assert.strictEqual(w.reads.length, 0);
});

// ---- 12. Clear --------------------------------------------------------------------

// The pause text of Clear for a limit read from the module.
function timeoutText(limit) {
    return new RegExp('last quest not finished after ' + Math.round(limit / 60000) + ' min');
}

t.test('Clear: waits for the last quest and idle generals; a camp still standing only warns', function () {
    var w = homeWorld();
    // Nothing left to pack, so the clear map goes on to the last quest.
    onIsland(w, null, {});
    series(w, { step: w.S.RunStep.Clear, zoneId: ZONE });
    tick(w);
    assertStep(w, 'Clear');
    lastQuest(w).finished = true;
    w.g1.state.task = { type: w.code.attack };
    tick(w);
    assertStep(w, 'Clear');
    w.g1.state.task = null;
    tick(w);
    assertStep(w, 'LastQuest');
    assert.ok(logged(w, /camps still standing after the last quest: 100, 200/, 'warn'));
});

t.test('Clear: ClearTimeout after CLEAR_MAX_MS of quiet', function () {
    var w = homeWorld();
    var limit = w.S.modules.adventures.away.CLEAR_MAX_MS;
    onIsland(w);
    series(w, { step: w.S.RunStep.Clear, zoneId: ZONE });
    tick(w);
    W.ticksFor(w, limit - 1);
    assertStep(w, 'Clear');
    waiting(w, /last quest not finished, \d+ of \d+ min quiet/);
    w.t += 1;
    tick(w);
    assertPaused(w, w.S.RunPause.ClearTimeout, timeoutText(limit));
});

t.test('Clear: quest done, a general busy far past CLEAR_MAX_MS stays Running', function () {
    var w = homeWorld();
    onIsland(w, null, {});
    var r = series(w, { step: w.S.RunStep.Clear, zoneId: ZONE });
    lastQuest(w).finished = true;
    w.g1.state.task = { type: w.code.attack };
    tick(w);
    w.t = r.since + w.S.modules.adventures.away.CLEAR_MAX_MS * 3;
    tick(w);
    assertStep(w, 'Clear');
    assert.ok(logged(w, /Anna \(1\.1\) busy/), 'the wait is logged');
    w.g1.state.task = null;
    tick(w);
    assertStep(w, 'LastQuest');
});

t.test('Clear: a recovering general is not waited on; Clear goes on to the last quest', function () {
    var w = homeWorld();
    onIsland(w, null, {});
    var r = series(w, { step: w.S.RunStep.Clear, zoneId: ZONE });
    lastQuest(w).finished = true;
    w.g1.state.task = { type: w.code.recover };
    tick(w);
    w.t = r.since + w.S.modules.adventures.away.CLEAR_MAX_MS * 3;
    tick(w);
    assertStep(w, 'LastQuest');
    assert.ok(!logged(w, /Anna \(1\.1\) busy/), 'no busy wait on him');
    assert.ok(!logged(w, /left in the free pool/), 'nothing left over, no warning');
});

t.test('Clear: troops only the recovering general could hold stay, with one warning', function () {
    var w = homeWorld();
    onIsland(w, null, { Rifle: 4 });
    series(w, { step: w.S.RunStep.Clear, zoneId: ZONE, keys: { '1.1': true } });
    lastQuest(w).finished = true;
    w.g1.state.task = { type: w.code.recover };
    tick(w);
    assertStep(w, 'LastQuest');
    var hits = w.H.logs().filter(function (l) {
        return l.category === 'adventures' && l.level === 'warn' &&
            /left in the free pool while .*Anna.* recover/.test(l.args.join(' '));
    });
    assert.strictEqual(hits.length, 1, 'one warning');
});

t.test('Clear: a general on a move task still holds the step', function () {
    var w = homeWorld();
    onIsland(w, null, {});
    series(w, { step: w.S.RunStep.Clear, zoneId: ZONE });
    lastQuest(w).finished = true;
    w.g1.state.task = { type: w.code.move, newGrid: 11 };
    tick(w);
    assertStep(w, 'Clear');
    assert.ok(logged(w, /Anna \(1\.1\) busy/), 'busy logged');
});

t.test('Clear: a running battle is not quiet time; the quest unfinished pauses ClearTimeout after it', function () {
    var w = homeWorld();
    var limit = w.S.modules.adventures.away.CLEAR_MAX_MS;
    onIsland(w, null, {});
    series(w, { step: w.S.RunStep.Clear, zoneId: ZONE });
    w.g1.state.task = { type: w.code.attack };
    tick(w);
    W.ticksFor(w, limit * 3);
    assertStep(w, 'Clear');
    waiting(w, /last quest not finished, 0 of \d+ min quiet/);
    w.g1.state.task = null;
    tick(w);
    W.ticksFor(w, limit - 1);
    assertStep(w, 'Clear');
    w.t += 1;
    tick(w);
    assertPaused(w, w.S.RunPause.ClearTimeout, timeoutText(limit));
});

t.test('Clear: a null quest list holds with no limit and is not quiet time', function () {
    var w = homeWorld();
    var limit = w.S.modules.adventures.away.CLEAR_MAX_MS;
    onIsland(w, null, {});
    series(w, { step: w.S.RunStep.Clear, zoneId: ZONE });
    var quests = w.quests;
    w.quests = null;
    tick(w);
    W.ticksFor(w, limit * 3);
    assertStep(w, 'Clear');
    waiting(w, /quest list not readable/);
    w.quests = quests;
    tick(w);
    W.ticksFor(w, limit - 1);
    assertStep(w, 'Clear');
    w.t += 1;
    tick(w);
    assertPaused(w, w.S.RunPause.ClearTimeout, timeoutText(limit));
});

// An empty pool and a pool whose last quest was skipped as unreadable both
// read as a list that lacks the quest.
[
    { name: 'an empty list', quests: [] },
    { name: 'a list of other quests', quests: [{ key: 'q1', name: 'Side', finished: false, last: false }] }
].forEach(function (c) {
    t.test('Clear: a list without the last quest waits CLEAR_MAX_MS of quiet, then NotObserved: ' + c.name, function () {
        var w = homeWorld();
        onIsland(w, null, {});
        series(w, { step: w.S.RunStep.Clear, zoneId: ZONE });
        w.quests = c.quests;
        tick(w);
        W.ticksFor(w, w.S.modules.adventures.away.CLEAR_MAX_MS - 1);
        assertStep(w, 'Clear');
        waiting(w, /last quest not listed, \d+ of \d+ min quiet/);
        w.t += 1;
        tick(w);
        assertPaused(w, w.S.RunPause.NotObserved, /last quest not listed/);
    });
});

// ---- 12b. Pickups and quest objects ---------------------------------------------

// Collect's stored settings, which the run reads raw to know whether anything
// picks up on the island at all.
function collectSettings(w, o) {
    var s = { enabled: true, namePatterns: ['Crate'], adventureZones: true };
    for (var k in (o || {})) if (Object.prototype.hasOwnProperty.call(o, k)) s[k] = o[k];
    w.H.settings.write('collect', s);
}

function mapObject(grid, name, kind) {
    return { grid: grid, name: name, kind: kind || 'collectible', zoneId: ZONE };
}

function pickupsWorld(settings) {
    var w = homeWorld();
    onIsland(w);
    if (settings !== null) collectSettings(w, settings);
    series(w, { step: w.S.RunStep.Pickups, zoneId: ZONE });
    return w;
}

t.test('Pickups: goes to StarAll at once when there is nothing to pick up', function () {
    var w = pickupsWorld();
    tick(w);
    assertStep(w, 'StarAll');
});

t.test('Pickups: goes to StarAll at once when collect settings are missing or adventureZones is off', function () {
    [null, { adventureZones: false }].forEach(function (settings) {
        var w = pickupsWorld(settings);
        w.pickups = [mapObject(5, 'CrateA')];
        tick(w);
        assertStep(w, 'StarAll');
    });
});

t.test('Pickups: waits while collectibles pend, names them, and goes on once they are gone', function () {
    var w = pickupsWorld();
    w.pickups = [mapObject(5, 'CrateA'), mapObject(6, 'CrateA'), mapObject(7, 'CrateB')];
    tick(w);
    assertStep(w, 'Pickups');
    waiting(w, /picking up CrateA x2, CrateB x1/);
    w.pickups = [mapObject(7, 'CrateB')];
    tick(w);
    assertStep(w, 'Pickups');
    waiting(w, /picking up CrateB x1/);
    w.pickups = [];
    tick(w);
    assertStep(w, 'StarAll');
});

t.test('Pickups: after PICKUPS_MAX_MS it goes on with a pickups left line and is never paused', function () {
    var w = pickupsWorld();
    var limit = w.S.modules.adventures.away.PICKUPS_MAX_MS;
    w.pickups = [mapObject(5, 'CrateA')];
    tick(w);
    W.ticksFor(w, limit - 20000);
    assertStep(w, 'Pickups');
    W.ticksFor(w, 40000);
    assertStep(w, 'StarAll');
    assert.strictEqual(w.st.run().pause, null);
    assert.ok(logged(w, /pickups left: CrateA x1/), 'the objects left are logged');
});

t.test('Pickups: an unreadable map holds, then goes on after PICKUPS_MAX_MS', function () {
    var w = pickupsWorld();
    var limit = w.S.modules.adventures.away.PICKUPS_MAX_MS;
    w.pickups = null;
    tick(w);
    assertStep(w, 'Pickups');
    waiting(w, /map objects not readable/);
    W.ticksFor(w, limit + 20000);
    assertStep(w, 'StarAll');
    assert.ok(logged(w, /map objects unreadable/));
});

// A quest object pending in Clear: the last quest is open and a general is idle.
function clearObjectsWorld(objects) {
    var w = homeWorld();
    onIsland(w, null, {});
    w.pickups = objects;
    series(w, { step: w.S.RunStep.Clear, zoneId: ZONE });
    return w;
}

function questObject(grid, name) { return mapObject(grid, name, 'quest'); }

t.test('Clear: quest objects pending do not reach ClearTimeout at CLEAR_MAX_MS', function () {
    var w = clearObjectsWorld([questObject(5, 'Chest')]);
    var limit = w.S.modules.adventures.away.CLEAR_MAX_MS;
    tick(w);
    W.ticksFor(w, limit * 2);
    assertStep(w, 'Clear');
    waiting(w, /quest objects left: Chest x1/);
});

t.test('Clear: quest objects with no progress pause ClearTimeout naming them after CLEAR_PICKUP_MAX_MS', function () {
    var w = clearObjectsWorld([questObject(5, 'Chest'), questObject(6, 'Chest'), questObject(7, 'Lever')]);
    var limit = w.S.modules.adventures.away.CLEAR_PICKUP_MAX_MS;
    tick(w);
    W.ticksFor(w, limit - 20000);
    assertStep(w, 'Clear');
    W.ticksFor(w, 40000);
    assertPaused(w, w.S.RunPause.ClearTimeout, /quest objects not picked up after 15 min: Chest x2, Lever x1/);
});

t.test('Clear: when an object goes the pickup clock restarts, so there is no pause at the cap from the start', function () {
    var w = clearObjectsWorld([questObject(5, 'Chest'), questObject(6, 'Lever')]);
    var limit = w.S.modules.adventures.away.CLEAR_PICKUP_MAX_MS;
    tick(w);
    W.ticksFor(w, limit - 120000);
    assertStep(w, 'Clear');
    w.pickups = [questObject(6, 'Lever')];
    tick(w);
    W.ticksFor(w, 300000);
    assertStep(w, 'Clear');
    waiting(w, /quest objects left: Lever x1/);
    W.ticksFor(w, limit);
    assertPaused(w, w.S.RunPause.ClearTimeout, /quest objects not picked up after 15 min: Lever x1/);
});

t.test('Clear: once the objects are gone it goes on to LastQuest when the last quest finishes', function () {
    var w = clearObjectsWorld([questObject(5, 'Chest')]);
    tick(w);
    assertStep(w, 'Clear');
    w.pickups = [];
    lastQuest(w).finished = true;
    tick(w);
    assertStep(w, 'LastQuest');
});

t.test('Clear: a null objects read holds with no limit and counts no time', function () {
    var w = clearObjectsWorld(null);
    var limit = w.S.modules.adventures.away.CLEAR_PICKUP_MAX_MS;
    tick(w);
    W.ticksFor(w, limit * 3);
    assertStep(w, 'Clear');
    waiting(w, /quest objects not readable/);
    w.pickups = [];
    tick(w);
    W.ticksFor(w, w.S.modules.adventures.away.CLEAR_MAX_MS - 20000);
    assertStep(w, 'Clear');
});

// ---- 13. Pack and the last quest ---------------------------------------------------

// An elite unit in the catalogue, so a pack can choose between two classes.
function addElite(w, name) {
    var units = w.H.host.game.def('MilitarySystem::cMilitaryUnitBase').GetAllUnit();
    units.push({
        GetType:         function () { return name; },
        GetUnitCategory: function () { return 0; },
        GetIsElite:      function () { return true; },
        GetCosts_vector: function () { return w.costs[name] || []; }
    });
}

// A carrier (1.5, room 10) and the two generals (rooms 4 and 2) on the
// island; Anna and Bert wait at the star, the carrier on its grid.
function packWorld(free) {
    var w = homeWorld();
    addElite(w, 'Knight');
    var c = gen('1.5', 'Cara', 30, {}, { carrier: true, maxUnits: 10 });
    w.g1 = gen('1.1', 'Anna', 0, {}, { maxUnits: 4 });
    w.g2 = gen('1.2', 'Bert', 0, {}, { maxUnits: 2 });
    w.c = c;
    onIsland(w, [w.g1, w.g2, c], free || { Rifle: 13, Knight: 5 });
    w.quests = [{ key: 'q9', name: 'Final', finished: true, last: true }];
    w.landing([500, 501]);
    return w;
}

var PACK_KEYS = { '1.1': true, '1.2': true, '1.5': true };

// Records the grid each raise's holder stands on when the raise goes out.
function watchRaises(w) {
    var cm = w.gi.mClientMessages;
    var send = cm.SendMessagetoServer;
    w.raiseAt = [];
    cm.SendMessagetoServer = function (id, zone, data) {
        if (id === 1031) {
            var g = w.byKey(data.armyHolderSpecialistVO.uid);
            w.raiseAt.push({ key: data.armyHolderSpecialistVO.uid, grid: g ? g.state.grid : null, t: w.t });
        }
        return send.apply(this, arguments);
    };
}

function movesOf(w) {
    return w.orders.filter(function (o) { return o.code === w.code.move; });
}

function moveText(w) {
    return movesOf(w).map(function (o) { return o.key + '->' + o.grid; });
}

// How often each series transition from -> to was logged.
function countOf(w, from, to) {
    return transitions(w).filter(function (x) { return !x.wave && x.from === from && x.to === to; }).length;
}

t.test('Pack: carriers first, then generals; one class each within capacity; the remainder is logged', function () {
    var w = packWorld();
    watchRaises(w);
    series(w, { step: w.S.RunStep.PackStar, zoneId: ZONE, keys: PACK_KEYS });
    drive(w, { until: at('LastQuest') });
    assertStep(w, 'LastQuest');
    assert.strictEqual(w.orders.filter(function (o) { return o.code === w.code.star; }).length, 0, 'no star order');
    assert.strictEqual(w.c.state.grid, 30, 'the carrier stays on its grid');
    // Landing fields in the map's order; the carrier's grid is never offered.
    assert.deepStrictEqual(moveText(w), ['1.1->500', '1.2->501']);
    movesOf(w).forEach(function (m) {
        var r = w.raiseAt.filter(function (x) { return x.key === m.key; })[0];
        assert.ok(r && r.t >= m.t, m.key + ' moved before its raise');
    });
    w.raiseAt.forEach(function (x) { assert.ok(x.grid > 0, 'raise ' + x.key + ' at grid ' + x.grid); });
    assert.deepStrictEqual(w.raises, ['1.5', '1.1', '1.2']);
    assert.deepStrictEqual(plain(w.c.state.army), { Rifle: 10 });
    assert.deepStrictEqual(plain(w.g1.state.army), { Knight: 4 });
    assert.deepStrictEqual(plain(w.g2.state.army), { Rifle: 2 });
    assert.ok(logged(w, /left in the free pool: /, 'warn'));
    assert.deepStrictEqual(plain(w.frees[ZONE]), { Rifle: 1, Knight: 1 });
    assert.strictEqual(claimsOf(w, 'q9').length, 0, 'the last quest waits for the pack');
    assert.ok(logged(w, /placing 2 holder\(s\): 1\.1 -> 500, 1\.2 -> 501/));
    assert.strictEqual(countOf(w, 'PackStar', 'Pack'), 1);
    assert.strictEqual(countOf(w, 'Pack', 'Clear'), 1);
    assert.strictEqual(countOf(w, 'Clear', 'LastQuest'), 1);
});

t.test('Pack: a raise refused by the client precheck pauses PackFailed with the reason', function () {
    var w = packWorld();
    w.g1.state.grid = 10;
    w.g2.state.grid = 20;
    w.c.GetGarrison = function () { return null; };
    series(w, { step: w.S.RunStep.Pack, zoneId: ZONE, keys: PACK_KEYS });
    drive(w, { max: 20 });
    assertPaused(w, w.S.RunPause.PackFailed, /pack 1\.5 refused: no garrison/);
    assert.strictEqual(w.c.state.grid, 30);
    assert.strictEqual(w.raises.indexOf('1.5'), -1);
});

t.test('Pack: a planned holder at the star goes back to PackStar before any raise', function () {
    var w = packWorld();
    series(w, { step: w.S.RunStep.Pack, zoneId: ZONE, keys: PACK_KEYS });
    tick(w);
    play(w);
    assertStep(w, 'PackStar');
    assert.deepStrictEqual(w.raises, []);
    assert.ok(logged(w, /Pack -> PackStar.*Anna \(1\.1\) is not on the map/), 'reason logged');
});

t.test('PackStar: holders go to landing fields, never to a battle grid', function () {
    var w = packWorld();
    series(w, { step: w.S.RunStep.PackStar, zoneId: ZONE, keys: PACK_KEYS });
    drive(w, { until: at('LastQuest') });
    assertStep(w, 'LastQuest');
    assert.deepStrictEqual(moveText(w), ['1.1->500', '1.2->501']);
    assert.deepStrictEqual(w.raises, ['1.5', '1.1', '1.2']);
});

t.test('PackStar: an occupied grid and a grid the client refuses are skipped', function () {
    var w = packWorld();
    w.landing([30, 500, 501, 502]);
    w.blocked[500] = true;
    series(w, { step: w.S.RunStep.PackStar, zoneId: ZONE, keys: PACK_KEYS });
    drive(w, { until: at('LastQuest') });
    assertStep(w, 'LastQuest');
    // Cara stands on 30, 500 is refused.
    assert.deepStrictEqual(moveText(w), ['1.1->501', '1.2->502']);
});

t.test('PackStar: no placeable grid and nobody on the map waits PLACE_QUIET_MS, then NotPlaceable; no move and no raise', function () {
    var w = packWorld();
    w.sent.placeable = 1;
    // Without the carrier on its grid, so no holder can raise first.
    series(w, { step: w.S.RunStep.PackStar, zoneId: ZONE, keys: KEYS });
    tick(w);
    play(w);
    passesFor(w, w.S.modules.adventures.away.PLACE_QUIET_MS - 1);
    assertStep(w, 'PackStar');
    waiting(w, /Anna \(1\.1\) has no placeable grid, \d+ of \d+ min quiet/);
    assert.strictEqual(w.st.run().rounds, 0);
    w.t += 1;
    tick(w);
    assertPaused(w, w.S.RunPause.NotPlaceable, /Anna \(1\.1\) has no placeable grid/);
    assert.strictEqual(movesOf(w).length, 0);
    assert.deepStrictEqual(w.raises, []);
});

t.test('PackStar: a move the client never shows pauses PackFailed; no raise', function () {
    var w = packWorld();
    w.auto.move = false;
    series(w, { step: w.S.RunStep.PackStar, zoneId: ZONE, keys: PACK_KEYS });
    drive(w, { max: 200 });
    assertPaused(w, w.S.RunPause.PackFailed, /place 1\.1 failed/);
    assert.strictEqual(w.g1.state.grid, 0, 'the holder stayed at the star');
    assert.deepStrictEqual(w.raises, []);
});

t.test('PackStar: a walking holder is waited on without a second move, then packed', function () {
    var w = packWorld();
    w.auto.walk = true;
    series(w, { step: w.S.RunStep.PackStar, zoneId: ZONE, keys: PACK_KEYS });
    for (var i = 0; i < 6; i++) { tick(w); play(w); w.t += 1000; }
    assertStep(w, 'PackStar');
    assert.deepStrictEqual(moveText(w), ['1.1->500', '1.2->501']);
    assert.deepStrictEqual(w.raises, []);
    w.endWalks();
    drive(w, { until: at('LastQuest') });
    assertStep(w, 'LastQuest');
    assert.strictEqual(movesOf(w).length, 2);
    assert.deepStrictEqual(w.raises, ['1.5', '1.1', '1.2']);
});

t.test('PackStar: a long walk never pauses', function () {
    var w = packWorld();
    w.auto.walk = true;
    series(w, { step: w.S.RunStep.PackStar, zoneId: ZONE, keys: PACK_KEYS });
    for (var i = 0; i < 3; i++) { tick(w); play(w); w.t += 1000; }
    w.t += 3600000;
    tick(w);
    assertStep(w, 'PackStar');
    assert.ok(logged(w, /walking to its grid/), 'the wait is logged');
    assert.deepStrictEqual(w.raises, []);
    w.endWalks();
    drive(w, { until: at('LastQuest') });
    assertStep(w, 'LastQuest');
});

t.test('PackStar: one unreadable read after a long walk holds and does not pause', function () {
    var w = packWorld();
    w.auto.walk = true;
    series(w, { step: w.S.RunStep.PackStar, zoneId: ZONE, keys: PACK_KEYS });
    tick(w);
    play(w);
    w.t += 3600000;
    tick(w);
    var zone = w.H.host.game.zone;
    var army = zone.GetArmy;
    zone.GetArmy = function () { return null; };
    tick(w);
    assertStep(w, 'PackStar');
    zone.GetArmy = army;
    tick(w);
    assertStep(w, 'PackStar');
    assert.strictEqual(w.st.run().waitUntil, null, 'a clean read ends the hold');
    w.endWalks();
    drive(w, { until: at('LastQuest') });
    assertStep(w, 'LastQuest');
});

t.test('Restart: in PackStar while walking sends no second move', function () {
    var w = packWorld();
    w.auto.walk = true;
    series(w, { step: w.S.RunStep.PackStar, zoneId: ZONE, keys: PACK_KEYS });
    tick(w);
    play(w);
    assert.strictEqual(movesOf(w).length, 2);
    w = restart(w);
    addElite(w, 'Knight');
    for (var i = 0; i < 3; i++) { tick(w); play(w); w.t += 1000; }
    assertStep(w, 'PackStar');
    assert.strictEqual(movesOf(w).length, 2);
    drive(w, { until: at('LastQuest'), on: function (w2, name) { if (name === 'PackStar') w2.endWalks(); } });
    assertStep(w, 'LastQuest');
    assert.deepStrictEqual(moveText(w), ['1.1->500', '1.2->501']);
    assert.deepStrictEqual(w.raises, ['1.5', '1.1', '1.2']);
});

t.test('Kernel pause: PackStar after a move send places each holder once', function () {
    var w = packWorld();
    series(w, { step: w.S.RunStep.PackStar, zoneId: ZONE, keys: PACK_KEYS });
    tick(w);
    play(w, function () { return movesOf(w).length === 1; });
    inFlight(w);
    w.kernelPause();
    drive(w, { until: at('LastQuest') });
    assertStep(w, 'LastQuest');
    assert.deepStrictEqual(moveText(w), ['1.1->500', '1.2->501']);
    assert.deepStrictEqual(w.raises, ['1.5', '1.1', '1.2']);
});

t.test('Clear: troops left after the first pack go back to PackStar once; a general on the map is raised where it stands', function () {
    var w = packWorld();
    var d = gen('1.6', 'Dora', 40, {}, { maxUnits: 5 });
    w.place(d, ZONE);
    d.state.task = { type: w.code.attack };
    var keys = { '1.1': true, '1.2': true, '1.5': true, '1.6': true };
    series(w, { step: w.S.RunStep.PackStar, zoneId: ZONE, keys: keys });
    drive(w, { until: at('Clear') });
    assertStep(w, 'Clear');
    assert.deepStrictEqual(w.raises, ['1.5', '1.1', '1.2']);
    assert.deepStrictEqual(plain(w.frees[ZONE]), { Rifle: 1, Knight: 1 });
    // The attack ends at Clear (drive's help), so Dora has room now.
    drive(w, { until: at('LastQuest') });
    assertStep(w, 'LastQuest');
    assert.deepStrictEqual(w.raises, ['1.5', '1.1', '1.2', '1.6']);
    assert.deepStrictEqual(plain(d.state.army), { Rifle: 1 });
    assert.strictEqual(d.state.grid, 40);
    assert.strictEqual(movesOf(w).filter(function (o) { return o.key === '1.6'; }).length, 0, 'no move for Dora');
    assert.strictEqual(countOf(w, 'Clear', 'PackStar'), 1);
    assert.ok(logged(w, /Clear -> PackStar.*free troops left to pack/));
    assert.strictEqual(countOf(w, 'Clear', 'LastQuest'), 1);
});

t.test('Clear: an unreadable free pool holds with no limit and goes on once it reads', function () {
    var w = packWorld();
    var zone = w.H.host.game.zone;
    var army = zone.GetArmy;
    zone.GetArmy = function () { return null; };
    series(w, { step: w.S.RunStep.Clear, zoneId: ZONE, keys: PACK_KEYS });
    tick(w);
    W.ticksFor(w, LONG_MS);
    assertStep(w, 'Clear');
    waiting(w, /free troops and armies not readable/);
    zone.GetArmy = army;
    tick(w);
    assertStep(w, 'PackStar');
});

t.test('LastQuest: claimed after Pack with allowLast, once across a reload', function () {
    var w = packWorld();
    series(w, { step: w.S.RunStep.PackStar, zoneId: ZONE, keys: PACK_KEYS });
    drive(w, { until: at('LastQuest') });
    assert.strictEqual(claimsOf(w, 'q9').length, 0);
    tick(w);
    play(w, function () { return !lastQuest(w); });
    assert.strictEqual(claimsOf(w, 'q9').length, 1);
    assert.strictEqual(claimsOf(w, 'q9')[0].opts.allowLast, true);
    reload(w);
    for (var i = 0; i < 5; i++) { tick(w); play(w); w.t += 1000; }
    assertStep(w, 'LastQuest');
    // The client removes the adventure after its last quest.
    w.adventures = [];
    tick(w);
    assertStep(w, 'Close');
    assert.strictEqual(claimsOf(w, 'q9').length, 1);
});

t.test('LastQuest: a claim verified goes on to Close and is marked seen', function () {
    var w = packWorld();
    series(w, { step: w.S.RunStep.LastQuest, zoneId: ZONE, keys: PACK_KEYS });
    drive(w, { until: at('Close') });
    assertStep(w, 'Close');
    assert.strictEqual(w.st.run().marks.lastQuest.seen, true);
    assert.strictEqual(claimsOf(w, 'q9').length, 1);
});

t.test('LastQuest: a seen mark on a later pass goes to Close without claiming again (B2)', function () {
    var w = packWorld();
    series(w, { step: w.S.RunStep.LastQuest, zoneId: ZONE, keys: PACK_KEYS,
        run: { marks: { lastQuest: { sentAt: w.t - 5000, seen: true, sentOnce: true } } } });
    tick(w);
    assertStep(w, 'Close');
    assert.strictEqual(w.claims.length, 0);
});

t.test('LastQuest: a failing claim pauses QuestFailed; home and Resume hold, then NotObserved; no close (B2)', function () {
    var w = packWorld();
    w.S.core.quests.claim = function (key, opts) {
        w.claims.push({ key: key, opts: opts });
        return { label: 'claim quest ' + key, timeoutMs: 15000,
            send: function () { return false; }, check: function () { return false; } };
    };
    series(w, { step: w.S.RunStep.LastQuest, zoneId: ZONE, keys: PACK_KEYS });
    drive(w, { max: 40 });
    assertPaused(w, w.S.RunPause.QuestFailed, /claim last quest failed/);
    w.gi.visitZone(HOME);
    assert.strictEqual(w.S.modules.adventures.run.resume(), true);
    assertStep(w, 'LastQuest');
    tick(w);
    assertStep(w, 'LastQuest');
    w.t += w.S.modules.adventures.loader.READ_MAX_MS;
    tick(w);
    assertStep(w, 'LastQuest');
    w.t += 1;
    tick(w);
    assertPaused(w, w.S.RunPause.NotObserved, /view the adventure island/);
    assert.strictEqual(w.closes.length, 0);
});

t.test('LastQuest: an empty quest list on the island holds, then NotObserved; no claim, no close', function () {
    var w = packWorld();
    w.quests = [];
    series(w, { step: w.S.RunStep.LastQuest, zoneId: ZONE, keys: PACK_KEYS });
    tick(w);
    assertStep(w, 'LastQuest');
    w.t += w.S.modules.adventures.loader.READ_MAX_MS + 1;
    tick(w);
    assertPaused(w, w.S.RunPause.NotObserved, /last quest not readable or not listed/);
    assert.strictEqual(w.claims.length, 0);
    assert.strictEqual(w.closes.length, 0);
});

t.test('LastQuest: a null quest list on the island holds with no limit; no claim, no close, then one claim', function () {
    var w = packWorld();
    var quests = w.quests;
    w.quests = null;
    series(w, { step: w.S.RunStep.LastQuest, zoneId: ZONE, keys: PACK_KEYS });
    tick(w);
    passesFor(w, LONG_MS);
    assertStep(w, 'LastQuest');
    waiting(w, /quest list not readable/);
    assert.strictEqual(w.claims.length, 0);
    assert.strictEqual(w.closes.length, 0);
    w.quests = quests;
    drive(w, { until: at('Close') });
    assertStep(w, 'Close');
    assert.strictEqual(claimsOf(w, 'q9').length, 1);
});

// ---- 14. Close, Recall, JumpHome, ArriveHome ----------------------------------------

var CLAIMED = { lastQuest: { sentAt: 1, seen: true, sentOnce: true } };

t.test('Close: after the settle window the adventure is closed and verified gone; generals go home', function () {
    var w = homeWorld();
    onIsland(w);
    var r = series(w, { step: w.S.RunStep.Close, zoneId: ZONE, run: { marks: plain(CLAIMED) } });
    var since = r.since;
    drive(w, { until: at('Account') });
    assertStep(w, 'Account');
    assert.strictEqual(w.closes.length, 1);
    assert.strictEqual(w.closes[0].zoneId, ZONE);
    assert.ok(w.closes[0].t - since >= w.S.modules.adventures.loader.MARK_SETTLE_MS, 'closed after the settle window');
    assert.strictEqual(typeof w.st.current().request.closedAt, 'number');
    assert.deepStrictEqual(w.zoneSends.map(function (s) { return s.key + '>' + s.zoneId; }).sort(),
        ['1.1>' + HOME, '1.2>' + HOME]);
    assert.ok(w.visits.some(function (v) { return v.id === HOME; }), 'the run jumped home');
    var names = transitions(w).map(function (x) { return x.from + '->' + x.to; });
    assert.deepStrictEqual(names, ['Close->Recall', 'Recall->JumpHome', 'JumpHome->ArriveHome', 'ArriveHome->Account']);
});

t.test('Close: an unseen lastQuest mark pauses CloseFailed without removeAdventure (B2)', function () {
    var w = homeWorld();
    onIsland(w);
    series(w, { step: w.S.RunStep.Close, zoneId: ZONE,
        run: { marks: { lastQuest: { sentAt: w.t, seen: false, sentOnce: true } } } });
    tick(w);
    assertPaused(w, w.S.RunPause.CloseFailed, /last quest not confirmed claimed/);
    assert.strictEqual(w.closes.length, 0);
});

t.test('Close: an adventure the client removes itself within MARK_SETTLE_MS is seen closed without a send', function () {
    var w = homeWorld();
    onIsland(w);
    series(w, { step: w.S.RunStep.Close, zoneId: ZONE, run: { marks: plain(CLAIMED) } });
    tick(w);
    w.t += 10000;
    tick(w);
    assertStep(w, 'Close');
    w.adventures = [];
    tick(w);
    assertStep(w, 'Recall');
    assert.strictEqual(w.closes.length, 0);
});

t.test('Recall: a busy general never pauses; the others leave; JumpHome once he is gone', function () {
    var w = homeWorld();
    onIsland(w);
    w.g2.state.task = { type: w.code.attack };
    series(w, { step: w.S.RunStep.Recall, zoneId: ZONE });
    tick(w);
    play(w);
    assert.strictEqual(sendsOf(w, '1.1').length, 1);
    assert.strictEqual(sendsOf(w, '1.2').length, 0);
    w.t += 3600000;
    tick(w);
    play(w);
    assertStep(w, 'Recall');
    assert.ok(logged(w, /Bert \(1\.2\) busy on the adventure/), 'the wait is logged');
    w.g2.state.task = null;
    drive(w, { until: at('JumpHome') });
    assertStep(w, 'JumpHome');
    assert.strictEqual(sendsOf(w, '1.1').length, 1);
    assert.strictEqual(sendsOf(w, '1.2').length, 1);
});

t.test('Recall: a recovering general is not sent and not waited on; he returns with the map', function () {
    var w = homeWorld();
    onIsland(w);
    w.g2.state.task = { type: w.code.recover };
    series(w, { step: w.S.RunStep.Recall, zoneId: ZONE });
    drive(w, { until: at('JumpHome') });
    assertStep(w, 'JumpHome');
    assert.strictEqual(sendsOf(w, '1.1').length, 1);
    assert.strictEqual(sendsOf(w, '1.2').length, 0);
    assert.ok(logged(w, /1 recovering return with the map/), 'the log names him');
});

t.test('Recall: three generals ready one at a time never pause', function () {
    var w = homeWorld();
    var g3 = gen('1.3', 'Cora', 30);
    onIsland(w, [w.g1, w.g2, g3]);
    series(w, { step: w.S.RunStep.Recall, zoneId: ZONE, keys: THREE });
    oneAtATime(w, g3);
    assertStep(w, 'JumpHome');
    Object.keys(THREE).forEach(function (k) {
        assert.strictEqual(sendsOf(w, k).length, 1, k);
    });
});

// ---- 15. Accounting -----------------------------------------------------------------

t.test('Account: lost = snapshot - (total + queued) stays exact when production finishes during the run', function () {
    var w = homeWorld({ free: { Rifle: 10 } });
    w.g1.state.army = { Rifle: 5 };
    w.queues[0].entries.push({ type: 'Rifle', amount: 3 });
    series(w, { step: w.S.RunStep.Account, run: { snapshot: { Rifle: 20 } } });
    tick(w);
    assertStep(w, 'Population');
    assert.ok(logged(w, /lost: 2 Rifle/), 'lost logged');
    // The queued units join the free pool: the count does not change.
    w.produce();
    drive(w, { until: at('Next') });
    assertStep(w, 'Next');
    assert.deepStrictEqual(w.productionOrders.map(function (o) { return o.unit + ' ' + o.amount; }), ['Rifle 2']);
});

t.test('Account: no snapshot (started on an open map) skips retraining with the log line', function () {
    var w = homeWorld();
    series(w, { step: w.S.RunStep.Account });
    tick(w);
    assertStep(w, 'Next');
    assert.ok(logged(w, /no troop snapshot \(run started on an open map\); retraining skipped/));
    assert.ok(!logged(w, /retrain off/), 'retraining is on, the missing snapshot is the reason');
    assert.strictEqual(w.productionOrders.length, 0);
    assert.strictEqual(popBuffs(w).length, 0);
});

// ---- 16. Population -----------------------------------------------------------------

// Two population stacks of 20 in the star menu.
function twoStacks(w) {
    var pop = w.stock.filter(function (b) { return b.type === 'AddResource'; })[0];
    pop.amount = 20;
    w.stock.push({ type: 'AddResource', resource: pop.resource, amount: 20, uid: 'pop2' });
}

t.test('Population: the top-up is exactly the shortfall', function () {
    var w = homeWorld({ free: { Rifle: 10 }, pop: 4 });
    series(w, { step: w.S.RunStep.Population, run: { snapshot: { Rifle: 20 } } });
    drive(w, { until: at('Next') });
    assertStep(w, 'Next');
    assert.deepStrictEqual(popBuffs(w), [6]);
    assert.strictEqual(w.pop, 10);
    assert.deepStrictEqual(w.productionOrders.map(function (o) { return o.unit + ' ' + o.amount; }), ['Rifle 10']);
});

t.test('Population: stacks of 20+20 for a shortfall of 30 send 20, then 10', function () {
    var w = homeWorld({ free: { Rifle: 10 }, pop: 0 });
    twoStacks(w);
    series(w, { step: w.S.RunStep.Population, run: { snapshot: { Rifle: 40 } } });
    drive(w, { until: at('Retrain') });
    assertStep(w, 'Retrain');
    assert.deepStrictEqual(popBuffs(w), [20, 10]);
    assert.ok(logged(w, /topped up 20/));
});

t.test('Population: a verified buff without a rise pauses RetrainFailed after one buff and ORDER_WAIT_MS (M4)', function () {
    var w = homeWorld({ free: { Rifle: 10 }, pop: 0, popNoEffect: true });
    twoStacks(w);
    series(w, { step: w.S.RunStep.Population, run: { snapshot: { Rifle: 40 } } });
    drive(w, { max: 200 });
    assertPaused(w, w.S.RunPause.RetrainFailed, /verified but free population did not rise/);
    assert.deepStrictEqual(popBuffs(w), [20]);
    var r = w.st.run();
    assert.ok(r.pause.at - r.marks.population.sentAt >= loaderOf(w).ORDER_WAIT_MS, 'paused only after the wait');
});

t.test('Population: a joint resource shortage pauses RetrainShort with the full list; nothing is spent', function () {
    var w = homeWorld({ free: { Rifle: 10 }, pop: 4, resources: { Coins: 5 } });
    w.costs.Rifle = [{ name_string: 'Population', amount: 1 }, { name_string: 'Coins', amount: 2 }];
    series(w, { step: w.S.RunStep.Population, run: { snapshot: { Rifle: 20 } } });
    tick(w);
    play(w);
    assertPaused(w, w.S.RunPause.RetrainShort, /Population 10\/4/);
    assert.ok(/Coins 20\/5/.test(w.st.run().pause.message), w.st.run().pause.message);
    assert.strictEqual(popBuffs(w).length, 0);
    assert.strictEqual(w.productionOrders.length, 0);
});

// ---- 17. Retrain --------------------------------------------------------------------

function retrainWorld() {
    var w = homeWorld({ free: { Rifle: 10, Knight: 2 } });
    addElite(w, 'Knight');
    w.costs.Knight = [{ name_string: 'Population', amount: 1 }];
    return w;
}

var RETRAIN_SNAPSHOT = { Rifle: 20, Knight: 6 };

function ordersOf(w) {
    return w.productionOrders.map(function (o) { return o.unit + ' ' + o.amount; }).sort();
}

t.test('Retrain: barracks and elite units go to their own queues; the recount leaves nothing to order', function () {
    var w = retrainWorld();
    series(w, { step: w.S.RunStep.Retrain, run: { snapshot: plain(RETRAIN_SNAPSHOT) } });
    drive(w, { until: at('Next') });
    assertStep(w, 'Next');
    assert.deepStrictEqual(plain(w.queues[0].entries), [{ type: 'Rifle', amount: 10 }]);
    assert.deepStrictEqual(plain(w.queues[8].entries), [{ type: 'Knight', amount: 4 }]);
    assert.deepStrictEqual(ordersOf(w), ['Knight 4', 'Rifle 10']);
    assert.ok(logged(w, /Retrain -> Next \(retrain ordered\)/));
});

t.test('Retrain: a reload after the send sends no second order', function () {
    var w = retrainWorld();
    series(w, { step: w.S.RunStep.Retrain, run: { snapshot: plain(RETRAIN_SNAPSHOT) } });
    tick(w);
    play(w, function () { return w.productionOrders.length === 1; });
    inFlight(w);
    reload(w);
    drive(w, { until: at('Next') });
    assertStep(w, 'Next');
    assert.deepStrictEqual(ordersOf(w), ['Knight 4', 'Rifle 10']);
});

// ---- 18. Repetition ------------------------------------------------------------------

t.test('Repetition: End repetition during map 2 of x3 stops after map 2', function () {
    var w = homeWorld();
    w.landing([500, 501]);
    series(w, { count: 3 });
    var ended = false;
    drive(w, { max: 2000, on: function (w2, name) {
        if (!ended && w2.st.current().request.finished === 1 && name === 'Clear') {
            ended = w2.S.modules.adventures.run.endRepetition();
        }
    } });
    assert.strictEqual(ended, true);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Done, 'status ' + w.st.run().status);
    assert.strictEqual(w.st.current().request.finished, 2);
    assert.strictEqual(w.st.current().request.count, 2);
    assert.strictEqual(w.st.current().request.ended, true);
    assert.strictEqual(mapStarts(w).length, 2);
    assert.strictEqual(w.st.status(), 'Done: Black Knights, 2 run(s)');
});

t.test('Repetition: each map gets a new run id and its own zoneId', function () {
    var w = homeWorld();
    w.landing([500, 501]);
    series(w, { count: 2 });
    var seen = [];
    var moved = false;
    drive(w, { max: 1500, on: function (w2, name) {
        var r = w2.st.run();
        if (name === 'Jump' && !seen.some(function (s) { return s.id === r.id; })) {
            seen.push({ id: r.id, zoneId: r.zoneId, finished: w2.st.current().request.finished });
        }
        // The second map opens on another island.
        if (!moved && w2.st.current().request.finished === 1) {
            moved = true;
            var list = w2.adventures.slice(0);
            list.push = function (a) {
                a.zoneID = 8;
                return Array.prototype.push.call(this, a);
            };
            w2.adventures = list;
        }
    } });
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Done, 'status ' + w.st.run().status +
        (w.st.run().pause ? ': ' + w.st.run().pause.message : ''));
    assert.strictEqual(seen.length, 2);
    assert.notStrictEqual(seen[0].id, seen[1].id);
    assert.deepStrictEqual(seen.map(function (s) { return s.zoneId; }), [ZONE, 8]);
    assert.deepStrictEqual(seen.map(function (s) { return s.finished; }), [0, 1]);
    assert.deepStrictEqual(w.closes.map(function (c) { return c.zoneId; }), [ZONE, 8]);
});

// ---- 19. Resume -----------------------------------------------------------------------

t.test('Resume: a paused home or away step is re-entered; a paused wave step resumes at Gate', function () {
    var w = homeWorld({ mapOpen: true });
    var run = w.S.modules.adventures.run;
    series(w, { step: w.S.RunStep.Depart, zoneId: ZONE });
    w.st.pause(w.S.RunPause.User, 'paused by you');
    assert.strictEqual(run.resume(), true);
    assertStep(w, 'Depart');

    series(w, { step: w.S.RunStep.Pack, zoneId: ZONE });
    w.st.pause(w.S.RunPause.PackFailed, 'test');
    assert.strictEqual(run.resume(), true);
    assertStep(w, 'Pack');

    series(w, { step: w.S.RunStep.Retrain, run: { snapshot: { Rifle: 8 } } });
    w.st.pause(w.S.RunPause.RetrainFailed, 'test');
    assert.strictEqual(run.resume(), true);
    assertStep(w, 'Retrain');

    series(w, { step: w.S.WaveStep.Supply, zoneId: ZONE });
    w.st.pause(w.S.RunPause.TroopsShort, 'test');
    assert.strictEqual(run.resume(), true);
    assertStep(w, 'Gate');
});

// ---- 20. Restart ------------------------------------------------------------------------

t.test('Restart: in Depart resumes without a second sendToZone', function () {
    var w = homeWorld({ mapOpen: true });
    series(w, { step: w.S.RunStep.Depart, zoneId: ZONE });
    tick(w);
    play(w, function () { return w.zoneSends.length === 1; });
    inFlight(w);
    w = restart(w);
    assertStep(w, 'Depart');
    drive(w, { until: at('Jump') });
    assertStep(w, 'Jump');
    assert.strictEqual(sendsOf(w, '1.1').length, 1);
    assert.strictEqual(sendsOf(w, '1.2').length, 1);
});

t.test('Restart: in Jump resumes without a second visit', function () {
    var w = homeWorld({ mapOpen: true });
    series(w, { step: w.S.RunStep.Jump, zoneId: ZONE });
    tick(w);
    assert.strictEqual(w.visits.length, 1);
    w = restart(w);
    tick(w);
    assertStep(w, 'Arrive');
    assert.strictEqual(w.visits.length, 1);
});

t.test('Restart: in Arrive resumes and goes on once every general is there', function () {
    var w = homeWorld();
    onIsland(w, [w.g1, w.g2]);
    w.g2.state.travelling = true;
    w.g2.state.task = { type: w.code.travel, remaining: 1000 };
    series(w, { step: w.S.RunStep.Arrive, zoneId: ZONE });
    tick(w);
    assertStep(w, 'Arrive');
    w = restart(w);
    tick(w);
    assertStep(w, 'Arrive');
    w.arrive();
    tick(w);
    assertStep(w, 'Pickups');
    assert.strictEqual(w.zoneSends.length, 0);
});

t.test('Restart: in Pack resumes without raising a holder twice', function () {
    var w = packWorld();
    var c = w.c;
    w.g1.state.grid = 10;
    w.g2.state.grid = 20;
    series(w, { step: w.S.RunStep.Pack, zoneId: ZONE, keys: PACK_KEYS });
    tick(w);
    play(w, function () { return w.raises.length === 1; });
    inFlight(w);
    w = restart(w);
    addElite(w, 'Knight');
    drive(w, { until: at('LastQuest') });
    assertStep(w, 'LastQuest');
    assert.deepStrictEqual(w.raises, ['1.5', '1.1', '1.2']);
    assert.deepStrictEqual(plain(c.state.army), { Rifle: 10 });
});

t.test('Restart: in LastQuest resumes without a second claim', function () {
    var w = packWorld();
    series(w, { step: w.S.RunStep.LastQuest, zoneId: ZONE, keys: PACK_KEYS });
    tick(w);
    play(w, function () { return !lastQuest(w); });
    inFlight(w);
    w = restart(w);
    for (var i = 0; i < 5; i++) { tick(w); play(w); w.t += 1000; }
    assertStep(w, 'LastQuest');
    w.adventures = [];
    tick(w);
    assertStep(w, 'Close');
    assert.strictEqual(claimsOf(w, 'q9').length, 1);
});

t.test('Restart: in Retrain resumes without a second order', function () {
    var w = retrainWorld();
    series(w, { step: w.S.RunStep.Retrain, run: { snapshot: plain(RETRAIN_SNAPSHOT) } });
    tick(w);
    play(w, function () { return w.productionOrders.length === 1; });
    inFlight(w);
    w = restart(w);
    addElite(w, 'Knight');
    drive(w, { until: at('Next') });
    assertStep(w, 'Next');
    assert.deepStrictEqual(ordersOf(w), ['Knight 4', 'Rifle 10']);
    assert.strictEqual(w.productionOrders.length, 2, 'one order per unit across the restart');
    assert.ok(!logged(w, /retrain off/), 'the setting survived the restart');
});

// ---- 21. Kernel pause without a reload (B1) ------------------------------------------------

t.test('Kernel pause: StartMap sends one map start and goes on once the map is listed', function () {
    var w = homeWorld();
    series(w, { step: w.S.RunStep.StartMap });
    tick(w);
    play(w, function () { return mapStarts(w).length === 1; });
    inFlight(w);
    w.kernelPause();
    drive(w, { until: at('Depart') });
    assertStep(w, 'Depart');
    assert.strictEqual(mapStarts(w).length, 1);
});

t.test('Kernel pause: StartMap with the map withheld pauses NotObserved after ORDER_WAIT_MS', function () {
    var w = homeWorld();
    w.auto.map = false;
    series(w, { step: w.S.RunStep.StartMap });
    tick(w);
    play(w, function () { return mapStarts(w).length === 1; });
    inFlight(w);
    w.kernelPause();
    drive(w, { max: 200 });
    assertPaused(w, w.S.RunPause.NotObserved, /map start sent/);
    var r = w.st.run();
    assert.ok(r.pause.at - r.marks.map.sentAt >= loaderOf(w).ORDER_WAIT_MS);
    assert.strictEqual(mapStarts(w).length, 1);
});

t.test('Kernel pause: Population sends one buff and goes on once free population rose', function () {
    var w = homeWorld({ free: { Rifle: 10 }, pop: 4 });
    series(w, { step: w.S.RunStep.Population, run: { snapshot: { Rifle: 20 } } });
    tick(w);
    play(w, function () { return popBuffs(w).length === 1; });
    inFlight(w);
    w.kernelPause();
    drive(w, { until: at('Retrain') });
    assertStep(w, 'Retrain');
    assert.deepStrictEqual(popBuffs(w), [6]);
});

t.test('Kernel pause: Population with the rise withheld pauses NotObserved after ORDER_WAIT_MS', function () {
    var w = homeWorld({ free: { Rifle: 10 }, pop: 4, popNoEffect: true });
    series(w, { step: w.S.RunStep.Population, run: { snapshot: { Rifle: 20 } } });
    tick(w);
    play(w, function () { return popBuffs(w).length === 1; });
    inFlight(w);
    w.kernelPause();
    drive(w, { max: 200 });
    assertPaused(w, w.S.RunPause.NotObserved, /population buff sent/);
    var r = w.st.run();
    assert.ok(r.pause.at - r.marks.population.sentAt >= loaderOf(w).ORDER_WAIT_MS);
    assert.deepStrictEqual(popBuffs(w), [6]);
});

t.test('Kernel pause: Retrain sends one order per unit and goes on once the queues are raised', function () {
    var w = retrainWorld();
    series(w, { step: w.S.RunStep.Retrain, run: { snapshot: plain(RETRAIN_SNAPSHOT) } });
    tick(w);
    play(w, function () { return w.productionOrders.length === 1; });
    inFlight(w);
    w.kernelPause();
    drive(w, { until: at('Next') });
    assertStep(w, 'Next');
    assert.deepStrictEqual(ordersOf(w), ['Knight 4', 'Rifle 10']);
});

t.test('Kernel pause: Retrain with the queue withheld pauses NotObserved after ORDER_WAIT_MS', function () {
    var w = homeWorld({ free: { Rifle: 10 } });
    var send = w.gi.mClientMessages.SendMessagetoServer;
    w.gi.mClientMessages.SendMessagetoServer = function (id, zone, data) {
        if (id !== 91) return send.apply(this, arguments);
        w.productionOrders.push({ unit: data.type_string, amount: data.amount * data.stacks, t: w.t });
    };
    series(w, { step: w.S.RunStep.Retrain, run: { snapshot: { Rifle: 20 } } });
    tick(w);
    play(w, function () { return w.productionOrders.length === 1; });
    inFlight(w);
    w.kernelPause();
    drive(w, { max: 200 });
    assertPaused(w, w.S.RunPause.NotObserved, /order of Rifle/);
    var r = w.st.run();
    assert.ok(r.pause.at - r.marks['order:Rifle'].sentAt >= loaderOf(w).ORDER_WAIT_MS);
    assert.deepStrictEqual(ordersOf(w), ['Rifle 10']);
});

t.test('Kernel pause: Depart sends one sendToZone per general', function () {
    var w = homeWorld({ mapOpen: true });
    series(w, { step: w.S.RunStep.Depart, zoneId: ZONE });
    tick(w);
    play(w, function () { return w.zoneSends.length === 1; });
    inFlight(w);
    w.kernelPause();
    drive(w, { until: at('Jump') });
    assertStep(w, 'Jump');
    assert.strictEqual(sendsOf(w, '1.1').length, 1);
    assert.strictEqual(sendsOf(w, '1.2').length, 1);
});

t.test('Kernel pause: LastQuest sends one claim and goes on once the adventure is gone', function () {
    var w = packWorld();
    series(w, { step: w.S.RunStep.LastQuest, zoneId: ZONE, keys: PACK_KEYS });
    tick(w);
    play(w, function () { return !lastQuest(w); });
    inFlight(w);
    w.kernelPause();
    for (var i = 0; i < 5; i++) { tick(w); play(w); w.t += 1000; }
    assertStep(w, 'LastQuest');
    w.adventures = [];
    tick(w);
    assertStep(w, 'Close');
    assert.strictEqual(claimsOf(w, 'q9').length, 1);
});

// ---- loader helpers --------------------------------------------------------------

function loaderOf(w) {
    return w.S.modules.adventures.loader;
}

t.test('loader: keysOf is sorted; who names a listed general and falls back to the key', function () {
    var w = homeWorld();
    var ld = loaderOf(w);
    assert.strictEqual(ld.keysOf({ loadoutKeys: { '1.2': true, '1.10': true, '1.1': true } }).join(), '1.1,1.10,1.2');
    assert.strictEqual(ld.keysOf({}).length, 0);
    var inv = { byKey: { '1.1': { name: 'Anna' }, '1.2': {} } };
    assert.strictEqual(ld.who(inv, '1.1'), 'Anna (1.1)');
    assert.strictEqual(ld.who(inv, '1.2'), '1.2', 'a listed general without a name');
    assert.strictEqual(ld.who(inv, '9.9'), '9.9', 'an unlisted general');
    assert.strictEqual(ld.who(null, '1.1'), '1.1', 'no inventory');
});

t.test('loader: leaving is true while travelling or on a TravelToZone task, false when idle', function () {
    var w = homeWorld();
    var ld = loaderOf(w);
    assert.strictEqual(ld.leaving({ travelling: true }, '1.1'), true, 'travelling flag');
    assert.strictEqual(ld.leaving({ travelling: false }, '1.1'), false, 'idle');
    w.g1.state.task = { type: w.code.travel };
    assert.strictEqual(ld.leaving({ travelling: false }, '1.1'), true, 'TravelToZone task');
    assert.strictEqual(ld.leaving({ travelling: false }, '1.2'), false, 'the other general is idle');
    w.g1.state.task = { type: w.code.attack };
    assert.strictEqual(ld.leaving({ travelling: false }, '1.1'), false, 'another task');
});

t.test('loader: anyAttacking is true only while an own fighter has an Attack task', function () {
    var w = homeWorld();
    var ld = loaderOf(w);
    assert.strictEqual(ld.anyAttacking(), false, 'nobody has a task');
    w.g1.state.task = { type: w.code.travel };
    assert.strictEqual(ld.anyAttacking(), false, 'a travel task is not an attack');
    w.g2.state.task = { type: w.code.attack };
    assert.strictEqual(ld.anyAttacking(), true, 'one attacking general');
    w.g2.state.task = null;
    assert.strictEqual(ld.anyAttacking(), false, 'the attack ended');
});

t.test('loader: waitRead holds with no limit, logs once a minute and keeps its since', function () {
    var w = homeWorld();
    var ld = loaderOf(w);
    var r = series(w);
    var rs = w.st.current();
    function lines() {
        return w.H.logs().filter(function (l) { return /the thing not readable, waited/.test(l.args.join(' ')); }).length;
    }
    w.t = r.since + ld.READ_MAX_MS * 100;
    var since = w.t;
    ld.waitRead(r, 'the thing');
    waiting(w, /^the thing not readable$/);
    assert.strictEqual(rs.busy.read, true);
    assert.strictEqual(lines(), 0, 'a momentary read logs nothing');
    w.t += ld.BUSY_LOG_MS - 1;
    ld.waitRead(r, 'the thing');
    assert.strictEqual(lines(), 0);
    w.t += 1;
    ld.waitRead(r, 'the thing');
    assert.strictEqual(lines(), 1);
    w.t += ld.BUSY_LOG_MS;
    ld.waitRead(r, 'the thing');
    assert.strictEqual(lines(), 2);
    assert.strictEqual(rs.busy.since, since);
    assert.strictEqual(r.waitUntil, null, 'no window');
    assertStep(w, 'Muster');
});

t.test('series: a malformed request count runs one run and ends Done', function () {
    var w = homeWorld();
    series(w, { step: w.S.RunStep.Next, count: 'x' });
    assert.strictEqual(w.st.requestedRuns(), 1);
    tick(w);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Done, 'status ' + w.st.run().status);
    assert.strictEqual(w.st.finishedRuns(), 1);
});

// ---- 20. Optional horseshoe and retraining ----------------------------------------------

t.test('retrain off: Snapshot goes to Supply without reading troops', function () {
    var w = homeWorld({ settings: { retrain: false } });
    var reads = 0;
    var queued = w.S.core.production.queued;
    w.S.core.production.queued = function () { reads++; return queued.apply(this, arguments); };
    // Troops that cannot be read would hold a snapshot; with retraining off
    // nothing waits for them.
    w.H.host.game.zone.GetArmy = function () { return null; };
    series(w, { step: w.S.RunStep.Snapshot });
    tick(w);
    assertStep(w, 'Supply');
    assert.strictEqual(w.st.run().snapshot, null);
    assert.strictEqual(reads, 0);
    assert.ok(logged(w, /Snapshot -> Supply \(retrain off\)/));
});

t.test('retrain off: Account goes to Next with no order', function () {
    var w = homeWorld({ settings: { retrain: false } });
    series(w, { step: w.S.RunStep.Account });
    tick(w);
    assertStep(w, 'Next');
    assert.ok(logged(w, /retrain off; retraining skipped/));
    assert.ok(!logged(w, /run started on an open map/));
    assert.strictEqual(w.productionOrders.length, 0);
    assert.strictEqual(popBuffs(w).length, 0);
});

t.test('nextRun carries pending transit and no retrain key', function () {
    var w = homeWorld();
    series(w, { step: w.S.RunStep.Next, count: 2, run: { transit: [
        { from: 41, army: { Rifle: 8 }, until: w.t + LONG_MS },
        { from: 40, army: { Bow: 3 }, until: w.t - 1 }
    ] } });
    tick(w);
    var r = w.st.run();
    assert.strictEqual(r.step, w.S.RunStep.Muster, 'the next run begins');
    assert.ok(!Object.prototype.hasOwnProperty.call(r, 'retrain'), 'no retrain field');
    assert.deepStrictEqual(plain(r.transit), [{ from: 41, army: { Rifle: 8 }, until: w.t + LONG_MS }],
        'the pending entry goes with the run, the expired one does not');
    assert.deepStrictEqual(plain(r.transitBase), { Rifle: 20 }, 'the base is the home count read at Next');
});

t.test('horseshoe None sends nothing and logs not used', function () {
    var w = homeWorld();
    onIsland(w);
    w.stock.push({ type: 'GeneralSpeedBuff_A', resource: '', amount: 2, uid: 'spd' });
    series(w, { step: w.S.RunStep.Horseshoe, zoneId: ZONE, speedBuff: w.S.SpeedBuffChoice.None });
    tick(w);
    play(w);
    assertStep(w, 'Gate');
    assert.ok(logged(w, /horseshoe not used/, 'log'));
    assert.ok(!logged(w, /no horseshoe in stock/));
    assert.strictEqual(w.buffActions.filter(function (b) { return /SpeedBuff/.test(b.type); }).length, 0);
});

t.test("a template's retrain key is ignored; the run has no retrain field", function () {
    [false, true].forEach(function (retrain) {
        var w = homeWorld();
        var tpl = w.S.modules.adventures.templates;
        w.H.ctx.prompt = function (text, def) { return def; };
        w.S.modules.adventures.executor.check = function () {
            return { ok: true, problems: [], warnings: [], loadoutKeys: { a: 1 } };
        };
        var saved = tpl.save({
            label: 'Black Knights', adventure: 'BlackKnights', loadout: LOADOUT, waves: [WAVE],
            speedBuff: 'SpeedBuffDefault', retrain: retrain
        }, 1000);
        assert.strictEqual(saved.ok, true);
        assert.strictEqual(w.S.modules.adventures.run.start(saved.id), true);
        assert.ok(!Object.prototype.hasOwnProperty.call(w.st.run(), 'retrain'), 'no retrain field');
    });
});

// ---- 20. Retrain setting, troops on the way home, series stop ------------------------

// Free troops of an earlier island on the way home, pending until untilMs.
function travelling(army, untilMs) {
    return [{ from: 41, army: army, until: untilMs }];
}

function transitOf(w) {
    return plain(w.st.run().transit);
}

t.test('retrain setting: nothing stored reads off; Snapshot skips the count', function () {
    var w = homeWorld({ settings: {} });
    assert.strictEqual(w.S.modules.adventures.retrainOn(), false);
    assert.strictEqual(w.S.modules.adventures.retrainSettlersOnly(), false);
    series(w, { step: w.S.RunStep.Snapshot });
    tick(w);
    assertStep(w, 'Supply');
    assert.strictEqual(w.st.run().snapshot, null);
    assert.ok(logged(w, /Snapshot -> Supply \(retrain off\)/));
});

t.test('retrain setting: turned off mid-run, Account, Population and Retrain go to Next with no order', function () {
    [['Account', true], ['Population', false], ['Retrain', false]].forEach(function (c) {
        var w = homeWorld({ free: { Rifle: 10 }, pop: 0 });
        series(w, { step: w.S.RunStep[c[0]], run: { snapshot: { Rifle: 20 } } });
        w.S.kernel.settings.write('adventures', { retrain: false });
        tick(w);
        play(w);
        assertStep(w, 'Next');
        assert.ok(logged(w, new RegExp(c[0] + ' -> Next \\(retrain off\\)')), c[0]);
        if (c[1]) assert.ok(logged(w, /retrain off; retraining skipped/), c[0] + ' logs the skip');
        assert.strictEqual(w.productionOrders.length, 0, c[0]);
        assert.strictEqual(popBuffs(w).length, 0, c[0]);
    });
});

t.test('transit: a Clear exit with free troops left records them once, logs them, and a re-exit replaces the entry', function () {
    var w = packWorld();
    series(w, { step: w.S.RunStep.PackStar, zoneId: ZONE, keys: PACK_KEYS });
    drive(w, { until: at('LastQuest') });
    assertStep(w, 'LastQuest');
    var r = w.st.run();
    var list = transitOf(w);
    assert.strictEqual(list.length, 1, JSON.stringify(list));
    assert.strictEqual(list[0].from, r.id);
    assert.deepStrictEqual(list[0].army, { Knight: 1, Rifle: 1 });
    assert.ok(list[0].until > w.t, 'pending');
    assert.ok(logged(w, /on the way home by themselves: .*counted as yours for 75 min/));
    w.st.go(w.S.RunStep.Clear, 'test');
    tick(w);
    play(w);
    assertStep(w, 'LastQuest');
    list = transitOf(w);
    assert.strictEqual(list.length, 1, 'one entry per run: ' + JSON.stringify(list));
    assert.deepStrictEqual(list[0].army, { Knight: 1, Rifle: 1 });
});

t.test('transit: Account counts troops on the way home as owned; Retrain orders only the real loss', function () {
    var w = homeWorld({ free: { Rifle: 10 } });
    series(w, { step: w.S.RunStep.Account, run: { snapshot: { Rifle: 20 }, transit: travelling({ Rifle: 8 }, w.t + LONG_MS) } });
    tick(w);
    assertStep(w, 'Population');
    assert.ok(logged(w, /lost: 2 Rifle/), 'lost logged');
    assert.ok(logged(w, /on the way home, not counted as lost: 8 Rifle/));
    drive(w, { until: at('Next') });
    assertStep(w, 'Next');
    assert.deepStrictEqual(ordersOf(w), ['Rifle 2']);
});

t.test('transit: troops seen landing at Population are retired once and nothing extra is ordered', function () {
    var w = homeWorld({ free: { Rifle: 10 } });
    series(w, { step: w.S.RunStep.Account, run: { snapshot: { Rifle: 20 }, transit: travelling({ Rifle: 8 }, w.t + LONG_MS) } });
    tick(w);
    assertStep(w, 'Population');
    assert.deepStrictEqual(plain(w.st.run().transitBase), { Rifle: 10 }, 'Account set the base');
    w.frees[HOME].Rifle += 8;
    drive(w, { until: at('Next') });
    assertStep(w, 'Next');
    assert.ok(logged(w, /landed at home: 8 Rifle, no longer counted as on the way/));
    assert.deepStrictEqual(transitOf(w), []);
    assert.deepStrictEqual(ordersOf(w), ['Rifle 2']);
});

t.test('transit: past its until nothing counts as on the way and the loss is the full count', function () {
    var w = homeWorld({ free: { Rifle: 10 } });
    series(w, { step: w.S.RunStep.Account, run: { snapshot: { Rifle: 20 }, transit: travelling({ Rifle: 8 }, w.t + 1000) } });
    w.t += 2000;
    tick(w);
    assertStep(w, 'Population');
    assert.ok(logged(w, /lost: 10 Rifle/), 'the full loss');
    assert.ok(!logged(w, /on the way home, not counted as lost/));
    drive(w, { until: at('Next') });
    assertStep(w, 'Next');
    assert.deepStrictEqual(ordersOf(w), ['Rifle 10']);
});

t.test('transit: nextRun waits on an unreadable read; the next Snapshot adds the pending troops', function () {
    var w = homeWorld();
    var zone = w.H.host.game.zone;
    var army = zone.GetArmy;
    zone.GetArmy = function () { return null; };
    series(w, { step: w.S.RunStep.Next, count: 2, run: { transit: travelling({ Rifle: 8 }, w.t + LONG_MS) } });
    tick(w);
    assertStep(w, 'Next');
    waiting(w, /troops or production queues/);
    assert.strictEqual(w.st.current().request.finished, 0, 'the run is not counted yet');
    zone.GetArmy = army;
    tick(w);
    var r = w.st.run();
    assert.strictEqual(r.step, w.S.RunStep.Muster, 'the next run begins');
    assert.strictEqual(w.st.current().request.finished, 1);
    assert.deepStrictEqual(plain(r.transitBase), { Rifle: 20 });
    drive(w, { until: at('Supply') });
    assertStep(w, 'Supply');
    assert.deepStrictEqual(plain(w.st.run().snapshot), { Rifle: 28 });
    assert.ok(logged(w, /snapshot: 28 Rifle \(on the way home: 8 Rifle\)/));
    assert.strictEqual(w.st.run().transitBase, null, 'Snapshot drops the base on its exit');
    assert.strictEqual(transitOf(w).length, 1, 'still on the way');
});

t.test('transit: troops landing before the next Snapshot are counted once there', function () {
    var w = homeWorld();
    series(w, { step: w.S.RunStep.Next, count: 2, run: { transit: travelling({ Rifle: 8 }, w.t + LONG_MS) } });
    tick(w);
    assert.deepStrictEqual(plain(w.st.run().transitBase), { Rifle: 20 });
    w.frees[HOME].Rifle += 8;
    drive(w, { until: at('Supply') });
    assertStep(w, 'Supply');
    assert.deepStrictEqual(plain(w.st.run().snapshot), { Rifle: 28 }, 'home total, no pending part');
    assert.ok(logged(w, /landed at home: 8 Rifle/));
    assert.deepStrictEqual(transitOf(w), []);
    // After a map that lost nothing, Account finds no loss.
    w.st.go(w.S.RunStep.Account, 'test');
    drive(w, { until: at('Next') });
    assertStep(w, 'Next');
    assert.ok(logged(w, /lost: none/));
    assert.strictEqual(w.productionOrders.length, 0);
});

t.test('transit: a landing during a Population pause is retired on the resumed pass; nextRun carries nothing', function () {
    var w = homeWorld({ free: { Rifle: 10 }, pop: 0, population: 0 });
    series(w, { step: w.S.RunStep.Population, count: 2,
        run: { snapshot: { Rifle: 20 }, transit: travelling({ Rifle: 8 }, w.t + LONG_MS) } });
    tick(w);
    play(w);
    assertPaused(w, w.S.RunPause.RetrainShort, /cannot retrain/);
    w.frees[HOME].Rifle += 8;
    w.pop = 5;
    assert.strictEqual(w.S.modules.adventures.run.resume(), true);
    drive(w, { until: at('Next') });
    assertStep(w, 'Next');
    assert.ok(logged(w, /landed at home: 8 Rifle/));
    assert.deepStrictEqual(transitOf(w), []);
    assert.deepStrictEqual(ordersOf(w), ['Rifle 2']);
    tick(w);
    var r = w.st.run();
    assert.strictEqual(r.step, w.S.RunStep.Muster, 'the next run begins');
    assert.deepStrictEqual(plain(r.transit), []);
    assert.strictEqual(r.transitBase, null);
});

t.test('transit: Home Supply short but covered by troops on the way home waits, with no pause and no stop', function () {
    var w = homeWorld({ free: { Rifle: 4 } });
    w.queues[0].entries.push({ type: 'Rifle', amount: 1 });
    series(w, { step: w.S.RunStep.Supply, finished: 1, count: 2,
        run: { snapshot: { Rifle: 8 }, transit: travelling({ Rifle: 3 }, w.t + LONG_MS) } });
    for (var i = 0; i < 5; i++) { tick(w); play(w); w.t += 60000; }
    assertStep(w, 'Supply');
    assert.ok(/^waiting for production: 4 Rifle \(part on the way home\)$/.test(w.st.run().blocker.reason),
        w.st.run().blocker.reason);
    assert.strictEqual(w.st.run().stopReason, null);
    assert.strictEqual(w.raises.length, 0);
});

// A population buff whose send fails.
function popBuffFails(w) {
    var buffs = w.S.core.buffs;
    var population = buffs.population;
    buffs.population = function () {
        var def = population.apply(buffs, arguments);
        def.send = function () { return false; };
        return def;
    };
}

t.test('settlers only: too few population buffs skips retraining; off it pauses RetrainShort; a failed buff skips', function () {
    var w = homeWorld({ free: { Rifle: 10 }, pop: 0, population: 0,
        settings: { retrain: true, retrainSettlersOnly: true } });
    series(w, { step: w.S.RunStep.Population, run: { snapshot: { Rifle: 20 } } });
    tick(w);
    play(w);
    assertStep(w, 'Next');
    assert.ok(logged(w, /retraining skipped: not enough settlers: .*population buffs in stock: 0/));
    assert.ok(logged(w, /Population -> Next \(retrain skipped\)/));
    assert.strictEqual(popBuffs(w).length, 0);
    assert.strictEqual(w.productionOrders.length, 0);

    w = homeWorld({ free: { Rifle: 10 }, pop: 0, population: 0 });
    series(w, { step: w.S.RunStep.Population, run: { snapshot: { Rifle: 20 } } });
    tick(w);
    play(w);
    assertPaused(w, w.S.RunPause.RetrainShort, /cannot retrain/);

    w = homeWorld({ free: { Rifle: 10 }, pop: 4, settings: { retrain: true, retrainSettlersOnly: true } });
    popBuffFails(w);
    series(w, { step: w.S.RunStep.Population, run: { snapshot: { Rifle: 20 } } });
    drive(w, { until: at('Next'), max: 60 });
    assertStep(w, 'Next');
    assert.ok(logged(w, /retraining skipped: population buff failed/));
    assert.strictEqual(w.productionOrders.length, 0);
});

t.test('series stop: run 2 short at Supply with retrain off stops the series with the setting hint', function () {
    var w = homeWorld({ free: { Rifle: 4 }, settings: { retrain: false } });
    series(w, { step: w.S.RunStep.Supply, finished: 1, count: 3 });
    tick(w);
    assertStep(w, 'Supply');
    w.t += w.S.modules.adventures.loader.READ_LAG_MS;
    tick(w);
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Done, 'status ' + r.status);
    assert.strictEqual(r.pause, null, 'no pause');
    assert.ok(/^troops short: .*Retrain lost troops/.test(r.stopReason), r.stopReason);
    assert.ok(/^Stopped:/.test(w.st.status()), w.st.status());
    assert.ok(logged(w, /series stopped at /, 'warn'));
    assert.strictEqual(w.S.modules.adventures.run.resume(), false);
    assert.strictEqual(w.raises.length, 0);
});

t.test('series stop: run 1 short still pauses TroopsShort; run 2 with settlers only gives the settlers hint', function () {
    var w = homeWorld({ free: { Rifle: 4 }, settings: { retrain: false } });
    series(w, { step: w.S.RunStep.Supply, count: 2 });
    tick(w);
    w.t += w.S.modules.adventures.loader.READ_LAG_MS;
    tick(w);
    assertPaused(w, w.S.RunPause.TroopsShort, /troops short: /);
    assert.strictEqual(w.st.run().stopReason, null);

    w = homeWorld({ free: { Rifle: 4 }, settings: { retrain: true, retrainSettlersOnly: true } });
    series(w, { step: w.S.RunStep.Supply, finished: 1, count: 2, run: { snapshot: { Rifle: 4 } } });
    tick(w);
    w.t += w.S.modules.adventures.loader.READ_LAG_MS;
    tick(w);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Done);
    assert.ok(/lack of settlers/.test(w.st.run().stopReason), w.st.run().stopReason);
});

t.test('series stop: an unreadable free pool or short queue at run 2 Supply waits for the read, then stops', function () {
    var w = homeWorld({ free: { Rifle: 4 }, settings: { retrain: false } });
    var zone = w.H.host.game.zone;
    var army = zone.GetArmy;
    zone.GetArmy = function () { return null; };
    series(w, { step: w.S.RunStep.Supply, finished: 1, count: 2 });
    tick(w);
    W.ticksFor(w, w.S.modules.adventures.loader.READ_LAG_MS + LONG_MS);
    assertStep(w, 'Supply');
    assert.strictEqual(w.st.run().stopReason, null);
    assert.ok(w.st.current().busy, 'a read wait is recorded');
    zone.GetArmy = army;
    tick(w);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Done, 'stopped once the pool reads short');
    assert.ok(/Retrain lost troops/.test(w.st.run().stopReason), w.st.run().stopReason);

    w = homeWorld({ free: { Rifle: 4 }, settings: { retrain: false } });
    var pzone = w.gi.mCurrentPlayerZone;
    var queue = pzone.GetProductionQueue;
    pzone.GetProductionQueue = function () { return null; };
    series(w, { step: w.S.RunStep.Supply, finished: 1, count: 2 });
    tick(w);
    W.ticksFor(w, w.S.modules.adventures.loader.READ_LAG_MS + LONG_MS);
    assertStep(w, 'Supply');
    waiting(w, /production queue of Rifle/);
    assert.strictEqual(w.st.run().stopReason, null);
    pzone.GetProductionQueue = queue;
    tick(w);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Done, 'stopped once the queue reads');
});

// ---- 21. Busy waits -----------------------------------------------------------------

t.test('waitBusy: logs once a minute under a moved clock, shows the remaining time, saves nothing, leaves r.since', function () {
    var w = homeWorld();
    var r = series(w);
    var since = r.since;
    var saves = 0;
    var save = w.st.save;
    w.st.save = function () {
        saves++;
        return save.apply(this, arguments);
    };
    function lines() {
        return w.H.logs().filter(function (l) { return /Bert \(1\.2\) busy/.test(l.args.join(' ')); }).length;
    }
    w.g2.state.task = { type: w.code.move, remaining: 7000 };
    tick(w);
    assert.strictEqual(lines(), 1);
    W.ticksFor(w, loaderOf(w).BUSY_LOG_MS - 10000);
    assert.strictEqual(lines(), 1);
    W.ticksFor(w, 10000);
    assert.strictEqual(lines(), 2);
    assert.ok(logged(w, /Bert \(1\.2\) busy, waited 1 min, remaining 7000 \(raw\)/));
    assert.strictEqual(saves, 0, 'the run file stays as it is');
    assert.strictEqual(w.st.run().since, since);
});

t.test('waitBusy: go, pause and a pass without a wait clear the record; an absent field is tolerated', function () {
    var w = homeWorld();
    onIsland(w, null, {});
    var r = series(w, { step: w.S.RunStep.Clear, zoneId: ZONE, run: { marks: plain(CLAIMED) } });
    var rs = w.st.current();
    var quest = lastQuest(w);
    quest.finished = true;
    w.g1.state.task = { type: w.code.attack };
    tick(w);
    assert.ok(rs.busy, 'the wait began');
    w.st.go(w.S.RunStep.Clear, 'test');
    assert.strictEqual(rs.busy, null, 'go');
    tick(w);
    assert.ok(rs.busy, 'the wait began again');
    w.st.pause(w.S.RunPause.User, 'paused by you');
    assert.strictEqual(rs.busy, null, 'pause');
    w.st.resume();
    tick(w);
    assert.ok(rs.busy, 'the wait began again');
    // Clear names a wait on every pass, so the pass with no wait is Close
    // inside its settle window, once its read works again.
    var open = w.adventures;
    w.st.go(w.S.RunStep.Close, 'test');
    w.adventures = null;
    tick(w);
    assert.ok(rs.busy, 'a wait on Close');
    w.adventures = open;
    tick(w);
    assertStep(w, 'Close');
    assert.strictEqual(rs.busy, null, 'a pass that no longer waits');
    w.st.go(w.S.RunStep.Clear, 'test');
    delete rs.busy;
    delete rs.busySeen;
    assert.strictEqual(w.st.waitsLong(r), true);
    tick(w);
    assertStep(w, 'Clear');
    assert.ok(rs.busy, 'the record comes back');
});

t.test('no site pauses GeneralBusy', function () {
    var w = homeWorld();
    assert.strictEqual(w.S.RunPause.GeneralBusy, undefined);
});
