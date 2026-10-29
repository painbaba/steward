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
 * The run request and the running wave executor's state are not settings
 * either: they live in their own steward file (see state.js), written whole
 * on every change, because the host's merging write would keep stale keys of
 * a shrinking object.
 *
 * There is no `enabled` key: the executor only acts while the user has
 * started a run, and Pause and Stop in the menu switch it off.
 */

(function (S) {

    if (!S.modules.adventures) S.modules.adventures = {};

    S.modules.adventures.defaultSettings = {
        lastDir: ''
    };

}(Steward));
