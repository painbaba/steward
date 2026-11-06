'use strict';

var t = require('../runner');
var harness = require('../harness');
var AC = require('../stubs/actions');

var ZONE = 7;

function trig(name, idx) {
    return { triggerIdx: idx, type: 1, condition: 9, name_string: name };
}

// Quest that waits for the named objects. opts: finished, active, status.
function quest(namesList, opts) {
    opts = opts || {};
    var triggers = namesList.map(function (n, i) { return trig(n, i); });
    var statuses = namesList.map(function () { return { status: opts.status || 0 }; });
    return {
        isFinished:    function () { return opts.finished === true; },
        IsQuestActive: function () { return opts.active !== false; },
        GetQuestDefinition: function () { return { questTriggers_vector: triggers }; },
        mQuestTriggersFinished_vector: statuses
    };
}

// The Arctic shape: neutral, selectable, attackable, owned by the zone id.
function obj(name, grid, extra) {
    var o = { name: name, grid: grid, selectable: true, attackable: true, playerId: ZONE };
    for (var k in (extra || {})) o[k] = extra[k];
    return o;
}

// opts.adventure (default true), opts.quests (fake quests), opts.objects
// (building opts), opts.collectibles (names the host flags as collectible).
function boot(opts) {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var gi = H.host.game.gi;
    var z = H.zone.zone();
    var made = (opts.objects || []).map(function (o) { return H.zone.building(o); });
    made.forEach(function (b) { z.building(b); });
    gi.mCurrentPlayer = {};
    gi.mCurrentPlayerZone = z.zone;
    z.mountOnPlayer(gi.mCurrentPlayer);
    gi.mCurrentPlayer.mIsAdventureZone = opts.adventure !== false;
    gi.mCurrentViewedZoneID = ZONE;
    var list = opts.quests || [];
    H.host.game.quests = {
        GetQuestPool: function () {
            return { GetQuest_vector: function () { return list; } };
        }
    };
    var flagged = opts.collectibles || [];
    H.Steward.core.buildings.isCollectible = function (b) {
        return flagged.indexOf(H.Steward.core.buildings.name(b)) > -1;
    };
    var sent = AC.wire(H);
    var selected = [];
    gi.SelectBuilding = function (b) { selected.push(b); };
    H.Steward.core.buildings.invalidate();
    return {
        H: H, S: H.Steward, P: H.Steward.core.pickups, gi: gi,
        buildings: z.zone.mStreetDataMap.mBuildingContainer,
        made: made, sent: sent, selected: selected
    };
}

function grids(list) {
    return list.map(function (x) { return x.kind + ':' + x.name + '@' + x.grid; }).join(',');
}

function targets(b, opts) {
    b.S.core.buildings.invalidate();
    return b.P.targets(opts || { quests: true });
}

// Runs the def to its result, driving the queue; onStep runs after each poll.
function run(b, def, onStep) {
    var result = null;
    b.S.core.actions.attempt(def, function (r) { result = r; });
    AC.drive(b.H, { onStep: onStep });
    return result;
}

function remove(b, building) {
    b.buildings.splice(b.buildings.indexOf(building), 1);
}

// ---- targets -------------------------------------------------------------------

t.test('targets returns the Arctic shape as a quest target', function () {
    var b = boot({
        quests: [quest(['crate'])],
        objects: [obj('crate', 12)]
    });
    var l = targets(b);
    t.assert.strictEqual(grids(l), 'quest:crate@12');
    t.assert.strictEqual(l[0].zoneId, ZONE);
});

t.test('targets excludes what a click cannot or must not reach', function () {
    var b = boot({
        quests: [quest(['crate'])],
        objects: [
            obj('crate', 1, { playerId: 0 }),
            obj('crate', 2, { ui: 'enemy' }),
            obj('crate', 3, { leaderCamp: true }),
            obj('crate', 4, { hasArmy: true }),
            obj('crate', 5, { selectable: false }),
            obj('crate', 6, { attackable: false }),
            obj('barrel', 7),
            obj('crate', 8)
        ]
    });
    t.assert.strictEqual(grids(targets(b)), 'quest:crate@8');
});

t.test('targets ignores triggers that are done, inactive, finished or half loaded', function () {
    var b = boot({
        quests: [
            quest(['a'], { status: 1 }),
            quest(['b'], { active: false }),
            quest(['c'], { finished: true }),
            { GetUniqueId: function () { return null; } }
        ],
        objects: [obj('a', 1), obj('b', 2), obj('c', 3)]
    });
    t.assert.strictEqual(grids(targets(b)), '');
});

