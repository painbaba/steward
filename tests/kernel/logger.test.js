'use strict';

var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');
var hostStubs = require('../stubs/host');

var assert = t.assert;

var DIR = 'C:/client/steward/logs';
var LOG = DIR + '/console.log';
var KB = 1024;

// Fixed local days far from the real one, so a stray real date can neither
// pass nor fail a test by accident. The logger keys days in local time.
function at(day, hour, minute, second) {
    return new Date(2030, 0, day, hour || 0, minute || 0, second || 0).getTime();
}

var D1_NOON  = at(15, 12);
var D1_EVE   = at(15, 18);
var D2_NOON  = at(16, 12);
var D2_START = at(16, 0, 0, 10);       // just after midnight

function rep(ch, n) { return new Array(n + 1).join(ch); }

function count(text, part) {
    return text.split(part).length - 1;
}

// A partial logger setup on the fake disk and a settable clock. setNow moves
// the logger's Date and the fake disk's modification dates together, so the
// two always agree on the day.
function setup(opts) {
    opts = opts || {};
    var fs = airfs.make();
    fs.dirs['C:/client/steward'] = true;
    fs.dirs[DIR] = true;
    var hs = hostStubs.makeSettingsHost();
    var H = harness.boot({ sections: ['kernel'], host: { air: fs.air, settings: hs } });

    var RealDate = Date;
    var clock = { nowMs: opts.now || D1_NOON };
    function FakeDate() {
        if (arguments.length === 0) return new RealDate(clock.nowMs);
        return new (Function.prototype.bind.apply(RealDate, [null].concat(Array.prototype.slice.call(arguments))))();
    }
    FakeDate.now = function () { return clock.nowMs; };
    H.ctx.Date = FakeDate;
    fs.now = clock.nowMs;

    var K = H.Steward.kernel;
    var s = { fs: fs, hs: hs, H: H, K: K, clock: clock };

    s.setNow = function (ms) {
        clock.nowMs = ms;
        fs.now = ms;
    };
    s.configure = function (cfg) { K.log.configure(cfg); };
    s.line = function (text) { K.log.raw('t', text); };
    s.path = function (name) { return DIR + '/' + name; };
    s.read = function (name) { return fs.disk[DIR + '/' + name]; };
    s.has = function (name) { return Object.prototype.hasOwnProperty.call(fs.disk, DIR + '/' + name); };
    s.put = function (name, content, ms) {
        fs.disk[DIR + '/' + name] = content;
        fs.mtime[DIR + '/' + name] = new RealDate(ms === undefined ? clock.nowMs : ms);
    };
    // Names of the rotated and aside files that exist.
    s.chain = function () {
        return Object.keys(fs.disk).filter(function (p) {
            return /\/console\.log\.(\d+|rotating)$/.test(p);
        }).map(function (p) { return p.substr(DIR.length + 1); }).sort();
    };
    s.retryMs = K.TIMEOUTS.LOG_ROTATE_RETRY_MS;
    return s;
}

// ---- Size trigger -----------------------------------------------------------

t.test('size trigger rotates an oversized file on the next line', function () {
    var s = setup();
    s.configure({ maxFileSizeKB: 1, rotateDaily: false, keepRotated: 3 });
    s.put('console.log', rep('x', 2 * KB));
    s.line('LINEA');
    assert.strictEqual(s.read('console.log.1'), rep('x', 2 * KB));
    assert.ok(s.read('console.log').indexOf('LINEA') >= 0);
    assert.strictEqual(s.read('console.log').indexOf('xxxx'), -1);
    assert.deepStrictEqual(s.chain(), ['console.log.1']);
});

t.test('a file under the size limit is not rotated', function () {
    var s = setup();
    s.configure({ maxFileSizeKB: 1, rotateDaily: false, keepRotated: 3 });
    s.put('console.log', rep('x', 500));
    s.line('LINEA');
    assert.deepStrictEqual(s.chain(), []);
    assert.ok(s.read('console.log').indexOf(rep('x', 500)) === 0);
    assert.ok(s.read('console.log').indexOf('LINEA') > 0);
});

