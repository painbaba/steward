'use strict';

var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');

var assert = t.assert;

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function boot(hostOpts) {
    var H = harness.boot({ host: hostOpts || {} });
    return { H: H, S: H.Steward, battles: H.Steward.core.battles };
}

// A battle file shaped like the ones the client's battle window saves.
function corpus() {
    return {
        '8908.0': {
            name: '<span style="color:#f00">Hans</span> &amp; Co',
            grid: 5, target: 77, targetName: 'Camp &lt;1&gt;',
            army: { Rifle: 100, Sabre: 20 }, time: 5000, order: 2
        },
        '8909.0': { name: 'Star', grid: -1, army: {}, time: 1000, order: 1 },
        '8910.0': { name: 'Mover', grid: 7, army: { Rifle: 5 }, time: 2000, order: 3 },
        'buff_1': { type: 'buff', name: 'SomeBuff', target: 77, targetName: 'Camp', time: 1000, order: 4 }
    };
}

function parse(b, obj) { return b.battles.parse(JSON.stringify(obj)); }

function codes(problems) {
    var out = [];
    for (var i = 0; i < problems.length; i++) out.push(problems[i].code);
    return out;
}

// ---- parse -------------------------------------------------------------------

t.test('parse: corpus-shaped file yields attack, move, star and buff lines in order', function () {
    var b = boot();
    var r = parse(b, corpus());
    var L = b.S.BattleLine;
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(plain(r.lines.map(function (l) { return l.key; })),
        ['8909.0', '8908.0', '8910.0', 'buff_1']);
    assert.deepStrictEqual(plain(r.lines.map(function (l) { return l.kind; })),
        [L.Star, L.Attack, L.Move, L.Buff]);
});

t.test('parse: names and target names are stripped of HTML and entities', function () {
    var b = boot();
    var r = parse(b, corpus());
    var attack = r.lines[1];
    assert.strictEqual(attack.name, 'Hans & Co');
    assert.strictEqual(attack.targetName, 'Camp <1>');
    assert.strictEqual(attack.target, 77);
    assert.strictEqual(attack.timeMs, 5000);
});

t.test('parse: a "buff_" line with type buff carries its raw buff name', function () {
    var b = boot();
    var buff = parse(b, corpus()).lines[3];
    assert.strictEqual(buff.kind, b.S.BattleLine.Buff);
    assert.strictEqual(buff.buffName, 'SomeBuff');
    assert.strictEqual(buff.target, 77);
    assert.deepStrictEqual(plain(buff.army), {});
});

t.test('parse: a grid of -1 is a star line and a move line has no target', function () {
    var b = boot();
    var r = parse(b, corpus());
    assert.strictEqual(r.lines[0].kind, b.S.BattleLine.Star);
    assert.strictEqual(r.lines[0].target, null);
    assert.strictEqual(r.lines[2].kind, b.S.BattleLine.Move);
    assert.strictEqual(r.lines[2].target, null);
});

t.test('parse: an empty army object is accepted', function () {
    var b = boot();
    var r = parse(b, { '1.0': { grid: 3, army: {} } });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(plain(r.lines[0].army), {});
});

t.test('parse: a speedbuff line becomes a SpeedBuff line', function () {
    var b = boot();
    var r = parse(b, { buff_s: { type: 'speedbuff', name: 'GeneralSpeedBuff_A' }, '1.0': { grid: 3, army: {} } });
    var kinds = {};
    r.lines.forEach(function (l) { kinds[l.key] = l.kind; });
    assert.strictEqual(kinds.buff_s, b.S.BattleLine.SpeedBuff);
    assert.strictEqual(kinds['1.0'], b.S.BattleLine.Move);
});

t.test('parse: ordering by order, gaps and missing values last in key order', function () {
    var b = boot();
    var r = parse(b, {
        '1.0': { grid: 1, army: {}, order: 10 },
        '2.0': { grid: 1, army: {} },
        '3.0': { grid: 1, army: {}, order: 2 },
        '4.0': { grid: 1, army: {} },
        '5.0': { grid: 1, army: {}, order: 5 }
    });
    assert.deepStrictEqual(plain(r.lines.map(function (l) { return l.key; })),
        ['3.0', '5.0', '1.0', '2.0', '4.0']);
});

