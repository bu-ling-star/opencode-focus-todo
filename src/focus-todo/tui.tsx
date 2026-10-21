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
 * The panel reads the newest `focus_todo` result in the current session's message
 * window: the structured `metadata.focus` first, the text dump as a fallback. It
 * resolves that through the pure helpers in `./view.ts`. Nothing is injected into
 * a model request and no todo state is owned here. It does persist two UI-only
 * things through the host's own `storage.store` (the channel the built-in
 * "getting started" panel uses for its dismiss state):
 *
 *  - the folded flags, so the panel reopens the way the user left it;
 *  - a bounded per-session copy of the last view, so a restart (or the result
 *    scrolling out of the host's 20-message window) does not blank the panel to
 *    `暂无待办` while the list is still in storage.
 *
 * The cache is a projection, never a source of truth: a fresh tool result always
 * replaces it, and nothing is ever read back by the server half.
 *
 * The `id` matches the server half on purpose (same convention as the installed
 * `opencode-visual-cache`): the two halves are separate registries and only the
 * server half owns state.
 */
import { For, Show, createMemo, createSignal } from "solid-js"
import {
  MAX_ROW_WIDTH,
  SNAPSHOT_SESSIONS,
  buildPanel,
  chooseFocusView,
  clip,
  isFocusSnapshot,
  isFoldStorePair,
  latestFocusHit,
  toHex,
  viewSignature,
} from "./view.ts"
import type { FocusSnapshot, PanelRow, ViewStatus } from "./view.ts"

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
   * is reactive and live-syncs across instances. Both the fold flags and the
   * session snapshot live here. There is no `get` on this side — that is why the
   * TUI keeps its own bounded mirror instead of reading the server's storage.
   */
  readonly storage?: {
    readonly store?: (key: string, options: { initial: unknown }) => unknown
  }
  readonly ui?: {
    slot(claim: {
      readonly prepend?: string
      readonly append?: string
      readonly before?: string
      readonly after?: string
      readonly replace?: string
      readonly render: (input: TuiPanelInput) => unknown
    }): unknown
  }
}

/** Below this the panel would be noise; keep at least a status word visible. */
const MIN_ROW_WIDTH = 14

/**
 * The sidebar is a fixed 42 columns wide in the host's session layout (its container sets
 * `width: 42` with `paddingLeft: 2` / `paddingRight: 2`, and the content box adds one more
 * column of `paddingRight`), so 37 content columns are all a sidebar row can ever use.
 *
 * This used to be `terminalWidth / 3 - 2`, which is 64 columns on a 200-column terminal:
 * `clip()` therefore never fired, and the host hard-truncated long rows mid-word with no
 * ellipsis. Measured on a captured 200x50 frame — the panel's rows occupy columns 160–197
 * and a 58-character item ended at `…layer with` with nothing to show it was cut.
 */
const SIDEBAR_ROW_WIDTH = 37

/**
 * Memory mirror of the persisted snapshots. It serves two purposes: the obvious
 * in-process cache for a session whose result has left the window, and the
 * fallback when the host does not hand back the documented `storage.store` pair
 * (a UI preference is allowed to degrade to "resets on restart").
 */
const MEMORY_LIMIT = 64
const remembered = new Map<string, FocusSnapshot>()

function rememberSnapshot(sessionID: string, snapshot: FocusSnapshot): void {
  if (remembered.size >= MEMORY_LIMIT && !remembered.has(sessionID)) {
    // Evict the least recently added entry, not the whole map: clearing everything made the
    // panel drop back to `暂无待办` in every other session as soon as the limit was reached.
    const oldest = remembered.keys().next().value
    if (oldest !== undefined) remembered.delete(oldest)
  }
  remembered.set(sessionID, snapshot)
}

/** Test seam: forget every remembered panel state. */
export function forgetPanelState(): void {
  remembered.clear()
}

/** Where the folded flags persist. One key, two booleans, nothing else. */
const FOLD_KEY = "focus-todo.panel"
/** Where the bounded per-session view cache persists. */
const SNAPSHOT_KEY = "focus-todo.snapshot"

interface FoldState {
  open?: boolean
  doneOpen?: boolean
}

interface Fold {
  /** Reactive read of whether the whole panel body is expanded. */
  open(): boolean
  /** Reactive read of whether the done section is expanded. */
  doneOpen(): boolean
  /** Flip the panel flag and persist it; failures are cosmetic by construction. */
  toggle(): void
  /** Flip only the done section. */
  toggleDone(): void
  /** True when the host handed back its `[state, setState]` pair. */
  readonly persistent: boolean
}

