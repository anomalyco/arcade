import { describe, expect, test } from "bun:test"
import { TICK_DT } from "../shared/clock"
import { CoopSim, hashSimState, type SurvivorSlot } from "../shared/coop-sim"
import { outbreakDiscoverySharedFeature } from "../shared/discovery/index"
import { carSites, carStoreId, closetSites, hideStoreId, trappedDoors, tripLine, tripStoreId } from "../shared/discovery/verbs"
import { propShape } from "../shared/map"
import { packCommand, unpackCommand } from "../shared/net-protocol"
import { DEFAULT_PROGRESSION_TUNING } from "../shared/progression"
import type { Command } from "../shared/session"
import { DEFAULT_STAMINA_TUNING } from "../shared/stamina"

const T = DEFAULT_PROGRESSION_TUNING
const idle = (aim = 0): Command => ({ mx: 0, my: 0, aim, interact: false })
const ticks = (seconds: number) => Math.ceil(seconds / TICK_DT) + 2

type Pose = { x: number; y: number; aim: number }

function room(poses: Record<string, Pose>) {
  const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
  sim.hour = 12
  const slots: SurvivorSlot[] = Object.entries(poses).map(([id, pose], i) => {
    const slot = sim.addSurvivor(id, i)
    Object.assign(slot.survivor, pose)
    return slot
  })
  sim.rebuildSolids()
  const tick = (cmds: Partial<Record<string, Partial<Command>>> = {}, n = 1) => {
    for (let k = 0; k < n; k++) {
      for (const s of sim.slots) sim.stepSurvivor(s, { ...idle(s.survivor.aim), ...cmds[s.id] }, TICK_DT)
      sim.stepWorld(TICK_DT, 0)
    }
  }
  const slot = (id: string) => sim.slot(id)!
  const give = (actor: string, item: string, count = 1) => expect(sim.progression.ledger.apply({ kind: "grant", actor, item, count }).ok).toBe(true)
  /** Puts `item` in `actor`'s hand. */
  const hold = (actor: string, item: string) => {
    const index = sim.progression.hotbar(actor)!.slots.findIndex((s) => s?.item === item)
    expect(index).toBeGreaterThanOrEqual(0)
    tick({ [actor]: { hotbarSlot: index } })
  }
  const heard: { kind: string; x: number; y: number; radius: number }[] = []
  const emit = sim.ai.emitNoise.bind(sim.ai)
  sim.ai.emitNoise = (x, y, radius, kind, ...rest) => {
    heard.push({ kind, x, y, radius })
    return emit(x, y, radius, kind, ...rest)
  }
  const noises = (kind: string) => heard.filter((e) => e.kind === kind)
  return { sim, slots, tick, slot, give, hold, noises, ledger: sim.progression.ledger, progression: sim.progression }
}

/** Ash's bedroom closet, from in front of it, facing it. */
const ASH_CLOSET = { x: 27.58, y: 24.52 }
const BEFORE_CLOSET: Pose = { x: 27.58, y: 25.4, aim: -Math.PI / 2 }

describe("crouching", () => {
  test("Ctrl halves walking speed, hushes footsteps, ignores sprint, and makes a smaller shape to the dead", () => {
    const { sim, tick, slot } = room({ ann: { x: 44, y: 44, aim: 0 }, bob: { x: 44, y: 47, aim: 0 } })
    tick({ ann: { mx: 1, crouch: true, sprint: true }, bob: { mx: 1 } }, 60)
    const ann = slot("ann").survivor
    const bob = slot("bob").survivor
    expect(ann.crouching).toBe(true)
    expect(bob.crouching).toBe(false)
    expect(ann.x - 44).toBeCloseTo((DEFAULT_STAMINA_TUNING.walkSpeed * T.crouchSpeed * 60) / 60, 1)
    expect(bob.x - 44).toBeCloseTo(DEFAULT_STAMINA_TUNING.walkSpeed, 1)
    expect(ann.sprinting).toBe(false)
    expect(ann.noise).toBeCloseTo(T.crouchNoise, 5)
    expect(bob.noise).toBeGreaterThan(ann.noise * 2)
    const view = outbreakDiscoverySharedFeature.transformAISurvivor!(sim, slot("ann"), { ...ann, id: "ann" }, undefined) as { visibility?: number }
    expect(view.visibility).toBe(T.crouchVisibility)
    const standing = outbreakDiscoverySharedFeature.transformAISurvivor!(sim, slot("bob"), { ...bob, id: "bob" }, undefined) as { visibility?: number }
    expect(standing.visibility).toBeUndefined()
  })

  test("the crouch bit rides the action byte, alongside an interact action", () => {
    const c = unpackCommand(packCommand({ ...idle(), crouch: true, interactAction: "disarm" }))
    expect(c.crouch).toBe(true)
    expect(c.interactAction).toBe("disarm")
    expect(unpackCommand(packCommand({ ...idle(), interactAction: "read" })).crouch).toBeUndefined()
  })
})

