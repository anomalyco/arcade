import { expect, test } from "bun:test"
import { WoodsRoomCore } from "../server/room-core"
import { BUILD } from "../shared/build.gen"
import { BOT_ID, MAX_TAPES, TRAIL_MAX, tieTarget, type MapKnowledge } from "../shared/sim"
import { applyMapDelta, decodeServer, packIntent, ROOM_FEEL, TEAM, tapeFromRow, type ServerMsg, type Snapshot } from "../shared/protocol"
import type { PlayerInput } from "../shared/sim"
import { trunkBetween } from "../shared/creature"
import { isDeepWater } from "../shared/world"

/** A fake client that keeps what a real one would: the tapes (join list + events) and its map (from deltas). */
type Client = { conn: { send(d: string): void; close(): void }; got: ServerMsg[]; keep: boolean; bytes: number; biggest: number; token?: string; seq: number; closed: boolean; tapes: Map<number, number>; map: MapKnowledge }

function receive(c: Client, m: ServerMsg) {
  if (c.keep) c.got.push(m)
  if (m.type === "s") {
    if (m.tapes) c.tapes = new Map(m.tapes.map((r) => [r[0]!, r[1]!]))
    if (m.map) applyMapDelta(c.map, m.map)
  }
  if (m.type === "ev") for (const e of m.events) {
    if (e.kind === "tape-tied") c.tapes.set(e.tape, e.tree)
    if (e.kind === "tape-removed") c.tapes.delete(e.tape)
  }
}

function setup() {
  let now = 0
  const room = new WoodsRoomCore("test1", () => now)
  const tick = (n = 1) => { for (let i = 0; i < n; i++) { now += 1000 / 30; room.step() } }
  const connect = (name: string, token?: string, keep = true): Client => {
    const c: Client = { got: [], keep, bytes: 0, biggest: 0, seq: 0, closed: false, tapes: new Map(), map: { trail: [], heard: [], tapes: [], markers: [] }, conn: { send: (d) => { c.bytes += d.length; c.biggest = Math.max(c.biggest, d.length); const m = decodeServer(d); if (m) receive(c, m) }, close: () => { c.closed = true } } }
    room.open(c.conn)
    room.message(c.conn, JSON.stringify({ type: "hello", build: BUILD, name, token }))
    const w = c.got.find((m) => m.type === "welcome") as { token: string } | undefined
    c.token = w?.token
    return c
  }
  const send = (c: Client, i: Partial<PlayerInput>) => room.message(c.conn, JSON.stringify({ type: "intent", seq: c.seq++, i: packIntent({ yaw: 0, pitch: 0, light: true, tie: false, map: false, mx: 0, mz: 0, ...i }) }))
  const last = (c: Client) => c.got.filter((m): m is Snapshot => m.type === "s").at(-1)!
  return { room, tick, connect, send, last, advance: (ms: number) => (now += ms) }
}

test("people join by code, bots make room for them, and everyone sees everyone", () => {
  const { room, tick, connect, last } = setup()
  const a = connect("Kit")
  tick(2)
  expect(room.state.players.filter((p) => p.bot).length).toBe(TEAM - 1)
  const b = connect("Aiden"), c = connect("Ryan")
  tick(4)
  expect(room.state.players.filter((p) => !p.bot).map((p) => p.name)).toEqual(["Kit", "Aiden", "Ryan"])
  expect(room.state.players.filter((p) => p.bot).length).toBe(TEAM - 3)
  for (const cl of [a, b, c]) expect(last(cl).p.length).toBe(TEAM)
  expect(last(b).me).toBe(2)
  const names = c.got.filter((m): m is Snapshot => m.type === "s" && !!m.names).at(-1)!.names!
  expect(Object.values(names)).toEqual(expect.arrayContaining(["Kit", "Aiden", "Ryan"]))
  expect(Object.keys(names).length).toBe(TEAM)
  expect(room.state.players.some((p) => p.id >= BOT_ID)).toBe(true)
})

test("movement is the room's: inputs walk you, the ack and your motion come back for reconciliation", () => {
  const { tick, connect, send, last, room } = setup()
  const a = connect("Kit")
  const x0 = room.state.players[0]!.z
  for (let i = 0; i < 60; i++) { send(a, { mz: -1 }); tick() }
  const me = room.state.players.find((p) => p.id === 1)!
  expect(x0 - me.z).toBeGreaterThan(ROOM_FEEL.walkSpeed * 1.5)
  const s = last(a)
  expect(s.ack).toBeGreaterThan(50)
  expect(s.you![1]).toBeCloseTo(me.z, 3)
})

