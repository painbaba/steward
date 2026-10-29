/*
 * Dashboard surface for the diagnostics module.
 *
 * Renders inside the Tools tab. Each probe is a row with the description on
 * the left and a button on the right. All output goes through the standard
 * logger (category 'diag') so users can paste it back when reporting bugs.
 */

(function (S) {

    if (!S.modules.diagnostics) S.modules.diagnostics = {};

    function notify(text) {
        try { if (typeof showGameAlert === 'function') showGameAlert('Steward: ' + text); }
        catch (e) { /* best effort */ }
    }

    function dumpHostSnapshot() {
        var d = S.modules.diagnostics.inspect;
        S.kernel.log('diag', '--- host snapshot ---');
        try {
            if (S.kernel.host && S.kernel.host.snapshot) {
                var snap = S.kernel.host.snapshot();
                d.logLines('diag', d.describe(snap, 'Steward.kernel.host.snapshot()'));
            }
        } catch (e) { S.kernel.error('diag', 'host snapshot threw:', e); }

        try {
            if (typeof mainSettings !== 'undefined' && mainSettings) {
                d.logLines('diag', d.describe(mainSettings, 'mainSettings'));
            }
        } catch (e) { S.kernel.error('diag', 'mainSettings dump threw:', e); }

        try {
            if (typeof settings !== 'undefined' && settings && settings.settings) {
                S.kernel.log('diag', '--- host settings.settings keys ---');
                var keys = Object.keys(settings.settings).sort();
                for (var i = 0; i < keys.length; i++) {
                    var v = settings.settings[keys[i]];
                    var n = (v && typeof v === 'object') ? Object.keys(v).length : 0;
                    S.kernel.log('diag', '  ' + keys[i] + '  (' + n + ' field' + (n === 1 ? '' : 's') + ')');
                }
            }
        } catch (e) { S.kernel.error('diag', 'settings dump threw:', e); }

        S.kernel.log('diag', '--- live events ---');
        try {
            if (S.core.events && S.core.events.liveEventNames) {
                var raw = S.core.events.liveEventNames();
                S.kernel.log('diag', 'GetActiveEventNames:', raw.length ? raw.join(', ') : '(none)');
                var ev = S.core.events.active();
                if (ev.length === 0) {
                    S.kernel.log('diag', 'matched against Steward.core.events.data: (none)');
                } else {
                    for (var k = 0; k < ev.length; k++) {
                        var values = S.core.events.treasureValues(ev[k].code);
                        S.kernel.log('diag', '  matched:', ev[k].code,
                                     '— categories:', (ev[k].categoryList || []).join(',') || '(none)',
                                     '— treasureValues:',
                                     (values && values.length) ? values.join(',') : '(none)',
                                     '— rawNames:', (ev[k].rawNames || []).join(','));
                    }
                }
            }
        } catch (e) { S.kernel.error('diag', 'events dump threw:', e); }

        notify('Host snapshot dumped to log.');
    }

    function dumpKernelState() {
        S.kernel.log('diag', '--- kernel state ---');
        try {
            S.kernel.log('diag', 'paused:', S.kernel.ui && S.kernel.ui.isPaused ? S.kernel.ui.isPaused() : '?');
            S.kernel.log('diag', 'modules registered:', S.kernel.registry.count());
            var mods = S.kernel.registry.list();
            for (var i = 0; i < mods.length; i++) {
                var m = mods[i];
                S.kernel.log('diag', '  -', m.id, '(' + m.priority + ')',
                             m.experimental ? '[experimental]' : '',
                             'busy:', S.kernel.queue.isModuleBusy(m.id),
                             'depth:', S.kernel.queue.depthByModule(m.id));
            }
            S.kernel.log('diag', 'queue total depth:', S.kernel.queue.depth());
            S.kernel.log('diag', 'queue running:', S.kernel.queue.runningModule());
        } catch (e) { S.kernel.error('diag', 'kernel state dump threw:', e); }
        notify('Kernel state dumped to log.');
    }

    function inspectSpecialists() {
        var d = S.modules.diagnostics.inspect;
        var c = S.core.specialists;
        S.kernel.log('diag', '--- specialists on current zone ---');
        try {
            var all = c.all();
            S.kernel.log('diag', 'total:', all.length);

            var byTriple = {};
            var byRawType = {};
            var firstByRaw = {};
            for (var i = 0; i < all.length; i++) {
                var s = all[i];
                var raw = '?';
                try { raw = (typeof s.GetType === 'function') ? s.GetType() : '?'; } catch (e) { raw = 'threw'; }
                byRawType[raw] = (byRawType[raw] || 0) + 1;
                if (!firstByRaw[raw]) firstByRaw[raw] = s;
                var cls = c.classify(s);
                var st = c.status(s);
                var key = raw + '|' + cls + '|' + st;
                byTriple[key] = (byTriple[key] || 0) + 1;
            }

            S.kernel.log('diag', 'distribution by (GetType | classify | status):');
            var tripleKeys = Object.keys(byTriple).sort();
            for (var t = 0; t < tripleKeys.length; t++) {
                S.kernel.log('diag', '  ' + tripleKeys[t] + '  →  ' + byTriple[tripleKeys[t]]);
            }

            S.kernel.log('diag', '--- one specimen per GetType ---');
            var rawKeys = Object.keys(firstByRaw).sort(function (a, b) { return Number(a) - Number(b); });
            for (var r = 0; r < rawKeys.length; r++) {
                var rt = rawKeys[r];
                var spec = firstByRaw[rt];
                var cls2 = c.classify(spec);
                var st2 = c.status(spec);
                var nm = '';
                try { nm = c.name(spec); } catch (e) { nm = '(name threw)'; }
                d.logLines('diag', d.describe(spec,
                    'specialist GetType=' + rt + ' classify=' + cls2 +
                    ' status=' + st2 + ' name=' + (nm || '?')));

                try {
                    if (typeof spec.GetSpecialistDescription === 'function') {
                        var desc = spec.GetSpecialistDescription();
                        if (desc) {
                            d.logLines('diag', d.describe(desc, 'description for GetType=' + rt));
                        }
                    }
                } catch (e) { S.kernel.warn('diag', 'description dump threw:', e); }

                S.kernel.log('diag', '');
            }
        } catch (e) {
            S.kernel.error('diag', 'inspectSpecialists threw:', e);
        }
        notify('Specialist inspection dumped to log.');
    }

    function inspectCurrentZone() {
        var d = S.modules.diagnostics.inspect;
        S.kernel.log('diag', '--- current zone ---');
        try {
            var z = S.core.zone.current();
            d.logLines('diag', d.describe(z, 'mCurrentPlayerZone'));
        } catch (e) { S.kernel.error('diag', 'zone dump threw:', e); }
        notify('Zone dumped to log.');
    }

    // ---------------------------------------------------------------
    // Deep explorer dump — capped at MAX_TYPES_PER_DUMP unique GetTypes
    // per run. Surfaces every callable on the SpecialistDescription, plus
    // every skill in getSkillTree() and spec.skills with their full
    // level_vector effects. Output lands in the log under 'diag:expl'.
    //
    // Two fixes from the first iteration:
    //   1. Player-owned filter (getPlayerID() !== -1) — mirrors autoTSO at
    //      user_auto.js:6688 and tso_client/4-specialists.js:185.
    //      Without it the host's specialist vector hands us NPC / foreign
    //      entries that aren't real cSpecialist objects, and walking those
    //      via for..in returns surrounding scope objects (we ended up
    //      dumping the logger's local variables on the first pass).
    //   2. Effect-property probe by KNOWN names rather than for..in.
    //      AS3 effect / definition objects expose data through prototype
    //      getters that aren't enumerable, so for..in returns zero keys.
    //      Probing each candidate name directly catches them.
    // ---------------------------------------------------------------

    // Dump every player-owned unique GetType. Set to a positive integer to
    // cap (kept the variable in case the log gets unwieldy on a roster with
    // many types).
    var MAX_TYPES_PER_DUMP = 0; // 0 = no cap

    // Field names the host may put on effect / skill-definition objects.
    // Probing each by name dodges the for..in problem with AS3 getters.
    var EFFECT_PROP_NAMES = [
        'type_string', 'taskType_string', 'modifier_string',
        'multiplier', 'adder', 'value',
        'name_string', 'id', '_id',
        'duration', 'duration_int', 'cooldown', 'cooldown_int',
        'requiredLevel_int', 'requiredLevel',
        'chance', 'rarity'
    ];
    var SKILL_DEF_PROP_NAMES = [
        'name_string', 'id', '_id',
        'description_string', 'descriptionShort_string',
        'requiredLevel_int', 'maxLevel_int',
        'icon_string', 'iconID', 'iconID_int',
        'category_string', 'category_int', 'tier_int'
    ];

    // Try to invoke a host getter without args. Returns the formatted
    // value, or null if the call wasn't safe.
    function probeMethod(obj, name) {
        if (!obj || typeof obj[name] !== 'function') return null;
        var s = S.modules.diagnostics.inspect;
        try {
            return s.shortValue(obj[name]());
        } catch (e1) {
            // Some getters take exactly one argument — try with `false`.
            try { return s.shortValue(obj[name](false)); }
            catch (e2) { return '[threw: ' + e1 + ']'; }
        }
    }

    // Walk every property that's a function and try to invoke it. Logs
    // each successful return value. This is how we discover undocumented
    // SpecialistDescription methods (e.g. anything that might encode the
    // Princess bonus).
    function dumpAllCallables(obj, label, cat) {
        if (!obj) return;
        S.kernel.log(cat, '--- ' + label + ': callable methods ---');
        var keys = [];
        for (var k in obj) {
            if (k.charAt(0) === '_' && k.charAt(1) === '_') continue;
            try { if (typeof obj[k] !== 'function') continue; }
            catch (e) { continue; }
            keys.push(k);
        }
        keys.sort();
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            var rv = probeMethod(obj, key);
            if (rv === null) continue;
            S.kernel.log(cat, '  ' + key + '() ->', rv);
        }
    }

    // Probe a curated list of property names directly — AS3 getters aren't
    // enumerable so for..in returns nothing. Returns "k=v, k=v, ..." for
    // properties that returned a non-undefined / non-function value.
    function probeKnownProps(obj, names) {
        if (!obj) return '';
        var sv = S.modules.diagnostics.inspect.shortValue;
        var parts = [];
        for (var i = 0; i < names.length; i++) {
            var n = names[i];
            try {
                var v = obj[n];
                if (typeof v === 'undefined') continue;
                if (typeof v === 'function')  continue;
                parts.push(n + '=' + sv(v));
            } catch (e) { /* skip */ }
        }
        return parts.join(', ');
    }

    function dumpSkillEffects(effects, indent, cat) {
        if (!effects) return;
        var elen = (typeof effects.length === 'number') ? effects.length : 0;
        S.kernel.log(cat, indent + '(' + elen + ' effects)');
        for (var i = 0; i < elen; i++) {
            var eff = effects[i];
            if (!eff) {
                S.kernel.log(cat, indent + '  [' + i + '] (null)');
                continue;
            }
            var probed = probeKnownProps(eff, EFFECT_PROP_NAMES);
            S.kernel.log(cat, indent + '  [' + i + '] ' +
                (probed.length ? probed : '(no probed props matched)'));
        }
    }

    function dumpOneSkill(skill, label, cat) {
        if (!skill) {
            S.kernel.log(cat, '  ' + label + ' (null)');
            return;
        }
        var sid = '?', lvl = '?';
        try { if (typeof skill.getId === 'function') sid = skill.getId(); }
        catch (e) { sid = 'threw'; }
        try { if (typeof skill.getLevel === 'function') lvl = skill.getLevel(); }
        catch (e) { lvl = 'threw'; }

        S.kernel.log(cat, '  ' + label + ' id=' + sid + ' level=' + lvl);

        var def = null;
        try { if (typeof skill.getDefinition === 'function') def = skill.getDefinition(); }
        catch (e) { S.kernel.log(cat, '    (getDefinition threw: ' + e + ')'); }
        if (!def) return;

        // Definition shape — name / id / etc. via known names (AS3 getters
        // aren't enumerable so for..in misses them).
        var defLine = probeKnownProps(def, SKILL_DEF_PROP_NAMES);
        if (defLine) S.kernel.log(cat, '    def: ' + defLine);

        // Effects at the active level (level-1, like autoTSO does).
        try {
            if (def.level_vector && typeof lvl === 'number' && lvl > 0) {
                S.kernel.log(cat,
                    '    level_vector[' + (lvl - 1) + ']:');
                dumpSkillEffects(def.level_vector[lvl - 1], '      ', cat);
            } else if (def.level_vector) {
                // Skill not learned (level 0) — log first level's effects
                // so we still see what the skill *would* do.
                S.kernel.log(cat,
                    '    level_vector[0] (skill not learned):');
                dumpSkillEffects(def.level_vector[0], '      ', cat);
            }
        } catch (e) { S.kernel.log(cat, '    (level_vector probe threw: ' + e + ')'); }
    }

    function dumpSkillVector(spec, accessorName, label, cat) {
        try {
            var fn = spec[accessorName];
            if (typeof fn !== 'function') {
                // Some hosts expose `spec.skills` as a property holding a
                // skill collection rather than a method on the spec.
                if (accessorName === 'skills' && spec.skills &&
                    typeof spec.skills.getItems_vector === 'function') {
                    var v = spec.skills.getItems_vector();
                    var len = (typeof v.length === 'number') ? v.length : 0;
                    S.kernel.log(cat, '--- ' + label + ' (' + len + ' items) ---');
                    for (var x = 0; x < len; x++) {
                        dumpOneSkill(v[x], label + '[' + x + ']', cat);
                    }
                }
                return;
            }
            var holder = fn.call(spec);
            if (!holder || typeof holder.getItems_vector !== 'function') return;
            var items = holder.getItems_vector();
            var ilen = (typeof items.length === 'number') ? items.length : 0;
            S.kernel.log(cat, '--- ' + label + ' (' + ilen + ' items) ---');
            for (var i = 0; i < ilen; i++) {
                dumpOneSkill(items[i], label + '[' + i + ']', cat);
            }
        } catch (e) {
            S.kernel.log(cat, '(' + label + ' threw: ' + e + ')');
        }
    }

    // ctx = { cat, label, header } — log category, family display label
    // ('Explorer' / 'Geologist'), and the per-instance header line which
    // includes uniqueID since we no longer dedup by GetType.
    function dumpSpecInstance(spec, typeNum, ctx) {
        var c = S.core.specialists;
        var d = S.modules.diagnostics.inspect;
        var name = '?';
        try { name = c.name ? c.name(spec) : '?'; }
        catch (e) { /* ignore */ }
        // Strip the host's HTML wrappers in display names so the log is readable.
        var cleanName = (typeof name === 'string')
            ? name.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '')
            : String(name);

        S.kernel.log(ctx.cat, '');
        S.kernel.log(ctx.cat, '====== ' + ctx.label + ' GetType=' + typeNum +
                              ' (' + cleanName + ')' +
                              (ctx.header ? ' ' + ctx.header : '') + ' ======');

        // 1. Top-level spec — gives us the basics + any direct properties.
        d.logLines(ctx.cat, d.describe(spec, 'spec (GetType=' + typeNum + ')'));

        // 2. SpecialistDescription, including ALL callables. Encodes per-type
        //    bonuses (e.g. the Princess time bonus on explorers).
        try {
            if (typeof spec.GetSpecialistDescription === 'function') {
                var desc = spec.GetSpecialistDescription();
                if (desc) {
                    d.logLines(ctx.cat, d.describe(desc, 'description'));
                    dumpAllCallables(desc, 'description', ctx.cat);
                }
            }
        } catch (e) {
            S.kernel.error(ctx.cat, 'description probe threw:', e);
        }

        // 3. Skill tree — permanent, learned skills.
        dumpSkillVector(spec, 'getSkillTree', 'skillTree', ctx.cat);

        // 4. Dynamic skills — from equipment / buffs / specials.
        dumpSkillVector(spec, 'skills', 'spec.skills', ctx.cat);

        S.kernel.log(ctx.cat, '');
    }

    // True when a spec belongs to the player (not an NPC / foreign ghost).
    // autoTSO uses the same predicate at user_auto.js / 4-specialists.js:185.
    // The host's specialist vector contains entries that aren't real
    // cSpecialist objects for non-player slots; without filtering them out
    // the deep dump trips over surrounding scope objects.
    function ownedByPlayer(spec) {
        try {
            if (typeof spec.getPlayerID === 'function') {
                return spec.getPlayerID() !== -1;
            }
        } catch (e) { /* fall through */ }
        return false;
    }

    // Generic deep-dump for a specialist family. Dumps EVERY player-owned
    // specialist of that family on the current zone — no per-GetType
    // dedup, no status filter (idle, working, traveling, returning all
    // included). For trait analysis we need to see active specimens too,
    // and per-instance skill-tree levels can vary across copies of the
    // same GetType.
    function deepInspectFamily(family) {
        var c = S.core.specialists;
        if (!c) return notify('core.specialists not ready.');

        var listFn, cat, label;
        if (family === 'explorer') {
            listFn = c.explorers; cat = 'diag:expl'; label = 'Explorer';
        } else if (family === 'geologist') {
            listFn = c.geologists; cat = 'diag:geo'; label = 'Geologist';
        } else {
            return notify('Unknown family: ' + family);
        }
        if (!listFn) return notify('core.specialists.' + family + 's() unavailable.');

        var specs;
        try { specs = listFn.call(c); }
        catch (e) {
            S.kernel.error(cat, family + 's() threw:', e);
            return notify('Could not list ' + family + 's — see log.');
        }
        if (!specs || !specs.length) {
            return notify('No ' + family + 's on the current zone.');
        }

        // Filter to player-owned. Sort by GetType so same-type specimens
        // group together in the log.
        var owned = [];
        var skippedForeign = 0;
        for (var i = 0; i < specs.length; i++) {
            var s = specs[i];
            if (!ownedByPlayer(s)) { skippedForeign++; continue; }
            owned.push(s);
        }
        owned.sort(function (a, b) {
            var ta = -1, tb = -1;
            try { if (typeof a.GetType === 'function') ta = a.GetType(); } catch (e) { /* skip */ }
            try { if (typeof b.GetType === 'function') tb = b.GetType(); } catch (e) { /* skip */ }
            return ta - tb;
        });

        // Apply the cap (if any) to keep the log manageable.
        var capped = (MAX_TYPES_PER_DUMP > 0)
            ? owned.slice(0, MAX_TYPES_PER_DUMP)
            : owned;
        var more = owned.length - capped.length;

        S.kernel.log(cat, '########################################################');
        S.kernel.log(cat, '## Deep ' + family + ' dump — ' + owned.length +
                          ' player-owned ' + family + '(s)' +
                          (skippedForeign ? ' (' + skippedForeign + ' foreign skipped)' : '') +
                          ', dumping ' + capped.length);
        if (more > 0) {
            S.kernel.log(cat, '## (' + more + ' additional ' + family + '(s) skipped by cap)');
        }
        S.kernel.log(cat, '########################################################');

        for (var k = 0; k < capped.length; k++) {
            var spec = capped[k];
            var t = -1;
            try { if (typeof spec.GetType === 'function') t = spec.GetType(); }
            catch (e) { /* skip */ }
            var uid = c.uniqueIdKey(spec);
            var status = '';
            try { status = c.status(spec); } catch (e) { status = ''; }
            var header = '[' + (k + 1) + '/' + capped.length + ']' +
                         (uid ? ' uid=' + uid : '') +
                         (status ? ' ' + status : '');
            dumpSpecInstance(spec, t, { cat: cat, label: label, header: header });
        }

        S.kernel.log(cat, '## end deep ' + family + ' dump');
        notify('Deep ' + family + ' dump for ' + capped.length +
               ' specialist(s) written to log (category ' + cat + ').');
    }

    function deepInspectExplorerTypes()  { return deepInspectFamily('explorer'); }
    function deepInspectGeologistTypes() { return deepInspectFamily('geologist'); }

    // ---------------------------------------------------------------

    function summary() { return 'read-only probes'; }

    function renderSection($rows, h) {
        $rows.append(h.formRow('Inspect specialists on current zone',
            h.button('Run', { onClick: inspectSpecialists })));
        $rows.append(h.formRow('Deep dump explorers (every owned, all states)',
            h.button('Run', { onClick: deepInspectExplorerTypes })));
        $rows.append(h.formRow('Deep dump geologists (every owned, all states)',
            h.button('Run', { onClick: deepInspectGeologistTypes })));
        $rows.append(h.formRow('Inspect current zone',
            h.button('Run', { onClick: inspectCurrentZone })));
        $rows.append(h.formRow('Dump host snapshot',
            h.button('Run', { onClick: dumpHostSnapshot })));
        $rows.append(h.formRow('Dump kernel state',
            h.button('Run', { onClick: dumpKernelState })));

        // Army probes live in army.js; resolved per click so a reloaded
        // bundle's functions are the ones that run.
        function army() { return S.modules.diagnostics.army; }
        $rows.append(h.formRow('Dump generals (task, squads)',
            h.button('Run', { onClick: function () { army().dumpGenerals(); } })));
        $rows.append(h.formRow('Dump army (free, assigned, units)',
            h.button('Run', { onClick: function () { army().dumpArmy(); } })));
        $rows.append(h.formRow('Dump quests on this zone',
            h.button('Run', { onClick: function () { army().dumpQuests(); } })));
        $rows.append(h.formRow('Dump active adventures',
            h.button('Run', { onClick: function () { army().dumpAdventures(); } })));
        $rows.append(h.formRow('Dump adventure and buff definitions',
            h.button('Run', { onClick: function () { army().dumpDefinitions(); } })));

        function samplerLabel() { return army().samplerRunning() ? 'Stop' : 'Start'; }
        var $sample = h.button(samplerLabel(), {
            onClick: function () {
                army().toggleSampler();
                $sample.text(samplerLabel());
            }
        });
        $rows.append(h.formRow('Sample generals every 5 s for 3 min', $sample));
    }

    S.modules.diagnostics.renderSection             = renderSection;
    S.modules.diagnostics.summary                   = summary;
    S.modules.diagnostics.inspectSpecialists        = inspectSpecialists;
    S.modules.diagnostics.inspectCurrentZone        = inspectCurrentZone;
    S.modules.diagnostics.dumpHostSnapshot          = dumpHostSnapshot;
    S.modules.diagnostics.dumpKernelState           = dumpKernelState;
    S.modules.diagnostics.deepInspectExplorerTypes  = deepInspectExplorerTypes;
    S.modules.diagnostics.deepInspectGeologistTypes = deepInspectGeologistTypes;

}(Steward));
