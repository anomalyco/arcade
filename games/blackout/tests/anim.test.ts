import { afterEach, expect, test } from "bun:test"
import { animate, fire, hit, newAvatar } from "../src/game/anim"
import { animation } from "../src/game/anim-settings"
import { gaitAt } from "../src/game/anim-locomotion"
import { bodyJoints } from "../src/game/anim-pose"
import { ragdoll, ragdollBody, stepRagdoll } from "../src/game/ragdoll"
import { angleDiff } from "../shared/geom"
import { at } from "../src/game/rig"
import { RIG } from "../src/render/person"
import { humanProfiles } from "@arcade/kit/human-profile"
import { animationLab, animationControls } from "../src/game/anim-settings"
import { LabNavigation } from "@arcade/kit/lab-navigation"
import { bodyBones, boneVisible, detach, type BoneId } from "@arcade/kit/human-pose"

const defaults = { ...animation }
afterEach(() => Object.assign(animation, defaults))
const dt = 1 / 60

test("runtime wizards consume shared posture while retaining all weapon frames and casting clips", () => {
  for (const gun of ["rifle", "shotgun", "sniper"] as const) {
    const wizard = newAvatar("wizard", 0, 0, 0, gun), soldier = newAvatar("wizard", 0, 0, 0, gun)
    for (let n = 0; n < 180; n++) {
      animate(wizard, dt, n * dt, n * dt * 1.1, 0, 1.1, 0, 0.2, true)
      animate(soldier, dt, n * dt, n * dt * 1.1, 0, 1.1, 0, 0.2)
      expect(wizard.body!.gun).not.toBeNull()
      // Different stride phases may change the small authored weapon sway, not its aim ownership.
      expect(wizard.body!.gun!.x.reduce((dot, value, axis) => dot + value * soldier.body!.gun!.x[axis]!, 0)).toBeGreaterThan(.999)
    }
    expect(wizard.profile).toBeUndefined()
    expect(wizard.motion.stride / soldier.motion.stride).toBeCloseTo(humanProfiles.wizard.strideScale, 10)
    const freeHand = wizard.body!.fa[0]
    wizard.throwAt = 3
    animate(wizard, dt, 3.15, 3.3, 0, 0, 0, 0.2, true)
    expect(wizard.body!.fa[0]).not.toEqual(freeHand)
    expect(wizard.body!.gun).not.toBeNull()
  }
})

for (const [name, vx, vy, spin] of [["walk", 1.4, 0, 0], ["run", 4.2, 0, 0], ["sprint", 6.3, 0, 0], ["backpedal", -1.5, 0, 0], ["strafe left", 0, -2, 0], ["strafe right", 0, 2, 0], ["turn", 0, 0, 1.4]] as const) {
  test(`${name}: both the lock and rendered toe have zero planted slip`, () => {
    const a = newAvatar("lock", 0, 0, 0, "rifle")
    let contacts = 0, steps = 0
    for (let n = 0; n < 360; n++) {
      const old = a.feet.map((f, i) => ({ planted: f.planted, p: [...f.p], rendered: a.body ? at(a.body.ft[i]!, 0.19, -RIG.ankle, 0) : null }))
      animate(a, dt, n * dt, vx * n * dt, vy * n * dt, vx, vy, spin * n * dt)
      for (let i = 0; i < 2; i++) {
        if (!old[i]!.planted && a.feet[i]!.planted) steps++
        if (n > 0 && old[i]!.planted && a.feet[i]!.planted) {
          expect(a.feet[i]!.p).toEqual(old[i]!.p)
          const toe = at(a.body!.ft[i]!, 0.19, -RIG.ankle, 0)
          for (let axis = 0; axis < 3; axis++) expect(toe[axis]!).toBeCloseTo(old[i]!.rendered![axis]!, 12)
          contacts++
        }
      }
      if (vy !== 0) expect(a.feet[1].p[2] - a.feet[0].p[2]).toBeGreaterThanOrEqual(0.199999)
      expect(Math.abs(angleDiff(a.legYaw, a.aim))).toBeLessThanOrEqual(1.050001)
      expect(a.body!.pelvis.p[1]).toBeGreaterThan(0.75)
      expect(a.body!.head.p).toEqual(at(a.body!.torso, 0.02, RIG.neckY, 0))
      if (n > 60 && vx > 0) for (let i = 0; i < 2; i++) if (a.feet[i]!.planted) {
        const ankle = at(a.body!.sh[i]!, 0, -RIG.shin, 0)
        expect(Math.hypot(...ankle.map((v, j) => v - a.body!.ft[i]!.p[j]!))).toBeLessThan(0.000001)
      }
    }
    expect(contacts).toBeGreaterThan(100)
    expect(steps).toBeGreaterThan(5)
  })
}

