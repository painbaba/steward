/*
 * Shared test world of the adventures module.
 *
 * The game is the army/actions stub host; the world applies the effect of
 * each order the way the client would, and play() runs the queued entries in
 * order with a test clock that advances by each entry's delay. The waves test
 * uses the island world; the series test passes { home: true } for a home
 * island and an adventure island with their own specialist lists, free pools,
 * travel between them, map and population buffs and the production queues.
 *
 *   var W = require('../stubs/adventures');
 *   var w = W.world({ generals: [g1, g2] });            // viewing the island
 *   var w = W.world({ home: true, generals: [g1] });     // viewing home
 *   W.startRun(w, ['C:/b/w1.txt'], { step: w.S.WaveStep.Attack });
 *   W.tick(w); W.play(w); W.runOut(w);
 *   w.ghost(g1, 3);                                      // a ghost for 3 ticks
 *   W.ticksFor(w, 60000);                                // the clock, tick by tick
 *
 * Set w.pickups to a list of { grid, name, kind, zoneId } to put map objects on
 * the viewed zone (null: the map cannot be read); the world's pickups.click
 * removes the object that was clicked.
 *
 * Set w.campsUnreadable = true to make the building list of the viewed zone
 * read as unreadable (core.buildings.readable() false), so no camp counts as
 * gone.
 *
 * Nothing here edits the shared stubs; host fakes are installed on the booted
 * harness only.
 */

'use strict';

var harness = require('../harness');
var airfs = require('./airfs');
var A = require('./army');
var AC = require('./actions');
var SP = require('./specialists');

var HOME = 1;
var ZONE = 7;
var RUN_FILE = 'C:/client/steward/adventures/run.json';
var LOADOUT = 'C:/b/loadout.txt';
var ADVENTURE_MANAGER = 'com.bluebyte.tso.adventure.logic::AdventureManager';
var SERVICE_MANAGER = 'com.bluebyte.tso.service::ServiceManager';

// Host message and action ids the world reacts to.
var ACTION_BUFF = 61;
var MESSAGE_RAISE = 1031;
var MESSAGE_ORDER = 91;

// Star-menu types; the population resource name is read from the core.
var MAP_TYPE = 'Adventure';
var POPULATION_TYPE = 'AddResource';

// The scheduler's plan gap; the grace of a missing general restarts when
// reports are further apart than a few of these.
var TICK_MS = 10000;

function plain(v) { return JSON.parse(JSON.stringify(v)); }

// Null for a ghost, which the world's own lookups walk past like the client's
// list does: its id is unreadable, not gone.
function keyOf(spec) {
    return typeof spec.GetUniqueID === 'function' ? spec.GetUniqueID().toKeyString() : null;
}

function writeJson(fs, path, data) { fs.disk[path] = JSON.stringify(data); }

// ---- world ----------------------------------------------------------------

