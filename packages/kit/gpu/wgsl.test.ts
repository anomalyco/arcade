import { describe, expect, test } from "bun:test"
import { ParticleFrameStruct, ParticleRenderer, makeParticleShader } from "../fx/particle-renderer"
import { VolumeFrameStruct, volumeShader } from "../fx/volume-shader"
import {
  FoliageActorsStruct,
  FoliageWindConfigStruct,
  foliageSettings,
  foliageWindDeclarationsWgsl,
  packFoliageActors,
  packFoliageUniforms,
} from "./foliage"
import { LOOK_PRESETS, LookUniformsStruct, createLookSettings, lookStructWgsl, packLookUniforms } from "./look"
import { makeLookPostShader, makeLookSceneShader, resolveLookVariant } from "./look-shaders"
import {
  MATERIAL_RECIPES,
  MaterialRecipeStruct,
  SurfaceTexUniformsStruct,
  buildSurfaceMaterialDeclarationsWgsl,
  packMaterialParams,
  packSurfaceTexUniforms,
  surfaceMaterialCoreWgsl,
} from "./surface-materials"
import { resolveWgsl, wgslSlot, wgslSnippet, wgslStruct } from "./wgsl"

describe("wgslStruct & resolveWgsl", () => {
  test("computes WGSL vec3f 16-byte alignment and @size tail padding", () => {
    const S = wgslStruct("TestAlign", {
      a: "f32",
      b: "vec3f",
      c: "f32",
    })
    expect(S.byteSize).toBe(32)
    expect(S.floatCount).toBe(8)
    expect(S.offsetOf("a")).toBe(0)
    expect(S.offsetOf("b")).toBe(4)
    expect(S.offsetOf("c")).toBe(7)
    expect(S.wgsl).toContain("@align(16) a: f32,")
    const buf = S.pack({ a: 1.5, b: [2, 3, 4], c: 9 })
    expect(Array.from(buf)).toEqual([1.5, 0, 0, 0, 2, 3, 4, 9])

    const TailPadded = wgslStruct("TailPadded", {
      head: "vec4f",
      tail: "f32",
    })
    expect(TailPadded.byteSize).toBe(32)
    expect(TailPadded.wgsl).toContain("@size(16) tail: f32,")
  })

  test("packs fixed-size array<vec4f, N> and integer fields", () => {
    const S = wgslStruct("ArrayAndInts", {
      count: "u32",
      mode: "i32",
      pad: "vec2f",
      items: "array<vec4f, 2>",
    })
    expect(S.byteSize).toBe(48)
    expect(S.floatCount).toBe(12)
    const buf = S.pack({
      count: 7,
      mode: -3,
      pad: [0.5, 1.5],
      items: [1, 2, 3, 4, 5, 6],
    })
    const u32 = new Uint32Array(buf.buffer)
    const i32 = new Int32Array(buf.buffer)
    expect(u32[0]).toBe(7)
    expect(i32[1]).toBe(-3)
    expect(Array.from(buf.subarray(2))).toEqual([0.5, 1.5, 1, 2, 3, 4, 5, 6, 0, 0])
  })

  test("resolves transitive dependencies once and applies slot overrides", () => {
    const modeSlot = wgslSlot("mode", "fast" as "fast" | "hq")
    const base = wgslSnippet("base", "fn helper() -> f32 { return 1.0; }")
    const mid = wgslSnippet("mid", "fn midFn() -> f32 { return helper(); }", [base])
    const main = wgslSnippet(
      "main",
      (ctx) => `fn run() -> f32 { return (helper() + midFn()) * ${ctx.get(modeSlot) === "hq" ? "2.0" : "1.0"}; }`,
      [base, mid],
    )
    const fastCode = resolveWgsl(main)
    expect(fastCode.match(/fn helper\(\)/g)?.length).toBe(1)
    expect(fastCode).toContain("* 1.0")
    expect(resolveWgsl(main, [[modeSlot, "hq"]])).toContain("* 2.0")
  })

  test("converted uniform structs match exact float counts and eliminate u0..u15 swizzles", () => {
    expect(LookUniformsStruct.floatCount).toBe(64)
    expect(ParticleFrameStruct.floatCount).toBe(88)
    expect(VolumeFrameStruct.floatCount).toBe(136)
    expect(FoliageWindConfigStruct.floatCount).toBe(12)
    expect(FoliageActorsStruct.floatCount).toBe(20)
    expect(MaterialRecipeStruct.floatCount).toBe(12)
    expect(SurfaceTexUniformsStruct.floatCount).toBe(44)

    for (const preset of ["current", "noir", "painterly", "sodium_70s"] as const) {
      const s = createLookSettings(preset)
      const packed = packLookUniforms(s)
      expect(packed.length).toBe(64)
      expect(packed[LookUniformsStruct.offsetOf("exposure")]).toBeCloseTo(s.exposure, 5)
      expect(packed[LookUniformsStruct.offsetOf("selectiveColor")]).toBeCloseTo(s.selectiveColor, 5)
      expect(packed[LookUniformsStruct.offsetOf("presetIndex")]).toBe(LOOK_PRESETS[preset].index)
    }

    const fol = packFoliageUniforms(foliageSettings)
    expect(fol.length).toBe(12)
    expect(fol[FoliageWindConfigStruct.offsetOf("treeWindStrength")]).toBeCloseTo(foliageSettings.treeWindStrength, 5)
    expect(fol[FoliageWindConfigStruct.offsetOf("trampleStrength")]).toBeCloseTo(foliageSettings.trampleStrength, 5)

    const act = packFoliageActors([{ x: 3, z: -4 }, { x: 9, z: 12 }])
    expect(act[0]).toBe(2)
    expect(Array.from(act.subarray(4, 8))).toEqual([3, -4, 9, 12])

    const mat = packMaterialParams(MATERIAL_RECIPES.wood_planks.defaults)
    expect(mat.length).toBe(12)
    expect(mat[MaterialRecipeStruct.offsetOf("roughness")]).toBeCloseTo(MATERIAL_RECIPES.wood_planks.defaults.roughness, 5)

    const stex = packSurfaceTexUniforms({ enabled: 1, globalScale: 1.25, splitX: 30 })
    expect(stex.length).toBe(44)
    expect(stex[SurfaceTexUniformsStruct.offsetOf("globalScale")]).toBeCloseTo(1.25, 5)
    expect(stex[SurfaceTexUniformsStruct.offsetOf("splitX")]).toBeCloseTo(30, 5)

    for (const code of [
      lookStructWgsl,
      makeLookSceneShader(),
      makeLookPostShader(),
      foliageWindDeclarationsWgsl,
      surfaceMaterialCoreWgsl,
      makeParticleShader(),
      volumeShader,
    ]) {
      expect(code).not.toMatch(/\b(L|LK|r|cfg)\.u\d+\b/)
    }
  })

  test("ParticleRenderer.setFrame packs vp, eye, debug, ambient, and filtered lights", () => {
    Object.assign(globalThis, {
      GPUBufferUsage: { UNIFORM: 64, COPY_DST: 8, VERTEX: 32 },
      GPUShaderStage: { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 },
    })
    const fakeDevice = {
      createBuffer: () => ({ destroy() {} }),
      createBindGroupLayout: () => ({}),
      createBindGroup: () => ({}),
      createShaderModule: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({}),
    } as unknown as GPUDevice
    const pr = new ParticleRenderer(fakeDevice)
    const vp = Array.from({ length: 16 }, (_, i) => i + 1)
    pr.setFrame({
      vp,
      eye: [10, 20, 30],
      debug: 3,
      ambient: [0.2, 0.3, 0.4],
      lights: [{ x: 1, y: 2, z: 3, radius: 8, r: 0.9, g: 0.5, b: 0.1, power: 2.5 }],
    })
    expect(Array.from(pr.uniforms.subarray(0, 16))).toEqual(vp)
    expect(Array.from(pr.uniforms.subarray(16, 24))).toEqual([10, 20, 30, 3, 0.20000000298023224, 0.30000001192092896, 0.4000000059604645, 1])
    expect(Array.from(pr.uniforms.subarray(24, 32))).toEqual([1, 2, 3, 8, 0.8999999761581421, 0.5, 0.10000000149011612, 2.5])
  })

  test("specializes Look scene & post variants and surface material slots without .replace()", () => {
    expect(resolveLookVariant(createLookSettings("noir"))).toBe("noir")
    expect(resolveLookVariant(createLookSettings("painterly"))).toBe("painterly")
    expect(resolveLookVariant(createLookSettings("sodium_70s"))).toBe("generic")
    expect(resolveLookVariant(createLookSettings("noir"), { mode: 2 })).toBe("generic")

    const noirScene = makeLookSceneShader({}, "noir")
    const painterlyScene = makeLookSceneShader({}, "painterly")
    const genericScene = makeLookSceneShader({}, "generic")

    expect(noirScene).toContain("moonRimDir")
    expect(noirScene).not.toContain("gouacheAlbedo")
    expect(painterlyScene).toContain("gouacheAlbedo")
    expect(painterlyScene).not.toContain("isLitRoomBulb")
    expect(genericScene).toContain("moonRimDir")
    expect(genericScene).toContain("gouacheAlbedo")

    const noirPost = makeLookPostShader(undefined, "noir")
    const painterlyPost = makeLookPostShader(undefined, "painterly")
    expect(noirPost).not.toContain("fn kuwaharaPost")
    expect(painterlyPost).toContain("fn kuwaharaPost")

    const customMat = buildSurfaceMaterialDeclarationsWgsl({
      asphaltConcrete: "fn evalAsphaltConcrete(p: vec2f, baseTint: vec3f, isConcrete: bool, r: MaterialRecipe) -> SurfaceSample { return SurfaceSample(baseTint, vec2f(0.0), r.roughness, 1.0); }",
    })
    expect(customMat).toContain("struct MaterialRecipe")
    expect(customMat).toContain("return SurfaceSample(baseTint, vec2f(0.0), r.roughness, 1.0);")
  })
})
