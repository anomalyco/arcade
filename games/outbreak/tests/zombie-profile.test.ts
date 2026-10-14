import { expect, test } from "bun:test"
import { zombieProfile, zombieProfileOverrides, zombieTuning, zombieControls } from "../src/zombie-profile"
import { Survivor } from "../src/survivor"
import { humanProfiles } from "@arcade/kit/human-profile"

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

test("terrain zombie adapter preserves authoritative inputs and finite elevated poses through stalls", () => {
  let model = 0
  const avatar = new Survivor({ addModel: () => model++ })
  avatar.profile = zombieProfile(zombieTuning)
  expect(avatar.profile.runPosture).toBe(humanProfiles.zombie.runPosture)
  const p = { x: 0, y: 0, vx: 1, vy: 0, aim: 0 }
  let time = 0
  for (let n = 0; n < 180; n++) {
    const dt = n % 40 === 0 ? 2 : 1 / 60
    p.x += Math.min(dt, .05); p.aim = Math.sin(n / 50) * .3; time += dt
    const input = JSON.stringify(p)
    const batches = avatar.draw(p, dt, time, (x, z) => .5 + x * .02 + z * .01)
    expect(batches).toHaveLength(13)
    expect(batches.every(b => [...b.data].every(Number.isFinite))).toBe(true)
    expect(avatar.bones.pelvis!.p[1]).toBeGreaterThan(.8)
    expect(avatar.bones["right.foreArm"]!.p[1]).toBeGreaterThan(1)
    expect(JSON.stringify(p)).toBe(input)
  }
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

test("sloped reversals keep survivor and zombie pelvis height and foot transitions smooth", () => {
  for (const isZombie of [false, true]) {
    let model = 0
    const avatar = new Survivor({ addModel: () => model++ })
    if (isZombie) avatar.profile = zombieProfile(zombieTuning)
    const p = { x: 0, y: 0, vx: 3.4, vy: 0, aim: 0 }
    const support = (sx: number, sz: number) => .4 * Math.sin(sx * .6) + .25 * Math.cos(sz * .5)
    let time = 0, prevPelY = 0
    for (let n = 0; n < 240; n++) {
      const dt = 1 / 60
      p.vx = n < 90 ? 3.4 : n < 160 ? -3.4 : 0
      p.vy = n >= 90 && n < 160 ? 2.0 : 0
      p.aim = n < 90 ? 0 : Math.PI * .75
      p.x += p.vx * dt; p.y += p.vy * dt; time += dt
      avatar.draw(p, dt, time, support)
      const pelY = avatar.bones.pelvis!.p[1]
      if (n > 0) expect(Math.abs(pelY - prevPelY)).toBeLessThan(.06)
      prevPelY = pelY
    }
  }
})
