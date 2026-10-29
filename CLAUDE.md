# steward

Modular automation framework for The Settlers Online: a scheduling kernel, a
core TSO library and pluggable modules, shipped as one userscript bundle for the
prebuilt **Adobe AIR 32** TSO client. Plain JavaScript, with no TypeScript and no
transpiler.

## Commands

- `npm ci` first in a fresh clone (`node_modules/` is not committed).
- `npm run build` produces `build/user_steward.js`, the only artefact, in the
  only build directory.
- `npm test` runs the zero-dependency runner over `tests/<area>/*.test.js`.
- `npm run lint` runs ESLint with the AIR ruleset (`scripts/lint-air.js`).
  `npm run lint:fix` fixes what it can.
- The husky pre-commit hook lints staged `src/**/*.js`, and CI runs lint, build
  and test, so keep all three green.

## Hard rule: `src/` is ES5-era, AIR-safe JavaScript

`'use strict'`, `var`, `function` expressions. **Never** use arrow functions,
`let`/`const`, template literals, ES modules, `Promise`, `Set`/`Map`,
`.includes()`/`.startsWith()`/`.find()`, destructuring or spread. Details:
[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md). `scripts/` and `tests/` are
CommonJS Node. Follow each file's existing style.

Never create a second source of truth. Derive from the existing list, enum
(`src/kernel/15_enums.js`), constant or function.

## Running it

There is no host build. Copy `build/user_steward.js` into the TSO client's
`userscripts/` directory (`C:\Users\Roland\AppData\Local\tso_portable\`) and
reload scripts from the client menu. Runtime output goes to
`tso_portable/steward/` (`logs/console.log`, `dumps/`).

## Where to read

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): kernel / core / module layers, lifecycle, bundle order.
- [docs/MODULE_GUIDE.md](docs/MODULE_GUIDE.md): authoring a module.
- [docs/CORE_USAGE.md](docs/CORE_USAGE.md): rules for calling `Steward.core.*`.
- [docs/SCHEDULER.md](docs/SCHEDULER.md): priority tiers, tick and queue contract.
- [docs/analysis/HOST_INTEGRATION.md](docs/analysis/HOST_INTEGRATION.md): how the AIR client loads userscripts and which globals it provides.
- [docs/TSO_API.md](docs/TSO_API.md), [docs/LOGGING.md](docs/LOGGING.md).

## Workflow

Every change to source, build or docs goes through the **so-pipeline** skill
(`.claude/skills/so-pipeline/`) automatically: it dispatches the `so-*` agents
and keeps a ledger under the git-excluded `analysis/`. Answer read-only questions
and git housekeeping directly, without the pipeline.

Agents never `git add`, commit or push; the user commits. Commit messages are
short, topic-prefixed (`mining: ...`) and end with `Assisted-by: Claude`.

Versioning: `package.json` `version` is the only hand-kept version (the build
injects it into the bundle banner and the dashboard Build row). Every shipped
task bumps it exactly once, as part of that task's change: a new module or a
massive redesign bumps minor, a bugfix or smaller feature bumps patch. Use
`npm version <x.y.z> --no-git-tag-version` so `package-lock.json` follows.

Line limits on agent-facing markdown (this file at most 200 lines, agents 100,
SKILL.md 160, handoff/todo notes 70) are enforced by a local hook; see
`.claude/pipeline/RULES.md` when present.
