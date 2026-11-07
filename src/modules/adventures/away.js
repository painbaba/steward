/*
 * Away steps of an adventure run: from leaving home to coming back.
 *
 * Jump -> Arrive -> Pickups -> StarAll -> Horseshoe hand the run to the
 * wave executor at Gate of wave 1; after the last wave the executor hands it
 * back at PackStar -> Pack -> Clear -> LastQuest -> Close -> Recall ->
 * JumpHome, and the home steps take over at ArriveHome. A holder of free
 * troops is placed on a map grid before its raise, because the client has no
 * garrison for a general at the star; Clear goes back to PackStar while free
 * troops are left to pack. plan() does one step per call. The scheduler only calls it while no adventures queue entry is
 * pending, so every step observes the game first and never relies on a
 * callback having fired.
 *
 * Every acting step checks, in this order: the observed exit (the effect
 * is in the game, so the step moves on); a sent but unseen marker (wait
 * for its effect, then pause, never send it again on its own); the last
 * action round (a failure pauses, a last round without the effect waits
 * for it, then pauses); and only then a new round. Each order that must not
 * go out twice (claiming the last quest, closing the adventure, each recall,
 * the horseshoe) goes through a persisted marker written before the packet.
 *
 * A zone change has no event, so a jump polls for the zone to load, with no
 * limit: it visits once more after JUMP_MS and then every JUMP_RETRY_MS. Only
 * an adventure that left the own list ends the jump in a pause. The stuck-step
 * zone trip reuses the same jump (toHome, toIsland) and brings its own
 * on-loaded callback.
 *
 * The last quest is the reward of the map, so the run never treats it as
 * claimed without proof: a verified claim, the adventure gone from the own
 * list, or, after a claim went out, a readable quest list that has lacked
 * the quest for the whole grace. The adventure is closed only after such a
 * claim, and only when its name still points at the run's zone.
 *
 * Map objects are picked up by the collect module, never here; the run only
 * waits for them. Pickups gives collect a short watched time after arrival
 * and never pauses. Clear holds while quest objects are left, because an
 * open quest may need them before the last quest can finish; it pauses only
 * after CLEAR_PICKUP_MAX_MS with no battle and no object picked up.
 *
 * Bundle slot: module file; top level only assigns
 * S.modules.adventures.away; state, loader and every core are read at call
 * time.
 */

