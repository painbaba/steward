'use strict';

var t = require('../runner');
var harness = require('../harness');

// A guard with a test clock. T is read at call time, so a test moves time by
// assigning env.T.
function setup() {
    var H = harness.boot();
    var env = { H: H, T: 1000000 };
    env.g = H.Steward.core.specialists.sendGuard;
    env.g.clock = function () { return env.T; };
    return env;
}

// A specialist whose busy state the test flips with spec.setBusy(bool).
function spec(env, uid) {
    var s = env.H.specs.spec({ name: 'S-' + uid, uid: uid });
    var task = null;
    s.GetTask = function () { return task; };
    s.IsInUse = function () { return !!task; };
    s.setBusy = function (on) { task = on ? env.H.specs.task(1, 1, 1000) : null; };
    return s;
}

// Guard results come from the vm realm; compare them as plain data.
function same(actual, expected, msg) {
    t.assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, msg);
}

function lines(env, level, category, re) {
    return env.H.logs().filter(function (l) {
        return l.level === level && l.category === category &&
            (!re || re.test(String(l.args && l.args[0])));
    });
}

// Notes one send per uid for owner, then judges them all as missed.
function missAll(env, owner, uids) {
    var list = uids.map(function (u) { return spec(env, u); });
    uids.forEach(function (u) { env.g.note(owner, u, 'S-' + u, 'tag'); });
    env.T += env.g.VERIFY_MS;
    return env.g.settle(owner, list, true);
}

t.test('a busy specialist after a send verifies and clears pending, hold and run', function () {
    var env = setup();
    var g = env.g;
    var a = spec(env, 'uid-a1');
    g.note('explorers', 'uid-a1', 'A', 'Short');
    env.T += g.VERIFY_MS;
    same(g.settle('explorers', [a], true), { verified: 0, missed: 1 });
    t.assert.strictEqual(g.snapshot().run, 1);
    t.assert.strictEqual(g.blocked('uid-a1'), true);
    env.H.clearLogs();

    g.note('explorers', 'uid-a1', 'A', 'Short');
    a.setBusy(true);
    env.T += 10000;
    same(g.settle('explorers', [a], true), { verified: 1, missed: 0 });

    var snap = g.snapshot();
    t.assert.strictEqual(snap.pending, 0);
    t.assert.strictEqual(snap.held, 0);
    t.assert.strictEqual(snap.run, 0);
    t.assert.strictEqual(g.blocked('uid-a1'), false);
    var v = lines(env, 'log', 'explorers', /verified/);
    t.assert.strictEqual(v.length, 1);
    t.assert.ok(/uid-a1/.test(v[0].args[0]), v[0].args[0]);
});

t.test('an Idle reading younger than VERIFY_MS stays pending and blocks', function () {
    var env = setup();
    var g = env.g;
    var a = spec(env, 'a');
    g.note('explorers', 'a', 'A', 'Short');
    env.T += g.VERIFY_MS - 1;
    same(g.settle('explorers', [a], true), { verified: 0, missed: 0 });
    t.assert.strictEqual(g.blocked('a'), true);
    t.assert.strictEqual(g.snapshot().pending, 1);
});

t.test('a miss holds HOLD_BASE_MS, doubles per miss and caps at HOLD_MAX_MS', function () {
    var env = setup();
    var g = env.g;
    var a = spec(env, 'a');
    var expect = [g.HOLD_BASE_MS, 2 * g.HOLD_BASE_MS, 4 * g.HOLD_BASE_MS,
                  8 * g.HOLD_BASE_MS, g.HOLD_MAX_MS, g.HOLD_MAX_MS];
    t.assert.ok(8 * g.HOLD_BASE_MS < g.HOLD_MAX_MS && 16 * g.HOLD_BASE_MS > g.HOLD_MAX_MS);
    for (var i = 0; i < expect.length; i++) {
        g.note('explorers', 'a', 'A', 'Short');
        env.T += g.VERIFY_MS;
        same(g.settle('explorers', [a], true), { verified: 0, missed: 1 }, 'miss ' + i);
        var at = env.T;
        env.T = at + expect[i] - 1;
        t.assert.strictEqual(g.blocked('a'), true, 'held before expiry, miss ' + (i + 1));
        env.T = at + expect[i];
        t.assert.strictEqual(g.blocked('a'), false, 'free at expiry, miss ' + (i + 1));
    }
    var last = lines(env, 'log', 'explorers', /did not leave Idle/);
    t.assert.strictEqual(last.length, expect.length);
    t.assert.ok(/held 60 min/.test(last[last.length - 1].args[0]), last[last.length - 1].args[0]);
});

