import { describe, expect, test } from "bun:test"
import { distToRect } from "@arcade/kit/sim/geom"
import { TICK_DT } from "../shared/clock"
import { CoopSim, hashSimState } from "../shared/coop-sim"
import { carStoreId } from "../shared/discovery/verbs"
import { chooseVignettes, parseVignetteId, vignetteDropId, vignetteGlassId, vignetteScene, vignetteStoreId } from "../shared/discovery/vignettes"
import { propShape } from "../shared/map"
import { DEFAULT_PROGRESSION_TUNING } from "../shared/progression"
import type { Command } from "../shared/session"

const T = DEFAULT_PROGRESSION_TUNING
const idle = (aim = 0): Command => ({ mx: 0, my: 0, aim, interact: false })

function room(pose: { x: number; y: number; aim: number }) {
  const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
  sim.hour = 12
  const slot = sim.addSurvivor("ann", 0)
  Object.assign(slot.survivor, pose)
  sim.rebuildSolids()
  const tick = (cmd: Partial<Command> = {}, n = 1) => {
    for (let k = 0; k < n; k++) {
      sim.stepSurvivor(slot, { ...idle(slot.survivor.aim), ...cmd }, TICK_DT)
      sim.stepWorld(TICK_DT, 0)
    }
  }
  const heard: { kind: string; x: number; y: number; radius: number }[] = []
  const emit = sim.ai.emitNoise.bind(sim.ai)
  sim.ai.emitNoise = (x, y, radius, kind, ...rest) => {
    heard.push({ kind, x, y, radius })
    return emit(x, y, radius, kind, ...rest)
  }
  return { sim, slot, tick, heard, ledger: sim.progression.ledger }
}

