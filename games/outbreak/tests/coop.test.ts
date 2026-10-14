import { describe, expect, test } from "bun:test"
import { CoopRoomCore, type Conn } from "../server/room-core"
import { BUILD } from "../shared/build.gen"
import { TICK_DT } from "../shared/clock"
import { DEFAULT_COOP_ROOM } from "../shared/coop-config"
import { CoopSim } from "../shared/coop-sim"
import { decodeServerText, decodeSnapshot, packCommand, type ServerMsg } from "../shared/net-protocol"
import type { Command } from "../shared/session"
import { NetSession } from "../src/net-session"
import { Loopback } from "./loopback"

const idle = (aim = 0): Command => ({ mx: 0, my: 0, aim, interact: false })

describe("CoopSim", () => {
  test("zombies split their attention between four survivors and each survivor takes its own damage", () => {
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    const spots = [
      [44, 12],
      [44, 84],
      [12, 44],
      [84, 44],
    ] as const
    const slots = spots.map(([x, y], i) => {
      const slot = sim.addSurvivor(`p${i}`, i)
      Object.assign(slot.survivor, { x, y })
      return slot
    })
    for (const [x, y] of spots) {
      sim.ai.spawnZombie(sim.town, x + 2.2, y, "chase", Math.PI)
      sim.ai.spawnZombie(sim.town, x - 2.2, y, "chase", 0)
    }
    for (let i = 0; i < 360; i++) {
      for (const slot of slots) sim.stepSurvivor(slot, idle(), TICK_DT)
      sim.stepWorld(TICK_DT, 120)
    }
    expect(new Set(sim.ai.agents.map((a) => a.focusId))).toEqual(new Set(slots.map((s) => s.id)))
    for (const slot of slots) expect(slot.survivor.health).toBeLessThan(100)
  })

  test("a lone survivor in CoopSim behaves like the offline session's target (id 'player' is the default)", () => {
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 6 })
    const slot = sim.addSurvivor("player", 0)
    for (let i = 0; i < 120; i++) {
      sim.stepSurvivor(slot, { mx: 1, my: 0, aim: 0, interact: false }, TICK_DT)
      sim.stepWorld(TICK_DT, 120)
    }
    expect(sim.ai.agents.every((a) => a.focusId === "" || a.focusId === "player")).toBe(true)
  })
})

type Client = { conn: Conn; msgs: ServerMsg[]; snaps: ReturnType<typeof decodeSnapshot>[]; seq: number; id: string; token: string }

function client(core: CoopRoomCore, name: string, token?: string): Client {
  const c: Client = { msgs: [], snaps: [], seq: 0, id: "", token: "", conn: null! }
  c.conn = {
    send(data) {
      if (typeof data === "string") {
        const m = decodeServerText(data)!
        c.msgs.push(m)
        if (m.t === "welcome") {
          c.id = m.id
          c.token = m.token
        }
      } else c.snaps.push(decodeSnapshot(data, 7))
    },
    close() {},
  }
  core.open(c.conn)
  core.message(c.conn, JSON.stringify({ t: "hello", name, token, build: "test" }))
  return c
}

/** Each tick, every client sends one command (from `cmd`, or idle) and the room steps once. */
function run(core: CoopRoomCore, clients: Client[], ticks: number, cmd: (c: Client, i: number) => Command = () => idle()): void {
  for (let i = 0; i < ticks; i++) {
    for (const c of clients) core.message(c.conn, JSON.stringify({ t: "in", s: c.seq++, c: [packCommand(cmd(c, i))] }))
    core.step()
  }
}

const last = (c: Client) => c.snaps[c.snaps.length - 1]!

