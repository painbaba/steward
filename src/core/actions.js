/*
 * Action attempt runner.
 *
 * The one send / verify / retry state machine for every write to the game.
 * Other cores build a plain "def" object that says how to check, send and
 * observe one action; the caller runs it with
 * S.core.actions.attempt(def, onDone). Which action to run and when stays with
 * the caller, so the cores remain policy-free.
 *
 * Def shape (send, check and timeoutMs are required, the rest optional):
 *   label        string for the log lines
 *   category     log category of the owning core (default 'actions')
 *   satisfied()  true when the effect already holds; checked once before the
 *                first send, and then the action verifies with zero sends
 *   precheck()   null when the action may be sent, else a reason string
 *   baseline()   read once, right before the first send; passed on as base
 *   send(base)   issues the host call(s); true when they were issued
 *   check(base)  true when the expected effect is observed
 *   describe(base)  optional extra text for the final log line
 *   timeoutMs    verify window per send
 *   retries      how many more sends may follow the first (default RETRIES);
 *                0 for an action that must not go out twice
 * Every callback is wrapped in try/catch. satisfied, precheck, check and
 * describe re-find host objects themselves; send may use what its precheck
 * found, since sendStep always runs precheck right before send in the same
 * step.
 *
 * Observation rule: satisfied and check return true only on a positive,
 * successful observation of the effect. A packet that went out is not success,
 * and neither is an absent object or a failed read. The readers that defs use
 * report a failed read as null (or { ok: false }) so a def can tell "read
 * failed" from "empty", and a def treats a failed read as not observed.
 *
 * Each send is followed by checks until the window is used up, then the retry
 * the def allows (which first checks whether the effect arrived late), then a
 * named failure. A failure because the effect was never seen carries
 * unseen: true on its result, so a caller can tell it from a refusal or a send
 * that failed; the action may still have gone out.
 * The window counts the polls that actually ran, not wall time: a check that
 * the modal guard or a queue backlog deferred does not use up the window.
 *
 * Every step runs as a 'core.attempt' queue entry carrying the poll gap, so
 * the gap between a send and its first check, and between checks, is one
 * poll. A reload resets the kernel queue, which drops an attempt in flight
 * without calling its onDone; callers re-derive what to do from game state.
 *
 * Bundle slot: core, first core file (before adventures.js). The top level
 * fills S.ActionResult, assigns S.core.actions and registers the queue
 * action; everything else happens at call time.
 */

