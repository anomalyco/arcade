import { describe, expect, test } from "bun:test"
import { TICK_DT } from "../shared/clock"
import { CoopSim, type SurvivorSlot } from "../shared/coop-sim"
import { throwableSite } from "../shared/interactions/toss-sites"
import { OUT_BONK, OUT_HIT, planToss, THROWABLES, throwPower, tossAt } from "../shared/interactions/throwables"
import { DEFAULT_INTERACTIONS_TUNING, type InteractionsTuning } from "../shared/interactions/tuning"
import type { Command } from "../shared/session"

const idle = (aim = 0): Command => ({ mx: 0, my: 0, aim, interact: false })
const ticks = (seconds: number) => Math.ceil(seconds / TICK_DT)

function room(pose: { x: number; y: number; aim: number }, tuning: Partial<InteractionsTuning> = {}) {
  const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
  sim.hour = 22
  Object.assign(sim.addSurvivor("ann", 0).survivor, pose)
  sim.rebuildSolids()
  const settings = { interactions: { ...DEFAULT_INTERACTIONS_TUNING, ...tuning } } as never
  const tick = (cmd: Partial<Command> = {}, n = 1) => {
    for (let k = 0; k < n; k++) {
      for (const s of sim.slots) sim.stepSurvivor(s, { ...idle(s.survivor.aim), ...cmd }, TICK_DT, settings)
      sim.stepWorld(TICK_DT, 0, settings)
    }
  }
  const heard: { kind: string; radius: number; x: number; y: number }[] = []
  const emit = sim.ai.emitNoise.bind(sim.ai)
  sim.ai.emitNoise = (x, y, radius, kind, ...rest) => {
    heard.push({ kind, radius, x, y })
    return emit(x, y, radius, kind, ...rest)
  }
  const ledger = sim.progression.ledger
  const slot = sim.slot("ann")!
  const hold = (item: string, count = 1) => {
    ledger.apply({ kind: "grant", actor: slot.id, item, count })
    const i = sim.progression.hotbar(slot.id)?.slots.findIndex((s) => s?.item === item) ?? -1
    if (i >= 0) ledger.apply({ kind: "select", actor: slot.id, slot: i })
    sim.progression.project(slot)
  }
  const zombie = (x: number, y: number) => {
    const z = sim.ai.spawnZombie(sim.town, x, y, "wander")
    z.speedScale = 0
    return z
  }
  const throwFor = (seconds: number) => {
    tick({ fire: true, fireHeld: true })
    tick({ fireHeld: true }, Math.max(0, ticks(seconds) - 1))
    tick({ fireHeld: false })
  }
  const drops = () => [...ledger.stores.values()].filter((s) => s.id.startsWith("drop:t:"))
  return { sim, tick, ledger, slot, hold, zombie, throwFor, drops, noises: (kind: string) => heard.filter((e) => e.kind === kind) }
}

const street = { x: 30, y: 46, aim: 0 }

