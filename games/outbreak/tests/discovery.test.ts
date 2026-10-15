import { describe, expect, test } from "bun:test"
import { TICK_DT } from "../shared/clock"
import { CoopSim } from "../shared/coop-sim"
import { barricadeWear, packPlanks, plankHealths, plankLook, unpackPlanks } from "../shared/discovery/barricade"
import { looksReinforced } from "../shared/discovery/found"
import { decodeShared, encodeShared } from "../shared/net-protocol"
import { DEFAULT_DISCOVERY_SETTINGS } from "../src/discovery/settings"
import { lowBatteryBeam } from "../src/discovery/flashlight"
import { openContainer } from "../src/discovery/props"

const idle = { mx: 0, my: 0, aim: 0, interact: false }

describe("barricade wear (boards show their health)", () => {
  test("damage comes off the last board nailed: sound, bowed, then hanging", () => {
    expect(plankHealths(3, 1).map(plankLook)).toEqual(["flush", "flush", "flush"])
    expect(plankHealths(3, 0.5).map(plankLook)).toEqual(["flush", "bowed", "hanging"])
    expect(plankHealths(3, 0.1).map(plankLook)).toEqual(["bowed", "hanging", "hanging"])
    expect(plankHealths(2, 0.75).map(plankLook)).toEqual(["flush", "bowed"])
    // Reinforced boards (180 each) stay flush until they fall under the nominal 100.
    expect(barricadeWear(3, 540)).toBe(1)
    expect(barricadeWear(0, 0)).toBe(0)
  })

  test("planks and wear share one wire byte", () => {
    for (const [planks, hp] of [
      [0, 0],
      [1, 100],
      [2, 120],
      [3, 33],
      [3, 540],
      [2, 200],
      [3, 300],
      [2, 360],
    ] as const) {
      const back = unpackPlanks(packPlanks(planks, hp))
      expect(back.planks).toBe(planks)
      expect(Math.abs(barricadeWear(back.planks, back.hp) - barricadeWear(planks, hp))).toBeLessThan(2 / 63 + 1e-9)
      expect(looksReinforced(back.planks, back.hp)).toBe(looksReinforced(planks, hp))
    }
  })

  test("a co-op client sees the same wear the room has, after bashes and on a full snapshot", () => {
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    sim.addSurvivor("p0", 0)
    const id = "ash-south-west"
    for (let i = 0; i < 3; i++) sim.ai.addBarricadePlank(id, 100)
    const st = sim.ai.portalStates.get(id)!
    st.barricadeHp = 140
    st.lastBashTime = sim.time
    sim.revision++
    sim.stepWorld(TICK_DT, 0)
    const portals = [...sim.town.doors.map((d) => d.id), ...sim.town.windows.map((w) => w.id)]
    const i = portals.indexOf(id)
    const snap = decodeShared(encodeShared(sim, 3, new Map()), 7)
    expect(snap.planks[i]).toBe(3)
    expect(Math.abs(snap.plankHp[i]! - 140)).toBeLessThan(300 / 63)
    expect(snap.bashes.some((b) => b.portal === i && unpackPlanks(b.planks).planks === 3)).toBe(true)
    expect(plankHealths(3, barricadeWear(3, snap.plankHp[i]!)).map(plankLook)).toEqual(
      plankHealths(3, barricadeWear(3, st.barricadeHp)).map(plankLook),
    )
  })

  test("wear survives a SimState snapshot and restore, and the fork stays in step", () => {
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    const slot = sim.addSurvivor("p0", 0)
    for (let i = 0; i < 3; i++) sim.ai.addBarricadePlank("ash-front", 100)
    sim.ai.portalStates.get("ash-front")!.barricadeHp = 110
    const fork = CoopSim.fromSnapshot(JSON.parse(JSON.stringify(sim.toSnapshot())))
    for (let i = 0; i < 30; i++) {
      sim.stepSurvivor(slot, idle, TICK_DT)
      sim.stepWorld(TICK_DT, 0)
      fork.stepSurvivor(fork.slot("p0")!, idle, TICK_DT)
      fork.stepWorld(TICK_DT, 0)
    }
    expect(fork.ai.portalStates.get("ash-front")!.barricadeHp).toBe(110)
    expect(JSON.stringify(fork.toSnapshot().ai.portalStates)).toBe(JSON.stringify(sim.toSnapshot().ai.portalStates))
  })
})

describe("low battery in the beam", () => {
  const fl = { flashlightCone: 56, flashlightRange: 19, flashlightWarmth: 0.92, flashlightFlicker: 0.28 }
  test("a charged beam is as tuned; a dying one narrows, shortens and turns amber", () => {
    const full = lowBatteryBeam(fl, 0.9, false, DEFAULT_DISCOVERY_SETTINGS)
    expect(full.low).toBe(0)
    expect(full.cone).toBe(56)
    expect(full.range).toBe(19)
    const low = lowBatteryBeam(fl, 0.03, false, DEFAULT_DISCOVERY_SETTINGS)
    expect(low.cone).toBeLessThan(56 * 0.8)
    expect(low.range).toBeLessThan(19 * 0.75)
    expect(low.color[2]).toBeLessThan(full.color[2] * 0.6)
    const off = lowBatteryBeam(fl, 0.03, false, { ...DEFAULT_DISCOVERY_SETTINGS, discoveryLowBeam: false })
    expect(off.cone).toBe(56)
  })
})

describe("searched containers open", () => {
  test("each container kind opens towards its front and lays its contents inside its reach", () => {
    const dresser = openContainer({ kind: "dresser", rect: [10, 10, 12.2, 10.7], x: 11.1, y: 10.35 }, 1.1)
    expect(dresser.fixtures[0]!.model).toBe("drawer")
    expect(dresser.shelf.z).toBeGreaterThan(10.7)
    const counter = openContainer({ kind: "counter", rect: [10, 10, 10.8, 12.4], x: 10.4, y: 11.2 }, 1.02)
    expect(counter.fixtures[0]!.model).toBe("door")
    expect(counter.shelf.y).toBe(1.02)
    const shelf = openContainer({ kind: "shelf", rect: [10, 10, 11.7, 10.8], x: 10.85, y: 10.4 }, 1.8)
    expect(shelf.fixtures).toEqual([])
  })
})
