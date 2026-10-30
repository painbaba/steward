'use strict';

var t = require('../runner');
var harness = require('../harness');

t.test('tick visits ready modules in registration order on first walk', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var seen = [];
    H.Steward.kernel.register({
        id: 'a', priority: H.Steward.Priority.Normal,
        isReady: function () { return true; },
        plan: function () { seen.push('a'); }
    });
    H.Steward.kernel.register({
        id: 'b', priority: H.Steward.Priority.Normal,
        isReady: function () { return true; },
        plan: function () { seen.push('b'); }
    });
    H.Steward.kernel.scheduler.state.running = true;
    H.Steward.kernel.scheduler.tick();
    t.assert.deepStrictEqual(seen, ['a', 'b']);
});

t.test('isReady=false skips plan', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var planned = false;
    H.Steward.kernel.register({
        id: 'gated', priority: H.Steward.Priority.Normal,
        isReady: function () { return false; },
        plan: function () { planned = true; }
    });
    H.Steward.kernel.scheduler.state.running = true;
    H.Steward.kernel.scheduler.tick();
    t.assert.strictEqual(planned, false);
});

t.test('plan throw is caught and logged, not propagated', function () {
    var H = harness.boot({ sections: ['kernel'] });
    H.Steward.kernel.register({
        id: 'bomb', priority: H.Steward.Priority.Normal,
        isReady: function () { return true; },
        plan: function () { throw new Error('boom'); }
    });
    H.Steward.kernel.scheduler.state.running = true;
    H.Steward.kernel.scheduler.tick();   // should not throw
    var errors = H.logs().filter(function (l) {
        return l.level === 'error' && l.category === 'scheduler';
    });
    t.assert.strictEqual(errors.length, 1);
});

// Recording timers: every live timeout keeps its callback and delay, so a test
// can fire one by hand and read which delay was armed.
function makeTimers() {
    var nextId = 1;
    var live = {};
    return {
        setTimeout:    function (fn, ms) { var id = nextId++; live[id] = { fn: fn, ms: ms }; return id; },
        clearTimeout:  function (id) { delete live[id]; },
        setInterval:   function () { return 0; },
        clearInterval: function () {},
        ids:           function () { return Object.keys(live); },
        get:           function (id) { return live[id]; },
        fire:          function (id) { var e = live[id]; delete live[id]; e.fn(); }
    };
}

// Boots the kernel with two modules that count their plans, and a started
// scheduler. The first tick has run, so only the next tick timer and wakes are live.
function wakeSetup() {
    var timers = makeTimers();
    var H = harness.boot({ sections: ['kernel'], timers: timers });
    var K = H.Steward.kernel;
    var o = { H: H, K: K, timers: timers, plansA: 0, plansB: 0, readyA: true, readyCalls: 0 };
    K.register({
        id: 'a', priority: H.Steward.Priority.Normal,
        isReady: function () { o.readyCalls++; return o.readyA; },
        plan: function () { o.plansA++; if (o.onPlanA) o.onPlanA(); }
    });
    K.register({
        id: 'b', priority: H.Steward.Priority.Normal,
        isReady: function () { return true; },
        plan: function () { o.plansB++; }
    });
    K.scheduler.start();
    timers.fire(K.scheduler.state.timer);   // the first tick; it arms the next tick
    // Timers other than the tick, from boot or the kernel, are not wakes.
    var others = timers.ids().filter(function (id) { return String(id) !== String(K.scheduler.state.timer); });
    o.wakeIds = function () {
        return timers.ids().filter(function (id) {
            return String(id) !== String(K.scheduler.state.timer) && others.indexOf(id) < 0;
        });
    };
    return o;
}

t.test('wake runs exactly one plan of that module', function () {
    var o = wakeSetup();
    var tickPlansB = o.plansB;
    var tickPlansA = o.plansA;
    t.assert.strictEqual(o.K.scheduler.wake('a', 1000), true);
    var ids = o.wakeIds();
    t.assert.strictEqual(ids.length, 1);
    o.timers.fire(ids[0]);
    t.assert.strictEqual(o.plansA, tickPlansA + 1);
    t.assert.strictEqual(o.plansB, tickPlansB);
    t.assert.strictEqual(o.wakeIds().length, 0);
});

t.test('wake leaves tickCount, cursors and the tick timer unchanged', function () {
    var o = wakeSetup();
    var st = o.K.scheduler.state;
    var count = st.tickCount;
    var cursors = JSON.stringify(st.cursors);
    var timer = st.timer;
    o.K.scheduler.wake('a', 1000);
    o.timers.fire(o.wakeIds()[0]);
    t.assert.strictEqual(st.tickCount, count);
    t.assert.strictEqual(JSON.stringify(st.cursors), cursors);
    t.assert.strictEqual(st.timer, timer);
    t.assert.ok(o.timers.get(timer));
});

