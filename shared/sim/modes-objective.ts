import { DT } from "../config"
import { type Vec, clearLine } from "../geom"
import { seedOf } from "../rng"
import { type Goal, MODE_FACTORIES, Mode, type ModeId, type ModeView, TeamDeathmatch } from "./modes"
import { navFor } from "./nav"
import { placesFor } from "./places"
import type { Intent, Player, World } from "./world"

/** Kill confirmed: how long a tag lies on the floor, and how close you walk to pick it up. */
export const KC = { life: 30, pickup: 1 }
/** Confirms that win kill confirmed: 15 for a few players, rising to 40 for a full room. */
export const kcTarget = (players: number) => Math.min(40, Math.max(15, Math.round((players * 40) / 12 / 5) * 5))
/** Hardpoint: zone radius, seconds before it moves, the heads-up before that, the score that wins, the match length. */
export const HP = { radius: 3.5, move: 60, warn: 10, target: 250, seconds: 480 }
/**
 * Capture the flag: captures that win, how close you touch a flag, how close to your base a capture counts, seconds
 * before a dropped flag goes home, the carrier's speed (of a walk), the match length.
 */
export const CTF = { captures: 3, touch: 1, capture: 1.6, autoReturn: 20, slow: 0.88, seconds: 480 }

export type TagView = { id: number; x: number; y: number; team: number; left: number }
export type ZoneView = { n: number; x: number; y: number; r: number; holder: number; contested: boolean; left: number; next: Vec | null }
export type FlagView = { team: number; state: "home" | "carried" | "dropped"; x: number; y: number; carrier: string; base: Vec; returnIn: number }

/** The flag carrier walks, a little slower than usual, and can't sprint. Shared by the server and client prediction. */
export function slowCarrier(i: Intent): Intent {
  const len = Math.hypot(i.mx, i.my)
  const k = len > 1 ? CTF.slow / len : CTF.slow
  return { ...i, sprint: false, mx: i.mx * k, my: i.my * k }
}

/** Whether `id` carries a flag in this view. */
export const carries = (m: ModeView, id: string) => !!m.flags?.some((f) => f.state === "carried" && f.carrier === id)

const bump = (p: Player, k: string) => {
  p.stats[k] = (p.stats[k] ?? 0) + 1
}
const living = (w: World) => [...w.players.values()].filter((p) => p.alive && p.team >= 0)
const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y)

/** A walkable spot up to `r` from `v`, different per bot, so a team doesn't stack on one point. */
function near(w: World, v: Vec, p: Player, r: number): Vec {
  const h = seedOf(p.id)
  const a = ((h % 360) / 360) * Math.PI * 2
  const s = { x: v.x + Math.cos(a) * r * (0.4 + ((h >> 9) % 60) / 100), y: v.y + Math.sin(a) * r * (0.4 + ((h >> 9) % 60) / 100) }
  return navFor(w.map).walkable(s) && clearLine(v.x, v.y, s.x, s.y, w.solids) ? s : v
}

type Tag = { id: number; x: number; y: number; team: number; at: number }

/** Team deathmatch where a kill only scores once someone picks up the victim's tag; their own team can deny it. */
export class KillConfirmed extends TeamDeathmatch {
  override readonly id: ModeId = "kc"
  tags: Tag[] = []
  private tagId = 0

  override start(w: World): void {
    this.tags = []
    super.start(w)
  }

  override killed(w: World, victim: Player): void {
    if (victim.team >= 0) this.tags.push({ id: ++this.tagId, x: victim.x, y: victim.y, team: victim.team, at: w.time })
  }

  override step(w: World): void {
    this.tags = this.tags.filter((t) => w.time - t.at < KC.life)
    const alive = living(w)
    for (const t of [...this.tags]) {
      const p = alive.find((q) => Math.hypot(q.x - t.x, q.y - t.y) <= KC.pickup)
      if (!p) continue
      this.tags.splice(this.tags.indexOf(t), 1)
      const confirm = p.team !== t.team
      if (confirm) this.score[p.team]!++
      bump(p, confirm ? "confirms" : "denies")
      w.events.push({ k: "obj", what: confirm ? "confirm" : "deny", team: p.team, by: p.id, x: t.x, y: t.y })
    }
    if (Math.max(...this.score) >= this.target(w)) w.endMatch()
  }

  override target(w: World): number {
    return kcTarget(w.players.size)
  }

  /** The nearest tag within reach, friend or foe. */
  override botGoal(_w: World, p: Player): Goal | null {
    let best: Tag | null = null
    let bd = 22
    for (const t of this.tags) {
      const d = dist(t, p)
      if (d < bd) {
        bd = d
        best = t
      }
    }
    return best ? { x: best.x, y: best.y, use: false } : null
  }

