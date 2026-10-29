'use strict';

var t = require('../runner');
var harness = require('../harness');
var AC = require('../stubs/actions');

var assert = t.assert;

// A home zone with a barracks (queue 0) and an elite barracks (queue 8).
// world.queues[id] = { entries: [{ type, amount }], grid, throwOn }.
function setup(opts) {
    opts = opts || {};
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var sent = AC.wire(H);
    var world = {
        queues: {
            0: { entries: [], grid: 111, type: 1 },
            8: { entries: [], grid: 222, type: 2 }
        },
        elite: { Rifleman: false, Marksman: true },
        costs: {
            Rifleman: [{ name_string: 'Population', amount: 1 }, { name_string: 'Gold', amount: 10 }],
            Marksman: [{ name_string: 'Population', amount: 2 }]
        },
        stock: { Gold: 1000 },
        free: 100,
        unreadable: false
    };

    function queueFake(id) {
        var q = world.queues[id];
        return {
            mProductionType: q.type,
            productionBuilding: { GetGrid: function () { return q.grid; } },
            get mTimedProductions_vector() {
                if (world.unreadable) throw new Error('queue read failed');
                var out = [];
                for (var i = 0; i < q.entries.length; i++) {
                    out.push((function (e) {
                        return { GetType_string: function () { return e.type; }, GetAmount: function () { return e.amount; } };
                    }(q.entries[i])));
                }
                return out;
            }
        };
    }

    H.host.game.gi.mCurrentPlayerZone = {
        GetProductionQueue: function (id) { return world.queues[id] ? queueFake(id) : null; }
    };
    H.host.game.gi.mCurrentViewedZoneID = 77;
    H.host.game.getResources = function () {
        return {
            GetResourceAmount: function (name) { return world.stock[name]; },
            GetFree: function () { return world.free; }
        };
    };
    sent.registerDef('MilitarySystem::cMilitaryUnitBase', {
        GetUnitBaseForType: function (name) {
            if (!(name in world.elite)) return null;
            return {
                GetIsElite: function () { return world.elite[name]; },
                GetCosts_vector: function () { return world.costs[name]; }
            };
        }
    });
    return { H: H, S: H.Steward, P: H.Steward.core.production, sent: sent, world: world };
}

function run(b, def, onStep) {
    var results = [];
    var ok = b.S.core.actions.attempt(def, function (r) { results.push(r); });
    AC.drive(b.H, { onStep: onStep });
    return { ok: ok, results: results };
}

// Lands every sent message in the matching queue, like the server would.
function deliver(b) {
    var m = b.sent.messages;
    for (var i = 0; i < m.length; i++) {
        var vo = m[i].data;
        var q = vo.buildingGrid === 222 ? b.world.queues[8] : b.world.queues[0];
        q.entries.push({ type: vo.type_string, amount: vo.amount * vo.stacks });
    }
    b.sent.messages.length = 0;
}

t.test('stacks splits 60 into 25, 25 and 10', function () {
    var b = setup();
    // Arrays come from the harness context, so compare their JSON.
    assert.strictEqual(JSON.stringify(b.P.stacks(60, 25)), '[{"amount":25,"count":2},{"amount":10,"count":1}]');
    assert.strictEqual(JSON.stringify(b.P.stacks(50, 25)), '[{"amount":25,"count":2}]');
    assert.strictEqual(JSON.stringify(b.P.stacks(7, 25)), '[{"amount":7,"count":1}]');
    assert.strictEqual(b.P.stacks(0, 25).length, 0);
    assert.strictEqual(b.P.stacks(2.5, 25).length, 0);
});

t.test('elite units use queue 8', function () {
    var b = setup();
    assert.strictEqual(b.P.queueIdFor('Rifleman'), 0);
    assert.strictEqual(b.P.queueIdFor('Marksman'), 8);
    assert.strictEqual(b.P.queueIdFor('Unknown'), null);
    b.world.queues[8].entries.push({ type: 'Marksman', amount: 4 });
    b.world.queues[8].entries.push({ type: 'Other', amount: 9 });
    assert.strictEqual(b.P.queued('Marksman'), 4);
    assert.strictEqual(b.P.queued('Rifleman'), 0);
});

t.test('population shortfall is exact and floored', function () {
    var b = setup();
    assert.strictEqual(b.P.populationShortfall([{ population: 1, count: 30 }, { population: 2, count: 10 }], 20), 30);
    assert.strictEqual(b.P.populationShortfall([{ population: 1, count: 5 }], 20), 0);
    assert.strictEqual(b.P.populationShortfall([{ population: 1, count: 5 }], null), null);
    assert.strictEqual(b.P.populationCost('Marksman'), 2);
});

