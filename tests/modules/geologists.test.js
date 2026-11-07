'use strict';

var t = require('../runner');
var harness = require('../harness');

// Settings helper: only the named deposit is enabled. Others stay defined
// (defaults' enabled:true would otherwise leak through the deep-merge in
// modules/geologists/ui.js readSettings).
function onlyEnable(depositName, max) {
    var names = ['Stone', 'BronzeOre', 'Marble', 'IronOre', 'GoldOre',
                 'Coal', 'Granite', 'TitaniumOre', 'Salpeter'];
    var deposits = {};
    for (var i = 0; i < names.length; i++) {
        deposits[names[i]] = (names[i] === depositName)
            ? { enabled: true,  max: max }
            : { enabled: false, max: 0 };
    }
    return { enabled: true, dispatchDelay: 0, deposits: deposits };
}

t.test('plan enqueues one dispatch per wanted slot when an idle geologist exists', function () {
    var H = harness.boot();
    var z = H.zone.zone()
        .deposits('IronOre', [])  // 0 on map, max=1 → wanted=1
        .specialists([
            H.specs.geologist({ name: 'irongut', uid: 'g1' })
        ])
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;

    H.settings.write('geologists', onlyEnable('IronOre', 1));

    var mod = H.module('geologists');
    t.assert.ok(mod, 'geologists module should be registered');
    mod.plan({ zone: { isHome: true } });

    var q = H.queued();
    t.assert.strictEqual(q.length, 1);
    t.assert.strictEqual(q[0].name, 'geologists.dispatch');
    t.assert.strictEqual(q[0].params[2], 'IronOre');
});

t.test('plan enqueues nothing when no idle geologists are available', function () {
    var H = harness.boot();
    var z = H.zone.zone()
        .deposits('IronOre', [])
        .specialists([])
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;

    H.settings.write('geologists', onlyEnable('IronOre', 1));

    H.module('geologists').plan({ zone: { isHome: true } });
    t.assert.strictEqual(H.queued().length, 0);
});

t.test('plan enqueues nothing when wanted slots are already filled (deposits on map)', function () {
    var H = harness.boot();
    var existing = H.zone.deposit({ name: 'IronOre', grid: 5 });
    var z = H.zone.zone()
        .deposits('IronOre', [existing])
        .specialists([H.specs.geologist({ name: 'irongut', uid: 'g1' })])
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;

    H.settings.write('geologists', onlyEnable('IronOre', 1));   // 1 on map, max 1 → wanted 0

    H.module('geologists').plan({ zone: { isHome: true } });
    t.assert.strictEqual(H.queued().length, 0);
});

// "Ghost" specialist: a real geologist whose members read undefined for a
// moment on the JS side of the AIR bridge (GetType still answers). The reader
// leaves such an entry out and counts it, and the plan treats a read that
// dropped anything as unreadable: a dropped busy geologist would shorten the
// busy count and over-dispatch the healthy idle ones.
function ghostGeologist(H, uid) {
    var g = H.specs.geologist({ name: 'ghost', uid: uid || 'ghost1' });
    H.specs.ghost(g);
    return g;
}

function planWith(H, list, max) {
    var z = H.zone.zone()
        .deposits('IronOre', [])
        .specialists(list)
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    H.settings.write('geologists', onlyEnable('IronOre', max));
    H.module('geologists').plan({ zone: { isHome: true } });
}

// The registered dispatch queue action, captured while the module boots.
function dispatchAction(H) {
    var q = H.Steward.kernel.queue;
    var orig = q.action;
    var fn = null;
    q.action = function (name, f) {
        if (name === 'geologists.dispatch') fn = f;
        return orig.apply(q, arguments);
    };
    H.module('geologists').boot();
    q.action = orig;
    return fn;
}

function geoWarns(H) {
    return H.logs().filter(function (l) {
        return l.level === 'warn' && l.category === 'geologists';
    });
}

t.test('plan queues nothing when a ghost is in the list next to a healthy idle geologist', function () {
    var H = harness.boot();
    planWith(H, [ghostGeologist(H), H.specs.geologist({ name: 'irongut', uid: 'g1' })], 1);

    t.assert.strictEqual(H.queued().length, 0);
    t.assert.strictEqual(H.Steward.core.specialists.dropped(), 1);
    t.assert.strictEqual(geoWarns(H).length, 0);
});