t.test('a read that dropped entries never misses, but a busy entry still verifies', function () {
    var env = setup();
    var g = env.g;
    var a = spec(env, 'a');
    var b = spec(env, 'b');
    g.note('explorers', 'a', 'A', 'Short');
    g.note('explorers', 'b', 'B', 'Short');
    b.setBusy(true);
    env.T += g.VERIFY_MS + 1000;
    same(g.settle('explorers', [a, b], false), { verified: 1, missed: 0 });
    t.assert.strictEqual(g.blocked('a'), true);
    t.assert.strictEqual(g.blocked('b'), false);
    t.assert.strictEqual(g.snapshot().run, 0);
});

t.test('an entry absent past STALE_MS is dropped without counting or holding', function () {
    var env = setup();
    var g = env.g;
    missAll(env, 'explorers', ['m1']);
    t.assert.strictEqual(g.snapshot().run, 1);
    g.note('explorers', 'a', 'A', 'Short');
    env.T += g.STALE_MS + 1;
    env.H.clearLogs();
    same(g.settle('explorers', [], true), { verified: 0, missed: 0 });
    var snap = g.snapshot();
    t.assert.strictEqual(snap.pending, 0);
    t.assert.strictEqual(snap.run, 1);
    t.assert.strictEqual(g.blocked('a'), false);
    t.assert.strictEqual(lines(env, 'debug', 'explorers').length, 1);
});

t.test('an Idle reading older than STALE_MS is dropped without a miss', function () {
    var env = setup();
    var g = env.g;
    var a = spec(env, 'a');
    g.note('explorers', 'a', 'A', 'Short');
    env.T += g.STALE_MS + 1;
    same(g.settle('explorers', [a], true), { verified: 0, missed: 0 });
    var snap = g.snapshot();
    t.assert.strictEqual(snap.pending, 0);
    t.assert.strictEqual(snap.held, 0);
    t.assert.strictEqual(snap.run, 0);
    t.assert.strictEqual(g.blocked('a'), false);
});

// Four misses and one verify judged in one settle; the list order is the
// reverse of the send order, so only sorting by sentAt gives the right run.
function orderRun(verifyLast) {
    var env = setup();
    var g = env.g;
    var uids = verifyLast ? ['m1', 'm2', 'm3', 'm4', 'v'] : ['v', 'm1', 'm2', 'm3', 'm4'];
    var list = [];
    for (var i = 0; i < uids.length; i++) {
        var s = spec(env, uids[i]);
        if (uids[i] === 'v') s.setBusy(true);
        g.note('explorers', uids[i], uids[i], 'Short');
        list.unshift(s);
        env.T += 1000;
    }
    env.T += g.VERIFY_MS;
    same(g.settle('explorers', list, true), { verified: 1, missed: 4 });
    return g.snapshot().run;
}

t.test('misses and verifies in one settle apply in send order', function () {
    t.assert.strictEqual(orderRun(true), 0, 'a verify sent after the misses resets the run');
    t.assert.strictEqual(orderRun(false), 4, 'a verify sent before the misses leaves 4');
});

