// Authoritative match state machine. Runs inside the Room Durable Object and in the
// browser for solo play. All game rules live here and in the sim modules.
//
// Crates: spawned at the start of an aim phase at a random surface x with
// landed=false (clients animate a parachute descent during the aim phase). They can be
// shot during the following volley; the sim then settles survivors on the terrain and
// flips landed=true.
import { clampAngle, clampPower } from "./ballistics"
import { botReposition, botShop, planBot, type BotPlan } from "./bot"
import { CLASSES, CLASS_IDS, classOf, passiveOf } from "./classes"
import { moveUnit } from "./move"
import { rng, type Rand } from "./rng"
import { applyPurchase, newLoadout, type Loadout } from "./shop"
import { WORLD_H, WORLD_W, footGround, generateBattle, nextWind, packMask, spawnY, type Mask } from "./terrain"
import { runVolley } from "./volley"
import { WEAPONS, type WeaponId } from "./weapons"
import type { ClassId, ClientMsg, Crate, Ghost, MatchView, Mode, Phase, PlayerView, PowerupId, ServerMsg, Shot, Unit } from "./protocol"

export const AIM_MS = 8000
export const FIRST_AIM_MS = 10000
export const RESOLVE_PAD_MS = 1600
export const SHOP_MS = 20000
export const OVER_MS = 12000
export const GHOST_THROTTLE_MS = 100
export const MAX_UNITS = 12
export const SUDDEN_DEATH_VOLLEY = 6
export const HAZARD_RISE = 36
export const MAX_VOLLEYS = 30
export const CREDITS = { kill: 150, survive: 100, win: 250, crate: 150 }

const TEAM_NAMES = ["CYAN", "ORANGE"]
const BOT_NAMES = ["VEX", "HALCYON", "MORTIS", "BRISK", "KESTREL", "ONYX", "RIVET", "SABLE", "TALON", "QUILL", "EMBER", "NOVA", "GRIT", "AXLE", "CINDER", "WREN"]
const CRATE_KINDS: Array<[PowerupId, number]> = [
  ["credits", 3],
  ["weapon", 3],
  ["shield", 2],
  ["repair", 2],
  ["boost", 1],
  ["preview", 1],
  ["fuel", 1],
]

interface Player {
  id: string
  name: string
  cls: ClassId
  level: number
  bot: boolean
  connected: boolean
  host: boolean
  slot: number
  team: number
  unit: number
  locked: boolean
  spectator: boolean
  ready: boolean
  score: number
  damage: number
  kills: number
  wins: number
  loadout: Loadout
  aim: { angle: number; power: number; weapon: WeaponId }
  skill: number
  aimAt: number
  lockAt: number
  plan: BotPlan | null
}

function mix(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  return h >>> 0
}

function copyUnit(u: Unit): Unit {
  return { ...u, ammo: { ...u.ammo } }
}

export class Match {
  readonly room: string
  readonly seed: number
  private rand: Rand
  private players: Player[] = []
  private out: Array<{ to: string | null; msg: ServerMsg }> = []
  private phase: Phase = "lobby"
  private phaseEndsAt = 0
  private mode: Mode = "ffa"
  private battle = 0
  private battles = 3
  private volley = 0
  private matchNo = 0
  private battleSeed = 0
  private wind = 0
  private hazardY = WORLD_H
  private mask: Mask
  private units: Unit[] = []
  private crates: Crate[] = []
  private battleWinner: string | null = null
  private matchWinner: string | null = null
  private nextSlot = 0
  private nextCrate = 1
  private botCount = 0
  private ghostsDirty = false
  private stateDirty = false
  private lastGhosts = -Infinity
  private lastState = -Infinity

  constructor(room: string, seed: number) {
    this.room = room
    this.seed = seed >>> 0
    this.rand = rng(this.seed ^ 0x6a09e667)
    this.mask = generateBattle(this.seed, 4).mask
  }

  get empty(): boolean {
    return !this.players.some((p) => !p.bot && p.connected)
  }

  drain(): Array<{ to: string | null; msg: ServerMsg }> {
    const out = this.out
    this.out = []
    return out
  }

  // -------------------------------------------------------------------------
  // connections

