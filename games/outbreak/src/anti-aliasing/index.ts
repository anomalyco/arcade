import type { Batch } from "@arcade/kit/gpu/renderer"
import { registerOutbreakClientFeature } from "../feature-registry"
import { antiAliasingControls, temporalSettings } from "./settings"

const NO_BATCHES: readonly Batch[] = []

/**
 * Anti-aliasing (AR-72): today's MSAA, or the shared renderer's temporal resolve (`@arcade/kit/gpu/temporal`), with
 * or without upscaling from a lower render scale. Backquote › Anti-aliasing; the values sit in the view settings.
 */
export const outbreakAntiAliasingFeature = registerOutbreakClientFeature({
  id: "antiAliasing",
  order: 5,
  labControls: () => antiAliasingControls,
  frame: {
    // Runs before the frame is submitted; contributes no batches.
    batches: (ctx) => {
      ctx.renderer.setTemporal(temporalSettings(ctx.settings.view))
      return NO_BATCHES
    },
  },
  harnessState: (host) => ({ antiAliasing: host.renderer.temporalState }),
})
