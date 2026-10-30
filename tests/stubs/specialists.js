/*
 * Fake-specialist factories for tests.
 *
 * core/specialists/* reads specialists via host calls (game.def('Enums::SPECIALIST_TYPE'),
 * spec.GetType(), spec.GetSkills_vector(), etc). These factories produce objects
 * implementing just enough of that surface for planner-decision tests.
 *
 * Specialist type IDs are sentinel numbers — any consistent value works as long
 * as the test's stub `game.def('Enums::SPECIALIST_TYPE')` returns matching
 * constants. Geologist=2 and Explorer=3 are the autoTSO conventions.
 */

'use strict';

var TYPE = {
    GENERAL:   0,
    CARRIER:   1,
    GEOLOGIST: 2,
    EXPLORER:  3,
    ADMIRAL:   4
};

function makeSkill(opts) {
    opts = opts || {};
    var levelVector = opts.levelVector || [];
    return {
        getId:         function () { return opts.id || 'Unknown'; },
        getLevel:      function () { return typeof opts.level === 'number' ? opts.level : 1; },
        getDefinition: function () {
            return {
                level_vector:  levelVector,
                effect_vector: opts.effects || []
            };
        }
    };
}

function makeSpec(opts) {
    opts = opts || {};
    var typeId  = (typeof opts.type === 'number') ? opts.type : TYPE.GENERAL;
    var uid     = opts.uid || ('spec-' + Math.random().toString(36).slice(2, 8));
    var name    = opts.name || 'Specialist';
    var task    = opts.task || null;
    var skills  = (opts.skills || []).map(makeSkill);
    var timeBonus = opts.timeBonus;

    return {
        GetType:     function () { return typeId; },
        GetUniqueID: function () {
            return {
                toKeyString: function () { return uid; },
                toString:    function () { return uid; }
            };
        },
        getPlayerID: function () { return typeof opts.playerId === 'number' ? opts.playerId : 1; },
        GetTask:     function () { return task; },
        IsInUse:     function () { return !!task; },
        GetName_string: function () { return name; },
        GetName:     function () { return name; },
        getName:     function () { return name; },
        GetSkills_vector: function () { return skills; },
        skills: {
            getItems_vector: function () { return skills; }
        },
        getIconID:   function () { return opts.iconID || null; },
        GetSpecialistDescription: function () {
            var desc = {
                getName_string:     function () { return name; },
                getBaseType:        function () { return typeId; },
                isTransportGeneral: function () { return false; }
            };
            // Only expose the time bonus when the test sets one, so the
            // missing-method path stays reachable.
            if (typeof timeBonus === 'number') {
                desc.GetTimeBonus = function () { return timeBonus; };
            }
            return desc;
        }
    };
}

// Turns spec into a bridge ghost: every function member except GetType reads
// undefined, the way a live cSpecialist can for a moment. Only GetType is known
// to keep working. Returns restore(), which puts the members back, so a test
// can flip an entry on and off, also from inside a getter in the middle of a
// pass. Non-function members stay as they are.
function ghost(spec) {
    var saved = {};
    var key;
    for (key in spec) {
        if (!Object.prototype.hasOwnProperty.call(spec, key)) continue;
        if (key === 'GetType' || typeof spec[key] !== 'function') continue;
        saved[key] = spec[key];
        delete spec[key];
    }
    return function restore() {
        for (var k in saved) {
            if (Object.prototype.hasOwnProperty.call(saved, k)) spec[k] = saved[k];
        }
    };
}

function geologist(opts) {
    opts = opts || {};
    opts.type = TYPE.GEOLOGIST;
    if (!opts.name) opts.name = 'Geologist';
    return makeSpec(opts);
}

function explorer(opts) {
    opts = opts || {};
    opts.type = TYPE.EXPLORER;
    if (!opts.name) opts.name = 'Explorer';
    return makeSpec(opts);
}

function task(typeId, subTypeId, remainingMs) {
    return {
        GetType:          function () { return typeId; },
        GetSubType:       function () { return subTypeId; },
        GetRemainingTime: function () { return typeof remainingMs === 'number' ? remainingMs : 0; }
    };
}

module.exports = {
    TYPE:      TYPE,
    geologist: geologist,
    explorer:  explorer,
    spec:      makeSpec,
    ghost:     ghost,
    skill:     makeSkill,
    task:      task
};
