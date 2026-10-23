import { MAT, type Mesh, type Rgb } from "../mesh"
import type { SceneLight } from "../scene-frame"
import { hash01, lampFlicker } from "./flicker"

/**
 * Practical light fixtures as small presets: a failing fluorescent tube, a caged incandescent bulb and LED
 * indicators. Each is pure in (time, seed), like `lampFlicker`, so every client and replay agrees, and gives one frame's
 * `SceneLight`, the brightness for its emissive mesh (a `MAT.lamp` slot's `lampPower`) and, for the tube, the ballast
 * hum's level for the game's audio. Light units follow the kit's physical model (`power × GAIN` is intensity).
 */
export type FixtureModel = "physical" | "today"

export type FixtureSample = {
  /** The fixture's light this frame (null while dark). */
  light: SceneLight | null
  /** `lampPower` for its `MAT.lamp` mesh: emission is `colour × (0.05 + 3.6 × this)`. */
  emissive: number
  /** 0..1 loudness of the fixture's own sound (the tube's ballast hum and buzz); 0 when silent. */
  hum: number
}

type Vec3 = readonly [number, number, number]

// ---------------------------------------------------------------- fluorescent tube

export type FluorescentTube = {
  /** Tube centre (world metres). */
  at: Vec3
  /** Tube length (m); a 4 ft T8 is 1.2. */
  length: number
  /** Rotates the tube's axis from +x toward +z. */
  yaw?: number
  seed: number
  /** On-axis intensity factor (kit power units). */
  power?: number
  /** Shared flicker amount: 0 a healthy tube, 1 failing, 2 failing twice as often. */
  failing?: number
  /** Cool white by default (about 4100 K, a little green). */
  color?: Rgb
  id?: number
}

const TUBE_WHITE: Rgb = [0.86, 1, 0.93]

/** A ceiling tube: a long downward panel under Physical (exact diffuse, `physicalLightHooks({ rect: true })`), a soft point under Today. */
export function fluorescentTube(t: FluorescentTube, time: number, model: FixtureModel = "physical"): FixtureSample {
  const f = lampFlicker("fluorescent", t.seed, time, t.failing ?? 1)
  const level = Math.max(0, f.level)
  // The ballast hums while powered and buzzes louder as the tube struggles to strike.
  const struggling = level < 0.9 ? 1 - level : 0
  const hum = Math.min(1, 0.45 + 0.55 * struggling)
  if (level < 0.005) return { light: null, emissive: level, hum }
  const yaw = t.yaw ?? 0
  const base: SceneLight = {
    x: t.at[0], y: t.at[2], h: t.at[1] - 0.02, r: 7, color: t.color ?? TUBE_WHITE, power: (t.power ?? 1) * level, size: t.length * 0.5,
    ...(t.id !== undefined ? { id: t.id } : {}),
  }
  if (model === "today") return { light: base, emissive: level, hum }
  // The panel's power is its on-axis intensity: a 1.2 m T8 gives about 300 cd straight down.
  return { light: { ...base, power: base.power * t.length * 0.9, rect: { halfWidth: t.length / 2, halfLength: 0.03, yaw } }, emissive: level, hum }
}

/** A batten: the steel channel and the opal tube, its tube on lamp slot `slot` (`MAT.lamp`). */
export function fluorescentTubeMesh(m: Mesh, t: FluorescentTube, slot: number): void {
  const [x, y, z] = t.at
  const yaw = t.yaw ?? 0
  m.yawBox(x, z, t.length + 0.06, 0.09, y + 0.025, y + 0.07, yaw, [0.62, 0.62, 0.6], MAT.lit)
  m.yawBox(x, z, t.length, 0.035, y - 0.012, y + 0.025, yaw, t.color ?? TUBE_WHITE, MAT.lamp, slot)
}

// ---------------------------------------------------------------- caged bulb

export type CagedBulb = {
  at: Vec3
  seed: number
  power?: number
  /** Brown-out wander: 0 steady, 1 a tired circuit. */
  wander?: number
  /** Warm tungsten (about 2700 K). */
  color?: Rgb
  id?: number
}

const TUNGSTEN: Rgb = [1, 0.6, 0.3]

/** A bare bulb in a wire cage: a small hot point, so shadows are crisp; it dims and warms a little as it wanders. */
export function cagedBulb(b: CagedBulb, time: number): FixtureSample {
  const f = lampFlicker("incandescent", b.seed, time, b.wander ?? 0.6)
  const level = Math.max(0, f.level)
  const c = b.color ?? TUNGSTEN
  // A dimmer filament is a redder filament.
  const cool = Math.max(0, 1 - level)
  const color: Rgb = [c[0], c[1] * (1 - cool * 0.6), c[2] * (1 - cool * 0.9)]
  return {
    light: { x: b.at[0], y: b.at[2], h: b.at[1], r: 8, color, power: (b.power ?? 1) * level, size: 0.03, ...(b.id !== undefined ? { id: b.id } : {}) },
    emissive: level * 2.2,
    hum: 0,
  }
}

