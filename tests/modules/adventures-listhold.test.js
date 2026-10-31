'use strict';

// A specialist list that lost entries must hold a run, never pause it or act
// on it. A ghost (w.ghost in tests/stubs/adventures.js) is a real entry whose
// members read undefined for a moment. Each test puts one in front of a step
// that would read the absent general as a fact, then checks the step acts on
// the next clean read. A general that is really gone still pauses, after the
// grace.

var t = require('../runner');
var AC = require('../stubs/actions');
var W = require('../stubs/adventures');

var assert = t.assert;

var HOME = W.HOME;
var ZONE = W.ZONE;
var LOADOUT = W.LOADOUT;
var RUN_FILE = W.RUN_FILE;
var WAVE = 'C:/b/w1.txt';
var KEYS = { '1.1': true, '1.2': true };
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

// Viewing the island, Anna and Bert on their grids with their armies.
function islandWorld(extra) {
    var g1 = AC.general({ uid: '1.1', name: 'Anna', grid: 10, army: { Rifle: 5 } });
    var g2 = AC.general({ uid: '1.2', name: 'Bert', grid: 20, army: { Rifle: 3 } });
    var w = W.world({ generals: [g1, g2].concat(extra || []) });
    files(w);
    w.g1 = g1;
    w.g2 = g2;
    return w;
}

// Viewing home, Anna and Bert empty on their grids. o: world options.
function homeWorld(o) {
    var g1 = AC.general({ uid: '1.1', name: 'Anna', grid: 10 });
    var g2 = AC.general({ uid: '1.2', name: 'Bert', grid: 20 });
    var opts = { home: true, generals: [g1, g2], free: { Rifle: 20, Bow: 0 } };
    for (var k in (o || {})) if (Object.prototype.hasOwnProperty.call(o, k)) opts[k] = o[k];
    var w = W.world(opts);
    files(w);
    w.g1 = g1;
    w.g2 = g2;
    w.gi = w.H.host.game.gi;
    return w;
}

// The home world moved onto the island, viewing it.
function onIsland(w, generals, free) {
    w.adventures = [{ adventureName: 'BlackKnights', zoneID: ZONE }];
    w.lists[HOME].length = 0;
    generals.forEach(function (g) { w.place(g, ZONE); });
    w.frees[ZONE] = free || {};
    w.gi.visitZone(ZONE);
}

// A carrier (1.5) on its grid and two generals, by default at the star.
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

// ---- asserts ----------------------------------------------------------------

function ld(w) { return w.S.modules.adventures.loader; }

