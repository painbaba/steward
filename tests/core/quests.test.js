'use strict';

var t = require('../runner');
var harness = require('../harness');
var AC = require('../stubs/actions');

// A fake quest pool. Each quest: { key, name, finished, special, throwOn }.
// The pool can be made unreadable through world.broken.
function world(H, quests) {
    var w = { quests: quests, broken: false, modes: [] };
    function fake(q) {
        return {
            GetUniqueId:       function () {
                if (q.throwOn === 'uid') throw new Error('uid failed');
                return { toKeyString: function () { return q.key; } };
            },
            getQuestName_string: function () { return q.name || q.key; },
            isFinished:          function () { return q.finished === true; },
            SetQuestMode:        function (mode) { w.modes.push(mode); },
            GetQuestDefinition:  function () { return { specialType_string: q.special || '' }; }
        };
    }
    H.host.game.quests = {
        GetQuestPool: function () {
            if (w.broken) throw new Error('pool failed');
            return {
                GetQuest_vector: function () {
                    var out = [];
                    for (var i = 0; i < w.quests.length; i++) out.push(fake(w.quests[i]));
                    return out;
                }
            };
        }
    };
    return w;
}

function boot(quests) {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    H.host.game.gi.mCurrentViewedZoneID = 5;
    var sent = AC.wire(H);
    var w = world(H, quests);
    return { H: H, S: H.Steward, Q: H.Steward.core.quests, sent: sent, w: w };
}

function run(b, def, onStep) {
    var result = null;
    b.S.core.actions.attempt(def, function (r) { result = r; });
    AC.drive(b.H, { onStep: onStep });
    return result;
}

function keys(l) {
    return l.map(function (e) { return e.key; }).join(',');
}

function drop(b, key) {
    b.w.quests = b.w.quests.filter(function (q) { return q.key !== key; });
}

t.test('list marks finished and last', function () {
    var b = boot([
        { key: 'a', name: 'First', finished: true },
        { key: 'b', name: 'Final', finished: false, special: 'x,lastQuest' }
    ]);
    var l = b.Q.list();
    t.assert.strictEqual(l.length, 2);
    t.assert.strictEqual(JSON.stringify(l[0]), JSON.stringify({ key: 'a', name: 'First', finished: true, last: false }));
    t.assert.strictEqual(l[1].last, true);
    t.assert.strictEqual(l[1].finished, false);
    t.assert.strictEqual(keys(b.Q.finished()), 'a');
});

t.test('list returns an empty array for an empty pool', function () {
    var b = boot([]);
    t.assert.strictEqual(b.Q.list().length, 0);
    t.assert.strictEqual(b.Q.finished().length, 0);
});

t.test('list returns null when the pool cannot be read', function () {
    var b = boot([{ key: 'a', finished: true }]);
    b.w.broken = true;
    t.assert.strictEqual(b.Q.list(), null);
    t.assert.strictEqual(b.Q.finished(), null);
    b.w.broken = false;
    b.H.host.game.quests = undefined;
    t.assert.strictEqual(b.Q.list(), null);
});

t.test('list skips an entry that cannot be read', function () {
    var b = boot([{ key: 'a', finished: true, throwOn: 'uid' }, { key: 'b', finished: true }]);
    t.assert.strictEqual(keys(b.Q.list()), 'b');
});

t.test('claim refuses the last quest unless allowed', function () {
    var b = boot([{ key: 'z', finished: true, special: 'lastQuest' }]);
    var r = run(b, b.Q.claim('z'));
    t.assert.strictEqual(r.status, b.S.ActionResult.Refused);
    t.assert.strictEqual(r.reason, 'last quest');
    t.assert.strictEqual(b.sent.messages.length, 0);

    r = run(b, b.Q.claim('z', { allowLast: true }), function () { drop(b, 'z'); });
    t.assert.strictEqual(r.status, b.S.ActionResult.Verified);
    t.assert.strictEqual(b.sent.messages.length, 1);
});