  join(id: string, name: string, cls: ClassId, level: number, now: number): void {
    const existing = this.players.find((p) => p.id === id)
    if (existing) {
      existing.connected = true
      existing.name = this.cleanName(name, existing.name)
      if (this.phase === "lobby" || this.phase === "shop" || this.phase === "over") existing.cls = this.cleanClass(cls, level)
      existing.level = level
    } else {
      const p: Player = {
        id,
        name: this.cleanName(name, `PILOT ${this.nextSlot + 1}`),
        cls: this.cleanClass(cls, level),
        level,
        bot: false,
        connected: true,
        host: false,
        slot: this.nextSlot++,
        team: 0,
        unit: -1,
        locked: false,
        spectator: this.phase === "aim" || this.phase === "resolve",
        ready: false,
        score: 0,
        damage: 0,
        kills: 0,
        wins: 0,
        loadout: newLoadout(),
        aim: { angle: Math.PI / 4, power: 55, weapon: "shell" },
        skill: 0,
        aimAt: 0,
        lockAt: 0,
        plan: null,
      }
      if (this.phase !== "lobby" && this.mode === "teams") p.team = this.smallerTeam()
      this.players.push(p)
      this.notice(`${p.name} joined`)
    }
    this.fixHost()
    this.out.push({ to: id, msg: { type: "welcome", you: id, view: this.view(true, now) } })
    this.broadcastState(now, false)
  }

  leave(id: string, now: number): void {
    const p = this.players.find((q) => q.id === id)
    if (!p) return
    if (this.phase === "lobby" || this.phase === "over") this.players = this.players.filter((q) => q !== p)
    else p.connected = false
    p.host = false
    this.notice(`${p.name} left`)
    this.fixHost()
    this.broadcastState(now, false)
  }

  handle(id: string, msg: ClientMsg, now: number): void {
    const p = this.players.find((q) => q.id === id)
    if (msg.type === "ping") {
      this.out.push({ to: id, msg: { type: "pong", t: msg.t, now } })
      return
    }
    if (msg.type === "join") {
      this.join(id, msg.name, msg.cls, msg.level, now)
      return
    }
    if (!p) return
    switch (msg.type) {
      case "start": {
        if (!p.host || this.phase !== "lobby") return
        this.startMatch(msg.mode === "teams" ? "teams" : "ffa", msg.bots, msg.battles, now)
        break
      }
      case "class": {
        if (!CLASSES[msg.cls]) return
        if (this.phase === "aim" || this.phase === "resolve") {
          this.error(id, "Class changes apply between battles")
          return
        }
        p.cls = this.cleanClass(msg.cls, p.level)
        this.stateDirty = true
        break
      }
      case "aim": {
        if (this.phase !== "aim" || p.locked) return
        const u = this.unitOf(p)
        if (!u || !u.alive) return
        const weapon: WeaponId = WEAPONS[msg.weapon] && (msg.weapon === "shell" || (u.ammo[msg.weapon] ?? 0) > 0) ? msg.weapon : "shell"
        p.aim = { angle: clampAngle(msg.angle), power: clampPower(msg.power), weapon }
        u.angle = p.aim.angle
        this.ghostsDirty = true
        break
      }
      case "move": {
        if (this.phase !== "aim" || p.locked) return
        const u = this.unitOf(p)
        if (!u || !u.alive) return
        if (moveUnit(this.mask, u, msg.dir === -1 ? -1 : 1)) this.stateDirty = true
        break
      }
      case "lock": {
        if (this.phase !== "aim") return
        const u = this.unitOf(p)
        if (!u || !u.alive || p.locked) return
        p.locked = true
        this.ghostsDirty = true
        this.stateDirty = true
        break
      }
      case "buy": {
        if (this.phase !== "shop") {
          this.error(id, "The armory is closed")
          return
        }
        const err = applyPurchase(p.loadout, msg.item)
        if (err) this.error(id, err)
        else this.stateDirty = true
        break
      }
      case "ready": {
        if (this.phase !== "shop") return
        p.ready = true
        this.stateDirty = true
        break
      }
    }
    this.flush(now)
  }

  tick(now: number): void {
    switch (this.phase) {
      case "aim":
        this.tickBots(now)
        if (this.aimDone(now)) this.resolve(now)
        break
      case "resolve":
        if (now >= this.phaseEndsAt) this.afterResolve(now)
        break
      case "shop": {
        const humans = this.players.filter((p) => !p.bot && p.connected)
        if (now >= this.phaseEndsAt || (humans.length > 0 && humans.every((p) => p.ready))) this.startBattle(now)
        break
      }
      case "over":
        if (now >= this.phaseEndsAt) this.toLobby(now)
        break
      case "lobby":
        break
    }
    this.flush(now)
  }

  // -------------------------------------------------------------------------
  // views

