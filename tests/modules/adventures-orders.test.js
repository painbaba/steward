'use strict';

// One send per order. A marked order goes out exactly once: an effect slower
// than the attempt's own window neither repeats it nor pauses the run, the step
// waits ORDER_WAIT_MS from the send for what the game shows, and only then
// pauses with the site's reason. The sites share one table, so each behaviour
// is pinned for every order. The horseshoe never waits or pauses and has its
// own cases, and so does a raise, which carries no mark.
//
// Each site's world withholds the effect the way the client would when it runs
// late; slow() also keeps the attempt's own check from seeing the send, and
// verified() makes it see the send while the effect stays away.

var t = require('../runner');
var AC = require('../stubs/actions');
var W = require('../stubs/adventures');

var assert = t.assert;

var HOME = W.HOME;
var ZONE = W.ZONE;
var LOADOUT = W.LOADOUT;
var WAVE = 'C:/b/w1.txt';
var ONE = { '1.1': true };
var PACK_KEYS = { '1.1': true, '1.2': true, '1.5': true };
var CLAIMED = { lastQuest: { sentAt: 1, seen: true, sentOnce: true } };
var TICK_MS = 10000;
var LOST = 'nope';

var plain = W.plain;
var writeJson = W.writeJson;
var tick = W.tick;
var play = W.play;
var stepName = W.stepName;

// ---- world ------------------------------------------------------------------

function gen(uid, name, grid, army, more) {
    var o = { uid: uid, name: name, grid: grid, army: army || {} };
    var k;
    for (k in (more || {})) if (Object.prototype.hasOwnProperty.call(more, k)) o[k] = more[k];
    return AC.general(o);
}

function homeWorld(o) {
    o = o || {};
    var g1 = gen('1.1', 'Anna', 10);
    var g2 = gen('1.2', 'Bert', 20);
    var opts = { home: true, generals: [g1, g2], free: { Rifle: 20, Bow: 0 },
        settings: { retrain: true } };
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) opts[k] = o[k];
    var w = W.world(opts);
    w.g1 = g1;
    w.g2 = g2;
    w.gi = w.H.host.game.gi;
    w.sentClaims = [];
    writeJson(w.fs, LOADOUT, {
        '1.1': { grid: 10, army: { Rifle: 5 } },
        '1.2': { grid: 20, army: { Rifle: 3 } }
    });
    writeJson(w.fs, WAVE, {
        '1.1': { grid: 10, target: 100, army: { Rifle: 5 }, order: 1, name: 'Anna' },
        '1.2': { grid: 20, target: 200, army: { Rifle: 3 }, order: 2, name: 'Bert' }
    });
    return w;
}

// A run of one map at o.step. o.run: run fields set after newRun.
function series(w, o) {
    var r = w.st.newRun({
        id: 42, templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights',
        zoneId: o.zoneId === undefined ? null : o.zoneId,
        paths: [WAVE], loadoutPath: LOADOUT, loadoutKeys: o.keys || ONE,
        waveIndex: 0, speedBuff: o.speedBuff || '', step: o.step
    });
    var k;
    for (k in (o.run || {})) if (Object.prototype.hasOwnProperty.call(o.run, k)) r[k] = o.run[k];
    w.st.begin({
        templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights', count: 1, ended: false,
        requested: w.t, finished: 0, closedAt: null
    }, r);
    return w.st.run();
}

function onIsland(w, generals, free) {
    w.adventures = [{ adventureName: 'BlackKnights', zoneID: ZONE }];
    w.lists[HOME].length = 0;
    generals.forEach(function (g) { w.place(g, ZONE); });
    w.frees[ZONE] = free || {};
    w.gi.visitZone(ZONE);
}

function addElite(w, name) {
    var units = w.H.host.game.def('MilitarySystem::cMilitaryUnitBase').GetAllUnit();
    units.push({
        GetType:         function () { return name; },
        GetUnitCategory: function () { return 0; },
        GetIsElite:      function () { return true; },
        GetCosts_vector: function () { return w.costs[name] || []; }
    });
}

