import { describe, expect, test } from "bun:test"
import { TICK_DT } from "../shared/clock"
import { CoopSim, type SurvivorSlot } from "../shared/coop-sim"
import { BURN_RING, burning, burnZombie, crackerAt, DEFAULT_FIRE_TUNING, FIRE_RING, fireLit, ringId, SCORCH_RING, type FireTuning } from "../shared/fire/fire"
import { inStream } from "../shared/fire/runtime"
import { CoopRoomCore, type Conn } from "../server/room-core"
import { DEFAULT_COOP_ROOM } from "../shared/coop-config"
import { decodeServerText, decodeSnapshot, packCommand } from "../shared/net-protocol"
import { OutbreakProgression, type Ledger } from "../shared/progression"
import { RECIPES } from "../shared/progression/catalog"
import { BACK_ROOM_FLAMETHROWER, backRoomFire, lootSites, RARE_LOOT } from "../shared/progression/loot"
import { DEFAULT_PROGRESSION_TUNING } from "../shared/progression/tuning"
import type { Command } from "../shared/session"
import { makeTown } from "../shared/map"

type Pose = { x: number; y: number; aim: number }

const idle = (aim = 0): Command => ({ mx: 0, my: 0, aim, interact: false })
const ticks = (seconds: number) => Math.ceil(seconds / TICK_DT)

function room(poses: Record<string, Pose>, tuning: Partial<FireTuning> = {}) {
  const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
  sim.hour = 22
  for (const [i, [id, pose]] of Object.entries(poses).entries()) Object.assign(sim.addSurvivor(id, i).survivor, pose)
  sim.rebuildSolids()
  const settings = { fire: { ...DEFAULT_FIRE_TUNING, ...tuning } } as never
  const tick = (cmds: Partial<Record<string, Partial<Command>>> = {}, n = 1) => {
    for (let k = 0; k < n; k++) {
      for (const s of sim.slots) sim.stepSurvivor(s, { ...idle(s.survivor.aim), ...cmds[s.id] }, TICK_DT, settings)
      sim.stepWorld(TICK_DT, 0, settings)
    }
  }
  const heard: { kind: string; radius: number; x: number; y: number }[] = []
  const emit = sim.ai.emitNoise.bind(sim.ai)
  sim.ai.emitNoise = (x, y, radius, kind, ...rest) => {
    heard.push({ kind, radius, x, y })
    return emit(x, y, radius, kind, ...rest)
  }
  const ledger = sim.progression.ledger
  const hold = (slot: SurvivorSlot, item: string, count = 1) => {
    if (count) ledger.apply({ kind: "grant", actor: slot.id, item, count })
    const i = sim.progression.hotbar(slot.id)?.slots.findIndex((s) => s?.item === item) ?? -1
    if (i >= 0) ledger.apply({ kind: "select", actor: slot.id, slot: i })
    sim.progression.project(slot)
  }
  const zombie = (x: number, y: number) => {
    const z = sim.ai.spawnZombie(sim.town, x, y, "wander")
    z.speedScale = 0
    return z
  }
  const stores = (prefix: string) => [...ledger.stores.values()].filter((s) => s.id.startsWith(`${prefix}:`))
  return { sim, tick, ledger, slot: (id: string) => sim.slot(id)!, hold, zombie, stores, noises: (kind: string) => heard.filter((e) => e.kind === kind) }
}

const fuelOf = (sim: CoopSim, id: string) => sim.progression.selected(id)?.charge ?? -1

