import { describe, expect, test } from "bun:test"
import { applyFoliagePreset, cloneFoliageParams } from "../foliage"
import { MAT, Mesh, VERT_BYTES } from "../mesh"
import { ScreenLightProbe, screenBounceSource } from "../screen/light"
import { createScreenDisplaySettings } from "../screen/settings"
import {
  BAKED_GI_DEFAULTS,
  BAKED_GI_UNIFORM_FLOATS,
  ENGINE_LIGHT_GAIN,
  HOUSE_LIGHTMAP_META,
  HOUSE_LIGHTMAP_RGB9E5_B64,
  MESH_UV2_BYTES,
  analyticSpotFloorBounce,
  applyBakedUv2ToMesh,
  assertBakedLightmapFresh,
  bakeCanopyOpenness,
  bakedLightmapHooks,
  computeBakeSceneInputHash,
  decodeRgb9e5Base64,
  encodeRgb9e5Words,
  evaluateBakedLightWeights,
  packBakedLightmapUniforms,
  packMeshWithUv2,
  packRgb9e5,
  sampleCanopyOpenness,
  sampleProbeGridCpu,
  sampleUv2LightmapCpu,
  sumProbeGridForWeights,
  unpackRgb9e5,
  type LiveBounceSource,
} from "./lightmap"
import {
  FLOOR,
  SCREEN_BAKE_REFERENCE,
  SCREEN_LIGHT_ID,
  WORLD_LIGHT_ID,
  buildWorld,
  exportHouseBakeSceneSpec,
  worldClock,
  worldLights,
} from "../../lab/world/scene"

describe("rgb9e5ufloat HDR lightmap codec", () => {
  test("packs and unpacks linear HDR RGB values across 4+ orders of magnitude", () => {
    const samples: [number, number, number][] = [
      [0, 0, 0],
      [0.0025, 0.0012, 0.0004],
      [0.18, 0.09, 0.03],
      [1.0, 0.72, 0.42],
      [14.5, 8.2, 3.1],
      [240.0, 120.0, 60.0],
    ]
    for (const [r, g, b] of samples) {
      const word = packRgb9e5(r, g, b)
      const [ur, ug, ub] = unpackRgb9e5(word)
      if (r === 0 && g === 0 && b === 0) {
        expect(ur).toBe(0)
        expect(ug).toBe(0)
        expect(ub).toBe(0)
      } else {
        expect(Math.abs(ur - r) / Math.max(1e-4, r)).toBeLessThan(0.01)
        expect(Math.abs(ug - g) / Math.max(1e-4, g)).toBeLessThan(0.01)
        expect(Math.abs(ub - b) / Math.max(1e-4, b)).toBeLessThan(0.01)
      }
    }
  })

  test("decodes the baked Blender Cycles house lightmap array and verifies falloff from the lamp to corners", () => {
    const words = decodeRgb9e5Base64(HOUSE_LIGHTMAP_RGB9E5_B64)
    const { size, lights } = HOUSE_LIGHTMAP_META
    expect(size).toBe(128)
    expect(lights.length).toBe(4)
    expect(words.length).toBe(size * size * lights.length)

    // Verify the ceiling soffit (downward-facing at y ≈ 2.78) has much brighter bounce directly above the lamp than in the corners
    const spec = exportHouseBakeSceneSpec()
    const ceilingTri = spec.triangles.find((t) => t.receiveLightmap && t.normal[1] < -0.9 && t.v0[1] > 2.7)!
    expect(ceilingTri).toBeDefined()
    const ceilingUv = HOUSE_LIGHTMAP_META.uv2Tris.find((u) => u[0] === ceilingTri.triIndex)!
    expect(ceilingUv).toBeDefined()
    const weights: [number, number, number][] = [
      [1, 0.72, 0.42],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]
    const cornerBounce = sampleUv2LightmapCpu(words, HOUSE_LIGHTMAP_META, weights, [ceilingUv[1], ceilingUv[2]])
    const centerBounce = sampleUv2LightmapCpu(words, HOUSE_LIGHTMAP_META, weights, [
      (ceilingUv[1] + ceilingUv[3] + ceilingUv[5]) / 3,
      (ceilingUv[2] + ceilingUv[4] + ceilingUv[6]) / 3,
    ])
    expect(centerBounce[0]).toBeGreaterThan(cornerBounce[0] * 3.5)
    // Red rug + warm planks bleed warm red-amber into the indirect bounce (R > G > B)
    expect(centerBounce[0]).toBeGreaterThan(centerBounce[1])
    expect(centerBounce[1]).toBeGreaterThan(centerBounce[2])
  })

  test("encodes a Float32Array of RGB triples into rgb9e5 words", () => {
    const src = new Float32Array([0.5, 0.25, 0.125, 2.0, 1.0, 0.5])
    const words = encodeRgb9e5Words(src)
    expect(words.length).toBe(2)
    expect(unpackRgb9e5(words[0]!)).toEqual([0.5, 0.25, 0.125])
    expect(unpackRgb9e5(words[1]!)).toEqual([2.0, 1.0, 0.5])
  })
})

