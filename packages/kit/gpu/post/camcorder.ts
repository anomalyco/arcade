import { mat4 } from "wgpu-matrix"
import type { LabControl, LabPanel } from "../../lab-panel"
import type { FinalPass, Renderer } from "../renderer"
import { BodycamRig } from "../../client/bodycam-rig"
import type { FirstPerson } from "../../client/first-person"
import { bodycamStamp, layoutText, phoneTimecode, textWidth, vhsStamp } from "./camcorder-font"

/**
 * Camera filters: the finished frame as if a phone, an '80s VHS camcorder, a CRT television or a police body camera
 * recorded it. One fullscreen pass after the game's tonemapped composite (`Renderer.setFinalPass`), plus a 2×1 state
 * pass for the phone and body camera's auto exposure, white balance and focus. Off ("today") builds nothing: no
 * textures, no pipelines, no shader compile. The body camera also moves the view (`BodycamRig`), so only games that
 * pass their `FirstPerson` offer it.
 */
export type CameraFilterMode = "today" | "iphone" | "vhs" | "crt" | "bodycam"
type Family = "phone" | "vhs" | "crt" | "body"
const familyOf = (mode: CameraFilterMode): Family | null =>
  mode === "iphone" ? "phone" : mode === "vhs" ? "vhs" : mode === "crt" ? "crt" : mode === "bodycam" ? "body" : null

export const CRT_PRESETS = {
  tv: { label: "Living-room TV", crtMask: 2, crtMaskStrength: 0.6, crtLines: 240, crtScanlines: 0.6, crtBeam: 0.7, crtSharpness: 0.3, crtCurvature: 0.6, crtBezel: 0.6, crtConvergence: 0.5, crtGlow: 0.5, crtPersistence: 0.25, crtFlicker: 0.3, crtInterlace: 0, crtVignette: 0.5, crtGlass: 0.5 },
  pvm: { label: "Studio monitor", crtMask: 0, crtMaskStrength: 0.7, crtLines: 300, crtScanlines: 0.85, crtBeam: 0.6, crtSharpness: 0.85, crtCurvature: 0.15, crtBezel: 0.3, crtConvergence: 0.1, crtGlow: 0.2, crtPersistence: 0.15, crtFlicker: 0.1, crtInterlace: 0, crtVignette: 0.2, crtGlass: 0.25 },
  arcade: { label: "Arcade cabinet", crtMask: 1, crtMaskStrength: 0.65, crtLines: 224, crtScanlines: 0.75, crtBeam: 0.8, crtSharpness: 0.6, crtCurvature: 0.45, crtBezel: 0.5, crtConvergence: 0.3, crtGlow: 0.7, crtPersistence: 0.3, crtFlicker: 0.15, crtInterlace: 0, crtVignette: 0.35, crtGlass: 0.6 },
  portable: { label: "Kitchen portable", crtMask: 2, crtMaskStrength: 0.5, crtLines: 200, crtScanlines: 0.45, crtBeam: 0.5, crtSharpness: 0.15, crtCurvature: 0.9, crtBezel: 0.9, crtConvergence: 0.8, crtGlow: 0.4, crtPersistence: 0.4, crtFlicker: 0.5, crtInterlace: 0.4, crtVignette: 0.8, crtGlass: 0.7 },
} as const
export const BODYCAM_PRESETS = {
  patrol: { label: "Chest, patrol", bodyLens: 140, bodyFisheye: 1, bodyMount: 0.35, bodySway: 1, bodyLag: 0.5, bodyBob: 1, bodyNoise: 1, bodySharpen: 1.2, bodyCompression: 0.7, bodyExposure: 0.8, bodyDirt: 0.5, bodyColor: 0.45, bodyVignette: 0.5, bodyRolling: 1, bodyMotionBlur: 0.8 },
  night: { label: "Chest, night", bodyLens: 140, bodyFisheye: 1, bodyMount: 0.35, bodySway: 1, bodyLag: 0.5, bodyBob: 1, bodyNoise: 1.8, bodySharpen: 0.8, bodyCompression: 0.9, bodyExposure: 1, bodyDirt: 0.8, bodyColor: 0.75, bodyVignette: 0.7, bodyRolling: 1, bodyMotionBlur: 1 },
  helmet: { label: "Head mount", bodyLens: 120, bodyFisheye: 0.8, bodyMount: 0.05, bodySway: 0.5, bodyLag: 0.15, bodyBob: 0.6, bodyNoise: 1, bodySharpen: 1.2, bodyCompression: 0.7, bodyExposure: 0.8, bodyDirt: 0.3, bodyColor: 0.45, bodyVignette: 0.4, bodyRolling: 1.2, bodyMotionBlur: 0.8 },
  older: { label: "Older unit", bodyLens: 125, bodyFisheye: 0.6, bodyMount: 0.4, bodySway: 1.2, bodyLag: 0.6, bodyBob: 1.2, bodyNoise: 1.4, bodySharpen: 1.8, bodyCompression: 1, bodyExposure: 1, bodyDirt: 0.6, bodyColor: 0.25, bodyVignette: 0.6, bodyRolling: 1.6, bodyMotionBlur: 1 },
} as const
export type CrtPreset = keyof typeof CRT_PRESETS
export type BodycamPreset = keyof typeof BODYCAM_PRESETS
const strip = <T extends { label: string }>({ label: _, ...rest }: T) => rest

export const CAMERA_FILTER_DEFAULTS = {
  mode: "today" as CameraFilterMode,
  /** Every effect of the chosen filter at once. */
  strength: 1,
  /** Phone: recording timer. VHS: PLAY and the date/time stamp. Body cam: time and unit. */
  overlay: true,
  phoneHdr: 0.7,
  phoneSharpen: 0.8,
  phoneNoise: 1,
  phoneDenoise: 0.5,
  phoneExposure: 0.6,
  phoneWhiteBalance: 0.6,
  phoneFocus: 0.5,
  phoneRolling: 1,
  phoneMotionBlur: 0.7,
  phoneFps: 30,
  phoneCompression: 0.5,
  phoneFlare: 0.6,
  phoneShake: 0.4,
  phoneVertical: false,
  vhsSoftness: 1,
  vhsChroma: 1,
  vhsSharpen: 0.5,
  vhsColor: 1,
  vhsNoise: 1,
  vhsDropouts: 1,
  vhsTracking: 0.6,
  vhsHeadSwitch: 1,
  vhsInterlace: 1,
  vhsBloom: 0.6,
  vhsVignette: 0.6,
  vhsRoll: 0.4,
  vhsYear: 1987,
  crtPreset: "tv" as CrtPreset,
  /** 0 aperture grille, 1 slot mask, 2 shadow mask. */
  crtMask: 2 as number,
  ...strip(CRT_PRESETS.tv) as { [K in Exclude<keyof typeof CRT_PRESETS.tv, "label" | "crtMask">]: number },
  bodyPreset: "patrol" as BodycamPreset,
  ...strip(BODYCAM_PRESETS.patrol) as { [K in Exclude<keyof typeof BODYCAM_PRESETS.patrol, "label">]: number },
}
export type CameraFilterSettings = typeof CAMERA_FILTER_DEFAULTS

const MODES: readonly CameraFilterMode[] = ["today", "iphone", "vhs", "crt", "bodycam"]

/** Copies a preset's values onto the look's knobs. */
export function applyCameraFilterPreset(settings: CameraFilterSettings, look: "crt" | "bodycam", id: string): boolean {
  if (look === "crt" && id in CRT_PRESETS) Object.assign(settings, strip(CRT_PRESETS[id as CrtPreset]), { crtPreset: id })
  else if (look === "bodycam" && id in BODYCAM_PRESETS) Object.assign(settings, strip(BODYCAM_PRESETS[id as BodycamPreset]), { bodyPreset: id })
  else return false
  return true
}

/**
 * Defaults, with `?camera=<mode>[-<preset>]` applied, e.g. `vhs`, `crt-pvm`, `bodycam-night` (automation and preview
 * deep links; the panel is the control). Body cam needs the rig, so `bodycam: false` ignores it.
 */
export function createCameraFilterSettings(params?: URLSearchParams, overrides: Partial<CameraFilterSettings> = {}, options: { bodycam?: boolean } = {}): CameraFilterSettings {
  const settings = { ...CAMERA_FILTER_DEFAULTS, ...overrides }
  const [raw = "", preset] = (params?.get("camera")?.toLowerCase() ?? "").split("-", 2)
  const alias: Record<string, CameraFilterMode> = { phone: "iphone", off: "today", tv: "crt", body: "bodycam" }
  const mode = alias[raw] ?? raw
  if (!(MODES as readonly string[]).includes(mode) || (mode === "bodycam" && options.bodycam === false)) return settings
  settings.mode = mode as CameraFilterMode
  if (preset && (mode === "crt" || mode === "bodycam")) applyCameraFilterPreset(settings, mode, preset)
  return settings
}