describe("CoopRoomCore", () => {
  const options = { ...DEFAULT_COOP_ROOM, zombieCount: 0 }

  test("shared doors and loot, private ammo, planks and inventory", () => {
    const core = new CoopRoomCore("test", options, Date.now, "test")
    const a = client(core, "Ann")
    const b = client(core, "Bob")
    expect(a.id).not.toBe(b.id)
    expect(a.token).not.toBe(a.id)
    const roster = b.msgs.filter((m) => m.t === "roster").at(-1)
    expect(roster && roster.t === "roster" && roster.players.map((p) => p.name)).toEqual(["Ann", "Bob"])
    run(core, [a, b], 6)
    const slotA = core.sim.slot(a.id)!
    const slotB = core.sim.slot(b.id)!
    Object.assign(slotA.survivor, { x: 27.7, y: 36.3 })
    Object.assign(slotB.survivor, { x: 24.65, y: 26.05 })
    core.sim.rebuildSolids()

    // Ann opens the Ash House front door; Bob searches a drawer inside.
    run(core, [a, b], 12, (c, i) => (c === a ? { ...idle(-Math.PI / 2), interact: i === 0 } : { ...idle(Math.PI / 2), interact: i === 0 }))
    run(core, [a, b], 60)
    const door = core.sim.town.doors.findIndex((d) => d.id === "ash-front")
    const drawer = core.sim.combat.containers.findIndex((c) => c.id === "loot-2")
    for (const c of [a, b]) {
      expect(last(c).shared.doors[door]!.open).toBe(true)
      expect(last(c).shared.searched[drawer]).toBe(true)
    }
    expect(last(b).personal.survivor.reserveAmmo).toBe(6 + 8)
    expect(last(a).personal.survivor.reserveAmmo).toBe(6)

    // Ann fires: only her magazine empties by one; both see the shot, attributed to her seat.
    run(core, [a, b], 3, (c, i) => (c === a && i === 0 ? { ...idle(Math.PI / 2), fire: true } : idle()))
    expect(last(a).personal.survivor.magAmmo).toBe(5)
    expect(last(b).personal.survivor.magAmmo).toBe(6)
    for (const c of [a, b]) expect(last(c).shared.shots.at(-1)?.shooter).toBe(slotA.index)
    expect(core.sim.ai.noiseBus.events.some((e) => e.kind === "gunshot")).toBe(true)
    expect(last(a).personal.ack).toBeGreaterThan(a.seq - 6)
  })

  test("reconnecting with the private token keeps the survivor; the public id does not", () => {
    let now = 0
    const core = new CoopRoomCore("test", options, () => now, "test")
    const a = client(core, "Ann")
    run(core, [a], 30, (_c, i) => ({ ...idle(), fire: i === 0 }))
    const ammo = core.sim.slot(a.id)!.survivor.magAmmo
    core.close(a.conn)
    now += 5000
    const thief = client(core, "Eve", a.id)
    expect(thief.id).not.toBe(a.id)
    const back = client(core, "Ann", a.token)
    expect(back.id).toBe(a.id)
    expect(core.sim.slot(a.id)!.survivor.magAmmo).toBe(ammo)
    expect(core.sim.slots.length).toBe(2)
  })

  test("stale builds are asked to reload and a fifth survivor is turned away", () => {
    const core = new CoopRoomCore("test", options, Date.now, "test")
    const stale: ServerMsg[] = []
    const conn: Conn = { send: (d) => typeof d === "string" && stale.push(decodeServerText(d)!), close() {} }
    core.open(conn)
    core.message(conn, JSON.stringify({ t: "hello", name: "Old", build: "old" }))
    expect(stale[0]?.t).toBe("reload")
    for (let i = 0; i < 4; i++) client(core, `P${i}`)
    const fifth = client(core, "Late")
    expect(fifth.msgs[0]?.t).toBe("error")
  })
})

describe("NetSession prediction", () => {
  test("predicts the local survivor ahead of the room and reconciles to the exact room state", () => {
    let virtualMs = 0
    const core = new CoopRoomCore("test", { ...DEFAULT_COOP_ROOM, zombieCount: 4 }, () => virtualMs, BUILD)
    const net = new Loopback(core, 4)
    const memory = new Map<string, string>()
    const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v) }
    const session = new NetSession({ url: "loop", room: "test", name: "Ann", storage, now: () => net.now, WebSocket: net.socketClass() })
    let corrections = 0
    let maxCorrection = 0
    for (let i = 0; i < 400; i++) {
      virtualMs = net.now * 1000
      net.step()
      const moving = i < 240
      const cmd: Command = { mx: moving ? Math.cos(i / 40) : 0, my: moving ? Math.sin(i / 55) : 0, aim: i / 30, interact: false, sprint: i % 90 < 30 }
      session.update(TICK_DT, cmd)
      session.sync(TICK_DT)
      const c = Math.hypot(session.smoother.x, session.smoother.y)
      if (c > 1e-6) corrections++
      maxCorrection = Math.max(maxCorrection, c)
    }
    expect(session.connected).toBe(true)
    const server = core.sim.slot(session.id)!.survivor
    const local = session.view.player
    expect(session.snapshotCount).toBeGreaterThan(50)
    expect(Math.hypot(local.x - server.x, local.y - server.y)).toBeLessThan(0.002)
    expect(Math.abs(local.stamina - server.stamina)).toBeLessThan(0.002)
    expect(maxCorrection).toBeLessThan(0.01)
    // Remote zombies render from the room's snapshots.
    expect(session.view.zombies.length).toBe(core.sim.ai.agents.length)
    expect(corrections).toBeLessThan(40)
    session.close()
  })
})

test("over a jittery link, stand-ins never lose a shot and the survivor still converges", () => {
  let virtualMs = 0
  const core = new CoopRoomCore("test", { ...DEFAULT_COOP_ROOM, zombieCount: 0 }, () => virtualMs, BUILD)
  const net = new Loopback(core, 3, 8)
  const session = new NetSession({ url: "loop", room: "test", name: "Ann", now: () => net.now, WebSocket: net.socketClass() })
  let shots = 0
  for (let i = 0; i < 600; i++) {
    virtualMs = net.now * 1000
    net.step()
    const fire = session.connected && i % 50 === 25 && shots < 5
    if (fire) shots++
    session.update(TICK_DT, { mx: i < 450 ? Math.sin(i / 30) : 0, my: i < 450 ? 0.6 : 0, aim: 1.2, interact: false, fire })
    session.sync(TICK_DT)
  }
  const server = core.sim.slot(session.id)!.survivor
  const seat = core.seats.byId(session.id)!
  expect(seat.data.jitter.stats.synthesized).toBeGreaterThan(0)
  expect(shots).toBe(5)
  expect(server.magAmmo + server.reserveAmmo).toBe(12 - 5)
  expect(Math.hypot(session.view.player.x - server.x, session.view.player.y - server.y)).toBeLessThan(0.01)
  session.close()
})
