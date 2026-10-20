import { angleDiff, clearLine, distToRect, RectGrid, type Rect } from "@arcade/kit/sim/geom"
import {
  boxMass,
  CARS,
  collideShapesXY,
  orientedShapeXY,
  rectShapeXY,
  resolveXY,
  separateXY,
  STATIC,
  WALL,
  type ContactXY,
  type Mass,
  type RigidXY,
} from "@arcade/kit/sim/obb"
import { Rng } from "@arcade/kit/sim/rng"
import type { AIAgent, OutbreakAISubsystem } from "./ai"
import {
  INTERACT_RANGE,
  type InteractAction,
  type InteractActorState,
  type InteractionHandler,
  type RawInteractCandidate,
} from "./interact"
import { CHUNK, EXTERIOR_VEHICLE_COLLIDERS, propShape, SIZE, type Building, type Town } from "./map"
import type { OutbreakProgression } from "./progression/progression"
import type { ProgressionSlot } from "./progression/types"
import { chunkKey, districtAtBlock, MACRO_CHUNKS, worldToChunk, type StreamingWorld, type WorldMode } from "./world"
import type { SavedVehicleState, VehicleKind } from "./vehicles/types"

export type { SavedVehicleState, VehicleKind } from "./vehicles/types"

export type VehicleSeat = {
  /** Forward offset from vehicle center (metres, +f is forward along heading). */
  f: number
  /** Rightward offset from vehicle center (metres, +s is right of heading). */
  s: number
  /** How far the seated survivor is lowered into the cabin (metres). */
  sink: number
  /** Damage multiplier while seated in this spot (0..1). */
  armor: number
}

export type OutbreakVehicleSpec = {
  kind: VehicleKind
  label: string
  length: number
  width: number
  mass: number
  maxSpeed: number
  reverse: number
  accel: number
  brake: number
  turn: number
  grip: number
  hp: number
  maxFuel: number
  seats: readonly VehicleSeat[]
}

const FOUR_SEATS: readonly VehicleSeat[] = [
  { f: 0.15, s: -0.42, sink: 0.48, armor: 0.35 },
  { f: 0.15, s: 0.42, sink: 0.48, armor: 0.45 },
  { f: -0.78, s: -0.42, sink: 0.48, armor: 0.45 },
  { f: -0.78, s: 0.42, sink: 0.48, armor: 0.45 },
]

export const VEHICLES: Readonly<Record<VehicleKind, OutbreakVehicleSpec>> = {
  sedan: {
    kind: "sedan",
    label: "Sedan",
    length: 4.0,
    width: 1.84,
    mass: 1550,
    maxSpeed: 15.5,
    reverse: 5.8,
    accel: 8.4,
    brake: 16.5,
    turn: 2.35,
    grip: 9.2,
    hp: 500,
    maxFuel: 100,
    seats: FOUR_SEATS,
  },
  cruiser: {
    kind: "cruiser",
    label: "Police Cruiser",
    length: 4.2,
    width: 1.9,
    mass: 1750,
    maxSpeed: 17.8,
    reverse: 6.5,
    accel: 9.8,
    brake: 18.0,
    turn: 2.5,
    grip: 9.8,
    hp: 650,
    maxFuel: 100,
    seats: FOUR_SEATS,
  },
  pickup: {
    kind: "pickup",
    label: "4x4 Pickup",
    length: 4.1,
    width: 1.92,
    mass: 1950,
    maxSpeed: 14.8,
    reverse: 5.5,
    accel: 7.8,
    brake: 15.5,
    turn: 2.2,
    grip: 8.8,
    hp: 700,
    maxFuel: 110,
    seats: [
      { f: 0.2, s: -0.44, sink: 0.46, armor: 0.35 },
      { f: 0.2, s: 0.44, sink: 0.46, armor: 0.45 },
      { f: -0.95, s: -0.42, sink: 0.32, armor: 0.6 },
      { f: -0.95, s: 0.42, sink: 0.32, armor: 0.6 },
    ],
  },
  van: {
    kind: "van",
    label: "Utility Van",
    length: 4.7,
    width: 2.02,
    mass: 2450,
    maxSpeed: 12.8,
    reverse: 5.0,
    accel: 6.2,
    brake: 14.0,
    turn: 1.9,
    grip: 8.4,
    hp: 850,
    maxFuel: 120,
    seats: [
      { f: 0.85, s: -0.46, sink: 0.52, armor: 0.3 },
      { f: 0.85, s: 0.46, sink: 0.52, armor: 0.35 },
      { f: -0.65, s: -0.46, sink: 0.52, armor: 0.35 },
      { f: -0.65, s: 0.46, sink: 0.52, armor: 0.35 },
    ],
  },
}

export const VEHICLE_KINDS: readonly VehicleKind[] = ["sedan", "cruiser", "pickup", "van"]

export type VehicleTuning = {
  maxSpeedScale: number
  accelScale: number
  gripScale: number
  fuelBurnRate: number
  engineNoise: number
  hornNoise: number
  roadkillSpeed: number
  ramDamage: number
  crashDamage: number
  headlightRange: number
  headlightPower: number
  cameraSpeedZoom: number
  vehicleSuspension: number
  vehicleSmoke: number
}

export const DEFAULT_VEHICLE_TUNING: VehicleTuning = {
  maxSpeedScale: 1.0,
  accelScale: 1.0,
  gripScale: 1.0,
  fuelBurnRate: 1.0,
  engineNoise: 26,
  hornNoise: 42,
  roadkillSpeed: 5.5,
  ramDamage: 1.0,
  crashDamage: 1.0,
  headlightRange: 22,
  headlightPower: 1.35,
  cameraSpeedZoom: 11,
  vehicleSuspension: 1,
  vehicleSmoke: 1,
}

export const vehicleControls = [
  { key: "maxSpeedScale", label: "Top speed", group: "Vehicle", min: 0.5, max: 2.0, step: 0.05, unit: "×" },
  { key: "accelScale", label: "Acceleration", group: "Vehicle", min: 0.5, max: 2.5, step: 0.05, unit: "×" },
  { key: "gripScale", label: "Tyre grip", group: "Vehicle", min: 0.4, max: 2.0, step: 0.05, unit: "×" },
  { key: "fuelBurnRate", label: "Fuel burn rate", group: "Vehicle", min: 0, max: 3.0, step: 0.1, unit: "×" },
  { key: "engineNoise", label: "Engine noise radius", group: "Vehicle", min: 6, max: 50, step: 1, unit: "m" },
  { key: "hornNoise", label: "Horn noise radius", group: "Vehicle", min: 12, max: 80, step: 2, unit: "m" },
  { key: "roadkillSpeed", label: "Roadkill speed", group: "Vehicle", min: 2.0, max: 14.0, step: 0.5, unit: "m/s" },
  { key: "ramDamage", label: "Zombie impact damage", group: "Vehicle", min: 0.2, max: 3.0, step: 0.1, unit: "×" },
  { key: "crashDamage", label: "Wall crash damage", group: "Vehicle", min: 0, max: 3.0, step: 0.1, unit: "×" },
  { key: "headlightRange", label: "Headlight range", group: "Vehicle", min: 8, max: 36, step: 1, unit: "m" },
  { key: "headlightPower", label: "Headlight intensity", group: "Vehicle", min: 0.2, max: 3.0, step: 0.05, unit: "×" },
  { key: "cameraSpeedZoom", label: "Camera pullback at speed", group: "Vehicle", min: 0, max: 22, step: 1, unit: "m" },
  {
    key: "vehicleSuspension",
    label: "Chassis suspension",
    group: "Vehicle",
    options: [
      { label: "On", value: 1 },
      { label: "Off", value: 0 },
    ],
  },
  {
    key: "vehicleSmoke",
    label: "Tyre smoke & skids",
    group: "Vehicle",
    options: [
      { label: "On", value: 1 },
      { label: "Off", value: 0 },
    ],
  },
] as const

export type Drive = { throttle: number; steer: number; handbrake: boolean }
export const PARKED: Drive = { throttle: 0, steer: 0, handbrake: true }

export type VehicleSpawnSpec = {
  id: number
  kind: VehicleKind
  originChunkKey: string
  x: number
  y: number
  h: number
  fuel: number
  hasBattery: boolean
  hasKeys: boolean
  headlights: boolean
}

export type OutbreakVehicle = RigidXY & {
  id: number
  kind: VehicleKind
  spec: OutbreakVehicleSpec
  originChunkKey: string
  spawnX: number
  spawnY: number
  spawnH: number
  hp: number
  maxHp: number
  fuel: number
  maxFuel: number
  hasBattery: boolean
  hasKeys: boolean
  headlights: boolean
  engineOn: boolean
  wreck: boolean
  /** Survivor IDs by seat (0 = driver, 1..3 = passengers); "" for empty. */
  seats: string[]
  drive: Drive
  horn: boolean
  lastDriver: string
  zombieHits: number
  zombieKills: number
  grabbingZombies: number
  bangCount: number
  lastBangAt: number
  lastCrashAt: number
  lastCrashImpact: number
  lastSputterAt: number
  modified: boolean
}

