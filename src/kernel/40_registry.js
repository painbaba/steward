/*
 * Module registry.
 *
 * Modules call Steward.kernel.register({...}) at IIFE time. The kernel walks
 * the registry on every scheduler tick.
 *
 * Validation: id must be unique and non-empty, priority must be one of the
 * declared tiers, isReady and plan must be functions. Bad specs are rejected
 * with an ERROR log; the offending module is simply not scheduled.
 *
 * UI spec (optional): a module can declare where it appears in the dashboard
 * via a `ui` field:
 *
 *   ui: {
 *     tab: 'specialists',                    // one of TABS below
 *     section: {
 *       id:    'explorers',                  // unique; settings buffer key
 *       title: 'Explorers',                  // shown on the parchment band
 *       icon:  '⌖',                          // single character / emoji
 *       action: { label: 'Show overrides', onClick: function () {} },  // optional
 *       summary: function () { return '…'; },// shown on the Status tab
 *       render:  function ($body, h) { … }   // populates section-rows
 *     }
 *   }
 *
 * Menu spec (optional): a module can add a submenu to the native ~Steward~
 * menu via a `menu` field. `items` is an array, or a function returning
 * one; a function is called when the submenu is built (at init, and when
 * the module asks for a rebuild), not at register time, so it can list
 * data the module loads in its boot.
 *
 *   menu: {
 *     title: 'Events',                       // submenu label
 *     items: [ { label: 'Event calculator…', onSelect: function () {} } ]
 *   }
 *
 * Item shapes:
 *
 *   { separator: true }                      // divider line
 *   { label: 'Do it', onSelect: fn }         // action
 *   { label: 'Do it', onSelect: fn, enabled: fn }  // action, live enabled
 *   { label: 'Info', enabled: false }        // display-only line, no onSelect
 *
 * `enabled` may be a function `enabled(pass)` beside `onSelect`; only a
 * result of true enables the item. It is re-evaluated with the labels and
 * the flag is written in place only when it changed. Without one, an
 * actionable item is enabled and reports any state it depends on itself
 * when selected. `label` is a string or a function `label(pass)` returning
 * the text. Label functions are re-evaluated on the status tick and the
 * text is written in place only when it changed, because every native
 * label write (and every rebuild) leaks objects in AIR. `pass` is one fresh
 * object per module per build or refresh, shared by that module's label
 * and enabled functions, so an expensive read can be done once per pass.
 *
 * When the item set itself changes (not just a label), the module calls
 * Steward.kernel.ui.refreshModuleMenu(id), which rebuilds only its own
 * submenu. Do that on a user action only, never on a timer.
 *
 * Bar menu spec (optional): a `barMenu` field has the same shape as `menu`
 * and becomes a separate root item beside ~Steward~. Its labels and enabled
 * flags are refreshed when it opens and never on the status tick, so text
 * that changes often does not cost a native write per tick. When its item
 * set changes the module calls Steward.kernel.ui.refreshBarMenu(id), on a
 * user action only. An optional `visible` function on the spec says whether
 * the entry is in the bar at build; the module then moves it with
 * Steward.kernel.ui.showBarMenu(id, on). Without `visible` it is always shown.
 *
 * The `events` tab hosts read-only event tools.
 *
 * The Status tab is reserved (rendered by the kernel's UI shell, not by a
 * module). Mail/Trades is deliberately omitted until that subsystem ships.
 */

