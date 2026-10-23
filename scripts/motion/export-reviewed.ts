// Export the five reviewed, distinct events from the full sweep for the owner handoff.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { sampleMotion } from "./scenarios"
import { RIG_SEGMENTS } from "../../packages/kit/pose-diff"
import type { Finding } from "./report"

const source = resolve(process.argv[2] ?? "captures/motion-reviewed")
const out = resolve(process.argv[3] ?? source)
const report = JSON.parse(readFileSync(`${source}/report.json`, "utf8"))
const list: Finding[] = report.reports.main
const targets = [
  ["outbreak-zombie", "run-walk", "ankleL", "contact-snap"],
  ["blackout-survivor", "reversals", "elbowR", "hinge-rate"],
  ["soldier", "reversals", "kneeR", "velocity"],
  ["b-woods", "reversals", "elbowL", "hinge-rate"],
  ["e-woods", "reversals", "toeL", "velocity"],
]
const clips = []
for (const [actor, scenario, joint, metric] of targets) {
  const v = list.find(v => !v.remote && v.actor === actor && v.scenario === scenario && v.joint === joint && v.metric === metric)
  if (!v) throw new Error(`Missing reviewed event: ${actor}/${scenario}/${joint}/${metric}`)
  const frames = await sampleMotion(process.cwd(), v.actor, v.fps, v.hitch, v.remote)
  clips.push({ id: `reviewed-${clips.length + 1}`, pass: "main", finding: v, frames: frames.filter(f => Math.abs(f.time - v.time) < 0.55) })
}
mkdirSync(out, { recursive: true })
writeFileSync(`${out}/moments.json`, JSON.stringify({ segments: RIG_SEGMENTS, clips }))
writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2))
console.log(`Exported ${clips.length} reviewed events to ${out}`)