// The world's view of the core library: camps, camp buffs and quests. Core
// functions live in the bundle, so a script reload needs this applied again.
function patchCore(w) {
    var S = w.S;
    S.core.buildings.byGrid = function (grid) {
        if (!w.camps[grid]) return null;
        return { grid: grid, GetStreetGridEntry: function () { return grid + 1000; } };
    };
    S.core.buildings.isEnemy = function (b) { return !!b && w.camps[b.grid] === true; };
    S.core.buildings.readable = function () { return w.campsUnreadable !== true; };

    S.core.buffs.camp = function (name, grid) {
        var done = false;
        return {
            label: 'buff ' + name + ' -> ' + grid,
            timeoutMs: 15000,
            send: function () { w.buffs.push({ name: name, grid: grid, t: w.t }); done = true; return true; },
            check: function () { return done; }
        };
    };

    // Map objects of the viewed zone: w.pickups is null (unreadable) or a
    // list of { grid, name, kind, zoneId }. Like the real read, an ask with no
    // patterns lists quest objects only.
    S.core.pickups.targets = function (opts) {
        if (w.pickups === null) return null;
        var withPatterns = !!(opts && opts.patterns && opts.patterns.length);
        return w.pickups.filter(function (p) { return withPatterns || p.kind === 'quest'; })
            .map(function (p) { return { grid: p.grid, name: p.name, kind: p.kind, zoneId: p.zoneId }; });
    };
    S.core.pickups.click = function (target) {
        var done = false;
        return {
            label: 'pick up ' + target.name + ' at ' + target.grid,
            timeoutMs: 6000,
            send: function () {
                if (w.pickups) {
                    w.pickups = w.pickups.filter(function (p) { return p.grid !== target.grid; });
                }
                done = true;
                return true;
            },
            check: function () { return done; }
        };
    };

    S.core.quests.list = function () {
        if (w.quests === null) return null;
        return w.quests.map(function (q) {
            return { key: q.key, name: q.name, finished: !!q.finished, last: !!q.last, unread: !!q.unread };
        });
    };
    S.core.quests.unread = function () {
        if (w.quests === null) return null;
        return w.quests.filter(function (q) { return q.unread; });
    };
    S.core.quests.read = function (key) {
        w.reads.push({ key: key });
        return {
            label: 'read quest ' + key,
            timeoutMs: 15000,
            send: function () {
                if (w.auto.readFails) return true;
                for (var i = 0; i < w.quests.length; i++) {
                    if (w.quests[i].key === key) w.quests[i].unread = false;
                }
                return true;
            },
            check: function () { return !w.auto.readFails; }
        };
    };
    S.core.quests.finished = function () {
        if (w.quests === null) return null;
        return w.quests.filter(function (q) { return q.finished; });
    };
    S.core.quests.claim = function (key, opts) {
        w.claims.push({ key: key, opts: opts });
        return {
            label: 'claim quest ' + key,
            timeoutMs: 15000,
            send: function () {
                w.quests = w.quests.filter(function (q) { return q.key !== key; });
                return true;
            },
            check: function () { return true; }
        };
    };
}

// A copy of the list of entries for the star menu; amounts are read at call
// time, so the world can spend them.
function buffVector(stock) {
    return stock.filter(function (b) { return b.amount > 0; }).map(function (b) { return A.buffEntry(b); });
}

// Adds a GetRemainingTime to the task of a general whose state.task carries
// `remaining`, the way the client reports travel and busy time.
function withRemaining(g) {
    var base = g.GetTask;
    g.GetTask = function () {
        var t = base.apply(g, arguments);
        if (t && g.state.task && typeof g.state.task.remaining === 'number') {
            var rem = g.state.task.remaining;
            t.GetRemainingTime = function () { return rem; };
        }
        return t;
    };
    return g;
}

// Star-menu stock of the home world: o.maps adventure maps of BlackKnights
// and one population stack of o.population.
function homeStock(o, popName) {
    return [
        { type: MAP_TYPE, resource: 'BlackKnights', amount: typeof o.maps === 'number' ? o.maps : 3, uid: 'map' },
        { type: POPULATION_TYPE, resource: popName,
            amount: typeof o.population === 'number' ? o.population : 50, uid: 'pop' }
    ];
}

