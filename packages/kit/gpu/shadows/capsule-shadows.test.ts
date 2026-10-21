import { describe, expect, test } from "bun:test"
import { validateWgsl } from "../test-naga"
import { LIGHT_FLOATS } from "../../limits"
import { makeSceneShader } from "../shaders"
import {
  CAPSULE_GRID,
  CAPSULE_SHADOW_DEFAULTS,
  CapsuleShadowPacker,
  HUMAN_CAPSULES,
  capsuleShadowWgsl,
  type CapsuleShadowSettings,
} from "./capsule-shadows"

const ON: CapsuleShadowSettings = { ...CAPSULE_SHADOW_DEFAULTS, mode: 1 }

/** An upright rig at plan (x, z): every bone frame at its rest height with identity axes. */
function standing(x: number, z: number): Float32Array {
  const heights = [0.9, 0.95, 1.45, 1.38, 1.38, 1.1, 1.1, 0.88, 0.88, 0.46, 0.46, 0.08, 0.08, 0.02, 0.02]
  const out = new Float32Array(15 * 12)
  heights.forEach((h, b) => out.set([x, h, z, 1, 0, 0, 0, 1, 0, 0, 0, 1], b * 12))
  return out
}

function light(out: Float32Array, i: number, x: number, h: number, z: number, radius: number, power: number, cone: [number, number, number, number] = [0, 0, 0, -1], size = 0.3): void {
  out.set([x, h, z, radius, 1, 0.8, 0.5, power, ...cone, 0, 0, size, -1], i * LIGHT_FLOATS)
}

function cellOf(p: CapsuleShadowPacker, x: number, z: number): number[] {
  const f = p.floats
  const i = Math.floor((x - f[0]!) * f[2]!)
  const j = Math.floor((z - f[1]!) * f[2]!)
  const o = (4 + j * CAPSULE_GRID + i) * 4
  const n = p.words[o]! & 0xff
  return Array.from({ length: n }, (_, k) => (p.words[o + ((k + 1) >> 2)]! >>> (((k + 1) & 3) * 8)) & 0xff)
}

function charLights(p: CapsuleShadowPacker, c: number): number[] {
  const at = (4 + CAPSULE_GRID * CAPSULE_GRID + c * 2) * 4 + 4
  const packed = p.words[at]!
  const out: number[] = []
  for (let k = 0; k < 4; k++) {
    const v = (packed >>> (k * 8)) & 0xff
    if (v) out.push(v - 1)
  }
  return out
}

describe("CapsuleShadowPacker", () => {
  test("Today uploads only the header, with the grid off", () => {
    const p = new CapsuleShadowPacker()
    p.begin([0, 0, 40, 30])
    p.addBoneFrames(standing(10, 10), 0)
    const words = p.finish(new Float32Array(LIGHT_FLOATS), 0, CAPSULE_SHADOW_DEFAULTS)
    expect(words).toBe(16)
    expect(p.floats[3]).toBe(0)
  })

  test("a standing rig becomes 14 capsules in a bounding sphere around it", () => {
    const p = new CapsuleShadowPacker()
    p.begin([0, 0, 40, 30])
    p.addBoneFrames(standing(10, 10), 0)
    expect(p.capsuleCount).toBe(HUMAN_CAPSULES.length)
    p.finish(new Float32Array(LIGHT_FLOATS), 0, ON)
    expect(p.floats[3]).toBe(CAPSULE_GRID)
    expect(cellOf(p, 10, 10)).toEqual([0])
    expect(cellOf(p, 25, 25)).toEqual([])
  })

  test("hidden bones drop their capsules; a lying body is six", () => {
    const p = new CapsuleShadowPacker()
    p.begin([0, 0, 40, 30])
    p.addBoneFrames(standing(10, 10), 0, (1 << 2) | (1 << 5))
    expect(p.capsuleCount).toBe(HUMAN_CAPSULES.length - 2)
    p.addLyingBody(20, 0, 20, 0.3)
    expect(p.characterCount).toBe(2)
    expect(p.capsuleCount).toBe(HUMAN_CAPSULES.length - 2 + 6)
  })

  test("picks the strongest lights, skips its own torch and lists the cells its shadow falls on", () => {
    const p = new CapsuleShadowPacker()
    p.begin([0, 0, 40, 30])
    p.addBoneFrames(standing(10, 10), 0)
    const lights = new Float32Array(4 * LIGHT_FLOATS)
    light(lights, 0, 0, 0, 0, 1, 0) // visibility slot: no power
    light(lights, 1, 10.3, 1.3, 10.1, 12, 3, [1, 0, 0.9, 2], 0.06) // its own torch, in the hand
    light(lights, 2, 8, 6, 10, 14, 2) // streetlamp 2 m west, 6 m up
    light(lights, 3, 30, 3, 25, 6, 2) // a porch lamp out of reach
    p.finish(lights, 4, ON)
    expect(charLights(p, 0)).toEqual([2])
    // The lamp is west and high: a short shadow east of the body, none west.
    expect(cellOf(p, 11.4, 10)).toEqual([0])
    expect(cellOf(p, 4, 10)).toEqual([])
  })

  test("a low light throws a long shadow, capped by reach", () => {
    const p = new CapsuleShadowPacker()
    p.begin([0, 0, 40, 30])
    p.addBoneFrames(standing(10, 10), 0)
    const lights = new Float32Array(LIGHT_FLOATS)
    light(lights, 0, 7, 1.2, 10, 15, 3)
    p.finish(lights, 1, { ...ON, reach: 4 })
    expect(cellOf(p, 13.5, 10)).toEqual([0])
    expect(cellOf(p, 18, 10)).toEqual([])
  })

  test("a cone light only casts on bodies inside its cone", () => {
    const p = new CapsuleShadowPacker()
    p.begin([0, 0, 40, 30])
    p.addBoneFrames(standing(10, 10), 0)
    p.addBoneFrames(standing(10, 20), 0)
    const lights = new Float32Array(LIGHT_FLOATS)
    light(lights, 0, 4, 1.3, 10, 16, 3, [1, 0, Math.cos(0.5), 1], 0.06)
    p.finish(lights, 1, ON)
    expect(charLights(p, 0)).toEqual([0])
    expect(charLights(p, 1)).toEqual([])
  })
})

describe("WGSL validates with naga", () => {
  const hooks = {
    declarations: capsuleShadowWgsl,
    material: "capsulePrepare(o.world, n, mat == 12);",
    lightVisibility: "vis *= capsuleLightVis(i);",
    occlusion: "capsuleOcclusion",
  }
  const sources: Record<string, string> = {
    "kit scene with capsule shadows": makeSceneShader({ ...hooks, lampGrid: true }, true),
    "kit scene, post-light material": makeSceneShader({ ...hooks, postLightMaterial: "albedo *= 1.0;" }),
  }
  for (const [name, code] of Object.entries(sources)) {
    test(name, () => {
      validateWgsl(code)
    })
  }
})
