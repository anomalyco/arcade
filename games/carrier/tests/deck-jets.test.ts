import { describe, expect, test } from "bun:test"
import { type Conn, RoomCore } from "../server/core"
import { BUILD } from "../shared/build.gen"
import { APRON, CENTERLINE_X, DECK_Y, ELEVATOR, ISLAND, RUNWAY, inRect } from "../shared/carrier-spec"
import { type Crew, type CrewShip, makeCrew, playerOf, shipOf, wreckParked } from "../shared/crew"
import { DECK_BAYS, DECK_JET, DeckJets, bayCorners, bayOf, crashFalloff, isParked, parkedAt, parkedJets } from "../shared/deck-jets"
import { LAUNCH } from "../shared/launch"
import { makeSlots, opById } from "../shared/ops"
import { shipQuat, shipToWorld } from "../shared/plane"
import { type ClientMsg, type PlaneTuple, type ServerMsg, decodeClient, decodeServer, encode } from "../shared/protocol"
import { makeShip } from "../shared/ship"

const ship = (id = 1, team = 1): CrewShip => ({ id, name: "CV-07 TEST", hull: 7, team, helm: null, pilots: [], aircraft: makeSlots(), emptySince: null, captain: null, locked: false, bans: [], catapultUntil: 0 })
const crewOf = (...ships: CrewShip[]): Crew => ({ ...makeCrew(7), ships, players: [] })

describe("parking layout", () => {
  test("one bay per flying slot of the catalogue: the Hornets, then the F-35C; never the boat", () => {
    const s = ship()
    const kinds = s.aircraft.map((a, i) => [opById(a.op)!.id, bayOf(s, i)])
    expect(kinds).toEqual([
      ["hornet", 0],
      ["hornet", 1],
      ["f35", 2],
      ["boat", -1],
    ])
    expect(DECK_BAYS.length).toBe(3)
    // An extra slot (a pilot rescued from a sunk carrier) has no bay.
    s.aircraft.push({ op: "hornet", pilot: null, readyAt: 0 })
    expect(bayOf(s, 4)).toBe(-1)
  })

  test("every bay's jet stands on the apron, clear of the runway, the catapult, the landing path, the island and the elevator", () => {
    const wingtip = CENTERLINE_X - 7.5
    for (const b of DECK_BAYS) {
      for (const [x, z] of bayCorners(b)) {
        expect(inRect(APRON, x, z)).toBe(true)
        expect(x).toBeLessThan(RUNWAY.x0)
        // A jet on the catapult track or landing on the centreline keeps its wingtips clear.
        expect(x).toBeLessThan(wingtip - 10)
        expect(x).toBeLessThan(LAUNCH.x - 20)
        expect(inRect(ISLAND, x, z)).toBe(false)
        expect(inRect(ELEVATOR, x, z)).toBe(false)
      }
      // Wholly fore or aft of the island, so no edge crosses it either.
      const zs = bayCorners(b).map(([, z]) => z)
      expect(Math.min(...zs) > ISLAND.z1 || Math.max(...zs) < ISLAND.z0).toBe(true)
    }
    // Bays don't overlap each other.
    for (let i = 0; i < DECK_BAYS.length; i++)
      for (let j = i + 1; j < DECK_BAYS.length; j++) {
        const a = bayCorners(DECK_BAYS[i]!).map(([, z]) => z)
        const b = bayCorners(DECK_BAYS[j]!).map(([, z]) => z)
        expect(Math.min(...a) > Math.max(...b) || Math.min(...b) > Math.max(...a)).toBe(true)
      }
  })
})

