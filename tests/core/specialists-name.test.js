'use strict';

var t = require('../runner');
var harness = require('../harness');

var RAW = "<b>Ghost #2</b> <font size='-3'>(Ghost General)</font>";

function boot() {
    return harness.boot({ sections: ['kernel', 'core'] });
}

function zoneOf(list) {
    return { GetSpecialists_vector: function () { return list; } };
}

t.test('name cleans the host display string, also with a leading space', function () {
    var H = boot();
    var c = H.Steward.core.specialists;
    t.assert.strictEqual(c.name(H.specs.spec({ name: RAW })), 'Ghost #2 (Ghost General)');
    t.assert.strictEqual(c.name(H.specs.spec({ name: ' ' + RAW })), 'Ghost #2 (Ghost General)');
});

t.test('name cleans a bold name, keeps an untagged one and decodes entities', function () {
    var H = boot();
    var c = H.Steward.core.specialists;
    t.assert.strictEqual(c.name(H.specs.spec({ name: '<b>The Smuggler</b>' })), 'The Smuggler');
    t.assert.strictEqual(c.name(H.specs.spec({ name: 'Hans' })), 'Hans');
    t.assert.strictEqual(c.name(H.specs.spec({ name: 'A &amp; B' })), 'A & B');
});

t.test('name falls through a tag-only read to the next reader', function () {
    var H = boot();
    var c = H.Steward.core.specialists;
    var s = H.specs.spec({ name: 'x' });
    s.getName = function () { return '<b></b>'; };
    s.GetName = function () { return '<b>Next</b>'; };
    t.assert.strictEqual(c.name(s), 'Next');
});

function locFallbackSpec(H, key) {
    var s = H.specs.spec({ name: 'x' });
    s.getName = function () { return ''; };
    s.GetName = function () { return ''; };
    s.GetSpecialistDescription = function () {
        return { getName_string: function () { return key; } };
    };
    return s;
}

t.test('name cleans the locale fallback with and without locale.spe', function () {
    var H = boot();
    var c = H.Steward.core.specialists;
    var s = locFallbackSpec(H, '<b>Geo Key</b>');
    H.Steward.core.locale = null;
    t.assert.strictEqual(c.name(s), 'Geo Key');
    H.Steward.core.locale = { spe: function (key) { return '<i>' + key + '</i> &amp; co'; } };
    t.assert.strictEqual(c.name(s), 'Geo Key & co');
});

t.test('name of a null spec is empty', function () {
    var H = boot();
    t.assert.strictEqual(H.Steward.core.specialists.name(null), '');
});

t.test('namedOverride finds the exact, entity and raw keys', function () {
    var H = boot();
    var o = H.Steward.core.specialists.namedOverride;
    t.assert.strictEqual(o({ 'A & B': 1 }, 'A & B'), 1);
    t.assert.strictEqual(o({ 'A &amp; B': 2 }, 'A & B'), 2);
    t.assert.strictEqual(o({ '<b>A</b>': 3 }, 'A'), 3);
});

t.test('namedOverride prefers the exact key over a cleaned one', function () {
    var H = boot();
    var o = H.Steward.core.specialists.namedOverride;
    t.assert.strictEqual(o({ '<b>A</b>': 'raw', A: 'exact' }, 'A'), 'exact');
    t.assert.strictEqual(o({ A: 'exact', '<b>A</b>': 'raw' }, 'A'), 'exact');
});

t.test('namedOverride finds a clean name that holds a literal tag', function () {
    var H = boot();
    var o = H.Steward.core.specialists.namedOverride;
    t.assert.strictEqual(o({ 'Camp <x> A': 7 }, 'Camp <x> A'), 7);
});

t.test('namedOverride gives undefined for no match or unusable input', function () {
    var H = boot();
    var o = H.Steward.core.specialists.namedOverride;
    t.assert.strictEqual(o({ A: 1 }, 'B'), undefined);
    t.assert.strictEqual(o(null, 'A'), undefined);
    t.assert.strictEqual(o({ A: 1 }, ''), undefined);
    t.assert.strictEqual(o({}, 'constructor'), undefined);
});

t.test('byName finds a spec by clean and by raw target', function () {
    var H = boot();
    var c = H.Steward.core.specialists;
    var s = H.specs.spec({ name: RAW, uid: 'k1' });
    var opts = { zone: zoneOf([H.specs.spec({ name: 'Other', uid: 'k2' }), s]) };
    t.assert.strictEqual(c.byName('Ghost #2 (Ghost General)', opts), s);
    t.assert.strictEqual(c.byName(RAW, opts), s);
});

t.test('byName finds nothing for an empty or missing target', function () {
    var H = boot();
    var c = H.Steward.core.specialists;
    var nameless = H.specs.spec({ name: 'x', uid: 'k1' });
    nameless.getName = function () { return ''; };
    nameless.GetName = function () { return ''; };
    // The stub's description would still give a name through the locale fallback.
    nameless.GetSpecialistDescription = function () { return null; };
    var opts = { zone: zoneOf([nameless, H.specs.spec({ name: 'Hans', uid: 'k2' })]) };
    t.assert.strictEqual(c.byName('', opts), null);
    t.assert.strictEqual(c.byName(undefined, opts), null);
});

t.test('byName finds a spec whose name decodes to a literal tag', function () {
    var H = boot();
    var c = H.Steward.core.specialists;
    var s = H.specs.spec({ name: 'Camp &lt;x&gt; A', uid: 'k1' });
    t.assert.strictEqual(c.name(s), 'Camp <x> A');
    t.assert.strictEqual(c.byName('Camp <x> A', { zone: zoneOf([s]) }), s);
});
