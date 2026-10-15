import type { LabControl } from "../lab-panel"
import { Rng } from "../sim/rng"

export type FeelPresetId = "outbreak" | "blackout" | "getaway" | "subtle" | "off"

export type FeelEventKind =
  | "shot"
  | "shove"
  | "hit-confirmed"
  | "kill"
  | "hit-taken"
  | "explosion"
  | "barricade-bash"
  | "land"

export type FeelEventPayload = {
  /** Multiplier for event strength (default 1). */
  power?: number
  /** Aim or impact direction in radians on the ground plane (+X is 0, +Z is +PI/2). */
  dir?: number
  /** Optional explicit ground-plane direction vector (overrides `dir`). */
  dx?: number
  dz?: number
  /** World coordinates of the event and listener for distance-attenuated impulses. */
  x?: number
  z?: number
  listenerX?: number
  listenerZ?: number
  /** Direct distance in metres (overrides x/z/listenerX/listenerZ when supplied). */
  distance?: number
  /** Falloff radius in metres for distance-attenuated events. */
  radius?: number
  /** Raw HP damage for `hit-taken` (e.g. 15..50). */
  damage?: number
  /** Number of targets connected on `shove` or `hit-confirmed`. */
  hits?: number
  /** Whether the hit was lethal or detached a limb. */
  lethal?: boolean
  /** Whether a barricade plank or door broke on `barricade-bash`. */
  broke?: boolean
  /** Optional deterministic roll sign (-1 or 1). */
  rollSign?: -1 | 1
}

export type ReduceMotionMode = 0 | 1 | 2

export type FeelSettings = {
  feelPreset: FeelPresetId
  /** Global game-feel multiplier (0..2). */
  feelIntensity: number
  /** 0 = Auto (honour OS prefers-reduced-motion), 1 = On (reduce shake & motion), 2 = Off (force full). */
  feelReduceMotion: ReduceMotionMode | boolean
  /** Trauma² screen-shake multiplier (0..2). */
  feelShake: number
  /** Trauma decay rate per second (0.5..8). */
  feelTraumaDecay: number
  /** Directional camera kick/recoil multiplier (0..2). */
  feelKick: number
  /** Zoom & roll punch multiplier (0..2). */
  feelPunch: number
  /** Presentation hit-stop duration multiplier (0..2). */
  feelHitStop: number
  /** Impulse & recoil motion-blur multiplier (0..2). */
  feelMotionBlur: number
  /** Damage vignette flash multiplier (0..2). */
  feelDamageFlash: number
  /** Chromatic aberration nudge multiplier (0..2). */
  feelChromatic: number
  /** Deterministic seed for Lab group randomization. */
  feelTuningSeed: number
}

export type FeelPresetProfile = {
  readonly id: FeelPresetId
  readonly label: string
  readonly settings: Omit<FeelSettings, "feelPreset" | "feelReduceMotion" | "feelTuningSeed">
  /** Maximum translational shake displacement at trauma = 1 (metres). */
  readonly maxShakeMeters: number
  /** Maximum rotational shake roll at trauma = 1 (radians). */
  readonly maxShakeRoll: number
  /** Smooth 1D noise frequency (Hz). */
  readonly shakeFrequency: number
  /** Maximum translational kick displacement (metres). */
  readonly maxKickMeters: number
  /** Spring stiffness for ground-plane kick return. */
  readonly kickSpring: number
  /** Maximum directional motion-blur UV offset (fraction of screen). */
  readonly maxBlurUv: number
  /** Maximum radial motion-blur UV offset (fraction of screen). */
  readonly maxRadialBlurUv: number
  /** Per-event tuning weights. */
  readonly events: {
    readonly shot: {
      trauma: number
      kick: number
      zoomPunch: number
      rollPunch: number
      dirBlur: number
      radialBlur: number
      chromatic: number
    }
    readonly shove: {
      trauma: number
      lungeKick: number
      zoomPunch: number
      rollPunch: number
      hitStopSec: number
      dirBlur: number
      radialBlur: number
      chromatic: number
    }
    readonly hitConfirmed: {
      trauma: number
      zoomPunch: number
      hitStopSec: number
      killHitStopSec: number
      killZoom: number
      radialBlur: number
    }
    readonly hitTaken: {
      trauma: number
      kick: number
      zoomPunch: number
      rollPunch: number
      flash: number
      hitStopSec: number
      dirBlur: number
      radialBlur: number
      chromatic: number
    }
    readonly explosion: {
      radius: number
      trauma: number
      kick: number
      zoomPunch: number
      rollPunch: number
      flash: number
      hitStopSec: number
      radialBlur: number
      chromatic: number
    }
    readonly barricadeBash: {
      radius: number
      trauma: number
      kick: number
      breakTrauma: number
      breakRadialBlur: number
    }
    readonly land: {
      trauma: number
      dip: number
      zoomPunch: number
      radialBlur: number
    }
  }
}

