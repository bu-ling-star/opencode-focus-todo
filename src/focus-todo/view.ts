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
 * The panel projects the newest `focus_todo` result in the session. It reads the
 * structured `metadata.focus` the tool now returns, and falls back to parsing the
 * text dump for results written before that channel existed (or when the host
 * drifts). The structured path exists because a regex over display text made the
 * panel silently blank whenever a label changed, a notice line was added, or a
 * long done row was clipped.
 *
 * The panel still renders facts only. Reminder delivery is a request-tail
 * concern owned by the server half and is not exposed as a guessed status line.
 */

/** Must match `server.ts` — the tool result is the data source. */
export const TOOL_NAME = "focus_todo"

/**
 * Safety ceiling for anything parsed here. The tool's own caps are configurable
 * (`maxItems` / `maxDone`), so the panel no longer mirrors them: it accepts what
 * the server sends and only refuses a body large enough to be a broken dump.
 */
export const MAX_PARSE_ROWS = 128

/** Never emit a row wider than this many terminal columns. */
export const MAX_ROW_WIDTH = 96

/** How far back to look for the newest tool result; bounds the per-render cost. */
export const MESSAGE_SCAN_LIMIT = 60

/** How many sessions the TUI snapshot cache keeps before evicting the oldest. */
export const SNAPSHOT_SESSIONS = 32

export type ViewStatus = "in_progress" | "pending" | "blocked" | "done"

export interface ViewItem {
  readonly id: string
  readonly status: ViewStatus
  readonly text: string
  /** Epoch ms the row entered `in_progress`; absent on text-only dumps and older states. */
  readonly startedAt?: number
}

export interface FocusView {
  readonly active: number
  /** Completions in the current plan, including rows no longer retained. */
  readonly done: number
  readonly items: readonly ViewItem[]
  /** Write epoch from the structured result; absent on a text-only dump. */
  readonly revision?: number
}

export interface PanelRow {
  readonly status: ViewStatus
  readonly line: string
}

export interface Panel {
  readonly header: string
  /** Every visible row in display order: open rows first, then marked ones. */
  readonly rows: readonly PanelRow[]
  /** Rows drawn above the done control. */
  readonly openRows: readonly PanelRow[]
  /** Rows drawn inside the collapsible done section (newest kept rows only). */
  readonly doneRows: readonly PanelRow[]
  readonly active: number
  readonly done: number
}

/** One cached view, persisted by the TUI half so a restart does not blank the panel. */
export interface FocusSnapshot {
  readonly view: FocusView
  /** Epoch ms of the result that produced this view (or when it was first seen). */
  readonly at?: number
}

/** One hit while scanning the message window. */
export interface FocusHit {
  readonly view: FocusView
  /** Epoch ms the host recorded for the result, when it records one. */
  readonly at?: number
  readonly messageID?: string
  readonly partID?: string
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
 * only; the text parser above still reads the letter marks the server prints.
 */
export const DISPLAY_MARK: Record<ViewStatus, string> = { in_progress: "▶", pending: "○", blocked: "!", done: "✓" }

/** `formatState` header: `"3 active, done=2"`. */
const HEADER = /^(\d{1,4}) active, done=(\d{1,6})$/
/** `formatState` item line: `"t1:> implement storage"`, done rows as `"t2:x add tests"`. */
const ITEM = /^([A-Za-z0-9_-]{1,16}):([>-]|!|x) (.*)$/
/** `formatState` collapse row for done rows it did not print: `"+7 done"`. */
const SUMMARY = /^\+\d{1,6} done$/
/** The tool's own id shape; a body with anything else did not come from it. */
const ID = /^[A-Za-z0-9_-]{1,16}$/
const STATUSES: readonly ViewStatus[] = ["in_progress", "pending", "blocked", "done"]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

/**
 * Parse the text `formatState` produces. The tool may prefix a `warn=` notice
 * line, so the header is searched for rather than required first; everything
 * after it must be well-formed item lines or summary rows, since a body we do
 * not understand must not be shown as if it were understood.
 *
 * Done rows are printed only for the newest few, followed by `+N done`; the
 * header's `done=` stays the authoritative completion count.
 */
export function parseFocusState(text: unknown): FocusView | undefined {
  if (typeof text !== "string") return undefined
  const lines = text.split("\n")
  const start = lines.findIndex((line) => HEADER.test(line.trimEnd()))
  if (start === -1) return undefined

  const items: ViewItem[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.length === 0) continue
    if (SUMMARY.test(line.trimEnd())) continue
    const match = ITEM.exec(line)
    if (!match) return undefined
    const status = STATUS_BY_MARK[match[2] ?? ""]
    if (status === undefined) return undefined
    if (items.length >= MAX_PARSE_ROWS) return undefined
    items.push({ id: match[1] ?? "", status, text: match[3] ?? "" })
  }

