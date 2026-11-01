# Geologist Traits — Live Findings

> Status: in progress, snapshot 2026-04-28. Sourced from
> `Settings → Diagnostics → Dump Specialists` runs (host script
> `docs/analysis/dump_specialists.js`). Update as more types are
> captured.

## TL;DR

Like explorers, special-geologist behaviour lives on **`spec.skills`** — a
separate skill collection from `spec.getSkillTree()`. Each special
geologist carries one trait entry whose `name_string` is either:

- a `Trait_<Name>Geologist` form (e.g. `Trait_LovelyGeologist`), or
- a lower-case word/phrase (e.g. `stone_cold`, `gold_hearted`,
  `iron_willed2`, `conscientious`, `Stargazinggeology`, etc.).

The `getSkillTree()` collection is identical structurally for every
geologist type — same 20 slots (skill ids 1-20). Look at `spec.skills`
for trait identity and routing input.

The trait's `level_vector[lvl-1]` effects encode the bonus mechanically.
Two modifiers drive ranking today:

- **`searchDepositCapacity`** — multiplies the size of deposit found.
  Higher is better. Multiplicative across stacked effects.
- **`searchTime`** — multiplies search duration. Lower is better
  (`mul<1` = faster, `mul>1` = slower). Multiplicative across stacked.

Two more modifiers appear in the data but aren't yet used by Steward's
scoring (`src/core/specialists/geologists.js:106 geologistScoreFor`):

- **`findDeposit`** — appears with `add=1` and a sub-1.0 chance, looks
  like an "extra deposit found per search" effect.
- **`modifierEffect`** — bare effect with no multiplier/value; chance
  varies. Likely a host-side hook that rolls a per-deposit "premium"
  modifier (e.g. larger / richer deposits).

`friendpremiumbuff1` (id=301) is excluded from scoring — every spec
carries it (universal premium buff applying `searchTime ×0.8` to every
task family), so it's neutral for ranking purposes.

## What lives where

```
spec.GetSpecialistDescription()
    .getName_string()        e.g. "Geologist", "Stone Cold", …
    .getBaseType()           2 = Geologist
    .GetTimeBonus()          1.0 / 100% for vanilla; tier-up multipliers
                             (200% etc.) on rare types

spec.getSkillTree().getItems_vector()
    20 items, ids 1-20. Universal across all geologist types — the per-
    type differences live elsewhere. Levels per-type still affect
    optimisation (e.g. `tendentiousGeologist` adds searchTime bonus).

spec.skills.getItems_vector()
    The trait collection. Two kinds of entries:
      - id=301, name_string='friendpremiumbuff1' — universal premium
        buff applied to ALL specs. searchTime ×0.8 on every task type.
        Equivalent to a "VIP" boost.
      - any other id, name_string ≈ 'Trait_<Name>Geologist' OR a bare
        lower-case word — the per-type trait. Encodes the actual bonus
        that distinguishes this geologist. Identify by "not 301" rather
        than by id range.
```

## Captured trait skills

### Verified (observed in our 2026-04-27 roster dump)

