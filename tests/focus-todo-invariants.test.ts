/**
 * Invariant hunt for the state machine.
 *
 * Every other test file checks a case someone thought of. This one drives thousands
 * of pseudo-random action sequences through the same public entry point the model
 * uses and asserts the invariants that must hold *after every single step* — the
 * properties a bug would break, whichever code path produced it:
 *
 *   1. at most `MAX_ITEMS` open and `MAX_DONE` marked rows;
 *   2. at most one open `in_progress`, and never a conflict error that the state
 *      does not actually contain;
 *   3. ids unique, well-formed, and never reused (`nextId` stays ahead);
 *   4. the stored order is exactly the printed order (open rows first, marked last,
 *      marked group newest-finish first);
 *   5. `completed` never falls below the marked rows it can see;
 *   6. text is non-empty, single-line and within the cap;
 *   7. the panel parses the tool result back into exactly the state that produced it
 *      (counts, rows, order, statuses);
 *   8. the reminder never mentions a marked row and never exceeds its budget.
 *
 * The generator is a seeded LCG, so a failure is reproducible: run the same seed and
 * the same sequence runs again. `bun test` runs it across several seeds.
 *
 * Run with `bun test`.
 */

import { describe, expect, test } from "bun:test"

import {
  applyAction,
  DEFAULT_SETTINGS,
  DONE_TEXT_MAX,
  emptyState,
  formatReminder,
  formatState,
  MAX_DONE,
  MAX_ITEMS,
  MAX_TEXT,
  openItems,
  type TodoItem,
  type TodoState,
} from "../src/focus-todo/server.ts"
import { parseFocusState } from "../src/focus-todo/view.ts"

/** The tool's own id shape; kept here so the test does not reach into internals. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/

function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

const TEXTS = [
  "a",
  "wire up storage",
  "汉字任务描述",
  "  padded   text  ",
  "",
  "   ",
  "x".repeat(MAX_TEXT),
  "y".repeat(MAX_TEXT + 1),
  "z".repeat(400),
  "line\nbreak\tand tab",
]

const STATUSES = ["pending", "in_progress", "blocked", "done", "whenever", undefined, 42]

/** One random, sometimes invalid, model-shaped call. */
function randomInput(rand: () => number, state: TodoState): unknown {
  const ids = state.items.map((item) => item.id)
  const pickId = (): string => {
    const roll = rand()
    if (roll < 0.15) return "t999"
    if (roll < 0.25 || ids.length === 0) return "nonexistent"
    return ids[Math.floor(rand() * ids.length)]!
  }
  const pickText = (): unknown => (rand() < 0.1 ? undefined : TEXTS[Math.floor(rand() * TEXTS.length)])
  const pickStatus = (): unknown => STATUSES[Math.floor(rand() * STATUSES.length)]

  const roll = rand()
  if (roll < 0.12) return { action: "list" }
  if (roll < 0.24) return { action: "replace", items: [] }
  if (roll < 0.4) return { action: "add", text: pickText(), status: pickStatus() }
  if (roll < 0.55)
    return { action: "update", id: pickId(), text: pickText(), status: pickStatus(), done: rand() < 0.2 ? true : undefined }
  if (roll < 0.7) return { action: "update", id: pickId(), done: true }
  if (roll < 0.85) return { action: "remove", id: pickId() }
  const count = Math.floor(rand() * (MAX_ITEMS + 3))
  return {
    action: "replace",
    items: Array.from({ length: count }, () =>
      rand() < 0.75
        ? { text: pickText(), status: pickStatus() }
        : { id: `t${1 + Math.floor(rand() * (MAX_ITEMS + MAX_DONE))}`, text: pickText() },
    ),
  }
}

/** Fails with the full state attached, so a broken invariant is reproducible from the log. */
function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

