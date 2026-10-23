import { describe, expect, test } from "bun:test"
import { mat4 } from "wgpu-matrix"
import { validateWgsl } from "../test-naga"
import { BODYCAM_PRESETS, CAMERA_FILTER_DEFAULTS, CameraFilter, CAMERA_FILTER_WGSL, CRT_PRESETS, applyCameraFilterPreset, cameraFilterControls, cameraFlow, createCameraFilterSettings, meterStep } from "./camcorder"
import { CAMERA_ARTIFACT_DEFAULTS, CameraArtifacts, denoiseEchoes } from "./camera-artifacts"
import { bodycamStamp, GLYPH_H, GLYPH_W, glyphPixels, hasGlyph, layoutText, phoneTimecode, textWidth, vhsStamp } from "./camcorder-font"
import { BodycamRig, bodycamRenderFov } from "../../client/bodycam-rig"
import type { FirstPerson } from "../../client/first-person"

describe("camera filter settings", () => {
  test("off by default; ?camera= picks a filter", () => {
    expect(CAMERA_FILTER_DEFAULTS.mode).toBe("today")
    expect(createCameraFilterSettings().mode).toBe("today")
    expect(createCameraFilterSettings(new URLSearchParams("camera=vhs")).mode).toBe("vhs")
    expect(createCameraFilterSettings(new URLSearchParams("camera=iPhone")).mode).toBe("iphone")
    expect(createCameraFilterSettings(new URLSearchParams("camera=phone")).mode).toBe("iphone")
    expect(createCameraFilterSettings(new URLSearchParams("camera=nonsense")).mode).toBe("today")
    expect(createCameraFilterSettings(new URLSearchParams("camera=crt")).mode).toBe("crt")
  })

  test("deep links pick a preset; body cam only where the game has the rig", () => {
    const pvm = createCameraFilterSettings(new URLSearchParams("camera=crt-pvm"))
    expect(pvm.mode).toBe("crt")
    expect(pvm.crtPreset).toBe("pvm")
    expect(pvm.crtMask).toBe(CRT_PRESETS.pvm.crtMask)
    expect(createCameraFilterSettings(new URLSearchParams("camera=bodycam-night"), {}, { bodycam: true }).bodyNoise).toBe(BODYCAM_PRESETS.night.bodyNoise)
    expect(createCameraFilterSettings(new URLSearchParams("camera=bodycam"), {}, { bodycam: false }).mode).toBe("today")
  })

  test("defaults are the first preset of each look, and presets only touch their own look", () => {
    const s = createCameraFilterSettings()
    for (const [k, v] of Object.entries(CRT_PRESETS.tv)) if (k !== "label") expect(s[k as keyof typeof s] as unknown).toBe(v)
    for (const [k, v] of Object.entries(BODYCAM_PRESETS.patrol)) if (k !== "label") expect(s[k as keyof typeof s] as unknown).toBe(v)
    const before = { ...s }
    expect(applyCameraFilterPreset(s, "crt", "portable")).toBe(true)
    expect(s.bodyLens).toBe(before.bodyLens)
    expect(s.crtCurvature).toBe(CRT_PRESETS.portable.crtCurvature)
    expect(applyCameraFilterPreset(s, "crt", "nope")).toBe(false)
  })

  test("controls: Today first, every row bound to a default with a sane range", () => {
    expect((m => "options" in m && m.options.map(o => o.value))(cameraFilterControls()[0]!)).toEqual(["today", "iphone", "vhs", "crt"])
    const controls = cameraFilterControls({ bodycam: true })
    const mode = controls[0]!
    expect("options" in mode && mode.options.map(o => o.value)).toEqual(["today", "iphone", "vhs", "crt", "bodycam"])
    for (const c of controls) {
      expect(c.key.startsWith("camera.")).toBe(true)
      expect(c.field! in CAMERA_FILTER_DEFAULTS).toBe(true)
      if ("min" in c) {
        const v = CAMERA_FILTER_DEFAULTS[c.field as keyof typeof CAMERA_FILTER_DEFAULTS] as number
        expect(v).toBeGreaterThanOrEqual(c.min)
        expect(v).toBeLessThanOrEqual(c.max)
      }
    }
    const vhsOnly = controls.find(c => c.field === "vhsTracking")!
    expect(vhsOnly.visible?.({ "camera.mode": "vhs" })).toBe(true)
    expect(vhsOnly.visible?.({ "camera.mode": "iphone" })).toBe(false)
  })
})

