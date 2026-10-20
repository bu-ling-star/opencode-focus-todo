/**
 * Integration test for the TUI half (`src/focus-todo/tui.tsx`).
 *
 * The real thing runs only inside a running TUI, so this file substitutes the
 * two modules the host injects — `solid-js` and the OpenTUI JSX runtime — with
 * minimal shims and then imports, sets up and renders the plugin for real. That
 * exercises everything the host would: entrypoint resolution, the slot claim,
 * the session → messages → panel data path and the cleanup contract. What it
 * does not exercise is Solid's fine-grained reactivity, which is the host's own
 * behaviour, not this plugin's.
 *
 * Run with `bun test`.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test"

type Node = { readonly type: unknown; readonly props: Record<string, unknown> }

function jsx(type: unknown, props: Record<string, unknown> = {}): unknown {
  // The real runtimes call function components here; intrinsic elements stay as nodes.
  if (typeof type === "function") return (type as (props: Record<string, unknown>) => unknown)(props)
  return { type, props }
}

// Registered before the dynamic import below, so the plugin module graph sees them.
mock.module("@opentui/solid/jsx-runtime", () => ({
  jsx,
  jsxs: jsx,
  jsxDEV: jsx,
  Fragment: (props: Record<string, unknown>) => props["children"],
}))

// Bun's dev-mode transform resolves the dev runtime instead of jsx-runtime.
mock.module("@opentui/solid/jsx-dev-runtime", () => ({
  jsx,
  jsxs: jsx,
  jsxDEV: jsx,
  Fragment: (props: Record<string, unknown>) => props["children"],
}))

mock.module("solid-js", () => ({
  // No reactivity needed here: every render in this file is a fresh call.
  createMemo: <T>(compute: () => T): (() => T) => compute,
  createSignal: <T>(initial: T): [() => T, (next: T | ((prev: T) => T)) => T] => {
    let value = initial
    return [
      () => value,
      (next) => {
        value = typeof next === "function" ? (next as (prev: T) => T)(value) : next
        return value
      },
    ]
  },
  For: (props: { each?: readonly unknown[]; children?: (item: unknown, index: () => number) => unknown }) =>
    (props.each ?? []).map((item, index) => props.children?.(item, () => index)),
  Show: (props: { when?: unknown; children?: unknown }) =>
    // Solid branches on truthiness, so an empty status string renders no line.
    props.when ? props.children : undefined,
}))

const { default: plugin } = await import("../src/focus-todo/tui.tsx")
const { forgetPanelState } = await import("../src/focus-todo/tui.tsx")
const { TOOL_NAME } = await import("../src/focus-todo/view.ts")

// The panel remembers the last state it saw per session, so every test starts clean.
beforeEach(() => forgetPanelState())

const SESSION = "ses_panel0000aaaaaaaaaaaaaaaaaaaaa"

function toolPart(text: string) {
  return {
    type: "tool",
    name: TOOL_NAME,
    state: { status: "completed", input: { action: "list" }, content: [{ type: "text", text }] },
  }
}

/** Flat palette behind `theme.current` — the shape the host actually hands over. */
const THEME = {
  text: {
    base: "#base",
    muted: "#muted",
    feedback: { success: { base: "#ok" }, error: { base: "#bad" } },
  },
}

/** Records slot claims and their render functions. */
function fakeContext(sessions: Record<string, unknown[]> = {}, options: { foldState?: { open: boolean } } = {}) {
  const claims: {
    prepend?: string
    append?: string
    after?: string
    render: (input: { sessionID?: unknown }) => unknown
  }[] = []
  let unregistered = 0
  const context = {
    options: {},
    renderer: { terminalWidth: 120 },
    theme: THEME,
    data: {
      session: {
        message: {
          list: (sessionID: string) => sessions[sessionID] ?? [],
        },
      },
    },
    ...(options.foldState
      ? {
          // Mimics the host's `storage.store`: same [state, setter] pair for the same
          // key on every call, the setter mutating the shared state object.
          storage: {
            store(_key: string, _options: { initial: unknown }) {
              const shared = options.foldState!
              return [
                shared,
                (updater: (draft: { open: boolean }) => void) => {
                  updater(shared)
                },
              ]
            },
          },
        }
      : {}),
    ui: {
      slot(claim: { prepend?: string; append?: string; after?: string; render: (input: { sessionID?: unknown }) => unknown }) {
        claims.push(claim)
        return () => {
          unregistered += 1
        }
      },
    },
  }
  return { context, claims, unregistered: () => unregistered }
}

