'use strict';

var path = require('path');
var t = require('../runner');
var harness = require('../harness');
var version = require('../../scripts/version');

var REPO_ROOT = path.resolve(__dirname, '..', '..');

// Runs fn with STEWARD_VERSION set (or removed when value is undefined) and
// always restores the previous value, so tests do not leak into each other.
function withEnv(value, fn) {
    var prev = process.env.STEWARD_VERSION;
    if (value === undefined) delete process.env.STEWARD_VERSION;
    else process.env.STEWARD_VERSION = value;
    try {
        return fn();
    } finally {
        if (prev === undefined) delete process.env.STEWARD_VERSION;
        else process.env.STEWARD_VERSION = prev;
    }
}

t.test('inject replaces the token literal with a quoted version', function () {
    var out = version.inject("a='__STEWARD_VERSION__';b='__STEWARD_VERSION__'", '0.4.3');
    t.assert.strictEqual(out, 'a="0.4.3";b="0.4.3"');
    t.assert.strictEqual(version.inject('var x = 1;', '0.4.3'), 'var x = 1;');
});

t.test('inject quotes a version containing a quote safely', function () {
    var out = version.inject("var v = '__STEWARD_VERSION__'; v;", "1'2");
    var result = new Function(out + '; return v;')();
    t.assert.strictEqual(result, "1'2");
});

t.test('read prefers STEWARD_VERSION env', function () {
    withEnv('9.9.9', function () {
        t.assert.strictEqual(version.read(REPO_ROOT), '9.9.9');
    });
});

t.test('read falls back to package.json', function () {
    withEnv(undefined, function () {
        t.assert.strictEqual(version.read(REPO_ROOT), require('../../package.json').version);
    });
});

t.test('harness-loaded kernel carries the build version', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var v = H.Steward.kernel.VERSION;
    t.assert.strictEqual(v, version.read(REPO_ROOT));
    t.assert.notStrictEqual(v, '__STEWARD_VERSION__');
});

t.test('reload overwrites the version slot', function () {
    var H = harness.boot({ sections: ['kernel'] });
    H.Steward.kernel.VERSION = 'stale';
    var H2 = harness.reload(H);
    t.assert.strictEqual(H2.Steward.kernel.VERSION, version.read(REPO_ROOT));
});