describe("camera flow", () => {
  const frame = (yaw: number) => {
    const proj = mat4.perspective(1.2, 16 / 9, 0.1, 100)
    const view = mat4.lookAt([0, 1.6, 0], [Math.sin(yaw), 1.6, -Math.cos(yaw)], [0, 1, 0])
    const f = new Float32Array(20)
    f.set(mat4.multiply(proj, view), 0)
    f.set([0, 1.6, 0], 16)
    return f
  }
  test("a still camera does not move the image", () => {
    const [dx, dy] = cameraFlow(frame(0.3), frame(0.3), 1920, 1080)
    expect(Math.abs(dx)).toBeLessThan(1e-3)
    expect(Math.abs(dy)).toBeLessThan(1e-3)
  })
  test("turning right moves the content left by the angle's share of the view", () => {
    const [dx, dy] = cameraFlow(frame(0.02), frame(0), 1920, 1080)
    const expected = (Math.tan(0.02) / (Math.tan(0.6) * (16 / 9))) * 960
    expect(dx).toBeLessThan(0)
    expect(Math.abs(dx)).toBeCloseTo(expected, 0)
    expect(Math.abs(dy)).toBeLessThan(0.5)
  })
})

describe("camcorder font and stamps", () => {
  test("every glyph is 5×7, and every stamp character has one", () => {
    for (const ch of "0123456789:. /-▶") expect(hasGlyph(ch)).toBe(true)
    for (const m of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
      const s = vhsStamp(new Date(1987, m, 21, 23, 47))
      for (const ch of s.date + s.time + "PLAY ▶") expect(hasGlyph(ch)).toBe(true)
    }
    for (const [x, y] of glyphPixels("8")) {
      expect(x).toBeLessThan(GLYPH_W)
      expect(y).toBeLessThan(GLYPH_H)
    }
  })
  test("stamp and timer text", () => {
    expect(vhsStamp(new Date(2026, 9, 21, 23, 47), 1987)).toEqual({ time: "PM 11:47", date: "OCT.21 1987" })
    expect(vhsStamp(new Date(2026, 0, 5, 0, 3))).toEqual({ time: "AM 12:03", date: "JAN.05 2026" })
    expect(phoneTimecode(83.9)).toBe("00:01:23")
    expect(phoneTimecode(3725)).toBe("01:02:05")
    const body = bodycamStamp(new Date(Date.UTC(2026, 9, 21, 23, 47, 5)), 1987)
    expect(body.time).toBe("2026-10-21 T23:47:05Z")
    expect(body.unit).toMatch(/^BODY CAM X1 {2}D\d\d-\d{5}$/)
  })
  test("layout advances one blank column per glyph", () => {
    const xs: number[] = []
    layoutText("11", 0, 0, 2, x => xs.push(x))
    expect(Math.max(...xs) - Math.min(...xs)).toBe(12 + 2 * 2)
    expect(textWidth("PM 11:47", 2)).toBe((7 * 6 + 5) * 2)
  })
})

describe("camera filter shaders", () => {
  test("state, iPhone/body cam, VHS and CRT passes validate", () => {
    validateWgsl(CAMERA_FILTER_WGSL.state)
    validateWgsl(CAMERA_FILTER_WGSL.phone)
    validateWgsl(CAMERA_FILTER_WGSL.vhs)
    validateWgsl(CAMERA_FILTER_WGSL.crt)
  })
})

