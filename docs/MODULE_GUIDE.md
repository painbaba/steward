# Authoring a Steward Module

A module is a small piece of automation that the kernel runs on its tick. This guide walks through writing one from scratch.

## File layout

Every module lives under `src/modules/<id>/`. By convention:

```
src/modules/<id>/
├── module.js     # The IIFE that calls Steward.kernel.register({...})
├── settings.js   # Default settings schema
└── ui.js         # Settings panel (optional)
```

You can split into more files if the module grows; the build picks them up alphabetically per directory. Just make sure `module.js` is concatenated last so its `register` call sees the rest of the module's helpers.

## The minimum viable module

```js
// src/modules/hello/module.js
(function (S) {
    S.kernel.register({
        id:       'hello',
        priority: S.Priority.Idle,
        isReady:  function () { return true; },
        plan:     function (ctx) {
            S.kernel.log('hello', 'tick', ctx.tick, 'now', ctx.now);
        }
    });
})(Steward);
```

That's a complete module. After `npm run build` it'll be bundled into `user_steward.js` and the kernel will call its `plan` once per tick.

## Anatomy of a real module: `collect`

```js
// src/modules/collect/settings.js
(function (S) {
    S.modules.collect = S.modules.collect || {};
    S.modules.collect.defaultSettings = {
        enabled:   true,
        pickups:   true,
        lootBoxes: true
    };
})(Steward);
```

```js
// src/modules/collect/module.js
(function (S) {
    var state = {
        lastRun:       0,
        cooldownUntil: 0
    };

    function settings() {
        var stored = S.kernel.settings.read('collect');
        return stored || S.modules.collect.defaultSettings;
    }

    S.kernel.register({
        id:       'collect',
        priority: S.Priority.Normal,
        boot:     function () {
            // Seed defaults if this is the first run
            if (!S.kernel.settings.read('collect')) {
                S.kernel.settings.write('collect', S.modules.collect.defaultSettings);
            }
        },
        isReady:  function (ctx) {
            var s = settings();
            if (!s.enabled) return false;
            if (!ctx.zone.isHome) return false;
            if (ctx.now < state.cooldownUntil) return false;
            return true;
        },
        plan:     function (ctx) {
            var s = settings();
            var enqueued = 0;

            if (s.pickups) {
                var pickups = S.core.buildings.list({ /* predicate from core */ });
                for (var i = 0; i < pickups.length; i++) {
                    S.kernel.queue.add('collect', [S.core.buildings.grid(pickups[i])]);
                    enqueued++;
                }
            }

            if (s.lootBoxes) {
                // similar
            }

            S.kernel.log('collect', 'queued', enqueued, 'actions');
            state.lastRun = ctx.now;
            state.cooldownUntil = ctx.now + 30000;
        }
    });
})(Steward);
```

## The `register` spec

