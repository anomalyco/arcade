import { describe, expect, test } from "bun:test"
import { type Conn, RoomCore } from "../server/core"
import { BUILD } from "../shared/build.gen"
import { DRAFT } from "../shared/carrier-spec"
import { playerOf } from "../shared/crew"
import { makeArchipelago, terrainHeight } from "../shared/islands"
import {
  OBJECTIVE_DEFAULTS,
  Objective,
  type ObjectiveRules,
  type ObjectiveShip,
  ZONE_AREA,
  packObjective,
  packRules,
  placeZones,
  rulesOf,
  spawnPoints,
  unpackObjective,
  zoneCount,
} from "../shared/objective"
import { type ServerMsg, decodeClient, decodeServer, encode } from "../shared/protocol"

const SEEDS = [1, 7, 42, 2026, 0xdeadbeef, 95028]
const arch7 = makeArchipelago(7)

/** Steps an objective from its last time to `to` in 0.1 s steps with the same ships. */
function run(o: Objective, from: number, to: number, ships: ObjectiveShip[] | ((t: number) => ObjectiveShip[])) {
  const ev = []
  const n = Math.ceil((to - from) / 0.1 - 1e-6)
  for (let i = 0; i <= n; i++) {
    const t = Math.min(to, from + i * 0.1)
    ev.push(...o.step(t, typeof ships === "function" ? ships(t) : ships))
  }
  return ev
}

/** A carrier sitting on zone `i`'s centre at time t. */
const onZone = (o: Objective, i: number, team: number, t: number): ObjectiveShip => {
  void t
  const z = o.state.zones[i]!
  return { team, x: z.x, z: z.z, active: true }
}

describe("zone placement", () => {
  test("open water, clear of every spawn, deterministic", () => {
    for (const seed of SEEDS) {
      const arch = makeArchipelago(seed)
      const spawns = spawnPoints(arch)
      let prev = placeZones(arch, spawns, 0, 0, 2, [], 0, OBJECTIVE_DEFAULTS)
      expect(placeZones(arch, spawns, 0, 0, 2, [], 0, OBJECTIVE_DEFAULTS)).toEqual(prev)
      for (let cycle = 0; cycle < 6; cycle++) {
        const t0 = cycle * OBJECTIVE_DEFAULTS.cycle
        const zones = cycle === 0 ? prev : placeZones(arch, spawns, 0, cycle, cycle % 2 ? 1 : 2, prev, t0, OBJECTIVE_DEFAULTS)
        for (const z of zones) {
          {
            const c = [z.x, z.z] as const
            expect(Math.hypot(c[0], c[1])).toBeLessThanOrEqual(ZONE_AREA.reach + 1)
            for (const s of spawns) expect(Math.hypot(c[0] - s.x, c[1] - s.z) - z.r).toBeGreaterThanOrEqual(ZONE_AREA.spawnGap)
            // A carrier fits anywhere in the inner 70%: deep water across it.
            for (let i = 0; i < 24; i++) {
              const a = (i / 24) * Math.PI * 2
              for (const k of [0, 0.3, 0.6]) expect(terrainHeight(arch, c[0] + Math.cos(a) * z.r * k, c[1] + Math.sin(a) * z.r * k)).toBeLessThan(-DRAFT)
            }
          }
        }
        if (zones.length === 2) expect(Math.hypot(zones[0]!.x - zones[1]!.x, zones[0]!.z - zones[1]!.z)).toBeGreaterThan(zones[0]!.r * 2 + ZONE_AREA.gap - 1)
        if (cycle > 0) {
          const hop = Math.hypot(prev[0]!.x - zones[0]!.x, prev[0]!.z - zones[0]!.z)
          expect(hop).toBeGreaterThanOrEqual(ZONE_AREA.hop)
          expect(hop).toBeLessThanOrEqual(ZONE_AREA.maxHop)
        }
        prev = zones
      }
    }
  })

  test("a round's first zone sits near the middle, equally reachable from every spawn", () => {
    for (const seed of SEEDS) {
      const arch = makeArchipelago(seed)
      const spawns = spawnPoints(arch)
      const [z] = placeZones(arch, spawns, 3, 0, 1, [], 0, OBJECTIVE_DEFAULTS)
      expect(Math.hypot(z!.x, z!.z)).toBeLessThanOrEqual(ZONE_AREA.firstReach)
      const d = spawns.map((s) => Math.hypot(s.x - z!.x, s.z - z!.z))
      expect(Math.max(...d) - Math.min(...d)).toBeLessThan(2 * ZONE_AREA.firstReach + 600)
    }
  })
})