describe("vignettes", () => {
  test("the classic town has a house broken into, a closet someone hid in and bottles thrown from the pharmacy, seeded the same in every room", () => {
    const a = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    const b = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    expect(chooseVignettes(a.town)).toEqual([
      { kind: "broken-in", target: "ash" },
      { kind: "hid", target: "elm" },
      { kind: "lured", target: "pharmacy" },
    ])
    const ids = (sim: CoopSim) => [...sim.progression.ledger.stores.keys()].filter((k) => k.startsWith("vignette:") || k.includes(":v:")).sort()
    expect(ids(a)).toEqual(ids(b))
    expect(hashSimState(a.toSnapshot())).toBe(hashSimState(b.toSnapshot()))
    const ledger = a.progression.ledger
    expect(ledger.count(vignetteDropId("broken-in", "ash"), "scrap")).toBe(1)
    expect(ledger.count(vignetteDropId("hid", "elm"), "battery")).toBe(1)
    expect(ledger.count(vignetteDropId("lured", "pharmacy"), "bottle")).toBe(1)
    expect(ledger.store(vignetteGlassId("broken-in", "ash", 0))!.counts.keep).toBe(1)
    expect(parseVignetteId(vignetteStoreId("alarm-car", "12.2,46.3"))).toEqual({ kind: "alarm-car", target: "12.2,46.3" })
  })

  test("streamed homes get a few, and every body, bat and drop lies clear of walls, doors, furniture and cars", () => {
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 }, "procedural")
    const homes = sim.town.buildings.filter((b) => ["house", "ranch", "cottage", "cabin"].includes(b.archetype ?? b.kind))
    const chosen = chooseVignettes(sim.town)
    expect(chosen.length).toBeGreaterThan(0)
    expect(chosen.length).toBeLessThan(homes.length)
    const classic = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    const scenes = [
      ...chosen.map((v) => [sim, vignetteScene(sim.town, v.kind, v.target)!] as const),
      ...(["broken-in:ash", "hid:elm", "lured:pharmacy", "alarm-car:12.2,46.3"] as const).map((s) => {
        const [kind, target] = s.split(/:(.*)/) as ["broken-in", string]
        return [classic, vignetteScene(classic.town, kind, target)!] as const
      }),
    ]
    for (const [world, scene] of scenes) {
      expect(scene).not.toBeNull()
      const solids = [...world.town.barriers.map((b) => b.rect), ...world.town.doors.map((d) => d.rect), ...world.town.props.flatMap((p) => propShape(p)?.rect ?? [])]
      const rects = solids.filter((r): r is [number, number, number, number] => Array.isArray(r))
      for (const body of scene.bodies) for (const r of rects) expect(distToRect(body.x, body.y, r)).toBeGreaterThanOrEqual(0.4)
      for (const p of [...scene.glass, ...(scene.drop ? [scene.drop] : [])]) for (const r of rects) expect(distToRect(p.x, p.y, r)).toBeGreaterThanOrEqual(0.15)
    }
  })

  test("glass underfoot crunches loud enough to carry when walked on upright, and not when crouched", () => {
    for (const crouch of [false, true]) {
      const { sim, tick, heard, ledger } = room({ x: 0, y: 0, aim: 0 })
      const glass = ledger.store(vignetteGlassId("broken-in", "ash", 0))!
      Object.assign(sim.slot("ann")!.survivor, { x: glass.at!.x - 1.5, y: glass.at!.y })
      tick({ mx: 1, crouch }, crouch ? 120 : 60)
      const crunches = heard.filter((e) => e.kind === "glass")
      expect(crunches.length > 0).toBe(!crouch)
      if (!crouch) {
        expect(crunches[0]!.radius).toBe(T.glassStepNoise)
        expect(glass.counts.steps).toBeGreaterThan(0)
      }
    }
  })

  test("a vignette's glass is never swept; a bottle's is", () => {
    const { sim, ledger } = room({ x: 44, y: 44, aim: 0 })
    ledger.createStore({ id: "glass:bottle", mode: "counters", scope: "shared", at: { x: 44, y: 44 }, initial: { t: 1 } })
    for (let t = 0; t < 95 * 60; t += 30) sim.stepWorld(TICK_DT * 30, 0)
    expect(ledger.store("glass:bottle")).toBeUndefined()
    expect(ledger.store(vignetteGlassId("lured", "pharmacy", 2))).toBeDefined()
  })

  test("what a vignette left stays taken, through a snapshot and when its chunk streams back", () => {
    const { sim, ledger } = room({ x: 44, y: 44, aim: 0 })
    const drop = vignetteDropId("hid", "elm")
    expect(ledger.apply({ kind: "take", actor: "ann", from: drop }).ok).toBe(true)
    expect(ledger.count(drop, "battery")).toBe(0)
    const fork = CoopSim.fromSnapshot(sim.toSnapshot())
    fork.progression.ensureContainerStores()
    expect(fork.progression.ledger.count(drop, "battery")).toBe(0)
    expect(fork.progression.ledger.store(vignetteStoreId("hid", "elm"))).toBeDefined()
    expect(hashSimState(fork.toSnapshot())).toBe(hashSimState(sim.toSnapshot()))
  })

  test("an alarm car that already rang out has its window in and stays quiet; the dead it called lie round it", () => {
    const { sim, tick, heard, ledger } = room({ x: 9.5, y: 46.3, aim: 0 })
    const key = "12.2,46.3"
    expect(sim.progression.seedVignette("alarm-car", key)).toBe(true)
    expect(ledger.store(carStoreId(key))!.counts).toMatchObject({ smashed: 1, alarm: 1 })
    expect(vignetteScene(sim.town, "alarm-car", key)!.bodies.length).toBeGreaterThanOrEqual(2)
    sim.ai.emitNoise(12.2, 46.3, 30, "gunshot", sim.time, "ann")
    tick({}, 120)
    expect(heard.filter((e) => e.kind === "alarm")).toHaveLength(0)
    expect(sim.progression.alarmRinging(sim.progression.cars.find((c) => c.key === key)!, sim.time)).toBe(false)
  })
})
