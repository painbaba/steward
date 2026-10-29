/*
 * Adventures module.
 *
 * Read-only phase. The user builds run templates (attack adventure, a
 * loadout battle file, ordered wave battle files, a horseshoe choice) and
 * gets a dry-run report per template that checks the files against the
 * current army. The menu lists the templates with their map counts and
 * stores a run request (count, end repetition); still nothing is sent: no
 * packet, no task, no buff, and the module never enqueues queue work.
 *
 * The templates live in their own dialog, opened from the native ~Steward~
 * menu, rather than in a dashboard tab: building a template needs a file
 * picker, a wave list and a report that do not fit a tab section.
 */

(function (S) {

    if (!S.modules.adventures) S.modules.adventures = {};

    function isReady() { return false; }    // nothing runs on the tick yet
    function plan()    { /* no-op */ }

    // Seed defaults eagerly so the first read already returns the setting.
    function boot() {
        if (!S.kernel.settings.read('adventures')) {
            S.kernel.settings.write('adventures', S.modules.adventures.defaultSettings);
        }
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