describe("availability → parked jets", () => {
  test("ready slots are parked; flown, recharging and boat slots are not; a landing frees the bay at once", () => {
    const s = ship()
    const now = 50_000
    expect(parkedJets(s, now).map((p) => [p.slot, p.kind])).toEqual([
      [0, "hornet"],
      [1, "hornet"],
      [2, "f35"],
    ])
    s.aircraft[0]!.pilot = 9
    s.aircraft[2]!.readyAt = now + 1
    expect(parkedJets(s, now).map((p) => p.slot)).toEqual([1])
    expect(parkedJets(s, now + 1).map((p) => p.slot)).toEqual([1, 2])
    s.aircraft[0]!.pilot = null
    expect(isParked(s, 0, now)).toBe(true)
    expect(isParked(s, 3, now)).toBe(false)
  })

  test("parkedAt: a round striking the deck inside a parked jet's box hits it; elsewhere, above it or an empty bay, nothing", () => {
    const s = ship()
    const b = DECK_BAYS[1]!
    expect(parkedAt(s, 0, b.x, DECK_Y - 0.2, b.z)).toBe(1)
    expect(parkedAt(s, 0, b.x + Math.sin(b.yaw) * 9, DECK_Y + 2, b.z + Math.cos(b.yaw) * 9)).toBe(1)
    expect(parkedAt(s, 0, b.x, DECK_Y + DECK_JET.height + 1, b.z)).toBe(-1)
    expect(parkedAt(s, 0, CENTERLINE_X, DECK_Y - 0.2, b.z)).toBe(-1)
    s.aircraft[1]!.readyAt = 10
    expect(parkedAt(s, 0, b.x, DECK_Y - 0.2, b.z)).toBe(-1)
  })
})

describe("parked jet health", () => {
  test("damage adds up to a kill; friendly fire, empty bays and wrecks are refused; repair after a quiet spell", () => {
    const s = ship(1, 1)
    const crew = crewOf(s)
    const d = new DeckJets()
    expect(d.hit(crew, 1, 0, 30, 5, 1, "gun", 0)).toBe(0)
    expect(d.hit(crew, 1, 3, 30, 5, 0, "gun", 0)).toBe(0)
    expect(d.hit(crew, 1, 0, 30, 5, 0, "gun", 0)).toBe(30)
    expect(d.health(1, 0)).toBe(DECK_JET.hp - 30)
    d.step(crew, DECK_JET.repairDelay - 1)
    expect(d.health(1, 0)).toBe(DECK_JET.hp - 30)
    d.step(crew, DECK_JET.repairDelay)
    expect(d.health(1, 0)).toBe(DECK_JET.hp)
    expect(d.hit(crew, 1, 2, DECK_JET.hp - 1, 5, 0, "missile", 0)).toBe(DECK_JET.hp - 1)
    expect(d.events).toEqual([])
    expect(d.hit(crew, 1, 2, 10, 6, 0, "gun", 1)).toBe(1)
    expect(d.events).toEqual([{ k: "kill", ship: 1, slot: 2, kind: "f35", by: 6, w: "gun" }])
    // The wreck takes no more until its slot has left the bay.
    expect(d.hit(crew, 1, 2, 10, 6, 0, "gun", 2)).toBe(0)
    // Its loss recharges the slot like a crash (the F-35C's 45 s).
    const out = wreckParked(crew, 1, 2, 2)
    expect(out.events).toEqual([{ k: "wreck", ship: 1, slot: 2, readyAt: 2 + 45_000 }])
    expect(wreckParked(crew, 1, 2, 3).error).toBe("in-use")
    d.step(crew, 3)
    expect(isParked(s, 2, 3)).toBe(false)
    // Back from its recharge: a whole new jet.
    expect(d.health(1, 2)).toBe(DECK_JET.hp)
    expect(isParked(s, 2, 2 + 45_000)).toBe(true)
  })

  test("a launch takes the jet out of its bay and its damage with it", () => {
    const s = ship()
    const crew = crewOf(s)
    const d = new DeckJets()
    d.hit(crew, 1, 0, 20, 5, 0, "gun", 0)
    s.aircraft[0]!.pilot = 9
    d.step(crew, 1)
    s.aircraft[0]!.pilot = null
    expect(d.health(1, 0)).toBe(DECK_JET.hp)
  })

  test("a burst hurts the enemy parked jets within reach on the drawn deck, deterministically", () => {
    const run = () => {
      const s = ship(1, 1)
      const crew = crewOf(s)
      const pose = Object.assign(makeShip(100, -200, 0.7, 0), { id: 1, team: 1, heave: 1.3, pitch: 0.02, roll: -0.03 })
      const d = new DeckJets()
      const b = DECK_BAYS[0]!
      const p = shipToWorld(pose, b.x + 3, DECK_Y, b.z - 2)
      // A friendly burst: nothing.
      expect(d.blast(crew, [pose], p[0], p[1], p[2], 4, 1, "bomb", () => 100, 0)).toBe(0)
      // A crash 16 m away destroys it; the other bays (~56 m and more off) are untouched.
      const n = d.blast(crew, [pose], p[0], p[1], p[2], 4, 0, "crash", crashFalloff, 0)
      return { n, events: d.events.slice(), hp: [0, 1, 2].map((i) => d.health(1, i)) }
    }
    const a = run()
    expect(a.n).toBe(1)
    expect(a.events).toEqual([{ k: "kill", ship: 1, slot: 0, kind: "hornet", by: 4, w: "crash" }])
    expect(a.hp).toEqual([0, DECK_JET.hp, DECK_JET.hp])
    expect(run()).toEqual(a)
  })
})

