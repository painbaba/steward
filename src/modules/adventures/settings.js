/*
 * Default settings for the adventures module.
 *
 * Stored under steward.adventures. Shape:
 *
 *   {
 *     defaultSpeedBuff: <speed-buff prefix> + 'Bronze',
 *     lastDir: ''
 *   }
 *
 * `defaultSpeedBuff` is the horseshoe a template uses when its own choice
 * is "Default". It is a speed-buff name (S.core.buffs.SPEED_BUFF_PREFIX)
 * or S.SpeedBuffChoice.None. Core loads before modules, so the prefix is
 * there when these defaults are assigned.
 * Bronze matches the user's autoTSO setting. It is stored per game profile,
 * which suits a value that depends on the profile's stock.
 *
 * `lastDir` is the folder the battle-file picker last opened from, so the
 * next pick starts there.
 *
 * Run templates are not settings: each one is its own JSON file under the
 * steward folder (see templates.js), so they can be shared and survive a
 * profile switch. These two keys are the only module settings. Both are
 * scalars that are only ever overwritten, never removed, so the host's
 * merging write is correct for them.
 *
 * There is no `enabled` key: nothing in this module runs on the scheduler
 * tick yet, so there is nothing to switch on or off.
 */

(function (S) {

    if (!S.modules.adventures) S.modules.adventures = {};

    S.modules.adventures.defaultSettings = {
        defaultSpeedBuff: S.core.buffs.SPEED_BUFF_PREFIX + 'Bronze',
        lastDir: ''
    };

}(Steward));
