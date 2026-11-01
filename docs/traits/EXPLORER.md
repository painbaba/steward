# Explorer Traits — Live Findings

> Status: in progress, snapshot 2026-04-27. Sourced from
> `Settings → Diagnostics → Deep dump explorer types` runs in the live AIR
> client. Update as more types are captured.

## TL;DR

Special explorer behaviour ("Princess bonus", trait stat boosts, etc.) lives
on **`spec.skills`** — a separate skill collection from `spec.getSkillTree()`.
Each special explorer carries one or more "trait" entries here whose
`name_string` looks like `Trait_<Name>Explorer`. The trait's
`level_vector[0]` effects encode the bonus mechanically using the same
fields the rest of the skill model uses (`type_string`, `modifier_string`,
`multiplier`, `adder`, `value`, `chance`).

The `getSkillTree()` collection is **identical structurally for every
explorer type** — same 20 slots (skill ids 22-41), differing only in which
levels the player has invested. Looking there to identify a "Princess" type
is a dead end.

## What lives where

```
spec.GetSpecialistDescription()
    .getName_string()        e.g. "Explorer", "Courageous Explorer", …
    .getBaseType()           1 = Explorer
    .GetTimeBonus()          1.0 for vanilla, 3.0 for Princess Zoe (+200%), …
    .isTransportGeneral()    irrelevant for explorers
    (no other surfaced methods produce useful data for this purpose —
     the brute-force enumerator returns zero callables on the description)

spec.getSkillTree().getItems_vector()
    20 items, ids 22-41 plus 41 in slot 0 ("fearlessHiker"). Universal
    across all explorer types — the differences between types live
    *elsewhere*. We do still read levels per-type to compute optimisation
    multipliers (some explorers have leveled "pilgrimage" to L3 etc.).

spec.skills.getItems_vector()
    The trait collection. Two kinds of entries:
      - id=301, name_string='friendpremiumbuff1' — universal premium buff
        applied to ALL specs. Effects: searchTime ×0.8 on every task type
        (treasure, adventure, expedition, deposit search, sector explore,
        island explore, expedition recover). Equivalent to a "VIP" boost.
      - any other id, name_string ≈ 'Trait_<Name>Explorer' — the per-type
        trait. Encodes the actual bonus that distinguishes this type from
        a vanilla Explorer. THIS is the field we want to read for
        recommendations. Captured ids range 111-338 across the 18 special
        types in this dump; do not assume id<300 (Fluffy Butte is 308,
        Nora is 338). Identify by "not 301" rather than by id range. Two
        observed naming exceptions: type 90's trait is `TraitChummyExplorer`
        (no underscore), type 97's is `Trait_GloryExploriExplorer` (Nora the
        Explorer has a non-`<Name>Explorer` token).
```

## Captured trait skills

