'use strict';

var t = require('../runner');
var harness = require('../harness');
var A = require('../stubs/army');

var assert = t.assert;

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function setup(o, loca) {
    var H = harness.boot();
    if (loca) H.host.loca.GetText = loca;
    A.install(H, o);
    return { H: H, S: H.Steward, buffs: H.Steward.core.buffs };
}

function names(list) {
    return plain(list.map(function (b) { return b.name; }));
}

var INV = [
    { type: 'GeneralSpeedBuff_A', amount: 3 },
    { type: 'GeneralSpeedBuff_A', amount: 2, uid: 'second' },
    { type: 'OtherBuff', amount: 9 }
];

t.test('speedBuffs: with no definitions the list comes from the inventory only', function () {
    var s = setup({ buffs: INV, buffDefs: null });
    var list = s.buffs.speedBuffs();
    assert.deepStrictEqual(names(list), ['GeneralSpeedBuff_A']);
});

t.test('speedBuffs: defined names are united with the inventory and sorted', function () {
    var s = setup({
        buffs: INV,
        buffDefs: { GeneralSpeedBuff_C: {}, GeneralSpeedBuff_A: {}, GeneralSpeedBuff_B: {}, Unrelated: {} }
    });
    assert.deepStrictEqual(names(s.buffs.speedBuffs()),
        ['GeneralSpeedBuff_A', 'GeneralSpeedBuff_B', 'GeneralSpeedBuff_C']);
});

t.test('speedBuffs: stacks of the same buff sum up', function () {
    var s = setup({ buffs: INV, buffDefs: {} });
    assert.strictEqual(s.buffs.speedBuffs()[0].amount, 5);
    assert.strictEqual(s.buffs.amount('GeneralSpeedBuff_A'), 5);
});

t.test('amount: entries bound to a resource are a different stock and are ignored', function () {
    var s = setup({
        buffs: [
            { type: 'GeneralSpeedBuff_A', amount: 4 },
            { type: 'GeneralSpeedBuff_A', amount: 7, resource: 'Coal' }
        ]
    });
    assert.strictEqual(s.buffs.amount('GeneralSpeedBuff_A'), 4);
});

t.test('speedBuffs: a defined buff with no stock is listed with amount 0', function () {
    var s = setup({ buffs: [], buffDefs: { GeneralSpeedBuff_A: {} } });
    var list = s.buffs.speedBuffs();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].amount, 0);
});

t.test('speedBuffs: non-speed buffs in the inventory are not listed', function () {
    var s = setup({ buffs: INV, buffDefs: {} });
    assert.deepStrictEqual(names(s.buffs.speedBuffs()), ['GeneralSpeedBuff_A']);
});

t.test('effectText: the description is cut at Target and trimmed', function () {
    var s = setup({ buffs: INV, buffDefs: {} }, function (cat, key) {
        return cat === 'DES' ? 'Faster march.  Target: all generals' : key;
    });
    assert.strictEqual(s.buffs.effectText('GeneralSpeedBuff_A'), 'Faster march.');
    assert.strictEqual(s.buffs.speedBuffs()[0].effect, 'Faster march.');
});

t.test('speedBuffs: a definition map that cannot be enumerated falls back to the inventory', function () {
    var hostile = new Proxy({}, {
        ownKeys: function () { throw new Error('not enumerable'); }
    });
    var s = setup({ buffs: INV, buffDefs: hostile });
    assert.deepStrictEqual(names(s.buffs.speedBuffs()), ['GeneralSpeedBuff_A']);
});

t.test('mapCounts sums Adventure entries per resource', function () {
    var s = setup({
        buffs: [
            { type: 'Adventure', resource: 'AdvA', amount: 2 },
            { type: 'Adventure', resource: 'AdvA', amount: 1, uid: 'second' },
            { type: 'Adventure', resource: 'AdvB', amount: 4 },
            { type: 'Adventure', resource: '', amount: 9, uid: 'empty' },
            { type: 'GeneralSpeedBuff_A', amount: 5 }
        ]
    });
    assert.deepStrictEqual(plain(s.buffs.mapCounts()), { AdvA: 3, AdvB: 4 });
});

