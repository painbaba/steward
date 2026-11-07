'use strict';

var t = require('../runner');
var harness = require('../harness');
var A = require('../stubs/army');
var AC = require('../stubs/actions');
var specStubs = require('../stubs/specialists');

var assert = t.assert;

// An enemy camp the attack precheck and path check can read.
function camp(grid) {
    return {
        getPlayerID:        function () { return -1; },
        GetStreetGridEntry: function () { return grid + 1000; }
    };
}

// Booted harness with action wiring. o.generals, o.buildings (grid -> building),
// o.home (default true), o.onSendToZone().
function setup(o) {
    o = o || {};
    var H = harness.boot();
    A.install(H, { fighters: o.generals || [] });
    var sent = AC.wire(H);
    var buildings = o.buildings || {};
    H.host.game.gi.mCurrentPlayerZone.GetBuildingFromGridPosition = function (grid) {
        return buildings[grid] || null;
    };
    H.host.game.gi.isOnHomzone = function () { return o.home !== false; };
    H.host.game.gi.mCurrentViewedZoneID = 1;
    var zoneCalls = [];
    sent.registerDef('com.bluebyte.tso.service::ServiceManager', {
        getInstance: function () {
            return {
                specialist: {
                    sendToZone: function (spec, zoneId) {
                        zoneCalls.push({ spec: spec, zoneId: zoneId });
                        if (o.onSendToZone) o.onSendToZone();
                    }
                }
            };
        }
    });
    var S = H.Steward;
    return { H: H, S: S, orders: S.core.specialists.orders, sent: sent, zoneCalls: zoneCalls, buildings: buildings };
}

function run(s, def, onStep) {
    var result = null;
    assert.strictEqual(s.S.core.actions.attempt(def, function (r) { result = r; }), true);
    AC.drive(s.H, { onStep: onStep });
    return result;
}

function breakList(s) {
    s.H.host.game.gi.mCurrentPlayerZone.GetSpecialists_vector = function () { throw new Error('list'); };
}

function hideGeneral(s) {
    s.H.host.game.gi.mCurrentPlayerZone.GetSpecialists_vector = function () { return []; };
}

// ---- readers ----------------------------------------------------------------

t.test('orders: GeneralTask is filled and every kind has a raw code', function () {
    var s = setup();
    var kinds = ['Move', 'Attack', 'TravelToZone', 'ToStar', 'Recovering'];
    for (var i = 0; i < kinds.length; i++) {
        var v = s.S.GeneralTask[kinds[i]];
        assert.strictEqual(typeof v, 'string');
        assert.strictEqual(typeof s.orders.RAW_CODES[v], 'number');
    }
    assert.strictEqual(s.orders.RAW_CODES[s.S.GeneralTask.Move], 4);
    assert.strictEqual(s.orders.RAW_CODES[s.S.GeneralTask.ToStar], 12);
    assert.strictEqual(s.orders.RAW_CODES[s.S.GeneralTask.Recovering], 6);
});

t.test('orders: task type 6 reads as Recovering and sendTask refuses it', function () {
    var g = AC.general({ uid: 'g1', task: { type: 6, newGrid: 0 } });
    var s = setup({ generals: [g] });
    assert.strictEqual(s.orders.taskKind(g), s.S.GeneralTask.Recovering);
    assert.strictEqual(s.orders.sendTask(g, s.S.GeneralTask.Recovering, 42), false);
    assert.strictEqual(s.sent.actions.length, 0);
});

t.test('orders: taskKind, rawTaskType and newGrid read the task and answer null otherwise', function () {
    var s = setup();
    var g = AC.general({ uid: 'g1', task: { type: 4, newGrid: 77 } });
    assert.strictEqual(s.orders.rawTaskType(g), 4);
    assert.strictEqual(s.orders.taskKind(g), s.S.GeneralTask.Move);
    assert.strictEqual(s.orders.newGrid(g), 77);
    g.state.task = { type: 99, newGrid: 'x' };
    assert.strictEqual(s.orders.taskKind(g), null);
    assert.strictEqual(s.orders.newGrid(g), null);
    g.state.task = null;
    assert.strictEqual(s.orders.rawTaskType(g), null);
    assert.strictEqual(s.orders.taskKind(g), null);
    g.state.task = { type: 5, newGrid: 1 };
    g.state.throwOn = 'GetTask';
    assert.strictEqual(s.orders.rawTaskType(g), null);
    assert.strictEqual(s.orders.taskKind(g), null);
    assert.strictEqual(s.orders.newGrid(g), null);
    assert.strictEqual(s.orders.taskKind(null), null);
});

