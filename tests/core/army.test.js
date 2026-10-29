'use strict';

var t = require('../runner');
var harness = require('../harness');
var A = require('../stubs/army');
var specStubs = require('../stubs/specialists');

var assert = t.assert;

// Objects built inside the vm context have that realm's prototypes, so
// deepStrictEqual compares a plain copy.
function plain(v) { return JSON.parse(JSON.stringify(v)); }

function setup(o) {
    var H = harness.boot();
    A.install(H, o);
    return { H: H, S: H.Steward, army: H.Steward.core.army };
}

var UNITS = A.unitCatalogue(['EliteRifle'], ['Rifle', 'Sabre', 'Bow']);

// ---- inventory --------------------------------------------------------------

t.test('inventory: free, assigned and total pools add up over generals and carriers', function () {
    var s = setup({
        units: UNITS,
        free:  { Rifle: 10 },
        fighters: [
            A.fighter({ uid: 'g1', army: { Rifle: 5, Sabre: 2 } }),
            A.fighter({ uid: 'c1', carrier: true, army: { Rifle: 3 } })
        ]
    });
    var inv = s.army.inventory();
    assert.deepStrictEqual(plain(inv.free), { Rifle: 10 });
    assert.deepStrictEqual(plain(inv.assigned), { Rifle: 8, Sabre: 2 });
    assert.deepStrictEqual(plain(inv.total), { Rifle: 18, Sabre: 2 });
    assert.deepStrictEqual(Object.keys(inv.byKey).sort(), ['c1', 'g1']);
    assert.strictEqual(inv.byKey.c1.cls, s.S.SpecialistType.Carrier);
    assert.strictEqual(inv.byKey.g1.cls, s.S.SpecialistType.General);
});

t.test('inventory: the free pool keeps only squads of the free-pool category', function () {
    var s = setup({
        free: A.armyOf({ Rifle: 10, Boat: 4 }, { categories: { Boat: 1 } })
    });
    assert.deepStrictEqual(plain(s.army.inventory().free), { Rifle: 10 });
});

t.test('inventory: a general of another player is not part of the inventory', function () {
    var s = setup({
        playerId: 1,
        free: { Rifle: 1 },
        fighters: [
            A.fighter({ uid: 'mine', army: { Rifle: 4 } }),
            A.fighter({ uid: 'theirs', playerId: 2, army: { Rifle: 9 } })
        ]
    });
    var inv = s.army.inventory();
    assert.deepStrictEqual(Object.keys(inv.byKey), ['mine']);
    assert.deepStrictEqual(plain(inv.assigned), { Rifle: 4 });
});

t.test('inventory: donorOk needs idle, not travelling, a real garrison grid and troops', function () {
    var s = setup({
        fighters: [
            A.fighter({ uid: 'ok', army: { Rifle: 5 } }),
            A.fighter({ uid: 'busy', task: specStubs.task(1, 0, 1000), army: { Rifle: 5 } }),
            A.fighter({ uid: 'away', travelling: true, army: { Rifle: 5 } }),
            A.fighter({ uid: 'star', grid: -1, army: { Rifle: 5 } }),
            A.fighter({ uid: 'zero', grid: 0, army: { Rifle: 5 } }),
            A.fighter({ uid: 'bare', army: {} })
        ]
    });
    var by = s.army.inventory().byKey;
    assert.strictEqual(by.ok.donorOk, true);
    assert.strictEqual(by.busy.donorOk, false);
    assert.strictEqual(by.away.donorOk, false);
    assert.strictEqual(by.star.donorOk, false);
    assert.strictEqual(by.zero.donorOk, false);
    assert.strictEqual(by.bare.donorOk, false);
});

// ---- matches ----------------------------------------------------------------

t.test('matches: empty maps match each other', function () {
    var s = setup();
    assert.strictEqual(s.army.matches({}, {}), true);
});

t.test('matches: equal compositions match regardless of key order', function () {
    var s = setup();
    assert.strictEqual(s.army.matches({ Rifle: 5, Sabre: 2 }, { Sabre: 2, Rifle: 5 }), true);
});

t.test('matches: a type missing on either side does not match', function () {
    var s = setup();
    assert.strictEqual(s.army.matches({ Rifle: 5 }, { Rifle: 5, Sabre: 2 }), false);
    assert.strictEqual(s.army.matches({ Rifle: 5, Sabre: 2 }, { Rifle: 5 }), false);
});

t.test('matches: a different amount does not match', function () {
    var s = setup();
    assert.strictEqual(s.army.matches({ Rifle: 5 }, { Rifle: 6 }), false);
});

// ---- classOf ----------------------------------------------------------------

