/*
 * Active events and their per-task modifiers.
 *
 * Live event detection mirrors autoTSO (user_auto.js:4416-4425):
 *   - game.gi.mEventManager.GetActiveEventNames() returns strings like
 *     'XMASContent2025', 'Valentine_Shop', 'HWContent_2024'.
 *   - Match against base event codes (XMAS, Valentine, Easter, Soccer,
 *     Anniversary, HW) by substring. One base event may have multiple
 *     sub-events live at once (e.g. _Content + _Shop).
 *
 * core/specialists.pickTask consults active() and treasureValues() so
 * modules don't need event-awareness themselves.
 */

(function (S) {

    function table() {
        return (S.core.events.data && S.core.events.data.events) || {};
    }

    function liveEventNames() {
        try {
            if (typeof game !== 'undefined' && game && game.gi && game.gi.mEventManager &&
                typeof game.gi.mEventManager.GetActiveEventNames === 'function') {
                var names = game.gi.mEventManager.GetActiveEventNames();
                if (!names) return [];
                // The host returns a Flash vector; iterate defensively.
                var out = [];
                var len = (typeof names.length === 'number') ? names.length : 0;
                for (var i = 0; i < len; i++) {
                    if (typeof names[i] === 'string') out.push(names[i]);
                }
                return out;
            }
        } catch (e) {
            S.kernel.warn('events', 'GetActiveEventNames threw:', e);
        }
        return [];
    }

    function eventEndTime(rawName) {
        try {
            if (typeof game !== 'undefined' && game && game.gi && game.gi.mEventManager &&
                typeof game.gi.mEventManager.GetEventStopDate === 'function') {
                return game.gi.mEventManager.GetEventStopDate(rawName);
            }
        } catch (e) { /* fall through */ }
        return null;
    }

    // Match a live event name against our base codes via substring (mirrors
    // autoTSO at user_auto.js:4421). Returns the base code or null.
    function matchBaseCode(rawEventName) {
        if (!rawEventName) return null;
        var t = table();
        var keys = Object.keys(t);
        for (var i = 0; i < keys.length; i++) {
            if (rawEventName.indexOf(keys[i]) !== -1) return keys[i];
        }
        return null;
    }

    // Return active events as { code, name, category, rawNames[], endTime,
    // endTimes }. Multiple raw events may collapse to one base code; their
    // suffixes (_Content, _Shop, …) become category tags so callers can
    // filter. endTimes holds the latest stop date per category
    // ({ treasure, shop, other }) because the item-drop phase (_Content)
    // ends before the shop phase (_Shop); endTime is the latest of all.
    function active() {
        var live = liveEventNames();
        if (!live.length) return [];
        var byCode = {};
        for (var i = 0; i < live.length; i++) {
            var raw = live[i];
            var code = matchBaseCode(raw);
            if (!code) continue;
            if (!byCode[code]) {
                byCode[code] = {
                    code:       code,
                    name:       (table()[code] && table()[code].name) || code,
                    rawNames:   [],
                    categories: {},
                    endTime:    null,
                    endTimes:   { treasure: null, shop: null, other: null }
                };
            }
            byCode[code].rawNames.push(raw);
            // Category guess from suffix. Mirror autoTSO (user_auto.js:4435
            // — getActiveEvent('_Content') / getActiveEvent('_Shop')) and
            // require the underscore-prefixed suffix. The bare 'Content'
            // substring matches wrapper event names that persist into the
            // event's cooldown / shop-only phase, which made pickTask think
            // treasure was still dropping after items had stopped.
            var catKey = raw.indexOf('_Shop') !== -1    ? 'shop'
                       : raw.indexOf('_Content') !== -1 ? 'treasure'
                       : 'other';
            byCode[code].categories[catKey] = true;
            // Track the latest end time across sub-events, overall and per category.
            var et = eventEndTime(raw);
            if (typeof et === 'number' && et > 0) {
                var cur = byCode[code];
                if (!cur.endTime || et > cur.endTime) cur.endTime = et;
                if (!cur.endTimes[catKey] || et > cur.endTimes[catKey]) cur.endTimes[catKey] = et;
            }
        }
        // Flatten categories object → list of strings, plus a flat
        // 'category' field that's the first ('treasure' wins over 'shop'
        // wins over 'other') so simple consumers can keep using it.
        var out = [];
        var codes = Object.keys(byCode);
        for (var k = 0; k < codes.length; k++) {
            var ev = byCode[codes[k]];
            ev.categoryList = Object.keys(ev.categories);
            ev.category = ev.categories.treasure ? 'treasure'
                        : ev.categories.shop     ? 'shop'
                        : (ev.categoryList[0] || null);
            out.push(ev);
        }
        return out;
    }

    function isActive(code) {
        var a = active();
        for (var i = 0; i < a.length; i++) {
            if (a[i].code === code) return true;
        }
        return false;
    }

    function treasureValues(code) {
        var ev = table()[code];
        if (!ev || !ev.treasureValues) return [];
        return ev.treasureValues.slice();
    }

    function depositModifier(code, depositType) {
        var mods = (S.core.events.data && S.core.events.data.depositModifiers) || {};
        if (mods[code] && typeof mods[code][depositType] === 'number') return mods[code][depositType];
        return 1;
    }

    function byCategory(category) {
        var all = active();
        var out = [];
        for (var i = 0; i < all.length; i++) {
            if (all[i].category === category) out.push(all[i]);
            else if (all[i].categories && all[i].categories[category]) out.push(all[i]);
        }
        return out;
    }

    // Player's current count of an event's resource currency. Returns null
    // when the host APIs aren't ready or the event has no resource. Used by
    // the dashboard to show "you have N StripedEggs" alongside the event.
    function eventResourceAmount(code) {
        var resName = eventResource(code);
        if (!resName) return null;
        return S.core.resources.amount(resName);
    }

    // True when the event is live but only its `_Shop` variant is in
    // GetActiveEventNames() — items have stopped dropping from explorer
    // treasure searches and the override should disengage. Mirrors
    // autoTSO's `getActiveEvent('_Shop') && !getActiveEvent('_Content')`.
    function isCooldown(eventOrCode) {
        var ev = (typeof eventOrCode === 'string')
            ? null
            : eventOrCode;
        if (!ev) {
            var a = active();
            for (var i = 0; i < a.length; i++) {
                if (a[i].code === eventOrCode) { ev = a[i]; break; }
            }
        }
        if (!ev) return false;
        return !!(ev.categories && ev.categories.shop && !ev.categories.treasure);
    }

    // Resource (currency) the event drops. Anniversary varies by player
    // level, so we resolve it here rather than baking the level into data.
    function eventResource(code) {
        var ev = table()[code];
        if (!ev) return null;
        if (ev.resource) return ev.resource;
        if (ev.resourceLowLevel && ev.resourceHighLevel) {
            try {
                var lvl = (typeof game !== 'undefined' && game.gi && game.gi.mHomePlayer &&
                           typeof game.gi.mHomePlayer.GetPlayerLevel === 'function')
                            ? game.gi.mHomePlayer.GetPlayerLevel() : 0;
                return lvl >= (ev.resourceLevelThreshold || 0) ? ev.resourceHighLevel : ev.resourceLowLevel;
            } catch (e) {
                return ev.resourceLowLevel;
            }
        }
        return null;
    }

    // The level-dependent treasure-value multiplier for events that have
    // one (Anniversary). Returns 1 when no multiplier applies.
    function levelMultiplier(code) {
        var ev = table()[code];
        if (!ev || typeof ev.lowLevelMultiplier !== 'number') return 1;
        try {
            var lvl = (typeof game !== 'undefined' && game.gi && game.gi.mHomePlayer &&
                       typeof game.gi.mHomePlayer.GetPlayerLevel === 'function')
                        ? game.gi.mHomePlayer.GetPlayerLevel() : 0;
            return lvl < (ev.lowLevelThreshold || 0) ? ev.lowLevelMultiplier : 1;
        } catch (e) {
            return 1;
        }
    }

    // -----------------------------------------------------------------
    // Event-suffix vocabulary used by trait/skill `name_string` filters.
    //
    // The host appends an underscore-prefixed suffix to a base task type
    // when an event-active variant of that task should drop event-themed
    // loot — e.g. `FindTreasureShort_Easter`, `FindTreasureLong_XMAS`,
    // `FindTreasure_Lovely_Short_Halloween`. Steward needs to map those
    // suffixes back to the base event codes returned by `active()` so
    // the trait recommendation algorithm (core/specialists.biasFromTrait)
    // can decide whether a seasonal-only effect should fire.
    //
    // Multiple suffixes may resolve to one event code — Soccer ships
    // both `_SoccerResources` and `_SoccerBalls` drop tables.
    //
    // Update this map alongside core/events/data.js when a new event
    // ships. The two files are kept in sync intentionally: data.js
    // owns the run-time event metadata (treasure values, resource
    // names), this map owns the build-time suffix vocabulary.
    // -----------------------------------------------------------------
    var EVENT_SUFFIX_TO_CODE = {
        '_Easter':          'Easter',
        '_XMAS':            'XMAS',
        '_Halloween':       'HW',
        '_Valentine':       'Valentine',
        '_SoccerResources': 'Soccer',
        '_SoccerBalls':     'Soccer',
        '_Anniversary':     'Anniversary',
        '_RedNose':         'RedNose',          // not yet in data.events
        '_SpecialistWeek':  'SpecialistWeek'    // not yet in data.events
    };

    // Map a single name_string entry to its event code, or null if the
    // entry has no recognised suffix. Endpoint OR `<suffix>_` substring
    // both match — the host's suffixes can appear at the end of the
    // task tag (`FindTreasureShort_Easter`) or as a middle segment in
    // composite Lovely-private variants (`FindTreasure_Lovely_Short_Easter`).
    function suffixToCode(entry) {
        if (!entry) return null;
        for (var suffix in EVENT_SUFFIX_TO_CODE) {
            if (!Object.prototype.hasOwnProperty.call(EVENT_SUFFIX_TO_CODE, suffix)) continue;
            var endsWith = entry.length >= suffix.length &&
                           entry.lastIndexOf(suffix) === (entry.length - suffix.length);
            var contains = entry.indexOf(suffix + '_') > -1;
            if (endsWith || contains) return EVENT_SUFFIX_TO_CODE[suffix];
        }
        return null;
    }

    // Plain enumeration of every known suffix string. Useful for dump
    // tooling that wants to highlight or normalise event-suffix tokens.
    function suffixList() {
        var out = [];
        for (var k in EVENT_SUFFIX_TO_CODE) {
            if (Object.prototype.hasOwnProperty.call(EVENT_SUFFIX_TO_CODE, k)) out.push(k);
        }
        return out;
    }

    if (!S.core.events) S.core.events = {};

    S.core.events.active              = active;
    S.core.events.isActive            = isActive;
    S.core.events.isCooldown          = isCooldown;
    S.core.events.treasureValues      = treasureValues;
    S.core.events.depositModifier     = depositModifier;
    S.core.events.byCategory          = byCategory;
    S.core.events.eventResource       = eventResource;
    S.core.events.eventResourceAmount = eventResourceAmount;
    S.core.events.levelMultiplier     = levelMultiplier;
    // Suffix vocabulary — see EVENT_SUFFIX_TO_CODE comment above.
    S.core.events.suffixToCode        = suffixToCode;
    S.core.events.suffixList          = suffixList;
    // Lower-level helpers exposed for diagnostics / future modules.
    S.core.events.liveEventNames   = liveEventNames;
    S.core.events.matchBaseCode    = matchBaseCode;

}(Steward));
