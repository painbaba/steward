/*
 * Army, buff and adventure-definition stubs for core tests.
 *
 * Builds squads, armies and fighter specialists, the unit catalogue and the
 * host wiring that core/army, core/buffs and core/adventures read. The shared
 * specialists, host and airfs stubs are used as they are; nothing here edits
 * them.
 *
 *   var A = require('../stubs/army');
 *   A.install(H, {
 *       playerId: 1,
 *       free:     { Rifle: 10 },
 *       fighters: [A.fighter({ uid: 'g1', army: { Rifle: 5 } })],
 *       units:    A.unitCatalogue(['EliteRifle'], ['Rifle']),
 *       buffs:    [{ type: 'GeneralSpeedBuff_A', amount: 2 }],
 *       buffDefs: { GeneralSpeedBuff_A: {} },
 *       adventureDefs: [A.adventureDef({ name: 'Adv1' })]
 *   });
 */

'use strict';

var specStubs = require('./specialists');

// squad(type, amount, opts): opts.category (unit category, default 0),
// opts.elite (GetIsElite result, default false).
function squad(type, amount, opts) {
    opts = opts || {};
    var category = typeof opts.category === 'number' ? opts.category : 0;
    return {
        amount:    amount,
        GetType:   function () { return type; },
        GetAmount: function () { return amount; },
        GetUnitBase: function () {
            return {
                GetUnitCategory: function () { return category; },
                GetIsElite:      function () { return !!opts.elite; }
            };
        }
    };
}

// armyOf(map, opts): opts.category is the default category of every squad,
// opts.categories overrides it per unit type.
function armyOf(map, opts) {
    opts = opts || {};
    var list = [];
    for (var type in map) {
        if (!Object.prototype.hasOwnProperty.call(map, type)) continue;
        var cat = (opts.categories && typeof opts.categories[type] === 'number')
            ? opts.categories[type]
            : (typeof opts.category === 'number' ? opts.category : 0);
        list.push(squad(type, map[type], { category: cat }));
    }
    var army = {
        GetSquadsCollection_vector: function () { return list; },
        GetSquads_vector:           function () { return list; },
        HasUnits:                   function () { return list.length > 0; }
    };
    return army;
}

// A general (or carrier) built on specialists.spec.
// opts: uid, name, carrier, army (map), playerId (default 1), grid (default 5),
// travelling, task, maxUnits (adds GetMaxMilitaryUnits), descMax (adds the
// description's getMaxTroopCount).
function fighter(opts) {
    opts = opts || {};
    var s = specStubs.spec({
        type: specStubs.TYPE.GENERAL,
        uid:  opts.uid,
        name: opts.name || opts.uid || 'General',
        task: opts.task || null
    });
    var baseDesc = s.GetSpecialistDescription;
    s.GetSpecialistDescription = function () {
        var d = baseDesc();
        d.isTransportGeneral = function () { return !!opts.carrier; };
        if (typeof opts.descMax === 'number') {
            d.getMaxTroopCount = function () { return opts.descMax; };
        }
        return d;
    };
    s.getPlayerID = function () { return typeof opts.playerId === 'number' ? opts.playerId : 1; };
    s.GetArmy = function () { return armyOf(opts.army || {}); };
    s.GetGarrisonGridIdx = function () { return typeof opts.grid === 'number' ? opts.grid : 5; };
    s.isTravellingAway = function () { return !!opts.travelling; };
    if (typeof opts.maxUnits === 'number') {
        s.GetMaxMilitaryUnits = function () { return opts.maxUnits; };
    }
    return s;
}

// MilitarySystem::cMilitaryUnitBase stand-in. opts.noLookup drops
// GetUnitBaseForType so the GetAllUnit scan is the only way in.
function unitCatalogue(eliteNames, baseNames, opts) {
    opts = opts || {};
    var units = [];
    var i;
    function unit(name, elite) {
        return {
            GetType:         function () { return name; },
            GetUnitCategory: function () { return 0; },
            GetIsElite:      function () { return elite; }
        };
    }
    for (i = 0; i < (baseNames || []).length; i++) units.push(unit(baseNames[i], false));
    for (i = 0; i < (eliteNames || []).length; i++) units.push(unit(eliteNames[i], true));
    var cat = {
        GetAllUnit: function () { return units; }
    };
    if (!opts.noLookup) {
        cat.GetUnitBaseForType = function (name) {
            for (var j = 0; j < units.length; j++) if (units[j].GetType() === name) return units[j];
            return null;
        };
    }
    return cat;
}

