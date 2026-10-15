import type { InputOps } from "@arcade/kit/net/jitter-buffer"
import { Abilities, type AbilityActor, type AbilityEvent, type AbilityHost, type HitDef, abilityState, movement, shieldScale } from "@arcade/kit/sim/abilities"
import { type Rect, pushOut } from "@arcade/kit/sim/geom"
import { stepBody } from "@arcade/kit/sim/move"
import { type PropEvent, Props } from "@arcade/kit/sim/props"
import { Rng } from "@arcade/kit/sim/rng"
import { BotBrain } from "./bots"
import { CENTER, PROP_KINDS, ROPES, SOLIDS, SPAWNS, STAGE, onStage, propLayout } from "./arena"
import { CHARACTERS, ROSTER, characterOf, type CharacterDef } from "./characters"
import {
  ACCEL, BOT_FILL, COUNTDOWN_SECONDS, CREDIT_SECONDS, DT, FALL_SECONDS, INVULN_SECONDS, KNOCK_GROWTH, LAUNCH_FRICTION,
  PLAYER_RADIUS, RESPAWN_SECONDS, RESULTS_SECONDS, ROPE_BREAK, ROUND_SECONDS, SELECT_SECONDS, STOCKS, WALL_BOUNCE,
} from "./config"

export type Phase = "select" | "play" | "results"

/** One tick of input: move, aim (radians) and the floor point under the cursor, and the slot pressed this tick (-1 none). */
export type Intent = { mx: number; my: number; aim: number; tx: number; ty: number; cast: number }
export const NO_INTENT: Intent = { mx: 0, my: 0, aim: 0, tx: 0, ty: 0, cast: -1 }

/** The cast is the one-shot edge (with the floor point it was aimed at); movement and aim are held. */
export const INTENT_OPS: InputOps<Intent> = {
  merge: (a, b) => (b.cast >= 0 || a.cast < 0 ? b : { ...b, cast: a.cast, tx: a.tx, ty: a.ty }),
  standIn: (last) => (last.cast < 0 ? last : { ...last, cast: -1 }),
  hasEdges: (i) => i.cast >= 0,
}

export interface Brain {
  think(world: World, f: Fighter): Intent
}

export type Fighter = AbilityActor & {
  name: string
  human: boolean
  brain: Brain | null
  /** The character in play, and the select-screen pick ("" none yet). */
  char: string
  pick: string
  ready: boolean
  /** Damage percent: knockback grows with it. */
  damage: number
  stocks: number
  kos: number
  falls: number
  /** Out of the round (no stocks left) or waiting to respawn. */
  respawnAt: number
  invulnUntil: number
  /** When the fighter went over the edge (0 on stage). */
  fallAt: number
  /** No control until this time: flying from a hit. */
  launchUntil: number
  lastHitBy: string
  lastHitAt: number
  queue: { seq: number; intent: Intent }[]
  ack: number
  /** Order of elimination, for placing: higher went out later. */
  outAt: number
  slot: number
}

export type SimEvent =
  | AbilityEvent
  | { k: "hit"; by: string; target: string; x: number; y: number; damage: number; speed: number }
  | { k: "ko"; victim: string; by: string; x: number; y: number; stocks: number }
  | { k: "spawn"; id: string; x: number; y: number }
  | { k: "phase"; phase: Phase }
  | { k: "go" }
  | { k: "end"; winner: string }
  | { k: "prop-fall"; id: number; x: number; y: number }

const BOT_NAMES = ["pip", "mabel", "dex", "zuzu", "otto", "fizz", "lulu", "boz"]

/**
 * A room's match: pick characters, then a stock round on the ring until one fighter is left, results, and back to the
 * select screen. Knockback grows with damage; fly fast enough and you clear the ropes. Props and every ability run in
 * `@arcade/kit/sim/{props,abilities}`; this file is the game's rules.
 */
