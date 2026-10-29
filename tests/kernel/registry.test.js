'use strict';

var t = require('../runner');
var harness = require('../harness');

function validSpec(id) {
    return {
        id:       id,
        priority: 'PriorityNormal',
        isReady:  function () { return true; },
        plan:     function () {}
    };
}

t.test('register accepts a valid spec', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var ok = H.Steward.kernel.register(validSpec('alpha'));
    t.assert.strictEqual(ok, true);
    t.assert.strictEqual(H.Steward.kernel.registry.count(), 1);
    t.assert.strictEqual(H.Steward.kernel.registry.get('alpha').id, 'alpha');
});

t.test('register rejects duplicate ids', function () {
    var H = harness.boot({ sections: ['kernel'] });
    H.Steward.kernel.register(validSpec('dup'));
    var second = H.Steward.kernel.register(validSpec('dup'));
    t.assert.strictEqual(second, false);
    t.assert.strictEqual(H.Steward.kernel.registry.count(), 1);
});

t.test('register rejects an invalid priority', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var spec = validSpec('bad');
    spec.priority = 'PriorityBogus';
    t.assert.strictEqual(H.Steward.kernel.register(spec), false);
    t.assert.strictEqual(H.Steward.kernel.registry.count(), 0);
});

t.test('register rejects spec missing isReady or plan', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var noReady = validSpec('noReady'); noReady.isReady = null;
    var noPlan  = validSpec('noPlan');  noPlan.plan    = null;
    t.assert.strictEqual(H.Steward.kernel.register(noReady), false);
    t.assert.strictEqual(H.Steward.kernel.register(noPlan),  false);
});

function menuSpec(id, items) {
    var s = validSpec(id);
    s.menu = { title: 'Events', items: items };
    return s;
}

t.test('a valid menu spec appears in withMenu()', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var fn = function () {};
    H.Steward.kernel.register(validSpec('plain'));
    H.Steward.kernel.register(menuSpec('withmenu', [{ label: 'Open', onSelect: fn }]));
    var list = H.Steward.kernel.registry.withMenu();
    t.assert.strictEqual(list.length, 1);
    t.assert.strictEqual(list[0].id, 'withmenu');
    t.assert.strictEqual(list[0].menu.title, 'Events');
    t.assert.strictEqual(list[0].menu.items.length, 1);
    t.assert.strictEqual(list[0].menu.items[0].label, 'Open');
    t.assert.strictEqual(list[0].menu.items[0].onSelect, fn);
});

t.test('a menu item without onSelect is dropped', function () {
    var H = harness.boot({ sections: ['kernel'] });
    H.Steward.kernel.register(menuSpec('m', [
        { label: 'Broken' },
        { label: 'Fine', onSelect: function () {} }
    ]));
    var items = H.Steward.kernel.registry.get('m').menu.items;
    t.assert.strictEqual(items.length, 1);
    t.assert.strictEqual(items[0].label, 'Fine');
});

t.test('a menu with no valid items is null but the module still registers', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var ok = H.Steward.kernel.register(menuSpec('m', [{ label: 'Broken' }, { onSelect: function () {} }]));
    t.assert.strictEqual(ok, true);
    t.assert.strictEqual(H.Steward.kernel.registry.get('m').menu, null);
    t.assert.strictEqual(H.Steward.kernel.registry.withMenu().length, 0);
});

t.test('a menu without a title is dropped', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var s = validSpec('m');
    s.menu = { items: [{ label: 'A', onSelect: function () {} }] };
    t.assert.strictEqual(H.Steward.kernel.register(s), true);
    t.assert.strictEqual(H.Steward.kernel.registry.get('m').menu, null);
});

t.test('ui.tab events is accepted', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var s = validSpec('ev');
    s.ui = { tab: 'events', section: { id: 'ev', title: 'Events', render: function () {} } };
    H.Steward.kernel.register(s);
    t.assert.ok(H.Steward.kernel.registry.get('ev').ui);
    t.assert.strictEqual(H.Steward.kernel.registry.byTab('events').length, 1);
});

t.test('items as a function is kept', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var fn = function () { return [{ label: 'A', onSelect: function () {} }]; };
    H.Steward.kernel.register(menuSpec('m', fn));
    t.assert.strictEqual(H.Steward.kernel.registry.get('m').menu.items, fn);
    t.assert.strictEqual(H.Steward.kernel.registry.withMenu().length, 1);
});

t.test('separator and display-only items are accepted', function () {
    var H = harness.boot({ sections: ['kernel'] });
    H.Steward.kernel.register(menuSpec('m', [
        { separator: true },
        { label: 'Status', enabled: false },
        { label: 'Go', onSelect: function () {} }
    ]));
    var items = H.Steward.kernel.registry.get('m').menu.items;
    t.assert.strictEqual(items.length, 3);
    t.assert.strictEqual(items[0].separator, true);
    t.assert.strictEqual(items[1].enabled, false);
    t.assert.strictEqual(items[1].onSelect, null);
    t.assert.strictEqual(items[2].enabled, true);
});

t.test('a label function is accepted', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var lf = function () { return 'dyn'; };
    H.Steward.kernel.register(menuSpec('m', [{ label: lf, onSelect: function () {} }]));
    t.assert.strictEqual(H.Steward.kernel.registry.get('m').menu.items[0].label, lf);
});

t.test('menuItems drops an item without label', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var out = H.Steward.kernel.registry.menuItems('m', [
        { onSelect: function () {} },
        { label: '', onSelect: function () {} },
        { label: 'Ok', onSelect: function () {} }
    ]);
    t.assert.strictEqual(out.length, 1);
    t.assert.strictEqual(out[0].label, 'Ok');
});
