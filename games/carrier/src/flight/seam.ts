import { type Crew, type RecoverHow, TEAMS, playerOf } from "../../shared/crew"
import type { Archipelago } from "../../shared/islands"
import { PLANE, makePlane, planeSpeed } from "../../shared/plane"
import { PLANE_MODE, type PlaneTuple } from "../../shared/protocol"
import { type Sea, seaHeight } from "../../shared/sea"
import type { Ship } from "../../shared/ship"
import type { Camera } from "../render/camera"
import { PlaneFx } from "../render/plane-fx"
import { type PlaneModels, loadPlaneModels } from "../render/plane-glb"
import { type PlaneDrawPose, PlanePass } from "../render/plane-pass"
import type { Renderer } from "../render/renderer"
import { playerTeamColor, shipTeamColor } from "../render/team"
import { WeaponFx } from "../render/weapon-fx"
import { Explosions, seeded, seedOf } from "../render/explosions"
import { terrainHeight } from "../../shared/islands"
import { WeaponAudio } from "../audio/weapon-audio"
import { JetAudio } from "../audio/jet-audio"
import { drawnShips } from "../audio/ship-audio"
import type { Net } from "../net"
import { WeaponHud } from "../weapons/hud"
import { WeaponInput } from "../weapons/input"
import { Weapons, type WeaponsNet } from "../weapons/weapons"
import { type KillWeapon, type Target, isKillWeapon } from "../../shared/weapons"
import type { CombatWorld } from "../../shared/combat"
import { playerVehicle } from "../../shared/ops"
import { type VehicleKind, vehicleCode, vehicleOfCode } from "../../shared/vehicles"
import { Flight } from "./flight"
import { landTarget } from "../../shared/landing"
import { landingVehicle } from "../../shared/vehicles"
import type { DrawnShip } from "../game/game"
import type { Hull } from "../../shared/fleet"
import { ShipHud } from "../weapons/ship-hud"
import { FlightHud } from "./hud"
import { FlightInput } from "./input"
import { RemotePlanes } from "./remote-planes"

/** What the flight module needs from the connection: the jet relay, the weapon events and the room's combat queue. */
export type FlightNet = Pick<Net, "state" | "id" | "sendPlane" | "sendGun" | "sendHits" | "sendShipHits" | "sendFire" | "sendFlare" | "sendSeek" | "combat">

const r1 = (v: number, k: number) => Math.round(v * k) / k

/** Own jet relay interval (s): 20 Hz. */
const SEND_EVERY = 0.05

export type FlightStart = {
  ship: number
  slot: number
  /** The aircraft type of the slot (the crew's when absent). */
  vehicle?: VehicleKind
  /** The pilot's carrier as drawn this frame. */
  deck: () => Ship | null
  /** The flight ended; `ship`: the friendly carrier it landed on, when not its own. */
  recover: (how: RecoverHow, ship?: number) => void
  /** Every carrier as simulated here, to crash into. */
  ships?: () => readonly Ship[]
}

/** What the game passes every frame, whatever this player is doing. */
export type FlightFrame = {
  t: number
  dt: number
  paused: boolean
  crew: Crew | null
  /** Other players' jets as relayed. */
  planes: ReadonlyMap<number, PlaneTuple>
  /** A carrier as drawn this frame, by crew ship id. */
  ship: (id: number) => Ship | null
  /** Every carrier as drawn this frame (settled by its damage), with its id and team. */
  ships?: readonly DrawnShip[]
  /** Every carrier's health and fires (shared/fleet.ts), by ship id. */
  hulls?: ReadonlyMap<number, Hull>
  eye: ArrayLike<number>
}

/**
 * The flight module in the real game (game.ts FlightSeam). LAUNCH HORNET in the SHIP OPERATIONS menu asks
 * the room for an aircraft slot; once granted, `start` puts a jet on this player's carrier and runs the catapult launch
 * on the carrier as drawn, then hands the stick over. R, or the respawn delay after a crash, recovers the player to
 * the deck. The jet is relayed to the room at 20 Hz; everyone else's jets are drawn here, interpolated, including their
 * catapult runs on our copy of their carriers.
 */