t.test('mapCounts without a player is empty and logs nothing', function () {
    var s = setup({ buffs: [{ type: 'Adventure', resource: 'AdvA', amount: 2 }] });
    delete s.H.host.game.gi.mCurrentPlayer;
    s.H.clearLogs();
    assert.deepStrictEqual(plain(s.buffs.mapCounts()), {});
    assert.strictEqual(s.H.logs().length, 0);
});

t.test('amount still ignores resource-bound entries of the map type', function () {
    var s = setup({ buffs: [{ type: 'Adventure', resource: 'AdvA', amount: 2 }] });
    assert.strictEqual(s.buffs.amount('Adventure'), 0);
});

t.test('amount is 0 when the star menu cannot be read', function () {
    var s = setup({ buffs: [{ type: 'GeneralSpeedBuff_A', amount: 4 }] });
    assert.strictEqual(s.buffs.amount('GeneralSpeedBuff_A'), 4);
    s.H.host.game.gi.mCurrentPlayer.getAvailableBuffs_vector = function () { throw new Error('boom'); };
    assert.strictEqual(s.buffs.amount('GeneralSpeedBuff_A'), 0);
});

// ---- reading the stock for actions ---------------------------------------------

var AC = require('../stubs/actions');

t.test('entry returns the uid object of a resource-bound entry', function () {
    var s = setup({ buffs: [
        { type: 'Adventure', resource: 'AdvA', amount: 0, uid: 'empty' },
        { type: 'Adventure', resource: 'AdvA', amount: 2, uid: 'full' },
        { type: 'Adventure', resource: 'AdvB', amount: 5, uid: 'other' }
    ] });
    var e = s.buffs.entry('Adventure', 'AdvA');
    assert.strictEqual(typeof e.uid, 'object');
    assert.strictEqual(e.uid.toKeyString(), 'full');
    assert.strictEqual(s.buffs.entry('Adventure', ''), null);
    assert.strictEqual(s.buffs.entry('Adventure', 'AdvZ'), null);
});

t.test('stock sums exactly the type and resource asked for', function () {
    var s = setup({ buffs: [
        { type: 'GeneralSpeedBuff_A', amount: 3 },
        { type: 'GeneralSpeedBuff_A', amount: 4, resource: 'Coal', uid: 'bound' },
        { type: 'Adventure', resource: 'AdvA', amount: 2 },
        { type: 'Adventure', resource: 'AdvA', amount: 1, uid: 'second' }
    ] });
    assert.strictEqual(s.buffs.stock('GeneralSpeedBuff_A', ''), 3);
    assert.strictEqual(s.buffs.stock('Adventure', 'AdvA'), 3);
    assert.strictEqual(s.buffs.stock('Adventure', 'AdvB'), 0);
});

t.test('stock and isRunning return null on an unreadable host', function () {
    var s = setup({ buffs: INV });
    var gi = s.H.host.game.gi;
    assert.strictEqual(s.buffs.isRunning('GeneralSpeedBuff_A'), null);
    gi.mZoneBuffManager = { isBuffRunning: function () { throw new Error('boom'); } };
    assert.strictEqual(s.buffs.isRunning('GeneralSpeedBuff_A'), null);
    gi.mZoneBuffManager = { isBuffRunning: function () { return true; } };
    assert.strictEqual(s.buffs.isRunning('GeneralSpeedBuff_A'), true);
    gi.mCurrentPlayer.getAvailableBuffs_vector = function () { throw new Error('boom'); };
    assert.strictEqual(s.buffs.stock('GeneralSpeedBuff_A', ''), null);
    assert.strictEqual(s.buffs.entry('GeneralSpeedBuff_A', ''), null);
    assert.deepStrictEqual(plain(s.buffs.inventory()), []);
    delete gi.mCurrentPlayer;
    assert.strictEqual(s.buffs.stock('GeneralSpeedBuff_A', ''), null);
});

// ---- action defs -----------------------------------------------------------------

// A booted setup with the packet recorder and simple stand-ins for the readers
// the defs use. env.onSend runs when a buff packet goes out.
function acting(o) {
    var s = setup(o);
    var sent = AC.wire(s.H);
    var env = { onSend: null, home: true, free: 10, own: [], buildings: {}, running: null };
    var gi = s.H.host.game.gi;
    var send = gi.SendServerAction;
    gi.SendServerAction = function () {
        send.apply(this, arguments);
        if (env.onSend) env.onSend(sent.actions[sent.actions.length - 1]);
    };
    gi.mZoneBuffManager = { isBuffRunning: function () { return env.running; } };
    s.S.core.zone.isHome = function () { return env.home; };
    s.S.core.resources.freePopulation = function () { return env.free; };
    s.S.core.adventures.own = function () { return env.own; };
    s.S.core.buildings.byGrid = function (g) { return env.buildings[g] || null; };
    s.sent = sent;
    s.env = env;
    return s;
}

