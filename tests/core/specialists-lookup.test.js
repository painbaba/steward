'use strict';

var t = require('../runner');
var harness = require('../harness');

function spec(key) {
    return {
        GetType:     function () { return 1; },
        GetTask:     function () { return null; },
        getPlayerID: function () { return 1; },
        GetUniqueID: function () { return { toKeyString: function () { return key; } }; }
    };
}

function zoneOf(list) {
    return { GetSpecialists_vector: function () { return list; } };
}

// The same stub without one member, as the bridge hands it out for a moment.
function without(key, member) {
    var s = spec(key);
    delete s[member];
    return s;
}

function dropLines(H) {
    return H.logs().filter(function (l) {
        return l.category === 'specialists' && /^dropped /.test(String(l.args[0]));
    });
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

// ---- ghosts: entries the bridge hands out with members undefined ---------------

t.test('the reader drops an entry lacking any required member', function () {
    var members = ['GetType', 'GetUniqueID', 'getPlayerID', 'GetTask'];
    for (var i = 0; i < members.length; i++) {
        var H = harness.boot({ sections: ['kernel', 'core'] });
        var c = H.Steward.core.specialists;
        var good = spec('k1');
        var list = c.all({ zone: zoneOf([good, without('k2', members[i])]) });
        t.assert.strictEqual(list.length, 1, members[i]);
        t.assert.strictEqual(list[0], good, members[i]);
    }
});

t.test('the reader drops an entry whose uid key is null or whose member throws', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var c = H.Steward.core.specialists;
    var nullKey = spec('x');
    nullKey.GetUniqueID = function () { return { toKeyString: function () { return null; } }; };
    var thrower = spec('y');
    Object.defineProperty(thrower, 'getPlayerID', { get: function () { throw new Error('boom'); } });
    var good = spec('k1');
    var list = c.all({ zone: zoneOf([nullKey, thrower, good]) });
    t.assert.strictEqual(list.length, 1);
    t.assert.strictEqual(list[0], good);
    t.assert.strictEqual(c.dropped(), 2);
});

t.test('the reader drops an entry whose uid key reads undefined or empty', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var c = H.Steward.core.specialists;
    var undef = spec('x');
    undef.GetUniqueID = function () { return { toKeyString: function () { return undefined; } }; };
    var empty = spec('y');
    empty.GetUniqueID = function () { return { toKeyString: function () { return ''; } }; };
    var good = spec('k1');
    var list = c.all({ zone: zoneOf([undef, empty, good]) });
    t.assert.strictEqual(list.length, 1);
    t.assert.strictEqual(list[0], good);
    t.assert.strictEqual(c.dropped(), 2);
});

t.test('lookup does not read absence when an entry flips to an undefined or empty key', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var L = H.Steward.core.specialists.lookup;
    [undefined, ''].forEach(function (bad) {
        var calls = 0;
        var flipper = spec('k2');
        flipper.GetUniqueID = function () {
            calls++;
            return { toKeyString: function () { return calls === 1 ? 'k2' : bad; } };
        };
        var r = L('k2', { zone: zoneOf([spec('k1'), flipper]) });
        t.assert.strictEqual(r.ok, false);
        t.assert.strictEqual(r.spec, null);
    });
});

t.test('a falsy slot is skipped and not counted as dropped', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var c = H.Steward.core.specialists;
    t.assert.strictEqual(c.all({ zone: zoneOf([null, undefined, spec('k1')]) }).length, 1);
    t.assert.strictEqual(c.dropped(), 0);
});

t.test('dropped moves on a dropped read and stays on a clean one', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var c = H.Steward.core.specialists;
    var z = zoneOf([spec('k1'), without('k2', 'getPlayerID'), without('k3', 'GetTask')]);
    t.assert.strictEqual(c.dropped(), 0);
    c.all({ zone: z });
    t.assert.strictEqual(c.dropped(), 2);
    c.all({ zone: z });
    t.assert.strictEqual(c.dropped(), 4);
    c.all({ zone: zoneOf([spec('k1')]) });
    t.assert.strictEqual(c.dropped(), 4);
});

