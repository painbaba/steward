'use strict';

var t = require('../runner');
var harness = require('../harness');
var hostStubs = require('../stubs/host');

// Native menu stubs with construction counters, so a test can tell an
// in-place label update from a rebuild (which constructs new menus/items),
// and label/enabled write counters (AIR leaks native objects on writes).
function installMenuStubs(H) {
    var air = H.ctx.air;
    var counts = { menus: 0, items: 0, labelWrites: 0, enabledWrites: 0 };

    function NativeMenu() {
        counts.menus++;
        this.items = [];
        this.listeners = {};
    }
    NativeMenu.prototype.addEventListener = function (type, fn) {
        (this.listeners[type] = this.listeners[type] || []).push(fn);
    };
    NativeMenu.prototype.fire = function (type) {
        var list = this.listeners[type] || [];
        for (var i = 0; i < list.length; i++) list[i]();
    };
    NativeMenu.prototype.addItem = function (item) { this.items.push(item); return item; };
    NativeMenu.prototype.addItemAt = function (item, index) { this.items.splice(index, 0, item); return item; };
    NativeMenu.prototype.getItemIndex = function (item) { return this.items.indexOf(item); };
    NativeMenu.prototype.removeItem = function (item) {
        var i = this.items.indexOf(item);
        if (i >= 0) this.items.splice(i, 1);
        return item;
    };
    NativeMenu.prototype.getItemByName = function (name) {
        for (var i = 0; i < this.items.length; i++) {
            if (this.items[i].name === name) return this.items[i];
        }
        return null;
    };

    function NativeMenuItem(label, isSep) {
        counts.items++;
        this._label = label; // direct: construction is not a label write
        this.isSeparator = !!isSep;
        this.name = '';
        this._enabled = true; // direct, like the label
        this.submenu = null;
        this.onSelect = null;
    }
    Object.defineProperty(NativeMenuItem.prototype, 'label', {
        get: function () { return this._label; },
        set: function (v) { this._label = v; counts.labelWrites++; }
    });
    Object.defineProperty(NativeMenuItem.prototype, 'enabled', {
        get: function () { return this._enabled; },
        set: function (v) { this._enabled = v; counts.enabledWrites++; }
    });
    NativeMenuItem.prototype.addEventListener = function (type, fn) {
        if (type === 'select') this.onSelect = fn;
    };

    air.NativeMenu = NativeMenu;
    air.NativeMenuItem = NativeMenuItem;
    air.Event = { SELECT: 'select', DISPLAYING: 'displaying', PREPARING: 'preparing' };

    var rootMenu = new NativeMenu();
    H.ctx.window = { nativeWindow: { menu: rootMenu } };
    counts.menus = 0;
    counts.items = 0;
    return { counts: counts, rootMenu: rootMenu };
}

function setup(opts) {
    opts = opts || {};
    var H = harness.boot({ sections: ['kernel'], timers: opts.timers });
    var M = installMenuStubs(H);
    H.Steward.kernel.register({
        id:       'alpha',
        priority: 'PriorityNormal',
        isReady:  function () { return true; },
        plan:     function () {},
        ui: {
            tab: 'misc',
            section: { id: 'alpha', title: 'Alpha', render: function () {} }
        }
    });
    H.settings.write('alpha', { enabled: true });
    H.Steward.kernel.ui.init();
    return { H: H, counts: M.counts, rootMenu: M.rootMenu };
}

function toggleItem(rootMenu) {
    var root = rootMenu.getItemByName('StewardRoot');
    return root ? root.submenu.getItemByName('StewardModuleToggle_alpha') : null;
}

function snapshot(c) { return { menus: c.menus, items: c.items }; }

t.test('init builds the menu once with the module toggle', function () {
    var s = setup();
    var root = s.rootMenu.getItemByName('StewardRoot');
    t.assert.ok(root);
    var item = toggleItem(s.rootMenu);
    t.assert.ok(item);
    t.assert.strictEqual(item.label, '✓ Alpha');
});

t.test('status refresh never rebuilds the menu', function () {
    var s = setup();
    var root = s.rootMenu.getItemByName('StewardRoot');
    var before = snapshot(s.counts);
    for (var i = 0; i < 10; i++) s.H.Steward.kernel.ui.status.refresh();
    t.assert.deepStrictEqual(snapshot(s.counts), before);
    t.assert.strictEqual(s.rootMenu.getItemByName('StewardRoot'), root);
});

