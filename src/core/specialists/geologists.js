/*
 * Geologist-specific helpers.
 *
 * Companion to `core/specialists.js` for behaviour that only applies to
 * the geologist family. Filename sort puts this after `specialists.js`,
 * so the parent `S.core.specialists.*` namespace is fully populated by
 * the time we extend it here.
 *
 * What lives here:
 *   - pickDeposits(geologist) — host-aware deposit-type recommendation
 *     (per-spec override → events → host default → empty)
 *   - geologistScoreFor(geo, depositName) — per-(geo, deposit) capacity
 *     and time factors derived from the geologist's trait skills.
 *   - rankGeologistsForDeposit(name, opts) — sorted candidate list,
 *     capacity primary, speed tiebreak.
 *   - bestGeologistForDeposit(name, opts) — top of the ranking with
 *     opts.exclude support so the routing module can dispatch one
 *     geo per wanted slot without picking the same spec twice.
 *
 * What stays in `core/specialists.js`:
 *   - generic listing / classification / status (geologists() listing
 *     sugar, isGeologist(), isProspecting())
 *   - GEOLOGIST_TASK_PACKET — the dispatch-level enum→packet mapping
 *     consumed by the unified send() function alongside its explorer
 *     counterpart. That table is a packet detail, not a behaviour, and
 *     belongs with send().
 */