t.test('the byte counter rotates a file that grows past the limit in this session', function () {
    var s = setup();
    s.configure({ maxFileSizeKB: 1, rotateDaily: false, keepRotated: 3 });
    for (var i = 0; i < 30; i++) s.line('L' + (i < 10 ? '0' + i : i) + rep('y', 80));
    assert.ok(s.has('console.log.1'));
    var joined = s.read('console.log');
    s.chain().forEach(function (name) { joined += s.read(name); });
    for (var j = 0; j < 30; j++) {
        assert.strictEqual(count(joined, 'L' + (j < 10 ? '0' + j : j) + 'yyyy'), 1);
    }
    assert.ok(s.read('console.log').length < KB + 200);
});

// ---- Day trigger ------------------------------------------------------------

t.test('a stale modification date rotates on the first line', function () {
    var s = setup({ now: D2_NOON });
    s.configure({ maxFileSizeKB: 0, rotateDaily: true, keepRotated: 3 });
    s.put('console.log', 'OLD\n', D1_NOON);
    s.line('LINEA');
    assert.strictEqual(s.read('console.log.1'), 'OLD\n');
    assert.ok(s.read('console.log').indexOf('LINEA') >= 0);
    assert.strictEqual(s.read('console.log').indexOf('OLD'), -1);
});

t.test('a file written today is not rotated at startup', function () {
    var s = setup({ now: D1_EVE });
    s.configure({ maxFileSizeKB: 0, rotateDaily: true, keepRotated: 3 });
    s.put('console.log', 'EARLIER\n', D1_NOON);
    s.line('LINEA');
    assert.deepStrictEqual(s.chain(), []);
    assert.ok(s.read('console.log').indexOf('EARLIER') === 0);
});

t.test('a session running through midnight rotates on the first line after it', function () {
    var s = setup();
    s.configure({ maxFileSizeKB: 0, rotateDaily: true, keepRotated: 3 });
    s.line('LINEA');
    s.setNow(D2_START);
    s.line('LINEB');
    assert.ok(s.read('console.log.1').indexOf('LINEA') >= 0);
    assert.strictEqual(s.read('console.log.1').indexOf('LINEB'), -1);
    assert.ok(s.read('console.log').indexOf('LINEB') >= 0);
    assert.strictEqual(s.read('console.log').indexOf('LINEA'), -1);
});

t.test('enabling daily later does not rotate a file written today', function () {
    var s = setup();
    s.configure({ maxFileSizeKB: 0, rotateDaily: false, keepRotated: 3 });
    // Dated before today: with daily off nothing rotates, and the line that
    // follows makes the file's last write today.
    s.put('console.log', 'OLD\n', at(10, 12));
    s.line('LINEA');
    s.configure({ rotateDaily: true });
    s.line('LINEB');
    assert.deepStrictEqual(s.chain(), []);
    assert.ok(s.read('console.log').indexOf('OLD') === 0);
    assert.ok(s.read('console.log').indexOf('LINEB') > 0);
});

t.test('with both triggers off nothing rotates', function () {
    var s = setup({ now: D2_NOON });
    s.configure({ maxFileSizeKB: 0, rotateDaily: false, keepRotated: 3 });
    s.put('console.log', rep('x', 20 * KB), D1_NOON);
    var base = s.fs.stats.moves;
    s.line('LINEA');
    s.line('LINEB');
    assert.strictEqual(s.fs.stats.moves, base);
    assert.deepStrictEqual(s.chain(), []);
});

t.test('an empty stale file is not rotated', function () {
    var s = setup({ now: D2_NOON });
    s.configure({ maxFileSizeKB: 0, rotateDaily: true, keepRotated: 3 });
    s.put('console.log', '', D1_NOON);
    var base = s.fs.stats.moves;
    s.line('LINEA');
    assert.strictEqual(s.fs.stats.moves, base);
    assert.deepStrictEqual(s.chain(), []);
    assert.ok(s.read('console.log').indexOf('LINEA') >= 0);
});