export type VehicleZombieHitEvent = {
  vehicleId: number
  zombieId: number
  x: number
  y: number
  dirX: number
  dirY: number
  speed: number
  damage: number
  killed: boolean
  time: number
}

export const VEH_REACH = 1.65
export const VEH_ENTER_SPEED = 4.5
export const VEH_CRASH_SPEED = 6.5
export const VEH_CRASH_DAMAGE = 8.0
const PLAYER_RADIUS = 0.3
const ZOMBIE_RADIUS = 0.28

export function driveFromCommand(c: { mx: number; my: number; jump?: boolean; sprint?: boolean }): Drive {
  return {
    throttle: Math.max(-1, Math.min(1, -c.my)),
    steer: Math.max(-1, Math.min(1, c.mx)),
    handbrake: Boolean(c.jump || c.sprint),
  }
}

export function halfOf(spec: OutbreakVehicleSpec): [number, number] {
  return [spec.length * 0.48, spec.width * 0.48]
}

const masses = new Map<OutbreakVehicleSpec, Mass>()
export function massOf(spec: OutbreakVehicleSpec): Mass {
  let m = masses.get(spec)
  if (!m) masses.set(spec, (m = boxMass(spec.mass, spec.length, spec.width)))
  return m
}

export const speedOf = (b: { vx: number; vy: number }) => Math.hypot(b.vx, b.vy)
export const forwardSpeed = (b: { h: number; vx: number; vy: number }) => b.vx * Math.cos(b.h) + b.vy * Math.sin(b.h)
export const lateralSpeed = (b: { h: number; vx: number; vy: number }) => -b.vx * Math.sin(b.h) + b.vy * Math.cos(b.h)

export function localToWorld(b: { x: number; y: number; h: number }, f: number, s: number): { x: number; y: number } {
  const c = Math.cos(b.h)
  const n = Math.sin(b.h)
  return { x: b.x + c * f - n * s, y: b.y + n * f + c * s }
}

export function seatPos(
  b: { x: number; y: number; h: number },
  spec: OutbreakVehicleSpec,
  seat: number,
): { x: number; y: number } {
  const s = spec.seats[seat] ?? spec.seats[0]!
  return localToWorld(b, s.f, s.s)
}

export type Box = { x: number; y: number; h: number; hl: number; hw: number }

export function boxOf(b: { x: number; y: number; h: number }, spec: OutbreakVehicleSpec): Box {
  const [hl, hw] = halfOf(spec)
  return { x: b.x, y: b.y, h: b.h, hl, hw }
}

/** Axis-aligned bounding rect of an oriented vehicle box. */
export function aabbOf(b: { x: number; y: number; h: number }, spec: OutbreakVehicleSpec): Rect {
  const [hl, hw] = halfOf(spec)
  const c = Math.abs(Math.cos(b.h))
  const s = Math.abs(Math.sin(b.h))
  const ex = hl * c + hw * s
  const ey = hl * s + hw * c
  return [b.x - ex, b.y - ey, b.x + ex, b.y + ey]
}

export function distToBox(x: number, y: number, k: Box): number {
  const c = Math.cos(k.h)
  const s = Math.sin(k.h)
  const dx = x - k.x
  const dy = y - k.y
  const f = dx * c + dy * s
  const r = -dx * s + dy * c
  return Math.hypot(Math.max(0, Math.abs(f) - k.hl), Math.max(0, Math.abs(r) - k.hw))
}

export function pushOutBox(p: { x: number; y: number }, radius: number, k: Box): boolean {
  const c = Math.cos(k.h)
  const s = Math.sin(k.h)
  const dx = p.x - k.x
  const dy = p.y - k.y
  let f = dx * c + dy * s
  let r = -dx * s + dy * c
  if (Math.abs(f) >= k.hl + radius || Math.abs(r) >= k.hw + radius) return false
  const cf = Math.max(-k.hl, Math.min(k.hl, f))
  const cr = Math.max(-k.hw, Math.min(k.hw, r))
  const ef = f - cf
  const er = r - cr
  const d2 = ef * ef + er * er
  if (d2 >= radius * radius) return false
  if (d2 > 1e-12) {
    const d = Math.sqrt(d2)
    f = cf + (ef / d) * radius
    r = cr + (er / d) * radius
  } else if (k.hl - Math.abs(f) < k.hw - Math.abs(r)) f = Math.sign(f || 1) * (k.hl + radius)
  else r = Math.sign(r || 1) * (k.hw + radius)
  p.x = k.x + f * c - r * s
  p.y = k.y + f * s + r * c
  return true
}

export function rayBox(ox: number, oy: number, dx: number, dy: number, k: Box, maxT: number): [number, number] | null {
  const c = Math.cos(k.h)
  const s = Math.sin(k.h)
  const px = ox - k.x
  const py = oy - k.y
  const lo = [px * c + py * s, -px * s + py * c]
  const ld = [dx * c + dy * s, -dx * s + dy * c]
  const ext = [k.hl, k.hw]
  let t0 = 0
  let t1 = maxT
  for (let i = 0; i < 2; i++) {
    if (Math.abs(ld[i]!) < 1e-9) {
      if (Math.abs(lo[i]!) > ext[i]!) return null
      continue
    }
    let a = (-ext[i]! - lo[i]!) / ld[i]!
    let b = (ext[i]! - lo[i]!) / ld[i]!
    if (a > b) [a, b] = [b, a]
    t0 = Math.max(t0, a)
    t1 = Math.min(t1, b)
    if (t0 > t1) return null
  }
  return [t0, t1]
}

export function stepCar(
  b: RigidXY,
  d: Drive,
  spec: OutbreakVehicleSpec,
  dt: number,
  tuning: Pick<VehicleTuning, "maxSpeedScale" | "accelScale" | "gripScale"> = DEFAULT_VEHICLE_TUNING,
): void {
  const maxSpeed = spec.maxSpeed * tuning.maxSpeedScale
  const reverse = spec.reverse * tuning.maxSpeedScale
  const accel = spec.accel * tuning.accelScale
  const grip = spec.grip * tuning.gripScale

  let fx = Math.cos(b.h)
  let fy = Math.sin(b.h)
  let vf = b.vx * fx + b.vy * fy
  const absVf = Math.abs(vf)
  const dir = vf >= -0.5 ? 1 : -1
  const slide = d.handbrake && absVf > 4
  const speedFactor = Math.min(1, absVf / 4) * (1 - 0.35 * Math.min(1, absVf / maxSpeed))
  const target = d.steer * spec.turn * speedFactor * dir * (slide ? 1.35 : 1)
  const rate = d.steer === 0 ? (slide ? 2.5 : 6) : 10
  b.w += (target - b.w) * Math.min(1, dt * rate)
  b.h += b.w * dt
  if (b.h > Math.PI) b.h -= Math.PI * 2
  else if (b.h < -Math.PI) b.h += Math.PI * 2
  fx = Math.cos(b.h)
  fy = Math.sin(b.h)
  const rx = -fy
  const ry = fx
  vf = b.vx * fx + b.vy * fy
  let vl = b.vx * rx + b.vy * ry
  let a = 0
  if (d.throttle > 0) {
    const x = Math.max(0, vf) / maxSpeed
    a += accel * d.throttle * Math.max(0, 1 - x * x) * (vf < 0 ? 1.8 : 1)
  } else if (d.throttle < 0) {
    if (vf > 0.5) a -= spec.brake * -d.throttle
    else a += accel * 0.7 * d.throttle * Math.max(0, 1 + vf / reverse)
  }
  a -= d.throttle !== 0 ? 0.03 * vf : Math.sign(vf) * Math.min(Math.abs(vf) * 4, 0.8 + 0.05 * Math.abs(vf))
  if (d.handbrake) {
    const stop = Math.min(Math.abs(vf) / dt, slide ? 9.5 : 15)
    a -= Math.sign(vf) * stop
  }
  let gripMul = slide ? 0.16 : 1
  if (absVf < 1.5) gripMul *= 2
  vl *= Math.exp(-grip * gripMul * dt)
  vf += a * dt
  if (Math.abs(vf) < 0.05 && Math.abs(vl) < 0.05 && d.throttle === 0) {
    vf = 0
    vl = 0
    b.w *= 0.5
  }
  b.vx = fx * vf + rx * vl
  b.vy = fy * vf + ry * vl
  b.x += b.vx * dt
  b.y += b.vy * dt
}

const WALL_SLOP = 0.002
const CAR_SLOP = 0.01
const nearScratch: number[] = []
const gridCache = new WeakMap<readonly Rect[], RectGrid>()

function gridOf(rects: readonly Rect[]): RectGrid | null {
  if (rects.length < 16) return null
  let g = gridCache.get(rects)
  if (!g) {
    g = new RectGrid(rects)
    gridCache.set(rects, g)
  }
  return g
}

const flip = (c: ContactXY): ContactXY => ({ ...c, nx: -c.nx, ny: -c.ny })

