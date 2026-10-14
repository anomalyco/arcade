import { angleDiff, clearLine, distToRect, raycast, type Rect } from "@arcade/kit/sim/geom"
import { Rng } from "@arcade/kit/sim/rng"
import type { AIAgent, OutbreakAISubsystem } from "./ai"
import {
  INTERACT_RANGE,
  type InteractAction,
  type InteractActorState,
  type InteractionHandler,
  type RawInteractCandidate,
} from "./interact"
import { propShape, type Prop, type Town } from "./map"

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
export const SEARCH_DURATION = 0.8
export const SEARCH_NOISE = 6.5
export const BARRICADE_DURATION = 0.7
export const BARRICADE_NOISE = 9.5

export type ItemId = "pistol" | "flashlight" | "plank" | "ammo"

export type HotbarSlot = {
  slot: 1 | 2 | 3
  itemId: ItemId
  label: string
  detail: string
  active: boolean
}

export type LootContainer = {
  id: string
  propIndex: number
  kind: Prop["kind"]
  label: string
  rect: Rect
  x: number
  y: number
  searched: boolean
  ammo: number
  planks: number
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
  detachBone: "head" | "left.upperArm" | "right.upperArm" | "right.foreArm" | null
  seed: number
}

export type CombatChannel = {
  kind: "search" | "barricade"
  targetId: string
  label: string
  x: number
  y: number
  elapsed: number
  duration: number
}

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