export class FlightModule {
  readonly input: FlightInput
  readonly hud: FlightHud
  readonly flight: Flight
  readonly remotes = new RemotePlanes()
  private pass: PlanePass | null = null
  private fx: PlaneFx | null = null
  private sea: Sea | null = null
  private arch: Archipelago | null = null
  private ctx: FlightStart | null = null
  private sendIn = 0
  private pose: PlaneDrawPose | null = null
  private matrix = new Float32Array(16)
  private tuple: PlaneTuple = [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0]
  private models: PlaneModels | null = null
  private world = { sea: null as Sea | null, arch: null as Archipelago | null, ships: [] as readonly Ship[] }
  /** Every carrier as drawn last frame (with its team) and every hull: where the jet may land (shared/landing.ts). */
  private drawnShips: readonly DrawnShip[] = []
  private hulls: ReadonlyMap<number, Hull> | null = null
  private seaT = 0
  /** Own ship health, the damage flash and enemy ship health in the air (src/weapons/ship-hud.ts). */
  readonly shipHud = new ShipHud()
  private recovering = false
  /** Granted before the hull was drawn: place the jet on the first deck seen. */
  private unplaced = false
  /** Guns, missiles, flares and everyone's weapon effects (src/weapons/weapons.ts). */
  readonly weapons: Weapons
  /** Every jet's engine, flybys, catapult, trap and cockpit sound (src/audio/jet-audio.ts). */
  readonly audio = new JetAudio()
  private weaponsNet: WeaponsNet
  private weaponInput: WeaponInput
  private wasArmed = false
  private crew: Crew | null = null
  /** Each other pilot's last seen sortie: a new one is a fresh jet with full health and stores. */
  private sorties = new Map<number, number>()
  /** Jet breakups, crashes and their fire, smoke, spray and debris (src/render/explosions.ts). */
  readonly boom: Explosions
  /** Our own crash has had its explosion; each remote crash (by its first crashed pose's time) too. */
  private ownBoom = false
  private remoteBooms = new Map<number, number>()

  constructor(
    private renderer: Renderer,
    private camera: Camera,
    canvas: HTMLCanvasElement,
    private net: FlightNet,
  ) {
    this.input = new FlightInput(canvas)
    this.hud = new FlightHud()
    this.flight = new Flight(this.input, this.hud, [0, 2.74, 4.35])
    const wfx = new WeaponFx(renderer)
    renderer.addPass("alpha", wfx)
    this.weaponsNet = {
      gun: (on) => this.net.sendGun(on),
      hits: (target, n) => this.net.sendHits(target, n),
      launch: (l) => this.net.sendFire([l.seq, r1(l.t, 1e3), r1(l.x, 100), r1(l.y, 100), r1(l.z, 100), r1(l.vx, 100), r1(l.vy, 100), r1(l.vz, 100), l.target, l.kind === "bomb" ? 1 : 0]),
      flare: (t, x, y, z, vx, vy, vz) => this.net.sendFlare([r1(t, 1e3), r1(x, 100), r1(y, 100), r1(z, 100), r1(vx, 100), r1(vy, 100), r1(vz, 100)]),
      lock: (target, locked) => this.net.sendSeek(target, locked),
      shipHits: (ship, n) => this.net.sendShipHits(ship, n),
    }
    this.weaponInput = new WeaponInput(canvas)
    this.weapons = new Weapons(wfx, new WeaponHud(), new WeaponAudio(), this.weaponInput, null)
    this.boom = new Explosions(renderer)
    // Shot-down jets break apart (seeded by pilot and sortie, so every client sees the same pieces).
    this.weapons.breakup = {
      airKill: (id, kind, j) => {
        this.boom.airKill(this.seedFor(id), kind, playerTeamColor(this.crew, id), j, id)
        return true
      },
      wreckHit: (id, hit, x, y, z, vx, vy, vz) => this.boom.wreckImpact(this.seedFor(id), id, hit, x, y, z, vx, vy, vz),
      random: (id) => seeded(this.seedFor(id) ^ 0x7ec4),
    }
    this.weapons.resolve = (id) => {
      const p = this.crew && playerOf(this.crew, id)
      return p ? { name: p.name, color: TEAMS[p.team]?.color ?? "#f4f7fb" } : null
    }
    // Falling bombs wear the F-35C's own store mesh (the only type that carries them).
    this.weapons.drawBomb = (x, y, z, vx, vy, vz) => {
      this.pass?.addStore("f35", 0, x, y, z, vx, vy, vz)
      return !!this.pass
    }
    // Shot down: the jet is lost like a crash; the respawn delay then recovers it ("crashed": the slot recharges).
    this.weapons.onDestroyed = () => this.flight.shootDown()
    void loadPlaneModels().then((m) => {
      this.models = m
      this.pass = new PlanePass(renderer, m)
      this.fx = new PlaneFx(renderer, m)
      this.boom.setModels(m)
      renderer.addPass("opaque", this.pass)
      renderer.addPass("alpha", this.fx)
      this.flight.eyeModel = m[this.flight.vehicle].eye
    })
  }