function sends(w) {
    return w.orders.length + w.raises.length + w.unloads.length + w.buffs.length + w.claims.length +
        w.zoneSends.length + w.buffActions.length + w.productionOrders.length + w.closes.length;
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

// One pass over a bad read: same step, no pause, nothing sent.
function holds(w) {
    var step = stepName(w);
    var before = sends(w);
    tick(w);
    play(w);
    assertStep(w, step);
    assert.strictEqual(sends(w), before, 'nothing sent');
}

function logged(w, re) {
    return w.H.logs().some(function (l) { return re.test(l.args.join(' ')); });
}

function ordersOf(w, code) {
    return w.orders.filter(function (o) { return o.code === code; })
        .map(function (o) { return o.key; }).sort();
}

// ---- one ghost tick -----------------------------------------------------------

t.test('Verify at home: a ghost tick with both armies raised holds, the clean read goes to StartMap', function () {
    var w = homeWorld();
    w.g1.state.army = { Rifle: 5 };
    w.g2.state.army = { Rifle: 3 };
    startRun(w, [WAVE], { step: w.S.RunStep.Verify });
    w.ghost(w.g1);
    w.ghost(w.g2);
    holds(w);
    tick(w);
    assertStep(w, 'StartMap');
    assert.ok(!w.H.logs().some(function (l) { return l.level === 'warn' && l.category === 'army'; }), 'no warning per entry');
    assert.strictEqual(w.H.logs().filter(function (l) { return /dropped \d+ of \d+/.test(l.args.join(' ')); }).length, 1,
        'one reader line');
});

[['Gate', 'Position'], ['Position', 'Supply'], ['Supply', 'Load'], ['Load', 'Reach'],
    ['Verify', 'Reach']].forEach(function (c) {
    t.test('wave ' + c[0] + ': a ghost tick holds, the clean read goes to ' + c[1], function () {
        var w = islandWorld();
        startRun(w, [WAVE], { step: w.S.WaveStep[c[0]] });
        w.ghost(w.g2);
        holds(w);
        tick(w);
        assertStep(w, c[1]);
    });
});

t.test('Supply at home: a ghost tick holds, the clean read goes to Load', function () {
    var w = homeWorld();
    startRun(w, [WAVE], { step: w.S.RunStep.Supply });
    w.ghost(w.g2);
    holds(w);
    tick(w);
    assertStep(w, 'Load');
});

t.test('Load at home: a ghost tick raises nobody, the clean read raises both', function () {
    var w = homeWorld();
    startRun(w, [WAVE], { step: w.S.RunStep.Load });
    w.ghost(w.g2);
    holds(w);
    tick(w);
    play(w);
    assertStep(w, 'Verify');
    assert.deepStrictEqual(w.raises.slice(0).sort(), ['1.1', '1.2']);
});

t.test('Depart: a ghost without a mark holds and sends nobody', function () {
    var w = homeWorld({ mapOpen: true });
    startRun(w, [WAVE], { step: w.S.RunStep.Depart });
    w.ghost(w.g2);
    holds(w);
    tick(w);
    play(w);
    assert.deepStrictEqual(w.zoneSends.map(function (s) { return s.key; }).sort(), ['1.1', '1.2']);
});

t.test('Depart: a ghost of a sent general does not read as departed', function () {
    var w = homeWorld({ mapOpen: true });
    var r = startRun(w, [WAVE], { step: w.S.RunStep.Depart });
    r.marks['depart:1.2'] = { sentAt: w.t, seen: false, sentOnce: true };
    w.ghost(w.g2);
    holds(w);
    assert.strictEqual(r.marks['depart:1.2'].seen, false);
    tick(w);
    assertStep(w, 'Depart');
    assert.strictEqual(r.marks['depart:1.2'].seen, false, 'listed and idle is not gone');
});

t.test('Arrive: a ghost tick holds, the clean read goes to StarAll', function () {
    var w = homeWorld();
    onIsland(w, [w.g1, w.g2]);
    startRun(w, [WAVE], { step: w.S.RunStep.Arrive });
    w.ghost(w.g2);
    holds(w);
    tick(w);
    assertStep(w, 'StarAll');
});

t.test('Recall: a ghost tick does not skip to JumpHome, the clean read sends both', function () {
    var w = homeWorld();
    onIsland(w, [w.g1, w.g2]);
    startRun(w, [WAVE], { step: w.S.RunStep.Recall });
    w.ghost(w.g1);
    w.ghost(w.g2);
    holds(w);
    tick(w);
    play(w);
    assert.deepStrictEqual(w.zoneSends.map(function (s) { return s.key; }).sort(), ['1.1', '1.2']);
});

t.test('Recall: one ghost does not count as gone, nobody is sent over that read', function () {
    var w = homeWorld();
    onIsland(w, [w.g1, w.g2]);
    startRun(w, [WAVE], { step: w.S.RunStep.Recall });
    w.ghost(w.g2);
    holds(w);
});

t.test('Recall: a null list still goes to JumpHome', function () {
    var w = homeWorld();
    onIsland(w, [w.g1, w.g2]);
    startRun(w, [WAVE], { step: w.S.RunStep.Recall });
    w.gi.mCurrentPlayerZone.GetSpecialists_vector = function () { return null; };
    tick(w);
    assertStep(w, 'JumpHome');
    assert.strictEqual(w.zoneSends.length, 0);
});

t.test('Position: a ghost on a Star line does not read as starred', function () {
    var g3 = AC.general({ uid: '1.3', name: 'Cora', grid: 30 });
    var w = islandWorld([g3]);
    writeJson(w.fs, WAVE, {
        '1.1': { grid: 10, target: 100, army: { Rifle: 5 }, order: 1 },
        '1.2': { grid: 20, target: 200, army: { Rifle: 3 }, order: 2 },
        '1.3': { grid: 0, army: {}, order: 3 }
    });
    startRun(w, [WAVE], { step: w.S.WaveStep.Position });
    w.ghost(g3);
    holds(w);
    tick(w);
    play(w);
    assert.deepStrictEqual(ordersOf(w, w.code.star), ['1.3']);
});

t.test('StarAll: a ghost tick does not move on, the clean read stars both', function () {
    var w = homeWorld();
    onIsland(w, [w.g1, w.g2]);
    startRun(w, [WAVE], { step: w.S.RunStep.StarAll });
    w.ghost(w.g1);
    holds(w);
    tick(w);
    play(w);
    assert.deepStrictEqual(ordersOf(w, w.code.star), ['1.1', '1.2']);
});

t.test('PackStar: a ghost holder is not planned around, the clean read places both', function () {
    var w = packWorld();
    startRun(w, [WAVE], { step: w.S.RunStep.PackStar, loadoutKeys: PACK_KEYS });
    w.ghost(w.g1);
    holds(w);
    tick(w);
    play(w);
    assert.deepStrictEqual(ordersOf(w, w.code.move), ['1.1', '1.2']);
});

t.test('Pack: ghost holders do not end the pack with troops left, the clean read raises', function () {
    var w = packWorld(10, 20);
    startRun(w, [WAVE], { step: w.S.RunStep.Pack, loadoutKeys: PACK_KEYS });
    w.ghost(w.g1);
    w.ghost(w.g2);
    w.ghost(w.c);
    holds(w);
    assert.ok(!logged(w, /left in the free pool/));
    tick(w);
    play(w);
    assert.deepStrictEqual(w.raises.slice(0).sort(), ['1.1', '1.2', '1.5']);
});

t.test('Clear: a ghost tick does not pass the pack check, the clean read goes back to PackStar', function () {
    var w = packWorld(10, 20);
    startRun(w, [WAVE], { step: w.S.RunStep.Clear, loadoutKeys: PACK_KEYS });
    w.ghost(w.c);
    holds(w);
    tick(w);
    assertStep(w, 'PackStar');
});

// ---- the window of bad reads ----------------------------------------------------

t.test('hold: bad reads pause NotObserved only after READ_MAX_MS, with nothing sent', function () {
    var w = islandWorld();
    startRun(w, [WAVE], { step: w.S.WaveStep.Gate });
    w.ghost(w.g2, 100);
    tick(w);
    W.ticksFor(w, ld(w).READ_MAX_MS);
    assertStep(w, 'Gate');
    w.t += 1;
    tick(w);
    assertPaused(w, w.S.RunPause.NotObserved, /specialist list incomplete for 60 s/);
    assert.strictEqual(sends(w), 0);
});

t.test('hold: a clean tick in between restarts the window', function () {
    var w = islandWorld();
    w.g1.state.task = { type: w.code.attack };     // keeps a clean Gate where it is
    startRun(w, [WAVE], { step: w.S.WaveStep.Gate });
    w.ghost(w.g2, 5);
    W.ticksFor(w, 60000);
    assert.strictEqual(w.st.current().listBadSince, null, 'the clean tick cleared it');
    w.ghost(w.g2, 100);
    W.ticksFor(w, 10000 + ld(w).READ_MAX_MS);
    assertStep(w, 'Gate');
    w.t += 1;
    tick(w);
    assertPaused(w, w.S.RunPause.NotObserved);
});

t.test('hold: a Resume gets a fresh window', function () {
    var w = islandWorld();
    startRun(w, [WAVE], { step: w.S.WaveStep.Gate });
    w.ghost(w.g2, 100);
    tick(w);
    W.ticksFor(w, ld(w).READ_MAX_MS + 1);
    assertPaused(w, w.S.RunPause.NotObserved);
    assert.strictEqual(w.st.current().listBadSince, null);
    assert.strictEqual(w.S.modules.adventures.run.resume(), true);
    tick(w);
    W.ticksFor(w, ld(w).READ_MAX_MS);
    assertStep(w, 'Gate');
    w.t += 1;
    tick(w);
    assertPaused(w, w.S.RunPause.NotObserved);
});

t.test('hold: one bad tick long after another starts a new window', function () {
    var w = islandWorld();
    startRun(w, [WAVE], { step: w.S.WaveStep.Gate });
    w.ghost(w.g2);
    tick(w);
    // No plan call in between: another zone viewed, or the kernel paused.
    w.t += 300000;
    w.ghost(w.g2);
    tick(w);
    assertStep(w, 'Gate');
    assert.strictEqual(w.st.current().listBadSince, w.t);
});

// ---- a general really gone --------------------------------------------------------

// The general is absent from the first pass on, on reads that are clean.
function pausesAfterGrace(w, re) {
    tick(w);
    var step = stepName(w);
    assertStep(w, step);
    W.ticksFor(w, ld(w).MISSING_GRACE_MS - 1);
    assertStep(w, step);
    w.t += 1;
    tick(w);
    assertPaused(w, w.S.RunPause.GeneralMissing, re);
    assert.strictEqual(sends(w), 0);
}

['Position', 'Supply', 'Load', 'Verify'].forEach(function (name) {
    t.test('gone: wave ' + name + ' pauses GeneralMissing only after the grace', function () {
        var w = islandWorld();
        w.fighters.splice(1, 1);
        startRun(w, [WAVE], { step: w.S.WaveStep[name], loadoutKeys: KEYS });
        pausesAfterGrace(w, /1\.2\) is not on the island|^1\.2 is not on the island/);
    });
});