  override view(w: World, viewer: string): ModeView {
    return { ...super.view(w, viewer), tags: this.tags.map((t) => ({ id: t.id, x: t.x, y: t.y, team: t.team, left: Math.max(0, KC.life - (w.time - t.at)) })) }
  }
}

/** One zone at a time, moving every minute; a team scores every second it holds the zone alone. */
export class Hardpoint extends TeamDeathmatch {
  override readonly id: ModeId = "hp"
  holder = -1
  contested = false
  private startAt = 0
  private acc = 0
  private last = 0

  override get seconds(): number {
    return HP.seconds
  }

  override start(w: World): void {
    this.startAt = w.time
    this.holder = -1
    this.contested = false
    this.acc = 0
    this.last = 0
    super.start(w)
  }

  override killed(): void {}

  /** How many times the zone has moved. */
  index(w: World): number {
    return Math.floor((w.time - this.startAt) / HP.move)
  }

  zone(w: World, ahead = 0): Vec {
    const hills = placesFor(w.map).hills
    return hills[(this.index(w) + ahead) % hills.length]!
  }

  /** Seconds before the zone moves. */
  zoneLeft(w: World): number {
    return HP.move - ((w.time - this.startAt) % HP.move)
  }

  override step(w: World): void {
    const n = this.index(w)
    if (n !== this.last) {
      this.last = n
      this.acc = 0
      const z = this.zone(w)
      w.events.push({ k: "obj", what: "move", team: -1, by: "", x: z.x, y: z.y })
    }
    const z = this.zone(w)
    const on = [0, 0]
    const there: Player[] = []
    for (const p of living(w)) {
      if (dist(p, z) > HP.radius || !clearLine(z.x, z.y, p.x, p.y, w.blockers)) continue
      on[p.team]!++
      there.push(p)
    }
    this.contested = on[0]! > 0 && on[1]! > 0
    const t: number = this.contested ? -1 : on[0]! > 0 ? 0 : on[1]! > 0 ? 1 : -1
    if (t !== this.holder) {
      this.acc = 0
      if (t >= 0) w.events.push({ k: "obj", what: "hold", team: t, by: "", x: z.x, y: z.y })
    }
    this.holder = t
    if (t >= 0) {
      this.acc += DT
      while (this.acc >= 1) {
        this.acc -= 1
        this.score[t]!++
        for (const p of there) bump(p, "hill")
      }
    }
    if (Math.max(...this.score) >= HP.target) w.endMatch()
  }

  override target(): number {
    return HP.target
  }

  /** The zone, or the next one when it's about to move. */
  override botGoal(w: World, p: Player): Goal | null {
    const z = this.zoneLeft(w) < 6 ? this.zone(w, 1) : this.zone(w)
    return { ...near(w, z, p, HP.radius * 0.6), use: false }
  }

  override view(w: World, viewer: string): ModeView {
    const z = this.zone(w)
    const left = this.zoneLeft(w)
    return {
      ...super.view(w, viewer),
      zone: { n: this.index(w), x: z.x, y: z.y, r: HP.radius, holder: this.holder, contested: this.contested, left, next: left <= HP.warn ? { ...this.zone(w, 1) } : null },
    }
  }
}

type Flag = { team: number; state: FlagView["state"]; x: number; y: number; carrier: string; droppedAt: number }

/** Take the enemy flag to your base while yours is home. Three captures wins; a tie goes to kills. */
export class CaptureTheFlag extends Mode {
  override readonly id: ModeId = "ctf"
  flags: [Flag, Flag] = [this.flag(0), this.flag(1)]
  private fresh = true

  override get seconds(): number {
    return CTF.seconds
  }

  private flag(team: number): Flag {
    return { team, state: "home", x: 0, y: 0, carrier: "", droppedAt: 0 }
  }

  base(w: World, team: number): Vec {
    return placesFor(w.map).bases[team === 1 ? 1 : 0]
  }

  override start(w: World): void {
    this.flags = [this.flag(0), this.flag(1)]
    for (const f of this.flags) this.home(w, f)
    this.fresh = true
    super.start(w)
    this.fresh = false
  }

  /** The opening spawn is at the team's end; after that, a spawn on the team's half far from enemies. */
  override spawnAt(w: World, p: Player): Vec | null {
    if (this.fresh) return this.endSlot(w, p, p.team)
    const half = placesFor(w.map).halves[p.team === 1 ? 1 : 0]
    const enemies = living(w).filter((q) => q.team !== p.team)
    let best: Vec | null = null
    let bs = -Infinity
    for (const s of half) {
      const e = enemies.length ? Math.min(...enemies.map((q) => dist(q, s))) : 20
      const sc = Math.min(e, 15) + w.rng.next()
      if (sc > bs) {
        bs = sc
        best = s
      }
    }
    return best
  }

