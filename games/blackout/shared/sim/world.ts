import { CLAYMORE, DT, END_SECONDS, EQUIP_LOCK, type Equip, FRAG, GUNS, GUN_IDS, type Gun, HEALTH, HIT_RADIUS, REGEN_DELAY, REGEN_RATE, RESPAWN_SECONDS, SPRINT_TO_FIRE, type Weapon } from "../config"
import { type Rect, angleDiff, clearLine, raycast } from "../geom"
import { type MapDef, getMap } from "../maps"
import { Rng } from "../rng"
import { BotBrain } from "./bots"
import { type Claymore, type Grenade, type Obstacles, launch, obstaclesOf, overlaps, stepGrenade } from "./gear"
import { type Mode, type ModeId, createMode, modeOf, tally, voteOptions } from "./modes"
import "./modes-objective"
import { stepBody } from "./move"
import { nextHost } from "./host"
import "./modes-rules"
import { type Kit, gunKit, kitSprints } from "./kit"
import { canSwing, startSwing, stepSwing } from "./melee"
import type { VehicleKind } from "./vehicle"
import { type Vehicle, armorOf, blastVehicles, damageVehicle, leaveSeat, pushOutVehicles, rayVehicles, resetVehicles, rideIntent, stepVehicles, toggleSeat } from "./vehicle-rules"

export type Phase = "play" | "end"

/**
 * One tick of input. `fire` holds the trigger; automatic guns keep firing, the others need a fresh press. `sprint`
 * holds Shift. `equip` is a press that throws or plants your equipment; (tx, ty) is the cursor on the floor, how far
 * to throw. `use` holds the plant/defuse key in search and destroy. `melee` is a press of the melee key (V), when the
 * kit has one; bare-handed, the trigger swings too. `enter` is a press of F that gets in or out of a vehicle; driving,
 * (mx, my) are the throttle and steering and `sprint` the handbrake; `horn` holds H.
 */
export type Intent = { mx: number; my: number; aim: number; fire: boolean; reload: boolean; sprint: boolean; equip: boolean; tx: number; ty: number; use: boolean; melee?: boolean; enter?: boolean; horn?: boolean }
export const NO_INTENT: Intent = { mx: 0, my: 0, aim: 0, fire: false, reload: false, sprint: false, equip: false, tx: 0, ty: 0, use: false }

/** Sprinting needs Shift and movement; pulling the trigger cancels it. Shared by the server and client prediction. */
export const sprints = (i: Intent): boolean => i.sprint && !i.fire && Math.hypot(i.mx, i.my) > 0.1

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
  /** No shots before this: the gun is coming up from a sprint. */
  readyAt: number
  /** The gun you have now, and the one you picked for your next life. */
  gun: Gun
  pick: Gun
  /** Equipment this life, how many are left, and the pick for the next life. */
  equip: Equip
  equipLeft: number
  equipPick: Equip
  triggerHeld: boolean
  health: number
  hurtAt: number
  mag: number
  reloadUntil: number
  queue: { seq: number; intent: Intent }[]
  ack: number
  kills: number
  deaths: number
  /** 0 orange, 1 cyan, -1 none (free for all). */
  team: number
  /** Holding the plant/defuse key this tick. */
  using: boolean
  caps: number
  plants: number
  defuses: number
  /** Per-mode scoreboard counts (confirms, denies, captures...), cleared every match. */
  stats: Record<string, number>
  /** The team the room host put you on (shared/sim/host.ts), kept across matches; -1 for auto-balance. */
  hostTeam: number
  /** What the mode armed you with this life (shared/sim/kit.ts). */
  kit: Kit
  /** A melee swing lands at this time (0 for none); the next can start at meleeReadyAt. */
  swingAt: number
  meleeReadyAt: number
  /** The vehicle you're in (0 for none) and your seat in it; seat 0 drives (shared/sim/vehicle-rules.ts). */
  veh: number
  seat: number
}

