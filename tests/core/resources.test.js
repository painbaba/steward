'use strict';

var t = require('../runner');
var harness = require('../harness');

function withResources(H, methods) {
    H.host.game.getResources = function () { return methods; };
}

function warnsFor(H, category) {
    return H.logs().filter(function (l) {
        return l.level === 'warn' && l.category === category;
    });
}

t.test('amount and freePopulation read the host', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var seen = [];
    withResources(H, {
        GetResourceAmount: function (name) { seen.push(name); return 42; },
        GetFree:           function () { return 7; }
    });

    var R = H.Steward.core.resources;
    t.assert.strictEqual(R.amount('StripedEggs'), 42);
    t.assert.strictEqual(R.freePopulation(), 7);
    t.assert.deepStrictEqual(seen, ['StripedEggs']);
});

t.test('zero is a real reading, not a failure', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    withResources(H, {
        GetResourceAmount: function () { return 0; },
        GetFree:           function () { return 0; }
    });

    var R = H.Steward.core.resources;
    t.assert.strictEqual(R.amount('Gold'), 0);
    t.assert.strictEqual(R.freePopulation(), 0);
});

t.test('missing host returns null and is silent', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    H.host.game.getResources = undefined;

    var R = H.Steward.core.resources;
    t.assert.strictEqual(R.amount('Gold'), null);
    t.assert.strictEqual(R.freePopulation(), null);
    t.assert.strictEqual(warnsFor(H, 'resources').length, 0);
});

t.test('missing method returns null', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    withResources(H, { GetFree: function () { return 3; } });

    var R = H.Steward.core.resources;
    t.assert.strictEqual(R.amount('Gold'), null);
    t.assert.strictEqual(R.freePopulation(), 3);
});

t.test('a non-number result returns null', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    withResources(H, {
        GetResourceAmount: function () { return undefined; },
        GetFree:           function () { return NaN; }
    });

    var R = H.Steward.core.resources;
    t.assert.strictEqual(R.amount('Gold'), null);
    t.assert.strictEqual(R.freePopulation(), null);
});

t.test('amount refuses a missing resource name without reading the host', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var calls = 0;
    withResources(H, { GetResourceAmount: function () { calls++; return 1; } });

    var R = H.Steward.core.resources;
    t.assert.strictEqual(R.amount(''), null);
    t.assert.strictEqual(R.amount(undefined), null);
    t.assert.strictEqual(calls, 0);
});

t.test('a throwing getter returns null and warns once', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    withResources(H, {
        GetResourceAmount: function () { throw new Error('boom'); },
        GetFree:           function () { throw new Error('boom'); }
    });

    var R = H.Steward.core.resources;
    t.assert.strictEqual(R.amount('Gold'), null);
    t.assert.strictEqual(R.amount('Gold'), null);
    t.assert.strictEqual(R.freePopulation(), null);
    t.assert.strictEqual(warnsFor(H, 'resources').length, 1);
});

t.test('a reload resets the throw warning', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    withResources(H, { GetResourceAmount: function () { throw new Error('boom'); } });
    H.Steward.core.resources.amount('Gold');
    t.assert.strictEqual(warnsFor(H, 'resources').length, 1);

    var H2 = harness.reload(H);
    H2.host.game.getResources = function () {
        return { GetResourceAmount: function () { throw new Error('boom'); } };
    };
    var before = warnsFor(H2, 'resources').length;
    H2.Steward.core.resources.amount('Gold');
    H2.Steward.core.resources.amount('Gold');
    t.assert.strictEqual(warnsFor(H2, 'resources').length - before, 1);
});

t.test('POPULATION names the host population resource', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    t.assert.strictEqual(H.Steward.core.resources.POPULATION, 'Population');
});

t.test('events.eventResourceAmount reuses the resource reader', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    withResources(H, { GetResourceAmount: function (name) { return name === 'ChristmasResource' ? 5 : null; } });

    var E = H.Steward.core.events;
    t.assert.strictEqual(E.eventResourceAmount('XMAS'), 5);
    t.assert.strictEqual(E.eventResourceAmount('NoSuchEvent'), null);
});
