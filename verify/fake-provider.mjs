// Fake OpenAI-compatible chat-completions provider.
// Logs every outbound request body, then replays a scripted response so a
// multi-turn session can be driven deterministically with no model cost.
// Requests without a tools array (title generation etc.) always get plain text.
import { createServer } from "node:http"
import { appendFileSync, readFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = dirname(fileURLToPath(import.meta.url))
// Overridable so a probe run can record to its own file and leave a baseline capture intact.
const LOG = process.env.WIRE_LOG ?? join(ROOT, "wire.jsonl")
const SCRIPT = process.env.WIRE_SCRIPT ?? join(ROOT, "script.json")
let seq = 0
let agentTurns = 0

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`
const chunk = (delta, body) => sse({ id: "chatcmpl-fake", object: "chat.completion.chunk", created: 1, model: body?.model ?? "fake", choices: [{ index: 0, delta, finish_reason: null }] })

createServer((req, res) => {
  let raw = ""
  req.on("data", (c) => (raw += c))
  req.on("end", () => {
    let body = null
    try { body = JSON.parse(raw) } catch {}
    seq += 1
    const isAgent = Array.isArray(body?.tools) && body.tools.length > 0
    if (isAgent) agentTurns += 1
    appendFileSync(LOG, JSON.stringify({ seq, agentTurn: isAgent ? agentTurns : 0, path: req.url, headers: req.headers, body }) + "\n")

    const script = existsSync(SCRIPT) ? JSON.parse(readFileSync(SCRIPT, "utf8")) : {}
    const step = isAgent ? (script["t" + agentTurns] ?? { type: "text", text: "EXTRA-OK" }) : { type: "text", text: "Title" }

    // A "hang" step answers nothing: it freezes the client mid-turn so a session
    // can be inspected at the moment its newest message is a tool result.
    if (step.type === "hang") {
      console.log(`hang: leaving request seq ${seq} (agent turn ${agentTurns}) unanswered`)
      return
    }

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
    res.write(sse({ id: "chatcmpl-fake", object: "chat.completion.chunk", created: 1, model: body?.model ?? "fake", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }))
    if (step.type === "tool") {
      res.write(chunk({ tool_calls: [{ index: 0, id: `call_${seq}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.args) } }] }, body))
      res.write(sse({ id: "chatcmpl-fake", object: "chat.completion.chunk", created: 1, model: body?.model ?? "fake", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }))
    } else {
      res.write(chunk({ content: step.text ?? "ok" }, body))
      res.write(sse({ id: "chatcmpl-fake", object: "chat.completion.chunk", created: 1, model: body?.model ?? "fake", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }))
    }
    res.write("data: [DONE]\n\n")
    res.end()
  })
}).listen(45999, "127.0.0.1", () => console.log("fake provider on http://127.0.0.1:45999"))
