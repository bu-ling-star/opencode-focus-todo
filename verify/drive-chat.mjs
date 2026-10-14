/**
 * Type into a real, headless TUI to produce consecutive user turns **in one process**.
 *
 * `opencode run` starts a fresh process per invocation, which is exactly what hides a
 * cadence that lives in memory (IMPLEMENTATION_NOTES.md §10.9). This script drives the
 * drive-mode TUI instead: it types a message, presses enter, waits until the provider
 * has logged another agent request, and repeats. What the plugin did with those turns is
 * then read from the same wire log (`analyze.mjs` / a small report), not from this script.
 *
 * Usage:
 *   node verify/drive-chat.mjs --wire <wire.jsonl> --messages "hi|and again|and again" [--settle=1500]
 *
 * Assumes the TUI is already running with OPENCODE_DRIVE=1 on ws://127.0.0.1:40900 and a
 * recording provider behind it.
 */
const ENDPOINT = "ws://127.0.0.1:40900"
const CAPABILITIES = ["ui.capture", "ui.type", "ui.enter", "ui.press", "ui.resize", "ui.state"]
const VIEWPORT = { cols: 200, rows: 50 }

import { readFile } from "node:fs/promises"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function connect(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const socket = new WebSocket(ENDPOINT)
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true })
        socket.addEventListener("error", () => reject(new Error("connect failed")), { once: true })
      })
      return socket
    } catch (error) {
      if (Date.now() > deadline) throw error
      await sleep(400)
    }
  }
}

function rpc(socket, method, params, timeoutMs = 20000) {
  const id = Math.floor(Math.random() * 1e9)
  const payload = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs)
    const onMessage = (event) => {
      let message
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data))
      } catch {
        return
      }
      if (message.id !== id) return
      clearTimeout(timer)
      socket.removeEventListener("message", onMessage)
      if (message.error) reject(new Error(`${method}: ${message.error.message ?? JSON.stringify(message.error)}`))
      else resolve(message.result)
    }
    socket.addEventListener("message", onMessage)
    socket.send(JSON.stringify(payload))
  })
}

/** Agent requests (those carrying tools) recorded so far — the "one turn happened" signal. */
async function agentRequests(wire) {
  try {
    const text = await readFile(wire, "utf8")
    let count = 0
    for (const line of text.trim().split("\n")) {
      if (line.length === 0) continue
      try {
        const entry = JSON.parse(line)
        if (Array.isArray(entry.body?.tools) && entry.body.tools.length > 0) count += 1
      } catch {}
    }
    return count
  } catch {
    return 0
  }
}

const argv = process.argv.slice(2)
const wire = argv[argv.indexOf("--wire") + 1]
const messageArg = argv[argv.indexOf("--messages") + 1]
const settleFlag = argv.find((arg) => arg.startsWith("--settle="))
const settle = settleFlag ? Number(settleFlag.slice("--settle=".length)) : 1500
if (!wire || !messageArg) {
  console.error('usage: node verify/drive-chat.mjs --wire <wire.jsonl> --messages "one|two|three" [--settle=ms]')
  process.exit(2)
}
const messages = messageArg.split("|").filter((text) => text.length > 0)

const socket = await connect()
const handshake = await rpc(socket, "simulation.handshake", {
  client: { name: "focus-todo-chat", version: "0.1.0" },
  expectedRole: "ui",
  offeredVersions: [1],
  requiredCapabilities: ["ui.type"],
  optionalCapabilities: CAPABILITIES,
})
console.log(`handshake: role=${handshake.role} protocol=${handshake.protocolVersion} capabilities=${handshake.capabilities.length}`)
await rpc(socket, "ui.resize", VIEWPORT)
await sleep(1200)

let turns = await agentRequests(wire)
console.log(`starting from ${turns} agent request(s) in ${wire}`)

for (const [index, message] of messages.entries()) {
  const before = turns
  await rpc(socket, "ui.type", { text: message })
  await rpc(socket, "ui.enter")
  const deadline = Date.now() + 60000
  for (;;) {
    turns = await agentRequests(wire)
    if (turns > before) break
    if (Date.now() > deadline) throw new Error(`no reply to message ${index + 1}: ${JSON.stringify(message)}`)
    await sleep(400)
  }
  await sleep(settle)
  console.log(`message ${index + 1}/${messages.length} ${JSON.stringify(message)} -> agent requests ${before} → ${turns}`)
}

const frame = await rpc(socket, "ui.capture")
const strings = []
const collect = (value) => {
  if (typeof value === "string") strings.push(value)
  else if (Array.isArray(value)) for (const item of value) collect(item)
  else if (value && typeof value === "object") for (const item of Object.values(value)) collect(item)
}
collect(frame)
const rail = strings.filter((text) => text.trim().length > 0 && text.length < 80).filter((text) => /Focus|待办|提醒|t\d:/.test(text))
console.log(`--- sidebar lines after ${messages.length} typed turns ---`)
for (const line of rail.slice(0, 12)) console.log(`  ${JSON.stringify(line.trim())}`)
console.log(`typed ${messages.length} turns, ${turns} agent request(s) total`)
socket.close()
process.exit(0)
