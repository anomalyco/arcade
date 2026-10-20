import type { GameContext } from "../flow"
import { createDeathScreen } from "../death"
import { clearCheckpoints, lastCheckpoint, restorePlayer, trackCheckpoints } from "../checkpoint"
import { CHAIN, story } from "../objectives"
import { setObjective } from "../objective"
import { startLiftAmbush } from "./lift-ambush"
import { bindRoadAmbush } from "./road-ambush"
import { hunterHandle, type HunterHandle } from "../hunter"

// Scripted monster encounters for a run (play mode), and what happens when one kills you: the death screen, restart
// from the last checkpoint (in place: the player put back, the beat re-armed) or start over (a fresh page straight
// into the intro: the world's story state — the transmitter, the doors, the lift — is easiest to reset by reloading).
// Started by the play shell just before explore; stopped with the run's signal.

/** sessionStorage key the play shell checks once the world is warm: start a run without the home screen. */
export const AUTOPLAY_KEY = "afterhours.autoplay"

export type EncounterShell = {
  /** Unpauses and recaptures the mouse (the shell's resume, without its menu). */
  resume: () => void
}

export function startEncounters(g: GameContext, shell: EncounterShell) {
  const death = createDeathScreen()
  bindRoadAmbush(g)
  const offTrack = trackCheckpoints(g.player)
  const canvas = g.world.renderer.domElement

  // One death at a time: whichever of the lift ambush and the hunter starts first has the kill.
  let dying = false
  const ambush = startLiftAmbush(g, {
    flood: () => death.flood(),
    busy: () => dying,
    // The lift ambush has the player: the hunter goes quiet so it can't catch them mid-scare.
    onAmbush: () => {
      dying = true
      hunterHandle()?.sleep()
    },
    onKill: () => {
      // The world stops; the mouse is freed for the options. Paused first, so losing the lock doesn't open the menu.
      g.flow.setPaused(true)
      g.player.release()
      document.body.dataset.modal = "death"
      if (document.pointerLockElement === canvas) document.exitPointerLock()
      death.show({ canRestart: lastCheckpoint() !== null, restart, startOver })
    },
  })

  // The hunter (src/game/hunter) is installed after explore starts: hand it our death path once it exists.
  let wired: HunterHandle | null = null
  const offWire = g.flow.onUpdate(() => {
    const h = hunterHandle()
    if (!h || h === wired) return
    wired = h
    h.setCatchHandler(() => {
      if (dying) return
      dying = true
      const body = h.hunter.creature
      const at = body?.root.position ?? h.hunter.pos
      // Its body goes dormant; the kill cam's (warmed) body takes its place, same spot, heading and stance.
      h.sleep()
      if (!ambush.killFrom({ x: at.x, y: at.y, z: at.z }, h.hunter.heading, h.hunter.stance)) {
        // Not warmed yet (shouldn't happen after 3-08): straight to the red.
        death.flood()
        setTimeout(() => ambushHooksKill(), 400)
      }
    })
  })
  const ambushHooksKill = () => {
    g.flow.setPaused(true)
    g.player.release()
    document.body.dataset.modal = "death"
    if (document.pointerLockElement === canvas) document.exitPointerLock()
    death.show({ canRestart: lastCheckpoint() !== null, restart, startOver })
  }

  function restart() {
    const cp = lastCheckpoint()
    if (!cp) return startOver()
    dying = false
    delete document.body.dataset.modal
    death.hide()
    ambush.reset()
    restorePlayer(g.player, cp)
    story.stage = cp.stage
    story.revealed = cp.stage >= 4
    setObjective(CHAIN[Math.min(CHAIN.length - 1, cp.stage)]!)
    g.flow.hold = false
    // The hunter: before the reveal it isn't in the building yet; after it, it comes back far away, memory wiped,
    // with a grace period.
    const h = hunterHandle()
    if (h) {
      if (cp.stage >= 4) h.restore()
      else h.sleep()
    }
    shell.resume()
  }

  function startOver() {
    clearCheckpoints()
    try {
      sessionStorage.setItem(AUTOPLAY_KEY, "1")
    } catch {}
    location.reload()
  }

  const api = { death, ambush, restart, startOver }
  ;(globalThis as { __ashwoodEncounters?: typeof api }).__ashwoodEncounters = api
  g.signal.addEventListener("abort", () => {
    offTrack()
    offWire()
    delete document.body.dataset.modal
    death.hide()
  })
  return api
}
