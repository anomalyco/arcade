import { describe, expect, test } from "bun:test"
import type { InputOps } from "./net/jitter-buffer"
import { type Activity, type Conn, DEFAULT_GRACE_MS, DEFAULT_MSG_BURST, type IdleState, RoomCore } from "./net/room-core"
import { VoiceRoom } from "./net/voice"

type In = { mx: number; press: boolean }
const ops: InputOps<In> = {
  merge: (a, b) => ({ ...b, press: a.press || b.press }),
  standIn: (last) => ({ ...last, press: false }),
  hasEdges: (i) => i.press,
}
type Msg = { type: string; [k: string]: unknown }
type Snap = { type: "snap"; ack: number; score: number }

/** A one-number world: each player has a score; a press scores a point, movement adds up. */
class TestRoom extends RoomCore<{ type: "noop" }, In, { id: string; score: number }, never, null, Snap> {
  players = new Map<string, { score: number; moved: number; ack: number; inputs: In[] }>()
  constructor(public now = { t: 0 }) {
    super({ code: "test", build: "b1", title: "TEST", maxPlayers: 2, snapEvery: 3, inputs: ops, clock: () => now.t })
  }
  /** One 60 Hz server tick. */
  tick() {
    this.now.t += 1000 / 60
    this.step()
  }
  protected decode(raw: unknown) {
    return typeof raw === "string" ? (JSON.parse(raw) as never) : null
  }
  protected encode(msg: unknown) {
    return JSON.stringify(msg)
  }
  protected hasPlayer(id: string) {
    return this.players.has(id)
  }
  protected join(id: string) {
    this.players.set(id, { score: 0, moved: 0, ack: 0, inputs: [] })
  }
  protected leave(id: string) {
    this.players.delete(id)
  }
  protected push(id: string, seq: number, i: In) {
    const p = this.players.get(id)!
    p.ack = seq
    p.inputs.push(i)
    p.moved += i.mx
    if (i.press) p.score++
  }
  protected activity(i: In, a: Activity) {
    return !!(i.mx || i.press || a)
  }
  protected handle() {}
  protected idleState(id: string): IdleState {
    return this.players.has(id) ? "play" : "gone"
  }
  protected stepWorld() {}
  protected takeEvents() {
    return []
  }
  protected roster() {
    return [...this.players].map(([id, p]) => ({ id, score: p.score }))
  }
  protected entities() {
    return null
  }
  protected snapshot(id: string): Snap {
    const p = this.players.get(id)
    return { type: "snap", ack: p?.ack ?? 0, score: p?.score ?? 0 }
  }
}

function client(room: TestRoom) {
  const got: Msg[] = []
  let closed: number | undefined
  const conn: Conn = { send: (d) => got.push(JSON.parse(d) as Msg), close: (c) => (closed = c) }
  const welcome = () => got.find((m) => m.type === "welcome") as { id: string; token: string } | undefined
  return {
    conn,
    got,
    welcome,
    get closed() {
      return closed
    },
    hello(extra: Record<string, unknown> = {}) {
      room.message(conn, JSON.stringify({ type: "hello", build: "b1", ...extra }))
      return welcome()
    },
    intent(seq: number, i: In) {
      room.message(conn, JSON.stringify({ type: "intent", seq, i }))
    },
  }
}

