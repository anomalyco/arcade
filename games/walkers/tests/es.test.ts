import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { evaluate, policyShape } from "../shared/episode"
import { Es } from "../shared/es"
import { DEFAULT_REWARD } from "../shared/episode"
import { envFor } from "../shared/tasks"
import { inlineEvaluator, parsePolicy, Trainer } from "../shared/trainer"

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

  test("is deterministic for a seed", async () => {
    const run = async () => {
      const t = new Trainer({ creature: "worm", env: envFor("room"), hidden: 8, seed: 5, es: { pairs: 4, sigma: 0.05, lr: 0.03, weightDecay: 0.005 } }, inlineEvaluator)
      for (let g = 0; g < 3; g++) await t.generation()
      return Array.from(t.es.theta).join(",")
    }
    expect(await run()).toBe(await run())
  })

  test("a quadruped learns to move forward within a few generations", async () => {
    const t = new Trainer({ creature: "quadruped", env: envFor("room"), hidden: 8, seed: 1, es: { pairs: 12, sigma: 0.06, lr: 0.03, weightDecay: 0.005 }, reward: { ...DEFAULT_REWARD, seconds: 4 } }, inlineEvaluator)
    const first = await t.generation()
    for (let g = 0; g < 20; g++) await t.generation()
    const last = t.history[t.history.length - 1]!
    expect(t.best!.fitness).toBeGreaterThan(first.best + 0.5)
    expect(last.mean).toBeGreaterThan(first.mean)
  }, 30_000)
})

describe("policies", () => {
  test("parsePolicy rejects malformed files", () => {
    expect(parsePolicy(null)).toBeNull()
    expect(parsePolicy({ format: "walkers-policy", version: 1, creature: "biped", task: "room", hidden: 16, params: [1, 2] })).toBeNull()
    expect(parsePolicy({ format: "walkers-policy", version: 2, sim: 1, creature: "biped", env: envFor("room"), hidden: 16, params: [] })).toBeNull()
    expect(parsePolicy({ format: "walkers-policy", version: 2, sim: 2, creature: "biped", env: { task: "moon" }, hidden: 16, params: [] })).toBeNull()
  })

  test("shipped pre-trained policies replay to exactly their recorded score", () => {
    const dir = join(import.meta.dir, "../src/pretrained")
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      const p = parsePolicy(JSON.parse(readFileSync(join(dir, f), "utf8")))
      expect(p).not.toBeNull()
      expect(f).toBe(`${p!.creature}-${p!.env.task}.json`)
      const r = evaluate(p!.creature, p!.env, policyShape(p!.creature, p!.hidden), Float64Array.from(p!.params), p!.reward)
      expect(r.fitness).toBe(p!.fitness)
    }
  })
})
