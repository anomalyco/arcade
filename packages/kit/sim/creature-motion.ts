/**
 * Root locomotion for a large legged creature, hand-ported from lamplight's arachnid (`src/arachnid/motion.rs`,
 * `Motion::step_planar` and `Dynamics`). This TypeScript is now the source; lamplight is not kept in sync.
 *
 * Pure and deterministic: the room sim and the client step the same root from the same intents. It holds only the
 * root (position, velocity, heading, turn phase); legs are presentation (`@arcade/kit/creature/arachnid-legs`) and
 * never go on the wire. Lamplight gated its pivot on the feet; with no legs here, the same gates are timers at the
 * swing's 0.15 s recovery, so server and client agree.
 *
 * Everything runs in **creature units**, lamplight's own scale (a leg about one unit long, a walk at 1.15 units/s).
 * A creature of world size `S` m per unit is the same motion Froude-scaled: lengths × S, times × √S, speeds × √S,
 * accelerations unchanged. `unitSurface` and `unitDt` make that conversion at the boundary so the tuned constants
 * never change. Heading follows lamplight: forward is (cos h, −sin h) in X/Z, the three.js rotation about +Y.
 */

export type CreatureTurn = "travel" | "braking" | "planting" | "pivoting"
export type CreaturePace = "walk" | "run"

/** Steering in world X/Z. Its length (clamped to 1) is the share of full speed. */
export type CreatureIntent = { dx: number; dz: number; pace: CreaturePace }

/** Ground in one coordinate space. Heights must be finite; `walkable` marks where a foot may land. */
export type CreatureSurface = {
  heightAt(x: number, z: number): number
  walkable?(x: number, z: number): boolean
  /** Where a move from (fx, fz) toward (tx, tz) actually ends (collision). */
  constrain?(fx: number, fz: number, tx: number, tz: number): readonly [number, number]
}

export type CreatureMotion = {
  x: number
  z: number
  vx: number
  vz: number
  heading: number
  angularVelocity: number
  turn: CreatureTurn
  pace: CreaturePace
  /** 0 walking … 1 running, eased. */
  run: number
  desiredVx: number
  desiredVz: number
  /** Seconds the current turn phase's foot gate has been satisfied (the legless stand-in for planted/aligned). */
  gate: number
}

/** Lamplight's fixed tick in creature time; any step works, this is the one its numbers were measured at. */
export const CREATURE_STEP = 1 / 60
/** One swing: constant at both paces. The pivot gates wait this long. */
export const CREATURE_RECOVERY = 0.15
/** Full walking and running speeds, creature units per second. */
export const CREATURE_WALK = 1.15
export const CREATURE_RUN = CREATURE_WALK + 1.2

const PI = Math.PI
const TAU = PI * 2
const wrapAngle = (a: number) => ((((a + PI) % TAU) + TAU) % TAU) - PI

export function createCreatureMotion(x: number, z: number, heading = 0): CreatureMotion {
  return { x, z, vx: 0, vz: 0, heading, angularVelocity: 0, turn: "travel", pace: "walk", run: 0, desiredVx: 0, desiredVz: 0, gate: 0 }
}

/** Leg readiness when legs exist and drive the gate; omit to use the shared timers. */
export type CreatureGates = { planted: boolean; aligned: boolean }

/**
 * One tick of planar momentum and facing. A reversal goes Travel → Braking (6.5 units/s²) → Planting → Pivoting
 * (bounded angular acceleration) → Travel; it resumes only once the feet would have caught up.
 */
