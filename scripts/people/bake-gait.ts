// Bakes the mocap gait cycles people walk and run with into packages/kit/people/gait.gen.ts:
//   bun scripts/people/bake-gait.ts
// Per clip: a steady window, one cycle from a left-foot-forward peak to the next, retargeted onto the rig's
// proportions in place (`retargetBvhFrame`, rig units, x forward, z right), the loop seam spread over the cycle,
// resampled to FRAMES, plus each foot's plant (ball low and still over the ground) and the stride in rig units.
import { writeFileSync } from "node:fs"
import { findSteadyWindow, loadCmu, normaliseClip, OPEN_MOCAP_CREDITS, parseCmu } from "../../games/blackout/scripts/animation/open-mocap"
import { POSE_JOINTS, retargetBvhFrame, type RigJointMap } from "../../packages/kit/pose-diff"
import { HIP, RIG } from "../../packages/kit/rig"

const FRAMES = 48
const CLIPS = [
  { name: "walk", trial: "07_12", label: "CMU 07_12 brisk walk", target: 1.9 },
  { name: "run", trial: "09_11", label: "CMU 09_11 run", target: 3.4 },
] as const

const out: string[] = []
const summary: Record<string, unknown> = {}
for (const c of CLIPS) {
  const raw = parseCmu(await loadCmu(c.trial))
  // Short takes (the run) are steady throughout; longer ones get their steadiest window at the target speed.
  const long = raw.frames.length * raw.dt > 2
  const win = long ? findSteadyWindow(raw, c.target, Math.min(2.5, raw.frames.length * raw.dt * 0.8)) : { start: 0, end: raw.frames.length, speed: 0 }
  const f = normaliseClip(raw, win.start, win.end).frames
  const lead = f.map((p) => p.Foot_L![0] - p.Hips![0])
  const gap = c.name === "walk" ? 20 : 10
  const peaks: number[] = []
  for (let i = 2; i < lead.length - 2; i++) if ([-2, -1, 1, 2].every((d) => lead[i]! >= lead[i + d]!) && lead[i]! > 0.05 && (!peaks.length || i - peaks.at(-1)! >= gap)) peaks.push(i)
  if (peaks.length < 2) throw new Error(`${c.trial}: no full cycle`)
  const [c0, c1] = [peaks[0]!, peaks[1]!]
  const cut = f.slice(c0, c1 + 1)
  const minFootY = Math.min(...cut.map((p) => Math.min(p.Foot_L![1], p.Foot_R![1], p.Toes_L![1], p.Toes_R![1])))
  const meanPelvisY = cut.reduce((a, p) => a + p.Hips![1], 0) / cut.length
  const scaleH = HIP / Math.max(0.4, meanPelvisY - minFootY)
  const dur = (c1 - c0) * raw.dt
  const stride = Math.hypot(f[c1]!.Hips![0] - f[c0]!.Hips![0], f[c1]!.Hips![2] - f[c0]!.Hips![2]) * scaleH
  const ret = cut.map((p) => retargetBvhFrame(p, meanPelvisY, minFootY))
  // Level each foot: with the foot flat on the ground (ankle at its lowest) the ball sits RIG.ankle below the ankle,
  // as the rig's own foot does. Marker placement left one CMU foot toe-up by 3-5 cm through its whole stance.
  const level: Record<string, number> = {}
  for (const sd of ["L", "R"] as const) {
    const ank = ret.map((r) => r[`ankle${sd}`][1]), lowest = Math.min(...ank)
    const flat = ret.filter((_, i) => ank[i]! < lowest + 0.015).map((r) => r[`ankle${sd}`][1] - r[`ball${sd}`][1]).sort((x, y) => x - y)
    const dy = flat[flat.length >> 1]! - RIG.ankle
    level[sd] = +dy.toFixed(3)
    for (const r of ret) for (const j of [`ball${sd}`, `toe${sd}`] as const) r[j] = [r[j][0], r[j][1] + dy, r[j][2]]
  }
  // Close the loop: the last frame (the next peak) should equal the first; spread the difference over the cycle.
  const n = ret.length - 1
  const seam = Object.fromEntries(POSE_JOINTS.map((j) => [j, ret[n]![j].map((x, k) => x - ret[0]![j][k]!)])) as Record<string, number[]>
  const closed = ret.slice(0, n).map((r, i) => Object.fromEntries(POSE_JOINTS.map((j) => [j, r[j].map((x, k) => x - seam[j]![k]! * (i / n))])) as RigJointMap)
  const sample = (u: number): RigJointMap => {
    const pos = u * n, i0 = Math.floor(pos) % n, i1 = (i0 + 1) % n, t = pos - Math.floor(pos)
    return Object.fromEntries(POSE_JOINTS.map((j) => [j, closed[i0]![j].map((x, k) => x + (closed[i1]![j][k]! - x) * t)])) as RigJointMap
  }
  const frames = Array.from({ length: FRAMES }, (_, i) => sample(i / FRAMES))
  // Plants: in place the stance foot slides back at the walking speed; over the ground it is still and low.
  const v = stride / dur
  const planted = [0, 1].map((side) => frames.map((fr, i) => {
    const b = side ? "ballR" : "ballL", a = side ? "ankleR" : "ankleL"
    const nx = frames[(i + 1) % FRAMES]!, pv = frames[(i + FRAMES - 1) % FRAMES]!
    const vx = (nx[b][0] - pv[b][0]) / (2 * dur / FRAMES) + v, vz = (nx[b][2] - pv[b][2]) / (2 * dur / FRAMES)
    // In stance while the ball is down or the heel is down; heel up with the ball lifted is push-off on the toe. The
    // ball is the one the mesh is pinned to (√(foot² + ankle²) along ankle -> ball), which lifts first.
    const d = Math.hypot(fr[b][0] - fr[a][0], fr[b][1] - fr[a][1], fr[b][2] - fr[a][2]) || 1
    const pinned = fr[a][1] + (fr[b][1] - fr[a][1]) * (Math.hypot(RIG.foot, RIG.ankle) / d)
    const low = pinned < 0.025 || fr[a][1] < 0.1
    return low && Math.hypot(vx, vz) < 0.45 * v + 0.15 ? 1 : 0
  }).map((x, i, all) => (all[(i + FRAMES - 1) % FRAMES] && all[(i + 1) % FRAMES] ? 1 : x)))
  const flat = frames.flatMap((fr) => POSE_JOINTS.flatMap((j) => fr[j].map((x) => Math.round(x * 1000))))
  out.push(`  ${c.name}: {
    source: ${JSON.stringify(`${c.label}, frames ${win.start + c0}–${win.start + c1}`)},
    /** Rig units per cycle (two steps) and seconds per cycle at the performer's own speed. */
    stride: ${stride.toFixed(4)}, duration: ${dur.toFixed(4)},
    /** Per foot (left, right), per frame: 1 while it is planted. */
    planted: [${JSON.stringify(planted[0]!.join(""))}, ${JSON.stringify(planted[1]!.join(""))}],
    /** FRAMES × POSE_JOINTS × xyz, rig units × 1000, in place (pelvis over the origin), x forward, z right. */
    joints: [${flat.join(",")}],
  },`)
  summary[c.name] = { level, window: win, stride: +stride.toFixed(3), duration: +dur.toFixed(3), rigSpeed: +(stride / dur).toFixed(2), planted: planted.map((p) => p.join("")) }
}

const credit = OPEN_MOCAP_CREDITS.cmu
writeFileSync(new URL("../../packages/kit/people/gait.gen.ts", import.meta.url), `// Generated by scripts/people/bake-gait.ts; do not edit.
// ${credit}
import type { PoseJointId } from "../pose-diff"

export const GAIT_FRAMES = ${FRAMES}
/** The joint order of each frame in \`joints\` (the kit's POSE_JOINTS). */
export const GAIT_JOINTS: readonly PoseJointId[] = ${JSON.stringify(POSE_JOINTS)}
export const GAITS = {
${out.join("\n")}
} as const
`)
console.log(JSON.stringify(summary, null, 1))
