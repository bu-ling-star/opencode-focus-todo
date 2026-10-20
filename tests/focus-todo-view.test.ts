/**
 * Unit tests for the sidebar panel's pure view logic. Run with `bun test`.
 *
 * The panel re-parses text the server half produced, so the most valuable tests
 * here round-trip the two halves: real `formatState` output goes in, and the
 * panel has to come back with exactly the same items.
 */

import { describe, expect, test } from "bun:test"

import { applyAction, emptyState, formatReminder, formatState, MAX_DONE, MAX_ITEMS, type TodoState } from "../src/focus-todo/server.ts"
import { MAX_DONE_ROWS, MAX_OPEN_ROWS, MAX_ROW_WIDTH, MAX_ROWS, MESSAGE_SCAN_LIMIT, TOOL_NAME, buildPanel, charWidth, clip, displayWidth, extractFocusState, isFoldStorePair, latestFocusState, parseFocusState, type FocusView, toHex } from "../src/focus-todo/view.ts"

const SESSION = "ses_view0000aaaaaaaaaaaaaaaaaaaaa"

describe("cap agreement with the tool", () => {
  test("the panel's row budget is the tool's own caps, not a guess", () => {
    // view.ts cannot import server.ts at runtime (the panel stays standalone), so the
    // literals are duplicated by design — and this is what keeps them in sync.
    expect(MAX_OPEN_ROWS).toBe(MAX_ITEMS)
    expect(MAX_DONE_ROWS).toBe(MAX_DONE)
    expect(MAX_ROWS).toBe(MAX_ITEMS + MAX_DONE)
  })

  test("a real list at both caps is still parsed and rendered whole", () => {
    const state: TodoState = { version: 1, revision: 0, completed: MAX_DONE, nextId: 0, items: [] }
    for (let index = 1; index <= MAX_ITEMS + MAX_DONE; index += 1) {
      state.items.push({
        id: `t${index}`,
        text: `item ${index}`,
        status: "pending",
        ...(index > MAX_ITEMS ? { done: true } : {}),
      })
    }
    const parsed = parseFocusState(formatState(state))
    expect(parsed?.active).toBe(MAX_ITEMS)
    expect(parsed?.done).toBe(MAX_DONE)
    expect(parsed?.items).toHaveLength(MAX_ROWS)
    expect(buildPanel(parsed).rows).toHaveLength(MAX_ROWS)
  })
})

/** A tool part shaped the way the host stores and streams one. */
function toolPart(text: string, overrides: { name?: string; status?: string } = {}) {
  return {
    type: "tool",
    id: "call_1",
    name: overrides.name ?? TOOL_NAME,
    executed: true,
    state: {
      status: overrides.status ?? "completed",
      input: { action: "list" },
      content: [{ type: "text", text }],
      metadata: {},
    },
  }
}

function assistantMessage(content: unknown[]) {
  return { id: "msg_1", type: "assistant", content }
}

function seededState(): TodoState {
  const first = applyAction(emptyState(), {
    action: "replace",
    items: [
      { text: "implement storage", status: "in_progress" },
      { text: "add tests" },
      { text: "API unavailable", status: "blocked" },
    ],
  })
  if (!first.ok) throw new Error("seed failed")
  const second = applyAction(first.state, { action: "update", id: "t2", status: "pending" })
  if (!second.ok) throw new Error("seed failed")
  return second.state
}