  view(withMask: boolean, now: number): MatchView {
    const players: PlayerView[] = this.players
      .slice()
      .sort((a, b) => a.slot - b.slot)
      .map((p) => ({
        id: p.id,
        name: p.name,
        team: p.team,
        unit: p.unit,
        bot: p.bot,
        connected: p.connected,
        locked: p.locked,
        spectator: p.spectator,
        credits: p.loadout.credits,
        score: p.score,
        damage: p.damage,
        kills: p.kills,
        wins: p.wins,
        cls: p.cls,
        level: p.level,
        host: p.host,
      }))
    const v: MatchView = {
      room: this.room,
      mode: this.mode,
      phase: this.phase,
      phaseEndsAt: this.phaseEndsAt,
      now,
      battle: this.battle,
      battles: this.battles,
      volley: this.volley,
      seed: this.battleSeed,
      wind: this.wind,
      hazardY: this.hazardY,
      units: this.units.map(copyUnit),
      players,
      crates: this.crates.map((c) => ({ ...c })),
      ghosts: this.ghosts(),
      battleWinner: this.battleWinner,
      matchWinner: this.matchWinner,
    }
    if (withMask) v.mask = packMask(this.mask)
    return v
  }

  private ghosts(): Ghost[] {
    const out: Ghost[] = []
    for (const p of this.players) {
      const u = this.unitOf(p)
      if (!u || !u.alive) continue
      out.push({ unit: u.id, angle: p.aim.angle, power: p.aim.power, locked: p.locked })
    }
    return out.sort((a, b) => a.unit - b.unit)
  }

  // -------------------------------------------------------------------------
  // flow

  private startMatch(mode: Mode, bots: number, battles: number, now: number): void {
    this.mode = mode
    this.matchNo++
    this.battles = Math.max(1, Math.min(9, Math.floor(battles) || 3))
    this.players = this.players.filter((p) => !p.bot && p.connected)
    for (const p of this.players) {
      p.score = 0
      p.damage = 0
      p.kills = 0
      p.wins = 0
      p.loadout = newLoadout()
      p.spectator = false
      p.ready = false
    }
    const humans = Math.min(MAX_UNITS, this.players.length)
    const want = Math.max(2 - humans, Math.min(MAX_UNITS - humans, Math.floor(bots) || 0))
    for (let i = 0; i < want; i++) this.addBot()
    if (mode === "teams") {
      const counts = [0, 0]
      for (const p of this.players.slice().sort((a, b) => Number(a.bot) - Number(b.bot) || a.slot - b.slot)) {
        p.team = counts[0]! <= counts[1]! ? 0 : 1
        counts[p.team]!++
      }
    }
    this.battle = 0
    this.battleWinner = null
    this.matchWinner = null
    this.startBattle(now)
  }

  private addBot(): void {
    const r = this.rand
    const used = new Set(this.players.map((p) => p.name))
    let name = BOT_NAMES[Math.floor(r() * BOT_NAMES.length)]!
    for (let k = 0; used.has(name) && k < 40; k++) name = BOT_NAMES[Math.floor(r() * BOT_NAMES.length)]!
    if (used.has(name)) name = `${name}-${++this.botCount}`
    const cls = CLASS_IDS[Math.floor(r() * CLASS_IDS.length)]!
    this.players.push({
      id: `bot:${this.matchNo}:${++this.botCount}`,
      name,
      cls,
      level: 1 + Math.floor(r() * 10),
      bot: true,
      connected: true,
      host: false,
      slot: this.nextSlot++,
      team: 0,
      unit: -1,
      locked: false,
      spectator: false,
      ready: true,
      score: 0,
      damage: 0,
      kills: 0,
      wins: 0,
      loadout: newLoadout(),
      aim: { angle: Math.PI / 4, power: 55, weapon: "shell" },
      skill: 0.35 + r() * 0.5,
      aimAt: 0,
      lockAt: 0,
      plan: null,
    })
  }

