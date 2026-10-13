import { describe, expect, test } from "bun:test"
import { END_SECONDS, SPEED } from "../shared/config"
import { Rng } from "../shared/rng"
import { MODE_IDS, modeChoices, modeOf, type ModeId, tally, voteOptions } from "../shared/sim/modes"
import { CTF, type CaptureTheFlag, HP, type Hardpoint, KC, type KillConfirmed, kcTarget } from "../shared/sim/modes-objective"
import { placesFor } from "../shared/sim/places"
import { buildSnapshot, rosterOf } from "../shared/sim/view"
import { type SimEvent, World } from "../shared/sim/world"
import { place, run, testMap } from "./helpers"

function modeWorld(mode: ModeId, names = ["a", "b", "c", "d"]): World {
  const w = new World(11, testMap(), mode)
  for (const n of names) w.addHuman(n, n)
  w.step()
  w.takeEvents()
  return w
}

const team = (w: World, t: number) => [...w.players.values()].filter((p) => p.team === t)
/** Everyone out of the way in the corner. */
const park = (w: World) => [...w.players.values()].forEach((p, i) => place(w, p.id, 1, 1 + i * 0.9))
const objs = (w: World) => w.takeEvents().filter((e): e is Extract<SimEvent, { k: "obj" }> => e.k === "obj")

describe("kill confirmed", () => {
  const setup = () => {
    const w = modeWorld("kc")
    park(w)
    return { w, kc: w.mode as KillConfirmed, t0: team(w, 0), t1: team(w, 1) }
  }

  test("a kill scores nothing by itself and drops the victim's tag where they died", () => {
    const { w, kc, t0, t1 } = setup()
    place(w, t1[0]!.id, 20, 10)
    w.kill(t1[0]!, t0[0]!)
    expect(kc.score).toEqual([0, 0])
    expect(kc.tags).toHaveLength(1)
    expect(kc.tags[0]).toMatchObject({ x: 20, y: 10, team: 1 })
    expect(buildSnapshot(w, "a").mode.tags).toHaveLength(1)
  })

  test("an enemy walking over the tag confirms it; a teammate denies it", () => {
    const { w, kc, t0, t1 } = setup()
    place(w, t1[0]!.id, 20, 10)
    w.kill(t1[0]!, t0[0]!)
    place(w, t0[1]!.id, 20 + KC.pickup * 0.6, 10)
    run(w, 0.1)
    expect(kc.tags).toHaveLength(0)
    expect(kc.score).toEqual([1, 0])
    expect(t0[1]!.stats.confirms).toBe(1)
    expect(objs(w).some((e) => e.what === "confirm" && e.by === t0[1]!.id)).toBe(true)

    place(w, t0[0]!.id, 25, 5)
    w.kill(t0[0]!, t1[1]!)
    place(w, t0[1]!.id, 25.4, 5)
    run(w, 0.1)
    expect(kc.tags).toHaveLength(0)
    expect(kc.score).toEqual([1, 0])
    expect(t0[1]!.stats.denies).toBe(1)
    expect(rosterOf(w).find((r) => r.id === t0[1]!.id)!.stats).toEqual({ confirms: 1, denies: 1 })
  })

  test("tags vanish after a while", () => {
    const { w, kc, t0, t1 } = setup()
    place(w, t1[0]!.id, 20, 10)
    w.kill(t1[0]!, t0[0]!)
    park(w)
    run(w, KC.life - 1)
    expect(kc.tags).toHaveLength(1)
    run(w, 1.2)
    expect(kc.tags).toHaveLength(0)
    expect(kc.score).toEqual([0, 0])
  })

  test("the first team to the confirm target wins", () => {
    const { w, kc, t0, t1 } = setup()
    expect(kc.target(w)).toBe(kcTarget(4))
    kc.score[0] = kc.target(w) - 1
    place(w, t1[0]!.id, 20, 10)
    w.kill(t1[0]!, t0[0]!)
    place(w, t0[1]!.id, 20, 10)
    run(w, 0.1)
    expect(w.phase).toBe("end")
    expect(kc.result(w).team).toBe(0)
  })

  test("the target scales with the room", () => {
    expect(kcTarget(2)).toBe(15)
    expect(kcTarget(12)).toBe(40)
    expect(kcTarget(8)).toBeGreaterThan(15)
  })
})

