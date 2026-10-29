/*
 * Run-template dialog for the adventures module.
 *
 * A separate host Modal rather than a dashboard tab: building a template
 * needs a file picker, a reorderable wave list and a report. Opening it hides
 * the dashboard (Modal.show semantics), and a zone load closes host modals,
 * so an unsaved draft can never outlive the island it was edited on.
 *
 * Edits are buffered in `state.draft` until Save; templates themselves are
 * files, so Save writes one and Delete removes one. DOM only: all data comes
 * through templates, dryrun, S.core.* and S.kernel.*. Open, save and delete
 * resync the native menu's template list.
 *
 * Reload safety: the file starts no timers and caches no function from
 * another file. Every handler calls S.modules.adventures.*, S.core.* and
 * S.kernel.* when it runs, so a dialog left open across a script reload
 * drives the new instance's code.
 *
 * Every user-supplied string (labels, paths, file names, messages) goes
 * through escape() before it reaches gridRow, which takes HTML.
 */

(function (S) {

    if (!S.modules.adventures) S.modules.adventures = {};

    var MODAL_ID = 'StewardAdventures';
    var TITLE = 'Steward — Adventure templates';

    var modal = null;
    var state = null;

    // ---- Small helpers --------------------------------------------------------

    function T() { return S.modules.adventures.templates; }
    function H() { return S.kernel.ui.helpers; }

    function esc(v) { return H().escape(v); }

    function has(obj, key) {
        return Object.prototype.hasOwnProperty.call(obj, key);
    }

    function notify(text) {
        if (S.kernel.ui && S.kernel.ui.notify) S.kernel.ui.notify(text);
    }

    // The native menu lists the templates; it rebuilds only when the set changed.
    function syncMenu() {
        var m = S.modules.adventures.menu;
        if (m && m.sync) m.sync();
    }

    function fileName(path) {
        var p = String(path || '');
        var cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
        return cut === -1 ? p : p.substring(cut + 1);
    }

    function span(cls, text) {
        return '<span class="' + cls + '">' + esc(text) + '</span>';
    }

    // formRow takes text or a jQuery element, so escaped HTML is wrapped.
    function htm(html) {
        return $('<span>').html(html);
    }

    function sortedKeys(map) {
        var keys = [];
        for (var k in map) {
            if (has(map, k)) keys.push(k);
        }
        keys.sort();
        return keys;
    }

    // "12 Type, 3 Other"; unit ids shown by their localised name when known.
    function armyText(army) {
        var keys = sortedKeys(army || {});
        var out = [];
        for (var i = 0; i < keys.length; i++) {
            if (!(army[keys[i]] > 0)) continue;
            var name = S.core.locale.res(keys[i]);
            out.push(army[keys[i]] + ' ' + (name || keys[i]));
        }
        return out.length ? out.join(', ') : '—';
    }

    function startDir() {
        return T().lastDir() || S.kernel.host.battleTemplateDir() || '';
    }

    function rememberDir(path) {
        var info = S.kernel.files.info(path);
        if (info && info.parent) T().setLastDir(info.parent);
    }

    function act(fn) {
        return function () {
            state.error = null;
            // A pending delete confirmation must not outlive any other action.
            state.confirmDelete = null;
            fn();
        };
    }

    function btn(label, onClick) {
        return H().button(label, { size: 'sm', onClick: onClick });
    }

    // ---- Shell ----------------------------------------------------------------

    function render() {
        if (!modal) return;
        var $body = modal.Body();
        if (!$body || !$body.length) return;
        // Every re-render rebuilds the edit form from the draft, so carry the typed
        // label over first or it would be lost on each loadout or wave change.
        if (state.view === 'edit' && state.draft && state.labelInput) {
            state.draft.label = state.labelInput.val();
        }
        state.labelInput = null;
        $body.empty();
        var $panel = $('<div>', { 'class': 'steward-panel' });
        var $c = $('<div>', { 'class': 'container-fluid' });
        $panel.append($c);
        $body.append($panel);

        if (state.view === 'edit') renderEdit($c);
        else if (state.view === 'report') renderReport($c);
        else renderList($c);
    }

    function renderFooter() {
        var $footer = modal.Footer ? modal.Footer() : null;
        if (!$footer || !$footer.length) return;
        $footer.empty();
        var $close = $('<button>', {
            'type':  'button',
            'class': 'steward-btn steward-btn-close',
            'text':  'Close'
        });
        $close.on('click', function () {
            try { modal.hide(); } catch (e) { /* ignore */ }
        });
        $footer.append($close);
    }

    function open() {
        if (typeof Modal === 'undefined') {
            S.kernel.error('adventures', 'host Modal class unavailable — cannot open the template dialog');
            notify('The template dialog needs the game window; try again once the island is loaded.');
            return;
        }
        S.kernel.ui.ensureStyle(MODAL_ID);
        state = { view: 'list', draft: null, report: null, confirmDelete: null, error: null, labelInput: null };
        try {
            modal = new Modal(MODAL_ID, TITLE, true);
            modal.create();
            renderFooter();
            render();
            modal.show();
            syncMenu();
        } catch (e) {
            S.kernel.error('adventures', 'open template dialog threw:', e);
        }
    }

    function errorRow($c) {
        if (!state.error) return;
        $c.append(H().gridRow([[12, span('steward-bad', state.error)]]));
    }

    // ---- List view ------------------------------------------------------------

    function newTemplate() {
        state.draft = T().normalize({});
        state.draft.speedBuff = T().initialSpeedBuff(state.draft, S.core.buffs.speedBuffs());
        state.view = 'edit';
        render();
    }

    function editTemplate(id) {
        var rec = T().get(id);
        if (!rec) {
            state.error = 'Could not open ' + id;
            render();
            return;
        }
        state.draft = rec;
        state.draft.speedBuff = T().initialSpeedBuff(rec, S.core.buffs.speedBuffs());
        state.view = 'edit';
        render();
    }

    function dryRun(rec) {
        state.report = S.modules.adventures.dryrun.report(rec);
        state.view = 'report';
        render();
    }

    function deleteButton(id, name) {
        var confirming = state.confirmDelete === id;
        return btn(confirming ? 'Confirm delete' : 'Delete', function () {
            state.error = null;
            if (!confirming) {
                state.confirmDelete = id;
            } else {
                state.confirmDelete = null;
                if (!T().remove(id)) state.error = 'Could not delete ' + name;
                else syncMenu();
            }
            render();
        });
    }

    function renderRecordRow($c, rec, buffs) {
        var h = H();
        var buffName = T().resolveSpeedBuff(rec, buffs);
        var buffText = buffName === null ? 'No horseshoe'
            : 'Horseshoe: ' + T().buffLabel(buffs, buffName);
        var adventure = S.core.adventures.label(rec.adventure) || rec.adventure;
        var $btns = $('<span>');
        $btns.append(btn('Edit', act(function () { editTemplate(rec.id); })));
        $btns.append(document.createTextNode(' '));
        $btns.append(btn('Dry run', act(function () { dryRun(rec); })));
        $btns.append(document.createTextNode(' '));
        $btns.append(deleteButton(rec.id, rec.id + T().EXT));
        $c.append(h.gridRow([
            [3, esc(rec.label)],
            [3, esc(adventure)],
            [1, String(rec.waves.length)],
            [2, esc(buffText)],
            [3, $btns]
        ]));
    }

    function renderBrokenRow($c, rec) {
        var name = rec.id + T().EXT;
        var $btns = $('<span>');
        $btns.append(deleteButton(rec.id, name));
        $c.append(H().gridRow([
            [3, span('steward-bad', name)],
            [6, span('steward-bad', rec.error)],
            [3, $btns]
        ]));
    }

    function renderList($c) {
        var h = H();
        var t = T();
        var folder = t.dirPath();
        var action = folder ? { label: 'New template', onClick: act(newTemplate) } : null;
        $c.append(h.headerRow('Run templates', { icon: '⚔', action: action }));
        errorRow($c);

        var buffs = S.core.buffs.speedBuffs();
        var run = S.modules.adventures.run;
        if (run) {
            $c.append(h.gridRow([[12, span('steward-muted', run.statusText(run.current()))]]));
        }

        var recs = t.list();
        if (!recs.length) {
            $c.append(h.gridRow([[12, span('steward-muted', 'No templates yet.')]]));
        }
        for (var i = 0; i < recs.length; i++) {
            if (recs[i].error !== undefined) renderBrokenRow($c, recs[i]);
            else renderRecordRow($c, recs[i], buffs);
        }

        if (folder) {
            $c.append(h.gridRow([[12, span('steward-muted', 'Stored in ' + folder)]]));
        } else {
            $c.append(h.gridRow([[12, span('steward-bad', 'No writable steward folder')]]));
        }
    }

    // ---- Edit view ------------------------------------------------------------

    function adventureControl(draft) {
        var h = H();
        var defs = S.core.adventures.definitions();
        if (!defs.length) {
            return h.input({
                value: draft.adventure,
                placeholder: 'Adventure name',
                onChange: function (v) { draft.adventure = v; }
            });
        }
        var groups = S.core.adventures.groups(defs);
        var $sel = $('<select>', { 'class': 'steward-dropdown' });
        var found = false;
        var i, j;
        $sel.append($('<option>', { value: '' }).text('— choose —'));
        for (i = 0; i < groups.length; i++) {
            var $g = $('<optgroup>', { label: groups[i].group });
            for (j = 0; j < groups[i].items.length; j++) {
                var def = groups[i].items[j];
                var $o = $('<option>', { value: def.name }).text(def.label);
                if (def.name === draft.adventure) { $o.attr('selected', 'selected'); found = true; }
                $g.append($o);
            }
            $sel.append($g);
        }
        // An old template keeps its map even when it is no longer listed.
        if (draft.adventure && !found) {
            var $x = $('<option>', { value: draft.adventure })
                .text(S.core.adventures.label(draft.adventure) || draft.adventure);
            $x.attr('selected', 'selected');
            $sel.append($x);
        }
        $sel.on('change', function () {
            // Keep the user's own label; only an empty or auto-filled one follows the map.
            var prevLabel = draft.adventure ? (S.core.adventures.label(draft.adventure) || draft.adventure) : '';
            var name = $sel.val();
            var nextLabel = name ? (S.core.adventures.label(name) || name) : '';
            var current = state.labelInput ? state.labelInput.val() : draft.label;
            var auto = T().autoLabel(current, prevLabel, nextLabel);
            if (auto !== null) {
                draft.label = auto;
                if (state.labelInput) state.labelInput.val(auto);
            }
            draft.adventure = name;
        });
        return $sel;
    }

    function loadoutSummary(path) {
        var ld = S.core.battles.load(path);
        var generals = 0;
        var units = {};
        for (var i = 0; i < ld.lines.length; i++) {
            var l = ld.lines[i];
            if (!S.core.battles.isGeneralLine(l)) continue;
            generals++;
            units = S.core.army.add(units, l.army);
        }
        var text = generals + ' general line' + (generals === 1 ? '' : 's') + ', ' + armyText(units) +
            ', ' + ld.problems.length + ' problem' + (ld.problems.length === 1 ? '' : 's');
        return span(ld.ok ? 'steward-muted' : 'steward-bad', text);
    }

    function pickLoadout() {
        var ok = S.kernel.files.browse({
            title: 'Choose the loadout battle file',
            multiple: false,
            filters: S.core.battles.BROWSE_FILTERS,
            startDir: startDir()
        }, function (paths) {
            if (!paths.length) return;
            state.draft.loadout = paths[0];
            rememberDir(paths[0]);
            render();
        });
        if (!ok) { state.error = 'Could not open the file picker'; render(); }
    }

    function pickWaves() {
        var ok = S.kernel.files.browse({
            title: 'Choose wave battle files',
            multiple: true,
            filters: S.core.battles.BROWSE_FILTERS,
            startDir: startDir()
        }, function (paths) {
            if (!paths.length) return;
            for (var i = 0; i < paths.length; i++) state.draft.waves.push(paths[i]);
            rememberDir(paths[paths.length - 1]);
            render();
        });
        if (!ok) { state.error = 'Could not open the file picker'; render(); }
    }

    function moveWave(idx, by) {
        var w = state.draft.waves;
        var to = idx + by;
        if (to < 0 || to >= w.length) return;
        var tmp = w[idx];
        w[idx] = w[to];
        w[to] = tmp;
        render();
    }

    function waveCounts(path) {
        var ld = S.core.battles.load(path);
        var attack = 0;
        var move = 0;
        for (var i = 0; i < ld.lines.length; i++) {
            if (ld.lines[i].kind === S.BattleLine.Attack) attack++;
            else if (ld.lines[i].kind === S.BattleLine.Move) move++;
        }
        var text = attack + ' attack, ' + move + ' move';
        return ld.ok ? span('steward-muted', text) : span('steward-bad', 'unreadable');
    }

    function waveList(draft) {
        var $ul = $('<ul>', { 'class': 'steward-list' });
        var sortable = !!($.fn && $.fn.sortable);
        for (var i = 0; i < draft.waves.length; i++) {
            (function (idx) {
                var path = draft.waves[idx];
                var $li = $('<li>', { 'data-idx': String(idx) });
                $li.append($('<span>').text('Wave ' + (idx + 1) + '  '));
                $li.append($('<span>', { title: path }).text(fileName(path)));
                $li.append($('<span>').html('  ' + waveCounts(path)));
                if (!sortable) {
                    $li.append(document.createTextNode(' '));
                    $li.append(btn('↑', function () { moveWave(idx, -1); }));
                    $li.append(btn('↓', function () { moveWave(idx, 1); }));
                }
                $li.append(document.createTextNode(' '));
                $li.append(btn('×', function () {
                    draft.waves.splice(idx, 1);
                    render();
                }));
                $ul.append($li);
            }(i));
        }
        if (sortable && draft.waves.length > 1) {
            $ul.sortable({
                update: function () {
                    var order = [];
                    $ul.children('li').each(function () {
                        order.push(parseInt($(this).attr('data-idx'), 10));
                    });
                    var next = [];
                    for (var i = 0; i < order.length; i++) next.push(draft.waves[order[i]]);
                    draft.waves = next;
                    render();
                }
            });
        }
        return $ul;
    }

    function saveDraft($label) {
        var draft = state.draft;
        draft.label = $label.val();
        var r = T().save(draft, new Date().getTime());
        if (!r.ok) {
            state.error = null;
            state.problems = r.problems;
            render();
            return;
        }
        state.problems = null;
        state.draft = null;
        state.view = 'list';
        render();
        syncMenu();
    }

    function renderEdit($c) {
        var h = H();
        var t = T();
        var draft = state.draft;
        $c.append(h.headerRow(draft.id ? 'Edit template' : 'New template', { icon: '⚔' }));
        errorRow($c);
        if (state.problems) {
            for (var p = 0; p < state.problems.length; p++) {
                $c.append(h.gridRow([[12, span('steward-bad', state.problems[p].message)]]));
            }
        }

        var $label = h.input({ value: draft.label, placeholder: 'Template name' });
        state.labelInput = $label;
        $c.append(h.formRow('Label', $label));
        $c.append(h.formRow('Adventure', adventureControl(draft)));

        var $lo = $('<span>');
        if (draft.loadout) {
            $lo.append($('<span>', { title: draft.loadout }).text(fileName(draft.loadout)));
            $lo.append(document.createTextNode(' '));
        }
        $lo.append(btn('Choose…', act(pickLoadout)));
        $c.append(h.formRow('Loadout', $lo));
        if (draft.loadout) {
            $c.append(h.gridRow([[12, loadoutSummary(draft.loadout)]]));
        }

        $c.append(h.gridRow([[12, '<strong>Waves</strong>']]));
        if (!draft.waves.length) {
            $c.append(h.gridRow([[12, span('steward-muted', 'No waves yet.')]]));
        } else {
            $c.append(h.gridRow([[12, waveList(draft)]]));
        }
        $c.append(h.gridRow([[12, btn('Add waves…', act(pickWaves))]]));

        var buffs = S.core.buffs.speedBuffs();
        var options = t.speedBuffOptions(buffs, draft.speedBuff);
        var $dd = h.dropdown(options, {
            selected: draft.speedBuff,
            onChange: function (v) {
                draft.speedBuff = v;
                render();
            }
        });
        $c.append(h.formRow('Horseshoe', $dd));
        for (var i = 0; i < options.length; i++) {
            if (options[i].value === draft.speedBuff && options[i].warn) {
                $c.append(h.gridRow([[12, span('steward-warn', 'None in stock: a run would skip the horseshoe')]]));
            }
        }

        var $btns = $('<span>');
        $btns.append(btn('Save', function () { saveDraft($label); }));
        $btns.append(document.createTextNode(' '));
        $btns.append(btn('Cancel', function () {
            state.draft = null;
            state.problems = null;
            state.error = null;
            state.view = 'list';
            render();
        }));
        $c.append(h.gridRow([[12, $btns]]));
    }

    // ---- Report view ----------------------------------------------------------

    function problemRows($c, problems) {
        for (var i = 0; i < problems.length; i++) {
            var p = problems[i];
            var cls = p.fatal ? 'steward-bad' : 'steward-warn';
            var key = p.key ? p.key + ': ' : '';
            $c.append(H().gridRow([[12, span(cls, key + p.message)]]));
        }
    }

    function lineTable($c, lines) {
        var h = H();
        if (!lines.length) return;
        $c.append(h.gridRow([
            [2, 'General'], [1, 'Kind'], [1, 'Grid'], [2, 'Target'],
            [3, 'Army'], [1, 'Delay'], [1, 'Now'], [1, 'Match']
        ], { headerCells: true }));
        for (var i = 0; i < lines.length; i++) {
            var l = lines[i];
            var general = S.core.battles.isGeneralLine(l);
            var grid = l.kind === S.BattleLine.Star ? 'star' : (l.grid === null ? '' : String(l.grid));
            var mark = '';
            if (general) mark = l.matches ? span('steward-ok', '✓') : span('steward-bad', '✗');
            $c.append(h.gridRow([
                [2, esc(l.name || l.key)],
                [1, esc(String(l.kind).replace(/^Line/, ''))],
                [1, esc(grid)],
                [2, esc(l.targetName || (l.target === null ? '' : l.target))],
                [3, esc(armyText(l.army))],
                [1, l.timeMs === null ? '' : esc(Math.round(l.timeMs / 1000) + ' s')],
                [1, general ? esc(armyText(l.have)) : ''],
                [1, mark]
            ]));
        }
    }

    function supplyRows($c, supply) {
        var h = H();
        if (!supply) return;
        var donors = [];
        for (var i = 0; i < supply.donors.length; i++) {
            var d = supply.donors[i];
            donors.push((d.name || d.key) + ' (' + armyText(d.army) + ')');
        }
        $c.append(h.formRow('Needed from the free pool', htm(esc(armyText(supply.need)))));
        $c.append(h.formRow('Free pool short by', htm(esc(armyText(supply.shortBefore)))));
        $c.append(h.formRow('Donors', htm(esc(donors.length ? donors.join('; ') : 'none'))));
        $c.append(h.formRow('Covered', htm(supply.covered ? span('steward-ok', 'yes') : span('steward-bad', 'no'))));
        if (supply.missing.length) {
            $c.append(h.formRow('Missing generals', htm(span('steward-bad', supply.missing.join(', ')))));
        }
    }

    function backToList() {
        state.report = null;
        state.error = null;
        state.view = 'list';
        render();
    }

    function renderReport($c) {
        var h = H();
        var data = state.report;
        var back = { label: 'Back', onClick: backToList };
        if (!data || data.broken) {
            $c.append(h.headerRow('Dry run', { icon: '⚔', action: back }));
            $c.append(h.gridRow([[12, span('steward-bad', 'This template cannot be read')]]));
            return;
        }
        var tpl = data.template;
        $c.append(h.headerRow('Dry run: ' + tpl.label, { icon: '⚔', action: back }));

        var viewing = data.zoneAdventure
            ? (S.core.adventures.label(data.zoneAdventure) || data.zoneAdventure) : 'not an adventure';
        var mapLabel = S.core.adventures.label(tpl.adventure) || tpl.adventure;
        $c.append(h.gridRow([[12, esc('Map: ' + mapLabel + ' — viewing ' + viewing)]]));
        if (!data.onTemplateMap) {
            $c.append(h.gridRow([[12, span('steward-warn', 'Not on the template\'s map: camp checks skipped')]]));
        }
        var sb = data.speedBuff;
        var sbText = sb.name === null ? 'no horseshoe' : sb.name + ' (' + (sb.amount || 0) + ' in stock)';
        $c.append(h.gridRow([[12, esc('Horseshoe: ' + sbText + (sb.note ? ' — ' + sb.note : ''))]]));

        for (var i = 0; i < data.files.length; i++) {
            var f = data.files[i];
            var title = f.role === 'loadout' ? 'Loadout' : 'Wave ' + f.index;
            $c.append(h.headerRow(title + ' — ' + fileName(f.path)));
            problemRows($c, f.problems);
            lineTable($c, f.lines);
            supplyRows($c, f.supply);
        }
        $c.append(h.gridRow([[12, esc(data.fatal + ' fatal, ' + data.warn + ' warnings')]]));
    }

    S.modules.adventures.dialog = {
        open: open
    };

}(Steward));
