import { THROW_RANGE, WEAPONS, type Stance } from "../config"
import { type Vec, angleDiff, distToRect, rayRect } from "../geom"
import { Rng } from "../rng"
import { navFor } from "./nav"
import type { Brain, Intent, Player, World } from "./world"

type State = "patrol" | "hold" | "investigate" | "engage"

const TURN_RATE = 3.2

/**
 * A bot plays by the same rules as everyone. It hears only rings it is inside of, sees only what the visibility rule
 * lets a player see, and knows the floor plan. It moves slowly, holds dark spots, and takes a moment to react.
 */
export class BotBrain implements Brain {
  private rng: Rng
  private state: State = "hold"
  private goal: Vec | null = null
  private path: Vec[] = []
  private stance: Stance = "walk"
  private holdUntil = -1
  private target: string | null = null
  private lastSeen: Vec | null = null
  private lastSeenAt = -10
  private reactAt = 0
  private aimError = 0
  private aim = 0
  private progressAt = 0
  private progressPos: Vec = { x: 0, y: 0 }
  private pendingUse = false
  private heardUpTo = 0
  private throwAt: { slot: 0 | 1; x: number; y: number } | null = null
  private patience: number

  constructor(seed: number) {
    this.rng = new Rng(seed)
    this.patience = 0.6 + this.rng.next() * 0.8
  }

  think(world: World, p: Player): Intent {
    const now = world.time
    const i: Intent = { mx: 0, my: 0, stance: "walk", aim: this.aim, fire: false, reload: false, gadget: -1, tx: 0, ty: 0, use: false }
    // Everyone starts a round by listening.
    if (this.holdUntil < 0) {
      this.holdUntil = now + 4 + this.rng.next() * 10
      this.aim = p.aim
    }
    if (this.pendingUse) {
      i.use = true
      this.pendingUse = false
    }

    const enemy = this.spot(world, p, now)
    if (enemy) return this.engage(world, p, i, enemy, now)
    if (this.state === "engage" && now - this.lastSeenAt > 1.2) {
      this.state = "investigate"
      this.setGoal(world, p, this.lastSeen!, "sneak")
    }

    this.listen(world, p, now)

    const w = WEAPONS[p.loadout.weapon]
    if (p.mag < w.mag && p.reserve > 0 && p.reloadUntil === 0 && now - this.lastSeenAt > 4) i.reload = true

    if (this.state === "hold") {
      this.turnToward(i, p.aim + Math.sin(now * 0.4 + p.x) * 0.02, 1)
      if (now >= this.holdUntil || (p.lit && this.rng.next() < 0.05)) this.state = "patrol"
      return i
    }
    if (!this.goal || this.path.length === 0) {
      if (this.state === "investigate") {
        this.state = "hold"
        this.holdUntil = now + 2 + this.rng.next() * 3
        return i
      }
      this.pickPatrol(world, p)
    }
    this.follow(world, p, i, now)
    return i
  }

  /** The nearest enemy this bot can currently see, if any. */
  private spot(world: World, p: Player, now: number): Player | null {
    let best: Player | null = null
    let bd = Infinity
    for (const q of world.players.values()) {
      if (!world.enemy(p, q) || !world.sees(p, q, true)) continue
      const d = Math.hypot(q.x - p.x, q.y - p.y)
      if (d < bd) {
        bd = d
        best = q
      }
    }
    if (best) {
      if (this.target !== best.id || now - this.lastSeenAt > 1.5) {
        this.reactAt = now + (0.6 + this.rng.next() * 0.6) * (this.patience + 0.5)
        this.aimError = (this.rng.next() - 0.5) * 0.5
      }
      this.target = best.id
      this.lastSeen = { x: best.x, y: best.y }
      this.lastSeenAt = now
      this.state = "engage"
    }
    return best
  }

  private engage(world: World, p: Player, i: Intent, q: Player, now: number): Intent {
    const want = Math.atan2(q.y - p.y, q.x - p.x)
    this.aimError *= 0.92
    this.turnToward(i, want + this.aimError, 1.6)
    const d = Math.hypot(q.x - p.x, q.y - p.y)
    const w = WEAPONS[p.loadout.weapon]
    const onTarget = Math.abs(angleDiff(i.aim, want)) < Math.max(0.05, 0.3 / Math.max(d, 1))
    if (p.mag === 0) {
      i.reload = true
      i.mx = -Math.cos(want)
      i.my = -Math.sin(want)
      i.stance = "walk"
      return i
    }
    if (now >= this.reactAt && onTarget && d <= w.range * 0.95 && p.windupUntil === 0) i.fire = true
    // Out of range: creep closer; in range: hold still and shoot.
    if (d > w.range * 0.8) {
      this.setGoal(world, p, { x: q.x, y: q.y }, "sneak")
      this.follow(world, p, i, now)
      i.aim = this.aim
    }
    return i
  }

