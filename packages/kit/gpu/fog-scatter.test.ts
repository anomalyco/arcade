import { expect, test } from "bun:test"
import { mat4 } from "wgpu-matrix"
import { validateWgsl } from "./test-naga"
import { FOG_DEFAULTS, FOG_GLOW_SIZE, FogLampPicker, FogScatter, bakeLampGlow, createFogSettings, fogOpticalDepth, fogSceneWgsl, fogScatterVolume, type FogLamp, type Vec3 } from "./fog-scatter"
import { makeSceneShader, postShader, spriteShader } from "./shaders"
import { volumeAccumulateShader, volumeBilinearShader, volumeUpsampleShader } from "./volume-pass"
import { fogBlurDownWgsl, fogBlurMixWgsl } from "./fog-blur"

const medium = { density: 0.01, falloff: 0.05, base: 0 }
const eye: Vec3 = [0, 1.7, 0]
const vp = mat4.multiply(mat4.perspective(1.1, 16 / 9, 0.15, 1200), mat4.lookAt(eye, [0, 1.7, 10], [0, 1, 0]))
const lamp = (x: number, z: number, intensity = 2000, id?: number): FogLamp => ({ x, y: 8, z, range: 20, color: [1, 0.5, 0.2], intensity, id })

test("CPU extinction used to pack lamps matches integration, including level rays", () => {
  for (const b of [[300, 1.7, 0], [40, 0, 25], [100, 60, -20], [0, 1.70001, 500]] as Vec3[]) {
    let sum = 0
    const steps = 20000
    for (let i = 0; i < steps; i++) sum += medium.density * Math.exp(-medium.falloff * (eye[1] + (b[1] - eye[1]) * ((i + 0.5) / steps)))
    const numeric = sum / steps * Math.hypot(b[0] - eye[0], b[1] - eye[1], b[2] - eye[2])
    expect(Math.abs(fogOpticalDepth(eye, b, medium) - numeric) / numeric).toBeLessThan(1e-4)
  }
})

test("lamp picker culls outside the view and respects the budget", () => {
  const p = new FogLampPicker()
  expect(p.pick([lamp(0, 20), lamp(0, -40), lamp(200, 20)], eye, vp, medium, 16)).toEqual([0])
  const lamps = Array.from({ length: 30 }, (_, i) => lamp(0, 10 + i * 4))
  expect(p.pick(lamps, eye, vp, medium, 24).length).toBe(16)
  expect(p.pick(lamps, eye, vp, medium, 3).length).toBe(3)
})

test("incumbents resist small score changes; tie-breaking does not depend on input order", () => {
  const p = new FogLampPicker(), a = lamp(-4, 40, 1000, 1), b = lamp(4, 40, 1000, 2)
  expect(p.pick([b, a], eye, vp, medium, 1)).toEqual([1])
  expect(p.pick([b, { ...a, intensity: 1000 / 1.3 }], eye, vp, medium, 1)).toEqual([1])
  expect(p.pick([b, { ...a, intensity: 1000 / 1.6 }], eye, vp, medium, 1)).toEqual([0])
})

test("lamp packing applies extinction and preserves the street lens ABI", () => {
  const fog = new FogScatter()
  const frame = fog.update({ eye, viewProj: vp, lamps: [lamp(0, 20)] })
  const sigma = medium.density * Math.exp(-medium.falloff * 8)
  const transmittance = Math.exp(-fogOpticalDepth(eye, [0, 8, 20], medium))
  expect(frame.lamps[4]).toBeCloseTo(2000 * sigma * transmittance * FOG_DEFAULTS.strength, 4)
  expect(frame.lamps[19]).toBeCloseTo(sigma, 6)
  fog.update({ eye, viewProj: vp, lamps: [{ ...lamp(0, 20), lens: { arm: [0, 2], a: 0.3, b: 0.14 } }] })
  expect(Array.from(frame.lamps.subarray(20, 24))).toEqual([0, 1, Math.fround(0.3), Math.fround(0.14)])
})