t.test('external enabled flip updates the label in place', function () {
    var s = setup();
    var item = toggleItem(s.rootMenu);
    var before = snapshot(s.counts);
    s.H.settings.write('alpha', { enabled: false });
    s.H.Steward.kernel.ui.status.refresh();
    t.assert.strictEqual(toggleItem(s.rootMenu), item);
    t.assert.strictEqual(item.label, '✕ Alpha');
    t.assert.deepStrictEqual(snapshot(s.counts), before);
});

t.test('quick-toggle click updates the label without a rebuild', function () {
    var s = setup();
    var item = toggleItem(s.rootMenu);
    var before = snapshot(s.counts);
    item.onSelect();
    t.assert.strictEqual(s.H.settings.read('alpha').enabled, false);
    t.assert.strictEqual(item.label, '✕ Alpha');
    t.assert.deepStrictEqual(snapshot(s.counts), before);
});

t.test('pause toggle updates its label in place', function () {
    var s = setup();
    var root = s.rootMenu.getItemByName('StewardRoot');
    var before = snapshot(s.counts);
    s.H.Steward.kernel.ui.toggle();
    t.assert.strictEqual(root.submenu.getItemByName('StewardPause').label, 'Steward: ✕ Paused');
    t.assert.deepStrictEqual(snapshot(s.counts), before);
});

// Brings the label cache to the steady state of an idle tick.
function settle(s) {
    s.H.Steward.kernel.ui.status.refresh();
    s.counts.labelWrites = 0;
}

t.test('idle refresh writes no labels after the first tick', function () {
    var s = setup();
    s.H.Steward.kernel.ui.status.refresh();
    s.counts.labelWrites = 0;
    for (var i = 0; i < 10; i++) s.H.Steward.kernel.ui.status.refresh();
    t.assert.strictEqual(s.counts.labelWrites, 0);
});

t.test('pause toggle writes only changed labels', function () {
    var s = setup();
    settle(s);
    s.H.Steward.kernel.ui.toggle();
    t.assert.strictEqual(s.counts.labelWrites, 2);
    s.counts.labelWrites = 0;
    s.H.Steward.kernel.ui.status.refresh();
    t.assert.strictEqual(s.counts.labelWrites, 0);
});

t.test('external enabled flip writes only that toggle', function () {
    var s = setup();
    settle(s);
    s.H.settings.write('alpha', { enabled: false });
    s.H.Steward.kernel.ui.status.refresh();
    t.assert.strictEqual(s.counts.labelWrites, 1);
    t.assert.strictEqual(toggleItem(s.rootMenu).label, '✕ Alpha');
});

t.test('quick-toggle click writes one label', function () {
    var s = setup();
    settle(s);
    toggleItem(s.rootMenu).onSelect();
    t.assert.strictEqual(s.counts.labelWrites, 1);
});

t.test('rebuild reseeds the cache', function () {
    var s = setup();
    settle(s);
    s.H.Steward.kernel.ui.init();
    s.counts.labelWrites = 0;
    s.H.Steward.kernel.ui.status.refresh();
    t.assert.strictEqual(s.counts.labelWrites, 0);
});

t.test('dispose stops the status interval and blocks init', function () {
    var live = {};
    var next = 1;
    var s = setup({ timers: {
        setInterval:   function (fn) { var id = next++; live[id] = fn; return id; },
        clearInterval: function (id) { delete live[id]; }
    } });
    t.assert.strictEqual(Object.keys(live).length, 1);
    s.H.Steward.kernel.ui.dispose();
    t.assert.strictEqual(Object.keys(live).length, 0);
    var before = snapshot(s.counts);
    s.H.Steward.kernel.ui.init();
    t.assert.deepStrictEqual(snapshot(s.counts), before);
});

