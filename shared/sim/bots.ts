import { type Input, forward, speedOf } from "./vehicle"
import { nearestNode } from "./city"
import type { Car, World } from "./world"

const TAU = Math.PI * 2

export function wrapAngle(a: number) {
  let x = (a + Math.PI) % TAU
  if (x < 0) x += TAU
  return x - Math.PI
}

/** Pure pursuit toward a world point with a speed cap, braking into sharp turns and backing out when stuck. */
export function driveToward(car: Car, tx: number, tz: number, cap: number): Input {
  const b = car.body
  const dx = tx - b.x
  const dz = tz - b.z
  const dist = Math.hypot(dx, dz)
  const err = wrapAngle(Math.atan2(dx, dz) - b.h)
  const speed = speedOf(b)
  const steer = Math.max(-1, Math.min(1, err * 2.2))
  const want = Math.min(cap, 8 + dist * 0.7)
  const input: Input = { throttle: 0, brake: 0, steer, handbrake: false, boost: false }
  if (speed < want) input.throttle = 1
  if (speed > want * 1.15) input.brake = 0.7
  if (Math.abs(err) > 1.1 && speed > 14) {
    input.throttle = 0.3
    input.brake = 0.4
    input.handbrake = Math.abs(err) > 1.9 && speed > 16 && car.role === "robber"
  }
  if (car.reverseT > 0) {
    car.reverseT -= 1 / 30
    return { throttle: -1, brake: 0, steer: -steer, handbrake: false, boost: false }
  }
  if (speed < 1.5 && input.throttle > 0.5) car.stuck += 1 / 30
  else car.stuck = 0
  if (car.stuck > 1) {
    car.stuck = 0
    car.reverseT = 1
  }
  return input
}

/** Follows the precomputed road route node by node, then heads straight for the goal. */
export function followRoute(world: World, car: Car, gx: number, gz: number, cap: number): Input {
  const b = car.body
  while (car.routeI < car.route.length) {
    const n = world.city.nodes[car.route[car.routeI]!]!
    if (Math.hypot(n.x - b.x, n.z - b.z) < 14) {
      car.routeI++
      continue
    }
    return driveToward(car, n.x, n.z, cap)
  }
  return driveToward(car, gx, gz, cap)
}

function reroute(world: World, car: Car, tx: number, tz: number, every: number) {
  car.routeT -= 1 / 30
  if (car.routeT > 0 && Math.hypot(car.routeX - tx, car.routeZ - tz) < 18) return
  car.route = world.routeTo(car.body.x, car.body.z, tx, tz)
  car.routeI = 0
  car.routeT = every
  car.routeX = tx
  car.routeZ = tz
}

/** A road node far from every cop and not too far from the exit, to lie low until the ride arrives. */
function hideout(world: World, car: Car): { x: number; z: number } {
  const cops = world.cops()
  let best = world.city.nodes[0]!
  let bestScore = -Infinity
  for (const n of world.city.nodes) {
    let away = 260
    for (const c of cops) away = Math.min(away, Math.hypot(c.body.x - n.x, c.body.z - n.z))
    const d = Math.hypot(n.x - car.body.x, n.z - car.body.z)
    const score = away - 0.3 * Math.hypot(n.x - world.exit.x, n.z - world.exit.z) - 0.1 * d + (d < 30 ? -80 : 0)
    if (score > bestScore) {
      bestScore = score
      best = n
    }
  }
  return best
}

export function robberBrain(world: World, car: Car): Input {
  const exit = world.exit
  const b = car.body
  const eta = Math.hypot(exit.x - b.x, exit.z - b.z) / 26
  let goal: { x: number; z: number } = exit
  if (world.exitOpenIn() > eta) {
    car.hideT -= 1 / 30
    if (car.hideT <= 0 || Math.hypot(car.hideX - b.x, car.hideZ - b.z) < 20) {
      const h = hideout(world, car)
      car.hideX = h.x
      car.hideZ = h.z
      car.hideT = world.seen ? 2 : 5
    }
    goal = { x: car.hideX, z: car.hideZ }
  }
  reroute(world, car, goal.x, goal.z, 3)
  const input = followRoute(world, car, goal.x, goal.z, car.vehicle.maxSpeed)
  const near = world.cops().map((c) => ({ c, d: Math.hypot(c.body.x - b.x, c.body.z - b.z) }))
  input.boost = speedOf(b) > 18 && Math.abs(input.steer) < 0.25 && near.some((n) => n.d < 40)
  const [fx, fz] = forward(b.h)
  const tailed = near.some(({ c, d }) => d < 28 && (c.body.x - b.x) * fx + (c.body.z - b.z) * fz < -0.5 * d)
  if (tailed && speedOf(b) > 12 && world.gadgetReady(car, 0)) input.gadget = 0
  else if (world.seen && (near.some((n) => n.d < 35) || world.bust > 0.25 || world.heli.lock > 1.5) && world.gadgetReady(car, 1)) input.gadget = 1
  return input
}

/** Spike strip when the visible robber is driving straight at this cop; roadblock on the approach to the exit. */
function copGadget(world: World, car: Car, visible: boolean, guard: boolean): 0 | 1 | null {
  const b = car.body
  const r = world.robber()
  if (visible && r && world.gadgetReady(car, 0)) {
    const dx = r.body.x - b.x
    const dz = r.body.z - b.z
    const d = Math.hypot(dx, dz)
    const [fx, fz] = forward(b.h)
    const facing = (dx * fx + dz * fz) / Math.max(1e-3, d)
    const closing = (-dx * r.body.vx - dz * r.body.vz) / Math.max(1e-3, d)
    if (d > 18 && d < 65 && facing > 0.8 && closing > 12) return 0
  }
  if (guard && world.exitOpenIn() < 12 && world.gadgetReady(car, 1)) {
    const de = Math.hypot(world.exit.x - b.x, world.exit.z - b.z)
    const n = world.city.nodes[nearestNode(world.city, b.x, b.z)]!
    if (de > 15 && de < 45 && Math.hypot(n.x - b.x, n.z - b.z) > 14) return 1
  }
  return null
}

export function copBrain(world: World, car: Car): Input {
  const target = world.copTarget(car)
  if (!target) return driveToward(car, car.homeX, car.homeZ, car.vehicle.maxSpeed * 0.4)
  const d = Math.hypot(target.x - car.body.x, target.z - car.body.z)
  if (target.visible && d < 55) {
    const input = driveToward(car, target.x, target.z, car.vehicle.maxSpeed)
    input.boost = d > 18 && Math.abs(input.steer) < 0.3
    input.gadget = copGadget(world, car, true, false)
    return input
  }
  // Every other unit covers the extraction point (all of them once the ride is about to arrive and the trail is cold).
  const closing = world.exitOpenIn() < 15
  const guard = car.id % 2 === 0 ? closing || !target.visible : closing && !target.visible
  const tx = guard ? world.exit.x : target.x
  const tz = guard ? world.exit.z : target.z
  reroute(world, car, tx, tz, 2.5)
  const input = guard && Math.hypot(tx - car.body.x, tz - car.body.z) < 25 ? driveToward(car, tx, tz, 6) : followRoute(world, car, tx, tz, car.vehicle.maxSpeed)
  input.gadget = copGadget(world, car, target.visible, guard)
  return input
}
