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
      const old = a.feet.map((f, i) => ({ planted: f.planted, p: f.p.slice() as typeof f.p, rendered: a.body ? a.body.toe![i]!.p : null }))
      animate(a, dt, n * dt, vx * n * dt, vy * n * dt, vx, vy, spin * n * dt)
      for (let i = 0; i < 2; i++) {
        if (!old[i]!.planted && a.feet[i]!.planted) steps++
        if (n > 0 && old[i]!.planted && a.feet[i]!.planted) {
          expect(a.feet[i]!.p).toEqual(old[i]!.p)
          const toe = a.body!.toe![i]!.p
          for (let axis = 0; axis < 3; axis++) expect(toe[axis]!).toBeCloseTo(old[i]!.rendered![axis]!, 12)
          contacts++
        }
      }
      // Side-steps keep the boots apart across the leg heading; they never pass through each other.
      if (vy !== 0) {
        const s = Math.sin(a.legYaw), c = Math.cos(a.legYaw)
        const d = [a.feet[1].p[0] - a.feet[0].p[0], a.feet[1].p[2] - a.feet[0].p[2]]
        expect(-d[0]! * s + d[1]! * c).toBeGreaterThanOrEqual(0.15)
      }
      expect(Math.abs(angleDiff(a.legYaw, a.aim))).toBeLessThanOrEqual(1.050001)
      expect(a.body!.pelvis.p[1]).toBeGreaterThan(vx >= 4.2 ? 0.66 : 0.75)
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

test("running posture and crouch depth shape the trunk and knees without altering cadence, contacts or gun aim", () => {
  const before = newAvatar("attitude", 0, 0, 0, "rifle"), after = newAvatar("attitude", 0, 0, 0, "rifle")
  let x = 0, y = 0
  for (let n = 0; n < 600; n++) {
    const speed = n < 120 ? n / 120 * 6.3 : n < 360 ? 6.3 : Math.max(0, 6.3 - (n - 360) * 0.06)
    const direction = n < 240 ? 0 : Math.PI / 4
    const vx = Math.cos(direction) * speed, vy = Math.sin(direction) * speed
    x += vx * dt; y += vy * dt
    animation.runPosture = 0
    animation.crouchDepth = 0
    animate(before, dt, n * dt, x, y, vx, vy, 0)
    animation.runPosture = defaults.runPosture
    animation.crouchDepth = defaults.crouchDepth
    animate(after, dt, n * dt, x, y, vx, vy, 0)
    expect(after.phase).toBe(before.phase)
    expect(after.feet).toEqual(before.feet)
    expect(after.motion.swings).toEqual(before.motion.swings)
    expect(after.motion.toes).toEqual(before.motion.toes)
    expect(after.body!.pelvis.p[0]).toBeCloseTo(before.body!.pelvis.p[0], 12)
    expect(after.body!.pelvis.p[2]).toBeCloseTo(before.body!.pelvis.p[2], 12)
    expect(after.body!.pelvis.p[1]).toBeLessThanOrEqual(before.body!.pelvis.p[1] + 1e-12)
    expect(after.body!.gun!.x).toEqual(before.body!.gun!.x)
    expect(after.body!.head.p).toEqual(at(after.body!.torso, 0.02, RIG.neckY, 0))
    for (let i = 0; i < 2; i++) if (after.feet[i]!.planted) expect(after.body!.ft[i]).toEqual(before.body!.ft[i])
    if (n === 220) {
      expect(after.body!.pelvis.p[1]).toBeLessThan(before.body!.pelvis.p[1] - 0.07)
      expect(after.body!.pelvis.x[1]).toBeLessThan(-0.2)
      expect(after.body!.torso.x[1]).toBeLessThan(before.body!.torso.x[1] - 0.2)
    }
  }
})

test("run lean stays bounded and continuous across acceleration, braking and reversal", () => {
  for (const posture of [0, 0.18, 0.3, 0.45]) {
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
      expect(Math.abs(a.motion.posture.x - previous)).toBeLessThan(0.05)
      expect(Math.abs(Math.asin(a.body!.torso.x[1]))).toBeLessThan(0.85)
      expect(bodyJoints(a.body!, a.gun).flat().every(Number.isFinite)).toBe(true)
      previous = a.motion.posture.x
    }
  }
})