t.test('isPlaceable uses edit mode 86 and restores the cursor mode', function () {
    var g = AC.general({ uid: 'g1' });
    var s = setup({ generals: [g] });
    assert.strictEqual(s.orders.isPlaceable(g, 42), true);
    s.sent.placeable = 3;
    assert.strictEqual(s.orders.isPlaceable(g, 42), false);
    var modes = s.sent.calls.filter(function (c) { return c.target === 'mMouseCursor'; });
    assert.deepStrictEqual(modes.map(function (c) { return c.method; }),
        ['SetCursorEditMode', 'SetToLastEditMode', 'SetCursorEditMode', 'SetToLastEditMode']);
    assert.strictEqual(modes[0].args[0], 86);
    assert.strictEqual(s.H.host.game.gi.mCurrentCursor.mCurrentSpecialist, g);
});

t.test('isPlaceable restores the cursor mode when the host throws', function () {
    var g = AC.general({ uid: 'g1' });
    var s = setup({ generals: [g] });
    s.H.host.game.gi.mMouseCursor.CheckIfGarrisonIsPlacableInGame = function () { throw new Error('host'); };
    assert.strictEqual(s.orders.isPlaceable(g, 42), false);
    var last = s.sent.calls.filter(function (c) { return c.method === 'SetToLastEditMode'; });
    assert.strictEqual(last.length, 1);
});

t.test('placeCode returns the host code, restores the cursor mode, null when the host throws', function () {
    var g = AC.general({ uid: 'g1' });
    var s = setup({ generals: [g] });
    assert.strictEqual(s.orders.placeCode(g, 42), 0);
    s.sent.placeable = 7;
    assert.strictEqual(s.orders.placeCode(g, 42), 7);
    var modes = s.sent.calls.filter(function (c) { return c.target === 'mMouseCursor'; });
    assert.deepStrictEqual(modes.map(function (c) { return c.method; }),
        ['SetCursorEditMode', 'SetToLastEditMode', 'SetCursorEditMode', 'SetToLastEditMode']);
    assert.strictEqual(s.orders.placeCode(null, 42), null);
    s.H.host.game.gi.mMouseCursor.CheckIfGarrisonIsPlacableInGame = function () { throw new Error('host'); };
    assert.strictEqual(s.orders.placeCode(g, 42), null);
    var last = s.sent.calls.filter(function (c) { return c.method === 'SetToLastEditMode'; });
    assert.strictEqual(last.length, 3);
});

t.test('hasPath needs a building at the target and a path above zero', function () {
    var g = AC.general({ uid: 'g1', grid: 5 });
    var s = setup({ generals: [g], buildings: { 300: camp(300) } });
    var seen = null;
    s.H.host.game.gi.mPathFinder.CalculatePath = function (from, to) {
        seen = [from, to];
        return { pathLenX10000: s.sent.pathLen };
    };
    assert.strictEqual(s.orders.hasPath(g, 300), true);
    assert.deepStrictEqual(seen, [1300, 5]);
    assert.strictEqual(s.orders.hasPath(g, 301), false);
    s.sent.pathLen = 0;
    assert.strictEqual(s.orders.hasPath(g, 300), false);
});

// ---- move -------------------------------------------------------------------

t.test('move sends 95 with code 4 and the grid, and verifies on the move task', function () {
    var g = AC.general({ uid: 'g1', grid: 5 });
    var s = setup({ generals: [g] });
    var r = run(s, s.orders.move('g1', 42), function (n) {
        if (n === 1) g.state.task = { type: 4, newGrid: 42 };
    });
    assert.strictEqual(r.status, s.S.ActionResult.Verified);
    assert.strictEqual(r.sends, 1);
    assert.strictEqual(s.sent.actions.length, 1);
    var a = s.sent.actions[0];
    assert.strictEqual(a.id, 95);
    assert.strictEqual(a.p1, 4);
    assert.strictEqual(a.p2, 42);
    assert.strictEqual(a.data.voName, 'dStartSpecialistTaskVO');
    assert.strictEqual(a.data.subTaskID, 0);
    assert.strictEqual(a.data.uniqueID.toKeyString(), 'g1');
    assert.strictEqual(s.H.host.game.gi.mCurrentCursor.mCurrentSpecialist, g);
});

