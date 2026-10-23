import { ArachnidLegs, arachnidLocal, interpolateArachnidPose, type ArachnidPose } from "@arcade/kit/creature/arachnid-legs"
import { ArachnidView, arachnidLook } from "@arcade/kit/creature/arachnid-view"
import { arachnidControls, arachnidScale, arachnidShape, createArachnidSettings, type ArachnidSettings } from "@arcade/kit/creature/arachnid-settings"
import type { Batch, Renderer } from "@arcade/kit/gpu/renderer"
import type { LabControl } from "@arcade/kit/lab-panel"
import { lerpAngle } from "@arcade/kit/net/interpolate"
import { CREATURE_STEP, createCreatureMotion, unitDt, unitSurface, type CreatureSurface } from "@arcade/kit/sim/creature-motion"
import { spiderSurface, type StalkerPose } from "../shared/stalker"
import type { WoodsWorld } from "../shared/world"
import type { SpiderEye } from "./eyeshine"

/**
 * The spider as drawn: the kit's harvestman legs (`ArachnidLegs`) walking under the shared root (`shared/stalker.ts`,
 * smoothed by the session), drawn with `ArachnidView`. The legs are presentation, so each client runs its own from the
 * same root: feet land in slightly different spots on different machines, which nobody can see at 20–100 m.
 *
 * The root comes as a pose per frame; the legs step at the kit's fixed 60 Hz between the last frame's pose and this
 * one's, with a velocity eased from the root's travel, and are drawn between their last two steps. A jump (a beat
 * starting somewhere out of sight) re-stands them where the root lands.
 */
export class SpiderView {
  /** Look and gait knobs (the Lab's harvestman defaults; `SPIDER_SIZE` is the shared root's scale). */
  readonly settings: ArachnidSettings = createArachnidSettings()
  /** Touchdowns since the last frame (m), for its footfalls. */
  readonly steps: { x: number; y: number; z: number }[] = []
  private view: ArachnidView
  private legs: ArachnidLegs | null = null
  private ground: CreatureSurface | null = null
  private groundSize = 0
  private root = createCreatureMotion(0, 0)
  private jump = -1
  private last: StalkerPose | null = null
  private vx = 0
  private vz = 0
  private spin = 0
  private acc = 0
  private previous: ArachnidPose | null = null
  private current: ArachnidPose | null = null
  /** The pose drawn this frame, or null without a spider. */
  pose: ArachnidPose | null = null

  constructor(renderer: Renderer, private world: WoodsWorld) {
    this.view = new ArachnidView(renderer, arachnidLook(this.settings))
  }

  /** A new woods (the Lab's trunk density): its ground, and the legs stood again. */
  setWorld(world: WoodsWorld): void {
    this.world = world
    this.ground = null
    this.jump = -1
  }

  /** The spider's knobs for the Lab panel: look changes rebuild the meshes, shape changes re-stand the legs. */
  controls(): LabControl[] {
    return arachnidControls(this.settings, { group: "Spider", change: () => { this.view.setShape(arachnidLook(this.settings)); this.jump = -1 } })
  }

  private surface(size: number): CreatureSurface {
    if (!this.ground || this.groundSize !== size) { this.ground = unitSurface(spiderSurface(this.world), size); this.groundSize = size }
    return this.ground
  }

  /** Steps the legs to this frame's root (`null`: no spider) and returns its batches. */
  frame(p: StalkerPose | null, dt: number): Batch[] {
    this.steps.length = 0
    if (!p) { this.legs = null; this.pose = null; this.last = null; return [] }
    const size = arachnidScale(this.settings), ground = this.surface(size), r = this.root
    if (!this.legs || !this.last || p.jump !== this.jump) {
      Object.assign(r, { x: p.x / size, z: p.z / size, heading: p.heading, vx: 0, vz: 0, angularVelocity: 0, desiredVx: 0, desiredVz: 0, turn: "travel", run: 0 })
      this.legs = new ArachnidLegs(r, ground, size, arachnidShape(this.settings))
      this.previous = this.current = this.legs.pose()
      this.jump = p.jump
      this.last = p
      this.vx = this.vz = this.spin = this.acc = 0
    }
    const from = this.last
    if (dt > 0) {
      // The root's travel this frame, eased so a snapshot's step doesn't jolt the stride.
      const k = 1 - Math.exp(-dt * 5)
      this.vx += ((p.x - from.x) / dt - this.vx) * k
      this.vz += ((p.z - from.z) / dt - this.vz) * k
      this.spin += (lerpAngle(0, p.heading - from.heading, 1) / dt - this.spin) * k
    }
    this.acc = Math.min(this.acc + dt, 0.25)
    const n = Math.floor(this.acc / CREATURE_STEP), rs = Math.sqrt(size)
    for (let i = 0; i < n; i++) {
      const t = (i + 1) / n
      // Creature units: lengths ÷ S, speeds ÷ √S (Froude).
      r.x = (from.x + (p.x - from.x) * t) / size
      r.z = (from.z + (p.z - from.z) * t) / size
      r.heading = lerpAngle(from.heading, p.heading, t)
      r.vx = r.desiredVx = this.vx / rs
      r.vz = r.desiredVz = this.vz / rs
      r.angularVelocity = this.spin * rs
      this.legs.step(r, ground, unitDt(CREATURE_STEP, size))
      for (const c of this.legs.contacts) this.steps.push({ x: c.x, y: c.y, z: c.z })
      this.previous = this.current
      this.current = this.legs.pose()
    }
    this.acc -= n * CREATURE_STEP
    this.last = p
    this.pose = interpolateArachnidPose(this.previous!, this.current!, this.acc / CREATURE_STEP)
    return this.view.frame([this.pose])
  }

  /** Its two eyes on the turret (m), each looking out to its side. */
  eyes(): SpiderEye[] {
    const p = this.pose
    if (!p) return []
    const h = this.settings.hips
    const at = arachnidLocal(p, [0.13 * h, 0.13 * h, 0])
    return [-1, 1].map((side) => {
      const o = arachnidLocal(p, [0.13 * h, 0.13 * h, side * 0.03 * h])
      const nx = o[0] - at[0], nz = o[2] - at[2], l = Math.hypot(nx, nz) || 1
      return { p: [o[0], o[1], o[2]], n: [nx / l, 0, nz / l] }
    })
  }
}
