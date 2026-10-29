/*
 * Adventure definitions (read-only).
 *
 * Reads the adventure definition map, the AdventureManager and the player's
 * own open adventures. Starting and closing adventures comes later. The list
 * offers attack adventures only, matching autoTSO's template maker.
 */

(function (S) {

    // autoTSO skips these groups in its template maker. A group is the type
    // when the adventure has no campaign.
    var HIDDEN_TYPES = ['Scenario', 'Coop'];

    // The host class whose singleton lists the open adventures.
    var ADVENTURE_MANAGER = 'com.bluebyte.tso.adventure.logic::AdventureManager';

    function str(fn) {
        try { return fn(); } catch (e) { return ''; }
    }

    function describe(d) {
        var name = str(function () { return d.mName_string; });
        var diff = 0;
        var req = false;
        try { diff = d.GetDifficulty(); } catch (e1) { /* default */ }
        try { req = !!d.GetRequiresEvent(); } catch (e2) { /* default */ }
        return {
            name:          name,
            label:         S.core.locale.adn(name),
            type:          str(function () { return d.GetType_string(); }),
            campaign:      str(function () { return d.GetCampaign_string(); }),
            difficulty:    diff,
            requiresEvent: req
        };
    }

    function definitions() {
        var out = [];
        try {
            var map = game.def('AdventureSystem::cAdventureDefinition').map_AdventureName_AdventureDefinition;
            var raw = [];
            var i;
            if (map && typeof map.valueSet === 'function') {
                var vs = map.valueSet();
                if (vs && typeof vs.length === 'number') {
                    for (i = 0; i < vs.length; i++) raw.push(vs[i]);
                } else if (vs) {
                    for (var k in vs) raw.push(vs[k]);
                }
            } else if (map) {
                for (var key in map) raw.push(map[key]);
            }
            for (i = 0; i < raw.length; i++) {
                if (raw[i]) out.push(describe(raw[i]));
            }
        } catch (e) {
            S.kernel.warn('adventures', 'definitions() threw:', e);
            return [];
        }
        return out;
    }

    function hasCampaign(def) {
        return !!(def.campaign && def.campaign !== 'None');
    }

    function groupOf(def) {
        return hasCampaign(def) ? S.core.locale.lab('Campaign_' + def.campaign) : def.type;
    }

    function isSelectable(def) {
        if (def.requiresEvent) return false;
        if (def.name.indexOf('Expedition') !== -1) return false;
        if (!def.label || def.label === def.name || def.label.indexOf('undefined') !== -1) return false;
        if (!hasCampaign(def) && HIDDEN_TYPES.indexOf(def.type) !== -1) return false;
        return true;
    }

    function groups(defs) {
        var list = [];
        var i;
        for (i = 0; i < defs.length; i++) {
            if (isSelectable(defs[i])) list.push(defs[i]);
        }
        list.sort(function (a, b) {
            if (a.difficulty !== b.difficulty) return a.difficulty - b.difficulty;
            return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
        });
        var out = [];
        var byGroup = {};
        for (i = 0; i < list.length; i++) {
            var g = groupOf(list[i]);
            if (!Object.prototype.hasOwnProperty.call(byGroup, g)) {
                byGroup[g] = { group: g, items: [] };
                out.push(byGroup[g]);
            }
            byGroup[g].items.push(list[i]);
        }
        return out;
    }

    function label(name) {
        return S.core.locale.adn(name);
    }

    // Returns the host AdventureManager instance, or null. Silent because it
    // runs on the menu tick; callers decide whether a missing manager is worth logging.
    function manager() {
        try {
            var cls = game.def(ADVENTURE_MANAGER);
            return (cls && cls.getInstance()) || null;
        } catch (e) {
            return null;
        }
    }

    // Names of the player's own open adventures. Runs on the menu's status
    // tick, so it never logs; any failure means "none".
    function ownOpen() {
        var out = [];
        try {
            var mgr = manager();
            if (!mgr) return [];
            var advs = mgr.getAdventures();
            try {
                if (advs && typeof advs.toArray === 'function') {
                    var arr = advs.toArray();
                    if (arr && typeof arr.length === 'number') advs = arr;
                }
            } catch (e1) { /* fall back to the index walk */ }
            var n = (advs && typeof advs.length === 'number') ? advs.length : 0;
            for (var i = 0; i < n; i++) {
                try {
                    var adv = advs[i];
                    if (mgr.isMyAdventure(adv)) out.push(String(adv.adventureName));
                } catch (e2) { /* skip this entry */ }
            }
        } catch (e) {
            return [];
        }
        return out;
    }

    S.core.adventures = {
        HIDDEN_TYPES: HIDDEN_TYPES,
        definitions:  definitions,
        groupOf:      groupOf,
        isSelectable: isSelectable,
        groups:       groups,
        label:        label,
        manager:      manager,
        ownOpen:      ownOpen
    };

}(Steward));