export type CameraFilterControlOptions = {
  group?: string
  prefix?: string
  /** Offer the body camera (the game drives its `FirstPerson` through `BodycamRig`). */
  bodycam?: boolean
  /** A look's preset was picked: copy its values (`applyCameraFilterPreset`) and refresh the panel. */
  onPreset?: (look: "crt" | "bodycam", id: string) => void
}

export function cameraFilterControls(options: CameraFilterControlOptions = {}): LabControl[] {
  const { group = "Camera filter", prefix = "camera.", bodycam = false, onPreset } = options
  const key = (k: keyof CameraFilterSettings) => ({ key: prefix + k, ...(prefix ? { field: k } : {}) })
  const is = (mode: CameraFilterMode) => (s: Readonly<Record<string, unknown>>) => s[prefix + "mode"] === mode
  const phone = is("iphone"), vhs = is("vhs"), crt = is("crt"), body = is("bodycam")
  const range = (k: keyof CameraFilterSettings, label: string, min: number, max: number, step: number, unit: string, when: typeof phone, subsection: string): LabControl => ({
    ...key(k), label, group, subsection, min, max, step, unit, visible: when,
  })
  const on = (s: Readonly<Record<string, unknown>>) => s[prefix + "mode"] !== "today"
  const stamped = (s: Readonly<Record<string, unknown>>) => on(s) && !crt(s)
  const modes = [{ value: "today", label: "Today (off)" }, { value: "iphone", label: "iPhone" }, { value: "vhs", label: "VHS camcorder" }, { value: "crt", label: "CRT TV" }]
  if (bodycam) modes.push({ value: "bodycam", label: "Body cam" })
  const presets = (table: Record<string, { label: string }>) => Object.entries(table).map(([value, p]) => ({ value, label: p.label }))
  return [
    { ...key("mode"), label: "Camera filter", group, type: "select", options: modes },
    { ...key("strength"), label: "Strength", group, min: 0, max: 1, step: 0.01, unit: "×", visible: on },
    { ...key("overlay"), label: "Overlay (timer / stamp)", group, type: "toggle", visible: stamped },
    { ...key("crtPreset"), label: "Preset", group, type: "select", options: presets(CRT_PRESETS), visible: crt, change: v => onPreset?.("crt", String(v)) },
    { ...key("crtMask"), label: "Phosphor mask", group, subsection: "Tube", type: "select", options: [{ value: 0, label: "Aperture grille" }, { value: 1, label: "Slot mask" }, { value: 2, label: "Shadow mask" }], visible: crt },
    range("crtMaskStrength", "Mask strength", 0, 1, 0.01, "×", crt, "Tube"),
    range("crtLines", "Scanlines per frame", 120, 720, 1, "lines", crt, "Tube"),
    range("crtScanlines", "Scanline gaps", 0, 1, 0.01, "×", crt, "Tube"),
    range("crtBeam", "Beam widens when bright", 0, 1, 0.01, "×", crt, "Tube"),
    range("crtSharpness", "Horizontal sharpness", 0, 1, 0.01, "×", crt, "Tube"),
    range("crtConvergence", "Convergence error", 0, 1, 0.01, "px", crt, "Tube"),
    range("crtGlow", "Halation, bloom", 0, 1, 0.01, "×", crt, "Tube"),
    range("crtPersistence", "Phosphor persistence", 0, 1, 0.01, "×", crt, "Tube"),
    range("crtFlicker", "Flicker (filmed)", 0, 1, 0.01, "×", crt, "Signal"),
    range("crtInterlace", "Interlace", 0, 1, 0.01, "×", crt, "Signal"),
    range("crtCurvature", "Curvature", 0, 1, 0.01, "×", crt, "Glass"),
    range("crtBezel", "Rounded bezel", 0, 1, 0.01, "×", crt, "Glass"),
    range("crtVignette", "Vignette", 0, 1, 0.01, "×", crt, "Glass"),
    range("crtGlass", "Glass reflection", 0, 1, 0.01, "×", crt, "Glass"),
    ...(bodycam ? [
      { ...key("bodyPreset"), label: "Preset", group, type: "select", options: presets(BODYCAM_PRESETS), visible: body, change: (v: unknown) => onPreset?.("bodycam", String(v)) } as LabControl,
      range("bodyLens", "Lens (diagonal)", 90, 170, 1, "°", body, "Lens"),
      range("bodyFisheye", "Fisheye", 0, 1, 0.01, "×", body, "Lens"),
      range("bodyDirt", "Lens dirt, glare", 0, 1, 0.01, "×", body, "Lens"),
      range("bodyVignette", "Vignette", 0, 1, 0.01, "×", body, "Lens"),
      range("bodyMount", "Below the eyes", 0, 0.6, 0.01, "m", body, "Rig"),
      range("bodySway", "Torso sway", 0, 2, 0.05, "×", body, "Rig"),
      range("bodyLag", "Turn lag", 0, 1, 0.01, "×", body, "Rig"),
      range("bodyBob", "Footstep bounce", 0, 2, 0.05, "×", body, "Rig"),
      range("bodyExposure", "Exposure hunting", 0, 1, 0.01, "×", body, "Sensor"),
      range("bodyNoise", "Noise in the dark", 0, 2, 0.05, "×", body, "Sensor"),
      range("bodySharpen", "Sharpening", 0, 2, 0.05, "×", body, "Sensor"),
      range("bodyCompression", "Compression", 0, 1, 0.01, "×", body, "Sensor"),
      range("bodyColor", "Washed-out colour", 0, 1, 0.01, "×", body, "Sensor"),
      range("bodyRolling", "Rolling shutter", 0, 3, 0.05, "×", body, "Sensor"),
      range("bodyMotionBlur", "Shutter blur", 0, 1, 0.01, "×", body, "Sensor"),
    ] : []),
    range("phoneHdr", "HDR tone curve", 0, 1, 0.01, "×", phone, "Image"),
    range("phoneSharpen", "Sharpening halos", 0, 2, 0.05, "×", phone, "Image"),
    range("phoneNoise", "Sensor noise", 0, 2, 0.05, "×", phone, "Image"),
    range("phoneDenoise", "Denoise smear", 0, 1, 0.01, "×", phone, "Image"),
    range("phoneCompression", "Compression blocks", 0, 1, 0.01, "×", phone, "Image"),
    range("phoneFlare", "Green lens ghost", 0, 1, 0.01, "×", phone, "Image"),
    range("phoneExposure", "Exposure hunting", 0, 1, 0.01, "×", phone, "Auto"),
    range("phoneWhiteBalance", "White balance drift", 0, 1, 0.01, "×", phone, "Auto"),
    range("phoneFocus", "Focus hunting", 0, 1, 0.01, "×", phone, "Auto"),
    { ...key("phoneFps"), label: "Frame rate", group, subsection: "Motion", type: "select", options: [{ value: 24, label: "24 fps" }, { value: 30, label: "30 fps" }, { value: 60, label: "60 fps" }], visible: phone },
    range("phoneMotionBlur", "Shutter blur", 0, 1, 0.01, "×", phone, "Motion"),
    range("phoneRolling", "Rolling shutter", 0, 3, 0.05, "×", phone, "Motion"),
    range("phoneShake", "Handheld shake", 0, 1, 0.01, "×", phone, "Motion"),
    { ...key("phoneVertical"), label: "Vertical 9:16", group, subsection: "Motion", type: "toggle", visible: phone },
    range("vhsSoftness", "Luma softness", 0, 2, 0.05, "×", vhs, "Signal"),
    range("vhsChroma", "Chroma bleed", 0, 2, 0.05, "×", vhs, "Signal"),
    range("vhsSharpen", "Edge ringing", 0, 1, 0.01, "×", vhs, "Signal"),
    range("vhsColor", "Colour shift", 0, 2, 0.05, "×", vhs, "Signal"),
    range("vhsBloom", "Lifted blacks, bloom", 0, 1, 0.01, "×", vhs, "Signal"),
    range("vhsVignette", "Vignette, soft edges", 0, 1, 0.01, "×", vhs, "Signal"),
    range("vhsNoise", "Tape noise", 0, 2, 0.05, "×", vhs, "Tape"),
    range("vhsDropouts", "Dropouts", 0, 3, 0.05, "×", vhs, "Tape"),
    range("vhsTracking", "Tracking errors", 0, 2, 0.05, "×", vhs, "Tape"),
    range("vhsHeadSwitch", "Head-switch band", 0, 1, 0.01, "×", vhs, "Tape"),
    range("vhsInterlace", "Interlace", 0, 1, 0.01, "×", vhs, "Tape"),
    range("vhsRoll", "Hum bar", 0, 1, 0.01, "×", vhs, "Tape"),
    range("vhsYear", "Stamp year (0 today)", 0, 2026, 1, "", vhs, "Tape"),
  ]
}

/**
 * Screen motion of the image centre, in pixels per frame: where the content now at the centre sat in the previous
 * frame, reprojected through a point 10 m ahead. Rotation (the pans that skew and smear) dominates; walking adds none.
 * `cur`/`prev` hold a column-major viewProj at 0..15 and the eye at 16..18 (the renderer's frame layout).
 */