/**
 * Fold state from the host's `storage.store`, falling back to in-memory signals
 * when the host does not hand back the documented pair. Both paths are reactive;
 * only persistence differs. The done section starts collapsed, because the open
 * work is what the panel is for.
 */
function createFold(context: TuiContext): Fold {
  try {
    const store = context.storage?.store
    if (typeof store === "function") {
      const pair = store.call(context.storage, FOLD_KEY, { initial: { open: true, doneOpen: false } })
      if (isFoldStorePair(pair)) {
        const state = pair[0] as FoldState
        const setState = pair[1] as (updater: (draft: FoldState) => void) => void
        return {
          open: () => state.open !== false,
          doneOpen: () => state.doneOpen === true,
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
          toggleDone: () => {
            try {
              const next = state.doneOpen === true
              setState((draft) => {
                draft.doneOpen = !next
              })
            } catch {
              /* a lost fold flip is cosmetic; the panel keeps rendering */
            }
          },
          persistent: true,
        }
      }
    }
  } catch {
    /* fall through to the memory-only fold */
  }
  const [open, setOpen] = createSignal(true)
  const [doneOpen, setDoneOpen] = createSignal(false)
  return {
    open,
    doneOpen,
    toggle: () => setOpen((value) => !value),
    toggleDone: () => setDoneOpen((value) => !value),
    persistent: false,
  }
}

interface SessionsSnapshot {
  sessions?: Record<string, unknown>
}