t.test('gone: a donor at Unload pauses GeneralMissing only after the grace', function () {
    var w = islandWorld();
    var r = startRun(w, [WAVE], { step: w.S.WaveStep.Unload, loadoutKeys: KEYS });
    r.donors = ['1.9'];
    pausesAfterGrace(w, /donor 1\.9 is not on the island/);
});

t.test('gone: Depart pauses GeneralMissing only after the grace', function () {
    var w = homeWorld({ mapOpen: true });
    w.lists[HOME].splice(1, 1);
    startRun(w, [WAVE], { step: w.S.RunStep.Depart, loadoutKeys: KEYS });
    pausesAfterGrace(w, /1\.2 left home without being sent/);
});

t.test('gone: a re-entered Gate gives the grace even with its own wait long over', function () {
    var w = islandWorld();
    w.fighters.splice(1, 1);
    var r = startRun(w, [WAVE], { step: w.S.WaveStep.Gate, loadoutKeys: KEYS });
    r.since = w.t - w.ex.GATE_MISSING_MS * 10;
    pausesAfterGrace(w, /1\.2/);
});

// lookup() of the key finds nothing on a clean read, while the inventory still
// lists the general: it left the list between the two. Returns the undo.
function hideFromLookup(w, key) {
    var sp = w.S.core.specialists;
    var lookup = sp.lookup;
    sp.lookup = function (k) {
        return k === key ? { ok: true, spec: null } : lookup.apply(sp, arguments);
    };
    return function () { sp.lookup = lookup; };
}

