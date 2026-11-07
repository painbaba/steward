/*
 * Default settings for the explorers module.
 *
 * Stores per-explorer task assignments under steward.explorers.
 * The shape is:
 *
 *   {
 *     enabled:       true,
 *     overrides:     { '<explorer name>': 'TaskExplorerShort', ... },
 *     dispatchDelay: 1500      // ms between queued sends
 *   }
 *
 * Naming the override map by explorer NAME (not by GetType) is intentional:
 *   - The host's mainSettings.explDefTaskByType uses GetType keys, but
 *     names are friendlier for users editing settings.json by hand.
 *   - core/specialists.pickTask already consults the host's by-type map
 *     as the first precedence step. This module's by-name overrides are
 *     applied AFTER pickTask returns, before dispatch. So a user can
 *     either set defaults globally via the host's UI or override
 *     per-explorer here.
 */

(function (S) {

    if (!S.modules.explorers) S.modules.explorers = {};

    S.modules.explorers.defaultSettings = {
        enabled:       false,        // off by default — must be explicitly turned on
        overrides:     {},           // { 'Snowy Explorer': 'TaskExplorerShort', ... }
        // Delay between dispatch actions. Match the kernel's default queue
        // gap so a roster of 300 explorers takes ~7-8 minutes rather than
        // 25. The kernel still pace-protects against server flooding.
        dispatchDelay: 1500,
        // When a treasure event is in its `_Content` phase, force every
        // owned explorer onto a treasure dispatch — including ones whose
        // trait would otherwise lean toward adventure (Royal, Love Struck,
        // Keener, Nora). Implementation in core/specialists.biasFromTrait
        // adds a large constant to the treasure score; nothing about the
        // host's trait/skill objects is mutated. Off → trait bias picks
        // the family even during events.
        forceTreasureOnEvents: true,
        // Default dispatch task for explorers that don't have a per-type
        // trait recommending something specific (vanilla Explorer,
        // Experienced Explorer, off-event Fluffy Butte). Stored as an
        // ExplorerTask enum value (see kernel/15_enums.js). Null falls
        // back to ExplorerTask.Prolonged (the "rule of thumb: longer is
        // better off-event" baseline). Honours all subtask choices —
        // treasure or adventure — so users can route vanilla explorers
        // to adventures if they prefer.
        defaultTask: null
    };

}(Steward));
