import { describe, expect, test } from "bun:test"
import { createWorld, FEEL, type FeelConfig, type JackInput, newJack, newTree, NO_INPUT, PART_KINDS, stepWorld, type World } from "../shared/sim"
import { fell, trunkHeightAt } from "../shared/trees"

const DT = 1 / 60
const hunt: FeelConfig = { ...FEEL, mode: "hunt", botWarmup: 0 }

/** A clearing with a lumberjack (0) and a survivor (1), no items, no truck, nobody thinking. */
function clearing(f: FeelConfig = hunt): World {
  const w = createWorld(7, { ...f, treeCount: 0, gasCans: 0 })
  w.trees = []
  w.items = []
  w.truck = null
  w.jacks = [newJack(0, false, 0, 0, "lumberjack", f), newJack(1, false, 1, 0, "survivor", f)]
  return w
}

function addTree(w: World, x: number, y: number, h = 20, cut = 0) {
  const t = newTree(w.trees.length, x, y, h)
  t.cut = cut
  w.trees.push(t)
  return t
}

function run(w: World, seconds: number, input: (w: World) => JackInput[] = () => [], f: FeelConfig = hunt) {
  const kinds: string[] = []
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    stepWorld(w, input(w), DT, f)
    for (const e of w.events) kinds.push(e.kind)
  }
  return kinds
}

const press = (k: Partial<JackInput>): JackInput => ({ ...NO_INPUT, ...k })

describe("lobby and setup", () => {
  test("as a survivor: you, two survivor bots and a lumberjack bot; parts, cans and a truck on the edge", () => {
    const w = createWorld(3, hunt)
    expect(w.jacks.map((j) => [j.role, j.bot])).toEqual([["survivor", false], ["lumberjack", true], ["survivor", true], ["survivor", true]])
    expect(w.items.filter((i) => i.kind !== "gas").map((i) => i.kind).sort()).toEqual([...PART_KINDS].sort())
    expect(w.items.filter((i) => i.kind === "gas").length).toBe(hunt.gasCans)
    const tr = w.truck!
    expect(Math.max(Math.abs(tr.x), Math.abs(tr.y))).toBeGreaterThan(20)
    for (const t of w.trees) expect(Math.hypot(t.x - tr.x, t.y - tr.y)).toBeGreaterThan(6)
    for (const it of w.items) expect(Math.hypot(it.x - tr.x, it.y - tr.y)).toBeGreaterThan(8)
  })

  test("as the lumberjack: three survivor bots", () => {
    const w = createWorld(3, { ...hunt, playAs: "lumberjack" })
    expect(w.jacks.map((j) => [j.role, j.bot])).toEqual([["lumberjack", false], ["survivor", true], ["survivor", true], ["survivor", true]])
    expect(w.jacks[0]!.engine).toBe("on")
  })
})