// A client restart: a fresh boot on the same disk. The game keeps what it holds
// and the run comes back from its file; the record arrays are shared, so counts
// span the restart. Changes a test made to a core def do not survive it, like
// everything else in memory.
var SHARED = ['raises', 'claims', 'sentClaims', 'zoneSends', 'buffActions', 'productionOrders', 'closes'];
var CARRIED = ['t', 'adventures', 'stock', 'queues', 'pop', 'popNoEffect', 'quests', 'camps', 'auto',
    'travelMs', 'resources', 'costs', 'blocked', 'pickups'];

function restart(w) {
    var viewed = w.gi.mCurrentViewedZoneID;
    var w2 = W.world({
        home: true, fs: w.fs, generals: w.lists[HOME], away: w.lists[ZONE],
        free: w.frees[HOME], awayFree: w.frees[ZONE],
        settings: w.S.kernel.settings.read('adventures') || {}
    });
    w2.g1 = w.g1;
    w2.g2 = w.g2;
    w2.gi = w2.H.host.game.gi;
    CARRIED.forEach(function (k) { w2[k] = w[k]; });
    w2.gi.visitZone(viewed);
    SHARED.forEach(function (k) { w2[k] = w[k]; });
    w2.mod.boot();
    assert.ok(w2.st.run(), 'the run came back from the file');
    return w2;
}

// ---- def changes -------------------------------------------------------------

function patchDef(holder, name, change) {
    var make = holder[name];
    holder[name] = function () {
        var def = make.apply(holder, arguments);
        change(def);
        return def;
    };
}

function changeDef(w, site, change) {
    var c = site.core(w.S);
    patchDef(c[0], c[1], change);
}

function slow(w, site) {
    changeDef(w, site, function (def) { def.check = function () { return false; }; });
}

function verified(w, site) {
    changeDef(w, site, function (def) { def.check = function () { return true; }; });
}

function refused(w, site) {
    changeDef(w, site, function (def) { def.precheck = function () { return LOST; }; });
}

function sendFails(w, site) {
    changeDef(w, site, function (def) { def.send = function () { return false; }; });
}

// A claim that went out and did nothing yet: the quest stays listed.
function claimLands(w, lands) {
    var claim = w.S.core.quests.claim;
    w.S.core.quests.claim = function (key, opts) {
        var def = claim(key, opts);
        var send = def.send;
        def.send = function () {
            w.sentClaims.push(key);
            return lands ? send() : true;
        };
        return def;
    };
}

// ---- passes ------------------------------------------------------------------

function at(name) {
    return function (w2, n) { return n === name; };
}

function drive(w, o) {
    for (var i = 0; i < (o.max || 40); i++) {
        var r = w.st.run();
        if (!r || r.status !== w.S.RunStatus.Running) return i;
        if (o.until && o.until(w, stepName(w))) return i;
        tick(w);
        play(w);
        w.t += 1000;
    }
    return i;
}

// Passes on the scheduler tick up to the time end, the last one exactly at it.
function passTo(w, end) {
    while (w.t < end) {
        w.t = Math.min(w.t + TICK_MS, end);
        tick(w);
        play(w);
    }
}

function assertStep(w, name) {
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Running, 'status ' + r.status + (r.pause ? ': ' + r.pause.message : ''));
    assert.strictEqual(stepName(w), name, 'step ' + stepName(w));
}

function assertPaused(w, reason, re) {
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Paused, 'status ' + r.status + ' at ' + stepName(w));
    assert.strictEqual(r.pause.reason, w.S.RunPause[reason], 'reason ' + r.pause.reason + ': ' + r.pause.message);
    if (re) assert.ok(re.test(r.pause.message), r.pause.message);
}

