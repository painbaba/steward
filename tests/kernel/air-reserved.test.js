'use strict';

// The build's terser pass rewrites x['word'] into x.word, and a reserved word
// as a dot-property makes AIR 32 (ES3 grammar) drop the whole script
// silently. Lint already bans the dot form in source; this bans the bracket
// form, the only way the minified bundle can gain a reserved dot-property.
// The word list is read from the lint config so there is one copy of it.

var fs = require('fs');
var path = require('path');
var t = require('../runner');
var loadOrder = require('../load-order');

var REPO_ROOT = path.resolve(__dirname, '..', '..');

function reservedWords() {
    var config = require('../../.eslintrc.json');
    var rule = config.rules && config.rules['no-restricted-syntax'];
    if (!rule) throw new Error('.eslintrc.json has no no-restricted-syntax rule');
    for (var i = 0; i < rule.length; i++) {
        var entry = rule[i];
        if (entry && typeof entry === 'object' &&
            typeof entry.selector === 'string' &&
            entry.selector.indexOf('MemberExpression[computed=false]') === 0) {
            var m = /property\.name=\/\^\(([^)]+)\)\$\//.exec(entry.selector);
            if (!m) throw new Error('reserved-word alternation not found in the MemberExpression selector');
            return m[1].split('|');
        }
    }
    throw new Error('MemberExpression[computed=false] entry not found in no-restricted-syntax');
}

function subscriptPattern() {
    return new RegExp('\\[\\s*([\'"])(' + reservedWords().join('|') + ')\\1\\s*\\]');
}

t.test('reserved word list is read from the lint config', function () {
    var words = reservedWords();
    t.assert.ok(words.indexOf('short') !== -1);
    t.assert.ok(words.indexOf('default') !== -1);
    t.assert.ok(words.indexOf('class') !== -1);
});

t.test('no bundled source reads or writes a reserved word through a string subscript', function () {
    var re = subscriptPattern();
    var files = loadOrder.collect(['kernel', 'core', 'modules', 'vendor'], REPO_ROOT);
    var hits = [];
    for (var i = 0; i < files.length; i++) {
        var lines = fs.readFileSync(path.join(REPO_ROOT, files[i]), 'utf8').split(/\r?\n/);
        for (var j = 0; j < lines.length; j++) {
            if (re.test(lines[j])) hits.push(files[i] + ':' + (j + 1) + ': ' + lines[j].trim());
        }
    }
    t.assert.strictEqual(hits.length, 0, 'reserved-word subscripts:\n' + hits.join('\n'));
});

t.test('the subscript pattern catches the forms the build unquotes', function () {
    var re = subscriptPattern();
    t.assert.ok(re.test("a['short']"));
    t.assert.ok(re.test('a[ "default" ]'));
    t.assert.ok(!re.test("a['shortBefore']"));
    t.assert.ok(!re.test("{ 'default': 1 }"));
    t.assert.ok(!re.test('a[k]'));
});
