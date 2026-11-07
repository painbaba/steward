/*
 * Geologists module.
 *
 * Dispatches idle geologists to deposit-search tasks. Each tick:
 *
 *   0. Settle earlier sends through the shared send guard
 *      (S.core.specialists.sendGuard): a send counts once the geologist
 *      leaves Idle. Pending and held geologists are not candidates, and
 *      pending ones count as on task for their deposit.
 *   1. Walk every enabled deposit type (ordered by S.core.deposits.types).
 *   2. Compute "wanted slots" per deposit:
 *        wanted = max - onMapCount - onTaskCount
 *      where onMapCount = current deposits of that type on the home zone,
 *            onTaskCount = busy geologists currently searching it.
 *   3. For each wanted slot, pick the best idle geologist via
 *      S.core.specialists.bestGeologistForDeposit (capacity primary,
 *      speed tiebreak; ignores friendpremiumbuff1 — see core/specialists/
 *      geologists.js for the algorithm). A geologist already pinned by
 *      `overrides` is only eligible for deposits in its override list.
 *   4. Collect the picks, then enqueue them via
 *      queue.add('geologists.dispatch', ...) unless the specialist list
 *      lost entries during the pass; such a pass queues nothing. While
 *      the guard's breaker is open it stops this step or limits it to
 *      a single probe.
 *
 * Honours the kernel's busy contract: once plan() has enqueued one
 * dispatch per intended slot the module is "busy" until the queue
 * drains. No second plan() call piles work on top.
 *
 * Mine building / leveling / buffing is intentionally out of v1 scope
 * (see plan: defer to v2 once core/buildings.place() exists). v1 is
 * dispatch-only.
 */

