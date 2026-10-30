/*
 * Host wiring and drivers for the action-def tests (orders, army, buffs,
 * adventures, quests, production).
 *
 * Builds on the army stub (fighter, armyOf) without editing it. wire() records
 * every server send and every host call a def makes; general() is a fighter
 * whose orders-relevant state can change between polls; drive() plays the
 * queued 'core.attempt' entries the way the kernel queue would, so a test can
 * change host state between polls.
 *
 *   var AC = require('../stubs/actions');
 *   var sent = AC.wire(H);
 *   var g = AC.general({ uid: 'g1', grid: 5, army: { Rifle: 5 } });
 *   S.core.actions.attempt(def, onDone);
 *   var run = AC.drive(H, { onStep: function (n) { g.state.grid = 9; } });
 */

'use strict';

var A = require('./army');

// Wraps the function members of a fake so each call lands in sent.calls as
// { target, method, args }; non-function members are kept as they are.
function recording(sent, target, fake) {
    var out = {};
    var key;
    function wrap(name, fn) {
        out[name] = function () {
            sent.calls.push({ target: target, method: name, args: Array.prototype.slice.call(arguments) });
            return fn.apply(this, arguments);
        };
    }
    for (key in fake) {
        if (!Object.prototype.hasOwnProperty.call(fake, key)) continue;
        if (typeof fake[key] === 'function') wrap(key, fake[key]);
        else out[key] = fake[key];
    }
    return out;
}

// Installs the recorders on the booted harness H and returns the record:
// { actions, messages, calls, placeable, pathLen, registerDef }.
// sent.placeable / sent.pathLen / sent.cursorGrid can be changed at any time.
function wire(H) {
    var game = H.host.game;
    var gi = game.gi;
    var previousDef = game.def;
    var registry = {};
    var sent = {
        actions:   [],
        messages:  [],
        calls:     [],
        placeable: 0,
        pathLen:   1,
        cursorGrid: 0
    };

    gi.SendServerAction = function (id, p1, p2, p3, data) {
        sent.actions.push({ id: id, p1: p1, p2: p2, p3: p3, data: data });
    };
    gi.mClientMessages = {
        SendMessagetoServer: function (id, zone, data, responder) {
            sent.messages.push({ id: id, zone: zone, data: data, responder: responder });
        }
    };

    gi.mCurrentCursor = {
        mCurrentSpecialist: null,
        GetGridPosition:    function () { return sent.cursorGrid; }
    };
    gi.mMouseCursor = {
        SetCursorEditMode: function (mode) {
            sent.calls.push({ target: 'mMouseCursor', method: 'SetCursorEditMode', args: [mode] });
        },
        SetToLastEditMode: function () {
            sent.calls.push({ target: 'mMouseCursor', method: 'SetToLastEditMode', args: [] });
        },
        CheckIfGarrisonIsPlacableInGame: function () { return sent.placeable; }
    };
    gi.mPathFinder = {
        CalculatePath: function () { return { pathLenX10000: sent.pathLen }; }
    };

    // Communication.VO::<X> yields a fresh plain VO; registered fakes win over
    // the previous def; everything else falls through.
    game.def = function (name) {
        var m = /^Communication\.VO::(.+)$/.exec(String(name));
        if (m) {
            return {
                voName:     m[1],
                unitSquads: { items: [], addItem: function (s) { this.items.push(s); } }
            };
        }
        if (Object.prototype.hasOwnProperty.call(registry, name)) return registry[name];
        return typeof previousDef === 'function' ? previousDef(name) : null;
    };

    // registerDef('cMilitaryUtil', { Method: fn }): calls to the fake's
    // methods are recorded in sent.calls with the def name as target.
    sent.registerDef = function (name, value) {
        registry[name] = recording(sent, name, value || {});
        return registry[name];
    };

    return sent;
}

// A general with mutable state. opts: everything A.fighter takes, plus
// grid, task ({ type, newGrid } or null), army (map), travelling, inUse and
// throwOn (a getter name that then throws).
function general(opts) {
    opts = opts || {};
    var state = {
        grid:       typeof opts.grid === 'number' ? opts.grid : 5,
        task:       opts.task || null,
        army:       opts.army || {},
        travelling: !!opts.travelling,
        inUse:      !!opts.inUse,
        throwOn:    opts.throwOn || null
    };
    var s = A.fighter({
        uid:      opts.uid,
        name:     opts.name,
        carrier:  opts.carrier,
        playerId: opts.playerId,
        maxUnits: opts.maxUnits,
        descMax:  opts.descMax
    });

    // Defines a getter that throws when state.throwOn names it.
    function getter(name, fn) {
        s[name] = function () {
            if (state.throwOn === name) throw new Error(name + ' failed');
            return fn.apply(s, arguments);
        };
    }

    getter('GetGarrisonGridIdx', function () { return state.grid; });
    getter('GetTask', function () {
        if (!state.task) return null;
        return {
            GetOriginalType:        function () { return state.task.type; },
            GetNewGarrisonGridIdx:  function () { return state.task.newGrid; }
        };
    });
    getter('GetArmy', function () { return A.armyOf(state.army); });
    getter('HasUnits', function () {
        for (var k in state.army) {
            if (Object.prototype.hasOwnProperty.call(state.army, k) && state.army[k] > 0) return true;
        }
        return false;
    });
    getter('IsInUse', function () { return state.inUse || !!state.task; });
    getter('isTravellingAway', function () { return state.travelling; });
    // The client has no garrison for a general at the star (grid <= 0), so
    // such a general cannot be raised there.
    getter('GetGarrison', function () { return state.grid > 0 ? { garrison: true } : null; });
    getter('CreateSpecialistVOFromSpecialist', function () {
        return { voName: 'SpecialistVO', uid: s.GetUniqueID().toKeyString() };
    });

    s.state = state;
    return s;
}

// Plays the queued 'core.attempt' entries until none are left (or opts.max
// steps, default 50). opts.onStep(n) runs after each step. Returns
// { steps, delays }: the number of steps run and the delay of every entry played.
function drive(H, opts) {
    opts = opts || {};
    var max = typeof opts.max === 'number' ? opts.max : 50;
    var actions = H.Steward.core.actions;
    var steps = 0;
    var delays = [];

    while (steps < max) {
        var entries = [];
        var all = H.queued();
        for (var i = 0; i < all.length; i++) {
            if (all[i].name === 'core.attempt') entries.push(all[i]);
        }
        H.clearQueued();
        if (entries.length === 0) break;
        for (var j = 0; j < entries.length; j++) {
            delays.push(entries[j].delay);
            actions.step(entries[j].params);
            steps++;
            if (typeof opts.onStep === 'function') opts.onStep(steps);
        }
    }
    return { steps: steps, delays: delays };
}

module.exports = {
    wire:    wire,
    general: general,
    drive:   drive
};
