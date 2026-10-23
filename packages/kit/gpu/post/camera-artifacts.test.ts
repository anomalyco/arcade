import { describe, expect, test } from "bun:test"
import { validateWgsl } from "../test-naga"
import { CAMERA_ARTIFACT_DEFAULTS, CAMERA_ARTIFACT_WGSL, CameraArtifacts, cameraArtifactControls } from "./camera-artifacts"
import { FinalPassChain } from "./final-chain"
import type { FinalPass } from "../renderer"

const device = {} as GPUDevice

describe("camera artifacts", () => {
  test("every effect is off by default, so neither stage runs", () => {
    for (const [k, v] of Object.entries(CAMERA_ARTIFACT_DEFAULTS)) if (typeof v === "boolean") expect([k, v]).toEqual([k, false])
    const s = { ...CAMERA_ARTIFACT_DEFAULTS }
    const lens = new CameraArtifacts(device, "bgra8unorm", s, "lens"), codec = new CameraArtifacts(device, "bgra8unorm", s, "codec")
    expect([lens.active, codec.active]).toEqual([false, false])
    s.compression = true
    expect([lens.active, codec.active]).toEqual([false, true])
    s.compression = false
    for (const k of ["focusHunt", "sensorGain", "pwm", "flare", "dirt", "condensation", "infrared"] as const) {
      s[k] = true
      expect([k, lens.active, codec.active]).toEqual([k, true, false])
      s[k] = false
    }
  })

  test("controls: a toggle per effect, its amounts only while it is on, defaults inside their ranges", () => {
    const controls = cameraArtifactControls({ prefix: "a." })
    for (const c of controls) {
      expect(c.field! in CAMERA_ARTIFACT_DEFAULTS).toBe(true)
      if ("min" in c) {
        const v = CAMERA_ARTIFACT_DEFAULTS[c.field as keyof typeof CAMERA_ARTIFACT_DEFAULTS] as number
        expect(v).toBeGreaterThanOrEqual(c.min)
        expect(v).toBeLessThanOrEqual(c.max)
      }
    }
    const amount = controls.find(c => c.field === "flareAmount")!
    expect(amount.visible?.({ "a.flare": true })).toBe(true)
    expect(amount.visible?.({ "a.flare": false })).toBe(false)
  })

  test("shaders validate", () => {
    validateWgsl(CAMERA_ARTIFACT_WGSL.pre)
    validateWgsl(CAMERA_ARTIFACT_WGSL.lens)
    validateWgsl(CAMERA_ARTIFACT_WGSL.codec)
  })
})

describe("final pass chain", () => {
  const fake = (name: string, log: string[], on = true) => ({
    active: on,
    source: () => name as unknown as GPUTextureView,
    encode: (_e: GPUCommandEncoder, target: GPUTextureView) => { log.push(`${name}→${target as unknown as string}`) },
  }) satisfies FinalPass

  test("each active pass writes the next one's source and the last the target; inactive ones are skipped", () => {
    const log: string[] = []
    const chain = new FinalPassChain([fake("a", log), fake("b", log, false), fake("c", log)])
    expect(chain.active).toBe(true)
    expect(chain.source(4, 4) as unknown as string).toBe("a")
    chain.encode({} as GPUCommandEncoder, "canvas" as unknown as GPUTextureView, new Float32Array(20))
    expect(log).toEqual(["a→c", "c→canvas"])
  })

  test("nothing active: the renderer composites straight to the canvas", () => {
    expect(new FinalPassChain([fake("a", [], false)]).active).toBe(false)
  })
})

describe("camera artifacts strength scale", () => {
  test("strengthScale 0 zeroes every effect's amount while the knobs stay on", () => {
    const s = { ...CAMERA_ARTIFACT_DEFAULTS, focusHunt: true, sensorGain: true, pwm: true, flare: true, dirt: true, condensation: true, infrared: true, compression: true }
    const amounts = (stage: "lens" | "codec", scale: number) => {
      const a = new CameraArtifacts(device, "bgra8unorm", s, stage)
      a.strengthScale = scale
      const f = new Float32Array(20)
      f[0] = f[5] = 1; f[10] = -1; f[11] = -1; f[14] = -0.2
      ;(a as unknown as { pack: (...x: unknown[]) => void }).pack(f, 1, 1 / 60, false, 1600, 900)
      const u = (a as unknown as { data: Float32Array }).data
      // e: flare, dirt, condensation, pwm (12..15); g: gain, infrared, compression (16..18).
      return [...u.subarray(12, 19)]
    }
    expect(amounts("lens", 1).slice(0, 6).every((v) => v > 0)).toBe(true)
    expect(amounts("codec", 1)[6]).toBeGreaterThan(0)
    expect(amounts("lens", 0)).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(amounts("codec", 0)).toEqual([0, 0, 0, 0, 0, 0, 0])
  })
})
