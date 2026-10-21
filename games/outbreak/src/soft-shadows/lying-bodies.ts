/**
 * Bodies drawn as static lying meshes this frame (fallen survivors, vignette and porch bodies), for soft shadows. The
 * presenters that draw them call `noteLyingBody` as they place each one; the soft-shadow presenter reads and clears
 * the list once per frame, after every batch is collected.
 */
const bodies: number[] = []

/** A body lying with its head along instance `yaw` at (x, y, z) (y is the ground under it). */
export function noteLyingBody(x: number, y: number, z: number, yaw: number): void {
  if (bodies.length < 64 * 4) bodies.push(x, y, z, yaw)
}

/** Visits and clears this frame's lying bodies. */
export function takeLyingBodies(visit: (x: number, y: number, z: number, yaw: number) => void): void {
  for (let i = 0; i < bodies.length; i += 4) visit(bodies[i]!, bodies[i + 1]!, bodies[i + 2]!, bodies[i + 3]!)
  bodies.length = 0
}
