/**
 * Terrain under the shared rig's feet, after Outbreak's survivor (`sharedFootGround`): the rig steps on a flat floor;
 * each foot then takes the ground where it stands, or, in a swing, eases from the lift-off ground to the landing
 * ground and arcs over anything higher in between (a log, a root, a kerb). The hips follow a blend of the ground
 * under the root and the planted feet, and drop on a spring only when a planted foot would be out of the leg's reach.
 * World units; the rig is in rig space (world / scale).
 */
import type { HumanBody } from "../human-pose"
import { at, RIG, stepSpring, type Frame, type Spring, type V3 } from "../rig"

export type TerrainState = { drop: Spring; init: boolean }
/** What `terrainFeet` reads of a gait (the rig's `Locomotion`, or the mocap gait's own foot state), rig units. */
export type TerrainLoco = {
  x: number; y: number
  feet: [TerrainFoot, TerrainFoot]
  motion: { targets: readonly V3[] }
}
type TerrainFoot = { planted: boolean; p: V3; lift: V3 }

const smoother = (u: number) => u * u * u * (u * (u * 6 - 15) + 10)
const smoothstep = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
/** Samples along a swing's path for obstacles narrower than half a stride. */
const SAMPLES = 16

export type TerrainFeet = {
  /** World y added to the whole body. */
  lift: number
  /** Per foot, world y added to the ball target on top of `lift`. */
  feet: [number, number]
  /** Per foot, extra pitch (rad, positive raises the heel) so a planted boot lies along the ground under it. */
  tilt: [number, number]
}

/** The boot along the ground (world m): ball back to the ankle and to the heel. Defaults to the rig's own foot. */
export type Sole = { toAnkle: number; toHeel: number }
/** Boot pitch limits on uneven ground (rad, heel up positive), and samples along the sole. */
const TILT = { down: -0.35, up: 0.75 }
const SOLE_SAMPLES = 6

