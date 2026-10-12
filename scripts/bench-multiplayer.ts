import { appendFileSync, mkdirSync } from "node:fs"
import { hostname } from "node:os"
import { World as Getaway } from "../games/getaway/shared/sim/world"
import { DT } from "../games/getaway/shared/config"
import { World as Blackout, NO_INTENT } from "../games/blackout/shared/sim/world"
import { buildSnapshot, snapshotEntities } from "../games/blackout/shared/sim/view"

const opt = (key: string, fallback: string) => process.argv.find((s) => s.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback
const target = opt("game", "getaway")
const experiment = opt("experiment", "baseline")
const ids = Array.from({ length: target === "getaway" ? 8 : 10 }, (_, i) => `human${i}`)
const median = (a: number[]) => [...a].sort((a, b) => a - b)[Math.floor(a.length / 2)]!
const runs: number[] = []
let expected = ""
for (let run = 0; run < 10; run++) {
  const world = target === "getaway"
    ? new Getaway(7123, [...ids.map((id) => ({ id, name: id, human: true, picks: { robber: "muscle", cop: "cruiser" } })), ...[0, 1].map((i) => ({ id: `bot${i}`, name: `bot${i}`, human: false, picks: { robber: "compact", cop: "interceptor" } }))])
    : new Blackout(7123)
  if (world instanceof Blackout) {
    for (const id of ids) world.addHuman(id, id)
    world.botFill = 14
    world.fill()
  }
  const hash = new Bun.CryptoHasher("sha256")
  let bytes = 0
  let elapsed = 0
  for (let tick = 0; tick < 1000; tick++) {
    const t = performance.now()
    let packets: string[]
    if (world instanceof Getaway) {
      for (let i = 0; i < ids.length; i++) world.setInput(ids[i]!, { throttle: 1, brake: 0, steer: Math.sin((tick + i * 70) * 0.015) * 0.7, handbrake: tick % 180 > 160, boost: tick % 200 < 20 })
      world.step(DT)
      const base = world.viewBase()
      packets = ids.map((id) => JSON.stringify({ type: "snapshot", tick, ack: tick, view: world.view(id, base), you: world.carOf(id)?.body ?? null }))
      packets.push(JSON.stringify(world.drainEvents()))
    } else {
      for (let i = 0; i < ids.length; i++) world.push(ids[i]!, tick + 1, { ...NO_INTENT, mx: Math.sin(tick * 0.02 + i), my: Math.cos(tick * 0.02 + i), aim: tick * 0.03 + i, fire: tick % 3 === 0 })
      world.step()
      const entities = snapshotEntities(world)
      packets = ids.map((id) => JSON.stringify(buildSnapshot(world, id, entities)))
      packets.push(JSON.stringify(world.events))
      world.events.length = 0
    }
    elapsed += performance.now() - t
    // A mock transport consumes every packet; hashing is outside the timed simulation/serialization interval.
    for (const packet of packets) { hash.update(packet); bytes += packet.length }
  }
  const digest = hash.digest("hex")
  if (expected && digest !== expected) throw new Error("Non-deterministic run")
  expected = digest
  if (run) runs.push(elapsed)
  console.log(JSON.stringify({ run, warmup: run === 0, elapsed_ms: elapsed, bytes, digest }))
}
const value = median(runs)
const record = { target: `${target}-multiplayer`, experiment, machine: hostname(), timestamp: new Date().toISOString(), ticks: 1000, connections: ids.length, warmup: 1, measured: 9, median_ms: value, mad_ms: median(runs.map((x) => Math.abs(x - value))), p95_ms: Math.max(...runs), runs, digest: expected }
mkdirSync(new URL("../perf/", import.meta.url), { recursive: true })
appendFileSync(new URL("../perf/results.jsonl", import.meta.url), JSON.stringify(record) + "\n")
console.log(`METRIC ${target}_multiplayer_ms=${value} MAD=${record.mad_ms}`)