  carrying(p: Player): Flag | undefined {
    return this.flags.find((f) => f.state === "carried" && f.carrier === p.id)
  }

  override intent(_w: World, p: Player, i: Intent): Intent {
    return this.carrying(p) ? slowCarrier(i) : i
  }

  override killed(w: World, victim: Player): void {
    this.drop(w, victim)
  }

  override leave(w: World, p: Player): void {
    this.drop(w, p)
  }

  private drop(w: World, p: Player): void {
    const f = this.carrying(p)
    if (!f) return
    f.state = "dropped"
    f.carrier = ""
    f.x = p.x
    f.y = p.y
    f.droppedAt = w.time
    w.events.push({ k: "obj", what: "drop", team: f.team, by: p.id, x: f.x, y: f.y })
  }

  private home(w: World, f: Flag): void {
    const b = this.base(w, f.team)
    f.state = "home"
    f.carrier = ""
    f.x = b.x
    f.y = b.y
  }

  override step(w: World): void {
    for (const f of this.flags) {
      if (f.state === "carried") {
        const c = w.players.get(f.carrier)
        if (c?.alive) {
          f.x = c.x
          f.y = c.y
        } else {
          f.state = "dropped"
          f.carrier = ""
          f.droppedAt = w.time
        }
      }
      if (f.state === "dropped" && w.time - f.droppedAt >= CTF.autoReturn) {
        this.home(w, f)
        w.events.push({ k: "obj", what: "return", team: f.team, by: "", x: f.x, y: f.y })
      }
    }
    for (const p of living(w)) {
      for (const f of this.flags) {
        if (f.state === "carried" || dist(p, f) > CTF.touch) continue
        if (p.team === f.team) {
          if (f.state !== "dropped") continue
          this.home(w, f)
          bump(p, "returns")
          w.events.push({ k: "obj", what: "return", team: f.team, by: p.id, x: f.x, y: f.y })
        } else if (!this.carrying(p)) {
          f.state = "carried"
          f.carrier = p.id
          f.x = p.x
          f.y = p.y
          w.events.push({ k: "obj", what: "take", team: f.team, by: p.id, x: f.x, y: f.y })
        }
      }
      const c = this.carrying(p)
      if (c && this.flags[p.team]!.state === "home" && dist(p, this.base(w, p.team)) <= CTF.capture) {
        this.score[p.team]!++
        bump(p, "captures")
        w.events.push({ k: "obj", what: "capture", team: p.team, by: p.id, x: p.x, y: p.y })
        this.home(w, c)
      }
    }
    if (Math.max(...this.score) >= CTF.captures) w.endMatch()
  }

  /** Most captures; level on captures, the team with more kills. */
  override result(w: World): { winner: string; team: number } {
    if (this.score[0] !== this.score[1]) return super.result(w)
    const k = [0, 1].map((t) => this.members(w, t).reduce((s, p) => s + p.kills, 0))
    return { winner: "", team: k[0] === k[1] ? -1 : k[0]! > k[1]! ? 0 : 1 }
  }

  override target(): number {
    return CTF.captures
  }

  /**
   * The carrier runs home. Half of each team attacks: takes the enemy flag, or escorts the carrier home. The other half
   * defends: returns or chases its own flag, else guards the base. Anyone close to a dropped own flag returns it.
   */
  override botGoal(w: World, p: Player): Goal | null {
    if (p.team < 0) return null
    const own = this.flags[p.team]!
    const foe = this.flags[1 - p.team]!
    const base = this.base(w, p.team)
    if (this.carrying(p)) return { ...base, use: false, rush: true }
    const attack = seedOf(p.id) % 2 === 0
    if (own.state === "dropped" && (!attack || dist(own, p) < 15)) return { x: own.x, y: own.y, use: false }
    if (attack) {
      if (foe.state !== "carried") return { x: foe.x, y: foe.y, use: false }
      return own.state === "home" ? { ...near(w, base, p, 2.5), use: false } : { x: own.x, y: own.y, use: false }
    }
    if (own.state === "carried") return { x: own.x, y: own.y, use: false }
    return { ...near(w, base, p, 4), use: false }
  }

  override view(w: World, viewer: string): ModeView {
    return {
      ...super.view(w, viewer),
      flags: this.flags.map((f) => ({ team: f.team, state: f.state, x: f.x, y: f.y, carrier: f.carrier, base: { ...this.base(w, f.team) }, returnIn: f.state === "dropped" ? Math.max(0, CTF.autoReturn - (w.time - f.droppedAt)) : 0 })),
    }
  }
}

MODE_FACTORIES.kc = () => new KillConfirmed()
MODE_FACTORIES.hp = () => new Hardpoint()
MODE_FACTORIES.ctf = () => new CaptureTheFlag()
