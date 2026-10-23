import type { LabControl, LabSettings } from "../../lab-panel"

/**
 * Settings, presets, Lab rows and the pure parts (power and degauss timelines, uniform packing) of the shared screen
 * display (`display.ts`): a CRT tube or a cheaper LCD panel showing any texture, video or canvas, on a quad in the
 * world or full screen. Everything here is deterministic in time so co-op clients, replays and paired captures agree.
 */
export type ScreenKind = "crt" | "lcd"
export type ScreenLightShape = "panel" | "spot"

export const SCREEN_DISPLAY_DEFAULTS = {
  kind: "crt" as ScreenKind,
  preset: "tv",
  /** On or off; a change runs the power-on or power-off animation. */
  power: true,
  /** Peak white, in scene units (1 is the brightness of a lit white wall at Today's exposure). */
  brightness: 2.4,
  /** 0 clean picture, 1 nothing but snow (aerial unplugged). */
  snow: 0,
  /** Runs the degauss coil on every power-on, as most sets with auto-degauss did. */
  autoDegauss: true,

  // Tube
  /** 0 aperture grille, 1 slot mask, 2 shadow mask (delta dots), 3 none (monochrome tube). */
  mask: 2,
  maskStrength: 0.65,
  /** Phosphor triads across the visible width (a 20" set at 0.6 mm pitch has about 650). */
  maskPitch: 420,
  /** Visible scanlines per field. */
  lines: 240,
  /** How dark the gaps between scanlines are. */
  scanlines: 0.6,
  /** How much a bright line's beam widens and fills its gap. */
  beam: 0.6,
  /** Horizontal sharpness of the signal (video bandwidth). */
  sharpness: 0.45,
  /** How far the raster bows (pincushion) on the curved tube. */
  curvature: 0.5,
  /** Red and blue guns landing off the green, worst in the corners. */
  convergence: 0.35,
  /** Halation and bloom in the faceplate. */
  glow: 0.45,
  /** Phosphor afterglow: bright moving things leave a short trail. */
  persistence: 0.3,
  vignette: 0.45,
  /** Picture beyond the visible face, each side. */
  overscan: 0.03,
  /** Rounded corners of the visible face, as a fraction of its height. */
  corner: 0.08,

  // Glass
  /** Reflections on the faceplate (lamps, the room). 0 is a matte anti-glare coating. */
  glass: 1,
  /** Grey of the phosphor face when lit by the room (the "black" of an off screen). */
  faceGrey: 0.05,
  /** Forward bulge of the glass at its centre, in metres (3D quads only). */
  bulge: 0.018,
  /** The room, lit by the screen itself, reflected faintly in the dark glass. */
  roomReflection: 0.7,
  /** Fingerprints and dust that roughen the reflection. */
  smudge: 0.3,

  // Signal
  /** Plays the picture through the kit's VHS camera filter first (tracking, head switch, chroma bleed). */
  vhs: false,
  vhsAmount: 0.75,

  // LCD
  /** Pixels across the panel's width. */
  lcdPixels: 640,
  /** How visible the black matrix between pixels is up close. */
  lcdGrid: 0.6,
  /** Backlight bleeding at the edges, seen in dark scenes. */
  lcdBleed: 0.4,
  /** Contrast and gamma lost at oblique angles. */
  lcdAngle: 0.6,

  // Light
  /** The screen as a light: × its live average colour and brightness. 1 is physical (a wall 2 m away gets about 1/150
   * of the picture); dark-room scenes use more, as an eye adapted to the room would see it. */
  light: 1,
  lightShape: "panel" as ScreenLightShape,
  /** How far the screen's light reaches (m). */
  lightRange: 6,
}
export type ScreenDisplaySettings = typeof SCREEN_DISPLAY_DEFAULTS

