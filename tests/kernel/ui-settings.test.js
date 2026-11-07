'use strict';

var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');
var hostStubs = require('../stubs/host');

var assert = t.assert;

var LOGDIR = 'C:/client/steward/logs';

// Objects built inside the vm context carry that realm's prototypes, so
// deepStrictEqual compares a plain copy.
function plain(v) { return JSON.parse(JSON.stringify(v)); }

function setup() {
    var fs = airfs.make();
    fs.dirs['C:/client/steward'] = true;
    fs.dirs[LOGDIR] = true;
    var alerts = [];
    var H = harness.boot({
        sections: ['kernel'],
        host: { air: fs.air, showGameAlert: function (msg) { alerts.push(msg); } }
    });
    return { fs: fs, H: H, alerts: alerts, ui: H.Steward.kernel.ui, S: H.Steward };
}

function seedRotated(s, count) {
    for (var n = 1; n <= count; n++) s.fs.disk[LOGDIR + '/console.log.' + n] = 'old ' + n;
}

function rotatedOnDisk(s) {
    return Object.keys(s.fs.disk).filter(function (p) {
        return /console\.log\.\d+$/.test(p);
    }).length;
}

// ---- Save and Close ---------------------------------------------------------

t.test('Save applies logger settings at once', function () {
    var s = setup();
    seedRotated(s, 4);
    s.ui.helpers.update('logger', { keepRotated: 1 });
    s.ui.closeDashboard(true);
    assert.strictEqual(s.H.settings.read('logger').keepRotated, 1);
    assert.strictEqual(rotatedOnDisk(s), 1);
    assert.ok(s.fs.disk[LOGDIR + '/console.log.1'] !== undefined);
    assert.strictEqual(s.S.kernel.log.effective().keepRotated, 1);
});

t.test('Save applies the tick interval', function () {
    var s = setup();
    s.ui.helpers.update('scheduler', { tickInterval: 20000 });
    s.ui.closeDashboard(true);
    assert.strictEqual(s.H.settings.read('scheduler').tickInterval, 20000);
    assert.strictEqual(s.S.kernel.scheduler.state.tickIntervalMs, 20000);
});

t.test('Close discards', function () {
    var s = setup();
    seedRotated(s, 4);
    var keepBefore = s.S.kernel.log.effective().keepRotated;
    var tickBefore = s.S.kernel.scheduler.state.tickIntervalMs;
    s.ui.helpers.update('logger', { keepRotated: 1 });
    s.ui.helpers.update('scheduler', { tickInterval: 20000 });
    s.ui.closeDashboard(false);
    assert.strictEqual(s.H.settings.read('logger'), null);
    assert.strictEqual(s.H.settings.read('scheduler'), null);
    assert.strictEqual(s.S.kernel.log.effective().keepRotated, keepBefore);
    assert.strictEqual(s.S.kernel.scheduler.state.tickIntervalMs, tickBefore);
    assert.strictEqual(rotatedOnDisk(s), 4);
});

t.test('h.update on a misc module id goes through the shared buffer and saves', function () {
    var s = setup();
    s.S.kernel.register({
        id: 'zeta', priority: 'PriorityNormal',
        isReady: function () { return true; }, plan: function () {},
        ui: { tab: 'misc', section: { id: 'zeta', title: 'Zeta', render: function () {} } }
    });
    s.H.settings.write('zeta', { keep: 'me' });
    s.ui.helpers.update('zeta', { probe: 1 });
    assert.strictEqual(s.ui.bufferedSettings('zeta').probe, 1);
    assert.strictEqual(s.H.settings.read('zeta').probe, undefined);
    s.ui.closeDashboard(true);
    assert.deepStrictEqual(plain(s.H.settings.read('zeta')), { keep: 'me', probe: 1 });
});

// ---- Typing enables Save ----------------------------------------------------

// Every $() in the host stub returns the shared $.fn, so patching its `on`
// records the handlers of whichever element h.input builds next.
function recordHandlers(s) {
    var handlers = {};
    s.H.ctx.$.fn.on = function (ev, fn) {
        (handlers[ev] = handlers[ev] || []).push(fn);
        return s.H.ctx.$.fn;
    };
    return handlers;
}

t.test('typing into a bound input enables Save before blur', function () {
    var s = setup();
    var handlers = recordHandlers(s);
    assert.strictEqual(s.ui.canSave(), false);
    s.ui.helpers.input({ onChange: function () {} });
    assert.strictEqual(handlers.input.length, 1);
    handlers.input[0]();
    assert.strictEqual(s.ui.canSave(), true);
    // Typing alone marks nothing dirty, so closing writes nothing.
    s.ui.closeDashboard(true);
    assert.strictEqual(s.alerts.length, 0);
    assert.strictEqual(s.H.settings.read('logger'), null);
    assert.strictEqual(s.ui.canSave(), false);
});

t.test('an unbound input adds no typing hook', function () {
    var s = setup();
    var handlers = recordHandlers(s);
    s.ui.helpers.input({});
    assert.strictEqual(handlers.input, undefined);
});

t.test('typing then the blur change saves on the first Save', function () {
    var s = setup();
    var handlers = recordHandlers(s);
    s.S.kernel.register({
        id: 'zeta', priority: 'PriorityNormal',
        isReady: function () { return true; }, plan: function () {},
        ui: { tab: 'misc', section: { id: 'zeta', title: 'Zeta', render: function () {} } }
    });
    s.ui.helpers.input({ onChange: function () { s.ui.helpers.update('zeta', { probe: 1 }); } });
    handlers.input[0]();
    assert.strictEqual(s.ui.canSave(), true);
    handlers.change[0]();
    s.ui.closeDashboard(true);
    assert.strictEqual(s.H.settings.read('zeta').probe, 1);
    assert.strictEqual(s.ui.canSave(), false);
});