function run(s, def) {
    var res = null;
    s.S.core.actions.attempt(def, function (r) { res = r; });
    AC.drive(s.H);
    return res;
}

function breakStock(s) {
    s.H.host.game.gi.mCurrentPlayer.getAvailableBuffs_vector = function () { throw new Error('boom'); };
}

t.test('speed buff uses grid 0 and verifies by isBuffRunning', function () {
    var buff = { type: 'GeneralSpeedBuff_A', amount: 2 };
    var s = acting({ buffs: [buff] });
    s.env.onSend = function () { s.env.running = true; };
    var res = run(s, s.buffs.speed('GeneralSpeedBuff_A'));
    assert.strictEqual(res.status, s.S.ActionResult.Verified);
    assert.strictEqual(res.sends, 1);
    assert.strictEqual(s.sent.actions[0].id, 61);
    assert.strictEqual(s.sent.actions[0].p2, 0);
    assert.strictEqual(s.sent.actions[0].p3, 0);
    assert.strictEqual(s.sent.actions[0].data.toKeyString(), 'GeneralSpeedBuff_A');
});

t.test('speed and camp verify by a stock drop against the baseline', function () {
    var buff = { type: 'GeneralSpeedBuff_A', amount: 2 };
    var s = acting({ buffs: [buff] });
    s.env.onSend = function () { buff.amount -= 1; };
    var res = run(s, s.buffs.speed('GeneralSpeedBuff_A'));
    assert.strictEqual(res.status, s.S.ActionResult.Verified);

    var c = { type: 'CampBuff', amount: 1 };
    var s2 = acting({ buffs: [c] });
    s2.env.buildings[500] = { getPlayerID: function () { return -1; } };
    s2.env.onSend = function () { c.amount -= 1; };
    var res2 = run(s2, s2.buffs.camp('CampBuff', 500));
    assert.strictEqual(res2.status, s2.S.ActionResult.Verified);
});

t.test('speed refuses a missing stock, a running buff and a non-speed name', function () {
    var s = acting({ buffs: [{ type: 'GeneralSpeedBuff_A', amount: 0 }] });
    assert.strictEqual(run(s, s.buffs.speed('GeneralSpeedBuff_A')).reason, 'no buff in stock');
    var s2 = acting({ buffs: [{ type: 'GeneralSpeedBuff_A', amount: 1 }] });
    s2.env.running = true;
    assert.strictEqual(run(s2, s2.buffs.speed('GeneralSpeedBuff_A')).reason, 'buff already running');
    assert.strictEqual(run(s2, s2.buffs.speed('Other')).reason, 'not a speed buff');
    assert.strictEqual(s2.sent.actions.length, 0);
});

t.test('speed is refused while the stock cannot be read', function () {
    var s = acting({ buffs: [{ type: 'GeneralSpeedBuff_A', amount: 1 }] });
    breakStock(s);
    var res = run(s, s.buffs.speed('GeneralSpeedBuff_A'));
    assert.strictEqual(res.status, s.S.ActionResult.Refused);
    assert.strictEqual(res.reason, 'buff stock unreadable');
    assert.strictEqual(s.sent.actions.length, 0);
});

t.test('speed does not verify when the stock becomes unreadable after the send', function () {
    var s = acting({ buffs: [{ type: 'GeneralSpeedBuff_A', amount: 1 }] });
    s.env.onSend = function () { breakStock(s); };
    var res = run(s, s.buffs.speed('GeneralSpeedBuff_A'));
    assert.strictEqual(res.status, s.S.ActionResult.Failed);
});

t.test('camp buff is sent to the line target grid, never 8825', function () {
    var buff = { type: 'CampBuff', amount: 3 };
    var s = acting({ buffs: [buff] });
    s.env.buildings[500] = { getPlayerID: function () { return -1; } };
    s.env.onSend = function () { buff.amount -= 1; };
    run(s, s.buffs.camp('CampBuff', 500));
    assert.strictEqual(s.sent.actions[0].p2, 500);
    assert.notStrictEqual(s.sent.actions[0].p2, 8825);
});