/** The bulb (lamp slot `slot`), its holder and a cage of wire hoops and ribs. */
export function cagedBulbMesh(m: Mesh, b: CagedBulb, slot: number): void {
  const [x, y, z] = b.at
  const wire: Rgb = [0.12, 0.12, 0.11]
  m.prism(x, z, 0.022, 0.022, y + 0.04, y + 0.11, 8, [0.1, 0.09, 0.08])
  m.prism(x, z, 0.03, 0.022, y - 0.035, y + 0.04, 10, b.color ?? TUNGSTEN, MAT.lamp, slot)
  for (const h of [-0.05, 0, 0.05]) {
    const r = 0.065 - Math.abs(h) * 0.4
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2
      m.yawBox(x + Math.cos(a) * r, z + Math.sin(a) * r, r * 0.56, 0.006, y + h - 0.003, y + h + 0.003, a + Math.PI / 2, wire, MAT.lit)
    }
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2
    m.yawBox(x + Math.cos(a) * 0.06, z + Math.sin(a) * 0.06, 0.006, 0.006, y - 0.075, y + 0.06, 0, wire, MAT.lit)
  }
}

// ---------------------------------------------------------------- LED indicators

export type LedColor = "red" | "amber" | "green" | "blue" | "white"
export type LedPattern = "steady" | "blink" | "heartbeat" | "activity" | "breathe"

/** Narrow-band emitters as linear sRGB: saturated, so they stay coloured in the bloom rather than clipping to white. */
export const LED_COLORS: Readonly<Record<LedColor, Rgb>> = {
  red: [1, 0.025, 0.008],
  amber: [1, 0.32, 0.01],
  green: [0.12, 1, 0.06],
  blue: [0.03, 0.12, 1],
  white: [0.92, 0.96, 1],
}

export type LedIndicator = {
  at: Vec3
  color: LedColor
  pattern?: LedPattern
  seed?: number
  /** Emission of the lens, in `lampPower` units: a 2 mm LED is a tiny, very bright area, so it blooms. */
  brightness?: number
  id?: number
}

/** On level 0..1 of an indicator's pattern at `time`. */
export function ledLevel(pattern: LedPattern, time: number, seed = 0): number {
  const ph = time + hash01(seed, 401) * 10
  switch (pattern) {
    case "steady": return 1
    case "blink": return (ph % 1) < 0.5 ? 1 : 0
    case "heartbeat": {
      const t = ph % 1.2
      return t < 0.1 || (t > 0.22 && t < 0.32) ? 1 : 0
    }
    case "activity": {
      // Disk or network activity: bursts of 30 ms flashes.
      const slot = Math.floor(ph / 0.03)
      const burst = hash01(seed + 1, Math.floor(ph / 0.7)) > 0.55
      return burst && hash01(seed, slot) > 0.4 ? 1 : 0
    }
    case "breathe": {
      // A sleeping machine: a slow, perceptually even swell (the eye's response is roughly a square).
      const s = 0.5 - 0.5 * Math.cos((ph % 4) / 4 * Math.PI * 2)
      return s * s
    }
  }
}

/** An LED: a very bright emissive point (it blooms) and a weak, short, unshadowed light on what's right beside it. */
export function ledIndicator(l: LedIndicator, time: number): FixtureSample {
  const level = ledLevel(l.pattern ?? "steady", time, l.seed ?? 0)
  const bright = l.brightness ?? 9
  if (level <= 0.001) return { light: null, emissive: 0, hum: 0 }
  return {
    light: { x: l.at[0], y: l.at[2], h: l.at[1], r: 0.6, color: LED_COLORS[l.color], power: 0.0025 * level, size: 0.003, unshadowed: true, ...(l.id !== undefined ? { id: l.id } : {}) },
    emissive: bright * level,
    hum: 0,
  }
}

/** The lens: a 3 mm dome on lamp slot `slot`, set into whatever panel the game draws. */
export function ledIndicatorMesh(m: Mesh, l: LedIndicator, slot: number, facing: Vec3 = [0, 0, 1]): void {
  const [x, y, z] = l.at
  const s = 0.0025
  const d = [facing[0] * s, facing[1] * s, facing[2] * s]
  m.box(x - s + d[0]!, y - s + d[1]!, z - s + d[2]!, x + s + d[0]!, y + s + d[1]!, z + s + d[2]!, LED_COLORS[l.color], MAT.lamp, slot)
}
