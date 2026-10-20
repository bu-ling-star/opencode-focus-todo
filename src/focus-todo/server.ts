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
 * - at most 16 open items, at most 150 chars per item, at most one `in_progress`;
 * - marking done (`update` with `done: true`) keeps the row instead of deleting it: marked
 *   rows stay in the sidebar and in the tool result (short) but never in the per-request
 *   reminder, which stays open-only;
 * - every failure path is soft: setup never throws, corrupt state is reset, writes are serialized.
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
}

export interface TodoState {
  version: 1
  revision: number
  /** Completions in the *current* plan: a `done: true` update adds one, `replace` resets it. */
  completed: number
  nextId: number
  items: TodoItem[]
}

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
export const MAX_ITEMS = 16
/** Marked items kept per session; the oldest ones are dropped once this is exceeded. */
export const MAX_DONE = 10
export const MAX_TEXT = 150
/** Upper bound on one mutation envelope: a plan holds at most 16 open items, so 24 ops covers any realistic reshuffle. */
export const MAX_BATCH_OPS = 24
/** Done rows appear in every tool result, so keep them compact while retaining a useful label. */
export const DONE_TEXT_MAX = 48
export const KEY_PREFIX = "focus-todo/session/"

/**
 * Settings come from a JSON file, not from environment variables:
 *
 *   <config>/opencode/focus-todo.json      (~/.config/opencode/focus-todo.json)
 *   <plugin dir>/focus-todo.json           (fallback, next to server.ts)
 *
 * Shape: `{ "reminder": true, "reminderBudget": 360, "staleAfter": 0 }`. Missing file,
 * missing key, wrong type or broken JSON all fall back to the defaults below, so the
 * plugin can never be configured into a broken state. The environment variables of the
 * same names are honoured as an override for tests and one-off runs.
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
   * 0 disables both nudges; the informative reminder is unaffected.
   */
  staleAfter: number
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
  // Disabled by default: the normal reminder is enough once a plan exists, and
  // an empty session should not be invited to create bookkeeping.
  staleAfter: 0,
  itemChars: 48,
  maintenanceNudge: " — update if changed",
  creationNudge: "[focus_todo] no list yet",
}

const REMINDER_BUDGET_MIN = 80
const REMINDER_BUDGET_MAX = 2000
const STALE_AFTER_MIN = 0
const STALE_AFTER_MAX = 200
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
  const itemChars =
    numberSetting(env["FOCUS_TODO_ITEM_CHARS"], ITEM_CHARS_MIN, ITEM_CHARS_MAX) ??
    numberSetting(file?.["itemChars"], ITEM_CHARS_MIN, ITEM_CHARS_MAX) ??
    DEFAULT_SETTINGS.itemChars
  // The nudge texts are the plugin's voice towards the model, so they are the one
  // place where a user may want their own language. They ride in the uncached tail,
  // so wording is free; only the length is clamped.
  const maintenanceNudge = textSetting(file?.["maintenanceNudge"]) ?? DEFAULT_SETTINGS.maintenanceNudge
  const creationNudge = textSetting(file?.["creationNudge"]) ?? DEFAULT_SETTINGS.creationNudge
  return { reminder, reminderBudget: budget, staleAfter, itemChars, maintenanceNudge, creationNudge }
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
  'Session focus list for multi-step work. For 3+ steps, start with action="replace"; skip trivial work. ' +
  'Use action="list" on resume/compaction/restart, or action="mutate" with 1–24 add/update/remove ops. ' +
  'Keep items short; set one in_progress before work; set done:true only after verification, leaving partial, blocked, or failing work open. ' +
  'Results mark each row as > running, - pending, ! blocked, x done.'

const STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "blocked"]
const MARK: Record<TodoStatus, string> = { in_progress: ">", pending: "-", blocked: "!" }
const ID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/

