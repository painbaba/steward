/*
 * Dashboard surface for the explorers module.
 *
 * Renders inside the Specialists tab as an "Explorers" section. Per-explorer
 * override editing is deferred — for now the override map is still hand-
 * edited in settings.json. The section action dumps current state (overrides,
 * idle/busy counts, pickTask results) to the log so users can see what
 * dispatches will look like before turning the module on.
 */

(function (S) {

    if (!S.modules.explorers) S.modules.explorers = {};

    function readSettings() {
        var stored = S.kernel.settings.read('explorers') || {};
        var defaults = S.modules.explorers.defaultSettings || {};
        var merged = {};
        var key;
        for (key in defaults) merged[key] = defaults[key];
        for (key in stored)   merged[key] = stored[key];
        return merged;
    }

    function writeSettings(s) {
        S.kernel.settings.write('explorers', s);
    }

    function notify(text) {
        try { if (typeof showGameAlert === 'function') showGameAlert('Steward: ' + text); }
        catch (e) { /* best effort */ }
    }

    // Section action: dump explorer state + per-explorer pickTask results
    // to the log. Helps users tune overrides before flipping `enabled`.
    function showOverrides() {
        var s = readSettings();
        S.kernel.log('explorers', '--- explorer state ---');
        S.kernel.log('explorers', 'enabled:', !!s.enabled,
                     '  dispatchDelay:', s.dispatchDelay || 5000, 'ms');

        try {
            var liveRaw = S.core.events.liveEventNames();
            S.kernel.log('explorers', 'host events (raw):',
                         liveRaw.length ? liveRaw.join(', ') : '(none)');
            var matched = S.core.events.active();
            if (matched.length === 0) {
                S.kernel.log('explorers',
                    'matched events: (none — pickTask falls back to host explDefTask)');
            } else {
                for (var m = 0; m < matched.length; m++) {
                    var ev = matched[m];
                    var values = S.core.events.treasureValues(ev.code);
                    S.kernel.log('explorers', '  matched:', ev.code,
                                 '— categories:', (ev.categoryList || []).join(',') || '(none)',
                                 '— treasureValues:',
                                 (values && values.length) ? values.join(',') : '(none)');
                }
            }
        } catch (e) {
            S.kernel.error('explorers', 'event dump threw:', e);
        }
        S.kernel.log('explorers',
                     'host explDefTask:', S.kernel.host.explDefTaskGlobal(),
                     ' explDefTaskByType keys:',
                     Object.keys((typeof mainSettings !== 'undefined' && mainSettings &&
                                  mainSettings.explDefTaskByType) || {}).length);

        var c = S.core.specialists;
        var explorers;
        try { explorers = c.explorers(); }
        catch (e) {
            S.kernel.error('explorers', 'failed to list explorers:', e);
            return notify('Could not list explorers — see log.');
        }

        var idle = 0, busy = 0;
        for (var i = 0; i < explorers.length; i++) {
            if (c.status(explorers[i]) === S.SpecialistStatus.Idle) idle++; else busy++;
        }
        S.kernel.log('explorers', 'explorers — total:', explorers.length,
                     '  idle:', idle, '  busy:', busy);

        // pickTask preview per explorer.
        for (var j = 0; j < explorers.length; j++) {
            var spec = explorers[j];
            var name = c.name(spec) || '?';
            var picked = '?';
            try { picked = c.pickTask(spec) || '?'; } catch (e) { picked = 'threw'; }
            var override = c.namedOverride(s.overrides, name);
            S.kernel.log('explorers',
                '  [' + (c.status(spec) === S.SpecialistStatus.Idle ? 'idle' : 'busy') + ']',
                name,
                '→ pickTask:', picked,
                override ? ('(override: ' + override + ')') : '');
        }
        notify('Explorer state dumped to log.');
    }

    function summary() {
        var s = readSettings();
        if (!s.enabled) return 'disabled';
        var n = Object.keys(s.overrides || {}).length;
        return n + ' override' + (n === 1 ? '' : 's');
    }

    function renderSection($panel, h) {
        var s = h.settings('explorers');

        $panel.append(h.formRow('Run on Startup', h.toggle({
            checked:  !!s.enabled,
            onChange: function (next) {
                h.update('explorers', { enabled: next });
            }
        })));

        $panel.append(h.formRow('Dispatch delay', h.input({
            type:     'number',
            value:    s.dispatchDelay || 1500,
            width:    '90px',
            onChange: function (val) {
                var n = parseInt(val, 10);
                if (!isNaN(n) && n >= 0) {
                    h.update('explorers', { dispatchDelay: n });
                }
            }
        }), 'ms — pause between sends'));

        // forceTreasureOnEvents — when ON, every explorer goes on a
        // treasure dispatch during a treasure event's _Content phase
        // (cooldown / shop-only doesn't trigger this — see
        // core/specialists.activeEventContext). When OFF, adventure-
        // biased explorers (Royal, Love Struck, Keener, Nora) stay on
        // adventures even during events.
        $panel.append(h.formRow('Force treasure during events', h.toggle({
            checked:  s.forceTreasureOnEvents !== false,  // default ON
            onChange: function (next) {
                h.update('explorers', { forceTreasureOnEvents: next });
            }
        }), 'no event items drop on adventures — keep ON unless you are deliberately farming adventure scrolls'));

        // Default task — applies to vanilla explorers (no per-type
        // trait) and to inactive-trait cases (off-event Fluffy Butte).
        // The trait-aware algorithm in core/specialists.pickTask uses
        // this as its fallback before the host's autoTSO-installed
        // mainSettings.explDefTask (which usually defaults to Short).
        $panel.append(h.formRow('Default task', h.dropdown(
            defaultTaskOptions(),
            {
                selected: s.defaultTask || '',
                onChange: function (val) {
                    h.update('explorers', { defaultTask: val || null });
                }
            }
        ), 'used for explorers without a trait recommendation'));

        // Per-explorer state table — alphabetical sort, host portrait,
        // localised task labels. Renders directly into the panel as a
        // sequence of BS3 rows (autoTSO style).
        appendExplorerTable($panel, h, s);
    }

    // Build dropdown options for the "Default task" picker. Values are
    // ExplorerTask enum strings (matching `core/specialists.taskLabel`).
    // Empty value = "use Steward's longest-available baseline (Prolonged)".
    // Skill-locked variants (Erudite/BeanACollada) are intentionally
    // omitted — they only apply to explorers who learned the skill, and
    // pickTask routes those automatically.
    function defaultTaskOptions() {
        var opts = [
            { value: '', label: 'Auto (Prolonged baseline)' }
        ];
        var c = S.core.specialists;
        var enums = [
            S.ExplorerTask.Short,
            S.ExplorerTask.Medium,
            S.ExplorerTask.Long,
            S.ExplorerTask.EvenLonger,
            S.ExplorerTask.Prolonged,
            S.ExplorerTask.AdventureZoneShort,
            S.ExplorerTask.AdventureZoneMedium,
            S.ExplorerTask.AdventureZoneLong,
            S.ExplorerTask.AdventureZoneVeryLong
        ];
        for (var i = 0; i < enums.length; i++) {
            var label = (c && c.taskLabel) ? c.taskLabel(enums[i]) : enums[i];
            opts.push({ value: enums[i], label: label });
        }
        return opts;
    }

    // Best-effort remaining-time read for a busy explorer. Returns the
    // formatted host string (e.g. "2h 14m") or null if the host APIs
    // aren't reachable. Mirrors autoTSO's
    // `loca.FormatDuration(item.GetTask().GetRemainingTime(), 1)`.
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
            // Fallback: HH:MM if the host helper isn't available.
            var totalMinutes = Math.round(ms / 60000);
            var hours = Math.floor(totalMinutes / 60);
            var minutes = totalMinutes % 60;
            return hours + 'h ' + (minutes < 10 ? '0' + minutes : minutes) + 'm';
        } catch (e) { return null; }
    }

    function appendExplorerTable($panel, h, s) {
        if (!S.core.specialists || !S.core.specialists.explorers) return;
        var explorers;
        try { explorers = S.core.specialists.explorers(); }
        catch (e) { return; }
        if (!explorers || !explorers.length) return;

        var c = S.core.specialists;

        // Alphabetical by display name. Stable across renders.
        explorers.sort(function (a, b) {
            var na = (c.name(a) || '').toLowerCase();
            var nb = (c.name(b) || '').toLowerCase();
            if (na < nb) return -1;
            if (na > nb) return 1;
            return 0;
        });

        var overrides = (s && s.overrides) || {};

        // Table header (tblHeader band).
        $panel.append(h.gridRow(
            [[5, 'Name'], [2, 'Status'], [2, 'Current'], [3, 'Next']],
            { headerCells: true }
        ));

        // One BS3 row per explorer.
        for (var i = 0; i < explorers.length; i++) {
            var spec = explorers[i];
            var name = c.name(spec) || '?';
            var st = c.status(spec);
            var isIdle = (st === S.SpecialistStatus.Idle);

            // Portrait: host's getIconID + getImageTag. Falls back to a
            // gray dot if the helpers aren't available (e.g. early boot).
            var portrait = '';
            try {
                if (typeof spec.getIconID === 'function' &&
                    typeof getImageTag === 'function') {
                    var iconId = spec.getIconID();
                    if (iconId) portrait = getImageTag(iconId, '20px') + ' ';
                }
            } catch (e) { /* ignore */ }
            var nameCell = portrait + h.escape(name);

            // Status with a leading dot (CSS coloured via row class).
            // Append the remaining time for busy explorers when the
            // host exposes it (e.g. "● Busy — 2h 14m").
            var statusCell;
            if (isIdle) {
                statusCell = '○ Idle';
            } else {
                var rem = remainingTimeFor(spec);
                statusCell = '● Busy' + (rem ? ' — ' + rem : '');
            }

            // Localised task labels.
            var current = '—';
            if (!isIdle && c.currentTask) {
                var ct = c.currentTask(spec);
                current = ct ? c.taskLabel(ct) : '—';
            }
            var next = '?';
            try {
                var nt = c.pickTask(spec);
                if (nt) next = c.taskLabel(nt);
            } catch (e) { /* keep '?' */ }
            if (c.namedOverride(overrides, name)) next = next + ' *';

            var rowClass = isIdle ? 'steward-row-idle' : 'steward-row-busy';
            $panel.append(h.gridRow(
                [[5, nameCell], [2, statusCell], [2, current], [3, next]]
            ).addClass(rowClass));
        }
    }

    S.modules.explorers.readSettings   = readSettings;
    S.modules.explorers.writeSettings  = writeSettings;
    S.modules.explorers.renderSection  = renderSection;
    S.modules.explorers.summary        = summary;
    S.modules.explorers.showOverrides  = showOverrides;

}(Steward));
