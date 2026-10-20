import { expect } from "bun:test"
import { CoopRoomCore } from "../server/room-core"
import { BUILD } from "../shared/build.gen"
import { TICK_DT } from "../shared/clock"
import { DEFAULT_COOP_ROOM } from "../shared/coop-config"
import type { Command } from "../shared/session"
import { outbreakClientFeatures as features } from "../src/features"
import { NetSession, type KeyValueStore } from "../src/net-session"
import { Loopback } from "./loopback"

/** Real room, binary snapshots, prediction and feature reconciliation; only the WebSocket transport is replaced. */
export function featureRoom(seed = 7) {
  const core: CoopRoomCore = new CoopRoomCore("parity", { ...DEFAULT_COOP_ROOM, seed, houseSeed: seed, zombieCount: 0 }, () => net.now * 1000, BUILD)
  const net = new Loopback(core, 1)
  const Socket = net.socketClass()
  const clients: NetSession[] = []
  const reloads: string[] = []
  const stores: KeyValueStore[] = []
  const join = (storage?: KeyValueStore) => {
    const values = new Map<string, string>()
    storage ??= { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => { values.set(k, v) } }
    stores.push(storage)
    const client = new NetSession({ features, url: "loop", room: "parity", name: `Peer ${clients.length}`, storage,
      now: () => net.now, WebSocket: Socket, onReload: (reason) => { reloads.push(reason ?? "build") } })
    clients.push(client)
    return client
  }
  const tick = (n = 1, commands: Partial<Command>[] = []) => {
    for (let i = 0; i < n; i++) {
      net.step()
      if (core.phase === "lobby") core.start()
      for (const [j, c] of clients.entries()) {
        c.update(TICK_DT, { mx: 0, my: 0, aim: c.local.survivor.aim, interact: false, ...commands[j] })
        c.sync(TICK_DT)
      }
    }
  }
  // Drain transport without advancing the world: compare discrete presentation inputs at precisely one room tick.
  const flush = () => {
    net.tick += 4
    net.deliver()
    core.snapshot(net.connections)
    net.tick += 4
    net.deliver()
    for (const c of clients) c.sync(TICK_DT)
  }
  const place = (c: NetSession, x: number, y: number, aim = 0) => {
    Object.assign(core.sim.slot(c.id)!.survivor, { x, y, aim })
    core.sim.rebuildSolids()
    tick(12, clients.map((p) => p === c ? { aim } : {}))
  }
  const hold = (c: NetSession, item: string, count = 1) => {
    const p = core.sim.progression
    if (count) expect(p.ledger.apply({ kind: "grant", actor: c.id, item, count }).ok).toBe(true)
    const i = p.hotbar(c.id)!.slots.findIndex((s) => s?.item === item)
    expect(i).toBeGreaterThanOrEqual(0)
    p.ledger.apply({ kind: "select", actor: c.id, slot: i })
    p.project(core.sim.slot(c.id)!)
    tick(12)
  }
  const act = (c: NetSession, cmd: Partial<Command>, n = 1) => tick(n, clients.map((p) => p === c ? cmd : {}))
  const ledgerParity = (prefixes: readonly string[]) => {
    flush()
    const project = (c: typeof core.sim) => [...c.progression.ledger.stores.values()]
      .filter((s) => prefixes.some((p) => s.id.startsWith(p)))
      .map((s) => ({ id: s.id, counts: s.counts, at: s.at, revealed: s.revealed, slots: s.revealed ? s.slots : [] }))
      .sort((a, b) => a.id.localeCompare(b.id))
    const want = project(core.sim)
    expect(want.length).toBeGreaterThan(0)
    for (const c of clients) expect(project(c.sim)).toEqual(want)
  }
  const a = join()
  const b = join()
  tick(24)
  expect(a.connected && b.connected).toBe(true)
  expect(a.isHost).toBe(true)
  return { core, net, clients, a, b, join, tick, flush, place, hold, act, ledgerParity, reloads, stores,
    close: () => { for (const c of clients) c.close() } }
}
