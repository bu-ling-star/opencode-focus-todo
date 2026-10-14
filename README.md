# focus-todo

[English](README.md) | [中文](README.zh-CN.md)

A minimal OpenCode v2 plugin that keeps a small per-session focus checklist, so the agent
can recover its working state after a long task, a context compaction or a restart. It is
meant to be installed **once, globally**, so every session in every project has it.

One tool. One source of truth. Zero dependencies. One cache-safe reminder.

```
focus_todo(action="replace", items=[{text:"wire up storage", status:"in_progress"}, {text:"write tests"}])

3 active, done=0
t1:> wire up storage
t2:- write tests
```

The model also sees the open list on every request, as a one-line reminder appended after
everything else:

```
[focus_todo] 2 open: t1> wire up storage | t2- write tests
```

And a human sees the same list in the sidebar while the agent works — with the finished rows
kept and marked, and a line saying what the model was last told:

```
▼ Focus 2 active, done 1
已提醒待办
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
own storage. It is inert once the plugin is gone; leave it or let it age out with the
sessions it belongs to.

## Usage

One tool, one `action` union:

| action | Required fields | Effect |
| --- | --- | --- |
| `list` | — | Return open items and the finished count. Read-only. |
| `replace` | `items[]` | Overwrite the list with these items — a new plan starts clean, so the marked rows **and** the `done` count of the previous plan go with it. Each item: `{id?, text, status?}`. An empty list is the wipe. |
| `add` | `text` | Append one item (`status` defaults to `pending`). |
| `update` | `id` | Change `text` and/or `status`, and/or mark done with `done: true` — all in one call. |
| `remove` | `id` | Drop the item without counting it as done (and without un-counting it if it was already marked). |
| `batch` | `ops[]` | Apply 2–24 ops in order — any of `replace`/`add`/`update`/`remove` — all-or-nothing: one failing op rejects the whole batch and nothing is written. |

Rules the tool enforces, returning a short `error=…` line when violated:

* at most 16 open items;
* at most 150 characters per item;
* at most 16 marked rows kept per session — the oldest mark is dropped first, so `done` keeps
  counting past it;
* at most one item `in_progress` (marked rows no longer hold the slot);
* ids are short, stable and predictable per session (`t1`, `t2`, …) and are never reused, not
  even by a new plan;
* empty text, unknown status, duplicate id and unknown id are rejected explicitly.

Errors are written to be self-healing rather than just terminal: an unknown id names the ids
that do exist (`error=unknown id t7; open ids: t1 t2 t3`) and a second `in_progress` names the
item already running (`error=only one in_progress allowed (t1 is in_progress)`), so the model
can correct itself in the same turn instead of spending a round trip on `list`.

Statuses: `pending` (`-`), `in_progress` (`>`), `blocked` (`!`), and `x` for a marked row in
the tool result; the sidebar renders the same four states as `○ ▶ ! ✓` with theme colours. A
marked row is finished, not gone: the model keeps seeing it in every tool result, it stops
counting as open, and it is no longer sent in the reminder.

**A plan owns its marks and its count.** `update … done: true` marks a row and increments
`done`; both stay visible while that plan is alive, including after the last item finishes, so
the sidebar can show what just got done. Starting a new plan — `replace` with new items, or
with an empty list to wipe the slate — takes the marked rows *and* the `done` count with it:
`done` answers "how far did this plan get", not "how much did I ever do", so it never
accumulates across unrelated pieces of work. `remove <id>` is the one action that touches
neither: dropping a row is not un-completing it, so the count stays where it was.

A typical agent flow:

```
1. focus_todo { action: "replace", items: [{text:"read the spec"}, {text:"implement storage", status:"in_progress"}] }
2. …work…
3. focus_todo { action: "update", id: "t2", done: true }        → 1 active, done=1
4. focus_todo { action: "batch", ops: [                          → several edits, one round trip
     { action: "update", id: "t3", done: true },
     { action: "add", text: "handle corrupt state", status: "in_progress" } ] }
5. …the plan is done, the next one starts…       → focus_todo { action: "replace", items: [...] }  → done=0
```

After a restart or a compaction the agent calls `focus_todo { action: "list" }` and gets the
open items, the marked rows and `done=N` back.

## One request, end to end

```
OpenCode starts
  └─ scans plugin/ , loads one directory → two entrypoints
       server.ts : registers the focus_todo tool + one "context" hook
       tui.tsx   : claims the sidebar slot (read-only), nothing else

