// The three real regressions in people-real 33a5d629, before its fixes. Never inject these into production code.
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { sampleMotion } from "./scenarios"
import { findings } from "./report"
import type { MotionCalibration } from "../../packages/kit/motion-check"
import { RIG_SEGMENTS } from "../../packages/kit/pose-diff"

const root = resolve(import.meta.dir, "../..")
const before = process.argv[2]
if (!before) throw new Error("Usage: bun scripts/motion/acceptance.ts <pre-fix checkout> [output.json]")
const c: MotionCalibration = JSON.parse(readFileSync(resolve(root, "scripts/motion/calibration.json"), "utf8"))
const evidence = []
const clips = []
for (const fps of [30, 60, 144]) {
  const frames = await sampleMotion(resolve(before), "a-woods", fps, false)
  const v = findings(frames, c, "a-woods", fps, false, false)
  const cases = {
    "knee flip": v.filter(v => v.joint.startsWith("knee") && v.metric === "hinge-reverse" && v.scenario === "start-walk"),
    "yaw whip on turned walk start": v.filter(v => v.metric === "yaw-rate" && v.scenario === "turned-walk-start"),
    "hovering stance foot at gait blend": v.filter(v => v.metric === "foot-hover" && v.scenario === "walk-run"),
  }
  for (const [name, hits] of Object.entries(cases)) {
    const worst = hits.toSorted((a, b) => b.ratio - a.ratio)[0]
    if (!worst) throw new Error(`${fps}fps: checker missed ${name}`)
    evidence.push({ name, ...worst })
    if (fps === 60) clips.push({ id: `acceptance-${clips.length + 1}`, pass: `people-real pre-fix: ${name}`,
      finding: worst, frames: frames.filter(f => Math.abs(f.time - worst.time) < 0.55) })
  }
}
if (process.argv[3]) {
  writeFileSync(process.argv[3], JSON.stringify(evidence, null, 2) + "\n")
  writeFileSync(process.argv[3].replace(/\.json$/, "") + ".moments.json", JSON.stringify({ segments: RIG_SEGMENTS, clips }))
}
console.table(evidence.map(v => ({ bug: v.name, fps: v.fps, joint: v.joint, time: v.time.toFixed(3), measured: v.value.toPrecision(5), threshold: v.threshold.toPrecision(5), unit: v.unit })))
