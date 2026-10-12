import { describe, expect, test } from "bun:test"
import { RoomEngine, createRng, createSnapshotDecoder, INPUT_QUEUE_MAX, JITTER_TARGET_MAX, JITTER_TARGET_MIN, ABANDONED_DESTROY_DELAY, MATCH_RESTART_DELAY, PARKED_REMOVE_DELAY, WRECK_LINGER } from "../src/sim/room-engine"
import { createLoopbackRoom } from "../src/sim/loopback"
import { FLEET, SPAWN_PROTECTION } from "../src/sim/fleet"
import type { WireSnapshot } from "../src/sim/room-engine"
import { DEFAULT_ROOM_CONFIG, RESPAWN_DELAY } from "../src/sim/protocol"
import type { ClientMessage, RoomConfig, ServerMessage, Snapshot } from "../src/sim/protocol"
import type { GameEvent } from "../src/sim/types"
import { TICK_DT } from "../src/sim/types"

function setup(config: Partial<RoomConfig> = {}) {
  const inbox = new Map<string, ServerMessage[]>()
  const engine = new RoomEngine("test", { ...DEFAULT_ROOM_CONFIG, ...config }, {
    send(id, message) {
      if (!inbox.has(id)) inbox.set(id, [])
      inbox.get(id)!.push(JSON.parse(JSON.stringify(message)))
    },
  })
  const join = (name = "p") => engine.addPlayer(name)
  const msgs = (id: string) => inbox.get(id) ?? []
  const of = <T extends ServerMessage["type"]>(id: string, type: T) => msgs(id).filter(m => m.type === type) as Extract<ServerMessage, { type: T }>[]
  const events = (id: string) => of(id, "events").flatMap(m => m.events)
  const lastSnap = (id: string) => of(id, "snapshot").at(-1) as Snapshot
  const ticks = (n: number) => { for (let i = 0; i < n; i++) engine.advance(TICK_DT) }
  const seconds = (s: number) => ticks(Math.round(s / TICK_DT))
  const send = (id: string, m: ClientMessage) => engine.handle(id, m)
  const player = (id: string) => engine.players.get(id)!.info
  const vehicle = (id: string) => engine.vehicles.find(v => v.id === player(id).vehicleId)
  return { engine, inbox, join, msgs, of, events, lastSnap, ticks, seconds, send, player, vehicle }
}

const seatInput = { aim: null, firePrimary: false, fireSecondary: false, flares: false, ability: false }
const flightInput = { aim: null, throttle: 0.5, roll: 0, yaw: 0, pitch: 0, boost: false, brake: false }