/** Every string a rendered element put on screen. */
function renderText(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) renderText(entry, out)
    return out
  }
  if (typeof value === "string") {
    out.push(value)
    return out
  }
  if (typeof value === "object" && value !== null) {
    const node = value as Node
    renderText(node.props["children"], out)
  }
  return out
}

describe("plugin directory discovery", () => {
  const pluginDir = `${import.meta.dir}/../src/focus-todo`

  test("one plugin directory resolves both entrypoints the host probes", () => {
    // `_E({ directory })` tries "<dir>/server" and "<dir>/tui" with extension
    // resolution; exactly these two calls. Resolving `tui` is what gives the
    // plugin record `features.tui`, which is what makes the TUI load it.
    expect(Bun.resolveSync(`${pluginDir}/server`, pluginDir).replace(/\\/g, "/")).toContain(
      "src/focus-todo/server.ts",
    )
    expect(Bun.resolveSync(`${pluginDir}/tui`, pluginDir).replace(/\\/g, "/")).toContain(
      "src/focus-todo/tui.tsx",
    )
  })

  test("the module exports the { id, setup } shape the TUI loader requires", () => {
    expect(plugin.id).toBe("focus-todo")
    expect(typeof plugin.setup).toBe("function")
  })

  test("the directory is self-contained, so one copy installs it", () => {
    // `tui.tsx` imports "./view.ts" — a module inside its own directory, not a
    // package and not something at the project root. That is what makes copying
    // this directory into <config>/opencode/plugin/ a complete install, in any
    // project. All three files must resolve from inside the directory.
    for (const entry of ["server.ts", "tui.tsx", "view.ts"]) {
      expect(Bun.resolveSync(`${pluginDir}/${entry}`, pluginDir).replace(/\\/g, "/")).toContain(
        `src/focus-todo/${entry}`,
      )
    }
  })
})

describe("sidebar slot", () => {
  test("claims exactly one slot, pinned after every append claim on sidebar.content", () => {
    const { context, claims } = fakeContext()
    plugin.setup(context)

    expect(claims).toHaveLength(1)
    // `after` is what puts the panel below the cli.json plugins: the host renders
    // before → prepend → children → append → after.
    expect(claims[0]?.after).toBe("sidebar.content")
    expect(claims[0]?.append).toBeUndefined()
    expect(typeof claims[0]?.render).toBe("function")
  })

  test("returns a cleanup that releases the slot", () => {
    const { context, unregistered } = fakeContext()
    const cleanup = plugin.setup(context)

    expect(typeof cleanup).toBe("function")
    expect(unregistered()).toBe(0)
    cleanup?.()
    expect(unregistered()).toBe(1)
  })

  test("stays inert instead of throwing when the context lacks the TUI surface", () => {
    expect(plugin.setup({} as never)).toBeUndefined()
    expect(plugin.setup({ ui: {} } as never)).toBeUndefined()
    expect(plugin.setup({ ui: { slot: () => () => {} } } as never)).toBeUndefined()
    expect(plugin.setup({ ui: { slot: () => () => {} }, data: {} } as never)).toBeUndefined()
    expect(plugin.setup(undefined as never)).toBeUndefined()
  })
})

