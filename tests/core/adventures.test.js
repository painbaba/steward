'use strict';

var t = require('../runner');
var harness = require('../harness');
var A = require('../stubs/army');
var AC = require('../stubs/actions');

var assert = t.assert;

function plain(v) { return JSON.parse(JSON.stringify(v)); }

// ADN labels differ from the name by default; names listed in `unlabelled`
// come back unchanged like an unknown key (a label may equal its name).
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
    assert.strictEqual(s.adv.isSelectable(def({ label: 'x undefined y' })), false);
});

t.test('isSelectable: a label equal to the name is offered', function () {
    var s = setup();
    assert.strictEqual(s.adv.isSelectable(def({ name: 'Traitors', label: 'Traitors' })), true);
});

t.test('isSelectable: a def without a string name is hidden and does not throw', function () {
    var s = setup();
    assert.strictEqual(s.adv.isSelectable(def({ name: undefined })), false);
    assert.strictEqual(s.adv.isSelectable(def({ name: null })), false);
    assert.strictEqual(s.adv.isSelectable(def({ name: 5 })), false);
});

t.test('definitions: an entry without a name is skipped with one warning', function () {
    var s = setup({ adventureDefs: [A.adventureDef({ name: 'AdvA' })] });
    var good = s.H.host.game.def('AdventureSystem::cAdventureDefinition').map_AdventureName_AdventureDefinition.valueSet()[0];
    var prev = s.H.host.game.def;
    s.H.host.game.def = function (n) {
        if (n === 'AdventureSystem::cAdventureDefinition') {
            return { map_AdventureName_AdventureDefinition: { valueSet: function () { return [{ mName_string: undefined }, good]; } } };
        }
        return prev(n);
    };
    assert.deepStrictEqual(plain(s.adv.definitions().map(function (d) { return d.name; })), ['AdvA']);
    var warns = s.H.logs().filter(function (l) { return l.level === 'warn'; });
    assert.strictEqual(warns.length, 1);
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

// ---- selectable ------------------------------------------------------------------

t.test('selectable: one list sorted by label, ties by name', function () {
    var s = setup();
    var list = [
        def({ name: 'N3', label: 'B' }),
        def({ name: 'N2', label: 'a x' }),
        def({ name: 'N1', label: 'a x' }),
        def({ name: 'N4', label: 'C' })
    ];
    var out = plain(s.adv.selectable(list));
    assert.deepStrictEqual(out.map(function (d) { return d.name; }), ['N1', 'N2', 'N3', 'N4']);
});

t.test('selectable: unselectable definitions are left out', function () {
    var s = setup();
    var list = [
        def({ name: 'S1', label: 'L S1', type: 'Scenario' }),
        def({ name: 'C1', label: 'L C1', type: 'Coop' }),
        def({ name: 'E1', label: 'L E1', requiresEvent: true })
    ];
    assert.deepStrictEqual(plain(s.adv.selectable(list)), []);
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

t.test('own lists names with zone ids', function () {
    var s = setup();
    var advs = [
        { adventureName: 'AdvA', zoneID: 11, mine: true },
        { adventureName: 'AdvB', zoneID: 12, mine: false },
        { adventureName: 'AdvC', zoneID: 13, mine: true }
    ];
    withManager(s, {
        getAdventures: function () { return advs; },
        isMyAdventure: function (adv) { return adv.mine; }
    });
    assert.deepStrictEqual(plain(s.adv.own()), [{ name: 'AdvA', zoneId: 11 }, { name: 'AdvC', zoneId: 13 }]);
    assert.strictEqual(s.adv.zoneIdOf('AdvC'), 13);
    assert.strictEqual(s.adv.zoneIdOf('AdvB'), null);
});

t.test('own returns null when the manager cannot be read', function () {
    var s = setup();
    withManager(s, null);
    assert.strictEqual(s.adv.own(), null);
    withManager(s, { getAdventures: function () { throw new Error('boom'); } });
    assert.strictEqual(s.adv.own(), null);
    assert.strictEqual(s.adv.zoneIdOf('AdvA'), null);
    withManager(s, { getAdventures: function () { return []; }, isMyAdventure: function () { return true; } });
    assert.deepStrictEqual(plain(s.adv.own()), []);
});

t.test('ownOpen unchanged (empty on a failed read)', function () {
    var s = setup();
    withManager(s, { getAdventures: function () { throw new Error('boom'); } });
    assert.deepStrictEqual(plain(s.adv.ownOpen()), []);
});

// ---- close -----------------------------------------------------------------------

function closable(s) {
    var st = { advs: [{ adventureName: 'AdvA', zoneID: 11 }, { adventureName: 'AdvB', zoneID: 12 }], removed: [], broken: false };
    withManager(s, {
        getAdventures: function () { if (st.broken) throw new Error('boom'); return st.advs; },
        isMyAdventure: function () { return true; },
        removeAdventure: function (id) {
            st.removed.push(id);
            st.advs = st.advs.filter(function (a) { return a.zoneID !== id; });
        }
    });
    return st;
}

function run(s, def, onStep) {
    var res = null;
    s.S.core.actions.attempt(def, function (r) { res = r; });
    AC.drive(s.H, { onStep: onStep });
    return res;
}

t.test('close sends removeAdventure with the zone id and verifies when gone', function () {
    var s = setup();
    var st = closable(s);
    var res = run(s, s.adv.close('AdvA'));
    assert.strictEqual(res.status, s.S.ActionResult.Verified);
    assert.strictEqual(res.sends, 1);
    assert.deepStrictEqual(st.removed, [11]);
});

t.test('close refuses an adventure that is not open', function () {
    var s = setup();
    var st = closable(s);
    var res = run(s, s.adv.close('Nope'));
    assert.strictEqual(res.status, s.S.ActionResult.Refused);
    assert.strictEqual(res.reason, 'adventure not open');
    assert.strictEqual(st.removed.length, 0);
});

t.test('close does not verify while the manager cannot be read', function () {
    var s = setup();
    var st = closable(s);
    var res = run(s, s.adv.close('AdvA'), function (n) { if (n === 1) st.broken = true; });
    assert.strictEqual(res.status, s.S.ActionResult.Failed);
});

t.test('close refuses when the zone id is unreadable and never verifies', function () {
    var s = setup();
    var st = closable(s);
    st.advs = [{ adventureName: 'AdvA' }];
    var res = run(s, s.adv.close('AdvA'));
    assert.strictEqual(res.status, s.S.ActionResult.Refused);
    assert.strictEqual(res.reason, 'adventure zone id unreadable');
    assert.strictEqual(st.removed.length, 0);
});

t.test('close check is false without a numeric baseline zone id', function () {
    var s = setup();
    closable(s);
    var def = s.adv.close('AdvA');
    assert.strictEqual(def.check({ zoneId: null }), false);
    assert.strictEqual(def.check(null), false);
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
