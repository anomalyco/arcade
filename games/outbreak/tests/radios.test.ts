import { describe, expect, test } from "bun:test"
import { TICK_DT } from "../shared/clock"
import { CoopSim, hashSimState, type SurvivorSlot } from "../shared/coop-sim"
import { propShape } from "../shared/map"
import { DEFAULT_RADIO_TUNING, radioBatteryLeft, radioSites, radioState, radioStoreId, type RadioTuning } from "../shared/radios/radios"
import type { RadiosState } from "../shared/radios/runtime"
import { resolveSessionTuning, type Command } from "../shared/session"

const R = DEFAULT_RADIO_TUNING
const idle = (aim = 0): Command => ({ mx: 0, my: 0, aim, interact: false })
const ticks = (seconds: number) => Math.ceil(seconds / TICK_DT) + 2

type Pose = { x: number; y: number; aim: number }

/** Ash's radio, on the corner of its living-room coffee table, and a spot in front of it facing it. */
const ASH = radioStoreId("ash")
const BEFORE_ASH: Pose = { x: 24.5, y: 34.5, aim: -Math.PI / 2 }

function room(poses: Record<string, Pose>, tuning: Partial<RadioTuning> = {}) {
  const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
  sim.hour = 22
  const slots: SurvivorSlot[] = Object.entries(poses).map(([id, pose], i) => {
    const slot = sim.addSurvivor(id, i)
    Object.assign(slot.survivor, pose)
    return slot
  })
  sim.rebuildSolids()
  const settings = { discovery: { ...R, ...tuning } } as never
  const tick = (cmds: Partial<Record<string, Partial<Command>>> = {}, n = 1) => {
    for (let k = 0; k < n; k++) {
      for (const s of sim.slots) sim.stepSurvivor(s, { ...idle(s.survivor.aim), ...cmds[s.id] }, TICK_DT, settings)
      sim.stepWorld(TICK_DT, 0, settings)
    }
  }
  const heard: { kind: string; x: number; y: number; radius: number }[] = []
  const emit = sim.ai.emitNoise.bind(sim.ai)
  sim.ai.emitNoise = (x, y, radius, kind, ...rest) => {
    heard.push({ kind, x, y, radius })
    return emit(x, y, radius, kind, ...rest)
  }
  const radio = () => sim.getFeatureState<RadiosState>("radios")!.sites.find((s) => s.id === ASH)!
  const state = () => radioState(sim.progression.ledger.store(ASH), sim.time)
  return { sim, slots, tick, slot: (id: string) => sim.slot(id)!, radio, state, noises: (kind: string) => heard.filter((e) => e.kind === kind), ledger: sim.progression.ledger, settings }
}

describe("where radios are", () => {
  test("both classic houses keep one on the living-room coffee table, not in the shops", () => {
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    const sites = radioSites(sim.town)
    expect(sites.map((s) => s.buildingId)).toEqual(["ash", "elm"])
    for (const s of sites) {
      const table = sim.town.props.find((p) => p.kind === "coffee" && propShape(p)!.rect[0] <= s.x && s.x <= propShape(p)!.rect[2] && propShape(p)!.rect[1] <= s.y && s.y <= propShape(p)!.rect[3])
      expect(table).toBeDefined()
      expect(s.z).toBeCloseTo(0.46)
    }
  })

  test("streamed homes: most have one, fixed per building, the same in two rooms, and the feature tracks them", () => {
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 }, "procedural")
    const again = new CoopSim(7, 7, 0.22, { zombieCount: 0 }, "procedural")
    const homes = sim.town.buildings.filter((b) => ["house", "ranch", "cottage", "cabin"].includes(b.archetype ?? b.kind))
    const sites = radioSites(sim.town)
    expect(sites).toEqual(radioSites(again.town))
    expect(homes.length).toBeGreaterThan(3)
    expect(sites.length).toBeGreaterThan(0)
    expect(sites.length).toBeLessThanOrEqual(homes.length)
    for (const s of sites) expect(homes.some((b) => b.id === s.buildingId)).toBe(true)
    expect(sim.getFeatureState<RadiosState>("radios")!.sites).toEqual(sites)
  })
})

