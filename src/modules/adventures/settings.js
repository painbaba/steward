/*
 * Default settings for the adventures module.
 *
 * Stored under steward.adventures. Shape:
 *
 *   {
 *     lastDir:      '',
 *     stuckMinutes: 45
 *   }
 *
 * `lastDir` is the folder the battle-file picker last opened from, so the
 * next pick starts there.
 *
 * `stuckMinutes` is the stuck-step limit: a run step on the island that has
 * watched a wait this many minutes takes a zone trip home and back, which
 * makes the host refresh what it reports. 0 switches the trip off. It is
 * edited in the Adventures section of the Settings screen. `stuckMinutes()`
 * is the reader the trip uses.
 *
 * Run templates are not settings: each one is its own JSON file under the
 * steward folder (see templates.js), so they can be shared and survive a
 * profile switch. Both module settings are scalars that are only ever
 * overwritten, never removed, so the host's merging write is correct for
 * them. One known overlap: the Settings screen snapshots the adventures
 * buffer when it is first used, so a `lastDir` the template dialog writes
 * while that buffer is dirty is overwritten by Save; `lastDir` is only the
 * dialog's start folder, so this is accepted.
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
        lastDir:      '',
        stuckMinutes: 45
    };

    // A stored limit that is not a usable minute count falls back to the
    // default, so a hand-edited or missing value never disables the trip.
    function minutesOf(s) {
        var m = s ? s.stuckMinutes : undefined;
        if (typeof m === 'number' && isFinite(m) && m >= 0) return m;
        return S.modules.adventures.defaultSettings.stuckMinutes;
    }

    // Settings screen section. Reads and writes go through the shared
    // settings buffer, so Save and Discard on the screen cover this field.
    S.modules.adventures.renderSettings = function ($body, h) {
        var s = h.settings('adventures');

        $body.append(h.formRow('Stuck step limit (min)', h.input({
            type:     'number',
            value:    minutesOf(s),
            width:    '70px',
            onChange: function (val) {
                var n = parseInt(val, 10);
                if (!isNaN(n) && n >= 0) {
                    h.update('adventures', { stuckMinutes: n });
                }
            }
        }), 'a step on the island waiting this long goes home and back; 0 = off'));
    };

    // The stored stuck-step limit in minutes, read with the defaults filled in
    // (the defaults alone while templates.js is not loaded yet). The trip and
    // the Settings summary both read it here, so they never disagree.
    S.modules.adventures.stuckMinutes = function () {
        var a = S.modules.adventures;
        return minutesOf(a.templates && a.templates.settings ? a.templates.settings() : a.defaultSettings);
    };

    // Section summary, from the same limit the trip uses.
    S.modules.adventures.settingsSummary = function () {
        var m = S.modules.adventures.stuckMinutes();
        return m > 0 ? 'stuck limit ' + m + ' min' : 'stuck limit off';
    };

}(Steward));
