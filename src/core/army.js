/*
 * Army library (read-only).
 *
 * Reads the free troop pool and every own general's and carrier's squads,
 * classifies troops as base or elite, compares compositions exactly and plans
 * where the troops for a wave come from. Nothing here sends a packet or
 * changes an army; raising and unloading come later.
 *
 * Bundle slot: core, after adventures.js and before buildings.js. Every
 * reference to another core (specialists, zone) happens at call time, so the
 * top level only fills S.TroopClass and assigns S.core.army.
 *
 * Two facts are taken from the client code rather than observed in play, so
 * each lives in one named constant that the diagnostics army dump confirms:
 * whether a raise reuses the general's own troops, and which unit category
 * the free pool reports.
 */

(function (S) {

    S.TroopClass.Empty   = 'TroopEmpty';
    S.TroopClass.Base    = 'TroopBase';
    S.TroopClass.Elite   = 'TroopElite';
    S.TroopClass.Mixed   = 'TroopMixed';
    S.TroopClass.Unknown = 'TroopUnknown';

    // The client's own load check computes the need as the target minus the
    // general's current squad, so a raise only draws the difference from the
    // free pool. Confirm with the diagnostics army dump before a raise is
    // ever sent.
    var RAISE_REUSES_OWN_TROOPS = true;

    // Unit category of the squads that form the free pool in the zone army.
    // Confirm with the category column of the diagnostics army dump.
    var FREE_POOL_CATEGORY = 0;

    function has(obj, key) {
        return Object.prototype.hasOwnProperty.call(obj, key);
    }

    // --- Pure map helpers. An army map is { unitName: amount }, amounts > 0.

    function add(a, b) {
        var out = {};
        var k;
        a = a || {};
        b = b || {};
        for (k in a) if (has(a, k) && a[k] > 0) out[k] = a[k];
        for (k in b) if (has(b, k) && b[k] > 0) out[k] = (out[k] || 0) + b[k];
        return out;
    }

    // a minus b, floored at 0; types that drop to 0 are left out.
    function minus(a, b) {
        var out = {};
        a = a || {};
        b = b || {};
        for (var k in a) {
            if (!has(a, k)) continue;
            var left = a[k] - (has(b, k) && b[k] > 0 ? b[k] : 0);
            if (left > 0) out[k] = left;
        }
        return out;
    }

    function total(map) {
        var sum = 0;
        map = map || {};
        for (var k in map) if (has(map, k) && map[k] > 0) sum += map[k];
        return sum;
    }

    function isEmpty(map) {
        return total(map) === 0;
    }

    // Exact per type; a type missing on one side counts as 0, so {} matches {}.
    function matches(have, want) {
        var k;
        have = have || {};
        want = want || {};
        for (k in have) {
            if (has(have, k) && (have[k] || 0) !== (has(want, k) ? want[k] || 0 : 0)) return false;
        }
        for (k in want) {
            if (has(want, k) && (want[k] || 0) !== (has(have, k) ? have[k] || 0 : 0)) return false;
        }
        return true;
    }

    function classOf(map, eliteFn) {
        var fn = eliteFn || isElite;
        var any = false, base = false, elite = false, unknown = false;
        map = map || {};
        for (var k in map) {
            if (!has(map, k) || !(map[k] > 0)) continue;
            any = true;
            var flag = fn(k);
            if (flag === null || flag === undefined) unknown = true;
            else if (flag) elite = true;
            else base = true;
        }
        if (!any) return S.TroopClass.Empty;
        if (unknown) return S.TroopClass.Unknown;
        if (base && elite) return S.TroopClass.Mixed;
        return elite ? S.TroopClass.Elite : S.TroopClass.Base;
    }

    // --- Unit catalogue.

    function unitBase(name) {
        if (!name) return null;
        try {
            var defs = game.def('MilitarySystem::cMilitaryUnitBase');
            if (!defs) return null;
            if (typeof defs.GetUnitBaseForType === 'function') {
                return defs.GetUnitBaseForType(name) || null;
            }
            if (typeof defs.GetAllUnit === 'function') {
                var all = defs.GetAllUnit(1);
                var n = all ? all.length : 0;
                for (var i = 0; i < n; i++) {
                    var u = all[i];
                    try { if (u && u.GetType() === name) return u; }
                    catch (e1) { /* skip this unit */ }
                }
            }
        } catch (e) {
            S.kernel.warn('army', 'unitBase(' + name + ') threw:', e);
        }
        return null;
    }

    // true / false from the unit definition, null when the unit is unknown.
    function isElite(name) {
        var ub = unitBase(name);
        if (!ub) return null;
        try {
            if (typeof ub.GetIsElite === 'function') return !!ub.GetIsElite();
        } catch (e) {
            S.kernel.warn('army', 'isElite(' + name + ') threw:', e);
        }
        return null;
    }

    // --- Readers.

    function squadAmount(sq) {
        if (typeof sq.GetAmount === 'function') return sq.GetAmount();
        return sq.amount;
    }

    // Squads of a host army object as a map. With opts.category a number,
    // squads of a different unit category are skipped; a squad whose
    // category cannot be read is kept, so an unreadable getter never hides
    // troops.
    function squads(army, opts) {
        var out = {};
        if (!army) return out;
        var cat = (opts && typeof opts.category === 'number') ? opts.category : null;
        try {
            var vec = null;
            if (typeof army.GetSquadsCollection_vector === 'function') vec = army.GetSquadsCollection_vector();
            else if (typeof army.GetSquads_vector === 'function') vec = army.GetSquads_vector();
            var n = vec ? vec.length : 0;
            for (var i = 0; i < n; i++) {
                var sq = vec[i];
                if (!sq) continue;
                var type = null, amt = 0;
                try { type = sq.GetType(); amt = squadAmount(sq); }
                catch (e1) { continue; }
                if (!type || !(amt > 0)) continue;
                if (cat !== null) {
                    var c = null;
                    try { c = sq.GetUnitBase().GetUnitCategory(); }
                    catch (e2) { c = null; }
                    if (typeof c === 'number' && c !== cat) continue;
                }
                out[type] = (out[type] || 0) + amt;
            }
        } catch (e) {
            S.kernel.warn('army', 'squads() threw:', e);
        }
        return out;
    }

    function generalArmy(spec) {
        if (!spec) return {};
        try {
            if (typeof spec.GetArmy === 'function') return squads(spec.GetArmy());
        } catch (e) {
            S.kernel.warn('army', 'generalArmy() threw:', e);
        }
        return {};
    }

    function freeArmy() {
        try {
            if (typeof game !== 'undefined' && game && game.zone &&
                typeof game.zone.GetArmy === 'function') {
                var army = game.zone.GetArmy(S.core.zone.playerId());
                if (army) return squads(army, { category: FREE_POOL_CATEGORY });
            }
        } catch (e) {
            S.kernel.warn('army', 'freeArmy() threw:', e);
            return {};
        }
        S.kernel.warn('army', 'freeArmy(): zone army unavailable');
        return {};
    }

    // --- Ownership and specialist facts.

    // Own when the specialist's player id is the zone's own player. Without
    // a player id, -1 (no owner) is the only id known not to be ours.
    function isOwn(spec) {
        if (!spec) return false;
        var owner;
        try { owner = spec.getPlayerID(); }
        catch (e) {
            S.kernel.warn('army', 'isOwn(): getPlayerID threw:', e);
            return false;
        }
        var pid = S.core.zone.playerId();
        if (pid === null || pid === undefined) return owner !== -1;
        return owner === pid;
    }

    function fighters() {
        var src = S.core.specialists.generals().concat(S.core.specialists.carriers());
        var out = [];
        for (var i = 0; i < src.length; i++) if (isOwn(src[i])) out.push(src[i]);
        return out;
    }

    function garrisonGrid(spec) {
        try {
            if (spec && typeof spec.GetGarrisonGridIdx === 'function') return spec.GetGarrisonGridIdx();
        } catch (e) {
            S.kernel.warn('army', 'garrisonGrid() threw:', e);
        }
        return null;
    }

    function isTravelling(spec) {
        try {
            if (spec && typeof spec.isTravellingAway === 'function') return !!spec.isTravellingAway();
        } catch (e) {
            S.kernel.warn('army', 'isTravelling() threw:', e);
        }
        return false;
    }

    // Free pool, per-general armies and the facts the planner needs, keyed
    // by the specialist's unique id key.
    function inventory() {
        var free = freeArmy();
        var byKey = {};
        var assigned = {};
        var list = fighters();
        for (var i = 0; i < list.length; i++) {
            var spec = list[i];
            var key = S.core.specialists.uniqueIdKey(spec);
            if (!key) continue;
            var army = generalArmy(spec);
            var grid = garrisonGrid(spec);
            var idle = S.core.specialists.status(spec) === S.SpecialistStatus.Idle;
            var travelling = isTravelling(spec);
            byKey[key] = {
                key:        key,
                name:       S.core.specialists.name(spec),
                cls:        S.core.specialists.classify(spec),
                army:       army,
                capacity:   S.core.specialists.troopCapacity(spec),
                idle:       idle,
                grid:       grid,
                travelling: travelling,
                donorOk:    idle && !travelling && typeof grid === 'number' && grid > 0 && total(army) > 0
            };
            assigned = add(assigned, army);
        }
        return { free: free, assigned: assigned, total: add(free, assigned), byKey: byKey };
    }

    // --- Supply planner (pure).

    function heldOf(army, shortMap) {
        var sum = 0;
        for (var k in shortMap) {
            if (has(shortMap, k) && has(army, k) && army[k] > 0) sum += army[k];
        }
        return sum;
    }

    // Where the troops for a wave come from. wave = [{ key, army }]; only
    // inv.free and inv.byKey are read. A general whose army already matches
    // draws nothing. Otherwise it draws the difference when a raise reuses
    // its own troops, else the whole target. A wave general's surplus never
    // counts for another general. When the free pool is short, idle donors
    // outside the wave are added, best first; an unload is all-or-nothing,
    // so a donor adds its whole army. A donor holding none of the types
    // still short is passed over, since unloading it would not help. Donor
    // names come from the same inv.byKey read, so a report never needs a
    // second inventory read that could disagree with the plan.
    function planSupply(wave, inv, opts) {
        var reuseOwn = (opts && typeof opts.reuseOwn === 'boolean') ? opts.reuseOwn : RAISE_REUSES_OWN_TROOPS;
        var byKey = (inv && inv.byKey) || {};
        var free = (inv && inv.free) || {};
        var lines = [];
        var missing = [];
        var inWave = {};
        var need = {};
        var i, k;

        wave = wave || [];
        for (i = 0; i < wave.length; i++) {
            var w = wave[i];
            inWave[w.key] = true;
            if (!has(byKey, w.key)) { missing.push(w.key); continue; }
            var have = byKey[w.key].army || {};
            var want = add(w.army, {});
            var ok = matches(have, want);
            var draw = ok ? {} : (reuseOwn ? minus(want, have) : want);
            lines.push({ key: w.key, have: have, want: want, draw: draw, matches: ok });
            need = add(need, draw);
        }

        var shortStart = minus(need, free);
        var candidates = [];
        for (k in byKey) {
            if (has(byKey, k) && !has(inWave, k) && byKey[k].donorOk) {
                candidates.push({ key: k, name: byKey[k].name || '', army: byKey[k].army || {}, score: heldOf(byKey[k].army || {}, shortStart) });
            }
        }
        candidates.sort(function (a, b) {
            if (a.score !== b.score) return b.score - a.score;
            return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0);
        });

        var pool = add(free, {});
        var shortAfter = shortStart;
        var donors = [];
        for (i = 0; i < candidates.length && !isEmpty(shortAfter); i++) {
            if (heldOf(candidates[i].army, shortAfter) === 0) continue;
            donors.push({ key: candidates[i].key, name: candidates[i].name, army: candidates[i].army });
            pool = add(pool, candidates[i].army);
            shortAfter = minus(need, pool);
        }

        return {
            lines:       lines,
            need:        need,
            free:        free,
            shortBefore: shortStart,
            donors:      donors,
            shortAfter:  shortAfter,
            covered:     isEmpty(shortAfter),
            missing:     missing
        };
    }

    S.core.army = {
        RAISE_REUSES_OWN_TROOPS: RAISE_REUSES_OWN_TROOPS,
        FREE_POOL_CATEGORY:      FREE_POOL_CATEGORY,
        unitBase:      unitBase,
        isElite:       isElite,
        squads:        squads,
        generalArmy:   generalArmy,
        freeArmy:      freeArmy,
        isOwn:         isOwn,
        fighters:      fighters,
        garrisonGrid:  garrisonGrid,
        isTravelling:  isTravelling,
        inventory:     inventory,
        add:           add,
        minus:         minus,
        total:         total,
        isEmpty:       isEmpty,
        matches:       matches,
        classOf:       classOf,
        planSupply:    planSupply
    };

}(Steward));
