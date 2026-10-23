import { bindVolumeControls } from "@arcade/kit/audio/volume"
import { cameraShakeControls, cameraShakeDefaults } from "@arcade/kit/client/camera"
import { keyLabelSetting } from "@arcade/kit/client/controls"
import type { GameQuality } from "@arcade/kit/client/quality"
import { mixer } from "../audio/mixer"
import type { CarrierQuality } from "../quality"
import { SHAKE } from "../render/camera"
import type { DevSection } from "./dev-panel"

/**
 * VIEW: the quality tier and player volume (Auto adapts resolution and bloom to the GPU; choices are saved for the game),
 * the shared Key labels choice (prompts name QWERTY keys unless the player picks their own layout) and the shared camera
 * shake every rig reads (`SHAKE`, src/render/camera.ts; Carrier's TraumaShake reads only the scale and reduced motion).
 */
export function viewSection(quality: GameQuality<CarrierQuality>): DevSection {
  return {
    id: "view",
    tab: "Game",
    bind: (panel) => {
      quality.addTo(panel)
      const mix = mixer()
      bindVolumeControls(panel, {
        volumes: mix.volumes,
        channels: ["master", "effects", "ambience", "voice"],
        getMuted: () => mix.muted,
        setMuted: (m) => mix.setMuted(m),
        onChange: () => mix.setVolumes(),
      })
      const keys = keyLabelSetting("Controls")
      panel.addControls(keys.settings, [keys.control], keys.defaults)
      const shake = cameraShakeControls.filter((c) => c.key === "shakeScale" || c.key === "reduceMotion")
      panel.addControls(SHAKE, shake, cameraShakeDefaults())
    },
  }
}