  private startBattle(now: number): void {
    this.battle++
    this.volley = 0
    this.hazardY = WORLD_H
    this.battleWinner = null
    this.battleSeed = mix(this.seed, this.matchNo * 7919 + this.battle)
    const r = rng(this.battleSeed)
    const fighters = this.players.filter((p) => p.connected).sort((a, b) => a.slot - b.slot).slice(0, MAX_UNITS)
    for (const p of this.players) {
      p.unit = -1
      p.locked = false
      p.ready = false
      p.spectator = !fighters.includes(p)
    }
    if (this.mode === "ffa") fighters.forEach((p, i) => (p.team = i))
    const bf = generateBattle(this.battleSeed, fighters.length)
    this.mask = bf.mask
    // shuffle spawn order; in teams mode team 0 takes the left side
    const order = fighters.map((p) => ({ p, k: r() }))
    order.sort((a, b) => (this.mode === "teams" ? a.p.team - b.p.team : 0) || a.k - b.k)
    this.units = []
    order.forEach(({ p }, i) => {
      const cls = classOf(p.cls)
      const pas = passiveOf(p.cls)
      const x = bf.spawns[i]!
      const maxHp = cls.maxHp + 20 * p.loadout.armor
      const ammo = { ...p.loadout.ammo }
      ammo.cluster = (ammo.cluster ?? 0) + pas.startCluster
      const unit: Unit = {
        id: i,
        team: p.team,
        name: p.name,
        cls: p.cls,
        x,
        y: spawnY(this.mask, x),
        hp: maxHp,
        maxHp,
        alive: true,
        kills: 0,
        ammo,
        shield: pas.startShield,
        boost: p.loadout.boost > 0 ? 1 : 0,
        fuel: this.maxFuel(p),
        angle: x < WORLD_W / 2 ? Math.PI / 4 : (Math.PI * 3) / 4,
        preview: p.loadout.lens,
      }
      p.loadout.boost = 0
      p.unit = unit.id
      p.aim = { angle: unit.angle, power: 55, weapon: "shell" }
      this.units.push(unit)
    })
    this.units.sort((a, b) => a.id - b.id)
    this.crates = []
    this.wind = nextWind(0, this.battleSeed)
    this.notice(`BATTLE ${this.battle}/${this.battles} — ${bf.biome.toUpperCase()}`)
    this.startAim(now, true)
  }

  private maxFuel(p: Player): number {
    return Math.round(classOf(p.cls).fuel * (1 + 0.5 * p.loadout.fuelTank))
  }

  private startAim(now: number, fresh: boolean): void {
    this.volley++
    const r = rng(mix(this.battleSeed, this.volley))
    if (this.volley >= SUDDEN_DEATH_VOLLEY) {
      if (this.volley === SUDDEN_DEATH_VOLLEY) this.notice("SUDDEN DEATH — the hazard is rising")
      this.hazardY = Math.min(this.hazardY, WORLD_H) - HAZARD_RISE
    }
    if (!fresh) this.wind = nextWind(this.wind, mix(this.battleSeed, this.volley * 97))
    if (this.volley > 1) this.spawnCrates(r)
    for (const p of this.players) {
      p.locked = false
      p.plan = null
      const u = this.unitOf(p)
      if (!u || !u.alive) continue
      u.fuel = Math.max(u.fuel, this.maxFuel(p))
      if (p.loadout.repair > 0 && u.hp <= u.maxHp - 40) {
        p.loadout.repair--
        u.hp += 40
        if (!p.bot) this.out.push({ to: p.id, msg: { type: "notice", text: "REPAIR KIT USED: +40 HP" } })
      }
      if (p.aim.weapon !== "shell" && (u.ammo[p.aim.weapon] ?? 0) <= 0) p.aim.weapon = "shell"
    }
    this.phase = "aim"
    this.phaseEndsAt = now + (fresh ? FIRST_AIM_MS : AIM_MS)
    for (const p of this.players) {
      if (!p.bot) continue
      const window = Math.max(1500, this.phaseEndsAt - now - 600)
      p.aimAt = now + 400 + r() * window * 0.35
      p.lockAt = Math.min(this.phaseEndsAt - 300, p.aimAt + 500 + r() * window * 0.4)
    }
    this.broadcastState(now, fresh)
  }

  private spawnCrates(r: Rand): void {
    if (this.crates.length >= 4 || r() > 0.55) return
    const count = r() < 0.15 ? 2 : 1
    for (let n = 0; n < count; n++) {
      for (let tries = 0; tries < 24; tries++) {
        const x = Math.round(50 + r() * (WORLD_W - 100))
        const g = footGround(this.mask, x, 0)
        if (g >= WORLD_H - 20 || g > this.hazardY - 12) continue
        if (this.units.some((u) => u.alive && Math.abs(u.x - x) < 26)) continue
        if (this.crates.some((c) => Math.abs(c.x - x) < 30)) continue
        const total = CRATE_KINDS.reduce((s, k) => s + k[1], 0)
        let pick = r() * total
        let kind: PowerupId = "credits"
        for (const [k, w] of CRATE_KINDS) {
          pick -= w
          if (pick <= 0) {
            kind = k
            break
          }
        }
        this.crates.push({ id: this.nextCrate++, x, y: g - 6, kind, landed: false })
        break
      }
    }
  }

