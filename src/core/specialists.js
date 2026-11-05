/*
 * Specialist library.
 *
 * Steward classifies generals vs carriers itself — the host engine collapses
 * them to raw type 0 and a Carrier "looks like" a General until you check
 * whether it can attack. The classify() implementation is provisional:
 * capability-flag first, capacity-threshold (>330) fallback. P2 SPIKE: this
 * needs validation against the live client; document the chosen mechanism in
 * docs/CORE_USAGE.md once confirmed.
 *
 * Modules consult these helpers and never compare against bare strings —
 * always use Steward.SpecialistType.* / Steward.SpecialistStatus.* enums.
 */

(function (S) {

    // --- Enums populated here so they're available the moment this file runs.
    S.SpecialistType.General        = 'SpecialistGeneral';
    S.SpecialistType.Carrier        = 'SpecialistCarrier';
    S.SpecialistType.Admiral        = 'SpecialistAdmiral';
    S.SpecialistType.AdmiralCarrier = 'SpecialistAdmiralCarrier';
    S.SpecialistType.Explorer       = 'SpecialistExplorer';
    S.SpecialistType.Geologist      = 'SpecialistGeologist';

    S.SpecialistStatus.Idle        = 'StatusIdle';
    S.SpecialistStatus.Working     = 'StatusWorking';
    S.SpecialistStatus.Traveling   = 'StatusTraveling';
    S.SpecialistStatus.Returning   = 'StatusReturning';
    S.SpecialistStatus.Unavailable = 'StatusUnavailable';

    S.SkillModifier.SearchTime = 'ModifierSearchTime';
    S.SkillModifier.LootRolls  = 'ModifierLootRolls';
    S.SkillModifier.LootAmount = 'ModifierLootAmount';
    S.SkillModifier.Other      = 'ModifierOther';

    // Explorer tasks come in two families. Treasure searches (taskId=1)
    // include five "standard" durations + two skill-locked variants. Adventure
    // zone searches (taskId=2) are a separate family for finding adventure
    // zones (the activity that DROPS adventures, not adventure-zone-internal
    // explorer tasks). Source: tso_client/.../4-specialists.js:21-33.
    //
    // The previous shape merged 1,4 / 1,5 with the adventure family, which
    // was wrong: 1,4 (FindTreasureTravellingErudite) and 1,5
    // (FindTreasureBeanACollada) are skill-locked TREASURE searches.
    S.ExplorerTask.Short                 = 'TaskExplorerShort';                // 1,0
    S.ExplorerTask.Medium                = 'TaskExplorerMedium';               // 1,1
    S.ExplorerTask.Long                  = 'TaskExplorerLong';                 // 1,2
    S.ExplorerTask.EvenLonger            = 'TaskExplorerEvenLonger';           // 1,3
    S.ExplorerTask.TravellingErudite     = 'TaskExplorerTravellingErudite';    // 1,4 — skill 39
    S.ExplorerTask.BeanACollada          = 'TaskExplorerBeanACollada';         // 1,5 — skill 40
    S.ExplorerTask.Prolonged             = 'TaskExplorerProlonged';            // 1,6
    S.ExplorerTask.AdventureZoneShort    = 'TaskExplorerAdvZoneShort';         // 2,0
    S.ExplorerTask.AdventureZoneMedium   = 'TaskExplorerAdvZoneMedium';        // 2,1
    S.ExplorerTask.AdventureZoneLong     = 'TaskExplorerAdvZoneLong';          // 2,2
    S.ExplorerTask.AdventureZoneVeryLong = 'TaskExplorerAdvZoneVeryLong';      // 2,3

    S.GeologistTask.Search = 'TaskGeologistSearch';                 // raw 0

    // Map enum → { taskId, subTaskId } for the dispatch packet.
    //
    // The host's SendServerAction(95, taskId, 0, 0, dStartSpecialistTaskVO)
    // expects taskId to identify the *task family* and the dVO's subTaskID
    // to pick the variant. Live-spike confirmed working explorer tasks return
    // GetTask().GetType()={1,2} and GetSubType()={0..6}.
    //
    //   - Explorer treasure searches:        taskId=1
    //   - Explorer adventure-zone searches:  taskId=2
    //   - Geologist deposit search:          taskId=0
    //
    // autoTSO/user_auto.js:743-750 confirms: sendExplorer passes taskId
    // (via finalTask[0]); sendGeologist passes taskId=0 (literal).
    var EXPLORER_TASK_PACKET = {};
    EXPLORER_TASK_PACKET[S.ExplorerTask.Short]                 = { taskId: 1, subTaskId: 0 };
    EXPLORER_TASK_PACKET[S.ExplorerTask.Medium]                = { taskId: 1, subTaskId: 1 };
    EXPLORER_TASK_PACKET[S.ExplorerTask.Long]                  = { taskId: 1, subTaskId: 2 };
    EXPLORER_TASK_PACKET[S.ExplorerTask.EvenLonger]            = { taskId: 1, subTaskId: 3 };
    EXPLORER_TASK_PACKET[S.ExplorerTask.TravellingErudite]     = { taskId: 1, subTaskId: 4 };
    EXPLORER_TASK_PACKET[S.ExplorerTask.BeanACollada]          = { taskId: 1, subTaskId: 5 };
    EXPLORER_TASK_PACKET[S.ExplorerTask.Prolonged]             = { taskId: 1, subTaskId: 6 };
    EXPLORER_TASK_PACKET[S.ExplorerTask.AdventureZoneShort]    = { taskId: 2, subTaskId: 0 };
    EXPLORER_TASK_PACKET[S.ExplorerTask.AdventureZoneMedium]   = { taskId: 2, subTaskId: 1 };
    EXPLORER_TASK_PACKET[S.ExplorerTask.AdventureZoneLong]     = { taskId: 2, subTaskId: 2 };
    EXPLORER_TASK_PACKET[S.ExplorerTask.AdventureZoneVeryLong] = { taskId: 2, subTaskId: 3 };

    // Inverse: (taskId, subTaskId) → ExplorerTask enum. Used by currentTask
    // to decode a busy explorer's GetTask().GetType()/.GetSubType() pair, and
    // by callers that read host settings (treasure-only context — pass 1 as
    // taskId).
    var RAW_TO_EXPLORER_TASK = {
        1: {
            0: S.ExplorerTask.Short,
            1: S.ExplorerTask.Medium,
            2: S.ExplorerTask.Long,
            3: S.ExplorerTask.EvenLonger,
            4: S.ExplorerTask.TravellingErudite,
            5: S.ExplorerTask.BeanACollada,
            6: S.ExplorerTask.Prolonged
        },
        2: {
            0: S.ExplorerTask.AdventureZoneShort,
            1: S.ExplorerTask.AdventureZoneMedium,
            2: S.ExplorerTask.AdventureZoneLong,
            3: S.ExplorerTask.AdventureZoneVeryLong
        }
    };

    var GEOLOGIST_TASK_PACKET = {};
    // Geologists: taskId=0, subTaskId is the deposit-type index supplied
    // by the caller (since one geologist enum represents many deposits).
    GEOLOGIST_TASK_PACKET[S.GeologistTask.Search] = { taskId: 0, subTaskId: 0 };

    // Skill IDs the host uses for explorer task gating. Sourced from the
    // `req` arrays in tso_client/.../4-specialists.js:21-27 and the host's
    // skill check in createExplorerDropdown (line 311). Skill 39 unlocks
    // FindTreasureTravellingErudite (1,4); skill 40 unlocks
    // FindTreasureBeanACollada (1,5).
    if (!S.ExplorerSkill) S.ExplorerSkill = {};
    S.ExplorerSkill.TravellingErudite = 39;
    S.ExplorerSkill.BeanACollada      = 40;

    // Per-task capability descriptor — mirrors the host's `req` arrays so
    // the dashboard / pickTask filter mirrors what the host's dropdown
    // shows. [enum, needsErudite, needsBeanACollada, requiredPlayerLevel].
    // Source: tso_client/.../4-specialists.js:19-35.
    var TASK_REQUIREMENTS = [
        [S.ExplorerTask.Short,                 false, false,  8],
        [S.ExplorerTask.Medium,                false, false, 20],
        [S.ExplorerTask.Long,                  false, false, 32],
        [S.ExplorerTask.EvenLonger,            false, false, 40],
        [S.ExplorerTask.Prolonged,             false, false, 54],
        [S.ExplorerTask.TravellingErudite,     true,  false,  0],
        [S.ExplorerTask.BeanACollada,          false, true,   0],
        [S.ExplorerTask.AdventureZoneShort,    false, false, 26],
        [S.ExplorerTask.AdventureZoneMedium,   false, false, 36],
        [S.ExplorerTask.AdventureZoneLong,     false, false, 42],
        [S.ExplorerTask.AdventureZoneVeryLong, false, false, 56]
    ];

    // Specialist type taxonomy.
    //
    // The host's GetType() returns many integers — beyond {0=General,
    // 1=Explorer, 2=Geologist} there are specials like Marshal (18),
    // Courageous Explorer (32), Admiral, etc. The instance method
    // GetBaseType() partially normalizes (Courageous Explorer → 1) but not
    // for all variants (Marshal → 18, NOT 0).
    //
    // Canonical normalization: ask the *type definition* for its base type:
    //   game.def('Specialists::cSpecialist').GetSpecialistDescriptionForType(typeNum).getBaseType()
    //
    // Confirmed mechanism via tso_client/.../4-specialists.js:73-77 and
    // 8-shortcuts.js:228 (`armySPECIALIST_TYPE.IsGeneral(item.GetType())`).
    //
    // Carrier detection: a Carrier is a General whose specialist description
    // returns isTransportGeneral() === true. Confirmed via
    // autoTSO/user_auto.js:6688 (`a.GetSpecialistDescription().isTransportGeneral()`).

    var BASE_GENERAL   = 0;
    var BASE_EXPLORER  = 1;
    var BASE_GEOLOGIST = 2;

    var armySpecTypeEnum = null;            // cached host enum (Enums::SPECIALIST_TYPE)
    var cSpecialistClass = null;            // cached host class (Specialists::cSpecialist)

    function getArmySpecTypeEnum() {
        if (armySpecTypeEnum !== null) return armySpecTypeEnum;
        try {
            if (typeof swmmo !== 'undefined' && swmmo && typeof swmmo.getDefinitionByName === 'function') {
                armySpecTypeEnum = swmmo.getDefinitionByName('Enums::SPECIALIST_TYPE') || false;
            } else if (typeof game !== 'undefined' && game && typeof game.def === 'function') {
                armySpecTypeEnum = game.def('Enums::SPECIALIST_TYPE') || false;
            } else {
                armySpecTypeEnum = false;
            }
        } catch (e) { armySpecTypeEnum = false; }
        return armySpecTypeEnum || null;
    }

    function getCSpecialist() {
        if (cSpecialistClass !== null) return cSpecialistClass;
        try {
            if (typeof game !== 'undefined' && game && typeof game.def === 'function') {
                cSpecialistClass = game.def('Specialists::cSpecialist') || false;
            } else {
                cSpecialistClass = false;
            }
        } catch (e) { cSpecialistClass = false; }
        return cSpecialistClass || null;
    }

    function rawType(spec) {
        if (!spec) return null;
        try {
            if (typeof spec.GetType === 'function') return spec.GetType();
        } catch (e) { /* fall through */ }
        return null;
    }

    function specDescription(spec) {
        if (!spec) return null;
        try {
            if (typeof spec.GetSpecialistDescription === 'function') {
                return spec.GetSpecialistDescription();
            }
        } catch (e) { /* fall through */ }
        // Fallback: look up via the static class given the type id.
        try {
            var cls = getCSpecialist();
            var rt = rawType(spec);
            if (cls && rt !== null && typeof cls.GetSpecialistDescriptionForType === 'function') {
                return cls.GetSpecialistDescriptionForType(rt);
            }
        } catch (e2) { /* fall through */ }
        return null;
    }

    function baseTypeOf(typeNum) {
        if (typeof typeNum !== 'number') return null;
        // Fast path: the standard three already match their base.
        if (typeNum === BASE_GENERAL)   return BASE_GENERAL;
        if (typeNum === BASE_EXPLORER)  return BASE_EXPLORER;
        if (typeNum === BASE_GEOLOGIST) return BASE_GEOLOGIST;
        // Static lookup for everything else.
        try {
            var cls = getCSpecialist();
            if (cls && typeof cls.GetSpecialistDescriptionForType === 'function') {
                var def = cls.GetSpecialistDescriptionForType(typeNum);
                if (def && typeof def.getBaseType === 'function') return def.getBaseType();
            }
        } catch (e) { /* fall through */ }
        return null;
    }

    function isCarrierByDescription(spec) {
        var desc = specDescription(spec);
        if (!desc) return false;
        try {
            if (typeof desc.isTransportGeneral === 'function') return !!desc.isTransportGeneral();
        } catch (e) { /* fall through */ }
        return false;
    }

    // The host exposes two related predicates we rely on:
    //   IsGeneral(rt)            — base General family (type 0 and friends)
    //   IsGeneralOrAdmiral(rt)   — also includes Admiral types (18, 19, …)
    //
    // The Admiral class is TSO's expedition-only combat class. Like
    // Generals, it splits into two flavours via isTransportGeneral():
    //   - attacker (e.g. Marshal,            type 18)
    //   - transport (e.g. Expedition Supplier, type 19)
    //
    // Helpers:
    //   isInGeneralFamily(spec)  → true for plain Generals (and Carriers built atop them)
    //   isInAdmiralFamily(spec)  → true for Admirals (and AdmiralCarriers built atop them)
    //   isFighterOrTransport(spec) → either family — useful as the umbrella check.

    function isInGeneralFamily(spec) {
        var rt = rawType(spec);
        if (rt === null) return false;
        var enum_ = getArmySpecTypeEnum();
        if (enum_ && typeof enum_.IsGeneral === 'function') {
            try { return !!enum_.IsGeneral(rt); }
            catch (e) { /* fall through to base-type heuristic */ }
        }
        return baseTypeOf(rt) === BASE_GENERAL;
    }

    function isInAdmiralFamily(spec) {
        var rt = rawType(spec);
        if (rt === null) return false;
        // Admiral = "GeneralOrAdmiral" minus "General". Best signal we have
        // without a dedicated IsAdmiral predicate (which the host doesn't
        // expose under that name).
        var enum_ = getArmySpecTypeEnum();
        if (enum_ && typeof enum_.IsGeneralOrAdmiral === 'function') {
            try { if (!enum_.IsGeneralOrAdmiral(rt)) return false; }
            catch (e) { return false; }
        } else {
            return false;
        }
        return !isInGeneralFamily(spec);
    }

    function isFighterOrTransport(spec) {
        return isInGeneralFamily(spec) || isInAdmiralFamily(spec);
    }

    function canAttack(spec) {
        // Generals and Admirals attack; their carrier-flavour cousins don't.
        if (!isFighterOrTransport(spec)) return false;
        return !isCarrierByDescription(spec);
    }

    function troopCapacity(spec) {
        // The instance getter GetMaxMilitaryUnits() is what autoTSO reads for
        // a general's troop limit, so it comes first. The description
        // getters stay as fallbacks for specialist types that lack it.
        if (!spec) return 0;
        try {
            if (typeof spec.GetMaxMilitaryUnits === 'function') {
                var max = spec.GetMaxMilitaryUnits();
                if (typeof max === 'number' && max > 0) return max;
            }
        } catch (e0) { /* fall through to the description */ }
        var desc = specDescription(spec);
        if (desc) {
            try {
                if (typeof desc.getMaxTroopCount === 'function') return desc.getMaxTroopCount();
                if (typeof desc.GetMaxTroopCount === 'function') return desc.GetMaxTroopCount();
                if (typeof desc.maxTroops_int    === 'number')   return desc.maxTroops_int;
            } catch (e) { /* fall through */ }
        }
        return 0;
    }

    function classify(spec) {
        var rt = rawType(spec);
        if (rt === null) return null;

        var base = baseTypeOf(rt);
        if (base === BASE_EXPLORER)  return S.SpecialistType.Explorer;
        if (base === BASE_GEOLOGIST) return S.SpecialistType.Geologist;

        // Two combat-class families, each with attacker / carrier flavour.
        var transport = isCarrierByDescription(spec);
        if (isInGeneralFamily(spec)) {
            return transport ? S.SpecialistType.Carrier : S.SpecialistType.General;
        }
        if (isInAdmiralFamily(spec)) {
            return transport ? S.SpecialistType.AdmiralCarrier : S.SpecialistType.Admiral;
        }
        return null;
    }

    function isGeneral(spec)        { return classify(spec) === S.SpecialistType.General; }
    function isCarrier(spec)        { return classify(spec) === S.SpecialistType.Carrier; }
    function isAdmiral(spec)        { return classify(spec) === S.SpecialistType.Admiral; }
    function isAdmiralCarrier(spec) { return classify(spec) === S.SpecialistType.AdmiralCarrier; }
    function isExplorer(spec)       { return classify(spec) === S.SpecialistType.Explorer; }
    function isGeologist(spec)      { return classify(spec) === S.SpecialistType.Geologist; }

    // The host returns names as HTML display strings.
    function cleanName(raw) { return (typeof raw === 'string') ? S.kernel.text.plain(raw) : raw; }

    function specName(spec) {
        if (!spec) return '';
        // ArgumentError #1063 (wrong number of arguments) varies by
        // specialist subtype: some take getName(), others getName(false).
        // Try both, in order of "no args" first since that's the more common
        // shape per the live spike output.
        try { if (typeof spec.getName === 'function') {
            var n = cleanName(spec.getName());
            if (n) return n;
        } } catch (e) { /* try next */ }
        try { if (typeof spec.getName === 'function') {
            var n2 = cleanName(spec.getName(false));
            if (n2) return n2;
        } } catch (e) { /* try next */ }
        try { if (typeof spec.GetName === 'function') {
            var n3 = cleanName(spec.GetName());
            if (n3) return n3;
        } } catch (e) { /* try next */ }
        try { if (typeof spec.GetName === 'function') {
            var n4 = cleanName(spec.GetName(false));
            if (n4) return n4;
        } } catch (e) { /* try next */ }

        // Geologists return '' from getName()/GetName(). Fall back to the
        // description's getName_string() loca key — autoTSO uses the same
        // path at user_auto.js:3498. Loca lookup gives a localized display
        // name; raw key returned if loca isn't ready.
        try {
            if (typeof spec.GetSpecialistDescription === 'function') {
                var desc = spec.GetSpecialistDescription();
                if (desc && typeof desc.getName_string === 'function') {
                    var key = desc.getName_string();
                    if (key) {
                        return cleanName((S.core.locale && S.core.locale.spe) ? S.core.locale.spe(key) : key);
                    }
                }
            }
        } catch (e) { /* fall through */ }
        return '';
    }

    // Looks up a hand-edited settings map keyed by specialist name. The exact
    // key wins. Otherwise keys are cleaned the way name() is, which also
    // accepts keys saved with entities or the host's raw markup.
    function namedOverride(map, name) {
        if (!map || !name) return undefined;
        var has = Object.prototype.hasOwnProperty;
        if (has.call(map, name)) return map[name];
        for (var key in map) {
            if (has.call(map, key) && S.kernel.text.plain(key) === name) return map[key];
        }
        return undefined;
    }

    // Stable per-instance string key derived from the dUniqueID. Use this
    // for queue payloads, exclude maps, and any "re-find this exact
    // specialist later" need — display names can collide across multiple
    // specimens of the same GetType. Returns null when the host doesn't
    // expose a uniqueID. core.specialists.dispatch.uniqueId returns the
    // dUniqueID *object* (for the server packet); this helper returns
    // the .toKeyString() form (for use as a JS map key).
    function uniqueIdKey(spec) {
        if (!spec) return null;
        try {
            if (typeof spec.GetUniqueID === 'function') {
                var uid = spec.GetUniqueID();
                if (uid && typeof uid.toKeyString === 'function') return uid.toKeyString();
            }
        } catch (e) { /* fall through */ }
        return null;
    }

    function specTask(spec) {
        if (!spec) return null;
        try { return typeof spec.GetTask === 'function' ? spec.GetTask() : null; }
        catch (e) { return null; }
    }

    function hasTask(spec) {
        // Confirmed via the spike: GetTask() returns null for idle specialists
        // and a Flash task object (which JSON-stringifies to "{}") for busy
        // ones. Truthiness check is sufficient.
        var t = specTask(spec);
        return !!t;
    }

    // IsInUse() is the cross-type "busy" flag. Generals expose
    // GetGeneralState() with -1 = idle-traveling/working, 0 = idle, plus
    // values for various activity sub-states. We use IsInUse first because
    // the spike showed it returns true for working explorers (where
    // GetGeneralState returns -1 even when idle).
    function isInUse(spec) {
        if (!spec) return false;
        try { if (typeof spec.IsInUse === 'function') return !!spec.IsInUse(); }
        catch (e) { /* fall through */ }
        return false;
    }

    function status(spec) {
        if (!spec) return S.SpecialistStatus.Unavailable;
        // Idle: no task AND not in use.
        if (!hasTask(spec) && !isInUse(spec)) return S.SpecialistStatus.Idle;
        // The spike showed Working specs all collapse to one bucket from
        // these getters — GetTask().GetType / GetSubType give activity
        // shape but not Working/Traveling/Returning distinctions reliably.
        // Refine when we have a returning specialist to inspect.
        return S.SpecialistStatus.Working;
    }

    // Map ExplorerTask enum → host loca key. Sourced from
    // tso_client/.../4-specialists.js:21-33. The host's loca lookup gives
    // the in-game label (e.g. "Treasure Search Short" vs the ambiguous bare
    // "Short") with translation. Two families:
    //   - FindTreasure* — the seven treasure-search variants
    //   - FindAdventureZone* — the four adventure-zone-search variants
    var TASK_LOCA_KEYS = {};
    TASK_LOCA_KEYS[S.ExplorerTask.Short]                 = 'FindTreasureShort';
    TASK_LOCA_KEYS[S.ExplorerTask.Medium]                = 'FindTreasureMedium';
    TASK_LOCA_KEYS[S.ExplorerTask.Long]                  = 'FindTreasureLong';
    TASK_LOCA_KEYS[S.ExplorerTask.EvenLonger]            = 'FindTreasureEvenLonger';
    TASK_LOCA_KEYS[S.ExplorerTask.Prolonged]             = 'FindTreasureLongest';
    TASK_LOCA_KEYS[S.ExplorerTask.TravellingErudite]     = 'FindTreasureTravellingErudite';
    TASK_LOCA_KEYS[S.ExplorerTask.BeanACollada]          = 'FindTreasureBeanACollada';
    TASK_LOCA_KEYS[S.ExplorerTask.AdventureZoneShort]    = 'FindAdventureZoneShort';
    TASK_LOCA_KEYS[S.ExplorerTask.AdventureZoneMedium]   = 'FindAdventureZoneMedium';
    TASK_LOCA_KEYS[S.ExplorerTask.AdventureZoneLong]     = 'FindAdventureZoneLong';
    TASK_LOCA_KEYS[S.ExplorerTask.AdventureZoneVeryLong] = 'FindAdventureZoneVeryLong';

    // Localised in-game label for an explorer task. Falls back gracefully
    // when loca isn't ready or the enum is unknown.
    function taskLabel(taskEnum) {
        if (!taskEnum) return '';
        var key = TASK_LOCA_KEYS[taskEnum];
        if (!key) return String(taskEnum);
        try {
            if (typeof loca !== 'undefined' && loca && typeof loca.GetText === 'function') {
                var t = loca.GetText('LAB', key);
                if (t) return t;
            }
        } catch (e) { /* fall through */ }
        return key;
    }

    // Decode the explorer's *current* task by reading both
    // GetTask().GetType() (task family) and GetSubType() (variant) and
    // mapping the pair back through RAW_TO_EXPLORER_TASK. Returns the
    // ExplorerTask enum or null when idle / on an unknown task.
    function currentTask(spec) {
        var task = specTask(spec);
        if (!task) return null;
        try {
            var type = (typeof task.GetType === 'function') ? task.GetType() : null;
            var sub  = (typeof task.GetSubType === 'function') ? task.GetSubType() : null;
            if (typeof type !== 'number' || typeof sub !== 'number') return null;
            return rawToExplorerTask(type, sub);
        } catch (e) { /* ignore */ }
        return null;
    }

    function isAttacking(spec)   {
        // Both Generals and Admirals attack. We collapse the two for this query
        // since modules generally don't care about the family — only the role.
        var c = classify(spec);
        if (c !== S.SpecialistType.General && c !== S.SpecialistType.Admiral) return false;
        return status(spec) === S.SpecialistStatus.Working;
    }
    function isHauling(spec)     {
        var c = classify(spec);
        if (c !== S.SpecialistType.Carrier && c !== S.SpecialistType.AdmiralCarrier) return false;
        return status(spec) === S.SpecialistStatus.Working;
    }
    function isExploring(spec)   { return isExplorer(spec)  && status(spec) === S.SpecialistStatus.Working; }
    function isProspecting(spec) { return isGeologist(spec) && status(spec) === S.SpecialistStatus.Working; }

    var UNREADABLE = 'specialist unreadable';

    // Every one of these is declared on cSpecialist itself, so a live object
    // has them. An entry that reads one as undefined is a passing fault of the
    // AS3 bridge, not a different kind of object.
    var REQUIRED_MEMBERS = ['GetType', 'GetUniqueID', 'getPlayerID', 'GetTask'];
    var DROP_LOG_MS = 60000;
    var droppedTotal = 0;
    var dropLoggedAt = null;

    // Returns null when the entry is usable, else the name of the member that
    // failed ('uid' when the members exist but the key reads null or empty). A throw
    // counts as unusable.
    function unusableMember(spec) {
        try {
            for (var i = 0; i < REQUIRED_MEMBERS.length; i++) {
                if (typeof spec[REQUIRED_MEMBERS[i]] !== 'function') return REQUIRED_MEMBERS[i];
            }
            if (!uniqueIdKey(spec)) return 'uid';
        } catch (e) {
            return 'threw';
        }
        return null;
    }

    function noteDropped(n, total, counts, sample) {
        var now = Date.now();
        if (dropLoggedAt !== null && now - dropLoggedAt < DROP_LOG_MS) return;
        dropLoggedAt = now;
        var parts = [];
        for (var name in counts) {
            if (Object.prototype.hasOwnProperty.call(counts, name)) parts.push(name + ' x' + counts[name]);
        }
        var rawType = '?';
        var cls = '?';
        try { rawType = String(sample.GetType()); } catch (e1) { /* keep ? */ }
        try { cls = window.runtime.flash.utils.getQualifiedClassName(sample); } catch (e2) { /* keep ? */ }
        S.kernel.log('specialists', 'dropped ' + n + ' of ' + total + '; missing ' + parts.join(', ') +
            '; sample GetType ' + rawType + ' class ' + cls);
    }

    // Ghosts: the vector sometimes holds a real cSpecialist whose members read
    // undefined on the JS side of the AIR bridge for a moment (GetType still
    // works). Such an entry cannot be classified, owned or re-found, and its
    // status would read Idle. The reader leaves it out and counts it in
    // dropped(), so a caller can tell a read that lost entries from a clean one.
    // There is no retry here: the next tick is the retry.
    //
    // Returns the specialist array, or null when the list could not be read
    // (no zone, no getter, falsy vector, or a throw). Callers that must tell
    // "empty" from "unreadable" use this; readVector flattens null to [].
    function readSpecialists(zone) {
        if (!zone) return null;
        try {
            if (typeof zone.GetSpecialists_vector !== 'function') return null;
            var v = zone.GetSpecialists_vector();
            if (!v) return null;
            var out = [];
            var len = (typeof v.length === 'number') ? v.length : 0;
            var lost = 0;
            var counts = {};
            var sample = null;
            for (var i = 0; i < len; i++) {
                var spec = v[i];
                if (!spec) continue;
                var bad = unusableMember(spec);
                if (bad === null) {
                    out.push(spec);
                } else {
                    lost++;
                    counts[bad] = (counts[bad] || 0) + 1;
                    if (sample === null) sample = spec;
                }
            }
            if (lost > 0) {
                droppedTotal += lost;
                noteDropped(lost, len, counts, sample);
            }
            return out;
        } catch (e) {
            S.kernel.warn('specialists', 'readVector threw:', e);
            return null;
        }
    }

    // Monotonic count of entries the reader has left out. A caller compares it
    // before and after a read to learn whether that read was complete.
    function dropped() { return droppedTotal; }

    function readVector(zone) {
        return readSpecialists(zone) || [];
    }

    // true when the list of opts.zone (default: the viewed zone) is readable,
    // so an empty list can be told from an unreadable one. A read that dropped
    // ghost entries still counts as readable: the away recall reads false as
    // "left the island", which a passing fault must not suggest.
    function listReadable(opts) {
        return readSpecialists((opts && opts.zone) || S.core.zone.current()) !== null;
    }

    // true only when the list of opts.zone (default: the viewed zone) reads and
    // that read dropped nothing.
    function listComplete(opts) {
        var before = droppedTotal;
        var list = readSpecialists((opts && opts.zone) || S.core.zone.current());
        return list !== null && droppedTotal === before;
    }

    function all(opts) {
        opts = opts || {};
        var zone = opts.zone || S.core.zone.current();
        return readVector(zone);
    }

    // Re-finds one specialist by its uid key. Action defs treat ok:false as
    // "not observed" (the list could not be read, or the read lost entries and
    // the key may have been one of them) and spec:null with ok:true as "not
    // listed" (a complete read in which the specialist is absent).
    function lookup(key, opts) {
        opts = opts || {};
        var zone = opts.zone || S.core.zone.current();
        var before = droppedTotal;
        var list = readSpecialists(zone);
        if (list === null) return { ok: false, spec: null };
        if (typeof key !== 'string' || !key) return { ok: true, spec: null };
        var sawNullKey = false;
        for (var i = 0; i < list.length; i++) {
            var k = uniqueIdKey(list[i]);
            if (k === key) return { ok: true, spec: list[i] };
            // An entry that passed the reader but reads null or empty here flipped
            // between the two reads; it may be the one searched for.
            if (!k) sawNullKey = true;
        }
        return { ok: droppedTotal === before && !sawNullKey, spec: null };
    }

    // The one place that turns a lookup into the refusal reason every action
    // def reports. An unreadable list and an absent specialist are different
    // refusals, so the caller can tell a host problem from a stale key.
    function refind(key, opts) {
        var r = lookup(key, opts);
        if (!r.ok) return { spec: null, reason: UNREADABLE };
        if (!r.spec) return { spec: null, reason: 'specialist not found' };
        return { spec: r.spec, reason: null };
    }

    function byType(type, opts) {
        var src = all(opts);
        var out = [];
        for (var i = 0; i < src.length; i++) {
            if (classify(src[i]) === type) out.push(src[i]);
        }
        return out;
    }

    // Generals and carriers of one read of the list, so a fault between two reads
    // cannot lose one class and leave the other. complete is false when the list
    // could not be read, the read dropped an entry, or an entry's type could not
    // be read. classify is also null for a real unknown type, which is no loss.
    function fighterList(opts) {
        opts = opts || {};
        var before = droppedTotal;
        var src = readSpecialists(opts.zone || S.core.zone.current());
        var out = [];
        var complete = src !== null;
        src = src || [];
        for (var i = 0; i < src.length; i++) {
            var c = classify(src[i]);
            if (c === S.SpecialistType.General || c === S.SpecialistType.Carrier) {
                out.push(src[i]);
            } else if (c === null) {
                var rt = rawType(src[i]);
                if (rt === null || rt === undefined) complete = false;
            }
        }
        return { list: out, complete: complete && droppedTotal === before };
    }

    function byName(targetName, opts) {
        var src = all(opts);
        var wanted = S.kernel.text.plain(targetName);
        for (var i = 0; i < src.length; i++) {
            var n = specName(src[i]);
            if (n && (n === targetName || n === wanted)) return src[i];
        }
        return null;
    }

    function generals(opts)         { return byType(S.SpecialistType.General,        opts); }
    function carriers(opts)         { return byType(S.SpecialistType.Carrier,        opts); }
    function admirals(opts)         { return byType(S.SpecialistType.Admiral,        opts); }
    function admiralCarriers(opts)  { return byType(S.SpecialistType.AdmiralCarrier, opts); }
    function explorers(opts)        { return byType(S.SpecialistType.Explorer,       opts); }
    function geologists(opts)       { return byType(S.SpecialistType.Geologist,      opts); }

    function available(type, opts) {
        var src = byType(type, opts);
        var out = [];
        for (var i = 0; i < src.length; i++) {
            if (status(src[i]) === S.SpecialistStatus.Idle) out.push(src[i]);
        }
        return out;
    }

    function busy(type, opts) {
        var src = byType(type, opts);
        var out = [];
        for (var i = 0; i < src.length; i++) {
            if (status(src[i]) !== S.SpecialistStatus.Idle) out.push(src[i]);
        }
        return out;
    }

    function hasArmy(spec) {
        if (!spec) return false;
        try {
            if (typeof spec.GetArmy === 'function') {
                var a = spec.GetArmy();
                return !!(a && typeof a.HasUnits === 'function' && a.HasUnits());
            }
        } catch (e) { /* fall through */ }
        return false;
    }

    function hasExpertTroops(spec) {
        if (!hasArmy(spec)) return false;
        try {
            var a = spec.GetArmy();
            if (!a || typeof a.GetUnits_vector !== 'function') return false;
            var units = a.GetUnits_vector();
            var len = (typeof units.length === 'number') ? units.length : 0;
            for (var i = 0; i < len; i++) {
                var u = units[i];
                if (u && typeof u.GetIsElite === 'function' && u.GetIsElite()) return true;
            }
        } catch (e) { /* fall through */ }
        return false;
    }

    // --- Skills (normalized) ---

    function modifierEnum(rawString) {
        if (!rawString || typeof rawString !== 'string') return S.SkillModifier.Other;
        var s = rawString.toLowerCase();
        if (s === 'searchtime')           return S.SkillModifier.SearchTime;
        if (s === 'changeloottablerolls') return S.SkillModifier.LootRolls;
        if (s === 'lootamount')           return S.SkillModifier.LootAmount;
        return S.SkillModifier.Other;
    }

    function skills(spec) {
        var out = [];
        if (!spec) return out;
        try {
            var v = (typeof spec.GetSkills_vector === 'function') ? spec.GetSkills_vector()
                  : spec.mSkills_vector || null;
            if (!v) return out;
            var len = (typeof v.length === 'number') ? v.length : 0;
            for (var i = 0; i < len; i++) {
                var sk = v[i];
                if (!sk) continue;
                var def = (typeof sk.GetDefinition === 'function') ? sk.GetDefinition() : sk;
                if (!def) continue;
                out.push({
                    modifier:   modifierEnum(def.modifier_string || ''),
                    raw:        def.modifier_string || '',
                    multiplier: typeof def.multiplier === 'number' ? def.multiplier : 1,
                    adder:      typeof def.adder === 'number' ? def.adder : 0,
                    value:      typeof def.value === 'number' ? def.value : 0
                });
            }
        } catch (e) {
            S.kernel.warn('specialists', 'skills() threw:', e);
        }
        return out;
    }

    // --- Recommendations ---

    // (taskId, subTaskId) → ExplorerTask enum. Both args required: pass 1
    // when reading a treasure-only host setting (host's `explDefTask` /
    // `explDefTaskByType` store just the subTaskID, family is implicit).
    function rawToExplorerTask(taskId, subTaskId) {
        if (typeof taskId !== 'number' || typeof subTaskId !== 'number') return null;
        var byTask = RAW_TO_EXPLORER_TASK[taskId];
        if (!byTask) return null;
        return byTask[subTaskId] || null;
    }

    // True when `taskEnum` is a recognised ExplorerTask (treasure OR
    // adventure-zone). Used by the modules that accept user-configured
    // task overrides — both families are valid choices since an explorer
    // might be configured for adventure-zone searches based on skills.
    function knownTask(taskEnum) {
        return !!EXPLORER_TASK_PACKET[taskEnum];
    }

    // Read `spec.getSkillTree().getItems_vector()` into a {skillId: level}
    // map. Skill tree only — these are the "permanent" skills that gate
    // task availability (matches the host's own filter at
    // tso_client/.../4-specialists.js:188-191). Returns {} on any failure
    // (host APIs not ready, foreign spec type, etc.).
    function skillTreeMap(spec) {
        var out = {};
        if (!spec) return out;
        try {
            if (typeof spec.getSkillTree !== 'function') return out;
            var tree = spec.getSkillTree();
            if (!tree || typeof tree.getItems_vector !== 'function') return out;
            var v = tree.getItems_vector();
            var len = (typeof v.length === 'number') ? v.length : 0;
            for (var i = 0; i < len; i++) {
                var sk = v[i];
                if (!sk) continue;
                var id = (typeof sk.getId === 'function') ? sk.getId() : null;
                var lvl = (typeof sk.getLevel === 'function') ? sk.getLevel() : 0;
                if (typeof id === 'number') out[id] = lvl || 0;
            }
        } catch (e) { /* ignore */ }
        return out;
    }

    function hasSkill(spec, skillId) {
        var m = skillTreeMap(spec);
        return (m[skillId] || 0) > 0;
    }

    // Player level — used for the level-gated tasks. 0 fallback when the
    // host isn't ready.
    function playerLevel() {
        try {
            if (typeof game !== 'undefined' && game && game.player &&
                typeof game.player.GetPlayerLevel === 'function') {
                return game.player.GetPlayerLevel() || 0;
            }
        } catch (e) { /* ignore */ }
        return 0;
    }

    // List of ExplorerTask enums this explorer is eligible for, mirroring
    // the host's createExplorerDropdown filter exactly. A task qualifies if:
    //   - it requires Erudite and the explorer has Erudite, OR
    //   - it requires BeanACollada and the explorer has BeanACollada, OR
    //   - it has no skill requirement and the player's level meets the gate.
    function availableTasks(spec) {
        if (!spec) return [];
        var hasE = hasSkill(spec, S.ExplorerSkill.TravellingErudite);
        var hasB = hasSkill(spec, S.ExplorerSkill.BeanACollada);
        var lvl = playerLevel();
        var out = [];
        for (var i = 0; i < TASK_REQUIREMENTS.length; i++) {
            var r = TASK_REQUIREMENTS[i];
            var enumVal = r[0], needsE = r[1], needsB = r[2], reqLvl = r[3];
            if (needsE && hasE) { out.push(enumVal); continue; }
            if (needsB && hasB) { out.push(enumVal); continue; }
            if (!needsE && !needsB && lvl >= reqLvl) { out.push(enumVal); continue; }
        }
        return out;
    }

    // Per-family routing helpers live alongside this file:
    //   - core/specialists/explorers.js  — biasFromTrait, pickTask, the
    //     event-aware items/hour optimiser, taskFamilyOf
    //   - core/specialists/geologists.js — pickDeposits (capacity-primary
    //     ranking lands here when the geologists module ships)
    //
    // EXPLORER_TASK_PACKET, GEOLOGIST_TASK_PACKET, RAW_TO_EXPLORER_TASK and
    // rawToExplorerTask stay in this file because they're dispatch-level
    // enum↔packet mappings consumed by send() and currentTask().
    // rawToExplorerTask is exposed on the public namespace so the per-
    // family files can reach it.

    // --- Dispatch (low-level passthrough to dispatch.js) ---
    //
    // Server packet: SendServerAction(95, taskId, 0, 0, dStartSpecialistTaskVO)
    //   - taskId    = "task category" int. For explorers and geologists the
    //                 host's user-config (mainSettings.explDefTask /
    //                 geoDefTask) stores this directly. 0 = treasure search
    //                 / deposit search; non-zero = adventure searches and
    //                 specials.
    //   - subTaskId = variant within the category. For explorers: short=0,
    //                 medium=1, long=2, evenLonger=3, prolonged=6. For
    //                 geologists: deposit-type index.
    //
    // Modules pass either Steward.{ExplorerTask,GeologistTask} enum values
    // (in which case we map to their raw subTaskId and assume taskId=0) or
    // explicit (taskId, subTaskId) integers.

    function send(spec, taskOrEnum, subTaskIdOpt, responder) {
        if (typeof taskOrEnum === 'string') {
            // Enum value — translate via the per-family packet map.
            var explPkt = EXPLORER_TASK_PACKET[taskOrEnum];
            if (explPkt) {
                return S.core.specialists.dispatch.send(spec, explPkt.taskId, explPkt.subTaskId, responder);
            }
            var geoPkt = GEOLOGIST_TASK_PACKET[taskOrEnum];
            if (geoPkt) {
                // For geologist enums, subTaskIdOpt overrides the default
                // subTaskId — that's how the caller specifies the deposit-
                // type index they want the geologist to search for.
                var subTaskId = (typeof subTaskIdOpt === 'number') ? subTaskIdOpt : geoPkt.subTaskId;
                return S.core.specialists.dispatch.send(spec, geoPkt.taskId, subTaskId, responder);
            }
            S.kernel.warn('specialists', 'send: unknown enum', taskOrEnum);
            return false;
        }
        if (typeof taskOrEnum === 'number') {
            // Caller passed taskId directly; subTaskId from the second arg.
            var sub = (typeof subTaskIdOpt === 'number') ? subTaskIdOpt : 0;
            return S.core.specialists.dispatch.send(spec, taskOrEnum, sub, responder);
        }
        S.kernel.warn('specialists', 'send: taskOrEnum must be Steward.{Explorer,Geologist}Task or a number');
        return false;
    }

    function recall(spec, responder) {
        return S.core.specialists.dispatch.recall(spec, responder);
    }

    // --- Public surface ---

    S.core.specialists.all              = all;
    S.core.specialists.listReadable     = listReadable;
    S.core.specialists.listComplete     = listComplete;
    S.core.specialists.dropped          = dropped;
    S.core.specialists.UNREADABLE       = UNREADABLE;
    S.core.specialists.lookup           = lookup;
    S.core.specialists.refind           = refind;
    S.core.specialists.byType           = byType;
    S.core.specialists.fighterList      = fighterList;
    S.core.specialists.byName           = byName;
    S.core.specialists.generals         = generals;
    S.core.specialists.carriers         = carriers;
    S.core.specialists.admirals         = admirals;
    S.core.specialists.admiralCarriers  = admiralCarriers;
    S.core.specialists.explorers        = explorers;
    S.core.specialists.geologists       = geologists;

    S.core.specialists.classify         = classify;
    S.core.specialists.canAttack        = canAttack;
    S.core.specialists.troopCapacity    = troopCapacity;
    S.core.specialists.isGeneral        = isGeneral;
    S.core.specialists.isCarrier        = isCarrier;
    S.core.specialists.isAdmiral        = isAdmiral;
    S.core.specialists.isAdmiralCarrier = isAdmiralCarrier;
    S.core.specialists.isExplorer       = isExplorer;
    S.core.specialists.isGeologist      = isGeologist;
    S.core.specialists.hasArmy          = hasArmy;
    S.core.specialists.hasExpertTroops  = hasExpertTroops;

    S.core.specialists.status           = status;
    S.core.specialists.isAttacking      = isAttacking;
    S.core.specialists.isHauling        = isHauling;
    S.core.specialists.isExploring      = isExploring;
    S.core.specialists.isProspecting    = isProspecting;
    S.core.specialists.available        = available;
    S.core.specialists.busy             = busy;

    S.core.specialists.skills           = skills;
    S.core.specialists.skillTreeMap     = skillTreeMap;
    S.core.specialists.hasSkill         = hasSkill;
    S.core.specialists.currentTask      = currentTask;
    S.core.specialists.taskLabel        = taskLabel;
    S.core.specialists.knownTask        = knownTask;
    S.core.specialists.rawToExplorerTask = rawToExplorerTask;
    S.core.specialists.availableTasks   = availableTasks;
    // pickTask / biasFromTrait / familyFromBias / bestTaskForEvent /
    // taskFamilyOf are exported from core/specialists/explorers.js.
    // pickDeposits is exported from core/specialists/geologists.js.

    S.core.specialists.send             = send;
    S.core.specialists.recall           = recall;

    S.core.specialists.name             = specName;
    S.core.specialists.namedOverride    = namedOverride;
    S.core.specialists.uniqueIdKey      = uniqueIdKey;

}(Steward));