t.test('a typing-only edit neither blocks opening nor survives it', function () {
    var s = setup();
    var handlers = recordHandlers(s);
    var rig = hostStubs.installModal(s.H);
    s.ui.openSettings();
    rig.visible = true;
    s.ui.helpers.input({ onChange: function () {} });
    handlers.input[0]();
    assert.strictEqual(s.ui.canSave(), true);

    s.ui.openDashboard();
    assert.strictEqual(rig.made.length, 2);
    assert.strictEqual(s.alerts.length, 0);
    assert.strictEqual(s.ui.canSave(), false);
});

// ---- Parsers ----------------------------------------------------------------

t.test('settingsParse sizeKB, keep and tickMs', function () {
    var K = harness.boot({ sections: ['kernel'] }).Steward.kernel;
    var p = K.ui.settingsParse;
    var min = K.TIMEOUTS.TICK_INTERVAL_MIN_MS;

    assert.strictEqual(p.sizeKB('2'), 2048);
    assert.strictEqual(p.sizeKB(' 1.5 '), 1536);
    assert.strictEqual(p.sizeKB('0'), 0);
    assert.strictEqual(p.sizeKB(''), null);
    assert.strictEqual(p.sizeKB('   '), null);
    assert.strictEqual(p.sizeKB('-1'), null);
    assert.strictEqual(p.sizeKB('abc'), null);

    assert.strictEqual(p.keep('3'), 3);
    assert.strictEqual(p.keep('2.7'), 2);
    assert.strictEqual(p.keep('0'), 0);
    assert.strictEqual(p.keep(''), null);
    assert.strictEqual(p.keep('-1'), null);
    assert.strictEqual(p.keep('many'), null);

    assert.strictEqual(p.tickMs('20'), 20000);
    assert.strictEqual(p.tickMs('12.5'), 12500);
    assert.strictEqual(p.tickMs('5'), min);
    assert.strictEqual(p.tickMs('0'), min);
    assert.strictEqual(p.tickMs(''), null);
    assert.strictEqual(p.tickMs('-3'), null);
    assert.strictEqual(p.tickMs('soon'), null);
});

// ---- Opening ----------------------------------------------------------------

t.test('openSettings opens the StewardSettings modal', function () {
    var s = setup();
    var rig = hostStubs.installModal(s.H);
    s.ui.openSettings();
    assert.strictEqual(rig.made.length, 1);
    assert.strictEqual(rig.made[0].id, 'StewardSettings');
    assert.strictEqual(rig.made[0].title, 'Steward \u2014 Settings');
    assert.strictEqual(rig.made[0].closable, true);
});

t.test('opening is refused while the open screen has unsaved edits', function () {
    var s = setup();
    var rig = hostStubs.installModal(s.H);
    s.ui.openSettings();
    rig.visible = true;
    s.ui.helpers.update('logger', { keepRotated: 2 });

    s.ui.openSettings();
    s.ui.openDashboard();
    assert.strictEqual(rig.made.length, 1);
    assert.strictEqual(s.alerts.length, 2);
    assert.ok(/Save or close/.test(s.alerts[0]));
    // The refused open must not have dropped the edit.
    assert.strictEqual(s.ui.bufferedSettings('logger').keepRotated, 2);
});

t.test('stale dirty state does not block opening', function () {
    var s = setup();
    var rig = hostStubs.installModal(s.H);
    s.ui.openSettings();
    rig.visible = false;
    s.ui.helpers.update('logger', { keepRotated: 2 });

    s.ui.openDashboard();
    assert.strictEqual(rig.made.length, 2);
    assert.strictEqual(rig.made[1].id, 'StewardDashboard');
    assert.strictEqual(rig.made[1].title, 'Steward — Auto Settings');
    assert.strictEqual(s.alerts.length, 0);
    s.ui.openSettings();
    assert.strictEqual(rig.made.length, 3);
    assert.strictEqual(s.alerts.length, 0);
});

t.test('open failures name the screen', function () {
    var s = setup();
    function errorText() {
        return s.H.logs().filter(function (l) {
            return l.level === 'error';
        }).map(function (l) { return l.args.join(' '); }).join('\n');
    }

    s.H.clearLogs();
    s.ui.openDashboard();
    s.ui.openSettings();
    var text = errorText();
    assert.ok(/cannot open dashboard/.test(text), text);
    assert.ok(/cannot open settings/.test(text), text);

    hostStubs.installModal(s.H);
    s.H.ctx.Modal.prototype.create = function () { throw new Error('boom'); };
    s.H.clearLogs();
    s.ui.openDashboard();
    s.ui.openSettings();
    text = errorText();
    assert.ok(/openDashboard threw/.test(text), text);
    assert.ok(/openSettings threw/.test(text), text);
});

// ---- Tabs -------------------------------------------------------------------

t.test('TAB_ORDER has no tools or misc and every other id is a known tab', function () {
    var s = setup();
    var ids = s.ui.TAB_ORDER.map(function (tab) { return tab.id; });
    assert.strictEqual(ids.indexOf('tools'), -1);
    assert.strictEqual(ids.indexOf('misc'), -1);
    for (var i = 0; i < ids.length; i++) {
        assert.ok(ids[i] === 'status' || s.S.kernel.registry.TABS[ids[i]] === true, ids[i]);
    }
});
