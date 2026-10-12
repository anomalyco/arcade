// Flight physics — owned by the Flight agent.
// Deterministic, dependency-free, allocation-free in the hot path. Runs identically on the client
// (prediction) and in the Worker (authority) at a fixed 60 Hz tick.
//
// Input sign conventions (FlightInput) — one scheme for every aircraft. In direct mode (aim null) the
// axes are stick deflections in [-1, 1] and every axis commands a body rotation *rate*:
//   throttle +1 = more throttle / collective (W), -1 = less (S)
//   roll     +1 = roll right   (heli: tilts right → slides right)
//   pitch    +1 = nose up      (heli: nose up → slows / flies backwards)
//   yaw      +1 = yaw right    (rudder / tail-rotor pedals)
//   aim      optional mouse-aim mode: world-space direction the autopilot steers the nose toward.
//
// Body axes: nose = -Z, up = +Y, right = +X. angularVelocity is body-space, right-handed:
//   x > 0 nose up, y > 0 nose left, z > 0 roll left.
import type { FlightInput, FlightState, Quat, Vec3, VehicleKind, WorldQuery } from "./types"
import { WATER_LEVEL, type SpawnPoint } from "./geography"
import { VEHICLES, type VehicleSpec } from "./vehicles"

export const NEUTRAL_INPUT: FlightInput = { aim: null, throttle: 0, roll: 0, yaw: 0, pitch: 0, boost: false, brake: false }

export const GRAVITY = 9.81
const DEG = Math.PI / 180
/** Helicopter collective that exactly balances gravity. */
export const HOVER_COLLECTIVE = 0.5

// ---------------------------------------------------------------------------------------------
// Handling tables (private tuning). Speeds come from VEHICLES[kind]; these shape how it feels.
// ---------------------------------------------------------------------------------------------

interface JetHandling {
  /** Forward acceleration at full throttle from rest (m/s²). Drag is derived so that full throttle settles at `cruise`. */
  thrust: number
  /** Throttle change per second while W/S is held. */
  throttleRate: number
  /** Max pitch rate at corner speed (rad/s). This is the main "turn rate" knob. */
  pitchRate: number
  /** Nose-down authority as a fraction of pitchRate. */
  pushFrac: number
  rollRate: number
  yawRate: number
  /** First-order angular response (1/s): higher = snappier. */
  pitchResponse: number
  rollResponse: number
  yawResponse: number
  /** Autopilot proportional gains (rad/s per rad of error). Keep ≲ response/3.5 to avoid overshoot. */
  pitchGain: number
  rollGain: number
  yawGain: number
  /** How fast velocity aligns with the nose (1/s). Lower = more drift / slide in hard turns. */
  grip: number
  /** Full turn authority from cornerFrac × cruise up to cruise. Below that it fades linearly. */
  cornerFrac: number
  /** Turn authority multiplier at boost speed (fast = wider turns). */
  boostAuth: number
  /** Induced drag in turns: decel = bleed × turnRate × speed. */
  bleed: number
  /** Drag multiplier with the airbrake out. */
  airbrake: number
  /** Wheel brake deceleration on the ground (m/s²). */
  wheelBrake: number
  /** Fraction of gravity carried by the fuselage at knife-edge. */
  sideLift: number
  /** Coordinated-turn assist: heading rate = bankTurn × g·sin(bank)/v. */
  bankTurn: number
  /** Wings-leveling gain (1/s): mouse-aim hands-off, and direct-mode trim within trimZone. */
  stability: number
  /** Direct steering: bank residual (rad) trimmed toward level when hands-off, nose-down pitch fraction. */
  trimZone: number
  directPush: number
  /** Direct steering: pitch authority multiplier over pitchRate (snappier loops than the autopilot). */
  directPitch: number
  /** Max nose-up attitude while wheels are on the ground. */
  maxGroundPitch: number
  /** Body origin height above ground with gear down / belly contact height. */
  gearHeight: number
  bellyHeight: number
}

interface HeliHandling {
  collectiveRate: number
  /** Collective return-to-hover rate (units/s) when W/S is released in the air. */
  collectiveReturn: number
  /** Vertical speed damping (1/s) while the collective is released or hover-hold is on. */
  altitudeHold: number
  /** Ground-effect cushion: sink damping (1/s) ramping in below cushionHeight (m AGL). */
  cushion: number
  cushionHeight: number
  /** Max forward tilt (normal / boost), back tilt and side tilt (rad). */
  maxTilt: number
  boostTilt: number
  backTilt: number
  sideTilt: number
  /** Direct steering: cyclic pitch rate at full input (rad/s); hands-off near-level drift damping (1/s). */
  cyclicRate: number
  driftKill: number
  /** Attitude P gain (rad/s per rad), max tilt rate and angular response. */
  tiltGain: number
  maxTiltRate: number
  tiltResponse: number
  yawRate: number
  yawGain: number
  yawResponse: number
  /** Extra gain on the horizontal part of rotor thrust (arcade: tilt translates harder than real). */
  cyclicGain: number
  /** Horizontal drag: a = -(quad·|v| + lin)·v. Vertical: a = -vert·vy. */
  dragQuad: number
  dragLin: number
  dragVert: number
  /** Heading grip at speed (1/s): forward flight follows the nose. */
  grip: number
  gearHeight: number
}

