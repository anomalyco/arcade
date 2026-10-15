import { WEAPON_MOUNTS } from "../../shared/carrier-spec"
import type { CombatWorld, Ground, GroundShip } from "../../shared/combat"
import {
  GUNNERY,
  type GunLaunch,
  type GunneryEvent,
  GunneryWorld,
  type Interceptable,
  type TurretAngles,
  type TurretState,
  type TurretTuple,
  TurretRounds,
  TURRET_GEOMETRY,
  TURRET_SCALE,
  type AimTuple,
  type GunFireTuple,
  type InterceptTuple,
  anglesOf,
  asInterceptable,
  boreLocal,
  ciwsStep,
  clampAim,
  leadPoint,
  makeTurretState,
  muzzleWorld,
  packAim,
  packGunFire,
  predictImpact,
  restAngles,
  samLockStep,
  shipPointVel,
  slewTurret,
  takeSam,
  takeShell,
  toLocalDir,
  toWorld,
  turretPoint,
  turretStep,
  type Impact,
} from "../../shared/gunnery"
import { PLANE, type Vec3, worldToShip } from "../../shared/plane"
import { type Target, clearLock } from "../../shared/weapons"
import { TurretAudio } from "../audio/turret-audio"
import type { Renderer } from "../render/renderer"
import { WeaponFx } from "../render/weapon-fx"
import { TURRET_CAM, TurretCam } from "./camera"
import { TurretHud, type TurretHudView } from "./hud"
import { TurretInput } from "./input"

/** What the gunnery tells the room (online). Offline there is none: the local world has the authority. */
export type GunneryNet = {
  /** Our turret's yaw, pitch (ship-local) and trigger, ~10 Hz while it moves and at once when the trigger changes. */
  aim(a: AimTuple): void
  /** We launched a SAM or fired a shell. */
  fire(f: GunFireTuple): void
  /** Our CIWS rounds hit jet `on` `n` times since the last report. */
  hits(on: number, n: number): void
  /** Our CIWS rounds hit carrier `ship` `n` times since the last report. */
  shipHits(ship: number, n: number): void
  /** Our CIWS shot down a store (missile or bomb: 0; SAM or shell: 1). */
  intercept(i: InterceptTuple): void
}

/** A carrier as the gunnery sees it this frame: the settled pose with its crew id, team and plan speeds. */
export type GunShip = GroundShip & { id: number; team: number; u?: number; v?: number }

/** What the host passes every frame, whatever this player does. */
export type GunneryFrame = {
  t: number
  dt: number
  paused: boolean
  /** Every carrier as drawn. */
  ships: readonly GunShip[]
  /** Every jet as the weapons see it (alive false: wrecked or on a deck). */
  jets: readonly Target[]
  /** The jets' combat world (shared/combat.ts): its missiles and bombs can be shot down, its flares decoy SAMs. */
  combat: CombatWorld | null
  eye: ArrayLike<number>
  fov: number
  /** Drawing camera for the HUD's markers (CSS px), when this player mans a turret. */
  project: ((x: number, y: number, z: number) => { x: number; y: number } | null) | null
}

type Remote = { ship: number; mount: number; yaw: number; pitch: number; firing: boolean; gunner: number; seen: number; owed: number; round: number }

/** Hits are reported to the room this often (s). */
const HIT_EVERY = 0.1
/** A remote turret not heard from for this long is unmanned (s). */
const REMOTE_STALE = 1.5
const MAX_FIRE_DT = 1

const mp: Vec3 = [0, 0, 0]
const md: Vec3 = [0, 0, 0]
const sv: Vec3 = [0, 0, 0]
const lv: Vec3 = [0, 0, 0]
const wv: Vec3 = [0, 0, 0]
const up: Vec3 = [0, 1, 0]
const aimDir: Vec3 = [0, 0, -1]
const ld: Vec3 = [0, 0, 0]
const ca: TurretAngles = { yaw: 0, pitch: 0 }

/**
 * The ship's guns from the gunner's seat, and everyone's turrets. The host (the game, or gunnery.html) feeds it:
 * - `setPlayer(id, team)` once known; `man(ship, mount)` when this player takes a gun from DEPLOY, `unman()`
 *   when they leave it;
 * - every frame while manning: `update(dt, t, aspect, ship)` (aims, slews, fires, places `cam`), then for everyone
 *   `frame(v)` (the world, remote turrets, effects, HUD, sound);
 * - room events: `remoteTurrets`, `remoteFire`, `apply` (bursts).
 * `anglesFor(ship)` gives every mount's yaw and pitch on a ship for src/render/turret-pass.ts.
 * Offline (`net` null) the local world is the authority; its `hurt`, `ship` and `intercept` events go to `onEvent`.
 */
