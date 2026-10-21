/**
 * focus-todo — a single, dependency-free OpenCode v2 plugin that keeps a small
 * per-session focus checklist so the agent can recover its working state after
 * long tasks, context compaction, or a restart.
 *
 * Design constraints (see IMPLEMENTATION_NOTES.md for the evidence behind them):
 * - one tool (`focus_todo`) with one `action` union; fixed description and fixed JSON Schema;
 * - one source of truth: OpenCode's official `storage` domain (no second JSON store, no DB);
 * - the only prompt influence is a per-request reminder appended as the LAST message of the
 *   outbound request, so the cacheable prefix (system prompt, tool definitions, history) is
 *   never touched; nothing is injected into the system prompt and no synthetic message is
 *   ever persisted (see `injectTail` and §9.8 of IMPLEMENTATION_NOTES.md);
 * - at most `maxItems` open items (default 16), at most 150 chars per item, at most one
 *   `in_progress`;
 * - marking done (`update` with `done: true`) keeps the row instead of deleting it: marked
 *   rows stay in the sidebar and in the tool result (short) but never in the per-request
 *   reminder, which stays open-only;
 * - setup never throws and corrupt state is reset; a tool call that cannot read or write
 *   storage throws instead of returning a success-shaped `error=...` string, so the host
 *   marks the part as failed and the sidebar falls back to its last known view;
 * - writes are serialized per session.
 *
 * Zero imports by design: the module stays importable by a test runner and cannot
 * break OpenCode startup by failing to resolve a package.
 */

export type TodoStatus = "pending" | "in_progress" | "blocked"

export interface TodoItem {
  id: string
  text: string
  status: TodoStatus
  /** Set by `update` with `done: true`: kept for the sidebar and the tool result, hidden from the reminder. */
  done?: boolean
  /**
   * Epoch milliseconds when this row entered `in_progress`. Optional so states written by
   * older versions stay valid; cleared whenever the row leaves `in_progress` or is marked done.
   */
  startedAt?: number
}

export interface TodoState {
  version: 1
  /**
   * Write epoch: advances on every stored mutation, never sent to the model. It is the
   * cheap consistency check the tests assert on (`revision advances on writes and is
   * never exposed to the model`), so keep it rather than treat it as dead data.
   */
  revision: number
  /** Completions in the *current* plan: a `done: true` update adds one, `replace` resets it. */
  completed: number
  nextId: number
  items: TodoItem[]
}

/** One row of the structured result; the sidebar reads this instead of parsing the text. */
export interface FocusMetaItem {
  id: string
  text: string
  status: TodoStatus
  done: boolean
  startedAt?: number
}

/**
 * Structured side-channel returned in `Tool.Result.metadata`. The host persists it on
 * the completed tool part, but never sends it to the model: verified against the
 * captured outbound request. The persisted shape depends on the host build — the
 * current CLI stores `state.metadata.focus`, an earlier one wrapped it once more as
 * `state.metadata.metadata.focus` — so the panel accepts both. It is versioned so the
 * TUI half can reject a shape it does not understand and fall back to the text dump.
 */
export interface FocusMeta {
  version: 1
  /** Revision of the state this result describes; newer snapshots win in the sidebar. */
  revision: number
  active: number
  completed: number
  items: FocusMetaItem[]
}

/** Per-session caps. The defaults keep the shipped behaviour; settings may raise them. */
export interface Limits {
  items: number
  done: number
}

export const MAX_ITEMS = 16
/** Marked items kept per session; the oldest ones are dropped once this is exceeded. */
export const MAX_DONE = 10
export const DEFAULT_LIMITS: Limits = { items: MAX_ITEMS, done: MAX_DONE }
/** Hard ceilings for settings: a config typo cannot turn one result into a megabyte. */
export const LIMITS_MAX = { items: 64, done: 50 } as const

/**
 * One local mutation inside `mutate`. Keeping this set small makes the public
 * tool contract easy to remember: replace a plan, or mutate existing rows.
 */
export type MutationOp =
  | { action: "add"; text: string; status?: TodoStatus }
  | { action: "update"; id: string; text?: string; status?: TodoStatus; done?: true }
  | { action: "remove"; id: string }

/** Accepted only for old `batch` calls; it is intentionally absent from the schema. */
export type LegacyBatchOp = MutationOp | { action: "replace"; items: Array<{ id?: string; text: string; status?: TodoStatus }> }

/** @deprecated Use `MutationOp`; retained so old integrations can still type-check. */
export type BatchOp = LegacyBatchOp

export type FocusTodoInput =
  | { action: "list" }
  | { action: "replace"; items: Array<{ id?: string; text: string; status?: TodoStatus }> }
  | { action: "mutate"; ops: MutationOp[] }

/** Old inputs remain executable, but are not advertised to the model. */
export type LegacyFocusTodoInput =
  | { action: "add"; text: string; status?: TodoStatus }
  | { action: "update"; id: string; text?: string; status?: TodoStatus; done?: true }
  | { action: "remove"; id: string }
  | { action: "batch"; ops: LegacyBatchOp[] }
  | { action: "complete"; id: string }
  | { action: "clear" }

/** Subset of `context.storage` that this plugin relies on. */
export interface Storage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  /** Drops a key. Optional so a host (or a test double) without it stays usable. */
  remove?(key: string): Promise<void>
}

export interface ActionResult {
  ok: true
  state: TodoState
  text: string
  /** `list` must stay read-only, so it never persists. */
  write: boolean
}

export type ActionFailure = { ok: false; error: string }

export type ActionOutcome = ActionResult | ActionFailure

export const TOOL_NAME = "focus_todo"
export const MAX_TEXT = 150
/** Upper bound on one mutation envelope: the default plan holds 16 open items, so 24 ops covers any realistic reshuffle. */
export const MAX_BATCH_OPS = 24
/** Done rows appear in every tool result, so keep them compact while retaining a useful label. */
export const DONE_TEXT_MAX = 32
/** Newest done rows kept verbatim; the rest collapse into one `+N done` summary row. */
export const DONE_ROWS_KEPT = 1
export const KEY_PREFIX = "focus-todo/session/"

/**
 * Settings come from a JSON file, not from environment variables:
 *
 *   <config>/opencode/focus-todo.json      (~/.config/opencode/focus-todo.json)
 *   <plugin dir>/focus-todo.json           (fallback, next to server.ts)
 *
 * Shape: `{ "reminder": true, "reminderBudget": 360, "staleAfter": 0, "maxItems": 16,
 * "maxDone": 10, "stalledAfter": 0 }`. Missing file, missing key, wrong type or broken
 * JSON all fall back to the defaults below, so the plugin can never be configured into a
 * broken state. The environment variables of the same names are honoured as an override
 * for tests and one-off runs.
 */
export interface Settings {
  /** Append the current list as the last message of the tail. */
  reminder: boolean
  /**
   * Bound for the generated state line, in characters. A custom nudge clause is
   * subtracted from it when there is room; the clause itself is the user's own
   * wording and is never truncated, so a very long clause can push the assembled
   * line past this bound (worst case `REMINDER_BUDGET_MIN + NUDGE_TEXT_MAX`).
   */
  reminderBudget: number
  /**
   * How many requests without list activity may pass before a turn start carries an
   * imperative nudge as well (optionally asking for a list that does not exist yet).
   * 0 disables the maintenance nudge only: the once-per-session invitation to create a list
   * is independent of it, and the informative reminder is unaffected.
   */
  staleAfter: number
  /** Open-item cap for one session. Raising it changes the tool schema, so it starts a new cache prefix. */
  maxItems: number
  /** Marked-row cap for one session. */
  maxDone: number
  /**
   * Minutes an `in_progress` row may run before the reminder appends `(stalled)`.
   * 0 disables the marker; the reminder text is otherwise unchanged.
   */
  stalledAfter: number
  /** Per-item clip inside the reminder line. The tool result keeps the full text. */
  itemChars: number
  /** Clause appended to the state line when the list has gone stale. */
  maintenanceNudge: string
  /** The line used instead of a state line when the session has no list yet. */
  creationNudge: string
}

