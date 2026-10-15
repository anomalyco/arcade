import { angleDiff, clearLine } from "@arcade/kit/sim/geom"
import { Rng } from "@arcade/kit/sim/rng"
import { STAGE } from "./arena"
import type { Brain, Fighter, Intent, World } from "./world"

const TURN = 14 / 30

/**
 * A party bot: picks the nearest foe, closes to brawl range, herds wounded foes toward the ropes, steps back from
 * the edge when threatened, and fires its abilities aggressively once aimed.
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
      // Prefer nearby and high-damage foes ready to be knocked over the ropes.
      const finishBias = q.damage >= 65 ? 0.72 : 1
      const d = Math.hypot(q.x - me.x, q.y - me.y) * (q.id === this.target ? 0.82 : 1) * finishBias
      if (d < fd) {
        fd = d
        foe = q
      }
    }
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
      this.reactAt = now + 0.06 + this.rng.next() * 0.08
    }
    const want = Math.atan2(foe.y - me.y, foe.x - me.x)
    this.aim += Math.max(-TURN, Math.min(TURN, angleDiff(want, this.aim)))
    i.aim = this.aim
    // Lead a moving target based on distance.
    const lead = Math.min(0.28, fd * 0.03)
    i.tx = foe.x + foe.vx * lead
    i.ty = foe.y + foe.vy * lead
    const defs = w.def(me).abilities
    const ranges = defs.slice(0, 3).map((d) => d.botRange ?? 1.5)
    const ready = (s: number) => now >= (me.ab.ready[s] ?? 0)
    // Always pressure into primary/brawl range instead of kiting away when long cooldowns are up.
    const keep = Math.min(2.4, ranges[0]! * 0.88)
    const dx = (foe.x - me.x) / (fd || 1)
    const dy = (foe.y - me.y) / (fd || 1)
    const close = fd > keep ? 1 : fd < keep * 0.45 ? -0.35 : 0.25
    if (now > this.strafeAt) {
      this.strafe = this.rng.next() < 0.5 ? -1 : 1
      this.strafeAt = now + 0.45 + this.rng.next() * 0.85
    }
    const strafeWeight = fd > 3.2 ? 0.28 : 0.48
    i.mx = dx * close - dy * this.strafe * strafeWeight
    i.my = dy * close + dx * this.strafe * strafeWeight
    if (edge < 1.9) {
      const k = (1.9 - edge) * 1.35
      i.mx += (cx / cd) * k
      i.my += (cy / cd) * k
    }
    // Step out of hostile zones.
    for (const z of w.abilitySystem.zones) {
      if (z.by === me.id || z.def.smoke || Math.hypot(z.x - me.x, z.y - me.y) > z.radius + 0.4) continue
      i.mx += (me.x - z.x) / (z.radius || 1)
      i.my += (me.y - z.y) / (z.radius || 1)
    }
    if (now < this.reactAt) return i
    // If carrying someone or a prop, aim toward the nearest rope and throw immediately!
    if (me.ab.carry) {
      const toLeft = me.x - STAGE[0], toRight = STAGE[2] - me.x
      const toTop = me.y - STAGE[1], toBot = STAGE[3] - me.y
      const minEdge = Math.min(toLeft, toRight, toTop, toBot)
      const ex = minEdge === toLeft ? STAGE[0] - 4 : minEdge === toRight ? STAGE[2] + 4 : me.x
      const ey = minEdge === toTop ? STAGE[1] - 4 : minEdge === toBot ? STAGE[3] + 4 : me.y
      i.aim = Math.atan2(ey - me.y, ex - me.x)
      i.cast = 1
      return i
    }
    const sees = clearLine(me.x, me.y, foe.x, foe.y, w.solids)
    const aimed = Math.abs(angleDiff(this.aim, want)) < 0.48
    // Dodge a foe winding up close by, or burst back toward stage center when cornered.
    const threat = foe.ab.cast && now < foe.ab.cast.release && fd < 3.2
    if (threat && ready(3) && now >= this.dodgeAt && this.rng.next() < 0.38) {
      this.dodgeAt = now + 1.4
      i.cast = 3
      i.tx = me.x - dy * this.strafe * 4 + (cx / cd) * 1.5
      i.ty = me.y + dx * this.strafe * 4 + (cy / cd) * 1.5
      i.aim = Math.atan2(i.ty - me.y, i.tx - me.x)
      return i
    }
    if (!sees || !aimed) return i
    for (const s of [2, 1, 0]) {
      const r = ranges[s]!
      if (!ready(s) || fd > r + 0.4 || (s > 0 && this.rng.next() > 0.72)) continue
      if (s > 0 && r > 4.5 && fd < 1.0) continue
      i.cast = s
      break
    }
    return i
  }
}