  private botInput(p: Player, u: Unit) {
    return { mask: this.mask, units: this.units, crates: this.crates, me: u, wind: this.wind, seed: mix(this.battleSeed, this.volley * 131 + u.id), skill: p.skill }
  }

  private tickBots(now: number): void {
    for (const p of this.players) {
      if (!p.bot || p.locked) continue
      const u = this.unitOf(p)
      if (!u || !u.alive) continue
      if (!p.plan && now >= p.aimAt) {
        if (botReposition(this.botInput(p, u)) > 0) this.stateDirty = true
        p.plan = planBot(this.botInput(p, u))
        const r = rng(mix(this.battleSeed, this.volley * 7 + u.id))
        // first ghost is a rough read, refined on lock
        p.aim = { angle: clampAngle(p.plan.angle + (r() - 0.5) * 0.3), power: clampPower(p.plan.power + (r() - 0.5) * 20), weapon: p.plan.weapon }
        u.angle = p.aim.angle
        this.ghostsDirty = true
      }
      if (p.plan && now >= p.lockAt) this.lockBot(p, u)
    }
  }

  private lockBot(p: Player, u: Unit): void {
    if (!p.plan) p.plan = planBot(this.botInput(p, u))
    p.aim = { angle: clampAngle(p.plan.angle), power: clampPower(p.plan.power), weapon: p.plan.weapon }
    u.angle = p.aim.angle
    p.locked = true
    this.ghostsDirty = true
  }

  private aimDone(now: number): boolean {
    if (now >= this.phaseEndsAt) return true
    const living = this.players.filter((p) => {
      const u = this.unitOf(p)
      return u !== null && u.alive && p.connected
    })
    const humans = living.filter((p) => !p.bot)
    if (humans.length > 0) return humans.every((p) => p.locked)
    return living.every((p) => p.locked)
  }

  private resolve(now: number): void {
    for (const p of this.players) {
      if (!p.bot || p.locked) continue
      const u = this.unitOf(p)
      if (u && u.alive) this.lockBot(p, u)
    }
    this.phase = "resolve"
    const shots: Shot[] = []
    for (const p of this.players) {
      const u = this.unitOf(p)
      if (!u || !u.alive) continue
      shots.push({ unit: u.id, weapon: p.aim.weapon, angle: p.aim.angle, power: p.aim.power })
    }
    shots.sort((a, b) => a.unit - b.unit)
    const before = this.view(true, now)
    const boosted = this.units.filter((u) => u.boost > 0).map((u) => u.id)
    const result = runVolley({ mask: this.mask, units: this.units, shots, wind: this.wind, seed: mix(this.battleSeed, this.volley * 31 + 5), crates: this.crates, hazardY: this.hazardY })
    for (const id of boosted) {
      const u = this.units[id]
      if (u && u.boost > 0) u.boost--
    }
    const owner = (unit: number) => this.players.find((p) => p.unit === unit && !p.spectator) ?? null
    for (const ev of result.events) {
      if (ev.type === "hit") {
        const victim = this.units[ev.unit]
        const attacker = owner(ev.killer)
        if (!attacker || !victim || ev.killer === ev.unit) continue
        const au = this.units[ev.killer]
        if (!au || au.team === victim.team) continue
        attacker.damage += ev.amount
        attacker.score += ev.amount
        attacker.loadout.credits += ev.amount
        if (ev.kill) {
          attacker.kills++
          attacker.score += CREDITS.kill
          attacker.loadout.credits += CREDITS.kill
        }
      } else if (ev.type === "crate" && ev.kind === "credits") {
        const p = owner(ev.unit)
        if (p) p.loadout.credits += CREDITS.crate
      }
    }
    for (const p of this.players) {
      const u = this.unitOf(p)
      if (u && p.aim.weapon !== "shell" && (u.ammo[p.aim.weapon] ?? 0) <= 0) p.aim.weapon = "shell"
    }
    this.phaseEndsAt = now + result.durationMs + RESOLVE_PAD_MS
    const after = this.view(true, now)
    this.out.push({ to: null, msg: { type: "volley", shots, result, before, after } })
    this.stateDirty = false
    this.lastState = now
  }

