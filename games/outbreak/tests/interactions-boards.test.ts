import { describe, expect, test } from "bun:test"
import { TICK_DT } from "../shared/clock"
import { CoopSim } from "../shared/coop-sim"
import { HOLD_DURATION } from "../shared/interact"
import { freshWear, type BreachState } from "../shared/breach/rules"
import { BOARDS_KIND } from "../shared/interactions/boards"
import { DEFAULT_INTERACTIONS_TUNING, type InteractionsTuning } from "../shared/interactions/tuning"
import { DEFAULT_PROGRESSION_TUNING } from "../shared/progression/tuning"
import type { Command } from "../shared/session"

const idle = (aim = 0): Command => ({ mx: 0, my: 0, aim, interact: false })
const ticks = (seconds: number) => Math.ceil(seconds / TICK_DT)
const T = DEFAULT_PROGRESSION_TUNING

/** Ann just outside Ash's front door, facing it, with `planks` in her belt. */
function atDoor(planks: number, tuning: Partial<InteractionsTuning> = {}) {
  const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
  sim.hour = 12
  sim.addSurvivor("ann", 0)
  sim.rebuildSolids()
  const settings = { interactions: { ...DEFAULT_INTERACTIONS_TUNING, ...tuning } } as never
  const ann = sim.slot("ann")!
  const door = sim.town.doors.find((d) => d.id === "ash-front")!
  door.open = false
  const aim = Math.PI / 2
  Object.assign(ann.survivor, { x: (door.rect[0] + door.rect[2]) / 2, y: door.rect[1] - 1, aim })
  const ledger = sim.progression.ledger
  const have = ledger.count("ann", "plank")
  if (planks > have) ledger.apply({ kind: "grant", actor: "ann", item: "plank", count: planks - have })
  const tick = (cmd: Partial<Command> = {}, n = 1) => {
    for (let k = 0; k < n; k++) {
      sim.stepSurvivor(ann, { ...idle(aim), ...cmd }, TICK_DT, settings)
      sim.stepWorld(TICK_DT, 0, settings)
    }
  }
  tick()
  return { sim, ann, door, tick, planks: () => sim.ai.getBarricadePlanks(door.id), belt: () => ledger.count("ann", "plank") }
}

describe("boarding up", () => {
  test("one B keeps nailing boards until the door is full", () => {
    const { tick, planks, belt } = atDoor(4)
    tick({ barricade: true })
    tick({}, ticks(T.barricadeTime * 3 + 1))
    expect(planks()).toBe(3)
    expect(belt()).toBe(1)
  })

  test("it stops when the planks run out", () => {
    const { tick, planks, belt } = atDoor(2)
    tick({ barricade: true })
    tick({}, ticks(T.barricadeTime * 3 + 1))
    expect(planks()).toBe(2)
    expect(belt()).toBe(0)
  })

  test("Today (chain off): one board per B", () => {
    const { tick, planks } = atDoor(4, { boardChain: 0 })
    tick({ barricade: true })
    tick({}, ticks(T.barricadeTime * 3 + 1))
    expect(planks()).toBe(1)
  })
})

describe("prying a board off", () => {
  test("hold E at a boarded door: one board comes off and goes back in the belt; the tap is still refused", () => {
    const { sim, ann, door, tick, planks, belt } = atDoor(2, { boardChain: 0 })
    sim.ai.addBarricadePlank(door.id)
    sim.ai.addBarricadePlank(door.id)
    tick()
    expect(ann.prompt?.secondary?.label).toBe("Pry off a board")
    expect(ann.prompt?.secondary?.hold).toBe(true)
    tick({ interact: true, interactHeld: true })
    expect(door.open).toBe(false)
    expect(ann.survivor.lootMessage).toContain("hold E")
    tick({ interactHeld: true }, ticks(HOLD_DURATION + 0.05))
    expect(ann.survivor.channel?.kind).toBe("unboard")
    expect(sim.ai.noiseBus.snapshot().events.some((e: { kind: string }) => e.kind === "barricade")).toBe(true)
    tick({}, ticks(T.unboardTime + 0.2))
    expect(planks()).toBe(1)
    expect(belt()).toBe(3)
  })

  test("picking Pry off a board from the radial pries; an action the door doesn't offer is ignored", () => {
    const { sim, ann, door, tick, planks, belt } = atDoor(2, { boardChain: 0 })
    sim.ai.addBarricadePlank(door.id)
    sim.ai.addBarricadePlank(door.id)
    tick()
    tick({ interact: true, interactAction: "hide" })
    expect(ann.survivor.channel?.kind).not.toBe("unboard")
    tick({ interact: true, interactAction: "pry" })
    expect(ann.survivor.channel?.kind).toBe("unboard")
    tick({}, ticks(T.unboardTime + 0.2))
    expect(planks()).toBe(1)
    expect(belt()).toBe(3)
  })

  test("a boarded window's hold pries too, without peeking first", () => {
    const { sim, ann, tick } = atDoor(0)
    const win = sim.town.windows.find((w) => w.id.startsWith("ash"))!
    sim.ai.addBarricadePlank(win.id)
    const aim = -Math.PI / 2
    const cx = (win.rect[0] + win.rect[2]) / 2
    const cy = (win.rect[1] + win.rect[3]) / 2
    // Stand off the window's long side, facing it.
    const horizontal = win.rect[2] - win.rect[0] > win.rect[3] - win.rect[1]
    Object.assign(ann.survivor, horizontal ? { x: cx, y: cy + 1, aim } : { x: cx + 1, y: cy, aim: Math.PI })
    const face = ann.survivor.aim
    tick({ aim: face })
    expect(ann.prompt?.id).toBe(win.id)
    expect(ann.prompt?.secondary?.label).toBe("Pry off a board")
    tick({ aim: face, interact: true, interactHeld: true })
    tick({ aim: face, interactHeld: true }, ticks(HOLD_DURATION + 0.05))
    expect(ann.survivor.peekingWindowId).toBe(null)
    tick({ aim: face }, ticks(T.unboardTime + 0.2))
    expect(sim.ai.getBarricadePlanks(win.id)).toBe(0)
  })

  test("a doorway whose door the dead tore off, boarded since: hold E still pries, a tap does not", () => {
    const { sim, ann, door, tick, planks } = atDoor(0, { boardChain: 0 })
    tick()
    const breach = sim.getFeatureState<BreachState>("breach")!
    expect(breach.on).toBe(true)
    breach.portals[door.id] = { ...freshWear(), broken: true }
    door.open = true
    sim.ai.addBarricadePlank(door.id)
    sim.ai.addBarricadePlank(door.id)
    tick()
    expect(ann.prompt?.kind).toBe(BOARDS_KIND)
    tick({ interact: true })
    tick({}, ticks(T.unboardTime + 0.2))
    expect(planks()).toBe(2)
    tick({ interact: true, interactHeld: true })
    tick({ interactHeld: true }, ticks(HOLD_DURATION + 0.05))
    tick({}, ticks(T.unboardTime + 0.2))
    expect(planks()).toBe(1)
  })

  test("Today (pry off): a boarded door's hold does not pry", () => {
    const { sim, ann, door, tick, planks } = atDoor(0, { pryBoards: 0 })
    sim.ai.addBarricadePlank(door.id)
    tick()
    expect(ann.prompt?.secondary?.label).not.toBe("Pry off a board")
    tick({ interact: true, interactHeld: true })
    tick({ interactHeld: true }, ticks(HOLD_DURATION + T.unboardTime + 0.3))
    expect(planks()).toBe(1)
  })
})
