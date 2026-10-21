/**
 * Unit tests for the focus-todo pure core, its persistence binding, and the
 * shape of the plugin entrypoint. Run with `bun test`.
 *
 * Everything here is offline: no OpenCode, no network, no billion-context.
 */

import { beforeEach, describe, expect, test } from "bun:test"

import focusTodoPlugin, {
  applyAction,
  compactReminder,
  createFocusTodo,
  emptyState,
  formatReminder,
  formatState,
  injectTail,
  INPUT_SCHEMA,
  KEY_PREFIX,
  MAX_ITEMS,
  MAX_BATCH_OPS,
  MAX_TEXT,
  normalizeState,
  OUTPUT_SCHEMA,
  DEFAULT_SETTINGS,
  loadSettings,
  resetHookRegistration,
  resolveSettings,
  userConfigPath,
  sessionKey,
  TOOL_DESCRIPTION,
  TOOL_NAME,
  type FocusTodo,
  type FocusTodoInput,
  type LegacyFocusTodoInput,
  type Storage,
  type TodoState,
  MAX_DONE,
  openItems,
} from "../src/focus-todo/server.ts"

const SESSION = "ses_f33236c3dfferUYpbu0fJCkh3K"

function memoryStorage(seed: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(seed))
  const storage: Storage = {
    async get(key) {
      return data.get(key)
    },
    async set(key, value) {
      data.set(key, value)
    },
  }
  return { data, storage }
}

function core(seed: Record<string, unknown> = {}) {
  const { data, storage } = memoryStorage(seed)
  const todo = createFocusTodo(storage, undefined)
  return { data, run: todo.run, todo, storage }
}

async function list(run: ReturnType<typeof createFocusTodo>["run"], sessionID = SESSION) {
  return run(sessionID, { action: "list" })
}

/**
 * Stands in for the v2 plugin context: a storage backend plus the `tool` domain
 * draft. The Proxy records every domain the plugin reaches for, which is how the
 * "no extra sidebar, no extra state" tests are able to assert anything.
 * `agents` optionally stands in for the host's agent registry (`agent.list()`
 * → `{location, data}`), probed shape: entries `{id, mode: "primary"|"subagent"}`.
 */
function fakeContext(
  options: {
    failGet?: boolean
    failTransform?: boolean
    failHook?: boolean
    failHookOnce?: boolean
    failEvent?: boolean
    failRemove?: boolean
    agents?: unknown[]
    failAgents?: boolean
  } = {},
) {
  const touched: string[] = []
  const added: Array<{ name: string; description: string; input: unknown; output: unknown; options: unknown }> = []
  const hooks: Array<{ name: string; callback: (payload: unknown) => Promise<void> | void }> = []
  const listeners: Array<(event: unknown) => Promise<void> | void> = []
  const removed: string[] = []
  const data = new Map<string, unknown>()
  let hookAttempts = 0

  const storage: Storage = {
    async get(key) {
      if (options.failGet) throw new Error("store down")
      return data.get(key)
    },
    async set(key, value) {
      data.set(key, value)
    },
    async remove(key) {
      if (options.failRemove) throw new Error("store down")
      data.delete(key)
      removed.push(key)
    },
  }

  const target = {
    storage,
    tool: {
      async transform(update: (draft: { add(tool: never): void }) => void) {
        if (options.failTransform) throw new Error("tool domain unavailable")
        update({
          add(tool: never) {
            added.push(tool)
          },
        })
      },
    },
    agent: {
      async list() {
        if (options.failAgents) throw new Error("agent registry unavailable")
        return { location: { directory: "test" }, data: options.agents ?? [] }
      },
    },
    session: {
      async hook(name: string, callback: (payload: unknown) => Promise<void> | void) {
        hookAttempts += 1
        if (options.failHook || (options.failHookOnce && hookAttempts === 1)) throw new Error("session domain unavailable")
        hooks.push({ name, callback })
      },
    },
    event: {
      async subscribe(callback: (event: unknown) => Promise<void> | void) {
        if (options.failEvent) throw new Error("event domain unavailable")
        listeners.push(callback)
      },
    },
  }

  const context = new Proxy(target, {
    get(object, property) {
      touched.push(String(property))
      return Reflect.get(object, property)
    },
  })

  return { context, touched, added, hooks, listeners, removed, data }
}