test("a tape one person ties reaches everyone, and so does untying it", () => {
  const { tick, connect, send, room } = setup()
  const a = connect("Kit"), b = connect("Aiden")
  const me = room.state.players.find((p) => p.id === 1)!
  const tree = room.world.trees.find((t) => t.species === "pine" && Math.abs(t.x) < 100)!
  Object.assign(me, { x: tree.x, z: tree.z + tree.radius + 0.8, yaw: 0 })
  expect(tieTarget(room.world, me, ROOM_FEEL.tapeReach)?.id).toBe(tree.id)
  for (let i = 0; i < 45; i++) { send(a, { tie: true }); send(b, {}); tick() }
  expect([...b.tapes.values()]).toEqual([tree.id])
  expect(b.got.some((m) => m.type === "ev" && m.events.some((e) => e.kind === "tape-tied" && e.tree === tree.id))).toBe(true)
  // After the join, snapshots never carry the tape list again: the events do.
  expect(b.got.filter((m) => m.type === "s" && m.tapes).length).toBe(1)
  for (let i = 0; i < 10; i++) { send(a, {}); tick() }
  for (let i = 0; i < 45; i++) { send(a, { tie: true }); tick() }
  expect(b.tapes.size).toBe(0)
  expect(room.state.players.every((p) => p.map.tapes.length === 0)).toBe(true)
  expect(b.map.tapes).toEqual([])
  // A late joiner gets the current list in its first snapshot.
  const c = connect("Ryan")
  expect(c.tapes.size).toBe(0)
  void tapeFromRow
})

test("held keys don't replay after a reconnect", () => {
  const { tick, connect, send, room } = setup()
  const a = connect("Kit")
  const me = () => room.state.players.find((p) => p.id === 1)!
  for (let i = 0; i < 20; i++) { send(a, { map: true }); tick() }
  expect(me().mapRaise).toBeGreaterThan(0.3)
  room.close(a.conn)
  tick(60)
  expect(me().mapRaise).toBe(0)
  connect("Kit", a.token)
  tick(12)
  expect(me().mapRaise).toBe(0)
})

test("a tie survives a ragged input stream (bursts and gaps the jitter buffer smooths over)", () => {
  const { tick, connect, send, room } = setup()
  const a = connect("Kit")
  const me = room.state.players.find((p) => p.id === 1)!
  const tree = room.world.trees.find((t) => t.species === "pine" && Math.abs(t.x) < 100)!
  Object.assign(me, { x: tree.x, z: tree.z + tree.radius + 0.8, yaw: 0 })
  // A slow client clock: about 2 inputs every 3 ticks, sometimes in pairs.
  for (let i = 0; i < 120; i++) { if (i % 3 !== 2) send(a, { tie: true }); if (i % 7 === 0) send(a, { tie: true }); tick() }
  expect(room.state.tapes.map((t) => t.tree)).toEqual([tree.id])
})

test("standing together with a map up swaps pencil marks; a marker find reaches everyone", () => {
  const { tick, connect, send, last, room } = setup()
  const a = connect("Kit"), b = connect("Aiden")
  const pa = room.state.players.find((p) => p.id === 1)!, pb = room.state.players.find((p) => p.id === 2)!
  const m = room.world.markers[0]!
  Object.assign(pa, { x: m.x + 1, z: m.z })
  send(a, {}); send(b, {}); tick(2)
  expect(b.got.filter((s): s is Snapshot => s.type === "s" && !!s.found).at(-1)!.found![m.id]).toEqual([1])
  Object.assign(pa, { x: pb.x + 1, z: pb.z })
  for (let i = 0; i < 20; i++) { send(a, { map: true }); send(b, {}); tick() }
  expect(pb.map.markers).toContain(m.id)
  const maps = b.got.filter((s): s is Snapshot => s.type === "s" && !!s.map?.markers)
  expect(maps.at(-1)!.map!.markers).toContain(m.id)
  expect(b.got.some((s) => s.type === "s" && s.map?.heard?.some((h) => h.from === 1))).toBe(true)
})

test("a dropped person keeps their seat, place and map, and gets everything again on rejoin", () => {
  const { tick, connect, send, room, advance } = setup()
  const a = connect("Kit")
  connect("Aiden")
  for (let i = 0; i < 30; i++) { send(a, { mz: -1 }); tick() }
  const before = { ...room.state.players.find((p) => p.id === 1)! }
  room.close(a.conn)
  tick(30)
  advance(20_000)
  tick(1)
  expect(room.state.players.find((p) => p.id === 1)).toBeTruthy()
  const again = connect("Kit", a.token)
  tick(2)
  const snaps = again.got.filter((m): m is Snapshot => m.type === "s")
  expect(snaps[0]!.me).toBe(1)
  expect(snaps[0]!.you![1]).toBeCloseTo(before.z, 1)
  expect(snaps[0]!.tapes).toBeDefined()
  expect(snaps[0]!.map!.from).toBe(0)
  expect(snaps[0]!.distant).toEqual(room.state.distant)
  expect(snaps.slice(1).some((s) => s.distant)).toBe(false)
  expect(room.humans).toBe(2)
})