export function cameraFlow(cur: Float32Array, prev: Float32Array, width: number, height: number, inverse = new Float32Array(16)): [number, number] {
  mat4.inverse(cur.subarray(0, 16), inverse)
  const un = (z: number) => {
    const x = inverse[8]! * z + inverse[12]!, y = inverse[9]! * z + inverse[13]!, w = inverse[11]! * z + inverse[15]!
    return [x / w, y / w, (inverse[10]! * z + inverse[14]!) / w] as const
  }
  const a = un(0.2), b = un(0.8)
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
  if (!(len > 1e-6)) return [0, 0]
  const p = [0, 1, 2].map(i => cur[16 + i]! + ((b[i]! - a[i]!) / len) * 10)
  const cx = prev[0]! * p[0]! + prev[4]! * p[1]! + prev[8]! * p[2]! + prev[12]!
  const cy = prev[1]! * p[0]! + prev[5]! * p[1]! + prev[9]! * p[2]! + prev[13]!
  const cw = prev[3]! * p[0]! + prev[7]! * p[1]! + prev[11]! * p[2]! + prev[15]!
  if (!(cw > 1e-4)) return [0, 0]
  return [(-cx / cw) * width * 0.5, (cy / cw) * height * 0.5]
}

const COMMON = /* wgsl */ `
struct U {
  a: vec4f,  // width, height, time s, tick (1/60 s)
  b: vec4f,  // mode, strength, hold, reset
  c: vec4f,  // flow x/y px per s, dt s, seed
  d: vec4f,  // shake x/y px, shake roll rad, overlay on
  o: vec4f,  // phone overlay rect (uv x0 y0 x1 y1)
  p0: vec4f, // hdr, sharpen, noise, denoise
  p1: vec4f, // exposure hunt, white balance, focus hunt, rolling
  p2: vec4f, // motion blur, compression, flare, stabiliser zoom
  p3: vec4f, // crop x0, crop x1, shutter s, readout s
  v0: vec4f, // softness, chroma, noise, dropouts
  v1: vec4f, // tracking, head switch, interlace, colour
  v2: vec4f, // bloom, vignette, roll, sharpen
  c0: vec4f, // lines, scanline gaps, beam widening, sharpness
  c1: vec4f, // mask type, mask strength, mask cell px, curvature
  c2: vec4f, // bezel, convergence, glow, persistence
  c3: vec4f, // flicker, interlace, vignette, glass
  b0: vec4f, // fisheye, tan(half vertical fov), dirt, washed-out colour
  b1: vec4f, // vignette, -, -, -
}
@group(0) @binding(0) var<uniform> u: U;
struct V { @builtin(position) pos: vec4f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: V;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  return o;
}
fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn h3(x: u32, y: u32, z: u32) -> f32 {
  return f32(pcg(x ^ pcg(y ^ pcg(z ^ u32(u.c.w))))) / 4294967295.0;
}
fn hf(x: f32, y: f32, z: u32) -> f32 { return h3(bitcast<u32>(i32(floor(x))), bitcast<u32>(i32(floor(y))), z); }
fn vnoise1(x: f32, z: u32) -> f32 {
  let f = fract(x);
  return mix(hf(x, 0.0, z), hf(x + 1.0, 0.0, z), f * f * (3.0 - 2.0 * f));
}
fn vnoise2(p: vec2f, z: u32) -> f32 {
  let f = fract(p);
  let s = f * f * (3.0 - 2.0 * f);
  return mix(mix(hf(p.x, p.y, z), hf(p.x + 1.0, p.y, z), s.x), mix(hf(p.x, p.y + 1.0, z), hf(p.x + 1.0, p.y + 1.0, z), s.x), s.y);
}
fn lum(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn toLin(c: vec3f) -> vec3f {
  let x = clamp(c, vec3f(0.0), vec3f(1.0));
  return select(pow((x + 0.055) / 1.055, vec3f(2.4)), x / 12.92, x <= vec3f(0.04045));
}
fn toSrgb(c: vec3f) -> vec3f {
  let x = max(c, vec3f(0.0));
  return select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, x * 12.92, x <= vec3f(0.0031308));
}
`

const LOCAL_W = 48, LOCAL_H = 27
/** 2×1 rgba32float: texel 0 exposure (log2 gain, velocity) and focus (offset, velocity); texel 1 white balance gains and the remembered scene level. */
const STATE_WGSL = COMMON + /* wgsl */ `
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var prevState: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@fragment fn fs_state(v: V) -> @location(0) vec4f {
  // Centre-weighted metering on an 8×6 grid of the finished frame.
  var sw = 0.0;
  var sl = 0.0;
  var sc = vec3f(0.0);
  for (var j = 0; j < 6; j++) {
    for (var i = 0; i < 8; i++) {
      let uv = (vec2f(f32(i), f32(j)) + 0.5) / vec2f(8.0, 6.0);
      let c = toLin(textureSampleLevel(src, samp, uv, 0.0).rgb);
      let w = max(1.6 - length((uv - 0.5) * vec2f(1.0, 1.3)) * 1.8, 0.15);
      sl += log2(lum(c) + 0.002) * w;
      sc += c * w;
      sw += w;
    }
  }
  let level = sl / sw;
  let mean = sc / sw;
  let s0 = textureLoad(prevState, vec2i(0, 0), 0);
  let s1 = textureLoad(prevState, vec2i(1, 0), 0);
  let dt = clamp(u.c.z, 0.0, 0.1);
  let reset = u.b.w > 0.5;
  let k = u.b.y;
  // Auto exposure pulls the frame towards mid grey within the sensor's gain range; an underdamped spring overshoots
  // and settles back (the hunt) when the light changes.
  let aim = clamp(log2(0.1) - level, -1.5, 1.8) * 0.75;
  let hunt = u.p1.x * k;
  let zeta = mix(1.0, 0.28, hunt);
  let omega = mix(6.0, 2.4, hunt);
  var e = s0.x;
  var ev = s0.y;
  if (reset) { e = aim; ev = 0.0; } else {
    ev += (omega * omega * (aim - e) - 2.0 * zeta * omega * ev) * dt;
    e += ev * dt;
  }
  // Focus is knocked out while the scene differs from the remembered one (a light turns on, a fast pan); a
  // springy return racks through sharp and back out once or twice before it locks.
  let remembered = select(s1.w, level, reset);
  let change = smoothstep(0.3, 1.2, abs(level - remembered)) + smoothstep(1.0, 3.0, length(u.c.xy) / u.a.y);
  var f = s0.z;
  var fv = s0.w;
  if (reset) { f = 0.0; fv = 0.0; } else {
    fv += change * u.p1.z * k * 30.0 * dt;
    fv += (-90.0 * f - 2.0 * 0.22 * 9.5 * fv) * dt;
    f = clamp(f + fv * dt, -1.0, 1.0);
  }
  let slow = mix(remembered, level, 1.0 - exp(-dt / 0.6));
  // Grey-world white balance, partly corrected and late: walking into a lamp tints, then drifts back.
  let grey = lum(mean) / max(mean, vec3f(1e-4));
  let gainT = clamp(mix(vec3f(1.0), grey, 0.5 * u.p1.y * k), vec3f(0.6), vec3f(1.7));
  let was = select(s1.rgb, vec3f(1.0), reset || s1.r <= 0.0);
  let gains = mix(was, gainT, select(1.0 - exp(-dt / 1.3), 1.0, reset));
  if (v.pos.x < 1.0) { return vec4f(e, ev, f, fv); }
  return vec4f(gains, slow);
}
/** The frame's local mean on a coarse grid (6×6 taps per cell); sampled bilinearly it is a smooth neighbourhood level. */
@fragment fn fs_local(v: V) -> @location(0) vec4f {
  let cell = 1.0 / vec2f(${LOCAL_W}.0, ${LOCAL_H}.0);
  let base = floor(v.pos.xy) * cell;
  var c = vec3f(0.0);
  for (var j = 0; j < 6; j++) {
    for (var i = 0; i < 6; i++) {
      c += textureSampleLevel(src, samp, base + (vec2f(f32(i), f32(j)) + 0.5) * cell / 6.0, 0.0).rgb;
    }
  }
  return vec4f(c / 36.0, 1.0);
}
`

const MAIN_COMMON = COMMON + /* wgsl */ `
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var hist: texture_2d<f32>;
@group(0) @binding(3) var state: texture_2d<f32>;
@group(0) @binding(4) var overlay: texture_2d<f32>;
@group(0) @binding(5) var samp: sampler;
@group(0) @binding(6) var localMean: texture_2d<f32>;
struct Out { @location(0) color: vec4f, @location(1) hist: vec4f };
fn S(uv: vec2f) -> vec3f { return textureSampleLevel(src, samp, uv, 0.0).rgb; }
fn M(uv: vec2f) -> vec3f { return textureSampleLevel(localMean, samp, uv, 0.0).rgb; }
`