t.test('targets ignores triggers of another type or condition', function () {
    var q = quest(['a', 'b']);
    q.GetQuestDefinition = function () {
        var x = trig('a', 0);
        x.type = 2;
        var y = trig('b', 1);
        y.condition = 3;
        return { questTriggers_vector: [x, y] };
    };
    var b = boot({ quests: [q], objects: [obj('a', 1), obj('b', 2)] });
    t.assert.strictEqual(grids(targets(b)), '');
});

t.test('targets is null on an unreadable quest pool', function () {
    var b = boot({ quests: [quest(['crate'])], objects: [obj('crate', 1)] });
    b.H.host.game.quests = undefined;
    t.assert.strictEqual(targets(b), null);
});

t.test('targets is null on an empty building list', function () {
    var b = boot({ quests: [quest(['crate'])], objects: [] });
    t.assert.strictEqual(targets(b), null);
});

t.test('targets is null when the zone id is not a number', function () {
    var b = boot({ quests: [quest(['crate'])], objects: [obj('crate', 1)] });
    b.gi.mCurrentViewedZoneID = undefined;
    t.assert.strictEqual(targets(b), null);
});

t.test('targets finds no quest objects on home but still finds collectibles', function () {
    var b = boot({
        adventure: false,
        quests: [quest(['crate'])],
        objects: [obj('crate', 1), obj('BuildingStripedEggs', 2, { playerId: 0 })],
        collectibles: ['BuildingStripedEggs']
    });
    t.assert.strictEqual(grids(targets(b, { quests: true, patterns: ['StripedEggs'] })),
        'collectible:BuildingStripedEggs@2');
});

t.test('targets without patterns lists no collectibles; with patterns it filters by name', function () {
    var b = boot({
        objects: [obj('BuildingStripedEggs', 1), obj('BuildingCharcoal', 2)],
        collectibles: ['BuildingStripedEggs', 'BuildingCharcoal']
    });
    t.assert.strictEqual(grids(targets(b, { quests: true })), '');
    t.assert.strictEqual(grids(targets(b, { patterns: ['Eggs'] })), 'collectible:BuildingStripedEggs@1');
});

t.test('targets keeps building-list order and prefers the quest kind', function () {
    var b = boot({
        quests: [quest(['BuildingStripedEggs'])],
        objects: [obj('other', 3), obj('BuildingStripedEggs', 2), obj('BuildingStripedEggs', 1, { playerId: 0 })],
        collectibles: ['BuildingStripedEggs']
    });
    t.assert.strictEqual(
        grids(targets(b, { quests: true, patterns: ['Eggs'] })),
        'quest:BuildingStripedEggs@2,collectible:BuildingStripedEggs@1'
    );
});

t.test('quests are not read when the caller does not ask for them', function () {
    var b = boot({ objects: [obj('crate', 1)] });
    b.H.host.game.quests = undefined;
    t.assert.strictEqual(grids(targets(b, { patterns: ['crate'] })), '');
});

// ---- click ---------------------------------------------------------------------

function bootQuest() {
    return boot({ quests: [quest(['crate'])], objects: [obj('crate', 12), obj('crate', 13)] });
}

function questTarget(b, grid) {
    var l = targets(b);
    for (var i = 0; i < l.length; i++) {
        if (l[i].grid === grid) return l[i];
    }
    return null;
}

t.test('click refuses a target that is gone, renamed, on another zone or not selectable', function () {
    var R = 'ActionRefused';
    var b = bootQuest();
    var tg = questTarget(b, 12);
    remove(b, b.made[0]);
    var r = run(b, b.P.click(tg));
    t.assert.strictEqual(r.status, R);
    t.assert.strictEqual(r.reason, 'gone');

    b = bootQuest();
    tg = questTarget(b, 12);
    tg.name = 'barrel';
    r = run(b, b.P.click(tg));
    t.assert.strictEqual(r.status, R);
    t.assert.strictEqual(r.reason, 'other building');

    b = bootQuest();
    tg = questTarget(b, 12);
    b.gi.mCurrentViewedZoneID = ZONE + 1;
    r = run(b, b.P.click(tg));
    t.assert.strictEqual(r.status, R);
    t.assert.strictEqual(r.reason, 'zone changed');

    b = bootQuest();
    tg = questTarget(b, 12);
    b.made[0].mIsSelectable = false;
    r = run(b, b.P.click(tg));
    t.assert.strictEqual(r.status, R);
    t.assert.strictEqual(r.reason, 'not selectable');
    t.assert.strictEqual(b.selected.length, 0);
});