export const FEEL_PRESETS: Record<FeelPresetId, FeelPresetProfile> = {
  outbreak: {
    id: "outbreak",
    label: "Outbreak (Survival)",
    settings: {
      feelIntensity: 1.0,
      feelShake: 1.0,
      feelTraumaDecay: 2.8,
      feelKick: 1.0,
      feelPunch: 1.0,
      feelHitStop: 1.0,
      feelMotionBlur: 1.0,
      feelDamageFlash: 1.0,
      feelChromatic: 1.0,
    },
    maxShakeMeters: 0.16,
    maxShakeRoll: 0.016,
    shakeFrequency: 11.5,
    maxKickMeters: 0.42,
    kickSpring: 240,
    maxBlurUv: 0.014,
    maxRadialBlurUv: 0.016,
    events: {
      shot: {
        trauma: 0.18,
        kick: 2.4,
        zoomPunch: 0.22,
        rollPunch: 0.0045,
        dirBlur: 0.0068,
        radialBlur: 0.0032,
        chromatic: 0.16,
      },
      shove: {
        trauma: 0.22,
        lungeKick: 2.8,
        zoomPunch: -0.26,
        rollPunch: 0.005,
        hitStopSec: 0.038,
        dirBlur: 0.0078,
        radialBlur: 0.0055,
        chromatic: 0.18,
      },
      hitConfirmed: {
        trauma: 0.14,
        zoomPunch: -0.14,
        hitStopSec: 0.024,
        killHitStopSec: 0.048,
        killZoom: -0.24,
        radialBlur: 0.0042,
      },
      hitTaken: {
        trauma: 0.42,
        kick: 2.8,
        zoomPunch: 0.34,
        rollPunch: 0.009,
        flash: 0.22,
        hitStopSec: 0.028,
        dirBlur: 0.0085,
        radialBlur: 0.0072,
        chromatic: 0.32,
      },
      explosion: {
        radius: 22,
        trauma: 0.88,
        kick: 6.8,
        zoomPunch: 1.5,
        rollPunch: 0.024,
        flash: 0.12,
        hitStopSec: 0.042,
        radialBlur: 0.013,
        chromatic: 0.38,
      },
      barricadeBash: {
        radius: 14,
        trauma: 0.24,
        kick: 1.4,
        breakTrauma: 0.44,
        breakRadialBlur: 0.0055,
      },
      land: {
        trauma: 0.18,
        dip: 0.32,
        zoomPunch: 0.18,
        radialBlur: 0.0028,
      },
    },
  },
  blackout: {
    id: "blackout",
    label: "Blackout (Arcade Shooter)",
    settings: {
      feelIntensity: 1.0,
      feelShake: 1.0,
      feelTraumaDecay: 3.2,
      feelKick: 1.0,
      feelPunch: 1.0,
      feelHitStop: 1.0,
      feelMotionBlur: 1.0,
      feelDamageFlash: 1.0,
      feelChromatic: 1.0,
    },
    maxShakeMeters: 0.2,
    maxShakeRoll: 0.02,
    shakeFrequency: 13.0,
    maxKickMeters: 0.6,
    kickSpring: 220,
    maxBlurUv: 0.016,
    maxRadialBlurUv: 0.018,
    events: {
      shot: {
        trauma: 0.16,
        kick: 3.0,
        zoomPunch: 0.3,
        rollPunch: 0.006,
        dirBlur: 0.006,
        radialBlur: 0.0028,
        chromatic: 0.14,
      },
      shove: {
        trauma: 0.24,
        lungeKick: 3.2,
        zoomPunch: -0.28,
        rollPunch: 0.006,
        hitStopSec: 0.04,
        dirBlur: 0.0075,
        radialBlur: 0.005,
        chromatic: 0.16,
      },
      hitConfirmed: {
        trauma: 0.25,
        zoomPunch: -0.2,
        hitStopSec: 0.025,
        killHitStopSec: 0.07,
        killZoom: -0.35,
        radialBlur: 0.005,
      },
      hitTaken: {
        trauma: 0.45,
        kick: 2.2,
        zoomPunch: 0.35,
        rollPunch: 0.01,
        flash: 0.45,
        hitStopSec: 0.0,
        dirBlur: 0.007,
        radialBlur: 0.006,
        chromatic: 0.28,
      },
      explosion: {
        radius: 22,
        trauma: 1.0,
        kick: 9.0,
        zoomPunch: 3.0,
        rollPunch: 0.035,
        flash: 0.6,
        hitStopSec: 0.045,
        radialBlur: 0.014,
        chromatic: 0.45,
      },
      barricadeBash: {
        radius: 14,
        trauma: 0.2,
        kick: 1.2,
        breakTrauma: 0.38,
        breakRadialBlur: 0.004,
      },
      land: {
        trauma: 0.3,
        dip: 0.5,
        zoomPunch: 0.45,
        radialBlur: 0.004,
      },
    },
  },
  getaway: {
    id: "getaway",
    label: "Getaway (Chase)",
    settings: {
      feelIntensity: 1.0,
      feelShake: 1.0,
      feelTraumaDecay: 2.4,
      feelKick: 1.0,
      feelPunch: 1.0,
      feelHitStop: 1.0,
      feelMotionBlur: 1.0,
      feelDamageFlash: 1.0,
      feelChromatic: 1.0,
    },
    maxShakeMeters: 0.5,
    maxShakeRoll: 0.018,
    shakeFrequency: 10.5,
    maxKickMeters: 0.85,
    kickSpring: 180,
    maxBlurUv: 0.018,
    maxRadialBlurUv: 0.02,
    events: {
      shot: {
        trauma: 0.14,
        kick: 1.8,
        zoomPunch: 0.2,
        rollPunch: 0.004,
        dirBlur: 0.005,
        radialBlur: 0.0025,
        chromatic: 0.12,
      },
      shove: {
        trauma: 0.28,
        lungeKick: 3.5,
        zoomPunch: -0.3,
        rollPunch: 0.006,
        hitStopSec: 0.04,
        dirBlur: 0.008,
        radialBlur: 0.006,
        chromatic: 0.18,
      },
      hitConfirmed: {
        trauma: 0.22,
        zoomPunch: -0.22,
        hitStopSec: 0.03,
        killHitStopSec: 0.045,
        killZoom: -0.3,
        radialBlur: 0.005,
      },
      hitTaken: {
        trauma: 0.55,
        kick: 3.8,
        zoomPunch: 0.5,
        rollPunch: 0.012,
        flash: 0.4,
        hitStopSec: 0.045,
        dirBlur: 0.009,
        radialBlur: 0.008,
        chromatic: 0.3,
      },
      explosion: {
        radius: 42,
        trauma: 0.95,
        kick: 8.5,
        zoomPunch: 2.4,
        rollPunch: 0.03,
        flash: 0.5,
        hitStopSec: 0.045,
        radialBlur: 0.015,
        chromatic: 0.4,
      },
      barricadeBash: {
        radius: 16,
        trauma: 0.2,
        kick: 1.2,
        breakTrauma: 0.35,
        breakRadialBlur: 0.004,
      },
      land: {
        trauma: 0.25,
        dip: 0.9,
        zoomPunch: 0.4,
        radialBlur: 0.005,
      },
    },
  },
  subtle: {
    id: "subtle",
    label: "Subtle (50%)",
    settings: {
      feelIntensity: 0.5,
      feelShake: 0.75,
      feelTraumaDecay: 3.2,
      feelKick: 0.75,
      feelPunch: 0.7,
      feelHitStop: 0.65,
      feelMotionBlur: 0.65,
      feelDamageFlash: 0.75,
      feelChromatic: 0.5,
    },
    maxShakeMeters: 0.12,
    maxShakeRoll: 0.012,
    shakeFrequency: 11.0,
    maxKickMeters: 0.3,
    kickSpring: 240,
    maxBlurUv: 0.01,
    maxRadialBlurUv: 0.011,
    events: {
      shot: {
        trauma: 0.14,
        kick: 1.9,
        zoomPunch: 0.18,
        rollPunch: 0.0035,
        dirBlur: 0.005,
        radialBlur: 0.0024,
        chromatic: 0.1,
      },
      shove: {
        trauma: 0.18,
        lungeKick: 2.2,
        zoomPunch: -0.2,
        rollPunch: 0.004,
        hitStopSec: 0.03,
        dirBlur: 0.006,
        radialBlur: 0.004,
        chromatic: 0.12,
      },
      hitConfirmed: {
        trauma: 0.12,
        zoomPunch: -0.1,
        hitStopSec: 0.02,
        killHitStopSec: 0.038,
        killZoom: -0.18,
        radialBlur: 0.003,
      },
      hitTaken: {
        trauma: 0.36,
        kick: 2.4,
        zoomPunch: 0.3,
        rollPunch: 0.008,
        flash: 0.45,
        hitStopSec: 0.02,
        dirBlur: 0.006,
        radialBlur: 0.005,
        chromatic: 0.22,
      },
      explosion: {
        radius: 22,
        trauma: 0.75,
        kick: 5.5,
        zoomPunch: 1.3,
        rollPunch: 0.02,
        flash: 0.38,
        hitStopSec: 0.035,
        radialBlur: 0.01,
        chromatic: 0.28,
      },
      barricadeBash: {
        radius: 14,
        trauma: 0.18,
        kick: 1.0,
        breakTrauma: 0.32,
        breakRadialBlur: 0.004,
      },
      land: {
        trauma: 0.14,
        dip: 0.24,
        zoomPunch: 0.14,
        radialBlur: 0.002,
      },
    },
  },
  off: {
    id: "off",
    label: "Off",
    settings: {
      feelIntensity: 0.0,
      feelShake: 0.0,
      feelTraumaDecay: 3.0,
      feelKick: 0.0,
      feelPunch: 0.0,
      feelHitStop: 0.0,
      feelMotionBlur: 0.0,
      feelDamageFlash: 0.0,
      feelChromatic: 0.0,
    },
    maxShakeMeters: 0,
    maxShakeRoll: 0,
    shakeFrequency: 10,
    maxKickMeters: 0,
    kickSpring: 240,
    maxBlurUv: 0,
    maxRadialBlurUv: 0,
    events: {
      shot: { trauma: 0, kick: 0, zoomPunch: 0, rollPunch: 0, dirBlur: 0, radialBlur: 0, chromatic: 0 },
      shove: { trauma: 0, lungeKick: 0, zoomPunch: 0, rollPunch: 0, hitStopSec: 0, dirBlur: 0, radialBlur: 0, chromatic: 0 },
      hitConfirmed: { trauma: 0, zoomPunch: 0, hitStopSec: 0, killHitStopSec: 0, killZoom: 0, radialBlur: 0 },
      hitTaken: { trauma: 0, kick: 0, zoomPunch: 0, rollPunch: 0, flash: 0, hitStopSec: 0, dirBlur: 0, radialBlur: 0, chromatic: 0 },
      explosion: { radius: 22, trauma: 0, kick: 0, zoomPunch: 0, rollPunch: 0, flash: 0, hitStopSec: 0, radialBlur: 0, chromatic: 0 },
      barricadeBash: { radius: 14, trauma: 0, kick: 0, breakTrauma: 0, breakRadialBlur: 0 },
      land: { trauma: 0, dip: 0, zoomPunch: 0, radialBlur: 0 },
    },
  },
}

