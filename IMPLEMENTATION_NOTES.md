# IMPLEMENTATION_NOTES — focus-todo for OpenCode v2

All statements below come from inspecting this machine's installed packages, the
OpenCode 2.0.27 executable, and runtime experiments — not from blog posts or
older-version examples. Anything that could not be verified is marked
**NOT VERIFIED**.

---

## 1. Environment

| Item | Value | How it was established |
| --- | --- | --- |
| OpenCode version | **2.0.27** | `opencode --version`; `@opencode/cli@2.0.27` in `package.json` |
| Binary | `D:\LF_software_programme\Opencode\npm-global\node_modules\@opencode\cli\bin\opencode.exe` (212 MB) | `opencode` shim resolves here |
| Runtime | **Bun single-file executable** | 6 676 occurrences of `B:/~BUN/root/chunk-*.js` import paths, 34 × `bun:ffi`, `@bun @bytecode` pragma, Bun's own test runner and SQLite internals embedded. `node:sea` appears only 4 times, as a Bun compatibility string. |
| Data / config / state | `%LOCALAPPDATA%`-style paths: data `~/.local/share/opencode`, config `~/.config/opencode`, state `~/.local/state/opencode`, cache `~/.cache/opencode` | `opencode debug paths` |
| Persistence | SQLite at `~/.local/share/opencode/opencode.db` (Drizzle schema, tables `session_v2`, `session_message`, `session_pending`, `session_inbox`, `todo`) | DB strings in binary; files on disk |
| TUI config file | **`cli.json`** (`$schema: https://opencode.ai/v2/cli.json`) | `tui.json` + `kv.json` are **migrated into** `cli.json`; the migration code and a `cli.json.migrated-bak-*` are present |
| Project plugin dir | **`.opencode/plugin/`** (plural `.opencode/plugins/` also referenced) | Discovery logged: `msg="loading plugin" id="...\.opencode\plugin\<file>.ts"` |
| Global plugin dir | **`<config>/opencode/plugin/`** and **`<config>/opencode/plugins/`** — both are scanned | A copy in each was loaded into a clean project on 2026-10-13; see §9.9 |
| Plugin target kinds | a `.ts`/`.js` **file** (server entrypoint only) or a **directory** (server + tui + rpc entrypoints) | Absolute-file targets short-circuit to `{server}`; directory targets get `features.tui` (§6.1) |
| Interface of the moment | TUI + background server; `opencode serve` starts "the v2 API and web server" | `opencode --help`, `opencode serve --help` |

### 1.1 Project plugins must use the v2 shape

A project plugin using the classic `export const X = async (input) => Hooks` form is
**rejected** at load time:

```
message="failed to load plugin"  target="...\.opencode\plugin\probe.ts"
cause="PluginModule.LoadError: Plugin must export a default definition with an id
       and an effect or setup function. (cause: SchemaError(Missing key at ["default"]))"
```

The accepted shape is `export default { id, setup(context) }` (or `{ id, effect }`).
The loader does `("effect" in module ? module : wrap(module)).default`.

### 1.2 Type definitions: published ≠ runtime

`@opencode-ai/plugin@1.18.25` is published and present in the Bun cache, but it does
**not** describe the 2.0.27 runtime:

* `tool.definition`, `chat.params`, `chat.headers`, `tool.execute.before/after`,
  `experimental.chat.system.transform`, `experimental.chat.messages.transform`,
  `experimental.session.compacting` — **0 occurrences** of these strings in the binary.
* `sidebar_content` (underscore) and `soundboard` from `tui.d.ts` — **0 occurrences**.
  The real sidebar slot path is `"sidebar.content"` and its prop is camelCase `sessionID`
  — the runtime shape the panel is built on and verified against (§6, §9.10).

Conclusion: the published package is a useful hint, not a contract. Every API used by
this plugin was confirmed by running it inside 2.0.27.

---

## 2. billion-context mode

| Question | Answer |
| --- | --- |
| How is it loaded? | **Native v2 package plugin**, declared in the global `opencode.json` as `"plugins": ["billion-context"]` |
| Resolved entrypoint | `file:///C:/Users/22985/.cache/opencode/npm/billion-context@latest/<ts>/node_modules/billion-context/dist/agent/opencode-native.js` (package `./server` export) |
| Version | installed **0.1.196** (its own `package.json` depends on `billion-context@0.1.149` — the cache directory holds 0.1.196) |
| `bili plugin install opencode` native plugin | yes — this is the mechanism that is in use |
| `bili opencode` launcher | **not in use** (no launcher shim found) |
| `/bili/` baseURL | **not in use** — no provider in `opencode.json` points at a `/bili/` path |
| legacy `opencode-acp` | **not installed** — no such package; no duplicate/legacy compaction plugin is loaded |
| `compaction.auto` | **already `false`** in the global config (`"compaction": {"auto":false,"buffer":55000}`) — correct for billion-context |
| Transport interception | yes — every outbound request carried `x-bili-plugin`, `x-bili-hop`, `x-bili-tunnel`, `x-bili-plugin-conversation`, `x-bili-plugin-instructions-mutable`, `x-bili-plugin-context-window`, `x-bili-plugin-max-output`, `x-bili-plugin-model`, `x-bili-plugin-agent` |
| Tools it contributes to the wire | `absorb`, `acp_cache`, `acp_status`, `compress`, `decompress`, `search_context` |
| Hooks it uses | `session.hook("context" / "compaction" / "generate")`, `aisdk.hook("sdk")`, plus a legacy bridge for `experimental.chat.system.transform`, `experimental.chat.messages.transform`, `experimental.text.complete` |

Historical note: on 2026-09-25 the log contains `failed to load plugin target=billion-context`
with the very same `PluginModule.LoadError`. It loads cleanly now; the exceptions in the
log are stale, not current.

**No billion-context configuration is abnormal, and nothing about it was modified.**

---

## 3. Existing Todo capability — complete inventory

### 3.1 Native session Todo exists as *state* but has **no writer and no UI**

| Capability | Status | Evidence |
| --- | --- | --- |
| Persistent per-session table | **yes** | `CREATE TABLE \`todo\` (\`session_id\` text NOT NULL, \`content\` text NOT NULL, \`status\` text NOT NULL, \`priority\` text NOT NULL, \`position\` integer NOT NULL, …)` plus `CREATE INDEX \`todo_session_idx\` ON \`todo\` (\`session_id\`)` |
| Read API | **yes** | SDK `session.todo({sessionID})` → `GET /session/{sessionID}/todo` |
| Write API | **no** | `sdk.gen.d.ts` exposes only the GET for `/session/{sessionID}/todo`; no PUT/POST/DELETE variant exists |
| `todo.updated` event | **no** | 0 occurrences of `todo.updated` in the 2.0.27 binary (the published SDK types mention it — the runtime does not implement it) |
| Native `todowrite` / `todoread` **tool** | **no** | runtime `tool.list()` returns `patch, edit, glob, grep, session_rename, session_move, worktree_create, worktree_list, worktree_remove, models, list_mcp_resources, read_mcp_resource, question, read, shell, skill, subagent, webfetch, websearch, write` — no todo tool. The string `todowrite` survives only in two legacy-migration lists (`["todowrite"]` next to `migration.v1-v2`). |
| Built-in sidebar Todo panel | **no** | the only internal sidebar plugins are `opencode.sidebar.context`, `opencode.sidebar.footer`, `opencode.sidebar.mcp`. `internal:sidebar-todo`, `sidebar.todo`, `opencode.sidebar.todo` do not exist. |
| TUI read helper | **present but useless here** | `context.tool`… no; the TUI state exposes `session.todo(sessionID)`, which can only ever return the native table — and nothing can write that table |

**Consequence:** Mode A ("reuse the native Todo") is **not viable**. The native todo
feature in 2.0.27 is state + read API with no producer and no consumer. A plugin cannot
populate it through any supported API, so there is nothing to reuse and no sidebar entry
that would ever show it.

### 3.2 Competing plugins / name collisions

`opencode plugin list` shows two TUI plugins from `cli.json`
(`opencode-subagent-magazine@1.7.4`, `opencode-visual-cache@1.7.5`); `cli.json` also
disables one built-in with `-opencode.sidebar.context`. Both declare a `"./tui"` export in
their own `package.json` and claim the `"sidebar.content"` slot in their bundled code — the
same mechanism this plugin uses locally (§6.1). No `oc-todo`, `opencode-todolist`,
`todo-reminder`, `pi-toolkit` or `goal-x` package is installed. `focus_todo` collides with
nothing: billion-context owns `absorb/acp_cache/acp_status/compress/decompress/search_context`.

---

## 4. Server surface that actually exists in 2.0.27

`export default { id, setup }`; `setup(context)` was dumped at runtime. Real domains:

```
app location options agent aisdk command event experimental generate model provider
integration mcp permission plugin reference rpc skill storage tool vcs websearch
worktree session shell
```

| Domain | Real shape | Verified how |
| --- | --- | --- |
| **`tool`** | `{ reload(), list(), transform(cb), hook(name, cb) }` | dumped keys and arities |
| `tool.transform` | draft `{ list, get, namespace, add, update, remove }`; `add({name, description, input, output, options, execute})` | registered a tool, `tool.list()` went 20 → 21, and it executed |
| `tool.hook` names | `"execute.before"`, `"execute.after"` | found at call sites in the binary |
| **`storage`** | `{ get(key), set(key, value), remove(key), scan({prefix}) → {entries:[{key,value}]} }` | round-tripped a key; `scan({})` → `{entries:[]}` |
| **`session`** | `{ hook, create, get, remove, switchAgent, switchModel, prompt, generate, command, compact, synthetic, interrupt, update, move, wait, context }` | dumped keys |
| `session.hook` names | `"context"`, `"compaction"`, `"generate"` | found at call sites |
| `session.hook("context", cb)` payload | `{ sessionID, model, system[], messages[], options, agent, tools{} }` — fires once per request | captured live |
| `aisdk.hook` names | `"sdk"`, `"language"` | `"sdk"` at call sites; `"language"` in the published types only (see limitation below) |
| `event` | `{ subscribe(cb) }` | dumped keys |
| `permission` / `shell` | `{ hook(...), … }` | dumped keys |

### 4.1 Tool result contract (discovered the hard way)

* `input` accepts **plain JSON Schema** — no `effect/Schema` and no `zod` required.
  (`effect/Schema` is importable inside the plugin because the host bundles it; `zod`,
  `@opencode-ai/plugin` and `@opencode-ai/sdk` are **not** resolvable from a project plugin.)
* Returning a bare string fails: `Error: s is not an Object. (evaluating '"output" in s')`.
* Returning `{ output: … }` without declaring `output` fails:
  `Error: Tool result declared output without an output schema`.
* `execute(input, toolContext)` — the session id is `toolContext.sessionID`.
* The model receives exactly the declared `output`; `content` is not what the model sees.
  Verified: with `output` = `{type:"string"}` the model literally reported the string back.

### 4.2 `options.codemode: false` is mandatory

With `options` omitted, the tool is registered but **never reaches the wire tool list**.
Captured outbound request before the fix: `tools=18`, `focus_todo=no` — the model could
only reach it inside the sandboxed code-mode `tools` object. After adding
`options: { codemode: false }`: `tools=19`, `focus_todo=yes`, and the model began calling
it as a first-class tool (`⚙ focus_todo {"action":"replace", ...}`).

---

## 5. Cache-safe injection: does a request-tail slot exist?

**No usable one. Dynamic injection is disabled.**

What was checked:

1. `session.hook("context")` hands over the request under construction with a live
   reference to `system[]` and `messages[]`. Mutating either edits the request **at the
   prefix**, in front of the whole conversation — exactly the failure mode the brief
   forbids. There is no documented guarantee that a mutation is confined to one outbound
   request and never written back to history.
2. The legacy `experimental.chat.system.transform` — the hook a naive implementation would
   use — **does not exist in 2.0.27** (0 occurrences). `output.system.push(...)` is not
   merely unwise here, it is unavailable.
3. `aisdk.hook("language")` is described by the published types as the point where the
   `LanguageModelV3` can be replaced, i.e. the transport boundary. **NOT VERIFIED** in
   2.0.27: a capture-only wrapper registered on it never fired. This is the one place that
   could in principle append a request-tail block, and it is not proven to work, so it is
   not used.
4. `tool.hook("execute.before"/"execute.after")` sees only a single tool call, never the
   assembled prompt.

The conclusion at the time was Mode C: no automatic injection, recovery via the frozen tool
description plus `focus_todo(action="list")`.

