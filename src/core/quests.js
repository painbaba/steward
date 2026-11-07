/*
 * Quests: listing, reading and claiming.
 *
 * Reads the quest pool of the current zone and builds the defs that read one
 * unread quest or claim one finished quest through message 100. Run a def
 * with S.core.actions.attempt(def, onDone); this file decides nothing about
 * which quest to read or claim or when.
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
 * A quest is unread while it waits in mode 2 for the player's "New Quest"
 * click and the client counts it as active (IsActive, or IsQuestActive where
 * IsActive is absent). An unread quest has not started: a main quest's
 * sub-quests do not enter the pool until it is read. read() sends what the
 * client sends when the player opens it: SetQuestMode(3) and message 100 with
 * server-action type 0 and the quest uid. It is verified by the server's
 * result for the current send, or by new quests entering the same zone's
 * pool. Mode 3 is never proof, because the send sets it on the client itself.
 * The last quest can be read: reading starts it, only claiming closes the
 * adventure.
 *
 * clickNames() names the map objects that open quests still wait to have
 * clicked. It applies the client's own pick-up-all filter: the quest is not
 * finished and IsQuestActive() holds, the trigger has type 1 and condition 9
 * (click a named map object) and a non-empty name_string, and its entry in
 * mQuestTriggersFinished_vector (by triggerIdx) is missing or has status 0.
 *
 * Bundle slot: core, after production.js and before resources.js (core files
 * load in name order). Everything here runs at call time; the top level only
 * assigns S.core.quests.
 */

