import { describe, expect, mock, test } from "bun:test"
import { END_SECONDS, GUNS, HEALTH, RESPAWN_SECONDS } from "../shared/config"
import { decodeClient } from "../shared/protocol"
import { Rng } from "../shared/rng"
import { DOM, type Domination, type ModeId, SND, type SearchAndDestroy, tally, tdmTarget } from "../shared/sim/modes"
import { navFor } from "../shared/sim/nav"
import { placesFor } from "../shared/sim/places"
import { buildSnapshot } from "../shared/sim/view"
import { World } from "../shared/sim/world"
import { generateOffice } from "../shared/maps/office"
import { place, run, testMap } from "./helpers"

const east = 0

function modeWorld(mode: ModeId, names: string[]): World {
  const w = new World(11, testMap(), mode)
  for (const n of names) w.addHuman(n, n)
  w.step()
  w.takeEvents()
  return w
}

const team = (w: World, t: number) => [...w.players.values()].filter((p) => p.team === t)

describe("team deathmatch", () => {
  test("joiners are balanced across two teams", () => {
    const w = modeWorld("tdm", ["a", "b", "c", "d", "e"])
    expect(team(w, 0).length + team(w, 1).length).toBe(5)
    expect(Math.abs(team(w, 0).length - team(w, 1).length)).toBeLessThanOrEqual(1)
    w.addHuman("f", "f")
    expect(team(w, 0).length).toBe(3)
    expect(team(w, 1).length).toBe(3)
  })

  test("teams spawn at opposite ends", () => {
    const w = modeWorld("tdm", ["a", "b", "c", "d"])
    w.setMode("tdm")
    const mean = (t: number) => team(w, t).reduce((s, p) => s + p.x, 0) / team(w, t).length
    expect(Math.abs(mean(0) - mean(1))).toBeGreaterThan(20)
  })

  test("no friendly fire: rounds pass through teammates and hit the enemy behind", () => {
    const w = modeWorld("tdm", ["a", "b", "c", "d"])
    const [a, mate] = team(w, 0)
    const [foe] = team(w, 1)
    place(w, a!.id, 15, 10)
    place(w, mate!.id, 17, 10)
    place(w, foe!.id, 20, 10)
    for (const p of w.players.values()) if (![a, mate, foe].includes(p)) place(w, p.id, 35, 18)
    a!.cooldownUntil = 0
    run(w, 1, (id) => (id === a!.id ? { aim: east, fire: true } : {}))
    expect(mate!.health).toBe(HEALTH)
    expect(mate!.alive).toBe(true)
    expect(foe!.alive).toBe(false)
    expect(w.mode.score[0]).toBe(1)
  })

  test("frags don't hurt teammates", () => {
    const w = modeWorld("tdm", ["a", "b"])
    const [a] = team(w, 0)
    w.addHuman("c", "c")
    const mate = team(w, 0).find((p) => p !== a) ?? team(w, 1).find((p) => p.id === "c")!
    mate.team = a!.team
    w.damage(mate, 50, a!, "frag", 0, 0)
    expect(mate.health).toBe(HEALTH)
  })

  test("the first team to the kill target wins", () => {
    const w = modeWorld("tdm", ["a", "b"])
    const [a] = team(w, 0)
    const [b] = team(w, 1)
    expect(w.mode.target(w)).toBe(tdmTarget(2))
    w.mode.score[0] = tdmTarget(2) - 1
    w.kill(b!, a!)
    expect(w.phase).toBe("end")
    const end = w.takeEvents().find((e) => e.k === "end")
    expect(end).toMatchObject({ k: "end", team: 0 })
  })

  test("the kill target scales with the room", () => {
    expect(tdmTarget(2)).toBe(20)
    expect(tdmTarget(12)).toBe(50)
    expect(tdmTarget(8)).toBeGreaterThan(20)
  })
})

