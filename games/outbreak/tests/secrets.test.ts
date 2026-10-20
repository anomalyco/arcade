import { describe, expect, test } from "bun:test"
import { distToRect } from "@arcade/kit/sim/geom"
import { CoopSim } from "../shared/coop-sim"
import { propShape, type Town } from "../shared/map"
import { DEFAULT_SECRETS_TUNING, SECRETS, type SecretsTuning } from "../shared/secrets/catalog"
import { CELLAR_STASH, CELLAR_STORE, cellarLock, workLock, type SecretsState } from "../shared/secrets/cellar"
import { secretHosts } from "../shared/secrets/hosts"
import { secretSitesIn } from "../shared/secrets/places"
import { pulseLit, secretRun, PULSE_GAP, PULSE_ON } from "../shared/secrets/select"
import { generateWorldChunk } from "../shared/world"
import { SecretMemory, tallyHtml } from "../src/secrets/tally"

const seeds = (n: number, from = 1) => Array.from({ length: n }, (_, i) => ({ seed: from + i * 7919, houseSeed: from + i * 7919 }))
const T = DEFAULT_SECRETS_TUNING

describe("secrets: which a run has", () => {
  test("the same seeds pick the same secrets and numbers; subtle ones in every run, the rest in none of them all", () => {
    const runs = seeds(300).map((s) => secretRun(s, T))
    const again = seeds(300).map((s) => secretRun(s, T))
    expect(runs.map((r) => [...r.picked].join(","))).toEqual(again.map((r) => [...r.picked].join(",")))
    expect(runs.map((r) => r.code)).toEqual(again.map((r) => r.code))
    for (const s of SECRETS) {
      const share = runs.filter((r) => r.picked.has(s.id)).length / runs.length
      if (s.tier === "subtle" && s.chance >= 1) expect(share).toBe(1)
      else expect(share).toBeLessThan(1)
      if (s.tier === "event") expect(share).toBeLessThan(0.1)
    }
    // Different towns differ.
    expect(new Set(runs.map((r) => [...r.picked].join(","))).size).toBeGreaterThan(20)
    for (const r of runs) {
      expect(SECRETS.filter((s) => s.tier === "strange" && r.picked.has(s.id)).length).toBeGreaterThanOrEqual(2)
      for (const d of r.code) expect(d >= 1 && d <= 9).toBe(true)
    }
  })

  test("Today turns every secret off; a toggle drops one; Force puts one in every run; Rarity scale moves the rest", () => {
    const s = { seed: 7, houseSeed: 7 }
    expect(secretRun(s, { ...T, secrets: 0 }).picked.size).toBe(0)
    expect(secretRun(s, { ...T, secret_calendar: 0 }).picked.has("calendar")).toBe(false)
    const visitor = SECRETS.findIndex((x) => x.id === "visitor")
    for (const x of seeds(40)) expect(secretRun(x, { ...T, secretForce: visitor }).picked.has("visitor")).toBe(true)
    const count = (t: SecretsTuning) => seeds(200).filter((x) => secretRun(x, t).picked.has("cellar")).length
    expect(count({ ...T, secretRarity: 0.25 })).toBeLessThan(count(T))
    expect(count({ ...T, secretRarity: 3 })).toBe(200)
  })

  test("the radio man's set pulses its number, then pauses", () => {
    for (const n of [1, 4, 9]) {
      let pulses = 0
      let was = false
      for (let t = 0; t < n * (PULSE_ON + PULSE_GAP) + 1; t += 0.01) {
        const on = pulseLit(n, t)
        if (on && !was) pulses++
        was = on
      }
      expect(pulses).toBe(n)
    }
  })
})

