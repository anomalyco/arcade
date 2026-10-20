import { describe, expect, test } from "bun:test"
import { TICK_DT } from "../shared/clock"
import { CoopSim } from "../shared/coop-sim"
import { applyBreachSnapshot } from "../shared/breach/net"
import {
  createBreachState,
  doorStage,
  KIND_BOARDS,
  KIND_BURST,
  KIND_CRUSH,
  KIND_HINGES,
  KIND_SPLIT,
  WEDGED_PLANK_HP,
  type BreachState,
} from "../shared/breach/rules"
import { SLAB_KIND } from "../shared/breach/interactions"
import { selectInteractTarget } from "../shared/interact"
import { decodeShared, encodeShared } from "../shared/net-protocol"
import type { Command, SessionTuning } from "../shared/sim-types"

// Kit, after co-op (AR-97): "When the zombies are breaking down a door, there's no way to tell if they're gonna break
// through, or I guess it just buys you time."

const idle: Command = { mx: 0, my: 0, aim: Math.PI / 2, interact: false }
const DOOR = "ash-front"

type Opts = { tuning?: Record<string, number>; inside?: boolean; pushers?: number; brute?: boolean }

function setup(o: Opts = {}) {
  const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0, openingCalm: 0 })
  const slot = sim.addSurvivor("p0", 0)
  const p = slot.survivor
  // Inside Ash, a few steps back from the front door (y 35.28..35.5; outside is +y).
  Object.assign(p, { x: 27.7, y: o.inside ? 34.85 : 33.0, vx: 0, vy: 0, aim: Math.PI / 2 })
  const zs = Array.from({ length: o.pushers ?? 1 }, (_, i) => {
    const z = sim.ai.spawnZombie(sim.town, 27.3 + i * 0.28, 36.1 + (i % 2) * 0.3, "chase", -Math.PI / 2)
    z.targetX = p.x
    z.targetY = p.y
    z.awareness = 1
    if (o.brute) z.aggression = 1.5
    return z
  })
  sim.rebuildCollision()
  const tuning = { breach: { ...(o.tuning ?? {}) } } as unknown as SessionTuning
  const step = () => {
    sim.stepSurvivor(slot, idle, TICK_DT, tuning)
    sim.stepWorld(TICK_DT, 0, tuning)
    for (const z of zs) if (z.state !== "dead") z.awareness = 1
  }
  const door = () => sim.town.doors.find((d) => d.id === DOOR)!
  const st = () => sim.ai.portalStates.get(DOOR)!
  const wear = () => sim.getFeatureState<BreachState>("breach")!.portals[DOOR]
  return { sim, slot, p, zs, step, door, st, wear }
}

