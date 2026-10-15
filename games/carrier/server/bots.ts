// Dev-only bots (shared/bots.ts): crew players without a socket, run by the room. Each bot joins its carrier and runs
// its ship operation through the crew rules (shared/crew.ts, shared/ops.ts), flies or drives the real shared models
// (shared/plane.ts, launch.ts, boat.ts, gunnery.ts) at their fixed steps, fires the real weapons (shared/weapons.ts,
// combat.ts Bullets, gunnery.ts TurretRounds, boat.ts BoatRounds), and hands everything it does to the room as the
// client messages a player would send (`plane`, `gun`, `hits`, `fire`, `flare`, `seek`, `boat`, `bhits`, `aim`,
// `gfire`, `thits`, `helm`, `op`, `recover`). The room validates and applies those exactly as it does a player's, so
// damage, kills, budgets and the relays to every client stay where they always were. RoomCore owns one RoomBots only in
// dev mode.

import { type Crew, type CrewPlayer, type Outcome, joinCrew, joinShip, playerOf, shipOf } from "../shared/crew"
import { makeSlots, opById, opError } from "../shared/ops"
import { type Archipelago, terrainHeight } from "../shared/islands"
import { type Sea } from "../shared/sea"
import { type Ship } from "../shared/ship"
import { type Plane, type PlaneControls, PLANE, bodyToWorld, makePlane, planeAttitude, planeSpeed, planeStep, quatAxis, quatMul, quatRotate, setPlaneQuat } from "../shared/plane"
import { VEHICLES, type VehicleKind } from "../shared/vehicles"
import { type Launch, LAUNCH, launchStep, startLaunch } from "../shared/launch"
import { type Lock, type Loadout, type Shooter, type Target, LOADOUTS, WEAPONS, gunStep, hash01, loadoutStep, lockStep, makeLoadout, railOf, takeBomb, takeFlares, takeMissile } from "../shared/weapons"
import { type CombatEvent, type CombatWorld, type GroundShip, type MissileLaunch, Bullets, bombImpact, bombLaunch, makeBombImpact } from "../shared/combat"
import { type GunneryWorld, type Interceptable, type TurretAngles, type TurretState, GUNNERY, TurretRounds, anglesOf, asInterceptable, ciwsStep, leadPoint, makeTurretState, muzzleWorld as mountMuzzle, packAim, packGunFire, predictImpact, restAngles, samLockStep, shipPointVel, slewTurret, takeSam, takeShell, toLocalDir, turretStep as mountStep } from "../shared/gunnery"
import { type Boat, type BoatMode, type BoatTarget, type Turret, BOAT_HIT, BOAT_MODE, BoatRounds, GUN, boatVelocity, makeTurret, muzzleWorld as boatMuzzle, turretGun, turretStep } from "../shared/boat"
import { WEAPON_MOUNTS } from "../shared/carrier-spec"
import { type ClientMsg, type PlaneTuple, PLANE_MODE, encode } from "../shared/protocol"
import { type BotAt, type BotCmd, type BotInfo, type BotKind, type BotSettings, BOT_ROOM_MAX, behaviorFor, botKind, botName } from "../shared/bots"

/** What the bots need from their room (server/core.ts builds it from its own state). */
export type BotRoom = {
  crew(): Crew | null
  /** Room clock (ms) and sea time (s) at it. */
  now(): number
  seaTime(now: number): number
  sea(): Sea | null
  arch(): Archipelago | null
  /** Every carrier's settled pose with its id and team (what rounds and stores hit). */
  hulls(): readonly (GroundShip & Ship)[]
  /** A carrier's simulated (unsettled) state, for the catapult. */
  sim(ship: number): Ship | undefined
  combat(): CombatWorld
  gunnery(): GunneryWorld
  /** Every jet and boat in the fight at sea time t (the room's own list: use it at once). */
  targets(t: number): readonly Target[]
  boats(): Iterable<[number, { boat: Boat; mode: BoatMode }]>
  /** How many enemy seekers are on player `id` now. */
  seekers(id: number): number
  /** A message from bot `id`, through the room's own handler (validated as a player's). */
  handle(id: number, msg: ClientMsg): void
  apply(out: Outcome): void
  /** Sends the crew to everyone (after a dev-side tweak of slots or the catapult). */
  sendCrew(): void
  newId(): number
  /** Player `id` leaves the room (crew, combat, stats). */
  drop(id: number): void
  sendAll(data: string): void
}

type Base = {
  id: number
  name: string
  role: string
  kind: BotKind
  ship: number
  group: number
  s: BotSettings
  start: "air" | "deck"
  rules: boolean
  /** Where it starts (air start) and the centre its patterns are laid around. */
  at: BotAt
  state: string
  note: string
  /** Room ms of the next attempt to launch or man its post. */
  retryAt: number
  /** Shot down by the panel: invulnerability doesn't save it. */
  dying: boolean
  /** Per-bot coin stream (deterministic). */
  coin: number
}

type JetBot = Base & {
  kind: "jet"
  vehicle: VehicleKind
  phase: "deck" | "fly" | "down" | "wait"
  plane: Plane
  launch: Launch | null
  sortie: number
  c: PlaneControls
  loadout: Loadout
  lock: Lock
  seek: { on: number; locked: boolean }
  gun: boolean
  downAt: number
  hits: Map<number, number>
  shipHits: Map<number, number>
  flushIn: number
  /** Path phase (figure-eight), jink state, missile pacing, flares already spent on a missile, bomb-run state. */
  phi: number
  jinkUntil: number
  jinkAt: number
  jinkTurn: number
  jinkAlt: number
  missileIn: number
  flared: Set<string>
  lockedFor: number
  lockFlared: boolean
  run: "in" | "out"
  runAt: number
  doors: number
  bombCheck: number
  target: number
  trigger: boolean
}

type BoatBot = Base & { kind: "boat"; tr: Turret; placed: boolean; firing: boolean; ctl: [number, number, number]; hits: Map<string, number>; flushIn: number; target: number; sortie: number }

type GunBot = Base & { kind: "gun"; mount: number; ts: TurretState; aim: TurretAngles; firing: boolean; aimIn: number; hits: Map<number, number>; shipHits: Map<number, number>; claims: [number, number, number][]; flushIn: number; target: number; bias: number; refineIn: number }

type HelmBot = Base & { kind: "helm" }

type Bot = JetBot | BoatBot | GunBot | HelmBot

const DT = PLANE.tick
/** Bots report hits this often (s), as a client does. */
const FLUSH = 0.1
/** The bot list goes to the room this often (ms). */
const LIST_MS = 500
/** Room ms between attempts to launch (or man a post) while held up. */
const RETRY_MS = 1000
/** Patterns stay inside this radius of the map's centre (shared/plane.ts loses jets past 9 km). */
const HOME = 7200
const G = 9.81

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
const lerp = (a: number, b: number, k: number) => a + (b - a) * k
const v3 = (): [number, number, number] => [0, 0, 0]
const tmp = v3()
const tmp2 = v3()
const tmp3 = v3()
const att = { heading: 0, pitch: 0, bank: 0 }

/** Heading (0 north, π/2 east) from (x, z) toward (tx, tz). */
const bearing = (x: number, z: number, tx: number, tz: number) => Math.atan2(tx - x, -(tz - z))

/**
 * The patrol autopilot (as the weapons harness's drones): bank toward the wanted heading, pull to hold the height.
 * `gain` 0..1 scales the stick.
 */
export function navigate(p: Plane, c: PlaneControls, heading: number, alt: number, maxBank = 1.1, gain = 1): void {
  const a = planeAttitude(p, att)
  const dh = wrap(heading - a.heading)
  const bank = clamp(dh * 2.5, -maxBank, maxBank)
  c.roll = clamp((bank - a.bank) * 2.5, -1, 1) * gain
  const climb = clamp((alt - p.y) * 0.004, -0.3, 0.3)
  c.pitch = clamp((climb - a.pitch) * 3 + Math.abs(Math.sin(a.bank)) * 0.55, -1, 1) * gain
  c.yaw = 0
}

/**
 * Points the nose at world point (x, y, z): roll the point into the canopy and pull while it is far off the nose,
 * then fine-aim with pitch and rudder. Returns the angle (rad) between the nose and the point.
 */
