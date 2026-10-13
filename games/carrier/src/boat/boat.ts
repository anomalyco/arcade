import {
  BOAT,
  BOAT_HEALTH,
  BOAT_MODE,
  type Boat,
  type BoatControls,
  type BoatMode,
  type BoatNet,
  type BoatObstacle,
  BoatRounds,
  type BoatTarget,
  CRANE,
  type CranePose,
  GUN,
  KNOT,
  boatStep,
  boatVelocity,
  copyBoat,
  cranePoint,
  cranePose,
  lerpBoat,
  makeBoat,
  makeTurret,
  muzzleWorld,
  recoverTime,
  recoverable,
  releaseBoat,
  turretGun,
  turretStep,
} from "../../shared/boat"
import type { Ground, GroundShip } from "../../shared/combat"
import type { Archipelago } from "../../shared/islands"
import type { ShipPoseLike, Vec3 } from "../../shared/plane"
import { type Sea, seaHeight } from "../../shared/sea"
import type { Target } from "../../shared/weapons"
import type { BoatAudio } from "../audio/boat-audio"
import type { BoatFx } from "../render/boat-fx"
import type { BoatDrawPose, BoatPass } from "../render/boat-pass"
import type { BoatWake } from "../render/boat-wake"
import type { Camera } from "../render/camera"
import { BoatCam } from "./camera"
import { type BoatHudView, BoatHud } from "./hud"
import type { BoatInput } from "./input"

/** Radar bar turns per second; a function of sea time, so every client sees it at the same bearing. */
export const BOAT_RADAR_RPS = 0.6

export type BoatPhase = "idle" | "launch" | "drive" | "recover" | "sunk"

/** A carrier as the boat sees it: its pose (drawn, settled), plan velocity, crew ship id and team. */
export type BoatShip = ShipPoseLike & BoatObstacle & { id: number; team: number }

/** The world around the boat each fixed step. */
export type BoatWorld = {
  sea: Sea
  arch: Archipelago | null
  /** Every carrier (obstacles; the ones rounds can strike). */
  ships: readonly BoatShip[]
  /** Your carrier, for the crane and the recovery (null: it's gone). */
  home: BoatShip | null
  /** Enemy jets and other boats the rounds can hit. */
  jets: readonly Target[]
  boats: readonly BoatTarget[]
}

const PHASE_MODE: Record<BoatPhase, BoatMode> = { idle: BOAT_MODE.drive, launch: BOAT_MODE.launch, drive: BOAT_MODE.drive, recover: BOAT_MODE.recover, sunk: BOAT_MODE.sunk }

const wrap = (a: number) => a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2))

/**
 * The player's boat: crane launch off the carrier's port elevator, driving and shooting (one seat: the helm keys drive,
 * the mouse aims the turret through the chase camera, Space/LMB fires), recovery by coming back alongside slowly, and
 * the sinking when it is destroyed. Fixed steps (`fixed`, BOAT.tick on sea time) run the shared sim; `frame`
 * interpolates, places the camera and the HUD; `draw` puts it on the boat pass, wake and effects.
 *
 * The host wires health (`hp`, `destroy()`), what the rounds hit (`onHit`), and the ends: `onRecovered` (back aboard)
 * and `onLost` (sunk, after the sinking plays).
 */