class FakeConn implements Conn {
  sent: ServerMsg[] = []
  send(data: string | Uint8Array) {
    const m = decodeServer(data)
    if (!m) throw new Error(`bad frame`)
    this.sent.push(m)
  }
  close() {}
  all<T extends ServerMsg["type"]>(type: T): Extract<ServerMsg, { type: T }>[] {
    return this.sent.filter((m): m is Extract<ServerMsg, { type: T }> => m.type === type)
  }
  last<T extends ServerMsg["type"]>(type: T): Extract<ServerMsg, { type: T }> | undefined {
    return this.all(type).at(-1)
  }
  get id(): number {
    return this.last("welcome")!.id
  }
}

const EPOCH = 1_000_000

/** A (team 0) flies, B (team 1) helms its carrier; C joins B's ship later as a gunner if needed. */
function battle() {
  let now = EPOCH
  const core = new RoomCore(
    () => now,
    () => 42,
  )
  const join = (name: string) => {
    const c = new FakeConn()
    core.message(c, encode({ type: "hello", build: BUILD, name }))
    return c
  }
  const say = (c: FakeConn, msg: ClientMsg) => core.message(c, encode(msg))
  const a = join("ada")
  const b = join("bo")
  const seaT = () => (now - EPOCH) / 1000
  const run = (ms: number) => {
    for (let left = ms; left > 0; left -= 50) {
      now += 50
      core.step(now)
    }
  }
  run(200)
  const bShip = () => playerOf(core.crew!, b.id)!.ship
  const pose = () => core.ships.get(bShip())!
  /** A's jet `up` m above ship-local (x, z) of B's carrier, flying with it. */
  const over = (x: number, z: number, up: number, mode = 1): PlaneTuple => {
    const s = pose()
    const p = shipToWorld({ ...s, pitch: 0, roll: 0 }, x, DECK_Y + up, z, [0, 0, 0])
    const f = [Math.sin(s.heading), -Math.cos(s.heading)]
    const q = shipQuat({ ...s, pitch: 0, roll: 0 }, [0, 0, 0, 1])
    return [seaT(), mode, p[0], p[1], p[2], q[0], q[1], q[2], q[3], f[0]! * s.u, 0, f[1]! * s.u, 0.8, 0, 0, 0, 0, 1, 0]
  }
  const launch = (op: string) => {
    say(a, { type: "op", op })
    expect(playerOf(core.crew!, a.id)!.plane).toBeGreaterThanOrEqual(0)
    say(a, { type: "plane", p: over(15, 0, 300) })
  }
  return { core, a, b, say, run, seaT, bShip, over, launch, join, now: () => now }
}

