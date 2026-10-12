import { GUNS } from "../config"
import { type Vec, angleDiff, clearLine } from "../geom"
import { Rng } from "../rng"
import { navFor } from "./nav"
import type { Brain, Intent, Player, World } from "./world"

const TURN = 4.5 / 30

/** Hunts the nearest player: walks a path toward them, and shoots after a short reaction when it has a clear line. */
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

  constructor(seed: number) {
    this.rng = new Rng(seed)
  }

  think(world: World, p: Player): Intent {
    const now = world.time
    const i: Intent = { mx: 0, my: 0, aim: this.aim, fire: false, reload: false }
    let near: Player | null = null
    let nd = Infinity
    for (const q of world.players.values()) {
      if (!q.alive || q.id === p.id) continue
      const d = Math.hypot(q.x - p.x, q.y - p.y)
      if (d < nd) {
        nd = d
        near = q
      }
    }
    if (!near) return i
    const gun = GUNS[p.gun]
    const sees = nd <= Math.max(gun.range, 12) && clearLine(p.x, p.y, near.x, near.y, world.blockers)
    if (sees) {
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
      return i
    }
    this.target = ""
    if (p.mag < gun.mag / 2) i.reload = true
    if (now >= this.repathAt || !this.path.length) {
      this.path = navFor(world.map).path(p, near) ?? []
      this.repathAt = now + 1 + this.rng.next()
    }
    while (this.path.length && Math.hypot(this.path[0]!.x - p.x, this.path[0]!.y - p.y) < 0.35) this.path.shift()
    const next = this.path[0]
    if (next) {
      const d = Math.hypot(next.x - p.x, next.y - p.y)
      i.mx = (next.x - p.x) / d
      i.my = (next.y - p.y) / d
      this.turn(Math.atan2(i.my, i.mx))
      i.aim = this.aim
    }
    return i
  }

  private turn(want: number): void {
    this.aim += Math.max(-TURN, Math.min(TURN, angleDiff(want, this.aim)))
  }
}