export const FEEL_PRESET_IDS: readonly FeelPresetId[] = ["outbreak", "blackout", "getaway", "subtle", "off"]

export function createFeelSettings(preset: FeelPresetId = "outbreak"): FeelSettings {
  const p = FEEL_PRESETS[preset] ?? FEEL_PRESETS.outbreak
  return {
    feelPreset: p.id,
    ...p.settings,
    feelReduceMotion: 0,
    feelTuningSeed: 404,
  }
}

export const DEFAULT_FEEL_SETTINGS: FeelSettings = createFeelSettings("outbreak")

export function applyFeelPreset(target: FeelSettings, preset: FeelPresetId | string): FeelSettings {
  const id = (preset in FEEL_PRESETS ? preset : "outbreak") as FeelPresetId
  const p = FEEL_PRESETS[id]
  target.feelPreset = id
  Object.assign(target, p.settings)
  return target
}

export function randomizeFeelSettings(
  target: FeelSettings,
  seed = target.feelTuningSeed ?? 404,
): FeelSettings {
  const nextSeed = ((seed * 1664525 + 1013904223) >>> 0) % 9999 + 1
  const rng = new Rng(nextSeed)
  const snap = (min: number, max: number, step: number) => {
    const raw = min + (max - min) * (0.2 + rng.next() * 0.6)
    return Math.round(raw / step) * step
  }
  target.feelTuningSeed = nextSeed
  target.feelIntensity = snap(0.5, 1.5, 0.05)
  target.feelShake = snap(0.4, 1.6, 0.05)
  target.feelTraumaDecay = snap(1.5, 4.5, 0.1)
  target.feelKick = snap(0.4, 1.6, 0.05)
  target.feelPunch = snap(0.4, 1.6, 0.05)
  target.feelHitStop = snap(0.4, 1.5, 0.05)
  target.feelMotionBlur = snap(0.4, 1.6, 0.05)
  target.feelDamageFlash = snap(0.5, 1.5, 0.05)
  target.feelChromatic = snap(0.3, 1.5, 0.05)
  return target
}

