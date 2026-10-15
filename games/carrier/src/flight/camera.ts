import type { LabControl } from "@arcade/kit/lab-panel"
import { mat4d } from "wgpu-matrix"
import { PLANE, type Plane, type PlaneTuning, type Quat, planeQuat, planeSpeed, quatAxis, quatMul, quatRotate, quatSlerp, type Vec3 } from "../../shared/plane"
import { FAR, NEAR } from "../render/camera"
import { RelView } from "../render/ocean-view"

const DEG = Math.PI / 180

/** Flight camera tuning. Metres, seconds, radians. */
export const FLIGHT_CAM = {
  /** Chase: distance behind the jet's centre, height above it, and how far below the screen centre the jet sits. */
  dist: 27,
  height: 5.2,
  lookDown: 4 * DEG,
  /** Extra pull-back at boost speed (fraction of dist). */
  speedPull: 0.25,
  /** Orientation lag (s): turns read as the jet rotating on screen, then the camera catching up. */
  lag: 0.13,
  /** Positional lag in the jet's frame (s). */
  posLag: 0.05,
  /** Share of the jet's bank the camera follows while roughly upright (the rest is taken out to keep the horizon). */
  rollFollow: 0.42,
  /** FOV (vertical): base, extra at boost speed, extra while the afterburner is lit. */
  fov: 56 * DEG,
  fovSpeed: 9 * DEG,
  fovBoost: 4 * DEG,
  cockpitFov: 64 * DEG,
  /** Cockpit view tipped down so the nose shows at the bottom. */
  cockpitDown: 0,
  /** Shake: metres of jitter and radians of wobble at full trauma (scaled by trauma²). */
  shake: 0.45,
  shakeAngle: 1.2 * DEG,
  /** Free look: radians per CSS pixel, limits, and spring back (s). */
  lookRate: 0.005,
  lookPitchMax: 70 * DEG,
  lookReturn: 0.25,
}

export type ViewMode = "chase" | "cockpit"

/**
 * The bombsight view, typed settings bound to the Lab panel (debug menu, SIGHT tab): first person from just ahead of
 * the nose and under it, tipped down so the ground ahead and below shows on the run in, zoomed a little. Live edits.
 */
export type SightCamSettings = {
  /** Selecting bombs switches to the bombsight view. */
  sightView: boolean
  /** Tilt below the jet's nose (degrees). */
  sightDown: number
  /** Vertical field of view (degrees). */
  sightFov: number
  /** Eye ahead of the nose tip and below the jet's centre line (m). */
  sightAhead: number
  sightBelow: number
}
export const SIGHT_CAM_DEFAULTS: Readonly<SightCamSettings> = { sightView: true, sightDown: 14, sightFov: 42, sightAhead: 1.2, sightBelow: 0.7 }
export const SIGHT_CAM: SightCamSettings = { ...SIGHT_CAM_DEFAULTS }
export const SIGHT_CAM_CONTROLS: LabControl[] = [
  { key: "sightView", label: "Bombsight view with bombs", group: "Bombsight view", type: "toggle" },
  { key: "sightDown", label: "Look down", group: "Bombsight view", min: 0, max: 35, step: 0.5, unit: "°" },
  { key: "sightFov", label: "Field of view", group: "Bombsight view", min: 20, max: 70, step: 1, unit: "°" },
  { key: "sightAhead", label: "Eye ahead of nose", group: "Bombsight view", min: 0, max: 4, step: 0.1, unit: "m" },
  { key: "sightBelow", label: "Eye below centre line", group: "Bombsight view", min: 0, max: 2, step: 0.05, unit: "m" },
]

const ease = (dt: number, lag: number) => 1 - Math.exp(-dt / lag)

/**
 * Third-person chase and cockpit views of a jet. The chase camera rides behind and above, follows the jet's attitude
 * with a short lag, takes out most of the bank while the jet is upright (all of it near vertical and inverted, so loops
 * never flip the view), widens with speed and boost, and shakes with trauma. Free look orbits it around the jet.
 * Output: eye, forward, up, fov and viewProj (reversed Z, like render/camera.ts).
 */
