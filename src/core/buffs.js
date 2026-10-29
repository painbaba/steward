/*
 * Buff inventory (read-only).
 *
 * Reads the star-menu buff stock (including adventure maps) and the buff
 * definitions. Applying buffs comes later; mining's buff phase waits on this
 * file.
 */

(function (S) {

    // The only place the speed-buff name prefix exists.
    var SPEED_BUFF_PREFIX = 'GeneralSpeedBuff_';

    // Star-menu type of adventure maps; the entry's resource is the adventure
    // name. The only place this type name exists.
    var ADVENTURE_MAP_TYPE = 'Adventure';

    function inventory() {
        var out = [];
        try {
            var vec = game.gi.mCurrentPlayer.getAvailableBuffs_vector();
            var n = vec ? vec.length : 0;
            for (var i = 0; i < n; i++) {
                var b = vec[i];
                var entry = { type: '', resource: '', amount: 0, uid: '' };
                try { entry.type = b.GetType(); } catch (e1) { /* leave default */ }
                try { entry.resource = b.GetResourceName_string(); } catch (e2) { /* leave default */ }
                try { entry.amount = b.amount; } catch (e3) { /* leave default */ }
                try { entry.uid = b.GetUniqueId().toKeyString(); } catch (e4) { /* leave default */ }
                out.push(entry);
            }
        } catch (e) {
            S.kernel.warn('buffs', 'inventory() threw:', e);
        }
        return out;
    }

    // Plain buffs only: entries bound to a resource are a different stock.
    function amount(type) {
        var inv = inventory();
        var sum = 0;
        for (var i = 0; i < inv.length; i++) {
            if (inv[i].type === type && !inv[i].resource) sum += (inv[i].amount || 0);
        }
        return sum;
    }

    // Adventure maps per adventure name. Runs on the menu's status tick, so
    // it stays silent while the game is not loaded.
    function mapCounts() {
        try {
            if (typeof game === 'undefined' || !game.gi || !game.gi.mCurrentPlayer) return {};
        } catch (e) {
            return {};
        }
        var out = {};
        var inv = inventory();
        for (var i = 0; i < inv.length; i++) {
            if (inv[i].type !== ADVENTURE_MAP_TYPE || !inv[i].resource) continue;
            var name = inv[i].resource;
            out[name] = (out[name] || 0) + (inv[i].amount || 0);
        }
        return out;
    }

    function definedNames(prefix) {
        var out = [];
        try {
            var map = game.def('global').map_BuffName_BuffDefinition;
            if (map) {
                for (var k in map) {
                    if (typeof k === 'string' && k.indexOf(prefix) === 0) out.push(k);
                }
            }
        } catch (e) { /* not enumerable */ }
        return out;
    }

    function isSpeedBuff(name) {
        return typeof name === 'string' && name.indexOf(SPEED_BUFF_PREFIX) === 0;
    }

    function effectText(name) {
        var t = S.core.locale.text('DES', name);
        var cut = t.indexOf('Target');
        if (cut !== -1) t = t.substring(0, cut);
        return t.replace(/^\s+|\s+$/g, '');
    }

    function speedBuffs() {
        var names = definedNames(SPEED_BUFF_PREFIX);
        var inv = inventory();
        var i;
        for (i = 0; i < inv.length; i++) {
            if (isSpeedBuff(inv[i].type) && names.indexOf(inv[i].type) === -1) names.push(inv[i].type);
        }
        names.sort();
        var out = [];
        for (i = 0; i < names.length; i++) {
            out.push({
                name:   names[i],
                amount: amount(names[i]),
                label:  S.core.locale.res(names[i]),
                effect: effectText(names[i])
            });
        }
        return out;
    }

    S.core.buffs = {
        SPEED_BUFF_PREFIX: SPEED_BUFF_PREFIX,
        inventory:     inventory,
        amount:        amount,
        mapCounts:     mapCounts,
        definedNames:  definedNames,
        isSpeedBuff:   isSpeedBuff,
        effectText:    effectText,
        speedBuffs:    speedBuffs
    };

}(Steward));