export const feelControls: LabControl[] = [
  {
    key: "feelPreset",
    label: "Preset",
    group: "Feel",
    options: FEEL_PRESET_IDS.map((id) => ({ label: FEEL_PRESETS[id].label, value: id })),
  },
  {
    key: "feelIntensity",
    label: "Global intensity",
    group: "Feel",
    min: 0,
    max: 2,
    step: 0.05,
    unit: "×",
  },
  {
    key: "feelReduceMotion",
    label: "Reduce shake & motion",
    group: "Feel",
    options: [
      { label: "Auto (OS setting)", value: 0 },
      { label: "On (Reduced)", value: 1 },
      { label: "Off (Full feel)", value: 2 },
    ],
  },
  {
    key: "feelShake",
    label: "Trauma shake",
    group: "Feel",
    min: 0,
    max: 2,
    step: 0.05,
    unit: "×",
  },
  {
    key: "feelTraumaDecay",
    label: "Trauma decay",
    group: "Feel",
    min: 0.5,
    max: 6,
    step: 0.1,
    unit: "/s",
  },
  {
    key: "feelKick",
    label: "Directional kick",
    group: "Feel",
    min: 0,
    max: 2,
    step: 0.05,
    unit: "×",
  },
  {
    key: "feelPunch",
    label: "Zoom & roll punch",
    group: "Feel",
    min: 0,
    max: 2,
    step: 0.05,
    unit: "×",
  },
  {
    key: "feelHitStop",
    label: "Hit-stop dilation",
    group: "Feel",
    min: 0,
    max: 2,
    step: 0.05,
    unit: "×",
  },
  {
    key: "feelMotionBlur",
    label: "Impulse motion blur",
    group: "Feel",
    min: 0,
    max: 2,
    step: 0.05,
    unit: "×",
  },
  {
    key: "feelDamageFlash",
    label: "Damage vignette",
    group: "Feel",
    min: 0,
    max: 2,
    step: 0.05,
    unit: "×",
  },
  {
    key: "feelChromatic",
    label: "Chromatic nudge",
    group: "Feel",
    min: 0,
    max: 2,
    step: 0.05,
    unit: "×",
  },
  {
    key: "feelTuningSeed",
    label: "Tuning seed",
    group: "Feel",
    min: 1,
    max: 9999,
    step: 1,
    unit: "",
    folded: true,
  },
]

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))

/** Hash an integer lattice coordinate + seed into [-1, 1] gradient. */
function grad1D(i: number, seed: number): number {
  let h = (Math.imul(i, 0x27d4eb2d) ^ Math.imul(seed, 0x85ebca6b)) | 0
  h = Math.imul(h ^ (h >>> 15), h | 1)
  h ^= h + Math.imul(h ^ (h >>> 7), h | 61)
  return (((h ^ (h >>> 14)) >>> 0) / 2147483647.5) - 1
}

/**
 * Smooth 1D Perlin/Quintic gradient noise in [-1, 1] (2 octaves).
 * Used for Squirrel Eiserloh's trauma² camera shake so shake paths never form repetitive sine loops.
 */
export function smoothNoise1D(x: number, seed: number): number {
  const sample = (t: number, s: number) => {
    const i0 = Math.floor(t)
    const f = t - i0
    // Quintic C2 smoothstep: 6f^5 - 15f^4 + 10f^3
    const u = f * f * f * (f * (f * 6 - 15) + 10)
    const g0 = grad1D(i0, s) * f
    const g1 = grad1D(i0 + 1, s) * (f - 1)
    return (g0 + (g1 - g0) * u) * 1.85
  }
  return clamp(sample(x, seed) * 0.72 + sample(x * 2.17 + 13.7, seed + 101) * 0.28, -1, 1)
}

