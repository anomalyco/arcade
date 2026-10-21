import { FogScatter, createFogSettings, fogControls, type FogLamp, type FogSettings } from "@arcade/kit/gpu/fog-scatter"
import { createStreetLampSettings, type StreetLampSettings } from "@arcade/kit/gpu/lights/street"
import type { FrameInput, VolumeInput } from "@arcade/kit/gpu/renderer"
import type { LabControl } from "@arcade/kit/lab-panel"
import { LIGHT_FLOATS } from "@arcade/kit/limits"
import { mistFogSettings, mistOn, type OutbreakMistSettings } from "../mist/settings"
import type { OutbreakStreetLampSettings } from "../street-lamps/settings"

/**
 * The kit's lamp fog (Aiden's equiangular scattering, `@arcade/kit/gpu/fog-scatter`) as a Lab option only
 * (Backquote › Lamp fog). Today by default: Darkwood's look (docs/outbreak-art-direction.md) stays unless Kit picks it.
 * The lamps are the frame's lights (omni, slot 0 is the visibility caster); the fog returns alpha 0, so the shroud
 * still dims it in the composite. The low mist (`mist/`) rides on the same fog: its bank, lit by the lamps and the torch.
 */
export const LAMP_FOG_DEFAULTS: FogSettings = createFogSettings({ mode: "today", density: 0.02, falloff: 0.12, strength: 0.25, coneLength: 6 })

export const lampFog = new FogScatter({ ...LAMP_FOG_DEFAULTS })

export const lampFogControls = (): LabControl[] => fogControls("Lamp fog", "lampFog.").map((c) => ({ ...c, folded: true }))

/** Surface att ≈ power · 2.6 / (0.3 d²) far from a kit light (default `lightAttenuation`), times the light GAIN. */
const INTENSITY_PER_POWER = (2.6 / 0.3) * 5
/** A lens street lamp's att is power · profile / (d² + b²); scaled like the omni lamps above (× 2.4 their real numerator). */
const LENS_INTENSITY_PER_POWER = 12
/** The torch: power · 9 · profile, softened inside 6 m (`flashAttenuation`), read at ~3.5 m. */
const TORCH_INTENSITY_PER_POWER = 9 * 12 * 5

/** What the fog needs beyond the frame's lights. */
export type LampFogFrame = {
  readonly mist: OutbreakMistSettings
  readonly streetLamps: OutbreakStreetLampSettings
  /** 0 night .. 1 day, for the mist's sky light. */
  readonly sun: number
  /** Seconds, for the mist's drift. */
  readonly time: number
  /** The torch's pitch (radians, negative down), for its cone in the mist. */
  readonly torchPitch: number
}

const lamps: FogLamp[] = []
const working = new FogScatter(createFogSettings())
const street: StreetLampSettings = createStreetLampSettings()
const mistParams = new Float32Array(4)

/** The fog this frame (lamp fog, mist, or both) and its volume slot input; null with both at Today. */
export function applyLampFog(render: FrameInput, frame: LampFogFrame): VolumeInput | null {
  const mist = mistOn(frame.mist)
  const lampFogOn = lampFog.enabled
  if (!mist && !lampFogOn) {
    render.fog = null
    return null
  }
  const fog = mist ? working : lampFog
  if (mist) mistFogSettings(lampFog.settings, lampFogOn, frame.mist, frame.sun, working.settings)
  const s = frame.streetLamps
  Object.assign(street, { along: s.slAlong, street: s.slStreet, house: s.slHouse, cutoff: s.slCutoff, glow: s.slGlow, air: 0.6, haze: s.slAir * 4.2, uplight: 0.12 })
  lamps.length = 0
  const L = render.lights
  for (let i = 1; i < render.lightCount; i++) {
    const k = i * LIGHT_FLOATS
    const power = L[k + 7]!
    const kind = L[k + 11]!
    if (power <= 0.001) continue
    const id = L[k + 15]! >= 0 ? L[k + 15]! : 100000 + i
    const base = { x: L[k]!, y: L[k + 1]!, z: L[k + 2]!, range: L[k + 3]!, color: [L[k + 4]!, L[k + 5]!, L[k + 6]!] as const, id }
    if (kind > 6.5) {
      // cone.z is the lens lamp's flux gain (street-lamps/lens.ts); its length comes from the settings.
      lamps.push({ ...base, intensity: power * L[k + 10]! * LENS_INTENSITY_PER_POWER, size: 0.3, lens: { arm: [L[k + 8]!, L[k + 9]!], a: s.slLensA, b: kind - 7 }, uplight: 0.12 })
    } else if (kind > 1.5 && kind < 2.5) {
      // The torch lights the mist inside its beam only (no glow map: no pool that follows the survivor).
      if (!mist) continue
      const cp = Math.cos(frame.torchPitch)
      const half = Math.acos(Math.max(-1, Math.min(1, L[k + 10]!)))
      lamps.push({ ...base, intensity: power * TORCH_INTENSITY_PER_POWER, axis: [L[k + 8]! * cp, Math.sin(frame.torchPitch), L[k + 9]! * cp], cosOuter: Math.cos(half), cosInner: Math.cos(half * 0.75), size: 0.1, uplight: 0 })
    } else if (kind <= 0.5) {
      lamps.push({ ...base, intensity: power * INTENSITY_PER_POWER, size: 0.3 })
    }
  }
  const f = render.frame
  render.fog = fog.update({ eye: [f[16]!, f[17]!, f[18]!], viewProj: f, lamps, time: frame.time, street })
  const input = fog.volumeInput()
  if (!input) return null
  mistParams.set([frame.mist.mistYards, frame.mist.mistGutters, frame.mist.mistRoads, mist ? 1 : 0])
  return { ...input, params: mistParams }
}