t.test('gone: PackStar pauses GeneralMissing only after the grace', function () {
    var w = packWorld();
    startRun(w, [WAVE], { step: w.S.RunStep.PackStar, loadoutKeys: PACK_KEYS });
    hideFromLookup(w, '1.1');
    pausesAfterGrace(w, /Anna \(1\.1\) is not on the island/);
});

t.test('gone: PackStar holding over a finished round counts that round once', function () {
    var w = packWorld();
    var r = startRun(w, [WAVE], { step: w.S.RunStep.PackStar, loadoutKeys: PACK_KEYS });
    var round = ld(w).startRound(r, r.step, ['1.1']);
    round.results['1.1'] = { status: w.S.ActionResult.Verified, reason: '' };
    var show = hideFromLookup(w, '1.1');
    W.ticksFor(w, 40000);
    assertStep(w, 'PackStar');
    assert.strictEqual(r.rounds, 0, 'no round counted over the hold');
    show();
    tick(w);
    assertStep(w, 'PackStar');
    assert.strictEqual(r.rounds, 1);
});

t.test('gone: a Resume with the general still gone pauses on the next report', function () {
    var w = islandWorld();
    w.fighters.splice(1, 1);
    startRun(w, [WAVE], { step: w.S.WaveStep.Position, loadoutKeys: KEYS });
    tick(w);
    W.ticksFor(w, ld(w).MISSING_GRACE_MS);
    assertPaused(w, w.S.RunPause.GeneralMissing);
    assert.strictEqual(w.S.modules.adventures.run.resume(), true);
    w.st.go(w.S.WaveStep.Position, 'test');
    tick(w);
    assertPaused(w, w.S.RunPause.GeneralMissing);
});

