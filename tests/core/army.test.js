'use strict';

var t = require('../runner');
var harness = require('../harness');
var A = require('../stubs/army');
var specStubs = require('../stubs/specialists');
var AC = require('../stubs/actions');

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

// ---- text -------------------------------------------------------------------

t.test('text: sorted, zero amounts skipped, localised names with key fallback', function () {
    var s = setup();
    s.S.core.locale.res = function (key) { return key === 'Rifle' ? 'Riflemen' : null; };
    assert.strictEqual(s.army.text({ Sabre: 3, Rifle: 12, Bow: 0 }), '12 Riflemen, 3 Sabre');
});

t.test('text: an empty or missing army reads as a dash', function () {
    var s = setup();
    assert.strictEqual(s.army.text({}), '—');
    assert.strictEqual(s.army.text({ Rifle: 0 }), '—');
    assert.strictEqual(s.army.text(null), '—');
    assert.strictEqual(s.army.text(), '—');
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

function surplusWorld(g2army) {
    return setup({
        free: { Rifle: 20, Sabre: 50 },
        fighters: [
            A.fighter({ uid: 'g1', army: {} }),
            A.fighter({ uid: 'g2', army: g2army })
        ]
    });
}

t.test('planSupply: with surplus on, an in-wave general holding a short type donates and need counts his full want', function () {
    var s = surplusWorld({ Rifle: 80 });
    var wave = [{ key: 'g1', army: { Rifle: 100 } }, { key: 'g2', army: { Sabre: 50 } }];
    var plan = s.army.planSupply(wave, s.army.inventory(), { surplus: true });
    assert.deepStrictEqual(plain(plan.donors.map(function (d) { return d.key; })), ['g2']);
    assert.deepStrictEqual(plain(plan.donors[0].army), { Rifle: 80 });
    assert.deepStrictEqual(plain(plan.need), { Rifle: 100, Sabre: 50 });
    assert.deepStrictEqual(plain(plan.shortAfter), {});
    assert.strictEqual(plan.covered, true);
});

t.test('planSupply: surplus counts what a wave general reuses as his own', function () {
    var s = surplusWorld({ Rifle: 80 });
    var wave = [{ key: 'g1', army: { Rifle: 100 } }, { key: 'g2', army: { Rifle: 30 } }];
    var plan = s.army.planSupply(wave, s.army.inventory(), { surplus: true });
    assert.deepStrictEqual(plain(plan.donors.map(function (d) { return d.key; })), ['g2']);
    assert.deepStrictEqual(plain(plan.need), { Rifle: 130 });
    assert.deepStrictEqual(plain(plan.shortAfter), { Rifle: 30 });
    assert.strictEqual(plan.covered, false);
});

t.test('planSupply: outside donors go before a wave general\'s surplus', function () {
    var s = setup({
        free: { Rifle: 20, Sabre: 10 },
        fighters: [
            A.fighter({ uid: 'g1', army: {} }),
            A.fighter({ uid: 'g2', army: { Rifle: 150 } }),
            A.fighter({ uid: 'd1', army: { Rifle: 80 } })
        ]
    });
    var wave = [{ key: 'g1', army: { Rifle: 100 } }, { key: 'g2', army: { Sabre: 10 } }];
    var plan = s.army.planSupply(wave, s.army.inventory(), { surplus: true });
    assert.deepStrictEqual(plain(plan.donors.map(function (d) { return d.key; })), ['d1']);
    assert.strictEqual(plan.covered, true);
});

t.test('planSupply: surplus skips a busy, travelling or matching wave general', function () {
    var s = setup({
        free: {},
        fighters: [
            A.fighter({ uid: 'g1', army: {} }),
            A.fighter({ uid: 'busy', task: specStubs.task(1, 0, 1000), army: { Rifle: 80 } }),
            A.fighter({ uid: 'away', travelling: true, army: { Rifle: 80 } }),
            A.fighter({ uid: 'same', army: { Rifle: 80 } })
        ]
    });
    var wave = [
        { key: 'g1', army: { Rifle: 100 } },
        { key: 'busy', army: {} },
        { key: 'away', army: {} },
        { key: 'same', army: { Rifle: 80 } }
    ];
    var plan = s.army.planSupply(wave, s.army.inventory(), { surplus: true });
    assert.deepStrictEqual(plain(plan.donors), []);
    assert.deepStrictEqual(plain(plan.need), { Rifle: 100 });
    assert.strictEqual(plan.covered, false);
});

t.test('planSupply: surplus with reuseOwn false offers his whole army and need stays', function () {
    var s = surplusWorld({ Rifle: 80 });
    var wave = [{ key: 'g1', army: { Rifle: 100 } }, { key: 'g2', army: { Rifle: 30 } }];
    var plan = s.army.planSupply(wave, s.army.inventory(), { surplus: true, reuseOwn: false });
    assert.deepStrictEqual(plain(plan.donors.map(function (d) { return d.key; })), ['g2']);
    assert.deepStrictEqual(plain(plan.donors[0].army), { Rifle: 80 });
    assert.deepStrictEqual(plain(plan.need), { Rifle: 130 });
    assert.deepStrictEqual(plain(plan.shortAfter), { Rifle: 30 });
});

t.test('planSupply: without the option a wave general\'s surplus stays out', function () {
    var s = surplusWorld({ Rifle: 80 });
    var wave = [{ key: 'g1', army: { Rifle: 100 } }, { key: 'g2', army: { Sabre: 50 } }];
    var plan = s.army.planSupply(wave, s.army.inventory());
    assert.deepStrictEqual(plain(plan.donors), []);
    assert.strictEqual(plan.covered, false);
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

// ---- canUnload / readGeneralArmy -----------------------------------------------

t.test('readGeneralArmy returns null on a throw and generalArmy {}', function () {
    var s = setup({ fighters: [] });
    var g = AC.general({ uid: 'g1', army: { Rifle: 5 }, throwOn: 'GetArmy' });
    assert.strictEqual(s.army.readGeneralArmy(g), null);
    assert.strictEqual(s.army.readGeneralArmy(null), null);
    assert.deepStrictEqual(plain(s.army.generalArmy(g)), {});
    g.state.throwOn = null;
    assert.deepStrictEqual(plain(s.army.readGeneralArmy(g)), { Rifle: 5 });
});

t.test('canUnload: own, idle, home, not travelling and holding troops', function () {
    var s = setup({ fighters: [] });
    assert.strictEqual(s.army.canUnload(A.fighter({ uid: 'ok', army: { Rifle: 5 } })), true);
    assert.strictEqual(s.army.canUnload(A.fighter({ uid: 'other', playerId: 2, army: { Rifle: 5 } })), false);
    assert.strictEqual(s.army.canUnload(A.fighter({ uid: 'away', travelling: true, army: { Rifle: 5 } })), false);
    assert.strictEqual(s.army.canUnload(A.fighter({ uid: 'star', grid: -1, army: { Rifle: 5 } })), false);
    assert.strictEqual(s.army.canUnload(A.fighter({ uid: 'bare', army: {} })), false);
    assert.strictEqual(s.army.canUnload(null), false);
});

t.test('donorOk unchanged after the extraction: a failing getter is warned about once', function () {
    var g = AC.general({ uid: 'g1', army: { Rifle: 5 }, throwOn: 'GetGarrisonGridIdx' });
    var s = setup({ fighters: [g] });
    var before = s.H.logs().length;
    var by = s.army.inventory().byKey;
    assert.strictEqual(by.g1.donorOk, false);
    var warns = s.H.logs().slice(before).filter(function (l) {
        return l.level === 'warn' && /garrisonGrid/.test(JSON.stringify(l));
    });
    assert.strictEqual(warns.length, 1);
});

// ---- raise and unload defs -------------------------------------------------------

// Booted harness with the action wiring. o.free / o.generals as for install.
function actionSetup(o) {
    var generals = o.generals || [];
    var H = harness.boot();
    A.install(H, { units: UNITS, free: o.free || {}, fighters: generals });
    var sent = AC.wire(H);
    var util = sent.registerDef('MilitarySystem::cMilitaryUtil', {
        SendRaiseArmyToServer: function () { if (o.onUnload) o.onUnload(); }
    });
    return { H: H, S: H.Steward, army: H.Steward.core.army, sent: sent, util: util };
}

function runDef(s, def, onStep) {
    var result = null;
    assert.strictEqual(s.S.core.actions.attempt(def, function (r) { result = r; }), true);
    AC.drive(s.H, { onStep: onStep });
    return result;
}

t.test('raise sends 1031 with the full target composition', function () {
    var g = AC.general({ uid: 'g1', army: { Rifle: 5 } });
    var s = actionSetup({ free: { Rifle: 100, Sabre: 10 }, generals: [g] });
    var r = runDef(s, s.army.raise('g1', { Rifle: 60, Sabre: 2 }), function (n) {
        if (n === 1) g.state.army = { Rifle: 60, Sabre: 2 };
    });
    assert.strictEqual(r.status, s.S.ActionResult.Verified);
    assert.strictEqual(r.sends, 1);
    assert.strictEqual(s.sent.messages.length, 1);
    var m = s.sent.messages[0];
    assert.strictEqual(m.id, 1031);
    assert.strictEqual(m.data.armyHolderSpecialistVO.uid, 'g1');
    assert.deepStrictEqual(plain(m.data.unitSquads.items.map(function (i) { return [i.name_string, i.amount]; })),
        [['Rifle', 60], ['Sabre', 2]]);
});

t.test('raise refuses mixed, over capacity, uncovered', function () {
    var g = AC.general({ uid: 'g1', army: {}, maxUnits: 10 });
    var s = actionSetup({ free: { Rifle: 3, EliteRifle: 3 }, generals: [g] });
    var mixed = runDef(s, s.army.raise('g1', { Rifle: 1, EliteRifle: 1 }));
    assert.strictEqual(mixed.status, s.S.ActionResult.Refused);
    assert.ok(/Mixed/.test(mixed.reason));
    var over = runDef(s, s.army.raise('g1', { Rifle: 20 }));
    assert.strictEqual(over.status, s.S.ActionResult.Refused);
    assert.ok(/capacity/.test(over.reason));
    var short = runDef(s, s.army.raise('g1', { Rifle: 5 }));
    assert.strictEqual(short.status, s.S.ActionResult.Refused);
    assert.ok(/free pool/.test(short.reason));
    assert.strictEqual(s.sent.messages.length, 0);
});

t.test('raise refuses an empty target', function () {
    var g = AC.general({ uid: 'g1', army: {} });
    var s = actionSetup({ free: { Rifle: 5 }, generals: [g] });
    var r = runDef(s, s.army.raise('g1', {}));
    assert.strictEqual(r.status, s.S.ActionResult.Refused);
    assert.strictEqual(r.reason, 'empty target: use unload');
    assert.strictEqual(r.sends, 0);
    assert.strictEqual(s.sent.messages.length, 0);
});

// The client has no garrison for a general at the star, so a raise there is
// refused before the packet; the same general on a map grid passes.
t.test('raise refuses a general at the star with no garrison; on a grid it passes the precheck', function () {
    var g = AC.general({ uid: 'g1', grid: 0, army: {}, maxUnits: 10 });
    var s = actionSetup({ free: { Rifle: 5 }, generals: [g] });
    var r = runDef(s, s.army.raise('g1', { Rifle: 5 }));
    assert.strictEqual(r.status, s.S.ActionResult.Refused);
    assert.strictEqual(r.reason, 'no garrison');
    assert.strictEqual(r.sends, 0);
    assert.strictEqual(s.sent.messages.length, 0);
    g.state.grid = 5;
    r = runDef(s, s.army.raise('g1', { Rifle: 5 }), function (n) {
        if (n === 1) g.state.army = { Rifle: 5 };
    });
    assert.strictEqual(r.status, s.S.ActionResult.Verified);
    assert.strictEqual(s.sent.messages.length, 1);
});

t.test('raise verified when the army matches', function () {
    var done = AC.general({ uid: 'g1', army: { Rifle: 5 } });
    var s = actionSetup({ free: {}, generals: [done] });
    var already = runDef(s, s.army.raise('g1', { Rifle: 5 }));
    assert.strictEqual(already.status, s.S.ActionResult.Verified);
    assert.strictEqual(already.sends, 0);

    var late = AC.general({ uid: 'g2', army: { Rifle: 1 } });
    var s2 = actionSetup({ free: { Rifle: 10 }, generals: [late] });
    var r = runDef(s2, s2.army.raise('g2', { Rifle: 5 }), function (n) {
        if (n === 3) late.state.army = { Rifle: 5 };
    });
    assert.strictEqual(r.status, s2.S.ActionResult.Verified);
    assert.strictEqual(r.sends, 1);
});

t.test('raise fails after exactly two sends when the army never matches or cannot be read', function () {
    var g = AC.general({ uid: 'g1', army: {} });
    var s = actionSetup({ free: { Rifle: 10 }, generals: [g] });
    var never = runDef(s, s.army.raise('g1', { Rifle: 5 }));
    assert.strictEqual(never.status, s.S.ActionResult.Failed);
    assert.strictEqual(never.sends, 2);
    assert.strictEqual(s.sent.messages.length, 2);

    var g2 = AC.general({ uid: 'g2', army: {} });
    var s2 = actionSetup({ free: { Rifle: 10 }, generals: [g2] });
    var r = runDef(s2, s2.army.raise('g2', { Rifle: 5 }), function (n) {
        if (n === 1) g2.state.throwOn = 'GetArmy';
    });
    assert.notStrictEqual(r.status, s2.S.ActionResult.Verified);
});

t.test('raise and unload refuse a missing specialist', function () {
    var s = actionSetup({ free: { Rifle: 10 }, generals: [AC.general({ uid: 'g1' })] });
    var a = runDef(s, s.army.raise('nope', { Rifle: 5 }));
    var b = runDef(s, s.army.unload('nope'));
    assert.strictEqual(a.status, s.S.ActionResult.Refused);
    assert.strictEqual(a.reason, 'specialist not found');
    assert.strictEqual(b.status, s.S.ActionResult.Refused);
    assert.strictEqual(b.reason, 'specialist not found');
    assert.strictEqual(a.sends + b.sends, 0);

    s.H.host.game.gi.mCurrentPlayerZone.GetSpecialists_vector = function () { throw new Error('list'); };
    var c = runDef(s, s.army.raise('g1', { Rifle: 5 }));
    assert.strictEqual(c.status, s.S.ActionResult.Refused);
    assert.strictEqual(c.reason, 'specialist unreadable');
});

t.test('unload is not satisfied when the army read throws', function () {
    var g = AC.general({ uid: 'g1', army: { Rifle: 5 }, throwOn: 'GetArmy' });
    var s = actionSetup({ free: {}, generals: [g] });
    var r = runDef(s, s.army.unload('g1'));
    assert.notStrictEqual(r.status, s.S.ActionResult.Verified);
    assert.strictEqual(r.sends, 0);
});

t.test('unload does not verify while the army cannot be read', function () {
    var g = AC.general({ uid: 'g1', army: { Rifle: 5 } });
    var s = actionSetup({ free: {}, generals: [g], onUnload: function () { g.state.army = {}; g.state.throwOn = 'GetArmy'; } });
    var r = runDef(s, s.army.unload('g1'));
    assert.notStrictEqual(r.status, s.S.ActionResult.Verified);
    assert.strictEqual(r.status, s.S.ActionResult.Failed);

    var stuck = AC.general({ uid: 'g2', army: { Rifle: 5 } });
    var s2 = actionSetup({ free: {}, generals: [stuck] });
    var r2 = runDef(s2, s2.army.unload('g2'));
    assert.strictEqual(r2.status, s2.S.ActionResult.Failed);
    assert.strictEqual(r2.sends, 2);
});

t.test('unload uses SendRaiseArmyToServer with null', function () {
    var g = AC.general({ uid: 'g1', army: { Rifle: 5 } });
    var s = actionSetup({ free: {}, generals: [g], onUnload: function () { g.state.army = {}; } });
    runDef(s, s.army.unload('g1'));
    var calls = s.sent.calls.filter(function (c) { return c.method === 'SendRaiseArmyToServer'; });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].target, 'MilitarySystem::cMilitaryUtil');
    assert.strictEqual(calls[0].args[0], s.H.host.game.gi);
    assert.strictEqual(calls[0].args[1], g);
    assert.strictEqual(calls[0].args[2], null);
    assert.strictEqual(s.sent.messages.length, 0);
});

t.test('unload verified when the army is empty', function () {
    var g = AC.general({ uid: 'g1', army: { Rifle: 5 } });
    var s = actionSetup({ free: {}, generals: [g], onUnload: function () { g.state.army = {}; } });
    var r = runDef(s, s.army.unload('g1'));
    assert.strictEqual(r.status, s.S.ActionResult.Verified);
    assert.strictEqual(r.sends, 1);

    var empty = AC.general({ uid: 'g2', army: {} });
    var s2 = actionSetup({ free: {}, generals: [empty] });
    var already = runDef(s2, s2.army.unload('g2'));
    assert.strictEqual(already.status, s2.S.ActionResult.Verified);
    assert.strictEqual(already.sends, 0);
});

// ---- inventory().ok ------------------------------------------------------------

t.test('inventory: ok is true when the free pool, the list and every army are readable', function () {
    var s = setup({ free: { Rifle: 1 }, fighters: [A.fighter({ uid: 'g1', army: { Rifle: 2 } })] });
    var inv = s.army.inventory();
    assert.strictEqual(inv.ok, true);
    assert.strictEqual(inv.freeOk, true);
});

t.test('inventory: ok is false when the free pool is unreadable', function () {
    var s = setup({ fighters: [A.fighter({ uid: 'g1', army: { Rifle: 2 } })] });
    var inv = s.army.inventory();
    assert.strictEqual(inv.freeOk, false);
    assert.strictEqual(inv.ok, false);
});

t.test('inventory: ok is false when a general army is unreadable', function () {
    var g = AC.general({ uid: 'g1', army: { Rifle: 5 }, throwOn: 'GetArmy' });
    var s = setup({ free: { Rifle: 1 }, fighters: [g] });
    var inv = s.army.inventory();
    assert.strictEqual(inv.byKey.g1.armyOk, false);
    assert.strictEqual(inv.ok, false);
});

t.test('inventory: ok is false when the specialist list is unreadable', function () {
    var s = setup({ free: { Rifle: 1 }, fighters: [] });
    s.H.host.game.gi.mCurrentPlayerZone.GetSpecialists_vector = function () { throw new Error('list'); };
    assert.strictEqual(s.army.inventory().ok, false);
});

// ---- planPack -------------------------------------------------------------------

function eliteName(name) {
    if (name === 'Mystery') return null;
    return name.indexOf('Elite') === 0;
}

function pack(free, holders) {
    var s = setup({});
    return plain(s.army.planPack(free, holders, eliteName));
}

t.test('planPack: one class per holder, never both in one raise', function () {
    var r = pack({ Rifle: 10, EliteRifle: 4 }, [{ key: 'a', army: {}, capacity: 100 }]);
    assert.strictEqual(r.raises.length, 1);
    assert.strictEqual(Object.keys(r.raises[0].added).length, 1);
});

t.test('planPack: an Empty holder takes the larger class', function () {
    var base = pack({ Rifle: 10, EliteRifle: 4 }, [{ key: 'a', army: {}, capacity: 100 }]);
    assert.deepStrictEqual(base.raises[0].added, { Rifle: 10 });
    var elite = pack({ Rifle: 3, EliteRifle: 8 }, [{ key: 'a', army: {}, capacity: 100 }]);
    assert.deepStrictEqual(elite.raises[0].added, { EliteRifle: 8 });
});

t.test('planPack: a holder already holding Elite takes only Elite', function () {
    var r = pack({ Rifle: 50, EliteRifle: 4 }, [{ key: 'a', army: { EliteRifle: 2 }, capacity: 100 }]);
    assert.deepStrictEqual(r.raises[0].added, { EliteRifle: 4 });
    assert.deepStrictEqual(r.raises[0].target, { EliteRifle: 6 });
    assert.strictEqual(r.remainder.Rifle, 50);
    assert.strictEqual(r.remainder.EliteRifle || 0, 0);
});

t.test('planPack: capacity is respected and capacity 0 is skipped', function () {
    var r = pack({ Rifle: 50 }, [
        { key: 'zero', army: {}, capacity: 0 },
        { key: 'a', army: { Rifle: 5 }, capacity: 12 }
    ]);
    assert.strictEqual(r.raises.length, 1);
    assert.strictEqual(r.raises[0].key, 'a');
    assert.deepStrictEqual(r.raises[0].added, { Rifle: 7 });
});

t.test('planPack: holders are filled in the given order and the remainder is exact', function () {
    var r = pack({ Rifle: 15 }, [
        { key: 'first', army: {}, capacity: 10 },
        { key: 'second', army: {}, capacity: 10 }
    ]);
    assert.strictEqual(r.raises[0].key, 'first');
    assert.deepStrictEqual(r.raises[0].added, { Rifle: 10 });
    assert.strictEqual(r.raises[1].key, 'second');
    assert.deepStrictEqual(r.raises[1].added, { Rifle: 5 });
    assert.strictEqual(r.remainder.Rifle || 0, 0);
});

t.test('planPack: Mixed and Unknown holders are skipped', function () {
    var r = pack({ Rifle: 10 }, [
        { key: 'mixed', army: { Rifle: 1, EliteRifle: 1 }, capacity: 100 },
        { key: 'unknown', army: { Mystery: 1 }, capacity: 100 }
    ]);
    assert.strictEqual(r.raises.length, 0);
    assert.deepStrictEqual(r.remainder, { Rifle: 10 });
});

// ---- ghosts: entries whose members read undefined for a moment -------------------

function warnsOf(s, from) {
    return s.H.logs().slice(from).filter(function (l) { return l.level === 'warn'; });
}

t.test('isOwn is false for a ghost and for an unreadable owner, with no warning', function () {
    var s = setup({ fighters: [] });
    var g = A.fighter({ uid: 'g1', army: { Rifle: 1 } });
    var restore = specStubs.ghost(g);
    var before = s.H.logs().length;
    assert.strictEqual(s.army.isOwn(g), false);
    assert.strictEqual(s.army.isOwn(null), false);
    var mute = A.fighter({ uid: 'g2' });
    mute.getPlayerID = function () { return undefined; };
    assert.strictEqual(s.army.isOwn(mute), false);
    var thrower = A.fighter({ uid: 'g3' });
    thrower.getPlayerID = function () { throw new Error('boom'); };
    assert.strictEqual(s.army.isOwn(thrower), false);
    assert.strictEqual(warnsOf(s, before).length, 0);
    restore();
    assert.strictEqual(s.army.isOwn(g), true);
});

t.test('ownerOf: the player id, or null when it cannot be read', function () {
    var s = setup({ fighters: [] });
    assert.strictEqual(s.army.ownerOf(A.fighter({ uid: 'g1', playerId: 7 })), 7);
    assert.strictEqual(s.army.ownerOf(null), null);
    assert.strictEqual(s.army.ownerOf({}), null);
    var ghost = A.fighter({ uid: 'g2' });
    specStubs.ghost(ghost);
    assert.strictEqual(s.army.ownerOf(ghost), null);
    var mute = A.fighter({ uid: 'g3' });
    mute.getPlayerID = function () { return undefined; };
    assert.strictEqual(s.army.ownerOf(mute), null);
    var str = A.fighter({ uid: 'g4' });
    str.getPlayerID = function () { return '1'; };
    assert.strictEqual(s.army.ownerOf(str), null);
    var thrower = A.fighter({ uid: 'g5' });
    thrower.getPlayerID = function () { throw new Error('boom'); };
    assert.strictEqual(s.army.ownerOf(thrower), null);
});

t.test('ownReason: unreadable, not own, or null', function () {
    var s = setup({ playerId: 1, fighters: [] });
    var unreadable = s.S.core.specialists.UNREADABLE;
    var mute = A.fighter({ uid: 'g1' });
    mute.getPlayerID = function () { return undefined; };
    assert.strictEqual(s.army.ownReason(mute), unreadable);
    assert.strictEqual(s.army.ownReason(null), unreadable);
    assert.strictEqual(s.army.ownReason(A.fighter({ uid: 'g2', playerId: 2 })), 'not own');
    assert.strictEqual(s.army.ownReason(A.fighter({ uid: 'g3', playerId: 1 })), null);
});

t.test('readFighters: complete on a clean read, incomplete on a dropped or unreadable entry', function () {
    var s = setup({ fighters: [A.fighter({ uid: 'g1' }), A.fighter({ uid: 'theirs', playerId: 2 })] });
    var rf = s.army.readFighters();
    assert.strictEqual(rf.complete, true);
    assert.strictEqual(rf.list.length, 1);
    assert.strictEqual(s.army.fighters().length, 1);

    var ghost = A.fighter({ uid: 'g2' });
    specStubs.ghost(ghost);
    var d = setup({ fighters: [A.fighter({ uid: 'g1' }), ghost] });
    var drop = d.army.readFighters();
    assert.strictEqual(drop.complete, false);
    assert.strictEqual(drop.list.length, 1);

    var mute = A.fighter({ uid: 'g3' });
    mute.getPlayerID = function () { return undefined; };
    var m = setup({ fighters: [A.fighter({ uid: 'g1' }), mute] });
    var unread = m.army.readFighters();
    assert.strictEqual(unread.complete, false);
    assert.strictEqual(unread.list.length, 1);
});

t.test('inventory: listOk and ok are false on a read that dropped an entry', function () {
    var ghost = A.fighter({ uid: 'g2', army: { Rifle: 3 } });
    specStubs.ghost(ghost);
    var s = setup({ free: { Rifle: 1 }, fighters: [A.fighter({ uid: 'g1', army: { Rifle: 2 } }), ghost] });
    var inv = s.army.inventory();
    assert.strictEqual(inv.listOk, false);
    assert.strictEqual(inv.ok, false);
    assert.deepStrictEqual(Object.keys(inv.byKey), ['g1']);
});

t.test('inventory: listOk and ok are true on a clean read', function () {
    var s = setup({ free: { Rifle: 1 }, fighters: [A.fighter({ uid: 'g1', army: { Rifle: 2 } })] });
    var inv = s.army.inventory();
    assert.strictEqual(inv.listOk, true);
    assert.strictEqual(inv.ok, true);
});

t.test('inventory: an unreadable owner makes the read incomplete', function () {
    var mute = A.fighter({ uid: 'g2' });
    mute.getPlayerID = function () { return undefined; };
    var s = setup({ free: { Rifle: 1 }, fighters: [A.fighter({ uid: 'g1' }), mute] });
    var inv = s.army.inventory();
    assert.strictEqual(inv.listOk, false);
    assert.strictEqual(inv.ok, false);
});

t.test('inventory: a null uid key sets listOk false and leaves the entry out', function () {
    var g2 = A.fighter({ uid: 'g2' });
    // Each of generals() and carriers() reads the list, and the reader reads the
    // key once per entry; the third read is the one inventory makes itself.
    var calls = 0;
    g2.GetUniqueID = function () {
        calls++;
        return { toKeyString: function () { return calls <= 2 ? 'g2' : null; } };
    };
    var s = setup({ free: { Rifle: 1 }, fighters: [A.fighter({ uid: 'g1' }), g2] });
    var inv = s.army.inventory();
    assert.strictEqual(inv.listOk, false);
    assert.strictEqual(inv.ok, false);
    assert.deepStrictEqual(Object.keys(inv.byKey), ['g1']);
});

t.test('inventory: an entry that turns into a ghost after the fighter read is caught by the last sweep', function () {
    var g1 = A.fighter({ uid: 'g1', army: { Rifle: 2 } });
    var g2 = A.fighter({ uid: 'g2', army: { Rifle: 3 } });
    // g1 is already processed when g2's army is read, so only the final sweep
    // of the pass can notice that g1 flipped.
    g2.GetArmy = function () {
        specStubs.ghost(g1);
        return A.armyOf({ Rifle: 3 });
    };
    var s = setup({ free: { Rifle: 1 }, fighters: [g1, g2] });
    var inv = s.army.inventory();
    assert.strictEqual(inv.listOk, false);
    assert.strictEqual(inv.ok, false);
    assert.deepStrictEqual(Object.keys(inv.byKey).sort(), ['g1', 'g2']);
});

t.test('inventory: a thrown list leaves listOk true with ok false', function () {
    var s = setup({ free: { Rifle: 1 }, fighters: [] });
    s.H.host.game.gi.mCurrentPlayerZone.GetSpecialists_vector = function () { throw new Error('list'); };
    var inv = s.army.inventory();
    assert.strictEqual(inv.listOk, true);
    assert.strictEqual(inv.ok, false);
});

t.test('raise and unload report unreadable, not not own or cannot unload, for an owner flip', function () {
    var g = AC.general({ uid: 'g1', army: { Rifle: 5 } });
    var s = actionSetup({ free: { Rifle: 10 }, generals: [g] });
    g.getPlayerID = function () { return undefined; };
    var a = runDef(s, s.army.raise('g1', { Rifle: 8 }));
    var b = runDef(s, s.army.unload('g1'));
    assert.strictEqual(a.status, s.S.ActionResult.Refused);
    assert.strictEqual(a.reason, s.S.core.specialists.UNREADABLE);
    assert.strictEqual(b.status, s.S.ActionResult.Refused);
    assert.strictEqual(b.reason, s.S.core.specialists.UNREADABLE);
    assert.strictEqual(a.sends + b.sends, 0);
});

t.test('raise and unload keep the not own reason for a real foreign general', function () {
    var g = AC.general({ uid: 'g1', army: { Rifle: 5 }, playerId: 2 });
    var s = actionSetup({ free: { Rifle: 10 }, generals: [g] });
    assert.strictEqual(runDef(s, s.army.raise('g1', { Rifle: 8 })).reason, 'not own');
    assert.strictEqual(runDef(s, s.army.unload('g1')).reason, 'not own');
});