export const DEFAULT_SETTINGS: Settings = {
  reminder: true,
  reminderBudget: 360,
  // Disabled by default: the normal reminder is enough once a plan exists. The
  // once-per-session invitation is not gated on this.
  staleAfter: 0,
  maxItems: MAX_ITEMS,
  maxDone: MAX_DONE,
  stalledAfter: 0,
  itemChars: 48,
  maintenanceNudge: " — update if changed",
  creationNudge: "[focus_todo] no list yet",
}

const REMINDER_BUDGET_MIN = 80
const REMINDER_BUDGET_MAX = 2000
const STALE_AFTER_MIN = 0
const STALE_AFTER_MAX = 200
const STALLED_AFTER_MIN = 0
const STALLED_AFTER_MAX = 1440
const MAX_ITEMS_MIN = 1
const MAX_DONE_MIN = 0
const ITEM_CHARS_MIN = 16
const ITEM_CHARS_MAX = 200
/** Both nudge texts are one line of the tail; a typo cannot be allowed to flood it. */
const NUDGE_TEXT_MAX = 300

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

function boolSetting(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value
  if (value === "true" || value === "1") return true
  if (value === "false" || value === "0") return false
  return undefined
}

function numberSetting(value: unknown, min: number, max: number): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
  if (!Number.isFinite(number)) return undefined
  return Math.min(max, Math.max(min, Math.round(number)))
}

/**
 * A one-line text setting: empty means "use the default", an overlong value is cut,
 * trailing whitespace is dropped. A *leading* space is kept, because the maintenance
 * clause relies on it to stay its own sentence — the wire showed
 * `update docs— update it if it changed` the first time this trimmed everything.
 */
function textSetting(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  if (value.trim().length === 0) return undefined
  const text = value.trimEnd()
  return text.length > NUDGE_TEXT_MAX ? text.slice(0, NUDGE_TEXT_MAX) : text
}

/** Pure merge of a parsed config file and the environment over the defaults. */
export function resolveSettings(raw: unknown, env: Record<string, string | undefined> = {}): Settings {
  const file = asRecord(raw)
  const reminder = boolSetting(env["FOCUS_TODO_REMINDER"]) ?? boolSetting(file?.["reminder"]) ?? DEFAULT_SETTINGS.reminder
  const budget =
    numberSetting(env["FOCUS_TODO_REMINDER_BUDGET"], REMINDER_BUDGET_MIN, REMINDER_BUDGET_MAX) ??
    numberSetting(file?.["reminderBudget"], REMINDER_BUDGET_MIN, REMINDER_BUDGET_MAX) ??
    DEFAULT_SETTINGS.reminderBudget
  const staleAfter =
    numberSetting(env["FOCUS_TODO_STALE_AFTER"], STALE_AFTER_MIN, STALE_AFTER_MAX) ??
    numberSetting(file?.["staleAfter"], STALE_AFTER_MIN, STALE_AFTER_MAX) ??
    DEFAULT_SETTINGS.staleAfter
  const maxItems =
    numberSetting(env["FOCUS_TODO_MAX_ITEMS"], MAX_ITEMS_MIN, LIMITS_MAX.items) ??
    numberSetting(file?.["maxItems"], MAX_ITEMS_MIN, LIMITS_MAX.items) ??
    DEFAULT_SETTINGS.maxItems
  const maxDone =
    numberSetting(env["FOCUS_TODO_MAX_DONE"], MAX_DONE_MIN, LIMITS_MAX.done) ??
    numberSetting(file?.["maxDone"], MAX_DONE_MIN, LIMITS_MAX.done) ??
    DEFAULT_SETTINGS.maxDone
  const stalledAfter =
    numberSetting(env["FOCUS_TODO_STALLED_AFTER"], STALLED_AFTER_MIN, STALLED_AFTER_MAX) ??
    numberSetting(file?.["stalledAfter"], STALLED_AFTER_MIN, STALLED_AFTER_MAX) ??
    DEFAULT_SETTINGS.stalledAfter
  const itemChars =
    numberSetting(env["FOCUS_TODO_ITEM_CHARS"], ITEM_CHARS_MIN, ITEM_CHARS_MAX) ??
    numberSetting(file?.["itemChars"], ITEM_CHARS_MIN, ITEM_CHARS_MAX) ??
    DEFAULT_SETTINGS.itemChars
  // The nudge texts are the plugin's voice towards the model, so they are the one
  // place where a user may want their own language. They ride in the uncached tail,
  // so wording is free; only the length is clamped.
  const maintenanceNudge = textSetting(file?.["maintenanceNudge"]) ?? DEFAULT_SETTINGS.maintenanceNudge
  const creationNudge = textSetting(file?.["creationNudge"]) ?? DEFAULT_SETTINGS.creationNudge
  return {
    reminder,
    reminderBudget: budget,
    staleAfter,
    maxItems,
    maxDone,
    stalledAfter,
    itemChars,
    maintenanceNudge,
    creationNudge,
  }
}

/** The caps a loaded `Settings` maps to. */
export function limitsOf(settings: Settings): Limits {
  return { items: settings.maxItems, done: settings.maxDone }
}

/** The config file next to the plugin, derived from this module's own URL. */
function pluginConfigPath(): string | undefined {
  try {
    const url = (import.meta as { url?: string }).url
    if (typeof url !== "string" || url.length === 0) return undefined
    return `${url.slice(0, url.lastIndexOf("/"))}/focus-todo.json`
  } catch {
    return undefined
  }
}

/** `<config>/opencode/focus-todo.json`, following the host's own config location. */
export function userConfigPath(env: Record<string, string | undefined>): string | undefined {
  const base =
    env["XDG_CONFIG_HOME"] !== undefined && env["XDG_CONFIG_HOME"].length > 0
      ? env["XDG_CONFIG_HOME"]
      : (() => {
          const home = env["HOME"] ?? env["USERPROFILE"]
          return home !== undefined && home.length > 0 ? `${home.replace(/[\\/]+$/, "")}/.config` : undefined
        })()
  return base === undefined ? undefined : `${base.replace(/[\\/]+$/, "")}/opencode/focus-todo.json`
}

/**
 * Read the first config file that exists and parses, then merge. Every failure
 * path (no Bun file API, unreadable file, invalid JSON) resolves to the
 * defaults: a settings problem must never stop the plugin from loading.
 */
export async function loadSettings(
  env: Record<string, string | undefined> = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env ?? {},
  paths: readonly (string | undefined)[] = [userConfigPath(env), pluginConfigPath()],
): Promise<Settings> {
  for (const path of paths) {
    if (path === undefined) continue
    try {
      const file = (globalThis as { Bun?: { file?: (path: string) => { text(): Promise<string> } } }).Bun?.file
      if (typeof file !== "function") break
      const raw: unknown = JSON.parse(await file(path).text())
      return resolveSettings(raw, env)
    } catch {
      continue
    }
  }
  return resolveSettings(undefined, env)
}

export const TOOL_DESCRIPTION =
  'Session focus for multi-step work: 3+ steps → action="replace"; skip trivial work. ' +
  'action="list" on resume/compaction/restart; action="mutate" for 1–24 add/update/remove ops. ' +
  'Keep items short; one in_progress before work; done:true only after verification; keep partial, blocked, or failing work open. ' +
  'Rows: > running, - pending, ! blocked, x done.'

const STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "blocked"]
const MARK: Record<TodoStatus, string> = { in_progress: ">", pending: "-", blocked: "!" }
const ID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/

/**
 * Input schema for the configured caps. The schema is still fixed for the life of a
 * process, so the tool prefix stays cacheable; changing `maxItems` in settings starts
 * a new process and therefore a new prefix, which is a one-time cost.
 */
export function inputSchema(limits: Limits = DEFAULT_LIMITS) {
  return {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "replace", "mutate"],
      },
      items: {
        type: "array",
        description: "replace: full plan; [] clears all.",
        maxItems: limits.items,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            text: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "blocked"] },
          },
          required: ["text"],
          additionalProperties: false,
        },
      },
      ops: {
        type: "array",
        description: `mutate: 1–${MAX_BATCH_OPS} atomic ops, in order.`,
        minItems: 1,
        maxItems: MAX_BATCH_OPS,
        items: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["add", "update", "remove"],
            },
            text: { type: "string" },
            id: { type: "string", description: "update/remove target." },
            status: { type: "string", enum: ["pending", "in_progress", "blocked"] },
            done: { type: "boolean", enum: [true], description: "true marks done; row kept." },
          },
          required: ["action"],
          additionalProperties: false,
        },
      },
    },
    required: ["action"],
    additionalProperties: false,
  }
}