type PresetValues = Partial<Omit<ScreenDisplaySettings, "preset" | "power">>
export const SCREEN_PRESETS: Record<string, { label: string; values: PresetValues }> = {
  tv: { label: "Living-room TV (shadow mask)", values: {} },
  pvm: { label: "Studio monitor (aperture grille)", values: { mask: 0, maskStrength: 0.7, maskPitch: 600, lines: 288, scanlines: 0.85, beam: 0.55, sharpness: 0.85, curvature: 0.18, convergence: 0.08, glow: 0.22, persistence: 0.15, vignette: 0.2, overscan: 0.015, corner: 0.04, bulge: 0.008, faceGrey: 0.03 } },
  arcade: { label: "Arcade cabinet (slot mask)", values: { mask: 1, maskStrength: 0.7, maskPitch: 330, lines: 224, scanlines: 0.75, beam: 0.8, sharpness: 0.6, curvature: 0.45, convergence: 0.3, glow: 0.7, persistence: 0.3, vignette: 0.35, brightness: 2.8 } },
  portable: { label: "Kitchen portable", values: { mask: 2, maskStrength: 0.5, maskPitch: 260, lines: 200, scanlines: 0.45, beam: 0.5, sharpness: 0.18, curvature: 0.9, convergence: 0.85, glow: 0.4, persistence: 0.4, vignette: 0.8, overscan: 0.05, corner: 0.14, bulge: 0.03, brightness: 1.8 } },
  terminal: { label: "Terminal (monochrome)", values: { mask: 3, maskStrength: 0, lines: 350, scanlines: 0.5, beam: 0.7, sharpness: 0.7, curvature: 0.35, convergence: 0, glow: 0.8, persistence: 0.75, vignette: 0.4, corner: 0.1, bulge: 0.012 } },
  lcd: { label: "LCD monitor", values: { kind: "lcd", lcdPixels: 640, lcdGrid: 0.6, lcdBleed: 0.4, lcdAngle: 0.6, persistence: 0.12, glow: 0.08, curvature: 0, bulge: 0, corner: 0.01, overscan: 0, faceGrey: 0.012, glass: 0.35, smudge: 0.15, brightness: 2.2 } },
}
export type ScreenPreset = keyof typeof SCREEN_PRESETS

export function createScreenDisplaySettings(overrides: Partial<ScreenDisplaySettings> = {}): ScreenDisplaySettings {
  const s = { ...SCREEN_DISPLAY_DEFAULTS }
  if (overrides.preset) applyScreenPreset(s, overrides.preset)
  return Object.assign(s, overrides)
}

/** Resets every look value to the defaults, then applies the preset's. Power and the light stay as they are. */
export function applyScreenPreset(settings: ScreenDisplaySettings, id: string): boolean {
  const preset = SCREEN_PRESETS[id]
  if (!preset) return false
  const { power, light, lightShape, lightRange, snow, vhs, vhsAmount, autoDegauss } = settings
  Object.assign(settings, SCREEN_DISPLAY_DEFAULTS, preset.values, { preset: id, power, light, lightShape, lightRange, snow, vhs, vhsAmount, autoDegauss })
  return true
}

export type ScreenControlOptions = {
  group?: string
  prefix?: string
  onPreset?: (id: string) => void
  onDegauss?: () => void
}