export function collideWalls(b: RigidXY, spec: OutbreakVehicleSpec, rects: readonly Rect[]): number {
  const [hl, hw] = halfOf(spec)
  const r = Math.hypot(hl, hw)
  const mass = massOf(spec)
  const grid = gridOf(rects)
  const list = grid ? grid.query(b.x - r, b.y - r, b.x + r, b.y + r, nearScratch) : null
  const n = list ? list.length : rects.length
  let impact = 0
  for (let k = 0; k < n; k++) {
    const rc = rects[list ? list[k]! : k]!
    if (b.x < rc[0] - r || b.x > rc[2] + r || b.y < rc[1] - r || b.y > rc[3] + r) continue
    const c = collideShapesXY(rectShapeXY(rc), orientedShapeXY(b.x, b.y, b.h, hl, hw))
    if (!c) continue
    const f = flip(c)
    const hit = resolveXY(b, mass, null, STATIC, f, WALL)
    separateXY(b, mass, null, STATIC, f, WALL_SLOP)
    impact = Math.max(impact, hit.impact)
  }
  return impact
}

function substeps(
  b: RigidXY,
  spec: OutbreakVehicleSpec,
  dt: number,
  tuning: Pick<VehicleTuning, "accelScale"> = DEFAULT_VEHICLE_TUNING,
): number {
  const [hl, hw] = halfOf(spec)
  const travel = (speedOf(b) + spec.accel * tuning.accelScale * dt + Math.abs(b.w) * hl) * dt
  return Math.max(1, Math.min(12, Math.ceil(travel / (Math.min(hl, hw) * 0.5))))
}

export function driveStep(
  b: RigidXY,
  d: Drive,
  spec: OutbreakVehicleSpec,
  dt: number,
  solids: readonly Rect[],
  tuning: Pick<VehicleTuning, "maxSpeedScale" | "accelScale" | "gripScale"> = DEFAULT_VEHICLE_TUNING,
): number {
  const n = substeps(b, spec, dt, tuning)
  let impact = 0
  for (let i = 0; i < n; i++) {
    stepCar(b, d, spec, dt / n, tuning)
    impact = Math.max(impact, collideWalls(b, spec, solids))
  }
  return impact
}

export function collideCars(
  a: RigidXY,
  sa: OutbreakVehicleSpec,
  b: RigidXY,
  sb: OutbreakVehicleSpec,
  dt: number,
  fixedA = false,
  fixedB = false,
): number {
  if (fixedA && fixedB) return 0
  const [la, wa] = halfOf(sa)
  const [lb, wb] = halfOf(sb)
  const reach = Math.hypot(la, wa) + Math.hypot(lb, wb)
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (dx * dx + dy * dy >= reach * reach) return 0
  const c = collideShapesXY(orientedShapeXY(a.x, a.y, a.h, la, wa), orientedShapeXY(b.x, b.y, b.h, lb, wb))
  if (!c) return 0
  const ma = fixedA ? STATIC : massOf(sa)
  const mb = fixedB ? STATIC : massOf(sb)
  const closing = (a.vx - b.vx) * c.nx + (a.vy - b.vy) * c.ny
  const back = closing > 0.5 ? Math.min(dt, c.depth / closing) : 0
  const a0 = { vx: a.vx, vy: a.vy, w: a.w }
  const b0 = { vx: b.vx, vy: b.vy, w: b.w }
  const hit = fixedA ? resolveXY(b, mb, null, STATIC, flip(c), CARS) : resolveXY(a, ma, fixedB ? null : b, mb, c, CARS)
  for (const [body, v0, fixed] of [
    [a, a0, fixedA],
    [b, b0, fixedB],
  ] as const) {
    if (fixed) continue
    body.x += (body.vx - v0.vx) * back
    body.y += (body.vy - v0.vy) * back
    body.h += (body.w - v0.w) * back
  }
  const left = collideShapesXY(orientedShapeXY(a.x, a.y, a.h, la, wa), orientedShapeXY(b.x, b.y, b.h, lb, wb))
  if (left) {
    if (fixedA) separateXY(b, mb, null, STATIC, flip(left), CAR_SLOP)
    else separateXY(a, ma, fixedB ? null : b, mb, left, CAR_SLOP)
  }
  return hit.impact
}

/** Deterministic integer ID base for vehicles in chunk `(cx, cy)` so IDs never collide across chunks. */
export function chunkVehicleIdBase(cx: number, cy: number): number {
  if (cx >= 0 && cx < 3 && cy >= 0 && cy < 3) {
    return 1 + (cy * 3 + cx) * 4
  }
  const hx = (cx + 512) & 1023
  const hy = (cy + 512) & 1023
  return 100 + (((hx * 53 + hy * 131) % 7000) * 4)
}

/**
 * Deterministically generates parked vehicle spawns for chunk `(cx, cy)`.
 * In the origin 3×3 block (`0..2, 0..2`), places:
 * - Vehicle 1 (`sedan` at `22.8, 41.2`, chunk `0,1`): right near spawn `(27.7, 41)` — ready to start (with The Way
 *   Out's car project on, `spawnRule` takes its keys and drains its tank like every other car's).
 * - Vehicle 2 (`pickup` at `50.6, 30.5`, chunk `1,0`): Hardware Store lot — needs a Car Battery.
 * - Vehicle 3 (`cruiser` at `62.0, 51.2`, chunk `1,1`): Pharmacy street curb — needs Keys.
 * - Vehicle 4 (`van` at `34.5, 51.2`, chunk `0,2`): Elm House street curb — needs Fuel.
 * In procedural chunks outside `(0,0)`, places parked vehicles at driveways, gas stations, police stations,
 * warehouses, cabins, and outer street curbs (keeping the center driving lane `y = 44` / `locZ = 12` clear).
 */