const JET: Record<Exclude<VehicleKind, "apache">, JetHandling> = {
  fighter: {
    thrust: 15, throttleRate: 0.6,
    pitchRate: 0.58, pushFrac: 0.5, rollRate: 3.5, yawRate: 0.3,
    pitchResponse: 8.5, rollResponse: 13, yawResponse: 8.5,
    pitchGain: 2.4, rollGain: 3.6, yawGain: 1.8,
    grip: 3.2, cornerFrac: 0.7, boostAuth: 0.82, bleed: 0.05,
    airbrake: 2.8, wheelBrake: 10, sideLift: 0.55, bankTurn: 1, stability: 0.6,
    trimZone: 10 * DEG, directPush: 0.75, directPitch: 1.25,
    maxGroundPitch: 13 * DEG, gearHeight: 2, bellyHeight: 1,
  },
  warthog: {
    thrust: 10.5, throttleRate: 0.5,
    pitchRate: 0.46, pushFrac: 0.55, rollRate: 2.6, yawRate: 0.35,
    pitchResponse: 6.5, rollResponse: 9.5, yawResponse: 6.5,
    pitchGain: 1.8, rollGain: 2.7, yawGain: 1.7,
    grip: 4, cornerFrac: 0.6, boostAuth: 0.85, bleed: 0.035,
    airbrake: 3, wheelBrake: 9, sideLift: 0.6, bankTurn: 1, stability: 0.9,
    trimZone: 10 * DEG, directPush: 0.75, directPitch: 1.2,
    maxGroundPitch: 12 * DEG, gearHeight: 2, bellyHeight: 1,
  },
  blackbird: {
    thrust: 17, throttleRate: 0.45,
    pitchRate: 0.24, pushFrac: 0.5, rollRate: 1.75, yawRate: 0.12,
    pitchResponse: 4.5, rollResponse: 6.5, yawResponse: 4.5,
    pitchGain: 1.25, rollGain: 1.9, yawGain: 0.9,
    grip: 2.2, cornerFrac: 0.6, boostAuth: 0.8, bleed: 0.05,
    airbrake: 2.5, wheelBrake: 9, sideLift: 0.5, bankTurn: 1, stability: 0.4,
    trimZone: 10 * DEG, directPush: 0.75, directPitch: 1.3,
    maxGroundPitch: 12 * DEG, gearHeight: 2, bellyHeight: 1,
  },
}

const HELI: Record<"apache", HeliHandling> = {
  apache: {
    collectiveRate: 0.8, collectiveReturn: 1.5, altitudeHold: 1.5, cushion: 3, cushionHeight: 10,
    maxTilt: 25 * DEG, boostTilt: 36 * DEG, backTilt: 18 * DEG, sideTilt: 22 * DEG,
    cyclicRate: 0.9, driftKill: 0.35,
    tiltGain: 4, maxTiltRate: 1.6, tiltResponse: 9,
    yawRate: 1.7, yawGain: 3, yawResponse: 7,
    cyclicGain: 1.8, dragQuad: 1.063e-3, dragLin: 0.03, dragVert: 0.6,
    grip: 0.9, gearHeight: 2,
  },
}

interface HeliDirectHandling {
  /** Collective change per second while W/S held; hover detent half-width and pull rate. */
  collectiveRate: number
  detentWidth: number
  detentRate: number
  /** Max body rates at full input (rad/s) and their response (1/s; also how fast they damp on release). */
  pitchRate: number
  rollRate: number
  yawRate: number
  cyclicResponse: number
  yawResponse: number
  /** Righting: rate (rad/s) = min(rightGain·tilt, rightCap), tapering to rightInverted when upside down;
   *  full stick deflection on an axis scales it by (1 - rightUnderInput). */
  rightGain: number
  rightCap: number
  rightInverted: number
  rightUnderInput: number
  /** Released collective above this eases toward hover at highReturnRate (units/s). */
  highCollective: number
  highReturnRate: number
  /** Horizontal share of rotor thrust multiplier, drag (horizontal quad/lin, vertical lin). */
  cyclicGain: number
  dragQuad: number
  dragLin: number
  dragVert: number
  /** Brake (X) auto-hover: velocity→tilt gain, max tilt, attitude gain, vertical damping, collective pull. */
  brakeGain: number
  brakeTilt: number
  brakeAttitudeGain: number
  brakeRecoverRate: number
  brakeVertical: number
  brakeCollectiveRate: number
  cushion: number
  cushionHeight: number
  gearHeight: number
}

const HELI_DIRECT: Record<"apache", HeliDirectHandling> = {
  apache: {
    collectiveRate: 1.2, detentWidth: 0.1, detentRate: 0.3,
    pitchRate: 1.5, rollRate: 1.6, yawRate: 1.5, cyclicResponse: 12, yawResponse: 10,
    rightGain: 1.6, rightCap: 1.0, rightInverted: 0.35, rightUnderInput: 0.5,
    highCollective: 0.6, highReturnRate: 0.35,
    cyclicGain: 1.3, dragQuad: 1.6e-3, dragLin: 0.08, dragVert: 0.55,
    brakeGain: 0.6, brakeTilt: 30 * DEG, brakeAttitudeGain: 3, brakeRecoverRate: 3, brakeVertical: 1.5, brakeCollectiveRate: 0.8,
    cushion: 2, cushionHeight: 8, gearHeight: 2,
  },
}

// ---------------------------------------------------------------------------------------------
// Math helpers (allocation-free variants write into scratch arrays)
// ---------------------------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
/** Clamp an untrusted input axis to [-1, 1]; NaN → 0. */
const axis = (v: number) => (v > 1 ? 1 : v < -1 ? -1 : v === v ? v : 0)
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}
const wrapAngle = (a: number) => {
  while (a > Math.PI) a -= 2 * Math.PI
  while (a < -Math.PI) a += 2 * Math.PI
  return a
}

/** out = q ⊗ v (or conj(q) ⊗ v when inverse). */
function rotInto(out: number[], q: Quat, vx: number, vy: number, vz: number, inverse = false): void {
  const qx = inverse ? -q[0] : q[0], qy = inverse ? -q[1] : q[1], qz = inverse ? -q[2] : q[2], qw = q[3]
  const tx = 2 * (qy * vz - qz * vy)
  const ty = 2 * (qz * vx - qx * vz)
  const tz = 2 * (qx * vy - qy * vx)
  out[0] = vx + qw * tx + (qy * tz - qz * ty)
  out[1] = vy + qw * ty + (qz * tx - qx * tz)
  out[2] = vz + qw * tz + (qx * ty - qy * tx)
}

