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

t.test('a falsy slot counts as dropped and makes lookup ok:false', function () {
    [null, undefined, ''].forEach(function (empty) {
        var H = harness.boot({ sections: ['kernel', 'core'] });
        var c = H.Steward.core.specialists;
        var k1 = spec('k1');
        var z = zoneOf([empty, k1]);
        t.assert.strictEqual(c.all({ zone: z }).length, 1);
        t.assert.strictEqual(c.dropped(), 1);
        c.all({ zone: z });
        t.assert.strictEqual(c.dropped(), 2);
        var hit = c.lookup('k1', { zone: z });
        t.assert.strictEqual(hit.ok, true);
        t.assert.strictEqual(hit.spec, k1);
        var miss = c.lookup('k2', { zone: z });
        t.assert.strictEqual(miss.ok, false);
        t.assert.strictEqual(miss.spec, null);
    });
});

t.test('the drop line names an empty slot as empty x1', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    H.Steward.core.specialists.all({ zone: zoneOf([null, spec('k1')]) });
    var lines = dropLines(H);
    t.assert.strictEqual(lines.length, 1);
    t.assert.ok(/empty x1/.test(String(lines[0].args[0])), String(lines[0].args[0]));
});

// A zone whose list is built per call: absent(n) says whether the key k is
// hidden on read n (1-based). reads() counts the calls.
function countingZone(absent, other) {
    var calls = 0;
    var k = spec('k');
    return {
        zone: { GetSpecialists_vector: function () {
            calls++;
            var list = [spec('k1')];
            if (!absent(calls)) list.push(k);
            if (other) return other(calls, list);
            return list;
        } },
        reads: function () { return calls; },
        spec:  k
    };
}

function foundLines(H) {
    return H.logs().filter(function (l) {
        return l.category === 'specialists' && /found on read/.test(String(l.args[0]));
    });
}

t.test('lookup finds a key that is hidden for the first m clean reads, in m+1 reads, with one log line', function () {
    for (var m = 1; m <= 4; m++) {
        var H = harness.boot({ sections: ['kernel', 'core'] });
        var z = countingZone(function (n) { return n <= m; });
        var r = H.Steward.core.specialists.lookup('k', { zone: z.zone });
        t.assert.strictEqual(r.ok, true);
        t.assert.strictEqual(r.spec, z.spec);
        t.assert.strictEqual(z.reads(), m + 1);
        var lines = foundLines(H);
        t.assert.strictEqual(lines.length, 1);
        t.assert.ok(new RegExp('found on read ' + (m + 1)).test(String(lines[0].args[0])), String(lines[0].args[0]));
    }
});

t.test('lookup of a key absent on every read is not listed after exactly LOOKUP_CLEAN_MISSES reads', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var c = H.Steward.core.specialists;
    t.assert.strictEqual(c.LOOKUP_CLEAN_MISSES, 5);
    var z = countingZone(function () { return true; });
    var r = c.lookup('k', { zone: z.zone });
    t.assert.strictEqual(r.ok, true);
    t.assert.strictEqual(r.spec, null);
    t.assert.strictEqual(z.reads(), 5);
    t.assert.strictEqual(foundLines(H).length, 0);
});

t.test('lookup stops at once when a later read is null or drops an entry', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var L = H.Steward.core.specialists.lookup;
    var nulled = countingZone(function () { return true; }, function (n, list) { return n === 2 ? null : list; });
    var r = L('k', { zone: nulled.zone });
    t.assert.strictEqual(r.ok, false);
    t.assert.strictEqual(r.spec, null);
    t.assert.strictEqual(nulled.reads(), 2);
    var lossy = countingZone(function () { return true; }, function (n, list) {
        if (n === 2) list.push(without('bad', 'getPlayerID'));
        return list;
    });
    r = L('k', { zone: lossy.zone });
    t.assert.strictEqual(r.ok, false);
    t.assert.strictEqual(r.spec, null);
    t.assert.strictEqual(lossy.reads(), 2);
});

t.test('a hit on the first read makes one read and logs nothing', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var z = countingZone(function () { return false; });
    var r = H.Steward.core.specialists.lookup('k', { zone: z.zone });
    t.assert.strictEqual(r.spec, z.spec);
    t.assert.strictEqual(z.reads(), 1);
    t.assert.strictEqual(foundLines(H).length, 0);
});

t.test('repeated hits on read 2 log one line within the throttle window', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var L = H.Steward.core.specialists.lookup;
    for (var i = 0; i < 4; i++) {
        var z = countingZone(function (n) { return n === 1; });
        t.assert.strictEqual(L('k', { zone: z.zone }).spec, z.spec);
    }
    t.assert.strictEqual(foundLines(H).length, 1);
});

t.test('refind says specialist not found only after LOOKUP_CLEAN_MISSES clean misses', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var c = H.Steward.core.specialists;
    var hidden = countingZone(function (n) { return n <= 4; });
    var r = c.refind('k', { zone: hidden.zone });
    t.assert.strictEqual(r.spec, hidden.spec);
    t.assert.strictEqual(r.reason, null);
    var gone = countingZone(function () { return true; });
    r = c.refind('k', { zone: gone.zone });
    t.assert.strictEqual(r.spec, null);
    t.assert.strictEqual(r.reason, 'specialist not found');
    t.assert.strictEqual(gone.reads(), 5);
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

// ---- fighterList ------------------------------------------------------------

var A = require('../stubs/army');
var specStubs = require('../stubs/specialists');

function fighterBoot(fighters) {
    var H = harness.boot();
    A.install(H, { fighters: fighters || [] });
    return H;
}

t.test('fighterList: generals and carriers of one read, explorers left out, complete', function () {
    var H = fighterBoot();
    var list = [
        A.fighter({ uid: 'g1' }),
        specStubs.spec({ type: specStubs.TYPE.EXPLORER, uid: 'e1' }),
        A.fighter({ uid: 'c1', carrier: true })
    ];
    var r = H.Steward.core.specialists.fighterList({ zone: zoneOf(list) });
    t.assert.strictEqual(r.complete, true);
    t.assert.strictEqual(r.list.length, 2);
    t.assert.strictEqual(r.list[0], list[0]);
    t.assert.strictEqual(r.list[1], list[2]);
});

t.test('fighterList: a list that cannot be read is empty and incomplete', function () {
    var H = fighterBoot();
    var bad = [
        {},
        { GetSpecialists_vector: function () { return null; } },
        { GetSpecialists_vector: function () { throw new Error('boom'); } }
    ];
    for (var i = 0; i < bad.length; i++) {
        var r = H.Steward.core.specialists.fighterList({ zone: bad[i] });
        t.assert.strictEqual(r.list.length, 0);
        t.assert.strictEqual(r.complete, false);
    }
});

t.test('fighterList: a ghost entry makes the read incomplete', function () {
    var H = fighterBoot();
    var ghost = A.fighter({ uid: 'g2' });
    specStubs.ghost(ghost);
    var r = H.Steward.core.specialists.fighterList({ zone: zoneOf([A.fighter({ uid: 'g1' }), ghost]) });
    t.assert.strictEqual(r.complete, false);
    t.assert.strictEqual(r.list.length, 1);
});