export class World implements AbilityHost<Fighter> {
  readonly rng: Rng
  readonly dt = DT
  time = 0
  tick = 0
  phase: Phase = "select"
  phaseEnd = SELECT_SECONDS
  /** Fighters can't act before this (the round's countdown). */
  goAt = 0
  round = 0
  winner = ""
  players = new Map<string, Fighter>()
  order: string[] = []
  events: SimEvent[] = []
  readonly props = new Props(PROP_KINDS)
  readonly abilitySystem: Abilities<Fighter>
  solids: Rect[] = SOLIDS
  readonly bodySolids: Rect[] = [...SOLIDS, ...ROPES]
  /** What walking fighters bump into: blocks, ropes and grounded props. */
  private walk: Rect[] = []
  botFill = BOT_FILL
  private botCount = 0
  host = ""

  constructor(seed: number) {
    this.rng = new Rng(seed)
    this.abilitySystem = new Abilities(this)
    this.layProps()
  }

  get actors(): Fighter[] {
    return this.order.map((id) => this.players.get(id)!)
  }

  get humans(): Fighter[] {
    return [...this.players.values()].filter((p) => p.human)
  }

  abilities(f: Fighter) {
    return this.def(f).abilities
  }

  def(f: Fighter): CharacterDef {
    return CHARACTERS[f.char] ?? ROSTER[0]!
  }

  targetable(f: Fighter): boolean {
    return f.alive && f.fallAt === 0 && this.time >= f.invulnUntil && this.phase === "play"
  }

  private newFighter(id: string, name: string, brain: Brain | null): Fighter {
    return {
      id, name, human: !brain, brain, x: 0, y: 0, vx: 0, vy: 0, aim: 0, alive: false, radius: PLAYER_RADIUS, ab: abilityState(4),
      char: ROSTER[0]!.id, pick: "", ready: false, damage: 0, stocks: 0, kos: 0, falls: 0, respawnAt: Infinity, invulnUntil: 0, fallAt: 0,
      launchUntil: 0, lastHitBy: "", lastHitAt: -99, queue: [], ack: 0, outAt: 0, slot: this.freeSlot(),
    }
  }

  /** The lowest colour slot nobody holds. */
  private freeSlot(): number {
    const used = new Set([...this.players.values()].map((p) => p.slot))
    let s = 0
    while (used.has(s)) s++
    return s
  }

  addHuman(id: string, name: string, pick = ""): Fighter {
    const f = this.newFighter(id, name, null)
    if (characterOf(pick)) f.pick = f.char = pick
    this.players.set(id, f)
    this.order.push(id)
    this.host ||= id
    this.fill()
    // Joining mid-round: watch until the next select screen.
    return f
  }

  remove(id: string): void {
    const f = this.players.get(id)
    if (!f) return
    this.abilitySystem.forget(f)
    this.players.delete(id)
    this.order = this.order.filter((x) => x !== id)
    if (this.host === id) this.host = this.humans[0]?.id ?? ""
    if (this.phase === "play") this.checkEnd()
  }

  /** Tops the room up to `botFill` fighters with bots (removing bots as humans arrive). */
  fill(to = this.botFill): void {
    const bots = [...this.players.values()].filter((p) => !p.human)
    while (this.players.size > Math.max(to, this.humans.length) && bots.length) this.remove(bots.pop()!.id)
    while (this.players.size < to) {
      const id = `bot${++this.botCount}`
      const brain = new BotBrain(this.rng.int(2 ** 31))
      const f = this.newFighter(id, BOT_NAMES[(this.botCount - 1) % BOT_NAMES.length]!, brain)
      // Bots pick someone nobody else has, while there's anyone left.
      const taken = new Set([...this.players.values()].map((p) => p.pick))
      const free = ROSTER.filter((c) => !taken.has(c.id))
      f.pick = f.char = this.rng.pick(free.length ? free : ROSTER).id
      f.ready = true
      this.players.set(id, f)
      this.order.push(id)
    }
  }

