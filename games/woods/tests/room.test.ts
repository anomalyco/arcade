import { expect, test } from "bun:test"
import { WoodsRoomCore } from "../server/room-core"
import { BUILD } from "../shared/build.gen"
import { BOT_ID, tieTarget } from "../shared/sim"
import { decodeServer, packIntent, ROOM_FEEL, TEAM, tapeFromRow, type ServerMsg, type Snapshot } from "../shared/protocol"
import type { PlayerInput } from "../shared/sim"

type Client = { conn: { send(d: string): void; close(): void }; got: ServerMsg[]; bytes: number; token?: string; seq: number; closed: boolean }

function setup() {
  let now = 0
  const room = new WoodsRoomCore("test1", () => now)
  const tick = (n = 1) => { for (let i = 0; i < n; i++) { now += 1000 / 30; room.step() } }
  const connect = (name: string, token?: string): Client => {
    const c: Client = { got: [], bytes: 0, seq: 0, closed: false, conn: { send: (d) => { c.bytes += d.length; const m = decodeServer(d); if (m) c.got.push(m) }, close: () => { c.closed = true } } }
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

test("a tape one person ties is in everyone's snapshot, and so is untying it", () => {
  const { tick, connect, send, last, room } = setup()
  const a = connect("Kit"), b = connect("Aiden")
  const me = room.state.players.find((p) => p.id === 1)!
  const tree = room.world.trees.find((t) => t.species === "pine" && Math.abs(t.x) < 100)!
  Object.assign(me, { x: tree.x, z: tree.z + tree.radius + 0.8, yaw: 0 })
  expect(tieTarget(room.world, me, ROOM_FEEL.tapeReach)?.id).toBe(tree.id)
  for (let i = 0; i < 45; i++) { send(a, { tie: true }); send(b, {}); tick() }
  const rows = b.got.filter((m): m is Snapshot => m.type === "s" && !!m.tapes).at(-1)!.tapes!
  expect(rows.map((r) => tapeFromRow(room.world, r)!.tree)).toEqual([tree.id])
  expect(b.got.some((m) => m.type === "ev" && m.events.some((e) => e.kind === "tape-tied" && e.tree === tree.id))).toBe(true)
  for (let i = 0; i < 10; i++) { send(a, {}); tick() }
  for (let i = 0; i < 45; i++) { send(a, { tie: true }); tick() }
  expect(b.got.filter((m): m is Snapshot => m.type === "s" && !!m.tapes).at(-1)!.tapes).toEqual([])
  void last
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
  expect(room.humans).toBe(2)
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