t.test('plan queues the healthy geologist again once the ghost is gone', function () {
    var H = harness.boot();
    var ghost = ghostGeologist(H);
    var real = H.specs.geologist({ name: 'irongut', uid: 'g1' });
    var z = H.zone.zone()
        .deposits('IronOre', [])
        .specialists([ghost, real])
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    H.settings.write('geologists', onlyEnable('IronOre', 1));
    var mod = H.module('geologists');
    mod.plan({ zone: { isHome: true } });
    t.assert.strictEqual(H.queued().length, 0);

    z.specialists([real]);
    mod.plan({ zone: { isHome: true } });
    var q = H.queued();
    t.assert.strictEqual(q.length, 1);
    t.assert.strictEqual(q[0].params[0], 'g1');
});

t.test('plan with only ghost geologists queues nothing and warns about nothing', function () {
    var H = harness.boot();
    planWith(H, [ghostGeologist(H, 'a'), ghostGeologist(H, 'b'), ghostGeologist(H, 'c')], 5);

    t.assert.strictEqual(H.queued().length, 0);
    t.assert.strictEqual(geoWarns(H).length, 0);
    var perEntry = H.logs().filter(function (l) {
        return /no uniqueID|ghost/i.test(String(l.args && l.args[0]));
    });
    t.assert.strictEqual(perEntry.length, 0);
});

t.test('plan queues nothing when a busy geologist turns into a ghost inside the pass', function () {
    var H = harness.boot();
    var idle = H.specs.geologist({ name: 'irongut', uid: 'g1' });
    // The busy geologist is counted before the idle one's name is read, so the
    // flip lands after the counts and the pick, and only the last list check
    // can still stop the dispatch. Its sub type is not the deposit's, so the
    // wanted slot stays open.
    var busy = H.specs.geologist({ name: 'busy', uid: 'g2', task: H.specs.task(1, 999, 1000) });
    var flipped = false;
    ['GetName_string', 'GetName', 'getName'].forEach(function (member) {
        var orig = idle[member];
        idle[member] = function () {
            var v = orig.apply(this, arguments);
            if (!flipped) { flipped = true; H.specs.ghost(busy); }
            return v;
        };
    });
    planWith(H, [idle, busy], 1);

    t.assert.strictEqual(flipped, true, 'the flip should have happened during the pass');
    t.assert.strictEqual(H.queued().length, 0);
});

t.test('plan still queues when nobody flips during the pass (control for the flip test)', function () {
    var H = harness.boot();
    var idle = H.specs.geologist({ name: 'irongut', uid: 'g1' });
    var busy = H.specs.geologist({ name: 'busy', uid: 'g2', task: H.specs.task(1, 999, 1000) });
    planWith(H, [idle, busy], 1);

    t.assert.strictEqual(H.queued().length, 1);
    t.assert.strictEqual(H.queued()[0].params[0], 'g1');
});

t.test('rank skips a geologist whose uid key reads null', function () {
    var H = harness.boot();
    var c = H.Steward.core.specialists;
    var bad = H.specs.geologist({ name: 'bad', uid: 'x' });
    bad.GetUniqueID = function () { return { toKeyString: function () { return null; } }; };
    var good = H.specs.geologist({ name: 'good', uid: 'g1' });
    var rows = c.rankGeologistsForDeposit('IronOre', { from: [bad, good] });
    t.assert.strictEqual(rows.length, 1);
    t.assert.strictEqual(rows[0].uid, 'g1');
    rows = c.rankGeologistsForDeposit('IronOre', { from: [bad], exclude: { g1: true } });
    t.assert.strictEqual(rows.length, 0);
});

t.test('dispatch on a dropped read that lacks its key is silent and sends nothing', function () {
    var H = harness.boot();
    var c = H.Steward.core.specialists;
    var sends = [];
    c.send = function () { sends.push(arguments); return true; };
    var z = H.zone.zone()
        .specialists([ghostGeologist(H), H.specs.geologist({ name: 'other', uid: 'g2' })])
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    var fire = dispatchAction(H);
    t.assert.strictEqual(typeof fire, 'function');
    H.clearLogs();

    fire(['g1', 'irongut', 'IronOre']);

    t.assert.strictEqual(sends.length, 0);
    t.assert.strictEqual(geoWarns(H).length, 0);
    t.assert.strictEqual(H.logs().filter(function (l) { return l.level === 'error'; }).length, 0);
});

t.test('dispatch on a clean read sends to the re-found geologist', function () {
    var H = harness.boot();
    var c = H.Steward.core.specialists;
    var sends = [];
    c.send = function (spec) { sends.push(spec); return true; };
    var g1 = H.specs.geologist({ name: 'irongut', uid: 'g1' });
    var z = H.zone.zone()
        .specialists([H.specs.geologist({ name: 'other', uid: 'g2' }), g1])
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    var fire = dispatchAction(H);

    fire(['g1', 'irongut', 'IronOre']);

    t.assert.strictEqual(sends.length, 1);
    t.assert.strictEqual(sends[0], g1);
    t.assert.strictEqual(geoWarns(H).length, 0);
});