describe("domination", () => {
  const setup = () => {
    const w = modeWorld("dom", ["a", "b", "c", "d"])
    const dom = w.mode as Domination
    // Everyone parked well away from the points.
    for (const p of w.players.values()) place(w, p.id, 1, 1 + [...w.players.keys()].indexOf(p.id))
    return { w, dom, t0: team(w, 0), t1: team(w, 1) }
  }

  test("three points spread along the floor", () => {
    const { dom } = setup()
    expect(dom.points.map((p) => p.name)).toEqual(["A", "B", "C"])
    const xs = dom.points.map((p) => p.x)
    expect(xs[0]!).toBeLessThan(xs[1]!)
    expect(xs[1]!).toBeLessThan(xs[2]!)
    expect(xs[2]! - xs[0]!).toBeGreaterThan(15)
  })

  test("standing alone on a point captures it in about five seconds, and it scores every second", () => {
    const { w, dom, t0 } = setup()
    const b = dom.points[1]!
    place(w, t0[0]!.id, b.x, b.y)
    run(w, DOM.capture - 0.5)
    expect(b.owner).toBe(-1)
    expect(b.capper).toBe(0)
    run(w, 0.7)
    expect(b.owner).toBe(0)
    expect(t0[0]!.caps).toBe(1)
    expect(w.takeEvents().some((e) => e.k === "cap" && e.point === "B")).toBe(true)
    const before = w.mode.score[0]
    run(w, 3)
    expect(w.mode.score[0] - before).toBeGreaterThanOrEqual(2)
    expect(w.mode.score[0] - before).toBeLessThanOrEqual(4)
    expect(w.mode.score[1]).toBe(0)
  })

  test("two teammates capture faster", () => {
    const { w, dom, t0 } = setup()
    const b = dom.points[1]!
    place(w, t0[0]!.id, b.x, b.y)
    place(w, t0[1]!.id, b.x + 0.5, b.y)
    run(w, DOM.capture / 1.5 + 0.2)
    expect(b.owner).toBe(0)
  })

  test("a contested point pauses", () => {
    const { w, dom, t0, t1 } = setup()
    const b = dom.points[1]!
    place(w, t0[0]!.id, b.x, b.y)
    run(w, 2)
    const p = b.progress
    expect(p).toBeGreaterThan(0.3)
    place(w, t1[0]!.id, b.x + 0.5, b.y)
    run(w, 4)
    expect(b.contested).toBe(true)
    expect(b.progress).toBeCloseTo(p, 5)
    expect(b.owner).toBe(-1)
  })

  test("the first team to the target wins", () => {
    const { w, dom, t0 } = setup()
    dom.points[0]!.owner = 0
    dom.score[0] = DOM.target - 1
    place(w, t0[0]!.id, 1, 1)
    run(w, 1.1)
    expect(w.phase).toBe("end")
    expect(dom.result(w).team).toBe(0)
  })
})

