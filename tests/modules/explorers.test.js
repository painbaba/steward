'use strict';

var t = require('../runner');
var harness = require('../harness');

// The classifier takes base type 1 for an explorer, so the stub's own explorer
// type id (3) would not classify; build the entry with the real one.
function explorer(H, opts) {
    opts.type = 1;
    return H.specs.spec(opts);
}

function mount(H, list) {
    var z = H.zone.zone()
        .specialists(list)
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    return z;
}

// The registered dispatch queue action, captured while the module boots.
function dispatchAction(H) {
    var q = H.Steward.kernel.queue;
    var orig = q.action;
    var fn = null;
    q.action = function (name, f) {
        if (name === 'explorers.dispatch') fn = f;
        return orig.apply(q, arguments);
    };
    H.module('explorers').boot();
    q.action = orig;
    return fn;
}

function explorerWarns(H) {
    return H.logs().filter(function (l) {
        return l.level === 'warn' && l.category === 'explorers';
    });
}

t.test('plan queues the healthy idle explorers next to a ghost, with no per-entry line', function () {
    var H = harness.boot();
    var ghost = explorer(H, { name: 'ghost', uid: 'ghost1' });
    H.specs.ghost(ghost);
    mount(H, [explorer(H, { name: 'one', uid: 'e1' }), ghost, explorer(H, { name: 'two', uid: 'e2' })]);
    H.settings.write('explorers', { enabled: true, dispatchDelay: 0 });

    H.module('explorers').plan({ zone: { isHome: true } });

    var q = H.queued();
    t.assert.strictEqual(q.length, 2);
    t.assert.strictEqual(q[0].name, 'explorers.dispatch');
    t.assert.deepStrictEqual(q.map(function (e) { return e.params[0]; }).sort(), ['e1', 'e2']);
    t.assert.strictEqual(H.Steward.core.specialists.dropped(), 1);
    t.assert.strictEqual(explorerWarns(H).length, 0);
    var perEntry = H.logs().filter(function (l) {
        return /no uniqueID|ghost/i.test(String(l.args && l.args[0]));
    });
    t.assert.strictEqual(perEntry.length, 0);
});

t.test('plan queues nothing when the only explorer is a ghost', function () {
    var H = harness.boot();
    var ghost = explorer(H, { name: 'ghost', uid: 'ghost1' });
    H.specs.ghost(ghost);
    mount(H, [ghost]);
    H.settings.write('explorers', { enabled: true, dispatchDelay: 0 });

    H.module('explorers').plan({ zone: { isHome: true } });

    t.assert.strictEqual(H.queued().length, 0);
    t.assert.strictEqual(explorerWarns(H).length, 0);
});

t.test('plan skips an explorer whose key turns null after the idle filter', function () {
    var H = harness.boot();
    var c = H.Steward.core.specialists;
    var flip = explorer(H, { name: 'flip', uid: 'e1' });
    var key = 'e1';
    flip.GetUniqueID = function () { return { toKeyString: function () { return key; } }; };
    mount(H, [flip, explorer(H, { name: 'two', uid: 'e2' })]);
    H.settings.write('explorers', { enabled: true, dispatchDelay: 0 });
    // The task pick sits between the idle filter and the second key read.
    var pick = c.pickTask;
    c.pickTask = function (spec) {
        if (spec === flip) key = null;
        return pick.apply(this, arguments);
    };

    H.module('explorers').plan({ zone: { isHome: true } });
    c.pickTask = pick;

    var q = H.queued();
    t.assert.strictEqual(key, null, 'the flip should have happened during the pass');
    t.assert.strictEqual(q.length, 1);
    t.assert.strictEqual(q[0].params[0], 'e2');
    t.assert.strictEqual(explorerWarns(H).length, 0);
});

t.test('dispatch on a dropped read that lacks its key is silent and sends nothing', function () {
    var H = harness.boot();
    var c = H.Steward.core.specialists;
    var sends = [];
    c.send = function () { sends.push(arguments); return true; };
    var ghost = explorer(H, { name: 'ghost', uid: 'e1' });
    H.specs.ghost(ghost);
    mount(H, [ghost, explorer(H, { name: 'other', uid: 'e2' })]);
    var fire = dispatchAction(H);
    t.assert.strictEqual(typeof fire, 'function');
    H.clearLogs();

    fire(['e1', 'one', 'Short']);

    t.assert.strictEqual(sends.length, 0);
    t.assert.strictEqual(explorerWarns(H).length, 0);
    t.assert.strictEqual(H.logs().filter(function (l) { return l.level === 'error'; }).length, 0);
});

t.test('dispatch on a clean read sends to the re-found explorer', function () {
    var H = harness.boot();
    var c = H.Steward.core.specialists;
    var sends = [];
    c.send = function (spec, task) { sends.push({ spec: spec, task: task }); return true; };
    var e1 = explorer(H, { name: 'one', uid: 'e1' });
    mount(H, [explorer(H, { name: 'other', uid: 'e2' }), e1]);
    var fire = dispatchAction(H);

    fire(['e1', 'one', 'Short']);

    t.assert.strictEqual(sends.length, 1);
    t.assert.strictEqual(sends[0].spec, e1);
    t.assert.strictEqual(sends[0].task, 'Short');
});

t.test('dispatch of a key that is really absent on a clean read still warns', function () {
    var H = harness.boot();
    var c = H.Steward.core.specialists;
    var sends = [];
    c.send = function () { sends.push(arguments); return true; };
    mount(H, [explorer(H, { name: 'other', uid: 'e2' })]);
    var fire = dispatchAction(H);

    fire(['e1', 'one', 'Short']);

    t.assert.strictEqual(sends.length, 0);
    var warns = explorerWarns(H);
    t.assert.strictEqual(warns.length, 1);
    t.assert.ok(/could not re-find/.test(String(warns[0].args[0])), String(warns[0].args[0]));
});
