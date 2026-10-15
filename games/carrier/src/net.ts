import { BUILD } from "../shared/build.gen"
import { ClockSync } from "../shared/clock"
import { type Crew, type Outcome, type RecoverHow, type Role, createShip, joinCrew, joinShip, makeCrew, playerOf, recover, roleOf, runOp, tickCrew } from "../shared/crew"
import { kick, promote, setLock } from "../shared/squad"
import { type Hull, unpackHull } from "../shared/fleet"
import type { AimTuple, GunFireTuple, InterceptTuple } from "../shared/gunnery"
import type { BoatCtlTuple, BoatTuple } from "../shared/boat"
import { type ClientMsg, type FireTuple, type FlareTuple, type PlaneTuple, type ServerMsg, type ShipTuple, type World, decodeServer, encode, roomName } from "../shared/protocol"
import { RoomTime, TIME_OVERRIDE_LEAD, timeOverride, unpackTime } from "../shared/daycycle"
import { RoomWeather, WEATHER_OVERRIDE_LEAD, type Weather, type WeatherKind, overrideTo, packWeather, unpackOverride } from "../shared/weather"

/** The room's combat messages (relays and results), queued for the weapons controller. */
export type CombatMsg = Extract<ServerMsg, { type: "gun" | "fire" | "flare" | "seek" | "boom" | "hp" | "kill" | "sunk" }>
const COMBAT_TYPES = new Set(["gun", "fire", "flare", "seek", "boom", "hp", "kill", "sunk"])
/** Queued combat messages beyond this are dropped (nobody is draining them). */
const COMBAT_MAX = 512
/** The room's ship-gun messages (shared/gunnery.ts), queued for src/gunnery/gunnery.ts. */
export type GunneryMsg = Extract<ServerMsg, { type: "turrets" | "gfire" | "gboom" }>
const GUNNERY_TYPES = new Set(["turrets", "gfire", "gboom"])

export interface Net {
  readonly state: "connecting" | "online" | "offline"
  readonly seed: number // valid after ready
  readonly players: number
  readonly ready: Promise<void> // welcome received, or offline fallback after ≤ 3 s with a random seed
  /** The room name, or null offline. */
  readonly room: string | null
  /** This player's id in the crew (valid after ready). */
  readonly id: number
  /** Who is aboard which ship (shared/crew.ts). Offline: a local crew of one, run with the same rules. */
  readonly crew: Crew | null
  /** The last refused crew request (a CrewError) and when (performance.now()), for a HUD flash. */
  readonly refused: { error: string; at: number } | null
  /** Seconds since the room epoch on the server clock; smooth and monotonic (slews, never jumps back). */
  seaTime(): number
  /** The room clock (server Date.now() ms; crew timestamps such as `emptySince` use it). */
  serverNow(): number
  /** Every ship's authoritative pose by crew ship id (the room simulates them all). Empty offline. */
  readonly ships: ReadonlyMap<number, ShipTuple>
  /** Other players' jets by player id, as last relayed (about 20 Hz). Empty offline. */
  readonly planes: ReadonlyMap<number, PlaneTuple>
  /** The room's synced weather: its override history (shared/weather.ts), seeded with the room's seed after ready. */
  readonly weather: RoomWeather
  /** Sets the room's weather for everyone: fade over `fade` s to a kind, a custom weather, or back to the timeline (null). */
  sendWeather(to: WeatherKind | Weather | null, fade: number): void
  /** The room's synced clock (shared/daycycle.ts): its override history, seeded with the room's seed after ready. */
  readonly time: RoomTime
  /** Sets the room's clock for everyone: run over `fade` s to clock hour `hour` (null: the timeline), then at `speed`. */
  sendTime(hour: number | null, speed: number, fade: number): void
  /** This player's jet while airborne (dropped unless online). */
  sendPlane(p: PlaneTuple): void
  // Weapons (shared/combat.ts; all dropped unless online: offline the local combat world has the authority).
  sendGun(on: boolean): void
  sendHits(on: number, n: number): void
  sendFire(m: FireTuple): void
  sendFlare(f: FlareTuple): void
  sendSeek(on: number, locked: boolean): void
  sendShipHits(ship: number, n: number): void
  // Ship guns (shared/gunnery.ts; dropped unless online).
  sendAim(a: AimTuple): void
  sendGunFire(g: GunFireTuple): void
  sendTurretHits(on: number, n: number): void
  sendTurretShipHits(ship: number, n: number): void
  sendIntercept(i: InterceptTuple): void
  /** Ship-gun messages from the room (turrets, launches, bursts) in arrival order; the consumer empties it every frame. */
  readonly gunnery: GunneryMsg[]
  // The boat (shared/boat.ts; dropped unless online: offline the boat runs locally).
  /** The driver's orders; sent when they change and at least every second while out (dropped unless online). */
  sendBoat(c: BoatCtlTuple): void
  /** The boat's 25 mm hits since the last report: `k` 0 a jet, 1 a boat (player `on`), 2 a carrier (ship `on`). */
  sendBoatHits(k: number, on: number, n: number): void
  /** Every boat out by its driver's player id (ours included), as the room last sent them (~10 Hz). Empty offline. */
  readonly boats: ReadonlyMap<number, BoatTuple>
  /** Room sea time of the last `boats` frame (to age them). */
  readonly boatsAt: number
  /** Every carrier's health, zones and fires (shared/fleet.ts), by crew ship id, as of the last `hulls` (empty offline). */
  readonly hulls: ReadonlyMap<number, Hull>
  /** Combat messages from the room in arrival order; the consumer empties it every frame. */
  readonly combat: CombatMsg[]
  /** Kills and deaths by player id, as the room counts them (empty offline). */
  readonly stats: ReadonlyMap<number, { kills: number; deaths: number }>
  /** The helm's orders for this player's ship; sent when they change (dropped unless online and at the helm). */
  sendHelm(throttle: number, rudder: number): void
  // Crew requests (shared/crew.ts rules). The answer is a new `crew`, or `refused`.
  /** Run a ship operation (shared/ops.ts): take the helm, launch a vehicle. The DEPLOY menu's only path. */
  op(id: string): void
  /** Board another ship as `as`, or at its helm if free, else as a pilot. */
  board(ship: number, as?: Role): void
  /** Commission a ship on the team that has none (a sunk one's replacement not out yet). */
  newShip(): void
  recover(how: RecoverHow): void
  // Captain powers on my own ship (shared/squad.ts).
  promote(player: number): void
  kick(player: number): void
  lock(locked: boolean): void
  close(): void
}