describe("parked jets over the network", () => {
  test("protocol: deckhits travels as a binary frame, deckkill as JSON; malformed ones are dropped", () => {
    const hits: ClientMsg = { type: "deckhits", w: 2, ship: 3, slot: 1, n: 12 }
    const frame = encode(hits)
    expect(frame).toBeInstanceOf(Uint8Array)
    expect(decodeClient(frame)).toEqual(hits)
    expect(decodeClient(JSON.stringify({ ...hits, w: 3 }))).toBeNull()
    expect(decodeClient(JSON.stringify({ ...hits, n: 0 }))).toBeNull()
    const kill: ServerMsg = { type: "deckkill", ship: 3, slot: 1, by: 4, w: "bomb" }
    expect(decodeServer(encode(kill))).toEqual(kill)
    expect(decodeServer(JSON.stringify({ ...kill, w: "laser" }))).toBeNull()
  })

  test("a Hornet strafes a parked Hornet: budgeted rounds destroy it, credited, and its slot recharges like a crash", () => {
    const w = battle()
    w.launch("hornet")
    w.say(w.a, { type: "plane", p: w.over(-25, -300, 80) })
    const id = w.bShip()
    w.say(w.a, { type: "deckhits", w: 0, ship: id, slot: 0, n: 20 })
    expect(w.core.deckJetHp(id, 0)).toBe(DECK_JET.hp - 40)
    expect(w.b.all("deckkill")).toEqual([])
    w.run(1000)
    w.say(w.a, { type: "deckhits", w: 0, ship: id, slot: 0, n: 20 })
    expect(w.b.last("deckkill")).toEqual({ type: "deckkill", ship: id, slot: 0, by: w.a.id, w: "gun" })
    const slot = shipOf(w.core.crew!, id)!.aircraft[0]!
    expect(slot.readyAt).toBe(w.now() + opById("hornet")!.recharge * 1000)
    // Everyone's crew shows the bay empty until then; the other Hornet still stands.
    const seen = shipOf(w.b.last("crew")!.crew, id)!
    expect(parkedJets(seen, w.now()).map((p) => p.slot)).toEqual([1, 2])
    // Launching it is refused while it recharges.
    w.say(w.b, { type: "op", op: "hornet" })
    expect(playerOf(w.core.crew!, w.b.id)!.plane).toBe(1)
  })

  test("claims are checked like hull hits: no gun in the air, out of range, a friendly deck or an empty bay change nothing", () => {
    const w = battle()
    const id = w.bShip()
    // A on deck: no jet, no rounds.
    w.say(w.a, { type: "deckhits", w: 0, ship: id, slot: 0, n: 20 })
    expect(w.core.deckJetHp(id, 0)).toBe(DECK_JET.hp)
    // A CIWS claim from someone who mans none; a boat claim with no boat.
    w.say(w.a, { type: "deckhits", w: 1, ship: id, slot: 0, n: 20 })
    w.say(w.a, { type: "deckhits", w: 2, ship: id, slot: 0, n: 20 })
    expect(w.core.deckJetHp(id, 0)).toBe(DECK_JET.hp)
    w.launch("hornet")
    // 5 km away.
    w.say(w.a, { type: "plane", p: w.over(-25, -5000, 80) })
    w.say(w.a, { type: "deckhits", w: 0, ship: id, slot: 0, n: 20 })
    expect(w.core.deckJetHp(id, 0)).toBe(DECK_JET.hp)
    // Its own carrier's jets: friendly.
    const own = playerOf(w.core.crew!, w.a.id)!.ship
    w.say(w.a, { type: "plane", p: w.over(-25, -300, 80) })
    w.say(w.a, { type: "deckhits", w: 0, ship: own, slot: 1, n: 20 })
    expect(w.core.deckJetHp(own, 1)).toBe(DECK_JET.hp)
    // B's boat bay (slot 3) holds no jet.
    w.say(w.a, { type: "deckhits", w: 0, ship: id, slot: 3, n: 20 })
    expect(w.b.all("deckkill")).toEqual([])
  })

  test("an F-35C's bomb on a parked jet destroys it (and dents the deck); the same drop gives the same result", () => {
    const drop = () => {
      const w = battle()
      w.launch("f35")
      const b = DECK_BAYS[0]!
      const p = w.over(b.x, b.z, 120)
      w.say(w.a, { type: "plane", p })
      w.say(w.a, { type: "fire", m: [0, w.seaT(), p[2], p[3], p[4], p[9], 0, p[11], -1, 1] })
      w.run(7000)
      const id = w.bShip()
      return { kills: w.b.all("deckkill"), ready: shipOf(w.core.crew!, id)!.aircraft.map((a) => a.readyAt), hp: w.core.hull(id)!.hp, a: w.a.id, start: w.now() - 7000 }
    }
    const r = drop()
    expect(r.kills.length).toBe(1)
    expect(r.kills[0]).toMatchObject({ slot: 0, by: r.a, w: "bomb" })
    expect(r.ready[0]).toBeGreaterThan(r.start)
    expect(r.ready.slice(1)).toEqual([0, 0, 0])
    expect(r.hp).toBeLessThan(1000)
    expect(drop()).toEqual(r)
  })
})
