import { describe, expect, test } from "bun:test"
import { DT, HEALTH, PLAYER_RADIUS } from "../shared/config"
import { Builder } from "../shared/maps/builder"
import { COVER } from "../shared/sim/cover"
import { buildSnapshot } from "../shared/sim/view"
import { type Intent, World } from "../shared/sim/world"
import { place, run } from "./helpers"

/**
 * A 40 x 20 m room: a tall wall at x = 10..10.3 from the north wall down to y = 8, desks at x = 20..22, y = 9..9.8
 * and x = 6..8, y = 10..10.8, and a cubicle partition at x = 28..31, y = 9..9.08.
 */
function coverWorld(names: string[] = ["a", "b"]): World {
  const b = new Builder()
  b.floor("carpet", 0, 0, 40, 20)
  b.wall(0, 0, 40, 0.3)
  b.wall(0, 19.7, 40, 20)
  b.wall(0, 0, 0.3, 20)
  b.wall(39.7, 0, 40, 20)
  b.wall(10, 0, 10.3, 8)
  b.prop("desk", 20, 9, 22, 9.8)
  b.prop("desk", 6, 10, 8, 10.8)
  b.wall(28, 9, 31, 9.08, 1.3, "partition")
  b.spawns.push({ x: 3, y: 3 }, { x: 3, y: 17 }, { x: 37, y: 3 }, { x: 37, y: 17 })
  const w = new World(5, b.build({ id: "cover", seed: 0, name: "Cover", size: [40, 20] }))
  for (const n of names) w.addHuman(n, n)
  for (const p of [...w.players.values()]) if (!p.human) w.remove(p.id)
  w.step()
  w.takeEvents()
  return w
}

const LINE = PLAYER_RADIUS + COVER.gap
const east = 0
const south = Math.PI / 2
const north = -Math.PI / 2

/** Presses Space once (on the first tick) for `id`, holding `hold` the whole time. */
function press(w: World, id: string, seconds: number, hold: Partial<Intent> = {}): void {
  let first = true
  run(w, seconds, (pid) => {
    if (pid !== id) return {}
    const i = { ...hold, cover: first }
    first = false
    return i
  })
}

/** Takes cover against the tall wall's west face at y = 4, aiming east. */
function inCover(w: World) {
  place(w, "a", 8.5, 4)
  press(w, "a", 0.4, { aim: east })
  return w.players.get("a")!
}

