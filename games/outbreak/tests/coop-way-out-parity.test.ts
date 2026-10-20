import { expect, test } from "bun:test"
import { planOf, nearDawnHour } from "../shared/way-out/runtime"
import { roadblocksOf } from "../shared/way-out/roadblocks"
import { wayOutOf } from "../shared/way-out/state"
import { DEFAULT_WAY_OUT_TUNING as T } from "../shared/way-out/tuning"
import { featureRoom } from "./coop-feature-room"

for (const seat of [0, 1]) {
  test(`seat ${seat}: clues, stand, escape, late join use the room's goal state`, () => {
    const r = featureRoom()
    try {
      const actor = r.clients[seat]!
      const plan = planOf(r.core.sim, T)
      r.place(actor, plan.sign.x + 0.9, plan.sign.y, Math.PI)
      r.act(actor, { interact: true })
      r.tick(12)
      expect(wayOutOf(r.core.sim.progression.ledger)?.tier).toBe(2)
      r.ledgerParity(["wayout"])
      r.place(actor, plan.soldier.x + 0.8, plan.soldier.y, Math.PI)
      r.act(actor, { interact: true })
      r.tick(12)
      expect(wayOutOf(r.core.sim.progression.ledger)?.tier).toBe(3)
      r.ledgerParity(["wayout"])
      r.place(actor, plan.signal.x + 0.6, plan.signal.y, Math.PI)
      r.act(actor, { interact: true })
      r.tick(12)
      expect(wayOutOf(r.core.sim.progression.ledger)?.signalled).toBe(true)
      r.ledgerParity(["wayout"])
      r.join()
      r.tick(190)
      expect(wayOutOf(r.core.sim.progression.ledger)?.wave).toBeGreaterThan(0)
      r.ledgerParity(["wayout"])
      r.core.sim.hour = 22
      r.tick(1)
      r.core.sim.hour = nearDawnHour() + 0.12
      r.tick(30)
      expect(wayOutOf(r.core.sim.progression.ledger)?.won).toBe(true)
      r.ledgerParity(["wayout"])
      for (const c of r.clients) expect(wayOutOf(c.sim.progression.ledger)).toEqual(wayOutOf(r.core.sim.progression.ledger))
    } finally { r.close() }
  })

  test(`seat ${seat}: dynamite clears the roadblock for client car prediction as well as the room`, () => {
    const r = featureRoom()
    try {
      const actor = r.clients[seat]!
      const block = roadblocksOf(planOf(r.core.sim, T), T)[0]!
      const has = (rects: readonly (readonly number[])[]) => rects.some((x) => x.every((v, i) => v === block.car[i]))
      r.place(actor, block.x - block.dx * 10, block.y - block.dy * 10, Math.atan2(block.dy, block.dx))
      r.hold(actor, "dynamite")
      expect(has(r.core.sim.vehicleSolids)).toBe(true)
      r.act(actor, { fire: true })
      r.tick(180)
      expect(wayOutOf(r.core.sim.progression.ledger)?.cleared[block.index]).toBe(1)
      expect(has(r.core.sim.vehicleSolids)).toBe(false)
      r.ledgerParity(["wayout"])
      for (const c of r.clients) expect(has(c.sim.vehicleSolids)).toBe(false)
      r.join()
      r.tick(12)
      r.flush()
      for (const c of r.clients) expect(has(c.sim.vehicleSolids)).toBe(false)
    } finally { r.close() }
  })

  test(`seat ${seat}: hotwire, battery repair and gas cans reach both clients`, () => {
    const r = featureRoom()
    try {
      const actor = r.clients[seat]!
      const v = r.core.sim.vehicles.spawnVehicle("sedan", 44, 70, Math.PI / 2, { fuel: 0, hasKeys: false, hasBattery: false })
      // A duffel (9×4) so the toolbox, car battery and gas can all fit the case.
      r.core.sim.progression.ledger.apply({ kind: "grant", actor: actor.id, item: "duffel", count: 1 })
      r.core.sim.progression.syncCase(actor.id)
      for (const item of ["toolbox", "car-battery", "fuel"]) r.core.sim.progression.ledger.apply({ kind: "grant", actor: actor.id, item, count: 1 })
      r.place(actor, 41.8, 70)
      r.act(actor, { interactHeld: true }, Math.ceil((T.hotwireTime + 0.5) * 60))
      expect(v.hasKeys).toBe(true)
      r.act(actor, { interact: true })
      r.tick(12)
      expect(v.hasBattery).toBe(true)
      expect(v.fuel).toBeGreaterThan(0)
      r.ledgerParity(["wayout"])
      r.join()
      r.tick(12)
      r.flush()
      for (const c of r.clients) {
        const got = c.sim.vehicles.list.find((c) => c.id === v.id)!
        expect(got).toBeDefined()
        expect([got.hasKeys, got.hasBattery]).toEqual([true, true])
        expect(got.fuel).toBeCloseTo(v.fuel, 0)
      }
    } finally { r.close() }
  })

}

// Co-op currently accepts only seed 7. Gate cutting cannot be exercised there: its route has no gates.
test("the supported co-op town has no chained gate (New town design gap)", () => {
  const r = featureRoom()
  try { expect(roadblocksOf(planOf(r.core.sim, T), T).some((b) => b.kind === "gate")).toBe(false) }
  finally { r.close() }
})