  private afterResolve(now: number): void {
    const teams = new Set(this.units.filter((u) => u.alive).map((u) => u.team))
    if (teams.size <= 1) {
      this.endBattle(now, teams.size === 1 ? [...teams][0]! : null)
      return
    }
    if (this.volley >= MAX_VOLLEYS) {
      // stalemate: most total hp wins
      const hp = new Map<number, number>()
      for (const u of this.units) if (u.alive) hp.set(u.team, (hp.get(u.team) ?? 0) + u.hp)
      const best = [...hp.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]
      this.endBattle(now, best ? best[0] : null)
      return
    }
    this.startAim(now, false)
  }

  private endBattle(now: number, team: number | null): void {
    for (const p of this.players) {
      const u = this.unitOf(p)
      if (!u) continue
      p.loadout.ammo = { ...u.ammo, shell: WEAPONS.shell.ammo }
      if (u.alive) {
        p.score += CREDITS.survive
        p.loadout.credits += CREDITS.survive
      }
      if (team !== null && u.team === team) {
        p.wins++
        p.score += CREDITS.win
        p.loadout.credits += CREDITS.win
      }
    }
    if (team === null) this.battleWinner = null
    else if (this.mode === "teams") this.battleWinner = `${TEAM_NAMES[team] ?? `TEAM ${team + 1}`} TEAM`
    else this.battleWinner = this.players.find((p) => p.unit >= 0 && this.units[p.unit]?.team === team)?.name ?? null
    this.notice(this.battleWinner ? `${this.battleWinner} WINS THE BATTLE` : "NO SURVIVORS")
    if (this.battle >= this.battles) {
      const ranked = this.players.slice().sort((a, b) => b.score - a.score || b.wins - a.wins || a.slot - b.slot)
      this.matchWinner = ranked[0]?.name ?? null
      this.phase = "over"
      this.phaseEndsAt = now + OVER_MS
    } else {
      this.phase = "shop"
      this.phaseEndsAt = now + SHOP_MS
      for (const p of this.players) {
        p.ready = p.bot
        p.locked = false
        if (p.bot) botShop(p.loadout, mix(this.battleSeed, p.slot))
      }
    }
    this.broadcastState(now, false)
  }

  private toLobby(now: number): void {
    this.phase = "lobby"
    this.phaseEndsAt = 0
    this.players = this.players.filter((p) => !p.bot && p.connected)
    for (const p of this.players) {
      p.unit = -1
      p.locked = false
      p.spectator = false
      p.ready = false
    }
    this.units = []
    this.crates = []
    this.volley = 0
    this.battle = 0
    this.hazardY = WORLD_H
    this.battleWinner = null
    this.fixHost()
    this.broadcastState(now, false)
  }

  // -------------------------------------------------------------------------
  // helpers

  private unitOf(p: Player): Unit | null {
    if (p.unit < 0 || p.spectator) return null
    return this.units[p.unit] ?? null
  }

  private smallerTeam(): number {
    const a = this.players.filter((p) => p.team === 0).length
    const b = this.players.filter((p) => p.team === 1).length
    return a <= b ? 0 : 1
  }

  private cleanName(name: string, fallback: string): string {
    const n = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 16)
    return n || fallback
  }

  private cleanClass(cls: ClassId, level: number): ClassId {
    const def = CLASSES[cls]
    if (!def) return "howitzer"
    return (level ?? 1) >= def.unlock ? cls : "howitzer"
  }

  private fixHost(): void {
    const current = this.players.find((p) => p.host && p.connected && !p.bot)
    for (const p of this.players) p.host = false
    const next = current ?? this.players.filter((p) => !p.bot && p.connected).sort((a, b) => a.slot - b.slot)[0]
    if (next) next.host = true
  }

  private notice(text: string): void {
    this.out.push({ to: null, msg: { type: "notice", text } })
  }

  private error(id: string, message: string): void {
    this.out.push({ to: id, msg: { type: "error", message } })
  }

  private broadcastState(now: number, withMask: boolean): void {
    this.out.push({ to: null, msg: { type: "state", view: this.view(withMask, now) } })
    this.stateDirty = false
    this.lastState = now
    this.ghostsDirty = false
    this.lastGhosts = now
  }

  private flush(now: number): void {
    if (this.stateDirty && now - this.lastState >= GHOST_THROTTLE_MS) this.broadcastState(now, false)
    if (this.ghostsDirty && now - this.lastGhosts >= GHOST_THROTTLE_MS) {
      this.out.push({ to: null, msg: { type: "ghosts", ghosts: this.ghosts() } })
      this.ghostsDirty = false
      this.lastGhosts = now
    }
  }
}
