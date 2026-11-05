/*
 * Home steps of an adventure run.
 *
 * Takes a run on the home island from Muster to Depart, and back home from
 * ArriveHome to Next:
 *
 *   Muster -> Validate -> Snapshot -> Supply (-> Unload -> Supply) -> Load
 *   -> Verify -> StartMap -> Depart, then the island ...,
 *   ArriveHome -> Account -> Population -> Retrain -> Next.
 *
 * plan() does one step per call, and only while the home island is viewed.
 * The scheduler calls it only while no adventures queue entry is pending, so
 * a step always observes the game first: when the effect it wants is already
 * there (a general home and idle, the map listed, the population risen, the
 * order queued) it moves on without sending. Every order that must not go
 * out twice (map start, each departure, the population buff, each training
 * order) carries a persisted send marker, so a reload or a kernel Pause
 * right after a send waits for the effect and then pauses instead of
 * sending again. A failed read holds the step, with no limit: an unreadable
 * source is never taken for an empty one.
 *
 * The troops at home are counted before the load (free pool plus every
 * general plus what is still queued), so after the map the lost troops are
 * exactly that count minus the same count now. Population and Retrain
 * recompute what is missing from the game on every pass, so an order that
 * reached the queue drops out of the plan by itself.
 *
 * Bundle slot: module file; top level only assigns
 * S.modules.adventures.home; state, loader, executor and every core are read
 * at call time.
 */