(function (S) {

    var TABS = {
        specialists: true,
        geologists:  true,
        quests:      true,
        buildings:   true,
        events:      true,
        tools:       true,
        misc:        true
    };

    var modules = [];                         // [{ id, priority, isReady, plan, boot, ui?, menu?, barMenu? }]
    var byId = {};

    function isFunction(x) { return typeof x === 'function'; }

    // Validate and normalise the optional ui spec. Returns null on any
    // problem (with a warning logged) so the module still registers and
    // runs — only its dashboard surface is dropped.
    function validateUi(moduleId, raw) {
        if (!raw || typeof raw !== 'object') return null;
        if (!TABS[raw.tab]) {
            S.kernel.warn('registry', moduleId, 'ui.tab is not a known tab:', raw.tab);
            return null;
        }
        var sec = raw.section;
        if (!sec || typeof sec !== 'object' || !sec.id || !sec.title || !isFunction(sec.render)) {
            S.kernel.warn('registry', moduleId, 'ui.section requires id, title, render');
            return null;
        }
        var action = null;
        if (sec.action && typeof sec.action === 'object' && sec.action.label && isFunction(sec.action.onClick)) {
            action = { label: String(sec.action.label), onClick: sec.action.onClick };
        }
        return {
            tab: raw.tab,
            section: {
                id:      String(sec.id),
                title:   String(sec.title),
                icon:    sec.icon ? String(sec.icon) : '',
                action:  action,
                summary: isFunction(sec.summary) ? sec.summary : null,
                render:  sec.render
            }
        };
    }

    // Normalise a menu item list. Used for a static array at register time
    // and by the UI shell for the result of an `items` function at build
    // time, so both paths accept exactly the same shapes. Invalid items are
    // dropped with a warning.
    function normalizeMenuItems(moduleId, raw) {
        if (!Array.isArray(raw)) {
            S.kernel.warn('registry', moduleId, 'menu items is not an array');
            return [];
        }
        var items = [];
        for (var i = 0; i < raw.length; i++) {
            var it = raw[i];
            if (!it || typeof it !== 'object') {
                S.kernel.warn('registry', moduleId, 'menu item', i, 'requires label and onSelect');
                continue;
            }
            if (it.separator === true) {
                items.push({ separator: true });
                continue;
            }
            var hasLabel = isFunction(it.label) || (typeof it.label === 'string' && it.label !== '');
            if (!hasLabel) {
                S.kernel.warn('registry', moduleId, 'menu item', i, 'requires label');
                continue;
            }
            var enabled = isFunction(it.enabled) ? it.enabled : it.enabled !== false;
            if (enabled !== false && !isFunction(it.onSelect)) {
                S.kernel.warn('registry', moduleId, 'menu item', i, 'requires label and onSelect');
                continue;
            }
            items.push({
                label:    isFunction(it.label) ? it.label : String(it.label),
                onSelect: isFunction(it.onSelect) ? it.onSelect : null,
                enabled:  enabled
            });
        }
        return items;
    }

    // Validate and normalise the optional menu spec. A static array is
    // normalised now: invalid items are dropped, and when none survive the
    // whole menu is dropped. An `items` function is kept as is and its
    // result is normalised when the submenu is built. Either way the module
    // still registers.
    function validateMenu(moduleId, raw) {
        if (!raw || typeof raw !== 'object') return null;
        if (!raw.title || !(Array.isArray(raw.items) || isFunction(raw.items))) {
            S.kernel.warn('registry', moduleId, 'menu requires title and items (array or function)');
            return null;
        }
        var visible = null;
        if (raw.visible !== undefined && raw.visible !== null) {
            if (isFunction(raw.visible)) visible = raw.visible;
            else S.kernel.warn('registry', moduleId, 'menu visible must be a function, ignoring');
        }
        if (isFunction(raw.items)) return { title: String(raw.title), items: raw.items, visible: visible };
        var items = normalizeMenuItems(moduleId, raw.items);
        if (!items.length) {
            S.kernel.warn('registry', moduleId, 'menu has no valid items');
            return null;
        }
        return { title: String(raw.title), items: items, visible: visible };
    }

    function register(spec) {
        if (!spec || typeof spec !== 'object') {
            S.kernel.error('registry', 'register called with non-object spec');
            return false;
        }
        if (!spec.id || typeof spec.id !== 'string') {
            S.kernel.error('registry', 'register: spec.id must be a non-empty string');
            return false;
        }
        if (byId[spec.id]) {
            S.kernel.warn('registry', 'register: duplicate id', spec.id, '— ignoring re-registration');
            return false;
        }
        if (!S.kernel.PRIORITY_VALID[spec.priority]) {
            S.kernel.error('registry', 'register:', spec.id, 'has invalid priority', spec.priority);
            return false;
        }
        if (!isFunction(spec.isReady)) {
            S.kernel.error('registry', 'register:', spec.id, 'missing isReady function');
            return false;
        }
        if (!isFunction(spec.plan)) {
            S.kernel.error('registry', 'register:', spec.id, 'missing plan function');
            return false;
        }

        // Experimental gate — modules flagged experimental only register when
        // the host has mainSettings.experimental enabled. This matches the
        // host convention (see HOST_INTEGRATION.md).
        if (spec.experimental === true) {
            if (!S.kernel.host || !S.kernel.host.experimental()) {
                S.kernel.log('registry', 'skipping experimental module', spec.id,
                             '(mainSettings.experimental is off)');
                return false;
            }
        }

        var entry = {
            id:           spec.id,
            priority:     spec.priority,
            isReady:      spec.isReady,
            plan:         spec.plan,
            boot:         isFunction(spec.boot) ? spec.boot : null,
            experimental: spec.experimental === true,
            ui:           validateUi(spec.id, spec.ui),
            menu:         validateMenu(spec.id, spec.menu),
            barMenu:      validateMenu(spec.id, spec.barMenu)
        };
        modules.push(entry);
        byId[spec.id] = entry;
        S.kernel.log('registry', 'registered', spec.id, 'at', spec.priority);
        return true;
    }

    function list() { return modules.slice(); }

    function byTier(priority) {
        var out = [];
        for (var i = 0; i < modules.length; i++) {
            if (modules[i].priority === priority) out.push(modules[i]);
        }
        return out;
    }

    function get(id) { return byId[id] || null; }

    function count() { return modules.length; }

    // Modules registered against `tab`, ordered by registration time (which
    // matches build-order). The dashboard renders sections in this order.
    function byTab(tab) {
        var out = [];
        for (var i = 0; i < modules.length; i++) {
            if (modules[i].ui && modules[i].ui.tab === tab) out.push(modules[i]);
        }
        return out;
    }

    function withUi() {
        var out = [];
        for (var i = 0; i < modules.length; i++) {
            if (modules[i].ui) out.push(modules[i]);
        }
        return out;
    }

    // Modules that declare a native-menu submenu, in registration order.
    function withMenu() {
        var out = [];
        for (var i = 0; i < modules.length; i++) {
            if (modules[i].menu) out.push(modules[i]);
        }
        return out;
    }

    // Modules that declare a menu-bar root item, in registration order.
    function withBarMenu() {
        var out = [];
        for (var i = 0; i < modules.length; i++) {
            if (modules[i].barMenu) out.push(modules[i]);
        }
        return out;
    }

    S.kernel.register = register;
    S.kernel.registry = {
        list:    list,
        byTier:  byTier,
        byTab:   byTab,
        withUi:  withUi,
        withMenu: withMenu,
        withBarMenu: withBarMenu,
        menuItems: normalizeMenuItems,
        get:     get,
        count:   count,
        TABS:    TABS
    };

}(Steward));