describe("switching a radio on and off", () => {
  test("E switches it on; it calls the dead on a beat; E switches it off and keeps what is left of the battery", () => {
    const { tick, slot, state, noises, sim } = room({ ann: BEFORE_ASH })
    tick()
    expect(slot("ann").prompt?.kind).toBe("radio")
    expect(slot("ann").prompt?.primary.label).toBe("Switch on")
    tick({ ann: { interact: true } })
    expect(state()).toBe("playing")
    tick({}, ticks(R.radioBeat * 4))
    const bursts = noises("radio").filter((n) => n.radius === R.radioNoise)
    expect(bursts.length).toBeGreaterThanOrEqual(4)
    expect(bursts.length).toBeLessThanOrEqual(6)
    expect(slot("ann").prompt?.primary.label).toBe("Switch off")
    tick({ ann: { interact: true } })
    expect(state()).toBe("off")
    const left = radioBatteryLeft(sim.progression.ledger.store(ASH), sim.time, R)
    expect(left).toBeGreaterThan(R.radioBattery - R.radioBeat * 4 - 1)
    expect(left).toBeLessThan(R.radioBattery - R.radioBeat * 4 + 0.5)
    const before = noises("radio").length
    tick({}, ticks(3))
    expect(noises("radio").length).toBe(before)
  })

  test("its battery runs down across plays; a flat radio goes quiet and offers nothing", () => {
    const { tick, slot, state } = room({ ann: BEFORE_ASH }, { radioBattery: 5 })
    tick()
    tick({ ann: { interact: true } })
    tick({}, ticks(3))
    tick({ ann: { interact: true } })
    expect(state()).toBe("off")
    tick({}, 30)
    tick({ ann: { interact: true } })
    expect(state()).toBe("playing")
    tick({}, ticks(2.2))
    expect(state()).toBe("dead")
    expect(slot("ann").prompt?.kind).not.toBe("radio")
  })
})

describe("the dead and a playing radio", () => {
  test("one in the house hears it, walks over and knocks it down, which ends it for good", () => {
    const { sim, tick, state, slot } = room({ ann: { x: 44, y: 44, aim: 0 } })
    const site = radioSites(sim.town).find((s) => s.id === ASH)!
    const z = sim.ai.spawnZombie(sim.town, site.x + 4, site.y - 0.5, "wander")
    const st = sim.progression.ledger
    // Switched on by someone who then left.
    sim.getFeatureState<RadiosState>("radios")!
    Object.assign(slot("ann").survivor, BEFORE_ASH)
    tick()
    tick({ ann: { interact: true } })
    Object.assign(slot("ann").survivor, { x: 44, y: 44 })
    expect(state()).toBe("playing")
    let at = -1
    for (let i = 0; i < ticks(25) && state() === "playing"; i++) {
      tick()
      if (at < 0 && Math.hypot(z.x - site.x, z.y - site.y) <= R.radioReach) at = sim.time
    }
    expect(at).toBeGreaterThan(0)
    expect(state()).toBe("broken")
    expect(st.store(ASH)!.counts.broken).toBe(1)
    expect(sim.time - at).toBeGreaterThanOrEqual(R.radioBreakTime - 0.2)
  })

  test("the dead out on the street turn towards the house it plays in", () => {
    const { sim, tick, slot } = room({ ann: BEFORE_ASH })
    const site = radioSites(sim.town).find((s) => s.id === ASH)!
    const z = sim.ai.spawnZombie(sim.town, 20, 44, "wander")
    const d0 = Math.hypot(z.x - site.x, z.y - site.y)
    tick()
    tick({ ann: { interact: true } })
    Object.assign(slot("ann").survivor, { x: 70, y: 70 })
    tick({}, ticks(6))
    expect(["investigate", "search", "alert", "chase", "bash"]).toContain(z.state)
    expect(Math.hypot(z.x - site.x, z.y - site.y)).toBeLessThan(d0 - 1.5)
  })
})

describe("state", () => {
  test("a playing radio survives a snapshot, and both copies tick the same", () => {
    const { sim, tick, settings } = room({ ann: BEFORE_ASH })
    tick()
    tick({ ann: { interact: true } })
    tick({}, 30)
    const copy = CoopSim.fromSnapshot(sim.toSnapshot())
    expect(hashSimState(copy.toSnapshot())).toBe(hashSimState(sim.toSnapshot()))
    expect(radioState(copy.progression.ledger.store(ASH), copy.time)).toBe("playing")
    for (let i = 0; i < 200; i++) {
      for (const s of [sim, copy]) {
        for (const slot of s.slots) s.stepSurvivor(slot, idle(slot.survivor.aim), TICK_DT, settings)
        s.stepWorld(TICK_DT, 0, settings)
      }
    }
    expect(hashSimState(copy.toSnapshot())).toBe(hashSimState(sim.toSnapshot()))
  })

  test("its tunables ride in the Discovery settings the client already sends", () => {
    const resolved = resolveSessionTuning({ stamina: {}, discovery: { radioNoise: 9, radioBattery: 12 } } as never)
    expect(resolved.features?.radios).toMatchObject({ radioNoise: 9, radioBattery: 12, radioBeat: R.radioBeat })
    expect(resolveSessionTuning().features?.radios).toEqual(R)
  })
})