describe("search and destroy", () => {
  const setup = (names = ["a", "b", "c", "d"]) => {
    const w = modeWorld("snd", names)
    const snd = w.mode as SearchAndDestroy
    const att = () => team(w, snd.attack)
    const def = () => team(w, snd.defend)
    return { w, snd, att, def }
  }
  const carrier = (w: World, snd: SearchAndDestroy) => w.players.get(snd.bomb.carrier)!

  test("one attacker spawns with the bomb; attackers and defenders start at opposite ends", () => {
    const { w, snd, att, def } = setup()
    expect(snd.round).toBe(1)
    expect(snd.bomb.state).toBe("carried")
    expect(carrier(w, snd).team).toBe(snd.attack)
    const mean = (ps: { x: number }[]) => ps.reduce((s, p) => s + p.x, 0) / ps.length
    expect(Math.abs(mean(att()) - mean(def()))).toBeGreaterThan(20)
  })

  test("planting holds you still and arms the bomb; defusing wins the round for the defenders", () => {
    const { w, snd, def } = setup()
    const c = carrier(w, snd)
    const site = placesFor(w.map).sites[0]!
    place(w, c.id, site.x, site.y)
    run(w, SND.plant - 0.3, (id) => (id === c.id ? { use: true, mx: 1 } : {}))
    expect(c.x).toBeCloseTo(site.x, 3)
    run(w, 0.5, (id) => (id === c.id ? { use: true } : {}))
    expect(snd.bomb.state).toBe("planted")
    expect(c.plants).toBe(1)
    const d = def()[0]!
    place(w, d.id, site.x + 0.5, site.y)
    run(w, SND.defuse + 0.2, (id) => (id === d.id ? { use: true } : {}))
    expect(snd.bomb.state).toBe("defused")
    expect(d.defuses).toBe(1)
    expect(snd.score[snd.defend]).toBe(1)
    expect(snd.post).toBe(true)
  })

  test("letting go resets the plant", () => {
    const { w, snd } = setup()
    const c = carrier(w, snd)
    const site = placesFor(w.map).sites[1]!
    place(w, c.id, site.x, site.y)
    run(w, SND.plant - 1, (id) => (id === c.id ? { use: true } : {}))
    run(w, 0.1)
    run(w, SND.plant - 1, (id) => (id === c.id ? { use: true } : {}))
    expect(snd.bomb.state).toBe("carried")
  })

  test("the bomb detonates after the fuse: attackers win and defenders nearby die", () => {
    const { w, snd, def } = setup()
    const c = carrier(w, snd)
    const site = placesFor(w.map).sites[0]!
    place(w, c.id, site.x, site.y)
    run(w, SND.plant + 0.2, (id) => (id === c.id ? { use: true } : {}))
    place(w, c.id, 1, 1)
    const d = def()[0]!
    place(w, d.id, site.x + 2, site.y)
    run(w, SND.fuse + 0.2)
    expect(snd.bomb.state).toBe("exploded")
    expect(d.alive).toBe(false)
    expect(snd.score[snd.attack]).toBe(1)
    expect(w.takeEvents().some((e) => e.k === "bomb" && e.what === "explode")).toBe(true)
  })

  test("eliminating the defenders wins; the dead stay dead until the next round", () => {
    const { w, snd, att, def } = setup()
    const a = att()[0]!
    const [d1, d2] = def()
    w.kill(d1!, a)
    run(w, RESPAWN_SECONDS + 1)
    expect(d1!.alive).toBe(false)
    expect(buildSnapshot(w, d1!.id).you!.respawnIn).toBe(-1)
    expect(snd.post).toBe(false)
    w.kill(d2!, a)
    run(w, 0.1)
    expect(snd.post).toBe(true)
    expect(snd.score[snd.attack]).toBe(1)
    run(w, SND.post + 0.2)
    expect(snd.round).toBe(2)
    expect([...w.players.values()].every((p) => p.alive)).toBe(true)
  })

  test("the bomb drops when its carrier dies and another attacker picks it up", () => {
    const { w, snd, att, def } = setup()
    const c = carrier(w, snd)
    const other = att().find((p) => p !== c)!
    place(w, c.id, 20, 10)
    place(w, other.id, 25, 10)
    w.kill(c, def()[0]!)
    run(w, 0.1)
    expect(snd.bomb.state).toBe("dropped")
    place(w, other.id, 20.3, 10)
    run(w, 0.1)
    expect(snd.bomb.state).toBe("carried")
    expect(snd.bomb.carrier).toBe(other.id)
  })

  test("running out the clock without a plant is a defender win", () => {
    const { w, snd } = setup()
    run(w, SND.round + 0.2)
    expect(snd.post).toBe(true)
    expect(snd.why).toBe("time")
    expect(snd.score[snd.defend]).toBe(1)
  })

  test("sides swap at half and the first team to four rounds wins the match", () => {
    const { w, snd } = setup()
    const first = snd.attack
    const winRound = () => {
      const a = team(w, snd.attack)[0]!
      for (const d of team(w, snd.defend)) w.kill(d, a)
      run(w, 0.1)
      run(w, SND.post + 0.1)
    }
    for (let i = 0; i < SND.wins - 1; i++) winRound()
    expect(snd.round).toBe(SND.wins)
    expect(snd.attack).toBe(1 - first)
    expect(snd.score[first]).toBe(SND.wins - 1)
    // The other side now wins three; then team `first`, defending, takes the decider on time.
    for (let i = 0; i < SND.wins - 1; i++) winRound()
    expect(w.phase).toBe("play")
    run(w, SND.round + 0.2)
    run(w, SND.post + 0.2)
    expect(w.phase).toBe("end")
    expect(snd.result(w).team).toBe(first)
  })

  test("a late joiner waits for the next round", () => {
    const { w } = setup()
    run(w, SND.lateJoin + 1)
    const p = w.addHuman("late", "late")
    expect(p.alive).toBe(false)
    run(w, RESPAWN_SECONDS + 1)
    expect(p.alive).toBe(false)
  })
})

