/*
 * Adventures module.
 *
 * The user builds run templates (attack adventure, a loadout battle file,
 * ordered wave battle files, a horseshoe choice), validated when saved. The
 * menu lists the templates with their map counts and starts a run: with the
 * adventure open and viewed, the wave executor takes every wave file of the
 * template from the chosen start wave on (position, supply, load, verify,
 * reach, attack, confirm), and a quest watcher claims finished quests except
 * the last. Any failed check pauses the run with the wave, general and
 * reason; Resume re-enters the gate of that wave, so no wave is skipped. The
 * run state lives in its own steward file (state.js), so a script reload or
 * client restart picks it up again without sending an attack twice. When the
 * last wave is confirmed the run ends and the user finishes the map by hand.
 *
 * The executor only acts while the run's adventure is the viewed zone. On
 * any other zone isReady is false: nothing is sent and nothing pauses, and
 * the run carries on when the user views the map again.
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

    // Late-bound: state.js loads after this file in name order, and a script
    // reload may replace any part.
    function currentRun() {
        var st = S.modules.adventures.state;
        return st ? st.run() : null;
    }

    function isReady(ctx) {
        var run = currentRun();
        if (!run || run.status !== S.RunStatus.Running) return false;
        if (!ctx || !ctx.zone) return false;
        return ctx.zone.id === run.zoneId;
    }

    // The watcher runs first so a finished quest is claimed before the
    // executor's Settle step asks whether the island has settled. Each part
    // is guarded on its own: a watcher fault must not stall the waves.
    function plan() {
        var a = S.modules.adventures;
        if (a.watcher) {
            try { a.watcher.plan(); }
            catch (e) { S.kernel.error('adventures', 'watcher.plan threw:', e); }
        }
        if (a.executor) {
            try { a.executor.plan(); }
            catch (e) { S.kernel.error('adventures', 'executor.plan threw:', e); }
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
        menu: {
            title: 'Adventures',
            // Late-bound: menu.js loads before this file, but a script
            // reload may replace it.
            items: function () {
                return S.modules.adventures.menu ? S.modules.adventures.menu.items() : [];
            }
        }
    });

}(Steward));
