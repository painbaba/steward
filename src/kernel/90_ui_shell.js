/*
 * In-game UI shell.
 *
 * Three surfaces:
 *
 *   1. Native menu — pause toggle, status, "Open Dashboard…", module
 *      submenus declared via the register spec's `menu` field (read-only
 *      tools such as the event calculator), quick toggles, then
 *      "Settings…". The dashboard and the Settings modal are the
 *      configuration surfaces. Module submenus are built at init; a
 *      module may rebuild its own inner submenu on a user action, and
 *      label functions refresh in place.
 *      A module may also declare a `barMenu`: one more root item right
 *      after ~Steward~, built the same way but refreshed when it opens
 *      instead of on the status tick. An entry may stay out of the bar
 *      (its `visible` function) and be moved in and out with showBarMenu.
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
 *      Tabs: Status | Explorers | Geologists | Quests | Collections & Buildings | Events
 *      (Mail/Trades is intentionally deferred until those modules ship.)
 *
 *   3. Settings modal — same frame with no tab bar: the kernel Logging and
 *      Scheduler sections, then the `misc` module sections. It shares the
 *      dashboard's settings buffer and footer.
 *
 *   Module dialogs share the dashboard stylesheet through ensureStyle(id),
 *   which scopes the same rules to each modal id; the scope list is kept on
 *   the <style> element so it survives a script reload.
 *
 * Settings buffer (explicit Save semantics):
 *   - Either modal (dashboard or Settings) opens → one buffer, snapshotting
 *     each module's settings on first use.
 *   - Modules render via helpers.settings(id) which proxies the buffer.
 *   - Save → flushes dirty modules and applies the logger and scheduler
 *     settings through lifecycle.applySettings. Close → discards.
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
    // The same per slot for the enabled flag of items with a live `enabled`
    // function, for the same reason.
    var lastEnabled = {};

    // Module submenus: the ~Steward~ entry item per module id, so one
    // module's inner submenu can be swapped without touching the rest, and
    // per module id the items whose label or enabled flag is a function, as
    // [{ slot, item, fn, enabledFn }], refreshed in place on the status tick.
    var moduleEntries = {};
    var moduleLabels = {};

    // Bar menus: the root entry item and the same records per module id.
    // Their records are kept apart from moduleLabels so the status tick
    // never reads or writes them.
    var BAR_PREFIX = 'StewardBarMenu_';
    var barEntries = {};
    var barLabels = {};
    var barContainer = null;   // where the entries live, for showBarMenu
    var barShown = {};         // id -> whether the entry is in the bar now

    var dashboard = {
        modal:     null,
        modalId:   'StewardDashboard',
        activeTab: null,
        buffer:    {},
        dirty:     {},
        editing:   false,
        saveBtn:   null
    };

    // The tab order shown in the bar. Status is built-in; every other id is
    // in the registry's TABS (see 40_registry.js). `misc` is the exception
    // that has no tab here: it renders on the Settings screen. Mail/Trades
    // is omitted (deferred to a later phase).
    // Internal `id` strings stay stable so module ui specs (and the registry's
    // TABS set) don't have to track renames. Only the user-visible `label`
    // changes here.
    var TAB_ORDER = [
        { id: 'status',      label: 'Status' },
        { id: 'specialists', label: 'Explorers' },
        { id: 'geologists',  label: 'Geologists' },
        { id: 'quests',      label: 'Quests' },
        { id: 'buildings',   label: 'Collections & Buildings' },
        { id: 'events',      label: 'Events' }
    ];

    // A second id, not the dashboard's: the host's create() is a no-op for a
    // live id and removes a closed modal asynchronously, so one id reused
    // with another title and layout would race.
    var SETTINGS_MODAL_ID = 'StewardSettings';

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

    // The enabled-flag twin of writeLabel.
    function writeEnabled(slot, item, on) {
        if (!item || lastEnabled[slot] === on) return;
        lastEnabled[slot] = on;
        try { item.enabled = on; } catch (e) { /* invalidated */ }
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
            lastEnabled = {};
            moduleEntries = {};
            moduleLabels = {};
            barEntries = {};
            barLabels = {};
            barShown = {};
            var attach = attachContainer();
            var container = attach.container;
            removeIfPresent(container, 'StewardRoot');
            removeBarMenus(container);
            // If mode flipped between rebuilds, also clean the *other* container
            // so we don't leave orphan entries behind.
            if (attach.mode === 'tools') {
                removeIfPresent(window.nativeWindow.menu, 'StewardRoot');
                removeBarMenus(window.nativeWindow.menu);
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

            try { sub.addItem(new air.NativeMenuItem('', true)); } catch (e) { /* sep */ }

            var settingsItem = new air.NativeMenuItem('Settings…');
            settingsItem.name = 'StewardOpenSettings';
            settingsItem.enabled = true;
            try { settingsItem.addEventListener(air.Event.SELECT, function () { openSettings(); }); }
            catch (e) { /* ignore */ }
            sub.addItem(settingsItem);

            root.submenu = sub;
            container.addItem(root);
            appendBarMenus(container);
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

    // One submenu per module that declares a `menu` in its register spec,
    // built at init. An actionable item stays enabled (the module reports
    // "nothing to show" itself) unless its `enabled` is a function; after
    // init only label and enabled functions change, in place, unless the
    // module rebuilds its own submenu on a user action.
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
        var entry = new air.NativeMenuItem(mod.menu.title);
        entry.name = 'StewardModuleMenu_' + mod.id;
        entry.submenu = buildModuleInner(mod, mod.menu, mod.id, moduleLabels);
        moduleEntries[mod.id] = entry;
        sub.addItem(entry);
    }

    function barModules() {
        if (!S.kernel.registry || typeof S.kernel.registry.withBarMenu !== 'function') return [];
        return S.kernel.registry.withBarMenu();
    }

    function removeBarMenus(menu) {
        var mods = barModules();
        for (var i = 0; i < mods.length; i++) {
            removeIfPresent(menu, BAR_PREFIX + mods[i].id);
        }
    }

    // One root item per module that declares a `barMenu`, after ~Steward~.
    // Each is guarded on its own: a bad bar menu must never fail the
    // ~Steward~ build, which has already been added at this point.
    function appendBarMenus(container) {
        barContainer = container;
        var mods = barModules();
        for (var i = 0; i < mods.length; i++) {
            try {
                var entry = new air.NativeMenuItem(mods[i].barMenu.title);
                entry.name = BAR_PREFIX + mods[i].id;
                entry.submenu = buildBarInner(mods[i]);
                barEntries[mods[i].id] = entry;
                if (barVisible(mods[i])) {
                    container.addItem(entry);
                    barShown[mods[i].id] = true;
                } else {
                    barShown[mods[i].id] = false;
                }
            } catch (e) {
                S.kernel.error('ui', mods[i].id, 'bar menu failed:', e);
            }
        }
    }

    // A module without a `visible` function is always in the bar. A throwing
    // one counts as shown so its controls stay reachable.
    function barVisible(mod) {
        if (!mod.barMenu.visible) return true;
        try {
            return mod.barMenu.visible() === true;
        } catch (e) {
            S.kernel.error('ui', mod.id, 'bar menu visible failed:', e);
            return true;
        }
    }

    // Puts an entry right after ~Steward~ so the bar order stays the same
    // however often it is hidden and shown. Falls back to the end of the bar
    // when this host lacks the positional calls.
    function placeBarEntry(entry) {
        var root = barContainer.getItemByName ? barContainer.getItemByName('StewardRoot') : null;
        if (root && barContainer.addItemAt && barContainer.getItemIndex) {
            try {
                barContainer.addItemAt(entry, barContainer.getItemIndex(root) + 1);
                return;
            } catch (e) {
                S.kernel.warn('ui', 'bar menu addItemAt failed, appending:', e);
            }
        } else {
            S.kernel.warn('ui', 'bar menu position unavailable, appending');
        }
        barContainer.addItem(entry);
    }

    // Moves a built entry in or out of the bar. Moving creates no native
    // object, unlike a rebuild, so this may run from plan(). True only when
    // it moved the item.
    function showBarMenu(id, on) {
        if (!initialized || disposed || !barContainer) return false;
        var entry = barEntries[id];
        if (!entry) return false;
        var want = on === true;
        if (barShown[id] === want) return false;
        try {
            if (want) placeBarEntry(entry);
            else barContainer.removeItem(entry);
            barShown[id] = want;
            return true;
        } catch (e) {
            S.kernel.error('ui', id, 'bar menu show failed:', e);
            return false;
        }
    }

    function buildBarInner(mod) {
        var inner = buildModuleInner(mod, mod.barMenu, mod.id + '#bar', barLabels);
        addOpenRefresh(mod, inner);
        return inner;
    }

    // Refreshes a bar menu's records when it opens. Neither open event is
    // proven to fire in this host, so both are registered; the second pass
    // writes nothing because writes happen only on change. A host without
    // either keeps the state of the last build. An open menu shows the state
    // at opening, which is safe because every command guards itself.
    function addOpenRefresh(mod, inner) {
        function onOpen() {
            if (disposed) return;
            try {
                var current = S.kernel.registry.get(mod.id);
                var recs = barLabels[mod.id];
                if (current && recs) refreshRecords(current, recs);
            } catch (e) {
                S.kernel.error('ui', mod.id, 'bar menu refresh threw:', e);
            }
        }
        var types = [air.Event.PREPARING, air.Event.DISPLAYING];
        for (var i = 0; i < types.length; i++) {
            if (typeof types[i] === 'undefined') continue;
            try { inner.addEventListener(types[i], onOpen); }
            catch (e) { /* ignore */ }
        }
    }

    // The menu's item list: a static array was normalised at register
    // time; an `items` function is evaluated now and its result goes
    // through the same registry normalisation.
    function moduleMenuItems(mod, menu) {
        var items = menu.items;
        if (typeof items !== 'function') return items;
        var raw;
        try { raw = items(); }
        catch (e) {
            S.kernel.error('ui', mod.id, 'menu items threw:', e);
            raw = [];
        }
        return S.kernel.registry.menuItems(mod.id, raw);
    }

    // Text of a label function. A throwing one must not break the menu
    // build or the status tick, so it yields an empty label.
    function labelText(mod, fn, pass) {
        try { return String(fn(pass)); }
        catch (e) {
            S.kernel.error('ui', mod.id, 'menu label threw:', e);
            return '';
        }
    }

    // Value of an enabled function. A throwing one must not break the menu
    // build or a refresh; the item goes disabled, the safe side for a control.
    function enabledValue(mod, fn, pass) {
        try { return fn(pass) === true; }
        catch (e) {
            S.kernel.error('ui', mod.id, 'menu enabled threw:', e);
            return false;
        }
    }

    function addModuleSelect(mod, item, onSelect) {
        try {
            item.addEventListener(air.Event.SELECT, function () {
                try { onSelect(); }
                catch (e) { S.kernel.error('ui', mod.id, 'menu item threw:', e); }
            });
        } catch (e) { /* ignore */ }
    }

    function dropSlots(cache, prefix) {
        var stale = [];
        var slot;
        for (slot in cache) {
            if (cache.hasOwnProperty(slot) && slot.indexOf(prefix) === 0) stale.push(slot);
        }
        for (var n = 0; n < stale.length; n++) delete cache[stale[n]];
    }

    // Builds an inner NativeMenu from `menu`. `key` names its slots (the ':'
    // after it keeps a module's submenu and bar menu slots disjoint) and
    // `store` receives its records. Its slots are dropped from both caches
    // first and then seeded with the constructor values, so the new items are
    // not rewritten on the next refresh and no stale value from the previous
    // items suppresses a needed write.
    function buildModuleInner(mod, menu, key, store) {
        var prefix = 'mod:' + key + ':';
        dropSlots(lastLabels, prefix);
        dropSlots(lastEnabled, prefix);

        var records = [];
        var pass = {};
        var items = moduleMenuItems(mod, menu);
        var inner = new air.NativeMenu();
        for (var k = 0; k < items.length; k++) {
            var spec = items[k];
            if (spec.separator) {
                try { inner.addItem(new air.NativeMenuItem('', true)); } catch (e) { /* sep */ }
                continue;
            }
            var isFn = typeof spec.label === 'function';
            var text = isFn ? labelText(mod, spec.label, pass) : spec.label;
            var liveOn = typeof spec.enabled === 'function';
            var on = liveOn ? enabledValue(mod, spec.enabled, pass) : spec.enabled !== false;
            var item = new air.NativeMenuItem(text);
            item.enabled = on;
            if (spec.onSelect) addModuleSelect(mod, item, spec.onSelect);
            if (isFn) lastLabels[prefix + k] = text;
            if (liveOn) lastEnabled[prefix + k] = on;
            if (isFn || liveOn) {
                records.push({
                    slot:      prefix + k,
                    item:      item,
                    fn:        isFn ? spec.label : null,
                    enabledFn: liveOn ? spec.enabled : null
                });
            }
            inner.addItem(item);
        }
        store[mod.id] = records;
        return inner;
    }

    // Rebuilds a submenu when its item set changed and assigns it to the
    // existing entry. Each rebuild leaks native objects in AIR, so modules
    // call this on a user action only, never on a timer.
    function swapSubmenu(what, id, entry, build) {
        try {
            entry.submenu = build();
            S.kernel.debug('ui', what, 'rebuilt:', id);
            return true;
        } catch (e) {
            S.kernel.error('ui', what, 'rebuild failed:', id, e);
            return false;
        }
    }

    function refreshModuleMenu(id) {
        if (!initialized || disposed) return false;
        var mod = S.kernel.registry.get(id);
        var entry = moduleEntries[id];
        if (!mod || !mod.menu || !entry) return false;
        return swapSubmenu('module menu', id, entry, function () {
            return buildModuleInner(mod, mod.menu, mod.id, moduleLabels);
        });
    }

    function refreshBarMenu(id) {
        if (!initialized || disposed) return false;
        var mod = S.kernel.registry.get(id);
        var entry = barEntries[id];
        if (!mod || !mod.barMenu || !entry) return false;
        return swapSubmenu('bar menu', id, entry, function () {
            return buildBarInner(mod);
        });
    }

    // Re-evaluates a module's records and writes only what changed. One
    // fresh `pass` per refresh lets its functions share an expensive read.
    function refreshRecords(mod, recs) {
        var pass = {};
        for (var i = 0; i < recs.length; i++) {
            var rec = recs[i];
            if (rec.fn) writeLabel(rec.slot, rec.item, labelText(mod, rec.fn, pass));
            if (rec.enabledFn) writeEnabled(rec.slot, rec.item, enabledValue(mod, rec.enabledFn, pass));
        }
    }

    function refreshModuleLabels() {
        if (!initialized) return;
        try {
            for (var id in moduleLabels) {
                if (!moduleLabels.hasOwnProperty(id)) continue;
                var mod = S.kernel.registry.get(id);
                if (!mod) continue;
                refreshRecords(mod, moduleLabels[id]);
            }
        } catch (e) {
            S.kernel.error('ui', 'refreshModuleLabels threw:', e);
        }
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
            refreshModuleLabels();
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

    // The one open sequence: the refusal and the buffer reset live here so a
    // second screen cannot drift from the first.
    function openScreen(modalId, title, label, activeTab, render) {
        if (typeof Modal === 'undefined') {
            S.kernel.error('ui', 'host Modal class unavailable — cannot open ' + label.toLowerCase());
            return;
        }
        if (hasOpenEdits()) { notify('Save or close the open window first'); return; }
        ensureStyle(modalId);
        dashboard.buffer = {};
        dashboard.dirty = {};
        dashboard.editing = false;
        dashboard.activeTab = activeTab;
        try {
            dashboard.modal = new Modal(modalId, title, true);
            dashboard.modal.create();
            render();
            dashboard.modal.show();
        } catch (e) {
            S.kernel.error('ui', 'open' + label + ' threw:', e);
        }
    }

    function openDashboard(initialTabId) {
        openScreen(dashboard.modalId, 'Steward — Auto Settings', 'Dashboard',
            initialTabId || 'specialists', renderDashboard);
    }

    function openSettings() {
        openScreen(SETTINGS_MODAL_ID, 'Steward — Settings', 'Settings', null, renderSettings);
    }

    function closeDashboard(commit) {
        if (commit && hasDirty()) {
            flushBuffers();
            notify('Configuration saved');
        }
        dashboard.buffer = {};
        dashboard.dirty = {};
        dashboard.editing = false;
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

        $panel.append(sectionSpacer());
    }

    // Visual separator between sections — empty row.
    function sectionSpacer() {
        return $('<div>', { 'class': 'steward-section-spacer' }).css({ height: '10px' });
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
    // Settings screen — built into the shell like the Status tab. Rows
    // write through h.update, so Save and Close work as on the dashboard.
    // -----------------------------------------------------------------

    // The number typed, or null for blank, non-numeric or negative input.
    function parseNumber(text) {
        var t = String(text).replace(/^\s+|\s+$/g, '');
        if (t === '') return null;
        var n = Number(t);
        return (isFinite(n) && n >= 0) ? n : null;
    }

    // Each returns the stored unit, or null when the input is rejected.
    var settingsParse = {
        sizeKB: function (text) {
            var n = parseNumber(text);
            return n === null ? null : Math.round(n * 1024);
        },
        keep: function (text) {
            var n = parseNumber(text);
            return n === null ? null : Math.floor(n);
        },
        tickMs: function (text) {
            var n = parseNumber(text);
            if (n === null) return null;
            return Math.max(S.kernel.TIMEOUTS.TICK_INTERVAL_MIN_MS, Math.round(n * 1000));
        }
    };

    function showMB(kb) { return Math.round(kb / 1024 * 100) / 100; }
    function showCount(n) { return n; }
    function showSeconds(ms) { return ms / 1000; }

    // Text input bound to a number. A rejected entry reverts and a clamped
    // one shows the clamped value. h.input enables Save while typing, and the
    // blur change event from the Save click still runs before the flush.
    function numberInput(ns, key, value, parse, show) {
        var h = S.kernel.ui.helpers;
        var current = value;
        var $i = h.input({ value: show(value), width: '70px', onChange: function (text) {
            var next = parse(text);
            if (next !== null) {
                current = next;
                var patch = {};
                patch[key] = next;
                h.update(ns, patch);
            }
            $i.val(show(current));
        } });
        return $i;
    }

    function loggerToggle(key, checked) {
        var h = S.kernel.ui.helpers;
        return h.toggle({
            checked:  checked,
            onChange: function (next) {
                var patch = {};
                patch[key] = next;
                h.update('logger', patch);
            }
        });
    }

    function renderLoggingSection($panel) {
        var h = S.kernel.ui.helpers;
        var cfg = S.kernel.log.effective();

        $panel.append(h.headerRow('Logging', { icon: '✎' }));
        $panel.append(h.formRow('Debug lines', loggerToggle('debugEnabled', cfg.debugEnabled)));
        $panel.append(h.formRow('Write to file', loggerToggle('fileEnabled', cfg.fileEnabled)));
        $panel.append(h.formRow('Rotate at size (MB)',
            numberInput('logger', 'maxFileSizeKB', cfg.maxFileSizeKB, settingsParse.sizeKB, showMB),
            '0 = off'));
        $panel.append(h.formRow('Rotate daily', loggerToggle('rotateDaily', cfg.rotateDaily)));
        $panel.append(h.formRow('Old files to keep',
            numberInput('logger', 'keepRotated', cfg.keepRotated, settingsParse.keep, showCount),
            '0 = none'));
        $panel.append(sectionSpacer());
    }

    function renderSchedulerSection($panel) {
        var h = S.kernel.ui.helpers;

        $panel.append(h.headerRow('Scheduler', { icon: '⏱' }));
        // `tickInterval` in ms is the key scheduler.configure reads.
        $panel.append(h.formRow('Tick interval (seconds)',
            numberInput('scheduler', 'tickInterval', S.kernel.scheduler.state.tickIntervalMs,
                settingsParse.tickMs, showSeconds),
            'minimum ' + showSeconds(S.kernel.TIMEOUTS.TICK_INTERVAL_MIN_MS)));
        $panel.append(sectionSpacer());
    }

    function renderSettings() {
        if (!dashboard.modal) return;
        var $body = dashboard.modal.Body();
        if (!$body || !$body.length) return;
        $body.empty();

        var h = S.kernel.ui.helpers;
        var $panel = $('<div>', { 'class': 'steward-panel' });
        // Same wrapper as activateTab: BS3 .row needs container-fluid.
        var $container = $('<div>', { 'class': 'container-fluid' });
        $panel.append($container);
        $body.append($panel);

        $container.append(h.indentRow('Logging and scheduler changes apply on Save. ' +
            'Diagnostics buttons run at once.'));
        renderLoggingSection($container);
        renderSchedulerSection($container);
        renderModuleTab($container, 'misc');

        renderFooter();
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

    // The native menu stays clickable behind a modal, and opening a screen
    // drops the buffer. Visibility matters because the header X and a zone
    // load skip closeDashboard and leave a stale dirty flag behind.
    function hasOpenEdits() {
        return hasDirty() && dashboard.modal && dashboard.modal.Body().is(':visible');
    }

    // Typing alone enables Save: a bound input commits on blur, and a disabled
    // button would swallow the very click whose blur commits the value.
    function canSave() {
        return hasDirty() || dashboard.editing === true;
    }

    function updateFooterButtons() {
        if (!dashboard.saveBtn) return;
        dashboard.saveBtn.prop('disabled', !canSave());
    }

    function flushBuffers() {
        for (var moduleId in dashboard.buffer) {
            if (!dashboard.dirty[moduleId]) continue;
            try {
                S.kernel.settings.write(moduleId, dashboard.buffer[moduleId]);
                S.kernel.log('ui', 'saved settings for', moduleId);
                var apply = S.kernel.lifecycle.applySettings[moduleId];
                if (typeof apply === 'function') apply();
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

    // An input is being typed into but has not committed yet; the flag only
    // enables Save so the committing click reaches it, it never marks dirty.
    function markEditing() {
        dashboard.editing = true;
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
    S.kernel.ui.refreshModuleMenu = refreshModuleMenu;
    S.kernel.ui.refreshBarMenu   = refreshBarMenu;
    S.kernel.ui.showBarMenu      = showBarMenu;
    S.kernel.ui.notify           = notify;
    S.kernel.ui.seedPaused       = function (v) { paused = v === true; refreshStatus(); };

    S.kernel.ui.openDashboard    = openDashboard;
    S.kernel.ui.openSettings     = openSettings;
    S.kernel.ui.closeDashboard   = closeDashboard;
    S.kernel.ui.bufferedSettings = bufferedSettings;
    S.kernel.ui.markDirty        = markDirty;
    S.kernel.ui.markEditing      = markEditing;
    S.kernel.ui.canSave          = canSave;
    S.kernel.ui.settingsParse    = settingsParse;
    S.kernel.ui.TAB_ORDER        = TAB_ORDER;

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