  const declared = Number(HEADER.exec(lines[start]?.trimEnd() ?? "")?.[2] ?? 0)
  const done = Number.isFinite(declared) && declared >= 0 ? declared : 0
  // `active` counts the unmarked rows, so the panel cannot disagree with itself if a
  // future header ever drifts.
  return { active: items.filter((item) => item.status !== "done").length, done, items }
}

/** The structured `focus` payload inside a completed tool part, in either wrapper shape. */
function focusMetaOf(state: Record<string, unknown>): unknown {
  const metadata = state["metadata"]
  if (!isRecord(metadata)) return undefined
  // The host wraps a plugin's metadata once more: it arrives as
  // `state.metadata.metadata.focus`. The flat shape is accepted too, so a host
  // that stops wrapping does not break the panel.
  const nested = metadata["metadata"]
  if (isRecord(nested) && nested["focus"] !== undefined) return nested["focus"]
  return metadata["focus"]
}

/**
 * Validate the structured result the tool returned. Strict on the shape and on
 * self-consistency, because a half-understood payload must fall back to the text
 * dump rather than render a guess.
 */
export function viewFromMeta(raw: unknown): FocusView | undefined {
  if (!isRecord(raw) || raw["version"] !== 1) return undefined
  const revision = raw["revision"]
  const completed = raw["completed"]
  const entries = raw["items"]
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) return undefined
  if (
    typeof completed !== "number" ||
    !Number.isInteger(completed) ||
    completed < 0 ||
    completed > Number.MAX_SAFE_INTEGER
  ) {
    return undefined
  }
  if (!Array.isArray(entries) || entries.length > MAX_PARSE_ROWS) return undefined

  const items: ViewItem[] = []
  for (const entry of entries) {
    if (!isRecord(entry)) return undefined
    const id = entry["id"]
    const text = entry["text"]
    const status = entry["status"]
    const done = entry["done"]
    if (typeof id !== "string" || !ID.test(id)) return undefined
    if (typeof text !== "string") return undefined
    if (typeof status !== "string" || !STATUSES.includes(status as ViewStatus) || status === "done") return undefined
    if (typeof done !== "boolean") return undefined
    const startedAt = entry["startedAt"]
    if (startedAt !== undefined && !isTimestamp(startedAt)) return undefined
    const viewStatus = done ? "done" : (status as ViewStatus)
    items.push({
      id,
      text,
      status: viewStatus,
      ...(startedAt !== undefined && viewStatus === "in_progress" ? { startedAt } : {}),
    })
  }

  const active = items.filter((item) => item.status !== "done").length
  const marked = items.length - active
  // Rows can be dropped by the cap, so `completed` may exceed the rows on screen;
  // it may never be smaller than the marked rows actually present.
  if (completed < marked) return undefined
  return { active, done: completed, items, revision }
}

/**
 * Read the state out of one tool part. The structured metadata wins; the text
 * dump is the fallback for parts written before the channel existed. Both the
 * persisted form (`state.content[]` text parts) and the legacy `state.output`
 * string are accepted.
 */
