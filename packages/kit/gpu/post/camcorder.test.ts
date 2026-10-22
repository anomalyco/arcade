import { describe, expect, test } from "bun:test"
import { mat4 } from "wgpu-matrix"
import { validateWgsl } from "../test-naga"
import { BODYCAM_PRESETS, CAMERA_FILTER_DEFAULTS, CAMERA_FILTER_WGSL, CRT_PRESETS, applyCameraFilterPreset, cameraFilterControls, cameraFlow, createCameraFilterSettings } from "./camcorder"
import { bodycamStamp, GLYPH_H, GLYPH_W, glyphPixels, hasGlyph, layoutText, phoneTimecode, textWidth, vhsStamp } from "./camcorder-font"
import { bodycamRenderFov } from "../../client/bodycam-rig"

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