export function pursue(p: Plane, c: PlaneControls, x: number, y: number, z: number, gain = 1): number {
  const d = quatRotate(-p.qx, -p.qy, -p.qz, p.qw, x - p.x, y - p.y, z - p.z, tmp)
  const len = Math.hypot(d[0], d[1], d[2]) || 1
  // Body frame: +X the pilot's left, +Y up, +Z the nose.
  const right = -d[0] / len
  const up = d[1] / len
  const fwd = d[2] / len
  const off = Math.acos(clamp(fwd, -1, 1))
  const a = planeAttitude(p, att)
  if (off > 0.2) {
    const roll = Math.atan2(right, up)
    c.roll = clamp(roll * 2.4, -1, 1) * gain
    const facing = Math.cos(roll)
    c.pitch = (facing > 0.3 ? Math.min(1, off * 2.5) : facing > -0.2 ? 0.3 : 0.08) * gain
    c.yaw = clamp(Math.atan2(right, Math.max(fwd, 0.05)) * 0.6, -1, 1) * gain
  } else {
    c.pitch = clamp(Math.atan2(up, fwd) * 7, -1, 1) * gain
    c.yaw = clamp(Math.atan2(right, fwd) * 7, -1, 1)
    c.roll = clamp((clamp(Math.atan2(right, fwd) * 6, -1.2, 1.2) - a.bank) * 2, -1, 1) * gain
  }
  return off
}

/** Throttle intent for an airspeed: full, released (cruise) or the airbrake; the burner when far below it. */
export function holdSpeed(p: Plane, c: PlaneControls, want: number, burner: boolean): void {
  const s = planeSpeed(p)
  c.throttle = s < want - 6 ? 1 : s > want + 14 ? -1 : want > PLANE.optimalSpeed + 5 ? 1 : 0
  c.boost = burner && s < want - 25
}

/**
 * The room's bots. `command` takes the panel's requests, `step` runs every bot to sea time t (call it after the ships
 * and before the combat world), `absorb` lets an invulnerable bot shrug off damage, `list` is what the panel shows.
 */
