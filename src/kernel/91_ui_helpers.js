/*
 * Dashboard helpers — autoTSO-mirror primitives.
 *
 * Modules' section.render($body, h) callbacks emit BS3 rows + cells. The
 * styling is mostly the host's (`tblHeader`, `.switch / .slider`, BS3
 * col-xs-* / col-sm-* / col-lg-*); we just provide ergonomic builders so
 * modules don't have to know the exact markup.
 *
 * Settings buffer:
 *   var s = h.settings('collect');                  // proxy via shell buffer
 *   h.update('collect', { enabled: true });          // patch + mark dirty
 *
 * The buffer is committed when the user presses Save; Close discards.
 *
 * gridRow cell content is HTML (it may carry host image markup), so
 * callers pass user strings through escape() first.
 */

(function (S) {

    var swSeq = 0;

    // ---------------------------------------------------------------
    // Generic BS3 row builder.
    //
    // gridRow([[cols, content], [cols, content], ...]) → <div class="row">
    // gridRow([[cols, content, extraClass], ...])      → cell gets extra class
    //
    // Cell colspans should sum to 12. Content can be a string (treated as
    // text) or a jQuery element. Used by autoTSO at user_auto.js:2257-… via
    // the host's createTableRow(); we replicate the structure with jQuery.
    // ---------------------------------------------------------------
    function gridRow(cells, opts) {
        opts = opts || {};
        var $row = $('<div>', { 'class': 'row steward-row' });
        if (opts.disabled) $row.addClass('steward-row-disabled');

        for (var i = 0; i < cells.length; i++) {
            var cell = cells[i];
            var cols = cell[0];
            var content = cell[1];
            var extra = cell[2] || '';
            var classes = 'col-xs-' + cols + ' col-sm-' + cols + ' col-lg-' + cols;
            if (extra) classes += ' ' + extra;
            if (opts.headerCells) {
                classes += ' tblHeader';
                if (i === 0)               classes += ' steward-tbl-first';
                if (i === cells.length - 1) classes += ' steward-tbl-last';
            }
            var $cell = $('<div>', { 'class': classes });
            if (content && content.jquery) {
                $cell.append(content);
            } else if (content !== null && typeof content !== 'undefined') {
                // Strings may contain <img> markup (e.g. host's getImageTag
                // output), so use html() rather than text() — callers are
                // expected to escape user content themselves.
                $cell.html(String(content));
            }
            $row.append($cell);
        }
        return $row;
    }

    // ---------------------------------------------------------------
    // Section header — parchment band styled with the host's `tblHeader`.
    // Two cells: [icon + title | action link]. autoTSO does this verbatim
    // at user_auto.js:2257.
    // ---------------------------------------------------------------
    function headerRow(title, opts) {
        opts = opts || {};
        var $title = $('<span>', { 'class': 'steward-section-title' });
        if (opts.icon) {
            $title.append($('<span>', { 'class': 'steward-section-icon' }).text(opts.icon));
        }
        $title.append(document.createTextNode(' ' + (title || '')));

        var $right;
        if (opts.action && opts.action.label) {
            $right = $('<a>', {
                href: '#',
                'class': 'steward-section-action'
            }).text(opts.action.label);
            if (typeof opts.action.onClick === 'function') {
                $right.on('click', function (e) {
                    e.preventDefault();
                    try { opts.action.onClick(); }
                    catch (err) { S.kernel.error('ui', 'section action threw:', err); }
                });
            }
        } else {
            $right = $('<span>').html('&nbsp;');
        }
        return gridRow([[8, $title], [4, $right]], { headerCells: true });
    }

    // ---------------------------------------------------------------
    // Form row — convenience for "label | control" with optional help.
    // 6/6 split keeps the layout consistent with autoTSO's settings rows.
    // ---------------------------------------------------------------
    function formRow(label, $control, helpText, opts) {
        opts = opts || {};

        var $labelCell;
        if (label && label.jquery) {
            $labelCell = label;
        } else {
            $labelCell = $('<span>').text(String(label || ''));
        }

        var $ctlCell = $('<span>');
        if ($control) {
            if ($control.jquery) $ctlCell.append($control);
            else                 $ctlCell.append(document.createTextNode(String($control)));
        }
        if (helpText) {
            $ctlCell.append($('<span>', { 'class': 'steward-row-help' })
                .text(helpText));
        }
        return gridRow([[6, $labelCell], [6, $ctlCell, 'steward-row-ctl']],
                       { disabled: opts.disabled });
    }

    // Sub-hint row — indented "↳ On: … / Off: …" callout.
    function indentRow(text) {
        var $hint = $('<span>', { 'class': 'steward-row-hint' })
            .html('&#10551; ' + (text || ''));
        return gridRow([[12, $hint]]);
    }

    // ---------------------------------------------------------------
    // Toggle — host's native iOS-style switch.
    //   <label class="switch">
    //     <input type="checkbox" id="…" checked>
    //     <span class="slider round"></span>
    //   </label>
    // The host's CSS in bootstrap.min.css paints it; we just emit markup.
    // ---------------------------------------------------------------
    function toggle(opts) {
        opts = opts || {};
        var name      = opts.id || ('steward-sw-' + (++swSeq));
        var isChecked = !!opts.checked;
        var onChange  = opts.onChange;

        var $wrap = $('<label>', { 'class': 'switch' });
        var $input = $('<input>', { type: 'checkbox', id: name });
        if (isChecked) $input.attr('checked', 'checked');
        var $slider = $('<span>', { 'class': 'slider round' });
        $wrap.append($input).append($slider);

        if (typeof onChange === 'function') {
            $input.on('change', function () {
                try { onChange($input.prop('checked')); }
                catch (err) { S.kernel.error('ui', 'toggle handler threw:', err); }
            });
        }
        return $wrap;
    }

    // ---------------------------------------------------------------
    // Parchment input (text / number).
    // ---------------------------------------------------------------
    function input(opts) {
        opts = opts || {};
        var $i = $('<input>', {
            type:    opts.type || 'text',
            value:   opts.value !== undefined ? String(opts.value) : '',
            'class': 'steward-input'
        });
        if (opts.placeholder) $i.attr('placeholder', opts.placeholder);
        if (opts.width) $i.css({ width: opts.width });
        if (typeof opts.onChange === 'function') {
            $i.on('change', function () {
                try { opts.onChange($i.val()); }
                catch (err) { S.kernel.error('ui', 'input change threw:', err); }
            });
            // change fires only on blur; enable Save while typing so the
            // click that causes the blur is not swallowed by a disabled button.
            $i.on('input', function () {
                try {
                    if (S.kernel.ui && typeof S.kernel.ui.markEditing === 'function') {
                        S.kernel.ui.markEditing();
                    }
                } catch (err) { S.kernel.error('ui', 'input edit hook threw:', err); }
            });
        }
        return $i;
    }

    // ---------------------------------------------------------------
    // Parchment dropdown.
    // ---------------------------------------------------------------
    function dropdown(options, opts) {
        opts = opts || {};
        var $sel = $('<select>', { 'class': 'steward-dropdown' });
        if (opts.width) $sel.css({ width: opts.width });
        for (var i = 0; i < options.length; i++) {
            var o = options[i];
            var label, value;
            if (typeof o === 'string') { label = o; value = o; }
            else { label = o.label || o.value; value = (typeof o.value === 'undefined' ? label : o.value); }
            var $opt = $('<option>', { value: String(value) }).text(label);
            if (opts.selected !== undefined && String(opts.selected) === String(value)) {
                $opt.attr('selected', 'selected');
            }
            $sel.append($opt);
        }
        if (typeof opts.onChange === 'function') {
            $sel.on('change', function () {
                try { opts.onChange($sel.val()); }
                catch (err) { S.kernel.error('ui', 'dropdown change threw:', err); }
            });
        }
        return $sel;
    }

    // ---------------------------------------------------------------
    // Parchment button.
    // ---------------------------------------------------------------
    function button(label, opts) {
        opts = opts || {};
        var classes = 'steward-btn';
        if (opts.size === 'sm') classes += ' steward-btn-sm';
        var $b = $('<button>', { type: 'button', 'class': classes }).text(label || '');
        if (typeof opts.onClick === 'function') {
            $b.on('click', function (e) {
                e.preventDefault();
                try { opts.onClick(); }
                catch (err) { S.kernel.error('ui', 'button onClick threw:', err); }
            });
        }
        return $b;
    }

    // ---------------------------------------------------------------
    // Decorative bits.
    // ---------------------------------------------------------------
    function helpIcon(text) {
        return $('<span>', { 'class': 'steward-help-i', title: text || '' }).text('i');
    }

    function newBadge() {
        return $('<span>', { 'class': 'steward-new-badge' }).text('NEW');
    }

    // ---------------------------------------------------------------
    // Settings buffer proxy.
    // ---------------------------------------------------------------
    function settings(moduleId) {
        return S.kernel.ui.bufferedSettings(moduleId);
    }

    function update(moduleId, mutatorOrPatch) {
        var s = S.kernel.ui.bufferedSettings(moduleId);
        if (typeof mutatorOrPatch === 'function') {
            try { mutatorOrPatch(s); }
            catch (e) { S.kernel.error('ui', 'update mutator for', moduleId, 'threw:', e); }
        } else if (mutatorOrPatch && typeof mutatorOrPatch === 'object') {
            for (var k in mutatorOrPatch) s[k] = mutatorOrPatch[k];
        }
        S.kernel.ui.markDirty(moduleId);
    }

    // ---------------------------------------------------------------
    // HTML-escape a user string for html() content such as gridRow
    // cells. null/undefined become an empty string.
    // ---------------------------------------------------------------
    function escape(s) {
        if (s === null || typeof s === 'undefined') return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ---------------------------------------------------------------

    if (!S.kernel.ui) S.kernel.ui = {};
    S.kernel.ui.helpers = {
        gridRow:   gridRow,
        headerRow: headerRow,
        formRow:   formRow,
        indentRow: indentRow,
        toggle:    toggle,
        input:     input,
        dropdown:  dropdown,
        button:    button,
        helpIcon:  helpIcon,
        newBadge:  newBadge,
        settings:  settings,
        update:    update,
        escape:    escape
    };

}(Steward));
