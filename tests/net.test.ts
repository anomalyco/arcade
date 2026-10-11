import { describe, expect, test } from "bun:test"
import { DT } from "../shared/config"
import { type ServerMsg, decodeServer, encodeClient } from "../shared/protocol"
import type { Body, Input } from "../shared/sim/vehicle"
import { type Conn, RoomCore } from "../server/core"
import { NetClient } from "../src/game/netcode"

/** A socket pair with fixed one-way latency, measured in ticks. */
class Pipe {
  up: { at: number; data: string }[] = []
  down: { at: number; data: string }[] = []
  received: ServerMsg[] = []
  conn: Conn
  closed = false
  constructor(
    readonly net: Net,
    readonly lat: number,
  ) {
    this.conn = { send: (data) => this.down.push({ at: net.t + lat, data }), close: () => (this.closed = true) }
    net.core.open(this.conn)
  }
  sendUp(msg: Parameters<typeof encodeClient>[0]) {
    this.up.push({ at: this.net.t + this.lat, data: encodeClient(msg) })
  }
  take(): ServerMsg[] {
    const out: ServerMsg[] = []
    while (this.down.length && this.down[0]!.at <= this.net.t) out.push(decodeServer(this.down.shift()!.data)!)
    this.received.push(...out)
    return out
  }
}

class Net {
  t = 0
  core = new RoomCore("TEST")
  pipes: Pipe[] = []
  pipe(lat = 3) {
    const p = new Pipe(this, lat)
    this.pipes.push(p)
    return p
  }
  /** Delivers due client frames, then steps the server one tick. */
  tick() {
    this.t++
    for (const p of this.pipes) while (p.up.length && p.up[0]!.at <= this.t) this.core.message(p.conn, p.up.shift()!.data)
    this.core.step()
  }
}

/** Joins a client that predicts with NetClient. Records its predicted body per input seq and the server's per ack. */
function join(net: Net, name: string, lat = 3) {
  const pipe = net.pipe(lat)
  pipe.sendUp({ type: "hello", name, picks: { robber: "muscle", cop: "cruiser" } })
  let client: NetClient | null = null
  const predicted = new Map<number, Body>()
  const server = new Map<number, Body>()
  return {
    pipe,
    get client() {
      return client
    },
    predicted,
    server,
    /** Receives due frames and runs one client frame of exactly one tick. */
    frame(input: Input) {
      for (const m of pipe.take()) {
        if (m.type === "welcome") client = new NetClient(net.core.world!.city, m.id, (msg) => pipe.sendUp(msg))
        else if (client) {
          client.receive(m)
          if (m.type === "snapshot" && m.you) server.set(m.ack, m.you)
        }
      }
      if (!client) return null
      const v = client.update(DT, input)
      if (client.body) predicted.set(client.seq, { ...client.body })
      return v
    },
  }
}

type Joined = ReturnType<typeof join>

/** Ticks until every joiner has been welcomed and holds a snapshot. */
function settle(net: Net, ...js: Joined[]) {
  for (let i = 0; i < 30 && js.some((j) => !j.client?.latest); i++) {
    net.tick()
    for (const j of js) j.frame(drive(i))
  }
}

const drive = (i: number): Input => ({ throttle: 1, brake: 0, steer: Math.sin(i / 25) * 0.8, handbrake: i % 90 > 70, boost: i % 200 < 40 })

function maxError(predicted: Map<number, Body>, server: Map<number, Body>, from = 0) {
  let worst = 0
  let n = 0
  for (const [seq, s] of server) {
    const p = predicted.get(seq)
    if (!p || seq < from) continue
    worst = Math.max(worst, Math.hypot(p.x - s.x, p.z - s.z), Math.abs(p.vx - s.vx), Math.abs(p.h - s.h))
    n++
  }
  return { worst, n }
}

describe("prediction", () => {
  test("predicted car matches the server body for every acked input", () => {
    const net = new Net()
    const a = join(net, "Ada")
    for (let i = 0; i < 260; i++) {
      net.tick()
      a.frame(drive(i))
    }
    const world = net.core.world!
    expect(world.robberId).toBe(a.client!.myId)
    expect(world.phase).toBe("headstart")
    const { worst, n } = maxError(a.predicted, a.server)
    expect(n).toBeGreaterThan(100)
    expect(worst).toBeLessThan(1e-9)
    // It actually drove somewhere.
    const car = world.carOf(a.client!.myId)!
    expect(Math.hypot(car.body.x - world.site.x, car.body.z - world.site.z + 10)).toBeGreaterThan(5)
  })

  test("reconciles after a server-side correction and the drawn car converges", () => {
    const net = new Net()
    const a = join(net, "Ada")
    let hitSeq = 0
    let view = null
    for (let i = 0; i < 300; i++) {
      net.tick()
      if (i === 200) {
        const body = net.core.world!.carOf(a.client!.myId)!.body
        body.x += 3
        body.vx += 6
        hitSeq = a.client!.seq
      }
      view = a.frame(drive(i))
    }
    expect(hitSeq).toBeGreaterThan(0)
    const { worst, n } = maxError(a.predicted, a.server, hitSeq + 10)
    expect(n).toBeGreaterThan(20)
    expect(worst).toBeLessThan(1e-9)
    const mine = view!.cars.find((c) => c.ownerId === a.client!.myId)!
    // Frames here land exactly on tick boundaries, so the drawn pose is the previous tick's body plus any leftover correction.
    const prev = a.predicted.get(a.client!.seq - 1)!
    expect(Math.hypot(mine.x - prev.x, mine.z - prev.z)).toBeLessThan(0.05)
  })

  test("other cars are interpolated between snapshots", () => {
    const net = new Net()
    const a = join(net, "Ada")
    settle(net, a)
    net.core.world!.startRound()
    const xs: number[] = []
    for (let i = 0; i < 420; i++) {
      net.tick()
      const v = a.frame({ throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false })
      const bot = v?.cars.find((c) => c.role === "cop" && !c.human)
      if (v?.phase === "chase" && bot && bot.speed > 3) xs.push(bot.x + bot.z)
    }
    // Snapshots arrive every other tick, yet the drawn position changes every frame.
    let still = 0
    for (let i = 1; i < xs.length; i++) if (xs[i] === xs[i - 1]) still++
    expect(xs.length).toBeGreaterThan(30)
    expect(still / xs.length).toBeLessThan(0.2)
  })
})

