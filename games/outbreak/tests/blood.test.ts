import { describe, expect, test } from "bun:test"
import { distToRect } from "@arcade/kit/sim/geom"
import { inBuildingFootprint, makeTown, propShape } from "../shared/map"
import { LocalSession } from "../shared/session"
import { placeAmbientBlood } from "../src/blood/placement"
import { DEFAULT_BLOOD_SETTINGS, type OutbreakBloodSettings } from "../src/blood/settings"
import { BLOOD_VARIANTS, BLOOD_WALL_KINDS, buildBloodMeshes } from "../src/blood/shapes"
import { BLOOD_RING_MAX, BloodStains, type BloodFrame } from "../src/blood/stains"

const settings = (patch: Partial<OutbreakBloodSettings> = {}): OutbreakBloodSettings => ({ ...DEFAULT_BLOOD_SETTINGS, ...patch })

const fakeRenderer = () => {
  let n = 0
  return { addModel: () => n++, setModel: () => {} }
}

describe("ambient blood placement", () => {
  test("the same town and settings place the same stains; bloodSeed rerolls them without touching the town", () => {
    const a = placeAmbientBlood(makeTown(7), settings())
    const b = placeAmbientBlood(makeTown(7), settings())
    expect(a.length).toBeGreaterThan(20)
    expect(b).toEqual(a)
    const reroll = placeAmbientBlood(makeTown(7), settings({ bloodSeed: 3 }))
    expect(reroll).not.toEqual(a)
    expect(placeAmbientBlood(makeTown(8), settings())).not.toEqual(a)
  })

  test("streamed towns place deterministically too, and a building keeps its stains when the window moves", () => {
    const s1 = new LocalSession(7, 7, 0.22, { zombieCount: 0 }, "streaming")
    const s2 = new LocalSession(7, 7, 0.22, { zombieCount: 0 }, "streaming")
    const a = placeAmbientBlood(s1.view.town, settings())
    expect(a.length).toBeGreaterThan(20)
    expect(placeAmbientBlood(s2.view.town, settings())).toEqual(a)
  })

  test("off, or zero density, places nothing", () => {
    expect(placeAmbientBlood(makeTown(7), settings({ bloodWorld: false }))).toEqual([])
    expect(placeAmbientBlood(makeTown(7), settings({ bloodWorldDensity: 0 }))).toEqual([])
  })

  test("houses where something happened get pools, drag trails and prints on the walls; density scales the rest", () => {
    const town = makeTown(7)
    const all = placeAmbientBlood(town, settings({ bloodIncidents: 1 }))
    const kinds = new Set(all.map((s) => s.kind))
    for (const k of ["drag", "hand"]) expect(kinds.has(k as never)).toBe(true)
    expect(all.some((s) => s.kind === "pool" || s.kind === "stain")).toBe(true)
    const none = placeAmbientBlood(town, settings({ bloodIncidents: 0 }))
    expect(none.filter((s) => s.kind === "drag" && town.buildings.some((b) => inBuildingFootprint(b, s.x, s.z))).length).toBe(0)
    const heavy = placeAmbientBlood(town, settings({ bloodWorldDensity: 2 }))
    expect(heavy.length).toBeGreaterThan(placeAmbientBlood(town, settings({ bloodWorldDensity: 0.5 })).length)
  })

  test("floor stamps sit clear of furniture and walls, wall stamps stand on wall faces", () => {
    const town = makeTown(7)
    const stamps = placeAmbientBlood(town, settings({ bloodIncidents: 1, bloodWorldDensity: 2 }))
    for (const s of stamps) {
      expect(s.variant).toBeLessThan(BLOOD_VARIANTS[s.kind])
      if (s.wall) {
        expect((BLOOD_WALL_KINDS as readonly string[]).includes(s.kind)).toBe(true)
        expect(s.y).toBeGreaterThan(0.5)
        const nearWall = town.barriers.some((b) => b.kind === "wall" && distToRect(s.x, s.z, b.rect) < 0.05)
        expect(nearWall).toBe(true)
        continue
      }
      for (const p of town.props) {
        const shape = propShape(p)
        if (shape) expect(distToRect(s.x, s.z, shape.rect)).toBeGreaterThan(0.05)
      }
    }
  })
})