function logged(w, re, level) {
    return w.H.logs().some(function (l) {
        return l.category === 'adventures' && (!level || l.level === level) && re.test(l.args.join(' '));
    });
}

function orderWait(w) {
    return w.S.modules.adventures.loader.ORDER_WAIT_MS;
}

function busyText(w) {
    var b = w.st.current().busy;
    return b ? b.text : null;
}

// ---- the sites ---------------------------------------------------------------

function travel(w) {
    w.g1.state.task = { type: w.code.travel, remaining: 1000 };
    w.g1.state.travelling = true;
}

// Sends of unit orders are recorded, but the queue does not fill by itself.
function queueLags(w) {
    var cm = w.gi.mClientMessages;
    var send = cm.SendMessagetoServer;
    cm.SendMessagetoServer = function (id, zone, data) {
        if (id !== 91) return send.apply(this, arguments);
        w.productionOrders.push({ unit: data.type_string, amount: data.amount * data.stacks, t: w.t });
    };
}

// make: the run at its step, with the effect withheld. sends: packets that went
// out. effect: what the game shows late. next: the step that takes over. wait:
// the name in the waiting text. reason, text: the pause of an effect that never
// comes. fail: the words of a failure that pauses at once. seen: how the site
// ends when the send verified and its effect stays away, for the sites where
// that is a wait of its own; resends says whether a Resume sends again then.
var SITES = [
    {
        name: 'Map start', mark: 'map', step: 'StartMap', next: 'Depart', wait: 'map start',
        reason: 'NotObserved', text: /map start sent but not seen/, failure: 'MapFailed', fail: /start map failed/,
        core: function (S) { return [S.core.buffs, 'map']; },
        make: function () {
            var w = homeWorld();
            w.auto.map = false;
            series(w, { step: w.S.RunStep.StartMap });
            return w;
        },
        sends: function (w) { return w.buffActions.filter(function (b) { return b.type === 'Adventure'; }).length; },
        effect: function (w) { w.adventures.push({ adventureName: 'BlackKnights', zoneID: ZONE }); },
        seen: { reason: 'MapFailed', text: /map started but not listed/, resends: false }
    },
    {
        name: 'Depart', mark: 'depart:1.1', step: 'Depart', next: 'Jump', wait: 'departure of 1.1',
        reason: 'NotObserved', text: /departure of 1\.1 sent but not seen/, failure: 'DepartFailed', fail: /send 1\.1 failed/,
        core: function (S) { return [S.core.specialists.orders, 'sendToZone']; },
        make: function () {
            var w = homeWorld({ mapOpen: true });
            w.auto.travel = false;
            series(w, { step: w.S.RunStep.Depart, zoneId: ZONE });
            return w;
        },
        sends: function (w) { return w.zoneSends.length; },
        effect: travel,
        seen: { reason: 'NotObserved', text: /departure of 1\.1 sent but not seen/, resends: true }
    },
    {
        name: 'Recall', mark: 'recall:1.1', step: 'Recall', next: 'JumpHome', wait: 'return of Anna (1.1)',
        reason: 'NotObserved', text: /return of Anna \(1\.1\) sent but not seen/,
        failure: 'DepartFailed', fail: /send 1\.1 home failed/,
        core: function (S) { return [S.core.specialists.orders, 'sendToZone']; },
        make: function () {
            var w = homeWorld();
            onIsland(w, [w.g1]);
            w.auto.travel = false;
            series(w, { step: w.S.RunStep.Recall, zoneId: ZONE });
            return w;
        },
        sends: function (w) { return w.zoneSends.length; },
        effect: travel
    },
    {
        name: 'Claim', mark: 'lastQuest', step: 'LastQuest', next: 'Close', wait: 'last quest claim',
        reason: 'NotObserved', text: /last quest claim sent but not seen/, failure: 'QuestFailed', fail: /claim last quest failed/,
        core: function (S) { return [S.core.quests, 'claim']; },
        make: function () {
            var w = homeWorld();
            onIsland(w, [w.g1]);
            w.quests = [{ key: 'q9', name: 'Final', finished: true, last: true }];
            claimLands(w, false);
            series(w, { step: w.S.RunStep.LastQuest, zoneId: ZONE });
            return w;
        },
        sends: function (w) { return w.sentClaims.length; },
        effect: function (w) { w.adventures = []; }
    },
    {
        name: 'Close', mark: 'close', step: 'Close', next: 'Recall', wait: 'close',
        reason: 'NotObserved', text: /close sent but the adventure is still listed/, failure: 'CloseFailed', fail: /close failed/,
        core: function (S) { return [S.core.adventures, 'close']; },
        make: function () {
            var w = homeWorld();
            onIsland(w, [w.g1]);
            w.auto.close = false;
            series(w, { step: w.S.RunStep.Close, zoneId: ZONE, run: { marks: plain(CLAIMED) } });
            return w;
        },
        sends: function (w) { return w.closes.length; },
        effect: function (w) { w.adventures = []; }
    },
    {
        name: 'Population', mark: 'population', step: 'Population', next: 'Retrain', wait: 'population buff',
        reason: 'NotObserved', text: /population buff sent but free population did not rise/,
        failure: 'RetrainFailed', fail: /population buff failed/,
        core: function (S) { return [S.core.buffs, 'population']; },
        make: function () {
            var w = homeWorld({ free: { Rifle: 10 }, pop: 4, popNoEffect: true });
            series(w, { step: w.S.RunStep.Population, run: { snapshot: { Rifle: 20 } } });
            return w;
        },
        sends: function (w) { return w.buffActions.filter(function (b) { return b.type === 'AddResource'; }).length; },
        effect: function (w) { w.pop += 6; },
        seen: { reason: 'RetrainFailed', text: /verified but free population did not rise/, resends: false }
    },
    {
        name: 'Unit order', mark: 'order:Rifle', step: 'Retrain', next: 'Next', wait: 'order of Rifle',
        reason: 'NotObserved', text: /order of Rifle sent but not seen in the queue/,
        failure: 'RetrainFailed', fail: /order Rifle failed/,
        core: function (S) { return [S.core.production, 'order']; },
        make: function () {
            var w = homeWorld({ free: { Rifle: 10 } });
            queueLags(w);
            series(w, { step: w.S.RunStep.Retrain, run: { snapshot: { Rifle: 20 } } });
            return w;
        },
        sends: function (w) { return w.productionOrders.length; },
        effect: function (w) { w.queues[0].entries.push({ type: 'Rifle', amount: 10 }); },
        seen: { reason: 'NotObserved', text: /order of Rifle sent but not seen in the queue/, resends: true }
    }
];

