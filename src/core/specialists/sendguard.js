/*
 * Send guard: a send to an idle explorer or geologist only counts once the
 * specialist is seen to leave Idle.
 *
 * When the client stops applying search tasks, every send still reports
 * success, the specialist stays Idle and the next plan sends it again, without
 * limit. The guard keeps a pending entry per sent uid. The module's next plan
 * passes its own specialist read to settle(), which judges what it can see: a
 * pending specialist that is no longer Idle is verified, one that is still
 * Idle after VERIFY_MS on a complete read missed. A miss holds that uid with a
 * delay that doubles per miss up to HOLD_MAX_MS; only a verify clears the
 * count. BREAKER_MISSES misses in a row, counted in send order across every
 * owner, open one breaker that pauses dispatch, warns once and lets one probe
 * through every PROBE_COOLDOWN_MS. The first verified send closes it.
 *
 * Verification is deferred to the module's plan instead of running through
 * S.core.actions.attempt: a batch of sends would each hold the shared queue
 * while polling, and the plan already reads its specialists once anyway.
 *
 * One guard is shared by every specialist module, because a client that stops
 * applying tasks hits them all at once and a per-module guard could not see
 * the other's misses. What to send and when stays in the modules.
 *
 * Unknown is never evidence. Only a send that really left is noted. A read
 * that dropped entries never produces a miss, since a half-read entry reads
 * Idle, but a busy reading from it is still a verify. An entry that could not
 * be judged before STALE_MS is dropped without counting or holding.
 *
 * State is memory only and built fresh each time this file runs, so a script
 * reload resets every pending entry, hold and the breaker.
 *
 * Bundle slot: core, under core/specialists/ after orders.js and, like every
 * file there, before specialists.js. Every reference to
 * S.core.specialists.uniqueIdKey/status happens at call time.
 */

