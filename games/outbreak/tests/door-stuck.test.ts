import { describe, expect, test } from "bun:test"
import { doorScenarios, runDoorScenario, summarize } from "../scripts/door-stuck"
import { TICK_DT } from "../shared/clock"
import { LocalSession } from "../shared/session"

// Kit, playing (AR-65): "These guys often get stuck on doors." Relentless chasers through every start-block door and
// the generated houses' doors, open and shut, from both sides, crowds of 1–6 and the specials. Before the doorway
// funnel (origin/main 8e631e5c) the full matrix (`bun scripts/door-stuck.ts`) had 553 s of wedged time and 43 of 1418
// zombies that never got through in 20 s; this subset (12 s each) had 157.7 s, a 5.8 s longest stretch and 24 of 541
// zombies not through. After: 0.6 s, 0.1 s, none.

describe("zombies through doors (AR-65)", () => {
  test("chasers get through open and shut doors without wedging", () => {
    const scenarios = doorScenarios([7]).filter((s) => !s.world || (s.layout === "fan" && s.seed === 7))
    const results = scenarios.map((s) => runDoorScenario({ ...s, seconds: 12 }))
    const sum = summarize(results)
    const worst = results
      .filter((r) => r.longestStuck > 1 || r.arrived < r.zombies)
      .map((r) => `${r.label}: longest ${r.longestStuck.toFixed(1)} s, through ${r.arrived}/${r.zombies}`)
    expect(worst).toEqual([])
    expect(sum.notArrived).toBe(0)
    expect(sum.stuckOver2s).toBe(0)
    expect(sum.longestStuck).toBeLessThanOrEqual(1)
    expect(sum.totalStuck).toBeLessThanOrEqual(3)
  }, 60_000)

  test("a door opened mid-bash lets the basher straight through", () => {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0, openingCalm: 0 })
    const door = session.view.town.doors.find((d) => d.id === "ash-front")!
    const p = session.view.player
    const home = { x: 27.7, y: 33.2 }
    const z = session.ai.spawnZombie(session.view.town, 28.3, 36.1, "chase", -Math.PI / 2)
    let bashedAt = -1
    let throughAt = -1
    for (let t = 0; t < 600 && throughAt < 0; t++) {
      Object.assign(p, { ...home, vx: 0, vy: 0, health: 100 })
      z.awareness = 1
      z.targetX = home.x
      z.targetY = home.y
      session.update(TICK_DT, { mx: 0, my: 0, aim: Math.PI / 2, interact: false }, 0)
      if (bashedAt < 0 && z.state === "bash") {
        bashedAt = t
        door.open = true
        session.rebuildCollision()
      }
      if (z.y < door.rect[1] - 0.6) throughAt = t
    }
    expect(bashedAt).toBeGreaterThanOrEqual(0)
    expect(throughAt).toBeGreaterThan(bashedAt)
    expect((throughAt - bashedAt) * TICK_DT).toBeLessThan(2.5)
  })

  test("a door shut on a zombie in the threshold puts it on one side, and it comes through", () => {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0, openingCalm: 0 })
    const door = session.view.town.doors.find((d) => d.id === "ash-front")!
    door.open = true
    session.rebuildCollision()
    const p = session.view.player
    const home = { x: 27.7, y: 33.2 }
    const cy = (door.rect[1] + door.rect[3]) / 2
    const z = session.ai.spawnZombie(session.view.town, 27.9, cy + 0.05, "chase", -Math.PI / 2)
    door.open = false
    session.rebuildCollision()
    let throughAt = -1
    for (let t = 0; t < 900 && throughAt < 0; t++) {
      Object.assign(p, { ...home, vx: 0, vy: 0, health: 100 })
      z.awareness = 1
      z.targetX = home.x
      z.targetY = home.y
      session.update(TICK_DT, { mx: 0, my: 0, aim: Math.PI / 2, interact: false }, 0)
      // Never inside the shut leaf.
      if (!door.open) expect(Math.abs(z.y - cy)).toBeGreaterThan(0.25)
      if (z.y < door.rect[1] - 0.6) throughAt = t
    }
    expect(throughAt).toBeGreaterThanOrEqual(0)
    expect(throughAt * TICK_DT).toBeLessThan(8)
  })
})
