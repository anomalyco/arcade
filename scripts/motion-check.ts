// bun scripts/motion-check.ts [--out captures/motion] [--baseline checkout] [--actor a-woods] [--fps 60]
// Calibration is generated from pinned CMU references only. Baselines record existing defects without blessing them.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { execFileSync } from "node:child_process"
import { referenceMotion } from "./motion/reference"
import { ACTORS, sampleMotion } from "./motion/scenarios"
import { findings, ranked, regressionEnvelope, type Finding } from "./motion/report"
import { RIG_SEGMENTS } from "../packages/kit/pose-diff"
import type { MotionCalibration } from "../packages/kit/motion-check"
import { writeMotionLedger } from "./motion/ledger"

const root = resolve(import.meta.dir, "..")
const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]! }
const flag = (name: string) => process.argv.includes(name)
const out = resolve(arg("--out", "captures/motion"))
mkdirSync(out, { recursive: true })
const calibrationFile = join(root, "scripts/motion/calibration.json")
let calibration: MotionCalibration
if (flag("--calibrate")) {
  const ref = await referenceMotion(root, arg("--bvh-dir", join(root, "games/blackout/scripts/animation/fixtures/mocap/cmu")))
  calibration = ref.calibration
  writeFileSync(calibrationFile, JSON.stringify({ ...calibration, hashes: ref.hashes }, null, 2) + "\n")
  console.log(`CMU control: 0 violations in ${ref.references.length} clock sweeps; ${ref.references.reduce((n, r) => n + r.frames.length, 0)} frames`)
  if (flag("--calibrate-only")) process.exit(0)
} else calibration = JSON.parse(readFileSync(calibrationFile, "utf8"))

const baseline = arg("--baseline", "")
const sourceRoot = resolve(arg("--source-root", root))
const current = { name: arg("--tag", "current"), root: sourceRoot }
const passes = baseline ? [{ name: arg("--baseline-tag", "before"), root: resolve(baseline) }, current] : [current]
if (new Set(passes.map(p => p.name)).size !== passes.length) throw new Error("Pass tags must be distinct")
const actors = arg("--actor", ACTORS.join(",")).split(",")
const rates = arg("--fps", "30,60,144").split(",").map(Number)
if (rates.some(x => ![30, 60, 144].includes(x))) throw new Error("Use 30, 60 or 144 fps")
const reports: Record<string, Finding[]> = {}
const traces = new Map<string, Awaited<ReturnType<typeof sampleMotion>>>()
const envelope: Record<string, Record<string, number>> = {}
for (const pass of passes) {
  let all: Finding[] = []
  const passActors = pass !== current ? arg("--baseline-actor", actors.join(",")).split(",") : actors
  for (const actor of passActors) for (const fps of rates) for (const hitch of [false, true]) {
    const frames = await sampleMotion(pass.root, actor, fps, hitch)
    all = ranked([...all, ...ranked(findings(frames, calibration, actor, fps, hitch, false))])
    if (flag("--write-baseline") && pass === current) envelope[`${actor}/${fps}/${hitch}`] = regressionEnvelope(frames, calibration)
    // Only retain a few candidate windows, rather than hundreds of MB of full-body traces.
    const best = ranked(all).slice(0, 12)
    const key = `${pass.name}/${actor}/${fps}/${hitch}/false`
    if (best.some(v => v.actor === actor && v.fps === fps && v.hitch === hitch)) traces.set(key, frames)
    const wanted = new Set(best.map(v => `${pass.name}/${v.actor}/${v.fps}/${v.hitch}/false`))
    for (const key of traces.keys()) if (key.startsWith(pass.name + "/") && !wanted.has(key)) traces.delete(key)
    console.log(`${pass.name} ${actor} ${fps}fps${hitch ? " +100ms" : ""}: ${all.length} accumulated findings`)
  }
  if (!flag("--no-remote")) for (const fps of rates) for (const hitch of [false, true]) {
    const frames = await sampleMotion(pass.root, "blackout-survivor", fps, hitch, true)
    all = ranked([...all, ...ranked(findings(frames, calibration, "blackout-survivor", fps, hitch, true))])
    traces.set(`${pass.name}/blackout-survivor/${fps}/${hitch}/true`, frames)
  }
  reports[pass.name] = ranked(all)
  console.log(`\n${pass.name}: ranked candidate iteration targets (metres/seconds/radians)`)
  console.table(reports[pass.name]!.slice(0, 25).map(v => ({ actor: v.actor, scenario: v.scenario, joint: v.joint, metric: `${v.metric}/${v.space}`, fps: v.fps, hitch: v.hitch,
    frame: v.frame, time: +v.time.toFixed(3), measured: +v.value.toPrecision(5), threshold: +v.threshold.toPrecision(5), unit: v.unit })))
}
const revision = (path: string) => { try { return execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() } catch { return "unavailable (worker export)" } }
const coverage = {
  revision: arg("--revision", "working tree"), sourceRoot, baselineRoot: baseline || null,
  passes: passes.map(p => ({ ...p, revision: revision(p.root), actors: p === current ? actors : arg("--baseline-actor", actors.join(",")).split(",") })),
  actors, rates, hitch: "one 100 ms step at 3.05 s, just after walk→run", remote: !flag("--no-remote"),
  missing: ["No jump/land input or airborne pose in animate, Outbreak Survivor or People.drive; not synthesized.",
    "Crouch is supported by Outbreak Survivor only; other adapters have speed-driven posture, no crouch input.",
    "Woods map raise covers its downward torch axis through People.drive. friends-view has no remote map-hand pose; the first-person sheet/HUD is outside joint checking.",
    "CMU walk/run provide locomotion envelopes, not anatomical limits for every action. Armed elbow-plane findings need review; axial twists require orientation markers.",
    "CMU parser exposes one toe marker: toe-tip reference is a rigid extension. Independent toe flexion and gripped props are absent; grip tolerance uses rigid-link residuals."]
}
writeFileSync(join(out, "report.json"), JSON.stringify({ calibration, coverage, reports }, null, 2))
const clips = []
for (const [pass, list] of Object.entries(reports)) {
  // Different defect families, not twelve copies of the same shin gap.
  let n = 0
  for (const metric of ["velocity", "hinge-reverse", "yaw-rate", "foot-hover", "bone-length", "grip"]) {
    const v = list.find(v => v.metric === metric)
    if (!v) continue
    const key = `${pass}/${v.actor}/${v.fps}/${v.hitch}/${v.remote}`
    const frames = traces.get(key) ?? await sampleMotion(passes.find(p => p.name === pass)!.root, v.actor, v.fps, v.hitch, v.remote)
    clips.push({ id: `${pass}-${++n}`, pass, finding: v, frames: frames.filter(f => Math.abs(f.time - v.time) < 0.55) })
  }
}
writeFileSync(join(out, "moments.json"), JSON.stringify({ segments: RIG_SEGMENTS, clips }))
console.log(`Report and exact joint windows: ${out}. Render: uv run --with pillow python3 scripts/motion/render.py ${out}`)
// Always leave the report for review, even when a ledger increase is refused.
if (flag("--write-baseline")) {
  writeFileSync(join(out, "baseline-candidate.json"), JSON.stringify(envelope) + "\n")
  writeMotionLedger(join(root, "scripts/motion/baseline.json"), envelope, flag("--accept-regression"))
}
