/*
 * Diagnostics module.
 *
 * Read-only. Renders on the Settings screen as a "Diagnostics"
 * section with one-shot probes: each row is a description + Run button
 * that dumps kernel/host/specialist state to the standard logger.
 *
 * Never enqueues queue work. Never calls SendServerAction. Safe to leave
 * registered in production.
 *
 * Output goes to category 'diag' in the standard log file.
 */

(function (S) {

    if (!S.modules.diagnostics) S.modules.diagnostics = {};

    function isReady() { return false; }    // diagnostics never enqueues — only the buttons do
    function plan()    { /* no-op */ }
    function boot()    { /* nothing — the dashboard reads ui.section.render directly */ }

    S.kernel.register({
        id:       'diagnostics',
        priority: S.Priority.Idle,
        boot:     boot,
        isReady:  isReady,
        plan:     plan,
        // Late-binding refs — see collect/module.js for why.
        ui: {
            tab: 'misc',
            section: {
                id:    'diagnostics',
                title: 'Diagnostics',
                icon:  '⚙',
                render: function ($body, h) {
                    if (S.modules.diagnostics.renderSection) {
                        return S.modules.diagnostics.renderSection($body, h);
                    }
                },
                summary: function () {
                    return S.modules.diagnostics.summary
                        ? S.modules.diagnostics.summary()
                        : '';
                }
            }
        }
    });

}(Steward));
