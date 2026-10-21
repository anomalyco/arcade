import { registerOutbreakClientFeature } from "../feature-registry"
import { bounceControls, bounceInput, DEFAULT_BOUNCE_SETTINGS } from "./settings"

/**
 * Bounced light (AR-115, D-47: on at ×3 by default; Lab › Bounced light, "Today (off)" one setting away): the kit's
 * plan-space bounce (`@arcade/kit/gpu/gi/plan-bounce`) runs on a 64 m grid around the camera's ground focus; the scene
 * adds it through the `bounce` hook (`wgsl.ts`, `shaders.ts`).
 */
export const outbreakBounceLightFeature = registerOutbreakClientFeature({
  id: "bounce-light",
  order: 17,
  settingsGroup: { subsystem: "bounce", defaults: DEFAULT_BOUNCE_SETTINGS },
  labControls: () => bounceControls,
  frame: {
    render: (ctx, input) => {
      const [x0, z0, x1, z1] = ctx.cam.groundRect(0)
      input.planBounce = bounceInput(ctx.settings.bounce, (x0 + x1) / 2, (z0 + z1) / 2)
    },
  },
  harnessMethods: (host) => ({
    /** A loaded pistol in hand, for muzzle-flash stills (`bounce-stills.ts`). */
    bounceArmPistol() {
      const view = host.discoveryHost.view()
      const ledger = view.progression.ledger
      if (ledger.count(view.actorId, "pistol") < 1) ledger.apply({ kind: "grant", actor: view.actorId, item: "pistol", count: 1 })
      const slot = view.progression.hotbar(view.actorId)?.slots.findIndex((s) => s?.item === "pistol") ?? -1
      if (slot >= 0) ledger.apply({ kind: "select", actor: view.actorId, slot })
      ledger.apply({ kind: "setCharge", actor: view.actorId, item: "pistol", charge: 8 })
      const sim = host.session().sim
      const me = sim.slot(view.actorId)
      if (me) sim.progression.project(me)
    },
    /** GPU time of the current frame input (ms, timestamp queries), for paired cost runs. */
    bounceMeasure() {
      return host.renderer.measure(host.render)
    },
  }),
  harnessState: (host) => ({
    bounce: { on: host.settings.bounce.bouncedLight >= 0.5, strength: host.settings.bounce.bounceStrength },
  }),
})
