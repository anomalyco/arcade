import { WEAPONS } from "../config"
import { clearLine } from "../geom"
import { Rng } from "../rng"
import type { Brain, Intent, Player, World } from "./world"

const IDLE: Intent = { mx: 0, my: 0, stance: "walk", aim: 0, fire: false, reload: false, gadget: -1, tx: 0, ty: 0, use: false }

type Mode = "patrol" | "investigate" | "engage"

/**
 * A bot plays by the same rules as a person. It hears only rings it could be within range of, and sees only players
 * the visibility rule lets a viewer see. It has the map's nav points and nothing else.
 */
export class BotBrain implements Brain {
  private rng: Rng
  private mode: Mode = "patrol"
  private goal: { x: number; y: number } | null = null
  private goalUntil = 0
  private target: string | null = null
  private sawAt = -10
  private sawPos = { x: 0, y: 0 }
  private reactAt = 0
  private jitter = 0
  private stuckAt = 0
  private stuckPos = { x: 0, y: 0 }

  constructor(seed: number) {
    this.rng = new Rng(seed)
  }

  think(world: World, p: Player): Intent {
    const i: Intent = { ...IDLE, aim: p.aim }
    const now = world.time

    const seen = [...world.players.values()].filter((q) => q.id !== p.id && world.enemy(p, q) && q.alive && world.canSee(p, q))
    if (seen.length > 0) {
      const t = seen.reduce((a, b) => (Math.hypot(b.x - p.x, b.y - p.y) < Math.hypot(a.x - p.x, a.y - p.y) ? b : a))
      if (this.target !== t.id || now - this.sawAt > 1) {
        this.reactAt = now + this.rng.range(0.35, 0.7)
        this.jitter = this.rng.range(-0.07, 0.07)
      }
      this.target = t.id
      this.sawAt = now
      this.sawPos = { x: t.x, y: t.y }
      this.mode = "engage"
    } else if (now - this.sawAt > 2.5) {
      this.target = null
      if (this.mode === "engage") this.mode = "investigate"
    }

    if (this.mode !== "engage") {
      const heard = world.heardBy(p, 1.2).filter((r) => r.owner !== p.id)
      if (heard.length > 0) {
        const r = heard[heard.length - 1]!
        this.goal = { x: r.x, y: r.y }
        this.goalUntil = now + 4
        this.mode = "investigate"
      }
    }

    if (this.mode === "engage") {
      const t = this.target ? world.players.get(this.target) : undefined
      const visible = t && world.canSee(p, t)
      const focus = visible ? t : null
      const fx = focus ? focus.x : this.sawPos.x
      const fy = focus ? focus.y : this.sawPos.y
      i.aim = Math.atan2(fy - p.y, fx - p.x) + (focus ? this.jitter : 0)
      const d = Math.hypot(fx - p.x, fy - p.y)
      if (!focus && d > 1) {
        i.stance = "walk"
        this.moveToward(p, i, fx, fy, 1)
      }
      if (focus && d > 9) {
        i.stance = "sneak"
        this.moveToward(p, i, fx, fy, 0.6)
      }
      if (focus && now >= this.reactAt && p.mag > 0 && p.reloadUntil === 0 && !p.windup && now >= p.cooldownUntil) {
        const diff = Math.abs(angleDiff(i.aim, Math.atan2(fy - p.y, fx - p.x)))
        if (diff < 0.2 && d <= WEAPONS[p.loadout.weapon].range) i.fire = true
      }
      if (!focus && now - this.sawAt > 2.5) this.mode = "patrol"
      if (p.mag === 0 && !focus) i.reload = true
      return this.unstick(p, i, now)
    }

    if (p.mag < WEAPONS[p.loadout.weapon].mag && !p.windup && p.reserve > 0 && p.reloadUntil === 0 && now - this.sawAt > 3) {
      i.reload = true
    }

    if (!this.goal || now >= this.goalUntil || Math.hypot(this.goal.x - p.x, this.goal.y - p.y) < 1.2) {
      this.pickGoal(world, p, now)
    }
    if (this.mode === "investigate" && this.goal && Math.hypot(this.goal.x - p.x, this.goal.y - p.y) < 1.2) this.mode = "patrol"
    if (this.goal) {
      const hurry = this.mode === "patrol" && this.rng.next() < 0.002
      i.stance = this.mode === "investigate" ? "sneak" : hurry ? "run" : "walk"
      this.moveToward(p, i, this.goal.x, this.goal.y, 1)
    }
    return this.unstick(p, i, now)
  }

  private pickGoal(world: World, p: Player, now: number): void {
    const nav = world.map.nav
    let best: { x: number; y: number } | null = null
    for (let k = 0; k < 8; k++) {
      const c = nav[this.rng.int(nav.length)]!
      if (Math.hypot(c.x - p.x, c.y - p.y) < 3) continue
      if (!clearLine(p.x, p.y, c.x, c.y, world.walls)) continue
      const lit = world.litAt(c.x, c.y)
      best = c
      if (!lit || this.rng.next() < 0.3) break
    }
    this.mode = "patrol"
    this.goal = best ?? nav[this.rng.int(nav.length)]!
    this.goalUntil = now + 8
  }

  private moveToward(p: Player, i: Intent, x: number, y: number, speedFactor: number): void {
    const dx = x - p.x
    const dy = y - p.y
    const d = Math.hypot(dx, dy)
    if (d < 0.2) return
    i.mx = (dx / d) * speedFactor
    i.my = (dy / d) * speedFactor
  }

  /** A bot that has barely moved for a while drops its goal and picks another. */
  private unstick(p: Player, i: Intent, now: number): Intent {
    if (now - this.stuckAt > 1.5) {
      const moved = Math.hypot(p.x - this.stuckPos.x, p.y - this.stuckPos.y)
      if (moved < 0.2 && this.mode !== "engage") this.goal = null
      this.stuckAt = now
      this.stuckPos = { x: p.x, y: p.y }
    }
    return i
  }
}

function angleDiff(a: number, b: number): number {
  let d = a - b
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return d
}
