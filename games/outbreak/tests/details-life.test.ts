import { describe, expect, test } from "bun:test"
import { bodySites } from "../shared/bodies/bodies"
import { inBuildingFootprint } from "../shared/map"
import { LocalSession } from "../shared/session"
import { CROW_FLIGHT, CrowFlocks, type CrowPose } from "../src/details/crows"
import { DistantLife, tvLevel, type LifeSound } from "../src/details/life"
import { DetailsPresenter } from "../src/details/presenter"
import { placeBuildingDetails, placeCrowFlocks, type CrowFlock } from "../src/details/placement"
import { DEFAULT_DETAIL_SETTINGS, type OutbreakDetailSettings } from "../src/details/settings"
import { DEFAULT_NIGHT_LIGHT_SETTINGS } from "../src/night-lights/settings"

const town = () => {
  const s = new LocalSession(7, 7, 0.22, { zombieCount: 0 }, "streaming")
  s.view.player.x = 44
  s.view.player.y = 150
  s.rebuildCollision()
  return s.view.town
}

const flock: CrowFlock = { key: "lawn:test", x: 10, z: 10, birds: 5, seed: 99 }
const view = [0, 0, 40, 40] as const

describe("crows", () => {
  test("flocks are seeded from the town and stay outdoors; off places none", () => {
    const t = town()
    const a = placeCrowFlocks(t, { ...DEFAULT_DETAIL_SETTINGS, dtCrows: 2 }, bodySites(t))
    expect(a).toEqual(placeCrowFlocks(town(), { ...DEFAULT_DETAIL_SETTINGS, dtCrows: 2 }, bodySites(t)))
    expect(a.length).toBeGreaterThan(0)
    for (const f of a) {
      expect(f.birds).toBeGreaterThanOrEqual(3)
      expect(f.birds).toBeLessThanOrEqual(6)
      for (const b of t.buildings) expect(inBuildingFootprint(b, f.x, f.z)).toBe(false)
    }
    expect(placeCrowFlocks(t, { ...DEFAULT_DETAIL_SETTINGS, dtCrows: 0 }, bodySites(t))).toEqual([])
  })

  test("they peck until someone comes close, then fly off up and away, and come back once nobody is near", () => {
    const crows = new CrowFlocks()
    let scattered = 0
    crows.onScatter = () => scattered++
    crows.setFlocks("k", [flock])
    const poses: CrowPose[] = []
    let t = 0
    for (; t < 3; t += 1 / 60) crows.step(1 / 60, t, 5, [{ x: 30, y: 30 }], [])
    expect(crows.poses(t, view, poses).every((p) => p.wings === "folded" && p.y === 0)).toBe(true)
    crows.step(1 / 60, t, 5, [{ x: 7, y: 10 }], [])
    expect(scattered).toBe(1)
    for (let k = 0; k < 60; k++) crows.step(1 / 60, (t += 1 / 60), 5, [{ x: 7, y: 10 }], [])
    const flying = crows.poses(t, view, poses)
    expect(flying.length).toBe(5)
    for (const p of flying) {
      expect(p.y).toBeGreaterThan(1)
      expect(p.x).toBeGreaterThan(9)
      expect(p.wings).not.toBe("folded")
    }
    for (let k = 0; k < (CROW_FLIGHT + 1) * 60; k++) crows.step(1 / 60, (t += 1 / 60), 5, [{ x: 7, y: 10 }], [])
    expect(crows.counts().gone).toBe(1)
    // Someone still close: they stay away. Then the street empties and they return.
    for (let k = 0; k < 200; k++) crows.step(0.5, (t += 0.5), 5, [{ x: 12, y: 12 }], [])
    expect(crows.counts().gone).toBe(1)
    for (let k = 0; k < 200; k++) crows.step(0.5, (t += 0.5), 5, [{ x: 40, y: 40 }], [])
    expect(crows.counts().ground).toBe(1)
    expect(scattered).toBe(1)
  })

  test("a gunshot nearby scatters them even with nobody close", () => {
    const crows = new CrowFlocks()
    crows.setFlocks("k", [flock])
    crows.step(1 / 60, 1, 5, [{ x: 30, y: 30 }], [{ x: 18, y: 10, radius: 30, kind: "gunshot" }])
    expect(crows.counts().flying).toBe(1)
    const calm = new CrowFlocks()
    calm.setFlocks("k", [flock])
    calm.step(1 / 60, 1, 5, [{ x: 30, y: 30 }], [{ x: 18, y: 10, radius: 30, kind: "footstep" }])
    expect(calm.counts().ground).toBe(1)
  })
})

