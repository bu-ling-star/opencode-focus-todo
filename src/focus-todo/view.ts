/**
 * Pure view logic for the focus-todo sidebar panel.
 *
 * Deliberately free of SolidJS/OpenTUI imports: the TUI entrypoint (`tui.tsx`)
 * is compiled by OpenCode's own pipeline and cannot be loaded outside a running
 * TUI, so every decision worth testing lives here and is imported by `bun test`
 * directly.
 *
 * It sits inside the plugin directory so that copying that one directory is a
 * complete install: the panel resolves it relatively (`./view.ts`) and nothing
 * outside the directory is needed. `server.ts` does not import it — the tool
 * half stays dependency-free and knows nothing about the panel.
 *
 * The panel is a read-only projection of the newest `focus_todo` tool result in
 * the session. It writes nothing anywhere: the tool remains the single source of
 * truth, and a missing or unparsable result simply renders `暂无待办`.
 *
 * The panel deliberately renders facts only. Reminder delivery is a request-tail
 * concern owned by the server half and is not exposed as a guessed status line.
 */

/** Must match `server.ts` — the tool result is the data source. */
export const TOOL_NAME = "focus_todo"

/** Must match `MAX_ITEMS` in `server.ts` — a test asserts it, so the two cannot drift. */
export const MAX_OPEN_ROWS = 16
/** Must match `MAX_DONE` in `server.ts` — a test asserts it. */
export const MAX_DONE_ROWS = 10
/** The longest list the tool can ever produce: open rows plus marked ones. */
export const MAX_ROWS = MAX_OPEN_ROWS + MAX_DONE_ROWS

/** Never emit a row wider than this many terminal columns. */
export const MAX_ROW_WIDTH = 96

/** How far back to look for the newest tool result; bounds the per-render cost. */
export const MESSAGE_SCAN_LIMIT = 60

export type ViewStatus = "in_progress" | "pending" | "blocked" | "done"

export interface ViewItem {
  readonly id: string
  readonly status: ViewStatus
  readonly text: string
}

export interface FocusView {
  readonly active: number
  readonly done: number
  readonly items: readonly ViewItem[]
}

export interface PanelRow {
  readonly status: ViewStatus
  readonly line: string
}

export interface Panel {
  readonly header: string
  readonly rows: readonly PanelRow[]
}

/** Mark the parser accepts, kept identical to what the model sees in the tool result. */
const STATUS_BY_MARK: Record<string, ViewStatus> = {
  ">": "in_progress",
  "-": "pending",
  "!": "blocked",
  x: "done",
}

/**
 * What the panel draws instead of the tool result's compact letter marks: a
 * scannable status column — ▶ running, ○ open, ! blocked, ✓ finished. Display
 * only; the parser above still reads the letter marks the server prints.
 */
export const DISPLAY_MARK: Record<ViewStatus, string> = { in_progress: "▶", pending: "○", blocked: "!", done: "✓" }

/** `formatState` header: `"3 active, done=2"`. */
const HEADER = /^(\d{1,4}) active, done=(\d{1,6})$/
/** `formatState` item line: `"t1:> implement storage"`, done rows as `"t2:x add tests"`. */
const ITEM = /^([A-Za-z0-9_-]{1,16}):([>-]|!|x) (.*)$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * Parse the text `formatState` produces. The tool may prefix a `warn=` notice
 * line, so the header is searched for rather than required first; everything
 * after it must be well-formed item lines or the whole dump is rejected, since
 * a body we do not understand must not be shown as if it were understood.
 */
export function parseFocusState(text: unknown): FocusView | undefined {
  if (typeof text !== "string") return undefined
  const lines = text.split("\n")
  const start = lines.findIndex((line) => HEADER.test(line.trimEnd()))
  if (start === -1) return undefined

  const items: ViewItem[] = []
  let open = 0
  let marked = 0
  for (const line of lines.slice(start + 1)) {
    if (line.length === 0) continue
    const match = ITEM.exec(line)
    if (!match) return undefined
    const status = STATUS_BY_MARK[match[2] ?? ""]
    if (status === undefined) return undefined
    // The tool caps both halves, so a longer body did not come from it.
    if (status === "done") marked += 1
    else open += 1
    if (open > MAX_OPEN_ROWS || marked > MAX_DONE_ROWS) return undefined
    items.push({ id: match[1] ?? "", status, text: match[3] ?? "" })
  }

  const declared = Number(HEADER.exec(lines[start]?.trimEnd() ?? "")?.[2] ?? 0)
  const done = Number.isFinite(declared) && declared >= 0 ? declared : 0
  // `active` counts the unmarked rows, so the panel cannot disagree with itself if a
  // future header ever drifts.
  return { active: items.filter((item) => item.status !== "done").length, done, items }
}

/**
 * Read the state out of one tool part. Both shapes are accepted: the persisted
 * form (`state.content[]` text parts, what a reloaded session has) and the
 * legacy `state.output` string.
 */