(function (S) {

    if (!S.modules.geologists) S.modules.geologists = {};

    function readSettings() {
        if (S.modules.geologists.readSettings) {
            return S.modules.geologists.readSettings();
        }
        return S.modules.geologists.defaultSettings;
    }

    function isReady(ctx) {
        var s = readSettings();
        if (!s || !s.enabled) return false;
        if (!ctx.zone || !ctx.zone.isHome) return false;
        return true;
    }

    // Count busy geologists currently searching the given depositIndex
    // (i.e. spec.GetTask().GetSubType() matches). autoTSO uses the same
    // approach at user_auto.js:5136-5138.
    function busyOnDeposit(geos, depositIndex) {
        var c = S.core.specialists;
        var count = 0;
        for (var i = 0; i < geos.length; i++) {
            var g = geos[i];
            if (!g) continue;
            try {
                if (c.status(g) === S.SpecialistStatus.Idle) continue;
            } catch (e) { continue; }
            try {
                var task = (typeof g.GetTask === 'function') ? g.GetTask() : null;
                if (!task || typeof task.GetSubType !== 'function') continue;
                if (task.GetSubType() === depositIndex) count++;
            } catch (e) { /* skip */ }
        }
        return count;
    }

    // Number of entries in `tags` equal to `name`.
    function countTag(tags, name) {
        var n = 0;
        for (var i = 0; i < tags.length; i++) {
            if (tags[i] === name) n++;
        }
        return n;
    }

    // Filter `idle` to only those eligible for `depositName` given the
    // `overrides` map. Geologists with no override are always eligible.
    // Geologists with an override list are eligible only when that list
    // contains the deposit.
    function eligibleForDeposit(idle, depositName, overrides) {
        var c = S.core.specialists;
        var out = [];
        for (var i = 0; i < idle.length; i++) {
            var g = idle[i];
            var ov = c.namedOverride(overrides, c.name(g));
            if (ov && ov.length) {
                var allowed = false;
                for (var j = 0; j < ov.length; j++) {
                    if (ov[j] === depositName) { allowed = true; break; }
                }
                if (!allowed) continue;
            }
            out.push(g);
        }
        return out;
    }

    function plan() {
        var c = S.core.specialists;
        var s = readSettings();
        if (!S.core.deposits || !S.core.deposits.types) {
            S.kernel.error('geologists', 'core.deposits.types unavailable — bundle order issue?');
            return;
        }

        var before = c.dropped();
        var allGeos;
        try { allGeos = c.geologists(); }
        catch (e) {
            S.kernel.error('geologists', 'geologists() threw:', e);
            return;
        }
        // Dropped busy geologists would shorten busyOnDeposit, raise wanted
        // and over-dispatch the healthy idle ones, so this tick plans nothing.
        if (c.dropped() !== before) return;
        // The check above makes this read complete, so the guard may judge
        // an Idle geologist as a missed send.
        c.sendGuard.settle('geologists', allGeos || [], true);
        if (!allGeos || !allGeos.length) return;

        // Idle pool: idle status AND a stable uniqueID. The reader already
        // leaves out entries without one; an entry can still lose its members
        // after that read, and the queue action could not re-find it at fire
        // time. A geologist whose last send is pending or held stays out, so
        // ranking picks another one for the slot.
        var idleGeos = [];
        for (var ig = 0; ig < allGeos.length; ig++) {
            var g0 = allGeos[ig];
            try {
                if (c.status(g0) !== S.SpecialistStatus.Idle) continue;
            } catch (e) { continue; }
            var uid0 = c.uniqueIdKey(g0);
            if (!uid0) continue;
            if (c.sendGuard.blocked(uid0)) continue;
            idleGeos.push(g0);
        }
        if (!idleGeos.length) return;

        var types = S.core.deposits.types();
        var depCfg = (s && s.deposits) || {};
        var overrides = (s && s.overrides) || {};
        var assigned = {};   // uid → true (this tick)
        var delay = (typeof s.dispatchDelay === 'number') ? s.dispatchDelay : 1500;
        var picks = [];
        // A sent geologist can read Idle for a while before its task shows;
        // counting it as on task keeps a second geologist off the same slot.
        var pendingTags = c.sendGuard.pendingTags('geologists');

        for (var t = 0; t < types.length; t++) {
            var info = types[t];
            var cfg = depCfg[info.name];
            if (!cfg || !cfg.enabled) continue;
            var max = (typeof cfg.max === 'number') ? cfg.max : 0;
            if (max <= 0) continue;

            var onMap;
            try { onMap = S.core.deposits.byType(info.name).length; }
            catch (e) {
                // An unknown count must not read as zero: wanted would then equal
                // max and over-dispatch, so this type is skipped for this tick.
                S.kernel.warn('geologists', 'byType failed for', info.name, '- skipping this tick:', e);
                continue;
            }
            var onTask = busyOnDeposit(allGeos, info.index) + countTag(pendingTags, info.name);
            var wanted = max - onMap - onTask;
            if (wanted <= 0) continue;

            // Apply override constraint to the candidate pool, then ask
            // the scoring helper for ranking. We re-rank per slot so the
            // exclude set updates between picks.
            var pool = eligibleForDeposit(idleGeos, info.name, overrides);
            for (var w = 0; w < wanted; w++) {
                var best = c.bestGeologistForDeposit(info.name, {
                    from:            pool,
                    exclude:         assigned,
                    requirePositive: false   // accept vanilla geo when no specialist is idle
                });
                if (!best) break;
                // best.uid is non-null: the ranking skips entries without one.
                assigned[best.uid] = true;

                var displayName = c.name(best.geo) || '?';
                picks.push([best.uid, displayName, info.name]);
            }
        }

        if (!picks.length) return;
        // An entry that lost its members inside this pass reads Idle, so the
        // counts above may be wrong. One last read decides before anything is
        // queued.
        if (!c.listComplete()) return;
        // The shared breaker allows nothing, or a single probe, while
        // recent sends keep failing to change their specialist.
        var room = c.sendGuard.admit(picks.length);
        if (room <= 0) return;
        var count = Math.min(room, picks.length);

        for (var p = 0; p < count; p++) {
            S.kernel.queue.add('geologists.dispatch', picks[p], p === 0 ? 0 : delay);
        }
        S.kernel.log('geologists', 'queued dispatch for', count, 'geologist(s)');
    }

    function boot() {
        if (!S.kernel.settings.read('geologists')) {
            S.kernel.settings.write('geologists', S.modules.geologists.defaultSettings);
        }

        S.kernel.queue.action('geologists.dispatch', function (params) {
            var uidKey = params[0];
            var displayName = params[1] || '?';
            var depositName = params[2];
            var c = S.core.specialists;

            var depIdx = (S.core.deposits && S.core.deposits.indexOf)
                ? S.core.deposits.indexOf(depositName) : -1;
            if (depIdx < 0) {
                S.kernel.warn('geologists', 'unknown deposit', depositName, '— skipping dispatch for', displayName);
                return;
            }

            // Re-find by uniqueID so the dispatch hits the same instance
            // we ranked. Names can collide across multiple specimens of
            // the same GetType. A read that cannot tell ends here without a
            // warning: the reader already logged and the next plan dispatches
            // again.
            var spec = null;
            try {
                var l = c.lookup(uidKey);
                if (!l.ok) return;
                spec = l.spec;
            } catch (e) {
                S.kernel.error('geologists', 'lookup for', displayName, 'threw:', e);
                return;
            }

            if (!spec) {
                S.kernel.warn('geologists', 'could not re-find', displayName,
                              '(uid', uidKey, ') — skipping');
                return;
            }
            if (c.status(spec) !== S.SpecialistStatus.Idle) {
                S.kernel.log('geologists', displayName, 'no longer idle — skipping');
                return;
            }

            try {
                var ok = c.send(spec, S.GeologistTask.Search, depIdx);
                if (ok) {
                    c.sendGuard.note('geologists', uidKey, displayName, depositName);
                    S.kernel.log('geologists', 'sent', displayName, '(uid', uidKey + ')', '→', depositName,
                                 '(subTaskId', depIdx + ')');
                } else {
                    S.kernel.warn('geologists', 'send returned false for', displayName);
                }
            } catch (e) {
                S.kernel.error('geologists', 'send threw for', displayName, ':', e);
            }
        });
    }

    S.kernel.register({
        id:       'geologists',
        priority: S.Priority.Normal,
        boot:     boot,
        isReady:  isReady,
        plan:     plan,
        ui: {
            tab: 'geologists',
            section: {
                id:    'geologists',
                title: 'Geologists',
                icon:  '⛏',
                render: function ($body, h) {
                    if (S.modules.geologists.renderSection) {
                        return S.modules.geologists.renderSection($body, h);
                    }
                },
                summary: function () {
                    return S.modules.geologists.summary
                        ? S.modules.geologists.summary()
                        : '';
                },
                action: {
                    label:   'Show ranking + state',
                    onClick: function () {
                        if (S.modules.geologists.showRanking) {
                            S.modules.geologists.showRanking();
                        }
                    }
                }
            }
        }
    });

}(Steward));