// A module with a dynamic menu: `items` is a counting function, and the label
// functions read mutable state so a test can change their text and see which
// pass object each one received.
function setupBeta() {
    var H = harness.boot({ sections: ['kernel'] });
    var M = installMenuStubs(H);
    var beta = { itemsCalls: 0, text: 'one', other: 'fixed', passes: [], otherPasses: [], selected: 0 };
    H.Steward.kernel.register({
        id:       'beta',
        priority: 'PriorityNormal',
        isReady:  function () { return true; },
        plan:     function () {},
        menu: {
            title: 'Beta',
            items: function () {
                beta.itemsCalls++;
                return [
                    { label: 'Open', onSelect: function () { beta.selected++; } },
                    { separator: true },
                    { label: function (pass) { beta.passes.push(pass); return beta.text; }, enabled: false },
                    { label: function (pass) { beta.otherPasses.push(pass); return beta.other; },
                      onSelect: function () {} }
                ];
            }
        }
    });
    H.settings.write('beta', { enabled: true });
    H.Steward.kernel.ui.init();
    return { H: H, counts: M.counts, rootMenu: M.rootMenu, beta: beta };
}

function betaEntry(rootMenu) {
    var root = rootMenu.getItemByName('StewardRoot');
    return root.submenu.getItemByName('StewardModuleMenu_beta');
}

t.test('dynamic module items are built once at init', function () {
    var s = setupBeta();
    t.assert.strictEqual(s.beta.itemsCalls, 1);
    var inner = betaEntry(s.rootMenu).submenu;
    t.assert.strictEqual(inner.items.length, 4);
    t.assert.strictEqual(inner.items[0].label, 'Open');
    t.assert.strictEqual(inner.items[1].isSeparator, true);
    t.assert.strictEqual(inner.items[2].label, 'one');
    t.assert.strictEqual(inner.items[2].enabled, false);
    t.assert.strictEqual(inner.items[3].label, 'fixed');
    t.assert.strictEqual(inner.items[3].enabled, true);
    inner.items[0].onSelect();
    t.assert.strictEqual(s.beta.selected, 1);
});

t.test('status refresh with unchanged label functions writes no label and builds nothing', function () {
    var s = setupBeta();
    settle(s);
    var before = snapshot(s.counts);
    for (var i = 0; i < 10; i++) s.H.Steward.kernel.ui.status.refresh();
    t.assert.strictEqual(s.counts.labelWrites, 0);
    t.assert.deepStrictEqual(snapshot(s.counts), before);
    t.assert.strictEqual(s.beta.itemsCalls, 1);
});

t.test('a changed label function rewrites only that item', function () {
    var s = setupBeta();
    settle(s);
    var inner = betaEntry(s.rootMenu).submenu;
    var item = inner.items[2];
    s.beta.text = 'two';
    s.H.Steward.kernel.ui.status.refresh();
    t.assert.strictEqual(s.counts.labelWrites, 1);
    t.assert.strictEqual(inner.items[2], item);
    t.assert.strictEqual(item.label, 'two');
    t.assert.strictEqual(inner.items[3].label, 'fixed');
});

t.test('label functions share one pass object per refresh', function () {
    var s = setupBeta();
    s.beta.passes.length = 0;
    s.beta.otherPasses.length = 0;
    s.H.Steward.kernel.ui.status.refresh();
    s.H.Steward.kernel.ui.status.refresh();
    t.assert.strictEqual(s.beta.passes.length, 2);
    t.assert.strictEqual(s.beta.passes[0], s.beta.otherPasses[0]);
    t.assert.strictEqual(s.beta.passes[1], s.beta.otherPasses[1]);
    t.assert.notStrictEqual(s.beta.passes[0], s.beta.passes[1]);
});

t.test('refreshModuleMenu rebuilds only that module submenu', function () {
    var s = setupBeta();
    settle(s);
    var root = s.rootMenu.getItemByName('StewardRoot');
    var toggle = root.submenu.getItemByName('StewardModuleToggle_beta');
    var entry = betaEntry(s.rootMenu);
    var oldInner = entry.submenu;
    var before = snapshot(s.counts);
    t.assert.strictEqual(s.H.Steward.kernel.ui.refreshModuleMenu('beta'), true);
    t.assert.strictEqual(s.counts.menus, before.menus + 1);
    t.assert.strictEqual(s.counts.items, before.items + 4);
    t.assert.strictEqual(s.rootMenu.getItemByName('StewardRoot'), root);
    t.assert.strictEqual(root.submenu.getItemByName('StewardModuleToggle_beta'), toggle);
    t.assert.strictEqual(betaEntry(s.rootMenu), entry);
    t.assert.notStrictEqual(entry.submenu, oldInner);
    t.assert.strictEqual(s.beta.itemsCalls, 2);
    s.counts.labelWrites = 0;
    s.H.Steward.kernel.ui.status.refresh();
    t.assert.strictEqual(s.counts.labelWrites, 0);
});