t.test('move is satisfied when the general already stands on the grid', function () {
    var g = AC.general({ uid: 'g1', grid: 42 });
    var s = setup({ generals: [g] });
    var r = run(s, s.orders.move('g1', 42));
    assert.strictEqual(r.status, s.S.ActionResult.Verified);
    assert.strictEqual(r.sends, 0);
    assert.strictEqual(s.sent.actions.length, 0);
});

t.test('move verifies when the general arrives on the grid', function () {
    var g = AC.general({ uid: 'g1', grid: 5 });
    var s = setup({ generals: [g] });
    var r = run(s, s.orders.move('g1', 42), function (n) { if (n === 3) g.state.grid = 42; });
    assert.strictEqual(r.status, s.S.ActionResult.Verified);
    assert.strictEqual(r.sends, 1);
});

t.test('move refuses busy, not placeable, a bad grid, not own, a missing or unreadable general', function () {
    var busy = AC.general({ uid: 'busy', inUse: true });
    var idle = AC.general({ uid: 'idle' });
    var theirs = AC.general({ uid: 'theirs', playerId: 2 });
    var s = setup({ generals: [busy, idle, theirs] });
    var reasons = [
        run(s, s.orders.move('busy', 42)).reason,
        run(s, s.orders.move('idle', 0)).reason,
        run(s, s.orders.move('theirs', 42)).reason,
        run(s, s.orders.move('nope', 42)).reason
    ];
    s.sent.placeable = 1;
    reasons.push(run(s, s.orders.move('idle', 42)).reason);
    breakList(s);
    var unreadable = run(s, s.orders.move('idle', 42));
    reasons.push(unreadable.reason);
    assert.deepStrictEqual(reasons, ['not idle', 'bad grid 0', 'not own', 'specialist not found',
        'not placeable at 42', 'specialist unreadable']);
    assert.strictEqual(unreadable.status, s.S.ActionResult.Refused);
    assert.strictEqual(s.sent.actions.length, 0);
});

t.test('move fails after exactly two sends when nothing changes', function () {
    var g = AC.general({ uid: 'g1', grid: 5 });
    var s = setup({ generals: [g] });
    var r = run(s, s.orders.move('g1', 42));
    assert.strictEqual(r.status, s.S.ActionResult.Failed);
    assert.strictEqual(r.sends, 2);
    assert.strictEqual(s.sent.actions.length, 2);
});

t.test('move does not verify while the specialist list cannot be read', function () {
    var g = AC.general({ uid: 'g1', grid: 5 });
    var s = setup({ generals: [g] });
    var r = run(s, s.orders.move('g1', 42), function (n) {
        if (n === 1) { g.state.grid = 42; breakList(s); }
    });
    assert.strictEqual(r.status, s.S.ActionResult.Failed);
    assert.strictEqual(r.sends, 1);
    assert.ok(/retry refused: specialist unreadable/.test(r.reason));
});

// ---- attack -----------------------------------------------------------------

t.test('attack sends 95 with code 5 and the target, and verifies on the attack task', function () {
    var g = AC.general({ uid: 'g1', grid: 5, army: { Rifle: 10 } });
    var s = setup({ generals: [g], buildings: { 300: camp(300) } });
    var r = run(s, s.orders.attack('g1', 300, 5), function (n) {
        if (n === 1) g.state.task = { type: 5, newGrid: 0 };
    });
    assert.strictEqual(r.status, s.S.ActionResult.Verified);
    assert.strictEqual(r.sends, 1);
    var a = s.sent.actions[0];
    assert.deepStrictEqual([a.id, a.p1, a.p2], [95, 5, 300]);
    assert.strictEqual(a.data.uniqueID.toKeyString(), 'g1');
    assert.strictEqual(s.H.host.game.gi.mCurrentCursor.mCurrentSpecialist, g);
});

