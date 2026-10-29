/*
 * Adventure definitions, open adventures and closing.
 *
 * Reads the adventure definition map, the AdventureManager and the player's
 * own open adventures (with their zone ids), and builds the action def that
 * closes one. Starting a map lives in core/buffs.js. The list offers attack
 * adventures only, sorted by label, matching autoTSO's template maker.
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
        // A definition without a name cannot be started or labelled.
        if (typeof name !== 'string' || name === '') return null;
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
        var skipped = 0;
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
                if (!raw[i]) continue;
                var d = describe(raw[i]);
                if (d) out.push(d);
                else skipped++;
            }
            if (skipped > 0) S.kernel.warn('adventures', 'skipped ' + skipped + ' adventure definition(s) without a name');
        } catch (e) {
            S.kernel.warn('adventures', 'definitions() threw:', e);
            return [];
        }
        return out;
    }

    function hasCampaign(def) {
        return !!(def.campaign && def.campaign !== 'None');
    }

    function isSelectable(def) {
        if (!def || typeof def.name !== 'string' || !def.name) return false;
        if (def.requiresEvent) return false;
        if (def.name.indexOf('Expedition') !== -1) return false;
        if (typeof def.label !== 'string' || !def.label || def.label.indexOf('undefined') !== -1) return false;
        if (!hasCampaign(def) && HIDDEN_TYPES.indexOf(def.type) !== -1) return false;
        return true;
    }

    // One flat list of the attack adventures, sorted by the label the player
    // reads (ties by name) so the order matches what the dropdown shows.
    function selectable(defs) {
        var list = [];
        var i;
        for (i = 0; i < defs.length; i++) {
            if (isSelectable(defs[i])) list.push(defs[i]);
        }
        list.sort(function (a, b) {
            var c = String(a.label).localeCompare(String(b.label));
            if (c !== 0) return c;
            return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
        });
        return list;
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

    // The player's own open adventures as [{ name, zoneId }]. [] means the
    // manager read fine and none is open; null means it could not be read, so
    // callers never mistake an unreadable manager for "nothing open". Runs on
    // the menu's status tick, so it never logs.
    function own() {
        var out = [];
        try {
            var mgr = manager();
            if (!mgr) return null;
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
                    if (mgr.isMyAdventure(adv)) out.push({ name: String(adv.adventureName), zoneId: adv.zoneID });
                } catch (e2) { /* skip this entry */ }
            }
        } catch (e) {
            return null;
        }
        return out;
    }

    // Names of the own open adventures; an unreadable manager means "none".
    function ownOpen() {
        var list = own();
        var out = [];
        if (!list) return out;
        for (var i = 0; i < list.length; i++) out.push(list[i].name);
        return out;
    }

    function entryOf(list, name) {
        for (var i = 0; i < list.length; i++) {
            if (list[i].name === name) return list[i];
        }
        return null;
    }

    // Zone id of an open own adventure; null when unreadable or not open.
    function zoneIdOf(name) {
        var list = own();
        var e = list ? entryOf(list, name) : null;
        return (e && typeof e.zoneId === 'number') ? e.zoneId : null;
    }

    // Action def that closes an own open adventure. No "already satisfied": a
    // name that is not open is a refusal, since success must be seen as the
    // adventure leaving a list that was read successfully. The caller visits
    // the home island itself.
    function close(name) {
        return {
            label:     'close ' + name,
            category:  'adventures',
            timeoutMs: 30000,
            precheck: function () {
                var list = own();
                if (!list) return 'adventures unreadable';
                if (!entryOf(list, name)) return 'adventure not open';
                if (zoneIdOf(name) === null) return 'adventure zone id unreadable';
                var mgr = manager();
                if (!mgr || typeof mgr.removeAdventure !== 'function') return 'removeAdventure missing';
                return null;
            },
            baseline: function () {
                return { zoneId: zoneIdOf(name) };
            },
            send: function (base) {
                var mgr = manager();
                if (!mgr || !base || typeof base.zoneId !== 'number') return false;
                mgr.removeAdventure(base.zoneId);
                return true;
            },
            check: function (base) {
                var list = own();
                // Without a numeric baseline zone id nothing was sent and
                // absence proves nothing.
                if (!list || !base || typeof base.zoneId !== 'number') return false;
                for (var i = 0; i < list.length; i++) {
                    if (list[i].zoneId === base.zoneId) return false;
                }
                return true;
            }
        };
    }

    S.core.adventures = {
        HIDDEN_TYPES: HIDDEN_TYPES,
        definitions:  definitions,
        isSelectable: isSelectable,
        selectable:   selectable,
        label:        label,
        manager:      manager,
        own:          own,
        ownOpen:      ownOpen,
        zoneIdOf:     zoneIdOf,
        close:        close
    };

}(Steward));