| GetType | Display name | Trait id | Trait name_string | Effect summary | Implied bias |
|---|---|---|---|---|---|
| 1 | Explorer | — | (no trait) | `friendpremiumbuff1` only | follow user default |
| 10 | Experienced explorer | — | (no trait) | `friendpremiumbuff1` only | follow user default |
| 32 | Courageous Explorer | 111 | `Trait_CorageousExplorer` | 7 effects, all `FindTreasure*` (incl. Erudite + BeanACollada) with `modifier_string='ChangeLoottableRolls', multiplier=2, chance=1`. Nothing on Adventure family. | **Treasure** (×2 loot rolls on every treasure variant) |
| 39 | Candid Explorer | 112 | `Trait_CandidExplorer` | 7 effects, all `FindTreasure*` (incl. Erudite + BeanACollada) with `modifier_string='ChangeLoottableRolls', multiplier=4, chance=1`. Nothing on Adventure family. | **Treasure (very strong)** |
| 41 | Lovely Explorer | 122 | `Trait_LovelyExplorer` | 22 effects with `±` `adder` patterns on `FindTreasure*` and `FindTreasure_Lovely_*` named variants. Plain treasures get `adder=-2`; `_Lovely_<size>` (no event suffix) get `adder=+2` (year-round); `_Lovely_<size>_<event>` get an extra `+1` (event-gated on Easter / XMAS / Valentine / Halloween / Soccer / RedNose). Also `+2` on `FindTreasureBeanACollada_Lovely`. | **Treasure** — year-round score 10 (from the `_Lovely_<size>` private-variant adders), event-active score 17 (adds the `_Lovely_<size>_<event>` rolls). Score is positive year-round, so recommendation is treasure regardless of events; magnitude is much higher during events |
| 44 | Princess Zoe | 200 | `Trait_PrincessZoeExplorer` | 3 effects, all `ChangeLoottableRolls, mul=1, add=1, chance=1`, with **empty `type_string`** — match by `name_string` only: `FindTreasure_Zoe_Buffs`, `FindTreasure_Zoe_Adventures`, `FindAdventure_Zoe_Buffs`. | **Buff / adventure-scroll finder** — extra rolls on private `_Zoe_*` drop tables. By effect count 2 treasure : 1 adventure → treasure (slight); practical reading is "produces buffs/scrolls on either family" |
| 48 | Emphatic Explorer | 202 | `Trait_EmphaticExplorer` | 7 effects, `ChangeLoottableRolls mul=3` on every plain `FindTreasure*` (Short..Prolonged + Erudite + BeanACollada). | **Treasure (strong)** — same shape as Courageous, just multiplier 3 instead of 2 |
| 51 | Bewitching Explorer | 203 | `Trait_BewitchingExplorer` | 23 effects mixing seasonal `_Lovely_` adders with size-tiered boosts. Plain treasures get `add=-2`; `add=+4` on Short/Prolonged, `+3` on Medium/Long/EvenLonger (year-round); `+2` on every `_Lovely_<size>` private variant; additional event-gated bonuses on the `_Lovely_<size>_<event>` rolls; `mul=2` specifically on `FindTreasureTravellingErudite`; `add=-1` on BeanACollada. | **Treasure (size-tiered)** — year-round score 19 (size-tier + Lovely-private adders), event-active score 30 (adds `_Lovely_<size>_<event>` rolls during {Easter, HW, RedNose, Soccer, Valentine, XMAS}). Strong recommendation regardless of events |
| 53 | Humble Explorer | 204 | `Trait_HumbleExplorer` | 2 effects, `ChangeLoottableRolls mul=6` on `FindTreasureShort` and `FindTreasureMedium` only. | **Short/Medium treasure (very strong)** — useless on long expeditions |
| 55 | Keener Explorer | 205 | `Trait_KeenerExplorer` | 1 effect, `ChangeLoottableRolls add=2` on `IntrepidLoot` (matched by `name_string`; `type_string` is empty). | **Adventure-family synergy** — `IntrepidLoot` is a named loot table grouped with the four `FindAdventureZone*` variants by `wildDetermination`'s effect list, so the algorithm bins her as `adventure=2.0`. Likely a synergy partner for Intrepid Explorer dispatches; standalone she still rolls extra adventure loot via the same table |
| 65 | Snowy Explorer | 282 | `Trait_SnowyExplorer` | 12 effects: `ChangeLoottableRolls mul=4` on every plain `FindTreasure*` with name_string filter listing the event-suffixed variants too (year-round + event); `mul=2` on the corresponding `FindTreasure_Lovely_<size>` variants (year-round Lovely-private) + the same `_Lovely_<size>_<event>` rolls (event-gated). | **Treasure** — year-round score 7 (Lovely-private), event-active score 22 (adds the +4× and event-gated `_Lovely_<size>_<event>` rolls during {Easter, HW, RedNose, Soccer, XMAS}). Year-round is positive but small; event-time is dominant — pair her with active events when possible |
| 66 | Romantic Explorer | 283 | `Trait_RomanticExplorer` | 3 effects, `ChangeLoottableRolls mul=12` on `FindTreasureLong`, `FindTreasureEvenLonger`, `FindTreasureProlonged` only. | **Long-form treasure (extreme)** — useless on Short/Medium |
| 70 | Royal Explorer | 288 | `Trait_RoyalCollector` | 4 effects, `ChangeLoottableRolls add=1` on every `FindAdventureZone*`. | **Adventure** — first pure-adventure trait observed |
| 74 | Pirate Explorer | 289 | `Trait_PirateExplorer` | 6 effects: `ChangeLoottableRolls add=1` on private `FindTreasure_Pirate_Buffs` (Zoe-style), plus `ChangeLootCount mul=2` on every plain `FindTreasure*`. | **Treasure** — boosts both quantity (×2 count on every treasure) AND drops a private buff loot table |
| 78 | Fluffy Butte Explorer | 308 | `Trait_FluffyButteExplorer` | 5 effects, `ChangeLoottableRolls mul=5` with `name_string` filter listing **only** event-suffixed variants (`_Easter`, `_XMAS`, `_SoccerResources`, `_SoccerBalls`, `_Halloween`, `_RedNose`, …). No plain entry. | **Seasonal-only treasure** — fires `+5×` rolls on Short..Prolonged variants ONLY during {Easter, HW, RedNose, Soccer, XMAS}. Off-event her trait is functionally inert; score collapses to 0 and the recommendation falls back to user default |
| 84 | Love Struck Explorer | 323 | `Trait_LoveStruckExplorer` | 4 effects, `ChangeLoottableRolls add=1` on every `FindAdventureZone*`. | **Adventure** — identical effect set to Royal Explorer |
| 87 | Blacktree Explorer | 326 | `Trait_BlacktreeExplorer` | 3 effects, `ChangeLoottableRolls add=1` on Long, EvenLonger, Prolonged. | **Long-form treasure (mild)** |
| 90 | Chummy Explorer | 329 | `TraitChummyExplorer` *(no underscore)* | 3 effects on Long (`add=1, chance=0.75`), EvenLonger (`add=1`), Prolonged (`add=2`). | **Long-form treasure** — the chance-discounted Long roll is the only sub-1.0 chance gate seen on the simple-multiplier traits |
| 94 | Ghost Explorer | 334 | `Trait_Ghostlyloot` | 9 stacked-chance effects on Long (chances 0.7+0.7+0.35), EvenLonger (0.85+0.85+0.42), Prolonged (1.0+1.0+0.5) — each `ChangeLoottableRolls add=1`. | **Long-form treasure (probabilistic)** — the layered chances appear to roll independently for variable extra loot |
| 97 | Nora the Explorer | 338 | `Trait_GloryExploriExplorer` | 13 effects mixing two modifiers: `searchTime mul=1.5` on every `FindTreasure*` (penalty — slower), `searchTime mul=0.5` on every `FindAdventureZone*` (bonus — faster), and `ChangeLoottableRolls add=1` on `FindAdventureZoneLong/VeryLong`. | **Adventure (strong)** — only trait observed that uses `searchTime` to actively discourage one family. Sending her on treasure costs +50% time |

