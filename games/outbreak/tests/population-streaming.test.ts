import { describe, expect, test } from "bun:test"
import { TICK_DT } from "../shared/clock"
import { LocalSession } from "../shared/session"
import { createOutbreakSettings, resolveWorldMode } from "../src/settings"

// Kit: "And then zombies just stopped appearing." Out of the first town's 96 m square the director clamped every
// backstage spawn point to that square's edge and a new chunk's own dead were tested against nav tiles not yet built,
// so driving out of town left nobody alive near you, for good. The living dead must keep to the director's wanted
// population wherever you are, by day and by night.
describe("Outbreak population while driving across town", () => {
  test("stays within the director's band out of town, through dusk, night 1 and the next morning", () => {
    const settings = createOutbreakSettings()
    const session = new LocalSession(7, settings.world.houseSeed, settings.world.terrain, settings.ai, settings.progression, resolveWorldMode(settings.world.worldMode))
    const sim = session.sim
    const p = session.slot.survivor
    const road = 44
    const [west, east] = [road, road + 96 * 6]
    const speed = 12
    let dir = 1
    const samples: { h: number; x: number; living: number; near: number; want: number }[] = []
    let mark = -1
    while (sim.elapsedHours < 15) {
      p.health = p.maxHealth
      // Driven at 12 m/s up and down the town's east-west road, the first 40 s on foot round the start.
      if (sim.time > 40) {
        if (p.x > east) dir = -1
        if (p.x < west) dir = 1
        p.x += dir * speed * TICK_DT
        p.y = road
      }
      session.update(TICK_DT, { mx: 0, my: 0, aim: dir > 0 ? 0 : Math.PI, interact: false }, settings.dayCycle.timeScale, settings)
      const m = Math.floor(sim.elapsedHours * 4)
      if (m === mark) continue
      mark = m
      let living = 0
      let near = 0
      for (const a of sim.ai.agents) {
        if (a.state === "dead" || a.hordeId !== undefined) continue
        living++
        if (Math.hypot(a.x - p.x, a.y - p.y) < 60) near++
      }
      samples.push({ h: Number(sim.elapsedHours.toFixed(2)), x: Math.round(p.x), living, near, want: sim.ai.pacing.telemetry.desiredPopulation })
    }
    const out = samples.filter((s) => s.h >= 1.5)
    const outOfTown = out.filter((s) => s.x > 140)
    expect(outOfTown.length).toBeGreaterThan(20)
    // A chunk unloading behind the car can take the dead left in it before the director refills backstage, so one
    // quarter-hour sample may dip below the band; two in a row is the "stopped appearing" bug.
    const low = (s: (typeof out)[number]) => s.living < Math.max(2, Math.floor(s.want * 0.5))
    for (const [i, s] of out.entries()) {
      expect({ ...s, ok: s.living <= s.want + 4 && !(low(s) && (i === out.length - 1 || low(out[i + 1]!))) }).toEqual({ ...s, ok: true })
    }
    // Most of the time some of them are within 60 m.
    expect(outOfTown.filter((s) => s.near > 0).length).toBeGreaterThan(outOfTown.length * 0.75)
  }, 60_000)
})
