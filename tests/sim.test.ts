import { describe, expect, test } from "bun:test"
import { DT, END_SECONDS, FLAT_SECONDS, GADGETS, HEAD_START_SECONDS, INTRO_SECONDS, ROUND_SECONDS, SPIKE_SPOT_RANGE } from "../shared/config"
import { propBox, segmentHitsBox } from "../shared/sim/gadgets"
import { NO_INPUT } from "../shared/sim/vehicle"
import { World, type Phase } from "../shared/sim/world"
import { ROAD_X, ROAD_Z, bot, drive, human, humanWorld, place, steps, toChase } from "./sim-helpers"

const robberOf = (w: World, viewer: string) => w.view(viewer).cars.find((c) => c.ownerId === w.robberId)

describe("fog of war", () => {
  test("cops never get the robber's true position while unseen", () => {
    const w = humanWorld()
    toChase(w)
    const last = w.lastSeen!
    expect(last).not.toBeNull()
    // Robber far from both cops (still at the precinct).
    steps(w, 2, () => place(w, "r", ROAD_X, ROAD_Z, 0, 15))
    expect(w.seen).toBe(false)
    const ghost = robberOf(w, "c1")!
    const r = w.robber()!.body
    expect(ghost.ghost).toBe(true)
    expect(ghost.x).toBe(last.x)
    expect(ghost.z).toBe(last.z)
    expect(Math.hypot(ghost.x - r.x, ghost.z - r.z)).toBeGreaterThan(20)
    expect(ghost.vx).toBe(0)
    expect(ghost.speed).toBe(0)
    expect(ghost.gadgets).toBeUndefined()
    // The robber and spectators see the real car.
    expect(robberOf(w, "r")!.ghost).toBe(false)
    expect(robberOf(w, "r")!.x).toBe(r.x)
    expect(robberOf(w, "spectator")!.x).toBe(r.x)
  })

  test("in plain sight the cops see the live car", () => {
    const w = humanWorld()
    toChase(w)
    place(w, "c1", ROAD_X, ROAD_Z - 50)
    place(w, "r", ROAD_X, ROAD_Z)
    steps(w, 0.1)
    expect(w.seen).toBe(true)
    const v = robberOf(w, "c1")!
    expect(v.ghost).toBe(false)
    expect(v.x).toBe(w.robber()!.body.x)
  })

  test("buildings block line of sight beyond hearing range", () => {
    const w = humanWorld()
    toChase(w)
    const clear = (x: number, z: number) => !w.city.boxes.some((b) => x > b.x0 - 3 && x < b.x1 + 3 && z > b.z0 - 3 && z < b.z1 + 3)
    const building = w.city.boxes.find((b) => {
      const zc = (b.z0 + b.z1) / 2
      const d = b.x1 - b.x0 + 10
      return b.kind === "building" && b.h > 3 && d > 25 && d < 65 && clear(b.x0 - 5, zc) && clear(b.x1 + 5, zc)
    })!
    expect(building).toBeDefined()
    const zc = (building.z0 + building.z1) / 2
    place(w, "c1", building.x0 - 5, zc)
    place(w, "r", building.x1 + 5, zc)
    expect(segmentHitsBox(building.x0 - 5, zc, building.x1 + 5, zc, building)).toBe(true)
    steps(w, 0.1)
    expect(w.seen).toBe(false)
    expect(robberOf(w, "c1")!.ghost).toBe(true)
  })

  test("smoke breaks line of sight, through the cloud and inside it", () => {
    const w = humanWorld()
    toChase(w)
    place(w, "c1", ROAD_X, ROAD_Z - 35)
    place(w, "r", ROAD_X, ROAD_Z)
    steps(w, 0.1)
    expect(w.seen).toBe(true)
    w.setInput("r", { ...NO_INPUT, gadget: 1 })
    steps(w, 0.1)
    const smoke = w.props.find((p) => p.kind === "smoke")!
    expect(smoke).toBeDefined()
    expect(w.seen).toBe(false)
    // Out of the cloud, but the cloud sits between cop and robber.
    place(w, "r", ROAD_X, ROAD_Z + 25)
    steps(w, 0.1)
    expect(w.seen).toBe(false)
    // A cop on the robber's side of the cloud sees them again.
    place(w, "c2", ROAD_X, ROAD_Z + 45)
    steps(w, 0.1)
    expect(w.seen).toBe(true)
    // The cloud thins out after its lifetime.
    place(w, "c2", 0, 0)
    steps(w, GADGETS.smoke.ttl)
    expect(w.props.some((p) => p.kind === "smoke")).toBe(false)
    place(w, "r", ROAD_X, ROAD_Z + 25)
    steps(w, 0.1)
    expect(w.seen).toBe(true)
  })
})

