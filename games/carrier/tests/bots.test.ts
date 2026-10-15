import { describe, expect, test } from "bun:test"
import { type Conn, RoomCore } from "../server/core"
import { BUILD } from "../shared/build.gen"
import { BOT_DEFAULTS, BOT_PREFIX, type BotCmd, type BotSettings, botCmdOf } from "../shared/bots"
import { playerOf, shipOf } from "../shared/crew"
import { FLEET } from "../shared/fleet"
import { type ClientMsg, DEV_MESSAGES, PLANE_MODE, type PlaneTuple, type ServerMsg, decodeClient, decodeServer, encode } from "../shared/protocol"

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

function room(dev: boolean) {
  let now = EPOCH
  const core = new RoomCore(
    () => now,
    () => 42,
    { dev },
  )
  const join = (name: string) => {
    const c = new FakeConn()
    core.message(c, encode({ type: "hello", build: BUILD, name }))
    return c
  }
  const say = (c: FakeConn, msg: ClientMsg) => core.message(c, encode(msg))
  const seaT = () => (now - EPOCH) / 1000
  const run = (ms: number, each?: () => void) => {
    for (let left = ms; left > 0; left -= 50) {
      now += 50
      each?.()
      core.step(now)
    }
  }
  const bot = (c: FakeConn, cmd: BotCmd) => say(c, { type: "bot", cmd })
  const crew = () => core.crew!
  const bots = () => crew().players.filter((p) => p.name.startsWith(BOT_PREFIX))
  return { core, join, say, run, seaT, bot, crew, bots, now: () => now }
}

const settings = (s: Partial<BotSettings>): BotSettings => ({ ...BOT_DEFAULTS, ...s })

describe("dev-only protocol", () => {
  test("a production room refuses every dev message and changes nothing", () => {
    const r = room(false)
    const a = r.join("ada")
    expect(a.last("welcome")!.dev).toBeUndefined()
    const before = JSON.stringify(r.crew())
    const ship = r.crew().ships[1]!.id
    r.say(a, { type: "weather", to: "heavy", f: 5 })
    r.say(a, { type: "time", h: 22, s: 0, f: 5 })
    r.bot(a, { c: "spawn", role: "hornet", ship, n: 2, start: "air", rules: false, at: [0, 800, 0, 0], s: settings({}) })
    r.bot(a, { c: "clear" })
    r.run(500)
    expect(a.all("nope").map((m) => m.error)).toEqual(["dev-only", "dev-only", "dev-only", "dev-only"])
    expect(r.core.weather).toBeNull()
    expect(r.core.time).toBeNull()
    expect(a.all("weather").every((m) => m.o === null)).toBe(true)
    expect(a.all("bots")).toEqual([])
    expect(r.bots()).toEqual([])
    expect(r.crew().players.length).toBe(1)
    expect(JSON.stringify(r.crew().players)).toBe(JSON.stringify(JSON.parse(before).players))
    // The dev tools are on the one gated list.
    for (const t of ["bot", "time", "weather"] as const) expect(DEV_MESSAGES.has(t)).toBe(true)
  })

  test("a dev room says so and takes them", () => {
    const r = room(true)
    const a = r.join("ada")
    expect(a.last("welcome")!.dev).toBe(true)
    r.say(a, { type: "weather", to: "heavy", f: 5 })
    r.say(a, { type: "time", h: 22, s: 0, f: 5 })
    expect(a.all("nope")).toEqual([])
    expect(r.core.weather).not.toBeNull()
    expect(r.core.time).not.toBeNull()
  })

  test("bot commands are validated at the protocol boundary", () => {
    const ok = { c: "spawn", role: "hornet", ship: 2, n: 1, start: "air", rules: true, at: [100, 900, -200, 1], s: settings({}) }
    expect(botCmdOf(ok)).not.toBeNull()
    expect(decodeClient(encode({ type: "bot", cmd: ok as BotCmd }))).not.toBeNull()
    expect(botCmdOf({ ...ok, role: "battleship" })).toBeNull()
    expect(botCmdOf({ ...ok, n: 99 })).toBeNull()
    expect(botCmdOf({ ...ok, at: [1e7, 0, 0, 0] })).toBeNull()
    expect(botCmdOf({ ...ok, s: { ...settings({}), behavior: "kamikaze" } })).toBeNull()
    expect(botCmdOf({ ...ok, s: { ...settings({}), weapons: "yes" } })).toBeNull()
    expect(botCmdOf({ ...ok, s: { alt: 500 } })).toBeNull()
    // Numbers are clamped to the shared ranges.
    const clamped = botCmdOf({ ...ok, s: { ...settings({}), alt: 1e6, skill: -4 } }) as Extract<BotCmd, { c: "spawn" }>
    expect(clamped.s.alt).toBe(3000)
    expect(clamped.s.skill).toBe(0)
    expect(botCmdOf({ c: "set", ids: [3], s: { unknown: 1 } })).toBeNull()
    expect(botCmdOf({ c: "remove", ids: [] })).toBeNull()
    // The biggest spawn fits a client frame.
    expect(encode({ type: "bot", cmd: { ...ok, n: 8, at: [-8999.99, 2999.99, -8999.99, -3.14159], s: settings({ behavior: "dogfight", target: 123456, targetShip: 99999 }) } as BotCmd }).length).toBeLessThan(512)
  })
})