/** Detects OS `prefers-reduced-motion: reduce` when running in a browser environment. */
export function prefersReducedMotion(): boolean {
  try {
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    }
  } catch {}
  return false
}

export type FeelCameraOffset = {
  /** Ground-plane X offset (shake + directional kick) in metres. */
  x: number
  /** Vertical target Y offset (landing dip) in metres. */
  y: number
  /** Ground-plane Z offset (shake + directional kick) in metres. */
  z: number
  /** Camera distance / zoom offset in metres. */
  zoom: number
  /** Camera roll angle in radians. */
  roll: number
}

/**
 * Shared presentation-only Game Feel controller.
 * Maps semantic gameplay events (`shot`, `shove`, `hit-taken`, `hit-confirmed`, `kill`, `explosion`,
 * `barricade-bash`, `land`) to trauma² smooth-noise camera shake, substepped spring recoil/kick,
 * zoom & roll punch, sim-safe presentation hit-stop, directional/radial motion blur bursts,
 * damage vignette pulse, and chromatic nudge.
 */
export class GameFeel {
  /** Current trauma in [0, 1]. Shake scales with trauma². */
  trauma = 0
  /** Current damage vignette pulse in [0, 1]. */
  damageFlash = 0
  /** Remaining presentation hit-stop time in seconds. */
  hitStopRemaining = 0
  /** Presentation time-dilation factor during hit-stop (default 0.08). */
  hitStopTimeScale = 0.08
  /** Cooldown before another hit-stop can trigger so rapid hits never lock presentation. */
  private hitStopCooldown = 0

  /** Ground-plane directional kick displacement (metres) and velocity (m/s). */
  kickX = 0
  kickZ = 0
  kickVx = 0
  kickVz = 0

  /** Zoom punch displacement (metres) and velocity (m/s). */
  zoom = 0
  zoomV = 0

  /** Roll punch angle (radians) and angular velocity (rad/s). */
  roll = 0
  rollV = 0

  /** Vertical landing dip (metres). */
  landing = 0

  /** Impulse-driven directional motion blur in UV space. */
  blurX = 0
  blurY = 0
  /** Impulse-driven radial motion blur in UV space. */
  radialBlur = 0
  /** Impulse-driven chromatic aberration boost. */
  chromatic = 0

  /** Monotonic presentation time for noise evaluation (seconds) and deterministic roll counter. */
  time = 0
  private eventCount = 0
  /** Optional override for OS prefers-reduced-motion (used in tests). */
  osReducedMotionOverride: boolean | null = null

  /** Preallocated camera offset updated every `step(dt)`. */
  readonly offset: FeelCameraOffset = { x: 0, y: 0, z: 0, zoom: 0, roll: 0 }
  /** Preallocated 4-float post uniform `[blurX, blurY, radialBlur, chromatic]` for `FrameInput.feel`. */
  readonly post: [number, number, number, number] = [0, 0, 0, 0]

  constructor(public settings: FeelSettings = createFeelSettings("outbreak")) {}

  get profile(): FeelPresetProfile {
    return FEEL_PRESETS[this.settings.feelPreset] ?? FEEL_PRESETS.outbreak
  }

  /** Whether reduced motion is active via explicit setting or OS `prefers-reduced-motion: reduce`. */
  get reducedMotion(): boolean {
    const mode = this.settings.feelReduceMotion
    if (typeof mode === "boolean") return mode
    if (mode === 1) return true
    if (mode === 2) return false
    return this.osReducedMotionOverride !== null ? this.osReducedMotionOverride : prefersReducedMotion()
  }

  /** Effective global intensity (0 when preset is 'off' or feelIntensity <= 0). */
  get effectiveIntensity(): number {
    if (this.settings.feelPreset === "off") return 0
    return clamp(this.settings.feelIntensity, 0, 2)
  }

  reset(): void {
    this.trauma = 0
    this.damageFlash = 0
    this.hitStopRemaining = 0
    this.hitStopCooldown = 0
    this.kickX = 0
    this.kickZ = 0
    this.kickVx = 0
    this.kickVz = 0
    this.zoom = 0
    this.zoomV = 0
    this.roll = 0
    this.rollV = 0
    this.landing = 0
    this.blurX = 0
    this.blurY = 0
    this.radialBlur = 0
    this.chromatic = 0
    this.time = 0
    this.eventCount = 0
    this.offset.x = 0
    this.offset.y = 0
    this.offset.z = 0
    this.offset.zoom = 0
    this.offset.roll = 0
    this.post[0] = 0
    this.post[1] = 0
    this.post[2] = 0
    this.post[3] = 0
  }

  /** Returns the presentation-only delta-time dilated by active hit-stop (never affects authoritative sim). */
  visualDt(dt: number): number {
    if (this.reducedMotion || this.hitStopRemaining <= 0 || this.settings.feelHitStop <= 0.001) {
      return dt
    }
    return dt * this.hitStopTimeScale
  }

  /** Computes distance attenuation in [0, 1] for spatial events (`explosion`, `barricade-bash`). */
  static distanceAttenuation(payload: FeelEventPayload, defaultRadius: number): number {
    const radius = Math.max(0.1, payload.radius ?? defaultRadius)
    let dist = payload.distance
    if (
      dist === undefined &&
      payload.x !== undefined &&
      payload.z !== undefined &&
      payload.listenerX !== undefined &&
      payload.listenerZ !== undefined
    ) {
      dist = Math.hypot(payload.x - payload.listenerX, payload.z - payload.listenerZ)
    }
    if (dist === undefined || !Number.isFinite(dist)) return 1
    if (dist >= radius) return 0
    const linear = clamp(1 - dist / radius, 0, 1)
    return linear * Math.sqrt(linear)
  }