t.test('dispatch of a key that is really absent on a clean read still warns', function () {
    var H = harness.boot();
    var c = H.Steward.core.specialists;
    var sends = [];
    c.send = function () { sends.push(arguments); return true; };
    var z = H.zone.zone()
        .specialists([H.specs.geologist({ name: 'other', uid: 'g2' })])
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    var fire = dispatchAction(H);

    fire(['g1', 'irongut', 'IronOre']);

    t.assert.strictEqual(sends.length, 0);
    var warns = geoWarns(H);
    t.assert.strictEqual(warns.length, 1);
    t.assert.ok(/could not re-find/.test(String(warns[0].args[0])), String(warns[0].args[0]));
});

t.test('plan dispatches nothing for a type whose byType fails', function () {
    var H = harness.boot();
    var z = H.zone.zone()
        .deposits('IronOre', [])
        .specialists([H.specs.geologist({ name: 'irongut', uid: 'g1' })])
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    z.zone.mStreetDataMap.getDeposits_vectorByType = function () {
        throw new Error('[undefined] is not a function');
    };

    H.settings.write('geologists', onlyEnable('IronOre', 3));
    H.module('geologists').plan({ zone: { isHome: true } });

    t.assert.strictEqual(H.queued().length, 0);
    var warns = H.logs().filter(function (l) {
        return l.level === 'warn' && l.category === 'geologists';
    });
    t.assert.ok(warns.length >= 1, 'a geologists warning should be logged');
});

var TAGGED = '<b>A &amp; B</b>';

function planTagged(H, overrides, max) {
    var cfg = onlyEnable('IronOre', max || 1);
    cfg.overrides = overrides;
    var z = H.zone.zone()
        .deposits('IronOre', [])
        .specialists([H.specs.geologist({ name: TAGGED, uid: 'g1' })])
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    H.settings.write('geologists', cfg);
    H.module('geologists').plan({ zone: { isHome: true } });
    return H.queued();
}

t.test('plan applies an override keyed by the clean, entity or raw name', function () {
    ['A & B', 'A &amp; B', TAGGED].forEach(function (key) {
        var other = {};
        other[key] = ['Stone'];
        var H = harness.boot();
        t.assert.strictEqual(planTagged(H, other).length, 0, key);

        var allowed = {};
        allowed[key] = ['IronOre'];
        H = harness.boot();
        t.assert.strictEqual(planTagged(H, allowed).length, 1, key);
    });
});

t.test('plan queues the clean name as the dispatch label', function () {
    var H = harness.boot();
    var q = planTagged(H, {});
    t.assert.strictEqual(q.length, 1);
    t.assert.strictEqual(q[0].params[1], 'A & B');
});

// renderSection with the helpers a headless context lacks replaced; gridRow
// records its cells, deposit rows included.
function renderRows(H, settingsObj) {
    var real = H.Steward.kernel.ui.helpers;
    var h = {};
    var k;
    for (k in real) {
        if (Object.prototype.hasOwnProperty.call(real, k)) h[k] = real[k];
    }
    var rows = [];
    function blank() { return H.host.$(); }
    h.formRow = blank;
    h.toggle = blank;
    h.input = blank;
    h.dropdown = blank;
    h.settings = function () { return settingsObj; };
    h.gridRow = function (cells) {
        rows.push(cells);
        return { addClass: function () { return this; } };
    };
    H.Steward.modules.geologists.renderSection(H.host.$(), h);
    return rows;
}

function mountNamed(H, name) {
    var z = H.zone.zone()
        .deposits('IronOre', [])
        .specialists([H.specs.geologist({ name: name, uid: 'g1' })])
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
}

t.test('the name cell escapes the decoded name', function () {
    var H = harness.boot();
    mountNamed(H, 'A &amp; &lt;B&gt;');
    var rows = renderRows(H, { overrides: {}, deposits: {} });
    var row = rows[rows.length - 1];
    t.assert.strictEqual(row[0][1], 'A &amp; &lt;B&gt;');
});

t.test('the override star shows for an entity-form key only', function () {
    var H = harness.boot();
    mountNamed(H, 'A &amp; &lt;B&gt;');
    var rows = renderRows(H, { overrides: { 'A &amp; &lt;B&gt;': ['IronOre'] }, deposits: {} });
    var row = rows[rows.length - 1];
    t.assert.ok(/ \*$/.test(row[0][1]), String(row[0][1]));
    t.assert.ok(/^A &amp; &lt;B&gt;/.test(row[0][1]), String(row[0][1]));
    rows = renderRows(H, { overrides: {}, deposits: {} });
    row = rows[rows.length - 1];
    t.assert.ok(!/ \*$/.test(row[0][1]), String(row[0][1]));
});

