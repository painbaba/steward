/*
 * Building search, listing, and state predicates.
 *
 * Returns raw game objects — modules read fields via the helpers below or
 * via GetBuildingName_string() / GetGrid() directly.
 *
 * Cache: per scheduler tick, cleared at every tick start. Modules that mutate
 * the building set (place, destroy, upgrade) call invalidate() to force a
 * re-read in the same tick.
 */

(function (S) {

    var snapshot = null;     // cached array per tick

    function currentZone(zoneOverride) {
        if (zoneOverride) return zoneOverride;
        return S.core.zone.current();
    }

    function readAllFromZone(zone) {
        var out = [];
        if (!zone) return out;
        try {
            var sdm = zone.mStreetDataMap;
            if (!sdm) return out;

            var src = null;
            if (typeof sdm.GetBuildings_vector === 'function') {
                src = sdm.GetBuildings_vector();
            } else if (sdm.mBuildingContainer) {
                src = sdm.mBuildingContainer;
            }
            if (!src) return out;

            // Vectors usually expose a .length and numeric index; iterate defensively.
            var len = (typeof src.length === 'number') ? src.length : 0;
            for (var i = 0; i < len; i++) {
                var b = src[i];
                if (b) out.push(b);
            }
        } catch (e) {
            S.kernel.warn('buildings', 'readAllFromZone threw:', e);
        }
        return out;
    }

    function ensureSnapshot(zoneOverride) {
        if (zoneOverride) return readAllFromZone(zoneOverride);
        if (!snapshot) snapshot = readAllFromZone(currentZone());
        return snapshot;
    }

    function invalidate() { snapshot = null; }

    // True when the viewed zone's building list holds anything. byGrid returns
    // null for a missing zone and the reader flattens failures to [], so a
    // building's absence only means something on a non-empty list. The caller
    // invalidates first and checks that the viewed zone is the one it means.
    function readable() { return ensureSnapshot().length > 0; }

    function name(b) {
        if (!b) return '';
        try { return b.GetBuildingName_string ? b.GetBuildingName_string() : ''; }
        catch (e) { return ''; }
    }

    function grid(b) {
        if (!b) return null;
        try { return b.GetGrid ? b.GetGrid() : null; }
        catch (e) { return null; }
    }

    function level(b) {
        if (!b) return 0;
        try { return b.GetUpgradeLevel ? b.GetUpgradeLevel() : 0; }
        catch (e) { return 0; }
    }

    function playerId(b) {
        if (!b) return null;
        try { return typeof b.getPlayerID === 'function' ? b.getPlayerID() : null; }
        catch (e) { return null; }
    }

    function goContainer(b) {
        if (!b) return null;
        try { return typeof b.GetGOContainer === 'function' ? b.GetGOContainer() : null; }
        catch (e) { return null; }
    }

    // True while the host still lets the object be clicked. A clicked map
    // object drops this flag, so it is the positive sign that a click landed.
    function isSelectable(b) {
        if (!b) return false;
        try { return b.mIsSelectable === true; }
        catch (e) { return false; }
    }

    function isMine(b) { return playerId(b) === 0; }

    function isEnemy(b) {
        if (playerId(b) === -1) return true;
        var c = goContainer(b);
        return !!(c && c.ui === 'enemy');
    }

    function isAttackable(b) {
        var c = goContainer(b);
        return !!(c && c.mIsAttackable && !c.mIsLeaderCamp);
    }

    function hasArmy(b) {
        if (!b) return false;
        try {
            var a = typeof b.GetArmy === 'function' ? b.GetArmy() : null;
            return !!(a && typeof a.HasUnits === 'function' && a.HasUnits());
        } catch (e) { return false; }
    }

    function isUpgradable(b) {
        if (!b) return false;
        try { return typeof b.IsUpgradeAllowed === 'function' && !!b.IsUpgradeAllowed(true); }
        catch (e) { return false; }
    }

    function isCollectible(b) {
        if (!b) return false;
        try {
            if (typeof game === 'undefined' || !game.def) return false;
            var cm = game.def('Collections::CollectionsManager');
            if (!cm) return false;
            var inst = typeof cm.getInstance === 'function' ? cm.getInstance() : cm;
            if (inst && typeof inst.getBuildingIsCollectible === 'function') {
                return !!inst.getBuildingIsCollectible(name(b));
            }
        } catch (e) { /* swallow */ }
        return false;
    }

    function matchesType(b, type) {
        // type may be either an internal building name (Steward.Building.Foo
        // value) or an array of names.
        var n = name(b);
        if (!n) return false;
        if (type && typeof type === 'string') return n === type;
        if (type && type.length) {
            for (var i = 0; i < type.length; i++) {
                if (n === type[i]) return true;
            }
        }
        return false;
    }

    function list(opts) {
        opts = opts || {};
        var src = ensureSnapshot(opts.zone);
        if (!opts.type) return src.slice();
        var out = [];
        for (var i = 0; i < src.length; i++) {
            if (matchesType(src[i], opts.type)) out.push(src[i]);
        }
        return out;
    }

    function byName(targetName, opts) {
        opts = opts || {};
        // Fast path: ask the host's named lookup. Mirrors byGrid's fast
        // path. Some building categories (e.g. masons) appear in the
        // host's getBuildingsByName_vector but not in GetBuildings_vector,
        // so the snapshot fallback would miss them.
        if (!opts.zone) {
            try {
                var z = S.core.zone.current();
                if (z && z.mStreetDataMap &&
                    typeof z.mStreetDataMap.getBuildingsByName_vector === 'function') {
                    var v = z.mStreetDataMap.getBuildingsByName_vector(targetName);
                    if (v) {
                        var hits = [];
                        var len = (typeof v.length === 'number') ? v.length : 0;
                        for (var i = 0; i < len; i++) {
                            if (v[i]) hits.push(v[i]);
                        }
                        return hits;
                    }
                }
            } catch (e) { /* fall through to snapshot */ }
        }
        var src = ensureSnapshot(opts.zone);
        var out = [];
        for (var j = 0; j < src.length; j++) {
            if (name(src[j]) === targetName) out.push(src[j]);
        }
        return out;
    }

    function byGrid(targetGrid, opts) {
        opts = opts || {};
        if (!opts.zone) {
            // Fast path: ask the game directly when on the current zone.
            try {
                var g = typeof game !== 'undefined' ? game : null;
                if (g && g.zone && typeof g.zone.GetBuildingFromGridPosition === 'function') {
                    return g.zone.GetBuildingFromGridPosition(targetGrid) || null;
                }
            } catch (e) { /* fall through */ }
        }
        var src = ensureSnapshot(opts.zone);
        for (var i = 0; i < src.length; i++) {
            if (grid(src[i]) === targetGrid) return src[i];
        }
        return null;
    }

    function byPredicate(fn, opts) {
        opts = opts || {};
        var src = ensureSnapshot(opts.zone);
        var out = [];
        for (var i = 0; i < src.length; i++) {
            try { if (fn(src[i])) out.push(src[i]); }
            catch (e) { /* skip */ }
        }
        return out;
    }

    function listMines(opts) {
        return byPredicate(function (b) {
            var n = name(b);
            return typeof n === 'string' && n.indexOf('Mine') > -1;
        }, opts);
    }

    // Group every collectible building on the zone by display name and
    // count occurrences. Returns [{ name, count }] sorted by count desc
    // then by name. Used by the dashboard's Collect Pickups section, but
    // intentionally lives here so any module ("how much is on the ground
    // right now") can consume the same query without re-implementing the
    // walk + filter + group.
    function collectiblesByName(opts) {
        opts = opts || {};
        var src = ensureSnapshot(opts.zone);
        var groups = {};
        for (var i = 0; i < src.length; i++) {
            if (!isCollectible(src[i])) continue;
            var n = name(src[i]);
            if (!n) continue;
            groups[n] = (groups[n] || 0) + 1;
        }
        var out = [];
        var keys = Object.keys(groups);
        for (var k = 0; k < keys.length; k++) {
            out.push({ name: keys[k], count: groups[keys[k]] });
        }
        out.sort(function (a, b) {
            if (b.count !== a.count) return b.count - a.count;
            return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
        });
        return out;
    }

    // Resource-creation definition of a building type from the economy
    // definitions, or null when the host cannot answer. Shared by every
    // accessor that reads per-type production data, so there is one lookup path.
    function creationDef(buildingName) {
        try {
            if (typeof game === 'undefined' || !game.def) return null;
            var econ = game.def('ServerState::gEconomics');
            if (!econ || typeof econ.GetResourcesCreationDefinitionForBuilding !== 'function') return null;
            return econ.GetResourcesCreationDefinitionForBuilding(buildingName) || null;
        } catch (e) {
            return null;
        }
    }

    // Seconds per produced unit, read from the economy definition rather than
    // from a placed building, so it is available for any building type even when
    // none is on the current island. Mirrors how autoTSO derives production time.
    // Returns null when the host cannot answer, so callers can fall back safely.
    function workTime(buildingName) {
        var def = creationDef(buildingName);
        if (!def) return null;
        var wt = def.workTime;
        return (typeof wt === 'number' && wt > 0) ? wt : null;
    }

    // Units delivered per production cycle before any buff (amountRemoved),
    // or null when the definition is unavailable.
    function amountPerCycle(buildingName) {
        var def = creationDef(buildingName);
        if (!def) return null;
        var a = def.amountRemoved;
        return (typeof a === 'number' && a > 0) ? a : null;
    }

    // Factor the host applies to a delivery, buffs included. Null when missing.
    function outputFactor(b) {
        if (!b) return null;
        try {
            if (typeof b.GetResourceOutputFactor !== 'function') return null;
            var f = b.GetResourceOutputFactor();
            return (typeof f === 'number' && f > 0) ? f : null;
        } catch (e) { return null; }
    }

    // Unbuffed factor from the upgrade level. The host truncates it to an
    // integer before applying buffs, so do the same.
    function baseOutputFactor(b) {
        if (!b) return null;
        try {
            if (typeof b.GetExactOutputFactor !== 'function') return null;
            var f = Math.floor(b.GetExactOutputFactor());
            return (typeof f === 'number' && f > 0) ? f : null;
        } catch (e) { return null; }
    }

    // Host game clock. Same time base as buff start times; not epoch, so only
    // differences against it are meaningful.
    function clientTime() {
        try {
            if (typeof swmmo === 'undefined' || !swmmo) return null;
            var gi = swmmo.application && swmmo.application.mGameInterface;
            if (!gi || typeof gi.GetClientTime !== 'function') return null;
            var t = gi.GetClientTime();
            return typeof t === 'number' ? t : null;
        } catch (e) { return null; }
    }

    // Milliseconds left on one buff appliance if it raises output, else null.
    // Duration minus elapsed time, as the client's own time-left label does.
    function applianceOutputRemainingMs(a, now) {
        try {
            if (!a || typeof a.GetBuffDefinition !== 'function') return null;
            var def = a.GetBuffDefinition();
            if (!def || typeof def.getProductivityOutputPercent !== 'function') return null;
            if (!(def.getProductivityOutputPercent() > 100)) return null;
            if (typeof def.getDuration !== 'function' ||
                typeof a.GetApplicanceMode !== 'function' ||
                typeof a.GetStartTime !== 'function') return null;
            var left = def.getDuration(a.GetApplicanceMode()) - (now - a.GetStartTime());
            return (typeof left === 'number' && left > 0) ? left : null;
        } catch (e) { return null; }
    }

    // Remaining milliseconds of the shortest active output buff on a building,
    // or null when none is running or the clock/host cannot answer.
    function buffRemainingMs(b) {
        if (!b) return null;
        var now = clientTime();
        if (now === null) return null;
        var best = null;
        var v = null;
        try { v = b.mBuffs_vector; } catch (e) { v = null; }
        var len = (v && typeof v.length === 'number') ? v.length : 0;
        for (var i = 0; i < len; i++) {
            var left = applianceOutputRemainingMs(v[i], now);
            if (left !== null && (best === null || left < best)) best = left;
        }
        if (best === null) {
            var single = null;
            try { single = b.productionBuff; } catch (e2) { single = null; }
            best = applianceOutputRemainingMs(single, now);
        }
        return best;
    }

    S.core.buildings = {
        // listing
        list:               list,
        byName:             byName,
        byGrid:             byGrid,
        byPredicate:        byPredicate,
        listMines:          listMines,
        collectiblesByName: collectiblesByName,
        invalidate:         invalidate,
        readable:           readable,

        // accessors
        name:         name,
        grid:         grid,
        level:        level,
        playerId:     playerId,
        workTime:     workTime,
        amountPerCycle:    amountPerCycle,
        outputFactor:      outputFactor,
        baseOutputFactor:  baseOutputFactor,
        buffRemainingMs:   buffRemainingMs,
        isSelectable:      isSelectable,

        // state predicates
        isMine:       isMine,
        isEnemy:      isEnemy,
        isAttackable: isAttackable,
        hasArmy:      hasArmy,
        isUpgradable: isUpgradable,
        isCollectible:isCollectible
    };

}(Steward));
