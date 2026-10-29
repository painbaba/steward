'use strict';

var t = require('../runner');
var harness = require('../harness');

var assert = t.assert;

function boot() {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    return { H: H, S: H.Steward, A: H.Steward.core.actions };
}

// Runs the captured 'core.attempt' entries until none are queued. onStep(n)
// runs after the n-th round so a test can change state between polls.
function drive(b, onStep) {
    var rounds = 0;
    var delays = [];
    for (var n = 0; n < 50; n++) {
        var entries = b.H.queued().filter(function (e) { return e.name === b.A.STEP; });
        if (entries.length === 0) break;
        b.H.clearQueued();
        for (var i = 0; i < entries.length; i++) {
            delays.push(entries[i].delay);
            b.A.step(entries[i].params);
        }
        rounds++;
        if (onStep) onStep(rounds);
    }
    return { rounds: rounds, delays: delays };
}

function gap(b) { return b.S.kernel.TIMEOUTS.QUEUE_ACTION_GAP_MS; }

// A def whose effect appears when world.done is set; send counts calls.
function def(world, extra) {
    var d = {
        label:     'test action',
        category:  'testcat',
        send:      function () { world.sends++; return true; },
        check:     function () { return world.done === true; },
        timeoutMs: 1
    };
    var keys = Object.keys(extra || {});
    for (var i = 0; i < keys.length; i++) d[keys[i]] = extra[keys[i]];
    return d;
}

function run(b, d, onStep) {
    var results = [];
    var ok = b.A.attempt(d, function (r) { results.push(r); });
    var drove = drive(b, onStep);
    return { ok: ok, results: results, drove: drove };
}

function logsAt(b, level, category) {
    return b.H.logs().filter(function (l) { return l.level === level && l.category === category; });
}

t.test('verified on the first check after one send', function () {
    var b = boot();
    var world = { sends: 0, done: false };
    var d = def(world, { send: function () { world.sends++; world.done = true; return true; } });
    var r = run(b, d);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.results.length, 1);
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Verified);
    assert.strictEqual(r.results[0].sends, 1);
    assert.strictEqual(r.results[0].reason, '');
    assert.strictEqual(r.results[0].label, 'test action');
    assert.strictEqual(world.sends, 1);
    assert.strictEqual(logsAt(b, 'log', 'testcat').length, 1);
});

t.test('satisfied before the first send verifies with zero sends', function () {
    var b = boot();
    var world = { sends: 0 };
    var r = run(b, def(world, { satisfied: function () { return true; } }));
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Verified);
    assert.strictEqual(r.results[0].sends, 0);
    assert.strictEqual(world.sends, 0);
});

t.test('precheck reason refuses without sending', function () {
    var b = boot();
    var world = { sends: 0 };
    var r = run(b, def(world, { precheck: function () { return 'general busy'; } }));
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Refused);
    assert.strictEqual(r.results[0].reason, 'general busy');
    assert.strictEqual(r.results[0].sends, 0);
    assert.strictEqual(world.sends, 0);
    assert.strictEqual(logsAt(b, 'warn', 'testcat').length, 1);
});

t.test('timeout then retry then verified', function () {
    var b = boot();
    var world = { sends: 0, done: false };
    // Window of three polls; the effect appears only after the second send.
    var d = def(world, {
        timeoutMs: 3 * gap(b),
        send: function () { world.sends++; if (world.sends === 2) world.done = true; return true; }
    });
    var r = run(b, d);
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Verified);
    assert.strictEqual(r.results[0].sends, 2);
    assert.strictEqual(world.sends, 2);
    var retried = logsAt(b, 'warn', 'testcat').filter(function (l) {
        return String(l.args[0]).indexOf('not observed, retrying') !== -1;
    });
    assert.strictEqual(retried.length, 1);
});

t.test('two timeouts fail after exactly two sends', function () {
    var b = boot();
    var world = { sends: 0, done: false };
    var d = def(world, { timeoutMs: 2 * gap(b) });
    var r = run(b, d);
    assert.strictEqual(r.results.length, 1);
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Failed);
    assert.strictEqual(r.results[0].sends, 2);
    assert.strictEqual(r.results[0].reason, 'not observed within ' + (2 * gap(b)) + ' ms');
    assert.strictEqual(world.sends, 2);
    // send, 2 checks, send, 2 checks.
    assert.strictEqual(r.drove.rounds, 6);
});

t.test('retry checks the effect first and does not resend when it arrived late', function () {
    var b = boot();
    var world = { sends: 0, done: false };
    var d = def(world, { timeoutMs: gap(b) });
    // Round 1 sends, round 2 checks and times out; the effect lands before
    // the retry step runs.
    var r = run(b, d, function (n) { if (n === 2) world.done = true; });
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Verified);
    assert.strictEqual(r.results[0].sends, 1);
    assert.strictEqual(world.sends, 1);
});

t.test('a precheck failing on retry fails with retry refused', function () {
    var b = boot();
    var world = { sends: 0, done: false };
    var d = def(world, {
        timeoutMs: gap(b),
        precheck:  function () { return world.sends > 0 ? 'target gone' : null; }
    });
    var r = run(b, d);
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Failed);
    assert.strictEqual(r.results[0].reason, 'retry refused: target gone');
    assert.strictEqual(r.results[0].sends, 1);
    assert.strictEqual(world.sends, 1);
});