t.test('classOf: Empty for no troops', function () {
    var s = setup({ units: UNITS });
    assert.strictEqual(s.army.classOf({}), s.S.TroopClass.Empty);
});

t.test('classOf: Base for base units only', function () {
    var s = setup({ units: UNITS });
    assert.strictEqual(s.army.classOf({ Rifle: 3, Sabre: 1 }), s.S.TroopClass.Base);
});

t.test('classOf: Elite for elite units only', function () {
    var s = setup({ units: UNITS });
    assert.strictEqual(s.army.classOf({ EliteRifle: 3 }), s.S.TroopClass.Elite);
});

t.test('classOf: Mixed for base and elite together', function () {
    var s = setup({ units: UNITS });
    assert.strictEqual(s.army.classOf({ Rifle: 3, EliteRifle: 1 }), s.S.TroopClass.Mixed);
});

t.test('classOf: Unknown when a unit is not in the catalogue', function () {
    var s = setup({ units: UNITS });
    assert.strictEqual(s.army.classOf({ Rifle: 3, Ghost: 1 }), s.S.TroopClass.Unknown);
});

t.test('classOf: the catalogue scan finds units when there is no direct lookup', function () {
    var s = setup({ units: A.unitCatalogue(['EliteRifle'], ['Rifle'], { noLookup: true }) });
    assert.strictEqual(s.army.classOf({ EliteRifle: 1 }), s.S.TroopClass.Elite);
});

// ---- planSupply ---------------------------------------------------------------

t.test('planSupply: a wave covered by the free pool needs no donor', function () {
    var s = setup({ free: { Rifle: 100 }, fighters: [A.fighter({ uid: 'g1' })] });
    var plan = s.army.planSupply([{ key: 'g1', army: { Rifle: 60 } }], s.army.inventory());
    assert.deepStrictEqual(plain(plan.need), { Rifle: 60 });
    assert.deepStrictEqual(plain(plan.shortBefore), {});
    assert.deepStrictEqual(plain(plan.donors), []);
    assert.strictEqual(plan.covered, true);
    assert.deepStrictEqual(plain(plan.lines[0].draw), { Rifle: 60 });
});

t.test('planSupply: reuseOwn true draws only the delta over the general\'s own troops', function () {
    var s = setup({ free: { Rifle: 100 }, fighters: [A.fighter({ uid: 'g1', army: { Rifle: 5 } })] });
    var plan = s.army.planSupply([{ key: 'g1', army: { Rifle: 60 } }], s.army.inventory(), { reuseOwn: true });
    assert.deepStrictEqual(plain(plan.lines[0].draw), { Rifle: 55 });
    assert.deepStrictEqual(plain(plan.need), { Rifle: 55 });
});

t.test('planSupply: reuseOwn false draws the whole want', function () {
    var s = setup({ free: { Rifle: 100 }, fighters: [A.fighter({ uid: 'g1', army: { Rifle: 5 } })] });
    var plan = s.army.planSupply([{ key: 'g1', army: { Rifle: 60 } }], s.army.inventory(), { reuseOwn: false });
    assert.deepStrictEqual(plain(plan.lines[0].draw), { Rifle: 60 });
    assert.deepStrictEqual(plain(plan.need), { Rifle: 60 });
});

t.test('planSupply: a general that already matches draws nothing', function () {
    var s = setup({ free: {}, fighters: [A.fighter({ uid: 'g1', army: { Rifle: 60 } })] });
    var plan = s.army.planSupply([{ key: 'g1', army: { Rifle: 60 } }], s.army.inventory());
    assert.strictEqual(plan.lines[0].matches, true);
    assert.deepStrictEqual(plain(plan.lines[0].draw), {});
    assert.deepStrictEqual(plain(plan.need), {});
    assert.strictEqual(plan.covered, true);
});

t.test('planSupply: a short pool is covered by an idle donor outside the wave', function () {
    var s = setup({
        free: { Rifle: 10 },
        fighters: [
            A.fighter({ uid: 'g1', army: { Rifle: 5 } }),
            A.fighter({ uid: 'd1', name: 'Donor One', army: { Rifle: 50 } })
        ]
    });
    var plan = s.army.planSupply([{ key: 'g1', army: { Rifle: 60 } }], s.army.inventory());
    assert.deepStrictEqual(plain(plan.shortBefore), { Rifle: 45 });
    assert.deepStrictEqual(plain(plan.donors), [{ key: 'd1', name: 'Donor One', army: { Rifle: 50 } }]);
    assert.deepStrictEqual(plain(plan.shortAfter), {});
    assert.strictEqual(plan.covered, true);
});