describe("secrets: where they are", () => {
  test("one-house hosts are fixed per run whatever order things are asked in, and never the start house", () => {
    for (const s of seeds(40)) {
      const run = secretRun(s, { ...T, secretRarity: 4 })
      const a = secretHosts(s, "streaming", run.picked)
      const b = secretHosts({ ...s }, "streaming", new Set([...run.picked].reverse()))
      expect([...a.values()].map((h) => `${h.id}@${h.buildingId}`).sort()).toEqual([...b.values()].map((h) => `${h.id}@${h.buildingId}`).sort())
      for (const h of a.values()) expect(h.buildingId).not.toBe("ash")
      if (a.has("cellar")) expect(a.get("footprints")?.buildingId).toBe(a.get("cellar")!.buildingId)
      const homes = new Set([...a.values()].filter((h) => h.id !== "footprints").map((h) => h.buildingId))
      expect(homes.size).toBe([...a.values()].filter((h) => h.id !== "footprints").length)
    }
  })

  test("every one-house secret stands in its house on every seed, whichever is forced", () => {
    const PIECE = { nod: "nod", audience: "chair", litWindow: "window", footprints: "footprint", phone: "phone", rockingChair: "rocker", cellar: "hatch" } as const
    const missing: string[] = []
    for (const [id, piece] of Object.entries(PIECE)) {
      const force = SECRETS.findIndex((x) => x.id === id)
      for (const s of seeds(40)) {
        const run = secretRun(s, { ...T, secretForce: force })
        const hosts = secretHosts(s, "streaming", run.picked)
        const h = hosts.get(id as keyof typeof PIECE)!
        const c = generateWorldChunk(s.seed, s.houseSeed, h.cx, h.cy, "streaming")
        const town: Town = { seed: s.seed, houseSeed: s.houseSeed, terrain: 0.22, foliageDensity: 1, chunks: [c.bounds], buildings: c.buildings, barriers: c.barriers, doors: c.doors, windows: c.windows, props: c.props, lamps: c.lamps, vehicles: c.vehicles }
        const b = town.buildings.find((x) => x.id === h.buildingId)!
        if (!secretSitesIn(town, b, run, hosts).some((x) => x.piece === piece && x.secret === id)) missing.push(`${id}@${s.seed}:${b.id}`)
      }
    }
    expect(missing).toEqual([])
  })

  test("pieces in a house do not depend on the order the town lists its walls, doors and furniture", () => {
    const sim = new CoopSim(7, 7)
    const run = secretRun(sim.town, { ...T, secretRarity: 4 })
    const town = sim.town
    const elm = town.buildings.find((b) => b.id === "elm")!
    const hosts = new Map([["cellar", { id: "cellar", buildingId: "elm", rect: elm.rect, cx: 0, cy: 1 }], ["audience", { id: "audience", buildingId: "elm", rect: elm.rect, cx: 0, cy: 1 }]] as const)
    const a = secretSitesIn(town, elm, run, hosts)
    const shuffled: Town = { ...town, barriers: [...town.barriers].reverse(), doors: [...town.doors].reverse(), props: [...town.props].reverse(), windows: [...town.windows].reverse() }
    expect(secretSitesIn(shuffled, elm, run, hosts)).toEqual(a)
    expect(a.some((s) => s.piece === "hatch")).toBe(true)
    expect(a.filter((s) => s.piece === "chair").length).toBeGreaterThanOrEqual(5)
  })

  test("wall pieces hang where a survivor can stand in front of them, clear of doors and of each other", () => {
    const sim = new CoopSim(7, 7)
    sim.addSurvivor("a", 0)
    for (let i = 0; i < 6; i++) {
      Object.assign(sim.slots[0]!.survivor, { x: 44 + i * 70, y: 44 - i * 40 })
      sim.syncWorldChunks()
      const run = secretRun(sim.town, T)
      for (const b of sim.town.buildings) {
        const sites = secretSitesIn(sim.town, b, run, new Map())
        const wall = sites.filter((s) => s.piece === "calendar" || s.piece === "clock" || s.piece === "photo")
        for (const s of wall) {
          expect(s.x > b.rect[0] && s.x < b.rect[2] && s.y > b.rect[1] && s.y < b.rect[3]).toBe(true)
          for (const d of sim.town.doors) expect(distToRect(s.x, s.y, d.rect)).toBeGreaterThan(0.3)
          const standX = s.x
          const standY = s.y + 0.5
          for (const p of sim.town.props) {
            const sh = propShape(p)
            if (sh && ["shelf", "fridge", "closet"].includes(p.kind)) expect(standX > sh.rect[0] && standX < sh.rect[2] && standY > sh.rect[1] && standY < sh.rect[3]).toBe(false)
          }
          for (const o of wall) if (o !== s && Math.abs(o.y - s.y) < 0.05) expect(Math.abs(o.x - s.x)).toBeGreaterThan(0.6)
        }
      }
    }
  })
})