export function generateChunkVehicleSpawns(
  seed: number,
  houseSeed: number,
  cx: number,
  cy: number,
  mode: WorldMode = "streaming",
  buildings: readonly Building[] = [],
  staticVehicles: readonly Rect[] = [],
): VehicleSpawnSpec[] {
  const cKey = chunkKey(cx, cy)
  if (mode !== "procedural" && cx >= 0 && cx < 3 && cy >= 0 && cy < 3) {
    if (cx === 0 && cy === 1) {
      return [
        {
          id: 1,
          kind: "sedan",
          originChunkKey: cKey,
          x: 22.8,
          y: 41.2,
          h: 0,
          fuel: 80,
          hasBattery: true,
          hasKeys: true,
          headlights: true,
        },
      ]
    }
    if (cx === 1 && cy === 0) {
      return [
        {
          id: 2,
          kind: "pickup",
          originChunkKey: cKey,
          x: 50.6,
          y: 30.5,
          h: Math.PI / 2,
          fuel: 85,
          hasBattery: false,
          hasKeys: true,
          headlights: true,
        },
      ]
    }
    if (cx === 1 && cy === 1) {
      return [
        {
          id: 3,
          kind: "cruiser",
          originChunkKey: cKey,
          x: 62.0,
          y: 51.2,
          h: Math.PI,
          fuel: 72,
          hasBattery: true,
          hasKeys: false,
          headlights: true,
        },
      ]
    }
    if (cx === 0 && cy === 2) {
      return [
        {
          id: 4,
          kind: "van",
          originChunkKey: cKey,
          x: 28.5,
          y: 68.5,
          h: 0,
          fuel: 0,
          hasBattery: true,
          hasKeys: true,
          headlights: true,
        },
      ]
    }
    return []
  }

  const bx = Math.floor(cx / MACRO_CHUNKS)
  const by = Math.floor(cy / MACRO_CHUNKS)
  const lx = ((cx % MACRO_CHUNKS) + MACRO_CHUNKS) % MACRO_CHUNKS
  const ly = ((cy % MACRO_CHUNKS) + MACRO_CHUNKS) % MACRO_CHUNKS
  // Never place parked vehicles inside the center 4-way intersection chunk (1, 1)
  if (lx === 1 && ly === 1) return []

  const district = districtAtBlock(seed, bx, by)
  const vSeed = (seed ^ Math.imul(cx + 4096, 0x45d9f3b) ^ Math.imul(cy + 4096, 0x119de1f3) ^ (houseSeed * 31)) >>> 0
  const rng = new Rng(vSeed)
  const baseId = chunkVehicleIdBase(cx, cy)
  const x0 = cx * CHUNK
  const z0 = cy * CHUNK
  const bld = buildings[0]
  const arch = bld?.archetype ?? bld?.kind
  const out: VehicleSpawnSpec[] = []

  const overlapsStatic = (x: number, y: number): boolean => {
    for (const r of staticVehicles) {
      if (distToRect(x, y, r) < 2.6) return true
    }
    for (const b of buildings) {
      if (distToRect(x, y, b.rect) < 1.2) return true
    }
    return false
  }

  const pickCondition = (preferReady = false): { fuel: number; hasBattery: boolean; hasKeys: boolean } => {
    const r = rng.next()
    if (preferReady ? r < 0.45 : r < 0.25) {
      return { fuel: Math.round(45 + rng.next() * 45), hasBattery: true, hasKeys: true }
    }
    if (r < 0.5) {
      return { fuel: 0, hasBattery: true, hasKeys: true }
    }
    if (r < 0.75) {
      return { fuel: Math.round(50 + rng.next() * 40), hasBattery: false, hasKeys: true }
    }
    return { fuel: Math.round(40 + rng.next() * 45), hasBattery: true, hasKeys: false }
  }

  if (arch === "gas_station" && bld) {
    // Forecourt vehicle parked by the gas station island
    const vx = (bld.rect[0] + bld.rect[2]) * 0.5
    const vy = Math.min(z0 + CHUNK - 3.2, bld.rect[3] + 3.4)
    if (!overlapsStatic(vx, vy)) {
      const cond = pickCondition(true)
      out.push({
        id: baseId,
        kind: rng.pick(["sedan", "pickup", "van"] as const),
        originChunkKey: cKey,
        x: Number(vx.toFixed(2)),
        y: Number(vy.toFixed(2)),
        h: 0,
        ...cond,
        headlights: true,
      })
    }
  } else if (arch === "police" && bld) {
    // Police Cruiser parked outside the police station
    const vx = Math.max(x0 + 3.2, bld.rect[0] - 1.8)
    const vy = (bld.rect[1] + bld.rect[3]) * 0.5
    if (!overlapsStatic(vx, vy)) {
      const cond = pickCondition(true)
      out.push({
        id: baseId,
        kind: "cruiser",
        originChunkKey: cKey,
        x: Number(vx.toFixed(2)),
        y: Number(vy.toFixed(2)),
        h: -Math.PI / 2,
        ...cond,
        headlights: true,
      })
    }
  } else if ((arch === "house" || arch === "ranch" || arch === "cottage" || arch === "cabin") && bld && rng.next() < 0.65) {
    // Driveway vehicle beside house
    const vx = bld.rect[0] - 1.75
    const vy = bld.rect[3] - 2.0
    if (vx > x0 + 2.0 && !overlapsStatic(vx, vy)) {
      const cond = pickCondition(false)
      out.push({
        id: baseId,
        kind: arch === "cabin" || arch === "ranch" ? rng.pick(["pickup", "sedan"] as const) : "sedan",
        originChunkKey: cKey,
        x: Number(vx.toFixed(2)),
        y: Number(vy.toFixed(2)),
        h: -Math.PI / 2,
        ...cond,
        headlights: true,
      })
    }
  } else if ((arch === "warehouse" || arch === "hardware" || arch === "clinic" || arch === "diner" || arch === "grocery") && bld && rng.next() < 0.6) {
    const vx = bld.rect[0] - 1.8
    const vy = bld.rect[3] - 2.2
    if (vx > x0 + 2.0 && !overlapsStatic(vx, vy)) {
      const cond = pickCondition(false)
      const kind: VehicleKind =
        arch === "warehouse" ? "van" : arch === "hardware" ? "pickup" : arch === "clinic" ? "van" : "sedan"
      out.push({
        id: baseId,
        kind,
        originChunkKey: cKey,
        x: Number(vx.toFixed(2)),
        y: Number(vy.toFixed(2)),
        h: -Math.PI / 2,
        ...cond,
        headlights: true,
      })
    }
  } else if ((lx === 1 || ly === 1) && rng.next() < 0.42) {
    // Curbside street vehicle (strictly outside the center driving lane locZ = 12 / locX = 12)
    if (ly === 1 && lx !== 1) {
      const vx = x0 + 10 + rng.next() * 12
      const northSide = rng.next() < 0.5
      const vy = z0 + (northSide ? 8.85 : 15.15)
      if (!overlapsStatic(vx, vy)) {
        const cond = pickCondition(false)
        const kind = district === "civic" ? "cruiser" : district === "industrial" ? "pickup" : "sedan"
        out.push({
          id: baseId,
          kind,
          originChunkKey: cKey,
          x: Number(vx.toFixed(2)),
          y: Number(vy.toFixed(2)),
          h: northSide ? 0 : Math.PI,
          ...cond,
          headlights: true,
        })
      }
    } else if (lx === 1 && ly !== 1) {
      const westSide = rng.next() < 0.5
      const vx = x0 + (westSide ? 8.85 : 15.15)
      const vy = z0 + 10 + rng.next() * 12
      if (!overlapsStatic(vx, vy)) {
        const cond = pickCondition(false)
        out.push({
          id: baseId,
          kind: rng.pick(["sedan", "pickup"] as const),
          originChunkKey: cKey,
          x: Number(vx.toFixed(2)),
          y: Number(vy.toFixed(2)),
          h: westSide ? Math.PI / 2 : -Math.PI / 2,
          ...cond,
          headlights: true,
        })
      }
    }
  }

  return out
}

export function createVehicleFromSpawn(spawn: VehicleSpawnSpec): OutbreakVehicle {
  const spec = VEHICLES[spawn.kind]
  return {
    id: spawn.id,
    kind: spawn.kind,
    spec,
    originChunkKey: spawn.originChunkKey,
    spawnX: spawn.x,
    spawnY: spawn.y,
    spawnH: spawn.h,
    x: spawn.x,
    y: spawn.y,
    h: spawn.h,
    vx: 0,
    vy: 0,
    w: 0,
    hp: spec.hp,
    maxHp: spec.hp,
    fuel: spawn.fuel,
    maxFuel: spec.maxFuel,
    hasBattery: spawn.hasBattery,
    hasKeys: spawn.hasKeys,
    headlights: spawn.headlights,
    engineOn: false,
    wreck: false,
    seats: spec.seats.map(() => ""),
    drive: { ...PARKED },
    horn: false,
    lastDriver: "",
    zombieHits: 0,
    zombieKills: 0,
    grabbingZombies: 0,
    bangCount: 0,
    lastBangAt: -Infinity,
    lastCrashAt: -Infinity,
    lastCrashImpact: 0,
    lastSputterAt: -Infinity,
    modified: false,
  }
}

export function createVehicleFromSaved(saved: SavedVehicleState): OutbreakVehicle {
  const spec = VEHICLES[saved.kind]
  return {
    id: saved.id,
    kind: saved.kind,
    spec,
    originChunkKey: saved.originChunkKey,
    spawnX: saved.spawnX,
    spawnY: saved.spawnY,
    spawnH: saved.spawnH,
    x: saved.x,
    y: saved.y,
    h: saved.h,
    vx: 0,
    vy: 0,
    w: 0,
    hp: saved.hp,
    maxHp: spec.hp,
    fuel: saved.fuel,
    maxFuel: spec.maxFuel,
    hasBattery: saved.hasBattery,
    hasKeys: saved.hasKeys,
    headlights: saved.headlights,
    engineOn: false,
    wreck: saved.wreck,
    seats: spec.seats.map(() => ""),
    drive: { ...PARKED },
    horn: false,
    lastDriver: "",
    zombieHits: 0,
    zombieKills: 0,
    grabbingZombies: 0,
    bangCount: 0,
    lastBangAt: -Infinity,
    lastCrashAt: -Infinity,
    lastCrashImpact: 0,
    lastSputterAt: -Infinity,
    modified: true,
  }
}

export function toSavedVehicleState(v: OutbreakVehicle): SavedVehicleState {
  return {
    id: v.id,
    kind: v.kind,
    originChunkKey: v.originChunkKey,
    spawnX: v.spawnX,
    spawnY: v.spawnY,
    spawnH: v.spawnH,
    x: Number(v.x.toFixed(2)),
    y: Number(v.y.toFixed(2)),
    h: Number(v.h.toFixed(4)),
    hp: Math.round(v.hp),
    fuel: Number(v.fuel.toFixed(2)),
    hasBattery: v.hasBattery,
    hasKeys: v.hasKeys,
    headlights: v.headlights,
    wreck: v.wreck,
  }
}

export function isVehicleModifiedFromSpawn(v: OutbreakVehicle): boolean {
  if (v.modified || v.wreck || v.hp < v.maxHp) return true
  if (Math.hypot(v.x - v.spawnX, v.y - v.spawnY) > 0.08) return true
  if (Math.abs(angleDiff(v.h, v.spawnH)) > 0.05) return true
  return false
}

export type VehicleRiderActor = InteractActorState & {
  x: number
  y: number
  vx: number
  vy: number
  aim: number
  health: number
  maxHealth: number
  vehicleId?: number | null
  seatIndex?: number
  lootMessage: string | null
  lootMessageUntil: number
}

export type VehicleRiderSlot = ProgressionSlot & {
  survivor: VehicleRiderActor
}

function closing(v: OutbreakVehicle, q: { x: number; y: number }): boolean {
  const s = speedOf(v)
  if (s < 1e-6) return false
  return Math.abs(angleDiff(Math.atan2(q.y - v.y, q.x - v.x), Math.atan2(v.vy, v.vx))) < 1.4
}

function overlapsRects(x: number, y: number, r: number, rects: readonly Rect[]): boolean {
  for (let i = 0; i < rects.length; i++) {
    if (distToRect(x, y, rects[i]!) < r) return true
  }
  return false
}

export type OutbreakVehicleSnapshot = {
  tuning: VehicleTuning
  nextCustomId: number
  lastEngineNoiseAt: [number, number][]
  lastHornNoiseAt: [number, number][]
  list: OutbreakVehicle[]
  recentHits: VehicleZombieHitEvent[]
}

/**
 * How a tank is filled. Chem by default; The Way Out's car project (`shared/way-out/`) makes it gas cans only, poured
 * into any tank with room, with the gas station pumps dry.
 */