describe("parseFocusState", () => {
  test("round-trips the server's own formatState output", () => {
    const state = seededState()
    const parsed = parseFocusState(formatState(state))

    expect(parsed).toBeDefined()
    expect(parsed?.active).toBe(3)
    expect(parsed?.done).toBe(0)
    expect(parsed?.items).toEqual([
      { id: "t1", status: "in_progress", text: "implement storage" },
      { id: "t2", status: "pending", text: "add tests" },
      { id: "t3", status: "blocked", text: "API unavailable" },
    ])
  })

  test("accepts a header-only dump (empty list)", () => {
    expect(parseFocusState("0 active, done=4")).toEqual({ active: 0, done: 4, items: [] })
  })

  test("skips a warn= notice that precedes the dump", () => {
    const parsed = parseFocusState("warn=state store unavailable, list not loaded\n1 active, done=1\nt1:> keep going")
    expect(parsed?.items).toEqual([{ id: "t1", status: "in_progress", text: "keep going" }])
  })

  test("rejects error text and anything without a header", () => {
    expect(parseFocusState("error=unknown id t9")).toBeUndefined()
    expect(parseFocusState("")).toBeUndefined()
    expect(parseFocusState("not a todo dump at all")).toBeUndefined()
    expect(parseFocusState(undefined)).toBeUndefined()
    expect(parseFocusState(42)).toBeUndefined()
  })

  test("rejects a body it cannot fully account for", () => {
    expect(parseFocusState("2 active, done=0\nt1:> one\nnot an item line")).toBeUndefined()
    expect(parseFocusState("1 active, done=0\nt1:~ unknown marker")).toBeUndefined()
    // an id that violates the tool's own id pattern must not be silently shown
    expect(parseFocusState("1 active, done=0\ntoolongidentifier1234:> nope")).toBeUndefined()
  })

  test("rejects more rows than the tool can ever hold", () => {
    const tooMany = ["9 active, done=0"]
    for (let index = 1; index <= MAX_ITEMS + 1; index += 1) tooMany.push(`t${index}:> item ${index}`)
    expect(parseFocusState(tooMany.join("\n"))).toBeUndefined()
  })

  test("reads marked rows, keeps them out of the active count and keeps them in the list", () => {
    const parsed = parseFocusState("1 active, done=2\nt1:> still open\nt2:x finished\nt3:x also finished")
    expect(parsed?.active).toBe(1)
    expect(parsed?.done).toBe(2)
    expect(parsed?.items.map((item) => item.status)).toEqual(["in_progress", "done", "done"])
  })

  test("a header whose done count is larger than the rows is still accepted", () => {
    // The store caps retained rows, so `done=` can exceed the rows on screen.
    const parsed = parseFocusState("0 active, done=40\nt2:x finished")
    expect(parsed?.active).toBe(0)
    expect(parsed?.done).toBe(40)
  })

  test("derives the active count from the items", () => {
    const parsed = parseFocusState("9 active, done=1\nt1:> only one")
    expect(parsed?.active).toBe(1)
    expect(parsed?.done).toBe(1)
  })

  test("tolerates trailing whitespace on the header line", () => {
    expect(parseFocusState("1 active, done=0  \nt1:> x")?.active).toBe(1)
  })
})

describe("extractFocusState", () => {
  test("reads the persisted content-part shape", () => {
    expect(extractFocusState(toolPart("1 active, done=2\nt1:> work"))?.items).toHaveLength(1)
  })

  test("joins several text parts before parsing", () => {
    const part = {
      name: TOOL_NAME,
      state: {
        status: "completed",
        content: [
          { type: "text", text: "1 active, done=2" },
          { type: "text", text: "\nt1:> work" },
        ],
      },
    }
    expect(extractFocusState(part)?.items[0]?.text).toBe("work")
  })

  test("falls back to the legacy output field", () => {
    const part = { name: TOOL_NAME, state: { status: "completed", output: "0 active, done=7" } }
    expect(extractFocusState(part)?.done).toBe(7)
  })

  test("ignores other tools, unfinished calls and unparsable results", () => {
    expect(extractFocusState(toolPart("1 active, done=0", { name: "bash" }))).toBeUndefined()
    expect(extractFocusState(toolPart("1 active, done=0", { status: "running" }))).toBeUndefined()
    expect(extractFocusState(toolPart("1 active, done=0", { status: "error" }))).toBeUndefined()
    // a failed call has no state dump; its body must not be shown
    expect(extractFocusState(toolPart(""))).toBeUndefined()
    expect(extractFocusState(undefined)).toBeUndefined()
    expect(extractFocusState({ name: TOOL_NAME })).toBeUndefined()
  })
})