describe("RoomCore seats", () => {
  test("voice requires a seat and is removed on disconnect and idle kick", async () => {
    const room = new TestRoom()
    room.voice = new VoiceRoom()
    const a = client(room), b = client(room)
    const join = (c: ReturnType<typeof client>) => room.message(c.conn, '{"type":"voice.join"}')
    const flush = () => new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)))
    join(a)
    await flush()
    expect(a.got).toHaveLength(0)
    const wa = a.hello()!, wb = b.hello()!
    join(a); join(b)
    await flush()
    expect(a.got.some((m) => m.type === "voice.ready")).toBe(true)
    room.close(a.conn)
    expect(b.got.at(-1)).toMatchObject({ type: "voice.members", members: [{ id: wb.id }] })
    room.now.t = 100_000
    room.step()
    expect(b.closed).toBe(4002)
    // Even a late message from the kicked socket cannot re-enrol that old public identity.
    b.got.length = 0
    join(b)
    await flush()
    expect(b.got).toHaveLength(0)
    expect(wa.id).not.toBe(wb.id)
  })

  test("welcome carries a private token distinct from the public id", () => {
    const room = new TestRoom()
    const w = client(room).hello()!
    expect(w.id).toMatch(/^p1[0-9a-f]{4}$/)
    expect(w.token).toMatch(/^[0-9a-f]{32}$/)
    // Nobody else ever sees the token: rosters and snapshots carry only ids.
    const b = client(room)
    b.hello()
    room.step()
    expect(JSON.stringify(b.got)).not.toContain(w.token)
  })

  test("a dropped player reclaims their seat and score with the token, within the grace window", () => {
    const now = { t: 0 }
    const room = new TestRoom(now)
    const a = client(room)
    const w = a.hello()!
    room.players.get(w.id)!.score = 7
    room.close(a.conn)
    now.t = DEFAULT_GRACE_MS - 1
    room.step()
    const back = client(room).hello({ token: w.token })!
    expect(back.id).toBe(w.id)
    expect(back.token).toBe(w.token)
    expect(room.players.get(w.id)!.score).toBe(7)
  })

  test("the public id never reclaims a seat (no hijack), and a held seat isn't taken from its owner", () => {
    const room = new TestRoom()
    const a = client(room)
    const w = a.hello()!
    room.close(a.conn)
    const thief = client(room)
    const t = thief.hello({ token: w.id, id: w.id })!
    expect(t.id).not.toBe(w.id)
    // The room is now full (one held seat, one thief); the owner still gets back in with the token.
    expect(client(room).hello()).toBeUndefined()
    expect(client(room).hello({ token: w.token })!.id).toBe(w.id)
  })

  test("a second tab carrying a live seat's token gets a seat of its own", () => {
    const room = new TestRoom()
    const w = client(room).hello()!
    const dup = client(room).hello({ token: w.token })!
    expect(dup.id).not.toBe(w.id)
    expect(dup.token).not.toBe(w.token)
  })

  test("after the grace window the seat is gone and the token starts a fresh one", () => {
    const now = { t: 0 }
    const room = new TestRoom(now)
    const a = client(room)
    const w = a.hello()!
    room.close(a.conn)
    now.t = DEFAULT_GRACE_MS
    room.step()
    expect(room.players.has(w.id)).toBe(false)
    const again = client(room).hello({ token: w.token })!
    expect(again.token).not.toBe(w.token)
    expect(room.players.get(again.id)!.score).toBe(0)
  })

  test("a stale build is told to reload; a full room says so", () => {
    const room = new TestRoom()
    const stale = client(room)
    room.message(stale.conn, JSON.stringify({ type: "hello", build: "old" }))
    expect(stale.got[0]!.type).toBe("reload")
    expect(stale.closed).toBe(4003)
    client(room).hello()
    client(room).hello()
    const third = client(room)
    expect(third.hello()).toBeUndefined()
    expect(third.closed).toBe(4001)
  })

  test("open sockets count before their hello, so the room isn't dropped mid-handshake", () => {
    const room = new TestRoom()
    const a = client(room)
    room.open(a.conn)
    expect(room.connections).toBe(1)
    room.close(a.conn)
    expect(room.connections).toBe(0)
  })
})

