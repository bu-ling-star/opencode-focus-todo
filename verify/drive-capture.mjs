/**
 * Headless verification of the sidebar panel against a real OpenCode TUI.
 *
 * OpenCode ships a UI simulation protocol: with `OPENCODE_DRIVE=1` the TUI
 * renders headlessly and listens on ws://127.0.0.1:40900 (ui) /
 * ws://127.0.0.1:40950 (backend) instead of requiring a terminal. This script
 * connects to the ui endpoint, performs the handshake, resizes the viewport so
 * the sidebar is visible, captures the rendered frame and reports whether the
 * expected text is on screen.
 *
 * Usage: node verify/drive-capture.mjs <sessionID> <expected text>...
 *
 * Assertions:
 *   "text"   the frame must contain it (row/column are reported, so a caller can
 *            see whether the text sits in the sidebar region rather than the
 *            transcript)
 *   "!text"  the frame must NOT contain it (used for the empty-state checks)
 * Flags:
 *   --min-col=N  every expected string must appear at column >= N
 *
 * The TUI itself is started separately (see README.md §verify), because it owns
 * the terminal and must outlive this script.
 */
// Node >= 22 provides a global WebSocket client; no dependency is needed.
const ENDPOINT = "ws://127.0.0.1:40900"
const VIEWPORT = { cols: 200, rows: 50 }
const CAPABILITIES = [
  "ui.state",
  "ui.snapshot",
  "ui.capture",
  "ui.matches",
  "ui.resize",
  "ui.type",
  "ui.press",
  "ui.enter",
  "ui.arrow",
  "ui.focus",
  "ui.click",
  "ui.mouse",
  "ui.recording.finish",
]

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

function rpc(socket, method, params, timeoutMs = 15000) {
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

/** Every string reachable in a captured frame, in order. */
function collectStrings(value, out = []) {
  if (typeof value === "string") out.push(value)
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out)
  else if (value && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, out)
  return out
}

/** First (row, column) where `needle` occurs, using span widths as columns. */
function locate(frame, needle) {
  for (let row = 0; row < (frame.lines?.length ?? 0); row += 1) {
    let column = 0
    for (const span of frame.lines[row].spans ?? []) {
      const text = String(span.text ?? "")
      const at = text.indexOf(needle)
      if (at >= 0) return { row, column: column + at }
      column += span.width ?? 1
    }
  }
  return undefined
}

const argv = process.argv.slice(2)
const minColFlag = argv.find((arg) => arg.startsWith("--min-col="))
const minColumn = minColFlag ? Number(minColFlag.slice("--min-col=".length)) : undefined
const bare = argv.filter((arg) => !arg.startsWith("--"))
const sessionID = bare[0]
const expected = bare.slice(1).filter((arg) => !arg.startsWith("!"))
const forbidden = bare.slice(1).filter((arg) => arg.startsWith("!")).map((arg) => arg.slice(1))
if (!sessionID || (expected.length === 0 && forbidden.length === 0)) {
  console.error("usage: node verify/drive-capture.mjs <sessionID> [--min-col=N] <expected text|!absent text>...")
  process.exit(2)
}

const socket = await connect()

const handshake = await rpc(socket, "simulation.handshake", {
  client: { name: "focus-todo-verify", version: "0.1.0" },
  expectedRole: "ui",
  offeredVersions: [1],
  requiredCapabilities: ["ui.capture"],
  optionalCapabilities: CAPABILITIES,
})
console.log(`handshake: role=${handshake.role} protocol=${handshake.protocolVersion} capabilities=${handshake.capabilities.length}`)

await rpc(socket, "ui.resize", VIEWPORT)
await sleep(1200)

const frame = await rpc(socket, "ui.capture")
const strings = collectStrings(frame)
const haystack = strings.join("\n")

const missing = expected.filter((text) => !haystack.includes(text))
const present = forbidden.filter((text) => haystack.includes(text))
const misplaced = minColumn === undefined
  ? []
  : expected.filter((text) => {
      const at = locate(frame, text)
      return at !== undefined && at.column < minColumn
    })

console.log(`\n--- captured frame ${frame.cols}x${frame.rows} (${strings.length} strings, ${haystack.length} chars) ---`)
console.log(haystack.slice(0, 4000))
console.log("--- end ---\n")

for (const text of expected) {
  const at = locate(frame, text)
  console.log(at ? `at row=${at.row} col=${at.column}: ${JSON.stringify(text)}` : `not found: ${JSON.stringify(text)}`)
}
for (const text of present) console.log(`unexpectedly present: ${JSON.stringify(text)}`)

if (missing.length > 0) {
  console.error(`MISSING: ${JSON.stringify(missing)}`)
  socket.close()
  process.exit(1)
}
if (present.length > 0) {
  console.error(`PRESENT BUT MUST BE ABSENT: ${JSON.stringify(present)}`)
  socket.close()
  process.exit(1)
}
if (misplaced.length > 0) {
  console.error(`LEFT OF COLUMN ${minColumn}: ${JSON.stringify(misplaced)}`)
  socket.close()
  process.exit(1)
}
console.log(`OK: found ${expected.length} expected string(s)${forbidden.length ? `, absent ${forbidden.length}` : ""}${minColumn === undefined ? "" : `, all at col>=${minColumn}`}`)
socket.close()
process.exit(0)
