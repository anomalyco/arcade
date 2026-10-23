/**
 * Steers a creature root along waypoints (world metres) at a share of its full speed: the Lab station's walk and the
 * motion-check route. Pure; the stalker AI will make its own intents the same shape.
 */
import type { CreatureIntent, CreaturePace } from "../sim/creature-motion"

export type CreatureRoute = { points: readonly (readonly [number, number])[]; loop: boolean; next: number }

export const createRoute = (points: readonly (readonly [number, number])[], loop = true): CreatureRoute => ({ points, loop, next: 0 })

/** The intent toward the next waypoint from (x, z), advancing within `arrive` m. Stops at the end of an open route. */
export function routeIntent(route: CreatureRoute, x: number, z: number, share: number, pace: CreaturePace = "walk", arrive = 3): CreatureIntent {
  if (!route.points.length) return { dx: 0, dz: 0, pace }
  let [tx, tz] = route.points[route.next]!
  if (Math.hypot(tx - x, tz - z) < arrive) {
    if (route.next + 1 < route.points.length) route.next++
    else if (route.loop) route.next = 0
    else return { dx: 0, dz: 0, pace }
    ;[tx, tz] = route.points[route.next]!
  }
  const dx = tx - x, dz = tz - z, l = Math.hypot(dx, dz) || 1
  return { dx: (dx / l) * share, dz: (dz / l) * share, pace }
}
