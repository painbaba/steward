'use strict';

var t = require('../runner');
var harness = require('../harness');

// Recording timer stubs: ids come from a counter and every live timeout and
// interval is kept with its callback, so a test can tell which timers a
// teardown cleared.
function makeTimers() {
    var nextId = 1;
    var timeouts = {};
    var intervals = {};
    return {
        setTimeout:    function (fn) { var id = nextId++; timeouts[id] = fn; return id; },
        clearTimeout:  function (id) { delete timeouts[id]; },
        setInterval:   function (fn) { var id = nextId++; intervals[id] = fn; return id; },
        clearInterval: function (id) { delete intervals[id]; },
        liveTimeouts:  function () { return Object.keys(timeouts); },
        liveIntervals: function () { return Object.keys(intervals); }
    };
}

function setup() {
    var timers = makeTimers();
    var H = harness.boot({ sections: ['kernel'], timers: timers });
    return { H: H, timers: timers };
}

// Starts the first instance's scheduler and keeps handles to everything the
// reload must stop, plus a call counter on the old queue.reset.
function capturePrevious(s) {
    var k = s.H.Steward.kernel;
    k.scheduler.start();
    var prev = {
        scheduler:  k.scheduler,
        lifecycle:  k.lifecycle,
        queue:      k.queue,
        intervalId: s.timers.liveIntervals()[0],
        timerId:    String(k.scheduler.state.timer),
        resetCalls: 0
    };
    var origReset = k.queue.reset;
    k.queue.reset = function () {
        prev.resetCalls++;
        return origReset.apply(k.queue, arguments);
    };
    return prev;
}

function reloadMentioned(H) {
    var logs = H.logs();
    for (var i = 0; i < logs.length; i++) {
        if (logs[i].category === 'lifecycle' && /reload/.test(String(logs[i].args[0]))) return true;
    }
    return false;
}

t.test('first load performs no teardown', function () {
    var s = setup();
    t.assert.strictEqual(reloadMentioned(s.H), false);
    t.assert.strictEqual(s.timers.liveIntervals().length, 1);
});

t.test('reload stops the previous instance', function () {
    var s = setup();
    var prev = capturePrevious(s);
    t.assert.strictEqual(prev.scheduler.state.running, true);
    t.assert.ok(s.timers.liveTimeouts().indexOf(prev.timerId) >= 0);

    var H2 = harness.reload(s.H);

    t.assert.strictEqual(prev.scheduler.state.running, false);
    t.assert.strictEqual(s.timers.liveTimeouts().indexOf(prev.timerId), -1);
    t.assert.strictEqual(s.timers.liveIntervals().indexOf(prev.intervalId), -1);
    t.assert.ok(prev.resetCalls >= 1);
    t.assert.strictEqual(s.timers.liveIntervals().length, 1);
    t.assert.strictEqual(H2.Steward.kernel.scheduler.state.running, false);
    t.assert.notStrictEqual(H2.Steward.kernel.scheduler, prev.scheduler);
});

t.test('stale boot after reload is a no-op', function () {
    var s = setup();
    var prev = capturePrevious(s);
    var H2 = harness.reload(s.H);
    H2.clearLogs();

    prev.lifecycle.boot();

    t.assert.strictEqual(H2.Steward.kernel.scheduler.state.running, false);
    var logs = H2.logs();
    for (var i = 0; i < logs.length; i++) {
        t.assert.notStrictEqual(String(logs[i].args[0]), 'boot starting');
    }
});

t.test('previous build without shutdown and dispose is still torn down', function () {
    var s = setup();
    var prev = capturePrevious(s);
    delete s.H.Steward.kernel.lifecycle.shutdown;
    delete s.H.Steward.kernel.ui.dispose;

    harness.reload(s.H);

    t.assert.strictEqual(prev.scheduler.state.running, false);
    t.assert.strictEqual(s.timers.liveIntervals().indexOf(prev.intervalId), -1);
    t.assert.ok(prev.resetCalls >= 1);
});

t.test('minimal previous instance does not abort the reload', function () {
    var s = setup();
    var prev = capturePrevious(s);
    delete s.H.Steward.kernel.lifecycle;
    delete s.H.Steward.kernel.ui.dispose;
    delete s.H.Steward.kernel.ui.stopStatusUpdater;
    prev.queue.reset = function () { throw new Error('reset failed'); };

    var H2 = harness.reload(s.H);

    t.assert.ok(H2.Steward.kernel.scheduler);
    t.assert.strictEqual(prev.scheduler.state.running, false);
});

t.test('shutdown twice runs the teardown once', function () {
    var s = setup();
    var lc = s.H.Steward.kernel.lifecycle;
    s.H.clearLogs();

    lc.shutdown();
    lc.shutdown();

    var n = 0;
    var logs = s.H.logs();
    for (var i = 0; i < logs.length; i++) {
        if (logs[i].category === 'lifecycle' && logs[i].args[0] === 'shutdown complete') n++;
    }
    t.assert.strictEqual(n, 1);
});

t.test('reload clears a pending wake of the previous instance', function () {
    var s = setup();
    var prev = capturePrevious(s);
    s.H.Steward.kernel.register({
        id: 'waker', priority: s.H.Steward.Priority.Normal,
        isReady: function () { return true; },
        plan: function () {}
    });
    t.assert.strictEqual(prev.scheduler.wake('waker', 5000), true);
    var wakeId = String(prev.scheduler.state.wakes.waker.timer);
    t.assert.ok(s.timers.liveTimeouts().indexOf(wakeId) >= 0);

    harness.reload(s.H);

    t.assert.strictEqual(s.timers.liveTimeouts().indexOf(wakeId), -1);
    t.assert.deepStrictEqual(Object.keys(prev.scheduler.state.wakes), []);
});
