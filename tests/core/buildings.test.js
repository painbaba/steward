'use strict';

var t = require('../runner');
var harness = require('../harness');

t.test('byName finds buildings via host getBuildingsByName_vector fast-path', function () {
    // Scenario: the host returns masons via getBuildingsByName_vector but
    // does NOT include them in mStreetDataMap.GetBuildings_vector(). This
    // mirrors the live AIR client where some building categories (masons)
    // are queryable by name yet absent from the all-buildings vector.
    var H = harness.boot();
    var mason = H.zone.building({ name: 'Mason', grid: 99 });

    var customZone = {
        mStreetDataMap: {
            mDepositContainer:  [],
            mBuildingContainer: [],                              // empty — snapshot would return 0
            GetBuildings_vector: function () { return []; },     // empty
            getDeposits_vectorByType: function () { return []; },
            getBuildingsByName_vector: function (n) {
                return n === 'Mason' ? [mason] : [];             // host knows Mason
            }
        },
        GetBuildingFromGridPosition: function () { return null; },
        GetResources: function () { return { CanPlayerAffordBuilding: function () { return true; } }; }
    };
    H.host.game.gi.mCurrentPlayer = { mBuildQueue: { GetTotalAvailableSlots: function () { return 0; }, GetQueue_vector: function () { return { length: 0 }; } } };
    H.host.game.gi.mCurrentPlayerZone = customZone;

    var found = H.Steward.core.buildings.byName('Mason');
    t.assert.strictEqual(found.length, 1);
    t.assert.strictEqual(found[0].GetBuildingName_string(), 'Mason');
});

t.test('byName falls back to snapshot when host API absent', function () {
    var H = harness.boot();
    var mine = H.zone.building({ name: 'IronMine', grid: 12 });
    var z = H.zone.zone()
        .building(mine)
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;

    var found = H.Steward.core.buildings.byName('IronMine');
    t.assert.strictEqual(found.length, 1);
});

// Production buff reads. The host clock is a mutable value so a test can move
// time without rebooting.
function bootClock(startAt) {
    var clock = { now: startAt };
    var H = harness.boot({
        host: {
            swmmo: { application: { mGameInterface: { GetClientTime: function () { return clock.now; } } } }
        }
    });
    H.clock = clock;
    return H;
}

var HOUR = 3600000;

t.test('outputFactor and baseOutputFactor return host values', function () {
    var H = harness.boot();
    var B = H.Steward.core.buildings;
    var b = H.zone.building({ name: 'pumpkinfield_01', outputFactor: 10, exactOutputFactor: 1.9 });
    t.assert.strictEqual(B.outputFactor(b), 10);
    t.assert.strictEqual(B.baseOutputFactor(b), 1);   // truncated like the host
});

t.test('outputFactor and baseOutputFactor are null when missing or throwing', function () {
    var H = harness.boot();
    var B = H.Steward.core.buildings;
    var plain = H.zone.building({ name: 'pumpkinfield_01' });
    t.assert.strictEqual(B.outputFactor(plain), null);
    t.assert.strictEqual(B.baseOutputFactor(plain), null);
    t.assert.strictEqual(B.outputFactor(null), null);
    t.assert.strictEqual(B.baseOutputFactor(null), null);

    var bad = {
        GetResourceOutputFactor: function () { throw new Error('boom'); },
        GetExactOutputFactor:    function () { throw new Error('boom'); }
    };
    t.assert.strictEqual(B.outputFactor(bad), null);
    t.assert.strictEqual(B.baseOutputFactor(bad), null);

    var zero = H.zone.building({ outputFactor: 0, exactOutputFactor: 0 });
    t.assert.strictEqual(B.outputFactor(zero), null);
    t.assert.strictEqual(B.baseOutputFactor(zero), null);
});

t.test('buffRemainingMs is duration minus elapsed time', function () {
    var H = bootClock(100 * HOUR);
    var b = H.zone.building({
        buffs: [H.zone.buff({ pct: 1000, duration: 32400000, start: 100 * HOUR - HOUR })]
    });
    t.assert.strictEqual(H.Steward.core.buildings.buffRemainingMs(b), 28800000);
});

t.test('buffRemainingMs takes the shortest output buff and ignores pct 100', function () {
    var H = bootClock(100 * HOUR);
    var b = H.zone.building({
        buffs: [
            H.zone.buff({ pct: 1000, duration: 10 * HOUR, start: 100 * HOUR }),
            H.zone.buff({ pct: 500,  duration: 4 * HOUR,  start: 100 * HOUR }),
            H.zone.buff({ pct: 100,  duration: 1 * HOUR,  start: 100 * HOUR })
        ]
    });
    t.assert.strictEqual(H.Steward.core.buildings.buffRemainingMs(b), 4 * HOUR);
});

t.test('buffRemainingMs is null for an expired buff', function () {
    var H = bootClock(100 * HOUR);
    var b = H.zone.building({
        buffs: [H.zone.buff({ pct: 1000, duration: HOUR, start: 98 * HOUR })]
    });
    t.assert.strictEqual(H.Steward.core.buildings.buffRemainingMs(b), null);
});

t.test('buffRemainingMs falls back to productionBuff', function () {
    var H = bootClock(100 * HOUR);
    var b = H.zone.building({
        buffs: [],
        productionBuff: H.zone.buff({ pct: 1000, duration: 5 * HOUR, start: 99 * HOUR })
    });
    t.assert.strictEqual(H.Steward.core.buildings.buffRemainingMs(b), 4 * HOUR);
});

t.test('buffRemainingMs is null without a host clock or a buff', function () {
    var H = harness.boot();   // no swmmo
    var b = H.zone.building({
        buffs: [H.zone.buff({ pct: 1000, duration: HOUR, start: 0 })]
    });
    t.assert.strictEqual(H.Steward.core.buildings.buffRemainingMs(b), null);

    var C = bootClock(100 * HOUR);
    t.assert.strictEqual(C.Steward.core.buildings.buffRemainingMs(C.zone.building({})), null);
    t.assert.strictEqual(C.Steward.core.buildings.buffRemainingMs(null), null);
});

t.test('amountPerCycle reads amountRemoved from the economy definition', function () {
    var H = harness.boot();
    var B = H.Steward.core.buildings;
    H.host.game.def = function () {
        return {
            GetResourcesCreationDefinitionForBuilding: function (n) {
                if (n === 'a') return { amountRemoved: 2 };
                if (n === 'b') return { workTime: 100 };
                return null;
            }
        };
    };
    t.assert.strictEqual(B.amountPerCycle('a'), 2);
    t.assert.strictEqual(B.amountPerCycle('b'), null);
    t.assert.strictEqual(B.amountPerCycle('c'), null);
});

// ---- readable ----------------------------------------------------------------

t.test('readable is false with no street map and on an empty vector', function () {
    var H = harness.boot();
    var B = H.Steward.core.buildings;
    H.host.game.gi.mCurrentPlayerZone = {};
    B.invalidate();
    t.assert.strictEqual(B.readable(), false);
    H.host.game.gi.mCurrentPlayerZone = H.zone.zone().zone;
    B.invalidate();
    t.assert.strictEqual(B.readable(), false);
});

t.test('readable is true once the zone lists a building', function () {
    var H = harness.boot();
    var B = H.Steward.core.buildings;
    H.host.game.gi.mCurrentPlayerZone = H.zone.zone()
        .building(H.zone.building({ name: 'IronMine', grid: 12 })).zone;
    B.invalidate();
    t.assert.strictEqual(B.readable(), true);
});
