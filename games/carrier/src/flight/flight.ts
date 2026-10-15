import { CAPTURE_BLEND, type Landing, type LandingShip, landingPose, landingStep, startLanding } from "../../shared/landing"
import { DECK_Y } from "../../shared/carrier-spec"
import { LAUNCH, type Launch, launchPose, launchStep, startLaunch, type ShipLike } from "../../shared/launch"
import { PLANE, type Plane, type PlaneControls, type PlaneWorld, copyPlane, lerpPlane, makePlane, planeAttitude, planeSpeed, planeStep } from "../../shared/plane"
import { VEHICLES, type VehicleKind, landingVehicle } from "../../shared/vehicles"
import type { PlaneDrawPose } from "../render/plane-pass"
import { FlightCam } from "./camera"
import { type FlightHud, knots } from "./hud"
import type { FlightInput } from "./input"

export type FlightPhase = "idle" | "deck" | "launching" | "flying" | "landing" | "crashed"

/** The bombsight view waits this long after the catapult (s), so a launch with bombs still selected flies off first. */
const SIGHT_AFTER_LAUNCH = 1.5
/** Gear retraction time after leaving the deck (s), and the delay before it starts. */
const GEAR_DELAY = 0.8
const GEAR_TIME = 2.2

/**
 * One player's jet: on the deck waiting, launching off the catapult, flying, or crashed. Owns the fixed-step jet state
 * (with the previous step kept for interpolation), the flight camera and the HUD readout. The caller steps its carrier
 * first, then calls `tick(ship, world)` once per fixed step and `frame(...)` once per rendered frame.
 */