describe("zone count", () => {
  test("fewer than four active ships: one zone; four: two", () => {
    expect([0, 1, 2, 3, 4].map((n) => zoneCount(n))).toEqual([1, 1, 1, 1, 2])
    const r: ObjectiveRules = { ...OBJECTIVE_DEFAULTS, twoZonesAt: 3 }
    expect(zoneCount(3, r)).toBe(2)
  })

  test("re-evaluated when the next spots are revealed", () => {
    const o = new Objective(arch7, 0, OBJECTIVE_DEFAULTS, 1)
    expect(o.state.zones).toHaveLength(1)
    const far = (team: number): ObjectiveShip => ({ team, x: 9000, z: 9000 + team * 500, active: true })
    const four = [0, 1, 2, 3].map(far)
    const R = OBJECTIVE_DEFAULTS
    run(o, 0, R.cycle - R.warning + 0.05, four)
    expect(o.state.next).toHaveLength(2)
    run(o, R.cycle - R.warning + 0.15, R.cycle + 0.05, four)
    expect(o.state.zones).toHaveLength(2)
    // Back to three active (one empty, so inactive): the next reveal has one.
    const three = [far(0), far(1), far(2), { ...far(3), active: false }]
    const reveal = R.cycle * 2 - R.warning
    run(o, R.cycle + 0.15, reveal + 0.05, three)
    expect(o.state.next).toHaveLength(1)
  })
})

describe("capture and score", () => {
  const R = OBJECTIVE_DEFAULTS

  test("alone in a zone: captured over the capture time, then scores while inside", () => {
    const o = new Objective(arch7, 0)
    const ev = run(o, 0, R.capture - 0.5, (t) => [onZone(o, 0, 2, t)])
    expect(o.state.zones[0]!.holder).toBe(-1)
    expect(o.state.zones[0]!.cap).toBe(2)
    expect(o.state.zones[0]!.present).toBe(1 << 2)
    expect(ev.some((e) => e.k === "captured")).toBe(false)
    const ev2 = run(o, R.capture - 0.4, R.capture + 10, (t) => [onZone(o, 0, 2, t)])
    expect(ev2).toContainEqual({ k: "captured", zone: 0, team: 2 })
    expect(o.state.zones[0]!.holder).toBe(2)
    expect(o.state.scores[2]).toBeCloseTo(R.rate * 10, 0)
    // Leaving: still theirs, but no more points.
    const s = o.state.scores[2]!
    run(o, R.capture + 10.1, R.capture + 20, [{ team: 2, x: 9000, z: 9000, active: true }])
    expect(o.state.zones[0]!.holder).toBe(2)
    expect(o.state.scores[2]).toBe(s)
  })

  test("contested: two carriers inside freeze the progress and nobody scores", () => {
    const o = new Objective(arch7, 0)
    run(o, 0, 4, (t) => [onZone(o, 0, 0, t)])
    const p = o.state.zones[0]!.progress
    expect(p).toBeGreaterThan(0.3)
    run(o, 4.1, 20, (t) => [onZone(o, 0, 0, t), onZone(o, 0, 1, t)])
    expect(o.state.zones[0]!.progress).toBeCloseTo(p, 5)
    expect(o.state.zones[0]!.present).toBe(0b11)
    expect(o.state.scores).toEqual([0, 0, 0, 0])
  })

  test("another side drains a held zone to neutral before capturing it", () => {
    const o = new Objective(arch7, 0)
    run(o, 0, R.capture + 1, (t) => [onZone(o, 0, 0, t)])
    expect(o.state.zones[0]!.holder).toBe(0)
    const ev = run(o, R.capture + 1.1, R.capture * 2 + 1.5, (t) => [onZone(o, 0, 3, t)])
    expect(ev).toContainEqual({ k: "neutral", zone: 0, team: 0 })
    expect(o.state.zones[0]!.holder).toBe(-1)
    expect(o.state.zones[0]!.cap).toBe(3)
    run(o, R.capture * 2 + 1.6, R.capture * 3 + 2, (t) => [onZone(o, 0, 3, t)])
    expect(o.state.zones[0]!.holder).toBe(3)
  })

  test("inactive carriers (empty or sinking) neither capture nor contest", () => {
    const o = new Objective(arch7, 0)
    run(o, 0, R.capture + 1, (t) => [onZone(o, 0, 0, t), { ...onZone(o, 0, 1, t), active: false }])
    expect(o.state.zones[0]!.holder).toBe(0)
  })

  test("half a capture left alone empties again", () => {
    const o = new Objective(arch7, 0)
    run(o, 0, 5, (t) => [onZone(o, 0, 1, t)])
    run(o, 5.1, 30, [])
    expect(o.state.zones[0]!.progress).toBe(0)
    expect(o.state.zones[0]!.cap).toBe(-1)
  })
})

