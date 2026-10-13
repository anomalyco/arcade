import { BUILD } from "../shared/build.gen"
import {
  type Crew,
  type Outcome,
  createShip,
  joinCrew,
  joinShip,
  launch,
  leaveCrew,
  makeCrew,
  playerOf,
  recover,
  runOp,
  scuttle,
  shipOf,
  spawnAt,
  takeHelm,
  teamShips,
  tickCrew,
} from "../shared/crew"
import { kick, promote, setLock } from "../shared/squad"
import { type Archipelago, makeArchipelago } from "../shared/islands"
import { CombatWorld, type CombatEvent, type GroundShip } from "../shared/combat"
import { BOW_Z, DECK_X0, DECK_X1, ISLAND, STERN_Z } from "../shared/carrier-spec"
import { Fleet, type ShipDamageKind, deckOpen, hullLimits, packHull, settled } from "../shared/fleet"
import { opById } from "../shared/ops"
import { placeLocal } from "../shared/landing"
import { playerVehicle } from "../shared/ops"
import { makePlane, worldToShip } from "../shared/plane"
import { type ClientMsg, compactPlane, type PlaneEntry, type PlaneTuple, PLANE_MODE, type ShipTuple, type StatTuple, type World, decodeClient, encode } from "../shared/protocol"
import { vehicleCode } from "../shared/vehicles"
import { makeTarget, type Target } from "../shared/weapons"
import { GunneryWorld, type Interceptable, asInterceptable, packGunBoom, packTurret, shipHitOf, unpackGunFire } from "../shared/gunnery"
import { type Sea, makeSea } from "../shared/sea"
import { SHIP, type Ship, type ShipControls, headingTo, makeShip, shipStep } from "../shared/ship"
import { RoomTime, TIME_OVERRIDE_LEAD, type TimeOverride, packTime, timeOverride } from "../shared/daycycle"
import { RoomWeather, WEATHER_OVERRIDE_LEAD, type WeatherOverride, type WeatherSea, makeWeather, makeWeatherSea, overrideTo, packOverride, unpackWeather } from "../shared/weather"

export type Conn = { send(data: string): void; close(code?: number, reason?: string): void }

/** A joined connection silent this long is dropped. Clients ping every 2 s, but hidden tabs can throttle timers to
 *  once a minute. */
export const SILENT_MS = 90_000
/** Every ship's pose goes to everyone this often (ms). */
export const SHIPS_EVERY_MS = 100
/** Airborne players' jets go to everyone this often (ms); the Room ticks every 50 ms, so ~20 Hz. */
export const PLANES_EVERY_MS = 50
/** A player's captain powers (promote, kick, lock) are ignored this soon after their last one (ms). */
export const CAPTAIN_COOLDOWN_MS = 400
/** At most this much sea time is simulated in one step; a longer stall (an evicted isolate) skips ahead. */
const MAX_CATCHUP = 2

const randomU32 = () => crypto.getRandomValues(new Uint32Array(1))[0]!
const round = (v: number, k: number) => Math.round(v * k) / k

type Sim = { ship: Ship; controls: ShipControls }

/**
 * One room, independent of the transport so tests can drive it. Holds a world while anyone has joined, and with it
 * the crew (shared/crew.ts) and every ship's simulation (shared/ship.ts, fixed SHIP.tick on sea time): the helm's
 * orders drive their ship, a ship without a helm holds its throttle with the rudder centred. The transport calls
 * `step` on a timer while anyone is connected; it advances the ships, sinks long-empty ones and sends the poses.
 */