**Revised 2026-10-13.** The requirement became "the model must know the todo content whether
it asks or not, without hurting the cache and without a compaction being able to erase it",
so the hook was probed properly instead of reasoned about. It turns out the request-tail
position *does* exist and is safe: `session.hook("context")` hands over the assembled request
and a message appended to `messages[]` reaches the provider as the last message and is never
persisted. That is Mode C's escape hatch, exercised only at the tail: the plugin now appends
one reminder line there, and nothing is ever added to `system[]`, to history or to the tool
definitions. Full evidence in §9.8.

---

## 6. TUI sidebar: a real panel, verified in a rendered frame

Section 3.1 stands: there is no native Todo panel and no native data to show. But the TUI
plugin path itself **does** exist in 2.0.27 and was reverse-engineered end to end, so a
read-only panel was built and is verified rendering (§9.10). This replaces the earlier "skip
the TUI" conclusion, which was based on the published types alone.

### 6.1 How a local TUI plugin gets loaded

Four facts, all confirmed against the binary and by experiment:

1. Server-side discovery under `<.opencode>/plugin/` accepts every **directory** and every
   file ending in `.ts`/`.js`. A `.tsx` file is therefore never a server plugin — and a
   directory always is.
2. The loader turns a target into entrypoints with `_E({directory})`, probing `server`,
   `tui` and `rpc`. The decisive branch: an **absolute file** target
   (`isAbsolute(target) && isFile()`) short-circuits to `{server: pathToFileURL(target)}`
   with no TUI entrypoint and `features.tui=false`; a **directory or package** target
   resolves all of them and sets `features.tui=true`.
3. TUI reconciliation takes three sources: discovered directories, active server plugins
   (`state.status==="active" && features.tui===true && source.type is package|local`,
   re-targeted to `dirname(source.path)`), and `cli.json` entries. The last two require the
   TUI entrypoint to sit next to the server entrypoint.
4. Local `.tsx` is compiled by the host's own Babel (`babel-preset-solid` with
   `{moduleName, generate:"universal"}` plus `@babel/preset-typescript`), and
   `solid-js`, `@opentui/core`, `@opentui/solid` and `@opencode/plugin/tui` are injected as
   virtual modules. **No npm install, no node_modules, no declared dependency.**

Hence the layout of this plugin: one directory, two entrypoints, one plugin id.

```
.opencode/plugin/focus-todo/server.ts   → resolved as the server entrypoint (the tool)
.opencode/plugin/focus-todo/tui.tsx     → resolved as the TUI entrypoint (the panel)
.opencode/plugin/focus-todo/view.ts     → neither; a plain module `tui.tsx` imports as "./view.ts"
```

`view.ts` is deliberately inside the directory rather than at the project root: an install is
then a copy of one directory, at any location (project-local or global), and the panel's
relative import resolves the same way in all of them. It is also what keeps both halves
testable together — `bun test` imports the panel and this module directly.

**Failed hypothesis, kept here because it is the trap:** putting the panel at
`.opencode/plugin/tui.tsx` next to `.opencode/plugin/focus-todo.ts` never loads. The
directory is what matters, and absolute file targets get no TUI entrypoint at all. Measured:
with the file layout the panel text appeared **0** times in a captured frame; with the
directory layout it appears in the sidebar (§9.10).

### 6.2 The API the panel actually uses

`tui.tsx` exports `{id, setup(context)}` like the server half. Dumped TUI context domains:
`options, location, app, renderer, client, data, attention, theme, themeMode, markdown,
keymap, storage, ui`. The panel uses four of them and nothing else:

| Used | Shape | Note |
| --- | --- | --- |
| `context.ui.slot` | `slot({prepend\|append\|before\|after\|replace, render}) → unregister` | exactly one of the position keys; the host mounts the render result inside an error boundary and also releases the slot on unload. Real slot name: **`"sidebar.content"`** (dotted, not the published `sidebar_content`). Shipped build uses `append`, matching every built-in panel (§9.22). |
| `context.data.session.message.list(sessionID)` | reactive window of the session's messages, newest `initialMessageLimit` (20) by default, with `sync`/`more`/`loading`/`loadMore` | the only viable read path — see 6.3 |
| `context.renderer.terminalWidth` | number | used to clamp the panel width |
| `context.theme.text` | `{base, default, muted, …}` per theme | status colours |

Render input carries the **camelCase `sessionID`** prop, matching the runtime, not the
published `session_id` (which is why §1.2's warning still applies).

### 6.3 Why the panel reads the transcript instead of the store

The two halves do **not** share storage, and this was measured, not assumed:

* Server side: `context.storage` is the SQLite key/value table, keys
  `plugin:<utf16-be-hex(pluginID)>:<key>`.
* TUI side: `context.storage` is a completely different backend —
  `<state>/<channel>/tui/<key>.json` files with a `fs.watch` live-reload, and key segments
  may not contain `/`.

So the TUI cannot read `focus-todo/session/<sessionID>`, and a file-based project plugin
gets neither an event-bus publisher nor an RPC surface. The remaining option is the one
taken: the panel reads the newest `focus_todo` tool result **already in the current
session's message window** (persisted messages, and live parts written by
`session.tool.input.started/called/success/failed` as the tool runs). That is also the
better design here — one source of truth, the same text the model saw, nothing extra
written, and nothing to keep in sync.

### 6.4 What the panel deliberately does not do

No writes, no polling, no timers, no subscriptions, no clicks, no popups, no settings, no
routing, no second list, no space when there is nothing to show. Every read is inside a
`try/catch`, `setup` returns the unregister function for cleanup, and if `ui.slot` or
`data.session.message.list` is missing the panel returns `undefined` and simply does not
exist. It is version-locked to the 2.0.27 internal API: if that API changes, the panel goes
inert while the tool keeps working — the sidebar is never required for the tool to function,
and no compatibility is faked when the API is absent.

---

## 7. Chosen mode

**Mode B (fallback implementation) combined with Mode C (no dynamic injection).**

Reasoning chain:

1. Mode A requires a reusable, writable native Todo. The native Todo cannot be written by
   anything (no tool, no write API, no event). → Mode A is impossible.
2. Mode B is therefore required: one `focus_todo` tool plus a per-session persistence layer.
3. The brief says to prefer official storage over a hand-rolled JSON file when available.
   `context.storage` is official, transactional, key-based and needs no path handling. → the
   fallback store is built on `context.storage`, so no plugin JSON file, no
   temp-file-plus-rename, no path-traversal surface, no resident cache.
4. Mode C applies because no provable request-tail injection point exists (§5). Dynamic
   injection stays off and the frozen tool description carries the behavioural contract.
5. Mode B's optional read-only TUI is included, as `tui.tsx` (§6, verified in §9.10). It
   displays state the tool already produced; it is not a second store and not a second
   source of truth.

### 7.1 Why `storage` satisfies the fallback-store requirements

| Requirement | How it is met |
| --- | --- |
| Per-session isolation | key `focus-todo/session/<sessionID>`; one key per session |
| Session id validation / no traversal | `sessionKey()` rejects empty, >128 chars, `/`, `\`, `..` and anything outside `[A-Za-z0-9_.:-]`; keys are DB keys, never filesystem paths |
| Atomic write | delegated to the host's transactional key/value store |
| Serialized mutations per session | per-session promise chain in `createFocusTodo`; the chain entry is deleted when it settles so nothing accumulates |
| Re-read before mutating | every call reads fresh state inside the lock, applies the pure transition, then writes with `revision + 1` |
| Fail-soft on corruption | unreadable state → structured warning + reset, mutating call still succeeds |
| Fail-soft on a broken store | read failure → `warn=…` and an in-memory empty state; write failure → `error=state store write failed` |
| No big resident cache | read on demand; only in-flight promises are held |
| No chat/prompt/code/billion-context data | the stored value is exactly `{version, revision, completed, nextId, items[]}` |

`revision` and `nextId` are persisted but never shown to the model.

---

## 8. Files

```
src/focus-todo/server.ts                the tool: pure core + storage binding + request-tail reminder + entrypoint
src/focus-todo/tui.tsx                  the read-only sidebar panel (imports only solid-js + its own module,
                                        both provided by the host / on disk — no package dependency)
src/focus-todo/view.ts                  pure view logic: parse tool results, clip to width, build panel rows
tests/focus-todo.test.ts                63 tests: actions, storage, isolation, concurrency, reminder, entrypoint
tests/focus-todo-view.test.ts           28 tests: parsing, warn prefixes, junk, wide chars, panel branches
tests/tui-panel.test.ts                 14 tests: both entrypoints resolve, one slot claimed, cleanup, render
types/bun-test.d.ts                     ambient types for the test runner so `tsc --noEmit` needs no node_modules
types/tui-runtime.d.ts                  ambient solid/JSX types so the panel type-checks under `jsx: preserve`
tsconfig.json                           strict type checking
package.json                            scripts: test / typecheck / verify:provider / verify:analyze / verify:drive
verify/fake-provider.mjs                local OpenAI-compatible fake provider that records outbound requests
verify/analyze.mjs                      cache-prefix and request-tail assertions over the recorded requests
verify/script.json                      scripted responses used to drive the multi-turn capture
verify/wire.jsonl                       baseline capture, before the reminder existed (10 requests / 5 turns)
verify/wire-reminder.jsonl              the reminder capture (9 agent requests, 6 of them carrying a reminder)
verify/cache-report.json                result of verify/analyze.mjs over the reminder capture
verify/cache-report-baseline.json       result over the baseline capture
verify/drive-capture.mjs                connects to a headless TUI and asserts the rendered frame
_evidence/probe/hook-probe.ts           throwaway probe that established the context-hook contract
_evidence/wire/                         the scratch project (fake provider config) the probe ran in
```

`server.ts` has **no imports at all** — not even `node:*` — so it cannot fail to load
because of a missing package, and it stays directly importable by the test runner. `tui.tsx`
imports `solid-js` (injected by the host) and `./view.ts` (on disk, inside the same
directory), so the panel and its parsing can be tested together without a running TUI, and
the directory stays self-contained at any install location.

`view.ts` lives **inside** the plugin directory on purpose: it is imported relatively by
`tui.tsx`, and a module that is only imported is never a plugin. Verified against the log —
every load line for this plugin reads `id="…\\.opencode\\plugin\\focus-todo"`
`entrypoint=file:///…/focus-todo/server.ts`, and neither `tui.tsx` nor `view.ts` ever appears
as a plugin target, so there is exactly one plugin and one tool registration, not two
(§9.3).

This is still a small file count: three source files, which is what the brief's cap allows
for the fallback (`package.json`, `src/{core,server,tui.tsx}`, `test/`, README, NOTES) —
`server.ts` is the server entrypoint, `tui.tsx` the TUI entrypoint, and `view.ts` plays the
role of `src/core`: the pure logic the panel and the tests share.

---

## 9. Verification results

### 9.1 Unit tests — 163 passed / 0 failed

`tests/focus-todo.test.ts` (102) covers session isolation, restart recovery, every action,
overlong/empty text, item cap, unknown/invalid/duplicate ids, several `in_progress`,
path-traversal session ids, corrupt state, a dead store, concurrent mutations on one session
and on many, per-session chain cleanup, setup failure containment, the single-tool surface,
no colliding tool name, that todo activity never alters the tool definition, and the whole
reminder path: the exact one-line format, attention ordering (running first, then blocked,
then list order), the `+k more` remainder, budget clamping (80…2000), per-item clipping,
appending exactly one trailing message in the session's own content shape, nothing at all
when the list is empty or the session is unknown or invalid, every malformed payload shape, a
dead store, the settings switch and budget, the double-registration guard, and the
"newest message already shows this state" guard — including the host's nested tool-result
shape that first exposed it as a no-op (§9.11). Settings are covered as pure functions: file
shape, junk keys, clamps, environment precedence, `userConfigPath` for
`HOME`/`USERPROFILE`/`XDG_CONFIG_HOME`/none, and a missing file resolving to the defaults —
plus, since §9.16, all seven keys: the budget clamp, the nudge interval (including `0`), the
per-item clip, the invitation cap, and the two text settings' semantics (trailing whitespace
dropped, leading whitespace kept). Since §9.17 the marked-row semantics are covered too: the
`x` row in the tool result, the separate `MAX_DONE` cap (newest kept, oldest dropped), the
deterministic order of the marked group across both the `add` and the `replace` flow, a new
plan replacing the marks, `remove` dropping a single mark, the
open-only reminder, the refusal to edit or re-complete a marked item, and adversarial host
shapes (a frozen message array, a throwing content accessor, a payload nested past the
contains-walk's depth limit). Since §9.18 the counter is covered as well: `replace` and
`clear` resetting `done` to zero (and the panel consequently falling back to `暂无待办`),
`remove` leaving it alone, the reset surviving a store round-trip and a restart where a fresh
instance re-reads the bytes, and the upward repair in `normalizeState` not resurrecting a
reset counter. The entrypoint suite is hermetic: it points `XDG_CONFIG_HOME` at a
path that does not exist, so a real config file on the machine cannot change what the tests
observe.

`tests/focus-todo-view.test.ts` (36) round-trips the server's own `formatState` output through
the panel's parser (so the two halves cannot drift), and covers `warn=` prefixes, `error=`
text, malformed bodies, more than 16 items, a body longer than the tool's own caps (16 open
plus 16 marked), `x` rows and an oversized `done=`, derived counts, scan limits, junk inputs,
wide-character width budgets, every `buildPanel` branch — including both `暂无待办` branches,
`all done` with marked rows, and the count-only line when the marks were removed (§9.20) —
`reminderStatus` for the three provable cases, `newestIsOwnResult` looking only at the newest
message, and the cap agreement with the tool (the panel's row budget is asserted equal to
`MAX_ITEMS`/`MAX_DONE`, so the duplicated literals cannot drift).

