import { beforeAll, expect, test } from "bun:test"
import { resolve } from "node:path"
import { readFileSync } from "node:fs"
import { referenceMotion } from "../../../scripts/motion/reference"
import { checkBodyMotion, type MotionCalibration, type MotionPoint } from "../../../packages/kit/motion-check"

const root = resolve(import.meta.dir, "../../..")
const saved: MotionCalibration = JSON.parse(readFileSync(resolve(root, "scripts/motion/calibration.json"), "utf8"))
let reference: Awaited<ReturnType<typeof referenceMotion>>
// Two SHA-pinned CMU downloads on a cold cache; never production output as the negative control.
beforeAll(async () => { reference = await referenceMotion(root) }, 60_000)

test("the saved clock envelopes keep every CMU reference and hitch clean", () => {
  expect(reference.references).toHaveLength(12)
  for (const ref of reference.references) expect(checkBodyMotion(ref.frames, saved)).toEqual([])
})

for (const fps of [30, 60]) for (const joint of ["pelvis", "wristL", "ankleL"]) {
  test(`${fps}fps: a 3cm ${joint} pop in the CMU walk triggers a derivative finding`, () => {
    const ref = reference.references.find(r => r.name.startsWith("CMU 07_12") && r.name.endsWith(` ${fps}fps`))!
    // Exercise all axes. Ignore geometric alarms: this specifically guards derivative sensitivity.
    for (const axis of [0, 1, 2]) {
      const frames = structuredClone(ref.frames)
      const i = Math.floor(frames.length / 2), f = frames[i]!, p = [...f.joints[joint]!] as [number, number, number]
      p[axis]! += 0.03
      f.joints = { ...f.joints, [joint]: p as MotionPoint }
      const hits = checkBodyMotion(frames, saved).filter(v => v.joint === joint && v.space === "world"
        && (v.metric === "acceleration" || v.metric === "jerk") && v.frame >= i && v.frame <= i + 3)
      expect(hits.length).toBeGreaterThan(0)
    }
  })
}
