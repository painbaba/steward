/*
 * Army library.
 *
 * Reads the free troop pool and every own general's and carrier's squads,
 * classifies troops as base or elite, compares compositions exactly and plans
 * where the troops for a wave come from. The readers send nothing. raise()
 * and unload() only build action defs (see actions.js); the caller runs them
 * with S.core.actions.attempt, which sends and verifies.
 *
 * Bundle slot: core, after adventures.js and before buildings.js. Every
 * reference to another core (specialists, zone, locale) happens at call time, so the
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

    // Verify window per send for a raise or an unload.
    var ACTION_TIMEOUT_MS = 15000;

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

    // "12 Type, 3 Other" for display: types sorted, zero amounts left out, a
    // type shown by its localised name when the client knows one. An empty or
    // missing army reads as a dash. S.core.locale is read at call time.
    function text(army) {
        var keys = [];
        var out = [];
        var i;
        army = army || {};
        for (var k in army) if (has(army, k) && army[k] > 0) keys.push(k);
        keys.sort();
        for (i = 0; i < keys.length; i++) {
            out.push(army[keys[i]] + ' ' + (S.core.locale.res(keys[i]) || keys[i]));
        }
        return out.length ? out.join(', ') : '—';
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

    // A general's squads as a map, or null when they cannot be read (no
    // specialist, no getter, or a throw). Verification needs the difference
    // between "empty" ({}) and "unreadable" (null); generalArmy flattens it.
    function readGeneralArmy(spec) {
        if (!spec) return null;
        try {
            if (typeof spec.GetArmy === 'function') return squads(spec.GetArmy());
        } catch (e) {
            S.kernel.warn('army', 'generalArmy() threw:', e);
        }
        return null;
    }

    function generalArmy(spec) {
        return readGeneralArmy(spec) || {};
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

    // The client's own unload conditions: an own general that is idle, home
    // (a real garrison grid, not the star menu), not travelling and holding
    // troops. This is the one place the condition lives; inventory's donorOk
    // uses it too. known optionally carries values the caller already read
    // ({ own, army, grid, idle, travelling }) so a getter that fails is not
    // read, and warned about, a second time.
    function canUnload(spec, known) {
        known = known || {};
        if (!spec) return false;
        if (known.own !== true && !isOwn(spec)) return false;
        var idle = typeof known.idle === 'boolean' ? known.idle
            : S.core.specialists.status(spec) === S.SpecialistStatus.Idle;
        if (!idle) return false;
        var travelling = typeof known.travelling === 'boolean' ? known.travelling : isTravelling(spec);
        if (travelling) return false;
        var grid = has(known, 'grid') ? known.grid : garrisonGrid(spec);
        if (typeof grid !== 'number' || !(grid > 0)) return false;
        var army = has(known, 'army') ? known.army : readGeneralArmy(spec);
        return total(army) > 0;
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
                donorOk:    canUnload(spec, { own: true, army: army, grid: grid, idle: idle, travelling: travelling })
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

    // --- Raising and unloading (action defs for S.core.actions.attempt).

    function sameKeys(map) {
        return add(map, {});
    }

    // The raise message carries the full target composition, not a delta.
    // null when the host cannot build the value objects.
    function buildRaiseVO(spec, target) {
        try {
            if (!spec || typeof game === 'undefined' || !game || typeof game.def !== 'function') return null;
            var vo = game.def('Communication.VO::dRaiseArmyVO', true);
            if (!vo || !vo.unitSquads) return null;
            vo.armyHolderSpecialistVO = spec.CreateSpecialistVOFromSpecialist();
            var want = sameKeys(target);
            for (var unit in want) {
                if (!has(want, unit)) continue;
                var r = game.def('Communication.VO::dResourceVO', true);
                if (!r) return null;
                r.name_string = unit;
                r.amount = want[unit];
                vo.unitSquads.addItem(r);
            }
            return vo;
        } catch (e) {
            S.kernel.warn('army', 'buildRaiseVO() threw:', e);
            return null;
        }
    }

    function hasGarrison(spec) {
        try {
            return typeof spec.GetGarrison === 'function' && !!spec.GetGarrison();
        } catch (e) {
            S.kernel.warn('army', 'GetGarrison() threw:', e);
            return false;
        }
    }

    // true only when the general is found and its army reads as the target.
    function armyIs(key, wantEmpty, target) {
        var f = S.core.specialists.refind(key);
        if (!f.spec) return false;
        var have = readGeneralArmy(f.spec);
        if (have === null) return false;
        return wantEmpty ? total(have) === 0 : matches(have, target);
    }

    // Def that sets a general's army to exactly target. An empty target is
    // refused: unload is the empty form.
    function raise(key, target) {
        var want = sameKeys(target);
        return {
            label:     'raise ' + key,
            category:  'army',
            timeoutMs: ACTION_TIMEOUT_MS,
            satisfied: function () {
                return total(want) > 0 && armyIs(key, false, want);
            },
            precheck: function () {
                if (total(want) === 0) return 'empty target: use unload';
                var f = S.core.specialists.refind(key);
                if (!f.spec) return f.reason;
                var spec = f.spec;
                if (!isOwn(spec)) return 'not own';
                if (S.core.specialists.status(spec) !== S.SpecialistStatus.Idle) return 'not idle';
                if (!hasGarrison(spec)) return 'no garrison';
                if (isTravelling(spec)) return 'travelling';
                var cls = classOf(want);
                if (cls === S.TroopClass.Mixed || cls === S.TroopClass.Unknown) return 'troop class ' + cls;
                var cap = S.core.specialists.troopCapacity(spec);
                if (cap > 0 && total(want) > cap) return 'over capacity (' + total(want) + ' > ' + cap + ')';
                var have = readGeneralArmy(spec);
                if (have === null) return 'army unreadable';
                var draw = RAISE_REUSES_OWN_TROOPS ? minus(want, have) : want;
                if (!isEmpty(minus(draw, freeArmy()))) return 'free pool does not cover the raise';
                return null;
            },
            send: function () {
                var f = S.core.specialists.refind(key);
                if (!f.spec) return false;
                var vo = buildRaiseVO(f.spec, want);
                if (!vo) return false;
                return S.core.packets.sendMessage(1031, vo) === true;
            },
            check: function () {
                return armyIs(key, false, want);
            }
        };
    }

    // Def that empties a general's army back into the free pool, with the
    // client's own shortcut. The free pool growth is only logged: another
    // raise or production in the same window can shrink the pool and make a
    // real unload look like it failed.
    function unload(key) {
        return {
            label:     'unload ' + key,
            category:  'army',
            timeoutMs: ACTION_TIMEOUT_MS,
            satisfied: function () {
                return armyIs(key, true);
            },
            precheck: function () {
                var f = S.core.specialists.refind(key);
                if (!f.spec) return f.reason;
                if (!canUnload(f.spec)) return 'cannot unload';
                return null;
            },
            baseline: function () {
                return total(freeArmy());
            },
            send: function () {
                var f = S.core.specialists.refind(key);
                if (!f.spec) return false;
                try {
                    var util = game.def('MilitarySystem::cMilitaryUtil');
                    if (!util || typeof util.SendRaiseArmyToServer !== 'function') return false;
                    util.SendRaiseArmyToServer(game.gi, f.spec, null);
                    return true;
                } catch (e) {
                    S.kernel.warn('army', 'unload send threw:', e);
                    return false;
                }
            },
            check: function () {
                return armyIs(key, true);
            },
            describe: function (base) {
                return 'free pool ' + base + ' -> ' + total(freeArmy());
            }
        };
    }

    S.core.army = {
        RAISE_REUSES_OWN_TROOPS: RAISE_REUSES_OWN_TROOPS,
        FREE_POOL_CATEGORY:      FREE_POOL_CATEGORY,
        ACTION_TIMEOUT_MS:       ACTION_TIMEOUT_MS,
        unitBase:      unitBase,
        isElite:       isElite,
        squads:        squads,
        generalArmy:   generalArmy,
        readGeneralArmy: readGeneralArmy,
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
        text:          text,
        matches:       matches,
        classOf:       classOf,
        planSupply:    planSupply,
        canUnload:     canUnload,
        buildRaiseVO:  buildRaiseVO,
        raise:         raise,
        unload:        unload
    };

}(Steward));