describe("relocation and rounds", () => {
  const R = OBJECTIVE_DEFAULTS

  test("zones stay put for the cycle; next spots appear `warning` s ahead, then the zones move (neutral again)", () => {
    const o = new Objective(arch7, 100)
    const first = o.state.zones[0]!
    const move = 100 + R.cycle
    expect(R.cycle).toBe(300)
    expect(o.state.moveAt).toBe(move)
    run(o, 100, move - R.warning - 0.2, [])
    expect(o.state.next).toHaveLength(0)
    // Static the whole time.
    expect(o.state.zones[0]).toMatchObject({ x: first.x, z: first.z })
    const ev = run(o, move - R.warning - 0.1, move - R.warning + 0.1, [])
    expect(ev).toContainEqual({ k: "reveal", count: 1 })
    const next = o.state.next[0]!
    expect(next.t0).toBe(move)
    const ev2 = run(o, move - R.warning + 0.2, move + 0.1, [])
    expect(ev2).toContainEqual({ k: "moved", count: 1 })
    expect(o.state.zones[0]).toMatchObject({ x: next.x, z: next.z, holder: -1, progress: 0 })
    expect(o.state.zones[0]!.x).not.toBe(first.x)
    expect(o.state.cycle).toBe(1)
    expect(o.state.moveAt).toBe(move + R.cycle)
  })

  test("a round ends at the target, shows the winner, then restarts with the scores reset", () => {
    const rules: ObjectiveRules = { ...R, target: 50, rate: 10 }
    const o = new Objective(arch7, 0, rules)
    const ev = run(o, 0, rules.capture + 8, (t) => (o.state.end < 0 ? [onZone(o, 0, 1, t)] : []))
    expect(ev).toContainEqual({ k: "end", winner: 1 })
    expect(o.state.winner).toBe(1)
    const end = o.state.end
    expect(end).toBeGreaterThan(rules.capture + 4)
    const ev2 = run(o, rules.capture + 8.1, end + rules.intermission + 0.2, [])
    expect(ev2).toContainEqual({ k: "round", round: 1 })
    expect(o.state.end).toBe(-1)
    expect(o.state.scores).toEqual([0, 0, 0, 0])
    expect(o.state.cycle).toBe(0)
  })

  test("no clock: a round without points runs on through relocations until someone reaches the target", () => {
    const o = new Objective(arch7, 0)
    run(o, 0, R.cycle * 8, [])
    expect(o.state.end).toBe(-1)
    expect(o.state.cycle).toBe(8)
    expect(Object.keys(rulesOf(packRules(R)))).not.toContain("roundTime")
  })

  test("rules from the wire are clamped", () => {
    const r = rulesOf([1e9, -5, Number.NaN])
    expect(r.radius).toBe(1200)
    expect(r.cycle).toBe(45)
    expect(r.warning).toBe(OBJECTIVE_DEFAULTS.warning)
    expect(r.capture).toBe(OBJECTIVE_DEFAULTS.capture)
  })
})

