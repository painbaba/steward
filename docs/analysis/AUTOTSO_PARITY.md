# autoTSO ↔ Steward Feature Parity

> Status: snapshot at Steward v0.5.1.
> Source: `autoTSO/user_auto.js` (8174 lines, single file).
>
> Purpose: catalogue every autoTSO subsystem so we don't ship Steward
> v1.0 without realising we left out a daily-use feature. This is a
> living document — update with each Steward release.

## Dashboard scope (current)

Steward's dashboard mirrors autoTSO's tab structure with one omission and
one addition:

- **Status** — Steward-only. Surfaces master pause, modules running, queue
  depth, tick interval, and live events. autoTSO has no equivalent.
- **Specialists / Quests / Buildings / Tools / Misc** — mirror autoTSO,
  Steward modules slot in.
- **Mail/Trades** — *deferred*. The tab is intentionally absent until the
  Mail and Trade modules ship. Modules can't register against `'mail'`
  today (registry rejects unknown tabs). Re-add the tab to
  `TAB_ORDER` in `90_ui_shell.js` and the `TABS` set in `40_registry.js`
  when the first Mail/Trades module lands.

## Reading the table

- **Status**:
  - `✓` — implemented in Steward and verified live
  - `~` — partially implemented (foundations there, surface incomplete)
  - `✗` — not yet started
  - `n/a` — autoTSO has it but we deliberately won't (security risk, replaced by host integration, etc.)
- **Tier**: rough priority for the v0.5–v1.0 roadmap.
  - **must** — daily-use feature most autoTSO users actually run
  - **should** — common, but not blocking
  - **nice** — power-user / rare workflows
  - **drop** — explicitly de-scoped

## Top-level toggles (autoTSO `aSession.isOn.*`)

These are the master on/off switches autoTSO surfaces in the menu (`aUI.menu.featureLabel` / `toggleFeature`).

| autoTSO flag | Subsystem | Steward equivalent | Status | Tier |
|---|---|---|---|---|
| `Adventure` | aAdventure (auto-run an adventure) | — | ✗ | must |
| `Explorers` | aSpecialists.manageExplorers (treasure searches) | `modules/explorers` | ✓ | must |
| `Quests` | aQuests.manage (auto-complete daily/letter/event quests) | — | ✗ | must |
| `Deposits` | aBuildings.deposits.manage (geologists + mine build/upgrade) | partially in `core/deposits` (read), no module yet | ~ | must |
| `Buildings` | aBuildings.manage (auto-toggle production) | — | ✗ | must |
| `Mail` | aMail.manage (loot mail + pending trades + invites) | — | ✗ | must |
| `OpenMysteryBoxs` | aBuffs.openLootables (open inventory mystery boxes) | — | ✗ | should |
| `FromStarToStore` | aResources.transferFromStarToStore (move buffed resources to warehouse) | — | ✗ | should |
| `CollectPickups` | aBuildings.collectibles.manage | `modules/collect` | ✓ | must |

## Subsystems

### aQueue — Action Queue
| Surface | autoTSO | Steward | Status |
|---|---|---|---|
| FIFO queue | `aQueue.queue` | `Steward.kernel.queue` | ✓ |
| Per-action delay | yes | yes | ✓ |
| Pause / restart | manual | `Steward.kernel.ui.pause/resume` | ✓ |
| Retry on stuck operation | watchdog | not yet | ~ |
| Modal-aware gating | no | yes (`runOne` defers when `div[role="dialog"]:visible`) | ✓ Steward improvement |
| Per-module cancel | no | `cancelByModule(id)` | ✓ Steward improvement |
| Module busy contract | no (modules manage themselves) | yes (`isModuleBusy` skips plan) | ✓ Steward improvement |

### aSettings — Settings Store
| autoTSO | Steward | Status |
|---|---|---|
| Single JSON file under `auto/settings.json` | Delegates to host's `settings` global at `'steward.<id>'` | ✓ |
| Deep `extend` merge with defaults | shallow merge per-module | ~ |
| Per-config nickname (`--clientconfig`) | per-profile via host's `settingsFile` | ✓ via host |
| Migration helpers | none (bumped settings shape between releases — manual edit so far) | ~ |

