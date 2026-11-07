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

// An override value pickTask would not choose for a vanilla explorer.
function planNames(H, name, overrides) {
    mount(H, [explorer(H, { name: name, uid: 'e1' })]);
    H.settings.write('explorers', { enabled: true, dispatchDelay: 0, overrides: overrides });
    H.module('explorers').plan({ zone: { isHome: true } });
    return H.queued();
}

t.test('plan applies an override keyed by the clean, entity or raw name', function () {
    var keys = ['A & B', 'A &amp; B', '<b>A &amp; B</b>'];
    keys.forEach(function (key) {
        var H = harness.boot();
        var ov = {};
        ov[key] = H.Steward.ExplorerTask.AdventureZoneLong;
        var q = planNames(H, '<b>A &amp; B</b>', ov);
        t.assert.strictEqual(q.length, 1, key);
        t.assert.strictEqual(q[0].params[2], H.Steward.ExplorerTask.AdventureZoneLong, key);
    });
});

t.test('plan queues the clean name as the dispatch label', function () {
    var H = harness.boot();
    var q = planNames(H, "<b>Ghost #2</b> <font size='-3'>(Ghost General)</font>", {});
    t.assert.strictEqual(q.length, 1);
    t.assert.strictEqual(q[0].params[1], 'Ghost #2 (Ghost General)');
});

// renderSection with the helpers a headless context lacks replaced; gridRow
// records its cells. Returns the recorded rows.
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
    H.Steward.modules.explorers.renderSection(H.host.$(), h);
    return rows;
}

t.test('the name cell escapes the decoded name', function () {
    var H = harness.boot();
    mount(H, [explorer(H, { name: 'A &amp; &lt;B&gt;', uid: 'e1' })]);
    var rows = renderRows(H, { overrides: {} });
    var row = rows[rows.length - 1];
    t.assert.strictEqual(row[0][1], 'A &amp; &lt;B&gt;');
});

t.test('the override star shows for an entity-form key only', function () {
    var H = harness.boot();
    mount(H, [explorer(H, { name: 'A &amp; &lt;B&gt;', uid: 'e1' })]);
    var rows = renderRows(H, { overrides: { 'A &amp; &lt;B&gt;': H.Steward.ExplorerTask.AdventureZoneLong } });
    var row = rows[rows.length - 1];
    t.assert.ok(/ \*$/.test(row[3][1]), String(row[3][1]));
    rows = renderRows(H, { overrides: {} });
    row = rows[rows.length - 1];
    t.assert.ok(!/ \*$/.test(row[3][1]), String(row[3][1]));
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

// An explorer whose busy state the test flips with spec.setBusy(bool).
function busyable(H, opts) {
    var s = explorer(H, opts);
    var task = null;
    s.GetTask = function () { return task; };
    s.IsInUse = function () { return !!task; };
    s.setBusy = function (on) { task = on ? H.specs.task(1, 1, 1000) : null; };
    return s;
}

// Mounts n idle explorers e1..en with dispatchDelay 0 and boots the module.
// Returns { specs, byUid, fire, plan }; plan() returns what that pass queued.
function guardedFleet(env, n) {
    var H = env.H;
    var specs = [];
    var byUid = {};
    for (var i = 1; i <= n; i++) {
        var s = busyable(H, { name: 'x' + i, uid: 'e' + i });
        specs.push(s);
        byUid['e' + i] = s;
    }
    var z = mount(H, specs);
    H.settings.write('explorers', { enabled: true, dispatchDelay: 0 });
    var fire = dispatchAction(H);
    return {
        specs: specs,
        byUid: byUid,
        zone: z,
        fire: fire,
        plan: function () {
            H.clearQueued();
            H.module('explorers').plan({ zone: { isHome: true } });
            return H.queued();
        }
    };
}

function fireAll(f, queued) {
    for (var i = 0; i < queued.length; i++) f.fire(queued[i].params);
}

function uidsOf(queued) {
    return queued.map(function (e) { return e.params[0]; }).sort();
}

t.test('guard: verified explorers are not sent again and each logs one verified line', function () {
    var env = guarded();
    var H = env.H;
    var f = guardedFleet(env, 2);
    H.Steward.core.specialists.send = function (spec) { spec.setBusy(true); return true; };

    var q = f.plan();
    t.assert.deepStrictEqual(uidsOf(q), ['e1', 'e2']);
    fireAll(f, q);
    env.T += env.g.VERIFY_MS;
    H.clearLogs();

    t.assert.strictEqual(f.plan().length, 0);
    var verified = H.logs().filter(function (l) {
        return l.level === 'log' && l.category === 'explorers' && /^verified /.test(String(l.args[0]));
    });
    t.assert.strictEqual(verified.length, 2);
    t.assert.ok(/uid e1\)/.test(verified.map(function (l) { return l.args[0]; }).join('|')));
    t.assert.ok(/uid e2\)/.test(verified.map(function (l) { return l.args[0]; }).join('|')));
});