t.test('repeated dropped reads log one line, not one per entry or read', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var c = H.Steward.core.specialists;
    var z = zoneOf([without('a', 'getPlayerID'), without('b', 'GetUniqueID'), spec('k1')]);
    for (var i = 0; i < 5; i++) c.all({ zone: z });
    var lines = dropLines(H);
    t.assert.strictEqual(lines.length, 1);
    var text = String(lines[0].args[0]);
    t.assert.ok(/dropped 2 of 3/.test(text), text);
    t.assert.ok(/getPlayerID x1/.test(text), text);
    t.assert.ok(/GetUniqueID x1/.test(text), text);
    t.assert.strictEqual(H.logs().filter(function (l) { return l.level === 'warn'; }).length, 0);
});

t.test('a clean read logs nothing', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    H.Steward.core.specialists.all({ zone: zoneOf([spec('k1')]) });
    t.assert.strictEqual(dropLines(H).length, 0);
});

t.test('lookup of an absent key is not observed on a dropped read, observed on a clean one', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var L = H.Steward.core.specialists.lookup;
    var dropped = L('k2', { zone: zoneOf([spec('k1'), without('k2', 'getPlayerID')]) });
    t.assert.strictEqual(dropped.ok, false);
    t.assert.strictEqual(dropped.spec, null);
    var clean = L('k2', { zone: zoneOf([spec('k1')]) });
    t.assert.strictEqual(clean.ok, true);
    t.assert.strictEqual(clean.spec, null);
});

t.test('lookup still finds a key that is present on a dropped read', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var L = H.Steward.core.specialists.lookup;
    var good = spec('k1');
    var r = L('k1', { zone: zoneOf([without('k2', 'GetTask'), good]) });
    t.assert.strictEqual(r.ok, true);
    t.assert.strictEqual(r.spec, good);
});

t.test('lookup does not read absence when an entry flips to a null key between the two reads', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var L = H.Steward.core.specialists.lookup;
    // The reader checks the key once; the scan reads it again. A key that goes
    // null in between is not counted as dropped, but may be the one searched for.
    var calls = 0;
    var flipper = spec('k2');
    flipper.GetUniqueID = function () {
        calls++;
        return { toKeyString: function () { return calls === 1 ? 'k2' : null; } };
    };
    var r = L('k2', { zone: zoneOf([spec('k1'), flipper]) });
    t.assert.strictEqual(r.ok, false);
    t.assert.strictEqual(r.spec, null);
});

t.test('refind reports UNREADABLE for an absent key on a dropped read', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var c = H.Steward.core.specialists;
    var r = c.refind('k2', { zone: zoneOf([spec('k1'), without('k2', 'getPlayerID')]) });
    t.assert.strictEqual(r.spec, null);
    t.assert.strictEqual(r.reason, c.UNREADABLE);
    t.assert.strictEqual(c.UNREADABLE, 'specialist unreadable');
});

t.test('listReadable stays true and listComplete is false on a dropped read', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var c = H.Steward.core.specialists;
    var z = zoneOf([spec('k1'), without('k2', 'getPlayerID')]);
    t.assert.strictEqual(c.listReadable({ zone: z }), true);
    t.assert.strictEqual(c.listComplete({ zone: z }), false);
    t.assert.strictEqual(c.listComplete({ zone: zoneOf([spec('k1')]) }), true);
});

t.test('listComplete and listReadable are both false on a null list', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var c = H.Steward.core.specialists;
    var bad = [
        {},
        { GetSpecialists_vector: function () { return null; } },
        { GetSpecialists_vector: function () { throw new Error('boom'); } }
    ];
    for (var i = 0; i < bad.length; i++) {
        t.assert.strictEqual(c.listComplete({ zone: bad[i] }), false);
        t.assert.strictEqual(c.listReadable({ zone: bad[i] }), false);
    }
});