export type SimEvent =
  | { k: "shot"; by: string; x0: number; y0: number; x1: number; y1: number; hit: string; veh?: number }
  | { k: "kill"; killer: string; victim: string; dx: number; dy: number; how: Weapon }
  | { k: "throw"; by: string; id: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; fuse: number }
  | { k: "plant"; by: string; id: number; x: number; y: number; aim: number }
  | { k: "bounce"; id: number; x: number; y: number; v: number }
  | { k: "beep"; id: number; x: number; y: number }
  | { k: "explode"; kind: Equip; by: string; id: number; x: number; y: number; aim: number }
  | { k: "reload"; by: string }
  | { k: "end"; winner: string; team: number }
  | { k: "cap"; team: number; point: string }
  | { k: "bomb"; what: "plant" | "defuse" | "explode"; by: string; x: number; y: number }
  | { k: "round"; team: number; why: string }
  | { k: "swing"; by: string }
  | { k: "obj"; what: string; team: number; by: string; x: number; y: number }
  /** The room host restarted the match, in the same mode or a new one (shared/sim/host.ts). */
  | { k: "host"; what: "reset" | "mode"; mode: ModeId }
  /** Someone got in or out of a vehicle; a vehicle blew up; a vehicle hit something at `v` m/s. */
  | { k: "veh"; what: "enter" | "exit"; id: number; by: string; seat: number }
  | { k: "wreck"; id: number; by: string; x: number; y: number; h: number; kind: VehicleKind }
  | { k: "crash"; id: number; x: number; y: number; v: number }

const BOT_NAMES = ["kade", "rei", "mako", "juno", "lexx", "ryn", "zen", "lee", "nox", "ivo", "sable", "wren"]

/**
 * A match on a procedural office floor. Everyone sees everyone. Four hits kill, health regenerates out of combat, and
 * you respawn after a few seconds. The mode (shared/sim/modes.ts) sets teams, spawns, objectives and who wins. Then
 * everyone votes on the next mode and it's a new floor.
 */
export class World {
  map: MapDef
  /** Block movement: walls, windows, glass and solid furniture. */
  solids: Rect[] = []
  /** Block bullets: walls, windows and glass. */
  blockers: Rect[] = []
  /** What frags bounce off, with heights. */
  obstacles: Obstacles = { rects: [], h: [] }
  readonly rng: Rng
  time = 0
  tick = 0
  phase: Phase = "play"
  phaseEnd = 0
  mode: Mode
  /** End-screen votes for the next mode, by player. */
  votes = new Map<string, ModeId>()
  /** The modes the end screen offers, the current one first. */
  voteOptions: ModeId[] = []
  players = new Map<string, Player>()
  order: string[] = []
  events: SimEvent[] = []
  grenades: Grenade[] = []
  claymores: Claymore[] = []
  /** Drivable vehicles, from the map's spawns (shared/sim/vehicle-rules.ts). */
  vehicles: Vehicle[] = []
  private gearId = 0
  private botCount = 0
  /** Players to top the room up to with bots. 0 online; local practice and tests set it. */
  botFill = 0
  /** The room host: the first human in, then the longest-connected one. They can pick teams (shared/sim/host.ts). */
  host = ""
  /** When the host last reset or switched the match (world time), for the rate limit in shared/sim/host.ts. */
  hostActAt = -Infinity
  /** Counts matches, so a restart on the same floor in the same mode still reads as a new match. */
  match = 0

  constructor(
    seed: number,
    private fixed: MapDef | null = null,
    mode: ModeId = "ffa",
  ) {
    this.rng = new Rng(seed)
    this.map = fixed ?? getMap(this.rng.int(2 ** 31))
    this.setMap(this.map)
    this.mode = createMode(mode)
    this.phaseEnd = this.mode.seconds
    this.mode.start(this)
  }

  /** Switches mode and restarts the match on the same floor: the room creator's pick, before anyone else is in. */
  setMode(id: ModeId): void {
    this.mode = createMode(id)
    this.phase = "play"
    this.phaseEnd = this.time + this.mode.seconds
    this.resetPlayers()
    this.mode.start(this)
  }

  /** Same team, or the same player, in a team mode. */
  allies(a: Player, b: Player): boolean {
    return this.mode.teams && a.team >= 0 && a.team === b.team
  }

  /** A vote for the next mode, during the end screen. */
  vote(id: string, mode: ModeId): void {
    if (this.phase === "end" && this.players.has(id) && modeOf(mode) && this.voteOptions.includes(mode)) this.votes.set(id, mode)
  }

  private setMap(map: MapDef): void {
    this.map = map
    this.blockers = [...map.walls.map((w) => w.rect), ...map.windows, ...map.glass]
    this.solids = [...this.blockers, ...map.props.filter((p) => p.solid).map((p) => p.rect)]
    this.obstacles = obstaclesOf(map)
    resetVehicles(this)
  }

