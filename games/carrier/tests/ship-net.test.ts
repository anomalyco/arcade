import { describe, expect, test } from "bun:test"
import { type Conn, RoomCore, SHIPS_EVERY_MS } from "../server/core"
import { BUILD } from "../shared/build.gen"
import { CREW, playerOf } from "../shared/crew"
import { type ClientMsg, type ServerMsg, type ShipTuple, decodeClient, decodeServer, encode } from "../shared/protocol"
import { SHIP } from "../shared/ship"

class FakeConn implements Conn {
  sent: ServerMsg[] = []
  closed: number | null = null
  send(data: string) {
    const m = decodeServer(data)
    if (!m) throw new Error(`bad frame ${data}`)
    this.sent.push(m)
  }
  close(code?: number) {
    this.closed = code ?? 1000
  }
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

function room() {
  let now = 1_000_000
  const core = new RoomCore(
    () => now,
    () => 42,
  )
  /** Advances the clock in room ticks, stepping the room like its timer does. */
  const run = (ms: number) => {
    for (let left = ms; left > 0; left -= 50) {
      now += Math.min(50, left)
      core.step(now)
    }
  }
  const join = (name: string, extra: Partial<Extract<ClientMsg, { type: "hello" }>> = {}) => {
    const c = new FakeConn()
    core.message(c, encode({ type: "hello", build: BUILD, name, ...extra }))
    return c
  }
  const say = (c: FakeConn, msg: ClientMsg) => core.message(c, encode(msg))
  return { core, run, join, say, now: () => now }
}

const shipIn = (frame: Extract<ServerMsg, { type: "ships" }> | undefined, id: number): ShipTuple | undefined => frame?.s.find((s) => s[0] === id)

describe("room ships", () => {
  test("joiners share a world and a ship: the first takes the helm, the crew is sent to everyone", () => {
    const { core, join } = room()
    const a = join("ada")
    const c = join("cy")
    const b = join("bo")
    const crew = core.crew!
    expect(playerOf(crew, a.id)!.plane).toBe(-1)
    // The second joiner starts the other team at its first ship's helm; the third waits on a's deck as a pilot.
    expect(playerOf(crew, b.id)).toMatchObject({ ship: playerOf(crew, a.id)!.ship, role: "pilot", plane: -1 })
    expect(playerOf(crew, c.id)!.plane).toBe(-1)
    expect(playerOf(crew, c.id)!.team).not.toBe(playerOf(crew, a.id)!.team)
    expect(a.last("crew")!.crew).toEqual(crew)
    expect(b.last("crew")!.crew).toEqual(crew)
    expect(playerOf(crew, a.id)!.name).toBe("ada")
    // Every new joiner gets the ships right away: both teams' two ships, out from the first join.
    expect(c.last("ships")!.s).toHaveLength(4)
  })

  test("the helm's orders drive its ship on the room's simulation; anyone else's are ignored", () => {
    const { core, run, join, say } = room()
    const a = join("ada")
    const c = join("cy")
    join("bo")
    const ship = playerOf(core.crew!, a.id)!.ship
    say(c, { type: "helm", o: 1, r: 1 }) // c is a pilot, not the helm
    run(2000)
    expect(core.ships.get(ship)!.order).toBe(0)
    say(a, { type: "helm", o: 1, r: 0.5 })
    run(10_000)
    const s = core.ships.get(ship)!
    expect(s.order).toBe(1)
    expect(s.u).toBeGreaterThan(5)
    expect(s.r).toBeGreaterThan(0)
    // The sim keeps to sea time.
    expect(Math.abs(s.t - 12)).toBeLessThan(SHIP.tick * 1.01)
    const p = shipIn(a.last("ships"), ship)!
    expect(p[8]).toBe(1)
    expect(Math.abs(p[2] - s.x)).toBeLessThan(2)
  })

  test("the helm can order astern and the room's ship backs up", () => {
    const { core, run, join, say } = room()
    const a = join("ada")
    const ship = playerOf(core.crew!, a.id)!.ship
    say(a, { type: "helm", o: -1, r: 0 })
    run(20_000)
    const s = core.ships.get(ship)!
    expect(s.order).toBe(-SHIP.astern)
    expect(s.u).toBeLessThan(-2)
  })

  test("a ship whose helm leaves holds its throttle and centres the rudder", () => {
    const { core, run, join, say } = room()
    const a = join("ada")
    join("bo")
    const c = join("cy")
    const ship = playerOf(core.crew!, a.id)!.ship
    say(a, { type: "helm", o: 0.6, r: 1 })
    run(3000)
    say(a, { type: "op", op: "hornet" }) // a hands off the helm and flies
    run(5000)
    const s = core.ships.get(ship)!
    expect(s.order).toBeCloseTo(0.6)
    expect(Math.abs(s.rudder)).toBeLessThan(0.01)
    // c, a pilot on deck, takes the free helm and steers.
    say(c, { type: "op", op: "helm" })
    say(c, { type: "helm", o: 0.2, r: -1 })
    run(3000)
    expect(core.ships.get(ship)!.rudder).toBeLessThan(-0.5)
  })

  test("refused requests come back as nope; new ships spawn and get simulated", () => {
    const { core, join, say, run } = room()
    const a = join("ada")
    join("bo")
    const c = join("cy")
    say(c, { type: "op", op: "helm" })
    expect(c.last("nope")).toEqual({ type: "nope", error: "helm-taken" })
    // Both ships of the team are out: no third.
    say(c, { type: "newship", team: playerOf(core.crew!, c.id)!.team })
    expect(c.last("nope")).toEqual({ type: "nope", error: "fleet-full" })
    expect(core.ships.size).toBe(4)
    // The team's two ships start apart.
    const [s1, s2] = core.crew!.ships.filter((s) => s.team === playerOf(core.crew!, a.id)!.team).map((s) => core.ships.get(s.id)!)
    expect(Math.hypot(s1!.x - s2!.x, s1!.z - s2!.z)).toBeGreaterThan(200)
    run(200)
    expect(a.last("ships")!.s).toHaveLength(4)
  })

  test("LAUNCH HORNET makes the helm a pilot; recover puts the pilot back on the deck; recharge gates the next launch", () => {
    const { core, join, say, run } = room()
    const a = join("ada")
    say(a, { type: "op", op: "hornet" })
    expect(playerOf(core.crew!, a.id)).toMatchObject({ role: "pilot", plane: 0, sortie: 1 })
    say(a, { type: "op", op: "hornet" })
    expect(a.last("nope")!.error).toBe("flying")
    say(a, { type: "op", op: "helm" })
    expect(a.last("nope")!.error).toBe("flying")
    say(a, { type: "recover", how: "crashed" })
    // Shot down: on deck, nothing launches by itself; slot 0 recharges but slot 1 is ready.
    expect(playerOf(core.crew!, a.id)).toMatchObject({ role: "pilot", plane: -1, sortie: 1 })
    run(500)
    expect(playerOf(core.crew!, a.id)!.plane).toBe(-1)
    say(a, { type: "op", op: "hornet" })
    expect(playerOf(core.crew!, a.id)).toMatchObject({ plane: 1, sortie: 2 })
    // Shot down again: both slots recharging, the launch is refused until one is ready.
    say(a, { type: "recover", how: "crashed" })
    say(a, { type: "op", op: "hornet" })
    expect(a.last("nope")!.error).toBe("recharging")
    run(CREW.recharge + 100)
    expect(playerOf(core.crew!, a.id)).toMatchObject({ role: "pilot", plane: -1, sortie: 2 })
    say(a, { type: "op", op: "hornet" })
    expect(playerOf(core.crew!, a.id)).toMatchObject({ plane: 0, sortie: 3 })
    // Landing back aboard frees the slot at once.
    say(a, { type: "recover", how: "landed" })
    expect(core.crew!.ships[0]!.aircraft[0]).toMatchObject({ pilot: null })
    say(a, { type: "op", op: "helm" })
    expect(playerOf(core.crew!, a.id)).toMatchObject({ role: "helm", plane: -1 })
  })

  test("two pilots launch, a third waits for a slot", () => {
    const { core, join, say } = room()
    const a = join("ada")
    join("x1") // the other team
    const b = join("bo")
    join("x2")
    const d = join("di")
    expect(playerOf(core.crew!, d.id)!.ship).toBe(playerOf(core.crew!, a.id)!.ship)
    say(b, { type: "op", op: "hornet" })
    say(d, { type: "op", op: "hornet" })
    say(a, { type: "op", op: "hornet" })
    expect(a.last("nope")!.error).toBe("in-use")
    expect(playerOf(core.crew!, a.id)!.role).toBe("helm")
    say(b, { type: "recover", how: "crashed" })
    say(a, { type: "op", op: "hornet" })
    expect(a.last("nope")!.error).toBe("recharging")
  })

  test("every team keeps its two ships, crewed or not", () => {
    const { core, join, run } = room()
    const a = join("ada")
    run(CREW.emptyMs + 2000)
    expect(core.ships.size).toBe(4)
    expect(a.last("ships")!.s).toHaveLength(4)
  })

  test("a reconnecting helm gets the helm back if free, else flies", () => {
    const { core, join, say } = room()
    const a = join("ada")
    join("cy")
    const b = join("bo")
    const ship = playerOf(core.crew!, a.id)!.ship
    core.close(a)
    const again = join("ada", { back: { ship, role: "helm" } })
    expect(playerOf(core.crew!, again.id)).toMatchObject({ ship, plane: -1 })
    expect(b.last("players")!.n).toBe(3)
    // Gone again, and bo takes the helm meanwhile: ada comes back as a pilot on deck.
    core.close(again)
    say(b, { type: "op", op: "helm" })
    const third = join("ada", { back: { ship, role: "helm" } })
    expect(playerOf(core.crew!, third.id)).toMatchObject({ ship, role: "pilot", plane: -1 })
  })

  test("a full room says so and closes", () => {
    const { join } = room()
    for (let i = 0; i < CREW.roomMax; i++) join(`p${i}`)
    const late = join("late")
    expect(late.sent).toEqual([{ type: "full" }])
    expect(late.closed).toBe(4004)
  })

  test("ships go out every SHIPS_EVERY_MS", () => {
    const { join, run } = room()
    const a = join("ada")
    const before = a.all("ships").length
    run(SHIPS_EVERY_MS * 10)
    expect(a.all("ships").length - before).toBeGreaterThanOrEqual(9)
  })

  test("frames decode on both ends and junk is refused", () => {
    expect(decodeClient(encode({ type: "helm", o: 0.5, r: -1 }))).toEqual({ type: "helm", o: 0.5, r: -1 })
    expect(decodeClient('{"type":"helm","o":2,"r":0}')).toBeNull()
    expect(decodeClient(encode({ type: "board", ship: 3, as: "helm" }))).toEqual({ type: "board", ship: 3, as: "helm" })
    expect(decodeClient(encode({ type: "op", op: "hornet" }))).toEqual({ type: "op", op: "hornet" })
    expect(decodeClient('{"type":"op","op":"submarine"}')).toBeNull()
    expect(decodeClient('{"type":"takehelm"}')).toBeNull()
    expect(decodeClient('{"type":"launch"}')).toBeNull()
    expect(decodeClient(encode({ type: "kick", player: 4 }))).toEqual({ type: "kick", player: 4 })
    expect(decodeClient(encode({ type: "promote", player: 4 }))).toEqual({ type: "promote", player: 4 })
    expect(decodeClient('{"type":"kick","player":-1}')).toBeNull()
    expect(decodeClient(encode({ type: "lock", locked: true }))).toEqual({ type: "lock", locked: true })
    expect(decodeClient('{"type":"lock","locked":"yes"}')).toBeNull()
    expect(decodeClient('{"type":"seat","seat":1}')).toBeNull()
    expect(decodeClient(encode({ type: "board", ship: 3 }))).toEqual({ type: "board", ship: 3 })
    expect(decodeClient('{"type":"recover","how":"teleport"}')).toBeNull()
    expect(decodeClient(encode({ type: "hello", build: "x", name: "ada", back: { ship: 1, role: "pilot" } }))).toEqual({ type: "hello", build: "x", name: "ada", back: { ship: 1, role: "pilot" } })
    const s: ShipTuple = [7, 123.456, -4000.25, 5000.5, -3.1, 15.4, -0.8, 0.02, 1, -1, 0.9]
    expect(decodeServer(encode({ type: "ships", s: [s] }))).toEqual({ type: "ships", s: [s] })
    expect(decodeServer('{"type":"ships","s":[[1,2,3]]}')).toBeNull()
    expect(decodeServer('{"type":"crew","crew":{"seed":1,"made":0,"nextShip":1,"ships":[{"id":1}],"players":[]}}')).toBeNull()
  })
})

describe("captains on the room", () => {
  test("only the captain kicks, locks and promotes; the crew carries the captain, the lock and the bans", () => {
    const { core, join, say, run } = room()
    const a = join("ada") // captain of team 0's ship
    const c = join("cy") // team 1
    const b = join("bo")
    join("x1") // team 1
    const d = join("di") // team 0, ada's ship
    const ship = playerOf(core.crew!, a.id)!.ship
    expect(a.last("crew")!.crew.ships.find((s) => s.id === ship)).toMatchObject({ captain: a.id, locked: false, bans: [] })
    say(b, { type: "kick", player: d.id })
    expect(b.last("nope")!.error).toBe("not-captain")
    say(b, { type: "lock", locked: true })
    expect(b.last("nope")!.error).toBe("not-captain")
    say(a, { type: "kick", player: c.id })
    expect(a.last("nope")!.error).toBe("not-member")
    run(500)
    // Locked: cy can't join it, and a fresh joiner goes elsewhere.
    say(a, { type: "lock", locked: true })
    expect(c.last("crew")!.crew.ships.find((s) => s.id === ship)!.locked).toBe(true)
    say(c, { type: "board", ship })
    expect(c.last("nope")!.error).toBe("locked")
    const e = join("ed")
    expect(playerOf(core.crew!, e.id)!.ship).not.toBe(ship)
    // Kick: di lands on another team-0 ship and is banned from this one.
    run(500)
    say(a, { type: "kick", player: d.id })
    const di = playerOf(core.crew!, d.id)!
    expect(di.ship).not.toBe(ship)
    expect(di.team).toBe(playerOf(core.crew!, a.id)!.team)
    expect(d.last("crew")!.crew.ships.find((s) => s.id === ship)!.bans.map((x) => x.player)).toEqual([d.id])
    // Captain leaves: bo, the longest-serving member left, takes over.
    run(500)
    say(a, { type: "promote", player: b.id })
    expect(core.crew!.ships.find((s) => s.id === ship)!.captain).toBe(b.id)
    say(b, { type: "promote", player: a.id })
    core.close(b)
    expect(core.crew!.ships.find((s) => s.id === ship)!.captain).toBe(a.id)
  })

  test("captain powers have a short cooldown", () => {
    const { core, join, say, run } = room()
    const a = join("ada")
    const ship = playerOf(core.crew!, a.id)!.ship
    say(a, { type: "lock", locked: true })
    say(a, { type: "lock", locked: false })
    expect(core.crew!.ships.find((s) => s.id === ship)!.locked).toBe(true)
    run(500)
    say(a, { type: "lock", locked: false })
    expect(core.crew!.ships.find((s) => s.id === ship)!.locked).toBe(false)
  })

  test("a locked ship still takes back a member whose connection dropped", () => {
    const { core, join, say } = room()
    const a = join("ada")
    join("cy")
    const b = join("bo")
    const ship = playerOf(core.crew!, a.id)!.ship
    say(a, { type: "lock", locked: true })
    core.close(b)
    const back = join("bo", { back: { ship, role: "pilot" } })
    expect(playerOf(core.crew!, back.id)!.ship).toBe(ship)
    expect(core.crew!.ships.find((s) => s.id === ship)!.locked).toBe(true)
  })
})