export type VehicleRefuelRule = {
  /** Belt item poured in, how many make one fill, and the fuel one fill adds (tank units). */
  item: string
  count: number
  fill: number
  /** Pour into a tank with room for a whole fill (false: only into an empty tank, and the fill sets the level). */
  topUp: boolean
  /** Gas station pumps fill the tank for free. */
  pumps: boolean
  /** How the warnings name it. */
  name: string
}

export const CHEM_REFUEL: VehicleRefuelRule = { item: "chem", count: 2, fill: 55, topUp: false, pumps: true, name: "Chem" }

const canPour = (v: Pick<OutbreakVehicle, "fuel" | "maxFuel">, r: VehicleRefuelRule) => (r.topUp ? v.fuel + r.fill <= v.maxFuel + 0.01 : v.fuel <= 0.01)
const refuelHint = (r: VehicleRefuelRule) => (r.pumps ? `refuel with ${r.name} or at a Gas Station` : `pour in a ${r.name}`)

/**
 * Authoritative vehicle subsystem for Outbreak (`CoopSim`).
 * Manages vehicle spawning across streaming chunks, `ChunkDelta` persistence when a vehicle is left somewhere,
 * entering/exiting/seat-cycling, battery/key/fuel checks, OBB physics, engine/horn noise, zombie roadkill,
 * and zombie grabbing/banging.
 */
export class OutbreakVehicleSubsystem {
  readonly list: OutbreakVehicle[] = []
  readonly recentHits: VehicleZombieHitEvent[] = []
  tuning: VehicleTuning = { ...DEFAULT_VEHICLE_TUNING }
  private nextCustomId = 9000
  private lastEngineNoiseAt = new Map<number, number>()
  private lastHornNoiseAt = new Map<number, number>()
  private actorOf = new WeakMap<object, VehicleRiderSlot>()
  /** How tanks are filled; a feature may change it (The Way Out's car project). */
  refuelRule: () => VehicleRefuelRule = () => CHEM_REFUEL
  /** How a parked car spawns; a feature may change it (The Way Out's car project: no keys or battery, a dry tank). */
  spawnRule: (spawn: VehicleSpawnSpec) => VehicleSpawnSpec = (spawn) => spawn

  constructor(worldStream: StreamingWorld, town: Town, tuning?: Partial<VehicleTuning>) {
    if (tuning) Object.assign(this.tuning, tuning)
    this.syncChunks(worldStream, town)
  }

  snapshot(): OutbreakVehicleSnapshot {
    return {
      tuning: { ...this.tuning },
      nextCustomId: this.nextCustomId,
      lastEngineNoiseAt: [...this.lastEngineNoiseAt.entries()],
      lastHornNoiseAt: [...this.lastHornNoiseAt.entries()],
      list: this.list.map((v) => ({
        ...v,
        seats: [...v.seats],
        drive: { ...v.drive },
      })),
      recentHits: this.recentHits.map((h) => ({ ...h })),
    }
  }

  restore(snap: OutbreakVehicleSnapshot, slots: readonly VehicleRiderSlot[] = []): void {
    this.tuning = { ...snap.tuning }
    this.nextCustomId = snap.nextCustomId
    this.lastEngineNoiseAt.clear()
    for (const [k, v] of snap.lastEngineNoiseAt) this.lastEngineNoiseAt.set(k, v)
    this.lastHornNoiseAt.clear()
    for (const [k, v] of snap.lastHornNoiseAt) this.lastHornNoiseAt.set(k, v)
    this.list.length = 0
    for (const v of snap.list) {
      this.list.push({
        ...v,
        lastBangAt: v.lastBangAt ?? -Infinity,
        lastCrashAt: v.lastCrashAt ?? -Infinity,
        lastSputterAt: v.lastSputterAt ?? -Infinity,
        spec: VEHICLES[v.kind] ?? v.spec,
        seats: [...v.seats],
        drive: { ...v.drive },
      })
    }
    this.recentHits.length = 0
    for (const h of snap.recentHits) this.recentHits.push({ ...h })
    for (const slot of slots) this.bindActor(slot)
  }

  bindActor(slot: VehicleRiderSlot): void {
    this.actorOf.set(slot.survivor, slot)
  }

  byId(id: number | null | undefined): OutbreakVehicle | undefined {
    if (!id) return undefined
    return this.list.find((v) => v.id === id)
  }

  vehicleOf(p: { vehicleId?: number | null }): OutbreakVehicle | undefined {
    if (!p.vehicleId) return undefined
    const v = this.byId(p.vehicleId)
    return v && !v.wreck ? v : undefined
  }

  /** Synchronizes live vehicles with `worldStream.activeChunks`, saving modified/relocated vehicles into `ChunkDelta`s. */
  syncChunks(worldStream: StreamingWorld, _town: Town): void {
    // 1. Persist any modified or relocated vehicles into their current chunk's delta
    for (let i = this.list.length - 1; i >= 0; i--) {
      const v = this.list[i]!
      const curCoord = worldToChunk(v.x, v.y)
      const curKey = chunkKey(curCoord.cx, curCoord.cy)
      const movedChunk = curKey !== v.originChunkKey
      if (movedChunk || isVehicleModifiedFromSpawn(v)) {
        v.modified = true
        const curDelta = worldStream.ensureDelta(curCoord.cx, curCoord.cy)
        curDelta.visited = true
        curDelta.vehicles ??= {}
        curDelta.vehicles[v.id] = toSavedVehicleState(v)
        if (movedChunk) {
          const [ocx, ocy] = v.originChunkKey.split(",").map(Number)
          const origDelta = worldStream.ensureDelta(ocx!, ocy!)
          origDelta.visited = true
          origDelta.removedVehicles ??= {}
          origDelta.removedVehicles[v.id] = true
          if (origDelta.vehicles) delete origDelta.vehicles[v.id]
        }
      }
      // Clean up stale saved records in any other active chunks where this vehicle used to be parked
      for (const [k, delta] of worldStream.deltas) {
        if (k !== curKey && delta.vehicles && v.id in delta.vehicles) {
          delete delta.vehicles[v.id]
        }
      }
      // If the chunk containing this vehicle is no longer active and nobody is riding in it, unload the vehicle
      const occupied = v.seats.some(Boolean)
      if (!occupied && !worldStream.activeChunks.has(curKey)) {
        this.list.splice(i, 1)
      }
    }

    // 2. Materialize vehicles for all currently active chunks
    const activeIds = new Set(this.list.map((v) => v.id))
    for (const chunk of worldStream.activeChunks.values()) {
      const delta = worldStream.deltas.get(chunk.key)
      // Restore saved vehicles in this chunk
      if (delta?.vehicles) {
        for (const saved of Object.values(delta.vehicles)) {
          if (activeIds.has(saved.id)) continue
          this.list.push(createVehicleFromSaved(saved))
          activeIds.add(saved.id)
        }
      }
      // Materialize native spawns for this chunk unless removed or already active
      const spawns = generateChunkVehicleSpawns(
        worldStream.seed,
        worldStream.houseSeed,
        chunk.cx,
        chunk.cy,
        worldStream.mode,
        chunk.buildings,
        chunk.vehicles,
      )
      for (const sp of spawns) {
        if (activeIds.has(sp.id)) continue
        if (delta?.removedVehicles?.[sp.id]) continue
        this.list.push(createVehicleFromSpawn(this.spawnRule(sp)))
        activeIds.add(sp.id)
      }
    }
    this.list.sort((a, b) => a.id - b.id)
  }

  /** Re-reads `spawnRule` for every parked car nobody has touched (after the rule changed, or was installed). */
  respawnParked(worldStream: StreamingWorld): void {
    const native = new Map<number, VehicleSpawnSpec>()
    for (const chunk of worldStream.activeChunks.values()) {
      const spawns = generateChunkVehicleSpawns(worldStream.seed, worldStream.houseSeed, chunk.cx, chunk.cy, worldStream.mode, chunk.buildings, chunk.vehicles)
      for (const sp of spawns) native.set(sp.id, sp)
    }
    for (const v of this.list) {
      if (v.seats.some(Boolean) || isVehicleModifiedFromSpawn(v)) continue
      const sp = native.get(v.id)
      if (!sp) continue
      const ruled = this.spawnRule(sp)
      v.fuel = ruled.fuel
      v.hasBattery = ruled.hasBattery
      v.hasKeys = ruled.hasKeys
    }
  }

  /** Spawns a fresh vehicle at `(x, y, h)` (used by Lab actions and station staging). */
  spawnVehicle(
    kind: VehicleKind,
    x: number,
    y: number,
    h = 0,
    options?: Partial<Pick<OutbreakVehicle, "fuel" | "hasBattery" | "hasKeys" | "headlights" | "hp">>,
  ): OutbreakVehicle {
    const coord = worldToChunk(x, y)
    const cKey = chunkKey(coord.cx, coord.cy)
    const spec = VEHICLES[kind]
    const v = createVehicleFromSpawn({
      id: this.nextCustomId++,
      kind,
      originChunkKey: cKey,
      x,
      y,
      h,
      fuel: options?.fuel ?? spec.maxFuel,
      hasBattery: options?.hasBattery ?? true,
      hasKeys: options?.hasKeys ?? true,
      headlights: options?.headlights ?? true,
    })
    if (options?.hp !== undefined) v.hp = options.hp
    v.modified = true
    this.list.push(v)
    return v
  }