describe("wire", () => {
  test("packObjective round-trips through unpackObjective", () => {
    const o = new Objective(arch7, 0)
    run(o, 0, OBJECTIVE_DEFAULTS.cycle - 5, (t) => [onZone(o, 0, 1, t)])
    const v = unpackObjective(JSON.parse(JSON.stringify(packObjective(o.state))))!
    expect(v).not.toBeNull()
    expect(v.zones).toHaveLength(1)
    expect(v.next).toHaveLength(1)
    expect(v.zones[0]!.holder).toBe(1)
    expect(v.scores[1]).toBeCloseTo(o.state.scores[1]!, 0)
    expect(v.moveAt).toBe(o.state.moveAt)
    expect(v.rules.target).toBe(OBJECTIVE_DEFAULTS.target)
    expect(v.zones[0]!.x).toBeCloseTo(o.state.zones[0]!.x, 0)
    expect(unpackObjective([1, 2, 3])).toBeNull()
    expect(unpackObjective("x")).toBeNull()
  })

  test("a dev client's rules message decodes", () => {
    expect(decodeClient(encode({ type: "objective", r: packRules(OBJECTIVE_DEFAULTS) }))).toMatchObject({ type: "objective" })
  })
})

class FakeConn implements Conn {
  sent: ServerMsg[] = []
  send(data: string) {
    const m = decodeServer(data)
    if (!m) throw new Error(`bad frame ${data}`)
    this.sent.push(m)
  }
  close() {}
  all<T extends ServerMsg["type"]>(type: T): Extract<ServerMsg, { type: T }>[] {
    return this.sent.filter((m): m is Extract<ServerMsg, { type: T }> => m.type === type)
  }
  last<T extends ServerMsg["type"]>(type: T): Extract<ServerMsg, { type: T }> | undefined {
    return this.all(type).at(-1)
  }
}

