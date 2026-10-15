import type { LabControl } from "@arcade/kit/lab-panel"

/**
 * Unseen post-process & visibility mode IDs:
 * - 0: Off (baseline identity)
 * - 1: Acid Knife glitch (Powerhoof-inspired low-Hz stepped block/scanline tear, cold slate-indigo monochrome, red/cyan chroma split)
 * - 2: Warp wobble (continuous two-octave domain-warped refraction outside the cone, like heat haze or dark water)
 * - 3: Dark shroud (classic survival-horror fog of war: soft penumbra fade into deep desaturated charcoal-indigo darkness)
 * - 4: Stale memory (unseen areas freeze as a faded archival snapshot of when last seen; zombies hidden or ghosted at last-known pose)
 * - 5: Noise film (analog 16mm silver-halide grain and ordered Bayer dither thickening progressively away from sight)
 */
export type UnseenModeId = 0 | 1 | 2 | 3 | 4 | 5

export type UnseenSettings = {
  unseenMode: UnseenModeId
  unseenStrength: number
  unseenNightScale: number
  unseenEdgeSoftness: number
  unseenUpdateRate: number
  hideUnseenZombies: boolean
}

export const DEFAULT_UNSEEN_SETTINGS: UnseenSettings = {
  unseenMode: 0,
  unseenStrength: 1.0,
  unseenNightScale: 0.75,
  unseenEdgeSoftness: 0.85,
  unseenUpdateRate: 10,
  hideUnseenZombies: true,
}

export const UNSEEN_MODE_OPTIONS: readonly { label: string; value: UnseenModeId }[] = [
  { label: "Off", value: 0 },
  { label: "Acid Knife glitch", value: 1 },
  { label: "Warp wobble", value: 2 },
  { label: "Dark shroud", value: 3 },
  { label: "Stale memory", value: 4 },
  { label: "Noise film", value: 5 },
] as const

export const unseenControls: LabControl[] = [
  {
    key: "unseenMode",
    label: "Mode",
    group: "Unseen",
    options: UNSEEN_MODE_OPTIONS,
  },
  {
    key: "unseenStrength",
    label: "Strength",
    group: "Unseen",
    min: 0.0,
    max: 2.0,
    step: 0.05,
    unit: "×",
  },
  {
    key: "unseenNightScale",
    label: "Night scaling",
    group: "Unseen",
    min: 0.0,
    max: 1.0,
    step: 0.05,
    unit: "",
  },
  {
    key: "unseenEdgeSoftness",
    label: "Edge softness",
    group: "Unseen",
    min: 0.1,
    max: 2.0,
    step: 0.05,
    unit: "",
  },
  {
    key: "unseenUpdateRate",
    label: "Update rate",
    group: "Unseen",
    min: 2,
    max: 30,
    step: 1,
    unit: "Hz",
  },
  {
    key: "hideUnseenZombies",
    label: "Hide unseen zombies",
    group: "Unseen",
    type: "toggle",
  },
]

export type UnseenFrameEvaluation = {
  mode: UnseenModeId
  nightFactor: number
  panicBoost: number
  effectiveStrength: number
  edgeSoftness: number
  updateRate: number
  hideZombies: boolean
  postParams: readonly [number, number, number]
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

/**
 * Evaluates per-frame Unseen shader parameters from Lab settings, current day-cycle darkness (0 = noon, 1 = night),
 * and local survivor health (for low-health panic intensification).
 */
export function evaluateUnseenFrame(
  settings: Partial<UnseenSettings> | undefined,
  darkness = 1.0,
  playerHp = 100,
  playerMaxHp = 100,
): UnseenFrameEvaluation {
  const rawMode = Math.round(settings?.unseenMode ?? DEFAULT_UNSEEN_SETTINGS.unseenMode)
  const mode = (rawMode >= 0 && rawMode <= 5 ? rawMode : 0) as UnseenModeId
  const strength = clamp(settings?.unseenStrength ?? DEFAULT_UNSEEN_SETTINGS.unseenStrength, 0, 2)
  const nightScale = clamp(settings?.unseenNightScale ?? DEFAULT_UNSEEN_SETTINGS.unseenNightScale, 0, 1)
  const edgeSoftness = clamp(settings?.unseenEdgeSoftness ?? DEFAULT_UNSEEN_SETTINGS.unseenEdgeSoftness, 0.1, 2.0)
  const updateRate = clamp(settings?.unseenUpdateRate ?? DEFAULT_UNSEEN_SETTINGS.unseenUpdateRate, 2, 30)
  const hideZombies = Boolean(settings?.hideUnseenZombies ?? DEFAULT_UNSEEN_SETTINGS.hideUnseenZombies)

  const dark = clamp(darkness, 0, 1)
  // Much stronger at night (1.0x at full darkness), subtle by day (~0.46x at default 0.75 night scaling)
  const nightFactor = 1 - (1 - dark) * nightScale * 0.72
  const hpRatio = clamp(playerHp / Math.max(1, playerMaxHp), 0, 1)
  const panicBoost = clamp((1 - hpRatio) * 0.35, 0, 0.35)
  const effectiveStrength = mode === 0 ? 0 : Number((strength * nightFactor * (1 + panicBoost)).toFixed(4))

  return {
    mode,
    nightFactor: Number(nightFactor.toFixed(4)),
    panicBoost: Number(panicBoost.toFixed(4)),
    effectiveStrength,
    edgeSoftness,
    updateRate,
    hideZombies,
    postParams: [mode, effectiveStrength, updateRate] as const,
  }
}
