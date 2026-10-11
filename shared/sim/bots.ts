import { type Input, speedOf } from "./vehicle"
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

export function robberBrain(world: World, car: Car): Input {
  const exit = world.exit
  reroute(world, car, exit.x, exit.z, 3)
  const input = followRoute(world, car, exit.x, exit.z, car.vehicle.maxSpeed)
  input.boost = speedOf(car.body) > 18 && Math.abs(input.steer) < 0.25 && world.cops().some((c) => Math.hypot(c.body.x - car.body.x, c.body.z - car.body.z) < 40)
  return input
}

export function copBrain(world: World, car: Car): Input {
  const target = world.copTarget()
  if (!target) return driveToward(car, car.homeX, car.homeZ, car.vehicle.maxSpeed * 0.4)
  const d = Math.hypot(target.x - car.body.x, target.z - car.body.z)
  if (target.visible && d < 55) {
    const input = driveToward(car, target.x, target.z, car.vehicle.maxSpeed)
    input.boost = d > 18 && Math.abs(input.steer) < 0.3
    return input
  }
  // Without eyes on the suspect, every other unit covers the extraction point.
  const guard = !target.visible && car.id % 2 === 0
  const tx = guard ? world.exit.x : target.x
  const tz = guard ? world.exit.z : target.z
  reroute(world, car, tx, tz, 2.5)
  if (guard && Math.hypot(tx - car.body.x, tz - car.body.z) < 25) return driveToward(car, tx, tz, 6)
  return followRoute(world, car, tx, tz, car.vehicle.maxSpeed)
}
