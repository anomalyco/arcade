import { describe, expect, test } from "bun:test"
import { CoopRoomCore } from "../server/room-core"
import { crowdHearingReach } from "../shared/ai"
import { BUILD } from "../shared/build.gen"
import { TICK_DT } from "../shared/clock"
import { DEFAULT_COOP_ROOM } from "../shared/coop-config"
import { CoopSim } from "../shared/coop-sim"
import { decodeShared, encodeShared, type SharedSnapshot } from "../shared/net-protocol"
import { SEC_NOISES } from "../shared/noises/net"
import { AckHistory } from "@arcade/kit/net/interest"
import { dogSites } from "../shared/dogs/dogs"
import { radioState, radioStoreId } from "../shared/radios/radios"
import type { Command } from "../shared/session"
import { outbreakClientFeatures as features } from "../src/features"
import { NetSession } from "../src/net-session"
import { SoundCueModel, type NoiseLike } from "../src/sound-cues/model"
import { Loopback } from "./loopback"

/** Positions go over the wire in centimetres. */
const cm = (v: number) => Math.round(v * 100) / 100
const idle = (aim = 0): Command => ({ mx: 0, my: 0, aim, interact: false })
/** In front of Ash's living-room radio, facing it (tests/radios.test.ts). */
const BEFORE_ASH = { x: 24.5, y: 34.5, aim: -Math.PI / 2 }

type Seen = { kind: string; label: string; source: string; x: number; y: number; reach: number }

/** One peer's cue model, fed the way the overlay feeds it: its sim's noise bus, its own id, its teammates' ids. */
function cueWatcher(sim: () => CoopSim, selfId: () => string) {
  const model = new SoundCueModel()
  const seen = new Map<number, Seen>()
  return {
    seen,
    observe() {
      const s = sim()
      const allies = new Set(s.slots.map((sl) => sl.id).filter((id) => id !== selfId()))
      const k = crowdHearingReach(s.ai.config, s.ai.threat)
      model.observe(s.ai.noiseBus.events as readonly NoiseLike[], selfId(), allies, s.time, (n) => ({ reach: n.radius * k, outside: null }))
      for (const c of model.cues) {
        if (!seen.has(c.id)) seen.set(c.id, { kind: c.kind, label: c.label, source: c.source, x: cm(c.x), y: cm(c.y), reach: Number(c.reach.toFixed(1)) })
      }
    },
  }
}

describe("noises on the wire", () => {
  test("each new noise once, footsteps never, nothing from out of earshot, and nothing at all on a quiet delta", () => {
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    const ann = sim.addSurvivor("ann", 0)
    Object.assign(ann.survivor, { x: 40, y: 40 })
    const serverHist = new AckHistory<SharedSnapshot>(16)
    const clientHist = new AckHistory<SharedSnapshot>(16)
    const send = (tick: number, base?: number) => {
      const out: { snap?: SharedSnapshot } = {}
      const bytes = encodeShared(sim, tick, new Map(), undefined, {
        viewerCenter: { cx: 1, cy: 1 },
        ...(base !== undefined ? { baseSnap: serverHist.get(base) } : {}),
        snapIndex: tick,
        outSnapshot: out,
      })
      serverHist.record(tick, out.snap!)
      return decodeShared(bytes, 7, clientHist)
    }
    sim.ai.emitNoise(41.234, 39.5, 34, "gunshot", sim.time, "ann", 2.2)
    sim.ai.emitNoise(40, 40, 5, "footstep", sim.time, "ann")
    sim.ai.emitNoise(1040, 40, 34, "gunshot", sim.time, "zombie-9")
    sim.ai.emitNoise(30, 52, 18, "bark", sim.time, "dog:elm")
    const first = send(3)
    expect(first.noises?.events.map((n) => [n.id, n.kind, n.x, n.y, n.radius, n.seat, n.sourceId])).toEqual([
      [1, "gunshot", 41.23, 39.5, 34, 0, ""],
      [4, "bark", 30, 52, 18, -1, "dog:elm"],
    ])
    expect(first.noises?.events[0]!.loudness).toBe(2.2)
    // Nothing new: the delta leaves the section out.
    const quiet = send(6, 3)
    expect(quiet.noises).toBeUndefined()
    sim.ai.emitNoise(42, 40, 20, "radio", sim.time, "radio", 1.6)
    expect(send(9, 3).noises?.events.map((n) => n.kind)).toEqual(["radio"])
    expect(SEC_NOISES).toBe(512)
  })
})