t.test('missingLong: a longer gap restarts the time, per key, and a lost map is rebuilt', function () {
    var w = islandWorld();
    var r = startRun(w, [WAVE], { step: w.S.WaveStep.Gate });
    var l = ld(w);
    delete w.st.current().missing;
    assert.strictEqual(l.missingLong(r, 'a'), false);
    w.t += 20000;
    assert.strictEqual(l.missingLong(r, 'a'), false);
    w.t += 30001;
    assert.strictEqual(l.missingLong(r, 'a'), false, 'restarted');
    assert.strictEqual(l.missingLong(r, 'b'), false);
    w.t += 30000;
    l.missingLong(r, 'a');
    w.t += 30000;
    assert.strictEqual(l.missingLong(r, 'a'), true);
    assert.strictEqual(l.missingLong(r, 'c'), false, 'another key has its own time');
});

// ---- passes that say nothing about a busy wait ----------------------------------------

function busyLines(w) {
    return w.H.logs().filter(function (l) { return /, waited \d+ min/.test(l.args.join(' ')); }).length;
}

// tick(w) starts the wait; hide() sets up one pass that says nothing about it,
// show() (optional) undoes that, and a clean pass follows. The record is the
// same all along and nothing is logged again.
function keepsWait(w, hide, show) {
    tick(w);
    var rs = w.st.current();
    var b = rs.busy;
    assert.ok(b, 'the wait began');
    var since = b.since;
    var noted = b.noted;
    var lines = busyLines(w);
    w.t += 5000;
    hide();
    tick(w);
    w.t += 5000;
    if (show) show();
    tick(w);
    assert.strictEqual(rs.busy, b, 'the same record');
    assert.strictEqual(b.since, since);
    assert.strictEqual(b.noted, noted);
    assert.strictEqual(busyLines(w), lines, 'no second log line');
}

t.test('a list hold does not end a busy wait', function () {
    var w = islandWorld();
    w.g1.state.task = { type: w.code.attack };
    startRun(w, [WAVE], { step: w.S.WaveStep.Gate });
    keepsWait(w, function () { w.ghost(w.g2); });
    assertStep(w, 'Gate');
});

t.test('a read hold does not end a busy wait', function () {
    var w = packWorld();
    w.auto.walk = true;
    startRun(w, [WAVE], { step: w.S.RunStep.PackStar, loadoutKeys: PACK_KEYS });
    tick(w);
    play(w);
    var zone = w.H.host.game.zone;
    var army = zone.GetArmy;
    keepsWait(w, function () {
        zone.GetArmy = function () { return null; };
    }, function () {
        zone.GetArmy = army;
    });
    assertStep(w, 'PackStar');
});

t.test('a missing report does not end a busy wait', function () {
    var w = islandWorld();
    w.g1.state.task = { type: w.code.attack };
    startRun(w, [WAVE], { step: w.S.WaveStep.Gate });
    keepsWait(w, function () {
        w.fighters.splice(w.fighters.indexOf(w.g2), 1);
    }, function () {
        w.fighters.push(w.g2);
    });
    assertStep(w, 'Gate');
});

t.test('Clear: a null quest list does not end a busy wait', function () {
    var w = homeWorld();
    onIsland(w, [w.g1, w.g2]);
    var quests = [{ key: 'q9', name: 'Final', finished: true, last: true }];
    w.quests = quests;
    w.g1.state.task = { type: w.code.attack };
    startRun(w, [WAVE], { step: w.S.RunStep.Clear });
    keepsWait(w, function () {
        w.quests = null;
    }, function () {
        w.quests = quests;
    });
    assertStep(w, 'Clear');
});

