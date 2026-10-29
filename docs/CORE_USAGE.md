# Using the Core Library

`Steward.core.*` is the general TSO library. Every module uses it; nothing else should. This document is the rulebook for module authors.

## What core gives you

| Namespace            | Purpose                                                      |
|----------------------|--------------------------------------------------------------|
| `Steward.core.zone`        | Current zone identity, navigation, predicates.         |
| `Steward.core.buildings`   | Find, list, classify buildings.                        |
| `Steward.core.specialists` | Find, list, classify, dispatch specialists.            |
| `Steward.core.deposits`    | Find, list deposits.                                  |
| `Steward.core.packets`     | `SendServerAction` and `SendMessagetoServer` wrappers. |
| `Steward.core.locale`      | `loca.GetText` shorthand + safe formatter.            |
| `Steward.core.events`      | Active events and their per-task modifiers.           |
| `Steward.core.adventures`  | Adventure definitions, grouped for the template maker, and the player's own open adventures. |
| `Steward.core.army`        | Free troop pool, squads, composition checks, supply plan. |
| `Steward.core.battles`     | Battle-file loader and validator against the army.    |
| `Steward.core.buffs`       | Star-menu buff stock (including adventure maps) and buff definitions. |
| `Steward.core.actions`     | Runs write actions: send, verify by observation, retry once. |
| `Steward.core.quests`      | Quest pool reads and the claim action.                |
| `Steward.core.production`  | Troop queue reads, order pricing and the order action. |
| `Steward.core.resources`   | Resource amount and free population reads.            |

Write actions are defs (plain objects with `precheck`, `send`, `check` and so on) built by the core that owns the action, for example `S.core.army.raise`, `S.core.quests.claim` and `S.core.production.order`. They run through `S.core.actions.attempt(def, onDone)`, which verifies by positive observation: a failed read or a missing object never counts as success. Which action to run and when stays with the module; the cores stay policy-free. Readers that defs rely on report a failed read as `null`, never as zero or an empty list.

Detailed API per file lives in `docs/analysis/PLAN.md` (P2 file scopes). Once P2 lands, each `core/*.js` source file's IIFE will be the canonical reference.

## Rule 1: don't reach past the helpers

Core returns **raw game objects**. That is intentional — it keeps the layer cheap. But it means it's tempting to chain into game internals from your module:

```js
// BAD — module reaches into the game API directly
if (b.GetGOContainer().mIsAttackable && !b.GetGOContainer().mIsLeaderCamp && b.GetGOContainer().ui !== 'enemy') {
    // ...
}

// GOOD — module asks core
if (Steward.core.buildings.isAttackable(b) && !Steward.core.buildings.isEnemy(b)) {
    // ...
}
```

If a helper you need doesn't exist yet, **add it to core**. Three signs you should:

1. You're about to write the same multi-step expression a second time.
2. The expression depends on game-internal field names (anything starting with `m`, `Get*`, `_`).
3. The expression encodes a meaningful concept (`isCollectible`, `isHome`, `hasArmy`).

Helpers are cheap to add. The cost of *not* adding them — duplicated logic, decay when the game API changes — is high.

## Rule 2: never compare against bare strings

Steward exposes shared enums for everything that has a fixed set of values:

```js
Steward.Building              // BuildingButchers, BuildingBakery, …
Steward.SpecialistType        // SpecialistGeneral, SpecialistCarrier, SpecialistExplorer, SpecialistGeologist
Steward.SpecialistStatus      // StatusIdle, StatusWorking, StatusTraveling, StatusReturning, StatusUnavailable
Steward.SkillModifier         // ModifierSearchTime, ModifierLootRolls, …
Steward.ExplorerTask          // TaskExplorerShort, …
Steward.GeologistTask         // TaskGeologistSearch, …
Steward.Priority              // PriorityCritical, PriorityNormal, PriorityIdle
```

Always use the enum reference at the call site:

```js
// BAD
if (Steward.core.specialists.classify(s) === 'SpecialistCarrier') { /* ... */ }
if (skill.modifier === 'searchtime') { /* ... */ }

// GOOD
if (Steward.core.specialists.classify(s) === Steward.SpecialistType.Carrier) { /* ... */ }
if (skill.modifier === Steward.SkillModifier.SearchTime) { /* ... */ }
```

The values are prefixed strings (`'SpecialistCarrier'`, not `'CARRIER'`) precisely so they're self-explanatory if they ever leak into a log or settings file. Don't undo that by hard-coding them.

## Rule 2.5: settings live in the host's namespace

