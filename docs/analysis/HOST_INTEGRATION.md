# Host TSO Client Integration

> **Status:** review of what `tso_client/client/files/content/scripts/` already
> provides, and what Steward v0.1 missed. The fixes themselves are tracked in
> `P5_PLAN.md`.

## What runs before us

The TSO client preloads 21 scripts from `client/files/content/scripts/` (~6800
lines) **before** any userscript. They populate the global namespace with
infrastructure every userscript is expected to honour. Anything Steward does
sits on top of these.

```
client/files/content/scripts/
├── 0-common.js       (994 lines)   ← settings, Modal, Utils, TimedQueue
├── 0-keybinds.js     (166 lines)
├── 0-lang-*.js                     ← three language tables
├── 0-manager.js      (261 lines)   ← userscript install/enable manager
├── 4-itemshide.js
├── 4-spec*.js                      ← specialist UIs
├── 4-specialists.js  (421 lines)
├── 5-army.js, 5-battle.js, 5-settings.js
├── 6-buffs.js, 6-timed.js
├── 7-building.js     (154 lines)   ← production toggle UI
├── 7-notify.js
├── 8-auction.js, 8-help.js
├── 8-shortcuts.js    (1046 lines)
└── 99-menu.js        (242 lines)   ← native menu shell
```

Numeric prefix drives load order. `0-common.js` is foundational; `99-menu.js`
runs last and triggers `reloadScripts(null)` which loads userscripts.

## Globals defined by the host

| Global | Defined in | Purpose |
|---|---|---|
| `settings` | `0-common.js:942` | Per-profile JSON settings instance. `settings.store(data, module)` / `settings.read(key, module)`. Backed by `air.File.applicationDirectory.resolvePath(settingsFile)`. |
| `settingsFile` | `index.html` (per-profile) | Filename for the settings JSON. Default `'settings.json'`; per-game-account profiles override (e.g. `'rknall.json'`). |
| `mainSettings` | `0-common.js:7-51` | ~50 client-wide preferences. Loaded into globals at `0-common.js:944` via `$.extend(mainSettings, settings.read())`. |
| `Modal` | `0-common.js:564` | Standard modal-dialog class. **Hides other visible modals on show.** Used by every host UI. |
| `Utils` / `utils` | `0-common.js:489` / `941` | DOM/image helpers. |
| `TimedQueue` | `0-common.js:432` | Already-built paced action queue. |
| `getText(id, module)` | `0-common.js:99` | Userscript-extensible translation lookup. `extendBaseLang(data, module)` adds entries. |
| `createModalWindow`, `createSwitch`, `createTableRow`, `getImageTag` | `0-common.js:410-420` | Backward-compat wrappers around `Modal` / `Utils`. |
| `enabledScripts` | `0-common.js:2` | Map keyed by userscript filename. The host `0-manager.js` lets users toggle scripts on/off; userscripts not in the map (or `=== true`) load on `reloadScripts`. |
| `menu` (instance of `Menu`) | `99-menu.js:225` | Native-menu shell. `menu.addToolsItem(name, fn, key, ...)` is the documented integration point for userscripts. |
| `dropbox` | `0-common.js:989` | Cloud-sync of the entire `settings.settings` object. Steward modules under host settings get sync for free. |

## Highlights of `mainSettings`

Selected fields relevant to Steward:

| Field | Default | Used for |
|---|---|---|
| `menuStyle` | `'grouped'` | Drives `99-menu.js` between grouped (sub-menus) vs flat layout. |
| `experimental` | `false` | Gates host-experimental features. Userscripts should respect. |
| `explDefTask`, `explDefTaskByType` | `0`, `{}` | Default explorer tasks. Per-type overrides keyed by explorer name. |
| `geoDefTask`, `geoDefTaskByType` | `0`, `{}` | Same for geologists. |
| `specDefTimeType` | `false` | Display-time mode. |
| `highlight*` | various | Building-highlight visual config. |
| `lruCacheSize`, `lruDisableDuplicates` | `3`, `false` | Recently-used templates cache. |
| `customShortcuts` | `{}` | User-defined keyboard shortcuts. |
| `infoBarResources` | `[Tool, Coin, Plank, RealPlank, Stone, Marble]` | Top info-bar resource slots. |

Userscripts read these to *cooperate* with the host's defaults (e.g.
`pickTask` should prefer `mainSettings.explDefTaskByType[name]` before falling
back to its own logic).

## How the host's settings system works

```js
settings.store(data, module);       // merge `data` into settings.settings[module]
var v = settings.read(key, module); // returns settings.settings[module][key]
var all = settings.read(null, module); // returns the whole module object
```