(function (S) {

    S.ActionResult.Verified = 'ActionVerified';
    S.ActionResult.Refused  = 'ActionRefused';
    S.ActionResult.Failed   = 'ActionFailed';

    // By default at most one retry, so an action is sent at most twice and
    // never a third time.
    var RETRIES = 1;

    var STEP = 'core.attempt';

    var DEFAULT_CATEGORY = 'actions';

    // Poll gap: the kernel's own spacing between queued actions, read at call
    // time. A non-positive value would make the window never close, so it is
    // floored at 1 ms.
    function pollGap() {
        var ms = S.kernel.TIMEOUTS && S.kernel.TIMEOUTS.QUEUE_ACTION_GAP_MS;
        return (typeof ms === 'number' && ms > 0) ? ms : 1;
    }

    function retriesOf(def) {
        return (typeof def.retries === 'number' && def.retries >= 0) ? def.retries : RETRIES;
    }

    function categoryOf(def) {
        return (typeof def.category === 'string' && def.category) ? def.category : DEFAULT_CATEGORY;
    }

    function labelOf(def) {
        return (typeof def.label === 'string' && def.label) ? def.label : 'action';
    }

    // Calls an optional def callback. Returns { ok, value }; ok is false when
    // the callback threw (warned under the def's category).
    function call(state, name, arg) {
        var def = state.def;
        if (typeof def[name] !== 'function') return { ok: true, value: undefined };
        try {
            return { ok: true, value: def[name](arg) };
        } catch (e) {
            S.kernel.warn(categoryOf(def), labelOf(def) + ': ' + name + ' threw:', e);
            return { ok: false, value: undefined };
        }
    }

    // A throwing check counts as not observed.
    function observed(state) {
        var r = call(state, 'check', state.base);
        return r.ok && r.value === true;
    }

    function enqueue(state) {
        return S.kernel.queue.add(STEP, [state], pollGap()) === true;
    }

    function finish(state, status, reason, unseen) {
        var def = state.def;
        state.phase = 'done';
        var result = {
            status: status,
            label:  labelOf(def),
            reason: reason || '',
            sends:  state.sends
        };
        if (unseen === true) result.unseen = true;
        var text = result.label + ': ' + status + ' after ' + state.sends + ' send(s)';
        if (result.reason) text += ' (' + result.reason + ')';
        var extra = call(state, 'describe', state.base);
        if (extra.ok && extra.value !== undefined && extra.value !== null && extra.value !== '') {
            text += '; ' + String(extra.value);
        }
        if (status === S.ActionResult.Verified) S.kernel.log(categoryOf(def), text);
        else S.kernel.warn(categoryOf(def), text);

        if (typeof state.onDone === 'function') {
            try {
                state.onDone(result);
            } catch (e) {
                S.kernel.error(categoryOf(def), result.label + ': onDone threw:', e);
            }
        }
        return result;
    }

    function sendStep(state) {
        var first = state.sends === 0;

        if (first && !state.started) {
            var sat = call(state, 'satisfied');
            if (sat.ok && sat.value === true) {
                finish(state, S.ActionResult.Verified, '');
                return;
            }
        }

        // A retry first looks for an effect that arrived after the window.
        if (!first && observed(state)) {
            finish(state, S.ActionResult.Verified, '');
            return;
        }

        var pre = call(state, 'precheck');
        var reason = null;
        if (!pre.ok) reason = 'precheck threw';
        else if (pre.value !== null && pre.value !== undefined) reason = String(pre.value) || 'precheck refused';
        if (reason !== null) {
            if (first) finish(state, S.ActionResult.Refused, reason);
            else finish(state, S.ActionResult.Failed, 'retry refused: ' + reason);
            return;
        }

        if (!state.started) {
            state.started = true;
            state.base = call(state, 'baseline').value;
        }

        var sent = call(state, 'send', state.base);
        state.sends++;
        if (!sent.ok || sent.value !== true) {
            if (state.sends <= retriesOf(state.def)) {
                S.kernel.warn(categoryOf(state.def), labelOf(state.def) + ': send failed, retrying');
                enqueue(state);
            } else {
                finish(state, S.ActionResult.Failed, 'send failed');
            }
            return;
        }
        state.phase = 'check';
        state.polls = 0;
        enqueue(state);
    }

    function checkStep(state) {
        if (observed(state)) {
            finish(state, S.ActionResult.Verified, '');
            return;
        }
        state.polls++;
        if (state.polls * pollGap() >= state.def.timeoutMs) {
            if (state.sends <= retriesOf(state.def)) {
                S.kernel.warn(categoryOf(state.def), labelOf(state.def) + ': not observed, retrying');
                state.phase = 'send';
                enqueue(state);
            } else {
                finish(state, S.ActionResult.Failed, 'not observed within ' + state.def.timeoutMs + ' ms', true);
            }
            return;
        }
        enqueue(state);
    }

    // Queue handler: one call does one step of one attempt.
    function step(params) {
        var state = params && params[0];
        if (!state || !state.def) {
            S.kernel.error(DEFAULT_CATEGORY, 'step: missing attempt state');
            return;
        }
        if (state.phase === 'send') sendStep(state);
        else if (state.phase === 'check') checkStep(state);
        // phase 'done': a finished attempt ignores a stray entry.
    }

    function attempt(def, onDone) {
        if (!def || typeof def !== 'object') {
            S.kernel.error(DEFAULT_CATEGORY, 'attempt: def must be an object');
            return false;
        }
        if (typeof def.send !== 'function' || typeof def.check !== 'function') {
            S.kernel.error(categoryOf(def), labelOf(def) + ': attempt needs send and check functions');
            return false;
        }
        if (typeof def.timeoutMs !== 'number' || !(def.timeoutMs > 0)) {
            S.kernel.error(categoryOf(def), labelOf(def) + ': attempt needs timeoutMs > 0');
            return false;
        }
        var state = { def: def, onDone: onDone, phase: 'send', sends: 0, polls: 0, base: undefined, started: false };
        return enqueue(state);
    }

    S.core.actions = {
        RETRIES: RETRIES,
        STEP:    STEP,
        attempt: attempt,
        step:    step
    };

    // The kernel loads before core, and a reload re-runs the kernel queue
    // file first, so this never replaces an earlier handler.
    S.kernel.queue.action(STEP, step);

}(Steward));
