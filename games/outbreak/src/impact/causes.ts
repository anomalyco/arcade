import type { HitImpulse } from "@arcade/kit/avatar/hit-reaction"
import type { RagdollImpulse } from "@arcade/kit/avatar/bone-ragdoll"
import { MELEE_WEAPONS, type CombatMeleeEvent, type CombatMeleeHit, type CombatShotEvent, type MeleeWeaponId } from "../../shared/combat"

/**
 * What each blow does to a body, as a pure function of the replicated event (its direction, weapon, seed), so every
 * co-op client rocks and drops the same zombie the same way. Strengths are rad/s at the trunk for the living
 * (`HitImpulse`) and m/s for the dead (`RagdollImpulse`); Darkwood weight, not arcade launch: a pistol round
 * crumples, a fire axe folds, a car or dynamite throws.
 */

/** −1..1 from an event seed and a zombie id, the same on every client. */
export function signedHash(seed: number, id: number, salt = 0): number {
  let h = Math.imul((seed ^ 0x9e3779b9) >>> 0, 0x85ebca6b) ^ Math.imul(id + 1 + salt * 977, 0xc2b2ae35)
  h ^= h >>> 15
  h = Math.imul(h, 0x27d4eb2f)
  h ^= h >>> 13
  return ((h >>> 0) / 0xffffffff) * 2 - 1
}

/**
 * How heavy a melee weapon lands, ~0.6 (knife) to ~1.4 (fire axe), crowbar 1: √(damage × knockback) against the
 * crowbar's.
 */
export function weaponWeight(id: MeleeWeaponId): number {
  const d = MELEE_WEAPONS[id] ?? MELEE_WEAPONS.crowbar
  const ref = MELEE_WEAPONS.crowbar
  return Math.sqrt((d.damage * d.knockback) / (ref.damage * ref.knockback))
}

const isBlade = (id: MeleeWeaponId) => MELEE_WEAPONS[id]?.weaponClass === "one-blade"

export type BodyBlow = { living: HitImpulse; dead: RagdollImpulse }

export function shotBlow(shot: CombatShotEvent): BodyBlow {
  const dirX = Math.cos(shot.aim)
  const dirZ = Math.sin(shot.aim)
  const head = shot.detachBone === "head" ? 1 : 0.3
  const off = signedHash(shot.seed, shot.hitZombieId ?? 0)
  const legs = shot.crawler || shot.limp || shot.knockdown
  return {
    living: { dirX, dirZ, strength: legs ? 5.6 : 4.2, offset: off * 0.8, head, buckle: legs ? 0.9 : 0.25 },
    // A round drops them where they stand: a short push back, a twist from where it struck, knees gone.
    dead: { dirX, dirZ, push: head > 0.5 ? 2.3 : 1.7, lift: 0.15, spin: off * 1.3, buckle: head > 0.5 ? 0.4 : 0.95 },
  }
}

export function meleeBlow(swing: CombatMeleeEvent, hit: CombatMeleeHit, zx: number, zy: number): BodyBlow {
  let dirX = zx - swing.x
  let dirZ = zy - swing.y
  const l = Math.hypot(dirX, dirZ)
  if (l < 1e-3) {
    dirX = Math.cos(swing.aim)
    dirZ = Math.sin(swing.aim)
  } else {
    dirX /= l
    dirZ /= l
  }
  const def = MELEE_WEAPONS[swing.weapon] ?? MELEE_WEAPONS.crowbar
  const kb = def.knockback * (swing.heavy ? 1.35 + 0.25 * swing.charge : swing.combo === 3 ? 1.15 : 1)
  // Swings sweep across the body: alternate combo swings come from the other side.
  const across = swing.combo === 2 ? -1 : 1
  const blade = isBlade(swing.weapon)
  const head = hit.headshot || hit.detachBone === "head" ? 1 : 0.4
  const legs = hit.knockdown || hit.crawler || hit.limp
  return {
    living: {
      dirX,
      dirZ,
      strength: 2.6 + 2.2 * kb,
      offset: across * (blade ? 0.9 : 0.65),
      head,
      buckle: legs ? 0.8 : 0.15 + 0.1 * kb,
    },
    dead: {
      dirX,
      dirZ,
      push: 1.1 + 1.25 * kb,
      lift: swing.heavy ? 0.35 * kb : 0.05,
      spin: across * (blade ? 1.6 : 1.0) * (0.6 + 0.4 * kb),
      buckle: swing.finisher ? 0 : blade ? 0.8 : 0.45,
    },
  }
}