  /** A pick on the select screen (or between rounds). */
  pick(id: string, char: string): void {
    const f = this.players.get(id)
    if (!f || !characterOf(char) || this.phase === "play") return
    f.pick = char
    f.char = char
  }

  setReady(id: string, ready: boolean): void {
    const f = this.players.get(id)
    if (f && this.phase === "select" && f.pick) f.ready = ready
  }

  /** Queues one tick of input (the room's jitter buffer hands over one per tick; a reconnect may restart `seq`). */
  push(id: string, seq: number, intent: Intent): void {
    const f = this.players.get(id)
    if (!f || !f.human) return
    f.queue.push({ seq, intent })
    // Never drop a press: an overflowing queue folds its oldest input into the next one.
    if (f.queue.length > 8) {
      const a = f.queue.shift()!
      f.queue[0] = { seq: f.queue[0]!.seq, intent: INTENT_OPS.merge(a.intent, f.queue[0]!.intent) }
    }
  }

  takeEvents(): SimEvent[] {
    const out = this.events
    this.events = []
    return out
  }

  private layProps(): void {
    this.props.clear()
    for (const p of propLayout(this.rng)) this.props.add(p.kind, p.x, p.y, p.h)
  }

  private setPhase(phase: Phase, seconds: number): void {
    this.phase = phase
    this.phaseEnd = this.time + seconds
    this.events.push({ k: "phase", phase })
  }

  /** Starts a round with everyone's pick (a random one for anyone who didn't). */
  startRound(): void {
    this.round++
    this.winner = ""
    this.abilitySystem.clear()
    this.layProps()
    const spots = [...SPAWNS]
    for (let i = spots.length - 1; i > 0; i--) {
      const j = this.rng.int(i + 1)
      ;[spots[i], spots[j]] = [spots[j]!, spots[i]!]
    }
    this.actors.forEach((f, i) => {
      if (!f.pick) f.pick = this.rng.pick(ROSTER).id
      f.char = f.pick
      f.stocks = STOCKS
      f.kos = 0
      f.falls = 0
      f.outAt = 0
      const s = spots[i % spots.length]!
      this.spawnAt(f, s.x, s.y)
      f.invulnUntil = 0
    })
    this.goAt = this.time + COUNTDOWN_SECONDS
    this.setPhase("play", COUNTDOWN_SECONDS + ROUND_SECONDS)
  }

  private spawnAt(f: Fighter, x: number, y: number): void {
    this.abilitySystem.forget(f)
    f.ab = abilityState(4)
    f.x = x
    f.y = y
    f.vx = f.vy = 0
    f.aim = Math.atan2(CENTER.y - y, CENTER.x - x)
    f.alive = true
    f.damage = 0
    f.fallAt = 0
    f.launchUntil = 0
    f.lastHitBy = ""
    f.respawnAt = Infinity
    f.invulnUntil = this.time + INVULN_SECONDS
    this.events.push({ k: "spawn", id: f.id, x, y })
  }

  /** The spawn point farthest from everyone on stage. */
  private respawn(f: Fighter): void {
    let best = SPAWNS[0]!
    let bd = -1
    for (const s of SPAWNS) {
      let d = Infinity
      for (const q of this.players.values()) if (q !== f && q.alive) d = Math.min(d, Math.hypot(q.x - s.x, q.y - s.y))
      if (d > bd) {
        bd = d
        best = s
      }
    }
    this.spawnAt(f, best.x, best.y)
  }

