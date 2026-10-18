import { describe, expect, test } from "bun:test"
import { OutbreakAmbientMotion, evaluateWindGust } from "../src/ambient-motion"
import { ABANDONED_VEHICLE_SPECS, ExteriorClutterRenderer, exteriorEdgeAffinity, isExteriorWalkPathBlocked } from "../src/clutter"
import {
  DEFAULT_GROUND_SETTINGS,
  GroundWearRenderer,
  packGroundCfgBits,
  randomizeGroundSettings,
} from "../src/ground"
import { EXTERIOR_VEHICLE_COLLIDERS, makeTown, SIZE, solidRects } from "../shared/map"
import { LocalSession } from "../shared/session"
import { SPRITE_FLOATS } from "@arcade/kit/gpu/renderer"

const mockRenderer = () => {
  let nextId = 0
  return {
    addModel: () => nextId++,
  }
}

describe("ground wear, exterior clutter, and ambient motion", () => {
  test("ground tuning randomization is deterministic and isolated from structural clutterSeed", () => {
    const a = randomizeGroundSettings(DEFAULT_GROUND_SETTINGS, 41)
    const b = randomizeGroundSettings(DEFAULT_GROUND_SETTINGS, 41)
    const c = randomizeGroundSettings(DEFAULT_GROUND_SETTINGS, 99)
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
    // Structural seed is never touched by parameter Randomize
    expect("clutterSeed" in a).toBe(false)
    expect("groundTuningSeed" in a).toBe(false)
    for (const v of Object.values(a)) {
      expect(typeof v).toBe("number")
      expect(v).toBeGreaterThanOrEqual(0.55)
      expect(v).toBeLessThanOrEqual(1.75)
      expect(Math.abs(Math.round(v * 20) - v * 20)).toBeLessThan(1e-6)
    }
  })

  test("packGroundCfgBits round-trips wearAmount, curbDirt and puddleWetness in F.map.w", () => {
    const bits = packGroundCfgBits({ wearAmount: 1.35, curbDirt: 0.85, puddleWetness: 1.65 })
    expect((bits & (1 << 18)) !== 0).toBe(true)
    const w = (bits & 63) * 0.05
    const d = ((bits >> 6) & 63) * 0.05
    const p = ((bits >> 12) & 63) * 0.05
    expect(w).toBeCloseTo(1.35, 5)
    expect(d).toBeCloseTo(0.85, 5)
    expect(p).toBeCloseTo(1.65, 5)
  })

  test("exterior clutter respects walk paths, doorways, and edge affinity rules", () => {
    const town = makeTown(7)
    // Interior of Ash house is blocked
    expect(isExteriorWalkPathBlocked(town, 28, 30)).toBe(true)
    // Center of Ash front entrance walkway is kept clear
    expect(isExteriorWalkPathBlocked(town, 27.7, 36.8)).toBe(true)
    // Immediate doorway threshold is kept clear
    expect(isExteriorWalkPathBlocked(town, 27.7, 35.4)).toBe(true)
    // Survivor street-proof pose (30, 41) is kept clear
    expect(isExteriorWalkPathBlocked(town, 30.0, 41.0)).toBe(true)
    // Curb gutter & fence borders are allowed and have higher edge affinity than mid-sidewalk or open lawn
    expect(isExteriorWalkPathBlocked(town, 25.5, 40.15)).toBe(false)
    const gutterAff = exteriorEdgeAffinity(town, 25.5, 40.15)
    const fenceAff = exteriorEdgeAffinity(town, 18.4, 30.0)
    const midSidewalkAff = exteriorEdgeAffinity(town, 25.5, 38.75)
    const openLawnAff = exteriorEdgeAffinity(town, 8.0, 12.0)
    expect(gutterAff).toBeGreaterThan(0.75)
    expect(fenceAff).toBeGreaterThan(0.65)
    expect(midSidewalkAff).toBeLessThan(0.25)
    expect(openLawnAff).toBeLessThan(0.15)
  })

  test("GroundWearRenderer and ExteriorClutterRenderer deterministically instance and frustum-cull", () => {
    const town = makeTown(7)
    const wear = new GroundWearRenderer(mockRenderer())
    const clutter = new ExteriorClutterRenderer(mockRenderer())
    const fullView: readonly [number, number, number, number] = [0, 0, SIZE, SIZE]
    const cornerView: readonly [number, number, number, number] = [0, 0, 5, 5]

    const wFull = wear.collectBatches(town, fullView, DEFAULT_GROUND_SETTINGS)
    const wZero = wear.collectBatches(town, fullView, { ...DEFAULT_GROUND_SETTINGS, wearAmount: 0, curbDirt: 0 })
    expect(wFull.reduce((n, b) => n + b.count, 0)).toBeGreaterThan(60)
    expect(wZero).toHaveLength(0)

    const cSeed7A = clutter.collectBatches(town, fullView, DEFAULT_GROUND_SETTINGS)
    const count7A = cSeed7A.reduce((n, b) => n + b.count, 0)
    const snap7A = cSeed7A.map(b => ({ model: b.model, count: b.count, firstX: b.data[0], firstZ: b.data[2] }))

    const cSeed19 = clutter.collectBatches(town, fullView, { ...DEFAULT_GROUND_SETTINGS, clutterSeed: 19 })
    const snap19 = cSeed19.map(b => ({ model: b.model, count: b.count, firstX: b.data[0], firstZ: b.data[2] }))
    expect(snap19).not.toEqual(snap7A)

    const cSeed7B = clutter.collectBatches(town, fullView, DEFAULT_GROUND_SETTINGS)
    const snap7B = cSeed7B.map(b => ({ model: b.model, count: b.count, firstX: b.data[0], firstZ: b.data[2] }))
    expect(snap7B).toEqual(snap7A)

    const cCorner = clutter.collectBatches(town, cornerView, DEFAULT_GROUND_SETTINGS)
    expect(cCorner.reduce((n, b) => n + b.count, 0)).toBeLessThan(count7A / 4)
  })

  test("abandoned vehicle colliders are registered in solidRects and zombie GridNav routes safely around them", () => {
    const town = makeTown(7)
    const solids = solidRects(town)
    for (const rect of EXTERIOR_VEHICLE_COLLIDERS) {
      expect(solids).toContainEqual(rect)
    }
    expect(ABANDONED_VEHICLE_SPECS.length).toBeGreaterThanOrEqual(4)

    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 })
    for (const v of ABANDONED_VEHICLE_SPECS) {
      // Nearest walkable cell to vehicle center is pushed outside the vehicle hull
      const nearest = session.ai.nav.nearest({ x: v.x, y: v.z })
      const insideHull =
        nearest.x > v.rect[0] + 0.1 &&
        nearest.x < v.rect[2] - 0.1 &&
        nearest.y > v.rect[1] + 0.1 &&
        nearest.y < v.rect[3] - 0.1
      expect(insideHull).toBe(false)
    }
  })

  test("OutbreakAmbientMotion animates wind-gust leaves, papers, bags, cans, swinging gates, and signs", () => {
    const town = makeTown(7)
    const motion = new OutbreakAmbientMotion(mockRenderer())
    const alphaSprites = new Float32Array(128 * SPRITE_FLOATS)
    const player = { x: 30, y: 41, aim: -Math.PI / 2, flashlightOn: true, flashlightOutput: 1 }
    const view: readonly [number, number, number, number] = [14, 24, 46, 54]

    expect(evaluateWindGust(1.2, 30, 41, 1.0)).toBeGreaterThan(0.05)

    const t0 = motion.stepAndCollect(1 / 60, 0.5, town, player, view, DEFAULT_GROUND_SETTINGS, alphaSprites, 0)
    expect(t0.batches.length).toBeGreaterThanOrEqual(6)
    expect(t0.alphaCount).toBeGreaterThan(0)
    const leafX0 = t0.batches[0]!.data[0]!
    const gateYaw0 = t0.batches.find(b => b.model === 5)!.data[3]!

    let t1 = t0
    for (let s = 1; s <= 30; s++) {
      t1 = motion.stepAndCollect(1 / 60, 0.5 + s / 60, town, player, view, DEFAULT_GROUND_SETTINGS, alphaSprites, 0)
    }
    const leafX1 = t1.batches[0]!.data[0]!
    const gateYaw1 = t1.batches.find(b => b.model === 5)!.data[3]!
    expect(leafX1).not.toBeCloseTo(leafX0, 4)
    expect(gateYaw1).not.toBeCloseTo(gateYaw0, 4)
    expect(motion.particles.count).toBeGreaterThan(0)
  })
})