  get humans(): Player[] {
    return [...this.players.values()].filter((p) => p.human)
  }

  addHuman(id: string, name: string, gun: Gun = "rifle", equip: Equip = "frag"): Player {
    const p = this.newPlayer(id, name, null)
    p.pick = gun
    p.equipPick = equip
    this.players.set(id, p)
    this.order.push(id)
    this.host ||= id
    if (this.mode.join(this, p)) this.spawn(p)
    this.fill()
    return p
  }

  /** Picks a gun. It's yours on your next spawn, or right away while you're dead or haven't fired since spawning. */
  pickGun(id: string, gun: Gun): void {
    const p = this.players.get(id)
    if (p) p.pick = gun
  }

  /** Picks the equipment for your next life. */
  pickEquip(id: string, equip: Equip): void {
    const p = this.players.get(id)
    if (p) p.equipPick = equip
  }

  remove(id: string): void {
    const p = this.players.get(id)
    if (p) this.mode.leave(this, p)
    if (p) leaveSeat(this, p)
    this.votes.delete(id)
    this.grenades = this.grenades.filter((g) => g.by !== id)
    this.claymores = this.claymores.filter((c) => c.by !== id)
    this.players.delete(id)
    this.order = this.order.filter((x) => x !== id)
    if (this.host === id) this.host = nextHost(this)
  }

  /** Keeps the room at `to` players with bots, removing bots as humans join. Online rooms use 0: humans only. */
  fill(to = this.botFill): void {
    const bots = [...this.players.values()].filter((p) => !p.human)
    while (this.players.size > to && bots.length) this.remove(bots.pop()!.id)
    while (this.players.size < to) {
      const id = `bot${++this.botCount}`
      const p = this.newPlayer(id, BOT_NAMES[(this.botCount - 1) % BOT_NAMES.length]!, new BotBrain(this.rng.next() * 1e9))
      p.pick = this.rng.next() < 0.6 ? "rifle" : this.rng.pick(GUN_IDS)
      this.players.set(id, p)
      this.order.push(id)
      if (this.mode.join(this, p)) this.spawn(p)
    }
  }

  private newPlayer(id: string, name: string, brain: Brain | null): Player {
    return { id, name, human: !brain, brain, x: 0, y: 0, vx: 0, vy: 0, aim: 0, alive: false, respawnAt: 0, cooldownUntil: 0, readyAt: 0, gun: "rifle", pick: "rifle", equip: "frag", equipLeft: 0, equipPick: "frag", triggerHeld: false, health: HEALTH, hurtAt: 0, mag: 0, reloadUntil: 0, queue: [], ack: 0, kills: 0, deaths: 0, team: -1, hostTeam: -1, using: false, caps: 0, plants: 0, defuses: 0, stats: {}, kit: gunKit("rifle"), swingAt: 0, meleeReadyAt: 0, veh: 0, seat: 0 }
  }