t.test('claim refuses an unknown key without sending', function () {
    var b = boot([{ key: 'a', finished: true }]);
    var r = run(b, b.Q.claim('nope'));
    t.assert.strictEqual(r.status, b.S.ActionResult.Refused);
    t.assert.strictEqual(r.reason, 'quest not found');
    t.assert.strictEqual(r.sends, 0);
    t.assert.strictEqual(b.sent.messages.length, 0);
});

t.test('claim refuses a quest that is not finished', function () {
    var b = boot([{ key: 'a', finished: false }]);
    var r = run(b, b.Q.claim('a'));
    t.assert.strictEqual(r.status, b.S.ActionResult.Refused);
    t.assert.strictEqual(r.reason, 'quest not finished');
    t.assert.strictEqual(b.sent.messages.length, 0);
});

t.test('claim refuses while the pool cannot be read', function () {
    var b = boot([{ key: 'a', finished: true }]);
    b.w.broken = true;
    var r = run(b, b.Q.claim('a'));
    t.assert.strictEqual(r.status, b.S.ActionResult.Refused);
    t.assert.strictEqual(r.reason, 'quests unreadable');
    t.assert.strictEqual(b.sent.messages.length, 0);
});

t.test('claim sends 100 with type 1 and the quest uid', function () {
    var b = boot([{ key: 'a', finished: true }]);
    var r = run(b, b.Q.claim('a'), function () { drop(b, 'a'); });
    t.assert.strictEqual(r.status, b.S.ActionResult.Verified);
    t.assert.strictEqual(r.sends, 1);
    t.assert.strictEqual(b.sent.messages.length, 1);
    var m = b.sent.messages[0];
    t.assert.strictEqual(m.id, 100);
    t.assert.strictEqual(m.data.type, 1);
    t.assert.strictEqual(m.data.data.toKeyString(), 'a');
    t.assert.deepStrictEqual(b.w.modes, [1]);
});

t.test('claim verified when the quest leaves the pool', function () {
    var b = boot([{ key: 'a', finished: true }, { key: 'b', finished: true }]);
    var r = run(b, b.Q.claim('a'), function (n) { if (n === 2) drop(b, 'a'); });
    t.assert.strictEqual(r.status, b.S.ActionResult.Verified);
    t.assert.strictEqual(r.sends, 1);
});

t.test('claim is not verified when only isFinished turns false', function () {
    var b = boot([{ key: 'a', finished: true }]);
    var r = run(b, b.Q.claim('a'), function () { b.w.quests[0].finished = false; });
    t.assert.strictEqual(r.status, b.S.ActionResult.Failed);
    t.assert.strictEqual(r.sends, 2);
    t.assert.strictEqual(b.sent.messages.length, 2);
});

t.test('claim does not verify while the pool cannot be read', function () {
    var b = boot([{ key: 'a', finished: true }]);
    var r = run(b, b.Q.claim('a'), function () { b.w.broken = true; });
    t.assert.strictEqual(r.status, b.S.ActionResult.Failed);
    t.assert.strictEqual(b.sent.messages.length, 1);
});

t.test('claim retry is not refused because the quest no longer reads finished', function () {
    var b = boot([{ key: 'a', finished: true }]);
    var d = b.Q.claim('a');
    d.timeoutMs = 1;
    var r = run(b, d, function () {
        if (b.w.quests[0]) b.w.quests[0].finished = false;
        if (b.sent.messages.length === 2) drop(b, 'a');
    });
    // The retry went out (two sends) instead of being refused on isFinished.
    t.assert.strictEqual(b.sent.messages.length, 2);
    t.assert.strictEqual(r.status, b.S.ActionResult.Verified);
    t.assert.strictEqual(r.sends, 2);
});

t.test('claim is not verified when the zone changes and the quest is absent there', function () {
    var b = boot([{ key: 'a', finished: true }]);
    var r = run(b, b.Q.claim('a'), function () {
        if (b.sent.messages.length < 1) return;
        b.H.host.game.gi.mCurrentViewedZoneID = 6;
        drop(b, 'a');
    });
    t.assert.strictEqual(r.status, b.S.ActionResult.Failed);
    // The retry is refused (the quest is not in the new zone's pool); the
    // point is that the absence is never taken as a claim.
    t.assert.strictEqual(r.sends, 1);
});