// ---- The chain --------------------------------------------------------------

t.test('chain order is kept and the oldest is deleted', function () {
    var s = setup();
    s.configure({ maxFileSizeKB: 1, rotateDaily: false, keepRotated: 3 });
    s.put('console.log.1', 'one');
    s.put('console.log.2', 'two');
    s.put('console.log.3', 'three');
    s.put('console.log', rep('x', 2 * KB));
    s.line('LINEA');
    assert.strictEqual(s.read('console.log.1'), rep('x', 2 * KB));
    assert.strictEqual(s.read('console.log.2'), 'one');
    assert.strictEqual(s.read('console.log.3'), 'two');
    assert.deepStrictEqual(s.chain(), ['console.log.1', 'console.log.2', 'console.log.3']);
    Object.keys(s.fs.disk).forEach(function (p) {
        assert.strictEqual(s.fs.disk[p].indexOf('three'), -1, p);
    });
});

t.test('lowering keepRotated removes the excess at configure and leaves unrelated names', function () {
    var s = setup();
    for (var n = 1; n <= 5; n++) s.put('console.log.' + n, 'old ' + n);
    s.put('console.log.bak', 'bak');
    s.put('console.log.1.5', 'dotted');
    s.put('console.log.rotating', 'aside');
    s.put('other.txt', 'other');
    s.configure({ keepRotated: 2 });
    assert.ok(s.has('console.log.1'));
    assert.ok(s.has('console.log.2'));
    assert.ok(!s.has('console.log.3'));
    assert.ok(!s.has('console.log.4'));
    assert.ok(!s.has('console.log.5'));
    assert.ok(s.has('console.log.bak'));
    assert.ok(s.has('console.log.1.5'));
    assert.ok(s.has('console.log.rotating'));
    assert.ok(s.has('other.txt'));
});

t.test('keepRotated 0 leaves no rotated file and no aside file', function () {
    var s = setup();
    s.configure({ maxFileSizeKB: 1, rotateDaily: false, keepRotated: 0 });
    s.put('console.log.1', 'one');
    s.put('console.log.2', 'two');
    s.put('console.log', rep('x', 2 * KB));
    s.line('LINEA');
    assert.deepStrictEqual(s.chain(), []);
    assert.ok(s.read('console.log').indexOf('LINEA') >= 0);
    assert.strictEqual(s.read('console.log').indexOf('xxxx'), -1);
});

// ---- Failures ---------------------------------------------------------------

t.test('a failed move of the current file keeps history and the line, and backs off', function () {
    var s = setup();
    s.configure({ maxFileSizeKB: 1, rotateDaily: false, keepRotated: 3 });
    s.put('console.log.1', 'a1');
    s.put('console.log.2', 'a2');
    s.put('console.log.3', 'a3');
    s.put('console.log', rep('x', 2 * KB));
    s.fs.fail.move[s.path('console.log')] = true;
    var base = s.fs.stats.moves;

    s.line('LINEONE');
    s.line('LINETWO');
    s.line('LINETHREE');

    assert.strictEqual(s.read('console.log.1'), 'a1');
    assert.strictEqual(s.read('console.log.2'), 'a2');
    assert.strictEqual(s.read('console.log.3'), 'a3');
    var cur = s.read('console.log');
    assert.ok(cur.indexOf(rep('x', 2 * KB)) === 0);
    assert.ok(cur.indexOf('LINEONE') > 0 && cur.indexOf('LINETWO') > 0 && cur.indexOf('LINETHREE') > 0);
    assert.strictEqual(s.fs.stats.moves - base, 1);
    assert.strictEqual(count(cur, 'rotation failed'), 1);
    assert.ok(/\[WARN\][^\n]*rotation failed/.test(cur));

    s.fs.fail.move = {};
    s.setNow(D1_NOON + s.retryMs + 1000);
    s.line('LINEFOUR');
    var old = s.read('console.log.1');
    assert.ok(old.indexOf(rep('x', 2 * KB)) === 0);
    assert.ok(old.indexOf('LINETHREE') > 0);
    assert.strictEqual(s.read('console.log.2'), 'a1');
    assert.strictEqual(s.read('console.log.3'), 'a2');
    assert.ok(s.read('console.log').indexOf('LINEFOUR') >= 0);
    assert.strictEqual(s.read('console.log').indexOf('LINETHREE'), -1);
});