(function (S) {

    if (!S.core.specialists) S.core.specialists = {};

    // Healthy clients show a search task 10-50 s after the send, so an Idle
    // reading earlier than this proves nothing.
    var VERIFY_MS         = 60000;
    // Past this an Idle reading says nothing about the send: the task may
    // have run and finished while nobody looked.
    var STALE_MS          = 900000;
    var HOLD_BASE_MS      = 300000;
    var HOLD_MAX_MS       = 3600000;
    // One or two slow tasks never trip it; a desynced batch trips it at once.
    var BREAKER_MISSES    = 5;
    var PROBE_COOLDOWN_MS = 300000;

    var CATEGORY = 'specialists';

    var has = Object.prototype.hasOwnProperty;

    var pending     = {};   // uid -> { owner, label, tag, sentAt }
    var holds       = {};   // uid -> { until, misses }
    var run         = 0;    // unverified sends in a row, in send order
    var open        = false;
    var nextProbeAt = 0;

    var guard = {};

    function now() {
        return guard.clock();
    }

    function seconds(ms) {
        return Math.round(ms / 1000);
    }

    function holdMs(misses) {
        return Math.min(HOLD_BASE_MS * Math.pow(2, misses - 1), HOLD_MAX_MS);
    }

    function note(owner, uid, label, tag) {
        if (!uid) return;
        pending[uid] = { owner: owner, label: label || '?', tag: tag, sentAt: now() };
    }

    function applyVerify(item, t) {
        var e = item.entry;
        delete pending[item.key];
        delete holds[item.key];
        run = 0;
        S.kernel.log(e.owner, 'verified ' + e.label + ' (uid ' + item.key + ') after ' +
            seconds(t - e.sentAt) + ' s');
        if (open) {
            open = false;
            S.kernel.log(CATEGORY, 'send guard closed: ' + e.label + ' verified, dispatch resumes');
        }
    }

    function applyMiss(item, t) {
        var e = item.entry;
        delete pending[item.key];
        var h = has.call(holds, item.key) ? holds[item.key] : { until: 0, misses: 0 };
        h.misses += 1;
        var ms = holdMs(h.misses);
        h.until = t + ms;
        holds[item.key] = h;
        S.kernel.log(e.owner, e.label + ' (uid ' + item.key + ') did not leave Idle after ' +
            seconds(t - e.sentAt) + ' s - held ' + Math.round(ms / 60000) + ' min');
        run += 1;
        if (!open && run >= BREAKER_MISSES) {
            open = true;
            nextProbeAt = t + PROBE_COOLDOWN_MS;
            S.kernel.warn(CATEGORY, 'send guard open: ' + run + ' sends in a row did not change ' +
                'their specialist; explorer and geologist dispatch is paused, one probe every ' +
                Math.round(PROBE_COOLDOWN_MS / 60000) + ' min; reloading scripts resets it');
        }
    }

    // list: the plan's own specialist read (may be null). complete: false
    // when that read dropped entries, which then cannot produce a miss.
    function settle(owner, list, complete) {
        var t = now();
        var judged = [];
        var seen = {};
        var v = 0;
        var m = 0;
        var i;
        if (list && list.length) {
            for (i = 0; i < list.length; i++) {
                var key = S.core.specialists.uniqueIdKey(list[i]);
                if (!key || has.call(seen, key)) continue;
                if (!has.call(pending, key) || pending[key].owner !== owner) continue;
                var st;
                try { st = S.core.specialists.status(list[i]); }
                catch (e) { continue; }
                var entry = pending[key];
                var age = t - entry.sentAt;
                if (st !== S.SpecialistStatus.Idle) {
                    seen[key] = true;
                    judged.push({ key: key, entry: entry, verified: true });
                } else if (complete && age >= VERIFY_MS && age <= STALE_MS) {
                    seen[key] = true;
                    judged.push({ key: key, entry: entry, verified: false });
                }
            }
        }
        for (var k in pending) {
            if (!has.call(pending, k) || has.call(seen, k)) continue;
            var p = pending[k];
            if (p.owner !== owner || t - p.sentAt <= STALE_MS) continue;
            delete pending[k];
            S.kernel.debug(owner, 'send to ' + p.label + ' (uid ' + k + ') not judged after ' +
                seconds(t - p.sentAt) + ' s - dropped');
        }
        judged.sort(function (a, b) { return a.entry.sentAt - b.entry.sentAt; });
        for (i = 0; i < judged.length; i++) {
            if (judged[i].verified) {
                applyVerify(judged[i], t);
                v++;
            } else {
                applyMiss(judged[i], t);
                m++;
            }
        }
        return { verified: v, missed: m };
    }

    // Pending or held. A hold that ran out keeps its miss count but no longer
    // blocks.
    function blocked(uid) {
        if (!uid) return false;
        if (has.call(pending, uid)) return true;
        return has.call(holds, uid) && holds[uid].until > now();
    }

    function pendingTags(owner) {
        var out = [];
        for (var k in pending) {
            if (has.call(pending, k) && pending[k].owner === owner) out.push(pending[k].tag);
        }
        return out;
    }

    // How many of n sends may go out now. While the breaker is open the first
    // caller after each cooldown gets one probe; the cooldown re-arms at once,
    // so a probe that misses waits a full cooldown before the next.
    function admit(n) {
        if (!(n > 0)) return 0;
        if (!open) return n;
        var t = now();
        if (t >= nextProbeAt) {
            nextProbeAt = t + PROBE_COOLDOWN_MS;
            S.kernel.debug(CATEGORY, 'send guard open: one probe send allowed');
            return 1;
        }
        return 0;
    }

    function isOpen() {
        return open;
    }

    function snapshot() {
        var t = now();
        var np = 0;
        var nh = 0;
        var k;
        for (k in pending) {
            if (has.call(pending, k)) np++;
        }
        for (k in holds) {
            if (has.call(holds, k) && holds[k].until > t) nh++;
        }
        return { open: open, run: run, pending: np, held: nh, nextProbeAt: nextProbeAt };
    }

    guard.clock             = function () { return Date.now(); };
    guard.VERIFY_MS         = VERIFY_MS;
    guard.STALE_MS          = STALE_MS;
    guard.HOLD_BASE_MS      = HOLD_BASE_MS;
    guard.HOLD_MAX_MS       = HOLD_MAX_MS;
    guard.BREAKER_MISSES    = BREAKER_MISSES;
    guard.PROBE_COOLDOWN_MS = PROBE_COOLDOWN_MS;
    guard.note              = note;
    guard.settle            = settle;
    guard.blocked           = blocked;
    guard.pendingTags       = pendingTags;
    guard.admit             = admit;
    guard.isOpen            = isOpen;
    guard.snapshot          = snapshot;

    S.core.specialists.sendGuard = guard;

}(Steward));