t.test('attack refuses no units, a fromGrid mismatch, a missing or friendly target, no path, a missing general', function () {
    var bare = AC.general({ uid: 'bare', grid: 5, army: {} });
    var g = AC.general({ uid: 'g1', grid: 5, army: { Rifle: 10 } });
    var friendly = { getPlayerID: function () { return 1; }, GetStreetGridEntry: function () { return 1; } };
    var s = setup({ generals: [bare, g], buildings: { 300: camp(300), 400: friendly } });
    var reasons = [
        run(s, s.orders.attack('bare', 300)).reason,
        run(s, s.orders.attack('g1', 300, 6)).reason,
        run(s, s.orders.attack('g1', 301)).reason,
        run(s, s.orders.attack('g1', 400)).reason,
        run(s, s.orders.attack('nope', 300)).reason
    ];
    s.sent.pathLen = 0;
    reasons.push(run(s, s.orders.attack('g1', 300, 5)).reason);
    breakList(s);
    reasons.push(run(s, s.orders.attack('g1', 300)).reason);
    assert.deepStrictEqual(reasons, ['no units', 'not on line grid 6', 'no building at 301',
        'target 400 not enemy', 'specialist not found', 'no path to 300', 'specialist unreadable']);
    assert.strictEqual(s.sent.actions.length, 0);
});

t.test('attack does not verify when the target building disappears without an attack task', function () {
    var g = AC.general({ uid: 'g1', grid: 5, army: { Rifle: 10 } });
    var s = setup({ generals: [g], buildings: { 300: camp(300) } });
    var r = run(s, s.orders.attack('g1', 300), function (n) {
        if (n === 1) delete s.buildings[300];
    });
    assert.strictEqual(r.status, s.S.ActionResult.Failed);
    assert.strictEqual(r.sends, 1);
    assert.ok(/retry refused: no building at 300/.test(r.reason));
});

t.test('attack fails after exactly two sends when the task never appears', function () {
    var g = AC.general({ uid: 'g1', grid: 5, army: { Rifle: 10 } });
    var s = setup({ generals: [g], buildings: { 300: camp(300) } });
    var r = run(s, s.orders.attack('g1', 300));
    assert.strictEqual(r.status, s.S.ActionResult.Failed);
    assert.strictEqual(r.sends, 2);
    assert.strictEqual(s.sent.actions.length, 2);
});

t.test('attack does not verify on a read failure during check', function () {
    var g = AC.general({ uid: 'g1', grid: 5, army: { Rifle: 10 } });
    var s = setup({ generals: [g], buildings: { 300: camp(300) } });
    var r = run(s, s.orders.attack('g1', 300), function (n) {
        if (n === 1) { g.state.task = { type: 5, newGrid: 0 }; g.state.throwOn = 'GetTask'; }
    });
    assert.notStrictEqual(r.status, s.S.ActionResult.Verified);
});

// ---- star -------------------------------------------------------------------

t.test('star sends code 12 with the cursor grid and verifies off the map with an empty army', function () {
    var g = AC.general({ uid: 'g1', grid: 5, army: { Rifle: 3 } });
    var s = setup({ generals: [g] });
    s.sent.cursorGrid = 777;
    var r = run(s, s.orders.star('g1'), function (n) {
        if (n === 2) { g.state.grid = 0; g.state.army = {}; }
    });
    assert.strictEqual(r.status, s.S.ActionResult.Verified);
    assert.strictEqual(r.sends, 1);
    var a = s.sent.actions[0];
    assert.deepStrictEqual([a.id, a.p1, a.p2], [95, 12, 777]);
    assert.strictEqual(a.data.uniqueID.toKeyString(), 'g1');
});

t.test('star is satisfied off the map with an empty army', function () {
    var g = AC.general({ uid: 'g1', grid: 0, army: {} });
    var s = setup({ generals: [g] });
    var r = run(s, s.orders.star('g1'));
    assert.strictEqual(r.status, s.S.ActionResult.Verified);
    assert.strictEqual(r.sends, 0);
});

t.test('star is not satisfied when the army read throws', function () {
    var g = AC.general({ uid: 'g1', grid: 0, army: {}, throwOn: 'GetArmy' });
    var s = setup({ generals: [g] });
    var r = run(s, s.orders.star('g1'));
    assert.strictEqual(r.status, s.S.ActionResult.Refused);
    assert.strictEqual(r.reason, 'not on the map');
    assert.strictEqual(r.sends, 0);
});