describe("hardpoint", () => {
  const setup = () => {
    const w = modeWorld("hp")
    park(w)
    return { w, hp: w.mode as Hardpoint, t0: team(w, 0), t1: team(w, 1) }
  }

  test("the zones are spread over the floor", () => {
    const { w } = setup()
    const hills = placesFor(w.map).hills
    expect(hills.length).toBeGreaterThanOrEqual(4)
    for (let i = 0; i < hills.length; i++) for (let j = i + 1; j < hills.length; j++) expect(Math.hypot(hills[i]!.x - hills[j]!.x, hills[i]!.y - hills[j]!.y)).toBeGreaterThan(5)
  })

  test("holding the zone alone scores a point a second", () => {
    const { w, hp, t0 } = setup()
    const z = hp.zone(w)
    place(w, t0[0]!.id, z.x, z.y)
    run(w, 3.1)
    expect(hp.score).toEqual([3, 0])
    expect(hp.holder).toBe(0)
    expect(t0[0]!.stats.hill).toBe(3)
    expect(buildSnapshot(w, "a").mode.zone).toMatchObject({ holder: 0, contested: false, r: HP.radius })
  })

  test("a contested zone scores for nobody", () => {
    const { w, hp, t0, t1 } = setup()
    const z = hp.zone(w)
    place(w, t0[0]!.id, z.x, z.y)
    place(w, t1[0]!.id, z.x + 0.6, z.y)
    run(w, 3)
    expect(hp.contested).toBe(true)
    expect(hp.holder).toBe(-1)
    expect(hp.score).toEqual([0, 0])
  })

  test("the zone moves every minute, announced beforehand", () => {
    const { w, hp } = setup()
    const first = hp.zone(w)
    expect(buildSnapshot(w, "a").mode.zone!.next).toBeNull()
    run(w, HP.move - HP.warn + 0.5)
    const next = buildSnapshot(w, "a").mode.zone!.next!
    expect(next).not.toBeNull()
    expect(Math.hypot(next.x - first.x, next.y - first.y)).toBeGreaterThan(3)
    run(w, HP.warn)
    expect(hp.zone(w)).toEqual(next)
    expect(objs(w).some((e) => e.what === "move")).toBe(true)
    // It cycles back around.
    const n = placesFor(w.map).hills.length
    run(w, HP.move * (n - 1))
    expect(hp.zone(w)).toEqual(first)
  })

  test("the first team to the target wins", () => {
    const { w, hp, t1 } = setup()
    hp.score[1] = HP.target - 1
    const z = hp.zone(w)
    place(w, t1[0]!.id, z.x, z.y)
    run(w, 1.1)
    expect(w.phase).toBe("end")
    expect(hp.result(w).team).toBe(1)
  })
})