const PHONE_WGSL = MAIN_COMMON + /* wgsl */ `
fn shoulder(x: vec3f) -> vec3f { return select(x, 0.72 + 0.28 * (1.0 - exp(-(x - 0.72) / 0.28)), x > vec3f(0.72)); }
/** Exposure, then local exposure: dark neighbourhoods (ym) brightened, bright ones held back; black stays black. */
fn look(c: vec3f, gain: vec3f, ym: f32, hdr: f32) -> vec3f {
  let d = toSrgb(shoulder(toLin(c) * gain)) * clamp(pow(0.4 / max(ym, 0.03), 0.3 * hdr), 0.8, 1.3);
  return pow(max(d, vec3f(0.0)), vec3f(mix(1.0, 0.95, hdr)));
}
/** Equidistant fisheye from the wide rectilinear render: the angle grows with the radius, the corners stay the corners. */
fn fisheye(uv: vec2f, asp: f32, amount: f32) -> vec2f {
  let a = vec2f(asp, 1.0);
  let p = (uv - 0.5) * 2.0 * a;
  let rc = length(a);
  let r = max(length(p), 1e-5);
  let rs = tan(r / rc * atan(rc * u.b0.y)) / u.b0.y;
  return p * mix(1.0, rs / r, amount) / a * 0.5 + 0.5;
}
fn ui(c: vec3f, uv: vec2f) -> vec3f {
  if (u.d.w < 0.5) { return c; }
  let t = (uv - u.o.xy) / (u.o.zw - u.o.xy);
  if (any(t < vec2f(0.0)) || any(t > vec2f(1.0))) { return c; }
  let o = textureSampleLevel(overlay, samp, t, 0.0);
  return c * (1.0 - o.a) + o.rgb;
}
@fragment fn fs_phone(v: V) -> Out {
  let size = u.a.xy;
  let px = v.pos.xy;
  let uv = px / size;
  let ip = vec2i(px);
  var res: Out;
  if (uv.x < u.p3.x || uv.x > u.p3.y) {
    res.color = vec4f(0.0, 0.0, 0.0, 1.0);
    res.hist = res.color;
    return res;
  }
  // Between sensor frames (30 fps on a faster display) the last frame stays up.
  if (u.b.z > 0.5) {
    let h = textureLoad(hist, ip, 0).rgb;
    res.hist = vec4f(h, 1.0);
    res.color = vec4f(ui(h, uv), 1.0);
    return res;
  }
  let k = u.b.y;
  let s0 = textureLoad(state, vec2i(0, 0), 0);
  let s1 = textureLoad(state, vec2i(1, 0), 0);
  let focus = s0.z;
  // Lens: stabiliser crop, handheld roll and drift, focus breathing, rolling-shutter skew (lower rows read later).
  let asp = size.x / size.y;
  let fish = u.b0.x * k;
  var q = uv;
  if (fish > 0.001) { q = fisheye(uv, asp, fish); }
  q = (q - 0.5) * vec2f(asp, 1.0);
  let cr = cos(u.d.z);
  let sr = sin(u.d.z);
  q = vec2f(cr * q.x - sr * q.y, sr * q.x + cr * q.y) / (u.p2.w * (1.0 + focus * 0.012 * k));
  q = q / vec2f(asp, 1.0) + 0.5 + u.d.xy / size;
  q -= u.c.xy * u.p3.w * (q.y - 0.5) / size;
  let texel = 1.0 / size;
  // Shutter blur along the pan and the defocus disc while focus hunts.
  let streak = u.c.xy * u.p3.z * u.p2.x * k / size;
  let disc = abs(focus) * 9.0 * (size.y / 1080.0) * k;
  var c = vec3f(0.0);
  if (dot(streak * size, streak * size) > 1.0 || disc > 0.5) {
    for (var i = 0; i < 6; i++) {
      let t = (f32(i) + 0.5) / 6.0;
      let a = f32(i) * 2.39996;
      c += S(q + streak * (t - 0.5) + vec2f(cos(a), sin(a)) * sqrt(t) * disc * texel);
    }
    c /= 6.0;
  } else {
    c = S(q);
  }
  let d1 = vec2f(1.25, 0.0) * texel;
  let d2 = vec2f(0.0, 1.25) * texel;
  let near = (S(q + d1) + S(q - d1) + S(q + d2) + S(q - d2)) * 0.25;
  let wide = M(q);
  // Auto exposure and white balance act on light; the shoulder rolls off what the gain pushes past white.
  let gain = exp2(s0.x * k) * mix(vec3f(1.0), s1.rgb, k);
  let hdr = u.p0.x * k;
  let ym = lum(toSrgb(shoulder(toLin(wide) * gain)));
  let wideL = look(wide, gain, ym, hdr);
  var d = look(c, gain, ym, hdr);
  let nearL = look(near, gain, ym, hdr);
  let y0 = lum(d);
  // Computational HDR: local contrast pushed against the wide neighbourhood (the crunchy halos), a little more
  // colour, and blacks pinned back down.
  d = d + (d - wideL) * 0.5 * hdr;
  d = mix(vec3f(lum(d)), d, 1.0 + 0.12 * hdr);
  // Sharpening on luma: the bright/dark rims around edges.
  d += (y0 - lum(nearL)) * 1.7 * u.p0.y * k;
  d = max(d - 0.04 * hdr, vec3f(0.0)) / (1.0 - 0.04 * hdr);
  d = mix(d, d * d * (3.0 - 2.0 * d), 0.3 * hdr);
  // Sensor noise grows with the gain; the denoiser leaves it as soft grain and slow chroma blotches.
  let dark = 1.0 - smoothstep(0.02, 0.55, lum(d));
  let amount = u.p0.z * k * clamp(0.3 + max(s0.x * k, 0.0) * 0.6, 0.3, 1.6) * (0.2 + 0.8 * dark);
  let tt = u.a.z * 15.0;
  let tk = u32(tt);
  let tf = fract(tt);
  let ln = mix(vnoise2(px / 1.6, tk), vnoise2(px / 1.6, tk + 1u), tf) - 0.5;
  let cb = mix(vnoise2(px / 7.0, tk + 101u), vnoise2(px / 7.0, tk + 102u), tf) - 0.5;
  let crn = mix(vnoise2(px / 7.0 + 37.0, tk + 201u), vnoise2(px / 7.0 + 37.0, tk + 202u), tf) - 0.5;
  d += ln * 0.08 * amount + vec3f(1.4 * crn, -0.34 * cb - 0.71 * crn, 1.77 * cb) * 0.06 * amount;
  // Green ghost: the bright source reflected through the optical centre.
  let fl = u.p2.z * k;
  if (fl > 0.001) {
    let m = vec2f(1.0) - q;
    let g = toLin((S(m + d1 * 1.5) + S(m - d1 * 1.5)) * 0.5);
    d += vec3f(0.2, 0.95, 0.55) * smoothstep(0.7, 1.0, max(max(g.r, g.g), g.b)) * fl * 0.5;
  }
  // Body camera: smudges on the cover glass light up around bright sources, cheap sensor colour washes out and
  // greens the shadows, the wide lens darkens its corners.
  if (u.b.x > 3.5) {
    let a = vec2f(asp, 1.0);
    let glare = max(lum(toLin(wide) * gain) - 0.2, 0.0);
    let smudge = smoothstep(0.45, 0.85, vnoise2(uv * a * 3.0 + 5.0, 77u) * 0.6 + vnoise2(uv * a * 11.0, 78u) * 0.4) + 0.2;
    d += vec3f(1.0, 0.93, 0.8) * glare * smudge * u.b0.z * k * 0.6;
    let wash = u.b0.w * k;
    d = mix(vec3f(lum(d)), d, 1.0 - 0.65 * wash) + vec3f(-0.012, 0.01, 0.005) * wash * (1.0 - lum(d));
    d *= 1.0 - u.b1.x * k * 0.6 * smoothstep(0.3, 1.05, length((uv - 0.5) * a) / (0.5 * length(a)));
  }
  // Temporal denoise: dark areas lean on the previous frame, so they smear and trail when the view moves.
  if (u.b.w < 0.5) {
    let h = textureLoad(hist, ip, 0).rgb;
    d = mix(d, h, u.p0.w * k * 0.75 * (1.0 - smoothstep(0.03, 0.4, lum(d))));
  }
  // Compression: flat dark 8×8 blocks collapse to a banded block mean.
  let cmp = u.p2.y * k;
  if (cmp > 0.001) {
    let bc = (floor(px / 8.0) * 8.0 + 4.0) / size;
    let dcL = look(S(q + bc - uv), gain, ym, hdr);
    let dc = dcL + (dcL - wideL) * 0.5 * hdr;
    let yd = lum(d);
    let flatness = 1.0 - smoothstep(0.0, 0.06, abs(y0 - lum(nearL)) * 3.0 + abs(lum(dc) - yd));
    let levels = mix(26.0, 90.0, smoothstep(0.0, 0.45, yd));
    let banded = floor(dc * levels + 0.5) / levels + (d - dc) * 0.2;
    d = mix(d, banded, cmp * flatness * (1.0 - smoothstep(0.1, 0.45, yd)));
  }
  d = clamp(d, vec3f(0.0), vec3f(1.0));
  res.hist = vec4f(d, 1.0);
  res.color = vec4f(ui(d, uv), 1.0);
  return res;
}
`