describe("the engine", () => {
  test("killing it goes quiet; a pull-cord start takes its time, then runs", () => {
    const w = clearing()
    const lj = w.jacks[0]!
    run(w, DT, () => [press({ engine: true })])
    expect(lj.engine).toBe("off")
    expect(lj.noise).toBeLessThan(0.2)
    const kinds = run(w, DT, () => [press({ engine: true })])
    expect(kinds).toContain("pull")
    expect(lj.engine).toBe("pulling")
    run(w, hunt.pullTime * 0.8)
    expect(lj.engine).toBe("pulling")
    expect(run(w, hunt.pullTime * 0.4)).toContain("start")
    expect(lj.engine).toBe("on")
    expect(lj.noise).toBeGreaterThanOrEqual(1)
  })

  test("the saw doesn't cut with the engine off", () => {
    const w = clearing()
    w.jacks[1]!.x = 1
    run(w, DT, () => [press({ engine: true })])
    run(w, 1, () => [press({ saw: true })])
    expect(w.jacks[1]!.hp).toBe(100)
  })

  test("mashing the cord floods it: the start fails and locks out for a while", () => {
    const w = clearing()
    const lj = w.jacks[0]!
    run(w, DT, () => [press({ engine: true })])
    const kinds: string[] = []
    // Yank on every other tick through the pull.
    for (let i = 0; i < Math.round((hunt.pullTime + 0.2) / DT); i++) {
      stepWorld(w, [press({ engine: i % 6 === 0 })], DT, hunt)
      for (const e of w.events) {
        kinds.push(e.kind)
        if (e.kind === "sputter") expect(e.flooded).toBe(true)
      }
    }
    expect(kinds).toContain("sputter")
    expect(lj.engine).toBe("off")
    expect(lj.floodLock).toBeGreaterThan(0)
    run(w, DT, () => [press({ engine: true })])
    expect(lj.engine).toBe("off")
    run(w, hunt.floodLock)
    run(w, DT, () => [press({ engine: true })])
    expect(lj.engine).toBe("pulling")
  })

  test("revving burns fuel faster; dry, it dies; a gas can fills it", () => {
    const f = { ...hunt, fuelMax: 10 }
    const w = clearing(f)
    const lj = w.jacks[0]!
    w.jacks[1]!.x = 15
    run(w, 1, () => [press({})], f)
    const idle = f.fuelMax - lj.fuel
    lj.fuel = f.fuelMax
    run(w, 1, () => [press({ saw: true })], f)
    expect(f.fuelMax - lj.fuel).toBeGreaterThan(idle * 2)
    expect(run(w, 10, () => [press({ saw: true })], f)).toContain("stop")
    expect(lj.engine).toBe("off")
    w.items.push({ id: 0, kind: "gas", x: 2, y: 0, taken: false, respawn: 0 })
    const kinds = run(w, 1.5, () => [press({ mx: 1 })], f)
    expect(kinds).toContain("pickup")
    expect(lj.fuel).toBeGreaterThan(0)
  })
})

describe("the saw on a survivor", () => {
  test("downs them; a short hold executes them", () => {
    const w = clearing()
    const s = w.jacks[1]!
    const kinds = run(w, 2, () => [press({ saw: true })])
    expect(kinds).toContain("down")
    expect(kinds.indexOf("sawStart")).toBeLessThan(kinds.indexOf("down"))
    if (!s.alive) {
      expect(kinds).toContain("execute")
      return
    }
    expect(s.downed).toBe(true)
    expect(run(w, hunt.executeTime + 0.2, () => [press({ saw: true })])).toContain("execute")
    expect(s.alive as boolean).toBe(false)
  })

  test("after a pin, the next bite on someone starts fresh (hit-stop and kickback again)", () => {
    const f = { ...hunt, pinTime: 0.5 }
    const w = clearing(f)
    const lj = w.jacks[0]!
    const s = w.jacks[1]!
    const starts = (kinds: string[]) => kinds.filter((k) => k === "sawStart").length
    expect(starts(run(w, 0.15, () => [press({ saw: true })], f))).toBe(1)
    expect(lj.contact).toBeGreaterThan(0)
    // Mid-cut, a trunk almost down comes across him; she's beside its fall line, clear of it and still at the bar.
    fell(addTree(w, 0, -4, 20), 0, 1, 1.3, 2, 1)
    const kinds = run(w, 0.5, () => [press({ saw: true })], f)
    expect(kinds).toContain("pin")
    expect(starts(kinds)).toBe(0)
    run(w, f.pinTime, () => [press({ saw: true })], f)
    expect(lj.stun).toBe(0)
    lj.engine = "on"
    Object.assign(s, { x: lj.x + 1, y: lj.y, vx: 0, vy: 0 })
    expect(starts(run(w, 0.2, () => [press({ saw: true, aim: 0 })], f))).toBe(1)
  })

  test("a teammate revives the downed before he comes back", () => {
    const w = clearing()
    const s = w.jacks[1]!
    const friend = newJack(2, false, 1, 1.2, "survivor", hunt)
    w.jacks.push(friend)
    for (let i = 0; i < 600 && !s.downed; i++) stepWorld(w, [press({ saw: true })], DT, hunt)
    expect(s.downed).toBe(true)
    // He walks off; the friend holds E over them.
    w.jacks[0]!.x = -15
    const kinds = run(w, hunt.reviveTime + 0.3, () => [NO_INPUT, NO_INPUT, press({ use: true, aim: -Math.PI / 2 })])
    expect(kinds).toContain("revive")
    expect(s.downed).toBe(false)
    expect(s.hp).toBe(hunt.reviveHp)
  })

  test("left alone, the downed bleed out", () => {
    const f = { ...hunt, downTime: 2 }
    const w = clearing(f)
    const s = w.jacks[1]!
    for (let i = 0; i < 600 && !s.downed; i++) stepWorld(w, [press({ saw: true })], DT, f)
    w.jacks[0]!.x = -15
    expect(run(w, 2.2, () => [], f)).toContain("bleedout")
    expect(s.alive).toBe(false)
  })
})

