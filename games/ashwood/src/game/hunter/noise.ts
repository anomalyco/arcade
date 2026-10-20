// Noise events the Wendigo hunter can hear (src/game/hunter). No three.js here, so any module can report a noise
// cheaply: `emitNoise({ x, y, z }, 14, "knock")` when the player knocks something over, drops a bucket, rings a phone.
//
// `radius` is how far the noise carries in the open (m). The hunter attenuates it by distance, every wall-height solid
// on the straight line between them, and the storeys in between (src/game/hunter/senses.ts). Reference radii:
//   crouch-walk 1.5 · walk 7 · jog 10 · sprint 18–40 (kind "sprint": carries through walls and floors) · landing 6–14 · flashlight click 2.5 · door eased open 7 · door banged 18 ·
//   lift clunk 14–28 · a hold-E search 3–5 ("search"), a metal locker 8–10 ("search") · the truck's engine starting or
//   the dock's roll-up door ("engine", 90: heard anywhere in the building; it comes straight there at a rush) · something knocked over 14 · the transmitter switch 30

export type NoiseKind = "step" | "sprint" | "land" | "door" | "lift" | "flashlight" | "knock" | "search" | "engine" | "voice" | "switch" | "other"

export type NoiseEvent = {
  x: number
  /** World y of the source (feet for steps). */
  y: number
  z: number
  radius: number
  kind: NoiseKind
  /** Seconds (performance.now() / 1000) when it happened. */
  t: number
}

const listeners = new Set<(e: NoiseEvent) => void>()
let last: NoiseEvent | null = null
let loudest: NoiseEvent | null = null

/** Reports a noise at `p`. */
export function emitNoise(p: { x: number; y: number; z: number }, radius: number, kind: NoiseKind = "other") {
  const e: NoiseEvent = { x: p.x, y: p.y, z: p.z, radius, kind, t: performance.now() / 1000 }
  last = e
  // The most recent loud one (the hunter's first target when it arrives): louder noises stay "the last loud noise" for
  // longer than quiet ones.
  if (!loudest || radius >= Math.min(8, loudest.radius * 0.5) || e.t - loudest.t > loudest.radius * 4) loudest = e
  for (const l of listeners) l(e)
}

/** Subscribes to noises. Returns an unsubscribe function. */
export function onNoise(fn: (e: NoiseEvent) => void) {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

/** The most recent noise, and the most recent loud one (≥ 8 m radius, or louder than half the previous loud one). */
export const lastNoise = () => last
export const lastLoudNoise = () => loudest