t.test('a failed day rotation retries after the back-off', function () {
    var s = setup({ now: D2_START });
    s.configure({ maxFileSizeKB: 0, rotateDaily: true, keepRotated: 3 });
    s.put('console.log', 'OLD\n', D1_NOON);
    s.fs.fail.move[s.path('console.log')] = true;

    s.line('LINEA');
    s.line('LINEB');
    assert.ok(!s.has('console.log.1'));
    assert.ok(s.read('console.log').indexOf('OLD') === 0);

    s.fs.fail.move = {};
    s.setNow(D2_START + s.retryMs + 1000);
    s.line('LINEC');
    var old = s.read('console.log.1');
    assert.ok(old.indexOf('OLD') === 0);
    assert.ok(old.indexOf('LINEA') > 0 && old.indexOf('LINEB') > 0);
    assert.strictEqual(old.indexOf('LINEC'), -1);
    var cur = s.read('console.log');
    assert.ok(cur.indexOf('LINEC') >= 0);
    assert.strictEqual(cur.indexOf('OLD'), -1);
    assert.strictEqual(cur.indexOf('LINEA'), -1);
    assert.strictEqual(cur.indexOf('LINEB'), -1);
});

t.test('a failure inside the chain loses no file and the next rotation finishes it', function () {
    var s = setup();
    s.configure({ maxFileSizeKB: 1, rotateDaily: false, keepRotated: 3 });
    var big = rep('x', 2 * KB);
    s.put('console.log.1', 'a1');
    s.put('console.log.2', 'a2');
    s.put('console.log', big);
    s.fs.fail.move[s.path('console.log.2')] = true;

    s.line('LINEFIRST');
    // The current file is safe under its aside name, the line went to a new file.
    assert.strictEqual(s.read('console.log.rotating'), big);
    assert.strictEqual(s.read('console.log.1'), 'a1');
    assert.strictEqual(s.read('console.log.2'), 'a2');
    assert.ok(s.read('console.log').indexOf('LINEFIRST') >= 0);

    // Past the cap again, so the next rotation is due.
    s.line(rep('z', 2 * KB));
    s.fs.fail.move = {};
    s.setNow(D1_NOON + s.retryMs + 1000);
    s.line('LINEX');
    // The leftover went through the chain; the grown current file waits.
    assert.ok(!s.has('console.log.rotating'));
    assert.strictEqual(s.read('console.log.1'), big);
    assert.strictEqual(s.read('console.log.2'), 'a1');
    assert.strictEqual(s.read('console.log.3'), 'a2');
    assert.ok(s.read('console.log').indexOf('LINEX') >= 0);

    s.line('LINEY');
    assert.ok(!s.has('console.log.rotating'));
    assert.ok(s.read('console.log.1').indexOf('LINEX') >= 0);
    assert.strictEqual(s.read('console.log.2'), big);
    assert.strictEqual(s.read('console.log.3'), 'a1');
    var cur = s.read('console.log');
    assert.ok(cur.indexOf('LINEY') >= 0);
    assert.strictEqual(cur.indexOf('LINEX'), -1);
});