const VHS_WGSL = MAIN_COMMON + /* wgsl */ `
fn yiq(c: vec3f) -> vec3f {
  return vec3f(dot(c, vec3f(0.299, 0.587, 0.114)), dot(c, vec3f(0.596, -0.274, -0.322)), dot(c, vec3f(0.211, -0.523, 0.312)));
}
fn rgb(c: vec3f) -> vec3f {
  return vec3f(c.x + 0.956 * c.y + 0.621 * c.z, c.x - 0.272 * c.y - 0.647 * c.z, c.x - 1.106 * c.y + 1.703 * c.z);
}
@fragment fn fs_vhs(v: V) -> Out {
  let size = u.a.xy;
  let px = v.pos.xy;
  var uv = px / size;
  let ip = vec2i(px);
  var res: Out;
  let k = u.b.y;
  let t = u.a.z;
  let tick = u32(u.a.w);
  // 480 visible lines; alternate fields sit half a line apart.
  let lines = 480.0;
  let line = floor(uv.y * lines);
  let lu = u32(line);
  let il = u.v1.z * k;
  uv.y += (f32(tick & 1u) - 0.5) * 0.5 / lines * il;
  // Time-base wobble, an intermittent tracking band crawling up, the head switch tearing the bottom lines right.
  let tr = u.v1.x * k;
  var dx = (vnoise1(line * 0.05 + t * 1.3, 1u) - 0.5) * 0.003 * tr + (h3(lu, tick, 3u) - 0.5) * 0.0008 * tr;
  let env = smoothstep(0.5, 0.85, vnoise1(t * 0.21 + 11.0, 2u)) * tr;
  let band = exp(-pow((uv.y - fract(0.9 - t * 0.04)) / 0.03, 2.0)) * min(env, 1.0);
  dx += band * (h3(lu, tick, 5u) - 0.3) * 0.06;
  let hs = smoothstep(0.976, 0.99, uv.y) * u.v1.y * k;
  dx += hs * (0.03 + 0.025 * h3(lu, tick, 7u));
  uv.x += dx;
  let r = length((uv - 0.5) * vec2f(size.x / size.y, 1.0));
  let edge = 1.0 + u.v2.y * k * 1.5 * r * r;
  // Luma: ~333 samples per line (3 MHz) with a touch of vertical softness.
  let lp = size.x / 333.0 * u.v0.x * k * edge / size.x;
  let ly = 0.35 / lines * k;
  // Three bilinear taps: the outer two straddle texels, so the kernel is wider than its tap count.
  let s0 = yiq(S(uv + vec2f(-0.7 * lp, -ly))).x;
  let s2 = yiq(S(uv + vec2f(0.0, ly))).x;
  let s4 = yiq(S(uv + vec2f(0.7 * lp, -ly))).x;
  var y = (s0 + 2.0 * s2 + s4) * 0.25;
  // Chroma: ~40 samples per line (colour-under), arriving late so colour smears right of its edges.
  let cw = size.x / 40.0 * u.v0.y * k / size.x;
  var iq = vec2f(0.0);
  var yw = 0.0;
  for (var i = 0; i < 4; i++) {
    let s = yiq(S(uv + vec2f(((f32(i) + 0.5) / 4.0 - 0.5) * cw - cw * 0.35, 0.0)));
    iq += s.yz;
    yw += s.x;
  }
  iq *= 0.25;
  yw *= 0.25;
  // Camcorder aperture correction rings a halo beside edges; highlights smear sideways.
  y += (y - 0.5 * (s0 + s4)) * u.v2.w * k * 1.2;
  let bl = u.v2.x * k;
  y += max(yw - 0.6, 0.0) * 0.8 * bl;
  // Colour: over-saturated, hue pulled towards red, a little warm.
  let col = u.v1.w * k;
  let a = 0.09 * col;
  iq = vec2f(cos(a) * iq.x - sin(a) * iq.y, sin(a) * iq.x + cos(a) * iq.y) * (1.0 + 0.4 * col) + vec2f(0.012, 0.0) * col;
  // Burned-in stamp, soft as the tape, its colour late like everything else.
  if (u.d.w > 0.5) {
    let o = textureSampleLevel(overlay, samp, uv, 0.0);
    y = y * (1.0 - o.a) + yiq(o.rgb).x;
    let oc = textureSampleLevel(overlay, samp, uv - vec2f(cw * 0.35, 0.0), 0.0);
    iq = iq * (1.0 - oc.a) + yiq(oc.rgb).yz;
  }
  // Tape noise: streaks stretched along the line, low-frequency chroma noise.
  let nz = u.v0.z * k;
  let cx = px.x / (size.x / 220.0);
  y += (mix(hf(cx, line, tick), hf(cx + 1.0, line, tick), fract(cx)) - 0.5) * 0.07 * nz + (hf(px.x, line, tick + 9u) - 0.5) * 0.03 * nz;
  let cc = px.x / (size.x / 26.0);
  let pair = floor(line * 0.5);
  iq += (vec2f(mix(hf(cc, pair, tick + 1u), hf(cc + 1.0, pair, tick + 1u), fract(cc)), mix(hf(cc, pair, tick + 2u), hf(cc + 1.0, pair, tick + 2u), fract(cc))) - 0.5) * 0.06 * nz;
  // Dropouts: oxide gaps flash as white streaks along a line, and the odd speck.
  let dp = u.v0.w * k;
  if (h3(lu, tick, 11u) > 1.0 - 0.006 * dp) {
    let s = (uv.x - h3(lu, tick, 12u)) / (0.01 + 0.12 * h3(lu, tick, 13u));
    if (s > 0.0 && s < 1.0) {
      let w = sin(s * 3.14159);
      y = mix(y, 1.0, w * 0.9);
      iq *= 1.0 - w;
    }
  }
  if (hf(px.x * 0.5, line, tick + 21u) > 1.0 - 0.00015 * dp) { y = 1.0; }
  y = mix(y, hf(px.x / 3.0, line, tick + 31u) * 1.1, band * 0.55);
  iq *= 1.0 - band * 0.8;
  y = mix(y, y * 0.6 + hf(px.x * 0.5, line, tick + 41u) * 0.5, hs * 0.8);
  iq *= 1.0 - hs * 0.7;
  // Levels: no true black on tape, whites crushed into a shoulder; hum bar and the occasional rolling line.
  y = 0.075 * bl + y * (1.0 - 0.075 * bl);
  y = mix(y, select(y, 0.7 + 0.24 * (1.0 - exp(-(y - 0.7) / 0.24)), y > 0.7), bl);
  let rl = u.v2.z * k;
  let hum = 0.5 + 0.5 * sin((uv.y + t * 0.11) * 6.28318);
  y *= 1.0 - rl * 0.08 * hum * hum;
  y += exp(-pow((fract(uv.y - t * 0.27) - 0.5) / 0.004, 2.0)) * rl * 0.12 * smoothstep(0.55, 0.8, vnoise1(t * 0.13 + 4.0, 3u));
  y *= 1.0 - u.v2.y * k * 0.45 * smoothstep(0.4, 1.05, r);
  var c = clamp(rgb(vec3f(y, iq)), vec3f(0.0), vec3f(1.0));
  res.hist = vec4f(c, 1.0);
  // Interlace: every other line is still the previous field, so motion combs.
  if (u.b.w < 0.5 && ((lu + tick) & 1u) == 1u) { c = mix(c, textureLoad(hist, ip, 0).rgb, il); }
  res.color = vec4f(c, 1.0);
  return res;
}
`
/**
 * CRT television. Technique after Timothy Lottes' public-domain CRT shader (tube warp, gaussian scanlines, the shadow
 * mask layout) with ideas documented for crt-royale and guest-advanced (beam width that grows with brightness,
 * halation, convergence); none of their GPL code. Light is handled at gamma 2 (a tube's response, and cheap).
 */