/** q ← normalize(q ⊗ exp(ω·dt/2)), ω in body space. */
function integrateOrientation(q: Quat, wx: number, wy: number, wz: number, dt: number): void {
  const rate = Math.sqrt(wx * wx + wy * wy + wz * wz)
  if (rate < 1e-9) return
  const half = rate * dt * 0.5
  const k = Math.sin(half) / rate
  const bx = wx * k, by = wy * k, bz = wz * k, bw = Math.cos(half)
  const ax = q[0], ay = q[1], az = q[2], aw = q[3]
  let x = aw * bx + ax * bw + ay * bz - az * by
  let y = aw * by - ax * bz + ay * bw + az * bx
  let z = aw * bz + ax * by - ay * bx + az * bw
  let w = aw * bw - ax * bx - ay * by - az * bz
  const n = 1 / Math.sqrt(x * x + y * y + z * z + w * w)
  q[0] = x * n; q[1] = y * n; q[2] = z * n; q[3] = w * n
}

/** Write yaw (about world Y; 0 = nose -Z, + = nose left), pitch (+ = nose up) and bank (+ = right wing down). */
function setYawPitchRoll(q: Quat, yaw: number, pitch: number, bank: number): void {
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2)
  const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2)
  const cr = Math.cos(-bank / 2), sr = Math.sin(-bank / 2)
  // qYaw ⊗ qPitch
  const ax = cy * sp, ay = sy * cp, az = -sy * sp, aw = cy * cp
  // ⊗ qRoll (about Z)
  q[0] = ax * cr + ay * sr
  q[1] = ay * cr - ax * sr
  q[2] = aw * sr + az * cr
  q[3] = aw * cr - az * sr
}

// Scratch (module-level, reused every tick).
const F = [0, 0, 0] // world nose
const U = [0, 0, 0] // world up
const R = [0, 0, 0] // world right
const TMP = [0, 0, 0]
const AIM = [0, 0, 0]

function basis(q: Quat): void {
  rotInto(F, q, 0, 0, -1)
  rotInto(U, q, 0, 1, 0)
  rotInto(R, q, 1, 0, 0)
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

export function createFlightState(kind: VehicleKind, spawn: SpawnPoint): FlightState {
  const heli = VEHICLES[kind].flight === "heli"
  const orientation: Quat = [0, 0, 0, 1]
  setYawPitchRoll(orientation, spawn.yaw, 0, 0)
  const airSpeed = heli ? 0 : VEHICLES[kind].cruise
  return {
    kind,
    position: [spawn.position[0], spawn.position[1], spawn.position[2]],
    velocity: spawn.onGround ? [0, 0, 0] : [-Math.sin(spawn.yaw) * airSpeed, 0, -Math.cos(spawn.yaw) * airSpeed],
    orientation,
    angularVelocity: [0, 0, 0],
    throttle: heli ? (spawn.onGround ? 0.35 : 0.5) : (spawn.onGround ? 0 : 1),
    onGround: spawn.onGround,
    gearDown: spawn.onGround || heli,
    crashed: null,
    tick: 0,
  }
}

/** Advance one fixed tick (dt = TICK_DT). Mutates state. Must be deterministic. */
export function stepFlight(state: FlightState, input: FlightInput, dt: number, world: WorldQuery): void {
  if (state.crashed) return
  state.tick++
  const spec = VEHICLES[state.kind]

  // Sanitize aim into AIM (unit), or mark absent.
  let hasAim = false
  const a = input.aim
  if (a) {
    const len = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2])
    if (len > 1e-6) {
      AIM[0] = a[0] / len; AIM[1] = a[1] / len; AIM[2] = a[2] / len
      hasAim = true
    }
  }

  if (spec.flight === "heli") {
    if (hasAim) stepHeliAim(state, input, dt, world, HELI[state.kind as "apache"])
    else stepHeliDirect(state, input, dt, world, HELI_DIRECT[state.kind as "apache"])
  }
  else stepJet(state, input, hasAim, dt, world, spec, JET[state.kind as Exclude<VehicleKind, "apache">])
}

/** Thin-air factor: 1 below ceiling-400 m, 0 at the ceiling. */
function airFactor(y: number, ceiling: number): number {
  return clamp((ceiling - y) / 400, 0, 1)
}

