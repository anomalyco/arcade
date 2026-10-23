import { describe, expect, test } from "bun:test"
import { createWorld, FEEL, type FeelConfig, type JackInput, newJack, newTree, NO_INPUT, sawTarget, stepWorld, type World } from "../shared/sim"
import { landAngle, predictedFall } from "../shared/trees"

const DT = 1 / 60
const feel: FeelConfig = { ...FEEL, mode: "ffa", botCount: 0 }

/** An empty clearing with the given trees and lumberjacks (no bots thinking unless asked). */
function clearing(): World {
  const w = createWorld(7, { ...feel, treeCount: 0 })
  w.trees = []
  w.jacks = [newJack(0, false, 0, 0)]
  return w
}

function addTree(w: World, x: number, y: number, h = 20, cut = 0) {
  const t = newTree(w.trees.length, x, y, h)
  t.cut = cut
  w.trees.push(t)
  return t
}

function run(w: World, seconds: number, input: (w: World) => JackInput[] = () => [], f: FeelConfig = feel) {
  for (let i = 0; i < Math.round(seconds / DT); i++) stepWorld(w, input(w), DT, f)
}

const sawAt = (aim: number): JackInput => ({ ...NO_INPUT, aim, saw: true })

describe("felling", () => {
  test("a tree falls away from the side it was cut from", () => {
    for (const [side, ax, ay] of [["west", -1, 0], ["east", 1, 0], ["south", 0, -1], ["north", 0, 1]] as const) {
      const w = clearing()
      const t = addTree(w, 0, 0)
      const me = w.jacks[0]!
      me.x = ax * 0.75
      me.y = ay * 0.75
      const aim = Math.atan2(-ay, -ax)
      run(w, feel.cutTime + 0.2, () => [sawAt(aim)])
      expect(t.state, side).not.toBe("standing")
      expect(t.fx, side).toBeCloseTo(-ax, 3)
      expect(t.fy, side).toBeCloseTo(-ay, 3)
    }
  })

  test("it creaks at the warning point, then tips slowly and lands fast", () => {
    const w = clearing()
    const t = addTree(w, 0, 0)
    w.jacks[0]!.x = -0.75
    const kinds: string[] = []
    let fellAt = -1
    let landAt = -1
    let landSpeed = 0
    for (let i = 0; i < 60 * 12 && landAt < 0; i++) {
      stepWorld(w, [sawAt(0)], DT, feel)
      for (const e of w.events) {
        kinds.push(e.kind)
        if (e.kind === "fell") fellAt = w.t
        if (e.kind === "land") {
          landAt = w.t
          landSpeed = e.speed
        }
      }
    }
    expect(kinds.indexOf("warn")).toBeGreaterThanOrEqual(0)
    expect(kinds.indexOf("warn")).toBeLessThan(kinds.indexOf("fell"))
    expect(landAt - fellAt).toBeGreaterThan(1)
    expect(landAt - fellAt).toBeLessThan(5)
    expect(landSpeed).toBeGreaterThan(10)
    run(w, 2)
    expect(t.state).toBe("down")
    expect(t.theta).toBeCloseTo(landAngle(t), 6)
  })

  test("the ground preview predicts the fall before the cut", () => {
    const t = newTree(0, 0, 0, 20)
    const p = predictedFall(t, -0.7, 0.3)
    expect(p.x).toBeGreaterThan(0.9)
    t.cdx = 0
    t.cdy = 1
    expect(predictedFall(t, -0.7, 0).y).toBeGreaterThan(0.9)
  })
})

describe("crush", () => {
  test("anyone under the trunk dies instantly and the cutter gets the kill", () => {
    const w = clearing()
    addTree(w, 0, 0)
    w.jacks[0]!.x = -0.75
    const victim = newJack(1, false, 6, 0)
    w.jacks.push(victim)
    run(w, 8, () => [sawAt(0), NO_INPUT])
    expect(victim.alive).toBe(false)
    expect(victim.cause).toBe("crush")
    expect(victim.killedBy).toBe(0)
  })

  test("the crown kills off the trunk line, the clear side lives", () => {
    const w = clearing()
    addTree(w, 0, 0, 20)
    w.jacks[0]!.x = -0.75
    const inCrown = newJack(1, false, 15, 1.3)
    const clear = newJack(2, false, 15, 5)
    const pastTip = newJack(3, false, 23, 0)
    w.jacks.push(inCrown, clear, pastTip)
    run(w, 8, () => [sawAt(0), NO_INPUT, NO_INPUT, NO_INPUT])
    expect(inCrown.alive).toBe(false)
    expect(clear.alive).toBe(true)
    expect(pastTip.alive).toBe(true)
  })

  test("the cutter behind the stump survives", () => {
    const w = clearing()
    addTree(w, 0, 0)
    w.jacks[0]!.x = -0.75
    w.jacks.push(newJack(1, false, 0, 10))
    run(w, 8, () => [sawAt(0)])
    expect(w.jacks[0]!.alive).toBe(true)
  })
})