t.test('wake of a busy module skips isReady and plan and re-arms the recheck', function () {
    var o = wakeSetup();
    o.K.queue.isModuleBusy = function (id) { return id === 'a'; };
    o.K.scheduler.wake('a', 1000);
    var readyBefore = o.readyCalls;
    var plansBefore = o.plansA;
    o.timers.fire(o.wakeIds()[0]);
    t.assert.strictEqual(o.readyCalls, readyBefore);
    t.assert.strictEqual(o.plansA, plansBefore);
    var ids = o.wakeIds();
    t.assert.strictEqual(ids.length, 1);
    t.assert.strictEqual(o.timers.get(ids[0]).ms, o.K.TIMEOUTS.WAKE_BUSY_RECHECK_MS);
});

t.test('wake with isReady false plans nothing and re-arms nothing', function () {
    var o = wakeSetup();
    o.readyA = false;
    o.K.scheduler.wake('a', 1000);
    var plansBefore = o.plansA;
    o.timers.fire(o.wakeIds()[0]);
    t.assert.strictEqual(o.plansA, plansBefore);
    t.assert.strictEqual(o.wakeIds().length, 0);
});

t.test('a throwing plan inside a wake is caught and logged', function () {
    var o = wakeSetup();
    o.onPlanA = function () { throw new Error('boom'); };
    o.H.clearLogs();
    o.K.scheduler.wake('a', 1000);
    o.timers.fire(o.wakeIds()[0]);
    var errors = o.H.logs().filter(function (l) {
        return l.level === 'error' && l.category === 'scheduler';
    });
    t.assert.strictEqual(errors.length, 1);
});

t.test('wake(id, 0) arms the floor, tags the plan queue entries and drains', function () {
    var o = wakeSetup();
    o.onPlanA = function () { o.K.queue.add('noop', [], 10); };
    var drained = 0;
    o.K.queue.drain = function () { drained++; };
    o.H.clearQueued();
    o.K.scheduler.wake('a', 0);
    var ids = o.wakeIds();
    t.assert.strictEqual(o.timers.get(ids[0]).ms, o.K.TIMEOUTS.WAKE_MIN_MS);
    o.timers.fire(ids[0]);
    var q = o.H.queued();
    t.assert.strictEqual(q.length, 1);
    t.assert.strictEqual(q[0].moduleId, 'a');
    t.assert.strictEqual(drained, 1);
    t.assert.ok(!o.K._currentModule);
});

t.test('earliest wake wins: a sooner call replaces, a later call returns false', function () {
    var o = wakeSetup();
    t.assert.strictEqual(o.K.scheduler.wake('a', 5000), true);
    var first = o.wakeIds()[0];
    t.assert.strictEqual(o.K.scheduler.wake('a', 300), true);
    var ids = o.wakeIds();
    t.assert.strictEqual(ids.length, 1);
    t.assert.notStrictEqual(ids[0], first);
    t.assert.strictEqual(o.timers.get(ids[0]).ms, 300);
    t.assert.strictEqual(o.K.scheduler.wake('a', 5000), false);
    t.assert.strictEqual(o.wakeIds().length, 1);
    t.assert.strictEqual(o.wakeIds()[0], ids[0]);
});

t.test('plan may re-arm its own wake', function () {
    var o = wakeSetup();
    var rearm = null;
    o.onPlanA = function () { rearm = o.K.scheduler.wake('a', 1000); };
    o.K.scheduler.wake('a', 1000);
    o.timers.fire(o.wakeIds()[0]);
    t.assert.strictEqual(rearm, true);
    t.assert.strictEqual(o.wakeIds().length, 1);
});

t.test('wake while not running or for an unknown id is false and arms nothing', function () {
    var o = wakeSetup();
    t.assert.strictEqual(o.K.scheduler.wake('nope', 1000), false);
    t.assert.strictEqual(o.wakeIds().length, 0);
    o.K.scheduler.stop();
    t.assert.strictEqual(o.K.scheduler.wake('a', 1000), false);
    t.assert.strictEqual(o.wakeIds().length, 0);
});

t.test('stop clears pending wakes and a stale fired callback does nothing', function () {
    var o = wakeSetup();
    o.K.scheduler.wake('a', 1000);
    var id = o.wakeIds()[0];
    var stale = o.timers.get(id).fn;
    o.K.scheduler.stop();
    t.assert.strictEqual(o.wakeIds().length, 0);
    t.assert.deepStrictEqual(Object.keys(o.K.scheduler.state.wakes), []);
    var plansBefore = o.plansA;
    stale();
    t.assert.strictEqual(o.plansA, plansBefore);
    t.assert.strictEqual(o.wakeIds().length, 0);
});
