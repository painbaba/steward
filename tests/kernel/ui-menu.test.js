'use strict';

var t = require('../runner');
var harness = require('../harness');

// Native menu stubs with construction counters, so a test can tell an
// in-place label update from a rebuild (which constructs new menus/items),
// and a label-write counter (AIR leaks native objects on label writes).
function installMenuStubs(H) {
    var air = H.ctx.air;
    var counts = { menus: 0, items: 0, labelWrites: 0 };

    function NativeMenu() {
        counts.menus++;
        this.items = [];
    }
    NativeMenu.prototype.addItem = function (item) { this.items.push(item); return item; };
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
        this.enabled = true;
        this.submenu = null;
        this.onSelect = null;
    }
    Object.defineProperty(NativeMenuItem.prototype, 'label', {
        get: function () { return this._label; },
        set: function (v) { this._label = v; counts.labelWrites++; }
    });
    NativeMenuItem.prototype.addEventListener = function (type, fn) {
        if (type === 'select') this.onSelect = fn;
    };

    air.NativeMenu = NativeMenu;
    air.NativeMenuItem = NativeMenuItem;
    air.Event = { SELECT: 'select' };

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
