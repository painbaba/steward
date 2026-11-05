/*
 * Quests: listing and claiming.
 *
 * Reads the quest pool of the current zone and builds the def that claims one
 * finished quest through message 100. Run the def with
 * S.core.actions.attempt(def, onDone); this file decides nothing about which
 * quest to claim or when.
 *
 * list() distinguishes a failed read (null) from an empty pool ([]): a def
 * that verifies by absence must never mistake an unreadable pool for a
 * claimed quest. This is the failure contract of core/actions.js.
 *
 * A claim is verified by the server's result callback for the current send
 * (game.createResponder, a ServerState::ResponderSimple), or by the quest key
 * leaving the same zone's pool. A claimed quest stays in the pool for a while,
 * so absence alone often comes too late. A fault, a result for an earlier
 * send, a missing response or "no longer finished" are never success.
 *
 * Pool entries without an isFinished method are not quests and are skipped.
 *
 * Claiming the last quest of an adventure closes the adventure, so claim()
 * refuses it unless the caller passes allowLast.
 *
 * Bundle slot: core, after production.js and before resources.js (core files
 * load in name order). Everything here runs at call time; the top level only
 * assigns S.core.quests.
 */

(function (S) {

    // specialType_string of the adventure's final quest contains this marker.
    var LAST_QUEST_MARK = 'lastQuest';

    // Message that claims a quest, and the server-action type it carries.
    var CLAIM_MESSAGE = 100;
    var CLAIM_TYPE = 1;

    // Quest mode set on the client when a claim is sent.
    var CLAIM_MODE = 1;

    var CLAIM_TIMEOUT_MS = 15000;

    // The live quest objects of the pool, or null when the game, the pool or
    // the vector is missing or the read throws.
    function readPool() {
        try {
            if (typeof game === 'undefined' || !game || !game.quests) return null;
            var pool = game.quests.GetQuestPool();
            if (!pool) return null;
            var vec = pool.GetQuest_vector();
            if (!vec) return null;
            if (typeof vec.toArray === 'function') {
                var arr = vec.toArray();
                if (arr && typeof arr.length === 'number') vec = arr;
            }
            if (typeof vec.length !== 'number') return null;
            var out = [];
            for (var i = 0; i < vec.length; i++) out.push(vec[i]);
            return out;
        } catch (e) {
            S.kernel.warn('quests', 'quest pool read threw:', e);
            return null;
        }
    }

    function keyOf(q) {
        try {
            var uid = q.GetUniqueId();
            if (uid && typeof uid.toKeyString === 'function') return uid.toKeyString();
        } catch (e) { /* the entry is skipped by the caller */ }
        return null;
    }

    // The pool can hold entries that are not quest objects; they have no
    // isFinished and must neither be listed nor claimed.
    function isQuest(q) {
        return !!q && typeof q.isFinished === 'function';
    }

    // The host responder for a claim, or null when the host has none. Called
    // as a method on game because createResponder reads its own this.
    function claimResponder(onResult, onFault) {
        try {
            if (typeof game === 'undefined' || !game || typeof game.createResponder !== 'function') return null;
            return game.createResponder(onResult, onFault) || null;
        } catch (e) {
            S.kernel.warn('quests', 'createResponder threw:', e);
            return null;
        }
    }

    // True when the quest definition carries the last-quest marker.
    function isLast(q) {
        try {
            var special = q.GetQuestDefinition().specialType_string;
            return typeof special === 'string' && special.indexOf(LAST_QUEST_MARK) !== -1;
        } catch (e) {
            return false;
        }
    }

    // [{ key, name, finished, last }] for the quests on this zone; null when
    // the pool cannot be read, [] for a pool that reads fine and is empty. An
    // entry that cannot be read is skipped.
    function list() {
        var qs = readPool();
        if (qs === null) return null;
        var out = [];
        for (var i = 0; i < qs.length; i++) {
            try {
                var q = qs[i];
                if (!isQuest(q)) {
                    S.kernel.debug('quests', 'quest entry ' + i + ' is not a quest, skipped');
                    continue;
                }
                var key = keyOf(q);
                if (key === null) continue;
                var name = '';
                try { name = String(q.getQuestName_string()); } catch (e1) { /* leave default */ }
                out.push({ key: key, name: name, finished: q.isFinished() === true, last: isLast(q) });
            } catch (e2) {
                S.kernel.warn('quests', 'quest entry ' + i + ' threw:', e2);
            }
        }
        return out;
    }

    // The finished entries of list(); null when the pool cannot be read.
    function finished() {
        var all = list();
        if (all === null) return null;
        var out = [];
        for (var i = 0; i < all.length; i++) {
            if (all[i].finished) out.push(all[i]);
        }
        return out;
    }

    // The live host quest with this uid key, or null. Always re-found, never
    // cached, so a def never acts on a quest object that has left the pool.
    function findQuest(key) {
        var qs = readPool();
        if (qs === null) return null;
        for (var i = 0; i < qs.length; i++) {
            if (!isQuest(qs[i])) continue;
            if (keyOf(qs[i]) === key) return qs[i];
        }
        return null;
    }

    function hasKey(all, key) {
        for (var i = 0; i < all.length; i++) {
            if (all[i].key === key) return true;
        }
        return false;
    }

    // Def that claims the finished quest with this uid key. opts.allowLast
    // lets it claim the adventure's last quest (which closes the adventure).
    // Verified when the server's result callback for the current send fires,
    // or when the quest has left the pool by its key in the same zone. A
    // fault, a result that belongs to an earlier send or no response at all
    // do not verify. "No longer finished" is not a success signal either: the
    // send itself puts the quest into claim mode on the client, which can make
    // isFinished read false. There is no satisfied(): an absent quest is a
    // refusal, not an earlier success.
    function claim(key, opts) {
        var allowLast = !!(opts && opts.allowLast);
        var label = 'claim quest ' + key;
        // Set by send. The retry must not refuse because the quest no longer
        // reads finished after our own SetQuestMode.
        var sentOnce = false;
        // Per-send token: send numbers each message, a result callback records
        // its own number only while that send is still the latest one, so a
        // late answer to an earlier send never verifies a later one.
        var sendSeq = 0;
        var ackSeq = 0;

        return {
            label:     label,
            category:  'quests',
            timeoutMs: CLAIM_TIMEOUT_MS,

            precheck: function () {
                var all = list();
                if (all === null) return 'quests unreadable';
                var entry = null;
                for (var i = 0; i < all.length; i++) {
                    if (all[i].key === key) { entry = all[i]; break; }
                }
                if (!entry) return 'quest not found';
                if (entry.last && !allowLast) return 'last quest';
                if (!entry.finished && !sentOnce) return 'quest not finished';
                return null;
            },

            // The zone is part of the baseline: the pool is the current zone's,
            // so a zone change would otherwise read as the quest leaving it.
            baseline: function () {
                return { found: true, zoneId: S.core.zone.id() };
            },

            send: function () {
                var q = findQuest(key);
                if (!q) return false;
                var sa = game.def('Communication.VO::dServerAction', true);
                if (!sa) return false;
                q.SetQuestMode(CLAIM_MODE);
                sentOnce = true;
                sa.type = CLAIM_TYPE;
                sa.data = q.GetUniqueId();
                sendSeq++;
                var seq = sendSeq;
                // Both callbacks run inside the host's dispatch loop, so
                // nothing may escape them.
                var responder = claimResponder(
                    function () {
                        try {
                            if (seq === sendSeq) ackSeq = seq;
                            S.kernel.debug('quests', label + ': server result for send ' + seq +
                                (seq === sendSeq ? '' : ' (stale, ignored)'));
                        } catch (e) {
                            S.kernel.error('quests', label + ': result callback threw:', e);
                        }
                    },
                    function (f) {
                        try {
                            S.kernel.warn('quests', label + ': server fault for send ' + seq, f);
                        } catch (e) {
                            S.kernel.error('quests', label + ': fault callback threw:', e);
                        }
                    }
                );
                if (!responder) S.kernel.debug('quests', label + ': no host responder, verifying by absence only');
                return S.core.packets.sendMessage(CLAIM_MESSAGE, sa, responder) === true;
            },

            check: function (base) {
                if (!base || base.found !== true) return false;
                // The server answered our own latest send; that send carried
                // the zone id at send time, so no zone guard is needed here.
                if (sendSeq > 0 && ackSeq === sendSeq) return true;
                var zoneId = S.core.zone.id();
                if (typeof zoneId !== 'number' || zoneId !== base.zoneId) return false;
                var all = list();
                if (all === null) return false;
                return !hasKey(all, key);
            }
        };
    }

    if (!S.core.quests) S.core.quests = {};
    S.core.quests.LAST_QUEST_MARK = LAST_QUEST_MARK;
    S.core.quests.list     = list;
    S.core.quests.finished = finished;
    S.core.quests.isLast   = isLast;
    S.core.quests.claim    = claim;

}(Steward));
