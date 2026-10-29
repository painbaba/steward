/*
 * Buff inventory and buff actions.
 *
 * Reads the star-menu buff stock (including adventure maps) and the buff
 * definitions, and builds the action defs that apply a buff (speed, camp,
 * population) or start an adventure map. A def is run with
 * S.core.actions.attempt. Every reader reports an unreadable host as null, and
 * a def treats null as not observed: an unreadable stock never counts as
 * "the stock dropped".
 */

(function (S) {

    // The only place the speed-buff name prefix exists.
    var SPEED_BUFF_PREFIX = 'GeneralSpeedBuff_';

    // Star-menu type of adventure maps; the entry's resource is the adventure
    // name. The only place this type name exists.
    var ADVENTURE_MAP_TYPE = 'Adventure';

    // Wire values of the buff action (61): the player's own island grid, the
    // zone-wide target of a speed buff, and the star-menu type that carries the
    // population buff. 8825 and 0 are what the client's own buff UI sends; they
    // exist only here. The population resource name is read from
    // S.core.resources.POPULATION at call time, since that file loads after
    // this one.
    var PLAYER_GRID = 8825;
    var ZONE_GRID = 0;
    var POPULATION_TYPE = 'AddResource';

    var BUFF_TIMEOUT_MS = 15000;
    var MAP_TIMEOUT_MS = 30000;

    // Raw star-menu entries { type, resource, amount, uid } where uid is the
    // host's unique-id object, which the buff action needs as it is. null means
    // the player or the menu could not be read, so callers can tell "no buffs"
    // from "unreadable".
    function readEntries() {
        try {
            if (typeof game === 'undefined' || !game.gi || !game.gi.mCurrentPlayer ||
                typeof game.gi.mCurrentPlayer.getAvailableBuffs_vector !== 'function') {
                return null;
            }
            var vec = game.gi.mCurrentPlayer.getAvailableBuffs_vector();
            if (!vec) return null;
            var out = [];
            var n = vec.length || 0;
            for (var i = 0; i < n; i++) {
                var b = vec[i];
                var item = { type: '', resource: '', amount: 0, uid: null };
                try { item.type = b.GetType(); } catch (e1) { /* leave default */ }
                try { item.resource = b.GetResourceName_string(); } catch (e2) { /* leave default */ }
                try { item.amount = b.amount; } catch (e3) { /* leave default */ }
                try { item.uid = b.GetUniqueId(); } catch (e4) { /* leave default */ }
                out.push(item);
            }
            return out;
        } catch (e) {
            S.kernel.warn('buffs', 'inventory() threw:', e);
            return null;
        }
    }

    function inventory() {
        var raw = readEntries();
        var out = [];
        if (!raw) return out;
        for (var i = 0; i < raw.length; i++) {
            var key = '';
            try { key = raw[i].uid.toKeyString(); } catch (e) { /* leave default */ }
            out.push({ type: raw[i].type, resource: raw[i].resource, amount: raw[i].amount, uid: key });
        }
        return out;
    }

    // First in-stock entry of exactly this type and resource ('' = not bound
    // to a resource), carrying the uid object; null when there is none or the
    // menu cannot be read.
    function entry(type, resource) {
        var raw = readEntries();
        if (!raw) return null;
        var res = resource || '';
        for (var i = 0; i < raw.length; i++) {
            if (raw[i].type === type && (raw[i].resource || '') === res && raw[i].amount > 0) return raw[i];
        }
        return null;
    }

    // Stock of exactly this type and resource ('' = not bound to a resource):
    // a number, or null when the menu cannot be read. The map stock of an
    // adventure is stock(ADVENTURE_MAP_TYPE, name).
    function stock(type, resource) {
        var raw = readEntries();
        if (!raw) return null;
        var res = resource || '';
        var sum = 0;
        for (var i = 0; i < raw.length; i++) {
            if (raw[i].type === type && (raw[i].resource || '') === res) sum += (raw[i].amount || 0);
        }
        return sum;
    }

    // Whether the zone buff manager says this buff is running; null when the
    // manager is missing or the call throws.
    function isRunning(name) {
        try {
            var mgr = game.gi.mZoneBuffManager;
            if (!mgr || typeof mgr.isBuffRunning !== 'function') return null;
            return !!mgr.isBuffRunning(name);
        } catch (e) {
            return null;
        }
    }

    // Sends one buff of this type and resource to a grid; false when none is
    // in stock or the packet could not be sent.
    function send(type, resource, grid, amount) {
        var e = entry(type, resource);
        if (!e || !e.uid) return false;
        return S.core.packets.sendAction(61, 0, grid, amount, e.uid) === true;
    }

    // Plain buffs only: entries bound to a resource are a different stock.
    // 0 when the menu cannot be read.
    function amount(type) {
        var n = stock(type, '');
        return typeof n === 'number' ? n : 0;
    }

    // Adventure maps per adventure name. Runs on the menu's status tick, so
    // it stays silent while the game is not loaded.
    function mapCounts() {
        try {
            if (typeof game === 'undefined' || !game.gi || !game.gi.mCurrentPlayer) return {};
        } catch (e) {
            return {};
        }
        var out = {};
        var inv = inventory();
        for (var i = 0; i < inv.length; i++) {
            if (inv[i].type !== ADVENTURE_MAP_TYPE || !inv[i].resource) continue;
            var name = inv[i].resource;
            out[name] = (out[name] || 0) + (inv[i].amount || 0);
        }
        return out;
    }

    function definedNames(prefix) {
        var out = [];
        try {
            var map = game.def('global').map_BuffName_BuffDefinition;
            if (map) {
                for (var k in map) {
                    if (typeof k === 'string' && k.indexOf(prefix) === 0) out.push(k);
                }
            }
        } catch (e) { /* not enumerable */ }
        return out;
    }

    function isSpeedBuff(name) {
        return typeof name === 'string' && name.indexOf(SPEED_BUFF_PREFIX) === 0;
    }

    function effectText(name) {
        var t = S.core.locale.text('DES', name);
        var cut = t.indexOf('Target');
        if (cut !== -1) t = t.substring(0, cut);
        return t.replace(/^\s+|\s+$/g, '');
    }

    function speedBuffs() {
        var names = definedNames(SPEED_BUFF_PREFIX);
        var inv = inventory();
        var i;
        for (i = 0; i < inv.length; i++) {
            if (isSpeedBuff(inv[i].type) && names.indexOf(inv[i].type) === -1) names.push(inv[i].type);
        }
        names.sort();
        var out = [];
        for (i = 0; i < names.length; i++) {
            out.push({
                name:   names[i],
                amount: amount(names[i]),
                label:  S.core.locale.res(names[i]),
                effect: effectText(names[i])
            });
        }
        return out;
    }

    function isNum(v) { return typeof v === 'number' && !isNaN(v); }

    // The host's population resource name, owned by core/resources.js.
    function populationResource() { return S.core.resources.POPULATION; }

    // Speed buff: zone-wide, so it targets grid 0. Verified by the buff running
    // or by the stock dropping below the baseline.
    function speed(name) {
        return {
            label:     'speed buff ' + name,
            category:  'buffs',
            timeoutMs: BUFF_TIMEOUT_MS,
            precheck: function () {
                if (!isSpeedBuff(name)) return 'not a speed buff';
                var n = stock(name, '');
                if (!isNum(n)) return 'buff stock unreadable';
                if (!(n > 0)) return 'no buff in stock';
                if (isRunning(name) === true) return 'buff already running';
                return null;
            },
            baseline: function () { return { stock: stock(name, '') }; },
            send: function () { return send(name, '', ZONE_GRID, 0); },
            check: function (base) {
                if (isRunning(name) === true) return true;
                var n = stock(name, '');
                return !!base && isNum(base.stock) && isNum(n) && n < base.stock;
            }
        };
    }

    // Camp buff: sent to the grid of the camp it is meant for, never to the
    // player grid. Verified by the stock dropping below the baseline.
    function camp(name, grid) {
        return {
            label:     'camp buff ' + name + ' -> ' + grid,
            category:  'buffs',
            timeoutMs: BUFF_TIMEOUT_MS,
            precheck: function () {
                if (!isNum(grid) || !(grid > 0)) return 'no target grid';
                var n = stock(name, '');
                if (!isNum(n)) return 'buff stock unreadable';
                if (!(n > 0)) return 'no buff in stock';
                S.core.buildings.invalidate();
                var b = S.core.buildings.byGrid(grid);
                if (!b || !S.core.buildings.isEnemy(b)) return 'no enemy building at grid';
                return null;
            },
            baseline: function () { return { stock: stock(name, '') }; },
            send: function () { return send(name, '', grid, 0); },
            check: function (base) {
                var n = stock(name, '');
                return !!base && isNum(base.stock) && isNum(n) && n < base.stock;
            }
        };
    }

    // Population buff: the exact amount the caller asks for. Verified by the
    // free population rising by that amount or the stock dropping by it.
    function population(amount) {
        return {
            label:     'population buff ' + amount,
            category:  'buffs',
            timeoutMs: BUFF_TIMEOUT_MS,
            precheck: function () {
                if (!isNum(amount) || amount !== Math.floor(amount) || !(amount > 0)) return 'invalid amount';
                var n = stock(POPULATION_TYPE, populationResource());
                if (!isNum(n)) return 'buff stock unreadable';
                if (n < amount) return 'not enough in stock';
                if (!isNum(S.core.resources.freePopulation())) return 'free population unreadable';
                return null;
            },
            baseline: function () {
                return {
                    free:  S.core.resources.freePopulation(),
                    stock: stock(POPULATION_TYPE, populationResource())
                };
            },
            send: function () { return send(POPULATION_TYPE, populationResource(), PLAYER_GRID, amount); },
            check: function (base) {
                if (!base) return false;
                var free = S.core.resources.freePopulation();
                if (isNum(free) && isNum(base.free) && free >= base.free + amount) return true;
                var n = stock(POPULATION_TYPE, populationResource());
                return isNum(n) && isNum(base.stock) && n <= base.stock - amount;
            },
            describe: function (base) {
                return 'free population ' + (base ? base.free : '?') + ' -> ' + S.core.resources.freePopulation();
            }
        };
    }

    function countOpen(list, name) {
        var c = 0;
        for (var i = 0; i < list.length; i++) {
            if (list[i].name === name) c++;
        }
        return c;
    }

    // Starts an adventure map from the star menu; only on the home island.
    // Verified by one more open adventure of that name or the map stock
    // dropping below the baseline.
    function map(name) {
        return {
            label:     'start map ' + name,
            category:  'buffs',
            timeoutMs: MAP_TIMEOUT_MS,
            precheck: function () {
                if (S.core.zone.isHome() !== true) return 'not on the home island';
                var n = stock(ADVENTURE_MAP_TYPE, name);
                if (!isNum(n)) return 'map stock unreadable';
                if (!(n > 0)) return 'no map in stock';
                if (!S.core.adventures.own()) return 'adventures unreadable';
                return null;
            },
            baseline: function () {
                var list = S.core.adventures.own();
                return {
                    open:  list ? countOpen(list, name) : null,
                    stock: stock(ADVENTURE_MAP_TYPE, name)
                };
            },
            send: function () { return send(ADVENTURE_MAP_TYPE, name, PLAYER_GRID, 0); },
            check: function (base) {
                if (!base) return false;
                var list = S.core.adventures.own();
                if (list && isNum(base.open) && countOpen(list, name) > base.open) return true;
                var n = stock(ADVENTURE_MAP_TYPE, name);
                return isNum(n) && isNum(base.stock) && n < base.stock;
            }
        };
    }

    S.core.buffs = {
        SPEED_BUFF_PREFIX: SPEED_BUFF_PREFIX,
        PLAYER_GRID:   PLAYER_GRID,
        ZONE_GRID:     ZONE_GRID,
        inventory:     inventory,
        entry:         entry,
        stock:         stock,
        isRunning:     isRunning,
        send:          send,
        amount:        amount,
        speed:         speed,
        camp:          camp,
        population:    population,
        map:           map,
        mapCounts:     mapCounts,
        definedNames:  definedNames,
        isSpeedBuff:   isSpeedBuff,
        effectText:    effectText,
        speedBuffs:    speedBuffs
    };

}(Steward));