describe("Blocker 1: strictly linear per-light weight evaluation & off-means-zero", () => {
  test("scales weights strictly linearly with livePower / bakedPower across 0..10x with no threshold jump", () => {
    const interiorSpec = HOUSE_LIGHTMAP_META.lights[0]!
    expect(interiorSpec.id).toBe(WORLD_LIGHT_ID.interior)

    const ratios = [0, 0.1, 0.25, 0.5, 1.0, 2.0, 3.4, 3.5, 3.6, 5.0, 10.0]
    for (const ratio of ratios) {
      const w = evaluateBakedLightWeights(
        HOUSE_LIGHTMAP_META,
        [
          {
            id: WORLD_LIGHT_ID.interior,
            x: -4,
            y: -10,
            h: 1.5,
            r: 7,
            color: [1, 0.5, 0.25],
            power: interiorSpec.bakedPower * ratio,
          },
        ],
        [],
        { giMode: "baked", giIntensity: 1 },
      )
      expect(w[0]![0]).toBeCloseTo(1.0 * ratio, 6)
      expect(w[0]![1]).toBeCloseTo(0.5 * ratio, 6)
      expect(w[0]![2]).toBeCloseTo(0.25 * ratio, 6)
    }
  })

  test("returns [0, 0, 0] immediately when a LiveBounceSource is present and off, even if sceneLights has power > 0", () => {
    const offSource: LiveBounceSource = {
      id: SCREEN_LIGHT_ID.screen,
      scale: () => 0,
      color: () => [0, 0.8, 1.0],
    }
    const weights = evaluateBakedLightWeights(
      HOUSE_LIGHTMAP_META,
      [
        {
          id: SCREEN_LIGHT_ID.screen,
          x: -2.85,
          y: -12.172,
          h: 1.245,
          r: 6,
          color: [1, 1, 1],
          power: 50,
        },
      ],
      [offSource],
      { giMode: "baked", giIntensity: 1 },
    )
    expect(weights[1]).toEqual([0, 0, 0])
  })

  test("integrates with kit-crt screenBounceSource for live CRT colour and power scaling", () => {
    const settings = createScreenDisplaySettings({ light: 6, brightness: 2.4, power: true })
    const probe = new ScreenLightProbe()
    let powerLevel = 1
    let rgb: readonly [number, number, number] = [0.1, 0.5, 1.0]
    const emitter = {
      settings,
      light: probe,
      emission: (): readonly [number, number, number] => [
        rgb[0] * settings.brightness * powerLevel,
        rgb[1] * settings.brightness * powerLevel,
        rgb[2] * settings.brightness * powerLevel,
      ],
    }
    const bounce = screenBounceSource(emitter, SCREEN_LIGHT_ID.screen, SCREEN_BAKE_REFERENCE)

    const wCyan = evaluateBakedLightWeights(HOUSE_LIGHTMAP_META, [], [bounce], { giMode: "baked", giIntensity: 1 })
    expect(wCyan[1]![2]).toBeGreaterThan(wCyan[1]![0] * 5)

    rgb = [1.0, 0.2, 0.1]
    const wRed = evaluateBakedLightWeights(HOUSE_LIGHTMAP_META, [], [bounce], { giMode: "baked", giIntensity: 1 })
    expect(wRed[1]![0]).toBeGreaterThan(wRed[1]![2] * 5)

    // Turning CRT power off zeroes the bounce layer immediately
    powerLevel = 0
    const wOff = evaluateBakedLightWeights(HOUSE_LIGHTMAP_META, [], [bounce], { giMode: "baked", giIntensity: 1 })
    expect(wOff[1]).toEqual([0, 0, 0])
  })
})