export class Gunnery {
  readonly world: GunneryWorld
  readonly input: TurretInput
  readonly cam = new TurretCam()
  readonly hud: TurretHud
  readonly audio = new TurretAudio()
  readonly fx: WeaponFx
  readonly rounds = new TurretRounds(1024)
  readonly others = new TurretRounds(2048)
  id = 0
  team = 0
  /** The manned mount, or null. */
  seat: { ship: number; mount: number } | null = null
  state: TurretState | null = null
  /** Our turret's actual angles (ship-local), and the aim it slews toward (world: compass heading, elevation). */
  readonly turret: TurretAngles = { yaw: 0, pitch: 0 }
  aimHeading = 0
  aimElevation = 0
  /** Authority-side events for the host (offline): jet damage, ship hits, intercepted jet stores. */
  onEvent: ((e: GunneryEvent) => void) | null = null
  /** Team of a player (remote launches), from the host's crew. */
  teamOf: ((id: number) => number) | null = null
  private net: GunneryNet | null = null
  private remotes = new Map<number, Remote>()
  private drawAngles = new Map<number, Float32Array>()
  private simT = -1
  private time = 0
  private wantFire = false
  private wasFire = false
  private sentAim = ""
  private aimIn = 0
  private firedAt = -1
  private gunFlash = -1
  private pendingHits = new Map<number, number>()
  private pendingShipHits = new Map<number, { n: number; x: number; y: number; z: number }>()
  private hitIn = 0
  private claimed = new Map<number, number>()
  private boomed: string[] = []
  private press = { yaw: 0, pitch: 0 }
  private ship: GunShip | null = null
  private jets: Target[] = []
  private jetsT = 0
  private jetPool: Target[] = []
  private subJets: Target[] = []
  private stores: Interceptable[] = []
  private storePool: Interceptable[] = []
  private impact: Impact = { x: 0, y: 0, z: 0, time: 0, kind: "air" }
  private impactIn = 0
  private ear: Vec3 = [0, 0, 0]
  private combat: CombatWorld | null = null
  private hudView: TurretHudView = { kind: "ciws", label: "", heat: 0, overheated: false, cells: 0, cellsMax: 0, reload: 1, ready: 1, bore: null, arcYaw: 0.5, arcPitch: 0, limitYaw: 0, limitPitch: 0, lock: null, lead: null, impact: null, range: 0 }

  constructor(renderer: Renderer, canvas: HTMLCanvasElement, ground: Ground = { sea: null, arch: null }) {
    this.fx = new WeaponFx(renderer)
    renderer.addPass("alpha", this.fx)
    this.input = new TurretInput(canvas)
    this.hud = new TurretHud()
    this.world = new GunneryWorld(ground, true)
    this.others.hits = false
  }

  setNet(net: GunneryNet | null): void {
    this.net = net
    this.world.authority = net === null
  }

  setGround(g: Ground): void {
    this.world.ground = g
  }

  setPlayer(id: number, team: number): void {
    if (this.id !== id && this.seat) this.world.unman(this.id)
    this.id = id
    this.team = team
  }

  /** This player takes mount `mount` of ship `ship` (from DEPLOY). */
  man(ship: number, mount: number): void {
    if (this.seat && this.seat.ship === ship && this.seat.mount === mount) return
    this.seat = { ship, mount }
    this.state = makeTurretState(mount)
    restAngles(mount, this.turret)
    this.simT = -1
    this.rounds.clear()
    this.sentAim = ""
    this.wasFire = false
    this.aimFromTurret = true
    if (!this.net) this.world.man(this.id, this.team, ship, mount)
    this.cam.fov = TURRET_CAM.fov
  }
  private aimFromTurret = false

  /** This player leaves the gun (another operation, left the ship, the ship sank). */
  unman(): void {
    if (!this.seat) return
    if (this.wantFire) this.net?.aim(packAim(this.turret.yaw, this.turret.pitch, false))
    this.world.unman(this.id)
    this.seat = null
    this.state = null
    this.wantFire = false
    this.input.enabled = false
  }

  get manning(): boolean {
    return this.seat !== null
  }

  // ---- room events -----------------------------------------------------------------------------------------------------

  /** The room's manned turrets (every ~100 ms). Ours is skipped (we draw our own). */
  remoteTurrets(list: readonly TurretTuple[]): void {
    for (const t of list) {
      if (t[5] === this.id && this.seat) continue
      const key = t[0] * 16 + t[1]
      let r = this.remotes.get(key)
      if (!r) this.remotes.set(key, (r = { ship: t[0], mount: t[1], yaw: 0, pitch: 0, firing: false, gunner: t[5], seen: 0, owed: 0, round: 0 }))
      r.yaw = t[2] / 1000
      r.pitch = t[3] / 1000
      if (t[4] === 1 && !r.firing) r.owed = 0.999
      r.firing = t[4] === 1
      r.gunner = t[5]
      r.seen = this.time
    }
  }