export function buildLootContainers(town: Town): LootContainer[] {
  const rng = new Rng((town.seed ^ 0x5c3e19a7) >>> 0)
  const containers: LootContainer[] = []
  const searchableKinds = new Set<Prop["kind"]>(["dresser", "shelf", "nightstand", "counter", "fridge"])
  const labelMap: Partial<Record<Prop["kind"], string>> = {
    dresser: "dresser drawers",
    shelf: "supply shelf",
    nightstand: "nightstand",
    counter: "kitchen cabinet",
    fridge: "refrigerator",
  }

  for (let i = 0; i < town.props.length; i++) {
    const p = town.props[i]!
    if (!searchableKinds.has(p.kind)) continue
    const shape = propShape(p)
    if (!shape) continue
    const building = town.buildings.find(
      (b) => p.x >= b.rect[0] && p.x <= b.rect[2] && p.y >= b.rect[1] && p.y <= b.rect[3],
    )
    const isHardware = building?.kind === "hardware"
    const isPharmacy = building?.kind === "pharmacy"

    let ammo = 0
    let planks = 0
    const roll = rng.next()
    if (isHardware) {
      planks = roll < 0.8 ? 1 + rng.int(3) : 0
      ammo = roll > 0.45 ? 3 + rng.int(5) : 0
    } else if (isPharmacy) {
      ammo = roll < 0.75 ? 4 + rng.int(6) : 0
      planks = roll > 0.65 ? 1 : 0
    } else {
      if (p.kind === "dresser" || p.kind === "nightstand") {
        ammo = roll < 0.78 ? 4 + rng.int(6) : 0
        planks = roll > 0.7 ? 1 : 0
      } else if (p.kind === "shelf" || p.kind === "counter") {
        ammo = roll < 0.55 ? 3 + rng.int(5) : 0
        planks = roll < 0.65 ? 1 + rng.int(2) : 0
      } else {
        ammo = roll < 0.35 ? 2 + rng.int(4) : 0
      }
    }

    containers.push({
      id: `loot-${i}`,
      propIndex: i,
      kind: p.kind,
      label: labelMap[p.kind] ?? p.kind,
      rect: shape.rect,
      x: p.x,
      y: p.y,
      searched: false,
      ammo,
      planks,
    })
  }
  return containers
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
  readonly containers: LootContainer[]
  readonly shots: CombatShotEvent[] = []
  private nextShotId = 1

  constructor(town: Town) {
    this.containers = buildLootContainers(town)
  }

  createContainerHandler(
    getCombatState: () => SurvivorCombatState,
    ai: OutbreakAISubsystem,
    getTime: () => number,
  ): InteractionHandler {
    return {
      kind: "container",
      candidates: (town, actor) => {
        if (actor.peekingWindowId) return []
        const out: RawInteractCandidate[] = []
        const walls = town.barriers.filter((b) => b.kind === "wall").map((b) => b.rect)
        for (const c of this.containers) {
          if (c.searched) continue
          if (distToRect(actor.x, actor.y, c.rect) > 1.45) continue
          const cBuilding = town.buildings.find(
            (b) => c.x >= b.rect[0] && c.x <= b.rect[2] && c.y >= b.rect[1] && c.y <= b.rect[3],
          )
          const aBuilding = town.buildings.find(
            (b) => actor.x >= b.rect[0] && actor.x <= b.rect[2] && actor.y >= b.rect[1] && actor.y <= b.rect[3],
          )
          if (cBuilding !== aBuilding) continue
          const nx = Math.max(c.rect[0], Math.min(c.rect[2], actor.x))
          const ny = Math.max(c.rect[1], Math.min(c.rect[3], actor.y))
          if (!clearLine(actor.x, actor.y, nx, ny, walls)) continue
          const searchAction: InteractAction = { id: "search", label: `Search ${c.label}` }
          out.push({
            kind: "container",
            id: c.id,
            rect: c.rect,
            worldX: c.x,
            worldY: c.y,
            primary: searchAction,
            actions: [searchAction],
          })
        }
        return out
      },
      execute: (_town, actor, targetId, action) => {
        if (action !== "search") return { handled: false }
        const c = this.containers.find((item) => item.id === targetId)
        if (!c || c.searched || distToRect(actor.x, actor.y, c.rect) > INTERACT_RANGE) {
          return { handled: false }
        }
        const combat = getCombatState()
        combat.channel = {
          kind: "search",
          targetId: c.id,
          label: `Searching ${c.label}…`,
          x: c.x,
          y: c.y,
          elapsed: 0,
          duration: SEARCH_DURATION,
        }
        actor.noise = Math.max(actor.noise, SEARCH_NOISE)
        ai.emitNoise(actor.x, actor.y, SEARCH_NOISE, "search", getTime(), "player")
        return {
          handled: true,
          kind: "container",
          targetId: c.id,
          action: "search",
          topologyChanged: false,
          noise: SEARCH_NOISE,
        }
      },
    }
  }

  startBarricade(
    town: Town,
    actor: InteractActorState & SurvivorCombatState,
    ai: OutbreakAISubsystem,
    time: number,
    explicitTargetId?: string,
  ): { started: boolean; topologyChanged: boolean } {
    if (actor.planks <= 0) {
      actor.lootMessage = "Need wooden planks to barricade"
      actor.lootMessageUntil = time + 2.2
      return { started: false, topologyChanged: false }
    }

    // Find nearest door or window within INTERACT_RANGE
    let bestId: string | null = explicitTargetId ?? null
    let bestRect: Rect | null = null
    let bestLabel = "opening"
    if (bestId) {
      const d = town.doors.find((item) => item.id === bestId)
      const w = town.windows.find((item) => item.id === bestId)
      if (d && distToRect(actor.x, actor.y, d.rect) <= INTERACT_RANGE) {
        bestRect = d.rect
        bestLabel = "door"
      } else if (w && distToRect(actor.x, actor.y, w.rect) <= INTERACT_RANGE) {
        bestRect = w.rect
        bestLabel = "window"
      } else {
        bestId = null
      }
    }

    if (!bestId) {
      let bestDist = INTERACT_RANGE
      for (const d of town.doors) {
        const dist = distToRect(actor.x, actor.y, d.rect)
        if (dist <= bestDist && ai.getBarricadePlanks(d.id) < 3) {
          bestDist = dist
          bestId = d.id
          bestRect = d.rect
          bestLabel = "door"
        }
      }
      for (const w of town.windows) {
        const dist = distToRect(actor.x, actor.y, w.rect)
        if (dist <= bestDist && ai.getBarricadePlanks(w.id) < 3) {
          bestDist = dist
          bestId = w.id
          bestRect = w.rect
          bestLabel = "window"
        }
      }
    }

    if (!bestId || !bestRect) return { started: false, topologyChanged: false }
    if (ai.getBarricadePlanks(bestId) >= 3) {
      actor.lootMessage = "Already fully barricaded (3/3 planks)"
      actor.lootMessageUntil = time + 2.0
      return { started: false, topologyChanged: false }
    }

    actor.channel = {
      kind: "barricade",
      targetId: bestId,
      label: `Boarding up ${bestLabel}…`,
      x: (bestRect[0] + bestRect[2]) * 0.5,
      y: (bestRect[1] + bestRect[3]) * 0.5,
      elapsed: 0,
      duration: BARRICADE_DURATION,
    }
    actor.noise = Math.max(actor.noise, BARRICADE_NOISE)
    ai.emitNoise(actor.x, actor.y, BARRICADE_NOISE, "barricade", time, "player")
    return { started: true, topologyChanged: false }
  }

  firePistol(
    player: { x: number; y: number; aim: number; noise: number; vault: unknown } & SurvivorCombatState,
    ai: OutbreakAISubsystem,
    sightBlockers: readonly Rect[],
    time: number,
  ): CombatShotEvent | null {
    if (player.vault || player.equippedItem !== "pistol") return null
    if (player.fireCooldown > 0 || player.reloadRemaining > 0) return null
    if (player.magAmmo <= 0) {
      if (player.reserveAmmo > 0) {
        this.startReload(player, ai, time)
      } else {
        player.lootMessage = "Out of 9mm ammo! Search houses (E) or shove (V)"
        player.lootMessageUntil = time + 2.2
      }
      return null
    }

    player.magAmmo--
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
  ): boolean {
    if (player.reloadRemaining > 0) return false
    if (player.magAmmo >= player.magCapacity || player.reserveAmmo <= 0) return false
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
      if (d > SHOVE_RANGE) continue
      const ang = Math.atan2(dy, dx)
      if (d > 0.35 && Math.abs(angleDiff(ang, player.aim)) > SHOVE_ARC) continue
      if (!clearLine(player.x, player.y, z.x, z.y, sightBlockers)) continue

      const ux = dx / (d || 1)
      const uy = dy / (d || 1)
      z.state = "stagger"
      z.stateTime = 0
      z.timer = 0.72
      z.staggerVx = ux * 6.2
      z.staggerVy = uy * 6.2
      z.hitFlash = 0.65
      z.hp = Math.max(1, z.hp - 15)
      z.awareness = 1
      z.targetX = player.x
      z.targetY = player.y
      shoved++
    }
    return shoved
  }

  step(
    town: Town,
    player: { x: number; y: number; vx: number; vy: number; sprinting: boolean } & SurvivorCombatState,
    ai: OutbreakAISubsystem,
    dt: number,
    time: number,
  ): { topologyChanged: boolean } {
    if (player.fireCooldown > 0) player.fireCooldown = Math.max(0, player.fireCooldown - dt)
    if (player.shoveCooldown > 0) player.shoveCooldown = Math.max(0, player.shoveCooldown - dt)
    if (player.shoveAnim > 0) player.shoveAnim = Math.max(0, player.shoveAnim - dt)
    if (player.recoil > 0) player.recoil = Math.max(0, player.recoil - dt * 5.5)

    if (player.reloadRemaining > 0) {
      player.reloadRemaining = Math.max(0, player.reloadRemaining - dt)
      if (player.reloadRemaining <= 0) {
        const needed = Math.max(0, player.magCapacity - player.magAmmo)
        const loaded = Math.min(needed, player.reserveAmmo)
        player.magAmmo += loaded
        player.reserveAmmo -= loaded
      }
    }

    let topologyChanged = false
    if (player.channel) {
      const ch = player.channel
      const movedTooFar = Math.hypot(player.x - ch.x, player.y - ch.y) > INTERACT_RANGE + 0.65
      if (movedTooFar || player.sprinting) {
        player.channel = null
      } else {
        ch.elapsed += dt
        if (ch.elapsed >= ch.duration) {
          player.channel = null
          if (ch.kind === "search") {
            const c = this.containers.find((item) => item.id === ch.targetId)
            if (c && !c.searched) {
              c.searched = true
              player.reserveAmmo += c.ammo
              player.planks += c.planks
              const parts: string[] = []
              if (c.ammo > 0) parts.push(`+${c.ammo} 9mm ammo`)
              if (c.planks > 0) parts.push(`+${c.planks} plank${c.planks > 1 ? "s" : ""}`)
              player.lootMessage = parts.length ? `Found ${parts.join(", ")}` : `Searched ${c.label}: empty`
              player.lootMessageUntil = time + 3.2
            }
          } else if (ch.kind === "barricade") {
            if (player.planks > 0 && ai.addBarricadePlank(ch.targetId)) {
              player.planks--
              const count = ai.getBarricadePlanks(ch.targetId)
              const door = town.doors.find((d) => d.id === ch.targetId)
              if (door) door.open = false
              const win = town.windows.find((w) => w.id === ch.targetId)
              if (win) win.open = false
              ai.rebuildTopology(town)
              topologyChanged = true
              player.lootMessage = `Barricaded (${count}/3 planks)`
              player.lootMessageUntil = time + 2.5
            }
          }
        }
      }
    }

    // Prune old shot events
    for (let i = this.shots.length - 1; i >= 0; i--) {
      if (time - this.shots[i]!.time > 0.35) {
        this.shots.splice(i, 1)
      }
    }

    return { topologyChanged }
  }
}