  /** Nearest enterable vehicle within `VEH_REACH` of `(x, y)`. */
  enterable(x: number, y: number): OutbreakVehicle | undefined {
    let best: OutbreakVehicle | undefined
    let bestDist = VEH_REACH
    for (const v of this.list) {
      if (v.wreck || speedOf(v) > VEH_ENTER_SPEED || !v.seats.includes("")) continue
      const d = distToBox(x, y, boxOf(v, v.spec))
      if (d <= bestDist) {
        bestDist = d
        best = v
      }
    }
    return best
  }

  /** Checks what items the actor has to satisfy a vehicle's missing battery, keys, or fuel. */
  canSupply(
    slotId: string,
    v: OutbreakVehicle,
    progression: OutbreakProgression,
  ): { canInstallBattery: boolean; canUnlockKey: boolean; canRefuel: boolean } {
    const l = progression.ledger
    const r = this.refuelRule()
    return {
      canInstallBattery: !v.hasBattery && l.count(slotId, "car-battery") > 0,
      canUnlockKey: !v.hasKeys && l.count(slotId, "key") > 0,
      canRefuel: canPour(v, r) && l.count(slotId, r.item) >= r.count,
    }
  }

  /** Consumes carried items (`car-battery`, `key`, the refuel item) to ready a vehicle if the survivor has them. */
  trySupplyVehicle(slot: VehicleRiderSlot, v: OutbreakVehicle, progression: OutbreakProgression): boolean {
    const l = progression.ledger
    let supplied = false
    if (!v.hasBattery && l.count(slot.id, "car-battery") > 0) {
      for (const storeSuffix of ["pack", "hotbar"] as const) {
        const st = l.store(`${slot.id}/${storeSuffix}`)
        if (st && l.count(st.id, "car-battery") > 0) {
          l.apply({ kind: "drain", store: st.id, item: "car-battery", count: 1 })
          v.hasBattery = true
          v.modified = true
          progression.notify(slot, "Installed car battery", "result", "vehicle")
          supplied = true
          break
        }
      }
    }
    if (!v.hasKeys && l.count(slot.id, "key") > 0) {
      const beltId = `${slot.id}/belt`
      if (l.count(beltId, "key") > 0) {
        l.apply({ kind: "drain", store: beltId, item: "key", count: 1 })
        v.hasKeys = true
        v.modified = true
        progression.notify(slot, "Unlocked ignition with key", "result", "vehicle")
        supplied = true
      }
    }
    const r = this.refuelRule()
    const beltId = `${slot.id}/belt`
    let poured = 0
    while (canPour(v, r) && l.count(slot.id, r.item) >= r.count && l.count(beltId, r.item) >= r.count) {
      l.apply({ kind: "drain", store: beltId, item: r.item, count: r.count })
      v.fuel = r.topUp ? Math.min(v.maxFuel, v.fuel + r.fill) : Math.min(v.maxFuel, r.fill)
      v.modified = true
      poured++
      if (!r.topUp) break
    }
    if (poured) {
      const text = r.topUp ? `Poured in ${poured} ${r.name}${poured > 1 ? "s" : ""} (${Math.round((v.fuel / v.maxFuel) * 100)}% fuel)` : `Refueled tank (+${r.fill}% fuel)`
      progression.notify(slot, text, "result", "vehicle")
      supplied = true
    }
    if (supplied) progression.project(slot)
    return supplied
  }

  /** Enters a vehicle (and automatically installs battery/key/fuel if carried). */
  enter(
    slot: VehicleRiderSlot,
    v: OutbreakVehicle,
    progression: OutbreakProgression,
    ai: OutbreakAISubsystem,
    time: number,
  ): boolean {
    if (v.wreck || speedOf(v) > VEH_ENTER_SPEED || !v.seats.includes("")) return false
    const p = slot.survivor
    if (p.vehicleId) return false

    this.trySupplyVehicle(slot, v, progression)

    // Driver seat (0) first if free, else nearest free passenger seat
    let seat = v.seats[0] === "" ? 0 : -1
    if (seat < 0) {
      let bd = Infinity
      v.seats.forEach((s, i) => {
        if (s) return
        const at = seatPos(v, v.spec, i)
        const d = Math.hypot(at.x - p.x, at.y - p.y)
        if (d < bd) {
          bd = d
          seat = i
        }
      })
    }
    if (seat < 0) return false

    progression.ledger.cancel(slot.id)
    v.seats[seat] = slot.id
    p.vehicleId = v.id
    p.seatIndex = seat
    p.vx = 0
    p.vy = 0
    p.peekingWindowId = null
    p.holdTargetId = null
    p.holdElapsed = 0
    p.holdTriggered = false
    p.holdPendingPrimary = null
    p.vault = null
    if (seat === 0) {
      v.lastDriver = slot.id
      v.engineOn = v.hasBattery && v.hasKeys && v.fuel > 0
      if (!v.hasBattery) {
        progression.notify(slot, "Dead battery — needs a Car Battery from the Hardware Store", "warning", "vehicle")
      } else if (!v.hasKeys) {
        progression.notify(slot, "No keys — search house dressers or nightstands for a Key", "warning", "vehicle")
      } else if (v.fuel <= 0) {
        progression.notify(slot, `Empty fuel tank — ${refuelHint(this.refuelRule())}`, "warning", "vehicle")
      }
    }
    this.sit(v, p, seat)
    ai.emitNoise(v.x, v.y, v.engineOn ? 12 : 5, "door", time, slot.id, 0.8)
    return true
  }

  /** Leaves seat without moving (when disconnecting or removed). */
  leaveSeat(slotId: string, p?: VehicleRiderActor): void {
    for (const v of this.list) {
      for (let i = 0; i < v.seats.length; i++) {
        if (v.seats[i] === slotId) {
          v.seats[i] = ""
          if (i === 0) {
            v.drive = { ...PARKED }
            v.horn = false
            v.engineOn = false
          }
        }
      }
    }
    if (p) {
      p.vehicleId = null
      p.seatIndex = 0
    }
  }

  /** Exits the vehicle to a clear spot beside the door (or opposite side, rear, or front). */
  exit(
    slot: VehicleRiderSlot,
    solids: readonly Rect[],
    ai: OutbreakAISubsystem,
    time: number,
  ): boolean {
    const p = slot.survivor
    const v = this.vehicleOf(p)
    if (!v) {
      this.leaveSeat(slot.id, p)
      return true
    }
    const spec = v.spec
    const seatIdx = p.seatIndex ?? 0
    const seat = spec.seats[seatIdx] ?? spec.seats[0]!
    const hl = spec.length / 2
    const hw = spec.width / 2
    const side = seat.s <= 0 ? -1 : 1
    const out = PLAYER_RADIUS + 0.32
    const spots = [
      [seat.f, side * (hw + out)],
      [seat.f, -side * (hw + out)],
      [-(hl + out), 0],
      [hl + out, 0],
      [seat.f, side * (hw + out + 0.85)],
      [seat.f, -side * (hw + out + 0.85)],
    ] as const
    for (const [f, s] of spots) {
      const at = localToWorld(v, f, s)
      if (overlapsRects(at.x, at.y, PLAYER_RADIUS, solids) || !clearLine(v.x, v.y, at.x, at.y, solids)) continue
      if (this.list.some((o) => o !== v && distToBox(at.x, at.y, boxOf(o, o.spec)) < PLAYER_RADIUS)) continue
      this.leaveSeat(slot.id, p)
      p.x = at.x
      p.y = at.y
      p.vx = v.vx * 0.25
      p.vy = v.vy * 0.25
      v.modified = true
      ai.emitNoise(at.x, at.y, 5.5, "door", time, slot.id, 0.6)
      return true
    }
    // Fallback if completely boxed in: step out at the first side spot and push out of solids
    const fallback = localToWorld(v, seat.f, side * (hw + out))
    this.leaveSeat(slot.id, p)
    p.x = fallback.x
    p.y = fallback.y
    v.modified = true
    return true
  }

  /** C: cycles to the next free seat (0..3) in the vehicle. */
  cycleSeat(slot: VehicleRiderSlot, progression?: OutbreakProgression): boolean {
    const p = slot.survivor
    const v = this.vehicleOf(p)
    if (!v || v.wreck) return false
    const cur = p.seatIndex ?? 0
    const n = v.seats.length
    for (let k = 1; k < n; k++) {
      const next = (cur + k) % n
      if (v.seats[next]) continue
      v.seats[cur] = ""
      v.seats[next] = slot.id
      p.seatIndex = next
      if (cur === 0) {
        v.drive = { ...PARKED }
        v.horn = false
        v.engineOn = false
      }
      if (next === 0) {
        if (progression) this.trySupplyVehicle(slot, v, progression)
        v.lastDriver = slot.id
        v.engineOn = v.hasBattery && v.hasKeys && v.fuel > 0
      }
      this.sit(v, p, next)
      return true
    }
    return false
  }

  sit(v: OutbreakVehicle, p: { x: number; y: number; vx: number; vy: number }, seat: number): void {
    const at = seatPos(v, v.spec, seat)
    p.x = at.x
    p.y = at.y
    p.vx = v.vx
    p.vy = v.vy
  }

