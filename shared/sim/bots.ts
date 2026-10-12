import { GUNS } from "../config"
import { type Vec, angleDiff, clearLine } from "../geom"
import { Rng } from "../rng"
import { navFor } from "./nav"
import type { Brain, Intent, Player, World } from "./world"

const TURN = 4.5 / 30

/**
 * Hunts the nearest enemy: walks a path toward them, and shoots after a short reaction when it has a clear line. With
 * nobody in sight it plays the objective, when the mode has one.
 */
export class BotBrain implements Brain {
  private rng: Rng
  private path: Vec[] = []
  private repathAt = 0
  private aim = 0
  private target = ""
  private reactAt = 0
  private error = 0
  private strafe = 1
  private strafeAt = 0
  private goal: { x: number; y: number } | null = null

  constructor(seed: number) {
    this.rng = new Rng(seed)
  }

  think(world: World, p: Player): Intent {
    const now = world.time
    const i: Intent = { mx: 0, my: 0, aim: this.aim, fire: false, reload: false, sprint: false, equip: false, tx: 0, ty: 0, use: false }
    let near: Player | null = null
    let nd = Infinity
    for (const q of world.players.values()) {
      if (!q.alive || q.id === p.id || world.allies(p, q)) continue
      const d = Math.hypot(q.x - p.x, q.y - p.y)
      if (d < nd) {
        nd = d
        near = q
      }
    }
    const gun = GUNS[p.gun]
    const sees = !!near && nd <= Math.max(gun.range, 12) && clearLine(p.x, p.y, near.x, near.y, world.blockers)
    const obj = sees ? null : world.mode.botGoal(world, p)
    if (!near && !obj) return i
    if (near && sees) {
      if (this.target !== near.id) {
        this.target = near.id
        this.reactAt = now + 0.35 + this.rng.next() * 0.4
        this.error = (this.rng.next() - 0.5) * 0.4
      }
      this.error *= 0.93
      const want = Math.atan2(near.y - p.y, near.x - p.x) + this.error
      this.turn(want)
      i.aim = this.aim
      // Semi-automatic guns need the trigger released between shots.
      i.fire = now >= this.reactAt && Math.abs(angleDiff(this.aim, want)) < 0.12 && nd <= gun.range && (gun.auto || world.tick % 2 === 0)
      if (now > this.strafeAt) {
        this.strafe = this.rng.next() < 0.5 ? -1 : 1
        this.strafeAt = now + 0.6 + this.rng.next()
      }
      i.mx = Math.cos(want + (Math.PI / 2) * this.strafe) * 0.6
      i.my = Math.sin(want + (Math.PI / 2) * this.strafe) * 0.6
      // Now and then a frag at someone in throwing range.
      if (p.equip === "frag" && p.equipLeft > 0 && now >= this.reactAt && nd > 4 && nd < 11 && Math.abs(angleDiff(this.aim, want)) < 0.2 && this.rng.next() < 0.012) {
        i.equip = true
        i.fire = false
        i.tx = near.x
        i.ty = near.y
      }
      return i
    }
    this.target = ""
    if (p.mag < gun.mag / 2) i.reload = true
    const dest = obj ?? near!
    if (obj && Math.hypot(obj.x - p.x, obj.y - p.y) < 0.8) {
      // At the objective: hold still, and hold the key when there's something to plant or defuse.
      i.use = obj.use
      this.turn(this.aim + 0.02)
      i.aim = this.aim
      return i
    }
    const moved = !this.goal || Math.hypot(this.goal.x - dest.x, this.goal.y - dest.y) > 2
    if (now >= this.repathAt || !this.path.length || moved) {
      this.path = navFor(world.map).path(p, dest) ?? []
      this.goal = { x: dest.x, y: dest.y }
      this.repathAt = now + 1 + this.rng.next()
    }
    while (this.path.length && Math.hypot(this.path[0]!.x - p.x, this.path[0]!.y - p.y) < 0.35) this.path.shift()
    const next = this.path[0]
    if (next) {
      const d = Math.hypot(next.x - p.x, next.y - p.y)
      i.mx = (next.x - p.x) / d
      i.my = (next.y - p.y) / d
      // Run when the hunt has a long way to go.
      i.sprint = Math.hypot(dest.x - p.x, dest.y - p.y) > 8
      this.turn(Math.atan2(i.my, i.mx))
      i.aim = this.aim
    }
    return i
  }

  private turn(want: number): void {
    this.aim += Math.max(-TURN, Math.min(TURN, angleDiff(want, this.aim)))
  }
}