test("every person hears the room's distant sounds as the same events", () => {
  const { tick, connect, room } = setup()
  const a = connect("Kit"), b = connect("Aiden")
  room.state.distant.next = room.state.t + 0.5
  tick(60)
  const heard = (c: Client) => c.got.flatMap((m) => (m.type === "ev" ? m.events.filter((e) => e.kind === "distant") : []))
  expect(heard(a).length).toBe(1)
  expect(heard(b)).toEqual(heard(a))
})

test("everyone in a room sees the creature as the same event at the same moment", () => {
  const { tick, connect, room } = setup()
  const a = connect("Kit"), b = connect("Aiden")
  tick(2)
  // Kit faces a bot that holds its beam up, 100 m off over open ground: something to cross.
  const kit = room.state.players.find((p) => p.name === "Kit")!, aiden = room.state.players.find((p) => p.name === "Aiden")!
  const bot = room.state.players.find((p) => p.bot)!, brain = room.state.brains.find((x) => x.id === bot.id)!
  const was = { ...ROOM_FEEL }
  Object.assign(ROOM_FEEL, { creature: true })
  try {
    let found = false
    for (let x = -150; x <= 150 && !found; x += 9) for (let z = -150; z <= 150 && !found; z += 9) {
      const bx = x + 100, bz = z
      if (Math.abs(bx) > 180 || trunkBetween(room.world, x, z, bx, bz, 0.3) || isDeepWater(room.world, x, z) || isDeepWater(room.world, bx, bz)) continue
      Object.assign(kit, { x, z }); Object.assign(aiden, { x: x - 2, z }); Object.assign(bot, { x: bx, z: bz })
      found = true
    }
    expect(found).toBe(true)
    room.state.distant.creature.next = room.state.distant.creature.tryAt = room.state.t + 0.2
    room.state.distant.busyUntil = 0
    for (let i = 0; i < 90; i++) {
      const p = { x: kit.x, z: kit.z }
      brain.mode = "found"; brain.timer = 24
      Object.assign(bot, { vx: 0, vz: 0 })
      // Hold Kit and Aiden still, looking east at the bot.
      kit.yaw = aiden.yaw = -Math.PI / 2
      tick()
      Object.assign(kit, p); Object.assign(aiden, { x: p.x - 2, z: p.z })
    }
  } finally { Object.assign(ROOM_FEEL, was) }
  const seen = (c: Client) => c.got.flatMap((m) => (m.type === "ev" ? m.events.filter((e) => e.kind === "creature") : []))
  expect(seen(a).length).toBe(1)
  expect(seen(b)).toEqual(seen(a))
})

test("bandwidth: a 6-person room stays small per player", () => {
  const { tick, connect, send, room } = setup()
  const cs = ["Kit", "Aiden", "Ryan", "Dax", "Alan", "Sam"].map((n) => connect(n))
  for (const c of cs) c.bytes = 0
  for (let i = 0; i < 30 * 20; i++) {
    cs.forEach((c, k) => send(c, { mx: Math.sin(i / 40 + k), mz: Math.cos(i / 40 + k), yaw: i / 50 + k, pitch: Math.sin(i / 30) * 0.3 }))
    tick()
  }
  const kbs = cs.map((c) => c.bytes / 20 / 1024)
  console.log(`down per player, 6 people walking: ${kbs.map((k) => k.toFixed(2)).join(", ")} KB/s`)
  expect(Math.max(...kbs)).toBeLessThan(12)
  expect(room.humans).toBe(6)
})

/** Plays `minutes` of a room: Kit spams tie/untie on one trunk, Aiden walks a wide loop and keeps comparing maps with
 * the bots, Ryan joins and leaves every few minutes (so bots leave, come back and reuse ids). Returns bytes per minute. */