/** A dev room with ADA airborne in a Hornet flying north at 1,000 m (relayed as her client would), and helpers. */
function arena() {
  const r = room(true)
  const a = r.join("ada")
  r.say(a, { type: "op", op: "hornet" })
  const me = { x: 0, y: 1000, z: 0, vz: -140 }
  const relay = () => {
    const p: PlaneTuple = [r.seaT(), PLANE_MODE.flying, me.x, me.y, me.z, 0, 1, 0, 0, 0, 0, me.vz, 0.77, 0, 0, 0, 0]
    r.say(a, { type: "plane", p })
  }
  relay()
  const fly = (ms: number, each?: () => void) =>
    r.run(ms, () => {
      me.z += me.vz * 0.05
      relay()
      each?.()
    })
  const myShip = playerOf(r.crew(), a.id)!.ship
  const enemy = r.crew().ships.find((s) => s.id !== myShip)!.id
  return { ...r, a, me, fly, myShip, enemy }
}

describe("bots", () => {
  test("a bot joins the chosen carrier under the crew rules and flies the real model, relayed to everyone", () => {
    const r = arena()
    const b = r.join("bo")
    r.bot(r.a, { c: "spawn", role: "hornet", ship: r.enemy, n: 1, start: "air", rules: true, at: [0, 900, -2000, Math.PI], s: settings({ behavior: "straight", speed: 150, alt: 900 }) })
    expect(r.a.all("nope")).toEqual([])
    const [bot] = r.bots()
    expect(bot!.name).toBe("BOT·VIPER")
    expect(bot!.ship).toBe(r.enemy)
    expect(bot!.team).toBe(shipOf(r.crew(), r.enemy)!.team)
    expect(bot!.role).toBe("pilot")
    expect(bot!.plane).toBeGreaterThanOrEqual(0)
    // Its slot is taken like a player's.
    expect(shipOf(r.crew(), r.enemy)!.aircraft[bot!.plane]!.pilot).toBe(bot!.id)
    r.fly(8000)
    const jet = r.core.jets.get(bot!.id)!
    expect(jet[1]).toBe(PLANE_MODE.flying)
    // Straight and level, heading south (π) at its height.
    expect(jet[4]).toBeGreaterThan(-2000 + 900)
    expect(Math.abs(jet[2])).toBeLessThan(100)
    expect(Math.abs(jet[3] - 900)).toBeLessThan(60)
    // Every page sees it: B gets it in `planes`, and the panel's list.
    expect(b.last("planes")!.p.some((e) => e[0] === bot!.id)).toBe(true)
    const list = b.last("bots")!.b
    expect(list).toHaveLength(1)
    expect(list[0]!.state).toBe("flying")
    expect(r.core.fighters.get(bot!.id)?.alive).toBe(true)
  })

  test("obeying the rules, a third Hornet waits for a slot; without them it takes an extra one", () => {
    const r = arena()
    r.bot(r.a, { c: "spawn", role: "hornet", ship: r.enemy, n: 3, start: "air", rules: true, at: [0, 900, -3000, 0], s: settings({ behavior: "orbit" }) })
    r.fly(200)
    const flying = () => r.bots().filter((p) => p.plane >= 0).length
    expect(flying()).toBe(2)
    expect(r.a.last("bots")!.b.map((x) => x.state)).toContain("in-use")
    r.bot(r.a, { c: "clear" })
    expect(r.bots()).toEqual([])
    // The extra slots bots took are gone with them.
    expect(shipOf(r.crew(), r.enemy)!.aircraft.length).toBe(4)
    r.bot(r.a, { c: "spawn", role: "hornet", ship: r.enemy, n: 4, start: "air", rules: false, at: [0, 900, -3000, 0], s: settings({ behavior: "orbit" }) })
    r.fly(200)
    expect(flying()).toBe(4)
  })

  test("target practice: an orbit holds its height and radius", () => {
    const r = arena()
    r.bot(r.a, { c: "spawn", role: "hornet", ship: r.enemy, n: 1, start: "air", rules: true, at: [2000, 700, -2000, 0], s: settings({ behavior: "orbit", alt: 700, radius: 1200, speed: 150, weapons: false }) })
    const id = r.bots()[0]!.id
    let worst = 0
    let worstR = 0
    r.fly(40_000, () => {
      const j = r.core.jets.get(id)
      if (!j || r.seaT() < 15) return
      worst = Math.max(worst, Math.abs(j[3] - 700))
      worstR = Math.max(worstR, Math.abs(Math.hypot(j[2] - 3200, j[4] + 2000) - 1200))
    })
    expect(r.core.jets.get(id)![1]).toBe(PLANE_MODE.flying)
    expect(worst).toBeLessThan(120)
    expect(worstR).toBeLessThan(350)
  })

  test("a dogfighter hunts the player down with its gun and missiles", () => {
    const r = arena()
    // 1.5 km behind ADA, same height, chasing.
    r.bot(r.a, { c: "spawn", role: "hornet", ship: r.enemy, n: 1, start: "air", rules: true, at: [0, 1000, 1500, 0], s: settings({ behavior: "dogfight", skill: 0.9, accuracy: 0.9, aggression: 0.9, target: r.a.id }) })
    const id = r.bots()[0]!.id
    let hitBy = 0
    let seek = false
    r.fly(40_000, () => {
      hitBy = r.a.all("hp").filter((m) => m.id === r.a.id && m.by === id).length
      seek ||= r.a.all("seek").some((m) => m.by === id && m.s === 2)
    })
    expect(hitBy).toBeGreaterThan(0)
    expect(seek).toBe(true)
    const kill = r.a.all("kill").find((k) => k.on === r.a.id)
    expect(kill?.by).toBe(id)
    expect(r.core.hp(r.a.id)).toBe(0)
  })

  test("the player shoots a bot down; invulnerable ones shrug it off; a downed bot respawns", () => {
    const r = arena()
    r.bot(r.a, { c: "spawn", role: "hornet", ship: r.enemy, n: 1, start: "air", rules: false, at: [0, 1000, -600, Math.PI], s: settings({ behavior: "straight", invulnerable: true, weapons: false }) })
    const id = r.bots()[0]!.id
    r.fly(500)
    r.say(r.a, { type: "hits", on: id, n: 30 })
    r.fly(100)
    expect(r.core.hp(id)).toBe(100)
    r.bot(r.a, { c: "set", ids: [id], s: { invulnerable: false } })
    r.fly(1000)
    const sortie = playerOf(r.crew(), id)!.sortie
    for (let i = 0; i < 2; i++) {
      r.say(r.a, { type: "hits", on: id, n: 30 })
      r.fly(1000)
    }
    expect(r.a.all("kill").some((k) => k.on === id && k.by === r.a.id)).toBe(true)
    // Down, the sortie ends after the usual wait, then (extra slot, no rules) it launches again at full health.
    r.fly(4000)
    expect(playerOf(r.crew(), id)!.sortie).toBe(sortie + 1)
    expect(r.core.fighters.get(id)?.alive).toBe(true)
    // The panel's SHOOT DOWN works on it too, invulnerable or not.
    r.bot(r.a, { c: "set", ids: [id], s: { invulnerable: true } })
    r.bot(r.a, { c: "kill", ids: [id] })
    r.fly(200)
    expect(r.a.all("kill").filter((k) => k.on === id).length).toBe(2)
  })

  test("an F-35C bot bombs the chosen carrier", () => {
    const r = arena()
    const target = r.crew().ships.find((s) => s.id !== r.myShip && s.id !== r.enemy)!.id
    const ship = r.core.ships.get(target)!
    // 5 km from the target, at 600 m, heading for it.
    const h = Math.atan2(ship.x - (ship.x + 5000), -(ship.z - ship.z))
    r.bot(r.a, { c: "spawn", role: "f35", ship: r.enemy, n: 1, start: "air", rules: true, at: [ship.x + 5000, 600, ship.z, h], s: settings({ behavior: "bomber", alt: 600, speed: 150, targetShip: target, accuracy: 1 }) })
    r.fly(70_000)
    expect(r.core.hull(target)!.hp).toBeLessThan(FLEET.hp - 100)
  })

  test("boats, gunners and the helm run their operations", () => {
    const r = arena()
    const b = r.join("bo")
    // A carrier nobody is aboard (BO took the helm of one when joining).
    r.enemy = r.crew().ships.find((s) => s.helm === null && !s.pilots.length)!.id
    r.bot(r.a, { c: "spawn", role: "helm", ship: r.enemy, n: 1, start: "deck", rules: true, at: [0, 0, 0, 0], s: settings({ behavior: "cruise", throttle: 0.8 }) })
    r.bot(r.a, { c: "spawn", role: "ciws-port", ship: r.enemy, n: 1, start: "deck", rules: true, at: [0, 0, 0, 0], s: settings({ behavior: "engage" }) })
    r.bot(r.a, { c: "spawn", role: "boat", ship: r.enemy, n: 1, start: "deck", rules: true, at: [0, 0, 0, 0], s: settings({ behavior: "patrol", throttle: 0.7 }) })
    expect(r.a.all("nope")).toEqual([])
    const ship = shipOf(r.crew(), r.enemy)!
    const [helm, gunner, boat] = r.bots()
    expect(ship.helm).toBe(helm!.id)
    expect(gunner!.role).toBe("gunner")
    const start = { ...r.core.ships.get(r.enemy)! }
    r.fly(15_000)
    const sim = r.core.ships.get(r.enemy)!
    expect(Math.hypot(sim.x - start.x, sim.z - start.z)).toBeGreaterThan(100)
    expect(b.last("turrets")!.t.some((t) => t[5] === gunner!.id)).toBe(true)
    const out = r.core.boatSims.get(boat!.id)
    expect(out?.mode).toBe(1)
    expect(Math.hypot(out!.boat.u, out!.boat.v)).toBeGreaterThan(5)
    r.bot(r.a, { c: "remove", ids: [helm!.id, gunner!.id, boat!.id] })
    expect(r.bots()).toEqual([])
    expect(shipOf(r.crew(), r.enemy)!.helm).toBeNull()
  })

  test("same inputs, same fight", () => {
    const fight = () => {
      const r = arena()
      r.bot(r.a, { c: "spawn", role: "hornet", ship: r.enemy, n: 2, start: "air", rules: false, at: [0, 1000, 1800, 0], s: settings({ behavior: "dogfight" }) })
      r.fly(12_000)
      return r.bots().map((p) => r.core.jets.get(p.id)?.slice(2, 5))
    }
    expect(fight()).toEqual(fight())
  })
})
