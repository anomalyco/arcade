import type { LabControl } from "@arcade/kit/lab-panel"

/**
 * Unseen post-process & visibility preset/mode IDs:
 * - 0: Off (baseline identity)
 * - 1: Acid Knife glitch (Powerhoof-inspired low-Hz stepped block/scanline tear, cold slate-indigo monochrome, red/cyan chroma split)
 * - 2: Warp wobble (continuous two-octave domain-warped refraction outside the cone, like heat haze or dark water)
 * - 3: Dark shroud (classic survival-horror fog of war: soft penumbra fade into deep desaturated charcoal-indigo darkness)
 * - 4: Stale memory (unseen areas freeze as a faded archival snapshot of when last seen; zombies hidden or ghosted at last-known pose)
 * - 5: Noise film (analog 16mm silver-halide grain and ordered Bayer dither thickening progressively away from sight)
 * - 6: Combo: Shroud + Noise (Dark shroud + tactile 16mm silver-halide grain in the penumbra)
 * - 7: Combo: Memory + Warp (Faded archival room memory swimming under slow dark-water refraction)
 * - 8: Combo: Edge glitch + Shroud (Acid Knife glitch restricted to the LOS boundary band + Dark shroud + subtle Noise film)
 * - 9: Custom layers (arbitrary user mix of the 5 combinable layers + edge-band control)
 */
export type UnseenModeId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

export type UnseenLayerWeights = {
  glitch: number
  glitchEdge: number
  warp: number
  shroud: number
  memory: number
  noise: number
}

export type UnseenSettings = {
  unseenMode: UnseenModeId
  unseenStrength: number
  unseenGlitch: number
  unseenGlitchEdge: number
  unseenWarp: number
  unseenShroud: number
  unseenMemory: number
  unseenNoise: number
  unseenNightScale: number
  unseenEdgeSoftness: number
  unseenUpdateRate: number
  hideUnseenZombies: boolean
}

export const DEFAULT_UNSEEN_SETTINGS: UnseenSettings = {
  unseenMode: 0,
  unseenStrength: 1.0,
  unseenGlitch: 0.0,
  unseenGlitchEdge: 0.0,
  unseenWarp: 0.0,
  unseenShroud: 0.0,
  unseenMemory: 0.0,
  unseenNoise: 0.0,
  unseenNightScale: 0.75,
  unseenEdgeSoftness: 0.85,
  unseenUpdateRate: 10,
  hideUnseenZombies: true,
}

export const UNSEEN_PRESETS: Readonly<Record<Exclude<UnseenModeId, 9>, UnseenLayerWeights>> = {
  0: { glitch: 0, glitchEdge: 0, warp: 0, shroud: 0, memory: 0, noise: 0 },
  1: { glitch: 1.0, glitchEdge: 0, warp: 0, shroud: 0, memory: 0, noise: 0 },
  2: { glitch: 0, glitchEdge: 0, warp: 1.0, shroud: 0, memory: 0, noise: 0 },
  3: { glitch: 0, glitchEdge: 0, warp: 0, shroud: 1.0, memory: 0, noise: 0 },
  4: { glitch: 0, glitchEdge: 0, warp: 0, shroud: 0, memory: 1.0, noise: 0 },
  5: { glitch: 0, glitchEdge: 0, warp: 0, shroud: 0, memory: 0, noise: 1.0 },
  6: { glitch: 0, glitchEdge: 0, warp: 0, shroud: 0.85, memory: 0, noise: 0.75 },
  7: { glitch: 0, glitchEdge: 0, warp: 0.65, shroud: 0, memory: 0.90, noise: 0 },
  8: { glitch: 1.0, glitchEdge: 0.85, warp: 0, shroud: 0.85, memory: 0, noise: 0.35 },
}

export const UNSEEN_MODE_OPTIONS: readonly { label: string; value: UnseenModeId }[] = [
  { label: "Off", value: 0 },
  { label: "Acid Knife glitch", value: 1 },
  { label: "Warp wobble", value: 2 },
  { label: "Dark shroud", value: 3 },
  { label: "Stale memory", value: 4 },
  { label: "Noise film", value: 5 },
  { label: "Combo: Shroud + Noise", value: 6 },
  { label: "Combo: Memory + Warp", value: 7 },
  { label: "Combo: Edge glitch + Shroud", value: 8 },
  { label: "Custom layers", value: 9 },
] as const

