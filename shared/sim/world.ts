import { DT, END_SECONDS, FILL_TO, GUNS, GUN_IDS, type Gun, HEALTH, HIT_RADIUS, MATCH_SECONDS, REGEN_DELAY, REGEN_RATE, RESPAWN_SECONDS, SPEED } from "../config"
import { type Rect, raycast } from "../geom"
import { type MapDef, getMap } from "../maps"
import { Rng } from "../rng"
import { BotBrain } from "./bots"
import { stepBody } from "./move"

export type Phase = "play" | "end"

/** One tick of input. `fire` holds the trigger; automatic guns keep firing, the others need a fresh press. */
export type Intent = { mx: number; my: number; aim: number; fire: boolean; reload: boolean }
export const NO_INTENT: Intent = { mx: 0, my: 0, aim: 0, fire: false, reload: false }

export interface Brain {
  think(world: World, p: Player): Intent
}

export type Player = {
  id: string
  name: string
  human: boolean
  brain: Brain | null
  x: number
  y: number
  vx: number
  vy: number
  aim: number
  alive: boolean
  respawnAt: number
  cooldownUntil: number
  /** The gun you have now, and the one you picked for your next life. */
  gun: Gun
  pick: Gun
  triggerHeld: boolean
  health: number
  hurtAt: number
  mag: number
  reloadUntil: number
  queue: { seq: number; intent: Intent }[]
  ack: number
  kills: number
  deaths: number
}

export type SimEvent =
  | { k: "shot"; by: string; x0: number; y0: number; x1: number; y1: number; hit: string }
  | { k: "kill"; killer: string; victim: string; dx: number; dy: number }
  | { k: "reload"; by: string }
  | { k: "end"; winner: string }

const BOT_NAMES = ["kade", "rei", "mako", "juno", "lexx", "ryn", "zen", "lee", "nox", "ivo", "sable", "wren"]

/**
 * Free-for-all deathmatch on a procedural office floor. Everyone sees everyone. Four hits kill, health regenerates out
 * of combat, you respawn after a few seconds, and the most kills when the clock runs out wins. Then a new floor.
 */
export class World {
  map: MapDef
  /** Block movement: walls, windows, glass and solid furniture. */
  solids: Rect[] = []
  /** Block bullets: walls, windows and glass. */
  blockers: Rect[] = []
  readonly rng: Rng
  time = 0
  tick = 0
  phase: Phase = "play"
  phaseEnd = MATCH_SECONDS
  players = new Map<string, Player>()
  order: string[] = []
  events: SimEvent[] = []
  private botCount = 0

  constructor(
    seed: number,
    private fixed: MapDef | null = null,
  ) {
    this.rng = new Rng(seed)
    this.map = fixed ?? getMap(this.rng.int(2 ** 31))
    this.setMap(this.map)
  }

  private setMap(map: MapDef): void {
    this.map = map
    this.blockers = [...map.walls.map((w) => w.rect), ...map.windows, ...map.glass]
    this.solids = [...this.blockers, ...map.props.filter((p) => p.solid).map((p) => p.rect)]
  }

  get humans(): Player[] {
    return [...this.players.values()].filter((p) => p.human)
  }

  addHuman(id: string, name: string, gun: Gun = "rifle"): Player {
    const p = this.newPlayer(id, name, null)
    p.pick = gun
    this.players.set(id, p)
    this.order.push(id)
    this.spawn(p)
    this.fill()
    return p
  }

  /** Picks a gun. It's yours on your next spawn, or right away while you're dead or haven't fired since spawning. */
  pickGun(id: string, gun: Gun): void {
    const p = this.players.get(id)
    if (p) p.pick = gun
  }

  remove(id: string): void {
    this.players.delete(id)
    this.order = this.order.filter((x) => x !== id)
  }

  /** Keeps the room at FILL_TO players with bots, removing bots as humans join. */
  fill(): void {
    const bots = [...this.players.values()].filter((p) => !p.human)
    while (this.players.size > FILL_TO && bots.length) this.remove(bots.pop()!.id)
    while (this.players.size < FILL_TO) {
      const id = `bot${++this.botCount}`
      const p = this.newPlayer(id, BOT_NAMES[(this.botCount - 1) % BOT_NAMES.length]!, new BotBrain(this.rng.next() * 1e9))
      p.pick = this.rng.next() < 0.6 ? "rifle" : this.rng.pick(GUN_IDS)
      this.players.set(id, p)
      this.order.push(id)
      this.spawn(p)
    }
  }

  private newPlayer(id: string, name: string, brain: Brain | null): Player {
    return { id, name, human: !brain, brain, x: 0, y: 0, vx: 0, vy: 0, aim: 0, alive: false, respawnAt: 0, cooldownUntil: 0, gun: "rifle", pick: "rifle", triggerHeld: false, health: HEALTH, hurtAt: 0, mag: 0, reloadUntil: 0, queue: [], ack: 0, kills: 0, deaths: 0 }
  }

  /** Puts a player at the spawn farthest from everyone alive. */
  spawn(p: Player): void {
    const others = [...this.players.values()].filter((q) => q.alive && q.id !== p.id)
    let best = this.map.spawns[0]!
    let bd = -1
    for (const s of this.map.spawns) {
      const d = others.length ? Math.min(...others.map((q) => Math.hypot(q.x - s.x, q.y - s.y))) : this.rng.next()
      if (d > bd) {
        bd = d
        best = s
      }
    }
    p.x = best.x
    p.y = best.y
    p.vx = 0
    p.vy = 0
    p.alive = true
    p.health = HEALTH
    p.gun = p.pick
    p.mag = GUNS[p.gun].mag
    p.reloadUntil = 0
    p.cooldownUntil = this.time + 0.5
  }