export class FlightCam {
  mode: ViewMode = "chase"
  /** The flown type's nose tip (body z from the centre, m): the bombsight eye sits just ahead of it. */
  nose = 9
  readonly eye: Vec3 = [0, 0, 0]
  readonly forward: Vec3 = [0, 0, -1]
  readonly up: Vec3 = [0, 1, 0]
  fov = FLIGHT_CAM.fov
  readonly viewProj = new Float32Array(16)
  readonly viewProj64 = new Float64Array(16)
  private q: Quat = [0, 0, 0, 1]
  private rel: Vec3 = [0, 0, 0]
  private lookYaw = 0
  private lookPitch = 0
  /**
   * A framing the chase camera drifts toward (eased over ~2 s): yaw (rad, around the jet, + to its left), pitch (rad,
   * negative = eye higher, looking down) and a distance factor. The landing uses it to frame the jet and the deck on final and in the trap.
   */
  framing = { yaw: 0, pitch: 0, dist: 1 }
  private frame = { yaw: 0, pitch: 0, dist: 1 }
  private placed = false
  private shakeT = 0
  private time = 0
  private view = new Float64Array(16)
  private proj = new Float64Array(16)
  private target = new Float64Array(3)
  private upv = new Float64Array(3)
  private eyev = new Float64Array(3)
  private tq: Quat = [0, 0, 0, 1]
  private tmp: Quat = [0, 0, 0, 1]
  private v: Vec3 = [0, 0, 0]

  /** Bombs are selected while flying (the host sets it every frame). */
  private bombs = false
  /** C left the bombsight for the chase or cockpit view, until bombs are selected again. */
  private sightOff = false

  reset(): void {
    this.placed = false
  }

  /** Bombs selected (flying): the bombsight view takes over from chase or cockpit; any other weapon gives it back. */
  setBombs(on: boolean): void {
    if (on === this.bombs) return
    this.bombs = on
    this.sightOff = false
    this.placed = false
  }

  /** The bombsight view is showing. */
  get sighting(): boolean {
    return this.bombs && !this.sightOff && SIGHT_CAM.sightView
  }

  /** C: chase ⇄ cockpit; with bombs selected, the bombsight ⇄ the view it replaced. */
  toggle(): void {
    if (this.bombs && SIGHT_CAM.sightView) {
      this.sightOff = !this.sightOff
      this.placed = false
      return
    }
    this.mode = this.mode === "chase" ? "cockpit" : "chase"
  }

