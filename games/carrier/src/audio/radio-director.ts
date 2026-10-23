import type { ZoneMark } from "../objective/zones"
import type { Radio } from "./radio"

/** What the director reads each frame: only this player's own jet, carrier and side. */
export type RadioWorld = {
  /** In play (not the title or the menus' offline sea). */
  playing: boolean
  /** Our jet's flight phase ("idle" when not in a jet). */
  phase: string
  /** The weapons' warning: 0 none, 1 an enemy is locking or locked on us, 2 a missile is inbound. */
  warn: 0 | 1 | 2
  /** Our jet's health 0..100 while it flies. */
  hp: number
  /** Our jet's position and the camera's right vector (which side an inbound missile is on). */
  own: { x: number; y: number; z: number } | null
  right: ArrayLike<number>
  /** Missiles in the air; those homing on `me` set the break direction. */
  missiles: readonly { alive: boolean; kind: string; target: number; x: number; y: number; z: number }[]
  me: number
  /** Our carrier's health 0..1 (null without one). */
  shipHp: number | null
  /** The objective's zones and our side. */
  zones: readonly ZoneMark[]
  team: number
}

/**
 * Decides when the radio talks, from transitions in the player's own state: the catapult shot ("cleared, good shot"),
 * the scripted landing starting ("call the ball"), a lock on us ("spike"), a missile inbound ("break left/right", by
 * the side it comes from), our jet badly hurt ("I'm hit"), our carrier losing health ("Mother's taking hits"), our side
 * taking a zone, zones about to move. Kills are pushed in (`kill`). The radio itself rate-limits and never overlaps.
 */
export class RadioDirector {
  private primed = false
  private phase = "idle"
  private warn = 0
  private hp = 100
  private shipHp: number | null = null
  private holders = new Map<number, number>()
  private nextCount = 0
  private flip = false

  constructor(readonly radio: Radio) {}

  /** We shot something down (a jet, a carrier, a parked jet). */
  kill(): void {
    this.radio.say("splash")
  }

  update(dt: number, w: RadioWorld): void {
    this.radio.update(dt)
    if (!w.playing) {
      if (this.primed) this.radio.reset()
      this.primed = false
      return
    }
    const first = !this.primed
    this.primed = true
    const say = first ? () => false : this.radio.say.bind(this.radio)

    if (w.phase !== this.phase) {
      if (w.phase === "launching") say("launch")
      else if (w.phase === "landing") say("ball")
      this.phase = w.phase
    }
    const flying = w.phase === "flying" || w.phase === "landing"
    const warn = flying ? w.warn : 0
    if (warn === 2 && this.warn !== 2) say(this.side(w) < 0 ? "break-left" : "break-right")
    else if (warn === 1 && this.warn === 0) say("spike")
    this.warn = warn
    const hp = flying ? w.hp : 100
    if (hp > 0 && (hp < this.hp - 15 || (hp < 35 && this.hp >= 35))) say("hit")
    this.hp = hp
    if (w.shipHp !== null && this.shipHp !== null && w.shipHp < this.shipHp - 0.004) say("mother")
    this.shipHp = w.shipHp

    let next = 0
    for (const z of w.zones) {
      if (z.next) {
        next++
        continue
      }
      const before = this.holders.get(z.id)
      if (z.holder >= 0 && z.holder === w.team && before !== undefined && before !== z.holder) say("zone-captured")
      this.holders.set(z.id, z.holder)
    }
    if (next > 0 && this.nextCount === 0) say("zones-moving")
    this.nextCount = next
  }

  /** -1 when the nearest missile homing on us is to our left, +1 right. */
  private side(w: RadioWorld): number {
    const o = w.own
    let best = Infinity
    let side = 0
    if (o)
      for (const m of w.missiles) {
        if (!m.alive || m.kind !== "missile" || m.target !== w.me) continue
        const dx = m.x - o.x
        const dy = m.y - o.y
        const dz = m.z - o.z
        const d = dx * dx + dy * dy + dz * dz
        if (d >= best) continue
        best = d
        side = dx * w.right[0]! + dy * w.right[1]! + dz * w.right[2]!
      }
    if (side !== 0) return Math.sign(side)
    // A SAM (not in the jets' world): alternate.
    this.flip = !this.flip
    return this.flip ? -1 : 1
  }
}