(function (S) {

    if (!S.core.specialists) S.core.specialists = {};

    function pickDeposits(geologist) {
        // Returns an ordered list of deposit type names the geologist should
        // prioritize. Precedence:
        //   1. mainSettings.geoDefTaskByType[<name>] — per-spec host override
        //   2. event-aware deposit modifiers
        //   3. mainSettings.geoDefTask              — host's global default
        //   4. []                                    — caller falls back to own config
        //
        // The host stores defaults as a single deposit-type index (not a list)
        // so when only the host default applies we return a one-element array.
        // Per-geologist skill weighting plugs in here once the routing module
        // lands.
        var out = [];
        if (!geologist) return out;

        // 1. Per-spec host override (returns a single index → wrap as one-elem list).
        if (S.kernel.host) {
            var perName = S.kernel.host.geoDefTaskByName(S.core.specialists.name(geologist));
            if (typeof perName === 'number') return ['' + perName];
        }

        // 2. Event-aware deposit modifiers.
        try {
            var active = S.core.events.active();
            for (var i = 0; i < active.length; i++) {
                var ev = active[i];
                var data = S.core.events.data && S.core.events.data.events[ev.code];
                if (!data || !data.depositModifier) continue;
                var keys = Object.keys(data.depositModifier);
                for (var k = 0; k < keys.length; k++) out.push(keys[k]);
            }
            if (out.length > 0) return out;
        } catch (e) {
            S.kernel.warn('specialists', 'pickDeposits event eval threw:', e);
        }

        // 3. Host global default.
        if (S.kernel.host) {
            var global = S.kernel.host.geoDefTaskGlobal();
            if (typeof global === 'number') return ['' + global];
        }

        return out;
    }

    // ---------------------------------------------------------------
    // Trait-skill scoring.
    //
    // Each owned geologist carries a trait-skill collection on
    // spec.skills. Per-trait effects target specific deposit
    // type_strings ('FindDepositIronOre', etc.) with two modifiers we
    // care about for routing:
    //
    //   - searchDepositCapacity → multiplies the size of the deposit
    //     the geologist finds. Higher is better. Multiplicative across
    //     stacked effects.
    //   - searchTime            → multiplies the duration of the
    //     search. Lower is better (mul<1 = faster, >1 = slower).
    //     Multiplicative across stacked effects.
    //
    // friendpremiumbuff1 (id=301) is excluded from the score because
    // it applies the same searchTime ×0.8 to every deposit on every
    // geologist — neutral for ranking purposes.
    //
    // Algorithm validated against the user's live dump in
    // docs/analysis/specialists-20260427-120127.json (e.g.
    // stone_cold = cap×2.00 / time×0.50 on Stone/Marble/Granite,
    // sooty = cap×3.00 / time×0.75 on Coal,
    // gold_hearted = cap×2.00 / time×0.50 on Gold).
    // ---------------------------------------------------------------

    var FRIEND_PREMIUM_TRAIT_ID = 301;

    function geologistScoreFor(geo, depositName) {
        var out = { capacityFactor: 1, timeFactor: 1 };
        if (!geo || !geo.skills || typeof geo.skills.getItems_vector !== 'function') return out;
        var typeString = (S.core.deposits && S.core.deposits.depositTypeStringFor)
            ? S.core.deposits.depositTypeStringFor(depositName)
            : ('FindDeposit' + depositName);
        if (!typeString) return out;

        var traits;
        try { traits = geo.skills.getItems_vector(); }
        catch (e) { return out; }
        var tlen = (typeof traits.length === 'number') ? traits.length : 0;

        for (var i = 0; i < tlen; i++) {
            var trait = traits[i];
            if (!trait) continue;
            var sid = -1;
            try { if (typeof trait.getId === 'function') sid = trait.getId(); }
            catch (e) { sid = -1; }
            if (sid === FRIEND_PREMIUM_TRAIT_ID) continue;

            var lvl = -1;
            try { if (typeof trait.getLevel === 'function') lvl = trait.getLevel(); }
            catch (e) { lvl = -1; }
            if (lvl <= 0) continue;

            var def = null;
            try { if (typeof trait.getDefinition === 'function') def = trait.getDefinition(); }
            catch (e) { /* skip */ }
            if (!def || !def.level_vector || !def.level_vector[lvl - 1]) continue;
            var effects = def.level_vector[lvl - 1];
            var elen = (typeof effects.length === 'number') ? effects.length : 0;

            for (var e = 0; e < elen; e++) {
                var eff = effects[e];
                if (!eff) continue;
                if (eff.type_string !== typeString) continue;
                var mod = (eff.modifier_string || '').toLowerCase();
                var mul = (typeof eff.multiplier === 'number') ? eff.multiplier : 1;
                var ch  = (typeof eff.chance === 'number') ? eff.chance : 1;
                var factor = 1 + (mul - 1) * ch;
                if (mod === 'searchdepositcapacity') {
                    out.capacityFactor *= factor;
                } else if (mod === 'searchtime') {
                    out.timeFactor *= factor;
                }
            }
        }
        return out;
    }

    function defaultPool() {
        try { return S.core.specialists.geologists() || []; }
        catch (e) { return []; }
    }

    function rankGeologistsForDeposit(depositName, opts) {
        opts = opts || {};
        var pool = opts.from || defaultPool();
        var exclude = opts.exclude || null;       // object map { uid: true }
        var idleOnly = opts.idleOnly !== false;   // default true
        var c = S.core.specialists;
        var rows = [];

        for (var i = 0; i < pool.length; i++) {
            var geo = pool[i];
            if (!geo) continue;
            if (idleOnly && c.status && c.status(geo) !== S.SpecialistStatus.Idle) continue;
            var uid = c.uniqueIdKey(geo);
            // Without a uid the dispatch could not re-find this entry.
            if (!uid) continue;
            if (exclude && exclude[uid]) continue;

            var s = geologistScoreFor(geo, depositName);
            rows.push({
                geo:            geo,
                uid:            uid,
                capacityFactor: s.capacityFactor,
                timeFactor:     s.timeFactor
            });
        }

        rows.sort(function (a, b) {
            if (a.capacityFactor !== b.capacityFactor) {
                return b.capacityFactor - a.capacityFactor;     // higher cap first
            }
            return a.timeFactor - b.timeFactor;                  // lower time wins tiebreak
        });
        return rows;
    }

    function bestGeologistForDeposit(depositName, opts) {
        opts = opts || {};
        var requirePositive = opts.requirePositive !== false; // default true — only return if there's a real bonus
        var rows = rankGeologistsForDeposit(depositName, opts);
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            if (requirePositive && row.capacityFactor <= 1 && row.timeFactor >= 1) continue;
            return row;
        }
        // If no positive-bias candidate, return the first (vanilla) row so
        // callers that want any-idle-geologist can still get one.
        return (!requirePositive && rows.length) ? rows[0] : null;
    }

    S.core.specialists.pickDeposits             = pickDeposits;
    S.core.specialists.geologistScoreFor        = geologistScoreFor;
    S.core.specialists.rankGeologistsForDeposit = rankGeologistsForDeposit;
    S.core.specialists.bestGeologistForDeposit  = bestGeologistForDeposit;

}(Steward));
