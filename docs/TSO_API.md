# TSO Client API

The host TSO client exposes a number of globals to userscripts. This document is a working reference for the surface Steward depends on. It is _descriptive_ — the client is the source of truth and these names may shift between client builds.

## Globals

| Global       | Source                                | What it is                                          |
|--------------|---------------------------------------|-----------------------------------------------------|
| `air`        | Adobe AIR runtime                     | File system, events, native windows.                |
| `game`       | TSO client                            | Main game controller (`gi`, `quests`, `auto`, …).  |
| `swmmo`      | TSO client                            | ActionScript bridge / app entrypoint.               |
| `loca`       | TSO client                            | Localization.                                       |
| `assets`     | TSO client                            | Bitmap / icon registry.                             |
| `globalFlash`| TSO client                            | Bridge to Flash UI (`gui.mMailWindow`, `gui.mQuestBook`). |
| `$`          | jQuery (loaded by client)             | Used for DOM and iteration helpers.                |
| `debug`      | TSO client                            | Original logging hook used by tso_client itself.    |

Steward modules **must not rely on globals introduced by other userscripts** (e.g. autoTSO's `aSettings`). Use only the host client globals listed above.

## Adobe AIR — file system

```js
air.File.applicationDirectory                       // client install dir (writes need the round trip below)
air.File.applicationStorageDirectory                // per-user app storage (AppData), writable
air.File.documentsDirectory                         // user docs
air.File.userDirectory
```

Steward keeps its files under `<client install>/steward/` (for example `steward/logs/console.log`). Every path goes through `Steward.kernel.files`, which tries these locations in order:

1. `applicationDirectory`, reached by the round trip: `air.File.applicationDirectory.resolvePath(rel).nativePath`, then `new air.File(thatPath)`.
2. `applicationStorageDirectory`, when the install folder refuses the directory.
3. `documentsDirectory`, as the last resort.

`Steward.kernel.files.writableDir(rel)` returns `{ dir, where }`, with `where` set to a `Steward.FileLocation` value (`Steward.FileLocation.Application`, `.Storage` or `.Documents`), or `null` when none works. `stewardDir(sub)` is the same under `steward/`. Modules do not build `air.File` or `air.FileStream` objects themselves; they use the file API:

| Call | Purpose |
|------|---------|
| `readText(path)` | `{ ok, text }`, or `{ ok: false, error, message }` with an `S.FileError` code. Strips a leading UTF-8 byte order mark. |
| `writeText(path, text)` | Writes `<path>.tmp`, then moves it over the target, so a failed write leaves the old file in place. |
| `list(dir, suffix)` | Files in `dir` whose name ends with `suffix`, sorted by name. `x.json.tmp` never matches `.json`. |
| `remove(path)` | Deletes a file; `true` when it was removed. |
| `info(path)` | `exists`, `isDirectory`, `size`, `modified`, `name`, `parent`, `nativePath`. |
| `browse(opts, onPick)` | Native open dialog with `air.FileFilter`; `air.FileListEvent.SELECT_MULTIPLE` when `multiple` is set. `opts.filters` is a list of `{ label, pattern }` (default: one "All files" filter); battle files pass `Steward.core.battles.BROWSE_FILTERS`. `onPick(paths)` runs on selection, nothing on cancel. |

`air.File.createDirectory()` does not create parents, so the file API walks the path and creates each missing folder in turn.

### Reading and writing

```js
var dir = Steward.kernel.files.stewardDir('adventures/templates');   // { dir, where } or null
if (dir) {
    var path = dir.dir.resolvePath('t1.json').nativePath;
    Steward.kernel.files.writeText(path, JSON.stringify(data, null, 2));
    var back = Steward.kernel.files.readText(path);
    if (back.ok) data = JSON.parse(back.text);
}
```

### Important: writability

A File obtained from `applicationDirectory.resolvePath(...)` is marked as read-only application content: writing to it, or creating a directory through it, throws `SecurityError: fileWriteResource`. Constructing a new `air.File` from its `nativePath` clears the mark. `Steward.kernel.files.appFile` does that round trip, the same one autoTSO uses (see [LOGGING.md](LOGGING.md#why-not-alongside-autotso)), and the fallbacks above cover a client that refuses it anyway.

## `game`

The main game controller. Lots of it; only the parts Steward uses are listed here.

### Identity / current state

```js
game.gi                                  // game interface
game.gi.mCurrentPlayer                   // player object for the currently viewed zone
game.gi.mCurrentPlayerZone               // zone object for the currently viewed zone
game.gi.mHomePlayer                      // home player
game.gi.mCurrentViewedZoneID             // zone ID
game.gi.isOnHomzone()                    // true on home island
game.zone                                // shorthand for current zone
game.player                              // shorthand for current player
```

### Navigation

```js
game.gi.visitZone(zoneId);
game.zone.ScrollToGrid(grid);
game.gi.SelectBuilding(building);
```

### Server actions

```js
game.gi.SendServerAction(actionId, p1, p2, p3, data);
game.gi.mClientMessages.SendMessagetoServer(messageId, zoneId, payload, responder);
```

Host calls behind the core write actions (each is wrapped by `Steward.core.packets` or the owning core, so modules do not call them):

| Call | Used by |
|------|---------|
| `SendMessagetoServer(1031, dRaiseArmyVO)` with `armyHolderSpecialistVO` and one `dResourceVO` per unit | `army.raise` (the general must stand on a map grid: `GetGarrison()` is null at the star and the server refuses the raise) |
| `SendMessagetoServer(1037, null)` for the currently viewed zone — the client's own Update menu entry (`menuZoneRefreshHandler` in the client's `scripts/0-common.js`); the server answers with a fresh zone state. The message alone: the handler's UI refresh is not steward's to trigger | `adventures.resolve` (the stuck-step resync before the zone trip) |
| `cMilitaryUtil.SendRaiseArmyToServer(game.gi, spec, null)` | `army.unload` |
| `SendMessagetoServer(91, dTimedProductionVO)`, one per stack shape; queue 0 is the barracks, 8 the elite barracks | `production.order` |
| `quest.SetQuestMode(1)`, then `SendMessagetoServer(100, dServerAction, responder)` with `type = 1`, `data = quest.GetUniqueId()` and `responder = game.createResponder(onResult, onFault)` (`ServerState::ResponderSimple`). The claim is verified by the server's result callback for the current send, or by the quest leaving the zone's pool (a claimed quest stays in the pool for a while). A fault, a stale callback or `isFinished` turning false is never a success | `quests.claim` |
| `quest.SetQuestMode(3)`, then `SendMessagetoServer(100, dServerAction, responder)` with `type = 0` (`SERVER_STACK_QUEST_BUTTON_OK`) and `data = quest.GetUniqueId()`. This is what the client's `QuestOkButtonPressedFromGui` sends when the player opens a quest in mode 2 ("New Quest", unread). The read is verified by the server's result callback for the current send, or by new quests entering the zone's pool. Mode 3 alone is never proof | `quests.read` |
| `AdventureManager.removeAdventure(zoneId)` | `adventures.close` |
| `game.getResources().GetResourceAmount(name)` and `.GetFree()` | `resources.amount`, `resources.freePopulation` |
| `unitBase.GetCosts_vector()` | `production.costs` |
| `SendServerAction(95, code, grid, 0, dStartSpecialistTaskVO)` after `mCurrentCursor.mCurrentSpecialist = general`; codes 4 move, 5 attack, 7 travel to zone, 12 to star menu (not yet confirmed in steward logs); code 6 is not an order: the client sets it while a general recovers after a lost battle (seen in steward logs), steward only reads it | `specialists.orders.move`, `.attack`, `.star` (via `sendTask`) |
| `game.zone.mStreetDataMap.mLandingFields_vector[i].GetGrid()` (not yet confirmed in steward logs; the vector also lists other players' fields, `lf.mId` differs, so steward's callers leave the choice to the placeable test) | `zone.landingGrids` (returns an array of grid numbers, empty when unreadable) |
| `ServiceManager.getInstance().specialist.sendToZone(general, zoneId)`, home to an adventure and back home from one (the client's battle window uses the same call for Return home) | `specialists.orders.sendToZone` |
| `game.player.GetHomeZoneId()`, else `game.gi.mCurrentPlayer.GetHomeZoneId()` | `zone.homeId` (returns a number or null) |
| `mMouseCursor.CheckIfGarrisonIsPlacableInGame(grid, true)` in cursor edit mode 86; `mPathFinder.CalculatePath` | `orders.placeCode` (the raw code), `orders.isPlaceable` (code 0 is placeable), `orders.hasPath` (prechecks). On an adventure a general with no garrison (at the star) is placeable only on a free landing field of the player's own landing zone; a general with a garrison goes through the normal rules. |
| `general.GetTask().GetOriginalType()` (4, 5, 6 recovering, 7, 12), `.GetNewGarrisonGridIdx()` | `orders.rawTaskType`, `.taskKind`, `.newGrid` (verification) |
| `general.GetTask().GetRemainingTime()` (unit assumed to be ms, not yet confirmed in steward logs; the raw value is logged) | `specialists.orders.remaining` (returns a number or null) |

### Class lookup

```js
game.def(className)                                  // resolve an ActionScript class
game.def('Communication.VO::dIntegerVO', true)       // create a new instance
swmmo.getDefinitionByName(className)
```

### Utilities

```js
game.chatMessage(text, channel);
game.showAlert(text);
game.getTracker(name, callback);                     // observe a property
game.quests.getQuest(name);
game.quests.GetQuestPool().GetQuest_vector();
game.gi.mClientMessages.GetClientTime?.();
swmmo.application.mGameInterface.GetClientTime();
```

## Zones and buildings

```js
var zone = game.gi.mCurrentPlayerZone;
zone.mStreetDataMap.GetBuildings_vector();                   // all buildings on this zone
zone.mStreetDataMap.getBuildingsByName_vector('ProvisionHouse');
zone.mStreetDataMap.getBuildingByName('FlyingHouse');
zone.GetBuildingFromGridPosition(grid);
zone.UpgradeBuildingOnGridPosition(grid);
zone.SendDestructBuildingCommand(building, source);

// Specialists
zone.GetSpecialists_vector();

// Deposits
// mDepositContainer is a NotifyingIndexedContainer in the AIR client. It does not
// index or enumerate, so do not walk it. Read deposits per type instead.
zone.mStreetDataMap.getDeposits_vectorByType('IronOre');
// The AIR bridge can throw a transient "[undefined] is not a function" from this
// call. Wrap it and retry once before treating the count as unknown.
// Specialist entries are real cSpecialist objects, but in observed logs several
// members can read undefined on the JS side at once. Only GetType has been seen
// still working, and nothing ties these episodes to a list read. Treat a missing
// member as unknown, not absent. The episodes recurred about every 120 s in the
// logs; the cause (host garbage collection) is not established.
```

### Building accessors

```js
b.GetBuildingName_string();
b.GetGrid();
b.GetUpgradeLevel();
b.GetGOContainer();           // .mIsAttackable, .mIsLeaderCamp, .ui ('enemy'|'friend'|...)
b.getPlayerID();              // -1 = neutral/enemy, 0 = home
b.GetArmy();                  // null or army; .HasUnits()
b.mIsSelectable;              // true while the object can still be clicked
b.IsUpgradeAllowed(true);
b.productionQueue;            // .mTimedProductions_vector, .mProductionType
```

### Quest accessors

```js
q.IsQuestActive();
q.IsActive();                 // the client's gate for the read: a quest not active is never read
q.mQuestMode;                 // 0 failed, 1 claim pending, 2 waits for "New Quest" (unread),
                              // 3 running, 4-12 reward and housekeeping
q.GetQuestDefinition().questTriggers_vector[k];   // .triggerIdx, .type, .condition, .name_string
// type 1 with condition 9 = click on a named map object
q.mQuestTriggersFinished_vector[triggerIdx].status; // 0 = open
```

`cQuestBook.Show()` sends the read for the preselected quest when it is in mode 2 (through
`DisplayQuest` and `QuestOkButtonPressedFromGui`). `Hide()` sends nothing.

### Specialist accessors

```js
s.getName(false);
s.GetType();                  // 0 general/carrier, 1 explorer, 2 geologist
s.GetTask();                  // .GetSubType(), .GetType()
s.getPlayerID();
```

## Localization (`loca`)

```js
loca.GetText(category, key);
```

Common categories:

| Category | Meaning              |
|----------|----------------------|
| `LAB`    | Labels / UI text     |
| `BUI`    | Building names       |
| `RES`    | Resource names       |
| `MEL`    | Mail messages        |
| `ALT`    | Alerts               |
| `QUL`    | Quest titles         |
| `ADN`    | Adventure names      |
| `SHG`    | Shop / guild text    |
| `ACL`    | Action labels        |
| `SHI`    | Shop items           |
| `QTG`    | Quest tags           |
| `HIL`    | Help / info labels   |

`Steward.core.locale` wraps these and adds shorthands (`.bui()`, `.res()`, `.lab()`, `.adn()`, `.qul()`).

## UI helpers (provided by host client)

```js
createModalWindow(id, title, removeOnHide);
$('#myModal').modal({ backdrop: 'static' });
$('#myModal').modal('hide');

new Modal(id, title, removeOnHide);
modal.create(); modal.show(); modal.hide();
modal.Body(); modal.Title(); modal.Footer(); modal.Data();

prompt(text, default);   // string, or null on cancel; blocks the JS thread while open
confirm(text);           // boolean; blocks the JS thread while open

createTableRow([[4, 'Col1'], [4, 'Col2'], [4, 'Col3']], false);
createSwitch('id', true, function () { /* on change */ });

getImageTag('Coin', '24px');
assets.GetResourceIcon('Coin');
```

## Star menu and adventures

The star menu stock is `game.gi.mCurrentPlayer.getAvailableBuffs_vector()`. Each entry has `GetType()`, `GetResourceName_string()` and `amount`. Adventure maps have type `Adventure` and the adventure name as resource.

The player's open adventures come from the AdventureManager:

```js
var mgr = game.def('com.bluebyte.tso.adventure.logic::AdventureManager').getInstance();
var advs = mgr.getAdventures();   // AS3 vector; adv.adventureName
mgr.isMyAdventure(adv);           // true for the player's own
```

Steward code reads it through `Steward.core.adventures.manager()`, which returns the instance or null and stays silent.

## Time

```js
swmmo.application.mGameInterface.GetClientTime();   // game time base, not epoch
new window.runtime.Date(timestamp);                 // game's Date constructor
```

`GetClientTime()` is the same time base as a buff appliance's `GetStartTime()` and
`mBuildingCreationTime`. It is not epoch milliseconds, so only differences between two
values from this base are meaningful.

## Building production buffs

Read from the client bytecode of one client build; re-check after a client update.

```js
b.GetResourceOutputFactor();   // pumpkins etc. delivered per cycle, buffs included
b.GetExactOutputFactor();      // upgrade-level base only (Number), no buffs
b.mBuffs_vector;               // BuffAppliance list of the building
b.productionBuff;              // single appliance, used by host scripts
```

- `GetResourceOutputFactor()` is `ceil(base + base*(timed/100 - 1) + base*(zone - 1))`.
  `base` is the upgrade bonus percent / 100 truncated to an integer, `timed` multiplies
  `percent/100 * buffMultiplier` over every timed or zone appliance, `zone` sums the zone
  buffs. Delivery multiplies the definition's `amountRemoved` by this factor; the deposit
  consumption is not changed by an output buff.
- `buffMultiplier` is a game-wide server effect that scales productivity buffs on
  workyards. It can start or end independently of a buff, so never hard-code it: read
  the factor from the host.
- Appliance members: `GetBuffDefinition()` (`getProductivityOutputPercent()`,
  `getDuration(mode)`), `GetStartTime()`, `GetApplicanceMode()` (host spelling).
- Remaining time, as the in-game label computes it:
  `getDuration(GetApplicanceMode()) - (GetClientTime() - GetStartTime())`, milliseconds.

## Where to look in autoTSO for working examples

| Concern                | autoTSO file              |
|------------------------|---------------------------|
| File I/O               | `user_auto.js` `aUtils.file.*` |
| Settings persistence   | `user_auto.js:1046` `aSettings` |
| Server packets         | `user_auto.js` `aUtils.game.*`, `aQueue.actions.*` |
| Building search        | `user_auto.js:5021` `aBuildings` |
| Specialist dispatch    | `user_auto.js` `aSpecialists`, `aUtils.game.sendSpecialistPacket` |
| Modal UI               | `user_auto.js:1971` `aUI` |
| Logger                 | `user_auto.js:358` `aDebug` + `aConsoleLogger` |