Steward delegates settings persistence to the host's `settings` object. Every read/write goes through `Steward.kernel.settings.{read,write}` — modules never call `settings.store(...)` directly. Internally the kernel namespaces under `'steward.<module>'` so:

```js
Steward.kernel.settings.write('collect', { enabled: true });
// → host: settings.store({enabled: true}, 'steward.collect')
```

Why: per-profile separation (one settings file per game account, set in host index.html), free dropbox sync, single place to inspect.

## Rule 3: respect the cache contract

`Steward.core.buildings.list()` is cached per scheduler tick. The cache is cleared at the start of every tick — within a single tick, repeated calls are cheap and consistent.

If your module **mutates the building set** (places a mine, destroys a depleted deposit, upgrades a building), call:

```js
Steward.core.buildings.invalidate();
```

Otherwise subsequent reads in the same tick will return the stale snapshot.

You don't need to invalidate after server packets that *trigger* an asynchronous mutation — invalidation is for when you've taken an action whose effect you need to see immediately. Most modules never need this.

## Rule 4: use the locale wrapper

```js
// BAD
loca.GetText('BUI', 'FlyingHouse');
loca.GetText('RES', 'Coin');

// GOOD
Steward.core.locale.bui('FlyingHouse');
Steward.core.locale.res('Coin');
```

The wrapper handles missing-key fallback uniformly, and centralises the categorical strings (`'BUI'`, `'RES'`) so a typo doesn't ship.

## Rule 5: `pickTask` and `pickDeposits` are the source of truth

When choosing what an explorer or geologist should do next, ask core:

```js
var task     = Steward.core.specialists.pickTask(explorer);
var deposits = Steward.core.specialists.pickDeposits(geologist);
```

These methods consult, in order:

1. **Host per-spec overrides** — `mainSettings.explDefTaskByType[name]` / `geoDefTaskByType[name]`. If the user has configured a specific explorer/geologist's preferred task in the host UI, Steward respects it.
2. **Event-aware optimization** — for treasure events, picks the task with the best items-per-hour rate. For deposit-affecting events, returns the prioritized deposit list.
3. **Host global default** — `mainSettings.explDefTask` / `geoDefTask`.
4. **Hard-coded baseline** — `ExplorerTask.Short` / empty list.

If you're tempted to compute your own preferred task, check whether the desired behaviour is "the canonical answer plus a constraint" — if so, filter the result of `pickTask` rather than recomputing it. Modules add their own override at most as the *last* word, never bypassing host preferences entirely.

## Rule 6: dispatch composition is module concern

Core stays thin. The low-level send is in core:

```js
Steward.core.specialists.send(spec, taskType, params, responder);
```

The composed operation — "send geologists to find iron until we have 3 deposits queued" — is **module concern**. Each module composes its own dispatch logic over `available` + `pickX` + `send`. We don't centralize these compositions because different modules want different policies.

## Rule 7: wrap risky calls

Every game-API call can throw — the API surface is large and not all of it is documented. Wrap calls in try/catch and log the failure:

```js
function name(b) {
    try {
        return b.GetBuildingName_string();
    } catch (e) {
        Steward.kernel.warn('buildings', 'name failed:', e);
        return null;
    }
}
```

Core helpers do this internally so module code doesn't have to. When you're forced to reach past a helper (rare), do it yourself.

Don't wrap calls just to swallow them — autoTSO had 237 silent try/catch blocks and the cost of that decision is exactly why Steward exists. Always log the error with category context.

## Anti-patterns

| Anti-pattern                                   | Use instead                                              |
|-----------------------------------------------|----------------------------------------------------------|
| `building.GetGOContainer().mIsAttackable`     | `Steward.core.buildings.isAttackable(building)`          |
| `loca.GetText('BUI', name)`                   | `Steward.core.locale.bui(name)`                          |
| `if (status === 'IDLE')`                      | `if (status === Steward.SpecialistStatus.Idle)`          |
| Reaching into another module's settings       | Don't. Cross-module communication is via the kernel.     |
| Holding onto a `list()` result across ticks   | The cache is per-tick. Re-fetch every tick.              |
| Hard-coding deposit type names                | Add an entry to `Steward.Building` and use the enum.     |
| Using `console.log`                           | Use `Steward.kernel.log('module-id', …)`.                |

## When to extend core

Core grows as patterns become apparent. The flow:

1. You write a module and find yourself doing the same multi-step game-API expression more than once.
2. Add a helper to the relevant `core/*.js` file.
3. Update this document if the helper deserves explicit mention.

Core changes ship with their consumers. We don't pre-emptively design helpers for hypothetical modules.