  /** Someone else launched a SAM or fired a shell. */
  remoteFire(l: GunLaunch): void {
    if (l.owner === this.id) return
    this.world.fire(l, this.teamOf?.(l.owner))
    this.launchFx(l, this.dist(l.x, l.y, l.z))
  }

  /** A burst (from the room, or our own world offline): snap the projectile and draw it once. */
  apply(e: GunneryEvent): void {
    switch (e.k) {
      case "gboom": {
        this.world.snap(e.owner, e.seq)
        const key = `${e.owner}:${e.seq}`
        if (this.boomed.includes(key)) return
        this.boomed.push(key)
        if (this.boomed.length > 48) this.boomed.shift()
        const fx = this.fx
        if (e.kind === "sam") fx.explosion(e.x, e.y, e.z, 0, 0, 0, 1, e.surface === "sea", "missile")
        else if (e.surface === "sea") {
          fx.splash(e.x, e.y, e.z, 0.85)
          fx.glowAt(e.x, e.y + 1, e.z, 4, 6, 3, 1, 1)
        } else if (e.surface === "air") fx.explosion(e.x, e.y, e.z, 0, 0, 0, 0.55, false, "pop")
        else {
          fx.explosion(e.x, e.y + 1, e.z, 0, 0, 0, 0.8, false, e.surface === "ship" ? "ship" : "barrel")
          fx.impact(e.surface === "land" ? "land" : "ship", e.x, e.y, e.z)
        }
        this.audio.burstAt(this.dist(e.x, e.y, e.z), e.kind, e.surface)
        if (e.owner === this.id && e.on >= 0) {
          this.hud.hit()
        }
        return
      }
      case "intercept": {
        this.fx.explosion(e.x, e.y, e.z, 0, 0, 0, 0.5, false, "pop")
        this.audio.intercept(this.dist(e.x, e.y, e.z))
        if (e.by === this.id) {
          this.hud.hit(true)
        }
        if (this.world.authority) this.onEvent?.(e)
        return
      }
      case "hurt":
      case "ship":
        if (this.world.authority) this.onEvent?.(e)
        return
      case "decoy":
        return
    }
  }

  /** A kill credited to us (from the jets' feed): the HUD's kill marker. */
  confirmKill(): void {
    this.hud.hit(true)
  }

  // ---- our turret --------------------------------------------------------------------------------------------------------

  /**
   * While manning: mouse aim (world-stabilised, clamped to the mount's arcs as the ship moves), the turret slewing toward
   * it in fixed steps to sea time t, firing, our rounds, and the camera at the sight. `ship` is our carrier as drawn.
   * Returns false when there is nothing to drive (not manning, or the ship isn't drawn).
   */
  update(dt: number, t: number, aspect: number, ship: GunShip | null, paused = false): boolean {
    const seat = this.seat
    const st = this.state
    this.ship = ship
    if (!seat || !st || !ship) {
      this.input.enabled = false
      return false
    }
    const mount = WEAPON_MOUNTS[seat.mount]!
    const geo = TURRET_GEOMETRY[mount.kind]
    this.input.enabled = !paused
    if (this.aimFromTurret) {
      // Take over looking where the turret points.
      this.aimFromTurret = false
      toWorld(ship, boreLocal(this.turret.yaw, this.turret.pitch, lv), true, wv)
      this.aimHeading = Math.atan2(wv[0], -wv[2])
      this.aimElevation = Math.asin(Math.max(-1, Math.min(1, wv[1])))
    }
    const sens = (TURRET_CAM.sensitivity * this.cam.fov) / TURRET_CAM.fov
    this.aimHeading += this.input.lookX * sens
    this.aimElevation = Math.max(-1.45, Math.min(1.45, this.aimElevation - this.input.lookY * sens))
    this.wantFire = this.input.fire
    // The aim, in the ship's frame, kept inside the arcs (it stops at a limit instead of running past it).
    const ce = Math.cos(this.aimElevation)
    toLocalDir(ship, Math.sin(this.aimHeading) * ce, Math.sin(this.aimElevation), -Math.cos(this.aimHeading) * ce, lv)
    const want = anglesOf(lv[0], lv[1], lv[2], { yaw: 0, pitch: 0 })
    const c = clampAim(mount, want.yaw, want.pitch, ca)
    const ey = Math.atan2(Math.sin(want.yaw - c.yaw), Math.cos(want.yaw - c.yaw))
    const ep = want.pitch - c.pitch
    this.press.yaw = Math.abs(ey) > 1e-5 ? Math.sign(ey) : this.press.yaw * Math.exp(-dt / 0.3)
    this.press.pitch = Math.abs(ep) > 1e-5 ? Math.sign(ep) : this.press.pitch * Math.exp(-dt / 0.3)
    toWorld(ship, boreLocal(c.yaw, c.pitch, lv), true, aimDir)
    if (Math.abs(ey) > 1e-5 || Math.abs(ep) > 1e-5) {
      this.aimHeading = Math.atan2(aimDir[0], -aimDir[2])
      this.aimElevation = Math.asin(Math.max(-1, Math.min(1, aimDir[1])))
    }
    const wantYaw = c.yaw
    const wantPitch = c.pitch
    this.input.endFrame()

    // Fixed steps: slew, fire, fly our rounds.
    const dt0 = PLANE.tick
    if (this.simT < 0 || t - this.simT > MAX_FIRE_DT || t < this.simT - 0.5) this.simT = t - dt0
    while (this.simT + dt0 <= t) {
      this.simT += dt0
      this.stepTurret(dt0, this.simT, ship, wantYaw, wantPitch, !paused)
    }

    // Aim reports: ~10 Hz while the turret moves, at once when the trigger changes.
    const firing = this.firingNow()
    this.aimIn -= dt
    const a = packAim(this.turret.yaw, this.turret.pitch, firing)
    const key = a.join()
    if (key !== this.sentAim && (this.aimIn <= 0 || (a[2] === 1) !== this.sentAim.endsWith(",1"))) {
      this.sentAim = key
      this.aimIn = GUNNERY.aimEvery
      this.net?.aim(a)
    }

    // The eye at the sight on the ship's live pose, looking along the aim, rolling with the deck.
    const s = geo.sight
    turretPoint(seat.mount, this.turret.yaw, this.turret.pitch, s[0] * TURRET_SCALE, s[1] * TURRET_SCALE, s[2] * TURRET_SCALE, geo.sightFrame, lv)
    toWorld(ship, lv, false, wv)
    lv[0] = 0
    lv[1] = 1
    lv[2] = 0
    toWorld(ship, lv, true, up)
    const zoom = this.input.scope ? (TURRET_CAM.scope[mount.kind] ?? TURRET_CAM.fov) : TURRET_CAM.fov
    this.cam.place(dt, wv, aimDir, up, zoom, aspect)
    return true
  }

