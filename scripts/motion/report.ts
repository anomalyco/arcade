import { checkBodyMotion, measureBodyMotion, type MotionCalibration, type MotionViolation } from "../../packages/kit/motion-check"
import type { Sample } from "./scenarios"

export type Finding = MotionViolation & { actor: string; fps: number; hitch: boolean; remote: boolean; scenario: string; visibility: number }
/** Rank by estimated visible travel, not a million-fold floating-point residual. Ranking is triage, not a pass/fail rule. */
export function visibility(v: MotionViolation, frames: Sample[]): number {
  const f = frames[v.frame]!, prev = frames[v.frame - 1]
  const id = v.joint.split(":").at(-1)!, p = f.joints[id], q = prev?.joints[id]
  const displacement = p && q ? Math.hypot(...p.map((x, k) => x - q[k]!)) : 0
  const excess = v.value - v.threshold
  if (v.metric === "bad-number") return 100
  if (["bone-length", "width", "foot-hover", "foot-sink", "hinge-reverse", "grip"].includes(v.metric)) return excess
  if (v.metric === "foot-slip" || v.metric === "contact-snap") return excess * f.dt
  if (v.metric === "hinge-flexion") return 0.4 * excess
  if (v.metric === "hinge-rate" || v.metric === "yaw-rate") return 0.4 * excess * f.dt
  if (v.metric === "yaw-acceleration") return 0.4 * excess * f.dt * f.dt
  return displacement * (1 - 1 / v.ratio)
}

export function findings(frames: Sample[], calibration: MotionCalibration, actor: string, fps: number, hitch: boolean, remote: boolean): Finding[] {
  return checkBodyMotion(frames, calibration).map(v => ({ ...v, actor, fps, hitch, remote, scenario: frames[v.frame]!.scenario, visibility: visibility(v, frames) }))
}

/** One worst moment per scenario/joint/rule. Displacement and velocity describe the same event; keep velocity. */
export function ranked(findings: Finding[]): Finding[] {
  const best = new Map<string, Finding>()
  for (const v of findings) {
    if (v.metric === "displacement") continue
    const key = `${v.actor}/${v.remote ? "remote" : "local"}/${v.scenario}/${v.joint}/${v.metric}/${v.space}`
    if (!best.has(key) || best.get(key)!.visibility < v.visibility) best.set(key, v)
  }
  return [...best.values()].sort((a, b) => b.visibility - a.visibility || b.ratio - a.ratio)
}

/** Small durable regression ledger: each exact joint/channel maximum over the same input tape. */
export function regressionEnvelope(frames: Sample[], c: MotionCalibration) {
  const out: Record<string, number> = {}
  for (const r of measureBodyMotion(frames, c)) {
    const key = `${r.metric}/${r.space}/${r.joint}`
    out[key] = Math.max(out[key] ?? 0, r.value / r.scale)
  }
  return out
}