describe("cover", () => {
  test("Space snaps you to the wall in front, quickly but not instantly", () => {
    const w = coverWorld(["a"])
    place(w, "a", 8.5, 4)
    press(w, "a", 3 * DT, { aim: east })
    const a = w.players.get("a")!
    expect(a.cover?.enter).toBeGreaterThan(0)
    expect(a.x).toBeLessThan(10 - LINE - 0.1)
    run(w, 0.3, () => ({ aim: east }))
    expect(a.cover).not.toBeNull()
    expect(a.cover!.enter).toBe(0)
    expect(a.cover!.low).toBe(false)
    expect(a.cover!.nx).toBe(-1)
    expect(a.x).toBeCloseTo(10 - LINE, 3)
    expect(a.y).toBeCloseTo(4, 1)
  })

  test("not a wall behind you, and not one out of reach", () => {
    const w = coverWorld(["a"])
    place(w, "a", 11.5, 4)
    press(w, "a", 0.4, { aim: east })
    expect(w.players.get("a")!.cover).toBeNull()
    place(w, "a", 6, 4)
    press(w, "a", 0.4, { aim: east })
    expect(w.players.get("a")!.cover).toBeNull()
    expect(w.players.get("a")!.x).toBeCloseTo(6, 3)
  })

  test("moving toward a wall takes cover against it, whatever the aim", () => {
    const w = coverWorld(["a"])
    place(w, "a", 8.5, 4)
    press(w, "a", 0.4, { aim: Math.PI, mx: 1 })
    expect(w.players.get("a")!.cover?.nx).toBe(-1)
  })

  test("in cover you slide along the wall, slower than walking, and stop at its ends", () => {
    const w = coverWorld(["a"])
    const a = inCover(w)
    run(w, 0.5, () => ({ aim: east, my: 1 }))
    expect(a.x).toBeCloseTo(10 - LINE, 3)
    expect(a.y - 4).toBeGreaterThan(COVER.speed * 0.5 - 0.1)
    expect(a.y - 4).toBeLessThan(COVER.speed * 0.5 + 0.1)
    run(w, 3, () => ({ aim: east, my: 1 }))
    expect(a.x).toBeCloseTo(10 - LINE, 3)
    // The open end is a corner: rest just short of it.
    expect(a.y).toBeCloseTo(8 - COVER.inset, 1)
    // The other end runs into the north wall: stop where the body meets it.
    run(w, 5, () => ({ aim: east, my: -1 }))
    expect(a.x).toBeCloseTo(10 - LINE, 3)
    expect(a.y).toBeCloseTo(0.3 + PLAYER_RADIUS, 1)
    expect(a.cover).not.toBeNull()
  })

  test("at a corner, the trigger leans you out past the edge, and letting go brings you back", () => {
    const w = coverWorld(["a"])
    const a = inCover(w)
    run(w, 3, () => ({ aim: east, my: 1 }))
    const rest = a.y
    const peekAim = Math.atan2(1, 1)
    run(w, 0.4, () => ({ aim: peekAim, fire: true }))
    expect(a.cover!.peek).not.toBe(0)
    expect(a.y).toBeGreaterThan(8 + 0.3)
    expect(a.y - rest).toBeCloseTo(COVER.peek, 1)
    expect(a.x).toBeCloseTo(10 - LINE, 3)
    run(w, 0.8, () => ({ aim: peekAim }))
    expect(a.cover!.peek).toBe(0)
    expect(a.y).toBeCloseTo(rest, 2)
  })

  test("right click peeks too, and the first shot waits for the lean", () => {
    const w = coverWorld(["a", "b"])
    const a = inCover(w)
    run(w, 3, () => ({ aim: east, my: 1 }))
    // Someone around the corner, out of sight from the rest spot.
    place(w, "b", 13, 9.2)
    const aim = Math.atan2(9.2 - 8.45, 13 - a.x)
    run(w, 0.4, (id) => (id === "a" ? { aim, peek: true } : {}))
    expect(a.y).toBeGreaterThan(8.3)
    a.cooldownUntil = 0
    run(w, 0.2, (id) => (id === "a" ? { aim: Math.atan2(9.2 - a.y, 13 - a.x), peek: true, fire: true } : {}))
    expect(w.players.get("b")!.health).toBeLessThan(HEALTH)
  })

  test("Space again, or holding away from the wall, leaves cover", () => {
    const w = coverWorld(["a"])
    const a = inCover(w)
    press(w, "a", 0.1, { aim: east })
    expect(a.cover).toBeNull()
    inCover(w)
    run(w, 0.1, () => ({ aim: east, mx: -1 }))
    expect(a.cover).not.toBeNull()
    run(w, 0.4, () => ({ aim: east, mx: -1 }))
    expect(a.cover).toBeNull()
    expect(a.x).toBeLessThan(10 - LINE - 0.1)
  })

  test("no sprinting in cover, and sprinting away leaves at once", () => {
    const w = coverWorld(["a"])
    const a = inCover(w)
    run(w, 0.3, () => ({ aim: east, my: 1, sprint: true }))
    expect(a.cover).not.toBeNull()
    expect(Math.hypot(a.vx, a.vy)).toBeLessThanOrEqual(COVER.speed + 1e-6)
    expect(a.readyAt).toBeLessThan(w.time)
    run(w, DT, () => ({ aim: east, mx: -1, sprint: true }))
    expect(a.cover).toBeNull()
  })

  test("taking cover cancels a sprint", () => {
    const w = coverWorld(["a"])
    place(w, "a", 8, 4)
    press(w, "a", 0.4, { aim: east, mx: 1, sprint: true })
    const a = w.players.get("a")!
    expect(a.cover).not.toBeNull()
    expect(a.x).toBeCloseTo(10 - LINE, 3)
  })

  test("a desk is low cover: crouched behind it you can't be shot through it, popped up you can", () => {
    // Desks don't stop bullets on their own.
    const w0 = coverWorld()
    place(w0, "a", 21, 8.5)
    place(w0, "b", 21, 14).cooldownUntil = 0
    run(w0, 0.3, (id) => (id === "b" ? { aim: north, fire: true } : {}))
    expect(w0.players.get("a")!.health).toBeLessThan(HEALTH)

    const w = coverWorld()
    place(w, "a", 21, 7.5)
    press(w, "a", 0.4, { aim: south })
    const a = w.players.get("a")!
    expect(a.cover?.low).toBe(true)
    expect(a.cover?.ny).toBe(-1)
    expect(a.y).toBeCloseTo(9 - LINE, 3)
    place(w, "b", 21, 14)
    run(w, 1, (id) => (id === "b" ? { aim: north, fire: true } : { aim: south }))
    expect(a.health).toBe(HEALTH)
    expect(a.alive).toBe(true)
    run(w, 0.3, (id) => (id === "b" ? { aim: north, fire: true } : { aim: south, peek: true }))
    expect(a.health).toBeLessThan(HEALTH)
  })

  test("low cover only guards the side it faces", () => {
    const w = coverWorld()
    place(w, "a", 21, 7.5)
    press(w, "a", 0.4, { aim: south })
    const a = w.players.get("a")!
    place(w, "b", 21, 4)
    run(w, 0.3, (id) => (id === "b" ? { aim: south, fire: true } : { aim: south }))
    expect(a.health).toBeLessThan(HEALTH)
  })

  test("behind a partition you pop up to shoot over it, and can be shot while up", () => {
    const w = coverWorld()
    place(w, "a", 29.5, 7.5)
    press(w, "a", 0.4, { aim: south })
    const a = w.players.get("a")!
    const b = w.players.get("b")!
    expect(a.cover?.low).toBe(true)
    place(w, "b", 29.5, 13)
    // Crouched, the partition stops shots both ways.
    run(w, 0.5, (id) => (id === "b" ? { aim: north, fire: true } : { aim: south }))
    expect(a.health).toBe(HEALTH)
    // Popped up, you can shoot over it.
    a.cooldownUntil = 0
    b.cooldownUntil = w.time + 10
    run(w, 0.4, (id) => (id === "a" ? { aim: south, fire: true } : { aim: north }))
    expect(b.health).toBeLessThan(HEALTH)
    // And you're exposed while up.
    b.cooldownUntil = 0
    run(w, 0.3, (id) => (id === "b" ? { aim: north, fire: true } : { aim: south, peek: true }))
    expect(a.health).toBeLessThan(HEALTH)
  })

  test("Space aimed at other cover nearby hops to it; with none in reach it leaves", () => {
    const w = coverWorld(["a"])
    const a = inCover(w)
    run(w, 3, () => ({ aim: east, my: 1 }))
    const wall = a.cover!
    // The far desk is out of hop range.
    press(w, "a", 0.2, { aim: Math.atan2(9 - a.y, 20.5 - a.x) })
    expect(a.cover).toBeNull()
    inCover(w)
    run(w, 3, () => ({ aim: east, my: 1 }))
    press(w, "a", 1, { aim: Math.atan2(10 - a.y, 7 - a.x) })
    expect(a.cover).not.toBeNull()
    expect(a.cover).not.toBe(wall)
    expect(a.cover!.low).toBe(true)
    expect(a.cover!.ny).toBe(-1)
    expect(a.y).toBeCloseTo(10 - LINE, 3)
    expect(a.x).toBeCloseTo(7, 0)
  })

  test("snapshots carry cover", () => {
    const w = coverWorld(["a", "b"])
    inCover(w)
    const s = buildSnapshot(w, "b")
    const v = s.players.find((p) => p.id === "a")!
    expect(v.cover).toEqual({ nx: -1, ny: 0, low: false, out: false, peek: 0, enter: false })
    expect(buildSnapshot(w, "a").you!.cover!.nx).toBe(-1)
  })
})
