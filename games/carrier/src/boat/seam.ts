import {
  BOAT,
  BOAT_DAMAGE,
  BOAT_HIT,
  BOAT_MODE,
  type BoatTarget,
  boatVelocity,
  copyBoat,
  extrapolateBoat,
  muzzleWorld,
  unpackBoat,
} from "../../shared/boat"
import type { Ground, GroundShip } from "../../shared/combat"
import { DECK_ROUND } from "../../shared/deck-jets"
import { worldToShip } from "../../shared/plane"
import { type Crew, type RecoverHow, teamCss, playerOf } from "../../shared/crew"
import type { Archipelago } from "../../shared/islands"
import type { Sea } from "../../shared/sea"
import type { Target } from "../../shared/weapons"
import { BoatAudio } from "../audio/boat-audio"
import type { DrawnShip } from "../game/game"
import type { Input } from "../input"
import type { Net } from "../net"
import { BoatFx } from "../render/boat-fx"
import { loadBoatModel } from "../render/boat-glb"
import { type BoatDrawPose, BoatPass } from "../render/boat-pass"
import { BoatWake } from "../render/boat-wake"
import type { Camera } from "../render/camera"
import type { Renderer } from "../render/renderer"
import { playerTeamColor, teamColor } from "../render/team"
import { WeaponFx } from "../render/weapon-fx"
import type { Weapons } from "../weapons/weapons"
import { BOAT_RADAR_RPS, BoatDriver, type BoatShip } from "./boat"
import { BoatInput } from "./input"
import { RemoteBoats } from "./remote-boats"

/** What the boat module needs from the connection. */
export type BoatNetLike = Pick<Net, "state" | "id" | "boats" | "sendBoat" | "sendBoatHits" | "sendDeckHits">

/** The predicted boat glides onto the room's pose over this lag (s); further apart than SNAP m, it jumps. */
const CORRECT_LAG = 0.8
const SNAP = 35
/** Reported hits go out this often (s). */
const HIT_EVERY = 0.1

export type BoatStart = {
  ship: number
  slot: number
  /** The driver's carrier as drawn this frame (settled), with its plan velocity, id and team. */
  home: () => DrawnShip | null
  /** The sortie ended (offline only: online the room ends it). */
  recover: (how: RecoverHow) => void
}

/** What the game passes every frame, whatever this player is doing. */
export type BoatFrame = {
  t: number
  dt: number
  paused: boolean
  crew: Crew | null
  /** A carrier as drawn this frame, by crew ship id. */
  ship: (id: number) => DrawnShip | null
  ships: readonly DrawnShip[]
  /** Enemy and friendly jets as the jets' weapons see them (our rounds hit the enemy ones). */
  jets: readonly Target[]
  eye: ArrayLike<number>
  fov: number
}

/**
 * The boat in the real game (game.ts BoatSeam), like the flight module for jets. LAUNCH BOAT in DEPLOY gives
 * the player the ship's boat slot; `start` puts the boat under the crane on their carrier, which lowers it over the port
 * side; then they drive and shoot it (src/boat/boat.ts) until the room picks it up alongside (back to their old role) or
 * it sinks. Online the room runs the authoritative sim (server/core.ts): the driver predicts it here on the same shared
 * code and glides onto the room's pose, and the room decides the pickup and the sinking. Every other boat is drawn here
 * from the room's `boats` frames (src/boat/remote-boats.ts). Boats are targets for everyone's guns, blasts and shells,
 * never for heat-seekers (`targets()`, `surface`).
 */
