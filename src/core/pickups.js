/*
 * Pickups: what can be clicked on the viewed zone, and the click itself.
 *
 * targets() lists two kinds of map object. Quest objects are the map objects
 * an open quest still waits to have clicked (S.core.quests.clickNames()),
 * read only on an adventure zone. Collectibles are the objects the host flags
 * as collectible whose name matches one of the given patterns. Which kinds to
 * ask for, which patterns to use and when to click stay with the caller; this
 * file decides nothing.
 *
 * targets() returns null when the zone id, the building list or the quest
 * pool cannot be read, and [] for a readable zone with nothing to click: a
 * caller that waits for pickups must never mistake an unreadable map for an
 * empty one. It does not invalidate the building cache; the caller decides
 * when to.
 *
 * click(target) builds the def for S.core.actions.attempt. It is verified by
 * a positive observation on the same zone with a readable building list:
 * either the object left its grid, or its mIsSelectable flag went from true
 * to false. A zone change, an unreadable list or an object that still reads
 * the same never verifies. There is no satisfied(): an absent target is a
 * refusal, not an earlier success.
 *
 * Bundle slot: core, after packets.js and before production.js (core files
 * load in name order). Everything here runs at call time; the top level only
 * assigns S.core.pickups.
 */

(function (S) {

    // Verify window per click, in polls of the kernel's queue action gap (the
    // gap the actions runner measures in).
    var CLICK_POLLS = 4;

    // One more click is harmless: selecting an object that is still
    // selectable only selects it again.
    var CLICK_RETRIES = 1;

    function hasOwn(obj, key) {
        return Object.prototype.hasOwnProperty.call(obj, key);
    }

    // The window is CLICK_POLLS runner polls, read at call time. The floor of
    // 1 ms matches the actions runner's pollGap(), so the window is exactly
    // CLICK_POLLS polls whatever the gap is.
    function clickTimeoutMs() {
        var ms = S.kernel.TIMEOUTS && S.kernel.TIMEOUTS.QUEUE_ACTION_GAP_MS;
        return CLICK_POLLS * ((typeof ms === 'number' && ms > 0) ? ms : 1);
    }

    // A copy of base plus, for every active event, its code and its resource
    // name. Easter's collectible is named after its resource
    // ('BuildingStripedEggs'), not its code, so both are added; the host's
    // collectible flag narrows the result to real collectibles either way.
    function patterns(base) {
        var pats = (base && base.length) ? base.slice() : [];
        try {
            if (S.core.events && typeof S.core.events.active === 'function') {
                var ev = S.core.events.active();
                for (var i = 0; i < ev.length; i++) {
                    if (ev[i].code && pats.indexOf(ev[i].code) === -1) pats.push(ev[i].code);
                    if (typeof S.core.events.eventResource === 'function') {
                        var res = S.core.events.eventResource(ev[i].code);
                        if (res && pats.indexOf(res) === -1) pats.push(res);
                    }
                }
            }
        } catch (e) { /* fall through with the base list */ }
        return pats;
    }

    // True when the name contains one of the non-empty pattern strings.
    function matches(name, pats) {
        if (!name || !pats || !pats.length) return false;
        for (var i = 0; i < pats.length; i++) {
            if (typeof pats[i] !== 'string' || !pats[i].length) continue;
            if (name.indexOf(pats[i]) > -1) return true;
        }
        return false;
    }

    // A quest object is a neutral map object the player can still click:
    // not an enemy camp, not an own building or fence (playerId 0), with no
    // army on it. The helpers are read through S.core.buildings at call time
    // so a patched helper applies.
    function isQuestObject(b) {
        var bld = S.core.buildings;
        return bld.isSelectable(b) && bld.isAttackable(b) &&
            !bld.isEnemy(b) && !bld.isMine(b) && !bld.hasArmy(b);
    }

    // [{ grid, name, kind: 'quest'|'collectible', zoneId }] in building-list
    // order, or null when the map cannot be read. opts.patterns is an
    // already expanded pattern list (missing or empty: no collectibles);
    // opts.quests true includes quest objects on an adventure zone.
    function targets(opts) {
        opts = opts || {};
        var bld = S.core.buildings;
        var zoneId = S.core.zone.id();
        if (typeof zoneId !== 'number') return null;
        if (!bld.readable()) return null;
        var names = null;
        if (opts.quests === true && S.core.zone.isAdventure()) {
            names = S.core.quests.clickNames();
            if (names === null) return null;
        }
        var pats = (opts.patterns && opts.patterns.length) ? opts.patterns : null;
        var src = bld.list();
        var out = [];
        for (var i = 0; i < src.length; i++) {
            var b = src[i];
            var n = bld.name(b);
            if (!n) continue;
            var g = bld.grid(b);
            if (g === null || g === undefined) continue;
            var kind = null;
            if (names && hasOwn(names, n) && isQuestObject(b)) kind = 'quest';
            else if (pats && bld.isCollectible(b) && matches(n, pats)) kind = 'collectible';
            if (kind) out.push({ grid: g, name: n, kind: kind, zoneId: zoneId });
        }
        return out;
    }

    // Def that clicks one target from targets(). Verified when, on the same
    // zone with a readable building list, the object left its grid (or the
    // grid holds another name) or its selectable flag went from true to
    // false. A collectible that was never selectable can only verify by
    // leaving its grid.
    function click(target) {
        var grid = target.grid;
        var name = target.name;

        return {
            label:     'pick up ' + name + ' at ' + grid,
            category:  'pickups',
            timeoutMs: clickTimeoutMs(),
            retries:   CLICK_RETRIES,

            precheck: function () {
                var bld = S.core.buildings;
                if (S.core.zone.id() !== target.zoneId) return 'zone changed';
                var b = bld.byGrid(grid);
                if (!b) return 'gone';
                if (bld.name(b) !== name) return 'other building';
                if (target.kind === 'quest' && !bld.isSelectable(b)) return 'not selectable';
                return null;
            },

            baseline: function () {
                var bld = S.core.buildings;
                return { zoneId: target.zoneId, selectable: bld.isSelectable(bld.byGrid(grid)) };
            },

            send: function () {
                var bld = S.core.buildings;
                var b = bld.byGrid(grid);
                if (!b) return false;
                if (typeof game === 'undefined' || !game || !game.gi ||
                    typeof game.gi.SelectBuilding !== 'function') return false;
                game.gi.SelectBuilding(b);
                // Refreshes the client's own panels, as a manual pick-up does.
                if (typeof globalFlash !== 'undefined' && globalFlash && globalFlash.gui &&
                    typeof globalFlash.gui.UpdateGuiOnZoneLoad === 'function') {
                    globalFlash.gui.UpdateGuiOnZoneLoad();
                }
                bld.invalidate();
                return true;
            },

            check: function (base) {
                if (!base) return false;
                var bld = S.core.buildings;
                bld.invalidate();
                if (S.core.zone.id() !== base.zoneId) return false;
                if (!bld.readable()) return false;
                var b = bld.byGrid(grid);
                if (!b || bld.name(b) !== name) return true;
                return base.selectable === true && !bld.isSelectable(b);
            }
        };
    }

    S.core.pickups = {
        patterns: patterns,
        matches:  matches,
        targets:  targets,
        click:    click
    };

}(Steward));