// One pass reads a list that lacks the last quest. On a young step that pass
// says so itself; on an old one, taking this for an unfinished quest would pause.
[
    { name: 'an empty list', quests: [] },
    { name: 'a list of other quests', quests: [{ key: 'q1', name: 'Side', finished: false, last: false }] }
].forEach(function (c) {
    [
        { name: 'a young step', age: 0 },
        { name: 'past CLEAR_MAX_MS', age: 1 }
    ].forEach(function (a) {
        t.test('Clear: a list without the last quest does not end a busy wait: ' + c.name + ', ' + a.name, function () {
            var w = homeWorld();
            onIsland(w, [w.g1, w.g2]);
            var quests = [{ key: 'q9', name: 'Final', finished: true, last: true }];
            w.quests = quests;
            w.g1.state.task = { type: w.code.attack };
            var r = startRun(w, [WAVE], { step: w.S.RunStep.Clear });
            if (a.age) w.t = r.since + w.S.modules.adventures.away.CLEAR_MAX_MS + a.age;
            keepsWait(w, function () {
                w.quests = c.quests;
            }, function () {
                w.quests = quests;
            });
            assertStep(w, 'Clear');
        });
    });
});

// A clean read lacks the only busy general, with the deadline far off.
function lacksBusyGeneral(w, name) {
    w.g1.state.task = { type: w.code.move };
    keepsWait(w, function () {
        w.fighters.splice(w.fighters.indexOf(w.g1), 1);
    }, function () {
        w.fighters.push(w.g1);
    });
    assertStep(w, name);
}

t.test('a general not listed before the deadline does not end a busy wait: Arrive', function () {
    var w = homeWorld();
    onIsland(w, [w.g1, w.g2]);
    startRun(w, [WAVE], { step: w.S.RunStep.Arrive });
    lacksBusyGeneral(w, 'Arrive');
});

t.test('a general not listed before the deadline does not end a busy wait: gather', function () {
    var w = homeWorld();
    startRun(w, [WAVE], { step: w.S.RunStep.Muster });
    lacksBusyGeneral(w, 'Muster');
});

// ---- refusals over an unreadable general --------------------------------------------

t.test('settleRound: a round refused unreadable is a round without effect', function () {
    var w = islandWorld();
    var r = startRun(w, [WAVE], { step: w.S.WaveStep.Position });
    var round = ld(w).startRound(r, r.step, ['1.1']);
    round.results['1.1'] = { status: w.S.ActionResult.Refused, reason: w.S.core.specialists.UNREADABLE };
    var failed = 0;
    var res = ld(w).settleRound(r, r.step, function () { failed++; }, 'positioning');
    assert.strictEqual(res, 'new');
    assert.strictEqual(failed, 0);
    assert.strictEqual(r.rounds, 1);
});

t.test('settleRound: a retry refused unreadable went out once and stays a failure', function () {
    var w = islandWorld();
    var r = startRun(w, [WAVE], { step: w.S.WaveStep.Position });
    var round = ld(w).startRound(r, r.step, ['1.1']);
    round.results['1.1'] = { status: w.S.ActionResult.Failed, reason: 'retry refused: ' + w.S.core.specialists.UNREADABLE };
    var failed = [];
    var res = ld(w).settleRound(r, r.step, function (f) { failed.push(f.key); }, 'positioning');
    assert.strictEqual(res, 'paused');
    assert.deepStrictEqual(failed, ['1.1']);
});

t.test('Depart: a marked send whose verify ran into a ghost is not sent again', function () {
    var w = homeWorld({ mapOpen: true });
    w.auto.travel = false;
    startRun(w, [WAVE], { step: w.S.RunStep.Depart });
    tick(w);
    play(w, function () { return w.zoneSends.length === 2; });
    w.ghost(w.g1);
    w.ghost(w.g2);
    play(w);
    tick(w);
    tick(w);
    play(w);
    assertPaused(w, w.S.RunPause.DepartFailed, /retry refused: specialist unreadable/);
    assert.strictEqual(w.zoneSends.length, 2);
});