// o.generals: AC.general list (the viewed zone's specialist list, mutable
// through w.fighters); o.free: free pool map; o.camps: grid -> true (enemy)
// or 'own'; o.quests: [{ key, name, finished, last, unread }] or null (unreadable);
// o.fs: an airfs disk to boot on (fresh boot on the same disk); o.settings:
// the module's stored settings, written right after boot.
//
// o.home (off by default) builds two zones, HOME (viewed at start, holding
// o.generals and o.free) and ZONE (o.away generals, o.awayFree pool):
//   - gi.visitZone(id) switches the viewed zone, its specialist list
//     (w.fighters) and its free pool (w.free);
//   - sendToZone moves a general to the other zone's list with a travel task
//     (remaining w.travelMs) that w.arrive() clears;
//   - a star keeps the general listed at grid 0 and moves its army into the
//     free pool;
//   - o.mapOpen lists the adventure from the start; a map buff (o.maps in
//     stock) opens it; the manager's removeAdventure closes it;
//   - production queues 0 and 8 fill from order messages; w.produce() moves
//     them into the home free pool;
//   - free population is w.pop (o.pop, default 100); a population buff
//     (o.population in stock) raises it unless w.popNoEffect (o.popNoEffect);
//   - unit costs are w.costs (o.costs, default one Population per unit) and
//     other resources w.resources (o.resources);
//   - the quest pool has a last quest that is not finished;
//   - w.reads lists every core.quests.read(key) send, and a read clears the
//     quest's unread flag. w.auto.readFails models a read that never reached
//     the client (quest not found, no server action): the quest stays unread
//     and the check fails. It does not model a server refusal.
//
// On either world:
//   - w.landing(grids) fills the map's landing fields (none by default);
//   - w.blocked[grid] = true makes the client refuse that grid for a placement;
//   - the client's star rule holds on the adventure: a general at the star can
//     only be placed on a landing field, a general on the map never on one,
//     and a landing field an own fighter stands on is refused;
//   - w.auto.taken (default off) makes the client refuse, with code 1, any grid
//     an own fighter on the viewed zone stands on, as the live client does off a
//     landing field; landing fields keep answering 9;
//   - w.auto.walk makes a move a walk: a Move task that holds until
//     w.endWalks() puts each walker on its grid (default: instant move);
//   - a general at the star (grid <= 0) has no garrison, so a raise is refused;
//   - w.auto.starKeep keeps a starred general listed at grid 0, as the live
//     client does, with his army in the free pool (default on the island world:
//     he leaves the list, as tests on that end state expect);
//   - w.ghost(g, passes) makes g a bridge ghost for the next passes ticks
//     (default 1), play() in between included;
//   - w.ghostAfterRead(g) does the same from the moment the next inventory
//     read ends, for a flip inside a pass;
//   - w.afterRead(fn) runs fn once the next inventory read ends, for any
//     change inside a pass (ghostAfterRead is one such fn);
//   - w.nullListRead(n) makes the n-th specialist list read from now return
//     null, the way the client does for a moment; earlier reads pass through;
//   - w.hideReads(g, n, mode) hides g from the next n specialist list reads:
//     each returns a copy of the list without g (mode 'short', the default)
//     or with a null slot in his place (mode 'falsy'), the way the bridge
//     loses an entry for a moment; then the real getter is back.
function world(o) {
    o = o || {};
    var fs = o.fs || airfs.make();
    var alerts = [];
    var H = harness.boot({ host: { air: fs.air, showGameAlert: function (m) { alerts.push(m); } } });
    var S = H.Steward;
    if (o.settings && typeof o.settings === 'object' && !Array.isArray(o.settings)) {
        S.kernel.settings.write('adventures', o.settings);
    }
    var home = o.home === true;
    var fighters = (o.generals || []).slice(0);
    var units = A.unitCatalogue([], ['Rifle', 'Bow']);
    A.install(H, { fighters: fighters, units: units });
    var sent = AC.wire(H);
    var gi = H.host.game.gi;

    var defaultQuests = home ? [{ key: 'q9', name: 'Final', finished: false, last: true }] : [];
    var w = {
        fs: fs, H: H, S: S, sent: sent, alerts: alerts, fighters: fighters,
        home: home,
        t: 1000000,
        free: o.free || { Rifle: 100, Bow: 100 },
        camps: o.camps || { 100: true, 200: true, 300: true },
        quests: o.quests === undefined ? defaultQuests : o.quests,
        auto: { move: true, attack: true, star: true, raise: true, unload: true,
            map: true, visit: true, travel: true, close: true, walk: false, starKeep: false, taken: false },
        blocked: {},
        pickups: [],
        orders: [], raises: [], unloads: [], buffs: [], claims: [], reads: [],
        zoneSends: [], buffActions: [], productionOrders: [], closes: [],
        pending: [], entries: [], ghosts: [],
        adventures: home && !o.mapOpen ? [] : [{ adventureName: 'BlackKnights', zoneID: ZONE }],
        stock: [],
        lists: {},
        frees: {}
    };
    w.lists[home ? HOME : ZONE] = fighters;
    w.frees[home ? HOME : ZONE] = w.free;
    w.st = S.modules.adventures.state;
    w.ex = S.modules.adventures.executor;
    w.mod = H.module('adventures');

    w.st.now = function () { return w.t; };
    gi.mCurrentViewedZoneID = home ? HOME : ZONE;
    gi.mCurrentPlayer.mIsAdventureZone = !home;
    gi.isOnHomzone = function () { return gi.mCurrentViewedZoneID === HOME; };
    H.host.game.zone.GetArmy = function () { return A.armyOf(w.free); };
    gi.mCurrentPlayer.getAvailableBuffs_vector = function () { return buffVector(w.stock); };
    gi.mMouseCursor.CheckIfGarrisonIsPlacableInGame = function (grid) {
        var spec = gi.mCurrentCursor.mCurrentSpecialist;
        var at = spec && spec.GetGarrisonGridIdx ? spec.GetGarrisonGridIdx() : 1;
        var map = H.host.game.zone.mStreetDataMap;
        var fields = (map && map.mLandingFields_vector) || [];
        var landing = fields.some(function (f) { return f.GetGrid() === grid; });
        var taken = (w.lists[gi.mCurrentViewedZoneID] || []).some(function (g) {
            return typeof g.GetGarrisonGridIdx === 'function' && g.GetGarrisonGridIdx() === grid;
        });
        if (w.blocked[grid]) return 1;
        if (!gi.isOnHomzone() && !(at > 0) && !landing) return 7;
        if (!gi.isOnHomzone() && at > 0 && landing) return 8;
        if (landing && taken) return 9;
        if (w.auto.taken && taken) return 1;
        return sent.placeable;
    };

    // Landing fields of the map: the grids the client lets a general be
    // placed on. Without a call there is no vector to read.
    w.landing = function (grids) {
        var zone = H.host.game.zone;
        if (!zone.mStreetDataMap) zone.mStreetDataMap = {};
        zone.mStreetDataMap.mLandingFields_vector = grids.map(function (g) {
            return { GetGrid: function () { return g; } };
        });
    };

    // Ends every walk: a general with a Move task stands on its target grid.
    w.endWalks = function () {
        Object.keys(w.lists).forEach(function (id) {
            w.lists[id].forEach(function (g) {
                var t = g.state.task;
                if (!t || t.type !== w.code.move) return;
                g.state.grid = t.newGrid;
                g.state.task = null;
            });
        });
    };

    w.ghost = function (g, passes) {
        w.ghosts.push({ restore: SP.ghost(g), left: passes || 1 });
    };

    w.afterRead = function (fn) {
        var army = S.core.army;
        var inventory = army.inventory;
        army.inventory = function () {
            army.inventory = inventory;
            var inv = inventory.apply(army, arguments);
            fn();
            return inv;
        };
    };

    w.ghostAfterRead = function (g) {
        w.afterRead(function () { w.ghost(g); });
    };

    w.nullListRead = function (n) {
        var zone = gi.mCurrentPlayerZone;
        var real = zone.GetSpecialists_vector;
        var left = n;
        zone.GetSpecialists_vector = function () {
            left--;
            if (left === 0) {
                zone.GetSpecialists_vector = real;
                return null;
            }
            return real.apply(this, arguments);
        };
    };

    w.hideReads = function (g, n, mode) {
        var zone = gi.mCurrentPlayerZone;
        var real = zone.GetSpecialists_vector;
        var left = typeof n === 'number' ? n : 1;
        zone.GetSpecialists_vector = function () {
            var list = real.apply(this, arguments);
            left--;
            if (left <= 0) zone.GetSpecialists_vector = real;
            if (!list) return list;
            var out = [];
            for (var i = 0; i < list.length; i++) {
                if (list[i] !== g) out.push(list[i]);
                else if (mode === 'falsy') out.push(null);
            }
            return out;
        };
    };

    // The general with this key on any zone.
    w.byKey = function (key) {
        for (var id in w.lists) {
            if (!Object.prototype.hasOwnProperty.call(w.lists, id)) continue;
            var list = w.lists[id];
            for (var i = 0; i < list.length; i++) if (keyOf(list[i]) === key) return list[i];
        }
        return null;
    };

    // The zone id whose list holds the general.
    w.zoneOf = function (g) {
        for (var id in w.lists) {
            if (Object.prototype.hasOwnProperty.call(w.lists, id) && w.lists[id].indexOf(g) >= 0) return Number(id);
        }
        return null;
    };

    // Order codes come from the orders table, so the test follows it.
    var RAW = S.core.specialists.orders.RAW_CODES;
    w.code = {
        move: RAW[S.GeneralTask.Move], attack: RAW[S.GeneralTask.Attack], star: RAW[S.GeneralTask.ToStar],
        travel: RAW[S.GeneralTask.TravelToZone], recover: RAW[S.GeneralTask.Recovering]
    };

    // Buff action: spends the star-menu entry and applies its effect.
    function buffAction(grid, amount, uid) {
        var key = uid && typeof uid.toKeyString === 'function' ? uid.toKeyString() : null;
        var e = null;
        for (var i = 0; i < w.stock.length && !e; i++) {
            if ((w.stock[i].uid || w.stock[i].type) === key) e = w.stock[i];
        }
        w.buffActions.push({ type: e ? e.type : null, resource: e ? e.resource : null, grid: grid, amount: amount, t: w.t });
        if (!e) return;
        if (e.type === POPULATION_TYPE) {
            e.amount -= amount;
            if (!w.popNoEffect) w.pop += amount;
            return;
        }
        e.amount -= 1;
        if (e.type === MAP_TYPE && w.auto.map) {
            w.adventures.push({ adventureName: e.resource, zoneID: ZONE });
        }
    }

    var sendAction = gi.SendServerAction;
    gi.SendServerAction = function (id, p1, p2, p3, data) {
        sendAction.apply(this, arguments);
        if (id === ACTION_BUFF) {
            buffAction(p2, p3, data);
            return;
        }
        var key = data && data.uniqueID ? data.uniqueID.toKeyString() : null;
        w.orders.push({ key: key, code: p1, grid: p2, t: w.t });
        var g = w.byKey(key);
        if (!g) return;
        if (p1 === w.code.move && w.auto.walk) g.state.task = { type: w.code.move, newGrid: p2 };
        else if (p1 === w.code.move && w.auto.move) g.state.grid = p2;
        if (p1 === w.code.attack && w.auto.attack) g.state.task = { type: w.code.attack };
        if (p1 === w.code.star && w.auto.star) {
            if (!home && !w.auto.starKeep) {
                var list = w.lists[w.zoneOf(g)];
                list.splice(list.indexOf(g), 1);
                return;
            }
            Object.keys(g.state.army).forEach(function (u) {
                w.free[u] = (w.free[u] || 0) + g.state.army[u];
            });
            g.state.army = {};
            g.state.grid = 0;
        }
    };

    // Raise: message 1031 with the full target composition. Order: message
    // 91, landing in the queue of its building's grid.
    var sendMessage = gi.mClientMessages.SendMessagetoServer;
    gi.mClientMessages.SendMessagetoServer = function (id, zone, data) {
        sendMessage.apply(this, arguments);
        if (id === MESSAGE_ORDER && home) {
            w.productionOrders.push({ unit: data.type_string, amount: data.amount * data.stacks, t: w.t });
            var q = data.buildingGrid === w.queues[8].grid ? w.queues[8] : w.queues[0];
            q.entries.push({ type: data.type_string, amount: data.amount * data.stacks });
            return;
        }
        if (id !== MESSAGE_RAISE) return;
        var key = data.armyHolderSpecialistVO.uid;
        w.raises.push(key);
        var g = w.byKey(key);
        if (!g || !w.auto.raise) return;
        var want = {};
        data.unitSquads.items.forEach(function (r) { want[r.name_string] = r.amount; });
        Object.keys(want).forEach(function (u) {
            var draw = want[u] - (g.state.army[u] || 0);
            if (draw > 0) w.free[u] = (w.free[u] || 0) - draw;
        });
        g.state.army = want;
    };

    sent.registerDef('MilitarySystem::cMilitaryUtil', {
        SendRaiseArmyToServer: function (host, spec) {
            w.unloads.push(keyOf(spec));
            if (!w.auto.unload) return;
            Object.keys(spec.state.army).forEach(function (u) {
                w.free[u] = (w.free[u] || 0) + spec.state.army[u];
            });
            spec.state.army = {};
        }
    });

    sent.registerDef(ADVENTURE_MANAGER, {
        getInstance: function () {
            return {
                getAdventures: function () { return w.adventures; },
                isMyAdventure: function () { return true; },
                removeAdventure: function (zoneId) {
                    w.closes.push({ zoneId: zoneId, t: w.t });
                    if (!w.auto.close) return;
                    w.adventures = w.adventures.filter(function (a) { return a.zoneID !== zoneId; });
                }
            };
        }
    });

    if (home) installHome(w, o, gi, units);

    // A Steward Pause: the kernel queue is emptied with no reload, so the
    // pending attempts vanish while the sends they made have gone out.
    w.kernelPause = function () {
        if (S.kernel.queue && typeof S.kernel.queue.reset === 'function') S.kernel.queue.reset();
        w.H.clearQueued();
        w.pending = [];
    };

    patchCore(w);

    return w;
}