describe("panel rendering", () => {
  test("renders the newest focus_todo result for the slot's session", () => {
    const conversation: unknown[] = [
      { type: "assistant", content: [toolPart("2 active, done=1\nt1:> implement storage\nt2:- add tests")] },
    ]
    const { context, claims } = fakeContext({ [SESSION]: conversation })
    plugin.setup(context)

    const tree = claims[0]?.render({ sessionID: SESSION })
    expect(renderText(tree)).toEqual(["▼ Focus 2 active, done 1", "▶ t1 implement storage", "○ t2 add tests"])

    // A newer user message changes server-side request context, not the facts shown here.
    conversation.push({ role: "user", content: "go on" })
    expect(renderText(claims[0]?.render({ sessionID: SESSION }))).toEqual(["▼ Focus 2 active, done 1", "▶ t1 implement storage", "○ t2 add tests"])
  })

  test("renders the count when nothing is open and no rows are left", () => {
    const { context, claims } = fakeContext({
      [SESSION]: [{ type: "assistant", content: [toolPart("0 active, done=4")] }],
    })
    plugin.setup(context)

    // The marks were removed one by one, so there is nothing to list; `all done` over an
    // empty body would read like a rendering bug, so the count is stated instead.
    expect(renderText(claims[0]?.render({ sessionID: SESSION }))).toEqual(["▼ Focus 0 active, done 4"])
  })

  test("renders all done plus the marked rows while they are still there", () => {
    const { context, claims } = fakeContext({
      [SESSION]: [
        { type: "assistant", content: [toolPart("0 active, done=2\nt2:x add tests\nt1:x implement storage")] },
      ],
    })
    plugin.setup(context)

    expect(renderText(claims[0]?.render({ sessionID: SESSION }))).toEqual([
      "▼ Focus: all done",
      "✓ t2 add tests",
      "✓ t1 implement storage",
    ])
  })

  test("says 暂无待办 before the tool has ever been used", () => {
    const { context, claims } = fakeContext({ [SESSION]: [{ type: "assistant", content: [{ type: "text", text: "hi" }] }] })
    plugin.setup(context)

    // No list, and the window cannot prove whether the invitation went out, so the panel shows
    // exactly one line and makes no reminder claim.
    expect(renderText(claims[0]?.render({ sessionID: SESSION }))).toEqual(["▼ 暂无待办"])
  })

  test("keeps showing the empty state when the slot reports no session", () => {
    const { context, claims } = fakeContext({ [SESSION]: [{ type: "assistant", content: [toolPart("1 active, done=0\nt1:> x")] }] })
    plugin.setup(context)

    // The panel is a permanent fixture of the sidebar: without a session it shows
    // the same empty state as before the first call, it does not disappear.
    expect(renderText(claims[0]?.render({}))).toEqual(["▼ 暂无待办"])
    expect(renderText(claims[0]?.render({ sessionID: 42 }))).toEqual(["▼ 暂无待办"])
  })

  test("keeps sessions apart", () => {
    const { context, claims } = fakeContext({
      [SESSION]: [{ type: "assistant", content: [toolPart("1 active, done=0\nt1:> mine")] }],
      ses_other0000bbbbbbbbbbbbbbbbbbbbb: [{ type: "assistant", content: [toolPart("0 active, done=2")] }],
    })
    plugin.setup(context)

    expect(renderText(claims[0]?.render({ sessionID: SESSION }))).toEqual(["▼ Focus 1 active", "▶ t1 mine"])
    expect(renderText(claims[0]?.render({ sessionID: "ses_other0000bbbbbbbbbbbbbbbbbbbbb" }))).toEqual([
      "▼ Focus 0 active, done 2",
    ])
  })

  test("keeps showing the last state after its result scrolls out of the window", () => {
    // The host holds the last 20 messages by default, so a long turn drops the very
    // focus_todo result the panel reads; blanking to 暂无待办 mid-plan is a lie.
    const conversation: unknown[] = [
      { type: "assistant", content: [toolPart("2 active, done=0\nt1:> alpha\nt2:- beta")] },
    ]
    const { context, claims } = fakeContext({ [SESSION]: conversation })
    plugin.setup(context)

    const expected = ["▼ Focus 2 active", "▶ t1 alpha", "○ t2 beta"]
    expect(renderText(claims[0]?.render({ sessionID: SESSION }))).toEqual(expected)

    for (let index = 0; index < 70; index += 1) {
      conversation.push({ role: "assistant", content: [{ type: "text", text: "x" }] })
    }
    expect(renderText(claims[0]?.render({ sessionID: SESSION }))).toEqual(expected)

    // A cleared list is a real result and must still replace what was remembered.
    conversation.push({ type: "assistant", content: [toolPart("0 active, done=0")] })
    expect(renderText(claims[0]?.render({ sessionID: SESSION }))).toEqual(["▼ 暂无待办"])
  })

  test("a broken message store degrades to an empty panel, not a throw", () => {
    const { context, claims } = fakeContext()
    const broken = {
      ...context,
      data: {
        session: {
          message: {
            list() {
              throw new Error("store unavailable")
            },
          },
        },
      },
    }
    plugin.setup(broken as never)

    expect(renderText(claims[0]?.render({ sessionID: SESSION }))).toEqual(["▼ 暂无待办"])
  })

  test("clips rows to the fixed sidebar budget, with an ellipsis", () => {
    const long = "x".repeat(200)
    const { context, claims } = fakeContext({
      [SESSION]: [{ type: "assistant", content: [toolPart(`1 active, done=0\nt1:> ${long}`)] }],
    })
    plugin.setup({ ...context, renderer: { terminalWidth: 200 } } as never)

    const lines = renderText(claims[0]?.render({ sessionID: SESSION }))
    expect(lines).toHaveLength(2)
    // The sidebar is a fixed 42 columns wide whatever the terminal is, so the row budget
    // is a constant 37 — and text that does not fit says so instead of being hard-cut.
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(37)
    expect(lines[1]?.endsWith("…")).toBe(true)

    // A terminal narrower than the sidebar itself must still not widen the rows.
    const narrow = fakeContext({
      [SESSION]: [{ type: "assistant", content: [toolPart(`1 active, done=0\nt1:> ${long}`)] }],
    })
    plugin.setup({ ...narrow.context, renderer: { terminalWidth: 30 } } as never)
    for (const line of renderText(narrow.claims[0]?.render({ sessionID: SESSION }))) {
      expect(line.length).toBeLessThanOrEqual(30)
    }
  })

  test("colours in-progress, pending and blocked rows differently", () => {
    const { context, claims } = fakeContext({
      [SESSION]: [
        { type: "assistant", content: [toolPart("3 active, done=0\nt1:> a\nt2:- b\nt3:! c")] },
      ],
    })
    plugin.setup(context)

    const collected: (string | undefined)[] = []
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const entry of value) walk(entry)
        return
      }
      if (typeof value === "object" && value !== null) {
        const node = value as Node
        if (node.type === "text") collected.push(node.props["fg"] as string | undefined)
        walk(node.props["children"])
      }
    }
    walk(claims[0]?.render({ sessionID: SESSION }))
    // Header, then the three rows — done recedes, pending is plain
    // text colour, in-progress is success green, blocked is error red.
    expect(collected).toEqual([
      THEME.text.base,
      THEME.text.feedback.success.base,
      THEME.text.base,
      THEME.text.feedback.error.base,
    ])
  })
})

