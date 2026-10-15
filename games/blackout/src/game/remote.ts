import { SnapshotBuffer, lerpAngle } from "@arcade/kit/net/interpolate"
import type { Snapshot } from "../../shared/sim/view"

/**
 * Remote soldiers and vehicles are drawn between the two snapshots around `now − delay`
 * (`@arcade/kit/net/interpolate`), so a 15 Hz stream moves smoothly at any frame rate instead of being chased. The
 * curve between two snapshots is a cubic through both positions with their velocities as tangents, so speed and
 * direction carry through each snapshot instead of kinking there. When the stream stalls (a TCP retransmit holds up
 * everything behind it), they coast on their last velocity for up to `MAX_COAST` instead of freezing.
 */
export const REMOTE_DELAY = 0.1
export const MAX_COAST = 0.25
/** Farther than this between two snapshots is a respawn or a teleport: draw the newer one. */
export const SOLDIER_JUMP = 4
export const VEHICLE_JUMP = 6
/** A snapshot velocity this far (m/s) from the straight line between two snapshots (a soldier pushing into a wall)
 * would bulge the curve: use the straight line's velocity instead. */
const TANGENT_SLACK = 2

export type SoldierPose = { x: number; y: number; vx: number; vy: number; aim: number }
export type VehiclePose = { x: number; y: number; h: number; vx: number; vy: number }
/** The two snapshots around the render time, the blend between them and how far past the newest it is (seconds). */
export type RemoteSample = { a: Snapshot; b: Snapshot; t: number; over: number }

export function remoteBuffer(): SnapshotBuffer<Snapshot> {
  return new SnapshotBuffer<Snapshot>(REMOTE_DELAY)
}

/** Adds a snapshot; a server time that went backwards (a fresh room), a new match or map starts the buffer over. */
export function pushSnapshot(buf: SnapshotBuffer<Snapshot>, s: Snapshot, now: number): void {
  const last = buf.latest
  if (last && (s.t < last.t || s.match !== last.match || s.map !== last.map)) buf.clear()
  buf.push(s.t, s, now)
}

export function sampleRemote(buf: SnapshotBuffer<Snapshot>, now: number): RemoteSample | null {
  const br = buf.sample(now)
  if (!br) return null
  return { ...br, over: Math.min(MAX_COAST, Math.max(0, buf.renderTime(now) - br.b.t)) }
}

type Moving = { x: number; y: number; vx: number; vy: number }

/** Position and velocity on the cubic from `a` to `b` (`span` seconds apart) at blend `t`, coasting `over` past `b`. */
function curve(a: Moving, b: Moving, span: number, t: number, over: number): Moving {
  if (span <= 0 || t >= 1) return { x: b.x + b.vx * over, y: b.y + b.vy * over, vx: b.vx, vy: b.vy }
  const cx = (b.x - a.x) / span, cy = (b.y - a.y) / span
  const tan = (vx: number, vy: number) => (Math.hypot(vx - cx, vy - cy) > TANGENT_SLACK ? [cx, cy] : [vx, vy])
  const [ax, ay] = tan(a.vx, a.vy)
  const [bx, by] = tan(b.vx, b.vy)
  const t2 = t * t, t3 = t2 * t
  const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2
  const d00 = 6 * t2 - 6 * t, d10 = 3 * t2 - 4 * t + 1, d01 = -6 * t2 + 6 * t, d11 = 3 * t2 - 2 * t
  return {
    x: h00 * a.x + h10 * span * ax! + h01 * b.x + h11 * span * bx!,
    y: h00 * a.y + h10 * span * ay! + h01 * b.y + h11 * span * by!,
    vx: (d00 * a.x + d01 * b.x) / span + d10 * ax! + d11 * bx!,
    vy: (d00 * a.y + d01 * b.y) / span + d10 * ay! + d11 * by!,
  }
}

/** A remote soldier at the render time, or null when only the newest snapshot should be drawn (respawn, death). */
export function soldierAt(s: RemoteSample, id: string): SoldierPose | null {
  const pa = s.a.players.find((p) => p.id === id)
  const pb = s.b.players.find((p) => p.id === id)
  if (!pa || !pb || !pa.alive || !pb.alive || Math.hypot(pb.x - pa.x, pb.y - pa.y) > SOLDIER_JUMP) return null
  return { ...curve(pa, pb, s.b.t - s.a.t, s.t, s.over), aim: lerpAngle(pa.aim, pb.aim, s.t) }
}

/** A vehicle at the render time, or null when only the newest snapshot should be drawn (new, wrecked, respawned). */
export function vehicleAt(s: RemoteSample, id: number): VehiclePose | null {
  const va = s.a.vehicles?.find((v) => v.id === id)
  const vb = s.b.vehicles?.find((v) => v.id === id)
  if (!va || !vb || !!va.wreck !== !!vb.wreck || Math.hypot(vb.x - va.x, vb.y - va.y) > VEHICLE_JUMP) return null
  const at = curve(va, vb, s.b.t - s.a.t, s.t, s.over)
  return { ...at, h: s.t >= 1 ? vb.h + vb.w * s.over : lerpAngle(va.h, vb.h, s.t) }
}

/**
 * Hides the jumps interpolation can't: when a stalled stream resumes, the coasted pose and the real one differ. The
 * jump (beyond the pose's own motion this frame) becomes an offset that decays at `rate` per second, like your own
 * soldier's prediction corrections; a teleport resets it.
 */
export class Glide {
  x = 0
  y = 0
  private lx = Number.NaN
  private ly = Number.NaN

  constructor(
    public rate = 10,
    private readonly jump = SOLDIER_JUMP,
  ) {}

  /** The drawn position for target (tx, ty) moving at (vx, vy). */
  step(tx: number, ty: number, vx: number, vy: number, dt: number): { x: number; y: number } {
    if (!Number.isNaN(this.lx)) {
      const jx = tx - this.lx - vx * dt
      const jy = ty - this.ly - vy * dt
      const j = Math.hypot(jx, jy)
      if (j > this.jump) this.x = this.y = 0
      else if (j > 0.01) {
        this.x -= jx
        this.y -= jy
      }
    }
    this.lx = tx
    this.ly = ty
    const k = Math.exp(-dt * this.rate)
    this.x *= k
    this.y *= k
    return { x: tx + this.x, y: ty + this.y }
  }

  reset(): void {
    this.x = this.y = 0
    this.lx = this.ly = Number.NaN
  }
}
