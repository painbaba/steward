/*
 * User commands of an adventure run: start, pause, resume, stop and end
 * repetition, chosen from the ~Steward~ > Adventures menu.
 *
 * Start asks for the run count, prefilled with the maps available (star-menu
 * maps plus one when an own adventure of that map is already open). What
 * happens next depends on where the user is:
 * - the template's map is open and viewed: a second prompt asks for the
 *   start wave (default 1), the executor checks the loadout and wave files
 *   against the island, and the run starts at Gate of that wave. There is
 *   no troop snapshot, so the first return home retrains nothing.
 * - at home: the files and the loadout keys are checked without the
 *   fighters, because the generals may still be away, and the run starts by
 *   mustering them. The map is started by the run when it is not open yet.
 * - anywhere else: nothing is stored; the user goes home or views the
 *   island and chooses the template again.
 * A fatal check problem stores nothing. End repetition lets the series stop
 * after the current run.
 *
 * Menu handlers only change state. They never enqueue: an entry added from
 * a menu callback carries no module tag, so cancelByModule could not remove
 * it. The scheduler's plan() enqueues every step. Pause, Stop and replacing
 * a run cancel the module's queued entries so nothing acts after the user
 * said stop. A wake enqueues nothing, so Start and Resume may ask for one:
 * the next plan() then comes right away instead of on the tick.
 *
 * The request and the run live on S.modules.adventures.runState and are
 * written to the run state file through S.modules.adventures.state, so both
 * survive a script reload and a client restart. They stay out of the
 * settings and the template file: they describe what to do now, not how a
 * template is configured. There is one request and one run at a time;
 * starting another asks before replacing them.
 *
 * Request shape: { templateId, label, adventure, count, ended, requested,
 * finished, closedAt }: finished counts the runs done in this series and
 * closedAt is when the last map was closed.
 */

