import { Bullets, CombatWorld, type CombatEvent, type Ground, type MissileLaunch, bombLaunch, flareAt, groundHit } from "../../shared/combat"
import { PLANE, type Plane, type Quat, type Vec3, bodyToWorld, quatAxis, quatMul, quatRotate, worldToShip } from "../../shared/plane"
import { VEHICLES } from "../../shared/vehicles"
import {
  WEAPONS,
  type Loadout,
  type Shooter,
  type Target,
  type VehicleKind,
  type WeaponKind,
  type KillWeapon,
  clearLock,
  cycleWeapon,
  damageState,
  gunStep,
  lockStep,
  loadoutStep,
  makeLoadout,
  railOf,
  rearm,
  selectSlot,
  takeBomb,
  takeFlares,
  takeMissile,
  weaponOf,
} from "../../shared/weapons"
import type { WeaponAudio } from "../audio/weapon-audio"
import type { PlaneDrawPose } from "../render/plane-pass"
import type { WeaponFx } from "../render/weapon-fx"
import type { JetBreakup } from "../render/explosions"
import type { WeaponHud, WeaponHudView } from "./hud"
import type { WeaponInput } from "./input"
import { type FxShip, ShipFx } from "./ship-fx"
import { BombSight, type SightShip, aimBomb, makeBombAim } from "./bombsight"
import type { Hull } from "../../shared/fleet"
import { teamCss } from "../../shared/crew"
import { FireFx } from "./fire-fx"
import { FEEDBACK } from "../feedback/settings"

/** Damage and reward feedback (src/feedback/feedback.ts `Feedback`): presentation hooks fed from the same events. */
export type WeaponFeedback = {
  /** A jet lost `amount` health: `own` ours; `from` the attacker's position when known. */
  struck(own: boolean, amount: number, at: Target, from: { x: number; y: number; z: number } | null): void
  /** A jet was shot down (`mine`: by us). True when the kill's own sting played (the hit marker then stays silent). */
  kill(mine: boolean, at: Target | null): boolean
  /** Our missile or bomb burst without hitting a jet. */
  burst(x: number, y: number, z: number): void
  /** We sank a carrier / destroyed a parked jet. True when the sting played. */
  sunk(): boolean
  deckKill(): boolean
  /** Our jet was destroyed. */
  died(): void
}

/** What the weapons tell the room (online). Offline there is none: the local world has the authority. */
export type WeaponsNet = {
  /** Our trigger went down or up (others draw our rounds from it). */
  gun(on: boolean): void
  /** Our rounds hit `target` `n` times since the last report. */
  hits(target: number, n: number): void
  /** We fired a missile or released a bomb. */
  launch(l: MissileLaunch): void
  /** We dropped a flare burst. */
  flare(t: number, x: number, y: number, z: number, vx: number, vy: number, vz: number): void
  /** Our seeker's target (-1 none) and whether it is locked. */
  lock(target: number, locked: boolean): void
  /** Our rounds hit carrier `ship` `n` times since the last report. */
  shipHits(ship: number, n: number): void
  /** Our rounds hit the jet parked in slot `slot` on carrier `ship`'s deck `n` times since the last report. */
  deckHits(ship: number, slot: number, n: number): void
}

/** Another jet as the weapons see it this frame. */
export type Jet = Target & {
  qx: number
  qy: number
  qz: number
  qw: number
  vehicle: VehicleKind
  name: string
  color: string
  /** Its trigger (from the room). */
  gun: boolean
  /** Its model matrix this frame (rails), when drawn. */
  model: Float32Array
  hasModel: boolean
  seen: number
  /** Its stores as we reckon them (rail missiles drawn), and its rounds fired (cosmetic dispersion). */
  rack: Loadout
  round: number
  owed: number
}

type Wreck = { id: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; q: Quat; axis: Vec3; spin: number; age: number; live: boolean; pose: PlaneDrawPose }

/** Hits are reported to the room this often (s). */
const HIT_EVERY = 0.1
/** A missile homing on us within this range lights the MISSILE warning (m). */
const INBOUND = 3500
/** Wrecks fall at most this long (s). */
const WRECK_LIFE = 9
/** Weapons-bay doors open or close in this long (s). */
const DOOR_TIME = 0.6
/** A bay bomb leaves once the doors are this far open. */
const DOOR_RELEASE = 0.92

const fwd: Vec3 = [0, 0, 0]
const up: Vec3 = [0, 0, 0]
const left: Vec3 = [0, 0, 0]
const vel: Vec3 = [0, 0, 0]
const tmp: Vec3 = [0, 0, 0]
const qs: Quat = [0, 0, 0, 1]

/**
 * The player's weapons, and everyone's weapon effects. The host (flight seam or the harness) feeds it:
 * - `setPilot` once we know who we are, `sortie(vehicle)` on every launch;
 * - every frame: `beginJets()`, `jet(...)` for each other jet, `ownModel(m)`, then `frame(...)`;
 * - every fixed step while our jet flies: `tick(plane)` (after planeStep);
 * - room events: `apply(event)`, `remoteLaunch`, `remoteFlare`, `remoteGun`, `lockedBy`.
 * Offline (`net` null) the local world is the authority: it keeps health, credits kills and repairs.
 */
