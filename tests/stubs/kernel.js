/*
 * Kernel capture stub.
 *
 * After kernel/core/modules sources have loaded into a vm context, the harness
 * calls attachCaptures(Steward) to wrap kernel.log/warn/error/debug,
 * kernel.queue.add, and kernel.settings.read/write with capturing versions.
 * Tests inspect the returned arrays/maps to assert what was logged or queued.
 *
 * queue.add is fully replaced (the original's "actions[name] must be
 * registered" check is bypassed) so tests don't need to call boot() before
 * exercising plan(). Tests that DO want to invoke a registered action
 * handler in isolation can register one normally and call it directly.
 */

'use strict';

function attachCaptures(Steward) {
    if (!Steward || !Steward.kernel) {
        throw new Error('attachCaptures: Steward.kernel missing — bootstrap failed');
    }

    var logs = [];                    // [{ level, category, args }]
    var queued = [];                  // [{ name, params, delay, moduleId }]
    var settingsStore = {};

    var levels = ['log', 'warn', 'error', 'debug'];
    for (var i = 0; i < levels.length; i++) {
        (function (lvl) {
            var orig = Steward.kernel[lvl] || function () {};
            var wrapper = function () {
                var args = Array.prototype.slice.call(arguments);
                logs.push({
                    level:    lvl,
                    category: args[0],
                    args:     args.slice(1)
                });
                if (process.env.DEBUG_LOG) orig.apply(null, arguments);
            };
            // Preserve any helper props the original carries (.isEnabled, .configure etc.).
            var keys = Object.keys(orig);
            for (var k = 0; k < keys.length; k++) wrapper[keys[k]] = orig[keys[k]];
            // The real logger, which the capture hides unless DEBUG_LOG is set.
            wrapper.raw = orig;
            Steward.kernel[lvl] = wrapper;
        }(levels[i]));
    }

    if (Steward.kernel.queue) {
        Steward.kernel.queue.add = function (name, params, delay) {
            queued.push({
                name:     name,
                params:   params || [],
                delay:    typeof delay === 'number' ? delay : null,
                moduleId: Steward.kernel._currentModule || null
            });
            return true;
        };
    }

    if (Steward.kernel.settings) {
        Steward.kernel.settings.read = function (id) {
            return Object.prototype.hasOwnProperty.call(settingsStore, id)
                ? settingsStore[id]
                : null;
        };
        Steward.kernel.settings.write = function (id, val) {
            settingsStore[id] = val;
            return true;
        };
    }

    return {
        logs:          function () { return logs.slice(); },
        queued:        function () { return queued.slice(); },
        clearLogs:     function () { logs.length = 0; },
        clearQueued:   function () { queued.length = 0; },
        settingsStore: settingsStore
    };
}

module.exports = {
    attachCaptures: attachCaptures
};
