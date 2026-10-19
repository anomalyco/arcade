import type * as THREE from "three/webgpu"
import type { WorldContext } from "../world/context"
import type { Player } from "../player"
import { insideBuilding } from "../render/atmosphere"
import { CORE, INTERIOR } from "../world/layout"
import { audio, BUSES, prepareAudio, setLevels, setSpace, unlockAudio, type Bus } from "./context"
import { Sfx } from "./engine"
import { Footsteps } from "./footsteps"
import { Ambience } from "./ambience"
import { Horror } from "./horror"
import { LiftSounds } from "./lift"
import { hooks } from "./hooks"
import { resolveMode } from "../game/shell/mode"

// The game's audio: one context and mix (context.ts), the shipped samples (engine.ts, sfx-manifest.ts), and what plays
// them: footsteps, doors (world/doors/audio.ts through `hooks.sfx`), the lift (lift.ts through `hooks.lift`), ambience
// and weather, the horror layer, and the interface. Created by the player only when input is enabled, so never in
// `?shot` mode; silent until the first click or key press. One-shots are fetched and decoded in idle time a few
// seconds after boot (no input needed); loops load when first needed. Lab: Audio group (master and one level per bus).

const LEVELS: { key: string; bus: Bus | "master"; label: string; value: number }[] = [
  { key: "audio.master", bus: "master", label: "Master volume", value: 1 },
  { key: "audio.footsteps", bus: "footsteps", label: "Footsteps", value: 0.8 },
  { key: "audio.doors", bus: "doors", label: "Doors, lift & interactions", value: 0.85 },
  { key: "audio.ambience", bus: "ambience", label: "Ambience & weather", value: 0.75 },
  { key: "audio.horror", bus: "horror", label: "Horror & story sounds", value: 0.8 },
  { key: "audio.ui", bus: "ui", label: "Interface", value: 0.6 },
]

export class GameAudio {
  readonly sfx: Sfx
  readonly footsteps: Footsteps
  readonly ambience: Ambience
  readonly horror: Horror
  private unlocked = false
  private indoor = 0
  private ear = { x: 0, y: 0, z: 0 }

  constructor(
    private ctx: WorldContext,
    player: Player,
  ) {
    for (const l of LEVELS) {
      ctx.settings[l.key] ??= l.value
      ctx.controls.push({ key: l.key, label: l.label, group: "Audio", min: 0, max: l.bus === "master" ? 1.5 : 1.5, step: 0.05 })
    }
    // The horror layer (random scares, the Sublevel drone) is off in play mode until the owner wants it; /debug starts
    // with it on. Story sounds on the horror bus (the listening room's radio voices) are not part of it.
    ctx.settings["audio.horrorLayer"] ??= resolveMode() === "play" ? 0 : 1
    ctx.controls.push({ key: "audio.horrorLayer", label: "Horror layer (scares, drone)", group: "Audio", min: 0, max: 1, step: 0.05 })
    this.sfx = new Sfx(ctx.colliders)
    this.footsteps = new Footsteps(ctx, player, this.sfx)
    this.ambience = new Ambience(ctx, this.sfx)
    this.horror = new Horror(ctx, this.sfx)
    hooks.sfx = this.sfx
    hooks.lift = new LiftSounds(this.sfx, () => this.unlock())
    hooks.paper = () => this.paper()
    // Soon after the first frame, in idle time while the world is still streaming in behind the boot overlay: the
    // context (suspended, silent), its reverbs, then every one-shot fetched and decoded one at a time. The first key
    // press then only resumes the context.
    setTimeout(() => this.prepare(), 1200)
    ;(globalThis as { __afterhoursAudio?: GameAudio }).__afterhoursAudio = this
  }

  private prepared = false

  /** Everything that can be readied before input, in idle time. */
  private prepare() {
    if (this.prepared) return
    this.prepared = true
    const idle = globalThis.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 0))
    idle(
      () => {
        prepareAudio()
        this.sfx.prepare()
      },
      { timeout: 4000 },
    )
  }

  /** From a user-input handler: only creates/resumes the context (decoding is already under way in idle time). */
  unlock() {
    if (!unlockAudio()) return
    if (this.unlocked) return
    this.unlocked = true
    this.prepare()
  }

  update(dt: number, camera: THREE.PerspectiveCamera) {
    if (!audio()) return
    const s = this.ctx.settings
    const levels: Partial<Record<Bus, number>> = {}
    for (const l of LEVELS) if (l.bus !== "master") levels[l.bus] = Number(s[l.key] ?? l.value)
    setLevels(Number(s["audio.master"] ?? 1), levels)
    this.sfx.setListener(camera)
    const p = camera.position
    this.ear.x = p.x
    this.ear.y = p.y
    this.ear.z = p.z
    this.indoor += ((insideBuilding(p) ? 1 : 0) - this.indoor) * (1 - Math.exp(-dt * 3))
    const inRect = (r: { min: readonly [number, number]; max: readonly [number, number] }) => p.x >= r.min[0] && p.x <= r.max[0] && p.z >= r.min[1] && p.z <= r.max[1]
    setSpace(this.indoor, inRect(CORE.stair) ? 1 : inRect(INTERIOR.lobby) ? 0.7 : 0.25)
    const e = camera.matrixWorld.elements
    const rl = Math.hypot(e[0]!, e[2]!) || 1
    this.ambience.right.x = e[0]! / rl
    this.ambience.right.z = e[2]! / rl
    const scares = Number(s["audio.horrorLayer"] ?? 0)
    this.ambience.horrorLevel = scares
    this.horror.level = scares
    this.ambience.update(dt, this.ear, this.indoor)
    this.horror.update(dt, this.ear, this.indoor)
  }

  /** The flashlight's switch. */
  flashlight() {
    this.sfx.play("int-flashlight", { bus: "doors", gain: 0.7, jitter: 0.02 })
  }

  /** Picking up or reading a document (hook for the documents feature: `paperSound()` in hooks.ts). */
  paper() {
    this.sfx.play("int-paper", { bus: "doors", gain: 0.7 })
  }

  /** Automation: a MediaStream of the final mix (for recording a walk). */
  tap(): MediaStream | null {
    const a = audio()
    if (!a) return null
    const dest = a.ctx.createMediaStreamDestination()
    a.master.connect(dest)
    return dest.stream
  }

  /** Bus names (automation). */
  static readonly buses = BUSES
}
