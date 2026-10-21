import { placeFire } from "../../shared/fire/runtime"
import { LocalSession } from "../../shared/session"
import { registerOutbreakClientFeature } from "../feature-registry"
import { currentSoftShadows } from "./presenter"
import { DEFAULT_SOFT_SHADOW_SETTINGS, softShadowControls } from "./settings"

/**
 * Soft character shadows (AR-113): Lab controls and proof telemetry. The frame renderer owns the presenter, since it
 * reads every posed body (`scene/frame-renderer.ts`), and the scene shader reads the capsules (`shaders.ts`).
 */
export const outbreakSoftShadowsFeature = registerOutbreakClientFeature({
  id: "soft-shadows",
  order: 31,
  settingsGroup: { subsystem: "softShadows", defaults: DEFAULT_SOFT_SHADOW_SETTINGS },
  labControls: () => softShadowControls,
  harnessState: () => ({ softShadows: currentSoftShadows()?.stats ?? null }),
  harnessMethods: (host) => ({
    /** Offline: a teammate standing at (x, y) facing `aim`, drawn like a co-op survivor (stills of a group). */
    addShadowMate(x: number, y: number, aim = 0) {
      const session = host.session()
      if (!(session instanceof LocalSession)) throw new Error("Offline only")
      const sim = session.sim
      const index = Math.max(...sim.slots.map((s) => s.index)) + 1
      const slot = sim.addSurvivor(`mate-${index}`, index)
      Object.assign(slot.survivor, { x, y, aim, vx: 0, vy: 0, flashlightOn: false })
      sim.rebuildSolids()
      return slot.id
    },
    /** A ground fire of radius `r` burning for ten minutes at (x, y) (stills of a group round a fire). */
    placeShadowFire(x: number, y: number, r = 0.6) {
      return placeFire(host.session().sim, x, y, r, 600, 0)?.id ?? null
    },
  }),
})
