/*
 * Battle files: loader and validator.
 *
 * Reads the .txt files the client's battle window saves (one JSON object,
 * keyed by general uid "N.N" or by "buff_*" for star-menu buffs) and checks
 * them against the current army. Read-only: nothing here sends anything.
 *
 * Line kinds (S.BattleLine): Attack (general with a target camp), Move
 * (general without a target), Star (grid <= 0: the general stays out of the
 * field and only receives troops), Buff (a buff applied to a target) and
 * SpeedBuff (a horseshoe line; the template's own choice applies instead).
 *
 * Problems are fatal or warnings. A fatal problem means the wave cannot be
 * run as written; a warning is shown but does not block. The fatal set lives
 * once, in FATAL, and every producer builds problems through problem().
 *
 * validate() is pure over an injected context, so this file has no
 * dependency on core/army.js; production passes army's classOf/total in.
 *
 * Bundle place: core, before buildings. At load time it only fills the enum
 * slots and assigns S.core.battles; S.kernel.files is used at call time.
 */

(function (S) {

    var P = S.BattleProblem;
    P.NotFound       = 'ProblemNotFound';
    P.Unreadable     = 'ProblemUnreadable';
    P.NotJson        = 'ProblemNotJson';
    P.RunTemplate    = 'ProblemRunTemplate';
    P.Empty          = 'ProblemEmpty';
    P.BadKey         = 'ProblemBadKey';
    P.BadLine        = 'ProblemBadLine';
    P.MissingGeneral = 'ProblemMissingGeneral';
    P.CarrierTarget  = 'ProblemCarrierTarget';
    P.MixedTroops    = 'ProblemMixedTroops';
    P.UnknownUnit    = 'ProblemUnknownUnit';
    P.OverCapacity   = 'ProblemOverCapacity';
    P.TargetMissing  = 'ProblemTargetMissing';
    P.TargetNotEnemy = 'ProblemTargetNotEnemy';
    P.TimeRange      = 'ProblemTimeRange';
    P.StarWithArmy   = 'ProblemStarWithArmy';
    P.SpeedBuffLine  = 'ProblemSpeedBuffLine';
    P.NotInLoadout   = 'ProblemNotInLoadout';

    var L = S.BattleLine;
    L.Attack    = 'LineAttack';
    L.Move      = 'LineMove';
    L.Star      = 'LineStar';
    L.Buff      = 'LineBuff';
    L.SpeedBuff = 'LineSpeedBuff';

    // These lines name a general (a loadout key). Buff and speed-buff lines
    // do not, so callers test membership here instead of restating the kinds.
    function isGeneralLine(line) {
        if (!line) return false;
        return line.kind === L.Attack || line.kind === L.Move || line.kind === L.Star;
    }

    // Of the general lines, Attack and Move carry troops into the field. A
    // Star line holds none, so it is left out of the supply request.
    function supplyWave(lines) {
        var wave = [];
        for (var i = 0; i < lines.length; i++) {
            if (lines[i].kind === L.Attack || lines[i].kind === L.Move) {
                wave.push({ key: lines[i].key, army: lines[i].army });
            }
        }
        return wave;
    }

    // The set of general keys a parsed loadout names, as a lookup map.
    function loadoutKeys(lines) {
        var keys = {};
        for (var i = 0; i < lines.length; i++) {
            if (isGeneralLine(lines[i])) keys[lines[i].key] = true;
        }
        return keys;
    }

    // A wave may only use generals the loadout brings; one problem per
    // general line whose key the loadout does not list.
    function notInLoadout(lines, keys) {
        var out = [];
        for (var i = 0; i < lines.length; i++) {
            if (isGeneralLine(lines[i]) && !Object.prototype.hasOwnProperty.call(keys, lines[i].key)) {
                out.push(problem(P.NotInLoadout, lines[i].key,
                    (lines[i].name ? lines[i].name + ' ' : '') + '(' + lines[i].key +
                    ') is not in the loadout'));
            }
        }
        return out;
    }

    // Open-dialog filter list for battle files, in the shape that
    // Steward.kernel.files.browse takes as opts.filters.
    var BROWSE_FILTERS = [
        { label: 'Battle files', pattern: '*.txt' },
        { label: 'All files',    pattern: '*.*' }
    ];

    // The only copy of the fatal set; everything else is a warning.
    var FATAL = {};
    FATAL[P.NotFound]       = true;
    FATAL[P.Unreadable]     = true;
    FATAL[P.NotJson]        = true;
    FATAL[P.RunTemplate]    = true;
    FATAL[P.Empty]          = true;
    FATAL[P.BadKey]         = true;
    FATAL[P.BadLine]        = true;
    FATAL[P.MissingGeneral] = true;
    FATAL[P.CarrierTarget]  = true;
    FATAL[P.MixedTroops]    = true;
    FATAL[P.OverCapacity]   = true;
    FATAL[P.NotInLoadout]   = true;

    var KEY_RE = /^\d+\.\d+$/;
    var BUFF_PREFIX = 'buff_';

    // The battle window accepts 1..300 s per line (C:5-battle.js:52-53).
    var TIME_MIN_MS = 1000;
    var TIME_MAX_MS = 300000;

    function problem(code, key, message) {
        return {
            code:    code,
            fatal:   FATAL[code] === true,
            key:     key === undefined ? null : key,
            message: message
        };
    }

    function isPlainObject(v) {
        return v !== null && typeof v === 'object' && Object.prototype.toString.call(v) === '[object Object]';
    }

    function isNum(v) {
        return typeof v === 'number' && isFinite(v);
    }

    function copyArmy(src) {
        var out = {};
        for (var k in src) {
            if (Object.prototype.hasOwnProperty.call(src, k) && isNum(src[k]) && src[k] > 0) out[k] = src[k];
        }
        return out;
    }

    function hasFatal(problems) {
        for (var i = 0; i < problems.length; i++) {
            if (problems[i].fatal) return true;
        }
        return false;
    }

    function parse(text) {
        var problems = [];
        var data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            problems.push(problem(P.NotJson, null, 'not valid JSON: ' + e));
            return { ok: false, lines: [], problems: problems };
        }
        if (!isPlainObject(data)) {
            problems.push(problem(P.NotJson, null, 'not a battle file: top level is not an object'));
            return { ok: false, lines: [], problems: problems };
        }
        if (Object.prototype.toString.call(data.steps) === '[object Array]') {
            problems.push(problem(P.RunTemplate, null, 'autoTSO run template, not a battle file'));
            return { ok: false, lines: [], problems: problems };
        }

        var lines = [];
        var index = 0;
        for (var key in data) {
            if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
            var raw = data[key];
            var line = null;

            if (key.indexOf(BUFF_PREFIX) === 0) {
                var kind = null;
                if (isPlainObject(raw)) {
                    if (raw.type === 'buff') kind = L.Buff;
                    else if (raw.type === 'speedbuff') kind = L.SpeedBuff;
                }
                if (kind === null) {
                    problems.push(problem(P.BadLine, key, 'buff line ' + key + ' has an unknown type'));
                    continue;
                }
                if (kind === L.Buff && !(isNum(raw.target) && raw.target > 0)) {
                    problems.push(problem(P.BadLine, key, 'buff line ' + key + ' has no target camp'));
                    continue;
                }
                // The battle window stores names as HTML (colour spans etc.).
                line = {
                    key:        key,
                    kind:       kind,
                    grid:       null,
                    target:     isNum(raw.target) && raw.target > 0 ? raw.target : null,
                    targetName: typeof raw.targetName === 'string' ? S.kernel.text.plain(raw.targetName) : null,
                    army:       {},
                    timeMs:     isNum(raw.time) ? raw.time : null,
                    order:      isNum(raw.order) ? raw.order : null,
                    name:       S.kernel.text.plain(raw.name),
                    buffName:   typeof raw.name === 'string' ? raw.name : null
                };
            } else {
                if (!KEY_RE.test(key)) {
                    problems.push(problem(P.BadKey, key, 'line key "' + key + '" is not a general uid (N.N) or buff_*'));
                    continue;
                }
                if (!isPlainObject(raw) || !isNum(raw.grid) || !isPlainObject(raw.army)) {
                    problems.push(problem(P.BadLine, key, 'line ' + key + ' lacks a numeric grid or an army object'));
                    continue;
                }
                var hasTarget = isNum(raw.target) && raw.target > 0;
                line = {
                    key:        key,
                    kind:       raw.grid <= 0 ? L.Star : (hasTarget ? L.Attack : L.Move),
                    grid:       raw.grid,
                    target:     hasTarget ? raw.target : null,
                    targetName: typeof raw.targetName === 'string' ? S.kernel.text.plain(raw.targetName) : null,
                    army:       copyArmy(raw.army),
                    timeMs:     isNum(raw.time) ? raw.time : null,
                    order:      isNum(raw.order) ? raw.order : null,
                    name:       S.kernel.text.plain(raw.name),
                    buffName:   null
                };
            }
            line.index = index++;
            lines.push(line);
        }

        // Ascending order, unordered lines last, ties keep the file's key order.
        lines.sort(function (a, b) {
            var ao = a.order === null, bo = b.order === null;
            if (ao !== bo) return ao ? 1 : -1;
            if (!ao && a.order !== b.order) return a.order - b.order;
            return a.index - b.index;
        });
        for (var i = 0; i < lines.length; i++) delete lines[i].index;

        if (lines.length === 0) problems.push(problem(P.Empty, null, 'no usable lines in the file'));
        return { ok: !hasFatal(problems), lines: lines, problems: problems };
    }

    function who(line, fighters) {
        var f = fighters && fighters[line.key];
        var name = (f && f.name) || line.name || '';
        return (name ? name + ' ' : '') + '(' + line.key + ')';
    }

    function target(line) {
        return line.targetName ? line.targetName + ' (' + line.target + ')' : String(line.target);
    }

    function validate(lines, ctx) {
        var out = [];
        var fighters = ctx.fighters || {};
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            var k = line.key;

            if (line.kind === L.SpeedBuff) {
                out.push(problem(P.SpeedBuffLine, k, 'speed buff line ' + k + ' ignored: the template horseshoe applies instead'));
                continue;
            }

            if ((line.kind === L.Attack || line.kind === L.Buff) && typeof ctx.camp === 'function') {
                var camp = ctx.camp(line.target);
                if (!camp) {
                    out.push(problem(P.TargetMissing, k, 'target ' + target(line) + ' of ' + who(line, fighters) +
                        ' not found (the camp may already be beaten)'));
                } else if (camp.enemy === false) {
                    out.push(problem(P.TargetNotEnemy, k, 'target ' + target(line) + ' of ' + who(line, fighters) +
                        ' is not an enemy camp'));
                }
            }

            if (line.kind === L.Buff) continue;

            var f = fighters[k];
            if (!f) {
                out.push(problem(P.MissingGeneral, k, who(line, fighters) + ' is not among your generals'));
                continue;
            }
            var name = who(line, fighters);

            if (f.cls === S.SpecialistType.Carrier && line.kind === L.Attack) {
                out.push(problem(P.CarrierTarget, k, name + ' is a carrier and cannot attack target ' + target(line)));
            }

            var cls = ctx.classOf(line.army);
            if (cls === S.TroopClass.Mixed) {
                out.push(problem(P.MixedTroops, k, name + ' mixes base and elite troops'));
            } else if (cls === S.TroopClass.Unknown) {
                for (var unit in line.army) {
                    if (Object.prototype.hasOwnProperty.call(line.army, unit) && ctx.isElite(unit) === null) {
                        out.push(problem(P.UnknownUnit, k, name + ' lists unknown unit ' + unit));
                    }
                }
            }

            if (f.capacity > 0 && ctx.total(line.army) > f.capacity) {
                out.push(problem(P.OverCapacity, k, name + ' carries ' + ctx.total(line.army) +
                    ' units, capacity is ' + f.capacity));
            }

            if (line.kind === L.Star && ctx.total(line.army) > 0) {
                out.push(problem(P.StarWithArmy, k, name + ' stays on the star but lists troops'));
            }

            if (isNum(line.timeMs) && (line.timeMs < TIME_MIN_MS || line.timeMs > TIME_MAX_MS)) {
                out.push(problem(P.TimeRange, k, name + ' has a time of ' + line.timeMs +
                    ' ms, outside ' + TIME_MIN_MS + '..' + TIME_MAX_MS));
            }
        }
        return out;
    }

    function load(path) {
        var r = S.kernel.files.readText(path);
        if (!r.ok) {
            var missing = r.error === S.FileError.Missing;
            return {
                ok: false,
                path: path,
                lines: [],
                problems: [problem(missing ? P.NotFound : P.Unreadable, null,
                    (missing ? 'file not found: ' : 'file unreadable: ') + path +
                    (missing ? '' : ' (' + r.message + ')'))]
            };
        }
        var res = parse(r.text);
        res.path = path;
        return res;
    }

    S.core.battles = {
        parse:          parse,
        validate:       validate,
        load:           load,
        problem:        problem,
        isGeneralLine:  isGeneralLine,
        supplyWave:     supplyWave,
        loadoutKeys:    loadoutKeys,
        notInLoadout:   notInLoadout,
        FATAL:         FATAL,
        KEY_RE:         KEY_RE,
        BROWSE_FILTERS: BROWSE_FILTERS
    };

}(Steward));
