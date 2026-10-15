import type { MeleeSwingPhase, MeleeWeaponClass } from "@arcade/kit/human-melee"
import { angleDiff, clearLine, distToRect, raycast, type Rect } from "@arcade/kit/sim/geom"
import { Rng } from "@arcade/kit/sim/rng"
import { hasSeveredLeg, type AIAgent, type OutbreakAISubsystem } from "./ai"
import type { Town } from "./map"
import type { ChannelView, PistolAmmo } from "./progression"

export type MeleeHitMaterial = "wood" | "metal" | "blade"

export const PISTOL_RANGE = 26.0
export const PISTOL_MAG_SIZE = 8
export const PISTOL_FIRE_COOLDOWN = 0.24
export const PISTOL_RELOAD_TIME = 1.15
export const PISTOL_NOISE = 32.0
export const RELOAD_NOISE = 2.8
export const SHOVE_RANGE = 1.75
export const SHOVE_ARC = 1.15
export const SHOVE_COOLDOWN = 0.65
export const SHOVE_NOISE = 5.0
export const FINISHER_RANGE = 1.45
export const ZOMBIE_CAPSULE_RADIUS = 0.36

export const DETACHABLE_BONES = [
  "head",
  "left.upperArm",
  "right.upperArm",
  "left.foreArm",
  "right.foreArm",
  "left.thigh",
  "right.thigh",
] as const

export type DetachableBone = (typeof DETACHABLE_BONES)[number]

/**
 * Finds a downed or crawling zombie at the survivor's feet that can be finished off
 * with a contextual stomp or downward melee strike.
 */
export function findFinisherTarget(
  player: { x: number; y: number; aim: number },
  agents: readonly AIAgent[],
  sightBlockers?: readonly Rect[],
): AIAgent | null {
  let best: AIAgent | null = null
  let bestScore = Infinity
  for (let i = 0; i < agents.length; i++) {
    const z = agents[i]!
    if (z.state !== "knockdown" && z.state !== "crawler") continue
    const dx = z.x - player.x
    const dy = z.y - player.y
    const d = Math.hypot(dx, dy)
    if (d > FINISHER_RANGE) continue
    const ang = Math.abs(angleDiff(Math.atan2(dy, dx), player.aim))
    if (d > 0.65 && ang > 1.25) continue
    if (sightBlockers && sightBlockers.length > 0 && !clearLine(player.x, player.y, z.x, z.y, sightBlockers)) {
      continue
    }
    const score = d + ang * 0.35
    if (score < bestScore) {
      bestScore = score
      best = z
    }
  }
  return best
}

export type CombatShotEvent = {
  id: number
  time: number
  fromX: number
  fromY: number
  toX: number
  toY: number
  aim: number
  hitZombieId: number | null
  killed: boolean
  knockdown?: boolean
  crawler?: boolean
  limp?: boolean
  detachBone: DetachableBone | null
  seed: number
}

export const MELEE_WEAPON_IDS = [
  "knife",
  "hammer",
  "pipe",
  "crowbar",
  "machete",
  "bat",
  "spiked-board",
  "axe",
  "fire-axe",
] as const

export type MeleeWeaponId = (typeof MELEE_WEAPON_IDS)[number]

export type MeleeWeaponDef = {
  id: MeleeWeaponId
  label: string
  shortLabel: string
  weaponClass: MeleeWeaponClass
  material: MeleeHitMaterial
  /** Base damage per light swing. */
  damage: number
  /** Center-to-edge reach in metres (before adding zombie capsule radius). */
  reach: number
  /** Total horizontal sweep arc in radians. */
  arc: number
  /** Base swing rate (swings/sec) governing windup, active and recovery durations. */
  speed: number
  /** Stamina fraction (0..1) drained per light swing (heavy costs 1.6×). */
  stamina: number
  /** Knockback and stagger impulse multiplier. */
  knockback: number
  /** Maximum durability hits before breaking. */
  durability: number
  /** Acoustic noise radius in metres on impact (whiffs emit 40% of this). */
  noise: number
  /** Maximum zombies cleaved in a single swing. */
  maxTargets: number
  /** Number of chained swings in a combo (2 or 3). */
  comboLength: 2 | 3
  /** Damage multiplier on sweet-spot / head hits. */
  headMultiplier: number
  /** Structural damage dealt to closed/locked doors or barricades per swing. */
  doorDamage: number
  /** Visual 3D mesh length from right-hand grip to tip in metres. */
  length: number
}

export const MELEE_WEAPONS: Readonly<Record<MeleeWeaponId, MeleeWeaponDef>> = {
  knife: {
    id: "knife",
    label: "Kitchen Knife",
    shortLabel: "KNIFE",
    weaponClass: "one-blade",
    material: "blade",
    damage: 18,
    reach: 1.38,
    arc: 1.08,
    speed: 2.55,
    stamina: 0.06,
    knockback: 0.78,
    durability: 22,
    noise: 3.5,
    maxTargets: 1,
    comboLength: 3,
    headMultiplier: 1.7,
    doorDamage: 0,
    length: 0.42,
  },
  hammer: {
    id: "hammer",
    label: "Claw Hammer",
    shortLabel: "HAMMER",
    weaponClass: "one-blunt",
    material: "metal",
    damage: 21,
    reach: 1.5,
    arc: 1.2,
    speed: 2.05,
    stamina: 0.08,
    knockback: 1.25,
    durability: 32,
    noise: 5.5,
    maxTargets: 2,
    comboLength: 3,
    headMultiplier: 1.6,
    doorDamage: 18,
    length: 0.46,
  },
  pipe: {
    id: "pipe",
    label: "Lead Pipe",
    shortLabel: "PIPE",
    weaponClass: "one-blunt",
    material: "metal",
    damage: 23,
    reach: 1.64,
    arc: 1.3,
    speed: 1.8,
    stamina: 0.1,
    knockback: 1.45,
    durability: 36,
    noise: 6.5,
    maxTargets: 2,
    comboLength: 3,
    headMultiplier: 1.6,
    doorDamage: 20,
    length: 0.64,
  },
  crowbar: {
    id: "crowbar",
    label: "Crowbar",
    shortLabel: "PRY",
    weaponClass: "one-blunt",
    material: "metal",
    damage: 24,
    reach: 1.74,
    arc: 1.36,
    speed: 1.72,
    stamina: 0.11,
    knockback: 1.65,
    durability: 45,
    noise: 6.5,
    maxTargets: 2,
    comboLength: 3,
    headMultiplier: 1.65,
    doorDamage: 25,
    length: 0.72,
  },
  machete: {
    id: "machete",
    label: "Machete",
    shortLabel: "MACHETE",
    weaponClass: "one-blade",
    material: "blade",
    damage: 30,
    reach: 1.8,
    arc: 1.44,
    speed: 1.85,
    stamina: 0.1,
    knockback: 1.15,
    durability: 28,
    noise: 4.5,
    maxTargets: 2,
    comboLength: 3,
    headMultiplier: 1.75,
    doorDamage: 15,
    length: 0.68,
  },
  bat: {
    id: "bat",
    label: "Baseball Bat",
    shortLabel: "BAT",
    weaponClass: "two-heavy",
    material: "wood",
    damage: 27,
    reach: 1.96,
    arc: 1.6,
    speed: 1.52,
    stamina: 0.12,
    knockback: 1.85,
    durability: 30,
    noise: 7.0,
    maxTargets: 3,
    comboLength: 3,
    headMultiplier: 1.65,
    doorDamage: 28,
    length: 0.78,
  },
  "spiked-board": {
    id: "spiked-board",
    label: "Spiked Board",
    shortLabel: "SPIKE",
    weaponClass: "two-heavy",
    material: "wood",
    damage: 29,
    reach: 2.02,
    arc: 1.64,
    speed: 1.44,
    stamina: 0.13,
    knockback: 1.95,
    durability: 20,
    noise: 7.5,
    maxTargets: 3,
    comboLength: 3,
    headMultiplier: 1.65,
    doorDamage: 32,
    length: 0.84,
  },
  axe: {
    id: "axe",
    label: "Wood Axe",
    shortLabel: "AXE",
    weaponClass: "two-heavy",
    material: "blade",
    damage: 34,
    reach: 1.94,
    arc: 1.5,
    speed: 1.34,
    stamina: 0.14,
    knockback: 1.75,
    durability: 32,
    noise: 8.0,
    maxTargets: 3,
    comboLength: 3,
    headMultiplier: 1.75,
    doorDamage: 50,
    length: 0.7,
  },
  "fire-axe": {
    id: "fire-axe",
    label: "Fire Axe",
    shortLabel: "FIRE AXE",
    weaponClass: "two-heavy",
    material: "blade",
    damage: 38,
    reach: 2.14,
    arc: 1.68,
    speed: 1.15,
    stamina: 0.17,
    knockback: 1.95,
    durability: 38,
    noise: 9.0,
    maxTargets: 3,
    comboLength: 2,
    headMultiplier: 1.8,
    doorDamage: 80,
    length: 0.88,
  },
}