/** Fixed input schema. Todo content never changes it, so the tool prefix stays cacheable. */
export const INPUT_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["list", "replace", "mutate"],
      description: "list: read. replace: overwrite all. mutate: apply add/update/remove ops atomically.",
    },
    items: {
      type: "array",
      description: "For replace: new plan; [] clears rows and done count.",
      maxItems: MAX_ITEMS,
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Existing id to keep; omit for a new id." },
          text: { type: "string", description: `Item text, max ${MAX_TEXT} chars.` },
          status: { type: "string", enum: ["pending", "in_progress", "blocked"] },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
    ops: {
      type: "array",
      description: `For mutate: 1–${MAX_BATCH_OPS} ops, applied in order, all-or-nothing.`,
      minItems: 1,
      maxItems: MAX_BATCH_OPS,
      items: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["add", "update", "remove"],
            description: "One local mutation; replace is top-level only.",
          },
          text: { type: "string", description: `For add/update: max ${MAX_TEXT} chars.` },
          id: { type: "string", description: "For update/remove." },
          status: { type: "string", enum: ["pending", "in_progress", "blocked"] },
          done: { type: "boolean", enum: [true], description: "For update: marks done; retained as a row." },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
  required: ["action"],
  additionalProperties: false,
} as const

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

/** Enforce both caps: at most `MAX_ITEMS` open, the newest `MAX_DONE` marked. */
function capped(items: TodoItem[]): TodoItem[] {
  const ordered = canonical(items)
  return [
    ...ordered.filter((item) => !isDone(item)).slice(0, MAX_ITEMS),
    ...ordered.filter(isDone).slice(0, MAX_DONE),
  ]
}

/** The `N active, done=M` header, shared by the tool result and the reminder's dedup guard. */
function stateHeader(state: TodoState): string {
  return `${openItems(state).length} active, done=${state.completed}`
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
export function normalizeState(raw: unknown): { state: TodoState; corrupt: boolean } {
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
    items.push({
      id: item.id,
      text: text.slice(0, MAX_TEXT),
      status: item.status,
      done: item.done === true,
    })
  }

  const kept = capped(items)
  let inProgress = false
  for (const item of kept) {
    if (isDone(item)) continue
    if (item.status !== "in_progress") continue
    if (inProgress) item.status = "pending"
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
  const rows = canonical(state.items).map((item) => {
    if (isDone(item)) {
      const text = item.text.length > DONE_TEXT_MAX ? `${item.text.slice(0, DONE_TEXT_MAX - 1)}\u2026` : item.text
      return `${item.id}:x ${text}`
    }
    return `${item.id}:${MARK[item.status]} ${item.text}`
  })
  const header = stateHeader(state)
  return rows.length === 0 ? header : [header, ...rows].join("\n")
}

/** Room reserved for the "+k more" suffix so a clipped list never hides its own clipping. */
const REMINDER_TAIL_RESERVE = 12

/** What deserves the model's attention first: what is running, then what is stuck. */
const ATTENTION_RANK: Record<TodoStatus, number> = { in_progress: 0, blocked: 1, pending: 2 }

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
): string | undefined {
  // Marked items are deliberately absent here: this line is re-sent at eligible user-turn starts and the
  // model only needs what is still open (the header still carries the `done` count).
  const open = openItems(state)
  if (open.length === 0) return undefined
  // Defensive: a caller must not be able to turn the bound off by passing a non-number.
  const limited = Number.isFinite(budget) ? Math.max(REMINDER_BUDGET_MIN, Math.round(budget)) : DEFAULT_SETTINGS.reminderBudget

  const done = state.completed > 0 ? `, ${state.completed} done` : ""
  const head = `[${TOOL_NAME}] ${open.length} open${done}: `

  // Stable sort, so items keep their list order inside each attention group.
  const ordered = [...open].sort((a, b) => ATTENTION_RANK[a.status] - ATTENTION_RANK[b.status])
  const parts: string[] = []
  let used = head.length
  for (const item of ordered) {
    const text = item.text.length > itemChars ? `${item.text.slice(0, itemChars - 1)}…` : item.text
    const entry = `${item.id}${MARK[item.status]} ${text}`
    const cost = parts.length === 0 ? entry.length : entry.length + 3 // " | "
    // The first entry is always kept: dropping the running item would defeat the point.
    if (parts.length > 0 && used + cost + REMINDER_TAIL_RESERVE > limited) break
    parts.push(entry)
    used += cost
  }

  const omitted = ordered.length - parts.length
  const line = head + parts.join(" | ") + (omitted > 0 ? ` | +${omitted} more` : "")
  return line.length > limited ? `${line.slice(0, limited - 1)}…` : line
}

