import { describe, expect, test } from "bun:test"
import { CREW, type Crew, joinCrew, makeCrew, playerOf, recover, runOp, shipOf } from "../shared/crew"
import { add } from "./crew-helpers"
import { OPS, isOpId, makeSlots, opById, opError, playerVehicle, readySlot, shipOps, slotVehicle, slotsOf } from "../shared/ops"

const T = 1_000_000
const HORNET = opById("hornet")!
const F35 = opById("f35")!

/** One ship: p1 at the helm, p2, p4 and p6 pilots on deck (p3 and p5 are the other team). */
function ship(): Crew {
  const c = makeCrew(3)
  joinCrew(c, 1, "p1", T)
  for (const id of [2, 4, 6]) add(c, id, playerOf(c, 1)!.ship, "pilot", T)
  for (const id of [3, 5]) joinCrew(c, id, `p${id}`, T)
  return c
}
const state = (c: Crew, id: number, op: string, now: number) => shipOps(c, id, now)!.find((v) => v.op.id === op)!

describe("the catalogue", () => {
  test("TAKE HELM, LAUNCH HORNET (two per ship), LAUNCH F-35C (one per ship, a longer recharge), LAUNCH BOAT, then the guns", () => {
    expect(OPS.map((o) => o.id)).toEqual(["helm", "hornet", "f35", "boat", "ciws-port", "ciws-stbd", "sam-port", "sam-stbd", "gun-5in"])
    expect(opById("boat")).toMatchObject({ label: "LAUNCH BOAT", kind: "vehicle", boat: true, cap: 1, recharge: 40 })
    expect(F35).toMatchObject({ label: "LAUNCH F-35C", kind: "vehicle", vehicle: "f35", cap: 1 })
    expect(F35.recharge).toBeGreaterThan(HORNET.recharge)
    expect(isOpId("f35")).toBe(true)
    expect(HORNET).toMatchObject({ kind: "vehicle", vehicle: "hornet", cap: 2 })
    expect(HORNET.recharge).toBeGreaterThan(0)
    expect(CREW.aircraft).toBe(HORNET.cap)
    expect(CREW.recharge).toBe(HORNET.recharge * 1000)
    expect(isOpId("hornet")).toBe(true)
    expect(isOpId("submarine")).toBe(false)
  })

  test("every ship gets cap slots per vehicle operation, tagged with it", () => {
    const slots = makeSlots()
    const vehicles = OPS.filter((o) => o.kind === "vehicle")
    expect(slots).toHaveLength(vehicles.reduce((n, o) => n + o.cap, 0))
    for (const o of vehicles) expect(slots.filter((s) => s.op === o.id)).toHaveLength(o.cap)
    expect(slots.every((s) => s.pilot === null && s.readyAt === 0)).toBe(true)
    const c = ship()
    const s = shipOf(c, playerOf(c, 1)!.ship)!
    expect(slotsOf(s, "hornet").map((x) => x.i)).toEqual([0, 1])
    expect(readySlot(s, "hornet", T)).toBe(0)
  })
})