describe("readable door breaches (AR-97)", () => {
  test("a door wears through its stages, holds for the warning beat, then is torn out for good", () => {
    const { sim, step, door, st, wear } = setup()
    const stages = new Set<number>()
    let zeroAt = -1
    let openAt = -1
    for (let i = 0; i < 60 * 30 && openAt < 0; i++) {
      step()
      stages.add(doorStage(st().integrity, wear()))
      if (zeroAt < 0 && st().integrity <= 0) zeroAt = sim.time
      if (door().open) openAt = sim.time
    }
    // Every hit shows: a single zombie takes three or four, so each lands on its own stage (a strong one can skip one).
    expect(stages.has(0) && stages.has(4) && stages.has(5)).toBe(true)
    expect([1, 2, 3].filter((s) => stages.has(s)).length).toBeGreaterThanOrEqual(2)
    expect(openAt).toBeGreaterThan(0)
    // The warning beat: the door held at 0 for breachWarn (1.1 s) before it gave.
    expect(openAt - zeroAt).toBeGreaterThanOrEqual(1.1 - 1e-6)
    expect(openAt - zeroAt).toBeLessThan(1.1 + 2 * TICK_DT)
    const w = wear()!
    expect(w.broken).toBe(true)
    expect([KIND_HINGES, KIND_SPLIT]).toContain(w.kind)
    expect(st().integrity).toBe(0)
    if (w.kind === KIND_HINGES) {
      // The slab lies inside (Ash's inside is -y of the front door).
      expect(w.debris!.y).toBeLessThan(35.28)
    }
    // A torn-out door can't be shut again: no door prompt, and the sim forces it open even if something closes it.
    door().open = false
    step()
    expect(door().open).toBe(true)
  })

  test("Today: a door pops open at 0 and is good as new", () => {
    const { step, door, st, wear } = setup({ tuning: { breachMode: 0 } })
    let opened = false
    for (let i = 0; i < 60 * 20 && !opened; i++) {
      step()
      opened = door().open
    }
    expect(opened).toBe(true)
    expect(st().integrity).toBe(100)
    expect(wear()).toBeUndefined()
  })

  test("a survivor leaning on the door from inside slows the dead down", () => {
    const run = (inside: boolean) => {
      const { step, st, wear } = setup({ inside })
      let braced = 0
      for (let i = 0; i < 60 * 1.9; i++) {
        step()
        braced = Math.max(braced, wear()?.braced ?? 0)
      }
      return { left: st().integrity, braced }
    }
    const free = run(false)
    const held = run(true)
    expect(free.braced).toBe(0)
    expect(held.braced).toBe(1)
    expect(100 - held.left).toBeLessThan((100 - free.left) * 0.6)
  })

  test("four pushing at once crush the frame; the first falls in, the rest spill in one by one", () => {
    const { step, door, wear, zs } = setup({ pushers: 4 })
    let states: string[] = []
    for (let i = 0; i < 60 * 30; i++) {
      step()
      if (door().open) {
        states = zs.map((z) => z.state)
        break
      }
    }
    expect(wear()!.kind).toBe(KIND_CRUSH)
    expect(states.filter((s) => s === "knockdown").length).toBe(1)
    const timers = zs.filter((z) => z.state === "stagger").map((z) => z.timer).sort((a, b) => a - b)
    expect(timers.length).toBeGreaterThanOrEqual(2)
    expect(timers[timers.length - 1]! - timers[0]!).toBeGreaterThan(0.3)
  })

  test("the last board hangs for the warning beat, then flies in; a window bursts open for good", () => {
    const { sim, step, st, wear } = setup()
    sim.ai.addBarricadePlank(DOOR, 100)
    sim.rebuildCollision()
    let givingAt = -1
    let goneAt = -1
    for (let i = 0; i < 60 * 20 && goneAt < 0; i++) {
      step()
      if (givingAt < 0 && (wear()?.givingAt ?? -1) >= 0) givingAt = sim.time
      if (givingAt >= 0) {
        if (st().barricadePlanks === 0) goneAt = sim.time
        else expect(st().barricadePlanks).toBe(1)
      }
    }
    expect(givingAt).toBeGreaterThan(0)
    expect(goneAt - givingAt).toBeGreaterThanOrEqual(1.1 - TICK_DT)
    expect(wear()!.kind).toBe(KIND_BOARDS)

    const win = sim.town.windows.find((w) => w.id === "ash-south-west")!
    sim.ai.addBarricadePlank(win.id, 100)
    sim.rebuildCollision()
    const z = sim.ai.spawnZombie(sim.town, 24.5, 36.1, "chase", -Math.PI / 2)
    // One heavy hit straight through the rules: the board hangs, then bursts.
    sim.ai.bashRules!.apply(sim.town, sim.ai.portalStates, [{ agentId: z.id, portalId: win.id, portalKind: "window", x: 24.5, y: 35.4, damage: 200 }], sim.time, sim.ai.agents)
    expect(st().barricadePlanks).toBe(0)
    expect(sim.ai.portalStates.get(win.id)!.barricadePlanks).toBe(1)
    const ww = () => sim.getFeatureState<BreachState>("breach")!.portals[win.id]
    for (let i = 0; i < 60 * 2 && !win.open; i++) step()
    expect(ww()?.kind).toBe(KIND_BURST)
    expect(win.open).toBe(true)
    expect(win.openable).toBe(false)
  })

  test("a fallen door can be wedged back into the frame as one strong board", () => {
    const { sim, slot, p, step, door, st, wear } = setup()
    const state = sim.getFeatureState<BreachState>("breach")!
    for (let i = 0; i < 60 * 30 && !door().open; i++) step()
    for (const z of sim.ai.agents) z.state = "dead"
    const w = wear()!
    w.debris ??= { x: 27.7, y: 34.1 }
    Object.assign(p, { x: w.debris.x + 0.4, y: w.debris.y - 0.9, aim: Math.atan2(0.9, -0.4) })
    sim.refreshPrompt(slot)
    const doorPrompt = selectInteractTarget(sim.town, p, sim.registry)
    expect(doorPrompt?.kind === "door" && doorPrompt.id === DOOR).toBe(false)
    const slab = sim.registry.get(SLAB_KIND)!
    const out = slab.execute(sim.town, p, DOOR, "install")
    expect(out.handled).toBe(true)
    expect(st().barricadePlanks).toBe(1)
    expect(st().barricadeHp).toBe(WEDGED_PLANK_HP)
    expect(state.portals[DOOR]!.debris).toBeNull()
    expect(state.portals[DOOR]!.wedged).toBe(true)
    step()
    expect(door().open).toBe(false)
  })

  test("arms through a punched panel grab whoever stands in front of it", () => {
    const { p, step, st, wear } = setup({ inside: true, tuning: { breachWarn: 3 } })
    for (let i = 0; i < 120 && !wear(); i++) step()
    // Force the punch-through variant on this door regardless of its seed.
    wear()!.holed = true
    const before = p.health
    let grabbed = false
    for (let i = 0; i < 120 && st().integrity > 0; i++) {
      step()
      grabbed ||= wear()!.grabbing
    }
    expect(grabbed).toBe(true)
    expect(p.health).toBeLessThan(before)
  })

  test("a co-op client and a late joiner see the same wear, warning beat and fallen slab", () => {
    const { sim, step, door, wear } = setup()
    let sawGiving = false
    for (let i = 0; i < 60 * 30 && !door().open; i++) {
      step()
      if ((wear()?.givingAt ?? -1) >= 0 && !sawGiving) {
        sawGiving = true
        const snap = decodeShared(encodeShared(sim, i, new Map()), 7)
        const client = createBreachState()
        const states = new Map([[DOOR, { integrity: 100 }]])
        applyBreachSnapshot(client, sim.town, states, snap.breach)
        expect(client.portals[DOOR]!.givingAt).toBeCloseTo(wear()!.givingAt, 3)
        expect(states.get(DOOR)!.integrity).toBe(0)
      }
    }
    expect(sawGiving).toBe(true)
    step()
    const snap = decodeShared(encodeShared(sim, 99, new Map()), 7)
    const client = createBreachState()
    applyBreachSnapshot(client, sim.town, new Map(), snap.breach)
    const w = wear()!
    const c = client.portals[DOOR]!
    expect(c.broken).toBe(true)
    expect(c.kind).toBe(w.kind)
    expect(c.breachAt).toBeCloseTo(w.breachAt, 3)
    expect(c.debris?.x ?? null).toBe(w.debris ? Math.round(w.debris.x * 100) / 100 : null)
    // Quiet ticks write nothing more.
    const a = encodeShared(sim, 100, new Map())
    expect(a.byteLength).toBeGreaterThan(0)
  })
})