export function stepCreatureMotion(m: CreatureMotion, intent: CreatureIntent, dt: number, surface: CreatureSurface, gates?: CreatureGates): void {
  let dx = Number.isFinite(intent.dx) ? intent.dx : 0
  let dz = Number.isFinite(intent.dz) ? intent.dz : 0
  const raw = Math.hypot(dx, dz)
  if (raw > 1) { dx /= raw; dz /= raw }
  const mag = Math.min(1, raw)
  const active = mag > 0.04
  m.pace = intent.pace
  const run = intent.pace === "run" && active ? 1 : 0
  m.run += (run - m.run) * (1 - Math.exp(-dt * 8))

  const target = active ? Math.atan2(-dz, dx) : m.heading
  const angle = wrapAngle(target - m.heading)
  const speed = Math.hypot(m.vx, m.vz)
  const before = m.turn

  if (m.turn === "travel" && active && Math.abs(angle) > 1.55 && speed > 0.14) m.turn = "braking"
  if (m.turn === "braking") {
    if (Math.abs(angle) < 0.25) m.turn = "travel"
    else if (speed < 0.08) m.turn = "planting"
  }
  if (m.turn === "planting") {
    if (m.turn !== before) m.gate = 0
    m.gate += dt
    if (gates ? gates.planted : m.gate >= CREATURE_RECOVERY) m.turn = active ? "pivoting" : "travel"
  }
  if (m.turn === "pivoting") {
    if (m.turn !== before) m.gate = 0
    const settled = Math.abs(angle) < 0.08 && Math.abs(m.angularVelocity) < 0.35
    m.gate = settled ? m.gate + dt : 0
    if (settled && (gates ? gates.aligned : m.gate >= CREATURE_RECOVERY)) m.turn = "travel"
  }

  const yawTarget = !active || m.turn === "braking" || m.turn === "planting" ? 0 : Math.max(-3.6, Math.min(3.6, angle * 8))
  const maxYaw = 18 * dt
  m.angularVelocity += Math.max(-maxYaw, Math.min(maxYaw, yawTarget - m.angularVelocity))
  m.heading = wrapAngle(m.heading + m.angularVelocity * dt)
  if (!active && Math.abs(m.angularVelocity) < 0.001) m.turn = "travel"
  if (m.turn !== before) m.gate = 0

  const fx = Math.cos(m.heading), fz = -Math.sin(m.heading)
  const desiredSpeed = m.turn === "travel" && active ? mag * (CREATURE_WALK + 1.2 * m.run) * Math.max(0, Math.cos(angle)) : 0
  m.desiredVx = fx * desiredSpeed
  m.desiredVz = fz * desiredSpeed
  const braking = desiredSpeed < speed || m.turn !== "travel"
  const acceleration = braking ? 6.5 : 4.5 + 2 * m.run
  let ax = m.desiredVx - m.vx, az = m.desiredVz - m.vz
  const al = Math.hypot(ax, az), cap = acceleration * dt
  if (al > cap) { ax *= cap / al; az *= cap / al }
  const nvx = m.vx + ax, nvz = m.vz + az
  const tx = m.x + nvx * dt, tz = m.z + nvz * dt
  const [x, z] = surface.constrain ? surface.constrain(m.x, m.z, tx, tz) : [tx, tz]
  m.vx = (x - m.x) / dt
  m.vz = (z - m.z) / dt
  m.x = x
  m.z = z
}

/** A copy for snapshots, replay checks and interpolation. */
export const cloneCreatureMotion = (m: CreatureMotion): CreatureMotion => ({ ...m })

/** A world-space surface seen in creature units, for a creature of `size` m per unit. */
export function unitSurface(world: CreatureSurface, size: number): CreatureSurface {
  const k = 1 / size
  return {
    heightAt: (x, z) => world.heightAt(x * size, z * size) * k,
    walkable: world.walkable ? (x, z) => world.walkable!(x * size, z * size) : undefined,
    constrain: world.constrain
      ? (fx, fz, tx, tz) => {
          const [x, z] = world.constrain!(fx * size, fz * size, tx * size, tz * size)
          return [x * k, z * k] as const
        }
      : undefined,
  }
}

/** World seconds to creature seconds: a creature `size` times larger lives √size times slower. */
export const unitDt = (dt: number, size: number) => dt / Math.sqrt(size)

/**
 * t3ssel8r's second-order response (lamplight `Dynamics`): frequency `f` Hz, damping `z`, response `r`. It keeps its
 * position and velocity when the parameters change. A negative response anticipates; damping below one overshoots.
 * The stability clamp also covers weak leg support.
 */
export class SecondOrder {
  speed = 0
  private previous: number | null = null

  /** Advances `value` toward `target` and returns the new value. */
  step(value: number, target: number, f: number, z: number, r: number, dt: number): number {
    const k1 = z / (PI * f)
    const k2 = Math.max((TAU * f) ** -2, (dt * dt) / 2 + (dt * k1) / 2, dt * k1)
    const k3 = (r * z) / (TAU * f)
    const derivative = (target - (this.previous ?? target)) / dt
    this.previous = target
    const next = value + this.speed * dt
    this.speed += (dt * (target + k3 * derivative - next - k1 * this.speed)) / k2
    return next
  }
}