| GetType | Display name | Trait id | Trait name_string | Effect summary | Bias |
|---|---|---|---|---|---|
| 2 | Geologist | — | (no trait) | `friendpremiumbuff1` only | follow user default — vanilla |
| 35 | Stone Cold | 116 | `stone_cold` | 6 effects on Stone/Marble/Granite — `searchTime mul=0.5` + `searchDepositCapacity mul=2` | **Stone-family specialist** — the trio of structural deposits, twice as fast and twice as productive |
| 38 | _versed_ | 119 | `versed` | 27 effects on every deposit: `searchTime mul=0.5` + `searchDepositCapacity mul=1.5`, plus `findDeposit add=1, chance=0.5` on every type | **Universal balanced** — moderate speed/capacity boost across all 9 deposit types, half-chance bonus deposit per search |
| 40 | _Lovely Geologist_ | 121 | `Trait_LovelyGeologist` | 6 effects on Iron/Titanium/Salpeter — `searchDepositCapacity mul=2` + `modifierEffect chance=1` | **Premium-trio specialist** — guaranteed modifier on Iron, Titanium, Salpeter; double capacity |
| 42 | Gold Hearted | 175 | `gold_hearted` | 3 effects on Gold only: `searchTime mul=0.5` + `searchDepositCapacity mul=2` + `modifierEffect chance=1` | **Gold specialist** — fastest + biggest gold deposits, with guaranteed modifier |
| 45 | Buried Treasure | 177 | `buriedTreasure` | 5 effects, all `modifierEffect`: Coal/Gold chance=0.25, Granite/Titanium/Salpeter chance=0.5; `description.GetTimeBonus = 200` | **Tier-2 modifier specialist** — no time/capacity bonus, only chance to roll modifier on premium deposits |
| 59 | _deservedBonus_ | 179 | `deservedBonus` | 14 effects on every deposit except Stone: `searchTime mul=6` (heavy penalty) + `searchDepositCapacity mul=1.5`; modifierEffect chances Marble=0.25 / Iron=0.35 / Coal/Gold=0.5 / Granite/Titanium/Salpeter=0.75 | **Slow rare-resource modifier** — 6× longer searches in exchange for cap×1.5 and high modifier chances on premium deposits. Weighing factor on speed is severe |
| 62 | _chummyBonus_ | 180 | `chummyBonus` | 23 effects: tier-1 (Stone/Bronze/Marble/Iron) `searchTime mul=0.5`; tier-2 (Coal/Gold/Granite/Titanium/Salpeter) `searchTime mul=1.5`; cap×1 across the board; chance modifierEffect 0.4 (Coal/Gold) / 0.6 (Granite/Titanium/Salpeter) | **Tier-split** — fast on tier-1, slow on tier-2 with chance modifier |
| 76 | Gingerbread Geology | 306 | `GingerbreadGeology` | 27 effects on every deposit: `searchTime mul=3` + `searchDepositCapacity mul=1.5`; modifierEffect chances 0.25 (Stone/Bronze/Marble) / 0.35 (Iron) / 0.5 (Coal/Gold) / 0.75 (Granite/Titanium/Salpeter) | **Slow universal w/ tiered modifier chance** — capacity boost universal, modifier chance scales with deposit tier |
| 80 | Vacational Geology | 315 | `VacationalGeology` | 27 effects on every deposit: `searchTime mul=2` + `searchDepositCapacity mul=1.5` + `modifierEffect chance=1` | **Slow universal w/ guaranteed modifier** — 2× slower searches but guaranteed modifier on every deposit type |
| 83 | Sooty | 320 | `sooty` | 3 effects on Coal: `searchTime mul=0.75` + `searchDepositCapacity mul=3` + `modifierEffect chance=0.75` | **Coal specialist (best observed)** — 25% faster, 3× capacity, 75% chance of modifier |
| 86 | _balanced_ | 325 | `balanced` | 18 effects on every deposit except Salpeter: `searchTime mul=0.5` + `modifierEffect chance=1` | **Universal speed + guaranteed modifier** — no capacity boost, but every search is fast and rolls a modifier |

### Newly catalogued from external dump (2026-04-28)

