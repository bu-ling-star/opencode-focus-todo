/**
 * What focus-todo costs, measured on a real capture rather than estimated.
 *
 * Reads an OpenAI-compatible request log (the same file `analyze.mjs` consumes) and
 * reports the four things the plugin puts on the wire:
 *
 *   1. the frozen tool block (description + input schema) inside the tool surface;
 *   2. the system prompt, which the plugin never touches (byte-identity is `analyze.mjs`'s job);
 *   3. the reminder appended to a subset of requests, and its size when it is there;
 *   4. the focus_todo tool results, i.e. what the model pays for reading the list.
 *
 * Everything the panel draws costs zero tokens and is therefore not here: it is rendered
 * from the newest tool result in the session window.
 *
 * Usage: WIRE_LOG=verify/wire-counter.jsonl node verify/cost-report.mjs
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = dirname(fileURLToPath(import.meta.url))
const LOG = process.env.WIRE_LOG ?? join(ROOT, "wire-counter.jsonl")
const TOOL = "focus_todo"

const requests = readFileSync(LOG, "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))
  .filter((entry) => Array.isArray(entry.body?.tools) && entry.body.tools.length > 0)

/** The host's own accounting ran at ≈4.0 characters per token on this stack. */
const approx = (chars) => Math.round(chars / 4)
const pct = (part, whole) => `${((part / whole) * 100).toFixed(1)} %`
const size = (chars) => `${chars} chars ≈ ${approx(chars)} tokens`

const first = requests[0]
const toolsBytes = JSON.stringify(first.body.tools ?? []).length
const todoTool = (first.body.tools ?? []).find((tool) => tool.function?.name === TOOL)
if (todoTool === undefined) throw new Error(`${TOOL} is not in the first request's tools`)
const todoBytes = JSON.stringify(todoTool).length
const description = todoTool.function?.description?.length ?? 0
const schema = JSON.stringify(todoTool.function?.parameters ?? {}).length

console.log(`capture: ${LOG}`)
console.log(`agent requests: ${requests.length}`)
console.log("")
console.log("frozen prefix (identical on every request — see analyze.mjs)")
console.log(`  focus_todo tool block        ${size(todoBytes)}   ${pct(todoBytes, toolsBytes)} of the tool surface`)
console.log(`    description                ${size(description)}`)
console.log(`    input schema               ${size(schema)}`)
console.log(`  all ${first.body.tools.length} tools                 ${size(toolsBytes)}`)
console.log(`  system prompt                ${size((first.body.messages?.[0]?.content ?? "").length)}   (untouched by the plugin)`)
console.log("")

const reminders = []
const results = []
for (const request of requests) {
  const messages = request.body?.messages ?? []
  const last = messages[messages.length - 1]
  const content = typeof last?.content === "string" ? last.content : ""
  const at = content.indexOf(`[${TOOL}]`)
  if (at !== -1) reminders.push(content.slice(at))
  for (const message of messages) {
    if (message.role !== "tool") continue
    const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content)
    if (/^(\d+ active|error=|warn=)/.test(text)) results.push(text)
  }
}

const widths = (list) => {
  const lengths = list.map((text) => text.length)
  const max = Math.max(...lengths)
  const atMax = list.find((text) => text.length === max)
  return { count: list.length, max, atMax, total: lengths.reduce((a, b) => a + b, 0) }
}

const reminder = widths(reminders)
console.log("the reminder (appended to the request tail, never persisted)")
console.log(`  requests carrying it         ${reminder.count} of ${requests.length}`)
console.log(`  largest                      ${size(reminder.max)}`)
console.log(`     ${JSON.stringify(reminder.atMax)}`)
console.log("")

const result = widths(results)
console.log("tool results (what the model pays to read the list)")
console.log(`  results in the transcript    ${result.count}`)
console.log(`  largest                      ${size(result.max)}`)
console.log(`     ${JSON.stringify(result.atMax)?.slice(0, 200)}`)
console.log("")
console.log("bounded by construction")
console.log(`  marked rows in a result      at most 16 × 32 chars ≈ 128 chars ≈ ${approx(128)} tokens`)
console.log(`  open rows in a result        at most 16 × (150 + id) chars ≈ 2.7 KB ≈ ${approx(2700)} tokens (only when the model asks)`)
console.log(`  session state in storage     at most 16 open + 16 marked ≈ 3 KB, one key per session`)
console.log(`  panel / TUI                 0 tokens — it renders the newest tool result from the session window`)
