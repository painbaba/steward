/*
 * Collect module.
 *
 * Clicks map pickups, one target per plan(). The targets come from
 * S.core.pickups.targets(): on the home island the collectibles whose name
 * matches the pattern list, on an adventure zone also the quest objects an
 * open quest still waits to have clicked. Every other zone is left alone.
 *
 * Each click runs as S.core.pickups.click(target) through
 * S.core.actions.attempt, so it counts only once the object is seen gone
 * from its grid or no longer selectable. The attempt's queue entries keep
 * this module busy, so the next plan() comes only after the click settled;
 * a verified click wakes the module at once for the next target.
 *
 * On adventures the setting adventureZones switches clicking on or off, and
 * isReady() holds while the adventures module has queue work in flight, so a
 * click never lands between the steps of an attack it is pacing.
 *
 * A click that did not verify (or did not start) puts its zone and grid into
 * a memory-only retry table and is not tried again for CLICK_RETRY_MS; other
 * targets go first meanwhile.
 *
 * Collectible detection: the host flag
 * CollectionsManager.getBuildingIsCollectible(name) alone also matches
 * terrain rocks, depleted mines and charcoal piles (what the client's F4
 * "pickup all" sweeps), so a name pattern is required on top. Use
 * Steward -> Collect -> "Discover collectibles" to log every candidate on
 * the current map and tune the pattern list.
 */