test("crouch run increases trunk lean, pelvis lowering and knee bend with speed while keeping strafe/backpedal sensible", () => {
  const sample = (vx: number, vy: number) => {
    const a = newAvatar("posture-speed", 0, 0, 0, "rifle")
    let x = 0, y = 0, pelY = 0, pelX = 0, headX = 0, pelPitch = 0, chestPitch = 0, headPitch = 0, kneeBend = 0
    const warmup = 120, count = 240
    for (let n = 0; n < warmup + count; n++) {
      x += vx * dt; y += vy * dt
      animate(a, dt, n * dt, x, y, vx, vy, 0)
      if (n < warmup) continue
      const b = a.body!
      const deg = (f: typeof b.pelvis) => Math.atan2(f.x[1], Math.hypot(f.x[0], f.x[2])) * 180 / Math.PI
      pelY += b.pelvis.p[1]
      pelX += b.pelvis.p[0] - x
      headX += b.head.p[0] - x
      pelPitch += deg(b.pelvis)
      chestPitch += deg(b.torso)
      headPitch += deg(b.head)
      for (let i = 0; i < 2; i++) {
        const dotY = b.th[i]!.y[0] * b.sh[i]!.y[0] + b.th[i]!.y[1] * b.sh[i]!.y[1] + b.th[i]!.y[2] * b.sh[i]!.y[2]
        kneeBend += Math.acos(Math.max(-1, Math.min(1, dotY))) * 90 / Math.PI
      }
    }
    return {
      pelY: pelY / count, pelX: pelX / count, headX: headX / count,
      pelPitch: pelPitch / count, chestPitch: chestPitch / count, headPitch: headPitch / count,
      kneeBend: kneeBend / count, posture: a.motion.posture.x,
    }
  }
  const walk = sample(1.4, 0), run = sample(4.2, 0), sprint = sample(6.3, 0)
  const strafe = sample(0, 4.2), back = sample(-4.2, 0)
  // Forward lean and crouch scale monotonically: walk -> run -> sprint.
  expect(-walk.chestPitch).toBeLessThan(10)
  expect(-run.chestPitch).toBeGreaterThan(24)
  expect(-sprint.chestPitch).toBeGreaterThan(-run.chestPitch + 6)
  expect(-run.pelPitch).toBeGreaterThan(10)
  expect(-sprint.pelPitch).toBeGreaterThan(-run.pelPitch + 2)
  expect(run.pelY).toBeLessThan(walk.pelY - 0.08)
  expect(sprint.pelY).toBeLessThan(run.pelY - 0.02)
  expect(run.kneeBend).toBeGreaterThan(walk.kneeBend + 15)
  expect(sprint.kneeBend).toBeGreaterThan(walk.kneeBend + 15)
  // Hips behind root, head forward of pelvis, head stabilised to look ahead.
  expect(run.pelX).toBeLessThan(-0.02)
  expect(run.headX - run.pelX).toBeGreaterThan(0.28)
  expect(sprint.headX - sprint.pelX).toBeGreaterThan(0.35)
  expect(Math.abs(run.headPitch)).toBeLessThan(8.5)
  // Strafe and backpedal do not pitch forward into a run lean.
  expect(strafe.posture).toBeCloseTo(0, 8)
  expect(back.posture).toBeCloseTo(0, 8)
  expect(Math.abs(strafe.pelPitch)).toBeLessThan(0.5)
  expect(Math.abs(back.pelPitch)).toBeLessThan(0.5)
  expect(back.chestPitch).toBeGreaterThan(-5)
  expect(back.chestPitch).toBeLessThan(1)
})

