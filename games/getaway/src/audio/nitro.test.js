import { expect, test } from "bun:test"
import { NitroGate } from "./nitro"

test("held boost exhausts once; refuelling while held cannot ignite again", () => {
  const g = new NitroGate()
  let ignitions = 0
  for (let i = 0; i < 600; i++) {
    // Stair-step network fuel, then empty, then regeneration while the key stays down.
    const fuel = i < 180 ? Math.max(0, 1 - Math.floor(i / 6) / 20) : 0.5
    g.update(true, fuel, 1 / 60)
    ignitions += Number(g.ignited)
    if (i >= 120) expect(g.active).toBe(false)
  }
  expect(ignitions).toBe(1)
  for (let tap = 0; tap < 5; tap++) {
    g.update(false, 1, 1 / 60)
    for (let i = 0; i < 6; i++) { g.update(true, 1, 1 / 60); ignitions += Number(g.ignited) }
  }
  expect(ignitions).toBe(6)
  for (let i = 0; i < 7; i++) g.update(false, 1, 1 / 60)
  expect(g.active).toBe(false)
})

test("remote snapshot jitter and discrete fuel drops do not retrigger", () => {
  const g = new NitroGate()
  let ignitions = 0
  for (let i = 0; i < 120; i++) {
    g.update(i % 10 !== 9, 1 - Math.floor(i / 10) * 0.05, 1 / 30, true, true)
    ignitions += Number(g.ignited)
  }
  expect(ignitions).toBe(1)
  for (let i = 0; i < 5; i++) g.update(false, 0.4, 1 / 30, true, true)
  expect(g.active).toBe(false)
  g.update(true, 0.4, 1 / 30, true, true)
  expect(g.ignited).toBe(true)
})

test("interruptions and unavailable engines require a fresh press", () => {
  for (const reason of ["blur", "pause", "round end", "reset", "hidden"]) {
    const g = new NitroGate()
    g.update(true, 1, 1 / 60)
    expect(g.ignited).toBe(true)
    g.cancel()
    for (let i = 0; i < 90; i++) {
      g.update(true, 1, 1 / 60)
      expect(g.active, reason).toBe(false)
      expect(g.ignited, reason).toBe(false)
    }
    g.update(false, 1, 1 / 60)
    g.update(true, 1, 1 / 60)
    expect(g.ignited).toBe(true)
    g.update(true, 1, 1 / 60, false)
    expect(g.active).toBe(false)
    g.update(true, 1, 1 / 60, true)
    expect(g.active).toBe(false)
  }
})