t.test('star refuses a busy, missing or unreadable general', function () {
    var busy = AC.general({ uid: 'busy', inUse: true });
    var s = setup({ generals: [busy] });
    assert.strictEqual(run(s, s.orders.star('busy')).reason, 'not idle');
    assert.strictEqual(run(s, s.orders.star('nope')).reason, 'specialist not found');
    breakList(s);
    var r = run(s, s.orders.star('busy'));
    assert.strictEqual(r.status, s.S.ActionResult.Refused);
    assert.strictEqual(r.reason, 'specialist unreadable');
    assert.strictEqual(s.sent.actions.length, 0);
});

t.test('star verifies when the general leaves the list after being found', function () {
    var g = AC.general({ uid: 'g1', grid: 5, army: { Rifle: 3 } });
    var s = setup({ generals: [g] });
    var r = run(s, s.orders.star('g1'), function (n) { if (n === 1) hideGeneral(s); });
    assert.strictEqual(r.status, s.S.ActionResult.Verified);
    assert.strictEqual(r.sends, 1);
});

t.test('star does not verify a missing general after the viewed zone changed', function () {
    var g = AC.general({ uid: 'g1', grid: 5, army: { Rifle: 3 } });
    var s = setup({ generals: [g] });
    var r = run(s, s.orders.star('g1'), function (n) {
        if (n === 1) { hideGeneral(s); s.H.host.game.gi.mCurrentViewedZoneID = 2; }
    });
    assert.notStrictEqual(r.status, s.S.ActionResult.Verified);
});

t.test('star does not verify a missing general when the zone id is unreadable', function () {
    var g = AC.general({ uid: 'g1', grid: 5, army: { Rifle: 3 } });
    var s = setup({ generals: [g] });
    var r = run(s, s.orders.star('g1'), function (n) {
        if (n === 1) { hideGeneral(s); s.H.host.game.gi.mCurrentViewedZoneID = null; }
    });
    assert.notStrictEqual(r.status, s.S.ActionResult.Verified);
});

t.test('star does not verify when the specialist list cannot be read', function () {
    var g = AC.general({ uid: 'g1', grid: 5, army: { Rifle: 3 } });
    var s = setup({ generals: [g] });
    var r = run(s, s.orders.star('g1'), function (n) { if (n === 1) breakList(s); });
    assert.strictEqual(r.status, s.S.ActionResult.Failed);
    assert.strictEqual(r.sends, 1);
    assert.ok(/retry refused: specialist unreadable/.test(r.reason));
});

t.test('star does not verify off the map while the army cannot be read', function () {
    var g = AC.general({ uid: 'g1', grid: 5, army: { Rifle: 3 } });
    var s = setup({ generals: [g] });
    var r = run(s, s.orders.star('g1'), function (n) {
        if (n === 1) { g.state.grid = 0; g.state.army = {}; g.state.throwOn = 'GetArmy'; }
    });
    assert.strictEqual(r.status, s.S.ActionResult.Failed);
    assert.strictEqual(r.reason, 'retry refused: not on the map');
});

t.test('star fails after exactly two sends when the general stays on the map', function () {
    var g = AC.general({ uid: 'g1', grid: 5, army: { Rifle: 3 } });
    var s = setup({ generals: [g] });
    var r = run(s, s.orders.star('g1'));
    assert.strictEqual(r.status, s.S.ActionResult.Failed);
    assert.strictEqual(r.sends, 2);
    assert.strictEqual(s.sent.actions.length, 2);
});

// ---- sendToZone -------------------------------------------------------------

t.test('sendToZone calls ServiceManager.specialist.sendToZone and verifies on travelling', function () {
    var g = AC.general({ uid: 'g1' });
    var s = setup({ generals: [g], onSendToZone: function () { g.state.travelling = true; } });
    var r = run(s, s.orders.sendToZone('g1', 4711));
    assert.strictEqual(r.status, s.S.ActionResult.Verified);
    assert.strictEqual(r.sends, 1);
    assert.strictEqual(s.zoneCalls.length, 1);
    assert.strictEqual(s.zoneCalls[0].spec, g);
    assert.strictEqual(s.zoneCalls[0].zoneId, 4711);
    assert.strictEqual(s.sent.actions.length, 0);
});