test("weapon frame is at least as stable as old during locomotion, stops and 30 Hz mux stepping while keeping aim accurate", () => {
  const measure = (mode: "old" | "new", scenario: "run" | "strafe" | "stop" | "aim" | "mux") => {
    animation.animationMode = mode
    const a = newAvatar("gun-stability", 0, 0, 0, "rifle")
    let x = 0, y = 0, bodyX = 0
    const gripX: number[] = [], gripZ: number[] = [], muzZ: number[] = [], shDist: number[] = [], yawErr: number[] = [], pitchArr: number[] = []
    for (let n = 0; n < 300; n++) {
      const t = n * dt
      const vx = scenario === "strafe" ? 0 : scenario === "stop" ? (n < 150 ? 4.2 : 0) : 4.2
      const vy = scenario === "strafe" ? (Math.floor(t * 2) % 2 === 0 ? 4.2 : -4.2) : 0
      const aim = scenario === "aim" ? Math.sin(t * 3) * 0.8 : 0
      if (scenario === "mux") {
        if (n % 2 === 0) bodyX += vx / 30
        x = bodyX
      } else {
        x += vx * dt; y += vy * dt
      }
      animate(a, dt, t, x, y, vx, vy, aim)
      if (scenario === "stop" ? n >= 140 && n < 210 : n >= 90) {
        const g = a.body!.gun!, sh = at(a.body!.torso, 0, RIG.shoulderY, 0)
        const muzzle = at(g, 0.66, 0.03, 0)
        gripX.push(g.p[0] - x); gripZ.push(g.p[2] - y); muzZ.push(muzzle[2] - y)
        shDist.push(Math.hypot(g.p[0] - sh[0], g.p[2] - sh[2]))
        yawErr.push(angleDiff(Math.atan2(g.x[2], g.x[0]), aim))
        pitchArr.push(Math.asin(g.x[1]))
      }
    }
    const rms = (arr: number[]) => {
      const m = arr.reduce((s, v) => s + v, 0) / arr.length
      return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length)
    }
    const hf = (arr: number[]) => {
      let s = 0
      for (let i = 1; i < arr.length; i++) s += (arr[i]! - arr[i - 1]!) ** 2
      return Math.sqrt(s / (arr.length - 1))
    }
    return {
      gripXRms: rms(gripX), gripXHf: hf(gripX), gripZRms: rms(gripZ), gripZHf: hf(gripZ),
      muzZRms: rms(muzZ), muzZHf: hf(muzZ), yawRms: rms(yawErr), yawHf: hf(yawErr),
      pitchRms: rms(pitchArr), pitchHf: hf(pitchArr),
      maxYawErr: Math.max(...yawErr.map(Math.abs)),
      minShDist: Math.min(...shDist), maxShDist: Math.max(...shDist),
    }
  }
  for (const scenario of ["run", "strafe", "stop", "aim", "mux"] as const) {
    const oldM = measure("old", scenario), newM = measure("new", scenario)
    expect(newM.gripXRms).toBeLessThanOrEqual(oldM.gripXRms + 1e-4)
    expect(newM.gripXHf).toBeLessThanOrEqual(oldM.gripXHf + 1e-4)
    expect(newM.muzZRms).toBeLessThanOrEqual(oldM.muzZRms + 1e-4)
    expect(newM.muzZHf).toBeLessThanOrEqual(oldM.muzZHf + 1e-4)
    expect(newM.yawRms).toBeLessThanOrEqual(oldM.yawRms + 1e-4)
    expect(newM.yawHf).toBeLessThanOrEqual(oldM.yawHf + 1e-4)
    expect(newM.pitchRms).toBeLessThanOrEqual(oldM.pitchRms + 1e-4)
    expect(newM.pitchHf).toBeLessThanOrEqual(oldM.pitchHf + 1e-4)
    expect(newM.maxYawErr).toBeLessThan(0.035)
    expect(newM.minShDist).toBeGreaterThan(0.18)
    // 0.330 → 0.335 (AR-95): the hip-reach catch steps change the body's sway in 2 Hz A/D reversals at 4.2 m/s; the
    // grip still sits within 34 cm of the shoulder.
    expect(newM.maxShDist).toBeLessThan(0.335)
  }
})

