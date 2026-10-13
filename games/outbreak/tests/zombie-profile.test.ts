import { expect, test } from "bun:test"
import { zombieProfileOverrides, zombieTuning, zombieControls } from "../src/zombie-profile"

test("zombie controls keep reaching and delayed upper-body response independent of foot drag", () => {
  const profile = zombieProfileOverrides(zombieTuning)
  expect(profile.handPose).toBe("reach")
  expect(profile.headHz).toBeLessThan(profile.chestHz)
  const { footDrag, ...dragging } = profile
  const { footDrag: noDrag, ...planted } = zombieProfileOverrides({ ...zombieTuning, zombieDrag: 0 })
  expect(footDrag).toBeGreaterThan(noDrag)
  expect(dragging).toEqual(planted)
  expect(zombieControls.map(c => c.key).sort()).toEqual(Object.keys(zombieTuning).sort())
})

test("Lab endpoints stay within the shared rig's pose and contact limits", () => {
  const tune = (value: number) => ({ zombieLurch: value, zombieAsymmetry: value, zombieDrag: value, zombieReach: value })
  const low = zombieProfileOverrides(tune(0)), high = zombieProfileOverrides(tune(1))
  expect(zombieProfileOverrides(tune(-5))).toEqual(low)
  expect(zombieProfileOverrides(tune(5))).toEqual(high)
  expect(low.footDrag).toBe(0)
  expect(low.timingBias).toBe(0)
  expect(high.footDrag).toBeLessThan(1)
  expect(high.timingBias).toBeLessThan(.3)
  expect(high.armReach).toBeLessThan(.56) // Shared upper arm + forearm; IK retains extension margin.
  expect(high.headHz).toBeGreaterThan(0)
  expect(high.strideScale).toBeLessThan(low.strideScale)
})