(function (S) {

    // specialType_string of the adventure's final quest contains this marker.
    var LAST_QUEST_MARK = 'lastQuest';

    // Message that carries both the read and the claim of a quest
    // (COMMAND.QUEST_TRIGGER), and the server-action types it carries:
    // SERVER_STACK_QUEST_BUTTON_OK for the read, SERVER_STACK_REWARD_BUTTON_OK
    // for the claim.
    var TRIGGER_MESSAGE = 100;
    var READ_TYPE = 0;
    var CLAIM_TYPE = 1;

    // Quest modes. The client sets CLAIM_MODE when a claim is sent and
    // READ_MODE (QUEST_MODE_RUNNING) when a read is sent. UNREAD_MODE
    // (QUEST_MODE_START_WINDOW_DESCRIPTION_WAIT_FOR_BUTTON_PRESSED) is a quest
    // that waits for the player's "New Quest" click.
    var CLAIM_MODE = 1;
    var UNREAD_MODE = 2;
    var READ_MODE = 3;

    var TRIGGER_TIMEOUT_MS = 15000;

    // Trigger type and condition of "click the named map object".
    var CLICK_TRIGGER_TYPE = 1;
    var CLICK_TRIGGER_CONDITION = 9;

    // A plain array copy of a host vector, or null when it is missing or has
    // no length. toArray is preferred where the host offers it; otherwise the
    // vector is walked by index. A throw reaches the caller.
    function toList(vec) {
        if (!vec) return null;
        if (typeof vec.toArray === 'function') {
            var arr = vec.toArray();
            if (arr && typeof arr.length === 'number') vec = arr;
        }
        if (typeof vec.length !== 'number') return null;
        var out = [];
        for (var i = 0; i < vec.length; i++) out.push(vec[i]);
        return out;
    }

    // The live quest objects of the pool, or null when the game, the pool or
    // the vector is missing or the read throws.
    function readPool() {
        try {
            if (typeof game === 'undefined' || !game || !game.quests) return null;
            var pool = game.quests.GetQuestPool();
            if (!pool) return null;
            return toList(pool.GetQuest_vector());
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

    // The host responder for a read or claim, or null when the host has none.
    // Called as a method on game because createResponder reads its own this.
    function triggerResponder(onResult, onFault) {
        try {
            if (typeof game === 'undefined' || !game || typeof game.createResponder !== 'function') return null;
            return game.createResponder(onResult, onFault) || null;
        } catch (e) {
            S.kernel.warn('quests', 'createResponder threw:', e);
            return null;
        }
    }

    // The quest's definition: the getter first, the raw field when the getter
    // is absent, throws or returns nothing. source tells which one answered,
    // so a dump can show where a definition came from.
    function definition(q) {
        try {
            if (typeof q.GetQuestDefinition === 'function') {
                var d = q.GetQuestDefinition();
                if (d) return { def: d, source: 'getter' };
            }
        } catch (e) { /* try the field */ }
        try {
            if (q.mQuestDefinition) return { def: q.mQuestDefinition, source: 'field' };
        } catch (e2) { /* none */ }
        return { def: null, source: 'none' };
    }

    // True when the quest definition carries the last-quest marker.
    function isLast(q) {
        try {
            var special = definition(q).def.specialType_string;
            return typeof special === 'string' && special.indexOf(LAST_QUEST_MARK) !== -1;
        } catch (e) {
            return false;
        }
    }

    // The quest's mode (mQuestMode), or null when it is not a number or the
    // read throws.
    function modeOf(q) {
        try {
            var m = q.mQuestMode;
            return typeof m === 'number' ? m : null;
        } catch (e) {
            return null;
        }
    }

    // True when the client counts the quest as active. IsActive is the
    // client's own gate for the read; IsQuestActive stands in where it is
    // absent. A missing method means the quest does not count.
    function isActive(q) {
        if (typeof q.IsActive === 'function') return q.IsActive() === true;
        if (typeof q.IsQuestActive === 'function') return q.IsQuestActive() === true;
        return false;
    }

    // True for a quest the player could open now: it waits for "New Quest"
    // and is active. The adventure's last quest is included on purpose.
    function isUnread(q) {
        return modeOf(q) === UNREAD_MODE && isActive(q);
    }

    // [{ key, name, finished, last, unread }] for the quests on this zone;
    // null when the pool cannot be read, [] for a pool that reads fine and is
    // empty. An entry that cannot be read is skipped.
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
                out.push({
                    key: key, name: name, finished: q.isFinished() === true,
                    last: isLast(q), unread: isUnread(q)
                });
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

    // The unread entries of list(); null when the pool cannot be read.
    function unread() {
        var all = list();
        if (all === null) return null;
        var out = [];
        for (var i = 0; i < all.length; i++) {
            if (all[i].unread) out.push(all[i]);
        }
        return out;
    }

    // True while the quest is open and the client counts it as active. A
    // missing method means the quest does not count.
    function isOpenActive(q) {
        if (q.isFinished() === true) return false;
        return typeof q.IsQuestActive === 'function' && q.IsQuestActive() === true;
    }

    // True when the trigger asks for a click on a named map object.
    function isClickTrigger(t) {
        return !!t && t.type === CLICK_TRIGGER_TYPE && t.condition === CLICK_TRIGGER_CONDITION &&
            typeof t.name_string === 'string' && t.name_string.length > 0;
    }

    // True while the trigger's status entry is missing or still open. Any
    // other status means the client already counts the trigger as done.
    function isTriggerOpen(statuses, t) {
        if (!statuses) return true;
        var st = statuses[t.triggerIdx];
        if (st === undefined || st === null) return true;
        return st.status === 0;
    }

    // { name: true } for every map object an open, active quest still waits
    // to have clicked; null when the pool cannot be read. A quest whose read
    // throws is skipped, as list() does.
    function clickNames() {
        var qs = readPool();
        if (qs === null) return null;
        var out = {};
        for (var i = 0; i < qs.length; i++) {
            try {
                var q = qs[i];
                if (!isQuest(q) || !isOpenActive(q)) continue;
                var def = definition(q).def;
                var triggers = def ? toList(def.questTriggers_vector) : null;
                if (!triggers) continue;
                var statuses = toList(q.mQuestTriggersFinished_vector);
                for (var k = 0; k < triggers.length; k++) {
                    var t = triggers[k];
                    if (!isClickTrigger(t) || !isTriggerOpen(statuses, t)) continue;
                    out[t.name_string] = true;
                }
            } catch (e) {
                S.kernel.warn('quests', 'quest entry ' + i + ' threw:', e);
            }
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

    // Send state of one def: whether it has sent at all, and a per-send
    // token. sendTrigger numbers each message, and a result callback records
    // its own number only while that send is still the latest one, so a late
    // answer to an earlier send never verifies a later one.
    function sendState() {
        return { sent: false, seq: 0, ack: 0 };
    }

    // Sets the quest's mode on the client and sends message 100 with the
    // given server-action type and the quest uid, as the client does. False
    // when the quest or the server action is missing or the send fails.
    function sendTrigger(key, mode, type, label, ss) {
        var q = findQuest(key);
        if (!q) return false;
        var sa = game.def('Communication.VO::dServerAction', true);
        if (!sa) return false;
        q.SetQuestMode(mode);
        ss.sent = true;
        sa.type = type;
        sa.data = q.GetUniqueId();
        ss.seq++;
        var seq = ss.seq;
        // Both callbacks run inside the host's dispatch loop, so nothing may
        // escape them.
        var responder = triggerResponder(
            function () {
                try {
                    if (seq === ss.seq) ss.ack = seq;
                    S.kernel.debug('quests', label + ': server result for send ' + seq +
                        (seq === ss.seq ? '' : ' (stale, ignored)'));
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
        return S.core.packets.sendMessage(TRIGGER_MESSAGE, sa, responder) === true;
    }

    // True when the server answered the latest send. That send carried the
    // zone id at send time, so no zone guard is needed with it.
    function answered(ss) {
        return ss.seq > 0 && ss.ack === ss.seq;
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
        // ss.sent is set by send. The retry must not refuse because the quest
        // no longer reads finished after our own SetQuestMode.
        var ss = sendState();

        return {
            label:     label,
            category:  'quests',
            timeoutMs: TRIGGER_TIMEOUT_MS,

            precheck: function () {
                var all = list();
                if (all === null) return 'quests unreadable';
                var entry = null;
                for (var i = 0; i < all.length; i++) {
                    if (all[i].key === key) { entry = all[i]; break; }
                }
                if (!entry) return 'quest not found';
                if (entry.last && !allowLast) return 'last quest';
                if (!entry.finished && !ss.sent) return 'quest not finished';
                return null;
            },

            // The zone is part of the baseline: the pool is the current zone's,
            // so a zone change would otherwise read as the quest leaving it.
            baseline: function () {
                return { found: true, zoneId: S.core.zone.id() };
            },

            send: function () {
                return sendTrigger(key, CLAIM_MODE, CLAIM_TYPE, label, ss);
            },

            check: function (base) {
                if (!base || base.found !== true) return false;
                if (answered(ss)) return true;
                var zoneId = S.core.zone.id();
                if (typeof zoneId !== 'number' || zoneId !== base.zoneId) return false;
                var all = list();
                if (all === null) return false;
                return !hasKey(all, key);
            }
        };
    }

    // Def that reads the unread quest with this uid key, as the player's
    // "New Quest" click does. Verified when the server's result callback for
    // the current send fires, or when quests that were not in the baseline
    // enter the same zone's pool (the server started a main quest's
    // sub-quests). Mode 3, or the quest no longer reading unread, is never
    // proof: the send sets mode 3 on the client itself. For the same reason a
    // read that was sent and is neither answered nor followed by new quests
    // fails and is not tried again by a caller that waits for the quest to
    // read unread: on the client it no longer does. The last quest is not
    // refused, since reading it only starts it. There is no satisfied().
    function read(key) {
        var label = 'read quest ' + key;
        // ss.sent is set by send. The retry must not refuse because the quest
        // no longer reads unread after our own SetQuestMode.
        var ss = sendState();

        return {
            label:     label,
            category:  'quests',
            timeoutMs: TRIGGER_TIMEOUT_MS,

            precheck: function () {
                var all = list();
                if (all === null) return 'quests unreadable';
                var entry = null;
                for (var i = 0; i < all.length; i++) {
                    if (all[i].key === key) { entry = all[i]; break; }
                }
                if (!entry) return 'quest not found';
                if (!entry.unread && !ss.sent) return 'quest not unread';
                return null;
            },

            // The keys present before the send, so quests the server starts
            // afterwards can be told apart. The zone is kept so another
            // zone's pool is never read as new quests.
            baseline: function () {
                var all = list();
                var keys = null;
                if (all !== null) {
                    keys = {};
                    for (var i = 0; i < all.length; i++) keys[all[i].key] = true;
                }
                return { found: true, zoneId: S.core.zone.id(), keys: keys };
            },

            send: function () {
                return sendTrigger(key, READ_MODE, READ_TYPE, label, ss);
            },

            check: function (base) {
                if (!base || base.found !== true) return false;
                if (answered(ss)) return true;
                var zoneId = S.core.zone.id();
                if (typeof zoneId !== 'number' || zoneId !== base.zoneId) return false;
                if (base.keys === null) return false;
                var all = list();
                if (all === null) return false;
                for (var i = 0; i < all.length; i++) {
                    if (base.keys[all[i].key] !== true) return true;
                }
                return false;
            }
        };
    }

    if (!S.core.quests) S.core.quests = {};
    S.core.quests.LAST_QUEST_MARK = LAST_QUEST_MARK;
    S.core.quests.list     = list;
    S.core.quests.finished = finished;
    S.core.quests.unread   = unread;
    S.core.quests.isLast   = isLast;
    S.core.quests.claim    = claim;
    S.core.quests.read     = read;
    S.core.quests.definition = definition;
    S.core.quests.clickNames = clickNames;

}(Steward));
