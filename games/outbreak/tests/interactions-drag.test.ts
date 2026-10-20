import { describe, expect, test } from "bun:test"
import { TICK_DT } from "../shared/clock"
import { CoopSim, type SurvivorSlot } from "../shared/coop-sim"
import type { InteractionsState } from "../shared/interactions/index"
import { furnitureSites, FURNITURE_KINDS, furnRect, type FurnitureKind } from "../shared/interactions/furniture"
import { haulStoreId } from "../shared/interactions/drag"
import { DEFAULT_INTERACTIONS_TUNING, type InteractionsTuning } from "../shared/interactions/tuning"
import { DEFAULT_DEATH_TUNING } from "../shared/death/rules"
import { solidRects } from "../shared/map"
import type { Command } from "../shared/session"

const idle = (aim = 0): Command => ({ mx: 0, my: 0, aim, interact: false })
const ticks = (seconds: number) => Math.ceil(seconds / TICK_DT)

function room(ids: string[], tuning: Partial<InteractionsTuning> = {}) {
  const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
  sim.hour = 12
  for (const [i, id] of ids.entries()) sim.addSurvivor(id, i)
  sim.rebuildSolids()
  const settings = { interactions: { ...DEFAULT_INTERACTIONS_TUNING, ...tuning }, death: { ...DEFAULT_DEATH_TUNING, deathMode: 1 } } as never
  const tick = (cmds: Partial<Record<string, Partial<Command>>> = {}, n = 1) => {
    for (let k = 0; k < n; k++) {
      for (const s of sim.slots) sim.stepSurvivor(s, { ...idle(s.survivor.aim), ...cmds[s.id] }, TICK_DT, settings)
      sim.stepWorld(TICK_DT, 0, settings)
    }
  }
  const state = () => sim.getFeatureState<InteractionsState>("interactions")!
  const pieces = () => [...sim.progression.ledger.stores.values()].filter((s) => s.id.startsWith("furn:"))
  const place = (slot: SurvivorSlot, x: number, y: number, aim: number) => Object.assign(slot.survivor, { x, y, aim })
  tick()
  return { sim, tick, state, pieces, place, slot: (id: string) => sim.slot(id)! }
}

/** Puts a loose piece of `kind` at `(x, y)` (replacing whatever the house had as its first). */
function putPiece(sim: CoopSim, kind: FurnitureKind, x: number, y: number) {
  const st = [...sim.progression.ledger.stores.values()].find((s) => s.id.startsWith("furn:ash:"))!
  st.at = { x, y }
  st.counts = { k: FURNITURE_KINDS.indexOf(kind), yaw: 0 }
  st.rev = ++sim.progression.ledger.rev
  return st
}

