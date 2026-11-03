'use strict';

var fs = require('fs');
var path = require('path');

var t = require('../runner');
var harness = require('../harness');

var FILE = path.resolve(__dirname, '..', '..', 'src', 'kernel', '16_text.js');

function plain(s) {
    var H = harness.boot({ sections: ['kernel'] });
    return H.Steward.kernel.text.plain(s);
}

t.test('text.plain strips the host name markup', function () {
    var raw = "<b>Ghost #2</b> <font size='-3'>(Ghost General)</font>";
    t.assert.strictEqual(plain(raw), 'Ghost #2 (Ghost General)');
    t.assert.strictEqual(plain(' ' + raw), 'Ghost #2 (Ghost General)');
    t.assert.strictEqual(plain('<b>The Smuggler</b>'), 'The Smuggler');
});

t.test('text.plain leaves plain names and collapses whitespace', function () {
    t.assert.strictEqual(plain('Hans'), 'Hans');
    t.assert.strictEqual(plain('A  B'), 'A B');
});

t.test('text.plain decodes entities once', function () {
    t.assert.strictEqual(plain('A &amp; B'), 'A & B');
    t.assert.strictEqual(plain('Camp &lt;1&gt;'), 'Camp <1>');
    t.assert.strictEqual(plain('&amp;lt;'), '&lt;');
    t.assert.strictEqual(plain('&quot; &#39; &apos; &#x27;'), '" \' \' \'');
});

t.test('text.plain turns non-breaking spaces into plain spaces', function () {
    t.assert.strictEqual(plain('A&nbsp;B'), 'A B');
    t.assert.strictEqual(plain('A&#160;B'), 'A B');
    t.assert.strictEqual(plain('A\u00A0B'), 'A B');
});

t.test('text.plain keeps what is not markup or a known entity', function () {
    t.assert.strictEqual(plain('&unknown;'), '&unknown;');
    t.assert.strictEqual(plain('&#0;'), '&#0;');
    t.assert.strictEqual(plain('a<>b'), 'a<>b');
});

t.test('text.plain gives an empty string for tag-only and non-string input', function () {
    t.assert.strictEqual(plain('<b></b>'), '');
    t.assert.strictEqual(plain(null), '');
    t.assert.strictEqual(plain(undefined), '');
    t.assert.strictEqual(plain(5), '');
});

t.test('16_text.js holds no literal non-breaking space character', function () {
    var src = fs.readFileSync(FILE, 'utf8');
    t.assert.strictEqual(src.indexOf(String.fromCharCode(0xA0)), -1);
});