export class Flight {
  phase: FlightPhase = "deck"
  /** The aircraft type flown (set before `toDeck`): its flight tuning, probes, gear and catapult. */
  vehicle: VehicleKind = "hornet"
  readonly plane: Plane = makePlane()
  readonly prev: Plane = makePlane()
  readonly draw: Plane = makePlane()
  launch: Launch | null = null
  readonly cam = new FlightCam()
  readonly controls: PlaneControls = { pitch: 0, roll: 0, yaw: 0, throttle: 0, boost: false }
  /** Seconds since leaving the deck, and since the crash. */
  airborne = 0
  crashTime = 0
  /** Called when a crashed jet's respawn delay is over (default: back on the deck). */
  onRespawn: (() => void) | null = null
  /** Called once when a landing has stopped on the deck (default: back on the catapult). */
  onLanded: (() => void) | null = null
  /** The scripted landing's state while it has the jet (and the previous step's, to draw between steps). */
  landing: Landing | null = null
  /** The carrier being landed on (until the flight ends). */
  landingShip: (LandingShip & { t: number }) | null = null
  /** True while bombs are the selected weapon (the host's weapons): flying, the camera turns into the bombsight. */
  bombsight: (() => boolean) | null = null
  /** The host shows "R LAND" this frame (shared/landing.ts landTarget found a carrier). */
  landPrompt = false
  private prevLanding: Landing | null = null
  /** Gear 0 (up) .. 1 (down), and the tailhook. */
  private gear = 1
  private hook = 0
  /** Ship-local catapult z at the previous step (to draw the deck run between steps). */
  private prevZ = 0
  private trauma = 0
  private pose: PlaneDrawPose = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, pitch: 0, roll: 0, gear: 1, throttle: 0, burner: 0 }
  private wantLaunch = false
  private att = { heading: 0, pitch: 0, bank: 0 }
  private drawLanding = {} as Landing

  constructor(
    private input: FlightInput,
    private hud: FlightHud,
    /** The pilot's eye in model space (the cockpit camera). */
    public eyeModel: [number, number, number],
  ) {}

  /** A fresh jet waiting on the catapult of `ship`. */
  toDeck(ship: ShipLike & { t: number }): void {
    const { launch } = startLaunch(ship, this.plane, this.vehicle)
    this.launch = launch
    copyPlane(this.plane, this.prev)
    this.phase = "deck"
    this.airborne = 0
    this.crashTime = 0
    this.landing = this.prevLanding = null
    this.landingShip = null
    this.landPrompt = false
    this.gear = 1
    this.hook = 0
    this.cam.reset()
    // Keep Pointer Lock across the hand-off from the ship's camera: just centre the stick.
    this.input.centre()
  }

  /** Shot down (shared/combat.ts): the jet is lost like a crash, and the same recovery follows. */
  shootDown(): void {
    if (this.phase !== "flying" && this.phase !== "landing") return
    this.plane.crashed = "shot"
    this.phase = "crashed"
    this.crashTime = 0
    this.trauma = 1
    this.landing = this.prevLanding = null
    this.landingShip = null
  }

  /** Camera shake from outside (being hit): trauma 0..1, presentation only. */
  shake(trauma: number): void {
    this.trauma = Math.max(this.trauma, Math.min(1, trauma))
  }

  requestLaunch(): void {
    if (this.phase === "deck") this.wantLaunch = true
  }

  /** F at the prompt: the scripted landing on `ship` takes the jet (from the next step on, input is ignored). */
  land(ship: LandingShip & { t: number }): void {
    if (this.phase !== "flying") return
    this.landingShip = ship
    this.landing = startLanding(this.plane, ship, landingVehicle(this.vehicle))
    this.prevLanding = { ...this.landing, capQ: [...this.landing.capQ] }
    this.landPrompt = false
    this.phase = "landing"
  }

  /** One fixed step (PLANE.tick), after the carrier has been stepped to the same sea time. */
  tick(ship: ShipLike & { t: number }, world: PlaneWorld): void {
    copyPlane(this.plane, this.prev)
    this.prevZ = this.launch?.z ?? 0
    const dt = PLANE.tick
    if (this.phase === "idle") return
    if (this.phase === "deck") {
      if (this.wantLaunch) {
        this.wantLaunch = false
        this.phase = "launching"
      } else {
        // Hold on the line-up mark, riding the deck.
        startLaunch(ship, this.plane, this.vehicle)
        this.plane.t = ship.t
        return
      }
    }
    const gearWant = this.phase === "flying" && this.airborne > GEAR_DELAY ? 0 : 1
    this.gear = gearWant > this.gear ? Math.min(1, this.gear + dt / GEAR_TIME) : Math.max(0, this.gear - dt / GEAR_TIME)
    this.hook = this.landing ? this.landing.hook : Math.max(0, this.hook - dt)
    if (this.phase === "launching" && this.launch) {
      if (launchStep(this.launch, this.plane, ship, dt)) {
        this.phase = "flying"
        this.airborne = 0
      }
      this.trauma = Math.max(this.trauma, this.launch.shake)
      return
    }
    if (this.phase === "flying") {
      this.airborne += dt
      const v = VEHICLES[this.vehicle]
      planeStep(this.plane, this.controls, dt, world, v.flight, v.probes)
      if (this.plane.crashed) {
        this.phase = "crashed"
        this.crashTime = 0
        this.trauma = 1
      }
      return
    }
    if (this.phase === "landing" && this.landing) {
      // The scripted landing: no input, it always advances the clock and always ends (landingStep reports that once);
      // the jet then rides the deck until the host ends the flight.
      ship = this.landingShip ?? ship
      const l = this.landing
      Object.assign(this.prevLanding!, l)
      const touched = l.phase === "approach"
      const done = landingStep(l, this.plane, ship, dt)
      if (touched && l.phase !== "approach") this.trauma = Math.max(this.trauma, 0.7)
      this.trauma = Math.max(this.trauma, l.shake)
      if (done) {
        if (this.onLanded) this.onLanded()
        else this.toDeck(ship)
      }
      return
    }
    if (this.phase === "crashed") {
      this.plane.t += dt
      this.crashTime += dt
      if (this.crashTime >= LAUNCH.respawnDelay) {
        if (this.onRespawn) this.onRespawn()
        else this.toDeck(ship)
      }
    }
  }

  /** Per rendered frame, before the fixed steps: reads the keys and stick into `controls` (none while `paused`). */
  readInput(dt: number, paused = false): void {
    const i = this.input
    const flying = this.phase === "flying"
    i.enabled = flying && !paused
    i.controls(dt, this.controls)
    if (!flying || paused) {
      this.controls.pitch = this.controls.roll = this.controls.yaw = 0
      if (paused) this.controls.boost = false
    }
    // A menu has the mouse (and has suspended Pointer Lock itself).
    if (paused) return
    if (i.cameraToggle) this.cam.toggle()
    if (i.launch) this.requestLaunch()
  }

  /** Back to no jet (the player is aboard again). */
  idle(): void {
    this.phase = "idle"
    this.launch = null
    this.input.enabled = false
    this.hud.update(null)
    this.hud.message(null)
  }

  /** Network mode of the current jet: 0 on deck (x = catapult z), 1 flying, 2 crashed, 3 landing (ship-local pose,
   *  once the capture blend is over; until then it is sent as flying). */
  get mode(): 0 | 1 | 2 | 3 {
    if (this.phase === "landing") return this.landing && this.landing.since >= CAPTURE_BLEND ? 3 : 1
    return this.phase === "flying" ? 1 : this.phase === "crashed" ? 2 : 0
  }

  /**
   * Per rendered frame, after the fixed steps: interpolates the jet (`k` between the last two steps), drives the
   * camera and the HUD. On the deck the jet is placed on `ship` (the hull as drawn this frame) so it never drifts off
   * it. Returns the pose to draw, or null when there is nothing to draw (crashed).
   */
  frame(dt: number, k: number, aspect: number, seaHeight: (x: number, z: number) => number, size: { w: number; h: number }, ship?: ShipLike | null): PlaneDrawPose | null {
    lerpPlane(this.prev, this.plane, k, this.draw)
    const p = this.draw
    if (ship && this.launch && (this.phase === "deck" || this.phase === "launching")) launchPose(this.prevZ + (this.launch.z - this.prevZ) * k, ship, p, this.launch.kind)
    const lship = this.landingShip ?? ship
    if (lship && this.landing && this.prevLanding && this.phase === "landing") {
      // Between the last two landing steps, placed on the hull as drawn this frame.
      const a = this.prevLanding
      const b = this.landing
      const m = (x: number, y: number) => x + (y - x) * k
      const l = this.drawLanding
      Object.assign(l, b, { x: m(a.x, b.x), y: m(a.y, b.y), z: m(a.z, b.z), yaw: m(a.yaw, b.yaw), pitch: m(a.pitch, b.pitch), bank: m(a.bank, b.bank), since: m(a.since, b.since) })
      landingPose(l, lship, p)
    }
    this.trauma = Math.max(this.trauma * Math.exp(-dt * 2.2), this.phase === "flying" ? p.stall * 0.45 + Math.max(0, p.g - 7) * 0.05 : 0)
    const look = this.input.freeLook ? this.input.look : null
    // The landing: on the glideslope and in the trap the chase camera swings out to a high three-quarter view that
    // frames the jet coming down onto the deck.
    const lp = this.phase === "landing" ? this.landing?.phase : undefined
    const showDeck = lp === "trap" || lp === "stopped" || lp === "done" || (lp === "approach" && !!this.landing && this.landing.seg === this.landing.segs.length - 1)
    this.cam.framing.yaw = showDeck ? 0.5 : 0
    this.cam.framing.pitch = showDeck ? -0.32 : 0
    this.cam.framing.dist = showDeck ? 1.6 : 1
    this.cam.nose = VEHICLES[this.vehicle].probes[0]![2]
    this.cam.setBombs(this.phase === "flying" && this.airborne > SIGHT_AFTER_LAUNCH && !!this.bombsight?.())
    if (this.phase === "crashed") this.cam.crashView(p.x, p.y, p.z, seaHeight(this.cam.eye[0], this.cam.eye[2]), dt, aspect, Math.min(1, this.trauma))
    else this.cam.update(p, dt, aspect, Math.min(1, this.trauma), look, this.eyeModel, VEHICLES[this.vehicle].flight)

    const pose = this.pose
    pose.x = p.x
    pose.y = p.y
    pose.z = p.z
    pose.qx = p.qx
    pose.qy = p.qy
    pose.qz = p.qz
    pose.qw = p.qw
    pose.pitch = this.phase === "flying" ? this.controls.pitch : 0
    pose.roll = this.phase === "flying" ? this.controls.roll : 0
    pose.gear = this.gear
    pose.hook = this.hook
    pose.throttle = p.throttle
    pose.burner = p.boosting ? 1 : 0
    pose.noCanopy = this.cam.mode === "cockpit"

    if (this.phase === "flying" || this.phase === "landing") {
      planeAttitude(p, this.att)
      const speed = planeSpeed(p)
      const far = 1000
      const f = { x: 0, y: 0, z: 0 }
      const nx = 2 * (p.qx * p.qz + p.qw * p.qy)
      const ny = 2 * (p.qy * p.qz - p.qw * p.qx)
      const nz = 1 - 2 * (p.qx * p.qx + p.qy * p.qy)
      f.x = p.x + nx * far
      f.y = p.y + ny * far
      f.z = p.z + nz * far
      const nose = this.cam.project(f.x, f.y, f.z, size.w, size.h)
      const path = speed > 1 ? this.cam.project(p.x + (p.vx / speed) * far, p.y + (p.vy / speed) * far, p.z + (p.vz / speed) * far, size.w, size.h) : null
      this.hud.update({
        knots: knots(speed),
        altitude: p.y - VEHICLES[this.vehicle].flight.centre - seaHeight(p.x, p.z),
        heading: this.att.heading,
        throttle: p.throttle,
        boost: p.boost,
        boosting: p.boosting > 0,
        stall: p.stall,
        edgeLeft: p.outside > 0 ? PLANE.edgeTime - p.outside : null,
        nose,
        path,
        cockpit: this.cam.mode === "cockpit",
        landing: this.phase === "landing",
        prompt: this.phase === "flying" && this.landPrompt,
        home: ship ? this.home(ship, size) : null,
      })
    } else this.hud.update(null)
    if (this.phase === "crashed") {
      const left = Math.max(0, LAUNCH.respawnDelay - this.crashTime)
      const c = this.plane.crashed
      const what = c === "sea" ? "SPLASH" : c === "lost" ? "LOST" : c === "shot" ? "SHOT DOWN" : "CRASHED"
      this.hud.message(what, `BACK ON DECK  ${Math.ceil(left)}`)
    } else this.hud.message(null)
    return this.phase === "crashed" ? null : pose
  }

  /**
   * Where your carrier is on screen (a tiny tick under it) when in view, else the screen-edge direction toward it; with
   * its distance in km. Hidden within 500 m and while the landing autopilot has the jet.
   */
  private home(ship: ShipLike, size: { w: number; h: number }): { x: number; y: number; size: number; on: boolean; angle: number; km: number } | null {
    const p = this.draw
    const km = Math.hypot(p.x - ship.x, p.z - ship.z) / 1000
    // Close in, and while landing, the ship itself is the marker.
    if (km < 0.5 || this.phase === "landing") return null
    const cam = this.cam
    const y = ship.heave + DECK_Y
    const at = cam.project(ship.x, y, ship.z, size.w, size.h)
    const margin = 40
    if (at && at.x > margin && at.x < size.w - margin && at.y > margin && at.y < size.h - margin) return { x: at.x, y: at.y, size: 0, on: true, angle: 0, km }
    // Off screen (or behind): the direction in the camera's own frame.
    const dx = ship.x - cam.eye[0]
    const dy = y - cam.eye[1]
    const dz = ship.z - cam.eye[2]
    const fw = cam.forward
    const up = cam.up
    const rx = fw[1] * up[2] - fw[2] * up[1]
    const ry = fw[2] * up[0] - fw[0] * up[2]
    const rz = fw[0] * up[1] - fw[1] * up[0]
    let sx = dx * rx + dy * ry + dz * rz
    let sy = -(dx * up[0] + dy * up[1] + dz * up[2])
    if (Math.hypot(sx, sy) < 1e-6) sy = 1
    const l = Math.hypot(sx, sy)
    sx /= l
    sy /= l
    // Onto the screen border, inset.
    const hw = size.w / 2 - margin
    const hh = size.h / 2 - margin
    const k = Math.min(hw / Math.max(1e-6, Math.abs(sx)), hh / Math.max(1e-6, Math.abs(sy)))
    return { x: size.w / 2 + sx * k, y: size.h / 2 + sy * k, size: 0, on: false, angle: Math.atan2(sy, sx), km }
  }

  /** Stick and trauma the effects layer wants: vapour strength from the load factor. */
  get vapour(): number {
    if (this.phase !== "flying") return 0
    return Math.max(0, Math.min(1, (this.draw.g - 7) / 5))
  }
}