t.test('a leftover aside file goes through the chain and the current file rotates after it', function () {
    var s = setup();
    s.configure({ maxFileSizeKB: 1, rotateDaily: false, keepRotated: 3 });
    var big = rep('x', 2 * KB);
    s.put('console.log.rotating', 'ASIDE');
    s.put('console.log.1', 'a1');
    s.put('console.log', big);

    s.line('LINEA');
    assert.ok(!s.has('console.log.rotating'));
    assert.strictEqual(s.read('console.log.1'), 'ASIDE');
    assert.strictEqual(s.read('console.log.2'), 'a1');
    assert.ok(s.read('console.log').indexOf(big) === 0);
    assert.ok(s.read('console.log').indexOf('LINEA') > 0);

    s.line('LINEB');
    var rotated = s.read('console.log.1');
    assert.ok(rotated.indexOf(big) === 0 && rotated.indexOf('LINEA') > 0);
    assert.strictEqual(s.read('console.log.2'), 'ASIDE');
    assert.strictEqual(s.read('console.log.3'), 'a1');
    assert.ok(s.read('console.log').indexOf('LINEB') >= 0);
    assert.strictEqual(s.read('console.log').indexOf('LINEA'), -1);
});

t.test('a leftover aside with a day-due current file rotates the current file on the next line', function () {
    var s = setup({ now: D2_NOON });
    s.configure({ maxFileSizeKB: 0, rotateDaily: true, keepRotated: 3 });
    s.put('console.log.rotating', 'ASIDE', D1_NOON);
    s.put('console.log', 'OLD\n', D1_NOON);

    s.line('LINEA');
    assert.ok(!s.has('console.log.rotating'));
    assert.strictEqual(s.read('console.log.1'), 'ASIDE');
    assert.ok(s.read('console.log').indexOf('OLD') === 0);
    assert.ok(s.read('console.log').indexOf('LINEA') > 0);

    s.line('LINEB');
    var rotated = s.read('console.log.1');
    assert.ok(rotated.indexOf('OLD') === 0 && rotated.indexOf('LINEA') > 0);
    assert.strictEqual(s.read('console.log.2'), 'ASIDE');
    var cur = s.read('console.log');
    assert.ok(cur.indexOf('LINEB') >= 0);
    assert.strictEqual(cur.indexOf('OLD'), -1);
    assert.strictEqual(cur.indexOf('LINEA'), -1);
});

// ---- Disk confirm -----------------------------------------------------------

t.test('an outside truncation resyncs instead of rotating', function () {
    var s = setup();
    s.configure({ maxFileSizeKB: 1, rotateDaily: false, keepRotated: 3 });
    s.put('console.log', rep('x', 1000));
    s.line('LINEA');                       // the counter now stands at the limit
    s.fs.disk[s.path('console.log')] = 'tiny\n';
    var base = s.fs.stats.moves;
    s.line('LINEB');
    assert.strictEqual(s.fs.stats.moves, base);
    assert.deepStrictEqual(s.chain(), []);
    assert.ok(s.read('console.log').indexOf('tiny') === 0);
    assert.ok(s.read('console.log').indexOf('LINEB') > 0);
    s.line('LINEC');
    assert.deepStrictEqual(s.chain(), []);
});

t.test("another profile's day rotation is not repeated", function () {
    var s = setup();
    s.configure({ maxFileSizeKB: 0, rotateDaily: true, keepRotated: 3 });
    s.line('LINEA');
    s.setNow(D2_NOON);
    // The other profile rotated and started a small file today.
    s.put('console.log', 'OTHER\n', D2_NOON);
    var base = s.fs.stats.moves;
    s.line('LINEB');
    assert.strictEqual(s.fs.stats.moves, base);
    assert.deepStrictEqual(s.chain(), []);
    assert.ok(s.read('console.log').indexOf('OTHER') === 0);
});