// The send has gone out and the attempt has ended. Returns the send's time.
function sendAndFinish(w, site) {
    drive(w, { until: function () { return site.sends(w) > 0; }, max: 60 });
    assert.strictEqual(site.sends(w), 1, 'the order went out');
    play(w);
    var at0 = w.st.run().marks[site.mark].sentAt;
    assert.strictEqual(typeof at0, 'number', 'the mark holds the send time');
    return at0;
}

// The send has gone out and its verify is still queued, the moment a restart
// loses it.
function sendInFlight(w, site) {
    for (var i = 0; i < 60 && site.sends(w) === 0; i++) {
        tick(w);
        play(w, function () { return site.sends(w) > 0; });
        if (site.sends(w) === 0) w.t += 1000;
    }
    assert.strictEqual(site.sends(w), 1, 'the order went out');
    assert.ok(w.pending.length > 0, 'the verify is still queued');
    return w.st.run().marks[site.mark].sentAt;
}

// Passes up to the end of the wait, then the pass that ends it.
function assertPausesAtWait(w, site, sentAt) {
    var limit = sentAt + orderWait(w);
    passTo(w, limit - 1);
    assertStep(w, site.step);
    w.t = limit;
    tick(w);
    assertPaused(w, site.reason, site.text);
    assert.strictEqual(w.st.run().pause.at - sentAt, orderWait(w), 'paused exactly at the end of the wait');
    assert.strictEqual(site.sends(w), 1, 'exactly one send');
}