  push(id: string, seq: number, intent: Intent): void {
    const p = this.players.get(id)
    if (!p || !p.human) return
    const last = p.queue.length ? p.queue[p.queue.length - 1]!.seq : p.ack
    if (seq <= last) return
    p.queue.push({ seq, intent })
    if (p.queue.length > 8) p.queue.splice(0, p.queue.length - 3)
  }

  takeEvents(): SimEvent[] {
    const out = this.events
    this.events = []
    return out
  }

  step(): void {
    this.time += DT
    this.tick++
    if (this.time >= this.phaseEnd) {
      if (this.phase === "play") this.endMatch()
      else this.newMatch()
    }
    for (const id of this.order) {
      const p = this.players.get(id)!
      let intent = NO_INTENT
      if (p.brain) {
        if (p.alive && this.phase === "play") intent = p.brain.think(this, p)
      } else {
        const q = p.queue.shift()
        if (q) {
          intent = q.intent
          p.ack = q.seq
        }
      }
      if (!p.alive) {
        if (this.phase === "play" && this.time >= p.respawnAt) this.spawn(p)
        continue
      }
      p.aim = intent.aim
      if (this.phase !== "play") {
        p.vx = 0
        p.vy = 0
        continue
      }
      stepBody(p, intent.mx, intent.my, SPEED, this.solids, DT)
      const gun = GUNS[p.gun]
      if (p.reloadUntil > 0 && this.time >= p.reloadUntil) {
        p.reloadUntil = 0
        p.mag = gun.mag
      }
      if ((intent.reload && p.mag < gun.mag) || (intent.fire && p.mag === 0)) this.reload(p)
      const pressed = intent.fire && (gun.auto || !p.triggerHeld)
      if (pressed && p.reloadUntil === 0 && p.mag > 0 && this.time >= p.cooldownUntil) this.fire(p)
      p.triggerHeld = intent.fire
      if (p.health < HEALTH && this.time - p.hurtAt >= REGEN_DELAY) p.health = Math.min(HEALTH, p.health + REGEN_RATE * DT)
    }
  }

  private reload(p: Player): void {
    if (p.reloadUntil > 0) return
    p.reloadUntil = this.time + GUNS[p.gun].reload
    this.events.push({ k: "reload", by: p.id })
  }

  private fire(p: Player): void {
    const gun = GUNS[p.gun]
    p.cooldownUntil = this.time + gun.cooldown
    p.mag--
    for (let k = 0; k < gun.pellets; k++) {
      const spread = gun.pellets > 1 ? ((k + 0.5) / gun.pellets - 0.5) * 2 * gun.spread + this.rng.range(-0.02, 0.02) : this.rng.range(-gun.spread, gun.spread)
      this.bullet(p, p.aim + spread)
      if (!p.alive) return
    }
  }

  /** One hitscan bullet: stops at the first wall or player. */
  private bullet(p: Player, aim: number): void {
    const gun = GUNS[p.gun]
    const dx = Math.cos(aim)
    const dy = Math.sin(aim)
    const wall = raycast(p.x, p.y, dx, dy, this.blockers, gun.range)
    let stop = Math.min(wall, gun.range)
    let victim: Player | null = null
    for (const q of this.players.values()) {
      if (!q.alive || q.id === p.id) continue
      const t = (q.x - p.x) * dx + (q.y - p.y) * dy
      const off = Math.abs(-(q.x - p.x) * dy + (q.y - p.y) * dx)
      if (t > 0 && t < stop && off <= HIT_RADIUS) {
        stop = t
        victim = q
      }
    }
    this.events.push({ k: "shot", by: p.id, x0: p.x, y0: p.y, x1: p.x + dx * stop, y1: p.y + dy * stop, hit: victim?.id ?? "" })
    if (!victim) return
    victim.health -= gun.damage
    victim.hurtAt = this.time
    if (victim.health <= 0) this.kill(victim, p)
  }

  kill(victim: Player, killer: Player): void {
    victim.alive = false
    victim.health = 0
    victim.deaths++
    victim.respawnAt = this.time + RESPAWN_SECONDS
    killer.kills++
    const d = Math.hypot(victim.x - killer.x, victim.y - killer.y) || 1
    this.events.push({ k: "kill", killer: killer.id, victim: victim.id, dx: (victim.x - killer.x) / d, dy: (victim.y - killer.y) / d })
  }

  private endMatch(): void {
    this.phase = "end"
    this.phaseEnd = this.time + END_SECONDS
    const ranked = [...this.players.values()].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
    this.events.push({ k: "end", winner: ranked[0]?.id ?? "" })
  }

  private newMatch(): void {
    if (!this.fixed) this.setMap(getMap(this.rng.int(2 ** 31)))
    this.phase = "play"
    this.phaseEnd = this.time + MATCH_SECONDS
    for (const p of this.players.values()) {
      p.kills = 0
      p.deaths = 0
      p.alive = false
    }
    for (const p of this.players.values()) this.spawn(p)
  }
}
