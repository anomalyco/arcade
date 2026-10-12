import { CELL, DT } from "../shared/config"
import { type Participant, World } from "../shared/sim/world"
import { type Input, NO_INPUT } from "../shared/sim/vehicle"

export const human = (id: string, robber = "muscle", cop = "cruiser"): Participant => ({ id, name: id.toUpperCase(), human: true, picks: { robber, cop } })
export const bot = (id: string): Participant => ({ id, name: id.toUpperCase(), human: false, picks: { robber: "muscle", cop: "cruiser" } })

/** A middle-of-the-road spot on the north-south avenue at x = 3 * CELL, clear of buildings. */
export const ROAD_X = 3 * CELL
export const ROAD_Z = 3 * CELL + CELL / 2

export function steps(w: World, seconds: number, each?: () => void) {
  const n = Math.round(seconds / DT)
  for (let i = 0; i < n; i++) {
    each?.()
    w.step(DT)
  }
}

export function toChase(w: World) {
  for (let i = 0; i < 30 * 30 && w.phase !== "chase"; i++) w.step(DT)
}

/** Teleports a car and zeroes its motion. */
export function place(w: World, ownerId: string, x: number, z: number, h = 0, speed = 0) {
  const b = w.carOf(ownerId)!.body
  b.x = x
  b.z = z
  b.h = h
  b.vx = Math.sin(h) * speed
  b.vz = Math.cos(h) * speed
  b.yaw = 0
  b.stun = 0
}

export const drive = (throttle: number, extra: Partial<Input> = {}): Input => ({ ...NO_INPUT, throttle, ...extra })

/** Robber "r" and human cops; no bots, so nothing moves unless told to. */
export function humanWorld(cops = ["c1", "c2"], robberCar = "muscle", copCar = "cruiser", seed = 7) {
  const w = new World(seed, [human("r", robberCar, copCar), ...cops.map((c) => human(c, robberCar, copCar))])
  return w
}