// ---- slower than the attempt's window ------------------------------------------

SITES.forEach(function (site) {
    t.test(site.name + ': an effect slower than the attempt window gets exactly one send and a named wait', function () {
        var w = site.make();
        slow(w, site);
        var sentAt = sendAndFinish(w, site);
        assert.ok(w.t - sentAt < orderWait(w), 'the attempt ended inside the wait');
        passTo(w, sentAt + orderWait(w) - 1);
        assertStep(w, site.step);
        assert.strictEqual(site.sends(w), 1);
        assert.strictEqual(busyText(w), site.wait + ' sent, waiting to see it');
        assert.strictEqual(w.st.run().rounds, 0, 'no round was counted');
    });

    t.test(site.name + ': an effect 1 s before the end of the wait moves on with no second send', function () {
        var w = site.make();
        slow(w, site);
        var sentAt = sendAndFinish(w, site);
        passTo(w, sentAt + orderWait(w) - 1000);
        assertStep(w, site.step);
        site.effect(w);
        drive(w, { until: at(site.next), max: 5 });
        assertStep(w, site.next);
        assert.strictEqual(site.sends(w), 1);
    });

    t.test(site.name + ': no effect pauses with the site\'s reason at the end of the wait', function () {
        var w = site.make();
        slow(w, site);
        assertPausesAtWait(w, site, sendAndFinish(w, site));
    });

    t.test(site.name + ': a restart inside the wait keeps waiting from the send and never sends', function () {
        var w = site.make();
        slow(w, site);
        var sentAt = sendAndFinish(w, site);
        passTo(w, sentAt + orderWait(w) / 2);
        assertPausesAtWait(restart(w), site, sentAt);
    });

    t.test(site.name + ': a restart with the verify in flight keeps waiting and never sends', function () {
        var w = site.make();
        slow(w, site);
        var sentAt = sendInFlight(w, site);
        assertPausesAtWait(restart(w), site, sentAt);
    });

    t.test(site.name + ': Resume after the pause may send, once', function () {
        var w = site.make();
        slow(w, site);
        assertPausesAtWait(w, site, sendAndFinish(w, site));
        assert.strictEqual(w.S.modules.adventures.run.resume(), true);
        drive(w, { until: function () { return site.sends(w) > 1; }, max: 60 });
        assert.strictEqual(site.sends(w), 2, 'the user looked, so it goes out again');
        play(w);
        passTo(w, w.t + orderWait(w) - 1000 * 60);
        assertStep(w, site.step);
        assert.strictEqual(site.sends(w), 2);
    });

    t.test(site.name + ': a refused order pauses at once, nothing sent', function () {
        var w = site.make();
        refused(w, site);
        var from = w.t;
        drive(w, { max: 60 });
        assertPaused(w, site.failure, site.fail);
        assert.ok(new RegExp(LOST).test(w.st.run().pause.message), w.st.run().pause.message);
        assert.strictEqual(site.sends(w), 0);
        assert.ok(w.t - from < orderWait(w), 'no wait before the pause');
    });

    t.test(site.name + ': a send that fails pauses at once, with no second try', function () {
        var w = site.make();
        sendFails(w, site);
        var from = w.t;
        drive(w, { max: 60 });
        assertPaused(w, site.failure, site.fail);
        assert.ok(/send failed/.test(w.st.run().pause.message), w.st.run().pause.message);
        assert.ok(w.t - from < orderWait(w), 'no wait before the pause');
        assert.ok(logged(w, new RegExp(site.mark + ' sent')), 'the one try is logged');
        assert.strictEqual(w.H.logs().filter(function (l) {
            return new RegExp(site.mark + ' sent').test(l.args.join(' '));
        }).length, 1);
    });
});