export class BoatDriver {
  phase: BoatPhase = "idle"
  /** Seconds into the current phase. */
  phaseT = 0
  /** Sea time the phase began (for the wire). */
  phaseAt = 0
  readonly boat: Boat = makeBoat(0, 0, 0)
  readonly prev: Boat = makeBoat(0, 0, 0)
  readonly draw: Boat = makeBoat(0, 0, 0)
  readonly turret = makeTurret()
  readonly rounds = new BoatRounds()
  readonly cam = new BoatCam()
  /** Crew player id and team: the rounds' owner and friendly fire. */
  id = 0
  team = 0
  /** Health as the authority sees it (0..BOAT_HEALTH.max). */
  hp: number = BOAT_HEALTH.max
  /** The recovery's ship-local start. */
  from: { x: number; z: number; yaw: number } | null = null
  /** Rounds struck something: kind, id (jet/boat) or −1, where, the carrier when one. */
  onHit: ((kind: "jet" | "boat" | "sea" | "land" | "ship", id: number, x: number, y: number, z: number, ship: GroundShip | null) => void) | null = null
  onRecovered: (() => void) | null = null
  onLost: (() => void) | null = null
  /** The crane let go (for the splash sound and the wire). */
  onRelease: (() => void) | null = null
  /** Rounds fired this step (for the wire and the sound). */
  onFire: ((n: number) => void) | null = null
  /** Camera shake from hits (the host adds; decays). */
  trauma = 0
  /** Recovery only arms once the boat has left the crane's reach (or sped up) after a launch. */
  armed = false
  /** Offline the driver decides the pickup itself; online the room does (`beginRecover`, `destroy` from its tuple). */
  authority = true
  /** Test hook: when set, aims at this world point instead of the camera's. */
  aimAt: [number, number, number] | null = null
  private controls: BoatControls = { throttle: 0, steer: 0, boost: false }
  private trigger = false
  private aim: [number, number, number] = [0, 0, 0]
  private crane: CranePose = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0 }
  private muzzles = 0
  private impacts: { kind: "jet" | "boat" | "sea" | "land" | "ship"; x: number; y: number; z: number }[] = []
  private splashed = false
  private exploded = false
  private slamsHeard = 0
  private mp: Vec3 = [0, 0, 0]
  private md: Vec3 = [0, 0, 0]
  private drawPose: BoatDrawPose = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, radar: 0, yaw: 0, gun: 0, nozzle: 0 }
  private ground: Ground = { sea: null, arch: null, ships: [] }
  /** The pose drawn this frame (the crane's or the interpolated hull's). */
  readonly shown: ShipPoseLike & { u: number; v: number } = { x: 0, z: 0, heave: 0, heading: 0, pitch: 0, roll: 0, u: 0, v: 0 }

  constructor(
    readonly input: BoatInput,
    readonly hud: BoatHud = new BoatHud(),
    readonly audio: BoatAudio | null = null,
  ) {}

  /** Starts a launch at sea time t: the boat appears on the elevator. */
  launch(t: number): void {
    this.setPhase("launch", t)
    this.hp = BOAT_HEALTH.max
    this.from = null
    Object.assign(this.turret, makeTurret())
    this.boat.t = t
    this.boat.boost = 1
    this.splashed = false
    this.exploded = false
    this.armed = false
    this.cam.reset()
  }

  /** Destroyed: the boat explodes and goes down (onLost after it has sunk). */
  destroy(): void {
    if (this.phase === "sunk" || this.phase === "idle") return
    this.hp = 0
    this.setPhase("sunk", this.boat.t)
  }

  /** The room picked the boat up at sea time `at` from ship-local `from` (online). */
  beginRecover(from: { x: number; z: number; yaw: number }, at: number): void {
    if (this.phase !== "drive") return
    this.from = from
    this.setPhase("recover", at)
    this.phaseT = Math.max(0, this.boat.t - at)
  }

  /** The room's crane clock for a launch that began at sea time `at` (online: keeps the release in step with it). */
  syncLaunch(at: number): void {
    if (this.phase !== "launch") return
    this.phaseAt = at
    this.phaseT = Math.max(0, this.boat.t - at)
  }

  /** Ends whatever the boat was doing, silently (the host took the player elsewhere). */
  stop(): void {
    this.phase = "idle"
    this.hud.visible = false
    this.hud.message(null)
    this.audio?.ownBoat(null, 0)
  }

  get active(): boolean {
    return this.phase !== "idle"
  }

  private setPhase(p: BoatPhase, t: number): void {
    this.phase = p
    this.phaseT = 0
    this.phaseAt = t
  }

  /** The driver's orders this frame (for the room). */
  get orders(): { throttle: number; steer: number; boost: boolean; trigger: boolean } {
    const c = this.controls
    return { throttle: c.throttle, steer: c.steer, boost: c.boost, trigger: this.trigger }
  }

  /** Reads the helm and the trigger once per frame (before the fixed steps). */
  readInput(): void {
    this.input.controls(this.controls)
    this.trigger = this.input.fire && this.phase === "drive"
  }

  /** One fixed step (BOAT.tick). */
  fixed(w: BoatWorld): void {
    const dt = BOAT.tick
    const b = this.boat
    this.ground.sea = w.sea
    this.ground.arch = w.arch
    this.ground.ships = w.ships as readonly GroundShip[]
    if (this.phase === "idle") return
    this.phaseT += dt
    if (this.phase === "launch") {
      b.t += dt
      if (this.phaseT >= CRANE.release && w.home) {
        const at = cranePoint(w.home, this.mp)
        releaseBoat(b, w.home, seaHeight(w.sea, at[0], at[2], b.t), b.t)
        copyBoat(b, this.prev)
        this.setPhase("drive", b.t)
        this.splashed = true
        this.onRelease?.()
        this.audio?.splash(0)
      }
    } else if (this.phase === "drive") {
      copyBoat(b, this.prev)
      boatStep(b, this.controls, w.sea, w.arch, w.ships, dt)
      const aim = this.aimAt ?? this.aim
      turretStep(this.turret, b, aim[0], aim[1], aim[2], dt)
      const n = turretGun(this.turret, this.trigger, dt)
      if (n > 0) {
        const [vx, vz] = boatVelocity(b)
        for (let i = 0; i < n; i++) {
          muzzleWorld(b, this.turret.yaw, this.turret.pitch, this.mp, this.md)
          this.rounds.fire(this.id, this.team, this.turret.round++, this.mp[0], this.mp[1], this.mp[2], this.md[0], this.md[1], this.md[2], vx, vz)
          this.audio?.round(0)
        }
        this.muzzles += n
        this.onFire?.(n)
      }
      if (b.slams !== this.slamsHeard) {
        this.slamsHeard = b.slams
        this.audio?.slam(b.slam, 0)
        this.trauma = Math.max(this.trauma, b.slam * 0.8)
      }
      const home = w.home
      const pick = home && this.hp > 0 ? recoverable(b, home) : null
      if (!pick) this.armed = true
      else if (this.armed && this.authority) {
        this.from = pick
        this.setPhase("recover", b.t)
      }
    } else if (this.phase === "recover") {
      b.t += dt
      if (this.from && this.phaseT >= recoverTime(this.from.x, this.from.z)) {
        this.phase = "idle"
        this.onRecovered?.()
      }
    } else if (this.phase === "sunk") {
      copyBoat(b, this.prev)
      // Adrift and settling: the speed dies, the stern goes first, then it slips under.
      const k = Math.min(1, this.phaseT / BOAT_HEALTH.sink)
      b.u *= Math.exp(-dt * 0.9)
      b.v *= Math.exp(-dt * 0.9)
      b.r *= Math.exp(-dt * 1.2)
      const sh = Math.sin(b.heading)
      const ch = Math.cos(b.heading)
      b.x += (b.u * sh + b.v * ch) * dt
      b.z += (-b.u * ch + b.v * sh) * dt
      b.heading = wrap(b.heading + b.r * dt)
      b.t += dt
      const wy = seaHeight(w.sea, b.x, b.z, b.t)
      b.heave += (wy - 1.2 - 7 * k * k - b.heave) * (1 - Math.exp(-dt * 1.5))
      b.pitch += (0.32 * Math.min(1, k * 2) - b.pitch) * (1 - Math.exp(-dt * 1.2))
      b.roll += (0.25 * Math.min(1, k * 2) - b.roll) * (1 - Math.exp(-dt * 1.0))
      b.wet = 1
      b.wetAft = 0
      if (this.phaseT >= BOAT_HEALTH.sink) {
        this.phase = "idle"
        this.onLost?.()
      }
    }
    this.rounds.step(dt, b.t, w.jets, w.boats, this.ground, (_o, kind, id, x, y, z, ship) => {
      if (this.impacts.length < 32) this.impacts.push({ kind, x, y, z })
      this.onHit?.(kind, id, x, y, z, ship)
    })
  }

  /**
   * Per frame after the fixed steps: interpolate (k between the last two steps), place the camera (unless `camera`
   * is null: the host drives it), update the HUD. `home` is your carrier as drawn this frame.
   */
  frame(dt: number, k: number, camera: Camera | null, aspect: number, size: { w: number; h: number }, home: BoatShip | null, sea: Sea, paused = false): void {
    if (this.phase === "idle") {
      this.hud.visible = false
      this.audio?.ownBoat(null, dt)
      return
    }
    const s = this.shown
    if (this.phase === "launch" || this.phase === "recover") {
      if (home) {
        const water = (x: number, z: number) => seaHeight(sea, x, z, this.boat.t)
        cranePose(this.phaseT + k * BOAT.tick, home, water, this.phase === "recover" ? this.from : null, this.crane)
        const c = this.crane
        Object.assign(s, { x: c.x, z: c.z, heave: c.y, heading: c.heading, pitch: c.pitch, roll: c.roll, u: home.u, v: 0 })
      }
    } else {
      const d = lerpBoat(this.prev, this.boat, k, this.draw)
      Object.assign(s, { x: d.x, z: d.z, heave: d.heave, heading: d.heading, pitch: d.pitch, roll: d.roll, u: d.u, v: d.v })
    }
    this.trauma *= Math.exp(-dt * 3)
    if (camera) {
      const look = paused ? { dx: 0, dy: 0 } : this.input.look
      const water = (x: number, z: number) => seaHeight(sea, x, z, this.boat.t)
      this.cam.update(camera, { x: s.x, z: s.z, heave: s.heave, heading: s.heading, trauma: Math.max(this.trauma, this.boat.ground, this.boat.slam * 0.6), boost: this.boat.boosting ? 1 : 0 }, look, dt, aspect, water, this.trigger)
      this.aim[0] = this.cam.aim[0]
      this.aim[1] = this.cam.aim[1]
      this.aim[2] = this.cam.aim[2]
    }
    const b = this.boat
    const driving = this.phase === "drive"
    this.hud.visible = true
    this.hud.message(this.phase === "sunk" ? "BOAT LOST" : null, this.phase === "sunk" ? "BACK TO THE SHIP" : "")
    const view: BoatHudView | null =
      driving && camera
        ? {
            knots: Math.abs(this.draw.u) / KNOT,
            throttle: b.order >= 0 ? b.order : b.order / BOAT.astern,
            boost: b.boost,
            boosting: b.boosting,
            heat: this.turret.heat,
            overheated: this.turret.overheated,
            hp: this.hp / BOAT_HEALTH.max,
            arc: this.turret.onTarget || Math.abs(this.turret.aimYaw) < GUN.arc - 0.01,
            barrel: this.barrel(camera, size),
            home: home ? homeMarker(camera, home, s, size) : null,
          }
        : null
    this.hud.update(view, this.phase === "recover" ? "RECOVERING" : this.phase === "launch" ? "LAUNCHING" : "")
    this.audio?.ownBoat(this.phase === "sunk" ? null : { power: Math.abs(this.draw.power), speed: Math.min(1, Math.abs(this.draw.u) / BOAT.topSpeed), wet: this.phase === "drive" ? b.wet : 0.5, boosting: b.boosting }, dt)
  }

  /** Where the barrel points on screen: its line 400 m out. */
  private barrel(camera: Camera, size: { w: number; h: number }): { x: number; y: number } | null {
    muzzleWorld(this.shown, this.turret.yaw, this.turret.pitch, this.mp, this.md)
    const d = 400
    const p = camera.project(this.mp[0] + this.md[0] * d, this.mp[1] + this.md[1] * d, this.mp[2] + this.md[2] * d, size.w, size.h)
    return p.ok ? { x: p.x, y: p.y } : null
  }

  /** The boat on the pass, its wake and effects (call after `frame`, after the effects' `begin`). */
  render(pass: BoatPass, fx: BoatFx | null, wake: BoatWake | null, t: number, accent: readonly [number, number, number], dt: number): void {
    if (this.phase === "idle") return
    const s = this.shown
    const p = this.drawPose
    p.x = s.x
    p.y = s.heave
    p.z = s.z
    p.heading = s.heading
    p.pitch = s.pitch
    p.roll = s.roll
    p.radar = (t * BOAT_RADAR_RPS * Math.PI * 2) % (Math.PI * 2)
    p.yaw = this.turret.yaw
    p.gun = this.turret.pitch
    p.nozzle = this.phase === "drive" ? this.draw.rudder : 0
    p.accent = accent
    pass.add(p, this.id)
    const driving = this.phase === "drive" || this.phase === "sunk"
    if (wake && driving) wake.boat(this.id, this.draw)
    if (!fx) return
    if (this.splashed) {
      this.splashed = false
      fx.splash(s)
    }
    if (this.phase === "sunk" && !this.exploded) {
      this.exploded = true
      fx.explode(s)
    }
    if (driving) fx.boat(this.id, { ...s, power: this.draw.power, wet: this.draw.wet, wetAft: this.draw.wetAft, slams: this.boat.slams, boosting: this.boat.boosting }, this.hp, dt, this.phase === "sunk" ? Math.min(1, this.phaseT / BOAT_HEALTH.sink) : 0)
    // Muzzle flashes since the last frame, tracers in flight, strikes.
    if (this.muzzles > 0) {
      muzzleWorld(s, this.turret.yaw, this.turret.pitch, this.mp, this.md)
      fx.muzzle(this.mp, this.md)
      this.muzzles = 0
    }
    const r = this.rounds
    for (let i = 0; i < r.cap; i++) if (r.state[i] === 2) fx.tracer(r.x[i]!, r.y[i]!, r.z[i]!, r.vx[i]!, r.vy[i]!, r.vz[i]!)
    for (const h of this.impacts) fx.impact(h.kind, h.x, h.y, h.z)
    this.impacts.length = 0
  }

  /** This boat on the wire (shared/boat.ts packBoat). */
  net(ship: number): BoatNet {
    const b = this.boat
    return {
      id: this.id,
      t: b.t,
      x: b.x,
      z: b.z,
      heading: b.heading,
      u: b.u,
      v: b.v,
      r: b.r,
      power: b.power,
      rudder: b.rudder,
      yaw: this.turret.yaw,
      pitch: this.turret.pitch,
      mode: PHASE_MODE[this.phase],
      modeAt: this.phaseAt,
      ship,
      from: this.from,
      firing: this.trigger,
      boosting: b.boosting,
    }
  }
}

