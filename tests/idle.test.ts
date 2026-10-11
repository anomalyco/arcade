import { describe, expect, test } from "bun:test"
import { IDLE_DARK_KICK_SECONDS, IDLE_KICK_SECONDS, IDLE_WARN_SECONDS, TICK_HZ } from "../shared/config"
import { type ClientMsg, type ServerMsg, decodeServer, encodeClient } from "../shared/protocol"
import type { Input } from "../shared/sim/vehicle"
import { type Conn, RoomCore } from "../server/core"

const NEUTRAL: Input = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false }
/** Activity that doesn't move the car, so nobody gets busted by accident. */
const fidget = (tick: number): Input => ({ ...NEUTRAL, handbrake: tick % 2 === 0 })

class Client {
  msgs: ServerMsg[] = []
  closed = false
  id = ""
  seq = 0
  conn: Conn
  constructor(
    readonly core: RoomCore,
    name: string,
  ) {
    this.conn = {
      send: (d) => {
        const m = decodeServer(d)!
        if (m.type === "welcome") this.id = m.id
        this.msgs.push(m)
      },
      close: () => {
        this.closed = true
        core.close(this.conn)
      },
    }
    core.open(this.conn)
    this.send({ type: "hello", name, picks: { robber: "muscle", cop: "cruiser" } })
  }
  send(msg: ClientMsg) {
    this.core.message(this.conn, encodeClient(msg))
  }
  input(input: Input) {
    this.send({ type: "input", seq: ++this.seq, input })
  }
  lastIdleIn() {
    const snaps = this.msgs.filter((m) => m.type === "snapshot")
    return snaps.at(-1)?.idleIn
  }
  kicked() {
    return this.msgs.some((m) => m.type === "error" && m.code === "idle")
  }
}

/** Steps `seconds` of server time; `active` clients send fresh activity every tick, the rest stay silent. */
function run(core: RoomCore, seconds: number, active: Client[], each?: () => void) {
  const n = Math.round(seconds * TICK_HZ)
  for (let i = 0; i < n; i++) {
    for (const c of active) if (!c.closed) c.input(fidget(core.tick))
    core.step()
    each?.()
  }
}

describe("idle kick", () => {
  test("an idle player is warned from 100 s and kicked at 120 s, seat freed at once", () => {
    const core = new RoomCore("IDLE")
    const a = new Client(core, "A")
    const b = new Client(core, "B")
    run(core, IDLE_KICK_SECONDS - IDLE_WARN_SECONDS - 1, [b])
    expect(a.lastIdleIn()).toBeUndefined()
    run(core, 2, [b])
    expect(a.lastIdleIn()).toBeGreaterThan(IDLE_WARN_SECONDS - 3)
    expect(a.lastIdleIn()).toBeLessThanOrEqual(IDLE_WARN_SECONDS)
    expect(b.lastIdleIn()).toBeUndefined()
    run(core, IDLE_WARN_SECONDS - 1.5, [b])
    expect(a.kicked()).toBe(false)
    expect(a.lastIdleIn()).toBe(1)
    run(core, 1, [b])
    expect(a.kicked()).toBe(true)
    expect(a.closed).toBe(true)
    expect(core.humans()).toBe(1)
    expect(core.roster().map((r) => r.id)).toEqual([b.id])
    expect(b.kicked()).toBe(false)
  })

  test("input activity resets the timer; repeating a neutral input does not", () => {
    const core = new RoomCore("RESET")
    const a = new Client(core, "A")
    const b = new Client(core, "B")
    run(core, 60, [b])
    a.input({ ...NEUTRAL, throttle: 1 })
    run(core, 0.1, [b])
    a.input(NEUTRAL) // a change back to neutral is activity too
    for (let i = 0; i < 100; i++) a.input(NEUTRAL)
    run(core, IDLE_KICK_SECONDS - 1, [b])
    expect(a.kicked()).toBe(false)
    run(core, 1.5, [b])
    expect(a.kicked()).toBe(true)
  })

  test("the driver sitting dark gets 240 s", () => {
    const core = new RoomCore("DARK")
    const a = new Client(core, "A")
    const b = new Client(core, "B")
    run(core, 12, [b]) // into the chase
    const world = core.world!
    expect(world.phase).toBe("chase")
    expect(world.robberId).toBe(a.id)
    a.input({ ...NEUTRAL, engine: true })
    core.step()
    a.input(NEUTRAL)
    core.step()
    expect(world.carOf(a.id)!.body.engineOff).toBe(true)
    run(core, IDLE_KICK_SECONDS + 5, [b])
    expect(a.kicked()).toBe(false)
    expect(a.lastIdleIn()).toBeUndefined()
    run(core, IDLE_DARK_KICK_SECONDS - IDLE_KICK_SECONDS - IDLE_WARN_SECONDS - 5 + 1, [b])
    expect(a.lastIdleIn()).toBeLessThanOrEqual(IDLE_WARN_SECONDS)
    run(core, IDLE_WARN_SECONDS, [b])
    expect(a.kicked()).toBe(true)
  })

  test("nobody is kicked during the end card; the timer keeps running", () => {
    const core = new RoomCore("END")
    const a = new Client(core, "A")
    const b = new Client(core, "B")
    run(core, 12, [b])
    const world = core.world!
    run(core, IDLE_KICK_SECONDS - 14, [b])
    // Survival rounds only end on a bust; end this one directly.
    ;(world as unknown as { endRound(escaped: boolean, text: string): void }).endRound(false, "SUSPECT BUSTED")
    expect(world.phase).toBe("end")
    run(core, 7, [b]) // 125 s: overdue, but the end card protects them
    expect(world.phase).toBe("end")
    expect(a.kicked()).toBe(false)
    run(core, 3, [b]) // the next round starts and the overdue player goes
    expect(a.kicked()).toBe(true)
  })

  test("kicking the robber sends the round back to the start", () => {
    const core = new RoomCore("ROBBER")
    const a = new Client(core, "A")
    const b = new Client(core, "B")
    const c = new Client(core, "C")
    run(core, 12, [b, c])
    const world = core.world!
    expect(world.robberId).toBe(a.id)
    expect(world.phase).toBe("chase")
    const round = world.round
    run(core, IDLE_KICK_SECONDS - 12 + 1, [b, c])
    expect(a.kicked()).toBe(true)
    expect(world.round).toBe(round + 1)
    expect(world.phase).toBe("intro")
    expect([b.id, c.id]).toContain(world.robberId)
    expect(world.carOf(a.id)).toBeUndefined()
  })
})