describe("televisions and distant dogs", () => {
  test("a TV's flicker stays in range and is smooth inside a scene (no frame-to-frame strobe)", () => {
    let jumps = 0
    let prev = tvLevel(0.4, 0)
    for (let t = 1 / 60; t < 60; t += 1 / 60) {
      const v = tvLevel(0.4, t)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
      if (Math.abs(v - prev) > 0.08) jumps++
      prev = v
    }
    // Only the scene cuts jump: a cut every 1.6–4 s.
    expect(jumps).toBeLessThan(40)
    expect(jumps).toBeGreaterThan(5)
  })

  test("some homes get a television; dtTvs 0 places none", () => {
    const t = town()
    const homes = t.buildings.filter((b) => b.archetype === "house" || b.archetype === "cottage")
    const tvs = homes.flatMap((b) => placeBuildingDetails(t, b, { ...DEFAULT_DETAIL_SETTINGS, dtTvs: 1 }, false)).filter((d) => d.model === "tv")
    expect(tvs.length).toBeGreaterThan(0)
    expect(homes.flatMap((b) => placeBuildingDetails(t, b, { ...DEFAULT_DETAIL_SETTINGS, dtTvs: 0 }, false)).some((d) => d.model === "tv")).toBe(false)
  })

  test("dogs bark far off, only at night, and not when switched off", () => {
    const run = (night: number, on: boolean) => {
      const life = new DistantLife()
      const out: LifeSound[] = []
      for (let t = 0; t < 600; t += 0.5) life.step(t, { worldDetails: true, dtDistantDogs: on }, night, { x: 0, y: 0 }, (e) => out.push(e))
      return out
    }
    const night = run(1, true)
    expect(night.length).toBeGreaterThan(5)
    for (const e of night) {
      expect(e.id).toBe("dog.bark")
      expect(Math.hypot(e.x, e.y)).toBeGreaterThan(25)
    }
    expect(run(0, true)).toEqual([])
    expect(run(1, false)).toEqual([])
  })
})

describe("details presenter settings cache", () => {
  const frame = { dt: 1 / 60, time: 1, threats: [], noises: [] }
  const world = [-1e4, -1e4, 1e4, 1e4] as const
  const presenter = () => {
    let id = 0
    return new DetailsPresenter({ addModel: () => id++ })
  }
  const collect = (p: DetailsPresenter, t: ReturnType<typeof town>, s: OutbreakDetailSettings) => {
    p.collect(t, world, s, DEFAULT_NIGHT_LIGHT_SETTINGS, frame)
    const c = p.shown.crows
    return { tvs: p.shown.tvs, flocks: c.ground + c.flying + c.gone }
  }
  const lively = { ...DEFAULT_DETAIL_SETTINGS, dtTvs: 1, dtCrows: 2 }
  const empty = { ...lively, dtTvs: 0, dtCrows: 0 }

  test("collect places the televisions and crows the settings ask for", () => {
    const t = town()
    const got = collect(presenter(), t, lively)
    expect(got.tvs).toBeGreaterThan(0)
    expect(got.flocks).toBe(placeCrowFlocks(t, lively, bodySites(t)).length)
    expect(got.flocks).toBeGreaterThan(0)
  })

  test("changing television and crow density takes effect on the next frame", () => {
    const t = town()
    const p = presenter()
    const before = collect(p, t, lively)
    expect(before.tvs).toBeGreaterThan(0)
    expect(collect(p, t, empty)).toEqual({ tvs: 0, flocks: 0 })
    expect(collect(p, t, lively)).toEqual(before)
  })

  test("World details off then on brings the televisions and crows back", () => {
    const t = town()
    const p = presenter()
    const before = collect(p, t, lively)
    expect(collect(p, t, { ...lively, worldDetails: false })).toEqual({ tvs: 0, flocks: 0 })
    expect(collect(p, t, lively)).toEqual(before)
  })
})
