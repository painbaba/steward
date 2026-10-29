/*
 * In-game UI shell.
 *
 * Two surfaces:
 *
 *   1. Native menu — pause toggle, status, "Open Dashboard…", module
 *      submenus declared via the register spec's `menu` field (read-only
 *      tools such as the event calculator), then quick toggles. The
 *      dashboard remains the single configuration surface.
 *
 *   2. Dashboard modal — autoTSO-mirror layout:
 *        ┌──────────────────────────────────┐
 *        │ Title bar                        │
 *        ├──────────────────────────────────┤
 *        │ [tab] [tab] [tab] [tab] [tab]    │
 *        ├──────────────────────────────────┤
 *        │ ╔══ section band ═══════════╗    │
 *        │ │  rows… (label | control)  │    │
 *        │ ╚═══════════════════════════╝    │
 *        │ ╔══ section band ═══════════╗    │
 *        │ ╚═══════════════════════════╝    │
 *        ├──────────────────────────────────┤
 *        │ Save                       Close │
 *        └──────────────────────────────────┘
 *      Tabs: Status | Specialists | Quests | Buildings | Events | Tools | Misc
 *      (Mail/Trades is intentionally deferred until those modules ship.)
 *
 *   Module dialogs share the dashboard stylesheet through ensureStyle(id),
 *   which scopes the same rules to each modal id; the scope list is kept on
 *   the <style> element so it survives a script reload.
 *
 * Settings buffer (explicit Save semantics):
 *   - Modal opens → buffer snapshot of each module's settings.
 *   - Modules render via helpers.settings(id) which proxies the buffer.
 *   - Save → flushes dirty modules. Close → discards.
 */