function stepJet(s: FlightState, inp: FlightInput, hasAim: boolean, dt: number, world: WorldQuery, spec: VehicleSpec, h: JetHandling): void {
  const q = s.orientation, v = s.velocity, w = s.angularVelocity, p = s.position
  s.throttle = clamp(s.throttle + axis(inp.throttle) * h.throttleRate * dt, 0, 1)
  const inRoll = axis(inp.roll), inPitch = axis(inp.pitch), inYaw = axis(inp.yaw)

  basis(q)
  let speed = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
  const vf = v[0] * F[0] + v[1] * F[1] + v[2] * F[2]
  const air = airFactor(p[1], world.ceiling)
  const stall = spec.stall
  const lift = smoothstep(0.7 * stall, stall, vf) * air

  // Speed-dependent turn authority: ramps up to corner speed, fades toward boost.
  const corner = h.cornerFrac * spec.cruise
  const auth = vf < corner ? Math.max(0.3, vf / corner)
    : vf <= spec.cruise ? 1
    : 1 + (h.boostAuth - 1) * clamp((vf - spec.cruise) / (spec.boost - spec.cruise), 0, 1.5)
  const rollAuth = 0.4 + 0.6 * Math.min(auth, 1)
  const pitchMax = h.pitchRate * auth, yawMax = h.yawRate * auth, rollMax = h.rollRate * rollAuth

  const bank = Math.atan2(-R[1], U[1])
  const pitchAngle = Math.asin(clamp(F[1], -1, 1))

  // Desired rates in pilot terms: + pitch up, + yaw right, + roll right (rad/s).
  let pUp = 0, yRight = 0, rRight = 0

  if (s.onGround) {
    // Nosewheel steering + rotation.
    const steerMax = 0.25 + 0.45 * (1 - clamp(speed / stall, 0, 1))
    if (inYaw !== 0) yRight = inYaw * steerMax
    else if (hasAim && (AIM[0] * AIM[0] + AIM[2] * AIM[2]) > 1e-6) {
      const heading = Math.atan2(-F[0], -F[2])
      const aimHeading = Math.atan2(-AIM[0], -AIM[2])
      yRight = clamp(-wrapAngle(aimHeading - heading) * 2, -steerMax, steerMax)
    }
    let targetPitch = 0
    if (vf > 0.88 * stall) {
      if (inPitch !== 0) targetPitch = Math.max(0, inPitch) * h.maxGroundPitch
      else if (hasAim) targetPitch = clamp(Math.asin(clamp(AIM[1], -1, 1)), 0, h.maxGroundPitch)
      // Forgiving: past takeoff speed the jet rotates by itself unless the pilot holds the nose down.
      if (vf > stall && inPitch >= 0 && !inp.brake && (s.throttle > 0.6 || inp.boost) && !(hasAim && AIM[1] < -0.035)) targetPitch = Math.max(targetPitch, 6 * DEG)
    }
    pUp = clamp((targetPitch - pitchAngle) * 3, -0.4, 0.4)
  } else {
    if (hasAim) {
      // Mouse-aim autopilot (War Thunder style).
      rotInto(TMP, q, AIM[0], AIM[1], AIM[2], true)
      const lx = TMP[0], ly = TMP[1], fz = -TMP[2]
      const ang = Math.acos(clamp(fz, -1, 1))
      // When the target is (nearly) behind, bias toward pulling up so the roll axis doesn't dither.
      const behind = fz < -0.6 ? (-0.6 - fz) * 2.5 : 0
      // Small offsets below the nose: push. Large offsets: roll so the target is overhead and pull.
      const s2 = smoothstep(25 * DEG, 60 * DEG, ang)
      const absLy = Math.abs(ly)
      const uRoll = absLy + (ly - absLy) * s2 + behind
      const rollToTarget = Math.atan2(lx, uRoll)
      const aggressive = smoothstep(4 * DEG, 20 * DEG, ang)
      const rollErr = aggressive * rollToTarget + (1 - aggressive) * -bank
      const pitchErr = Math.atan2(ly + behind, fz)
      const yawErr = Math.atan2(lx, Math.max(fz, 0.2))
      pUp = h.pitchGain * pitchErr
      rRight = h.rollGain * rollErr
      // Rudder only for fine alignment: while banked hard, body-yaw would drag the nose off the horizon.
      yRight = h.yawGain * yawErr * (1 - aggressive)
      if (inPitch !== 0) pUp = inPitch * pitchMax
      if (inYaw !== 0) yRight = inYaw * yawMax
      if (inRoll !== 0) rRight = inRoll * rollMax
      pUp = clamp(pUp, -pitchMax * h.pushFrac, pitchMax)
      yRight = clamp(yRight, -yawMax, yawMax)
      rRight = clamp(rRight, -rollMax, rollMax)
    } else {
      // Direct steering (stick deflections): pitch/roll rates proportional to deflection around the
      // body axes, gentle rudder. Turning = roll + pull. Only tiny bank residuals (<10°) are trimmed out.
      const directMax = pitchMax * h.directPitch
      pUp = inPitch * directMax * (inPitch < 0 ? h.directPush : 1)
      yRight = inYaw * yawMax
      rRight = inRoll * rollMax
      if (Math.cos(pitchAngle) > 0.5) rRight -= bank * h.stability * (1 - smoothstep(0.5 * h.trimZone, h.trimZone, Math.abs(bank))) * (1 - Math.abs(inRoll))
      pUp = clamp(pUp, -directMax, directMax)
      rRight = clamp(rRight, -rollMax, rollMax)
    }
  }

  // Body-space target angular velocity.
  let tx = pUp, ty = -yRight, tz = -rRight
  if (!s.onGround) {
    // Coordinated-turn assist: banking alone gently turns the nose around world up.
    const turn = -h.bankTurn * GRAVITY * Math.sin(bank) * Math.max(0, Math.cos(pitchAngle)) * lift / Math.max(speed, stall)
    rotInto(TMP, q, 0, turn, 0, true)
    tx += TMP[0]; ty += TMP[1]; tz += TMP[2]
    // Stall: nose falls toward the ground and weathervanes into the airflow.
    const unlift = 1 - lift
    if (unlift > 0) {
      rotInto(TMP, q, 0, -1, 0, true) // world down in body space
      const fwdDown = -TMP[2]
      tx += clamp(0.8 * Math.atan2(TMP[1], fwdDown), -0.6, 0.6) * unlift
      ty += clamp(0.8 * Math.atan2(-TMP[0], fwdDown), -0.6, 0.6) * unlift
      if (speed > 5) {
        rotInto(TMP, q, v[0], v[1], v[2], true)
        const bf = -TMP[2]
        if (bf > 0) {
          tx += clamp(Math.atan2(TMP[1], bf), -0.5, 0.5) * unlift
          ty += clamp(Math.atan2(-TMP[0], bf), -0.5, 0.5) * unlift
        }
      }
    }
  }

  // Carry the existing pitch/yaw rate through this tick's roll (world-fixed turn rate), so rolling into
  // a turn doesn't swing a lagging yaw rate into a nose-down pitch.
  const rollStep = w[2] * dt, cr = Math.cos(rollStep), sr = Math.sin(rollStep)
  const wx0 = w[0], wy0 = w[1]
  w[0] = wx0 * cr + wy0 * sr
  w[1] = -wx0 * sr + wy0 * cr
  w[0] += (tx - w[0]) * (1 - Math.exp(-h.pitchResponse * dt))
  w[1] += (ty - w[1]) * (1 - Math.exp(-h.yawResponse * dt))
  w[2] += (tz - w[2]) * (1 - Math.exp(-h.rollResponse * dt))
  integrateOrientation(q, w[0], w[1], w[2], dt)
  basis(q)

  // Forces.
  const engine = 0.35 + 0.65 * air
  const thrust = (inp.boost ? h.thrust * (spec.boost / spec.cruise) ** 2 : s.throttle * h.thrust) * engine
  const dragK = (h.thrust / (spec.cruise * spec.cruise)) * (inp.brake ? h.airbrake : 1)
  const turnRate = Math.sqrt(w[0] * w[0] + w[1] * w[1])
  const resist = speed > 1e-6 ? (dragK * speed * speed + h.bleed * turnRate * speed) / speed : 0
  const liftU = lift * GRAVITY * U[1], liftR = lift * GRAVITY * h.sideLift * R[1]
  let ax = F[0] * thrust - v[0] * resist + U[0] * liftU + R[0] * liftR
  let ay = F[1] * thrust - v[1] * resist + U[1] * liftU + R[1] * liftR - GRAVITY
  let az = F[2] * thrust - v[2] * resist + U[2] * liftU + R[2] * liftR
  if (p[1] > world.ceiling) ay -= (p[1] - world.ceiling) * 0.3
  v[0] += ax * dt; v[1] += ay * dt; v[2] += az * dt

  // Grip: velocity swings toward the nose (arcade "goes where you point"), preserving speed.
  speed = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
  const along = v[0] * F[0] + v[1] * F[1] + v[2] * F[2]
  if (speed > 1 && along > 0) {
    const k = 1 - Math.exp(-h.grip * (0.2 + 0.8 * lift) * dt)
    v[0] += (F[0] * speed - v[0]) * k
    v[1] += (F[1] * speed - v[1]) * k
    v[2] += (F[2] * speed - v[2]) * k
    const n = speed / Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
    v[0] *= n; v[1] *= n; v[2] *= n
  }
  if (p[1] > world.ceiling + 150 && v[1] > 0) v[1] = 0

  p[0] += v[0] * dt; p[1] += v[1] * dt; p[2] += v[2] * dt

  const ground = resolveGround(s, world, false, h.gearHeight, h.bellyHeight, spec.stall, h.maxGroundPitch, inp.brake ? h.wheelBrake : 0.4, dt)
  if (s.crashed) return

  // Gear: auto-retract after climb-out, auto-extend on a slow approach.
  const agl = p[1] - h.gearHeight - ground
  const gs = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
  if (s.onGround) s.gearDown = true
  else if (s.gearDown && agl > 40) s.gearDown = false
  else if (!s.gearDown && agl < 25 && gs < 1.4 * stall) s.gearDown = true

  checkBoundary(s, world)
}

