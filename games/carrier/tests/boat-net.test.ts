import { describe, expect, test } from "bun:test"
import { type Conn, RoomCore } from "../server/core"
import { BUILD } from "../shared/build.gen"
import { BOAT_ARMOR, BOAT_DAMAGE, BOAT_HEALTH, BOAT_MODE, CRANE, packBoat, recoverTime, unpackBoat } from "../shared/boat"
import { CombatWorld } from "../shared/combat"
import { type Crew, joinCrew, makeCrew, playerOf, recover, runOp, shipOf } from "../shared/crew"
import { opById, opError, playerBoat, shipOps, slotIsBoat } from "../shared/ops"
import { shipToWorld } from "../shared/plane"
import { type ClientMsg, type PlaneTuple, type ServerMsg, decodeClient, decodeServer, encode } from "../shared/protocol"
import { WEAPONS, lockStep, makeLoadout, makeTarget } from "../shared/weapons"
import { add } from "./crew-helpers"

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
  get id(): number {
    return this.last("welcome")!.id
  }
}

const EPOCH = 1_000_000
const T = 1_000_000

/** A room with A (team 0, at its ship's helm) and B (team 1). */
function room() {
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
  const run = (ms: number, each?: () => void) => {
    for (let left = ms; left > 0; left -= 50) {
      now += 50
      each?.()
      core.step(now)
    }
  }
  const crew = () => core.crew!
  const seaT = () => (now - EPOCH) / 1000
  return { core, a, b, say, run, crew, seaT, now: () => now }
}

describe("LAUNCH BOAT in the crew rules", () => {
  /** One ship: p1 at the helm, p2 a pilot on deck, p4 a gunner on CIWS PORT. */
  function ship(): Crew {
    const c = makeCrew(3)
    joinCrew(c, 1, "p1", T)
    for (const id of [2, 4]) add(c, id, playerOf(c, 1)!.ship, "pilot", T)
    runOp(c, 4, "ciws-port", T)
    return c
  }

  test("one boat per ship; out in it the menu is read-only", () => {
    const c = ship()
    expect(runOp(c, 2, "boat", T).error).toBeUndefined()
    expect(playerBoat(c, 2)).toBe(true)
    expect(slotIsBoat(shipOf(c, playerOf(c, 2)!.ship), playerOf(c, 2)!.plane)).toBe(true)
    expect(opError(c, 1, "boat", T)).toBe("in-use")
    expect(opError(c, 2, "helm", T)).toBe("flying")
    expect(shipOps(c, 2, T)!.find((v) => v.op.id === "boat")!.state).toBe("active")
  })

  test("sunk: the slot recharges for 40 s; brought back: it frees at once", () => {
    const c = ship()
    runOp(c, 2, "boat", T)
    recover(c, 2, "crashed", T + 1000)
    expect(opError(c, 2, "boat", T + 2000)).toBe("recharging")
    expect(opError(c, 2, "boat", T + 1000 + opById("boat")!.recharge * 1000)).toBeNull()
    runOp(c, 2, "boat", T + 50_000)
    recover(c, 2, "landed", T + 60_000)
    expect(opError(c, 2, "boat", T + 60_000)).toBeNull()
  })

  test("the driver goes back to the role they launched from, if it is still free", () => {
    const c = ship()
    const s = shipOf(c, playerOf(c, 1)!.ship)!
    // The helm launches: hands off the helm, gets it back.
    runOp(c, 1, "boat", T)
    expect(s.helm).toBeNull()
    recover(c, 1, "landed", T + 1000)
    expect(playerOf(c, 1)!.role).toBe("helm")
    expect(s.helm).toBe(1)
    // A gunner launches, and comes back to the gun.
    runOp(c, 4, "boat", T + 2000)
    expect(playerOf(c, 4)!.role).toBe("pilot")
    recover(c, 4, "crashed", T + 3000)
    expect(playerOf(c, 4)!).toMatchObject({ role: "gunner", mount: opById("ciws-port")!.mount })
    // The helm launches, someone else takes the helm: back as a pilot on deck.
    runOp(c, 1, "boat", T + 50_000)
    runOp(c, 2, "helm", T + 50_000)
    recover(c, 1, "landed", T + 51_000)
    expect(playerOf(c, 1)!).toMatchObject({ role: "pilot", plane: -1 })
  })
})