describe("dominoes", () => {
  test("a falling tree knocks over a partly cut tree in its path, which crushes beyond", () => {
    const w = clearing()
    const a = addTree(w, 0, 0, 20)
    const b = addTree(w, 8, 0.2, 20, 0.5)
    const c = addTree(w, 16, -0.2, 20, 0.5)
    w.jacks[0]!.x = -0.75
    const far = newJack(1, false, 30, 0)
    w.jacks.push(far)
    const dominos: number[] = []
    for (let i = 0; i < 60 * 14; i++) {
      stepWorld(w, [sawAt(0), NO_INPUT], DT, feel)
      for (const e of w.events) if (e.kind === "domino") dominos.push(e.tree)
    }
    expect(a.state).toBe("down")
    expect(b.state).toBe("down")
    expect(c.state).toBe("down")
    expect(dominos).toEqual([b.id, c.id])
    expect(b.fx).toBeCloseTo(1, 3)
    expect(far.alive).toBe(false)
    expect(far.killedBy).toBe(0)
  })

  test("a sound tree shrugs it off", () => {
    const w = clearing()
    addTree(w, 0, 0, 20)
    const sound = addTree(w, 8, 0.2, 20, 0.1)
    w.jacks[0]!.x = -0.75
    const kinds: string[] = []
    for (let i = 0; i < 60 * 10; i++) {
      stepWorld(w, [sawAt(0)], DT, feel)
      for (const e of w.events) kinds.push(e.kind)
    }
    expect(sound.state).toBe("standing")
    expect(kinds).toContain("brush")
  })

  test("the threshold is a knob", () => {
    const w = clearing()
    addTree(w, 0, 0, 20)
    const b = addTree(w, 8, 0.2, 20, 0.1)
    w.jacks[0]!.x = -0.75
    run(w, 10, () => [sawAt(0)], { ...feel, dominoThreshold: 0 })
    expect(b.state).toBe("down")
  })
})

describe("saw fight", () => {
  test("the saw prefers a lumberjack over a trunk and kills with continuous contact", () => {
    const w = clearing()
    addTree(w, 0.9, 0.3)
    const v = newJack(1, false, 1, 0)
    w.jacks.push(v)
    w.jacks[0]!.aim = 0
    expect(sawTarget(w, w.jacks[0]!, feel)).toEqual({ kind: "jack", id: 1 })
    const kinds: string[] = []
    for (let i = 0; i < 60 * 3 && v.alive; i++) {
      stepWorld(w, [sawAt(0), NO_INPUT], DT, feel)
      for (const e of w.events) kinds.push(e.kind)
    }
    expect(v.alive).toBe(false)
    expect(v.cause).toBe("saw")
    expect(kinds[0]).toBe("sawStart")
    expect(kinds).toContain("gore")
    expect(kinds).toContain("kill")
  })

  test("letting go of the trigger flings the victim", () => {
    const w = clearing()
    const v = newJack(1, false, 1, 0)
    w.jacks.push(v)
    run(w, 0.3, () => [sawAt(0), NO_INPUT])
    const hp = v.hp
    expect(hp).toBeLessThan(100)
    let flung = false
    stepWorld(w, [{ ...NO_INPUT, aim: 0 }, NO_INPUT], DT, feel)
    for (const e of w.events) if (e.kind === "fling") flung = true
    expect(flung).toBe(true)
    expect(v.vx).toBeGreaterThan(feel.knockback * 0.8)
    run(w, 0.4)
    expect(v.x).toBeGreaterThan(3)
  })

  test("Space lunges only with the saw revved, with a cooldown", () => {
    const w = clearing()
    const me = w.jacks[0]!
    stepWorld(w, [{ ...NO_INPUT, dash: true }], DT, feel)
    expect(me.vx).toBeLessThan(1)
    stepWorld(w, [{ ...NO_INPUT, dash: true, saw: true }], DT, feel)
    expect(me.vx).toBeGreaterThan(feel.dashImpulse * 0.5)
    const cd = me.dashCd
    expect(cd).toBeGreaterThan(0)
    me.vx = 0
    stepWorld(w, [{ ...NO_INPUT, dash: true, saw: true }], DT, feel)
    expect(me.vx).toBeLessThan(1)
  })

  test("two revved saws meeting throw sparks instead of cutting", () => {
    const w = clearing()
    const v = newJack(1, false, 1, 0)
    w.jacks.push(v)
    const kinds: string[] = []
    for (let i = 0; i < 30; i++) {
      stepWorld(w, [sawAt(0), sawAt(Math.PI)], DT, feel)
      for (const e of w.events) kinds.push(e.kind)
    }
    expect(kinds).toContain("clash")
    expect(v.hp).toBe(100)
    expect(w.jacks[0]!.hp).toBe(100)
  })
})

describe("round", () => {
  test("the forest is dense and the spawns are clear", () => {
    const w = createWorld(3, FEEL)
    expect(w.trees.length).toBeGreaterThan(110)
    for (const j of w.jacks) for (const t of w.trees) expect(Math.hypot(t.x - j.x, t.y - j.y)).toBeGreaterThan(2)
  })

  test("free-for-all bots play a round to an end", () => {
    const w = createWorld(5, { ...feel, botCount: 3, botAggro: 1, botFocus: 0 })
    const human = w.jacks[0]!
    human.alive = false
    human.bot = true
    // A round with only bots: let them fight to the last one standing.
    w.phase = "play"
    let over = false
    for (let i = 0; i < 60 * 120 && !over; i++) {
      stepWorld(w, [], DT, { ...feel, botCount: 3, botAggro: 1, botFocus: 0 })
      over = (w.phase as string) === "over"
    }
    expect(over).toBe(true)
  })
})