// The second zone, travel, map, population and production of the home world.
function installHome(w, o, gi, units) {
    var S = w.S;
    var game = w.H.host.game;
    var awayList = (o.away || []).slice(0);
    w.lists[ZONE] = awayList;
    w.frees[ZONE] = o.awayFree || {};
    w.travelMs = 600000;
    w.pop = typeof o.pop === 'number' ? o.pop : 100;
    w.popNoEffect = o.popNoEffect === true;
    w.resources = o.resources || {};
    w.costs = o.costs || {
        Rifle: [{ name_string: 'Population', amount: 1 }],
        Bow:   [{ name_string: 'Population', amount: 1 }]
    };
    w.stock = homeStock(o, S.core.resources.POPULATION);
    w.queues = {
        0: { entries: [], grid: 111, type: 1 },
        8: { entries: [], grid: 222, type: 2 }
    };
    w.lists[HOME].forEach(withRemaining);
    awayList.forEach(withRemaining);

    var zoneObj = gi.mCurrentPlayerZone;
    zoneObj.GetSpecialists_vector = function () { return w.lists[gi.mCurrentViewedZoneID] || []; };
    zoneObj.GetProductionQueue = function (id) {
        var q = w.queues[id];
        if (!q) return null;
        return {
            mProductionType: q.type,
            productionBuilding: { GetGrid: function () { return q.grid; } },
            mTimedProductions_vector: q.entries.map(function (e) {
                return { GetType_string: function () { return e.type; }, GetAmount: function () { return e.amount; } };
            })
        };
    };

    units.GetAllUnit().forEach(function (u) {
        u.GetCosts_vector = function () { return w.costs[u.GetType()] || []; };
    });

    game.getResources = function () {
        return {
            GetResourceAmount: function (name) { return w.resources[name]; },
            GetFree: function () {
                // The client's GetFree takes no argument and throws on one.
                if (arguments.length) throw new Error('#1063');
                return w.pop;
            }
        };
    };

    game.player.GetHomeZoneId = function () { return HOME; };
    gi.mCurrentPlayer.GetHomeZoneId = function () { return HOME; };

    // Switches the viewed zone in place: the zone object stays, its list,
    // free pool and adventure flags follow the id.
    gi.visitZone = function (id) {
        if (!w.auto.visit) return;
        gi.mCurrentViewedZoneID = id;
        if (!w.lists[id]) w.lists[id] = [];
        if (!w.frees[id]) w.frees[id] = {};
        w.fighters = w.lists[id];
        w.free = w.frees[id];
        gi.mCurrentPlayer.mIsAdventureZone = id !== HOME;
        zoneObj.mAdventureName = id === HOME ? 'Home' : 'BlackKnights';
    };
    gi.visitZone(HOME);

    w.sent.registerDef(SERVICE_MANAGER, {
        getInstance: function () {
            return {
                specialist: {
                    sendToZone: function (spec, zoneId) {
                        var key = keyOf(spec);
                        w.zoneSends.push({ key: key, zoneId: zoneId, t: w.t });
                        if (!w.auto.travel) return;
                        var from = w.lists[w.zoneOf(spec)];
                        if (from) from.splice(from.indexOf(spec), 1);
                        if (!w.lists[zoneId]) w.lists[zoneId] = [];
                        w.lists[zoneId].push(spec);
                        spec.state.task = { type: w.code.travel, remaining: w.travelMs };
                        spec.state.travelling = true;
                    }
                }
            };
        }
    });

    // Every general on its way arrives: the travel task ends.
    w.arrive = function () {
        Object.keys(w.lists).forEach(function (id) {
            w.lists[id].forEach(function (g) {
                if (!g.state.travelling && !(g.state.task && g.state.task.type === w.code.travel)) return;
                g.state.travelling = false;
                g.state.task = null;
            });
        });
    };

    // The production queues finish: their units join the home free pool.
    w.produce = function () {
        var pool = w.frees[HOME];
        Object.keys(w.queues).forEach(function (id) {
            w.queues[id].entries.forEach(function (e) { pool[e.type] = (pool[e.type] || 0) + e.amount; });
            w.queues[id].entries = [];
        });
    };

    // Adds a general to a zone's list with GetRemainingTime support.
    w.place = function (g, zoneId) {
        withRemaining(g);
        if (!w.lists[zoneId]) w.lists[zoneId] = [];
        w.lists[zoneId].push(g);
        return g;
    };
}