(function (S) {

    // -----------------------------------------------------------------
    // State
    // -----------------------------------------------------------------

    var statusText = 'Steward online';
    var statusItem = null;
    var pauseItem = null;
    var toggleItems = {};
    var initAttempts = 0;
    var initialized = false;
    var paused = false;
    // Set once a script reload has replaced this bundle; blocks a pending
    // init retry from building a second menu for the dead instance.
    var disposed = false;

    // Last label string written per native item ('status', 'pause',
    // 'toggle:<id>'). AIR leaks native objects on every label write, so an
    // unchanged text is never rewritten. Kept in JS because NativeMenuItem is
    // sealed (no expando) and reading item.label back crosses the AIR bridge.
    var lastLabels = {};

    var dashboard = {
        modal:     null,
        modalId:   'StewardDashboard',
        activeTab: null,
        buffer:    {},
        dirty:     {},
        saveBtn:   null
    };

    // The tab order shown in the bar — must match what the registry
    // accepts (see 40_registry.js). Status is built-in; the rest are
    // module-populated. Mail/Trades is omitted (deferred to a later phase).
    // Internal `id` strings stay stable so module ui specs (and the registry's
    // TABS set) don't have to track renames. Only the user-visible `label`
    // changes here.
    var TAB_ORDER = [
        { id: 'status',      label: 'Status' },
        { id: 'specialists', label: 'Explorers' },
        { id: 'geologists',  label: 'Geologists' },
        { id: 'quests',      label: 'Quests' },
        { id: 'buildings',   label: 'Collections & Buildings' },
        { id: 'events',      label: 'Events' },
        { id: 'tools',       label: 'Tools' },
        { id: 'misc',        label: 'Misc' }
    ];

    // -----------------------------------------------------------------
    // Native menu plumbing
    // -----------------------------------------------------------------

    function nativeMenuAvailable() {
        try {
            return typeof window !== 'undefined' &&
                   window.nativeWindow &&
                   window.nativeWindow.menu &&
                   typeof air !== 'undefined' &&
                   air.NativeMenuItem;
        } catch (e) { return false; }
    }

    function removeIfPresent(menu, name) {
        try {
            var existing = menu.getItemByName ? menu.getItemByName(name) : null;
            if (existing) menu.removeItem(existing);
        } catch (e) { /* ignore */ }
    }

    function pauseLabel() { return paused ? 'Steward: ✕ Paused' : 'Steward: ✓ Active'; }

    // Writes `text` to the item's label only when it differs from the last
    // string written to that slot. The cache is updated before the write so
    // an invalidated item that throws is not retried on every status tick.
    function writeLabel(slot, item, text) {
        if (!item || lastLabels[slot] === text) return;
        lastLabels[slot] = text;
        try { item.label = text; } catch (e) { /* invalidated */ }
    }

    // Quick-toggle label, or null when the module has no `enabled` flag (no
    // toggle entry exists for it). Shared by the build and the in-place refresh.
    function toggleLabel(mod) {
        var s = S.kernel.settings.read(mod.id);
        if (!s || typeof s.enabled === 'undefined') return null;
        return (s.enabled ? '✓ ' : '✕ ') + mod.ui.section.title;
    }

    function statusLabel() {
        var n = 0;
        try { n = S.kernel.registry.count(); } catch (e) { /* ignore */ }
        return (paused ? 'Paused' : 'Active') + ' — ' + n + ' module' + (n === 1 ? '' : 's');
    }

    // Adaptive placement: the host's `mainSettings.menuStyle` decides whether
    // we land at the menu-bar root ("grouped") or nested in Tools (anything
    // else). See HOST_INTEGRATION.md.
    function attachContainer() {
        var rootMenu = window.nativeWindow.menu;
        var style = (S.kernel.host && S.kernel.host.menuStyle) ? S.kernel.host.menuStyle() : 'grouped';
        if (style === 'grouped') return { container: rootMenu, mode: 'top-level' };
        try {
            var toolsItem = rootMenu.getItemByName ? rootMenu.getItemByName('Tools') : null;
            if (toolsItem && toolsItem.submenu) {
                return { container: toolsItem.submenu, mode: 'tools' };
            }
        } catch (e) { /* fall through */ }
        return { container: rootMenu, mode: 'top-level' };
    }

    function rebuildNativeMenu() {
        if (!nativeMenuAvailable()) return false;
        try {
            // Fresh items carry their constructor labels; the cache restarts
            // from those so the next tick does not rewrite identical text.
            lastLabels = {};
            var attach = attachContainer();
            var container = attach.container;
            removeIfPresent(container, 'StewardRoot');
            // If mode flipped between rebuilds, also clean the *other* container
            // so we don't leave orphan entries behind.
            if (attach.mode === 'tools') {
                removeIfPresent(window.nativeWindow.menu, 'StewardRoot');
            }

            var root = new air.NativeMenuItem('~Steward~');
            root.name = 'StewardRoot';
            var sub = new air.NativeMenu();

            var pLabel = pauseLabel();
            pauseItem = new air.NativeMenuItem(pLabel);
            lastLabels.pause = pLabel;
            pauseItem.name = 'StewardPause';
            pauseItem.enabled = true;
            try { pauseItem.addEventListener(air.Event.SELECT, togglePause); }
            catch (e) { /* ignore */ }
            sub.addItem(pauseItem);

            try { sub.addItem(new air.NativeMenuItem('', true)); } catch (e) { /* sep */ }

            var sLabel = statusText || statusLabel();
            statusItem = new air.NativeMenuItem(sLabel);
            lastLabels.status = sLabel;
            statusItem.name = 'StewardStatus';
            statusItem.enabled = false;
            sub.addItem(statusItem);

            try { sub.addItem(new air.NativeMenuItem('', true)); } catch (e) { /* sep */ }

            var openItem = new air.NativeMenuItem('Open Dashboard…');
            openItem.name = 'StewardOpenDashboard';
            openItem.enabled = true;
            try { openItem.addEventListener(air.Event.SELECT, function () { openDashboard(); }); }
            catch (e) { /* ignore */ }
            sub.addItem(openItem);

            appendModuleMenus(sub);

            // Per-module quick-toggles. Each enabled-aware module surfaces a
            // single entry showing its current state — clicking flips
            // settings.<id>.enabled and updates the entry's label. autoTSO has the
            // equivalent under "Start/Stop X Auto".
            try { sub.addItem(new air.NativeMenuItem('', true)); } catch (e) { /* sep */ }
            toggleItems = {};
            appendModuleQuickToggles(sub);

            root.submenu = sub;
            container.addItem(root);
            S.kernel.debug('ui', 'menu rebuilt — mode:', attach.mode);
            return true;
        } catch (e) {
            S.kernel.error('ui', 'rebuildNativeMenu failed:', e);
            return false;
        }
    }

    // Rebuilding the native menu leaks native menus in AIR, so after init
    // only the labels of the existing items change, and only when the text
    // differs (unchanged labels are skipped). Also re-syncs labels after an
    // `enabled` flip made outside the menu (dashboard Save, console write).
    function refreshToggleLabels() {
        if (!initialized) return;
        try {
            var mods = S.kernel.registry.withUi();
            for (var i = 0; i < mods.length; i++) {
                var item = toggleItems[mods[i].id];
                if (!item) continue;
                var label = toggleLabel(mods[i]);
                if (label === null) continue;
                writeLabel('toggle:' + mods[i].id, item, label);
            }
        } catch (e) {
            S.kernel.error('ui', 'refreshToggleLabels threw:', e);
        }
    }

    // Surface a quick-toggle for every dashboard-aware module that has an
    // `enabled` settings flag. Click the entry to flip it without opening
    // the modal. Mirrors autoTSO's "Start/Stop X Auto" entries. Modules
    // that don't expose `enabled` (e.g. diagnostics — read-only probes)
    // are skipped automatically.
    function appendModuleQuickToggles(sub) {
        try {
            var mods = S.kernel.registry.withUi();
            for (var i = 0; i < mods.length; i++) {
                appendOneToggle(sub, mods[i]);
            }
        } catch (e) {
            S.kernel.error('ui', 'appendModuleQuickToggles threw:', e);
        }
    }

    // One submenu per module that declares a `menu` in its register spec.
    // Items stay enabled because the native menu is only built once, on
    // init; the module reports "nothing to show" itself.
    function appendModuleMenus(sub) {
        try {
            if (!S.kernel.registry || typeof S.kernel.registry.withMenu !== 'function') return;
            var mods = S.kernel.registry.withMenu();
            for (var i = 0; i < mods.length; i++) {
                appendOneModuleMenu(sub, mods[i]);
            }
        } catch (e) {
            S.kernel.error('ui', 'appendModuleMenus threw:', e);
        }
    }

    function appendOneModuleMenu(sub, mod) {
        var spec = mod.menu;
        var entry = new air.NativeMenuItem(spec.title);
        entry.name = 'StewardModuleMenu_' + mod.id;
        var inner = new air.NativeMenu();
        for (var i = 0; i < spec.items.length; i++) {
            inner.addItem(makeModuleMenuItem(mod, spec.items[i]));
        }
        entry.submenu = inner;
        sub.addItem(entry);
    }

    function makeModuleMenuItem(mod, spec) {
        var item = new air.NativeMenuItem(spec.label);
        item.enabled = true;
        try {
            item.addEventListener(air.Event.SELECT, function () {
                try { spec.onSelect(); }
                catch (e) { S.kernel.error('ui', mod.id, 'menu item threw:', e); }
            });
        } catch (e) { /* ignore */ }
        return item;
    }

    function appendOneToggle(sub, mod) {
        var label = toggleLabel(mod);
        if (label === null) return;
        var item = new air.NativeMenuItem(label);
        item.name = 'StewardModuleToggle_' + mod.id;
        item.enabled = true;
        try {
            item.addEventListener(air.Event.SELECT, function () {
                toggleModuleEnabled(mod.id);
            });
        } catch (e) { /* ignore */ }
        toggleItems[mod.id] = item;
        lastLabels['toggle:' + mod.id] = label;
        sub.addItem(item);
    }

    function toggleModuleEnabled(moduleId) {
        try {
            var s = S.kernel.settings.read(moduleId) || {};
            s.enabled = !s.enabled;
            S.kernel.settings.write(moduleId, s);
            S.kernel.log('ui', 'quick-toggle', moduleId, '→', s.enabled);
            // Cancel pending queue work the moment the user disables a module —
            // matches the buffered-Save flow's behaviour for the same flip.
            if (!s.enabled && S.kernel.queue && S.kernel.queue.cancelByModule) {
                S.kernel.queue.cancelByModule(moduleId);
            }
            refreshToggleLabels();
        } catch (e) {
            S.kernel.error('ui', 'toggleModuleEnabled threw:', e);
        }
    }

    function init() {
        if (disposed) return;
        if (initialized) { rebuildNativeMenu(); return; }
        if (!nativeMenuAvailable()) {
            initAttempts++;
            if (initAttempts >= S.kernel.TIMEOUTS.UI_INIT_MAX_ATTEMPTS) {
                S.kernel.warn('ui', 'native menu unavailable after', initAttempts, 'attempts — giving up');
                return;
            }
            setTimeout(init, S.kernel.TIMEOUTS.UI_INIT_RETRY_MS);
            return;
        }
        initialized = rebuildNativeMenu();
        if (initialized) S.kernel.log('ui', 'menu initialized');
    }

    // -----------------------------------------------------------------
    // Pause control
    // -----------------------------------------------------------------

    function persistPaused() {
        try {
            var s = S.kernel.settings.read('kernel') || {};
            s.paused = paused;
            S.kernel.settings.write('kernel', s);
        } catch (e) { S.kernel.warn('ui', 'failed to persist paused state:', e); }
    }

    function applyPause() {
        try {
            if (paused) {
                if (S.kernel.scheduler && S.kernel.scheduler.stop) S.kernel.scheduler.stop();
                if (S.kernel.queue && S.kernel.queue.reset) S.kernel.queue.reset();
            } else {
                if (S.kernel.scheduler && S.kernel.scheduler.start) S.kernel.scheduler.start();
            }
        } catch (e) { S.kernel.error('ui', 'applyPause threw:', e); }
    }

    function setPaused(value, opts) {
        var next = value === true;
        if (next === paused) return;
        paused = next;
        opts = opts || {};
        S.kernel.log('ui', paused ? 'paused' : 'resumed');
        applyPause();
        if (opts.persist !== false) persistPaused();
        refreshStatus();
    }

    function togglePause() { setPaused(!paused); }
    function isPaused() { return paused; }

    function setStatus(text) {
        statusText = text || '';
        writeLabel('status', statusItem, statusText);
    }

    function refreshStatus() {
        try {
            setStatus(statusLabel());
            writeLabel('pause', pauseItem, pauseLabel());
            refreshToggleLabels();
        } catch (e) { /* ignore */ }
    }

    function isModuleEnabled(moduleId) {
        var s = S.kernel.settings.read(moduleId);
        return !!(s && s.enabled);
    }

    // Surface a transient message to the user via the host's alert system.
    // Best-effort — silently no-ops if the host isn't ready (e.g., very
    // early boot).
    function notify(text) {
        try {
            if (typeof showGameAlert === 'function') {
                showGameAlert('Steward: ' + text);
            }
        } catch (e) { /* best effort */ }
    }

    // -----------------------------------------------------------------
    // Dashboard modal — autoTSO-mirror layout
    // -----------------------------------------------------------------

    // Stylesheet rules without a scope prefix: scopeCss() prefixes every
    // selector with each modal id that shares the look (the dashboard and
    // module dialogs), so the rules exist once. The host's bootstrap.min.css
    // forces .modal-body { height:60% } and a parchment background image;
    // both need overriding with !important.
    var STYLE_ID = 'steward-dashboard-style';
    var STYLE_RULES = [
        // ---- modal frame ----
        // The host paints the wood chrome on .modal-header / .modal-body /
        // .modal-footer (window_top.png + window_middle.png + window_bottom.png).
        // We DON'T override those — autoTSO uses exactly the same chrome
        // and looks great. We only override layout (padding, height) and
        // our colour palette.
        '.modal-dialog{width:1000px;max-width:96%;}',
        '.modal-content{color:#e8e1cf;}',

        // ---- title bar (keep wood background) ----
        '.modal-header{padding:14px 22px 12px !important;' +
            'border-bottom:1px solid rgba(0,0,0,.3);}',
        // Pure white + a soft dark text-shadow so the title pops off the
        // wood regardless of how the host renders window_top.png.
        '.modal-header .modal-title,' +
            '.modal-header h4{color:#fff;font-size:20px;' +
            'font-weight:600;letter-spacing:.3px;margin:0;' +
            'text-shadow:0 1px 2px rgba(0,0,0,.6);}',
        '.modal-header .close{color:#f8f1d9;opacity:.85;' +
            'text-shadow:none;font-size:24px;line-height:1;}',
        '.modal-header .close:hover{color:#fff;opacity:1;}',

        // ---- body (keep wood background, override host .modal-body { height:60%; padding:15px }) ----
        '.modal-body{padding:0 !important;height:auto !important;' +
            'overflow:visible;color:#e8e1cf;}',

        // ---- tab bar ----
        '.steward-tabs{display:block;padding:12px 20px 0;' +
            'border-bottom:1px solid rgba(0,0,0,.3);}',
        '.steward-tabs:after{content:"";display:block;clear:both;height:0;}',
        '.steward-tab{float:left;padding:9px 22px;color:#5dade2;' +
            'text-decoration:none;font-size:15px;font-weight:500;cursor:pointer;' +
            'border-radius:6px 6px 0 0;margin-right:4px;}',
        '.steward-tab:hover{background:rgba(93,173,226,.12);' +
            'color:#5dade2;text-decoration:none;}',
        '.steward-tab.active{background:#3d8fc6;color:#fff;}',
        '.steward-tab.active:hover{background:#3d8fc6;color:#fff;}',

        // ---- panel (per-tab content) ----
        '.steward-panel{padding:16px 22px 20px;height:480px;' +
            'overflow-y:auto;}',

        // ---- section header / form rows ----
        // Sections render as a flat sequence of BS3 rows on the panel.
        // The header row uses cells with the host's `tblHeader` class
        // (parchment + black text + 23px height — defined in
        // bootstrap.min.css). Form rows are plain BS3 .row with col-*
        // cells from gridRow().
        //
        // tblHeader rounded corners are applied to the first / last cell
        // of each header (matches utils.createTableRow output).
        '.steward-row{margin:0;padding:6px 0;font-size:13px;' +
            'color:#e8e1cf;border-bottom:1px solid rgba(0,0,0,.15);}',
        '.steward-row:last-child{border-bottom:none;}',
        '.steward-row-disabled{background:rgba(120,40,30,.25);}',
        '.steward-row-ctl{text-align:right;}',
        '.steward-row-help{color:#a09a85;font-size:11px;' +
            'margin-left:8px;}',
        '.steward-row-hint{color:#b8b0a3;font-size:12px;' +
            'padding-left:18px;}',

        '.tblHeader{padding-top:3px !important;' +
            'padding-bottom:3px !important;line-height:23px;' +
            'font-weight:600;}',
        '.steward-tbl-first{border-radius:10px 0 0 10px;}',
        '.steward-tbl-last{border-radius:0 10px 10px 0;}',
        '.steward-section-title{font-size:14px;color:#000;}',
        '.steward-section-icon{display:inline-block;' +
            'margin-right:4px;}',
        '.steward-section-action{color:#2c5fb5;' +
            'text-decoration:none;font-size:13px;font-weight:500;' +
            'float:right;line-height:23px;}',
        '.steward-section-action:hover{text-decoration:underline;' +
            'color:#2c5fb5;}',

        // Pad the row that follows a tblHeader so the table doesn't feel
        // crammed against the band.
        '.row.steward-row{padding-left:14px;padding-right:14px;}',

        // Idle/busy variants of a per-explorer row — different accent
        // colour without changing the underlying row layout.
        '.row.steward-row-idle{color:#cfe6ce;}',
        '.row.steward-row-busy{color:#d8c89c;}',

        // ---- input / dropdown ----
        '.steward-input,' +
            '.steward-dropdown{background:linear-gradient(180deg,#f5e8c8 0%,#e0c898 100%);' +
            'color:#2a2418;border:1px solid #5a4a30;border-radius:3px;' +
            'padding:5px 10px;font-size:13px;font-family:inherit;' +
            'box-shadow:0 1px 0 rgba(255,255,255,.3) inset;line-height:normal;}',
        '.steward-dropdown{padding-right:24px;cursor:pointer;}',

        // ---- button ----
        '.steward-btn{background:linear-gradient(180deg,#f5e8c8 0%,#e0c898 100%);' +
            'color:#2a2418;border:1px solid #5a4a30;padding:6px 22px;' +
            'border-radius:4px;font-size:13px;font-weight:500;font-family:inherit;' +
            'cursor:pointer;line-height:normal;' +
            'box-shadow:0 1px 0 rgba(255,255,255,.4) inset,0 1px 2px rgba(0,0,0,.3);}',
        '.steward-btn:hover{background:linear-gradient(180deg,#faedd2,#e8d2a8);}',
        '.steward-btn-sm{padding:3px 12px;font-size:12px;}',

        // ---- decorative bits ----
        '.steward-help-i{display:inline-block;width:18px;height:18px;' +
            'border-radius:50%;background:#5dade2;color:#fff;font-style:italic;' +
            'font-size:11px;font-weight:600;line-height:18px;text-align:center;' +
            'margin-left:6px;cursor:help;vertical-align:middle;}',
        '.steward-new-badge{display:inline-block;' +
            'background:linear-gradient(180deg,#e34a3c,#b8362a);color:#fff;' +
            'font-size:9px;font-weight:700;padding:2px 6px;border-radius:8px;' +
            'letter-spacing:.5px;border:1px solid #5a1a14;margin-left:6px;' +
            'vertical-align:middle;}',
        'code{background:rgba(255,255,255,.06);color:#d8d0bd;' +
            'padding:1px 5px;border-radius:2px;font-size:11px;}',
        'strong{color:#f5e9c4;}',

        // ---- footer (keep wood background) ----
        '.modal-footer{padding:12px 22px !important;' +
            'border-top:1px solid rgba(0,0,0,.4);text-align:left;margin:0;}',
        '.modal-footer:after{content:"";display:block;clear:both;height:0;}',
        '.modal-footer .steward-btn{margin:0;}',
        '.modal-footer .steward-btn-save{float:left;}',
        '.modal-footer .steward-btn-close{float:right;}',
        '.modal-footer .steward-btn[disabled]{opacity:.5;cursor:default;}',

        // ---- shared classes for module dialogs ----
        // Sortable lists (jQuery UI) and status colours used by dialogs that
        // borrow this stylesheet through ensureStyle().
        '.steward-list{list-style:none;margin:0;padding:0;}',
        '.steward-list li{padding:5px 8px;margin:2px 0;background:rgba(0,0,0,.18);' +
            'border-radius:4px;cursor:move;}',
        '.steward-list .ui-sortable-placeholder{visibility:visible !important;' +
            'background:rgba(93,173,226,.2);}',
        '.steward-bad{color:#f3a299;}',
        '.steward-warn{color:#f0c47c;}',
        '.steward-ok{color:#9fd8a8;}',
        '.steward-muted{color:#a09a85;}'
    ];

    // Prefix every selector of every rule with '#<id> ' for each id. Only
    // the selector part (before the first '{') is split on ',', so commas
    // inside a body such as linear-gradient(...) stay intact.
    function scopeCss(rules, ids) {
        var out = [];
        for (var r = 0; r < rules.length; r++) {
            var rule = rules[r];
            var brace = rule.indexOf('{');
            if (brace < 0) continue;
            var sels = rule.substring(0, brace).split(',');
            var scoped = [];
            for (var i = 0; i < ids.length; i++) {
                for (var j = 0; j < sels.length; j++) {
                    var sel = sels[j].replace(/^\s+|\s+$/g, '');
                    if (sel) scoped.push('#' + ids[i] + ' ' + sel);
                }
            }
            out.push(scoped.join(',') + rule.substring(brace));
        }
        return out.join('');
    }

    // Scope list for the shared stylesheet: the dashboard first, then the
    // ids already recorded in `attr` (comma-separated) in order, then
    // modalId when new. Empties and duplicates are dropped.
    function mergeScopes(attr, modalId) {
        var list = [dashboard.modalId];
        var parts = attr ? String(attr).split(',') : [];
        parts.push(modalId || '');
        for (var i = 0; i < parts.length; i++) {
            var id = parts[i].replace(/^\s+|\s+$/g, '');
            if (id && list.indexOf(id) < 0) list.push(id);
        }
        return list;
    }

    // Make the shared stylesheet cover modalId. The scope list lives on the
    // <style> element (data-scopes), not in this closure: after a script
    // reload the new bundle starts with fresh closures while the old element
    // and any open dialog stay in the page, so a closure list would drop a
    // dialog's scope. The element is looked up by id on every call and only
    // rewritten when its scope list changes.
    function ensureStyle(modalId) {
        var el = document.getElementById(STYLE_ID);
        var current = el ? el.getAttribute('data-scopes') : '';
        var key = mergeScopes(current, modalId).join(',');
        if (el && current === key) return;
        var css = scopeCss(STYLE_RULES, key.split(','));
        if (!el) {
            var $style = $('<style>', { type: 'text/css', id: STYLE_ID });
            el = $style[0];
            if (el.styleSheet) el.styleSheet.cssText = css;
            else               el.appendChild(document.createTextNode(css));
            $('head').append($style);
        } else if (el.styleSheet) {
            el.styleSheet.cssText = css;
        } else {
            while (el.firstChild) el.removeChild(el.firstChild);
            el.appendChild(document.createTextNode(css));
        }
        el.setAttribute('data-scopes', key);
    }

    function openDashboard(initialTabId) {
        if (typeof Modal === 'undefined') {
            S.kernel.error('ui', 'host Modal class unavailable — cannot open dashboard');
            return;
        }
        ensureStyle(dashboard.modalId);
        dashboard.buffer = {};
        dashboard.dirty = {};
        dashboard.activeTab = initialTabId || 'specialists';
        try {
            dashboard.modal = new Modal(dashboard.modalId, 'Steward — Auto Settings', true);
            dashboard.modal.create();
            renderDashboard();
            dashboard.modal.show();
        } catch (e) {
            S.kernel.error('ui', 'openDashboard threw:', e);
        }
    }

    function closeDashboard(commit) {
        if (commit && hasDirty()) {
            flushBuffers();
            notify('Configuration saved');
        } else if (!commit && hasDirty()) {
            // Notify modules that buffered changes were thrown away so they
            // can repaint any stale state derived from the buffer.
            for (var moduleId in dashboard.dirty) {
                if (!dashboard.dirty[moduleId]) continue;
                var mod = S.kernel.registry.get(moduleId);
                if (mod && mod.ui && mod.ui.section && typeof mod.ui.section.onCancel === 'function') {
                    try { mod.ui.section.onCancel(); }
                    catch (e) { S.kernel.error('ui', moduleId, 'onCancel threw:', e); }
                }
            }
        }
        dashboard.buffer = {};
        dashboard.dirty = {};
        if (dashboard.modal) {
            try { dashboard.modal.hide(); } catch (e) { /* ignore */ }
        }
    }

    function renderDashboard() {
        if (!dashboard.modal) return;
        var $body = dashboard.modal.Body();
        if (!$body || !$body.length) return;
        $body.empty();

        // Tab bar.
        var $tabs = $('<div>', { 'class': 'steward-tabs' });
        for (var i = 0; i < TAB_ORDER.length; i++) {
            (function (tab) {
                var $a = $('<a>', {
                    'href':       '#',
                    'class':      'steward-tab' + (tab.id === dashboard.activeTab ? ' active' : ''),
                    'data-tab':   tab.id
                }).text(tab.label);
                $a.on('click', function (e) {
                    e.preventDefault();
                    activateTab(tab.id);
                });
                $tabs.append($a);
            }(TAB_ORDER[i]));
        }
        $body.append($tabs);

        // Panel container.
        $body.append($('<div>', { 'class': 'steward-panel', 'id': 'steward-panel' }));

        renderFooter();
        activateTab(dashboard.activeTab);
    }

    function activateTab(tabId) {
        var $body = dashboard.modal.Body();
        $('.steward-tab', $body).removeClass('active');
        $('.steward-tab[data-tab="' + tabId + '"]', $body).addClass('active');
        dashboard.activeTab = tabId;

        var $panel = $('#steward-panel', $body);
        $panel.empty();
        // BS3 .row carries negative side margins; wrap in container-fluid
        // so the rows align with the panel edges instead of overflowing.
        var $container = $('<div>', { 'class': 'container-fluid' });
        $panel.append($container);

        if (tabId === 'status') {
            renderStatusTab($container);
        } else {
            renderModuleTab($container, tabId);
        }
    }

    function renderModuleTab($panel, tabId) {
        var h = S.kernel.ui.helpers;
        var mods = S.kernel.registry.byTab(tabId);
        if (!mods.length) {
            $panel.append(h.headerRow('No modules in this tab yet.'));
            return;
        }
        for (var i = 0; i < mods.length; i++) {
            renderSection($panel, mods[i]);
        }
    }

    // The shell builds the section's header row from the ui spec, then hands
    // the panel + helpers to the module so it can append its data rows.
    // Modules append directly to $panel — same flat sequence-of-rows layout
    // autoTSO uses (createTableRow per row, header rows interleaved).
    function renderSection($panel, mod) {
        var sec = mod.ui.section;
        var h = S.kernel.ui.helpers;

        $panel.append(h.headerRow(sec.title, {
            icon:   sec.icon,
            action: sec.action || null
        }));

        try {
            sec.render($panel, h);
        } catch (e) {
            S.kernel.error('ui', 'render threw for', mod.id, ':', e);
            $panel.append(h.formRow('Render failed — see log.', ''));
        }

        // Visual separator between sections — empty row.
        $panel.append($('<div>', { 'class': 'steward-section-spacer' })
            .css({ height: '10px' }));
    }

    // Render one event in the Status tab's "Active events" section.
    // Surfaces:
    //   - the event display name (Easter, XMAS, …)
    //   - phase: "Treasure phase" (green) when items are dropping,
    //            "Event Cooldown" (amber) when only the shop variant is
    //            live, otherwise the raw category list
    //   - the resource currency + the player's current count
    function renderEventRow(ev, h) {
        var $lbl = $('<span>');
        $lbl.append($('<strong>').text(ev.name));
        $lbl.append(document.createTextNode(' — '));

        var inTreasure = !!(ev.categories && ev.categories.treasure);
        var inCooldown = !!(ev.categories && ev.categories.shop && !inTreasure);
        var $phase;
        if (inTreasure) {
            $phase = $('<span>').css({ color: '#6cba5d', fontWeight: '600' })
                .text('Treasure phase');
        } else if (inCooldown) {
            $phase = $('<span>').css({ color: '#e8a64a', fontWeight: '600' })
                .text('Cooldown Phase');
        } else {
            $phase = $('<span>').text((ev.categoryList || []).join(', ') || 'live');
        }
        $lbl.append($phase);

        var $rhs = $('<span>');
        var resource = null;
        try {
            if (S.core.events.eventResource) {
                resource = S.core.events.eventResource(ev.code) || null;
            }
        } catch (e) { /* ignore */ }
        if (resource) {
            $rhs.append($('<code>').text(resource));
            var amount = null;
            try {
                if (S.core.events.eventResourceAmount) {
                    amount = S.core.events.eventResourceAmount(ev.code);
                }
            } catch (e) { /* ignore */ }
            if (typeof amount === 'number') {
                $rhs.append(document.createTextNode(' · '));
                $rhs.append($('<strong>').text(String(amount)));
                $rhs.append(document.createTextNode(' held'));
            }
        }
        return h.formRow($lbl, $rhs);
    }

    // -----------------------------------------------------------------
    // Status tab — built into the shell, not a module.
    // -----------------------------------------------------------------

    function renderStatusTab($panel) {
        var h = S.kernel.ui.helpers;

        // ---- Section: Steward Status ----
        $panel.append(h.headerRow('Steward Status', { icon: '★' }));

        $panel.append(h.formRow('Master pause', h.toggle({
            checked:  paused,
            onChange: function (next) { setPaused(next); }
        })));

        var withUi = S.kernel.registry.withUi();
        var enabledNames = [];
        for (var i = 0; i < withUi.length; i++) {
            if (isModuleEnabled(withUi[i].id)) enabledNames.push(withUi[i].ui.section.title);
        }
        var $modText = $('<span>');
        $modText.append($('<strong>').text(enabledNames.length));
        $modText.append(document.createTextNode(' of ' + withUi.length + ' enabled'));
        if (enabledNames.length) {
            $modText.append(document.createTextNode(' · ' + enabledNames.join(', ')));
        }
        $panel.append(h.formRow('Modules running', $modText));

        $panel.append(h.formRow('Queue depth', String(S.kernel.queue.depth())));
        $panel.append(h.formRow('Tick interval',
            S.kernel.scheduler.state.tickIntervalMs + ' ms'));
        var ver = S.kernel.VERSION;
        var verLabel = (typeof ver === 'string' && /^\d/.test(ver)) ? 'v' + ver : 'dev';
        $panel.append(h.formRow('Build', $('<code>').text(verLabel)));

        $panel.append($('<div>').css({ height: '10px' }));

        // ---- Section: Active events ----
        try {
            if (S.core.events && S.core.events.active) {
                var ev = S.core.events.active();
                $panel.append(h.headerRow('Active events', { icon: '⚑' }));
                if (ev.length === 0) {
                    $panel.append(h.formRow(
                        $('<em>').css({ color: '#a09a85' }).text('No events live.'),
                        ''));
                } else {
                    for (var k = 0; k < ev.length; k++) {
                        $panel.append(renderEventRow(ev[k], h));
                    }
                }
            }
        } catch (e) { /* ignore */ }
    }

    // -----------------------------------------------------------------
    // Footer
    // -----------------------------------------------------------------

    function renderFooter() {
        var $footer = dashboard.modal.Footer ? dashboard.modal.Footer() : null;
        if (!$footer || !$footer.length) return;
        $footer.empty();
        dashboard.saveBtn = $('<button>', {
            'type':  'button',
            'class': 'steward-btn steward-btn-save',
            'text':  'Save'
        });
        var $closeBtn = $('<button>', {
            'type':  'button',
            'class': 'steward-btn steward-btn-close',
            'text':  'Close'
        });
        dashboard.saveBtn.on('click', function () { closeDashboard(true); });
        $closeBtn.on('click', function () { closeDashboard(false); });
        $footer.append(dashboard.saveBtn).append($closeBtn);
        updateFooterButtons();
    }

    function hasDirty() {
        for (var k in dashboard.dirty) {
            if (dashboard.dirty[k]) return true;
        }
        return false;
    }

    function updateFooterButtons() {
        if (!dashboard.saveBtn) return;
        dashboard.saveBtn.prop('disabled', !hasDirty());
    }

    function flushBuffers() {
        for (var moduleId in dashboard.buffer) {
            if (!dashboard.dirty[moduleId]) continue;
            try {
                S.kernel.settings.write(moduleId, dashboard.buffer[moduleId]);
                S.kernel.log('ui', 'saved settings for', moduleId);
                var mod = S.kernel.registry.get(moduleId);
                if (mod && mod.ui && mod.ui.section &&
                        typeof mod.ui.section.onSave === 'function') {
                    try { mod.ui.section.onSave(); }
                    catch (e) { S.kernel.error('ui', moduleId, 'onSave threw:', e); }
                }
            } catch (e) {
                S.kernel.error('ui', 'failed to save', moduleId, ':', e);
            }
        }
    }

    // -----------------------------------------------------------------
    // Settings buffer
    // -----------------------------------------------------------------

    function bufferedSettings(moduleId) {
        if (!dashboard.buffer[moduleId]) {
            var stored = S.kernel.settings.read(moduleId) || {};
            var snap = {};
            for (var k in stored) snap[k] = stored[k];
            dashboard.buffer[moduleId] = snap;
        }
        return dashboard.buffer[moduleId];
    }

    function markDirty(moduleId) {
        dashboard.dirty[moduleId] = true;
        updateFooterButtons();
    }

    // -----------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------

    if (!S.kernel.ui) S.kernel.ui = {};
    S.kernel.ui.init             = init;
    S.kernel.ui.status           = {
        set:     setStatus,
        get:     function () { return statusText; },
        refresh: refreshStatus
    };
    S.kernel.ui.pause            = function () { setPaused(true); };
    S.kernel.ui.resume           = function () { setPaused(false); };
    S.kernel.ui.toggle           = togglePause;
    S.kernel.ui.isPaused         = isPaused;
    S.kernel.ui.seedPaused       = function (v) { paused = v === true; refreshStatus(); };

    S.kernel.ui.openDashboard    = openDashboard;
    S.kernel.ui.closeDashboard   = closeDashboard;
    S.kernel.ui.bufferedSettings = bufferedSettings;
    S.kernel.ui.markDirty        = markDirty;

    S.kernel.ui.ensureStyle      = ensureStyle;
    S.kernel.ui.scopeCss         = scopeCss;
    S.kernel.ui.mergeScopes      = mergeScopes;

    var statusUpdater = setInterval(refreshStatus, S.kernel.TIMEOUTS.STATUS_UPDATE_MS);

    function stopStatusUpdater() {
        if (statusUpdater) { clearInterval(statusUpdater); statusUpdater = null; }
    }

    // Called by lifecycle shutdown when a script reload replaces this bundle:
    // stops the status interval and keeps a pending init retry from building
    // a menu for this dead instance.
    function dispose() {
        disposed = true;
        stopStatusUpdater();
    }

    S.kernel.ui.stopStatusUpdater = stopStatusUpdater;
    S.kernel.ui.dispose           = dispose;

}(Steward));
