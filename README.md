# focus-todo

[English](README.md) | [中文](README.zh-CN.md)

A minimal OpenCode v2 plugin that keeps a small per-session focus checklist, so the agent
can recover its working state after a long task, a context compaction or a restart. It is
meant to be installed **once, globally**, so every session in every project has it.

One tool. One source of truth. Zero dependencies. One cache-safe reminder.

```
focus_todo(action="replace", items=[{text:"wire up storage", status:"in_progress"}, {text:"write tests"}])

2 active, done=0
t1:> wire up storage
t2:- write tests
```

At the start of a user turn with open items, the model also sees the list as a one-line reminder appended after
everything else:

```
[focus_todo] 2 open: t1> wire up storage | t2- write tests
```

And a human sees the same list in the sidebar while the agent works — with finished rows kept
and marked:

```
▼ Focus 2 active, done 1
▶ t1 wire up storage
○ t2 write tests
✓ t3 read the spec
```

The panel is a permanent sidebar fixture: before the first `focus_todo` call it shows
`▼ 暂无待办` rather than disappearing. Clicking the header row (the `▼`/`▶` glyph) folds
the body away to just the header — which keeps the counts, so a folded panel still reads
"how far did the plan get". The folded flag persists across restarts through the host's
own UI-preference storage; if the host does not provide it, the fold still works and
merely resets on restart.

## Install (global, recommended)

Copy the plugin directory into OpenCode's config directory:

```bash
# Windows (Git Bash / PowerShell)                  # Linux / macOS
mkdir -p ~/.config/opencode/plugin                mkdir -p ~/.config/opencode/plugin
cp -R src/focus-todo ~/.config/opencode/plugin/focus-todo
```

The Windows path is `C:\Users\<you>\.config\opencode\plugin\focus-todo\`. No `opencode.json`
entry, no `npm install`, no build step: OpenCode scans `plugin/` **and** `plugins/` in that
directory at startup, takes each entry as one plugin, and resolves `server.ts` from it.

**Install exactly one copy.** The loader does not deduplicate by plugin id: a project copy
plus a global copy loads twice in that project, which means two `focus_todo` registrations
and two sidebar panels. Measured, not assumed.

Restart OpenCode (or open a new session) and every project has the tool. Verify from any
project:

```
opencode run --model <provider/model> "Call focus_todo with action=list and show the raw output."
```

### Per-project install

If you want it in one project only, copy the same directory to `<project>/.opencode/plugin/`
instead — and do not also install it globally, for the reason above.

## Uninstall

Delete the directory and restart OpenCode. Nothing else references it:

```bash
rm -r ~/.config/opencode/plugin/focus-todo
```

Per-session state stays behind as keys named `focus-todo/session/<sessionID>` in OpenCode's
own storage. The plugin removes that key when the host reports the session deleted
(`session.deleted`); a row left by a deletion that happened while the plugin was not
running is inert and harmless.

## Usage

One tool with three **public** actions:

| action | Required fields | Effect |
| --- | --- | --- |
| `list` | — | Read the current state. No write. |
| `replace` | `items[]` | Replace the whole plan; `[]` clears rows and resets `done`. A new plan starts clean. |
| `mutate` | `ops[]` | Apply 1–24 local `add`/`update`/`remove` operations in order, all-or-nothing. |

`update` with `done: true` marks a row as finished; it stays visible as `x` and increments
`done`. `remove` removes a row without changing the counter. The old `add`, `update`,
`remove`, `batch`, `complete` and `clear` envelopes remain accepted at runtime for
compatibility, but are intentionally absent from the public schema.

Rules enforced by the tool:

* at most `maxItems` open items (default 16) and `maxDone` retained done rows (default 10);
* at most 150 characters per item;
* at most one open item `in_progress`;
* ids are short, stable and never reused within a session;
* empty text, invalid status, duplicate id and unknown id are rejected explicitly;
* a failed `mutate` writes nothing and reports the failing op(s).

Statuses are `pending` (`-`), `in_progress` (`>`), `blocked` (`!`), and `x`
for a finished row. Finished rows appear in tool results and the sidebar, but never in the
request-tail reminder.

A typical flow:

```
1. focus_todo { action: "replace", items: [{text:"read spec"}, {text:"implement storage", status:"in_progress"}] }
2. …work…
3. focus_todo { action: "mutate", ops: [{action:"update", id:"t2", done:true}] }
4. focus_todo { action: "mutate", ops: [{action:"add", text:"handle corrupt state", status:"in_progress"}] }
5. next plan → focus_todo { action: "replace", items: [...] }
```

After a restart or compaction, call `focus_todo(action="list")` to recover the stored state.

## One request, end to end

```
OpenCode starts
  └─ loads server.ts → one focus_todo tool + one context hook
     loads tui.tsx    → one read-only sidebar panel