// ---- verified, and the effect stays away ---------------------------------------

SITES.filter(function (s) { return !!s.seen; }).forEach(function (site) {
    t.test(site.name + ': verified with no effect waits across a restart, then pauses with no second send', function () {
        var w = site.make();
        verified(w, site);
        var sentAt = sendAndFinish(w, site);
        assert.strictEqual(w.st.run().marks[site.mark].seen, true);
        passTo(w, sentAt + orderWait(w) / 2);
        assertStep(w, site.step);
        assert.strictEqual(busyText(w), site.wait + ' sent, waiting to see it');
        w = restart(w);
        passTo(w, sentAt + orderWait(w) - 1);
        assertStep(w, site.step);
        w.t = sentAt + orderWait(w) + 1;
        tick(w);
        assertPaused(w, site.seen.reason, site.seen.text);
        assert.strictEqual(site.sends(w), 1);
    });

    t.test(site.name + ': verified with no effect moves on when the effect shows late', function () {
        var w = site.make();
        verified(w, site);
        var sentAt = sendAndFinish(w, site);
        passTo(w, sentAt + orderWait(w) - 1000);
        site.effect(w);
        drive(w, { until: at(site.next), max: 5 });
        assertStep(w, site.next);
        assert.strictEqual(site.sends(w), 1);
    });

    t.test(site.name + ': Resume after a verified order ' + (site.seen.resends ? 'may send' : 'never sends again'), function () {
        var w = site.make();
        verified(w, site);
        var sentAt = sendAndFinish(w, site);
        passTo(w, sentAt + orderWait(w) + 1000);
        assertPaused(w, site.seen.reason, site.seen.text);
        assert.strictEqual(w.S.modules.adventures.run.resume(), true);
        if (site.seen.resends) {
            drive(w, { until: function () { return site.sends(w) > 1; }, max: 60 });
            assert.strictEqual(site.sends(w), 2);
            return;
        }
        drive(w, { max: 10 });
        assertStep(w, site.step);
        passTo(w, w.t + orderWait(w) + 1000);
        assertPaused(w, site.seen.reason, site.seen.text);
        assert.strictEqual(site.sends(w), 1);
    });
});

// ---- the horseshoe -------------------------------------------------------------

function horseshoeWorld() {
    var w = homeWorld();
    onIsland(w, [w.g1]);
    w.stock.push({ type: 'GeneralSpeedBuff_A', resource: '', amount: 2, uid: 'spd' });
    series(w, { step: w.S.RunStep.Horseshoe, zoneId: ZONE, speedBuff: 'GeneralSpeedBuff_A' });
    return w;
}

function speeds(w) {
    return w.buffActions.filter(function (b) { return b.type === 'GeneralSpeedBuff_A'; }).length;
}

function speedSite() {
    return { core: function (S) { return [S.core.buffs, 'speed']; } };
}

t.test('Horseshoe: a slow effect sends once, warns and goes to Gate with no wait', function () {
    var w = horseshoeWorld();
    slow(w, speedSite());
    drive(w, { until: at('Gate'), max: 20 });
    assertStep(w, 'Gate');
    assert.strictEqual(speeds(w), 1);
    var mark = w.st.run().marks.speed;
    assert.strictEqual(mark.sentOnce, true);
    assert.strictEqual(mark.seen, false);
    assert.ok(logged(w, /horseshoe not applied/, 'warn'));
    assert.ok(!logged(w, /sent, waiting to see it/), 'it never waits');
    assert.ok(w.t - mark.sentAt < orderWait(w), 'it moves on within the attempt window');
    assert.strictEqual(w.st.run().pause, null);
});