// One entry of the star-menu buff inventory.
function buffEntry(b) {
    return {
        amount: b.amount,
        GetType: function () { return b.type; },
        GetResourceName_string: function () { return b.resource || ''; },
        GetUniqueId: function () {
            return { toKeyString: function () { return b.uid || b.type; } };
        }
    };
}

// opts: name, type, campaign, difficulty, requiresEvent.
function adventureDef(opts) {
    opts = opts || {};
    return {
        mName_string:      opts.name || 'Adventure',
        GetType_string:    function () { return opts.type || 'Attack'; },
        GetCampaign_string: function () { return opts.campaign || 'None'; },
        GetDifficulty:     function () { return typeof opts.difficulty === 'number' ? opts.difficulty : 0; },
        GetRequiresEvent:  function () { return !!opts.requiresEvent; }
    };
}

// Host map of adventure definitions in one of the shapes the client has:
// 'array' (valueSet() returns an array), 'object' (valueSet() returns a keyed
// object) or 'plain' (no valueSet, the map itself is enumerated).
function adventureMap(defs, form) {
    var i;
    if (form === 'plain') {
        var plain = {};
        for (i = 0; i < defs.length; i++) plain[defs[i].mName_string] = defs[i];
        return plain;
    }
    if (form === 'object') {
        var keyed = {};
        for (i = 0; i < defs.length; i++) keyed[defs[i].mName_string] = defs[i];
        return { valueSet: function () { return keyed; } };
    }
    return { valueSet: function () { return defs; } };
}

// Wires the host of a booted harness H. opts: playerId (default 1), free (map,
// or an army object), fighters, units (unitCatalogue), buffs (array of
// { type, amount, resource, uid }), buffDefs (map name -> anything),
// adventureDefs (array), adventureForm ('array' default, 'object', 'plain').
function install(H, opts) {
    opts = opts || {};
    var game = H.host.game;
    var playerId = typeof opts.playerId === 'number' ? opts.playerId : 1;
    var fighters = opts.fighters || [];
    var buffs = opts.buffs || [];

    game.player = {
        GetPlayerId:    function () { return playerId; },
        GetPlayerLevel: function () { return 60; }
    };

    var freeArmy = opts.free && typeof opts.free.GetSquads_vector === 'function'
        ? opts.free
        : (opts.free ? armyOf(opts.free) : null);
    game.zone.GetArmy = function () { return freeArmy; };

    game.gi.mCurrentPlayer = game.gi.mCurrentPlayer || {};
    game.gi.mCurrentPlayer.getAvailableBuffs_vector = function () {
        var out = [];
        for (var i = 0; i < buffs.length; i++) out.push(buffEntry(buffs[i]));
        return out;
    };
    game.gi.mCurrentPlayerZone = {
        mAdventureName: 'Home',
        GetSpecialists_vector: function () { return fighters; }
    };

    game.def = function (name) {
        if (name === 'MilitarySystem::cMilitaryUnitBase') return opts.units || null;
        if (name === 'global') return { map_BuffName_BuffDefinition: opts.buffDefs };
        if (name === 'AdventureSystem::cAdventureDefinition') {
            if (!opts.adventureDefs) return null;
            return { map_AdventureName_AdventureDefinition: adventureMap(opts.adventureDefs, opts.adventureForm) };
        }
        return null;
    };
}

module.exports = {
    squad:          squad,
    armyOf:         armyOf,
    fighter:        fighter,
    unitCatalogue:  unitCatalogue,
    buffEntry:      buffEntry,
    adventureDef:   adventureDef,
    adventureMap:   adventureMap,
    install:        install
};
