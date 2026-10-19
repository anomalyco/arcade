import { describe, expect, test } from "bun:test"
import { TICK_DT } from "../shared/clock"
import { CoopSim, type SurvivorSlot } from "../shared/coop-sim"
import { bodySites, DEFAULT_BODIES_TUNING, type BodiesTuning } from "../shared/bodies/bodies"
import { DEFAULT_DOG_TUNING, dogSites, dogState, type DogTuning } from "../shared/dogs/dogs"
import { DEFAULT_FLARE_TUNING, flareBurning, type FlareTuning } from "../shared/flares/flares"
import { pullToward } from "../shared/flares/runtime"
import { DEFAULT_LIGHTS_TUNING, lampHeads, lampOnShot, lampStoreId, porchSwitch, type LightsTuning } from "../shared/lights-out/lights"
import { samplePointLightLevel } from "../shared/ai"
import type { Lamp } from "../shared/map"
import { sightRects } from "../shared/map"
import type { Command } from "../shared/session"

type Tuning = Partial<LightsTuning & FlareTuning & BodiesTuning & DogTuning>
type Pose = { x: number; y: number; aim: number }

const idle = (aim = 0): Command => ({ mx: 0, my: 0, aim, interact: false })
const ticks = (seconds: number) => Math.ceil(seconds / TICK_DT) + 2

function room(poses: Record<string, Pose>, tuning: Tuning = {}, zombies = 0) {
  const sim = new CoopSim(7, 7, 0.22, { zombieCount: zombies })
  sim.hour = 22
  for (const [i, [id, pose]] of Object.entries(poses).entries()) Object.assign(sim.addSurvivor(id, i).survivor, pose)
  sim.rebuildSolids()
  const settings = { discovery: { ...DEFAULT_LIGHTS_TUNING, ...DEFAULT_FLARE_TUNING, ...DEFAULT_BODIES_TUNING, ...DEFAULT_DOG_TUNING, ...tuning } } as never
  const tick = (cmds: Partial<Record<string, Partial<Command>>> = {}, n = 1) => {
    for (let k = 0; k < n; k++) {
      for (const s of sim.slots) sim.stepSurvivor(s, { ...idle(s.survivor.aim), ...cmds[s.id] }, TICK_DT, settings)
      sim.stepWorld(TICK_DT, 0, settings)
    }
  }
  const heard: { kind: string; radius: number }[] = []
  const emit = sim.ai.emitNoise.bind(sim.ai)
  sim.ai.emitNoise = (x, y, radius, kind, ...rest) => {
    heard.push({ kind, radius })
    return emit(x, y, radius, kind, ...rest)
  }
  const ledger = sim.progression.ledger
  const hold = (slot: SurvivorSlot, item: string, count = 1) => {
    if (count) ledger.apply({ kind: "grant", actor: slot.id, item, count })
    const i = sim.progression.hotbar(slot.id)?.slots.findIndex((s) => s?.item === item) ?? -1
    if (i >= 0) ledger.apply({ kind: "select", actor: slot.id, slot: i })
    sim.progression.project(slot)
  }
  return { sim, tick, ledger, slot: (id: string) => sim.slot(id)!, hold, noises: (kind: string) => heard.filter((e) => e.kind === kind) }
}

/** The street lamp nearest Ash's front, and Ash's porch light. */
function ashLamps(sim: CoopSim): { street: Lamp; porch: Lamp } {
  const ash = sim.town.buildings.find((b) => b.id === "ash")!
  const cx = (ash.rect[0] + ash.rect[2]) / 2
  const d = (l: Lamp) => Math.hypot(l.x - cx, l.y - ash.rect[3])
  const of = (kind: string) => sim.town.lamps.filter((l) => l.kind === kind).sort((a, b) => d(a) - d(b))[0]!
  return { street: of("street"), porch: of("porch") }
}