  /**
   * `trauma` 0..1 (catapult, stall buffet, crash). `look` is free-look mouse movement while held (null when released).
   * `eyeModel` is the pilot's eye in model space.
   */
  update(p: Plane, dt: number, aspect: number, trauma: number, look: { dx: number; dy: number } | null, eyeModel: Vec3, P: PlaneTuning = PLANE): void {
    this.time += dt
    const pq = planeQuat(p, this.tq)
    // Bank as seen against the world: take most of it out while upright, none of it when vertical or inverted.
    const l = quatRotate(pq[0], pq[1], pq[2], pq[3], 1, 0, 0, this.v)
    const ly = l[1]
    const u = quatRotate(pq[0], pq[1], pq[2], pq[3], 0, 1, 0, this.v)
    const bank = Math.atan2(ly, u[1])
    const f = quatRotate(pq[0], pq[1], pq[2], pq[3], 0, 0, 1, this.v)
    const vertical = Math.min(1, Math.abs(f[1]) ** 4)
    const ab = Math.abs(bank)
    const out = (1 - FLIGHT_CAM.rollFollow) * (ab < Math.PI / 2 ? ab : Math.PI - ab) * Math.sign(bank) * (1 - vertical)
    // Removing bank b (right wing down +) is a roll left about the body +Z axis by -b.
    quatMul(pq, quatAxis(0, 0, 1, -out, this.tmp), pq)
    const sight = this.sighting
    if (!this.placed || this.mode === "cockpit" || sight) {
      this.q[0] = pq[0]
      this.q[1] = pq[1]
      this.q[2] = pq[2]
      this.q[3] = pq[3]
    } else quatSlerp(this.q, pq, ease(dt, FLIGHT_CAM.lag), this.q)

    if (look) {
      this.lookYaw -= look.dx * FLIGHT_CAM.lookRate
      this.lookPitch = Math.max(-FLIGHT_CAM.lookPitchMax, Math.min(FLIGHT_CAM.lookPitchMax, this.lookPitch - look.dy * FLIGHT_CAM.lookRate))
    } else {
      const k = ease(dt, FLIGHT_CAM.lookReturn)
      this.lookYaw -= this.lookYaw * k
      this.lookPitch -= this.lookPitch * k
    }
    const fk = ease(dt, 1.8)
    const fr = this.frame
    fr.yaw += (this.framing.yaw - fr.yaw) * fk
    fr.pitch += (this.framing.pitch - fr.pitch) * fk
    fr.dist += (this.framing.dist - fr.dist) * fk
    const cq = this.tmp
    quatMul(this.q, quatAxis(0, 1, 0, this.lookYaw + fr.yaw, cq), cq)
    quatMul(cq, quatAxis(1, 0, 0, -(this.lookPitch + fr.pitch), this.tq), cq)

    const speed = planeSpeed(p)
    const fast = Math.max(0, Math.min(1, (speed - P.optimalSpeed) / (P.boostSpeed - P.optimalSpeed)))
    const s2 = trauma * trauma
    const n = this.time
    const jx = s2 * (Math.sin(n * 41.3) * 0.6 + Math.sin(n * 67.1 + 1.3) * 0.4)
    const jy = s2 * (Math.sin(n * 47.9 + 0.7) * 0.6 + Math.sin(n * 73.3 + 2.1) * 0.4)

    let fov: number
    if (sight) {
      // Under the nose with the jet's full attitude (the horizon banks as in the cockpit), free look still works.
      const q0 = planeQuat(p, this.tq)
      const e = quatRotate(q0[0], q0[1], q0[2], q0[3], 0, -SIGHT_CAM.sightBelow, this.nose + SIGHT_CAM.sightAhead, this.v)
      this.eye[0] = p.x + e[0]
      this.eye[1] = p.y + e[1]
      this.eye[2] = p.z + e[2]
      quatMul(q0, quatAxis(0, 1, 0, this.lookYaw, this.tmp), cq)
      quatMul(cq, quatAxis(1, 0, 0, -this.lookPitch, this.tq), cq)
      fov = SIGHT_CAM.sightFov * DEG
      this.placed = false
    } else if (this.mode === "cockpit") {
      const q0 = planeQuat(p, this.tq)
      const e = quatRotate(q0[0], q0[1], q0[2], q0[3], eyeModel[0], eyeModel[1] - P.centre, eyeModel[2], this.v)
      this.eye[0] = p.x + e[0]
      this.eye[1] = p.y + e[1]
      this.eye[2] = p.z + e[2]
      // Cockpit keeps the jet's full attitude.
      quatMul(q0, quatAxis(0, 1, 0, this.lookYaw, this.tmp), cq)
      quatMul(cq, quatAxis(1, 0, 0, -this.lookPitch, this.tq), cq)
      fov = FLIGHT_CAM.cockpitFov + FLIGHT_CAM.fovSpeed * 0.5 * fast
      this.placed = false
    } else {
      const dist = FLIGHT_CAM.dist * (1 + FLIGHT_CAM.speedPull * fast) * fr.dist
      const want = quatRotate(cq[0], cq[1], cq[2], cq[3], jx * FLIGHT_CAM.shake, FLIGHT_CAM.height + jy * FLIGHT_CAM.shake, -dist, this.v)
      if (!this.placed) {
        this.rel[0] = want[0]
        this.rel[1] = want[1]
        this.rel[2] = want[2]
        this.placed = true
      } else {
        const k = ease(dt, FLIGHT_CAM.posLag)
        this.rel[0] += (want[0] - this.rel[0]) * k
        this.rel[1] += (want[1] - this.rel[1]) * k
        this.rel[2] += (want[2] - this.rel[2]) * k
      }
      this.eye[0] = p.x + this.rel[0]
      this.eye[1] = p.y + this.rel[1]
      this.eye[2] = p.z + this.rel[2]
      fov = FLIGHT_CAM.fov + FLIGHT_CAM.fovSpeed * fast + FLIGHT_CAM.fovBoost * p.boosting
    }
    this.fov += (fov - this.fov) * ease(dt, 0.5)
    // Look along the camera's forward, tipped down a little so the jet sits below centre; wobble with trauma.
    const down = sight ? SIGHT_CAM.sightDown * DEG : this.mode === "chase" ? FLIGHT_CAM.lookDown : FLIGHT_CAM.cockpitDown
    const wob = s2 * FLIGHT_CAM.shakeAngle
    quatMul(cq, quatAxis(1, 0, 0, down + wob * Math.sin(n * 53.7), this.tq), cq)
    quatMul(cq, quatAxis(0, 0, 1, wob * Math.sin(n * 59.3 + 1), this.tq), cq)
    const fw = quatRotate(cq[0], cq[1], cq[2], cq[3], 0, 0, 1, this.v)
    this.forward[0] = fw[0]
    this.forward[1] = fw[1]
    this.forward[2] = fw[2]
    const up = quatRotate(cq[0], cq[1], cq[2], cq[3], 0, 1, 0, this.v)
    this.up[0] = up[0]
    this.up[1] = up[1]
    this.up[2] = up[2]
    this.compute(aspect)
  }