export class Weapons {
  readonly loadout: Loadout = makeLoadout()
  readonly world: CombatWorld
  readonly rounds = new Bullets(512)
  readonly others = new Bullets(1024)
  readonly jets = new Map<number, Jet>()
  id = 0
  team = 0
  name = "YOU"
  color = "#f4f7fb"
  /** True while our jet flies (tick runs). */
  flying = false
  /** Called when our jet is destroyed: by whom (-1 a crash) and with what. */
  onDestroyed: ((by: number, w: KillWeapon | "") => void) | null = null
  /** The cockpit warning as of the last frame: 0 none, 1 locked on, 2 a missile inbound. */
  warning: 0 | 1 | 2 = 0
  /** Camera trauma owed from being hit (the host adds it and zeroes it). */
  trauma = 0
  /** Your own shots since the host last read them, for the camera feel (the host zeroes them). */
  readonly fired = { rounds: 0, missiles: 0, bombs: 0 }
  private fireFx = new FireFx()
  /** Breaks shot-down jets apart and draws their wrecks' impacts (src/render/explosions.ts); the old burst when null. */
  breakup: JetBreakup | null = null
  /** Our weapons-bay doors, 0 shut .. 1 open: open while bombs are selected (and a bay bomb is waiting to drop). */
  doors = 0
  /** Draws a falling bomb with the jet model's own store mesh (the host's PlanePass); false falls back to a rock. */
  drawBomb: ((x: number, y: number, z: number, vx: number, vy: number, vz: number) => boolean) | null = null
  /** True while the host's camera shows the bombsight view (it draws the horizon and pitch bars then). */
  sightView: (() => boolean) | null = null
  /** Names and team colours of players not in view (the kill feed), from the host's crew. */
  resolve: ((id: number) => { name: string; color: string } | null) | null = null
  /** Damage and reward feedback (src/feedback), or null (harnesses). */
  feedback: WeaponFeedback | null = null
  /** When each jet was last shot down (presentation clock), so the host can skip its generic crash effect. */
  private killedAt = new Map<number, number>()
  private net: WeaponsNet | null
  /** Our own jet as a target (position and velocity this frame). */
  readonly own: Target
  private ownPlane: Plane | null = null
  private ownModel = new Float32Array(16)
  private hasOwnModel = false
  private targets: Target[] = []
  private jetList: Jet[] = []
  private frameNo = 0
  private wantFire = false
  private wasFire = false
  private sentGun = false
  private firedAt = -1
  private wantFlares = false
  /** A bomb release asked for while the bay doors were still opening: it drops once they are open. */
  private bombQueued = false
  private pendingHits = new Map<number, number>()
  private pendingShipHits = new Map<number, number>()
  /** Rounds on parked jets, by ship × 64 + slot. */
  private pendingDeckHits = new Map<number, number>()
  /** The parked jet (slot) at a ship-local point of carrier `ship`, or -1; the host wires it (shared/deck-jets.ts parkedAt). */
  deckJet: ((ship: number, x: number, y: number, z: number) => number) | null = null
  private local: Vec3 = [0, 0, 0]
  /** Burning carriers, smoke and the sinking (src/weapons/ship-fx.ts). */
  private shipFx: ShipFx
  private hitIn = 0
  private lockers = new Map<number, boolean>()
  /** The host's view of the ship guns (src/gunnery): SAMs homing on us and whether a player is a gunner, so a SAM
   *  lock and a SAM in flight warn exactly like a missile's. */
  sams: { inbound(id: number, x: number, y: number, z: number): number; gunner(id: number): boolean } | null = null
  private boomed: string[] = []
  private wrecks: Wreck[] = []
  private acc = 0
  private time = 0
  private ear: Vec3 = [0, 0, 0]
  private hudView: WeaponHudView
  /** The bombsight's symbols and its continuously computed impact point (src/weapons/bombsight.ts). */
  private sight = new BombSight()
  private aim = makeBombAim()
  private lockView = { x: 0, y: 0, progress: 0, locked: false }
  private shooter: Shooter = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 1, team: 0 }

  constructor(
    readonly fx: WeaponFx,
    readonly hud: WeaponHud,
    readonly audio: WeaponAudio,
    readonly input: WeaponInput,
    net: WeaponsNet | null,
    ground: Ground = { sea: null, arch: null },
  ) {
    this.net = net
    this.world = new CombatWorld(ground, net === null)
    this.others.hits = false
    this.own = { id: 0, team: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, alive: false }
    this.shipFx = new ShipFx(fx, audio, () => this.ear)
    this.hudView = { weapons: [], slot: 0, heat: 0, overheated: false, missiles: 0, missileMax: 0, bombs: 0, bombMax: 0, flares: 0, flareMax: 0, hp: 100, lock: null, warn: 0, nose: null }
  }

  /** Online (room has authority) or offline (we do). */
  setNet(net: WeaponsNet | null): void {
    this.net = net
    this.world.authority = net === null
  }

  setGround(g: Ground): void {
    this.world.ground = g
  }

  setPilot(id: number, team: number, name: string, color: string): void {
    this.id = id
    this.team = team
    this.name = name
    this.color = color
    this.own.id = id
    this.own.team = team
  }

  /** A new sortie in `vehicle`: full stores, cold gun, full health. */
  sortie(vehicle: VehicleKind = this.loadout.vehicle): void {
    rearm(this.loadout, vehicle)
    this.doors = 0
    this.bombQueued = false
    this.world.spawn(this.id, this.team, vehicle)
    this.rounds.clear()
    this.wrecks = this.wrecks.filter((w) => w.id !== this.id)
    this.lockers.clear()
  }

  /** Our jet stops flying (crashed, recovered, destroyed). */
  land(): void {
    this.flying = false
    this.ownPlane = null
    this.own.alive = false
    clearLock(this.loadout.lock)
    if (this.sentGun) this.net?.gun(false)
    this.sentGun = false
  }

  // ---- other jets ----------------------------------------------------------------------------------------------------

  beginJets(): void {
    this.frameNo++
  }

  /** Another jet this frame (pose = its draw pose; velocity; alive false on the deck or wrecked). */
  jet(id: number, team: number, p: { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number }, vx: number, vy: number, vz: number, alive: boolean, name: string, color: string, vehicle: VehicleKind = "hornet", model?: Float32Array): Jet {
    let j = this.jets.get(id)
    if (!j) {
      j = { id, team, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, alive, qx: 0, qy: 0, qz: 0, qw: 1, vehicle, name, color, gun: false, model: new Float32Array(16), hasModel: false, seen: 0, rack: makeLoadout(vehicle), round: 0, owed: 0 }
      this.jets.set(id, j)
      if (!this.world.fighters.has(id)) this.world.spawn(id, team, vehicle)
    }
    if (j.vehicle !== vehicle) rearm(j.rack, vehicle)
    j.team = team
    j.vehicle = vehicle
    j.name = name
    j.color = color
    j.x = p.x
    j.y = p.y
    j.z = p.z
    j.qx = p.qx
    j.qy = p.qy
    j.qz = p.qz
    j.qw = p.qw
    j.vx = vx
    j.vy = vy
    j.vz = vz
    j.alive = alive && (this.world.fighters.get(id)?.alive ?? true)
    j.seen = this.frameNo
    j.hasModel = !!model
    if (model) j.model.set(model)
    const f = this.world.fighters.get(id)
    if (f) f.team = team
    return j
  }

  /** A jet entered a new sortie (full health, full stores). */
  respawned(id: number): void {
    const j = this.jets.get(id)
    this.world.spawn(id, j?.team ?? 0, j?.vehicle ?? "hornet")
    if (j) rearm(j.rack)
  }

  /**
   * Boats this frame (shared/boat.ts; `surface` targets): our rounds and the world's blasts hit them, the seeker never
   * locks them, and they are not jets (no racks, no cosmetic M61 fire, no wreck).
   */
  surface(list: readonly Target[]): void {
    this.boats = list
  }
  /** The boats last handed to `surface` (the pilot's radar reads them too). */
  boats: readonly Target[] = []

  /** Our jet's model matrix this frame (to hang the missiles on its rails). */
  setOwnModel(m: Float32Array | null): void {
    this.hasOwnModel = !!m
    if (m) this.ownModel.set(m)
  }

  // ---- room events ---------------------------------------------------------------------------------------------------

  remoteGun(id: number, on: boolean): void {
    const j = this.jets.get(id)
    if (j) {
      j.gun = on
      if (on) j.owed = 0.999
    }
  }

  remoteLaunch(l: MissileLaunch): void {
    if (l.owner === this.id) return
    const j = this.jets.get(l.owner)
    this.world.fire(l, j?.team)
    if (j) {
      if (l.kind === "bomb") takeBomb(j.rack)
      else {
        j.rack.launchIn = 0
        takeMissile(j.rack)
      }
    }
    const d = this.dist(l.x, l.y, l.z)
    if (l.kind === "bomb") this.audio.bomb(d)
    else this.audio.missile(d)
  }

  remoteFlare(owner: number, t: number, x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    if (owner === this.id) return
    this.world.flare(owner, t, x, y, z, vx, vy, vz)
    this.fx.flarePop(x, y, z)
    this.audio.flare(this.dist(x, y, z))
  }

  /** An enemy's seeker on us: tracking (false) or locked (true), or off (null). */
  lockedBy(id: number, state: boolean | null): void {
    if (state === null) this.lockers.delete(id)
    else this.lockers.set(id, state)
  }

  /** A combat event, from the room (online) or our own world (offline). */
  apply(e: CombatEvent): void {
    switch (e.k) {
      case "boom": {
        this.world.snap(e.owner, e.seq)
        const key = `${e.owner}:${e.seq}`
        if (this.boomed.includes(key)) return
        this.boomed.push(key)
        if (this.boomed.length > 32) this.boomed.shift()
        const j = e.on >= 0 ? this.jetOrOwn(e.on) : null
        // A hit on our own jet bursts right by the chase camera: smaller, so it doesn't white out the screen.
        if (e.bomb) this.fx.bombBlast(e.x, e.y, e.z, e.water)
        else this.fx.explosion(e.x, e.y, e.z, j?.vx ?? 0, j?.vy ?? 0, j?.vz ?? 0, e.on === this.id ? 0.55 : 1, e.water, e.on === this.id ? "pop" : "missile")
        this.audio.explosion(this.dist(e.x, e.y, e.z), e.bomb ? 1.8 : 1, e.bomb ? (e.water ? "bomb-water" : "bomb-land") : "missile")
        if (e.owner === this.id && e.on >= 0) this.hud.hit()
        if (e.owner === this.id && e.on < 0) this.feedback?.burst(e.x, e.y, e.z)
        return
      }
      case "hp": {
        const before = this.world.hp(e.on)
        this.world.setHp(e.on, e.hp)
        if (e.hp < before && this.feedback) {
          const j = this.jetOrOwn(e.on)
          const src = e.by >= 0 ? this.jets.get(e.by) : undefined
          if (j) this.feedback.struck(e.on === this.id, before - e.hp, j, src ?? null)
        }
        if (e.on === this.id && e.hp < before) {
          const heavy = before - e.hp > 20
          this.audio.hurt(heavy)
          this.trauma = Math.min(1, this.trauma + (heavy ? 0.9 : 0.25))
        }
        return
      }
      case "kill": {
        this.world.setHp(e.on, 0)
        if (e.w) this.killedAt.set(e.on, this.time)
        const f = this.world.fighters.get(e.on)
        if (f) f.alive = false
        const killer = e.by >= 0 ? this.who(e.by) : null
        this.hud.feed(killer, this.who(e.on), e.by === this.id && e.on !== this.id)
        const mine = e.by === this.id && e.on !== this.id
        const stung = this.feedback?.kill(mine, e.on === this.id ? null : this.jetOrOwn(e.on)) ?? false
        if (mine) this.hud.hit(true, !stung)
        if (e.on === this.id) this.feedback?.died()
        // A jet shot down blows up and its wreck falls, burning.
        if (e.w) {
          const j = this.jetOrOwn(e.on)
          if (j) {
            const kind = e.on === this.id ? this.loadout.vehicle : (this.jets.get(e.on)?.vehicle ?? "hornet")
            if (!this.breakup?.airKill(e.on, kind, j)) this.fx.explosion(j.x, j.y, j.z, j.vx, j.vy, j.vz, e.on === this.id ? 0.8 : 1.5, false)
            this.audio.explosion(this.dist(j.x, j.y, j.z), 1.5, "air-kill")
            this.wreck(e.on, j)
          }
        }
        if (e.on === this.id) {
          this.land()
          this.onDestroyed?.(e.by, e.w)
        }
        return
      }
      case "decoy":
        return
    }
  }

  private who(id: number): { name: string; color: string } {
    if (id === this.id) return { name: this.name, color: this.color }
    const j = this.jets.get(id)
    if (j) return { name: j.name, color: j.color }
    return this.resolve?.(id) ?? { name: `#${id}`, color: "#f4f7fb" }
  }

  private jetOrOwn(id: number): (Target & { qx: number; qy: number; qz: number; qw: number }) | null {
    if (id === this.id && this.ownPlane) return { ...this.own, qx: this.ownPlane.qx, qy: this.ownPlane.qy, qz: this.ownPlane.qz, qw: this.ownPlane.qw }
    return this.jets.get(id) ?? null
  }

  private wreck(id: number, j: { x: number; y: number; z: number; vx: number; vy: number; vz: number; qx: number; qy: number; qz: number; qw: number }): void {
    let w = this.wrecks.find((w) => !w.live)
    if (!w) {
      w = { id, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, q: [0, 0, 0, 1], axis: [0, 0, 1], spin: 0, age: 0, live: false, pose: { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, pitch: 0, roll: 0, gear: 0, throttle: 0, burner: 0 } }
      this.wrecks.push(w)
    }
    w.id = id
    w.x = j.x
    w.y = j.y
    w.z = j.z
    w.vx = j.vx * 0.7
    w.vy = j.vy * 0.7 + 5
    w.vz = j.vz * 0.7
    w.q[0] = j.qx
    w.q[1] = j.qy
    w.q[2] = j.qz
    w.q[3] = j.qw
    // Tumble mostly in roll with some pitch: a body-frame axis (seeded per sortie, so every client sees the same fall).
    const rnd = this.breakup?.random(id) ?? Math.random
    w.axis[0] = rnd() - 0.5
    w.axis[1] = (rnd() - 0.5) * 0.4
    w.axis[2] = 1.5
    const l = Math.hypot(...w.axis)
    w.axis[0] /= l
    w.axis[1] /= l
    w.axis[2] /= l
    w.spin = (rnd() < 0.5 ? -1 : 1) * (1.2 + rnd() * 1.6)
    w.age = 0
    w.live = true
    w.pose.kind = id === this.id ? this.loadout.vehicle : (this.jets.get(id)?.vehicle ?? "hornet")
    w.pose.stores = 0
  }

  /** Falling wrecks to draw this frame, with the jet's id (the host's PlanePass draws them). */
  *wreckPoses(): Generator<[id: number, pose: PlaneDrawPose]> {
    for (const w of this.wrecks) if (w.live) yield [w.id, w.pose]
  }

  /** Our own wreck while it falls (the crash camera follows it), or null. */
  get ownWreck(): { x: number; y: number; z: number } | null {
    return this.wrecks.find((w) => w.live && w.id === this.id) ?? null
  }

  // ---- our jet -------------------------------------------------------------------------------------------------------

  /** Every carrier as drawn this frame and the room's hulls: their fires and smoke draw with the other effects. */
  fleet(ships: readonly (FxShip & SightShip)[], hulls: ReadonlyMap<number, Hull> | null, _team: number, _t: number, _dt: number): void {
    this.fleetShips = ships
    this.fleetHulls = hulls
  }
  private fleetShips: readonly (FxShip & SightShip)[] = []
  private fleetHulls: ReadonlyMap<number, Hull> | null = null

  /** A carrier started sinking: a kill feed line, the killer's confirmation, and its big first explosion. */
  sunk(ship: number, name: string, team: number, by: number, color = teamCss(team)): void {
    const killer = by >= 0 ? this.who(by) : null
    this.hud.feed(killer, { name, color }, by === this.id, "SUNK", "SUNK")
    if (by === this.id) this.feedback?.sunk()
    const s = this.fleetShips.find((x) => x.id === ship)
    if (s) {
      this.fx.explosion(s.x, s.heave + 26, s.z, 0, 0, 0, 3, false, "ship")
      this.audio.explosion(this.dist(s.x, s.heave + 26, s.z), 2.5, "bomb-land")
    }
  }

  /** A jet parked on a carrier's deck was destroyed: a kill feed line and the killer's confirmation. */
  deckKill(by: number, victim: { name: string; color: string }, at?: { x: number; y: number; z: number }): void {
    this.hud.feed(by >= 0 ? this.who(by) : null, victim, by === this.id, "✕", "DESTROYED")
    if (by === this.id) this.feedback?.deckKill()
    if (at) this.audio.explosion(this.dist(at.x, at.y, at.z), 1.4, "bomb-land")
  }

  /** Our jet crashed on its own (sea, land, ship, lost). Offline the world credits whoever damaged it lately. */
  crashed(): void {
    if (this.world.authority) this.world.crash(this.id)
    this.feedback?.died()
    this.land()
  }

  /** True when jet `id` was shot down within `within` seconds (its wreck and explosion are already drawn). */
  recentlyKilled(id: number, within = 15): boolean {
    const at = this.killedAt.get(id)
    return at !== undefined && this.time - at < within
  }

  /**
   * One fixed step of our jet (after planeStep), at sea time p.t. `armed` false (the landing autopilot has it): it is
   * still a target, its stores still rearm and it can still drop flares, but nothing fires.
   */
  tick(p: Plane, armed = true): void {
    const dt = PLANE.tick
    const l = this.loadout
    this.ownPlane = p
    this.flying = true
    const f = this.world.fighters.get(this.id)
    if (!f) this.world.spawn(this.id, this.team, l.vehicle)
    const own = this.own
    own.x = p.x
    own.y = p.y
    own.z = p.z
    own.vx = p.vx
    own.vy = p.vy
    own.vz = p.vz
    own.alive = this.world.fighters.get(this.id)?.alive ?? true
    if (!own.alive) return
    loadoutStep(l, dt)
    bodyToWorld(p, 0, 0, 1, fwd)
    bodyToWorld(p, 0, 1, 0, up)
    bodyToWorld(p, 1, 0, 0, left)
    vel[0] = p.vx
    vel[1] = p.vy
    vel[2] = p.vz
    const weapon = weaponOf(l)
    const trigger = this.wantFire && armed
    const pressed = trigger && !this.wasFire
    this.wasFire = trigger

    // Cannon.
    const n = weapon === "gun" ? gunStep(l, trigger, dt) : gunStep(l, false, dt)
    const mz = WEAPONS.gun.muzzleAt
    if (n > 0) {
      const m = bodyToWorld(p, mz[0], mz[1], mz[2], tmp)
      for (let i = 0; i < n; i++) this.rounds.fire(this.id, this.team, l.round++, p.x + m[0], p.y + m[1], p.z + m[2], vel, fwd, up, left, (i / n) * dt)
      this.firedAt = this.time
      this.fired.rounds += n
      this.fireFx.rounds(n)
    }
    const firing = weapon === "gun" && trigger && !l.overheated
    if (firing !== this.sentGun) {
      this.sentGun = firing
      this.net?.gun(firing)
    }
    this.rounds.step(dt, p.t, this.targets, this.world.ground, (_o, target, kind, x, y, z, ship) => {
      this.fx.impact(kind, x, y, z)
      // Rounds on an enemy carrier: reported for the room to apply (the hit marker says they landed).
      if (kind === "ship" && ship && ship.id !== undefined && ship.team !== undefined && ship.team !== this.team) {
        // A round into a jet parked on the deck counts for that jet (the room keeps its health), else for the hull.
        const l = this.deckJet ? worldToShip(ship, x, y, z, this.local) : null
        const slot = l ? this.deckJet!(ship.id, l[0], l[1], l[2]) : -1
        if (this.net && slot >= 0) this.pendingDeckHits.set(ship.id * 64 + slot, (this.pendingDeckHits.get(ship.id * 64 + slot) ?? 0) + 1)
        else if (this.net) this.pendingShipHits.set(ship.id, (this.pendingShipHits.get(ship.id) ?? 0) + 1)
        this.hud.hit()
      }
      if (target < 0) return
      this.hud.hit()
      if (this.net) this.pendingHits.set(target, (this.pendingHits.get(target) ?? 0) + 1)
      else this.world.gunHit(this.id, target, 1)
    })

    // Seeker.
    const s = this.shooter
    s.x = p.x
    s.y = p.y
    s.z = p.z
    s.fx = fwd[0]
    s.fy = fwd[1]
    s.fz = fwd[2]
    s.team = this.team
    if (weapon === "missile" && l.missiles > 0 && armed) {
      if (lockStep(l.lock, dt, s, this.jetList, (id) => this.world.blind(id))) this.net?.lock(l.lock.target, l.lock.locked)
    } else if (l.lock.target >= 0) {
      clearLock(l.lock)
      this.net?.lock(-1, false)
    }

    // Missiles and bombs leave on the trigger's press.
    if (pressed && weapon === "missile") {
      const seq = takeMissile(l)
      if (seq >= 0) {
        const r = railOf(seq, l.vehicle)
        const at = bodyToWorld(p, r[0], r[1], r[2], tmp)
        this.launch({ owner: this.id, seq, t: p.t, x: p.x + at[0], y: p.y + at[1], z: p.z + at[2], vx: p.vx, vy: p.vy, vz: p.vz, target: l.lock.locked ? l.lock.target : -1 })
        this.audio.missile(this.dist(p.x, p.y, p.z))
        this.fired.missiles++
        this.fireFx.missile(r)
      }
    }
    // Bombs drop in station order (VEHICLES[vehicle].bombs): from the bay once its doors are open, then the wings.
    if (pressed && weapon === "bomb") this.bombQueued = true
    if (weapon !== "bomb" || !armed) this.bombQueued = false
    const inBay = l.spec.bombs - l.bombs < VEHICLES[l.vehicle].bay
    if (this.bombQueued && (!inBay || this.doors >= DOOR_RELEASE)) {
      this.bombQueued = false
      const drop = bombLaunch(p, l.vehicle, l.bombs, l.spec.bombs, { owner: this.id, seq: 0, t: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, target: -1 })
      const seq = takeBomb(l)
      if (seq >= 0) {
        drop.seq = seq
        this.launch(drop)
        this.audio.bomb(this.dist(p.x, p.y, p.z))
        this.fired.bombs++
      }
    }
    if (this.wantFlares) {
      this.wantFlares = false
      if (takeFlares(l)) {
        this.world.flare(this.id, p.t, p.x, p.y, p.z, p.vx, p.vy, p.vz)
        this.net?.flare(p.t, p.x, p.y, p.z, p.vx, p.vy, p.vz)
        this.fx.flarePop(p.x, p.y, p.z)
        this.audio.flare(0)
      }
    }
  }

  private launch(m: MissileLaunch): void {
    this.world.fire(m, this.team)
    this.net?.launch(m)
  }

  // ---- per frame -----------------------------------------------------------------------------------------------------

  /**
   * Every frame, whatever the player does: reads the weapon keys (while flying), steps the world to sea time t and
   * applies its events (offline), flies everyone else's rounds, and draws every effect; then the HUD and the sounds.
   * `project` maps a world point to CSS pixels (null behind the camera).
   */
  frame(dt: number, t: number, eye: ArrayLike<number>, fov: number, viewportH: number, project: (x: number, y: number, z: number) => { x: number; y: number } | null, paused = false): void {
    this.time += dt
    this.ear[0] = eye[0]!
    this.ear[1] = eye[1]!
    this.ear[2] = eye[2]!
    const l = this.loadout
    const input = this.input
    input.enabled = this.flying && !paused
    this.wantFire = input.fire
    if (input.flares) this.wantFlares = true
    const sel = input.select
    const cyc = input.cycle
    // The bay doors open while bombs are selected (VEHICLES bay stations still loaded or not: the bay stays clear).
    const bay = VEHICLES[l.vehicle].bay > 0 && this.flying && this.own.alive && weaponOf(l) === "bomb" && !paused
    this.doors = bay ? Math.min(1, this.doors + dt / DOOR_TIME) : Math.max(0, this.doors - dt / DOOR_TIME)
    if (sel >= 0 ? selectSlot(l, sel) : cyc ? cycleWeapon(l, cyc) : false) {
      this.wasFire = this.wantFire
      if (weaponOf(l) !== "missile" && l.lock.target >= 0) {
        clearLock(l.lock)
        this.net?.lock(-1, false)
      }
    }
    input.endFrame()

    // The world: missiles, bombs, flares (and with authority, health). Its events go first, while jets that just died
    // (and so were not fed this frame) are still known for the feed and their wrecks.
    this.targets.length = 0
    for (const j of this.jets.values()) if (j.seen === this.frameNo) this.targets.push(j)
    for (const b of this.boats) this.targets.push(b)
    if (this.flying && this.own.alive) this.targets.push(this.own)
    this.world.step(t, this.targets)
    if (this.world.events.length) for (const e of this.world.events.splice(0)) this.apply(e)
    // Jets not seen this frame are gone.
    for (const [id, j] of this.jets) if (j.seen !== this.frameNo) this.jets.delete(id)
    this.jetList.length = 0
    for (const j of this.jets.values()) this.jetList.push(j)
    this.targets.length = 0
    for (const j of this.jetList) this.targets.push(j)
    for (const b of this.boats) this.targets.push(b)
    for (const [id] of this.lockers) if (!this.jets.has(id) && !this.sams?.gunner(id)) this.lockers.delete(id)
    if (this.net) {
      this.hitIn -= dt
      if (this.hitIn <= 0 && (this.pendingHits.size || this.pendingShipHits.size || this.pendingDeckHits.size)) {
        this.hitIn = HIT_EVERY
        for (const [target, n] of this.pendingHits) this.net.hits(target, n)
        for (const [ship, n] of this.pendingShipHits) this.net.shipHits(ship, n)
        for (const [k, n] of this.pendingDeckHits) this.net.deckHits(Math.floor(k / 64), k % 64, n)
        this.pendingHits.clear()
        this.pendingShipHits.clear()
        this.pendingDeckHits.clear()
      }
    }

    // Everyone else's rounds (cosmetic) in fixed steps, and their racks rearming.
    this.acc = Math.min(0.25, this.acc + dt)
    const step = PLANE.tick
    let farGun = 0
    while (this.acc >= step) {
      this.acc -= step
      for (const j of this.jetList) {
        loadoutStep(j.rack, step)
        if (!j.gun || !j.alive) continue
        j.owed += WEAPONS.gun.rate * step
        const n = Math.floor(j.owed)
        j.owed -= n
        if (!n) continue
        const mz = WEAPONS.gun.muzzleAt
        quatRotate(j.qx, j.qy, j.qz, j.qw, 0, 0, 1, fwd)
        quatRotate(j.qx, j.qy, j.qz, j.qw, 0, 1, 0, up)
        quatRotate(j.qx, j.qy, j.qz, j.qw, 1, 0, 0, left)
        const m = quatRotate(j.qx, j.qy, j.qz, j.qw, mz[0], mz[1], mz[2], tmp)
        vel[0] = j.vx
        vel[1] = j.vy
        vel[2] = j.vz
        for (let i = 0; i < n; i++) this.others.fire(j.id, j.team, j.round++, j.x + m[0], j.y + m[1], j.z + m[2], vel, fwd, up, left, (i / n) * step)
      }
      this.others.step(step, t, this.targets, this.world.ground, (_o, _t, kind, x, y, z) => this.fx.impact(kind, x, y, z))
    }
    // Rounds cracking past the camera (src/audio/weapon-audio.ts, from each round's live path).
    this.audio.zips(this.others, dt)

    // Effects.
    const fx = this.fx
    fx.begin(eye, t, dt, fov, viewportH)
    this.shipFx.draw(dt, t, this.fleetShips, this.fleetHulls)
    this.drawRounds(this.rounds)
    this.drawRounds(this.others)
    const own = this.ownPlane
    if (own && this.flying && this.time - this.firedAt < 0.05) {
      const mz = WEAPONS.gun.muzzleAt
      const m = bodyToWorld(own, mz[0], mz[1], mz[2], tmp)
      bodyToWorld(own, 0, 0, 1, fwd)
      fx.muzzle(own.x + m[0] + own.vx * dt, own.y + m[1] + own.vy * dt, own.z + m[2] + own.vz * dt, fwd[0], fwd[1], fwd[2])
    }
    if (own && this.flying) this.fireFx.draw(fx, own, dt)
    for (const j of this.jetList) {
      if (j.gun && j.alive) {
        const mz = WEAPONS.gun.muzzleAt
        const m = quatRotate(j.qx, j.qy, j.qz, j.qw, mz[0], mz[1], mz[2], tmp)
        quatRotate(j.qx, j.qy, j.qz, j.qw, 0, 0, 1, fwd)
        fx.muzzle(j.x + m[0], j.y + m[1], j.z + m[2], fwd[0], fwd[1], fwd[2])
        farGun = Math.max(farGun, 1 / (1 + this.dist(j.x, j.y, j.z) / 300))
      }
      if (j.alive) this.damageFx(j.id, j, j.qx, j.qy, j.qz, j.qw)
      if (j.hasModel && j.alive) this.racks(j.model, j.rack.missiles, j.rack.launched, j.vehicle)
    }
    if (own && this.flying && this.own.alive) {
      this.damageFx(this.id, this.own, own.qx, own.qy, own.qz, own.qw)
      if (this.hasOwnModel) this.racks(this.ownModel, l.missiles, l.launched, l.vehicle)
    }
    for (const m of this.world.missiles) {
      if (!m.alive) continue
      if (m.kind === "bomb") {
        if (!this.drawBomb?.(m.x, m.y, m.z, m.vx, m.vy, m.vz)) fx.rock(1, m.x, m.y, m.z, m.vx / (m.speed || 1), m.vy / (m.speed || 1), m.vz / (m.speed || 1), 2.6, 2.6, 0.8, 0, 0.4, 0.42, 0.38, 0, 1)
      }
      else fx.missile(m.owner * 4096 + m.seq, m.x, m.y, m.z, m.vx, m.vy, m.vz, m.age < WEAPONS.missile.burn)
    }
    for (let i = 0; i < this.world.flares.length; i++) {
      const f = this.world.flares[i]!
      if (!f.live || t < f.t0) continue
      flareAt(f, t, tmp)
      fx.flare(0x200000 + i, tmp[0], tmp[1], tmp[2], t - f.t0, WEAPONS.flare.life)
    }
    this.stepWrecks(dt, t)
    fx.upload()

    // Warnings, seeker tone and the HUD.
    let warn: 0 | 1 | 2 = 0
    if (this.flying && this.own.alive) {
      const o = this.own
      if (Math.min(this.world.inbound(this.id, o.x, o.y, o.z), this.sams?.inbound(this.id, o.x, o.y, o.z) ?? Infinity) < INBOUND) warn = 2
      else if (this.lockers.size) warn = 1
    }
    this.warning = warn
    const weapon = weaponOf(l)
    const seek: 0 | 1 | 2 = this.flying && weapon === "missile" && l.lock.target >= 0 ? (l.lock.locked ? 2 : 1) : 0
    this.audio.update(dt, this.flying && weapon === "gun" && this.wantFire && !l.overheated && this.own.alive, farGun, seek, warn)
    if (!this.flying || !this.own.alive || paused) {
      this.hud.update(dt, null)
      this.sight.update(null)
      return
    }
    const v = this.hudView
    v.weapons = l.spec.weapons
    v.slot = l.slot
    v.heat = l.heat
    v.overheated = l.overheated
    v.missiles = l.missiles
    v.missileMax = l.spec.missiles
    v.bombs = l.bombs
    v.bombMax = l.spec.bombs
    v.flares = l.flares
    v.flareMax = l.spec.flares
    v.hp = this.world.hp(this.id)
    v.warn = warn
    v.lock = null
    const tg = l.lock.target >= 0 ? this.jets.get(l.lock.target) : undefined
    if (tg) {
      const s = project(tg.x, tg.y, tg.z)
      if (s) {
        this.lockView.x = s.x
        this.lockView.y = s.y
        this.lockView.progress = Math.min(1, l.lock.time / WEAPONS.missile.lockTime)
        this.lockView.locked = l.lock.locked
        v.lock = this.lockView
      }
    }
    if (own) {
      bodyToWorld(own, 0, 0, 1, fwd)
      v.nose = project(own.x + fwd[0] * 1000, own.y + fwd[1] * 1000, own.z + fwd[2] * 1000)
    }
    this.hud.update(dt, v)
    // Bombs selected: where one released now lands, by the world's own bomb (shared/combat.ts bombImpact).
    if (own && weapon === "bomb") {
      const aim = l.bombs > 0 ? aimBomb(own, l.vehicle, l.bombs, l.spec.bombs, this.world.ground, this.fleetShips, this.boats, this.team, this.aim) : null
      this.sight.update({ aim, p: own, eye, view: this.sightView?.() ?? false, project })
    } else this.sight.update(null)
  }

  private drawRounds(b: Bullets): void {
    for (let i = 0; i < b.cap; i++) if (b.state[i] === 2) this.fx.tracer(b.x[i]!, b.y[i]!, b.z[i]!, b.vx[i]!, b.vy[i]!, b.vz[i]!)
  }

  /** Smoke or fire from a damaged jet's tail. */
  private damageFx(id: number, j: Target, qx: number, qy: number, qz: number, qw: number): void {
    const hp = this.world.hp(id)
    const state = damageState(hp)
    if (state === 0 || state === 3) return
    const at = quatRotate(qx, qy, qz, qw, state >= 2 ? 1.2 : 0, 0.4, -6.5, tmp)
    // Thicker as health falls: 1 at the smoke threshold, FEEDBACK.smokeScale near zero.
    const smoke = WEAPONS.health.max * WEAPONS.health.smoke
    const thick = 1 + (FEEDBACK.smokeScale - 1) * Math.max(0, Math.min(1, 1 - hp / smoke))
    this.fx.damage(id, j.x + at[0], j.y + at[1], j.z + at[2], j.vx, j.vy, j.vz, state, thick)
  }

  /** The missiles still on a jet's rails: with one left, it is on the rail that fires next. */
  private racks(m: Float32Array, n: number, launched: number, vehicle: VehicleKind): void {
    const v = VEHICLES[vehicle]
    for (let i = 0; i < Math.min(n, v.rails.length); i++) {
      const r = railOf(launched + i, vehicle)
      this.fx.railMissile(m, r[0], r[1] + v.flight.centre, r[2])
    }
  }

  private stepWrecks(dt: number, t: number): void {
    for (const w of this.wrecks) {
      if (!w.live) continue
      w.age += dt
      const k = Math.exp(-0.25 * dt)
      w.vx *= k
      w.vz *= k
      w.vy = w.vy * k - 9.81 * dt
      w.x += w.vx * dt
      w.y += w.vy * dt
      w.z += w.vz * dt
      quatMul(w.q, quatAxis(w.axis[0], w.axis[1], w.axis[2], w.spin * dt, qs), w.q)
      const ql = Math.hypot(w.q[0], w.q[1], w.q[2], w.q[3])
      for (let i = 0; i < 4; i++) w.q[i] = w.q[i]! / ql
      const p = w.pose
      p.x = w.x
      p.y = w.y
      p.z = w.z
      p.qx = w.q[0]
      p.qy = w.q[1]
      p.qz = w.q[2]
      p.qw = w.q[3]
      p.throttle = 0
      if (!this.breakup) this.fx.damage(0x300000 + w.id, w.x, w.y, w.z, w.vx, w.vy, w.vz, 2)
      const hit = groundHit(this.world.ground, w.x, w.y, w.z, t)
      if (hit || w.age > WRECK_LIFE) {
        w.live = false
        const drawn = !!hit && !!this.breakup?.wreckHit(w.id, hit, w.x, w.y, w.z, w.vx, w.vy, w.vz)
        if (!drawn && hit === "sea") this.fx.splash(w.x, w.y, w.z, 1.6)
        else if (!drawn && hit) this.fx.explosion(w.x, w.y, w.z, 0, 0, 0, 1.2, false)
        if (hit) this.audio.explosion(this.dist(w.x, w.y, w.z), 1.2, hit === "sea" ? "crash-sea" : "crash-land")
      }
    }
  }

  /** Distance from the listener (the camera). */
  private dist(x: number, y: number, z: number): number {
    return Math.hypot(x - this.ear[0], y - this.ear[1], z - this.ear[2])
  }

  /** For scripts and the debug harness. */
  get status(): { weapon: WeaponKind; heat: number; missiles: number; flares: number; lock: number; locked: boolean; hp: number; inbound: number } {
    const l = this.loadout
    return { weapon: weaponOf(l), heat: l.heat, missiles: l.missiles, flares: l.flares, lock: l.lock.target, locked: l.lock.locked, hp: this.world.hp(this.id), inbound: this.world.inbound(this.id, this.own.x, this.own.y, this.own.z) }
  }
}

