import type { DeathState } from "../../shared/death/rules"
import { localSlot } from "../death/spectate"
import { registerOutbreakClientFeature, type OutbreakClientFrameContext } from "../feature-registry"
import { controlKeyControls, type ControlSettings } from "./settings"

/** Real seconds into a solo run before closing the tab asks first (a fresh run is cheap to lose). */
const SOLO_GUARD_AFTER = 30

/**
 * Whether closing the tab now would throw away a night: in a co-op room, or a solo run under way, and not over. Any
 * open menu (the pause menu included: Restart, New town and Play seed navigate from it) and being dead don't ask.
 */
export function guardsClose(
  s: Pick<ControlSettings, "askBeforeClose">,
  at: { inRoom: boolean; menuOpen: boolean; runOver: boolean; dead: boolean; played: number },
): boolean {
  if (!s.askBeforeClose || at.runOver || at.menuOpen || at.dead) return false
  return at.inRoom || at.played >= SOLO_GUARD_AFTER
}

/** The latest frame's state, read again when the tab closes (the pause menu stops frames, so a flag would go stale). */
let latest: OutbreakClientFrameContext | null = null
let session: object | null = null
let played = 0
let listening = false

function closeState(ctx: OutbreakClientFrameContext) {
  const lobby = ctx.coop.lobby
  const death = ctx.session.sim.getFeatureState<DeathState>("death")
  return {
    inRoom: Boolean(ctx.coop.net),
    menuOpen: Boolean(lobby?.isOpen),
    runOver: Boolean(death?.runOver),
    dead: death?.records[localSlot(ctx.session).index]?.state === "dead",
    played,
  }
}

const asks = () => Boolean(latest && guardsClose(latest.settings.hud as unknown as ControlSettings, closeState(latest)))

const onBeforeUnload = (e: BeforeUnloadEvent) => {
  if (!asks()) return
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
      // Automation never asks: a leave-site dialog would stall a proof's next navigation.
      if (typeof window === "undefined" || navigator.webdriver) return
      latest = ctx
      // A new session (a restart, the death card's Again, a room) starts the half minute again.
      if (ctx.session !== session) {
        session = ctx.session
        played = 0
      }
      const state = closeState(ctx)
      played = state.menuOpen || state.runOver || state.dead ? 0 : played + ctx.dt
      if (!listening) {
        listening = true
        window.addEventListener("beforeunload", onBeforeUnload)
      }
    },
  },
  harnessState: () => ({ controls: { closeGuard: asks() } }),
})
