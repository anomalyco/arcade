import { expect, test } from "bun:test"
import { CoopSim } from "../shared/coop-sim"
import { noteSites, policeSites, roadSites } from "../shared/way-out/clues"
import { outbreakWayOutSharedFeature } from "../shared/way-out/index"
import { clueSites, planOf, seedOf, type WayOutState } from "../shared/way-out/runtime"

test("chunk sync refreshes clues when the middle buildings and furniture change at equal counts", () => {
  const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0, directorPacing: 0 })
  const state = sim.getFeatureState<WayOutState>("wayOut")!
  state.tuning = { ...state.tuning, noteShare: 1 }
  const plan = planOf(sim, state.tuning)
  const first = clueSites(sim, state, plan)
  expect(clueSites(sim, state, plan)).toBe(first)

  const buildings = sim.town.buildings
  expect(buildings.length).toBeGreaterThan(2)
  sim.town.buildings = buildings.map((b, i) => i === 1 ? { ...b, id: `${b.id}:replacement`, kind: "house", archetype: "house" } : b)
  sim.town.props = sim.town.props.map((p) => ({ ...p, x: p.x + 0.5 }))
  // The streaming system calls this hook after replacing the loaded town geometry.
  outbreakWayOutSharedFeature.onChunkSync!(sim, state)
  const expected = [...noteSites(sim.town, seedOf(sim), 1), ...policeSites(sim.town), ...roadSites(plan)]
  expect(expected).not.toEqual(first)
  const refreshed = clueSites(sim, state, plan)
  expect(refreshed).toEqual(expected)
  expect(clueSites(sim, state, plan)).toBe(refreshed)
})