export function terrainFeet(st: TerrainState, a: TerrainLoco, body: HumanBody, s: number, ground: (x: number, z: number) => number, dt: number, sole?: Sole): TerrainFeet {
  const G = (x: number, z: number) => ground(x * s, z * s)
  const toAnkle = (sole?.toAnkle ?? RIG.foot * s) / s, toHeel = (sole?.toHeel ?? (RIG.foot + RIG.heel) * s) / s
  /** The rig's ball pivot (where retarget.ts pins the mesh ball), in rig plan coordinates. */
  const ballAt = (ft: Frame): [number, number] => [ft.p[0] + ft.x[0] * RIG.foot - ft.y[0] * RIG.ankle, ft.p[2] + ft.x[2] * RIG.foot - ft.y[2] * RIG.ankle]
  /**
   * Pitch (rad, heel up positive) of a boot whose ball is at height `gb` and whose sole clears the ground back to
   * its heel: the tangent from the ball over a log, or the heel's own ground when everything behind is lower. A
   * pitched sole reaches back only d·cos θ in plan, so θ is found by a few fixed-point steps.
   */
  const solePitch = (ft: Frame, gb: number, lo: number) => {
    const [bx, bz] = ballAt(ft)
    const hl = Math.hypot(ft.x[0], ft.x[2]) || 1, dx = ft.x[0] / hl, dz = ft.x[2] / hl
    let th = 0
    for (let it = 0; it < 4; it++) {
      let sin = -Infinity
      const c = Math.cos(th)
      for (let k = 1; k <= SOLE_SAMPLES; k++) {
        const d = (toHeel * k) / SOLE_SAMPLES
        const rise = (G(bx - dx * d * c, bz - dz * d * c) - gb) / (d * s)
        // Behind and below the ball only the heel matters (it rests on the ground there); above, any point does.
        sin = Math.max(sin, k === SOLE_SAMPLES || rise > 0 ? rise : -Infinity)
      }
      th = Math.max(lo, Math.min(TILT.up, Math.asin(Math.max(-1, Math.min(1, sin)))))
    }
    // At the limit the whole boot rises until its sole clears (a heel on the top of a log, toes toward the ground).
    let raise = 0
    const c = Math.cos(th), sn = Math.sin(th)
    for (let k = 1; k <= SOLE_SAMPLES; k++) {
      const d = (toHeel * k) / SOLE_SAMPLES
      raise = Math.max(raise, G(bx - dx * d * c, bz - dz * d * c) - gb - d * s * sn)
    }
    return { th, raise }
  }
  const g: [number, number] = [0, 0]
  const tilt: [number, number] = [0, 0]
  for (let i = 0; i < 2; i++) {
    const f = a.feet[i]!
    if (f.planted) {
      // The ball takes the ground under it; the boot then pitches so its heel rests on the ground (or log) behind.
      // Heel and ankle are sampled where the mesh's own boot puts them (the ball is pinned to the rig's): a rig heel
      // further back would find a log edge the boot never touches and stand the foot on tiptoe in the air.
      // The footprint is flat and hangs off the ball pivot the rig locks (as retarget.ts pins it), so heel strike and
      // heel rise do not slide the samples off a log the boot is standing on. Samples are where the mesh's own boot
      // is; the rig's longer foot would find log edges the boot never touches.
      const ft = body.ft[i]!
      const gb = G(...ballAt(ft))
      const p = solePitch(ft, gb, TILT.down)
      tilt[i] = p.th
      g[i] = gb + p.raise
      // At heel strike the boot lands on the rig's heel point (retarget.ts pivots there), not on this footprint: near a
      // log's steep edge a centimetre is a hand's height, so the heel's own ground lifts the boot if it is higher.
      const strike = Math.max(0, Math.min(1, ft.x[1] / 0.06))
      if (strike > 0) {
        const heel = G(ft.p[0] - ft.x[0] * RIG.heel - ft.y[0] * RIG.ankle, ft.p[2] - ft.x[2] * RIG.heel - ft.y[2] * RIG.ankle)
        g[i] += Math.max(0, heel - (g[i] + Math.sin(tilt[i]) * toHeel * s)) * strike
      }
      continue
    }
    const t = a.motion.targets[i]!
    const g0 = G(f.lift[0], f.lift[2]), g1 = G(t[0], t[2])
    const px = t[0] - f.lift[0], pz = t[2] - f.lift[2], l2 = px * px + pz * pz
    // Progress along the swing from where the foot actually is, so the clearance follows the boot, not the clock.
    const e = l2 > 1e-8 ? Math.max(0, Math.min(1, ((f.p[0] - f.lift[0]) * px + (f.p[2] - f.lift[2]) * pz) / l2)) : 1
    const path = Math.sqrt(l2) * s
    let clear = 0
    for (let k = 1; k < SAMPLES; k++) {
      const q = k / SAMPLES
      const over = G(f.lift[0] + px * q, f.lift[2] + pz * q) - (g0 + (g1 - g0) * q)
      if (over < 0.01) continue
      // The boot reaches 0.19 m ahead of the ankle and 0.06 m behind: lift for an obstacle within that, plus a toe margin.
      const d = (q - e) * path
      const reach = d >= 0 ? 1 - smoothstep(0.2, 0.36, d) : 1 - smoothstep(0.08, 0.2, -d)
      clear = Math.max(clear, (over + 0.05) * reach)
    }
    g[i] = g0 + (g1 - g0) * smoother(e) + clear
    // A swinging boot keeps its heel above whatever is under it (the log it just stepped off), so the stance tilt
    // eases out over the swing instead of dropping the heel through the log at lift-off.
    const p = solePitch(body.ft[i]!, g[i] - 0.01, 0)
    tilt[i] = p.th
    g[i] += p.raise
  }
  const root = G(a.x, a.y)
  const support = root * 0.65 + (G(a.feet[0].p[0], a.feet[0].p[2]) + G(a.feet[1].p[0], a.feet[1].p[2])) * 0.175
  // Hips lower when a planted foot on lower ground would otherwise be out of reach (straight leg, 1.5% slack).
  const leg = (RIG.thigh + RIG.shin) * s * 0.985
  let want = 0
  for (let i = 0; i < 2; i++) {
    const f = a.feet[i]!
    if (!f.planted) continue
    const hip = at(body.pelvis, 0, 0, (i === 0 ? -1 : 1) * RIG.hipW)
    const ankle = body.ft[i]!.p
    const dx = (hip[0] - ankle[0]) * s, dz = (hip[2] - ankle[2]) * s
    const reach = Math.sqrt(Math.max(0, leg * leg - dx * dx - dz * dz))
    const dy = (hip[1] - ankle[1]) * s + support - g[i]
    want = Math.max(want, Math.min(0.3, dy - reach))
  }
  if (!st.init) { st.drop.x = want; st.drop.v = 0; st.init = true }
  else stepSpring(st.drop, 140, 0.85, dt, want)
  const lift = support - Math.max(0, st.drop.x)
  return { lift, feet: [g[0] - lift, g[1] - lift], tilt }
}
