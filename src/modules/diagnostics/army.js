/*
 * Army and adventure probes.
 *
 * Read-only dumps of what an adventure attack needs to know before anything
 * is ever sent: each own general's task and squads, the free troop pool, the
 * quest pool, the active adventures and the adventure, buff and unit
 * definitions. Every line goes to the standard log so the open questions
 * (is an injury a task, does a raise reuse the general's own troops, can the
 * definition maps be enumerated) can be settled from a pasted log.
 *
 * Never enqueues queue work. Never sends a packet, sets a task or applies a
 * buff.
 *
 * The sampler is the one timer a module owns. Module timers are otherwise
 * forbidden because nothing stops them when the scripts are reloaded. This
 * one is allowed because it is bounded (SAMPLE_COUNT ticks), read-only (log
 * lines only) and stops itself on reload: it remembers the lifecycle object
 * that was current when it started, and every bundle load assigns a new
 * one, so a tick that finds a different lifecycle neither dumps nor
 * re-arms. The scheduler cannot drive it, because it has to sample while
 * the scheduler is paused or idle, at a cadence that is not a tick.
 *
 * Loads before inspect.js, so every inspect helper is read at call time.
 */

(function (S) {

    if (!S.modules.diagnostics) S.modules.diagnostics = {};

    var SAMPLE_MS    = 5000;
    var SAMPLE_COUNT = 36;      // 3 min at SAMPLE_MS

    // Getters read on the general and, where the host keeps them there, on
    // its army object.
    var SPEC_GETTERS = ['IsInUse', 'GetGeneralState', 'GetGarrisonGridIdx', 'isTravellingAway'];
    var ARMY_GETTERS = ['GetMaxMilitaryUnits', 'HasEliteUnits', 'GetUnitsCount'];

    function notify(text) {
        try { if (typeof showGameAlert === 'function') showGameAlert('Steward: ' + text); }
        catch (e) { /* best effort */ }
    }

    function insp() { return S.modules.diagnostics.inspect; }

    function fmt(v) { return insp().shortValue(v); }

    // Host vectors: toArray when the host offers it, else an index walk.
    function list(vec) {
        var out = [];
        if (!vec) return out;
        try {
            if (typeof vec.toArray === 'function') {
                var arr = vec.toArray();
                if (arr && typeof arr.length === 'number') vec = arr;
            }
        } catch (e) { /* fall back to the index walk */ }
        var n = (typeof vec.length === 'number') ? vec.length : 0;
        for (var i = 0; i < n; i++) out.push(vec[i]);
        return out;
    }

    // "name=value" for each getter the object has; absent getters are left out.
    function probe(obj, names, prefix) {
        var parts = [];
        if (!obj) return parts;
        for (var i = 0; i < names.length; i++) {
            var rv = insp().callerOf(obj, names[i]);
            if (rv === null) continue;
            parts.push((prefix || '') + names[i] + '=' + rv);
        }
        return parts;
    }

    function json(map) {
        try { return JSON.stringify(map); }
        catch (e) { return '[unprintable]'; }
    }

    function has(obj, key) {
        return Object.prototype.hasOwnProperty.call(obj, key);
    }

    // ---------------------------------------------------------------
    // Generals
    // ---------------------------------------------------------------

    function squadLines(army, cat) {
        if (!army) {
            S.kernel.log(cat, '    army: none');
            return;
        }
        try {
            if (typeof army.GetSquads_vector === 'function') {
                var a = list(army.GetSquads_vector());
                var pa = [];
                for (var i = 0; i < a.length; i++) {
                    try { pa.push(a[i].GetType() + ' x' + fmt(a[i].amount)); }
                    catch (e1) { pa.push('[threw: ' + e1 + ']'); }
                }
                S.kernel.log(cat, '    GetSquads_vector (' + a.length + '): ' + pa.join(', '));
            } else {
                S.kernel.log(cat, '    GetSquads_vector: absent');
            }
        } catch (e) { S.kernel.warn(cat, 'GetSquads_vector threw:', e); }

        try {
            if (typeof army.GetSquadsCollection_vector === 'function') {
                var b = list(army.GetSquadsCollection_vector());
                var pb = [];
                for (var j = 0; j < b.length; j++) pb.push(squadText(b[j]));
                S.kernel.log(cat, '    GetSquadsCollection_vector (' + b.length + '): ' + pb.join(', '));
            } else {
                S.kernel.log(cat, '    GetSquadsCollection_vector: absent');
            }
        } catch (e2) { S.kernel.warn(cat, 'GetSquadsCollection_vector threw:', e2); }

        try {
            if (typeof army.GetUnits_vector === 'function') {
                S.kernel.log(cat, '    GetUnits_vector length: ' + list(army.GetUnits_vector()).length);
            } else {
                S.kernel.log(cat, '    GetUnits_vector: absent');
            }
        } catch (e3) { S.kernel.warn(cat, 'GetUnits_vector threw:', e3); }
    }

    // "type x amount [cat=, elite=, prio=]" for one squad; the unit-base
    // getters are what the free-pool filter and the elite flag rely on.
    function squadText(sq) {
        if (!sq) return '(null)';
        var type = '?';
        var amt = '?';
        try { type = sq.GetType(); } catch (e1) { type = '[threw]'; }
        try { amt = (typeof sq.GetAmount === 'function') ? sq.GetAmount() : sq.amount; }
        catch (e2) { amt = '[threw]'; }
        var ub = null;
        try { if (typeof sq.GetUnitBase === 'function') ub = sq.GetUnitBase(); }
        catch (e3) { ub = null; }
        var extra = probe(ub, ['GetUnitCategory', 'GetIsElite', 'GetCombatPriority']);
        return type + ' x' + fmt(amt) + (extra.length ? ' [' + extra.join(' ') + ']' : '');
    }

    function generalLine(spec, cat) {
        var c = S.core.specialists;
        var parts = [];
        var army = null;
        try { parts.push('uid=' + c.uniqueIdKey(spec)); } catch (e1) { parts.push('uid=[threw]'); }
        try { parts.push('name=' + c.name(spec)); } catch (e2) { parts.push('name=[threw]'); }
        try { parts.push('class=' + c.classify(spec)); } catch (e3) { parts.push('class=[threw]'); }
        try { parts.push('status=' + c.status(spec)); } catch (e4) { parts.push('status=[threw]'); }
        try { parts.push('troopCapacity=' + c.troopCapacity(spec)); } catch (e5) { parts.push('troopCapacity=[threw]'); }
        parts = parts.concat(probe(spec, SPEC_GETTERS));
        try { if (typeof spec.GetArmy === 'function') army = spec.GetArmy(); }
        catch (e6) { S.kernel.warn(cat, 'GetArmy threw:', e6); }
        parts = parts.concat(probe(spec, ARMY_GETTERS));
        parts = parts.concat(probe(army, ARMY_GETTERS, 'army.'));
        S.kernel.log(cat, '  ' + parts.join(' '));

        try {
            var task = (typeof spec.GetTask === 'function') ? spec.GetTask() : null;
            if (task) {
                var tp = probe(task, insp().TASK_GETTERS);
                S.kernel.log(cat, '    task: ' + (tp.length ? tp.join(' ') : '(no known getters)'));
            } else {
                S.kernel.log(cat, '    task: none');
            }
        } catch (e7) { S.kernel.warn(cat, 'task probe threw:', e7); }

        squadLines(army, cat);
        S.kernel.log(cat, '    core.army.generalArmy: ' + json(S.core.army.generalArmy(spec)));
    }

    // note: extra header text, such as the sample number.
    function dumpGenerals(cat, note) {
        cat = cat || 'diag:army';
        var c = S.core.specialists;
        var src = [];
        try { src = c.generals().concat(c.carriers()); }
        catch (e) { S.kernel.error(cat, 'listing generals threw:', e); }
        var own = [];
        var foreign = 0;
        for (var i = 0; i < src.length; i++) {
            if (S.core.army.isOwn(src[i])) own.push(src[i]);
            else foreign++;
        }
        S.kernel.log(cat, '--- generals' + (note ? ' ' + note : '') + ': ' + own.length + ' own' +
                          (foreign ? ', ' + foreign + ' foreign skipped' : '') + ' ---');
        for (var k = 0; k < own.length; k++) {
            try { generalLine(own[k], cat); }
            catch (e2) { S.kernel.error(cat, 'general ' + k + ' threw:', e2); }
        }
        S.kernel.log(cat, '--- end generals ---');
        if (cat !== 'diag:sample') notify('Generals dumped to log (category ' + cat + ').');
    }

    // ---------------------------------------------------------------
    // Free army, inventory, unit catalogue
    // ---------------------------------------------------------------

    function dumpArmy() {
        var cat = 'diag:army';
        S.kernel.log(cat, '--- army ---');
        try {
            var army = null;
            if (typeof game !== 'undefined' && game && game.zone && typeof game.zone.GetArmy === 'function') {
                army = game.zone.GetArmy(S.core.zone.playerId());
            }
            if (!army) {
                S.kernel.log(cat, 'zone army: unavailable');
            } else {
                var vec = (typeof army.GetSquadsCollection_vector === 'function')
                    ? army.GetSquadsCollection_vector() : army.GetSquads_vector();
                var sq = list(vec);
                S.kernel.log(cat, 'zone army squads (no category filter): ' + sq.length);
                for (var i = 0; i < sq.length; i++) {
                    try { S.kernel.log(cat, '  ' + squadText(sq[i])); }
                    catch (e1) { S.kernel.warn(cat, 'squad ' + i + ' threw:', e1); }
                }
            }
        } catch (e) { S.kernel.error(cat, 'zone army dump threw:', e); }

        try {
            var inv = S.core.army.inventory();
            S.kernel.log(cat, 'inventory free:     ' + json(inv.free));
            S.kernel.log(cat, 'inventory assigned: ' + json(inv.assigned));
            S.kernel.log(cat, 'inventory total:    ' + json(inv.total));
            var types = [];
            var k;
            for (k in inv.total) if (has(inv.total, k)) types.push(k);
            for (k in inv.free) if (has(inv.free, k) && types.indexOf(k) === -1) types.push(k);
            for (k in inv.assigned) if (has(inv.assigned, k) && types.indexOf(k) === -1) types.push(k);
            types.sort();
            for (var t = 0; t < types.length; t++) {
                var ty = types[t];
                var f = inv.free[ty] || 0;
                var a = inv.assigned[ty] || 0;
                var tot = inv.total[ty] || 0;
                S.kernel.log(cat, '  check ' + ty + ': ' + f + ' + ' + a + ' == ' + tot +
                                  (f + a === tot ? ' ok' : ' MISMATCH'));
            }
        } catch (e2) { S.kernel.error(cat, 'inventory dump threw:', e2); }

        try {
            var defs = game.def('MilitarySystem::cMilitaryUnitBase');
            if (!defs || typeof defs.GetAllUnit !== 'function') {
                S.kernel.log(cat, 'unit catalogue: unavailable');
            } else {
                var units = list(defs.GetAllUnit(1));
                S.kernel.log(cat, 'unit catalogue: ' + units.length);
                for (var u = 0; u < units.length; u++) {
                    try {
                        var parts = probe(units[u], ['GetType', 'GetIsElite', 'GetUnitCategory']);
                        S.kernel.log(cat, '  ' + parts.join(' '));
                    } catch (e3) { S.kernel.warn(cat, 'unit ' + u + ' threw:', e3); }
                }
            }
        } catch (e4) { S.kernel.error(cat, 'unit catalogue dump threw:', e4); }

        S.kernel.log(cat, '--- end army ---');
        notify('Army dumped to log (category ' + cat + ').');
    }

    // ---------------------------------------------------------------
    // Quests and active adventures
    // ---------------------------------------------------------------

    function dumpQuests() {
        var cat = 'diag:quest';
        S.kernel.log(cat, '--- quests on this zone ---');
        try {
            var pool = game.quests.GetQuestPool();
            var qs = list(pool.GetQuest_vector());
            S.kernel.log(cat, 'quests: ' + qs.length);
            for (var i = 0; i < qs.length; i++) {
                try {
                    var q = qs[i];
                    var parts = probe(q, ['getQuestName_string', 'GetUniqueId', 'isFinished',
                                          'IsQuestActive', 'IsRunning']);
                    var special = '?';
                    try { special = fmt(q.GetQuestDefinition().specialType_string); }
                    catch (e1) { special = '[threw]'; }
                    parts.push('specialType=' + special);
                    S.kernel.log(cat, '  ' + parts.join(' '));
                } catch (e2) { S.kernel.warn(cat, 'quest ' + i + ' threw:', e2); }
            }
        } catch (e) { S.kernel.error(cat, 'quest pool unavailable:', e); }
        S.kernel.log(cat, '--- end quests ---');
        notify('Quests dumped to log (category ' + cat + ').');
    }

    function dumpAdventures() {
        var cat = 'diag:adv';
        S.kernel.log(cat, '--- active adventures ---');
        try {
            S.kernel.log(cat, 'zone id=' + fmt(S.core.zone.id()) +
                              ' adventureName=' + fmt(S.core.zone.adventureName()));
        } catch (e0) { S.kernel.warn(cat, 'zone probe threw:', e0); }
        try {
            var mgr = game.def('com.bluebyte.tso.adventure.logic::AdventureManager').getInstance();
            var advs = list(mgr.getAdventures());
            S.kernel.log(cat, 'adventures: ' + advs.length);
            for (var i = 0; i < advs.length; i++) {
                try {
                    var adv = advs[i];
                    var mine = '?';
                    try { mine = fmt(mgr.isMyAdventure(adv)); } catch (e1) { mine = '[threw]'; }
                    S.kernel.log(cat, '  zoneID=' + fmt(adv.zoneID) + ' adventureName=' + fmt(adv.adventureName) +
                                      ' ownerPlayerID=' + fmt(adv.ownerPlayerID) + ' isMyAdventure=' + mine);
                } catch (e2) { S.kernel.warn(cat, 'adventure ' + i + ' threw:', e2); }
            }
        } catch (e) { S.kernel.error(cat, 'adventure manager unavailable:', e); }
        S.kernel.log(cat, '--- end adventures ---');
        notify('Active adventures dumped to log (category ' + cat + ').');
    }

    // ---------------------------------------------------------------
    // Definitions
    // ---------------------------------------------------------------

    // True when isSelectable rejects d only because of its type: the same
    // definition with an empty type passes. Asks the filter itself rather
    // than restating its rules.
    function hiddenByType(d) {
        var a = S.core.adventures;
        if (a.isSelectable(d)) return false;
        var copy = {};
        for (var k in d) if (has(d, k)) copy[k] = d[k];
        copy.type = '';
        return a.HIDDEN_TYPES.indexOf(d.type) !== -1 && a.isSelectable(copy);
    }

    function dumpAdventureDefinitions(cat) {
        try {
            var map = game.def('AdventureSystem::cAdventureDefinition').map_AdventureName_AdventureDefinition;
            var vsType = map ? typeof map.valueSet : 'no map';
            var vsLen = '?';
            if (map && typeof map.valueSet === 'function') {
                var vs = map.valueSet();
                vsLen = (vs && typeof vs.length === 'number') ? vs.length : fmt(vs);
            }
            S.kernel.log(cat, 'adventure map: typeof valueSet=' + vsType + ' length=' + vsLen);
        } catch (e) { S.kernel.warn(cat, 'adventure map probe threw:', e); }

        try {
            var defs = S.core.adventures.definitions();
            var byType = {};
            var types = [];
            var hidden = 0;
            for (var i = 0; i < defs.length; i++) {
                var ty = defs[i].type || '(none)';
                if (!has(byType, ty)) { byType[ty] = 0; types.push(ty); }
                byType[ty]++;
                if (hiddenByType(defs[i])) hidden++;
            }
            types.sort();
            var tp = [];
            for (var t = 0; t < types.length; t++) tp.push(types[t] + '=' + byType[types[t]]);
            S.kernel.log(cat, 'core.adventures.definitions: ' + defs.length);
            S.kernel.log(cat, '  types: ' + (tp.length ? tp.join(', ') : '(none)'));
            S.kernel.log(cat, '  rejected by HIDDEN_TYPES (' + S.core.adventures.HIDDEN_TYPES.join(', ') + '): ' + hidden);
            var n = Math.min(10, defs.length);
            for (var j = 0; j < n; j++) {
                var d = defs[j];
                S.kernel.log(cat, '  ' + d.name + ' type=' + d.type + ' campaign=' + d.campaign +
                                  ' difficulty=' + d.difficulty + ' requiresEvent=' + d.requiresEvent +
                                  ' selectable=' + S.core.adventures.isSelectable(d));
            }
        } catch (e2) { S.kernel.error(cat, 'adventure definitions dump threw:', e2); }
    }

    function buffType(map, name) {
        if (!map) return null;
        try {
            var def = map[name];
            if (def && typeof def.GetBuffType === 'function') return def.GetBuffType();
        } catch (e) { /* unreadable */ }
        return null;
    }

    function dumpBuffDefinitions(cat) {
        var b = S.core.buffs;
        var map = null;
        try { map = game.def('global').map_BuffName_BuffDefinition; }
        catch (e) { S.kernel.warn(cat, 'buff map unavailable:', e); }
        var count = 0;
        try { if (map) for (var k in map) if (typeof k === 'string') count++; }
        catch (e1) { S.kernel.warn(cat, 'buff map for-in threw:', e1); }
        S.kernel.log(cat, 'buff map: ' + (map ? 'for-in count=' + count : 'unavailable'));

        var speed = [];
        try { speed = b.definedNames(b.SPEED_BUFF_PREFIX); }
        catch (e2) { S.kernel.warn(cat, 'definedNames threw:', e2); }
        S.kernel.log(cat, 'speed buffs defined (' + b.SPEED_BUFF_PREFIX + '*): ' + speed.length);
        var speedTypes = [];
        for (var i = 0; i < speed.length; i++) {
            var bt = buffType(map, speed[i]);
            if (bt !== null && speedTypes.indexOf(bt) === -1) speedTypes.push(bt);
            var amt = '?';
            try { amt = b.amount(speed[i]); } catch (e3) { amt = '[threw]'; }
            S.kernel.log(cat, '  ' + speed[i] + ' GetBuffType=' + fmt(bt) + ' inventory=' + amt);
        }

        // Whether the horseshoes' buff type is theirs alone: list stock that
        // shares it under another name.
        S.kernel.log(cat, 'horseshoe buff type(s): ' + (speedTypes.length ? speedTypes.join(', ') : '(unknown)'));
        try {
            var inv = b.inventory();
            var shared = 0;
            for (var j = 0; j < inv.length; j++) {
                var name = inv[j].type;
                if (b.isSpeedBuff(name)) continue;
                var it = buffType(map, name);
                if (it === null || speedTypes.indexOf(it) === -1) continue;
                shared++;
                S.kernel.log(cat, '  same type, other name: ' + name + ' GetBuffType=' + fmt(it) +
                                  ' amount=' + inv[j].amount);
            }
            S.kernel.log(cat, '  inventory entries sharing the type: ' + shared);
        } catch (e4) { S.kernel.warn(cat, 'buff inventory probe threw:', e4); }
    }

    function dumpDefinitions() {
        var cat = 'diag:defs';
        S.kernel.log(cat, '--- adventure and buff definitions ---');
        dumpAdventureDefinitions(cat);
        dumpBuffDefinitions(cat);
        S.kernel.log(cat, '--- end definitions ---');
        notify('Definitions dumped to log (category ' + cat + ').');
    }

    // ---------------------------------------------------------------
    // Sampler
    // ---------------------------------------------------------------

    // The current run, or null. The run object is its own token: a tick
    // whose run is no longer current is a no-op, which covers a callback
    // that fires after a stop despite clearTimeout.
    var run = null;

    function arm(r) {
        try {
            r.handle = setTimeout(function () { tick(r); }, SAMPLE_MS);
        } catch (e) {
            if (run === r) run = null;
            S.kernel.error('diag', 'sampler could not arm its timer:', e);
        }
    }

    function tick(r) {
        // A reload has replaced the lifecycle: this closure belongs to the
        // old bundle, so it stops before dumping or re-arming.
        if (S.kernel.lifecycle !== r.owner) {
            if (run === r) {
                run = null;
                S.kernel.log('diag', 'sampler stopped: script reloaded');
            }
            return;
        }
        if (run !== r) return;
        r.count++;
        dumpGenerals('diag:sample', 'sample ' + r.count + '/' + SAMPLE_COUNT);
        if (r.count >= SAMPLE_COUNT) {
            run = null;
            S.kernel.log('diag', 'sampler finished after ' + SAMPLE_COUNT + ' samples');
            return;
        }
        arm(r);
    }

    // Starts the sampler when idle, stops it when running. Returns whether
    // it runs afterwards.
    function toggleSampler() {
        if (run) {
            var r = run;
            run = null;
            try { clearTimeout(r.handle); }
            catch (e) { S.kernel.warn('diag', 'sampler clearTimeout threw:', e); }
            S.kernel.log('diag', 'sampler stopped after ' + r.count + ' samples');
            notify('Generals sampler stopped.');
            return false;
        }
        run = { owner: S.kernel.lifecycle, count: 0, handle: null };
        S.kernel.log('diag', 'sampler started: every ' + (SAMPLE_MS / 1000) + ' s, ' +
                             SAMPLE_COUNT + ' samples (category diag:sample)');
        arm(run);
        if (run) notify('Generals sampler started.');
        return !!run;
    }

    function samplerRunning() { return run !== null; }

    S.modules.diagnostics.army = {
        dumpGenerals:    dumpGenerals,
        dumpArmy:        dumpArmy,
        dumpQuests:      dumpQuests,
        dumpAdventures:  dumpAdventures,
        dumpDefinitions: dumpDefinitions,
        toggleSampler:   toggleSampler,
        samplerRunning:  samplerRunning
    };

}(Steward));