describe("body cam lens", () => {
  test("the render's diagonal is the lens's: 140° on 16:9 renders about 107° tall", () => {
    const fov = bodycamRenderFov(140, 16 / 9)
    expect(fov).toBeCloseTo(106.8, 0)
    const half = (fov / 2) * Math.PI / 180
    expect(2 * Math.atan(Math.tan(half) * Math.hypot(16 / 9, 1)) * 180 / Math.PI).toBeCloseTo(140, 3)
  })
})

describe("body cam rig", () => {
  const settings = { lens: 140, mount: 0.35, sway: 1, lag: 0.5, bob: 1 }
  const camera = () => ({ yaw: 0, pitch: 0, fov: 68, body: { x: 0, y: 0, vx: 0, vy: 0 }, mount: { yaw: 0, pitch: 0, roll: 0, height: 0, fov: 0 } })
  test("hangs below the eyes with the lens's field of view; off leaves the camera alone", () => {
    const c = camera(), rig = new BodycamRig()
    rig.step(c as unknown as FirstPerson, 1 / 60, 16 / 9, settings, 1, true)
    expect(c.mount.height).toBeCloseTo(-0.35, 6)
    expect(c.fov + c.mount.fov).toBeCloseTo(bodycamRenderFov(140, 16 / 9), 6)
    rig.step(c as unknown as FirstPerson, 1 / 60, 16 / 9, settings, 1, false)
    expect(c.mount).toEqual({ yaw: 0, pitch: 0, roll: 0, height: 0, fov: 0 })
    rig.step(c as unknown as FirstPerson, 1 / 60, 16 / 9, settings, 0, true)
    expect(Math.abs(c.mount.height) + Math.abs(c.mount.fov) + Math.abs(c.mount.yaw)).toBe(0)
  })
  test("a sudden turn lags, swings past and settles on the aim", () => {
    const c = camera(), rig = new BodycamRig()
    rig.step(c as unknown as FirstPerson, 1 / 60, 16 / 9, { ...settings, sway: 0 }, 1, true)
    c.yaw = 1
    const lags: number[] = []
    for (let i = 0; i < 120; i++) { rig.step(c as unknown as FirstPerson, 1 / 60, 16 / 9, { ...settings, sway: 0 }, 1, true); lags.push(c.mount.yaw) }
    expect(lags[0]!).toBeLessThan(-0.3)
    expect(Math.max(...lags)).toBeGreaterThan(0.005)
    expect(Math.abs(lags.at(-1)!)).toBeLessThan(0.01)
  })
})

describe("camera filter lifecycle", () => {
  test("switching off forgets the last filter, so iPhone → Today → iPhone starts a fresh recording", () => {
    const filter = new CameraFilter({} as GPUDevice, "bgra8unorm", createCameraFilterSettings())
    const state = filter as unknown as { valid: boolean; lastMode: string }
    filter.settings.mode = "iphone"
    expect(filter.active).toBe(true)
    // As after a filtered frame.
    state.valid = true
    state.lastMode = "iphone"
    expect(filter.active).toBe(true)
    expect(state).toMatchObject({ valid: true, lastMode: "iphone" })
    filter.settings.mode = "today"
    expect(filter.active).toBe(false)
    expect(state).toMatchObject({ valid: false, lastMode: "today" })
  })
})