t.test('Horseshoe: a step entered again after the send sends nothing', function () {
    var w = horseshoeWorld();
    slow(w, speedSite());
    drive(w, { until: at('Gate'), max: 20 });
    w.st.go(w.S.RunStep.Horseshoe, 'again');
    tick(w);
    play(w);
    assertStep(w, 'Gate');
    assert.ok(logged(w, /horseshoe already sent \(not seen\)/));
    assert.strictEqual(speeds(w), 1);
});

t.test('Horseshoe: a refused one warns and goes to Gate; nothing sent', function () {
    var w = horseshoeWorld();
    refused(w, speedSite());
    drive(w, { until: at('Gate'), max: 20 });
    assertStep(w, 'Gate');
    assert.strictEqual(speeds(w), 0);
    assert.ok(logged(w, /horseshoe not applied/, 'warn'));
});

// ---- a raise carries no mark -----------------------------------------------------

// A carrier and two generals on the map, the free pool waiting to be packed.
function packWorld() {
    var w = homeWorld();
    addElite(w, 'Knight');
    w.g1 = gen('1.1', 'Anna', 10, {}, { maxUnits: 4 });
    w.g2 = gen('1.2', 'Bert', 20, {}, { maxUnits: 2 });
    var c = gen('1.5', 'Cara', 30, {}, { carrier: true, maxUnits: 10 });
    onIsland(w, [w.g1, w.g2, c], { Rifle: 13, Knight: 5 });
    return w;
}

t.test('Pack: a raise never seen pauses PackFailed and does not go out again', function () {
    var w = packWorld();
    w.auto.raise = false;
    series(w, { step: w.S.RunStep.Pack, zoneId: ZONE, keys: PACK_KEYS });
    drive(w, { max: 40 });
    assertPaused(w, 'PackFailed', /pack \S+ refused: not observed/);
    var raises = w.raises.length;
    assert.ok(raises > 0, 'the raises went out');
    assert.ok(!logged(w, /Pack -> Pack/), 'an unseen raise is no packed round');
    passTo(w, w.t + 600000);
    assert.strictEqual(w.raises.length, raises);
});

// ---- a claim seen late -------------------------------------------------------------

function claimWorld(lands) {
    var w = homeWorld();
    onIsland(w, [w.g1]);
    w.quests = [{ key: 'q9', name: 'Final', finished: true, last: true }];
    claimLands(w, lands);
    series(w, { step: w.S.RunStep.LastQuest, zoneId: ZONE });
    return w;
}

var CLAIM = SITES.filter(function (s) { return s.mark === 'lastQuest'; })[0];

t.test('LastQuest: a claim that leaves the list unseen moves to Close after the grace', function () {
    var w = claimWorld(true);
    slow(w, CLAIM);
    sendAndFinish(w, CLAIM);
    tick(w);
    play(w);
    var grace = w.S.modules.adventures.loader.MISSING_GRACE_MS;
    var from = w.t;
    assert.deepStrictEqual(plain(w.quests), []);
    passTo(w, from + grace - 1000);
    assertStep(w, 'LastQuest');
    assert.strictEqual(w.st.run().marks.lastQuest.seen, false);
    passTo(w, from + grace);
    assertStep(w, 'Close');
    assert.strictEqual(w.st.run().marks.lastQuest.seen, true);
    assert.ok(logged(w, /last quest left the list after the claim/));
    assert.strictEqual(CLAIM.sends(w), 1);
});

t.test('LastQuest: one read that skips the quest is no proof of the claim', function () {
    var w = claimWorld(false);
    slow(w, CLAIM);
    var sentAt = sendAndFinish(w, CLAIM);
    passTo(w, sentAt + orderWait(w) / 2);
    var quests = w.quests;
    w.quests = [];
    w.t += TICK_MS;
    tick(w);
    play(w);
    assertStep(w, 'LastQuest');
    w.quests = quests;
    assertPausesAtWait(w, CLAIM, sentAt);
    assert.strictEqual(w.st.run().marks.lastQuest.seen, false);
});