describe("flamethrower", () => {
  test("holding the button sprays: the dead in the cone catch fire and burn down to charred bodies", () => {
    const { sim, tick, hold, zombie, slot, ledger, noises } = room({ ann: { x: 30, y: 46, aim: 0 } })
    hold(slot("ann"), "flamethrower")
    const near = zombie(33, 46)
    const wide = zombie(33, 49.5)
    tick({ ann: { fire: true, fireHeld: true } })
    tick({ ann: { fireHeld: true } }, 5)
    expect(ledger.store("flamer:ann")?.counts.on).toBe(1)
    const burns = [...Array(BURN_RING).keys()].map((k) => ledger.store(ringId("burn", k))).filter((s) => s && burning(s, sim.time))
    expect(burns.map((s) => burnZombie(s!))).toContain(near.id)
    expect(burns.map((s) => burnZombie(s!))).not.toContain(wide.id)
    tick({ ann: { fireHeld: true } }, ticks(0.6))
    expect(noises("flamethrower").length).toBeGreaterThan(0)
    tick({}, 2)
    expect(ledger.store("flamer:ann")?.counts.on).toBeUndefined()
    // Off the trigger it keeps burning, and falls charred.
    tick({}, ticks(DEFAULT_FIRE_TUNING.burnSeconds))
    expect(near.state).toBe("dead")
    const st = [...Array(BURN_RING).keys()].map((k) => ledger.store(ringId("burn", k))).find((s) => s && burnZombie(s) === near.id)!
    expect(st.counts.dead).toBeGreaterThan(0)
  })

  test("fuel drains fast while spraying and a gas can refills it; empty and without a can it will not spray", () => {
    const { sim, tick, hold, slot, ledger } = room({ ann: { x: 30, y: 46, aim: 0 } }, { flameFuelSeconds: 2 })
    hold(slot("ann"), "flamethrower")
    expect(fuelOf(sim, "ann")).toBe(100)
    tick({ ann: { fireHeld: true } }, ticks(1))
    expect(fuelOf(sim, "ann")).toBeGreaterThan(40)
    expect(fuelOf(sim, "ann")).toBeLessThan(60)
    tick({ ann: { fireHeld: true } }, ticks(1.2))
    expect(fuelOf(sim, "ann")).toBe(0)
    tick({ ann: { fireHeld: true } }, 3)
    expect(ledger.store("flamer:ann")?.counts.on).toBeUndefined()
    ledger.apply({ kind: "grant", actor: "ann", item: "fuel", count: 1 })
    tick({ ann: { reload: true } })
    expect(fuelOf(sim, "ann")).toBe(100)
    expect(ledger.count("ann", "fuel")).toBe(0)
  })

  test("friendly fire: a teammate in the stream is burnt, one beside it is not", () => {
    const { tick, hold, slot } = room({ ann: { x: 30, y: 46, aim: 0 }, bo: { x: 33, y: 46, aim: 0 }, cy: { x: 30, y: 49, aim: 0 } })
    hold(slot("ann"), "flamethrower")
    tick({ ann: { fireHeld: true } }, ticks(1))
    expect(slot("bo").survivor.health).toBeLessThan(90)
    expect(slot("cy").survivor.health).toBe(100)
  })

  test("the cone test: in front within reach and angle, never behind or wide", () => {
    const p = { x: 0, y: 0, aim: 0 }
    expect(inStream(p, 4, 0, 6.5, 16, 0)).toBe(true)
    expect(inStream(p, 4, 0.9, 6.5, 16, 0)).toBe(true)
    expect(inStream(p, 4, 2, 6.5, 16, 0)).toBe(false)
    expect(inStream(p, -1, 0, 6.5, 16, 0)).toBe(false)
    expect(inStream(p, 8, 0, 6.5, 16, 0)).toBe(false)
  })

  test("spraying leaves short-lived fire and scorch on the ground, never more than the rings hold", () => {
    const { sim, tick, hold, slot, ledger, stores } = room({ ann: { x: 30, y: 46, aim: 0 } }, { flameFuelSeconds: 60, groundFireSeconds: 5 })
    hold(slot("ann"), "flamethrower")
    tick({ ann: { fireHeld: true } }, ticks(30))
    expect(stores("fire").length).toBe(FIRE_RING)
    expect(stores("scorch").length).toBe(SCORCH_RING)
    tick({}, ticks(5.5))
    expect(stores("fire").filter((s) => fireLit(s, sim.time)).length).toBe(0)
    // Never deleted, so the ledger does not grow a removal list.
    expect(ledger.snapshot().removedStores ?? []).toHaveLength(0)
  })
})