describe("gadgets", () => {
  test("presses are edge-triggered and limited by cooldown and charges", () => {
    const w = humanWorld()
    toChase(w)
    place(w, "r", ROAD_X, ROAD_Z)
    w.setInput("r", { ...NO_INPUT, gadget: 0 })
    steps(w, 0.2)
    w.setInput("r", { ...NO_INPUT, gadget: 0 })
    steps(w, 0.2)
    expect(w.props.filter((p) => p.kind === "oil").length).toBe(1)
    const own = w.view("r").cars.find((c) => c.ownerId === "r")!
    expect(own.gadgets!.map((g) => g.id)).toEqual(["oil", "smoke"])
    expect(own.gadgets![0]!.charges).toBe(GADGETS.oil.charges - 1)
    expect(own.gadgets![0]!.ready).toBe(false)
    expect(own.gadgets![1]!.ready).toBe(true)
    // A fresh press during the cooldown is dropped.
    w.setInput("r", NO_INPUT)
    w.setInput("r", { ...NO_INPUT, gadget: 0 })
    steps(w, 0.1)
    expect(w.props.filter((p) => p.kind === "oil").length).toBe(1)
    for (let k = 0; k < GADGETS.oil.charges + 1; k++) {
      steps(w, GADGETS.oil.cooldown)
      w.setInput("r", NO_INPUT)
      w.setInput("r", { ...NO_INPUT, gadget: 0 })
      steps(w, 0.1)
    }
    expect(w.robber()!.gadgets[0]!.charges).toBe(0)
    expect(w.drainEvents().filter((e) => e.kind === "gadget").length).toBe(GADGETS.oil.charges)
  })

  test("cop gadgets wait for the chase; only the viewer's own car carries gadget state", () => {
    const w = humanWorld()
    while (w.phase !== "headstart") w.step(DT)
    w.setInput("c1", { ...NO_INPUT, gadget: 0 })
    steps(w, 0.2)
    expect(w.props.length).toBe(0)
    const v = w.view("c1")
    expect(v.cars.find((c) => c.ownerId === "c1")!.gadgets!.map((g) => g.id)).toEqual(["spike", "roadblock"])
    expect(v.cars.find((c) => c.ownerId === "c2")!.gadgets).toBeUndefined()
  })

  test("oil spins out cops that drive through it, once each; the robber is immune", () => {
    const w = humanWorld()
    toChase(w)
    place(w, "r", ROAD_X, ROAD_Z)
    w.setInput("r", { ...NO_INPUT, gadget: 0 })
    steps(w, 0.1)
    const oil = w.props.find((p) => p.kind === "oil")!
    expect(oil.z).toBeLessThan(ROAD_Z - 4)
    place(w, "r", ROAD_X, ROAD_Z + 120)
    place(w, "c1", ROAD_X + 1, ROAD_Z - 30, 0, 20)
    w.setInput("c1", drive(1))
    let maxSlip = 0
    steps(w, 1.5, () => (maxSlip = Math.max(maxSlip, w.carOf("c1")!.body.slip ?? 0)))
    expect(w.drainEvents().filter((e) => e.kind === "spinout").length).toBe(1)
    expect(maxSlip).toBeGreaterThan(1)
    expect(oil.hits).toEqual([w.carOf("c1")!.id])
    // Same cop again: no second spin. The robber drives through unharmed.
    place(w, "c1", ROAD_X + 1, ROAD_Z - 30, 0, 20)
    place(w, "r", ROAD_X - 1, ROAD_Z - 60, 0, 20)
    w.setInput("r", drive(1))
    let robberSlip = 0
    steps(w, 1.5, () => (robberSlip = Math.max(robberSlip, w.robber()!.body.slip ?? 0)))
    expect(w.drainEvents().filter((e) => e.kind === "spinout").length).toBe(0)
    expect(robberSlip).toBe(0)
  })

  test("a spike strip ahead of a cop flattens the robber's tires", () => {
    const w = humanWorld()
    toChase(w)
    place(w, "c1", ROAD_X + 2, ROAD_Z + 20, Math.PI)
    w.setInput("c1", { ...NO_INPUT, gadget: 0 })
    steps(w, 0.1)
    const spike = w.props.find((p) => p.kind === "spike")!
    expect(spike.x).toBe(ROAD_X)
    expect(spike.z).toBeCloseTo(ROAD_Z + 10, 0)
    place(w, "c1", ROAD_X, ROAD_Z + 60)
    // Spikes are hidden from the robber until they are close.
    place(w, "r", ROAD_X, ROAD_Z + 10 - SPIKE_SPOT_RANGE - 10)
    steps(w, 0.1)
    expect(w.view("r").props!.some((p) => p.kind === "spike")).toBe(false)
    expect(w.view("c2").props!.some((p) => p.kind === "spike")).toBe(true)
    place(w, "r", ROAD_X - 3, ROAD_Z - 20, 0, 25)
    w.setInput("r", drive(1))
    expect(w.view("r").props!.some((p) => p.kind === "spike")).toBe(true)
    steps(w, 2)
    const flat = w.drainEvents().find((e) => e.kind === "flat")
    expect(flat?.text).toContain("SPIKE STRIP")
    expect(w.robber()!.body.flat).toBeGreaterThan(FLAT_SECONDS - 2)
    expect(w.props.some((p) => p.kind === "spike")).toBe(false)
    expect(robberOf(w, "r")!.flat).toBeGreaterThan(0)
  })

  test("a roadblock is a solid barrier across the road for everyone, then expires", () => {
    const w = humanWorld()
    toChase(w)
    place(w, "c1", ROAD_X, ROAD_Z + 20, Math.PI)
    w.setInput("c1", { ...NO_INPUT, gadget: 1 })
    steps(w, 0.1)
    const rb = w.props.find((p) => p.kind === "roadblock")!
    const box = propBox(rb)!
    expect(box.x1 - box.x0).toBeGreaterThan(12)
    expect(w.propBoxes.length).toBe(1)
    place(w, "c1", ROAD_X, ROAD_Z + 60)
    for (const viewer of ["r", "c1", "c2"]) expect(w.view(viewer).props!.some((p) => p.kind === "roadblock")).toBe(true)
    place(w, "r", ROAD_X, ROAD_Z - 30, 0, 40)
    w.setInput("r", drive(1, { boost: true }))
    let maxZ = -Infinity
    steps(w, 2, () => (maxZ = Math.max(maxZ, w.robber()!.body.z)))
    expect(maxZ).toBeLessThan(box.z0)
    steps(w, GADGETS.roadblock.ttl)
    expect(w.props.some((p) => p.kind === "roadblock")).toBe(false)
    expect(w.propBoxes.length).toBe(0)
  })

  test("robber props dropped out of sight stay hidden from cops until one gets close", () => {
    const w = humanWorld()
    toChase(w)
    place(w, "r", ROAD_X, ROAD_Z)
    steps(w, 0.1)
    expect(w.seen).toBe(false)
    w.setInput("r", { ...NO_INPUT, gadget: 0 })
    steps(w, 0.1)
    expect(w.view("r").props!.length).toBe(1)
    expect(w.view("c1").props!.length).toBe(0)
    place(w, "r", ROAD_X, ROAD_Z + 400)
    place(w, "c1", ROAD_X, ROAD_Z - 60)
    steps(w, 0.1)
    expect(w.view("c1").props!.length).toBe(1)
  })
})

