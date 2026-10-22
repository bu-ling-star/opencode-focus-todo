import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
const ROOT = dirname(fileURLToPath(import.meta.url))
// WIRE_LOG / REPORT let the same analyzer run over any capture, e.g. the
// request-tail reminder capture, without rewriting this file.
const CAPTURE = process.env.WIRE_LOG ?? join(ROOT, "wire.jsonl")
const REPORT = process.env.REPORT ?? join(ROOT, "cache-report.json")
const recs = readFileSync(CAPTURE, "utf8").trim().split("\n").map(JSON.parse)
const agent = recs.filter((r) => Array.isArray(r.body?.tools) && r.body.tools.length > 0)

const J = (v) => JSON.stringify(v)
const toolName = (t) => t?.function?.name
const toolOrder = (r) => r.body.tools.map(toolName).join(",")
// Only focus_todo is this plugin's responsibility: other plugins may register a
// tool late in a fresh process, so the whole surface is not required to be frozen.
const focusDef = (r) => J(r.body.tools.find((t) => toolName(t) === "focus_todo"))
const sharedToolNames = agent
  .map((r) => r.body.tools.map(toolName))
  .reduce((shared, names) => shared.filter((name) => names.includes(name)))
const sharedOrder = (r) => r.body.tools.map(toolName).filter((name) => sharedToolNames.includes(name)).join(",")
const system = (r) => J(r.body.messages.filter((m) => m.role === "system"))
const cacheKey = (r) => J(r.body.prompt_cache_key)

// The one message this plugin is allowed to add: the request-tail reminder. It is
// appended last and never persisted, so "history is append-only" is checked with
// it excluded, and its exact position is checked separately below.
const REMINDER = "[focus_todo]"
const isReminder = (m) => String(m?.content ?? "").includes(REMINDER)
const historyOf = (r) => r.body.messages.filter((m) => !isReminder(m))