/** The shipped schema, re-exported for tests and documentation that pin the tool prefix. */
export const INPUT_SCHEMA = inputSchema(DEFAULT_LIMITS)

export const OUTPUT_SCHEMA = { type: "string" } as const

function isDone(item: TodoItem): boolean {
  return item.done === true
}

/** Open items only: the reminder, the caps and the `in_progress` rule all speak about these. */
export function openItems(state: TodoState): TodoItem[] {
  return state.items.filter((item) => !isDone(item))
}

/**
 * Open items first, then marked ones, each in list order — and the marked group
 * leads with the most recently finished row, because a newly marked item sits in
 * the open section just before the marked one. Every mutation writes this order
 * back, so the result does not depend on whether items were added or replaced.
 */
function canonical(items: TodoItem[]): TodoItem[] {
  return [...items.filter((item) => !isDone(item)), ...items.filter(isDone)]
}

/** Enforce both caps: at most `limits.items` open, the newest `limits.done` marked. */
function capped(items: TodoItem[], limits: Limits = DEFAULT_LIMITS): TodoItem[] {
  const ordered = canonical(items)
  return [
    ...ordered.filter((item) => !isDone(item)).slice(0, limits.items),
    ...ordered.filter(isDone).slice(0, limits.done),
  ]
}

/** The `N active, done=M` header, shared by the tool result and the reminder's dedup guard. */
function stateHeader(state: TodoState): string {
  return `${openItems(state).length} active, done=${state.completed}`
}

/** A caller-supplied clock is only trusted when it is a real epoch; otherwise no timestamp is set. */
function timestamp(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined
  return Math.round(value)
}

/** The structured side-channel the sidebar prefers over parsing the text dump. */
export function focusMeta(state: TodoState): FocusMeta {
  return {
    version: 1,
    revision: state.revision,
    active: openItems(state).length,
    completed: state.completed,
    items: state.items.map((item) => {
      const row: FocusMetaItem = {
        id: item.id,
        text: item.text,
        status: item.status,
        done: isDone(item),
      }
      if (item.startedAt !== undefined) row.startedAt = item.startedAt
      return row
    }),
  }
}

export function emptyState(): TodoState {
  return { version: 1, revision: 0, completed: 0, nextId: 1, items: [] }
}

/**
 * Maps a session id to a storage key. Storage is key/value inside the host
 * database, but ids are still restricted so a hostile id can never look like a
 * path or escape the plugin's key namespace.
 */
export function sessionKey(sessionID: unknown): string | undefined {
  if (typeof sessionID !== "string") return undefined
  const id = sessionID.trim()
  if (id.length === 0 || id.length > 128) return undefined
  if (id.includes("/") || id.includes("\\") || id.includes("..")) return undefined
  if (!/^[A-Za-z0-9_.:-]+$/.test(id)) return undefined
  return KEY_PREFIX + id
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value)
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

/**
 * Reads persisted state defensively. A value that is not recognisably ours is
 * reported as corrupt so the caller can reset it; a value that is ours but
 * violates the invariants (too many items, several in_progress, duplicate ids)
 * is repaired in place instead of being thrown away.
 */
export function normalizeState(raw: unknown, limits: Limits = DEFAULT_LIMITS): { state: TodoState; corrupt: boolean } {
  if (raw === undefined || raw === null) return { state: emptyState(), corrupt: false }
  if (typeof raw !== "object" || Array.isArray(raw)) return { state: emptyState(), corrupt: true }

  const value = raw as Partial<TodoState>
  if (value.version !== 1 || !Array.isArray(value.items)) return { state: emptyState(), corrupt: true }

  const items: TodoItem[] = []
  const seen = new Set<string>()
  for (const entry of value.items) {
    if (typeof entry !== "object" || entry === null) return { state: emptyState(), corrupt: true }
    const item = entry as Partial<TodoItem>
    if (typeof item.id !== "string" || !ID_PATTERN.test(item.id)) return { state: emptyState(), corrupt: true }
    if (typeof item.text !== "string" || item.text.length === 0) return { state: emptyState(), corrupt: true }
    if (!isTodoStatus(item.status)) return { state: emptyState(), corrupt: true }
    if (seen.has(item.id)) return { state: emptyState(), corrupt: true }
    // Same normalisation the write path applies (`cleanText`): a stored newline or tab
    // would break the one-row-per-item shape of both the result and the reminder, and
    // leave the panel unable to parse the dump it reads back.
    const text = item.text.trim().replace(/\s+/g, " ")
    if (text.length === 0) return { state: emptyState(), corrupt: true }
    seen.add(item.id)
    const done = item.done === true
    const startedAt =
      !done && item.status === "in_progress" && typeof item.startedAt === "number" && Number.isFinite(item.startedAt)
        ? timestamp(item.startedAt)
        : undefined
    items.push({
      id: item.id,
      text: text.slice(0, MAX_TEXT),
      status: item.status,
      done,
      ...(startedAt !== undefined ? { startedAt } : {}),
    })
  }

  const kept = capped(items, limits)
  let inProgress = false
  for (const item of kept) {
    if (isDone(item)) continue
    if (item.status !== "in_progress") continue
    if (inProgress) {
      // A repaired duplicate must not keep a timer: only the row that stays
      // in_progress owns the start timestamp.
      item.status = "pending"
      delete item.startedAt
    }
    inProgress = true
  }

  const highest = kept.reduce((max, item) => {
    const match = /^t(\d+)$/.exec(item.id)
    return match ? Math.max(max, Number(match[1])) : max
  }, 0)
  // A stored list whose counter is missing or behind its own marked rows would render as
  // "done=0" while showing `x` rows — and a panel reading `0 active, done=0` shows nothing
  // at all. Repair it upward; never downward, since a plan's count can legitimately outrun
  // its rows (the cap drops old marks). A counter reset by `replace` has no rows
  // left either, so the repair cannot resurrect it.
  const marked = kept.filter((item) => item.done === true).length
  const completed = isCount(value.completed) ? Math.max(value.completed, marked) : marked

  return {
    state: {
      version: 1,
      revision: isCount(value.revision) ? value.revision : 0,
      completed,
      nextId: isCount(value.nextId) && value.nextId >= 1 ? Math.max(value.nextId, highest + 1) : highest + 1,
      items: kept,
    },
    corrupt: false,
  }
}

function cleanText(value: unknown): { text: string } | ActionFailure {
  if (typeof value !== "string") return { ok: false, error: "text must be a string" }
  const text = value.trim().replace(/\s+/g, " ")
  if (text.length === 0) return { ok: false, error: "empty text" }
  if (text.length > MAX_TEXT) return { ok: false, error: `text too long (max ${MAX_TEXT} chars)` }
  return { text }
}

function cleanStatus(value: unknown): { status: TodoStatus } | ActionFailure {
  if (value === undefined) return { status: "pending" }
  if (isTodoStatus(value)) return { status: value }
  return { ok: false, error: `invalid status (use ${STATUSES.join("|")})` }
}

function findIndex(state: TodoState, id: unknown): number | ActionFailure {
  if (typeof id !== "string" || id.length === 0) return { ok: false, error: "id is required" }
  const index = state.items.findIndex((item) => item.id === id)
  if (index === -1) {
    // Naming the open ids lets the model correct a stale or mistyped id in the
    // same turn instead of spending a round trip on `list`.
    const open = openItems(state)
      .map((item) => item.id)
      .join(" ")
    return {
      ok: false,
      error: open.length === 0 ? `unknown id ${id}; nothing is open` : `unknown id ${id}; open ids: ${open}`,
    }
  }
  return index
}

/** The id of the single item in progress, if any — named in conflict errors. */
function inProgressId(state: TodoState): string | undefined {
  return openItems(state).find((item) => item.status === "in_progress")?.id
}