t.test('send returning false retries once then fails', function () {
    var b = boot();
    var world = { sends: 0, checks: 0 };
    var d = def(world, {
        send:  function () { world.sends++; return false; },
        check: function () { world.checks++; return false; }
    });
    var r = run(b, d);
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Failed);
    assert.strictEqual(r.results[0].reason, 'send failed');
    assert.strictEqual(r.results[0].sends, 2);
    assert.strictEqual(world.sends, 2);
    // Only the retry looks for a late effect; no check phase ran.
    assert.strictEqual(world.checks, 1);
});

t.test('a throwing send counts as not sent', function () {
    var b = boot();
    var world = { sends: 0 };
    var d = def(world, { send: function () { world.sends++; throw new Error('boom'); } });
    var r = run(b, d);
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Failed);
    assert.strictEqual(r.results[0].reason, 'send failed');
    assert.strictEqual(world.sends, 2);
});

t.test('baseline is read once and passed to send and check', function () {
    var b = boot();
    var world = { sends: 0, baselines: 0, seen: [] };
    var base = { stock: 5 };
    var d = def(world, {
        timeoutMs: gap(b),
        baseline:  function () { world.baselines++; return base; },
        send:      function (x) { world.sends++; world.seen.push(x); return true; },
        check:     function (x) { world.seen.push(x); return world.sends === 2; },
        describe:  function (x) { world.seen.push(x); return 'stock ' + x.stock; }
    });
    var r = run(b, d);
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Verified);
    assert.strictEqual(world.baselines, 1);
    assert.ok(world.seen.length >= 4);
    for (var i = 0; i < world.seen.length; i++) assert.strictEqual(world.seen[i], base);
    var line = logsAt(b, 'log', 'testcat')[0];
    assert.ok(String(line.args[0]).indexOf('stock 5') !== -1);
});

t.test('throwing check counts as not observed', function () {
    var b = boot();
    var world = { sends: 0 };
    var d = def(world, { check: function () { throw new Error('read failed'); } });
    var r = run(b, d);
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Failed);
    assert.strictEqual(r.results[0].sends, 2);
    assert.ok(logsAt(b, 'warn', 'testcat').some(function (l) {
        return String(l.args[0]).indexOf('check threw') !== -1;
    }));
});

t.test('throwing satisfied counts as not satisfied and sends', function () {
    var b = boot();
    var world = { sends: 0 };
    var d = def(world, {
        satisfied: function () { throw new Error('nope'); },
        send:      function () { world.sends++; world.done = true; return true; }
    });
    var r = run(b, d);
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Verified);
    assert.strictEqual(r.results[0].sends, 1);
    assert.strictEqual(world.sends, 1);
});

t.test('throwing precheck refuses with precheck threw', function () {
    var b = boot();
    var world = { sends: 0 };
    var r = run(b, def(world, { precheck: function () { throw new Error('x'); } }));
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Refused);
    assert.strictEqual(r.results[0].reason, 'precheck threw');
    assert.strictEqual(world.sends, 0);
});

t.test('throwing onDone is logged', function () {
    var b = boot();
    var world = { sends: 0, done: true };
    var ok = b.A.attempt(def(world, { satisfied: function () { return true; } }), function () {
        throw new Error('caller bug');
    });
    assert.strictEqual(ok, true);
    drive(b);
    var errors = logsAt(b, 'error', 'testcat');
    assert.strictEqual(errors.length, 1);
    assert.ok(String(errors[0].args[0]).indexOf('onDone threw') !== -1);
});

t.test('every step entry carries the poll gap', function () {
    var b = boot();
    var world = { sends: 0, done: false };
    var r = run(b, def(world, { timeoutMs: 2 * gap(b) }));
    assert.strictEqual(r.drove.delays.length, 6);
    for (var i = 0; i < r.drove.delays.length; i++) assert.strictEqual(r.drove.delays[i], gap(b));
});

t.test('invalid def is rejected and nothing is queued', function () {
    var b = boot();
    var world = { sends: 0 };
    var bad = [
        null,
        'move',
        def(world, { send: null }),
        def(world, { check: 'yes' }),
        def(world, { timeoutMs: 0 }),
        def(world, { timeoutMs: '1000' })
    ];
    for (var i = 0; i < bad.length; i++) {
        assert.strictEqual(b.A.attempt(bad[i], function () {}), false);
    }
    assert.strictEqual(b.H.queued().length, 0);
    assert.strictEqual(b.H.logs().filter(function (l) { return l.level === 'error'; }).length, bad.length);
});

t.test('result enum and exports are filled', function () {
    var b = boot();
    assert.strictEqual(b.S.ActionResult.Verified, 'ActionVerified');
    assert.strictEqual(b.S.ActionResult.Refused, 'ActionRefused');
    assert.strictEqual(b.S.ActionResult.Failed, 'ActionFailed');
    assert.strictEqual(b.A.RETRIES, 1);
    assert.strictEqual(b.A.STEP, 'core.attempt');
});

t.test('the step handler is registered with the kernel queue', function () {
    var b = boot();
    // Registering the name again warns only when a handler already exists.
    b.S.kernel.queue.action(b.A.STEP, function () {});
    var replaced = b.H.logs().filter(function (l) {
        return l.level === 'warn' && l.category === 'queue' &&
            l.args.join(' ').indexOf('replacing previous handler') !== -1;
    });
    assert.strictEqual(replaced.length, 1);
});
