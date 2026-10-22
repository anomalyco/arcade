// Real-socket smoke of a running woods Worker (wrangler dev or the live site), no browser:
//   bun scripts/ws-smoke.ts [--url http://127.0.0.1:5298/arcade/woods/]
// Two clients join one room by code, see each other, one ties a tape the other receives, one drops and reclaims its
// seat with the token. Prints bytes per second per client.
import { BUILD } from "../shared/build.gen"
import { decodeServer, packIntent, tapeFromRow, type ServerMsg, type Snapshot } from "../shared/protocol"
import { tieTarget, type PlayerInput } from "../shared/sim"
import { makeWorld } from "../shared/world"

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : fallback }
const base = new URL(arg("--url", "http://127.0.0.1:5298/arcade/woods/"))
const world = makeWorld()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const room = ((await (await fetch(new URL("api/create", base), { method: "POST" })).json()) as { room: string }).room
console.log("room", room)

type Client = { name: string; ws: WebSocket; got: ServerMsg[]; bytes: number; token?: string; seq: number; me: number; snap?: Snapshot; tapes: number[][] }
function join(name: string, token?: string): Promise<Client> {
  const ws = new WebSocket(`${base.protocol === "https:" ? "wss" : "ws"}://${base.host}${base.pathname}ws/${room}`)
  const c: Client = { name, ws, got: [], bytes: 0, seq: 0, me: -1, tapes: [] }
  return new Promise((resolve, reject) => {
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", build: BUILD, name, token }))
    ws.onerror = () => reject(new Error(`${name}: socket error`))
    ws.onmessage = (e) => {
      const raw = String(e.data)
      c.bytes += raw.length
      const m = decodeServer(raw)
      if (!m) return
      c.got.push(m)
      if (m.type === "welcome") c.token = (m as { token: string }).token
      if (m.type === "s") { c.snap = m; c.me = m.me; if (m.tapes) c.tapes = m.tapes; resolve(c) }
      if (m.type === "error" || m.type === "reload") reject(new Error(`${name}: ${raw}`))
    }
  })
}
const send = (c: Client, i: Partial<PlayerInput>) => c.ws.send(JSON.stringify({ type: "intent", seq: c.seq++, i: packIntent({ yaw: 0, pitch: 0, light: true, tie: false, map: false, mx: 0, mz: 0, ...i }) }))
async function drive(cs: Client[], seconds: number, input: (c: Client) => Partial<PlayerInput>) {
  for (let t = 0; t < seconds * 30; t++) { for (const c of cs) send(c, input(c)); await sleep(1000 / 30) }
}
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) process.exitCode = 1 }

const a = await join("Kit"), b = await join("Aiden")
await drive([a, b], 1, () => ({}))
const seen = (c: Client, id: number) => !!c.snap?.p.some((r) => r[0] === id)
check(seen(a, b.me) && seen(b, a.me), `both see each other (ids ${a.me}, ${b.me}; ${a.snap!.p.length} walkers incl. bots)`)
const lit = b.snap!.p.find((r) => r[0] === a.me)!
check(!!(lit[7]! & 1), "Kit's flashlight is on in Aiden's snapshot")

// Kit walks to the nearest trunk and holds E.
const row = () => a.snap!.p.find((r) => r[0] === a.me)!
const me = () => ({ x: row()[1]! / 100, z: row()[2]! / 100 })
const tree = [...world.trees].sort((p, q) => Math.hypot(p.x - me().x, p.z - me().z) - Math.hypot(q.x - me().x, q.z - me().z))[0]!
const stand = { x: tree.x, z: tree.z + tree.radius + 0.7 }
for (let t = 0; t < 30 * 30 && Math.hypot(stand.x - me().x, stand.z - me().z) > 0.3; t++) {
  const dx = stand.x - me().x, dz = stand.z - me().z, d = Math.hypot(dx, dz)
  send(a, { mx: dx / d, mz: dz / d }); send(b, {}); await sleep(1000 / 30)
}
console.log("at tree", tree.id, "distance", Math.hypot(stand.x - me().x, stand.z - me().z).toFixed(2), "target", tieTarget(world, { ...me(), yaw: 0 } as never, 1.6)?.id)
await drive([a, b], 2, (c) => (c === a ? { tie: true } : {}))
const tapeEvents = a.got.flatMap((m) => (m.type === "ev" ? (m as { events: { kind: string; tree?: number; by?: number }[] }).events : [])).filter((e) => e.kind.startsWith("tape"))
console.log("tape events seen by Kit:", JSON.stringify(tapeEvents.map((e) => [e.kind, e.tree, e.by])), "Kit's tie:", JSON.stringify(row().slice(7)))
check(b.tapes.some((r) => tapeFromRow(world, r)?.tree === tree.id), `Aiden received Kit's tape on tree ${tree.id}`)

// Aiden drops and comes back with the seat token.
const bytes = b.bytes, t0 = performance.now()
await drive([a, b], 3, () => ({ mx: 0.3 }))
const kbs = (b.bytes - bytes) / ((performance.now() - t0) / 1000) / 1024
const token = b.token, id = b.me
b.ws.close()
await drive([a], 2, () => ({}))
const away = a.got.filter((m) => m.type === "roster").at(-1) as { players: { pid: number; connected: boolean }[] } | undefined
check(!!away?.players.some((r) => r.pid === id && !r.connected), "Kit's roster shows Aiden dropped")
const b2 = await join("Aiden", token)
await drive([a, b2], 1, () => ({}))
check(b2.me === id && b2.tapes.some((r) => tapeFromRow(world, r)?.tree === tree.id), `Aiden is back as ${b2.me} and still sees the tape`)
console.log(`down per client (2 people + bots walking): ${kbs.toFixed(2)} KB/s`)
a.ws.close(); b2.ws.close()
