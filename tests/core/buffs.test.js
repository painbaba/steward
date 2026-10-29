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