  setNet(net: FlightNet): void {
    this.net = net
  }

  setWorld(sea: Sea, arch: Archipelago): void {
    this.sea = sea
    this.arch = arch
    this.world.sea = sea
    this.world.arch = arch
    this.weapons.setGround(this.world)
    this.boom.world = this.world
    this.boom.wind = [sea.wind[0] * 4, sea.wind[1] * 4]
  }

  get phase(): string {
    return this.flight.phase
  }

  start(ctx: FlightStart): void {
    this.ctx = ctx
    this.recovering = false
    const ship = ctx.deck()
    const f = this.flight
    f.vehicle = ctx.vehicle ?? playerVehicle(this.crew, this.net.id)
    if (this.models) f.eyeModel = this.models[f.vehicle].eye
    f.onRespawn = () => this.recover("crashed")
    // Landed on another friendly carrier: the room moves the pilot aboard it if it has room.
    f.onLanded = () => {
      const on = f.landingShip?.id
      this.recover("landed", on !== undefined && on !== this.ctx?.ship ? on : undefined)
    }
    this.unplaced = !ship
    if (ship) f.toDeck(ship)
    else {
      Object.assign(f.plane, makePlane())
      f.phase = "deck"
    }
    f.requestLaunch()
    f.cam.reset()
    const me = this.crew && playerOf(this.crew, this.net.id)
    this.weapons.setPilot(this.net.id, me?.team ?? 0, me?.name ?? "YOU", TEAMS[me?.team ?? 0]?.color ?? "#f4f7fb")
    this.hud.homeColor = TEAMS[me?.team ?? 0]?.color ?? "#f4f7fb"
    this.weapons.sortie(f.vehicle)
  }

  stop(): void {
    this.ctx = null
    this.pose = null
    this.recovering = false
    this.weaponInput.flaresBlocked = false
    this.flight.idle()
    this.weapons.land()
    this.wasArmed = false
  }

  private recover(how: RecoverHow, ship?: number): void {
    if (!this.ctx || this.recovering) return
    this.recovering = true
    this.ctx.recover(how, ship)
  }