t.test('camp refuses without a grid or an enemy building', function () {
    var s = acting({ buffs: [{ type: 'CampBuff', amount: 3 }] });
    assert.strictEqual(run(s, s.buffs.camp('CampBuff', 0)).reason, 'no target grid');
    assert.strictEqual(run(s, s.buffs.camp('CampBuff', 500)).reason, 'no enemy building at grid');
    s.env.buildings[500] = { getPlayerID: function () { return 0; } };
    assert.strictEqual(run(s, s.buffs.camp('CampBuff', 500)).reason, 'no enemy building at grid');
    assert.strictEqual(s.sent.actions.length, 0);
});

t.test('camp does not verify while the stock cannot be read', function () {
    var buff = { type: 'CampBuff', amount: 3 };
    var s = acting({ buffs: [buff] });
    s.env.buildings[500] = { getPlayerID: function () { return -1; } };
    s.env.onSend = function () { buff.amount -= 1; breakStock(s); };
    var res = run(s, s.buffs.camp('CampBuff', 500));
    assert.strictEqual(res.status, s.S.ActionResult.Failed);
});

t.test('population sends exactly the requested amount', function () {
    var buff = { type: 'AddResource', resource: 'Population', amount: 500 };
    var s = acting({ buffs: [buff] });
    s.env.onSend = function (a) { buff.amount -= a.p3; };
    run(s, s.buffs.population(120));
    assert.strictEqual(s.sent.actions[0].id, 61);
    assert.strictEqual(s.sent.actions[0].p2, 8825);
    assert.strictEqual(s.sent.actions[0].p3, 120);
});

t.test('population verified by free population', function () {
    var buff = { type: 'AddResource', resource: 'Population', amount: 500 };
    var s = acting({ buffs: [buff] });
    s.env.onSend = function (a) { s.env.free += a.p3; };
    var res = run(s, s.buffs.population(120));
    assert.strictEqual(res.status, s.S.ActionResult.Verified);
    assert.strictEqual(res.sends, 1);
});

t.test('population uses the resource name from core.resources', function () {
    var buff = { type: 'AddResource', resource: 'Coins', amount: 50 };
    var s = acting({ buffs: [buff] });
    var prev = s.S.core.resources.POPULATION;
    s.S.core.resources.POPULATION = 'Coins';
    try {
        s.env.onSend = function (a) { s.env.free += a.p3; };
        var res = run(s, s.buffs.population(10));
        assert.strictEqual(res.status, s.S.ActionResult.Verified);
        assert.strictEqual(s.sent.actions.length, 1);
        assert.strictEqual(s.sent.actions[0].p3, 10);
    } finally {
        s.S.core.resources.POPULATION = prev;
    }
});

t.test('population refuses a bad amount, a short stock and unreadable readers', function () {
    var s = acting({ buffs: [{ type: 'AddResource', resource: 'Population', amount: 50 }] });
    assert.strictEqual(run(s, s.buffs.population(0)).reason, 'invalid amount');
    assert.strictEqual(run(s, s.buffs.population(1.5)).reason, 'invalid amount');
    assert.strictEqual(run(s, s.buffs.population(51)).reason, 'not enough in stock');
    s.env.free = null;
    assert.strictEqual(run(s, s.buffs.population(10)).reason, 'free population unreadable');
    breakStock(s);
    s.env.free = 10;
    assert.strictEqual(run(s, s.buffs.population(10)).reason, 'buff stock unreadable');
    assert.strictEqual(s.sent.actions.length, 0);
});

t.test('population does not verify while both readers fail after the send', function () {
    var s = acting({ buffs: [{ type: 'AddResource', resource: 'Population', amount: 50 }] });
    s.env.onSend = function () { s.env.free = null; breakStock(s); };
    var res = run(s, s.buffs.population(10));
    assert.strictEqual(res.status, s.S.ActionResult.Failed);
});

