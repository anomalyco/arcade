import { mulberry32 } from "@arcade/kit/sim/rng"
import type { AIState } from "../../shared/ai"
import { MELEE_WEAPONS, type CombatMeleeEvent, type CombatShotEvent } from "../../shared/combat"
import type { Town } from "../../shared/map"
import { impactDelay, shotImpacts } from "./impacts"
import { InventorySounds, type SoundHold, type SoundProgression } from "./inventory"
import { RELOAD_STARTS, reloadElapsed } from "./reload"
import type { SoundActor, SoundEvent } from "./types"

export type { SoundActor, SoundEvent } from "./types"

export type SoundZombie = { id: number; x: number; y: number; state: AIState; vx?: number; vy?: number; seed?: number; drag?: number }

/** What the director reads each frame. `CoopSim` provides all of it offline and in co-op (from snapshots). */
export type SoundWorld = {
  time: number
  town: Town
  zombies: readonly SoundZombie[]
  shots: readonly CombatShotEvent[]
  meleeSwings?: readonly CombatMeleeEvent[]
  portals: ReadonlyMap<string, { barricadePlanks: number; lastBashTime: number }>
  survivors: readonly { id: string; survivor: SoundActor }[]
  /** Items, drops, benches, pings and lures (absent in tests that only need combat and doors). */
  progression?: SoundProgression
  hour?: number
}

export const DIRECTOR_TUNING = {
  /** Zombies further than this from the listener stay silent (m). */
  hearing: 30,
  /** Idle groans: seconds between groans with one zombie in earshot, and the shortest gap with many. */
  groanInterval: 4.5,
  groanMinGap: 0.7,
  /** A zombie groans at most this often (s). */
  groanPerZombie: 8,
  /** A zombie's alert snarl at most this often (s), and at most one snarl per `alertGap` across the crowd. */
  alertPerZombie: 8,
  alertGap: 0.35,
  /** Reach of a zombie attack, for pairing a survivor's damage with the zombie that dealt it (m). */
  attackReach: 1.8,
}

/** Reload parts are scheduled up to this far ahead of the frame that reaches them (s). */
const RELOAD_LOOKAHEAD = 1 / 50
const QUIET: ReadonlySet<AIState> = new Set(["wander", "investigate", "search"])
const LOUD: ReadonlySet<AIState> = new Set(["alert", "chase", "crawler"])
const center = (r: readonly number[]) => ({ x: (r[0]! + r[2]!) / 2, y: (r[1]! + r[3]!) / 2 })

type ActorMemory = SoundActor & { lootKey: number; reloadStart: number; reloadElapsed: number }

/**
 * Turns world-state changes into sounds. It only reads state (like the HUD's `ActorFeedback`), so the simulation and
 * wire format stay unchanged and co-op peers sound the same from snapshots. The first frame only records state.
 */
export class SoundDirector {
  private started = false
  private shots = new Set<number>()
  private meleeSwings = new Set<number>()
  private meleeHits = new Set<string>()
  private meleeBreaks = new Set<number>()
  private zombies = new Map<number, AIState>()
  private groanedAt = new Map<number, number>()
  private alertedAt = new Map<number, number>()
  private attackedAt = new Map<number, number>()
  private deaths = new Set<number>()
  private doors = new Map<string, { open: boolean; locked: boolean }>()
  private windows = new Map<string, boolean>()
  private planks = new Map<string, number>()
  private bashes = new Map<string, number>()
  private actors = new Map<string, ActorMemory>()
  private readonly inventory = new InventorySounds()
  private nextGroan = 0
  private lastAlert = -Infinity
  private readonly rng: () => number
  readonly tuning = { ...DIRECTOR_TUNING }

  constructor(seed = 11) {
    this.rng = mulberry32(seed)
  }

  reset(): void {
    this.started = false
    this.shots.clear()
    this.meleeSwings.clear()
    this.meleeHits.clear()
    this.meleeBreaks.clear()
    this.zombies.clear()
    this.deaths.clear()
    this.actors.clear()
    this.inventory.reset()
  }

  /** Sounds held for as long as something lasts, as of the last `observe`: crafts, research, noisemakers, generators. */
  get holds(): readonly SoundHold[] {
    return this.inventory.holds
  }