function clone(state: TodoState, items: TodoItem[], patch: Partial<TodoState> = {}): TodoState {
  return { ...state, items, ...patch }
}

export function formatState(state: TodoState): string {
  const ordered = canonical(state.items)
  const open = ordered.filter((item) => !isDone(item))
  const done = ordered.filter(isDone)
  // A long plan can finish a dozen rows; repeating every clipped label in every
  // tool result is pure history weight. The newest one stays verbatim (it is the
  // row a reader checks), the rest become one count in the header's own unit.
  const keptDone = done.slice(0, DONE_ROWS_KEPT)
  const hiddenDone = done.length - keptDone.length
  const rows = [
    ...open.map((item) => `${item.id}:${MARK[item.status]} ${item.text}`),
    ...keptDone.map((item) => {
      const text = item.text.length > DONE_TEXT_MAX ? `${item.text.slice(0, DONE_TEXT_MAX - 1)}\u2026` : item.text
      return `${item.id}:x ${text}`
    }),
    ...(hiddenDone > 0 ? [`+${hiddenDone} done`] : []),
  ]
  const header = stateHeader(state)
  return rows.length === 0 ? header : [header, ...rows].join("\n")
}

/** Room reserved for the "+k more" suffix so a clipped list never hides its own clipping. */
const REMINDER_TAIL_RESERVE = 12

/**
 * The shell the injected *instruction* travels in — the invitation, or a state line with the
 * maintenance clause on it. `<system-reminder>` is the host's own convention for
 * harness-authored text (its system prompt: "`<system-reminder>` blocks are harness
 * instructions, not user-authored content. Read and follow them."), which is exactly what an
 * instruction is. A plain state line goes out bare: it asserts facts, and charging every turn
 * 37 characters to label a fact was paying for nothing. Where it is used, its length is
 * charged to the reminder budget, so the whole injected message stays inside `reminderBudget`.
 */
const REMINDER_WRAP = { open: "<system-reminder>\n", close: "\n</system-reminder>" } as const
const REMINDER_WRAP_LENGTH = REMINDER_WRAP.open.length + REMINDER_WRAP.close.length
/**
 * Cheap provenance marker for a bare state line. It is charged to the reminder
 * budget, unlike the 37-character shell, and does not depend on a provider
 * accepting a system message at the end of the request.
 */
const PLAN_PREFIX = "[plan] "

/** Floor for the reminder *line* itself: small enough that the shell and a clause still fit inside the configured budget. */
const REMINDER_LINE_MIN = 24

/** What deserves the model's attention first: what is running, then what is stuck. */
const ATTENTION_RANK: Record<TodoStatus, number> = { in_progress: 0, blocked: 1, pending: 2 }

/** Optional clock/threshold for the `(stalled)` marker. Both are absent by default. */
export interface ReminderOptions {
  /** Epoch milliseconds. No marker is emitted without a clock, which keeps the pure core deterministic. */
  now?: number
  /** Minutes before an `in_progress` row is called stalled; 0 or undefined disables the marker. */
  stalledAfter?: number
}

function stalledSuffix(item: TodoItem, options: ReminderOptions): string {
  const minutes = options.stalledAfter
  const now = options.now
  if (minutes === undefined || minutes <= 0 || now === undefined) return ""
  if (item.status !== "in_progress" || item.startedAt === undefined) return ""
  return now - item.startedAt >= minutes * 60_000 ? " (stalled)" : ""
}

/**
 * One compact line describing the open items, used as the trailing reminder on
 * each outbound request. `undefined` when there is nothing open: a session that
 * is not using the tool pays zero tokens and shows no sign of this plugin.
 *
 * The line is bounded, because it is re-sent at eligible user-turn starts, and it is ordered
 * by attention rather than by list order: the in-progress item first, then
 * blocked ones, then the rest in their original order. When the budget runs out
 * the remainder is stated as `+k more` instead of being silently cut, so the
 * model always knows the header total and how incomplete the line is.
 */
export function formatReminder(
  state: TodoState,
  budget: number = DEFAULT_SETTINGS.reminderBudget,
  itemChars: number = DEFAULT_SETTINGS.itemChars,
  options: ReminderOptions = {},
): string | undefined {
  // Marked items are deliberately absent here: this line is re-sent at eligible user-turn starts and the
  // model only needs what is still open (the header still carries the `done` count).
  const open = openItems(state)
  if (open.length === 0) return undefined
  // Defensive: a caller must not be able to turn the bound off by passing a non-number.
  const limited = Number.isFinite(budget) ? Math.max(REMINDER_LINE_MIN, Math.round(budget)) : DEFAULT_SETTINGS.reminderBudget

  const done = state.completed > 0 ? `, ${state.completed} done` : ""
  const head = `[${TOOL_NAME}] ${open.length} open${done}: `

  // Stable sort, so items keep their list order inside each attention group.
  const ordered = [...open].sort((a, b) => ATTENTION_RANK[a.status] - ATTENTION_RANK[b.status])
  const parts: string[] = []
  let used = head.length
  for (const item of ordered) {
    const text = item.text.length > itemChars ? `${item.text.slice(0, itemChars - 1)}…` : item.text
    const entry = `${item.id}${MARK[item.status]} ${text}${stalledSuffix(item, options)}`
    const cost = parts.length === 0 ? entry.length : entry.length + 3 // " | "
    // The first entry is always kept: dropping the running item would defeat the point.
    if (parts.length > 0 && used + cost + REMINDER_TAIL_RESERVE > limited) break
    parts.push(entry)
    used += cost
  }

  // Assemble the fullest line that fits. A hard slice at the end would be cheaper, but it
  // can cut the `+k more` marker — the one token that tells the model the list is partial —
  // and present a fragment as if it were the whole line. Stepping down one entry at a time
  // degrades into a stated remainder instead, which is information rather than noise.
  const assemble = (count: number): string => {
    const kept = parts.slice(0, count)
    const hidden = ordered.length - count
    const tail = hidden > 0 ? `${kept.length > 0 ? " | " : ""}+${hidden} more` : ""
    return `${head}${kept.join(" | ")}${tail}`
  }
  for (let count = parts.length; count >= 0; count -= 1) {
    const candidate = assemble(count)
    if (candidate.length <= limited) return candidate
  }
  // A budget below even the counts: state them alone, still inside the bound.
  return `[${TOOL_NAME}] ${open.length} open`
}

/**
 * The reminder for a turn where the list did not move since the last one: the
 * counts, the word `unchanged`, and the single item that deserves attention.
 *
 * Repeating an identical sentence every turn costs the same tokens and teaches
 * the reader to skim it, which is the opposite of what this plugin is for. The
 * shorter form keeps the anchor (there is a plan, here is what is running, here
 * is how much is left) and states plainly that nothing moved; any change brings
 * the full line back, and the other ids are one `list` call away.
 */
export function compactReminder(
  state: TodoState,
  budget: number = DEFAULT_SETTINGS.reminderBudget,
  itemChars: number = DEFAULT_SETTINGS.itemChars,
  options: ReminderOptions = {},
): string | undefined {
  const open = openItems(state)
  const first = [...open].sort((a, b) => ATTENTION_RANK[a.status] - ATTENTION_RANK[b.status])[0]
  if (first === undefined) return undefined
  const limited = Number.isFinite(budget) ? Math.max(REMINDER_LINE_MIN, Math.round(budget)) : DEFAULT_SETTINGS.reminderBudget
  const done = state.completed > 0 ? `, ${state.completed} done` : ""
  const head = `[${TOOL_NAME}] ${open.length} open${done}, unchanged: `
  const text = first.text.length > itemChars ? `${first.text.slice(0, itemChars - 1)}…` : first.text
  const line = `${head}${first.id}${MARK[first.status]} ${text}${stalledSuffix(first, options)}`
  if (line.length <= limited) return line
  // Clipping the entry would leave a fragment that reads like a truncated id or word.
  // Keep the anchor — the counts and `unchanged` — and drop the entry instead.
  const anchor = head.trimEnd().replace(/:$/, "")
  return anchor.length <= limited ? anchor : `[${TOOL_NAME}] ${open.length} open`
}