describe("room engine", () => {
  test("welcome + auto-balanced teams", () => {
    const r = setup({ teams: 3 })
    const ids = Array.from({ length: 6 }, (_, i) => r.join(`p${i}`))
    expect(r.of(ids[0], "welcome")[0]).toMatchObject({ playerId: ids[0], room: "test" })
    const counts = [0, 0, 0]
    for (const id of ids) counts[r.player(id).team]++
    expect(counts).toEqual([2, 2, 2])
    expect(r.engine.humanCount()).toBe(6)
  })

  test("preferred team honored only when it keeps balance", () => {
    const r = setup({ teams: 2 })
    const a = r.join(), b = r.join()
    expect(r.player(a).team).toBe(0)
    expect(r.player(b).team).toBe(1)
    r.send(b, { type: "hello", name: "Bravo\u0000!!", team: 0 }) // would be 2v0
    expect(r.player(b).team).toBe(1)
    expect(r.player(b).name).toBe("Bravo !!")
    const c = r.join()
    r.send(c, { type: "team", team: 1 }) // 1v2 with c on team 1? c starts on 0 (balanced) → moving makes 0v... allowed only if balanced
    const counts = [0, 0]
    for (const id of [a, b, c]) counts[r.player(id).team]++
    expect(Math.abs(counts[0] - counts[1])).toBeLessThanOrEqual(1)
  })

  test("spawn creates a vehicle with the player as pilot", () => {
    const r = setup()
    const a = r.join()
    r.send(a, { type: "spawn", kind: "apache" })
    r.send(a, { type: "spawn", kind: "bogus" as never })
    const v = r.vehicle(a)!
    expect(v.kind).toBe("apache")
    expect(v.seats).toEqual([a, null])
    expect(v.team).toBe(r.player(a).team)
    expect(v.hp).toBe(v.maxHp)
    expect(r.player(a).seat).toBe(0)
    expect(r.engine.vehicles.length).toBe(1)
  })

  test("board, switch seats, leave", () => {
    const r = setup({ teams: 2 })
    const a = r.join(), enemy = r.join(), b = r.join()
    expect(r.player(b).team).toBe(r.player(a).team)
    r.send(a, { type: "spawn", kind: "fighter" })
    const v = r.vehicle(a)!
    r.send(enemy, { type: "board", vehicle: v.id, seat: 1 })
    expect(v.seats[1]).toBeNull()
    r.send(b, { type: "board", vehicle: v.id, seat: 0 })
    expect(v.seats[0]).toBe(a) // occupied by a human
    r.send(b, { type: "board", vehicle: v.id, seat: 1 })
    expect(v.seats).toEqual([a, b])
    r.send(b, { type: "switch-seat", seat: 0 })
    expect(v.seats).toEqual([a, b])
    expect(r.of(b, "error").length).toBeGreaterThan(0)
    r.send(a, { type: "leave-vehicle" }) // at base → allowed
    expect(v.seats).toEqual([null, b])
    r.send(b, { type: "switch-seat", seat: 0 })
    expect(v.seats).toEqual([b, null])
    expect(r.player(b).seat).toBe(0)
    expect(r.player(a).vehicleId).toBeNull()
  })

  test("leaving: allowed on own carrier deck or during spawn protection, ignored when airborne later", () => {
    const r = setup()
    const a = r.join()
    r.send(a, { type: "spawn", kind: "fighter" })
    const v = r.vehicle(a)!
    expect(v.spawnedAt).toBe(r.engine.time)
    expect(r.engine.onOwnDeck(v)).toBe(true)
    r.seconds(SPAWN_PROTECTION + 0.1)
    v.flight.position = [0, 1500, 0]
    v.flight.onGround = false
    r.send(a, { type: "leave-vehicle" })
    r.send(a, { type: "spawn", kind: "apache" })
    expect(v.seats[0]).toBe(a)
    // Freshly spawned aircraft can be swapped even once airborne.
    const b = r.join()
    r.send(b, { type: "spawn", kind: "fighter" })
    const w = r.vehicle(b)!
    w.flight.position = [0, 1500, 0]
    w.flight.onGround = false
    r.send(b, { type: "leave-vehicle" })
    expect(w.seats[0]).toBeNull()
  })

  test("fleet AA kills score for the ship's team", () => {
    const r = setup()
    const a = r.join()
    r.send(a, { type: "spawn", kind: "fighter" })
    const v = r.vehicle(a)!
    r.seconds(SPAWN_PROTECTION + 0.1)
    // Park the (crippled) aircraft in the air next to the enemy carrier and let its AA finish it.
    const enemyCarrier = FLEET.find(s => s.team === 1 && s.kind === "carrier")!
    v.flight.position = [enemyCarrier.position[0] + 600, 300, enemyCarrier.position[2]]
    v.flight.velocity = [0, 0, 0]
    v.flight.onGround = false
    v.hp = 1
    for (let i = 0; i < 600 && v.alive; i++) {
      v.flight.position = [enemyCarrier.position[0] + 600, 300, enemyCarrier.position[2]]
      v.flight.crashed = null
      r.ticks(1)
    }
    const kill = r.events(a).find(e => e.type === "kill") as Extract<GameEvent, { type: "kill" }>
    expect(kill).toMatchObject({ victim: v.id, killer: null, weapon: "aa", killerTeam: 1 })
    expect(r.engine.scores).toEqual([0, 1])
    expect(r.player(a).deaths).toBe(1)
  })

  test("input ack is reported in snapshots; old/invalid seqs ignored", () => {
    const r = setup()
    const a = r.join()
    r.send(a, { type: "spawn", kind: "fighter" })
    r.send(a, { type: "input", seq: 5, flight: flightInput, seat: seatInput })
    r.send(a, { type: "input", seq: 3, flight: { ...flightInput, throttle: -1 } })
    r.ticks(3)
    expect(r.lastSnap(a).ack).toBe(5)
    expect(r.engine.players.get(a)!.flight.throttle).toBe(0.5)
  })

  test("validation rejects NaN, bad aims and clamps axes", () => {
    const r = setup()
    const a = r.join()
    r.send(a, { type: "input", seq: 1, flight: { ...flightInput, throttle: NaN } })
    expect(r.engine.players.get(a)!.seq).toBe(-1)
    r.send(a, { type: "input", seq: 2, seat: { ...seatInput, aim: [0, 0, 0] } })
    r.send(a, { type: "input", seq: 3, seat: { ...seatInput, aim: [1, Infinity, 0] } })
    r.send(a, { type: "input", seq: 4.5, flight: flightInput })
    expect(r.engine.players.get(a)!.seq).toBe(-1)
    r.send(a, { type: "input", seq: 6, flight: { ...flightInput, roll: 7, aim: [0, 0, -2] }, seat: { ...seatInput, firePrimary: "yes" as never } })
    r.ticks(3)
    const p = r.engine.players.get(a)!
    expect(p.seq).toBe(6)
    expect(p.flight.roll).toBe(1)
    expect(p.flight.aim).toEqual([0, 0, -1])
    expect(p.seat.firePrimary).toBe(false)
    r.send(a, { type: "ping", t: NaN })
    r.send(a, { type: "ping", t: 42 })
    expect(r.of(a, "pong")).toEqual([{ type: "pong", t: 42 }])
    r.send(a, null as never)
    r.send(a, { type: "board", vehicle: {} as never, seat: 7 as never })
  })

  test("snapshots at 20 Hz, events batched", () => {
    const r = setup()
    const a = r.join()
    r.ticks(60)
    expect(r.of(a, "snapshot").length).toBe(20)
    expect(r.engine.tick).toBe(60)
    // advance() caps catch-up at 250 ms.
    r.engine.advance(10)
    expect(r.engine.tick).toBe(75)
  })

  test("crash kills crew, respawn after RESPAWN_DELAY, wreck removed", () => {
    const r = setup()
    const a = r.join()
    r.send(a, { type: "spawn", kind: "fighter" })
    const v = r.vehicle(a)!
    v.flight.crashed = "terrain"
    r.ticks(1)
    const kill = r.events(a).find(e => e.type === "kill") as Extract<GameEvent, { type: "kill" }>
    expect(kill).toMatchObject({ victim: v.id, weapon: "crash", killer: null })
    expect(r.player(a)).toMatchObject({ deaths: 1, vehicleId: null })
    expect(r.player(a).respawnAt).toBeCloseTo(r.engine.time + RESPAWN_DELAY, 5)
    expect(r.engine.scores).toEqual([0, 0])
    r.send(a, { type: "spawn", kind: "fighter" })
    expect(r.player(a).vehicleId).toBeNull()
    r.seconds(WRECK_LINGER + 0.1)
    expect(r.engine.vehicles.find(x => x.id === v.id)).toBeUndefined()
    r.seconds(RESPAWN_DELAY - WRECK_LINGER)
    r.send(a, { type: "spawn", kind: "warthog" })
    expect(r.vehicle(a)?.kind).toBe("warthog")
  })

  test("kills score for the attacker's team; scoreLimit ends and restarts the match", () => {
    const r = setup({ scoreLimit: 2 })
    const a = r.join(), b = r.join()
    const kill = (victim: string, weapon: "combat" | "crash") => {
      r.send(victim, { type: "spawn", kind: "fighter" })
      const v = r.vehicle(victim)!
      v.hp -= 50
      v.lastDamagedBy = a
      r.ticks(1)
      if (weapon === "crash") v.flight.crashed = "water"
      else { v.hp = 0; v.alive = false }
      r.ticks(1)
      r.seconds(RESPAWN_DELAY + 0.1)
    }
    kill(b, "combat")
    expect(r.engine.scores).toEqual([1, 0])
    expect(r.player(a).kills).toBe(1)
    kill(b, "crash") // recently damaged → credited
    expect(r.engine.scores).toEqual([2, 0])
    const end = r.events(a).find(e => e.type === "match-end")
    expect(end).toEqual({ type: "match-end", winner: 0 })
    r.send(a, { type: "spawn", kind: "fighter" })
    expect(r.player(a).vehicleId).toBeNull() // intermission
    r.ticks(3)
    expect(r.lastSnap(a).intermission).toBe(true)
    expect(r.lastSnap(a).matchEndsAt).toBeCloseTo(r.engine.matchEndedAt! + MATCH_RESTART_DELAY, 2)
    r.seconds(MATCH_RESTART_DELAY)
    expect(r.engine.scores).toEqual([0, 0])
    expect(r.engine.matchEndedAt).toBeNull()
    expect(r.lastSnap(a).intermission).toBe(false)
    expect(r.player(a).kills).toBe(0)
  })

  test("time limit ends the match (tie → null winner)", () => {
    const r = setup({ timeLimit: 60 })
    const a = r.join()
    r.seconds(60.05)
    expect(r.events(a).find(e => e.type === "match-end")).toEqual({ type: "match-end", winner: null })
  })

  test("chat is sanitized and rate limited", () => {
    const r = setup()
    const a = r.join()
    for (let i = 0; i < 6; i++) r.send(a, { type: "chat", text: `hi\n${"x".repeat(500)}` })
    r.ticks(1)
    const chats = r.events(a).filter(e => e.type === "chat") as Extract<GameEvent, { type: "chat" }>[]
    expect(chats.length).toBe(4)
    expect(chats[0].text.length).toBe(200)
    expect(chats[0].text.startsWith("hi x")).toBe(true)
    expect(r.of(a, "error").length).toBe(2)
    r.seconds(1.6)
    r.send(a, { type: "chat", text: "again" })
    r.ticks(1)
    expect(r.events(a).filter(e => e.type === "chat").length).toBe(5)
  })

  test("no bots when config.bots = 0", () => {
    const r = setup({ teams: 4, bots: 0 })
    const a = r.join()
    r.send(a, { type: "spawn", kind: "fighter" })
    r.seconds(10)
    expect(r.engine.botCount()).toBe(0)
    expect(r.engine.playerCount()).toBe(1)
    expect(r.engine.vehicles.length).toBe(1)
  })

  const bots = (r: ReturnType<typeof setup>, team?: number) =>
    [...r.engine.players.values()].filter(p => p.info.bot && (team === undefined || p.info.team === team))

  test("bots fill teams, spawn, and leave gracefully as humans join", () => {
    const r = setup({ teams: 2, bots: 3, maxPerTeam: 4 })
    expect(r.engine.botCount()).toBe(6)
    expect(r.engine.humanCount()).toBe(0)
    r.seconds(3)
    expect(bots(r).every(b => b.info.vehicleId)).toBe(true)
    r.seconds(SPAWN_PROTECTION)
    const h1 = r.join(), h2 = r.join()
    expect(r.engine.botCount()).toBe(6) // 1 human + 3 bots per team
    // A bot that's airborne outside its safe zone only leaves after it dies.
    const flyer = bots(r, 0).find(b => b.info.seat === 0)!
    const fv = r.engine.vehicles.find(v => v.id === flyer.info.vehicleId)!
    for (const b of bots(r, 0)) {
      const v = r.engine.vehicles.find(x => x.id === b.info.vehicleId)!
      v.flight.position = [0, 1500, 0]
      v.flight.onGround = false
    }
    const h3 = r.join()
    expect(r.player(h3).team).toBe(0)
    expect(bots(r, 0).length).toBe(3)
    expect(bots(r, 0).filter(b => b.leaving).length).toBe(1)
    const leaver = bots(r, 0).find(b => b.leaving)!
    r.seconds(2)
    expect(r.engine.players.has(leaver.info.id)).toBe(true)
    const lv = r.engine.vehicles.find(v => v.id === leaver.info.vehicleId)!
    lv.flight.crashed = "terrain"
    r.ticks(1)
    expect(r.engine.players.has(leaver.info.id)).toBe(false)
    expect(bots(r, 0).length).toBe(2)
    expect(fv).toBeDefined()
    // Humans leaving bring bots back.
    for (const h of [h1, h2, h3]) r.engine.removePlayer(h)
    expect(bots(r, 0).filter(b => !b.leaving).length).toBe(3)
    expect(bots(r, 1).filter(b => !b.leaving).length).toBe(3)
  })

  test("parked surplus bots leave immediately with their aircraft", () => {
    const r = setup({ teams: 2, bots: 2, maxPerTeam: 2 })
    r.seconds(3)
    const before = r.engine.vehicles.filter(v => v.alive).length
    r.join() // team 0 now 1 human → 1 bot
    expect(bots(r, 0).length).toBe(1)
    r.ticks(1)
    expect(r.engine.vehicles.filter(v => v.alive).length).toBe(before - 1)
  })

  test("bot fills a human pilot's empty gunner seat; humans push it out; it never pilots a human's aircraft", () => {
    const r = setup({ teams: 2, bots: 1, maxPerTeam: 4 })
    const a = r.join()
    r.send(a, { type: "spawn", kind: "apache" })
    r.seconds(3)
    const bot = bots(r, r.player(a).team)[0].info
    // Ground the bot's own aircraft so it goes looking for a seat.
    const freeBot = () => {
      const own = r.engine.vehicles.find(x => x.id === bot.vehicleId && x.seats[0] === bot.id)
      if (own) own.flight.crashed = "terrain"
      r.seconds(RESPAWN_DELAY + 1)
    }
    freeBot()
    const v = r.vehicle(a)!
    expect(v.seats).toEqual([a, bot.id])
    // Pilot moving to the gunner seat evicts the bot instead of handing it the controls.
    r.send(a, { type: "switch-seat", seat: 1 })
    expect(v.seats).toEqual([null, a])
    expect(bot.vehicleId).toBeNull()
    r.send(a, { type: "switch-seat", seat: 0 })
    r.seconds(2)
    freeBot()
    expect(v.seats[1]).toBe(bot.id)
    // A human boarding the gunner seat pushes the bot out.
    r.join()
    const c = r.join()
    expect(r.player(c).team).toBe(r.player(a).team)
    r.send(c, { type: "board", vehicle: v.id, seat: 1 })
    expect(v.seats).toEqual([a, c])
    expect(bot.vehicleId).not.toBe(v.id)
    // A bot gunner leaves when the human pilot bails.
    r.send(c, { type: "leave-vehicle" })
    r.seconds(2)
    freeBot()
    expect(v.seats[1]).toBe(bot.id)
    r.send(a, { type: "leave-vehicle" })
    r.ticks(1)
    expect(v.seats).toEqual([null, null])
  })

  test("bots don't count as humans (empty-room TTL) and never receive messages", () => {
    const sentTo = new Set<string>()
    const engine = new RoomEngine("ttl", { ...DEFAULT_ROOM_CONFIG, bots: 3 }, { send(id) { sentTo.add(id) }, sendText(id) { sentTo.add(id) } })
    expect(engine.humanCount()).toBe(0)
    expect(engine.playerCount()).toBe(6)
    const h = engine.addPlayer("h")
    for (let i = 0; i < 300; i++) engine.advance(TICK_DT)
    engine.removePlayer(h)
    expect(engine.humanCount()).toBe(0)
    expect(engine.botCount()).toBe(6)
    expect([...sentTo]).toEqual([h])
  })

  test("bot kills score for the bot's team", () => {
    const r = setup({ teams: 2, bots: 1, maxPerTeam: 4 })
    const a = r.join()
    const enemyBot = bots(r, 1)[0].info
    r.send(a, { type: "spawn", kind: "fighter" })
    const v = r.vehicle(a)!
    v.hp -= 100
    v.lastDamagedBy = enemyBot.id
    r.ticks(1)
    v.flight.crashed = "terrain"
    r.ticks(1)
    expect(r.engine.scores).toEqual([0, 1])
    expect(enemyBot.kills).toBe(1)
  })

  test("botFill tops teams up while few humans are present", () => {
    const r = setup({ teams: 2, bots: 0, botFill: 4 } as Partial<RoomConfig>)
    expect(bots(r, 0).length).toBe(4)
    r.join()
    expect(bots(r, 0).filter(b => !b.leaving).length).toBe(3)
    expect(bots(r, 1).filter(b => !b.leaving).length).toBe(4)
    r.join(); r.join(); r.join()
    expect(bots(r).filter(b => !b.leaving).length).toBe(0)
  })

  test("jitter buffer primes to 2, consumes one per tick, drains bursts beyond the cap", () => {
    const r = setup()
    const a = r.join()
    r.send(a, { type: "spawn", kind: "fighter" })
    const p = r.engine.players.get(a)!
    r.send(a, { type: "input", seq: 1, flight: { ...flightInput, throttle: 0.1 } })
    r.ticks(1)
    expect(p.ack).toBe(-1) // held ~2 ticks
    r.send(a, { type: "input", seq: 2, flight: { ...flightInput, throttle: 0.2 } })
    r.ticks(1)
    expect(p.ack).toBe(1)
    expect(p.flight.throttle).toBe(0.1)
    r.ticks(1)
    expect(p.ack).toBe(2)
    r.ticks(10) // not a stream: no stand-ins, ack stays at what was sent
    expect(p.ack).toBe(2)
    for (let seq = 10; seq < 20; seq++) r.send(a, { type: "input", seq, flight: flightInput })
    expect(p.queue.length).toBe(INPUT_QUEUE_MAX)
    expect(p.jitter.dropped).toBe(2)
    r.ticks(20)
    expect(p.ack).toBe(19)
  })

  /** Client sends seq k at tick k; delivery is delayed by `delay(k)` ticks but stays in order. */
  function jitterRun(delay: (k: number) => number, ticks: number) {
    const r = setup()
    const a = r.join()
    r.send(a, { type: "spawn", kind: "fighter" })
    const p = r.engine.players.get(a)!
    const pending: { at: number; seq: number }[] = []
    let lastAt = 0
    const consumedAt = new Map<number, number>()
    const applied: number[] = []
    let prevAck = -1
    for (let t = 1; t <= ticks; t++) {
      const at = Math.max(lastAt, t + delay(t))
      lastAt = at
      pending.push({ at, seq: t })
      while (pending.length && pending[0].at <= t) {
        const { seq } = pending.shift()!
        r.send(a, { type: "input", seq, flight: { ...flightInput, throttle: seq / 1000 } })
      }
      r.ticks(1)
      expect(p.ack).toBeGreaterThanOrEqual(prevAck)
      expect(p.ack - prevAck).toBeLessThanOrEqual(2)
      for (let s = prevAck + 1; s <= p.ack; s++) consumedAt.set(s, t)
      prevAck = p.ack
      const value = Math.round(p.flight.throttle * 1000)
      if (value !== applied.at(-1)) applied.push(value)
    }
    const latency = [...consumedAt].filter(([s]) => s > 0).map(([s, t]) => t - s)
    return { p, latency, applied }
  }

  test("jittery arrival → every seq consumed once, nothing dropped or repeated, bounded latency", () => {
    const rng = createRng(7)
    const { p, latency, applied } = jitterRun(() => Math.floor(rng() * 2), 1200) // ±1 tick
    expect(p.jitter.synthesized).toBe(0)
    expect(p.jitter.dropped).toBe(0)
    expect(p.jitter.late).toBe(0)
    expect(p.jitter.caughtUp).toBe(0)
    expect(Math.max(...latency)).toBeLessThanOrEqual(3)
    // Real inputs are applied in order, never revisited.
    for (let i = 1; i < applied.length; i++) expect(applied[i]).toBeGreaterThan(applied[i - 1])
    expect(p.jitter.target).toBeGreaterThanOrEqual(JITTER_TARGET_MIN)
    expect(p.jitter.target).toBeLessThanOrEqual(JITTER_TARGET_MAX)
  })

  test("heavier jitter grows the buffer, then stays clean; late seqs never re-applied", () => {
    const rng = createRng(11)
    // Starts on a clean link (small buffer), then 0..3 ticks of jitter.
    const { p, latency, applied } = jitterRun(k => (k < 30 ? 0 : Math.floor(rng() * 4)), 1800)
    expect(p.jitter.target).toBeGreaterThanOrEqual(3)
    expect(p.jitter.synthesized).toBeGreaterThan(0)
    expect(p.jitter.synthesized).toBeLessThanOrEqual(6)
    expect(p.jitter.late).toBe(p.jitter.synthesized)
    expect(p.jitter.dropped).toBe(0)
    for (let i = 1; i < applied.length; i++) expect(applied[i]).toBeGreaterThan(applied[i - 1])
    expect(Math.max(...latency.slice(-600))).toBeLessThanOrEqual(3 + JITTER_TARGET_MAX)
  })

  test("smooth arrival shrinks the buffer; stalls repeat the last input without double-applying late seqs", () => {
    const smooth = jitterRun(() => 0, 900)
    expect(smooth.p.jitter.target).toBe(JITTER_TARGET_MIN)
    expect(smooth.latency.slice(-100).every(l => l <= 1)).toBe(true)
    // Every 200 ticks the network stalls for 4 ticks, then delivers the backlog at once.
    const stall = jitterRun(k => (k % 200 >= 100 && k % 200 < 104 ? 104 - (k % 200) : 0), 1000)
    expect(stall.p.jitter.synthesized).toBeGreaterThan(0)
    expect(stall.p.jitter.late).toBe(stall.p.jitter.synthesized)
    for (let i = 1; i < stall.applied.length; i++) expect(stall.applied[i]).toBeGreaterThan(stall.applied[i - 1])
    expect(stall.p.jitter.target).toBeGreaterThan(JITTER_TARGET_MIN)
    expect(Math.max(...stall.latency)).toBeLessThanOrEqual(8)
  })

  test("wire snapshots: compact, players only when changed, own weapons only", () => {
    const texts = new Map<string, string[]>()
    const engine = new RoomEngine("wire", { ...DEFAULT_ROOM_CONFIG, timeLimit: 600 }, {
      send() {},
      sendText(id, text) { if (!texts.has(id)) texts.set(id, []); texts.get(id)!.push(text) },
    })
    const a = engine.addPlayer("A"), b = engine.addPlayer("B")
    engine.handle(a, { type: "spawn", kind: "fighter" })
    for (let i = 0; i < 6; i++) engine.advance(TICK_DT)
    const snaps = texts.get(a)!.map(t => JSON.parse(t)).filter(m => m.type === "snapshot") as WireSnapshot[]
    expect(snaps.length).toBe(2)
    expect(snaps[0].players?.length).toBe(2)
    expect(snaps[1].players).toBeUndefined()
    expect(snaps[1].own?.vehicle).toBe(engine.vehicles[0].id)
    const bSnap = JSON.parse(texts.get(b)!.at(-1)!) as WireSnapshot
    expect(bSnap.own).toBeUndefined()
    // Decoder restores the protocol shape.
    const decode = createSnapshotDecoder()
    for (const raw of texts.get(a)!) decode(JSON.parse(raw))
    const full = decode(snaps[1]) as Snapshot
    expect(full.players.length).toBe(2)
    expect(full.vehicles[0].weapons[0].length).toBe(2)
    expect(full.vehicles[0].maxHp).toBe(450)
    expect(full.matchEndsAt).toBe(600)
    expect(full.intermission).toBe(false)
    // Recon spot state rides in `own`; spottedUntil reaches everyone.
    const ve = engine.vehicles[0]
    ve.spotProgress = 0.4567
    ve.spotCandidate = "v99"
    const until = engine.time + 5
    ve.spottedUntil = until
    for (let i = 0; i < 3; i++) engine.advance(TICK_DT)
    const lastOf = (id: string) => JSON.parse(texts.get(id)!.filter(t => t.includes('"snapshot"')).at(-1)!) as WireSnapshot
    const mineFull = decode(lastOf(a)) as Snapshot
    expect(mineFull.vehicles[0]).toMatchObject({ spotProgress: 0.457, spotCandidate: "v99" })
    expect(mineFull.vehicles[0].spottedUntil).toBeCloseTo(until, 2)
    const otherFull = createSnapshotDecoder()(lastOf(b)) as Snapshot
    expect(otherFull.vehicles[0].spotProgress).toBeUndefined()
    expect(otherFull.vehicles[0].spottedUntil).toBeCloseTo(until, 2)
    const fromB = createSnapshotDecoder()(bSnap) as Snapshot
    expect(fromB.vehicles[0].weapons[0][0].ammo).toBe(engine.vehicles[0].weapons[0][0].ammo)
    // A player list change is broadcast in the next snapshot.
    engine.handle(b, { type: "hello", name: "Bee" })
    for (let i = 0; i < 3; i++) engine.advance(TICK_DT)
    const next = JSON.parse(texts.get(a)!.filter(t => t.includes('"snapshot"')).at(-1)!) as WireSnapshot
    expect(next.players?.find(p => p.id === b)?.name).toBe("Bee")
  })

  test("unmanned vehicles: parked removed after 60 s, abandoned destroyed after 20 s", () => {
    const r = setup()
    const a = r.join(), b = r.join()
    r.send(a, { type: "spawn", kind: "fighter" })
    const parked = r.vehicle(a)!
    r.send(a, { type: "leave-vehicle" })
    r.send(b, { type: "spawn", kind: "fighter" })
    const lost = r.vehicle(b)!
    lost.flight.position = [0, 2000, 0]
    lost.flight.onGround = false
    r.engine.removePlayer(b)
    r.seconds(ABANDONED_DESTROY_DELAY + 0.1)
    expect(lost.alive).toBe(false)
    expect(r.events(a).some(e => e.type === "kill" && e.victim === lost.id)).toBe(true)
    expect(parked.alive).toBe(true)
    r.seconds(PARKED_REMOVE_DELAY - ABANDONED_DESTROY_DELAY)
    expect(r.engine.vehicles.find(v => v.id === parked.id)).toBeUndefined()
    expect(r.events(a).some(e => e.type === "kill" && e.victim === parked.id)).toBe(false)
  })

  test("loopback room delivers JSON messages asynchronously", async () => {
    const got: ServerMessage[] = []
    const statuses: string[] = []
    const room = createLoopbackRoom({ bots: 1 }, "Solo", { onMessage: m => got.push(m), onStatus: s => statuses.push(s) }, { manual: true })
    expect(got.length).toBe(0)
    await Promise.resolve()
    expect(got[0]).toMatchObject({ type: "welcome", playerId: room.playerId })
    room.send({ type: "spawn", kind: "blackbird" })
    room.step(0.1)
    await Promise.resolve()
    const snap = got.filter(m => m.type === "snapshot").at(-1) as Snapshot
    expect(snap.vehicles.some(v => v.seats[0] === room.playerId)).toBe(true)
    room.close()
    expect(statuses).toEqual(["connecting", "open", "closed"])
  })
})