describe("latestFocusState", () => {
  test("takes the newest result and ignores older ones", () => {
    const messages = [
      assistantMessage([toolPart("3 active, done=0\nt1:> old")]),
      assistantMessage([{ type: "text", text: "thinking" }]),
      assistantMessage([toolPart("1 active, done=2\nt7:> newest")]),
    ]
    const found = latestFocusState(messages)
    expect(found?.items[0]?.id).toBe("t7")
    expect(found?.done).toBe(2)
  })

  test("looks past non-tool parts and other tools", () => {
    const messages = [
      assistantMessage([]),
      assistantMessage([{ type: "tool", name: "bash", state: { status: "completed", content: [] } }]),
      assistantMessage([{ type: "text", text: "hello" }, toolPart("2 active, done=1\nt1:> a\nt2:- b")]),
    ]
    expect(latestFocusState(messages)?.active).toBe(2)
  })

  test("stops looking past the scan limit", () => {
    const messages = [assistantMessage([toolPart("1 active, done=0\nt1:> ancient")])]
    for (let index = 0; index < MESSAGE_SCAN_LIMIT; index += 1) {
      messages.push(assistantMessage([{ type: "text", text: `filler ${index}` }]))
    }
    expect(latestFocusState(messages)).toBeUndefined()
  })

  test("survives junk and empty windows", () => {
    expect(latestFocusState(undefined)).toBeUndefined()
    expect(latestFocusState([])).toBeUndefined()
    expect(latestFocusState([null, 42, { content: "nope" }])).toBeUndefined()
  })
})

describe("width handling", () => {
  test("counts wide characters as two columns", () => {
    expect(charWidth("a")).toBe(1)
    expect(charWidth("中")).toBe(2)
    expect(charWidth("…")).toBe(1)
    expect(displayWidth("ab")).toBe(2)
    expect(displayWidth("中文")).toBe(4)
    expect(displayWidth("a中")).toBe(3)
  })

  test("leaves short text alone and marks clipped text", () => {
    expect(clip("short", 10)).toBe("short")
    expect(clip("exactly10!", 10)).toBe("exactly10!")
    expect(clip("abcdefghijk", 10)).toBe("abcdefghi…")
    expect(clip("", 10)).toBe("")
    expect(clip("anything", 0)).toBe("")
  })

  test("never exceeds the column budget, wide characters included", () => {
    for (const width of [4, 7, 12, 30]) {
      for (const text of ["汉字汉字汉字汉字", "a汉b字c汉d字", "plain ascii text here", "🙂🙂🙂🙂🙂🙂"]) {
        expect(displayWidth(clip(text, width))).toBeLessThanOrEqual(width)
      }
    }
  })
})

describe("toHex", () => {
  test("converts the host's opentui colour objects into hex strings", () => {
    // The exact shape the runtime probe found: `{ buffer: Uint8Array [r, g, b, a] }`.
    const alpha = new Uint8Array([127, 217, 98, 255])
    expect(toHex({ buffer: alpha })).toBe("#7fd962")
  })

  test("passes hex strings through and handles rgb triples defensively", () => {
    expect(toHex("#C5C5BB")).toBe("#C5C5BB")
    expect(toHex({ r: 12, g: 34, b: 56 })).toBe("#0c2238")
    // A future host might ship 0..1 floats; rounding keeps them sane.
    expect(toHex({ r: 1, g: 0.5, b: 0 })).toBe("#ff8000")
    // Out-of-range channel values are clamped, so the string stays a valid 6-digit colour.
    expect(toHex({ r: 255, g: -1, b: 300 })).toBe("#ff00ff")
  })

  test("returns undefined for anything it cannot read", () => {
    expect(toHex(undefined)).toBeUndefined()
    expect(toHex(null)).toBeUndefined()
    expect(toHex(42)).toBeUndefined()
    expect(toHex({})).toBeUndefined()
    expect(toHex({ buffer: "not a view" })).toBeUndefined()
    expect(toHex({ buffer: new Uint8Array(2) })).toBeUndefined()
  })
})

