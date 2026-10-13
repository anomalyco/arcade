import type { PoseTuple, ShipTuple } from "../../shared/protocol"
import type { Sea } from "../../shared/sea"
import { type Ship, type ShipPose, copyShip, extrapolatePose, lerpShip, makeShip, shipFloat } from "../../shared/ship"

/** How fast a remote hull's drawn plan pose closes the gap to its dead-reckoned pose, and when it just snaps. */
const CORRECT_LAG = 0.5
const SNAP = 300

const wrap = (a: number) => a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2))

export const poseFromTuple = (p: PoseTuple): ShipPose => ({ t: p[0], x: p[1], z: p[2], heading: p[3], u: p[4], v: p[5], r: p[6], order: p[7], rudder: p[8] })
/** The pose in a room `ships` entry ([id, ...pose, power]). */
export const poseFromShip = (s: ShipTuple): ShipPose => ({ t: s[1], x: s[2], z: s[3], heading: s[4], u: s[5], v: s[6], r: s[7], order: s[8], rudder: s[9] })

/**
 * Another player's carrier. Only the plan pose comes over the network: it is dead-reckoned along its arc to our sea
 * time, the drawn hull glides onto it, and heave, pitch and roll are floated here on our own copy of the sea, so the
 * hull bobs in step with the water we draw (an interpolated heave would lag the waves; sea-of-thieves-water.md §6.3).
 */
class Remote {
  readonly ship: Ship
  readonly prev: Ship
  private target = { x: 0, z: 0, heading: 0 }
  private placed = false

  constructor(public pose: ShipPose) {
    this.ship = makeShip(pose.x, pose.z, pose.heading, pose.t)
    this.prev = makeShip(pose.x, pose.z, pose.heading, pose.t)
  }

  /** Starts from a hull we were already drawing (our own predicted ship as we leave its helm), so nothing jumps. */
  seed(s: Ship): void {
    copyShip(s, this.ship)
    copyShip(s, this.prev)
    this.placed = true
  }

  step(sea: Sea, t: number, dt: number): void {
    copyShip(this.ship, this.prev)
    const s = this.ship
    const p = this.pose
    extrapolatePose(p, t, this.target)
    if (!this.placed || Math.hypot(this.target.x - s.x, this.target.z - s.z) > SNAP) {
      this.placed = true
      s.x = this.target.x
      s.z = this.target.z
      s.heading = this.target.heading
    } else {
      // Move on our own velocity, then close the remaining error smoothly.
      const sh = Math.sin(s.heading)
      const ch = Math.cos(s.heading)
      s.x += (p.u * sh + p.v * ch) * dt
      s.z += (-p.u * ch + p.v * sh) * dt
      s.heading = wrap(s.heading + p.r * dt)
      const k = 1 - Math.exp(-dt / CORRECT_LAG)
      s.x += (this.target.x - s.x) * k
      s.z += (this.target.z - s.z) * k
      s.heading = wrap(s.heading + wrap(this.target.heading - s.heading) * k)
    }
    s.u = p.u
    s.v = p.v
    s.r = p.r
    s.order = p.order
    s.rudder = p.rudder
    s.t = t
    shipFloat(s, sea, dt)
  }
}

export class Remotes {
  readonly ships = new Map<number, Remote>()
  private draw = makeShip(0, 0, 0)

  /** Mirrors the room's latest poses: adds new ships, updates poses, drops sunk ones. `skip` (the ship this client
   *  predicts itself) is left out. */
  sync(poses: ReadonlyMap<number, ShipTuple>, skip = -1): void {
    for (const id of this.ships.keys()) if (!poses.has(id) || id === skip) this.ships.delete(id)
    for (const [id, tuple] of poses) {
      if (id === skip) continue
      const pose = poseFromShip(tuple)
      const r = this.ships.get(id)
      if (r) r.pose = pose
      else this.ships.set(id, new Remote(pose))
    }
  }

  /** Adds ship `id` (if the room has a pose for it) starting from the hull state `s`. */
  adopt(id: number, s: Ship, poses: ReadonlyMap<number, ShipTuple>): void {
    const tuple = poses.get(id)
    if (!tuple) return
    const r = new Remote(poseFromShip(tuple))
    r.seed(s)
    this.ships.set(id, r)
  }

  step(sea: Sea, t: number, dt: number): void {
    for (const r of this.ships.values()) r.step(sea, t, dt)
  }

  /** Each remote's drawn state between its last two steps. */
  *interpolated(k: number): Generator<[id: number, ship: Ship]> {
    for (const [id, r] of this.ships) yield [id, lerpShip(r.prev, r.ship, k, this.draw)]
  }
}