t.test('parse: invalid JSON is NotJson and fatal', function () {
    var b = boot();
    var r = b.battles.parse('{oops');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.problems[0].code, b.S.BattleProblem.NotJson);
    assert.strictEqual(r.problems[0].fatal, true);
});

t.test('parse: a top-level array is NotJson', function () {
    var b = boot();
    var r = b.battles.parse('[1,2]');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.problems[0].code, b.S.BattleProblem.NotJson);
});

t.test('parse: a run template is recognised and rejected', function () {
    var b = boot();
    var r = parse(b, { name: 'x', steps: [], hash: 'abc' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.problems[0].code, b.S.BattleProblem.RunTemplate);
    assert.strictEqual(r.problems[0].fatal, true);
});

t.test('parse: an object without lines is Empty and fatal', function () {
    var b = boot();
    var r = parse(b, {});
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(plain(codes(r.problems)), [b.S.BattleProblem.Empty]);
});

t.test('parse: a key that is neither N.N nor buff_ is BadKey', function () {
    var b = boot();
    var r = parse(b, { abc: { grid: 1, army: {} }, '1.0': { grid: 1, army: {} } });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(plain(codes(r.problems)), [b.S.BattleProblem.BadKey]);
    assert.strictEqual(r.problems[0].key, 'abc');
    assert.strictEqual(r.lines.length, 1);
});

t.test('parse: a line without a numeric grid or an army object is BadLine', function () {
    var b = boot();
    var r = parse(b, { '1.0': { grid: 'x', army: {} }, '2.0': { grid: 1 }, '3.0': { grid: 1, army: {} } });
    assert.deepStrictEqual(plain(codes(r.problems)), [b.S.BattleProblem.BadLine, b.S.BattleProblem.BadLine]);
    assert.strictEqual(r.lines.length, 1);
});

t.test('parse: a buff line with an unknown type or no target is BadLine', function () {
    var b = boot();
    var r = parse(b, {
        buff_a: { type: 'weird', name: 'x', target: 5 },
        buff_b: { type: 'buff', name: 'x' },
        '1.0': { grid: 1, army: {} }
    });
    assert.deepStrictEqual(plain(codes(r.problems)), [b.S.BattleProblem.BadLine, b.S.BattleProblem.BadLine]);
});

// ---- validate ----------------------------------------------------------------

function ctxFor(b, fighters, extra) {
    var army = b.S.core.army;
    function isElite(u) { return u === 'EliteRifle' ? true : (u === 'Ghost' ? null : false); }
    var ctx = {
        fighters: fighters,
        classOf:  function (m) { return army.classOf(m, isElite); },
        total:    army.total,
        isElite:  isElite
    };
    for (var k in (extra || {})) ctx[k] = extra[k];
    return ctx;
}

function fighters(b, map) {
    var out = {};
    for (var k in map) {
        out[k] = { name: 'G' + k, cls: map[k].cls || b.S.SpecialistType.General, capacity: map[k].capacity || 0 };
    }
    return out;
}

function line(key, kind, army, extra) {
    var l = { key: key, kind: kind, grid: 5, target: null, targetName: null, army: army || {}, timeMs: null, order: null, name: '', buffName: null };
    for (var k in (extra || {})) l[k] = extra[k];
    return l;
}

function validate(b, lines, f, extra) {
    return plain(b.battles.validate(lines, ctxFor(b, f, extra)));
}

t.test('validate: MissingGeneral when the key is not among the fighters', function () {
    var b = boot();
    var p = validate(b, [line('9.0', b.S.BattleLine.Move)], fighters(b, {}));
    assert.deepStrictEqual(codes(p), [b.S.BattleProblem.MissingGeneral]);
    assert.strictEqual(p[0].fatal, true);
});

t.test('validate: CarrierTarget when a carrier is given an attack', function () {
    var b = boot();
    var f = fighters(b, { '1.0': { cls: b.S.SpecialistType.Carrier } });
    var p = validate(b, [line('1.0', b.S.BattleLine.Attack, {}, { target: 5 })], f);
    assert.deepStrictEqual(codes(p), [b.S.BattleProblem.CarrierTarget]);
    assert.strictEqual(p[0].fatal, true);
});

t.test('validate: a carrier on a move line is fine', function () {
    var b = boot();
    var f = fighters(b, { '1.0': { cls: b.S.SpecialistType.Carrier } });
    assert.deepStrictEqual(validate(b, [line('1.0', b.S.BattleLine.Move)], f), []);
});

t.test('validate: MixedTroops for base and elite together', function () {
    var b = boot();
    var p = validate(b, [line('1.0', b.S.BattleLine.Move, { Rifle: 1, EliteRifle: 1 })], fighters(b, { '1.0': {} }));
    assert.deepStrictEqual(codes(p), [b.S.BattleProblem.MixedTroops]);
    assert.strictEqual(p[0].fatal, true);
});

t.test('validate: UnknownUnit names only the unknown unit and is a warning', function () {
    var b = boot();
    var p = validate(b, [line('1.0', b.S.BattleLine.Move, { Rifle: 1, Ghost: 2 })], fighters(b, { '1.0': {} }));
    assert.deepStrictEqual(codes(p), [b.S.BattleProblem.UnknownUnit]);
    assert.strictEqual(p[0].fatal, false);
    assert.ok(p[0].message.indexOf('Ghost') !== -1);
    assert.ok(p[0].message.indexOf('Rifle') === -1);
});

t.test('validate: OverCapacity when the army exceeds a positive capacity', function () {
    var b = boot();
    var p = validate(b, [line('1.0', b.S.BattleLine.Move, { Rifle: 60 })], fighters(b, { '1.0': { capacity: 50 } }));
    assert.deepStrictEqual(codes(p), [b.S.BattleProblem.OverCapacity]);
    assert.strictEqual(p[0].fatal, true);
});

t.test('validate: no OverCapacity when the capacity is 0 or the army fits', function () {
    var b = boot();
    assert.deepStrictEqual(validate(b, [line('1.0', b.S.BattleLine.Move, { Rifle: 600 })], fighters(b, { '1.0': { capacity: 0 } })), []);
    assert.deepStrictEqual(validate(b, [line('1.0', b.S.BattleLine.Move, { Rifle: 50 })], fighters(b, { '1.0': { capacity: 50 } })), []);
});

t.test('validate: StarWithArmy for a star line that lists troops', function () {
    var b = boot();
    var p = validate(b, [line('1.0', b.S.BattleLine.Star, { Rifle: 5 }, { grid: -1 })], fighters(b, { '1.0': {} }));
    assert.deepStrictEqual(codes(p), [b.S.BattleProblem.StarWithArmy]);
    assert.strictEqual(p[0].fatal, false);
});

t.test('validate: TimeRange outside 1000..300000 ms, bounds included', function () {
    var b = boot();
    var f = fighters(b, { '1.0': {} });
    function run(ms) { return codes(validate(b, [line('1.0', b.S.BattleLine.Move, {}, { timeMs: ms })], f)); }
    assert.deepStrictEqual(run(999), [b.S.BattleProblem.TimeRange]);
    assert.deepStrictEqual(run(300001), [b.S.BattleProblem.TimeRange]);
    assert.deepStrictEqual(run(1000), []);
    assert.deepStrictEqual(run(300000), []);
});

t.test('validate: TargetMissing and TargetNotEnemy only when ctx.camp is given', function () {
    var b = boot();
    var f = fighters(b, { '1.0': {}, '2.0': {}, '3.0': {} });
    var lines = [
        line('1.0', b.S.BattleLine.Attack, {}, { target: 77 }),
        line('2.0', b.S.BattleLine.Attack, {}, { target: 78 }),
        line('3.0', b.S.BattleLine.Attack, {}, { target: 79 }),
        line('buff_1', b.S.BattleLine.Buff, {}, { target: 79 })
    ];
    assert.deepStrictEqual(validate(b, lines, f), []);
    var camp = function (id) {
        if (id === 77) return { enemy: true };
        if (id === 78) return { enemy: false };
        return null;
    };
    var p = validate(b, lines, f, { camp: camp });
    assert.deepStrictEqual(codes(p), [
        b.S.BattleProblem.TargetNotEnemy,
        b.S.BattleProblem.TargetMissing,
        b.S.BattleProblem.TargetMissing
    ]);
    assert.strictEqual(p[0].fatal, false);
    assert.strictEqual(p[1].fatal, false);
});

t.test('validate: SpeedBuffLine is a warning and the line is not checked further', function () {
    var b = boot();
    var p = validate(b, [line('buff_s', b.S.BattleLine.SpeedBuff)], fighters(b, {}));
    assert.deepStrictEqual(codes(p), [b.S.BattleProblem.SpeedBuffLine]);
    assert.strictEqual(p[0].fatal, false);
});

t.test('validate: a clean corpus-shaped file has no problems', function () {
    var b = boot();
    var r = parse(b, corpus());
    var f = fighters(b, { '8908.0': { capacity: 200 }, '8909.0': {}, '8910.0': {} });
    assert.deepStrictEqual(validate(b, r.lines, f), []);
});

// ---- FATAL ---------------------------------------------------------------------

t.test('fatal flags follow FATAL: blocking codes fatal, the rest warnings', function () {
    var b = boot();
    var P = b.S.BattleProblem;
    var fatal = ['NotFound', 'Unreadable', 'NotJson', 'RunTemplate', 'Empty', 'BadKey', 'BadLine',
        'MissingGeneral', 'CarrierTarget', 'MixedTroops', 'OverCapacity', 'NotInLoadout'];
    var warn = ['UnknownUnit', 'TargetMissing', 'TargetNotEnemy', 'TimeRange', 'StarWithArmy', 'SpeedBuffLine'];
    var i;
    for (i = 0; i < fatal.length; i++) {
        assert.strictEqual(b.battles.problem(P[fatal[i]], null, 'm').fatal, true, fatal[i]);
        assert.strictEqual(b.battles.FATAL[P[fatal[i]]], true, fatal[i]);
    }
    for (i = 0; i < warn.length; i++) {
        assert.strictEqual(b.battles.problem(P[warn[i]], null, 'm').fatal, false, warn[i]);
    }
    assert.strictEqual(Object.keys(P).length, fatal.length + warn.length);
});

// ---- load ----------------------------------------------------------------------

t.test('load: a missing file is NotFound', function () {
    var fs = airfs.make();
    var b = boot({ air: fs.air });
    var r = b.battles.load('C:/battles/none.txt');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.path, 'C:/battles/none.txt');
    assert.strictEqual(r.problems[0].code, b.S.BattleProblem.NotFound);
    assert.strictEqual(r.problems[0].fatal, true);
});