### Newly catalogued from external dump (2026-04-28)

Sourced from `docs/analysis/user_provided/angrywolf_specialists-20260428-122935.json`.
Display names cross-referenced with [settlersonlinewiki.eu](https://settlersonlinewiki.eu/en/guides/explorer/),
[tsomaps](https://en.tsomaps.com/handbook/explorers/), and
[settlersportal](https://settlersportal.com/specialists/explorers).
The "Verified?" column indicates how the row was confirmed:

- `wiki` — display name + bias inferred from public wikis; mechanically
  consistent with raw effect data but not yet test-dispatched in our
  automation.
- `yes` — observed end-to-end in our own dispatch + log capture.
- `no` — neither verified.

| GetType | Display name | Trait id | Trait name_string | Effect summary | Implied bias | Verified? |
|---|---|---|---|---|---|---|
| 4 | **Savage Scout** _or_ **Fast Explorer** _(awaiting roster owner)_ | — | (no trait) | `friendpremiumbuff1` only; `description.GetTimeBonus = 200` | follow user default — pure-speed vanilla tier-2. Both candidate names are +100% speed vanillas with no other trait, so the data alone cannot distinguish them. Question sent to angrywolf for confirmation | no — ambiguous |
| 17 | Lucky Explorer | 106 | `Trait_FastLuckyExplorer` | 1 effect, `ChangeLoottableRolls add=1` on `ExplorerBuffs` (matched by `name_string`; `type_string` empty). `description.GetTimeBonus = 300` | **Buff finder** — wiki: "+200% task speed and a chance to find a buff on treasure, artefact, rarity and adventure searches". Always-on buff producer rather than a treasure/adventure family lean — the `ExplorerBuffs` private table fires regardless of dispatch family. Recommendation should fall back to user default for family choice and treat the buff as a passive bonus | wiki |
| 28 | Intrepid Explorer | 107 | `Trait_IntrepidExplorer` | 1 effect, `ChangeLoottableRolls add=1` on `IntrepidLoot` (matched by `name_string`). `description.GetTimeBonus = 200` | **Adventure** — wiki: "+100% task speed and 2× rewards on adventure searches". `IntrepidLoot` is a named loot table grouped with the four `FindAdventureZone*` variants by `wildDetermination`'s effect list (same mechanic as Keener Explorer GetType=55). Algorithm should bin this trait as `adventure=1.0` | wiki |
| 58 | Bold Explorer | 274 | `Trait_BoldExplorer` | 9 effects: `+1 ChangeLoottableRolls` on private `FindTreasure_Bold_Buffs` AND `FindAdventure_Zoe_Buffs` (Zoe-style), plus **`mul=1.5 ChangeLootCount` on every `FindTreasure*` size + Erudite + BeanACollada** (with all event suffixes). `description.GetTimeBonus = 250` | **Treasure (moderate)** — wiki: "+150% task speed, +50% rewards on treasure searches, guaranteed buff on treasure and adventure searches". Anniversary Event 2020. The Zoe-style private adventure-buff drop is a side bonus | wiki |
| 61 | Scared Explorer | 277 | `Trait_ScaredExplorer` | 6 effects: `+1 ChangeLoottableRolls` on private `FindTreasure_Scared_Buffs`, plus **`mul=4 ChangeLootCount` on every `FindTreasure*` size** (with all event suffixes; no Erudite/BeanACollada). `description.GetTimeBonus = 25` | **Treasure (very strong, slow)** — wiki: "-75% task speed, 4× rewards on treasure searches, small chance to find crystals/premium days/books". Halloween Event 2020. The unusual 25% TimeBonus is the speed penalty rendered as a positive number, not a 75% boost. Recommendation is treasure with the caveat that searches take 4× longer | wiki |
| 68 | Motherly Explorer | 286 | `Trait_MotherlyExplorer` | 7 effects, **`mul=4 ChangeLoottableRolls` on every `FindTreasure*` size + Erudite + BeanACollada** (with all event suffixes). `description.GetTimeBonus = 100` | **Treasure (very strong)** — wiki: "loves to bring back lots of loot". Same shape as Emphatic (GetType=48) but `mul=4` instead of `mul=3`. Year-round score ≈ 21 (7 × ((4-1) chance=1)). Strong recommendation regardless of events | wiki |
| 69 | Benevolent Explorer | 287 | `Trait_BenevolentExplorer` | 2 effects: `+1 ChangeLoottableRolls` on `FindTreasureEvenLonger` private `FindTreasure_Benevolent_Buffs1`, and on `FindTreasureProlonged` private `FindTreasure_Benevolent_Buffs2`. `description.GetTimeBonus = 200` | **Long-form buff finder** — wiki: "+100% speed, always finds an extra buff (sometimes a Medipack) on EvenLonger and Prolonged treasure searches". Football Event 2021. Bias is "extra buff loot rolls on the two longest variants"; family-wise lean is treasure (slight) | wiki |

Note: the host's own modifier name is **`ChangeLoottableRolls`** (not
`changeloottablerolls`); autoTSO at `user_auto.js:4456` lower-cases before
comparing. Our matcher will do the same.

## Effect modifier vocabulary (observed so far)

The `modifier_string` field inside a skill effect has used these values:

| Modifier | Meaning | Affects |
|---|---|---|
| `searchTime` | Multiplies / replaces / adds to the task's duration. `value` overrides duration outright; otherwise `duration = duration * multiplier + adder`. Lower is better for the explorer. | All task families |
| `ChangeLoottableRolls` | Multiplies (or adds to via `adder`) the number of loot table rolls that fire when the task completes. Stacks with the host's per-event drop tables. | Treasure family heavily; some adventure entries |
| `ChangeLootChance` | Adds `value` percent to the chance of a particular loot drop. Used by skills like `mistwalker` for unlocking `_Lovely_*` seasonal variants. | Treasure family |
| `ChangeLootCount` | Multiplies the count of items returned per loot roll. | Treasure + Adventure |
| `searchCost` | Reduces the resource cost of dispatching. Multiplier `<1` = cheaper. | Adventure family observed |
| `modifierEffect` | Per-effect chance multiplier — appears with `chance < 1` and is applied separately. Probably a "this effect only fires sometimes" shaper. | Both families |
| `unlockTask` | Marks a task variant as available. Used by `travellingErudite` (skill 39) and `beanAColada` (skill 40) to gate the FindTreasureTravellingErudite / FindTreasureBeanACollada subtask IDs (1,4 and 1,5). | Erudite / BeanACollada gating |

(Princess-style "find buff" / "find adventure" bonuses likely use one or
two more modifier names we haven't catalogued. Update this table when the
next dump produces them.)

## Other vocabulary (observed)

`type_string` values seen so far:

- **Treasure family**: `FindTreasureShort`, `FindTreasureMedium`,
  `FindTreasureLong`, `FindTreasureEvenLonger`, `FindTreasureProlonged`,
  `FindTreasureTravellingErudite`, `FindTreasureBeanACollada`.
- **Treasure seasonal variants**: `FindTreasure_Lovely_<Variant>`,
  plus per-event suffixes appended to standard names — e.g.
  `FindTreasureShort_Easter`, `FindTreasureMedium_XMAS`,
  `FindTreasureLong_SoccerResources`, `FindTreasureProlonged_Halloween`,
  `FindTreasureProlonged_RedNose`, `FindTreasureBeanACollada_Lovely`,
  `FindTreasure_Lovely_Long_SoccerResources`, etc.
  These appear to gate event-resource drops on a per-task basis.
- **Trait-private drop tables**: `FindTreasure_<Name>_<Category>` and
  `FindAdventure_<Name>_<Category>` — e.g. `FindTreasure_Zoe_Buffs`,
  `FindTreasure_Zoe_Adventures`, `FindAdventure_Zoe_Buffs`. These look like
  dedicated loot tables only that explorer's trait can roll on. The trait
  effect leaves `type_string` empty and matches by `name_string`, so the
  bonus stacks on top of whatever standard treasure / adventure the player
  dispatched.
- **Adventure family**: `FindAdventureZoneShort`, `FindAdventureZoneMedium`,
  `FindAdventureZoneLong`, `FindAdventureZoneVeryLong`. Plus the meta
  target `FindAdventureZone` (no suffix) used by `troubleSeeker` to
  apply a single effect across the whole family.
- **Other task families** (visible via the `friendpremiumbuff1` premium
  buff): `FindExpeditionPvPSmall/Medium/Big`, `ExploreSector`,
  `ExploreIsland`, `ExpeditionRecover`, `IntrepidLoot`,
  `FindDeposit<Resource>` (Stone, Marble, Coal, BronzeOre, IronOre,
  GoldOre, Granite, TitaniumOre, Salpeter — the geologist task family).

`name_string` on effects can be a comma-separated list of task identifiers
that the effect applies to. Some Lovely / Sturdy Shovel entries have ten+
names spanning every event suffix. Treat empty strings as "matches by
type_string only".

## Skill-tree slot identities (skill ids 22-41)

The skill tree is the same 20 slots for every explorer; the player invests
points to level them. Each carries one or more effects at each level
(usually one at L1 and a stronger version at L3). Captured names:

| id | name_string | gist |
|---|---|---|
| 22 | luckyDetour | `FindTreasureMedium ChangeLootChance +8` (and a `_Lovely_` mirror) |
| 23 | pilgrimage | `FindTreasureLong searchTime ×0.95 / ×0.85 (L3)` |
| 24 | mountainBoots | `searchTime ×0.91` on every treasure variant |
| 25 | wildDetermination | `FindAdventureZone* ChangeLootCount ×1.3 / ×1.9 (L3)` + `IntrepidLoot ×same` |
| 26 | powderSack | `FindTreasureEvenLonger ChangeLootCount ×1.08` |
| 27 | offbeatRoads | `FindTreasureLong ChangeLootChance +5` |
| 28 | extendedWeekend | `FindTreasureMedium searchTime ×0.95 / ×0.85 (L3)` |
| 29 | travelExpenses | `FindAdventureZone* searchCost ×0.7 / ×0.9` |
| 30 | lootWagon | `FindTreasureMedium ChangeLootCount ×1.08` |
| 31 | sturdyShovel | `FindTreasure* ChangeLootCount ×1.03 / ×1.09 (L3)` |
| 32 | mistwalker | `FindTreasureEvenLonger ChangeLootChance +30` |
| 33 | troubleSeeker | `FindAdventureZone ChangeLoottableRolls +1, chance=0.1 / 0.3 (L3)` |
| 34 | heroOre | `FindTreasureLong ChangeLootCount ×1.08` |
| 35 | sabbatical | `FindTreasureEvenLonger searchTime ×0.95` |
| 36 | pathfinder | global `searchTime ×0.95 / ×0.9 (L2)` (empty type_string = applies to all) |
| 37 | sophisticatedPillager | `FindAdventureZone* modifierEffect, chance=0.3` |
| 38 | streetwiseNegotiator | `FindTreasureLong/EvenLonger modifierEffect, chance=0.3` |
| 39 | travellingErudite | `unlockTask FindTreasureTravellingErudite` (gates 1,4) |
| 40 | beanAColada | `unlockTask FindTreasureBeanACollada` (gates 1,5) |
| 41 | fearlessHiker | `FindAdventureZone* searchTime ×0.85 / ×0.95` |

## Algorithm: trait → recommended task family

Once the trait is captured, the recommendation can be derived
mechanically:

```
function biasFromTrait(trait, activeEvents, opts):
    // activeEvents: Set of event codes ('Easter', 'XMAS', 'HW',
    // 'Valentine', 'Soccer', 'RedNose', 'SpecialistWeek', …) currently
    // live, sourced from S.core.events.active(). Pass the empty set
    // for the off-event score; pass the universal sentinel ('ANY') to
    // treat every event as live.
    //
    // opts.eventBoost: positive number added to the treasure score
    // whenever activeEvents is non-empty. Used by callers to enforce
    // the "no adventure during events" rule without mutating any
    // host data — set to 0 to leave the trait's mechanical bias intact,
    // or to any value larger than the maximum observed adventure score
    // (~4) to guarantee treasure wins. Default 0; the recommended
    // production value is ≥1000 (well above any plausible trait score
    // we've observed). Wired off `explorers.forceTreasureOnEvents`.
    score = { treasure: 0, adventure: 0, deposit: 0, other: 0 }
    for each effect in trait.level_vector[traitLevel - 1]:
        // Princess-style traits leave type_string empty and match by
        // name_string (e.g. 'FindTreasure_Zoe_Buffs'). Fall back to
        // name_string when type_string is empty.
        tag = effect.type_string || effect.name_string.split(',')[0]
        family = 'treasure'  if tag starts with 'FindTreasure'  else
                 'adventure' if tag starts with ('FindAdventureZone'
                                             or 'FindAdventure_'
                                             or 'IntrepidLoot')    else
                 'deposit'   if tag starts with 'FindDeposit'      else 'other'
        // IntrepidLoot is a loot-table identifier grouped with the four
        // FindAdventureZone* variants by `wildDetermination`. Adventure
        // family — see resolved open question 5.

        mod = effect.modifier_string.toLowerCase()
        weight = 0
        if mod in ['changeloottablerolls', 'changelootcount', 'changelootchance']:
            weight = max(effect.adder, effect.multiplier - 1) * (effect.chance || 1)
            if weight <= 0: continue
        else if mod == 'searchtime':
            // duration = duration * multiplier + adder; <1 is faster
            // (good), >1 is slower (bad). Score (1 - multiplier) so
            // positive numbers always mean "use this family." Negative
            // weight is kept — it's a real "this family is actively
            // discouraged" signal (Nora the Explorer is canonical).
            weight = (1 - effect.multiplier) * (effect.chance || 1)
        else: continue

        // Seasonal gating. The effect's name_string lists the loot-
        // table identifiers the bonus fires on. Classify the entries
        // (the original Python tool's `classify_effect()` codified
        // this; the algorithm now lives inline below):
        //   - 'plain'         : bare type_string match (year-round)
        //   - 'lovely'        : '_Lovely' token without event suffix
        //                       (Lovely-trait private; year-round for owner)
        //   - 'trait-private' : 'FindTreasure_<TraitName>_*' /
        //                       'FindAdventure_<TraitName>_*' / 'IntrepidLoot'
        //                       (year-round for owner)
        //   - 'event-gated'   : entry ends with a known event suffix
        //                       (_Easter, _XMAS, _Halloween, _Valentine,
        //                        _SoccerResources, _SoccerBalls, _RedNose,
        //                        _SpecialistWeek, …) and no plain entry
        //                       in the list — fires only when the event
        //                       is live
        //
        // An effect with mode='event-gated' contributes its weight ONLY
        // when one of its events is in activeEvents (or activeEvents
        // is the 'ANY' sentinel). All other modes contribute year-round.
        cls = classifyEffect(effect)
        if cls.mode == 'event-gated':
            if activeEvents != 'ANY':
                if not (cls.events ∩ activeEvents): continue

        // Effects with mode='mixed' (plain entry AND event-suffixed
        // entries sharing the same multiplier — e.g. Courageous
        // Explorer's `name_string='FindTreasureShort, FindTreasureShort_Easter, …'`)
        // get the full weight credited regardless of activeEvents,
        // since the SAME multiplier fires whether the dispatch lands
        // on the plain or the suffixed loot-table identifier.

        score[family] += weight

    // Treasure boost when an event is live. Implements the "no adventure
    // during events" rule the host's economy assumes — short/medium
    // treasures yield far more event items per hour than adventures, so
    // we want every owned explorer on treasures during the event. The
    // boost is purely additive to OUR scoring; nothing mutates the host
    // trait/skill objects.
    if activeEvents is non-empty AND opts.eventBoost > 0:
        score['treasure'] += opts.eventBoost

    return whichever family has the highest positive score, or null if
    no family is positive (treat the trait as neutral and follow the
    user default)
```

For Courageous Explorer the result is unambiguously `treasure` (every
effect is on `FindTreasure*` with `multiplier=2`). For Candid Explorer
it's a stronger `treasure`. For Lovely Explorer it's `treasure` only on
the `_Lovely_*` suffixes — outside events the result is neutral or
slightly negative, suggesting we should treat Lovely as "follow user
default unless an event matching her bonus is live".

For Princess Zoe: captured. Hypothesis was off — she does **not** introduce
a new modifier name. She reuses `ChangeLoottableRolls` (the same modifier
Courageous / Candid use) but targets it via three private `name_string`
drop tables: `FindTreasure_Zoe_Buffs`, `FindTreasure_Zoe_Adventures`, and
`FindAdventure_Zoe_Buffs`. With `type_string` empty, the engine must be
matching purely on `name_string`. Effect-count tilt is 2 treasure : 1
adventure, so the algorithm above returns `treasure` for her — but a
mechanical reading is "she rolls extra buff/adventure-scroll loot
regardless of which family she's dispatched on." The `_Zoe_Buffs` table
appearing on **both** treasure and adventure dispatches is what makes her
useful in either family. UI should probably annotate her recommendation
as "treasure (slight) — also produces buffs/scrolls on either family"
rather than a strict family pick.

For Nora the Explorer: with the `searchTime` branch added above, her
score becomes:

- treasure  = `(1 - 1.5) × 7 = -3.5` (seven `FindTreasure*` slowdowns)
- adventure = `(1 - 0.5) × 4 + 2 = 4.0` (four `FindAdventureZone*`
  speedups + two `+1` loot-roll adders on Long / VeryLong)

So the algorithm now returns a strong adventure recommendation that
matches the data. Without the speed branch she scored only
`adventure=2.0` and the host's clear "treasure is actively discouraged"
signal was invisible.

## Per-explorer dispatch recommendation

Concrete dispatch task per owned explorer type, derived by combining
the family bias from `biasFromTrait()` with the trait's per-variant
emphasis (which subtasks within the family the trait actually boosts).
"Off-event" assumes no relevant seasonal event is live; "event live"
assumes at least one of the trait's listed events is active.

| GetType | Name | Off-event task | When event live | Notes |
|---|---|---|---|---|
| 1 | Explorer | follow user default | follow user default | vanilla — no trait |
| 10 | Experienced Explorer | follow user default | follow user default | vanilla — no trait |
| 32 | Courageous Explorer | **Treasure (any variant)** | same | `+2×` rolls on every treasure variant year-round; pick the size the user prefers |
| 39 | Candid Explorer | **Treasure (any variant)** | same | `+4×` rolls on every treasure variant — strongest plain-treasure trait |
| 41 | Lovely Explorer | **Treasure (Short / Medium / Long / EvenLonger / Prolonged)** | same | year-round `+2` on `_Lovely_<size>` private rolls; event-time adds another `+1` per `_Lovely_<size>_<event>`; recommendation unchanged but value rises during {Easter, HW, RedNose, Soccer, Valentine, XMAS} |
| 44 | Princess Zoe | **Treasure (any variant) — bias slight, also produces buffs/scrolls on adventure** | same | trait-private `_Zoe_*` drop tables fire on either family; treasure wins by 2:1 effect count but practical use is "wherever buffs/scrolls are wanted" |
| 48 | Emphatic Explorer | **Treasure (any variant)** | same | `+3×` rolls on every treasure variant year-round |
| 51 | Bewitching Explorer | **Treasure (Short or Prolonged preferred)** | same | year-round `+4` on Short/Prolonged, `+3` on Medium/Long/EvenLonger, plus `mul=2` on TravellingErudite (the host has to allow it); event-time adds `_Lovely_<size>_<event>` rolls |
| 53 | Humble Explorer | **Treasure (Short or Medium only)** | same | `mul=6` on Short/Medium; trait gives nothing on Long/EvenLonger/Prolonged so don't waste her there |
| 55 | Keener Explorer | **Adventure (any variant)** | same | `+2 IntrepidLoot` rolls — adventure-family synergy specialist; works on every `FindAdventureZone*` variant equally |
| 65 | Snowy Explorer | **Treasure (Short / Medium / Long / EvenLonger / Prolonged)** | same | year-round `+2×` Lovely-private; event-time `+4×` on plain + `_Lovely_<size>_<event>`; year-round usable but disproportionately valuable during {Easter, HW, RedNose, Soccer, XMAS} |
| 66 | Romantic Explorer | **Treasure (Long / EvenLonger / Prolonged)** | same | `mul=12` (!) on Long-form treasures only; useless on Short/Medium |
| 70 | Royal Explorer | **Adventure (any variant)** | same | `+1` roll on every `FindAdventureZone*` via private `FindAdventure_Royal_Buffs<n>` tables |
| 74 | Pirate Explorer | **Treasure (any variant)** | same | `ChangeLootCount mul=2` on every plain treasure year-round + private `FindTreasure_Pirate_Buffs`; some bonuses gated on SpecialistWeek |
| 78 | Fluffy Butte Explorer | **follow user default** *(trait inactive)* | **Treasure (Short / Medium / Long / EvenLonger / Prolonged)** | seasonal-only — `+5×` rolls fire only when {Easter, HW, RedNose, Soccer, XMAS} is live. Off-event her trait contributes zero; treat as a vanilla Explorer |
| 84 | Love Struck Explorer | **Adventure (any variant)** | same | `+1` roll on every `FindAdventureZone*` via private `FindAdventure_LoveStruckExplorer<n>` tables |
| 87 | Blacktree Explorer | **Treasure (Long / EvenLonger / Prolonged)** | same | `+1` roll on Long-form treasures year-round; mild but reliable |
| 90 | Chummy Explorer | **Treasure (Prolonged preferred, EvenLonger > Long)** | same | `+2` on Prolonged, `+1` on EvenLonger, `+1×0.75 chance` on Long; weight peaks on Prolonged |
| 94 | Ghost Explorer | **Treasure (Prolonged preferred, EvenLonger > Long)** | same | probabilistic stacked rolls — Prolonged carries the highest expected value (~3 rolls), EvenLonger ~2.1, Long ~1.75 |
| 97 | Nora the Explorer | **Adventure (Long or VeryLong preferred)** | same | adventure tasks run at `searchTime ×0.5` (faster), treasure at `×1.5` (actively discouraged); `+1` roll specifically on Long/VeryLong adventures — pick those over Short/Medium |

Off-event vs event-live differs only for type 78 (Fluffy Butte). Every
other trait's recommended task is unchanged year-round; events only
amplify the value, they don't change which task to send.

### Subtask selection rules

The "Off-event task" column above gives the **family** (and any trait-
forced size constraint, e.g. Romantic = Long-form only). Within the
family, picking a specific subtask follows two different rules:

- **Off-event (default rule of thumb)**: prefer the **longest available**
  variant. Treasure rolls scale roughly with duration, so longer
  searches yield more items per dispatch — and dispatches are
  individually cheap (you're not throughput-bound on dispatch slots
  off-event). Today's hardcoded fallback at
  `core/specialists.js:816` (`ExplorerTask.Short`) violates this rule
  and should be changed to `ExplorerTask.Prolonged` (or whatever the
  trait-allowed maximum is).
- **On-event (items/hour optimisation)**: pick the variant with the
  highest `(treasureValue × itemModifier) / duration` — short/medium
  variants typically win because event treasure values don't scale
  proportionally with duration. Steward already implements this in
  `core/specialists.js:770-804` (`bestTaskForEvent`), matching
  autoTSO's `user_auto.js:4914-4968` formula. **No new code needed**
  for on-event picking; it just needs to be exercised by tests after
  trait-aware routing lands.

Worked example for Easter (`treasureValues: [2.6, 3.9, 5.9, 8.8, 11.7]`)
with a 1.0× time bonus and no skill speedups:

| Variant   | items | duration  | items/h |
|-----------|-------|-----------|---------|
| Short     | 2.6   | 1.2 h     | **2.17** |
| Medium    | 3.9   | 3.0 h     | 1.30 |
| Long      | 5.9   | 6.0 h     | 0.98 |
| EvenLonger| 8.8   | 9.0 h     | 0.98 |
| Prolonged | 11.7  | 14.4 h    | 0.81 |

Short wins on items/hour by ~2.7× over Prolonged. Skill speedups +
trait loot multipliers can shift the optimum to Medium for some
explorers, which is why the algorithm computes per-explorer rather
than picking a fixed size.

### Configurable user default

The "follow user default" outcome (vanilla Explorer, Experienced
Explorer, off-event Fluffy Butte) needs a dropdown on the Explorer
settings page so the player can pick their preferred fallback variant.
Suggested options:
- `Treasure — Prolonged` (recommended default per "prefer longer")
- `Treasure — EvenLonger`
- `Treasure — Long`
- `Treasure — Medium`
- `Treasure — Short`
- `Adventure — VeryLong / Long / Medium / Short` (when the player
  has a paid-up adventure stash)
- `Skip dispatch` (don't send vanilla explorers automatically)

Persist as `mainSettings.explDefTaskByType[default]` (or a new
`mainSettings.stewardExplorerDefault`) so it survives reloads. Tracked
as a separate UI work item — not part of trait recommendations.

## Open questions

All open questions resolved as of 2026-04-27 — list retained for
traceability; trim on next doc pass.

1. ~~**Princess Zoe's trait**~~ — captured (id=200). All 20 home-zone explorer types captured in the table above. Trait-private drop-table gating (`_Zoe_*`, `_Pirate_*`, `_Lovely_*`) folded into question 3 below.
2. ~~**`modifierEffect` semantics**~~ — resolved 2026-04-27 (provisionally). Every observed `modifierEffect` entry is numerically inert (`multiplier=1, adder=0, value=0, name_string=`) with `chance=0.3` — so the value isn't in the data, it's an engine hook keyed by skill ID. The host probably runs a hardcoded routine for each skill when the marker fires (`sophisticatedPillager` and `streetwiseNegotiator` are the only two skills using it, hinting at "extra plunder" / "better negotiation" behaviour respectively). `biasFromTrait()` correctly skips `modifierEffect` since its modifier whitelist doesn't list it. Refine if a player ever levels one of these skills and observes specific drop behaviour.
3. ~~**`FindTreasure_Lovely_*` / private trait drop-table gating**~~ — resolved 2026-04-27 (algorithmically moot). The host could be doing any of: (A) tables always exist, only the matching trait's `+1 ChangeLoottableRolls` rolls them; (B) tables conditionally injected when the matching trait is on dispatch; (C) tables always exist and roll, but the `name_string` filter only fires the bonus for the matching trait. Under all three readings `biasFromTrait()` produces the same recommendation per trait — we only score effects that exist on the trait, and those are correctly attributed regardless of how the host implements the table lifecycle. Empirical test (dispatch a non-Zoe explorer and observe whether any `_Zoe_*` drops occur) is gameplay observation, not data analysis; not blocking.
4. **The premium buff (id=301) effect on `FindExpeditionPvP*` / `ExploreSector` / etc.** confirms the host has at least 7 explorer task families beyond treasure + adventure-zone. Out of scope for v0.5 — note for the future adventure / expedition modules. *(Not a recommendation-blocker; tracked for scope, not for resolution.)*
5. ~~**`IntrepidLoot` (Keener Explorer)**~~ — resolved 2026-04-27. `IntrepidLoot` is a named loot table (not a task type — confirmed by absence from the premium buff's 26-task `searchTime` list). `wildDetermination`'s effect list pairs it with the four `FindAdventureZone*` variants under the same modifier (`ChangeLootCount`) and same multiplier, so `biasFromTrait()` now bins it as adventure family. Sound-notification keys (`ExplorerStart_IntrepidExplorer` vs `ExplorerStart_KeenerExplorer`) confirm there's a separate "Intrepid Explorer" trait type the player doesn't currently own; Keener's role appears to be an adventure-family synergy specialist that boosts `IntrepidLoot` rolls (whether she requires an Intrepid Explorer co-dispatch or rolls IntrepidLoot on every adventure is the remaining empirical question — but doesn't change the adventure-family recommendation).
6. ~~**Search-time as a recommendation signal**~~ — resolved 2026-04-27. `biasFromTrait()` now scores `(1 - multiplier) × chance` for `searchTime` effects, so Nora the Explorer comes out as adventure=4.0 / treasure=-3.5 instead of the previous adventure=2.0 / treasure=0. Kept here for traceability; remove on next doc trim.

## Next dump targets

All 20 home-zone explorer types (1, 10, 32, 39, 41, 44, 48, 51, 53, 55,
65, 66, 70, 74, 78, 84, 87, 90, 94, 97) captured on 2026-04-27. The
canonical source for re-analysis is now
`docs/analysis/specialists-20260427-134729.json` (schema v2). Re-parse
with `docs/analysis/parse-specialists-dump.js`.

Future dump targets:

- Explorer types **not** owned by the player (any types > 97 introduced by
  later events).
- Geologists (`baseType=2`) — same probe with the deep-dump tool, captures
  trait-targeted `FindDeposit*` effects.
- Generals / Carriers / Marshals / Admirals (`baseType=0`) — combat trait
  data lives in the same `spec.skills` collection.

## Generalisation: same model applies to Geologists (and other specialists)

The trait mechanism is **not explorer-specific**. The host uses the same
`{ getSkillTree(), skills }` shape on every specialist type:

- **Generals / Carriers / Marshals / Admirals (baseType=0)** — `spec.skills`
  carries combat-related traits; `isTransportGeneral()` is one effect-less
  classification helper but the rest of the bonus data lives in the same
  trait-skill collection.
- **Geologists (baseType=2)** — `spec.skills` holds traits whose effects
  target `FindDeposit<ResourceName>` task types (Stone, Marble, Coal,
  BronzeOre, IronOre, GoldOre, Granite, TitaniumOre, Salpeter — same names
  the universal `friendpremiumbuff1` dumps showed).

Implication for Steward: **autoTSO's hardcoded geologist recommendation
table** (`user_auto.js:3514-3522`) — `{ Stone: [35, 62, 38, 49], … }` —
can be **derived from data instead of hardcoded**. For each geologist
GetType, walk its trait, look at which `FindDeposit*` effects have
positive `multiplier > 1` or `adder > 0`, and surface that as the
recommended deposit list. Strictly more accurate than the static map and
needs no community maintenance as new types are added.

The same `biasFromTrait()` algorithm above generalises — substitute
`FindDeposit*` for `FindTreasure*` / `FindAdventureZone*` and the rest of
the logic carries over.

Implementation plan (when we tackle it):

1. Generalise the deep-dump probe (`diagnostics/ui.js`) to take a
   `baseType` parameter — explorer (1) is the current default; add a
   second button for geologist (2).
2. Capture geologist trait data the same way we're doing for explorers.
3. Build a `Steward.core.specialists.recommendedDeposits(spec)` helper
   alongside the explorer pickers.
4. Surface a "Recommendation" link in the future Deposits / Geologists
   dashboard section that pre-fills per-deposit assignments from the
   derived data.

Not in scope for v0.5 (no Geologists module yet). Documented here so the
groundwork carries forward.