  private firingNow(): boolean {
    const st = this.state
    if (!st) return false
    return st.kind === "ciws" && this.wantFire && !st.overheated
  }

  /** One fixed step of our turret at sea time t. */
  private stepTurret(dt: number, t: number, ship: GunShip, wantYaw: number, wantPitch: number, armed: boolean): void {
    const seat = this.seat!
    const st = this.state!
    slewTurret(this.turret, seat.mount, wantYaw, wantPitch, dt)
    turretStep(st, dt)
    if (!this.net) this.world.aim(this.id, this.turret.yaw, this.turret.pitch, this.firingNow())
    const trigger = this.wantFire && armed
    const pressed = trigger && !this.wasFire
    this.wasFire = trigger
    muzzleWorld(ship, seat.mount, this.turret.yaw, this.turret.pitch, mp, md)
    shipPointVel(ship, sv)
    this.targetsAt(t)
    if (st.kind === "ciws") {
      const n = ciwsStep(st, trigger, dt)
      for (let i = 0; i < n; i++) this.rounds.fire(this.id, this.team, seat.ship, st.round++, mp[0], mp[1], mp[2], sv, md, (i / n) * dt)
      if (n > 0) {
        this.firedAt = this.time
        this.cam.trauma = Math.min(0.45, this.cam.trauma + 0.05)
      }
    } else if (st.kind === "sam") {
      if (st.cells > 0 && armed) samLockStep(st.lock, dt, mp[0], mp[1], mp[2], md[0], md[1], md[2], this.team, this.subJets, (id) => this.combat?.blind(id) ?? false)
      else clearLock(st.lock)
      if (pressed) {
        const cell = takeSam(st)
        if (cell >= 0) {
          muzzleWorld(ship, seat.mount, this.turret.yaw, this.turret.pitch, mp, md, cell)
          const e = GUNNERY.sam.eject
          this.launch({ owner: this.id, seq: st.seq++, kind: "sam", ship: seat.ship, mount: seat.mount, t, x: mp[0], y: mp[1], z: mp[2], vx: sv[0] + md[0] * e, vy: sv[1] + md[1] * e, vz: sv[2] + md[2] * e, target: st.lock.locked ? st.lock.target : -1 })
          this.cam.trauma = Math.min(1, this.cam.trauma + 0.35)
        }
      }
    } else if (trigger && takeShell(st)) {
      const v = GUNNERY.gun.muzzle
      this.launch({ owner: this.id, seq: st.seq++, kind: "shell", ship: seat.ship, mount: seat.mount, t, x: mp[0], y: mp[1], z: mp[2], vx: sv[0] + md[0] * v, vy: sv[1] + md[1] * v, vz: sv[2] + md[2] * v, target: -1 })
      this.cam.trauma = Math.min(1, this.cam.trauma + 0.75)
      this.gunFlash = this.time
    }
    this.rounds.step(dt, t, this.subJets, this.stores, this.world.ground, (_o, kind, target, x, y, z, sh) => {
      if (kind === "store") {
        const s = this.stores[target]
        this.fx.impact("jet", x, y, z)
        if (!s) return
        // One claim per store (a burst puts many rounds through it).
        const key = s.store * 1e9 + s.owner * 1e5 + s.seq
        if (this.time - (this.claimed.get(key) ?? -9) < 2) return
        this.claimed.set(key, this.time)
        if (this.claimed.size > 64) for (const [k, at] of this.claimed) if (this.time - at > 2) this.claimed.delete(k)
        if (this.net) {
          this.net.intercept([s.owner, s.seq, s.store])
          this.hud.hit(true)
        } else this.interceptLocal(s)
        return
      }
      this.fx.impact(kind === "jet" ? "jet" : kind, x, y, z)
      if (kind === "jet") {
        this.hud.hit()
        if (this.net) this.pendingHits.set(target, (this.pendingHits.get(target) ?? 0) + 1)
        else {
          const j = this.subJets.find((j) => j.id === target)
          if (j) this.world.ciwsHits(this.id, j, 1)
        }
        return
      }
      if (kind === "ship" && sh && sh.id !== undefined && sh.team !== undefined && sh.team !== this.team) {
        this.hud.hit()
        const l = worldToShip(sh, x, y, z, ld)
        if (this.net) {
          const p = this.pendingShipHits.get(sh.id)
          if (p) {
            p.n++
            p.x = l[0]
            p.y = l[1]
            p.z = l[2]
          } else this.pendingShipHits.set(sh.id, { n: 1, x: l[0], y: l[1], z: l[2] })
        } else this.world.ciwsShipHits(this.id, sh, 1, l[0], l[1], l[2])
      }
    })
  }

