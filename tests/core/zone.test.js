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

// ---- landingGrids -------------------------------------------------------------

function field(grid) { return { GetGrid: function () { return grid; } }; }

t.test('landingGrids returns the positive grids of the landing fields, deduped, in vector order', function () {
    var s = setup();
    s.game.zone.mStreetDataMap = { mLandingFields_vector: [field(12), field(34), field(12), field(0)] };
    assert.deepStrictEqual(JSON.parse(JSON.stringify(s.S.core.zone.landingGrids())), [12, 34]);
});

t.test('landingGrids is empty when the street data has no landing vector', function () {
    var s = setup();
    s.game.zone.mStreetDataMap = {};
    assert.deepStrictEqual(JSON.parse(JSON.stringify(s.S.core.zone.landingGrids())), []);
    delete s.game.zone.mStreetDataMap;
    assert.deepStrictEqual(JSON.parse(JSON.stringify(s.S.core.zone.landingGrids())), []);
});

t.test('landingGrids warns once in zone and returns [] when an entry throws', function () {
    var s = setup();
    s.game.zone.mStreetDataMap = { mLandingFields_vector: [field(12),
        { GetGrid: function () { throw new Error('boom'); } }] };
    assert.deepStrictEqual(JSON.parse(JSON.stringify(s.S.core.zone.landingGrids())), []);
    var warns = s.H.logs().filter(function (l) { return l.category === 'zone' && l.level === 'warn'; });
    assert.strictEqual(warns.length, 1);
});