export class BoatModule {
  readonly input: BoatInput
  readonly audio = new BoatAudio()
  readonly driver: BoatDriver
  readonly remotes = new RemoteBoats()
  readonly wfx: WeaponFx
  readonly fx: BoatFx
  readonly wake: BoatWake
  private pass: BoatPass | null = null
  private sea: Sea | null = null
  private arch: Archipelago | null = null
  private ctx: BoatStart | null = null
  private recovering = false
  /** The jets' weapons (src/weapons/weapons.ts): health from the room, the kill feed, and boats as their targets. */
  weapons: Weapons | null = null
  private targetList: Target[] = []
  private boatTargets: BoatTarget[] = []
  private ground: Ground = { sea: null, arch: null, ships: [] }
  private pending = new Map<string, { k: number; on: number; n: number; slot?: number }>()
  private hitIn = 0
  private ctl: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0]
  private target = { x: 0, z: 0, heading: 0 }
  private lastHp = 100
  private crew: Crew | null = null
  private pose: BoatDrawPose = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, radar: 0, yaw: 0, gun: 0, nozzle: 0 }
  private homeShip: BoatShip | null = null
  private mp: [number, number, number] = [0, 0, 0]
  private md: [number, number, number] = [0, 0, 0]

  constructor(
    renderer: Renderer,
    gameInput: Input,
    canvas: HTMLCanvasElement,
    private net: BoatNetLike,
  ) {
    this.input = new BoatInput(gameInput, canvas)
    this.driver = new BoatDriver(this.input, undefined, this.audio)
    this.wfx = new WeaponFx(renderer)
    this.fx = new BoatFx(this.wfx)
    this.wake = new BoatWake(renderer)
    renderer.addPass("alpha", this.wake)
    renderer.addPass("alpha", this.wfx)
    void loadBoatModel().then((m) => {
      this.pass = new BoatPass(renderer, m)
      renderer.addPass("opaque", this.pass)
    })
    this.driver.onHit = (kind, id, x, y, z, ship) => this.hit(kind, id, ship?.id ?? -1, ship?.team ?? -1, this.parked(kind, ship, x, y, z))
    this.driver.onRecovered = () => this.end("landed")
    this.driver.onLost = () => this.end("crashed")
  }

  setNet(net: BoatNetLike): void {
    this.net = net
  }

  setWorld(sea: Sea, arch: Archipelago): void {
    this.sea = sea
    this.arch = arch
    this.wake.reset()
  }

  get online(): boolean {
    return this.net.state !== "offline"
  }

  /** A new boat sortie: the boat appears under the crane on the driver's carrier at sea time t. */
  start(ctx: BoatStart, t: number): void {
    this.ctx = ctx
    this.recovering = false
    const d = this.driver
    const me = this.crew && playerOf(this.crew, this.net.id)
    d.id = this.net.id
    d.team = me?.team ?? 0
    d.authority = !this.online
    d.launch(t)
    d.hud.homeColor = teamCss(d.team)
    this.lastHp = 100
    const w = this.weapons
    if (w) {
      // The kill feed knows us by name; offline the jets' world keeps our health (a boat fighter, shared/combat.ts).
      w.setPilot(this.net.id, d.team, me?.name ?? "YOU", teamCss(d.team))
      w.world.spawn(this.net.id, d.team, "hornet", t, true)
    }
  }

  stop(): void {
    this.ctx = null
    this.driver.stop()
    this.pending.clear()
  }

  get active(): boolean {
    return this.ctx !== null && this.driver.active
  }

  private end(how: RecoverHow): void {
    if (!this.ctx || this.recovering) return
    this.recovering = true
    // Online the room has already ended it (or will): its crew update stops us.
    if (!this.online) this.ctx.recover(how)
  }

  /** Which parked jet (shared/deck-jets.ts slot) a round that struck a carrier's deck hit, or -1. */
  private parked(kind: string, ship: GroundShip | null, x: number, y: number, z: number): number {
    if (kind !== "ship" || !ship || ship.id === undefined || !this.deckJet) return -1
    const l = worldToShip(ship, x, y, z, this.local)
    return this.deckJet(ship.id, l[0], l[1], l[2])
  }
  private local: [number, number, number] = [0, 0, 0]

  /** The parked jet (slot) at a ship-local point of carrier `ship`, or -1; the host wires it (shared/deck-jets.ts parkedAt). */
  deckJet: ((ship: number, x: number, y: number, z: number) => number) | null = null

  /** What our rounds struck: batched for the room (online), applied to the local world (offline). */
  private hit(kind: "jet" | "boat" | "sea" | "land" | "ship", id: number, ship: number, shipTeam: number, slot = -1): void {
    const team = this.driver.team
    let k = -1
    let on = -1
    if (kind === "jet") [k, on] = [BOAT_HIT.jet, id]
    else if (kind === "boat") [k, on] = [BOAT_HIT.boat, id]
    else if (kind === "ship" && ship >= 0 && shipTeam !== team) [k, on] = [BOAT_HIT.ship, ship]
    if (k < 0) return
    this.driver.hud.hit()
    // Rounds on a jet parked on an enemy deck: reported for it, not the hull (online only: the room keeps its health).
    if (k === BOAT_HIT.ship && slot >= 0) {
      if (!this.online) return
      const key = `d:${ship}:${slot}`
      const p = this.pending.get(key)
      if (p) p.n++
      else this.pending.set(key, { k: -1, on: ship, slot, n: 1 })
      return
    }
    if (!this.online) {
      const w = this.weapons?.world
      if (w && k !== BOAT_HIT.ship) w.hurt(on, k === BOAT_HIT.jet ? BOAT_DAMAGE.cannonJet : BOAT_DAMAGE.cannonBoat, this.net.id, "cannon")
      return
    }
    const key = `${k}:${on}`
    const p = this.pending.get(key)
    if (p) p.n++
    else this.pending.set(key, { k, on, n: 1 })
  }

  /**
   * Steps our boat to sea time t and drives the camera. False while there is no boat (the game shows the carrier).
   * `world` gives the jets our rounds can hit and every carrier as drawn.
   */
  update(dt: number, t: number, camera: Camera, aspect: number, v: { ships: readonly DrawnShip[]; jets: readonly Target[] }, paused = false): boolean {
    const ctx = this.ctx
    const d = this.driver
    const sea = this.sea
    if (!ctx || !sea || !d.active) return false
    this.input.enabled = !paused
    const homeDrawn = ctx.home()
    const home = homeDrawn ? (this.homeShip = Object.assign(this.homeShip ?? ({} as BoatShip), homeDrawn)) : null
    d.readInput()
    // Online: the room's view of our boat keeps the crane clock, the pickup and the sinking in step, and the pose honest.
    const mine = this.online ? this.net.boats.get(this.net.id) : undefined
    const n = mine ? unpackBoat(mine) : null
    if (n) {
      if (n.mode === BOAT_MODE.launch) d.syncLaunch(n.modeAt)
      else if (n.mode === BOAT_MODE.recover && n.from && d.phase === "drive") d.beginRecover(n.from, n.modeAt)
      else if (n.mode === BOAT_MODE.sunk && d.phase !== "sunk") d.destroy()
    }
    const b = d.boat
    if (t - b.t > 2 || t < b.t - 1) b.t = t - BOAT.tick
    const jets = this.enemyJets(v.jets)
    const boats = this.remotes.targets((id) => this.teamOf(id), (id) => this.weapons?.world.fighters.get(id)?.alive ?? true, this.boatTargets)
    const w = { sea, arch: this.arch, ships: v.ships, home, jets, boats }
    while (d.active && b.t + BOAT.tick <= t) d.fixed(w)
    if (!d.active) return false
    if (n && n.mode === BOAT_MODE.drive && d.phase === "drive") {
      extrapolateBoat(n, b.t, this.target)
      const dx = this.target.x - b.x
      const dz = this.target.z - b.z
      const dh = Math.atan2(Math.sin(this.target.heading - b.heading), Math.cos(this.target.heading - b.heading))
      const k = Math.hypot(dx, dz) > SNAP ? 1 : 1 - Math.exp(-dt / CORRECT_LAG)
      for (const s of [b, d.prev]) {
        s.x += dx * k
        s.z += dz * k
        s.heading += dh * k
      }
      if (k === 1) copyBoat(b, d.prev)
    }
    // Health from the room (or the local world offline); a drop shakes the camera.
    const hp = this.weapons?.world.hp(this.net.id) ?? d.hp
    if (hp < this.lastHp - 0.5) d.cam.shake.add(this.lastHp - hp > 20 ? 0.9 : 0.25)
    this.lastHp = hp
    d.hp = hp
    if (!this.online && hp <= 0 && d.phase === "drive") d.destroy()
    const k = Math.max(0, Math.min(1, (t - b.t) / BOAT.tick))
    d.frame(dt, k, camera, aspect, { w: innerWidth, h: innerHeight }, home, sea, paused)
    // Our orders to the room.
    if (this.online) {
      const c = this.ctl
      const o = d.orders
      c[0] = Math.round(o.throttle * 100) / 100
      c[1] = Math.round(o.steer * 100) / 100
      c[2] = o.boost ? 1 : 0
      c[3] = Math.round(d.turret.yaw * 1000)
      c[4] = Math.round(d.turret.pitch * 1000)
      c[5] = o.trigger ? 1 : 0
      this.net.sendBoat(c)
      this.hitIn -= dt
      if (this.hitIn <= 0 && this.pending.size) {
        this.hitIn = HIT_EVERY
        for (const p of this.pending.values()) {
          if (p.k < 0) this.net.sendDeckHits(DECK_ROUND.cannon, p.on, p.slot ?? 0, Math.min(60, p.n))
          else this.net.sendBoatHits(p.k, p.on, Math.min(60, p.n))
        }
        this.pending.clear()
      }
    }
    return true
  }

  private teamOf(id: number): number {
    return (this.crew && playerOf(this.crew, id)?.team) ?? -1
  }

  /** The jets our rounds can hit (the enemy ones; the rounds check the team too). */
  private enemyJets(jets: readonly Target[]): Target[] {
    const out = this.targetList
    out.length = 0
    for (const j of jets) if (!j.surface) out.push(j)
    return out
  }

  /** Every frame after the camera is placed (and after the jets' effects began): every boat drawn and heard. */
  frame(v: BoatFrame): void {
    this.crew = v.crew
    const sea = this.sea
    const pass = this.pass
    if (!sea) return
    this.remotes.sync(this.net.boats, this.net.id, v.t)
    this.ground.sea = sea
    this.ground.arch = this.arch
    this.ground.ships = v.ships
    this.remotes.update(v.dt, v.t, sea, (id) => v.ship(id), this.ground)
    pass?.begin()
    this.wake.begin(v.t)
    this.wfx.begin(v.eye, v.t, v.dt, v.fov, innerHeight)
    const d = this.driver
    const fx = this.fx
    if (pass && d.active) d.render(pass, fx, this.wake, v.t, teamColor(d.team), v.dt)
    this.audio.beginRemotes()
    const ear = v.eye
    const near = [...this.remotes.boats.values()].sort((a, b) => Math.hypot(a.shown.x - ear[0]!, a.shown.z - ear[2]!) - Math.hypot(b.shown.x - ear[0]!, b.shown.z - ear[2]!))
    for (const r of near) {
      const s = r.shown
      const n = r.net
      const p = this.pose
      Object.assign(p, { x: s.x, y: s.heave, z: s.z, heading: s.heading, pitch: s.pitch, roll: s.roll, radar: (v.t * BOAT_RADAR_RPS * Math.PI * 2) % (Math.PI * 2), yaw: r.yaw, gun: r.pitch, nozzle: n.mode === BOAT_MODE.drive ? n.rudder : 0, accent: playerTeamColor(v.crew, r.id) })
      const sinking = n.mode === BOAT_MODE.sunk ? Math.min(1, (v.t - n.modeAt) / 7) : 0
      if (sinking < 1) pass?.add(p, r.id)
      const onWater = n.mode === BOAT_MODE.drive || n.mode === BOAT_MODE.sunk
      if (onWater) this.wake.boat(r.id, { ...r.boat, wet: r.boat.wet, wetAft: n.mode === BOAT_MODE.sunk ? 0 : r.boat.wetAft })
      const hp = this.weapons?.world.hp(r.id) ?? 100
      if (onWater) fx.boat(r.id, { ...s, power: n.power, wet: r.boat.wet, wetAft: r.boat.wetAft, slams: r.boat.slams, boosting: n.boosting }, hp, v.dt, sinking)
      if (n.mode === BOAT_MODE.sunk && !r.exploded) {
        r.exploded = true
        fx.explode(s)
      }
      if (r.fired > 0) {
        const mp = this.mp
        const md = this.md
        muzzleWorld(s, r.yaw, r.pitch, mp, md)
        fx.muzzle(mp, md)
        const dist = Math.hypot(mp[0] - ear[0]!, mp[1] - ear[1]!, mp[2] - ear[2]!)
        for (let i = 0; i < Math.min(2, r.fired); i++) this.audio.round(dist)
        r.fired = 0
      }
      const rr = r.rounds
      for (let i = 0; i < rr.cap; i++) if (rr.state[i] === 2) fx.tracer(rr.x[i]!, rr.y[i]!, rr.z[i]!, rr.vx[i]!, rr.vy[i]!, rr.vz[i]!)
      if (r.boat.slams !== r.slams) {
        r.slams = r.boat.slams
        this.audio.slam(r.boat.slam, Math.hypot(s.x - ear[0]!, s.z - ear[2]!))
      }
      if (onWater && sinking === 0) {
        const dx = s.x - ear[0]!
        const dz = s.z - ear[2]!
        const dist = Math.hypot(dx, s.heave - ear[1]!, dz)
        this.audio.remote(r.id, { power: Math.abs(n.power), speed: Math.min(1, Math.abs(n.u) / BOAT.topSpeed), wet: r.boat.wet, boosting: n.boosting }, [s.x, s.heave + 1, s.z], dist, 0, v.dt)
      }
    }
    this.audio.endRemotes()
    fx.prune()
    pass?.upload()
    this.wake.upload()
    this.wfx.upload()
    // Boats are everyone's targets this frame: the jets' guns, blasts and shells (heat-seekers skip them).
    this.weapons?.surface(this.targets())
  }

  /** Every boat on the water as the weapons see it (`surface` targets): ours and everyone else's. */
  targets(): Target[] {
    const out = this.surfaceList
    out.length = 0
    let k = 0
    const d = this.driver
    const alive = (id: number) => this.weapons?.world.fighters.get(id)?.alive ?? true
    if (this.ctx && d.phase === "drive") {
      const [vx, vz] = boatVelocity(d.draw)
      out.push(this.surfaceTarget(k++, d.id, d.team, d.shown.x, d.shown.heave, d.shown.z, vx, vz, alive(d.id)))
    }
    for (const r of this.remotes.boats.values()) {
      if (r.net.mode !== BOAT_MODE.drive) continue
      const [vx, vz] = boatVelocity(r.boat)
      out.push(this.surfaceTarget(k++, r.id, this.teamOf(r.id), r.shown.x, r.shown.heave, r.shown.z, vx, vz, alive(r.id)))
    }
    return out
  }
  private surfaceList: Target[] = []
  private surfacePool: Target[] = []

  private surfaceTarget(i: number, id: number, team: number, x: number, y: number, z: number, vx: number, vz: number, alive: boolean): Target {
    const t = (this.surfacePool[i] ??= { id: 0, team: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, alive: true, surface: true })
    t.id = id
    t.team = team
    t.x = x
    t.y = y + 1.5
    t.z = z
    t.vx = vx
    t.vy = 0
    t.vz = vz
    t.alive = alive
    return t
  }

  /** For scripts: our boat's state. */
  get status(): { phase: string; knots: number; hp: number; x: number; z: number; air: number; remote: number } {
    const b = this.driver.boat
    return { phase: this.driver.phase, knots: b.u / 0.514444, hp: this.driver.hp, x: b.x, z: b.z, air: b.air, remote: this.remotes.boats.size }
  }
}