/** Typed Lab rows for one display: preset and power first, then Tube / Glass / Signal / LCD / Light. */
export function screenDisplayControls(options: ScreenControlOptions = {}): LabControl[] {
  const { group = "Screen", prefix = "screen.", onPreset, onDegauss } = options
  const key = (k: keyof ScreenDisplaySettings) => ({ key: prefix + k, ...(prefix ? { field: k } : {}) })
  const crt = (s: Readonly<LabSettings>) => s[prefix + "kind"] !== "lcd"
  const lcd = (s: Readonly<LabSettings>) => s[prefix + "kind"] === "lcd"
  const range = (k: keyof ScreenDisplaySettings, label: string, min: number, max: number, step: number, unit: string, subsection: string, visible?: (s: Readonly<LabSettings>) => boolean): LabControl => ({
    ...key(k), label, group, subsection, min, max, step, unit, ...(visible ? { visible } : {}),
  })
  return [
    { ...key("preset"), label: "Display", group, type: "select", options: Object.entries(SCREEN_PRESETS).map(([value, p]) => ({ value, label: p.label })), change: v => onPreset?.(String(v)) },
    { ...key("power"), label: "Power", group, type: "toggle" },
    ...(onDegauss ? [{ key: prefix + "degauss", label: "Degauss", group, type: "action", run: () => onDegauss() } as LabControl] : []),
    range("brightness", "Peak white", 0, 8, 0.05, "×", ""),
    range("snow", "Signal lost (snow)", 0, 1, 0.01, "×", ""),
    { ...key("kind"), label: "Kind", group, subsection: "Tube", type: "select", options: [{ value: "crt", label: "CRT" }, { value: "lcd", label: "LCD" }] },
    { ...key("mask"), label: "Phosphor mask", group, subsection: "Tube", type: "select", options: [{ value: 0, label: "Aperture grille" }, { value: 1, label: "Slot mask" }, { value: 2, label: "Shadow mask" }, { value: 3, label: "None (monochrome)" }], visible: crt },
    range("maskStrength", "Mask strength", 0, 1, 0.01, "×", "Tube", crt),
    range("maskPitch", "Triads across", 120, 1000, 10, "", "Tube", crt),
    range("lines", "Scanlines", 120, 600, 1, "lines", "Tube", crt),
    range("scanlines", "Scanline gaps", 0, 1, 0.01, "×", "Tube", crt),
    range("beam", "Beam widens when bright", 0, 1, 0.01, "×", "Tube", crt),
    range("sharpness", "Horizontal sharpness", 0, 1, 0.01, "×", "Tube"),
    range("curvature", "Raster bow", 0, 1, 0.01, "×", "Tube", crt),
    range("convergence", "Convergence error", 0, 1, 0.01, "×", "Tube", crt),
    range("glow", "Halation, bloom", 0, 1, 0.01, "×", "Tube"),
    range("persistence", "Phosphor afterglow", 0, 1, 0.01, "×", "Tube"),
    range("vignette", "Vignette", 0, 1, 0.01, "×", "Tube"),
    range("overscan", "Overscan", 0, 0.1, 0.005, "×", "Tube", crt),
    range("corner", "Rounded corners", 0, 0.25, 0.005, "×", "Tube"),
    range("lcdPixels", "Pixels across", 160, 1920, 8, "px", "LCD", lcd),
    range("lcdGrid", "Pixel grid", 0, 1, 0.01, "×", "LCD", lcd),
    range("lcdBleed", "Backlight bleed", 0, 1, 0.01, "×", "LCD", lcd),
    range("lcdAngle", "Viewing-angle loss", 0, 1, 0.01, "×", "LCD", lcd),
    range("glass", "Reflections", 0, 1.5, 0.01, "×", "Glass"),
    range("roomReflection", "Room in the dark glass", 0, 2, 0.01, "×", "Glass"),
    range("faceGrey", "Face grey", 0, 0.15, 0.002, "", "Glass"),
    range("bulge", "Glass bulge", 0, 0.05, 0.001, "m", "Glass"),
    range("smudge", "Smudges", 0, 1, 0.01, "×", "Glass"),
    { ...key("autoDegauss"), label: "Degauss on power-on", group, subsection: "Signal", type: "toggle", visible: crt },
    { ...key("vhs"), label: "Play through VHS", group, subsection: "Signal", type: "toggle" },
    range("vhsAmount", "VHS wear", 0, 1, 0.01, "×", "Signal", s => s[prefix + "vhs"] === true),
    range("light", "Screen light", 0, 16, 0.1, "×", "Light"),
    { ...key("lightShape"), label: "Light shape", group, subsection: "Light", type: "select", options: [{ value: "panel", label: "Area panel (exact diffuse)" }, { value: "spot", label: "Cosine spot (any light model)" }] },
    range("lightRange", "Light reach", 1, 15, 0.25, "m", "Light"),
  ]
}