// Moves the captured queue into w.pending, keeping FIFO order.
function drain(w) {
    w.pending = w.pending.concat(w.H.queued());
    w.H.clearQueued();
}

// One scheduler tick: plan() only when isReady, tagged with the module as
// the scheduler does. The scheduler's zone is { id, isHome, isAdventure } as
// the zone core reads it.
function tick(w) {
    var z = w.S.core.zone;
    var ready = w.mod.isReady({ zone: { id: z.id(), isHome: z.isHome(), isAdventure: z.isAdventure() } });
    if (ready) {
        w.S.kernel._currentModule = 'adventures';
        try { w.mod.plan({}); }
        finally { w.S.kernel._currentModule = null; }
        drain(w);
    }
    endGhosts(w);
    return ready;
}

// Ghosts whose last tick this was read normally again.
function endGhosts(w) {
    w.ghosts = w.ghosts.filter(function (e) {
        e.left--;
        if (e.left > 0) return true;
        e.restore();
        return false;
    });
}

// Moves the clock forward by ms with a tick every TICK_MS. A jump over the
// same time would look like nobody having looked, which restarts a grace.
function ticksFor(w, ms) {
    var end = w.t + ms;
    while (w.t < end) {
        w.t = Math.min(w.t + TICK_MS, end);
        tick(w);
    }
}