describe("capture the flag", () => {
  const setup = () => {
    const w = modeWorld("ctf")
    park(w)
    const bases = placesFor(w.map).bases
    return { w, ctf: w.mode as CaptureTheFlag, t0: team(w, 0), t1: team(w, 1), bases }
  }

  test("the flags start at bases at opposite ends", () => {
    const { ctf, bases } = setup()
    expect(bases[0].x).toBeLessThan(12)
    expect(bases[1].x).toBeGreaterThan(28)
    expect(ctf.flags.map((f) => f.state)).toEqual(["home", "home"])
    expect(ctf.flags[0]).toMatchObject({ x: bases[0].x, y: bases[0].y })
  })

  test("walk over the enemy flag to take it; the carrier walks slower and can't sprint", () => {
    const { w, ctf, t0, bases } = setup()
    const a = t0[0]!
    place(w, a.id, bases[1].x, bases[1].y)
    run(w, 0.1)
    expect(ctf.flags[1]).toMatchObject({ state: "carried", carrier: a.id })
    expect(objs(w).some((e) => e.what === "take")).toBe(true)
    place(w, a.id, 20, 10)
    run(w, 1, (id) => (id === a.id ? { mx: -1, sprint: true } : {}))
    expect(Math.hypot(a.vx, a.vy)).toBeLessThan(SPEED * CTF.slow + 0.01)
    expect(a.readyAt).toBe(0)
    expect(ctf.flags[1].x).toBeCloseTo(a.x, 5)
    expect(buildSnapshot(w, "a").mode.flags![1]).toMatchObject({ state: "carried", carrier: a.id })
  })

  test("bringing it home while your flag is home scores", () => {
    const { w, ctf, t0, bases } = setup()
    const a = t0[0]!
    place(w, a.id, bases[1].x, bases[1].y)
    run(w, 0.1)
    place(w, a.id, bases[0].x + 0.5, bases[0].y)
    run(w, 0.1)
    expect(ctf.score).toEqual([1, 0])
    expect(a.stats.captures).toBe(1)
    expect(ctf.flags[1].state).toBe("home")
    expect(ctf.flags[1]).toMatchObject({ x: bases[1].x, y: bases[1].y })
  })

  test("no capture while your own flag is away; returning it lets the carrier score", () => {
    const { w, ctf, t0, t1, bases } = setup()
    const [a, mate] = t0
    const foe = t1[0]!
    place(w, foe.id, bases[0].x, bases[0].y)
    place(w, a!.id, bases[1].x, bases[1].y)
    run(w, 0.1)
    expect(ctf.flags[0].carrier).toBe(foe.id)
    expect(ctf.flags[1].carrier).toBe(a!.id)
    place(w, foe.id, 20, 10)
    place(w, a!.id, bases[0].x, bases[0].y)
    run(w, 1)
    expect(ctf.score).toEqual([0, 0])
    // The enemy carrier dies: the flag drops where they were.
    w.kill(foe, mate!)
    run(w, 0.1)
    expect(ctf.flags[0]).toMatchObject({ state: "dropped", x: 20, y: 10 })
    expect(objs(w).some((e) => e.what === "drop")).toBe(true)
    place(w, mate!.id, 20.4, 10)
    run(w, 0.1)
    expect(ctf.flags[0].state).toBe("home")
    expect(mate!.stats.returns).toBe(1)
    run(w, 0.1)
    expect(ctf.score).toEqual([1, 0])
  })

  test("enemies pick a dropped flag up", () => {
    const { w, ctf, t0, t1, bases } = setup()
    const [a, mate] = t0
    place(w, a!.id, bases[1].x, bases[1].y)
    run(w, 0.1)
    place(w, a!.id, 20, 10)
    w.kill(a!, t1[0]!)
    run(w, 0.1)
    expect(ctf.flags[1].state).toBe("dropped")
    place(w, mate!.id, 20.5, 10)
    run(w, 0.1)
    expect(ctf.flags[1]).toMatchObject({ state: "carried", carrier: mate!.id })
  })

  test("a dropped flag goes home by itself", () => {
    const { w, ctf, t0, t1, bases } = setup()
    const a = t0[0]!
    place(w, a.id, bases[1].x, bases[1].y)
    run(w, 0.1)
    place(w, a.id, 20, 10)
    w.kill(a, t1[0]!)
    park(w)
    run(w, CTF.autoReturn - 1)
    expect(ctf.flags[1].state).toBe("dropped")
    expect(buildSnapshot(w, "a").mode.flags![1]!.returnIn).toBeGreaterThan(0)
    run(w, 1.2)
    expect(ctf.flags[1].state).toBe("home")
  })

  test("three captures win; level captures go to kills", () => {
    const { w, ctf, t0, t1, bases } = setup()
    expect(ctf.result(w).team).toBe(-1)
    t1[0]!.kills = 2
    expect(ctf.result(w).team).toBe(1)
    ctf.score[0] = CTF.captures - 1
    const a = t0[0]!
    place(w, a.id, bases[1].x, bases[1].y)
    run(w, 0.1)
    place(w, a.id, bases[0].x, bases[0].y)
    run(w, 0.1)
    expect(w.phase).toBe("end")
    expect(ctf.result(w).team).toBe(0)
  })
})

