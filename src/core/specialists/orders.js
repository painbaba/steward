/*
 * General orders: move, attack, back to the star menu, send to another zone
 * (home to an adventure and back).
 *
 * Readers for a general's current task and action defs for the four orders.
 * The defs only describe how to check, send and observe; the caller runs them
 * with S.core.actions.attempt, which sends and verifies. Nothing here decides
 * which order to give or when.
 *
 * Packet: the client sends every order as the specialist task action with the
 * task code in p1, the target grid in p2 and a dStartSpecialistTaskVO carrying
 * the general's uniqueID, after pointing mCurrentCursor.mCurrentSpecialist at
 * the general. Orders set the cursor and call dispatch.sendTask with the grid.
 *
 * Task codes 4 (move), 5 (attack), 7 (travel to zone) and 12 (to star) are
 * autoTSO's GetOriginalType() values and have not been observed in steward
 * yet; they live in RAW_CODES only, and every finished order logs the raw
 * task type it observed so the codes can be confirmed from the console log.
 *
 * Every callback re-finds the general by uid key through
 * S.core.specialists.lookup, so a def never acts on a stale object. A failed
 * list read is "not observed", never success; a general that is not listed
 * is a refusal before the first send.
 *
 * Bundle slot: core, after specialists/geologists.js and, like every file
 * under core/specialists/, before specialists.js. The top level fills
 * S.GeneralTask and assigns S.core.specialists.orders; every reference to
 * another core happens at call time.
 */