t.test('a pending rotation that no longer applies is dropped', function () {
    var s = setup();
    s.configure({ maxFileSizeKB: 1, rotateDaily: true, keepRotated: 3 });
    s.put('console.log', rep('x', 2 * KB));
    s.fs.fail.move[s.path('console.log')] = true;
    s.line('LINEA');                       // the size rotation fails and stays pending

    s.fs.fail.move = {};
    s.fs.disk[s.path('console.log')] = 'small\n';
    s.fs.mtime[s.path('console.log')] = new Date(D1_NOON);
    s.setNow(D1_NOON + s.retryMs + 1000);
    var base = s.fs.stats.moves;
    s.line('LINEB');
    assert.strictEqual(s.fs.stats.moves, base);
    assert.deepStrictEqual(s.chain(), []);

    // At the next midnight the file's own date decides again: a file dated
    // the new day belongs to someone else's rotation and is left alone.
    s.setNow(D2_START);
    s.fs.mtime[s.path('console.log')] = new Date(D2_START);
    s.line('LINEC');
    assert.strictEqual(s.fs.stats.moves, base);
    assert.deepStrictEqual(s.chain(), []);
});

// ---- files.info contract ----------------------------------------------------

t.test('a failing stat backs off and does not rotate', function () {
    var s = setup();
    var K = s.K;
    var realInfo = K.files.info;
    s.configure({ maxFileSizeKB: 1, rotateDaily: false, keepRotated: 3 });
    s.put('console.log', 'small\n');
    s.line('LINEA');

    // files.info logs through the kernel itself, which re-enters the logger
    // while a rotation is being decided.
    K.files.info = function () {
        K.warn.raw('files', 'stat failed');
        return null;
    };
    s.line(rep('x', 2 * KB));
    s.line('LINEB');

    assert.ok(!s.has('console.log.1'));
    assert.ok(!s.has('console.log.rotating'));
    var cur = s.read('console.log');
    assert.ok(cur.indexOf('LINEA') >= 0 && cur.indexOf('LINEB') >= 0);
    assert.ok(cur.indexOf('stat failed') >= 0);
    assert.strictEqual(count(cur, 'rotation failed'), 1);
    // The explicit throw in readDisk gives the note its cause; without it a
    // TypeError on null lands in the same catch and the note reads differently.
    assert.ok(cur.indexOf('could not read console.log') >= 0);

    K.files.info = realInfo;
    s.setNow(D1_NOON + s.retryMs + 1000);
    s.line('LINEC');
    assert.ok(s.has('console.log.1'));
    assert.ok(s.read('console.log.1').indexOf('LINEB') >= 0);
    assert.strictEqual(s.read('console.log').indexOf('LINEB'), -1);
    assert.ok(s.read('console.log').indexOf('LINEC') >= 0);
});

t.test('a missing modification date is not a stale day', function () {
    var s = setup({ now: D2_NOON });
    var K = s.K;
    var realInfo = K.files.info;
    s.configure({ maxFileSizeKB: 0, rotateDaily: true, keepRotated: 3 });
    s.put('console.log', 'OLD\n', D1_NOON);
    K.files.info = function (path) {
        var r = realInfo(path);
        if (r) r.modified = null;
        return r;
    };

    var base = s.fs.stats.moves;
    s.line('LINEA');

    // new Date(null) is the epoch, a different day, and would rotate.
    assert.strictEqual(s.fs.stats.moves, base);
    assert.ok(!s.has('console.log.1'));
    assert.ok(s.read('console.log').indexOf('LINEA') >= 0);
});

// ---- Settings ---------------------------------------------------------------

