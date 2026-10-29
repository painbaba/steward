# Adobe AIR 32 JavaScript Compatibility

Steward runs as a userscript inside the TSO client, which is built on **Adobe AIR 32.0.0.116**. The JavaScript engine in that AIR version is roughly ES5 with a few ES6 additions. **Modern syntax that's standard everywhere else (arrow functions, `let`, template literals, `Promise`) does not work and will crash the entire game client.**

This document is the canonical compatibility reference. The ESLint configuration in `.eslintrc.json` enforces these rules; violations fail CI.

## TL;DR

- Use `var`. Top-level `const` is fine.
- Use traditional `function () { ... }` expressions. No arrow functions.
- Use string concatenation (`'a' + b`). No template literals.
- Use `.indexOf(x) > -1`. No `.includes()`, no `.startsWith()`, no `.endsWith()`.
- Use `for (var i = 0; ...)` or `$.each(arr, fn)`. No `for...of`. `.forEach()` works on real arrays but is unreliable on game-provided vectors.
- Use callbacks/responders. No `Promise`/`async`/`await`.
- Use plain objects as key maps. No `Set`/`Map`.
- Use `Steward.kernel.log(...)`. There is no `console` object unless you go through `air.Introspector.Console`.

## Supported

### Variable declarations
- `var` — fully supported.
- `const` — supported at the top level of a file or function. Avoid inside conditional blocks.

### Functions
- `function name() {}` declarations.
- `function () {}` expressions.
- Closures, callbacks.
- `arguments` object.
- `Function.prototype.apply`, `Function.prototype.call`, `Function.prototype.bind`.

### Strings
- `.indexOf()`, `.lastIndexOf()`
- `.substring()`, `.substr()`, `.slice()`
- `.split()`, `.toLowerCase()`, `.toUpperCase()`
- `.replace()` (string and RegExp)
- `.charAt()`, `.charCodeAt()`
- `.trim()` (ES5)
- String concatenation with `+`.

### Arrays
- `[]` literals, `new Array(...)`.
- `.length`, `[i]` index access.
- `.push()`, `.pop()`, `.shift()`, `.unshift()`.
- `.splice()`, `.slice()`.
- `.concat()`, `.join()`.
- `.sort()`, `.reverse()`.
- `.indexOf()`, `.lastIndexOf()`.
- `.forEach()`, `.map()`, `.filter()`, `.reduce()` — work on real arrays. **Game-provided vectors do not always behave like arrays — prefer `$.each` or numeric `for` loops when iterating game data.**

### Objects
- `{ key: value }` literals.
- `obj.prop` and `obj['prop']` access.
- `new`, `instanceof`, `typeof`.
- `Object.keys(obj)`.
- `Object.prototype.hasOwnProperty`.

### Control flow
- `if/else`, `switch/case`.
- `for`, `while`, `do/while`.
- `try/catch/finally`.
- `break`, `continue`, `return`.

### Other
- Regular expressions, including all ES5 flags.
- `JSON.parse()`, `JSON.stringify()`.
- Ternary operator `? :`.
- jQuery (`$`) is loaded by the host client.
- `air.*` (file system, events, native windows) — see `docs/TSO_API.md`.
- `game`, `swmmo`, `loca`, `assets` globals — see `docs/TSO_API.md`.
- The host client provides UI helpers: `createModalWindow`, `createTableRow`, `createSwitch`, `getImageTag`, `Modal`, `MenuItem`.

## Not supported

Using any of the following will either parse-fail or throw at runtime, and in many cases takes the entire game client down with it.

### Variable declarations
- `let` — **parse error**.
- Block-scoped declarations.

### Modern syntax
- Arrow functions `() => {}` — `not a function` at runtime.
- Template literals `` `hello ${name}` ``.
- Destructuring `var { x } = obj` and `var [a, b] = arr`.
- Spread `...arr` and rest `function f(...args)`.
- `class` declarations and expressions.
- `for...of`.

### String / array methods
- `String.prototype.includes`, `.startsWith`, `.endsWith`, `.padStart`, `.padEnd`, `.repeat`.
- `Array.prototype.includes`, `.find`, `.findIndex`, `.flat`, `.flatMap`.
- `Array.from`, `Array.of`.

### Async
- `Promise`.
- `async`/`await`.
- Generators (`function*`, `yield`).

### Collection types
- `Set`, `Map`, `WeakSet`, `WeakMap`.
- `Symbol`.

### Modules
- `import`, `export`.