function fail(error: string): ActionFailure {
  return { ok: false, error }
}

/**
 * Pure state transition: no IO, no clock, no randomness, so it is exhaustively
 * testable and every result is reproducible.
 */
export function applyAction(state: TodoState, input: FocusTodoInput | LegacyFocusTodoInput): ActionOutcome {
  const action = (input as { action?: unknown } | null | undefined)?.action

  switch (action) {
    case "list":
      return { ok: true, state, text: formatState(state), write: false }

    case "replace": {
      const raw = (input as { items?: unknown }).items
      if (!Array.isArray(raw)) return fail("items must be an array")
      if (raw.length > MAX_ITEMS) return fail(`too many items (max ${MAX_ITEMS})`)

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
        items.push({ id, text: text.text, status: status.status })
      }

      // A new plan starts clean: the marked rows and the `done` count both belonged to the
      // plan being replaced, so they go with it. `done` counts completions in the current
      // plan, not the session — nothing accumulates past the plan that produced it.
      const next = clone(state, capped(items), { nextId, completed: 0 })
      return { ok: true, state: next, text: formatState(next), write: true }
    }

    case "mutate":
      return applyMutationOps(state, (input as { ops?: unknown }).ops, false, "mutate")

    case "add": {
      if (openItems(state).length >= MAX_ITEMS) return fail(`too many items (max ${MAX_ITEMS})`)
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
      const items = capped([...state.items, { id, text: text.text, status: status.status }])
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
          state.items.map((item, position) => (position === index ? { ...item, text, status, done: true } : item)),
        )
        const next = clone(state, items, { completed: state.completed + 1 })
        return { ok: true, state: next, text: formatState(next), write: true }
      }

      const items = state.items.map((item, position) => (position === index ? { ...item, text, status } : item))
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
      return applyMutationOps(state, (input as { ops?: unknown }).ops, true, "batch")

    case "complete":
      return applyAction(state, { action: "update", id: (input as { id: string }).id, done: true })

    case "clear":
      return applyAction(state, { action: "replace", items: [] })

    default:
      return fail(`unknown action (use list|replace|mutate)`)
  }
}

