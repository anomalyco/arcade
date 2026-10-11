// End-to-end WebSocket smoke test against a running worker.
//
//   bun run build && bunx wrangler dev --port 8790
//   bun scripts/ws-smoke.ts http://localhost:8790
//
// Creates a room, connects two players, the host starts a match with bots, both aim and lock,
// and asserts both receive a `volley` with the same result.hash. Then reconnects player B with
// the same pid and checks it rejoins as the same player.
import type { ClientMsg, MatchView, ServerMsg } from "../src/sim/protocol"

const origin = (process.argv[2] ?? process.env.SALVO_URL ?? "http://localhost:8790").replace(/\/$/, "")
const wsOrigin = origin.replace(/^http/, "ws")
const TIMEOUT = 45_000

function fail(message: string): never {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

class Client {
  ws!: WebSocket
  you: string | null = null
  view: MatchView | null = null
  locked = -1
  volleys: Array<Extract<ServerMsg, { type: "volley" }>> = []
  waiters: Array<() => void> = []

  constructor(readonly label: string, readonly room: string, readonly pid: string) {}

  open(): Promise<void> {
    this.ws = new WebSocket(`${wsOrigin}/labs/salvo/ws/${this.room}?pid=${this.pid}`)
    this.ws.onmessage = (event) => this.onMessage(JSON.parse(String(event.data)) as ServerMsg)
    return new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve()
      this.ws.onerror = () => reject(new Error(`${this.label}: socket error`))
    })
  }

  send(msg: ClientMsg) {
    this.ws.send(JSON.stringify(msg))
  }

  onMessage(msg: ServerMsg) {
    if (msg.type === "welcome") {
      this.you = msg.you
      this.view = msg.view
    } else if (msg.type === "state") this.view = msg.view
    else if (msg.type === "volley") {
      this.volleys.push(msg)
      this.view = msg.after
    } else if (msg.type === "error") console.log(`${this.label} error: ${msg.message}`)
    this.act()
    for (const w of this.waiters.splice(0)) w()
  }

  // play along: aim and lock once per volley, ready up in the shop
  act() {
    const v = this.view
    if (!v || !this.you) return
    const me = v.players.find((p) => p.id === this.you)
    if (!me || me.spectator) return
    if (v.phase === "aim" && this.locked !== v.volley && !me.locked) {
      this.locked = v.volley
      this.send({ type: "aim", angle: 0.9 + Math.random() * 1.3, power: 55 + Math.random() * 20, weapon: "shell" })
      this.send({ type: "lock" })
    }
    if (v.phase === "shop" && !me.locked) this.send({ type: "ready" })
  }

  async until(check: () => boolean, what: string) {
    const deadline = Date.now() + TIMEOUT
    while (!check()) {
      if (Date.now() > deadline) fail(`${this.label}: timed out waiting for ${what}`)
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
        setTimeout(resolve, 250)
      })
    }
  }
}

const health = await fetch(`${origin}/labs/salvo/api/health`)
if (!health.ok) fail(`health returned ${health.status}`)
const created = await fetch(`${origin}/labs/salvo/api/rooms`, { method: "POST" })
const { room } = (await created.json()) as { room: string }
if (!/^[a-z0-9]{5}$/.test(room)) fail(`bad room id ${room}`)
const link = await fetch(`${origin}/labs/salvo/r/${room}`)
if (!link.ok || !(await link.text()).includes("<canvas")) fail(`room link returned ${link.status}`)
console.log(`room ${room}`)

const a = new Client("A", room, "smokeplayeraaaa")
const b = new Client("B", room, "smokeplayerbbbb")
await a.open()
a.send({ type: "join", name: "Alpha", cls: "crawler", level: 3 })
await a.until(() => a.you !== null, "welcome")
await b.open()
b.send({ type: "join", name: "Bravo", cls: "rail", level: 1 })
await b.until(() => b.you !== null && (b.view?.players.length ?? 0) >= 2, "welcome")
if (a.you !== a.pid || b.you !== b.pid) fail(`ids did not follow pid: ${a.you} ${b.you}`)

const host = [a, b].find((c) => c.view?.players.find((p) => p.id === c.you)?.host) ?? a
console.log(`host ${host.label}, starting`)
host.send({ type: "start", mode: "ffa", bots: 2, battles: 1 })

await a.until(() => a.volleys.length > 0, "volley")
await b.until(() => b.volleys.length > 0, "volley")
const ha = a.volleys[0]!.result.hash
const hb = b.volleys[0]!.result.hash
if (ha !== hb) fail(`hash mismatch ${ha} vs ${hb}`)
console.log(`volley ok: hash ${ha}, ${a.volleys[0]!.shots.length} shots, ${a.volleys[0]!.result.events.length} events`)

// reconnect B with the same pid
b.ws.close()
await new Promise((r) => setTimeout(r, 300))
const b2 = new Client("B2", room, b.pid)
await b2.open()
b2.send({ type: "join", name: "Bravo", cls: "rail", level: 1 })
await b2.until(() => b2.you !== null, "rejoin welcome")
const humans = b2.view!.players.filter((p) => !p.bot)
if (b2.you !== b.pid || humans.length !== 2) fail(`rejoin produced ${humans.length} humans as ${b2.you}`)
console.log("reconnect ok")

// garbage input must not kill the room
b2.ws.send("{not json")
b2.ws.send(JSON.stringify({ type: "aim", angle: "x" }))
b2.send({ type: "ping", t: Date.now() })
let ponged = false
b2.ws.addEventListener("message", (e) => { if (String(e.data).includes('"pong"')) ponged = true })
await b2.until(() => ponged, "pong after garbage")

a.ws.close()
b2.ws.close()
console.log("PASS")
process.exit(0)