describe("counterplay", () => {
  test("a landing trunk crushes someone lying under it", () => {
    for (const along of [3, 6, 9]) {
      const w = clearing()
      const lj = w.jacks[0]!
      const s = w.jacks[1]!
      lj.x = -20
      lj.y = -15
      Object.assign(s, { x: -10 + along, y: 5, downed: true, hp: 0, bleed: 99 })
      const t = addTree(w, -10, 5, 20)
      fell(t, 1, 0, 0.05, 0.3, 0)
      const kinds = run(w, 8)
      expect(kinds).toContain("land")
      expect(s.alive).toBe(false)
      expect(s.cause).toBe("crush")
    }
  })

  test("past horizontal the trunk slopes down to the ground instead of vanishing", () => {
    const t = newTree(0, 0, 0, 20)
    t.theta = Math.PI / 2 + 0.02
    expect(trunkHeightAt(t, 5)).toBeLessThan(0.6)
    expect(trunkHeightAt(t, 5)).toBeGreaterThanOrEqual(0)
    expect(trunkHeightAt(t, 30)).toBe(Infinity)
  })

  test("a tree on the lumberjack pins him and stalls the saw; a second one kills him and the survivors win", () => {
    const w = clearing()
    const lj = w.jacks[0]!
    lj.x = 6
    const s = w.jacks[1]!
    s.x = -0.75
    s.y = 0
    addTree(w, 0, 0, 20, 0.95)
    let pinned = false
    for (let i = 0; i < 60 * 8 && !pinned; i++) {
      stepWorld(w, [NO_INPUT, press({ saw: true, aim: 0 })], DT, hunt)
      pinned = w.events.some((e) => e.kind === "pin")
    }
    expect(pinned).toBe(true)
    expect(lj.alive).toBe(true)
    expect(lj.engine).toBe("off")
    expect(lj.stun).toBeGreaterThan(0)
    // Pinned: a pushed tree finishes him.
    const t2 = addTree(w, 6, -4, 20, hunt.pushAt + 0.05)
    s.x = 6
    s.y = -4.9
    expect(run(w, DT, () => [NO_INPUT, press({ use: true, aim: Math.PI / 2 })])).toContain("push")
    expect(t2.state).toBe("falling")
    expect(t2.fy).toBeCloseTo(1, 3)
    run(w, 6)
    expect(lj.alive).toBe(false)
    expect(lj.cause).toBe("crush")
    expect(w.phase).toBe("over")
    expect(w.side).toBe("survivor")
  })

  test("a sound tree won't shove; the axe is far slower than the saw", () => {
    const w = clearing()
    const s = w.jacks[1]!
    w.jacks[0]!.x = -15
    s.x = -0.75
    const t = addTree(w, 0, 0, 20, 0.1)
    run(w, DT, () => [NO_INPUT, press({ use: true, aim: 0 })])
    expect(t.state).toBe("standing")
    run(w, 1, () => [NO_INPUT, press({ saw: true, aim: 0 })])
    expect(t.cut - 0.1).toBeCloseTo(1 / hunt.axeCutTime, 2)
    expect(hunt.axeCutTime).toBeGreaterThan(hunt.cutTime * 3)
  })

  test("a flare thrown at him blinds him", () => {
    const w = clearing()
    const lj = w.jacks[0]!
    const s = w.jacks[1]!
    s.x = -5
    expect(run(w, 1.5, (w) => [NO_INPUT, press({ flare: w.t < DT * 0.5, aim: 0 })])).toContain("blind")
    expect(lj.blind).toBeGreaterThan(0)
    expect(s.flares).toBe(hunt.flares - 1)
  })

  test("sprinting runs out of stamina", () => {
    const w = clearing()
    const s = w.jacks[1]!
    w.jacks[0]!.y = 20
    s.x = -22
    run(w, 1, () => [NO_INPUT, press({ mx: 1, sprint: true })])
    expect(s.sprinting).toBe(true)
    expect(Math.hypot(s.vx, s.vy)).toBeGreaterThan(hunt.survivorWalk + 1)
    run(w, hunt.staminaMax, () => [NO_INPUT, press({ mx: 1, sprint: true })])
    expect(s.exhausted).toBe(true)
    run(w, 0.5, () => [NO_INPUT, press({ mx: 1, sprint: true })])
    expect(Math.hypot(s.vx, s.vy)).toBeLessThan(hunt.survivorWalk + 0.1)
  })
})

