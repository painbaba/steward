/*
 * Dashboard surface for the geologists module.
 *
 * Renders inside the Specialists tab as a "Geologists" section.
 * Per-geologist override editing is deferred for v1 — the override
 * map is hand-edited in settings.json. The section action dumps a
 * per-deposit ranking (best capacity-bonus geo per deposit) plus
 * idle/busy/wanted state so users can preview routing before they
 * flip `enabled`.
 */

(function (S) {

    if (!S.modules.geologists) S.modules.geologists = {};

    function readSettings() {
        var stored = S.kernel.settings.read('geologists') || {};
        var defaults = S.modules.geologists.defaultSettings || {};
        var merged = {};
        var key;
        for (key in defaults) merged[key] = defaults[key];
        for (key in stored)   merged[key] = stored[key];
        // Deep-merge nested deposits map so partial user edits don't
        // wipe defaults for deposit types the user hasn't touched.
        var depMerged = {};
        var defaultDeps = defaults.deposits || {};
        var storedDeps  = stored.deposits  || {};
        for (key in defaultDeps) depMerged[key] = defaultDeps[key];
        for (key in storedDeps)  depMerged[key] = storedDeps[key];
        merged.deposits = depMerged;
        return merged;
    }

    function writeSettings(s) {
        S.kernel.settings.write('geologists', s);
    }

    function notify(text) {
        try { if (typeof showGameAlert === 'function') showGameAlert('Steward: ' + text); }
        catch (e) { /* best effort */ }
    }

    function fmtFactor(n) {
        if (typeof n !== 'number' || !isFinite(n)) return '?';
        return (Math.round(n * 100) / 100).toFixed(2);
    }

    // Best-effort remaining-time read for a busy geologist. Same shape
    // as the explorers module's helper.
    function remainingTimeFor(spec) {
        try {
            if (typeof spec.GetTask !== 'function') return null;
            var task = spec.GetTask();
            if (!task || typeof task.GetRemainingTime !== 'function') return null;
            var ms = task.GetRemainingTime();
            if (typeof ms !== 'number' || ms <= 0) return null;
            if (typeof loca !== 'undefined' && loca && typeof loca.FormatDuration === 'function') {
                return loca.FormatDuration(ms, 1);
            }
            var totalMinutes = Math.round(ms / 60000);
            var hours = Math.floor(totalMinutes / 60);
            var minutes = totalMinutes % 60;
            return hours + 'h ' + (minutes < 10 ? '0' + minutes : minutes) + 'm';
        } catch (e) { return null; }
    }

    // Section action: dump per-deposit ranking + state. Helps users
    // tune `deposits.*.max` and overrides before flipping `enabled`.
    function showRanking() {
        var s = readSettings();
        var c = S.core.specialists;
        var d = S.core.deposits;
        S.kernel.log('geologists', '--- geologist state ---');
        S.kernel.log('geologists', 'enabled:', !!s.enabled,
                     '  dispatchDelay:', s.dispatchDelay || 1500, 'ms');

        var allGeos;
        try { allGeos = c.geologists() || []; }
        catch (e) {
            S.kernel.error('geologists', 'failed to list geologists:', e);
            return notify('Could not list geologists — see log.');
        }
        var idle = 0, busy = 0;
        for (var i = 0; i < allGeos.length; i++) {
            if (c.status(allGeos[i]) === S.SpecialistStatus.Idle) idle++; else busy++;
        }
        S.kernel.log('geologists', 'geologists — total:', allGeos.length,
                     '  idle:', idle, '  busy:', busy);

        if (!d || !d.types) {
            S.kernel.warn('geologists', 'core.deposits.types unavailable');
            return notify('Geologist state dumped — core.deposits not ready.');
        }

        var types = d.types();
        S.kernel.log('geologists', '--- per-deposit ranking (capacity / time) ---');
        for (var t = 0; t < types.length; t++) {
            var info = types[t];
            var cfg = (s.deposits || {})[info.name] || {};
            var enabled = !!cfg.enabled;
            var max = (typeof cfg.max === 'number') ? cfg.max : 0;

            var onMap = 0;
            try { onMap = d.byType(info.name).length; }
            catch (e) { /* skip */ }

            // Count busy geos on this deposit.
            var onTask = 0;
            for (var b = 0; b < allGeos.length; b++) {
                var g = allGeos[b];
                try {
                    if (c.status(g) === S.SpecialistStatus.Idle) continue;
                    var task = (typeof g.GetTask === 'function') ? g.GetTask() : null;
                    if (task && typeof task.GetSubType === 'function' &&
                        task.GetSubType() === info.index) {
                        onTask++;
                    }
                } catch (e) { /* skip */ }
            }
            var wanted = enabled ? Math.max(0, max - onMap - onTask) : 0;

            S.kernel.log('geologists',
                '  ' + info.name +
                '  cfg: enabled=' + enabled + ' max=' + max +
                '  on map=' + onMap + '  on task=' + onTask +
                '  wanted=' + wanted);

            if (!c.rankGeologistsForDeposit) continue;
            var ranked = c.rankGeologistsForDeposit(info.name, {
                from:     allGeos,
                idleOnly: false
            });
            var topN = Math.min(5, ranked.length);
            for (var r = 0; r < topN; r++) {
                var row = ranked[r];
                if (row.capacityFactor <= 1 && row.timeFactor >= 1) break;  // out of "interesting" picks
                var nm = c.name(row.geo) || '?';
                var st = c.status(row.geo);
                var stTag = (st === S.SpecialistStatus.Idle) ? '[idle]' : '[busy]';
                S.kernel.log('geologists',
                    '    ' + stTag +
                    ' cap×' + fmtFactor(row.capacityFactor) +
                    '  time×' + fmtFactor(row.timeFactor) +
                    '  ' + nm);
            }
        }
        notify('Geologist ranking dumped to log.');
    }

    function summary() {
        var s = readSettings();
        if (!s.enabled) return 'disabled';
        var n = Object.keys(s.overrides || {}).length;
        return n + ' override' + (n === 1 ? '' : 's');
    }

    function renderSection($panel, h) {
        var s = h.settings('geologists');

        $panel.append(h.formRow('Run on Startup', h.toggle({
            checked:  !!s.enabled,
            onChange: function (next) {
                h.update('geologists', { enabled: next });
            }
        })));

        $panel.append(h.formRow('Dispatch delay', h.input({
            type:     'number',
            value:    s.dispatchDelay || 1500,
            width:    '90px',
            onChange: function (val) {
                var n = parseInt(val, 10);
                if (!isNaN(n) && n >= 0) {
                    h.update('geologists', { dispatchDelay: n });
                }
            }
        }), 'ms — pause between sends'));

        appendDepositTable($panel, h, s);
        appendGeologistTable($panel, h, s);
    }

    // Per-deposit toggle + on-map count + max input. Order matches
    // autoTSO (subTaskId order), driven by S.core.deposits.types().
    // The "On map" column reads the live host count so users can see
    // how close they are to the configured `max` for each deposit.
    function appendDepositTable($panel, h, s) {
        var d = S.core.deposits;
        if (!d || !d.types) return;
        var types = d.types();
        var depCfg = (s && s.deposits) || {};

        $panel.append(h.gridRow(
            [[5, 'Deposit'], [2, 'Enabled'], [2, 'On map'], [3, 'Max']],
            { headerCells: true }
        ));

        for (var i = 0; i < types.length; i++) {
            var info = types[i];
            var cfg = depCfg[info.name] || { enabled: false, max: 0 };

            var onMap = 0;
            try { onMap = d.byType(info.name).length; }
            catch (e) { /* leave 0 */ }

            // Closure capture: each loop iteration needs its own `name`
            // for the onChange callbacks.
            (function (depositName, currentCfg, currentOnMap) {
                var $toggle = h.toggle({
                    checked:  !!currentCfg.enabled,
                    onChange: function (next) {
                        updateDeposit(h, depositName, { enabled: next });
                    }
                });
                var $maxInput = h.input({
                    type:     'number',
                    value:    (typeof currentCfg.max === 'number') ? currentCfg.max : 0,
                    width:    '70px',
                    onChange: function (val) {
                        var n = parseInt(val, 10);
                        if (!isNaN(n) && n >= 0) {
                            updateDeposit(h, depositName, { max: n });
                        }
                    }
                });
                $panel.append(h.gridRow(
                    [[5, depositName], [2, $toggle], [2, String(currentOnMap)], [3, $maxInput]]
                ));
            })(info.name, cfg, onMap);
        }
    }

    // Merge a partial change into settings.deposits[name]. h.update
    // does shallow merge at the top level so we hand it the full
    // updated `deposits` object. Read from the dashboard buffer, NOT
    // from persisted settings — multiple edits before Save must layer
    // on top of each other or earlier pending changes get clobbered.
    function updateDeposit(h, depositName, partial) {
        var s = h.settings('geologists');
        var deposits = {};
        var k;
        for (k in (s.deposits || {})) deposits[k] = s.deposits[k];
        var current = deposits[depositName] || { enabled: false, max: 0 };
        var next = { enabled: current.enabled, max: current.max };
        if (typeof partial.enabled !== 'undefined') next.enabled = partial.enabled;
        if (typeof partial.max !== 'undefined')     next.max = partial.max;
        deposits[depositName] = next;
        h.update('geologists', { deposits: deposits });
    }

    // Per-geologist roster: best deposit, current task, override flag.
    function appendGeologistTable($panel, h, s) {
        var c = S.core.specialists;
        var d = S.core.deposits;
        if (!c || !c.geologists) return;
        var geos;
        try { geos = c.geologists(); }
        catch (e) { return; }
        if (!geos || !geos.length) return;

        // Sort alphabetical by display name for stable rendering.
        geos.sort(function (a, b) {
            var na = (c.name(a) || '').toLowerCase();
            var nb = (c.name(b) || '').toLowerCase();
            if (na < nb) return -1;
            if (na > nb) return 1;
            return 0;
        });

        var overrides = (s && s.overrides) || {};
        var types = (d && d.types) ? d.types() : [];

        $panel.append(h.gridRow(
            [[5, 'Name'], [2, 'Status'], [3, 'Best deposit'], [2, 'Current']],
            { headerCells: true }
        ));

        for (var i = 0; i < geos.length; i++) {
            var spec = geos[i];
            var name = c.name(spec) || '?';
            var st = c.status(spec);
            var isIdle = (st === S.SpecialistStatus.Idle);

            var portrait = '';
            try {
                if (typeof spec.getIconID === 'function' &&
                    typeof getImageTag === 'function') {
                    var iconId = spec.getIconID();
                    if (iconId) portrait = getImageTag(iconId, '20px') + ' ';
                }
            } catch (e) { /* ignore */ }
            var nameCell = portrait + h.escape(name);
            if (c.namedOverride(overrides, name)) nameCell = nameCell + ' *';

            var statusCell;
            if (isIdle) {
                statusCell = '○ Idle';
            } else {
                var rem = remainingTimeFor(spec);
                statusCell = '● Busy' + (rem ? ' — ' + rem : '');
            }

            // Best deposit by capacity factor across all known types.
            var bestName = '—';
            var bestCap  = 1;
            var bestTime = 1;
            for (var t = 0; t < types.length; t++) {
                var score = c.geologistScoreFor ? c.geologistScoreFor(spec, types[t].name) : null;
                if (!score) continue;
                if (score.capacityFactor > bestCap ||
                    (score.capacityFactor === bestCap && score.timeFactor < bestTime)) {
                    bestCap  = score.capacityFactor;
                    bestTime = score.timeFactor;
                    bestName = types[t].name;
                }
            }
            var bestCell = (bestCap > 1 || bestTime < 1)
                ? bestName + '  cap×' + fmtFactor(bestCap) + ' / time×' + fmtFactor(bestTime)
                : '— vanilla —';

            // Current task: read the host's GetTask().GetSubType() and
            // map back to deposit name for busy specs.
            var currentCell = '—';
            if (!isIdle) {
                try {
                    var task = (typeof spec.GetTask === 'function') ? spec.GetTask() : null;
                    if (task && typeof task.GetSubType === 'function') {
                        var sub = task.GetSubType();
                        if (typeof sub === 'number' && d && d.types) {
                            var resolved = types[sub];
                            if (resolved) currentCell = resolved.name;
                            else          currentCell = 'subTaskId=' + sub;
                        }
                    }
                } catch (e) { /* keep '—' */ }
            }

            var rowClass = isIdle ? 'steward-row-idle' : 'steward-row-busy';
            $panel.append(h.gridRow(
                [[5, nameCell], [2, statusCell], [3, bestCell], [2, currentCell]]
            ).addClass(rowClass));
        }
    }

    S.modules.geologists.readSettings  = readSettings;
    S.modules.geologists.writeSettings = writeSettings;
    S.modules.geologists.renderSection = renderSection;
    S.modules.geologists.summary       = summary;
    S.modules.geologists.showRanking   = showRanking;

}(Steward));