  /** Reacts to the newest ring this bot is inside of. Teammates' rings are ignored when the teammate is in view. */
  private listen(world: World, p: Player, now: number): void {
    let pick: (typeof world.heard)[number] | null = null
    for (const r of world.heard) {
      if (r.t <= this.heardUpTo || r.owner === p.id) continue
      if (Math.hypot(r.x - p.x, r.y - p.y) > r.r) continue
      if (r.kind === "lamp" || r.kind === "flare") continue
      const owner = r.owner ? world.players.get(r.owner) : undefined
      if (owner && !world.enemy(p, owner) && Math.hypot(owner.x - r.x, owner.y - r.y) < 1.5) continue
      pick = r
    }
    if (world.heard.length) this.heardUpTo = world.heard[world.heard.length - 1]!.t
    if (!pick) return
    const d = Math.hypot(pick.x - p.x, pick.y - p.y)
    const loud = pick.kind === "shot" || pick.kind === "shotgun" || pick.kind === "glass" || pick.kind === "alarm"
    // Patient bots stay put for soft sounds; loud ones get investigated or flared.
    if (!loud && this.state === "hold" && this.rng.next() < this.patience * 0.6) {
      this.aim = Math.atan2(pick.y - p.y, pick.x - p.x)
      return
    }
    const flareSlot = p.loadout.gadgets.indexOf("flare")
    if (loud && flareSlot >= 0 && p.gadgets[flareSlot as 0 | 1] > 0 && d > 4 && d < THROW_RANGE + 2 && this.rng.next() < 0.35) {
      this.throwAt = { slot: flareSlot as 0 | 1, x: pick.x, y: pick.y }
    }
    this.state = "investigate"
    this.setGoal(world, p, { x: pick.x, y: pick.y }, d < 7 ? "sneak" : this.rng.next() < 0.5 ? "walk" : "sneak")
    this.aim = Math.atan2(pick.y - p.y, pick.x - p.x)
  }

  private pickPatrol(world: World, p: Player): void {
    const nav = navFor(world.map)
    let goal = nav.randomFree(this.rng)
    for (let k = 0; k < 10; k++) {
      const c = nav.randomFree(this.rng)
      const d = Math.hypot(c.x - p.x, c.y - p.y)
      if (d < 4 || d > 14) continue
      goal = c
      if (!world.litAt(c.x, c.y)) break
    }
    this.state = "patrol"
    this.setGoal(world, p, goal, this.rng.next() < 0.8 ? "sneak" : "walk")
  }

  private setGoal(world: World, p: Player, goal: Vec, stance: Stance): void {
    const nav = navFor(world.map)
    this.goal = goal
    this.stance = stance
    this.path = nav.path(p, goal) ?? []
    this.progressAt = world.time
    this.progressPos = { x: p.x, y: p.y }
  }

  private follow(world: World, p: Player, i: Intent, now: number): void {
    if (this.throwAt) {
      i.gadget = this.throwAt.slot
      i.tx = this.throwAt.x
      i.ty = this.throwAt.y
      this.throwAt = null
    }
    while (this.path.length && Math.hypot(this.path[0]!.x - p.x, this.path[0]!.y - p.y) < 0.35) this.path.shift()
    const next = this.path[0]
    if (!next) {
      if (this.state === "patrol") {
        this.state = "hold"
        this.holdUntil = now + (6 + this.rng.next() * 12) * (0.5 + this.patience)
      }
      this.goal = null
      return
    }
    const dx = next.x - p.x
    const dy = next.y - p.y
    const d = Math.hypot(dx, dy)
    // Open closed doors on the way.
    for (const door of world.map.doors) {
      if (world.level.doorsOpen[door.id] || distToRect(p.x, p.y, door.rect) > 1.1) continue
      if (rayRect(p.x, p.y, dx / d, dy / d, door.rect, Math.min(d, 1.6)) !== Infinity) this.pendingUse = true
    }
    i.mx = dx / d
    i.my = dy / d
    i.stance = this.stance
    this.turnToward(i, Math.atan2(dy, dx), 1)
    if (now - this.progressAt > 1.6) {
      if (Math.hypot(p.x - this.progressPos.x, p.y - this.progressPos.y) < 0.3) {
        this.path = []
        this.goal = null
      }
      this.progressAt = now
      this.progressPos = { x: p.x, y: p.y }
    }
  }

  private turnToward(i: Intent, want: number, rate: number): void {
    const diff = angleDiff(want, this.aim)
    const step = TURN_RATE * rate * (1 / 30)
    this.aim += Math.max(-step, Math.min(step, diff))
    i.aim = this.aim
  }
}