model calls focus_todo
  └─ validate → read storage → apply pure transition → serialized write → compact full-state result

outbound request reaches the context hook
  ├─ non-user/tool-chain tail: return immediately (default path does not read storage)
  ├─ user-turn tail: read the state once
  ├─ empty state or no open items: append nothing
  ├─ same user message id already handled: append nothing
  └─ otherwise append one open-only reminder as the last, request-scoped message

TUI
  └─ parses the newest focus_todo result and renders facts only; it writes no state
```

The reminder is never persisted and never changes the system prompt, tool definitions or earlier
messages. A failed storage read, hook or plugin setup only disables that part; it never breaks the
request. A mutation attempted while the store cannot be read is refused rather than written, so a
transient read failure cannot replace a list it never saw.

## How the model keeps knowing

Three channels reinforce focus. The request-tail reminder is enabled by default only when a session has open items:

1. **Tool description** — tells the model when to read or record a plan, while remaining part of the
   cacheable tool definition.
2. **Tool result** — every actual call returns the complete compact state.
3. **Request-tail reminder** — when a plan has open items, one short line is appended at the start
   of a user turn:

   ```
   [focus_todo] 2 open: t1> implement storage | t2- write tests
   ```

The reminder is open-only, ordered by attention, bounded by `reminderBudget`, and never persisted.
It is not appended during assistant/tool continuations. Ordinary user text containing
`[focus_todo]` cannot suppress it; suppression uses the plugin-generated tail id and the
user-message id, not arbitrary text matching.

`staleAfter: 0` is the shipped default: no maintenance nudge. The one thing an empty session
can still draw is the once-per-session invitation (`creationNudge`), which does not depend on
`staleAfter` — a session that never builds a list would otherwise never hear from the plugin at
all. Maintenance nudges, when explicitly enabled, occur only at user-turn starts, and both forms
are suppressed for positively identified subagents. This is an opt-in attention aid, not an
instruction to create a todo list.

### Settings

Optional config: `~/.config/opencode/focus-todo.json` (or next to `server.ts`). Defaults:

```json
{
  "reminder": true,
  "reminderBudget": 360,
  "staleAfter": 0,
  "maxItems": 16,
  "maxDone": 10,
  "stalledAfter": 0,
  "itemChars": 48,
  "maintenanceNudge": " — update if changed",
  "creationNudge": "[focus_todo] no list yet"
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `reminder` | `true` | Enable the request-tail reminder. `false` skips the session hook entirely. |
| `reminderBudget` | `360` | Maximum generated reminder length in characters. |
| `staleAfter` | `0` | Number of quiet hook calls before the optional maintenance nudge. `0` disables that nudge only; the once-per-session invitation is unconditional. |
| `maxItems` | `16` | Open-item cap (1–64). Raising it changes the tool schema, so it starts a new cache prefix. |
| `maxDone` | `10` | Retained done-row cap (0–50). |
| `stalledAfter` | `0` | Minutes an `in_progress` row may run before the reminder appends `(stalled)`. `0` disables the marker; the sidebar shows the age either way. |
| `itemChars` | `48` | Per-item clipping inside the reminder. |
| `maintenanceNudge` | ` — update if changed` | Optional short clause for an enabled maintenance nudge. |
| `creationNudge` | `[focus_todo] no list yet` | Line for the once-per-session invitation an empty session draws. |

The environment variables `FOCUS_TODO_REMINDER`, `FOCUS_TODO_REMINDER_BUDGET`,
`FOCUS_TODO_STALE_AFTER`, `FOCUS_TODO_ITEM_CHARS`, `FOCUS_TODO_MAX_ITEMS`,
`FOCUS_TODO_MAX_DONE` and `FOCUS_TODO_STALLED_AFTER` override file values for tests or
one-off runs. `FOCUS_TODO_DOCTOR=1` prints one diagnostic line per host surface the plugin
depends on at startup (tool transform, context hook, storage, agent registry, TUI storage).

### Why the reminder is cache-safe

* It is appended **after** everything else. Nothing in the request is reordered, rewritten or
  re-positioned, so the reusable prefix — system prompt, tool definitions, and every earlier
  message — keeps its exact bytes. Measured on recorded outbound requests: tool definitions
  byte-identical, system prompt byte-identical (18 151 bytes), and each request's shared
  prefix with the previous one is *all of it except the previous reminder*.
* It is never persisted: no synthetic message is written to the session, so the transcript
  stays append-only and nothing accumulates. Verified in the session store: 16 persisted
  messages, **0** containing the reminder text.
* When eligible, it is rebuilt from storage at the start of a user turn, which is why a compaction cannot dull
  it: the reminder is not part of the compressible conversation, so the model is reminded
  again on the next eligible user turn no matter what happened to the history.
* It costs nothing when there is nothing to say: a session with no open items gets **no**
  state line, and the line is bounded (`itemChars` per item, `reminderBudget` in total). The
  only message an empty session can draw is the once-per-session invitation.

### What it costs, measured

The fixed tool definition lives in the cacheable prefix. The reminder is the only per-request text
this plugin adds, and it is bounded by `reminderBudget`; with the default `staleAfter: 0`,
an empty session adds zero reminder tokens (its single invitation aside) and a working session
adds at most one short line at a user-turn start. Tool results are paid only when the model calls the tool. The sidebar is local UI
and costs no model tokens.

Use `verify/cost-report.mjs` against a real capture when you need exact provider/token numbers;
do not treat old capture-specific byte counts as product constants.

## Sidebar panel

The TUI registers one read-only panel:

| Session state | Panel |
| --- | --- |
| open items | `Focus N active[, done M][ · K running]`, open rows, then a collapsible `✓ M done` section |
| no open items, retained done rows | `Focus: all done`, then the done rows |
| no open items and no retained rows | `Focus 0 active, done N` |
| no list yet or after `replace(items: [])` | `暂无待办` |

A running row shows its age (`▶ t1 12m fix parser`) once a whole minute has passed. The done
section folds on its own by clicking its `✓ N done` row; clicking the header still folds the
whole panel. The newest done row is kept verbatim, the rest are counted by the header.

The panel intentionally has no “reminded / not reminded” status line. Reminder delivery belongs to
the request hook and cannot be truthfully reconstructed by the separate TUI process. The panel
prefers the structured `metadata.focus` on the newest completed `focus_todo` part and falls back
to parsing its text when an older result is all the window holds. It never writes todo state: its
two persisted UI values — the fold flags and a bounded per-session copy of the last view — go
through the host's own `storage.store`, so a restart does not blank the panel while the list is
still in storage. The cache is always replaced by a fresh result and is never read by the server
half.

## How it stays out of the way

* **Storage is OpenCode's own.** State goes through the official `context.storage` key/value
  domain, one key per session. No second plugin store, no database, no migrations. The sidebar's
  snapshot cache uses the host's own UI storage (`storage.store`) and is never read back by the
  server half.
* **Failure never blocks startup.** Setup is fully guarded per feature: a failing tool
  registration leaves the reminder and the panel intact, a failing hook costs only the
  reminder, unreadable state is reset with a warning, and a failed read or write makes the tool
  call fail loudly instead of returning a success-shaped error string (the sidebar then keeps
  its last view). Mutations on one session are serialized so nothing is lost.
* **Coexists with billion-context.** It registers exactly one tool (`focus_todo`), never
  touches billion-context's tools, headers, prompts, config or state, and works normally with
  billion-context removed. The plugin does not edit billion-context settings. If you run
  compression and want the latest todo snapshot retained as well, you may add
  `compress.protectedLatestTools: ["focus_todo"]` on the billion-context side; this is optional
  because the reminder is regenerated from storage on each eligible user turn. The coexistence
  is measured, not assumed: on a recorded capture, **16 of 16** requests carry billion-context's
  `<acp tokens="…">` markers and all twelve cache-prefix checks pass, and the reminder still
  lands last inside billion-context's `<acp>` wrapper.
* **Light.** Three files, no imports beyond the host's own virtual modules, no npm
  dependencies, no background work when a session is not using the tool.

## Develop

The repository keeps the **source** in `src/focus-todo/`; the installed copy under
`~/.config/opencode/plugin/focus-todo/` is what OpenCode loads. After editing the source,
copy it over again:

```bash
cp -R src/focus-todo/. ~/.config/opencode/plugin/focus-todo/
```

```bash
bun test                       # unit tests, incl. a seeded invariant sweep
bunx --bun tsc --noEmit        # strict type check, no node_modules needed
```

### Wire verification

`verify/` ships a small toolkit for verifying the plugin on the wire against a **fake,
scripted OpenAI-compatible provider** — no model cost, fully deterministic:

```bash
# terminal 1 — local recorder/provider on :45999, logs every outbound request body
node verify/fake-provider.mjs          # WIRE_LOG=<file> picks the capture file

# then point a test project's opencode.json at http://127.0.0.1:45999/v1
# and drive a session; afterwards:

node verify/analyze.mjs                # 12 cache-prefix + reminder-placement checks
WIRE_LOG=<capture> node verify/cost-report.mjs   # reprints the cost table above
```

Captures (`WIRE_LOG` files) are machine-local and git-ignored; regenerate your own.

### Headless-TUI capture

Re-check the sidebar in a real, headless TUI. `OPENCODE_DRIVE=1` makes OpenCode render
without a terminal and listen on `ws://127.0.0.1:40900`, and `verify/drive-capture.mjs`
asserts what is on screen:

```bash
# terminal 1 — launch the TUI headlessly (adjust the opencode path / project dir)
OPENCODE_DRIVE=1 <path-to-opencode> --session <sessionID>

# terminal 2 — assert the rendered frame
node verify/drive-capture.mjs <sessionID> --min-col=150 "Focus 2 active" "t1 wire up storage"
node verify/drive-capture.mjs <sessionID> --min-col=150 "Focus: all done"
node verify/drive-capture.mjs <sessionID-after-a-clear> --min-col=150 "暂无待办" "!Focus"
```

`--min-col` proves the text sits in the right-hand sidebar region rather than the transcript,
`!text` asserts absence (the empty-state cases), and the script prints the row/column of
everything it finds.

`opencode run` starts a fresh process per invocation, which hides anything that lives in
memory. `verify/drive-chat.mjs` types into the same headless TUI instead, so consecutive user
turns land in one process — that is how the nudge cadence was measured:

```bash
node verify/drive-chat.mjs --wire my-capture.jsonl --messages "one|two|three|four"
```

Two things worth knowing when reproducing: the bare `opencode` command has no `--model` flag,
so the TUI's model comes from the project's `opencode.json` (pin a fake model there so no
real provider can be reached), and the plugin's **server half runs in the background
service**, not in the TUI process — its environment comes from wherever that service was
started, not from the launcher.

## Layout

```
src/focus-todo/server.ts        the plugin: tool, storage binding, request-tail reminder, v2 entrypoint
src/focus-todo/tui.tsx          the read-only sidebar panel
src/focus-todo/view.ts          pure view logic shared by the panel and its tests
tests/focus-todo.test.ts        tool, storage, reminder and entrypoint tests
tests/focus-todo-view.test.ts   view logic tests (parsing, clipping, panel branches)
tests/tui-panel.test.ts         panel registration, cleanup and render tests
tests/focus-todo-invariants.test.ts  seeded random workloads against the state invariants
types/                          ambient test-runner, solid and JSX types so tsc needs no node_modules
tsconfig.json                   strict config
verify/                         wire-verification toolkit (fake provider, analyzers, headless-TUI drivers)
```

`src/focus-todo/` is self-contained: copy that one directory and the install is complete.

## Licence

MIT. No third-party code was copied into this plugin; other OpenCode plugins were consulted
for design conventions only. `verify/` is development scaffolding and is not part of the
installed plugin.