describe("cars", () => {
  test("ramming: the heavier car shoves the lighter one and knocks it silly", () => {
    const w = humanWorld(["c1"], "compact", "swat")
    toChase(w)
    place(w, "r", ROAD_X, ROAD_Z - 6)
    place(w, "c1", ROAD_X, ROAD_Z + 6, Math.PI, 15)
    let stunR = 0
    let stunC = 0
    steps(w, 1.2, () => {
      stunR = Math.max(stunR, w.robber()!.body.stun)
      stunC = Math.max(stunC, w.carOf("c1")!.body.stun)
    })
    expect(w.robber()!.body.z).toBeLessThan(ROAD_Z - 9)
    expect(w.carOf("c1")!.body.vz).toBeLessThan(-5)
    expect(stunR).toBeGreaterThan(0.3)
    expect(stunC).toBe(0)
  })
})

describe("rounds", () => {
  test("phases cycle intro -> headstart -> chase -> end -> next round, and the robber rotates between humans", () => {
    const w = new World(11, [human("h1"), human("h2"), bot("b1"), bot("b2"), bot("b3")])
    const seen: Phase[] = [w.phase]
    const robbers = [w.robberId]
    const starts: number[] = []
    let round = w.round
    for (let i = 0; i < 30 * 600 && w.round < 2; i++) {
      w.step(DT)
      if (w.phase !== seen[seen.length - 1]) {
        seen.push(w.phase)
        starts.push(w.t)
      }
      if (w.round !== round) {
        round = w.round
        robbers.push(w.robberId)
      }
    }
    expect(seen.slice(0, 9)).toEqual(["intro", "headstart", "chase", "end", "intro", "headstart", "chase", "end", "intro"])
    expect(Math.abs(starts[0]! - INTRO_SECONDS)).toBeLessThan(0.1)
    expect(Math.abs(starts[1]! - INTRO_SECONDS - HEAD_START_SECONDS)).toBeLessThan(0.1)
    expect(robbers).toEqual(["h1", "h2", "h1"])
    expect(w.props.length).toBe(0)
    expect(w.robber()!.gadgets[0]!.charges).toBe(GADGETS.oil.charges)
  })

  test("a lone human alternates with a bot robber", () => {
    const w = new World(5, [human("me"), bot("b1"), bot("b2"), bot("b3")])
    const robbers = [w.robberId]
    let round = 0
    for (let i = 0; i < 30 * 1000 && w.round < 3; i++) {
      w.step(DT)
      if (w.round !== round) {
        round = w.round
        robbers.push(w.robberId)
      }
    }
    expect(robbers.length).toBe(4)
    expect(robbers[0]).toBe("me")
    expect(robbers[1]).not.toBe("me")
    expect(robbers[2]).toBe("me")
  })

  test("bots-only rounds end in an escape or a bust within the time limit", () => {
    const outcomes: string[] = []
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const w = new World(seed * 7919, ["a", "b", "c", "d", "e"].map(bot))
      while (w.phase !== "end" && w.t < ROUND_SECONDS + 20) w.step(DT)
      expect(w.phase).toBe("end")
      expect(w.escaped !== w.busted).toBe(true)
      outcomes.push(w.escaped ? "escape" : "bust")
      expect(w.drainEvents().some((e) => e.kind === "gadget")).toBe(true)
      // Then the next round starts.
      for (let i = 0; i < (END_SECONDS + 0.1) / DT; i++) w.step(DT)
      expect(w.round).toBe(1)
    }
    expect(outcomes).toContain("escape")
    expect(outcomes).toContain("bust")
  })

  test("the simulation is deterministic", () => {
    const run = () => {
      const w = new World(99, ["a", "b", "c", "d", "e"].map(bot))
      for (let i = 0; i < 30 * 90; i++) w.step(DT)
      return JSON.stringify(w.view())
    }
    expect(run()).toBe(run())
  })

  test("heat rises over the chase and calls backup at higher stars", () => {
    const w = humanWorld()
    toChase(w)
    place(w, "c1", ROAD_X, ROAD_Z - 40)
    let maxStars = 1
    let maxCops = 0
    const heat: number[] = []
    steps(w, 75, () => {
      if (w.phase !== "chase") return
      place(w, "r", ROAD_X, ROAD_Z)
      maxStars = Math.max(maxStars, w.stars)
      maxCops = Math.max(maxCops, w.cops().length)
      heat.push(w.heat)
    })
    expect(heat[30 * 30]!).toBeGreaterThan(heat[30 * 5]!)
    expect(Math.max(...heat)).toBeGreaterThan(50)
    expect(maxStars).toBeGreaterThanOrEqual(3)
    expect(maxCops).toBeGreaterThan(2)
  })
})