describe("Blocker 2: exact unit calibration, analytic spot-floor verification, and surface/probe separation", () => {
  test("defaults giIntensity and giProbes to 1.0 with ENGINE_LIGHT_GAIN = 5.0", () => {
    expect(ENGINE_LIGHT_GAIN).toBe(5.0)
    expect(BAKED_GI_DEFAULTS.giIntensity).toBe(1)
    expect(BAKED_GI_DEFAULTS.giProbes).toBe(1)
  })

  test("Cycles 1-bounce spot-floor bake matches closed-form analyticSpotFloorBounce within 0.5%", () => {
    const check = HOUSE_LIGHTMAP_META.analyticSpotFloorCheck
    const analytic = analyticSpotFloorBounce({
      height: check.height,
      coneHalfAngleRad: check.coneHalfAngleRad,
      floorAlbedo: check.floorAlbedo,
      power: check.power,
    })
    expect(analytic).toBeCloseTo(check.analyticBounce, 5)
    const relErr = Math.abs(check.cyclesBounce - analytic) / analytic
    expect(relErr).toBeLessThan(0.005)
  })

  test("bakedLightmapHooks WGSL samples lightmaps only on static surfaces and L1 SH probes only on MAT.actor", () => {
    const hooks = bakedLightmapHooks({}, { uniformName: "PK" })
    expect(hooks.declarations).toContain("if (abs(mat - 12.0) < 0.5)")
    expect(hooks.declarations).toContain("return mix(prevBounce, sampleBakedProbeVolume(pos, n), falloff);")
    expect(hooks.declarations).toContain("return lmIrr * BAKED_ENGINE_GAIN;")
    // Confirm procedural chartUv / chartIndexAndSt / bakedChartUv are completely removed
    expect(hooks.declarations).not.toContain("chartIndexAndSt")
    expect(hooks.declarations).not.toContain("bakedChartUv")
  })

  test("3D L1 SH probe grid evaluates directional irradiance for dynamic actors", () => {
    const summed = new Float32Array(32 * 12)
    sumProbeGridForWeights(
      HOUSE_LIGHTMAP_META.probes,
      [
        [1, 0.72, 0.42],
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ],
      summed,
      0,
      1,
    )
    const actorPos: [number, number, number] = [-5.2, 1.1, -10.6]
    const irrTowardLamp = sampleProbeGridCpu(summed, HOUSE_LIGHTMAP_META.probes, actorPos, [0.7, 0.2, 0.7])
    expect(irrTowardLamp[0]).toBeGreaterThan(0.01)
    expect(irrTowardLamp[0]).toBeGreaterThan(irrTowardLamp[2])

    const uniformBuf = new Float32Array(BAKED_GI_UNIFORM_FLOATS)
    packBakedLightmapUniforms(
      uniformBuf,
      HOUSE_LIGHTMAP_META,
      [{ id: WORLD_LIGHT_ID.interior, x: -4, y: -10, h: 1.5, r: 7, color: [1, 0.72, 0.42], power: 10.51109 }],
      { giMode: "baked", giIntensity: 1, giProbes: 1 },
    )
    expect(uniformBuf[12]).toBe(1)
  })
})