### aDebug + aConsoleLogger — Logging
| autoTSO | Steward | Status |
|---|---|---|
| Category filter (adventure/combat/geologists/explorers) | `Steward.kernel.log.isEnabled(category)` plus per-category map | ✓ |
| File rotation | `applicationDirectory/auto/logs/console.log.{N}` | `<client>/steward/logs/console.log.{N}` | ✓ |
| DEBUG-level gating | implicit (single level) | explicit `Steward.kernel.debug` with `debugEnabled` master | ✓ Steward improvement |
| Console + file dual sink | yes | yes | ✓ |

### aUI — In-game UI
| autoTSO | Steward | Status | Notes |
|---|---|---|---|
| Top-level "Automation" menu | "Steward" menu | ✓ | grouped/flat layout aware |
| Modal-based settings dialogs | uses host `Modal` class | ✗ — Steward only has native menu items today | must — UI overhaul next |
| Feature label "Start/Stop X Auto" | per-feature toggle | ~ — toggle exists, label scheme not enforced | |
| Status bar (top of menu) | yes | yes | ✓ |
| Adventure monitor modal | extensive | ✗ | depends on adventure module |
| Settings modal (giant tabbed) | ~500 lines | ✗ | UI overhaul scope |
| Excelsior modal (resource finder) | yes | ✗ | nice |
| Trade dialogs (with friends, saved trades) | yes | ✗ | depends on trade module |
| Lootables / mystery box dialog | yes | ✗ | depends on aBuffs port |

### aEvents — Event Awareness
| autoTSO | Steward | Status |
|---|---|---|
| Hard-coded treasure values for 6 events | mirrored in `core/events/data.js` | ✓ |
| `getActiveEvent(type)` (substring match against host event names) | `core/events.active()` + `liveEventNames()` | ✓ |
| `isEventWithDepos()` | `core/events/refill.js` `depositEvent()`: the live event whose `depositInfo` (in `core/events/data.js`) names workyard buildings | ✓ |
| `calculateDailyItems` (per-explorer skill-aware items/hour estimate) | `core/specialists.estimateEventItems()`: best task per explorer, summed, shown in the Events tab. Loot-count traits are not modelled, as in autoTSO | ✓ |
| `calculateDeposits` (Valentine flowers / HW pumpkins for the rest of event) | `core/events/refill.js` `rows()` / `compute()`: one row per placed field, shown in the Events tab by the `eventcalc` module with its deposit, production per 12 h and production until the shop closes (buffed value in parentheses while a production buff is active), and the refill with the current deposit subtracted | ✓ |

### aBuffs — Buffs System
| autoTSO | Steward | Status |
|---|---|---|
| List buffs / lootables / building buffs | — | ✗ |
| `getBuffAmount(name)` | — | ✗ |
| `getBuffTargets(name, amount)` | — | ✗ |
| `applyBuff(type, grid, amount, responder)` (server packet 61) | — | ✗ |
| `openLootables` (mystery boxes) | — | ✗ |
| `getProduceableBuffs`, `getDefinition`, `fullName` | — | ✗ |
| `lootables()` (filter `Loottable_*` buffs) | — | ✗ |
| `applyOnFriend(buff, amount, friendId)` | — | ✗ |

**Steward gap**: needs a full `core/buffs.js` plus a buffs-aware module. Many other subsystems (Quests, Adventure, Buildings) depend on buff application.

### aResources — Resource Management
| autoTSO | Steward | Status |
|---|---|---|
| `getResourcesInfo` (list player resources, filter event-only) | — | ✗ |
| `runProduction(resource, total)` (start production runs) | — | ✗ |
| `productionBuildings(resource)` | partial via `core/buildings` predicates | ~ |
| `getResourceFormStar` (transfer from star menu) | — | ✗ |
| `transferFromStarToStore` | — | ✗ |
| `gather.byTrade(friendId)` (inter-player trade gathering) | — | ✗ |
| `Has(name, amount)` | — | ✗ |
| `remainingCapacity(name)` | — | ✗ |

### aSpecialists — Specialists
| autoTSO | Steward | Status |
|---|---|---|
| `getSpecialists(type)` | `core.specialists.byType` | ✓ |
| `manageExplorers` (auto-dispatch) | `modules/explorers` | ✓ |
| `sendGeologists(geos, count, depoIndex, depoName)` | `core.specialists.send` (low-level only) | ~ |
| Templates (per-explorer task) | `explorers.overrides` | ✓ |
| Templates UI (dropdown per spec) | — | ✗ — only menu toggle exists |
| Event optimisation (skill-aware items/hour) | partial — uses default-hours, doesn't read skills yet | ~ |
| `pickTask` precedence (per-spec → event → host default → baseline) | yes | ✓ |
| Carrier/Admiral classification | `SpecialistType.{Carrier,Admiral,AdmiralCarrier}` | ✓ Steward improvement |

