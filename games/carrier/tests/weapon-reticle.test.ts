import { describe, expect, test } from "bun:test"
import { Bullets } from "../shared/combat"
import { PLANE, type Plane, type Quat, type Vec3, bodyToWorld, makePlane, quatAxis, quatMul } from "../shared/plane"
import { type Target, makeTarget, WEAPONS } from "../shared/weapons"
import { gunLead, makeGunLead } from "../src/weapons/reticle"

const DT = PLANE.tick

/** A jet at (x, y, z) with its nose along unit `dir`, flying `speed` along heading 0 (north, -z). */
function jet(x: number, y: number, z: number, dir: Vec3, speed: number): Plane {
  const p = makePlane(0)
  const yaw = Math.atan2(dir[0], -dir[2])
  const dive = -Math.asin(dir[1])
  const q: Quat = quatMul(quatAxis(0, 1, 0, Math.PI - yaw), quatAxis(1, 0, 0, dive))
  ;[p.qx, p.qy, p.qz, p.qw] = q
  p.x = x
  p.y = y
  p.z = z
  p.vz = -speed
  return p
}

/** Fires a short burst along the jet's boresight as `Weapons.tick` does and flies it against `t`: rounds that hit. */
function burst(p: Plane, t: Target): number {
  const b = new Bullets()
  const f = bodyToWorld(p, 0, 0, 1)
  const u = bodyToWorld(p, 0, 1, 0)
  const l = bodyToWorld(p, 1, 0, 0)
  const m = bodyToWorld(p, ...WEAPONS.gun.muzzleAt)
  for (let i = 0; i < 10; i++) b.fire(1, 0, i, p.x + m[0], p.y + m[1], p.z + m[2], [p.vx, p.vy, p.vz], f, u, l)
  let hits = 0
  for (let s = 0; s < WEAPONS.gun.life / DT + 2; s++) {
    t.x += t.vx * DT
    t.y += t.vy * DT
    t.z += t.vz * DT
    b.step(DT, s * DT, [t], { sea: null, arch: null }, (_o, target) => {
      if (target >= 0) hits++
    })
  }
  return hits
}

describe("gun lead cue", () => {
  test("the boresight on the cue puts the rounds on a crossing jet", () => {
    const target = (): Target => Object.assign(makeTarget(7, 1), { x: 60, y: 1030, z: -700, vx: -140, vy: 10, vz: -120 })
    const ahead = jet(0, 1000, 0, [0, 0, -1], 220)
    const lead = gunLead(ahead, [target()], 0, makeGunLead())
    expect(lead).not.toBeNull()
    expect(lead!.range).toBeGreaterThan(0)
    expect(lead!.range).toBeLessThan(1)
    expect(lead!.solution).toBe(false)
    // Aimed straight at the target the burst misses; aimed at the cue it hits.
    expect(burst(ahead, target())).toBe(0)
    const aimed = jet(0, 1000, 0, lead!.dir, 220)
    expect(gunLead(aimed, [target()], 0, makeGunLead())!.solution).toBe(true)
    expect(burst(aimed, target())).toBeGreaterThan(5)
  })

  test("no cue for friends, boats or jets out of the gun's reach", () => {
    const p = jet(0, 1000, 0, [0, 0, -1], 220)
    const friend = Object.assign(makeTarget(2, 0), { y: 1000, z: -600 })
    const boat = Object.assign(makeTarget(3, 1), { y: 1000, z: -600, surface: true })
    const far = Object.assign(makeTarget(4, 1), { y: 1000, z: -2500 })
    const wide = Object.assign(makeTarget(5, 1), { x: 600, y: 1000, z: -300 })
    expect(gunLead(p, [friend, boat, far, wide], 0, makeGunLead())).toBeNull()
  })
})