describe("Blocker 3: Blender Lightmap Pack UV2 export and vertex buffer stamping", () => {
  test("HOUSE_LIGHTMAP_META.uv2Tris contains valid [0, 1] unwrapped UV2s for all 90 receiver triangles", () => {
    const spec = exportHouseBakeSceneSpec()
    const receivers = spec.triangles.filter((t) => t.receiveLightmap)
    expect(HOUSE_LIGHTMAP_META.uv2Tris.length).toBe(receivers.length)
    expect(receivers.length).toBe(90)

    for (const [triIdx, u0, v0, u1, v1, u2, v2] of HOUSE_LIGHTMAP_META.uv2Tris) {
      expect(triIdx).toBeGreaterThanOrEqual(0)
      for (const c of [u0, v0, u1, v1, u2, v2]) {
        expect(c).toBeGreaterThanOrEqual(0)
        expect(c).toBeLessThanOrEqual(1)
      }
      // Non-degenerate triangle in UV2 space
      const areaUv = 0.5 * Math.abs((u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0))
      expect(areaUv).toBeGreaterThan(1e-6)
    }
  })

  test("applyBakedUv2ToMesh and packMeshWithUv2 stamp Blender UV2s onto vertices without distorting normals", () => {
    const m = new Mesh()
    m.quad([-8, 0.22, -12.82], [0, 0.22, -12.82], [0, 2.9, -12.82], [-8, 2.9, -12.82], [0, 0, 1], [0.7, 0.7, 0.65], MAT.wall, 2)
    const packed24 = m.pack()
    const customMeta = {
      uv2Tris: [
        [0, 0.125, 0.25, 0.375, 0.25, 0.375, 0.625] as const,
        [1, 0.125, 0.25, 0.375, 0.625, 0.125, 0.625] as const,
      ],
    }
    const packed32 = packMeshWithUv2(packed24.slice(0), customMeta)
    expect(packed32.byteLength).toBe(6 * MESH_UV2_BYTES)
    const f32 = new Float32Array(packed32)
    expect(f32[0 * 8 + 6]).toBeCloseTo(0.125, 4)
    expect(f32[0 * 8 + 7]).toBeCloseTo(0.25, 4)
    expect(f32[2 * 8 + 6]).toBeCloseTo(0.375, 4)
    expect(f32[2 * 8 + 7]).toBeCloseTo(0.625, 4)

    applyBakedUv2ToMesh(packed24, customMeta)
    const i8 = new Int8Array(packed24)
    const u8 = new Uint8Array(packed24)
    for (let v = 0; v < 6; v++) {
      const bOff = v * VERT_BYTES
      // Normal xyz remains (0, 0, +1)
      expect(i8[bOff + 12]).toBe(0)
      expect(i8[bOff + 13]).toBe(0)
      expect(i8[bOff + 14]).toBe(127)
      // normal.w > 0 marks lightmapped vertex
      expect(i8[bOff + 15]).toBeGreaterThan(0)
    }
    const hi0 = i8[15]!
    const lo0 = u8[19]!
    const decodedU0 = ((hi0 - 1) * 256 + lo0) / 32511
    expect(decodedU0).toBeCloseTo(0.125, 3)
  })
})