  /** Offline: our world (the authority) checks the claim; its events kill the store. */
  private interceptLocal(s: Interceptable): void {
    this.world.intercept(this.id, s)
  }

  /** The jets and stores extrapolated to sea time t (rounds sweep them over the step). */
  private targetsAt(t: number): void {
    const back = t - this.jetsT
    this.subJets.length = 0
    for (let i = 0; i < this.jets.length; i++) {
      const j = this.jets[i]!
      const s = (this.jetPool[i] ??= { id: 0, team: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, alive: true })
      s.id = j.id
      s.team = j.team
      s.alive = j.alive
      s.vx = j.vx
      s.vy = j.vy
      s.vz = j.vz
      s.x = j.x + j.vx * back
      s.y = j.y + j.vy * back
      s.z = j.z + j.vz * back
      this.subJets.push(s)
    }
    this.stores.length = 0
    let k = 0
    const c = this.combat
    if (c) {
      const cb = t - c.t
      for (const m of c.missiles) {
        if (!m.alive) continue
        const s = asInterceptable(m, 0, (this.storePool[k++] ??= { store: 0, owner: 0, seq: 0, team: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }))
        s.x += s.vx * cb
        s.y += s.vy * cb
        s.z += s.vz * cb
        this.stores.push(s)
      }
    }
    const gb = t - this.world.t
    for (const p of this.world.projectiles) {
      if (!p.alive || p.owner === this.id) continue
      const s = asInterceptable(p, 1, (this.storePool[k++] ??= { store: 0, owner: 0, seq: 0, team: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }))
      s.x += s.vx * gb
      s.y += s.vy * gb
      s.z += s.vz * gb
      this.stores.push(s)
    }
  }

  private launch(l: GunLaunch): void {
    this.world.fire(l, this.team)
    this.net?.fire(packGunFire(l))
    this.launchFx(l, 0)
  }

