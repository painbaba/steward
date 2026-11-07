/*
 * Run-template dialog for the adventures module.
 *
 * A separate host Modal rather than a dashboard tab: building a template
 * needs a file picker and a reorderable wave list. Opening it hides the
 * dashboard (Modal.show semantics), and a zone load closes host modals, so
 * an unsaved draft can never outlive the island it was edited on.
 *
 * Edits are buffered in `state.draft` until Save; templates themselves are
 * files, so Save writes one and Delete removes one. DOM only: all data comes
 * through templates, S.core.* and S.kernel.*. Open, save and delete resync
 * the native menu's template list.
 *
 * A view is built detached and swapped in only once complete: a view that
 * throws while building leaves a failure view with a way back to the list,
 * never a half-emptied body.
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

    function notify(text) {
        if (S.kernel.ui && S.kernel.ui.notify) S.kernel.ui.notify(text);
    }

    // The native menu lists the templates; it rebuilds only when the set changed.
    function syncMenu() {
        var m = S.modules.adventures.menu;
        if (m && m.sync) m.sync();
    }

    function span(cls, text) {
        return '<span class="' + cls + '">' + esc(text) + '</span>';
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
        // Build detached: the old view stays until the new one is complete, so
        // a throw part-way never leaves an emptied, half-built body.
        var $panel = $('<div>', { 'class': 'steward-panel' });
        var $c = $('<div>', { 'class': 'container-fluid' });
        $panel.append($c);
        try {
            if (state.view === 'edit') renderEdit($c);
            else renderList($c);
        } catch (e) {
            S.kernel.error('adventures', 'render ' + state.view + ' view threw:', e);
            state.labelInput = null;
            $c.empty();
            renderFailure($c, e);
        }
        $body.empty();
        $body.append($panel);
    }

    // Leaves the broken view behind; it renders only on click, so a list that
    // throws again simply shows this view again instead of looping.
    function backToListFromFailure() {
        state.draft = null;
        state.problems = null;
        state.view = 'list';
        render();
    }

    function renderFailure($c, e) {
        var message = e && e.message ? e.message : String(e);
        $c.append(H().headerRow('Adventure templates', {
            icon: '⚔',
            action: { label: 'Back to list', onClick: act(backToListFromFailure) }
        }));
        $c.append(H().gridRow([[12, span('steward-bad',
            'This view could not be shown: ' + message + ' (details in the console log)')]]));
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
        state = { view: 'list', draft: null, confirmDelete: null, error: null, labelInput: null, lastBuff: null };
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
        // A new template starts with the horseshoe on, even with none in stock.
        state.draft.speedBuff = T().enabledSpeedBuff(null, S.core.buffs.speedBuffs());
        state.lastBuff = null;
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
        state.lastBuff = null;
        state.view = 'edit';
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
        var store = S.modules.adventures.state;
        if (store) {
            $c.append(h.gridRow([[12, span('steward-muted', store.status())]]));
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
        // One flat list in label order, so a map is found by the name shown.
        var list = S.core.adventures.selectable(defs);
        var $sel = $('<select>', { 'class': 'steward-dropdown' });
        var found = false;
        $sel.append($('<option>', { value: '' }).text('— choose —'));
        for (var i = 0; i < list.length; i++) {
            var def = list[i];
            var $o = $('<option>', { value: def.name }).text(def.label);
            if (def.name === draft.adventure) { $o.attr('selected', 'selected'); found = true; }
            $sel.append($o);
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
        var text = generals + ' general line' + (generals === 1 ? '' : 's') + ', ' + S.core.army.text(units) +
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
                $li.append($('<span>', { 'class': 'steward-wave-no' }).text('Wave ' + (idx + 1) + '  '));
                $li.append($('<span>', { title: path }).text(T().fileName(path)));
                $li.append($('<span>').html('  ' + waveCounts(path)));
                if (!sortable) {
                    $li.append(document.createTextNode(' '));
                    $li.append(btn('↑', function () { moveWave(idx, -1); }));
                    $li.append(btn('↓', function () { moveWave(idx, 1); }));
                }
                $li.append(document.createTextNode(' '));
                // A drag renumbers rows in place, so the row's own index is read
                // at click time rather than the one it was built with.
                $li.append(btn('×', function () {
                    var at = parseInt($li.attr('data-idx'), 10);
                    if (!(at >= 0 && at < draft.waves.length)) return;
                    draft.waves.splice(at, 1);
                    render();
                }));
                $ul.append($li);
            }(i));
        }
        // The update handler runs inside the sortable's own mouse-stop, so it
        // must not re-render (that would destroy the sortable under it): it
        // reorders the draft and renumbers the rows in place.
        if (sortable && draft.waves.length > 1) {
            $ul.sortable({
                update: function () {
                    var order = [];
                    $ul.children('li').each(function () {
                        order.push(parseInt($(this).attr('data-idx'), 10));
                    });
                    var next = T().reorderWaves(draft.waves, order);
                    if (next === null) {
                        // The next render shows the draft's real order again.
                        S.kernel.warn('adventures', 'wave reorder ignored: bad order');
                        return;
                    }
                    draft.waves = next;
                    $ul.children('li').each(function (i) {
                        $(this).attr('data-idx', String(i));
                        $(this).children('.steward-wave-no').text('Wave ' + (i + 1) + '  ');
                    });
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
            $lo.append($('<span>', { title: draft.loadout }).text(T().fileName(draft.loadout)));
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
        var useShoe = draft.speedBuff !== S.SpeedBuffChoice.None;
        // The re-render shows the switch off again when no buff exists at all,
        // and turning it back on restores the buff it held.
        $c.append(h.formRow('Use horseshoe', h.toggle({
            checked: useShoe,
            onChange: function (on) {
                if (on) {
                    draft.speedBuff = t.enabledSpeedBuff(state.lastBuff, buffs);
                } else {
                    state.lastBuff = draft.speedBuff;
                    draft.speedBuff = S.SpeedBuffChoice.None;
                }
                render();
            }
        })));
        if (useShoe) {
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

    S.modules.adventures.dialog = {
        open: open
    };

}(Steward));