describe("burning", () => {
  test("a burning zombie sets the one it brushes against alight; one standing clear does not catch", () => {
    const { sim, tick, zombie, ledger } = room({ ann: { x: 10, y: 10, aim: 0 } }, { burnSpreadRate: 50 })
    const a = zombie(40, 60)
    const b = zombie(40.5, 60)
    const c = zombie(44, 60)
    const fire = sim.getFeatureState<{ tuning: FireTuning }>("fire")!
    fire.tuning = { ...DEFAULT_FIRE_TUNING, burnSpreadRate: 50 }
    const { ignite } = require("../shared/fire/runtime") as typeof import("../shared/fire/runtime")
    ignite(sim, a, "ann", fire.tuning)
    tick({}, ticks(0.3))
    const on = [...Array(BURN_RING).keys()].map((k) => ledger.store(ringId("burn", k))).filter((s) => s && burning(s, sim.time)).map((s) => burnZombie(s!))
    expect(on).toContain(a.id)
    expect(on).toContain(b.id)
    expect(on).not.toContain(c.id)
  })

  test("no more than the ring can burn at once", () => {
    const { sim, zombie, ledger } = room({ ann: { x: 10, y: 10, aim: 0 } })
    const { ignite } = require("../shared/fire/runtime") as typeof import("../shared/fire/runtime")
    const lit = Array.from({ length: BURN_RING + 6 }, (_, i) => ignite(sim, zombie(40 + (i % 8) * 2, 60 + Math.floor(i / 8) * 2), "ann", DEFAULT_FIRE_TUNING))
    expect(lit.filter(Boolean).length).toBe(BURN_RING)
    expect([...ledger.stores.keys()].filter((id) => id.startsWith("burn:")).length).toBe(BURN_RING)
  })

  test("fire on the ground only spreads when the Lab asks for it", () => {
    for (const spread of [0, 2]) {
      const { sim, tick, stores } = room({ ann: { x: 10, y: 10, aim: 0 } }, { fireSpread: spread })
      const { placeFire } = require("../shared/fire/runtime") as typeof import("../shared/fire/runtime")
      placeFire(sim, 36, 46, 1, 4, 1, "ann")
      tick({}, ticks(3))
      const lit = stores("fire").filter((s) => fireLit(s, sim.time)).length
      if (spread === 0) expect(lit).toBe(1)
      else expect(lit).toBeGreaterThan(1)
    }
  })
})

describe("dynamite", () => {
  test("lit fuse, then a blast: near dead killed, farther ones thrown down, none past the radius; a crater and a town-wide bang", () => {
    const { sim, tick, hold, zombie, slot, stores, noises } = room({ ann: { x: 30, y: 46, aim: 0 } }, { dynThrow: 8, dynFuse: 1 })
    hold(slot("ann"), "dynamite", 2)
    const centre = zombie(38.5, 46)
    const edge = zombie(38, 49.6)
    const far = zombie(38, 53)
    tick({ ann: { fire: true } })
    expect(sim.progression.ledger.count("ann", "dynamite")).toBe(1)
    expect(stores("dyn").length).toBe(1)
    expect(centre.state).not.toBe("dead")
    tick({}, ticks(1.1))
    expect(centre.state).toBe("dead")
    expect(edge.state === "knockdown" || edge.state === "dead").toBe(true)
    expect(far.state).not.toBe("dead")
    expect(far.state).not.toBe("knockdown")
    expect(noises("explosion")[0]?.radius).toBe(DEFAULT_FIRE_TUNING.dynNoise)
    expect(stores("scorch").some((s) => s.counts.crater)).toBe(true)
    expect(stores("dyn")[0]!.counts.done).toBe(1)
  })

  test("the blast tears the planks off a boarded door and blows a shut door in", () => {
    const { sim, tick, hold, slot } = room({ ann: { x: 0, y: 0, aim: 0 } }, { dynFuse: 0.5 })
    const door = sim.town.doors.find((d) => !d.open)!
    const pst = sim.ai.portalStates.get(door.id)!
    sim.ai.addBarricadePlank(door.id)
    sim.ai.addBarricadePlank(door.id)
    const cx = (door.rect[0] + door.rect[2]) / 2
    const cy = (door.rect[1] + door.rect[3]) / 2
    const { explode } = require("../shared/fire/runtime") as typeof import("../shared/fire/runtime")
    expect(explode(sim, cx, cy + 1.5, "ann", DEFAULT_FIRE_TUNING)).toBe(true)
    expect(pst.barricadePlanks).toBe(0)
    explode(sim, cx, cy + 1.5, "ann", DEFAULT_FIRE_TUNING)
    explode(sim, cx, cy + 1.5, "ann", DEFAULT_FIRE_TUNING)
    expect(door.open).toBe(true)
    void tick
    void hold
    void slot
  })
})

