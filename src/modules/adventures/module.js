/*
 * Adventures module.
 *
 * The user builds run templates (attack adventure, a loadout battle file,
 * ordered wave battle files, a horseshoe choice), validated when saved. The
 * menu lists the templates with their map counts and starts a run, which is
 * one persisted series of maps from home back to home: at home the loadout
 * generals are mustered, the template is checked, the troops are
 * snapshotted and loaded, the map is started and the generals are sent; on
 * the island items are picked up (by the collect module, the run only waits
 * for it), the generals are starred and the horseshoe applied, the wave
 * executor takes every wave file (position, supply, load, verify, reach, attack,
 * confirm) while a quest watcher claims finished quests except the last;
 * after the last wave the end of map packs the free troops into carriers,
 * claims the last quest, closes the map and recalls whoever is left; back
 * home the lost troops are counted and retrained, and the next repetition
 * starts. Any failed check pauses the run with where it stands and why;
 * Resume re-enters that step (a wave step re-enters the gate of its wave),
 * so nothing is skipped. The run state lives in its own steward file
 * (state.js), so a script reload or client restart picks it up again
 * without sending an order twice. The run shows in its own ~Adventures~ bar
 * menu (runmenu.js) while it is Running or Paused.
 *
 * A run takes its next step as soon as the game allows: a pass that moved a
 * step or left queue work asks the scheduler for another at once, a short
 * wait polls every WAIT_MS, and a long wait stays on the scheduler tick.
 *
 * Each step names where it may run (home, the run's island, or anywhere),
 * and isReady is false on any other zone: nothing is sent and nothing
 * pauses, and the run carries on when the user views that zone again. One
 * log line marks the start and one the end of each such wait.
 *
 * A step on the island that has watched a wait for the stuckMinutes setting
 * takes a zone trip (resolve.js): home, a few minutes there, back, and the
 * step is entered again, because the client may hold a stale read of the
 * island. While the trip lasts it owns every pass and runs on any zone; after
 * a step pass, resolve.watch() feeds the watched-wait clock. The setting is
 * edited in the Adventures section of the Settings screen.
 *
 * Menu handlers only change state; all queue work is enqueued from plan(),
 * where the scheduler tags it with this module, so Pause and Stop can cancel
 * it by module.
 *
 * The templates live in their own dialog, opened from the native ~Steward~
 * menu, rather than in a dashboard tab: building a template needs a file
 * picker and a reorderable wave list that do not fit a tab section.
 */

(function (S) {

    if (!S.modules.adventures) S.modules.adventures = {};

    var WAIT_MS = 2000;   // next pass while a short wait polls the game

    // Late-bound: state.js loads after this file in name order, and a script
    // reload may replace any part.
    function currentRun() {
        var st = S.modules.adventures.state;
        return st ? st.run() : null;
    }

    // One log line when a Running run starts waiting for its zone and one when
    // it may act again, so a run that sends nothing says why.
    function isReady(ctx) {
        var state = S.modules.adventures.state;
        var run = currentRun();
        if (!run || run.status !== S.RunStatus.Running) {
            if (run) state.current().zoneWait = false;
            return false;
        }
        var ok = state.readyOn(run, ctx ? ctx.zone : null);
        var rs = state.current();
        if (!ok && rs.zoneWait !== true) {
            rs.zoneWait = true;
            S.kernel.log('adventures', state.label() + ': waiting for the right zone (' + state.viewHint(run) +
                '); nothing is sent');
        }
        if (ok && rs.zoneWait === true) {
            rs.zoneWait = false;
            S.kernel.log('adventures', state.label() + ': zone viewed again, run continues');
        }
        return ok;
    }

    // The next pass, sooner than the tick when there is something to do. One pass
    // stays one step, so each keeps its own turn and its own re-read of the game.
    // A stopped chain costs nothing: the next tick picks the run up again. since
    // counts too, because a step may re-enter itself with no queue work.
    function nextPass(before, step, since) {
        var r = currentRun();
        if (!r || r.status !== S.RunStatus.Running) return;
        var moved = r !== before || r.step !== step || r.since !== since;
        if (moved || S.kernel.queue.isModuleBusy('adventures')) S.kernel.scheduler.wake('adventures', 0);
        else if (!S.modules.adventures.state.waitsLong(r)) S.kernel.scheduler.wake('adventures', WAIT_MS);
    }

    // The watcher runs first so a finished quest is claimed before the
    // executor's Settle step asks whether the island has settled. Then the
    // part that owns the run's step (executor, home or away) does one step.
    // Each part is guarded on its own: a watcher fault must not stall the run.
    function plan() {
        var a = S.modules.adventures;
        if (a.watcher) {
            try { a.watcher.plan(); }
            catch (e) { S.kernel.error('adventures', 'watcher.plan threw:', e); }
        }
        var run = currentRun();
        if (!run || !a.state) return;
        var step = run.step;
        var since = run.since;
        // A zone trip under way owns the pass: the step neither acts nor
        // counts its wait until the trip has entered it again.
        if (run.resolve && run.status === S.RunStatus.Running && a.resolve) {
            a.state.passBegins();
            try { a.resolve.plan(); }
            catch (e) { S.kernel.error('adventures', 'resolve.plan threw:', e); }
            a.state.passEnds();
            nextPass(run, step, since);
            return;
        }
        var name = a.state.partOf(step);
        var part = name ? a[name] : null;
        if (part && part.plan) {
            // A pass that did not wait any more ended the wait.
            a.state.passBegins();
            part.plan();
            // The watched-wait clock reads whether this pass kept a wait
            // going, so it runs before the pass ends.
            if (a.resolve) {
                try { a.resolve.watch(); }
                catch (e2) { S.kernel.error('adventures', 'resolve.watch threw:', e2); }
            }
            a.state.passEnds();
            nextPass(run, step, since);
        }
    }

    // Seed defaults eagerly so the first read already returns the setting,
    // then pick up a persisted run (a fresh client has none in memory yet).
    function boot() {
        if (!S.kernel.settings.read('adventures')) {
            S.kernel.settings.write('adventures', S.modules.adventures.defaultSettings);
        }
        if (S.modules.adventures.state) S.modules.adventures.state.load();
    }

    S.kernel.register({
        id:       'adventures',
        priority: S.Priority.Idle,
        boot:     boot,
        isReady:  isReady,
        plan:     plan,
        // The module's settings on the Settings screen. The section id is the
        // module id, because it names the settings buffer. Late-bound:
        // settings.js loads after this file in name order.
        ui: {
            tab: 'misc',
            section: {
                id:    'adventures',
                title: 'Adventures',
                render: function ($body, h) {
                    if (S.modules.adventures.renderSettings) {
                        return S.modules.adventures.renderSettings($body, h);
                    }
                },
                summary: function () {
                    return S.modules.adventures.settingsSummary
                        ? S.modules.adventures.settingsSummary()
                        : '';
                }
            }
        },
        menu: {
            title: 'Adventures',
            // Late-bound: menu.js loads before this file, but a script
            // reload may replace it.
            items: function () {
                return S.modules.adventures.menu ? S.modules.adventures.menu.items() : [];
            }
        },
        barMenu: {
            title: '~Adventures~',
            // Late-bound for the same reason.
            items: function () {
                return S.modules.adventures.runmenu ? S.modules.adventures.runmenu.items() : [];
            },
            visible: function () {
                var m = S.modules.adventures.runmenu;
                return m ? m.visible() : false;
            }
        }
    });

}(Steward));