  /**
   * After a crash: the camera stops where it was, climbs clear of the water (never below `floor`) and backs away,
   * looking just above the wreck at (x, y, z) (where its fireball and smoke rise), horizon level, shaken by `trauma`.
   */
  crashView(x: number, y: number, z: number, floor: number, dt: number, aspect: number, trauma = 0): void {
    let dx = this.eye[0] - x
    let dz = this.eye[2] - z
    const d = Math.hypot(dx, dz) || 1
    dx /= d
    dz /= d
    const back = d < 110 ? (110 - d) * Math.min(1, dt * 2) : 0
    this.eye[0] += dx * back
    this.eye[2] += dz * back
    // Never inside a hillside (a crash into a slope leaves the chase camera in it): out at once, then up clear.
    if (this.eye[1] < floor) this.eye[1] = floor
    const want = Math.max(floor + 16, this.eye[1])
    this.eye[1] += (want - this.eye[1]) * Math.min(1, dt * 3)
    const s2 = trauma * trauma
    this.shakeT += dt
    const jx = s2 * FLIGHT_CAM.shake * 2 * Math.sin(this.shakeT * 37.1)
    const jy = s2 * FLIGHT_CAM.shake * 2 * Math.sin(this.shakeT * 43.7 + 1.3)
    const fx = x - this.eye[0] - jx
    const fy = y + 6 - this.eye[1] - jy
    const fz = z - this.eye[2]
    const l = Math.hypot(fx, fy, fz) || 1
    this.forward[0] = fx / l
    this.forward[1] = fy / l
    this.forward[2] = fz / l
    this.up[0] = 0
    this.up[1] = 1
    this.up[2] = 0
    this.placed = false
    this.compute(aspect)
  }

  /** Rebuilds viewProj from eye, forward, up and fov. */
  compute(aspect: number): void {
    this.eyev.set(this.eye)
    this.target[0] = this.eye[0] + this.forward[0]
    this.target[1] = this.eye[1] + this.forward[1]
    this.target[2] = this.eye[2] + this.forward[2]
    this.upv.set(this.up)
    mat4d.lookAt(this.eyev, this.target, this.upv, this.view)
    mat4d.perspectiveReverseZ(this.fov, aspect, NEAR, FAR, this.proj)
    mat4d.multiply(this.proj, this.view, this.viewProj64)
    this.viewProj.set(this.viewProj64)
  }

  /** World point to CSS pixels in a w × h viewport (null behind the camera). */
  project(x: number, y: number, z: number, w: number, h: number): { x: number; y: number } | null {
    const m = this.viewProj64
    const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!
    if (cw <= 0) return null
    const cx = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / cw
    const cy = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / cw
    return { x: (cx * 0.5 + 0.5) * w, y: (0.5 - cy * 0.5) * h }
  }
}

/**
 * RelView with a free up vector and field of view, so the sea, sky and clouds roll and zoom with the flight camera.
 * Fills the same public matrices RelView.update does.
 */
export class FlightView extends RelView {
  private fv = new Float64Array(16)
  private fp = new Float64Array(16)
  private fvp = new Float64Array(16)
  private finv = new Float64Array(16)
  private fz = new Float64Array(3)
  private ft = new Float64Array(3)
  private fu = new Float64Array(3)
  private fn = new Float64Array(3)

  set(eye: ArrayLike<number>, forward: ArrayLike<number>, up: ArrayLike<number>, fov: number, aspect: number, near = NEAR): void {
    this.eye[0] = eye[0]!
    this.eye[1] = eye[1]!
    this.eye[2] = eye[2]!
    this.ft[0] = forward[0]!
    this.ft[1] = forward[1]!
    this.ft[2] = forward[2]!
    this.fu[0] = up[0]!
    this.fu[1] = up[1]!
    this.fu[2] = up[2]!
    mat4d.lookAt(this.fz, this.ft, this.fu, this.fv)
    mat4d.perspectiveReverseZ(fov, aspect, near, FAR, this.fp)
    mat4d.multiply(this.fp, this.fv, this.fvp)
    this.viewProjRel.set(this.fvp)
    this.viewProjRel64.set(this.fvp)
    mat4d.inverse(this.fvp, this.finv)
    this.invViewProjRel.set(this.finv)
    this.fn[0] = -this.eye[0]!
    this.fn[1] = -this.eye[1]!
    this.fn[2] = -this.eye[2]!
    mat4d.translate(this.fvp, this.fn, this.viewProj)
  }
}