  observe(world: SoundWorld, listener: { x: number; y: number }): SoundEvent[] {
    const out: SoundEvent[] = []
    const emit = this.started ? (e: SoundEvent) => out.push(e) : () => {}
    const t = world.time
    const near = (x: number, y: number) => Math.hypot(x - listener.x, y - listener.y) <= this.tuning.hearing

    // Shots: the report at the muzzle, a casing a beat later, and the hit, or the kill, at the target; a miss strikes
    // whatever stopped it (and rings off any pane, board, fence or car it went through), as the round arrives.
    for (const shot of world.shots) {
      if (this.shots.has(shot.id)) continue
      this.shots.add(shot.id)
      emit({ id: "gun.pistol.shot", x: shot.fromX, y: shot.fromY, source: "shot" })
      emit({ id: "gun.casing", x: shot.fromX, y: shot.fromY, delay: 0.38 + this.rng() * 0.12, source: "shot" })
      if (shot.hitZombieId !== null) {
        emit({ id: "zombie.hit", x: shot.toX, y: shot.toY, delay: 0.02, source: "shot" })
        if (shot.killed && !this.deaths.has(shot.hitZombieId)) {
          this.deaths.add(shot.hitZombieId)
          emit({ id: "zombie.death", x: shot.toX, y: shot.toY, delay: 0.1, source: "shot" })
        }
      } else if (this.started) {
        for (const hit of shotImpacts(world.town, shot, (id) => world.portals.get(id)?.barricadePlanks ?? 0)) {
          emit({ id: `impact.bullet.${hit.surface}`, x: hit.x, y: hit.y, delay: impactDelay(hit.t), gain: hit.through ? 0.8 : 1, source: "shot" })
        }
      }
    }
    if (this.shots.size > 256) this.shots = new Set(world.shots.map((s) => s.id))

    // Melee swings: whoosh on active swing start, material-matched impact on each struck zombie, and break sound on shatter.
    if (world.meleeSwings) {
      for (const m of world.meleeSwings) {
        const w = MELEE_WEAPONS[m.weapon] ?? MELEE_WEAPONS.crowbar
        const attacker = world.survivors.find((s) => s.id === m.attackerId)?.survivor
        const maxDur = attacker?.meleeMaxDurability ?? w.durability
        const curDur = attacker?.meleeDurability
        const wear = m.weaponBroke
          ? 1
          : curDur !== undefined && maxDur > 0
            ? Math.max(0, Math.min(1, 1 - curDur / maxDur))
            : m.durabilityLow
              ? 0.75
              : 0
        const hitRate = wear > 0.08 ? Number((1 - wear * 0.22).toFixed(3)) : undefined
        if (!this.meleeSwings.has(m.id)) {
          this.meleeSwings.add(m.id)
          const isHeavy = m.heavy || w.weaponClass === "two-heavy"
          emit({
            id: isHeavy ? "melee.swing.heavy" : "melee.swing.light",
            x: m.x,
            y: m.y,
            ...(hitRate ? { rate: Number((1 - wear * 0.1).toFixed(3)) } : {}),
            source: m.attackerId,
          })
        }
        for (const h of m.hits) {
          const hitKey = `${m.id}:${h.zombieId}`
          if (this.meleeHits.has(hitKey)) continue
          this.meleeHits.add(hitKey)
          emit({
            id: `melee.hit.${w.material}`,
            x: h.x,
            y: h.y,
            delay: 0.015,
            gain: h.finisher ? 1.3 : m.heavy ? 1.15 : 1,
            ...(hitRate ? { rate: hitRate } : {}),
            source: m.attackerId,
          })
          if (!m.weaponBroke && (m.durabilityLow || wear >= 0.65)) {
            emit({
              id: "melee.break",
              x: h.x,
              y: h.y,
              delay: 0.032,
              gain: 0.42,
              rate: 1.28,
              source: m.attackerId,
            })
          }
          if (h.finisher) {
            emit({
              id: "melee.shove",
              x: h.x,
              y: h.y,
              delay: 0.03,
              gain: 1.15,
              source: m.attackerId,
            })
          }
          if (h.killed && !this.deaths.has(h.zombieId)) {
            this.deaths.add(h.zombieId)
            emit({ id: "zombie.death", x: h.x, y: h.y, delay: 0.08, source: "zombie" })
          }
        }
        if (m.weaponBroke && !this.meleeBreaks.has(m.id)) {
          this.meleeBreaks.add(m.id)
          emit({ id: "melee.break", x: m.x, y: m.y, delay: 0.04, source: m.attackerId })
        }
      }
      if (this.meleeSwings.size > 256) this.meleeSwings = new Set(world.meleeSwings.map((m) => m.id))
      if (this.meleeHits.size > 512) this.meleeHits.clear()
      if (this.meleeBreaks.size > 128) this.meleeBreaks.clear()
    }

    // Zombie states: snarl on noticing someone, death without a shot (shoves, co-op kills), crowd-spaced idle groans.
    const seen = new Set<number>()
    const candidates: SoundZombie[] = []
    for (const z of world.zombies) {
      seen.add(z.id)
      const prev = this.zombies.get(z.id)
      this.zombies.set(z.id, z.state)
      if (z.state === "dead") {
        if (prev !== undefined && prev !== "dead" && !this.deaths.has(z.id)) {
          this.deaths.add(z.id)
          if (near(z.x, z.y)) emit({ id: "zombie.death", x: z.x, y: z.y, source: "zombie" })
        }
        continue
      }
      this.deaths.delete(z.id)
      if (!near(z.x, z.y)) continue
      if (prev !== undefined && prev !== "knockdown" && z.state === "knockdown") {
        emit({ id: "body.vault", x: z.x, y: z.y, delay: 0.14, gain: 0.85, source: "zombie" })
      }
      if (prev !== undefined && QUIET.has(prev) && LOUD.has(z.state)) {
        if (t - (this.alertedAt.get(z.id) ?? -Infinity) >= this.tuning.alertPerZombie && t - this.lastAlert >= this.tuning.alertGap) {
          this.alertedAt.set(z.id, t)
          this.lastAlert = t
          emit({ id: "zombie.alert", x: z.x, y: z.y, source: "zombie" })
        }
      }
      if (z.state !== "stagger" && z.state !== "knockdown" && t - (this.groanedAt.get(z.id) ?? -Infinity) >= this.tuning.groanPerZombie) candidates.push(z)
    }
    for (const id of this.zombies.keys()) if (!seen.has(id)) { this.zombies.delete(id); this.groanedAt.delete(id) }
    if (candidates.length && t >= this.nextGroan) {
      const z = candidates[Math.floor(this.rng() * candidates.length)]!
      this.groanedAt.set(z.id, t)
      const chasing = LOUD.has(z.state) ? 1.25 : 1
      emit({ id: "zombie.groan.idle", x: z.x, y: z.y, gain: chasing, source: "zombie" })
      const gap = this.tuning.groanInterval / Math.sqrt(candidates.length)
      this.nextGroan = t + Math.max(this.tuning.groanMinGap, gap * (0.6 + this.rng() * 0.8))
    }

    // Doors and windows, wherever they are: whoever moved them, the sound comes from the opening.
    for (const d of world.town.doors) {
      const prev = this.doors.get(d.id)
      const now = { open: d.open, locked: Boolean(d.locked) }
      this.doors.set(d.id, now)
      if (!prev) continue
      const at = center(d.rect)
      if (prev.locked !== now.locked) emit({ id: "door.locked", ...at, source: "door" })
      if (prev.open !== now.open) emit({ id: now.open ? "door.wood.open" : "door.wood.close", ...at, source: "door" })
    }
    for (const w of world.town.windows) {
      const prev = this.windows.get(w.id)
      this.windows.set(w.id, w.open)
      if (prev !== undefined && prev !== w.open) emit({ id: "window.slide", ...center(w.rect), source: "window" })
    }
    for (const [id, st] of world.portals) {
      const rect = world.town.doors.find((d) => d.id === id)?.rect ?? world.town.windows.find((w) => w.id === id)?.rect
      if (!rect) continue
      const prevPlanks = this.planks.get(id)
      this.planks.set(id, st.barricadePlanks)
      if (prevPlanks !== undefined && st.barricadePlanks > prevPlanks) emit({ id: "barricade.hammer", ...center(rect), source: "barricade" })
      if (prevPlanks !== undefined && st.barricadePlanks < prevPlanks) emit({ id: "barricade.break", ...center(rect), source: "barricade" })
      const prevBash = this.bashes.get(id)
      this.bashes.set(id, st.lastBashTime)
      if (prevBash !== undefined && st.lastBashTime > prevBash + 1e-3) emit({ id: "door.bash", ...center(rect), source: "bash" })
    }

    // Survivors: the same transitions ActorFeedback reports, as sounds at each survivor (remote ones from snapshots).
    const present = new Set<string>()
    for (const { id, survivor: a } of world.survivors) {
      present.add(id)
      const p = this.actors.get(id)
      // The reload in parts, each when the reload pose reaches it (looking one frame ahead to land on time).
      let reloadStart = p?.reloadStart ?? t
      let elapsed = -1
      if (a.reloadRemaining > 0) {
        if (!p || p.reloadRemaining <= 0) reloadStart = t
        elapsed = reloadElapsed(a.reloadRemaining, p?.reloadRemaining ?? 0, reloadStart, t)
      }
      this.actors.set(id, { ...a, channel: a.channel ? { ...a.channel } : null, lootKey: a.lootMessageUntil, reloadStart, reloadElapsed: elapsed })
      if (!p) continue
      const at = { x: a.x, y: a.y, source: id }
      if (a.reloadRemaining > 0 && p.reloadRemaining <= 0 && a.magAmmo === 0 && a.equippedItem === "pistol") emit({ id: "gun.dry-fire", ...at })
      if (elapsed >= 0) {
        const ahead = elapsed + RELOAD_LOOKAHEAD
        for (const part of RELOAD_STARTS) {
          if (part.start <= ahead && part.start > p.reloadElapsed + RELOAD_LOOKAHEAD) emit({ id: part.id, ...at, delay: Math.max(0, part.start - elapsed) })
        }
      }
      if (a.lootMessageUntil !== p.lootKey && a.lootMessage) {
        if (a.lootMessage.startsWith("Out of 9mm")) emit({ id: "gun.dry-fire", ...at })
        else if (a.lootMessage.startsWith("Blocked by barricade")) emit({ id: "door.locked", ...at })
      }
      // Pickups by item class come from the ledger (`InventorySounds`); survivors whose stores this peer cannot see
      // (other seats on a co-op client) fall back to their replicated ammo and planks.
      if (!world.progression?.ledger.stores.has(`${id}/belt`)) {
        if (a.reserveAmmo > p.reserveAmmo) emit({ id: "pickup.ammo", ...at })
        else if (a.planks > p.planks) emit({ id: "pickup.plank", ...at })
      }
      if (a.channel?.kind === "search" && (!p.channel || p.channel.targetId !== a.channel.targetId)) emit({ id: "search.rummage", ...at })
      if (a.shoveAnim > p.shoveAnim + 1e-4) emit({ id: "melee.shove", ...at })
      if (a.flashlightOn !== p.flashlightOn) emit({ id: "flashlight.click", ...at })
      if (a.exhausted && !p.exhausted) emit({ id: "body.breath.exhausted", ...at })
      if (a.vault && !p.vault) emit({ id: "body.vault", ...at })
      if (a.health < p.health - 0.5) {
        emit({ id: "body.hurt", ...at, delay: 0.04 })
        let best: SoundZombie | null = null
        let bestD = this.tuning.attackReach
        for (const z of world.zombies) {
          if (z.state === "dead") continue
          const d = Math.hypot(z.x - a.x, z.y - a.y)
          if (d < bestD) { bestD = d; best = z }
        }
        if (best && t - (this.attackedAt.get(best.id) ?? -Infinity) > 0.8) {
          this.attackedAt.set(best.id, t)
          emit({ id: "zombie.attack", x: best.x, y: best.y, source: "zombie" })
        }
      }
    }
    for (const id of this.actors.keys()) if (!present.has(id)) this.actors.delete(id)
    this.inventory.observe(world.progression, world.hour ?? 12, world.survivors, out, world.time)

    this.started = true
    return out
  }
}
