import { describe, expect, test } from "bun:test"
import { SFX_BY_ID } from "@arcade/kit/audio"
import { TICK_DT } from "../shared/clock"
import { CoopSim } from "../shared/coop-sim"
import { LocalSession } from "../shared/session"
import { SoundDirector, type SoundEvent, type SoundWorld, type SoundZombie } from "../src/audio/director"
import { SoundOcclusion, surfaceAt } from "../src/audio/space"
import { pursuers, soundWorld } from "../src/audio/world"

const ids = (events: readonly SoundEvent[]) => events.map((e) => e.id)
const idle = { mx: 0, my: 0, aim: 0, interact: false }

describe("Outbreak sound director", () => {
  test("every id it can emit exists in the shared library", () => {
    const source = Bun.file(new URL("../src/audio/director.ts", import.meta.url).pathname)
    return source.text().then((text) => {
      const emitted = [...text.matchAll(/id: "([a-z.-]+)"/g)].map((m) => m[1]!)
      expect(emitted.length).toBeGreaterThan(15)
      for (const id of emitted) expect(SFX_BY_ID.has(id), id).toBe(true)
      for (const s of ["concrete", "grass", "wood"]) for (const g of ["walk", "run"]) expect(SFX_BY_ID.has(`foot.${s}.${g}`)).toBe(true)
    })
  })

  test("first frame is silent; shots, kills, reloads and doors sound from the live simulation", () => {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 })
    const director = new SoundDirector()
    const p = session.view.player
    Object.assign(p, { x: 30, y: 44, vx: 0, vy: 0, aim: 0, magAmmo: 2, reserveAmmo: 6 })
    const target = session.ai.spawnZombie(session.view.town, 34, 44, "wander", Math.PI)
    const hear = () => director.observe(soundWorld(session.sim), p)
    expect(hear()).toEqual([])

    session.update(TICK_DT, { ...idle, fire: true }, 0)
    const shot = hear()
    expect(ids(shot)).toContain("gun.pistol.shot")
    expect(ids(shot)).toContain("gun.casing")
    expect(ids(shot)).toContain("zombie.hit")
    expect(shot.find((e) => e.id === "gun.casing")!.delay).toBeGreaterThan(0.3)
    for (let i = 0; i < 18; i++) session.update(TICK_DT, idle, 0), hear()
    session.update(TICK_DT, { ...idle, fire: true }, 0)
    const kill = hear()
    expect(target.state).toBe("dead")
    expect(ids(kill).filter((id) => id === "zombie.death")).toHaveLength(1)
    // The death is not repeated when the state change is seen on a later frame.
    session.update(TICK_DT, idle, 0)
    expect(ids(hear())).not.toContain("zombie.death")

    for (let i = 0; i < 18; i++) session.update(TICK_DT, idle, 0), hear()
    session.update(TICK_DT, { ...idle, reload: true }, 0)
    expect(ids(hear())).toContain("gun.pistol.reload")

    const door = session.view.town.doors[0]!
    door.open = !door.open
    const opened = hear()
    expect(ids(opened)).toEqual([door.open ? "door.wood.open" : "door.wood.close"])
    expect(opened[0]!.x).toBeCloseTo((door.rect[0] + door.rect[2]) / 2)
  })

  test("co-op peers sound at their own position from their replicated state", () => {
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    const a = sim.addSurvivor("a", 0)
    const b = sim.addSurvivor("b", 1)
    Object.assign(b.survivor, { x: 40, y: 30 })
    const director = new SoundDirector()
    director.observe(soundWorld(sim), a.survivor)
    b.survivor.flashlightOn = !b.survivor.flashlightOn
    b.survivor.health -= 10
    const events = director.observe(soundWorld(sim), a.survivor)
    expect(events.find((e) => e.id === "flashlight.click")).toMatchObject({ x: 40, y: 30, source: "b" })
    expect(ids(events)).toContain("body.hurt")
  })

  function crowd(n: number): { world: SoundWorld; zombies: SoundZombie[] } {
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    const zombies = Array.from({ length: n }, (_, i): SoundZombie => ({ id: i + 1, x: 30 + (i % 10) * 1.5, y: 30 + Math.floor(i / 10) * 1.5, state: "wander" }))
    return { world: { ...soundWorld(sim), zombies, survivors: [] }, zombies }
  }

  test("idle groans are spaced and capped however big the crowd; alerts are rate-limited", () => {
    const { world, zombies } = crowd(100)
    const director = new SoundDirector(3)
    const times = new Map<number, number[]>()
    let groans = 0
    const listener = { x: 37, y: 37 }
    for (let f = 0; f <= 60 * 60; f++) {
      const t = f / 60
      for (const e of director.observe({ ...world, time: t }, listener)) {
        if (e.id !== "zombie.groan.idle") continue
        groans++
        const z = zombies.find((z) => z.x === e.x && z.y === e.y)!
        times.set(z.id, [...(times.get(z.id) ?? []), t])
      }
    }
    // One minute with 100 zombies in earshot: no closer than the minimum gap, so at most ~86, and no zombie repeats
    // within its own spacing.
    expect(groans).toBeGreaterThan(20)
    expect(groans).toBeLessThanOrEqual(Math.ceil(60 / director.tuning.groanMinGap) + 1)
    for (const list of times.values()) for (let i = 1; i < list.length; i++) expect(list[i]! - list[i - 1]!).toBeGreaterThanOrEqual(director.tuning.groanPerZombie - 1e-9)

    // The whole crowd notices at once: one snarl, then at most one per alertGap.
    for (const z of zombies) z.state = "chase"
    const burst = director.observe({ ...world, time: 61 }, listener)
    expect(ids(burst).filter((id) => id === "zombie.alert")).toHaveLength(1)
    expect(pursuers(zombies, listener.x, listener.y)).toBe(100)
  })

  test("director cost with 100 zombies stays far under a frame", () => {
    const { world, zombies } = crowd(100)
    const director = new SoundDirector()
    let t = 0
    for (let i = 0; i < 120; i++) director.observe({ ...world, time: (t += 1 / 60) }, { x: 37, y: 37 })
    const start = performance.now()
    const frames = 600
    for (let i = 0; i < frames; i++) {
      zombies[i % 100]!.state = i % 3 ? "wander" : "chase"
      director.observe({ ...world, time: (t += 1 / 60) }, { x: 37, y: 37 })
    }
    const ms = (performance.now() - start) / frames
    console.log(`director.observe with 100 zombies: ${ms.toFixed(3)} ms/frame`)
    expect(ms).toBeLessThan(0.5)
  })
})

describe("Outbreak acoustic space", () => {
  const town = new LocalSession(7).view.town
  test("surfaces follow the town layout", () => {
    const house = town.buildings.find((b) => b.kind === "house")!
    expect(surfaceAt(town, (house.rect[0] + house.rect[2]) / 2, house.rect[3] - 1)).toBe("wood")
    expect(surfaceAt(town, 10, 44)).toBe("concrete")
    expect(surfaceAt(town, 4, 20)).toBe("grass")
  })

  test("walls and closed doors muffle, open air does not", () => {
    const occlusion = new SoundOcclusion()
    occlusion.sync(town, 0)
    const house = town.buildings[0]!
    const inside = { x: (house.rect[0] + house.rect[2]) / 2, y: (house.rect[1] + house.rect[3]) / 2 }
    expect(occlusion.query(10, 44, 14, 44)).toBe(0)
    expect(occlusion.query(10, 44, inside.x, inside.y)).toBeGreaterThan(0.5)
    occlusion.strength = 0
    expect(occlusion.query(10, 44, inside.x, inside.y)).toBe(0)
  })
})