/** Your shove: rocks them back hard, never kills. */
export function shoveBlow(aim: number, px: number, py: number, zx: number, zy: number, id: number): HitImpulse {
  const l = Math.hypot(zx - px, zy - py) || 1
  const dirX = l > 1e-3 ? (zx - px) / l : Math.cos(aim)
  const dirZ = l > 1e-3 ? (zy - py) / l : Math.sin(aim)
  return { dirX, dirZ, strength: 5.2, offset: signedHash(id, 77) * 0.4, head: 0.5, buckle: 0.2 }
}

/** A car at `speed` m/s along (dirX, dirZ): the living reel, the dead are thrown and tumble over the bonnet. */
export function vehicleBlow(dirX: number, dirZ: number, speed: number, vx: number, vz: number, id: number, time: number): BodyBlow {
  const spin = signedHash(Math.floor(time * 1000), id) * 2.4
  const s = Math.min(16, Math.max(2, speed))
  const tx = dirX * 0.6 + (Math.hypot(vx, vz) > 0.5 ? (vx / Math.hypot(vx, vz)) * 0.4 : 0)
  const tz = dirZ * 0.6 + (Math.hypot(vx, vz) > 0.5 ? (vz / Math.hypot(vx, vz)) * 0.4 : 0)
  return {
    living: { dirX: tx, dirZ: tz, strength: 4 + s * 0.45, offset: spin * 0.3, head: 0.6, buckle: 0.5 },
    dead: { dirX: tx, dirZ: tz, push: s * 0.55, lift: 1 + s * 0.2, spin, sweep: s * 0.45, buckle: 0 },
  }
}

/** A blast at distance fraction `f` (1 at the centre, 0 at the edge) pushing along (dirX, dirZ). */
export function blastBlow(dirX: number, dirZ: number, f: number, id: number, k: number): BodyBlow {
  const spin = signedHash(k * 131 + 7, id) * (1 + 2 * f)
  return {
    living: { dirX, dirZ, strength: 3 + 7 * f, offset: spin * 0.3, head: 0.6, buckle: 0.6 + 0.6 * f },
    dead: { dirX, dirZ, push: 3 + 6 * f, lift: 1.4 + 3.2 * f, spin, buckle: 0 },
  }
}

/** A death no blow explains (fire, bleeding out, a peer's event we missed): the body's own slide, then it folds. */
export function fallBlow(staggerVx: number, staggerVy: number, aim: number, id: number): RagdollImpulse {
  const v = Math.hypot(staggerVx, staggerVy)
  if (v > 0.3) return { dirX: staggerVx, dirZ: staggerVy, push: Math.min(2.6, v * 0.4), buckle: 0.8, spin: signedHash(id, 3) * 0.8 }
  return { dirX: -Math.cos(aim), dirZ: -Math.sin(aim), push: 0.35, buckle: 1.1, spin: signedHash(id, 5) * 0.9 }
}

/** Scales a ragdoll impulse (Lab › Physics › Death push). */
export function scaled(imp: RagdollImpulse, k: number): RagdollImpulse {
  return {
    dirX: imp.dirX,
    dirZ: imp.dirZ,
    push: imp.push * k,
    lift: (imp.lift ?? 0) * k,
    spin: (imp.spin ?? 0) * k,
    buckle: (imp.buckle ?? 0) * Math.min(1.5, k),
    sweep: (imp.sweep ?? 0) * k,
  }
}
