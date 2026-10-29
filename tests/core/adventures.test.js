'use strict';

var t = require('../runner');
var harness = require('../harness');
var A = require('../stubs/army');

var assert = t.assert;

function plain(v) { return JSON.parse(JSON.stringify(v)); }

// ADN labels differ from the name, so isSelectable sees a real label; the
// names listed in `unlabelled` come back unchanged like an unknown key.
function loca(unlabelled) {
    return function (cat, key) {
        if (unlabelled && unlabelled.indexOf(key) !== -1) return key;
        if (cat === 'ADN') return 'Label ' + key;
        if (cat === 'LAB') return 'Camp ' + key.replace('Campaign_', '');
        return key;
    };
}

function setup(o, unlabelled) {
    var H = harness.boot();
    H.host.loca.GetText = loca(unlabelled);
    A.install(H, o || {});
    return { H: H, S: H.Steward, adv: H.Steward.core.adventures };
}

function def(extra) {
    var d = { name: 'Adv', label: 'Label Adv', type: 'Attack', campaign: 'None', difficulty: 1, requiresEvent: false };
    for (var k in (extra || {})) d[k] = extra[k];
    return d;
}

function defs() {
    return [
        A.adventureDef({ name: 'AdvB', difficulty: 2 }),
        A.adventureDef({ name: 'AdvA', difficulty: 2 })
    ];
}

// ---- definitions ---------------------------------------------------------------

t.test('definitions: read through valueSet() returning an array', function () {
    var s = setup({ adventureDefs: defs(), adventureForm: 'array' });
    var list = s.adv.definitions();
    assert.deepStrictEqual(plain(list.map(function (d) { return d.name; })), ['AdvB', 'AdvA']);
    assert.strictEqual(list[0].label, 'Label AdvB');
    assert.strictEqual(list[0].type, 'Attack');
    assert.strictEqual(list[0].difficulty, 2);
});

t.test('definitions: read through valueSet() returning a keyed object', function () {
    var s = setup({ adventureDefs: defs(), adventureForm: 'object' });
    assert.deepStrictEqual(plain(s.adv.definitions().map(function (d) { return d.name; })).sort(), ['AdvA', 'AdvB']);
});

t.test('definitions: read by enumerating a map without valueSet()', function () {
    var s = setup({ adventureDefs: defs(), adventureForm: 'plain' });
    assert.deepStrictEqual(plain(s.adv.definitions().map(function (d) { return d.name; })).sort(), ['AdvA', 'AdvB']);
});

t.test('definitions: a failing map gives an empty list', function () {
    var s = setup();
    s.H.host.game.def = function () {
        var o = {};
        Object.defineProperty(o, 'map_AdventureName_AdventureDefinition', {
            get: function () { throw new Error('boom'); }
        });
        return o;
    };
    assert.deepStrictEqual(plain(s.adv.definitions()), []);
});

t.test('definitions: a missing definition class gives an empty list', function () {
    var s = setup();
    assert.deepStrictEqual(plain(s.adv.definitions()), []);
});

// ---- isSelectable ----------------------------------------------------------------

t.test('isSelectable: a plain attack adventure with a label is offered', function () {
    var s = setup();
    assert.strictEqual(s.adv.isSelectable(def()), true);
});

t.test('isSelectable: event-gated adventures are hidden', function () {
    var s = setup();
    assert.strictEqual(s.adv.isSelectable(def({ requiresEvent: true })), false);
});

t.test('isSelectable: expedition adventures are hidden', function () {
    var s = setup();
    assert.strictEqual(s.adv.isSelectable(def({ name: 'SomeExpeditionX' })), false);
});

t.test('isSelectable: an adventure without a real label is hidden', function () {
    var s = setup();
    assert.strictEqual(s.adv.isSelectable(def({ label: '' })), false);
    assert.strictEqual(s.adv.isSelectable(def({ label: 'Adv' })), false);
    assert.strictEqual(s.adv.isSelectable(def({ label: 'x undefined y' })), false);
});

t.test('isSelectable: Scenario and Coop without a campaign are hidden', function () {
    var s = setup();
    assert.strictEqual(s.adv.isSelectable(def({ type: 'Scenario' })), false);
    assert.strictEqual(s.adv.isSelectable(def({ type: 'Coop' })), false);
    assert.strictEqual(s.adv.isSelectable(def({ type: 'Scenario', campaign: 'None' })), false);
});