t.test('sendToZone verifies on the travel task or when the general left the list', function () {
    var g = AC.general({ uid: 'g1' });
    var s = setup({ generals: [g], onSendToZone: function () { g.state.task = { type: 7, newGrid: 0 }; } });
    assert.strictEqual(run(s, s.orders.sendToZone('g1', 5)).status, s.S.ActionResult.Verified);

    var g2 = AC.general({ uid: 'g2' });
    var s2 = setup({ generals: [g2] });
    var r = run(s2, s2.orders.sendToZone('g2', 5), function (n) { if (n === 1) hideGeneral(s2); });
    assert.strictEqual(r.status, s2.S.ActionResult.Verified);
    assert.strictEqual(r.sends, 1);
});

t.test('sendToZone does not verify a missing general after the viewed zone changed', function () {
    var g = AC.general({ uid: 'g1' });
    var s = setup({ generals: [g] });
    var r = run(s, s.orders.sendToZone('g1', 5), function (n) {
        if (n === 1) { hideGeneral(s); s.H.host.game.gi.mCurrentViewedZoneID = 2; }
    });
    assert.notStrictEqual(r.status, s.S.ActionResult.Verified);
});

t.test('sendToZone is allowed from an adventure back to the home id', function () {
    var g = AC.general({ uid: 'g1' });
    var s = setup({ generals: [g], home: false, onSendToZone: function () { g.state.travelling = true; } });
    s.H.host.game.gi.mCurrentViewedZoneID = 9001;
    var r = run(s, s.orders.sendToZone('g1', 5));
    assert.strictEqual(r.status, s.S.ActionResult.Verified);
    assert.strictEqual(s.zoneCalls.length, 1);
    assert.strictEqual(s.zoneCalls[0].zoneId, 5);
});

t.test('sendToZone refuses the zone already viewed and an unreadable viewed zone', function () {
    var s = setup({ generals: [AC.general({ uid: 'g1' })] });
    s.H.host.game.gi.mCurrentViewedZoneID = 4711;
    assert.strictEqual(run(s, s.orders.sendToZone('g1', 4711)).reason, 'already on zone 4711');
    s.H.host.game.gi.mCurrentViewedZoneID = undefined;
    assert.strictEqual(run(s, s.orders.sendToZone('g1', 4711)).reason, 'viewed zone unreadable');
    assert.strictEqual(s.zoneCalls.length, 0);
});

t.test('remaining returns the task time as a number, else null', function () {
    var s = setup();
    function withTask(rem) {
        return { GetTask: function () { return { GetRemainingTime: function () { return rem; } }; } };
    }
    assert.strictEqual(s.orders.remaining(withTask(5000)), 5000);
    assert.strictEqual(s.orders.remaining(withTask(0)), 0);
    assert.strictEqual(s.orders.remaining(withTask(-1)), null);
    assert.strictEqual(s.orders.remaining(withTask(NaN)), null);
    assert.strictEqual(s.orders.remaining(withTask('x')), null);
    assert.strictEqual(s.orders.remaining({ GetTask: function () { return null; } }), null);
    assert.strictEqual(s.orders.remaining({ GetTask: function () { throw new Error('x'); } }), null);
    assert.strictEqual(s.orders.remaining(null), null);
});

t.test('sendToZone refuses a bad zone id, a missing or unreadable general', function () {
    var g = AC.general({ uid: 'g1' });
    var away = setup({ generals: [g] });
    var s = setup({ generals: [AC.general({ uid: 'g1' })] });
    assert.strictEqual(run(s, s.orders.sendToZone('g1', null)).reason, 'bad zone id null');
    assert.strictEqual(run(s, s.orders.sendToZone('nope', 5)).reason, 'specialist not found');
    breakList(s);
    var r = run(s, s.orders.sendToZone('g1', 5));
    assert.strictEqual(r.status, s.S.ActionResult.Refused);
    assert.strictEqual(r.reason, 'specialist unreadable');
    assert.strictEqual(away.zoneCalls.length + s.zoneCalls.length, 0);
});

t.test('sendToZone does not verify on a failed list read', function () {
    var g = AC.general({ uid: 'g1' });
    var s = setup({ generals: [g] });
    var r = run(s, s.orders.sendToZone('g1', 5), function (n) { if (n === 1) breakList(s); });
    assert.strictEqual(r.status, s.S.ActionResult.Failed);
    assert.strictEqual(r.sends, 1);
    assert.ok(/retry refused: specialist unreadable/.test(r.reason));
});