t.test('BREAKER_MISSES misses across both owners open the breaker with one warn', function () {
    var env = setup();
    var g = env.g;
    t.assert.strictEqual(g.BREAKER_MISSES, 5);
    missAll(env, 'explorers', ['e1', 'e2', 'e3']);
    t.assert.strictEqual(g.isOpen(), false);
    missAll(env, 'geologists', ['g1', 'g2']);
    t.assert.strictEqual(g.isOpen(), true);
    t.assert.strictEqual(lines(env, 'warn', 'specialists').length, 1);
    missAll(env, 'explorers', ['e4', 'e5']);
    missAll(env, 'geologists', ['g3']);
    t.assert.strictEqual(lines(env, 'warn', 'specialists').length, 1);
    t.assert.strictEqual(g.snapshot().run, 8);
});

t.test('admit gives n when closed and one probe per cooldown when open', function () {
    var env = setup();
    var g = env.g;
    t.assert.strictEqual(g.admit(4), 4);
    t.assert.strictEqual(g.admit(0), 0);
    missAll(env, 'explorers', ['a', 'b', 'c', 'd', 'e']);
    var openedAt = env.T;
    t.assert.strictEqual(g.snapshot().nextProbeAt, openedAt + g.PROBE_COOLDOWN_MS);
    t.assert.strictEqual(g.admit(3), 0);
    env.T = openedAt + g.PROBE_COOLDOWN_MS - 1;
    t.assert.strictEqual(g.admit(3), 0);
    env.T = openedAt + g.PROBE_COOLDOWN_MS;
    t.assert.strictEqual(g.admit(3), 1, 'first caller gets the probe');
    t.assert.strictEqual(g.admit(2), 0, 'second caller gets nothing');
});

function openAndProbe(env) {
    var g = env.g;
    missAll(env, 'explorers', ['a', 'b', 'c', 'd', 'e']);
    env.T = g.snapshot().nextProbeAt;
    t.assert.strictEqual(g.admit(5), 1);
    var p = spec(env, 'p');
    g.note('explorers', 'p', 'P', 'Short');
    return p;
}

t.test('a probe that verifies closes the breaker with one log', function () {
    var env = setup();
    var g = env.g;
    var p = openAndProbe(env);
    p.setBusy(true);
    env.T += 20000;
    env.H.clearLogs();
    same(g.settle('explorers', [p], true), { verified: 1, missed: 0 });
    t.assert.strictEqual(g.isOpen(), false);
    t.assert.strictEqual(lines(env, 'log', 'specialists', /closed/).length, 1);
    t.assert.strictEqual(g.admit(3), 3);
});

t.test('a probe that misses leaves the breaker open until the next cooldown', function () {
    var env = setup();
    var g = env.g;
    var p = openAndProbe(env);
    var probeAt = env.T;
    env.T += g.VERIFY_MS;
    same(g.settle('explorers', [p], true), { verified: 0, missed: 1 });
    t.assert.strictEqual(g.isOpen(), true);
    t.assert.strictEqual(g.admit(5), 0);
    env.T = probeAt + g.PROBE_COOLDOWN_MS - 1;
    t.assert.strictEqual(g.admit(5), 0);
    env.T = probeAt + g.PROBE_COOLDOWN_MS;
    t.assert.strictEqual(g.admit(5), 1);
});

t.test('a settle for one owner ignores the other owner\'s pending entries', function () {
    var env = setup();
    var g = env.g;
    var g1 = spec(env, 'g1');
    g1.setBusy(true);
    g.note('geologists', 'g1', 'G1', 'IronOre');
    g.note('geologists', 'g2', 'G2', 'IronOre');
    env.T += g.STALE_MS + 1;
    same(g.settle('explorers', [g1], true), { verified: 0, missed: 0 });
    t.assert.strictEqual(g.snapshot().pending, 2, 'neither judged nor dropped');
    same(g.pendingTags('geologists'), ['IronOre', 'IronOre']);
    same(g.pendingTags('explorers'), []);
    same(g.settle('geologists', [g1], true), { verified: 1, missed: 0 });
    t.assert.strictEqual(g.snapshot().pending, 0, 'g2 dropped as stale by its own owner');
});
