// Bytes on the wire in a full 32-player room: `bun scripts/net-bandwidth.ts [--seconds=20]`.
// A deterministic RoomCore with fake sockets: 4 carriers of 8 (helm, 2 Hornets and the F-35C in the air, 3 gunners,
// the boat out), each client sending what its seam sends (jets 20 Hz, aims 10 Hz, boat orders 20 Hz, helm on change
// plus 1 Hz, pings every 2 s, triggers and hit reports now and then). Prints payload bytes per second per client, both ways, and with
// WebSocket framing (2-4 B header per server frame, 6-8 B per masked client frame).
import { type Conn, RoomCore } from "../server/core"
import { BUILD } from "../shared/build.gen"
import { CREW, playerOf } from "../shared/crew"
import { type ClientMsg, type PlaneTuple, type ServerMsg, decodeServer, encode } from "../shared/protocol"

const SECONDS = Number(process.argv.find((a) => a.startsWith("--seconds="))?.split("=")[1] ?? 20)
const TICK = 50

const size = (data: string | Uint8Array) => (typeof data === "string" ? Buffer.byteLength(data) : data.byteLength)
const header = (n: number, masked: boolean) => (n < 126 ? 2 : n < 65536 ? 4 : 10) + (masked ? 4 : 0)

class Client implements Conn {
  id = 0
  down = 0
  downFramed = 0
  downFrames = 0
  up = 0
  upFramed = 0
  counting = false
  byType = new Map<string, number>()
  send(data: string | Uint8Array) {
    const m = decodeServer(data) as ServerMsg | null
    if (!m) throw new Error("bad frame")
    if (m.type === "welcome") this.id = m.id
    if (!this.counting) return
    const n = size(data)
    this.down += n
    this.downFramed += n + header(n, false)
    this.downFrames++
    this.byType.set(m.type, (this.byType.get(m.type) ?? 0) + n)
  }
  close() {}
}

let now = 1_700_000_000_000
const epoch = now
const core = new RoomCore(
  () => now,
  () => 7,
)
const clients: Client[] = []
const say = (c: Client, msg: ClientMsg) => {
  const data = encode(msg) as string | Uint8Array
  if (c.counting) {
    const n = size(data)
    c.up += n
    c.upFramed += n + header(n, true)
  }
  core.message(c, data)
}
const step = (ms: number, each?: (t: number) => void) => {
  for (let left = ms; left > 0; left -= TICK) {
    now += TICK
    // Clients ping every 2 s (src/net.ts PING_MS), which also keeps the room from dropping them as silent.
    if (now % 2000 < TICK) for (const c of clients) say(c, { type: "ping", c: now - epoch })
    each?.((now - epoch) / 1000)
    core.step(now)
  }
}

for (let i = 0; i < CREW.roomMax; i++) {
  const c = new Client()
  clients.push(c)
  say(c, { type: "hello", build: BUILD, name: `p${i}` })
}
const crew = () => core.crew!
const ops = ["hornet", "hornet", "f35", "ciws-port", "ciws-stbd", "sam-port", "boat"]
for (const ship of crew().ships) {
  const aboard = clients.filter((c) => playerOf(crew(), c.id)?.ship === ship.id && crew().ships.find((s) => s.id === ship.id)?.helm !== c.id)
  aboard.forEach((c, i) => {
    say(c, { type: "op", op: ops[i]! })
    step(10_000)
  })
}
const roleOf = (c: Client) => {
  const p = playerOf(crew(), c.id)!
  const s = crew().ships.find((x) => x.id === p.ship)!
  if (s.helm === c.id) return "helm"
  if (p.role === "gunner") return "gunner"
  const slot = s.aircraft[p.plane]
  return slot?.op === "boat" ? "boat" : p.plane >= 0 ? "jet" : "deck"
}
const roles = new Map(clients.map((c) => [c, roleOf(c)]))
const count = (r: string) => [...roles.values()].filter((x) => x === r).length
console.log(`room: ${clients.length} players, ${count("helm")} helms, ${count("jet")} jets, ${count("gunner")} gunners, ${count("boat")} boats, ${count("deck")} on deck`)

const jet = (i: number, t: number): PlaneTuple => {
  const a = t * 0.3 + i
  const r = (v: number, k: number) => Math.round(v * k) / k
  const half = Math.sin(a * 0.5)
  return [r(t, 1e3), 1, r(Math.cos(a) * 3000 + i * 50, 1e2), r(800 + i * 20, 1e2), r(Math.sin(a) * 3000, 1e2), 0, r(half, 1e4), 0, r(Math.cos(a * 0.5), 1e4), r(-Math.sin(a) * 200, 10), r(1.3, 10), r(Math.cos(a) * 200, 10), 0.85, i % 3 === 0 ? 1 : 0, 0, r(Math.sin(t) * 0.3, 100), r(Math.cos(t) * 0.4, 100), 0, 0.12]
}

for (const c of clients) c.counting = true
let tick = 0
step(SECONDS * 1000, (t) => {
  tick++
  clients.forEach((c, i) => {
    const role = roles.get(c)
    if (role === "jet") {
      say(c, { type: "plane", p: jet(i, t) })
      if (tick % 40 === 0) say(c, { type: "gun", on: true })
      if (tick % 40 === 10) say(c, { type: "gun", on: false })
    } else if (role === "gunner" && tick % 2 === 0) {
      say(c, { type: "aim", a: [Math.round(Math.sin(t + i) * 1500), Math.round(300 + Math.cos(t) * 200), tick % 20 < 5 ? 1 : 0] })
    } else if (role === "boat") {
      say(c, { type: "boat", c: [0.8, Math.round(Math.sin(t) * 100) / 100, 0, Math.round(Math.sin(t) * 1000), 50, tick % 20 < 4 ? 1 : 0] })
    } else if (role === "helm" && tick % 20 === 0) {
      say(c, { type: "helm", o: 0.6, r: Math.round(Math.sin(t / 5) * 1000) / 1000 })
    }
  })
})

const avg = (f: (c: Client) => number) => clients.reduce((s, c) => s + f(c), 0) / clients.length / SECONDS
const kb = (v: number) => `${(v / 1024).toFixed(2)} KB/s`
console.log(`${SECONDS} s, per client:`)
console.log(`  down: ${kb(avg((c) => c.down))} payload, ${kb(avg((c) => c.downFramed))} framed, ${avg((c) => c.downFrames).toFixed(1)} frames/s`)
console.log(`  up (all clients averaged): ${kb(avg((c) => c.up))} payload, ${kb(avg((c) => c.upFramed))} framed`)
const types = new Map<string, number>()
for (const c of clients) for (const [k, v] of c.byType) types.set(k, (types.get(k) ?? 0) + v)
console.log("  down by message:", [...types].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / clients.length / SECONDS / 1024).toFixed(2)}`).join(", "), "(KB/s)")
const up = new Map<string, number>()
for (const [c, r] of roles) up.set(r, (up.get(r) ?? 0) + c.up / SECONDS)
console.log("  up by role:", [...up].map(([r, v]) => `${r} ${(v / count(r) / 1024).toFixed(2)}`).join(", "), "(KB/s each)")
