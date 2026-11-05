/*
 * Zone trip of an adventure run: the way out of a wait the game never ends.
 *
 * The client can keep a stale read of the island: a general that finished
 * his battle still reads busy, and a wave waits at its gate for hours. Viewing
 * another zone and coming back makes the client read the island afresh, so a
 * step on the island that has watched a wait for the stuckMinutes setting
 * (0 is off) goes home, stays RESOLVE_HOME_MS there, travels back and enters
 * its step again: a wave step at the Gate of its wave, a series step anew.
 *
 * Only watched time counts. The clock sums the passes that kept a wait going
 * and skips any silence longer than the pass gap, so the time the user spends
 * on another zone (passes stop there) or a busy queue (no pass is planned) is
 * not counted. Any step change starts the clock again.
 *
 * Only the wave steps and the short island steps take the trip. The long ones
 * (the travel to the map, the last quest) wait for the game on purpose, and
 * the home and any-zone steps are not on the island.
 *
 * After RESOLVE_MAX trips at the same wave or series step the next long wait
 * pauses the run (Stuck) instead of travelling again, so a wait no trip fixes
 * does not loop. The trip sends no order: rounds, send markers and lines stay
 * as they were, so nothing goes out twice. A Pause leaves a trip in progress
 * on the run, and nothing travels while paused; Resume ends it and clears the
 * trip count, because the user has looked. The trip and its count live on
 * the run (run.json), so a script reload or a client restart carries on in
 * the same phase.
 *
 * Bundle slot: module file; top level only assigns
 * S.modules.adventures.resolve; state, loader, away and settings are read at
 * call time.
 */

(function (S) {

    if (!S.modules.adventures) S.modules.adventures = {};

    var RESOLVE_HOME_MS = 300000;   // time the trip stays at home before it goes back
    var RESOLVE_MAX     = 2;        // trips per stuck wave or series step before the pause

    var CATEGORY = 'adventures';

    // Send markers of the two jumps, so each keeps its own visit times.
    var HOME_MARK = 'resolveHome';
    var BACK_MARK = 'resolveBack';

    function st() {
        return S.modules.adventures.state;
    }

    function ld() {
        return S.modules.adventures.loader;
    }

    function aw() {
        return S.modules.adventures.away;
    }

    function now() {
        return S.modules.adventures.state.now();
    }

    function log(text) {
        S.kernel.log(CATEGORY, st().label() + ': ' + text);
    }

    // The watched-wait limit in ms; 0 means the trip is off. The stored value
    // and its fallback are read by settings.js alone.
    function limitMs() {
        var a = S.modules.adventures;
        return typeof a.stuckMinutes === 'function' ? a.stuckMinutes() * 60000 : 0;
    }

    // Starts a trip, or pauses once the trips at this stuck position are used
    // up. The text names the wait that did not end.
    function fire(r, ms) {
        var b = st().busyOf(r);
        var what = b ? b.text : 'waiting';
        var mins = Math.round(ms / 60000);
        if (!st().sameStuck(r, r.step)) r.stuck = { step: r.step, wave: r.waveIndex, trips: 0 };
        if (r.stuck.trips >= RESOLVE_MAX) {
            st().pause(S.RunPause.Stuck, 'waited ' + mins + ' min after ' + r.stuck.trips + ' zone trips: ' + what);
            return;
        }
        r.stuck.trips++;
        // Old visit times of an earlier trip must not count for this one.
        ld().dropMark(r, HOME_MARK);
        ld().dropMark(r, BACK_MARK);
        r.resolve = { phase: st().ResolvePhase.Home, at: null };
        st().save();
        log(st().stepName(r.step) + ' waited ' + mins + ' min (' + what + '); zone trip ' + r.stuck.trips + '/' +
            RESOLVE_MAX + ': going home');
    }

    // Feeds the watched-wait clock once per step pass. module.js calls it
    // after the step's own part and before the pass ends, so busySeen tells
    // whether this pass kept a wait going.
    function watch() {
        var r = st().run();
        if (!r || r.status !== S.RunStatus.Running || r.resolve) return;
        if (!st().tripAllowed(r.step)) return;
        var limit = limitMs();
        if (!(limit > 0)) return;
        var q = ld().quietClock(r, st().current().busySeen === true, 'stuckClock');
        if (q.ms < limit) return;
        fire(r, q.ms);
    }

    // Ends the trip through the same re-entry as Resume, but not Resume
    // itself: nobody looked at the game during the trip, so the unseen send
    // markers stay and nothing is sent twice. The trip count stays as well,
    // because the step is entered again at the same stuck position.
    function finish(r, why) {
        ld().dropMark(r, HOME_MARK);
        ld().dropMark(r, BACK_MARK);
        r.resolve = null;
        st().reenter('zone trip done: ' + why);
    }

    // One pass of the trip. module.js calls it instead of the step's part
    // while a trip is under way.
    function plan() {
        var r = st().run();
        if (!r || r.status !== S.RunStatus.Running || !r.resolve) return;
        var P = st().ResolvePhase;
        var v = r.resolve;
        try {
            if (v.phase === P.Home) {
                aw().toHome(r, HOME_MARK, function () {
                    v.phase = P.Wait;
                    v.at = now();
                    st().save();
                    log('zone trip: home loaded, back in ' + RESOLVE_HOME_MS / 60000 + ' min');
                });
                return;
            }
            if (v.phase === P.Wait) {
                // The user went back to the island early.
                if (aw().islandLoaded(r)) {
                    finish(r, 'island viewed again');
                    return;
                }
                if (typeof v.at !== 'number') {
                    v.at = now();
                    st().save();
                }
                if (now() - v.at < RESOLVE_HOME_MS) {
                    ld().waitBusy(r, null, 'zone trip: at home');
                    return;
                }
                v.phase = P.Back;
                st().save();
                log('zone trip: going back to the island');
            }
            if (v.phase === P.Back) {
                aw().toIsland(r, BACK_MARK, function () { finish(r, 'island loaded'); });
            }
        } catch (e) {
            S.kernel.error(CATEGORY, st().label() + ': zone trip (' + v.phase + ') threw:', e);
        }
    }

    S.modules.adventures.resolve = {
        RESOLVE_HOME_MS: RESOLVE_HOME_MS,
        RESOLVE_MAX:     RESOLVE_MAX,
        limitMs:         limitMs,
        watch:           watch,
        plan:            plan
    };

}(Steward));
