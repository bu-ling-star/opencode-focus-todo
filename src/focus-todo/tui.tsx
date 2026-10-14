/** @jsxImportSource @opentui/solid */
/**
 * focus-todo — read-only sidebar panel (TUI half).
 *
 * This file sits next to `server.ts` on purpose. OpenCode resolves a plugin
 * *directory* into two entrypoints, `<dir>/server.*` and `<dir>/tui.*`, and
 * records `features.tui` for it; the TUI then loads the `tui` entrypoint of every
 * active plugin that declares that feature. A bare `.ts` file dropped directly in
 * `.opencode/plugin/` would only ever be a server plugin — the loader short-circuits
 * absolute *file* targets to `{ server }` — so the directory shape is what makes a
 * project-local TUI plugin possible at all, with no configuration, no package
 * install and no declared dependency.
 *
 * It only reads: the newest `focus_todo` tool result in the current session's
 * message window, projected by the pure helpers in `./view.ts`. Nothing is
 * written, injected into a model request, or stored — with one deliberate
 * exception: the panel's *folded* flag persists through the host's own
 * `storage.store`, the same UI-preferences channel the built-in "getting
 * started" panel uses for its dismiss state. Todo state never touches it.
 *
 * The `id` matches the server half on purpose (same convention as the installed
 * `opencode-visual-cache`): the two halves are separate registries and only the
 * server half owns state.
 */
import { For, Show, createMemo, createSignal } from "solid-js"
import { MAX_ROW_WIDTH, buildPanel, clip, isFoldStorePair, latestFocusState, toHex } from "./view.ts"
import type { PanelRow, ViewStatus } from "./view.ts"

/**
 * Minimal hand-written view of the parts of the v2 TUI plugin API this file
 * touches. The published `@opencode-ai/plugin` types do not describe the
 * runtime, so this mirrors what the host actually passes to `setup`
 * (see IMPLEMENTATION_NOTES.md §6).
 */
/**
 * The host hands `setup` a nested colour tree whose leaves are opentui colour
 * objects (`{ buffer: Uint8Array [r, g, b, a] }`) — verified by a runtime probe
 * of the real setup context. The flat `theme.current` palette that the shipped
 * opencode-visual-cache reads belongs to the *slot-callback* context, which this
 * plugin never receives: the render function gets exactly one argument (the
 * panel input), so colours must come from the setup tree, converted to hex.
 */
interface TuiColor {
  readonly buffer?: unknown
}

interface TuiTextTheme {
  readonly base?: TuiColor | string
  readonly muted?: TuiColor | string
  readonly feedback?: {
    readonly success?: { readonly base?: TuiColor | string }
    readonly error?: { readonly base?: TuiColor | string }
  }
}

interface TuiPanelInput {
  readonly sessionID?: unknown
}

interface TuiContext {
  readonly renderer?: { readonly terminalWidth?: number }
  readonly theme?: { readonly text?: TuiTextTheme }
  readonly data?: {
    readonly session?: {
      readonly message?: { list(sessionID: string): readonly unknown[] }
    }
  }
  /**
   * Host persistence for UI preferences. `store(key, { initial })` returns a
   * `[state, setState]` pair backed by the host's own storage; the state object
   * is reactive. Only the panel's fold flag lives here — probing on the shipped
   * build confirmed the shape (`storage.store` is a function, and the built-in
   * getting-started panel persists its dismissed flag through exactly this call).
   */
  readonly storage?: {
    readonly store?: (key: string, options: { initial: unknown }) => unknown
  }
  readonly ui?: {
    slot(claim: {
      readonly prepend?: string
      readonly append?: string
      readonly render: (input: TuiPanelInput) => unknown
    }): unknown
  }
}

/** Below this the panel would be noise; keep at least a status word visible. */
const MIN_ROW_WIDTH = 14

/** Where the folded flag persists. One key, one boolean, nothing else. */
const FOLD_KEY = "focus-todo.panel"

interface Fold {
  /** Reactive read of whether the body is expanded. */
  open(): boolean
  /** Flip the flag and persist it; failures are cosmetic by construction. */
  toggle(): void
}

/**
 * Fold state from the host's `storage.store`, falling back to an in-memory
 * signal when the host does not hand back the documented `[state, setState]`
 * pair. Both paths are reactive; only persistence differs.
 */
