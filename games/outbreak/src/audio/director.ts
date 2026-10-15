import { mulberry32 } from "@arcade/kit/sim/rng"
import type { AIState } from "../../shared/ai"
import type { CombatShotEvent } from "../../shared/combat"
import type { Town } from "../../shared/map"
import type { FeedbackActor } from "../hud/actor-feedback"

/** One sound to play: a library id at a plan position (x, y), optionally later or quieter. */
export type SoundEvent = { id: string; x: number; y: number; delay?: number; gain?: number; source: string }

/** The survivor fields the director diffs: `FeedbackActor` (the HUD's action feedback contract) plus position. */
export type SoundActor = Pick<
  FeedbackActor,
  "health" | "equippedItem" | "magAmmo" | "reserveAmmo" | "planks" | "reloadRemaining" | "shoveAnim" | "channel" | "lootMessage" | "lootMessageUntil" | "flashlightOn" | "exhausted" | "vault"
> & { x: number; y: number }

export type SoundZombie = { id: number; x: number; y: number; state: AIState }

/** What the director reads each frame. `CoopSim` provides all of it offline and in co-op (from snapshots). */
export type SoundWorld = {
  time: number
  town: Town
  zombies: readonly SoundZombie[]
  shots: readonly CombatShotEvent[]
  portals: ReadonlyMap<string, { barricadePlanks: number; lastBashTime: number }>
  survivors: readonly { id: string; survivor: SoundActor }[]
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

const QUIET: ReadonlySet<AIState> = new Set(["wander", "investigate", "search"])
const LOUD: ReadonlySet<AIState> = new Set(["alert", "chase"])
const center = (r: readonly number[]) => ({ x: (r[0]! + r[2]!) / 2, y: (r[1]! + r[3]!) / 2 })

type ActorMemory = SoundActor & { lootKey: number }

/**
 * Turns world-state changes into sounds. It only reads state (like the HUD's `ActorFeedback`), so the simulation and
 * wire format stay unchanged and co-op peers sound the same from snapshots. The first frame only records state.
 */
export class SoundDirector {
  private started = false
  private shots = new Set<number>()
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
    this.zombies.clear()
    this.deaths.clear()
    this.actors.clear()
  }

  observe(world: SoundWorld, listener: { x: number; y: number }): SoundEvent[] {
    const out: SoundEvent[] = []
    const emit = this.started ? (e: SoundEvent) => out.push(e) : () => {}
    const t = world.time
    const near = (x: number, y: number) => Math.hypot(x - listener.x, y - listener.y) <= this.tuning.hearing

    // Shots: the report at the muzzle, a casing a beat later, and the hit, or the kill, at the target.
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
      }
    }
    if (this.shots.size > 256) this.shots = new Set(world.shots.map((s) => s.id))

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
      if (prev !== undefined && QUIET.has(prev) && LOUD.has(z.state)) {
        if (t - (this.alertedAt.get(z.id) ?? -Infinity) >= this.tuning.alertPerZombie && t - this.lastAlert >= this.tuning.alertGap) {
          this.alertedAt.set(z.id, t)
          this.lastAlert = t
          emit({ id: "zombie.alert", x: z.x, y: z.y, source: "zombie" })
        }
      }
      if (z.state !== "stagger" && t - (this.groanedAt.get(z.id) ?? -Infinity) >= this.tuning.groanPerZombie) candidates.push(z)
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
      this.actors.set(id, { ...a, channel: a.channel ? { ...a.channel } : null, lootKey: a.lootMessageUntil })
      if (!p) continue
      const at = { x: a.x, y: a.y, source: id }
      if (a.reloadRemaining > 0 && p.reloadRemaining <= 0) {
        if (a.magAmmo === 0 && a.equippedItem === "pistol") emit({ id: "gun.dry-fire", ...at })
        emit({ id: "gun.pistol.reload", ...at, delay: 0.05 })
      }
      if (a.lootMessageUntil !== p.lootKey && a.lootMessage) {
        if (a.lootMessage.startsWith("Out of 9mm")) emit({ id: "gun.dry-fire", ...at })
        else if (a.lootMessage.startsWith("Blocked by barricade")) emit({ id: "door.locked", ...at })
      }
      if (a.reserveAmmo > p.reserveAmmo) emit({ id: "pickup.ammo", ...at })
      else if (a.planks > p.planks) emit({ id: "pickup.item", ...at })
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

    this.started = true
    return out
  }
}