describe("buildPanel", () => {
  const view = (active: number, done: number): FocusView => ({
    active,
    done,
    items: Array.from({ length: active }, (_unused, index) => ({
      id: `t${index + 1}`,
      status: index === 0 ? ("in_progress" as const) : ("pending" as const),
      text: `item ${index + 1}`,
    })),
  })

  test("says 暂无待办 until the session has used the tool", () => {
    expect(buildPanel(undefined)).toEqual({ header: "暂无待办", rows: [] })
  })

  test("says 暂无待办 for a list that was cleared before anything finished", () => {
    expect(buildPanel(view(0, 0))).toEqual({ header: "暂无待办", rows: [] })
  })

  test("shows all done plus the marked rows once nothing is open", () => {
    const panel = buildPanel({
      active: 0,
      done: 3,
      items: [
        { id: "t1", status: "done" as const, text: "implement storage" },
        { id: "t2", status: "done" as const, text: "add tests" },
      ],
    })
    expect(panel.header).toBe("Focus: all done")
    expect(panel.rows.map((row) => row.status)).toEqual(["done", "done"])
    expect(panel.rows.map((row) => row.line)).toEqual(["✓ t1 implement storage", "✓ t2 add tests"])
  })

  test("states the count when nothing is open and the marks were removed too", () => {
    // `remove` can drop marked rows one by one; when the last one goes, `0 active, done N`
    // is the true state and the only thing there is to draw.
    expect(buildPanel({ active: 0, done: 1, items: [] })).toEqual({
      header: "Focus 0 active, done 1",
      rows: [],
    })

    expect(buildPanel({ active: 0, done: 12, items: [] }, 30).header).toBe("Focus 0 active, done 12")

    // The same string the tool result carries, parsed and drawn without a special case.
    expect(buildPanel(parseFocusState("0 active, done=1"))?.header).toBe("Focus 0 active, done 1")
    // And it still respects the width budget of a narrow sidebar.
    expect(buildPanel({ active: 0, done: 3, items: [] }, 10).header).toBe("Focus 0 a…")
  })

  test("renders a header plus one row per open item", () => {
    const panel = buildPanel(view(2, 5))
    expect(panel?.header).toBe("Focus 2 active, done 5 · 1 running")
    expect(panel?.rows.map((row) => row.line)).toEqual(["▶ t1 item 1", "○ t2 item 2"])
    expect(panel?.rows[0]?.status).toBe("in_progress")
  })

  test("omits the done counter when nothing has finished", () => {
    expect(buildPanel(view(1, 0))?.header).toBe("Focus 1 active · 1 running")
  })

  test("names the running count, and says nothing about it when nothing runs", () => {
    const quiet = buildPanel({
      active: 2,
      done: 0,
      items: [
        { id: "t1", status: "blocked", text: "wait for review" },
        { id: "t2", status: "pending", text: "next" },
      ],
    })
    expect(quiet?.header).toBe("Focus 2 active")
    expect(buildPanel(view(3, 1))?.header).toBe("Focus 3 active, done 1 · 1 running")
  })

  test("keeps every row inside the requested width", () => {
    const panel = buildPanel(
      { active: 1, done: 0, items: [{ id: "t1", status: "blocked", text: "一段很长的中文任务描述需要被截断" }] },
      16,
    )
    expect(panel).toBeDefined()
    for (const row of panel?.rows ?? []) expect(displayWidth(row.line)).toBeLessThanOrEqual(16)
    expect(displayWidth(panel?.header ?? "")).toBeLessThanOrEqual(16)
  })

  test("uses the default width when none is given", () => {
    const long = { active: 1, done: 0, items: [{ id: "t1", status: "pending" as const, text: "x".repeat(200) }] }
    expect(displayWidth(buildPanel(long)?.rows[0]?.line ?? "")).toBeLessThanOrEqual(MAX_ROW_WIDTH)
  })

  test("never emits more rows than the tool can hold", () => {
    const many = { active: MAX_ITEMS, done: 0, items: view(MAX_ITEMS, 0).items }
    expect(buildPanel(many)?.rows).toHaveLength(MAX_ITEMS)
  })
})

describe("session isolation of the projection", () => {
  test("two sessions with different states do not bleed into each other", () => {
    const mine = [assistantMessage([toolPart("1 active, done=0\nt1:> mine")])]
    const theirs = [assistantMessage([toolPart("0 active, done=9")])]

    expect(latestFocusState(mine)?.items[0]?.text).toBe("mine")
    expect(latestFocusState(theirs)?.done).toBe(9)
    expect(buildPanel(latestFocusState(theirs))?.header).toBe("Focus 0 active, done 9")
    expect(SESSION).toContain("ses_")
  })
})

describe("isFoldStorePair", () => {
  test("accepts the documented [state, setState] pair", () => {
    expect(isFoldStorePair([{ open: true }, () => {}])).toBe(true)
  })

  test("rejects every shape that is not a usable pair", () => {
    expect(isFoldStorePair(undefined)).toBe(false)
    expect(isFoldStorePair(null)).toBe(false)
    expect(isFoldStorePair({ open: true })).toBe(false)
    expect(isFoldStorePair([null, () => {}])).toBe(false)
    expect(isFoldStorePair([undefined, () => {}])).toBe(false)
    expect(isFoldStorePair([{ open: true }])).toBe(false)
    expect(isFoldStorePair([{ open: true }, "not-a-function"])).toBe(false)
    expect(isFoldStorePair([{ open: true }, () => {}, "extra"])).toBe(false)
  })
})