// ---------------------------------------------------------------- power and degauss

/** What the power animation does to the tube this instant. */
export type PowerSample = {
  /** Raster width and height (1 full; the beam collapses toward 0). */
  rasterX: number
  rasterY: number
  /** Beam current: 0 dark, 1 warmed up. */
  level: number
  /** The bright spot left at the centre when the raster has collapsed. */
  dot: number
}
const clamp01 = (x: number) => Math.max(0, Math.min(1, x))
const easeOut = (x: number) => 1 - (1 - clamp01(x)) ** 3
const easeIn = (x: number) => clamp01(x) ** 2
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const OFF: PowerSample = { rasterX: 0.004, rasterY: 0.003, level: 0, dot: 0 }
const ON: PowerSample = { rasterX: 1, rasterY: 1, level: 1, dot: 0 }

/**
 * Power on and off as a pure timeline from the moment of the last switch, starting from wherever the previous one had
 * got to (switching mid-animation never jumps). A CRT turns on as a bright line that opens into the picture while the
 * cathodes warm; it turns off by collapsing to a line, then to a dot that cools away (lights cool, never cut). An LCD's
 * backlight fades. Reduced motion keeps only short fades.
 */
export class ScreenPower {
  on: boolean
  private at = -1e9
  private from: PowerSample

  constructor(on = true) {
    this.on = on
    this.from = on ? { ...ON } : { ...OFF }
  }

  /** Switch at `time` (s). Returns true when this was a change. */
  set(on: boolean, time: number, kind: ScreenKind = "crt", reduce = false): boolean {
    if (on === this.on) return false
    this.from = this.sample(time, kind, reduce)
    this.on = on
    this.at = time
    return true
  }

  /** Jump straight to on or off, no animation (first frame, scene loads). */
  reset(on: boolean): void {
    this.on = on
    this.at = -1e9
    this.from = on ? { ...ON } : { ...OFF }
  }

  /** Seconds since the last switch. */
  since(time: number): number {
    return time - this.at
  }

  sample(time: number, kind: ScreenKind = "crt", reduce = false): PowerSample {
    const t = Math.max(0, time - this.at)
    const f = this.from
    if (reduce || kind === "lcd") {
      // A fade only: LCD backlights and reduced motion. Exits run shorter than entrances.
      const k = this.on ? easeOut(t / (reduce ? 0.2 : 0.35)) : easeIn(t / (reduce ? 0.16 : 0.25))
      const target = this.on ? 1 : 0
      return { rasterX: 1, rasterY: 1, level: lerp(f.level, target, k), dot: 0 }
    }
    if (this.on) {
      // The high-voltage click, then a line that opens over a third of a second while the cathodes warm.
      const open = easeOut((t - 0.06) / 0.32)
      const wide = easeOut((t - 0.02) / 0.12)
      const warm = 1 - Math.exp(-Math.max(0, t - 0.04) / 0.55)
      return {
        rasterX: lerp(Math.max(f.rasterX, OFF.rasterX), 1, wide),
        rasterY: lerp(Math.max(f.rasterY, OFF.rasterY), 1, open),
        level: lerp(f.level, 1, warm),
        dot: f.dot * Math.exp(-t / 0.08),
      }
    }
    // Off: the field collapses first (a bright line), then the line shrinks to a dot that cools.
    const fold = easeIn(t / 0.09)
    const shrink = easeIn((t - 0.07) / 0.14)
    const cool = t < 0.2 ? 1 : Math.exp(-(t - 0.2) / 0.42)
    const rasterX = lerp(f.rasterX, OFF.rasterX, shrink)
    return {
      rasterX,
      rasterY: lerp(f.rasterY, OFF.rasterY, fold),
      level: f.level * cool,
      dot: f.level * cool * clamp01((t - 0.12) / 0.08),
    }
  }
}

