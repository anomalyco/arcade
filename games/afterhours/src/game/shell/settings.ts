import type * as THREE from "three/webgpu"
import type { WorldContext } from "../../world/context"
import type { ControlsMode } from "./hints"

// Player-facing settings (the Settings screen), saved to localStorage and applied onto the world's settings keys
// (the same keys the Lab panel tunes in debug mode). Debug mode never applies them.

export type Quality = "low" | "medium" | "high"

export type ShellSettings = {
  /** 0..1 */
  master: number
  /** Footsteps, doors, interface. 0..1 */
  sfx: number
  /** The loading screen's static (0 = off). 0..1, 0.25 the default level. */
  menuStatic: number
  /** Ambience, weather and the horror layer. 0..1 */
  ambience: number
  /** Multiplier on the controller's base sensitivity. */
  sensitivity: number
  invertY: boolean
  /** Vertical field of view, degrees. */
  fov: number
  quality: Quality
  /** The controls strip: always, the first minutes of each run, or only on H. */
  controls: ControlsMode
}

export const DEFAULTS: ShellSettings = { master: 0.8, sfx: 1, menuStatic: 0.25, ambience: 1, sensitivity: 1, invertY: false, fov: 68, quality: "high", controls: "auto" }
export const FOV_RANGE = [55, 90] as const
export const SENSITIVITY_RANGE = [0.2, 3] as const

const KEY = "static.settings"

export function loadSettings(): ShellSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<ShellSettings>
    const s = { ...DEFAULTS, ...saved }
    if (!["low", "medium", "high"].includes(s.quality)) s.quality = DEFAULTS.quality
    if (!["always", "auto", "off"].includes(s.controls)) s.controls = DEFAULTS.controls
    return s
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(s: ShellSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {}
}

/** Default bus levels (src/audio/game.ts LEVELS); the sliders scale them. */
const SFX_BUSES = { "audio.footsteps": 0.8, "audio.doors": 0.85, "audio.ui": 0.6 }
const AMBIENT_BUSES = { "audio.ambience": 0.75, "audio.horror": 0.8 }

/**
 * Graphics presets over the render settings (src/render/post.ts). "high" is the tuned default; the others trade
 * resolution, reflections, AO and fog-light samples for speed. Values a preset doesn't name keep the world's default.
 */
const PRESETS: Record<Quality, Record<string, number | boolean>> = {
  high: {},
  medium: { "post.maxDpr": 1.25, "post.minScale": 0.6, "post.aoSamples": 6, "scatter.samples": 3, "post.ssrQuality": 0.45 },
  low: { "post.maxDpr": 1, "post.renderScale": 0.75, "post.minScale": 0.5, "post.ssr": false, "post.ao": false, "scatter.samples": 2, "scatter.lights": 8, "scatter.lightsIndoor": 6 },
}

export function createSettingsApplier(ctx: WorldContext, camera: THREE.PerspectiveCamera) {
  const s = ctx.settings
  // The world's own defaults for every key a preset touches, so switching back to "high" restores them.
  const base: Record<string, number | boolean | string> = {}
  for (const preset of Object.values(PRESETS)) for (const k of Object.keys(preset)) if (k in s) base[k] ??= s[k] as number | boolean | string
  let quality: Quality | null = null
  /** `duck` lowers the master (paused); `ambienceDuck` the night ambience and horror layer (under the menus). */
  return (v: ShellSettings, duck = 1, ambienceDuck = 1) => {
    s["audio.master"] = v.master * duck
    for (const [k, d] of Object.entries(SFX_BUSES)) s[k] = d * v.sfx
    for (const [k, d] of Object.entries(AMBIENT_BUSES)) s[k] = d * v.ambience * ambienceDuck
    s["player.sensitivity"] = v.sensitivity
    s["player.invertY"] = v.invertY ? 1 : 0
    if (camera.fov !== v.fov) {
      camera.fov = v.fov
      camera.updateProjectionMatrix()
    }
    if (quality !== v.quality) {
      quality = v.quality
      for (const [k, d] of Object.entries(base)) s[k] = d
      for (const [k, d] of Object.entries(PRESETS[v.quality])) if (k in s) s[k] = d
    }
  }
}