t.test('refreshModuleMenu returns false before init and for an unknown id', function () {
    var H = harness.boot({ sections: ['kernel'] });
    installMenuStubs(H);
    t.assert.strictEqual(H.Steward.kernel.ui.refreshModuleMenu('beta'), false);
    var s = setupBeta();
    t.assert.strictEqual(s.H.Steward.kernel.ui.refreshModuleMenu('nope'), false);
});

t.test('a throwing label function does not break the status tick', function () {
    var s = setupBeta();
    s.beta.passes.push = function () { throw new Error('boom'); };
    s.H.clearLogs();
    s.H.Steward.kernel.ui.toggle();
    var pause = s.rootMenu.getItemByName('StewardRoot').submenu.getItemByName('StewardPause');
    t.assert.strictEqual(pause.label, 'Steward: ✕ Paused');
    var errors = s.H.logs().filter(function (l) { return l.level === 'error'; });
    t.assert.ok(errors.length >= 1);
});

// A module with a bar menu (its own root item beside ~Steward~) and a normal
// submenu. All items read mutable state, so a test can change the text or the
// flag and count which writes follow.
function setupGamma(opts) {
    opts = opts || {};
    var H = harness.boot({ sections: ['kernel'] });
    var M = installMenuStubs(H);
    var g = { text: 'one', on: true, sub: true, boom: !!opts.boom, selected: 0,
              itemsCalls: 0, passes: [], enabledPasses: [] };
    if (opts.failTitle) {
        var Real = H.ctx.air.NativeMenuItem;
        H.ctx.air.NativeMenuItem = function (label, isSep) {
            if (label === opts.failTitle) throw new Error('cannot build');
            return new Real(label, isSep);
        };
    }
    function register(Hx) {
        Hx.Steward.kernel.register({
            id:       'gamma',
            priority: 'PriorityNormal',
            isReady:  function () { return true; },
            plan:     function () {},
            menu: {
                title: 'Gamma',
                items: [{
                    label: 'Act',
                    enabled: function () { return g.sub; },
                    onSelect: function () {}
                }]
            },
            barMenu: {
                title: '~Gamma~',
                items: function () {
                    g.itemsCalls++;
                    return [
                        { label: function (pass) { g.passes.push(pass); return g.text; }, enabled: false },
                        { label: 'Go',
                          enabled: function (pass) {
                              g.enabledPasses.push(pass);
                              if (g.boom) throw new Error('boom');
                              return g.on;
                          },
                          onSelect: function () { g.selected++; } },
                        { separator: true },
                        { label: 'Head', enabled: false }
                    ];
                }
            }
        });
        Hx.settings.write('gamma', { enabled: true });
    }
    if (opts.failTitle) {
        H.Steward.kernel.register({
            id:       'bad',
            priority: 'PriorityNormal',
            isReady:  function () { return true; },
            plan:     function () {},
            barMenu:  { title: opts.failTitle, items: [{ label: 'x', onSelect: function () {} }] }
        });
    }
    register(H);
    H.Steward.kernel.ui.init();
    return { H: H, counts: M.counts, rootMenu: M.rootMenu, g: g, register: register };
}

function barEntry(rootMenu) { return rootMenu.getItemByName('StewardBarMenu_gamma'); }

function countNamed(rootMenu, name) {
    return rootMenu.items.filter(function (i) { return i.name === name; }).length;
}

// Idle state after the build: the writes of construction are not counted.
function settleBar(s) {
    s.H.Steward.kernel.ui.status.refresh();
    s.counts.labelWrites = 0;
    s.counts.enabledWrites = 0;
}

function errorLogs(s) {
    return s.H.logs().filter(function (l) { return l.level === 'error'; });
}

t.test('bar menu is built right after the Steward root', function () {
    var s = setupGamma();
    var items = s.rootMenu.items;
    var root = s.rootMenu.getItemByName('StewardRoot');
    var bar = barEntry(s.rootMenu);
    t.assert.ok(bar);
    t.assert.strictEqual(bar.label, '~Gamma~');
    t.assert.strictEqual(items.indexOf(bar), items.indexOf(root) + 1);
    var inner = bar.submenu;
    t.assert.strictEqual(inner.items.length, 4);
    t.assert.strictEqual(inner.items[0].label, 'one');
    t.assert.strictEqual(inner.items[0].enabled, false);
    t.assert.strictEqual(inner.items[1].label, 'Go');
    t.assert.strictEqual(inner.items[1].enabled, true);
    t.assert.strictEqual(inner.items[2].isSeparator, true);
    t.assert.strictEqual(inner.items[3].enabled, false);
    inner.items[1].onSelect();
    t.assert.strictEqual(s.g.selected, 1);
});