  /** Puts a player where the mode says, else at the spawn farthest from everyone alive. */
  spawn(p: Player): void {
    leaveSeat(this, p)
    const others = [...this.players.values()].filter((q) => q.alive && q.id !== p.id)
    const at = this.mode.spawnAt(this, p)
    let best = at ?? this.map.spawns[0]!
    let bd = -1
    for (const s of at ? [] : this.map.spawns) {
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
    const kit = this.mode.loadout(this, p)
    this.arm(p, kit)
    p.equip = kit.equip ?? p.equipPick
    p.equipLeft = kit.equip ? kit.equipCount : 0
    p.cooldownUntil = this.time + 0.5
    p.readyAt = 0
  }

  /** Hands a player a kit: its gun, a full magazine, no reload or swing in progress. Modes call it to re-arm mid-life. */
  arm(p: Player, kit: Kit): void {
    p.kit = kit
    if (kit.gun) p.gun = kit.gun
    p.mag = kit.mag
    p.reloadUntil = 0
    p.swingAt = 0
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
      let fresh = false
      if (p.brain) {
        if (p.alive && this.phase === "play") intent = p.brain.think(this, p)
        fresh = true
      } else {
        const q = p.queue.shift()
        if (q) {
          intent = q.intent
          p.ack = q.seq
          fresh = true
        }
      }
      if (!p.alive) {
        p.using = false
        if (this.phase === "play" && this.time >= p.respawnAt) this.spawn(p)
        continue
      }
      if (this.phase === "play") intent = this.mode.intent(this, p, intent)
      if (this.phase === "play" && intent.enter) toggleSeat(this, p)
      if (p.veh) intent = rideIntent(this, p, intent, fresh)
      p.using = intent.use
      p.aim = intent.aim
      if (this.phase !== "play") {
        p.vx = 0
        p.vy = 0
        continue
      }
      const kit = p.kit
      const sprint = kitSprints(intent, kit)
      if (!p.veh) {
        stepBody(p, intent.mx, intent.my, sprint ? kit.run : kit.walk, this.solids, DT)
        pushOutVehicles(this, p)
      }
      if (sprint && kit.gun) p.readyAt = this.time + SPRINT_TO_FIRE
      if (p.reloadUntil > 0 && this.time >= p.reloadUntil) {
        p.reloadUntil = 0
        p.mag = kit.mag
      }
      if (kit.gun && kit.reload && ((intent.reload && p.mag < kit.mag) || (intent.fire && p.mag === 0))) this.reload(p)
      if (intent.equip && p.equipLeft > 0) this.useEquip(p, intent)
      // Bare hands swing while the trigger is held; anyone with a melee kit swings with V.
      if ((intent.melee || (!kit.gun && intent.fire)) && canSwing(p, this.time)) startSwing(this, p)
      stepSwing(this, p)
      // A press during the sprint-to-fire delay is held over until the gun is up.
      const ready = this.time >= p.readyAt
      const pressed = !!kit.gun && intent.fire && ready && (kit.auto || !p.triggerHeld)
      if (pressed && p.reloadUntil === 0 && p.swingAt === 0 && p.mag > 0 && this.time >= p.cooldownUntil) this.fire(p)
      if (ready || !intent.fire) p.triggerHeld = intent.fire
      if (kit.regen && p.health < HEALTH && this.time - p.hurtAt >= REGEN_DELAY) p.health = Math.min(HEALTH, p.health + REGEN_RATE * DT)
    }
    if (this.phase === "play") stepVehicles(this)
    if (this.phase === "play") this.stepGear()
    if (this.phase === "play") this.mode.step(this)
  }

  /** Throws the frag toward the cursor, or plants the claymore just ahead facing the aim. */
  private useEquip(p: Player, intent: Intent): void {
    p.equipLeft--
    p.cooldownUntil = Math.max(p.cooldownUntil, this.time + EQUIP_LOCK)
    const id = ++this.gearId
    if (p.equip === "frag") {
      const l = launch(p.x, p.y, p.aim, Math.hypot(intent.tx - p.x, intent.ty - p.y))
      this.grenades.push({ id, by: p.id, ...l, at: this.time + FRAG.fuse })
      this.events.push({ k: "throw", by: p.id, id, ...l, fuse: FRAG.fuse })
      return
    }
    // One claymore each: a new one replaces the last.
    this.claymores = this.claymores.filter((c) => c.by !== p.id)
    let x = p.x + Math.cos(p.aim) * 0.45
    let y = p.y + Math.sin(p.aim) * 0.45
    if (!clearLine(p.x, p.y, x, y, this.solids) || overlaps(x, y, 0.15, this.solids)) {
      x = p.x
      y = p.y
    }
    this.claymores.push({ id, by: p.id, x, y, aim: p.aim, armAt: this.time + CLAYMORE.arm, blowAt: 0 })
    this.events.push({ k: "plant", by: p.id, id, x, y, aim: p.aim })
  }

  /** Grenades fly and blow; armed claymores watch their cone, beep when tripped and blow a moment later. */
  private stepGear(): void {
    for (const g of [...this.grenades]) {
      const v = stepGrenade(g, this.obstacles)
      if (v > 2) this.events.push({ k: "bounce", id: g.id, x: g.x, y: g.y, v })
      if (this.time >= g.at) this.frag(g)
    }
    for (const c of [...this.claymores]) {
      if (!this.claymores.includes(c)) continue
      if (c.blowAt > 0) {
        if (this.time >= c.blowAt) this.claymore(c, c.by)
        continue
      }
      if (this.time < c.armAt) continue
      const owner = this.players.get(c.by)
      for (const q of this.players.values()) {
        if (!q.alive || q.id === c.by || (owner && this.allies(owner, q))) continue
        const d = Math.hypot(q.x - c.x, q.y - c.y)
        if (d > CLAYMORE.range || Math.abs(angleDiff(Math.atan2(q.y - c.y, q.x - c.x), c.aim)) > CLAYMORE.cone) continue
        if (!clearLine(c.x, c.y, q.x, q.y, this.blockers)) continue
        c.blowAt = this.time + CLAYMORE.delay
        this.events.push({ k: "beep", id: c.id, x: c.x, y: c.y })
        break
      }
    }
  }