const CRT_WGSL = MAIN_COMMON + /* wgsl */ `
fn L(uv: vec2f) -> vec3f { let c = S(uv); return c * c; }
fn warp(uv: vec2f, k: f32) -> vec2f {
  let p = uv * 2.0 - 1.0;
  return p * vec2f(1.0 + p.y * p.y * 0.07 * k, 1.0 + p.x * p.x * 0.1 * k) * 0.5 + 0.5;
}
/** Phosphor layout in screen pixels: 0 aperture grille stripes, 1 slot mask (stripes cut into staggered slots), 2 shadow-mask dot triads. */
fn mask(px: vec2f, kind: f32, cell: f32, strength: f32) -> vec3f {
  let lo = 1.0 - 0.7 * strength;
  let hi = 1.0 + 0.4 * strength;
  let c = floor(px / cell);
  var phase = fract(c.x / 3.0);
  var gap = 1.0;
  if (kind > 1.5) {
    phase = fract((c.x + floor(c.y * 0.5) * 3.0) / 6.0);
  } else if (kind > 0.5) {
    let column = floor(c.x / 3.0);
    if (fract((c.y + (column % 2.0) * 2.0) / 4.0) < 0.24) { gap = lo; }
  }
  var m = vec3f(lo);
  if (phase < 0.333) { m.r = hi; } else if (phase < 0.666) { m.g = hi; } else { m.b = hi; }
  let mean = (hi + 2.0 * lo) / 3.0 * select(1.0, 0.75 + 0.25 * lo, kind > 0.5 && kind < 1.5);
  // Brighter drive makes up most of what the mask blocks; highlights clip and the mask fades in them, as on a tube.
  return m * gap * mix(1.0, 1.0 / mean, 0.85);
}
@fragment fn fs_crt(v: V) -> Out {
  let size = u.a.xy;
  let px = v.pos.xy;
  let uv = px / size;
  let ip = vec2i(px);
  let k = u.b.y;
  let asp = size.x / size.y;
  let a = vec2f(asp, 1.0);
  let tick = u32(u.a.w);
  var res: Out;
  let bz = u.c2.x * k;
  let w = (warp(uv, u.c1.w * k) - 0.5) * (1.0 + 0.05 * bz) + 0.5;
  // Rounded face of the tube inside the bezel (distances in half-heights).
  let rr = (0.02 + 0.16 * bz) * k;
  let dist = length(max(abs(w * 2.0 - 1.0) * a - (a - rr), vec2f(0.0))) - rr;
  let inside = 1.0 - smoothstep(-2.0 / size.y, 2.0 / size.y, dist);
  var tube = vec3f(0.0);
  if (inside > 0.0) {
    let lines = u.c0.x;
    let shift = f32(tick & 1u) * 0.5 * u.c3.y * k;
    let y = w.y * lines - 0.5 + shift;
    let row = floor(y);
    let f = y - row;
    let dx = 1.0 / (lines * asp);
    let soft = 1.0 - u.c0.w;
    let conv = u.c2.y * k;
    var beam = vec3f(0.0);
    var plain = vec3f(0.0);
    for (var j = 0; j < 2; j++) {
      let ly = (row + f32(j) + 0.5 - shift) / lines;
      let l = L(vec2f(w.x - dx, ly));
      let m = L(vec2f(w.x, ly));
      let r = L(vec2f(w.x + dx, ly));
      var col = m * (1.0 - 0.5 * soft) + (l + r) * 0.25 * soft;
      // Misconverged guns: red lands a little right, blue a little left.
      col.r = mix(col.r, r.r, conv);
      col.b = mix(col.b, l.b, conv);
      // Each line is a gaussian beam, wider where it is brighter; normalised so the average light is kept.
      let sigma = mix(vec3f(0.2), vec3f(0.5), clamp(sqrt(col) * u.c0.z * k, vec3f(0.0), vec3f(1.0)));
      let d = f - f32(j);
      beam += col * exp(-0.5 * d * d / (sigma * sigma)) / (sigma * 2.5066);
      plain += col * select(f, 1.0 - f, j == 0);
    }
    var c = mix(plain, beam, u.c0.y * k);
    // Halation: light scattered in the faceplate, a ring of near taps and the wide local mean.
    let g = u.c2.z * k;
    if (g > 0.001) {
      let r1 = vec2f(0.009 / asp, 0.009);
      let near = L(w + r1) + L(w - r1) + L(w + vec2f(r1.x, -r1.y)) + L(w - vec2f(r1.x, -r1.y));
      let far = M(w);
      let halo = near * 0.15 + far * far * 0.4;
      c += halo * g * 0.3 + max(halo - 0.45, vec3f(0.0)) * g * 0.8;
    }
    c *= mask(px, u.c1.x, u.c1.z, u.c1.y * k);
    // Filmed at a shutter that doesn't match the refresh: a soft dark band rolls down, the level jitters.
    let fl = u.c3.x * k;
    let band = fract(w.y - u.a.z * 0.37);
    c *= (1.0 + (h3(tick, 0u, 61u) - 0.5) * 0.05 * fl) * (1.0 - fl * 0.22 * smoothstep(0.0, 0.2, band) * (1.0 - smoothstep(0.2, 0.45, band)));
    // Phosphor persistence: bright light fades over a few frames.
    if (u.b.w < 0.5) {
      let h = textureLoad(hist, ip, 0).rgb;
      c = max(c, h * h * u.c2.w * k * 0.85);
    }
    res.hist = vec4f(sqrt(clamp(c, vec3f(0.0), vec3f(1.0))), 1.0);
    c *= 1.0 - u.c3.z * k * 0.6 * smoothstep(0.35, 1.15, length((w - 0.5) * 2.0 * vec2f(1.0, 0.85)));
    // Glass: off-black phosphor under room light, a window's highlight high on the left.
    let gl = u.c3.w * k;
    let hp = (w - vec2f(0.24, 0.2)) * a;
    c += (vec3f(0.006, 0.007, 0.008) + vec3f(0.05, 0.055, 0.06) * exp(-dot(hp, hp) * 10.0)) * gl;
    tube = c;
  } else {
    res.hist = vec4f(0.0, 0.0, 0.0, 1.0);
  }
  // Plastic bezel, catching a little of the picture near its edge.
  let bezel = vec3f(0.012, 0.0115, 0.011) + L(clamp(w, vec2f(0.01), vec2f(0.99))) * 0.05 * exp(-max(dist, 0.0) * 25.0);
  res.color = vec4f(sqrt(max(mix(bezel, tube, inside), vec3f(0.0))), 1.0);
  return res;
}
`
/** The filter's shaders, for validation. */
export const CAMERA_FILTER_WGSL = {
  state: STATE_WGSL,
  phone: PHONE_WGSL,
  vhs: VHS_WGSL,
  crt: CRT_WGSL,
}

const UNIFORM_FLOATS = 72
type Targets = { width: number; height: number; source: GPUTexture; sourceView: GPUTextureView; hist: [GPUTexture, GPUTexture]; histViews: [GPUTextureView, GPUTextureView] }

/** Camera filters as a renderer final pass. Construct once; `active` follows `settings.mode`. */
export class CameraFilter implements FinalPass {
  readonly settings: CameraFilterSettings
  private targets: Targets | null = null
  private state: [GPUTexture, GPUTexture] | null = null
  private stateViews: [GPUTextureView, GPUTextureView] | null = null
  private local: GPUTexture | null = null
  private localView: GPUTextureView | null = null
  private overlayTex: GPUTexture | null = null
  private overlayKey = ""
  private overlaySize: [number, number] = [0, 0]
  private canvas: OffscreenCanvas | HTMLCanvasElement | null = null
  private pipes: Partial<Record<"state" | "local" | "phone" | "vhs" | "crt", GPURenderPipeline>> = {}
  private mainLayout: GPUBindGroupLayout | null = null
  private stateLayout: GPUBindGroupLayout | null = null
  private sampler: GPUSampler | null = null
  private uniform: GPUBuffer | null = null
  private groups: { main: GPUBindGroup[]; state: GPUBindGroup[] } | null = null
  private readonly data = new Float32Array(UNIFORM_FLOATS)
  private readonly prev = new Float32Array(20)
  private readonly inverse = new Float32Array(16)
  private flow: [number, number] = [0, 0]
  private parity = 0
  private valid = false
  private lastMode: CameraFilterMode = "today"
  private lastTime = 0
  private lastFrameIndex = -1
  private recordStart = 0
  private stampEpoch = Date.now()
  private timer: { query: GPUQuerySet; resolve: GPUBuffer; read: GPUBuffer; pending: ((ms: number | null) => void)[]; busy: boolean } | null = null
  private measureNext: ((ms: number | null) => void)[] = []

  constructor(private readonly device: GPUDevice, private readonly format: GPUTextureFormat, settings: CameraFilterSettings = createCameraFilterSettings(), private readonly seed = 1987) {
    this.settings = settings
  }

  get active(): boolean {
    return familyOf(this.settings.mode) !== null
  }

  /** The texture the renderer composites into while a filter is on. */
  source(width: number, height: number): GPUTextureView {
    if (!this.targets || this.targets.width !== width || this.targets.height !== height) this.resize(width, height)
    return this.targets!.sourceView
  }

  /** Copies a CRT or body-cam preset onto the knobs (the panel's Preset row; automation). */
  preset(look: "crt" | "bodycam", id: string): boolean {
    return applyCameraFilterPreset(this.settings, look, id)
  }

  /** GPU time of the filter's own passes on the next filtered frame (null without timestamp queries). */
  measure(): Promise<number | null> {
    if (!this.device.features.has("timestamp-query")) return Promise.resolve(null)
    return new Promise(resolve => this.measureNext.push(resolve))
  }