t.test('Attack: a line refused unreadable is paced again and goes out on the clean read', function () {
    var w = islandWorld();
    startRun(w, [WAVE], { step: w.S.WaveStep.Attack });
    tick(w);
    w.ghost(w.g1);
    play(w);
    assert.strictEqual(w.orders.length, 0);
    tick(w);
    assertStep(w, 'Attack');
    tick(w);
    play(w);
    assertStep(w, 'Attack');
    assert.deepStrictEqual(ordersOf(w, w.code.attack), ['1.1', '1.2']);
});

t.test('Attack: a real refusal still pauses AttackRefused', function () {
    var w = islandWorld();
    startRun(w, [WAVE], { step: w.S.WaveStep.Attack });
    w.g1.state.army = {};
    tick(w);
    play(w);
    tick(w);
    assertPaused(w, w.S.RunPause.AttackRefused, /refused: no units/);
});

// ---- flips inside a pass ----------------------------------------------------------

t.test('anyAttacking: an incomplete read counts as not quiet', function () {
    var w = islandWorld();
    assert.strictEqual(ld(w).anyAttacking(), false);
    w.ghost(w.g1);
    assert.strictEqual(ld(w).anyAttacking(), true);
});

t.test('Settle: a flip inside the pass does not start the quiet time', function () {
    var w = islandWorld();
    w.g2.state.grid = 55;
    w.sent.placeable = 3;
    startRun(w, [WAVE], { step: w.S.WaveStep.Position });
    tick(w);
    assertStep(w, 'Settle');
    w.ghostAfterRead(w.g1);
    tick(w);
    assertStep(w, 'Settle');
    assert.strictEqual(w.st.run().settledAt, null);
    tick(w);
    assert.strictEqual(w.st.run().settledAt, w.t);
});

t.test('Validate: a flip before the check holds with no WaveFile pause', function () {
    var w = homeWorld();
    startRun(w, [WAVE], { step: w.S.RunStep.Validate });
    w.ghostAfterRead(w.g2);
    tick(w);
    assertStep(w, 'Validate');
    tick(w);
    assertStep(w, 'Snapshot');
});

// ---- starting a run ---------------------------------------------------------------

function template(w) {
    w.stock.push({ type: 'Adventure', resource: 'BlackKnights', amount: 3, uid: 'map' });
    w.H.ctx.prompt = function (text, def) { return def; };
    w.H.ctx.confirm = function () { return true; };
    return w.S.modules.adventures.templates.save({
        label: 'Black Knights', adventure: 'BlackKnights', loadout: LOADOUT, waves: [WAVE],
        speedBuff: 'SpeedBuffDefault'
    }, 1000).id;
}

t.test('Start on the island: a ghost starts nothing and says to retry; the clean read starts', function () {
    var w = islandWorld();
    var id = template(w);
    var run = w.S.modules.adventures.run;
    w.ghost(w.g2);
    assert.strictEqual(run.start(id), false);
    assert.strictEqual(w.st.run(), null);
    assert.ok(w.alerts.some(function (a) { return /cannot be read right now; try again/.test(a); }), w.alerts.join(' | '));
    assert.ok(!w.alerts.some(function (a) { return /cannot start/.test(a); }), w.alerts.join(' | '));
    tick(w);
    assert.strictEqual(run.start(id), true);
    assert.strictEqual(w.st.run().step, w.S.WaveStep.Gate);
});

t.test('Start at home: the generals play no part, so a ghost does not stop it', function () {
    var w = homeWorld();
    var id = template(w);
    w.ghost(w.g2);
    assert.strictEqual(w.S.modules.adventures.run.start(id), true);
    assert.strictEqual(w.st.run().step, w.S.RunStep.Muster);
});

// ---- memory only ------------------------------------------------------------------

t.test('listBadSince, listBadLast and missing never reach the run file', function () {
    var w = islandWorld();
    var r = startRun(w, [WAVE], { step: w.S.WaveStep.Gate });
    w.ghost(w.g2);
    tick(w);
    ld(w).missingLong(r, '1.2');
    var rs = w.st.current();
    assert.strictEqual(typeof rs.listBadSince, 'number');
    assert.ok(rs.missing['1.2'], 'the record exists in memory');
    w.st.save();
    assert.ok(!/listBad|"missing"/.test(w.fs.disk[RUN_FILE]), w.fs.disk[RUN_FILE]);
});