describe("closets", () => {
  test("every house bedroom has one closet between the bed and the dresser; nothing seeded before it moved", () => {
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    const closets = closetSites(sim.town)
    expect(closets.map((c) => [c.x, c.y])).toEqual([
      [ASH_CLOSET.x, ASH_CLOSET.y],
      [26.58, 54.52],
    ])
    // Loot ids are prop indices: every closet comes after every container.
    const lastLoot = Math.max(...sim.progression.containers.map((c) => c.propIndex))
    for (const c of closets) expect(sim.town.props.findIndex((p) => p.x === c.x && p.y === c.y)).toBeGreaterThan(lastLoot)
  })

  test("streamed houses get closets too, clear of every other piece of furniture and wall", () => {
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 }, "procedural")
    const closets = closetSites(sim.town)
    expect(closets.length).toBeGreaterThan(0)
    const overlaps = (a: readonly number[], b: readonly number[]) => a[0]! < b[2]! - 0.01 && b[0]! < a[2]! - 0.01 && a[1]! < b[3]! - 0.01 && b[1]! < a[3]! - 0.01
    for (const c of closets) {
      for (const p of sim.town.props) {
        const shape = propShape(p)
        if (!shape || (p.x === c.x && p.y === c.y)) continue
        expect(overlaps(c.rect, shape.rect)).toBe(false)
      }
      for (const b of sim.town.barriers) expect(overlaps(c.rect, b.rect)).toBe(false)
    }
  })

  test("E squeezes in: still, silent, dark and unseen until E lets you back out in front of it", () => {
    const { sim, tick, slot, ledger, progression } = room({ ann: BEFORE_CLOSET })
    tick()
    expect(slot("ann").prompt?.kind).toBe("closet")
    tick({ ann: { interact: true } })
    const ann = slot("ann").survivor
    const closet = progression.verbs.hiddenIn("ann")!
    expect(closet).not.toBeNull()
    expect(ledger.store(hideStoreId(closet.id))?.owner).toBe("ann")
    expect([ann.x, ann.y]).toEqual([ASH_CLOSET.x, ASH_CLOSET.y])
    expect(ann.flashlightOn).toBe(false)
    tick({ ann: { mx: 1, my: 1, sprint: true } }, 30)
    expect([ann.x, ann.y]).toEqual([ASH_CLOSET.x, ASH_CLOSET.y])
    expect(ann.noise).toBe(0)
    const view = outbreakDiscoverySharedFeature.transformAISurvivor!(sim, slot("ann"), { ...ann, id: "ann" }, undefined) as { visibility?: number; noise: number }
    expect(view.visibility).toBe(0)
    expect(slot("ann").prompt?.primary.label).toBe("Leave")
    tick({ ann: { interact: true } })
    expect(progression.verbs.hiddenIn("ann")).toBeNull()
    expect(ann.y).toBeCloseTo(closet.out.y, 5)
    tick({ ann: { my: 1 } }, 10)
    expect(ann.y).toBeGreaterThan(closet.out.y)
  })

  test("a closet holds one: a teammate sees no way in while it is taken", () => {
    const { tick, slot, progression } = room({ ann: BEFORE_CLOSET, bob: { ...BEFORE_CLOSET, x: BEFORE_CLOSET.x + 0.4 } })
    tick({ ann: { interact: true } })
    expect(progression.verbs.hiddenIn("ann")).not.toBeNull()
    tick()
    expect(slot("bob").prompt?.kind).not.toBe("closet")
    tick({ bob: { interact: true } })
    expect(progression.verbs.hiddenIn("bob")).toBeNull()
  })

  test("the dead lose a survivor who hides: a chaser goes to where it last saw them and searches", () => {
    const { sim, tick, slot, progression } = room({ ann: BEFORE_CLOSET })
    sim.hour = 23
    const z = sim.ai.spawnZombie(sim.town, 28.6, 28.4, "chase", -Math.PI / 2)
    tick({}, 20)
    expect(z.state).toBe("chase")
    expect(z.focusId).toBe("ann")
    tick({ ann: { interact: true } })
    expect(progression.verbs.hiddenIn("ann")).not.toBeNull()
    let searched = false
    for (let i = 0; i < 60 * 12 && !searched; i++) {
      tick()
      searched = z.state === "search"
    }
    expect(searched).toBe(true)
    expect(z.seesTarget).toBe(false)
    expect(slot("ann").survivor.health).toBe(100)
  })
})