### aBuildings — Production / Mines / Collectibles
| autoTSO | Steward | Status |
|---|---|---|
| Buildings list / search / by-grid / by-name | `core.buildings.*` | ✓ |
| Production toggle (`SetProductionActiveCommand` / `SendServerAction(107)`) | — | ✗ — daily-use, blocks v0.5 |
| `aBuildings.production.{order, info, inProgress, affordable}` | — | ✗ |
| `manage()` periodic auto-production | — | ✗ |
| `collectibles.{check, collect, lootables, buildings, manage}` | `modules/collect` (refined: pure-collectible focus, event-aware patterns) | ✓ |
| `deposits.{removeDepleted, manage}` (geo dispatch + mine build/upgrade) | — | ✗ |
| `production.getBook` (Bookbinder / skill book special handling) | — | ✗ |
| Buff application during production | — depends on aBuffs | ✗ |

### aMail — Mail Automation
| autoTSO | Steward | Status |
|---|---|---|
| `getHeaders` | — | ✗ |
| `handleHeaders` | — | ✗ |
| `acceptLootMails` | — | ✗ |
| Pending trade tracking (`aSession.mail.pendingTrades`) | — | ✗ |
| Pending invite tracking | — | ✗ |
| `getMailBody`, `setMonitor`, `manage` periodic check | — | ✗ |
| Trade-log saved trades modal | — | ✗ |

### aTrade — Trade Automation
| autoTSO | Steward | Status |
|---|---|---|
| `send(tradeSpec)` | — | ✗ |
| `complete(tradeId)` | — | ✗ |
| Trade office (incoming) | — | ✗ |
| Outbox check / response (`SendMessagetoServer 1176`) | — | ✗ |
| Friends list integration (`aUtils.friends.getRandom`) | — | ✗ |
| Saved trades / templates UI | — | ✗ |
| Trade-with-friends dialog | — | ✗ |

### aQuests — Quest Automation
| autoTSO | Steward | Status |
|---|---|---|
| Quest list (`getQuests(regex)`) | — | ✗ |
| Letter quests (SharpClaw, StrangeIdols, Annoholics, SilkCat, Miranda, BartTheBarter, Vigilante, SettlersBandits, LostCompass, AThreat) | — | ✗ |
| Mini quests (LittlePanda, MysteriousCoin, WeddingInvitation, ANewStone, SaveTheDeers, WolfPuppy) | — | ✗ |
| Other (Daily, DailyGuild, Weekly, Ghost, PathFinder, Starfall) | — | ✗ |
| Order-execution engine (buffapplied, resourceproduced, soldgoods, …) | — | ✗ |
| `payQuest` (skip with rubies) | — | ✗ |
| `completeQuest` action | — | ✗ |
| `finishAdventureQuests` (auto-claim mid-adventure) | — | ✗ |

**Note**: aQuests is the largest subsystem (~2000 lines) and depends on aBuffs, aResources, aTrade, and aMail. Realistically a v0.7-v1.0 endeavour.

### aAdventure — Adventures
| autoTSO | Steward | Status |
|---|---|---|
| Adventure templates (per-step plan) | `modules/adventures` run templates (one JSON file per template, dialog, dry run) | ~ |
| Speed buff selection | per template, starts at the first in stock by name; read-only (`core/buffs`) | ~ |
| Import autoTSO run templates (`auto/templates/*.json` + `auto/settings.json` labels) | — | ✗ (planned follow-up) |
| Black Vortex toggle | — | ✗ |
| Step-by-step execution | — | ✗ |
| Camp elimination tracking | — | ✗ |
| Unit training / retraining | — | ✗ |
| Lost-army recovery | — | ✗ |
| Adventure monitor UI | — | ✗ |
| `completeQuest` mid-adventure | — | ✗ |
| `auto.start` / repeat counter | menu start with run count and End repetition; request stored only, no executor | ~ |
| Template menu with map counts | `~Steward~ > Adventures` lists templates with star-menu map counts | ✓ |
| Extra template actions (todo) | — | ✗ (home loadout load, start adventure with Black Vortex option, send generals, visit adventure with auto-claim of quests, wait for departure, star generals, use speed buff, produce adventure items (skippable), apply adventure items, waves with kill-all, collect pickups, return home, load generals to end, module-wide retrain of lost units) |