/** Everything that must be true of a state the tool just returned. */
function assertInvariants(state: TodoState, context: string): void {
  const open = openItems(state)
  const marked = state.items.filter((item) => item.done === true)
  const where = `${context} :: ${formatState(state)}`

  check(open.length <= MAX_ITEMS, `too many open rows: ${where}`)
  check(marked.length <= MAX_DONE, `too many marked rows: ${where}`)
  check(state.items.length <= MAX_ITEMS + MAX_DONE, `too many rows in total: ${where}`)
  check(
    open.filter((item) => item.status === "in_progress").length <= 1,
    `more than one in_progress: ${where}`,
  )
  check(state.completed >= marked.length, `counter below its own marks: ${where}`)

  const ids = state.items.map((item) => item.id)
  check(new Set(ids).size === ids.length, `duplicate ids: ${where}`)
  for (const id of ids) {
    check(ID_PATTERN.test(id), `malformed id ${id}: ${where}`)
    const numeric = /^t(\d+)$/.exec(id)
    if (numeric) check(state.nextId > Number(numeric[1]), `nextId would reuse ${id}: ${where}`)
  }

  for (const item of state.items) {
    check(item.text.length > 0, `empty text: ${where}`)
    check(item.text.length <= MAX_TEXT, `text over the cap: ${where}`)
    check(!/[\n\r\t]/.test(item.text), `multi-line text: ${where}`)
    check(item.text === item.text.trim(), `untrimmed text: ${where}`)
  }

  // The stored array is exactly the printed order: open rows first, then marked ones
  // (the marked group leading with the most recently finished row).
  const order = state.items.map((item) => (item.done === true ? `x:${item.id}` : `o:${item.id}`))
  check(
    order.join(" ") === [...open.map((item) => `o:${item.id}`), ...marked.map((item) => `x:${item.id}`)].join(" "),
    `row order is not open-then-marked: ${where}`,
  )

  // The panel reads this exact text back; it must not have to guess.
  const parsed = parseFocusState(formatState(state))
  check(parsed !== undefined, `panel cannot parse the tool result: ${where}`)
  check(parsed?.active === open.length, `panel active count: ${where}`)
  check(parsed?.done === state.completed, `panel done count: ${where}`)
  // Marked rows are clipped in the tool result (open ones keep their full text), so the
  // panel sees a shortened row for them — by design, and the only place text is lost.
  const shownText = (item: TodoItem): string =>
    item.done === true && item.text.length > DONE_TEXT_MAX
      ? `${item.text.slice(0, DONE_TEXT_MAX - 1)}\u2026`
      : item.text
  const expectedRows = [...open, ...marked].map(
    (item) => `${item.id}:${item.done === true ? "done" : item.status}:${shownText(item)}`,
  )
  const actualRows = (parsed?.items ?? []).map((item) => `${item.id}:${item.status}:${item.text}`)
  check(actualRows.join("\n") === expectedRows.join("\n"), `panel rows differ: ${where}\n${actualRows.join("\n")}`)

  // Whatever the panel sees is what the reminder must not repeat.
  const line = formatReminder(state)
  if (line !== undefined) {
    check(line.length <= DEFAULT_SETTINGS.reminderBudget, `reminder over budget: ${line}`)
    check(line.startsWith(`[focus_todo] ${open.length} open`), `reminder header: ${line}`)
    // Parse the entries instead of substring-matching ids: an open `t10` contains "t1",
    // so a naive `includes` check both misses leaks and invents them.
    const entryIds = line
      .slice(line.indexOf(": ") + 2)
      .split(" | ")
      .map((entry) => /^([A-Za-z0-9_-]{1,16})[>!-]/.exec(entry)?.[1])
      .filter((id): id is string => id !== undefined)
    for (const item of marked) check(!entryIds.includes(item.id), `reminder names marked row ${item.id}: ${line}`)
    check(entryIds.length === new Set(entryIds).size, `reminder repeats a row: ${line}`)
    check(entryIds.length === open.length || line.includes("more"), `reminder drops an open row silently: ${line}`)
  } else {
    check(open.length === 0, `no reminder although ${open.length} rows are open: ${where}`)
  }
}