export function extractFocusState(part: unknown): FocusView | undefined {
  if (!isRecord(part) || part["name"] !== TOOL_NAME) return undefined
  const state = part["state"]
  if (!isRecord(state) || state["status"] !== "completed") return undefined

  const meta = viewFromMeta(focusMetaOf(state))
  if (meta !== undefined) return meta

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

function partTime(part: Record<string, unknown>): number | undefined {
  const state = part["state"]
  if (!isRecord(state)) return undefined
  const time = state["time"]
  if (!isRecord(time)) return undefined
  for (const key of ["end", "completed", "start"]) {
    const value = time[key]
    if (isTimestamp(value)) return value
  }
  return undefined
}

function messageTime(message: Record<string, unknown>): number | undefined {
  const time = message["time"]
  if (!isRecord(time)) return undefined
  for (const key of ["completed", "updated", "created"]) {
    const value = time[key]
    if (isTimestamp(value)) return value
  }
  return undefined
}

/**
 * Newest `focus_todo` hit in the session's messages, or undefined when none is
 * present in the window the TUI currently holds.
 */
export function latestFocusHit(messages: unknown): FocusHit | undefined {
  if (!Array.isArray(messages)) return undefined
  const first = Math.max(0, messages.length - MESSAGE_SCAN_LIMIT)
  for (let index = messages.length - 1; index >= first; index -= 1) {
    const message = messages[index]
    if (!isRecord(message)) continue
    const content = message["content"]
    if (!Array.isArray(content)) continue
    for (let part = content.length - 1; part >= 0; part -= 1) {
      const candidate = content[part]
      const view = extractFocusState(candidate)
      if (view === undefined) continue
      const record = isRecord(candidate) ? candidate : {}
      const at = partTime(record) ?? messageTime(message)
      return {
        view,
        ...(at !== undefined ? { at } : {}),
        ...(typeof message["id"] === "string" ? { messageID: message["id"] } : {}),
        ...(typeof record["id"] === "string" ? { partID: record["id"] } : {}),
      }
    }
  }
  return undefined
}

/** Newest `focus_todo` view in the session's messages. */
export function latestFocusState(messages: unknown): FocusView | undefined {
  return latestFocusHit(messages)?.view
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
 * How long a running row has been running, as a compact prefix (`12m `,
 * `1h05m `). Empty until a whole minute has passed, so a fresh row does not
 * flicker through `0m`.
 */
export function elapsedLabel(item: ViewItem, now: number | undefined): string {
  if (now === undefined || item.startedAt === undefined || item.status !== "in_progress") return ""
  const elapsed = now - item.startedAt
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return ""
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 60) return `${minutes}m `
  const hours = Math.floor(minutes / 60)
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m `
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
 *
 * `openRows` / `doneRows` split the body so the caller can fold the done section
 * on its own. `now` only feeds the running-row duration; without it the rows are
 * identical to the pre-duration output.
 */
export function buildPanel(view: FocusView | undefined, width: number = MAX_ROW_WIDTH, now?: number): Panel {
  const rowsOf = (items: readonly ViewItem[]): PanelRow[] =>
    items.slice(0, MAX_PARSE_ROWS).map((item) => ({
      status: item.status,
      line: clip(`${DISPLAY_MARK[item.status]} ${item.id} ${elapsedLabel(item, now)}${item.text}`, width),
    }))

  if (view === undefined || (view.active === 0 && view.done === 0)) {
    return { header: clip("暂无待办", width), rows: [], openRows: [], doneRows: [], active: 0, done: 0 }
  }

  const open = view.items.filter((item) => item.status !== "done")
  const marked = view.items.filter((item) => item.status === "done")
  const openRows = rowsOf(open)
  const doneRows = rowsOf(marked)

  if (view.active === 0) {
    if (doneRows.length > 0) {
      return { header: clip("Focus: all done", width), rows: doneRows, openRows, doneRows, active: 0, done: view.done }
    }
    return {
      header: clip(`Focus 0 active, done ${view.done}`, width),
      rows: [],
      openRows,
      doneRows,
      active: 0,
      done: view.done,
    }
  }

  const running = open.filter((item) => item.status === "in_progress").length
  const suffix = view.done > 0 ? `, done ${view.done}` : ""
  const busy = running > 0 ? ` · ${running} running` : ""
  return {
    header: clip(`Focus ${view.active} active${suffix}${busy}`, width),
    rows: [...openRows, ...doneRows],
    openRows,
    doneRows,
    active: view.active,
    done: view.done,
  }
}

/**
 * Pick the view to render when the message window and the persisted snapshot
 * disagree. Revision wins when both sides have one (structured results), the
 * host timestamp is the fallback, and an untimed fresh hit always beats the
 * cache: it is what the session is showing right now.
 */
export function chooseFocusView(
  fresh: FocusSnapshot | undefined,
  saved: FocusSnapshot | undefined,
): FocusView | undefined {
  if (fresh === undefined) return saved?.view
  if (saved === undefined) return fresh.view
  if (fresh.view.revision !== undefined && saved.view.revision !== undefined) {
    return fresh.view.revision >= saved.view.revision ? fresh.view : saved.view
  }
  if (fresh.at !== undefined && saved.at !== undefined) {
    return fresh.at >= saved.at ? fresh.view : saved.view
  }
  return fresh.view
}

/** Stable fingerprint of a view: two equal signatures mean the snapshot need not be rewritten. */
export function viewSignature(view: FocusView): string {
  const rows = view.items
    .map((item) => `${item.id}${item.status}:${item.text}:${item.startedAt ?? 0}`)
    .join("\u0000")
  return `${view.revision ?? "-"}|${view.active}|${view.done}|${rows}`
}

/** Validate a view read back from host storage; anything else is ignored, not rendered. */
export function isFocusView(value: unknown): value is FocusView {
  if (!isRecord(value)) return false
  const active = value["active"]
  const done = value["done"]
  const items = value["items"]
  const revision = value["revision"]
  if (typeof active !== "number" || !Number.isInteger(active) || active < 0 || active > MAX_PARSE_ROWS) return false
  if (typeof done !== "number" || !Number.isInteger(done) || done < 0) return false
  if (!Array.isArray(items) || items.length > MAX_PARSE_ROWS) return false
  if (revision !== undefined) {
    if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) return false
  }
  let open = 0
  let marked = 0
  for (const item of items) {
    if (!isRecord(item)) return false
    const id = item["id"]
    const text = item["text"]
    const status = item["status"]
    const startedAt = item["startedAt"]
    if (typeof id !== "string" || !ID.test(id)) return false
    if (typeof text !== "string") return false
    if (typeof status !== "string" || !STATUSES.includes(status as ViewStatus)) return false
    if (startedAt !== undefined && !isTimestamp(startedAt)) return false
    if (status === "done") marked += 1
    else open += 1
  }
  return active === open && done >= marked
}

/** Validate one snapshot entry read back from host storage. */
export function isFocusSnapshot(value: unknown): value is FocusSnapshot {
  if (!isRecord(value)) return false
  const at = value["at"]
  if (at !== undefined && !isTimestamp(at)) return false
  return isFocusView(value["view"])
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
      // The length was just checked, so the tuple shape is a fact, not a guess.
      const [r, g, b] = view as readonly [number, number, number]
      return `#${[r, g, b].map(hexByte).join("")}`
    }
  }
  const rgb = raw as { r?: unknown; g?: unknown; b?: unknown }
  if (typeof rgb.r === "number" && typeof rgb.g === "number" && typeof rgb.b === "number") {
    // Any channel above 1 marks the triple as 0..255; otherwise treat it as 0..1 floats.
    const { r, g, b } = rgb as { r: number; g: number; b: number }
    const scale = r > 1 || g > 1 || b > 1 ? 1 : 255
    return `#${[r, g, b].map((value) => hexByte(value * scale)).join("")}`
  }
  return undefined
}

/** One colour channel as two hex digits; out-of-range input is clamped, not emitted raw. */
function hexByte(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0")
}

/**
 * Whether a host `storage.store` return value is the documented `[state, setState]`
 * pair the panel needs to persist its fold flag and its session snapshots (the
 * built-in getting-started panel persists its dismiss state through exactly this
 * call). Anything else means the host shape has drifted, and the panel falls back
 * to in-memory state that merely resets on restart — UI preferences and a UI
 * cache, so degradation is cosmetic by design.
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