- The backing file path is `air.File.applicationDirectory.resolvePath(settingsFile).nativePath`.
- `settingsFile` defaults to `'settings.json'` but is overridden per-profile in `index.html` so users running multiple game accounts get separate settings files.
- All settings live in **one JSON file**, namespaced by module.
- `dropbox.upload()` (line 833) ships `JSON.stringify(settings.settings)` — modules under host settings sync automatically.

autoTSO uses this as a fallback (`autoTSO/user_auto.js:1282`):

```js
if (!data) {
    data = readSettings(null, 'auto');
}
```

## How userscripts integrate with the menu

The host menu (`99-menu.js:225`) is built via `air.ui.Menu.createFromJSON(...)`. It exposes:

```js
menu.addToolsItem(name, fn, key, ctrl, shiftKey, altKey);
menu.clearTools();
```

`addToolsItem` appends to the **Tools** submenu (defined in `99-menu.js:121`). The keybind machinery in `Menu.prototype.checkKeybind` is a single global keymap — userscripts compete for keys via `addKeybBind`.

There's no native concept of a top-level "this userscript's menu". Userscripts that want one create a Modal instead and attach a Tools item that opens the modal.

## How userscripts get enabled/disabled

`0-manager.js` provides a UI (`scriptsManagerWindow()`) that:
- Lists every `userscripts/*.js` file plus everything in `info.json` (host-curated catalog).
- Renders an "Enabled" checkbox per script.
- Persists the result via `settings.store(enabledScripts, "scripts")`.
- Calls `reloadScripts(null)` which only re-injects scripts whose `enabledScripts[name]` is truthy or `undefined`.

So **the host already provides per-userscript enable/disable**. Steward doesn't need to build its own; it just needs to be aware that the host can disable it without warning.

`reloadScripts` re-injects the bundle into the same page and global, so a second copy of Steward starts while the first is still running. The new bundle therefore tears down the previous instance itself (`src/kernel/05_reload.js`): it stops the scheduler, the queue and the status interval before replacing the kernel. Known limitation: if Steward is disabled in the manager and scripts are reloaded, no new bundle is injected, so the running instance stays alive until the client restarts.

## Implications for Steward

1. **Settings backend.** Steward should delegate to `settings.store/read` instead of writing its own JSON file. Per-module namespace `'steward.<id>'` (e.g. `'steward.collect'`, `'steward.kernel'`). Gains: per-profile separation, dropbox sync, single place to inspect.
2. **Host-defaults consultation.** `pickTask`/`pickDeposits` should read `mainSettings.{expl,geo}Def{Task,TaskByType}` as the first-pass policy and only deviate when the module has a stronger signal (active event, user override).
3. **Menu integration.** A top-level "Steward" entry is non-standard. The host way is to attach an item to the Tools submenu that opens a Modal. We can keep our own root entry for visibility but should also register a Tools item so users can find Steward via the host's normal flow.
4. **Modal awareness.** Steward's queue actions should defer when a host Modal is visible. This is a **Steward improvement** — autoTSO has the same UI-takeover issue (confirmed by the user: when collectibles run, all open user windows close).
5. **Userscript-level enable/disable.** The host's manager can already disable Steward at the file level. We don't need to build that. But a runtime "pause" (without reloading scripts) is still useful for in-session control.
6. **Translation system.** Steward's `core/locale.js` could use `getText()` for our own user-facing strings (and `extendBaseLang(data, 'steward')` for the catalog) instead of hard-coding English. Low priority.

## Confirmed UX issue: collectibles close user windows

User confirmed: in autoTSO, running the collectibles automation closes any
open user window. Both autoTSO and Steward call:

```js
game.gi.SelectBuilding(building);
globalFlash.gui.UpdateGuiOnZoneLoad();
```

`UpdateGuiOnZoneLoad` triggers a full GUI refresh that hides modals as a side
effect. autoTSO's pattern doesn't guard against this. Steward can do better
by gating action execution on "no host Modal currently visible" — see fix #3
in `P5_PLAN.md`.

## File references

- `tso_client/client/files/content/scripts/0-common.js`
- `tso_client/client/files/content/scripts/0-manager.js`
- `tso_client/client/files/content/scripts/7-building.js` — example: pure server-action production toggle (`SendServerAction(107, ...)`) with no SelectBuilding side effect
- `tso_client/client/files/content/scripts/99-menu.js`
- `autoTSO/user_auto.js:1245-1287` — autoTSO's settings load/save (with host fallback)
- `autoTSO/user_auto.js:1468-1479` — autoTSO's per-profile config-nickname handling