  encode(encoder: GPUCommandEncoder, target: GPUTextureView, frame: Float32Array): void {
    const t = this.targets
    if (!t) return
    const s = this.settings
    const mode = familyOf(s.mode)
    if (!mode) return
    this.ensure(mode)
    const sensor = mode === "phone" || mode === "body"
    const time = frame[19]!
    const dt = time - this.lastTime
    const continuous = this.valid && s.mode === this.lastMode && dt >= 0 && dt < 0.25
    if (s.mode !== this.lastMode) { this.recordStart = time; this.stampEpoch = Date.now() }
    if (continuous && dt > 0) {
      const [fx, fy] = cameraFlow(frame, this.prev, t.width, t.height, this.inverse)
      const k = 1 - Math.exp(-dt / 0.04)
      this.flow[0] += (fx / dt - this.flow[0]) * k
      this.flow[1] += (fy / dt - this.flow[1]) * k
    } else if (!continuous) this.flow = [0, 0]
    this.prev.set(frame.subarray(0, 20))
    const fps = mode === "body" ? 30 : Number(s.phoneFps) || 30
    const frameIndex = Math.floor(time * fps)
    const hold = sensor && continuous && fps < 59 && frameIndex === this.lastFrameIndex
    if (!hold) this.lastFrameIndex = frameIndex
    this.paintOverlay(mode, time, t.width, t.height)
    this.pack(mode, frame, time, continuous ? dt : 0, hold, !continuous, t.width, t.height)
    this.device.queue.writeBuffer(this.uniform!, 0, this.data)
    const read = this.parity, write = 1 - read
    const timing = this.measureNext.length > 0 && !this.timer?.busy ? this.ensureTimer() : null
    let begun = false
    const begin = () => {
      if (!timing || begun) return {}
      begun = true
      return { beginningOfPassWriteIndex: 0 }
    }
    const small = (view: GPUTextureView, pipe: GPURenderPipeline) => {
      const ts = begin()
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
        timestampWrites: timing && "beginningOfPassWriteIndex" in ts ? { querySet: timing.query, ...ts } : undefined,
      })
      pass.setPipeline(pipe)
      pass.setBindGroup(0, this.groups!.state[read]!)
      pass.draw(3)
      pass.end()
    }
    if (sensor && !hold) small(this.stateViews![write], this.pipes.state!)
    // Held frame: carry the state forward untouched.
    else if (sensor) encoder.copyTextureToTexture({ texture: this.state![read] }, { texture: this.state![write] }, [2, 1])
    if (!hold && mode !== "vhs") small(this.localView!, this.pipes.local!)
    const main = encoder.beginRenderPass({
      colorAttachments: [
        { view: target, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } },
        { view: t.histViews[write], loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } },
      ],
      timestampWrites: timing ? { querySet: timing.query, ...begin(), endOfPassWriteIndex: 1 } : undefined,
    })
    main.setPipeline(this.pipes[sensor ? "phone" : mode]!)
    main.setBindGroup(0, this.groups!.main[read]!)
    main.draw(3)
    main.end()
    if (timing) {
      encoder.resolveQuerySet(timing.query, 0, 2, timing.resolve, 0)
      encoder.copyBufferToBuffer(timing.resolve, 0, timing.read, 0, 16)
      timing.pending = this.measureNext.splice(0)
      timing.busy = true
      // The renderer submits right after this call returns.
      queueMicrotask(() => void this.collect())
    }
    this.parity = write
    this.valid = true
    this.lastMode = s.mode
    this.lastTime = time
  }

  dispose(): void {
    this.targets?.source.destroy()
    this.targets?.hist.forEach(h => h.destroy())
    this.state?.forEach(s => s.destroy())
    this.local?.destroy()
    this.local = null
    this.overlayTex?.destroy()
    this.uniform?.destroy()
    this.targets = null
    this.state = null
    this.overlayTex = null
    this.groups = null
  }

  private ensureTimer() {
    this.timer ??= {
      query: this.device.createQuerySet({ type: "timestamp", count: 2 }),
      resolve: this.device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
      read: this.device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
      pending: [],
      busy: false,
    }
    return this.timer
  }

  private async collect() {
    const timer = this.timer!
    let ms: number | null = null
    try {
      await timer.read.mapAsync(GPUMapMode.READ)
      const stamps = new BigUint64Array(timer.read.getMappedRange())
      ms = Number(stamps[1]! - stamps[0]!) / 1e6
      timer.read.unmap()
      if (!(ms > 0 && ms < 1000)) ms = null
    } catch { ms = null }
    timer.busy = false
    for (const resolve of timer.pending.splice(0)) resolve(ms)
  }

  private resize(width: number, height: number) {
    const d = this.device
    this.targets?.source.destroy()
    this.targets?.hist.forEach(h => h.destroy())
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    const make = (label: string) => d.createTexture({ label, size: [width, height], format: this.format, usage })
    const source = make("camera filter source")
    const hist: [GPUTexture, GPUTexture] = [make("camera filter history a"), make("camera filter history b")]
    this.targets = { width, height, source, sourceView: source.createView(), hist, histViews: [hist[0].createView(), hist[1].createView()] }
    this.valid = false
    this.groups = null
  }

  private ensure(mode: Family) {
    const d = this.device
    if (!this.mainLayout) {
      const F = GPUShaderStage.FRAGMENT, FV = GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX
      this.mainLayout = d.createBindGroupLayout({ label: "camera filter", entries: [
        { binding: 0, visibility: FV, buffer: { type: "uniform" } },
        { binding: 1, visibility: F, texture: { sampleType: "float" } },
        { binding: 2, visibility: F, texture: { sampleType: "float" } },
        { binding: 3, visibility: F, texture: { sampleType: "unfilterable-float" } },
        { binding: 4, visibility: F, texture: { sampleType: "float" } },
        { binding: 5, visibility: F, sampler: { type: "filtering" } },
        { binding: 6, visibility: F, texture: { sampleType: "float" } },
      ] })
      this.stateLayout = d.createBindGroupLayout({ label: "camera filter state", entries: [
        { binding: 0, visibility: FV, buffer: { type: "uniform" } },
        { binding: 1, visibility: F, texture: { sampleType: "float" } },
        { binding: 2, visibility: F, texture: { sampleType: "unfilterable-float" } },
        { binding: 3, visibility: F, sampler: { type: "filtering" } },
      ] })
      this.sampler = d.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" })
      this.uniform = d.createBuffer({ label: "camera filter", size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    }
    if (!this.state) {
      const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST
      this.state = [0, 1].map(() => d.createTexture({ label: "camera filter state", size: [2, 1], format: "rgba32float", usage })) as [GPUTexture, GPUTexture]
      this.stateViews = [this.state[0].createView(), this.state[1].createView()]
      this.local = d.createTexture({ label: "camera filter local mean", size: [LOCAL_W, LOCAL_H], format: "rgba16float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING })
      this.localView = this.local.createView()
      this.groups = null
    }
    if (!this.overlayTex) this.overlayTex = d.createTexture({ size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT })
    const pipe = (key: "state" | "local" | "phone" | "vhs" | "crt", code: string, entry: string, layout: GPUBindGroupLayout, targets: GPUColorTargetState[]) => {
      if (this.pipes[key]) return
      const module = d.createShaderModule({ label: `camera filter ${key}`, code })
      this.pipes[key] = d.createRenderPipeline({ label: `camera filter ${key}`, layout: d.createPipelineLayout({ bindGroupLayouts: [layout] }), vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: entry, targets }, primitive: { topology: "triangle-list" } })
    }
    const targets = [{ format: this.format }, { format: this.format }]
    if (mode === "phone" || mode === "body") {
      pipe("state", CAMERA_FILTER_WGSL.state, "fs_state", this.stateLayout!, [{ format: "rgba32float" }])
      pipe("phone", CAMERA_FILTER_WGSL.phone, "fs_phone", this.mainLayout, targets)
    }
    if (mode !== "vhs") pipe("local", CAMERA_FILTER_WGSL.state, "fs_local", this.stateLayout!, [{ format: "rgba16float" }])
    if (mode === "vhs") pipe("vhs", CAMERA_FILTER_WGSL.vhs, "fs_vhs", this.mainLayout, targets)
    else if (mode === "crt") pipe("crt", CAMERA_FILTER_WGSL.crt, "fs_crt", this.mainLayout, targets)
    if (!this.groups) {
      const t = this.targets!, ov = this.overlayTex.createView(), stateViews = this.stateViews!
      this.groups = {
        main: [0, 1].map(i => d.createBindGroup({ layout: this.mainLayout!, entries: [
          { binding: 0, resource: { buffer: this.uniform! } },
          { binding: 1, resource: t.sourceView },
          { binding: 2, resource: t.histViews[i]! },
          // The main pass reads the state the state pass just wrote (the other half of the pair).
          { binding: 3, resource: stateViews[1 - i]! },
          { binding: 4, resource: ov },
          { binding: 5, resource: this.sampler! },
          { binding: 6, resource: this.localView! },
        ] })),
        state: [0, 1].map(i => d.createBindGroup({ layout: this.stateLayout!, entries: [
          { binding: 0, resource: { buffer: this.uniform! } },
          { binding: 1, resource: t.sourceView },
          { binding: 2, resource: stateViews[i]! },
          { binding: 3, resource: this.sampler! },
        ] })),
      }
    }
  }

  /** Repaints the overlay texture when its text or size changes (once a second at most). */
  private paintOverlay(mode: Family, time: number, width: number, height: number) {
    if (!this.settings.overlay || mode === "crt") return
    let w: number, h: number, key: string
    let stamp: { time: string; date: string } | null = null
    let body: { time: string; unit: string } | null = null
    let code = ""
    if (mode === "body") {
      h = 540
      w = Math.round((540 * width) / height)
      body = bodycamStamp(new Date(this.stampEpoch + (time - this.recordStart) * 1000), this.seed)
      key = `body ${w} ${body.time}`
    } else if (mode === "vhs") {
      h = 240
      w = Math.max(320, Math.round((240 * width) / height))
      stamp = vhsStamp(new Date(this.stampEpoch + (time - this.recordStart) * 1000), this.settings.vhsYear)
      key = `vhs ${w} ${stamp.time} ${stamp.date}`
    } else {
      w = 320
      h = 72
      code = phoneTimecode(time - this.recordStart)
      key = `phone ${code}`
    }
    if (key === this.overlayKey) return
    this.overlayKey = key
    this.canvas ??= typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : document.createElement("canvas")
    this.canvas.width = w
    this.canvas.height = h
    const ctx = this.canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
    if (!ctx) return
    ctx.clearRect(0, 0, w, h)
    if (body) {
      // Burned-in like the real units: plain bold capitals, white with a dark edge, top right. No brand.
      ctx.font = `700 ${Math.round(h * 0.034)}px ui-monospace, SFMono-Regular, Menlo, monospace`
      ctx.textAlign = "right"
      ctx.textBaseline = "top"
      ctx.lineJoin = "round"
      ctx.lineWidth = Math.max(2, h * 0.006)
      ctx.strokeStyle = "rgba(0,0,0,0.75)"
      ctx.fillStyle = "#f2f2f2"
      const x = w - h * 0.04
      for (const [i, text] of [body.time, body.unit].entries()) {
        const y = h * (0.035 + i * 0.045)
        ctx.strokeText(text, x, y)
        ctx.fillText(text, x, y)
      }
    } else if (stamp) {
      const scale = 2
      const draw = (text: string, x: number, y: number) => {
        ctx.fillStyle = "rgba(0,0,0,0.85)"
        layoutText(text, x + 1, y + 1, scale, (rx, ry, rw, rh) => ctx.fillRect(rx, ry, rw, rh))
        ctx.fillStyle = "#f4f4ec"
        layoutText(text, x, y, scale, (rx, ry, rw, rh) => ctx.fillRect(rx, ry, rw, rh))
      }
      draw("PLAY ▶", Math.round(w * 0.08), Math.round(h * 0.08))
      const right = Math.round(w * 0.92)
      draw(stamp.time, right - textWidth(stamp.time, scale), Math.round(h * 0.79))
      draw(stamp.date, right - textWidth(stamp.date, scale), Math.round(h * 0.87))
    } else {
      ctx.fillStyle = "rgba(0,0,0,0.42)"
      const r = h / 2
      ctx.beginPath()
      ctx.moveTo(r, 0); ctx.lineTo(w - r, 0); ctx.arc(w - r, r, r, -Math.PI / 2, Math.PI / 2); ctx.lineTo(r, h); ctx.arc(r, r, r, Math.PI / 2, Math.PI * 1.5)
      ctx.fill()
      ctx.fillStyle = "#ff3b30"
      ctx.beginPath(); ctx.arc(h * 0.62, r, h * 0.17, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = "#ffffff"
      ctx.font = `600 ${Math.round(h * 0.52)}px ui-monospace, SFMono-Regular, Menlo, monospace`
      ctx.textBaseline = "middle"
      ctx.fillText(code, h * 1.05, r + 1)
    }
    if (!this.overlayTex || this.overlaySize[0] !== w || this.overlaySize[1] !== h) {
      this.overlayTex?.destroy()
      this.overlayTex = this.device.createTexture({ size: [w, h], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT })
      this.overlaySize = [w, h]
      this.groups = null
      this.ensure(mode)
    }
    this.device.queue.copyExternalImageToTexture({ source: this.canvas }, { texture: this.overlayTex, premultipliedAlpha: true }, [w, h])
  }

  private pack(mode: Family, frame: Float32Array, time: number, dt: number, hold: boolean, reset: boolean, width: number, height: number) {
    const s = this.settings, k = Math.max(0, Math.min(1, s.strength)), u = this.data
    const seed = this.seed
    const body = mode === "body"
    const wave = (a: number, b: number, c: number, o: number) => Math.sin(time * a + o) * 0.6 + Math.sin(time * b + o * 1.7) * 0.3 + Math.sin(time * c + o * 2.3) * 0.1
    const shake = mode === "phone" ? s.phoneShake * k : 0
    const amp = 4 * shake * (height / 1080)
    const crop = mode === "phone" && s.phoneVertical ? Math.min(1, (height * 9) / 16 / width) : 1
    const x0 = 0.5 - crop / 2, x1 = 0.5 + crop / 2
    // Phone timer: top centre of the (cropped) frame. Body camera: the whole frame.
    const ph = 0.042, pw = (ph * height * (320 / 72)) / width
    const rect = body ? [0, 0, 1, 1] : [0.5 - pw / 2, 0.035, 0.5 + pw / 2, 0.035 + ph]
    // A perspective viewProj's second row is the view's up axis scaled by 1/tan(fov/2).
    const tanHalf = 1 / Math.max(1e-6, Math.hypot(frame[1]!, frame[5]!, frame[9]!))
    const fps = body ? 30 : Number(s.phoneFps) || 30
    const rolling = body ? s.bodyRolling : s.phoneRolling
    u.set([
      width, height, time, Math.floor(time * 60),
      mode === "phone" ? 1 : mode === "vhs" ? 2 : mode === "crt" ? 3 : 4, k, hold ? 1 : 0, reset ? 1 : 0,
      this.flow[0], this.flow[1], dt, seed,
      amp * wave(1.9, 3.7, 7.3, seed % 7), amp * wave(1.6, 3.1, 6.7, (seed % 11) + 3), 0.0025 * shake * wave(1.3, 2.9, 5.3, (seed % 5) + 1), s.overlay ? 1 : 0,
      ...rect,
      ...(body ? [0.3, s.bodySharpen, s.bodyNoise, 0.4] : [s.phoneHdr, s.phoneSharpen, s.phoneNoise, s.phoneDenoise]),
      ...(body ? [s.bodyExposure, 0.35, 0, rolling] : [s.phoneExposure, s.phoneWhiteBalance, s.phoneFocus, rolling]),
      ...(body ? [s.bodyMotionBlur, s.bodyCompression, 0, 1 + 0.01 * k] : [s.phoneMotionBlur, s.phoneCompression, s.phoneFlare, 1 + 0.035 * k]),
      x0, x1, 1 / (2 * fps), 0.012 * rolling * k,
      s.vhsSoftness, s.vhsChroma, s.vhsNoise, s.vhsDropouts,
      s.vhsTracking, s.vhsHeadSwitch, s.vhsInterlace, s.vhsColor,
      s.vhsBloom, s.vhsVignette, s.vhsRoll, s.vhsSharpen,
      s.crtLines, s.crtScanlines, s.crtBeam, s.crtSharpness,
      Number(s.crtMask), s.crtMaskStrength, Math.max(1, Math.round(height / 1080)), s.crtCurvature,
      s.crtBezel, s.crtConvergence, s.crtGlow, s.crtPersistence,
      s.crtFlicker, s.crtInterlace, s.crtVignette, s.crtGlass,
      body ? s.bodyFisheye : 0, tanHalf, s.bodyDirt, s.bodyColor,
      s.bodyVignette, 0, 0, 0,
    ])
  }
}

/**
 * Camera filter on a game's renderer and Backquote panel; `?camera=<mode>[-<preset>]` starts with one on. Pass the
 * game's `FirstPerson` as `bodycam` to offer the body camera, whose rig then moves that camera's view.
 */
export function attachCameraFilter(renderer: Renderer, panel: LabPanel, device: GPUDevice, format: GPUTextureFormat, options: { params?: URLSearchParams; bodycam?: FirstPerson } = {}): CameraFilter {
  const { params = new URLSearchParams(location.search), bodycam } = options
  const filter = new CameraFilter(device, format, createCameraFilterSettings(params, {}, { bodycam: Boolean(bodycam) }))
  const s = filter.settings
  renderer.setFinalPass(filter)
  const onPreset = (look: "crt" | "bodycam", id: string) => {
    if (filter.preset(look, id)) queueMicrotask(() => panel.sync())
  }
  panel.addControls(s as unknown as Record<string, string | number | boolean>, cameraFilterControls({ bodycam: Boolean(bodycam), onPreset }), { ...CAMERA_FILTER_DEFAULTS })
  if (bodycam) {
    const rig = new BodycamRig()
    const previous = bodycam.rig
    bodycam.rig = (camera, dt, aspect) => {
      previous?.(camera, dt, aspect)
      rig.step(camera, dt, aspect, { lens: s.bodyLens, mount: s.bodyMount, sway: s.bodySway, lag: s.bodyLag, bob: s.bodyBob }, s.strength, s.mode === "bodycam")
    }
  }
  Object.assign(globalThis, { cameraFilter: filter })
  return filter
}
