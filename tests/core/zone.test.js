'use strict';

var t = require('../runner');
var harness = require('../harness');

var assert = t.assert;

function setup() {
    var H = harness.boot();
    return { H: H, S: H.Steward, game: H.host.game };
}

t.test('homeId reads game.player first', function () {
    var s = setup();
    s.game.player = { GetHomeZoneId: function () { return 11; } };
    s.game.gi.mCurrentPlayer = { GetHomeZoneId: function () { return 22; } };
    assert.strictEqual(s.S.core.zone.homeId(), 11);
});

t.test('homeId falls back to mCurrentPlayer when game.player does not answer a number', function () {
    var s = setup();
    s.game.player = { GetHomeZoneId: function () { return null; } };
    s.game.gi.mCurrentPlayer = { GetHomeZoneId: function () { return 22; } };
    assert.strictEqual(s.S.core.zone.homeId(), 22);
    s.game.player = { GetHomeZoneId: function () { throw new Error('x'); } };
    assert.strictEqual(s.S.core.zone.homeId(), 22);
});

t.test('homeId is null when neither source is readable', function () {
    var s = setup();
    s.game.player = {};
    s.game.gi.mCurrentPlayer = { GetHomeZoneId: function () { return 'x'; } };
    assert.strictEqual(s.S.core.zone.homeId(), null);
    s.game.gi.mCurrentPlayer = null;
    assert.strictEqual(s.S.core.zone.homeId(), null);
});
