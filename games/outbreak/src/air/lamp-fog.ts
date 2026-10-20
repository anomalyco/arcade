import { FogScatter, createFogSettings, fogControls, fogScatterVolume, type FogLamp, type FogSettings } from "@arcade/kit/gpu/fog-scatter"
import type { FrameInput, VolumeInput } from "@arcade/kit/gpu/renderer"
import type { LabControl } from "@arcade/kit/lab-panel"
import { LIGHT_FLOATS } from "@arcade/kit/limits"

/**
 * The kit's lamp fog (Aiden's equiangular scattering, `@arcade/kit/gpu/fog-scatter`) as a Lab option only
 * (Backquote › Lamp fog). Today by default: Darkwood's look (docs/outbreak-art-direction.md) stays unless Kit picks it.
 * The lamps are the frame's lights (omni, slot 0 is the visibility caster); the fog returns alpha 0, so the shroud
 * still dims it in the composite.
 */
export const LAMP_FOG_DEFAULTS: FogSettings = createFogSettings({ mode: "today", density: 0.02, falloff: 0.12, strength: 0.25, coneLength: 6 })

export const lampFog = new FogScatter({ ...LAMP_FOG_DEFAULTS })

/** Slot 1 of Outbreak's volume shaders (slot 0 is the flashlight beam). */
export const lampFogVolume = fogScatterVolume()

export const lampFogControls = (): LabControl[] => fogControls("Lamp fog", "lampFog.").map((c) => ({ ...c, folded: true }))

/** Surface att ≈ power · 2.6 / (0.3 d²) far from a kit light (default `lightAttenuation`), times the light GAIN. */
const INTENSITY_PER_POWER = (2.6 / 0.3) * 5

const lamps: FogLamp[] = []

/** Fills `render.fog` and the fog's volume slot from the frame's lights (a no-op while the option is Today). */
export function applyLampFog(render: FrameInput, flashlight: VolumeInput | null | undefined): void {
  const volume = lampFog.volumeInput()
  if (!volume) {
    render.fog = null
    render.volume = flashlight
    return
  }
  lamps.length = 0
  const L = render.lights
  for (let i = 1; i < render.lightCount; i++) {
    const k = i * LIGHT_FLOATS
    const power = L[k + 7]!
    if (power <= 0.001 || L[k + 11]! > 0.5) continue
    lamps.push({ x: L[k]!, y: L[k + 1]!, z: L[k + 2]!, range: L[k + 3]!, color: [L[k + 4]!, L[k + 5]!, L[k + 6]!], intensity: power * INTENSITY_PER_POWER, size: 0.3, id: L[k + 15]! >= 0 ? L[k + 15]! : 100000 + i })
  }
  const f = render.frame
  render.fog = lampFog.update({ eye: [f[16]!, f[17]!, f[18]!], viewProj: f, lamps })
  render.volume = [flashlight ?? null, volume]
}