describe("loose furniture", () => {
  test("houses have loose pieces on open floor, seeded from the town alone", () => {
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    const solids = solidRects(sim.town)
    const houses = sim.town.buildings.filter((b) => b.kind === "house")
    const sites = houses.flatMap((b) => furnitureSites(sim.town, b, 2, solids))
    expect(sites.length).toBeGreaterThan(houses.length)
    expect(houses.flatMap((b) => furnitureSites(sim.town, b, 2, solids))).toEqual(sites)
    for (const s of sites) {
      const r = furnRect(s.x, s.y, s.kind, s.yaw)
      expect(solids.some((o) => r[0] < o[2] && r[2] > o[0] && r[1] < o[3] && r[3] > o[1])).toBe(false)
    }
    expect(houses.flatMap((b) => furnitureSites(sim.town, b, 0, solids))).toEqual([])
  })

  test("E takes hold of a dresser: it goes in front, slows you, and E sets it down", () => {
    const { sim, tick, pieces, place, slot } = room(["ann"])
    expect(pieces().length).toBeGreaterThan(0)
    const st = putPiece(sim, "dresser", 27, 29)
    const ann = slot("ann")
    place(ann, 27, 30, -Math.PI / 2)
    tick()
    expect(ann.prompt?.kind).toBe("furniture")
    expect(ann.prompt?.primary.label).toBe("Drag")
    tick({ ann: { interact: true, aim: -Math.PI / 2 } })
    expect(st.counts.drag).toBe(1)
    expect(st.owner).toBe("ann")
    // Walk east for a second: slower than walking free, the dresser kept in front.
    const x0 = ann.survivor.x
    tick({ ann: { mx: 1, my: 0, aim: 0 } }, ticks(1))
    const dragged = ann.survivor.x - x0
    expect(st.at!.x).toBeGreaterThan(ann.survivor.x + 0.4)
    tick({ ann: { interact: true, aim: 0 } })
    expect(st.counts.drag).toBe(0)
    // Free again, out on the street: a full walking pace.
    place(ann, 44, 44, 0)
    tick({ ann: { mx: 1, my: 0, aim: 0 } }, ticks(1))
    expect(ann.survivor.x - 44).toBeGreaterThan(dragged * 1.4)
  })

  test("set down against a door it braces it: the door shuts and the crowd counts it barricaded until bashed through", () => {
    const { sim, tick, place, slot, state } = room(["ann"])
    const door = sim.town.doors.find((d) => d.id === "ash-front")!
    const cx = (door.rect[0] + door.rect[2]) / 2
    const st = putPiece(sim, "dresser", cx, door.rect[1] - 1.5)
    const ann = slot("ann")
    place(ann, cx, door.rect[1] - 2.3, Math.PI / 2)
    tick({ ann: { interact: true, aim: Math.PI / 2 } })
    expect(st.counts.drag).toBe(1)
    tick({ ann: { mx: 0, my: 1, aim: Math.PI / 2 } }, ticks(0.6))
    tick()
    expect(ann.prompt?.primary.label).toBe("Brace")
    door.open = true
    tick({ ann: { interact: true, aim: Math.PI / 2 } })
    expect(st.counts.br).toBe(1)
    expect(door.open).toBe(false)
    const holds = sim.ai.portalHolds!
    expect(holds.held(door.id)).toBe(true)
    sim.ai.rebuildTopology(sim.town)
    expect((sim.ai as unknown as { portals: { id: string; barricadePlanks: number }[] }).portals.find((p) => p.id === door.id)!.barricadePlanks).toBe(1)
    expect(state().drag.braced[st.id]).toBe(door.id)
    // Bashed: it holds while it has hit points, then is shoved into the room and falls over.
    expect(holds.absorb(door.id, 100, sim.time)).toBe(0)
    expect(holds.held(door.id)).toBe(true)
    holds.absorb(door.id, 1000, sim.time)
    expect(holds.held(door.id)).toBe(false)
    expect(st.counts.down).toBe(1)
    expect(st.at!.y).toBeLessThan(door.rect[1] - 0.6)
  })

  test("Today (furniture off): no loose pieces are put out", () => {
    const { pieces } = room(["ann"], { furniture: 0 })
    expect(pieces().length).toBe(0)
  })
})

describe("hauling a downed teammate", () => {
  test("tap E drags them along behind you, slowly; tap again lets go; hold still revives", () => {
    const { sim, tick, place, slot } = room(["ann", "bo"])
    const ann = slot("ann")
    const bo = slot("bo")
    place(ann, 44, 44, 0)
    place(bo, 45, 44, 0)
    bo.survivor.health = 0
    tick({}, 2)
    expect(ann.prompt?.kind).toBe("downed")
    expect(ann.prompt?.primary.label).toBe("Drag")
    tick({ ann: { interact: true, aim: Math.PI } })
    tick({ ann: { aim: Math.PI } }, 2)
    expect(sim.progression.ledger.store(haulStoreId(ann.index))?.counts.who).toBe(bo.index + 1)
    const x0 = ann.survivor.x
    tick({ ann: { mx: -1, my: 0, aim: Math.PI } }, ticks(1))
    expect(x0 - ann.survivor.x).toBeLessThan(3)
    expect(x0 - ann.survivor.x).toBeGreaterThan(0.8)
    expect(bo.survivor.x).toBeGreaterThan(ann.survivor.x + 0.4)
    expect(Math.abs(bo.survivor.x - ann.survivor.x)).toBeLessThan(1.4)
    tick({ ann: { interact: true, aim: 0 } })
    tick({}, 2)
    expect(sim.progression.ledger.store(haulStoreId(ann.index))?.counts.who).toBe(0)
  })
})