  /** Steps the jet to sea time t and drives the camera. False until the jet exists. */
  update(dt: number, t: number, aspect: number, paused = false): boolean {
    const ctx = this.ctx
    const f = this.flight
    if (!ctx || f.phase === "idle") return false
    const deck = ctx.deck()
    f.readInput(dt, paused)
    // "F LAND": near a friendly carrier with an open deck, F lands (and drops no flares).
    const me = this.crew && playerOf(this.crew, this.net.id)
    const target = f.phase === "flying" && me ? landTarget(f.plane, f.airborne, this.drawnShips, me.team, this.hulls, this.seaT, landingVehicle(f.vehicle)) : null
    f.landPrompt = !!target
    this.weaponInput.flaresBlocked = !!target
    if (target && !paused && this.input.land) f.land(target)
    if (deck) {
      // The first sight of the deck places the jet (start may have come before the hull was drawn).
      if (this.unplaced) {
        this.unplaced = false
        f.toDeck(deck)
        f.requestLaunch()
      }
      if (t - f.plane.t > 2 || t < f.plane.t - 1) f.plane.t = t - PLANE.tick
      this.world.ships = ctx.ships?.() ?? [deck]
      while (f.plane.t + PLANE.tick <= t) {
        f.tick(deck, this.world)
        // Weapons ride along while the jet flies (and while it lands: a target, but nothing fires).
        const live = f.phase === "flying" || f.phase === "landing"
        if (live) this.weapons.tick(f.plane, f.phase === "flying")
        else if (this.wasArmed) {
          if (f.phase === "crashed" && f.plane.crashed !== "shot") this.weapons.crashed()
          else this.weapons.land()
        }
        this.wasArmed = live
      }
    }
    if (this.weapons.trauma > 0) {
      f.shake(this.weapons.trauma)
      this.weapons.trauma = 0
    }
    // Explosions nearby shake the camera too (presentation only).
    const bang = this.boom.takeTrauma()
    if (bang > 0) f.shake(bang)
    // Shot down: the crash camera follows the falling wreck.
    const wreck = f.phase === "crashed" ? this.weapons.ownWreck : null
    if (wreck)
      for (const p of [f.plane, f.prev]) {
        p.x = wreck.x
        p.y = wreck.y
        p.z = wreck.z
      }
    const k = Math.max(0, Math.min(1, (t - f.plane.t) / PLANE.tick))
    const sea = this.sea
    const arch = this.arch
    // The crash camera's floor: the sea, or the land under it.
    this.pose = f.frame(dt, k, aspect, (x, z) => Math.max(sea ? seaHeight(sea, x, z, t) : 0, arch ? terrainHeight(arch, x, z) + 45 : -1e9), { w: innerWidth, h: innerHeight }, deck)
    const cam = f.cam
    this.camera.lookAlong(cam.eye, cam.forward, cam.up, cam.fov, aspect)

    this.sendIn -= dt
    if (this.sendIn <= 0) {
      this.sendIn = SEND_EVERY
      this.send(t)
    }
    return true
  }

  private send(t: number): void {
    const f = this.flight
    const p = f.draw
    const s = this.tuple
    const r = (v: number, k: number) => Math.round(v * k) / k
    s[0] = r(t, 1e3)
    const mode = f.mode
    const l = f.landing
    s[1] = mode === 1 ? PLANE_MODE.flying : mode === 2 ? PLANE_MODE.crashed : mode === 3 ? PLANE_MODE.landing : PLANE_MODE.deck
    if (mode === 3 && l) {
      // Ship-local pose: every client places it on its own copy of the hull.
      s[2] = r(l.x, 1e2)
      s[3] = r(l.y, 1e2)
      s[4] = r(l.z, 1e2)
      s[5] = r(l.yaw, 1e4)
      s[6] = r(l.pitch, 1e4)
      s[7] = r(l.bank, 1e4)
      // qw carries the carrier it lands on when that isn't its own (0: own), so others place it on the right hull.
      const on = f.landingShip?.id ?? 0
      s[8] = on !== this.ctx?.ship ? on : 0
    } else {
      s[2] = r(mode === 0 ? (f.launch?.z ?? 0) : p.x, 1e2)
      s[3] = r(p.y, 1e2)
      s[4] = r(p.z, 1e2)
      s[5] = r(p.qx, 1e4)
      s[6] = r(p.qy, 1e4)
      s[7] = r(p.qz, 1e4)
      s[8] = r(p.qw, 1e4)
    }
    s[9] = r(p.vx, 10)
    s[10] = r(p.vy, 10)
    s[11] = r(p.vz, 10)
    s[12] = r(this.pose?.throttle ?? p.throttle, 100)
    s[13] = this.pose?.burner ?? 0
    s[14] = r(this.pose?.gear ?? 1, 100)
    s[15] = r(this.pose?.pitch ?? 0, 100)
    s[16] = r(this.pose?.roll ?? 0, 100)
    s[17] = vehicleCode(f.vehicle)
    s[18] = r(this.weapons.doors, 100)
    this.net.sendPlane(s)
  }