  /** A frag goes off: lethal close in, falling off with distance, stopped by walls. It sets off claymores too. */
  private frag(g: Grenade): void {
    this.grenades = this.grenades.filter((o) => o !== g)
    this.events.push({ k: "explode", kind: "frag", by: g.by, id: g.id, x: g.x, y: g.y, aim: 0 })
    const owner = this.players.get(g.by)
    if (!owner) return
    for (const q of this.players.values()) {
      if (!q.alive) continue
      const d = Math.hypot(q.x - g.x, q.y - g.y)
      if (d > FRAG.radius || !clearLine(g.x, g.y, q.x, q.y, this.blockers)) continue
      const u = Math.max(0, (d - FRAG.kill) / (FRAG.radius - FRAG.kill))
      this.damage(q, (d <= FRAG.kill ? HEALTH * 2 : FRAG.edge + (HEALTH - 5 - FRAG.edge) * (1 - u)) * armorOf(this, q), owner, "frag", g.x, g.y)
    }
    blastVehicles(this, g.x, g.y, FRAG.radius, 300, owner, "frag")
    for (const c of [...this.claymores]) {
      if (this.claymores.includes(c) && Math.hypot(c.x - g.x, c.y - g.y) <= FRAG.radius && clearLine(g.x, g.y, c.x, c.y, this.blockers)) this.claymore(c, g.by)
    }
  }

  /** A claymore blows: lethal in its cone, and hurts anyone right on top of it. `by` gets the kills. */
  private claymore(c: Claymore, by: string): void {
    this.claymores = this.claymores.filter((o) => o !== c)
    this.events.push({ k: "explode", kind: "claymore", by, id: c.id, x: c.x, y: c.y, aim: c.aim })
    const owner = this.players.get(by) ?? this.players.get(c.by)
    if (!owner) return
    for (const q of this.players.values()) {
      if (!q.alive) continue
      const d = Math.hypot(q.x - c.x, q.y - c.y)
      const inCone = d <= CLAYMORE.blast && Math.abs(angleDiff(Math.atan2(q.y - c.y, q.x - c.x), c.aim)) <= CLAYMORE.blastCone
      const dmg = inCone ? HEALTH * 2 : d <= CLAYMORE.near ? 20 + 60 * (1 - d / CLAYMORE.near) : 0
      if (dmg > 0 && clearLine(c.x, c.y, q.x, q.y, this.blockers)) this.damage(q, dmg * armorOf(this, q), owner, "claymore", c.x, c.y)
    }
    blastVehicles(this, c.x + Math.cos(c.aim) * 1.2, c.y + Math.sin(c.aim) * 1.2, CLAYMORE.blast * 0.6, 250, owner, "claymore")
  }

  /** No friendly fire in team modes; your own frag still hurts you. */
  damage(q: Player, dmg: number, by: Player, how: Weapon, fx: number, fy: number): void {
    if (q !== by && this.allies(q, by)) return
    q.health -= dmg
    q.hurtAt = this.time
    if (q.health <= 0) this.kill(q, by, how, fx, fy)
  }

  private reload(p: Player): void {
    if (p.reloadUntil > 0) return
    p.reloadUntil = this.time + GUNS[p.gun].reload
    this.events.push({ k: "reload", by: p.id })
  }

