import { describe, expect, test } from "bun:test"
import { AckHistory } from "@arcade/kit/net/interest"
import { CoopRoomCore, type Conn } from "../server/room-core"
import { createAIAgent } from "../shared/ai"
import { BUILD } from "../shared/build.gen"
import { TICK_DT } from "../shared/clock"
import { DEFAULT_COOP_ROOM } from "../shared/coop-config"
import { CoopSim, createSurvivor } from "../shared/coop-sim"
import {
  decodeClient,
  decodePersonal,
  decodeServerText,
  decodeShared,
  decodeSnapshot,
  encodeClientIn,
  encodePersonal,
  encodeShared,
  inspectSnapshotBreakdown,
  packCommand,
  type ServerMsg,
  type SharedSnapshot,
} from "../shared/net-protocol"
import type { Command } from "../shared/session"
import { ALL_PAIRS, matStoreId, pairKey, pinStoreId, readPin } from "../shared/discovery/tinker"
import { OutbreakProgression, type Ledger } from "../shared/progression"
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

type Client = {
  conn: Conn
  msgs: ServerMsg[]
  snaps: ReturnType<typeof decodeSnapshot>[]
  seq: number
  id: string
  token: string
  /** What this client knows of the ledger, built only from its snapshots. */
  ledger: Ledger
  notices: string[]
}