export const unseenControls: LabControl[] = [
  {
    key: "unseenMode",
    label: "Preset / mode",
    group: "Unseen",
    options: UNSEEN_MODE_OPTIONS,
  },
  {
    key: "unseenStrength",
    label: "Master strength",
    group: "Unseen",
    min: 0.0,
    max: 2.0,
    step: 0.05,
    unit: "×",
  },
  {
    key: "unseenGlitch",
    label: "Layer: Acid Knife glitch",
    group: "Unseen",
    min: 0.0,
    max: 2.0,
    step: 0.05,
    unit: "×",
  },
  {
    key: "unseenGlitchEdge",
    label: "Glitch edge band only",
    group: "Unseen",
    min: 0.0,
    max: 1.0,
    step: 0.05,
    unit: "",
  },
  {
    key: "unseenWarp",
    label: "Layer: Warp wobble",
    group: "Unseen",
    min: 0.0,
    max: 2.0,
    step: 0.05,
    unit: "×",
  },
  {
    key: "unseenShroud",
    label: "Layer: Dark shroud",
    group: "Unseen",
    min: 0.0,
    max: 2.0,
    step: 0.05,
    unit: "×",
  },
  {
    key: "unseenMemory",
    label: "Layer: Stale memory",
    group: "Unseen",
    min: 0.0,
    max: 2.0,
    step: 0.05,
    unit: "×",
  },
  {
    key: "unseenNoise",
    label: "Layer: Noise film",
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
  active: boolean
  nightFactor: number
  panicBoost: number
  effectiveStrength: number
  edgeSoftness: number
  updateRate: number
  hideZombies: boolean
  layers: UnseenLayerWeights
  postParams: readonly [number, number, number]
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

const UNSEEN_LAYER_KEYS = new Set([
  "unseenGlitch",
  "unseenGlitchEdge",
  "unseenWarp",
  "unseenShroud",
  "unseenMemory",
  "unseenNoise",
])

/**
 * Populates the individual layer sliders on `settings` from one of the built-in presets (`0..8`).
 */
export function applyUnseenModePreset(settings: UnseenSettings, mode = settings.unseenMode): void {
  const m = (Math.round(mode) >= 0 && Math.round(mode) <= 9 ? Math.round(mode) : 0) as UnseenModeId
  settings.unseenMode = m
  if (m === 9) return
  const preset = UNSEEN_PRESETS[m]
  settings.unseenGlitch = preset.glitch
  settings.unseenGlitchEdge = preset.glitchEdge
  settings.unseenWarp = preset.warp
  settings.unseenShroud = preset.shroud
  settings.unseenMemory = preset.memory
  settings.unseenNoise = preset.noise
}

/**
 * Keeps `unseenMode` and the individual layer sliders synchronized when edited in the Lab or via commands:
 * - Picking a preset (`unseenMode` 0..8) sets the layer sliders to that preset's weights.
 * - Picking `unseenMode = 9` ("Custom layers") from Off seeds a starter Shroud + Noise mix if all layers are zero.
 * - Dragging any layer slider (`unseenGlitch`, `unseenWarp`, etc.) promotes `unseenMode` to `9` ("Custom layers").
 */
export function syncUnseenSettingChange(settings: UnseenSettings, changedKey: string): boolean {
  if (changedKey === "unseenMode") {
    const m = (Math.round(settings.unseenMode) >= 0 && Math.round(settings.unseenMode) <= 9
      ? Math.round(settings.unseenMode)
      : 0) as UnseenModeId
    if (m !== 9) {
      applyUnseenModePreset(settings, m)
    } else {
      const sum =
        settings.unseenGlitch +
        settings.unseenWarp +
        settings.unseenShroud +
        settings.unseenMemory +
        settings.unseenNoise
      if (sum <= 0.001) {
        settings.unseenShroud = 0.85
        settings.unseenNoise = 0.75
      }
    }
    return true
  }
  if (UNSEEN_LAYER_KEYS.has(changedKey)) {
    if (settings.unseenMode !== 9) {
      settings.unseenMode = 9
    }
    return true
  }
  return false
}

/**
 * Packs the 5 effective layer weights (`0..3.99`), `glitchEdge` (`0..1`), and `updateRate` (`2..60` Hz)
 * losslessly into the three 24-bit integer-mantissa floats of `postParams` (`GL.pad.yzw`).
 * Returns `[0, 0, 0]` when all layers are inactive so the post shader exits on its first check.
 */
export function packUnseenPostParams(
  layers: UnseenLayerWeights,
  updateRate: number,
): readonly [number, number, number] {
  const g = Math.round(clamp(layers.glitch, 0, 3.99) * 1024) & 4095
  const w = Math.round(clamp(layers.warp, 0, 3.99) * 1024) & 4095
  const s = Math.round(clamp(layers.shroud, 0, 3.99) * 1024) & 4095
  const m = Math.round(clamp(layers.memory, 0, 3.99) * 1024) & 4095
  const n = Math.round(clamp(layers.noise, 0, 3.99) * 256) & 1023
  if (g === 0 && w === 0 && s === 0 && m === 0 && n === 0) {
    return [0, 0, 0] as const
  }
  const edge = Math.round(clamp(layers.glitchEdge, 0, 1) * 127) & 127
  const rate = Math.round(clamp(updateRate, 2, 60)) & 63
  return [g + w * 4096, s + m * 4096, n + edge * 1024 + rate * 131072] as const
}

/**
 * Unpacks `postParams` (`GL.pad.yzw`) using the exact same bit layout as `applyOutbreakUnseenPost` in WGSL.
 */
export function unpackUnseenPostParams(postParams: readonly [number, number, number]): {
  layers: UnseenLayerWeights
  updateRate: number
} {
  const py = Math.floor(Math.max(0, postParams[0]) + 0.5)
  const pz = Math.floor(Math.max(0, postParams[1]) + 0.5)
  const pw = Math.floor(Math.max(0, postParams[2]) + 0.5)
  if (py === 0 && pz === 0 && pw === 0) {
    return {
      layers: { glitch: 0, glitchEdge: 0, warp: 0, shroud: 0, memory: 0, noise: 0 },
      updateRate: DEFAULT_UNSEEN_SETTINGS.unseenUpdateRate,
    }
  }
  return {
    layers: {
      glitch: (py & 4095) / 1024,
      warp: ((py >>> 12) & 4095) / 1024,
      shroud: (pz & 4095) / 1024,
      memory: ((pz >>> 12) & 4095) / 1024,
      noise: (pw & 1023) / 256,
      glitchEdge: ((pw >>> 10) & 127) / 127,
    },
    updateRate: Math.max(2, (pw >>> 17) & 63),
  }
}

export function resolveUnseenBaseLayers(settings: Partial<UnseenSettings> | undefined): UnseenLayerWeights {
  const rawMode = Math.round(settings?.unseenMode ?? DEFAULT_UNSEEN_SETTINGS.unseenMode)
  const mode = (rawMode >= 0 && rawMode <= 9 ? rawMode : 0) as UnseenModeId
  if (mode === 0) {
    return { glitch: 0, glitchEdge: 0, warp: 0, shroud: 0, memory: 0, noise: 0 }
  }
  const g = clamp(settings?.unseenGlitch ?? 0, 0, 2)
  const ge = clamp(settings?.unseenGlitchEdge ?? 0, 0, 1)
  const w = clamp(settings?.unseenWarp ?? 0, 0, 2)
  const s = clamp(settings?.unseenShroud ?? 0, 0, 2)
  const m = clamp(settings?.unseenMemory ?? 0, 0, 2)
  const n = clamp(settings?.unseenNoise ?? 0, 0, 2)
  const hasExplicit = g > 0 || w > 0 || s > 0 || m > 0 || n > 0
  if (mode === 9 || hasExplicit) {
    return { glitch: g, glitchEdge: ge, warp: w, shroud: s, memory: m, noise: n }
  }
  const preset = UNSEEN_PRESETS[mode]
  return {
    ...preset,
    glitchEdge: settings?.unseenGlitchEdge !== undefined ? ge : preset.glitchEdge,
  }
}

/**
 * Evaluates per-frame Unseen shader parameters and combinable layer weights from Lab settings,
 * current day-cycle darkness (0 = noon, 1 = night), and local survivor health (for low-health panic intensification).
 */
export function evaluateUnseenFrame(
  settings: Partial<UnseenSettings> | undefined,
  darkness = 1.0,
  playerHp = 100,
  playerMaxHp = 100,
): UnseenFrameEvaluation {
  const rawMode = Math.round(settings?.unseenMode ?? DEFAULT_UNSEEN_SETTINGS.unseenMode)
  const mode = (rawMode >= 0 && rawMode <= 9 ? rawMode : 0) as UnseenModeId
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
  const masterScale = strength * nightFactor * (1 + panicBoost)

  const base = resolveUnseenBaseLayers(settings)
  const maxBase = Math.max(base.glitch, base.warp, base.shroud, base.memory, base.noise)
  const active = mode > 0 && maxBase > 0.001 && masterScale > 0.001
  const effectiveStrength = active ? Number((masterScale * Math.min(1, maxBase)).toFixed(4)) : 0

  const layers: UnseenLayerWeights = active
    ? {
        glitch: Number((base.glitch * masterScale).toFixed(4)),
        glitchEdge: Number(base.glitchEdge.toFixed(4)),
        warp: Number((base.warp * masterScale).toFixed(4)),
        shroud: Number((base.shroud * masterScale).toFixed(4)),
        memory: Number((base.memory * masterScale).toFixed(4)),
        noise: Number((base.noise * masterScale).toFixed(4)),
      }
    : { glitch: 0, glitchEdge: 0, warp: 0, shroud: 0, memory: 0, noise: 0 }

  return {
    mode: active ? mode : 0,
    active,
    nightFactor: Number(nightFactor.toFixed(4)),
    panicBoost: Number(panicBoost.toFixed(4)),
    effectiveStrength,
    edgeSoftness,
    updateRate,
    hideZombies,
    layers,
    postParams: active ? packUnseenPostParams(layers, updateRate) : ([0, 0, 0] as const),
  }
}