t.test('population cost follows core.resources.POPULATION', function () {
    var b = setup();
    b.world.elite.Scout = false;
    b.world.costs.Scout = [{ name_string: 'Manpower', amount: 3 }];
    b.world.free = 1;
    b.world.stock.Manpower = 100;
    var original = b.S.core.resources.POPULATION;
    try {
        assert.strictEqual(b.P.populationCost('Scout'), 0);
        assert.strictEqual(b.P.shortfalls('Scout', 5).length, 0);

        b.S.core.resources.POPULATION = 'Manpower';
        assert.strictEqual(b.P.populationCost('Scout'), 3);
        var missing = b.P.shortfalls('Scout', 5);
        assert.strictEqual(missing.length, 1);
        assert.strictEqual(missing[0].name, 'Manpower');
        assert.strictEqual(missing[0].need, 15);
        assert.strictEqual(missing[0].have, 1);
    } finally {
        b.S.core.resources.POPULATION = original;
    }
});

t.test('order refuses when unaffordable', function () {
    var b = setup();
    b.world.free = 3;
    var r = run(b, b.P.order('Rifleman', 5));
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Refused);
    assert.strictEqual(r.results[0].sends, 0);
    assert.strictEqual(b.sent.messages.length, 0);

    // A failed stock read is unaffordable, not free.
    var c = setup();
    c.world.stock = {};
    var r2 = run(c, c.P.order('Rifleman', 5));
    assert.strictEqual(r2.results[0].status, c.S.ActionResult.Refused);
    assert.strictEqual(c.sent.messages.length, 0);
});

t.test('order refuses a missing queue, an unknown unit and a bad amount', function () {
    var b = setup();
    delete b.world.queues[0];
    assert.strictEqual(run(b, b.P.order('Rifleman', 5)).results[0].status, b.S.ActionResult.Refused);

    var c = setup();
    assert.strictEqual(run(c, c.P.order('Ghost', 5)).results[0].status, c.S.ActionResult.Refused);
    assert.strictEqual(run(c, c.P.order('Rifleman', 0)).results[0].status, c.S.ActionResult.Refused);
    assert.strictEqual(run(c, c.P.order('Rifleman', 1.5)).results[0].status, c.S.ActionResult.Refused);
    assert.strictEqual(c.sent.messages.length, 0);
});

t.test('order refuses when the queue cannot be read', function () {
    var b = setup();
    b.world.unreadable = true;
    var r = run(b, b.P.order('Rifleman', 5));
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Refused);
    assert.strictEqual(r.results[0].reason, 'production queue unreadable');
    assert.strictEqual(r.results[0].sends, 0);
    assert.strictEqual(b.sent.messages.length, 0);
});

t.test('order does not verify while the queue cannot be read', function () {
    var b = setup();
    var r = run(b, b.P.order('Rifleman', 5), function (n) {
        if (n === 1) { deliver(b); b.world.unreadable = true; }
    });
    // The first send lands, but every later read fails: not observed, and the
    // retry refuses to send blind, so the order fails after exactly one send.
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Failed);
    assert.strictEqual(r.results[0].sends, 1);
    assert.strictEqual(b.sent.messages.length, 0);
});

t.test('order sends one message per stack shape with the building grid', function () {
    var b = setup();
    var r = run(b, b.P.order('Rifleman', 60), function (n) { if (n === 1) deliver(b); });
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Verified);
    assert.strictEqual(r.results[0].sends, 1);
    // deliver() consumed the messages; replay the order to inspect them.
    var c = setup();
    c.world.free = 1000;
    run(c, c.P.order('Marksman', 60));
    var m = c.sent.messages;
    assert.strictEqual(m.length, 4);
    assert.strictEqual(m[0].id, 91);
    assert.strictEqual(m[0].zone, 77);
    assert.strictEqual(m[0].data.voName, 'dTimedProductionVO');
    assert.strictEqual(m[0].data.type_string, 'Marksman');
    assert.strictEqual(m[0].data.productionType, 2);
    assert.strictEqual(m[0].data.buildingGrid, 222);
    assert.strictEqual(m[0].data.amount, 25);
    assert.strictEqual(m[0].data.stacks, 2);
    assert.strictEqual(m[1].data.amount, 10);
    assert.strictEqual(m[1].data.stacks, 1);
});

t.test('a retry orders only the remainder', function () {
    var b = setup();
    b.world.queues[0].entries.push({ type: 'Rifleman', amount: 3 });
    var seen = [];
    var r = run(b, b.P.order('Rifleman', 50), function (n) {
        // Part of the first order arrives, the rest does not.
        if (n === 1) {
            b.world.queues[0].entries.push({ type: 'Rifleman', amount: 20 });
            seen.push(b.sent.messages.length);
        }
    });
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Failed);
    assert.strictEqual(r.results[0].sends, 2);
    var m = b.sent.messages;
    // First send: 50 as two stacks of 25. Retry: 50 - 20 = 30 as 25 + 5.
    assert.strictEqual(seen[0], 1);
    assert.strictEqual(m.length, 3);
    assert.strictEqual(m[1].data.amount, 25);
    assert.strictEqual(m[1].data.stacks, 1);
    assert.strictEqual(m[2].data.amount, 5);
    assert.strictEqual(m[2].data.stacks, 1);
});

t.test('a late first order verifies on the retry without a second send', function () {
    var b = setup();
    var r = run(b, b.P.order('Rifleman', 10), function (n) {
        if (n === 1) deliver(b);
    });
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Verified);
    assert.strictEqual(r.results[0].sends, 1);
});