describe("camera filter motion and map clearing", () => {
  const packed = (filter: CameraFilter, mode: "phone" | "body" | "vhs") => {
    const f = new Float32Array(20)
    f.set(mat4.perspective(1, 16 / 9, 0.1, 100), 0)
    ;(filter as unknown as { pack: (...a: unknown[]) => void }).pack(mode, f, 1, 1 / 60, false, false, 1600, 900)
    return (filter as unknown as { data: Float32Array }).data
  }

  test("reduced motion (motion 0) stops the phone shake and both shutter blurs", () => {
    for (const mode of ["phone", "body"] as const) {
      const filter = new CameraFilter({} as GPUDevice, "bgra8unorm", { ...createCameraFilterSettings(), phoneShake: 1, phoneMotionBlur: 1, bodyMotionBlur: 1 })
      const on = [...packed(filter, mode)]
      filter.motion = 0
      const off = packed(filter, mode)
      // d: shake x, y, roll (12..14); p2.x: shutter blur (28).
      expect(on[28]).toBe(1)
      expect(off[28]).toBe(0)
      expect([off[12], off[13], off[14]].map(Math.abs)).toEqual([0, 0, 0])
      if (mode === "phone") expect(Math.abs(on[12]!) + Math.abs(on[13]!)).toBeGreaterThan(0)
    }
  })

  test("a cleared picture (strengthScale 0) still draws its stamp", () => {
    const filter = new CameraFilter({} as GPUDevice, "bgra8unorm", createCameraFilterSettings())
    filter.strengthScale = 0
    const u = packed(filter, "vhs")
    expect(u[5]).toBe(0)
    expect(u[15]).toBe(1)
  })

  test("the VHS stamp is composited after the tape, unwarped and at full alpha", () => {
    const vhs = CAMERA_FILTER_WGSL.vhs
    const body = vhs.slice(vhs.indexOf("@fragment"))
    expect(body.indexOf("textureSampleLevel(overlay")).toBeGreaterThan(body.indexOf("Interlace"))
    expect(body).toContain("c = c * (1.0 - o.a) + o.rgb")
  })
})

describe("camera filter held frames and textures", () => {
  const at = (t: number) => { const f = new Float32Array(20); f[19] = t; return f }
  /** As after a body-cam frame at 1 s (30 fps sensor frame 30). */
  function recorded(mode: "bodycam" | "vhs" | "iphone", fps = 30) {
    const filter = new CameraFilter({} as GPUDevice, "bgra8unorm", { ...createCameraFilterSettings(), mode, phoneFps: fps })
    Object.assign(filter, { targets: { source: { destroy() {} }, hist: [] }, valid: true, lastMode: mode, lastTime: 1, lastFrameIndex: 30 })
    return filter
  }

  test("a 30 fps sensor holds the 60 Hz frame between its own, and only that one", () => {
    expect(recorded("bodycam").holds(at(1.01))).toBe(true)
    expect(recorded("bodycam").holds(at(1.04))).toBe(false)
    expect(recorded("iphone").holds(at(1.01))).toBe(true)
    expect(recorded("iphone", 60).holds(at(1.01))).toBe(false)
    // VHS records every field; a jump in time starts afresh.
    expect(recorded("vhs").holds(at(1.01))).toBe(false)
    expect(recorded("bodycam").holds(at(1.5))).toBe(false)
  })

  test("a held frame the chain skips still moves the clock, and the next sensor frame meters from the last one", () => {
    const filter = recorded("bodycam")
    Object.assign(filter, { targets: { width: 1600, height: 900, source: { destroy() {} }, hist: [] }, stateTime: 1 })
    filter.skip(at(1.01))
    expect((filter as unknown as { lastTime: number }).lastTime).toBe(Math.fround(1.01))
    expect(filter.holds(at(1.02))).toBe(true)
    expect(filter.holds(at(1.04))).toBe(false)
    const { meter } = (filter as unknown as { clock(mode: string, frame: Float32Array): { meter: number } }).clock("body", at(1.04))
    expect(meter).toBeCloseTo(0.02, 5)
  })

    test("switching off frees its full-size textures", () => {
    const filter = recorded("bodycam")
    let freed = 0
    Object.assign(filter, { targets: { source: { destroy: () => freed++ }, hist: [{ destroy: () => freed++ }, { destroy: () => freed++ }] } })
    filter.settings.mode = "today"
    expect(filter.active).toBe(false)
    expect(freed).toBe(3)
    expect((filter as unknown as { targets: unknown }).targets).toBeNull()
  })
})

