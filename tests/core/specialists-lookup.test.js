'use strict';

var t = require('../runner');
var harness = require('../harness');

function spec(key) {
    return {
        GetUniqueID: function () { return { toKeyString: function () { return key; } }; }
    };
}

function zoneOf(list) {
    return { GetSpecialists_vector: function () { return list; } };
}

t.test('lookup finds a specialist by uid key', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var a = spec('k1');
    var b = spec('k2');
    var r = H.Steward.core.specialists.lookup('k2', { zone: zoneOf([a, b]) });
    t.assert.strictEqual(r.ok, true);
    t.assert.strictEqual(r.spec, b);
});

t.test('lookup reports not listed after a good read', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var L = H.Steward.core.specialists.lookup;
    var r = L('nope', { zone: zoneOf([spec('k1')]) });
    t.assert.strictEqual(r.ok, true);
    t.assert.strictEqual(r.spec, null);
    r = L('k1', { zone: zoneOf([]) });
    t.assert.strictEqual(r.ok, true);
    t.assert.strictEqual(r.spec, null);
    r = L('', { zone: zoneOf([spec('k1')]) });
    t.assert.strictEqual(r.ok, true);
    t.assert.strictEqual(r.spec, null);
    r = L(5, { zone: zoneOf([spec('k1')]) });
    t.assert.strictEqual(r.ok, true);
    t.assert.strictEqual(r.spec, null);
});

t.test('lookup reports a failed read when the zone or vector is missing or throws', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var L = H.Steward.core.specialists.lookup;
    var bad = [
        {},
        { GetSpecialists_vector: function () { return null; } },
        { GetSpecialists_vector: function () { throw new Error('boom'); } }
    ];
    for (var i = 0; i < bad.length; i++) {
        var r = L('k1', { zone: bad[i] });
        t.assert.strictEqual(r.ok, false);
        t.assert.strictEqual(r.spec, null);
    }
    var r2 = L('k1', { zone: null });
    t.assert.strictEqual(r2.ok, false);
});

t.test('all still returns an empty array on a failed read', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var all = H.Steward.core.specialists.all;
    t.assert.strictEqual(all({ zone: {} }).length, 0);
    t.assert.strictEqual(all({ zone: { GetSpecialists_vector: function () { return null; } } }).length, 0);
    t.assert.strictEqual(all({ zone: { GetSpecialists_vector: function () { throw new Error('x'); } } }).length, 0);
    t.assert.strictEqual(all({ zone: zoneOf([spec('a')]) }).length, 1);
});

t.test('refind returns the spec with no reason', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var a = spec('k1');
    var r = H.Steward.core.specialists.refind('k1', { zone: zoneOf([a]) });
    t.assert.strictEqual(r.spec, a);
    t.assert.strictEqual(r.reason, null);
});

t.test('refind refuses a failed read as specialist unreadable', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var r = H.Steward.core.specialists.refind('k1', { zone: {} });
    t.assert.strictEqual(r.spec, null);
    t.assert.strictEqual(r.reason, 'specialist unreadable');
});

t.test('refind refuses an absent key as specialist not found', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var r = H.Steward.core.specialists.refind('nope', { zone: zoneOf([spec('k1')]) });
    t.assert.strictEqual(r.spec, null);
    t.assert.strictEqual(r.reason, 'specialist not found');
});