(function (S) {

    if (!S.modules.adventures) S.modules.adventures = {};
    if (!S.modules.adventures.runState) S.modules.adventures.runState = { request: null, run: null };

    var MODULE_ID = 'adventures';

    // The run state store, read at call time: it loads after this file and a
    // script reload may replace it.
    function store() {
        return S.modules.adventures.state;
    }

    function current() {
        return store().current().request;
    }

    function statusText(req) {
        if (!req) return 'No run requested';
        return 'Requested: ' + req.label + ' ×' + req.count + (req.ended ? ', repetition ended' : '');
    }

    function trim(v) {
        return String(v).replace(/^\s+|\s+$/g, '');
    }

    // Turns a prompt answer into a run count. Cancel stores nothing, unlike
    // autoTSO, which treats a cancelled prompt as one run.
    function countFrom(answer, maps) {
        if (answer === null || answer === undefined) return { ok: false, reason: 'cancel' };
        var n = parseInt(trim(answer), 10);
        if (isNaN(n) || n < 1) return { ok: false, reason: 'invalid' };
        return { ok: true, count: Math.min(n, maps) };
    }

    // Turns a prompt answer into a 1-based start wave. Unlike the count it is
    // never clamped: starting at a wave the user did not name could skip a
    // wave or send one twice.
    function waveFrom(answer, waves) {
        if (answer === null || answer === undefined) return { ok: false, reason: 'cancel' };
        var s = trim(answer);
        if (!/^[0-9]+$/.test(s)) return { ok: false, reason: 'invalid' };
        var n = parseInt(s, 10);
        if (n < 1 || n > waves) return { ok: false, reason: 'invalid' };
        return { ok: true, wave: n };
    }

    // Maps of `adventure` the player can run: star-menu stock plus one for an
    // own adventure already open. `pass` caches both reads, so a menu pass that
    // asks for every template reads the star menu and the open adventures once.
    function available(adventure, pass) {
        pass = pass || {};
        if (!pass.maps) pass.maps = S.core.buffs.mapCounts();
        if (!pass.open) pass.open = S.core.adventures.ownOpen();
        return (pass.maps[adventure] || 0) + (pass.open.indexOf(adventure) !== -1 ? 1 : 0);
    }

    // prompt/confirm are host globals; resolved at call time because they are
    // not guaranteed to exist when this file loads.
    function ask(text, def) {
        if (typeof prompt === 'function') return prompt(text, def);
        S.kernel.warn('adventures', 'prompt() is not available; nothing asked');
        return null;
    }

    function agree(text) {
        return typeof confirm === 'function' && confirm(text) === true;
    }

    function notify(text) {
        if (S.kernel.ui && S.kernel.ui.notify) S.kernel.ui.notify(text);
    }

    // Rewrites the menu status line in place; no menu rebuild.
    function refresh() {
        if (S.kernel.ui && S.kernel.ui.status && S.kernel.ui.status.refresh) S.kernel.ui.status.refresh();
    }

    // The first pass of a started or resumed run, sooner than the tick.
    function wakeRun() {
        S.kernel.scheduler.wake(MODULE_ID, 0);
    }

    // Drops this module's queued entries: action attempts and the attack pacer.
    function cancelQueued() {
        if (S.kernel.queue && S.kernel.queue.cancelByModule) S.kernel.queue.cancelByModule(MODULE_ID);
    }

    // Problems may be battle file problem records or plain strings.
    function messageOf(p) {
        if (p && typeof p === 'object') return String(p.message);
        return String(p);
    }

    function listOf(v) {
        return v && typeof v.length === 'number' ? v : [];
    }

    // Text of the replace question: the request, plus where the run stands.
    function replaceQuestion(rs) {
        var r = rs.run;
        var q = rs.request;
        var what = q ? '"' + q.label + '" ×' + q.count : '"' + r.label + '"';
        if (r) what += ' (' + store().label() + ', ' + store().nameOf(S.RunStatus, r.status) + ')';
        return 'Replace the requested run ' + what + '?';
    }

    function makeRequest(rec, count) {
        return {
            templateId: rec.id,
            label:      rec.label,
            adventure:  rec.adventure,
            count:      count,
            ended:      false,
            requested:  store().now(),
            finished:   0,
            closedAt:   null
        };
    }

    function checkFailed(rec, problems) {
        var first = [];
        for (var i = 0; i < problems.length; i++) {
            S.kernel.warn('adventures', 'start check "' + rec.label + '" failed:', messageOf(problems[i]));
            if (i < 3) first.push(messageOf(problems[i]));
        }
        notify('"' + rec.label + '" cannot start: ' + problems.length + ' problem(s). ' + first.join('; '));
        return false;
    }

    // Runs the executor's start check and logs its warnings; null when the
    // executor is not loaded or the specialist list lost entries, whose
    // generals would read as problems of the template (the user has been
    // told either way).
    function startCheck(rec, opts) {
        var executor = S.modules.adventures.executor;
        if (!executor || !executor.check) {
            notify('The wave executor is not loaded; nothing started.');
            return null;
        }
        var chk = executor.check(rec, opts) || {};
        if (chk.listOk === false) {
            notify('The specialist list cannot be read right now; try again in a moment.');
            return null;
        }
        var warnings = listOf(chk.warnings);
        for (var i = 0; i < warnings.length; i++) {
            S.kernel.warn('adventures', 'start check "' + rec.label + '":', messageOf(warnings[i]));
        }
        chk.warnings = warnings;
        return chk;
    }

    // A new run of the template, checked as chk. Without a step the store
    // starts the run at Gate of the given wave.
    function runFromTemplate(rec, chk, zoneId, waveIndex, step) {
        return store().newRun({
            id:          store().now(),
            templateId:  rec.id,
            label:       rec.label,
            adventure:   rec.adventure,
            zoneId:      zoneId,
            paths:       rec.waves,
            loadoutPath: rec.loadout,
            loadoutKeys: chk.loadoutKeys,
            waveIndex:   waveIndex,
            step:        step,
            speedBuff:   S.modules.adventures.templates.speedBuffChoice(rec)
        });
    }

    // The template's map is open and viewed: ask the start wave, check the
    // files against the island, then store a run at Gate of that wave.
    function startWaves(rec, count, zoneId) {
        var waves = rec.waves ? rec.waves.length : 0;
        var answer = ask('Start at which wave of "' + rec.label + '"? 1..' + waves, '1');
        var w = waveFrom(answer, waves);
        if (!w.ok) {
            if (w.reason === 'invalid') notify('Not a wave number: ' + answer);
            return false;
        }

        var chk = startCheck(rec);
        if (!chk) return false;
        var warnings = chk.warnings;
        if (!chk.ok) return checkFailed(rec, listOf(chk.problems));

        var run = runFromTemplate(rec, chk, zoneId, w.wave - 1);
        store().begin(makeRequest(rec, count), run);
        wakeRun();
        S.kernel.log('adventures', 'run started:', rec.label, 'x' + count, 'at wave', w.wave, 'of', waves,
            'zone', zoneId, '(' + warnings.length + ' warning(s))');
        notify('Run started at wave ' + w.wave + ' of ' + waves + ': ' + rec.label +
            '. It acts while you view the map.' +
            (warnings.length ? ' ' + warnings.length + ' warning(s) in the log.' : ''));
        return true;
    }

    // At home: check the files and loadout keys only (the generals may be
    // away), then store a run at Muster. zoneId is the open map's zone, or
    // null until the run starts the map.
    function startHome(rec, count, zoneId) {
        var chk = startCheck(rec, { camps: false, fighters: false });
        if (!chk) return false;
        var warnings = chk.warnings;
        if (!chk.ok) return checkFailed(rec, listOf(chk.problems));

        var run = runFromTemplate(rec, chk, typeof zoneId === 'number' ? zoneId : null, 0, S.RunStep.Muster);
        store().begin(makeRequest(rec, count), run);
        wakeRun();
        S.kernel.log('adventures', 'run started from home:', rec.label, 'x' + count, 'zone', zoneId,
            '(' + warnings.length + ' warning(s))');
        notify('Run started from home: ' + rec.label + ' ×' + count + '.' +
            (warnings.length ? ' ' + warnings.length + ' warning(s) in the log.' : ''));
        return true;
    }

    function start(id) {
        var rec = S.modules.adventures.templates.get(id);
        if (!rec) {
            notify('Template ' + id + ' cannot be read.');
            return false;
        }
        var maps = available(rec.adventure);
        var advLabel = S.core.adventures.label(rec.adventure) || rec.adventure;
        if (maps < 1) {
            notify('No ' + advLabel + ' map in the star menu.');
            return false;
        }
        var rs = store().current();
        if (rs.request || rs.run) {
            if (!agree(replaceQuestion(rs))) return false;
            // The old run must not act while the prompts below are answered. A
            // queued attack leaves its round half sent; later exits keep the
            // run, so the round goes with the queue.
            cancelQueued();
            store().dropRound();
        }
        var answer = ask('How many consecutive runs of "' + rec.label + '"? ' + maps + ' available.', String(maps));
        var r = countFrom(answer, maps);
        if (!r.ok) {
            if (r.reason === 'invalid') notify('Not a run count: ' + answer);
            return false;
        }

        var zoneId = S.core.adventures.zoneIdOf(rec.adventure);
        if (typeof zoneId === 'number' && S.core.zone.id() === zoneId) return startWaves(rec, r.count, zoneId);
        if (S.core.zone.isHome() === true) return startHome(rec, r.count, zoneId);
        notify('Go home or view the ' + advLabel + ' island, then choose the template again.');
        return false;
    }

    // True while runs are requested beyond the one in progress, so there is
    // a repetition left to end.
    function repetitionLeft() {
        return store().requestedRuns() > store().finishedRuns() + 1;
    }

    // Which commands apply now; each key is the name of its command. The
    // conditions mirror the ones the commands guard themselves with, so a
    // control this table enables is accepted by its command. The one exception
    // is endRepetition: for a request without a run, this table is stricter
    // and greys it out, while the command itself still accepts the call.
    function can() {
        var rs = store().current();
        var status = rs.run ? rs.run.status : null;
        return {
            pause:         status === S.RunStatus.Running,
            resume:        status === S.RunStatus.Paused,
            endRepetition: !!rs.run && status !== S.RunStatus.Done && !!rs.request && repetitionLeft(),
            stop:          !!rs.request || !!rs.run
        };
    }

    function pause() {
        if (!can().pause) {
            notify('No running adventure run to pause.');
            return false;
        }
        cancelQueued();
        return store().pause(S.RunPause.User, 'paused by you');
    }

    function resume() {
        var run = store().run();
        if (!run) {
            notify('No adventure run to resume.');
            return false;
        }
        if (run.status === S.RunStatus.Done) {
            notify('The series is done; use Stop run.');
            return false;
        }
        if (run.status !== S.RunStatus.Paused) {
            notify('The run is not paused.');
            return false;
        }
        if (!store().resume()) return false;
        wakeRun();
        notify('Run resumed at ' + store().label() + ': ' + run.label + '.');
        return true;
    }

    // Same meaning as autoTSO's end repetition: the series ends with the run
    // in progress, so the count becomes the runs finished plus that one.
    function endRepetition() {
        var req = current();
        if (!req) {
            notify('No run requested.');
            return false;
        }
        if (!repetitionLeft()) {
            notify('This is the last run requested; there is no repetition to end.');
            return false;
        }
        req.count = store().finishedRuns() + 1;
        req.ended = true;
        store().save();
        S.kernel.log('adventures', 'run repetition ended:', req.label);
        notify('Repetition ended: ' + req.label + ' stops after the current run.');
        refresh();
        return true;
    }

    // Drops the request and the run. Queued entries go first, so no attempt
    // or attack is sent after the state is gone.
    function stop() {
        if (!can().stop) {
            notify('No run requested.');
            return false;
        }
        var rs = store().current();
        var label = rs.run ? rs.run.label : rs.request.label;
        cancelQueued();
        store().clear();
        S.kernel.log('adventures', 'run stopped:', label);
        notify('Run stopped.');
        return true;
    }

    S.modules.adventures.run = {
        current:       current,
        statusText:    statusText,
        countFrom:     countFrom,
        waveFrom:      waveFrom,
        available:     available,
        can:           can,
        start:         start,
        pause:         pause,
        resume:        resume,
        stop:          stop,
        endRepetition: endRepetition
    };

}(Steward));