t.test('bar menu appears once after a rebuild', function () {
    var s = setupGamma();
    s.H.Steward.kernel.ui.init();
    t.assert.strictEqual(countNamed(s.rootMenu, 'StewardBarMenu_gamma'), 1);
    t.assert.strictEqual(countNamed(s.rootMenu, 'StewardRoot'), 1);
    var H2 = harness.reload(s.H);
    s.register(H2);
    H2.Steward.kernel.ui.init();
    t.assert.strictEqual(countNamed(s.rootMenu, 'StewardBarMenu_gamma'), 1);
    t.assert.strictEqual(countNamed(s.rootMenu, 'StewardRoot'), 1);
});

t.test('status refresh writes no bar label and no enabled flag', function () {
    var s = setupGamma();
    settleBar(s);
    s.g.text = 'two';
    s.g.on = false;
    for (var i = 0; i < 5; i++) s.H.Steward.kernel.ui.status.refresh();
    t.assert.strictEqual(s.counts.labelWrites, 0);
    t.assert.strictEqual(s.counts.enabledWrites, 0);
    var inner = barEntry(s.rootMenu).submenu;
    t.assert.strictEqual(inner.items[0].label, 'one');
    t.assert.strictEqual(inner.items[1].enabled, true);
});

t.test('opening writes only the changed label', function () {
    var s = setupGamma();
    settleBar(s);
    var inner = barEntry(s.rootMenu).submenu;
    s.g.text = 'two';
    inner.fire('preparing');
    t.assert.strictEqual(s.counts.labelWrites, 1);
    t.assert.strictEqual(s.counts.enabledWrites, 0);
    t.assert.strictEqual(inner.items[0].label, 'two');
    inner.fire('displaying');
    t.assert.strictEqual(s.counts.labelWrites, 1);
    t.assert.strictEqual(s.counts.enabledWrites, 0);
});

t.test('opening writes the enabled flag only on change', function () {
    var s = setupGamma();
    settleBar(s);
    var inner = barEntry(s.rootMenu).submenu;
    inner.fire('preparing');
    t.assert.strictEqual(s.counts.enabledWrites, 0);
    s.g.on = false;
    inner.fire('preparing');
    t.assert.strictEqual(s.counts.enabledWrites, 1);
    t.assert.strictEqual(inner.items[1].enabled, false);
    inner.fire('displaying');
    t.assert.strictEqual(s.counts.enabledWrites, 1);
    t.assert.strictEqual(s.counts.labelWrites, 0);
});

t.test('bar label functions share one pass per open', function () {
    var s = setupGamma();
    var inner = barEntry(s.rootMenu).submenu;
    s.g.passes.length = 0;
    s.g.enabledPasses.length = 0;
    inner.fire('preparing');
    inner.fire('displaying');
    t.assert.strictEqual(s.g.passes.length, 2);
    t.assert.strictEqual(s.g.enabledPasses.length, 2);
    t.assert.strictEqual(s.g.passes[0], s.g.enabledPasses[0]);
    t.assert.strictEqual(s.g.passes[1], s.g.enabledPasses[1]);
    t.assert.notStrictEqual(s.g.passes[0], s.g.passes[1]);
});

t.test('a throwing enabled function gives a disabled item and an error log', function () {
    var s = setupGamma({ boom: true });
    var inner = barEntry(s.rootMenu).submenu;
    t.assert.strictEqual(inner.items[1].enabled, false);
    t.assert.ok(errorLogs(s).length >= 1);
    s.H.clearLogs();
    inner.fire('preparing');
    t.assert.strictEqual(inner.items[1].enabled, false);
    t.assert.ok(errorLogs(s).length >= 1);
});

