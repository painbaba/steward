/*
 * The ~Adventures~ bar menu of the adventures module.
 *
 * A read-only view of the run plus the run controls: the run title, one
 * status line, the four commands enabled by what applies now, and the stage
 * rows grouped as the steps table in state.js folds them. The marks are
 * written here and nowhere else.
 *
 * The entry stays built and joins or leaves the bar: it is in the bar only
 * while the run is Running or Paused. Moving it creates no native object, so
 * a run that ends inside plan() can hide it.
 *
 * Labels and enabled flags refresh when the menu opens, not on the status
 * tick: a run changes this text far too often for a label write per tick,
 * and AIR grows objects on those writes. The row set is fixed between
 * rebuilds because a submenu row cannot be hidden, so the status line is
 * always present during a run and a rebuild happens only when the wave count
 * changes; a series keeps its count and rebuilds nothing. Labels read memory
 * only, never files.
 *
 * Bundle slot: module file, in name order after run.js and before settings.js
 * and state.js; top level only assigns S.modules.adventures.runmenu; all else
 * runs at call time. Every call into the other adventures parts is late-bound
 * because a script reload may replace them.
 */

(function (S) {

    if (!S.modules.adventures) S.modules.adventures = {};

    // The one glyph table. If the client's menu font cannot draw the done or
    // now mark, use x and > here. The todo mark is two no-break spaces because
    // leading spaces may be trimmed, and written as escapes because a literal
    // one is invisible in review and an editor can turn it into plain spaces.
    var MARK = { done: '✓', now: '▶', paused: '!', skip: '–', todo: '\u00A0\u00A0' };

    var IDLE = 'idle';

    // Signature of the row set the last items() call built.
    var lastSignature = null;

    function st() {
        return S.modules.adventures.state;
    }

    function templates() {
        return S.modules.adventures.templates;
    }

    function keyCount(obj) {
        var n = 0;
        for (var k in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, k)) n++;
        }
        return n;
    }

    // ---- Details ------------------------------------------------------------

    // The action round of the run's current wave. Matched without the step:
    // the round stays keyed by the load step while the run is already at
    // Verify.
    function roundOf(rs, r) {
        var round = rs.round;
        return round && round.runId === r.id && round.waveIndex === r.waveIndex ? round : null;
    }

    function roundText(rs, r) {
        var round = roundOf(rs, r);
        var expected = round ? keyCount(round.expected) : 0;
        return expected ? keyCount(round.results) + '/' + expected : '';
    }

    // Who the current step waits for and how long, or ''. The record is memory
    // only and may be absent after a script reload.
    function busyText(r) {
        var b = st().busyOf(r);
        if (!b) return '';
        var n = Math.floor((st().now() - b.since) / 60000);
        return b.text + (n >= 1 ? ', ' + n + ' min' : '');
    }

    function attackText(rs, r) {
        var c = rs.cache;
        if (r.step !== S.WaveStep.Attack && r.step !== S.WaveStep.Confirm) return '';
        if (!c || c.runId !== r.id || c.waveIndex !== r.waveIndex || c.path !== r.paths[r.waveIndex]) return '';
        var n = S.modules.adventures.executor.attackCount(r, c.lines);
        return n.total > 0 ? n.sent + '/' + n.total : '';
    }

    // The inner step of the current wave. Load moves to Verify in the same
    // pass that starts its round, so an open round at Verify is still loading.
    function innerText(rs, r) {
        var round = roundOf(rs, r);
        var name = st().stepName(r.step);
        if (r.step === S.WaveStep.Verify && round && !S.modules.adventures.loader.complete(round)) name = 'Load';
        var busy = busyText(r);
        if (busy) return name + ', ' + busy;
        var count = attackText(rs, r) || roundText(rs, r);
        return name + (count ? ' ' + count : '');
    }

    // The game may not be loaded when the menu opens.
    function safeBuffs() {
        try { return S.core.buffs.speedBuffs(); }
        catch (e) { return []; }
    }

    function buffText(r) {
        var buffs = safeBuffs();
        var name = templates().resolveSpeedBuff({ speedBuff: r.speedBuff }, buffs);
        return name === null ? '' : templates().buffLabel(buffs, name);
    }

    // ---- Rows ---------------------------------------------------------------

    function isCurrent(mark) {
        return mark === 'now' || mark === 'paused';
    }

    function stageMark(r, row, pos) {
        // A series that was stopped keeps its step like a paused run, so the
        // list shows where it stopped; a series that finished shows all done.
        if ((r.status === S.RunStatus.Done && !r.stopReason) || pos > row.last) return 'done';
        if (pos < row.first) return 'todo';
        return r.status === S.RunStatus.Paused || r.status === S.RunStatus.Done ? 'paused' : 'now';
    }

    function waveMark(r, row, pos, i) {
        var mark = stageMark(r, row, pos);
        if (!isCurrent(mark)) return mark;
        if (i < r.waveIndex) return 'done';
        return i > r.waveIndex ? 'todo' : mark;
    }

    function stageRow(rs, r, row, pos) {
        var state = st();
        if (state.optionOff(r, row.option)) return { label: row.label, file: '', mark: 'skip', detail: 'not used' };
        var mark = stageMark(r, row, pos);
        var detail = '';
        // Found by its step, so the row's name stays in the one steps table.
        if (row.first === state.position(S.RunStep.Horseshoe)) detail = buffText(r);
        else if (isCurrent(mark)) detail = busyText(r) || roundText(rs, r);
        return { label: row.label, file: '', mark: mark, detail: detail };
    }

    function waveRows(rs, r, row, pos) {
        var out = [];
        for (var i = 0; i < r.paths.length; i++) {
            var mark = waveMark(r, row, pos, i);
            out.push({
                label:  'Wave ' + (i + 1),
                file:   templates().fileName(r.paths[i]),
                mark:   mark,
                detail: isCurrent(mark) ? innerText(rs, r) : ''
            });
        }
        return out;
    }

    // Groups of rows: [{ label, rows: [{ label, file, mark, detail }] }], empty
    // with no run. mark is a key of MARK.
    function rows() {
        var rs = st().current();
        var r = rs.run;
        var groups = [];
        if (!r) return groups;
        var steps = st().stepRows();
        var pos = st().position(r.step);
        var group = null;
        for (var i = 0; i < steps.length; i++) {
            var row = steps[i];
            if (!group || group.label !== row.group) {
                group = { label: row.group, rows: [] };
                groups.push(group);
            }
            if (row.waves) group.rows = group.rows.concat(waveRows(rs, r, row, pos));
            else group.rows.push(stageRow(rs, r, row, pos));
        }
        return groups;
    }

    // The single read of a menu pass, shared by all its label and enabled
    // functions.
    function view(pass) {
        pass.view = pass.view || { groups: rows(), can: S.modules.adventures.run.can() };
        return pass.view;
    }

    function currentRow(groups) {
        for (var g = 0; g < groups.length; g++) {
            for (var n = 0; n < groups[g].rows.length; n++) {
                if (isCurrent(groups[g].rows[n].mark)) return groups[g].rows[n];
            }
        }
        return null;
    }

    function rowText(row) {
        return MARK[row.mark] + '  ' + row.label + (row.file ? '  ' + row.file : '') +
            (row.detail ? '   ' + row.detail : '');
    }

    function statusLine(pass) {
        var r = st().run();
        if (!r) return '';
        if (r.status === S.RunStatus.Paused) return r.pause ? r.pause.message : '';
        if (r.status === S.RunStatus.Done) {
            return r.stopReason ? 'Stopped: ' + r.stopReason + '; use Stop run to clear'
                : 'Series done; use Stop run to clear';
        }
        var row = currentRow(view(pass).groups);
        var line = row ? 'Now: ' + row.label + (row.detail ? ', ' + row.detail : '') : '';
        // A wrong zone stops the passes, so nothing else can say why the run
        // stands.
        var hint = line ? st().viewHint(r) : '';
        return hint ? line + ', ' + hint : line;
    }

    // ---- Items --------------------------------------------------------------

    // The Adventures submenu's row, so both menus run one command and this
    // one only adds when it applies.
    function control(cmd) {
        var name = cmd.name;
        var item = S.modules.adventures.menu.command(cmd.label, name);
        item.enabled = function (pass) {
            return view(pass).can[name] === true;
        };
        return item;
    }

    // A function, so each item captures its own indices (ES5 has no block
    // scope). Rows are read by index because the item set outlives the run it
    // was built for: a series keeps it.
    function rowItem(g, n) {
        return {
            label: function (pass) {
                var group = view(pass).groups[g];
                var row = group ? group.rows[n] : null;
                return row ? rowText(row) : '';
            },
            enabled: false
        };
    }

    function signature() {
        var r = st().run();
        return r ? 'waves:' + r.paths.length : IDLE;
    }

    function items() {
        lastSignature = signature();

        var list = [{
            label: function () { return st().title(); },
            enabled: false
        }];
        if (lastSignature !== IDLE) list.push({ label: statusLine, enabled: false });
        list.push({ separator: true });
        var commands = S.modules.adventures.menu.COMMANDS;
        for (var c = 0; c < commands.length; c++) list.push(control(commands[c]));

        var groups = rows();
        for (var g = 0; g < groups.length; g++) {
            list.push({ separator: true }, { label: groups[g].label, enabled: false });
            for (var n = 0; n < groups[g].rows.length; n++) list.push(rowItem(g, n));
        }
        return list;
    }

    // Whether the bar shows the menu now.
    function visible() {
        var r = st().run();
        return !!r && (r.status === S.RunStatus.Running || r.status === S.RunStatus.Paused);
    }

    // Brings the entry in line with the run; true when it rebuilt the rows.
    function sync() {
        var ui = S.kernel.ui;
        var show = visible();
        var rebuilt = false;
        // Built before it shows; a hidden menu is not rebuilt. lastSignature keeps
        // the last build, which is what the hidden entry still holds.
        if (show && signature() !== lastSignature && ui && ui.refreshBarMenu) {
            rebuilt = ui.refreshBarMenu('adventures');
        }
        if (ui && ui.showBarMenu) ui.showBarMenu('adventures', show);
        return rebuilt;
    }

    S.modules.adventures.runmenu = {
        items:     items,
        sync:      sync,
        visible:   visible,
        rows:      rows,
        signature: signature,
        MARK:      MARK
    };

}(Steward));
