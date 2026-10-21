import type { GameContext } from "../flow"
import { createDeathScreen } from "../death"
import { clearCheckpoints, lastCheckpoint, restorePlayer, trackCheckpoints } from "../checkpoint"
import { objectiveText, story } from "../objectives"
import { setObjective } from "../objective"
import { startLiftAmbush } from "./lift-ambush"
import { bindRoadAmbush } from "./road-ambush"
import { clearDeath, playDeath, prepareDeathLights } from "../death/variants"
import * as THREE from "three/webgpu"
import type { Box } from "../../world/context"
import { hunterHandle, type HunterHandle } from "../hunter"

// Scripted monster encounters for a run (play mode), and what happens when one kills you: the death screen, restart
// from the last checkpoint (in place: the player put back, the beat re-armed) or start over (a fresh page straight
// into the intro: the world's story state — the transmitter, the doors, the lift — is easiest to reset by reloading).
// Started by the play shell just before explore; stopped with the run's signal.

/** sessionStorage key the play shell checks once the world is warm: start a run without the home screen. */
export const AUTOPLAY_KEY = "ashwood.autoplay"

export type EncounterShell = {
  /** Unpauses and recaptures the mouse (the shell's resume, without its menu). */
  resume: () => void
}

export function startEncounters(g: GameContext, shell: EncounterShell) {
  const death = createDeathScreen()
  bindRoadAmbush(g)
  const offTrack = trackCheckpoints(g.player)
  const lights = prepareDeathLights(g.scene)
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
  // The kill is played on the hunter's OWN body (no second creature, no swap, no teleport): face to face it mauls you
  // from exactly where it is (variants.ts "maul"); from behind or the side the view is wrenched round to it
  // ("spin", aimed at its actual side). The kill is also started a little before the brain's own catch distance
  // while it's rushing you head-on, so it never runs past or through the camera first.
  let wired: HunterHandle | null = null
  let bodyWas: unknown = undefined
  const _to = new THREE.Vector3()
  const _view = new THREE.Vector3()
  /** cos of the angle between the view and the direction to the hunter (horizontal). */
  const lookingAt = (p: THREE.Vector3) => {
    g.camera.getWorldDirection(_view)
    _to.set(p.x - g.camera.position.x, 0, p.z - g.camera.position.z).normalize()
    _view.y = 0
    return _view.normalize().dot(_to)
  }
  const killByHunter = (h: HunterHandle) => {
    if (dying) return
    dying = true
    const hunter = h.hunter
    const body = hunter.creature
    const at = (body?.root.position ?? hunter.pos).clone()
    const vel = hunter.vel.clone()
    // The brain stops driving it (dormant hides it) and the scene drives the same body from this frame on.
    h.sleep()
    if (!body?.rig) {
      death.flood()
      setTimeout(() => ambushHooksKill(), 400)
      return
    }
    body.root.visible = true
    // The player's own body would be in shot once the view is wrenched round or shoved out of it.
    bodyWas = g.ctx.settings["body.show"]
    g.ctx.settings["body.show"] = false
    g.flow.hold = true
    g.player.release()
    ambush.hud(true)
    void playDeath(lookingAt(at) > 0.3 ? "maul" : "spin", {
      camera: g.camera,
      wendigo: body,
      ground: at.y,
      from: at,
      velocity: vel,
      tick: (fn) => g.flow.onUpdate(fn),
      scream: () => ambush.scream(),
      chatter: () => ambush.chatter(),
      flood: () => death.flood(),
      lights,
      ceiling: at.y + 2.94,
      canvas: g.world.renderer.domElement,
      free: (from, dir) => freeAlong(g.ctx.colliders, from, dir),
    }).then(() => ambushHooksKill())
  }
  const offWire = g.flow.onUpdate(() => {
    const h = hunterHandle()
    if (!h) return
    if (h !== wired) {
      wired = h
      h.setCatchHandler(() => killByHunter(h))
    }
    // Head-on rush: take over while it's still in front of the camera (~3 m), before the brain's own catch.
    const hn = h.hunter
    if (dying || hn.grace > 0 || (hn.mode !== "hunt" && hn.mode !== "investigate") || !hn.creature?.root.visible) return
    const p = g.camera.position
    const dx = p.x - hn.pos.x
    const dz = p.z - hn.pos.z
    const d = Math.hypot(dx, dz)
    if (d > 3.1 || Math.abs(p.y - 1.6 - hn.pos.y) > 1.3) return
    const closing = (hn.vel.x * dx + hn.vel.z * dz) / Math.max(d, 1e-3)
    if (closing < 1.2 || lookingAt(hn.pos) < 0.3) return
    if (!h.nav.sees(hn.s, hn.pos.x, hn.pos.y + 1.1, hn.pos.z, p.x, p.y - 0.5, p.z)) return
    killByHunter(h)
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
    clearDeath(ambush.creature(), lights)
    clearDeath(hunterHandle()?.hunter.creature ?? null, lights)
    if (bodyWas !== undefined) g.ctx.settings["body.show"] = bodyWas as never
    bodyWas = undefined
    ambush.reset()
    restorePlayer(g.player, cp)
    story.stage = cp.stage
    story.revealed = cp.stage >= 4
    setObjective(objectiveText(cp.stage))
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

/** Free horizontal distance from a point along a direction against the colliders at body height (death scenes). */
function freeAlong(colliders: readonly Box[], from: THREE.Vector3, dir: THREE.Vector3) {
  let best = 40
  for (const b of colliders) {
    if (b.max[1] < from.y - 1.3 || b.min[1] > from.y - 0.2) continue
    let t0 = 0
    let t1 = best
    let hit = true
    for (const [o, d, lo, hi] of [
      [from.x, dir.x, b.min[0], b.max[0]],
      [from.z, dir.z, b.min[2], b.max[2]],
    ] as const) {
      if (Math.abs(d) < 1e-9) {
        if (o < lo || o > hi) hit = false
        continue
      }
      let a = (lo - o) / d
      let c = (hi - o) / d
      if (a > c) [a, c] = [c, a]
      t0 = Math.max(t0, a)
      t1 = Math.min(t1, c)
    }
    if (hit && t0 <= t1 && t0 > 0.05) best = Math.min(best, t0)
  }
  return best
}