export function isMeleeWeapon(item: string | null | undefined): item is MeleeWeaponId {
  return Boolean(item && item in MELEE_WEAPONS)
}

export type MeleeTuning = {
  meleeDamageScale: number
  meleeReachScale: number
  meleeArcScale: number
  meleeSpeedScale: number
  meleeStaminaScale: number
  meleeKnockbackScale: number
  meleeDurabilityWear: number
  meleeNoiseScale: number
  meleeChargeTime: number
  meleeComboWindow: number
}

export const DEFAULT_MELEE_TUNING: MeleeTuning = {
  meleeDamageScale: 1.0,
  meleeReachScale: 1.0,
  meleeArcScale: 1.0,
  meleeSpeedScale: 1.0,
  meleeStaminaScale: 1.0,
  meleeKnockbackScale: 1.0,
  meleeDurabilityWear: 1.0,
  meleeNoiseScale: 1.0,
  meleeChargeTime: 0.34,
  meleeComboWindow: 0.26,
}

export const meleeControls = [
  { key: "meleeDamageScale", label: "Damage scale", group: "Melee", min: 0.25, max: 3, step: 0.05, unit: "×" },
  { key: "meleeReachScale", label: "Reach scale", group: "Melee", min: 0.5, max: 2, step: 0.05, unit: "×" },
  { key: "meleeArcScale", label: "Arc width", group: "Melee", min: 0.5, max: 2, step: 0.05, unit: "×" },
  { key: "meleeSpeedScale", label: "Swing speed", group: "Melee", min: 0.5, max: 2.5, step: 0.05, unit: "×" },
  { key: "meleeStaminaScale", label: "Stamina cost", group: "Melee", min: 0, max: 2.5, step: 0.05, unit: "×" },
  { key: "meleeKnockbackScale", label: "Knockback", group: "Melee", min: 0.25, max: 2.5, step: 0.05, unit: "×" },
  { key: "meleeDurabilityWear", label: "Durability wear", group: "Melee", min: 0, max: 3, step: 0.25, unit: "×" },
  { key: "meleeNoiseScale", label: "Impact noise", group: "Melee", min: 0, max: 2.5, step: 0.05, unit: "×" },
  { key: "meleeChargeTime", label: "Heavy charge time", group: "Melee", min: 0.14, max: 0.8, step: 0.02, unit: "s" },
  { key: "meleeComboWindow", label: "Combo window", group: "Melee", min: 0.08, max: 0.5, step: 0.02, unit: "s" },
] as const

export type CombatMeleeHit = {
  zombieId: number
  x: number
  y: number
  damage: number
  killed: boolean
  knockdown: boolean
  headshot: boolean
  finisher?: boolean
  crawler?: boolean
  limp?: boolean
  detachBone: DetachableBone | null
  seed: number
}

export type CombatMeleeEvent = {
  id: number
  time: number
  attackerId: string
  attackerIndex: number
  weapon: MeleeWeaponId
  x: number
  y: number
  aim: number
  arc: number
  reach: number
  combo: 1 | 2 | 3
  heavy: boolean
  finisher?: boolean
  charge: number
  hits: CombatMeleeHit[]
  hitDoorId: string | null
  doorBroke: boolean
  weaponBroke: boolean
  durabilityLow: boolean
  seed: number
}

/** Handle to spend durability on the held melee weapon in the progression ledger. */
export type MeleeDurabilityHandle = {
  readonly weapon: MeleeWeaponId
  readonly durability: number
  readonly maxDurability: number
  /** Spends `amount` durability; returns remaining durability and whether the weapon broke or crossed low threshold. */
  spend(amount: number): { remaining: number; broke: boolean; low: boolean }
}

/** The survivor's current timed action, projected from the progression ledger for the HUD and the wire. */
export type CombatChannel = ChannelView

export type SurvivorCombatState = {
  equippedItem: "pistol" | "hands" | MeleeWeaponId
  meleeWeapon: MeleeWeaponId | null
  meleeDurability: number
  meleeMaxDurability: number
  meleePhase: MeleeSwingPhase
  meleePhaseTime: number
  meleePhaseDuration: number
  meleeCombo: 1 | 2 | 3
  meleeCharge: number
  meleeHeavy: boolean
  meleeFinisher?: boolean
  meleeComboQueued: boolean
  meleeComboUntil: number
  meleeSwingId: number
  magAmmo: number
  magCapacity: number
  reserveAmmo: number
  planks: number
  fireCooldown: number
  reloadRemaining: number
  recoil: number
  shoveCooldown: number
  shoveAnim: number
  stompAnim?: number
  channel: CombatChannel | null
  lootMessage: string | null
  lootMessageUntil: number
}