describe("peepholes", () => {
  test("Shift+E at a shut front door looks out through it; E or opening the door stops", () => {
    const { sim, tick, slot } = room({ ann: { x: 27.7, y: 34.6, aim: Math.PI / 2 } })
    tick()
    const prompt = slot("ann").prompt!
    expect(prompt.kind).toBe("door")
    expect(prompt.alt?.id).toBe("peek")
    tick({ ann: { interact: true, sprint: true } })
    const ann = slot("ann").survivor
    expect(ann.peekingWindowId).toBe("ash-front")
    expect(slot("ann").peek?.eyeY).toBeGreaterThan(35.5)
    expect(slot("ann").peek?.cone).toBeLessThan(165)
    expect(sim.town.doors.find((d) => d.id === "ash-front")!.open).toBe(false)
    tick({ ann: { interact: true } })
    expect(ann.peekingWindowId).toBeNull()
    expect(sim.town.doors.find((d) => d.id === "ash-front")!.open).toBe(false)
    tick({ ann: { interact: true } })
    expect(sim.town.doors.find((d) => d.id === "ash-front")!.open).toBe(true)
    tick()
    expect(slot("ann").prompt?.alt).toBeUndefined()
  })

  test("bedroom and back-room doors have none", () => {
    const { tick, slot } = room({ ann: { x: 27.7, y: 30.2, aim: -Math.PI / 2 } })
    tick()
    expect(slot("ann").prompt?.id).toBe("ash-room")
    expect(slot("ann").prompt?.alt).toBeUndefined()
  })
})