/**
 * Battlefield-style helicopter (direct mode, aim null). Rotor thrust along body up, collective set by
 * W/S and held where left (small hover detent), cyclic pitch/roll and pedal yaw are rate commands with
 * no angle limits. Only light help: rates damp on release and a weak self-level within ~15° of level.
 */
function stepHeliDirect(s: FlightState, inp: FlightInput, dt: number, world: WorldQuery, h: HeliDirectHandling): void {
  const q = s.orientation, v = s.velocity, w = s.angularVelocity, p = s.position
  const inCollective = axis(inp.throttle)
  const inRoll = axis(inp.roll), inPitch = axis(inp.pitch), inYaw = axis(inp.yaw)
  if (inCollective !== 0) s.throttle = clamp(s.throttle + inCollective * h.collectiveRate * dt, 0, 1)
  else if (!s.onGround) {
    const d = HOVER_COLLECTIVE - s.throttle
    // Hold where left, except: X pulls to hover, near-hover snaps to the detent, and a released high
    // collective (> highCollective) eases back down (then into the detent) so it doesn't climb forever.
    const pull = inp.brake ? h.brakeCollectiveRate
      : Math.abs(d) < h.detentWidth ? h.detentRate
      : s.throttle > h.highCollective ? h.highReturnRate : 0
    const step = pull * dt
    s.throttle += d > step ? step : d < -step ? -step : d
  }

  basis(q)
  const pitchAngle = Math.asin(clamp(F[1], -1, 1))
  const bank = Math.atan2(-R[1], U[1])

  // Body-space rate targets: x nose-up, y nose-left, z roll-left.
  let tx = inPitch * h.pitchRate
  let ty = -inYaw * h.yawRate
  let tz = -inRoll * h.rollRate
  // Righting axis: rotate body-up toward world-up (no yaw component).
  rotInto(TMP, q, 0, 1, 0, true) // world up in body space
  const tilt = Math.acos(clamp(TMP[1], -1, 1))
  let axX = TMP[2], axZ = -TMP[0]
  let axN = Math.sqrt(axX * axX + axZ * axZ)
  if (axN < 1e-4) { axX = 0; axZ = 1; axN = 1 }
  axX /= axN; axZ /= axN
  if (inp.brake && !s.onGround && tilt > h.brakeTilt * 1.5) {
    // Auto-hover from an unusual attitude: right it quickly first.
    const r = Math.min(h.brakeAttitudeGain * tilt, h.brakeRecoverRate)
    if (inPitch === 0) tx = axX * r
    if (inRoll === 0) tz = axZ * r
  } else if (inp.brake && !s.onGround) {
    // Auto-hover assist: tilt against velocity (bounded), level otherwise.
    const heading = Math.atan2(-F[0], -F[2])
    const vF = v[0] * -Math.sin(heading) + v[2] * -Math.cos(heading)
    const vR = v[0] * Math.cos(heading) + v[2] * -Math.sin(heading)
    const pitchT = clamp(Math.atan(vF * h.brakeGain / GRAVITY), -h.brakeTilt, h.brakeTilt)
    const bankT = clamp(Math.atan(-vR * h.brakeGain / GRAVITY), -h.brakeTilt, h.brakeTilt)
    if (inPitch === 0) tx = clamp(h.brakeAttitudeGain * wrapAngle(pitchT - pitchAngle), -h.pitchRate, h.pitchRate)
    if (inRoll === 0) tz = -clamp(h.brakeAttitudeGain * wrapAngle(bankT - bank), -h.rollRate, h.rollRate)
  } else if (!s.onGround) {
    // Progressive righting: proportional to tilt up to a cap at moderate angles, tapering to a gentle
    // pull when inverted (flips stay possible, recovery is slow). Stick input weakens it on that axis
    // but never removes it, so short key presses can't flip the heli.
    const strength = Math.min(h.rightGain * tilt, h.rightCap) + (h.rightInverted - h.rightCap) * smoothstep(100 * DEG, 170 * DEG, tilt)
    tx += axX * strength * (1 - h.rightUnderInput * Math.abs(inPitch))
    tz += axZ * strength * (1 - h.rightUnderInput * Math.abs(inRoll))
  }
  if (s.onGround && s.throttle < 0.3) ty = 0
  const kc = 1 - Math.exp(-h.cyclicResponse * dt)
  w[0] += (tx - w[0]) * kc
  w[1] += (ty - w[1]) * (1 - Math.exp(-h.yawResponse * dt))
  w[2] += (tz - w[2]) * kc
  integrateOrientation(q, w[0], w[1], w[2], dt)
  basis(q)

  const air = airFactor(p[1], world.ceiling)
  const lift = GRAVITY * (s.throttle / HOVER_COLLECTIVE) * air
  const hs = Math.sqrt(v[0] * v[0] + v[2] * v[2])
  const hd = h.dragQuad * hs + h.dragLin
  const ax = U[0] * lift * h.cyclicGain - v[0] * hd
  let ay = U[1] * lift - GRAVITY - v[1] * h.dragVert
  const az = U[2] * lift * h.cyclicGain - v[2] * hd
  if (inp.brake) ay -= v[1] * h.brakeVertical
  const agl = p[1] - h.gearHeight - world.groundHeight(p[0], p[2])
  if (v[1] < 0 && agl < h.cushionHeight) ay -= v[1] * h.cushion * (1 - Math.max(agl, 0) / h.cushionHeight)
  if (p[1] > world.ceiling) ay -= (p[1] - world.ceiling) * 0.3
  v[0] += ax * dt; v[1] += ay * dt; v[2] += az * dt
  if (p[1] > world.ceiling + 150 && v[1] > 0) v[1] = 0

  p[0] += v[0] * dt; p[1] += v[1] * dt; p[2] += v[2] * dt
  s.gearDown = true
  resolveGround(s, world, true, h.gearHeight, h.gearHeight, 0, 0, 0, dt)
  if (s.crashed) return
  checkBoundary(s, world)
}