the model decides to record or read a plan
  └─ focus_todo { action, … }
       ├─ validate the input            → short `error=…` line if it is wrong
       ├─ read  focus-todo/session/<sessionID> from context.storage
       ├─ apply the action to the state (pure function, no I/O)
       ├─ write it back with revision + 1     (serialized per session: no interleaving)
       └─ return one compact text result: header + open rows + marked rows

every outbound request, after the host assembled it
  └─ the same "context" hook runs once
       ├─ read the state (one storage read)
       ├─ if nothing is open, or the newest message already is that tool result → append nothing
       ├─ otherwise append ONE line as the last message, never written back to the session
       └─ at a user turn start that has been stale for `staleAfter` requests, add the nudge

the sidebar (TUI process, separate from the model path)
  └─ reads the newest focus_todo result in the session window when it re-renders
       ├─ writes nothing, polls nothing, costs zero tokens
       └─ header + 已提醒待办 / 未提醒 + rows, or 暂无待办

a compaction or a restart
  └─ changes nothing: the state is in storage, the tool description is in the frozen prefix,
     and the reminder is regenerated from storage on the next request
```

Failure behaviour, in one line each: a failed storage read serves the request with a
`warn=state store unavailable` notice and an in-memory list; a failed write reports
`error=state store write failed`; a failed hook or a failed plugin load is logged and leaves
the request untouched — this plugin can never break a turn, only its own reminder.

## How the model keeps knowing

Three channels, in increasing order of intrusiveness — the third has a louder variant. Only the
third touches a request, and only at its very end.

1. **The tool description** — frozen text that tells the model to call
   `focus_todo(action="list")` when it starts or resumes work, after a compaction and after a
   restart, to record multi-step plans with `replace`, to skip the list for a single trivial
   step, and to keep each item to a few words. It is part of the tool definition, byte-identical
   on every request, and it is not conversation, so a compaction cannot remove it.
2. **Every tool result** — any `focus_todo` call returns the whole list, so the state is in
   the transcript right after each update.
3. **The request-tail reminder** — one line, appended as the *last* message of outbound
   requests, regenerated from storage every time:

   ```
   [focus_todo] 2 open, 1 done: t1> implement storage | t2- add tests
   ```

   The line is ordered by attention: the running item first, then `blocked` ones, then the
   rest in list order, and when the budget cannot fit everything it ends with `+k more`
   instead of silently dropping items:

   ```
   [focus_todo] 16 open: t1> implement storage | t2! waiting on review | t3- add tests | … | +8 more
   ```

   Two guards keep it from ever becoming noise. It is not appended when the newest message
   already shows the same state — that is, right after a `focus_todo` tool result, where the
   model has just read the list — and it is not appended twice if the plugin is ever loaded
   twice. Measured on the wire: with a 16-item list, 3 of 8 requests carried it, and the
   requests that did not were exactly the ones whose tail already was the todo result.

   The line carries **open items only**, and the header says how many are marked
   (`2 open, 1 done: …`). The marked rows themselves are deliberately not re-sent: the model
   needs to know what is left, while a human reading the sidebar wants to see what was already
   finished. Both come from the same state, rendered two ways.

4. **The nudge — the same line, occasionally mentioning the tool.** Two forms, both only at a
   *user turn start* (the moment a new instruction is read, and the only moment where a nudge
   is worth its tokens) and only when the list has been idle for `staleAfter` requests:

   * the state line gains a clause — `… | t3- update docs — automated reminder, update it if it changed`
     (the word *automated* tells the model the line is the plugin speaking, not the user — the
     reminder rides in as a user-role message, which models otherwise read as the user asking);
   * a session that has **no list at all** gets one line instead of a state:
     `[focus_todo] automated reminder — no list yet; focus_todo is available if you want to record a plan`.

   Both forms are silent in **subagent sessions**: the host's agent registry (`agent.list()`,
   entries with `mode: "subagent"` — `explore`, `general`, any custom subagent) is read once at
   setup, and those ids never hear either nudge, because their sessions are too short-lived to
   be worth an invitation. The informative reminder is unaffected, a failing registry keeps the
   previous behaviour, and an unknown agent is never guessed about.

   Neither is rationed. A session that keeps working without a list hears about the tool again
   every `staleAfter` requests, and the clause returns the same way while a list exists but is
   ignored — a fired nudge resets the counter, so two can never land in consecutive turns, but
   there is no lifetime cap on either. The invitation is worded as availability, not as an
   order: it never tells the model to call anything, because a session that wants no list is
   allowed to have none.

   Honest limit: a fresh nudge does **not** make `qwen3.8-flash` start a list on its own —
   three real-model probes, one of them with the invitation present, produced zero unprompted
   `focus_todo` calls, while the model happily uses the tool when asked.

### Settings

`~/.config/opencode/focus-todo.json` (or next to `server.ts`). Everything the plugin can be
asked to do differently lives here; the file carries all keys at their defaults, so it
documents itself:

```json
{
  "reminder": true,
  "reminderBudget": 360,
  "staleAfter": 10,
  "itemChars": 48,
  "maintenanceNudge": " — automated reminder, update it if it changed",
  "creationNudge": "[focus_todo] automated reminder — no list yet; focus_todo is available if you want to record a plan"
}
```

| Key | Default | Meaning | Clamp |
| --- | --- | --- | --- |
| `reminder` | `true` | Append the request-tail reminder at all. `false` also means the plugin never even opens the session domain. | — |
| `reminderBudget` | `360` | Upper bound for the generated state line, in characters. The nudge clause is subtracted from it, so the line yields rather than overrunning; a custom clause longer than the remaining room is used as written (your text is never clipped). | 80…2000 |
| `staleAfter` | `10` | Requests without list activity after which a user turn start also carries a nudge (both forms above). It is the only cadence the plugin has — both forms repeat on it indefinitely. `0` disables both and keeps the informative reminder. | 0…200 |
| `itemChars` | `48` | Characters kept per item in that one line, before the clipping `…`. | 16…200 |
| `maintenanceNudge` | `" — automated reminder, update it if it changed"` | The clause appended to the state line at a stale turn start. A leading space is kept, so the file controls the spacing. | ≤300 chars |
| `creationNudge` | the `automated reminder — no list yet …` line | The whole line for a session with no list. Worded as availability, and it never tells the model to call anything. | ≤300 chars |

Environment variables override the file for one-off runs: `FOCUS_TODO_REMINDER`,
`FOCUS_TODO_REMINDER_BUDGET`, `FOCUS_TODO_STALE_AFTER` and `FOCUS_TODO_ITEM_CHARS` (the two
texts are file-only — they are multi-line-ish prose, not switches).

A missing file, a wrong type, a broken value or broken JSON all fall back to the defaults,
per key: a typo can never configure the plugin into a broken state, and the clamps above are
re-checked in the unit tests.

### Why the reminder is cache-safe

* It is appended **after** everything else. Nothing in the request is reordered, rewritten or
  re-positioned, so the reusable prefix — system prompt, tool definitions, and every earlier
  message — keeps its exact bytes. Measured on recorded outbound requests: tool definitions
  byte-identical, system prompt byte-identical (18 151 bytes), and each request's shared
  prefix with the previous one is *all of it except the previous reminder*.
* It is never persisted: no synthetic message is written to the session, so the transcript
  stays append-only and nothing accumulates. Verified in the session store: 16 persisted
  messages, **0** containing the reminder text.
* It is rebuilt from storage on every request, which is exactly why a compaction cannot dull
  it: the reminder is not part of the compressible conversation, so the model is reminded
  again on the next request no matter what happened to the history.
* It costs nothing when there is nothing to say: a session with no open items gets **no**
  state line, and the line is bounded (`itemChars` per item, `reminderBudget` in total). The
  only message an empty session can draw is the invitation, and only on its `staleAfter`
  cadence.

### What it costs, measured

| Piece | Size | Paid |
| --- | --- | --- |
| Tool block (`name` + description + input schema) | 2804 chars ≈ 700 tokens | once per request, inside the cached prefix (cache read, not a write) |
| — of which the description | 522 chars ≈ 130 tokens | " |
| — of which the input schema | 2180 chars ≈ 545 tokens | " |
| Request-tail reminder | measured 123 chars ≈ 31 tokens at most in the 16-request capture; bounded by `reminderBudget` at 360 chars ≈ 90 tokens | per request, and only when something is open and the tail does not already show it (7 of 16 requests carried it) |
| Nudge clause (`— automated reminder, update it if it changed`) | +46 chars ≈ 12 tokens (counts against the same budget) | only at a stale user turn start |
| Nudge line (`automated reminder — no list yet …`) | 101 chars ≈ 25 tokens | on the `staleAfter` cadence, uncapped — an empty session that is idle draws it every `staleAfter` requests |
| Tool results (the list the model reads back) | measured 195 chars ≈ 49 tokens; worst case 16 open items ≈ 2.7 KB ≈ 675 tokens | only when the model itself calls the tool |
| Marked rows inside those results | ≤ 16 × 32 chars ≈ 128 chars ≈ 32 tokens | " |
| Session state in storage | ≤ 16 open + 16 marked ≈ 3 KB, one key per session | no tokens |
| Sidebar panel | 0 bytes | never reaches the model |

For scale: the 19 tools the host sends total 21 092 chars, so this plugin is **13 % of the
tool surface**; the system prompt is 17 770 chars / 18 151 bytes and is not touched. Two unit
tests hold the budget down: one caps the description and the schemas, the other fails if any of
the eight behavioural rules drops out of the description while it is being reworded.
`verify/cost-report.mjs` reprints this table from any capture, so the numbers stay honest
(see [Develop](#develop) for how to produce one).

## Sidebar panel

`tui.tsx` registers one read-only panel in the sidebar's content area:

| Session state | Panel |
| --- | --- |
| open items | `Focus N active[, done M]`, a status line, then every row — open items first, marked rows last and newest finish first (`✓ t3 read the spec`) |
| no open items, marked rows still there | `Focus: all done`, a status line, then the marked rows |
| no open items, every marked row removed (`remove`) | `Focus 0 active, done N` — the count is the truth, and `all done` over an empty body would read like a bug |
| no list yet, or after a `clear` — `0 active, done=0` | the single line `暂无待办` — no status line, because nothing was ever sent |

The status line is the panel's second row and says what this plugin last put in front of the
model, derived from the message window alone:

| Text | When |
| --- | --- |
| `已提醒待办` | the list has open items and the newest message is not the todo result — the next request carries the reminder |
| `未提醒` | the newest message already *is* the todo result (the reminder is suppressed for that request), or nothing is open |
| `暂无待办` (instead of a line) | no list at all |

The panel reports only what the session window can prove and invents no label it cannot back:
the server half's nudge counters are not visible to the TUI half (they live in separate
storage domains), so richer wording like "reminded *and* updated" is deliberately not
attempted. It reads the newest `focus_todo` tool result already present in the current
session's message window and renders it. It writes nothing, polls nothing, has no popups and
no settings, and it does not add a second list. Colours follow the active theme through the
host's flat `theme.current` palette (in-progress draws the success colour, blocked the error
colour, a marked row recedes to the muted text colour), and long lines are clipped to the
panel width, counted in display columns so CJK text lines up.

If a future OpenCode changes the internal TUI API, the panel turns inert and the tool keeps
working — the sidebar is never required for the tool to function.

## How it stays out of the way

* **Storage is OpenCode's own.** State goes through the official `context.storage` key/value
  domain, one key per session. No plugin JSON file, no database, no migrations.
* **Failure never blocks startup.** Setup is fully guarded per feature: a failing tool
  registration leaves the reminder and the panel intact, a failing hook costs only the
  reminder, unreadable state is reset with a warning, and mutations on one session are
  serialized so nothing is lost.
* **Coexists with billion-context.** It registers exactly one tool (`focus_todo`), never
  touches billion-context's tools, headers, prompts or state, and works normally with
  billion-context removed. The coexistence is measured, not assumed: on a recorded capture,
  **16 of 16** requests carry billion-context's `<acp tokens="…">` markers and all twelve
  cache-prefix checks pass, and the reminder still lands last inside billion-context's
  `<acp>` wrapper. One setting on the billion-context side makes the *list itself*
  compression-proof on top of that — `compress.protectedLatestTools: ["focus_todo"]` in
  billion-context's config protects the newest snapshot from a compression. The plugin works
  identically without it (the reminder is regenerated from storage on every request); adding
  the entry is recommended if you run billion-context with compression enabled.
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
bun test                       # 179 unit tests, incl. a seeded invariant sweep
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
node verify/drive-capture.mjs <sessionID> --min-col=150 "Focus 2 active" "已提醒待办" "!active, done"
node verify/drive-capture.mjs <sessionID> --min-col=150 "Focus: all done" "未提醒"
node verify/drive-capture.mjs <sessionID-after-a-clear> --min-col=150 "暂无待办" "!Focus" "!已提醒待办"
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