describe("tripwires", () => {
  /** Outside the pharmacy's front door, which someone strung cans across. */
  const OUTSIDE_PHARMACY: Pose = { x: 58.7, y: 69.2, aim: -Math.PI / 2 }

  const openFront = (sim: CoopSim) => {
    sim.town.doors.find((d) => d.id === "pharmacy-front")!.open = true
    sim.rebuildCollision()
  }

  test("pharmacies, police stations and clinics start with cans strung across their front steps, in the camera's view", () => {
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    expect(trappedDoors(sim.town)).toEqual(["pharmacy-front"])
    expect(sim.progression.ledger.store(tripStoreId("pharmacy-front"))?.counts.armed).toBe(1)
    const door = sim.town.doors.find((d) => d.id === "pharmacy-front")!
    const line = tripLine(sim.town, door)
    expect(line.y).toBeGreaterThan(door.rect[3])
  })

  test("walking through rattles them; crouching steps over", () => {
    for (const crouch of [false, true]) {
      const { sim, tick, noises, ledger } = room({ ann: OUTSIDE_PHARMACY })
      openFront(sim)
      tick({ ann: { my: -1, crouch } }, crouch ? 120 : 60)
      expect(sim.slot("ann")!.survivor.y).toBeLessThan(66.2)
      expect(ledger.store(tripStoreId("pharmacy-front"))!.counts.armed).toBe(crouch ? 1 : 0)
      expect(noises("cans")).toHaveLength(crouch ? 0 : 1)
      if (!crouch) expect(noises("cans")[0]!.radius).toBe(T.tripNoise)
    }
  })

  test("taking an armed line down quietly teaches the squad to make one, and leaves the cans in hand", () => {
    const { sim, tick, slot, ledger, progression, noises } = room({ ann: OUTSIDE_PHARMACY })
    tick()
    expect(slot("ann").prompt?.kind).toBe("tripwire")
    expect(slot("ann").prompt?.primary.id).toBe("disarm")
    tick({ ann: { interact: true } })
    expect(slot("ann").survivor.channel?.kind).toBe("disarm")
    tick({}, ticks(T.tripDisarmTime))
    expect(progression.learned("tripwire")).toBe(true)
    expect(ledger.count("ann", "cans")).toBe(1)
    expect(ledger.store(tripStoreId("pharmacy-front"))!.counts).toMatchObject({ down: 1 })
    expect(noises("cans")).toHaveLength(0)
    expect(progression.craftable().map((r) => r.id)).toContain("tripwire")
    void sim
  })

  test("cans in hand string a new line across the nearest doorway, and it catches whoever walks through", () => {
    const { tick, slot, give, hold, ledger, noises } = room({ ann: { x: 27.7, y: 33.6, aim: Math.PI / 2 }, bob: { x: 27.7, y: 37, aim: -Math.PI / 2 } })
    give("ann", "cans")
    hold("ann", "cans")
    tick({ ann: { fire: true } })
    expect(slot("ann").survivor.channel?.kind).toBe("set")
    tick({}, ticks(T.tripSetTime))
    const st = ledger.store(tripStoreId("ash-front"))!
    expect(st.counts.armed).toBe(1)
    expect(st.owner).toBe("ann")
    expect(ledger.count("ann", "cans")).toBe(0)
    // Ann steps back out of the way; Bob opens up and walks in.
    tick({ ann: { my: -1 } }, 40)
    tick({ bob: { interact: true } })
    tick({ bob: { my: -1 } }, 60)
    expect(st.counts.armed).toBe(0)
    expect(noises("cans")).toHaveLength(1)
  })
})

describe("bottles and car alarms", () => {
  test("a thrown bottle breaks where it lands, loud, and leaves glass", () => {
    const { tick, give, hold, noises, ledger } = room({ ann: { x: 44, y: 44, aim: 0 } })
    give("ann", "bottle", 2)
    hold("ann", "bottle")
    // Thrown by the throwables feature (AR-96): heard where it lands, after its flight.
    tick({ ann: { fire: true } })
    tick({}, ticks(1.5))
    const glass = noises("glass")
    expect(glass).toHaveLength(1)
    expect(glass[0]!.x).toBeGreaterThan(50)
    expect(glass[0]!.x).toBeLessThanOrEqual(44 + T.bottleRange)
    expect(glass[0]!.radius).toBe(T.bottleNoise)
    expect(ledger.count("ann", "bottle")).toBe(1)
    expect([...ledger.stores.keys()].filter((id) => id.startsWith("glass:") && !id.startsWith("glass:v:"))).toHaveLength(1)
  })

  test("half the abandoned cars have alarms; E puts a window in, and an alarm car wails on a beat until its battery dies", () => {
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    const cars = carSites(sim.town)
    const alarmed = cars.filter((c) => c.alarm)
    expect(alarmed.length).toBeGreaterThan(0)
    expect(alarmed.length).toBeLessThan(cars.length)
    const car = alarmed[0]!
    const beside: Pose = { x: car.rect[0] - 0.7, y: car.y, aim: 0 }
    const { tick, slot, noises, ledger, progression, sim: s } = room({ ann: beside })
    tick()
    expect(slot("ann").prompt?.kind).toBe("car")
    tick({ ann: { interact: true } })
    expect(ledger.store(carStoreId(car.key))!.counts).toMatchObject({ smashed: 1, alarm: 1 })
    expect(progression.verbs.alarmRinging(car, s.time)).toBe(true)
    tick({}, 60 * 5)
    const wails = noises("alarm").length
    expect(wails).toBeGreaterThanOrEqual(3)
    tick({}, ticks(T.alarmTime))
    expect(progression.verbs.alarmRinging(car, s.time)).toBe(false)
    expect(slot("ann").prompt?.kind).not.toBe("car")
  })

  test("a bottle breaking beside an alarm car sets it off from across the street", () => {
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    const car = carSites(sim.town).find((c) => c.alarm)!
    const from: Pose = { x: car.rect[0] - 6, y: car.y, aim: 0 }
    const { tick, give, hold, ledger, sim: s, progression } = room({ ann: from })
    give("ann", "bottle")
    hold("ann", "bottle")
    tick({ ann: { fire: true } })
    tick({}, ticks(1.5))
    expect(ledger.store(carStoreId(car.key))!.counts).toMatchObject({ alarm: 1 })
    expect(progression.verbs.alarmRinging(car, s.time)).toBe(true)
  })
})

