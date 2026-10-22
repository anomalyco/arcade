import { registerOutbreakClientFeature } from "../feature-registry"
import { contactShadowControls, DEFAULT_CONTACT_SHADOW_SETTINGS } from "./settings"

/**
 * Contact shadows on props (Lab › Look · Contact shadows, Today one setting away): volume slot 0 (`contact-shadows/wgsl.ts`),
 * fed each frame by `scene/frame-renderer.ts`.
 */
export const outbreakContactShadowsFeature = registerOutbreakClientFeature({
  id: "contact-shadows",
  order: 34,
  settingsGroup: { subsystem: "contactShadows", defaults: DEFAULT_CONTACT_SHADOW_SETTINGS },
  labControls: () => contactShadowControls,
  harnessState: (host) => ({ contactShadows: { on: host.settings.contactShadows.contactShadowStyle > 0.5 } }),
})
