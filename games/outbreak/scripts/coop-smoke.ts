// Two headless protocol clients (the game's own NetSession, no browser) in one co-op room: join, see each other,
// walk to the Ash House front door and open it, shoot, then check that both clients agree and report bandwidth.
//
//   bun run dev:server                                   # wrangler dev on :8797 (in another shell)
//   bun scripts/coop-smoke.ts                            # against ws://127.0.0.1:8797
//   bun scripts/coop-smoke.ts --url=https://anoma.ly/arcade/outbreak/ --room=abcd
import assert from "node:assert/strict"
import { randomRoomCode } from "@arcade/kit/sim/matchmaking"
import { TICK_DT } from "../shared/clock"
import type { Command } from "../shared/session"
import { NetSession } from "../src/net-session"

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=")
const base = new URL(arg("url") ?? "http://127.0.0.1:8797/arcade/outbreak/")
const room = arg("room") ?? `t${randomRoomCode(undefined, Math.random, 5)}`
const wsUrl = `${base.protocol === "https:" ? "wss" : "ws"}://${base.host}${base.pathname.replace(/\/?$/, "/")}ws/${room}`
const memory = new Map<string, string>()
const store = (p: string) => ({ getItem: (k: string) => memory.get(p + k) ?? null, setItem: (k: string, v: string) => void memory.set(p + k, v) })

const a = new NetSession({ url: wsUrl, room, name: "Smoke A", storage: store("a") })
const b = new NetSession({ url: wsUrl, room, name: "Smoke B", storage: store("b") })
const clients = [a, b]
const commands = new Map<NetSession, () => Command>(clients.map((c) => [c, () => ({ mx: 0, my: 0, aim: -Math.PI / 2, interact: false })]))

// Fixed 60 Hz command stream per client, like the game's FrameClock.
let ticks = 0
const start = performance.now()
const timer = setInterval(() => {
  const due = Math.floor((performance.now() - start) / (TICK_DT * 1000))
  while (ticks < due) {
    ticks++
    for (const c of clients) c.update(TICK_DT, commands.get(c)!())
  }
  for (const c of clients) c.sync(1 / 60)
}, 8)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(what: string, test: () => boolean, ms = 8000): Promise<void> {
  const end = performance.now() + ms
  while (!test()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what} (a: ${a.status}, b: ${b.status})`)
    await sleep(20)
  }
}

const report: Record<string, unknown> = { url: wsUrl, room }
try {
  await until("both welcomed", () => a.connected && b.connected)
  await until("roster of two", () => a.roster.length === 2 && b.roster.length === 2)
  await until("each sees the other", () => a.remotes.length === 1 && b.remotes.length === 1)
  report.seats = [a.index, b.index]

  // A walks to the front door of Ash House and opens it.
  const target = { x: 27.7, y: 36.4 }
  commands.set(a, () => {
    const p = a.view.player
    const dx = target.x - p.x
    const dy = target.y - p.y
    const d = Math.hypot(dx, dy)
    return d < 0.15 ? { mx: 0, my: 0, aim: -Math.PI / 2, interact: false } : { mx: dx / d, my: dy / d, aim: -Math.PI / 2, interact: false }
  })
  await until("A at the door", () => Math.hypot(a.view.player.x - target.x, a.view.player.y - target.y) < 0.2, 10000)
  let pressed = false
  commands.set(a, () => {
    const press = !pressed
    pressed = true
    return { mx: 0, my: 0, aim: -Math.PI / 2, interact: press }
  })
  const doorOpen = (c: NetSession) => c.sim.town.doors.find((d) => d.id === "ash-front")!.open
  const opened = performance.now()
  await until("door open for both", () => doorOpen(a) && doorOpen(b))
  report.doorSeenMs = Math.round(performance.now() - opened)

  // A turns and fires once.
  const ammo = a.view.player.magAmmo
  let fired = false
  commands.set(a, () => {
    const fire = !fired
    fired = true
    return { mx: 0, my: 0, aim: Math.PI / 2, interact: false, fire }
  })
  await until("shot seen by both", () => a.view.player.magAmmo === ammo - 1 && b.view.shots.length > 0 && a.view.shots.length > 0)
  assert.equal(b.view.shots.at(-1)!.id, a.view.shots.at(-1)!.id)
  commands.set(a, () => ({ mx: 0, my: 0, aim: Math.PI / 2, interact: false }))

  // Agreement: B's view of A matches A's own (both settled), and both have the same zombies at the same tick.
  await sleep(600)
  const aSelf = a.view.player
  const aOnB = b.remotes[0]!.survivor
  report.positionDisagreementM = +Math.hypot(aSelf.x - aOnB.x, aSelf.y - aOnB.y).toFixed(4)
  assert.ok((report.positionDisagreementM as number) < 0.05, "B sees A where A is")
  await until("same latest tick", () => a.snapshots.latest?.tick === b.snapshots.latest?.tick, 3000)
  const za = a.snapshots.latest!.zombies
  const zb = b.snapshots.latest!.zombies
  assert.deepEqual(za, zb, "both clients received the same zombies")
  report.zombies = za.length
  assert.deepEqual(a.snapshots.latest!.doors, b.snapshots.latest!.doors)

  // Bandwidth over a 5 s window of normal play (A walks back, B idles).
  const before = clients.map((c) => [c.bytesIn, c.bytesOut, c.snapshotCount])
  commands.set(a, () => ({ mx: Math.sin(ticks / 40), my: 0.5, aim: ticks / 50, interact: false, sprint: true }))
  await sleep(5000)
  report.downKBps = clients.map((c, i) => +((c.bytesIn - before[i]![0]!) / 5 / 1024).toFixed(2))
  report.upKBps = clients.map((c, i) => +((c.bytesOut - before[i]![1]!) / 5 / 1024).toFixed(2))
  report.snapshotsPerSecond = clients.map((c, i) => +((c.snapshotCount - before[i]![2]!) / 5).toFixed(1))
  report.rttMs = clients.map((c) => Math.round(c.rtt * 1000))
  report.pendingCommands = clients.map((c) => c.predictor.unacked.length)
  report.ok = true
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  console.error(JSON.stringify(report, null, 2))
  console.error(error)
  process.exitCode = 1
} finally {
  clearInterval(timer)
  for (const c of clients) c.close()
}
