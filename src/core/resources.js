/*
 * Player resource reads (read-only).
 *
 * The current amount of a named resource and the free population, taken from
 * the host's resource object. A number is a real reading. null means the host,
 * the method or the value is missing, or the call threw. Callers that verify
 * an effect must treat null as "not observed", never as zero: a failed read
 * must not look like an empty stock. This is the failure contract of the
 * action runner in core/actions.js.
 *
 * It also names the population resource, which unit costs and the population
 * star buff both refer to.
 *
 * Bundle slot: core, after packets.js and before specialists.js (core files
 * load in name order). Nothing here calls another core at load time; the top
 * level only assigns S.core.resources.
 */

(function (S) {

    // The host's resource name for population. It is the only copy: unit costs
    // and the population star buff read it from here at call time.
    var POPULATION = 'Population';

    // The UI status updater reads resource amounts on every refresh, so a
    // persistent host throw would flood the log. The first throw per load is
    // logged; a reload re-runs this file and resets the flag.
    var warnedThrow = false;

    function read(method, arg) {
        try {
            if (typeof game === 'undefined' || !game || typeof game.getResources !== 'function') return null;
            var resources = game.getResources();
            if (!resources || typeof resources[method] !== 'function') return null;
            var n = resources[method](arg);
            return (typeof n === 'number' && !isNaN(n)) ? n : null;
        } catch (e) {
            if (!warnedThrow) {
                warnedThrow = true;
                S.kernel.warn('resources', method + ' threw:', e);
            }
            return null;
        }
    }

    // Amount of one resource by its host name, e.g. 'StripedEggs'.
    function amount(resName) {
        if (typeof resName !== 'string' || !resName) return null;
        return read('GetResourceAmount', resName);
    }

    // Free population: the host's GetFree() value.
    function freePopulation() {
        return read('GetFree', undefined);
    }

    if (!S.core.resources) S.core.resources = {};

    S.core.resources.amount         = amount;
    S.core.resources.freePopulation = freePopulation;
    S.core.resources.POPULATION     = POPULATION;

}(Steward));