function longRoom(minutes: number) {
  const env = setup()
  const { room, tick, connect, send } = env
  const kit = connect("Kit", undefined, false), aiden = connect("Aiden", undefined, false)
  const pk = room.state.players.find((p) => p.id === 1)!, pa = room.state.players.find((p) => p.id === 2)!
  const tree = room.world.trees.find((t) => t.species === "pine" && Math.abs(t.x) < 100)!
  const c = room.world.camp
  let ryan: Client | null = null
  const perMinute: number[][] = []
  let mark = [0, 0], botUntied = 0
  for (let i = 0; i < minutes * 60 * 30; i++) {
    const sec = i / 30
    Object.assign(pk, { x: tree.x, z: tree.z + tree.radius + 0.8, vx: 0, vz: 0 })
    send(kit, { tie: i % 60 < 45 })
    // The last bot is the one that leaves when Ryan arrives, so its copied path must go too.
    const bot = [...room.state.players].reverse().find((p) => p.bot)
    const comparing = sec % 90 < 3 && bot
    if (comparing) Object.assign(pa, { x: bot.x + 1, z: bot.z })
    else Object.assign(pa, { x: c.x + 80 * Math.cos(sec / 60), z: c.z - 90 + 80 * Math.sin(sec / 60) })
    send(aiden, { map: !!comparing })
    if (ryan) send(ryan, {})
    if (i % (30 * 240) === 30 * 60) ryan = connect("Ryan", undefined, false)
    if (ryan && i % (30 * 240) === 30 * 120) { room.close(ryan.conn); ryan = null }
    tick()
    for (const e of room.state.events) if (e.kind === "tape-removed" && e.by >= BOT_ID) botUntied++
    if ((i + 1) % (30 * 60) === 0) { perMinute.push([kit.bytes - mark[0]!, aiden.bytes - mark[1]!]); mark = [kit.bytes, aiden.bytes] }
  }
  return { ...env, kit, aiden, perMinute, tree, botUntied }
}

test("a long room stays bounded: tapes, known tapes, copied paths, and bytes per seat stay flat", () => {
  // Bots tie every 10 m and keep 2 up here, so the cap comes into play within the run (sim.test covers it exactly).
  const was = { botTapes: ROOM_FEEL.botTapes, botTapeEvery: ROOM_FEEL.botTapeEvery }
  Object.assign(ROOM_FEEL, { botTapes: 2, botTapeEvery: 10 })
  let run: ReturnType<typeof longRoom>
  try { run = longRoom(15) } finally { Object.assign(ROOM_FEEL, was) }
  const { room, kit, aiden, perMinute, botUntied } = run
  const s = room.state, ids = new Set(s.tapes.map((t) => t.id)), walkers = new Map(s.players.map((p) => [p.id, p]))
  const bots = s.players.filter((p) => p.bot)
  // Bot tapes: at most 2 per bot id still up (ids are reused as bots come and go), plus Kit's one.
  expect(s.tapes.length).toBeLessThanOrEqual(2 * new Set(s.tapes.map((t) => t.by)).size + 1)
  expect(s.tapes.length).toBeLessThanOrEqual(MAX_TAPES)
  for (const b of bots) expect(s.tapes.filter((t) => t.by === b.id).length).toBeLessThanOrEqual(2)
  expect(s.nextTape).toBeGreaterThan(200)
  expect(botUntied).toBeGreaterThan(0)
  console.log(`long room: ${s.nextTape - 1} tapes tied, ${botUntied} bot tapes taken down by the cap, ${s.tapes.length} up at the end`)
  for (const p of s.players) {
    expect(p.map.tapes.every((id) => ids.has(id))).toBe(true)
    expect(p.map.heard.every((h) => walkers.get(h.from)?.serial === h.serial)).toBe(true)
    expect(p.map.trail.length).toBeLessThanOrEqual(TRAIL_MAX * 2)
  }
  expect(room.state.players.find((p) => p.id === 2)!.map.heard.length).toBeGreaterThan(0)
  // The clients' copies, built only from the join snapshot, events and deltas, match the room's.
  for (const [c, pid] of [[kit, 1], [aiden, 2]] as const) {
    const m = s.players.find((p) => p.id === pid)!.map
    expect([...c.tapes.keys()].sort()).toEqual([...ids].sort())
    expect([...c.map.tapes].sort()).toEqual([...m.tapes].sort())
    expect(c.map.trail).toEqual(m.trail.map((v) => Math.round(v * 100) / 100))
    expect(c.map.heard.map((h) => [h.from, h.trail.length]).sort()).toEqual(m.heard.map((h) => [h.from, h.trail.length]).sort())
    for (const h of m.heard) expect(c.map.heard.find((x) => x.from === h.from)!.trail).toEqual(h.trail.map((v) => Math.round(v * 100) / 100))
  }
  // Bytes per seat per minute: the last minutes cost no more than the early ones.
  const avg = (rows: number[][], k: number) => rows.reduce((a, r) => a + r[k]!, 0) / rows.length
  for (const k of [0, 1]) expect(avg(perMinute.slice(-4), k)).toBeLessThan(avg(perMinute.slice(2, 6), k) * 1.3)
  expect(Math.max(kit.biggest, aiden.biggest)).toBeLessThan(16_000)
  console.log(`long room, KB/s per seat by minute (Kit, Aiden): ${perMinute.map((r) => r.map((b) => (b / 60 / 1024).toFixed(2)).join("/")).join(" ")}; biggest frame ${Math.max(kit.biggest, aiden.biggest)} B`)
}, 120_000)