/**
 * Equality check for "the list did not move": every id, status and text, plus
 * the finished count. Cheap, and independent of object identity, so a state
 * re-read from storage compares equal to the one that produced the last line.
 */
export function stateSignature(state: TodoState): string {
  return `${state.items
    .map((item) => `${item.id}${item.status}:${item.text}:${item.startedAt ?? 0}`)
    .join("\u0000")}|${state.completed}`
}

function fail(error: string): ActionFailure {
  return { ok: false, error }
}

/**
 * Pure state transition: no IO and no randomness. `now` is injected rather than read
 * here, so a caller that does not care about timestamps gets the same deterministic
 * result as before.
 */
export interface ApplyOptions {
  limits?: Limits
  /** Epoch milliseconds for `startedAt`; omitted in pure tests, supplied by `handle`. */
  now?: number
}

export function applyAction(
  state: TodoState,
  input: FocusTodoInput | LegacyFocusTodoInput,
  options: ApplyOptions = {},
): ActionOutcome {
  const action = (input as { action?: unknown } | null | undefined)?.action
  const limits = options.limits ?? DEFAULT_LIMITS
  const now = timestamp(options.now)

  switch (action) {
    case "list":
      return { ok: true, state, text: formatState(state), write: false }

    case "replace": {
      const raw = (input as { items?: unknown }).items
      if (!Array.isArray(raw)) return fail("items must be an array")
      if (raw.length > limits.items) return fail(`too many items (max ${limits.items})`)

      const items: TodoItem[] = []
      const used = new Set<string>()
      let nextId = state.nextId
      let inProgress: string | undefined

      for (const entry of raw) {
        if (typeof entry !== "object" || entry === null) return fail("each item must be an object")
        const source = entry as { id?: unknown; text?: unknown; status?: unknown }
        const text = cleanText(source.text)
        if ("ok" in text) return text
        const status = cleanStatus(source.status)
        if ("ok" in status) return status

        let id: string
        if (source.id === undefined) {
          while (used.has(`t${nextId}`)) nextId += 1
          id = `t${nextId}`
          nextId += 1
        } else {
          if (typeof source.id !== "string" || !ID_PATTERN.test(source.id)) return fail("invalid id")
          if (used.has(source.id)) return fail(`duplicate id ${source.id}`)
          id = source.id
          const match = /^t(\d+)$/.exec(id)
          if (match) nextId = Math.max(nextId, Number(match[1]) + 1)
        }

        if (status.status === "in_progress") {
          if (inProgress !== undefined) return fail(`only one in_progress allowed (${inProgress} is in_progress)`)
          inProgress = id
        }
        used.add(id)
        items.push({
          id,
          text: text.text,
          status: status.status,
          ...(status.status === "in_progress" && now !== undefined ? { startedAt: now } : {}),
        })
      }

      // A new plan starts clean: the marked rows and the `done` count both belonged to the
      // plan being replaced, so they go with it. `done` counts completions in the current
      // plan, not the session — nothing accumulates past the plan that produced it.
      const next = clone(state, capped(items, limits), { nextId, completed: 0 })
      return { ok: true, state: next, text: formatState(next), write: true }
    }

    case "mutate":
      return applyMutationOps(state, (input as { ops?: unknown }).ops, false, "mutate", options)

    case "add": {
      if (openItems(state).length >= limits.items) return fail(`too many items (max ${limits.items})`)
      const source = input as { text?: unknown; status?: unknown }
      const text = cleanText(source.text)
      if ("ok" in text) return text
      const status = cleanStatus(source.status)
      if ("ok" in status) return status
      if (status.status === "in_progress") {
        const busy = inProgressId(state)
        if (busy !== undefined) return fail(`only one in_progress allowed (${busy} is in_progress)`)
      }
      const id = `t${state.nextId}`
      // A new item joins the open section, not the end of the array: the marked rows
      // stay last, so the stored order is the same one `formatState` prints.
      const added: TodoItem = {
        id,
        text: text.text,
        status: status.status,
        ...(status.status === "in_progress" && now !== undefined ? { startedAt: now } : {}),
      }
      const items = capped([...state.items, added], limits)
      const next = clone(state, items, { nextId: state.nextId + 1 })
      return { ok: true, state: next, text: formatState(next), write: true }
    }

    case "update": {
      const source = input as { id?: unknown; text?: unknown; status?: unknown; done?: unknown }
      const index = findIndex(state, source.id)
      if (typeof index !== "number") return index
      const wantsDone = source.done === true
      if (source.done !== undefined && source.done !== true) return fail("done only supports true")
      if (source.text === undefined && source.status === undefined && source.done === undefined) {
        return fail("nothing to update")
      }

      const current = state.items[index]!
      if (isDone(current)) {
        const open = openItems(state)
          .map((item) => item.id)
          .join(" ")
        return fail(`${current.id} is already done; open ids: ${open.length === 0 ? "none" : open}`)
      }
      let text = current.text
      if (source.text !== undefined) {
        const cleaned = cleanText(source.text)
        if ("ok" in cleaned) return cleaned
        text = cleaned.text
      }
      let status = current.status
      if (source.status !== undefined) {
        const cleaned = cleanStatus(source.status)
        if ("ok" in cleaned) return cleaned
        if (cleaned.status === "in_progress") {
          const busy = state.items.find(
            (item, position) => position !== index && !isDone(item) && item.status === "in_progress",
          )
          if (busy !== undefined) return fail(`only one in_progress allowed (${busy.id} is in_progress)`)
        }
        status = cleaned.status
      }

      if (wantsDone) {
        // Marked, not deleted: the row stays visible (sidebar, tool result) while the
        // per-request reminder keeps speaking only about open items. Text and status
        // edits ride along in the same call, so finishing something renamed on the way
        // is one op, not two.
        const items = capped(
          state.items.map((item, position) => {
            if (position !== index) return item
            const marked: TodoItem = { ...item, text, status, done: true }
            delete marked.startedAt
            return marked
          }),
          limits,
        )
        const next = clone(state, items, { completed: state.completed + 1 })
        return { ok: true, state: next, text: formatState(next), write: true }
      }

      const items = state.items.map((item, position) => {
        if (position !== index) return item
        // Re-entering in_progress starts a fresh timer; renaming a row that is
        // already running keeps the original start.
        const startedAt =
          status === "in_progress"
            ? current.status === "in_progress" && current.startedAt !== undefined
              ? current.startedAt
              : now
            : undefined
        const updated: TodoItem = { ...item, text, status }
        if (startedAt !== undefined) updated.startedAt = startedAt
        else delete updated.startedAt
        return updated
      })
      const next = clone(state, canonical(items))
      return { ok: true, state: next, text: formatState(next), write: true }
    }

    case "remove": {
      const index = findIndex(state, (input as { id?: unknown }).id)
      if (typeof index !== "number") return index
      const next = clone(
        state,
        canonical(state.items.filter((_, position) => position !== index)),
      )
      return { ok: true, state: next, text: formatState(next), write: true }
    }

    case "batch":
      // Backward compatibility for callers that still send the old envelope.
      return applyMutationOps(state, (input as { ops?: unknown }).ops, true, "batch", options)

    case "complete":
      return applyAction(state, { action: "update", id: (input as { id: string }).id, done: true }, options)

    case "clear":
      return applyAction(state, { action: "replace", items: [] }, options)

    default:
      return fail(`unknown action (use list|replace|mutate)`)
  }
}