| Field      | Required | Type      | Notes                                                            |
|------------|----------|-----------|------------------------------------------------------------------|
| `id`       | yes      | string    | Unique. Used as logger category, settings namespace, UI label.   |
| `priority` | yes      | enum      | `Steward.Priority.{Critical,Normal,Idle}`.                       |
| `isReady`  | yes      | `(ctx)→bool` | Cheap. Errors are treated as `false`.                         |
| `plan`     | yes      | `(ctx)→void` | Called when `isReady` returns true. Errors are swallowed and logged. |
| `boot`     | no       | `()→void` | One-shot, called after registration completes.                   |
| `ui`       | no       | object    | Dashboard section: `{ tab, section: { id, title, icon, render } }`. See [UI](#ui). |
| `menu`     | no       | object    | Native `~Steward~` submenu: `{ title, items }`; `items` is an array or a function returning one. See [UI](#ui). |

See [`SCHEDULER.md`](SCHEDULER.md) for the contract details.

## Settings

Modules own their settings schema. Read and write through the kernel, namespaced by module id:

```js
var s = Steward.kernel.settings.read('collect');     // returns object or null
Steward.kernel.settings.write('collect', { enabled: true, pickups: false });
```

The kernel persists settings to a single JSON file on disk. Don't write outside your module's namespace.

### Defaulting

Two patterns are common:

**Lazy:** `read()` returns `null` until first write; the module substitutes a default each call.

```js
function settings() {
    return Steward.kernel.settings.read('collect') || Steward.modules.collect.defaultSettings;
}
```

**Eager:** seed defaults in the `boot` hook so subsequent reads always return populated data.

```js
boot: function () {
    if (!Steward.kernel.settings.read('collect')) {
        Steward.kernel.settings.write('collect', Steward.modules.collect.defaultSettings);
    }
}
```

Eager is friendlier for debugging — you can inspect `settings.json` and see what every module expects. Prefer it.

`write` deep-merges into the stored object, so a key or array entry that was stored once is not removed by a later `write` that leaves it out. Records a module creates and deletes (for example adventure run templates, one JSON file per record) do not belong in settings. Keep them in files under `Steward.kernel.files.stewardDir('<module>/<folder>')`, which returns `{ dir, where }` or `null`, and write each one with `Steward.kernel.files.writeText`.

## Enqueueing actions

`plan` should not perform side effects directly. It should enqueue actions:

```js
Steward.kernel.queue.add('collect', [grid]);
```

Actions are registered separately:

```js
Steward.kernel.queue.action('collect', function (params) {
    var grid = params[0];
    // perform the actual game-API call
});
```

The kernel paces action execution; one `plan` call can enqueue dozens, the queue drains FIFO.

### Cancelling on disable

When your module exposes an "off" switch, drop pending queued actions immediately so users don't see your work continue for tens of seconds after they disable you:

```js
S.kernel.queue.cancelByModule('your-module-id');
```

Actions enqueued from inside your `plan()` or `boot()` are automatically tagged with your module's id — you don't pass it explicitly. See `SCHEDULER.md` for the full contract.

### Plan is transactional — write it that way

`plan()` runs once per cycle. Once it returns, the kernel will **not** call it again until every action it enqueued has completed (or been cancelled). Implications:

- **Don't worry about re-entry.** You can safely scan game state and enqueue everything you found; the busy contract guarantees no second invocation racing with the first.
- **Long-running game operations** that aren't fully represented in the queue (an adventure mid-flight, a production order placed) need additional gating in `isReady`. Return `false` while the operation is in progress; return `true` when it completes or is cancelled.
- **Don't enqueue a "watcher" that re-enqueues itself forever.** The natural cycle is: scan → enqueue → drain → become idle → next tick re-evaluates `isReady`. If you need periodic checks during a long operation, that's `isReady`'s job, not the queue's.

See `SCHEDULER.md` "Module busy contract" for the full mechanism.

## Logging

```js
Steward.kernel.log('collect', 'queued', n, 'pickups');
Steward.kernel.warn('collect', 'unexpected building shape:', JSON.stringify(b));
Steward.kernel.error('collect', 'failed to read game state:', e);
```

Use your module's `id` as the category. Don't log inside hot loops.

## UI

A module shows things in the native menu and the dashboard through two optional fields of its register spec.

- `ui` adds a section to one dashboard tab. `tab` is one of `specialists`, `geologists`, `quests`, `buildings`, `events`, `tools` or `misc`. `section.id` is unique and also the settings buffer key. `render($body, h)` runs when the dashboard draws the tab; `h` is `S.kernel.ui.helpers` (`headerRow`, `gridRow`, `formRow`, `input`, `dropdown`, `toggle`, `button`, `settings`, `update`, ...).
- `menu` adds a submenu to the native `~Steward~` menu. Use it for read-only tools, such as opening a tab or showing an alert.

```js
// src/modules/eventcalc/module.js (trimmed)
S.kernel.register({
    id: 'eventcalc',
    // priority, isReady, plan and boot as above
    ui: {
        tab: 'events',
        section: {
            id:    'eventcalc',
            title: 'Event calculator',
            icon:  '⚑',
            render: function ($body, h) {
                // ui.js loads after module.js, so look the renderer up at call time
                return S.modules.eventcalc.renderSection($body, h);
            }
        }
    },
    menu: {
        title: 'Events',
        items: [
            { label: 'Event calculator…', onSelect: function () {
                S.kernel.ui.openDashboard('events');
            } }
        ]
    }
});
```

Menu items come in three shapes: an action `{ label, onSelect }`, a separator `{ separator: true }` and a display-only line `{ label, enabled: false }` (no `onSelect`). Actionable items are always enabled, because the menu is not rebuilt on a timer and an enabled flag would go stale; an item that depends on game state reports that itself when selected, as the event calculator's estimate alert does.

`label` may be a function `label(pass)` returning the text. The kernel re-evaluates label functions on the 5 s status tick and writes only text that changed, in place. `pass` is one plain object shared by all label functions of the module within a single pass, so an expensive read can be cached on it (`pass.maps = ...`) instead of repeated per item.

`items` may be a function. It is evaluated when the module's submenu is built (at init and on `S.kernel.ui.refreshModuleMenu(id)`), never at registration. When the set of items changes (for example a user saved a template), call `S.kernel.ui.refreshModuleMenu(id)` from the user action that caused it; it rebuilds only that module's submenu. Never call it on a timer: every rebuild leaks native objects in the AIR client. `S.kernel.ui.notify(text)` shows a game alert. The adventures module (`src/modules/adventures/menu.js`) is the example.

Dashboard settings go through a buffer: `h.settings(id)` returns it, `h.update(id, patch)` merges changes into it, and the dashboard Save button writes them to the module's settings. Keep state that describes the current moment out of the buffer; a session-only value is cleared when the menu entry reopens the dashboard.

A module can also own a dialog of its own, opened from its `menu` items, when a dashboard tab does not fit (the adventures module's template dialog is the example). Such a module registers only a `menu`, so it gets no dashboard section and no quick toggle. Its dialog uses its own `Modal` id, calls `S.kernel.ui.ensureStyle(id)` before it is first shown so it shares the dashboard stylesheet, and passes every user string through `h.escape` before it reaches the page. Opening a modal hides the dashboard. A zone load closes host modals and drops unsaved edits.

UI primitives are host-provided; see [`TSO_API.md`](TSO_API.md).

## Error handling

The kernel guards both `isReady` and `plan` with try/catch. If your code throws:

- `isReady` throw → treated as `false`. Logged at WARN.
- `plan` throw → swallowed. Logged at ERROR. Module is unaffected on next tick.

Don't rely on this as your only error handling — wrap risky game-API calls in try/catch yourself so you can decide what to do (skip, defer, disable). Failing silently to the kernel makes diagnosis harder.

## Module lifecycle

```
build:   src/modules/<id>/*.js → bundled into user_steward.js
load:    client loads bundle → IIFE runs → register() called
boot:    kernel runs your boot() hook (if provided)
tick N:  isReady(ctx) → plan(ctx) → kernel drains queue
…
```

There is no module unload. When the host reloads scripts, the new bundle shuts down the previous instance's scheduler, queue and status interval, and the old module closures are orphaned. Do not start timers of your own (`setInterval`, `setTimeout` loops): they are not stopped on reload and would keep running beside the new instance. Plan work through `plan(ctx)` so the kernel owns the timing. If you need to disable a module at runtime, gate everything behind `settings.enabled` in `isReady`.

One exception exists: a diagnostic chain that is bounded, read-only and stops itself on reload. It captures `S.kernel.lifecycle` when it starts; each tick returns without work or re-arming once `S.kernel.lifecycle` is a different object, because every bundle load assigns a new one. The diagnostics generals sampler (`src/modules/diagnostics/army.js`) is the example. Anything that acts on the game still plans through `plan(ctx)`.

## Naming and discoverability

- Module `id` is lowercase, no spaces, dash-separated if multi-word: `'collect'`, `'auto-mail'`, `'templates-explorers'`.
- Reserve `Steward.modules.<id>` for any state your module wants to publish (helpers, render functions, public read-only data).
- Internal state goes in IIFE-scoped `var`s, not on the namespace.

## Where to look for examples

- `src/modules/collect/` (v0.1) — the canonical reference module once it lands in P3.
- autoTSO's `aBuildings.collectibles` (`autoTSO/user_auto.js:5021`) — proven game-side logic to mirror.

## Testing

Steward has a small custom test runner at `tests/runner.js`. Tests load source files into a fresh `vm` context per test, with stubbed host globals — pure logic and planner decisions can be exercised without an AIR client.

```bash
npm test                                    # all tests
node tests/runner.js tests/core/foo.test.js # single file
```

Test API is flat: `var t = require('../runner'); t.test(name, fn);` plus `t.assert` (Node's built-in `assert.strict`). No describe/it nesting, no global `expect`.

The harness gives each test a fresh Steward, capturable kernel logs and queue, and an in-memory settings store:

```js
var t = require('../runner');
var harness = require('../harness');

t.test('plan enqueues nothing when disabled', function () {
    var H = harness.boot();
    H.settings.write('mymodule', { enabled: false });
    H.module('mymodule').plan({ zone: { isHome: true } });
    t.assert.strictEqual(H.queued().length, 0);
});
```

Stubs live under `tests/stubs/`:

- `host.js` — `game`, `loca`, `air`, `$`, `settings`, `globalFlash`. Defaults are no-ops or null sentinels so an accidental host call surfaces as a loud failure rather than a silent zero.
- `zone.js` — fluent fake-zone builder: `zone().deposits('IronOre', [...]).building({...}).specialists([...]).buildQueue(used, max).mountOnPlayer(player)`.
- `specialists.js` — factories for `geologist({...})`, `explorer({...})`, `task(typeId, subTypeId)`.
- `kernel.js` — wraps `kernel.log/queue.add/settings.read/write` after source load with capturing versions; the harness wires this for you.

Canonical example: `tests/modules/geologists.test.js`. It builds a zone with a single idle geologist, writes settings, calls `plan()`, asserts the resulting `queue.add` payload — end-to-end planner test in ~25 lines.

What the runner does **not** cover: `SendServerAction` payloads (host-side state), UI rendering against the dashboard DOM, anything depending on AIR-only globals like `air.File`. Those stay validated by the live-host smoke test in each module's plan.

When adding a module, write planner tests alongside the implementation. Lint already ignores `tests/` so test files use modern JS freely; only `src/` is held to the AIR-32 ES5 subset.