test("reversals, sharp turns, strafe transitions, hard stops and mux stepping have no foot kick-out, knee flip or pelvis whip", () => {
  const scenarios: { name: string; steps: number; step: (n: number) => { dt: number; vx: number; vy: number; aim: number; mux?: boolean } }[] = [
    { name: "180-reversal-sprint", steps: 240, step: n => ({ dt, vx: n < 90 ? 6.3 : -6.3, vy: 0, aim: 0 }) },
    { name: "sharp-90-turn-sprint", steps: 240, step: n => ({ dt, vx: n < 90 ? 6.3 : 0, vy: n < 90 ? 0 : 6.3, aim: n < 90 ? 0 : Math.PI / 2 }) },
    { name: "strafe-to-run", steps: 300, step: n => { const ang = n / 300 * Math.PI * 2; return { dt, vx: Math.cos(ang) * 4.2, vy: Math.sin(ang) * 4.2, aim: 0 } } },
    { name: "strafe-reversal", steps: 240, step: n => ({ dt, vx: 0, vy: Math.floor(n / 45) % 2 === 0 ? 4.2 : -4.2, aim: 0 }) },
    { name: "start-stop-sprint", steps: 240, step: n => ({ dt, vx: n >= 30 && n < 120 ? 6.3 : 0, vy: 0, aim: 0 }) },
    { name: "mux-30-in-60", steps: 240, step: n => ({ dt, vx: n < 150 ? 4.2 : 0, vy: 0, aim: 0, mux: true }) },
  ]
  for (const sc of scenarios) {
    const a = newAvatar(sc.name, 0, 0, 0, "rifle")
    let x = 0, y = 0, t = 0, muxX = 0, muxY = 0
    let prevFootP: [number, number, number][] | null = null
    let prevAnkles: [number, number, number][] | null = null
    let prevToes: [number, number, number][] | null = null
    let prevPlanted: boolean[] | null = null
    let prevPelPitch = 0, prevPelY = 0
    for (let n = 0; n < sc.steps; n++) {
      const s = sc.step(n)
      t += s.dt
      if (s.mux) {
        if (n % 2 === 0) { muxX += s.vx * (2 / 60); muxY += s.vy * (2 / 60) }
        x = muxX; y = muxY
      } else {
        x += s.vx * s.dt; y += s.vy * s.dt
      }
      animate(a, s.dt, t, x, y, s.vx, s.vy, s.aim)
      const b = a.body!
      const footP = a.feet.map(f => [...f.p] as [number, number, number])
      const ankles = b.ft.map(f => [...f.p] as [number, number, number])
      const toes = b.toe!.map(t => [...t.p] as [number, number, number])
      const planted = a.feet.map(f => f.planted)
      const pelPitch = Math.asin(b.pelvis.x[1]), pelY = b.pelvis.p[1]
      if (n > 0) {
        expect(Math.abs(pelPitch - prevPelPitch)).toBeLessThan(0.05)
        expect(Math.abs(pelY - prevPelY)).toBeLessThan(0.03)
        for (let i = 0; i < 2; i++) {
          const df = Math.hypot(footP[i]![0] - prevFootP![i]![0], footP[i]![1] - prevFootP![i]![1], footP[i]![2] - prevFootP![i]![2])
          const da = Math.hypot(ankles[i]![0] - prevAnkles![i]![0], ankles[i]![1] - prevAnkles![i]![1], ankles[i]![2] - prevAnkles![i]![2])
          expect(df).toBeLessThan(0.34)
          expect(da).toBeLessThan(0.34)
          if (planted[i] && prevPlanted![i]) {
            const dtSlip = Math.hypot(toes[i]![0] - prevToes![i]![0], toes[i]![1] - prevToes![i]![1], toes[i]![2] - prevToes![i]![2])
            expect(dtSlip).toBeLessThan(1e-12)
          }
        }
      }
      for (let i = 0; i < 2; i++) {
        const hip = b.th[i]!.p, knee = at(b.th[i]!, 0, -RIG.thigh, 0), shinEnd = at(b.sh[i]!, 0, -RIG.shin, 0)
        const mid = [(hip[0] + shinEnd[0]) * 0.5, (hip[1] + shinEnd[1]) * 0.5, (hip[2] + shinEnd[2]) * 0.5]
        // The knee tracks over the boot, which may turn from the pelvis while strafing.
        const fy = a.feet[i]!.yaw, fx = [Math.cos(fy), 0, Math.sin(fy)], fz = [-Math.sin(fy), 0, Math.cos(fy)]
        const kneeFwd = (knee[0] - mid[0]!) * fx[0]! + (knee[2] - mid[2]!) * fx[2]!
        const kneeSide = Math.abs((knee[0] - mid[0]!) * fz[0]! + (knee[2] - mid[2]!) * fz[2]!)
        expect(kneeFwd).toBeGreaterThan(-0.01)
        expect(kneeSide).toBeLessThan(0.17)
      }
      prevFootP = footP; prevAnkles = ankles; prevToes = toes; prevPlanted = planted
      prevPelPitch = pelPitch; prevPelY = pelY
    }
  }
})