export class RoomCore {
  world: World | null = null
  crew: Crew | null = null
  /** Joined connections (hello accepted) and when each last sent anything. */
  private seen = new Map<Conn, number>()
  /** Each joined connection's player id in the crew. */
  private ids = new Map<Conn, number>()
  private sims = new Map<number, Sim>()
  /** The weather-scaled sea every ship floats on (shared/weather.ts): the room's weather at its sea time. */
  private sea: Sea | null = null
  private weatherSea: WeatherSea | null = null
  /** The room's weather override history (the latest and the one it replaces until it starts). */
  private roomWeather = new RoomWeather()
  private weatherNow = makeWeather()
  /** The room's clock override history (shared/daycycle.ts): only relayed, physics never reads the time of day. */
  private roomTime = new RoomTime()
  private arch: Archipelago | null = null
  /** Where ships face when they start: toward the centrepiece island. */
  private heading = 0
  private nextId = 1
  private shipsAt = -Infinity
  /** Each airborne player's latest jet, relayed as sent; dropped when their plane slot is freed. */
  private planes = new Map<number, PlaneTuple>()
  private planesAt = -Infinity
  /** A frame with no jets still goes out once after the last one lands, so clients drop it. */
  private planesSent = 0
  /** When each player last used a captain power (room ms). */
  private captainAt = new Map<number, number>()
  /**
   * Air combat (shared/combat.ts): the room's authoritative missiles, bombs, flares and health. Jets enter it on
   * launch and leave it on recovery; it steps with the ships against the relayed jets.
   */
  private combat = new CombatWorld({ sea: null, arch: null, ships: [] }, true)
  private targets = new Map<number, Target>()
  private targetList: Target[] = []
  private scratch = makePlane()
  /** Kills and deaths per player id, for the Tab menu. */
  private stats = new Map<number, { kills: number; deaths: number }>()
  /** Whom each player's seeker is on (to clear the warning when it moves). */
  private seeking = new Map<number, number>()
  /** Every carrier's health (shared/fleet.ts): hits from the combat world, rounds and crashing jets; sinking. */
  private fleet = new Fleet()
  /** Each ship's settled pose (the settle offset applied), with its id and team: what rounds and stores hit. */
  private hullPoses = new Map<number, GroundShip & Ship>()
  private hullList: (GroundShip & Ship)[] = []
  private hullsDirty = false
  private hullsAt = -Infinity
  /**
   * Ship guns (shared/gunnery.ts): the gunners (synced from the crew), their budgets, and the authoritative SAMs and
   * shells. Steps with the combat world against the same jets and hulls; its damage goes through the combat world
   * (jets) and the fleet (ships).
   */
  private gunnery = new GunneryWorld({ sea: null, arch: null, ships: [] }, true)
  private turretsAt = -Infinity
  private turretsSent = 0

  constructor(
    private clock: () => number = Date.now,
    private random: () => number = randomU32,
  ) {}

  get players(): number {
    return this.seen.size
  }

  /** The simulated ships by crew ship id (for tests and the Room's reports). */
  get ships(): ReadonlyMap<number, Ship> {
    return new Map([...this.sims].map(([id, s]) => [id, s.ship]))
  }