  /** Every frame, after the camera is placed: every jet drawn. (Launching is the SHIP OPERATIONS menu's job.) */
  frame(v: FlightFrame): void {
    const airborne = this.ctx !== null && this.flight.phase !== "idle"
    if (!airborne) this.hud.update(null)

    this.remotes.sync(v.planes, v.crew)
    this.crew = v.crew
    const me = v.crew && playerOf(v.crew, this.net.id)
    // A jet rescued from a sunk carrier flies on as a pilot of the ship it was moved to.
    if (this.ctx && me && me.ship !== this.ctx.ship && me.plane >= 0) this.ctx.ship = me.ship
    const hulls = v.hulls
    this.hulls = hulls ?? null
    this.seaT = v.t
    if (v.ships) {
      this.world.ships = v.ships
      this.drawnShips = v.ships
    }
    if (v.crew)
      for (const p of v.crew.players) {
        if (p.id === this.net.id || p.plane < 0) continue
        if (this.sorties.get(p.id) !== p.sortie) {
          this.sorties.set(p.id, p.sortie)
          this.weapons.respawned(p.id)
        }
      }
    const pass = this.pass
    const fx = this.fx
    const w = this.weapons
    w.setNet(this.net.state === "offline" ? null : this.weaponsNet)
    this.input.endFrame()
    w.beginJets()
    if (pass && fx) {
      pass.begin()
      fx.begin(v.eye, v.t)
    }
    const camNow = airborne && this.flight.phase !== "crashed" ? this.flight.cam : null
    this.boom.begin(v.dt, v.t, v.eye, camNow?.fov ?? this.camera.fov, innerHeight, v.ships)
    const f = this.flight
    if (airborne && this.pose && this.ctx) {
      this.pose.accent = shipTeamColor(v.crew, this.ctx.ship)
      this.pose.kind = f.vehicle
      this.pose.doors = w.doors
      this.pose.stores = w.loadout.bombs
      const m = pass ? pass.modelMatrix(this.pose, this.matrix) : null
      if (pass && fx && m) {
        pass.add(this.pose)
        fx.plane(-1, m, this.pose.throttle, this.pose.burner, this.flight.vapour, f.vehicle)
      }
      w.setOwnModel(f.phase === "flying" || f.phase === "landing" ? m : null)
    } else w.setOwnModel(null)
    this.audio.own(airborne ? f : null, this.pose)
    // A crash breaks the jet up where it hit (once). A jet that was shot down already has its breakup and burning
    // wreck: no crash for it.
    const crashed = airborne && f.phase === "crashed" ? f.plane.crashed : ""
    if (crashed === "sea" || crashed === "land" || crashed === "ship") {
      if (!this.ownBoom) {
        this.ownBoom = true
        const p = f.plane
        this.boom.crash(this.seedFor(this.net.id), f.vehicle, this.pose?.accent ?? shipTeamColor(v.crew, this.ctx?.ship ?? -1), crashed, p)
      }
    } else if (f.phase !== "crashed") this.ownBoom = false
    for (const c of this.remotes.crashes(v.t))
      if (!w.recentlyKilled(c.id)) {
        const s = c.snap
        if (this.remoteBooms.get(c.id) !== s[0] && c.age < 3) {
          this.remoteBooms.set(c.id, s[0])
          const g = this.boom.surfaceHeight(c.x, c.z, c.y + 3)
          const hit = g.kind === "ship" ? "ship" : g.kind === "land" && c.y < g.h + 20 ? "land" : "sea"
          this.boom.crash(this.seedFor(c.id), vehicleOfCode(s[17]), playerTeamColor(v.crew, c.id), hit, { x: c.x, y: c.y, z: c.z, vx: s[9], vy: s[10], vz: s[11], qx: s[5], qy: s[6], qz: s[7], qw: s[8] })
        }
        this.audio.crash(c.id, c.x, c.y, c.z, c.age, c.y < 6)
      }
    for (const [id, pose] of this.remotes.poses(v.t, v.ship)) {
      pose.accent = playerTeamColor(v.crew, id)
      const snaps = this.remotes.jets.get(id)!.snaps
      const last = snaps[snaps.length - 1]!
      const kind = vehicleOfCode(last[17])
      const m = pass ? pass.modelMatrix(pose, this.matrix) : undefined
      const p = v.crew && playerOf(v.crew, id)
      const live = last[1] === PLANE_MODE.flying || last[1] === PLANE_MODE.landing
      const jet = w.jet(id, p?.team ?? 0, pose, last[9], last[10], last[11], live, p?.name ?? `#${id}`, TEAMS[p?.team ?? 0]?.color ?? "#f4f7fb", kind, m)
      pose.stores = jet.rack.bombs
      this.audio.remote(id, pose, last)
      if (pass && fx && m) {
        pass.add(pose)
        const speed = Math.hypot(last[9], last[10], last[11])
        const g = (speed * PLANE.pitchRate * Math.abs(pose.pitch)) / 9.81
        fx.plane(id, m, pose.throttle, pose.burner, last[1] === 1 ? Math.max(0, Math.min(1, (g - 7) / 5)) : 0, kind)
      }
    }
    this.combat()
    this.audio.ships(drawnShips(v.crew?.ships ?? [], v.ship))
    this.audio.frame(v.dt, v.eye, this.camera.forward, this.camera.upDir)
    if (pass) for (const [id, wp] of w.wreckPoses()) {
      wp.accent = playerTeamColor(v.crew, id)
      // A broken-up wreck is drawn by the explosions (what is left of it, burning).
      if (!this.boom.drawWreck(id, wp)) pass.add(wp)
    }
    const cam = airborne && f.phase !== "crashed" ? f.cam : null
    if (v.ships) w.fleet(v.ships, hulls ?? null, me?.team ?? -1, v.t, v.dt)
    this.shipHud.update(v.dt, v.t, me ?? null, v.crew, v.ships ?? [], hulls ?? null, cam, airborne && (f.phase === "flying" || f.phase === "landing"), v.paused)
    w.frame(v.dt, v.t, v.eye, cam?.fov ?? this.camera.fov, innerHeight, (x, y, z) => (cam ? cam.project(x, y, z, innerWidth, innerHeight) : null), v.paused)
    this.boom.end()
    if (pass && fx) {
      pass.upload()
      fx.upload()
    }
  }