/** Apply a mutation envelope atomically. `allowReplace` exists only for old `batch` calls. */
function applyMutationOps(
  state: TodoState,
  raw: unknown,
  allowReplace: boolean,
  envelope: "mutate" | "batch",
  options: ApplyOptions = {},
): ActionOutcome {
  if (!Array.isArray(raw)) return fail("ops must be an array")
  if (raw.length === 0) return fail("ops is empty")
  if (raw.length > MAX_BATCH_OPS) return fail(`too many ops (max ${MAX_BATCH_OPS})`)

  let draft = state
  const errors: string[] = []
  for (let index = 0; index < raw.length; index += 1) {
    const op = raw[index]
    const label = `op ${index + 1}`
    if (typeof op !== "object" || op === null || Array.isArray(op)) {
      errors.push(`${label}: must be an object`)
      continue
    }
    const action = (op as { action?: unknown }).action
    if (action === "replace" && !allowReplace) {
      errors.push(`${label}: replace must be a top-level action`)
      continue
    }
    if (action === "list") {
      errors.push(
        envelope === "batch"
          ? `${label}: list is pointless inside a batch (the result shows the final state)`
          : `${label}: list is not allowed inside mutate`,
      )
      continue
    }
    if (action === "mutate" || action === "batch") {
      errors.push(envelope === "batch" ? `${label}: nested batch not allowed` : `${label}: ${String(action)} is not allowed inside mutate`)
      continue
    }
    if (action !== "add" && action !== "update" && action !== "remove" && !(allowReplace && action === "replace")) {
      errors.push(`${label}: unknown op (use add|update|remove)`)
      continue
    }
    const outcome = applyAction(draft, op as FocusTodoInput | LegacyFocusTodoInput, options)
    if (!outcome.ok) {
      errors.push(`${label}: ${outcome.error}`)
      continue
    }
    draft = outcome.state
  }
  if (errors.length > 0) {
    const shown = errors.slice(0, 4).join("; ")
    const rest = errors.length > 4 ? `; +${errors.length - 4} more` : ""
    return fail(`${envelope} rejected, ${errors.length} of ${raw.length} ops failed: ${shown}${rest}`)
  }
  return { ok: true, state: draft, text: formatState(draft), write: true }
}

export interface FocusTodo {
  run(sessionID: unknown, input: FocusTodoInput | LegacyFocusTodoInput): Promise<string>
  /**
   * Same work as `run`, plus the structured state the tool returns in `metadata`.
   * Throws when the store cannot be read or written, or when the action is rejected.
   */
  runDetailed(sessionID: unknown, input: FocusTodoInput | LegacyFocusTodoInput): Promise<{ text: string; meta: FocusMeta }>
  /** Read-only snapshot for the request reminder; never writes, never throws. */
  peek(sessionID: unknown): Promise<TodoState | undefined>
  /** Diagnostic only: how many sessions currently hold an unfinished mutation chain. */
  pendingSessions(): number
}

type Logger = { warn(...args: unknown[]): void }

function hostLogger(): Logger | undefined {
  const candidate = (globalThis as { console?: unknown }).console
  if (typeof candidate === "object" && candidate !== null && typeof (candidate as Logger).warn === "function") {
    return candidate as Logger
  }
  return undefined
}

/**
 * Binds the pure core to a storage backend. Mutations for one session are
 * chained so concurrent tool calls cannot lose an update; the chain entry is
 * removed once it settles, so nothing accumulates in memory.
 */
export function createFocusTodo(
  storage: Storage,
  log: Logger | undefined = hostLogger(),
  limits: Limits = DEFAULT_LIMITS,
): FocusTodo {
  const tails = new Map<string, Promise<void>>()

  function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve()
    const result = previous.then(task, task)
    const settled = result.then(
      () => undefined,
      () => undefined,
    )
    tails.set(key, settled)
    void settled.then(() => {
      if (tails.get(key) === settled) tails.delete(key)
    })
    return result
  }

  async function handleDetailed(
    sessionID: unknown,
    input: FocusTodoInput | LegacyFocusTodoInput,
  ): Promise<{ text: string; meta: FocusMeta }> {
    const key = sessionKey(sessionID)
    if (key === undefined) throw new Error("invalid session id")

    return serialize(key, async () => {
      let state: TodoState
      let notice = ""

      // A failed read means we do not know what is stored. Never act from an empty
      // base: writing would silently replace the real plan with this one call. The
      // host now gets a thrown error (red part) instead of a success-shaped string,
      // and the sidebar falls back to its last known view.
      try {
        const stored = normalizeState(await storage.get(key), limits)
        state = stored.state
        if (stored.corrupt) {
          notice = "warn=stored state was unreadable and has been reset\n"
          log?.warn("[focus-todo] discarded unreadable state", { session: sessionID })
        }
      } catch (error) {
        log?.warn("[focus-todo] storage read failed", { session: sessionID, error: String(error) })
        throw new Error("state store unavailable")
      }

      const outcome = applyAction(state, input, { limits, now: Date.now() })
      if (!outcome.ok) throw new Error(outcome.error)

      let effective = outcome.state
      if (outcome.write) {
        const revision = state.revision + 1
        effective = { ...outcome.state, revision }
        try {
          await storage.set(key, effective)
        } catch (error) {
          log?.warn("[focus-todo] storage write failed", { session: sessionID, error: String(error) })
          throw new Error("state store write failed")
        }
      }

      resetNudgeCadence(key)
      return { text: notice + outcome.text, meta: focusMeta(effective) }
    })
  }

  async function peek(sessionID: unknown): Promise<TodoState | undefined> {
    const key = sessionKey(sessionID)
    if (key === undefined) return undefined
    try {
      return normalizeState(await storage.get(key), limits).state
    } catch {
      // A reminder is an optimisation; a failed read must not disturb anything.
      return undefined
    }
  }

  return {
    run: async (sessionID, input) => (await handleDetailed(sessionID, input)).text,
    runDetailed: handleDetailed,
    peek,
    pendingSessions: () => tails.size,
  }
}

/** Bound on the per-session cadence memo; entries are tiny and evicted oldest-first. */
const MEMO_LIMIT = 512

/**
 * Per-session cadence for the optional nudge. Memory only: it times invitations,
 * it is not state — a restart simply re-invites once, which is the behaviour a
 * fresh process should have anyway.
 */
interface SessionMemo {
  /** Most recent user message that received an appended reminder. */
  lastTurn?: string
  /** Requests since the last nudge, used only when nudges are explicitly enabled. */
  idle: number
  /** `stateSignature` of the list the last reminder was built from. */
  signature?: string
  /** Whether this session has already been invited to make a list (once is enough). */
  invited?: boolean
}
const memos = new Map<string, SessionMemo>()

function recallMemo(key: string): SessionMemo | undefined {
  return memos.get(key)
}

function storeMemo(key: string, value: SessionMemo): void {
  // Re-insert so insertion order doubles as recency, and keep the map bounded.
  memos.delete(key)
  memos.set(key, value)
  if (memos.size > MEMO_LIMIT) {
    const oldest = memos.keys().next().value
    if (oldest !== undefined) memos.delete(oldest)
  }
}

function resetNudgeCadence(key: string): void {
  const memo = recallMemo(key)
  if (memo === undefined) return
  storeMemo(key, { ...memo, idle: 0 })
}

/**
 * Whether the newest HOST message is the user's turn-opening prompt.
 *
 * Messages this plugin appended earlier in the same pipeline are skipped by id
 * (`focus-todo-…`): a request-scoped tail is not host conversation, and a
 * custom nudge text without the `[focus_todo]` marker would otherwise read as
 * a turn start. Measured on this machine (IMPLEMENTATION_NOTES.md §9.20):
 * billion-context registers its own context hook AFTER this one, so the tail
 * seen here is host-assembled; a foreign user-role tail from a plugin
 * registered BEFORE this one is indistinguishable from a real user message —
 * the host exposes no marker for it — and stays out of scope.
 */
function lastHostRoleIsUser(messages: unknown[]): boolean {
  let tail = messages.length - 1
  while (tail > 0) {
    const id = (messages[tail] as { id?: unknown } | undefined)?.id
    if (typeof id === "string" && id.startsWith("focus-todo-")) tail -= 1
    else break
  }
  return (messages[tail] as { role?: unknown } | undefined)?.role === "user"
}