test("walk/run transition changes continuously, including the posed feet and pelvis", () => {
  const a = newAvatar("transition", 0, 0, 0, "rifle")
  let x = 0
  for (let n = 0; n < 600; n++) {
    const speed = 1.5 + n / 600
    const before = a.body
    x += speed * dt
    animate(a, dt, n * dt, x, 0, speed, 0, 0)
    if (before) {
      expect(Math.abs(a.body!.pelvis.p[1] - before.pelvis.p[1])).toBeLessThan(0.02)
      for (let i = 0; i < 2; i++) expect(Math.hypot(...a.body!.ft[i]!.p.map((p, k) => p - before.ft[i]!.p[k]!))).toBeLessThan(0.20)
    }
    const l = gaitAt(speed), r = gaitAt(speed + 0.00001)
    expect(Math.abs(l.duty - r.duty)).toBeLessThan(0.00001)
    expect(Math.abs(l.stride - r.stride)).toBeLessThan(0.00001)
  }
})

test("fixed-step replay includes deterministic recoil and hit impulses", () => {
  function run() {
    const a = newAvatar("replay", 0, 0, 0, "shotgun")
    for (let n = 0; n < 360; n++) {
      if (n % 60 === 0) fire(a, n * dt)
      if (n === 200) hit(a, 0.3, 1)
      animate(a, dt, n * dt, Math.sin(n * dt), Math.cos(n * dt), Math.cos(n * dt), -Math.sin(n * dt), n * dt * 0.5)
    }
    return JSON.stringify(a)
  }
  expect(run()).toBe(run())
})

test("hard stop settles in at most two catch steps", () => {
  const a = newAvatar("stop", 0, 0, 0, "rifle")
  for (let n = 0; n < 120; n++) animate(a, dt, n * dt, n * dt * 4.2, 0, 4.2, 0, 0)
  let steps = 0
  for (let n = 0; n < 90; n++) {
    const before = a.feet.map(f => f.planted)
    animate(a, dt, 2 + n * dt, 119 * dt * 4.2, 0, 0, 0, 0)
    steps += a.feet.filter((f, i) => !before[i] && f.planted).length
  }
  expect(steps).toBeLessThanOrEqual(2)
  expect(a.feet.every(f => f.planted)).toBe(true)
})

test("ragdoll starts at the exact pose and inherits individual joint velocities", () => {
  const a = newAvatar("death", 0, 0, 0, "rifle")
  for (let n = 0; n < 45; n++) animate(a, dt, n * dt, n * dt * 1.4, 0, 1.4, 0, 0)
  const body = a.body!, saved = JSON.stringify(body)
  const r = ragdoll(body, a.gun, 1.4, 0, 0, 0, { push: 0, lift: 0, spin: 0, buckle: 0 }, [])
  const posed = ragdollBody(r, 0, a.gun)
  const before = bodyJoints(body, a.gun), after = bodyJoints(posed, a.gun)
  for (let i = 0; i < 15; i++) for (let axis = 0; axis < 3; axis++) {
    expect(after[i]![axis]!).toBeCloseTo(before[i]![axis]!, 10)
    expect((r.pos[i]![axis]! - r.prev[i]![axis]!) * 120).toBeCloseTo(body.velocities![i]![axis]!, 10)
  }
  for (let i = 0; i < 2; i++) expect(posed.ft[i]!.x[1]).toBeCloseTo(body.ft[i]!.x[1], 10)
  const replay = ragdoll(body, a.gun, 1.4, 0, 0, 0, { push: 0, lift: 0, spin: 0, buckle: 0 }, [])
  stepRagdoll(r, dt)
  stepRagdoll(replay, dt)
  expect(JSON.stringify(r)).toBe(JSON.stringify(replay))
  expect(JSON.stringify(body)).toBe(saved)
})

test("every animation setting has a Lab control", async () => {
  const { animationControls } = await import("../src/game/anim-settings")
  expect(animationControls.map(c => c.key).sort()).toEqual(Object.keys(animation).sort())
})

test("sprint has flight instead of stretching a locked leg or crouching to reach it", () => {
  const a = newAvatar("flight", 0, 0, 0, "rifle")
  let flight = 0
  for (let n = 0; n < 180; n++) {
    animate(a, dt, n * dt, n * dt * 6.3, 0, 6.3, 0, 0)
    if (a.feet.every(f => !f.planted)) flight++
  }
  expect(flight).toBeGreaterThan(30)
})