`tests/tui-panel.test.ts` (15) loads the real `tui.tsx` through a stubbed JSX runtime and
asserts that one plugin directory resolves **both** entrypoints, that all three plugin files
resolve from inside that one directory (so a directory copy is a complete install), that
exactly one slot is claimed and it is `append: "sidebar.content"`, that cleanup releases it,
that a non-TUI context leaves the panel inert, and that rendering matches the session state
(header, status line, rows — both `0 active, done=N` shapes, §9.20), colours each status, clips
to the terminal budget and isolates sessions.

`tests/focus-todo-invariants.test.ts` (10) is the hunt described in §9.17.1: seeded random
action sequences (including deliberately invalid ones) checked against the state invariants
after every step, plus bounded growth over 3 000 steps and the two panel round-trips. The wide
version of the same sweep lives in `_evidence/bughunt/invariants-sweep.ts`.

### 9.2 Type check — clean

`bunx --bun tsc --noEmit` with `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`
and `types: []` → no errors. The panel is type-checked too, under `jsx: "preserve"` with the
ambient solid/JSX declarations in `types/tui-runtime.d.ts`; the host itself compiles the same
file with Babel, so the panel is checked twice by two different front ends.

### 9.3 Plugin loading — clean, and loaded exactly once

No current `failed to load plugin` entry mentions this plugin. The two entries in the log
refer to a throwaway `probe.ts` from reconnaissance and to billion-context on 2026-09-25.

After the directory restructure, every load line for this plugin is identical in shape:

```
msg="loading plugin" id="…\.opencode\plugin\focus-todo"
                    entrypoint=file:///…/focus-todo/server.ts
```

so the **directory** is the plugin target and `server.ts` is its server entrypoint. Neither
`tui.tsx` nor `view.ts` ever appears as a plugin target — they are the second entrypoint and
an imported module respectively — which rules out a duplicate plugin and a duplicate
`focus_todo` registration. On the same restructured plugin, a real model call
(`tokenrhythm/qwen3.8-flash`, session `ses_realA01`) registered `focus_todo` as a
first-class tool and read back the three items written before the move, so the tool id and
the storage key are unchanged and no state migration was needed.

### 9.4 Real session: isolation and restart recovery (model `tokenrhythm/qwen3.8-flash`)

* Session A, process 1 → `focus_todo(action=replace, …)` → `3 active, done=0` /
  `t1:- wire up storage`, `t2:> write tests`, `t3:- update docs`.
* Session A, **process 2** (fresh standalone server) → `action=list` → the identical three
  items. Restart recovery confirmed.
* Session B, first ever call → `0 active, done=0`. Session isolation confirmed.
* The model drove the tool as a first-class wire tool, not through code mode.

### 9.5 Cache evidence — real outbound requests

Harness: a local OpenAI-compatible fake provider records every request body and replays
scripted responses, so a five-turn session was driven deterministically with the todo list
changing on each turn (`replace` → `complete` → `update` → `clear`). The requests still
flowed through billion-context's transport, so this is the billion-context-enabled path.

Ten captures exist, and `verify/analyze.mjs` runs the same checks over any of them
(`WIRE_LOG=<file>`, `REPORT=<file>`):

| Capture | Records | Reminder | Report | Result |
| --- | --- | --- | --- | --- |
| `verify/wire.jsonl` (baseline, before the reminder existed) | 10 requests / 5 turns | none | `cache-report-baseline.json` | all PASS |
| `verify/wire-reminder.jsonl` (first reminder round, 8-item cap) | 9 agent requests | 6 requests carry one | `cache-report.json` | all PASS (12 checks) |
| `verify/wire-16.jsonl` (current plugin, 16-item list) | 8 agent requests / 4 turns | 3 requests carry one | `cache-report-16.json` | all PASS (9 + 3 checks) |
| `verify/wire-16-off.jsonl` (same session, `"reminder": false`) | 8 agent requests / 4 turns | zero | `cache-report-16-off.json` | all PASS, "no reminder in this capture" |
| `verify/wire-described.jsonl` (the §9.12 description rewording) | 8 agent requests / 4 turns | 3 requests carry one | `cache-report-described.json` | all PASS |
| `verify/wire-trimmed.jsonl` (the §9.14 size budget) | 8 agent requests / 4 turns | 3 requests carry one | `cache-report-trimmed.json` | all PASS |
| `verify/wire-nudge.jsonl` (§9.15 nudge on, `staleAfter: 2`) | 8 agent requests / 4 turns | 6 requests carry one | `cache-report-nudge.json` | all PASS, documented timeline |
| `verify/wire-config.jsonl` (§9.16, `creationNudgeMax: 0`) | 6 agent requests / 3 turns | 3, invitation suppressed | `cache-report-config.json` | all PASS |
| `verify/wire-cfgtext.jsonl` (§9.16, custom texts, `staleAfter: 1`) | 8 agent requests / 4 turns | 6 requests carry one | `cache-report-cfgtext.json` | all PASS (12 checks) |
| `verify/wire-defaults.jsonl` (§9.16, the shipped default config after the restore) | 2 agent requests / 1 turn | 2 requests carry one | `cache-report-defaults.json` | all PASS |

Checks that hold in all four, on the wire, with the requests flowing through
billion-context's transport:

| Check | Result |
| --- | --- |
| Every agent request carries byte-identical tool definitions | PASS (1 distinct definition) |
| Tool order identical | PASS (19 tools) |
| `focus_todo` is a first-class wire tool | PASS |
| System prompt byte-identical across every request | PASS (18 151 bytes) |
| History append-only (ignoring the last-message reminder) | PASS (8 consecutive pairs) |
| `prompt_cache_key` unchanged | PASS (`"ses_eca310a01ffe07cVw3gFNVxF6D"`, set by the host) |
| `x-session-affinity` unchanged | PASS |
| No extra system message appended | PASS |
| Todo state appears only inside tool results in the transcript | PASS (16 todo tool results) |
| Reminder appears exactly once per request, as the last message | PASS (6 requests in the first round, 3 in the 16-item round) |
| Each request reuses every message the previous one sent except its own reminder | PASS (shared prefixes 6/7, 8/9, 10/11, 12/13, 14/15 in round one; 6/7 and 10/11 with the dedup guard on) |
| Reminder content tracks the list rather than being frozen | PASS (3 distinct texts in both rounds) |

The 16-item round also measures the two guards and the settings switch:

| Observation | Evidence |
| --- | --- |
| Attention ordering on the wire | `[focus_todo] 15 open, 1 done: t16> … \| t2! … \| t3- …` — the running item first, then the blocked one, then list order |
| Budget with `+k more` | 357 / 324 / 326 characters against the default 360 budget, each ending `+8 more` — nothing is dropped silently |
| Dedup guard (item 3 of this round) | Requests whose tail already was the todo tool result (`16 active, done=0 …`) carry **no** reminder; the three that do are the turn-start requests. Before the fix the same guard was a silent no-op (§9.11) |
| Settings file honoured | `"reminder": false` in `~/.config/opencode/focus-todo.json` → 8 agent requests, **0** reminders, tool and sidebar unchanged; back to `true` → reminders return |

**Stable cache prefix boundary:** the system prompt, the full tool-definition array in a
fixed order, and every message of the conversation up to the newest one. Todo activity
appends tool results and, when something is open, one reminder as the very last message —
both new suffixes, never a change to anything before them. Cache hit rate is therefore
unaffected by todo updates.

### 9.6 Compaction — NOT VERIFIED

* Native compaction is off by design (`compaction.auto=false`) and compression is owned by
  billion-context.
* The plugin registers **no** compaction hook and writes nothing to compaction output — it
  literally never touches the `session.hook("compaction")` path (see the unit test that
  asserts only the `storage` and `tool` domains are accessed).
* A real billion-context compression boundary could **not** be induced: `/compact` is
  handled by billion-context's own `compress` tool, which refused because the compressible
  range was below its 5 000-character minimum, and its multi-step protocol could not be
  driven from the fake provider.
* Therefore **"prefix comparison across a real compression boundary" is NOT VERIFIED**, and
  no claim of passing it is made. What *is* verified is that requests flowing through
  billion-context carry a stable prefix (§9.5) and that todo state lives outside the
  conversation, so it does not need to be carried across a compression boundary at all.

### 9.7 billion-context availability

The plugin has no dependency on billion-context: the unit tests run with no other plugin
present, it registers only `focus_todo`, and it never reads or writes anything belonging to
billion-context. Removing billion-context leaves the todo tool fully functional.