export type ConnectOpts = {
  room?: string
  /** Forces offline with this seed. */
  seed?: number
  name?: string
  /** Create game: ask an empty room to stay out of quick join. */
  private?: boolean
  /** The room is full: the caller should offer another. */
  onFull?: () => void
}

/** No welcome by then: play offline. */
const WELCOME_MS = 3000
/** Pings right after connecting, this far apart, so the first estimate is already good. */
const BURST = 5
const BURST_GAP_MS = 50
/** After the welcome, ready waits for the burst's pongs, but no longer than this. */
const SETTLE_MS = 800
const PING_MS = 2000
const RETRY_MS = 500
const RETRY_MAX_MS = 8000
/** Unchanged helm orders are resent this often anyway (a lost frame never leaves the ship on a stale order). */
const HELM_RESEND_MS = 1000
const RELOAD_KEY = "carrier.reloadAt"
/** The local player's id offline. */
const SOLO_ID = 1

const randomU32 = () => crypto.getRandomValues(new Uint32Array(1))[0]!

function socketUrl(room: string, priv: boolean): string {
  const dir = location.pathname.replace(/[^/]*$/, "")
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${dir}ws?room=${encodeURIComponent(room)}${priv ? "&private=1" : ""}`
}

export function connect(opts: ConnectOpts = {}): Net {
  return new NetClient(opts)
}

class NetClient implements Net {
  state: Net["state"] = "connecting"
  seed = 0
  players = 0
  id = 0
  crew: Crew | null = null
  refused: Net["refused"] = null
  readonly room: string | null
  readonly ships = new Map<number, ShipTuple>()
  readonly planes = new Map<number, PlaneTuple>()
  readonly weather = new RoomWeather()
  readonly time = new RoomTime()
  readonly combat: CombatMsg[] = []
  readonly gunnery: GunneryMsg[] = []
  readonly stats = new Map<number, { kills: number; deaths: number }>()
  readonly hulls = new Map<number, Hull>()
  readonly boats = new Map<number, BoatTuple>()
  boatsAt = 0
  private boatSent = { key: "", at: 0 }
  readonly ready: Promise<void>
  private resolve!: () => void
  private settled = false
  private clock = new ClockSync()
  private world: World | null = null
  private ws: WebSocket | null = null
  private helloAt = 0
  private pings = 0
  private retries = 0
  private helmSent = { o: -1, r: -2, at: 0 }
  /** Closed by the caller, or gone offline: no more sockets. */
  private stopped = false
  private welcomeTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setTimeout> | null = null
  private settleTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  /** Offline: the local crew's tick (sinks long-empty ships, as the room's does). */
  private crewTimer: ReturnType<typeof setInterval> | null = null

  constructor(private opts: ConnectOpts) {
    this.ready = new Promise((r) => (this.resolve = r))
    const seed = opts.seed
    if (seed !== undefined && Number.isFinite(seed)) {
      this.room = null
      this.offline(seed >>> 0)
      return
    }
    this.room = roomName(opts.room)
    this.welcomeTimer = setTimeout(() => this.world || this.offline(randomU32()), WELCOME_MS)
    this.open()
  }

  seaTime(): number {
    // Until ready the estimate is still settling; the first call after it snaps to it.
    if (!this.settled || !this.world) return 0
    return (this.clock.now(performance.now()) - this.world.epoch) / 1000
  }

  serverNow(): number {
    return this.clock.count ? this.clock.now(performance.now()) : Date.now()
  }

  sendHelm(throttle: number, rudder: number): void {
    // Negative is astern (the sim clamps it to −SHIP.astern).
    const o = Math.round(Math.max(-1, Math.min(1, throttle)) * 1000) / 1000
    const r = Math.round(Math.max(-1, Math.min(1, rudder)) * 1000) / 1000
    const now = performance.now()
    const h = this.helmSent
    if (o === h.o && r === h.r && now - h.at < HELM_RESEND_MS) return
    if (this.send({ type: "helm", o, r })) this.helmSent = { o, r, at: now }
  }

  sendPlane(p: PlaneTuple): void {
    this.send({ type: "plane", p })
  }

  sendGun(on: boolean): void {
    this.send({ type: "gun", on })
  }

  sendHits(on: number, n: number): void {
    this.send({ type: "hits", on, n })
  }

  sendFire(m: FireTuple): void {
    this.send({ type: "fire", m })
  }

  sendFlare(f: FlareTuple): void {
    this.send({ type: "flare", f })
  }

  sendShipHits(ship: number, n: number): void {
    this.send({ type: "shiphits", ship, n })
  }

  sendSeek(on: number, locked: boolean): void {
    this.send({ type: "seek", on, locked })
  }

  sendAim(a: AimTuple): void {
    this.send({ type: "aim", a })
  }

  sendGunFire(g: GunFireTuple): void {
    this.send({ type: "gfire", g })
  }

  sendTurretHits(on: number, n: number): void {
    this.send({ type: "thits", on, n })
  }

  sendTurretShipHits(ship: number, n: number): void {
    this.send({ type: "tshiphits", ship, n })
  }

  sendIntercept(i: InterceptTuple): void {
    this.send({ type: "intercept", i })
  }

  sendBoat(c: BoatCtlTuple): void {
    const key = c.join()
    const now = performance.now()
    if (key === this.boatSent.key ? now - this.boatSent.at < HELM_RESEND_MS : now - this.boatSent.at < 50) return
    if (this.send({ type: "boat", c })) this.boatSent = { key, at: now }
  }

  sendBoatHits(k: number, on: number, n: number): void {
    this.send({ type: "bhits", k, on, n })
  }

  sendWeather(to: WeatherKind | Weather | null, fade: number): void {
    const f = Math.max(0, Math.min(600, fade))
    // Offline the local room is this client: apply the same override the server would.
    if (this.state === "offline") {
      this.weather.set(overrideTo(this.seed, this.weather.cur, this.seaTime() + WEATHER_OVERRIDE_LEAD, to, f))
      return
    }
    this.send({ type: "weather", to: to === null ? "auto" : typeof to === "string" ? to : packWeather(to), f })
  }

  sendTime(hour: number | null, speed: number, fade: number): void {
    const f = Math.max(0, Math.min(600, fade))
    if (this.state === "offline") {
      this.time.set(timeOverride(this.seed, this.time.cur, this.seaTime() + TIME_OVERRIDE_LEAD, hour, speed, f))
      return
    }
    this.send({ type: "time", h: hour, s: speed, f })
  }

  op(id: string): void {
    this.request({ type: "op", op: id }, (c) => runOp(c, SOLO_ID, id, this.serverNow()))
  }

  promote(player: number): void {
    this.request({ type: "promote", player }, (c) => promote(c, SOLO_ID, player))
  }

  kick(player: number): void {
    this.request({ type: "kick", player }, (c) => kick(c, SOLO_ID, player, this.serverNow()))
  }

  lock(locked: boolean): void {
    this.request({ type: "lock", locked }, (c) => setLock(c, SOLO_ID, locked))
  }

  board(ship: number, as?: Role): void {
    this.request(as === undefined ? { type: "board", ship } : { type: "board", ship, as }, (c) => joinShip(c, SOLO_ID, ship, this.serverNow(), as))
  }

  newShip(): void {
    this.request({ type: "newship" }, (c) => createShip(c, SOLO_ID, this.serverNow()))
  }

  recover(how: RecoverHow): void {
    this.request({ type: "recover", how }, (c) => recover(c, SOLO_ID, how, this.serverNow()))
  }

  close(): void {
    this.stop()
  }

  /** Online: asks the room. Offline: applies the same rule to the local crew. */
  private request(msg: ClientMsg, local: (c: Crew) => Outcome): void {
    if (this.state === "offline") {
      if (!this.crew) return
      tickCrew(this.crew, this.serverNow())
      const out = local(this.crew)
      if (out.error) this.refused = { error: out.error, at: performance.now() }
      else this.crew = structuredClone(this.crew)
      return
    }
    this.send(msg)
  }

  private send(msg: ClientMsg): boolean {
    const ws = this.ws
    if (this.state !== "online" || !ws || ws.readyState !== WebSocket.OPEN) return false
    ws.send(encode(msg))
    return true
  }

  private stop(): void {
    this.stopped = true
    for (const t of [this.welcomeTimer, this.pingTimer, this.settleTimer, this.retryTimer]) if (t) clearTimeout(t)
    if (this.crewTimer) clearInterval(this.crewTimer)
    const ws = this.ws
    this.ws = null
    ws?.close()
  }

  /** Runs alone: a fixed or random world on the local clock, starting at sea time 0, with a local crew of one. */
  private offline(seed: number): void {
    if (this.settled) return
    this.stop()
    this.state = "offline"
    this.seed = seed
    this.players = 1
    this.clock = new ClockSync()
    const now = performance.now()
    this.clock.add(now, now, now)
    this.world = { seed, epoch: now }
    this.weather.seed = seed
    this.weather.set(null)
    this.time.seed = seed
    this.time.set(null)
    this.id = SOLO_ID
    this.crew = makeCrew(seed)
    joinCrew(this.crew, SOLO_ID, this.opts.name ?? "", now)
    this.crewTimer = setInterval(() => {
      if (this.crew && tickCrew(this.crew, this.serverNow()).events.length) this.crew = structuredClone(this.crew)
    }, 250)
    this.settle()
  }

  private settle(): void {
    if (this.settled) return
    this.settled = true
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.resolve()
  }

  private open(): void {
    let ws: WebSocket
    try {
      ws = new WebSocket(socketUrl(this.room!, !!this.opts.private))
    } catch {
      return this.lost(null)
    }
    this.ws = ws
    this.pings = 0
    ws.onopen = () => {
      if (this.ws !== ws) return
      this.helloAt = performance.now()
      const hello: Extract<ClientMsg, { type: "hello" }> = { type: "hello", build: BUILD }
      if (this.world) hello.resume = { seed: this.world.seed, epoch: this.world.epoch }
      if (this.opts.name) hello.name = this.opts.name
      // Back to the ship and role we had before the connection dropped.
      const me = this.crew && playerOf(this.crew, this.id)
      if (me) hello.back = { ship: me.ship, role: roleOf(me) }
      ws.send(encode(hello))
      this.ping(ws)
    }
    ws.onmessage = (e) => {
      if (this.ws !== ws) return
      const msg = decodeServer(e.data)
      if (msg) this.receive(msg)
    }
    ws.onclose = () => this.lost(ws)
    ws.onerror = () => this.lost(ws)
  }

  private ping(ws: WebSocket): void {
    if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(encode({ type: "ping", c: performance.now() }))
    this.pings++
    this.pingTimer = setTimeout(() => this.ping(ws), this.pings < BURST ? BURST_GAP_MS : PING_MS)
  }

  private lost(ws: WebSocket | null): void {
    if (this.stopped || this.ws !== ws) return
    this.ws = null
    if (this.pingTimer) clearTimeout(this.pingTimer)
    ws?.close()
    // Never welcomed: don't wait for the timeout, just play offline.
    if (!this.world) return this.offline(randomU32())
    // Keep running on the last estimate meanwhile; the ships dead-reckon from their last poses.
    this.state = "connecting"
    this.retryTimer = setTimeout(() => this.stopped || this.open(), Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** this.retries++))
  }

  private receive(msg: ServerMsg): void {
    if (COMBAT_TYPES.has(msg.type)) {
      if (this.combat.length < COMBAT_MAX) this.combat.push(msg as CombatMsg)
      return
    }
    if (GUNNERY_TYPES.has(msg.type)) {
      if (this.gunnery.length < COMBAT_MAX) this.gunnery.push(msg as GunneryMsg)
      return
    }
    switch (msg.type) {
      case "hulls": {
        // Unpacked at our sea time now: fire ages and deck-fire countdowns are relative to it.
        const t = this.seaTime()
        const seen = new Set<number>()
        for (const v of msg.h) {
          const id = v[0]!
          seen.add(id)
          const team = this.crew?.ships.find((s) => s.id === id)?.team ?? -1
          this.hulls.set(id, unpackHull(v, t, team, this.hulls.get(id)))
        }
        for (const id of this.hulls.keys()) if (!seen.has(id)) this.hulls.delete(id)
        return
      }
      case "stats":
        this.stats.clear()
        for (const [id, kills, deaths] of msg.s) this.stats.set(id, { kills, deaths })
        return
      case "pong":
        this.clock.add(msg.c, msg.s, performance.now())
        if (this.world && this.clock.count > BURST) this.settle()
        return
      case "players":
        this.players = msg.n
        return
      case "crew":
        this.crew = msg.crew
        return
      case "ships":
        this.ships.clear()
        for (const s of msg.s) this.ships.set(s[0], s)
        return
      case "boats":
        this.boats.clear()
        for (const b of msg.b) this.boats.set(b[0]!, b)
        this.boatsAt = this.seaTime()
        return
      case "planes":
        this.planes.clear()
        for (const e of msg.p) if (e[0] !== this.id) this.planes.set(e[0], e.slice(1) as PlaneTuple)
        return
      case "nope":
        this.refused = { error: msg.error, at: performance.now() }
        return
      case "weather":
        this.weather.set(msg.o ? unpackOverride(msg.o) : null)
        return
      case "time":
        this.time.set(msg.o ? unpackTime(msg.o) : null)
        return
      case "full":
        this.stop()
        this.state = "offline"
        this.opts.onFull?.()
        return
      case "welcome": {
        const w = this.world
        // The room forgot our world while we were away (everyone left and someone started a new one).
        if (w && (w.seed !== msg.seed || w.epoch !== msg.epoch)) {
          this.stop()
          location.reload()
          return
        }
        // A fresh welcome: the room sends its weather override right after, if it has one.
        if (!w) {
          this.weather.seed = msg.seed
          this.weather.set(null)
          this.time.seed = msg.seed
          this.time.set(null)
        }
        this.world = { seed: msg.seed, epoch: msg.epoch }
        this.seed = msg.seed
        this.players = msg.players
        this.id = msg.id
        this.state = "online"
        this.retries = 0
        this.helmSent = { o: -1, r: -2, at: 0 }
        if (this.welcomeTimer) clearTimeout(this.welcomeTimer)
        // The hello/welcome exchange is a round trip too.
        this.clock.add(this.helloAt, msg.now, performance.now())
        if (!this.settled) this.settleTimer = setTimeout(() => this.settle(), SETTLE_MS)
        if (this.clock.count > BURST) this.settle()
        return
      }
      case "reload": {
        const welcomed = !!this.world
        this.stop()
        // Reload once; a second mismatch within a minute means the new build isn't served yet, so keep playing.
        const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
        if (Date.now() - last < 60_000) {
          if (!welcomed) return this.offline(randomU32())
          this.state = "offline"
          this.settle()
          return
        }
        sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
        location.reload()
        return
      }
    }
  }
}