describe("escape", () => {
  test("three parts to the truck start it; reaching it escapes and the survivors win", () => {
    const w = clearing()
    const s = w.jacks[1]!
    w.jacks[0]!.x = -20
    w.truck = { x: 10, y: 0, yaw: Math.PI, parts: [], started: false }
    const kinds: string[] = []
    for (const kind of PART_KINDS) {
      w.items.push({ id: w.items.length, kind, x: s.x + 1, y: s.y, taken: false, respawn: 0 })
      kinds.push(...run(w, 0.5, () => [NO_INPUT, press({ mx: 1 })]))
      expect(s.carrying).toBe(kind)
      kinds.push(...run(w, 3, () => [NO_INPUT, press({ mx: 1 })]))
      expect(s.carrying).toBe(null)
      s.x = 0
      s.y = 0
    }
    expect(kinds.filter((k) => k === "install").length).toBe(3)
    expect(kinds).toContain("truck")
    expect(kinds).toContain("escape")
    expect(s.escaped).toBe(true)
    expect(w.side).toBe("survivor")
  })
})

describe("bots", () => {
  test("a dry lumberjack bot goes for a gas can even with a survivor in sight", () => {
    const w = clearing()
    const lj = Object.assign(newJack(0, true, 0, 0, "lumberjack", hunt), { fuel: 0, engine: "off" as const })
    w.jacks = [lj, newJack(1, false, -2.5, 0, "survivor", hunt)]
    w.items = [{ id: 0, kind: "gas", x: 9, y: 0, taken: false, respawn: 0 }]
    const kinds = run(w, 6)
    expect(kinds).toContain("pickup")
    expect(lj.fuel).toBeGreaterThan(0)
    // The can comes first; only then does he go to work on her.
    if (kinds.includes("down")) expect(kinds.indexOf("pickup")).toBeLessThan(kinds.indexOf("down"))
  })

  for (const playAs of ["survivor", "lumberjack"] as const) {
    test(`a hunt round with only bots plays out (you as ${playAs}, standing by)`, () => {
      const f = { ...hunt, playAs }
      const w = createWorld(11, f)
      const me = w.jacks[0]!
      me.bot = true
      const seen = new Set<string>()
      for (let i = 0; i < Math.round(f.roundTime / DT) + 5 && w.phase === "play"; i++) {
        stepWorld(w, [], DT, f)
        for (const e of w.events) seen.add(e.kind)
      }
      expect(w.phase as string).toBe("over")
      expect(seen.has("pickup")).toBe(true)
      expect(seen.has("fell") || seen.has("down")).toBe(true)
    }, 60_000)
  }
})