/** Mouse-aim helicopter (aim non-null): nose follows the aim heading/elevation with stabilized attitude. */
function stepHeliAim(s: FlightState, inp: FlightInput, dt: number, world: WorldQuery, h: HeliHandling): void {
  const hasAim = true
  const q = s.orientation, v = s.velocity, w = s.angularVelocity, p = s.position
  const inCollective = axis(inp.throttle)
  if (inCollective !== 0) s.throttle = clamp(s.throttle + inCollective * h.collectiveRate * dt, 0, 1)
  else if (!s.onGround) {
    // Released in the air: collective eases back to the hover detent (W/S = climb/descend while held).
    const d = HOVER_COLLECTIVE - s.throttle, step = h.collectiveReturn * dt
    s.throttle += d > step ? step : d < -step ? -step : d
  }
  const inRoll = axis(inp.roll), inPitch = axis(inp.pitch), inYaw = axis(inp.yaw)

  basis(q)
  const heading = Math.atan2(-F[0], -F[2])
  const pitchAngle = Math.asin(clamp(F[1], -1, 1))
  const bank = Math.atan2(-R[1], U[1])
  const hfx = -Math.sin(heading), hfz = -Math.cos(heading) // horizontal nose
  const hrx = Math.cos(heading), hrz = -Math.sin(heading) // horizontal right
  const vF = v[0] * hfx + v[2] * hfz
  const vR = v[0] * hrx + v[2] * hrz

  // Yaw (left-positive rate around world up).
  let yawLeft = 0
  if (inYaw !== 0) yawLeft = -inYaw * h.yawRate
  else if (hasAim) {
    const horiz = Math.sqrt(AIM[0] * AIM[0] + AIM[2] * AIM[2])
    if (horiz > 1e-4) {
      const err = wrapAngle(Math.atan2(-AIM[0], -AIM[2]) - heading)
      yawLeft = clamp(h.yawGain * err * Math.min(1, horiz * 3), -h.yawRate, h.yawRate)
    }
  }
  if (s.onGround && s.throttle < 0.3) yawLeft = 0

  // Attitude targets: nose-up positive pitch, right-positive bank.
  const tiltLimit = inp.boost ? h.boostTilt : h.maxTilt
  let pitchT = 0, bankT = 0
  // Hover-hold: tilt against horizontal drift. Brake = strong, hands-off near-level = gentle.
  let hold = inp.brake ? 1 : 0
  let holdGain = 1.2
  let driftKill = 0
  const nearLevel = Math.abs(pitchAngle) < 4 * DEG
  if (!inp.brake && inPitch === 0 && inRoll === 0 && !inp.boost) {
    if (hasAim) {
      hold = 1 - smoothstep(2 * DEG, 6 * DEG, Math.abs(Math.asin(clamp(AIM[1], -1, 1))))
      holdGain = 0.35
    } else if (nearLevel) driftKill = h.driftKill
  }
  const holdPitch = clamp(Math.atan((vF * holdGain) / (GRAVITY * h.cyclicGain)), -h.maxTilt, h.backTilt)
  const holdBank = clamp(Math.atan((-vR * holdGain) / (GRAVITY * h.cyclicGain)), -h.sideTilt, h.sideTilt)
  // Mouse-aim: nose follows aim elevation. Direct: cyclic is a rate command and the tilt is held on
  // release (snapping level only when already near level), so forward flight needs no constant input.
  pitchT = hasAim ? Math.asin(clamp(AIM[1], -1, 1)) : nearLevel ? 0 : pitchAngle
  if (inp.boost) pitchT = Math.min(pitchT, -h.boostTilt)
  if (inPitch !== 0) pitchT = hasAim ? inPitch * (inPitch > 0 ? h.backTilt : h.maxTilt) : pitchAngle + (inPitch * h.cyclicRate) / h.tiltGain
  pitchT = pitchT + (holdPitch - pitchT) * hold
  bankT = holdBank * hold
  if (inRoll !== 0) bankT = inRoll * h.sideTilt
  else bankT += clamp((-yawLeft * vF) / GRAVITY * 0.7, -20 * DEG, 20 * DEG) * smoothstep(10, 40, vF)
  pitchT = clamp(pitchT, -tiltLimit, h.backTilt)

  let tx = clamp(h.tiltGain * (pitchT - pitchAngle), -h.maxTiltRate, h.maxTiltRate)
  let tz = -clamp(h.tiltGain * (bankT - bank), -h.maxTiltRate, h.maxTiltRate)
  rotInto(TMP, q, 0, yawLeft, 0, true)
  tx += TMP[0]
  const ty = TMP[1]
  tz += TMP[2]
  const kt = 1 - Math.exp(-h.tiltResponse * dt)
  w[0] += (tx - w[0]) * kt
  w[1] += (ty - w[1]) * (1 - Math.exp(-h.yawResponse * dt))
  w[2] += (tz - w[2]) * kt
  integrateOrientation(q, w[0], w[1], w[2], dt)
  basis(q)

  // Rotor thrust along body up; tilt-compensated so collective 0.5 holds altitude in forward flight.
  const air = airFactor(p[1], world.ceiling)
  const lift = (GRAVITY * (s.throttle / HOVER_COLLECTIVE) * air) / Math.max(U[1], 0.6)
  const hs = Math.sqrt(v[0] * v[0] + v[2] * v[2])
  const hd = h.dragQuad * hs + h.dragLin + driftKill
  let ax = U[0] * lift * h.cyclicGain - v[0] * hd
  let ay = U[1] * lift - GRAVITY - v[1] * h.dragVert
  let az = U[2] * lift * h.cyclicGain - v[2] * hd
  // Altitude hold with the collective released (or hover-hold), and a ground-effect cushion.
  if (inp.brake || (inCollective === 0 && !s.onGround)) ay -= v[1] * h.altitudeHold
  const agl = p[1] - h.gearHeight - world.groundHeight(p[0], p[2])
  if (v[1] < 0 && agl < h.cushionHeight) ay -= v[1] * h.cushion * (1 - Math.max(agl, 0) / h.cushionHeight)
  if (p[1] > world.ceiling) ay -= (p[1] - world.ceiling) * 0.3
  v[0] += ax * dt; v[1] += ay * dt; v[2] += az * dt

  // Forward flight tracks the nose so turns at speed feel planted (not while strafing).
  if (inRoll === 0 && vF > 0 && hs > 1) {
    const k = 1 - Math.exp(-h.grip * smoothstep(15, 50, hs) * dt)
    if (k > 0) {
      const hs2 = Math.sqrt(v[0] * v[0] + v[2] * v[2])
      v[0] += (hfx * hs2 - v[0]) * k
      v[2] += (hfz * hs2 - v[2]) * k
      const n = hs2 / Math.max(1e-9, Math.sqrt(v[0] * v[0] + v[2] * v[2]))
      v[0] *= n; v[2] *= n
    }
  }
  if (p[1] > world.ceiling + 150 && v[1] > 0) v[1] = 0

  p[0] += v[0] * dt; p[1] += v[1] * dt; p[2] += v[2] * dt
  s.gearDown = true
  resolveGround(s, world, true, h.gearHeight, h.gearHeight, 0, 0, 0, dt)
  if (s.crashed) return
  checkBoundary(s, world)
}

