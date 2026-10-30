/*
 * Run state store for the adventures module.
 *
 * Holds the run request (the series: template, count, runs finished) and the
 * current run, from muster at home through the waves and the end of the map
 * back home, and is the only writer of the run's step and status. The home
 * and away steps, the wave executor, the quest watcher and the user commands
 * all change the run through the functions below, so every transition is
 * logged and persisted in one place.
 *
 * run.step holds either a wave step (S.WaveStep, run by the executor) or a
 * series step (S.RunStep). RUN_STEPS below is the one table of the series
 * steps: S.RunStep is filled from it, and which part runs a step and on which
 * zone it may run (partOf, readyOn) are read from it, so no second list of
 * steps exists to drift from it. Wave steps always run on the run's island.
 *
 * Storage: one file, <steward folder>/adventures/run.json, written whole
 * with S.kernel.files.writeText (temp file, then move). The file replaces
 * the previous one, so a field that is dropped from the run never lingers;
 * the host settings store is a deep merge and would keep it. File format:
 * JSON.stringify of { version, request, run }, indented.
 *
 * The working copy is S.modules.adventures.runState. The module namespace
 * survives a script reload, so load() reads the file only on a fresh client
 * (runState.loaded is unset); after a reload the memory copy already equals
 * the file. A run that survives a client restart therefore resumes from the
 * file, and the executor re-observes the game before it sends anything.
 *
 * Memory-only parts of runState, never written: loaded, round (the action
 * round in flight), cache (parsed wave lines), questRetry (quest key ->
 * time a failed claim may be retried) and homeNote (the last wait the home
 * steps logged, so a repeated wait is logged once). They describe callbacks
 * and reads of this client session, which do not exist after a restart.
 * resetMemory() is the one place that resets them for a new or loaded run.
 * The round alone is also dropped at bundle load and by dropRound(), because a reload or a
 * cancelled queue removes its queued attempts while the run stays as it was.
 *
 * newRun() is the one literal of the run's shape; starting a run and loading
 * the file both build on it, so a field added there is persisted and loaded
 * without a second list to keep in step.
 *
 * A run file that cannot be trusted is never guessed at: an unknown step
 * restarts the wave at Gate, an unknown status pauses the run, and a run
 * without its loadout keys pauses until the user stops and starts it again.
 * A file written before the series fields existed loads with their newRun
 * defaults (no snapshot, no marks, no runs finished).
 *
 * Resume re-enters the paused step with fresh rounds and a fresh start time,
 * after the user has looked at the game. A wave step restarts its wave at
 * Gate instead, which re-reads the wave file. Unseen send markers (wave
 * lines and series marks) are cleared, so an order that never showed in the
 * game may be sent again.
 *
 * now() is the one clock of the run; callers read it through the namespace
 * at call time, so tests can replace it.
 *
 * Bundle slot: module file; top level fills S.WaveStep, S.RunStep,
 * S.RunStatus, S.RunPause, drops runState.round and assigns
 * S.modules.adventures.state; all else at call time.
 */

