// CPU-only streaming readiness probe. Sequential runs; no worker fan-out.
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { runHeadlessBotGame } from "../shared/bot-runner"
import { encodeShared, decodeShared } from "../shared/net-protocol"
import type { SharedSnapshot } from "../shared/net-types"

const results = []
for (const players of [1, 2, 3, 4]) {
  let next = 0
  let tick = 0
  let base: SharedSnapshot | undefined
  const samples: Record<string, number>[] = []
  const started = performance.now()
  const result = runHeadlessBotGame({ seed: 7, houseSeed: 7, playerCount: players, preset: "Expert",
    maxDurationSeconds: 2400, timeScale: 120, tickDt: 1 / 30, worldMode: "streaming",
    observe(sim, slots) {
      tick++
      for (const slot of slots) {
        const p = slot.survivor
        for (const value of [p.x, p.y, p.vx, p.vy, p.aim, p.health, p.stamina]) assert(Number.isFinite(value))
      }
      if (sim.time < next) return
      next += 60
      for (const z of sim.ai.agents) for (const value of [z.x, z.y, z.hp]) assert(Number.isFinite(value))
      const full = encodeShared(sim, tick, new Map())
      const delta = encodeShared(sim, tick, new Map(), undefined, { baseSnap: base })
      base = decodeShared(full, sim.town.seed)
      samples.push({ seconds: sim.time, hour: sim.hour, zombies: sim.ai.agents.length,
        living: sim.ai.agents.filter((a) => a.state !== "dead").length,
        chunks: sim.worldStream.activeChunks.size, stores: sim.progression.ledger.stores.size,
        fullBytes: full.length, deltaBytes: delta.length, heapMiB: process.memoryUsage().heapUsed / 1048576 })
    },
  })
  const summary = { players, survived: result.survived, seconds: result.survivalTime, nights: result.nightsSurvived,
    cause: result.causeOfDeath, kills: result.killsByWeapon.total, wallSeconds: (performance.now() - started) / 1000, samples }
  results.push(summary)
  console.log(JSON.stringify(summary))
}
const out = process.argv.find((a) => a.startsWith("--out="))?.slice(6)
if (out) writeFileSync(out, JSON.stringify(results, null, 2))
