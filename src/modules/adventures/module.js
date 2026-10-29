/*
 * Adventures module.
 *
 * Read-only phase. The user builds run templates (attack adventure, a
 * loadout battle file, ordered wave battle files, a horseshoe choice) and
 * gets a dry-run report per template that checks the files against the
 * current army. Nothing is sent: no packet, no task, no buff, and the
 * module never enqueues queue work.
 *
 * The templates live in their own dialog, opened from the native ~Steward~
 * menu, rather than in a dashboard tab: building a template needs a file
 * picker, a wave list and a report that do not fit a tab section.
 */

(function (S) {

    if (!S.modules.adventures) S.modules.adventures = {};

    function isReady() { return false; }    // nothing runs on the tick yet
    function plan()    { /* no-op */ }

    // Seed defaults eagerly so the first read already returns both keys.
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
            items: [
                {
                    label: 'Run templates…',
                    onSelect: function () {
                        // Late-bound: dialog.js loads before this file, but
                        // a script reload may replace it.
                        if (S.modules.adventures.dialog) {
                            S.modules.adventures.dialog.open();
                        }
                    }
                }
            ]
        }
    });

}(Steward));