describe("Blocker 4 & 5: inert default outside baked-gi and input hash freshness check", () => {
  test("buildWorld and worldLights with default bakedRoom=false leave existing presets untouched", () => {
    const vegetation = cloneFoliageParams()
    applyFoliagePreset("tree", "oak", vegetation)
    applyFoliagePreset("bush", "hedge", vegetation)
    applyFoliagePreset("grass", "lawn", vegetation)

    const defaultWorld = buildWorld({
      seed: 7,
      street: FLOOR.wetAsphalt,
      walk: FLOOR.sidewalk,
      path: FLOOR.flagstone,
      floor: FLOOR.planks,
      wall: "clapboard",
      car: "red",
      vegetation,
      tree: true,
      bush: true,
      grass: true,
    })
    const bakedRoomWorld = buildWorld({
      seed: 7,
      street: FLOOR.wetAsphalt,
      walk: FLOOR.sidewalk,
      path: FLOOR.flagstone,
      floor: FLOOR.planks,
      wall: "clapboard",
      car: "red",
      vegetation,
      tree: true,
      bush: true,
      grass: true,
      bakedRoom: true,
    })
    // Default world does NOT contain the ceiling soffit, indoor actor, or bookcase shadow box
    expect(bakedRoomWorld.vertices).toBeGreaterThan(defaultWorld.vertices)
    expect(bakedRoomWorld.boxes.length).toBe(defaultWorld.boxes.length + 1)
    expect(bakedRoomWorld.casters.length).toBe(defaultWorld.casters.length + 1)

    // In defaultWorld, no vertex has normal.w != 0
    const i8Default = new Int8Array(defaultWorld.level.chunks[0]!.data)
    let taggedDefault = 0
    for (let i = 15; i < i8Default.length; i += VERT_BYTES) {
      if (i8Default[i] !== 0) taggedDefault++
    }
    expect(taggedDefault).toBe(0)

    // In default physical worldLights, interior lamp stays a point light (spot === undefined)
    const clock = worldClock(0)
    const defaultLights = worldLights(clock, { lampPower: 1, headlights: false, flashlight: false, porch: true, physical: true })
    const defaultInterior = defaultLights.find((l) => l.id === WORLD_LIGHT_ID.interior)!
    expect(defaultInterior.spot).toBeUndefined()

    const bakedLights = worldLights(clock, { lampPower: 1, headlights: false, flashlight: false, porch: true, physical: true, bakedRoom: true })
    const bakedInterior = bakedLights.find((l) => l.id === WORLD_LIGHT_ID.interior)!
    expect(bakedInterior.spot).toBeDefined()
  })

  test("assertBakedLightmapFresh passes on current scene and throws when scene geometry or light changes", () => {
    const spec = exportHouseBakeSceneSpec()
    expect(HOUSE_LIGHTMAP_META.blenderVersion).toContain("Blender 5.2")
    expect(computeBakeSceneInputHash(spec)).toBe(HOUSE_LIGHTMAP_META.inputHash)
    expect(() => assertBakedLightmapFresh(HOUSE_LIGHTMAP_META, spec)).not.toThrow()

    const mutatedSpec = {
      ...spec,
      lights: spec.lights.map((l, idx) => (idx === 0 ? { ...l, bakedPower: l.bakedPower + 0.1 } : l)),
    }
    expect(() => assertBakedLightmapFresh(HOUSE_LIGHTMAP_META, mutatedSpec)).toThrow(/stale/)
  })
})

describe("Forest canopy-openness ambient baker", () => {
  test("bakes darker openness under dense tree crowns and brighter openness in clearings", () => {
    const map = bakeCanopyOpenness(
      {
        count: 3,
        x: new Float32Array([0, 2, -2]),
        z: new Float32Array([0, 1.5, -1.5]),
        scale: new Float32Array([1.2, 1.1, 1.3]),
        variant: new Uint8Array([0, 0, 0]),
      },
      [{ impostor: { w: 7, h: 10 } }],
      { size: 64, bounds: [-24, -24, 24, 24] },
    )
    const underCanopy = sampleCanopyOpenness(map, 0, 0)
    const clearing = sampleCanopyOpenness(map, 20, 20)
    expect(underCanopy).toBeLessThan(0.55)
    expect(clearing).toBeGreaterThan(0.95)
  })
})