describe("Lights Out", () => {
  test("a pistol shot past a street lamp's head puts it out for good: glass on the ground, a pop, and darker under it", () => {
    const probe = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    const { street } = ashLamps(probe)
    const head = lampHeads(street)[0]!
    const from = { x: head.x - 3, y: head.y + 3 }
    const { sim, tick, ledger, slot, hold, noises } = room({ ann: { ...from, aim: Math.atan2(head.y - from.y, head.x - from.x) } })
    hold(slot("ann"), "pistol", 0)
    tick()
    const lamp = sim.town.lamps.find((l) => lampStoreId(l) === lampStoreId(street))!
    const lit = samplePointLightLevel(sim.town, sim.hour, lamp.x + 0.5, lamp.y + 0.3)
    expect(lamp.power).toBeGreaterThan(0)
    tick({ ann: { fire: true } })
    tick()
    expect(ledger.store(lampStoreId(street))?.counts.broken).toBe(1)
    expect(ledger.store(`glass:${lampStoreId(street)}`)).toBeDefined()
    expect(noises("glass").length).toBe(1)
    expect(lamp.power).toBe(0)
    expect(samplePointLightLevel(sim.town, sim.hour, lamp.x + 0.5, lamp.y + 0.3)).toBeLessThan(lit)
    // A second shot finds nothing left to break.
    tick({}, ticks(0.6))
    tick({ ann: { fire: true } })
    tick()
    expect(noises("glass").length).toBe(1)
  })

  test("a shot stops at what it hits: a lamp behind a wall is safe", () => {
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    const { street } = ashLamps(sim)
    const head = lampHeads(street)[0]!
    expect(lampOnShot(sim.town, head.x - 4, head.y, head.x + 4, head.y, 0.5, () => false)?.lamp).toBe(street)
    expect(lampOnShot(sim.town, head.x - 4, head.y, head.x - 2, head.y, 0.5, () => false)).toBeNull()
    expect(lampOnShot(sim.town, head.x - 4, head.y + 2, head.x + 4, head.y + 2, 0.5, () => false)).toBeNull()
  })

  test("a porch light's switch: E on the step switches it off and on again; facing the door keeps the door's prompt", () => {
    const probe = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    const sw = porchSwitch(ashLamps(probe).porch)
    const { sim, tick, ledger, slot } = room({ ann: { x: sw.x - 0.1, y: sw.y + 0.7, aim: -Math.PI / 2 } })
    tick()
    const porch = sim.town.lamps.find((l) => lampStoreId(l) === lampStoreId(ashLamps(sim).porch))!
    const power = porch.power
    expect(slot("ann").prompt?.kind).toBe("lamp")
    expect(slot("ann").prompt?.primary.label).toBe("Switch off")
    tick({ ann: { interact: true } })
    expect(ledger.store(lampStoreId(porch))?.counts.off).toBe(1)
    expect(porch.power).toBe(0)
    tick()
    expect(slot("ann").prompt?.primary.label).toBe("Switch on")
    tick({ ann: { interact: true } })
    expect(ledger.store(lampStoreId(porch))?.counts.off).toBe(0)
    expect(porch.power).toBe(power)
    // Turned to face the front door, the door has the prompt.
    const door = sim.town.doors.find((d) => d.id === "ash-front")!
    const dx = (door.rect[0] + door.rect[2]) / 2
    const dy = (door.rect[1] + door.rect[3]) / 2
    Object.assign(slot("ann").survivor, { x: dx, y: dy + 0.9, aim: -Math.PI / 2 })
    tick()
    expect(slot("ann").prompt?.kind).toBe("door")
  })

  test("a dark lamp stays dark in a fork of the sim", () => {
    const { sim, ledger } = room({ ann: { x: 30, y: 40, aim: 0 } })
    const { street } = ashLamps(sim)
    ledger.createStore({ id: lampStoreId(street), mode: "counters", scope: "shared", at: { x: street.x, y: street.y }, initial: { broken: 1, off: 0 } })
    sim.stepWorld(TICK_DT, 0, {} as never)
    const fork = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    fork.restoreSnapshot(sim.toSnapshot())
    fork.stepWorld(TICK_DT, 0, {} as never)
    expect(fork.town.lamps.find((l) => lampStoreId(l) === lampStoreId(street))!.power).toBe(0)
  })
})