/** Streams a run's cellar house in and returns the sim with its secrets state. */
function atCellar(seed: number): { sim: CoopSim; state: SecretsState } | null {
  const sim = new CoopSim(seed, seed)
  sim.addSurvivor("a", 0)
  const state = sim.getFeatureState<SecretsState>("secrets")!
  const host = state.hosts.get("cellar")
  if (!host) return null
  Object.assign(sim.slots[0]!.survivor, { x: (host.rect[0] + host.rect[2]) / 2, y: host.rect[3] + 3 })
  sim.syncWorldChunks()
  return { sim, state }
}

describe("the radio man's cellar", () => {
  test("is solvable on every seed that picks it: his house holds the hatch, his set, his page, a clock and a calendar", () => {
    let picked = 0
    for (const s of seeds(70)) {
      const run = secretRun(s, T)
      if (!run.picked.has("cellar")) continue
      picked++
      const at = atCellar(s.seed)
      expect(at).not.toBeNull()
      const { sim, state } = at!
      expect(state.hatch).not.toBeNull()
      const b = sim.town.buildings.find((x) => x.id === state.hatch!.buildingId)!
      const pieces = new Set(secretSitesIn(sim.town, b, state.run, state.hosts).map((x) => x.piece))
      for (const p of ["hatch", "set", "page", "clock", "calendar", "mast"] as const) expect([s.seed, p, pieces.has(p)]).toEqual([s.seed, p, true])
      // Set the dials to the hour, the day and the number: it opens, and what he left is there to take.
      const [a, d, c] = state.run.code
      for (const [dial, want] of [a, d, c].entries()) {
        for (let k = 0; k < want; k++) workLock(sim, state, false)
        if (dial < 2) workLock(sim, state, true)
      }
      const lock = cellarLock(sim.progression.ledger.store(CELLAR_STORE))
      expect(lock.open).toBe(true)
      expect(sim.progression.contents(CELLAR_STASH).map((x) => x.item)).toEqual(["flamethrower", "flare-gun", "ammo", "medkit"])
    }
    expect(picked).toBeGreaterThan(15)
  })

  test("a wrong combination never opens it, and the dials wrap", () => {
    const seed = seeds(200).find((s) => secretRun(s, T).picked.has("cellar"))!.seed
    const { sim, state } = atCellar(seed)!
    const [a] = state.run.code
    for (let k = 0; k < 10 + ((a + 1) % 10); k++) workLock(sim, state, false)
    const lock = cellarLock(sim.progression.ledger.store(CELLAR_STORE))
    expect(lock.dials[0]).toBe((a + 1) % 10)
    expect(lock.open).toBe(false)
    expect(sim.progression.ledger.store(CELLAR_STASH)).toBeUndefined()
  })

  test("the lock survives a snapshot", () => {
    const seed = seeds(200).find((s) => secretRun(s, T).picked.has("cellar"))!.seed
    const { sim, state } = atCellar(seed)!
    workLock(sim, state, false)
    workLock(sim, state, true)
    workLock(sim, state, false)
    const fork = CoopSim.fromSnapshot(sim.toSnapshot())
    expect(cellarLock(fork.progression.ledger.store(CELLAR_STORE))).toEqual(cellarLock(sim.progression.ledger.store(CELLAR_STORE)))
  })
})

describe("the quiet tally", () => {
  test("remembers every secret this browser noticed; a new run starts at nothing", () => {
    const store = new Map<string, string>()
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) }
    const m = new SecretMemory(storage)
    expect(m.notice("calendar")).toBe(true)
    expect(m.notice("calendar")).toBe(false)
    m.notice("tallMan")
    m.newRun()
    expect(m.run.size).toBe(0)
    const again = new SecretMemory(storage)
    expect([...again.ever].sort()).toEqual(["calendar", "tallMan"])
    const html = tallyHtml(6, again.ever)
    expect(html).not.toMatch(/[A-Za-z]{3,}(?![^<]*>)/)
    expect(html.match(/<b class="on">/g)?.length).toBe(2)
    again.forget()
    expect(new SecretMemory(storage).ever.size).toBe(0)
  })
})