  message(conn: Conn, raw: unknown): void {
    const now = this.clock()
    if (this.seen.has(conn)) this.seen.set(conn, now)
    this.sweep(now)
    const msg = decodeClient(raw)
    if (!msg) return
    if (msg.type === "ping") return conn.send(encode({ type: "pong", c: msg.c, s: now }))
    if (msg.type === "hello") return this.hello(conn, msg, now)
    const id = this.ids.get(conn)
    const crew = this.crew
    if (id === undefined || !crew) return
    switch (msg.type) {
      case "helm": {
        const p = playerOf(crew, id)
        const sim = p && this.sims.get(p.ship)
        if (sim && p.role === "helm" && !this.fleet.sinking(p.ship)) sim.controls = { throttle: msg.o, rudder: msg.r }
        return
      }
      case "op": {
        // A sinking ship runs nothing; a burning deck launches nothing.
        const p = playerOf(crew, id)
        const hull = p && this.fleet.hulls.get(p.ship)
        if (hull && this.fleet.sinking(hull.id)) return conn.send(encode({ type: "nope", error: "sinking" }))
        if (hull && opById(msg.op)?.kind === "vehicle" && !deckOpen(hull, this.seaTime(now))) return conn.send(encode({ type: "nope", error: "deck-fire" }))
        return this.apply(conn, runOp(crew, id, msg.op, now))
      }
      case "board":
        return this.apply(conn, joinShip(crew, id, msg.ship, now, msg.as))
      case "newship":
        return this.apply(conn, createShip(crew, id, msg.team, now))
      case "recover": {
        // Landing on another friendly ship only counts if its deck is open (the client checks too).
        const on = msg.ship !== undefined && deckOpen(this.fleet.hulls.get(msg.ship), this.seaTime(now)) ? msg.ship : -1
        return this.apply(conn, recover(crew, id, msg.how, now, on))
      }
      case "promote":
      case "kick":
      case "lock": {
        // Captain powers; a short cooldown per player keeps a spammed toggle from flooding everyone with crews.
        if (now - (this.captainAt.get(id) ?? -Infinity) < CAPTAIN_COOLDOWN_MS) return
        this.captainAt.set(id, now)
        const out = msg.type === "promote" ? promote(crew, id, msg.player) : msg.type === "kick" ? kick(crew, id, msg.player, now) : setLock(crew, id, msg.locked)
        return this.apply(conn, out)
      }
      case "plane": {
        const p = playerOf(crew, id)
        if (!p || p.plane < 0) return
        // The jet's type is the pilot's slot's, whatever the client says (old clients send none).
        const vehicle = playerVehicle(crew, id)
        const jet = msg.p.slice(0, 17) as PlaneTuple
        jet.push(vehicleCode(vehicle), msg.p[18] ?? 0)
        this.planes.set(id, compactPlane(jet))
        const f = this.combat.fighters.get(id)
        // A jet we don't know yet (a reconnect mid-flight) joins the fight; one reported crashed is destroyed (and a
        // recent attacker gets the kill).
        if (!f && (msg.p[1] === PLANE_MODE.flying || msg.p[1] === PLANE_MODE.landing)) this.combat.spawn(id, p.team, vehicle, this.seaTime(now))
        else if (f?.alive && msg.p[1] === PLANE_MODE.crashed) {
          this.combat.t = Math.max(this.combat.t, this.seaTime(now))
          this.combat.crash(id)
          this.crashIntoShip(id, p.team, msg.p[2], msg.p[3], msg.p[4], this.seaTime(now))
          this.flushCombat()
        }
        return
      }
      case "gun":
        if ((playerOf(crew, id)?.plane ?? -1) >= 0) this.sendOthers(id, encode({ type: "gun", id, on: msg.on }))
        return
      case "hits": {
        const a = this.where(id)
        const b = this.where(msg.on)
        if (!a || !b) return
        this.combat.gunHit(id, msg.on, msg.n, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]))
        this.flushCombat()
        return
      }
      case "shiphits": {
        // The shooter's rounds on a carrier: a gun, an enemy ship within gun range, and the shared round budget.
        const a = this.where(id)
        const f = this.combat.fighters.get(id)
        const ship = this.hullPoses.get(msg.ship)
        if (!a || !f || !ship) return
        if (Math.hypot(a[0] - ship.x, a[2] - ship.z) > 1800) return
        const n = this.combat.spendRounds(id, msg.n)
        if (n > 0) {
          // Spread over the island and the deck by where the shooter is (the client doesn't say where they hit).
          const l = worldToShip(ship, a[0], a[1], a[2], [0, 0, 0])
          const onIsland = l[1] > ISLAND.y0 && Math.abs(l[2] - (ISLAND.z0 + ISLAND.z1) / 2) < 120 && l[0] < 0
          this.fleet.hit({ ship: msg.ship, by: id, team: f.team, w: "gun", x: onIsland ? (ISLAND.x0 + ISLAND.x1) / 2 : 0, y: onIsland ? ISLAND.y0 + 10 : 26, z: onIsland ? (ISLAND.z0 + ISLAND.z1) / 2 : 0, near: 0, n }, this.seaTime(now))
          this.flushFleet(now)
        }
        return
      }
      case "fire": {
        const m = msg.m
        const kind = m[9] === 1 ? "bomb" : "missile"
        const t = this.seaTime(now)
        // A launch from the future or the distant past is clamped to the room's clock.
        const at = Math.max(t - 1, Math.min(t, m[1]))
        this.targetsAt(t)
        if (!this.combat.fire({ owner: id, seq: m[0], t: at, x: m[2], y: m[3], z: m[4], vx: m[5], vy: m[6], vz: m[7], target: m[8], kind })) return
        this.sendOthers(id, encode({ type: "fire", id, m: [m[0], at, m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9]] }))
        return
      }
      case "flare": {
        const f = msg.f
        const t = this.seaTime(now)
        const at = Math.max(t - 1, Math.min(t, f[0]))
        if (!this.combat.flare(id, at, f[1], f[2], f[3], f[4], f[5], f[6])) return
        this.sendOthers(id, encode({ type: "flare", id, f: [at, f[1], f[2], f[3], f[4], f[5], f[6]] }))
        return
      }
      case "aim": {
        const a = msg.a
        this.gunnery.aim(id, a[0] / 1000, a[1] / 1000, a[2] === 1)
        return
      }
      case "gfire": {
        const g = this.gunnery.gunners.get(id)
        if (!g) return
        const t = this.seaTime(now)
        const l = unpackGunFire(id, msg.g)
        l.t = Math.max(t - 1, Math.min(t, l.t))
        this.syncGunneryGround()
        if (!this.gunnery.fire(l, g.team)) return
        this.sendOthers(id, encode({ type: "gfire", id, g: [msg.g[0], msg.g[1], msg.g[2], msg.g[3], l.t, msg.g[5], msg.g[6], msg.g[7], msg.g[8], msg.g[9], msg.g[10], msg.g[11]] }))
        return
      }
      case "thits": {
        const t = this.seaTime(now)
        const target = this.targetsAt(t).find((x) => x.id === msg.on)
        this.syncGunneryGround()
        if (target) this.gunnery.ciwsHits(id, target, msg.n)
        this.flushGunnery()
        return
      }
      case "tshiphits": {
        const ship = this.hullPoses.get(msg.ship)
        const g = this.gunnery.gunners.get(id)
        if (!ship || !g) return
        this.syncGunneryGround()
        // The client doesn't say where: the side of the hull facing the gun.
        const at = this.gunnery.mountAt(g, [0, 0, 0])
        const l = at ? worldToShip(ship, at[0], at[1], at[2], [0, 0, 0]) : [0, 14, 0]
        this.gunnery.ciwsShipHits(id, ship, msg.n, Math.max(-25, Math.min(25, l[0]!)), 14, Math.max(STERN_Z + 10, Math.min(BOW_Z - 10, l[2]!)))
        this.flushGunnery()
        return
      }
      case "intercept": {
        const [owner, seq, store] = msg.i
        let s: Interceptable | null = null
        if (store === 0) {
          const m = this.combat.missiles.find((x) => x.alive && x.owner === owner && x.seq === seq)
          if (m) s = asInterceptable(m, 0, { store: 0, owner, seq, team: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 })
        } else {
          const p = this.gunnery.find(owner, seq)
          if (p) s = asInterceptable(p, 1, { store: 1, owner, seq, team: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 })
        }
        this.syncGunneryGround()
        if (s) this.gunnery.intercept(id, s)
        this.flushGunnery()
        return
      }
      case "seek": {
        const f = this.combat.fighters.get(id)
        const g = msg.on >= 0 ? this.combat.fighters.get(msg.on) : undefined
        // Only an enemy's seeker is relayed, and only to that jet; switching targets clears the old one.
        const prev = this.seeking.get(id) ?? -1
        if (prev >= 0 && prev !== msg.on) this.sendTo(prev, encode({ type: "seek", by: id, s: 0 }))
        if (!f || !g || f.team === g.team) {
          this.seeking.delete(id)
          return
        }
        this.seeking.set(id, msg.on)
        this.sendTo(msg.on, encode({ type: "seek", by: id, s: msg.locked ? 2 : 1 }))
        return
      }
      case "weather": {
        // Any player may set the room's weather (a dev tool, the debug menu's BROADCAST).
        const w = this.world
        if (!w) return
        const at = (now - w.epoch) / 1000 + WEATHER_OVERRIDE_LEAD
        const to = msg.to === "auto" ? null : typeof msg.to === "string" ? msg.to : unpackWeather(msg.to)
        this.roomWeather.set(overrideTo(w.seed, this.roomWeather.cur, at, to, msg.f))
        this.sendAll(this.weatherFrame())
        return
      }
      case "time": {
        // Any player may set the room's clock (a dev tool, the debug menu's TIME tab).
        const w = this.world
        if (!w) return
        const at = (now - w.epoch) / 1000 + TIME_OVERRIDE_LEAD
        this.roomTime.set(timeOverride(w.seed, this.roomTime.cur, at, msg.h, msg.s, msg.f))
        this.sendAll(this.timeFrame())
        return
      }
    }
  }

  close(conn: Conn): void {
    if (this.seen.delete(conn)) this.left(conn)
  }

  /** Advances every ship to the current sea time, sinks ships empty too long, and sends poses when due. */
  step(now = this.clock()): void {
    this.sweep(now)
    const w = this.world
    if (!w || !this.crew || !this.sea) return
    const t = (now - w.epoch) / 1000
    // Storms raise the waves every hull rides (the clients float the same weather-scaled sea).
    this.weatherSea?.set(this.roomWeather.at(t, this.weatherNow))
    for (const [id, { ship, controls }] of this.sims) {
      if (t - ship.t > MAX_CATCHUP) ship.t = t - SHIP.tick
      // A wrecked bridge slows the ship and weakens its rudder; a sinking one has no power at all.
      const lim = hullLimits(this.fleet.hulls.get(id))
      const ctl = lim.speed === 1 && lim.turn === 1 ? controls : { throttle: controls.throttle * lim.speed, rudder: controls.rudder * lim.turn }
      while (ship.t + SHIP.tick <= t) shipStep(ship, ctl, this.sea, this.arch, SHIP.tick)
    }
    this.apply(null, tickCrew(this.crew, now))
    this.settleHulls(t)
    this.stepCombat(t)
    this.stepGunnery(t)
    this.fleet.step(t, Math.max(0, Math.min(1, t - this.fleetT)))
    this.fleetT = t
    this.flushFleet(now)
    if (now - this.shipsAt >= SHIPS_EVERY_MS) {
      this.shipsAt = now
      this.sendAll(this.shipsFrame())
    }
    if (now - this.turretsAt >= SHIPS_EVERY_MS && (this.gunnery.gunners.size || this.turretsSent)) {
      this.turretsAt = now
      const list = [...this.gunnery.gunners.values()].map((g) => packTurret(g.ship, g))
      this.turretsSent = list.length
      this.sendAll(encode({ type: "turrets", t: list }))
    }
    if (now - this.planesAt >= PLANES_EVERY_MS && (this.planes.size || this.planesSent)) {
      this.planesAt = now
      const p: PlaneEntry[] = [...this.planes].map(([id, t]) => [id, ...t])
      this.planesSent = p.length
      this.sendAll(encode({ type: "planes", p }))
    }
  }

  /** The relayed jets by player id (for tests). */
  get jets(): ReadonlyMap<number, PlaneTuple> {
    return this.planes
  }

  /** The room's weather override (null: the seeded timeline). */
  get weather(): WeatherOverride | null {
    return this.roomWeather.cur
  }

  /** The room's clock override (null: the seeded timeline). */
  get time(): TimeOverride | null {
    return this.roomTime.cur
  }

  /** Health of a jet in the room's combat world (for tests). */
  hp(id: number): number {
    return this.combat.hp(id)
  }

  private seaTime(now: number): number {
    return this.world ? (now - this.world.epoch) / 1000 : 0
  }

  /** World position of a player's relayed jet (landing jets placed on the room's copy of their carrier), or null. */
  private where(id: number): [number, number, number] | null {
    const p = this.planes.get(id)
    if (!p || p[1] === PLANE_MODE.deck || p[1] === PLANE_MODE.crashed) return null
    if (p[1] === PLANE_MODE.landing) {
      // qw carries the carrier it lands on (0: its own).
      const on = p[8] > 0 ? p[8] : this.crew ? (playerOf(this.crew, id)?.ship ?? -1) : -1
      const ship = this.hullPoses.get(on) ?? this.sims.get(on)?.ship
      if (!ship) return null
      const w = placeLocal(ship, p[2], p[3], p[4], p[5], p[6], p[7], this.scratch)
      return [w.x, w.y, w.z]
    }
    return [p[2], p[3], p[4]]
  }

  /** Every jet in the fight as of sea time t: relayed poses dead-reckoned to t. */
  private targetsAt(t: number): Target[] {
    const list = this.targetList
    list.length = 0
    for (const [id, f] of this.combat.fighters) {
      const p = this.planes.get(id)
      const at = p && this.where(id)
      if (!p || !at) continue
      let tg = this.targets.get(id)
      if (!tg) this.targets.set(id, (tg = makeTarget(id, f.team)))
      const dt = p[1] === PLANE_MODE.flying ? Math.max(0, Math.min(1, t - p[0])) : 0
      tg.team = f.team
      tg.alive = f.alive
      tg.x = at[0] + p[9] * dt
      tg.y = at[1] + p[10] * dt
      tg.z = at[2] + p[11] * dt
      tg.vx = p[9]
      tg.vy = p[10]
      tg.vz = p[11]
      list.push(tg)
    }
    return list
  }

  private fleetT = 0

  /** Every ship's settled pose (shared/fleet.ts `settled`), as rounds, stores and crashing jets see it. */
  private settleHulls(t: number): void {
    this.hullList.length = 0
    for (const [id, sim] of this.sims) {
      let g = this.hullPoses.get(id)
      if (!g) this.hullPoses.set(id, (g = Object.assign(makeShip(0, 0, 0), { id, team: 0 })))
      settled(sim.ship, this.fleet.hulls.get(id), t, g)
      g.id = id
      g.team = this.crew ? (shipOf(this.crew, id)?.team ?? 0) : 0
      this.hullList.push(g)
    }
    for (const id of this.hullPoses.keys()) if (!this.sims.has(id)) this.hullPoses.delete(id)
  }

  private stepCombat(t: number): void {
    const c = this.combat
    if (!c.fighters.size) return
    c.ground.sea = this.sea
    c.ground.arch = this.arch
    c.ground.ships = this.hullList
    c.step(t, this.targetsAt(t))
    this.flushCombat()
  }

  private syncGunneryGround(): void {
    const g = this.gunnery.ground
    g.sea = this.sea
    g.arch = this.arch
    g.ships = this.hullList
  }

  /** SAMs and shells fly, burst and hurt, against the same jets, flares and hulls as the combat world. */
  private stepGunnery(t: number): void {
    const w = this.gunnery
    if (!w.gunners.size && !w.projectiles.some((p) => p.alive)) {
      w.t = t
      return
    }
    this.syncGunneryGround()
    w.step(t, { jets: this.targetsAt(t), flares: this.combat.flares })
    this.flushGunnery()
  }

  /** The gunnery world's events: bursts out to everyone, damage into the combat world and the fleet, intercepts. */
  private flushGunnery(): void {
    const events = this.gunnery.events
    if (!events.length) return
    const t = this.seaTime(this.clock())
    for (const e of events.splice(0)) {
      if (e.k === "gboom") this.sendAll(encode({ type: "gboom", b: packGunBoom(e) }))
      else if (e.k === "hurt") this.combat.hurt(e.on, e.dmg, e.by, e.w)
      else if (e.k === "ship") {
        const team = this.gunnery.gunners.get(e.owner)?.team ?? (this.crew ? playerOf(this.crew, e.owner)?.team : undefined) ?? -1
        const h = shipHitOf(e.w, e.near)
        this.fleet.hit({ ship: e.ship, by: e.owner, team, w: h.w, x: e.x, y: e.y, z: e.z, near: h.near, n: (e.n ?? 1) * h.n, amount: h.amount }, t)
      } else if (e.k === "intercept" && e.store === 0) this.combat.intercept(e.owner, e.seq)
    }
    this.flushCombat()
    this.flushFleet(this.clock())
  }

  /** The gunners follow the crew: whoever holds a gun seat mans that mount, nobody else does. */
  private syncGunners(): void {
    const crew = this.crew
    const w = this.gunnery
    for (const id of w.gunners.keys()) {
      const p = crew && playerOf(crew, id)
      if (!p || p.role !== "gunner") w.unman(id)
    }
    if (!crew) return
    for (const p of crew.players) {
      if (p.role !== "gunner" || p.mount < 0) continue
      const g = w.gunners.get(p.id)
      if (!g || g.ship !== p.ship || g.mount !== p.mount) w.man(p.id, p.team, p.ship, p.mount)
    }
  }

  /** A jet reported crashed at (x, y, z): into a ship of the other team, that ship takes a crash's damage. */
  private crashIntoShip(id: number, team: number, x: number, y: number, z: number, t: number): void {
    for (const g of this.hullList) {
      if (Math.abs(x - g.x) > 240 || Math.abs(z - g.z) > 240) continue
      const l = worldToShip(g, x, y, z, [0, 0, 0])
      const m = 12
      if (l[0] < DECK_X0 - m || l[0] > DECK_X1 + m || l[2] < STERN_Z - m || l[2] > BOW_Z + m || l[1] < -15 || l[1] > ISLAND.y1 + m) continue
      this.fleet.hit({ ship: g.id!, by: id, team, w: "crash", x: l[0], y: l[1], z: l[2], near: 0 }, t)
      return
    }
  }

  /** Fleet events: hull changes go out (batched), a sinking is announced, a ship gone under is scuttled. */
  private flushFleet(now: number): void {
    const crew = this.crew
    for (const e of this.fleet.events.splice(0)) {
      if (e.k === "hull") this.hullsDirty = true
      else if (e.k === "sinking") {
        const s = crew && shipOf(crew, e.ship)
        const sim = this.sims.get(e.ship)
        if (sim) sim.controls = { throttle: 0, rudder: 0 }
        if (s) this.sendAll(encode({ type: "sunk", ship: s.id, name: s.name, team: s.team, by: e.by }))
        this.hullsDirty = true
      } else if (e.k === "sunk" && crew) this.apply(null, scuttle(crew, e.ship, now))
    }
    if (this.hullsDirty && now - this.hullsAt >= 100) {
      this.hullsDirty = false
      this.hullsAt = now
      this.sendAll(this.hullsFrame())
    }
  }

  private hullsFrame(): string {
    const t = this.seaTime(this.clock())
    return encode({ type: "hulls", h: [...this.fleet.hulls.values()].map((h) => packHull(h, t)) })
  }

  // ---- hooks for ship guns (gunnery) -------------------------------------------------------------------------------

  /**
   * Damages ship `shipId` by `amount` from a hit at world point `at` (its zone and fire placement come from where that
   * lands on the settled hull), dealt by player `by` (-1 nobody; their team decides friendly fire) with `kind` ("shell"
   * for ship guns). Returns the damage applied (0: friendly, sinking, unknown ship).
   */
  damageShip(shipId: number, amount: number, at: readonly [number, number, number], by: number, kind: ShipDamageKind = "shell"): number {
    const g = this.hullPoses.get(shipId)
    if (!g || !this.crew) return 0
    const l = worldToShip(g, at[0], at[1], at[2], [0, 0, 0])
    const team = by >= 0 ? (playerOf(this.crew, by)?.team ?? -1) : -1
    const done = this.fleet.hit({ ship: shipId, by, team, w: kind, x: l[0], y: l[1], z: l[2], near: 0, amount }, this.seaTime(this.clock()))
    this.flushFleet(this.clock())
    return done
  }

  /** Missiles and bombs in flight (the room's authoritative ones), for CIWS/SAM targeting: owner, seq, kind, position. */
  *stores(): Generator<{ owner: number; seq: number; kind: "missile" | "bomb"; x: number; y: number; z: number; vx: number; vy: number; vz: number; team: number }> {
    for (const m of this.combat.missiles) if (m.alive) yield { owner: m.owner, seq: m.seq, kind: m.kind, x: m.x, y: m.y, z: m.z, vx: m.vx, vy: m.vy, vz: m.vz, team: m.team }
  }

  /** Destroys a missile or bomb in flight (shot down by CIWS/SAM); everyone sees it burst harmlessly. */
  interceptStore(owner: number, seq: number): boolean {
    const ok = this.combat.intercept(owner, seq)
    if (ok) this.flushCombat()
    return ok
  }

  /** Every ship's settled pose (as rounds and stores hit it), with its id and team, for gunnery's own hit tests. */
  get hullPoseList(): readonly (GroundShip & Ship)[] {
    return this.hullList
  }

  /** The fleet's view of a ship (for tests). */
  hull(id: number): ReturnType<Fleet["hulls"]["get"]> {
    return this.fleet.hulls.get(id)
  }

  /** Sends the combat world's events: bursts, health, kills (and the new tallies). */
  private flushCombat(): void {
    const events = this.combat.events
    if (!events.length) return
    let tally = false
    for (const e of events.splice(0) as CombatEvent[]) {
      if (e.k === "ship") {
        // A missile or bomb on a carrier (or a bomb's near miss): the fleet decides (friendly fire is refused there).
        const team = this.combat.fighters.get(e.owner)?.team ?? (this.crew ? playerOf(this.crew, e.owner)?.team : undefined) ?? -1
        this.fleet.hit({ ship: e.ship, by: e.owner, team, w: e.w, x: e.x, y: e.y, z: e.z, near: e.near }, this.combat.t)
        continue
      }
      if (e.k === "boom") this.sendAll(encode({ type: "boom", b: [e.owner, e.seq, round(e.x, 10), round(e.y, 10), round(e.z, 10), e.on, e.water ? 1 : 0, e.bomb ? 1 : 0] }))
      else if (e.k === "hp") this.sendAll(encode({ type: "hp", id: e.on, hp: e.hp, by: e.by, w: e.w }))
      else if (e.k === "kill") {
        this.sendAll(encode({ type: "kill", on: e.on, by: e.by, w: e.w }))
        this.tally(e.on).deaths++
        if (e.by >= 0 && e.by !== e.on) this.tally(e.by).kills++
        tally = true
      }
    }
    if (tally) this.sendAll(this.statsFrame())
    this.flushFleet(this.clock())
  }

  private tally(id: number): { kills: number; deaths: number } {
    let s = this.stats.get(id)
    if (!s) this.stats.set(id, (s = { kills: 0, deaths: 0 }))
    return s
  }

  private statsFrame(): string {
    const s: StatTuple[] = [...this.stats].map(([id, v]) => [id, v.kills, v.deaths])
    return encode({ type: "stats", s })
  }

  /** The combat world's view of a jet (for tests). */
  get fighters(): CombatWorld["fighters"] {
    return this.combat.fighters
  }

  private sendTo(id: number, data: string): void {
    for (const [c, pid] of this.ids) if (pid === id) c.send(data)
  }

  private sendOthers(id: number, data: string): void {
    for (const c of this.seen.keys()) if (this.ids.get(c) !== id) c.send(data)
  }

  private timeFrame(): string {
    return encode({ type: "time", o: this.time ? packTime(this.time) : null })
  }

  private weatherFrame(): string {
    return encode({ type: "weather", o: this.weather ? packOverride(this.weather) : null })
  }

  private shipsFrame(): string {
    const s: ShipTuple[] = []
    for (const [id, { ship: p }] of this.sims)
      s.push([id, round(p.t, 1e3), round(p.x, 1e2), round(p.z, 1e2), round(p.heading, 1e5), round(p.u, 1e3), round(p.v, 1e3), round(p.r, 1e5), round(p.order, 1e3), round(p.rudder, 1e3), round(p.power, 1e3)])
    return encode({ type: "ships", s })
  }

  /** Applies a crew outcome: a refusal goes back to the asker; otherwise the ships follow and everyone gets the crew. */
  private apply(conn: Conn | null, out: Outcome): void {
    if (out.error) {
      conn?.send(encode({ type: "nope", error: out.error }))
      return
    }
    if (!out.events.length) return
    // A freed plane slot (took the helm, left, ship sunk) ends that player's jet; so does a recovery (back on the deck,
    // the next sortie relays a new one).
    for (const id of this.planes.keys()) if (!this.crew || (playerOf(this.crew, id)?.plane ?? -1) < 0) this.planes.delete(id)
    for (const e of out.events) {
      if (e.k === "recover" || e.k === "launch") this.planes.delete(e.player)
      // A launch is a fresh jet in the fight; a recovery (or leaving) takes it out.
      if (e.k === "launch") {
        const p = this.crew && playerOf(this.crew, e.player)
        this.combat.spawn(e.player, p?.team ?? 0, playerVehicle(this.crew, e.player), this.seaTime(this.clock()))
      } else if (e.k === "recover" || e.k === "leave") this.combat.remove(e.player)
      if (e.k === "new") this.spawn(e.ship)
      else if (e.k === "sink") {
        this.sims.delete(e.ship)
        this.fleet.remove(e.ship)
        this.hullsDirty = true
      }
      else if (e.k === "helm" && e.player === null) {
        // Nobody at the helm: hold the last throttle order, centre the rudder.
        const sim = this.sims.get(e.ship)
        if (sim) sim.controls = { throttle: sim.controls.throttle, rudder: 0 }
      }
    }
    this.syncGunners()
    this.sendAll(encode({ type: "crew", crew: this.crew! }))
  }

  private spawn(id: number): void {
    const crew = this.crew!
    const s = shipOf(crew, id)
    if (!s || !this.world) return
    const friend = teamShips(crew, s.team)
      .filter((o) => o.id !== id && this.sims.has(o.id))
      .sort((a, b) => a.slot - b.slot)[0]
    const at = spawnAt(s.team, s.slot, this.heading, friend && this.sims.get(friend.id)!.ship)
    const t = (this.clock() - this.world.epoch) / 1000
    this.sims.set(id, { ship: makeShip(at.x, at.z, at.heading, t), controls: { throttle: 0, rudder: 0 } })
    this.fleet.add(id, s.team)
    this.hullsDirty = true
  }

  private hello(conn: Conn, msg: Extract<ClientMsg, { type: "hello" }>, now: number): void {
    if (this.seen.has(conn)) return
    // A client built from different shared code (protocol, waves, islands) would show another sea: reload it.
    if (msg.build !== BUILD) {
      conn.send(encode({ type: "reload" }))
      conn.close(4003, "stale client")
      return
    }
    if (!this.world) {
      const resume = msg.resume && msg.resume.epoch <= now ? msg.resume : null
      const world = (this.world = resume ?? { seed: this.random() >>> 0, epoch: now })
      this.crew = makeCrew(world.seed)
      this.weatherSea = makeWeatherSea(makeSea(world.seed))
      this.sea = this.weatherSea.sea
      this.roomWeather = new RoomWeather(world.seed)
      this.roomTime = new RoomTime(world.seed)
      this.arch = makeArchipelago(world.seed)
      const goal = this.arch.islands[0]
      this.heading = goal ? headingTo(0, 0, goal.x, goal.z) : 0
      this.sims.clear()
    }
    const world = this.world
    const crew = this.crew!
    const id = this.nextId++
    const joined = joinCrew(crew, id, msg.name ?? "", now)
    if (joined.error) {
      conn.send(encode({ type: "full" }))
      conn.close(4004, "room full")
      if (this.seen.size === 0) this.forget()
      return
    }
    this.seen.set(conn, now)
    this.ids.set(conn, id)
    // A reconnecting player gets their old ship back: the helm if they had it and it's still free, else a plane.
    const back = msg.back
    const events = [...joined.events]
    if (back && shipOf(crew, back.ship)) {
      const p = playerOf(crew, id)!
      const ship = shipOf(crew, back.ship)!
      const role = back.role === "helm" && (ship.helm === null || ship.helm === id) ? "helm" : "pilot"
      let out: Outcome | null = null
      // A locked ship still takes back a member whose connection dropped.
      if (p.ship !== back.ship) {
        const locked = ship.locked
        ship.locked = false
        out = joinShip(crew, id, back.ship, now, role)
        ship.locked = locked
      }
      else if (role === "helm" && p.role === "pilot") out = takeHelm(crew, id, now)
      else if (role === "pilot" && p.role === "helm") out = launch(crew, id, now)
      if (out && !out.error) events.push(...out.events)
    }
    conn.send(encode({ type: "welcome", seed: world.seed, epoch: world.epoch, now, players: this.seen.size, id }))
    this.apply(null, { events })
    conn.send(this.shipsFrame())
    conn.send(this.weatherFrame())
    conn.send(this.timeFrame())
    if (this.stats.size) conn.send(this.statsFrame())
    conn.send(this.hullsFrame())
    this.broadcast(conn)
  }

  /** Drops joined connections that went silent without a close event. */
  private sweep(now: number): void {
    for (const [c, at] of this.seen) {
      if (now - at <= SILENT_MS) continue
      this.seen.delete(c)
      c.close(4000, "silent")
      this.left(c)
    }
  }

  private left(conn: Conn): void {
    const id = this.ids.get(conn)
    this.ids.delete(conn)
    // Nobody left: forget the world, so the next visit is a new one.
    if (this.seen.size === 0) return this.forget()
    if (id !== undefined && this.crew) this.apply(null, leaveCrew(this.crew, id, this.clock()))
    if (id !== undefined) {
      this.captainAt.delete(id)
      this.stats.delete(id)
      this.seeking.delete(id)
      this.combat.remove(id)
    }
    this.broadcast(null)
  }

  private forget(): void {
    this.planes.clear()
    this.planesSent = 0
    this.world = null
    this.crew = null
    this.sea = null
    this.weatherSea = null
    this.roomWeather = new RoomWeather()
    this.roomTime = new RoomTime()
    this.arch = null
    this.sims.clear()
    this.captainAt.clear()
    this.combat = new CombatWorld({ sea: null, arch: null, ships: [] }, true)
    this.gunnery = new GunneryWorld({ sea: null, arch: null, ships: [] }, true)
    this.turretsSent = 0
    this.targets.clear()
    this.stats.clear()
    this.seeking.clear()
    this.fleet = new Fleet()
    this.hullPoses.clear()
    this.hullList.length = 0
  }

  private sendAll(data: string): void {
    for (const c of this.seen.keys()) c.send(data)
  }

  private broadcast(except: Conn | null): void {
    const data = encode({ type: "players", n: this.seen.size })
    for (const c of this.seen.keys()) if (c !== except) c.send(data)
  }
}