t.test('load: a read fault is Unreadable', function () {
    var fs = airfs.make();
    fs.disk['C:/battles/a.txt'] = JSON.stringify(corpus());
    fs.fail.read['C:/battles/a.txt'] = true;
    var b = boot({ air: fs.air });
    var r = b.battles.load('C:/battles/a.txt');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.problems[0].code, b.S.BattleProblem.Unreadable);
});

t.test('load: file text is parsed into lines and carries its path', function () {
    var fs = airfs.make();
    fs.disk['C:/battles/a.txt'] = JSON.stringify(corpus());
    var b = boot({ air: fs.air });
    var r = b.battles.load('C:/battles/a.txt');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.path, 'C:/battles/a.txt');
    assert.strictEqual(r.lines.length, 4);
    assert.strictEqual(r.lines[0].key, '8909.0');
});

// ---- helpers -----------------------------------------------------------------

t.test('isGeneralLine: attack, move and star lines are general lines', function () {
    var b = boot();
    var r = parse(b, corpus());
    assert.strictEqual(b.battles.isGeneralLine(r.lines[0]), true);
    assert.strictEqual(b.battles.isGeneralLine(r.lines[1]), true);
    assert.strictEqual(b.battles.isGeneralLine(r.lines[2]), true);
});

t.test('isGeneralLine: buff, speed-buff and null are not', function () {
    var b = boot();
    var r = parse(b, corpus());
    assert.strictEqual(b.battles.isGeneralLine(r.lines[3]), false);
    assert.strictEqual(b.battles.isGeneralLine({ kind: b.S.BattleLine.SpeedBuff }), false);
    assert.strictEqual(b.battles.isGeneralLine(null), false);
});

t.test('BROWSE_FILTERS: battle .txt filter first, all files last', function () {
    var f = boot().battles.BROWSE_FILTERS;
    assert.strictEqual(f[0].label, 'Battle files');
    assert.strictEqual(f[0].pattern, '*.txt');
    assert.strictEqual(f[f.length - 1].label, 'All files');
    assert.strictEqual(f[f.length - 1].pattern, '*.*');
});