/** Apply a mutation envelope atomically. `allowReplace` exists only for old `batch` calls. */
function applyMutationOps(state: TodoState, raw: unknown, allowReplace: boolean, envelope: "mutate" | "batch"): ActionOutcome {
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
    const outcome = applyAction(draft, op as FocusTodoInput | LegacyFocusTodoInput)
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
export function createFocusTodo(storage: Storage, log: Logger | undefined = hostLogger()): FocusTodo {
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

  async function handle(sessionID: unknown, input: FocusTodoInput | LegacyFocusTodoInput): Promise<string> {
    const key = sessionKey(sessionID)
    if (key === undefined) return "error=invalid session id"

    return serialize(key, async () => {
      let state: TodoState
      let notice = ""

      try {
        const stored = normalizeState(await storage.get(key))
        state = stored.state
        if (stored.corrupt) {
          notice = "warn=stored state was unreadable and has been reset\n"
          log?.warn("[focus-todo] discarded unreadable state", { session: sessionID })
        }
      } catch (error) {
        state = emptyState()
        notice = "warn=state store unavailable, list is not persisted\n"
        log?.warn("[focus-todo] storage read failed", { session: sessionID, error: String(error) })
      }

      const outcome = applyAction(state, input)
      if (!outcome.ok) return `error=${outcome.error}`

      if (outcome.write) {
        try {
          await storage.set(key, { ...outcome.state, revision: state.revision + 1 })
        } catch (error) {
          log?.warn("[focus-todo] storage write failed", { session: sessionID, error: String(error) })
          return `${notice}error=state store write failed`
        }
      }

      resetNudgeCadence(key)
      return notice + outcome.text
    })
  }

  async function peek(sessionID: unknown): Promise<TodoState | undefined> {
    const key = sessionKey(sessionID)
    if (key === undefined) return undefined
    try {
      return normalizeState(await storage.get(key)).state
    } catch {
      // A reminder is an optimisation; a failed read must not disturb anything.
      return undefined
    }
  }

  return { run: handle, peek, pendingSessions: () => tails.size }
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
 * The informative reminder is added once at the start of a user turn. Tool and assistant
 * continuations return before storage access. Optional nudge cadence is updated in memory
 * only, and remains disabled by the shipped `staleAfter: 0` default.
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
    const nudges = settings.staleAfter > 0
    const previous = recallMemo(key)
    const turn = typeof newest.id === "string" ? newest.id : undefined
    if (turn !== undefined && previous?.lastTurn === turn) return false

    // Tool/assistant continuations are not new user turns. With the default
    // settings this path avoids even reading persistent todo state.
    if (!lastHostRoleIsUser(messages)) {
      if (nudges) storeMemo(key, { ...previous, idle: (previous?.idle ?? 0) + 1 })
      return false
    }

    const state = await todo.peek(request.sessionID)
    if (state === undefined) return false
    const memo = recallMemo(key)
    if (isOwnReminderMessage(messages[messages.length - 1]) || (turn !== undefined && memo?.lastTurn === turn)) return false

    const idle = memo?.idle ?? 0
    const isSubagent = typeof request.agent === "string" && subagents?.has(request.agent) === true
    let nudge: "create" | "maintain" | undefined
    if (nudges && !isSubagent && (memo === undefined || idle >= settings.staleAfter)) {
      nudge = state.items.length === 0 ? "create" : "maintain"
    }
    // The clause is the user's own wording, used as written (see `reminderBudget`):
    // a long one may push the line past the budget rather than being cut.
    const clause = nudge === "maintain" ? settings.maintenanceNudge : ""
    const line = nudge === "create" ? settings.creationNudge : formatReminder(state, settings.reminderBudget - clause.length, settings.itemChars)
    if (line === undefined) {
      storeMemo(key, { lastTurn: turn, idle: idle + 1 })
      return false
    }
    const reminder = line + clause
    messages.push({
      id: `focus-todo-${Date.now().toString(36)}`,
      role: "user",
      content: typeof newest.content === "string" ? reminder : [{ type: "text", text: reminder }],
      metadata: asRecord(newest.metadata) ?? {},
    })
    storeMemo(key, { lastTurn: turn, idle: nudge === undefined ? idle + 1 : 0 })
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
 * Test/teardown hook: forgets the registration guard *and* the per-session
 * reminder cadence, so each case starts from a fresh process's point of view.
 */
export function resetHookRegistration(): void {
  reminderHookRegistered = false
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
}

/**
 * v2 plugin entrypoint. Every step is guarded: a failure here must never stop
 * OpenCode from starting, it only leaves this plugin inert.
 */
export default {
  id: "focus-todo",
  setup: async (context: PluginContextV2) => {
    const log = hostLogger()
    const todo = createFocusTodo(context.storage, log)
    try {
      await context.tool.transform((draft) => {
        draft.add({
          name: TOOL_NAME,
          description: TOOL_DESCRIPTION,
          input: INPUT_SCHEMA,
          output: OUTPUT_SCHEMA,
          options: { codemode: false },
          execute: async (input, tool) => ({ output: await todo.run(tool?.sessionID, input as FocusTodoInput | LegacyFocusTodoInput) }),
        })
      })
    } catch (error) {
      log?.warn("[focus-todo] setup failed, tool not registered", { error: String(error) })
    }

    // Optional extra: an attention reminder appended to the request tail. Its
    // failure is contained separately from the tool, because the tool is the
    // contract and the reminder is only an optimisation.
    try {
      const settings = await loadSettings()
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
            }
          } catch (error) {
            log?.warn("[focus-todo] agent registry unavailable, nudges apply to every agent", { error: String(error) })
          }
          await register.call(context.session, "context", async (payload) => {
            await injectTail(todo, payload, settings, subagents)
          })
          // Mark only after the host confirms registration. A transient hook failure
          // must not make a later plugin setup permanently inert.
          reminderHookRegistered = true
        }
      }
    } catch (error) {
      log?.warn("[focus-todo] reminder hook not registered, tool unaffected", { error: String(error) })
    }
  },
}