t.test('sendToZone fails after exactly two sends when nothing changes', function () {
    var g = AC.general({ uid: 'g1' });
    var s = setup({ generals: [g] });
    var r = run(s, s.orders.sendToZone('g1', 5));
    assert.strictEqual(r.status, s.S.ActionResult.Failed);
    assert.strictEqual(r.sends, 2);
    assert.strictEqual(s.zoneCalls.length, 2);
});

// ---- describe ---------------------------------------------------------------

t.test('a verified order logs the observed raw task type', function () {
    var g = AC.general({ uid: 'g1', grid: 5 });
    var s = setup({ generals: [g] });
    run(s, s.orders.move('g1', 42), function (n) {
        if (n === 1) g.state.task = { type: 4, newGrid: 42 };
    });
    var hit = s.H.logs().filter(function (l) { return /observed task type 4/.test(JSON.stringify(l)); });
    assert.strictEqual(hit.length, 1);
});

// ---- packet path ------------------------------------------------------------

t.test('dispatch.sendTask puts the grid in p2 and send still passes 0', function () {
    var g = AC.general({ uid: 'g1' });
    var s = setup({ generals: [g] });
    var d = s.S.core.specialists.dispatch;
    assert.strictEqual(d.sendTask(g, 4, 42), true);
    assert.strictEqual(d.send(g, 3, 1), true);
    assert.strictEqual(s.sent.actions.length, 2);
    assert.strictEqual(s.sent.actions[0].p1, 4);
    assert.strictEqual(s.sent.actions[0].p2, 42);
    assert.strictEqual(s.sent.actions[0].data.uniqueID.toKeyString(), 'g1');
    assert.strictEqual(s.sent.actions[1].p1, 3);
    assert.strictEqual(s.sent.actions[1].p2, 0);
    assert.strictEqual(s.sent.actions[1].data.subTaskID, 1);
    assert.strictEqual(d.sendTask(g, 'x', 42), false);
    assert.strictEqual(d.sendTask(g, 4, undefined), false);
    assert.strictEqual(s.sent.actions.length, 2);
});

t.test('orders send fails without a packet when the uid cannot be read', function () {
    var g = AC.general({ uid: 'g1' });
    var s = setup({ generals: [g] });
    g.GetUniqueID = function () { throw new Error('uid'); };
    assert.strictEqual(s.orders.sendTask(g, s.S.GeneralTask.Move, 42), false);
    assert.strictEqual(s.sent.actions.length, 0);
});

// ---- ghosts: a dropped read is never absence or success ---------------------------

t.test('orders report unreadable for an owner that reads undefined, and send nothing', function () {
    var g = AC.general({ uid: 'g1', grid: 5, army: { Rifle: 3 } });
    var s = setup({ generals: [g] });
    g.getPlayerID = function () { return undefined; };
    var unreadable = s.S.core.specialists.UNREADABLE;
    var rs = [
        run(s, s.orders.star('g1')),
        run(s, s.orders.sendToZone('g1', 5)),
        run(s, s.orders.move('g1', 7))
    ];
    for (var i = 0; i < rs.length; i++) {
        assert.strictEqual(rs[i].status, s.S.ActionResult.Refused, 'order ' + i);
        assert.strictEqual(rs[i].reason, unreadable, 'order ' + i);
    }
    assert.strictEqual(s.sent.actions.length, 0);
    assert.strictEqual(s.zoneCalls.length, 0);
});

t.test('orders keep the not own reason for a real foreign general', function () {
    var g = AC.general({ uid: 'g1', grid: 5, army: { Rifle: 3 }, playerId: 2 });
    var s = setup({ generals: [g] });
    assert.strictEqual(run(s, s.orders.star('g1')).reason, 'not own');
});

t.test('star does not verify when the general turns into a ghost after the send', function () {
    var g = AC.general({ uid: 'g1', grid: 5, army: { Rifle: 3 } });
    var s = setup({ generals: [g] });
    var r = run(s, s.orders.star('g1'), function (n) { if (n === 1) specStubs.ghost(g); });
    assert.notStrictEqual(r.status, s.S.ActionResult.Verified);
    assert.strictEqual(r.status, s.S.ActionResult.Failed);
    assert.strictEqual(r.sends, 1);
    assert.ok(/retry refused: specialist unreadable/.test(r.reason), r.reason);
});