/** Your carrier on screen, as the flight HUD's marker (shown beyond 300 m). */
function homeMarker(cam: Camera, ship: ShipPoseLike, me: ShipPoseLike, size: { w: number; h: number }): BoatHudView["home"] {
  const km = Math.hypot(me.x - ship.x, me.z - ship.z) / 1000
  if (km < 0.3) return null
  const y = ship.heave + 26
  const at = cam.project(ship.x, y, ship.z, size.w, size.h)
  const margin = 40
  if (at.ok && at.x > margin && at.x < size.w - margin && at.y > margin && at.y < size.h - margin) return { x: at.x, y: at.y, on: true, angle: 0, km }
  const dx = ship.x - cam.eye[0]
  const dy = y - cam.eye[1]
  const dz = ship.z - cam.eye[2]
  const fw = cam.forward
  const up = cam.upDir
  const rx = fw[1] * up[2] - fw[2] * up[1]
  const ry = fw[2] * up[0] - fw[0] * up[2]
  const rz = fw[0] * up[1] - fw[1] * up[0]
  let sx = dx * rx + dy * ry + dz * rz
  let sy = -(dx * up[0] + dy * up[1] + dz * up[2])
  if (Math.hypot(sx, sy) < 1e-6) sy = 1
  const l = Math.hypot(sx, sy)
  sx /= l
  sy /= l
  const hw = size.w / 2 - margin
  const hh = size.h / 2 - margin
  const kk = Math.min(hw / Math.max(1e-6, Math.abs(sx)), hh / Math.max(1e-6, Math.abs(sy)))
  return { x: size.w / 2 + sx * kk, y: size.h / 2 + sy * kk, on: false, angle: Math.atan2(sy, sx), km }
}
