import type * as THREE from "three/webgpu"
import type { World } from "../boot/world"
import type { Player } from "../player"
import type { WorldContext } from "../world/context"

// The play-mode phase machine (src/game/shell drives it): menu → title → intro → explore, plus a pause flag. Later
// systems (map, objectives, monster) hook in through `onPhase`, `onPause` and `onUpdate` instead of the frame loop.
// Debug mode (/debug, automation) never creates a Flow.

export type Phase = "menu" | "title" | "intro" | "explore"

/** Per-frame hook: runs before the world renders, only while a run is under way (not in the menu) and not paused. */
export type UpdateHook = (dt: number, time: number) => void

export class Flow {
  phase: Phase = "menu"
  paused = false
  /** Lets the player walk before `explore` (an intro that hands over control early). Reset on every phase change. */
  playerControl = false
  /** A scripted moment (src/game/encounters) has the camera: the controller neither reads input nor moves. */
  hold = false
  private phaseListeners = new Set<(to: Phase, from: Phase) => void>()
  private pauseListeners = new Set<(paused: boolean) => void>()
  private updates = new Set<UpdateHook>()

  /** True when the controller should read input and move this frame. */
  get playerActive() {
    return !this.paused && !this.hold && (this.phase === "explore" || this.playerControl)
  }

  set(phase: Phase) {
    const from = this.phase
    if (from === phase) return
    this.phase = phase
    this.playerControl = false
    this.hold = false
    if (phase === "menu") this.setPaused(false)
    for (const l of this.phaseListeners) l(phase, from)
  }

  setPaused(paused: boolean) {
    if (this.paused === paused) return
    this.paused = paused
    for (const l of this.pauseListeners) l(paused)
  }

  /** Called on every phase change with the new and previous phase. Returns an unsubscribe function. */
  onPhase(listener: (to: Phase, from: Phase) => void) {
    this.phaseListeners.add(listener)
    return () => void this.phaseListeners.delete(listener)
  }

  onPause(listener: (paused: boolean) => void) {
    this.pauseListeners.add(listener)
    return () => void this.pauseListeners.delete(listener)
  }

  /** Per-frame hook (see UpdateHook). Returns an unsubscribe function. */
  onUpdate(hook: UpdateHook) {
    this.updates.add(hook)
    return () => void this.updates.delete(hook)
  }

  /** The shell calls this once per frame, before the world renders. */
  update(dt: number, time: number) {
    if (this.phase === "menu" || this.paused) return
    for (const u of this.updates) u(dt, time)
  }
}

/** What a run hands to the systems it starts (the intro's `runIntro(ctx)`, and later the map, objectives, monster). */
export type GameContext = {
  world: World
  /** The shared world context (scene, colliders, doors, lamps, settings). */
  ctx: WorldContext
  player: Player
  camera: THREE.PerspectiveCamera
  scene: THREE.Scene
  flow: Flow
  /** HUD layer for prompts and captions (pointer-events off). */
  hud: HTMLElement
  /** Aborted when the player quits to the title: stop timers, remove hooks and HUD elements. */
  signal: AbortSignal
}
