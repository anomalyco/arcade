import { expect, test } from "bun:test"
import { resolve } from "node:path"
import { readFileSync } from "node:fs"
import { sampleMotion } from "../../../scripts/motion/scenarios"
import { regressionEnvelope } from "../../../scripts/motion/report"
import type { MotionCalibration } from "../../../packages/kit/motion-check"

// The ledger is deliberately separate from CMU thresholds: existing defects stay visible in the CLI.
// No network in CI. Refresh only after reviewing the ranked report, with a reason in docs/animation.md.
const root = resolve(import.meta.dir, "../../..")
const calibration: MotionCalibration = JSON.parse(readFileSync(resolve(root, "scripts/motion/calibration.json"), "utf8"))
const baseline: Record<string, Record<string, number>> = JSON.parse(readFileSync(resolve(root, "scripts/motion/baseline.json"), "utf8"))
test("production body-motion channels do not exceed the reviewed baseline", async () => {
  expect(Object.keys(baseline).length).toBeGreaterThan(0)
  const regressions: string[] = []
  for (const [key, limits] of Object.entries(baseline)) {
    const [actor, fps, hitch] = key.split("/")
    const frames = await sampleMotion(root, actor!, Number(fps), hitch === "true")
    const measured = regressionEnvelope(frames, calibration)
    for (const channel of Object.keys(limits)) if (!(channel in measured)) regressions.push(`${key}: missing ${channel}`)
    for (const [channel, peak] of Object.entries(measured)) {
      const limit = limits[channel]
      if (limit === undefined || !Number.isFinite(peak) || peak > limit * 1.00001 + 1e-7)
        regressions.push(`${key} ${channel}: ${peak} > ${limit}`)
    }
  }
  expect(regressions).toEqual([])
}, 60_000)