/** First node matching `type` whose props satisfy `predicate`, depth-first. */
function findNode(value: unknown, type: unknown, predicate: (node: Node) => boolean): Node | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findNode(entry, type, predicate)
      if (found) return found
    }
    return undefined
  }
  if (typeof value === "object" && value !== null) {
    const node = value as Node
    if (node.type === type && predicate(node)) return node
    return findNode(node.props["children"], type, predicate)
  }
  return undefined
}

describe("fold", () => {
  const conversation = (): Record<string, unknown[]> => ({
    [SESSION]: [{ type: "assistant", content: [toolPart("1 active, done=0\nt1:> mine")] }],
  })

  test("starts expanded: the fold glyph marks the header and the body is present", () => {
    const { context, claims } = fakeContext(conversation(), { foldState: { open: true } })
    plugin.setup(context)

    const lines = renderText(claims[0]?.render({ sessionID: SESSION }))
    expect(lines[0]).toBe("▼ Focus 1 active")
    expect(lines).toContain("▶ t1 mine")
  })

  test("clicking the header folds the panel and persists the flag", () => {
    const foldState = { open: true }
    const { context, claims } = fakeContext(conversation(), { foldState })
    plugin.setup(context)

    const header = findNode(
      claims[0]?.render({ sessionID: SESSION }),
      "text",
      (node) => typeof node.props["onMouseUp"] === "function",
    )
    expect(typeof header?.props["onMouseUp"]).toBe("function")
    ;(header?.props["onMouseUp"] as () => void)()

    // The flag landed in the host's storage...
    expect(foldState.open).toBe(false)
    // ...and a fresh render (a new component instance, e.g. after a session switch)
    // still reads the folded flag from the same shared state object.
    expect(renderText(claims[0]?.render({ sessionID: SESSION }))).toEqual(["▶ Focus 1 active"])
  })

  test("without a host store the fold still works, it merely resets on restart", () => {
    const { context, claims } = fakeContext(conversation())
    plugin.setup(context)

    // Expanded on first render, and the toggle is wired without throwing.
    expect(renderText(claims[0]?.render({ sessionID: SESSION }))[0]).toBe("▼ Focus 1 active")
    const header = findNode(
      claims[0]?.render({ sessionID: SESSION }),
      "text",
      (node) => typeof node.props["onMouseUp"] === "function",
    )
    let threw = false
    try {
      ;(header?.props["onMouseUp"] as () => void)()
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
  })
})