/**
 * Wheel/skid contact. Returns the ground height under the aircraft.
 * Sets onGround, clamps to the surface, constrains attitude, applies wheel friction, or flags a crash.
 */
function resolveGround(
  s: FlightState, world: WorldQuery, heli: boolean,
  gearHeight: number, bellyHeight: number, stall: number, maxGroundPitch: number, wheelDecel: number, dt: number,
): number {
  const p = s.position, v = s.velocity, q = s.orientation, w = s.angularVelocity
  const ground = world.groundHeight(p[0], p[2])
  const clearance = s.gearDown ? gearHeight : bellyHeight
  if (p[1] - clearance > ground + 0.02) {
    s.onGround = false
    return ground
  }
  const runway = world.onRunway(p[0], p[2])
  const water = !runway && ground <= WATER_LEVEL + 0.01
  basis(q)
  const sink = -v[1]
  const pitch = Math.asin(clamp(F[1], -1, 1))
  const bank = Math.atan2(-R[1], U[1])
  const hs = Math.sqrt(v[0] * v[0] + v[2] * v[2])

  if (water) {
    s.crashed = "water"
  } else if (heli) {
    if (sink > 7.5 || Math.abs(bank) > 35 * DEG || Math.abs(pitch) > 35 * DEG || hs > 30) s.crashed = "terrain"
  } else if (runway) {
    if (!s.gearDown || sink > 6 || Math.abs(bank) > 25 * DEG || pitch < -10 * DEG || pitch > 25 * DEG) s.crashed = "terrain"
  } else {
    // Rough field: survivable only gentle, slow, wings level, gear down.
    if (!s.gearDown || sink > 4 || Math.abs(bank) > 20 * DEG || pitch < -8 * DEG || hs > 1.3 * stall) s.crashed = "terrain"
  }
  if (s.crashed) {
    p[1] = Math.max(p[1], ground)
    return ground
  }

  s.onGround = true
  p[1] = ground + gearHeight
  if (v[1] < 0) v[1] = 0

  // Constrain attitude: wings level; jets may rotate nose-up to maxGroundPitch, helis sit level.
  const heading = Math.atan2(-F[0], -F[2])
  const gp = heli ? 0 : clamp(pitch, 0, maxGroundPitch)
  setYawPitchRoll(q, heading, gp, 0)
  w[2] = 0
  if (heli || (gp <= 0 && w[0] < 0) || (gp >= maxGroundPitch && w[0] > 0)) w[0] = 0

  // Wheels: kill sideways slip, rolling friction / brakes along the nose.
  const hfx = -Math.sin(heading), hfz = -Math.cos(heading)
  let along = v[0] * hfx + v[2] * hfz
  let latX = v[0] - hfx * along, latZ = v[2] - hfz * along
  const latKeep = Math.exp(-(heli ? 4 : 12) * dt)
  latX *= latKeep; latZ *= latKeep
  if (heli) along *= Math.exp(-4 * dt)
  else {
    const dec = (wheelDecel + (runway ? 0 : 2)) * dt
    along = along > dec ? along - dec : along < -dec ? along + dec : 0
  }
  v[0] = hfx * along + latX
  v[2] = hfz * along + latZ
  return ground
}

