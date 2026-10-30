/*
 * explorers module.
 *
 * Periodically dispatches idle explorers to the task chosen by the
 * precedence chain documented in docs/CORE_USAGE.md (Rule 5):
 *
 *   1. settings.overrides[<name>]                  — Steward's per-explorer
 *                                                     override (most specific)
 *   2. mainSettings.explDefTaskByType[<GetType>]   — host's per-type override
 *      (consulted inside core.specialists.pickTask)
 *   3. event-aware optimisation                     — pickTask
 *   4. mainSettings.explDefTask                     — host's global default
 *      (also inside pickTask)
 *   5. Steward.ExplorerTask.Short                   — hardcoded baseline
 *
 * Honours the kernel's busy contract: once plan() has enqueued one
 * dispatch per available explorer, the module is "busy" until those
 * dispatches drain. No second plan() call piles work on top.
 *
 * P7d v0.4.0 scope: dispatch idle explorers only. Explorers already
 * working are left alone. Cancellation and re-routing are deferred
 * until the user has a real workflow that needs them.
 */

(function (S) {

    function readSettings() {
        return (S.modules.explorers && S.modules.explorers.readSettings)
            ? S.modules.explorers.readSettings()
            : S.modules.explorers.defaultSettings;
    }

    function stripHtml(name) {
        if (S.modules.explorers && S.modules.explorers.stripHtml) {
            return S.modules.explorers.stripHtml(name);
        }
        return (typeof name === 'string') ? name.replace(/<[^>]+>/g, '') : '';
    }

    // Per-explorer overrides accept ANY known ExplorerTask — both treasure
    // searches and adventure-zone searches. Dispatch packet selection
    // (taskId=1 vs taskId=2) is handled inside core.specialists.send via
    // EXPLORER_TASK_PACKET. Validation goes through core.specialists.knownTask
    // so we don't duplicate the enum list here.
    function pickForExplorer(explorer) {
        var s = readSettings();
        var c = S.core.specialists;

        // 1. Per-name override (Steward's settings).
        if (s.overrides) {
            var rawName = c.name(explorer);
            var key = stripHtml(rawName);
            if (key && s.overrides[key]) {
                var enumVal = s.overrides[key];
                if (c.knownTask(enumVal)) return enumVal;
                S.kernel.warn('explorers',
                    'override for', key, 'is not a recognised ExplorerTask value:', enumVal);
            }
        }

        // 2-5. Host per-type, event-aware, host global, baseline — all in pickTask.
        try {
            return c.pickTask(explorer) || S.ExplorerTask.Short;
        } catch (e) {
            S.kernel.warn('explorers', 'pickTask threw:', e);
            return S.ExplorerTask.Short;
        }
    }

    function isReady(ctx) {
        var s = readSettings();
        if (!s || !s.enabled) return false;
        if (!ctx.zone || !ctx.zone.isHome) return false;
        return true;
    }

    function plan() {
        var c = S.core.specialists;
        var rawIdle;
        try { rawIdle = c.available(S.SpecialistType.Explorer); }
        catch (e) {
            S.kernel.error('explorers', 'available() threw:', e);
            return;
        }
        if (rawIdle.length === 0) return;

        // The reader already leaves out entries without a stable uniqueID; an
        // entry can still lose its members after that read. The queue contract
        // needs the uid for the re-find at fire time. A dropped explorer only
        // leaves fewer candidates, never a wrong count, so unlike geologists
        // this pass does not hold on a read that dropped entries.
        var idleExplorers = [];
        for (var ie = 0; ie < rawIdle.length; ie++) {
            if (!c.uniqueIdKey(rawIdle[ie])) continue;
            idleExplorers.push(rawIdle[ie]);
        }
        if (idleExplorers.length === 0) return;

        var s = readSettings();
        var delay = (typeof s.dispatchDelay === 'number') ? s.dispatchDelay : 1500;
        var dispatched = 0;

        for (var i = 0; i < idleExplorers.length; i++) {
            var spec = idleExplorers[i];
            var task = pickForExplorer(spec);
            if (!task) continue;

            // Capture uniqueID (a stable per-instance key) so the queue
            // action re-finds the SAME explorer at fire time. Two explorers
            // can share a display name (e.g. multiple "Bewitching Explorer"
            // instances of GetType=51) — name-based lookup picks one and
            // sends to it repeatedly while ignoring the rest.
            // The key is read again here, so an entry can still turn
            // unreadable between the idle filter and this read. A null key
            // would queue an action that can never re-find its explorer.
            var uidKey = c.uniqueIdKey(spec);
            if (!uidKey) continue;
            var name = stripHtml(c.name(spec)) || '?';
            S.kernel.queue.add('explorers.dispatch',
                [uidKey, name, task],
                i === 0 ? 0 : delay);
            dispatched++;
        }

        if (dispatched > 0) {
            S.kernel.log('explorers', 'queued dispatch for', dispatched, 'idle explorer(s)');
        }
    }

    function boot() {
        // Seed defaults on first run.
        if (!S.kernel.settings.read('explorers')) {
            S.kernel.settings.write('explorers',
                S.modules.explorers.defaultSettings);
        }

        // Register the dispatch action.
        S.kernel.queue.action('explorers.dispatch', function (params) {
            var uidKey = params[0];
            var displayName = params[1] || '?';
            var taskEnum = params[2];
            var c = S.core.specialists;

            // Re-find the explorer by uniqueID (display names can repeat
            // across instances; uniqueID is stable per-instance). A read that
            // cannot tell ends here without a warning: the reader already
            // logged and the next plan dispatches again.
            var spec = null;
            try {
                var l = c.lookup(uidKey);
                if (!l.ok) return;
                spec = l.spec;
            } catch (e) {
                S.kernel.error('explorers', 'lookup for', displayName, 'threw:', e);
                return;
            }

            if (!spec) {
                S.kernel.warn('explorers', 'could not re-find', displayName,
                              '(uid', uidKey, ') — skipping');
                return;
            }
            if (c.status(spec) !== S.SpecialistStatus.Idle) {
                S.kernel.log('explorers', displayName, 'no longer idle — skipping');
                return;
            }

            try {
                var ok = c.send(spec, taskEnum);
                if (ok) {
                    S.kernel.log('explorers', 'sent', displayName, '→', taskEnum);
                } else {
                    S.kernel.warn('explorers', 'send returned false for', displayName);
                }
            } catch (e) {
                S.kernel.error('explorers', 'send threw for', displayName, ':', e);
            }
        });

    }

    S.kernel.register({
        id:       'explorers',
        priority: S.Priority.Normal,
        boot:     boot,
        isReady:  isReady,
        plan:     plan,
        // Late-binding refs — see collect/module.js for why.
        ui: {
            tab: 'specialists',
            section: {
                id:    'explorers',
                title: 'Explorers',
                icon:  '⌖',
                render: function ($body, h) {
                    if (S.modules.explorers.renderSection) {
                        return S.modules.explorers.renderSection($body, h);
                    }
                },
                summary: function () {
                    return S.modules.explorers.summary
                        ? S.modules.explorers.summary()
                        : '';
                },
                action: {
                    label:   'Show overrides + state',
                    onClick: function () {
                        if (S.modules.explorers.showOverrides) {
                            S.modules.explorers.showOverrides();
                        }
                    }
                }
            }
        }
    });

}(Steward));
