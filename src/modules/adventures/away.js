/*
 * Away steps of an adventure run: from leaving home to coming back.
 *
 * Jump -> Arrive -> StarAll -> Horseshoe hand the run to the wave executor
 * at Gate of wave 1; after the last wave the executor hands it back at
 * PackStar -> Pack -> Clear -> LastQuest -> Close -> Recall -> JumpHome,
 * and the home steps take over at ArriveHome. A holder of free troops is
 * placed on a map grid before its raise, because the client has no
 * garrison for a general at the star; Clear goes back to PackStar while
 * free troops are left to pack. plan() does one step per
 * call. The scheduler only calls it while no adventures queue entry is
 * pending, so every step observes the game first and never relies on a
 * callback having fired.
 *
 * Every acting step checks, in this order: the observed exit (the effect
 * is in the game, so the step moves on); a sent but unseen marker (wait
 * for its effect, then pause, never send it again on its own); the last
 * action round (a failure pauses, a second round without the effect
 * pauses); and only then a new round. Each order that must not go out
 * twice (claiming the last quest, closing the adventure, each recall, the
 * horseshoe) goes through a persisted marker written before the packet.
 *
 * A zone change has no event, so a jump polls for the zone to load,
 * visits once more after JUMP_MS and pauses after a second window.
 *
 * The last quest is the reward of the map, so the run never treats it as
 * claimed without proof: a verified claim, or the adventure gone from the
 * own list. The adventure is closed only after a verified claim, and only
 * when its name still points at the run's zone.
 *
 * Bundle slot: module file; top level only assigns
 * S.modules.adventures.away; state, loader and every core are read at call
 * time.
 */