describe("firecrackers, molotovs, flare gun, bear trap", () => {
  test("firecrackers pop in bursts that move along the ground, dragging the dead after them", () => {
    const { sim, tick, hold, slot, stores, noises } = room({ ann: { x: 30, y: 46, aim: 0 } }, { crackSeconds: 4, crackTravel: 5 })
    hold(slot("ann"), "firecrackers")
    tick({ ann: { fire: true } })
    const st = stores("crack")[0]!
    const start = crackerAt(st, sim.time)
    tick({}, ticks(4))
    const pops = noises("firecracker")
    expect(pops.length).toBeGreaterThan(5)
    expect(Math.hypot(pops.at(-1)!.x - start.x, pops.at(-1)!.y - start.y)).toBeGreaterThan(2.5)
    expect(fireLit(st, sim.time)).toBe(false)
  })

  test("a molotov bursts into a pool of fire that sets alight whatever walks through it", () => {
    const { sim, tick, hold, slot, zombie, stores, ledger } = room({ ann: { x: 30, y: 46, aim: 0 } }, { molotovThrow: 6 })
    hold(slot("ann"), "molotov")
    tick({ ann: { fire: true } })
    const pool = stores("fire").find((s) => s.counts.src === 1)!
    expect(pool).toBeTruthy()
    const z = zombie(pool.at!.x + 0.5, pool.at!.y)
    tick({}, 2)
    const on = [...Array(BURN_RING).keys()].map((k) => ledger.store(ringId("burn", k))).filter((s) => s && burning(s, sim.time)).map((s) => burnZombie(s!))
    expect(on).toContain(z.id)
  })

  test("the flare gun sets the first of the dead it hits alight and leaves a burning flare; after three it is gone", () => {
    const { sim, tick, hold, slot, zombie, ledger } = room({ ann: { x: 30, y: 46, aim: 0 } })
    hold(slot("ann"), "flare-gun")
    const z = zombie(38, 46)
    tick({ ann: { fire: true } })
    expect([...ledger.stores.values()].some((s) => s.id.startsWith("flare:") && s.counts.gun)).toBe(true)
    const on = [...Array(BURN_RING).keys()].map((k) => ledger.store(ringId("burn", k))).filter((s) => s && burning(s, sim.time)).map((s) => burnZombie(s!))
    expect(on).toContain(z.id)
    tick({ ann: { fire: true } })
    tick({ ann: { fire: true } })
    expect(ledger.count("ann", "flare-gun")).toBe(0)
  })

  test("a bear trap snaps on the first of the dead to step in and holds it", () => {
    const { sim, tick, hold, slot, zombie, stores } = room({ ann: { x: 30, y: 46, aim: 0 } }, { trapHold: 2 })
    hold(slot("ann"), "bear-trap")
    tick({ ann: { fire: true } })
    const trap = stores("trap")[0]!
    const z = zombie(trap.at!.x + 0.2, trap.at!.y)
    z.speedScale = 1
    tick({}, 2)
    expect(trap.counts.snap).toBeGreaterThan(0)
    expect(z.hp).toBeLessThan(z.maxHp)
    z.x += 3
    tick({}, 1)
    expect(Math.hypot(z.x - trap.at!.x, z.y - trap.at!.y)).toBeLessThan(0.01)
    void sim
  })
})

describe("loot and recipes", () => {
  test("rare loot is deterministic from the town seed, and rare", () => {
    const town = makeTown(11, 11, 0.22)
    const a = lootSites(town, DEFAULT_PROGRESSION_TUNING).stores.map((s) => JSON.stringify(s.initial))
    const b = lootSites(makeTown(11, 11, 0.22), DEFAULT_PROGRESSION_TUNING).stores.map((s) => JSON.stringify(s.initial))
    expect(a).toEqual(b)
    for (const table of Object.values(RARE_LOOT))
      for (const rolls of Object.values(table)) for (const r of rolls ?? []) expect(r.chance).toBeLessThanOrEqual(r.item === "fuel" ? 0.35 : 0.15)
    // The flamethrower itself: rarest of all on shelves, and in the hardware back room in most towns, not all.
    let withFlamer = 0
    for (let seed = 1; seed <= 200; seed++) if (backRoomFire({ seed }, "hardware").includes("flamethrower")) withFlamer++
    expect(withFlamer / 200).toBeGreaterThan(BACK_ROOM_FLAMETHROWER - 0.12)
    expect(withFlamer / 200).toBeLessThan(BACK_ROOM_FLAMETHROWER + 0.12)
  })

  test("the hardware store's back room holds a pressure tank", () => {
    const town = makeTown(7, 7, 0.22)
    const { stores } = lootSites(town, DEFAULT_PROGRESSION_TUNING)
    const items = stores.flatMap((s) => (s.initial as unknown as { item: string }[]).map((x) => x.item))
    expect(items).toContain("pressure-tank")
  })

  test("the molotov fills in from a bottle and chem; the flamethrower waits on a pressure tank at the bench and uses it up", () => {
    const { sim, ledger, slot } = room({ ann: { x: 30, y: 46, aim: 0 } })
    const progression = sim.progression
    ledger.apply({ kind: "grant", actor: "ann", item: "bottle", count: 1 })
    ledger.apply({ kind: "grant", actor: "ann", item: "chem", count: 1 })
    progression.board.fillIn()
    expect(progression.learned("molotov")).toBe(true)
    expect(RECIPES.find((r) => r.id === "flamethrower")!.part).toBe("pressure-tank")
    ledger.apply({ kind: "grant", actor: "ann", item: "fuel", count: 1 })
    ledger.apply({ kind: "grant", actor: "ann", item: "scrap", count: 3 })
    progression.board.fillIn()
    expect(progression.learned("flamethrower")).toBe(false)
    const bench = progression.benches[0]!
    ledger.apply({ kind: "grant", actor: "ann", item: "pressure-tank", count: 1 })
    expect(progression.install(slot("ann"), bench.id)).toBe(true)
    progression.board.fillIn()
    expect(progression.learned("flamethrower")).toBe(true)
    const res = ledger.apply({ kind: "run", actor: "ann", rule: "craft:flamethrower", station: bench.id }, { light: 1 })
    expect(res.ok).toBe(true)
    expect(ledger.count("ann", "flamethrower")).toBe(1)
    expect(ledger.count(bench.id, "pressure-tank")).toBe(0)
  })
})

