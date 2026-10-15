import { Glide, SnapshotBuffer, hermite2, lerpAngle } from "@arcade/kit/net/interpolate"
import type { Snapshot } from "../../shared/sim/view"

export { Glide }

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
  return new SnapshotBuffer<Snapshot>(REMOTE_DELAY, 32, MAX_COAST)
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
  return { a: br.a, b: br.b, t: br.t, over: Math.min(MAX_COAST, Math.max(0, buf.renderTime(now) - br.b.t)) }
}

/** A remote soldier at the render time, or null when only the newest snapshot should be drawn (respawn, death). */
export function soldierAt(s: RemoteSample, id: string): SoldierPose | null {
  const pa = s.a.players.find((p) => p.id === id)
  const pb = s.b.players.find((p) => p.id === id)
  if (!pa || !pb || !pa.alive || !pb.alive || Math.hypot(pb.x - pa.x, pb.y - pa.y) > SOLDIER_JUMP) return null
  return { ...hermite2(pa, pb, s.b.t - s.a.t, s.t, s.over, TANGENT_SLACK), aim: lerpAngle(pa.aim, pb.aim, s.t) }
}

/** A vehicle at the render time, or null when only the newest snapshot should be drawn (new, wrecked, respawned). */
export function vehicleAt(s: RemoteSample, id: number): VehiclePose | null {
  const va = s.a.vehicles?.find((v) => v.id === id)
  const vb = s.b.vehicles?.find((v) => v.id === id)
  if (!va || !vb || !!va.wreck !== !!vb.wreck || Math.hypot(vb.x - va.x, vb.y - va.y) > VEHICLE_JUMP) return null
  const at = hermite2(va, vb, s.b.t - s.a.t, s.t, s.over, TANGENT_SLACK)
  return { ...at, h: s.t >= 1 ? vb.h + vb.w * s.over : lerpAngle(va.h, vb.h, s.t) }
}