  /** Interaction handler registered in `CoopSim.registry` so world-space prompts appear over nearby vehicles. */
  handler(
    progression: OutbreakProgression,
    ai: OutbreakAISubsystem,
    getTime: () => number,
  ): InteractionHandler {
    return {
      kind: "vehicle",
      candidates: (_town, actor) => {
        const p = actor as VehicleRiderActor
        if (p.vehicleId || p.peekingWindowId) return []
        const slot = this.actorOf.get(actor)
        const out: RawInteractCandidate[] = []
        for (const v of this.list) {
          if (v.wreck || speedOf(v) > VEH_ENTER_SPEED || !v.seats.includes("")) continue
          const box = boxOf(v, v.spec)
          const d = distToBox(actor.x, actor.y, box)
          if (d > VEH_REACH) continue
          const ready = v.hasBattery && v.hasKeys && v.fuel > 0
          const sup = slot ? this.canSupply(slot.id, v, progression) : { canInstallBattery: false, canUnlockKey: false, canRefuel: false }
          // Short verbs; the car's state is in the world and on the dashboard once seated.
          let actionLabel = v.seats[0] === "" ? "Drive" : "Ride"
          let statusTag = `${Math.round((v.fuel / v.maxFuel) * 100)}% fuel`
          if (!ready) {
            if (!v.hasBattery) {
              actionLabel = sup.canInstallBattery ? "Fit battery" : "No battery"
              statusTag = "No battery"
            } else if (!v.hasKeys) {
              actionLabel = sup.canUnlockKey ? "Unlock" : "No keys"
              statusTag = "Locked ignition"
            } else {
              actionLabel = sup.canRefuel ? "Refuel" : "Empty tank"
              statusTag = "0% fuel"
            }
          }
          const primary: InteractAction = { id: "enter", label: actionLabel }
          const aabb = aabbOf(v, v.spec)
          out.push({
            kind: "vehicle",
            id: `vehicle:${v.id}`,
            label: `${v.spec.label} · ${statusTag}`,
            rect: aabb,
            worldX: v.x,
            worldY: v.y,
            primary,
            actions: [primary],
          })
        }
        return out
      },
      execute: (_town, actor, targetId, action) => {
        if (action !== "enter") return { handled: false }
        const slot = this.actorOf.get(actor)
        if (!slot) return { handled: false }
        const id = Number(targetId.replace(/^vehicle:/, ""))
        const v = this.byId(id)
        if (!v) return { handled: false }
        const ok = this.enter(slot, v, progression, ai, getTime())
        return { handled: ok, kind: "vehicle", targetId, action: "enter" }
      },
    }
  }

  /**
   * Steps a seated survivor for one tick (`CoopSim.stepSurvivor`).
   * Runs both on the authoritative server and during local client prediction (`predict = true`).
   * Returns `true` when the survivor is in a vehicle (or just exited one this tick) so on-foot movement is skipped.
   */
  stepSeatedSurvivor(
    slot: VehicleRiderSlot,
    command: {
      mx: number
      my: number
      aim: number
      interact?: boolean
      flashlight?: boolean
      jump?: boolean
      sprint?: boolean
      seat?: boolean
      horn?: boolean
    },
    dt: number,
    solids: readonly Rect[],
    progression: OutbreakProgression,
    ai: OutbreakAISubsystem,
    time: number,
    predict: boolean,
  ): boolean {
    const p = slot.survivor
    const v = this.vehicleOf(p)
    if (!v) {
      if (p.vehicleId) this.leaveSeat(slot.id, p)
      return false
    }

    p.aim = command.aim
    const seatIdx = p.seatIndex ?? 0
    if ( v.seats[seatIdx] !== slot.id ) {
      const actualIdx = v.seats.indexOf(slot.id)
      if (actualIdx >= 0) p.seatIndex = actualIdx
      else {
        v.seats[seatIdx] = slot.id
      }
    }

    if (!predict && command.interact) {
      this.exit(slot, solids, ai, time)
      return true
    }

    if (!predict && command.seat) {
      this.cycleSeat(slot, progression)
    }

    const isDriver = (p.seatIndex ?? 0) === 0
    if (isDriver) {
      if (command.flashlight && v.hasBattery && !v.wreck) {
        v.headlights = !v.headlights
        v.modified = true
      }
      const rawDrive = driveFromCommand(command)
      if (!predict && rawDrive.throttle !== 0 && (!v.hasBattery || !v.hasKeys || v.fuel <= 0)) {
        this.trySupplyVehicle(slot, v, progression)
      }
      const canRun = !v.wreck && v.hasBattery && v.hasKeys && v.fuel > 0
      v.engineOn = canRun
      if (canRun) {
        v.drive = rawDrive
      } else {
        v.drive = { throttle: 0, steer: rawDrive.steer, handbrake: true }
        if (!predict && rawDrive.throttle !== 0 && time - v.lastSputterAt > 1.2) {
          v.lastSputterAt = time
          const reason = !v.hasBattery
            ? "Dead battery — needs a Car Battery"
            : !v.hasKeys
              ? "No ignition key — search houses for a Key"
              : `Out of fuel — ${refuelHint(this.refuelRule())}`
          progression.notify(slot, reason, "warning", "vehicle")
          ai.emitNoise(v.x, v.y, 7.5, "door", time, slot.id, 0.5)
        }
      }
      v.horn = Boolean(command.horn && v.hasBattery && !v.wreck)
      v.lastDriver = slot.id

      // Step the driven vehicle physics immediately so client prediction (`Predictor.reconcile`) and server match!
      const impact = driveStep(v, v.drive, v.spec, dt, solids, this.tuning)
      for (const other of this.list) {
        if (other === v) continue
        collideCars(v, v.spec, other, other.spec, dt, false, predict || other.wreck || !other.seats[0])
      }
      if (speedOf(v) > 0.05 || Math.abs(v.drive.throttle) > 0.05) {
        v.modified = true
      }
      if (!predict && impact > 2.0) {
        v.lastCrashAt = time
        v.lastCrashImpact = impact
        ai.emitNoise(v.x, v.y, Math.min(48, 12 + impact * 2.8), "crash", time, slot.id, Math.min(2.2, 0.8 + impact * 0.12))
        if (impact > VEH_CRASH_SPEED && this.tuning.crashDamage > 0) {
          this.damageVehicle(v, (impact - VEH_CRASH_SPEED) * VEH_CRASH_DAMAGE * this.tuning.crashDamage, slotsFrom(slot))
        }
      }
      this.sit(v, p, 0)
    } else {
      // Passenger: F toggles personal flashlight; position rides on seat
      this.sit(v, p, p.seatIndex ?? 1)
    }

    return true
  }