export function extractFocusState(part: unknown): FocusView | undefined {
  if (!isRecord(part) || part["name"] !== TOOL_NAME) return undefined
  const state = part["state"]
  if (!isRecord(state) || state["status"] !== "completed") return undefined

  const content = state["content"]
  if (Array.isArray(content)) {
    const text = content
      .filter(isRecord)
      .filter((entry) => entry["type"] === "text")
      .map((entry) => (typeof entry["text"] === "string" ? entry["text"] : ""))
      .join("")
    const parsed = parseFocusState(text)
    if (parsed !== undefined) return parsed
  }

  return parseFocusState(state["output"])
}

/**
 * Newest `focus_todo` result in the session's messages, or undefined when none
 * is present in the window the TUI currently holds.
 */
export function latestFocusState(messages: unknown): FocusView | undefined {
  if (!Array.isArray(messages)) return undefined
  const first = Math.max(0, messages.length - MESSAGE_SCAN_LIMIT)
  for (let index = messages.length - 1; index >= first; index -= 1) {
    const message = messages[index]
    const content = isRecord(message) ? message["content"] : undefined
    if (!Array.isArray(content)) continue
    for (let part = content.length - 1; part >= 0; part -= 1) {
      const found = extractFocusState(content[part])
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** East Asian wide / fullwidth and emoji occupy two columns in a terminal. */
const WIDE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u

export function charWidth(char: string): number {
  return WIDE.test(char) ? 2 : 1
}

export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) width += charWidth(char)
  return width
}

/** Single-line clip to `width` columns, appending `…` when text is dropped. */
export function clip(text: string, width: number): string {
  if (width <= 0) return ""
  if (displayWidth(text) <= width) return text
  const budget = width - 1
  let out = ""
  let used = 0
  for (const char of text) {
    const next = used + charWidth(char)
    if (next > budget) break
    out += char
    used = next
  }
  return `${out}…`
}

/**
 * Normalise a host theme leaf into a `#rrggbb` string. The host ships opentui
 * colour objects (`{ buffer: Uint8Array [r, g, b, a] }`), and the panel's `fg`
 * prop accepts hex strings; a plain `#hex` leaf passes straight through, and a
 * `{ r, g, b }` triple is accepted for future hosts. The buffer is duck-typed
 * rather than `instanceof`-checked so a cross-realm typed array still parses.
 * Anything else returns undefined and the caller falls back to the default colour.
 */
export function toHex(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw.length > 0) return raw
  if (raw === null || typeof raw !== "object") return undefined
  const view = (raw as { buffer?: unknown }).buffer
  if (view !== null && typeof view === "object") {
    const octets = view as { readonly length?: number }
    const first = (view as readonly unknown[])[0]
    if (typeof octets.length === "number" && octets.length >= 3 && typeof first === "number") {
      const [r, g, b] = view as readonly number[]
      return `#${[r, g, b].map((value) => (value as number).toString(16).padStart(2, "0")).join("")}`
    }
  }
  const rgb = raw as { r?: unknown; g?: unknown; b?: unknown }
  if (typeof rgb.r === "number" && typeof rgb.g === "number" && typeof rgb.b === "number") {
    // Any channel above 1 marks the triple as 0..255; otherwise treat it as 0..1 floats.
    const scale = rgb.r > 1 || rgb.g > 1 || rgb.b > 1 ? 1 : 255
    return `#${[rgb.r, rgb.g, rgb.b].map((value) => Math.max(0, Math.min(255, Math.round((value as number) * scale))).toString(16).padStart(2, "0")).join("")}`
  }
  return undefined
}

/**
 * Build what the panel shows.
 *
 *  - no state known, or nothing to show → one line, `暂无待办`
 *  - nothing open, marked rows left     → `Focus: all done` plus those rows
 *  - nothing open, no rows left         → `Focus 0 active, done N` (the marks were
 *    removed one by one, so the count is all there is; `all done` over an empty body
 *    would read like a rendering bug)
 *  - otherwise                          → the counts plus every row, marked rows last
 */
export function buildPanel(view: FocusView | undefined, width: number = MAX_ROW_WIDTH): Panel {
  const rowsOf = (items: readonly ViewItem[]): PanelRow[] =>
    items.slice(0, MAX_ROWS).map((item) => ({
      status: item.status,
      line: clip(`${DISPLAY_MARK[item.status]} ${item.id} ${item.text}`, width),
    }))

  if (view === undefined || (view.active === 0 && view.done === 0)) {
    return { header: clip("暂无待办", width), rows: [] }
  }

  if (view.active === 0) {
    if (view.items.length > 0) return { header: "Focus: all done", rows: rowsOf(view.items) }
    return { header: clip(`Focus 0 active, done ${view.done}`, width), rows: [] }
  }

  const suffix = view.done > 0 ? `, done ${view.done}` : ""
  return {
    header: clip(`Focus ${view.active} active${suffix}`, width),
    rows: rowsOf(view.items),
  }
}

/**
 * Whether a host `storage.store` return value is the documented `[state, setState]`
 * pair the panel needs to persist its fold flag (the built-in getting-started panel
 * persists its dismiss state through exactly this call). Anything else means the
 * host shape has drifted, and the panel falls back to an in-memory fold that merely
 * resets on restart — a UI preference, so degradation is cosmetic by design.
 */
export function isFoldStorePair(value: unknown): value is readonly [unknown, unknown] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value[0] !== null &&
    value[0] !== undefined &&
    typeof value[1] === "function"
  )
}