  /** A SAM's smoke and flash out of its cell, or the gun's blast. */
  private launchFx(l: GunLaunch, dist: number): void {
    const fx = this.fx
    const s = Math.hypot(l.vx, l.vy, l.vz) || 1
    const dx = l.vx / s
    const dy = l.vy / s
    const dz = l.vz / s
    if (l.kind === "sam") {
      fx.glowAt(l.x, l.y, l.z, 3.5, 12, 8, 3, 1)
      for (let i = 0; i < 16; i++) {
        const k = Math.random()
        // Out of the cell's front and blown back out of its rear, rolling over the launcher.
        const back = i % 3 === 0 ? -1 : 1
        fx.spawn(1, l.x, l.y, l.z, l.x, l.y, l.z, dx * back * (8 + k * 20) + (Math.random() - 0.5) * 8, dy * back * (8 + k * 20) + 2 + Math.random() * 4, dz * back * (8 + k * 20) + (Math.random() - 0.5) * 8, 3 + Math.random() * 3, 2, 9 + Math.random() * 6, 0.86, 0.86, 0.85, 0.65, 1.2, 0.6)
      }
      this.audio.samLaunch(dist)
    } else {
      fx.glowAt(l.x, l.y, l.z, 6, 12, 7, 2.5, 1)
      fx.beam(l.x, l.y, l.z, l.x + dx * 14, l.y + dy * 14, l.z + dz * 14, 2.6, 0.6, 10, 5, 1.6, 1)
      // Your own shot (dist 0): a thin, quick wisp well clear of the sight, so the splash stays visible.
      const own = dist === 0
      const n = own ? 4 : 12
      const off = own ? 16 : 4
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2
        const k = 10 + Math.random() * 25
        const ox = l.x + dx * off
        const oy = l.y + dy * off
        const oz = l.z + dz * off
        fx.spawn(1, ox, oy, oz, ox, oy, oz, dx * k + Math.cos(a) * 6, dy * k + Math.sin(a) * 6 + 1, dz * k + Math.sin(a) * 6, own ? 0.8 : 2.5 + Math.random() * 2, 2, own ? 5 : 10 + Math.random() * 5, 0.7, 0.69, 0.66, own ? 0.18 : 0.55, 2.2, 0.3)
      }
      this.audio.gunShot(dist)
    }
  }

  // ---- every frame ---------------------------------------------------------------------------------------------------

  /** Every frame, whatever the player does: the world, remote turrets and their rounds, effects, HUD and sound. */
  frame(v: GunneryFrame): void {
    this.time += v.dt
    this.ear[0] = v.eye[0]!
    this.ear[1] = v.eye[1]!
    this.ear[2] = v.eye[2]!
    this.combat = v.combat
    // Hulls as drawn: rounds and shells strike them (each settled by its damage).
    this.world.ground.ships = v.ships
    // The jets as of now, for the next update's rounds (extrapolated to each step).
    this.jets.length = 0
    for (const j of v.jets) this.jets.push(j)
    this.jetsT = v.t
    this.world.step(v.t, { jets: v.jets, flares: v.combat?.flares })
    if (this.world.events.length) for (const e of this.world.events.splice(0)) this.apply(e)

    if (this.net) {
      this.hitIn -= v.dt
      if (this.hitIn <= 0 && (this.pendingHits.size || this.pendingShipHits.size)) {
        this.hitIn = HIT_EVERY
        for (const [on, n] of this.pendingHits) this.net.hits(on, n)
        for (const [ship, p] of this.pendingShipHits) this.net.shipHits(ship, p.n)
        this.pendingHits.clear()
        this.pendingShipHits.clear()
      }
    }

    // Remote turrets: drop stale ones, fire their cosmetic rounds.
    for (const [k, r] of this.remotes) if (this.time - r.seen > REMOTE_STALE) this.remotes.delete(k)
    const step = PLANE.tick
    this.otherAcc = Math.min(0.25, this.otherAcc + v.dt)
    let farCiws = 0
    while (this.otherAcc >= step) {
      this.otherAcc -= step
      for (const r of this.remotes.values()) {
        if (!r.firing || WEAPON_MOUNTS[r.mount]?.kind !== "ciws") continue
        const sh = v.ships.find((s) => s.id === r.ship)
        if (!sh) continue
        r.owed += GUNNERY.ciws.rate * step
        const n = Math.floor(r.owed)
        r.owed -= n
        if (!n) continue
        const a = this.angleOf(r.ship, r.mount)
        muzzleWorld(sh, r.mount, a.yaw, a.pitch, mp, md)
        shipPointVel(sh, sv)
        for (let i = 0; i < n; i++) this.others.fire(r.gunner, -1, r.ship, r.round++, mp[0], mp[1], mp[2], sv, md, (i / n) * step)
      }
      this.others.step(step, v.t, [], [], this.world.ground, (_o, kind, _t, x, y, z) => {
        if (kind !== "store" && kind !== "jet") this.fx.impact(kind, x, y, z)
      })
    }
    this.smoothAngles(v)

    // Effects.
    const fx = this.fx
    fx.begin(v.eye, v.t, v.dt, v.fov, innerHeight)
    this.drawRounds(this.rounds)
    this.drawRounds(this.others)
    const seat = this.seat
    const own = seat && this.ship
    if (own && this.state?.kind === "ciws" && this.time - this.firedAt < 0.05) {
      muzzleWorld(this.ship!, seat.mount, this.turret.yaw, this.turret.pitch, mp, md)
      fx.muzzle(mp[0], mp[1], mp[2], md[0], md[1], md[2])
    }
    for (const r of this.remotes.values()) {
      if (!r.firing || WEAPON_MOUNTS[r.mount]?.kind !== "ciws") continue
      const sh = v.ships.find((s) => s.id === r.ship)
      if (!sh) continue
      const a = this.angleOf(r.ship, r.mount)
      muzzleWorld(sh, r.mount, a.yaw, a.pitch, mp, md)
      fx.muzzle(mp[0], mp[1], mp[2], md[0], md[1], md[2])
      farCiws = Math.max(farCiws, 1 / (1 + this.dist(mp[0], mp[1], mp[2]) / 300))
    }
    for (const p of this.world.projectiles) {
      if (!p.alive) continue
      if (p.kind === "sam") fx.missile(0x400000 + ((p.owner * 64 + p.seq) & 0xfffff), p.x, p.y, p.z, p.vx, p.vy, p.vz, p.age < GUNNERY.sam.burn)
      else {
        const k = 0.014
        fx.beam(p.x - p.vx * k, p.y - p.vy * k, p.z - p.vz * k, p.x, p.y, p.z, 0.18, 0.32, 9, 5, 1.8, 1)
      }
    }
    fx.upload()

    // Sound and the HUD.
    const st = this.state
    const seek: 0 | 1 | 2 = st && st.kind === "sam" && st.lock.target >= 0 ? (st.lock.locked ? 2 : 1) : 0
    this.audio.update(v.dt, this.firingNow(), farCiws, seek)
    if (!seat || !st || !this.ship || v.paused || !v.project) {
      this.hud.update(v.dt, null)
      return
    }
    this.hud.update(v.dt, this.view(v, seat.mount, st, this.ship, v.project))
  }
  private otherAcc = 0

  private view(v: GunneryFrame, mount: number, st: TurretState, ship: GunShip, project: (x: number, y: number, z: number) => { x: number; y: number } | null): TurretHudView {
    const m = WEAPON_MOUNTS[mount]!
    const h = this.hudView
    h.kind = m.kind
    h.label = m.kind === "ciws" ? "CIWS" : m.kind === "sam" ? "SAM" : "5-IN"
    h.heat = st.heat
    h.overheated = st.overheated
    h.cells = st.cells
    h.cellsMax = GUNNERY.sam.cells
    h.reload = st.cells < GUNNERY.sam.cells ? 1 - Math.max(0, Math.min(1, st.reloadIn / GUNNERY.sam.reload)) : 1
    h.ready = m.kind === "gun" ? 1 - st.readyIn / GUNNERY.gun.interval : 1
    muzzleWorld(ship, mount, this.turret.yaw, this.turret.pitch, mp, md)
    h.bore = project(mp[0] + md[0] * 1500, mp[1] + md[1] * 1500, mp[2] + md[2] * 1500)
    const [y0, y1] = m.yawArc
    h.arcYaw = (y1 - this.turret.yaw) / (y1 - y0)
    h.arcPitch = (this.turret.pitch - m.pitchArc[0]) / (m.pitchArc[1] - m.pitchArc[0])
    h.limitYaw = this.press.yaw
    h.limitPitch = this.press.pitch
    h.lock = null
    if (m.kind === "sam" && st.lock.target >= 0) {
      const j = v.jets.find((j) => j.id === st.lock.target)
      const p = j && project(j.x, j.y, j.z)
      if (p) h.lock = { x: p.x, y: p.y, progress: Math.min(1, st.lock.time / GUNNERY.sam.lockTime), locked: st.lock.locked }
    }
    // Lead pip: the enemy jet nearest the aim within range.
    h.lead = null
    if (m.kind !== "sam") {
      const speed = m.kind === "ciws" ? GUNNERY.ciws.muzzle : GUNNERY.gun.muzzle
      const range = m.kind === "ciws" ? GUNNERY.ciws.range : 8000
      shipPointVel(ship, sv)
      let best = Infinity
      for (const j of v.jets) {
        if (!j.alive || j.team === this.team) continue
        const d = Math.hypot(j.x - mp[0], j.y - mp[1], j.z - mp[2])
        if (d > range) continue
        const dot = ((j.x - mp[0]) * aimDir[0] + (j.y - mp[1]) * aimDir[1] + (j.z - mp[2]) * aimDir[2]) / d
        if (dot < 0.9 || 1 - dot > best) continue
        const tt = leadPoint(mp[0], mp[1], mp[2], sv[0], sv[1], sv[2], speed, j.x, j.y, j.z, j.vx, j.vy, j.vz, 1, ld)
        if (!Number.isFinite(tt)) continue
        const p = project(ld[0], ld[1], ld[2])
        if (!p) continue
        best = 1 - dot
        h.lead = { x: p.x, y: p.y, range: d }
      }
    }
    // The gun's splash point, re-predicted a few times a second.
    h.impact = null
    h.range = 0
    if (m.kind === "gun") {
      this.impactIn -= v.dt
      if (this.impactIn <= 0) {
        this.impactIn = 0.05
        shipPointVel(ship, sv)
        const s = GUNNERY.gun.muzzle
        predictImpact(mp[0], mp[1], mp[2], sv[0] + md[0] * s, sv[1] + md[1] * s, sv[2] + md[2] * s, v.t, this.world.ground, this.impact, ship.id)
      }
      const i = this.impact
      const r = Math.hypot(i.x - mp[0], i.z - mp[2])
      h.range = r
      if (i.kind !== "air") {
        const p = project(i.x, i.y, i.z)
        if (p) h.impact = { x: p.x, y: p.y, range: r, time: i.time }
      }
    }
    return h
  }

  /** Every mount's turret on ship `id` this frame: [yaw0, pitch0, ...] (src/render/turret-pass.ts). */
  anglesFor(id: number): Float32Array | null {
    return this.drawAngles.get(id) ?? null
  }

  private angleOf(ship: number, mount: number): TurretAngles {
    const a = this.drawAngles.get(ship)
    if (!a) return restAngles(mount, ca)
    ca.yaw = a[mount * 2]!
    ca.pitch = a[mount * 2 + 1]!
    return ca
  }

  /** Turrets slew toward their gunner's last report (or back to rest when unmanned) at their own rates. */
  private smoothAngles(v: GunneryFrame): void {
    for (const s of v.ships) {
      let a = this.drawAngles.get(s.id)
      if (!a) {
        a = new Float32Array(WEAPON_MOUNTS.length * 2)
        for (let i = 0; i < WEAPON_MOUNTS.length; i++) {
          a[i * 2] = WEAPON_MOUNTS[i]!.restYaw
          a[i * 2 + 1] = WEAPON_MOUNTS[i]!.restPitch
        }
        this.drawAngles.set(s.id, a)
      }
      for (let i = 0; i < WEAPON_MOUNTS.length; i++) {
        if (this.seat && this.seat.ship === s.id && this.seat.mount === i) {
          a[i * 2] = this.turret.yaw
          a[i * 2 + 1] = this.turret.pitch
          continue
        }
        const r = this.remotes.get(s.id * 16 + i)
        const m = WEAPON_MOUNTS[i]!
        ca.yaw = a[i * 2]!
        ca.pitch = a[i * 2 + 1]!
        // A little faster than the turret itself, so a remote never falls behind its reports.
        slewTurret(ca, i, r ? r.yaw : m.restYaw, r ? r.pitch : m.restPitch, v.dt * 1.5)
        a[i * 2] = ca.yaw
        a[i * 2 + 1] = ca.pitch
      }
    }
    if (this.drawAngles.size > v.ships.length + 8) for (const id of this.drawAngles.keys()) if (!v.ships.some((s) => s.id === id)) this.drawAngles.delete(id)
  }

  private drawRounds(b: TurretRounds): void {
    for (let i = 0; i < b.cap; i++) if (b.state[i] === 2) this.fx.tracer(b.x[i]!, b.y[i]!, b.z[i]!, b.vx[i]!, b.vy[i]!, b.vz[i]!, 0.024)
  }

  private dist(x: number, y: number, z: number): number {
    return Math.hypot(x - this.ear[0], y - this.ear[1], z - this.ear[2])
  }

  /** For scripts and the harness. */
  get status(): { mount: number; kind: string; yaw: number; pitch: number; heat: number; cells: number; ready: number; lock: number; locked: boolean; aimHeading: number; aimElevation: number; impact: Impact; live: number } {
    const st = this.state
    return {
      mount: this.seat?.mount ?? -1,
      kind: st?.kind ?? "",
      yaw: this.turret.yaw,
      pitch: this.turret.pitch,
      heat: st?.heat ?? 0,
      cells: st?.cells ?? 0,
      ready: st?.readyIn ?? 0,
      lock: st?.lock.target ?? -1,
      locked: st?.lock.locked ?? false,
      aimHeading: this.aimHeading,
      aimElevation: this.aimElevation,
      impact: this.impact,
      live: this.world.projectiles.filter((p) => p.alive).length,
    }
  }

  /** Points the aim at a world point (scripts, tests): heading and elevation from the sight. */
  aimAt(x: number, y: number, z: number): void {
    const e = this.cam.eye
    const dx = x - e[0]
    const dy = y - e[1]
    const dz = z - e[2]
    this.aimHeading = Math.atan2(dx, -dz)
    this.aimElevation = Math.atan2(dy, Math.hypot(dx, dz))
  }
}
