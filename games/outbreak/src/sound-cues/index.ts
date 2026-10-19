import { registerOutbreakClientFeature } from "../feature-registry"
import { SoundCueOverlay } from "./overlay"
import { soundCueControls } from "./settings"

/**
 * Sound cues (AR-67): what the dead can hear, drawn so the player learns what is safe (Backquote › Sound cues; the
 * values sit in the HUD settings). The rules are in `model.ts`, the drawing in `overlay.ts`, and the reach comes
 * from the crowd's own hearing (`shared/hearing.ts`).
 */
let overlay: SoundCueOverlay | null = null

export const outbreakSoundCuesFeature = registerOutbreakClientFeature({
  id: "soundCues",
  order: 60,
  labControls: () => soundCueControls,
  frame: {
    overlay: (ctx) => {
      if (typeof document === "undefined") return
      overlay ??= new SoundCueOverlay()
      overlay.draw(ctx)
    },
  },
  harnessState: () => ({
    soundCues: overlay
      ? { live: overlay.model.cues.map((c) => ({ kind: c.kind, label: c.label, source: c.source, reach: c.reach, outside: c.outside })), drawn: { ...overlay.drawn } }
      : null,
  }),
})