(function (S) {

    if (!S.modules.adventures) S.modules.adventures = {};

    // Starting values, to be tuned in game.
    var GAP_MS                 = 180000;    // the game wants this long between two maps
    var PRODUCTION_WAIT_MAX_MS = 21600000;  // the home load waits this long for queued troops

    var CATEGORY = 'adventures';

    // Mark name prefixes: one mark per general sent and per unit ordered.
    var DEPART = 'depart:';
    var ORDER  = 'order:';

    function has(obj, key) {
        return Object.prototype.hasOwnProperty.call(obj, key);
    }

    function st() {
        return S.modules.adventures.state;
    }

    function ld() {
        return S.modules.adventures.loader;
    }

    function now() {
        return S.modules.adventures.state.now();
    }

    function log(text) {
        S.kernel.log(CATEGORY, st().label() + ': ' + text);
    }

    // Built at call time: state.js fills S.RunStep and loads after this file
    // in name order.
    function homeSteps() {
        var RS = S.RunStep;
        return { supply: RS.Supply, unload: RS.Unload, load: RS.Load, verify: RS.Verify, done: RS.StartMap };
    }

    function specOf(key) {
        return S.core.specialists.lookup(key).spec;
    }

    // Logs a wait once per run and step instead of on every pass. Kept in
    // memory only: after a reload the wait is logged once more.
    function noteOnce(r, text) {
        var rs = st().current();
        var tag = r.id + ':' + r.step + ':' + text;
        if (rs.homeNote === tag) return;
        rs.homeNote = tag;
        log(text);
    }

    function loadoutLines(r) {
        return ld().linesOf(r, r.loadoutPath, -1, 'loadout');
    }

    // ---- Gathering ----------------------------------------------------------

    // Key of the first loadout general this read does not list, or null.
    function firstAbsent(r, inv) {
        var keys = ld().keysOf(r);
        for (var i = 0; i < keys.length; i++) {
            if (!ld().gen(inv, keys[i])) return keys[i];
        }
        return null;
    }

    function waitAbsent(r, inv, key) {
        ld().waitBusy(r, key, ld().who(inv, key) + ' not here yet');
    }

    // Holds until every loadout general is listed at home, idle and not
    // travelling, then goes to next. Both a busy general and one not listed
    // are waited for with no limit: he gets ready or comes back by himself, and
    // the game's remaining time runs short, so nothing is built on it. A list
    // that cannot prove his absence never reaches this step, listHold stops it.
    function gather(r, inv, next, why) {
        var absent = firstAbsent(r, inv);
        if (absent !== null) {
            waitAbsent(r, inv, absent);
            return;
        }
        var keys = ld().keysOf(r);
        for (var i = 0; i < keys.length; i++) {
            var g = ld().gen(inv, keys[i]);
            if (!g.idle || g.travelling) {
                ld().waitBusy(r, keys[i], ld().who(inv, keys[i]) + ' busy');
                return;
            }
        }
        st().go(next, why);
    }

    // ---- Before the map -----------------------------------------------------

    function muster(r, inv) {
        var q = st().current().request;
        var closedAt = q && typeof q.closedAt === 'number' ? q.closedAt : null;
        if (closedAt !== null && now() < closedAt + GAP_MS) {
            noteOnce(r, 'waiting ' + Math.round(GAP_MS / 1000) + ' s after the last map');
            return;
        }
        gather(r, inv, S.RunStep.Validate, 'generals home');
    }

    function sameKeys(a, b) {
        var k;
        a = a || {};
        b = b || {};
        for (k in a) if (has(a, k) && !has(b, k)) return false;
        for (k in b) if (has(b, k) && !has(a, k)) return false;
        return true;
    }

    // The template's files are checked again now that the generals are home,
    // since they may have been edited while the run waited. Camps are not
    // checked: they belong to an island that is not open yet. A check over a
    // list that lost entries proves nothing, so the step runs again. A loadout
    // general who is not listed is waited for with no limit, as at Muster: his
    // absence is the game's state, and only a fault in the files pauses. He is
    // looked for first, because every pass of a wait would otherwise read all
    // the files and log a start check. One who leaves between that look and the
    // check shows up as a problem on a loadout key, so it is filtered by code;
    // a key outside the loadout, like a wave naming a stranger, stays a fault.
    function validate(r, inv) {
        var gone = firstAbsent(r, inv);
        if (gone !== null) {
            waitAbsent(r, inv, gone);
            return;
        }
        var c = S.modules.adventures.executor.check({ label: r.label, loadout: r.loadoutPath, waves: r.paths },
            { camps: false });
        if (c.listOk === false) {
            ld().waitRead(r, 'specialist list');
            return;
        }
        for (var i = 0; i < c.warnings.length; i++) log('warning: ' + c.warnings[i].message);
        var fatal = [];
        for (var j = 0; j < c.problems.length; j++) {
            var p = c.problems[j];
            if (p.code === S.BattleProblem.MissingGeneral && has(r.loadoutKeys || {}, p.key)) {
                if (gone === null) gone = p.key;
            } else {
                fatal.push(p);
            }
        }
        if (!c.ok && (fatal.length || gone === null)) {
            var msg = fatal.length ? fatal[0].message : 'loadout cannot be read';
            st().pause(S.RunPause.WaveFile, msg + ' (' + fatal.length + ' problem(s))');
            return;
        }
        if (!sameKeys(c.loadoutKeys, r.loadoutKeys)) {
            st().pause(S.RunPause.WaveFile,
                'the loadout names other generals than at start; Stop and start the run again');
            return;
        }
        if (gone !== null) {
            waitAbsent(r, inv, gone);
            return;
        }
        st().go(S.RunStep.Snapshot, 'template checked');
    }

    // Units the loadout carries into the field.
    function loadoutUnits(lines) {
        var sup = S.core.battles.supplyWave(lines);
        var all = {};
        for (var i = 0; i < sup.length; i++) all = S.core.army.add(all, sup[i].army);
        var units = [];
        for (var u in all) if (has(all, u)) units.push(u);
        units.sort();
        return units;
    }

    // Troops at home per loadout unit, free pool plus generals plus queued.
    // A snapshot already taken (a resume or a reload) is kept: the troops may
    // have moved since.
    function snapshot(r, inv) {
        // Only Account, Population and Retrain read the snapshot, and taking it
        // can hold or pause the run, so a run that retrains nothing skips it.
        if (r.retrain === false) {
            st().go(S.RunStep.Supply, 'retrain off');
            return;
        }
        if (r.snapshot) {
            st().go(S.RunStep.Supply, 'snapshot kept');
            return;
        }
        var ln = loadoutLines(r);
        if (!ln.ok) {
            st().pause(S.RunPause.WaveFile, ln.message);
            return;
        }
        if (!inv.ok) {
            ld().waitRead(r, 'troops');
            return;
        }
        var units = loadoutUnits(ln.lines);
        var snap = {};
        for (var i = 0; i < units.length; i++) {
            var q = S.core.production.queued(units[i]);
            if (typeof q !== 'number') {
                ld().waitRead(r, 'production queue of ' + units[i]);
                return;
            }
            snap[units[i]] = (inv.total[units[i]] || 0) + q;
        }
        r.snapshot = snap;
        log('snapshot: ' + S.core.army.text(snap));
        st().go(S.RunStep.Supply, 'troops counted');
    }

    // Supply lines of the loadout (Star lines carry no troops), or null after
    // a pause.
    function loadoutSupply(r) {
        var ln = loadoutLines(r);
        if (!ln.ok) {
            st().pause(S.RunPause.WaveFile, ln.message);
            return null;
        }
        return S.core.battles.supplyWave(ln.lines);
    }

    // Troops still in production are waited for: at home the queue fills the
    // free pool by itself.
    function supplyStep(r, inv) {
        var sup = loadoutSupply(r);
        if (sup) ld().supply(r, sup, inv, homeSteps(), { waitQueued: true, waitMaxMs: PRODUCTION_WAIT_MAX_MS });
    }

    function loadOrders(r, inv) {
        var sup = loadoutSupply(r);
        if (sup) ld().load(r, sup, inv, homeSteps());
    }

    function verifyStep(r, inv) {
        var sup = loadoutSupply(r);
        if (sup) ld().verify(r, sup, inv, homeSteps());
    }

    function unloadStep(r, inv) {
        ld().unload(r, inv, homeSteps());
    }

    function verifiedIn(round, key) {
        var res = ld().resultOf(round, key);
        return !!res && res.status === S.ActionResult.Verified;
    }

    // The map is open once it is listed among the player's adventures; its
    // zone id is then the run's island. An open map of that name is taken as
    // it is, so a map started by hand is not started twice.
    function startMap(r) {
        var RS = S.RunStep;
        var id = S.core.adventures.zoneIdOf(r.adventure);
        if (typeof id === 'number') {
            r.zoneId = id;
            if (ld().marked(r, 'map')) ld().markSeen(r, 'map');
            log('map open: zone ' + id);
            st().go(RS.Depart, 'map open');
            return;
        }
        if (S.core.adventures.own() === null) {
            ld().waitRead(r, 'adventure list');
            return;
        }
        var m = ld().marked(r, 'map');
        var round = ld().currentRound(r, RS.StartMap);
        if ((m && m.seen) || (round && ld().complete(round) && verifiedIn(round, 'map'))) {
            // A start the game confirmed but whose map is not listed yet. The
            // wait runs from the send, or from a Resume, never sends again.
            var from = m && typeof m.sentAt === 'number' ? Math.max(m.sentAt, r.since) : r.since;
            if (now() - from > ld().ORDER_WAIT_MS) {
                st().pause(S.RunPause.MapFailed, 'map started but not listed among your adventures');
                return;
            }
            ld().waitSent(r, 'map start');
            return;
        }
        var s = ld().staleMark(r, 'map', 'map start');
        if (s === 'wait') return;
        if (s === 'stale') {
            st().pause(S.RunPause.NotObserved,
                'map start sent but not seen; check the star menu, then Resume');
            return;
        }
        var next = ld().settleRound(r, RS.StartMap, function (f) {
            st().pause(S.RunPause.MapFailed, 'start map failed: ' + f.reason);
        }, 'map start');
        if (next !== 'new') return;
        var nr = ld().startRound(r, RS.StartMap, []);
        ld().attempt(nr, 'map', ld().wrapSend(r, 'map', S.core.buffs.map(r.adventure)), ld().seenOnVerified('map'));
    }

    // Sends every loadout general to the island once. A general counts as
    // departed while it travels, or once it left the home list after a send
    // of ours; a general that left without one is not where the run thinks.
    function depart(r, inv) {
        var RS = S.RunStep;
        if (typeof r.zoneId !== 'number') {
            st().go(RS.StartMap, 'no island zone id');
            return;
        }
        var keys = ld().keysOf(r);
        var toSend = [];
        var busy = null;
        var travelling = [];
        var open = [];
        var i;
        for (i = 0; i < keys.length; i++) {
            var k = keys[i];
            var name = DEPART + k;
            var m = ld().marked(r, name);
            var g = ld().gen(inv, k);
            if (!g) {
                if (m && (m.sentOnce || m.seen)) {
                    if (!m.seen) ld().markSeen(r, name);
                    continue;
                }
                if (!ld().missingLong(r, k)) return;
                st().pause(S.RunPause.GeneralMissing, k + ' left home without being sent', { general: k });
                return;
            }
            if (ld().leaving(g, k)) {
                if (!m || !m.seen) ld().markSeen(r, name);
                travelling.push({ key: k, spec: specOf(k) });
                continue;
            }
            open.push(name);
            if (g.idle) toSend.push(k);
            else if (busy === null) busy = k;
        }

        if (!toSend.length && busy === null) {
            departed(r, travelling, keys.length);
            return;
        }
        if (busy !== null) ld().waitBusy(r, busy, ld().who(inv, busy) + ' busy and cannot leave yet');
        if (!toSend.length) return;

        for (i = 0; i < toSend.length; i++) {
            var s = ld().staleMark(r, DEPART + toSend[i], 'departure of ' + toSend[i], { seen: true });
            if (s === 'wait') return;
            if (s === 'stale') {
                st().pause(S.RunPause.NotObserved, 'departure of ' + toSend[i] +
                    ' sent but not seen; check the general, then Resume', { general: toSend[i] });
                return;
            }
        }
        ld().dropShown(r, RS.Depart, open);
        var next = ld().settleRound(r, RS.Depart, function (f) {
            var key = f.key.indexOf(DEPART) === 0 ? f.key.substring(DEPART.length) : f.key;
            st().pause(S.RunPause.DepartFailed, 'send ' + key + ' failed: ' + f.reason, { general: key });
        }, 'departure');
        if (next !== 'new') return;
        var round = ld().startRound(r, RS.Depart, []);
        for (i = 0; i < toSend.length; i++) sendOne(r, round, toSend[i]);
    }

    function sendOne(r, round, key) {
        var name = DEPART + key;
        ld().attempt(round, name, ld().wrapSend(r, name, S.core.specialists.orders.sendToZone(key, r.zoneId)),
            ld().seenOnVerified(name));
    }

    // Every general is on its way. The game's remaining time is logged only: it
    // runs short, so the arrival is waited for by what the island shows. An
    // 'arrive' mark left in an older run file is read by nothing.
    function departed(r, travelling, n) {
        var raw = [];
        for (var i = 0; i < travelling.length; i++) {
            raw.push(travelling[i].key + '=' + S.core.specialists.orders.remaining(travelling[i].spec));
        }
        if (raw.length) log('remaining travel (raw): ' + raw.join(', '));
        st().go(S.RunStep.Jump, n + ' general(s) departed');
    }

    // ---- After the map ------------------------------------------------------

    function arriveHome(r, inv) {
        gather(r, inv, S.RunStep.Account, 'generals home');
    }

    // Troops missing against the snapshot, from the game as it is now:
    // { ok, orders: [{ unit, count }], lost: { unit: n } }. ok is false while
    // any count cannot be read.
    function missing(r, inv) {
        var out = { ok: false, orders: [], lost: {} };
        if (!inv.ok || !r.snapshot) return out;
        var units = [];
        for (var u in r.snapshot) if (has(r.snapshot, u)) units.push(u);
        units.sort();
        for (var i = 0; i < units.length; i++) {
            var q = S.core.production.queued(units[i]);
            if (typeof q !== 'number') return out;
            var n = r.snapshot[units[i]] - ((inv.total[units[i]] || 0) + q);
            if (n > 0) {
                out.orders.push({ unit: units[i], count: n });
                out.lost[units[i]] = n;
            }
        }
        out.ok = true;
        return out;
    }

    function account(r, inv) {
        if (!r.snapshot) {
            if (r.retrain === false) {
                log('retrain off; retraining skipped');
                st().go(S.RunStep.Next, 'retrain off');
                return;
            }
            log('no troop snapshot (run started on an open map); retraining skipped');
            st().go(S.RunStep.Next, 'no snapshot');
            return;
        }
        var m = missing(r, inv);
        if (!m.ok) {
            ld().waitRead(r, 'troops or production queues');
            return;
        }
        log('lost: ' + (m.orders.length ? S.core.army.text(m.lost) : 'none'));
        st().go(S.RunStep.Population, 'troops counted');
    }

    function shortText(list) {
        var out = [];
        for (var i = 0; i < list.length; i++) {
            out.push(list[i].name + ' ' + list[i].need + '/' + (list[i].have === null ? '?' : list[i].have));
        }
        return out.join('; ');
    }

    // Tops up free population to what the retrain orders need, with as few
    // buffs as the stock allows. A buff counts only once free population has
    // risen above the value read before it: a buff the game confirms but
    // that does not raise free population pauses, so the stock is never
    // spent buff after buff.
    function population(r, inv) {
        var RS = S.RunStep;
        var m = missing(r, inv);
        if (!m.ok) {
            ld().waitRead(r, 'troops or production queues');
            return;
        }
        if (!m.orders.length) {
            st().go(RS.Next, 'nothing to retrain');
            return;
        }
        var j = S.core.production.jointShortfalls(m.orders);
        if (j === null) {
            ld().waitRead(r, 'unit costs');
            return;
        }
        var popLine = null;
        var others = [];
        for (var i = 0; i < j.length; i++) {
            if (j[i].name === S.core.resources.POPULATION) popLine = j[i];
            else others.push(j[i]);
        }
        if (popLine && popLine.have === null) {
            ld().waitRead(r, 'free population');
            return;
        }
        // Any other shortage stops the series before anything is spent: the
        // orders are paid from one stock, so a partial retrain helps nobody.
        if (others.length) {
            st().pause(S.RunPause.RetrainShort, 'cannot retrain: ' + shortText(j));
            return;
        }
        var popShort = popLine ? popLine.need - popLine.have : 0;
        if (popShort <= 0) {
            ld().dropMark(r, 'population');
            st().go(RS.Retrain, 'population covers the orders');
            return;
        }

        var pm = ld().marked(r, 'population');
        if (pm && typeof pm.sentAt === 'number') {
            var free = S.core.resources.freePopulation();
            if (typeof r.popBase === 'number' && typeof free === 'number' && free > r.popBase) {
                ld().dropMark(r, 'population');
                st().go(RS.Population, 'topped up ' + (free - r.popBase));
                return;
            }
            if (pm.seen) {
                // Free population may update after the buff stock does; it
                // gets the wait of an order, from the send or from a Resume.
                if (now() - Math.max(pm.sentAt, r.since) < ld().ORDER_WAIT_MS) {
                    ld().waitSent(r, 'population buff');
                    return;
                }
                st().pause(S.RunPause.RetrainFailed, 'population buff verified but free population did not rise');
                return;
            }
            var s = ld().staleMark(r, 'population', 'population buff');
            if (s === 'wait') return;
            if (s === 'stale') {
                st().pause(S.RunPause.NotObserved,
                    'population buff sent but free population did not rise; check the star menu, then Resume');
                return;
            }
        }

        var stock = S.core.buffs.populationStock();
        if (stock === null) {
            ld().waitRead(r, 'population buff stock');
            return;
        }
        if (popShort > stock.total) {
            st().pause(S.RunPause.RetrainShort, 'cannot retrain: ' + shortText(j) +
                ' (population buffs in stock: ' + stock.total + ')');
            return;
        }
        var next = ld().settleRound(r, RS.Population, function (f) {
            st().pause(S.RunPause.RetrainFailed, 'population buff failed: ' + f.reason);
        }, 'population buff');
        if (next !== 'new') return;
        var base = S.core.resources.freePopulation();
        if (typeof base !== 'number') {
            ld().waitRead(r, 'free population');
            return;
        }
        r.popBase = base;
        var amount = Math.min(popShort, stock.largest);
        var round = ld().startRound(r, RS.Population, []);
        // wrapSend saves the run before the send, so popBase is persisted
        // together with the mark.
        ld().attempt(round, 'population', ld().wrapSend(r, 'population', S.core.buffs.population(amount)),
            ld().seenOnVerified('population'));
    }

    // Orders every missing unit in its own queue (barracks or elite
    // barracks). An order whose units reached the queue drops out of the
    // recomputed plan, and its mark with it. A verified order keeps its mark
    // until then, so a queue that lags gets no second order.
    function retrain(r, inv) {
        var RS = S.RunStep;
        var m = missing(r, inv);
        if (!m.ok) {
            ld().waitRead(r, 'troops or production queues');
            return;
        }
        var want = {};
        var i;
        for (i = 0; i < m.orders.length; i++) want[m.orders[i].unit] = m.orders[i].count;
        var names = [];
        for (var name in (r.marks || {})) {
            if (has(r.marks, name) && name.indexOf(ORDER) === 0 && !has(want, name.substring(ORDER.length))) {
                names.push(name);
            }
        }
        for (i = 0; i < names.length; i++) ld().dropMark(r, names[i]);
        if (!m.orders.length) {
            st().go(RS.Next, 'retrain ordered');
            return;
        }
        for (i = 0; i < m.orders.length; i++) {
            var u = m.orders[i].unit;
            var s = ld().staleMark(r, ORDER + u, 'order of ' + u, { seen: true });
            if (s === 'wait') return;
            if (s === 'stale') {
                st().pause(S.RunPause.NotObserved, 'order of ' + u +
                    ' sent but not seen in the queue; check the barracks, then Resume');
                return;
            }
        }
        var next = ld().settleRound(r, RS.Retrain, function (f) {
            var unit = f.key.indexOf(ORDER) === 0 ? f.key.substring(ORDER.length) : f.key;
            st().pause(S.RunPause.RetrainFailed, 'order ' + unit + ' failed: ' + f.reason);
        }, 'retrain');
        if (next !== 'new') return;
        log('retrain: ' + S.core.army.text(want));
        var round = ld().startRound(r, RS.Retrain, []);
        for (i = 0; i < m.orders.length; i++) orderOne(r, round, m.orders[i]);
    }

    function orderOne(r, round, o) {
        var name = ORDER + o.unit;
        ld().attempt(round, name, ld().wrapSend(r, name, S.core.production.order(o.unit, o.count)),
            ld().seenOnVerified(name));
    }

    // Counts the run and starts the next one at Muster, or ends the series.
    // The counter is saved together with the new run (begin) or the done
    // state, so a reload in between repeats this step instead of counting a
    // run twice.
    function nextRun(r) {
        var q = st().current().request;
        var finished = st().finishedRuns() + 1;
        var total = st().requestedRuns();
        if (q) q.finished = finished;
        S.kernel.log(CATEGORY, 'run ' + finished + '/' + total + ' done: ' + r.label);
        if (!q || finished >= total) {
            st().done();
            return;
        }
        st().begin(q, st().newRun({
            // A new id, so nothing of the finished run is taken for this one.
            id:          Math.max(now(), r.id + 1),
            templateId:  r.templateId,
            label:       r.label,
            adventure:   r.adventure,
            zoneId:      null,
            paths:       r.paths,
            loadoutPath: r.loadoutPath,
            loadoutKeys: r.loadoutKeys,
            waveIndex:   0,
            step:        S.RunStep.Muster,
            speedBuff:   r.speedBuff,
            retrain:     r.retrain
        }));
        S.kernel.log(CATEGORY, 'run ' + (finished + 1) + '/' + total + ' begins: ' + r.label);
    }

    // Built at call time: state.js fills S.RunStep and loads after this file
    // in name order.
    function stepFn(step) {
        var RS = S.RunStep;
        if (step === RS.Muster)     return muster;
        if (step === RS.Validate)   return validate;
        if (step === RS.Snapshot)   return snapshot;
        if (step === RS.Supply)     return supplyStep;
        if (step === RS.Unload)     return unloadStep;
        if (step === RS.Load)       return loadOrders;
        if (step === RS.Verify)     return verifyStep;
        if (step === RS.StartMap)   return startMap;
        if (step === RS.Depart)     return depart;
        if (step === RS.ArriveHome) return arriveHome;
        if (step === RS.Account)    return account;
        if (step === RS.Population) return population;
        if (step === RS.Retrain)    return retrain;
        if (step === RS.Next)       return nextRun;
        return null;
    }

    // One home step of the running run. Holds (no send, no pause) while
    // another zone is viewed or the specialist list lost entries or cannot
    // be read, because the steps read a general absent from the list as a
    // fact. A throw leaves the step as it is for the next call.
    function plan() {
        var r = st().run();
        if (!r || r.status !== S.RunStatus.Running) return;
        if (st().partOf(r.step) !== 'home') return;
        if (S.core.zone.isHome() !== true) return;
        var step = r.step;
        try {
            var fn = stepFn(step);
            if (!fn) return;
            var inv = S.core.army.inventory();
            if (ld().listHold(r, inv)) return;
            fn(r, inv);
        } catch (e) {
            S.kernel.error(CATEGORY, st().label() + ': step ' + st().stepName(step) + ' threw:', e);
        }
    }

    S.modules.adventures.home = {
        GAP_MS:                 GAP_MS,
        PRODUCTION_WAIT_MAX_MS: PRODUCTION_WAIT_MAX_MS,
        plan:                   plan
    };

}(Steward));