describe("room", () => {
  function room(dev = false) {
    let now = 1_000_000
    const core = new RoomCore(
      () => now,
      () => 42,
      { dev },
    )
    const step = (ms: number) => {
      for (let left = ms; left > 0; left -= 50) {
        now += Math.min(50, left)
        core.step(now)
      }
    }
    const join = (name: string) => {
      const c = new FakeConn()
      core.message(c, encode({ type: "hello", build: BUILD, name }))
      return c
    }
    return { core, step, join }
  }

  test("joiners get the objective; a crewed carrier in the zone captures it and scores, and everyone hears", () => {
    const { core, step, join } = room()
    const a = join("ada")
    const b = join("bo")
    const v0 = unpackObjective(a.last("obj")!.o)!
    expect(v0.zones).toHaveLength(1)
    expect(b.last("obj")).toBeDefined()
    // Teleport ada's carrier onto the zone.
    const me = playerOf(core.crew!, a.last("welcome")!.id)!
    const ship = core.ships.get(me.ship)!
    const st = core.objectiveState!
    const c = [st.zones[0]!.x, st.zones[0]!.z] as const
    ship.x = c[0]
    ship.z = c[1]
    const before = b.all("obj").length
    step(OBJECTIVE_DEFAULTS.capture * 1000 + 3000)
    const v = unpackObjective(b.last("obj")!.o)!
    expect(v.zones[0]!.holder).toBe(me.team)
    expect(v.scores[me.team]).toBeGreaterThan(OBJECTIVE_DEFAULTS.rate * 1.5)
    // ~4 Hz while it is being taken.
    const sent = b.all("obj").length - before
    expect(sent).toBeGreaterThan(OBJECTIVE_DEFAULTS.capture * 3)
    expect(sent).toBeLessThan(OBJECTIVE_DEFAULTS.capture * 6 + 20)
  })

  test("empty carriers don't capture; new rules restart the round in dev rooms only", () => {
    const { core, step, join } = room()
    const a = join("ada")
    const empty = core.crew!.ships.find((s) => s.helm === null && s.pilots.length === 0)!
    const st = core.objectiveState!
    const c = [st.zones[0]!.x, st.zones[0]!.z] as const
    const ship = core.ships.get(empty.id)!
    ship.x = c[0]
    ship.z = c[1]
    step(OBJECTIVE_DEFAULTS.capture * 1000 + 2000)
    expect(core.objectiveState!.zones[0]!.holder).toBe(-1)
    core.message(a, encode({ type: "objective", r: packRules({ ...OBJECTIVE_DEFAULTS, radius: 900 }) }))
    expect(a.last("nope")?.error).toBe("dev-only")
    expect(core.objectiveState!.zones[0]!.r).toBe(OBJECTIVE_DEFAULTS.radius)

    const d = room(true)
    const x = d.join("dev")
    d.core.message(x, encode({ type: "objective", r: packRules({ ...OBJECTIVE_DEFAULTS, radius: 900 }) }))
    d.step(100)
    expect(d.core.objectiveState!.zones[0]!.r).toBe(900)
    expect(unpackObjective(x.last("obj")!.o)!.zones[0]!.r).toBe(900)
  })
  test("ships, crew and aircraft never reset: through captures, a relocation, a round end and restart, and new rules", () => {
    const d = room(true)
    const a = d.join("ada")
    d.join("bo")
    const rules = { ...OBJECTIVE_DEFAULTS, cycle: 45, warning: 5, capture: 2, rate: 10, target: 300, intermission: 5 }
    d.core.message(a, encode({ type: "objective", r: packRules(rules) }))
    d.step(100)
    const crew = d.core.crew!
    const me = playerOf(crew, a.last("welcome")!.id)!
    // Every carrier under way, A's parked on the zone.
    for (const s of crew.ships) {
      const sim = (d.core as unknown as { sims: Map<number, { controls: { throttle: number; rudder: number } }> }).sims.get(s.id)!
      sim.controls = { throttle: 0.6, rudder: 0.3 }
    }
    const z0 = d.core.objectiveState!.zones[0]!
    const mine = d.core.ships.get(me.ship)!
    mine.x = z0.x
    mine.z = z0.z
    const crewBefore = JSON.stringify(crew.ships.map((s) => [s.id, s.team, s.helm, s.pilots, s.aircraft]))
    const ids = [...d.core.ships.keys()].join()
    let last = new Map([...d.core.ships].map(([id, s]) => [id, [s.x, s.z]]))
    let worst = 0
    const watch = (ms: number) => {
      for (let left = ms; left > 0; left -= 50) {
        d.step(50)
        for (const [id, s] of d.core.ships) {
          const p = last.get(id)!
          worst = Math.max(worst, Math.hypot(s.x - p[0]!, s.z - p[1]!))
        }
        last = new Map([...d.core.ships].map(([id, s]) => [id, [s.x, s.z]]))
      }
    }
    const round0 = d.core.objectiveState!.round
    // Hold the zone (the sim moves the ship; keep putting it back is a teleport, so let it sail out and in naturally).
    watch(50_000)
    const st = d.core.objectiveState!
    expect(st.cycle + (st.round > round0 ? 1 : 0)).toBeGreaterThan(0)
    // Force a round end and the restart after it.
    st.scores[me.team] = rules.target
    watch(rules.intermission * 1000 + 1500)
    expect(d.core.objectiveState!.round).toBeGreaterThan(round0)
    // A dev rules message restarts the round too.
    d.core.message(a, encode({ type: "objective", r: packRules(rules) }))
    watch(1000)
    // Top speed at 60% throttle is ~14 m/s: never more than a step's travel between ticks.
    expect(worst).toBeLessThan(2)
    expect([...d.core.ships.keys()].join()).toBe(ids)
    expect(JSON.stringify(d.core.crew!.ships.map((s) => [s.id, s.team, s.helm, s.pilots, s.aircraft]))).toBe(crewBefore)
  })
})
