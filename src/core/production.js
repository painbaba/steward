/*
 * Troop production orders.
 *
 * Reads the home production queues (barracks and elite barracks), prices a
 * unit order against the player's stock and population, and builds the action
 * def that orders troops. Run the def with S.core.actions.attempt. Which unit
 * to order and when stays with the caller.
 *
 * Host facts, kept here only:
 *   - queue 0 is the barracks, queue 8 the elite barracks; the unit definition
 *     (GetIsElite) picks which one a unit is trained in
 *   - an order is message 91 with a dTimedProductionVO, one message per stack
 *     shape (a count of full stacks, then the remainder)
 *   - STACK_SIZE 25 is the stack size the autoTSO client uses by default
 *
 * Failure contract: queued() reports an unreadable queue as null, never as 0,
 * so a failed read cannot look like an empty queue or a finished order. A
 * null stock or population reading counts as unaffordable.
 *
 * Bundle slot: core, after packets and before quests, resources and
 * specialists (core files load in name order). Nothing here calls another
 * core at load time; the top level only assigns S.core.production.
 */

(function (S) {

    var QUEUE_BARRACKS = 0;
    var QUEUE_ELITE    = 8;
    var STACK_SIZE     = 25;

    var ORDER_TIMEOUT_MS = 15000;

    var MESSAGE_ORDER = 91;
    var VO_ORDER      = 'Communication.VO::dTimedProductionVO';

    // Queue id for a unit, or null when the unit definition is unknown.
    function queueIdFor(unit) {
        var elite = S.core.army.isElite(unit);
        if (elite === null || elite === undefined) return null;
        return elite ? QUEUE_ELITE : QUEUE_BARRACKS;
    }

    // The host queue object for a unit, or null when it cannot be read.
    function queueOf(unit) {
        var id = queueIdFor(unit);
        if (id === null) return null;
        try {
            var zone = S.core.zone.current();
            if (!zone || typeof zone.GetProductionQueue !== 'function') return null;
            return zone.GetProductionQueue(id) || null;
        } catch (e) {
            S.kernel.warn('production', 'GetProductionQueue threw:', e);
            return null;
        }
    }

    // Unit type of one queued entry, whichever accessor the host offers.
    function entryType(entry) {
        if (typeof entry.GetType_string === 'function') return entry.GetType_string();
        if (typeof entry.GetType === 'function') return entry.GetType();
        return entry.type_string;
    }

    // Units of this type waiting in the unit's queue: a number, or null when
    // the queue, its vector or an entry cannot be read.
    function queued(unit) {
        try {
            var q = queueOf(unit);
            if (!q) return null;
            var vec = q.mTimedProductions_vector;
            if (!vec || typeof vec.length !== 'number') return null;
            var total = 0;
            for (var i = 0; i < vec.length; i++) {
                var e = vec[i];
                if (!e) return null;
                if (entryType(e) !== unit) continue;
                var amount = typeof e.GetAmount === 'function' ? e.GetAmount() : e.amount;
                if (typeof amount !== 'number' || isNaN(amount)) return null;
                total += amount;
            }
            return total;
        } catch (e2) {
            S.kernel.warn('production', 'queued(' + unit + ') threw:', e2);
            return null;
        }
    }

    // Cost lines [{ name, amount }] of one unit, or null when unreadable.
    function costs(unit) {
        try {
            var ub = S.core.army.unitBase(unit);
            if (!ub || typeof ub.GetCosts_vector !== 'function') return null;
            var vec = ub.GetCosts_vector();
            if (!vec || typeof vec.length !== 'number') return null;
            var out = [];
            for (var i = 0; i < vec.length; i++) {
                var c = vec[i];
                if (!c || typeof c.name_string !== 'string' || typeof c.amount !== 'number') return null;
                out.push({ name: c.name_string, amount: c.amount });
            }
            return out;
        } catch (e) {
            S.kernel.warn('production', 'costs(' + unit + ') threw:', e);
            return null;
        }
    }

    // Splits n units into stack shapes: [{ amount, count }] with the full
    // stacks first and the remainder last. Each shape is one message.
    function stacks(n, size) {
        var out = [];
        if (typeof n !== 'number' || !(n > 0) || n !== Math.floor(n)) return out;
        var per = (typeof size === 'number' && size > 0) ? size : STACK_SIZE;
        var full = Math.floor(n / per);
        var rest = n - full * per;
        if (full > 0) out.push({ amount: per, count: full });
        if (rest > 0) out.push({ amount: rest, count: 1 });
        return out;
    }

    // Resources missing for n units: [{ name, need, have }]. have is null when
    // that reading failed, and a null reading counts as missing. null when the
    // unit's costs cannot be read.
    function shortfalls(unit, n) {
        var list = costs(unit);
        if (list === null) return null;
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var need = list[i].amount * n;
            var have = list[i].name === S.core.resources.POPULATION
                ? S.core.resources.freePopulation()
                : S.core.resources.amount(list[i].name);
            if (typeof have !== 'number' || have < need) {
                out.push({ name: list[i].name, need: need, have: typeof have === 'number' ? have : null });
            }
        }
        return out;
    }

    function affordable(unit, n) {
        var missing = shortfalls(unit, n);
        return missing !== null && missing.length === 0;
    }

    // Population cost of one unit: a number (0 when the unit costs none), or
    // null when the costs cannot be read.
    function populationCost(unit) {
        var list = costs(unit);
        if (list === null) return null;
        for (var i = 0; i < list.length; i++) {
            if (list[i].name === S.core.resources.POPULATION) return list[i].amount;
        }
        return 0;
    }

    // Pure. orders: [{ population, count }], population being the per-unit
    // Population cost. Returns how much population is missing for all of them
    // together, floored at 0; null when an input is not a number.
    function populationShortfall(orders, free) {
        if (typeof free !== 'number' || isNaN(free)) return null;
        var sum = 0;
        for (var i = 0; i < orders.length; i++) {
            if (typeof orders[i].population !== 'number' || typeof orders[i].count !== 'number') return null;
            sum += orders[i].population * orders[i].count;
        }
        return Math.max(0, sum - free);
    }

    function buildingGrid(q) {
        try {
            var b = q.productionBuilding;
            if (!b || typeof b.GetGrid !== 'function') return null;
            var g = b.GetGrid();
            return typeof g === 'number' ? g : null;
        } catch (e) {
            return null;
        }
    }

    // Order n units. Verified once the unit's queued total has grown by n over
    // the total read just before the first send. A retry orders only what is
    // still missing, so a late first order is never doubled.
    function order(unit, n) {
        var label = 'order ' + n + ' ' + unit;

        function sendShapes(q, remaining) {
            var shapes = stacks(remaining, STACK_SIZE);
            var grid = buildingGrid(q);
            if (shapes.length === 0 || grid === null) return false;
            for (var i = 0; i < shapes.length; i++) {
                var vo = game.def(VO_ORDER, true);
                if (!vo) return false;
                vo.productionType = q.mProductionType;
                vo.type_string = unit;
                vo.amount = shapes[i].amount;
                vo.stacks = shapes[i].count;
                vo.buildingGrid = grid;
                if (!S.core.packets.sendMessage(MESSAGE_ORDER, vo)) return false;
            }
            return true;
        }

        return {
            label:     label,
            category:  'production',
            timeoutMs: ORDER_TIMEOUT_MS,

            precheck: function () {
                if (!S.core.zone.isHome()) return 'not on the home zone';
                if (typeof n !== 'number' || !(n > 0) || n !== Math.floor(n)) return 'invalid amount';
                if (queueIdFor(unit) === null) return 'unknown unit';
                var q = queueOf(unit);
                if (!q) return 'production queue missing';
                if (buildingGrid(q) === null) return 'production building missing';
                if (typeof queued(unit) !== 'number') return 'production queue unreadable';
                var missing = shortfalls(unit, n);
                if (missing === null) return 'unit costs unreadable';
                if (missing.length > 0) return 'cannot afford: ' + missing[0].name;
                return null;
            },

            baseline: function () { return queued(unit); },

            send: function (base) {
                var now = queued(unit);
                if (typeof now !== 'number' || typeof base !== 'number') return false;
                var remaining = base + n - now;
                if (!(remaining > 0)) return false;
                var q = queueOf(unit);
                if (!q) return false;
                return sendShapes(q, remaining);
            },

            check: function (base) {
                var q = queued(unit);
                return typeof q === 'number' && typeof base === 'number' && q >= base + n;
            },

            describe: function (base) {
                return 'queued ' + base + ' -> ' + queued(unit);
            }
        };
    }

    S.core.production = {
        QUEUE_BARRACKS:     QUEUE_BARRACKS,
        QUEUE_ELITE:        QUEUE_ELITE,
        STACK_SIZE:         STACK_SIZE,
        queueIdFor:         queueIdFor,
        queued:             queued,
        costs:              costs,
        stacks:             stacks,
        shortfalls:         shortfalls,
        affordable:         affordable,
        populationCost:     populationCost,
        populationShortfall: populationShortfall,
        order:              order
    };

}(Steward));