t.test('guard: explorers still Idle within VERIFY_MS stay pending and are not queued', function () {
    var env = guarded();
    var f = guardedFleet(env, 2);
    env.H.Steward.core.specialists.send = function () { return true; };

    fireAll(f, f.plan());
    env.T += env.g.VERIFY_MS - 1;
    t.assert.strictEqual(f.plan().length, 0);
    t.assert.strictEqual(env.g.snapshot().pending, 2);
});

t.test('guard: explorers still Idle after VERIFY_MS are held, then queued after HOLD_BASE_MS', function () {
    var env = guarded();
    var f = guardedFleet(env, 2);
    env.H.Steward.core.specialists.send = function () { return true; };

    fireAll(f, f.plan());
    env.T += env.g.VERIFY_MS;
    t.assert.strictEqual(f.plan().length, 0, 'held');
    t.assert.strictEqual(env.g.snapshot().held, 2);
    env.T += env.g.HOLD_BASE_MS - 1;
    t.assert.strictEqual(f.plan().length, 0, 'still held');
    env.T += 1;
    t.assert.deepStrictEqual(uidsOf(f.plan()), ['e1', 'e2']);
});

t.test('guard: dispatch paths that send nothing leave nothing pending', function () {
    var cases = {
        'lookup ok:false': function (env, f) {
            env.H.Steward.core.specialists.lookup = function () { return { ok: false }; };
        },
        'not found': function (env, f) {
            f.zone.specialists([]);
        },
        'not idle': function (env, f) {
            f.byUid.e1.setBusy(true);
        },
        'send false': function (env) {
            env.H.Steward.core.specialists.send = function () { return false; };
        }
    };
    Object.keys(cases).forEach(function (name) {
        var env = guarded();
        var f = guardedFleet(env, 1);
        var c = env.H.Steward.core.specialists;
        var lookup = c.lookup;
        c.send = function () { return true; };
        var q = f.plan();
        t.assert.strictEqual(q.length, 1, name);
        cases[name](env, f);
        f.fire(q[0].params);

        c.lookup = lookup;
        f.zone.specialists(f.specs);
        f.byUid.e1.setBusy(false);
        t.assert.strictEqual(env.g.snapshot().pending, 0, name);
        t.assert.strictEqual(env.g.blocked('e1'), false, name);
        env.T += 1000;
        t.assert.deepStrictEqual(uidsOf(f.plan()), ['e1'], name);
    });
});

t.test('guard: the sent line carries the uid', function () {
    var env = guarded();
    var f = guardedFleet(env, 1);
    env.H.Steward.core.specialists.send = function () { return true; };
    fireAll(f, f.plan());
    var sent = env.H.logs().filter(function (l) {
        return l.level === 'log' && l.category === 'explorers' && l.args[0] === 'sent';
    });
    t.assert.strictEqual(sent.length, 1);
    t.assert.ok(/\(uid e1\)/.test(sent[0].args.join(' ')), sent[0].args.join(' '));
});

t.test('guard: a client that never applies a send is bounded to the batch plus probes', function () {
    var env = guarded();
    var H = env.H;
    var f = guardedFleet(env, 10);
    var sends = 0;
    H.Steward.core.specialists.send = function () { sends++; return true; };

    var STEP = 10000;
    var HOURS6 = 6 * 3600 * 1000;
    var end = env.T + HOURS6;
    var warns = 0;
    var openedBy = null;
    var start = env.T;
    while (env.T < end) {
        fireAll(f, f.plan());
        if (openedBy === null && env.g.isOpen()) openedBy = env.T - start;
        warns += H.logs().filter(function (l) {
            return l.level === 'warn' && l.category === 'specialists';
        }).length;
        H.clearLogs();
        env.T += STEP;
    }

    t.assert.strictEqual(openedBy, env.g.VERIFY_MS, 'opens at the first settle after VERIFY_MS');
    t.assert.strictEqual(warns, 1);
    var probes = Math.floor(HOURS6 / env.g.PROBE_COOLDOWN_MS);
    t.assert.ok(sends >= 10 && sends <= 10 + probes, 'sends ' + sends + ' (max ' + (10 + probes) + ')');
});