### Other
- `console.*` — there is no global `console`. Use `Steward.kernel.log(...)` (which falls back to `air.Introspector.Console` and the in-game console when present).
- `Object.assign` — unreliable; use explicit copies.
- `Object.values`, `Object.entries` — not supported; iterate `Object.keys` and look up.
- Computed property names `{ [key]: value }`.
- ES3 reserved words (e.g. `typeof`, `default`, `delete`, `class`, `new`) as unquoted object keys or dot-properties — the whole file then fails to parse silently (the script never runs and no error is logged). A quoted key in an object literal (`{ 'default': 1 }`) is safe, because the build keeps object keys quoted. A bracket read with a literal reserved word (`x['default']`) is not: the build's minifier rewrites it to `x.default`. So never read or write a property by name with a reserved word; pick another name (`isDefault`, `shortBefore`). `tests/kernel/air-reserved.test.js` fails on a literal reserved subscript in `src/`.

## Steward source patterns

Every Steward source file is a self-attaching IIFE on the global `Steward` namespace:

```js
(function (S) {
    S.core.zone = {
        isHome: function () {
            try {
                return game.gi.isOnHomzone();
            } catch (e) {
                Steward.kernel.log('zone', 'isHome failed: ' + e);
                return false;
            }
        }
    };
})(Steward);
```

- `var` only inside functions; `const` only at the top of a file or as enum tables.
- Concatenate strings with `+`.
- Iterate game vectors with `$.each` or `for (var i = 0; i < vec.length; i++)`.
- Wrap any call into game APIs in `try/catch` — failures must never propagate up to the kernel tick.
- Never reference modern globals (`Map`, `Set`, `Promise`, `Reflect`, `Proxy`).

## Substitution cheat sheet

| Modern (don't use)                 | AIR-compatible (use this)                                          |
|------------------------------------|--------------------------------------------------------------------|
| `let x = 1;`                       | `var x = 1;`                                                       |
| `const f = x => x + 1;`            | `var f = function (x) { return x + 1; };`                          |
| `` `hello ${name}` ``              | `'hello ' + name`                                                  |
| `arr.includes(x)`                  | `arr.indexOf(x) > -1`                                              |
| `s.startsWith('foo')`              | `s.indexOf('foo') === 0`                                           |
| `arr.find(fn)`                     | `arr.filter(fn)[0]` (or a `for` loop)                              |
| `for (const item of arr) {}`       | `for (var i = 0; i < arr.length; i++) { var item = arr[i]; }`      |
| `const { a, b } = obj;`            | `var a = obj.a, b = obj.b;`                                        |
| `[...arr1, ...arr2]`               | `arr1.concat(arr2)`                                                |
| `new Set(arr)`                     | `var seen = {}; for (...) { seen[arr[i]] = true; }`                |
| `new Promise(...)`                 | Pass a callback / responder.                                       |
| `console.log(x)`                   | `Steward.kernel.log('category', x)`                                |

## Detecting violations

```bash
npm run lint     # AIR ruleset over src/
```

`npm run lint` runs ESLint's JS entry through the current node, so it works on Windows. The ruleset also bans ES3 reserved words as unquoted keys and dot-properties (see "Other" under Not supported).

The pre-commit hook runs the same lint over staged files. Push without lint passing and CI will fail before any artifact is produced.

### Why ESLint and not Biome

ESLint is the **authoritative** source-of-truth for AIR-compatibility checks because its `no-restricted-syntax` rule lets us ban specific AST node types (`ArrowFunctionExpression`, `TemplateLiteral`, `RestElement`, `Set`/`Map`/`Promise` constructors, etc.). The full list is in `.eslintrc.json`.

Biome's defaults *recommend the opposite* — `useArrowFunction`, `useTemplate`, `useConst`, `noVar`, `noArguments` would all rewrite AIR-compatible code into AIR-crashing code. The repository ships a `biome.jsonc` that disables every Biome rule that conflicts with the AIR-32 ruleset, so the VS Code Biome extension stops emitting contradictory warnings. **Do not enable those rules** — each one points the wrong way for this runtime.

Biome's formatter is also disabled for source files; the IIFE / kernel-prefix conventions are formatted by hand to match `docs/ARCHITECTURE.md`.

## Why does any of this matter?

The Adobe AIR 32 runtime is from 2019 and is no longer updated. It does not get the JavaScript engine improvements that modern browsers received. Worse, its failure mode for unsupported syntax is not a thrown `SyntaxError` — the engine often fails to parse a whole file, taking the surrounding userscript ecosystem down with it. **One stray `let` can crash the client on launch.** Stick to the patterns above and let ESLint catch what you miss.
