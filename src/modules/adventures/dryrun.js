/*
 * Dry run of a run template.
 *
 * Reads the template's loadout and wave battle files fresh, validates each
 * against the current army and plans where its troops would come from.
 * Read-only: nothing is sent, raised, unloaded or enqueued.
 *
 * assemble() is pure over the injected deps, so it can be checked without
 * the client; liveDeps() wires the real cores and report() is what the
 * dialog calls.
 *
 * Files are evaluated in template order: the loadout, then each wave (a
 * wave listed twice is evaluated twice). Each file's supply is planned
 * against the island as it is now, independently of the files before it,
 * because nothing has been raised yet. Camp checks run only while the
 * viewed adventure is the template's map; elsewhere the camps are unknown.
 */

(function (S) {

    if (!S.modules.adventures) S.modules.adventures = {};

    function has(obj, key) {
        return Object.prototype.hasOwnProperty.call(obj, key);
    }

    function speedBuffInfo(tpl, deps) {
        var choice = S.modules.adventures.templates.speedBuffChoice(tpl);
        var name = S.modules.adventures.templates.resolveSpeedBuff(tpl, deps.defaultSpeedBuff);
        var amount = null;
        var note = '';
        if (name === null) {
            note = 'no horseshoe';
        } else {
            amount = deps.buffAmount(name);
            if (!amount) note = 'none in stock, a run would skip it';
        }
        return { choice: choice, name: name, amount: amount, note: note };
    }

    function lineRows(lines, byKey) {
        var out = [];
        for (var i = 0; i < lines.length; i++) {
            var l = lines[i];
            var live = S.core.battles.isGeneralLine(l) && has(byKey, l.key) ? byKey[l.key] : null;
            var have = live ? (live.army || {}) : null;
            out.push({
                key:        l.key,
                kind:       l.kind,
                name:       live && live.name ? live.name : l.name,
                grid:       l.grid,
                target:     l.target,
                targetName: l.targetName,
                army:       l.army,
                timeMs:     l.timeMs,
                have:       have,
                matches:    have ? S.core.army.matches(have, l.army) : false
            });
        }
        return out;
    }

    // Of the general lines (S.core.battles.isGeneralLine), Attack and Move
    // carry troops into the field; a Star line holds none.
    function supplyWave(lines) {
        var L = S.BattleLine;
        var wave = [];
        for (var i = 0; i < lines.length; i++) {
            if (lines[i].kind === L.Attack || lines[i].kind === L.Move) {
                wave.push({ key: lines[i].key, army: lines[i].army });
            }
        }
        return wave;
    }

    function evaluate(role, index, path, deps, loadoutKeys) {
        var ld = deps.load(path);
        var lines = ld.ok ? ld.lines : [];
        var problems = ld.problems.slice();
        if (ld.ok) problems = problems.concat(S.core.battles.validate(lines, deps.ctx));

        if (role === 'wave' && loadoutKeys) {
            for (var i = 0; i < lines.length; i++) {
                if (S.core.battles.isGeneralLine(lines[i]) && !has(loadoutKeys, lines[i].key)) {
                    problems.push(S.core.battles.problem(S.BattleProblem.NotInLoadout, lines[i].key,
                        (lines[i].name ? lines[i].name + ' ' : '') + '(' + lines[i].key +
                        ') is not in the loadout'));
                }
            }
        }

        var byKey = (deps.inv && deps.inv.byKey) || {};
        return {
            file: {
                role:     role,
                index:    index,
                path:     path,
                ok:       !!ld.ok,
                problems: problems,
                lines:    lineRows(lines, byKey),
                supply:   ld.ok ? S.core.army.planSupply(supplyWave(lines), deps.inv) : null
            },
            parsed: ld.ok ? lines : null
        };
    }

    function assemble(tpl, deps) {
        var files = [];
        var lo = evaluate('loadout', null, tpl.loadout, deps, null);
        files.push(lo.file);

        // Only a parsed loadout says which generals belong to the run.
        var loadoutKeys = null;
        if (lo.parsed) {
            loadoutKeys = {};
            for (var i = 0; i < lo.parsed.length; i++) {
                if (S.core.battles.isGeneralLine(lo.parsed[i])) loadoutKeys[lo.parsed[i].key] = true;
            }
        }

        var waves = tpl.waves || [];
        for (var w = 0; w < waves.length; w++) {
            files.push(evaluate('wave', w + 1, waves[w], deps, loadoutKeys).file);
        }

        var fatal = 0;
        var warn = 0;
        for (var f = 0; f < files.length; f++) {
            for (var p = 0; p < files[f].problems.length; p++) {
                if (files[f].problems[p].fatal) fatal++;
                else warn++;
            }
        }

        return {
            template:      tpl,
            onTemplateMap: !!deps.onTemplateMap,
            zoneAdventure: deps.zoneAdventure,
            speedBuff:     speedBuffInfo(tpl, deps),
            files:         files,
            fatal:         fatal,
            warn:          warn
        };
    }

    // The real cores. With a template, the camp check is enabled only while
    // the viewed adventure is that template's map.
    function liveDeps(tpl) {
        var inv = S.core.army.inventory();
        var zoneAdventure = S.core.zone.adventureName();
        var onTemplateMap = !!(tpl && tpl.adventure && zoneAdventure === tpl.adventure);

        var fighters = {};
        for (var k in inv.byKey) {
            if (!has(inv.byKey, k)) continue;
            var g = inv.byKey[k];
            fighters[k] = { name: g.name, cls: g.cls, capacity: g.capacity, army: g.army };
        }

        var camp = null;
        if (onTemplateMap) {
            camp = function (grid) {
                var b = S.core.buildings.byGrid(grid);
                return b ? { enemy: S.core.buildings.isEnemy(b) } : null;
            };
        }

        return {
            load:  function (path) { return S.core.battles.load(path); },
            ctx: {
                fighters: fighters,
                isElite:  S.core.army.isElite,
                classOf:  function (a) { return S.core.army.classOf(a); },
                total:    S.core.army.total,
                camp:     camp
            },
            inv:              inv,
            buffAmount:       function (name) { return S.core.buffs.amount(name); },
            defaultSpeedBuff: S.modules.adventures.templates.defaultSpeedBuff(),
            zoneAdventure:    zoneAdventure,
            onTemplateMap:    onTemplateMap
        };
    }

    function report(tpl) {
        if (tpl && tpl.error !== undefined) return { broken: tpl };
        var data = assemble(tpl, liveDeps(tpl));
        S.kernel.log('adventures', 'dry run "' + tpl.label + '": ' + data.files.length + ' files, ' +
            data.fatal + ' fatal, ' + data.warn + ' warnings');
        return data;
    }

    S.modules.adventures.dryrun = {
        assemble: assemble,
        liveDeps: liveDeps,
        report:   report
    };

}(Steward));