  /** The breakup seed of jet `id`'s current sortie: the same on every client. */
  private seedFor(id: number): number {
    const p = this.crew && playerOf(this.crew, id)
    return seedOf(id, p?.sortie ?? 0, 0xb00)
  }

  /** The room's combat messages since last frame, into the weapons. */
  private combat(): void {
    const q = this.net.combat
    if (!q.length) return
    const w = this.weapons
    for (const m of q) {
      switch (m.type) {
        case "gun":
          w.remoteGun(m.id, m.on)
          break
        case "fire": {
          const a = m.m
          w.remoteLaunch({ owner: m.id, seq: a[0], t: a[1], x: a[2], y: a[3], z: a[4], vx: a[5], vy: a[6], vz: a[7], target: a[8], kind: a[9] === 1 ? "bomb" : "missile" })
          break
        }
        case "flare":
          w.remoteFlare(m.id, m.f[0], m.f[1], m.f[2], m.f[3], m.f[4], m.f[5], m.f[6])
          break
        case "seek":
          w.lockedBy(m.by, m.s === 0 ? null : m.s === 2)
          break
        case "boom": {
          const b = m.b
          w.apply({ k: "boom", owner: b[0], seq: b[1], x: b[2], y: b[3], z: b[4], on: b[5], water: b[6] === 1, bomb: b[7] === 1 })
          break
        }
        case "hp":
          w.apply({ k: "hp", on: m.id, hp: m.hp, by: m.by, w: weaponKind(m.w) })
          break
        case "kill":
          w.apply({ k: "kill", on: m.on, by: m.by, w: weaponKind(m.w) })
          break
        case "sunk":
          w.sunk(m.ship, m.name, m.team, m.by)
          break
      }
    }
    q.length = 0
  }

  /** Every other jet as the weapons saw it this frame, and the jets' combat world: what the ship guns shoot at. */
  targets(): { jets: readonly Target[]; world: CombatWorld } {
    const list = this.targetList
    list.length = 0
    for (const j of this.weapons.jets.values()) list.push(j)
    return { jets: list, world: this.weapons.world }
  }
  private targetList: Target[] = []

  /** For scripts: every carrier as drawn last frame (settled), with its id and team. */
  get carriers(): readonly Ship[] {
    return this.world.ships
  }

  /** For scripts: the weapons' state (selected weapon, heat, stores, lock, health, nearest inbound missile). */
  get weaponStatus(): Weapons["status"] {
    return this.weapons.status
  }

  /** For scripts: the jet's speed (m/s) and phase. */
  get status(): { phase: string; speed: number; crashed: string } {
    return { phase: this.flight.phase, speed: planeSpeed(this.flight.plane), crashed: this.flight.plane.crashed }
  }
}

const weaponKind = (w: string): KillWeapon | "" => (isKillWeapon(w) ? w : "")
