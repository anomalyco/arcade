import type { DeathState } from "../../shared/death/rules"
import { registerOutbreakClientFeature } from "../feature-registry"
import { controlKeyControls, type ControlSettings } from "./settings"

/** Real seconds into a solo run before closing the tab asks first (a fresh run is cheap to lose). */
const SOLO_GUARD_AFTER = 30

/** Whether closing the tab now would throw away a night: in a co-op room, or a solo run under way, and not over. */
export function guardsClose(s: Pick<ControlSettings, "askBeforeClose">, at: { inRoom: boolean; menuOpen: boolean; runOver: boolean; played: number }): boolean {
  if (!s.askBeforeClose || at.runOver || at.menuOpen) return false
  return at.inRoom || at.played >= SOLO_GUARD_AFTER
}

let armed = false
let played = 0
const onBeforeUnload = (e: BeforeUnloadEvent) => {
  if (!armed) return
  e.preventDefault()
  e.returnValue = ""
}

/**
 * Control keys (Backquote › Controls): crouch on Z instead of Ctrl, the map on M with mute moved to the speaker
 * button, and a leave-site prompt mid-night. Browsers hand Ctrl/Cmd+W (and Ctrl+T, Ctrl+N, Cmd+Q) to themselves before
 * the page sees them; only Keyboard Lock in fullscreen can take them, so the prompt is the one guard a page has.
 */
export const outbreakControlsFeature = registerOutbreakClientFeature({
  id: "controls",
  order: 61,
  labControls: () => controlKeyControls,
  frame: {
    overlay: (ctx) => {
      // Automation never arms it: a leave-site dialog would stall a proof's next navigation.
      if (typeof window === "undefined" || navigator.webdriver) return
      const lobby = ctx.coop.lobby
      const menuOpen = Boolean(lobby?.isOpen && lobby.mode !== "pause")
      played = menuOpen ? 0 : played + ctx.dt
      const runOver = Boolean(ctx.session.sim.getFeatureState<DeathState>("death")?.runOver)
      const want = guardsClose(ctx.settings.hud as unknown as ControlSettings, { inRoom: Boolean(ctx.coop.net), menuOpen, runOver, played })
      if (want !== armed) {
        armed = want
        if (armed) window.addEventListener("beforeunload", onBeforeUnload)
        else window.removeEventListener("beforeunload", onBeforeUnload)
      }
    },
  },
  harnessState: () => ({ controls: { closeGuard: armed } }),
})