/**
 * Append the reminder as the LAST message of the outbound request, in place.
 *
 * Wire-verified shape (IMPLEMENTATION_NOTES.md §9.8): the host hands the hook the
 * assembled request, a message appended here reaches the model as the final
 * message and is never written back to the session — so the transcript stays
 * append-only, the reusable cache prefix (system prompt, tool definitions, all
 * earlier messages) keeps its exact bytes, and the reminder is regenerated from
 * storage at eligible user-turn starts, which is what makes it survive a compaction.
 *
 * The informative reminder is added once at the start of a user turn, and is shortened to
 * its `unchanged` form when the list did not move since the previous one. Only a message
 * that carries an *instruction* (the invitation, the maintenance clause) travels in the
 * host's `<system-reminder>` shell; the plain state line goes out bare, because it is a
 * statement of fact rather than something that could be misread as an order, and it is the
 * form sent on almost every turn. Tool and assistant continuations return before
 * storage access. The optional ``maintenanceNudge`` cadence is updated in memory only
 * and stays off under the shipped `staleAfter: 0`; the once-per-session invitation to
 * create a list is independent of it, because a session that never made a list would
 * otherwise never see any reminder at all.
 *
 * Best-effort by construction: any missing field or unexpected shape means no
 * reminder, never a failed request.
 *
 * `subagents` (optional) holds the ids the host's agent registry marks as
 * `mode: "subagent"`. Both nudge forms are silenced there — a subagent session
 * is short-lived and the invitation would otherwise open every run — while the
 * informative state line keeps working. Nothing is suppressed unless the
 * registry positively identifies the agent, so an unknown agent behaves exactly
 * as before.
 */
export async function injectTail(
  todo: FocusTodo,
  payload: unknown,
  settings: Settings = DEFAULT_SETTINGS,
  subagents?: ReadonlySet<string>,
): Promise<boolean> {
  try {
    if (!settings.reminder) return false
    const request = asRecord(payload)
    if (request === undefined) return false
    const messages = request.messages
    if (!Array.isArray(messages) || messages.length === 0) return false
    const key = sessionKey(request.sessionID)
    if (key === undefined) return false
    const newest = asRecord(messages[messages.length - 1])
    if (!newest || isOwnReminderMessage(newest)) return false
    const trackIdle = settings.staleAfter > 0
    const previous = recallMemo(key)
    const turn = typeof newest.id === "string" ? newest.id : undefined
    if (turn !== undefined && previous?.lastTurn === turn) return false

    // Tool/assistant continuations are not new user turns. With the default
    // settings this path avoids even reading persistent todo state.
    if (!lastHostRoleIsUser(messages)) {
      if (trackIdle) storeMemo(key, { ...previous, idle: (previous?.idle ?? 0) + 1 })
      return false
    }

    const state = await todo.peek(request.sessionID)
    if (state === undefined) return false
    const memo = recallMemo(key)
    if (isOwnReminderMessage(messages[messages.length - 1]) || (turn !== undefined && memo?.lastTurn === turn)) return false

    const idle = memo?.idle ?? 0
    const isSubagent = typeof request.agent === "string" && subagents?.has(request.agent) === true
    const hasList = state.items.length > 0
    // The invitation is not a cadence nudge: a session that never made a list would
    // otherwise never hear from this plugin (measured with the shipped
    // `staleAfter: 0`: a fresh session got no reminder at all, only the tool
    // definition). It spends its ~24 characters once per session, then stays quiet,
    // while the recurring `maintenanceNudge` clause remains behind `staleAfter`.
    const invited = memo?.invited === true
    const stale = settings.staleAfter > 0 && (memo === undefined || idle >= settings.staleAfter)
    let nudge: "create" | "maintain" | undefined
    if (!isSubagent) {
      if (!hasList && !invited) nudge = "create"
      else if (hasList && stale) nudge = "maintain"
    }
    // The clause is the user's own wording, used as written (see `reminderBudget`):
    // a long one may push the line past the budget rather than being cut.
    const clause = nudge === "maintain" ? settings.maintenanceNudge : ""
    // Only an instruction travels in the shell. A bare `[plan] [focus_todo] 3 open: …`
    // line is still role `user`, but the six-character marker makes its provenance
    // explicit without the 37-character shell and without relying on a provider
    // accepting a system message at the end of the request. The marker is charged to
    // the budget, so the assembled message never exceeds `reminderBudget`.
    const shelled = nudge !== undefined
    const budget = settings.reminderBudget - clause.length - (shelled ? REMINDER_WRAP_LENGTH : PLAN_PREFIX.length)
    const signature = stateSignature(state)
    // An unchanged list is re-stated in its short form: same anchor, fewer tokens,
    // and no verbatim repeat for the reader to start skimming.
    const unchanged = nudge === undefined && memo?.signature === signature
    const reminderOptions: ReminderOptions = {
      now: Date.now(),
      stalledAfter: settings.stalledAfter,
    }
    const line =
      nudge === "create"
        ? settings.creationNudge
        : ((unchanged ? compactReminder(state, budget, settings.itemChars, reminderOptions) : undefined) ??
          formatReminder(state, budget, settings.itemChars, reminderOptions))
    if (line === undefined) {
      storeMemo(key, { lastTurn: turn, idle: idle + 1, signature, invited })
      return false
    }
    // `<system-reminder>` is the host's own convention for harness-authored text: the
    // system prompt says so verbatim ("`<system-reminder>` blocks are harness
    // instructions, not user-authored content. Read and follow them."). It is spent
    // only where it changes how the line reads: an instruction, not a state report.
    const reminder = shelled ? `${REMINDER_WRAP.open}${line}${clause}${REMINDER_WRAP.close}` : `${PLAN_PREFIX}${line}`
    messages.push({
      id: `focus-todo-${Date.now().toString(36)}`,
      role: "user",
      content: typeof newest.content === "string" ? reminder : [{ type: "text", text: reminder }],
      // A copy, not the same object: sharing it with the host's own message would let
      // either side mutate the other's metadata in place.
      metadata: { ...(asRecord(newest.metadata) ?? {}) },
    })
    storeMemo(key, {
      lastTurn: turn,
      idle: nudge === undefined ? idle + 1 : 0,
      signature,
      invited: invited || nudge === "create",
    })
    return true
  } catch {
    return false
  }
}

function isOwnReminderMessage(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  const message = value as { id?: unknown; role?: unknown }
  return message.role === "user" && typeof message.id === "string" && message.id.startsWith("focus-todo-")
}

/** Guards against a double setup (plugin reload) registering two reminders. */
let reminderHookRegistered = false
/**
 * Test/teardown hook: forgets the registration guards *and* the per-session
 * reminder cadence, so each case starts from a fresh process's point of view.
 */
export function resetHookRegistration(): void {
  reminderHookRegistered = false
  sessionCleanupRegistered = false
  memos.clear()
}

interface ToolDraft {
  add(tool: {
    name: string
    description: string
    input: unknown
    output: unknown
    /**
     * `codemode: false` is required: without it the host exposes the tool only
     * inside the sandboxed code-mode `tools` object and it never reaches the
     * wire tool list, so the model cannot see it directly. Verified against the
     * captured outbound request (see IMPLEMENTATION_NOTES.md).
     */
    options: { codemode: boolean }
    execute(input: unknown, context: { sessionID?: string }): Promise<unknown>
  }): void
}

interface PluginContextV2 {
  storage: Storage
  tool: { transform(update: (draft: ToolDraft) => void): Promise<unknown> }
  /**
   * Optional agent registry, read ONCE at setup to tell primary sessions from
   * subagent ones (probed shape, notes §9.20: `list()` resolves to
   * `{location, data:[{id, mode}]}` with `mode: "primary" | "subagent"`, and
   * the context hook's payload `agent` is the id string). A missing domain or
   * a failing list leaves the set empty, which keeps the previous behaviour.
   */
  agent?: { list(): Promise<{ data?: unknown }> }
  session?: {
    hook(name: "context", callback: (payload: unknown) => Promise<void> | void): Promise<unknown> | unknown
  }
  /**
   * Host event stream, probed from the v2 binary: `session.deleted` carries
   * `data.sessionID`. The domain has been seen as both `subscribe` and `listen`
   * across builds, so either name is accepted.
   */
  event?: {
    subscribe?(callback: (event: unknown) => Promise<void> | void): Promise<unknown> | unknown
    listen?(callback: (event: unknown) => Promise<void> | void): Promise<unknown> | unknown
  }
}

function envOf(): Record<string, string | undefined> {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
}

/**
 * `FOCUS_TODO_DOCTOR=1` prints one line per unpublished host surface this plugin
 * depends on. Each of them fails silently when it drifts, so the probe exists to
 * turn "why did reminders stop?" into a five-second read of the log.
 */