export class RoomBots {
  private bots = new Map<number, Bot>()
  private t = 0
  private named = 0
  private groups = 0
  private listAt = -Infinity
  private listed = 0
  private bullets = new Bullets(1024)
  private turretRounds = new TurretRounds(512)
  private boatRounds = new BoatRounds(256)
  private stores: Interceptable[] = []
  private storePool: Interceptable[] = []
  private boatTargets: BoatTarget[] = []
  private jetTargets: Target[] = []
  private subTargets: Target[] = []
  private subPool: Target[] = []
  private shooter: Shooter = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 1, team: 0 }
  private impact = makeBombImpact()
  private ml: MissileLaunch = { owner: 0, seq: 0, t: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, target: -1, kind: "bomb" }

  constructor(private room: BotRoom) {}

  get size(): number {
    return this.bots.size
  }

  has(id: number): boolean {
    return this.bots.has(id)
  }

  /** A panel request. Returns an error to show (a crew error, "room-full", "no-ship"), or null. */
  command(cmd: BotCmd): string | null {
    const crew = this.room.crew()
    if (!crew) return "no-room"
    switch (cmd.c) {
      case "spawn":
        return this.spawn(crew, cmd)
      case "set":
        for (const id of cmd.ids) {
          const b = this.bots.get(id)
          if (!b) continue
          Object.assign(b.s, cmd.s)
          b.s.behavior = behaviorFor(b.kind, b.s.behavior)
          if (b.kind === "jet") b.run = "in"
        }
        return null
      case "kill":
        for (const id of cmd.ids) this.kill(id)
        return null
      case "remove":
        for (const id of cmd.ids) this.remove(id)
        return null
      case "clear":
        for (const id of [...this.bots.keys()]) this.remove(id)
        return null
    }
  }

  private spawn(crew: Crew, cmd: Extract<BotCmd, { c: "spawn" }>): string | null {
    const kind = botKind(cmd.role)
    if (!kind) return "bad-op"
    if (!shipOf(crew, cmd.ship)) return "no-ship"
    if (this.bots.size + cmd.n > BOT_ROOM_MAX) return "too-many-bots"
    const group = ++this.groups
    const now = this.room.now()
    let error: string | null = null
    for (let i = 0; i < cmd.n; i++) {
      const id = this.room.newId()
      const name = botName(this.named++)
      const joined = joinCrew(crew, id, name, now)
      if (joined.error) {
        error = joined.error
        break
      }
      this.room.apply(joined)
      const p = playerOf(crew, id)!
      if (p.ship !== cmd.ship) {
        const moved = joinShip(crew, id, cmd.ship, now, "pilot")
        if (moved.error) {
          this.room.drop(id)
          error = moved.error
          break
        }
        this.room.apply(moved)
      }
      // Side by side across the heading, a little stepped up.
      const [x, y, z, h] = cmd.at
      const off = (i - (cmd.n - 1) / 2) * 180
      const at: BotAt = [x + Math.cos(h) * off, y + Math.abs(off) * 0.15, z + Math.sin(h) * off, h]
      const s: BotSettings = { ...cmd.s, behavior: behaviorFor(kind, cmd.s.behavior) }
      const base: Base = { id, name, role: cmd.role, kind, ship: cmd.ship, group, s, start: cmd.start, rules: cmd.rules, at, state: "joining", note: "", retryAt: 0, dying: false, coin: hash01(id, 0x5eed) }
      this.bots.set(id, this.make(base))
      this.post(this.bots.get(id)!, crew, now)
    }
    this.sendList(now, true)
    return error
  }

  private make(b: Base): Bot {
    if (b.kind === "jet") {
      const vehicle = opById(b.role)?.vehicle ?? "hornet"
      return {
        ...b,
        kind: "jet",
        vehicle,
        phase: "wait",
        plane: makePlane(this.t),
        launch: null,
        sortie: -1,
        c: { pitch: 0, roll: 0, yaw: 0, throttle: 0, boost: false },
        loadout: makeLoadout(vehicle),
        lock: { target: -1, time: 0, locked: false },
        seek: { on: -1, locked: false },
        gun: false,
        downAt: 0,
        hits: new Map(),
        shipHits: new Map(),
        flushIn: FLUSH,
        phi: 0,
        jinkUntil: 0,
        jinkAt: 2 + b.coin * 3,
        jinkTurn: 0,
        jinkAlt: 0,
        missileIn: 3,
        flared: new Set(),
        lockedFor: 0,
        lockFlared: false,
        run: "in",
        runAt: 0,
        doors: 0,
        bombCheck: 0,
        target: -1,
        trigger: false,
      }
    }
    if (b.kind === "boat") return { ...b, kind: "boat", tr: makeTurret(), placed: false, firing: false, ctl: [0, 0, 0], hits: new Map(), flushIn: FLUSH, target: -1, sortie: -1 }
    if (b.kind === "gun") {
      const mount = opById(b.role)?.mount ?? 0
      return { ...b, kind: "gun", mount, ts: makeTurretState(mount), aim: restAngles(mount), firing: false, aimIn: 0, hits: new Map(), shipHits: new Map(), claims: [], flushIn: FLUSH, target: -1, bias: 0, refineIn: 0 }
    }
    return { ...b, kind: "helm" }
  }

  /**
   * Runs the bot's operation if it isn't at its post: launch (into a ready slot; with `rules` off an extra slot when all
   * are busy; an air start doesn't hold the catapult), or man its gun or the helm. Sets `state` to what holds it up.
   */
  private post(b: Bot, crew: Crew, now: number): boolean {
    const p = playerOf(crew, b.id)
    const s = p && shipOf(crew, p.ship)
    const op = opById(b.role)
    if (!p || !s || !op) return false
    if (this.atPost(b, p)) return true
    if (now < b.retryAt) return false
    b.retryAt = now + RETRY_MS
    const air = b.start === "air" && op.kind === "vehicle"
    const catapult = s.catapultUntil
    if (air) s.catapultUntil = 0
    let err = opError(crew, b.id, b.role, now)
    let extra = false
    if (!b.rules && op.kind === "vehicle" && (err === "in-use" || err === "recharging")) {
      s.aircraft.push({ op: op.id, pilot: null, readyAt: 0 })
      extra = true
      err = opError(crew, b.id, b.role, now)
    }
    if (!err) this.room.handle(b.id, { type: "op", op: b.role })
    if (air) s.catapultUntil = catapult
    const ok = this.atPost(b, p)
    if (extra && !ok) trimSlots(s)
    if (air || extra) this.room.sendCrew()
    b.state = ok ? "ready" : (err ?? "refused")
    return ok
  }

  private atPost(b: Bot, p: CrewPlayer): boolean {
    if (b.kind === "helm") return p.role === "helm"
    if (b.kind === "gun") return p.role === "gunner" && p.mount === b.mount
    return p.role === "pilot" && p.plane >= 0
  }

  private kill(id: number): void {
    const b = this.bots.get(id)
    if (!b) return
    const f = this.room.combat().fighters.get(id)
    if ((b.kind === "jet" || b.kind === "boat") && f?.alive) {
      b.dying = true
      this.room.combat().hurt(id, 1e4, -1, "gun")
    } else if (b.kind === "gun" || b.kind === "helm") this.remove(id)
  }

  private remove(id: number): void {
    const b = this.bots.get(id)
    if (!b) return
    if (b.kind === "jet" && b.gun) this.room.handle(id, { type: "gun", on: false })
    if (b.kind === "jet" && b.seek.on >= 0) this.room.handle(id, { type: "seek", on: -1, locked: false })
    this.bots.delete(id)
    const crew = this.room.crew()
    const ship = crew && shipOf(crew, playerOf(crew, id)?.ship ?? -1)
    this.room.drop(id)
    if (ship && trimSlots(ship)) this.room.sendCrew()
    this.sendList(this.room.now(), true)
  }

  /** Every bot gone (the room forgot its world). */
  clear(): void {
    this.bots.clear()
    this.bullets.clear()
    this.turretRounds.clear()
    this.boatRounds.clear()
    this.listed = 0
  }

  /**
   * A combat event the room is about to apply: damage to an invulnerable bot is undone (its health stays full, the
   * kill never happens) and the event dropped. Its own crash still counts. Returns true to drop it.
   */
  absorb(e: CombatEvent): boolean {
    if (e.k !== "hp" && e.k !== "kill") return false
    const b = this.bots.get(e.on)
    if (!b || !b.s.invulnerable || b.dying || (e.by < 0 && e.w === "")) return false
    const f = this.room.combat().fighters.get(e.on)
    if (f) {
      f.hp = WEAPONS.health.max
      f.sent = f.hp
      f.alive = true
    }
    return true
  }

  /** Runs every bot to sea time t (room ms `now`). */
  step(t: number, now: number): void {
    const crew = this.room.crew()
    if (!crew) return
    for (const id of [...this.bots.keys()]) if (!playerOf(crew, id)) this.bots.delete(id)
    if (!this.bots.size && !this.bullets.live && !this.turretRounds.live && !this.boatRounds.live) {
      this.t = t
      if (this.listed) this.sendList(now, true)
      return
    }
    if (t - this.t > 2) this.t = t - DT
    const targets = this.room.targets(t)
    this.jetTargets.length = 0
    for (const tg of targets) this.jetTargets.push(tg)
    for (const b of this.bots.values()) this.prepare(b, crew, t, now)
    const ground = { sea: this.room.sea(), arch: this.room.arch(), ships: this.room.hulls() }
    this.collectStores()
    this.collectBoats()
    while (this.t + DT <= t + 1e-9) {
      this.t += DT
      const back = this.t - t
      for (const b of this.bots.values()) {
        if (b.kind === "jet") this.jetTick(b, back, ground)
        else if (b.kind === "boat") this.boatTick(b)
        else if (b.kind === "gun") this.gunTick(b, back, ground)
      }
      const now = this.sub(back)
      this.bullets.step(DT, this.t, now, ground, (owner, target, kind, _x, _y, _z, ship) => {
        const b = this.bots.get(owner)
        if (!b || b.kind !== "jet") return
        if (kind === "jet") b.hits.set(target, (b.hits.get(target) ?? 0) + 1)
        else if (kind === "ship" && ship?.id !== undefined && ship.team !== this.teamOf(owner)) b.shipHits.set(ship.id, (b.shipHits.get(ship.id) ?? 0) + 1)
      })
      this.turretRounds.step(DT, this.t, now, this.stores, ground, (owner, kind, target, _x, _y, _z, ship) => {
        const b = this.bots.get(owner)
        if (!b || b.kind !== "gun") return
        if (kind === "jet") b.hits.set(target, (b.hits.get(target) ?? 0) + 1)
        else if (kind === "store") {
          const s = this.stores[target]
          if (s && !b.claims.some((c) => c[0] === s.owner && c[1] === s.seq)) b.claims.push([s.owner, s.seq, s.store])
        } else if (kind === "ship" && ship?.id !== undefined && ship.team !== this.teamOf(owner)) b.shipHits.set(ship.id, (b.shipHits.get(ship.id) ?? 0) + 1)
      })
      this.boatRounds.step(DT, this.t, now, this.boatTargets, ground, (owner, kind, id, _x, _y, _z, ship) => {
        const b = this.bots.get(owner)
        if (!b || b.kind !== "boat") return
        const key = kind === "jet" ? `${BOAT_HIT.jet}:${id}` : kind === "boat" ? `${BOAT_HIT.boat}:${id}` : kind === "ship" && ship?.id !== undefined && ship.team !== this.teamOf(owner) ? `${BOAT_HIT.ship}:${ship.id}` : ""
        if (key) b.hits.set(key, (b.hits.get(key) ?? 0) + 1)
      })
    }
    for (const b of this.bots.values()) this.report(b, crew)
    this.sendList(now, false)
  }

  /** The fight's jets and boats moved on to this sub-step (`back` s before the room's time: negative). */
  private sub(back: number): Target[] {
    const out = this.subTargets
    out.length = 0
    for (let i = 0; i < this.jetTargets.length; i++) {
      const tg = this.jetTargets[i]!
      const s = (this.subPool[i] ??= { id: 0, team: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, alive: true })
      Object.assign(s, tg)
      s.surface = tg.surface
      s.x = tg.x + tg.vx * back
      s.y = tg.y + tg.vy * back
      s.z = tg.z + tg.vz * back
      out.push(s)
    }
    return out
  }

  private teamOf(id: number): number {
    const crew = this.room.crew()
    return (crew && playerOf(crew, id)?.team) ?? -1
  }

  /** Enemy missiles, bombs, SAMs and shells as a CIWS sees them. */
  private collectStores(): void {
    this.stores.length = 0
    let k = 0
    for (const m of this.room.combat().missiles) if (m.alive) this.stores.push(asInterceptable(m, 0, (this.storePool[k++] ??= { store: 0, owner: 0, seq: 0, team: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 })))
    this.room.gunnery().interceptables(this.stores)
  }

  private collectBoats(): void {
    this.boatTargets.length = 0
    const combat = this.room.combat()
    for (const [id, s] of this.room.boats()) {
      const f = combat.fighters.get(id)
      if (!f || s.mode !== BOAT_MODE.drive) continue
      const [vx, vz] = boatVelocity(s.boat)
      this.boatTargets.push({ id, team: f.team, pose: s.boat, vx, vz, alive: f.alive })
    }
  }

  /** Per room step: keeps each bot at its post (launching, respawning) and follows the crew. */
  private prepare(b: Bot, crew: Crew, t: number, now: number): void {
    const p = playerOf(crew, b.id)!
    b.ship = p.ship
    if (b.kind === "jet") {
      if (p.plane < 0) {
        // Back on deck (recovered, or its ship sank under it): launch again if it should.
        if (b.phase !== "wait") b.phase = "wait"
        if (b.sortie >= 0 && !b.s.respawn) {
          b.state = "on deck"
          return
        }
        if (this.post(b, crew, now)) this.sortie(b, p, t)
      } else if (b.sortie !== p.sortie) this.sortie(b, p, t)
      return
    }
    if (b.kind === "boat") {
      if (p.plane < 0) {
        if (b.sortie >= 0 && !b.s.respawn) {
          b.state = "on deck"
          return
        }
        if (this.post(b, crew, now)) {
          b.sortie = p.sortie
          b.placed = false
        }
      } else if (b.sortie !== p.sortie) {
        b.sortie = p.sortie
        b.placed = false
      }
      return
    }
    this.post(b, crew, now)
  }

  /** A fresh jet: in the air at its start point, or on the catapult. */
  private sortie(b: JetBot, p: CrewPlayer, t: number): void {
    b.sortie = p.sortie
    b.loadout = makeLoadout(b.vehicle)
    b.lock = { target: -1, time: 0, locked: false }
    b.flared.clear()
    b.run = "in"
    b.doors = 0
    b.phi = 0
    const ship = this.room.sim(p.ship)
    if (b.start === "deck" && ship) {
      const { launch } = startLaunch(ship, b.plane, b.vehicle)
      b.launch = launch
      b.phase = "deck"
      b.state = "launch"
      return
    }
    const [x, y, z, h] = b.at
    const pl = b.plane
    Object.assign(pl, makePlane(t), { x, y, z, throttle: PLANE.cruise })
    setPlaneQuat(pl, quatMul(quatAxis(0, 1, 0, Math.PI - h, [0, 0, 0, 1]), quatAxis(1, 0, 0, 0, [0, 0, 0, 1])))
    const speed = clamp(b.s.speed, VEHICLES[b.vehicle].flight.stallSpeed + 30, 200)
    pl.vx = Math.sin(h) * speed
    pl.vz = -Math.cos(h) * speed
    b.launch = null
    b.phase = "fly"
    b.state = "flying"
  }

  // ---- jets ---------------------------------------------------------------------------------------------------------

  private jetTick(b: JetBot, back: number, ground: { sea: Sea | null; arch: Archipelago | null; ships: readonly (GroundShip & Ship)[] }): void {
    const p = b.plane
    const spec = VEHICLES[b.vehicle]
    if (b.phase === "deck") {
      const ship = this.room.sim(b.ship)
      if (!b.launch || !ship) return
      if (launchStep(b.launch, p, ship, DT)) {
        b.phase = "fly"
        b.state = "flying"
      }
      return
    }
    if (b.phase !== "fly") {
      p.t += DT
      return
    }
    const f = this.room.combat().fighters.get(b.id)
    if (!f || !f.alive) {
      // Shot down: the wreck is everyone's to draw; the sortie ends after the usual wait.
      this.down(b)
      return
    }
    this.brain(b, back, f.team)
    planeStep(p, b.c, DT, ground, spec.flight, spec.probes)
    if (p.crashed) {
      this.down(b)
      return
    }
    loadoutStep(b.loadout, DT)
    this.cannon(b, f.team)
  }

  private down(b: JetBot): void {
    b.phase = "down"
    b.downAt = this.t
    b.state = "down"
    b.dying = false
    if (b.seek.on >= 0) {
      b.seek = { on: -1, locked: false }
      this.room.handle(b.id, { type: "seek", on: -1, locked: false })
    }
  }

  /** The gun: rounds leave the muzzle along the boresight while the brain holds the trigger. */
  private cannon(b: JetBot, team: number): void {
    const p = b.plane
    const trigger = b.trigger && b.s.weapons
    const n = gunStep(b.loadout, trigger, DT)
    if (trigger !== b.gun) {
      b.gun = trigger
      this.room.handle(b.id, { type: "gun", on: trigger })
    }
    if (!n) return
    const m = WEAPONS.gun.muzzleAt
    const at = bodyToWorld(p, m[0], m[1], m[2], tmp)
    const f = bodyToWorld(p, 0, 0, 1, tmp2)
    const u = bodyToWorld(p, 0, 1, 0, tmp3)
    const l: [number, number, number] = [f[1] * u[2] - f[2] * u[1], f[2] * u[0] - f[0] * u[2], f[0] * u[1] - f[1] * u[0]]
    const v: [number, number, number] = [p.vx, p.vy, p.vz]
    for (let i = 0; i < n; i++) this.bullets.fire(b.id, team, b.loadout.round++, p.x + at[0], p.y + at[1], p.z + at[2], v, [f[0], f[1], f[2]], [u[0], u[1], u[2]], l, (i / n) * DT)
    if (b.s.ammo) b.loadout.heat = Math.min(b.loadout.heat, 0.5)
  }

  /** The nearest enemy jet worth chasing (the set target first), or null. Positions at this sub-step. */
  private pickJet(b: JetBot, team: number): Target | null {
    const p = b.plane
    let best: Target | null = null
    let score = Infinity
    for (const tg of this.jetTargets) {
      if (!tg.alive || tg.surface || tg.team === team || tg.id === b.id) continue
      if (b.s.target >= 0 && tg.id === b.s.target) return tg
      const d = Math.hypot(tg.x - p.x, tg.y - p.y, tg.z - p.z)
      const sp = planeSpeed(p) || 1
      const ahead = ((tg.x - p.x) * p.vx + (tg.y - p.y) * p.vy + (tg.z - p.z) * p.vz) / (d * sp || 1)
      const s = d * (1.6 - 0.6 * ahead)
      if (s < score) {
        score = s
        best = tg
      }
    }
    return best
  }

  /** The ship to attack: the set one if it is an enemy afloat, else the nearest enemy carrier. */
  private pickShip(x: number, z: number, team: number, want: number): (GroundShip & Ship) | null {
    let best: (GroundShip & Ship) | null = null
    let d = Infinity
    for (const h of this.room.hulls()) {
      if (h.team === team) continue
      if (h.id === want) return h
      const e = Math.hypot(h.x - x, h.z - z)
      if (e < d) {
        d = e
        best = h
      }
    }
    return best
  }

  /** One step of a jet's brain: sets `b.c` (the stick) and `b.trigger`, launches missiles, bombs and flares. */
  private brain(b: JetBot, back: number, team: number): void {
    const p = b.plane
    const c = b.c
    const s = b.s
    const gain = 0.55 + 0.45 * s.skill
    b.trigger = false
    b.target = -1
    const ground = this.groundAt(p.x, p.z)
    const ahead = this.groundAt(p.x + p.vx * 3, p.z + p.vz * 3)
    const floor = Math.max(ground, ahead) + 90
    const breaking = this.threat(b, team)
    // Pull out first: too low, or sinking into the ground within three seconds.
    if (p.y < floor || p.y + Math.min(0, p.vy) * 3.5 < floor) {
      navigate(p, c, Math.atan2(p.vx, -p.vz), floor + 400, 0.35, 1)
      c.throttle = 1
      c.boost = true
      b.note = "pull up"
      return
    }
    if (breaking) return
    switch (s.behavior) {
      case "straight": {
        const h = Math.hypot(p.x, p.z) > HOME ? bearing(p.x, p.z, 0, 0) : b.at[3]
        navigate(p, c, h, s.alt, 0.8, gain)
        holdSpeed(p, c, s.speed, false)
        b.note = `straight ${Math.round(s.alt)} m`
        break
      }
      case "orbit":
      case "evasive":
        this.orbit(b, gain)
        if (s.behavior === "evasive") this.jink(b, gain)
        break
      case "eight":
        this.eight(b, gain)
        break
      case "dogfight":
        this.dogfight(b, team, gain, back)
        break
      case "bomber":
        this.bomber(b, team, gain)
        break
    }
  }

  private groundAt(x: number, z: number): number {
    const arch = this.room.arch()
    return arch ? Math.max(0, terrainHeight(arch, x, z)) : 0
  }

  /** Patterns are centred so the start point lies on them: the orbit's centre is `radius` to the right of the start. */
  private orbit(b: JetBot, gain: number): void {
    const p = b.plane
    const s = b.s
    const [ax, , az, h] = b.at
    const cx = ax + Math.cos(h) * s.radius
    const cz = az + Math.sin(h) * s.radius
    const rx = p.x - cx
    const rz = p.z - cz
    const r = Math.hypot(rx, rz) || 1
    // Clockwise seen from above: the tangent, turned in or out by the radius error.
    let tx = -rz / r
    let tz = rx / r
    const err = clamp((r - s.radius) / 400, -1, 1)
    tx -= (rx / r) * err
    tz -= (rz / r) * err
    navigate(p, b.c, Math.atan2(tx, -tz), s.alt, 1.1, gain)
    holdSpeed(p, b.c, s.speed, false)
    b.note = `orbit r ${Math.round(s.radius)} m`
  }

  /** A figure-eight (a lemniscate along the start heading) at the set height: chase a point running round it. */
  private eight(b: JetBot, gain: number): void {
    const p = b.plane
    const s = b.s
    const [ax, , az, h] = b.at
    const R = s.radius
    b.phi += (planeSpeed(p) / (R * 1.6)) * DT
    const point = (phi: number) => {
      const along = R * Math.sin(phi)
      const across = R * Math.sin(phi) * Math.cos(phi)
      return [ax + Math.sin(h) * along + Math.cos(h) * across, az - Math.cos(h) * along + Math.sin(h) * across] as const
    }
    // Keep the carrot ahead of the jet: step the phase until it is a few seconds away.
    let lead = 0.25
    let q = point(b.phi + lead)
    while (Math.hypot(q[0] - p.x, q[1] - p.z) < planeSpeed(p) * 2.5 && lead < 1.5) {
      lead += 0.1
      q = point(b.phi + lead)
    }
    navigate(p, b.c, bearing(p.x, p.z, q[0], q[1]), s.alt, 1.15, gain)
    holdSpeed(p, b.c, s.speed, false)
    b.note = `figure-eight r ${Math.round(R)} m`
  }

  /** Evasive: random hard turns and height changes on top of the pattern, more often with skill. */
  private jink(b: JetBot, gain: number): void {
    const p = b.plane
    const s = b.s
    if (this.t >= b.jinkAt) {
      const k = hash01(b.id, Math.floor(this.t * 10))
      b.jinkTurn = (k < 0.5 ? -1 : 1) * (0.7 + 1.2 * hash01(b.id + 1, Math.floor(this.t * 10)))
      b.jinkAlt = (hash01(b.id + 2, Math.floor(this.t * 10)) - 0.5) * 400
      b.jinkUntil = this.t + 1.5 + 1.5 * hash01(b.id + 3, Math.floor(this.t))
      b.jinkAt = b.jinkUntil + lerp(7, 1.5, s.skill) * (0.6 + 0.8 * k)
    }
    if (this.t < b.jinkUntil) {
      const a = planeAttitude(p, att)
      navigate(p, b.c, a.heading + b.jinkTurn, s.alt + b.jinkAlt, 1.35, gain)
      b.c.throttle = 1
      b.c.boost = s.aggression > 0.4
      b.note = "evasive: jink"
    } else b.note = `evasive r ${Math.round(s.radius)} m`
  }

  /**
   * Missiles on us: break across the nearest one with the burner and spend flares (once per missile, with a chance
   * that grows with skill); a seeker held on us too long draws flares too. Returns true while it is breaking.
   */
  private threat(b: JetBot, team: number): boolean {
    const p = b.plane
    const s = b.s
    const combat = this.room.combat()
    b.lockedFor = this.room.seekers(b.id) > 0 ? b.lockedFor + DT : 0
    if (b.lockedFor === 0) b.lockFlared = false
    if (s.behavior === "straight" || s.behavior === "orbit" || s.behavior === "eight") return false
    let near: (typeof combat.missiles)[number] | null = null
    let d = Infinity
    for (const m of combat.missiles) {
      if (!m.alive || m.kind !== "missile" || m.target !== b.id) continue
      const e = Math.hypot(m.x - p.x, m.y - p.y, m.z - p.z)
      if (e < d) {
        d = e
        near = m
      }
    }
    const reads = hash01(b.id, near ? near.owner * 977 + near.seq : 0) < 0.35 + 0.65 * s.skill
    if (s.flares && b.lockedFor > lerp(3, 1.2, s.skill) && !b.lockFlared && reads) {
      b.lockFlared = true
      this.flare(b, team)
    }
    if (!near || d > 2600 || !reads) return false
    const key = `${near.owner}:${near.seq}`
    if (s.flares && d < 700 + 900 * s.skill && !b.flared.has(key)) {
      b.flared.add(key)
      this.flare(b, team)
    }
    // Break: turn to put the missile on the beam, nose a little low, burner.
    const from = bearing(near.x, near.z, p.x, p.z)
    const a = planeAttitude(p, att)
    const left = wrap(from - Math.PI / 2 - a.heading)
    const right = wrap(from + Math.PI / 2 - a.heading)
    const turn = Math.abs(left) < Math.abs(right) ? from - Math.PI / 2 : from + Math.PI / 2
    navigate(p, b.c, turn, Math.max(this.groundAt(p.x, p.z) + 250, p.y - 150), 1.4, 1)
    b.c.throttle = 1
    b.c.boost = true
    b.note = `break: missile ${Math.round(d)} m`
    return true
  }

  private flare(b: JetBot, team: number): void {
    const p = b.plane
    if (b.s.ammo) b.loadout.flares = Math.max(1, b.loadout.flares)
    if (!takeFlares(b.loadout)) return
    const f = this.room.combat().fighters.get(b.id)
    if (b.s.ammo && f) f.flares = Math.max(1, f.flares)
    void team
    this.room.handle(b.id, { type: "flare", f: [p.t, p.x, p.y, p.z, p.vx, p.vy, p.vz] })
  }

  private dogfight(b: JetBot, team: number, gain: number, back: number): void {
    const p = b.plane
    const c = b.c
    const s = b.s
    const tg = this.pickJet(b, team)
    if (!tg) {
      this.orbit(b, gain)
      b.note = "dogfight: searching"
      this.seeker(b, team, null)
      return
    }
    b.target = tg.id
    // The target as of this sub-step.
    const tx = tg.x + tg.vx * back
    const ty = tg.y + tg.vy * back
    const tz = tg.z + tg.vz * back
    const dx = tx - p.x
    const dy = ty - p.y
    const dz = tz - p.z
    const d = Math.hypot(dx, dy, dz)
    const sp = planeSpeed(p)
    const closing = -((tg.vx - p.vx) * dx + (tg.vy - p.vy) * dy + (tg.vz - p.vz) * dz) / (d || 1)
    // Gun lead: time of flight at muzzle speed plus ours, gravity drop.
    const tof = d / (WEAPONS.gun.muzzle + sp)
    let ax = tx + tg.vx * tof
    let ay = ty + tg.vy * tof + 0.5 * G * WEAPONS.gun.gravity * tof * tof
    let az = tz + tg.vz * tof
    // Aim error: a slow wander off the lead point that shrinks with accuracy.
    const wob = (1 - s.accuracy) * d * 0.03
    ax += Math.sin(this.t * 0.9 + b.coin * 7) * wob
    ay += Math.cos(this.t * 1.3 + b.coin * 11) * wob
    az += Math.sin(this.t * 1.1 + b.coin * 5) * wob
    let off: number
    if (d < 120 + 160 * (1 - s.aggression) && closing > 20) {
      // About to overshoot: lag pursuit, throttle back.
      off = pursue(p, c, tx - tg.vx * 1.2, ty + 40, tz - tg.vz * 1.2, gain)
      c.throttle = -1
      c.boost = false
    } else if (d > 1800) {
      off = pursue(p, c, tx + tg.vx * 1.5, ty + tg.vy * 1.5, tz + tg.vz * 1.5, gain)
      holdSpeed(p, c, s.aggression > 0.5 ? 230 : Math.max(s.speed, 175), s.aggression > 0.35)
    } else {
      off = pursue(p, c, ax, ay, az, gain)
      const want = Math.hypot(tg.vx, tg.vy, tg.vz) + clamp((d - 450) * 0.08, -40, 50)
      holdSpeed(p, c, clamp(want, 110, 230), s.aggression > 0.6 && d > 900)
    }
    if (d < 60) c.pitch = 1
    // Guns: in range and the nose on the lead point (a tighter cone with accuracy).
    const range = (WEAPONS.gun.muzzle + sp) * WEAPONS.gun.life * (0.55 + 0.3 * s.aggression)
    const aim = pursueError(p, ax, ay, az)
    const cone = 0.012 + (1 - s.accuracy) * 0.05
    b.trigger = LOADOUTS[b.vehicle].weapons.includes("gun") && d < range && aim < cone
    void off
    this.seeker(b, team, tg)
    b.note = `dogfight → #${tg.id} ${(d / 1000).toFixed(1)} km`
  }

  /** The AIM-9's seeker and launches: lock what the nose holds, fire once locked (paced by aggression). */
  private seeker(b: JetBot, team: number, tg: Target | null): void {
    const p = b.plane
    const s = b.s
    b.missileIn -= DT
    if (!s.weapons || !b.loadout.spec.missiles) return
    const f = bodyToWorld(p, 0, 0, 1, tmp)
    Object.assign(this.shooter, { x: p.x, y: p.y, z: p.z, fx: f[0], fy: f[1], fz: f[2], team })
    const combat = this.room.combat()
    const changed = lockStep(b.lock, DT, this.shooter, tg ? [tg] : [], (id) => combat.blind(id))
    if (changed) {
      const on = b.lock.target
      b.seek = { on, locked: b.lock.locked }
      this.room.handle(b.id, { type: "seek", on, locked: b.lock.locked })
    }
    if (!b.lock.locked || b.missileIn > 0 || !tg) return
    const d = Math.hypot(tg.x - p.x, tg.y - p.y, tg.z - p.z)
    if (d < 400) return
    if (s.ammo) b.loadout.missiles = Math.max(1, b.loadout.missiles)
    const seq = takeMissile(b.loadout)
    if (seq < 0) return
    b.missileIn = lerp(16, 3, s.aggression)
    const fighter = combat.fighters.get(b.id)
    if (s.ammo && fighter) fighter.missiles = Math.max(1, fighter.missiles)
    const r = railOf(seq, b.vehicle)
    const at = bodyToWorld(p, r[0], r[1], r[2], tmp)
    this.room.handle(b.id, { type: "fire", m: [seq, p.t, p.x + at[0], p.y + at[1], p.z + at[2], p.vx, p.vy, p.vz, b.lock.target, 0] })
  }

  /**
   * Bomb runs on a carrier. The F-35C flies level at the set height toward the release point (where the ship will be
   * when a bomb dropped now lands, less the bomb's own travel), checks the world's own bomb prediction and releases
   * while it lands on the target, then extends and comes round again. A Hornet strafes it with the gun instead.
   */
  private bomber(b: JetBot, team: number, gain: number): void {
    const p = b.plane
    const s = b.s
    const ship = this.pickShip(p.x, p.z, team, s.targetShip)
    if (!ship) {
      this.orbit(b, gain)
      b.note = "bomber: no target"
      return
    }
    b.target = ship.id ?? -1
    const [svx, , svz] = shipPointVel(ship, tmp2)
    const d = Math.hypot(ship.x - p.x, ship.z - p.z)
    const bombs = LOADOUTS[b.vehicle].bombs > 0
    if (b.run === "out") {
      // Extend away, climbing back to height, then turn in again.
      const away = bearing(ship.x, ship.z, p.x, p.z)
      navigate(p, b.c, Math.hypot(p.x, p.z) > HOME ? bearing(p.x, p.z, 0, 0) : away, s.alt, 0.9, gain)
      holdSpeed(p, b.c, s.speed, false)
      b.doors = Math.max(0, b.doors - DT / 0.6)
      if (d > 3200 && (!bombs || b.loadout.bombs > 0 || s.ammo)) b.run = "in"
      b.note = `bomber: extending ${(d / 1000).toFixed(1)} km`
      return
    }
    if (!bombs) {
      // Strafe: dive on the ship, guns from 1.2 km, pull out low.
      const ty = 15
      const off = pursue(p, b.c, ship.x + svx * 1.5, ty, ship.z + svz * 1.5, gain)
      holdSpeed(p, b.c, s.speed, false)
      b.trigger = d < 1300 && off < 0.04 + (1 - s.accuracy) * 0.05 && s.weapons
      if (d < 450 || p.y < 160) b.run = "out"
      b.note = `strafe → ${(d / 1000).toFixed(1)} km`
      return
    }
    const fall = Math.sqrt((2 * Math.max(50, p.y - 20)) / G)
    const rx = ship.x + svx * fall - p.vx * fall
    const rz = ship.z + svz * fall - p.vz * fall
    const toRelease = Math.hypot(rx - p.x, rz - p.z)
    navigate(p, b.c, bearing(p.x, p.z, rx, rz), s.alt, 0.9, gain)
    holdSpeed(p, b.c, s.speed, false)
    const near = d < 2500
    b.doors = near ? Math.min(1, b.doors + DT / 0.6) : Math.max(0, b.doors - DT / 0.6)
    b.note = `bomber → ${(d / 1000).toFixed(1)} km`
    if (near && s.weapons && --b.bombCheck <= 0) {
      b.bombCheck = 4
      const spec = LOADOUTS[b.vehicle]
      if (s.ammo) b.loadout.bombs = Math.max(1, b.loadout.bombs)
      if (b.loadout.bombs > 0 && b.loadout.launchIn <= 0 && b.doors >= 1) {
        const l = bombLaunch(p, b.vehicle, b.loadout.bombs, spec.bombs, this.ml)
        bombImpact({ sea: this.room.sea(), arch: this.room.arch() }, [ship], l, this.impact)
        // Accuracy: a sloppier bomber releases on a near miss too.
        const miss = (1 - s.accuracy) * 60
        const close = this.impact.kind === "ship" ? true : Math.hypot(this.impact.x - (ship.x + svx * this.impact.time), this.impact.z - (ship.z + svz * this.impact.time)) < miss
        if (this.impact.ship === 0 || close) {
          const seq = takeBomb(b.loadout)
          if (seq >= 0) {
            const fighter = this.room.combat().fighters.get(b.id)
            if (s.ammo && fighter) fighter.bombs = Math.max(1, fighter.bombs)
            this.room.handle(b.id, { type: "fire", m: [seq, l.t, l.x, l.y, l.z, l.vx, l.vy, l.vz, -1, 1] })
          }
        }
      }
    }
    // Past the release point (it is behind us) or out of bombs: extend.
    const behind = (rx - p.x) * p.vx + (rz - p.z) * p.vz < 0
    if ((behind && toRelease > 250) || (b.loadout.bombs === 0 && !s.ammo)) b.run = "out"
  }

  // ---- boats --------------------------------------------------------------------------------------------------------

  private boatOf(id: number): { boat: Boat; mode: BoatMode } | undefined {
    for (const [k, v] of this.room.boats()) if (k === id) return v
    return undefined
  }

  private boatTick(b: BoatBot): void {
    const sim = this.boatOf(b.id)
    if (!sim) {
      b.state = b.state === "driving" ? "on deck" : b.state
      return
    }
    const boat = sim.boat
    if (sim.mode !== BOAT_MODE.drive) {
      b.ctl = [0, 0, 0]
      b.firing = false
      b.state = sim.mode === BOAT_MODE.launch ? "launch" : sim.mode === BOAT_MODE.sunk ? "sinking" : "recovery"
      return
    }
    b.state = "driving"
    if (!b.placed) {
      b.placed = true
      // An "air" start drops it in the water at its start point instead of beside its carrier.
      if (b.start === "air") {
        boat.x = b.at[0]
        boat.z = b.at[2]
        boat.heading = b.at[3]
      }
    }
    const s = b.s
    const team = this.teamOf(b.id)
    let steerTo: number | null = null
    let throttle = s.throttle
    let aim: [number, number, number] | null = null
    let dist = Infinity
    b.target = -1
    if (s.behavior === "patrol") {
      const [ax, , az] = b.at
      const rx = boat.x - ax
      const rz = boat.z - az
      const r = Math.hypot(rx, rz) || 1
      const R = Math.min(s.radius, 900)
      let tx = -rz / r
      let tz = rx / r
      const err = clamp((r - R) / 150, -1, 1)
      tx -= (rx / r) * err
      tz -= (rz / r) * err
      steerTo = Math.atan2(tx, -tz)
      b.note = `patrol r ${Math.round(R)} m`
    } else if (s.behavior === "attack") {
      // A set player's jet or boat, else the nearest enemy boat, else the target (or nearest) enemy carrier.
      let tgt: { x: number; y: number; z: number; vx: number; vy: number; vz: number; id: number } | null = null
      for (const t of this.jetTargets) if (t.alive && t.team !== team && t.id === s.target) tgt = t
      if (!tgt) {
        let d = 2500
        for (const t of this.boatTargets)
          if (t.alive && t.team !== team && t.id !== b.id) {
            const e = Math.hypot(t.pose.x - boat.x, t.pose.z - boat.z)
            if (e < d) {
              d = e
              tgt = { x: t.pose.x, y: t.pose.heave + 1.5, z: t.pose.z, vx: t.vx, vy: 0, vz: t.vz, id: t.id }
            }
          }
      }
      if (tgt) {
        b.target = tgt.id
        dist = Math.hypot(tgt.x - boat.x, tgt.z - boat.z)
        steerTo = dist > 350 ? bearing(boat.x, boat.z, tgt.x + tgt.vx * 2, tgt.z + tgt.vz * 2) : bearing(boat.x, boat.z, tgt.x, tgt.z) + Math.PI / 2
        const tof = dist / GUN.muzzle
        aim = [tgt.x + tgt.vx * tof, tgt.y + tgt.vy * tof + 0.5 * G * tof * tof, tgt.z + tgt.vz * tof]
        b.note = `attack → #${tgt.id} ${Math.round(dist)} m`
      } else {
        const ship = this.pickShip(boat.x, boat.z, team, s.targetShip)
        if (ship) {
          b.target = ship.id ?? -1
          dist = Math.hypot(ship.x - boat.x, ship.z - boat.z)
          // Run in, then circle the hull at ~400 m, gun on its island.
          const b0 = bearing(ship.x, ship.z, boat.x, boat.z)
          steerTo = dist > 700 ? bearing(boat.x, boat.z, ship.x, ship.z) : b0 + Math.PI / 2 + clamp((dist - 400) / 300, -0.6, 0.6)
          aim = [ship.x, ship.heave + 30, ship.z]
          b.note = `attack → ship ${(dist / 1000).toFixed(1)} km`
        } else b.note = "attack: no target"
      }
    } else {
      throttle = 0
      b.note = "idle"
    }
    // Stay off the beaches: turn away from shallow water ahead.
    const arch = this.room.arch()
    if (arch && steerTo !== null) {
      const h = boat.heading
      if (terrainHeight(arch, boat.x + Math.sin(h) * 120, boat.z - Math.cos(h) * 120) > -3) steerTo = h + Math.PI / 2
    }
    const steer = steerTo === null ? 0 : clamp(wrap(steerTo - boat.heading) * 2, -1, 1)
    b.ctl = [throttle, steer, s.aggression > 0.7 && Math.abs(steer) < 0.3 && dist > 600 ? 1 : 0]
    // The turret: slew onto the aim point and fire when on it, in range.
    const pose = boat
    if (aim) turretStep(b.tr, pose, aim[0], aim[1], aim[2], DT)
    else turretStep(b.tr, pose, boat.x + Math.sin(boat.heading) * 100, boat.heave + 3, boat.z - Math.cos(boat.heading) * 100, DT)
    const trigger = !!aim && s.weapons && dist < 1100 && b.tr.onTarget
    b.firing = trigger
    const n = turretGun(b.tr, trigger, DT)
    if (n) {
      const pos = v3()
      const dir = v3()
      boatMuzzle(pose, b.tr.yaw, b.tr.pitch, pos, dir)
      const [vx, vz] = boatVelocity(boat)
      for (let i = 0; i < n; i++) this.boatRounds.fire(b.id, team, b.tr.round++, pos[0], pos[1], pos[2], dir[0], dir[1], dir[2], vx, vz)
      if (s.ammo) b.tr.heat = Math.min(b.tr.heat, 0.5)
    }
  }

  // ---- gunners ------------------------------------------------------------------------------------------------------

  private gunTick(b: GunBot, back: number, ground: { sea: Sea | null; arch: Archipelago | null; ships: readonly (GroundShip & Ship)[] }): void {
    const g = this.room.gunnery().gunners.get(b.id)
    const ship = ground.ships.find((h) => h.id === b.ship)
    if (!g || !ship) {
      b.firing = false
      return
    }
    b.state = "manned"
    const s = b.s
    const kind = WEAPON_MOUNTS[b.mount]!.kind
    mountStep(b.ts, DT)
    const pos = v3()
    const dir = v3()
    mountMuzzle(ship, b.mount, b.aim.yaw, b.aim.pitch, pos, dir)
    const sv = shipPointVel(ship, v3())
    b.firing = false
    b.target = -1
    if (s.behavior !== "engage") {
      slewTurret(b.aim, b.mount, WEAPON_MOUNTS[b.mount]!.restYaw, WEAPON_MOUNTS[b.mount]!.restPitch, DT)
      b.note = "hold"
      return
    }
    // Targets: the CIWS takes inbound stores first, then jets and boats; the SAM only jets; the gun jets, boats, ships.
    const range = kind === "ciws" ? GUNNERY.ciws.range : kind === "sam" ? GUNNERY.sam.range : 7500
    let best: { x: number; y: number; z: number; vx: number; vy: number; vz: number; id: number; ship?: boolean } | null = null
    let bd = range
    if (kind === "ciws")
      for (const st of this.stores) {
        if (st.team === g.team) continue
        const e = Math.hypot(st.x - pos[0], st.y - pos[1], st.z - pos[2])
        if (e < Math.min(bd, 1400)) {
          bd = e
          best = { ...st, id: -1 }
        }
      }
    if (!best)
      for (const tg of this.jetTargets) {
        if (!tg.alive || tg.team === g.team || (kind === "sam" && tg.surface)) continue
        if (s.target >= 0 && tg.id !== s.target) continue
        const e = Math.hypot(tg.x - pos[0], tg.y - pos[1], tg.z - pos[2])
        if (e < bd) {
          bd = e
          best = { x: tg.x + tg.vx * back, y: tg.y + tg.vy * back, z: tg.z + tg.vz * back, vx: tg.vx, vy: tg.vy, vz: tg.vz, id: tg.id }
        }
      }
    if (!best && kind === "gun") {
      const sh = this.pickShip(ship.x, ship.z, g.team, s.targetShip)
      if (sh && sh.id !== b.ship && Math.hypot(sh.x - ship.x, sh.z - ship.z) < 8000) {
        const v = shipPointVel(sh, v3())
        best = { x: sh.x, y: sh.heave + 14, z: sh.z, vx: v[0], vy: 0, vz: v[2], id: sh.id ?? -1, ship: true }
        bd = Math.hypot(sh.x - pos[0], sh.z - pos[2])
      }
    }
    if (!best) {
      slewTurret(b.aim, b.mount, WEAPON_MOUNTS[b.mount]!.restYaw, WEAPON_MOUNTS[b.mount]!.restPitch, DT)
      b.note = "searching"
      return
    }
    b.target = best.id
    const speed = kind === "ciws" ? GUNNERY.ciws.muzzle : kind === "gun" ? GUNNERY.gun.muzzle : GUNNERY.sam.topSpeed * 0.7
    const lead = v3()
    leadPoint(pos[0], pos[1], pos[2], sv[0], sv[1], sv[2], speed, best.x, best.y, best.z, best.vx, best.vy, best.vz, kind === "sam" ? 0 : 1, lead)
    // Aim error shrinks with accuracy; the gun walks its elevation onto a ship by where its last shell would land.
    const wob = (1 - s.accuracy) * bd * 0.02
    lead[0] += Math.sin(this.t * 0.8 + b.coin * 9) * wob
    lead[1] += Math.cos(this.t * 1.1 + b.coin * 3) * wob
    const local = toLocalDir(ship, lead[0] - pos[0], lead[1] - pos[1], lead[2] - pos[2], v3())
    const want = anglesOf(local[0], local[1], local[2])
    if (best.ship) {
      if ((b.refineIn -= DT) <= 0) {
        b.refineIn = 0.5
        const hit = predictImpact(pos[0], pos[1], pos[2], sv[0] + dir[0] * speed, sv[1] + dir[1] * speed, sv[2] + dir[2] * speed, this.t, { sea: ground.sea, arch: ground.arch }, undefined, b.ship)
        const short = Math.hypot(best.x - pos[0], best.z - pos[2]) - Math.hypot(hit.x - pos[0], hit.z - pos[2])
        b.bias = clamp(b.bias + short * 0.00002, -0.2, 0.6)
      }
      want.pitch += b.bias
    }
    const on = slewTurret(b.aim, b.mount, want.yaw, want.pitch, DT)
    if (!s.weapons) {
      b.note = `tracking ${Math.round(bd)} m`
      return
    }
    if (kind === "ciws") {
      const trigger = on && bd < GUNNERY.ciws.range
      b.firing = trigger
      const n = ciwsStep(b.ts, trigger, DT)
      for (let i = 0; i < n; i++) this.turretRounds.fire(b.id, g.team, b.ship, b.ts.round++, pos[0], pos[1], pos[2], sv, dir, (i / Math.max(1, n)) * DT)
      if (s.ammo) {
        b.ts.heat = Math.min(b.ts.heat, 0.5)
        g.rounds = Math.max(g.rounds, GUNNERY.ciws.rate * 0.6)
      }
    } else if (kind === "sam") {
      const tgs = this.jetTargets.filter((x) => x.id === best!.id)
      samLockStep(b.ts.lock, DT, pos[0], pos[1], pos[2], dir[0], dir[1], dir[2], g.team, tgs, (id) => this.room.combat().blind(id))
      if (b.ts.lock.locked && on) {
        if (s.ammo) {
          b.ts.cells = Math.max(1, b.ts.cells)
          g.cells = Math.max(1, g.cells)
        }
        const cell = takeSam(b.ts)
        if (cell >= 0) {
          mountMuzzle(ship, b.mount, b.aim.yaw, b.aim.pitch, pos, dir, cell)
          const e = GUNNERY.sam.eject
          this.room.handle(b.id, { type: "gfire", g: packGunFire({ owner: b.id, seq: b.ts.seq++, kind: "sam", ship: b.ship, mount: b.mount, t: this.t, x: pos[0], y: pos[1], z: pos[2], vx: sv[0] + dir[0] * e, vy: sv[1] + dir[1] * e, vz: sv[2] + dir[2] * e, target: b.ts.lock.target }) })
        }
      }
      b.firing = b.ts.lock.locked
    } else if (on && bd > 300) {
      if (s.ammo) g.shells = Math.max(1, g.shells)
      if (takeShell(b.ts)) {
        const m = GUNNERY.gun.muzzle
        this.room.handle(b.id, { type: "gfire", g: packGunFire({ owner: b.id, seq: b.ts.seq++, kind: "shell", ship: b.ship, mount: b.mount, t: this.t, x: pos[0], y: pos[1], z: pos[2], vx: sv[0] + dir[0] * m, vy: sv[1] + dir[1] * m, vz: sv[2] + dir[2] * m, target: -1 }) })
        b.firing = true
      }
    }
    b.note = `${kind} → ${best.id >= 0 ? `#${best.id}` : "store"} ${Math.round(bd)} m`
  }

  // ---- helm ---------------------------------------------------------------------------------------------------------

  private helm(b: HelmBot, crew: Crew): void {
    const p = playerOf(crew, b.id)
    const sim = this.room.sim(b.ship)
    if (!p || p.role !== "helm" || !sim) return
    b.state = "helm"
    const s = b.s
    let throttle = s.throttle
    let rudder = 0
    if (s.behavior === "stop") {
      throttle = 0
      b.note = "all stop"
    } else if (s.behavior === "circle") {
      rudder = 0.6
      b.note = "circling"
    } else if (s.behavior === "chase") {
      const ship = this.pickShip(sim.x, sim.z, p.team, s.targetShip)
      if (ship) {
        rudder = clamp(wrap(bearing(sim.x, sim.z, ship.x, ship.z) - sim.heading) * 1.5, -1, 1)
        b.note = `chase → ${(Math.hypot(ship.x - sim.x, ship.z - sim.z) / 1000).toFixed(1)} km`
      } else b.note = "chase: no target"
    } else b.note = `cruise ${Math.round(throttle * 100)}%`
    // Islands: steer for the deeper side when land is ahead; the map's edge: turn for home.
    const arch = this.room.arch()
    if (arch && s.behavior !== "stop") {
      const h = sim.heading
      const probe = (a: number, d: number) => terrainHeight(arch, sim.x + Math.sin(h + a) * d, sim.z - Math.cos(h + a) * d)
      if (Math.max(probe(0, 700), probe(0, 1300)) > -8) rudder = probe(-0.5, 900) < probe(0.5, 900) ? -1 : 1
    }
    if (Math.hypot(sim.x, sim.z) > HOME) rudder = clamp(wrap(bearing(sim.x, sim.z, 0, 0) - sim.heading) * 1.5, -1, 1)
    this.room.handle(b.id, { type: "helm", o: Math.round(throttle * 1000) / 1000, r: Math.round(rudder * 1000) / 1000 })
  }

  // ---- reports ------------------------------------------------------------------------------------------------------

  /** Per room step: what a client would send for this bot (its jet, hits, boat orders, turret aim, helm orders). */
  private report(b: Bot, crew: Crew): void {
    if (b.kind === "helm") return this.helm(b, crew)
    if (b.kind === "jet") {
      const p = b.plane
      if (b.phase === "down" && this.t - b.downAt >= LAUNCH.respawnDelay) {
        b.phase = "wait"
        this.room.handle(b.id, { type: "recover", how: "crashed" })
        return
      }
      if (b.phase === "deck" || b.phase === "fly" || b.phase === "down") this.room.handle(b.id, { type: "plane", p: this.tuple(b) })
      b.flushIn -= 0.05
      if (b.flushIn <= 0) {
        b.flushIn = FLUSH
        for (const [on, n] of b.hits) this.room.handle(b.id, { type: "hits", on, n: Math.min(200, n) })
        for (const [ship, n] of b.shipHits) this.room.handle(b.id, { type: "shiphits", ship, n: Math.min(200, n) })
        b.hits.clear()
        b.shipHits.clear()
      }
      return
    }
    if (b.kind === "boat") {
      if (this.boatOf(b.id)) {
        const r = (v: number) => Math.round(v * 1000) / 1000
        this.room.handle(b.id, { type: "boat", c: [r(b.ctl[0]), r(b.ctl[1]), b.ctl[2], Math.round(b.tr.yaw * 1000), Math.round(b.tr.pitch * 1000), b.firing ? 1 : 0] })
      }
      b.flushIn -= 0.05
      if (b.flushIn <= 0) {
        b.flushIn = FLUSH
        for (const [key, n] of b.hits) {
          const [k, on] = key.split(":").map(Number) as [number, number]
          this.room.handle(b.id, { type: "bhits", k, on, n: Math.min(60, n) })
        }
        b.hits.clear()
      }
      return
    }
    b.aimIn -= 0.05
    if (b.aimIn <= 0 && this.room.gunnery().gunners.has(b.id)) {
      b.aimIn = GUNNERY.aimEvery
      const a = packAim(b.aim.yaw, b.aim.pitch, b.firing)
      this.room.handle(b.id, { type: "aim", a })
    }
    b.flushIn -= 0.05
    if (b.flushIn <= 0) {
      b.flushIn = FLUSH
      for (const [on, n] of b.hits) this.room.handle(b.id, { type: "thits", on, n: Math.min(300, n) })
      for (const [ship, n] of b.shipHits) this.room.handle(b.id, { type: "tshiphits", ship, n: Math.min(300, n) })
      for (const i of b.claims) this.room.handle(b.id, { type: "intercept", i })
      b.hits.clear()
      b.shipHits.clear()
      b.claims.length = 0
    }
  }

  private tuple(b: JetBot): PlaneTuple {
    const p = b.plane
    const r = (v: number, k: number) => Math.round(v * k) / k
    const mode = b.phase === "deck" ? PLANE_MODE.deck : b.phase === "fly" ? PLANE_MODE.flying : PLANE_MODE.crashed
    return [
      r(p.t, 1e3),
      mode,
      r(mode === PLANE_MODE.deck ? (b.launch?.z ?? 0) : p.x, 1e2),
      r(p.y, 1e2),
      r(p.z, 1e2),
      r(p.qx, 1e4),
      r(p.qy, 1e4),
      r(p.qz, 1e4),
      r(p.qw, 1e4),
      r(p.vx, 10),
      r(p.vy, 10),
      r(p.vz, 10),
      r(b.phase === "deck" ? (b.launch?.throttle ?? p.throttle) : p.throttle, 100),
      b.phase === "deck" ? (b.launch?.burner ?? 0) : p.boosting,
      b.phase === "deck" ? 1 : 0,
      r(clamp(b.c.pitch, -1, 1), 100),
      r(clamp(b.c.roll, -1, 1), 100),
      0,
      r(b.doors, 100),
    ]
  }

  /** The bot list for the panel. */
  list(): BotInfo[] {
    const combat = this.room.combat()
    return [...this.bots.values()].map((b) => ({ id: b.id, name: b.name, role: b.role, ship: b.ship, group: b.group, state: b.state.slice(0, 24), note: b.note.slice(0, 64), hp: Math.round(combat.fighters.get(b.id)?.hp ?? 0), s: { ...b.s } }))
  }

  private sendList(now: number, force: boolean): void {
    if (!force && now - this.listAt < LIST_MS) return
    if (!this.bots.size && !this.listed) return
    this.listAt = now
    this.listed = this.bots.size
    this.room.sendAll(encode({ type: "bots", b: this.list() }))
  }
}

/** The angle (rad) between the jet's nose and the line to (x, y, z). */
function pursueError(p: Plane, x: number, y: number, z: number): number {
  const f = bodyToWorld(p, 0, 0, 1, tmp3)
  const dx = x - p.x
  const dy = y - p.y
  const dz = z - p.z
  const d = Math.hypot(dx, dy, dz) || 1
  return Math.acos(clamp((f[0] * dx + f[1] * dy + f[2] * dz) / d, -1, 1))
}

/** Drops free slots past a ship's catalogue from the end (extra ones bots took). Returns true if any went. */
function trimSlots(s: { aircraft: { pilot: number | null }[] }): boolean {
  const base = makeSlots().length
  let gone = false
  while (s.aircraft.length > base && s.aircraft[s.aircraft.length - 1]!.pilot === null) {
    s.aircraft.pop()
    gone = true
  }
  return gone
}

