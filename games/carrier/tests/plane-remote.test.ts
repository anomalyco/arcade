import { describe, expect, test } from "bun:test"
import { CENTERLINE_X } from "../shared/carrier-spec"
import { type Crew, joinCrew, makeCrew, runOp } from "../shared/crew"
import { placeLocal } from "../shared/landing"
import { DECK_CENTRE_Y } from "../shared/launch"
import { makePlane, worldToShip } from "../shared/plane"
import type { PlaneTuple } from "../shared/protocol"
import { makeShip } from "../shared/ship"
import { RemotePlanes } from "../src/flight/remote-planes"

function crewWithPilot(): { crew: Crew; id: number } {
  const crew = makeCrew(7)
  joinCrew(crew, 1, "ada", 0)
  joinCrew(crew, 2, "bo", 0) // joins ada's ship as a pilot on deck
  runOp(crew, 2, "hornet", 0) // and launches from SHIP OPERATIONS
  return { crew, id: 2 }
}

const flying = (t: number, x: number, vx: number): PlaneTuple => [t, 1, x, 300, 0, 0, 0, 0, 1, vx, 0, 0, 0.8, 0, 0, 0, 0]
const onDeck = (t: number, z: number): PlaneTuple => [t, 0, z, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0]

describe("remote jets", () => {
  test("a catapult run is placed on this client's copy of the carrier", () => {
    const { crew, id } = crewWithPilot()
    const r = new RemotePlanes()
    const ship = Object.assign(makeShip(500, -200, 1.1), { heave: 1.2, pitch: 0.02, roll: -0.03 })
    r.sync(new Map([[id, onDeck(10, 40)]]), crew)
    r.sync(new Map([[id, onDeck(10.05, 44)]]), crew)
    const poses = [...r.poses(10.025 + 0.12, () => ship)]
    expect(poses.length).toBe(1)
    const p = poses[0]![1]
    const l = worldToShip(ship, p.x, p.y, p.z)
    expect(l[0]).toBeCloseTo(CENTERLINE_X, 6)
    expect(l[1]).toBeCloseTo(DECK_CENTRE_Y, 6)
    expect(l[2]).toBeCloseTo(42, 6)
  })

  test("flying jets interpolate between relayed poses and drop when the slot is freed", () => {
    const { crew, id } = crewWithPilot()
    const r = new RemotePlanes()
    r.sync(new Map([[id, flying(5, 0, 100)]]), crew)
    r.sync(new Map([[id, flying(5.05, 5, 100)]]), crew)
    const [[, p]] = [...r.poses(5.025 + 0.12, () => null)]
    expect(p.x).toBeCloseTo(2.5, 6)
    // A crashed jet isn't drawn.
    r.sync(new Map([[id, [6, 2, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0] as PlaneTuple]]), crew)
    expect([...r.poses(6.2, () => null)].length).toBe(0)
    // Recovered: gone.
    crew.players.find((x) => x.id === id)!.plane = -1
    r.sync(new Map([[id, flying(7, 0, 100)]]), crew)
    expect(r.jets.size).toBe(0)
  })

  test("a landing jet is placed by its ship-local pose on this client's copy of the carrier", () => {
    const { crew, id } = crewWithPilot()
    const r = new RemotePlanes()
    const ship = Object.assign(makeShip(-800, 300, 2.2), { heave: -0.8, pitch: -0.015, roll: 0.02 })
    const land = (t: number, z: number): PlaneTuple => [t, 3, CENTERLINE_X, DECK_CENTRE_Y, z, 0, 0.02, 0, 0, 0, 0, 0, 0.2, 0, 1, 0, 0]
    r.sync(new Map([[id, land(20, -100)]]), crew)
    r.sync(new Map([[id, land(20.05, -97)]]), crew)
    const [[, p]] = [...r.poses(20.025 + 0.12, () => ship)]
    const want = placeLocal(ship, CENTERLINE_X, DECK_CENTRE_Y, -98.5, 0, 0.02, 0, makePlane())
    expect(p.x).toBeCloseTo(want.x, 6)
    expect(p.y).toBeCloseTo(want.y, 6)
    expect(p.z).toBeCloseTo(want.z, 6)
    expect(p.hook).toBe(1)
    const l = worldToShip(ship, p.x, p.y, p.z)
    expect(l[1]).toBeCloseTo(DECK_CENTRE_Y, 6)
  })
})