test("per-actor profiles preserve the default soldier and isolate zombie tuning", () => {
  const a = newAvatar("same", 0, 0, 0, "rifle"), b = newAvatar("same", 0, 0, 0, "rifle")
  b.profile = { ...humanProfiles.soldier }
  const zombie = newAvatar("zombie", 0, 0, 0, "rifle")
  zombie.profile = { ...humanProfiles.zombie }
  for (let n = 0; n < 180; n++) {
    for (const actor of [a, b, zombie]) animate(actor, dt, n * dt, n * dt * 1.1, 0, 1.1, 0, n * dt * 0.2)
    expect(a.body).toEqual(b.body)
    expect(zombie.body!.gun).toBeNull()
    expect(zombie.body!.head.p).toEqual(at(zombie.body!.torso, 0.02, RIG.neckY, 0))
  }
  expect(a.body!.torso).not.toEqual(zombie.body!.torso)
})

test("Lab profile selection, Copy and keyboard reset use the same settings", () => {
  const settings = animationLab({}, new URLSearchParams()), nav = new LabNavigation(settings, animationControls)
  const preset = animationControls.find(c => c.key === "profilePreset")!
  nav.set(preset, "zombie")
  for (const [key, value] of Object.entries(humanProfiles.zombie)) expect(settings[key as keyof typeof settings]).toBe(value)
  expect(JSON.parse(nav.json("Animation")).handPose).toBe("reach")
  nav.active = nav.rows.find(row => row.group === "Animation" && !row.control)
  nav.reset(true)
  expect({ ...animation }).toEqual(defaults)
})

test("missing limbs remain finite through future animation and do not mutate authoritative inputs", () => {
  const a = newAvatar("missing", 0, 0, 0, "rifle")
  a.profile = { ...humanProfiles.zombie }
  a.hiddenBones = new Set<BoneId>()
  for (let n = 0; n < 120; n++) {
    const previous = a.body && bodyBones(a.body)
    animate(a, dt, n * dt, n * dt, 0, 1, 0, 0)
    if (n === 60) {
      const before = JSON.stringify(a.body)
      const pieces = detach(bodyBones(a.body!), previous ?? undefined, dt, "right.upperArm", a.hiddenBones)
      expect(pieces.map(p => p.bone)).toEqual(["right.upperArm", "right.foreArm"])
      expect(JSON.stringify(a.body)).toBe(before)
    }
    expect(Object.values(bodyBones(a.body!)).flatMap(frame => Object.values(frame).flat()).every(Number.isFinite)).toBe(true)
    expect(a.vx).toBe(1)
  }
  expect(boneVisible("right.foreArm", a.hiddenBones)).toBe(false)
  expect(boneVisible("left.foreArm", a.hiddenBones)).toBe(true)
})

test("profiles keep poses bounded at dt spikes with missing limbs and preserve rifle aim", () => {
  for (const profile of Object.values(humanProfiles)) {
    const a = newAvatar("spikes", 0, 0, 0, "rifle"), soldier = newAvatar("spikes", 0, 0, 0, "rifle")
    a.profile = { ...profile }; a.hiddenBones = new Set(["left.thigh", "right.upperArm"])
    let x = 0, t = 0
    for (let n = 0; n < 240; n++) {
      const step = [1 / 240, 1 / 60, 0.05, 0.2, 2][n % 5]!
      t += step; x += Math.min(step, 0.05) * 4.2
      for (const actor of [a, soldier]) animate(actor, step, t, x, 0, 4.2, 0, Math.sin(n / 60) * 0.4)
      for (const frame of Object.values(bodyBones(a.body!))) {
        expect(Object.values(frame).flat().every(Number.isFinite)).toBe(true)
        expect(Math.hypot(frame.p[0] - x, frame.p[1], frame.p[2])).toBeLessThan(2.5)
        for (const axis of [frame.x, frame.y, frame.z]) expect(Math.hypot(...axis)).toBeCloseTo(1, 10)
      }
      expect(Math.abs(angleDiff(Math.atan2(a.body!.pelvis.x[2], a.body!.pelvis.x[0]), a.aim))).toBeLessThan(1.2)
      if (profile.handPose === "weapon") expect(a.body!.gun).toEqual(soldier.body!.gun)
    }
  }
})