function createFold(context: TuiContext): Fold {
  try {
    const store = context.storage?.store
    if (typeof store === "function") {
      const pair = store.call(context.storage, FOLD_KEY, { initial: { open: true } })
      if (isFoldStorePair(pair)) {
        const state = pair[0] as { open?: boolean }
        const setState = pair[1] as (updater: (draft: { open: boolean }) => void) => void
        return {
          open: () => state.open !== false,
          toggle: () => {
            try {
              const next = state.open !== false
              setState((draft) => {
                draft.open = !next
              })
            } catch {
              /* a lost fold flip is cosmetic; the panel keeps rendering */
            }
          },
        }
      }
    }
  } catch {
    /* fall through to the memory-only fold */
  }
  const [open, setOpen] = createSignal(true)
  return { open, toggle: () => setOpen((value) => !value) }
}

/**
 * The sidebar pane is about a third of the terminal, and the host hides it
 * entirely on narrow terminals, so a share of the terminal width is a safe
 * budget. Rows are clipped to it; the host may still wrap when the actual slot
 * is narrower than the renderer's reported terminal width.
 */
function rowWidth(terminalWidth: unknown): number {
  if (typeof terminalWidth !== "number" || !Number.isFinite(terminalWidth) || terminalWidth <= 0) {
    return MIN_ROW_WIDTH
  }
  return Math.max(MIN_ROW_WIDTH, Math.min(MAX_ROW_WIDTH, Math.floor(terminalWidth / 3) - 2))
}

function statusColor(theme: TuiTextTheme | undefined, status: ViewStatus): string | undefined {
  if (status === "done") {
    // Marked rows stay visible but recede: the open work is what deserves attention.
    return toHex(theme?.muted)
  }
  if (status === "in_progress") {
    return toHex(theme?.feedback?.success?.base)
  }
  if (status === "blocked") {
    return toHex(theme?.feedback?.error?.base)
  }
  // Pending rows are the actionable backlog: plain text colour, brighter than done.
  return toHex(theme?.base)
}

function FocusTodoPanel(props: { readonly context: TuiContext; readonly input: TuiPanelInput }) {
  // Reading `input.sessionID` inside the memo keeps the panel bound to whatever
  // session the slot currently reports.
  const width = createMemo(() => rowWidth(props.context.renderer?.terminalWidth))
  const fold = createFold(props.context)
  const panel = createMemo(() => {
    try {
      const sessionID = props.input?.sessionID
      if (typeof sessionID !== "string" || sessionID.length === 0) {
        // No session yet: the panel stays visible as the same empty state it
        // shows before the first focus_todo call, rather than flickering away.
        return buildPanel(undefined, width())
      }
      const messages = props.context.data?.session?.message?.list(sessionID) ?? []
      const view = latestFocusState(messages)
      return buildPanel(view, width())
    } catch {
      // A failed read must never take the sidebar down with it.
      return buildPanel(undefined, width())
    }
  })

  return (
    <box flexDirection="column">
      <text
        fg={toHex(props.context.theme?.text?.base)}
        truncate
        onMouseUp={() => fold.toggle()}
      >
        {`${fold.open() ? "▼" : "▶"} ${clip(panel()?.header ?? "", Math.max(1, width() - 2))}`}
      </text>
      <Show when={fold.open()}>
        <For each={panel()?.rows ?? []}>
          {(row: PanelRow) => (
            <text fg={statusColor(props.context.theme?.text, row.status)} truncate>
              {row.line}
            </text>
          )}
        </For>
      </Show>
    </box>
  )
}

const mod = {
  id: "focus-todo",
  setup(context: TuiContext): (() => void) | undefined {
    if (typeof context?.ui?.slot !== "function") return undefined
    if (typeof context.data?.session?.message?.list !== "function") return undefined

    // `append` keeps the panel after the session header, alongside the built-in
    // contributions; the host consumes both prepend and append claims through the
    // same slot tree, and append matches what every shipped panel uses.
    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: (input) => <FocusTodoPanel context={context} input={input} />,
    })

    return () => {
      try {
        if (typeof unregister === "function") unregister()
      } catch {
        // The host also releases the slot on unload; a failure here is not fatal.
      }
    }
  },
}

export default mod