describe("room", () => {
  test("bots fill the cop side and the room caps at six humans", () => {
    const net = new Net()
    const a = join(net, "Ada")
    settle(net, a)
    expect(net.core.participants().length).toBe(4)
    const others = [1, 2, 3, 4, 5].map((i) => join(net, `P${i}`))
    settle(net, ...others)
    expect(net.core.participants().length).toBe(6)
    expect(net.core.participants().every((p) => p.human)).toBe(true)
    const late = join(net, "Late")
    for (let i = 0; i < 6; i++) {
      net.tick()
      late.frame(drive(i))
    }
    expect(late.pipe.received.some((m) => m.type === "error" && m.code === "full")).toBe(true)
    expect(late.pipe.closed).toBe(true)
  })

  test("mid-round joiners spectate with a view, then get a car next round", () => {
    const net = new Net()
    const a = join(net, "Ada")
    settle(net, a)
    const b = join(net, "Bo")
    settle(net, b)
    for (let i = 0; i < 10; i++) {
      net.tick()
      a.frame(drive(i))
      b.frame(drive(i))
    }
    const snaps = b.pipe.received.filter((m) => m.type === "snapshot")
    expect(snaps.length).toBeGreaterThan(0)
    for (const s of snaps) {
      expect(s.you).toBeNull()
      expect(s.view.cars.length).toBeGreaterThan(0)
    }
    expect(b.client!.body).toBeNull()
    net.core.world!.startRound()
    for (let i = 0; i < 10; i++) {
      net.tick()
      a.frame(drive(i))
      b.frame(drive(i))
    }
    expect(b.client!.body).not.toBeNull()
    expect(a.client!.body).not.toBeNull()
    expect(net.core.world!.carOf(b.client!.myId)!.human).toBe(true)
  })

  test("a reconnect within the grace period resumes the same seat and car", () => {
    const net = new Net()
    const a = join(net, "Ada")
    settle(net, a)
    const id = a.client!.myId
    net.core.close(a.pipe.conn)
    for (let i = 0; i < 30; i++) net.tick()
    expect(net.core.world!.carOf(id)!.human).toBe(true)
    const p = net.pipe()
    p.sendUp({ type: "hello", name: "Ada", picks: { robber: "muscle", cop: "cruiser" }, id })
    for (let i = 0; i < 5; i++) net.tick()
    net.t += 3
    const welcome = p.take().find((m) => m.type === "welcome")
    expect(welcome && welcome.type === "welcome" && welcome.id).toBe(id)
    expect(net.core.humans()).toBe(1)
  })
})

describe("fog of war", () => {
  test("cop and spectator snapshots never carry the robber's live position while unseen", () => {
    const net = new Net()
    const cop = join(net, "Cop")
    settle(net, cop)
    // Round 1 alternates a lone human onto the cop side with a bot robber.
    net.core.world!.startRound()
    const spec = join(net, "Spec")
    const world = net.core.world!
    let unseen = 0
    let seen = 0
    for (const j of [cop, spec]) {
      const send = j.pipe.conn.send
      j.pipe.conn.send = (data) => {
        const m = JSON.parse(data) as ServerMsg
        if (m.type === "snapshot") {
          const robber = world.robber()!
          const live = m.view.cars.find((c) => c.ownerId === world.robberId && !c.ghost)
          const hidden = !world.seen && (world.phase === "headstart" || world.phase === "chase")
          if (hidden) {
            unseen++
            expect(live).toBeUndefined()
            for (const c of m.view.cars)
              if (c.ownerId === world.robberId) {
                expect(c.ghost).toBe(true)
                expect(Math.hypot(c.x - world.lastSeen!.x, c.z - world.lastSeen!.z)).toBeLessThan(0.01)
              }
            if (m.you) expect(Math.hypot(m.you.x - robber.body.x, m.you.z - robber.body.z)).toBeGreaterThan(0)
          } else if (world.phase === "chase") seen++
          for (const c of m.view.cars) if (c.ghost) expect(c.speed).toBe(0)
        }
        send(data)
      }
    }
    expect(world.robberId.startsWith("bot")).toBe(true)
    for (let i = 0; i < 30 * 40 && world.phase !== "end"; i++) {
      net.tick()
      cop.frame({ throttle: 0, brake: 1, steer: 0, handbrake: false, boost: false })
      spec.frame(drive(i))
    }
    expect(unseen).toBeGreaterThan(100)
    expect(cop.client!.body).not.toBeNull()
    expect(spec.client!.body).toBeNull()
    void seen
  })
})