  /** Resolves a unit direction vector `(ux, uz)` on the ground plane from `payload`. */
  private static resolveDir(payload: FeelEventPayload): [number, number] {
    if (payload.dx !== undefined || payload.dz !== undefined) {
      const dx = payload.dx ?? 0
      const dz = payload.dz ?? 0
      const l = Math.hypot(dx, dz)
      return l > 1e-5 ? [dx / l, dz / l] : [0, -1]
    }
    if (payload.dir !== undefined && Number.isFinite(payload.dir)) {
      return [Math.cos(payload.dir), Math.sin(payload.dir)]
    }
    if (
      payload.x !== undefined &&
      payload.z !== undefined &&
      payload.listenerX !== undefined &&
      payload.listenerZ !== undefined
    ) {
      const dx = payload.listenerX - payload.x
      const dz = payload.listenerZ - payload.z
      const l = Math.hypot(dx, dz)
      return l > 1e-5 ? [dx / l, dz / l] : [0, 1]
    }
    return [0, -1]
  }

  /** Emits a semantic game-feel event. Safe to call from any presentation path; never mutates sim state. */
  emit(kind: FeelEventKind, payload: FeelEventPayload = {}): void {
    const intensity = this.effectiveIntensity
    if (intensity <= 0.0001) return

    const s = this.settings
    const p = this.profile
    const ev = p.events
    const power = clamp(payload.power ?? 1, 0, 4)
    if (power <= 0.0001) return

    const reduced = this.reducedMotion
    const shakeScale = reduced ? 0 : clamp(s.feelShake, 0, 2) * intensity
    const kickScale = reduced ? 0 : clamp(s.feelKick, 0, 2) * intensity
    const punchScale = reduced ? 0 : clamp(s.feelPunch, 0, 2) * intensity
    const hitStopScale = reduced ? 0 : clamp(s.feelHitStop, 0, 2) * intensity
    const blurScale = reduced ? 0 : clamp(s.feelMotionBlur, 0, 2) * intensity
    const flashScale = clamp(s.feelDamageFlash, 0, 2) * intensity * (reduced ? 0.5 : 1)
    const chromaScale = reduced ? 0 : clamp(s.feelChromatic, 0, 2) * intensity

    const [ux, uz] = GameFeel.resolveDir(payload)
    const rollSign = payload.rollSign ?? (++this.eventCount % 2 === 0 ? 1 : -1)

    switch (kind) {
      case "shot": {
        const cfg = ev.shot
        this.addTrauma(cfg.trauma * power * shakeScale)
        // Recoil kicks camera opposite to the shot direction (-ux, -uz) and springs back.
        this.addKick(-ux, -uz, cfg.kick * power * kickScale)
        this.addPunch(cfg.zoomPunch * power * punchScale, rollSign * cfg.rollPunch * power * punchScale)
        // Screen-space shutter streak along the shot axis (world +X -> UV +X, world +Z -> UV +Y).
        this.addBlur(ux * cfg.dirBlur * power * blurScale, uz * cfg.dirBlur * power * blurScale, cfg.radialBlur * power * blurScale)
        this.addChromatic(cfg.chromatic * power * chromaScale)
        break
      }
      case "shove": {
        const cfg = ev.shove
        const connected = (payload.hits ?? 0) > 0
        const hitBoost = connected ? 1.35 : 0.85
        this.addTrauma(cfg.trauma * power * hitBoost * shakeScale)
        // Shove lunges forward along aim (+ux, +uz), then snaps back.
        this.addKick(ux, uz, cfg.lungeKick * power * hitBoost * kickScale)
        this.addPunch(cfg.zoomPunch * power * hitBoost * punchScale, rollSign * cfg.rollPunch * power * punchScale)
        if (connected) {
          this.triggerHitStop(cfg.hitStopSec * Math.min(1.5, power) * hitStopScale)
        }
        this.addBlur(
          ux * cfg.dirBlur * power * hitBoost * blurScale,
          uz * cfg.dirBlur * power * hitBoost * blurScale,
          cfg.radialBlur * power * hitBoost * blurScale,
        )
        this.addChromatic(cfg.chromatic * power * hitBoost * chromaScale)
        break
      }
      case "hit-confirmed":
      case "kill": {
        const cfg = ev.hitConfirmed
        const isKill = kind === "kill" || Boolean(payload.lethal)
        this.addTrauma(cfg.trauma * (isKill ? 1.35 : 0.85) * power * shakeScale)
        if (isKill && punchScale > 0) {
          this.zoom = clamp(this.zoom + cfg.killZoom * Math.min(1.4, power) * punchScale, -1.0, 2.5)
          this.zoomV = 0
        } else {
          this.addPunch(cfg.zoomPunch * power * punchScale, 0)
        }
        const stopDur = isKill ? cfg.killHitStopSec : cfg.hitStopSec
        this.triggerHitStop(stopDur * Math.min(1.4, power) * hitStopScale)
        this.addBlur(
          ux * 0.0028 * power * blurScale,
          uz * 0.0028 * power * blurScale,
          cfg.radialBlur * (isKill ? 1.35 : 0.85) * power * blurScale,
        )
        break
      }
      case "hit-taken": {
        const cfg = ev.hitTaken
        const dmgScale = payload.damage !== undefined ? clamp(payload.damage / 22, 0.45, 1.8) : 1.0
        const eff = power * dmgScale
        this.addTrauma(cfg.trauma * eff * shakeScale)
        this.addKick(ux, uz, cfg.kick * eff * kickScale)
        this.addPunch(cfg.zoomPunch * eff * punchScale, rollSign * cfg.rollPunch * eff * punchScale)
        const maxFlash = reduced ? 0.35 : 0.92
        this.damageFlash = clamp(Math.max(this.damageFlash, cfg.flash * eff * flashScale), 0, maxFlash)
        if (cfg.hitStopSec > 0) {
          this.triggerHitStop(cfg.hitStopSec * Math.min(1.3, eff) * hitStopScale)
        }
        this.addBlur(
          ux * cfg.dirBlur * eff * blurScale,
          uz * cfg.dirBlur * eff * blurScale,
          cfg.radialBlur * eff * blurScale,
        )
        this.addChromatic(cfg.chromatic * eff * chromaScale)
        break
      }
      case "explosion": {
        const cfg = ev.explosion
        const att = GameFeel.distanceAttenuation(payload, cfg.radius)
        if (att <= 0.001) break
        const eff = power * att
        const eff2 = power * att * att
        this.addTrauma(cfg.trauma * eff * shakeScale)
        this.addKick(ux, uz, cfg.kick * eff2 * kickScale)
        this.addPunch(cfg.zoomPunch * eff2 * punchScale, rollSign * cfg.rollPunch * eff * punchScale)
        if (att > 0.35) {
          const maxFlash = reduced ? 0.35 : 0.85
          this.damageFlash = clamp(this.damageFlash + cfg.flash * (att - 0.35) * 1.4 * flashScale, 0, maxFlash)
        }
        if (att > 0.4 && cfg.hitStopSec > 0) {
          this.triggerHitStop(cfg.hitStopSec * att * hitStopScale)
        }
        this.addBlur(
          ux * 0.005 * eff * blurScale,
          uz * 0.005 * eff * blurScale,
          cfg.radialBlur * eff * blurScale,
        )
        this.addChromatic(cfg.chromatic * eff * chromaScale)
        break
      }
      case "barricade-bash": {
        const cfg = ev.barricadeBash
        const att = GameFeel.distanceAttenuation(payload, cfg.radius)
        if (att <= 0.001) break
        const broke = Boolean(payload.broke)
        const tr = (broke ? cfg.breakTrauma : cfg.trauma) * att * power * shakeScale
        this.addTrauma(tr)
        this.addKick(ux, uz, cfg.kick * (broke ? 1.5 : 1.0) * att * power * kickScale)
        if (broke) {
          this.addBlur(0, 0, cfg.breakRadialBlur * att * power * blurScale)
          this.addChromatic(0.18 * att * power * chromaScale)
        }
        break
      }
      case "land": {
        const cfg = ev.land
        this.addTrauma(cfg.trauma * power * shakeScale)
        if (!reduced) {
          this.landing = clamp(Math.max(this.landing, cfg.dip * power * punchScale), 0, 1.2)
        }
        this.addPunch(cfg.zoomPunch * power * punchScale, 0)
        this.addBlur(0, cfg.radialBlur * 0.6 * power * blurScale, cfg.radialBlur * power * blurScale)
        break
      }
    }
  }

