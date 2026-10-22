/**
 * Terrain under the shared rig's feet, after Outbreak's survivor (`sharedFootGround`): the rig steps on a flat floor;
 * each foot then takes the ground where it stands, or, in a swing, eases from the lift-off ground to the landing
 * ground and arcs over anything higher in between (a log, a root, a kerb). The hips follow a blend of the ground
 * under the root and the planted feet, and drop on a spring only when a planted foot would be out of the leg's reach.
 * World units; the rig is in rig space (world / scale).
 */
import type { HumanBody } from "../human-pose"
import type { Locomotion } from "../human-locomotion"
import { at, RIG, stepSpring, type Spring } from "../rig"

export type TerrainState = { drop: Spring; init: boolean }

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

export function terrainFeet(st: TerrainState, a: Locomotion, body: HumanBody, s: number, ground: (x: number, z: number) => number, dt: number): TerrainFeet {
  const G = (x: number, z: number) => ground(x * s, z * s)
  const g: [number, number] = [0, 0]
  const tilt: [number, number] = [0, 0]
  for (let i = 0; i < 2; i++) {
    const f = a.feet[i]!
    if (f.planted) {
      // The ball takes the ground under it; the boot then pitches so its heel rests on the ground (or log) behind.
      const ft = body.ft[i]!
      const bx = ft.p[0] + ft.x[0] * RIG.foot, bz = ft.p[2] + ft.x[2] * RIG.foot
      const hx = ft.p[0] - ft.x[0] * RIG.heel, hz = ft.p[2] - ft.x[2] * RIG.heel
      const gb = G(bx, bz), gh = Math.max(G(hx, hz), G(ft.p[0], ft.p[2]))
      g[i] = gb
      tilt[i] = Math.max(-0.35, Math.min(0.5, Math.atan2(gh - gb, (RIG.foot + RIG.heel) * s)))
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