describe("road flares", () => {
  test("fire with a flare in hand throws it: one fewer, burning where it lands, then out and gone", () => {
    const { sim, tick, ledger, slot, hold } = room({ ann: { x: 30, y: 46, aim: 0 } }, { flareSeconds: 2 })
    hold(slot("ann"), "flare", 2)
    tick({ ann: { fire: true } })
    const flares = [...ledger.stores.values()].filter((s) => s.id.startsWith("flare:"))
    expect(flares.length).toBe(1)
    expect(ledger.count("ann", "flare")).toBe(1)
    expect(flareBurning(flares[0], sim.time)).toBe(true)
    expect(flares[0]!.at!.x).toBeGreaterThan(31)
    expect(slot("ann").survivor.fireCooldown).toBe(0)
    tick({}, ticks(2.2))
    expect([...ledger.stores.values()].some((s) => s.id.startsWith("flare:"))).toBe(false)
  })

  test("the dead who can see a burning flare go and stand round it; the ones already after a survivor do not", () => {
    const { sim, tick, slot, hold } = room({ ann: { x: 30, y: 46, aim: 0 } }, { flareThrow: 6 })
    const near = sim.ai.spawnZombie(sim.town, 44, 46, "wander", 0)
    // Torch off, so it is the flare they see and not the survivor.
    slot("ann").survivor.flashlightOn = false
    hold(slot("ann"), "flare", 1)
    tick({ ann: { fire: true } })
    tick({}, ticks(0.6))
    expect(near.targetKind).toBe("light")
    expect(near.state).toBe("investigate")
    expect(Math.hypot(near.targetX - 36, near.targetY - 46)).toBeLessThan(2.5)
    // One already after a survivor is not turned.
    const chasing = sim.ai.spawnZombie(sim.town, 40, 47, "chase")
    pullToward(sim, sightRects(sim.town), 36, 46, 16)
    expect(chasing.targetKind).not.toBe("light")
  })

  test("a flare's light does not go through walls", () => {
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    const ash = sim.town.buildings.find((b) => b.id === "ash")!
    const inside = sim.ai.spawnZombie(sim.town, (ash.rect[0] + ash.rect[2]) / 2, (ash.rect[1] + ash.rect[3]) / 2, "wander")
    for (const d of sim.town.doors) d.open = false
    const blockers = sightRects(sim.town)
    const x = (ash.rect[0] + ash.rect[2]) / 2
    const y = ash.rect[3] + 3
    expect(Math.hypot(inside.x - x, inside.y - y)).toBeLessThan(16)
    pullToward(sim, blockers, x, y, 16)
    expect(inside.targetKind).not.toBe("light")
  })
})

describe("bodies to search", () => {
  test("placed from the seed, the same in two rooms; the start district has one by Ash's porch", () => {
    const a = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    const b = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    expect(bodySites(a.town)).toEqual(bodySites(b.town))
    expect(bodySites(a.town).map((s) => s.key)).toContain("porch:ash")
  })

  test("E searches a body (a quiet channel), then what it carried is on show and E takes it", () => {
    const probe = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    const body = bodySites(probe.town).find((b) => b.key === "porch:ash")!
    const { tick, ledger, slot, noises } = room({ ann: { x: body.x - 0.4, y: body.y + 0.8, aim: Math.atan2(-0.8, 0.4) } }, { bodyRiseChance: 0 })
    tick()
    expect(slot("ann").prompt?.kind).toBe("body")
    expect(slot("ann").prompt?.primary.id).toBe("search")
    tick({ ann: { interact: true } })
    tick({}, ticks(DEFAULT_BODIES_TUNING.bodySearchTime))
    expect(ledger.store(body.id)?.revealed).toBe(true)
    tick()
    expect(slot("ann").prompt?.primary.id).toBe("take")
    const carried = ledger.store(body.id)!.slots.filter((s) => s !== null).length
    expect(carried).toBeGreaterThan(0)
    tick({ ann: { interact: true } })
    expect(ledger.store(body.id)!.slots.filter((s) => s !== null).length).toBeLessThan(carried)
  })

  test("one that is not quite dead rises as you reach for it, comes for you, and leaves what it carried", () => {
    const probe = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    const body = bodySites(probe.town).find((b) => b.key === "porch:ash")!
    const { sim, tick, ledger, slot } = room({ ann: { x: body.x - 0.4, y: body.y + 0.8, aim: Math.atan2(-0.8, 0.4) } }, { bodyRiseChance: 1 })
    tick()
    const before = sim.ai.agents.filter((a) => a.state !== "dead").length
    tick({ ann: { interact: true } })
    expect(ledger.store(body.id)?.counts.rise).toBeGreaterThan(0)
    tick()
    expect(slot("ann").prompt?.kind).not.toBe("body")
    tick({}, ticks(DEFAULT_BODIES_TUNING.bodyRiseDelay))
    expect(ledger.store(body.id)?.counts.risen).toBe(1)
    const risen = sim.ai.agents.filter((a) => a.state !== "dead")
    expect(risen.length).toBe(before + 1)
    expect(Math.hypot(risen.at(-1)!.targetX - slot("ann").survivor.x, risen.at(-1)!.targetY - slot("ann").survivor.y)).toBeLessThan(1)
    expect(ledger.store(`drop:body:${body.key}`)?.slots.some((s) => s !== null)).toBe(true)
  })

  test("the vignette's survivor never rises", () => {
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    for (const b of bodySites(sim.town)) if (b.vignette) expect(b.riseRoll).toBe(1)
  })
})