t.test("planSupply: donors carry the inventory name, '' when it has none", function () {
    var s = setup({ free: { Rifle: 0 }, fighters: [] });
    var inv = {
        free: { Rifle: 0 },
        byKey: {
            g1: { army: { Rifle: 5 } },
            d1: { name: 'Named', army: { Rifle: 50 }, donorOk: true },
            d2: { army: { Rifle: 40 }, donorOk: true }
        }
    };
    var plan = s.army.planSupply([{ key: 'g1', army: { Rifle: 90 } }], inv);
    assert.deepStrictEqual(plain(plan.donors.map(function (d) { return d.name; })), ['Named', '']);
});

t.test('planSupply: a donor holding none of the short types is passed over, ties break by key', function () {
    // short is Rifle 45: d1 holds only Sabre and is skipped, d2 and d3 hold 30
    // Rifle each and both are needed, d4 would tie but is never reached.
    var s = setup({
        free: { Rifle: 10 },
        fighters: [
            A.fighter({ uid: 'g1', army: { Rifle: 5 } }),
            A.fighter({ uid: 'd1', army: { Sabre: 20 } }),
            A.fighter({ uid: 'd4', army: { Rifle: 30 } }),
            A.fighter({ uid: 'd3', army: { Rifle: 30 } }),
            A.fighter({ uid: 'd2', army: { Rifle: 30 } })
        ]
    });
    var plan = s.army.planSupply([{ key: 'g1', army: { Rifle: 60 } }], s.army.inventory());
    assert.deepStrictEqual(plain(plan.donors.map(function (d) { return d.key; })), ['d2', 'd3']);
    assert.strictEqual(plan.covered, true);
});

t.test('planSupply: donors are ranked by units held of the short types', function () {
    var s = setup({
        free: { Rifle: 10 },
        fighters: [
            A.fighter({ uid: 'g1', army: { Rifle: 5 } }),
            A.fighter({ uid: 'd1', army: { Rifle: 30 } }),
            A.fighter({ uid: 'd2', army: { Rifle: 40 } })
        ]
    });
    var plan = s.army.planSupply([{ key: 'g1', army: { Rifle: 60 } }], s.army.inventory());
    assert.deepStrictEqual(plain(plan.donors.map(function (d) { return d.key; })), ['d2', 'd1']);
    assert.strictEqual(plan.covered, true);
});

t.test('planSupply: busy, travelling, star and in-wave generals are never donors', function () {
    var s = setup({
        free: {},
        fighters: [
            A.fighter({ uid: 'g1', army: {} }),
            A.fighter({ uid: 'g2', army: { Rifle: 100 } }),
            A.fighter({ uid: 'busy', task: specStubs.task(1, 0, 1000), army: { Rifle: 100 } }),
            A.fighter({ uid: 'away', travelling: true, army: { Rifle: 100 } }),
            A.fighter({ uid: 'star', grid: -1, army: { Rifle: 100 } }),
            A.fighter({ uid: 'zero', grid: 0, army: { Rifle: 100 } })
        ]
    });
    var wave = [{ key: 'g1', army: { Rifle: 200 } }, { key: 'g2', army: {} }];
    var plan = s.army.planSupply(wave, s.army.inventory());
    assert.deepStrictEqual(plain(plan.donors), []);
    assert.deepStrictEqual(plain(plan.shortBefore), { Rifle: 200 });
    assert.strictEqual(plan.covered, false);
});

t.test('planSupply: a wave key that is not in the inventory is listed as missing', function () {
    var s = setup({ free: { Rifle: 10 }, fighters: [A.fighter({ uid: 'g1' })] });
    var plan = s.army.planSupply(
        [{ key: 'nope', army: { Rifle: 5 } }, { key: 'g1', army: { Rifle: 5 } }],
        s.army.inventory());
    assert.deepStrictEqual(plain(plan.missing), ['nope']);
    assert.deepStrictEqual(plain(plan.lines.map(function (l) { return l.key; })), ['g1']);
});

// ---- troopCapacity ------------------------------------------------------------

t.test('troopCapacity prefers GetMaxMilitaryUnits over the description', function () {
    var s = setup();
    var spec = A.fighter({ uid: 'g1', maxUnits: 400, descMax: 300 });
    assert.strictEqual(s.S.core.specialists.troopCapacity(spec), 400);
});

t.test('troopCapacity falls back to the description when GetMaxMilitaryUnits is absent or 0', function () {
    var s = setup();
    assert.strictEqual(s.S.core.specialists.troopCapacity(A.fighter({ uid: 'g1', descMax: 300 })), 300);
    assert.strictEqual(s.S.core.specialists.troopCapacity(A.fighter({ uid: 'g2', maxUnits: 0, descMax: 300 })), 300);
    assert.strictEqual(s.S.core.specialists.troopCapacity(A.fighter({ uid: 'g3' })), 0);
});
