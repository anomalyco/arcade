import { describe, expect, test } from "bun:test"
import { validateWgsl } from "../test-naga"
import { makeSceneShader } from "../shaders"
import { withPhysicalLights } from "../lights/physical"
import { ALBEDO_RANGES, checkAlbedo, clampAlbedo, FINISH_LOOK_IDS, FINISH_LOOKS, packWear, WEAR_DEFAULTS, wearControls, wearFloats, wearVec4s, wearWgsl } from "./wear"

describe("albedo validator", () => {
  test("measured anchors", () => {
    expect(checkAlbedo([0.04, 0.04, 0.04], "charcoal").ok).toBe(true)
    expect(checkAlbedo([0.25, 0.25, 0.25], "concrete-aged").ok).toBe(true)
    expect(checkAlbedo([0.012, 0.012, 0.012]).verdict).toBe("dark")
    expect(checkAlbedo([0.95, 0.95, 0.95]).verdict).toBe("bright")
    // The non-metal range is 50–243 sRGB.
    expect(ALBEDO_RANGES.dielectric.min).toBeCloseTo(0.0319, 3)
    expect(ALBEDO_RANGES.dielectric.max).toBeCloseTo(0.8963, 3)
  })
  test("clamping keeps hue and lands in range", () => {
    const c = clampAlbedo([0.01, 0.005, 0.002])
    expect(checkAlbedo(c).ok).toBe(true)
    expect(c[0] / c[1]).toBeCloseTo(2)
  })
  test("every look's base and under-layer sit in measured ranges", () => {
    for (const l of FINISH_LOOKS) {
      expect({ look: l.id, ok: checkAlbedo(l.base, l.albedoClass).ok }).toEqual({ look: l.id, ok: true })
      expect({ look: l.id, ok: checkAlbedo(l.under, l.underMetal > 0.5 ? "metal" : "dielectric").ok }).toEqual({ look: l.id, ok: true })
    }
  })
})

describe("looks", () => {
  test("ids are unique and fit the vertex's three bits", () => {
    expect(new Set(FINISH_LOOK_IDS).size).toBe(FINISH_LOOK_IDS.length)
    expect(FINISH_LOOK_IDS.length).toBeLessThanOrEqual(8)
  })
  test("the vertex ABI order is append-only", () => {
    expect(FINISH_LOOK_IDS.slice(0, 6)).toEqual(["worn-lab-metal", "damp-cinderblock", "old-wood", "painted-steel", "wet-bark", "weathered-stone"])
  })
  test("packWear fills exactly its floats", () => {
    const looks = ["old-wood", "weathered-stone"] as const
    const out = new Float32Array(wearFloats(looks) + 2).fill(NaN)
    packWear(out, 1, looks, WEAR_DEFAULTS, { scanLayers: { "old-wood": 3 } })
    expect(Number.isNaN(out[0]!)).toBe(true)
    expect(Number.isNaN(out[out.length - 1]!)).toBe(true)
    for (let i = 1; i < out.length - 1; i++) expect(Number.isNaN(out[i]!)).toBe(false)
    expect(out[1 + 4 + 20]).toBe(3)
    expect(out[1 + 4 + 24 + 20]).toBe(-1)
  })
  test("controls cover every setting", () => {
    const fields = wearControls("w.", "Wear").map(c => c.field)
    expect(new Set(fields)).toEqual(new Set(Object.keys(WEAR_DEFAULTS)))
  })
})

describe("WGSL", () => {
  const looks = ["old-wood", "weathered-stone", "painted-steel"] as const
  const declarations = (scan: boolean) => `
struct Wear { t: array<vec4f, ${wearVec4s(looks)}> }
@group(0) @binding(13) var<uniform> W: Wear;
@group(1) @binding(0) var arr: texture_2d_array<f32>;
@group(1) @binding(1) var samp: sampler;
var<private> dpx: vec3f;
var<private> dpy: vec3f;
${wearWgsl({
  looks, params: "W.t",
  ...(scan ? { sample: (l: string, uv: string, dx: string, dy: string) => `textureSampleGrad(arr, samp, ${uv}, ${l}, ${dx}, ${dy}).rgb`, sampleMean: (l: string) => `textureSampleLevel(arr, samp, vec2f(0.5), ${l}, 20.0).rgb` } : {}),
  ground: p => `(${p}.y * 0.0)`,
})}`
  const material = `{
    var s: WearSurface;
    s.albedo = albedo; s.rough = 0.6; s.metal = 0.0; s.wet = 0.0;
    let w = wearApply(s, o.finish, o.world, normalize(o.normal), dpx, dpy);
    albedo = w.albedo;
    pbrRough = w.rough;
    pbrMetal = w.metal;
    if (W.t[0].y > 0.5) { albedo = wearCheck(albedo, pbrMetal); }
  }`
  for (const scan of [false, true]) test(`scene with wear${scan ? " and scans" : ""}`, () => {
    const hooks = withPhysicalLights({ lampGrid: false, finish: true, declarations: declarations(scan), fragmentStart: "dpx = dpdx(o.world); dpy = dpdy(o.world);", material }, {})
    validateWgsl(makeSceneShader(hooks))
  })
})