(function (S) {

    if (!S.modules.adventures) S.modules.adventures = {};

    S.WaveStep.Gate     = 'WaveGate';
    S.WaveStep.Position = 'WavePosition';
    S.WaveStep.Supply   = 'WaveSupply';
    S.WaveStep.Unload   = 'WaveUnload';
    S.WaveStep.Load     = 'WaveLoad';
    S.WaveStep.Verify   = 'WaveVerify';
    S.WaveStep.Reach    = 'WaveReach';
    S.WaveStep.Settle   = 'WaveSettle';
    S.WaveStep.Attack   = 'WaveAttack';
    S.WaveStep.Confirm  = 'WaveConfirm';

    // Where a series step may run. File-local and never persisted: the
    // file stores only the step value.
    var HOME = 1;       // the home island is viewed
    var ADVENTURE = 2;  // the run's adventure island is viewed
    var ANY = 3;        // any zone; the step itself handles where it is

    // The series steps in run order: [key, value, where]. The one table:
    // S.RunStep, partOf() and readyOn() are all read from it.
    var RUN_STEPS = [
        ['Muster',     'RunMuster',     HOME],
        ['Validate',   'RunValidate',   HOME],
        ['Snapshot',   'RunSnapshot',   HOME],
        ['Supply',     'RunSupply',     HOME],
        ['Unload',     'RunUnload',     HOME],
        ['Load',       'RunLoad',       HOME],
        ['Verify',     'RunVerify',     HOME],
        ['StartMap',   'RunStartMap',   HOME],
        ['Depart',     'RunDepart',     HOME],
        ['Jump',       'RunJump',       ANY],
        ['Arrive',     'RunArrive',     ADVENTURE],
        ['StarAll',    'RunStarAll',    ADVENTURE],
        ['Horseshoe',  'RunHorseshoe',  ADVENTURE],
        ['Clear',      'RunClear',      ADVENTURE],
        ['PackStar',   'RunPackStar',   ADVENTURE],
        ['Pack',       'RunPack',       ADVENTURE],
        ['LastQuest',  'RunLastQuest',  ANY],
        ['Close',      'RunClose',      ANY],
        ['Recall',     'RunRecall',     ANY],
        ['JumpHome',   'RunJumpHome',   ANY],
        ['ArriveHome', 'RunArriveHome', HOME],
        ['Account',    'RunAccount',    HOME],
        ['Population', 'RunPopulation', HOME],
        ['Retrain',    'RunRetrain',    HOME],
        ['Next',       'RunNext',       HOME]
    ];

    (function () {
        for (var i = 0; i < RUN_STEPS.length; i++) S.RunStep[RUN_STEPS[i][0]] = RUN_STEPS[i][1];
    }());

    S.RunStatus.Running = 'RunRunning';
    S.RunStatus.Paused  = 'RunPaused';
    S.RunStatus.Done    = 'RunDone';

    S.RunPause.User              = 'PauseUser';
    S.RunPause.WaveFile          = 'PauseWaveFile';
    S.RunPause.GeneralMissing    = 'PauseGeneralMissing';
    S.RunPause.GeneralBusy       = 'PauseGeneralBusy';
    S.RunPause.PositionFailed    = 'PausePositionFailed';
    S.RunPause.NotPlaceable      = 'PauseNotPlaceable';
    S.RunPause.TroopsShort       = 'PauseTroopsShort';
    S.RunPause.UnloadFailed      = 'PauseUnloadFailed';
    S.RunPause.LoadMismatch      = 'PauseLoadMismatch';
    S.RunPause.Unreachable       = 'PauseUnreachable';
    S.RunPause.SettleTimeout     = 'PauseSettleTimeout';
    S.RunPause.AttackRefused     = 'PauseAttackRefused';
    S.RunPause.AttackNotSeen     = 'PauseAttackNotSeen';
    S.RunPause.AttackUnconfirmed = 'PauseAttackUnconfirmed';
    S.RunPause.BuffFailed        = 'PauseBuffFailed';
    S.RunPause.NotObserved       = 'PauseNotObserved';
    S.RunPause.MapFailed         = 'PauseMapFailed';
    S.RunPause.DepartFailed      = 'PauseDepartFailed';
    S.RunPause.JumpFailed        = 'PauseJumpFailed';
    S.RunPause.StarFailed        = 'PauseStarFailed';
    S.RunPause.PackFailed        = 'PausePackFailed';
    S.RunPause.QuestFailed       = 'PauseQuestFailed';
    S.RunPause.CloseFailed       = 'PauseCloseFailed';
    S.RunPause.ClearTimeout      = 'PauseClearTimeout';
    S.RunPause.RetrainShort      = 'PauseRetrainShort';
    S.RunPause.RetrainFailed     = 'PauseRetrainFailed';

    var FILE_VERSION = 1;
    var SUBDIR = 'adventures';
    var FILE_NAME = 'run.json';

    // Each problem is reported once per script load; a store that cannot
    // write would otherwise warn on every transition.
    var warnedNoDir = false;
    var warnedWrite = false;

    function isArray(v) {
        return Object.prototype.toString.call(v) === '[object Array]';
    }

    function isPlainObject(v) {
        return v !== null && typeof v === 'object' && Object.prototype.toString.call(v) === '[object Object]';
    }

    function has(obj, key) {
        return Object.prototype.hasOwnProperty.call(obj, key);
    }

    function str(v) {
        return typeof v === 'string' ? v : '';
    }

    function num(v) {
        return typeof v === 'number' && isFinite(v) ? v : null;
    }

    function count(v) {
        return typeof v === 'number' && isFinite(v) && v >= 0 ? Math.floor(v) : 0;
    }

    function isValue(enumObj, value) {
        for (var k in enumObj) {
            if (has(enumObj, k) && enumObj[k] === value) return true;
        }
        return false;
    }

    // Display name of an enum value: its key, so no label table can drift
    // from the enum.
    function nameOf(enumObj, value) {
        if (enumObj) {
            for (var k in enumObj) {
                if (has(enumObj, k) && enumObj[k] === value) return k;
            }
        }
        return value === null || value === undefined ? '' : String(value);
    }

    // ---- Steps --------------------------------------------------------------

    function isWaveStep(v) {
        return isValue(S.WaveStep, v);
    }

    function isStep(v) {
        return isWaveStep(v) || isValue(S.RunStep, v);
    }

    // The where of a series step, or 0 for anything else.
    function whereOf(step) {
        for (var i = 0; i < RUN_STEPS.length; i++) {
            if (RUN_STEPS[i][1] === step) return RUN_STEPS[i][2];
        }
        return 0;
    }

    // The property of S.modules.adventures whose plan() runs the step, or
    // null for a value that is no step.
    function partOf(step) {
        if (isWaveStep(step)) return 'executor';
        var w = whereOf(step);
        if (w === HOME) return 'home';
        if (w === ADVENTURE || w === ANY) return 'away';
        return null;
    }

    // Whether the run's step may run on the zone the scheduler saw
    // ({ id, isHome }). A wave step runs on the run's island like an
    // ADVENTURE step. An unknown step runs nowhere.
    function readyOn(r, zone) {
        if (!r) return false;
        var z = zone || {};
        var w = isWaveStep(r.step) ? ADVENTURE : whereOf(r.step);
        if (w === ANY) return true;
        if (w === HOME) {
            if (typeof z.isHome === 'boolean') return z.isHome;
            return !!(S.core.zone && S.core.zone.isHome() === true);
        }
        if (w === ADVENTURE) return typeof r.zoneId === 'number' && z.id === r.zoneId;
        return false;
    }

    function stepName(step) {
        return nameOf(isWaveStep(step) ? S.WaveStep : S.RunStep, step);
    }

    function now() {
        return new Date().getTime();
    }

    // Read through the namespace so a test clock replaces every use.
    function clock() {
        return S.modules.adventures.state.now();
    }

    // The working copy. run.js loads first in name order and may have created
    // it without a run slot.
    function current() {
        var a = S.modules.adventures;
        if (!a.runState) a.runState = { request: null, run: null };
        if (a.runState.run === undefined) a.runState.run = null;
        if (a.runState.request === undefined) a.runState.request = null;
        return a.runState;
    }

    function run() {
        return current().run;
    }

    function notify(text) {
        if (S.kernel.ui && S.kernel.ui.notify) S.kernel.ui.notify(text);
    }

    // Rewrites the menu status line in place; no menu rebuild.
    function refresh() {
        if (S.kernel.ui && S.kernel.ui.status && S.kernel.ui.status.refresh) S.kernel.ui.status.refresh();
    }

    // ---- Labels -----------------------------------------------------------

    function waveLabel() {
        var r = run();
        if (!r) return '';
        var n = r.paths ? r.paths.length : 0;
        return 'wave ' + Math.min(r.waveIndex + 1, n) + '/' + n;
    }

    // Where the run is, for log, pause and notify texts: the wave during the
    // waves, else the series step.
    function labelOf(step) {
        return isWaveStep(step) ? waveLabel() : stepName(step);
    }

    function label() {
        var r = run();
        return r ? labelOf(r.step) : '';
    }

    // Runs finished and runs requested; a run without a request counts as a
    // series of one.
    function finishedRuns() {
        var q = current().request;
        return q ? count(q.finished) : 0;
    }

    function requestedRuns() {
        var q = current().request;
        return q && num(q.count) !== null && q.count >= 1 ? Math.floor(q.count) : 1;
    }

    function status() {
        var rs = current();
        var r = rs.run;
        if (!r) {
            if (!rs.request) return 'No run requested';
            var runCmd = S.modules.adventures.run;
            if (runCmd && runCmd.statusText) return runCmd.statusText(rs.request);
            return 'Requested: ' + rs.request.label;
        }
        if (r.status === S.RunStatus.Done) return 'Done: ' + r.label + ', ' + finishedRuns() + ' run(s)';
        var where = r.label + ', run ' + (finishedRuns() + 1) + '/' + requestedRuns() + ', ' +
            (isWaveStep(r.step) ? waveLabel() + ', ' : '') + stepName(r.step);
        if (r.status === S.RunStatus.Paused) {
            return 'Paused: ' + where + ': ' + (r.pause ? r.pause.message : '');
        }
        return 'Running: ' + where;
    }

    // ---- File -------------------------------------------------------------

    function filePath() {
        var d = S.kernel.files.stewardDir(SUBDIR);
        if (!d || !d.dir) {
            if (!warnedNoDir) {
                warnedNoDir = true;
                S.kernel.warn('adventures', 'no writable steward folder: the run state is kept in memory only');
            }
            return null;
        }
        try {
            return d.dir.resolvePath(FILE_NAME).nativePath;
        } catch (e) {
            S.kernel.warn('adventures', 'cannot resolve the run state path:', e);
            return null;
        }
    }

    // Pure. Only the persisted part; the memory-only parts are left out.
    function toFile(rs) {
        return JSON.stringify({
            version: FILE_VERSION,
            request: rs.request,
            run:     rs.run
        }, null, 2);
    }

    function save() {
        var path = filePath();
        if (!path) return false;
        var w = S.kernel.files.writeText(path, toFile(current()));
        if (!w.ok) {
            if (!warnedWrite) {
                warnedWrite = true;
                S.kernel.warn('adventures', 'run state not saved:', w.message);
            }
            return false;
        }
        warnedWrite = false;
        return true;
    }

    // ---- Run shape ----------------------------------------------------------

    // A troop count per unit: own keys with finite counts >= 0 are kept.
    // null (not a map) means "no snapshot", which skips retraining.
    function normArmy(v) {
        if (!isPlainObject(v)) return null;
        var out = {};
        for (var k in v) {
            if (has(v, k) && typeof v[k] === 'number' && isFinite(v[k]) && v[k] >= 0) out[k] = v[k];
        }
        return out;
    }

    // round, cache and questRetry belong to the run they were built for; a
    // new request, a new run or a loaded file starts without them.
    function resetMemory(rs) {
        rs.round = null;
        rs.cache = null;
        rs.questRetry = {};
        rs.homeNote = null;
    }

    // The only literal of the run object. start holds the facts fixed at
    // start: { id, templateId, label, adventure, zoneId, paths, loadoutPath,
    // loadoutKeys, waveIndex, speedBuff } and optionally the first step
    // (Gate when it is no step); every progress field takes its start value.
    // start may be omitted for the default shape.
    //
    // speedBuff is the template's choice as written and is resolved when it
    // is used. snapshot is the army counted at home before loading (null:
    // none). marks are the send markers of the series steps, in the shape of
    // lines. waitUntil is the deadline of the step that is waiting. popBase
    // is the free population read before the last population buff, so the
    // next pass can tell whether the buff took effect.
    function newRun(start) {
        var s = isPlainObject(start) ? start : {};
        var t = clock();
        return {
            id:          num(s.id) !== null ? s.id : t,
            templateId:  str(s.templateId),
            label:       str(s.label),
            adventure:   str(s.adventure),
            zoneId:      num(s.zoneId),
            // A copy: the run stays bound to the waves validated at start.
            paths:       isArray(s.paths) ? s.paths.slice(0) : [],
            loadoutPath: str(s.loadoutPath),
            loadoutKeys: isPlainObject(s.loadoutKeys) ? s.loadoutKeys : {},
            waveIndex:   count(s.waveIndex),
            speedBuff:   str(s.speedBuff),
            step:        isStep(s.step) ? s.step : S.WaveStep.Gate,
            status:      S.RunStatus.Running,
            since:       t,
            rounds:      0,
            cycles:      0,
            settleFrom:  null,
            settled:     0,
            blocker:     null,
            donors:      [],
            lines:       {},
            snapshot:    null,
            marks:       {},
            waitUntil:   null,
            popBase:     null,
            pause:       null
        };
    }

    // ---- Normalising a loaded file ------------------------------------------

    function normRequest(q) {
        if (!isPlainObject(q)) return null;
        var n = num(q.count);
        return {
            templateId: str(q.templateId),
            label:      str(q.label),
            adventure:  str(q.adventure),
            count:      n !== null && n >= 1 ? Math.floor(n) : 1,
            ended:      q.ended === true,
            requested:  num(q.requested),
            finished:   count(q.finished),
            closedAt:   num(q.closedAt)
        };
    }

    function strings(v) {
        var out = [];
        if (!isArray(v)) return out;
        for (var i = 0; i < v.length; i++) {
            if (typeof v[i] === 'string') out.push(v[i]);
        }
        return out;
    }

    function normKeys(v) {
        if (!isPlainObject(v)) return null;
        var out = {};
        for (var k in v) {
            if (has(v, k) && v[k] === true) out[k] = true;
        }
        return out;
    }

    function normLines(v) {
        var out = {};
        if (!isPlainObject(v)) return out;
        for (var k in v) {
            if (!has(v, k) || !isPlainObject(v[k])) continue;
            out[k] = {
                sentAt:   num(v[k].sentAt),
                seen:     v[k].seen === true,
                sentOnce: v[k].sentOnce === true
            };
        }
        return out;
    }

    // Grid targets are numbers and generals are names; either may be absent.
    function scalar(v) {
        return typeof v === 'string' || num(v) !== null ? v : null;
    }

    function normBlocker(b) {
        if (!isPlainObject(b)) return null;
        return { key: str(b.key), general: scalar(b.general), target: scalar(b.target), reason: str(b.reason) };
    }

    function normPause(p) {
        if (!isPlainObject(p)) return null;
        return {
            reason:  isValue(S.RunPause, p.reason) ? p.reason : S.RunPause.NotObserved,
            message: str(p.message),
            step:    isStep(p.step) ? p.step : null,
            wave:    num(p.wave),
            general: scalar(p.general),
            target:  scalar(p.target),
            at:      num(p.at)
        };
    }

    function filePause(r, reason, message) {
        r.status = S.RunStatus.Paused;
        r.pause = {
            reason:  reason,
            message: message,
            step:    r.step,
            wave:    r.waveIndex + 1,
            general: null,
            target:  null,
            at:      clock()
        };
    }

    // Returns { run, repaired }. repaired lists what was changed, for the log.
    // The run is built on newRun(), every field the file has is copied over,
    // and then each known field is normalised; a field without a normaliser
    // still round-trips. loadoutKeys may come back null here, which the
    // repair below turns into a WaveFile pause.
    function normRun(v) {
        if (!isPlainObject(v)) return { run: null, repaired: [] };
        var repaired = [];
        var facts = {
            id:          num(v.id) !== null ? v.id : 0,
            templateId:  str(v.templateId),
            label:       str(v.label),
            adventure:   str(v.adventure),
            zoneId:      num(v.zoneId),
            paths:       strings(v.paths),
            loadoutPath: str(v.loadoutPath),
            loadoutKeys: normKeys(v.loadoutKeys),
            waveIndex:   count(v.waveIndex),
            speedBuff:   str(v.speedBuff)
        };
        var r = newRun(facts);
        var k;
        for (k in r) {
            if (has(r, k) && has(v, k)) r[k] = v[k];
        }
        var since = num(v.since);
        r.step       = v.step;
        r.status     = v.status;
        r.since      = since !== null ? since : clock();
        r.rounds     = count(v.rounds);
        r.cycles     = count(v.cycles);
        r.settleFrom = v.settleFrom === S.WaveStep.Position || v.settleFrom === S.WaveStep.Reach ? v.settleFrom : null;
        r.settled    = count(v.settled);
        r.blocker    = normBlocker(v.blocker);
        r.donors     = strings(v.donors);
        r.lines      = normLines(v.lines);
        r.snapshot   = normArmy(v.snapshot);
        r.marks      = normLines(v.marks);
        r.waitUntil  = num(v.waitUntil);
        r.popBase    = num(v.popBase);
        r.pause      = normPause(v.pause);
        for (k in facts) {
            if (has(facts, k)) r[k] = facts[k];
        }
        if (!isStep(r.step)) {
            repaired.push('unknown step ' + String(r.step) + ' -> Gate');
            r.step = S.WaveStep.Gate;
        }
        if (!isValue(S.RunStatus, r.status)) {
            repaired.push('unknown status ' + String(r.status) + ' -> Paused');
            filePause(r, S.RunPause.NotObserved, 'state file had an unknown status');
        }
        if (r.loadoutKeys === null) {
            repaired.push('no loadout keys -> Paused');
            r.loadoutKeys = {};
            filePause(r, S.RunPause.WaveFile, 'state file has no loadout keys; Stop and start the run again');
        }
        if (r.status === S.RunStatus.Paused && !r.pause) {
            repaired.push('paused without a reason');
            filePause(r, S.RunPause.NotObserved, 'state file had no pause reason');
        }
        return { run: r, repaired: repaired };
    }

    // Reads the file once per client session. Missing file: nothing stored.
    // Unreadable, unparsable or another version: warn and start empty.
    function load() {
        var rs = current();
        if (rs.loaded === true) return false;
        rs.loaded = true;
        var path = filePath();
        if (!path) return false;
        var r = S.kernel.files.readText(path);
        if (!r.ok) {
            if (r.error !== S.FileError.Missing) S.kernel.warn('adventures', 'run state not read:', r.message);
            return false;
        }
        var data;
        try {
            data = JSON.parse(r.text);
        } catch (e) {
            S.kernel.warn('adventures', 'run state file is not valid JSON, starting empty:', e);
            return false;
        }
        if (!isPlainObject(data) || data.version !== FILE_VERSION) {
            S.kernel.warn('adventures', 'run state file has version', isPlainObject(data) ? data.version : '?',
                ', expected', FILE_VERSION, '; starting empty');
            return false;
        }
        var n = normRun(data.run);
        rs.request = normRequest(data.request);
        rs.run = n.run;
        resetMemory(rs);
        if (n.repaired.length) {
            S.kernel.warn('adventures', 'run state repaired on load:', n.repaired.join('; '));
            save();
        }
        if (rs.run) S.kernel.log('adventures', 'run state loaded:', status());
        refresh();
        return true;
    }

    // ---- Transitions ------------------------------------------------------

    // The only writer of run.step. A new step starts with no action round
    // unless opts.keepRounds carries the round over (Load -> Verify, and
    // Attack -> Confirm, which reads the round's results). Going to the same
    // step re-enters it with fresh rounds and a fresh start time. Every step
    // change drops the waiting deadline; a waiting step sets its own.
    function go(step, why, opts) {
        var rs = current();
        var r = rs.run;
        if (!r) return false;
        if (!isStep(step)) {
            S.kernel.warn('adventures', 'not a run step:', step);
            return false;
        }
        var from = r.step;
        // Leaving a wave keeps the wave in the log line (wave 3/3: Confirm ->
        // Clear); otherwise the line names where the run now is.
        var where = isWaveStep(from) ? labelOf(from) : labelOf(step);
        r.step = step;
        r.since = clock();
        r.waitUntil = null;
        if (!(opts && opts.keepRounds)) {
            r.rounds = 0;
            rs.round = null;
        }
        r.settled = 0;
        // Gate re-reads the wave file, so an edit made during a pause is seen.
        if (step === S.WaveStep.Gate) rs.cache = null;
        S.kernel.log('adventures', where + ': ' + stepName(from) + ' -> ' +
            stepName(step) + (why ? ' (' + why + ')' : ''));
        save();
        refresh();
        return true;
    }

    // info: { general, target }, both optional. Dropping the round makes any
    // callback still in flight a no-op.
    function pause(reason, message, info) {
        var rs = current();
        var r = rs.run;
        if (!r) return false;
        info = info || {};
        r.status = S.RunStatus.Paused;
        r.pause = {
            reason:  reason,
            message: str(message),
            step:    r.step,
            wave:    r.waveIndex + 1,
            general: scalar(info.general),
            target:  scalar(info.target),
            at:      clock()
        };
        rs.round = null;
        var who = '';
        if (r.pause.general !== null) who += ' general ' + r.pause.general;
        if (r.pause.target !== null) who += ' target ' + r.pause.target;
        S.kernel.warn('adventures', 'run paused at ' + label() + ' (' + stepName(r.step) + '): ' +
            nameOf(S.RunPause, reason) + ': ' + r.pause.message + who);
        save();
        notify('Adventure run paused at ' + label() + ' (' + stepName(r.step) + '): ' + r.pause.message);
        refresh();
        return true;
    }

    // Clears sentAt of every unseen record of a lines or marks map and
    // returns their names. sentOnce stays: it records that a packet went out
    // at some time, so a camp that is gone after the resume can be counted as
    // beaten by that attack instead of unreachable.
    function clearUnseen(recs) {
        var cleared = [];
        if (!isPlainObject(recs)) return cleared;
        for (var k in recs) {
            if (!has(recs, k) || !isPlainObject(recs[k])) continue;
            if (!recs[k].seen && recs[k].sentAt !== null && recs[k].sentAt !== undefined) {
                recs[k].sentAt = null;
                cleared.push(k);
            }
        }
        return cleared;
    }

    // The user has looked at the game: a line or order that was sent but
    // never seen may be sent again. A wave step restarts its wave at Gate;
    // a series step is entered again with fresh rounds.
    function resume() {
        var rs = current();
        var r = rs.run;
        if (!r || r.status !== S.RunStatus.Paused) return false;
        var lines = clearUnseen(r.lines);
        var marks = clearUnseen(r.marks);
        if (lines.length) {
            S.kernel.log('adventures', 'resume: sent marker cleared for unseen lines', lines.join(', '));
        }
        if (marks.length) {
            S.kernel.log('adventures', 'resume: sent marker cleared for unseen orders', marks.join(', '));
        }
        r.pause = null;
        r.blocker = null;
        r.settleFrom = null;
        r.cycles = 0;
        r.status = S.RunStatus.Running;
        if (isWaveStep(r.step)) return go(S.WaveStep.Gate, 'resumed');
        return go(r.step, 'resumed');
    }

    function clear() {
        var rs = current();
        rs.request = null;
        rs.run = null;
        resetMemory(rs);
        save();
        refresh();
        return true;
    }

    // Stores a new request and run (run may be null for a request only) and
    // persists both.
    function begin(request, r) {
        var rs = current();
        rs.request = request;
        rs.run = r;
        resetMemory(rs);
        save();
        refresh();
        return true;
    }

    // The queue was dropped without a run change (a script reload resets the
    // queue; a cancelled replace cancels the queued entries). A round whose
    // attempt was in the queue would then wait for a result that never comes,
    // so the next step starts a fresh round from the observed game.
    function dropRound(why) {
        var rs = current();
        if (rs.round === null || rs.round === undefined) {
            rs.round = null;
            return false;
        }
        rs.round = null;
        S.kernel.log('adventures', 'action round dropped' + (why ? ' (' + why + ')' : ''));
        return true;
    }

    // The series is done: every requested run has finished.
    function done() {
        var rs = current();
        var r = rs.run;
        if (!r) return false;
        r.status = S.RunStatus.Done;
        r.pause = null;
        rs.round = null;
        rs.cache = null;
        S.kernel.log('adventures', 'series done: ' + r.label + ' (' + finishedRuns() + ' run(s))');
        save();
        notify('Adventure series done: ' + r.label + '.');
        refresh();
        return true;
    }

    // A script reload always resets the queue, while the module namespace and
    // its runState survive; the round of the old bundle refers to attempts
    // that no longer exist.
    current().round = null;

    S.modules.adventures.state = {
        FILE_VERSION:  FILE_VERSION,
        current:       current,
        run:           run,
        load:          load,
        newRun:        newRun,
        begin:         begin,
        save:          save,
        go:            go,
        pause:         pause,
        resume:        resume,
        clear:         clear,
        dropRound:     dropRound,
        done:          done,
        now:           now,
        nameOf:        nameOf,
        status:        status,
        finishedRuns:  finishedRuns,
        requestedRuns: requestedRuns,
        waveLabel:     waveLabel,
        label:         label,
        stepName:      stepName,
        isStep:        isStep,
        isWaveStep:    isWaveStep,
        partOf:        partOf,
        readyOn:       readyOn
    };

}(Steward));