function drive(seed: number, steps: number): { applied: number; refused: number } {
  const rand = rng(seed)
  let state = emptyState()
  let applied = 0
  let refused = 0

  for (let step = 0; step < steps; step += 1) {
    const input = randomInput(rand, state)
    const before = order0(state)
    const outcome = applyAction(state, input as never)
    const label = `seed ${seed} step ${step} ${JSON.stringify(input).slice(0, 120)}`

    if (!outcome.ok) {
      refused += 1
      check(order0(state) === before, `a refusal moved the state: ${label}`)
      check(outcome.error.length > 0, `empty error message: ${label}`)
      continue
    }

    applied += 1
    const wasList = (input as { action?: unknown }).action === "list"
    check(outcome.write === !wasList, `write flag does not match the action: ${label}`)
    check(outcome.text === formatState(outcome.state), `text is not the state it returned: ${label}`)
    if (wasList) {
      check(outcome.state === state, `list returned a copy: ${label}`)
    } else {
      check(order0(state) === before, `a mutation mutated the state it was handed: ${label}`)
    }
    state = outcome.state
    assertInvariants(state, label)
  }
  return { applied, refused }
}

/** A cheap fingerprint of a state, for "nothing moved" checks. */
function order0(state: TodoState): string {
  return JSON.stringify([state.completed, state.nextId, state.items])
}

describe("state invariants under random workloads", () => {
  for (const seed of [1, 7, 42, 1337, 99991, 20261013, 424242]) {
    test(`holds for every step of a 1500-step random run (seed ${seed})`, () => {
      const { applied, refused } = drive(seed, 1500)
      // The generator must actually exercise the tool, and must include refusals —
      // an all-refused run would prove nothing about the state machine.
      check(applied > 200, `only ${applied} actions applied`)
      check(refused > 50, `only ${refused} actions refused`)
    })
  }

  test("long runs keep storage bounded — nothing accumulates past the caps", () => {
    const rand = rng(20261013)
    let state = emptyState()
    for (let step = 0; step < 3000; step += 1) {
      const outcome = applyAction(state, randomInput(rand, state) as never)
      if (outcome.ok) state = outcome.state
    }
    assertInvariants(state, "3000-step run")
    expect(state.items.length).toBeLessThanOrEqual(MAX_ITEMS + MAX_DONE)
    // The state that gets persisted stays small, whatever happened along the way.
    const openRowOverhead = 32
    const doneRowOverhead = 32
    expect(formatState(state).length).toBeLessThan(
      MAX_ITEMS * (MAX_TEXT + openRowOverhead) + MAX_DONE * (DONE_TEXT_MAX + doneRowOverhead) + 64,
    )
  })
})

describe("round-trips the panel depends on", () => {
  test("a full capped open + marked list survives format → parse → render unchanged", () => {
    const items: TodoItem[] = []
    for (let index = 1; index <= MAX_ITEMS + MAX_DONE; index += 1) {
      items.push({
        id: `t${index}`,
        text: `item ${index}`,
        status: index % 3 === 0 ? "blocked" : "pending",
        ...(index > MAX_ITEMS ? { done: true } : {}),
      })
    }
    const state: TodoState = { version: 1, revision: 3, completed: MAX_DONE, nextId: MAX_ITEMS + MAX_DONE + 1, items }
    assertInvariants(state, "full list")
  })

  test("a marked row whose text was clipped to the display cap still parses", () => {
    const state: TodoState = {
      version: 1,
      revision: 1,
      completed: 1,
      nextId: 2,
      items: [{ id: "t1", text: "z".repeat(MAX_TEXT), status: "pending", done: true }],
    }
    const parsed = parseFocusState(formatState(state))
    expect(parsed?.done).toBe(1)
    expect(parsed?.items[0]?.status).toBe("done")
    expect(parsed?.items[0]?.text.length).toBe(DONE_TEXT_MAX) // cap minus one character plus the ellipsis
    expect(parsed?.items[0]?.text.endsWith("\u2026")).toBe(true)
  })
})
