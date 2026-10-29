/*
 * Default settings for the adventures module.
 *
 * Stored under steward.adventures. Shape:
 *
 *   {
 *     lastDir: ''
 *   }
 *
 * `lastDir` is the folder the battle-file picker last opened from, so the
 * next pick starts there.
 *
 * Run templates are not settings: each one is its own JSON file under the
 * steward folder (see templates.js), so they can be shared and survive a
 * profile switch. This key is the only module setting. It is a scalar that is
 * only ever overwritten, never removed, so the host's merging write is
 * correct for it.
 *
 * Older versions also stored a module-wide default horseshoe. That stored
 * key is ignored without any migration, because only keys present in these
 * defaults are read.
 *
 * There is no `enabled` key: nothing in this module runs on the scheduler
 * tick yet, so there is nothing to switch on or off.
 */

(function (S) {

    if (!S.modules.adventures) S.modules.adventures = {};

    S.modules.adventures.defaultSettings = {
        lastDir: ''
    };

}(Steward));