(function (S) {

    if (!S.core.specialists) S.core.specialists = {};

    S.GeneralTask.Move         = 'GeneralTaskMove';
    S.GeneralTask.Attack       = 'GeneralTaskAttack';
    S.GeneralTask.TravelToZone = 'GeneralTaskTravelToZone';
    S.GeneralTask.ToStar       = 'GeneralTaskToStar';

    // The client's cursor edit mode for placing a garrison, used by its own
    // placeable check before a move.
    var EDIT_MODE_PLACE_GARRISON = 86;

    // Host task codes per order (autoTSO's GetOriginalType switch).
    var RAW_CODES = {};
    RAW_CODES[S.GeneralTask.Move]         = 4;
    RAW_CODES[S.GeneralTask.Attack]       = 5;
    RAW_CODES[S.GeneralTask.TravelToZone] = 7;
    RAW_CODES[S.GeneralTask.ToStar]       = 12;

    // Verify windows per send. The star trip includes the unload, so it gets
    // the longer window.
    var MOVE_TIMEOUT_MS   = 15000;
    var ATTACK_TIMEOUT_MS = 15000;
    var STAR_TIMEOUT_MS   = 30000;
    var ZONE_TIMEOUT_MS   = 15000;

    var CATEGORY = 'specialists';

    function gi() {
        return (typeof game !== 'undefined' && game && game.gi) ? game.gi : null;
    }

    // --- Task readers. null means "no task" or "could not be read"; neither
    // ever equals a task kind or a grid, so a check that compares with ===
    // treats both as not observed.

    function task(spec) {
        if (!spec || typeof spec.GetTask !== 'function') return null;
        return spec.GetTask() || null;
    }

    function rawTaskType(spec) {
        try {
            var t = task(spec);
            if (!t || typeof t.GetOriginalType !== 'function') return null;
            var raw = t.GetOriginalType();
            return typeof raw === 'number' ? raw : null;
        } catch (e) {
            return null;
        }
    }

    function taskKind(spec) {
        var raw = rawTaskType(spec);
        if (raw === null) return null;
        for (var kind in RAW_CODES) {
            if (Object.prototype.hasOwnProperty.call(RAW_CODES, kind) && RAW_CODES[kind] === raw) return kind;
        }
        return null;
    }

    // Remaining travel time of the running task, or null. The unit is assumed
    // to be milliseconds and has not been observed; callers log it raw.
    function remaining(spec) {
        try {
            var t = task(spec);
            if (!t || typeof t.GetRemainingTime !== 'function') return null;
            var rem = t.GetRemainingTime();
            return (typeof rem === 'number' && isFinite(rem) && rem >= 0) ? rem : null;
        } catch (e) {
            return null;
        }
    }

    function newGrid(spec) {
        try {
            var t = task(spec);
            if (!t || typeof t.GetNewGarrisonGridIdx !== 'function') return null;
            var g = t.GetNewGarrisonGridIdx();
            return typeof g === 'number' ? g : null;
        } catch (e) {
            return null;
        }
    }

    // --- Host checks the client runs before an order.

    // The client's own placeable test. It switches the player's cursor into
    // the garrison edit mode, so the previous mode is restored in finally even
    // when the host throws.
    function isPlaceable(spec, grid) {
        var g = gi();
        if (!spec || !g || !g.mMouseCursor || !g.mCurrentCursor) return false;
        var entered = false;
        try {
            g.mMouseCursor.SetCursorEditMode(EDIT_MODE_PLACE_GARRISON);
            entered = true;
            g.mCurrentCursor.mCurrentSpecialist = spec;
            return g.mMouseCursor.CheckIfGarrisonIsPlacableInGame(grid, true) === 0;
        } catch (e) {
            S.kernel.warn(CATEGORY, 'isPlaceable threw:', e);
            return false;
        } finally {
            if (entered) {
                try { g.mMouseCursor.SetToLastEditMode(); }
                catch (e2) { S.kernel.warn(CATEGORY, 'SetToLastEditMode threw:', e2); }
            }
        }
    }

    // The client's path test: a path from the target building's street entry
    // to the general's garrison grid with a length above zero.
    function hasPath(spec, target) {
        var g = gi();
        if (!spec || !g || !g.mPathFinder || typeof g.mPathFinder.CalculatePath !== 'function') return false;
        try {
            var b = S.core.buildings.byGrid(target);
            if (!b || typeof b.GetStreetGridEntry !== 'function') return false;
            var from = S.core.army.garrisonGrid(spec);
            if (typeof from !== 'number') return false;
            var p = g.mPathFinder.CalculatePath(b.GetStreetGridEntry(), from, null, true);
            return !!p && typeof p.pathLenX10000 === 'number' && p.pathLenX10000 > 0;
        } catch (e) {
            S.kernel.warn(CATEGORY, 'hasPath threw:', e);
            return false;
        }
    }

    // Sends one order packet. kind is an S.GeneralTask value; grid goes to p2.
    // The cursor is pointed at the general first because the client expects it;
    // dispatch builds and sends the packet.
    function sendTask(spec, kind, grid) {
        var code = RAW_CODES[kind];
        if (typeof code !== 'number') {
            S.kernel.warn(CATEGORY, 'sendTask: unknown order', kind);
            return false;
        }
        var g = gi();
        if (!spec || !g || !g.mCurrentCursor) return false;
        try {
            g.mCurrentCursor.mCurrentSpecialist = spec;
        } catch (e) {
            S.kernel.warn(CATEGORY, 'sendTask: cursor setup threw:', e);
            return false;
        }
        return S.core.specialists.dispatch.sendTask(spec, code, grid) === true;
    }

    // --- Shared def parts.

    // Found, own and idle; the common precheck of every order.
    function ready(key) {
        var f = S.core.specialists.refind(key);
        if (!f.spec) return f;
        if (!S.core.army.isOwn(f.spec)) return { spec: null, reason: 'not own' };
        if (S.core.specialists.status(f.spec) !== S.SpecialistStatus.Idle) return { spec: null, reason: 'not idle' };
        return f;
    }

    function onGrid(spec, grid) {
        var g = S.core.army.garrisonGrid(spec);
        return typeof g === 'number' && g === grid;
    }

    function hasUnits(spec) {
        try { return typeof spec.HasUnits === 'function' && spec.HasUnits() === true; }
        catch (e) {
            S.kernel.warn(CATEGORY, 'HasUnits threw:', e);
            return false;
        }
    }

    // Off the map (grid 0 or below) with an army that read as empty.
    function atStar(spec) {
        var g = S.core.army.garrisonGrid(spec);
        if (typeof g !== 'number' || g > 0) return false;
        var army = S.core.army.readGeneralArmy(spec);
        return army !== null && S.core.army.isEmpty(army);
    }

    function describeOf(key) {
        return function () {
            var l = S.core.specialists.lookup(key);
            if (!l.ok) return 'specialist list unreadable';
            if (!l.spec) return 'specialist not listed';
            return 'observed task type ' + rawTaskType(l.spec) + ', grid ' + S.core.army.garrisonGrid(l.spec);
        };
    }

    // --- Defs.

    function move(key, grid) {
        return {
            label:     'move ' + key + ' -> ' + grid,
            category:  CATEGORY,
            timeoutMs: MOVE_TIMEOUT_MS,
            satisfied: function () {
                var f = S.core.specialists.refind(key);
                return !!f.spec && onGrid(f.spec, grid);
            },
            precheck: function () {
                var r = ready(key);
                if (!r.spec) return r.reason;
                if (typeof grid !== 'number' || !(grid > 0)) return 'bad grid ' + grid;
                if (!isPlaceable(r.spec, grid)) return 'not placeable at ' + grid;
                return null;
            },
            send: function () {
                var f = S.core.specialists.refind(key);
                return !!f.spec && sendTask(f.spec, S.GeneralTask.Move, grid);
            },
            check: function () {
                var f = S.core.specialists.refind(key);
                if (!f.spec) return false;
                if (taskKind(f.spec) === S.GeneralTask.Move && newGrid(f.spec) === grid) return true;
                return onGrid(f.spec, grid);
            },
            describe: describeOf(key)
        };
    }

    // fromGrid (optional): the grid of the wave line the general must stand
    // on before it attacks. No satisfied: an attack task already running is
    // not this order's effect. The check is the attack task alone, which the
    // client keeps for the whole battle; a target that is gone proves nothing,
    // since the building lookup also answers null when it cannot read.
    function attack(key, target, fromGrid) {
        return {
            label:     'attack ' + key + ' -> ' + target,
            category:  CATEGORY,
            timeoutMs: ATTACK_TIMEOUT_MS,
            precheck: function () {
                var r = ready(key);
                if (!r.spec) return r.reason;
                if (!hasUnits(r.spec)) return 'no units';
                if (typeof fromGrid === 'number' && !onGrid(r.spec, fromGrid)) return 'not on line grid ' + fromGrid;
                if (typeof target !== 'number' || !(target > 0)) return 'bad target ' + target;
                S.core.buildings.invalidate();
                var b = S.core.buildings.byGrid(target);
                if (!b) return 'no building at ' + target;
                if (!S.core.buildings.isEnemy(b)) return 'target ' + target + ' not enemy';
                if (!hasPath(r.spec, target)) return 'no path to ' + target;
                return null;
            },
            send: function () {
                var f = S.core.specialists.refind(key);
                return !!f.spec && sendTask(f.spec, S.GeneralTask.Attack, target);
            },
            check: function () {
                var f = S.core.specialists.refind(key);
                return !!f.spec && taskKind(f.spec) === S.GeneralTask.Attack;
            },
            describe: describeOf(key)
        };
    }

    // Absence from the list only counts as success when the baseline saw the
    // general and the same zone is still viewed: another zone has its own
    // specialist list, which never contains this general.
    function leftList(base) {
        if (!base || base.found !== true || typeof base.zoneId !== 'number') return false;
        return S.core.zone.id() === base.zoneId;
    }

    // Back to the star menu. The client also sets a local TravelToStarMenu
    // task after sending, which proves nothing about the server, so no task is
    // set here and the check looks for the end state instead: off the map with
    // an empty army, or gone from a list that read fine after the precheck saw
    // it on the map.
    function star(key) {
        return {
            label:     'star ' + key,
            category:  CATEGORY,
            timeoutMs: STAR_TIMEOUT_MS,
            satisfied: function () {
                var f = S.core.specialists.refind(key);
                return !!f.spec && atStar(f.spec);
            },
            precheck: function () {
                var r = ready(key);
                if (!r.spec) return r.reason;
                var g = S.core.army.garrisonGrid(r.spec);
                if (typeof g !== 'number' || !(g > 0)) return 'not on the map';
                return null;
            },
            baseline: function () {
                return { found: true, zoneId: S.core.zone.id() };
            },
            send: function () {
                var f = S.core.specialists.refind(key);
                if (!f.spec) return false;
                // The client passes the cursor's grid along; copied as it is.
                var pos = 0;
                try {
                    var c = gi() ? gi().mCurrentCursor : null;
                    if (c && typeof c.GetGridPosition === 'function') pos = c.GetGridPosition();
                } catch (e) {
                    S.kernel.warn(CATEGORY, 'star: GetGridPosition threw:', e);
                }
                return sendTask(f.spec, S.GeneralTask.ToStar, typeof pos === 'number' ? pos : 0);
            },
            check: function (base) {
                var l = S.core.specialists.lookup(key);
                if (!l.ok) return false;
                if (l.spec === null) return leftList(base);
                return atStar(l.spec);
            },
            describe: describeOf(key)
        };
    }

    // Sends a general from the viewed zone to another: home to an adventure
    // (zoneId from S.core.adventures.zoneIdOf), or an adventure back home. The
    // client's battle window uses the same call for Return home. Seen as sent
    // when it left the viewed list, carries the travel task or reports
    // travelling.
    function sendToZone(key, zoneId) {
        return {
            label:     'send ' + key + ' to zone ' + zoneId,
            category:  CATEGORY,
            timeoutMs: ZONE_TIMEOUT_MS,
            precheck: function () {
                if (typeof zoneId !== 'number') return 'bad zone id ' + zoneId;
                var viewed = S.core.zone.id();
                if (typeof viewed !== 'number') return 'viewed zone unreadable';
                if (viewed === zoneId) return 'already on zone ' + zoneId;
                var r = ready(key);
                if (!r.spec) return r.reason;
                return null;
            },
            baseline: function () {
                return { found: true, zoneId: S.core.zone.id() };
            },
            send: function () {
                var f = S.core.specialists.refind(key);
                if (!f.spec) return false;
                try {
                    var sm = game.def('com.bluebyte.tso.service::ServiceManager');
                    var inst = sm && typeof sm.getInstance === 'function' ? sm.getInstance() : null;
                    if (!inst || !inst.specialist || typeof inst.specialist.sendToZone !== 'function') {
                        S.kernel.warn(CATEGORY, 'sendToZone: ServiceManager.specialist unavailable');
                        return false;
                    }
                    inst.specialist.sendToZone(f.spec, zoneId);
                    return true;
                } catch (e) {
                    S.kernel.warn(CATEGORY, 'sendToZone threw:', e);
                    return false;
                }
            },
            check: function (base) {
                var l = S.core.specialists.lookup(key);
                if (!l.ok) return false;
                if (l.spec === null) return leftList(base);
                if (taskKind(l.spec) === S.GeneralTask.TravelToZone) return true;
                return S.core.army.isTravelling(l.spec) === true;
            },
            describe: describeOf(key)
        };
    }

    S.core.specialists.orders = {
        RAW_CODES:         RAW_CODES,
        MOVE_TIMEOUT_MS:   MOVE_TIMEOUT_MS,
        ATTACK_TIMEOUT_MS: ATTACK_TIMEOUT_MS,
        STAR_TIMEOUT_MS:   STAR_TIMEOUT_MS,
        ZONE_TIMEOUT_MS:   ZONE_TIMEOUT_MS,
        rawTaskType:       rawTaskType,
        taskKind:          taskKind,
        newGrid:           newGrid,
        remaining:         remaining,
        isPlaceable:       isPlaceable,
        hasPath:           hasPath,
        sendTask:          sendTask,
        move:              move,
        attack:            attack,
        star:              star,
        sendToZone:        sendToZone
    };

}(Steward));