describe("applyAction", () => {
  test("add appends an item with a short predictable id and lists it", () => {
    const added = applyAction(emptyState(), { action: "add", text: "implement storage" })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    expect(added.state.items).toEqual([{ id: "t1", text: "implement storage", status: "pending" }])
    expect(added.state.nextId).toBe(2)
    expect(added.text).toContain("t1:- implement storage")
  })

  test("add honours an explicit status", () => {
    const added = applyAction(emptyState(), { action: "add", text: "work", status: "in_progress" })
    expect(added.ok && added.state.items[0]!.status).toBe("in_progress")
    expect(added.ok && added.text).toContain("t1:> work")
  })

  test("replace overwrites the list and keeps supplied ids", () => {
    const first = applyAction(emptyState(), { action: "add", text: "old" })
    if (!first.ok) throw new Error("setup failed")
    const replaced = applyAction(first.state, {
      action: "replace",
      items: [
        { id: "t1", text: "implement storage", status: "in_progress" },
        { text: "add tests" },
        { text: "ship", status: "blocked" },
      ],
    })
    expect(replaced.ok).toBe(true)
    if (!replaced.ok) return
    expect(replaced.state.items.map((item) => item.id)).toEqual(["t1", "t2", "t3"])
    expect(replaced.state.items.map((item) => item.status)).toEqual(["in_progress", "pending", "blocked"])
    expect(replaced.text).toContain("t3:! ship")
  })

  test("update changes text and status in place", () => {
    const added = applyAction(emptyState(), { action: "add", text: "draft" })
    if (!added.ok) throw new Error("setup failed")
    const updated = applyAction(added.state, { action: "update", id: "t1", text: "final", status: "blocked" })
    expect(updated.ok && updated.state.items[0]).toEqual({ id: "t1", text: "final", status: "blocked" })
  })

  test("update without any field is rejected", () => {
    const added = applyAction(emptyState(), { action: "add", text: "draft" })
    if (!added.ok) throw new Error("setup failed")
    expect(applyAction(added.state, { action: "update", id: "t1" })).toEqual({ ok: false, error: "nothing to update" })
  })

  test("update with done:true marks the item instead of deleting it, and advances the done counter", () => {
    const added = applyAction(emptyState(), { action: "add", text: "a" })
    if (!added.ok) throw new Error("setup failed")
    const completed = applyAction(added.state, { action: "update", id: "t1", done: true })
    expect(completed.ok && completed.state.items).toEqual([{ id: "t1", text: "a", status: "pending", done: true }])
    expect(completed.ok && completed.state.completed).toBe(1)
    // The model sees the count and a marked row, never the row's full text again.
    expect(completed.ok && completed.text).toBe("0 active, done=1\nt1:x a")

    // Marking twice is refused, naming what is still open.
    expect(applyAction(completed.ok ? completed.state : emptyState(), { action: "update", id: "t1", done: true })).toEqual({
      ok: false,
      error: "t1 is already done; open ids: none",
    })

    // `done` is not a toggle: only `true` is supported.
    const second = applyAction(emptyState(), { action: "add", text: "b" })
    if (!second.ok) throw new Error("setup failed")
    expect(applyAction(second.state, { action: "update", id: "t1", done: false } as unknown as FocusTodoInput)).toEqual({
      ok: false,
      error: "done only supports true",
    })
  })

  test("a marked item is not open: it is not the in_progress blocker and cannot be updated", () => {
    const seeded = applyAction(emptyState(), {
      action: "replace",
      items: [{ text: "running", status: "in_progress" }, { text: "later" }],
    })
    if (!seeded.ok) throw new Error("setup failed")
    const completed = applyAction(seeded.state, { action: "update", id: "t1", done: true })
    if (!completed.ok) throw new Error("mark failed")

    // t1 is marked, so a new in_progress is allowed even though t1 still says in_progress.
    expect(applyAction(completed.state, { action: "update", id: "t2", status: "in_progress" }).ok).toBe(true)
    expect(applyAction(completed.state, { action: "update", id: "t1", text: "z" })).toEqual({
      ok: false,
      error: "t1 is already done; open ids: t2",
    })
  })

  test("the marked rows are capped at the newest MAX_DONE and never counted as open", () => {
    let state = emptyState()
    for (let index = 0; index < MAX_DONE + 3; index += 1) {
      const added = applyAction(state, { action: "add", text: `task ${index}` })
      if (!added.ok) throw new Error("add failed")
      const completed = applyAction(added.state, { action: "update", id: `t${index + 1}`, done: true })
      if (!completed.ok) throw new Error("mark failed")
      state = completed.state
    }
    const marked = state.items.filter((item) => item.done === true)
    expect(marked).toHaveLength(MAX_DONE)
    // Newest finish first, oldest mark dropped: the three oldest (t1…t3) are gone.
    expect(marked[0]?.id).toBe(`t${MAX_DONE + 3}`)
    expect(marked[marked.length - 1]?.id).toBe("t4")
    expect(state.completed).toBe(MAX_DONE + 3)
    expect(openItems(state)).toHaveLength(0)
  })

  test("marked rows come last in the same order whether items were added or replaced", () => {
    // Both flows finish t2 last, so both must keep the newest marked row and count the rest.
    const added = applyAction(emptyState(), { action: "add", text: "first" })
    if (!added.ok) throw new Error("setup failed")
    const second = applyAction(added.state, { action: "add", text: "second" })
    if (!second.ok) throw new Error("setup failed")
    const addFlow = applyAction(second.state, { action: "update", id: "t1", done: true })
    if (!addFlow.ok) throw new Error("mark failed")
    const addFlowDone = applyAction(addFlow.state, { action: "update", id: "t2", done: true })
    if (!addFlowDone.ok) throw new Error("mark failed")

    const replaced = applyAction(emptyState(), {
      action: "replace",
      items: [{ text: "first" }, { text: "second" }],
    })
    if (!replaced.ok) throw new Error("setup failed")
    const replaceFlow = applyAction(replaced.state, { action: "update", id: "t1", done: true })
    if (!replaceFlow.ok) throw new Error("mark failed")
    const replaceFlowDone = applyAction(replaceFlow.state, { action: "update", id: "t2", done: true })
    if (!replaceFlowDone.ok) throw new Error("mark failed")

    expect(addFlowDone.text).toBe("0 active, done=2\nt2:x second\n+1 done")
    expect(replaceFlowDone.text).toBe(addFlowDone.text)
  })

  test("replace starts a clean plan: previous marks and the counter go with it", () => {
    const seeded = applyAction(emptyState(), {
      action: "replace",
      items: [{ text: "first", status: "in_progress" }, { text: "second" }],
    })
    if (!seeded.ok) throw new Error("setup failed")
    const completed = applyAction(seeded.state, { action: "update", id: "t1", done: true })
    if (!completed.ok) throw new Error("mark failed")
    expect(completed.ok && completed.text).toBe("1 active, done=1\nt2:- second\nt1:x first")

    const replanned = applyAction(completed.state, {
      action: "replace",
      items: [{ text: "replanned" }, { text: "and another" }],
    })
    // Neither the marks nor the count outlive the plan: `done` describes this list, not
    // the session. The id sequence is the one thing that keeps going (t3/t4, never reused).
    expect(replanned.ok && replanned.text).toBe("2 active, done=0\nt3:- replanned\nt4:- and another")
    expect(replanned.ok && replanned.state.completed).toBe(0)
    expect(replanned.ok && replanned.state.items.every((item) => item.done !== true)).toBe(true)
  })

  test("replace with an empty list clears the marks as well as the open items", () => {
    const added = applyAction(emptyState(), { action: "add", text: "first" })
    if (!added.ok) throw new Error("setup failed")
    const completed = applyAction(added.state, { action: "update", id: "t1", done: true })
    if (!completed.ok) throw new Error("setup failed")
    const careless = applyAction(completed.state, { action: "add", text: "b" })
    if (!careless.ok) throw new Error("setup failed")

    const emptied = applyAction(careless.state, { action: "replace", items: [] })
    expect(emptied.ok && emptied.state.items).toEqual([])
    expect(emptied.ok && emptied.state.completed).toBe(0)
    expect(emptied.ok && emptied.text).toBe("0 active, done=0")

    // A cleared session reads exactly like one that never used the tool: the panel falls
    // back to `暂无待办`, and the next plan starts its own count from zero — while the id
    // sequence keeps going (t3, never reused).
    expect(emptied.ok && emptied.state.nextId).toBe(3)
    const next = applyAction(emptied.ok ? emptied.state : emptyState(), { action: "add", text: "c" })
    expect(next.ok && next.text).toBe("1 active, done=0\nt3:- c")
  })

  test("remove drops the item without counting it as done", () => {
    const added = applyAction(emptyState(), { action: "add", text: "a" })
    if (!added.ok) throw new Error("setup failed")
    const removed = applyAction(added.state, { action: "remove", id: "t1" })
    expect(removed.ok && removed.state).toMatchObject({ items: [], completed: 0 })
  })

  test("remove can also drop a single marked row, without touching the counter", () => {
    const seeded = applyAction(emptyState(), {
      action: "replace",
      items: [{ text: "first" }, { text: "second" }],
    })
    if (!seeded.ok) throw new Error("setup failed")
    const completed = applyAction(seeded.state, { action: "update", id: "t1", done: true })
    if (!completed.ok) throw new Error("mark failed")

    const removed = applyAction(completed.state, { action: "remove", id: "t1" })
    expect(removed.ok && removed.state.items).toEqual([{ id: "t2", text: "second", status: "pending" }])
    expect(removed.ok && removed.text).toBe("1 active, done=1\nt2:- second")
    expect(removed.ok && removed.state.completed).toBe(1)
  })

  test("a cleared or replanned counter stays zero through the store round-trip", async () => {
    const { run } = core()
    await run(SESSION, { action: "replace", items: [{ text: "a" }, { text: "b" }] })
    await run(SESSION, { action: "update", id: "t1", done: true })
    expect(await run(SESSION, { action: "replace", items: [] })).toBe("0 active, done=0")
    // Reloading from the store must not "repair" the reset back: there are no marked rows
    // left to raise it to, which is exactly the case the upward repair must leave alone.
    expect(await list(run)).toBe("0 active, done=0")
    // And the reset survives a restart, where the store is read by a fresh instance.
    const { data, storage } = memoryStorage()
    const first = createFocusTodo(storage, undefined)
    await first.run(SESSION, { action: "replace", items: [{ text: "a" }] })
    await first.run(SESSION, { action: "update", id: "t1", done: true })
    await first.run(SESSION, { action: "replace", items: [{ text: "b" }] })
    const restarted = createFocusTodo(storage, undefined)
    expect(await list(restarted.run)).toBe("1 active, done=0\nt2:- b")
    expect(data.size).toBe(1)
  })

  test("list is read-only", () => {
    const state = emptyState()
    const outcome = applyAction(state, { action: "list" })
    expect(outcome.ok && outcome.write).toBe(false)
    expect(outcome.ok && outcome.state).toBe(state)
  })

  test("empty and whitespace-only text are rejected", () => {
    for (const text of ["", "   ", "\n\t "]) {
      const outcome = applyAction(emptyState(), { action: "add", text })
      expect(outcome).toEqual({ ok: false, error: "empty text" })
    }
  })

  test("text longer than the limit is rejected, exactly at the limit is accepted", () => {
    const tooLong = "x".repeat(MAX_TEXT + 1)
    expect(applyAction(emptyState(), { action: "add", text: tooLong })).toEqual({
      ok: false,
      error: `text too long (max ${MAX_TEXT} chars)`,
    })
    expect(applyAction(emptyState(), { action: "add", text: "x".repeat(MAX_TEXT) }).ok).toBe(true)
  })

  test("text is collapsed to a single line", () => {
    const outcome = applyAction(emptyState(), { action: "add", text: "  two\n\nlines  " })
    expect(outcome.ok && outcome.state.items[0]!.text).toBe("two lines")
  })

  test("the ninth open item is rejected", () => {
    let state = emptyState()
    for (let index = 0; index < MAX_ITEMS; index += 1) {
      const outcome = applyAction(state, { action: "add", text: `item ${index}` })
      if (!outcome.ok) throw new Error("setup failed")
      state = outcome.state
    }
    expect(applyAction(state, { action: "add", text: "one too many" })).toEqual({
      ok: false,
      error: `too many items (max ${MAX_ITEMS})`,
    })
    expect(
      applyAction(state, {
        action: "replace",
        items: Array.from({ length: MAX_ITEMS + 1 }, (_, index) => ({ text: `item ${index}` })),
      }),
    ).toEqual({ ok: false, error: `too many items (max ${MAX_ITEMS})` })
  })

  test("unknown ids are rejected for update and remove", () => {
    for (const action of ["update", "remove"] as const) {
      const input = action === "update" ? { action, id: "t9", done: true as const } : { action, id: "t9" }
      expect(applyAction(emptyState(), input as FocusTodoInput | LegacyFocusTodoInput)).toEqual({
        ok: false,
        error: "unknown id t9; nothing is open",
      })
    }
  })

  test("an unknown id names the open ids so the model can retry without a list call", () => {
    const seeded = applyAction(emptyState(), { action: "add", text: "keep" })
    if (!seeded.ok) throw new Error("setup failed")
    const second = applyAction(seeded.state, { action: "add", text: "and this" })
    if (!second.ok) throw new Error("setup failed")
    expect(applyAction(second.state, { action: "update", id: "t17", done: true })).toEqual({
      ok: false,
      error: "unknown id t17; open ids: t1 t2",
    })
  })

  test("invalid status values are rejected", () => {
    expect(applyAction(emptyState(), { action: "add", text: "a", status: "done" as never })).toEqual({
      ok: false,
      error: "invalid status (use pending|in_progress|blocked)",
    })
  })

  test("a second in_progress item is rejected, and the conflict is named", () => {
    const first = applyAction(emptyState(), { action: "add", text: "a", status: "in_progress" })
    if (!first.ok) throw new Error("setup failed")
    expect(applyAction(first.state, { action: "add", text: "b", status: "in_progress" })).toEqual({
      ok: false,
      error: "only one in_progress allowed (t1 is in_progress)",
    })
    expect(
      applyAction(first.state, {
        action: "replace",
        items: [
          { id: "t5", text: "a", status: "in_progress" },
          { id: "t6", text: "b", status: "in_progress" },
        ],
      }),
    ).toEqual({ ok: false, error: "only one in_progress allowed (t5 is in_progress)" })
  })

  test("duplicate ids inside replace are rejected", () => {
    expect(
      applyAction(emptyState(), {
        action: "replace",
        items: [
          { id: "t1", text: "a" },
          { id: "t1", text: "b" },
        ],
      }),
    ).toEqual({ ok: false, error: "duplicate id t1" })
  })

  test("unknown actions are rejected", () => {
    expect(applyAction(emptyState(), { action: "purge" } as never)).toEqual({
      ok: false,
      error: "unknown action (use list|replace|mutate)",
    })
  })

  test("todo content never leaks internal bookkeeping into the model-visible text", () => {
    const outcome = applyAction(emptyState(), { action: "add", text: "secret plan" })
    if (!outcome.ok) throw new Error("setup failed")
    expect(outcome.text).not.toContain("revision")
    expect(outcome.text).not.toContain("version")
    expect(outcome.text).not.toContain("nextId")
    expect(outcome.text).toBe("1 active, done=0\nt1:- secret plan")
  })

  test("batch applies ops in order and reports only the final state", () => {
    const outcome = applyAction(emptyState(), {
      action: "batch",
      ops: [
        { action: "add", text: "read the spec" },
        { action: "add", text: "implement storage", status: "in_progress" },
        { action: "add", text: "write tests" },
        { action: "update", id: "t1", done: true },
      ],
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // Same shape as any single mutation: the newest focus_todo result parse and
    // the reminder's dedup guard do not care how the state was reached.
    expect(outcome.text).toBe("2 active, done=1\nt2:> implement storage\nt3:- write tests\nt1:x read the spec")
    expect(outcome.write).toBe(true)
    expect(outcome.state.completed).toBe(1)
    expect(outcome.state.nextId).toBe(4)
  })

  test("mutate is the canonical atomic edit envelope", () => {
    const outcome = applyAction(emptyState(), {
      action: "mutate",
      ops: [
        { action: "add", text: "implement storage", status: "in_progress" },
        { action: "add", text: "write tests" },
        { action: "update", id: "t2", done: true },
      ],
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.text).toBe("1 active, done=1\nt1:> implement storage\nt2:x write tests")
  })

  test("mutate does not mix plan replacement into local ops", () => {
    const outcome = applyAction(emptyState(), {
      action: "mutate",
      ops: [{ action: "replace", items: [] } as never],
    })
    expect(outcome).toEqual({ ok: false, error: "mutate rejected, 1 of 1 ops failed: op 1: replace must be a top-level action" })
  })

  test("legacy complete and clear actions still map to canonical updates", () => {
    const added = applyAction(emptyState(), { action: "add", text: "x" })
    if (!added.ok) throw new Error("setup failed")
    const completed = applyAction(added.state, { action: "complete", id: "t1" })
    expect(completed.ok && completed.state.completed).toBe(1)
    if (!completed.ok) return
    const cleared = applyAction(completed.state, { action: "clear" })
    expect(cleared.ok && cleared.state.items).toEqual([])
  })

  test("batch is atomic: one bad op rejects the whole batch", () => {
    const seeded = applyAction(emptyState(), { action: "add", text: "already here" })
    if (!seeded.ok) throw new Error("setup failed")

    const outcome = applyAction(seeded.state, {
      action: "batch",
      ops: [
        { action: "add", text: "fine" },
        { action: "update", id: "t9", done: true }, // unknown id
      ],
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    // The failure names the op, the reason, and the ids that do exist — one retry
    // can fix everything without a separate list call. Later ops are evaluated on
    // the draft that earlier successful ops produced, so the ids listed here
    // include the one op 1 just added.
    expect(outcome.error).toBe("batch rejected, 1 of 2 ops failed: op 2: unknown id t9; open ids: t1 t2")
  })

  test("batch reports every failing op at once", () => {
    const outcome = applyAction(emptyState(), {
      action: "batch",
      ops: [
        { action: "update", id: "t7", done: true },
        "not an object" as never,
        { action: "replace", items: [] }, // fine, but the two failures still reject the batch
        { action: "update", id: "t1", text: "x" },
      ],
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toContain("3 of 4 ops failed")
    expect(outcome.error).toContain("op 1: unknown id t7")
    expect(outcome.error).toContain("op 2: must be an object")
    expect(outcome.error).toContain("op 4: unknown id t1")
  })

  test("batch error lists are capped at four with a counted remainder", () => {
    const ops = Array.from({ length: 6 }, () => ({ action: "update" as const, id: "t9", done: true as const }))
    const outcome = applyAction(emptyState(), { action: "batch", ops })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toContain("6 of 6 ops failed")
    expect(outcome.error).toContain("+2 more")
  })

  test("batch validates its own envelope", () => {
    expect(applyAction(emptyState(), { action: "batch" } as never)).toEqual({ ok: false, error: "ops must be an array" })
    expect(applyAction(emptyState(), { action: "batch", ops: [] })).toEqual({ ok: false, error: "ops is empty" })
    expect(
      applyAction(emptyState(), { action: "batch", ops: Array.from({ length: MAX_BATCH_OPS + 1 }, () => ({ action: "add", text: "x" })) }),
    ).toEqual({
      ok: false,
      error: "too many ops (max 24)",
    })
  })

  test("batch rejects nested batches and list ops with a reason, not a crash", () => {
    const outcome = applyAction(emptyState(), {
      action: "batch",
      ops: [
        { action: "list" } as never,
        { action: "batch", ops: [] } as never,
      ],
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toContain("op 1: list is pointless inside a batch")
    expect(outcome.error).toContain("op 2: nested batch not allowed")
  })

  test("batch ops face the same caps as single calls", () => {
    const outcome = applyAction(emptyState(), {
      action: "batch",
      ops: [{ action: "replace", items: Array.from({ length: MAX_ITEMS + 1 }, (_, i) => ({ text: `x${i}` })) }],
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toContain("op 1: too many items (max 16)")
  })
})

describe("normalizeState", () => {
  test("absent state is empty and not corrupt", () => {
    expect(normalizeState(undefined)).toEqual({ state: emptyState(), corrupt: false })
    expect(normalizeState(null)).toEqual({ state: emptyState(), corrupt: false })
  })

  test("unrecognised shapes are reported as corrupt", () => {
    for (const raw of ["junk", 42, [], { version: 2, items: [] }, { version: 1, items: "no" }, {}]) {
      const result = normalizeState(raw)
      expect(result.corrupt).toBe(true)
      expect(result.state).toEqual(emptyState())
    }
  })

  test("a malformed item makes the whole value corrupt", () => {
    const result = normalizeState({ version: 1, items: [{ id: "t1", text: "a", status: "whenever" }] })
    expect(result.corrupt).toBe(true)
  })

  test("stored whitespace is normalised so one item stays one row", () => {
    // The write path collapses whitespace (`cleanText`) but the read path used to keep it:
    // a stored newline then produced a two-line result, split the reminder line in two and
    // left the panel unable to parse its own dump (`parseFocusState` → undefined).
    const result = normalizeState({
      version: 1,
      items: [{ id: "t1", text: "  line one\n\tline two  ", status: "pending" }],
    })
    expect(result.corrupt).toBe(false)
    expect(result.state.items[0]?.text).toBe("line one line two")
    expect(formatState(result.state)).toBe("1 active, done=0\nt1:- line one line two")
    expect(formatReminder(result.state)).toBe("[focus_todo] 1 open: t1- line one line two")
  })

  test("text that is only whitespace is corrupt, not an empty row", () => {
    const result = normalizeState({ version: 1, items: [{ id: "t1", text: "   \n\t ", status: "pending" }] })
    expect(result.corrupt).toBe(true)
    expect(result.state).toEqual(emptyState())
  })

  test("invariant violations are repaired instead of discarded", () => {
    const result = normalizeState({
      version: 1,
      revision: 4,
      completed: 2,
      nextId: 3,
      items: [
        { id: "t1", text: "a", status: "in_progress" },
        { id: "t2", text: "b", status: "in_progress" },
        ...Array.from({ length: MAX_ITEMS }, (_, index) => ({ id: `x${index}`, text: "filler", status: "pending" })),
      ],
    })
    expect(result.corrupt).toBe(false)
    expect(result.state.items.length).toBe(MAX_ITEMS)
    expect(result.state.items.filter((item) => item.status === "in_progress").length).toBe(1)
    expect(result.state.completed).toBe(2)
    expect(result.state.revision).toBe(4)
  })

  test("nextId is pushed past any existing synthetic id", () => {
    const result = normalizeState({
      version: 1,
      revision: 0,
      completed: 0,
      nextId: 1,
      items: [{ id: "t7", text: "a", status: "pending" }],
    })
    expect(result.state.nextId).toBe(8)
  })

  test("a counter behind its own marked rows is repaired upward, never downward", () => {
    // A store written without the counter (or with a stale one) must not render as
    // `done=0` while showing `x` rows — and must not lose history it does carry.
    const missing = normalizeState({
      version: 1,
      revision: 1,
      nextId: 4,
      items: [
        { id: "t1", text: "a", status: "pending", done: true },
        { id: "t2", text: "b", status: "pending", done: true },
        { id: "t3", text: "c", status: "pending" },
      ],
    })
    expect(missing.state.completed).toBe(2)

    const behind = normalizeState({
      version: 1,
      revision: 1,
      completed: 1,
      nextId: 4,
      items: [{ id: "t1", text: "a", status: "pending", done: true }],
    })
    expect(behind.state.completed).toBe(1)

    const ahead = normalizeState({
      version: 1,
      revision: 1,
      completed: 9,
      nextId: 4,
      items: [{ id: "t1", text: "a", status: "pending", done: true }],
    })
    // Nine completions happened in this session's life; the cap only dropped old rows.
    expect(ahead.state.completed).toBe(9)
  })
})

describe("sessionKey", () => {
  test("accepts real opencode session ids inside the plugin namespace", () => {
    expect(sessionKey(SESSION)).toBe(`${KEY_PREFIX}${SESSION}`)
  })

  test("rejects anything that could traverse or escape the namespace", () => {
    for (const candidate of ["../../etc/passwd", "a/b", "a\\b", "..", "", "   ", "a".repeat(129), "a b", "a*b", null, 7, {}]) {
      expect(sessionKey(candidate)).toBeUndefined()
    }
  })

  test("the key never contains a path separator", () => {
    const key = sessionKey(SESSION)!
    expect(key.startsWith(KEY_PREFIX)).toBe(true)
    expect(key).not.toContain("/..")
    expect(key).not.toContain("\\")
    expect(key.split("/")).toEqual(["focus-todo", "session", SESSION])
  })
})

describe("formatState", () => {
  test("is stable, ordered and compact", () => {
    expect(formatState(emptyState())).toBe("0 active, done=0")
    const state: TodoState = {
      version: 1,
      revision: 0,
      completed: 2,
      nextId: 4,
      items: [
        { id: "t1", text: "implement storage", status: "in_progress" },
        { id: "t2", text: "add tests", status: "pending" },
        { id: "t3", text: "API unavailable", status: "blocked" },
      ],
    }
    expect(formatState(state)).toBe("3 active, done=2\nt1:> implement storage\nt2:- add tests\nt3:! API unavailable")
  })
})

describe("structured result and timing", () => {
  test("runDetailed returns the state the panel reads, not just the text", async () => {
    const { todo } = core()
    const result = await todo.runDetailed(SESSION, {
      action: "replace",
      items: [
        { text: "implement storage", status: "in_progress" },
        { text: "add tests" },
      ],
    })

    expect(result.text).toBe("2 active, done=0\nt1:> implement storage\nt2:- add tests")
    expect(result.meta.version).toBe(1)
    expect(result.meta.revision).toBe(1)
    expect(result.meta.active).toBe(2)
    expect(result.meta.completed).toBe(0)
    expect(result.meta.items).toEqual([
      { id: "t1", text: "implement storage", status: "in_progress", done: false, startedAt: result.meta.items[0]!.startedAt },
      { id: "t2", text: "add tests", status: "pending", done: false },
    ])
    expect(typeof result.meta.items[0]!.startedAt).toBe("number")
  })

  test("startedAt is stamped on entry, kept while running, and cleared on leave or done", async () => {
    const { todo, data } = core()
    const key = `${KEY_PREFIX}${SESSION}`
    await todo.run(SESSION, { action: "replace", items: [{ text: "work", status: "in_progress" }] })
    const first = data.get(key) as TodoState
    const stamp = first.items[0]!.startedAt
    expect(typeof stamp).toBe("number")

    // Editing the text while it stays in_progress must not reset the clock.
    await todo.run(SESSION, { action: "update", id: "t1", text: "work more" })
    expect((data.get(key) as TodoState).items[0]!.startedAt).toBe(stamp)

    // Leaving in_progress drops it; returning gets a fresh stamp.
    await todo.run(SESSION, { action: "update", id: "t1", status: "pending" })
    expect((data.get(key) as TodoState).items[0]!.startedAt).toBeUndefined()
    await todo.run(SESSION, { action: "update", id: "t1", status: "in_progress" })
    const restarted = (data.get(key) as TodoState).items[0]!.startedAt
    expect(typeof restarted).toBe("number")
    expect(restarted!).toBeGreaterThanOrEqual(stamp!)

    // Marking it done clears it, because done rows have no running clock.
    await todo.run(SESSION, { action: "update", id: "t1", done: true })
    expect((data.get(key) as TodoState).items[0]!.startedAt).toBeUndefined()
  })

  test("stalledAfter appends (stalled) only past the threshold", () => {
    const seeded = applyAction(
      emptyState(),
      { action: "replace", items: [{ text: "fix parser", status: "in_progress" }] },
      { now: 1_000_000 },
    )
    if (!seeded.ok) throw new Error("seed failed")
    const state = seeded.state
    expect(formatReminder(state, 360, 48, { now: 1_000_000 + 4 * 60_000, stalledAfter: 5 })).toBe(
      "[focus_todo] 1 open: t1> fix parser",
    )
    expect(formatReminder(state, 360, 48, { now: 1_000_000 + 6 * 60_000, stalledAfter: 5 })).toBe(
      "[focus_todo] 1 open: t1> fix parser (stalled)",
    )
    // Off by default, and the compact line carries the marker too.
    expect(formatReminder(state, 360, 48, { now: 1_000_000 + 6 * 60_000 })).toBe(
      "[focus_todo] 1 open: t1> fix parser",
    )
    expect(compactReminder(state, 360, 48, { now: 1_000_000 + 6 * 60_000, stalledAfter: 5 })).toContain("(stalled)")
  })

  test("configured caps replace the defaults", async () => {
    const { storage } = memoryStorage()
    const todo = createFocusTodo(storage, undefined, { items: 2, done: 1 })

    await todo.run(SESSION, { action: "add", text: "one" })
    await todo.run(SESSION, { action: "add", text: "two" })
    await expect(todo.run(SESSION, { action: "add", text: "three" })).rejects.toThrow("too many items (max 2)")

    // A three-row plan is refused with the configured bound, not the shipped 16.
    const over = await todo.runDetailed(SESSION, { action: "replace", items: [{ text: "a" }, { text: "b" }, { text: "c" }] })
      .catch((error: Error) => error)
    expect(String(over)).toContain("too many items (max 2)")

    // Marking both open rows keeps only the configured number of marked rows.
    await todo.run(SESSION, { action: "update", id: "t1", done: true })
    await todo.run(SESSION, { action: "update", id: "t2", done: true })
    const result = await todo.runDetailed(SESSION, { action: "list" })
    expect(result.meta.completed).toBe(2)
    expect(result.meta.items.filter((item) => item.done)).toHaveLength(1)
  })
})

describe("createFocusTodo persistence", () => {
  test("state survives a restart (a fresh instance over the same store)", async () => {
    const { data, storage } = memoryStorage()
    const before = createFocusTodo(storage, undefined)
    await before.run(SESSION, { action: "add", text: "keep me" })

    const after = createFocusTodo(storage, undefined)
    expect(await list(after.run)).toContain("t1:- keep me")
    expect(data.size).toBe(1)
  })

  test("sessions are isolated from each other", async () => {
    const { run } = core()
    const other = "ses_00d0c8862ffey0bmKZOEEHikKm"
    await run(SESSION, { action: "add", text: "mine" })
    expect(await list(run, other)).toBe("0 active, done=0")
    expect(await list(run)).toContain("t1:- mine")
  })

  test("revision advances on writes and is never exposed to the model", async () => {
    const { data, run } = core()
    await run(SESSION, { action: "add", text: "a" })
    expect((data.get(`${KEY_PREFIX}${SESSION}`) as TodoState).revision).toBe(1)
    await run(SESSION, { action: "add", text: "b" })
    expect((data.get(`${KEY_PREFIX}${SESSION}`) as TodoState).revision).toBe(2)
    await list(run)
    expect((data.get(`${KEY_PREFIX}${SESSION}`) as TodoState).revision).toBe(2)
    expect(await list(run)).not.toContain("revision")
  })

  test("invalid session ids are rejected and touch nothing", async () => {
    const { data, run } = core()
    await expect(run("../evil", { action: "add", text: "x" })).rejects.toThrow("invalid session id")
    expect(data.size).toBe(0)
  })

  test("corrupt stored state is reset with a warning instead of crashing", async () => {
    const key = `${KEY_PREFIX}${SESSION}`
    const { run } = core({ [key]: "{not json at all" })
    const first = await run(SESSION, { action: "list" })
    expect(first.startsWith("warn=stored state was unreadable")).toBe(true)
    expect(first).toContain("0 active, done=0")
    expect(await run(SESSION, { action: "add", text: "recovered" })).toContain("t1:- recovered")
  })

  test("a failing store throws instead of returning a success-shaped string", async () => {
    const broken: Storage = {
      async get() {
        throw new Error("db gone")
      },
      async set() {
        throw new Error("db gone")
      },
    }
    const run = createFocusTodo(broken, undefined).run
    // The host marks a thrown call red; the panel treats a non-completed part as
    // "no new data" and keeps its last view, which is the correct degradation.
    await expect(run(SESSION, { action: "list" })).rejects.toThrow("state store unavailable")
    await expect(run(SESSION, { action: "add", text: "x" })).rejects.toThrow("state store unavailable")
  })

  test("a failed read never overwrites the stored list", async () => {
    const data = new Map<string, unknown>()
    const key = `${KEY_PREFIX}${SESSION}`
    let down = false
    const storage: Storage = {
      async get(k) {
        if (down) throw new Error("db busy")
        return data.get(k)
      },
      async set(k, v) {
        data.set(k, v)
      },
    }
    const run = createFocusTodo(storage, undefined).run
    await run(SESSION, { action: "add", text: "read the spec" })
    await run(SESSION, { action: "add", text: "wire up storage" })
    const before = JSON.stringify(data.get(key))

    // The read fails, so the plugin holds an empty state; writing it back would replace a
    // list it never saw with a single row. The call now throws, so the host sees a failure
    // instead of a success-shaped result with an error string inside.
    down = true
    await expect(run(SESSION, { action: "add", text: "ghost" })).rejects.toThrow("state store unavailable")
    expect(JSON.stringify(data.get(key))).toBe(before)

    down = false
    expect(await list(run)).toContain("2 active, done=0")
  })

  test("concurrent mutations on one session all land", async () => {
    const { run } = core()
    const results = await Promise.all(
      Array.from({ length: MAX_ITEMS }, (_, index) => run(SESSION, { action: "add", text: `task ${index}` })),
    )
    expect(results.every((result) => !result.startsWith("error="))).toBe(true)
    const listed = await list(run)
    expect(listed.split("\n").length).toBe(MAX_ITEMS + 1)
    for (let index = 0; index < MAX_ITEMS; index += 1) expect(listed).toContain(`task ${index}`)
  })

  test("concurrent mutations on different sessions do not interleave", async () => {
    const { run } = core()
    const sessions = Array.from({ length: 6 }, (_, index) => `ses_concurrent${index}`)
    await Promise.all(sessions.map((session, index) => run(session, { action: "add", text: `only ${index}` })))
    for (const [index, session] of sessions.entries()) {
      const listed = await list(run, session)
      expect(listed).toBe(`1 active, done=0\nt1:- only ${index}`)
    }
  })

  test("the serialization map does not grow without bound", async () => {
    const { data, storage } = memoryStorage()
    const todo = createFocusTodo(storage, undefined)
    for (let index = 0; index < 50; index += 1) await todo.run(`ses_burst${index}`, { action: "add", text: "x" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(data.size).toBe(50)
    expect(todo.pendingSessions()).toBe(0)
  })
})

describe("plugin entrypoint", () => {
  const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process!.env

  beforeEach(() => {
    resetHookRegistration()
    // Point the settings lookup at a directory that does not exist, so a real
    // ~/.config/opencode/focus-todo.json on the machine can never change what
    // these tests observe (it did once: a verification file with the invitation
    // silenced silently disabled it here, back when a key could do that).
    env["XDG_CONFIG_HOME"] = "C:\\focus-todo-tests-no-config"
    // The two pins below then only spell out the intended shipped defaults.
    env["FOCUS_TODO_REMINDER"] = "1"
    env["FOCUS_TODO_STALE_AFTER"] = "0"
  })

  test("the description stays small and keeps every rule it carries", () => {
    // Size budget: the description is part of the cached prefix and is re-sent on
    // every request of every session, so growth is a product decision, not a
    // side effect of a rewording. The batch rule added ~105 characters — paid
    // once per request inside the cache, and repaid by every avoided round trip.
    expect(TOOL_DESCRIPTION.length).toBeLessThanOrEqual(540)

    // Rule coverage, one marker per rule. Rewording is fine; losing a rule is not.
    expect(TOOL_DESCRIPTION).toContain('action="list"') // the resume call
    expect(TOOL_DESCRIPTION).toContain("compaction")
    expect(TOOL_DESCRIPTION).toContain("restart")
    expect(TOOL_DESCRIPTION).toContain('action="replace"') // record multi-step plans
    expect(TOOL_DESCRIPTION).toContain("trivial") // and skip the list for trivial ones
    expect(TOOL_DESCRIPTION).toContain("short") // item brevity
    expect(TOOL_DESCRIPTION).toContain("in_progress")
    expect(TOOL_DESCRIPTION).toContain('action="mutate"') // one call, not repeated edits
    expect(TOOL_DESCRIPTION).toContain("3+ steps")
    expect(TOOL_DESCRIPTION).toContain("before work")
    expect(TOOL_DESCRIPTION).toContain("after verification")
    expect(TOOL_DESCRIPTION).toContain("partial, blocked, or failing")
  })

  test("the schemas stay small too: they are the other half of the cached prefix", () => {
    // The ops definition repeats the replace-item shape, which is what the batch
    // buys: one call for a whole reshuffle instead of one call per edit. Folding
    // `complete` into `update` (done:true) and `clear` into `replace` (empty list)
    // removed two enum values and added the `done` flag, netting ~+130 characters —
    // paid once inside the cache, repaid by two fewer actions for the model to pick.
    expect(JSON.stringify(INPUT_SCHEMA).length).toBeLessThanOrEqual(2200)
    expect(JSON.stringify(OUTPUT_SCHEMA)).toBe('{"type":"string"}')
  })

  test("the public schema exposes only the three canonical actions", () => {
    expect(INPUT_SCHEMA.properties.action.enum).toEqual(["list", "replace", "mutate"])
    expect(INPUT_SCHEMA.properties.ops.items.properties.action.enum).toEqual(["add", "update", "remove"])
    expect("items" in INPUT_SCHEMA.properties.ops.items.properties).toBe(false)
  })

  test("registers exactly one tool named focus_todo with a fixed definition", async () => {
    const { context, added } = fakeContext()
    await focusTodoPlugin.setup(context as never)

    expect(added.length).toBe(1)
    expect(added[0]!.name).toBe(TOOL_NAME)
    expect(TOOL_NAME).toBe("focus_todo")
    expect(added[0]!.description).toBe(TOOL_DESCRIPTION)
    expect(added[0]!.input).toEqual(INPUT_SCHEMA)
    expect(added[0]!.output).toEqual(OUTPUT_SCHEMA)
    // Without codemode:false the host hides plugin tools inside the code-mode
    // sandbox and they never reach the wire tool list.
    expect(added[0]!.options).toEqual({ codemode: false })
  })

  test("touches only storage, tool, the agent registry, the context hook and the event stream: no TUI slots, no second sidebar", async () => {
    const { context, touched } = fakeContext()
    await focusTodoPlugin.setup(context as never)
    // `agent` is read once at setup to tell primary sessions from subagent ones
    // (it only ever feeds the nudge gate); `session` once, for the context hook;
    // `event` once, to drop state when a session is deleted.
    expect([...new Set(touched)].sort()).toEqual(["agent", "event", "session", "storage", "tool"])
  })

  test("registers exactly one hook: the context hook for the request reminder", async () => {
    const { context, hooks } = fakeContext()
    await focusTodoPlugin.setup(context as never)
    expect(hooks.length).toBe(1)
    expect(hooks[0]!.name).toBe("context")
  })

  test("drops the state row when the host reports the session deleted", async () => {
    const { context, listeners, removed, data } = fakeContext()
    await focusTodoPlugin.setup(context as never)
    expect(listeners.length).toBe(1)
    const key = sessionKey(SESSION)!
    await context.storage.set(key, { version: 1, revision: 0, completed: 0, nextId: 1, items: [] })
    await listeners[0]!({ type: "session.deleted", data: { sessionID: SESSION, info: { id: SESSION } } })
    expect(removed).toEqual([key])
    expect(data.has(key)).toBe(false)
  })

  test("accepts the wrapped details envelope and the info.id fallback", async () => {
    const { context, listeners, removed } = fakeContext()
    await focusTodoPlugin.setup(context as never)
    const key = sessionKey(SESSION)!
    await context.storage.set(key, { marker: 1 })
    await listeners[0]!({ details: { type: "session.deleted", data: { info: { id: SESSION } } } })
    expect(removed).toEqual([key])
  })

  test("ignores other events and invalid session ids", async () => {
    const { context, listeners, removed, data } = fakeContext()
    await focusTodoPlugin.setup(context as never)
    const key = sessionKey(SESSION)!
    await context.storage.set(key, { marker: 1 })
    await listeners[0]!({ type: "session.updated", data: { sessionID: SESSION } })
    await listeners[0]!({ type: "session.deleted", data: { sessionID: "../not-a-session" } })
    expect(removed).toEqual([])
    expect(data.has(key)).toBe(true)
  })

  test("a failing remove is contained by the event callback", async () => {
    const { context, listeners, data } = fakeContext({ failRemove: true })
    await focusTodoPlugin.setup(context as never)
    const key = sessionKey(SESSION)!
    await context.storage.set(key, { marker: 1 })
    await listeners[0]!({ type: "session.deleted", data: { sessionID: SESSION } })
    // The row survives a failing host call, but the callback does not throw.
    expect(data.has(key)).toBe(true)
  })

  test("an unavailable event stream costs cleanup, not the tool", async () => {
    const { context, added, listeners } = fakeContext({ failEvent: true })
    await focusTodoPlugin.setup(context as never)
    expect(listeners.length).toBe(0)
    expect(added.length).toBe(1)
  })

  test("a second setup does not register a second cleanup listener", async () => {
    const first = fakeContext()
    await focusTodoPlugin.setup(first.context as never)
    const second = fakeContext()
    await focusTodoPlugin.setup(second.context as never)
    expect(first.listeners.length + second.listeners.length).toBe(1)
  })

  test("the hook reads the host's agent registry and never nudges a subagent session", async () => {
    env["FOCUS_TODO_STALE_AFTER"] = "2"
    const { context, hooks } = fakeContext({
      agents: [
        { id: "build", mode: "primary" },
        { id: "explore", mode: "subagent" },
        { id: "general", mode: "subagent" },
        { id: "plan", mode: "primary" },
      ],
    })
    await focusTodoPlugin.setup(context as never)
    expect(hooks.length).toBe(1)
    const callback = hooks[0]!.callback
    const turnMessage = { id: "m1", role: "user", content: [{ type: "text", text: "go" }], metadata: {} }

    // A subagent's fresh session: the invitation is suppressed, nothing lands.
    const invite = { sessionID: "ses_subagentprobe00000000001", agent: "explore", messages: [{ ...turnMessage }] }
    await callback(invite)
    expect((invite as { messages: unknown[] }).messages.length).toBe(1)

    // A primary session with the same shape: the invitation is the whole point.
    const primary = { sessionID: "ses_primaryprobe00000000001", agent: "build", messages: [{ ...turnMessage }] }
    await callback(primary)
    expect((primary as { messages: unknown[] }).messages.length).toBe(2)
  })

  test("a failing agent registry costs the nudge filter, not the reminder", async () => {
    env["FOCUS_TODO_STALE_AFTER"] = "2"
    const { context, hooks } = fakeContext({ agents: [], failAgents: true })
    await focusTodoPlugin.setup(context as never)
    expect(hooks.length).toBe(1)
    const payload = { sessionID: "ses_failagentsprobe0000000001", agent: "explore", messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "go" }], metadata: {} }] }
    await hooks[0]!.callback(payload)
    // The set is empty, so nothing is identified as a subagent and the
    // invitation fires — the pre-filter behaviour, kept as the fallback.
    expect((payload as { messages: unknown[] }).messages.length).toBe(2)
  })

  test("the registered hook appends the reminder to the request tail", async () => {
    const { context, hooks, added } = fakeContext()
    await focusTodoPlugin.setup(context as never)
    const tool = added[0] as unknown as { execute(input: unknown, tool: { sessionID?: string }): Promise<unknown> }
    await tool.execute({ action: "add", text: "wire up storage", status: "in_progress" }, { sessionID: SESSION })

    const payload = {
      sessionID: SESSION,
      messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "hello" }], metadata: {} }],
    }
    await hooks[0]!.callback(payload)

    expect(payload.messages.length).toBe(2)
    const appended = payload.messages[1] as unknown as { role: string; content: Array<{ text: string }> }
    expect(appended.role).toBe("user")
    expect(appended.content[0]!.text).toContain("t1> wire up storage")
    expect(appended.content[0]!.text).toContain("[focus_todo] 1 open")
  })

  test("the default hook invites an empty session to create a list, exactly once", async () => {
    const { context, hooks } = fakeContext()
    await focusTodoPlugin.setup(context as never)
    const payload = { sessionID: SESSION, messages: [{ id: "m1", role: "user", content: "hi", metadata: {} }] }
    await hooks[0]!.callback(payload)
    // `staleAfter: 0` silences the recurring clause, not the one-time invitation:
    // without it a session that never made a list hears nothing from the plugin.
    expect(payload.messages.length).toBe(2)
    expect((payload.messages[1] as { content: string }).content).toContain("no list yet")

    const second = { sessionID: SESSION, messages: [{ id: "m2", role: "user", content: "hi", metadata: {} }] }
    await hooks[0]!.callback(second)
    expect(second.messages.length).toBe(1)
  })

  test("the hook never mutates anything but the message array it is handed", async () => {
    const { context, hooks, added } = fakeContext()
    await focusTodoPlugin.setup(context as never)
    const tool = added[0] as unknown as { execute(input: unknown, tool: { sessionID?: string }): Promise<unknown> }
    await tool.execute({ action: "add", text: "keep me" }, { sessionID: SESSION })

    const system = [{ type: "text", text: "base system prompt" }]
    const payload = {
      sessionID: SESSION,
      system,
      messages: [{ id: "m1", role: "user", content: "hi", metadata: {} }],
      options: { maxTokens: 8000 },
      tools: { focus_todo: {} },
    }
    const before = JSON.stringify({ system: payload.system, options: payload.options, tools: payload.tools })
    await hooks[0]!.callback(payload)
    expect(JSON.stringify({ system: payload.system, options: payload.options, tools: payload.tools })).toBe(before)
    expect(system.length).toBe(1)
  })

  test("a failing session domain costs the reminder, not the tool", async () => {
    const { context, added } = fakeContext({ failHook: true })
    await expect(focusTodoPlugin.setup(context as never)).resolves.toBeUndefined()
    expect(added.length).toBe(1)
  })

  test("a failed hook registration does not permanently lock out a later setup", async () => {
    const { context, hooks } = fakeContext({ failHookOnce: true })
    await focusTodoPlugin.setup(context as never)
    expect(hooks.length).toBe(0)
    await focusTodoPlugin.setup(context as never)
    expect(hooks.length).toBe(1)
  })

  test("FOCUS_TODO_REMINDER=0 registers no hook at all, and keeps the tool", async () => {
    const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process!.env
    const original = env["FOCUS_TODO_REMINDER"]
    try {
      env["FOCUS_TODO_REMINDER"] = "0"
      const { context, added, hooks, touched } = fakeContext()
      await focusTodoPlugin.setup(context as never)
      expect(hooks.length).toBe(0)
      expect(added.length).toBe(1)
      // Reminders are off, so `session` is never looked at; `event` still is, for cleanup.
      expect([...new Set(touched)].sort()).toEqual(["event", "storage", "tool"])
    } finally {
      if (original === undefined) delete env["FOCUS_TODO_REMINDER"]
      else env["FOCUS_TODO_REMINDER"] = original
    }
  })

  test("never claims a tool name owned by billion-context or the native tool set", () => {
    const forbidden = [
      "todo",
      "todowrite",
      "todoread",
      "compress",
      "decompress",
      "search_context",
      "acp_status",
      "absorb",
      "acp_cache",
      "read",
      "write",
      "edit",
      "shell",
      "subagent",
    ]
    expect(forbidden).not.toContain(TOOL_NAME)
  })

  test("a failing storage or tool domain never throws during setup", async () => {
    for (const options of [{ failGet: true }, { failTransform: true }, { failGet: true, failTransform: true }]) {
      const { context } = fakeContext(options)
      await expect(focusTodoPlugin.setup(context as never)).resolves.toBeUndefined()
    }
  })

  test("setup survives a context whose domains are entirely missing", async () => {
    await expect(focusTodoPlugin.setup({} as never)).resolves.toBeUndefined()
  })

  test("the tool works with no other plugin present", async () => {
    const { context, added } = fakeContext()
    await focusTodoPlugin.setup(context as never)
    const tool = added[0] as unknown as {
      execute(input: unknown, tool: { sessionID?: string }): Promise<{ output: string }>
    }
    const result = await tool.execute({ action: "add", text: "solo" }, { sessionID: SESSION })
    expect(result.output).toContain("t1:- solo")
    const read = await tool.execute({ action: "list" }, { sessionID: SESSION })
    expect(read.output).toContain("1 active, done=0")
  })

  test("the tool rejects a call with no session id", async () => {
    const { context, added } = fakeContext()
    await focusTodoPlugin.setup(context as never)
    const tool = added[0] as unknown as { execute(input: unknown, tool: {}): Promise<{ output: string }> }
    await expect(tool.execute({ action: "list" }, {})).rejects.toThrow("invalid session id")
  })
})

describe("cache prefix stability", () => {
  /**
   * Fingerprint of the frozen tool definition the host receives (`description` + schemas):
   * character count plus an FNV-1a digest. Pinned, because "the definition never changes" is
   * the plugin's whole claim about the cacheable prefix, and a test that compares the module
   * constants with themselves can never fail. Re-pin only when the change is deliberate.
   */
  const DEFINITION_FINGERPRINT = "1343:4f44d688"

  const fingerprint = (text: string): string => {
    let hash = 0x811c9dc5
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return `${text.length}:${hash.toString(16).padStart(8, "0")}`
  }

  const definitionFingerprint = (tool: { description: string; input: unknown; output: unknown }): string =>
    fingerprint(JSON.stringify({ description: tool.description, input: tool.input, output: tool.output }))

  const mutate: Array<FocusTodoInput | LegacyFocusTodoInput> = [
    { action: "add", text: "implement storage" },
    { action: "update", id: "t1", text: "implement storage safely" },
    { action: "update", id: "t1", status: "in_progress" },
    { action: "add", text: "add tests", status: "blocked" },
    { action: "update", id: "t1", done: true },
    { action: "replace", items: [] },
  ]

  test("the registered definition matches the pinned prefix baseline, before and after every mutation", async () => {
    const { context, added, data } = fakeContext()
    await focusTodoPlugin.setup(context as never)
    expect(added).toHaveLength(1)
    // The object the host actually received — not the module constants it was built from.
    const registered = added[0]!
    expect(registered.description).toBe(TOOL_DESCRIPTION)
    expect(registered.input).toEqual(INPUT_SCHEMA)
    expect(registered.output).toEqual(OUTPUT_SCHEMA)
    expect(definitionFingerprint(registered)).toBe(DEFINITION_FINGERPRINT)
    const before = JSON.stringify(registered)

    const tool = registered as unknown as {
      execute(input: unknown, tool: { sessionID?: string }): Promise<{ output: string }>
    }
    for (const input of mutate) await tool.execute(input, { sessionID: SESSION })

    expect(definitionFingerprint(registered)).toBe(DEFINITION_FINGERPRINT)
    expect(JSON.stringify(registered)).toBe(before)
    expect(data.size).toBe(1)
    expect([...data.keys()]).toEqual([`${KEY_PREFIX}${SESSION}`])
  })

  test("a second setup produces the identical single-tool definition", async () => {
    const first = fakeContext()
    await focusTodoPlugin.setup(first.context as never)
    const tool = first.added[0] as unknown as {
      execute(input: unknown, tool: { sessionID?: string }): Promise<{ output: string }>
    }
    await tool.execute({ action: "add", text: "a" }, { sessionID: SESSION })

    const second = fakeContext()
    await focusTodoPlugin.setup(second.context as never)

    expect(JSON.stringify(second.added)).toBe(JSON.stringify(first.added))
    expect(second.added.map((entry) => entry.name)).toEqual([TOOL_NAME])
  })

  test("the plugin writes only to its own session key, never to the native todo store", async () => {
    const { context, data, added } = fakeContext()
    await focusTodoPlugin.setup(context as never)
    const tool = added[0] as unknown as {
      execute(input: unknown, tool: { sessionID?: string }): Promise<{ output: string }>
    }
    await tool.execute({ action: "add", text: "a" }, { sessionID: SESSION })
    expect([...data.keys()]).toEqual([`${KEY_PREFIX}${SESSION}`])
  })

  test("the reminder changes with the list but never touches the tool definition", async () => {
    const { context, added, data } = fakeContext()
    await focusTodoPlugin.setup(context as never)
    const definition = () => JSON.stringify(added[0])
    const before = definition()

    const tool = added[0] as unknown as {
      execute(input: unknown, tool: { sessionID?: string }): Promise<{ output: string }>
    }
    const lines: string[] = []
    for (const input of mutate) {
      await tool.execute(input, { sessionID: SESSION })
      // What the reminder hook would send for this state, read from the store.
      const line = formatReminder(normalizeState(data.get(`${KEY_PREFIX}${SESSION}`)).state)
      if (line !== undefined) lines.push(line)
      expect(definition()).toBe(before)
    }

    // The reminder text itself tracks the list (that is its whole purpose) and
    // the mutations above walk the list through several shapes.
    expect(new Set(lines).size).toBeGreaterThan(1)
    expect(lines.some((line) => line.includes("t1> implement storage safely"))).toBe(true)
  })
})

describe("formatReminder", () => {
  function stateWith(
    items: Array<{ id: string; text: string; status: "pending" | "in_progress" | "blocked" }>,
    completed = 0,
  ): TodoState {
    return { version: 1, revision: 1, completed, nextId: items.length + 1, items }
  }

  // Long enough that 16 of them cannot fit the default 360 character budget.
  const filler = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `t${index + 1}`,
      text: `task ${index + 1} ${"x".repeat(24)}`,
      status: "pending" as const,
    }))

  test("says nothing when nothing is open", () => {
    expect(formatReminder(stateWith([], 4))).toBeUndefined()
    expect(formatReminder(emptyState())).toBeUndefined()
  })

  test("one line, with the count, the items and the marker convention", () => {
    const line = formatReminder(stateWith([{ id: "t1", text: "wire up storage", status: "in_progress" }], 2))
    expect(line).toBe("[focus_todo] 1 open, 2 done: t1> wire up storage")
    expect(line?.includes("\n")).toBe(false)
  })

  test("puts the running item first, then the blocked ones, then list order", () => {
    const line = formatReminder(
      stateWith([
        { id: "t1", text: "read the spec", status: "pending" },
        { id: "t2", text: "waiting on review", status: "blocked" },
        { id: "t3", text: "not started", status: "pending" },
        { id: "t4", text: "implement storage", status: "in_progress" },
      ]),
    )!
    const order = [...line.matchAll(/(t\d)[>!-]/g)].map((match) => match[1])
    expect(order).toEqual(["t4", "t2", "t1", "t3"])
    expect(line.startsWith("[focus_todo] 4 open: t4> implement storage")).toBe(true)
  })

  test("states the remainder as +k more instead of cutting the list silently", () => {
    const line = formatReminder(stateWith(filler(MAX_ITEMS)), DEFAULT_SETTINGS.reminderBudget)!
    expect(line).toMatch(/\+\d+ more$/)
    expect(line.length).toBeLessThanOrEqual(DEFAULT_SETTINGS.reminderBudget)
    expect(line.startsWith(`[focus_todo] ${MAX_ITEMS} open: t1- task 1`)).toBe(true)

    // A wide budget keeps every item and adds no remainder note.
    const wide = formatReminder(stateWith(filler(4)), 4000)!
    expect(wide).not.toContain("more")
    expect([...wide.matchAll(/(t\d)[>!-]/g)]).toHaveLength(4)
  })

  test("keeps the running item even with a tiny budget, and clips oversized items", () => {
    const tiny = formatReminder(stateWith(filler(3)), 80)!
    expect(tiny.length).toBeLessThanOrEqual(80)
    expect(tiny.startsWith("[focus_todo] 3 open: t1- task 1")).toBe(true)

    const long = formatReminder(stateWith([{ id: "t1", text: "x".repeat(MAX_TEXT), status: "pending" }]))
    expect(long!.length).toBeLessThan(120)
    expect(long!.endsWith("\u2026")).toBe(true)
  })

  test("never leaves a fragment: the +k more marker survives the tightest budget", () => {
    const many = stateWith(
      Array.from({ length: MAX_ITEMS }, (_, index) => ({
        id: `t${index + 1}`,
        text: "z".repeat(MAX_TEXT),
        status: "pending" as const,
      })),
    )
    for (const budget of [24, 40, 80, 120, 200]) {
      const line = formatReminder(many, budget)!
      expect(line.length).toBeLessThanOrEqual(Math.max(24, budget))
      // Either the remainder is stated in full, or the counts stand alone — never a cut token.
      expect(line === `[focus_todo] ${MAX_ITEMS} open` || /\+\d+ more$/.test(line)).toBe(true)
    }
  })

  test("the compact line drops its item rather than clipping it", () => {
    const state = stateWith([{ id: "t1", text: "y".repeat(MAX_TEXT), status: "in_progress" }])
    const wide = compactReminder(state, 360)!
    expect(wide.startsWith("[focus_todo] 1 open, unchanged: t1> ")).toBe(true)
    const tight = compactReminder(state, 40)!
    expect(tight.length).toBeLessThanOrEqual(40)
    expect(tight).toBe("[focus_todo] 1 open, unchanged")
  })

  test("never exceeds the budget, whatever it is set to", () => {
    const many = stateWith(
      Array.from({ length: MAX_ITEMS }, (_, index) => ({
        id: `t${index + 1}`,
        text: "y".repeat(MAX_TEXT),
        status: "pending" as const,
      })),
    )
    for (const budget of [80, 200, 360, 2000]) {
      const line = formatReminder(many, budget)!
      expect(line.length).toBeLessThanOrEqual(budget)
      expect(line).toContain(`${MAX_ITEMS} open`)
    }
  })

  test("a non-finite budget falls back to the default instead of turning the bound off", () => {
    const many = stateWith(filler(MAX_ITEMS))
    for (const budget of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      const line = formatReminder(many, budget)
      expect(line).toBeDefined()
      expect(line!.length).toBeLessThanOrEqual(DEFAULT_SETTINGS.reminderBudget)
    }
  })
})

describe("injectTail", () => {
  // The reminder carries a per-session cadence; a fresh process per test keeps the
  // cases independent. The nudge tests below drive the same memo on purpose.
  beforeEach(() => {
    resetHookRegistration()
  })

  function request(messages: unknown[], sessionID: unknown = SESSION) {
    return { sessionID, messages, system: [{ type: "text", text: "sys" }], options: { maxTokens: 1 }, tools: {} }
  }

  const user = (id: string, text: string) => ({
    id,
    role: "user",
    content: [{ type: "text", text }],
    metadata: { a: 1 },
  })

  test("appends exactly one trailing user message and reports success", async () => {
    const { todo } = core()
    await todo.run(SESSION, { action: "add", text: "wire up storage", status: "in_progress" })
    const messages: unknown[] = [user("m1", "hello")]
    const payload = request(messages)

    expect(await injectTail(todo, payload)).toBe(true)
    expect(payload.messages.length).toBe(2)
    const appended = messages[1] as Record<string, unknown>
    expect(appended["role"]).toBe("user")
    expect(JSON.stringify(appended["content"])).toContain("t1> wire up storage")
    expect(Array.isArray(appended["content"])).toBe(true)
    expect(appended["metadata"]).toEqual({ a: 1 })
  })

  test("mirrors a string-content session instead of assuming parts", async () => {
    const { todo } = core()
    await todo.run(SESSION, { action: "add", text: "keep the shape" })
    const payload = request([{ id: "m1", role: "user", content: "plain string", metadata: {} }])
    await injectTail(todo, payload)
    expect(typeof (payload.messages[1] as Record<string, unknown>)["content"]).toBe("string")
  })

  test("does not append a second reminder when the plugin tail is already last", async () => {
    const { todo } = core()
    await todo.run(SESSION, { action: "add", text: "wire up storage" })
    const payload = request([
      user("m1", "hello"),
      { id: "focus-todo-fixed", role: "user", content: [{ type: "text", text: "[focus_todo] 1 open: t1- wire up storage" }] },
    ])
    expect(await injectTail(todo, payload)).toBe(false)
    expect(payload.messages.length).toBe(2)
  })

  test("does not let ordinary user text containing the marker suppress a reminder", async () => {
    const { todo } = core()
    await todo.run(SESSION, { action: "add", text: "wire up storage" })
    const payload = request([user("m1", "please discuss [focus_todo] 1 open: t1- wire up storage")])
    expect(await injectTail(todo, payload)).toBe(true)
    expect(payload.messages.length).toBe(2)
  })

  test("stays quiet after any assistant/tool tail without inspecting result text", async () => {
    const { todo } = core()
    await todo.run(SESSION, { action: "add", text: "wire up storage" })
    let reads = 0
    const noRead: FocusTodo = {
      ...todo,
      peek: async (sessionID) => {
        reads += 1
        return todo.peek(sessionID)
      },
    }
    const afterTool = request([
      user("m1", "hello"),
      {
        id: "m2",
        role: "tool",
        content: "1 active, done=0\nt1:- wire up storage",
      },
    ])
    expect(await injectTail(noRead, afterTool)).toBe(false)
    expect(reads).toBe(0)

    // A changed list is reflected at the next user turn, not inferred from tool text.
    await todo.run(SESSION, { action: "add", text: "add tests" })
    const next = request([user("m3", "continue")])
    expect(await injectTail(todo, next)).toBe(true)
    expect(JSON.stringify(next.messages.at(-1))).toContain("2 open")
  })

  test("deduplicates repeated hook calls for the same user message id", async () => {
    const { todo } = core()
    await todo.run(SESSION, { action: "add", text: "wire up storage" })
    const first = request([user("turn-1", "continue")])
    expect(await injectTail(todo, first)).toBe(true)

    const retry = request([user("turn-1", "continue")])
    expect(await injectTail(todo, retry)).toBe(false)
    expect(retry.messages).toHaveLength(1)
  })

  test("a mutate result is returned as the complete final state", async () => {
    const { todo } = core()
    const result = await todo.run(SESSION, {
      action: "batch",
      ops: [
        { action: "add", text: "wire up storage", status: "in_progress" },
        { action: "add", text: "write tests" },
        { action: "update", id: "t2", done: true },
      ],
    })
    // The result text carries the same state header, so the sidebar projection
    // and the reminder's dedup guard need no knowledge of how it was produced.
    expect(result).toBe("1 active, done=1\nt1:> wire up storage\nt2:x write tests")

    const fresh = request([
      user("m1", "hello"),
      {
        id: "m2",
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c1", output: { output: result } }],
      },
    ])
    expect(await injectTail(todo, fresh)).toBe(false)
  })

  test("honours the settings switch and the budget", async () => {
    const { todo } = core()
    await todo.run(SESSION, { action: "add", text: "wire up storage" })

    const off = request([user("m1", "hello")])
    expect(await injectTail(todo, off, { ...DEFAULT_SETTINGS, reminder: false })).toBe(false)
    expect(off.messages.length).toBe(1)

    const small = request([user("m1", "hello")])
    expect(await injectTail(todo, small, { ...DEFAULT_SETTINGS, reminderBudget: 80, staleAfter: 0 })).toBe(true)
    const text = (small.messages[1] as { content: Array<{ text: string }> }).content[0]?.text ?? ""
    // The whole injected message — shell, state line and all — stays inside the budget.
    expect(text.length).toBeLessThanOrEqual(80)
    expect(text).toContain("[focus_todo] 1 open: t1- wire up storage")
  })

  test("an empty list gets the invitation once, then silence while nudging is off", async () => {
    const { todo } = core()
    await todo.run(SESSION, { action: "replace", items: [] })
    const payload = request([user("m1", "hi")])
    expect(await injectTail(todo, payload, { ...DEFAULT_SETTINGS, staleAfter: 0 })).toBe(true)
    expect(payload.messages.length).toBe(2)
    expect(JSON.stringify((payload.messages[1] as Record<string, unknown>)["content"])).toContain("no list yet")

    const later = request([user("m2", "hi")])
    expect(await injectTail(todo, later, { ...DEFAULT_SETTINGS, staleAfter: 0 })).toBe(false)
    expect(later.messages.length).toBe(1)
  })

  test("an invalid session id is left alone; another session has its own state", async () => {
    const { todo } = core()
    await todo.run(SESSION, { action: "add", text: "elsewhere" })

    const invalid = request([user("m1", "hi")], "../escape")
    expect(await injectTail(todo, invalid)).toBe(false)

    // A different but valid empty session gets the one-time invitation, and only that.
    const other = request([user("m1", "hi")], "ses_other")
    expect(await injectTail(todo, other)).toBe(true)
    expect(other.messages).toHaveLength(2)
  })

  test("shrugs at malformed payloads instead of throwing into the request path", async () => {
    const { todo } = core()
    await todo.run(SESSION, { action: "add", text: "x" })
    expect(await injectTail(todo, undefined)).toBe(false)
    expect(await injectTail(todo, null)).toBe(false)
    expect(await injectTail(todo, { sessionID: SESSION })).toBe(false)
    expect(await injectTail(todo, { sessionID: SESSION, messages: [] })).toBe(false)
    expect(await injectTail(todo, { sessionID: SESSION, messages: "not an array" })).toBe(false)
  })

  test("a dead store costs the reminder, never the request", async () => {
    const { todo } = core()
    await todo.run(SESSION, { action: "add", text: "x" })
    const broken: FocusTodo = {
      run: todo.run,
      runDetailed: todo.runDetailed,
      peek: async () => {
        throw new Error("store down")
      },
      pendingSessions: todo.pendingSessions,
    }
    const payload = request([user("m1", "hi")])
    expect(await injectTail(broken, payload)).toBe(false)
    expect(payload.messages.length).toBe(1)
  })

  test("a pinned or hostile message array cannot take the request down", async () => {
    const { todo } = core()
    await todo.run(SESSION, { action: "add", text: "x" })

    // A frozen array refuses the append; the failure must stay inside the hook.
    const frozen = Object.freeze([user("m1", "hi")])
    expect(await injectTail(todo, request(frozen as unknown[]))).toBe(false)

    // A content accessor that throws anywhere in the walk must be swallowed too.
    const hostile = [
      {
        id: "m1",
        role: "user",
        get content(): unknown {
          throw new Error("nope")
        },
      },
    ]
    expect(await injectTail(todo, request(hostile))).toBe(false)
  })

  test("a message content nested so deep the walk gives up simply stops matching", async () => {
    const { todo } = core()
    await todo.run(SESSION, { action: "add", text: "x" })
    // 12 levels of wrapping: beyond the walk's depth limit, so nothing matches and the
    // reminder is still appended (the guard can only be conservative, never harmful).
    let nested: unknown = { text: `[focus_todo] ${TOOL_NAME}` }
    for (let depth = 0; depth < 12; depth += 1) nested = { child: nested }
    const payload = request([{ id: "m1", role: "user", content: nested, metadata: {} }])
    expect(await injectTail(todo, payload)).toBe(true)
    expect(payload.messages.length).toBe(2)
  })
})

describe("nudges: inviting the model to use the list", () => {
  beforeEach(() => {
    resetHookRegistration()
  })

  function request(messages: unknown[], sessionID: unknown = SESSION) {
    return { sessionID, messages, system: [{ type: "text", text: "sys" }], options: {}, tools: {} }
  }
  const turn = (id: string) => ({ id, role: "user", content: [{ type: "text", text: `what about ${id}` }], metadata: {} })
  const toolResult = (id: string, text = "shell output") => ({ id, role: "tool", content: [{ type: "text", text }], metadata: {} })
  const settings = { ...DEFAULT_SETTINGS, staleAfter: 2 }
  // The injected message mirrors the shape of the turn before it, so its content
  // may be a string or a parts array; both stringify to something readable here.
  const lastText = (payload: { messages: unknown[] }) =>
    JSON.stringify((payload.messages[payload.messages.length - 1] as Record<string, unknown>)["content"])

  test("a session with no list gets one invitation, in the host's reminder shell", async () => {
    const { todo } = core()
    const first = request([turn("m1")])
    expect(await injectTail(todo, first, settings)).toBe(true)
    expect(lastText(first)).toContain("no list yet")
    // An offer, not an order: it says the tool is available, and never tells the
    // model to call anything. The shell is the host's own convention for
    // harness-authored text, so the tail cannot be read as something the user typed.
    expect(lastText(first)).toBe('[{"type":"text","text":"<system-reminder>\\n[focus_todo] no list yet\\n</system-reminder>"}]')
    expect(lastText(first)).not.toContain("replace")

    // Same session, next turn: the invitation is not a cadence, it never repeats.
    const second = request([turn("m1"), turn("m2")])
    expect(await injectTail(todo, second, settings)).toBe(false)
    expect(second.messages.length).toBe(2)
  })

  test("the invitation lands once per session, whatever `staleAfter` says", async () => {
    // `staleAfter: 0` is the shipped default and the setting most configurations use.
    // The invitation used to be behind it, so a fresh session got no reminder at all —
    // measured on a real session: the model only ever learned about the tool from its
    // definition. It is now its own once-per-session event: 24 characters, then quiet.
    for (const policy of [{ ...DEFAULT_SETTINGS, staleAfter: 0 }, settings]) {
      // The cadence memo is process-wide (keyed by session), so each policy starts
      // from a fresh process's point of view rather than inheriting `invited`.
      resetHookRegistration()
      const { todo } = core()
      const fired: number[] = []
      for (let round = 0; round < 10; round += 1) {
        for (let quiet = 0; quiet < 2; quiet += 1) await injectTail(todo, request([toolResult(`q${round}-${quiet}`)]), policy)
        const payload = request([turn(`t${round}`)])
        if (await injectTail(todo, payload, policy)) {
          fired.push(round)
          expect(lastText(payload)).toContain("no list yet")
        }
      }
      expect(fired).toEqual([0])
    }
  })

  test("with a list, the nudge is a clause on the state line, spaced by `staleAfter`", async () => {
    const { todo } = core()
    await todo.run(SESSION, { action: "add", text: "implement storage", status: "in_progress" })

    // First turn of a fresh process: the list exists and is probably stale, so the
    // line carries the clause.
    const resumed = request([turn("m1")])
    expect(await injectTail(todo, resumed, settings)).toBe(true)
    expect(lastText(resumed)).toContain("1 open")
    expect(lastText(resumed)).toContain("update if changed")

    // Firing reset the counter, so the very next turn is informative only.
    const quiet = request([turn("m1"), turn("m2")])
    expect(await injectTail(todo, quiet, settings)).toBe(true)
    expect(lastText(quiet)).toContain("1 open")
    expect(lastText(quiet)).not.toContain("update it")

    // Two requests without list activity, then a turn start: the clause is back.
    await injectTail(todo, request([toolResult("a")]), settings)
    await injectTail(todo, request([toolResult("b")]), settings)
    const stale = request([turn("m2"), turn("m3")])
    expect(await injectTail(todo, stale, settings)).toBe(true)
    expect(lastText(stale)).toContain("update if changed")
  })

  test("an unchanged list is re-stated in its short form until it moves", async () => {
    const { todo } = core()
    const off = { ...DEFAULT_SETTINGS, staleAfter: 0 }
    await todo.run(SESSION, {
      action: "replace",
      items: [
        { text: "implement the storage layer", status: "in_progress" },
        { text: "write regression tests", status: "pending" },
        { text: "document the reminder cadence", status: "pending" },
      ],
    })

    const first = request([turn("m1")])
    expect(await injectTail(todo, first, off)).toBe(true)
    const full = (JSON.parse(lastText(first)) as Array<{ text: string }>)[0]!.text
    // A plain state line carries no instruction, so it is not wrapped in the host's
    // `<system-reminder>` shell: it asserts facts, and the shell cost 37 characters on
    // every single turn for no gain there. The six-character `[plan] ` marker keeps its
    // provenance visible, because the host only knows it as another user message.
    expect(full.startsWith("[plan] [focus_todo] 3 open: t1> implement")).toBe(true)
    expect(full).not.toContain("system-reminder")

    // Nothing moved: same anchor, fewer tokens, and the word that says so.
    const second = request([turn("m1"), turn("m2")])
    expect(await injectTail(todo, second, off)).toBe(true)
    const short = (JSON.parse(lastText(second)) as Array<{ text: string }>)[0]!.text
    expect(short).toContain("3 open, unchanged: t1> implement the storage layer")
    expect(short.length).toBeLessThan(full.length)

    // A change brings the whole line back.
    await todo.run(SESSION, { action: "add", text: "trim the reminder output" })
    const third = request([turn("m2"), turn("m3")])
    expect(await injectTail(todo, third, off)).toBe(true)
    const again = (JSON.parse(lastText(third)) as Array<{ text: string }>)[0]!.text
    expect(again).not.toContain("unchanged")
    expect(again).toContain("4 open")
  })

  test("only an instruction is shelled; a state report goes out with the plan marker", async () => {
    // The host's `<system-reminder>` shell says "this is harness text, not the user".
    // That matters for a message that reads like an order (the invitation, the clause)
    // and buys nothing for a message that only states facts — which is the form almost
    // every turn carries. A plain state line instead pays six characters for `[plan] `
    // so its provenance cannot be mistaken for user speech. This test pins both forms.
    const { todo } = core()
    const off = { ...DEFAULT_SETTINGS, staleAfter: 0 }

    // No list yet → invitation → shelled, and still inside the budget.
    const invite = request([turn("m1")])
    expect(await injectTail(todo, invite, off)).toBe(true)
    const invitation = (JSON.parse(lastText(invite)) as Array<{ text: string }>)[0]!.text
    expect(invitation.startsWith("<system-reminder>\n[focus_todo] no list yet")).toBe(true)
    expect(invitation.endsWith("</system-reminder>")).toBe(true)
    expect(invitation.length).toBeLessThanOrEqual(DEFAULT_SETTINGS.reminderBudget)

    // List exists, no clause due → plain state line → bare, no shell characters paid.
    await todo.run(SESSION, { action: "add", text: "implement storage", status: "in_progress" })
    const plain = request([turn("m1"), turn("m2")])
    expect(await injectTail(todo, plain, off)).toBe(true)
    const bare = (JSON.parse(lastText(plain)) as Array<{ text: string }>)[0]!.text
    expect(bare).toBe("[plan] [focus_todo] 1 open: t1> implement storage")
    expect(bare).not.toContain("system-reminder")

    // Clause due (fresh memo, `staleAfter: 2`) → the clause is an instruction → shelled.
    resetHookRegistration()
    const stale = request([turn("m3")])
    expect(await injectTail(todo, stale, settings)).toBe(true)
    const withClause = (JSON.parse(lastText(stale)) as Array<{ text: string }>)[0]!.text
    expect(withClause.startsWith("<system-reminder>\n[focus_todo] 1 open: t1> implement storage"))
      .toBe(true)
    expect(withClause).toContain("update if changed")
    expect(withClause.endsWith("</system-reminder>")).toBe(true)
    expect(bare.length).toBeLessThan(withClause.length)
  })

  test("using the tool resets the cadence, so a working session is never nudged", async () => {
    const { todo } = core()
    await todo.run(SESSION, { action: "add", text: "implement storage" })

    for (let round = 0; round < 4; round += 1) {
      // The model updates the list; the next request's tail is that tool result.
      await todo.run(SESSION, { action: "update", id: "t1", text: `implement storage ${round}` })
      const echo = request([toolResult("m", "1 active, done=0\nt1:- implement storage")])
      expect(await injectTail(todo, echo, settings)).toBe(false)

      const next = request([turn(`t${round}`)])
      expect(await injectTail(todo, next, settings)).toBe(true)
      expect(lastText(next)).not.toContain("update it")
    }
  })

  test("staleAfter: 0 keeps the informative reminder, drops the clause, keeps the invitation", async () => {
    const { todo } = core()
    const off = { ...DEFAULT_SETTINGS, staleAfter: 0 }

    // The invitation is not a nudge in the cadence sense: it is how a session that has
    // no list ever hears about the tool at all.
    const noList = request([turn("m1")])
    expect(await injectTail(todo, noList, off)).toBe(true)
    expect(lastText(noList)).toContain("no list yet")

    await todo.run(SESSION, { action: "add", text: "implement storage" })
    await injectTail(todo, request([toolResult("a")]), off)
    await injectTail(todo, request([toolResult("b")]), off)
    const payload = request([turn("m2")])
    expect(await injectTail(todo, payload, off)).toBe(true)
    expect(lastText(payload)).toContain("1 open")
    expect(lastText(payload)).not.toContain("update it")
  })

  test("nudges stay on user turns: a tool chain never carries one", async () => {
    const { todo } = core()
    await todo.run(SESSION, { action: "add", text: "implement storage" })
    for (let i = 0; i < 6; i += 1) {
      const payload = request([toolResult(`step ${i}`)])
      expect(await injectTail(todo, payload, settings)).toBe(false)
      expect(payload.messages).toHaveLength(1)
    }
  })

  test("subagent sessions are never nudged; the informative state line is untouched", async () => {
    const { todo } = core()
    const subs = new Set(["explore", "general"])
    const asAgent = (payload: { messages: unknown[] }, agent: string) => {
      ;(payload as Record<string, unknown>)["agent"] = agent
      return payload
    }

    // A fresh subagent session: the invitation is the only thing it could draw — suppressed.
    const invite = asAgent(request([turn("m1")]), "explore")
    expect(await injectTail(todo, invite, settings, subs)).toBe(false)
    expect(invite.messages.length).toBe(1)

    // With a list, the state line still lands — informative only.
    await todo.run(SESSION, { action: "add", text: "implement storage" })
    const state = asAgent(request([turn("m2")]), "general")
    expect(await injectTail(todo, state, settings, subs)).toBe(true)
    expect(lastText(state)).toContain("1 open")
    expect(lastText(state)).not.toContain("update it")

    // Even a stale turn start cannot fire the clause inside a subagent.
    await injectTail(todo, request([toolResult("a")]), settings, subs)
    await injectTail(todo, request([toolResult("b")]), settings, subs)
    const stale = asAgent(request([turn("m3")]), "explore")
    expect(await injectTail(todo, stale, settings, subs)).toBe(true)
    expect(lastText(stale)).not.toContain("update it")

    // A primary agent on the same cadence: the clause is back.
    const primary = asAgent(request([turn("m4")]), "build")
    expect(await injectTail(todo, primary, settings, subs)).toBe(true)
    expect(lastText(primary)).toContain("update if changed")

    // No set handed in (an older caller): behaviour is exactly as before.
    const legacy = request([turn("m1")], "ses_legacyagent000000000")
    asAgent(legacy, "explore")
    expect(await injectTail(todo, legacy, settings)).toBe(true)
    expect(lastText(legacy)).toContain("no list yet")
  })

  test("turn-start detection reads the host tail, skipping a message this plugin injected", async () => {
    const { todo } = core()
    // A custom creation nudge without the `[focus_todo]` marker passes the dedup
    // guard, so this isolates the tail-skip: below the injected message is a tool
    // result, which is not a turn start, so no invitation may fire.
    const custom = { ...DEFAULT_SETTINGS, staleAfter: 2, creationNudge: "consider recording a plan" }
    const payload = request([
      toolResult("m1"),
      { id: "focus-todo-abc123", role: "user", content: [{ type: "text", text: "consider recording a plan" }], metadata: {} },
    ])
    expect(await injectTail(todo, payload, custom)).toBe(false)
    expect(payload.messages.length).toBe(2)

    // Without the tail, the same request behaves identically.
    const plain = request([toolResult("m1")])
    expect(await injectTail(todo, plain, custom)).toBe(false)
  })

  test("the clause is inside the budget, not bolted on top of it", async () => {
    const { todo } = core()
    await todo.run(SESSION, { action: "add", text: "implement " + "z".repeat(MAX_TEXT - "implement ".length) })
    const tight = { ...DEFAULT_SETTINGS, reminderBudget: 120, staleAfter: 0 }
    const payload = request([turn("m1")])
    expect(await injectTail(todo, payload, { ...tight, staleAfter: 1 })).toBe(true)
    expect(lastText(payload)).toContain("update if changed")
    // The whole appended message — state line plus clause — honours the budget.
    expect(JSON.parse(lastText(payload))[0].text.length).toBeLessThanOrEqual(120)
  })

  test("itemChars controls the per-item clip, and a session with a list is never invited", async () => {
    const { todo } = core()
    await todo.run(SESSION, { action: "add", text: "implement the storage layer properly" })
    const narrow = { ...DEFAULT_SETTINGS, itemChars: 20, staleAfter: 0 }
    const payload = request([turn("m1")])
    await injectTail(todo, payload, narrow)
    expect(lastText(payload)).toContain("implement the stora") // 19 characters plus the ellipsis
    expect(lastText(payload)).toContain("\u2026")
  })

  test("custom nudge texts are the ones that reach the model", async () => {
    const { todo } = core()
    await todo.run(SESSION, { action: "add", text: "implement storage" })
    const chinese = { ...DEFAULT_SETTINGS, maintenanceNudge: " — 列表变了就更新", staleAfter: 0 }
    const payload = request([turn("m1")])
    await injectTail(todo, payload, { ...chinese, staleAfter: 1 })
    expect(lastText(payload)).toContain("列表变了就更新")

    const empty = core()
    const invite = request([turn("m1")], "ses_custominvite00000000000")
    await injectTail(empty.todo, invite, { ...DEFAULT_SETTINGS, creationNudge: "记一下计划", staleAfter: 1 })
    expect(lastText(invite)).toContain("记一下计划")
  })

  test("a user's own nudge text is never clipped, even when it outgrows the budget", async () => {
    // The documented contract: `reminderBudget` bounds the *generated* state line, and the
    // clause is subtracted from it when there is room. A deliberately long custom clause is
    // the user's own words — used as written, and worst case the appended message ends up
    // slightly over the budget rather than silently truncated.
    const long = 300
    const clause = ` — ${"c".repeat(long - 4)}`
    const { todo } = core()
    await todo.run(SESSION, { action: "replace", items: [{ text: "x".repeat(MAX_TEXT) }, { text: "y" }] })
    const payload = request([turn("m1")])
    await injectTail(todo, payload, { ...DEFAULT_SETTINGS, maintenanceNudge: clause, staleAfter: 1 })

    const last = payload.messages[payload.messages.length - 1] as { content: unknown }
    const text =
      typeof last.content === "string"
        ? last.content
        : (last.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("")
    expect(text.endsWith(`${clause}\n</system-reminder>`)).toBe(true) // whole clause, untouched
    const settings = resolveSettings({ maintenanceNudge: clause }, {})
    expect(settings.maintenanceNudge).toBe(clause)
    const worst = DEFAULT_SETTINGS.reminderBudget - 80 + settings.maintenanceNudge.length
    expect(text.length).toBeLessThanOrEqual(worst)
    expect(text.length).toBeLessThan(400) // and still bounded by constants, not by user input size
  })
})

describe("settings", () => {
  test("defaults to the reminder on with a bounded budget", () => {
    expect(resolveSettings(undefined, {})).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS.reminder).toBe(true)
    expect(DEFAULT_SETTINGS.reminderBudget).toBe(360)
    expect(DEFAULT_SETTINGS.staleAfter).toBe(0)
    expect(DEFAULT_SETTINGS.itemChars).toBe(48)
    expect(DEFAULT_SETTINGS.maintenanceNudge).toContain("update")
    expect(DEFAULT_SETTINGS.creationNudge).toContain("no list yet")
    // The invitation offers the tool; it does not order a call.
    expect(DEFAULT_SETTINGS.creationNudge).not.toContain("replace")
    expect(DEFAULT_SETTINGS.creationNudge.length).toBeLessThan(120)
  })

  test("reads the JSON file shape, tolerating junk keys and types", () => {
    expect(resolveSettings({ reminder: false, reminderBudget: 500, staleAfter: 4 }, {})).toEqual({
      ...DEFAULT_SETTINGS,
      reminder: false,
      reminderBudget: 500,
      staleAfter: 4,
    })
    expect(resolveSettings({ reminder: "nonsense", extra: 1 }, {})).toEqual(DEFAULT_SETTINGS)
    expect(resolveSettings([1, 2, 3], {})).toEqual(DEFAULT_SETTINGS)
  })

  test("clamps the budget so a typo cannot flood the context", () => {
    expect(resolveSettings({ reminderBudget: 5 }, {}).reminderBudget).toBe(80)
    expect(resolveSettings({ reminderBudget: 99999 }, {}).reminderBudget).toBe(2000)
    expect(resolveSettings({ reminderBudget: "420" }, {}).reminderBudget).toBe(420)
    expect(resolveSettings({ reminderBudget: "wide" }, {}).reminderBudget).toBe(360)
  })

  test("clamps the nudge interval, and 0 means never", () => {
    expect(resolveSettings({ staleAfter: 0 }, {}).staleAfter).toBe(0)
    expect(resolveSettings({ staleAfter: -3 }, {}).staleAfter).toBe(0)
    expect(resolveSettings({ staleAfter: 9999 }, {}).staleAfter).toBe(200)
    expect(resolveSettings({ staleAfter: "3" }, {}).staleAfter).toBe(3)
    expect(resolveSettings({ staleAfter: "soon" }, {}).staleAfter).toBe(0)
  })

  test("the item caps and the stalled threshold are configurable and clamped", () => {
    const raised = resolveSettings({ maxItems: 40, maxDone: 3, stalledAfter: 15 }, {})
    expect(raised.maxItems).toBe(40)
    expect(raised.maxDone).toBe(3)
    expect(raised.stalledAfter).toBe(15)

    // Hard ceilings: a typo cannot make one tool result enormous.
    expect(resolveSettings({ maxItems: 9999 }, {}).maxItems).toBe(64)
    expect(resolveSettings({ maxItems: 0 }, {}).maxItems).toBe(1)
    expect(resolveSettings({ maxDone: 9999 }, {}).maxDone).toBe(50)
    expect(resolveSettings({ maxDone: -1 }, {}).maxDone).toBe(0)
    expect(resolveSettings({ stalledAfter: -5 }, {}).stalledAfter).toBe(0)
    expect(resolveSettings({ stalledAfter: 99999 }, {}).stalledAfter).toBe(1440)
    // Env overrides the file, same as every other key.
    expect(resolveSettings({ maxItems: 8 }, { FOCUS_TODO_MAX_ITEMS: "24" }).maxItems).toBe(24)
    expect(resolveSettings({ maxItems: "wide" }, {}).maxItems).toBe(16)
  })

  test("clamps the item clip, and the retired invitation cap is inert", () => {
    expect(resolveSettings({ itemChars: 1 }, {}).itemChars).toBe(16)
    expect(resolveSettings({ itemChars: 9999 }, {}).itemChars).toBe(200)
    expect(resolveSettings({ itemChars: 24 }, {}).itemChars).toBe(24)
    // `creationNudgeMax` used to be a per-session cap. The invitation is no longer
    // rationed at all, so the key is now a tolerated unknown rather than a setting —
    // a file that still has it resolves to the defaults instead of shrinking a cap.
    expect(resolveSettings({ creationNudgeMax: 0 }, {})).toEqual(DEFAULT_SETTINGS)
    expect(resolveSettings({ creationNudgeMax: 50 }, {})).toEqual(DEFAULT_SETTINGS)
  })

  test("nudge texts are configurable, trimmed, capped, and empty falls back", () => {
    const custom = resolveSettings({ maintenanceNudge: "  — 列表变了就更新  ", creationNudge: "记一下计划" }, {})
    // The leading space survives (it separates the clause from the list); the
    // trailing one does not.
    expect(custom.maintenanceNudge).toBe("  — 列表变了就更新")
    expect(custom.creationNudge).toBe("记一下计划")

    expect(resolveSettings({ maintenanceNudge: "   " }, {}).maintenanceNudge).toBe(DEFAULT_SETTINGS.maintenanceNudge)
    expect(resolveSettings({ creationNudge: 42 }, {}).creationNudge).toBe(DEFAULT_SETTINGS.creationNudge)

    const flood = resolveSettings({ creationNudge: "x".repeat(5000) }, {}).creationNudge
    expect(flood.length).toBe(300)
  })

  test("the environment overrides the file, for tests and one-off runs", () => {
    expect(resolveSettings({ reminder: false }, { FOCUS_TODO_REMINDER: "1" }).reminder).toBe(true)
    expect(resolveSettings({ reminder: true }, { FOCUS_TODO_REMINDER: "0" }).reminder).toBe(false)
    expect(resolveSettings({ reminderBudget: 100 }, { FOCUS_TODO_REMINDER_BUDGET: "900" }).reminderBudget).toBe(900)
    expect(resolveSettings({ staleAfter: 9 }, { FOCUS_TODO_STALE_AFTER: "2" }).staleAfter).toBe(2)
    expect(resolveSettings({ itemChars: 100 }, { FOCUS_TODO_ITEM_CHARS: "20" }).itemChars).toBe(20)
    expect(resolveSettings({ staleAfter: 9 }, { FOCUS_TODO_STALE_AFTER: "0" }).staleAfter).toBe(0)
  })

  test("finds the config file next to the user's opencode.json", () => {
    expect(userConfigPath({ HOME: "/home/me" })).toBe("/home/me/.config/opencode/focus-todo.json")
    expect(userConfigPath({ USERPROFILE: "C:\\Users\\me" })).toBe("C:\\Users\\me/.config/opencode/focus-todo.json")
    expect(userConfigPath({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/me" })).toBe("/xdg/opencode/focus-todo.json")
    expect(userConfigPath({})).toBeUndefined()
  })

  test("a missing or unreadable config file resolves to the defaults", async () => {
    expect(await loadSettings({}, ["C:/definitely/not/here/focus-todo.json"])).toEqual(DEFAULT_SETTINGS)
    expect(await loadSettings({}, [undefined])).toEqual(DEFAULT_SETTINGS)
  })
})