t.test('refreshBarMenu rebuilds only the bar submenu', function () {
    var s = setupGamma();
    settleBar(s);
    var root = s.rootMenu.getItemByName('StewardRoot');
    var entry = barEntry(s.rootMenu);
    var oldInner = entry.submenu;
    var sub = root.submenu.getItemByName('StewardModuleMenu_gamma');
    var subInner = sub.submenu;
    var before = snapshot(s.counts);
    t.assert.strictEqual(s.H.Steward.kernel.ui.refreshBarMenu('gamma'), true);
    t.assert.strictEqual(s.counts.menus, before.menus + 1);
    t.assert.strictEqual(s.counts.items, before.items + 4);
    t.assert.strictEqual(s.rootMenu.getItemByName('StewardRoot'), root);
    t.assert.strictEqual(barEntry(s.rootMenu), entry);
    t.assert.notStrictEqual(entry.submenu, oldInner);
    t.assert.strictEqual(sub.submenu, subInner);
    t.assert.strictEqual(s.g.itemsCalls, 2);
});

t.test('the rebuilt menu refreshes on open', function () {
    var s = setupGamma();
    s.H.Steward.kernel.ui.refreshBarMenu('gamma');
    settleBar(s);
    var inner = barEntry(s.rootMenu).submenu;
    s.g.text = 'three';
    s.g.on = false;
    inner.fire('preparing');
    t.assert.strictEqual(inner.items[0].label, 'three');
    t.assert.strictEqual(inner.items[1].enabled, false);
    t.assert.strictEqual(s.counts.labelWrites, 1);
    t.assert.strictEqual(s.counts.enabledWrites, 1);
});

t.test('refreshBarMenu returns false before init and for a module without a bar menu', function () {
    var H = harness.boot({ sections: ['kernel'] });
    installMenuStubs(H);
    t.assert.strictEqual(H.Steward.kernel.ui.refreshBarMenu('gamma'), false);
    var s = setupGamma();
    t.assert.strictEqual(s.H.Steward.kernel.ui.refreshBarMenu('nope'), false);
    var b = setupBeta();
    t.assert.strictEqual(b.H.Steward.kernel.ui.refreshBarMenu('beta'), false);
});

t.test('a bar menu that fails to build leaves the Steward root in place', function () {
    var s = setupGamma({ failTitle: '~Bad~' });
    t.assert.ok(s.rootMenu.getItemByName('StewardRoot'));
    t.assert.strictEqual(s.rootMenu.getItemByName('StewardBarMenu_bad'), null);
    t.assert.ok(barEntry(s.rootMenu));
    t.assert.ok(errorLogs(s).length >= 1);
});

t.test('open refresh is a no-op after dispose', function () {
    var s = setupGamma();
    settleBar(s);
    var inner = barEntry(s.rootMenu).submenu;
    s.H.Steward.kernel.ui.dispose();
    s.g.text = 'late';
    s.g.on = false;
    s.g.passes.length = 0;
    inner.fire('preparing');
    inner.fire('displaying');
    t.assert.strictEqual(s.g.passes.length, 0);
    t.assert.strictEqual(s.counts.labelWrites, 0);
    t.assert.strictEqual(s.counts.enabledWrites, 0);
});

t.test('enabled function on a submenu item refreshes on the tick', function () {
    var s = setupGamma();
    settleBar(s);
    var root = s.rootMenu.getItemByName('StewardRoot');
    var item = root.submenu.getItemByName('StewardModuleMenu_gamma').submenu.items[0];
    t.assert.strictEqual(item.enabled, true);
    s.g.sub = false;
    s.H.Steward.kernel.ui.status.refresh();
    t.assert.strictEqual(item.enabled, false);
    t.assert.strictEqual(s.counts.enabledWrites, 1);
    s.H.Steward.kernel.ui.status.refresh();
    t.assert.strictEqual(s.counts.enabledWrites, 1);
});

// A module whose bar entry follows a `visible` function. state.visible is what
// the function answers at build; state.boom makes it throw.
function setupVis(opts) {
    opts = opts || {};
    var H = harness.boot({ sections: ['kernel'] });
    var M = installMenuStubs(H);
    var st = { visible: opts.visible !== false, boom: !!opts.boom };
    var spec = {
        id:       'vis',
        priority: 'PriorityNormal',
        isReady:  function () { return true; },
        plan:     function () {},
        barMenu:  { title: '~Vis~', items: [{ label: 'Go', onSelect: function () {} }] }
    };
    if (!opts.noVisible) {
        spec.barMenu.visible = function () {
            if (st.boom) throw new Error('boom');
            return st.visible;
        };
    }
    H.Steward.kernel.register(spec);
    H.settings.write('vis', { enabled: true });
    if (opts.noAddItemAt) delete M.rootMenu.addItemAt;
    if (opts.throwAddItemAt) M.rootMenu.addItemAt = function () { throw new Error('no addItemAt'); };
    H.Steward.kernel.ui.init();
    return { H: H, counts: M.counts, rootMenu: M.rootMenu, st: st, K: H.Steward.kernel };
}