describe("boats in the combat world", () => {
  test("a boat takes armored damage, carries nothing, and can't use the jets' gun budget", () => {
    const w = new CombatWorld()
    w.spawn(1, 0, "hornet", 0, true)
    w.spawn(2, 1, "hornet")
    expect(w.fighters.get(1)).toMatchObject({ boat: true, missiles: 0, bombs: 0, flares: 0, rounds: 0 })
    expect(w.gunHit(2, 1, 10)).toBe(10)
    expect(w.hp(1)).toBeCloseTo(WEAPONS.health.max - 10 * WEAPONS.gun.damage * BOAT_ARMOR.gun, 6)
    expect(w.gunHit(1, 2, 10)).toBe(0)
    w.hurt(1, 30, 2, "shell")
    expect(w.hp(1)).toBeCloseTo(WEAPONS.health.max - 10 * WEAPONS.gun.damage * BOAT_ARMOR.gun - 30 * BOAT_ARMOR.shell, 6)
  })

  test("heat-seekers never lock a boat", () => {
    const lock = makeLoadout().lock
    const boat = { ...makeTarget(5, 1), z: -800, surface: true }
    for (let i = 0; i < 200; i++) lockStep(lock, 1 / 60, { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: -1, team: 0 }, [boat])
    expect(lock.target).toBe(-1)
    const jet = { ...makeTarget(6, 1), z: -800 }
    for (let i = 0; i < 200; i++) lockStep(lock, 1 / 60, { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: -1, team: 0 }, [boat, jet])
    expect(lock).toMatchObject({ target: 6, locked: true })
  })
})