function client(core: CoopRoomCore, name: string, token?: string): Client {
  const mirror = new OutbreakProgression(core.sim.town).ledger
  const c: Client = { msgs: [], snaps: [], seq: 0, id: "", token: "", conn: null!, ledger: mirror, notices: [] }
  c.conn = {
    send(data) {
      if (typeof data === "string") {
        const m = decodeServerText(data)!
        c.msgs.push(m)
        if (m.t === "welcome") {
          c.id = m.id
          c.token = m.token
        }
      } else {
        const snap = decodeSnapshot(data, 7)
        c.snaps.push(snap)
        if (snap.personal.ledger) c.ledger.applyDelta(snap.personal.ledger)
        c.notices.push(...snap.personal.notices.map((n) => n.text))
      }
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

/** Replaces a container's contents (loot is seeded randomly; tests want to know what is inside). */
function stockContainer(ledger: Ledger, id: string, stacks: { item: string; count: number }[]): void {
  const st = ledger.store(id)!
  st.slots.fill(null)
  stacks.forEach((s, i) => (st.slots[i] = { ...s }))
  st.rev = ++ledger.rev
}

describe("CoopRoomCore", () => {
  const options = { ...DEFAULT_COOP_ROOM, zombieCount: 0 }

  test("shared doors and loot, private ammo, planks and belts", () => {
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
    const ledger = core.sim.progression.ledger
    const drawer = "loot:2"
    stockContainer(ledger, drawer, [{ item: "ammo", count: 8 }])

    // Ann opens the Ash House front door; Bob searches the nightstand inside, then takes what is in it.
    run(core, [a, b], 12, (c, i) => (c === a ? { ...idle(-Math.PI / 2), interact: i === 0 } : { ...idle(Math.PI / 2), interact: i === 0 }))
    run(core, [a, b], 80)
    const door = core.sim.town.doors.findIndex((d) => d.id === "ash-front")
    for (const c of [a, b]) {
      expect(last(c).shared.doors[door]!.open).toBe(true)
      expect(c.ledger.store(drawer)!.revealed).toBe(true)
      expect(c.ledger.count(drawer, "ammo")).toBe(8)
    }
    run(core, [a, b], 6, (c, i) => (c === b ? { ...idle(Math.PI / 2), interact: i === 0 } : idle()))
    for (const c of [a, b]) expect(c.ledger.count(drawer, "ammo")).toBe(0)
    expect(last(b).personal.survivor.reserveAmmo).toBe(6 + 8)
    expect(last(a).personal.survivor.reserveAmmo).toBe(6)
    // Each client sees its own belt and nobody else's.
    expect(b.ledger.count(`${b.id}/belt`, "ammo")).toBe(14)
    expect(a.ledger.store(`${b.id}/belt`)).toBeUndefined()
    expect(b.notices).toContain("+8 9mm")

    // Ann fires: only her magazine empties by one; both see the shot, attributed to her seat.
    run(core, [a, b], 6, (c, i) => (c === a && i === 0 ? { ...idle(Math.PI / 2), fire: true } : idle()))
    expect(last(a).personal.survivor.magAmmo).toBe(5)
    expect(last(b).personal.survivor.magAmmo).toBe(6)
    for (const c of [a, b]) expect(last(c).shared.shots.at(-1)?.shooter).toBe(slotA.index)
    expect(core.sim.ai.noiseBus.events.some((e) => e.kind === "gunshot")).toBe(true)
    expect(last(a).personal.ack).toBeGreaterThan(a.seq - 6)
  })

  test("two survivors grabbing the last medkit in the same tick: one gets it, the other is told it is gone", () => {
    const core = new CoopRoomCore("test", options, Date.now, "test")
    const a = client(core, "Ann")
    const b = client(core, "Bob")
    run(core, [a, b], 3)
    const ledger = core.sim.progression.ledger
    const site = core.sim.progression.containers.find((c) => c.id === "loot:2")!
    stockContainer(ledger, site.id, [{ item: "medkit", count: 1 }])
    ledger.store(site.id)!.revealed = true
    for (const [slot, dx] of [
      [core.sim.slot(a.id)!, -0.35],
      [core.sim.slot(b.id)!, 0.35],
    ] as const) Object.assign(slot.survivor, { x: site.x + dx, y: site.y + 0.75 })
    core.sim.rebuildSolids()
    run(core, [a, b], 1, () => ({ ...idle(-Math.PI / 2), pick: { mode: "take", index: 0 } }))
    run(core, [a, b], 3)
    const owners = [a, b].filter((c) => ledger.count(c.id, "medkit") > 0)
    expect(owners).toHaveLength(1)
    expect(ledger.count(site.id, "medkit")).toBe(0)
    for (const c of [a, b]) expect(c.ledger.count(site.id, "medkit")).toBe(0)
  })

  test("a sketch made at the bench reaches every client with its maker's seat", () => {
    const core = new CoopRoomCore("test", options, Date.now, "test")
    const a = client(core, "Ann")
    const b = client(core, "Bob")
    run(core, [a, b], 3)
    core.sim.hour = 12
    const progression = core.sim.progression
    const ledger = progression.ledger
    const bench = progression.benches.find((x) => x.id === "bench:ash")!
    ledger.apply({ kind: "grant", actor: b.id, item: "chem", count: 2 })
    Object.assign(core.sim.slot(a.id)!.survivor, { x: bench.bench.x - 0.8, y: bench.bench.y - 0.4, aim: 0 })
    Object.assign(core.sim.slot(b.id)!.survivor, { x: bench.bench.x - 0.8, y: bench.bench.y + 0.4, aim: 0 })
    core.sim.rebuildSolids()
    run(core, [a, b], 2)
    const chems = ALL_PAIRS.findIndex(([x, y]) => pairKey(x, y) === "chem+chem")
    run(core, [b], 1, () => ({ ...idle(0), pick: { mode: "bench", index: chems } }))
    run(core, [b], 1, () => ({ ...idle(0), interact: true, interactHeld: true }))
    run(core, [b], Math.ceil(0.45 / TICK_DT), () => ({ ...idle(0), interactHeld: true }))
    run(core, [a, b], Math.ceil(3 / TICK_DT))
    expect(progression.learned("bandage")).toBe(true)
    const seat = core.sim.slot(b.id)!.index
    for (const c of [a, b]) {
      expect(c.ledger.count("team/known", "learned:bandage")).toBe(1)
      expect(c.ledger.count(matStoreId(bench.id), "bandage")).toBe(1)
      expect(readPin(c.ledger.store(pinStoreId("bandage")), "bandage")).toMatchObject({ actor: b.id, seat })
      expect(c.notices.filter((t) => /learned/i.test(t))).toEqual([])
    }
  })

  test("a dropped bundle reaches a teammate, and a seat that expires leaves its kit on the floor", () => {
    let now = 0
    const core = new CoopRoomCore("test", options, () => now, "test")
    const a = client(core, "Ann")
    const b = client(core, "Bob")
    run(core, [a, b], 3)
    const ledger = core.sim.progression.ledger
    const ann = core.sim.slot(a.id)!
    const bob = core.sim.slot(b.id)!
    Object.assign(ann.survivor, { x: 44, y: 44 })
    Object.assign(bob.survivor, { x: 44.6, y: 44 })
    run(core, [a, b], 1, (c) => (c === a ? { ...idle(0), bundle: true } : idle()))
    run(core, [a, b], 3)
    const drop = [...ledger.stores.keys()].find((k) => k.startsWith("drop:"))!
    expect(ledger.count(drop, "ammo")).toBe(6)
    expect(ledger.count(drop, "plank")).toBe(2)
    expect(b.ledger.count(drop, "ammo")).toBe(6)
    expect(core.sim.slot(b.id)!.prompt?.kind).toBe("drop")
    run(core, [a, b], 1, (c) => (c === b ? { ...idle(Math.PI), interact: true } : idle()))
    run(core, [a, b], 3)
    expect(ledger.store(drop)).toBeUndefined()
    expect(b.ledger.store(drop)).toBeUndefined()
    expect(ledger.count(`${b.id}/belt`, "ammo")).toBe(12)

    core.close(a.conn)
    now += 61_000
    run(core, [b], 3)
    expect(core.sim.slot(a.id)).toBeUndefined()
    const left = [...ledger.stores.keys()].find((k) => k.startsWith("drop:") && ledger.count(k, "pistol") > 0)!
    expect(ledger.count(left, "flashlight")).toBe(1)
    expect(b.ledger.count(left, "pistol")).toBe(1)
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

describe("Wire protocol encode/decode, interest management & delta against ack under packet loss", () => {
  test("round-trips binary client inputs, personal survivor states and delta shared snapshots", () => {
    const cmds: Command[] = [
      { mx: 0.75, my: -0.5, aim: 1.25, interact: true, sprint: true, fire: true },
      {
        mx: 0,
        my: 1,
        aim: -2.1,
        interact: false,
        hotbarSlot: 2,
        hotbarDelta: -1,
        interactAction: "search",
        pick: { mode: "craft", index: 1 },
      },
    ]
    const tuples = cmds.map(packCommand)
    const binIn = encodeClientIn(42, tuples, 120, 114)
    const decodedIn = decodeClient(binIn)!
    expect(decodedIn.t).toBe("in")
    if (decodedIn.t === "in") {
      expect(decodedIn.s).toBe(42)
      expect(decodedIn.a).toBe(120)
      expect(decodedIn.v).toBe(114)
      expect(decodedIn.c).toHaveLength(2)
      expect(decodedIn.c[0]![0]).toBeCloseTo(0.75, 3)
      expect(decodedIn.c[1]![4]).toBe(2)
      expect(decodedIn.c[1]![5]).toBe(-1)
      expect(decodedIn.c[1]![6]).toBeGreaterThan(0)
      expect(decodedIn.c[1]![7]).toBeGreaterThan(0)
    }

    const surv = createSurvivor(18.5, 42.25)
    surv.stamina = 64.5
    surv.battery = 0.82
    surv.fireCooldown = 0.22
    surv.reloadRemaining = 0.75
    surv.recoil = 0.4
    surv.noise = 8.5
    surv.peekingWindowId = "ash-south-west"
    surv.lootMessage = "Searched drawer"
    surv.lootMessageUntil = 12.5
    const persBytes = encodePersonal(77, surv, null, [{ text: "+4 9mm", kind: "result" }])
    const persDecoded = decodePersonal(persBytes)
    expect(persDecoded.ack).toBe(77)
    expect(persDecoded.survivor.x).toBeCloseTo(18.5, 4)
    expect(persDecoded.survivor.y).toBeCloseTo(42.25, 4)
    expect(persDecoded.survivor.stamina).toBeCloseTo(64.5, 3)
    expect(persDecoded.survivor.fireCooldown).toBeCloseTo(0.22, 3)
    expect(persDecoded.survivor.reloadRemaining).toBeCloseTo(0.75, 3)
    expect(persDecoded.survivor.recoil).toBeCloseTo(0.4, 3)
    expect(persDecoded.survivor.peekingWindowId).toBe("ash-south-west")
    expect(persDecoded.survivor.lootMessage).toBe("Searched drawer")
    expect(persDecoded.notices).toEqual([{ text: "+4 9mm", kind: "result" }])

    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 12 })
    const slot = sim.addSurvivor("p0", 0)
    const serverHist = new AckHistory<SharedSnapshot>(16)
    const clientHist = new AckHistory<SharedSnapshot>(16)
    const shooters = new Map<number, number>()

    const out1: { snap?: SharedSnapshot } = {}
    const snap1Bytes = encodeShared(sim, 3, shooters, undefined, {
      viewerCenter: { cx: 1, cy: 1 },
      snapIndex: 1,
      outSnapshot: out1,
    })
    serverHist.record(3, out1.snap!)
    const dec1 = decodeShared(snap1Bytes, 7, clientHist)
    expect(dec1.zombies).toEqual(out1.snap!.zombies)

    for (let i = 0; i < 3; i++) {
      sim.stepSurvivor(slot, { mx: 1, my: 0, aim: 0.5, interact: false, fire: i === 0 }, TICK_DT)
      sim.stepWorld(TICK_DT, 120)
    }
    const out2: { snap?: SharedSnapshot } = {}
    const snap2Bytes = encodeShared(sim, 6, shooters, undefined, {
      viewerCenter: { cx: 1, cy: 1 },
      baseSnap: serverHist.get(3),
      snapIndex: 2,
      outSnapshot: out2,
    })
    expect(snap2Bytes.byteLength).toBeLessThan(snap1Bytes.byteLength)
    const bd = inspectSnapshotBreakdown(
      new Uint8Array([4, 0, 0, 0, 1, 2, 3, 4, ...snap2Bytes]),
      clientHist,
    )
    expect(bd.portalsBytes).toBe(0)
    const dec2 = decodeShared(snap2Bytes, 7, clientHist)
    expect(dec2.zombies).toEqual(out2.snap!.zombies)
    expect(dec2.doors).toEqual(out2.snap!.doors)

    // Verify two clients with different acked baseSnap ticks (e.g. 3 vs 6) reconstruct identical zombies at tick 9
    for (let i = 0; i < 3; i++) {
      sim.stepSurvivor(slot, { mx: 0, my: 1, aim: 1.0, interact: false }, TICK_DT)
      sim.stepWorld(TICK_DT, 120)
    }
    serverHist.record(6, out2.snap!)
    const clientHistLag = new AckHistory<SharedSnapshot>(16)
    clientHistLag.record(3, dec1)
    const out3A: { snap?: SharedSnapshot } = {}
    const snap3From6 = encodeShared(sim, 9, shooters, undefined, {
      viewerCenter: { cx: 1, cy: 1 },
      baseSnap: serverHist.get(6),
      prevBubbleSnap: out2.snap,
      snapIndex: 3,
      outSnapshot: out3A,
    })
    const snap3From3 = encodeShared(sim, 9, shooters, undefined, {
      viewerCenter: { cx: 1, cy: 1 },
      baseSnap: serverHist.get(3),
      prevBubbleSnap: out2.snap,
      snapIndex: 3,
    })
    const dec3From6 = decodeShared(snap3From6, 7, clientHist)
    const dec3From3 = decodeShared(snap3From3, 7, clientHistLag)
    expect(dec3From3.zombies).toEqual(dec3From6.zombies)
  })

  test("per-recipient interest filter sends only zombies inside each survivor's 1 km-separated bubble", () => {
    let virtualMs = 0
    const core = new CoopRoomCore("spread", { ...DEFAULT_COOP_ROOM, zombieCount: 0 }, () => virtualMs, BUILD)
    const net = new Loopback(core, 2, 0)
    const sock = net.socketClass()
    const a = new NetSession({ url: "loop", room: "spread", name: "A", now: () => net.now, WebSocket: sock })
    const b = new NetSession({ url: "loop", room: "spread", name: "B", now: () => net.now, WebSocket: sock })
    for (let i = 0; i < 12; i++) {
      virtualMs = net.now * 1000
      net.step()
    }
    const slotA = core.sim.slot(a.id)!
    const slotB = core.sim.slot(b.id)!
    slotA.survivor.x = 27.7
    slotA.survivor.y = 41.0
    slotB.survivor.x = 987.7
    slotB.survivor.y = 41.0
    a.local.survivor.x = 27.7
    a.local.survivor.y = 41.0
    b.local.survivor.x = 987.7
    b.local.survivor.y = 41.0
    core.sim.syncWorldChunks()
    core.sim.ai.agents.length = 0
    for (let i = 0; i < 20; i++) {
      core.sim.ai.agents.push(createAIAgent(i + 1, 7, 30 + (i % 5) * 3, 40 + Math.floor(i / 5) * 3, 0))
    }
    for (let i = 0; i < 20; i++) {
      core.sim.ai.agents.push(createAIAgent(101 + i, 7, 990 + (i % 5) * 3, 40 + Math.floor(i / 5) * 3, 0))
    }
    for (let i = 0; i < 18; i++) {
      virtualMs = net.now * 1000
      net.step()
      a.update(TICK_DT, idle())
      b.update(TICK_DT, idle())
      a.sync(TICK_DT)
      b.sync(TICK_DT)
    }
    const zA = a.snapshots.latest!.zombies
    const zB = b.snapshots.latest!.zombies
    expect(zA.length).toBe(20)
    expect(zB.length).toBe(20)
    expect(zA.every((z) => z.id <= 20)).toBe(true)
    expect(zB.every((z) => z.id >= 101)).toBe(true)
    a.close()
    b.close()
  })

  test("delta compression against acked snapshot stays in sync under 5% packet loss and jitter", () => {
    let virtualMs = 0
    const core = new CoopRoomCore("lossy", { ...DEFAULT_COOP_ROOM, zombieCount: 40 }, () => virtualMs, BUILD)
    const net = new Loopback(core, 4, 3, 0.05)
    const sock = net.socketClass()
    const clients = [
      new NetSession({ url: "loop", room: "lossy", name: "P1", now: () => net.now, WebSocket: sock }),
      new NetSession({ url: "loop", room: "lossy", name: "P2", now: () => net.now, WebSocket: sock }),
    ]
    net.lossRate = 0
    for (let i = 0; i < 15; i++) {
      virtualMs = net.now * 1000
      net.step()
    }
    net.lossRate = 0.05
    const firstHalfCorr: number[] = []
    const secondHalfCorr: number[] = []
    for (let i = 0; i < 360; i++) {
      virtualMs = net.now * 1000
      net.step()
      clients.forEach((c, k) => {
        const beforeX = c.local.survivor.x
        const beforeY = c.local.survivor.y
        c.update(TICK_DT, {
          mx: i < 300 ? Math.cos(i / 35 + k) : 0,
          my: i < 300 ? Math.sin(i / 45 + k) : 0,
          aim: i / 25,
          interact: i === 60 && k === 0,
          sprint: i % 120 < 30,
          fire: i % 70 === 20 + k * 15,
        })
        c.sync(TICK_DT)
        const jump = Math.hypot(c.local.survivor.x - beforeX, c.local.survivor.y - beforeY)
        if (i < 180) firstHalfCorr.push(jump)
        else secondHalfCorr.push(jump)
      })
    }
    // Let link settle with 0% loss and verify exact convergence
    net.lossRate = 0
    for (let i = 0; i < 30; i++) {
      virtualMs = net.now * 1000
      net.step()
      for (const c of clients) {
        c.update(TICK_DT, idle(1.0))
        c.sync(TICK_DT)
      }
    }
    for (const c of clients) {
      const srv = core.sim.slot(c.id)!.survivor
      expect(Math.hypot(c.view.player.x - srv.x, c.view.player.y - srv.y)).toBeLessThan(0.01)
      expect(c.snapshots.latest!.zombies.length).toBe(core.sim.ai.agents.length)
      c.close()
    }
    const mean1 = firstHalfCorr.reduce((a, b) => a + b, 0) / firstHalfCorr.length
    const mean2 = secondHalfCorr.reduce((a, b) => a + b, 0) / secondHalfCorr.length
    expect(mean2).toBeLessThanOrEqual(mean1 + 0.02)
  })

  test("decodeShared reuses pooled ZombieState pages across the 72-snapshot ring without mutating active snapshots", () => {
    const sim = new CoopSim(7, 17, 0.25, { zombieCount: 16 })
    const slot = sim.addSurvivor("p0", 0)
    const serverHist = new AckHistory<SharedSnapshot>(32)
    const clientHist = new AckHistory<SharedSnapshot>(32)
    const shooters = new Map<number, number>()
    let prevBubbleSnap: SharedSnapshot | undefined

    let page0ListRef: SharedSnapshot["zombies"] | undefined
    let page0FirstZombieRef: SharedSnapshot["zombies"][number] | undefined
    let page0FirstZombieX = 0
    let page1FirstZombieRef: SharedSnapshot["zombies"][number] | undefined
    let page1FirstZombieX = 0

    for (let s = 1; s <= 73; s++) {
      const tick = s * 3
      sim.stepSurvivor(slot, { mx: Math.cos(s * 0.2), my: Math.sin(s * 0.2), aim: s * 0.1, interact: false }, TICK_DT)
      sim.stepWorld(TICK_DT, 120)
      const baseTick = s > 1 ? (s - 1) * 3 : 0
      const out: { snap?: SharedSnapshot } = {}
      const bytes = encodeShared(sim, tick, shooters, undefined, {
        viewerCenter: { cx: 1, cy: 1 },
        baseSnap: baseTick > 0 ? serverHist.get(baseTick) : undefined,
        prevBubbleSnap,
        snapIndex: s,
        outSnapshot: out,
      })
      prevBubbleSnap = out.snap
      serverHist.record(tick, out.snap!)
      const decoded = decodeShared(bytes, 7, clientHist)
      clientHist.record(tick, decoded)
      expect(decoded.zombies).toEqual(out.snap!.zombies)

      if (s === 1) {
        page0ListRef = decoded.zombies
        page0FirstZombieRef = decoded.zombies[0]
        page0FirstZombieX = decoded.zombies[0]!.x
      } else if (s === 2) {
        page1FirstZombieRef = decoded.zombies[0]
        page1FirstZombieX = decoded.zombies[0]!.x
        // Page 1 must not alias or mutate Page 0 while Page 0 is still in the active history window
        expect(page1FirstZombieRef).not.toBe(page0FirstZombieRef)
        expect(page0FirstZombieRef!.x).toBe(page0FirstZombieX)
      } else if (s === 73) {
        // After 72 snapshots, page 0 (long evicted from 32-entry AckHistory & SnapshotBuffer) is reused in place
        expect(decoded.zombies).toBe(page0ListRef!)
        expect(decoded.zombies[0]).toBe(page0FirstZombieRef!)
        // Page 1 has not yet wrapped around on snapshot 73
        expect(page1FirstZombieRef!.x).toBe(page1FirstZombieX)
      }
    }
  })
})