describe("crowbar repairs", () => {
  const ASH_WINDOW: Pose = { x: 36.2, y: 28.8, aim: 0 }

  test("holding a crowbar, the barricade key re-nails a damaged barricade, faster with practice", () => {
    const { sim, tick, give, hold, progression, slot } = room({ ann: ASH_WINDOW })
    for (let i = 0; i < 2; i++) sim.ai.addBarricadePlank("ash-east", 100)
    sim.ai.rebuildTopology(sim.town)
    const st = sim.ai.portalStates.get("ash-east")!
    st.barricadeHp = 130
    give("ann", "crowbar")
    hold("ann", "crowbar")
    tick({ ann: { barricade: true } })
    const ch = slot("ann").survivor.channel
    expect(ch?.kind).toBe("repair")
    expect(st.barricadePlanks).toBe(2)
    tick({}, ticks(T.repairTime))
    expect(st.barricadeHp).toBe(200)
    expect(st.barricadePlanks).toBe(2)
    expect(progression.knowledge.practice("ann", "repair")).toBe(1)
    st.barricadeHp = 130
    tick({ ann: { barricade: true } })
    expect(progression.ledger.channel("ann")!.duration).toBeLessThan(T.repairTime)
  })

  test("a sound barricade is not re-nailed: the key adds a board as before", () => {
    const { sim, tick, give, hold } = room({ ann: ASH_WINDOW })
    sim.ai.addBarricadePlank("ash-east", 100)
    sim.ai.rebuildTopology(sim.town)
    give("ann", "crowbar")
    give("ann", "plank", 2)
    hold("ann", "crowbar")
    tick({ ann: { barricade: true } })
    expect(sim.slot("ann")!.survivor.channel?.kind).not.toBe("repair")
  })
})

describe("verb state", () => {
  test("hidden survivors, strung lines, wailing cars and glass survive a snapshot, and both copies tick the same", () => {
    const { sim, tick, give, hold } = room({ ann: BEFORE_CLOSET, bob: { x: 44, y: 44, aim: 0 } })
    give("bob", "bottle")
    hold("bob", "bottle")
    tick({ ann: { interact: true }, bob: { fire: true } })
    tick({ bob: { mx: 1, crouch: true } }, 5)
    const copy = CoopSim.fromSnapshot(sim.toSnapshot())
    expect(hashSimState(copy.toSnapshot())).toBe(hashSimState(sim.toSnapshot()))
    expect(copy.progression.verbs.hiddenIn("ann")?.id).toBe(sim.progression.verbs.hiddenIn("ann")!.id)
    expect(copy.slot("bob")!.survivor.crouching).toBe(true)
    const step = (s: CoopSim) => {
      for (let i = 0; i < 90; i++) {
        for (const slot of s.slots) s.stepSurvivor(slot, { ...idle(), crouch: slot.id === "bob", mx: slot.id === "bob" ? 1 : 0 }, TICK_DT)
        s.stepWorld(TICK_DT, 0)
      }
    }
    step(sim)
    step(copy)
    expect(hashSimState(copy.toSnapshot())).toBe(hashSimState(sim.toSnapshot()))
  })
})