**Note**: `aAdventure` is autoTSO's flagship feature (~1700 lines). Touches every other subsystem. v0.8+ scope.

### aUtils — Utilities
| autoTSO | Steward | Status |
|---|---|---|
| `aUtils.file.{Read, Write, Path, validatePath}` | `S.kernel.files` (read, safe write, list, delete, browse) | ✓ |
| `aUtils.format.num` | not yet | ~ |
| `aUtils.friends.getRandom` | — | ✗ |
| `aUtils.game.{restart, sendSpecialistPacket, uID, …}` | partially in `core/packets`, `core/specialists.dispatch` | ~ |
| `aUtils.create.{Select, SettingsImg, …}` (UI builders) | — | ✗ |
| `aUtils.responders.{buffOnFriend, openBox, checkOutbox, checkInbox, sendOfficeTrades}` | — | ✗ |

### Auto-update / Distribution
| autoTSO | Steward | Status |
|---|---|---|
| In-game "check for update" via GitHub Releases API | — | ✗ |
| Background auto-check on boot | — | ✗ |
| Backup before applying update | — | ✗ |
| Restore from backup | — | ✗ |
| Changelog modal | — | ✗ |
| **Plus security caveats**: autoTSO's update is base64-encoded URL with no signature verification | n/a | n/a |

**Steward decision**: defer auto-update. Manual install via GitHub Releases tag/asset workflow is good enough for v1.0.

### Native process execution / restart
| autoTSO | Steward | Status |
|---|---|---|
| `aUtils.game.restart()` (spawn `tso-portable.exe`, exit) | — | ✗ — security review needed |
| RAM-based auto-restart (`Auto.RestartRAM`) | — | nice (autoTSO uses to dodge memory leaks) |

## Notable improvements Steward already has over autoTSO

| Improvement | Where |
|---|---|
| Modal-aware queue (collect doesn't yank user windows) | `60_queue.js:isHostModalVisible` |
| Module busy contract (no plan-ing while previous cycle drains) | `50_scheduler.js` |
| Per-module queue cancellation | `60_queue.js:cancelByModule` |
| Master pause toggle persisted across restart | `90_ui_shell.js` |
| DEBUG-level logging gating (off by default) | `20_logger.js` |
| Carrier/Admiral classification (autoTSO collapses to "general") | `core/specialists.classify` |
| Auto-derived event collectible patterns (no per-event maintenance) | `modules/collect/module.js:effectivePatterns` |
| Diagnostics module (read-only inspector for debugging) | `modules/diagnostics/*` |
| Single-bundle delivery with deterministic load order | `scripts/build.js` |
| AIR-32 ESLint enforcement at lint-staged + CI | `.eslintrc.json` |
| GPLv3 + open source (autoTSO is "private project — All rights reserved") | `LICENSE` |

## Tier-grouped roadmap implication

If we want Steward at "daily-use parity" with autoTSO, this is the rough sequence:

**v0.5 — daily-use foundations**
- `core/buffs.js` (consumed by everything below)
- `core/resources.js` (production helpers, transfer-from-star)
- `modules/auto_buildings` (production toggle — small, no SelectBuilding)
- `modules/auto_mystery_boxes` (uses buffs.openLootables)
- `modules/auto_transfer_to_store`

**v0.6 — geologists + mail**
- `modules/templates_geologists` (depends on `core/buffs` for mine buffs)
- `modules/auto_mail` (loot mail + invite acceptance)
- `core/army.js` (preparation for adventures)

**v0.7 — quests**
- `modules/auto_quests` (letter, mini, daily/weekly)

**v0.8 — adventures**
- `modules/auto_adventures` (the big one)
- Adventure templates UI

**v0.9 — trade / friends / Excelsior / Pathfinder integration**

**v1.0 — UI overhaul, polish, auto-update mechanism**

## Explicit non-goals

- **Auto-update via in-game download** — manual GitHub Releases install is fine.
- **Native process restart** — security risk; users can restart their client themselves.
- **Pathfinder integration** — autoTSO requires a separate userscript; defer.
- **Per-feature start/stop labels** — Steward's pause toggle covers the common case.
