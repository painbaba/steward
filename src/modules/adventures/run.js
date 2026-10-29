/*
 * Run request for an adventure template.
 *
 * A run request says "run this template N times in a row". It is chosen
 * from the ~Steward~ > Adventures menu: one prompt asks for the count,
 * prefilled with the maps available (star-menu maps plus one when an own
 * adventure of that map is already open), and End repetition cuts the
 * count to one so a running series stops after the current run.
 *
 * Nothing starts and nothing is sent yet: there is no run executor, so a
 * request is only stored and shown. This file never touches the scheduler
 * queue, packets or settings.
 *
 * The request lives on S.modules.adventures.runState. The Steward global
 * and its module namespace survive a script reload, so a request survives
 * one too, and it is lost on a client restart. It is deliberately kept out
 * of the settings and the template file: it describes what to do now, not
 * how a template is configured. There is one request at a time; starting
 * another one asks before replacing it.
 *
 * Shape: { templateId, label, adventure, count, ended, requested }.
 */

(function (S) {

    if (!S.modules.adventures) S.modules.adventures = {};
    if (!S.modules.adventures.runState) S.modules.adventures.runState = { request: null };

    // Read at call time, so a state object restored by a reload is the one used.
    function state() {
        return S.modules.adventures.runState;
    }

    function current() {
        return state().request;
    }

    function statusText(req) {
        if (!req) return 'No run requested';
        return 'Requested: ' + req.label + ' ×' + req.count + (req.ended ? ', repetition ended' : '');
    }

    // Turns a prompt answer into a run count. Cancel stores nothing, unlike
    // autoTSO, which treats a cancelled prompt as one run.
    function countFrom(answer, maps) {
        if (answer === null || answer === undefined) return { ok: false, reason: 'cancel' };
        var n = parseInt(String(answer).replace(/^\s+|\s+$/g, ''), 10);
        if (isNaN(n) || n < 1) return { ok: false, reason: 'invalid' };
        return { ok: true, count: Math.min(n, maps) };
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
        S.kernel.warn('adventures', 'prompt() is not available; run count not asked');
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
        var cur = current();
        if (cur && !agree('Replace the requested run "' + cur.label + '" ×' + cur.count + '?')) return false;
        var answer = ask('How many consecutive runs of "' + rec.label + '"? ' + maps + ' available.', String(maps));
        var r = countFrom(answer, maps);
        if (!r.ok) {
            if (r.reason === 'invalid') notify('Not a run count: ' + answer);
            return false;
        }
        state().request = {
            templateId: rec.id,
            label:      rec.label,
            adventure:  rec.adventure,
            count:      r.count,
            ended:      false,
            requested:  new Date().getTime()
        };
        S.kernel.log('adventures', 'run requested:', rec.label, 'x' + r.count);
        notify('Requested ' + r.count + ' run(s) of ' + rec.label + '. Nothing starts yet: the run executor is not built.');
        refresh();
        return true;
    }

    // Same meaning as autoTSO's end repetition: the remaining count becomes one.
    function endRepetition() {
        var req = current();
        if (!req) {
            notify('No run requested.');
            return false;
        }
        if (req.count <= 1) {
            notify('Only one run requested; there is no repetition to end.');
            return false;
        }
        req.count = 1;
        req.ended = true;
        S.kernel.log('adventures', 'run repetition ended:', req.label);
        notify('Repetition ended: ' + req.label + ' stops after the current run.');
        refresh();
        return true;
    }

    // Nothing finishes a stored request until the executor exists, so this is
    // the only way to drop one.
    function clear() {
        var req = current();
        if (!req) {
            notify('No run requested.');
            return false;
        }
        state().request = null;
        S.kernel.log('adventures', 'run request cleared:', req.label);
        notify('Run request cleared.');
        refresh();
        return true;
    }

    S.modules.adventures.run = {
        current:       current,
        statusText:    statusText,
        countFrom:     countFrom,
        available:     available,
        start:         start,
        endRepetition: endRepetition,
        clear:         clear
    };

}(Steward));