describe("throwables", () => {
  test("holding longer throws further; a tap is a short lob", () => {
    const t = DEFAULT_INTERACTIONS_TUNING
    expect(throwPower(0, t)).toBeCloseTo(t.throwTap)
    expect(throwPower(t.throwWindup, t)).toBe(1)
    const tap = planToss(0, 0, 0, throwPower(0, t), THROWABLES.baseball, 1, [], [], [])
    const full = planToss(0, 0, 0, 1, THROWABLES.baseball, 1, [], [], [])
    expect(full.ix).toBeGreaterThan(tap.ix * 2.5)
  })

  test("a baseball winds up, flies, bonks one of the dead down and lies there to be picked up again", () => {
    const { sim, tick, hold, zombie, throwFor, drops, ledger, slot } = room(street)
    hold("baseball")
    const z = zombie(34.5, 46)
    const hp = z.hp
    // A flat throw at a head six metres off: a quick tap, which flies at head height.
    throwFor(0)
    expect(ledger.count(slot.id, "baseball")).toBe(0)
    const st = ledger.store("toss:0")!
    expect(st.counts.out! & OUT_HIT).toBeTruthy()
    expect(st.counts.out! & OUT_BONK).toBeTruthy()
    tick({}, ticks(1.4))
    expect(z.hp).toBeLessThan(hp)
    expect(["knockdown", "dead"]).toContain(z.state)
    expect(drops().length).toBe(1)
    expect(sim.progression.contents(drops()[0]!.id)[0]?.item).toBe("baseball")
  })

  test("a can lobbed long flies over the heads in the middle and is heard where it lands", () => {
    const { tick, hold, zombie, throwFor, ledger, noises } = room(street)
    hold("tin-can")
    const z = zombie(36, 46)
    throwFor(1)
    tick({}, ticks(1.5))
    expect(z.state).not.toBe("stagger")
    const st = ledger.store("toss:0")!
    expect(st.counts.out! & OUT_HIT).toBe(0)
    const heard = noises("cans")
    expect(heard.length).toBe(1)
    expect(heard[0]!.x).toBeGreaterThan(40)
  })

  test("a bottle shatters into glass where it lands and leaves nothing to pick up", () => {
    const { tick, hold, throwFor, ledger, drops, noises } = room(street)
    hold("bottle")
    throwFor(0.4)
    tick({}, ticks(1.5))
    expect(noises("glass").length).toBe(1)
    expect([...ledger.stores.keys()].some((id) => id.startsWith("glass:"))).toBe(true)
    expect(drops().length).toBe(0)
  })

  test("Today (throwables off): a bottle is the old instant fixed-range throw", () => {
    const { tick, hold, ledger, noises } = room(street, { throwables: 0 })
    tick()
    hold("bottle")
    tick({ fire: true, fireHeld: true })
    expect(noises("glass").length).toBe(1)
    expect(ledger.store("toss:0")).toBeUndefined()
  })

  test("a brick goes through a shut window, breaking it", () => {
    const { sim, tick, hold, throwFor, noises } = room(street)
    const w = sim.town.windows.find((x) => !x.open && !x.boarded)!
    const cx = (w.rect[0] + w.rect[2]) / 2
    const cy = (w.rect[1] + w.rect[3]) / 2
    const horizontal = w.rect[2] - w.rect[0] > w.rect[3] - w.rect[1]
    const p = sim.slot("ann")!.survivor
    // Stand four metres off the glass, facing it, on whichever side is open ground.
    const nx = horizontal ? 0 : 1
    const ny = horizontal ? 1 : 0
    const side = sim.solids.some((r) => cx + nx * 4 > r[0] && cx + nx * 4 < r[2] && cy + ny * 4 > r[1] && cy + ny * 4 < r[3]) ? -1 : 1
    p.x = cx + nx * 4 * side
    p.y = cy + ny * 4 * side
    p.aim = Math.atan2(cy - p.y, cx - p.x)
    hold("brick")
    throwFor(0.75)
    tick({ aim: p.aim }, ticks(1.5))
    expect(w.open).toBe(true)
    expect(noises("glass").length).toBeGreaterThan(0)
  })

  test("the flight reads the same on every seat: from the hand, up the arc, down to rest", () => {
    const { sim, hold, throwFor, ledger } = room(street)
    hold("rock")
    throwFor(0.75)
    const st = ledger.store("toss:0")!
    const t0 = st.counts.t! / 10
    const start = tossAt(st, t0)!
    const mid = tossAt(st, t0 + st.counts.fl! / 20)!
    const end = tossAt(st, t0 + 5)!
    expect(start.x).toBeCloseTo(30.35, 1)
    expect(mid.h).toBeGreaterThan(start.h)
    expect(end.phase).toBe(2)
    expect(end.x).toBeCloseTo(st.at!.x, 5)
  })

  test("some houses have one lying about, seeded from the town alone", () => {
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    const houses = sim.town.buildings.filter((b) => b.kind === "house")
    const sites = houses.map((b) => throwableSite(sim.town, b, 1)).filter(Boolean)
    expect(sites.length).toBeGreaterThan(0)
    expect(houses.map((b) => throwableSite(sim.town, b, 1))).toEqual(houses.map((b) => throwableSite(sim.town, b, 1)))
    expect(houses.every((b) => throwableSite(sim.town, b, 0) === null)).toBe(true)
  })
})

export type { SurvivorSlot }