interface SnapshotStore {
  /** Reactive read (inside a memo) of the last view for this session. */
  read(sessionID: string): FocusSnapshot | undefined
  /** Remember a view; written only when its signature actually changed. */
  write(sessionID: string, snapshot: FocusSnapshot): void
  readonly persistent: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function entryOf(value: unknown): FocusSnapshot | undefined {
  if (!isRecord(value)) return undefined
  return isFocusSnapshot(value) ? value : undefined
}

/**
 * Bounded per-session view cache. The host's message window keeps the last 20
 * messages, so the very result the panel projects can scroll out mid-plan; the
 * cache is the only way the panel survives both that and a restart (the TUI half
 * has no `storage.get`, so it cannot read the server's authoritative state).
 */
function createSnapshot(context: TuiContext): SnapshotStore {
  try {
    const store = context.storage?.store
    if (typeof store === "function") {
      const pair = store.call(context.storage, SNAPSHOT_KEY, { initial: { sessions: {} } })
      if (isFoldStorePair(pair)) {
        const state = pair[0] as SessionsSnapshot
        const setState = pair[1] as (updater: (draft: SessionsSnapshot) => void) => void
        return {
          read(sessionID: string): FocusSnapshot | undefined {
            const sessions = isRecord(state.sessions) ? state.sessions : undefined
            return entryOf(sessions?.[sessionID]) ?? remembered.get(sessionID)
          },
          write(sessionID: string, snapshot: FocusSnapshot): void {
            rememberSnapshot(sessionID, snapshot)
            const sessions = isRecord(state.sessions) ? state.sessions : undefined
            const previous = entryOf(sessions?.[sessionID])
            if (previous !== undefined && viewSignature(previous.view) === viewSignature(snapshot.view)) return
            try {
              setState((draft) => {
                const next: Record<string, unknown> = { ...(isRecord(draft.sessions) ? draft.sessions : {}) }
                next[sessionID] = snapshot
                const ids = Object.keys(next)
                if (ids.length > SNAPSHOT_SESSIONS) {
                  ids.sort((a, b) => (entryOf(next[a])?.at ?? 0) - (entryOf(next[b])?.at ?? 0))
                  for (const id of ids.slice(0, ids.length - SNAPSHOT_SESSIONS)) delete next[id]
                }
                draft.sessions = next
              })
            } catch {
              /* a lost cache write costs one blank panel after restart, nothing else */
            }
          },
          persistent: true,
        }
      }
    }
  } catch {
    /* fall through to the memory-only cache */
  }
  return {
    read: (sessionID) => remembered.get(sessionID),
    write: rememberSnapshot,
    persistent: false,
  }
}

/**
 * The sidebar is a fixed-width pane of the host's own session layout — it is not a share
 * of the terminal, so a constant budget is what actually fits. The terminal width only
 * matters when it is smaller than the sidebar would need.
 */
function rowWidth(terminalWidth: unknown): number {
  const limit =
    typeof terminalWidth === "number" && Number.isFinite(terminalWidth) && terminalWidth > 0
      ? Math.min(SIDEBAR_ROW_WIDTH, Math.floor(terminalWidth))
      : SIDEBAR_ROW_WIDTH
  return Math.max(MIN_ROW_WIDTH, Math.min(MAX_ROW_WIDTH, limit))
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
  const snapshot = createSnapshot(props.context)
  const panel = createMemo(() => {
    try {
      const sessionID = props.input?.sessionID
      if (typeof sessionID !== "string" || sessionID.length === 0) {
        // No session yet: the panel stays visible as the same empty state it
        // shows before the first focus_todo call, rather than flickering away.
        return buildPanel(undefined, width())
      }
      const messages = props.context.data?.session?.message?.list(sessionID) ?? []
      const hit = latestFocusHit(messages)
      const fresh = hit === undefined ? undefined : { view: hit.view, ...(hit.at !== undefined ? { at: hit.at } : {}) }
      const saved = snapshot.read(sessionID)
      const chosen = chooseFocusView(fresh, saved)
      // A fresh result always wins (or beats the cache by revision); the cache is
      // only rewritten when it does not already hold this exact view.
      if (chosen !== undefined && chosen !== saved?.view) {
        snapshot.write(sessionID, { view: chosen, at: hit?.at ?? Date.now() })
      }
      return buildPanel(chosen, width(), Date.now())
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
        <For each={panel()?.openRows ?? []}>
          {(row: PanelRow) => (
            <text fg={statusColor(props.context.theme?.text, row.status)} truncate>
              {row.line}
            </text>
          )}
        </For>
        <Show when={panel()?.active !== 0 && (panel()?.doneRows.length ?? 0) > 0}>
          <text
            fg={toHex(props.context.theme?.text?.muted)}
            truncate
            onMouseUp={() => fold.toggleDone()}
          >
            {clip(`${fold.doneOpen() ? "▾" : "▸"} ✓ ${panel()?.done ?? 0} done`, width())}
          </text>
          <Show when={fold.doneOpen()}>
            <For each={panel()?.doneRows ?? []}>
              {(row: PanelRow) => (
                <text fg={statusColor(props.context.theme?.text, row.status)} truncate>
                  {row.line}
                </text>
              )}
            </For>
          </Show>
        </Show>
        <Show when={panel()?.active === 0}>
          <For each={panel()?.doneRows ?? []}>
            {(row: PanelRow) => (
              <text fg={statusColor(props.context.theme?.text, row.status)} truncate>
                {row.line}
              </text>
            )}
          </For>
        </Show>
      </Show>
    </box>
  )
}

function doctorEnabled(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  return env?.["FOCUS_TODO_DOCTOR"] === "1" || env?.["FOCUS_TODO_DOCTOR"] === "true"
}

function doctorLine(line: string): void {
  try {
    ;(globalThis as { console?: { warn?: (...args: unknown[]) => void } }).console?.warn?.(`[focus-todo/doctor] ${line}`)
  } catch {
    /* the probe must never cost the panel */
  }
}

const mod = {
  id: "focus-todo",
  setup(context: TuiContext): (() => void) | undefined {
    if (typeof context?.ui?.slot !== "function") return undefined
    if (typeof context.data?.session?.message?.list !== "function") return undefined

    // `after` pins the panel below every `append` claim (e.g. the cli.json plugins
    // such as opencode-user-timeline): the host renders slot content in the order
    // before → prepend → children → append → after, so `after` is the only way a
    // locally-discovered plugin can sit at the very bottom.
    //
    // Guarded like every step of the server setup: a host-side change to the slot API
    // must cost the panel, not abort the TUI plugin load itself.
    let unregister: unknown
    try {
      unregister = context.ui.slot({
        after: "sidebar.content",
        render: (input) => <FocusTodoPanel context={context} input={input} />,
      })
    } catch {
      return undefined
    }

    if (doctorEnabled()) {
      // Probe the one unpublished TUI surface this half depends on. The panel itself
      // degrades to an in-memory fold/cache if the shape drifts, so the probe is how
      // that silent degradation becomes visible.
      let store = "absent"
      try {
        const candidate = context.storage?.store
        if (typeof candidate === "function") {
          const pair = candidate.call(context.storage, FOLD_KEY, { initial: { open: true, doneOpen: false } })
          store = isFoldStorePair(pair) ? "pair" : "unexpected"
        }
      } catch {
        store = "fail"
      }
      doctorLine(`tui.storage.store=${store}`)
      doctorLine("tui.slot=ok")
    }

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
