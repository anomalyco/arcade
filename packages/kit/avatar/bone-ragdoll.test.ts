import { describe, expect, test } from "bun:test"
import {
  blastRagdoll,
  bonePoints,
  createBoneRagdoll,
  impulseRagdoll,
  ragdollHips,
  ragdollStretch,
  RAGDOLL_BONES,
  standingBones,
  stepBoneRagdoll,
  sweepRagdoll,
  writeRagdollBones,
  type BoneRagdoll,
} from "./bone-ragdoll"
import { HitReactions } from "./hit-reaction"

const flat = () => 0

function run(r: BoneRagdoll, seconds: number, ground: (x: number, z: number) => number = flat): number {
  let t = 0
  for (; t < seconds && !r.asleep; t += 1 / 60) stepBoneRagdoll(r, 1 / 60, ground)
  return t
}

function standing(seed = 7) {
  const bones = standingBones(3, 4, 0.4)
  return { bones, r: createBoneRagdoll({ bones, off: 0, seed }) }
}

describe("bone ragdoll", () => {
  test("binds without a pop: the first write reproduces the pose it started from", () => {
    const { bones, r } = standing()
    const out = new Float32Array(RAGDOLL_BONES * 12)
    writeRagdollBones(r, out, 0)
    for (let i = 0; i < out.length; i++) expect(Math.abs(out[i]! - bones[i]!)).toBeLessThan(1e-4)
  })

  test("falls, settles on the floor, keeps its limb lengths and sleeps", () => {
    const { r } = standing()
    impulseRagdoll(r, { dirX: 1, dirZ: 0, push: 2.2, buckle: 0.8 })
    const t = run(r, 8)
    expect(r.asleep).toBe(true)
    expect(t).toBeLessThan(5)
    expect(ragdollStretch(r)).toBeLessThan(0.04)
    const hips = ragdollHips(r)
    expect(hips.y).toBeLessThan(0.3)
    expect(hips.y).toBeGreaterThan(0.05)
    for (let i = 0; i < r.pos.length; i += 3) {
      expect(Number.isFinite(r.pos[i]!)).toBe(true)
      expect(r.pos[i + 1]!).toBeGreaterThan(0.02)
    }
    // A push of 2.2 m/s carries the body a little way, not across the street.
    expect(Math.hypot(hips.x - 3, hips.z - 4)).toBeLessThan(2.2)
  })

  test("falls the way it was pushed", () => {
    for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
      const { r } = standing()
      impulseRagdoll(r, { dirX: dx, dirZ: dz, push: 3 })
      run(r, 6)
      const before = bonePoints(standingBones(3, 4, 0.4), 0, new Float32Array(48))
      // The crown moves along the push.
      const mx = r.pos[15] - before[15]!
      const mz = r.pos[17] - before[17]!
      expect(mx * dx + mz * dz).toBeGreaterThan(0.4)
    }
  })

  test("is deterministic for the same pose, impulse and seed", () => {
    const a = standing(11).r
    const b = standing(11).r
    for (const r of [a, b]) {
      impulseRagdoll(r, { dirX: 0.3, dirZ: 1, push: 2.5, spin: 1.4, buckle: 0.5 })
      sweepRagdoll(r, { x: 3, z: 4, yaw: 0, halfLength: 1, halfWidth: 1 }, 1, 6, 1, 2)
      run(r, 3)
    }
    expect(Array.from(a.pos)).toEqual(Array.from(b.pos))
  })

  test("stays stable under a violent blast and a car sweep, then settles", () => {
    const { r } = standing()
    blastRagdoll(r, 3.5, 0.3, 4, 14, 5, 0.8)
    run(r, 0.4)
    sweepRagdoll(r, { x: 4, z: 4, yaw: 0.3, halfLength: 4, halfWidth: 4 }, 1.2, 12, -3, 3)
    run(r, 10)
    expect(r.asleep).toBe(true)
    expect(ragdollStretch(r)).toBeLessThan(0.06)
    for (const v of r.pos) expect(Number.isFinite(v)).toBe(true)
  })

  test("a sleeping body wakes when pushed and goes back to sleep", () => {
    const { r } = standing()
    run(r, 8)
    expect(r.asleep).toBe(true)
    const before = ragdollHips(r)
    expect(blastRagdoll(r, before.x - 1, 0, before.z, 8, 4)).toBe(true)
    expect(r.asleep).toBe(false)
    run(r, 8)
    expect(r.asleep).toBe(true)
    expect(ragdollHips(r).x).toBeGreaterThan(before.x + 0.3)
  })

  test("collides with walls and follows raised ground", () => {
    const bones = standingBones(0, 0, 0)
    const r = createBoneRagdoll({ bones, off: 0, seed: 3, rects: [[0.6, -3, 1.2, 3]] })
    impulseRagdoll(r, { dirX: 1, dirZ: 0, push: 6 })
    run(r, 8, () => 0.4)
    for (let i = 0; i < r.pos.length; i += 3) {
      expect(r.pos[i]!).toBeLessThan(0.62)
      expect(r.pos[i + 1]!).toBeGreaterThan(0.42)
    }
  })

  test("costs little per step", () => {
    const bodies = Array.from({ length: 16 }, (_, i) => createBoneRagdoll({ bones: standingBones(i, 0, i), off: 0, seed: i + 1 }))
    for (const r of bodies) impulseRagdoll(r, { dirX: 1, dirZ: 0.2, push: 3, lift: 1 })
    const t0 = performance.now()
    for (let f = 0; f < 60; f++) for (const r of bodies) stepBoneRagdoll(r, 1 / 60, flat)
    const msPerFrame = (performance.now() - t0) / 60
    expect(msPerFrame).toBeLessThan(1.5)
  })
})