describe("the vote", () => {
  test("wizard routing stays explicit while public pickers and every public vote omit it", () => {
    expect(modeOf("wizards")).toBe("wizards")
    expect(modeChoices()).not.toContain("wizards")
    for (const mode of modeChoices()) {
      expect(modeChoices(mode)).not.toContain("wizards")
      for (let seed = 0; seed < 100; seed++) expect(voteOptions(mode, new Rng(seed))).not.toContain("wizards")
      expect(tally(["wizards", "wizards"], mode, new Rng(1))).toBe(mode)
    }
    const publicRoom = modeWorld("ffa", ["a", "b"])
    publicRoom.endMatch()
    publicRoom.vote("a", "wizards")
    expect(publicRoom.votes.size).toBe(0)
    expect(buildSnapshot(publicRoom, "a").mode.votes!.options).not.toContain("wizards")
  })

  test("an explicitly wizard room can reset and vote for another wizard round", () => {
    expect(modeChoices("wizards")).toContain("wizards")
    const w = modeWorld("wizards", ["a", "b"])
    w.endMatch()
    const votes = buildSnapshot(w, "a").mode.votes!
    expect(votes.options[0]).toBe("wizards")
    w.vote("a", "wizards")
    expect(tally(w.votes.values(), w.mode.id, w.rng, votes.options)).toBe("wizards")
    expect(buildSnapshot(w, "a").mode.votes!.counts.wizards).toBe(1)
  })

  test("four options: the current mode first, three others, the same for the same seed", () => {
    for (const cur of MODE_IDS) {
      const o = voteOptions(cur, new Rng(5))
      expect(o).toHaveLength(4)
      expect(o[0]).toBe(cur)
      expect(new Set(o).size).toBe(4)
      expect(voteOptions(cur, new Rng(5))).toEqual(o)
    }
    const seen = new Set<string>()
    const rng = new Rng(9)
    for (let i = 0; i < 30; i++) seen.add(voteOptions("ffa", rng).join())
    expect(seen.size).toBeGreaterThan(3)
  })

  test("the tally counts only offered modes", () => {
    const rng = new Rng(1)
    expect(tally(["ctf", "ctf", "hp"], "ffa", rng, ["ffa", "hp", "dom", "tdm"])).toBe("hp")
    expect(tally(["ctf"], "ffa", rng, ["ffa", "hp", "dom", "tdm"])).toBe("ffa")
  })

  test("the end screen offers four modes in the snapshot; votes outside them are ignored", () => {
    const w = modeWorld("kc", ["a", "b"])
    w.endMatch()
    const opts = buildSnapshot(w, "a").mode.votes!.options
    expect(opts).toHaveLength(4)
    expect(opts[0]).toBe("kc")
    expect(buildSnapshot(w, "b").mode.votes!.options).toEqual(opts)
    const other = MODE_IDS.find((m) => !opts.includes(m))!
    w.vote("a", other)
    expect(w.votes.size).toBe(0)
    w.vote("a", opts[2]!)
    w.vote("b", opts[2]!)
    for (let i = 0; i < 30 * (END_SECONDS + 1) && w.phase === "end"; i++) w.step()
    expect(w.mode.id).toBe(opts[2]!)
  })
})

describe("bots", () => {
  test("bots play each objective mode for a minute without errors", () => {
    for (const mode of ["kc", "hp", "ctf"] as ModeId[]) {
      const w = new World(7, null, mode)
      w.fill(6)
      const seen = new Set<string>()
      for (let i = 0; i < 30 * 60 && w.phase === "play"; i++) {
        w.step()
        for (const e of w.takeEvents()) if (e.k === "obj") seen.add(e.what)
      }
      const kills = [...w.players.values()].reduce((s, p) => s + p.kills, 0)
      expect(kills + Math.max(...w.mode.score) + seen.size).toBeGreaterThan(0)
      if (mode === "hp") expect(Math.max(...w.mode.score)).toBeGreaterThan(0)
      if (mode === "ctf") expect(seen.has("take")).toBe(true)
      if (mode === "kc" && kills > 0) expect(seen.has("confirm") || seen.has("deny")).toBe(true)
    }
  })
})
