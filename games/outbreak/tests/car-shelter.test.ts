import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { TICK_DT } from "../shared/clock"
import { outbreakSharedFeatures } from "../shared/feature-registry"
import { LocalSession } from "../shared/session"
import { DEFAULT_STAMINA_TUNING } from "../shared/stamina"
import { carShelters, DEFAULT_VEHICLE_TUNING } from "../shared/vehicles"
import { outbreakWayOutSharedFeature } from "../shared/way-out/index"

// AR-92: "Dude, they killed me while I was in the van?" Shut in a car, the dead batter the windows before they can
// reach a rider, which leaves time to drive off. Car shelter: Today keeps the old claws through the doors.
describe("car shelter", () => {
  beforeAll(() => outbreakSharedFeatures.unregister("wayOut"))
  afterAll(() => outbreakSharedFeatures.register(outbreakWayOutSharedFeature))

  /** Seats the survivor in the starter car, rings it with four chasing zombies and returns health per second. */
  function surrounded(carShelter: number, seconds: number) {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 }, "streaming")
    const p = session.view.player
    const car = session.vehicles.byId(1)!
    Object.assign(car, { x: 26, y: 44, h: 0, vx: 0, vy: 0, w: 0 })
    Object.assign(p, { x: 26, y: 42.7, aim: Math.PI / 2 })
    const tuning = { ...DEFAULT_STAMINA_TUNING, vehicle: { ...DEFAULT_VEHICLE_TUNING, carShelter } }
    session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: true }, 0, tuning)
    expect(p.vehicleId).toBe(car.id)
    const town = session.view.town
    for (const [dx, dy] of [[-0.8, -1.15], [0.8, -1.15], [-0.8, 1.15], [0.8, 1.15]] as const) {
      const z = session.ai.spawnZombie(town, car.x + dx, car.y + dy, "chase", Math.atan2(-dy, -dx))
      z.seesTarget = true
    }
    const health: number[] = []
    const ticks = Math.round(1 / TICK_DT)
    for (let s = 0; s < seconds; s++) {
      for (let i = 0; i < ticks; i++) session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false }, 0, tuning)
      health.push(p.health)
    }
    return { health, car, sheltered: carShelters(car, tuning.vehicle) }
  }

  test("Today: four of the dead hurt a rider through the doors within two seconds", () => {
    const { health } = surrounded(0, 2)
    expect(health[1]!).toBeLessThan(100)
  })

  test("Windows first: no harm while the windows hold, then the battered car lets them in", () => {
    const early = surrounded(1, 2)
    expect(early.health[1]).toBe(100)
    expect(early.car.bangCount).toBeGreaterThan(0)
    expect(early.sheltered).toBe(true)
    const late = surrounded(1, 14)
    expect(late.sheltered).toBe(false)
    expect(late.health.at(-1)!).toBeLessThan(100)
  })
})