test("walk-to-run-to-sprint-to-walk speed ramp and strafe reversals keep phase, posture and feet continuous", () => {
  const a = newAvatar("speed-ramp", 0, 0, 0, "rifle")
  let x = 0, prevPhase = 0, prevPosture = 0, prevCrouch = 0
  let prevFeet: [number, number, number][] | null = null
  for (let n = 0; n < 480; n++) {
    const u = n < 240 ? n / 240 : (480 - n) / 240
    const vx = 0.8 + u * 5.5
    x += vx * dt
    animate(a, dt, n * dt, x, 0, vx, 0, 0)
    if (n > 0) {
      const dPhase = ((a.phase - prevPhase + 1.5) % 1) - 0.5
      expect(dPhase).toBeGreaterThanOrEqual(-1e-6)
      expect(dPhase).toBeLessThan(0.08)
      expect(Math.abs(a.motion.posture.x - prevPosture)).toBeLessThan(0.025)
      expect(Math.abs(a.motion.crouch.x - prevCrouch)).toBeLessThan(0.01)
      for (let i = 0; i < 2; i++) {
        const df = Math.hypot(a.feet[i]!.p[0] - prevFeet![i]![0], a.feet[i]!.p[1] - prevFeet![i]![1], a.feet[i]!.p[2] - prevFeet![i]![2])
        expect(df).toBeLessThan(0.28)
      }
    }
    prevPhase = a.phase; prevPosture = a.motion.posture.x; prevCrouch = a.motion.crouch.x
    prevFeet = a.feet.map(f => [...f.p] as [number, number, number])
  }

  // Strafe left <-> right reversals at run speed cross over cleanly: the hips turn toward travel and the boots
  // pass on either side of the travel line without touching.
  const st = newAvatar("strafe-shuffle", 0, 0, 0, "rifle")
  let y = 0
  const boot = (f: { p: number[]; yaw: number }) => [[f.p[0]! - Math.cos(f.yaw) * 0.07, f.p[2]! - Math.sin(f.yaw) * 0.07], [f.p[0]! + Math.cos(f.yaw) * 0.19, f.p[2]! + Math.sin(f.yaw) * 0.19]] as const
  const segGap = (a: readonly (readonly number[])[], b: readonly (readonly number[])[]) => {
    let best = Infinity
    for (let k = 0; k <= 20; k++) for (let q = 0; q <= 20; q++) {
      const pa = [a[0]![0]! + (a[1]![0]! - a[0]![0]!) * k / 20, a[0]![1]! + (a[1]![1]! - a[0]![1]!) * k / 20]
      const pb = [b[0]![0]! + (b[1]![0]! - b[0]![0]!) * q / 20, b[0]![1]! + (b[1]![1]! - b[0]![1]!) * q / 20]
      best = Math.min(best, Math.hypot(pa[0]! - pb[0]!, pa[1]! - pb[1]!))
    }
    return best
  }
  for (let n = 0; n < 240; n++) {
    const vy = n < 80 ? 3.8 : n < 160 ? -3.8 : 3.8
    y += vy * dt
    animate(st, dt, n * dt, 0, y, 0, vy, 0)
    // Boots at different heights pass over each other; only compare them near the floor.
    if (Math.max(st.feet[0].p[1], st.feet[1].p[1]) < 0.06 && segGap(boot(st.feet[0]), boot(st.feet[1])) < 0.08) console.log("GAP", n, segGap(boot(st.feet[0]), boot(st.feet[1])).toFixed(3), st.feet.map(f => (f.planted ? "P" : "s") + f.p[1].toFixed(2) + "@" + f.p[0].toFixed(2) + "," + (f.p[2] - y).toFixed(2) + " y" + (f.yaw * 57.3).toFixed(0)).join(" "), (st.legYaw * 57.3).toFixed(0), (st.motion as any).strafeCross.toFixed(2), ((st.motion as any).strafePhi * 57.3).toFixed(0), st.svy.toFixed(2))
    if (Math.max(st.feet[0].p[1], st.feet[1].p[1]) < 0.06) expect(segGap(boot(st.feet[0]), boot(st.feet[1]))).toBeGreaterThan(0.08)
    expect(Math.abs(angleDiff(st.legYaw, st.aim))).toBeLessThanOrEqual(1.050001)
    if (n === 70) expect(angleDiff(st.legYaw, st.aim)).toBeGreaterThan(0.6)
    if (n === 150) expect(angleDiff(st.legYaw, st.aim)).toBeLessThan(-0.6)
  }
})