// Runs queued entries one by one (core.attempt through actions.step, the
// pacer through executor.pace) until none is left or until() holds. Each
// entry advances the clock by its delay and runs under its own module tag,
// so a re-enqueue inherits it as in the kernel queue.
function play(w, until) {
    drain(w);
    for (var n = 0; n < 2000 && w.pending.length; n++) {
        var e = w.pending.shift();
        w.entries.push(e);
        w.t += e.delay || 0;
        w.S.kernel._currentModule = e.moduleId;
        try {
            if (e.name === 'core.attempt') w.S.core.actions.step(e.params);
            else if (e.name === w.ex.PACE_ACTION) w.ex.pace(e.params);
        } finally {
            w.S.kernel._currentModule = null;
        }
        drain(w);
        if (until && until()) return n + 1;
    }
    return n;
}

// Ticks and plays until the run is no longer Running, has left the waves, or
// `max` ticks passed.
function runOut(w, max) {
    for (var i = 0; i < (max || 40); i++) {
        var r = w.st.run();
        if (!r || r.status !== w.S.RunStatus.Running || !w.st.isWaveStep(r.step)) return;
        tick(w);
        play(w);
    }
}

// A run at `step` of wave index `waveIndex` over the given wave files.
function startRun(w, paths, over) {
    over = over || {};
    var keys = {};
    w.fighters.forEach(function (g) { keys[keyOf(g)] = true; });
    var r = w.st.newRun({
        id: 42, templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights', zoneId: ZONE,
        paths: paths, loadoutPath: LOADOUT, loadoutKeys: over.loadoutKeys || keys,
        waveIndex: over.waveIndex || 0
    });
    if (over.step) r.step = over.step;
    w.st.begin({
        templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights', count: 1, ended: false,
        requested: w.t, finished: 0, closedAt: null
    }, r);
    return w.st.run();
}

function stepName(w) { return w.st.stepName(w.st.run().step); }

module.exports = {
    HOME:              HOME,
    ZONE:              ZONE,
    RUN_FILE:          RUN_FILE,
    LOADOUT:           LOADOUT,
    ADVENTURE_MANAGER: ADVENTURE_MANAGER,
    plain:             plain,
    keyOf:             keyOf,
    writeJson:         writeJson,
    patchCore:         patchCore,
    world:             world,
    drain:             drain,
    tick:              tick,
    ticksFor:          ticksFor,
    play:              play,
    runOut:            runOut,
    startRun:          startRun,
    stepName:          stepName
};