export function createSurvivorCombatState(): SurvivorCombatState {
  return {
    equippedItem: "pistol",
    meleeWeapon: null,
    meleeDurability: 0,
    meleeMaxDurability: 0,
    meleePhase: "idle",
    meleePhaseTime: 0,
    meleePhaseDuration: 0,
    meleeCombo: 1,
    meleeCharge: 0,
    meleeHeavy: false,
    meleeFinisher: false,
    meleeComboQueued: false,
    meleeComboUntil: -Infinity,
    meleeSwingId: 0,
    magAmmo: 6,
    magCapacity: PISTOL_MAG_SIZE,
    reserveAmmo: 6,
    planks: 2,
    fireCooldown: 0,
    reloadRemaining: 0,
    recoil: 0,
    shoveCooldown: 0,
    shoveAnim: 0,
    stompAnim: 0,
    channel: null,
    lootMessage: null,
    lootMessageUntil: -Infinity,
  }
}

/** Ray-circle intersection distance along unit ray (dx, dy) from (ox, oy) to circle (cx, cy, r). */
function rayCircle(ox: number, oy: number, dx: number, dy: number, cx: number, cy: number, r: number): number {
  const fx = cx - ox
  const fy = cy - oy
  const proj = fx * dx + fy * dy
  if (proj < 0) return Infinity
  const perp2 = fx * fx + fy * fy - proj * proj
  const r2 = r * r
  if (perp2 > r2) return Infinity
  const thc = Math.sqrt(r2 - perp2)
  return Math.max(0, proj - thc)
}