**The one setting worth knowing about, reported not changed** (§9.17's round asked whether it
should be enabled). billion-context 0.1.196 offers `compress.protectedLatestTools`, which
protects the *latest* instance of a cumulative-snapshot tool from compression — the documented
fix for "the agent forgets the todo list after a compression" (its issue #639), and it also
enrols those tools in plan-aware retrieval. `compress.protectedTools` (all history) is the
blunt version and is warned about upstream, because everything protected grows the request.

Measured state on this machine (read-only, no modification): the config file exists with
`compress.preserveRecentMessages = 2` only; **`protectedLatestTools` is not set**, so nothing
is protected today. If the list itself should survive a compression as well, the setting is
`"protectedLatestTools": ["focus_todo"]` — one entry, the *latest* snapshot only, which is
exactly the tool whose result this plugin keeps rewriting. It stays the user's call: the plugin
does not depend on it and works identically without it (the reminder is regenerated from
storage on every request, which is why a compression cannot dull it — §9.5).
**(Update, §9.21: now enabled** in the installed config — the latest snapshot is protected.**)

**Coexistence is now measured, not just argued** (§9.18): the requests in
`verify/wire-counter.jsonl` were assembled with billion-context in the path — all 16 carry its
`<acp tokens="…">` markers — and on that final body every prefix check passes, all eight
`focus_todo` tool results arrive verbatim, and the reminder still lands last. The compression
boundary itself remains **NOT VERIFIED** (§10.6): that session was 17 KB and nothing was
rewritten.

### 9.8 Request-tail reminder — how the model is told without asking

Goal: the model should know the open list even when it does not call `list`, without hurting
the cache and without a compaction being able to erase it. §5 explains why the obvious route
(`system[]`) is wrong; this is what the hook probe established instead.

**Step 1 — the contract, measured with a throwaway probe** (`_evidence/probe/hook-probe.ts`,
run inside a scratch project with the fake provider): `session.hook("context", cb)` fires once
per outbound request and hands the callback
`{sessionID, model, system[], messages[], options, agent, tools{}}`, where `messages[]` is the
host's internal model (`{id, role, content, metadata}`, `content` a parts array). The callback
may be async, and a message pushed onto `messages[]` **after an await** still lands.

**Step 2 — what the appended message actually does** (captured at the provider, two turns of
a probe session):

```
turn 1 request:  [system, user("probe turn one"), user("PROBE-TAIL-MARKER")]
turn 2 request:  [system, user("probe turn one"), assistant("P1-OK"), user("probe turn two"),
                  user("PROBE-TAIL-MARKER")]
```

The marker reaches the model, sits last, and is **not** in turn 2's history: it is regenerated,
not accumulated. billion-context wrapped it like any other message
(`<acp tokens="…" type="text">m…</acp>`) and did not move it.

**Step 3 — the reminder shipped in the plugin** is one bounded line
(`formatReminder`), appended only when the list is non-empty, mirrored to the shape of the
message before it, and reflected in the wire capture:

```
seq=2  (nothing open yet)          last = user  "start the scripted session"      ← no reminder
seq=4  after replace               last = user  "[focus_todo] 2 open: t1> implement storage | t2- add tests"
seq=6  after complete              last = user  "[focus_todo] 1 open, 1 done: t2- add tests"
seq=8  after update                last = user  "[focus_todo] 1 open, 1 done: t2> add unit tests"
seq=10 after clear                 last = tool  "0 active, done=1"                 ← nothing open, no reminder
```

**Step 4 — the three properties, each measured rather than argued:**

| Property | Evidence |
| --- | --- |
| Reaches the model, at the tail | Reminder present in 6 of 9 agent requests, always as the last message (`verify/analyze.mjs`) |
| Does not pollute the session | 19 persisted messages in the capture session, **0** containing the reminder text, while 4 todo tool results are persisted normally (SQLite `session_message`) |
| Does not move the cacheable prefix | Tool definitions 1 distinct / 19 tools in fixed order; system prompt byte-identical (18 151 bytes); every request's shared prefix with the previous one is *all of its messages except the previous reminder* (6/7, 8/9, 10/11, 12/13, 14/15) |

**Compaction interaction — this is the point of the design, and it is reasoning plus one
tested half.** The reminder is not part of the conversation: it is generated from storage on
every request and appended after everything else, so compressing the conversation cannot
remove it and it never enters the range billion-context summarizes. What *is* measured is that
it is not persisted (so it cannot be folded into a summary) and that it is regenerated with
current content on each request (3 distinct texts across the capture as the list changed).
What is **NOT VERIFIED** is the same thing as §9.6: a real billion-context compression boundary
could not be induced on this machine, so "the reminder survives an actual compression cycle"
is inference from the two measured properties, not a captured observation.

Cost: at most one message per request, ≤`reminderBudget` characters (default 360, 60 per
item), and **zero** when the list is empty or the session never used the tool. The switch is
the JSON file §9.11, not an environment variable; `FOCUS_TODO_REMINDER=0/1` still overrides
the file for one-off runs and tests.

### 9.9 Global install — what the loader really does

Measured on 2026-10-13 by installing copies and watching `msg="loading plugin"` lines:

| Question | Answer |
| --- | --- |
| Where does a global plugin go? | `<config>/opencode/plugin/` **and** `<config>/opencode/plugins/` are both scanned. Either works; this install uses `plugin/` (singular, matching the project convention) and leaves `plugins/` empty. |
| Does it apply to every project? | Yes. From a clean project with no `.opencode/plugin` of its own, both a real `focus_todo` call and the sidebar panel were verified; the load line reads `entrypoint=…\.config\opencode\plugin\focus-todo\server.ts`. |
| What if the same plugin exists in two places? | **Both load.** In this repository (source in `src/`, copy installed globally) the log shows two load lines for the directory — the project copy *and* the global copy — because deduplication is by target, not by plugin id. The `focus_todo` tool still worked, but two registrations and two sidebar panels are wrong, so the source was moved out of `.opencode/plugin/` and only one copy is installed. |
| Is a directory copy really enough? | Yes for `src/focus-todo/`: `tui.tsx` imports `./view.ts` from inside the same directory, and a test asserts all three files resolve from inside it. MD5 of the installed copy matches the source. |
| Does `opencode plugin list` reflect reality? | **No** — it is a persistent registry, not a live scan: it kept showing paths that had already been removed, and listed a directory entry with a `-` id. Only load lines in the log and a live tool call are trustworthy here. |

### 9.10 Sidebar panel — rendered-frame evidence, three states

Harness: `OPENCODE_DRIVE=1` makes the real TUI render without a terminal and serve a UI
simulation protocol on `ws://127.0.0.1:40900`; `verify/drive-capture.mjs` handshakes as a UI
client (`requiredCapabilities: ["ui.capture"]`), resizes to 200×50, captures the frame and
asserts on the visible text while reporting each hit's row/column. Frames are terminal cells
(`{cols, rows, lines[{spans[{text, width, fg}]}]}`), so a column number is real layout, not a
guess.

One Windows-only wrinkle, for anyone re-running this: the Bun binary trusts the `PWD`
environment variable, so a launcher must clear `PWD` and `cd /d` into the project before
starting it (`set PWD=` then `cd /d`), otherwise it resolves the project from the wrong
directory. The launcher used here is three lines and is shown in README.md §Develop.

| Session state | Expected | Result |
| --- | --- | --- |
| `3 active, done=0` (`ses_realA01`) | header + 3 item lines, in the sidebar region | **PASS** — `Focus 3 active` at row 5 **col 160**; `t1:- wire up storage`, `t2:> write tests`, `t3:- update docs` |
| `0 active, done=1` (`ses_wireexp0007`) | exactly `Focus: all done`, no item lines | **PASS** — `Focus: all done` at row 4 **col 160**; `!t1:` and `!t2:` both confirmed absent — **that body had no rows; since §9.20 this state draws `Focus 0 active, done 1`** |
| `0 active, done=0` (`ses_finalcheck02`) | no panel at all | **PASS** — the whole frame contains **no** `Focus` string |
| no state at all (unit tests) | no panel at all | PASS (`buildPanel` returns `undefined`) |

Placement is verified, not inferred. In the 200-column frame the transcript sits at columns
0–159 and the sidebar rail starts at column 160; a separator cell `│` appears at columns 160
and 196 around the neighbouring bordered panel. Quadrant check on the first capture:

```
row 2  col 10    Replace todo list with storage, tests, docs   ← transcript (session title from the tool call)
row 5  col 160   Focus 3 active                                ← this plugin's panel, sidebar rail
row 11 col 165   ▼ 缓存统计  v1.7.5                            ← opencode-visual-cache's bordered panel, below ours
```

So the panel renders in the sidebar's content area, above the visual-cache panel
(`prepend`), with the same 8-column left inset as the other sidebar content, and it does not
disturb any neighbouring panel. Both installed npm packages
(`opencode-visual-cache@1.7.4`, `opencode-subagent-magazine@1.7.1`) use the identical
mechanism: a package `./tui` export giving them a TUI entrypoint, then
`ui.slot({… : "sidebar.content", render})`. This plugin reaches the same slot from a local
directory plugin instead, with no package install.

Also verified at runtime: the panel is read-only (it never calls a mutating API), it holds no
timers or subscriptions (nothing to leak, and it is released on unload through the returned
unregister function), and it renders nothing when the tool has never been used in that
session.

**Not verified here:** behaviour of the panel across a TUI that changes the internal API
(there is only 2.0.27 installed), and the panel's appearance on very narrow terminals — the
width clamp is covered by unit tests (`rowWidth` and `clip`), not by a captured frame.

**Superseded for the two empty states.** The table above describes the 0.1.0 panel, which
rendered nothing when there was no list. Since §9.17 the panel always renders: `暂无待办` for a
session with no list (no status line, since nothing can be proven), and a status line under the
header in every other case. The three populated captures remain valid as placement evidence.

---

### 9.11 Second round — 16 items, a settings file, and two guards that had to be measured

Three changes, each chosen because it is provably cache-neutral (nothing touches the
tool-definition/system-prompt prefix; the only per-request difference stays at the tail):

1. **Cap 8 → 16 items.** The cap lives in `MAX_ITEMS` and is *not* mentioned in the frozen
   tool description or input schema, so raising it did not change one byte of the cached
   prefix. Verified against the first capture: `name`, `description` and `parameters` of
   `focus_todo` are byte-identical to the recorded baseline (only the host-added
   `strict: false` differs, and every host tool carries it).
2. **Settings in `~/.config/opencode/focus-todo.json`** instead of environment variables,
   with the env vars kept as an override. `{ "reminder": true, "reminderBudget": 360 }`;
   missing file, wrong types, junk keys or broken JSON all resolve to the defaults, and the
   budget is clamped to 80…2000. Measured on the wire, not just in unit tests: with
   `"reminder": false` the same 4-turn/8-request script produced a capture with **zero**
   reminders while every other check still passed (`verify/wire-16-off.jsonl`).
3. **Two guards**: the reminder is skipped when the newest message already shows the same
   state, and a second hook registration (plugin reload) cannot append a second reminder.

**The dedup guard was a silent no-op until the wire said otherwise.** The first 16-item
capture showed a reminder on *every* request, including the ones whose tail was the
`focus_todo` tool result — the state was duplicated in a 357-character line the model had
just read. Cause: the guard read `content.text`/`content.content`, but the host nests a tool
result's text deeper (`{… output: { output: "16 active, done=0 …" }}`), so the check never
matched a real message. Fixed by walking the whole content value (`containsText`), plus a
unit test that uses the nested shape. The second capture shows the intended profile: 3 of 8
requests carry a reminder, and those three are exactly the turn-start requests.

### 9.12 Third round — description wording (the one deliberate prefix change)

Proposals 1 and 2 of §11 were implemented, because they are the only kind of change that
touches the cached prefix **once** and then buys something on every request:

* `TOOL_DESCRIPTION` gained "skip the list for a single trivial step" (Claude Code and Kilo
  both carry such a clause) and "Keep each item to a few words" (Codex asks for 5–7 words;
  shorter items mean shorter tool results and more items fitting the reminder budget).
* The redundant "it returns the open items plus how many were already finished" was deleted —
  `list` is already described in the input schema — so the description went from 526 to
  **533 characters (+7)** while adding both behaviours.
* `INPUT_SCHEMA` and `OUTPUT_SCHEMA` are untouched, and `NAME` is unchanged.

Verified: 118 unit tests and `tsc --noEmit` clean; the plugin deployed to the global
directory with matching MD5; a fresh 4-turn capture (`verify/wire-described.jsonl`,
`verify/cache-report-described.json`) passes every check — 8 agent requests, **1 distinct**
`focus_todo` definition, tool order intact, system prompt byte-identical (18 151 bytes),
reminders still exactly-once-and-last on the three turn-start requests with 3 distinct texts.

Cross-capture note, so nobody mistakes it for drift: the definition is *not* byte-identical to
the older captures any more — that is this intentional one-line change (526 → 533 chars), and
it costs one cache re-write of the tool block on the next request. Within every capture the
definition is still 1 distinct value across all requests.

### 9.13 Spontaneous adoption — 0 of 2 (real model, `tokenrhythm/qwen3.8-flash`)

Open question from §11: does a real model call `focus_todo` on its *own* initiative at the
start of a multi-step task? Two bounded probes in `_evidence/real/` (real provider, global
install, `opencode run --standalone`), each a task with 4–6 obvious steps:

| Probe | Task | Tool calls the model made | `focus_todo` called? |
| --- | --- | --- | --- |
| 1 | create `one.txt`/`two.txt`/`three.txt`, read them back, summarise | 3 × `write`, 3 × `read`, 1 × code-mode `execute` | **no** |
| 2 | create `pkg/__init__.py`, `pkg/mathx.py`, `tests/test_mathx.py`, run the tests, report | 4 × `write`, 1 × shell | **no** |

Both tasks were completed correctly and reported correctly; neither session touched the list.
So for this model and this harness the tool is used when the model is *asked or reminded*, not
unprompted — the passive tail reminder (§9.8) and the description's own wording are what carry
the feature, which is exactly why the reminder exists and why it is not gated behind "the
model asked for it". Two honest caveats: two probes are not a rate, and the tasks may simply
not feel "complex" to a model that finishes them in four calls. A stronger lever, if
unprompted use is wanted, would be making the reminder also *ask* for an update — a change we
have not made, because it would spend tokens on every request and diverge from the
"inform, don't instruct" design of the tail line.

Also measured while writing the scripted captures: the `in_progress` invariant fires in real
use — a scripted `update` on a second item returned `error=only one in_progress allowed` and
the turn was wasted. That is why both conflict errors now name the offending id
(`only one in_progress allowed (t1 is in_progress)`) and an unknown id lists the open ids
(`unknown id t7; open ids: t1 t2 t3`), so a model can repair the call in the same turn. This
changes only the error strings inside tool results, never the tool definition.

### 9.14 Fourth round — a size budget for the cached prefix

Prompted by "keep it light": every byte here is re-sent on every request of every session, so
the fixed part got a measured budget and two guard tests.

| Piece | Before | After | Delta |
| --- | --- | --- | --- |
| `TOOL_DESCRIPTION` | 533 chars | **418 chars** | −115 |
| `INPUT_SCHEMA` (JSON) | 1253 chars | **1116 chars** | −137 |
| whole `focus_todo` block as serialized on the wire | 1900 chars | **1648 chars** | −252 (~63 tokens at the host's measured ≈4.0 chars/token) |
| reminder per item | 60 chars clip | **48 chars clip** | binds only for items longer than that; the line is also bounded by `reminderBudget` |

Nothing functional was removed: the same eight rules survive (resume/compaction/restart
`list`, `replace` for multi-step plans, skip for a trivial step, few-word items, one
`in_progress`, update on finish/block/scope change, "not tracked"), the enum values and
`required` lists in the schema are untouched, and the trimming is mostly wording
("overwrite the whole list" → "overwrite the list", "for example t3" → "e.g. t3", duplicated
phrasing between the description and the schema removed).

Two tests make the budget explicit rather than hoped for:

* `the description stays small and keeps every rule it carries` — asserts
  `TOOL_DESCRIPTION.length <= 430` and one marker per rule, so a future rewording can move
  words but not silently drop a rule or grow the prefix;
* `the schemas stay small too` — asserts the input schema stays ≤1050 chars and the output
  schema is exactly `{"type":"string"}`.

Verified on the wire with the trimmed build (`verify/wire-trimmed.jsonl`,
`verify/cache-report-trimmed.json`): 8 agent requests, **1 distinct** definition, tool order
intact, system prompt byte-identical (18 151 bytes), reminders exactly once and last on the
three turn-start requests, shared prefixes 6/7 and 10/11. The plugin was redeployed to the
global directory (MD5 matches). Reminder sizes in that capture: 357 / 324 / 326 characters
(90 / 81 / 82 host-counted tokens) for 16-item lists, i.e. the worst case is ~90 tokens and a
typical 3-item list is 30.

### 9.15 Fifth round — the nudge, and an honest adoption result

> **Superseded in part by §9.19:** the invitation is no longer capped at three per session and
> no longer reads as an imperative; the cadence (`staleAfter`) and everything else here still
> holds.

`staleAfter` (default 6, 0 disables; the key is `creationNudgeMax`
since §9.16 — `CREATION_NUDGE_MAX` was the internal constant of this round) adds one imperative to the tail channel, in two forms,
both gated on a **user turn start** and on the list being idle:

* list exists: the state line gains ` — update it if it changed`;
* no list at all: `[focus_todo] no list yet — for a multi-step turn, record the plan with
  focus_todo(action="replace")`, at most `CREATION_NUDGE_MAX` = 3 per session.

Cadence lives in a per-session in-memory memo (`idle`, `creation`): anything that shows the
model just used the list resets `idle`, and a fired nudge resets it too, so invitations are
never two turns in a row. `staleAfter: 0` turns both forms off and leaves the informative
reminder untouched. 127 unit tests cover the parse/clamp of the new key, the two forms, the
spacing, the per-session cap, the reset-on-use and the turn-start gate.

Wire evidence (`verify/wire-nudge.jsonl`, `verify/cache-report-nudge.json`, `staleAfter: 2` to
keep the capture short): 8 requests, all checks PASS — one definition, tool order, system
prompt byte-identical, one appended message per request, and the timeline

| seq | what the model did | what the plugin appended |
| --- | --- | --- |
| 1 | first turn, no list yet | the invitation line |
| 2 | after a `read` result | nothing (empty list, not a turn start) |
| 3 | next turn, still no list | the invitation again |
| 4 | after the `focus_todo` result | nothing (dedup guard) |
| 5 | next turn, list exists | state line + "update it if it changed" |
| 6 | after a `read` result | state line, no clause |
| 7 | next turn | state line + clause |
| 8 | after a `read` result | state line, no clause |

Two honest caveats. First, `opencode run` starts a fresh process per invocation, so every
captured turn start also looked "unseen"; the within-process cadence is therefore covered by
the unit tests rather than by this capture (the TUI and the background service keep one
process across turns, where the cadence applies). Second, the nudge did not flip spontaneous
adoption: a third real-model probe with the invitation present (`_evidence/real/`, session
`ses_realNudge…`) again produced zero unprompted `focus_todo` calls, so the count is now
**0 of 3** (§9.13). What the nudge does verifiably is keep a list that *is* in use from
silently going stale, and invite a list at the moments a new instruction arrives.

### 9.16 Sixth round — the whole settings surface, and two bugs the wire caught

Every knob the plugin has is now a key in the settings file (`~/.config/opencode/focus-todo.json`,
or next to `server.ts`), resolved with a clamp and — where it is a switch-like value — an
environment override, so behaviour can be tuned without touching code:

| Key | Default | Clamp | Env override |
| --- | --- | --- | --- |
| `reminder` | `true` | — | `FOCUS_TODO_REMINDER` |
| `reminderBudget` | `360` | 80…2000 | `FOCUS_TODO_REMINDER_BUDGET` |
| `staleAfter` | `6` | 0…200 | `FOCUS_TODO_STALE_AFTER` |
| `itemChars` | `48` | 16…200 | `FOCUS_TODO_ITEM_CHARS` |
| `creationNudgeMax` | `3` | 0…50 | `FOCUS_TODO_CREATION_NUDGE_MAX` |
| `maintenanceNudge` | `" — update it if it changed"` | ≤300 chars | file-only |
| `creationNudge` | the `no list yet …` line | ≤300 chars | file-only |

> **Since §9.19:** `creationNudgeMax` is retired (tolerated as an unknown key), so the shipped
> file now lists six keys and `staleAfter` is the only cadence the plugin has.

Resolution stays per-key: a wrong type, an out-of-range number or a `null` falls back to that
key's default, and broken JSON falls back to all defaults. The file shipped in
`~/.config/opencode/` lists all seven keys at their defaults, so it documents itself.

**Two bugs, both found by measuring rather than by reasoning.**

1. **The nudge clause escaped the reminder budget.** The line was formatted with the full
   `reminderBudget` and the clause was appended *after* that, so a full line plus a clause
   could exceed the configured bound. Now the line is formatted with
   `reminderBudget - clause.length` and the clause is added to it, so the whole appended
   message honours the budget.
2. **A custom clause lost its leading space.** `textSetting` trimmed both ends, so an explicit
   `" — update it if it changed"` in the file produced `update docs— update it if it changed`
   on the wire — the exact string in `verify/wire-config.jsonl` that gave it away. Only
   trailing whitespace is dropped now, because the leading space is what keeps the clause its
   own sentence and the file is the one place that owns the spacing. Re-verified with an
   explicit file value (`verify/wire-cfgtext.jsonl`): `… | t3- update docs  — 列表变了就更新`.

**What the nudge costs** (the measured answer to "what is the extra cost?"):

| Situation | Extra per request | Frequency |
| --- | --- | --- |
| steady state, informing | **0** — exactly the line the plugin always appended | every request |
| stale user turn start, list exists | +26 chars ≈ 6 tokens (`— update it if it changed`) | at most every `staleAfter` requests, turn starts only |
| session with no list yet | 99 chars ≈ 25 tokens *instead of* a 0-char state line | ≤ `creationNudgeMax` = 3 per session |
| plugin process | one memo entry per session (~100 bytes), 512 entries max, oldest evicted | — |
| cache prefix | unchanged: 12/12 checks pass, tool definitions and system prompt byte-identical, one appended message, prefix reuse intact | `verify/cache-report-cfgtext.json` |

Which is why it can be on by default: it is free when the list is in use and costs single-digit
tokens when it speaks.

**Where a bug would live, and what stops it today** (each row checked against code and
captures, not intent):

| Risk | Mitigation |
| --- | --- |
| the gate misreads "turn start" if the host renames a role | it is `last.role === "user"`; today's wire shows turn starts as `user` and in-turn requests as `tool`, and the worst case is a *missing* nudge |
| the memo leaks memory in a long-running TUI | bounded map, 512 entries, oldest evicted; each entry is two counters |
| an invitation returns after the user cleared the list on purpose | by design (`clear` leaves no items), capped at `creationNudgeMax`, and it is the only message an empty session ever draws |
| double hook registration (plugin reload) | process-level `reminderHookRegistered` guard |
| a hand-edited config breaking startup | every key typed, clamped and merged per-key; broken JSON = defaults; `loadSettings` never throws |
| tests observing the developer's real config file | pinned: the entrypoint suite points `XDG_CONFIG_HOME` at a nonexistent path (this bit us once — a verification file with `creationNudgeMax: 0` made the invitation test fail) |
| `staleAfter: 1` firing on nearly every turn | a legitimate setting, not a bug: the clause is 26 chars and cadence still resets on any list use |
| `opencode run` looks "unseen" every invocation (fresh process) | documented in §10.9; within one process (TUI, service) the cadence applies |

Wire evidence for this round: `verify/wire-cfgtext.jsonl` / `verify/cache-report-cfgtext.json`
— a session with `staleAfter: 1` and both texts overridden by the file. Timeline: R1/R3 the
custom invitation (no list yet), R4 nothing (dedup guard, tail was the todo result), R5/R7 the
state line + the custom clause at turn starts, R6/R8 the state line alone after tool results —
all 12 checks pass (`ALL PASS: true`), 132 unit tests and `tsc --noEmit` clean, deployed copy
MD5-matched.

### 9.17 Seventh round — finished rows stay visible, 150-character items, and two labels the panel refuses to fake

Three requests in one round: (a) raise the per-item limit to 150 characters, (b) let `complete`
**mark** an item instead of deleting it, showing it marked in the sidebar but not sending it,
(c) give the panel a state line — `暂无待办` when there is no list, a reminder status when there
is one, `未提醒` when nothing was sent.

**(a) and (b) on the wire** — `verify/wire-audit.jsonl`, 16 agent requests / 8 turns over one
session (`verify/cache-report-audit.json`: **ALL PASS**, 12 checks). One session walks the whole
lifecycle — a 150-character item, a completion, a re-plan, two more completions, the 151-char
rejection and an edit of a marked row — so every claim below is a recorded request, not an
assertion. The tool results it produced, in order:

```
2 active, done=0
t1:> implement storage
t2:- LLLL…(150 chars, unclipped)

1 active, done=1
t2:- LLLL…(150)
t1:x implement storage

2 active, done=1
t3:> replan step
t4:- ordering probe           ← the new plan replaced the list, `t1:x` went with it

1 active, done=2
t4:- ordering probe
t3:x replan step              ← the newest finish leads the marked group

0 active, done=3
t4:x ordering probe
t3:x replan step              ← finishing everything keeps the marks …

1 active, done=3
t5:- verify sidebar reminder state
t4:x ordering probe
t3:x replan step              ← … until the next interaction
```

| Observation | Value |
| --- | --- |
| 150-character item accepted | tool result row is `t2:- ` + exactly 150 chars (row length 155) |
| 151-character item rejected | `error=text too long (max 150 chars)` |
| `complete` marks rather than deletes | result after completing `t1`: `1 active, done=1` / `t2:- …` / `t1:x implement storage` |
| a marked row refuses further edits | `error=t3 is already done; open ids: none` |
| a new plan replaces the marks, keeps the counter | the third result above: `done=1` and no `x` row — **superseded by §9.18, where the counter is reset too** |
| marked group leads with the newest finish | `t3:x` before `t1:x`; later `t4:x` before `t3:x` |
| the reminder carries open items only | `[focus_todo] 2 open, 1 done: t2- LLL…` — no marked row, ever |
| reminder count in the same capture | 5 of 16 requests; the ones without it are exactly the ones whose tail already was the result |
| prefix checks | tool definitions byte-identical, system prompt byte-identical (18 151 bytes), append-only history, `prompt_cache_key` untouched |

**Three defects this work exposed — one while re-reading the new marked-row code, two by the
audit pass afterwards (§9.17.1):**

1. **The marked group's order was accidental.** `add` appended the new item after the marked
   rows while `replace` installed its items before them, so the same finishing sequence printed
   `[newest … oldest]` through one flow and `[oldest … newest]` through the other. `add` now
   joins the open section (`capped([...state.items, item])`) and `capped` keeps the newest
   `MAX_DONE` marks with `slice(0, …)` instead of `slice(-…)`, which also stopped the cap from
   dropping the row that was just completed. Both flows now print the same string — asserted by
   a test that runs the identical sequence through `add`/`complete` and through
   `replace`/`complete`.
2. **A stored counter could sit behind its own marked rows.** A state whose `completed` is
   missing or stale (a partial write, a hand-edited key, a future writer) would print `done=0`
   while listing `x` rows, and a panel reading `0 active, done=0` renders `暂无待办` — marks
   hidden by a counter. `normalizeState` now repairs the counter **upward** to at least the
   marked rows it can see, and never downward, since the cap drops old marks that history still
   counts (tests cover both directions).
3. **The budget claim was too strong.** §9.16 said the whole appended message honours
   `reminderBudget`; measured, a custom `maintenanceNudge` of ~300 characters pushes the
   message up to `reminderBudget − 80 + clause` (379 chars at the default 360) because the
   user's own text is used as written rather than clipped. Behaviour kept — clipping a
   configured sentence mid-word is worse than a 19-char overrun — and the contract is now
   stated correctly in the settings table, the source comment and a test that pins the real
   bound.

**The `replace` question, decided by the user this round.** The first version of this round kept
marked rows across a `replace` (a new plan inherited the previous plan's finished rows). The
requirement is the opposite — marks are not an archive: they can be cleared, or replaced by the
next plan, and keep nothing alive on their own. So `replace` installs its items *only*: the
previous plan's marks go with the plan, `clear` drops everything, and `remove <id>` stays the
way to drop a single mark. What survived at that point was the session-level `done` counter;
**§9.18 has since made that counter a per-plan one as well**, so nothing at all outlives the
plan that produced it except the id sequence. Verified on the wire
(`verify/wire-audit.jsonl`): marks appear (`1 active, done=1` / `t1:x`), survive the last
completion (`0 active, done=3` with the two marked rows), and are gone after the next plan
(`verify/wire-counter.jsonl`, §9.18, where the counter reads `done=0` again).

Row text of a marked item is clipped to `DONE_TEXT_MAX` = 24 characters in the tool result
(`t1:x implement storage`, `t3:x long description of someth…`). Marked rows accumulate in every
tool result, so they are the one place where the new behaviour costs bytes; the cap is what
keeps it bounded — at most 16 marked rows × ≤32 characters ≈ 500 bytes, and only inside a
result the model asked for, never on a plain request.

**Why the two channels differ.** The reminder exists to tell the model *what is left*; the
sidebar exists to tell a human *what happened*. Marked rows are therefore in the tool result
(which the panel reads — it is the panel's only data source) and out of the reminder. The
alternative — counts only in the tool result — would have made the panel show a bare
`0 active, done=3` with nothing to look at; if that is ever preferred, it is a one-line change
in `formatState` and the panel's parser already tolerates it.

**(c) on the panel** — four states, each captured from the real headless TUI on the shipped
build (`verify/drive-capture.mjs`, 200×50 frame, `--min-col=150` so every hit is in the sidebar
rail at column 160; session `ses_auditround18cVw3gFNVxF2`, re-captured after every fix below):

| State | Frame evidence |
| --- | --- |
| open + one mark, tail is a text message | `Focus 1 active, done 1` row 4 col 160; `已提醒待办` row 5; `t2:- L…` row 6, `t1:x implement storage` row 7 |
| same session after a new plan (`replace`) | `Focus 2 active, done 1` row 4; `已提醒待办` row 5; `t3:> replan step` row 6, `t4:- ordering probe` row 7; `t1:x` confirmed **absent** — the old plan's mark is gone |
| everything finished | `Focus: all done` row 4; `未提醒` row 5; the two marked rows rows 6–7, newest first (`t4:x ordering probe`, `t3:x replan step`); `已提醒待办` absent |
| session whose tail is the tool result | `Focus 1 active, done 3` row 4; `未提醒` row 5; `t5:- verify sidebar rem…` row 6, `t4:x ordering probe` row 7, `t3:x replan step` row 8; `已提醒待办` absent |
| session that never used the tool | `暂无待办` row 4 col 160; `已提醒待办`, `未提醒` and `t1:` all confirmed **absent** (one line, no status claim) |

### 9.17.1 The audit pass — a seeded invariant hunt, and what it found

The state machine is where a "reasonable-looking" change can go wrong silently, so it was
hunted rather than spot-checked: a seeded LCG drives random — and deliberately invalid — model
call shapes (`list|replace|add|update|complete|remove|clear` with junk ids, empty/oversized/
multi-line text, bad statuses, 0…19-item `replace` payloads) through the same `applyAction` the
tool uses, and after **every** step asserts the invariants a bug would break:

| Invariant | Why it matters |
| --- | --- |
| ≤16 open, ≤16 marked, ≤32 rows total | the caps are the whole anti-bloat story |
| ≤1 open `in_progress`, and marked rows never hold the slot | the rule the model is told about |
| ids unique, well-formed, never reused (`nextId` ahead) | an id collision corrupts both the panel and the model's view |
| stored order == printed order (open first, marked last, newest finish first) | this is the invariant the first defect violated |
| `completed` ≥ marked rows | the second defect |
| text non-empty, single-line, trimmed, ≤150 | what the schema promises |
| `formatState` → `parseFocusState` reproduces the exact rows, counts and statuses | the panel and the tool can never drift |
| the reminder lists every open row, names **no** marked row, and stays within budget | the send-side contract |

Results: `_evidence/bughunt/invariants-sweep.ts` — **24 seeds × 4 000 steps, 28 878 applied
actions, 67 122 refusals, 499 380 assertions, no invariant violated**; the committed subset
(`tests/focus-todo-invariants.test.ts`, 7 seeds × 1 500 steps + a 3 000-step bounded-growth run)
runs in ~0.3 s with `bun test`. It also checks the two purity properties the design leans on:
a refusal never moves the state, and a mutation never mutates the state it was handed.

Three things the hunt itself taught, both worth keeping in the record:

* **The first version of the "reminder leaks a marked row" check was wrong**, and the sweep
  said so: it substring-matched ids, so an open `t10` looked like a leak of marked `t1`. The
  check now parses the entries (`^<id><marker>`) before comparing. A hunt whose assertions are
  sloppy invents bugs; the false positives are in the log above for exactly that reason.
* **Nothing in the state machine broke**, including the paths the hand-written tests had not
  covered (an all-marked list, `replace` with an empty array, a 19-item `replace` refused at 17,
  completing the last open row of a list that still has marks).
* Adversarial **host** shapes were added to the hook tests in the same pass: a frozen
  `messages` array (the append throws, the request must not), a `content` getter that throws
  mid-walk, and a payload nested past the walk's depth limit (the guard gives up and appends —
  conservative, never harmful). All three now have regression tests.

Two harness details, because both took a try to get right:

* **Freezing the `未提醒` state.** It is a mid-turn state: it exists while the newest message is
  the plugin's own tool result, which normally lasts only until the assistant text arrives.
  `verify/fake-provider.mjs` therefore learned a `{"type":"hang"}` step that logs the request
  and leaves it unanswered. Driving one `add` turn against it produced
  `verify/wire-notified.jsonl`: the second request's last message is
  `2 active, done=2\nt4:- ordering probe\nt5:- verify sidebar reminder state\nt3:x replan step\nt1:x implement storage`
  and that request carries **no** reminder — exactly the condition the panel labels `未提醒`.
  The process was then killed and a fresh TUI opened on the same session, which is how the frame
  above was captured.
* **A stale TUI shows stale code.** The first capture attempt returned the old panel because the
  drive-mode server holding `ws://127.0.0.1:40900` had been started before the deploy and was
  still running the previous `view.ts`. Ports are now checked before a capture (and the process
  killed if needed) — worth remembering, since the plugin is loaded once per TUI process.

**The two labels that are not implemented, and why.** The request also named
`已提醒更新待办` (the nudge clause went out) and `已提醒是否使用待办` (the no-list invitation went
out). Both depend on counters that live in the **server half's memory**, and the TUI half cannot
read them. That was probed at runtime rather than assumed:

* the TUI's storage helper writes `plugin.<id>.<cell>` cells, and a cell name may not contain a
  `/` — the server's keys are `focus-todo/session/<sessionID>`, so they cannot even share a
  namespace;
* a cell written by the server half is not visible to a TUI-half `store()` read and vice versa
  (separate halves, separate domains — probed both directions);
* `context.data` in the TUI is a set of read-only views (`session.list/get/…`, `project`,
  `shell`, `location`), with no channel that carries plugin-private state.

So the panel reports only what the session window can prove, and the richer vocabulary stays
unimplemented rather than faked. The nudge timeline it would have described *is* verified — on
the wire (§9.15, §9.16) — which is the honest place for it until a supported bridge exists
(the server half exposes an unprobed `rpc` domain, and the TUI exposes `data.on`/`client`;
turning either into a channel would be its own round with its own evidence).

Also updated in this round: the tool description and schema changed once more as a consequence
(the schema now says `complete: mark done, kept as x` and `max 150 chars`), and the schema's
prose was tightened in the same edit, so the cached prefix grew *smaller*: the `focus_todo` tool
block went from 1648 to 1566 characters (`verify/wire-done.jsonl`), 1566 of the 21 092
characters of tool surface = 7 %. The budget tests (§9.14) still hold the description ≤430 and
the schema ≤1050 characters, and both were re-measured after the edit.

### 9.18 Eighth round — the `done` counter belongs to the plan, and coexistence with billion-context measured

**The change.** `done` no longer accumulates for the lifetime of a session. It counts the
completions of the **current plan**: `complete` increments it, `replace` and `clear` reset it to
zero along with the rows they drop, and `remove` leaves it alone (dropping a row is not
un-completing it). One line of reasoning decided it — the user's: a counter that keeps climbing
across unrelated pieces of work tells neither the model nor a human anything useful about *this*
list, and the moment a new plan starts, "3 done" from the previous one is worse than silence. A
side effect worth naming: `clear` now leaves the session at `0 active, done=0`, which the panel
renders as `暂无待办` instead of the old `Focus: all done` with no rows under it.

Implementation is two call sites — `clone(state, capped(items), { nextId, completed: 0 })` in
`replace`, `clone(state, [], { completed: 0 })` in `clear` — plus a comment on the upward repair
in `normalizeState`, which must never resurrect a reset counter. That repair only raises a count
to the number of marked rows it can see (a partial write used to be able to show `x` rows with
`done=0`), and a reset state has no rows at all, so the two rules cannot fight. Four tests were
rewritten and one added (§9.1, now 161).

**Wire evidence — `verify/wire-counter.jsonl`, 16 requests, 8 turns, 12/12 PASS.** The state
chain the model saw as its newest tool result, in order:

| # | result | what it proves |
| --- | --- | --- |
| 1 | `2 active, done=0` + a 150-char row | the items are accepted at the cap |
| 2 | `1 active, done=1` | `complete` marks and counts |
| 3 | `0 active, done=2` + both marked rows, newest first | the marks survive the last completion |
| 4 | `2 active, done=0`, new ids `t3`/`t4`, no marks | **`replace` resets the count** and does not reuse ids |
| 5 | `1 active, done=1` + `t3` marked | counting starts again inside the new plan |
| 6 | `0 active, done=0` | **`clear` resets the count and the rows** |
| 7 | `error=text too long (max 150 chars)` | the 151-character path still refuses, nothing written |
| 8 | `1 active, done=0` | the list keeps working after both resets |

`analyze.mjs` on that capture: tool definitions byte-identical (1 distinct), tool order stable
(19 tools), system prompt byte-identical (18 151 bytes), history append-only across all 15
consecutive pairs, `prompt_cache_key` and affinity headers untouched, no extra system message,
todo state only inside tool results, the reminder exactly once per request as the last message
(7 of 16), and its content tracking the list (5 distinct lines). The `done`-reset rows above are
the new part; every other check is the same suite that has passed since §9.14.

**Other evidence in this round.** `bun _evidence/bughunt/counter-reset.ts` drives the change
through the real store (not just `applyAction`): 10 steps, including a fresh instance re-reading
the same bytes, with `remove` on a marked row as the one action that keeps the count. The wide
seeded sweep was re-run after the change — 24 seeds × 4000 steps, 28 878 mutations applied,
**499 380 assertions, no invariant violated** — and the committed property test still holds
`completed >= marked`, which the new semantics preserve because only `complete` increments and
only `replace`/`clear` zero it, always together with the rows.

**Panel frames, re-captured on the shipped build** (`verify/drive-capture.mjs`, 200×50,
`--min-col=150`: every hit sits at column 160 in the sidebar rail):

| Frame | Assertions |
| --- | --- |
| new plan, nothing finished | `Focus 2 active`, `已提醒待办`, `t1:> implement storage`, and `active, done` **absent** (no suffix at `done=0`) |
| one done, one open | `Focus 1 active, done 1`, `已提醒待办`, `t1:x implement storage` |
| everything finished | `Focus: all done`, `未提醒`, the two marked rows newest first |
| **after a replan** | `Focus 2 active`, `已提醒待办`, `t3:> replan step`, `t4:- ordering probe`, and `t1:x`/`t2:x`/`active, done` **absent** — the counter-and-marks reset as a human sees it |
| after `clear` | `暂无待办`, `Focus`/`已提醒待办`/`未提醒`/rows all **absent** |
| tail is the tool result | `Focus 1 active`, `未提醒`, `已提醒待办` **absent** (the dedup guard) |

The frame session (`ses_counterround19cVw3gFNVxF2`, raw log
`_evidence/wire/wire-counter-frames.jsonl`) ran the same script as the canonical
capture; comparing the two logs shows the identical eight-state chain, plus extra `list` results
from two forced client kills (see the harness notes below).

**billion-context coexistence — measured, on this capture.** Every one of the 16 requests
carries billion-context's markers (`<acp tokens="…" type="text">` around system/user/assistant
content), so these requests were assembled *through* it, and the twelve checks above were
evaluated on that final body. All eight `focus_todo` tool results arrived **verbatim and
unwrapped**, and the reminder the plugin appends still landed as the last message content. The
plugin therefore needs no billion-context setting to work. The one setting that would make the
tool result itself compression-proof — `compress.protectedLatestTools: ["focus_todo"]` — is still
unset in the installed billion-context config (read-only measurement; not modified, §9.7).
**Honest limit:** in a 17 KB session billion-context compressed nothing, so *what happens at the
compression boundary* — the first time a session is large enough for its compressor to rewrite
old tool results — is **NOT VERIFIED** (§10.6). What is verified is everything up to that line.

**Cost, measured on the same capture** (`verify/cost-report.mjs`, new this round, reprints the
table from any capture):

| Piece | Measured | Bounded by |
| --- | --- | --- |
| `focus_todo` tool block | 1566 chars ≈ 392 tokens = 7.4 % of the 21 092-char tool surface | frozen; description 418 + schema 1046 |
| System prompt | 17 770 chars / 18 151 bytes, byte-identical | untouched by the plugin |
| Request-tail reminder | 7 of 16 requests carried one; largest 123 chars ≈ 31 tokens | `reminderBudget` 360 chars ≈ 90 tokens |
| Tool results | largest 195 chars ≈ 49 tokens | 16 open × 150 chars ≈ 2.7 KB when the model asks |
| Marked rows in results | ≤ 16 × 32 chars ≈ 128 chars | `MAX_DONE` × `DONE_TEXT_MAX` |
| Session state / panel | ≈ 3 KB per session in one storage key / 0 bytes to the model | both fixed |

**Harness notes, because they cost several attempts** (all in `_evidence/wire/frame.sh` now):
`MSYS_NO_PATHCONV=1 cmd.exe /c "<script.cmd>" "<message>"` is the invocation that works from Git
Bash — with that guard a `//c` stays literal and `cmd` opens an interactive shell instead; the
`run-capture-*.cmd` launcher needs a message argument; a hung run is killed by the PID holding
the socket to the provider (`netstat -ano` → `taskkill /F /PID`), and a kill makes the run
**retry**, which consumes the next script step — so a `hang` tail has to be planned for, and the
frame session's log legitimately contains the extra `list` requests that resulted. The TUI can
open a session while another client is hung on it (that is how the `未提醒` frame was captured).

### 9.19 Ninth round — the invitation loses its cap and its edge

**What the user asked for, in their words:** the reminder should not be rationed at all ("连续多
少轮没有做计划就可以提醒"), and the wording should stop sounding like an order ("语气也不用太强
烈，就是提醒可用这个工具记录就行"). The `staleAfter` rhythm already shipped was the right clock, so
this round is two deletions and one sentence rather than new machinery.

* **The cap is gone.** `creationNudgeMax` and the `creation` counter are deleted; the invitation
  is gated exactly like the maintenance clause — user turn start, `staleAfter` requests of list
  idleness, and a fired nudge resets the counter so two can never land in consecutive turns.
  Either form now repeats for as long as its situation lasts.
* **The tone is an offer.** The default line is
  `[focus_todo] no list yet — focus_todo is available if you want to record a plan` (76 chars,
  was 99 with "for a multi-step turn, record the plan with focus_todo(action=\"replace\")"). It
  names availability and never an action; a unit test asserts the word `replace` is absent from
  it, so a future reword cannot quietly turn it back into an instruction.
* **The retired key is inert, not repurposed.** A file that still says `creationNudgeMax: 0` no
  longer means "never invite" — `staleAfter: 0` is the switch that turns both nudges off. The
  key is tolerated like any other unknown (tested), and the shipped `~/.config/opencode/
  focus-todo.json` was updated in place: the stale key removed and the invitation text replaced,
  with the previous content kept at `_evidence/focus-todo.json.before-softening`.

**The measurement this needed a new harness for.** `opencode run` starts a fresh process per
invocation, so every captured turn start looks "unseen" and the cap could never be exercised
(§10.9). The answer was to type into one long-lived process: `verify/drive-chat.mjs` (new) drives
the drive-mode TUI — `ui.type` + `ui.enter`, then wait until the provider has logged another
agent request — so consecutive user turns accumulate in the same memory. `verify/wire-invite.jsonl`
is 24 such turns, and the invitation appears on **turns 1, 8, 15 and 22** with gaps of exactly 7
requests — four invitations, where the retired cap would have suppressed the fourth. All four
carry the same soft line, and no request carries a second reminder (the reset-on-fire guard still
holds: no two consecutive turns). `analyze.mjs` on that capture: 11 checks PASS, 2 `N/A`, ALL
PASS. The two that cannot apply — "state changes only inside tool results" and "the reminder
tracks the list" — are properties of a session *with* a list; the analyzer now reports them
`N/A` instead of `FAIL`, because a plan-less capture failing them made the summary lie about
everything else. The counter capture (`verify/wire-counter.jsonl`) still passes with no N/A.

**What that harness also exposed — the server half lives in the background service.** Setting
`FOCUS_TODO_STALE_AFTER=1` in the TUI launcher changed nothing: the observed spacing was 7
requests, exactly the deployed default `staleAfter: 6` plus one, which is only possible if the
hook that appended those lines was running in a process whose environment came from somewhere
else. It was: the TUI connects to OpenCode's background service, and the plugin's tool *and*
`context` hook run there, not in the TUI process (the TUI only renders the panel). Three
consequences worth keeping: the nudge memo is that service's memory and therefore survives
across TUI sessions; `FOCUS_TODO_*` overrides only apply where that service was started, which
is why the `run --standalone` captures could set them and the TUI capture could not; and a
plugin deploy is picked up by the service, which is how the new text reached the wire without a
restart. Two further harness facts: the bare `opencode` command has no `--model` flag, so the
TUI's model comes from the project's `opencode.json` (the capture project now pins
`fake/fake-model`; before that pin, two probe messages were submitted to a real provider, which
is recorded here rather than smoothed over), and `ui.enter` takes no parameters — the first
probe's `{}`-with-keys variants timed out for that reason.

**Cost of the change:** the invitation is 76 chars ≈ 19 tokens instead of 99 ≈ 25, and it is
sent on the `staleAfter` cadence rather than at most three times, so a plan-less session that is
left idle indefinitely draws roughly one line per `staleAfter` requests (≈3 tokens/request at
the default spacing) instead of going silent. That is the trade the user chose: a standing
invitation over a rationed one.

### 9.20 Tenth round — the panel's last empty case

The only state left where the panel could look broken: `0 active, done=N` **with no rows** —
reachable when every marked row is dropped one by one with `remove`, which never touches the
counter. `buildPanel` drew `Focus: all done` there, a header promising a list under an empty
body. The user asked for the count instead; it is a three-line change:

```ts
if (view.active === 0) {
  if (view.items.length > 0) return { header: "Focus: all done", status, rows: rowsOf(view.items) }
  return { header: clip(`Focus 0 active, done ${view.done}`, width), status, rows: [] }
}
```

The rows branch is unchanged, so "all done" still means "all done *and here they are*"; the new
branch draws the same string the tool result carries (`0 active, done=1`), so the panel stays a
projection rather than a special case. Two existing tests asserted the old header for a body with
no rows and were updated; one was added for the new branch (including that it clips to a narrow
sidebar: `Focus 0 a…`), and a tui-panel test now covers both the new line and the still-present
marked-rows variant. **163 unit tests pass**, `tsc` clean.

Wire and frame evidence (`verify/wire-orphan.jsonl`, session `ses_orphanframe19cVw3gFNVxF2`):
`replace [{only step}]` → `complete t1` → `remove t1` produced the results
`1 active, done=0 / t1:- only step`, `0 active, done=1 / t1:x only step` and finally
`0 active, done=1`. `analyze.mjs` on that capture: ALL PASS (both reminders present and distinct
— the invitation before the list existed, then `1 open: t1- only step — update it if it changed`).
The rendered sidebar on the shipped build: **`Focus 0 active, done 1`** at row 4 column 160,
`未提醒` at row 5, with `all done`, `t1:x` and `暂无待办` all confirmed **absent**.

### 9.21 Eleventh round — subagent silence, a sturdier turn-start test, compression protection on

An external review of the shipped plugin accepted its findings and asked for three changes.

**1. Subagent sessions are never nudged.** The invitation would otherwise open every
`explore`/`general` run — sessions too short-lived to be worth an invitation. The discriminator
is measured, not guessed (`_evidence/wire/.opencode/plugins/agentprobe.ts`, results in
`_evidence/wire/agent-probe.jsonl` and `agent-domain-probe.jsonl`):

| Probe run | hook payload `agent` | `agent.list()` entry |
| --- | --- | --- |
| `opencode run` (default) | string `"build"` | `{id:"build", mode:"primary", …}` |
| `--agent explore` | string `"explore"` | `{id:"explore", mode:"subagent", …}` |
| `--agent general` | string `"general"` | `{id:"general", mode:"subagent", …}` |
| `--agent plan` | string `"plan"` | — (primary) |

So: setup calls `context.agent.list()` once (shape `{location, data:[{id, mode}]}` — the same
wrapper as `model.list()`) and collects every id with `mode === "subagent"` into a set; the
hook hands the set to `injectTail`, which silences **both nudge forms** when
`payload.agent` is in it. Only a positive identification suppresses; a missing registry, a
failing `list()` or an unknown agent keep the previous behaviour (fail-soft, with a warn when
the domain exists but throws). The informative state line is untouched — a subagent that did
record a list still sees it. Custom agents with `mode: "subagent"` are covered for free
(host data, no hardcoded name list).

**2. Turn-start detection skips the plugin's own tail.** `startOfTurn` read
`messages[last].role`; a trailing message this plugin itself injected (id prefix
`focus-todo-`, request-scoped) is now skipped before the role is read, so a custom nudge text
without the `[focus_todo]` marker cannot read as a user turn. Honest scope: on this machine
billion-context registers its context hook **after** this plugin (load order measured in
`~/.local/share/opencode/log/opencode.log`: `focus-todo` at …881, `billion-context` at …902 in
run 0361cf60), so the tail this hook sees is host-assembled and the case cannot fire today;
the guard is future-proofing, and a foreign user-role tail from a plugin registered *before*
this one remains indistinguishable (no host-side marker — bili's sourcemap exposes no id
signature for its nudge push).

**3. `compress.protectedLatestTools` is now enabled** in the installed billion-context config
(`~/.config/billion-context/billion-context.json`): `["focus_todo"]` inside the `compress`
block, next to the existing `preserveRecentMessages: 2`. The key exists in billion-context
0.1.196 (1 occurrence in its dist). §9.7's "reported not changed" is superseded: the latest
`focus_todo` snapshot is now protected from compression, and the reminder regenerated from
storage remains the second, independent channel. **The compression boundary itself is still
NOT VERIFIED** (§10.6 unchanged — no local session has grown large enough to trigger a real
rewrite); what changed is that the newest snapshot no longer depends on that question.

**Wire verification** (fake provider, `_evidence/wire/probe-agent-wire.jsonl` lines 22+): the
`build` run's agent request carries `[focus_todo] no list yet — …` as the last message (wrapped
by billion-context's `<acp tokens="…">`, still landing last); the `explore` run's agent request
carries **no plugin text at all**. **167 unit tests pass** (4 new: subagent silence at the
`injectTail` level, the entrypoint wiring including a failing registry, and the tail-skip),
`tsc` clean, the seeded invariant sweep still 499 380 assertions / no violation.

Methodology notes that bit: opencode caches transpiled plugin files, so a rewritten probe ran
as its old version until the file name changed; `Bun.write(…, {append: true})` truncated rather
than appended in this host, which is why the probe writes one line per process; the WorkBuddy
PowerShell tool needs `Start-Process` **without** `-NoNewWindow` when redirecting opencode.exe
output, and its sandbox refuses `%TEMP%` paths (scratch files live in `_evidence/wire/`).


## 10. Known limitations

1. **The sidebar panel rests on an internal, undocumented API.** §6 — it works and is
   verified on 2.0.27 (§9.10), but the published `@opencode-ai/plugin` types describe a
   different shape (`sidebar_content`/`session_id` instead of `sidebar.content`/`sessionID`),
   so a future version can break the panel. It is written to fail soft: missing API → no
   panel, tool unaffected. Cross-version behaviour is **NOT VERIFIED**; only 2.0.27 is
   installed. There is also no native Todo panel to reuse (§3.1), so this panel displays the
   plugin's own state rather than any built-in list.
2. **The request-tail reminder rests on the same internal API as the panel.** §9.8 — it is
   measured on 2.0.27 (appended last, never persisted, prefix untouched) and it fails soft: if
   the hook or its payload shape changes, the reminder silently stops and the tool is
   unaffected. Two consequences worth stating: it costs at most one extra message per request,
   and it is never written to the session, so it cannot be seen in the transcript afterwards.
   The switch is the settings file (§9.11); the tool, the sidebar and the frozen description keep
   working exactly the same without it.
3. **No native-Todo integration.** Native todos cannot be written, so the plugin's list and
   `GET /session/{id}/todo` are unrelated stores; the plugin does not create a second
   sidebar or a second visible list.
4. **State is machine-local.** It lives in OpenCode's own store and is not portable or
   synchronised — by design.
5. **`aisdk.hook("language")` still unverified**, and no longer needed: the reminder uses the
   `session.hook("context")` path, which was proven at the wire level (§9.8). A documented
   transport-level hook would be a nicer home for it if a future version exposes one.
6. **Compaction boundary unverified** (§9.6). The reminder is designed to be immune —
   regenerated per request from state that lives outside the conversation — but "the reminder
   survives a real billion-context compression cycle" is inference, not a capture, because a
   compression could not be induced on this machine. The nearest measurement is §9.18: a
   16-request session ran end to end with billion-context in the path (its `<acp>` markers on
   every request) and every prefix check passed, but at 17 KB nothing was compressed yet.
7. **Install discipline is manual.** One copy only, and the global copy is a *copy*: after
   editing `src/focus-todo/`, re-copy it or OpenCode keeps loading the old bytes (§9.9).
8. **Published types are ahead of / behind the runtime.** Anything built on
   `@opencode-ai/plugin`'s published hook names must be re-verified against the binary.
9. **Nudge cadence is per process, not per session.** The `idle` memo lives in memory (nothing
   is written to the session store), so it resets when its process restarts. Which process that
   is was measured in §9.19: the tool and the hook run in OpenCode's **background service**, so a
   TUI session keeps one memo across turns and across sessions, while `opencode run` (private
   server per invocation) makes every first turn of an invocation look "unseen" — the invitation
   can therefore appear once per invocation rather than once per session. Persisting the memo
   would mean writing state on the request path, which the design deliberately avoids (§9.5).
10. **The panel's status line cannot see the nudge counters.** Two labels that were asked for
    (`已提醒更新待办`, `已提醒是否使用待办`) need server-half state, and the two plugin halves
    share no storage or data channel on 2.0.27 (§9.17). The panel therefore shows only what the
    session window proves (`已提醒待办` / `未提醒` / `暂无待办`). Anything further needs a bridge
    that does not exist yet — and would be built and verified as its own round, never faked.

---

## 11. Optimization backlog — what other agents do (surveyed 2026-10-13)

A read-only survey of how other agents carry a focus list, used to check this design and to
pick further optimizations. Sources are primary (repo files, docs, maintainer threads).

| Project | How the list reaches the model | Borrowable / warning |
| --- | --- | --- |
| Claude Code `TodoWrite` | Tool result is a static "modified successfully" string; the *list* is re-injected every 10 turns as a `todo_reminder` system-reminder block. | Its own tracker documents the anti-pattern: the reminder block "lives near the front of the conversation (in the cached prefix)" (anthropics/claude-code#68140), with user logs of 20 identical-hash updates and 16.7M tokens in 14 minutes. Our tail placement exists to avoid exactly this. |
| Codex CLI `update_plan` | Tool result is `"Plan updated"` (13 bytes); guidance lives in the base instructions: "Do not repeat the full contents of the plan after an `update_plan` call — the harness already displays it", "no more than 5-7 words each", "There should always be exactly one `in_progress` step". | Two ideas: item brevity as guidance, and a tiny acknowledgement instead of an echoed list. Disabled by default since 0.152.0. |
| Cline "focus chain" | `task_progress` parameter on **every** tool call + a reminder injected into the user turn every 6 messages. | Deprecated in 2026: "no longer providing enough additional benefit on top of the current harness". Known damage: the extra parameter leaked into MCP tool arguments and broke servers (#8256). Warning for us: never widen the tool surface for an attention feature. |
| Roo Code / Kilo Code | Todos re-injected every turn as a REMINDERS table in `<environment_details>`; whole-list replacement; `preventCompletionWithOpenTodos` blocks finishing with open items. | Kilo's cache lesson (#12666): a daily-changing date inside the system-prompt prefix cost ~74 000 tokens of cache ("297,257 characters were discarded") — the same class of mistake a dynamic system prompt would be. Kilo also states: "Kilo typically skips todo lists for simple tasks. The overhead isn't worth it." |
| Task Master (Claude MCP) | Tool surface is tiered: `all` = 36 tools ≈ 21 000 tokens, `core`/`lean` = 7 ≈ 5 000. | Quantifies why this plugin ships exactly one tool with a fixed description. |
| `opencode-todo-plugin` (npm) | Restores `todowrite`/`todoread` (V2 dropped the native names): cap 100 items × 500 chars, storage-backed, right sidebar list. | Closest sibling; its caps are about storage bloat, ours (16) about attention. Different tool name, so both can coexist. |
| `aiev/opencode-todolist`, `@falentio/opencode-todo` | Compact summary injected "at every user turn and whenever the list changes mid-run"; falentio adds an eager prelude (first turn only), a mid-run nudge after 12 mutating calls, and a stop-reminder when items are open. | Confirms the tail/summary channel is the family norm; falentio's gating (nudge every N calls) is the option we did **not** take — we prefer the tail reminder on every turn start plus the dedup guard. |
| `opencode-todo-reminder`, `opencode-cattleprod` | Inject by *submitting a user message* on `session.idle` via `client.session.prompt`. | Explicitly rejected here: those messages are persisted, so they grow the transcript and touch the cached prefix; our reminder is request-scoped. |
| OpenHands v0 `task_tracker` | Whole-list replace, `{id,title,status:todo\|in_progress\|done,notes}`, "Always `view` the current list before making changes"; removed in v1 in favour of sub-agents. | The `view`-first habit is what our description asks for (`list` on start/resume/restart). |
| aider | `--cache-prompts` orders the prompt: system, read-only files, repo map, then editable files. | Same principle as ours: put the volatile thing last. |
| Position research | Lost in the Middle (arXiv 2307.03172), multi-turn degradation (arXiv 2505.06120), context rot. | Recency is where attention is cheapest to win, which is the whole reason the reminder is a tail message. |

### Decisions taken from the survey

* **Keep** one tool, a frozen description, tail-only injection, storage outside the
  transcript. Every alternative above either touches the cached prefix, persists synthetic
  messages, or widens the tool surface — all measured or documented as harmful.
* **Done this round**: 16-item cap, JSON settings file, attention-ordered reminder with
  `+k more`, dedup guard, self-healing error text (§9.11).
* **Proposed, not implemented** (each needs its own verification before shipping):
  1. *Description trim + a "when not to use" clause.* Claude Code ("Skip using this tool when:
     there is only a single, straightforward task") and Kilo both carry one; ours did not.
     **Implemented** (§9.12): "skip the list for a single trivial step", paid for by deleting a
     redundant sentence — description 526 → 533 characters, schemas untouched, wire-verified.
  2. *Item brevity guidance.* Codex asks for "no more than 5-7 words each". **Implemented**
     (§9.12) in the same edit: "Keep each item to a few words" — shorter items mean shorter
     tool results and more items inside the reminder budget.
  3. *Compact mutation results.* Codex returns `Plan updated` and tells the model not to echo
     the plan; we return the whole list (≤16 × 150 chars, plus the marked rows). Not taken
     because the same string is what the sidebar panel parses and what a restarted session
     reads back from history; measured cost is bounded and small.
  4. *Quiet mode for long tool chains.* Skip the reminder when the list has not changed since
     the previous request in the session (needs a per-session memo in the hook). Trades
     attention for ~100–150 input tokens per request in tool-heavy runs. Default would stay
     "always remind"; the knob is only worth it if a real workload shows the tax matters.
  5. *Auto-demote instead of error* for a second `in_progress` (silently demote the previous
     one and say so). Cheaper for the model than a rejected call, but it weakens the "single
     focus" signal; the current error now names the offender, which is nearly as cheap.
  6. *Spontaneous-adoption A/B.* Measured for the "with the new clauses" side: **0 of 2**
     multi-step real-model probes called the tool unprompted (§9.13). The "before" side of the
     A/B was not run — the clauses are a wording change, not a nudge, so the more useful next
     experiment is the opposite one: give the tail reminder an imperative ("update the list if
     it changed") for one session and count calls. **Implemented** as the nudge (§9.15,
     tuneable since §9.16); the real-model probe with the imperative present still produced
     **0 of 3** unprompted calls, so the imperative keeps a live list current but does not by
     itself make this model start one.

### §9.22 — Panel always visible + foldable header (probe-verified, 2026-10-14)

Two user-facing changes, both driven by a real session where the empty panel read as
"the sidebar is missing".

**Finding first: the empty panel was never missing.** A fresh-session screenshot showed
`暂无待办` under the session title — that *is* this panel, rendering `buildPanel(undefined)`
as designed. What read as "missing" was (a) the empty state carrying no plugin identity and
(b) no affordance to fold it away. An earlier assessment wrongly claimed the panel does not
render before the first `focus_todo` call; the wire probes below refute that.

**Host API facts, established by a temporary file probe in `setup`/`render`/`memo**
(`focus-todo-tui-probe.log`, removed after diagnosis; the deployed copy went through the
same instrumentation):

- `ctx keys` on the real host: `options, location, app, renderer, client, data, attention,
  theme, themeMode, markdown, keymap, storage, ui`.
- `storage keys = store, memory`; `ui keys = dialog, toast, format, router, panel, tabs,
  model, slot`.
- `ui.slot({append|prepend: "sidebar.content", render})` registers fine under both position
  keys; `render` is invoked with `{sessionID}` once the session view is live. The shipped
  claim moves `prepend` → `append` to match every built-in panel.
- `storage.store(key, {initial})` is the host's UI-preference persistence — the built-in
  getting-started panel persists its dismiss flag through exactly this call, returning a
  `[state, setState]` pair whose state object is reactive. The fold flag rides here under
  `focus-todo.panel`; todo state never touches it.
- Probe hygiene learned the hard way: fire-and-forget `Bun.write` appends from the TUI
  process **lose lines on Windows** (concurrent opens → `EPERM` sharing violation, logged as
  unhandled rejections while looking like "code never ran"). The synchronous
  `process.getBuiltinModule("node:fs").appendFileSync` produced complete logs immediately.

**Fold design** (`tui.tsx`, mirroring the installed `opencode-visual-cache` UX): the header
line gains a `▼`/`▶` glyph and owns an `onMouseUp` toggle; the status and rows sit behind
`<Show when={fold.open()}>`; the header keeps the counts, so a folded panel still answers
"how far did the plan get". The glyph's two columns are paid for by clipping the header to
`width − 2`, keeping every line inside the row budget. Persistence degrades gracefully: if
`storage.store` is missing or returns anything other than the documented pair (shape checked
by `isFoldStorePair` in `view.ts`, unit-tested), the fold falls back to an in-memory signal
that merely resets on restart — a UI preference, so degradation is cosmetic by construction.

**Tests**: 167 → 172 (fold glyph/toggle/persistence ×3, store-pair shape ×2; all prior
render assertions updated for the glyph and the now-permanent empty state). `tsc --noEmit`
clean; deployed to the global directory verified by `diff -r`.