const results = []
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`) }
// A property that cannot apply to a capture is N/A, never a failure: a session that never
// made a list has no tool results to inspect and, with no list, its one reminder can only
// be the invitation — reporting FAIL there would make "all pass" say nothing.
const checkIf = (applies, name, ok, detail) => {
  if (applies) return check(name, ok, detail)
  results.push({ name, ok: true, na: true, detail: "not applicable to this capture" })
  console.log(`N/A   ${name}  -> not applicable to this capture`)
}

check("the focus_todo definition is byte-identical across every agent request", new Set(agent.map(focusDef)).size === 1, `${agent.length} requests, ${new Set(agent.map(focusDef)).size} distinct`)
check("the relative order of every tool present in all requests is stable", new Set(agent.map(sharedOrder)).size === 1, `${sharedToolNames.length} tools shared by all ${agent.length} requests`)
check("focus_todo is a first-class wire tool in every agent request", agent.every((r) => toolOrder(r).split(",").includes("focus_todo")))
check("the system prompt is byte-identical across every agent request", new Set(agent.map(system)).size === 1, `${system(agent[0]).length} bytes`)

// A tool registered by another plugin after this process's first request is
// reported, not failed: it says nothing about this plugin's wire surface.
const seenIn = new Map()
for (const r of agent) for (const name of r.body.tools.map(toolName)) seenIn.set(name, (seenIn.get(name) ?? 0) + 1)
const unstable = [...seenIn].filter(([, count]) => count !== agent.length)
if (unstable.length > 0) {
  console.log(`\nNOTE: tools present in only some agent requests (registered by another plugin): ${unstable.map(([name, count]) => `${name} ${count}/${agent.length}`).join(", ")}`)
}

let prefixOk = true, prefixDetail = ""
for (let i = 1; i < agent.length; i += 1) {
  const prev = historyOf(agent[i - 1]), next = historyOf(agent[i])
  const n = Math.min(prev.length, next.length)
  for (let k = 0; k < n; k += 1) {
    if (J(prev[k]) !== J(next[k])) { prefixOk = false; prefixDetail = `req${agent[i - 1].seq} vs req${agent[i].seq} diverge at message ${k}` ; break }
  }
  if (!prefixOk) break
}
check("history is append-only: each request's messages are a byte-exact extension of the previous ones (ignoring the last-message reminder)", prefixOk, prefixDetail || `${agent.length - 1} consecutive pairs compared`)

check("the plugin does not modify prompt_cache_key", new Set(agent.map(cacheKey)).size === 1, String(cacheKey(agent[0])))
check("the plugin does not modify session affinity headers", new Set(agent.map((r) => String(r.headers["x-session-affinity"]))).size === 1, String(agent[0].headers["x-session-affinity"]).slice(0, 24) + "...")
check("no extra system message is appended by the plugin", agent.every((r) => r.body.messages.filter((m) => m.role === "system").length === agent[0].body.messages.filter((m) => m.role === "system").length))

// The only per-request difference must be the transcript itself (turn content), never the reusable prefix.
const toolResults = agent.flatMap((r) => r.body.messages.filter((m) => m.role === "tool").map((m) => String(m.content))).filter((c) => c.includes("active, done="))
checkIf(toolResults.length > 0, "todo state changes show up only inside tool results in the transcript", toolResults.length > 0, toolResults.length + " todo tool results")

console.log("\n--- todo tool results observed on the wire ---")
for (const t of toolResults) console.log(JSON.stringify(t))

// ---- request-tail reminder (only checked when the capture contains one) ----
const reminderRuns = agent.filter((r) => r.body.messages.some(isReminder))

if (reminderRuns.length === 0) {
  console.log("\nNOTE: no request-tail reminder in this capture (reminder disabled, or nothing was open).")
} else {
  check(
    "the reminder appears exactly once per request, as the last message",
    reminderRuns.every((r) => {
      const messages = r.body.messages
      return messages.filter(isReminder).length === 1 && isReminder(messages[messages.length - 1])
    }),
    `${reminderRuns.length} requests carry it`,
  )

  // Whatever the reminder said last time cannot be inside the reusable prefix,
  // because it was the final message of that request: nothing could follow it.
  const commonPrefixLengths = []
  for (let i = 1; i < reminderRuns.length; i += 1) {
    const prev = reminderRuns[i - 1].body.messages
    const next = reminderRuns[i].body.messages
    let k = 0
    while (k < prev.length && k < next.length && J(prev[k]) === J(next[k])) k += 1
    commonPrefixLengths.push(`${k}/${Math.min(prev.length, next.length)}`)
  }
  check(
    "each request reuses every message the previous one sent except its reminder",
    reminderRuns
      .slice(1)
      .every((r, index) => {
        const previous = reminderRuns[index].body.messages
        return Number(commonPrefixLengths[index].split("/")[0]) === previous.length - 1
      }),
    `shared prefixes: ${commonPrefixLengths.join(", ")}`,
  )

  const reminderTexts = reminderRuns.map((r) => String(r.body.messages[r.body.messages.length - 1]?.content ?? "").match(/\[focus_todo\][^<]*/)?.[0] ?? "")
  console.log("\n--- reminders observed on the wire (last message of each request) ---")
  for (const t of reminderTexts) console.log(JSON.stringify(t))
  // With no list in the session the reminder is the invitation, and the invitation is
  // deliberately one fixed line, so "it varies" cannot apply — only "it varies when the
  // list varies" does.
  const hasState = agent.some((r) => r.body.messages.some((m) => String(m?.content ?? "").includes(" active, done=")))
  checkIf(hasState, "the reminder content tracks the list rather than being frozen", new Set(reminderTexts).size > 1, `${new Set(reminderTexts).size} distinct`)
}

const summary = {
  generatedFrom: CAPTURE.replace(/\\/g, "/").split("/").pop(),
  agentRequests: agent.length,
  reminders: reminderRuns.length,
  allPass: results.every((r) => r.ok),
  results,
  todoToolResults: toolResults,
}
writeFileSync(REPORT, JSON.stringify(summary, null, 2))
console.log("\nALL PASS:", summary.allPass)