describe("RoomCore inputs", () => {
  test("one input per tick after the jitter delay, acked by client sequence", () => {
    const room = new TestRoom()
    const a = client(room)
    const w = a.hello()!
    for (let seq = 1; seq <= 30; seq++) {
      a.intent(seq, { mx: 1, press: false })
      room.tick()
    }
    const p = room.players.get(w.id)!
    expect(p.inputs.length).toBe(p.ack)
    expect(p.ack).toBeGreaterThanOrEqual(27)
  })

  test("a burst after a stall keeps every press (the old queue.splice dropped them)", () => {
    const room = new TestRoom()
    const a = client(room)
    const w = a.hello()!
    let seq = 0
    let sent = 0
    for (let t = 0; t < 40; t++) {
      a.intent(++seq, { mx: 1, press: false })
      room.tick()
    }
    // A 600 ms stall (18 ticks of inputs held back by a TCP retransmit), then all at once; presses at 3 and 15.
    // (Two presses consumed in the same server tick merge into one, so they're kept apart here.)
    const held: In[] = []
    for (let t = 0; t < 18; t++) {
      held.push({ mx: 1, press: t === 3 || t === 15 })
      room.tick()
    }
    for (const i of held) {
      if (i.press) sent++
      a.intent(++seq, i)
    }
    for (let t = 0; t < 40; t++) {
      a.intent(++seq, { mx: 1, press: false })
      room.tick()
    }
    const p = room.players.get(w.id)!
    // A press stood in for during the stall is carried into the next applied input; the rest arrive in order.
    expect(sent).toBe(2)
    expect(p.score).toBe(2)
    expect(p.ack).toBeGreaterThan(seq - 8)
  })

  test("presses spread across bursts all land", () => {
    const room = new TestRoom()
    const a = client(room)
    const w = a.hello()!
    let seq = 0
    let presses = 0
    for (let round = 0; round < 10; round++) {
      const held: In[] = []
      for (let t = 0; t < 30; t++) {
        const press = t === 12
        if (press) presses++
        held.push({ mx: 1, press })
        if (t < 20) {
          a.intent(++seq, held.shift()!)
        }
        room.tick()
      }
      for (const i of held) a.intent(++seq, i)
    }
    for (let t = 0; t < 20; t++) room.tick()
    expect(room.players.get(w.id)!.score).toBe(presses)
  })

  test("a reconnect restarts the client's sequence without losing inputs", () => {
    const now = { t: 0 }
    const room = new TestRoom(now)
    const a = client(room)
    const w = a.hello()!
    for (let seq = 1; seq <= 100; seq++) {
      a.intent(seq, { mx: 1, press: false })
      room.tick()
    }
    room.close(a.conn)
    const b = client(room)
    b.hello({ token: w.token })
    // A reloaded page counts from 1 again.
    for (let seq = 1; seq <= 20; seq++) {
      b.intent(seq, { mx: 0, press: seq === 5 })
      room.tick()
    }
    const p = room.players.get(w.id)!
    expect(p.score).toBe(1)
    expect(p.ack).toBeGreaterThanOrEqual(17)
    expect(p.ack).toBeLessThanOrEqual(20)
  })
})

describe("RoomCore rate limit", () => {
  test("a flood past the burst budget is dropped; the budget refills over time", () => {
    const now = { t: 0 }
    const room = new TestRoom(now)
    const a = client(room)
    a.hello()
    a.got.length = 0
    for (let i = 0; i < 1000; i++) room.message(a.conn, JSON.stringify({ type: "ping", t: i }))
    // The hello spent one token.
    expect(a.got.length).toBe(DEFAULT_MSG_BURST - 1)
    a.got.length = 0
    now.t = 500
    for (let i = 0; i < 1000; i++) room.message(a.conn, JSON.stringify({ type: "ping", t: i }))
    expect(a.got.length).toBe(60)
  })

  test("a normal 60 Hz client with pings is never limited", () => {
    const now = { t: 0 }
    const room = new TestRoom(now)
    const a = client(room)
    const w = a.hello()!
    for (let tick = 1; tick <= 600; tick++) {
      now.t = (tick * 1000) / 60
      a.intent(tick, { mx: 1, press: tick % 30 === 0 })
      if (tick % 30 === 0) room.message(a.conn, JSON.stringify({ type: "ping", t: tick }))
      room.step()
    }
    for (let t = 0; t < 10; t++) room.step()
    expect(room.players.get(w.id)!.score).toBe(20)
    expect(a.got.filter((m) => m.type === "pong").length).toBe(20)
  })
})