describe("hit reactions", () => {
  test("a blow from the front leans the trunk back, overshoots and settles", () => {
    const h = new HitReactions()
    h.hit(1, 0, { dirX: -1, dirZ: 0, strength: 4 })
    let peak = 0
    let under = 0
    for (let i = 0; i < 120; i++) {
      h.step(1 / 60)
      const p = h.sample(1)
      if (!p) break
      peak = Math.max(peak, p.pitch)
      under = Math.min(under, p.pitch)
    }
    expect(peak).toBeGreaterThan(0.12)
    expect(under).toBeLessThan(0)
    expect(h.sample(1)).toBeNull()
  })

  test("a blow from behind leans it forward, from the side rolls it, off-centre twists it", () => {
    const h = new HitReactions()
    h.hit(1, 0, { dirX: 1, dirZ: 0, strength: 4 })
    h.hit(2, 0, { dirX: 0, dirZ: 1, strength: 4 })
    h.hit(3, 0, { dirX: -1, dirZ: 0, strength: 4, offset: 1 })
    for (let i = 0; i < 6; i++) h.step(1 / 60)
    expect(h.sample(1)!.pitch).toBeLessThan(-0.05)
    expect(h.sample(2)!.roll).toBeGreaterThan(0.05)
    expect(h.sample(3)!.twist).toBeGreaterThan(0.05)
  })

  test("stays inside its limits however hard it is hit", () => {
    const h = new HitReactions()
    for (let i = 0; i < 10; i++) h.hit(1, 0.3, { dirX: -1, dirZ: 0.2, strength: 12, head: 1, offset: 1 })
    for (let i = 0; i < 30; i++) {
      h.step(1 / 60)
      const p = h.sample(1)!
      expect(Math.abs(p.pitch)).toBeLessThanOrEqual(h.tuning.maxLean)
      expect(Math.abs(p.headPitch)).toBeLessThanOrEqual(h.tuning.maxHead)
      expect(p.drop).toBeLessThanOrEqual(h.tuning.maxDrop)
    }
  })
})