describe("camera clocks at any display rate", () => {
  /** A still view at time t (identity viewProj, so the flow is 0). */
  const at = (t: number) => { const f = new Float32Array(20); f[0] = f[5] = f[10] = f[15] = 1; f[19] = t; return f }
  const targets = { width: 1600, height: 900, source: { destroy() {} }, hist: [] }
  type Clocked = { clock(mode: string, frame: Float32Array): { meter: number } }
  type Advanced = { advance(frame: Float32Array, draws: boolean): { elapsed: number } }

  /**
   * Two seconds of a 30 fps body cam on a display at `hz`, driven as `FinalPassChain` does: held frames skip the lens
   * and the filter, sensor frames draw both. Returns the exposure spring after a step of light (simulating `fs_state`
   * from the packed steps) and the denoise's retention per second (log), with the per-frame steps.
   */
  function run(hz: number, mode: "bodycam" | "iphone" = "bodycam", fps = 30) {
    const filter = new CameraFilter({} as GPUDevice, "bgra8unorm", { ...createCameraFilterSettings(), mode, phoneFps: fps })
    const lens = new CameraArtifacts({} as GPUDevice, "bgra8unorm", { ...CAMERA_ARTIFACT_DEFAULTS, sensorGain: true }, "lens")
    const t0 = 1.003
    Object.assign(filter, { targets, valid: true, lastMode: mode, lastTime: t0, stateTime: t0, lastFrameIndex: Math.floor(t0 * fps) })
    Object.assign(lens, { targets, valid: true, lastTime: t0, drawnTime: t0 })
    // The exposure spring with the hunt off (omega 6, zeta 1), from 0 towards 1; a denoise smear keeping 0.6.
    let e = 0, ev = 0, retained = 0
    const meters: number[] = [], echoes: number[] = []
    const frames = Math.round(2 * hz)
    for (let i = 1; i <= frames; i++) {
      const f = at(t0 + i / hz)
      if (filter.holds(f)) {
        lens.skip(f)
        filter.skip(f)
        continue
      }
      const n = denoiseEchoes((lens as unknown as Advanced).advance(f, true).elapsed)
      echoes.push(n)
      // One smear as the lens draws, then the echoes, the last in part (the lens shader's loop).
      retained += Math.log(0.6)
      for (let k = 0; k < Math.ceil(n); k++) retained += Math.log(1 - Math.min(n - k, 1) * 0.4)
      const dt = Math.min((filter as unknown as Clocked).clock(mode === "bodycam" ? "body" : "phone", f).meter, 0.1)
      meters.push(dt)
      ev += (36 * (1 - e) - 12 * ev) * dt
      e += ev * dt
    }
    return { e, retained: retained / 2, meters, echoes }
  }

  test("60 Hz keeps the tuned steps: a 1/60 s meter step and one denoise echo per 30 fps frame", () => {
    const { meters, echoes } = run(60)
    expect(meters.length).toBe(60)
    for (const m of meters) expect(m).toBeCloseTo(1 / 60, 5)
    for (const n of echoes) expect(n).toBeCloseTo(1, 4)
  })

  test("30, 120 and 144 Hz match 60 Hz for the meter springs and the denoise smoothing", () => {
    const ref = run(60)
    for (const hz of [30, 120, 144]) {
      const r = run(hz)
      expect([hz, r.meters.reduce((a, b) => a + b, 0)]).toEqual([hz, expect.closeTo(1, 3)])
      expect([hz, r.e]).toEqual([hz, expect.closeTo(ref.e, 3)])
      expect([hz, r.retained / ref.retained]).toEqual([hz, expect.closeTo(1, 1)])
    }
  })

  test("a 24 fps phone's meter keeps its 60 Hz pace on faster displays", () => {
    const ref = run(60, "iphone", 24)
    for (const hz of [120, 144]) expect([hz, run(hz, "iphone", 24).e]).toEqual([hz, expect.closeTo(ref.e, 2)])
    expect(meterStep(1 / 24, 24)).toBeCloseTo(1 / 60, 6)
    expect(meterStep(1 / 120, 60)).toBeCloseTo(1 / 120, 6)
  })
})