type ActiveSwingRuntime = {
  event: CombatMeleeEvent
  hitZombieIds: Set<number>
  durabilitySpent: boolean
  attackerId: string
  attackerIndex: number
  wearAccum?: number
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export class OutbreakCombatSubsystem {
  readonly shots: CombatShotEvent[] = []
  readonly meleeSwings: CombatMeleeEvent[] = []
  private nextShotId = 1
  private nextMeleeId = 1
  private readonly activeSwings = new WeakMap<object, ActiveSwingRuntime>()
  private readonly wearRemainder = new WeakMap<object, number>()

  firePistol(
    player: { x: number; y: number; aim: number; noise: number; vault: unknown } & SurvivorCombatState,
    ai: OutbreakAISubsystem,
    sightBlockers: readonly Rect[],
    time: number,
    ammo: PistolAmmo,
    attackerId = "player",
  ): CombatShotEvent | null {
    if (player.vault || player.equippedItem !== "pistol") return null
    if (player.fireCooldown > 0 || player.reloadRemaining > 0) return null
    if (ammo.loaded <= 0) {
      if (ammo.reserve > 0) {
        this.startReload(player, ai, time, ammo)
      } else {
        player.lootMessage = "Out of 9mm ammo! Search houses (E) or shove (V)"
        player.lootMessageUntil = time + 2.2
      }
      return null
    }

    if (!ammo.spend()) return null
    player.magAmmo = ammo.loaded
    player.fireCooldown = PISTOL_FIRE_COOLDOWN
    player.recoil = 1.0
    player.channel = null
    player.noise = Math.max(player.noise, PISTOL_NOISE)
    ai.emitNoise(player.x, player.y, PISTOL_NOISE, "gunshot", time, attackerId, 2.2)

    const dx = Math.cos(player.aim)
    const dy = Math.sin(player.aim)
    const ox = player.x + dx * 0.32
    const oy = player.y + dy * 0.32
    const wallHit = Math.min(PISTOL_RANGE, raycast(ox, oy, dx, dy, sightBlockers, PISTOL_RANGE))

    let bestZombie: AIAgent | null = null
    let bestT = wallHit
    for (let i = 0; i < ai.agents.length; i++) {
      const z = ai.agents[i]!
      if (z.state === "dead") continue
      const t = rayCircle(ox, oy, dx, dy, z.x, z.y, ZOMBIE_CAPSULE_RADIUS)
      if (t < bestT) {
        bestT = t
        bestZombie = z
      }
    }

    const hitX = ox + dx * bestT
    const hitY = oy + dy * bestT
    let killed = false
    let knockdown = false
    let crawler = false
    let limp = false
    let detachBone: CombatShotEvent["detachBone"] = null
    const shotSeed = ((this.nextShotId * 0x9e3779b9) ^ Math.floor(time * 1000)) >>> 0

    if (bestZombie) {
      const rng = new Rng((shotSeed ^ bestZombie.seed) >>> 0)
      const fx = bestZombie.x - ox
      const fy = bestZombie.y - oy
      const proj = fx * dx + fy * dy
      const perpDist = Math.sqrt(Math.max(0, fx * fx + fy * fy - proj * proj))
      const perpSide = fx * -dy + fy * dx

      const damage = bestT < 6.5 ? 55 : 42
      bestZombie.hp = Math.max(0, bestZombie.hp - damage)
      bestZombie.hitFlash = 1.0
      bestZombie.awareness = 1.0
      bestZombie.targetX = player.x
      bestZombie.targetY = player.y
      bestZombie.targetKind = "sight"
      bestZombie.lastHitBy = attackerId

      const detachable: NonNullable<CombatShotEvent["detachBone"]>[] = [
        "head",
        "left.upperArm",
        "right.upperArm",
        "right.foreArm",
      ]
      if (bestZombie.hp <= 0) {
        killed = true
        bestZombie.state = "dead"
        bestZombie.stateTime = 0
        bestZombie.staggerVx = dx * 4.5
        bestZombie.staggerVy = dy * 4.5
        detachBone = rng.pick(detachable)
        if (detachBone && !bestZombie.detachedLimbs.includes(detachBone)) {
          bestZombie.detachedLimbs.push(detachBone)
        }
      } else if (perpDist >= 0.14 || (bestT >= 6.5 && rng.next() < 0.42)) {
        // Off-center hip/leg shot or medium-range impact: can blow a leg off (crawler), knock down, or cripple into a limp
        const legRoll = rng.next()
        const legChoice: DetachableBone = perpSide >= 0 ? "right.thigh" : "left.thigh"
        if (legRoll < 0.36 && !hasSeveredLeg(bestZombie)) {
          detachBone = legChoice
          bestZombie.detachedLimbs.push(detachBone)
          bestZombie.state = "crawler"
          bestZombie.stateTime = 0
          bestZombie.staggerVx = dx * 4.2
          bestZombie.staggerVy = dy * 4.2
          crawler = true
        } else if (legRoll < 0.72) {
          knockdown = true
          bestZombie.state = "knockdown"
          bestZombie.stateTime = 0
          bestZombie.timer = 2.0 + rng.next() * 0.65
          bestZombie.staggerVx = dx * 4.8
          bestZombie.staggerVy = dy * 4.8
          if (rng.next() < 0.55) {
            bestZombie.limping = true
            limp = true
          }
        } else {
          bestZombie.limping = true
          limp = true
          bestZombie.state = "stagger"
          bestZombie.stateTime = 0
          bestZombie.timer = 0.34
          bestZombie.staggerVx = dx * 3.6
          bestZombie.staggerVy = dy * 3.6
        }
      } else {
        bestZombie.state = "stagger"
        bestZombie.timer = 0.26
        bestZombie.staggerVx = dx * 3.4
        bestZombie.staggerVy = dy * 3.4
        if (bestZombie.hp <= 45 && bestZombie.detachedLimbs.length === 0 && rng.next() < 0.65) {
          detachBone = rng.pick(["left.upperArm", "right.upperArm", "right.foreArm"])
          if (detachBone && !bestZombie.detachedLimbs.includes(detachBone)) {
            bestZombie.detachedLimbs.push(detachBone)
          }
        }
      }
    }

    const ev: CombatShotEvent = {
      id: this.nextShotId++,
      time,
      fromX: ox,
      fromY: oy,
      toX: hitX,
      toY: hitY,
      aim: player.aim,
      hitZombieId: bestZombie?.id ?? null,
      killed,
      ...(knockdown ? { knockdown: true } : {}),
      ...(crawler ? { crawler: true } : {}),
      ...(limp ? { limp: true } : {}),
      detachBone,
      seed: shotSeed,
    }
    if (this.shots.length >= 24) this.shots.shift()
    this.shots.push(ev)
    return ev
  }

  startReload(
    player: { x: number; y: number; noise: number } & SurvivorCombatState,
    ai: OutbreakAISubsystem,
    time: number,
    ammo: PistolAmmo,
    attackerId = "player",
  ): boolean {
    if (player.reloadRemaining > 0) return false
    if (ammo.loaded >= ammo.capacity || ammo.reserve <= 0) return false
    player.reloadRemaining = PISTOL_RELOAD_TIME
    player.channel = null
    player.noise = Math.max(player.noise, RELOAD_NOISE)
    ai.emitNoise(player.x, player.y, RELOAD_NOISE, "door", time, attackerId, 0.35)
    return true
  }

  /**
   * Starts or queues a melee weapon swing on the fire input (`Mouse0`).
   * Tapping performs a quick windup -> active -> recovery swing (chaining up to 2–3 combo swings).
   * Holding `fireHeld` charges the windup into a heavy blow with bonus damage, knockback, and cleave.
   */
  startMeleeSwing(
    player: {
      x: number
      y: number
      aim: number
      stamina: number
      exhausted?: boolean
      regenCooldown?: number
      noise: number
      vault: unknown
    } & SurvivorCombatState,
    weaponId: MeleeWeaponId,
    time: number,
    tuning: MeleeTuning = DEFAULT_MELEE_TUNING,
  ): boolean {
    if (player.vault) return false
    const weapon = MELEE_WEAPONS[weaponId]
    if (!weapon) return false

    if (player.meleePhase === "idle") {
      const canChain =
        player.meleeWeapon === weaponId &&
        time <= player.meleeComboUntil &&
        player.meleeCombo < weapon.comboLength
      const nextCombo = canChain ? ((player.meleeCombo + 1) as 1 | 2 | 3) : 1
      this.beginWindup(player, weapon, nextCombo, tuning)
      return true
    }

    if (
      (player.meleePhase === "windup" && player.meleePhaseTime >= player.meleePhaseDuration * 0.5) ||
      player.meleePhase === "active" ||
      player.meleePhase === "recovery"
    ) {
      if (player.meleeCombo < weapon.comboLength) {
        player.meleeComboQueued = true
        return true
      }
    }

    return false
  }

  private beginWindup(
    player: { exhausted?: boolean } & SurvivorCombatState,
    weapon: MeleeWeaponDef,
    combo: 1 | 2 | 3,
    tuning: MeleeTuning,
  ): void {
    const exhScale = player.exhausted ? 0.68 : 1.0
    const comboSpeed = combo === 2 ? 1.14 : combo === 3 ? 0.88 : 1.0
    const effSpeed = Math.max(0.4, weapon.speed * tuning.meleeSpeedScale * exhScale * comboSpeed)
    const windupDuration = clamp(0.11 / effSpeed, 0.04, 0.14)
    player.meleeWeapon = weapon.id
    player.equippedItem = weapon.id
    player.meleeCombo = combo
    player.meleePhase = "windup"
    player.meleePhaseTime = 0
    player.meleePhaseDuration = windupDuration
    player.meleeCharge = 0
    player.meleeHeavy = false
    player.meleeFinisher = false
    player.meleeComboQueued = false
    player.channel = null
  }

  /**
   * Executes a contextual downward melee strike or heavy boot stomp on a downed or crawling zombie
   * at the survivor's feet without spending pistol ammo.
   */
  executeFinisher(
    player: {
      x: number
      y: number
      aim: number
      stamina: number
      exhausted?: boolean
      regenCooldown?: number
      noise: number
      vault: unknown
    } & SurvivorCombatState,
    target: AIAgent,
    ai: OutbreakAISubsystem,
    durability: MeleeDurabilityHandle | null,
    time: number,
    tuning: MeleeTuning = DEFAULT_MELEE_TUNING,
    attackerId = "player",
    attackerIndex = 0,
    onNotice?: (text: string, kind: "result" | "info" | "warning", key?: string) => void,
  ): CombatMeleeEvent | null {
    if (player.vault || player.meleePhase !== "idle" || (player.stompAnim ?? 0) > 0.05) return null
    const weaponId = player.meleeWeapon ?? (isMeleeWeapon(player.equippedItem) ? player.equippedItem : null)
    const weapon = weaponId ? MELEE_WEAPONS[weaponId] : MELEE_WEAPONS.crowbar
    const toTargetAngle = Math.atan2(target.y - player.y, target.x - player.x)
    player.aim = toTargetAngle
    player.channel = null
    player.stamina = Math.max(0, player.stamina - 0.12 * Math.max(0, tuning.meleeStaminaScale))
    if (player.stamina <= 1e-4) player.exhausted = true
    if (player.regenCooldown !== undefined) {
      player.regenCooldown = Math.max(player.regenCooldown, 0.85)
    }

    const swingId = this.nextMeleeId++
    const swingSeed = ((swingId * 0x9e3779b9) ^ Math.floor(time * 1000)) >>> 0
    const hitSeed = ((swingSeed ^ target.seed ^ Math.imul(target.id + 1, 0x9e3779b9)) >>> 0)
    const detachBone: DetachableBone = !target.detachedLimbs.includes("head") ? "head" : "right.foreArm"
    if (!target.detachedLimbs.includes(detachBone)) {
      target.detachedLimbs.push(detachBone)
    }

    const dx = target.x - player.x
    const dy = target.y - player.y
    const d = Math.hypot(dx, dy) || 1
    const ux = dx / d
    const uy = dy / d

    target.hp = 0
    target.state = "dead"
    target.stateTime = 0
    target.hitFlash = 1.0
    target.lastHitBy = attackerId
    target.staggerVx = ux * 2.4
    target.staggerVy = uy * 2.4

    const ev: CombatMeleeEvent = {
      id: swingId,
      time,
      attackerId,
      attackerIndex,
      weapon: weaponId ?? "crowbar",
      x: player.x,
      y: player.y,
      aim: player.aim,
      arc: 0.95,
      reach: 1.45,
      combo: 3,
      heavy: true,
      finisher: true,
      charge: 1.0,
      hits: [
        {
          zombieId: target.id,
          x: target.x,
          y: target.y,
          damage: 150,
          killed: true,
          knockdown: false,
          headshot: true,
          finisher: true,
          detachBone,
          seed: hitSeed,
        },
      ],
      hitDoorId: null,
      doorBroke: false,
      weaponBroke: false,
      durabilityLow: false,
      seed: swingSeed,
    }

    if (weaponId) {
      player.meleeWeapon = weaponId
      player.equippedItem = weaponId
      player.meleeCombo = 3
      player.meleePhase = "active"
      player.meleePhaseTime = 0
      player.meleePhaseDuration = 0.22
      player.meleeCharge = 1.0
      player.meleeHeavy = true
      player.meleeFinisher = true
      player.meleeSwingId = swingId
      const runtime: ActiveSwingRuntime = {
        event: ev,
        hitZombieIds: new Set([target.id]),
        durabilitySpent: false,
        attackerId,
        attackerIndex,
      }
      this.spendSwingDurability(player, weapon, runtime, durability, tuning, time, onNotice)
    } else {
      player.stompAnim = 0.38
      player.shoveCooldown = 0.48
      player.meleeFinisher = true
      player.meleeSwingId = swingId
    }

    const finNoise = 6.0 * Math.max(0, tuning.meleeNoiseScale)
    player.noise = Math.max(player.noise, finNoise)
    ai.emitNoise(player.x, player.y, finNoise, "shove", time, attackerId, 0.75)

    if (this.meleeSwings.length >= 24) this.meleeSwings.shift()
    this.meleeSwings.push(ev)
    return ev
  }

  /**
   * Advances an in-progress melee swing (windup/charge -> active arc sweep -> recovery/combo branch).
   * Called authoritatively on each survivor tick.
   */
  stepMelee(
    player: {
      x: number
      y: number
      aim: number
      stamina: number
      exhausted?: boolean
      regenCooldown?: number
      noise: number
      vault: unknown
    } & SurvivorCombatState,
    dt: number,
    time: number,
    fireHeld: boolean,
    ai: OutbreakAISubsystem,
    sightBlockers: readonly Rect[],
    durability: MeleeDurabilityHandle | null,
    tuning: MeleeTuning = DEFAULT_MELEE_TUNING,
    attackerId = "player",
    attackerIndex = 0,
    town?: Town,
    onNotice?: (text: string, kind: "result" | "info" | "warning", key?: string) => void,
  ): { topologyChanged: boolean; event: CombatMeleeEvent | null } {
    let topologyChanged = false
    const weaponId = player.meleeWeapon ?? (isMeleeWeapon(player.equippedItem) ? player.equippedItem : null)
    if (!weaponId || player.vault) {
      if (player.meleePhase !== "idle") {
        player.meleePhase = "idle"
        player.meleePhaseTime = 0
        player.meleeCharge = 0
        player.meleeHeavy = false
        player.meleeComboQueued = false
        this.activeSwings.delete(player)
      }
      return { topologyChanged: false, event: null }
    }

    const weapon = MELEE_WEAPONS[weaponId]
    const exhScale = player.exhausted ? 0.68 : 1.0
    const comboSpeed = player.meleeCombo === 2 ? 1.14 : player.meleeCombo === 3 ? 0.88 : 1.0
    const effSpeed = Math.max(0.4, weapon.speed * tuning.meleeSpeedScale * exhScale * comboSpeed)

    if (player.meleePhase === "windup") {
      player.meleePhaseTime += dt
      const baseWindup = player.meleePhaseDuration
      const chargeWindow = Math.max(0.12, tuning.meleeChargeTime)
      if (fireHeld && player.meleePhaseTime >= baseWindup * 0.85) {
        const extra = player.meleePhaseTime - baseWindup * 0.85
        player.meleeCharge = clamp(extra / chargeWindow, 0, 1)
        if (player.meleeCharge >= 0.25) {
          player.meleeHeavy = true
        }
      }
      const maxHoldTime = baseWindup + chargeWindow * 1.35
      if (player.meleePhaseTime >= baseWindup && (!fireHeld || player.meleePhaseTime >= maxHoldTime)) {
        // Transition from windup -> active
        const stamCost =
          weapon.stamina *
          Math.max(0, tuning.meleeStaminaScale) *
          (player.meleeHeavy ? 1.45 + 0.25 * player.meleeCharge : 1.0)
        player.stamina = Math.max(0, player.stamina - stamCost)
        if (player.regenCooldown !== undefined) {
          player.regenCooldown = Math.max(player.regenCooldown, 0.65)
        }
        if (player.stamina <= 0.001 && player.exhausted !== undefined) {
          player.exhausted = true
        }

        const activeDuration = clamp(0.16 / effSpeed, 0.07, 0.16) * (player.meleeHeavy ? 1.12 : 1.0)
        player.meleePhase = "active"
        player.meleePhaseTime = 0
        player.meleePhaseDuration = activeDuration
        player.meleeSwingId = (player.meleeSwingId + 1) | 0

        const whiffNoise = Math.max(2.0, weapon.noise * 0.38 * Math.max(0, tuning.meleeNoiseScale))
        player.noise = Math.max(player.noise, whiffNoise)
        ai.emitNoise(player.x, player.y, whiffNoise, "shove", time, attackerId, 0.45)

        const swingSeed = ((this.nextMeleeId * 0x85ebca6b) ^ Math.floor(time * 1000) ^ (attackerIndex << 8)) >>> 0
        const ev: CombatMeleeEvent = {
          id: this.nextMeleeId++,
          time,
          attackerId,
          attackerIndex,
          weapon: weapon.id,
          x: player.x,
          y: player.y,
          aim: player.aim,
          arc: weapon.arc * tuning.meleeArcScale * (player.meleeHeavy ? 1.15 : 1.0),
          reach: weapon.reach * tuning.meleeReachScale,
          combo: player.meleeCombo,
          heavy: player.meleeHeavy,
          charge: Number(player.meleeCharge.toFixed(3)),
          hits: [],
          hitDoorId: null,
          doorBroke: false,
          weaponBroke: false,
          durabilityLow: false,
          seed: swingSeed,
        }
        if (this.meleeSwings.length >= 24) this.meleeSwings.shift()
        this.meleeSwings.push(ev)
        const runtime: ActiveSwingRuntime = {
          event: ev,
          hitZombieIds: new Set(),
          durabilitySpent: false,
          attackerId,
          attackerIndex,
        }
        this.activeSwings.set(player, runtime)

        // Immediate initial sweep at entry of active frames
        const sweepRes = this.sweepActiveMelee(
          player,
          weapon,
          runtime,
          0.45,
          time,
          ai,
          sightBlockers,
          durability,
          tuning,
          town,
          onNotice,
        )
        if (sweepRes.topologyChanged) topologyChanged = true
        return { topologyChanged, event: ev }
      }
      return { topologyChanged: false, event: null }
    }

    if (player.meleePhase === "active") {
      player.meleePhaseTime += dt
      const runtime = this.activeSwings.get(player)
      const u = clamp(player.meleePhaseTime / Math.max(0.01, player.meleePhaseDuration), 0, 1)
      if (runtime) {
        const sweepRes = this.sweepActiveMelee(
          player,
          weapon,
          runtime,
          Math.max(0.45, u),
          time,
          ai,
          sightBlockers,
          durability,
          tuning,
          town,
          onNotice,
        )
        if (sweepRes.topologyChanged) topologyChanged = true
      }
      if (player.meleePhaseTime >= player.meleePhaseDuration) {
        if (runtime) {
          const sweepRes = this.sweepActiveMelee(
            player,
            weapon,
            runtime,
            1.0,
            time,
            ai,
            sightBlockers,
            durability,
            tuning,
            town,
            onNotice,
          )
          if (sweepRes.topologyChanged) topologyChanged = true
        }
        this.activeSwings.delete(player)
        const isFinalCombo = player.meleeCombo >= weapon.comboLength || player.meleeHeavy
        const recoveryDuration = clamp(0.22 / effSpeed, 0.1, 0.28) * (isFinalCombo ? 1.25 : 1.0)
        player.meleePhase = "recovery"
        player.meleePhaseTime = 0
        player.meleePhaseDuration = recoveryDuration
        return { topologyChanged, event: runtime?.event ?? null }
      }
      return { topologyChanged, event: runtime?.event ?? null }
    }

    if (player.meleePhase === "recovery") {
      player.meleePhaseTime += dt
      if (
        player.meleeComboQueued &&
        player.meleePhaseTime >= player.meleePhaseDuration * 0.55 &&
        player.meleeCombo < weapon.comboLength &&
        !player.meleeHeavy &&
        (!durability || durability.durability > 0)
      ) {
        const nextCombo = (player.meleeCombo + 1) as 1 | 2 | 3
        this.beginWindup(player, weapon, nextCombo, tuning)
        return { topologyChanged, event: null }
      }
        if (player.meleePhaseTime >= player.meleePhaseDuration) {
          const wasFinisher = player.meleeCombo >= weapon.comboLength || player.meleeHeavy || Boolean(player.meleeFinisher)
          player.meleePhase = "idle"
          player.meleePhaseTime = 0
          player.meleePhaseDuration = 0
          player.meleeCharge = 0
          player.meleeHeavy = false
          player.meleeFinisher = false
          player.meleeComboQueued = false
          player.meleeComboUntil = wasFinisher ? -Infinity : time + tuning.meleeComboWindow
        }
    }

    return { topologyChanged, event: null }
  }

  private spendSwingDurability(
    player: SurvivorCombatState,
    weapon: MeleeWeaponDef,
    runtime: ActiveSwingRuntime,
    durability: MeleeDurabilityHandle | null,
    tuning: MeleeTuning,
    time: number,
    onNotice?: (text: string, kind: "result" | "info" | "warning", key?: string) => void,
  ): void {
    if (runtime.durabilitySpent || !durability) return
    runtime.durabilitySpent = true
    const wearRate = Math.max(0, tuning.meleeDurabilityWear)
    if (wearRate <= 0) return
    const rawWear = (runtime.event.heavy ? 2 : 1) * wearRate + (this.wearRemainder.get(player) ?? 0)
    const wholeWear = Math.floor(rawWear + 1e-6)
    this.wearRemainder.set(player, Math.max(0, rawWear - wholeWear))
    if (wholeWear <= 0) return

    const res = durability.spend(wholeWear)
    player.meleeDurability = res.remaining
    if (res.broke) {
      runtime.event.weaponBroke = true
      player.meleeWeapon = null
      player.meleeComboQueued = false
      void time
      void onNotice
      void weapon
    } else if (res.low) {
      runtime.event.durabilityLow = true
    }
  }

  private sweepActiveMelee(
    player: {
      x: number
      y: number
      aim: number
      exhausted?: boolean
      noise: number
    } & SurvivorCombatState,
    weapon: MeleeWeaponDef,
    runtime: ActiveSwingRuntime,
    u: number,
    time: number,
    ai: OutbreakAISubsystem,
    sightBlockers: readonly Rect[],
    durability: MeleeDurabilityHandle | null,
    tuning: MeleeTuning,
    town?: Town,
    onNotice?: (text: string, kind: "result" | "info" | "warning", key?: string) => void,
  ): { topologyChanged: boolean } {
    let topologyChanged = false
    const ev = runtime.event
    ev.x = player.x
    ev.y = player.y
    ev.aim = player.aim

    const maxTargets = weapon.maxTargets + (ev.heavy ? 1 : 0)
    const effReach = weapon.reach * tuning.meleeReachScale + ZOMBIE_CAPSULE_RADIUS
    const fullArc = Math.min(Math.PI * 1.65, weapon.arc * tuning.meleeArcScale * (ev.heavy ? 1.15 : 1.0))
    const halfArc = fullArc * 0.5
    // Progressive sweep window: combo 2 sweeps from left (-halfArc) to right (+halfArc);
    // combo 1 & 3 sweep from right (+halfArc) to left (-halfArc).
    const sweepEnd = -halfArc + fullArc * clamp(u, 0, 1)

    if (ev.hits.length < maxTargets) {
      // Collect candidate zombies in the swept arc, sorted by distance so closest targets are struck first
      const candidates: { z: AIAgent; d: number; relAngle: number }[] = []
      for (let i = 0; i < ai.agents.length; i++) {
        const z = ai.agents[i]!
        if (z.state === "dead" || runtime.hitZombieIds.has(z.id)) continue
        const dx = z.x - player.x
        const dy = z.y - player.y
        const d = Math.hypot(dx, dy)
        if (d > effReach) continue
        const ang = Math.atan2(dy, dx)
        const rel = angleDiff(ang, player.aim)
        const capsuleAngularPad = d > 0.38 ? Math.asin(Math.min(0.92, ZOMBIE_CAPSULE_RADIUS / d)) : 0.75
        const inSweptCone =
          d <= 0.42 ||
          (ev.combo === 2
            ? rel >= -halfArc - capsuleAngularPad && rel <= sweepEnd + capsuleAngularPad
            : rel <= halfArc + capsuleAngularPad && rel >= -sweepEnd - capsuleAngularPad)
        if (!inSweptCone) continue
        if (!clearLine(player.x, player.y, z.x, z.y, sightBlockers)) continue
        if (town) {
          const closedWinRects = town.windows
            .filter((w) => !w.open || ai.getBarricadePlanks(w.id) > 0)
            .map((w) => w.rect)
          if (closedWinRects.length > 0 && !clearLine(player.x, player.y, z.x, z.y, closedWinRects)) continue
        }
        candidates.push({ z, d, relAngle: rel })
      }

      candidates.sort((a, b) => a.d - b.d)

      for (const { z, d, relAngle } of candidates) {
        if (ev.hits.length >= maxTargets) break
        runtime.hitZombieIds.add(z.id)

        const hitSeed = ((ev.seed ^ z.seed ^ Math.imul(z.id + 1, 0x9e3779b9)) >>> 0)
        const rng = new Rng(hitSeed)
        const exhScale = player.exhausted ? 0.65 : 1.0
        const comboMult = ev.combo === 2 ? 1.08 : ev.combo === 3 ? 1.2 : 1.0
        const heavyMult = ev.heavy ? 1.4 + 0.45 * ev.charge : 1.0
        const downedMult = z.state === "knockdown" || z.state === "crawler" ? 1.4 : 1.0
        const toughScale = z.hp <= 100 ? 1 / clamp(z.toughness ?? 1, 0.82, 1.24) : 1.0

        const sweetSpotArc = ev.heavy || ev.combo === 3 ? 0.32 : 0.24
        const headshot =
          (Math.abs(relAngle) <= sweetSpotArc && d >= weapon.reach * 0.35) ||
          ((z.state === "knockdown" || z.state === "crawler") && Math.abs(relAngle) <= 0.36)
        const headMult = headshot ? weapon.headMultiplier : 1.0

        const rawDamage =
          weapon.damage *
          tuning.meleeDamageScale *
          comboMult *
          heavyMult *
          exhScale *
          downedMult *
          headMult *
          toughScale
        const damage = Math.max(1, Math.round(rawDamage))
        const wasDowned = z.state === "knockdown"
        const wasCrawler = z.state === "crawler" || hasSeveredLeg(z)
        z.hp = Math.max(0, z.hp - damage)
        z.hitFlash = 1.0
        z.awareness = 1.0
        z.targetX = player.x
        z.targetY = player.y
        z.targetKind = "sight"
        z.lastHitBy = runtime.attackerId
        z.focusId = runtime.attackerId

        const ux = d > 1e-4 ? (z.x - player.x) / d : Math.cos(player.aim)
        const uy = d > 1e-4 ? (z.y - player.y) / d : Math.sin(player.aim)
        const kb =
          weapon.knockback *
          tuning.meleeKnockbackScale *
          (ev.heavy ? 1.65 + 0.25 * ev.charge : ev.combo === 3 ? 1.4 : 1.0) *
          exhScale

        let killed = false
        let knockdown = false
        let crawler = false
        let limp = false
        let detachBone: CombatMeleeHit["detachBone"] = null

        const sharp = weapon.material === "blade" || weapon.id === "spiked-board"
        const armChoices: NonNullable<CombatMeleeHit["detachBone"]>[] =
          ev.combo === 2
            ? ["left.foreArm", "left.upperArm", "right.foreArm"]
            : ["right.foreArm", "right.upperArm", "left.upperArm"]
        const legChoices: NonNullable<CombatMeleeHit["detachBone"]>[] =
          ev.combo === 2 ? ["left.thigh", "right.thigh"] : ["right.thigh", "left.thigh"]

        if (z.hp <= 0) {
          killed = true
          z.state = "dead"
          z.stateTime = 0
          z.staggerVx = ux * (4.2 + 2.0 * kb)
          z.staggerVy = uy * (4.2 + 2.0 * kb)
          if (sharp) {
            if (headshot || ev.heavy || ev.combo === 3) {
              detachBone = !z.detachedLimbs.includes("head") ? "head" : rng.pick(armChoices)
            } else {
              detachBone = rng.pick(["head", ...armChoices])
            }
          } else if (ev.heavy || ev.combo === 3 || headshot) {
            detachBone = headshot && !z.detachedLimbs.includes("head") ? "head" : rng.pick(armChoices)
          }
        } else {
          // Non-lethal leg severing -> Crawler (including second-leg severing -> torso-only crawler)
          const canSeverLeg =
            !headshot &&
            ((sharp && (ev.heavy || ev.combo === 3 || z.hp <= 55) && rng.next() < (ev.heavy ? 0.52 : 0.34)) ||
              (!sharp && ev.heavy && z.hp <= 50 && !wasCrawler && rng.next() < 0.3))
          if (canSeverLeg) {
            const availLeg = legChoices.find((b) => !z.detachedLimbs.includes(b))
            if (availLeg) {
              detachBone = availLeg
              z.detachedLimbs.push(availLeg)
              z.state = "crawler"
              z.stateTime = 0
              z.staggerVx = ux * (4.2 + 1.8 * kb)
              z.staggerVy = uy * (4.2 + 1.8 * kb)
              crawler = true
            }
          }

          if (!crawler) {
            if (wasCrawler) {
              z.state = "crawler"
              z.staggerVx = ux * (3.2 + 1.5 * kb)
              z.staggerVy = uy * (3.2 + 1.5 * kb)
            } else {
              const shouldKnockdown =
                wasDowned ||
                (ev.heavy && kb >= 1.2) ||
                (ev.combo === 3 && kb >= 1.55) ||
                (weapon.weaponClass === "two-heavy" && (ev.heavy || ev.combo === 3 || headshot))
              if (shouldKnockdown) {
                knockdown = true
                z.state = "knockdown"
                z.stateTime = 0
                z.timer = clamp(1.85 + 0.3 * kb, 1.8, 2.75)
                z.staggerVx = ux * (5.6 + 2.4 * kb)
                z.staggerVy = uy * (5.6 + 2.4 * kb)
              } else {
                z.state = "stagger"
                z.stateTime = 0
                z.timer = clamp(0.36 + 0.22 * kb, 0.28, 0.85)
                z.staggerVx = ux * (4.4 + 2.4 * kb)
                z.staggerVy = uy * (4.4 + 2.4 * kb)
              }
              if (!headshot && !z.limping && (ev.heavy || ev.combo >= 2 || rng.next() < 0.35)) {
                z.limping = true
                limp = true
              }
            }

            // Non-lethal arm detachment on heavy/sharp blows
            if (sharp && (ev.heavy || ev.combo === 3 || headshot || z.hp <= 60) && z.detachedLimbs.length < 2) {
              const avail = armChoices.find((b) => !z.detachedLimbs.includes(b))
              if (avail && (ev.heavy || ev.combo === 3 || rng.next() < 0.75)) {
                detachBone = avail
              }
            } else if (!sharp && ev.heavy && z.hp <= 45 && z.detachedLimbs.length === 0) {
              detachBone = "right.foreArm"
            }
          }
        }

        if (detachBone && !z.detachedLimbs.includes(detachBone)) {
          z.detachedLimbs.push(detachBone)
        }

        ev.hits.push({
          zombieId: z.id,
          x: z.x,
          y: z.y,
          damage,
          killed,
          knockdown,
          headshot,
          ...(crawler ? { crawler: true } : {}),
          ...(limp ? { limp: true } : {}),
          detachBone,
          seed: hitSeed,
        })

        // Emit impact noise & spend durability on first hit of the swing
        if (ev.hits.length === 1) {
          const hitNoise = weapon.noise * Math.max(0, tuning.meleeNoiseScale) * (ev.heavy ? 1.2 : 1.0)
          player.noise = Math.max(player.noise, hitNoise)
          ai.emitNoise(player.x, player.y, hitNoise, "shove", time, runtime.attackerId, 0.85)
          this.spendSwingDurability(player, weapon, runtime, durability, tuning, time, onNotice)
        }
      }
    }

    // Door & barricade breaching with axes and pry/hammer tools when no zombie absorbed the blow
    if (town && weapon.doorDamage > 0 && ev.hitDoorId === null && ev.hits.length === 0 && u >= 0.5) {
      let bestDoor: { id: string; rect: Rect; kind: "door" | "window"; d: number } | null = null
      let bestDist = weapon.reach * tuning.meleeReachScale + 0.25
      for (const d of town.doors) {
        const pst = ai.portalStates.get(d.id)
        if (d.open && (pst?.barricadePlanks ?? 0) <= 0) continue
        const dist = distToRect(player.x, player.y, d.rect)
        if (dist > bestDist) continue
        const cx = (d.rect[0] + d.rect[2]) * 0.5
        const cy = (d.rect[1] + d.rect[3]) * 0.5
        if (Math.abs(angleDiff(Math.atan2(cy - player.y, cx - player.x), player.aim)) > halfArc + 0.25) continue
        bestDist = dist
        bestDoor = { id: d.id, rect: d.rect, kind: "door", d: dist }
      }
      if (bestDoor) {
        ev.hitDoorId = bestDoor.id
        const pst = ai.portalStates.get(bestDoor.id)
        const door = town.doors.find((d) => d.id === bestDoor.id)
        const dmg = Math.round(weapon.doorDamage * (ev.heavy ? 1.5 : 1.0) * tuning.meleeDamageScale)
        if (pst) {
          pst.lastBashTime = time
          if (pst.barricadePlanks > 0) {
            const perPlank = pst.barricadeHp / pst.barricadePlanks
            pst.barricadeHp = Math.max(0, pst.barricadeHp - dmg)
            const nextPlanks = Math.max(0, Math.min(pst.barricadePlanks, Math.ceil(pst.barricadeHp / perPlank - 1e-9)))
            if (nextPlanks !== pst.barricadePlanks) {
              pst.barricadePlanks = nextPlanks
              ev.doorBroke = true
              topologyChanged = true
            }
          } else if (door && !door.open) {
            pst.integrity = Math.max(0, pst.integrity - dmg)
            if (pst.integrity <= 0) {
              door.open = true
              door.locked = false
              door.keyed = false
              pst.integrity = 100
              ev.doorBroke = true
              topologyChanged = true
              onNotice?.(`Breached door with ${weapon.label}`, "result", "portal")
            }
          }
        }
        const bashNoise = Math.max(12, weapon.noise * 1.4 * Math.max(0, tuning.meleeNoiseScale))
        player.noise = Math.max(player.noise, bashNoise)
        ai.emitNoise(player.x, player.y, bashNoise, "bash", time, runtime.attackerId, 1.1)
        this.spendSwingDurability(player, weapon, runtime, durability, tuning, time, onNotice)
      }
    }

    return { topologyChanged }
  }

  meleeShove(
    player: { x: number; y: number; aim: number; stamina: number; noise: number } & SurvivorCombatState,
    ai: OutbreakAISubsystem,
    sightBlockers: readonly Rect[],
    time: number,
    mods: { damage: number; stagger: number; range: number } = { damage: 15, stagger: 1, range: 0 },
    attackerId = "player",
  ): number {
    if (player.shoveCooldown > 0) return 0
    player.shoveCooldown = SHOVE_COOLDOWN
    player.shoveAnim = 0.28
    player.channel = null
    player.stamina = Math.max(0, player.stamina - 0.1)
    player.noise = Math.max(player.noise, SHOVE_NOISE)
    ai.emitNoise(player.x, player.y, SHOVE_NOISE, "shove", time, attackerId, 0.6)

    let shoved = 0
    for (let i = 0; i < ai.agents.length; i++) {
      const z = ai.agents[i]!
      if (z.state === "dead") continue
      const dx = z.x - player.x
      const dy = z.y - player.y
      const d = Math.hypot(dx, dy)
      if (d > SHOVE_RANGE + mods.range) continue
      const ang = Math.atan2(dy, dx)
      if (d > 0.35 && Math.abs(angleDiff(ang, player.aim)) > SHOVE_ARC) continue
      if (!clearLine(player.x, player.y, z.x, z.y, sightBlockers)) continue

      const ux = dx / (d || 1)
      const uy = dy / (d || 1)
      z.state = "stagger"
      z.stateTime = 0
      z.timer = 0.72 * mods.stagger
      z.staggerVx = ux * 6.2 * mods.stagger
      z.staggerVy = uy * 6.2 * mods.stagger
      z.hitFlash = 0.65
      z.lastHitBy = attackerId
      // Bare hands never kill; a crowbar or spiked board can finish a wounded zombie.
      z.hp = mods.damage > 15 ? z.hp - mods.damage : Math.max(1, z.hp - mods.damage)
      if (z.hp <= 0) {
        z.hp = 0
        z.state = "dead"
        z.stateTime = 0
        shoved++
        continue
      }
      z.awareness = 1
      z.targetX = player.x
      z.targetY = player.y
      shoved++
    }
    return shoved
  }

  step(
    player: SurvivorCombatState,
    dt: number,
    time: number,
    ammo: PistolAmmo,
  ): void {
    if (player.fireCooldown > 0) player.fireCooldown = Math.max(0, player.fireCooldown - dt)
    if (player.shoveCooldown > 0) player.shoveCooldown = Math.max(0, player.shoveCooldown - dt)
    if (player.shoveAnim > 0) player.shoveAnim = Math.max(0, player.shoveAnim - dt)
    if ((player.stompAnim ?? 0) > 0) {
      player.stompAnim = Math.max(0, (player.stompAnim ?? 0) - dt)
      if (player.stompAnim === 0 && player.meleePhase === "idle") {
        player.meleeFinisher = false
      }
    }
    if (player.recoil > 0) player.recoil = Math.max(0, player.recoil - dt * 5.5)

    if (player.reloadRemaining > 0) {
      player.reloadRemaining = Math.max(0, player.reloadRemaining - dt)
      if (player.reloadRemaining <= 0) {
        ammo.reload()
        player.magAmmo = ammo.loaded
        player.reserveAmmo = ammo.reserve
      }
    }

    // Prune old shot and melee events
    for (let i = this.shots.length - 1; i >= 0; i--) {
      if (time - this.shots[i]!.time > 0.35) {
        this.shots.splice(i, 1)
      }
    }
    for (let i = this.meleeSwings.length - 1; i >= 0; i--) {
      if (time - this.meleeSwings[i]!.time > 0.45) {
        this.meleeSwings.splice(i, 1)
      }
    }
  }
}
