# Steward Architecture

Steward is a userscript for the Adobe AIR–based TSO client. It is structured as three concentric layers:

```
┌────────────────────────────────────────────────────────────┐
│  modules/   ← opt-in automation (collect, mail, …)         │
│      ▲                                                      │
│      │ depends on                                           │
│      ▼                                                      │
│  core/      ← general TSO library (no policy)              │
│      ▲                                                      │
│      │ depends on                                           │
│      ▼                                                      │
│  kernel/    ← scheduler, queue, settings, logger, UI shell │
└────────────────────────────────────────────────────────────┘
```

The kernel knows nothing about TSO. The core library knows TSO but expresses no opinion about *what* to automate. Modules express opinions and rely on the kernel + core to do the work.

## Single global namespace

Everything attaches to `Steward`:

```
Steward
├── kernel
│   ├── log, warn, error
│   ├── settings        ← read(module), write(module, obj)
│   ├── files           ← file API: writableDir, readText, writeText, list, remove, browse
│   ├── register({...}) ← module registration
│   ├── scheduler       ← internal — tick loop, cursors
│   ├── queue           ← internal — FIFO action queue
│   └── ui              ← in-game menu shell
├── core
│   ├── zone
│   ├── buildings
│   ├── specialists
│   ├── deposits
│   ├── packets
│   ├── locale
│   ├── events
│   ├── adventures      ← adventure definitions (read-only)
│   ├── army            ← troop pool, squads, supply plan (read-only)
│   ├── battles         ← battle-file loader and validator
│   └── buffs           ← buff stock and definitions (read-only)
├── modules
│   ├── adventures      ← run templates and dry run (sends nothing)
│   └── <id>            ← exposed only if the module chooses to publish state
└── (shared enums)
    ├── Priority
    ├── Building
    ├── SpecialistType
    ├── SpecialistStatus
    ├── SkillModifier
    ├── ExplorerTask
    ├── GeologistTask
    ├── TroopClass
    ├── BattleLine
    ├── BattleProblem
    ├── SpeedBuffChoice
    ├── FileError
    ├── FileLocation
    └── LogLevel
```

## Module pattern

Every source file is an IIFE that takes the namespace and attaches to it:

```js
(function (S) {
    S.core.zone = {
        isHome: function () { /* ... */ }
    };
})(Steward);
```

This works because:

- The bundle is a single concatenated script — there are no modules to import.
- Adobe AIR has no module system anyway.
- The IIFE keeps each file's locals scoped, while the assignment makes the public surface explicit.

## Bundle order

The build script (`scripts/build.js`) concatenates files in this order:

1. `src/kernel/<NN>_*.js` — sorted by filename. The numeric prefix is the load-order knob.
2. `src/core/**/*.js` — sorted by filename within each directory.
3. `src/modules/**/*.js` — sorted by directory then filename.
4. `src/vendor/**/*.js` — optional, last.

The numeric prefixes inside `src/kernel/` matter: `00_namespace.js` runs before `40_registry.js` runs before `70_lifecycle.js`. Once the kernel is fully attached, core files can rely on `Steward.kernel.*` being there. By the time module files are concatenated, both kernel and core are available.

`05_reload.js` runs right after the namespace. When the host reloads userscripts into the same page and global, the new bundle finds the previous instance there and shuts it down before any later kernel file replaces its `Steward.kernel.*` slots. Every later kernel file must therefore come after it.

`17_files.js` follows the same rule and sits before `20_logger.js`, because the logger resolves its own log file through the file API.

## Lifecycle

```
boot
  ├─ kernel attaches to global Steward
  ├─ kernel.settings.load()
  ├─ core attaches helpers to Steward.core.*
  ├─ each module's IIFE runs and calls Steward.kernel.register({...})
  ├─ ui shell renders the in-game "Steward" menu entry
  └─ scheduler.start()           ← begins the tick loop

tick (every <tickInterval> ms)
  ├─ build ctx (zone, time, session flags)
  ├─ for each priority tier (Critical → Normal → Idle)
  │   ├─ advance the per-tier round-robin cursor
  │   └─ for each module in tier order
  │       ├─ if isReady(ctx): plan(ctx) enqueues work
  │       └─ else skip
  ├─ drain queue (FIFO with per-task delay)
  └─ schedule next tick

shutdown (script reload: the next bundle calls it on the previous instance)
  ├─ scheduler.stop()
  ├─ queue.reset()
  ├─ ui.dispose()            ← stops the 5 s status interval
  └─ flush settings and log
```

The native menu writes a label only when its text changes. Label writes on native items are observed to grow the AIR client's object count, so an unchanged label is skipped on each tick.

The tick interval defaults to **10 seconds** (configurable via `Steward.kernel.settings.read('scheduler').tickInterval`).

## Module contract

```js
Steward.kernel.register({
    id:       'collect',
    priority: Steward.Priority.Normal,
    isReady:  function (ctx) { /* return boolean */ },
    plan:     function (ctx) { /* enqueue 0..N tasks */ }
});
```

| Field      | Required | Notes                                                         |
|------------|----------|---------------------------------------------------------------|
| `id`       | yes      | Unique. Used as logger category and settings namespace.       |
| `priority` | yes      | One of `Steward.Priority.{Critical,Normal,Idle}`.             |
| `isReady`  | yes      | Cheap predicate. Called every tick. Errors → treated as `false`. |
| `plan`     | yes      | Called when `isReady` is true. Errors → swallowed and logged. |
| `boot`     | no       | Optional one-shot called once after registration completes.   |
| `settings` | no       | Default settings object; merged on first run only.            |

See [`MODULE_GUIDE.md`](MODULE_GUIDE.md) for a worked example.

## Why this shape

- **Kernel/core/module split** keeps each file's purpose obvious. Search/list operations live in core; "what to do with a search result" lives in modules.
- **Single namespace + IIFE** maps cleanly to the runtime — no bundler magic required, the build is plain `cat`.
- **Cooperative scheduler** prevents one heavy module from monopolising tick time. See [`SCHEDULER.md`](SCHEDULER.md) for the round-robin cursor mechanics.
- **Shared enums** at `Steward.<Name>` mean modules never typo a string. The literal values are prefixed (`'StatusIdle'`, not `'IDLE'`) so they're self-explanatory if they ever appear in logs or settings JSON.

## What sits on top later (not v0.1)

- A diagnostics module exposing kernel/scheduler/core state through the in-game menu.
- A template-system family of modules (explorer/geologist/army loadouts) sharing a config UI surface.
- An auto-update mechanism (out-of-band; deferred indefinitely).
