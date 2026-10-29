'use strict';

var fs   = require('fs');
var path = require('path');
var vm   = require('vm');

var t = require('../runner');
var harness = require('../harness');

var QUEUE_FILE = 'src/kernel/60_queue.js';
var QUEUE_SOURCE = fs.readFileSync(path.resolve(__dirname, '..', '..', QUEUE_FILE), 'utf8');

// The harness replaces queue.add with a capture, so each test boots its own
// harness and re-runs the queue source into that context to get the real
// queue. A fresh boot per test keeps the re-run queue from leaking.
function realQueue() {
    var H = harness.boot({ sections: ['kernel'] });
    var timers = [];
    H.ctx.setTimeout = function (fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; };
    // No visible host modal: the queue must never defer in these tests.
    var $ = function () { return { length: 0 }; };
    $.fn = { length: 0 };
    H.ctx.$ = $;
    vm.runInContext(QUEUE_SOURCE, H.ctx, { filename: QUEUE_FILE });
    var S = H.Steward;
    return {
        S: S,
        Q: S.kernel.queue,
        timers: timers,
        // Runs the next pending timer (the queue's paced runOne).
        step: function () {
            var next = timers.shift();
            if (next) next.fn();
            return !!next;
        }
    };
}

function noopAction() {}

t.test('add tags with the current module', function () {
    var R = realQueue();
    R.Q.action('noop', noopAction);
    R.S.kernel._currentModule = 'mining';
    R.Q.add('noop', [], 10);
    R.S.kernel._currentModule = null;
    t.assert.strictEqual(R.Q.depthByModule('mining'), 1);
    t.assert.strictEqual(R.Q.isModuleBusy('mining'), true);
});

t.test('add from inside a running tagged action inherits its tag', function () {
    var R = realQueue();
    var seenRunning = null;
    R.Q.action('child', noopAction);
    R.Q.action('parent', function () {
        seenRunning = R.Q.runningModule();
        R.Q.add('child', [], 10);
    });
    R.S.kernel._currentModule = 'adventures';
    R.Q.add('parent', [], 10);
    R.S.kernel._currentModule = null;
    R.Q.drain();
    t.assert.strictEqual(seenRunning, 'adventures');
    t.assert.strictEqual(R.Q.depth(), 1);
    t.assert.strictEqual(R.Q.depthByModule('adventures'), 1);
});

t.test('add outside any module is untagged', function () {
    var R = realQueue();
    R.Q.action('noop', noopAction);
    R.S.kernel._currentModule = null;
    R.Q.add('noop', [], 10);
    t.assert.strictEqual(R.Q.depth(), 1);
    t.assert.strictEqual(R.Q.isModuleBusy('mining'), false);
    t.assert.strictEqual(R.Q.cancelByModule('mining'), 0);
    t.assert.strictEqual(R.Q.depth(), 1);
});

t.test('isModuleBusy stays true while a running action re-enqueues itself', function () {
    var R = realQueue();
    var runs = 0;
    var busyDuringRun = [];
    R.Q.action('loop', function () {
        runs++;
        busyDuringRun.push(R.Q.isModuleBusy('adventures'));
        if (runs < 3) R.Q.add('loop', [], 50);
    });
    R.S.kernel._currentModule = 'adventures';
    R.Q.add('loop', [], 50);
    R.S.kernel._currentModule = null;

    R.Q.drain();
    t.assert.strictEqual(R.Q.isModuleBusy('adventures'), true);
    R.step();
    t.assert.strictEqual(R.Q.isModuleBusy('adventures'), true);
    R.step();
    t.assert.strictEqual(runs, 3);
    t.assert.deepStrictEqual(busyDuringRun, [true, true, true]);
    t.assert.strictEqual(R.Q.isModuleBusy('adventures'), false);
    t.assert.strictEqual(R.Q.depth(), 0);
});

t.test('cancelByModule drops inherited entries', function () {
    var R = realQueue();
    R.Q.action('other', noopAction);
    R.Q.action('loop', function () { R.Q.add('loop', [], 50); });
    R.S.kernel._currentModule = 'adventures';
    R.Q.add('loop', [], 50);
    R.S.kernel._currentModule = 'mining';
    R.Q.add('other', [], 50);
    R.S.kernel._currentModule = null;

    R.Q.drain();   // runs 'loop', which re-enqueues itself behind 'other'
    t.assert.strictEqual(R.Q.depthByModule('adventures'), 1);
    t.assert.strictEqual(R.Q.cancelByModule('adventures'), 1);
    t.assert.strictEqual(R.Q.depthByModule('adventures'), 0);
    t.assert.strictEqual(R.Q.depthByModule('mining'), 1);
    t.assert.strictEqual(R.Q.isModuleBusy('adventures'), false);
});