(function (S) {

    if (!S.modules.collect) S.modules.collect = {};

    // How long a failed click waits before the same target is tried again.
    var CLICK_RETRY_MS = 60000;

    // Module-private state. Persists across ticks but not across reboots.
    var state = {
        lastUnmatchedSig: null,
        // 'zoneId:grid' -> time from which that target may be clicked again.
        retries: {}
    };

    function readSettings() {
        return (S.modules.collect && S.modules.collect.readSettings)
            ? S.modules.collect.readSettings()
            : S.modules.collect.defaultSettings;
    }

    // Read through the module object at call time so tests can replace it.
    function now() {
        return S.modules.collect.now();
    }

    function retryKey(t) {
        return t.zoneId + ':' + t.grid;
    }

    function isReady(ctx) {
        var s = readSettings();
        if (!s || !s.enabled) return false;
        if (!ctx.zone) return false;
        if (ctx.zone.isHome) {
            return !!(s.namePatterns && s.namePatterns.length);
        }
        if (ctx.zone.isAdventure) {
            if (s.adventureZones !== true) return false;
            // The adventure run paces attacks through the queue; a click in
            // between would delay or reorder its steps.
            return !S.kernel.queue.isModuleBusy('adventures');
        }
        return false;
    }

    // Collectibles exist but none match. Logged once per distinct unmatched
    // set so a stale map doesn't spam the log every tick; repeats go to debug.
    function noteUnmatched(patterns) {
        var bld = S.core.buildings;
        var src = bld.list();
        var collectibleCount = 0;
        var unmatchedSamples = [];
        var seenUnmatched = {};
        var MAX_SAMPLES = 8;

        for (var i = 0; i < src.length; i++) {
            if (!bld.isCollectible(src[i])) continue;
            var name = bld.name(src[i]);
            if (S.core.pickups.matches(name, patterns)) continue;
            collectibleCount++;
            if (!seenUnmatched[name] && unmatchedSamples.length < MAX_SAMPLES) {
                seenUnmatched[name] = true;
                unmatchedSamples.push(name);
            }
        }
        if (collectibleCount === 0) return;

        var sig = patterns.join('|') + '|' + unmatchedSamples.join(',');
        var firstTime = (state.lastUnmatchedSig !== sig);
        state.lastUnmatchedSig = sig;
        var msg = ['host has', collectibleCount,
                   'collectible(s) on map but none match patterns:',
                   patterns.join(',') || '(empty)',
                   '— unmatched samples:',
                   unmatchedSamples.length ? unmatchedSamples.join(', ') : '(none)'];
        if (firstTime) S.kernel.log.apply(null, ['collect'].concat(msg));
        else            S.kernel.debug.apply(null, ['collect'].concat(msg));
    }

    function onClickDone(t, key) {
        return function (result) {
            if (result && result.status === S.ActionResult.Verified) {
                delete state.retries[key];
                S.kernel.log('collect', 'picked up ' + t.name + ' at ' + t.grid);
                // The busy contract still spaces the clicks; this only skips
                // the wait for the next regular tick.
                S.kernel.scheduler.wake('collect', 0);
                return;
            }
            state.retries[key] = now() + CLICK_RETRY_MS;
            S.kernel.debug('collect', t.name + ' at ' + t.grid + ' not picked up (' +
                           ((result && (result.reason || result.status)) || 'no result') +
                           '), retry in ' + (CLICK_RETRY_MS / 1000) + ' s');
        };
    }

    function plan(ctx) {
        var s = readSettings();
        var patterns = S.core.pickups.patterns(s.namePatterns || []);
        var adventure = !!(ctx && ctx.zone && ctx.zone.isAdventure);
        S.core.buildings.invalidate();
        var list = S.core.pickups.targets({ patterns: patterns, quests: adventure });
        if (list === null) return;

        var t = null;
        var key = null;
        var at = now();
        for (var i = 0; i < list.length; i++) {
            var k = retryKey(list[i]);
            if (state.retries.hasOwnProperty(k)) {
                if (state.retries[k] > at) continue;
                delete state.retries[k];
            }
            t = list[i];
            key = k;
            break;
        }

        if (!t) {
            if (list.length === 0) noteUnmatched(patterns);
            return;
        }

        var started = false;
        try {
            started = S.core.actions.attempt(S.core.pickups.click(t), onClickDone(t, key));
        } catch (e) {
            S.kernel.error('collect', 'click on ' + t.name + ' at ' + t.grid + ' threw:', e);
        }
        if (!started) {
            state.retries[key] = now() + CLICK_RETRY_MS;
            S.kernel.debug('collect', 'click on ' + t.name + ' at ' + t.grid + ' did not start');
        }
    }

    // Seeds every default key the stored settings lack, so readers of the raw
    // stored object (the adventure run reads adventureZones) see them. A
    // stored value always wins; nothing is written when no key was missing.
    function seedSettings() {
        var defaults = S.modules.collect.defaultSettings;
        var stored = S.kernel.settings.read('collect');
        if (!stored) {
            S.kernel.settings.write('collect', defaults);
            return;
        }
        var missing = false;
        for (var key in defaults) {
            if (defaults.hasOwnProperty(key) && !stored.hasOwnProperty(key)) missing = true;
        }
        if (missing) S.kernel.settings.write('collect', readSettings());
    }

    function boot() {
        seedSettings();
    }

    S.modules.collect.CLICK_RETRY_MS = CLICK_RETRY_MS;
    S.modules.collect.now = function () { return Date.now(); };

    S.kernel.register({
        id:       'collect',
        priority: S.Priority.Normal,
        boot:     boot,
        isReady:  isReady,
        plan:     plan,
        // Render / summary are wrapped in closures so they resolve
        // S.modules.collect.* at call time. ui.js loads AFTER module.js
        // (alphabetical concat order), so a direct reference here would
        // be undefined and validateUi would reject the spec.
        ui: {
            tab: 'buildings',
            section: {
                id:    'collect_pickups',
                title: 'Collect Pickups',
                icon:  '★',
                render: function ($body, h) {
                    if (S.modules.collect.renderSection) {
                        return S.modules.collect.renderSection($body, h);
                    }
                },
                summary: function () {
                    return S.modules.collect.summary ? S.modules.collect.summary() : '';
                },
                action: {
                    label:   'Discover collectibles (log)',
                    onClick: function () {
                        if (S.modules.collect.discover) S.modules.collect.discover();
                    }
                }
            }
        }
    });

}(Steward));