  /**
   * Advances all vehicles once per world tick (`CoopSim.stepWorld`):
   * - Steps coasting/unoccupied vehicles
   * - Consumes fuel & checks gas-station refueling
   * - Emits engine & horn noise to `ai.noiseBus`
   * - Resolves zombie roadkill, knockback, and zombie grabbing/banging on the car
   * - Pushes on-foot survivors and zombies outside vehicle OBBs
   */
  stepWorld(
    dt: number,
    time: number,
    town: Town,
    solids: readonly Rect[],
    slots: readonly VehicleRiderSlot[],
    ai: OutbreakAISubsystem,
    progression: OutbreakProgression,
  ): void {
    // Prune old hit events
    for (let i = this.recentHits.length - 1; i >= 0; i--) {
      if (time - this.recentHits[i]!.time > 0.45) this.recentHits.splice(i, 1)
    }

    const slotById = new Map(slots.map((s) => [s.id, s]))

    for (const v of this.list) {
      // Clear any seats whose survivor disconnected
      for (let s = 0; s < v.seats.length; s++) {
        const sid = v.seats[s]!
        if (sid && !slotById.has(sid)) v.seats[s] = ""
      }
      const driver = v.seats[0] ? slotById.get(v.seats[0]) : undefined
      if (!driver || v.wreck) {
        v.drive = { ...PARKED }
        v.horn = false
        v.engineOn = false
        if (!v.wreck && (Math.abs(v.vx) > 0.01 || Math.abs(v.vy) > 0.01)) {
          driveStep(v, v.drive, v.spec, dt, solids, this.tuning)
          v.modified = true
        } else {
          v.vx = 0
          v.vy = 0
          v.w = 0
        }
      }

      // Fuel burn & gas-station refueling
      if (v.engineOn && v.fuel > 0) {
        const burn = (0.12 + Math.abs(v.drive.throttle) * 0.72) * this.tuning.fuelBurnRate * dt
        v.fuel = Math.max(0, v.fuel - burn)
        if (v.fuel <= 0) {
          v.fuel = 0
          v.engineOn = false
          v.drive = { ...PARKED }
          if (driver) progression.notify(driver, "Out of fuel!", "warning", "vehicle")
        }
      }
      if (!v.wreck && v.fuel < v.maxFuel - 1 && speedOf(v) < 1.2 && driver && this.refuelRule().pumps) {
        const nearGas = town.buildings.some(
          (b) => (b.archetype ?? b.kind) === "gas_station" && distToRect(v.x, v.y, b.rect) < 6.5,
        )
        if (nearGas) {
          v.fuel = v.maxFuel
          v.modified = true
          progression.notify(driver, "Tank refueled at gas station", "result", "vehicle")
        }
      }

      // Engine & horn acoustic events on the AI noise bus
      if (v.engineOn) {
        const lastEng = this.lastEngineNoiseAt.get(v.id) ?? -Infinity
        if (time - lastEng >= 0.32) {
          this.lastEngineNoiseAt.set(v.id, time)
          const spdFrac = Math.min(1, speedOf(v) / Math.max(1, v.spec.maxSpeed))
          const thr = Math.max(Math.abs(v.drive.throttle), spdFrac)
          const idleRadius = Math.max(4, this.tuning.engineNoise * 0.38)
          const radius = idleRadius + (this.tuning.engineNoise - idleRadius) * thr
          ai.emitNoise(
            v.x,
            v.y,
            radius,
            "engine",
            time,
            driver?.id ?? `vehicle-${v.id}`,
            0.75 + 0.85 * thr,
          )
        }
      }
      if (v.horn && v.hasBattery && !v.wreck) {
        const lastH = this.lastHornNoiseAt.get(v.id) ?? -Infinity
        if (time - lastH >= 0.28) {
          this.lastHornNoiseAt.set(v.id, time)
          ai.emitNoise(
            v.x,
            v.y,
            this.tuning.hornNoise,
            "horn",
            time,
            driver?.id ?? `vehicle-${v.id}`,
            1.85,
          )
        }
      }
    }

    //Zombie collisions: roadkill / knockback at speed, grabbing & banging when slow/stopped
    for (const v of this.list) {
      v.grabbingZombies = 0
      const box = boxOf(v, v.spec)
      const speed = speedOf(v)
      const occupied = v.seats.some(Boolean)
      const roadkillThreshold = this.tuning.roadkillSpeed

      for (let i = 0; i < ai.agents.length; i++) {
        const z = ai.agents[i]!
        if (z.state === "dead") continue
        const dist = distToBox(z.x, z.y, box)

        // 1. Direct body contact / impact
        if (dist < ZOMBIE_RADIUS + 0.08) {
          if (!v.wreck && speed >= 1.6 && closing(v, z)) {
            const dx = z.x - v.x
            const dy = z.y - v.y
            const dLen = Math.hypot(dx, dy) || 1
            const ux = dx / dLen
            const uy = dy / dLen
            const lethal = speed >= roadkillThreshold
            const dmg = lethal ? Math.max(120, z.hp + 20) : Math.round(speed * 15 * this.tuning.ramDamage)
            z.hp = Math.max(0, z.hp - dmg)
            z.hitFlash = 1.0
            z.awareness = 1.0
            v.zombieHits++
            v.modified = true
            // Slight momentum transfer on impact
            v.vx *= lethal ? 0.94 : 0.88
            v.vy *= lethal ? 0.94 : 0.88
            this.damageVehicle(v, (lethal ? 4 : 2) * this.tuning.crashDamage, slots)

            if (z.hp <= 0) {
              z.state = "dead"
              z.stateTime = 0
              v.zombieKills++
            } else {
              z.state = "stagger"
              z.stateTime = 0
              z.timer = 0.68
              z.staggerVx = ux * Math.max(4.5, speed * 0.85) + v.vx * 0.35
              z.staggerVy = uy * Math.max(4.5, speed * 0.85) + v.vy * 0.35
            }
            pushOutBox(z, ZOMBIE_RADIUS + 0.12, box)
            this.recentHits.push({
              vehicleId: v.id,
              zombieId: z.id,
              x: z.x,
              y: z.y,
              dirX: ux,
              dirY: uy,
              speed,
              damage: dmg,
              killed: z.state === "dead",
              time,
            })
            ai.emitNoise(z.x, z.y, 14, "bash", time, `vehicle-${v.id}`, 1.1)
            continue
          }
          pushOutBox(z, ZOMBIE_RADIUS, box)
        }

        // 2. Zombies grabbing and banging on an occupied slow/parked car
        if (occupied && !v.wreck && dist <= 0.68 && speed < 4.0) {
          const engaged = z.state === "chase" || z.state === "alert" || z.state === "investigate" || z.state === "bash"
          if (engaged) {
            v.grabbingZombies++
            const wantAim = Math.atan2(v.y - z.y, v.x - z.x)
            z.aim += Math.max(-dt * 10, Math.min(dt * 10, angleDiff(wantAim, z.aim)))
            if (z.attackCooldown <= 0) {
              z.attackCooldown = 0.95 / Math.max(0.5, z.aggression * ai.config.aggression)
              v.bangCount++
              v.lastBangAt = time
              v.modified = true
              const bangDmg = 10 * z.aggression * ai.config.aggression
              this.damageVehicle(v, bangDmg, slots)
              ai.emitNoise(z.x, z.y, 14, "bash", time, `zombie-${z.id}`, 1.1)
              // Nearest rider takes reduced chip damage through the window when zombies pound the car
              let nearestRider: VehicleRiderSlot | undefined
              let nearestDist = Infinity
              for (let s = 0; s < v.seats.length; s++) {
                const sid = v.seats[s]!
                const rSlot = sid ? slotById.get(sid) : undefined
                if (!rSlot) continue
                const sp = seatPos(v, v.spec, s)
                const dRider = Math.hypot(sp.x - z.x, sp.y - z.y)
                if (dRider < nearestDist) {
                  nearestDist = dRider
                  nearestRider = rSlot
                }
              }
              if (nearestRider && nearestDist < 1.65) {
                const seatArmor = v.spec.seats[nearestRider.survivor.seatIndex ?? 0]?.armor ?? 0.4
                const riderDmg = bangDmg * seatArmor * (v.hp < v.maxHp * 0.4 ? 0.65 : 0.25)
                nearestRider.survivor.health = Math.max(0, nearestRider.survivor.health - riderDmg)
              }
            }
          }
        }
      }

      // Apply grabbing drag from zombies clinging to the car
      if (v.grabbingZombies > 0 && speed > 0.01) {
        const drag = Math.exp(-Math.min(6, v.grabbingZombies) * 1.4 * dt)
        v.vx *= drag
        v.vy *= drag
      }
    }

    // Keep all seated riders anchored to their seats and push on-foot survivors out of vehicle boxes
    for (const v of this.list) {
      if (!v.wreck) {
        for (let s = 0; s < v.seats.length; s++) {
          const sid = v.seats[s]!
          const rSlot = sid ? slotById.get(sid) : undefined
          if (rSlot) {
            rSlot.survivor.vehicleId = v.id
            rSlot.survivor.seatIndex = s
            this.sit(v, rSlot.survivor, s)
          }
        }
      }
    }
    for (const slot of slots) {
      const p = slot.survivor
      if (p.vehicleId) continue
      for (const v of this.list) {
        pushOutBox(p, PLAYER_RADIUS, boxOf(v, v.spec))
      }
    }
  }

  damageVehicle(v: OutbreakVehicle, dmg: number, slots: readonly VehicleRiderSlot[]): void {
    if (v.wreck || dmg <= 0) return
    v.hp = Math.max(0, v.hp - dmg)
    v.modified = true
    if (v.hp <= 0) {
      v.wreck = true
      v.engineOn = false
      v.headlights = false
      v.horn = false
      v.drive = { ...PARKED }
      v.vx *= 0.25
      v.vy *= 0.25
      v.w *= 0.25
      const slotById = new Map(slots.map((s) => [s.id, s]))
      for (let s = 0; s < v.seats.length; s++) {
        const sid = v.seats[s]!
        v.seats[s] = ""
        const rSlot = sid ? slotById.get(sid) : undefined
        if (rSlot) {
          rSlot.survivor.vehicleId = null
          rSlot.survivor.seatIndex = 0
          const side = (v.spec.seats[s]?.s ?? -0.4) <= 0 ? -1 : 1
          const ej = localToWorld(v, v.spec.seats[s]?.f ?? 0, side * (v.spec.width / 2 + 0.55))
          rSlot.survivor.x = ej.x
          rSlot.survivor.y = ej.y
          rSlot.survivor.health = Math.max(10, rSlot.survivor.health - 25)
        }
      }
    }
  }
}

function slotsFrom(slot: VehicleRiderSlot): readonly VehicleRiderSlot[] {
  return [slot]
}

/** Collects solid collision rects for vehicles (walls, closed doors, fences, furniture, trees, and static car hulks). */
export function vehicleSolidRects(town: Town): Rect[] {
  const out: Rect[] = []
  for (let i = 0; i < town.barriers.length; i++) {
    out.push(town.barriers[i]!.rect)
  }
  for (let i = 0; i < town.doors.length; i++) {
    const d = town.doors[i]!
    if (!d.open) out.push(d.rect)
  }
  for (let i = 0; i < town.props.length; i++) {
    const p = town.props[i]!
    if (p.kind === "tree") {
      out.push([p.x - 0.28, p.y - 0.28, p.x + 0.28, p.y + 0.28])
    } else {
      const s = propShape(p)
      if (s) out.push(s.rect)
    }
  }
  const veh = town.vehicles ?? EXTERIOR_VEHICLE_COLLIDERS
  for (let i = 0; i < veh.length; i++) out.push(veh[i]!)
  return out
}
