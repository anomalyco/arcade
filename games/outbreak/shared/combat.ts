import { angleDiff, clearLine, raycast, type Rect } from "@arcade/kit/sim/geom"
import { Rng } from "@arcade/kit/sim/rng"
import type { AIAgent, OutbreakAISubsystem } from "./ai"
import type { ChannelView, PistolAmmo } from "./progression"

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
  detachBone: "head" | "left.upperArm" | "right.upperArm" | "right.foreArm" | null
  seed: number
}

/** The survivor's current timed action, projected from the progression ledger for the HUD and the wire. */
export type CombatChannel = ChannelView

export type SurvivorCombatState = {
  equippedItem: "pistol" | "hands"
  magAmmo: number
  magCapacity: number
  reserveAmmo: number
  planks: number
  fireCooldown: number
  reloadRemaining: number
  recoil: number
  shoveCooldown: number
  shoveAnim: number
  channel: CombatChannel | null
  lootMessage: string | null
  lootMessageUntil: number
}

export function createSurvivorCombatState(): SurvivorCombatState {
  return {
    equippedItem: "pistol",
    magAmmo: 6,
    magCapacity: PISTOL_MAG_SIZE,
    reserveAmmo: 6,
    planks: 2,
    fireCooldown: 0,
    reloadRemaining: 0,
    recoil: 0,
    shoveCooldown: 0,
    shoveAnim: 0,
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

export class OutbreakCombatSubsystem {
  readonly shots: CombatShotEvent[] = []
  private nextShotId = 1

  firePistol(
    player: { x: number; y: number; aim: number; noise: number; vault: unknown } & SurvivorCombatState,
    ai: OutbreakAISubsystem,
    sightBlockers: readonly Rect[],
    time: number,
    ammo: PistolAmmo,
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
    ai.emitNoise(player.x, player.y, PISTOL_NOISE, "gunshot", time, "player", 2.2)

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
      const t = rayCircle(ox, oy, dx, dy, z.x, z.y, 0.36)
      if (t < bestT) {
        bestT = t
        bestZombie = z
      }
    }

    const hitX = ox + dx * bestT
    const hitY = oy + dy * bestT
    let killed = false
    let detachBone: CombatShotEvent["detachBone"] = null
    const shotSeed = ((this.nextShotId * 0x9e3779b9) ^ Math.floor(time * 1000)) >>> 0

    if (bestZombie) {
      const rng = new Rng((shotSeed ^ bestZombie.seed) >>> 0)
      const damage = bestT < 6.5 ? 55 : 42
      bestZombie.hp = Math.max(0, bestZombie.hp - damage)
      bestZombie.hitFlash = 1.0
      bestZombie.awareness = 1.0
      bestZombie.targetX = player.x
      bestZombie.targetY = player.y
      bestZombie.targetKind = "sight"

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
        detachBone = rng.pick(detachable)
      } else {
        bestZombie.state = "stagger"
        bestZombie.timer = 0.26
        bestZombie.staggerVx = dx * 3.4
        bestZombie.staggerVy = dy * 3.4
        if (bestZombie.hp <= 45 && bestZombie.detachedLimbs.length === 0 && rng.next() < 0.65) {
          detachBone = rng.pick(["left.upperArm", "right.upperArm", "right.foreArm"])
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
  ): boolean {
    if (player.reloadRemaining > 0) return false
    if (ammo.loaded >= ammo.capacity || ammo.reserve <= 0) return false
    player.reloadRemaining = PISTOL_RELOAD_TIME
    player.channel = null
    player.noise = Math.max(player.noise, RELOAD_NOISE)
    ai.emitNoise(player.x, player.y, RELOAD_NOISE, "door", time, "player", 0.35)
    return true
  }

  meleeShove(
    player: { x: number; y: number; aim: number; stamina: number; noise: number } & SurvivorCombatState,
    ai: OutbreakAISubsystem,
    sightBlockers: readonly Rect[],
    time: number,
    mods: { damage: number; stagger: number; range: number } = { damage: 15, stagger: 1, range: 0 },
  ): number {
    if (player.shoveCooldown > 0) return 0
    player.shoveCooldown = SHOVE_COOLDOWN
    player.shoveAnim = 0.28
    player.channel = null
    player.stamina = Math.max(0, player.stamina - 0.1)
    player.noise = Math.max(player.noise, SHOVE_NOISE)
    ai.emitNoise(player.x, player.y, SHOVE_NOISE, "shove", time, "player", 0.6)

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
    if (player.recoil > 0) player.recoil = Math.max(0, player.recoil - dt * 5.5)

    if (player.reloadRemaining > 0) {
      player.reloadRemaining = Math.max(0, player.reloadRemaining - dt)
      if (player.reloadRemaining <= 0) {
        ammo.reload()
        player.magAmmo = ammo.loaded
        player.reserveAmmo = ammo.reserve
      }
    }

    // Prune old shot events
    for (let i = this.shots.length - 1; i >= 0; i--) {
      if (time - this.shots[i]!.time > 0.35) {
        this.shots.splice(i, 1)
      }
    }
  }
}
