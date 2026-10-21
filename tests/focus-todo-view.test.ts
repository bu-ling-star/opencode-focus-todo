/**
 * Unit tests for the sidebar panel's pure view logic. Run with `bun test`.
 *
 * The panel re-parses text the server half produced, so the most valuable tests
 * here round-trip the two halves: real `formatState` output goes in, and the
 * panel has to come back with exactly the same items.
 */

import { describe, expect, test } from "bun:test"

import { applyAction, emptyState, formatState, type TodoState } from "../src/focus-todo/server.ts"
import {
  MAX_PARSE_ROWS,
  MAX_ROW_WIDTH,
  MESSAGE_SCAN_LIMIT,
  TOOL_NAME,
  buildPanel,
  charWidth,
  chooseFocusView,
  clip,
  displayWidth,
  elapsedLabel,
  extractFocusState,
  isFocusSnapshot,
  isFocusView,
  isFoldStorePair,
  latestFocusHit,
  latestFocusState,
  parseFocusState,
  viewFromMeta,
  viewSignature,
  type FocusView,
  toHex,
} from "../src/focus-todo/view.ts"

const SESSION = "ses_view0000aaaaaaaaaaaaaaaaaaaaa"

describe("panel caps", () => {
  test("accepts a list larger than the shipped defaults", () => {
    // `maxItems` / `maxDone` are configurable, so the panel must not mirror the
    // defaults and reject a legitimate dump; only the safety ceiling applies.
    const state: TodoState = { version: 1, revision: 0, completed: 20, nextId: 0, items: [] }
    for (let index = 1; index <= 23; index += 1) {
      state.items.push({
        id: `t${index}`,
        text: `item ${index}`,
        status: "pending",
        ...(index > 20 ? { done: true } : {}),
      })
    }
    const parsed = parseFocusState(formatState(state))
    expect(parsed?.active).toBe(20)
    expect(parsed?.done).toBe(20)
    // 20 open rows plus the newest marked row; the rest is `+N done`.
    expect(parsed?.items).toHaveLength(21)
    const panel = buildPanel(parsed)
    expect(panel.openRows).toHaveLength(20)
    expect(panel.doneRows).toHaveLength(1)
  })

  test("rejects a body past the safety ceiling", () => {
    const tooMany = [`${MAX_PARSE_ROWS + 1} active, done=0`]
    for (let index = 1; index <= MAX_PARSE_ROWS + 1; index += 1) tooMany.push(`t${index}:> item ${index}`)
    expect(parseFocusState(tooMany.join("\n"))).toBeUndefined()
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

  test("ignores the collapsed done summary row", () => {
    const parsed = parseFocusState("2 active, done=9\nt1:> still open\nt2:- next\nt8:x finished\n+5 done")
    expect(parsed?.active).toBe(2)
    expect(parsed?.done).toBe(9)
    expect(parsed?.items.map((item) => item.id)).toEqual(["t1", "t2", "t8"])
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

describe("structured metadata", () => {
  const payload = {
    version: 1,
    revision: 7,
    active: 2,
    completed: 5,
    items: [
      { id: "t1", text: "implement storage", status: "in_progress", done: false, startedAt: 1_700_000_000_000 },
      { id: "t2", text: "add tests", status: "pending", done: false },
      { id: "t3", text: "ship", status: "pending", done: true },
    ],
  }

  /** The host wraps plugin metadata once more: `state.metadata.metadata.focus`. */
  function partWith(meta: unknown, text = "garbage the text parser must not be reached for") {
    return {
      type: "tool",
      id: "call_1",
      name: TOOL_NAME,
      state: { status: "completed", content: [{ type: "text", text }], metadata: { metadata: { focus: meta } } },
    }
  }

  test("reads the wrapped path the host persists, without touching the text", () => {
    const view = extractFocusState(partWith(payload))
    expect(view?.active).toBe(2)
    expect(view?.done).toBe(5)
    expect(view?.revision).toBe(7)
    expect(view?.items).toEqual([
      { id: "t1", text: "implement storage", status: "in_progress", startedAt: 1_700_000_000_000 },
      { id: "t2", text: "add tests", status: "pending" },
      { id: "t3", text: "ship", status: "done" },
    ])
  })

  test("accepts the unwrapped path too", () => {
    const flat = partWith(undefined)
    flat.state.metadata = { focus: payload } as never
    expect(extractFocusState(flat)?.revision).toBe(7)
  })

  test("falls back to the text dump when the payload is inconsistent", () => {
    // `completed` below the marked rows cannot have come from the tool, so the
    // structured path refuses it and the text result is still readable.
    const broken = { ...payload, completed: 0 }
    const part = partWith(broken, "1 active, done=1\nt1:> keep going")
    expect(extractFocusState(part)?.items).toEqual([{ id: "t1", status: "in_progress", text: "keep going" }])
  })

  test("rejects an unknown version and malformed rows", () => {
    expect(viewFromMeta({ ...payload, version: 2 })).toBeUndefined()
    expect(viewFromMeta({ ...payload, items: [{ id: "t1", text: "x", status: "running", done: false }] })).toBeUndefined()
    expect(viewFromMeta({ ...payload, items: [{ id: "t1", text: "x", status: "pending", done: false, startedAt: -1 }] })).toBeUndefined()
    expect(viewFromMeta({ ...payload, items: [{ id: "t1", text: "x", status: "pending" }] })).toBeUndefined()
    expect(viewFromMeta(undefined)).toBeUndefined()
  })

  test("a hit carries the host timestamp and message id for snapshot ordering", () => {
    const message = {
      id: "msg_9",
      type: "assistant",
      time: { completed: 1_700_000_123_000 },
      content: [partWith(payload)],
    }
    const hit = latestFocusHit([message])
    expect(hit?.messageID).toBe("msg_9")
    expect(hit?.at).toBe(1_700_000_123_000)
    // The text-only projection remains the same view.
    expect(latestFocusState([message])?.revision).toBe(7)
  })
})

describe("view timing", () => {
  const running = {
    active: 1,
    done: 0,
    items: [{ id: "t1", status: "in_progress" as const, text: "fix parser", startedAt: 1_000_000 }],
  }

  test("prefixes a running row with its age once a minute has passed", () => {
    expect(buildPanel(running, 96, 1_000_000 + 12 * 60_000).rows[0]?.line).toBe("▶ t1 12m fix parser")
    expect(buildPanel(running, 96, 1_000_000 + 65 * 60_000).rows[0]?.line).toBe("▶ t1 1h05m fix parser")
  })

  test("stays quiet for a fresh row and for rows that are not running", () => {
    expect(buildPanel(running, 96, 1_000_000 + 30_000).rows[0]?.line).toBe("▶ t1 fix parser")
    const pending = { ...running, items: [{ ...running.items[0]!, status: "pending" as const }] }
    expect(buildPanel(pending, 96, 1_000_000 + 12 * 60_000).rows[0]?.line).toBe("○ t1 fix parser")
    expect(elapsedLabel(running.items[0]!, undefined)).toBe("")
  })
})

describe("snapshot choice", () => {
  const view = (revision: number | undefined, done = 0): FocusView => ({
    active: 1,
    done,
    items: [{ id: "t1", status: "pending", text: "work" }],
    ...(revision !== undefined ? { revision } : {}),
  })

  test("revision decides when both sides have one", () => {
    expect(chooseFocusView({ view: view(8, 2), at: 100 }, { view: view(7, 1), at: 200 })).toEqual(view(8, 2))
    expect(chooseFocusView({ view: view(6, 2), at: 300 }, { view: view(7, 1), at: 200 })).toEqual(view(7, 1))
  })

  test("the host timestamp decides when revision is unavailable", () => {
    expect(chooseFocusView({ view: view(undefined, 2), at: 300 }, { view: view(undefined, 1), at: 200 })).toEqual(
      view(undefined, 2),
    )
    expect(chooseFocusView({ view: view(undefined, 2), at: 100 }, { view: view(undefined, 1), at: 200 })).toEqual(
      view(undefined, 1),
    )
  })

  test("an untimed fresh result beats the cache, and a missing side yields the other", () => {
    expect(chooseFocusView({ view: view(undefined, 2) }, { view: view(undefined, 1), at: 200 })).toEqual(
      view(undefined, 2),
    )
    expect(chooseFocusView(undefined, { view: view(9), at: 1 })).toEqual(view(9))
    expect(chooseFocusView({ view: view(9) }, undefined)).toEqual(view(9))
    expect(chooseFocusView(undefined, undefined)).toBeUndefined()
  })

  test("validates what is read back, and its signature ignores the clock", () => {
    expect(isFocusView(view(1))).toBe(true)
    expect(isFocusSnapshot({ view: view(1), at: 5 })).toBe(true)
    expect(isFocusSnapshot({ view: { active: 2, done: 0, items: [] } })).toBe(false)
    expect(isFocusSnapshot({ view: view(1), at: -5 })).toBe(false)
    expect(isFocusSnapshot("nope")).toBe(false)
    expect(viewSignature(view(3, 1))).toBe(viewSignature(view(3, 1)))
    expect(viewSignature(view(3, 1))).not.toBe(viewSignature(view(4, 1)))
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
    expect(buildPanel(undefined)).toEqual({
      header: "暂无待办",
      rows: [],
      openRows: [],
      doneRows: [],
      active: 0,
      done: 0,
    })
  })

  test("says 暂无待办 for a list that was cleared before anything finished", () => {
    expect(buildPanel(view(0, 0))).toEqual({
      header: "暂无待办",
      rows: [],
      openRows: [],
      doneRows: [],
      active: 0,
      done: 0,
    })
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
      openRows: [],
      doneRows: [],
      active: 0,
      done: 1,
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

  test("never emits more rows than the safety ceiling", () => {
    const items = Array.from({ length: MAX_PARSE_ROWS }, (_unused, index) => ({
      id: `t${index + 1}`,
      status: "pending" as const,
      text: `item ${index + 1}`,
    }))
    expect(buildPanel({ active: MAX_PARSE_ROWS, done: 0, items })?.rows).toHaveLength(MAX_PARSE_ROWS)
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