describe("fight stains", () => {
  const frame = (patch: Partial<BloodFrame>): BloodFrame => ({
    dt: 1 / 60,
    town: makeTown(7),
    zombies: [],
    survivors: [{ x: 27, y: 44 }],
    player: { x: 27, y: 44, health: 100 },
    settings: settings(),
    ...patch,
  })

  test("a hit leaves a splat, a kill leaves a pool that spreads, and the ring reuses its oldest slot at the budget", () => {
    const blood = new BloodStains(fakeRenderer())
    const town = makeTown(7)
    const s = settings({ bloodBudget: 32 })
    const z = { id: 1, x: 30, y: 44, hp: 100, state: "chase" }
    blood.observe(frame({ town, zombies: [z], settings: s }))
    blood.observe(frame({ town, zombies: [{ ...z, hp: 60 }], settings: s }))
    expect(blood.fightStains().map((f) => f.kind)).toEqual(["splat"])
    const splat = blood.fightStains()[0]!
    // Thrown away from the shooter at x 27.
    expect(splat.x).toBeGreaterThan(30)
    blood.observe(frame({ town, zombies: [{ ...z, hp: 0, state: "dead" }], settings: s }))
    expect(blood.fightStains().map((f) => f.kind)).toContain("pool")
    for (let i = 0; i < 100; i++) blood.stamp("splat", 30, 0.02, 44 + i * 0.01, 0, 1, { budget: s.bloodBudget })
    expect(blood.fightStains().length).toBe(32)
    expect(blood.counts.recycled).toBeGreaterThan(0)
    // Newest last: the last stamp written is still there.
    expect(blood.fightStains().at(-1)!.z).toBeCloseTo(44.99, 5)
  })

  test("the ring never grows past its fixed slots", () => {
    const blood = new BloodStains(fakeRenderer())
    for (let i = 0; i < BLOOD_RING_MAX * 3; i++) blood.stamp("drops", i, 0, 0, 0, 1, { budget: 99999 })
    expect(blood.fightStains().length).toBe(BLOOD_RING_MAX)
    expect(blood.fightStains()[0]!.x).toBe(BLOOD_RING_MAX * 2)
  })

  test("crawlers smear drag trails and a survivor who steps in a pool leaves fading prints", () => {
    const blood = new BloodStains(fakeRenderer())
    const town = makeTown(7)
    const s = settings({ bloodFootprints: 6 })
    let z = { id: 2, x: 20, y: 44, hp: 40, state: "crawler" }
    blood.observe(frame({ town, zombies: [z], settings: s }))
    for (let i = 0; i < 20; i++) {
      z = { ...z, x: z.x + 0.1 }
      blood.observe(frame({ town, zombies: [z], settings: s }))
    }
    expect(blood.fightStains().filter((f) => f.kind === "drag").length).toBeGreaterThanOrEqual(2)

    blood.reset()
    blood.stamp("pool", 27, 0.03, 44, 0, 1.2, { budget: 320 })
    let px = 27
    for (let i = 0; i < 80; i++) {
      blood.observe(frame({ town, player: { x: px, y: 44, health: 100 }, settings: s }))
      px += 0.08
    }
    const feet = blood.fightStains().filter((f) => f.kind === "foot")
    expect(feet.length).toBe(6)
    // Strength fades: first prints full, last ones faint (variant = side * 3 + strength).
    expect(feet[0]!.variant % 3).toBe(0)
    expect(feet.at(-1)!.variant % 3).toBe(2)
  })

  test("every stamp mesh builds with geometry and a fixed variant count", () => {
    const meshes = buildBloodMeshes(1)
    const total = Object.values(BLOOD_VARIANTS).reduce((a, b) => a + b, 0)
    expect(meshes.length).toBe(total + 3)
    for (const m of meshes) expect(m.mesh.v.length).toBeGreaterThan(0)
  })
})