t.test('map start refuses off home and verifies by own open adventures', function () {
    var buff = { type: 'Adventure', resource: 'AdvA', amount: 2 };
    var s = acting({ buffs: [buff] });
    s.env.home = false;
    assert.strictEqual(run(s, s.buffs.map('AdvA')).reason, 'not on the home island');
    assert.strictEqual(s.sent.actions.length, 0);

    s.env.home = true;
    s.env.onSend = function () { s.env.own = [{ name: 'AdvA', zoneId: 1 }]; };
    var res = run(s, s.buffs.map('AdvA'));
    assert.strictEqual(res.status, s.S.ActionResult.Verified);
    assert.strictEqual(s.sent.actions[0].p2, 8825);
    assert.strictEqual(s.sent.actions[0].p3, 0);
    assert.strictEqual(s.sent.actions[0].data.toKeyString(), 'Adventure');
});

t.test('map start refuses an empty stock and unreadable stock or adventures', function () {
    var s = acting({ buffs: [{ type: 'Adventure', resource: 'AdvA', amount: 0 }] });
    assert.strictEqual(run(s, s.buffs.map('AdvA')).reason, 'no map in stock');
    breakStock(s);
    assert.strictEqual(run(s, s.buffs.map('AdvA')).reason, 'map stock unreadable');
    var s2 = acting({ buffs: [{ type: 'Adventure', resource: 'AdvA', amount: 1 }] });
    s2.env.own = null;
    assert.strictEqual(run(s2, s2.buffs.map('AdvA')).reason, 'adventures unreadable');
    assert.strictEqual(s2.sent.actions.length, 0);
});

t.test('map start does not verify while own adventures cannot be read and stock is unchanged', function () {
    var s = acting({ buffs: [{ type: 'Adventure', resource: 'AdvA', amount: 2 }] });
    s.env.onSend = function () { s.env.own = null; };
    var res = run(s, s.buffs.map('AdvA'));
    assert.strictEqual(res.status, s.S.ActionResult.Failed);
});

t.test('population refuses when no single stack holds the amount', function () {
    var s = acting({ buffs: [
        { type: 'AddResource', resource: 'Population', amount: 20, uid: 'a' },
        { type: 'AddResource', resource: 'Population', amount: 20, uid: 'b' }
    ] });
    assert.strictEqual(run(s, s.buffs.population(30)).reason, 'no single stack of 30');
    assert.strictEqual(s.sent.actions.length, 0);
});

t.test('entry skips empty and resource-bound entries; population needs one stack of the amount', function () {
    var e = setup({ buffs: [
        { type: 'GeneralSpeedBuff_A', amount: 0, uid: 'empty' },
        { type: 'GeneralSpeedBuff_A', resource: 'X', amount: 5, uid: 'bound' },
        { type: 'GeneralSpeedBuff_A', amount: 3, uid: 'plain' }
    ] });
    assert.strictEqual(e.buffs.entry('GeneralSpeedBuff_A').uid.toKeyString(), 'plain');
    assert.strictEqual(e.buffs.entry('GeneralSpeedBuff_A', 'X').uid.toKeyString(), 'bound');

    var s = acting({ buffs: [
        { type: 'AddResource', resource: 'Population', amount: 3, uid: 'a' },
        { type: 'AddResource', resource: 'Population', amount: 3, uid: 'b' }
    ] });
    assert.strictEqual(run(s, s.buffs.population(4)).reason, 'no single stack of 4');
    assert.strictEqual(s.sent.actions.length, 0);
});

t.test('population sends from the stack that holds at least the amount', function () {
    var s = acting({ buffs: [
        { type: 'AddResource', resource: 'Population', amount: 5, uid: 'small' },
        { type: 'AddResource', resource: 'Population', amount: 25, uid: 'big' }
    ] });
    run(s, s.buffs.population(20));
    assert.ok(s.sent.actions.length >= 1);
    assert.strictEqual(s.sent.actions[0].p3, 20);
    assert.strictEqual(s.sent.actions[0].data.toKeyString(), 'big');
});

t.test('populationStock returns the total and largest stack, null when unreadable', function () {
    var s = acting({ buffs: [
        { type: 'AddResource', resource: 'Population', amount: 20, uid: 'a' },
        { type: 'AddResource', resource: 'Population', amount: 35, uid: 'b' },
        { type: 'AddResource', resource: 'Coins', amount: 99, uid: 'c' }
    ] });
    assert.deepStrictEqual(plain(s.buffs.populationStock()), { total: 55, largest: 35 });
    breakStock(s);
    assert.strictEqual(s.buffs.populationStock(), null);
});