(function (S) {

    if (!S.modules.adventures) S.modules.adventures = {};

    // Starting values, to be tuned in game.
    var JUMP_MS             = 60000;    // a visited zone that has not loaded is visited once more
    var JUMP_RETRY_MS       = 300000;   // a further visit restarts a slow load, so later visits stay far apart
    var CLEAR_MAX_MS        = 300000;   // quiet time the last quest gets
    var PLACE_QUIET_MS      = 300000;   // quiet time a holder gets to find a free field
    var PICKUPS_MAX_MS      = 120000;   // watched time collect gets to pick up after arrival
    var CLEAR_PICKUP_MAX_MS = 900000;   // time with no battle and no pick-up quest objects may stay
    var TRANSIT_MS          = 4500000;  // free troops left on the island travel home by themselves (about an hour) and count as owned this long, unless seen landing first

    var CATEGORY = 'adventures';

    function has(obj, key) {
        return Object.prototype.hasOwnProperty.call(obj, key);
    }

    function st() {
        return S.modules.adventures.state;
    }

    function ld() {
        return S.modules.adventures.loader;
    }

    function now() {
        return S.modules.adventures.state.now();
    }

    function log(text) {
        S.kernel.log(CATEGORY, st().label() + ': ' + text);
    }

    function warn(text) {
        S.kernel.warn(CATEGORY, st().label() + ': ' + text);
    }

    // The key part of a marker name like 'recall:<key>'.
    function keyOfMark(name) {
        var i = name.indexOf(':');
        return i >= 0 ? name.slice(i + 1) : name;
    }

    // Whether the own adventure list (read, not null) no longer holds the
    // run's zone.
    function goneFrom(own, zoneId) {
        for (var i = 0; i < own.length; i++) {
            if (own[i] && own[i].zoneId === zoneId) return false;
        }
        return true;
    }

    function wt() {
        return S.modules.adventures.watcher;
    }

    function lastQuestOf(list) {
        for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].last) return list[i];
        }
        return null;
    }

    // The progress of a quiet clock against its limit, for a wait's text.
    function quietText(q, limit) {
        return Math.floor(q.ms / 60000) + ' of ' + Math.round(limit / 60000) + ' min quiet';
    }

    // ---- Jumps --------------------------------------------------------------

    // A visit the client refuses only warns: the zone may still load, and the
    // next visit comes in its own time.
    function visit(zoneId) {
        if (!S.core.zone.visit(zoneId)) warn('cannot visit zone ' + zoneId);
    }

    // Visits targetId until loaded() holds, with no limit, then marks the jump
    // seen and calls onLoaded. The marker's sentAt is the time of the last
    // visit; sentOnce means "visited again" and is written only by the retry,
    // so a resumed jump (sentAt cleared, sentOnce kept) visits at once and
    // then keeps the long interval.
    function jump(r, targetId, loaded, name, onLoaded) {
        if (loaded()) {
            ld().markSeen(r, name);
            onLoaded();
            return;
        }
        if (typeof targetId !== 'number') {
            ld().waitRead(r, 'target zone id');
            return;
        }
        var rec = ld().marked(r, name);
        if (!rec || typeof rec.sentAt !== 'number') {
            rec = ld().mark(r, name);
            rec.sentAt = now();
            st().save();
            log('visiting zone ' + targetId);
            visit(targetId);
        } else {
            var interval = rec.sentOnce ? JUMP_RETRY_MS : JUMP_MS;
            if (now() - rec.sentAt > interval) {
                rec.sentOnce = true;
                rec.sentAt = now();
                st().save();
                log('zone ' + targetId + ' not loaded after ' + Math.round(interval / 1000) + ' s, visiting again');
                visit(targetId);
            }
        }
        ld().waitBusy(r, null, 'zone ' + targetId + ' not loaded');
    }

    // Whether the run's adventure island is viewed, loaded and listing its
    // generals.
    function islandLoaded(r) {
        return typeof r.zoneId === 'number' && S.core.zone.id() === r.zoneId &&
            S.core.zone.isAdventure() && S.core.specialists.listReadable();
    }

    // Whether the home zone is viewed, loaded and listing its generals.
    function homeLoaded() {
        var homeId = S.core.zone.homeId();
        return typeof homeId === 'number' && S.core.zone.isHome() && S.core.zone.id() === homeId &&
            S.core.specialists.listReadable();
    }

    // Visiting a zone that no longer exists never ends, so an adventure gone
    // from the own list pauses. One read that lacks it proves nothing during
    // a zone load, so it has to stay gone for the grace.
    function toIsland(r, name, onLoaded) {
        if (typeof r.zoneId === 'number' && !islandLoaded(r)) {
            var own = S.core.adventures.own();
            if (own && goneFrom(own, r.zoneId) && ld().missingLong(r, 'adventure')) {
                st().pause(S.RunPause.JumpFailed, 'adventure no longer open');
                return;
            }
        }
        jump(r, r.zoneId, function () { return islandLoaded(r); }, name, onLoaded);
    }

    function toHome(r, name, onLoaded) {
        jump(r, S.core.zone.homeId(), homeLoaded, name, onLoaded);
    }

    function jumpStep(r) {
        toIsland(r, 'visit', function () { st().go(S.RunStep.Arrive, 'adventure loaded'); });
    }

    function jumpHome(r) {
        toHome(r, 'visitHome', function () { st().go(S.RunStep.ArriveHome, 'home loaded'); });
    }

    // ---- Arrival ------------------------------------------------------------

    // Waits per general, not by count: every loadout key must be listed here
    // and idle. There is no deadline: the game's remaining time runs short, so
    // no limit can be built on it, and a general not listed yet is on his way
    // or has to be looked at by the user, who sees the named wait.
    function arrive(r, inv) {
        var keys = ld().keysOf(r);
        var missing = null;
        var busy = null;
        for (var i = 0; i < keys.length; i++) {
            var g = ld().gen(inv, keys[i]);
            if (!g) { if (missing === null) missing = keys[i]; }
            else if (!ld().ready(g)) { if (busy === null) busy = keys[i]; }
        }
        if (missing === null && busy === null && inv.ok) {
            st().go(S.RunStep.Pickups, 'every general arrived');
            return;
        }
        if (missing !== null) {
            ld().waitBusy(r, missing, ld().who(inv, missing) + ' not here yet');
            return;
        }
        if (busy !== null) {
            ld().waitBusy(r, busy, ld().who(inv, busy) + ' busy');
            return;
        }
        ld().waitRead(r, 'armies');
    }

    // ---- Pickups ------------------------------------------------------------

    // Gives collect a short watched time to pick up what lies on the island
    // before the generals leave for the star. It never pauses: a pick-up is
    // no reason to stop a run, and Clear holds for the quest objects that
    // matter. When collect does not pick up on adventures there is nothing to
    // wait for.
    function pickups(r) {
        var w = wt();
        var pats = w.patterns();
        if (pats === null) {
            st().go(S.RunStep.StarAll, 'collect does not pick up on adventures');
            return;
        }
        var q = ld().quietClock(r, true, 'pickupClock');
        S.core.buildings.invalidate();
        var list = S.core.pickups.targets({ patterns: pats, quests: true });
        if (list === null) {
            if (q.ms >= PICKUPS_MAX_MS) {
                log('map objects unreadable, going on');
                st().go(S.RunStep.StarAll, 'map objects unreadable');
                return;
            }
            ld().waitRead(r, 'map objects');
            return;
        }
        if (!list.length) {
            st().go(S.RunStep.StarAll, 'nothing to pick up');
            return;
        }
        if (q.ms >= PICKUPS_MAX_MS) {
            log('pickups left: ' + w.pickupText(list));
            st().go(S.RunStep.StarAll, 'pickups left to collect');
            return;
        }
        ld().waitBusy(r, null, 'picking up ' + w.pickupText(list) + ', ' + quietText(q, PICKUPS_MAX_MS));
    }

    // ---- Star ---------------------------------------------------------------

    // At the star with a readable, empty army; the same end state the star
    // order checks.
    function atStar(g) {
        return typeof g.grid === 'number' && g.grid <= 0 && g.armyOk === true && S.core.army.total(g.army) === 0;
    }

    // A round of star orders for keys; a refusal or failure pauses StarFailed.
    function starRound(r, step, keys) {
        var next = ld().settleRound(r, step, function (f) {
            st().pause(S.RunPause.StarFailed, 'star ' + f.key + ' failed: ' + f.reason, { general: f.key });
        }, 'star');
        if (next !== 'new') return;
        var round = ld().startRound(r, step, []);
        for (var i = 0; i < keys.length; i++) ld().attempt(round, keys[i], S.core.specialists.orders.star(keys[i]));
    }

    // Every general goes to the star empty before the waves, so each wave
    // loads it from a known state. A general that left the list counts as
    // starred only on a positive read of the list and every army.
    function starAll(r, inv) {
        var keys = ld().keysOf(r);
        var todo = [];
        var unread = false;
        for (var i = 0; i < keys.length; i++) {
            var g = ld().gen(inv, keys[i]);
            if (g) {
                if (!atStar(g)) todo.push(keys[i]);
            } else if (!inv.ok) {
                unread = true;
            }
        }
        if (!todo.length && !unread) {
            st().go(S.RunStep.Horseshoe, 'every general at the star');
            return;
        }
        if (!todo.length) {
            ld().waitRead(r, 'generals');
            return;
        }
        starRound(r, S.RunStep.StarAll, todo);
    }

    // ---- Horseshoe ----------------------------------------------------------

    // Optional: a missing horseshoe or a refused one only warns, and a run
    // without one logs that and moves on. It is sent at most once per run; a
    // marker that went out (sentOnce survives a Resume) or was seen moves on
    // without a second send.
    function horseshoe(r) {
        var gate = 'to wave ' + (r.waveIndex + 1);
        var round = ld().currentRound(r, S.RunStep.Horseshoe);
        if (round && ld().complete(round)) {
            var res = ld().resultOf(round, 'speed');
            if (res && res.status === S.ActionResult.Verified) {
                ld().markSeen(r, 'speed');
                log('horseshoe applied');
            } else {
                warn('horseshoe not applied: ' + (res ? res.reason : 'no result'));
            }
            st().go(S.WaveStep.Gate, gate);
            return;
        }
        var rec = ld().marked(r, 'speed');
        if (rec && (rec.sentOnce || rec.seen)) {
            log('horseshoe already sent (' + (rec.seen ? 'seen' : 'not seen') + ')');
            st().go(S.WaveStep.Gate, gate);
            return;
        }
        var name = S.modules.adventures.templates.resolveSpeedBuff({ speedBuff: r.speedBuff },
            S.core.buffs.speedBuffs());
        if (name === null) {
            if (r.speedBuff === S.SpeedBuffChoice.None) log('horseshoe not used');
            else warn('no horseshoe in stock');
            st().go(S.WaveStep.Gate, gate);
            return;
        }
        // A round lost before its send leaves no marker and is started again.
        ld().dropOrphan(r);
        round = ld().startRound(r, S.RunStep.Horseshoe, []);
        ld().attempt(round, 'speed', ld().wrapSend(r, 'speed', S.core.buffs.speed(name)));
    }

    // ---- End of map ---------------------------------------------------------

    function standingText(r) {
        S.core.buildings.invalidate();
        var camps = ld().campsOf(r);
        var standing = [];
        for (var i = 0; i < camps.length; i++) {
            var b = S.core.buildings.byGrid(camps[i].grid);
            if (b && S.core.buildings.isEnemy(b)) standing.push(camps[i].text);
        }
        return standing.length ? standing.join(', ') : '';
    }

    function isCarrier(g) {
        return !!g && (g.cls === S.SpecialistType.Carrier || g.cls === S.SpecialistType.AdmiralCarrier);
    }

    // The one pack plan of PackStar, Pack and Clear: carriers first, then the
    // idle loadout generals, each holding one troop class within its
    // capacity. Sharing it keeps the three steps from disagreeing on what is
    // left to pack, so the Pack -> Clear -> PackStar cycle ends.
    function packPlan(r, inv) {
        var keys = ld().keysOf(r);
        var carriers = [];
        var generals = [];
        for (var i = 0; i < keys.length; i++) {
            var g = ld().gen(inv, keys[i]);
            if (!g) continue;
            var h = { key: g.key, capacity: g.capacity, army: g.army };
            if (isCarrier(g)) carriers.push(h);
            else if (g.cls === S.SpecialistType.General && ld().ready(g)) generals.push(h);
        }
        return S.core.army.planPack(inv.free, carriers.concat(generals));
    }

    // Keys of the planned raises whose holder is not on a map grid, in plan
    // order. PackStar's exit and Pack's way back both test this, so the two
    // steps never disagree on the same inventory.
    function offMap(p, inv) {
        var out = [];
        for (var i = 0; i < p.raises.length; i++) {
            if (!ld().onMap(ld().gen(inv, p.raises[i].key))) out.push(p.raises[i].key);
        }
        return out;
    }

    // The planned raises whose holder stands on a map grid, in plan order.
    function placedRaises(p, inv) {
        var out = [];
        for (var i = 0; i < p.raises.length; i++) {
            if (ld().onMap(ld().gen(inv, p.raises[i].key))) out.push(p.raises[i]);
        }
        return out;
    }

    // The map is clear when its last quest is finished and no loadout general
    // is still fighting. Once the quest is done a busy general is waited on
    // with no limit, so only the quest itself can time out. A general
    // recovering after a lost battle is not waited on: he takes no order
    // until his rest ends and goes home with the map. Free troops that only
    // he could have held stay in the pool, with one warning when Clear
    // leaves. A camp still standing only warns: it may belong to a side
    // quest or have been beaten in a way the map does not show. While quest
    // objects are left the quest may still need them, so the last quest's
    // own limit does not run; their own clock counts time with no battle and
    // starts again whenever one of them is picked up.
    // Leaving Clear records the leftover free troops as travelling home, so
    // the later home steps count them as owned until they land.
    function clear(r, inv) {
        var list = S.core.quests.list();
        var last = list ? lastQuestOf(list) : null;
        var questDone = !!(last && last.finished);
        var keys = ld().keysOf(r);
        var firstKey = null;
        var resting = [];
        for (var i = 0; i < keys.length; i++) {
            var g = ld().gen(inv, keys[i]);
            if (!g || ld().ready(g)) continue;
            if (ld().recovering(keys[i])) {
                resting.push(keys[i]);
                continue;
            }
            firstKey = keys[i];
            break;
        }
        if (questDone && firstKey === null && !ld().anyAttacking()) {
            if (!inv.ok) {
                ld().waitRead(r, 'free troops and armies');
                return;
            }
            // Troops freed by the last battles, or generals that were still
            // fighting during the first pack, are packed before the claim.
            // A recovering general is not ready, so the plan leaves his share
            // in the remainder.
            var p = packPlan(r, inv);
            if (p.raises.length) {
                st().go(S.RunStep.PackStar, 'free troops left to pack');
                return;
            }
            if (resting.length && S.core.army.total(p.remainder) > 0) {
                var names = [];
                for (i = 0; i < resting.length; i++) names.push(ld().who(inv, resting[i]));
                warn('left in the free pool while ' + names.join(', ') +
                    (resting.length === 1 ? ' recovers: ' : ' recover: ') + S.core.army.text(p.remainder));
            }
            var standing = standingText(r);
            if (standing) warn('camps still standing after the last quest: ' + standing);
            st().noteTransit(r, p.remainder, now() + TRANSIT_MS);
            if (S.core.army.total(p.remainder) > 0) {
                log('on the way home by themselves: ' + S.core.army.text(p.remainder) +
                    ', counted as yours for ' + Math.round(TRANSIT_MS / 60000) + ' min');
            }
            st().go(S.RunStep.LastQuest, 'last quest finished');
            return;
        }
        if (questDone) {
            ld().waitBusy(r, firstKey, firstKey !== null ? ld().who(inv, firstKey) + ' busy' : 'a fighter is busy');
            return;
        }
        // An unreadable list says nothing about the quest, so it does not feed
        // the clock either.
        if (list === null) {
            ld().waitRead(r, 'quest list');
            return;
        }
        // An unreadable map says nothing about the objects, so like the quest
        // list it holds with no limit and feeds no clock.
        var objs = wt().objects();
        if (objs === null) {
            ld().waitRead(r, 'quest objects');
            return;
        }
        if (objs.length) {
            clearPickups(r, objs);
            return;
        }
        // Only a running battle can still finish the quest, so the limit is
        // quiet time. Moving or idle generals count as quiet on purpose: a
        // general left waiting on a quest nothing works on must not hold the
        // run unseen.
        var q = ld().quietClock(r, !ld().anyAttacking());
        var over = q.ms >= CLEAR_MAX_MS;
        if (!last) {
            ld().waitBusy(r, null, 'last quest not listed, ' + quietText(q, CLEAR_MAX_MS));
            if (over) st().pause(S.RunPause.NotObserved, 'last quest not listed');
            return;
        }
        ld().waitBusy(r, null, 'last quest not finished, ' + quietText(q, CLEAR_MAX_MS));
        if (!over) return;
        var min = Math.round(CLEAR_MAX_MS / 60000);
        var camps = standingText(r) || 'none';
        st().pause(S.RunPause.ClearTimeout, 'last quest not finished after ' + min + ' min; camps standing: ' + camps);
    }

    // The hold of Clear while quest objects are left. The quiet clock is fed
    // without counting so it stays live and resumes where it was once the
    // objects are gone. Fewer objects than last seen is progress and restarts
    // the pickup clock.
    function clearPickups(r, objs) {
        var text = wt().pickupText(objs);
        ld().quietClock(r, false);
        var p = ld().quietClock(r, !ld().anyAttacking(), 'pickupClock');
        var c = st().current().pickupClock;
        if (c && typeof c.count === 'number' && objs.length < c.count) {
            c.ms = 0;
            p.ms = 0;
        }
        if (c) c.count = objs.length;
        ld().waitBusy(r, null, 'quest objects left: ' + text + ', ' + quietText(p, CLEAR_PICKUP_MAX_MS));
        if (p.ms < CLEAR_PICKUP_MAX_MS) return;
        var min = Math.round(CLEAR_PICKUP_MAX_MS / 60000);
        st().pause(S.RunPause.ClearTimeout, 'quest objects not picked up after ' + min + ' min: ' + text);
    }

    // Places the planned holders that wait at the star on free landing fields,
    // the only grids a general at the star can be placed on: a raise needs a
    // garrison, which a general has only on the map. A holder already walking
    // is waited on first, with no limit, because it may show its new grid
    // while not yet idle, and so a restart or a kernel Pause never orders it
    // twice.
    // A missing holder and a holder with no field are settled before the last
    // round is: past its read-lag hold, settleRound counts a finished round
    // every time it runs, so a hold after it would count the same round on each
    // pass and end in a false rounds pause. A round with a real failure still
    // goes to settleRound first, because that failure is the news.
    // A holder with no field does not stop the holders already placed: they
    // raise first, and a battle may yet free a field for him, so he waits for
    // quiet time. Pack judges this the same way, so the two steps cannot bounce.
    function packStar(r, inv) {
        if (!inv.ok) {
            ld().waitRead(r, 'free troops and armies');
            return;
        }
        var walking = ld().movingKey(r);
        if (walking !== null) {
            ld().waitBusy(r, walking, ld().who(inv, walking) + ' walking to its grid');
            return;
        }
        var p = packPlan(r, inv);
        var need = offMap(p, inv);
        if (!need.length) {
            st().go(S.RunStep.Pack, 'holders on the map');
            return;
        }
        var c = ld().chooseGrids(inv, need);
        if (c.missing !== null) {
            if (!ld().missingLong(r, c.missing)) return;
            st().pause(S.RunPause.GeneralMissing, ld().who(inv, c.missing) + ' is not on the island',
                { general: c.missing });
            return;
        }
        var blocked = c.blocked !== null && !c.moves.length;
        var last = ld().currentRound(r, S.RunStep.PackStar);
        if (blocked && !(last && ld().complete(last) && ld().firstFailure(last))) {
            var who = ld().who(inv, c.blocked);
            if (placedRaises(p, inv).length) {
                st().go(S.RunStep.Pack, who + ' has no field, packing the placed holders first');
                return;
            }
            var q = ld().quietClock(r, !ld().anyAttacking());
            ld().waitBusy(r, c.blocked, who + ' has no placeable grid, ' + quietText(q, PLACE_QUIET_MS));
            if (q.ms >= PLACE_QUIET_MS) {
                st().pause(S.RunPause.NotPlaceable, who + ' has no placeable grid (' + c.tried + ' tried)',
                    { general: c.blocked });
            }
            return;
        }
        var next = ld().settleRound(r, S.RunStep.PackStar, function (f) {
            st().pause(S.RunPause.PackFailed, 'place ' + f.key + ' failed: ' + f.reason, { general: f.key });
        }, 'place');
        if (next !== 'new') return;
        var round = ld().startRound(r, S.RunStep.PackStar, []);
        var text = [];
        for (var i = 0; i < c.moves.length; i++) {
            ld().attempt(round, c.moves[i].key, S.core.specialists.orders.move(c.moves[i].key, c.moves[i].grid));
            text.push(c.moves[i].key + ' -> ' + c.moves[i].grid);
        }
        log('placing ' + c.moves.length + ' holder(s): ' + text.join(', '));
    }

    // Free troops are packed so they travel home, by the shared pack plan.
    // Each verified round re-enters the step to plan again from the game;
    // every verified raise shrinks the free pool or the room, so this ends.
    // A planned holder off the map goes back to PackStar, so no raise is
    // ever sent to a general at the star. The one exception to going back is
    // PackStar's own: no field for him, nothing to place and holders already
    // placed. Then only those raise, and he stays at the star.
    function pack(r, inv) {
        if (!inv.ok) {
            ld().waitRead(r, 'free troops and armies');
            return;
        }
        var p = packPlan(r, inv);
        if (!p.raises.length) {
            if (S.core.army.total(p.remainder) > 0) warn('left in the free pool: ' + S.core.army.text(p.remainder));
            else log('free troops packed');
            st().go(S.RunStep.Clear, 'troops packed');
            return;
        }
        var round = ld().currentRound(r, S.RunStep.Pack);
        if (round && ld().complete(round) && !ld().firstFailure(round)) {
            // A plan on a free pool that still shows the raised troops would
            // raise too much.
            if (ld().roundSettling(round)) return;
            var n = 0;
            for (var k in round.expected) { if (has(round.expected, k)) n++; }
            st().go(S.RunStep.Pack, 'packed ' + n + ' holder(s)');
            return;
        }
        var raises = p.raises;
        var away = offMap(p, inv);
        if (away.length) {
            var c = ld().chooseGrids(inv, away);
            raises = placedRaises(p, inv);
            if (c.moves.length || c.missing !== null || !raises.length) {
                st().go(S.RunStep.PackStar, ld().who(inv, away[0]) + ' is not on the map');
                return;
            }
        }
        var next = ld().settleRound(r, S.RunStep.Pack, function (f) {
            st().pause(S.RunPause.PackFailed, 'pack ' + f.key + ' refused: ' + f.reason, { general: f.key });
        }, 'pack');
        if (next !== 'new') return;
        round = ld().startRound(r, S.RunStep.Pack, []);
        for (var i = 0; i < raises.length; i++) {
            ld().attempt(round, raises[i].key, S.core.army.raise(raises[i].key, raises[i].target));
        }
    }

    // Claims the last quest (the map's reward). Moves on only on proof: a
    // verified claim, the adventure gone from a readable own list, or, after a
    // claim went out, a readable list without the quest for the whole grace,
    // because one read can skip an entry. Off the island, or with a readable
    // list that lacks the quest and no claim sent, it holds, then pauses: only
    // the user can fix those. An unreadable list only waits.
    function lastQuest(r) {
        var rec = ld().marked(r, 'lastQuest');
        if (rec && rec.seen) {
            st().go(S.RunStep.Close, 'last quest claimed');
            return;
        }
        if (typeof r.zoneId !== 'number') {
            st().pause(S.RunPause.NotObserved, 'the run has no adventure zone; Stop the run');
            return;
        }
        var own = S.core.adventures.own();
        if (own && goneFrom(own, r.zoneId)) {
            log('adventure left before the last quest was seen claimed');
            st().go(S.RunStep.Close, 'adventure gone');
            return;
        }
        if (S.core.zone.id() !== r.zoneId) {
            ld().hold(r, 'view the adventure island to claim the last quest, then Resume');
            return;
        }
        var list = S.core.quests.list();
        if (list === null) {
            ld().waitRead(r, 'quest list');
            return;
        }
        var last = lastQuestOf(list);
        // A claim already sent is settled before the quest's own state is
        // read: the send itself can make the quest read not finished or take
        // it off the list.
        var s = ld().staleMark(r, 'lastQuest', 'last quest claim');
        if (s === 'wait') {
            if (!last && ld().missingLong(r, 'lastQuest')) {
                log('last quest left the list after the claim');
                ld().markSeen(r, 'lastQuest');
                st().go(S.RunStep.Close, 'last quest claimed');
            }
            return;
        }
        if (s === 'stale') {
            st().pause(S.RunPause.NotObserved, 'last quest claim sent but not seen; check the quest book, then Resume');
            return;
        }
        if (!last) {
            ld().hold(r, 'last quest not readable or not listed; if it was claimed by hand, close the ' +
                'adventure by hand, then Resume');
            return;
        }
        ld().clearHold(r);
        var next = ld().settleRound(r, S.RunStep.LastQuest, function (f) {
            st().pause(S.RunPause.QuestFailed, 'claim last quest failed: ' + f.reason);
        }, 'last quest claim');
        if (next !== 'new') return;
        if (!last.finished) {
            st().pause(S.RunPause.QuestFailed, 'last quest not finished');
            return;
        }
        var round = ld().startRound(r, S.RunStep.LastQuest, []);
        ld().attempt(round, 'lastQuest',
            ld().wrapSend(r, 'lastQuest', S.core.quests.claim(last.key, { allowLast: true })),
            ld().seenOnVerified('lastQuest'));
    }

    // Verifies the adventure left the own list. The client may remove it
    // itself after the last quest, so a close is sent only after a settle
    // window, only after a verified claim, and only when the adventure's name
    // still points at the run's zone (a second open copy would be closed
    // otherwise).
    function close(r) {
        if (typeof r.zoneId !== 'number') {
            st().pause(S.RunPause.NotObserved, 'the run has no adventure zone; Stop the run');
            return;
        }
        var own = S.core.adventures.own();
        if (own === null) {
            ld().waitRead(r, 'own adventures');
            return;
        }
        if (goneFrom(own, r.zoneId)) {
            var q = st().current().request;
            if (q) q.closedAt = now();
            st().save();
            log('adventure closed');
            st().go(S.RunStep.Recall, 'adventure closed');
            return;
        }
        var rec = ld().marked(r, 'lastQuest');
        if (!rec || !rec.seen) {
            st().pause(S.RunPause.CloseFailed, 'last quest not confirmed claimed; claim it by hand and close the ' +
                'adventure, then Resume');
            return;
        }
        if (now() - r.since < ld().MARK_SETTLE_MS) return;
        var s = ld().staleMark(r, 'close', 'close');
        if (s === 'wait') return;
        if (s === 'stale') {
            st().pause(S.RunPause.NotObserved, 'close sent but the adventure is still listed; check the star menu, ' +
                'then Resume');
            return;
        }
        var next = ld().settleRound(r, S.RunStep.Close, function (f) {
            st().pause(S.RunPause.CloseFailed, 'close failed: ' + f.reason);
        }, 'close');
        if (next !== 'new') return;
        if (S.core.adventures.zoneIdOf(r.adventure) !== r.zoneId) {
            st().pause(S.RunPause.CloseFailed, 'another ' + r.adventure + ' is open; close it by hand, then Resume');
            return;
        }
        var round = ld().startRound(r, S.RunStep.Close, []);
        ld().attempt(round, 'close', ld().wrapSend(r, 'close', S.core.adventures.close(r.adventure)));
    }

    // Sends home every loadout general still on the island, each as he gets
    // ready, with no limit on a busy one. Once the island is no longer viewed
    // (closing it may move the view) the generals are taken to return on their
    // own, which is assumed, not proven. A zone id that cannot be read says
    // nothing about the view, so it holds. A general the list lacks is gone at
    // once when his return went out. With no mark he may only be a skipped
    // entry, so he gets the grace, and after it he counts as gone with no pause.
    // A general recovering after a lost battle takes no order, so he is not
    // sent or waited on; he returns home with the map.
    function recall(r, inv) {
        var id = S.core.zone.id();
        if (typeof id !== 'number') {
            ld().waitRead(r, 'zone id');
            return;
        }
        if (id !== r.zoneId) {
            log('adventure no longer viewed; generals return on their own');
            st().go(S.RunStep.JumpHome, 'island left');
            return;
        }
        var homeId = S.core.zone.homeId();
        if (typeof homeId !== 'number') {
            ld().waitRead(r, 'home zone id');
            return;
        }
        var keys = ld().keysOf(r);
        var need = [];
        var open = [];
        var busy = null;
        var absent = null;
        var resting = 0;
        for (var i = 0; i < keys.length; i++) {
            var name = 'recall:' + keys[i];
            var g = ld().gen(inv, keys[i]);
            var rec = ld().marked(r, name);
            if (!g) {
                if (rec && (rec.seen || rec.sentOnce)) continue;
                // Runs for every such key on every pass, or its grace stops.
                if (!ld().missingLong(r, keys[i]) && absent === null) absent = keys[i];
                continue;
            }
            if (rec && rec.seen) continue;
            // A recall that went out and shows as travel is seen, even when
            // its round's result was lost.
            if (rec && rec.sentOnce && ld().leaving(g, keys[i])) {
                ld().markSeen(r, name);
                continue;
            }
            if (!ld().ready(g) && ld().recovering(keys[i])) {
                resting++;
                continue;
            }
            open.push(name);
            if (ld().ready(g)) need.push(keys[i]);
            else if (busy === null) busy = keys[i];
        }
        if (busy !== null) ld().waitBusy(r, busy, ld().who(inv, busy) + ' busy on the adventure');
        else if (absent !== null) ld().waitBusy(r, absent, ld().who(inv, absent) + ' not listed');
        if (!need.length) {
            if (busy === null && absent === null) {
                st().go(S.RunStep.JumpHome, 'generals sent home' +
                    (resting > 0 ? ', ' + resting + ' recovering return with the map' : ''));
            }
            return;
        }
        for (i = 0; i < need.length; i++) {
            var s = ld().staleMark(r, 'recall:' + need[i], 'return of ' + ld().who(inv, need[i]));
            if (s === 'wait') return;
            if (s === 'stale') {
                st().pause(S.RunPause.NotObserved, 'return of ' + ld().who(inv, need[i]) + ' sent but not seen; check the ' +
                    'general, then Resume', { general: need[i] });
                return;
            }
        }
        ld().dropShown(r, S.RunStep.Recall, open);
        var next = ld().settleRound(r, S.RunStep.Recall, function (f) {
            var k = keyOfMark(f.key);
            st().pause(S.RunPause.DepartFailed, 'send ' + k + ' home failed: ' + f.reason, { general: k });
        }, 'return home');
        if (next !== 'new') return;
        var round = ld().startRound(r, S.RunStep.Recall, []);
        for (i = 0; i < need.length; i++) {
            name = 'recall:' + need[i];
            ld().attempt(round, name, ld().wrapSend(r, name, S.core.specialists.orders.sendToZone(need[i], homeId)),
                ld().seenOnVerified(name));
        }
    }

    // ---- Dispatch -----------------------------------------------------------

    // [step, fn, needs the inventory]. Built at call time: state.js fills
    // S.RunStep and loads after this file in name order. Steps that only
    // read the zone or the quests skip the inventory read, which would warn
    // on every pass while a zone loads.
    function stepRow(step) {
        var R = S.RunStep;
        var rows = [
            [R.Jump,      jumpStep,  false],
            [R.Arrive,    arrive,    true],
            [R.Pickups,   pickups,   false],
            [R.StarAll,   starAll,   true],
            [R.Horseshoe, horseshoe, false],
            [R.Clear,     clear,     true],
            [R.PackStar,  packStar,  true],
            [R.Pack,      pack,      true],
            [R.LastQuest, lastQuest, false],
            [R.Close,     close,     false],
            [R.Recall,    recall,    true],
            [R.JumpHome,  jumpHome,  false]
        ];
        for (var i = 0; i < rows.length; i++) {
            if (rows[i][0] === step) return rows[i];
        }
        return null;
    }

    // One away step of the running run. Holds (no send, no pause) while the
    // specialist list lost entries, because the steps read a general absent
    // from the list as a fact. A throw leaves the step as it is for the next
    // call.
    function plan() {
        var r = st().run();
        if (!r || r.status !== S.RunStatus.Running) return;
        if (st().partOf(r.step) !== 'away') return;
        var step = r.step;
        try {
            var row = stepRow(step);
            if (!row) return;
            var inv = row[2] ? S.core.army.inventory() : null;
            if (inv && ld().listHold(r, inv)) return;
            row[1](r, inv);
        } catch (e) {
            S.kernel.error(CATEGORY, st().label() + ': step ' + st().stepName(step) + ' threw:', e);
        }
    }

    S.modules.adventures.away = {
        JUMP_MS:             JUMP_MS,
        JUMP_RETRY_MS:       JUMP_RETRY_MS,
        CLEAR_MAX_MS:        CLEAR_MAX_MS,
        PLACE_QUIET_MS:      PLACE_QUIET_MS,
        PICKUPS_MAX_MS:      PICKUPS_MAX_MS,
        CLEAR_PICKUP_MAX_MS: CLEAR_PICKUP_MAX_MS,
        toHome:              toHome,
        toIsland:            toIsland,
        homeLoaded:          homeLoaded,
        islandLoaded:        islandLoaded,
        plan:                plan
    };

}(Steward));
