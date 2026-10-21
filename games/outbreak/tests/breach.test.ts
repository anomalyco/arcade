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
  })
})

describe("staged door scenes (outbreak-breach station)", () => {
  test("each breach scene gives the way it is labelled, staged one after another in one session", async () => {
    const { LocalSession } = await import("../shared/session")
    const { stageBreach, applyStageHold } = await import("../src/breach/stage")
    const expectKind: Record<string, number> = { giving: KIND_HINGES, "split-door": KIND_SPLIT, crush: KIND_CRUSH, boards: KIND_BOARDS, burst: KIND_BURST }
    // One session, as the station and the clip use it: by the second scene the director's safehouse calm would turn
    // the staged dead away from the door unless the stage keeps them on it.
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0, openingCalm: 0 })
    for (const scene of ["holed", "giving", "split-door", "crush", "boards", "burst", "brace"] as const) {
      const host = {
        progressionHost: {
          view: () => session.view,
          pose: (x: number, y: number, aim: number) => Object.assign(session.view.player, { x, y, aim, vx: 0, vy: 0 }),
          setHour: (h: number) => (session.view.hour = h),
          hud: null as never,
          offline: () => true,
        },
        session: () => session,
      }
      const staged = stageBreach(host, scene)
      const aim = session.view.player.aim
      let braced = 0
      for (let i = 0; i < 60 * 4; i++) {
        session.update(TICK_DT, { mx: 0, my: 0, aim, interact: false }, 0)
        applyStageHold(session.sim)
        braced = Math.max(braced, session.sim.getFeatureState<BreachState>("breach")!.portals[staged.portal]?.braced ?? 0)
      }
      const w = session.sim.getFeatureState<BreachState>("breach")!.portals[staged.portal]
      if (scene === "holed") {
        expect(w?.holed).toBe(true)
        expect(w?.broken).toBe(false)
        continue
      }
      if (scene === "brace") {
        expect(braced).toBe(1)
        continue
      }
      const first = session.sim.getFeatureState<BreachState>("breach")!.events.findLast((e) => e.portalId === staged.portal)
      expect(`${scene}:${first?.kind}`).toBe(`${scene}:${expectKind[scene]}`)
    }
  }, 30_000)
})

describe("breach presenter (AR-97)", () => {
  test("draws the damaged door itself, throws pieces on a breach, and lights the gaps", async () => {
    const { LocalSession } = await import("../shared/session")
    const { stageBreach, applyStageHold } = await import("../src/breach/stage")
    const { BreachPresenter } = await import("../src/breach/presenter")
    const { DEFAULT_BREACH_SETTINGS } = await import("../src/breach/settings")
    let models = 0
    const presenter = new BreachPresenter({ addModel: () => models++ })
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0, openingCalm: 0 })
    const host = {
      progressionHost: {
        view: () => session.view,
        pose: (x: number, y: number, aim: number) => Object.assign(session.view.player, { x, y, aim, vx: 0, vy: 0 }),
        setHour: (h: number) => (session.view.hour = h),
        hud: null as never,
        offline: () => true,
      },
      session: () => session,
    }
    const seen = { drawn: false, maxDebris: 0, maxLights: 0, slabDrawn: false, stages: new Set<string>(), reactiveDebris: false, reactiveDoor: false }
    for (const scene of ["split", "crush"] as const) {
      presenter.reset()
      stageBreach(host, scene)
      for (let i = 0; i < 60 * 5; i++) {
        session.update(TICK_DT, { mx: 0, my: 0, aim: Math.PI / 2, interact: false }, 0)
        applyStageHold(session.sim)
        presenter.update({ session, settings: DEFAULT_BREACH_SETTINGS, cam: null, dt: TICK_DT })
        const lights = new Float32Array(64 * 16)
        seen.maxLights = Math.max(seen.maxLights, presenter.writeLights(lights, 0, 64))
        const batches = presenter.batches()
        seen.drawn ||= presenter.drawsDoor(session.view.town.doors.find((d) => d.id === DOOR)!)
        seen.maxDebris = Math.max(seen.maxDebris, presenter.stats.debris)
        if (scene === "crush" && session.sim.getFeatureState<BreachState>("breach")!.portals[DOOR]?.broken) seen.slabDrawn ||= batches.some((b) => b.model === 0 && b.count > 0)
        seen.stages.add(presenter.stats.stages[DOOR] ?? "")
        // Splinters, chunks, jambs, planks and glass (models 9+) fly: TAA's reactive mask; the door itself does not.
        seen.reactiveDebris ||= batches.some((b) => b.model >= 9 && b.reactive)
        seen.reactiveDoor ||= batches.some((b) => b.model < 9 && b.reactive)
      }
    }
    expect(models).toBe(14)
    expect(seen.drawn).toBe(true)
    expect(seen.maxDebris).toBeGreaterThan(10)
    expect(seen.maxLights).toBeGreaterThan(0)
    expect(seen.slabDrawn).toBe(true)
    expect(seen.reactiveDebris).toBe(true)
    expect(seen.reactiveDoor).toBe(false)
    expect([...seen.stages]).toContain("broken")
    expect(presenter.stats.breaches).toContain("crush")
  }, 30_000)
})