  addTrauma(amount: number): void {
    if (amount <= 0 || this.reducedMotion) return
    this.trauma = clamp(this.trauma + amount, 0, 1)
  }

  addKick(dx: number, dz: number, amount: number): void {
    if (amount === 0 || this.reducedMotion) return
    this.kickVx += dx * amount
    this.kickVz += dz * amount
  }

  addPunch(zoomAmount: number, rollRadians: number): void {
    if (this.reducedMotion) return
    this.zoomV += zoomAmount * 40
    this.rollV += rollRadians * 40
  }

  triggerHitStop(durationSec: number): void {
    if (durationSec <= 0.001 || this.reducedMotion || this.hitStopCooldown > 0) return
    const capped = clamp(durationSec, 0, 0.08)
    this.hitStopRemaining = Math.max(this.hitStopRemaining, capped)
    this.hitStopCooldown = Math.max(0.16, capped * 3.2)
  }

  private addBlur(bx: number, by: number, radial: number): void {
    if (this.reducedMotion) return
    const p = this.profile
    this.blurX = clamp(this.blurX + bx, -p.maxBlurUv, p.maxBlurUv)
    this.blurY = clamp(this.blurY + by, -p.maxBlurUv, p.maxBlurUv)
    this.radialBlur = clamp(Math.max(this.radialBlur, radial), 0, p.maxRadialBlurUv)
  }

  private addChromatic(amount: number): void {
    if (amount <= 0 || this.reducedMotion) return
    this.chromatic = clamp(Math.max(this.chromatic, amount), 0, 0.48)
  }