  private fire(p: Player): void {
    const gun = GUNS[p.gun]
    p.cooldownUntil = this.time + p.kit.cooldown
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
    let stop = Math.min(raycast(p.x, p.y, dx, dy, this.blockers, gun.range), gun.range)
    let nearest = gun.range
    let victim: Player | null = null
    for (const q of this.players.values()) {
      // Rounds pass through teammates, and whoever rides with you.
      if (!q.alive || q.id === p.id || this.allies(p, q) || (p.veh && q.veh === p.veh)) continue
      const t = (q.x - p.x) * dx + (q.y - p.y) * dy
      const off = Math.abs(-(q.x - p.x) * dy + (q.y - p.y) * dx)
      if (t > 0 && t < nearest && t < stop && off <= HIT_RADIUS) {
        nearest = t
        victim = q
      }
    }
    // A vehicle in the way takes the round, unless it's aimed at someone riding in it and passes close enough to them.
    const car = rayVehicles(this, p, p.x, p.y, dx, dy, stop)
    let struck: Vehicle | null = null
    if (car && !(victim && (nearest < car.t || (victim.veh === car.v.id && nearest <= car.out)))) {
      struck = car.v
      stop = car.t
      victim = null
    }
    if (victim) stop = nearest
    // Someone else's claymore in the line of fire takes the round and blows.
    let mine: Claymore | null = null
    for (const c of this.claymores) {
      const owner = this.players.get(c.by)
      if (c.by === p.id || (owner && this.allies(owner, p))) continue
      const t = (c.x - p.x) * dx + (c.y - p.y) * dy
      const off = Math.abs(-(c.x - p.x) * dy + (c.y - p.y) * dx)
      if (t > 0.5 && t < stop && off <= CLAYMORE.shot) {
        stop = t
        victim = null
        struck = null
        mine = c
      }
    }
    this.events.push({ k: "shot", by: p.id, x0: p.x, y0: p.y, x1: p.x + dx * stop, y1: p.y + dy * stop, hit: victim?.id ?? "", ...(struck ? { veh: struck.id } : {}) })
    if (mine) this.claymore(mine, p.id)
    if (struck) damageVehicle(this, struck, p.kit.damage, p, p.gun)
    if (victim) this.damage(victim, p.kit.damage * armorOf(this, victim), p, p.gun, p.x, p.y)
  }

  /** `how` and the blast point (fx, fy) default to the killer's gun and position. Killing yourself or a teammate scores nothing. */
  kill(victim: Player, killer: Player, how: Weapon = killer.gun, fx = killer.x, fy = killer.y): void {
    victim.alive = false
    victim.health = 0
    victim.deaths++
    victim.respawnAt = this.time + RESPAWN_SECONDS
    victim.swingAt = 0
    leaveSeat(this, victim)
    if (killer !== victim && !this.allies(killer, victim)) killer.kills++
    const d = Math.hypot(victim.x - fx, victim.y - fy) || 1
    this.events.push({ k: "kill", killer: killer.id, victim: victim.id, dx: (victim.x - fx) / d, dy: (victim.y - fy) / d, how })
    this.mode.killed(this, victim, killer, how)
  }

  /** The match is over: the end screen and the vote for the next mode. */
  endMatch(): void {
    if (this.phase === "end") return
    this.phase = "end"
    this.phaseEnd = this.time + END_SECONDS
    this.grenades = []
    this.claymores = []
    this.votes.clear()
    this.voteOptions = voteOptions(this.mode.id, this.rng)
    const r = this.mode.result(this)
    this.events.push({ k: "end", winner: r.winner, team: r.team })
  }

  private resetPlayers(): void {
    for (const p of this.players.values()) {
      p.kills = 0
      p.deaths = 0
      p.caps = 0
      p.plants = 0
      p.defuses = 0
      p.stats = {}
      p.alive = false
      p.respawnAt = 0
    }
  }

  /** A new floor in the mode that won the vote. */
  private newMatch(): void {
    if (!this.fixed) this.setMap(getMap(this.rng.int(2 ** 31)))
    const next = tally(this.votes.values(), this.mode.id, this.rng, this.voteOptions)
    if (next !== this.mode.id) this.mode = createMode(next)
    this.begin()
  }

  /**
   * Starts a fresh match in `id` right away, from play or the end screen: a new floor unless `newFloor` is false,
   * scores and objectives reset, gear cleared, everyone respawns. Host-picked teams stand.
   */
  restart(id: ModeId, newFloor = true): void {
    if (newFloor && !this.fixed) this.setMap(getMap(this.rng.int(2 ** 31)))
    this.grenades = []
    this.claymores = []
    this.mode = createMode(id)
    this.begin()
  }

  private begin(): void {
    this.votes.clear()
    this.voteOptions = []
    this.match++
    resetVehicles(this)
    this.phase = "play"
    this.phaseEnd = this.time + this.mode.seconds
    this.resetPlayers()
    this.mode.start(this)
  }
}
