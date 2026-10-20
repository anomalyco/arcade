import type { Player } from "../../player"
import type { WorldContext, Lamp } from "../../world/context"
import { hooks, type LiftAudio } from "../../audio/hooks"
import { surfaceAt } from "../../audio/surfaces"
import { CORE } from "../../world/layout"
import { emitNoise, type NoiseEvent } from "./noise"
import { type NavGraph, type DoorInternals, storeyOf } from "./nav"

// What the hunter can perceive, and where the player's noises come from.
//
// Noise sources (all go through `emitNoise`, so other systems can add their own):
//  - footsteps (Player.onStep): crouch-walk 1.5 m, walk ~7 m, jog ~10 m, scaled by the floor (carpet 0.6×, raised
//    access floor 1.2×, steel 1.3×); a sprint (over 2.6 m/s) 18–40 m, carpet only 0.85×; landings 6–14 m; jumps 3 m;
//  - doors: every leaf the player (or a closer) moves: the latch releasing 6–8 m, a door banged open at a run or
//    slammed shut up to 18 m; doors the hunter drives itself are its own, not noises it hears;
//  - the flashlight's click 2.5 m; the lift's clunks 14–28 m and its motor (16 m) while it runs, heard up and down the
//    shaft.
// Hearing: a noise is heard when its effective distance (straight distance + 3.5 m per wall-height solid on the line +
// 9 m per storey between; a sprint 2 m per wall and 4 m per storey, the lift 3 m per storey) is inside its radius × the Lab's Hearing. The position
// heard is fuzzed by up to 3.5 m the fainter it was (snapped to the building), so it never pinpoints you.
// Sight: a cone (55° half-angle, 80° once hunting, almost all round within 2.5 m) out to a range set by the light
// on you (lamps of your storey), your flashlight (on: seen 3× further, and a beam pointed at it gives you away),
// crouching (0.6×) and keeping still (0.8×), tested by ray against walls, furniture and door leaves.

export type Heard = { e: NoiseEvent; strength: number; x: number; y: number; z: number; s: number; t: number; heard: boolean; eff: number }

/** Footsteps faster than this (m/s) are a sprint. */
const SPRINT = 2.6
/** Footstep loudness by floor finish. */
const SURFACE_K: Record<string, number> = { carpet: 0.6, raised: 1.2, metal: 1.3, grating: 1.3, concrete: 1.05, tile: 1.05 }

export class PlayerNoises {
  private offs: (() => void)[] = []
  private doorPrev = new Map<string, number>()
  private flash: boolean
  private liftT = 0

  constructor(
    private ctx: WorldContext,
    private player: Player,
    /** Doors the hunter itself is moving (excluded). */
    private ownDoors: Set<string>,
  ) {
    const s = player.state
    this.flash = s.flashlight
    this.offs.push(
      player.onStep((e) => {
        const p = s.pos
        if (e.kind === "jump") return emitNoise(p, 3, "step")
        if (e.kind === "land") return emitNoise(p, 6 + 8 * e.intensity, "land")
        const surface = surfaceAt(e.surface, p.x, p.y, p.z)
        const k = SURFACE_K[surface] ?? 1
        // Sprinting pounds: 18 m at 2.6 m/s up to 40 m at full speed (4.5), barely softened by carpet, and it carries
        // through walls and floors (see `noiseDistance`). Walking and crouching stay quiet.
        if (s.crouch <= 0.5 && e.speed > SPRINT) return emitNoise(p, (18 + (22 * (Math.min(4.5, e.speed) - SPRINT)) / (4.5 - SPRINT)) * Math.max(0.85, k), "sprint")
        const r = s.crouch > 0.5 ? 1.5 : Math.min(18, 1.5 + 3.6 * e.speed)
        emitNoise(p, r * k, "step")
      }),
    )
    for (const d of ctx.doors.all()) this.doorPrev.set(d.id, d.amount)
    // The lift: wrap the game audio's lift hook so its clunks and motor are noises at the car.
    const inner = hooks.lift
    if (inner) {
      const car = { x: (CORE.lift.min[0] + CORE.lift.max[0]) / 2, y: 0, z: (CORE.lift.min[1] + CORE.lift.max[1]) / 2 }
      const wrapped: LiftAudio = {
        unlock: () => inner.unlock(),
        clunk: (strength) => {
          inner.clunk(strength)
          emitNoise(car, 14 + 14 * Math.min(1, strength), "lift")
        },
        update: (phase, vel, light, carY) => {
          inner.update(phase, vel, light, carY)
          car.y = carY
          if (Math.abs(vel) > 0.05) {
            this.liftT -= 1 / 60
            if (this.liftT <= 0) {
              this.liftT = 1.5
              emitNoise(car, 16, "lift")
            }
          }
        },
      }
      hooks.lift = wrapped
      this.offs.push(() => {
        if (hooks.lift === wrapped) hooks.lift = inner
      })
    }
  }

  /** Per frame: doors and the flashlight are polled. */
  update(dt: number) {
    const s = this.player.state
    if (s.flashlight !== this.flash) {
      this.flash = s.flashlight
      emitNoise(s.eye, 2.5, "flashlight")
    }
    for (const d of this.ctx.doors.all() as readonly DoorInternals[]) {
      const prev = this.doorPrev.get(d.id) ?? d.amount
      const now = d.amount
      if (now === prev) continue
      this.doorPrev.set(d.id, now)
      if (d.driven || this.ownDoors.has(d.id) || d.height < 1.2) continue
      const v = Math.abs(now - prev) / Math.max(1e-3, dt)
      const c = this.ctx.doors.centreOf(d.id)
      if (!c) continue
      c.y -= d.height / 2
      if (prev < 0.02 && now >= 0.02) emitNoise(c, v > 1.6 ? 18 : 7, "door")
      else if (prev > 0.02 && now <= 0.02) emitNoise(c, 6 + Math.min(12, v * 6), "door")
    }
  }

  dispose() {
    for (const o of this.offs) o()
    this.offs = []
  }
}

/** Light on the player from their storey's lamps (0 dark … 1 well lit). */
export function lightAt(lamps: readonly Lamp[], x: number, y: number, z: number) {
  let sum = 0
  for (const l of lamps) {
    const dy = l.position[1] - y
    if (dy < -0.5 || dy > 3.5) continue
    const dx = l.position[0] - x
    const dz = l.position[2] - z
    const d2 = dx * dx + dz * dz
    if (d2 > l.range * l.range) continue
    const f = 1 - Math.sqrt(d2 + dy * dy) / l.range
    if (f <= 0) continue
    sum += l.intensity * f * f
  }
  return 1 - Math.exp(-sum / 6)
}

/** Effective distance of a noise at the listener (m), and the storeys between. */
export function noiseDistance(nav: NavGraph, e: NoiseEvent, ear: { x: number; y: number; z: number }) {
  const d = Math.hypot(e.x - ear.x, (e.y - ear.y) * 0.5, e.z - ear.z)
  const storeys = Math.abs(storeyOf(e.y) - storeyOf(ear.y))
  const walls = nav.hits(e.x, e.y + 1.0, e.z, ear.x, ear.y + 1.0, ear.z, 5, true)
  // A sprint's pounding and the lift's machinery travel through the structure: walls and slabs cost them far less.
  if (e.kind === "sprint") return d + walls * 2 + storeys * 4
  return d + walls * 3.5 + storeys * (e.kind === "lift" ? 3 : 9)
}

export { storeyOf }