function visEntry(rootMenu) { return rootMenu.getItemByName('StewardBarMenu_vis'); }

t.test('a visible false entry is built but not in the bar', function () {
    var s = setupVis({ visible: false });
    t.assert.strictEqual(visEntry(s.rootMenu), null);
    t.assert.ok(s.rootMenu.getItemByName('StewardRoot'));
    t.assert.strictEqual(s.counts.menus >= 2, true);
});

t.test('show puts the entry directly after the root even with a foreign item after it', function () {
    var s = setupVis({ visible: false });
    var NMI = s.H.ctx.air.NativeMenuItem;
    s.rootMenu.addItem(new NMI('Foreign'));
    t.assert.strictEqual(s.K.ui.showBarMenu('vis', true), true);
    var items = s.rootMenu.items;
    var root = s.rootMenu.getItemByName('StewardRoot');
    t.assert.strictEqual(items.indexOf(visEntry(s.rootMenu)), items.indexOf(root) + 1);
    t.assert.strictEqual(items[items.length - 1].label, 'Foreign');
});

t.test('hide removes the entry; show and hide build no native objects', function () {
    var s = setupVis({ visible: true });
    t.assert.ok(visEntry(s.rootMenu));
    var before = snapshot(s.counts);
    t.assert.strictEqual(s.K.ui.showBarMenu('vis', false), true);
    t.assert.strictEqual(visEntry(s.rootMenu), null);
    t.assert.strictEqual(s.K.ui.showBarMenu('vis', true), true);
    t.assert.ok(visEntry(s.rootMenu));
    t.assert.deepStrictEqual(snapshot(s.counts), before);
});

t.test('a second call with the same state returns false and changes nothing', function () {
    var s = setupVis({ visible: true });
    var n = s.rootMenu.items.length;
    t.assert.strictEqual(s.K.ui.showBarMenu('vis', true), false);
    t.assert.strictEqual(s.rootMenu.items.length, n);
    s.K.ui.showBarMenu('vis', false);
    n = s.rootMenu.items.length;
    t.assert.strictEqual(s.K.ui.showBarMenu('vis', false), false);
    t.assert.strictEqual(s.rootMenu.items.length, n);
});

t.test('showBarMenu is false before init, after dispose and for an unknown id', function () {
    var H = harness.boot({ sections: ['kernel'] });
    installMenuStubs(H);
    t.assert.strictEqual(H.Steward.kernel.ui.showBarMenu('vis', true), false);

    var s = setupVis({ visible: true });
    t.assert.strictEqual(s.K.ui.showBarMenu('nope', false), false);
    s.K.ui.dispose();
    t.assert.strictEqual(s.K.ui.showBarMenu('vis', false), false);
    t.assert.ok(visEntry(s.rootMenu));
});

t.test('a throwing visible logs and shows the entry', function () {
    var s = setupVis({ boom: true });
    t.assert.ok(visEntry(s.rootMenu));
    t.assert.ok(errorLogs(s).length >= 1);
});

t.test('without addItemAt on the host the entry is appended', function () {
    var s = setupVis({ visible: false, noAddItemAt: true });
    t.assert.strictEqual(s.K.ui.showBarMenu('vis', true), true);
    var items = s.rootMenu.items;
    t.assert.strictEqual(items[items.length - 1], visEntry(s.rootMenu));
});

t.test('a throwing addItemAt falls back to addItem', function () {
    var s = setupVis({ visible: false, throwAddItemAt: true });
    t.assert.strictEqual(s.K.ui.showBarMenu('vis', true), true);
    var items = s.rootMenu.items;
    t.assert.strictEqual(items[items.length - 1], visEntry(s.rootMenu));
});

