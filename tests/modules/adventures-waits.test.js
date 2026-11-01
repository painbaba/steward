'use strict';

// Waits that have no limit: a step whose condition only the game or the user
// can end shows a named wait in the menu, logs it once a minute and ends by
// itself, and Pause, End repetition and Stop work inside it. A failed read
// holds a step the same way (waitRead), a general the list lacks gets the
// grace and no pause, and a wait that ends in a pause counts quiet time, not
// elapsed time. Worlds come from tests/stubs/adventures.js; the clock moves
// by passes, because a bare jump over passes is a gap the quiet clock does
// not count.

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
var TICK_MS = 10000;

var tick = W.tick;
var play = W.play;
var stepName = W.stepName;
var writeJson = W.writeJson;

// ---- worlds -----------------------------------------------------------------

function gen(uid, name, grid, more) {
    var o = { uid: uid, name: name, grid: grid, army: {} };
    var k;
    for (k in (more || {})) if (Object.prototype.hasOwnProperty.call(more, k)) o[k] = more[k];
    return AC.general(o);
}

// Anna (1.1) and Bert (1.2) at home; o: world options.
function homeWorld(o) {
    var g1 = gen('1.1', 'Anna', 10);
    var g2 = gen('1.2', 'Bert', 20);
    var opts = { home: true, generals: [g1, g2], free: { Rifle: 20, Bow: 0 } };
    for (var k in (o || {})) if (Object.prototype.hasOwnProperty.call(o, k)) opts[k] = o[k];
    var w = W.world(opts);
    writeJson(w.fs, LOADOUT, {
        '1.1': { grid: 10, army: { Rifle: 5 } },
        '1.2': { grid: 20, army: { Rifle: 3 } }
    });
    writeJson(w.fs, WAVE, {
        '1.1': { grid: 10, target: 100, army: { Rifle: 5 }, order: 1, name: 'Anna' },
        '1.2': { grid: 20, target: 200, army: { Rifle: 3 }, order: 2, name: 'Bert' }
    });
    w.g1 = g1;
    w.g2 = g2;
    w.gi = w.H.host.game.gi;
    w.rm = w.S.modules.adventures.runmenu;
    w.run = w.S.modules.adventures.run;
    w.visits = [];
    var visit = w.gi.visitZone;
    w.gi.visitZone = function (id) {
        w.visits.push({ id: id, t: w.t });
        return visit.apply(this, arguments);
    };
    return w;
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

// A run at `step` (a RunStep name); o.zoneId, o.count, o.run.
function series(w, step, o) {
    o = o || {};
    var r = w.st.newRun({
        id: 42, templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights',
        zoneId: o.zoneId === undefined ? ZONE : o.zoneId,
        paths: [WAVE], loadoutPath: LOADOUT, loadoutKeys: KEYS, waveIndex: 0, speedBuff: '',
        step: w.S.RunStep[step]
    });
    var k;
    for (k in (o.run || {})) if (Object.prototype.hasOwnProperty.call(o.run, k)) r[k] = o.run[k];
    w.st.begin({
        templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights', count: o.count || 1, ended: false,
        requested: w.t, finished: 0, closedAt: null
    }, r);
    return w.st.run();
}

// ---- helpers ----------------------------------------------------------------

function ld(w) { return w.S.modules.adventures.loader; }

function pass(w) {
    tick(w);
    play(w);
}

// The clock forward by ms, one pass every TICK_MS.
function span(w, ms) {
    var end = w.t + ms;
    while (w.t < end) {
        w.t = Math.min(w.t + TICK_MS, end);
        pass(w);
    }
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

function labelOf(item) {
    if (item.separator) return '---';
    return typeof item.label === 'function' ? item.label({}) : item.label;
}

// The menu's status line.
function statusLine(w) {
    return labelOf(w.rm.items()[1]);
}

// The adventures log lines (category adventures) matching re.
function logLines(w, re) {
    return w.H.logs().filter(function (l) {
        return l.category === 'adventures' && re.test(l.args.join(' '));
    });
}

function sends(w) {
    return w.orders.length + w.raises.length + w.unloads.length + w.buffs.length + w.claims.length +
        w.zoneSends.length + w.buffActions.length + w.productionOrders.length + w.closes.length;
}

function sentTo(w) {
    return w.zoneSends.map(function (s) { return s.key; }).sort();
}

function busy(w) { return w.st.current().busy; }

// ---- 1. Named waits stay Running, log once a minute, end by themselves --------

// Each row: the world, the step, the wait's text, how the game ends it and
// where the run goes then.
var GetArmy;
var ROWS = [
    {
        name: 'Arrive: a general not here yet', step: 'Arrive', text: /1\.2 not here yet/,
        setup: function (w) { onIsland(w, [w.g1]); },
        end: function (w) { w.place(w.g2, ZONE); }, next: 'StarAll'
    },
    {
        name: 'Arrive: a general on his way', step: 'Arrive', text: /Bert \(1\.2\) busy/,
        setup: function (w) {
            onIsland(w);
            w.g2.state.travelling = true;
            w.g2.state.task = { type: w.code.travel, remaining: 1000 };
        },
        end: function (w) { w.arrive(); }, next: 'StarAll'
    },
    {
        name: 'Arrive: armies not readable', step: 'Arrive', text: /armies not readable/,
        setup: function (w) {
            onIsland(w);
            GetArmy = w.H.host.game.zone.GetArmy;
            w.H.host.game.zone.GetArmy = function () { return null; };
        },
        end: function (w) { w.H.host.game.zone.GetArmy = GetArmy; }, next: 'StarAll'
    },
    {
        name: 'Jump: the zone does not load', step: 'Jump', text: /zone 7 not loaded/,
        setup: function (w) { w.adventures = [{ adventureName: 'BlackKnights', zoneID: ZONE }]; w.auto.visit = false; },
        end: function (w) { w.auto.visit = true; w.gi.visitZone(ZONE); }, next: 'Arrive'
    },
    {
        name: 'Jump: the target zone id is not known', step: 'Jump', text: /target zone id not readable/,
        zoneId: null,
        setup: function (w) { w.adventures = [{ adventureName: 'BlackKnights', zoneID: ZONE }]; },
        end: function (w) { w.st.run().zoneId = ZONE; w.gi.visitZone(ZONE); }, next: 'Arrive'
    },
    {
        name: 'Clear: the last quest is not finished while a battle runs', step: 'Clear',
        text: /last quest not finished, 0 of 5 min quiet/,
        setup: function (w) { onIsland(w, null, {}); w.g1.state.task = { type: w.code.attack }; },
        end: function (w) { w.quests[0].finished = true; w.g1.state.task = null; }, next: 'LastQuest'
    },
    {
        name: 'Clear: the quest list is not readable', step: 'Clear', text: /quest list not readable/,
        setup: function (w) { onIsland(w, null, {}); w.quests = null; },
        end: function (w) { w.quests = [{ key: 'q9', name: 'Final', finished: true, last: true }]; }, next: 'LastQuest'
    },
    {
        name: 'Recall: a general busy on the adventure', step: 'Recall', text: /Bert \(1\.2\) busy on the adventure/,
        setup: function (w) { onIsland(w); w.g2.state.task = { type: w.code.attack }; },
        end: function (w) { w.g2.state.task = null; }, sent: ['1.1', '1.2']
    },
    {
        name: 'Recall: the specialist list is not readable', step: 'Recall', text: /specialist list not readable/,
        setup: function (w) {
            onIsland(w);
            w.gi.mCurrentPlayerZone.GetSpecialists_vector = function () { return null; };
        },
        end: function (w) {
            w.gi.mCurrentPlayerZone.GetSpecialists_vector = function () { return w.lists[w.gi.mCurrentViewedZoneID] || []; };
        },
        sent: ['1.1', '1.2']
    },
    {
        name: 'Muster: a general not here yet', step: 'Muster', text: /Bert \(1\.2\) not here yet|1\.2 not here yet/,
        setup: function (w) { w.lists[HOME].splice(w.lists[HOME].indexOf(w.g2), 1); w.place(w.g2, ZONE); },
        end: function (w) { w.lists[ZONE].splice(w.lists[ZONE].indexOf(w.g2), 1); w.place(w.g2, HOME); }, next: 'Validate'
    }
];

function rowWorld(row) {
    var w = homeWorld({ mapOpen: true });
    row.setup(w);
    series(w, row.step, { zoneId: row.zoneId, count: 3 });
    return w;
}

ROWS.forEach(function (row) {
    t.test('wait: ' + row.name + ' stays Running 30 min, names itself, logs once a minute and ends by itself', function () {
        var w = rowWorld(row);
        span(w, 30 * MIN);
        assertStep(w, row.step);
        assert.ok(row.text.test(statusLine(w)), statusLine(w));
        assert.ok(row.text.test(busy(w).text), busy(w).text);
        var lines = logLines(w, row.text).filter(function (l) { return /waited/.test(l.args.join(' ')); });
        assert.ok(lines.length >= 25 && lines.length <= 31, 'log lines ' + lines.length);
        assert.strictEqual(w.st.run().pause, null);
        row.end(w);
        if (row.next) {
            tick(w);
            assertStep(w, row.next);
        } else {
            pass(w);
            assert.deepStrictEqual(sentTo(w), row.sent);
        }
    });

    t.test('wait: ' + row.name + ' lets Pause, End repetition, Resume and Stop work', function () {
        var w = rowWorld(row);
        span(w, 5 * MIN);
        var step = stepName(w);
        var before = sends(w);
        assert.strictEqual(w.run.endRepetition(), true);
        assertStep(w, step);
        assert.strictEqual(w.st.current().request.ended, true);
        assert.strictEqual(w.run.pause(), true);
        assertPaused(w, w.S.RunPause.User);
        span(w, MIN);
        assertPaused(w, w.S.RunPause.User);
        assert.strictEqual(sends(w), before, 'nothing sent while paused');
        assert.strictEqual(w.run.resume(), true);
        span(w, MIN);
        assertStep(w, step);
        assert.strictEqual(sends(w), before, 'nothing sent by the wait');
        assert.strictEqual(w.run.stop(), true);
        assert.strictEqual(w.st.run(), null);
        assert.doesNotThrow(function () { pass(w); w.rm.items(); });
    });
});

// ---- 2. Read waits (waitRead) --------------------------------------------------

// Clear with the quest open and a battle running: the good pass waits on the
// quest, the bad pass has no quest list. The battle keeps the quiet clock
// from running out.
function clearWorld() {
    var w = homeWorld({ mapOpen: true });
    onIsland(w, null, {});
    w.g1.state.task = { type: w.code.attack };
    series(w, 'Clear');
    w.goodQuests = w.quests;
    return w;
}

function listBad(w, bad) { w.quests = bad ? null : w.goodQuests; }

t.test('read: a flapping read logs at most once a minute', function () {
    var w = clearWorld();
    var n = 0;
    var end = w.t + 10 * MIN;
    while (w.t < end) {
        w.t += TICK_MS;
        listBad(w, n++ % 2 === 1);
        pass(w);
    }
    assertStep(w, 'Clear');
    var lines = logLines(w, /last quest not finished|quest list not readable/);
    assert.ok(lines.length >= 1 && lines.length <= 11, 'log lines ' + lines.length);
});

t.test('read: a busy text and since survive one bad read', function () {
    var w = clearWorld();
    pass(w);
    var b = busy(w);
    var since = b.since;
    assert.ok(/last quest not finished/.test(b.text), b.text);
    w.t += TICK_MS;
    listBad(w, true);
    pass(w);
    assert.ok(/last quest not finished/.test(busy(w).text), busy(w).text);
    assert.strictEqual(busy(w).since, since);
    assert.ok(/last quest not finished/.test(statusLine(w)), statusLine(w));
    w.t += TICK_MS;
    listBad(w, false);
    pass(w);
    assert.strictEqual(busy(w).since, since);
    assertStep(w, 'Clear');
});

t.test('read: a bad read that stays bad takes the busy wait over, and a real wait restores it', function () {
    var w = clearWorld();
    pass(w);
    var since = busy(w).since;
    var noted = busy(w).noted;
    listBad(w, true);
    // Short of BUSY_LOG_MS the busy text stays.
    span(w, ld(w).BUSY_LOG_MS - TICK_MS);
    assert.ok(/last quest not finished/.test(busy(w).text), busy(w).text);
    span(w, TICK_MS * 2);
    assert.ok(/quest list not readable/.test(busy(w).text), busy(w).text);
    assert.strictEqual(busy(w).read, true);
    assert.strictEqual(busy(w).since, since);
    assert.ok(/quest list not readable/.test(statusLine(w)), statusLine(w));
    // A bad read that stays bad logs a line a minute under its own text.
    var from = logLines(w, /quest list not readable, waited/).length;
    span(w, 5 * MIN);
    var got = logLines(w, /quest list not readable, waited/).length - from;
    assert.ok(got >= 4 && got <= 5, 'read log lines ' + got);
    assert.ok(busy(w).noted > noted);
    listBad(w, false);
    pass(w);
    assert.ok(/last quest not finished/.test(busy(w).text), busy(w).text);
    assert.strictEqual(busy(w).read, false);
    assert.strictEqual(busy(w).since, since);
    assertStep(w, 'Clear');
});

t.test('read: a read that is bad from the start waits with no pause, its first line held back a minute', function () {
    var w = homeWorld({ mapOpen: true });
    onIsland(w, null, {});
    w.quests = null;
    series(w, 'Clear');
    pass(w);
    assert.ok(/quest list not readable/.test(busy(w).text), busy(w).text);
    assert.strictEqual(busy(w).read, true);
    assert.strictEqual(logLines(w, /quest list not readable, waited/).length, 0);
    span(w, MIN + TICK_MS);
    assert.ok(logLines(w, /quest list not readable, waited/).length >= 1);
    span(w, 30 * MIN);
    assertStep(w, 'Clear');
});

// ---- 3. Recall --------------------------------------------------------------

function recallWorld() {
    var w = homeWorld({ mapOpen: true });
    onIsland(w);
    series(w, 'Recall');
    return w;
}

t.test('Recall: a null list holds and nobody is left behind', function () {
    var w = recallWorld();
    var list = w.gi.mCurrentPlayerZone.GetSpecialists_vector;
    w.gi.mCurrentPlayerZone.GetSpecialists_vector = function () { return null; };
    span(w, 10 * MIN);
    assertStep(w, 'Recall');
    assert.strictEqual(w.zoneSends.length, 0);
    w.gi.mCurrentPlayerZone.GetSpecialists_vector = list;
    pass(w);
    assert.deepStrictEqual(sentTo(w), ['1.1', '1.2']);
});

t.test('Recall: the zone moved goes to JumpHome with nothing sent', function () {
    var w = recallWorld();
    w.gi.visitZone(HOME);
    pass(w);
    assertStep(w, 'JumpHome');
    assert.strictEqual(w.zoneSends.length, 0);
});

t.test('Recall: an undefined zone id holds, then the clean read sends both', function () {
    var w = recallWorld();
    var id = w.S.core.zone.id;
    w.S.core.zone.id = function () { return undefined; };
    try {
        span(w, 5 * MIN);
        assertStep(w, 'Recall');
        assert.ok(/zone id not readable/.test(busy(w).text), busy(w).text);
        assert.strictEqual(w.zoneSends.length, 0);
    } finally {
        w.S.core.zone.id = id;
    }
    pass(w);
    assert.deepStrictEqual(sentTo(w), ['1.1', '1.2']);
});

t.test('Recall: a general absent with no mark waits the grace, then counts as gone with no pause', function () {
    var w = recallWorld();
    var grace = ld(w).MISSING_GRACE_MS;
    w.lists[ZONE].splice(w.lists[ZONE].indexOf(w.g2), 1);
    span(w, grace - 2 * TICK_MS);
    assertStep(w, 'Recall');
    assert.ok(/1\.2 not listed/.test(busy(w).text), busy(w).text);
    span(w, 4 * TICK_MS);
    assertStep(w, 'JumpHome');
    assert.deepStrictEqual(sentTo(w), ['1.1']);
    assert.strictEqual(w.st.run().pause, null);
});

t.test('Recall: a general absent with a mark is gone at once', function () {
    var w = recallWorld();
    var r = w.st.run();
    r.marks['recall:1.2'] = { sentAt: w.t - 1000, seen: false, sentOnce: true };
    w.lists[ZONE].splice(w.lists[ZONE].indexOf(w.g2), 1);
    pass(w);
    assert.deepStrictEqual(sentTo(w), ['1.1']);
    w.t += TICK_MS;
    pass(w);
    assertStep(w, 'JumpHome');
    assert.ok(w.t - r.since < ld(w).MISSING_GRACE_MS);
});

// ---- 4. Jump ----------------------------------------------------------------

function jumpWorld(open) {
    var w = homeWorld({ mapOpen: open !== false });
    w.auto.visit = false;
    series(w, 'Jump');
    return w;
}

t.test('Jump: zone N not loaded, the second visit at JUMP_MS, the third JUMP_RETRY_MS after it', function () {
    var w = jumpWorld();
    var A = w.S.modules.adventures.away;
    tick(w);
    assert.strictEqual(w.visits.length, 1);
    assert.ok(/zone 7 not loaded/.test(busy(w).text), busy(w).text);
    w.t += A.JUMP_MS;
    tick(w);
    assert.strictEqual(w.visits.length, 1);
    w.t += 1;
    tick(w);
    assert.strictEqual(w.visits.length, 2);
    var second = w.t;
    w.t += A.JUMP_MS + 1;
    tick(w);
    assert.strictEqual(w.visits.length, 2, 'later visits stay far apart');
    w.t = second + A.JUMP_RETRY_MS;
    tick(w);
    assert.strictEqual(w.visits.length, 2);
    w.t += 1;
    tick(w);
    assert.strictEqual(w.visits.length, 3);
    assert.ok(A.JUMP_RETRY_MS > A.JUMP_MS);
    assertStep(w, 'Jump');
    assert.strictEqual(w.st.run().pause, null);
});

t.test('Jump: a zone that never loads keeps waiting an hour with no JumpFailed', function () {
    var w = jumpWorld();
    span(w, 60 * MIN);
    assertStep(w, 'Jump');
    assert.ok(w.visits.length >= 2 && w.visits.length <= 14, 'visits ' + w.visits.length);
});

t.test('Jump: an adventure gone from the own list pauses only after the grace', function () {
    var w = jumpWorld(false);
    var grace = ld(w).MISSING_GRACE_MS;
    w.adventures = [];
    span(w, grace - 2 * TICK_MS);
    assertStep(w, 'Jump');
    span(w, 4 * TICK_MS);
    assertPaused(w, w.S.RunPause.JumpFailed, /adventure no longer open/);
});

t.test('Jump: an own list that cannot be read never pauses', function () {
    var w = jumpWorld(false);
    w.adventures = null;
    span(w, 20 * MIN);
    assertStep(w, 'Jump');
});

t.test('Jump: an adventure that is listed never pauses, however long the zone takes', function () {
    var w = jumpWorld();
    span(w, 20 * MIN);
    assertStep(w, 'Jump');
    assert.strictEqual(w.st.run().pause, null);
});

// ---- 5. Clear ----------------------------------------------------------------

function quietWorld(quests) {
    var w = homeWorld({ mapOpen: true });
    onIsland(w, null, {});
    if (quests !== undefined) w.quests = quests;
    series(w, 'Clear');
    return w;
}

t.test('Clear: the Witch Tower shape, no battle and the quest open, pauses ClearTimeout after 5 quiet min', function () {
    var w = quietWorld();
    var A = w.S.modules.adventures.away;
    assert.strictEqual(A.CLEAR_MAX_MS, 5 * MIN);
    span(w, 2 * MIN);
    assertStep(w, 'Clear');
    assert.ok(/last quest not finished, 1 of 5 min quiet/.test(busy(w).text), busy(w).text);
    span(w, 2 * MIN + 40000);
    assertStep(w, 'Clear');
    assert.ok(/4 of 5 min quiet/.test(statusLine(w)), statusLine(w));
    span(w, 40000);
    assertPaused(w, w.S.RunPause.ClearTimeout, /last quest not finished after 5 min/);
});

t.test('Clear: a running battle does not count, and the quiet time after it does', function () {
    var w = quietWorld();
    w.g1.state.task = { type: w.code.attack };
    span(w, 30 * MIN);
    assertStep(w, 'Clear');
    assert.ok(/0 of 5 min quiet/.test(statusLine(w)), statusLine(w));
    w.g1.state.task = null;
    span(w, 4 * MIN);
    assertStep(w, 'Clear');
    span(w, 2 * MIN);
    assertPaused(w, w.S.RunPause.ClearTimeout);
});

t.test('Clear: moving generals count as quiet', function () {
    var w = quietWorld();
    w.g1.state.task = { type: w.code.move };
    span(w, 5 * MIN + TICK_MS * 2);
    assertPaused(w, w.S.RunPause.ClearTimeout);
});

t.test('Clear: time while another zone was viewed is not counted', function () {
    var w = quietWorld();
    span(w, 2 * MIN + 30000);
    // Passes stop while the user views another zone.
    w.t += 20 * MIN;
    pass(w);
    assertStep(w, 'Clear');
    assert.ok(/2 of 5 min quiet/.test(busy(w).text), busy(w).text);
    span(w, 2 * MIN);
    assertStep(w, 'Clear');
    span(w, 2 * MIN);
    assertPaused(w, w.S.RunPause.ClearTimeout);
});

[
    { name: 'an empty list', quests: [] },
    { name: 'a list of other quests', quests: [{ key: 'q1', name: 'Side', finished: false, last: false }] }
].forEach(function (c) {
    t.test('Clear: a list without the last quest ends NotObserved after 5 quiet min: ' + c.name, function () {
        var w = quietWorld(c.quests);
        span(w, 2 * MIN);
        assertStep(w, 'Clear');
        assert.ok(/last quest not listed, 1 of 5 min quiet/.test(busy(w).text), busy(w).text);
        span(w, 3 * MIN + TICK_MS * 2);
        assertPaused(w, w.S.RunPause.NotObserved, /last quest not listed/);
    });
});

t.test('Clear: a quest finished with a general busy waits with no limit', function () {
    var w = quietWorld();
    w.quests[0].finished = true;
    w.g1.state.task = { type: w.code.attack };
    span(w, 30 * MIN);
    assertStep(w, 'Clear');
    assert.ok(/Anna \(1\.1\) busy/.test(busy(w).text), busy(w).text);
    w.g1.state.task = null;
    span(w, TICK_MS * 2);
    assertStep(w, 'LastQuest');
});

// ---- 6. PackStar --------------------------------------------------------------

// A carrier (1.5) on its grid and two generals at the star, with one landing
// field for the two of them.
function packWorld(fields) {
    var w = homeWorld({ mapOpen: true });
    w.g1 = gen('1.1', 'Anna', 0, { maxUnits: 4 });
    w.g2 = gen('1.2', 'Bert', 0, { maxUnits: 2 });
    w.c = gen('1.5', 'Cara', 30, { carrier: true, maxUnits: 10 });
    w.fighters = [w.g1, w.g2];
    w.lists[HOME].length = 0;
    onIsland(w, [w.g1, w.g2, w.c], { Rifle: 16 });
    w.quests = [{ key: 'q9', name: 'Final', finished: true, last: true }];
    w.landing(fields);
    var keys = { '1.1': true, '1.2': true, '1.5': true };
    var r = w.st.newRun({
        id: 42, templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights', zoneId: ZONE,
        paths: [WAVE], loadoutPath: LOADOUT, loadoutKeys: keys, waveIndex: 0, speedBuff: '',
        step: w.S.RunStep.PackStar
    });
    w.st.begin({
        templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights', count: 1, ended: false,
        requested: w.t, finished: 0, closedAt: null
    }, r);
    return w;
}

t.test('PackStar: too few fields, the placed holders raise and the rest waits, then NotPlaceable at PLACE_QUIET_MS', function () {
    var w = packWorld([500]);
    var quiet = w.S.modules.adventures.away.PLACE_QUIET_MS;
    span(w, MIN);
    assert.strictEqual(w.orders.filter(function (o) { return o.code === w.code.move; }).length, 1, 'one holder placed');
    assert.strictEqual(w.raises.length, 2, 'the carrier and the placed holder raise');
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
    assert.ok(/has no placeable grid, \d of 5 min quiet/.test(busy(w).text), busy(w) && busy(w).text);
    assert.ok(/has no placeable grid/.test(statusLine(w)), statusLine(w));
    span(w, quiet - 2 * MIN);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running, 'still waiting short of the limit');
    span(w, 3 * MIN);
    assertPaused(w, w.S.RunPause.NotPlaceable, /has no placeable grid \(\d+ tried\)/);
    assert.strictEqual(w.raises.length, 2, 'the holder with no field was never raised');
});

t.test('PackStar: a running battle does not count against the field wait', function () {
    var w = packWorld([500]);
    var l = ld(w);
    var anyAttacking = l.anyAttacking;
    l.anyAttacking = function () { return true; };
    try {
        span(w, 30 * MIN);
        assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
        assert.ok(/0 of 5 min quiet/.test(busy(w).text), busy(w).text);
    } finally {
        l.anyAttacking = anyAttacking;
    }
    span(w, 6 * MIN);
    assertPaused(w, w.S.RunPause.NotPlaceable);
});

t.test('PackStar: no false rounds pause while the holder waits for a field', function () {
    var w = packWorld([500]);
    span(w, 4 * MIN);
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Running, r.pause && r.pause.message);
    assert.strictEqual(r.rounds, 0);
    // A field opens up: the holder is placed and raised.
    w.landing([500, 501]);
    span(w, MIN);
    assert.strictEqual(w.raises.length >= 3, true, 'raises ' + w.raises.length);
});