describe("co-op sound cues", () => {
  test("a remote gunshot, a barking dog and a playing radio give every client the room's cues", () => {
    let virtualMs = 0
    const core = new CoopRoomCore("cues", { ...DEFAULT_COOP_ROOM, zombieCount: 0 }, () => virtualMs, BUILD)
    const net = new Loopback(core, 3)
    const ann = new NetSession({ features, url: "loop", room: "cues", name: "Ann", now: () => net.now, WebSocket: net.socketClass() })
    const bob = new NetSession({ features, url: "loop", room: "cues", name: "Bob", now: () => net.now, WebSocket: net.socketClass() })
    const room = { ann: cueWatcher(() => core.sim, () => ann.id), bob: cueWatcher(() => core.sim, () => bob.id) }
    const peers = { ann: cueWatcher(() => ann.sim, () => ann.id), bob: cueWatcher(() => bob.sim, () => bob.id) }
    const tick = (n: number, annCmd: (i: number) => Command = () => idle(ann.local.survivor.aim)) => {
      for (let i = 0; i < n; i++) {
        virtualMs = net.now * 1000
        net.step()
        if (core.phase === "lobby") core.start()
        room.ann.observe()
        room.bob.observe()
        ann.update(TICK_DT, annCmd(i))
        bob.update(TICK_DT, idle(bob.local.survivor.aim))
        ann.sync(TICK_DT)
        bob.sync(TICK_DT)
        peers.ann.observe()
        peers.bob.observe()
      }
    }
    tick(30)
    expect(ann.connected && bob.connected).toBe(true)
    // Ann (the room's host, seat 0) stands at Ash's radio; Bob walks up to Elm's chained dog.
    const sa = core.sim.slot(ann.id)!
    const sb = core.sim.slot(bob.id)!
    expect(ann.hostId).toBe(ann.id)
    const dog = dogSites(core.sim.town).find((d) => d.buildingId === "elm")!
    Object.assign(sa.survivor, BEFORE_ASH)
    Object.assign(sb.survivor, { x: dog.x + dog.chain + 0.6, y: dog.y + 0.4, aim: Math.PI })
    core.sim.rebuildSolids()
    tick(20)
    // Ann fires, then switches the radio on.
    tick(10, (i) => ({ ...idle(BEFORE_ASH.aim), fire: i === 0 }))
    tick(20, (i) => ({ ...idle(BEFORE_ASH.aim), interact: i === 0 }))
    expect(radioState(core.sim.progression.ledger.store(radioStoreId("ash")), core.sim.time)).toBe("playing")
    tick(240)

    const kinds = (w: { seen: Map<number, Seen> }) => new Set([...w.seen.values()].map((c) => c.kind))
    for (const k of ["gunshot", "bark", "radio"]) expect(kinds(room.ann).has(k)).toBe(true)
    for (const [name, roomView, client] of [
      ["ann", room.ann, peers.ann],
      ["bob", room.bob, peers.bob],
    ] as const) {
      const want = [...roomView.seen.entries()].sort((a, b) => a[0] - b[0])
      const got = [...client.seen.entries()].sort((a, b) => a[0] - b[0])
      expect({ name, cues: got }).toEqual({ name, cues: want })
    }
    // The shot is Ann's: her own on her screen, a teammate's on Bob's.
    const shot = [...peers.bob.seen.values()].find((c) => c.kind === "gunshot")!
    expect(shot.source).toBe("ally")
    expect([...peers.ann.seen.values()].find((c) => c.kind === "gunshot")!.source).toBe("self")
    ann.close()
    bob.close()
  })
})