function checkBoundary(s: FlightState, world: WorldQuery): void {
  const p = s.position
  if (p[0] > world.half || p[0] < -world.half || p[2] > world.half || p[2] < -world.half) s.crashed = "boundary"
}

/** Deep copy (JSON-safe). */
export function cloneFlight(state: FlightState): FlightState {
  const p = state.position, v = state.velocity, o = state.orientation, w = state.angularVelocity
  return {
    kind: state.kind,
    position: [p[0], p[1], p[2]],
    velocity: [v[0], v[1], v[2]],
    orientation: [o[0], o[1], o[2], o[3]],
    angularVelocity: [w[0], w[1], w[2]],
    throttle: state.throttle,
    onGround: state.onGround,
    gearDown: state.gearDown,
    crashed: state.crashed,
    tick: state.tick,
  }
}

// ---------------------------------------------------------------------------------------------
// Quaternion / attitude helpers (allocate; for UI, bots, rendering — not the hot path)
// ---------------------------------------------------------------------------------------------

/** Rotate v by q. Writes into `out` when given. */
export function rotate(q: Quat, v: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  rotInto(out, q, v[0], v[1], v[2])
  return out
}

/** World-space nose direction (unit vector, body -Z). */
export function forward(q: Quat): Vec3 {
  const [x, y, z, w] = q
  return [-(2 * (x * z + w * y)), -(2 * (y * z - w * x)), -(1 - 2 * (x * x + y * y))]
}

/** World-space body up (+Y). */
export function up(q: Quat): Vec3 {
  return rotate(q, [0, 1, 0])
}

/** World-space body right (+X). */
export function right(q: Quat): Vec3 {
  return rotate(q, [1, 0, 0])
}

/** Quaternion facing yaw (rad; 0 = nose -Z, + = nose toward -X / left). */
export function quatFromYaw(yaw: number): Quat {
  return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]
}

/** Quaternion from yaw (+ left), pitch (+ nose up), bank (+ right wing down), all radians. */
export function quatFromYawPitchRoll(yaw: number, pitch: number, bank: number): Quat {
  const q: Quat = [0, 0, 0, 1]
  setYawPitchRoll(q, yaw, pitch, bank)
  return q
}

/** Decompose into yaw (+ left, 0 = -Z), pitch (+ nose up), roll (+ right wing down), radians. */
export function yawPitchRoll(q: Quat): { yaw: number; pitch: number; roll: number } {
  basis(q)
  return { yaw: Math.atan2(-F[0], -F[2]), pitch: Math.asin(clamp(F[1], -1, 1)), roll: Math.atan2(-R[1], U[1]) }
}

/** Unit direction for a compass heading (rad, 0 = -Z north, + = clockwise/east) and elevation (rad). */
export function directionFromHeading(heading: number, elevation = 0): Vec3 {
  const c = Math.cos(elevation)
  return [Math.sin(heading) * c, Math.sin(elevation), -Math.cos(heading) * c]
}

/** Speed (along the nose) below which a jet stalls; 0 for helicopters. */
export function isStalled(state: FlightState): boolean {
  const spec = VEHICLES[state.kind]
  if (spec.flight !== "jet" || state.onGround) return false
  const f = forward(state.orientation), v = state.velocity
  return v[0] * f[0] + v[1] * f[1] + v[2] * f[2] < spec.stall * 0.85
}

/**
 * Readout for HUD: speed m/s, altitude m (above sea level), agl m (above ground; requires `world`,
 * otherwise equals altitude), heading deg 0..360 (0 = north/-Z, 90 = east/+X), pitch deg, roll deg
 * (+ right wing down), throttle 0..1, stalled, verticalSpeed m/s.
 */
export function flightReadout(state: FlightState, world?: WorldQuery) {
  const v = state.velocity, p = state.position
  const { yaw, pitch, roll } = yawPitchRoll(state.orientation)
  let heading = (-yaw / DEG) % 360
  if (heading < 0) heading += 360
  const gearHeight = VEHICLES[state.kind].flight === "heli" ? HELI.apache.gearHeight : JET[state.kind as Exclude<VehicleKind, "apache">].gearHeight
  return {
    speed: Math.hypot(v[0], v[1], v[2]),
    altitude: p[1],
    agl: world ? Math.max(0, p[1] - gearHeight - world.groundHeight(p[0], p[2])) : p[1],
    heading,
    pitch: pitch / DEG,
    roll: roll / DEG,
    throttle: state.throttle,
    stalled: isStalled(state),
    verticalSpeed: v[1],
    onGround: state.onGround,
    gearDown: state.gearDown,
  }
}
