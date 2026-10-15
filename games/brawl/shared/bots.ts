import { angleDiff, clearLine } from "@arcade/kit/sim/geom"
import { Rng } from "@arcade/kit/sim/rng"
import { STAGE } from "./arena"
import type { Brain, Fighter, Intent, World } from "./world"

const TURN = 7 / 30

/**
 * A party bot: picks the nearest foe, keeps to the range its abilities like, strafes, steps back from the ropes and
 * out of hostile zones, and uses every ability when the target sits in its `botRange`, after a short reaction.
 */
export class BotBrain implements Brain {
  private rng: Rng
  private aim = 0
  private target = ""
  private reactAt = 0
  private strafe = 1
  private strafeAt = 0
  private dodgeAt = 0

  constructor(seed: number) {
    this.rng = new Rng(seed)
  }

  think(w: World, me: Fighter): Intent {
    const now = w.time
    const i: Intent = { mx: 0, my: 0, aim: this.aim, tx: me.x, ty: me.y, cast: -1 }
    let foe: Fighter | null = null
    let fd = Infinity
    for (const q of w.players.values()) {
      if (q === me || !w.targetable(q)) continue
      const d = Math.hypot(q.x - me.x, q.y - me.y) * (q.id === this.target ? 0.8 : 1)
      if (d < fd) {
        fd = d
        foe = q
      }
    }
    // Ropes: lean back toward the middle when close to the edge.
    const edge = Math.min(me.x - STAGE[0], STAGE[2] - me.x, me.y - STAGE[1], STAGE[3] - me.y)
    const cx = (STAGE[0] + STAGE[2]) / 2 - me.x
    const cy = (STAGE[1] + STAGE[3]) / 2 - me.y
    const cd = Math.hypot(cx, cy) || 1
    if (!foe) {
      i.mx = cx / cd
      i.my = cy / cd
      return i
    }
    fd = Math.hypot(foe.x - me.x, foe.y - me.y)
    if (this.target !== foe.id) {
      this.target = foe.id
      this.reactAt = now + 0.25 + this.rng.next() * 0.35
    }
    const want = Math.atan2(foe.y - me.y, foe.x - me.x)
    this.aim += Math.max(-TURN, Math.min(TURN, angleDiff(want, this.aim)))
    i.aim = this.aim
    // Lead a moving target a little.
    i.tx = foe.x + foe.vx * 0.25
    i.ty = foe.y + foe.vy * 0.25
    const defs = w.def(me).abilities
    const ranges = defs.slice(0, 3).map((d) => d.botRange ?? 1.5)
    const ready = (s: number) => now >= (me.ab.ready[s] ?? 0)
    // Close to the longest-range ready ability, or to melee range.
    let keep = ranges[0]! * 0.8
    for (let s = 1; s < 3; s++) if (ready(s) && ranges[s]! > keep) keep = ranges[s]! * 0.7
    const dx = (foe.x - me.x) / (fd || 1)
    const dy = (foe.y - me.y) / (fd || 1)
    const close = fd > keep ? 1 : fd < keep * 0.6 ? -0.7 : 0
    if (now > this.strafeAt) {
      this.strafe = this.rng.next() < 0.5 ? -1 : 1
      this.strafeAt = now + 0.5 + this.rng.next() * 1.2
    }
    i.mx = dx * close - dy * this.strafe * 0.55
    i.my = dy * close + dx * this.strafe * 0.55
    if (edge < 2.2) {
      const k = (2.2 - edge) * 1.2
      i.mx += (cx / cd) * k
      i.my += (cy / cd) * k
    }
    // Step out of anything slippery or thorny someone else left.
    for (const z of w.abilitySystem.zones) {
      if (z.by === me.id || z.def.smoke || Math.hypot(z.x - me.x, z.y - me.y) > z.radius + 0.4) continue
      i.mx += (me.x - z.x) / (z.radius || 1)
      i.my += (me.y - z.y) / (z.radius || 1)
    }
    if (now < this.reactAt) return i
    const sees = clearLine(me.x, me.y, foe.x, foe.y, w.solids)
    const aimed = Math.abs(angleDiff(this.aim, want)) < 0.35
    // Dodge a foe winding up close by, now and then.
    const threat = foe.ab.cast && now < foe.ab.cast.release && fd < 3
    if (threat && ready(3) && now >= this.dodgeAt && this.rng.next() < 0.25) {
      this.dodgeAt = now + 1.5
      i.cast = 3
      i.tx = me.x - dy * this.strafe * 4
      i.ty = me.y + dx * this.strafe * 4
      i.aim = Math.atan2(i.ty - me.y, i.tx - me.x)
      return i
    }
    if (!sees || !aimed) return i
    for (const s of [2, 1, 0]) {
      const r = ranges[s]!
      if (!ready(s) || fd > r + 0.3 || (s > 0 && this.rng.next() > 0.18)) continue
      // Don't throw a long-range ability point-blank unless it is a short one.
      if (s > 0 && r > 4 && fd < 1.2) continue
      i.cast = s
      break
    }
    return i
  }
}
