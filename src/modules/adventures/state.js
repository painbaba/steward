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
 * steps: S.RunStep is filled from it, and which part runs a step, on which
 * zone it may run (partOf, readyOn), how the steps fold into the rows of the
 * run menu (stepRows) and which steps wait long (waitsLong) are read from it,
 * so no second list of steps exists to drift from it. Wave steps always run on
 * the run's island.
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
 * time a failed claim may be retried), homeNote (the last wait the home
 * steps logged, so a repeated wait is logged once), quiet (the quiet clock of
 * this step: { since, last, ms }), missing (general key -> { since, last } of
 * the reads that lacked it), busy (the busy wait of this run and step: { runId,
 * step, key, text, since, noted, read }, read marking a wait kept alive by a bad
 * read), busySeen (whether this pass kept that wait going), stuckClock (the
 * watched-wait clock of the zone trip, in the shape of quiet), pickupClock
 * (the clock of the wait for map objects, in the shape of quiet plus count,
 * the number of objects last seen, so a pick-up restarts it), zoneWait
 * (whether the "waiting for zone" line was logged) and deployProbe (run id
 * and key of the star-menu probe lines already logged). They describe callbacks and reads of this client session, which do not
 * exist after a restart.
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
 * defaults (no snapshot, no marks, no runs finished). A retrain key in a
 * run file is ignored: whether a run retrains is the module setting, read
 * when the run reaches the steps that count and order troops.
 *
 * Resume re-enters the paused step with fresh rounds and a fresh start time,
 * after the user has looked at the game. A wave step restarts its wave at
 * Gate instead, which re-reads the wave file. Unseen send markers (wave
 * lines and series marks) are cleared, so an order that never showed in the
 * game may be sent again.
 *
 * A step on the island whose wait does not end may take a zone trip: home
 * and back, after which the step is entered again. run.resolve holds the
 * trip in progress and run.stuck the trips taken at one stuck position; both
 * are persisted, so a trip goes on after a client restart. A step change ends
 * the trip, and Resume clears both, because the user has looked.
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

    // The options a template can switch off, as named in the table below.
    var OPT_HORSESHOE = 'horseshoe';
    var OPT_RETRAIN = 'retrain';

    // The waves are no series steps: they run between this row and the next
    // one and show as one group of their own.
    var WAVES_GROUP = 'Waves';
    var WAVES_AFTER = 'Horseshoe';

    // The series steps in run order: [key, value, where, group, row, option,
    // long]. The one table: S.RunStep, partOf(), readyOn(), the menu rows of
    // stepRows() and waitsLong() are all read from it. Steps next to each other
    // with the same group and row fold into one menu row; option names what
    // switches the row off. long marks a step that waits minutes for the game,
    // where the 10 s tick looks often enough and a faster pass only adds reads.
    var RUN_STEPS = [
        ['Muster',     'RunMuster',     HOME,      'Home',       'Check generals and files',   '', true],
        ['Validate',   'RunValidate',   HOME,      'Home',       'Check generals and files',   ''],
        ['Deploy',     'RunDeploy',     HOME,      'Home',       'Load generals',              ''],
        ['Snapshot',   'RunSnapshot',   HOME,      'Home',       'Load generals',              ''],
        ['Supply',     'RunSupply',     HOME,      'Home',       'Load generals',              ''],
        ['Unload',     'RunUnload',     HOME,      'Home',       'Load generals',              ''],
        ['Load',       'RunLoad',       HOME,      'Home',       'Load generals',              ''],
        ['Verify',     'RunVerify',     HOME,      'Home',       'Load generals',              ''],
        ['StartMap',   'RunStartMap',   HOME,      'Home',       'Start map',                  ''],
        ['Depart',     'RunDepart',     HOME,      'Home',       'Send generals',              ''],
        ['Jump',       'RunJump',       ANY,       'Travel',     'Jump to the map',            ''],
        ['Arrive',     'RunArrive',     ADVENTURE, 'Travel',     'Wait for all generals',      '', true],
        ['Pickups',    'RunPickups',    ADVENTURE, 'Travel',     'Pick up items',              ''],
        ['StarAll',    'RunStarAll',    ADVENTURE, 'Travel',     'Send all to the star',       ''],
        ['Horseshoe',  'RunHorseshoe',  ADVENTURE, 'Travel',     'Horseshoe',                  OPT_HORSESHOE],
        ['PackStar',   'RunPackStar',   ADVENTURE, 'End of map', 'Place carriers',             ''],
        ['Pack',       'RunPack',       ADVENTURE, 'End of map', 'Pack leftover troops',       ''],
        ['Clear',      'RunClear',      ADVENTURE, 'End of map', 'Wait for last quest',        '', true],
        ['LastQuest',  'RunLastQuest',  ANY,       'End of map', 'Claim last quest and close', ''],
        ['Close',      'RunClose',      ANY,       'End of map', 'Claim last quest and close', ''],
        ['Recall',     'RunRecall',     ANY,       'Back home',  'Return home',                ''],
        ['JumpHome',   'RunJumpHome',   ANY,       'Back home',  'Return home',                ''],
        ['ArriveHome', 'RunArriveHome', HOME,      'Back home',  'Return home',                '', true],
        ['Account',    'RunAccount',    HOME,      'Back home',  'Count lost troops',          OPT_RETRAIN],
        ['Population', 'RunPopulation', HOME,      'Back home',  'Retrain',                    OPT_RETRAIN],
        ['Retrain',    'RunRetrain',    HOME,      'Back home',  'Retrain',                    OPT_RETRAIN],
        ['Next',       'RunNext',       HOME,      'Back home',  'Next map',                   '']
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
    S.RunPause.Stuck             = 'PauseStuck';

    // The phases of the zone trip, persisted in run.json as run.resolve.phase.
    var ResolvePhase = { Home: 'home', Wait: 'wait', Back: 'back' };

    var FILE_VERSION = 1;
    var SUBDIR = 'adventures';
    var FILE_NAME = 'run.json';

    // A busy general usually ends soon, so the first minute of a wait polls;
    // after that the tick looks often enough.
    var BUSY_FAST_MS = 60000;

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

    // The table index of a series step, or -1 for anything else.
    function stepIndex(step) {
        for (var i = 0; i < RUN_STEPS.length; i++) {
            if (RUN_STEPS[i][1] === step) return i;
        }
        return -1;
    }

    // The where of a series step, or 0 for anything else.
    function whereOf(step) {
        var i = stepIndex(step);
        return i < 0 ? 0 : RUN_STEPS[i][2];
    }

    // Whether the step is flagged long in RUN_STEPS (its long column).
    function isLongStep(step) {
        var i = stepIndex(step);
        return i >= 0 && RUN_STEPS[i][6] === true;
    }

    // The busy record of the run's current step, or null: a record left by
    // another run or step is no wait of this one.
    function busyOf(r) {
        var b = current().busy;
        return b && r && b.runId === r.id && b.step === r.step ? b : null;
    }

    // Whether the run waits for something that takes minutes, so the tick is
    // enough to see it end. A blocker covers Settle and the wait for production
    // at home, which are no long steps by themselves, and so does a busy
    // general once his wait has outlasted BUSY_FAST_MS on any step. The busy
    // record may be absent after a script reload.
    function waitsLong(r) {
        if (r.blocker) return true;
        var b = busyOf(r);
        if (b && clock() - b.since >= BUSY_FAST_MS) return true;
        return isLongStep(r.step);
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

    // Whether the step may take a zone trip when its wait does not end: the
    // wave steps and the short island steps. The long steps wait for the game
    // on purpose (the travel to the map, the last quest), so a long watched
    // wait is no sign of a stale read there; home and any-zone steps are not
    // on the island.
    function tripAllowed(step) {
        if (isWaveStep(step)) return true;
        return whereOf(step) === ADVENTURE && !isLongStep(step);
    }

    // Whether the trip count in r.stuck belongs to the stuck position of step:
    // the same wave, and the same series step (every wave step shares one
    // position, so a wave that loops Gate -> Supply keeps its count).
    function sameStuck(r, step) {
        return !!(r && r.stuck) && r.stuck.wave === r.waveIndex &&
            position(r.stuck.step) === position(step);
    }

    // The viewed zone in the shape of the scheduler context, or null while
    // the game cannot be read (not loaded yet).
    function viewedZone() {
        try {
            return { id: S.core.zone.id(), isHome: S.core.zone.isHome(), isAdventure: S.core.zone.isAdventure() };
        } catch (e) {
            return null;
        }
    }

    // Whether the run's step may run on the zone the scheduler saw
    // ({ id, isHome, isAdventure }); a null zone reads the core. A wave step
    // runs on the run's island like an ADVENTURE step, which needs the island
    // loaded as an adventure too: the id alone is set before the island is
    // there. An unknown step runs nowhere.
    function readyOn(r, zone) {
        if (!r) return false;
        // The zone trip travels on purpose, and the step's part is not called
        // while it lasts, so every zone is right for it.
        if (r.resolve) return true;
        var z = zone === null || zone === undefined ? viewedZone() : zone;
        if (!z) return false;
        var w = isWaveStep(r.step) ? ADVENTURE : whereOf(r.step);
        if (w === ANY) return true;
        if (w === HOME) {
            if (typeof z.isHome === 'boolean') return z.isHome;
            var h = viewedZone();
            return !!(h && h.isHome === true);
        }
        if (w === ADVENTURE) {
            if (typeof r.zoneId !== 'number' || z.id !== r.zoneId) return false;
            if (typeof z.isAdventure === 'boolean') return z.isAdventure;
            var v = viewedZone();
            return !!(v && v.isAdventure === true);
        }
        return false;
    }

    // What the user must do so a Running run gets its passes again, or '' when
    // the viewed zone is the right one. Passes stop on a wrong zone, so no step
    // can say this itself. A wave step runs on the island, like an ADVENTURE
    // step. The game may not be loaded when the menu opens.
    function viewHint(r) {
        if (!r || r.status !== S.RunStatus.Running) return '';
        var zone = viewedZone();
        if (!zone || readyOn(r, zone)) return '';
        return !isWaveStep(r.step) && whereOf(r.step) === HOME ? 'go home' : 'view the island';
    }

    function stepName(step) {
        return nameOf(isWaveStep(step) ? S.WaveStep : S.RunStep, step);
    }

    // Where a step lies in run order, comparable across both step kinds: the
    // table index, and for every wave step the point just after WAVES_AFTER.
    // -1 for a value that is no step.
    function position(step) {
        if (isWaveStep(step)) return stepIndex(S.RunStep[WAVES_AFTER]) + 0.5;
        return stepIndex(step);
    }

    // The menu rows in run order: { group, label, option, first, last, waves },
    // where first and last are the positions the row covers. waves marks the
    // one row that stands for all wave steps.
    function stepRows() {
        var rows = [];
        for (var i = 0; i < RUN_STEPS.length; i++) {
            var step = RUN_STEPS[i];
            var prev = rows.length ? rows[rows.length - 1] : null;
            if (prev && prev.group === step[3] && prev.label === step[4]) {
                prev.last = i;
            } else {
                rows.push({ group: step[3], label: step[4], option: step[5], first: i, last: i, waves: false });
            }
            if (step[0] === WAVES_AFTER) {
                var p = position(S.WaveStep.Gate);
                rows.push({ group: WAVES_GROUP, label: '', option: '', first: p, last: p, waves: true });
            }
        }
        return rows;
    }

    // Whether this run skips the stage of an option. Retraining follows the
    // module setting, read now so a change shows at once; a bundle without
    // the settings reader reads as off. A run started on an open map took no
    // snapshot once it is past that step, so it retrains nothing.
    function optionOff(r, option) {
        if (option === OPT_HORSESHOE) return r.speedBuff === S.SpeedBuffChoice.None;
        if (option === OPT_RETRAIN) {
            var a = S.modules.adventures;
            return !(a.retrainOn && a.retrainOn()) ||
                (!r.snapshot && position(r.step) > position(S.RunStep.Snapshot));
        }
        return false;
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

    // The run menu's row set follows the run. Late-bound: state.js is the
    // store and the menu view sits on top of it.
    function syncMenu() {
        var m = S.modules.adventures.runmenu;
        if (m && m.sync) m.sync();
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

    // The run and its place in the series, shared by both status texts.
    function runPart(r) {
        return r.label + ', run ' + (finishedRuns() + 1) + '/' + requestedRuns();
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
        if (r.status === S.RunStatus.Done) {
            if (r.stopReason) return 'Stopped: ' + r.label + ', ' + finishedRuns() + ' run(s): ' + r.stopReason;
            return 'Done: ' + r.label + ', ' + finishedRuns() + ' run(s)';
        }
        var where = runPart(r) + ', ' + (isWaveStep(r.step) ? waveLabel() + ', ' : '') + stepName(r.step);
        if (r.status === S.RunStatus.Paused) {
            return 'Paused: ' + where + ': ' + (r.pause ? r.pause.message : '');
        }
        return 'Running: ' + where + (r.resolve ? ' (zone trip: ' + r.resolve.phase + ')' : '');
    }

    // The short head of the run menu: the rows below it carry the step and
    // the status line the pause reason.
    function title() {
        var rs = current();
        var r = rs.run;
        if (!r && !rs.request) return 'No run';
        if (!r || r.status === S.RunStatus.Done) return status();
        return (r.status === S.RunStatus.Paused ? 'Paused: ' : 'Running: ') + runPart(r);
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

    // A grid per loadout key: own keys with finite grids > 0 are kept, so a
    // grid that was never a placed one cannot be sent as a target.
    function normGrids(v) {
        var out = {};
        if (!isPlainObject(v)) return out;
        for (var k in v) {
            if (has(v, k) && typeof v[k] === 'number' && isFinite(v[k]) && v[k] > 0) out[k] = v[k];
        }
        return out;
    }

    // The travelling troops: entries with a run id, an end time and a troop
    // map are kept; anything else cannot be counted and is dropped.
    function normTransit(v) {
        var out = [];
        if (!isArray(v)) return out;
        for (var i = 0; i < v.length; i++) {
            var e = v[i];
            if (!isPlainObject(e) || num(e.from) === null || num(e.until) === null) continue;
            var army = normArmy(e.army);
            if (army === null) continue;
            out.push({ from: e.from, army: army, until: e.until });
        }
        return out;
    }

    // round, cache, questRetry and the read windows belong to the run they
    // were built for; a new request, a new run or a loaded file starts
    // without them.
    function resetMemory(rs) {
        rs.round = null;
        rs.cache = null;
        rs.questRetry = {};
        rs.homeNote = null;
        rs.quiet = null;
        rs.missing = {};
        rs.busy = null;
        rs.busySeen = false;
        rs.stuckClock = null;
        rs.pickupClock = null;
        rs.zoneWait = false;
        rs.deployProbe = {};
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
    // next pass can tell whether the buff took effect. settledAt is when the
    // island was first seen quiet in an unbroken row of passes while Settle
    // holds (null: not quiet). resolve is the zone trip in progress ({ phase,
    // at }, at being when home was loaded; null: none). stuck counts the zone
    // trips taken at one stuck position ({ step, wave, trips }; null: none).
    // homeGrids maps a loadout key to the home grid he was last seen on, so
    // Deploy can place him back from the star menu ({}: none known).
    // transit is the free troops left on earlier islands that travel home by
    // themselves, { from, army, until } each (from: the id of the run that
    // left them), counted as owned until until or until they are seen
    // landing. transitBase is the home count (free pool, generals and queue)
    // per travelling unit at the last read where only a landing could raise
    // it (null: no valid read). stopReason is the reason the series was
    // stopped (null: not stopped).
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
            settledAt:   null,
            blocker:     null,
            donors:      [],
            lines:       {},
            snapshot:    null,
            marks:       {},
            waitUntil:   null,
            popBase:     null,
            resolve:     null,
            stuck:       null,
            homeGrids:   normGrids(s.homeGrids),
            transit:     normTransit(s.transit),
            transitBase: isPlainObject(s.transitBase) ? normArmy(s.transitBase) : null,
            stopReason:  null,
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

    // A zone trip with a phase the code does not know cannot be continued, so
    // it is dropped and the step simply runs again.
    function normResolve(v) {
        if (!isPlainObject(v) || !isValue(ResolvePhase, v.phase)) return null;
        return { phase: v.phase, at: num(v.at) };
    }

    function normStuck(v) {
        if (!isPlainObject(v) || !isStep(v.step)) return null;
        return { step: v.step, wave: count(v.wave), trips: count(v.trips) };
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
        r.settledAt  = num(v.settledAt);
        r.blocker    = normBlocker(v.blocker);
        r.donors     = strings(v.donors);
        r.lines      = normLines(v.lines);
        r.snapshot   = normArmy(v.snapshot);
        r.marks      = normLines(v.marks);
        r.waitUntil  = num(v.waitUntil);
        r.popBase    = num(v.popBase);
        r.resolve    = normResolve(v.resolve);
        r.stuck      = normStuck(v.stuck);
        r.homeGrids  = normGrids(v.homeGrids);
        r.transit    = normTransit(v.transit);
        r.transitBase = isPlainObject(v.transitBase) ? normArmy(v.transitBase) : null;
        r.stopReason = typeof v.stopReason === 'string' && v.stopReason ? v.stopReason : null;
        r.pause      = normPause(v.pause);
        for (k in facts) {
            if (has(facts, k)) r[k] = facts[k];
        }
        if (!isStep(r.step)) {
            repaired.push('unknown step ' + String(r.step) + ' -> Gate');
            r.step = S.WaveStep.Gate;
        }
        // A finished run takes no trip; only a running or paused one goes on.
        if (r.resolve && r.status !== S.RunStatus.Running && r.status !== S.RunStatus.Paused) r.resolve = null;
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
    // change drops the waiting deadline and the busy wait; a waiting step sets
    // its own. A step change also ends any zone trip, while the trip count
    // lasts as long as the run stays at the same wave or series step.
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
        // PackStar); otherwise the line names where the run now is.
        var where = isWaveStep(from) ? labelOf(from) : labelOf(step);
        r.step = step;
        r.resolve = null;
        if (r.stuck && !sameStuck(r, step)) r.stuck = null;
        r.since = clock();
        r.waitUntil = null;
        rs.busy = null;
        if (!(opts && opts.keepRounds)) {
            r.rounds = 0;
            rs.round = null;
        }
        r.settledAt = null;
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
        rs.busy = null;
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

    // Enters the current step again: a wave step restarts its wave at Gate, a
    // series step starts over with fresh rounds. The Settle blocker and the
    // settle cycle count belong to the left attempt, so they go too; otherwise
    // a stale blocker keeps every later short wait on the fast poll.
    function reenter(why) {
        var r = current().run;
        if (!r) return false;
        r.blocker = null;
        r.settleFrom = null;
        r.cycles = 0;
        return go(isWaveStep(r.step) ? S.WaveStep.Gate : r.step, why);
    }

    // The user has looked at the game: a line or order that was sent but
    // never seen may be sent again. The step itself is entered again through
    // reenter(); resume adds the reset of the unseen send markers.
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
        // The user looked, so a trip in progress and the trips counted so far
        // are no longer needed: the step starts over as if new.
        r.resolve = null;
        r.stuck = null;
        r.status = S.RunStatus.Running;
        return reenter('resumed');
    }

    function clear() {
        var rs = current();
        rs.request = null;
        rs.run = null;
        resetMemory(rs);
        save();
        refresh();
        syncMenu();
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
        syncMenu();
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

    // module.js brackets each step pass with these two: a pass that did not
    // keep the busy wait going ended it, whatever the reason.
    function passBegins() {
        current().busySeen = false;
    }

    function passEnds() {
        var rs = current();
        if (!rs.busySeen) rs.busy = null;
    }

    // Ends the series: the run stays as Done, so Resume refuses it and Stop
    // run clears it.
    function finish(r, rs) {
        r.status = S.RunStatus.Done;
        r.pause = null;
        rs.round = null;
        rs.cache = null;
        save();
        refresh();
        // This runs inside plan(), which may not rebuild a menu. A hide only moves
        // the item out of the bar, so no rebuild comes from the tick.
        syncMenu();
    }

    // The series is done: every requested run has finished.
    function done() {
        var rs = current();
        var r = rs.run;
        if (!r) return false;
        S.kernel.log('adventures', 'series done: ' + r.label + ' (' + finishedRuns() + ' run(s))');
        finish(r, rs);
        notify('Adventure series done: ' + r.label + '.');
        return true;
    }

    // The series cannot go on: a later run would start short of troops. It
    // ends as Done with the reason kept, so the menu and the status line say
    // why and what to change before the next start. The step is named before
    // the run ends, while it still says where the run stood.
    function stop(message) {
        var rs = current();
        var r = rs.run;
        if (!r) return false;
        var lbl = label();
        var why = str(message);
        r.stopReason = why;
        finish(r, rs);
        S.kernel.warn('adventures', 'series stopped at ' + lbl + ' after ' + finishedRuns() + ' run(s): ' + why);
        notify('Adventure series stopped: ' + why);
        return true;
    }

    // ---- Travelling troops --------------------------------------------------

    // The live entries still on the way: not past their end time and not
    // empty, on the clock of the run.
    function pendingEntries(r) {
        var out = [];
        var list = r && isArray(r.transit) ? r.transit : [];
        var t = clock();
        for (var i = 0; i < list.length; i++) {
            var e = list[i];
            if (e && e.until > t && S.core.army.total(e.army) > 0) out.push(e);
        }
        return out;
    }

    // The troops on the way home: { army, entries }, with copies of the
    // pending entries and their sum, so a caller cannot change the record.
    function transit(r) {
        var live = pendingEntries(r);
        var entries = [];
        var army = {};
        for (var i = 0; i < live.length; i++) {
            entries.push({ from: live[i].from, army: S.core.army.add(live[i].army), until: live[i].until });
            army = S.core.army.add(army, live[i].army);
        }
        return { army: army, entries: entries };
    }

    // Records what one run left on its island. A repeated exit of the same
    // run replaces its entry, so the same troops are never counted twice.
    // No save: the caller's step change saves.
    function noteTransit(r, army, until) {
        if (!r) return false;
        var kept = [];
        var list = isArray(r.transit) ? r.transit : [];
        for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].from !== r.id) kept.push(list[i]);
        }
        if (S.core.army.total(army) > 0) kept.push({ from: r.id, army: S.core.army.add(army), until: until });
        r.transit = kept;
        return true;
    }

    function byUntil(a, b) {
        return a.until - b.until;
    }

    // Retires travelling troops seen at home. owned is the home count
    // ({ unit: n }: free pool, generals and queue) of each travelling unit.
    // A rise against transitBase, the count of the last read where only a
    // landing could raise it, is taken as landed troops, up to what is
    // pending, and comes off the entries that end first. The base rises by
    // the same amount, so a second call with the same count lands nothing,
    // and a reload between the change and its save stays consistent because
    // entries and base are written together. The live entries are changed,
    // not the copies transit() hands out. Returns the landed map ({}: none).
    // No save: the caller's step change saves.
    function landTransit(r, owned) {
        var landed = {};
        if (!r) return landed;
        var have = isPlainObject(owned) ? owned : {};
        var pend = transit(r).army;
        var units = [];
        var u;
        for (u in pend) {
            if (has(pend, u)) units.push(u);
        }
        if (!units.length) {
            r.transitBase = null;
            return landed;
        }
        units.sort();
        var i;
        if (!isPlainObject(r.transitBase)) {
            var first = {};
            for (i = 0; i < units.length; i++) {
                if (num(have[units[i]]) !== null) first[units[i]] = have[units[i]];
            }
            r.transitBase = first;
            return landed;
        }
        var base = r.transitBase;
        var live = pendingEntries(r).sort(byUntil);
        for (i = 0; i < units.length; i++) {
            u = units[i];
            if (num(have[u]) === null) continue;
            if (num(base[u]) === null) {
                base[u] = have[u];
                continue;
            }
            var rise = have[u] - base[u];
            if (rise <= 0) continue;
            var land = Math.min(rise, pend[u]);
            var left = land;
            for (var j = 0; j < live.length && left > 0; j++) {
                var n = live[j].army[u];
                if (!(n > 0)) continue;
                var take = Math.min(left, n);
                if (n - take > 0) live[j].army[u] = n - take;
                else delete live[j].army[u];
                left -= take;
            }
            base[u] += land;
            landed[u] = land;
        }
        var kept = [];
        for (i = 0; i < r.transit.length; i++) {
            if (S.core.army.total(r.transit[i].army) > 0) kept.push(r.transit[i]);
        }
        r.transit = kept;
        return landed;
    }

    // A script reload always resets the queue, while the module namespace and
    // its runState survive; the round of the old bundle refers to attempts
    // that no longer exist.
    current().round = null;

    S.modules.adventures.state = {
        FILE_VERSION:  FILE_VERSION,
        BUSY_FAST_MS:  BUSY_FAST_MS,
        current:       current,
        run:           run,
        load:          load,
        newRun:        newRun,
        begin:         begin,
        save:          save,
        go:            go,
        pause:         pause,
        resume:        resume,
        reenter:       reenter,
        ResolvePhase:  ResolvePhase,
        tripAllowed:   tripAllowed,
        sameStuck:     sameStuck,
        clear:         clear,
        dropRound:     dropRound,
        passBegins:    passBegins,
        passEnds:      passEnds,
        done:          done,
        stop:          stop,
        transit:       transit,
        noteTransit:   noteTransit,
        landTransit:   landTransit,
        now:           now,
        nameOf:        nameOf,
        status:        status,
        title:         title,
        finishedRuns:  finishedRuns,
        requestedRuns: requestedRuns,
        waveLabel:     waveLabel,
        label:         label,
        stepName:      stepName,
        position:      position,
        stepRows:      stepRows,
        optionOff:     optionOff,
        isStep:        isStep,
        isWaveStep:    isWaveStep,
        partOf:        partOf,
        readyOn:       readyOn,
        viewHint:      viewHint,
        waitsLong:     waitsLong,
        busyOf:        busyOf
    };

}(Steward));
