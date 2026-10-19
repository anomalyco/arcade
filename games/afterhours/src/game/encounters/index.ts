import type { GameContext } from "../flow"
import { createDeathScreen } from "../death"
import { clearCheckpoints, lastCheckpoint, restorePlayer, trackCheckpoints } from "../checkpoint"
import { OBJECTIVES, story } from "../objectives"
import { setObjective } from "../objective"
import { startLiftAmbush } from "./lift-ambush"

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
  const offTrack = trackCheckpoints(g.player)
  const canvas = g.world.renderer.domElement

  const ambush = startLiftAmbush(g, {
    flood: () => death.flood(),
    onKill: () => {
      // The world stops; the mouse is freed for the options. Paused first, so losing the lock doesn't open the menu.
      g.flow.setPaused(true)
      g.player.release()
      document.body.dataset.modal = "death"
      if (document.pointerLockElement === canvas) document.exitPointerLock()
      death.show({ canRestart: lastCheckpoint() !== null, restart, startOver })
    },
  })

  function restart() {
    const cp = lastCheckpoint()
    if (!cp) return startOver()
    delete document.body.dataset.modal
    death.hide()
    ambush.reset()
    restorePlayer(g.player, cp)
    story.stage = cp.stage
    setObjective([OBJECTIVES.transmission, OBJECTIVES.radio, OBJECTIVES.transmitter, OBJECTIVES.out][Math.min(3, cp.stage)]!)
    g.flow.hold = false
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
    delete document.body.dataset.modal
    death.hide()
  })
  return api
}
