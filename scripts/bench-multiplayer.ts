import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
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
const controls: number[] = []
const deltas: number[] = []
const paired = process.argv.includes("--paired")
let expected = ""
let serializedBytes = 0
function measure(shared: boolean) {
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
      const base = shared ? world.viewBase() : undefined
      packets = ids.map((id) => JSON.stringify({ type: "snapshot", tick, ack: tick, view: world.view(id, base), you: world.carOf(id)?.body ?? null }))
      packets.push(JSON.stringify(world.drainEvents()))
    } else {
      for (let i = 0; i < ids.length; i++) world.push(ids[i]!, tick + 1, { ...NO_INTENT, mx: Math.sin(tick * 0.02 + i), my: Math.cos(tick * 0.02 + i), aim: tick * 0.03 + i, fire: tick % 3 === 0 })
      world.step()
      const entities = shared ? snapshotEntities(world) : undefined
      packets = ids.map((id) => JSON.stringify(buildSnapshot(world, id, entities)))
      packets.push(JSON.stringify(world.events))
      world.events.length = 0
    }
    elapsed += performance.now() - t
    // A mock transport consumes every packet; hashing is outside the timed simulation/serialization interval.
    for (const packet of packets) { hash.update(packet); bytes += packet.length }
  }
  const digest = hash.digest("hex")
  return { elapsed_ms: elapsed, bytes, digest }
}
for (let run = 0; run < 10; run++) {
  const first = measure(!paired || run % 2 === 0)
  const second = paired ? measure(run % 2 !== 0) : null
  const optimized = paired && run % 2 !== 0 ? second! : first
  const control = paired ? run % 2 === 0 ? second! : first : null
  const { digest, elapsed_ms: elapsed, bytes } = optimized
  serializedBytes = bytes
  if (control && (control.digest !== digest || control.bytes !== bytes)) throw new Error("Shared/unshared output mismatch")
  if (expected && digest !== expected) throw new Error("Non-deterministic run")
  expected = digest
  if (run) {
    runs.push(elapsed)
    if (control) { controls.push(control.elapsed_ms); deltas.push(elapsed - control.elapsed_ms) }
  }
  console.log(JSON.stringify({ run, warmup: run === 0, elapsed_ms: elapsed, bytes, digest, control, sharedFirst: !paired || run % 2 === 0 }))
}
const value = median(runs)
const summarize = (values: number[]) => ({ median_ms: median(values), mad_ms: median(values.map((x) => Math.abs(x - median(values)))), p95_ms: Math.max(...values), runs: values })
const record = { target: `${target}-multiplayer`, experiment, machine: hostname(), timestamp: new Date().toISOString(), ticks: 1000, connections: ids.length, warmup: 1, measured: 9, ...summarize(runs), digest: expected, serializedBytes, ...(paired ? { control: summarize(controls), paired_delta: summarize(deltas), identicalOutput: true } : {}) }
mkdirSync(new URL("../perf/", import.meta.url), { recursive: true })
appendFileSync(new URL("../perf/results.jsonl", import.meta.url), JSON.stringify(record) + "\n")
writeFileSync(new URL(`../perf/${target}-multiplayer-${experiment}.json`, import.meta.url), JSON.stringify(record, null, 2) + "\n")
console.log(`METRIC ${target}_multiplayer_ms=${value} MAD=${record.mad_ms}`)
