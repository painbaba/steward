'use strict';

var t = require('../runner');
var harness = require('../harness');

// The harness runs the bundle in its own vm realm; copy its arrays into
// this realm so deepStrictEqual compares values, not prototypes.
function plain(arr) { return JSON.parse(JSON.stringify(arr)); }

function ui() {
    return harness.boot({ sections: ['kernel'] }).Steward.kernel.ui;
}

t.test('scopeCss prefixes a rule with one id', function () {
    var css = ui().scopeCss(['.a{color:red;}'], ['X']);
    t.assert.strictEqual(css, '#X .a{color:red;}');
});

t.test('scopeCss emits every id for every selector', function () {
    var css = ui().scopeCss(['.a, .b{color:red;}', '.c{x:1;}'], ['X', 'Y']);
    t.assert.strictEqual(css,
        '#X .a,#X .b,#Y .a,#Y .b{color:red;}' +
        '#X .c,#Y .c{x:1;}');
});

t.test('scopeCss leaves commas inside the body intact', function () {
    var body = '{background:linear-gradient(180deg,#a 0%,#b 100%);}';
    var css = ui().scopeCss(['.btn' + body], ['X', 'Y']);
    t.assert.strictEqual(css, '#X .btn,#Y .btn' + body);
});

t.test('mergeScopes with no attribute starts with the dashboard', function () {
    var u = ui();
    t.assert.deepStrictEqual(plain(u.mergeScopes(null, 'StewardDashboard')), ['StewardDashboard']);
    t.assert.deepStrictEqual(plain(u.mergeScopes(null, 'StewardAdventures')),
        ['StewardDashboard', 'StewardAdventures']);
});

t.test('mergeScopes does not duplicate a recorded id', function () {
    var out = plain(ui().mergeScopes('StewardDashboard,StewardAdventures', 'StewardAdventures'));
    t.assert.deepStrictEqual(out, ['StewardDashboard', 'StewardAdventures']);
});

t.test('mergeScopes puts the dashboard first when the attribute lacks it', function () {
    var out = plain(ui().mergeScopes('StewardAdventures', 'StewardDashboard'));
    t.assert.deepStrictEqual(out, ['StewardDashboard', 'StewardAdventures']);
});

t.test('mergeScopes appends a new id after the recorded ones', function () {
    var out = plain(ui().mergeScopes('StewardDashboard,,StewardA', 'StewardB'));
    t.assert.deepStrictEqual(out, ['StewardDashboard', 'StewardA', 'StewardB']);
});

t.test('helpers.escape replaces the five HTML characters', function () {
    var esc = ui().helpers.escape;
    t.assert.strictEqual(esc('<a href="x">Tom & Jerry\'s</a>'),
        '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;');
    t.assert.strictEqual(esc(null), '');
    t.assert.strictEqual(esc(undefined), '');
    t.assert.strictEqual(esc(5), '5');
});
