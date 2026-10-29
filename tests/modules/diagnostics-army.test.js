'use strict';

var t = require('../runner');
var harness = require('../harness');

var SAMPLE_MS = 5000;

// Capturing timers: every setTimeout is kept with its callback and delay so
// a case can fire the sampler's ticks by hand.
function makeTimers() {
    var list = [];
    var nextId = 1;
    return {
        list: list,
        setTimeout: function (fn, ms) {
            var e = { fn: fn, ms: ms, id: nextId++, cleared: false };
            list.push(e);
            return e.id;
        },
        clearTimeout: function (id) {
            for (var i = 0; i < list.length; i++) if (list[i].id === id) list[i].cleared = true;
        }
    };
}

// Sampler timers armed after index `from` (the lifecycle's deferred boot
// also goes through setTimeout and is ignored).
function samplerTimers(timers, from) {
    var out = [];
    for (var i = from; i < timers.list.length; i++) {
        if (timers.list[i].ms === SAMPLE_MS) out.push(timers.list[i]);
    }
    return out;
}

function pending(timers, from) {
    var out = [];
    var all = samplerTimers(timers, from);
    for (var i = 0; i < all.length; i++) {
        if (!all[i].cleared && !all[i].fired) out.push(all[i]);
    }
    return out;
}

function fire(entry) {
    entry.fired = true;
    entry.fn();
}

function setup() {
    var timers = makeTimers();
    var H = harness.boot({ timers: { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout } });
    return { H: H, timers: timers, army: H.Steward.modules.diagnostics.army };
}

function count(logs, category, re) {
    var n = 0;
    for (var i = 0; i < logs.length; i++) {
        if (logs[i].category !== category) continue;
        if (!re || re.test(String(logs[i].args[0]))) n++;
    }
    return n;
}

t.test('toggleSampler starts the sampler with one pending timer', function () {
    var s = setup();
    var from = s.timers.list.length;
    t.assert.strictEqual(s.army.toggleSampler(), true);
    t.assert.strictEqual(s.army.samplerRunning(), true);
    t.assert.strictEqual(pending(s.timers, from).length, 1);
    t.assert.strictEqual(s.H.queued().length, 0);
});

t.test('sampler stops itself after 36 samples', function () {
    var s = setup();
    var from = s.timers.list.length;
    s.army.toggleSampler();
    for (var i = 0; i < 36; i++) {
        var p = pending(s.timers, from);
        t.assert.strictEqual(p.length, 1, 'one timer pending before sample ' + (i + 1));
        fire(p[0]);
    }
    t.assert.strictEqual(s.army.samplerRunning(), false);
    t.assert.strictEqual(pending(s.timers, from).length, 0);
    t.assert.strictEqual(samplerTimers(s.timers, from).length, 36);
    t.assert.strictEqual(count(s.H.logs(), 'diag:sample', /^--- generals sample /), 36);
    t.assert.strictEqual(s.H.queued().length, 0);
});

t.test('toggle while running stops it and a stale callback does nothing', function () {
    var s = setup();
    var from = s.timers.list.length;
    s.army.toggleSampler();
    var p = pending(s.timers, from);
    t.assert.strictEqual(p.length, 1);
    t.assert.strictEqual(s.army.toggleSampler(), false);
    t.assert.strictEqual(s.army.samplerRunning(), false);
    t.assert.strictEqual(p[0].cleared, true);

    s.H.clearLogs();
    p[0].fn();
    t.assert.strictEqual(count(s.H.logs(), 'diag:sample'), 0);
    t.assert.strictEqual(samplerTimers(s.timers, from).length, 1);
    t.assert.strictEqual(s.H.queued().length, 0);
});

t.test('a pending tick after a script reload stops without dumping or re-arming', function () {
    var s = setup();
    var from = s.timers.list.length;
    s.army.toggleSampler();
    var p = pending(s.timers, from);
    t.assert.strictEqual(p.length, 1);

    var H2 = harness.reload(s.H);
    var afterReload = s.timers.list.length;
    s.H.clearLogs();
    H2.clearLogs();

    fire(p[0]);

    var all = s.H.logs().concat(H2.logs());
    t.assert.strictEqual(count(all, 'diag:sample'), 0);
    t.assert.strictEqual(count(all, 'diag', /^sampler stopped: script reloaded$/), 1);
    t.assert.strictEqual(samplerTimers(s.timers, afterReload).length, 0);
    t.assert.strictEqual(H2.Steward.modules.diagnostics.army.samplerRunning(), false);
    t.assert.strictEqual(s.H.queued().length, 0);
    t.assert.strictEqual(H2.queued().length, 0);
});

t.test('dumps do not throw on the bare host stubs', function () {
    var s = setup();
    s.army.dumpGenerals();
    s.army.dumpGenerals('diag:sample', 'sample 1/36');
    s.army.dumpArmy();
    s.army.dumpQuests();
    s.army.dumpAdventures();
    s.army.dumpDefinitions();
    t.assert.strictEqual(s.H.queued().length, 0);
    t.assert.ok(count(s.H.logs(), 'diag:army') > 0);
});

t.test('inspect.TASK_GETTERS holds the seven task getters', function () {
    var H = harness.boot();
    // Copied into this realm: the list was built inside the vm context.
    var list = Array.prototype.slice.call(H.Steward.modules.diagnostics.inspect.TASK_GETTERS);
    t.assert.deepStrictEqual(list, [
        'GetType', 'GetOriginalType', 'GetSubType', 'GetState',
        'IsRunning', 'GetRemainingTime', 'GetNewGarrisonGridIdx'
    ]);
});