test("atmosphere rebakes only when lamps change; Today disables the passes", () => {
  const fog = new FogScatter(createFogSettings({ bank: "drift", clouds: "lit", blur: "depth" }))
  const lamps = [lamp(0, 20)]
  fog.update({ eye, viewProj: vp, lamps, time: 12 })
  const version = fog.frame.glowVersion!
  expect(fog.blurInput()).not.toBeNull()
  fog.update({ eye, viewProj: vp, lamps, time: 13 })
  expect(fog.frame.glowVersion).toBe(version)
  fog.update({ eye, viewProj: vp, lamps: [lamp(0, 20, 3000)], time: 14 })
  expect(fog.frame.glowVersion).toBeGreaterThan(version)
  fog.settings.mode = "today"
  expect(fog.update({ eye, viewProj: vp, lamps }).lampCount).toBe(0)
  expect(fog.volumeInput()).toBeNull()
  expect(fog.blurInput()).toBeNull()
})

const sources = {
  volume: fogScatterVolume().code,
  hooks: fogScatterVolume({ declarations: "struct Night { look: vec4f }\n@group(0) @binding(13) var<uniform> N: Night;", wet: "select(0.0, N.look.x, p.y < 0.2)", roughness: "0.6", normal: "vec3f(0.0, 1.0, 0.0)" }).code,
  atmosphere: fogScatterVolume({ atmosphere: true, normal: "vec3f(0.0, 1.0, 0.0)", reflectionSamples: 4 }).code,
  blurDown: fogBlurDownWgsl, blurMix: fogBlurMixWgsl,
  accumulate: volumeAccumulateShader, upsample: volumeUpsampleShader, bilinear: volumeBilinearShader,
  scene: makeSceneShader({ lampGrid: false, declarations: fogSceneWgsl, ambient: "fogAmbient(n)", surface: "col = fogApply(col, F.cam.xyz, o.world); if (mat == 3 && o.aux < 0.0) { col = fogSky(F.cam.xyz, normalize(o.world - F.cam.xyz)) + fogEnv(n) * 0.0; }" }),
  sprite: spriteShader(), spriteMotion: spriteShader(true),
  post: postShader(false, false, { chromatic: 0, bloom: 0.26, grain: 0.01, vignette: 0.45, bloomGate: { cap: 0.02, hot: 4 } }),
  postLooks: postShader(true, false, { chromatic: 0, bloom: 0.26, grain: 0.01, vignette: 0.45, bloomGate: { cap: 0.02, hot: 4 } }),
}
for (const [name, code] of Object.entries(sources)) test(`WGSL: ${name}`, () => validateWgsl(code))

test("a lamp's glowRange keeps its glow-map light inside that reach", () => {
  const rect: [number, number, number, number] = [-20, -20, 20, 20]
  const lamp: FogLamp = { x: 0, y: 3, z: 0, range: 4, color: [1, 1, 1], intensity: 10 }
  const at = (out: Float32Array, x: number) => {
    const i = Math.floor(((x - rect[0]) / (rect[2] - rect[0])) * FOG_GLOW_SIZE)
    return out[(Math.floor(FOG_GLOW_SIZE / 2) * FOG_GLOW_SIZE + i) * 4]!
  }
  const open = new Float32Array(FOG_GLOW_SIZE * FOG_GLOW_SIZE * 4)
  const ranged = new Float32Array(FOG_GLOW_SIZE * FOG_GLOW_SIZE * 4)
  bakeLampGlow(open, [lamp], rect, 4)
  bakeLampGlow(ranged, [{ ...lamp, glowRange: 6 }], rect, 4)
  expect(at(open, 10)).toBeGreaterThan(0)
  expect(at(ranged, 10)).toBe(0)
  expect(at(ranged, 1)).toBeGreaterThan(at(open, 1) * 0.8)
})