t.test('click is verified when mIsSelectable goes from true to false', function () {
    var b = bootQuest();
    var r = run(b, b.P.click(questTarget(b, 12)), function () {
        b.made[0].mIsSelectable = false;
    });
    t.assert.strictEqual(r.status, b.S.ActionResult.Verified);
    t.assert.strictEqual(b.selected.length, 1);
    t.assert.strictEqual(b.selected[0], b.made[0]);
});

t.test('click is verified when a collectible leaves its grid', function () {
    var b = boot({
        adventure: false,
        objects: [obj('BuildingStripedEggs', 4, { playerId: 0, selectable: undefined }), obj('rock', 5)],
        collectibles: ['BuildingStripedEggs']
    });
    var l = targets(b, { patterns: ['Eggs'] });
    t.assert.strictEqual(l.length, 1);
    var r = run(b, b.P.click(l[0]), function () { remove(b, b.made[0]); });
    t.assert.strictEqual(r.status, b.S.ActionResult.Verified);
});

t.test('click is not verified while the object still reads the same', function () {
    var b = bootQuest();
    var r = run(b, b.P.click(questTarget(b, 12)));
    t.assert.strictEqual(r.status, b.S.ActionResult.Failed);
    t.assert.strictEqual(r.unseen, true);
});

t.test('click is not verified when the zone changes after the send', function () {
    var b = bootQuest();
    var r = run(b, b.P.click(questTarget(b, 12)), function () {
        b.gi.mCurrentViewedZoneID = ZONE + 1;
        remove(b, b.made[0]);
    });
    // The retry is refused on the new zone; the absence is never a pick-up.
    t.assert.strictEqual(r.status, b.S.ActionResult.Failed);
    t.assert.strictEqual(b.selected.length, 1);
});

t.test('click is not verified on an unreadable building list', function () {
    var b = bootQuest();
    var r = run(b, b.P.click(questTarget(b, 12)), function () {
        b.buildings.length = 0;
    });
    t.assert.strictEqual(r.status, b.S.ActionResult.Failed);
});

t.test('click label and category name the target', function () {
    var b = bootQuest();
    var d = b.P.click(questTarget(b, 12));
    t.assert.strictEqual(d.label, 'pick up crate at 12');
    t.assert.strictEqual(d.category, 'pickups');
});

t.test('click window is four runner polls of the kernel gap', function () {
    var b = bootQuest();
    var gap = b.S.kernel.TIMEOUTS.QUEUE_ACTION_GAP_MS;
    t.assert.strictEqual(b.P.click(questTarget(b, 12)).timeoutMs, 4 * gap);
    var saved = gap;
    try {
        b.S.kernel.TIMEOUTS.QUEUE_ACTION_GAP_MS = 500;
        t.assert.strictEqual(b.P.click(questTarget(b, 12)).timeoutMs, 2000);
    } finally {
        b.S.kernel.TIMEOUTS.QUEUE_ACTION_GAP_MS = saved;
    }
});

// ---- patterns and matches ------------------------------------------------------

t.test('patterns adds event codes and resources without duplicates', function () {
    var b = boot({});
    var ev = b.S.core.events;
    ev.active = function () { return [{ code: 'Easter' }, { code: 'Halloween' }, { code: 'Easter' }]; };
    ev.eventResource = function (c) { return c === 'Easter' ? 'StripedEggs' : null; };
    var base = ['Halloween'];
    var out = b.P.patterns(base);
    t.assert.deepStrictEqual(out, ['Halloween', 'Easter', 'StripedEggs']);
    t.assert.deepStrictEqual(base, ['Halloween']);
    t.assert.strictEqual(b.P.patterns(null).length, 3);
});

t.test('patterns falls back to the base list when events throw', function () {
    var b = boot({});
    b.S.core.events.active = function () { throw new Error('boom'); };
    t.assert.deepStrictEqual(b.P.patterns(['x']), ['x']);
});

t.test('matches is a substring test over non-empty patterns', function () {
    var b = boot({});
    t.assert.strictEqual(b.P.matches('BuildingStripedEggs', ['Eggs']), true);
    t.assert.strictEqual(b.P.matches('BuildingStripedEggs', ['', 'Nope']), false);
    t.assert.strictEqual(b.P.matches('', ['Eggs']), false);
    t.assert.strictEqual(b.P.matches('x', []), false);
});