describe("co-op", () => {
  test("a seat's spray, the burning it starts and the black it leaves reach the other seat through its snapshots", () => {
    const core = new CoopRoomCore("test", { ...DEFAULT_COOP_ROOM, zombieCount: 0 }, Date.now, "test")
    const mirrors = new Map<string, Ledger>()
    const ids: string[] = []
    const conns = ["Ann", "Bob"].map((name) => {
      const mirror = new OutbreakProgression(core.sim.town).ledger
      const conn: Conn = {
        send(data) {
          if (typeof data === "string") {
            const m = decodeServerText(data)!
            if (m.t === "welcome") {
              ids.push(m.id)
              mirrors.set(m.id, mirror)
            }
          } else {
            const snap = decodeSnapshot(data, 7)
            if (snap.personal.ledger) mirror.applyDelta(snap.personal.ledger)
          }
        },
        close() {},
      }
      core.open(conn)
      core.message(conn, JSON.stringify({ t: "hello", name, build: "test" }))
      return conn
    })
    core.start()
    let seq = 0
    const step = (n: number, ann: Partial<Command> = {}) => {
      for (let i = 0; i < n; i++) {
        conns.forEach((c, k) => core.message(c, JSON.stringify({ t: "in", s: seq, c: [packCommand({ ...idle(0), ...(k === 0 ? ann : {}) })] })))
        seq++
        core.step()
      }
    }
    step(3)
    const [ann, bob] = ids as [string, string]
    const sim = core.sim
    Object.assign(sim.slot(ann)!.survivor, { x: 30, y: 46, aim: 0 })
    Object.assign(sim.slot(bob)!.survivor, { x: 28, y: 43, aim: 0 })
    sim.rebuildSolids()
    const ledger = sim.progression.ledger
    ledger.apply({ kind: "grant", actor: ann, item: "flamethrower" })
    const i = sim.progression.hotbar(ann)!.slots.findIndex((s) => s?.item === "flamethrower")
    ledger.apply({ kind: "select", actor: ann, slot: i })
    const z = sim.ai.spawnZombie(sim.town, 33, 46, "wander")
    z.speedScale = 0
    step(1, { fire: true, fireHeld: true })
    step(30, { fireHeld: true })
    const seen = mirrors.get(bob)!
    expect(seen.store(`flamer:${ann}`)?.counts.on).toBe(1)
    const burnsOnBob = [...seen.stores.values()].filter((s) => s.id.startsWith("burn:") && burning(s, sim.time)).map((s) => burnZombie(s))
    expect(burnsOnBob).toContain(z.id)
    expect([...seen.stores.keys()].some((id) => id.startsWith("scorch:"))).toBe(true)
    step(4)
    expect(seen.store(`flamer:${ann}`)?.counts.on).toBeUndefined()
    // What Bob's mirror holds of the fire is exactly what the room has.
    for (const st of ledger.stores.values()) {
      if (!/^(fire|burn|scorch|flamer):/.test(st.id)) continue
      expect(seen.store(st.id)?.counts).toEqual(st.counts)
      expect(seen.store(st.id)?.at).toEqual(st.at)
    }
  })
})