t.test('isSelectable: a Scenario-type definition inside a campaign is kept', function () {
    var s = setup();
    assert.strictEqual(s.adv.isSelectable(def({ type: 'Scenario', campaign: 'Foo' })), true);
});

// ---- groups ----------------------------------------------------------------------

t.test('groups: sorted by difficulty then name, grouped in order of first appearance', function () {
    var s = setup();
    var list = [
        def({ name: 'Z1', label: 'L Z1', type: 'Attack', difficulty: 3 }),
        def({ name: 'B1', label: 'L B1', type: 'Attack', difficulty: 1 }),
        def({ name: 'C1', label: 'L C1', type: 'Other', difficulty: 2 }),
        def({ name: 'A1', label: 'L A1', type: 'Attack', difficulty: 3 })
    ];
    var g = plain(s.adv.groups(list));
    assert.deepStrictEqual(g.map(function (x) { return x.group; }), ['Attack', 'Other']);
    assert.deepStrictEqual(g[0].items.map(function (d) { return d.name; }), ['B1', 'A1', 'Z1']);
    assert.deepStrictEqual(g[1].items.map(function (d) { return d.name; }), ['C1']);
});

t.test('groups: an adventure with a campaign is grouped under the campaign label', function () {
    var s = setup();
    var list = [
        def({ name: 'K1', label: 'L K1', campaign: 'Foo', type: 'Scenario', difficulty: 1 }),
        def({ name: 'K2', label: 'L K2', campaign: 'Foo', type: 'Attack', difficulty: 2 }),
        def({ name: 'N1', label: 'L N1', difficulty: 3 })
    ];
    var g = plain(s.adv.groups(list));
    assert.deepStrictEqual(g.map(function (x) { return x.group; }), ['Camp Foo', 'Attack']);
    assert.deepStrictEqual(g[0].items.map(function (d) { return d.name; }), ['K1', 'K2']);
});

t.test('groups: unselectable definitions are left out and Scenario/Coop do not form groups', function () {
    var s = setup();
    var list = [
        def({ name: 'S1', label: 'L S1', type: 'Scenario' }),
        def({ name: 'C1', label: 'L C1', type: 'Coop' }),
        def({ name: 'E1', label: 'L E1', requiresEvent: true })
    ];
    assert.deepStrictEqual(plain(s.adv.groups(list)), []);
});

t.test('label: resolves through the ADN locale category', function () {
    var s = setup();
    assert.strictEqual(s.adv.label('AdvA'), 'Label AdvA');
});

// ---- ownOpen ---------------------------------------------------------------------

function withManager(s, mgr) {
    var prev = s.H.host.game.def;
    s.H.host.game.def = function (name) {
        if (name === 'com.bluebyte.tso.adventure.logic::AdventureManager') {
            return mgr ? { getInstance: function () { return mgr; } } : null;
        }
        return prev(name);
    };
}

t.test('ownOpen lists only own adventures', function () {
    var s = setup();
    var advs = [
        { adventureName: 'AdvA', mine: true },
        { adventureName: 'AdvB', mine: false },
        { adventureName: 'AdvC', mine: true }
    ];
    withManager(s, {
        getAdventures: function () { return advs; },
        isMyAdventure: function (adv) { return adv.mine; }
    });
    assert.deepStrictEqual(plain(s.adv.ownOpen()), ['AdvA', 'AdvC']);
});

t.test('ownOpen is empty when the manager is missing', function () {
    var s = setup();
    withManager(s, null);
    assert.deepStrictEqual(plain(s.adv.ownOpen()), []);
});

// ---- manager ---------------------------------------------------------------------

t.test('manager returns the host instance', function () {
    var s = setup();
    var mgr = { getAdventures: function () { return []; } };
    withManager(s, mgr);
    assert.strictEqual(s.adv.manager(), mgr);
});

t.test('manager is null when the class is missing', function () {
    var s = setup();
    withManager(s, null);
    assert.strictEqual(s.adv.manager(), null);
    assert.strictEqual(s.H.logs().length, 0);
});
