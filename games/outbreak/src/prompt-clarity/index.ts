import { holdProgress } from "../../shared/interact"
import { registerOutbreakClientFeature } from "../feature-registry"
import { TargetHighlight, targetScreenBox } from "./highlight"
import { clarityOn, promptClarityControls, type PromptClaritySettings } from "./settings"
import { StampLayer, StateWatch } from "./stamps"
import "./clarity.css"

/**
 * Prompt clarity (AR-89, after Aiden: "everything is E. I can't tell if I'm opening/closing/boarding"): the
 * outline on what E acts on and the stamp that rises off a target when it changes. The verbs that stay while an action
 * is new and B in door and window prompts are drawn by the world prompt (`src/inventory-hud.ts`) from `teach.ts` and
 * `board.ts`. Settings: Backquote › Controls (values in the HUD settings).
 */
let highlight: TargetHighlight | null = null
let stamps: StampLayer | null = null
const watch = new StateWatch()
let lastTarget = ""

export const outbreakPromptClarityFeature = registerOutbreakClientFeature({
  id: "promptClarity",
  order: 61,
  labControls: () => promptClarityControls,
  frame: {
    overlay: (ctx) => {
      if (typeof document === "undefined") return
      const s = ctx.settings.hud as unknown as PromptClaritySettings
      const view = ctx.session.view
      const p = view.player
      highlight ??= new TargetHighlight()
      stamps ??= new StampLayer()
      const target = view.prompt
      const show = clarityOn(s, "promptHighlight") && target && !view.peek && !p.vehicleId && !p.vault
      const box = show ? targetScreenBox(ctx.cam, view.town, target, ctx.w, ctx.h) : null
      lastTarget = box && target ? `${target.kind}:${target.id}` : ""
      highlight.update(lastTarget, box, holdProgress(p), ctx.dt)
      const events = watch.step(view, ctx.session)
      if (clarityOn(s, "promptStamp")) for (const ev of events) stamps.add(ev)
      const promptEl = stamps.count ? document.getElementById("prompt") : null
      stamps.draw(view, ctx.cam, ctx.w, ctx.h, ctx.dt, promptEl && !promptEl.hidden ? promptEl.getBoundingClientRect() : null)
    },
  },
  harnessState: () => ({ promptClarity: { outlined: lastTarget || null, stamps: stamps?.count ?? 0 } }),
})
