import { registerOutbreakClientFeature } from "../feature-registry"
import { contactShadowControls, DEFAULT_CONTACT_SHADOW_SETTINGS, resolveContactShadows } from "./settings"

/**
 * Contact shadows on props (Lab › Look · Contact shadows, Today one setting away): volume slot 0 (`contact-shadows/wgsl.ts`),
 * fed each frame by `scene/frame-renderer.ts`.
 */
export const outbreakContactShadowsFeature = registerOutbreakClientFeature({
  id: "contact-shadows",
  order: 34,
  settingsGroup: { subsystem: "contactShadows", defaults: DEFAULT_CONTACT_SHADOW_SETTINGS },
  labControls: () => contactShadowControls,
  harnessState: (host) => {
    const s = resolveContactShadows(host.settings.contactShadows, host.qualityController.getProfile(), { ...host.settings.contactShadows })
    return { contactShadows: { on: s.contactShadowStyle > 0.5, lights: s.csLights, steps: s.csSteps } }
  },
})