describe("chained dogs", () => {
  const probe = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
  const dog = dogSites(probe.town).find((d) => d.buildingId === "elm")!

  test("Elm keeps one in its side yard, out of every building, the same in two rooms", () => {
    expect(dog).toBeDefined()
    expect(dogSites(new CoopSim(7, 7, 0.22, { zombieCount: 0 }).town)).toEqual(dogSites(probe.town))
    for (const b of probe.town.buildings) {
      const [x0, y0, x1, y1] = b.rect
      expect(dog.x > x0 && dog.x < x1 && dog.y > y0 && dog.y < y1).toBe(false)
    }
  })

  test("it barks at a survivor who comes near, on a beat; feed it and it hushes and knows them", () => {
    const { sim, tick, ledger, slot, hold, noises } = room({ ann: { x: dog.x + dog.chain + 0.6, y: dog.y + 0.4, aim: Math.PI } })
    tick()
    expect(dogState(ledger.store(dog.id), sim.time)).toBe("barking")
    tick({}, ticks(DEFAULT_DOG_TUNING.dogBeat * 2))
    expect(noises("bark").length).toBeGreaterThanOrEqual(2)
    expect(slot("ann").prompt?.kind).toBe("dog")
    tick({ ann: { interact: true } })
    expect(ledger.store(dog.id)?.counts.fed).toBeFalsy()
    hold(slot("ann"), "food", 1)
    tick({ ann: { interact: true } })
    expect(ledger.store(dog.id)?.counts.fed).toBe(1)
    expect(ledger.count("ann", "food")).toBe(0)
    const barks = noises("bark").length
    tick({}, ticks(3))
    expect(noises("bark").length).toBe(barks)
    expect(dogState(ledger.store(dog.id), sim.time)).toBe("fed")
  })

  test("a fed dog's quiet runs out; then it barks at the dead but not at its friend", () => {
    const { sim, tick, ledger, slot, hold } = room({ ann: { x: dog.x + dog.chain + 0.6, y: dog.y + 0.4, aim: Math.PI } }, { dogHushTime: 1 })
    hold(slot("ann"), "food", 1)
    tick()
    tick({ ann: { interact: true } })
    expect(ledger.store(dog.id)?.counts.fed).toBe(1)
    tick({}, ticks(1.2))
    expect(dogState(ledger.store(dog.id), sim.time)).toBe("quiet")
    sim.ai.spawnZombie(sim.town, dog.x + 5, dog.y + 2, "wander")
    tick()
    expect(dogState(ledger.store(dog.id), sim.time)).toBe("barking")
  })

  test("the dead at it long enough kill it", () => {
    const { sim, tick, ledger } = room({ ann: { x: 30, y: 40, aim: 0 } }, { dogKillTime: 1 })
    const z = sim.ai.spawnZombie(sim.town, dog.x + 1.5, dog.y, "wander")
    z.speedScale = 0
    tick({}, ticks(1.4))
    expect(Math.hypot(z.x - dog.x, z.y - dog.y)).toBeLessThan(dog.chain + 0.9)
    expect(dogState(ledger.store(dog.id), sim.time)).toBe("dead")
  })
})