test("walk (<=1.8 m/s) stays upright with level head and no crouch, and unarmed survivor does not inherit soldier crouch-run", () => {
  const deg = (f: { x: [number, number, number] }) => Math.atan2(f.x[1], Math.hypot(f.x[0], f.x[2])) * 180 / Math.PI
  for (const speed of [1.4, 1.8] as const) {
    for (const unarmed of [true, false] as const) {
      const a = newAvatar(`walk-${speed}-${unarmed}`, 0, 0, 0, "rifle")
      a.unarmed = unarmed
      let x = 0
      for (let n = 0; n < 240; n++) {
        x += speed * dt
        animate(a, dt, n * dt, x, 0, speed, 0, 0)
        if (n >= 120) {
          const b = a.body!
          const pelPitch = -deg(b.pelvis), chestPitch = -deg(b.torso), headPitch = Math.abs(deg(b.head))
          expect(pelPitch).toBeLessThan(1.0)
          expect(chestPitch).toBeGreaterThan(2.5)
          expect(chestPitch).toBeLessThan(6.0)
          expect(headPitch).toBeLessThan(3.5)
          expect(a.motion.crouch.x).toBeLessThan(0.005)
        }
      }
    }
  }
  const survRun = newAvatar("survivor-run", 0, 0, 0, "rifle")
  survRun.unarmed = true
  const soldRun = newAvatar("soldier-run", 0, 0, 0, "rifle")
  let x = 0
  for (let n = 0; n < 180; n++) {
    x += 4.2 * dt
    animate(survRun, dt, n * dt, x, 0, 4.2, 0, 0)
    animate(soldRun, dt, n * dt, x, 0, 4.2, 0, 0)
  }
  const survChestPitch = -deg(survRun.body!.torso)
  const soldChestPitch = -deg(soldRun.body!.torso)
  expect(survChestPitch).toBeGreaterThan(10)
  expect(survChestPitch).toBeLessThan(18)
  expect(soldChestPitch).toBeGreaterThan(24)
  expect(survRun.body!.pelvis.p[1]).toBeGreaterThan(soldRun.body!.pelvis.p[1] + 0.04)
  expect(survRun.body!.gun).toBeNull()
  expect(soldRun.body!.gun).not.toBeNull()
})

test("the shared avatar adapter normalises gait to Blackout's run speed and gun set", async () => {
  const { AVATAR_RUN_SPEED, GUN_IDS: AVATAR_GUNS } = await import("@arcade/kit/avatar/gun")
  const { SPEED, GUN_IDS } = await import("../shared/config")
  expect(AVATAR_RUN_SPEED).toBe(SPEED)
  expect(AVATAR_GUNS).toEqual(GUN_IDS)
})