/**
 * The degauss coil's envelope `seconds` after it fires: `wobble` shakes the raster (the thunk), `purity` is the
 * rainbow blotching that swirls and settles. Reduced motion keeps the colour, not the shake.
 */
export function degaussEnvelope(seconds: number, reduce = false): { wobble: number; purity: number } {
  if (!(seconds >= 0) || seconds > 4) return { wobble: 0, purity: 0 }
  const wobble = reduce ? 0 : Math.exp(-seconds / 0.3) * clamp01(seconds / 0.02)
  const purity = Math.exp(-seconds / 0.85) * clamp01(seconds / 0.06)
  return { wobble, purity }
}

/** Per-frame phosphor decay factors (r, g, b) for `persistence` 0..1 at frame step `dt`: red phosphors linger. */
export function persistenceDecay(persistence: number, dt: number, kind: ScreenKind = "crt"): [number, number, number] {
  if (persistence <= 0 || dt <= 0) return [0, 0, 0]
  const tau = persistence * (kind === "lcd" ? 0.05 : 0.11)
  const rgb = kind === "lcd" ? [1, 1, 1] : [1.35, 1, 0.8]
  return rgb.map(k => Math.exp(-dt / (tau * k!))) as [number, number, number]
}

// ---------------------------------------------------------------- uniform

/** `Display` uniform layout, in vec4s (see `wgsl.ts`). */
export const DISPLAY_UNIFORM_FLOATS = 13 * 4

export type DisplayFrame = {
  time: number
  dt: number
  power: PowerSample
  degauss: { wobble: number; purity: number }
  degaussTime: number
  signalWidth: number
  signalHeight: number
  sourceLinear: boolean
  /** Source uv = signal uv × scale + offset (fit). */
  fit: readonly [number, number, number, number]
  /** Visible face width / height. */
  aspect: number
  /** Average emitted radiance (linear rgb, scene units) for the room reflection. */
  light: readonly [number, number, number]
}

export function packDisplayUniform(s: ScreenDisplaySettings, f: DisplayFrame, out = new Float32Array(DISPLAY_UNIFORM_FLOATS)): Float32Array {
  const lcd = s.kind === "lcd"
  const decay = persistenceDecay(s.persistence, f.dt, s.kind)
  out.set([f.time, f.dt, lcd ? 1 : 0, s.brightness * f.power.level], 0)
  out.set([f.signalWidth, f.signalHeight, f.sourceLinear ? 1 : 0, 1 - s.snow], 4)
  out.set(f.fit, 8)
  out.set([s.lines, s.scanlines, s.beam, s.sharpness], 12)
  out.set([s.mask, s.mask === 3 ? 0 : s.maskStrength, s.maskPitch, lcd ? 0 : s.curvature], 16)
  out.set([lcd ? 0 : s.convergence, s.glow, s.vignette, lcd ? 0 : s.overscan], 20)
  out.set([s.corner, f.aspect, 0, 0], 24)
  out.set([s.glass, s.faceGrey, s.bulge, s.roomReflection], 28)
  out.set([f.power.rasterX, f.power.rasterY, f.power.dot * s.brightness, f.power.level], 32)
  out.set([f.degauss.wobble, f.degauss.purity, f.degaussTime, 0], 36)
  out.set([s.lcdGrid, s.lcdBleed, s.lcdAngle, s.lcdPixels], 40)
  out.set([decay[0], decay[1], decay[2], s.smudge], 44)
  out.set([f.light[0], f.light[1], f.light[2], 0], 48)
  return out
}

/** Source uv scale and offset so a source of `sw`×`sh` covers (crops to) a signal of aspect `aspect`. */
export function coverFit(sw: number, sh: number, aspect: number): [number, number, number, number] {
  const src = sw / Math.max(1, sh)
  if (!(src > 0) || !(aspect > 0)) return [1, 1, 0, 0]
  if (src > aspect) {
    const k = aspect / src
    return [k, 1, (1 - k) / 2, 0]
  }
  const k = src / aspect
  return [1, k, 0, (1 - k) / 2]
}