t.test('sendToZone does not verify when the general turns into a ghost after the send', function () {
    var g = AC.general({ uid: 'g1' });
    var s = setup({ generals: [g] });
    var r = run(s, s.orders.sendToZone('g1', 5), function (n) { if (n === 1) specStubs.ghost(g); });
    assert.notStrictEqual(r.status, s.S.ActionResult.Verified);
    assert.strictEqual(r.status, s.S.ActionResult.Failed);
    assert.strictEqual(r.sends, 1);
    assert.ok(/retry refused: specialist unreadable/.test(r.reason), r.reason);
});

t.test('star still verifies when the general really left a clean list', function () {
    var g = AC.general({ uid: 'g1', grid: 5, army: { Rifle: 3 } });
    var s = setup({ generals: [g] });
    var r = run(s, s.orders.star('g1'), function (n) { if (n === 1) hideGeneral(s); });
    assert.strictEqual(r.status, s.S.ActionResult.Verified);
});

// ---- send uses what precheck found ------------------------------------------

// Counts the reads of the specialist vector from now on.
function countReads(s) {
    var z = s.H.host.game.gi.mCurrentPlayerZone;
    var real = z.GetSpecialists_vector;
    var box = { n: 0 };
    z.GetSpecialists_vector = function () { box.n++; return real.apply(z, arguments); };
    return box;
}

function warnLines(s, re) {
    return s.H.logs().filter(function (l) { return l.level === 'warn' && re.test(JSON.stringify(l)); });
}

t.test('send reads no list: it uses the general its precheck found', function () {
    var cases = [
        { name: 'move',   build: function (s) { return s.orders.move('g1', 42); },        packets: true },
        { name: 'attack', build: function (s) { return s.orders.attack('g1', 300); },     packets: true },
        { name: 'star',   build: function (s) { return s.orders.star('g1'); },            packets: true },
        { name: 'sendToZone', build: function (s) { return s.orders.sendToZone('g1', 5); }, packets: false }
    ];
    cases.forEach(function (c) {
        var g = AC.general({ uid: 'g1', grid: 5, army: { Rifle: 3 } });
        var s = setup({ generals: [g], buildings: { 300: camp(300) } });
        var def = c.build(s);
        assert.strictEqual(def.precheck(), null, c.name);
        var reads = countReads(s);
        hideGeneral(s);
        assert.strictEqual(def.send(), true, c.name);
        assert.strictEqual(reads.n, 0, c.name + ' read the list');
        if (c.packets) {
            assert.strictEqual(s.sent.actions.length, 1, c.name);
            assert.strictEqual(s.sent.actions[0].data.uniqueID.toKeyString(), 'g1', c.name);
        } else {
            assert.strictEqual(s.zoneCalls.length, 1, c.name);
            assert.strictEqual(s.zoneCalls[0].spec, g, c.name);
        }
    });
});

t.test('send without a found general returns false, sends nothing and warns', function () {
    var names = ['move', 'attack', 'star', 'sendToZone'];
    names.forEach(function (name) {
        var g = AC.general({ uid: 'g1', grid: 5, army: { Rifle: 3 } });
        var s = setup({ generals: [g], buildings: { 300: camp(300) } });
        var def = {
            move:       function () { return s.orders.move('g1', 42); },
            attack:     function () { return s.orders.attack('g1', 300); },
            star:       function () { return s.orders.star('g1'); },
            sendToZone: function () { return s.orders.sendToZone('g1', 5); }
        }[name]();
        assert.strictEqual(def.send(), false, name);
        assert.strictEqual(s.sent.actions.length, 0, name);
        assert.strictEqual(s.zoneCalls.length, 0, name);
        assert.strictEqual(warnLines(s, /send without a found general/).length, 1, name);
    });
});

t.test('a refused precheck clears what an earlier precheck found', function () {
    var g = AC.general({ uid: 'g1', grid: 5 });
    var s = setup({ generals: [g] });
    var def = s.orders.move('g1', 42);
    assert.strictEqual(def.precheck(), null);
    s.sent.placeable = 1;
    assert.ok(def.precheck());
    assert.strictEqual(def.send(), false);
    assert.strictEqual(s.sent.actions.length, 0);
});