t.test('a throwing removeItem returns false and a later call tries again', function () {
    var s = setupVis({ visible: true });
    var realRemove = s.rootMenu.removeItem;
    var fail = true;
    s.rootMenu.removeItem = function (item) {
        if (fail) throw new Error('cannot remove');
        return realRemove.call(s.rootMenu, item);
    };
    t.assert.strictEqual(s.K.ui.showBarMenu('vis', false), false);
    t.assert.ok(visEntry(s.rootMenu));
    fail = false;
    t.assert.strictEqual(s.K.ui.showBarMenu('vis', false), true);
    t.assert.strictEqual(visEntry(s.rootMenu), null);
});

t.test('a rebuild with a hidden entry leaves at most one entry', function () {
    var s = setupVis({ visible: true });
    s.K.ui.showBarMenu('vis', false);
    s.st.visible = false;
    s.K.ui.init();
    t.assert.strictEqual(countNamed(s.rootMenu, 'StewardBarMenu_vis'), 0);
    s.st.visible = true;
    s.K.ui.init();
    t.assert.strictEqual(countNamed(s.rootMenu, 'StewardBarMenu_vis'), 1);
    s.K.ui.showBarMenu('vis', false);
    s.K.ui.init();
    t.assert.ok(countNamed(s.rootMenu, 'StewardBarMenu_vis') <= 1);
});

t.test('a bar menu without visible is always shown', function () {
    var s = setupVis({ noVisible: true });
    t.assert.ok(visEntry(s.rootMenu));
    t.assert.strictEqual(s.K.ui.showBarMenu('vis', true), false);
});

// ---- Settings item ----------------------------------------------------------

function settingsItem(rootMenu) {
    return rootMenu.getItemByName('StewardRoot').submenu.getItemByName('StewardOpenSettings');
}

t.test('Settings item is the last menu entry, after a separator', function () {
    var s = setup();
    var items = s.rootMenu.getItemByName('StewardRoot').submenu.items;
    var last = items[items.length - 1];
    t.assert.strictEqual(last.name, 'StewardOpenSettings');
    t.assert.strictEqual(last.label, 'Settings…');
    t.assert.strictEqual(items[items.length - 2].isSeparator, true);
});

t.test('Settings stays last in ~Steward~ with a bar menu beside it', function () {
    var s = setupGamma();
    var items = s.rootMenu.getItemByName('StewardRoot').submenu.items;
    t.assert.strictEqual(items[items.length - 1].name, 'StewardOpenSettings');
    t.assert.strictEqual(items.filter(function (it) { return it.name === 'StewardOpenSettings'; }).length, 1);
    t.assert.strictEqual(s.rootMenu.items.indexOf(barEntry(s.rootMenu)),
        s.rootMenu.items.indexOf(s.rootMenu.getItemByName('StewardRoot')) + 1);
    t.assert.strictEqual(barEntry(s.rootMenu).submenu.getItemByName('StewardOpenSettings'), null);
});

t.test('Settings item is built once and refreshes do not touch it', function () {
    var s = setup();
    settle(s);
    var item = settingsItem(s.rootMenu);
    var before = snapshot(s.counts);
    for (var i = 0; i < 5; i++) s.H.Steward.kernel.ui.status.refresh();
    s.H.Steward.kernel.ui.toggle();
    t.assert.strictEqual(settingsItem(s.rootMenu), item);
    t.assert.strictEqual(item.label, 'Settings…');
    t.assert.deepStrictEqual(snapshot(s.counts), before);
    t.assert.strictEqual(s.rootMenu.getItemByName('StewardRoot').submenu.items.filter(function (it) {
        return it.name === 'StewardOpenSettings';
    }).length, 1);
});

t.test('selecting Settings opens the settings modal', function () {
    var s = setup();
    var made = hostStubs.installModal(s.H).made;
    settingsItem(s.rootMenu).onSelect();
    t.assert.strictEqual(made.length, 1);
    t.assert.strictEqual(made[0].id, 'StewardSettings');
    t.assert.strictEqual(made[0].title, 'Steward — Settings');
});

t.test('selecting Settings without a host Modal logs an error and does not throw', function () {
    var s = setup();
    s.H.clearLogs();
    settingsItem(s.rootMenu).onSelect();
    var errors = s.H.logs().filter(function (l) {
        return l.level === 'error' && /Modal class unavailable/.test(l.args.join(' '));
    });
    t.assert.strictEqual(errors.length, 1);
});