  /** Damage and knockback: speed grows with the damage taken so far and shrinks with weight. */
  hit(t: Fighter, h: HitDef, by: Fighter | null, fx: number, fy: number, scale: number): void {
    if (!this.targetable(t)) return
    const shield = shieldScale(t, this.time)
    const dmg = h.damage * scale * shield
    t.damage = Math.min(999, t.damage + dmg)
    const speed = (h.knock * scale * shield * (1 + t.damage / KNOCK_GROWTH)) / this.def(t).weight
    let dx = t.x - fx
    let dy = t.y - fy
    const d = Math.hypot(dx, dy)
    if (d < 1e-4) {
      dx = Math.cos(by?.aim ?? 0)
      dy = Math.sin(by?.aim ?? 0)
    } else {
      dx /= d
      dy /= d
    }
    if (speed > 2.5) {
      t.vx = dx * speed + t.vx * 0.2
      t.vy = dy * speed + t.vy * 0.2
      t.launchUntil = Math.max(t.launchUntil, this.time + Math.min(1.1, 0.08 + speed * 0.035))
      if (t.ab.cast && this.time < t.ab.cast.release) t.ab.cast = null
    } else {
      t.vx += dx * speed
      t.vy += dy * speed
    }
    if (by && by !== t) {
      t.lastHitBy = by.id
      t.lastHitAt = this.time
    }
    this.events.push({ k: "hit", by: by?.id ?? "", target: t.id, x: t.x, y: t.y, damage: dmg, speed })
  }

  step(): void {
    this.time += DT
    this.tick++
    if (this.phase === "select") this.stepSelect()
    else if (this.phase === "play") this.stepPlay()
    else if (this.time >= this.phaseEnd) {
      for (const f of this.players.values()) {
        f.ready = !f.human
        f.alive = false
      }
      this.setPhase("select", SELECT_SECONDS)
    }
    // Inputs are consumed every tick so acks keep moving outside play too.
    if (this.phase !== "play") for (const f of this.players.values()) this.intentOf(f)
  }

  private stepSelect(): void {
    const humans = this.humans
    const allReady = humans.length > 0 && humans.every((h) => h.ready)
    if (allReady || this.time >= this.phaseEnd) this.startRound()
  }

  private intentOf(f: Fighter): Intent {
    if (f.brain) return f.alive && this.phase === "play" && this.time >= this.goAt ? f.brain.think(this, f) : NO_INTENT
    const q = f.queue.shift()
    if (!q) return { ...NO_INTENT, aim: f.aim }
    f.ack = q.seq
    return q.intent
  }

  private stepPlay(): void {
    const now = this.time
    const live = now >= this.goAt
    // Heavy grounded props (the car) stop walking fighters; light ones get shoved instead.
    this.walk = [...SOLIDS, ...ROPES]
    for (const p of this.props.list) if (p.alive && !p.held && p.z < 0.4 && this.props.def(p).heavy) this.walk.push(this.props.bounds(p))
    for (const f of this.actors) {
      const intent = this.intentOf(f)
      if (!f.alive) {
        if (f.stocks > 0 && now >= f.respawnAt) this.respawn(f)
        continue
      }
      if (f.fallAt) {
        // Over the edge: keep drifting outward, then the knock-out counts.
        f.x += f.vx * DT
        f.y += f.vy * DT
        if (now - f.fallAt >= FALL_SECONDS) this.knockOut(f)
        continue
      }
      f.aim = intent.aim
      if (!live || f.ab.carriedBy) {
        f.vx = f.vy = 0
        continue
      }
      const mv = movement(f, this.def(f).abilities, now)
      if (now < f.launchUntil) this.fly(f)
      else if (!f.ab.dash) {
        const can = mv.canMove
        stepBody(f, can ? intent.mx : 0, can ? intent.my : 0, this.def(f).speed * mv.speed, this.walk, DT, f.radius, ACCEL * this.def(f).accel * mv.accel)
      }
      if (intent.cast >= 0 && intent.cast < 4) {
        // Pressing the grab again throws early.
        if (f.ab.carry && intent.cast === 1) this.abilitySystem.throw(f)
        else this.abilitySystem.cast(f, intent.cast, intent.tx, intent.ty)
      }
      this.abilitySystem.stepActor(f)
      if (!onStage(f.x, f.y, -0.05) && !f.ab.carriedBy) {
        f.fallAt = now
        f.ab.cast = null
        f.ab.dash = null
      }
    }
    if (live) {
      this.abilitySystem.step()
      const events: PropEvent[] = []
      const pushers = this.actors.filter((f) => f.alive && !f.fallAt && !f.ab.carriedBy)
      this.props.step(DT, SOLIDS, pushers, events, ROPES)
      for (const e of events) this.propEvent(e)
      for (const p of this.props.list) {
        if (p.alive && !p.held && !onStage(p.x, p.y, 0.3)) {
          p.alive = false
          this.events.push({ k: "prop-fall", id: p.id, x: p.x, y: p.y })
        }
      }
      for (const e of this.abilitySystem.events) {
        this.events.push(e)
        if (e.k === "prop-boom") this.propEvent(e)
      }
      this.abilitySystem.events = []
    }
    if (now >= this.phaseEnd) this.endRound()
  }