describe("votes", () => {
  test("no votes keeps the mode; the most votes wins; ties break at random", () => {
    const rng = new Rng(1)
    expect(tally([], "dom", rng)).toBe("dom")
    expect(tally(["tdm", "snd", "tdm"], "ffa", rng)).toBe("tdm")
    const seen = new Set<ModeId>()
    for (let i = 0; i < 40; i++) seen.add(tally(["dom", "snd"], "ffa", rng))
    expect([...seen].sort()).toEqual(["dom", "snd"])
  })

  test("votes count only on the end screen and pick the next match's mode", () => {
    const w = modeWorld("ffa", ["a", "b", "c"])
    w.vote("a", "snd")
    expect(w.votes.size).toBe(0)
    w.endMatch()
    // The end screen offers the current mode and three others at random; this test wants these.
    w.voteOptions = ["ffa", "tdm", "dom", "snd"]
    w.vote("a", "dom")
    w.vote("b", "dom")
    w.vote("c", "tdm")
    w.vote("a", "dom")
    const view = buildSnapshot(w, "a").mode.votes!
    expect(view.counts.dom).toBe(2)
    expect(view.counts.tdm).toBe(1)
    expect(view.mine).toBe("dom")
    for (let i = 0; i < 30 * (END_SECONDS + 1) && w.phase === "end"; i++) w.step()
    expect(w.phase).toBe("play")
    expect(w.mode.id).toBe("dom")
    expect(team(w, 0).length + team(w, 1).length).toBe(3)
    expect([...w.players.values()].every((p) => p.alive)).toBe(true)
  })
})

describe("protocol", () => {
  test("votes and the use key are validated", () => {
    expect(decodeClient(JSON.stringify({ type: "vote", mode: "snd" }))).toEqual({ type: "vote", mode: "snd" })
    expect(decodeClient(JSON.stringify({ type: "vote", mode: "nope" }))).toBeNull()
    const m = decodeClient(JSON.stringify({ type: "intent", seq: 1, i: { use: true } }))
    expect(m?.type === "intent" && m.i.use).toBe(true)
    const n = decodeClient(JSON.stringify({ type: "intent", seq: 1, i: { use: "yes" } }))
    expect(n?.type === "intent" && n.i.use).toBe(false)
  })
})

describe("rooms", () => {
  test("Create game's mode is the first match's mode, taken only while the room is empty", async () => {
    mock.module("cloudflare:workers", () => ({ DurableObject: class {} }))
    const { RoomCore } = await import("../server/room")
    const core = new RoomCore("abcd")
    expect(core.world.mode.id).toBe("ffa")
    expect(core.setMode("snd")).toBe(true)
    expect(core.world.mode.id).toBe("snd")
    const sent: string[] = []
    core.message({ send: (d) => sent.push(d), close() {} }, JSON.stringify({ type: "hello", name: "x", gun: "rifle", equip: "frag" }))
    expect(core.world.humans.length).toBe(1)
    expect(core.setMode("tdm")).toBe(false)
    expect(core.world.mode.id).toBe("snd")
    expect(new RoomCore("efgh", "dom").world.mode.id).toBe("dom")
  })
})

describe("places on generated floors", () => {
  test("points, sites and team ends are reachable and spread out", () => {
    for (const seed of [3, 17, 99, 1234]) {
      const map = generateOffice(seed)
      const nav = navFor(map)
      const pl = placesFor(map)
      const reach = nav.reachable(map.spawns[0]!)
      for (const v of [...pl.points, ...pl.sites, ...pl.slots[0], ...pl.slots[1]]) expect(nav.inMask(reach, v)).toBe(true)
      const [a, b, c] = pl.points
      const d = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y)
      expect(Math.min(d(a, b), d(b, c), d(a, c))).toBeGreaterThan(8)
      expect(d(pl.sites[0], pl.sites[1])).toBeGreaterThan(6)
      expect(pl.slots[0].length).toBeGreaterThanOrEqual(6)
      expect(pl.slots[1].length).toBeGreaterThanOrEqual(6)
      // A, B, C in order along the long axis; both sites on the defenders' (high) half.
      const along = (v: { x: number; y: number }) => (map.size[0] >= map.size[1] ? v.x : v.y)
      const len = Math.max(map.size[0], map.size[1])
      expect(along(a)).toBeLessThan(along(b))
      expect(along(b)).toBeLessThan(along(c))
      for (const s of pl.sites) expect(along(s)).toBeGreaterThan(len / 2)
      expect(along(pl.ends[0][0]!)).toBeLessThan(along(pl.ends[1][0]!))
    }
  })

  test("bots play every mode without errors and score", () => {
    for (const mode of ["tdm", "dom", "snd"] as ModeId[]) {
      const w = new World(7, null, mode)
      w.fill(6)
      for (let i = 0; i < 30 * 100 && w.phase === "play"; i++) w.step()
      const kills = [...w.players.values()].reduce((s, p) => s + p.kills, 0)
      if (mode === "dom") expect(Math.max(...w.mode.score)).toBeGreaterThan(0)
      expect(kills + Math.max(...w.mode.score)).toBeGreaterThan(0)
      expect(GUNS.rifle.mag).toBeGreaterThan(0)
    }
  })
})