  /**
   * Advances trauma decay, 240 Hz critically-damped recoil/punch springs, hit-stop timer,
   * and post-processing impulse envelopes. Call once per render frame with real `dt`.
   */
  step(dt: number): FeelCameraOffset {
    const safeDt = clamp(dt, 0, 0.1)
    this.time += safeDt

    if (this.reducedMotion || this.effectiveIntensity <= 0.0001) {
      this.trauma = 0
      this.hitStopRemaining = 0
      this.hitStopCooldown = 0
      this.kickX = this.kickZ = this.kickVx = this.kickVz = 0
      this.zoom = this.zoomV = 0
      this.roll = this.rollV = 0
      this.landing = 0
      this.blurX = this.blurY = this.radialBlur = this.chromatic = 0
      if (this.effectiveIntensity <= 0.0001) {
        this.damageFlash = 0
      } else {
        this.damageFlash = Math.min(0.35, this.damageFlash) * Math.exp(-safeDt * 2.4)
        if (this.damageFlash < 0.002) this.damageFlash = 0
      }
      this.offset.x = 0
      this.offset.y = 0
      this.offset.z = 0
      this.offset.zoom = 0
      this.offset.roll = 0
      this.post[0] = 0
      this.post[1] = 0
      this.post[2] = 0
      this.post[3] = 0
      return this.offset
    }

    const s = this.settings
    const p = this.profile

    // Hit-stop timers advance on unscaled wall dt so presentation never gets stuck.
    if (this.hitStopRemaining > 0) {
      this.hitStopRemaining = Math.max(0, this.hitStopRemaining - safeDt)
    }
    if (this.hitStopCooldown > 0) {
      this.hitStopCooldown = Math.max(0, this.hitStopCooldown - safeDt)
    }

    // Trauma decay & Squirrel Eiserloh's trauma² with 2-octave smooth 1D noise.
    const decay = clamp(s.feelTraumaDecay, 0.5, 12)
    this.trauma = Math.max(0, this.trauma - decay * safeDt * 0.45) * Math.exp(-safeDt * decay * 0.55)
    if (this.trauma < 0.001) this.trauma = 0
    const traumaSq = this.trauma * this.trauma
    const freq = p.shakeFrequency
    const nx = smoothNoise1D(this.time * freq, 101)
    const nz = smoothNoise1D(this.time * freq, 313)
    const nRoll = smoothNoise1D(this.time * (freq * 1.15), 619)
    const shakeX = traumaSq * p.maxShakeMeters * nx
    const shakeZ = traumaSq * p.maxShakeMeters * nz
    const shakeRoll = traumaSq * p.maxShakeRoll * nRoll

    // Substepped 240 Hz spring integration for directional kick, zoom punch, and roll punch.
    const kSpring = p.kickSpring
    const damp = 2 * Math.sqrt(kSpring)
    const nSteps = Math.max(1, Math.ceil(safeDt / (1 / 240)))
    const h = safeDt / nSteps
    for (let i = 0; i < nSteps; i++) {
      this.kickVx += (-kSpring * this.kickX - damp * this.kickVx) * h
      this.kickVz += (-kSpring * this.kickZ - damp * this.kickVz) * h
      this.kickX += this.kickVx * h
      this.kickZ += this.kickVz * h

      this.zoomV += (-400 * this.zoom - 26 * this.zoomV) * h
      this.zoom += this.zoomV * h

      this.rollV += (-500 * this.roll - 30 * this.rollV) * h
      this.roll += this.rollV * h
    }

    const maxK = Math.max(0.05, p.maxKickMeters)
    const kLen = Math.hypot(this.kickX, this.kickZ)
    if (kLen > maxK) {
      this.kickX *= maxK / kLen
      this.kickZ *= maxK / kLen
    }
    this.zoom = clamp(this.zoom, -1.0, 2.5)
    this.roll = clamp(this.roll, -0.05, 0.05)
    this.landing *= Math.exp(-safeDt * 14)
    if (this.landing < 0.001) this.landing = 0

    // Damage vignette pulse decay
    this.damageFlash *= Math.exp(-safeDt * 2.1)
    if (this.damageFlash < 0.002) this.damageFlash = 0

    // Impulse motion-blur & chromatic decay (short, snappy ~80-110 ms burst)
    const blurDecay = Math.exp(-safeDt * 18)
    this.blurX *= blurDecay
    this.blurY *= blurDecay
    this.radialBlur *= Math.exp(-safeDt * 15)
    this.chromatic *= Math.exp(-safeDt * 14)

    // Couple live camera recoil velocity into directional shutter blur for physical continuity
    const blurScale = clamp(s.feelMotionBlur, 0, 2) * this.effectiveIntensity
    const velBlurX = clamp(-this.kickVx * 0.00095 * blurScale, -p.maxBlurUv * 0.65, p.maxBlurUv * 0.65)
    const velBlurY = clamp(-this.kickVz * 0.00095 * blurScale, -p.maxBlurUv * 0.65, p.maxBlurUv * 0.65)
    const outBx = clamp(this.blurX + velBlurX, -p.maxBlurUv, p.maxBlurUv)
    const outBy = clamp(this.blurY + velBlurY, -p.maxBlurUv, p.maxBlurUv)
    const outRad = clamp(this.radialBlur + Math.abs(this.zoomV) * 0.00045 * blurScale, 0, p.maxRadialBlurUv)

    if (Math.abs(this.blurX) < 0.00005) this.blurX = 0
    if (Math.abs(this.blurY) < 0.00005) this.blurY = 0
    if (this.radialBlur < 0.00005) this.radialBlur = 0
    if (this.chromatic < 0.001) this.chromatic = 0

    this.offset.x = shakeX + this.kickX
    this.offset.y = -this.landing
    this.offset.z = shakeZ + this.kickZ
    this.offset.zoom = this.zoom
    this.offset.roll = clamp(shakeRoll + this.roll, -0.06, 0.06)

    this.post[0] = Math.abs(outBx) > 0.00018 ? outBx : 0
    this.post[1] = Math.abs(outBy) > 0.00018 ? outBy : 0
    this.post[2] = outRad > 0.00018 ? outRad : 0
    this.post[3] = this.chromatic > 0.002 ? this.chromatic : 0

    return this.offset
  }
}