describe("the menu's view", () => {
  test("nothing for a player who isn't aboard", () => {
    expect(shipOps(ship(), 99, T)).toBeNull()
  })

  test("a pilot on deck: helm in use, Hornets available", () => {
    const c = ship()
    const helm = state(c, 2, "helm", T)
    expect(helm).toMatchObject({ state: "in-use", reason: "helm-taken", slots: [{ player: 1, readyIn: 0 }] })
    expect(state(c, 2, "hornet", T)).toMatchObject({ state: "available", reason: null, readyIn: 0 })
    // The helm sees the helm as theirs.
    expect(state(c, 1, "helm", T)).toMatchObject({ state: "active", reason: "at-helm" })
    expect(state(c, 1, "hornet", T).state).toBe("available")
  })

  test("in use, recharging with a countdown, then available again", () => {
    const c = ship()
    runOp(c, 2, "hornet", T)
    runOp(c, 4, "hornet", T)
    expect(state(c, 6, "hornet", T)).toMatchObject({ state: "in-use", reason: "in-use", slots: [{ player: 2 }, { player: 4 }] })
    // A pilot in the air sees their slot as theirs and everything read-only.
    expect(state(c, 2, "hornet", T).state).toBe("active")
    expect(state(c, 2, "helm", T)).toMatchObject({ state: "unavailable", reason: "flying" })
    recover(c, 2, "crashed", T + 1000)
    const v = state(c, 6, "hornet", T + 1000)
    expect(v).toMatchObject({ state: "recharging", reason: "recharging", readyIn: CREW.recharge })
    expect(v.slots[0]).toEqual({ player: null, readyIn: CREW.recharge })
    expect(state(c, 6, "hornet", T + 1000 + CREW.recharge - 1500).readyIn).toBe(1500)
    expect(opError(c, 6, "hornet", T + 1000 + CREW.recharge - 1)).toBe("recharging")
    expect(state(c, 6, "hornet", T + 1000 + CREW.recharge)).toMatchObject({ state: "available", readyIn: 0 })
    expect(runOp(c, 6, "hornet", T + 1000 + CREW.recharge).error).toBeUndefined()
  })

  test("a jet that lands frees its slot without a recharge", () => {
    const c = ship()
    runOp(c, 2, "hornet", T)
    runOp(c, 4, "hornet", T)
    recover(c, 4, "landed", T + 5)
    expect(state(c, 6, "hornet", T + 5).state).toBe("available")
  })

  test("the helm and the pilots see the same operations; an unknown one is refused", () => {
    const c = ship()
    expect(opError(c, 1, "carrier-strike", T)).toBe("bad-op")
    expect(opError(c, 99, "helm", T)).toBe("no-player")
    expect(shipOps(c, 1, T)!.map((v) => v.op.id)).toEqual(OPS.map((o) => o.id))
  })
})

describe("Hornets and the F-35C", () => {
  test("each slot flies its own type", () => {
    const c = ship()
    const s = shipOf(c, playerOf(c, 1)!.ship)!
    expect(slotsOf(s, "f35").map((x) => x.i)).toEqual([2])
    expect(slotVehicle(s, 0)).toBe("hornet")
    expect(slotVehicle(s, 2)).toBe("f35")
    expect(slotVehicle(s, 9)).toBe("hornet")
    runOp(c, 2, "f35", T)
    runOp(c, 4, "hornet", T)
    expect(playerOf(c, 2)!.plane).toBe(2)
    expect(playerVehicle(c, 2)).toBe("f35")
    expect(playerVehicle(c, 4)).toBe("hornet")
    // One F-35C per ship.
    expect(opError(c, 6, "f35", T)).toBe("in-use")
    expect(state(c, 6, "f35", T)).toMatchObject({ state: "in-use", slots: [{ player: 2 }] })
  })

  test("they recharge independently: a lost F-35C leaves the Hornets ready, and a lost Hornet the F-35C", () => {
    const c = ship()
    runOp(c, 2, "f35", T)
    recover(c, 2, "crashed", T + 1000)
    const f35Ready = T + 1000 + F35.recharge * 1000
    expect(state(c, 6, "f35", T + 1000)).toMatchObject({ state: "recharging", readyIn: F35.recharge * 1000 })
    expect(state(c, 6, "hornet", T + 1000).state).toBe("available")
    runOp(c, 4, "hornet", T + 2000)
    recover(c, 4, "crashed", T + 3000)
    const s = shipOf(c, playerOf(c, 1)!.ship)!
    expect(slotsOf(s, "hornet").map(({ a }) => a.readyAt)).toEqual([T + 3000 + HORNET.recharge * 1000, 0])
    // The F-35C's slot keeps its own, longer countdown; Hornets keep launching from the other slot meanwhile.
    expect(opError(c, 6, "f35", f35Ready - 1)).toBe("recharging")
    expect(runOp(c, 6, "hornet", T + 3000).error).toBeUndefined()
    expect(runOp(c, 4, "f35", f35Ready).events).toEqual([{ k: "launch", player: 4, ship: s.id, slot: 2 }])
  })
})