describe("the boat over the network", () => {
  test("protocol round-trips the boat messages and rejects malformed ones", () => {
    expect(decodeClient(encode({ type: "boat", c: [1, -0.5, 1, 1200, -100, 1] }))).toEqual({ type: "boat", c: [1, -0.5, 1, 1200, -100, 1] })
    expect(decodeClient(encode({ type: "boat", c: [2, 0, 0, 0, 0, 0] }))).toBeNull()
    expect(decodeClient(encode({ type: "boat", c: [1, 0, 0.5, 0, 0, 0] }))).toBeNull()
    expect(decodeClient(encode({ type: "bhits", k: 2, on: 3, n: 4 }))).toEqual({ type: "bhits", k: 2, on: 3, n: 4 })
    expect(decodeClient(encode({ type: "bhits", k: 3, on: 3, n: 4 }))).toBeNull()
    expect(decodeClient(encode({ type: "bhits", k: 0, on: 3, n: 400 }))).toBeNull()
    const b = packBoat({ id: 3, t: 10, x: 1, z: 2, heading: 0.5, u: 10, v: 0, r: 0, power: 1, rudder: 0, yaw: 0.2, pitch: 0.1, mode: BOAT_MODE.drive, modeAt: 5, ship: 1, from: null, firing: true, boosting: false })
    const m = decodeServer(encode({ type: "boats", b: [b] }))
    expect(m?.type === "boats" && unpackBoat(m.b[0]!).firing).toBe(true)
    expect(decodeServer(encode({ type: "boats", b: [[1, 2, 3]] } as unknown as ServerMsg))).toBeNull()
  })

  test("launch: the crane lowers it, the room releases it moving with the carrier, and drives it on the driver's orders", () => {
    const { core, a, say, run, crew } = room()
    expect(playerOf(crew(), a.id)!.role).toBe("helm")
    say(a, { type: "op", op: "boat" })
    expect(core.boatSims.get(a.id)?.mode).toBe(BOAT_MODE.launch)
    expect(core.fighters.get(a.id)?.boat).toBe(true)
    run(1000)
    expect(core.boatSims.get(a.id)?.mode).toBe(BOAT_MODE.launch)
    expect(a.last("boats")?.b.some((t) => t[0] === a.id)).toBe(true)
    run(CRANE.release * 1000)
    const s = core.boatSims.get(a.id)!
    expect(s.mode).toBe(BOAT_MODE.drive)
    const ship = core.ships.get(s.ship)!
    // Off the carrier's port side, abreast of the elevator.
    expect(Math.hypot(s.boat.x - ship.x, s.boat.z - ship.z)).toBeLessThan(80)
    say(a, { type: "boat", c: [1, 0, 0, 0, 0, 0] })
    run(5000)
    expect(core.boatSims.get(a.id)!.boat.u).toBeGreaterThan(15)
    // A driver can't end the sortie themselves.
    say(a, { type: "recover", how: "landed" })
    expect(playerBoat(crew(), a.id)).toBe(true)
  })

  test("jets' guns hurt it (armored); its 25 mm hurts enemy jets and carriers, never friends", () => {
    const { core, a, b, say, run, crew } = room()
    expect(playerOf(crew(), b.id)!.team).not.toBe(playerOf(crew(), a.id)!.team)
    say(a, { type: "op", op: "boat" })
    run(3500)
    const s = core.boatSims.get(a.id)!
    // B flies over the boat in a Hornet.
    say(b, { type: "op", op: "hornet" })
    const jet = (): PlaneTuple => [(core as unknown as { seaTime(n: number): number }).seaTime(EPOCH) + 0, 1, s.boat.x + 300, 80, s.boat.z, 0, 0, 0, 1, -140, 0, 0, 0.8, 0, 0, 0, 0]
    run(100, () => say(b, { type: "plane", p: jet() }))
    say(b, { type: "hits", on: a.id, n: 10 })
    expect(core.hp(a.id)).toBeCloseTo(WEAPONS.health.max - 10 * WEAPONS.gun.damage * BOAT_ARMOR.gun, 3)
    // The boat's rounds on B's jet.
    const before = core.hp(b.id)
    say(a, { type: "bhits", k: 0, on: b.id, n: 3 })
    expect(core.hp(b.id)).toBeCloseTo(before - 3 * BOAT_DAMAGE.cannonJet, 3)
    // Out of the gun's reach of B's carrier (the fleets start kilometres apart): refused.
    const enemy = playerOf(crew(), b.id)!.ship
    const own = s.ship
    const far = core.ships.get(enemy)!
    expect(Math.hypot(far.x - s.boat.x, far.z - s.boat.z)).toBeGreaterThan(2000)
    say(a, { type: "bhits", k: 2, on: enemy, n: 5 })
    expect(core.hull(enemy)!.hp).toBe(1000)
    // Brought 400 m off B's carrier's beam: chip damage on it; on its own carrier: nothing.
    const off = shipToWorld(far, -400, 0, 0)
    Object.assign(s.boat, { x: off[0], z: off[2] })
    run(1000, () => say(b, { type: "plane", p: jet() }))
    say(a, { type: "bhits", k: 2, on: enemy, n: 5 })
    say(a, { type: "bhits", k: 2, on: own, n: 5 })
    expect(core.hull(enemy)!.hp).toBeLessThan(1000)
    expect(core.hull(own)!.hp).toBe(1000)
    // Kill feed: the room's hp messages name the boat like a jet.
    expect(b.all("hp").some((m) => m.id === a.id && m.w === "gun")).toBe(true)
  })

  test("destroyed: it sinks, the kill is credited, and its slot recharges once it has gone under", () => {
    const { core, a, b, say, run, crew } = room()
    say(a, { type: "op", op: "boat" })
    run(3500)
    const s = core.boatSims.get(a.id)!
    say(b, { type: "op", op: "hornet" })
    const jet = (): PlaneTuple => [0, 1, s.boat.x + 300, 80, s.boat.z, 0, 0, 0, 1, -140, 0, 0, 0.8, 0, 0, 0, 0]
    run(6000, () => {
      say(b, { type: "plane", p: jet() })
      say(b, { type: "hits", on: a.id, n: 4 })
    })
    expect(core.hp(a.id)).toBe(0)
    const kill = b.last("kill")!
    expect(kill).toMatchObject({ on: a.id, by: b.id, w: "gun" })
    expect(core.boatSims.get(a.id)?.mode).toBe(BOAT_MODE.sunk)
    expect(a.last("boats")?.b.find((t) => t[0] === a.id)?.[12]).toBe(BOAT_MODE.sunk)
    run(BOAT_HEALTH.sink * 1000 + 200)
    expect(core.boatSims.has(a.id)).toBe(false)
    expect(playerBoat(crew(), a.id)).toBe(false)
    // Back at the helm it launched from; the boat recharges.
    expect(playerOf(crew(), a.id)!.role).toBe("helm")
    expect(shipOps(crew(), a.id, (core as unknown as { clock(): number }).clock())!.find((v) => v.op.id === "boat")!.state).toBe("recharging")
    expect(a.last("stats")?.s.find((x) => x[0] === b.id)?.[1]).toBe(1)
  })

  test("brought back alongside slowly, the crane picks it up and the driver is back aboard", () => {
    const { core, a, say, run, crew } = room()
    say(a, { type: "op", op: "boat" })
    run(3500)
    const s = core.boatSims.get(a.id)! as unknown as { boat: { x: number; z: number; u: number; v: number; r: number; heading: number }; mode: number; ship: number; armed: boolean }
    // It was out and has come back: abreast of the crane, matching the carrier.
    run(200)
    s.armed = true
    const ship = core.ships.get(s.ship)!
    const p = shipToWorld(ship, CRANE.outX + 5, 0, CRANE.z - 10)
    Object.assign(s.boat, { x: p[0], z: p[2], heading: ship.heading, u: ship.u, v: 0, r: 0 })
    run(100)
    expect(s.mode).toBe(BOAT_MODE.recover)
    run(recoverTime(CRANE.outX + 5, CRANE.z - 10) * 1000 + 200)
    expect(playerBoat(crew(), a.id)).toBe(false)
    expect(playerOf(crew(), a.id)!.role).toBe("helm")
    expect(shipOps(crew(), a.id, (core as unknown as { clock(): number }).clock())!.find((v) => v.op.id === "boat")!.state).toBe("available")
  })
})