Sourced from `docs/analysis/user_provided/angrywolf_specialists-20260428-122935.json`.
Display names cross-referenced with
[settlersonlinewiki.eu](https://settlersonlinewiki.eu/en/guides/geologist/),
[tsomaps](https://en.tsomaps.com/handbook/geologs/), and
[settlersportal](https://settlersportal.com/specialists/geologists).
The "Verified?" column indicates how the row was confirmed:

- `wiki` — display name + bias inferred from public wikis; mechanically
  consistent with raw effect data but not yet test-dispatched in our
  automation.
- `yes` — observed end-to-end in our own dispatch + log capture.
- `no` — neither verified.

| GetType | Display name | Trait id | Trait name_string | Effect summary | Implied bias | Verified? |
|---|---|---|---|---|---|---|
| 5 | Jolly Geologist | — | (no trait) | `friendpremiumbuff1` only; `description.GetTimeBonus = 200` | wiki: "finds new deposits in half the speed of the normal Geologist". Pure-speed vanilla tier-2 (300 Gems). Internal class name on tsomaps is `MasterGeologist` — the host's class label diverges from the in-game display name | wiki |
| 26 | Conscientious Geologist | 57 | `conscientious` | 9 effects on every deposit: `findDeposit add=1, chance=1` (no searchTime/capacity multipliers) | wiki: "finds an additional deposit on every search". Guarantees one extra deposit found on every dispatch, on every deposit type. **Note:** the `findDeposit` modifier is NOT yet handled by `geologistScoreFor`, so this trait scores as vanilla until the scorer is extended | wiki |
| 34 | Iron-Willed Geologist | 115 | `iron_willed2` | 2 effects on IronOre: `searchTime mul=0.5` + `searchDepositCapacity mul=2` | wiki: "Iron Ore deposits twice the size in half the time" (+100% task speed, +100% deposit size on Iron only). Easter Event item. Same shape as `stone_cold` but Iron-only — use for IronOre dispatches | wiki |
| 49 | Thorough Geologist | 178 | `thorough` | 18 effects on every deposit: `searchTime mul=3` (penalty) + `searchDepositCapacity mul=3` | wiki: "takes three times as long on deposit searches but finds three times bigger deposits". Universal capacity tripler at 3× time cost. In current scoring, capacity wins over time, so this geo ranks above vanilla on every deposit | wiki |
| 95 | Stargazing Geologist | 336 | `Stargazinggeology` | 23 effects on every deposit: `searchTime mul=2` + `searchDepositCapacity mul=2`; modifierEffect chances Coal/Gold=0.25, Granite/Titanium/Salpeter=0.5 | wiki: "−50% task speed, +100% deposit size, chance to find Star Shards on successful searches for Coal, Gold Ore, Granite, Titanium Ore and Saltpeter". Christmas Event 2025. Like `GingerbreadGeology` but cap×2 instead of cap×1.5; better on premium deposits than tier-1 | wiki |

## Effect modifier vocabulary (observed)

| Modifier | Meaning | Steward scoring? |
|---|---|---|
| `searchDepositCapacity` | Multiplies deposit size found. Higher = better. Multiplicative across stacked effects. | yes — `geologistScoreFor` |
| `searchTime` | Multiplies search duration. Lower = better. Multiplicative across stacked effects. | yes — `geologistScoreFor` |
| `findDeposit` | Adds extra deposits per search (`add=N, chance=C`). Appears on `versed` and `conscientious`. | **no** — not yet handled. Currently doesn't influence ranking |
| `modifierEffect` | Bare effect with no multiplier/value, only `chance`. Likely a host-side hook that rolls a per-deposit "premium" modifier on the result. | **no** — not yet handled. Could be modelled as a separate score axis once the gameplay effect is confirmed |

## Open questions

1. **`findDeposit` modifier semantics.** Does `add=1, chance=0.5` mean
   "+1 deposit found, 50% chance to fire" or "the search yields N+1 with
   probability 0.5"? Worth a live spike on a `versed` or `conscientious`
   geologist before extending `geologistScoreFor`.

2. **`modifierEffect` semantics.** Same question — is the `chance`
   field the probability of rolling a "premium" deposit modifier, and
   if so, what does the modifier do at the gameplay level? Compare a
   `gold_hearted` (`chance=1`) Gold dispatch with a vanilla one and look
   at the post-search loot.

3. **`description.GetTimeBonus` discrepancy.** Most special geologists
   report `100` (i.e. 1.0× = vanilla baseline), even when their trait
   speeds up searches. The bonus appears to be a tier indicator (200% on
   `buriedTreasure`, vanilla `Geologist GetType=5`) rather than a real
   speed multiplier. Mining-trait `iron_willed2`'s 100% with `mul=0.5`
   confirms time bonus is independent from trait modifiers.

4. **`thorough` and `Stargazinggeology` time penalty.** `mul=3` and
   `mul=2` searchTime, paired with capacity multipliers, look like a
   classic trade-off. `geologistScoreFor` ranks capacity above time, so
   these geologists outrank vanilla even with the time penalty. Worth
   confirming in-game whether this is the intended use, or whether the
   user's preference should be configurable per-geologist.

## Trait → recommended deposit (rough)

For a deposit `D`, the routing module's `bestGeologistForDeposit(D)`
returns the geologist with the highest `capacityFactor` (tiebreak: lower
`timeFactor`). For traits whose effect set covers `D`, this works.
Vanilla geos score 1.0/1.0 — any trait with `searchDepositCapacity > 1`
on `D` outranks them.

For traits whose effects don't touch `D` (e.g. `stone_cold` on Iron),
`geologistScoreFor` returns 1.0/1.0 — equivalent to vanilla. The
ranking falls back to insertion order in that case.

The rough per-deposit "best trait" map (from current data):

| Deposit | Best trait | Notes |
|---|---|---|
| Stone | `stone_cold` (cap×2, time×0.5) | tied with `versed` (cap×1.5, time×0.5 + extra finds) |
| BronzeOre | `versed` | only universal cap-boosting trait that touches Bronze |
| Marble | `stone_cold` | matches Stone |
| IronOre | `iron_willed2` (Iron-Willed Geologist, wiki-verified) | cap×2 + time×0.5 on Iron; `versed` is the safe fallback when no Iron-Willed available |
| GoldOre | `gold_hearted` (cap×2, time×0.5, modifier guaranteed) | best single-deposit trait observed |
| Coal | `sooty` (cap×3, time×0.75, modifier 75%) | strongest observed trait by raw factor |
| Granite | `stone_cold` | tied with `versed` |
| TitaniumOre | `Trait_LovelyGeologist` (cap×2, modifier guaranteed) | best premium-deposit trait |
| Salpeter | `Trait_LovelyGeologist` | matches Titanium |
