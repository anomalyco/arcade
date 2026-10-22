import { join } from "node:path"
import { createHash } from "node:crypto"
import { calibrateMotion, checkBodyMotion, type MotionFrame } from "../../packages/kit/motion-check"
import type { BvhClip, RigJointMap } from "../../packages/kit/pose-diff"
import type { V3 } from "../../packages/kit/rig"

type MocapModule = {
  loadCmu(trial: string, dir?: string): Promise<string>
  parseCmu(text: string): BvhClip
  normaliseClip(clip: BvhClip, start?: number, end?: number): BvhClip
  findSteadyWindow(clip: BvhClip, speed: number, duration: number): { start: number; end: number }
}
const lerp = (a: V3, b: V3, t: number): V3 => a.map((x, k) => x + (b[k]! - x) * t) as V3
const median = (a: number[]) => a.toSorted((x, y) => x - y)[a.length >> 1]!

/** Reuses the existing CMU parser and axis normalization. Raw FK marker lengths, no gait-loop seam or pose rounding. */
export async function referenceMotion(root: string, fixtureDir?: string) {
  const mod = await import(join(root, "games/blackout/scripts/animation/open-mocap.ts")) as MocapModule
  if (typeof mod.loadCmu !== "function" || typeof mod.parseCmu !== "function")
    throw new Error("CMU loader is not in this revision. Pass --reference-root <people-real checkout> until PR #428 lands.")
  const references: { name: string; frames: MotionFrame[] }[] = []
  const hashes: Record<string, string> = {}
  for (const trial of ["07_12", "09_11"]) {
    const text = await mod.loadCmu(trial, fixtureDir)
    hashes[trial] = createHash("sha256").update(text).digest("hex")
    const clip = mod.parseCmu(text)
    // CMU's BVH includes a reference/T-pose and reset at its ends. Use the existing steady-window selector,
    // exactly as bake-gait does; never train thresholds on a capture reset or loop wrap.
    const win = clip.frames.length * clip.dt > 2
      ? mod.findSteadyWindow(clip, trial === "07_12" ? 1.9 : 3.4, Math.min(2.5, clip.frames.length * clip.dt * 0.8))
      : { start: 0, end: clip.frames.length }
    // Both cgspeed exports start with calibration poses (07_12 resets at frame 2, 09_11 at frame 1).
    win.start = Math.max(2, win.start)
    const raw = mod.normaliseClip(clip, win.start, win.end)
    const first = raw.frames[0]!, end = raw.frames.at(-1)!
    const speed = Math.hypot(end.Hips![0] - first.Hips![0], end.Hips![2] - first.Hips![2]) / ((raw.frames.length - 1) * raw.dt)
    const base = raw.frames.map(p => {
      const j = { pelvis: p.Hips!, waist: lerp(p.Hips!, p.Chest!, 0.45), chest: p.Chest!, neck: p.Neck!, headTop: p.Head_End! } as RigJointMap
      for (const s of ["L", "R"] as const) {
        j[`shoulder${s}`] = p[`UpperArm_${s}`]!; j[`elbow${s}`] = p[`LowerArm_${s}`]!; j[`wrist${s}`] = p[`Hand_${s}`]!
        j[`hip${s}`] = p[`UpperLeg_${s}`]!; j[`knee${s}`] = p[`LowerLeg_${s}`]!; j[`ankle${s}`] = p[`Foot_${s}`]!
        j[`ball${s}`] = p[`Toes_${s}`]!
        // CMU parser has one foot marker. A rigid extension only supplies toe kinematics; not independent toe-flex evidence.
        j[`toe${s}`] = lerp(j[`ankle${s}`], j[`ball${s}`], 1.4)
      }
      return j
    })
    // CMU has no force plates: infer mid-stance from independently low AND slow ball markers (lower quartiles).
    // Heel-rocking frames are not toe plants. Do not label every low ankle planted: that learns several m/s of slip.
    const quartile = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 4)]!
    const labels = (["L", "R"] as const).map(s => {
      const h = base.map(j => j[`ball${s}`][1])
      const v = base.map((j, i) => i ? Math.hypot(j[`ball${s}`][0] - base[i - 1]![`ball${s}`][0], j[`ball${s}`][2] - base[i - 1]![`ball${s}`][2]) / raw.dt : Infinity)
      const lo = quartile(h), slow = quartile(v)
      return h.map((y, i) => y <= lo && v[i]! <= slow)
    })
    const floor = (["L", "R"] as const).map((s, k) => median(base.filter((_, i) => labels[k]![i]).map(j => j[`ball${s}`][1])))
    for (const fps of [30, 60, 144]) for (const hitch of [false, true]) {
      const frames: MotionFrame[] = []
      let time = 0, hit = false
      while (time + 1 / fps < (base.length - 1) * raw.dt) {
        const dt = hitch && !hit && time >= 0.5 ? (hit = true, 0.1) : 1 / fps
        time += dt
        if (time >= (base.length - 1) * raw.dt) break
        const q = time / raw.dt, n = Math.floor(q), t = q - n
        const joints = Object.fromEntries(Object.entries(base[n]!).map(([key, p]) => [key, lerp(p, base[n + 1]![key as keyof RigJointMap]!, t)])) as RigJointMap
        const contacts = Object.fromEntries((["L", "R"] as const).map((s, k) => [`ball${s}`, {
          planted: labels[k]![n]! && labels[k]![n + 1]!, ground: 0,
          point: [joints[`ball${s}`][0], joints[`ball${s}`][1] - floor[k]!, joints[`ball${s}`][2]] as V3,
        }]))
        frames.push({ dt, joints, speed, contacts })
      }
      references.push({ name: `CMU ${trial}[${win.start}:${win.end}] ${fps}fps${hitch ? "+100ms" : ""}`, frames })
    }
  }
  const calibration = calibrateMotion(references)
  const failures = references.flatMap(r => checkBodyMotion(r.frames, calibration).map(v => ({ source: r.name, ...v })))
  if (failures.length) throw new Error(`CMU self-check failed: ${JSON.stringify(failures[0])}`)
  return { calibration, hashes, references }
}