t.test('configure ignores invalid numbers and floors fractions', function () {
    var s = setup();
    var eff = function () { return s.K.log.effective(); };

    s.configure({ keepRotated: 1.5 });
    assert.strictEqual(eff().keepRotated, 1);
    s.configure({ keepRotated: -1 });
    assert.strictEqual(eff().keepRotated, 1);
    s.configure({ keepRotated: NaN });
    assert.strictEqual(eff().keepRotated, 1);
    s.configure({ keepRotated: Infinity });
    assert.strictEqual(eff().keepRotated, 1);
    s.configure({ keepRotated: '3' });
    assert.strictEqual(eff().keepRotated, 1);

    s.configure({ maxFileSizeKB: 100.9 });
    assert.strictEqual(eff().maxFileSizeKB, 100);
    s.configure({ maxFileSizeKB: -1 });
    assert.strictEqual(eff().maxFileSizeKB, 100);
    s.configure({ maxFileSizeKB: '50' });
    assert.strictEqual(eff().maxFileSizeKB, 100);

    s.configure({ rotateDaily: false });
    assert.strictEqual(eff().rotateDaily, false);
    s.configure({ rotateDaily: 1 });
    assert.strictEqual(eff().rotateDaily, false);
});

t.test('effective reports the LIMITS defaults', function () {
    var s = setup();
    var limits = s.K.LIMITS;
    assert.deepStrictEqual(JSON.parse(JSON.stringify(s.K.log.effective())), {
        debugEnabled:  false,
        fileEnabled:   true,
        maxFileSizeKB: limits.LOG_FILE_MAX_KB_DEFAULT,
        keepRotated:   limits.LOG_KEEP_ROTATED_DEFAULT,
        rotateDaily:   limits.LOG_ROTATE_DAILY_DEFAULT
    });
});

t.test('a failing delete inside rotation does not recurse', function () {
    var s = setup();
    // The capture hides the real logger; the delete failure must reach it.
    s.K.error = s.K.error.raw;
    s.configure({ maxFileSizeKB: 1, rotateDaily: false, keepRotated: 2 });
    s.put('console.log.1', 'a1');
    s.put('console.log.2', 'a2');
    s.put('console.log', rep('x', 2 * KB));
    s.fs.fail.remove[s.path('console.log.2')] = true;

    s.line('LINEA');

    var cur = s.read('console.log');
    assert.ok(cur.indexOf('LINEA') >= 0);
    assert.strictEqual(count(cur, 'delete failed'), 1);
    assert.strictEqual(count(cur, 'rotation failed'), 1);
    assert.ok(s.has('console.log.rotating'));
    assert.strictEqual(s.read('console.log.2'), 'a2');
});

// ---- Full bundle load -------------------------------------------------------

function bootFull(seed, prepare) {
    var fs = airfs.make();
    fs.dirs['C:/client/steward'] = true;
    fs.dirs[DIR] = true;
    var hs = hostStubs.makeSettingsHost();
    if (seed) hs.store(seed, 'steward.logger');
    if (prepare) prepare(fs);
    var H = harness.boot({ host: { air: fs.air, settings: hs } });
    return { fs: fs, H: H };
}

function bigLog(fs) {
    fs.disk[LOG] = rep('x', 6 * 1024 * KB);
    // Today, so only the size can make it due.
    fs.mtime[LOG] = new Date();
}

t.test('no rotation with a stored size of 0 on a full bundle load', function () {
    var b = bootFull({ maxFileSizeKB: 0, rotateDaily: false }, bigLog);
    assert.ok(!Object.prototype.hasOwnProperty.call(b.fs.disk, LOG + '.1'));
    var text = b.fs.disk[LOG];
    assert.ok(text.length > 6 * 1024 * KB);
    assert.ok(/\[registry\]/.test(text.substr(6 * 1024 * KB)));
});

t.test('fileEnabled false is honoured from the first line of a full bundle load', function () {
    var b = bootFull({ fileEnabled: false });
    assert.ok(!Object.prototype.hasOwnProperty.call(b.fs.disk, LOG));
    assert.deepStrictEqual(Object.keys(b.fs.disk), []);
});

t.test('an oversized file rotates during a full bundle load with no stored settings', function () {
    var b = bootFull(null, bigLog);
    assert.strictEqual(b.fs.disk[LOG + '.1'], rep('x', 6 * 1024 * KB));
    var text = b.fs.disk[LOG];
    assert.ok(text.length < KB * KB);
    assert.ok(/\[registry\]/.test(text));
});
