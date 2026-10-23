import { describe, expect, test } from "bun:test"
import { CREATURE_STEP, createCreatureMotion, stepCreatureMotion, unitDt, unitSurface } from "../sim/creature-motion"
import type { ForestRock, ForestTree } from "../sim/forest-world"
import { ArachnidLegs, HARVESTMAN_SHAPE } from "./arachnid-legs"
import { createRoute, routeIntent } from "./arachnid-route"
import { forestCreatureSurface } from "./forest-surface"

const SIZE = 8.75
const BODY = 1.12
const tree = (x: number, z: number, r: number): ForestTree => ({ x, z, r, h: 20, species: "pine", seed: 1 })
const rock = (x: number, z: number, r: number): ForestRock => ({ x, z, r, h: 1, yaw: 0, seed: 1 })

/** Walks the harvestman (8.75 m per unit) from the origin toward (40, 0); returns its track and its longest stop. */
function walkAt(trees: ForestTree[], rocks: ForestRock[]) {
  const surface = forestCreatureSurface({ height: () => 0, trees, rocks }, () => BODY)
  const ground = unitSurface(surface, SIZE)
  const route = createRoute([[40, 0]], false)
  const motion = createCreatureMotion(0, 0, 0)
  const legs = new ArachnidLegs(motion, ground, SIZE, HARVESTMAN_SHAPE)
  const dt = unitDt(CREATURE_STEP, SIZE)
  const track: [number, number][] = []
  let stopped = 0, longestStop = 0
  for (let f = 0; f < 60 * 60; f++) {
    stepCreatureMotion(motion, routeIntent(route, motion.x * SIZE, motion.z * SIZE, 0.35, "walk", 3), dt, ground)
    legs.step(motion, ground, dt)
    const speed = Math.hypot(motion.vx, motion.vz) * Math.sqrt(SIZE)
    stopped = f > 120 && speed < 0.1 && Math.hypot(40 - motion.x * SIZE, motion.z * SIZE) > 3 ? stopped + 1 : 0
    longestStop = Math.max(longestStop, stopped / 60)
    track.push([motion.x * SIZE, motion.z * SIZE])
  }
  return { track, longestStop, end: track[track.length - 1]! }
}

describe("forest creature surface", () => {
  // The Lab loop's 14 s stall: the route ran straight at a 1.6 m boulder, and the body (riding 4 m up) was pushed
  // back off the rock every step.
  test("a boulder dead ahead does not stop the body: rocks only keep feet out", () => {
    const { longestStop, end } = walkAt([], [rock(15, 0, 1.6)])
    expect(longestStop).toBeLessThan(0.5)
    expect(Math.hypot(end[0] - 40, end[1])).toBeLessThan(3.5)
  })

  test("a trunk dead ahead is skirted, never entered, and it keeps walking", () => {
    const { track, longestStop, end } = walkAt([tree(15, 0, 0.5)], [])
    expect(longestStop).toBeLessThan(0.5)
    expect(Math.hypot(end[0] - 40, end[1])).toBeLessThan(3.5)
    const closest = Math.min(...track.map(([x, z]) => Math.hypot(x - 15, z)))
    expect(closest).toBeGreaterThanOrEqual(0.5 + 0.12 + BODY - 1e-6)
  })

  test("feet stay out of trunks, rocks and the lake", () => {
    const surface = forestCreatureSurface({ height: (x: number) => (x > 30 ? -1 : 0), trees: [tree(5, 0, 0.5)], rocks: [rock(10, 0, 1)], lake: { level: -0.5 } as never }, () => BODY)
    expect(surface.walkable!(5.2, 0)).toBe(false)
    expect(surface.walkable!(10.5, 0)).toBe(false)
    expect(surface.walkable!(35, 0)).toBe(false)
    expect(surface.walkable!(20, 0)).toBe(true)
  })
})
