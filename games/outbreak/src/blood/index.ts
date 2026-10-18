import { registerOutbreakClientFeature } from "../feature-registry"
import { bloodControls, DEFAULT_BLOOD_SETTINGS } from "./settings"
import { currentBloodStains } from "./stains"

/** Persistent and ambient blood (`stains.ts`, drawn from `scene/frame-renderer.ts`); Lab › Blood. */
export const outbreakBloodFeature = registerOutbreakClientFeature({
  id: "blood",
  order: 45,
  settingsGroup: { subsystem: "blood", defaults: DEFAULT_BLOOD_SETTINGS },
  labControls: () => bloodControls,
  harnessState: () => ({ blood: currentBloodStains()?.stats() ?? null }),
  harnessMethods: () => ({
    /** Clears the fight stains (proofs stage a fight on a clean floor). */
    clearBlood() {
      currentBloodStains()?.reset()
    },
  }),
  feel: {
    reset: () => currentBloodStains()?.reset(),
  },
})
