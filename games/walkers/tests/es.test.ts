import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { evaluate, policyShape } from "../shared/episode"
import { Es } from "../shared/es"
import { envFor } from "../shared/tasks"
import { parsePolicy } from "../shared/trainer"

describe("evolution strategies", () => {
  test("climbs a trivial objective", () => {
    const n = 20
    const target = Float64Array.from({ length: n }, (_, i) => Math.sin(i))
    const score = (row: Float64Array) => -row.reduce((s, v, i) => s + (v - target[i]!) ** 2, 0)
    const es = new Es(new Float64Array(n), { pairs: 16, sigma: 0.1, lr: 0.05, weightDecay: 0 }, 1)
    const start = score(es.theta)
    for (let g = 0; g < 150; g++) {
      const rows = es.ask()
      const fitness = Array.from({ length: es.population }, (_, i) => score(rows.subarray(i * n, (i + 1) * n)))
      es.tell(fitness)
    }
    expect(score(es.theta)).toBeGreaterThan(start * 0.05)
  })

  test("is deterministic for a seed", () => {
    const run = () => {
      const es = new Es(new Float64Array(20), { pairs: 4, sigma: 0.05, lr: 0.03, weightDecay: 0.005 }, 5)
      for (let g = 0; g < 3; g++) {
        const rows = es.ask()
        es.tell(Array.from({ length: es.population }, (_, i) =>
          -rows.subarray(i * 20, (i + 1) * 20).reduce((sum, v) => sum + (v - 1) ** 2, 0)))
      }
      return Array.from(es.theta)
    }
    expect(run()).toEqual(run())
  })
})

describe("policies", () => {
  test("parsePolicy rejects malformed files", () => {
    expect(parsePolicy(null)).toBeNull()
    expect(parsePolicy({ format: "walkers-policy", version: 1, creature: "biped", task: "room", hidden: 16, params: [1, 2] })).toBeNull()
    expect(parsePolicy({ format: "walkers-policy", version: 2, sim: 1, creature: "biped", env: envFor("room"), hidden: 16, params: [] })).toBeNull()
    expect(parsePolicy({ format: "walkers-policy", version: 2, sim: 2, creature: "biped", env: { task: "moon" }, hidden: 16, params: [] })).toBeNull()
  })

  test("shipped pre-trained policies replay their recorded behaviour bit-identically", () => {
    const dir = join(import.meta.dir, "../src/pretrained")
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"))
    expect(files.length).toBeGreaterThan(0)
    expect(files).toContain("quadruped-room.json")
    expect(files).toContain("quadruped-heist.json")
    expect(files).toContain("human-heist.json")
    for (const f of files) {
      const p = parsePolicy(JSON.parse(readFileSync(join(dir, f), "utf8")))
      expect(p).not.toBeNull()
      expect(f).toBe(`${p!.creature}-${p!.env.task}.json`)
      const r = evaluate(p!.creature, p!.env, policyShape(p!.creature, p!.hidden), Float64Array.from(p!.params), p!.reward)
      expect(r.fitness).toBe(p!.fitness)
      expect(r.distance).toBe(p!.distance)
      expect(r.time).toBe(p!.time!)
      expect(r.outcome).toBe(p!.outcome!)
      expect(r.alarms).toBe(p!.alarms!)
    }
  })
})
