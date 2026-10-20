import { describe, expect, test } from "bun:test"
import { FOLIAGE_BUILD_TODAY, FOLIAGE_GUST_OFF } from "@arcade/kit/gpu/foliage"
import { createOutbreakSettings } from "../src/settings"
import {
  DEFAULT_VEGETATION_SETTINGS,
  syncVegetationBuild,
  vegetationBuild,
  vegetationControls,
  vegetationGust,
  vegetationSignature,
} from "../src/vegetation/settings"
import { packVegetationTrees, setTreeBurnSource, treeBurnState, treeIdAt, VEG_TREE_UNIFORM_FLOATS } from "../src/vegetation/trees"
import { makeTown } from "../shared/map"

describe("Outbreak vegetation settings", () => {
  test("Lively is the default and Today is one setting away", () => {
    const s = { ...DEFAULT_VEGETATION_SETTINGS }
    syncVegetationBuild(s)
    expect(vegetationBuild.lively).toBe(true)
    expect(vegetationGust(s).on).toBe(1)
    const lively = vegetationSignature()
    expect(syncVegetationBuild({ ...s, vegLook: 0 })).toBe(true)
    expect({ ...vegetationBuild }).toEqual({ ...FOLIAGE_BUILD_TODAY })
    expect(vegetationGust({ ...s, vegLook: 0 })).toBe(FOLIAGE_GUST_OFF)
    expect(vegetationSignature()).not.toBe(lively)
    expect(syncVegetationBuild(s)).toBe(true)
    expect(vegetationSignature()).toBe(lively)
  })

  test("only structural settings rebuild; wind settings are live", () => {
    const s = { ...DEFAULT_VEGETATION_SETTINGS }
    syncVegetationBuild(s)
    expect(syncVegetationBuild({ ...s, vegWind: 2, vegGustScale: 40, vegBranchSway: 0.2 })).toBe(false)
    expect(syncVegetationBuild({ ...s, vegQuality: 2 })).toBe(true)
    expect(syncVegetationBuild({ ...s, vegQuality: 2 })).toBe(false)
    expect(syncVegetationBuild({ ...s, vegDeadTrees: 0.3 })).toBe(true)
    syncVegetationBuild(s)
  })

  test("the wind direction is a unit vector and the gust object is reused", () => {
    const a = vegetationGust({ ...DEFAULT_VEGETATION_SETTINGS, vegWindDir: 90 })
    expect(a.dirX).toBeCloseTo(0, 6)
    expect(a.dirZ).toBeCloseTo(1, 6)
    expect(vegetationGust(DEFAULT_VEGETATION_SETTINGS)).toBe(a)
  })

  test("every control is bound to the vegetation subsystem", () => {
    const settings = createOutbreakSettings()
    for (const c of vegetationControls) expect({ key: c.key, bound: c.key in settings.vegetation }).toEqual({ key: c.key, bound: true })
    expect(settings.vegetation).toEqual(DEFAULT_VEGETATION_SETTINGS)
  })
})

describe("Outbreak tree looks and the burn hook", () => {
  test("C (Darkwood, D-42) with blight is the default tree look; Today is one setting away", () => {
    const s = { ...DEFAULT_VEGETATION_SETTINGS }
    expect(s.vegTreeLook).toBe(3)
    expect(s.vegTreeBlight).toBeCloseTo(0.25, 6)
    expect(vegetationBuild.treeLook).toBe(3)
    syncVegetationBuild(s)
    const c = vegetationSignature()
    expect([vegetationBuild.treeLook, vegetationBuild.blight]).toEqual([3, 0.25])
    expect(syncVegetationBuild({ ...s, vegTreeLook: 0 })).toBe(true)
    expect([vegetationBuild.treeLook, vegetationBuild.blight]).toEqual([0, 0])
    expect(vegetationSignature()).not.toBe(c)
    expect(syncVegetationBuild(s)).toBe(true)
    expect(syncVegetationBuild({ ...s, vegTreeBlight: 0.5 })).toBe(true)
    expect(vegetationSignature()).not.toBe(c)
    expect(syncVegetationBuild({ ...s, vegLook: 0 })).toBe(true)
    expect(vegetationBuild.treeLook).toBe(0)
    syncVegetationBuild(s)
    expect(vegetationSignature()).toBe(c)
  })

  test("tree uniforms: look, shade only for A and C, burning trees from the source", () => {
    const town = makeTown(7, 7, 0, 1)
    const tree = town.props.find((p) => p.kind === "tree")!
    const out = new Float32Array(VEG_TREE_UNIFORM_FLOATS)
    const s = { ...DEFAULT_VEGETATION_SETTINGS, vegTreeLook: 0 }
    packVegetationTrees(s, town, tree.x, tree.y, out, 0)
    expect([out[0], out[1], out[3]]).toEqual([0, 0, 0])
    packVegetationTrees({ ...s, vegTreeLook: 2 }, town, tree.x, tree.y, out, 0)
    expect([out[0], out[1]]).toEqual([2, 0])
    packVegetationTrees({ ...s, vegTreeLook: 3 }, town, tree.x, tree.y, out, 0)
    expect(out[1]).toBeGreaterThan(0.8)
    const id = treeIdAt(tree.x, tree.y)
    setTreeBurnSource((t) => (t === id ? 0.4 : 0))
    try {
      expect(treeBurnState(id)).toBe(0.4)
      packVegetationTrees(s, town, tree.x, tree.y, out, 0)
      expect(out[3]).toBe(1)
      expect([out[4], out[5], out[7]]).toEqual([Math.fround(tree.x), Math.fround(tree.y), Math.fround(0.4)])
    } finally {
      setTreeBurnSource(null)
    }
    packVegetationTrees(s, town, tree.x, tree.y, out, 0)
    expect(out[3]).toBe(0)
    expect(out.slice(4).every((v) => v === 0)).toBe(true)
    packVegetationTrees({ ...s, vegBurnTest: 1 }, town, tree.x, tree.y, out, 0)
    expect([out[3], out[7]]).toEqual([1, 1])
  })

  test("tree ids are stable per position", () => {
    expect(treeIdAt(12.3, 40.1)).toBe(treeIdAt(12.3, 40.1))
    expect(treeIdAt(12.3, 40.1)).not.toBe(treeIdAt(12.3, 41.1))
  })
})
