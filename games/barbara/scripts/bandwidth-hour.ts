// Simulated hour of a room, in-process (no sockets): bytes each seat receives, per 10 minutes, and how big state gets.
//   bun scripts/bandwidth-hour.ts [--people 6] [--minutes 60]
// Everyone walks their own wide loop through the woods (a fresh path the whole time), regroups every 5 minutes to
// compare maps with everyone for a few seconds, and one person ties and unties a tape on the same trunk all hour.
// Bots fill the room up to TEAM (so a 6-person room has none; run --people 3 to include one).
import { WoodsRoomCore } from "../server/room-core"
import { BUILD } from "../shared/build.gen"
import { packIntent, TEAM, TICK_HZ } from "../shared/protocol"
import type { PlayerInput } from "../shared/sim"

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : fallback }
const people = Number(arg("--people", "6")), minutes = Number(arg("--minutes", "60"))
let now = 0
const room = new WoodsRoomCore("hour", () => now)
type Seat = { conn: { send(d: string): void; close(): void }; bytes: number; biggest: number; seq: number }
const seats: Seat[] = []
for (let k = 0; k < people; k++) {
  const s: Seat = { bytes: 0, biggest: 0, seq: 0, conn: { send: (d) => { s.bytes += d.length; s.biggest = Math.max(s.biggest, d.length) }, close() {} } }
  room.open(s.conn)
  room.message(s.conn, JSON.stringify({ type: "hello", build: BUILD, name: `P${k + 1}` }))
  seats.push(s)
}
const send = (s: Seat, i: Partial<PlayerInput>) => room.message(s.conn, JSON.stringify({ type: "intent", seq: s.seq++, i: packIntent({ yaw: 0, pitch: 0, light: true, tie: false, map: false, mx: 0, mz: 0, ...i }) }))
const humans = () => room.state.players.filter((p) => !p.bot)
const c = room.world.camp
const tree = room.world.trees.find((t) => t.species === "pine" && Math.abs(t.x - c.x) < 60 && Math.abs(t.z - c.z + 60) < 40)!
const block = 10 * 60 * TICK_HZ
let mark = seats.map(() => 0)
const t0 = performance.now()
console.log(`${people} people + ${Math.max(0, TEAM - people)} bots, ${minutes} simulated minutes`)
for (let i = 0; i < minutes * 60 * TICK_HZ; i++) {
  const sec = i / TICK_HZ, regroup = sec % 300 < 5 && sec > 10
  humans().forEach((p, k) => {
    if (k === 0) Object.assign(p, { x: tree.x, z: tree.z + tree.radius + 0.8, vx: 0, vz: 0 })
    else if (regroup) Object.assign(p, { x: c.x + k * 0.8, z: c.z - 40, vx: 0, vz: 0 })
    else { const r = 40 + k * 25, a = sec / (r * 0.55) + k; Object.assign(p, { x: c.x + r * Math.cos(a), z: c.z - 70 + r * Math.sin(a) * 0.8, vx: 0, vz: 0 }) }
  })
  seats.forEach((s, k) => send(s, k === 0 ? { tie: i % 60 < 45 } : { map: regroup }))
  now += 1000 / TICK_HZ
  room.step()
  if ((i + 1) % block === 0) {
    const kbs = seats.map((s, k) => (s.bytes - mark[k]!) / (block / TICK_HZ) / 1024)
    mark = seats.map((s) => s.bytes)
    console.log(`minutes ${((i + 1) / block - 1) * 10}-${((i + 1) / block) * 10}: ${kbs.map((v) => v.toFixed(2)).join(" ")} KB/s per seat`)
  }
}
const s = room.state
console.log(`biggest frame ${Math.max(...seats.map((x) => x.biggest))} B; tapes up ${s.tapes.length} of ${s.nextTape - 1} tied; path samples ${s.players.map((p) => p.map.trail.length / 2).join(", ")}; copied paths per map ${s.players.map((p) => p.map.heard.length).join(", ")}; known tapes per map ${s.players.map((p) => p.map.tapes.length).join(", ")}; whole hour avg ${(seats.reduce((a, x) => a + x.bytes, 0) / seats.length / (minutes * 60) / 1024).toFixed(2)} KB/s per seat; ran in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
