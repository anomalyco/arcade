import type { Crew } from "../../shared/crew"
import { playerOf } from "../../shared/crew"
import { placeLocal } from "../../shared/landing"
import { launchPose } from "../../shared/launch"
import { type Plane, type Quat, makePlane, quatSlerp, setPlaneQuat } from "../../shared/plane"
import type { PlaneTuple } from "../../shared/protocol"
import type { Ship } from "../../shared/ship"
import { vehicleOfCode } from "../../shared/vehicles"
import type { PlaneDrawPose } from "../render/plane-pass"

/** Remote jets are drawn this far behind the newest pose (s): two relay frames at 20 Hz, so we almost always have a
 *  pose on each side. */
const DELAY = 0.12
/** Past the newest pose, flying jets coast on their velocity for at most this long (s). */
const COAST = 0.4
const KEEP = 12

type Remote = { snaps: PlaneTuple[]; ship: number; pose: PlaneDrawPose; vapourG: number }

const qa: Quat = [0, 0, 0, 1]
const qb: Quat = [0, 0, 0, 1]
const qc: Quat = [0, 0, 0, 1]

/**
 * Other players' jets from the relayed poses (shared/protocol.ts PlaneTuple). Drawn DELAY seconds in the past and
 * interpolated between the poses either side: flying jets with a cubic Hermite on position (using the sent velocities)
 * and a slerp on orientation; jets on the catapult by their ship-local z, and landing jets by their ship-local pose,
 * placed on this client's copy of their carrier, so launches and traps on someone else's ship stay glued to the deck. Crashed jets are not drawn; jets whose slot was
 * freed disappear.
 */
export class RemotePlanes {
  readonly jets = new Map<number, Remote>()
  private scratch: Plane = makePlane()

  sync(planes: ReadonlyMap<number, PlaneTuple>, crew: Crew | null): void {
    for (const id of this.jets.keys()) {
      const p = crew && playerOf(crew, id)
      if (!planes.has(id) || !p || p.plane < 0) this.jets.delete(id)
    }
    for (const [id, tuple] of planes) {
      const p = crew && playerOf(crew, id)
      if (!p || p.plane < 0) continue
      let r = this.jets.get(id)
      if (!r) {
        r = { snaps: [], ship: p.ship, vapourG: 0, pose: { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, pitch: 0, roll: 0, gear: 1, throttle: 0, burner: 0 } }
        this.jets.set(id, r)
      }
      r.ship = p.ship
      const last = r.snaps[r.snaps.length - 1]
      if (last && tuple[0] <= last[0]) continue
      r.snaps.push(tuple)
      if (r.snaps.length > KEEP) r.snaps.shift()
    }
  }

  /** Jets that crashed: where, and how long ago (s) at sea time t. */
  *crashes(t: number): Generator<{ id: number; x: number; y: number; z: number; age: number }> {
    const rt = t - DELAY
    for (const [id, r] of this.jets) {
      const s = r.snaps
      const last = s[s.length - 1]
      if (!last || last[1] !== 2) continue
      let first = last
      for (let i = s.length - 1; i >= 0 && s[i]![1] === 2; i--) first = s[i]!
      yield { id, x: first[2], y: first[3], z: first[4], age: rt - first[0] }
    }
  }

  /** Each jet's pose at sea time t (null for crashed or not yet placeable), with its id. */
  *poses(t: number, shipOf: (id: number) => Ship | null): Generator<[id: number, pose: PlaneDrawPose]> {
    const rt = t - DELAY
    for (const [id, r] of this.jets) {
      const s = r.snaps
      if (!s.length) continue
      let i = s.length - 1
      while (i > 0 && s[i - 1]![0] > rt) i--
      // s[i] is the first pose at or after rt (or the newest); a = the one before it.
      const b = s[i]!
      const a = i > 0 && b[0] >= rt ? s[i - 1]! : b
      const span = b[0] - a[0]
      const k = span > 1e-6 ? Math.max(0, Math.min(1, (rt - a[0]) / span)) : 1
      const use = a[1] !== b[1] ? (k < 0.5 ? a : b) : b
      const mode = use[1]
      if (mode === 2) continue
      const pose = r.pose
      const p = this.scratch
      const kind = vehicleOfCode(use[17])
      if (mode === 0) {
        const ship = shipOf(r.ship)
        if (!ship) continue
        const z = a[1] === 0 && b[1] === 0 ? a[2] + (b[2] - a[2]) * k : use[2]
        launchPose(z, ship, p, kind)
      } else if (mode === 3) {
        // Landing: the ship-local pose, placed on our copy of the carrier (qw: the one it lands on, 0 its own).
        const ship = shipOf(use[8] > 0 ? use[8] : r.ship)
        if (!ship) continue
        const both = a[1] === 3 && b[1] === 3
        const m = (j: number) => (both ? a[j]! + (b[j]! - a[j]!) * k : use[j]!)
        placeLocal(ship, m(2), m(3), m(4), m(5), m(6), m(7), p)
      } else if (a !== b && a[1] === 1 && b[1] === 1) {
        // Hermite between a and b with their velocities.
        const k2 = k * k
        const k3 = k2 * k
        const h00 = 2 * k3 - 3 * k2 + 1
        const h10 = k3 - 2 * k2 + k
        const h01 = -2 * k3 + 3 * k2
        const h11 = k3 - k2
        p.x = h00 * a[2] + h10 * span * a[9] + h01 * b[2] + h11 * span * b[9]
        p.y = h00 * a[3] + h10 * span * a[10] + h01 * b[3] + h11 * span * b[10]
        p.z = h00 * a[4] + h10 * span * a[11] + h01 * b[4] + h11 * span * b[11]
        qa[0] = a[5]
        qa[1] = a[6]
        qa[2] = a[7]
        qa[3] = a[8]
        qb[0] = b[5]
        qb[1] = b[6]
        qb[2] = b[7]
        qb[3] = b[8]
        setPlaneQuat(p, quatSlerp(qa, qb, k, qc))
      } else {
        // One pose (or the newest, behind us): coast on its velocity for a moment.
        const dt = Math.max(0, Math.min(COAST, rt - use[0]))
        p.x = use[2] + use[9] * dt
        p.y = use[3] + use[10] * dt
        p.z = use[4] + use[11] * dt
        p.qx = use[5]
        p.qy = use[6]
        p.qz = use[7]
        p.qw = use[8]
      }
      pose.x = p.x
      pose.y = p.y
      pose.z = p.z
      pose.qx = p.qx
      pose.qy = p.qy
      pose.qz = p.qz
      pose.qw = p.qw
      const m = (j: number) => a[j]! + (b[j]! - a[j]!) * k
      pose.throttle = m(12)
      pose.burner = use[13]
      pose.gear = m(14)
      pose.pitch = m(15)
      pose.roll = m(16)
      pose.hook = mode === 3 ? 1 : 0
      pose.kind = kind
      pose.doors = (a[18] ?? 0) + ((b[18] ?? 0) - (a[18] ?? 0)) * k
      yield [id, pose]
    }
  }
}