// --- send guard ------------------------------------------------------------

// A booted harness with a test clock on the shared send guard; env.T is read
// at call time.
function guarded() {
    var H = harness.boot();
    var env = { H: H, T: 1000000 };
    env.g = H.Steward.core.specialists.sendGuard;
    env.g.clock = function () { return env.T; };
    return env;
}

// Mounts `list` with IronOre enabled at `max` and boots the module. plan()
// returns what that pass queued.
function guardedGeos(env, list, max) {
    var H = env.H;
    var z = H.zone.zone()
        .deposits('IronOre', [])
        .specialists(list)
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    H.settings.write('geologists', onlyEnable('IronOre', max));
    var fire = dispatchAction(H);
    return {
        zone: z,
        fire: fire,
        plan: function () {
            H.clearQueued();
            H.module('geologists').plan({ zone: { isHome: true } });
            return H.queued();
        }
    };
}

t.test('guard: a pending geologist counts as on task for its deposit', function () {
    var env = guarded();
    var f = guardedGeos(env, [idleGeo(env, 'g1'), idleGeo(env, 'g2')], 1);
    env.H.Steward.core.specialists.send = function () { return true; };

    var q = f.plan();
    t.assert.strictEqual(q.length, 1);
    f.fire(q[0].params);
    env.T += env.g.VERIFY_MS - 1;
    t.assert.strictEqual(f.plan().length, 0, 'the other idle geologist is not sent to the same slot');
});

t.test('guard: a held geologist is replaced by another idle one', function () {
    var env = guarded();
    var f = guardedGeos(env, [idleGeo(env, 'g1'), idleGeo(env, 'g2')], 1);
    env.H.Steward.core.specialists.send = function () { return true; };

    var q = f.plan();
    t.assert.strictEqual(q.length, 1);
    var first = q[0].params[0];
    f.fire(q[0].params);
    env.T += env.g.VERIFY_MS;

    q = f.plan();
    t.assert.strictEqual(env.g.blocked(first), true, 'the first geologist is held');
    t.assert.strictEqual(q.length, 1);
    t.assert.notStrictEqual(q[0].params[0], first);
});

t.test('guard: the breaker is shared, so explorer misses stop geologists until one probe', function () {
    var env = guarded();
    var H = env.H;
    var list = [idleGeo(env, 'g1'), idleGeo(env, 'g2')];
    var explorerUids = ['e1', 'e2', 'e3', 'e4', 'e5'];
    explorerUids.forEach(function (u) {
        var s = H.specs.spec({ name: u, uid: u, type: 1 });
        list.push(s);
    });
    var f = guardedGeos(env, list, 2);

    explorerUids.forEach(function (u) { env.g.note('explorers', u, u, 'Short'); });
    env.T += env.g.VERIFY_MS;
    env.g.settle('explorers', H.Steward.core.specialists.explorers(), true);
    t.assert.strictEqual(env.g.isOpen(), true);

    t.assert.strictEqual(f.plan().length, 0, 'paused while open');
    env.T = env.g.snapshot().nextProbeAt;
    t.assert.strictEqual(f.plan().length, 1, 'exactly one probe');
    t.assert.strictEqual(f.plan().length, 0, 'no second probe in the same cooldown');
});

t.test('guard: a geologist send that sends nothing leaves nothing pending', function () {
    var cases = {
        'send false': function (c) { c.send = function () { return false; }; },
        'lookup ok:false': function (c) { c.lookup = function () { return { ok: false }; }; }
    };
    Object.keys(cases).forEach(function (name) {
        var env = guarded();
        var f = guardedGeos(env, [idleGeo(env, 'g1')], 1);
        var c = env.H.Steward.core.specialists;
        var lookup = c.lookup;
        c.send = function () { return true; };
        var q = f.plan();
        t.assert.strictEqual(q.length, 1, name);
        cases[name](c);
        f.fire(q[0].params);
        c.lookup = lookup;

        t.assert.strictEqual(env.g.snapshot().pending, 0, name);
        t.assert.strictEqual(env.g.pendingTags('geologists').length, 0, name);
        t.assert.strictEqual(f.plan().length, 1, name);
    });
});

// An idle geologist with uid and name `uid`.
function idleGeo(env, uid) {
    return env.H.specs.geologist({ name: uid, uid: uid });
}