test("corpse detachment starts at its displayed pose and retains the missing-limb mask", () => {
  const a = newAvatar("corpse-detach", 0, 0, 0, "rifle")
  a.hiddenBones = new Set(["left.foreArm"])
  for (let n = 0; n < 90; n++) animate(a, dt, n * dt, n * dt * 4.2, 0, 4.2, 0, 0)
  const r = ragdoll(a.body!, a.gun, 4.2, 0, 1, 0, { push: 0, lift: 0, spin: 0, buckle: 0 }, [], a.hiddenBones)
  expect(boneVisible("left.foreArm", r.hiddenBones)).toBe(false)
  a.hiddenBones.clear()
  expect(boneVisible("left.foreArm", r.hiddenBones)).toBe(false)
  const previous = bodyBones(ragdollBody(r, 0, a.gun))
  stepRagdoll(r, dt)
  const current = bodyBones(ragdollBody(r, 0, a.gun)), snapshot = JSON.stringify(r.pos)
  const parts = detach(current, previous, dt, "right.upperArm", r.hiddenBones)
  expect(parts.map(p => p.bone)).toEqual(["right.upperArm", "right.foreArm"])
  for (const part of parts) {
    expect(part.frame).toEqual(current[part.bone]!)
    part.linear.forEach((v, i) => expect(v).toBeCloseTo((current[part.bone]!.p[i]! - previous[part.bone]!.p[i]!) / dt, 10))
  }
  expect(JSON.stringify(r.pos)).toBe(snapshot)
  stepRagdoll(r, 0.2)
  expect(Object.values(bodyBones(ragdollBody(r, 0, a.gun))).flatMap(f => Object.values(f).flat()).every(Number.isFinite)).toBe(true)
})

test("running posture changes the trunk, not cadence, contacts, root height or gun aim", () => {
  const before = newAvatar("attitude", 0, 0, 0, "rifle"), after = newAvatar("attitude", 0, 0, 0, "rifle")
  let x = 0, y = 0
  for (let n = 0; n < 600; n++) {
    const speed = n < 120 ? n / 120 * 6.3 : n < 360 ? 6.3 : Math.max(0, 6.3 - (n - 360) * 0.06)
    const direction = n < 240 ? 0 : Math.PI / 4
    const vx = Math.cos(direction) * speed, vy = Math.sin(direction) * speed
    x += vx * dt; y += vy * dt
    animation.runPosture = 0
    animate(before, dt, n * dt, x, y, vx, vy, 0)
    animation.runPosture = 0.18
    animate(after, dt, n * dt, x, y, vx, vy, 0)
    expect(after.phase).toBe(before.phase)
    expect(after.feet).toEqual(before.feet)
    expect(after.motion.swings).toEqual(before.motion.swings)
    expect(after.motion.toes).toEqual(before.motion.toes)
    expect(after.body!.pelvis.p).toEqual(before.body!.pelvis.p)
    expect(after.body!.gun).toEqual(before.body!.gun)
    expect(after.body!.head.p).toEqual(at(after.body!.torso, 0.02, RIG.neckY, 0))
    for (let i = 0; i < 2; i++) if (after.feet[i]!.planted) expect(after.body!.ft[i]).toEqual(before.body!.ft[i])
    if (n === 220) {
      expect(after.body!.pelvis.x[1]).toBeLessThan(-0.12)
      expect(after.body!.torso.x[1]).toBeLessThan(before.body!.torso.x[1] - 0.12)
    }
  }
})

test("run lean stays bounded and continuous across acceleration, braking and reversal", () => {
  for (const posture of [0, 0.18, 0.3]) {
    animation.runPosture = posture
    const a = newAvatar("lean-bounds", 0, 0, 0, "rifle")
    let x = 0, y = 0, previous = 0
    for (let n = 0; n < 720; n++) {
      const t = n * dt, speed = t < 2 ? t * 3.15 : t < 4 ? 6.3 : t < 6 ? (6 - t) * 3.15 : t < 8 ? -(t - 6) * 2.1 : t < 10 ? -4.2 : 0
      const vx = speed * Math.cos(t * 0.12), vy = speed * Math.sin(t * 0.12)
      x += vx * dt; y += vy * dt
      animate(a, dt, t, x, y, vx, vy, 0)
      expect(Number.isFinite(a.motion.posture.x)).toBe(true)
      expect(a.motion.posture.x).toBeGreaterThanOrEqual(0)
      expect(a.motion.posture.x).toBeLessThanOrEqual(posture * 1.25 + 1e-9)
      expect(Math.abs(a.motion.posture.x - previous)).toBeLessThan(0.035)
      expect(Math.abs(Math.asin(a.body!.torso.x[1]))).toBeLessThan(0.75)
      expect(bodyJoints(a.body!, a.gun).flat().every(Number.isFinite)).toBe(true)
      previous = a.motion.posture.x
    }
  }
})