export function doctorEnabled(env: Record<string, string | undefined> = envOf()): boolean {
  return env["FOCUS_TODO_DOCTOR"] === "1" || env["FOCUS_TODO_DOCTOR"] === "true"
}

function doctorLine(log: Logger | undefined, line: string): void {
  log?.warn(`[focus-todo/doctor] ${line}`)
}

/** Probes `storage.get` / `storage.set` with a key the plugin owns and never reads elsewhere. */
async function doctorStorage(storage: Storage | undefined, log: Logger | undefined): Promise<void> {
  if (!doctorEnabled()) return
  let getOk = false
  let setOk = false
  try {
    await storage?.get("focus-todo/doctor-probe")
    getOk = true
  } catch {}
  try {
    await storage?.set("focus-todo/doctor-probe", { at: Date.now() })
    setOk = true
  } catch {}
  const removable = typeof storage?.remove === "function"
  doctorLine(log, `storage.get=${getOk ? "ok" : "fail"} storage.set=${setOk ? "ok" : "fail"} storage.remove=${removable ? "ok" : "absent"}`)
}

const SESSION_DELETED_EVENT = "session.deleted"
let sessionCleanupRegistered = false

type EventCallback = (event: unknown) => Promise<void> | void

/**
 * Extracts the deleted session id from either envelope the host has shipped:
 * `{ type, data }` and `{ details: { type, data } }`. `data.sessionID` is the
 * shape the v2 binary declares; `data.info.id` is accepted as a fallback.
 */
export function deletedSessionID(event: unknown): string | undefined {
  const outer = asRecord(event)
  if (outer === undefined) return undefined
  const detail = asRecord(outer["details"]) ?? outer
  if (detail["type"] !== SESSION_DELETED_EVENT) return undefined
  const data = asRecord(detail["data"])
  if (data === undefined) return undefined
  if (typeof data["sessionID"] === "string") return data["sessionID"]
  const info = asRecord(data["info"])
  return typeof info?.["id"] === "string" ? info["id"] : undefined
}

async function removeSessionState(storage: Storage | undefined, sessionID: unknown, log: Logger | undefined): Promise<void> {
  const key = sessionKey(sessionID)
  if (key === undefined) return
  // The cadence memo only times reminders; letting it outlive the session would
  // keep a signature around for a list that no longer exists.
  memos.delete(key)
  const remove = storage?.remove
  if (typeof remove !== "function") return
  try {
    await remove.call(storage, key)
  } catch (error) {
    log?.warn("[focus-todo] deleted session state could not be dropped", { error: String(error) })
  }
}

function eventSubscriber(domain: PluginContextV2["event"]): ((callback: EventCallback) => unknown) | undefined {
  if (domain === undefined) return undefined
  const subscribe = domain.subscribe
  if (typeof subscribe === "function") return (callback) => subscribe.call(domain, callback)
  const listen = domain.listen
  if (typeof listen === "function") return (callback) => listen.call(domain, callback)
  return undefined
}

/**
 * Deletes the plugin's state row when the host reports a deleted session. This
 * is independent of the reminder switch: a stale row costs storage whether or
 * not reminders are on. Registration failure only leaves orphan rows behind.
 */
async function registerSessionCleanup(context: PluginContextV2, log: Logger | undefined): Promise<void> {
  if (sessionCleanupRegistered) return
  const subscribe = eventSubscriber(context.event)
  if (subscribe === undefined) {
    if (doctorEnabled()) doctorLine(log, "event.session.deleted=unavailable")
    return
  }
  try {
    await subscribe(async (event) => {
      const sessionID = deletedSessionID(event)
      if (sessionID !== undefined) await removeSessionState(context.storage, sessionID, log)
    })
    // Mark only after the host confirms registration, same rule as the reminder hook.
    sessionCleanupRegistered = true
    if (doctorEnabled()) doctorLine(log, "event.session.deleted=ok")
  } catch (error) {
    log?.warn("[focus-todo] session cleanup hook not registered", { error: String(error) })
    if (doctorEnabled()) doctorLine(log, "event.session.deleted=fail")
  }
}

/**
 * v2 plugin entrypoint. Every step is guarded: a failure here must never stop
 * OpenCode from starting, it only leaves this plugin inert.
 */
export default {
  id: "focus-todo",
  setup: async (context: PluginContextV2) => {
    const log = hostLogger()
    // Settings are read once, before the tool is registered: `maxItems` shapes the
    // input schema, and a schema that changes between setup calls starts a new
    // cache prefix, so it must be stable for the lifetime of this instance.
    let settings = DEFAULT_SETTINGS
    try {
      settings = await loadSettings()
    } catch (error) {
      log?.warn("[focus-todo] settings unavailable, defaults used", { error: String(error) })
    }
    const limits = limitsOf(settings)
    const todo = createFocusTodo(context.storage, log, limits)

    try {
      await context.tool.transform((draft) => {
        draft.add({
          name: TOOL_NAME,
          description: TOOL_DESCRIPTION,
          input: inputSchema(limits),
          output: OUTPUT_SCHEMA,
          options: { codemode: false },
          execute: async (input, tool) => {
            const result = await todo.runDetailed(tool?.sessionID, input as FocusTodoInput | LegacyFocusTodoInput)
            // The host persists this on the completed part as `state.metadata.focus` (verified
            // on the current CLI; older builds wrapped it once more as
            // `state.metadata.metadata.focus`) and never sends it to the model.
            return { output: result.text, metadata: { focus: result.meta } }
          },
        })
      })
      if (doctorEnabled()) doctorLine(log, "tool.transform=ok codemode=false")
    } catch (error) {
      log?.warn("[focus-todo] setup failed, tool not registered", { error: String(error) })
      if (doctorEnabled()) doctorLine(log, "tool.transform=fail")
    }

    // The storage probe is independent of the reminder path: it is the only surface
    // both halves share, so it is checked even when reminders are off.
    await doctorStorage(context.storage, log)

    // Cleanup is not an optimisation like the reminder: a deleted session must not
    // leave its state row behind, so this path runs even when reminders are off.
    await registerSessionCleanup(context, log)

    // Optional extra: an attention reminder appended to the request tail. Its
    // failure is contained separately from the tool, because the tool is the
    // contract and the reminder is only an optimisation.
    try {
      // With the reminder off the session domain is never even touched.
      if (settings.reminder && !reminderHookRegistered) {
        const register = context.session?.hook
        if (typeof register === "function") {
          // Subagent ids come from the host's own registry, not a hardcoded
          // name list, so custom agents with `mode: "subagent"` are covered.
          const subagents = new Set<string>()
          try {
            const listed = await context.agent?.list?.()
            const data = (listed as { data?: unknown } | undefined)?.data
            if (Array.isArray(data)) {
              for (const entry of data) {
                const info = entry as { id?: unknown; mode?: unknown }
                if (info.mode === "subagent" && typeof info.id === "string") subagents.add(info.id)
              }
              if (doctorEnabled()) doctorLine(log, `agent.list=ok subagents=${subagents.size}`)
            } else if (doctorEnabled()) {
              doctorLine(log, "agent.list=unavailable subagents=0")
            }
          } catch (error) {
            log?.warn("[focus-todo] agent registry unavailable, nudges apply to every agent", { error: String(error) })
            if (doctorEnabled()) doctorLine(log, "agent.list=fail subagents=0")
          }
          await register.call(context.session, "context", async (payload) => {
            await injectTail(todo, payload, settings, subagents)
          })
          // Mark only after the host confirms registration. A transient hook failure
          // must not make a later plugin setup permanently inert.
          reminderHookRegistered = true
          if (doctorEnabled()) doctorLine(log, "session.hook=ok")
        } else if (doctorEnabled()) {
          doctorLine(log, "session.hook=unavailable")
        }
      } else if (doctorEnabled()) {
        doctorLine(log, `session.hook=skipped (${settings.reminder ? "already registered" : "reminder off"})`)
      }
    } catch (error) {
      log?.warn("[focus-todo] reminder hook not registered, tool unaffected", { error: String(error) })
      if (doctorEnabled()) doctorLine(log, "session.hook=fail")
    }
  },
}