  /** Flying from a hit: no control, low friction, bounce off blocks, clear the ropes when fast enough. */
  private fly(f: Fighter): void {
    const sp = Math.hypot(f.vx, f.vy)
    if (sp > 0) {
      const k = Math.max(0, sp - LAUNCH_FRICTION * DT) / sp
      f.vx *= k
      f.vy *= k
    }
    const walls = sp > ROPE_BREAK ? SOLIDS : [...SOLIDS, ...ROPES]
    const steps = Math.max(1, Math.ceil((sp * DT) / 0.12))
    for (let i = 0; i < steps; i++) {
      const ox = f.x, oy = f.y
      f.x += (f.vx * DT) / steps
      f.y += (f.vy * DT) / steps
      const bx = f.x, by = f.y
      pushOut(f, f.radius, walls)
      if (Math.abs(f.x - bx) > 1e-6) f.vx = -f.vx * WALL_BOUNCE
      if (Math.abs(f.y - by) > 1e-6) f.vy = -f.vy * WALL_BOUNCE
      if (f.x === ox && f.y === oy) break
    }
  }

  private propEvent(e: PropEvent | Extract<AbilityEvent, { k: "prop-boom" }>): void {
    if (e.k !== "prop-boom") {
      this.events.push(e)
      return
    }
    const by = this.players.get(e.by) ?? null
    for (const f of this.actors) {
      const d = Math.hypot(f.x - e.x, f.y - e.y)
      if (d > e.radius) continue
      this.hit(f, { damage: 14 * (1 - d / e.radius) + 4, knock: 15 * (1 - d / e.radius) + 4 }, by, e.x, e.y, 1)
    }
    if (!this.abilitySystem.events.includes(e)) this.events.push(e)
  }

  private knockOut(f: Fighter): void {
    f.alive = false
    f.stocks--
    f.falls++
    const credit = f.lastHitBy && this.time - f.lastHitAt < CREDIT_SECONDS ? this.players.get(f.lastHitBy) : undefined
    if (credit) credit.kos++
    this.abilitySystem.forget(f)
    this.events.push({ k: "ko", victim: f.id, by: credit?.id ?? "", x: f.x, y: f.y, stocks: f.stocks })
    if (f.stocks > 0) f.respawnAt = this.time + RESPAWN_SECONDS
    else f.outAt = this.time
    this.checkEnd()
  }

  private checkEnd(): void {
    const standing = this.actors.filter((f) => f.stocks > 0)
    if (this.actors.length > 1 && standing.length <= 1) this.endRound()
  }

  /** Last one standing wins; on time, the most stocks, then the least damage. */
  endRound(): void {
    if (this.phase !== "play") return
    const ranked = this.ranking()
    this.winner = ranked[0]?.id ?? ""
    this.events.push({ k: "end", winner: this.winner })
    this.setPhase("results", RESULTS_SECONDS)
  }

  ranking(): Fighter[] {
    return [...this.actors].sort((a, b) => b.stocks - a.stocks || (a.stocks === 0 ? b.outAt - a.outAt : a.damage - b.damage) || b.kos - a.kos)
  }
}