(function (S) {

    if (!S.modules.adventures) S.modules.adventures = {};

    // Starting values, to be tuned in game.
    var JUMP_MS      = 60000;      // a visited zone that has not loaded is visited once more
    var CLEAR_MAX_MS = 1800000;    // the last quest and the generals get this long after the last wave
    var PLACE_MAX_MS = 300000;     // a holder walking from the star to its grid gets this long

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

    function ready(g) {
        return !!g && g.idle && !g.travelling;
    }

    // The key part of a marker name like 'recall:<key>'.
    function keyOfMark(name) {
        var i = name.indexOf(':');
        return i >= 0 ? name.slice(i + 1) : name;
    }

    // A hold on the step's own deadline (r.waitUntil), set on the first pass.
    function hold(r, text) {
        if (typeof r.waitUntil !== 'number') {
            r.waitUntil = now() + ld().READ_MAX_MS;
            st().save();
            return;
        }
        if (now() > r.waitUntil) st().pause(S.RunPause.NotObserved, text);
    }

    function clearHold(r) {
        if (r.waitUntil === null || r.waitUntil === undefined) return;
        r.waitUntil = null;
        st().save();
    }

    // Whether the own adventure list (read, not null) no longer holds the
    // run's zone.
    function goneFrom(own, zoneId) {
        for (var i = 0; i < own.length; i++) {
            if (own[i] && own[i].zoneId === zoneId) return false;
        }
        return true;
    }

    function lastQuestOf(list) {
        for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].last) return list[i];
        }
        return null;
    }

    // ---- Jumps --------------------------------------------------------------

    // Visits targetId until loaded() holds. The marker's sentAt is the time
    // of the last visit; sentOnce means "visited again" and is written only
    // by the retry, so a resumed jump (sentAt cleared, sentOnce kept) pauses
    // after one window instead of two.
    function jump(r, targetId, loaded, name, next, why) {
        if (loaded()) {
            ld().markSeen(r, name);
            st().go(next, why);
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
            if (!S.core.zone.visit(targetId)) st().pause(S.RunPause.JumpFailed, 'cannot visit zone ' + targetId);
            return;
        }
        if (now() - rec.sentAt <= JUMP_MS) return;
        if (rec.sentOnce) {
            st().pause(S.RunPause.JumpFailed, 'zone ' + targetId + ' did not load');
            return;
        }
        rec.sentOnce = true;
        rec.sentAt = now();
        st().save();
        log('zone ' + targetId + ' not loaded after ' + Math.round(JUMP_MS / 1000) + ' s, visiting again');
        if (!S.core.zone.visit(targetId)) st().pause(S.RunPause.JumpFailed, 'cannot visit zone ' + targetId);
    }

    function jumpStep(r) {
        jump(r, r.zoneId, function () {
            return typeof r.zoneId === 'number' && S.core.zone.id() === r.zoneId &&
                S.core.zone.isAdventure() && S.core.specialists.listReadable();
        }, 'visit', S.RunStep.Arrive, 'adventure loaded');
    }

    function jumpHome(r) {
        var homeId = S.core.zone.homeId();
        jump(r, homeId, function () {
            return typeof homeId === 'number' && S.core.zone.isHome() && S.core.zone.id() === homeId &&
                S.core.specialists.listReadable();
        }, 'visitHome', S.RunStep.ArriveHome, 'home loaded');
    }

    // ---- Arrival ------------------------------------------------------------

    // Waits per general, not by count: every loadout key must be listed here
    // and idle. The deadline is the one Depart stored in the 'arrive' marker
    // (a deadline, never a send time); without it, since + TRAVEL_CAP_MS.
    function arrive(r, inv) {
        var keys = ld().keysOf(r);
        var missing = null;
        var busy = null;
        for (var i = 0; i < keys.length; i++) {
            var g = ld().gen(inv, keys[i]);
            if (!g) { if (missing === null) missing = keys[i]; }
            else if (!ready(g)) { if (busy === null) busy = keys[i]; }
        }
        if (missing === null && busy === null && inv.ok) {
            st().go(S.RunStep.StarAll, 'every general arrived');
            return;
        }
        var rec = ld().marked(r, 'arrive');
        var deadline = rec && typeof rec.sentAt === 'number' ? rec.sentAt : r.since + ld().TRAVEL_CAP_MS;
        if (now() <= deadline) return;
        if (missing !== null) {
            st().pause(S.RunPause.GeneralMissing, ld().who(inv, missing) + ' did not arrive', { general: missing });
        } else if (busy !== null) {
            st().pause(S.RunPause.GeneralBusy, ld().who(inv, busy) + ' is still busy after arriving', { general: busy });
        } else {
            st().pause(S.RunPause.NotObserved, 'generals arrived but their armies are not readable');
        }
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

    // Optional: a missing horseshoe or a refused one only warns. It is sent
    // at most once per run; a marker that went out (sentOnce survives a
    // Resume) or was seen moves on without a second send.
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
            warn('no horseshoe in stock (or None chosen)');
            st().go(S.WaveStep.Gate, gate);
            return;
        }
        // A round lost before its send leaves no marker and is started again.
        ld().dropOrphan(r);
        round = ld().startRound(r, S.RunStep.Horseshoe, []);
        ld().attempt(round, 'speed', ld().wrapSend(r, 'speed', S.core.buffs.speed(name)));
    }

    // ---- End of map ---------------------------------------------------------

    // Grids of the attack and buff targets over every wave, deduped, with a
    // label. A file that no longer loads adds nothing; the list only names
    // camps in a warning.
    function campsOf(r) {
        var out = [];
        var seenGrid = {};
        var L = S.BattleLine;
        for (var i = 0; i < r.paths.length; i++) {
            var f = S.core.battles.load(r.paths[i]);
            if (!f || !f.ok) continue;
            for (var j = 0; j < f.lines.length; j++) {
                var l = f.lines[j];
                if (l.kind !== L.Attack && l.kind !== L.Buff) continue;
                if (typeof l.target !== 'number' || has(seenGrid, String(l.target))) continue;
                seenGrid[String(l.target)] = true;
                out.push({ grid: l.target, text: l.targetName ? l.targetName + ' (' + l.target + ')' : String(l.target) });
            }
        }
        return out;
    }

    function standingText(r) {
        S.core.buildings.invalidate();
        var camps = campsOf(r);
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

    // A raise needs the general's garrison, which only a general on a map
    // grid has.
    function onMap(g) {
        return !!g && typeof g.grid === 'number' && g.grid > 0;
    }

    // The first loadout key whose general is walking to a grid, or null. A
    // key that cannot be looked up does not count as walking.
    function movingKey(r) {
        var keys = ld().keysOf(r);
        for (var i = 0; i < keys.length; i++) {
            var spec = S.core.specialists.lookup(keys[i]).spec;
            if (spec && S.core.specialists.orders.taskKind(spec) === S.GeneralTask.Move) return keys[i];
        }
        return null;
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
            else if (g.cls === S.SpecialistType.General && ready(g)) generals.push(h);
        }
        return S.core.army.planPack(inv.free, carriers.concat(generals));
    }

    // Keys of the planned raises whose holder is not on a map grid, in plan
    // order. PackStar's exit and Pack's way back both test this, so the two
    // steps never disagree on the same inventory.
    function offMap(p, inv) {
        var out = [];
        for (var i = 0; i < p.raises.length; i++) {
            if (!onMap(ld().gen(inv, p.raises[i].key))) out.push(p.raises[i].key);
        }
        return out;
    }

    // Candidate grids for a holder: the island's landing fields, where the
    // client places generals, then the grids the run's battle files stand
    // generals on, last wave first, deduped.
    function placeGrids(r) {
        var out = [];
        var seen = {};
        function add(grid) {
            if (has(seen, String(grid))) return;
            seen[String(grid)] = true;
            out.push(grid);
        }
        var landing = S.core.zone.landingGrids();
        for (var i = 0; i < landing.length; i++) add(landing[i]);
        for (i = r.paths.length - 1; i >= 0; i--) {
            var f = S.core.battles.load(r.paths[i]);
            if (!f || !f.ok) continue;
            for (var j = 0; j < f.lines.length; j++) {
                var l = f.lines[j];
                if (typeof l.grid === 'number' && l.grid > 0) add(l.grid);
            }
        }
        return out;
    }

    // A free placeable grid for each key: never one an own fighter stands on
    // or one already chosen. The client's own placeable test decides, and
    // the move's precheck runs it again before the packet. Returns { moves,
    // missing, blocked, tried }; missing or blocked names the first key
    // without a spec or without a grid, and then no move may go out.
    function chooseGrids(r, inv, keys) {
        var cands = placeGrids(r);
        var taken = {};
        for (var k in inv.byKey) {
            if (!has(inv.byKey, k) || !inv.byKey[k]) continue;
            var at = inv.byKey[k].grid;
            if (typeof at === 'number' && at > 0) taken[String(at)] = true;
        }
        var out = { moves: [], missing: null, blocked: null, tried: cands.length };
        for (var i = 0; i < keys.length; i++) {
            var spec = S.core.specialists.lookup(keys[i]).spec;
            if (!spec) {
                out.missing = keys[i];
                return out;
            }
            var chosen = null;
            for (var j = 0; j < cands.length; j++) {
                if (has(taken, String(cands[j]))) continue;
                if (S.core.specialists.orders.isPlaceable(spec, cands[j])) {
                    chosen = cands[j];
                    break;
                }
            }
            if (chosen === null) {
                out.blocked = keys[i];
                return out;
            }
            taken[String(chosen)] = true;
            out.moves.push({ key: keys[i], grid: chosen });
        }
        return out;
    }

    // The map is clear when its last quest is finished and no loadout general
    // is still fighting. A camp still standing only warns: it may belong to
    // a side quest or have been beaten in a way the map does not show.
    function clear(r, inv) {
        var list = S.core.quests.list();
        var last = list ? lastQuestOf(list) : null;
        var questDone = !!(last && last.finished);
        var keys = ld().keysOf(r);
        var idle = true;
        for (var i = 0; i < keys.length; i++) {
            var g = ld().gen(inv, keys[i]);
            if (g && !ready(g)) { idle = false; break; }
        }
        if (questDone && idle && !ld().anyAttacking()) {
            // r.since is old here, so waitRead would pause at once; the hold
            // gives the read its own window from the first unreadable pass.
            if (!inv.ok) {
                hold(r, 'free troops and armies not readable at the end of the map');
                return;
            }
            clearHold(r);
            // Troops freed by the last battles, or generals that were still
            // fighting during the first pack, are packed before the claim.
            if (packPlan(r, inv).raises.length) {
                st().go(S.RunStep.PackStar, 'free troops left to pack');
                return;
            }
            var standing = standingText(r);
            if (standing) warn('camps still standing after the last quest: ' + standing);
            st().go(S.RunStep.LastQuest, 'last quest finished');
            return;
        }
        if (now() - r.since <= CLEAR_MAX_MS) return;
        var min = Math.round(CLEAR_MAX_MS / 60000);
        var camps = standingText(r) || 'none';
        st().pause(S.RunPause.ClearTimeout, (questDone ? 'generals still busy ' + min + ' min after the last wave'
            : 'last quest not finished after ' + min + ' min') + '; camps standing: ' + camps);
    }

    // Places the planned holders that wait at the star on map grids: a raise
    // needs a garrison, which a general has only on the map. A holder already
    // walking is waited on first, because it may show its new grid while not
    // yet idle, and so a restart or a kernel Pause never orders it twice.
    function packStar(r, inv) {
        if (!inv.ok) {
            ld().waitRead(r, 'free troops and armies');
            return;
        }
        var walking = movingKey(r);
        if (walking !== null) {
            if (now() - r.since > PLACE_MAX_MS) {
                st().pause(S.RunPause.GeneralBusy, ld().who(inv, walking) + ' did not reach its grid after ' +
                    Math.round(PLACE_MAX_MS / 60000) + ' min', { general: walking });
            }
            return;
        }
        var need = offMap(packPlan(r, inv), inv);
        if (!need.length) {
            st().go(S.RunStep.Pack, 'holders on the map');
            return;
        }
        var next = ld().settleRound(r, S.RunStep.PackStar, function (f) {
            st().pause(S.RunPause.PackFailed, 'place ' + f.key + ' failed: ' + f.reason, { general: f.key });
        }, 'place');
        if (next !== 'new') return;
        var c = chooseGrids(r, inv, need);
        if (c.missing !== null) {
            st().pause(S.RunPause.GeneralMissing, ld().who(inv, c.missing) + ' is not on the island',
                { general: c.missing });
            return;
        }
        if (c.blocked !== null) {
            st().pause(S.RunPause.NotPlaceable, ld().who(inv, c.blocked) + ' has no placeable grid (' +
                c.tried + ' tried)', { general: c.blocked });
            return;
        }
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
    // ever sent to a general at the star.
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
            var n = 0;
            for (var k in round.expected) { if (has(round.expected, k)) n++; }
            st().go(S.RunStep.Pack, 'packed ' + n + ' holder(s)');
            return;
        }
        var away = offMap(p, inv);
        if (away.length) {
            st().go(S.RunStep.PackStar, ld().who(inv, away[0]) + ' is not on the map');
            return;
        }
        var next = ld().settleRound(r, S.RunStep.Pack, function (f) {
            st().pause(S.RunPause.PackFailed, 'pack ' + f.key + ' refused: ' + f.reason, { general: f.key });
        }, 'pack');
        if (next !== 'new') return;
        round = ld().startRound(r, S.RunStep.Pack, []);
        for (var i = 0; i < p.raises.length; i++) {
            ld().attempt(round, p.raises[i].key, S.core.army.raise(p.raises[i].key, p.raises[i].target));
        }
    }

    // Claims the last quest (the map's reward). Moves on only on proof: a
    // verified claim, or the adventure gone from a readable own list. Off the
    // island or with the quest unreadable it holds, then pauses.
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
            hold(r, 'view the adventure island to claim the last quest, then Resume');
            return;
        }
        var list = S.core.quests.list();
        var last = list ? lastQuestOf(list) : null;
        if (!last) {
            hold(r, 'last quest not readable or not listed; if it was claimed by hand, close the ' +
                'adventure by hand, then Resume');
            return;
        }
        clearHold(r);
        // A claim already sent is settled before the quest's own state is
        // read: the send itself can make the quest read not finished.
        var s = ld().staleMark(r, 'lastQuest', ld().MARK_SETTLE_MS);
        if (s === 'wait') return;
        if (s === 'stale') {
            st().pause(S.RunPause.NotObserved, 'last quest claim sent but not seen; check the quest book, then Resume');
            return;
        }
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
        var s = ld().staleMark(r, 'close', ld().MARK_SETTLE_MS);
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

    // Sends home every loadout general still on the island. Once the island
    // is no longer viewed (closing it may move the view) the generals return
    // on their own.
    function recall(r, inv) {
        if (S.core.zone.id() !== r.zoneId || !S.core.specialists.listReadable()) {
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
        var busy = null;
        for (var i = 0; i < keys.length; i++) {
            var name = 'recall:' + keys[i];
            var g = ld().gen(inv, keys[i]);
            if (!g) continue;
            var rec = ld().marked(r, name);
            if (rec && rec.seen) continue;
            // A recall that went out and shows as travel is seen, even when
            // its round's result was lost.
            if (rec && rec.sentOnce && ld().leaving(g, keys[i])) {
                ld().markSeen(r, name);
                continue;
            }
            if (ready(g)) need.push(keys[i]);
            else if (busy === null) busy = keys[i];
        }
        if (!need.length) {
            if (busy === null) {
                st().go(S.RunStep.JumpHome, 'generals sent home');
                return;
            }
            if (now() - r.since > ld().TRAVEL_CAP_MS) {
                st().pause(S.RunPause.GeneralBusy, ld().who(inv, busy) + ' is still busy on the adventure', { general: busy });
            }
            return;
        }
        for (i = 0; i < need.length; i++) {
            var s = ld().staleMark(r, 'recall:' + need[i], ld().MARK_SETTLE_MS);
            if (s === 'wait') return;
            if (s === 'stale') {
                st().pause(S.RunPause.NotObserved, 'return of ' + ld().who(inv, need[i]) + ' sent but not seen; check the ' +
                    'general, then Resume', { general: need[i] });
                return;
            }
        }
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

    // One away step of the running run. A throw leaves the step as it is for
    // the next call.
    function plan() {
        var r = st().run();
        if (!r || r.status !== S.RunStatus.Running) return;
        if (st().partOf(r.step) !== 'away') return;
        var step = r.step;
        try {
            var row = stepRow(step);
            if (!row) return;
            row[1](r, row[2] ? S.core.army.inventory() : null);
        } catch (e) {
            S.kernel.error(CATEGORY, st().label() + ': step ' + st().stepName(step) + ' threw:', e);
        }
    }

    S.modules.adventures.away = {
        JUMP_MS:      JUMP_MS,
        CLEAR_MAX_MS: CLEAR_MAX_MS,
        PLACE_MAX_MS: PLACE_MAX_MS,
        plan:         plan
    };

}(Steward));
