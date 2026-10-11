import { expect, test } from "bun:test"
import { BIOMES, UNIT_BODY, WORLD_H, WORLD_W, carveCircle, embedded, fillRect, findIslands, generateBattle, isSolid, packMask, spawnY, supported, surfaceY, unpackMask, type Mask } from "../src/sim/terrain"
import { runVolley } from "../src/sim/volley"
import { replayTerrain } from "../src/sim/replay"
import { predictPath } from "../src/sim/predict"
import { moveUnit } from "../src/sim/move"
import { Match } from "../src/sim/match"
import { CLASSES, CLASS_IDS } from "../src/sim/classes"
import { SHOP, applyPurchase, newLoadout } from "../src/sim/shop"
import { planBot } from "../src/sim/bot"
import { WEAPONS, WEAPON_IDS, type WeaponId } from "../src/sim/weapons"
import type { ClassId, Crate, Shot, SimEvent, Unit } from "../src/sim/protocol"

function makeUnits(mask: Mask, xs: number[], cls: ClassId = "howitzer"): Unit[] {
  const ammo = Object.fromEntries(WEAPON_IDS.map((id) => [id, 5])) as Record<WeaponId, number>
  return xs.map((x, i) => ({ id: i, team: i, name: `u${i}`, cls, x, y: spawnY(mask, x), hp: 100, maxHp: 100, alive: true, kills: 0, ammo: { ...ammo }, shield: 0, boost: 0, fuel: 100, angle: 1 }))
}

function setup(seed: number, count = 4, weapons: WeaponId[] = WEAPON_IDS) {
  const bf = generateBattle(seed, count)
  const units = makeUnits(bf.mask, bf.spawns)
  const shots: Shot[] = units.map((u, i) => ({ unit: u.id, weapon: weapons[(i + seed) % weapons.length]!, angle: u.x < WORLD_W / 2 ? 0.75 + (seed % 5) * 0.08 : Math.PI - 0.75 - (seed % 3) * 0.08, power: 50 + ((i * 13 + seed) % 40) }))
  return { mask: bf.mask, units, shots }
}

test("terrain is seeded, procedural and varied across biomes", () => {
  const a = generateBattle(7, 4)
  const b = generateBattle(7, 4)
  const c = generateBattle(8, 4)
  expect(packMask(a.mask)).toBe(packMask(b.mask))
  expect(packMask(a.mask)).not.toBe(packMask(c.mask))
  for (const biome of BIOMES) {
    for (let seed = 1; seed <= 4; seed++) {
      const bf = generateBattle(seed * 101, 8, biome)
      expect(findIslands(bf.mask).length).toBe(0)
      expect(bf.spawns.length).toBe(8)
      for (const x of bf.spawns) {
        const y = spawnY(bf.mask, x)
        expect(y).toBeLessThan(WORLD_H - 40)
        expect(embedded(bf.mask, x, y)).toBe(false)
        expect(supported(bf.mask, x, y)).toBe(true)
      }
    }
  }
})

test("carving removes terrain and pack round-trips", () => {
  const mask = generateBattle(3, 2, "hills").mask
  const x = WORLD_W / 2
  const y = surfaceY(mask, x) + 10
  expect(isSolid(mask, x, y)).toBe(true)
  carveCircle(mask, x, y, 20)
  expect(isSolid(mask, x, y)).toBe(false)
  expect(packMask(unpackMask(packMask(mask)))).toBe(packMask(mask))
})

test("volley simulation is deterministic", () => {
  for (const seed of [42, 43, 44]) {
    const a = setup(seed)
    const b = setup(seed)
    const ra = runVolley({ ...a, wind: 12, seed: 99 })
    const rb = runVolley({ ...b, wind: 12, seed: 99 })
    expect(ra.hash).toBe(rb.hash)
    expect(JSON.stringify(ra.events)).toBe(JSON.stringify(rb.events))
    expect(ra.paths.length).toBeGreaterThan(0)
  }
})

test("replaying terrain events reproduces the post-volley mask", () => {
  let chunks = 0
  for (let seed = 1; seed <= 36; seed++) {
    const s = setup(seed, 6)
    const before = new Uint8Array(s.mask)
    const res = runVolley({ ...s, wind: (seed % 7) * 6 - 18, seed })
    for (let i = 1; i < res.events.length; i++) expect(res.events[i]!.t).toBeGreaterThanOrEqual(res.events[i - 1]!.t)
    chunks += res.events.filter((e) => e.type === "chunk").length
    expect(packMask(replayTerrain(before, res.events))).toBe(packMask(s.mask))
  }
  expect(chunks).toBeGreaterThan(0)
})

test("a tunneled hill collapses into falling chunks that land", () => {
  const mask: Mask = new Uint8Array(WORLD_W * WORLD_H)
  fillRect(mask, 0, 420, WORLD_W, WORLD_H)
  fillRect(mask, 500, 300, 700, 420)
  // hollow out the hill so only two thin legs hold it up
  fillRect(mask, 500, 300, 700, 420)
  for (let x = 510; x < 690; x += 4) carveCircle(mask, x, 400, 14)
  const units = makeUnits(mask, [150, 600, 1050])
  const before = new Uint8Array(mask)
  // shells at both legs
  const shots: Shot[] = [
    { unit: 0, weapon: "drill", angle: 0, power: 0 },
    { unit: 2, weapon: "drill", angle: 0, power: 0 },
  ]
  // aim the two outer units at the hill legs using the predictor
  for (const [shot, tx] of [
    [shots[0]!, 503],
    [shots[1]!, 697],
  ] as const) {
    let best = Infinity
    const u = units[shot.unit]!
    for (let a = 0.2; a < Math.PI - 0.2; a += 0.01) {
      for (let p = 20; p <= 100; p += 2) {
        const pts = predictPath(mask, u, a, p, 0, "shell", 9999, units)
        const ex = pts[pts.length - 2]!
        const ey = pts[pts.length - 1]!
        const d = Math.hypot(ex - tx, ey - 395)
        if (d < best) {
          best = d
          shot.angle = a
          shot.power = p
        }
      }
    }
  }
  shots[0]!.weapon = "buster"
  shots[1]!.weapon = "buster"
  const res = runVolley({ mask, units, shots, wind: 0, seed: 5 })
  const chunkEvents = res.events.filter((e): e is Extract<SimEvent, { type: "chunk" }> => e.type === "chunk")
  expect(chunkEvents.length).toBeGreaterThan(0)
  expect(chunkEvents.some((c) => c.dy > 0)).toBe(true)
  expect(findIslands(mask).length).toBe(0)
  expect(packMask(replayTerrain(before, res.events))).toBe(packMask(mask))
  // the unit on top rode the hill down
  expect(res.events.some((e) => e.type === "move" && e.unit === 1)).toBe(true)
})

test("every weapon produces its signature events", () => {
  const sig: Partial<Record<WeaponId, SimEvent["type"][]>> = {
    shell: ["boom", "carve"],
    cluster: ["boom"],
    mirv: ["boom"],
    drill: ["carve", "boom"],
    napalm: ["fire"],
    gravity: ["well", "boom"],
    builder: ["builder", "fill"],
    airstrike: ["boom"],
    bouncer: ["boom"],
    buster: ["boom", "carve"],
    shield: ["shieldUp"],
    teleport: ["teleport"],
  }
  for (const w of WEAPON_IDS) {
    const bf = generateBattle(77, 2, "hills")
    const units = makeUnits(bf.mask, bf.spawns)
    const res = runVolley({ mask: bf.mask, units, shots: [{ unit: 0, weapon: w, angle: 0.8, power: 55 }], wind: 0, seed: 1 })
    for (const type of sig[w] ?? []) expect({ w, has: res.events.some((e) => e.type === type) }).toEqual({ w, has: true })
    if (w === "drill") expect(res.events.filter((e) => e.type === "carve").length).toBeGreaterThan(10)
    if (w === "cluster") expect(res.paths.filter((p) => p.kind === "bomblet").length).toBe(6)
    if (w === "mirv") expect(res.paths.filter((p) => p.kind === "mirv").length).toBe(4)
    if (w === "airstrike") expect(res.paths.filter((p) => p.kind === "airstrike").length).toBe(6)
    if (w !== "shell") expect(units[0]!.ammo[w]).toBe(4)
  }
})

test("shield absorbs damage and expires after the volley", () => {
  const bf = generateBattle(9, 2, "hills")
  const units = makeUnits(bf.mask, [500, 540])
  units[0]!.y = spawnY(bf.mask, 500)
  units[1]!.y = spawnY(bf.mask, 540)
  // unit 1 lobs a shell straight onto unit 0 which raises a shield
  let shot: Shot = { unit: 1, weapon: "shell", angle: 1.6, power: 30 }
  for (let a = 1.6; a < 3; a += 0.005) {
    const pts = predictPath(bf.mask, units[1]!, a, 30, 0, "shell", 9999, units)
    if (Math.abs(pts[pts.length - 2]! - 500) < 3) {
      shot = { unit: 1, weapon: "shell", angle: a, power: 30 }
      break
    }
  }
  const res = runVolley({ mask: bf.mask, units, shots: [{ unit: 0, weapon: "shield", angle: 1, power: 0 }, shot], wind: 0, seed: 2 })
  expect(res.events.some((e) => e.type === "absorb" && e.unit === 0)).toBe(true)
  expect(units[0]!.shield).toBe(0)
})

test("shooting a crate claims it", () => {
  const bf = generateBattle(11, 2, "hills")
  const units = makeUnits(bf.mask, bf.spawns)
  const u = units[0]!
  const pts = predictPath(bf.mask, u, 0.9, 55, 0, "shell", 9999)
  const crates: Crate[] = [{ id: 1, x: pts[pts.length - 2]!, y: pts[pts.length - 1]! - 6, kind: "weapon", landed: false }]
  const res = runVolley({ mask: bf.mask, units, shots: [{ unit: 0, weapon: "shell", angle: 0.9, power: 55 }], wind: 0, seed: 3, crates })
  const ev = res.events.find((e) => e.type === "crate")
  expect(ev && ev.type === "crate" && ev.unit === 0 && ev.detail.startsWith("+1 ")).toBe(true)
  expect(crates.length).toBe(0)
})

test("predictPath matches the volley path", () => {
  const bf = generateBattle(21, 2)
  const units = makeUnits(bf.mask, bf.spawns, "catapult")
  const pts = predictPath(bf.mask, units[0]!, 1.0, 70, 25, "shell", 9999, units)
  const res = runVolley({ mask: bf.mask, units, shots: [{ unit: 0, weapon: "shell", angle: 1.0, power: 70 }], wind: 25, seed: 1 })
  const path = res.paths[0]!.pts
  const n = Math.min(pts.length, path.length) - 2
  for (let i = 0; i < n; i++) expect(Math.abs(pts[i]! - path[i]!)).toBeLessThan(1e-9)
})

test("moveUnit walks the surface and never enters terrain", () => {
  for (const biome of BIOMES) {
    for (const cls of CLASS_IDS) {
      const bf = generateBattle(1234 + cls.length, 4, biome)
      const [u] = makeUnits(bf.mask, [bf.spawns[1]!], cls)
      u!.fuel = 100000
      let moved = 0
      for (let i = 0; i < 300; i++) {
        const dir = i < 150 ? 1 : -1
        const x0 = u!.x
        moveUnit(bf.mask, u!, dir)
        moved += Math.abs(u!.x - x0)
        expect(embedded(bf.mask, u!.x, u!.y)).toBe(false)
        expect(supported(bf.mask, u!.x, u!.y)).toBe(true)
      }
      expect(moved).toBeGreaterThan(0)
    }
  }
  const bf = generateBattle(5, 2, "hills")
  const [u] = makeUnits(bf.mask, [bf.spawns[0]!])
  u!.fuel = 3
  moveUnit(bf.mask, u!, 1)
  moveUnit(bf.mask, u!, 1)
  expect(u!.fuel).toBe(0)
  expect(moveUnit(bf.mask, u!, 1)).toBe(false)
})

test("classes and shop", () => {
  expect(Object.keys(CLASSES).length).toBe(8)
  expect(CLASSES.catapult.unlock).toBe(8)
  expect(SHOP.filter((i) => i.kind === "weapon").length).toBe(11)
  const l = newLoadout(400)
  expect(applyPurchase(l, "mirv")).toBe(null)
  expect(l.ammo.mirv).toBe(WEAPONS.mirv.ammo + 1)
  expect(applyPurchase(l, "airstrike")).toBe("Not enough credits")
})

test("bot finds a dangerous shot", () => {
  const bf = generateBattle(31, 2, "hills")
  const units = makeUnits(bf.mask, bf.spawns)
  const plan = planBot({ mask: bf.mask, units, crates: [], me: units[0]!, wind: 10, seed: 3, skill: 1 })
  const pts = predictPath(bf.mask, units[0]!, plan.angle, plan.power, 10, "shell", 9999, units)
  const ex = pts[pts.length - 2]!
  const ey = pts[pts.length - 1]!
  expect(Math.hypot(ex - units[1]!.x, ey - units[1]!.y)).toBeLessThan(80)
})

test("a bots match with one auto-locking human runs to the end and back to lobby", () => {
  const m = new Match("test", 1234)
  let now = 1000
  m.join("h", "Human", "crawler", 10, now)
  m.handle("h", { type: "start", mode: "ffa", bots: 5, battles: 2 }, now)
  let sawVolley = 0
  let sawShop = false
  let sawOver = false
  let sawLobby = false
  for (let i = 0; i < 20000 && !sawLobby; i++) {
    now += 250
    const v = m.view(false, now)
    if (v.phase === "aim") {
      m.handle("h", { type: "aim", angle: 0.9, power: 60, weapon: "shell" }, now)
      m.handle("h", { type: "move", dir: 1 }, now)
      if (now - (v.phaseEndsAt - 8000) > 2500) m.handle("h", { type: "lock" }, now)
    }
    if (v.phase === "shop") {
      m.handle("h", { type: "buy", item: "repair" }, now)
      m.handle("h", { type: "ready" }, now)
    }
    m.handle("h", { type: "ping", t: now }, now)
    m.tick(now)
    for (const { msg } of m.drain()) {
      if (msg.type === "volley") {
        sawVolley++
        expect(msg.after.mask).toBeDefined()
        const mask = unpackMask(msg.before.mask!)
        expect(packMask(replayTerrain(mask, msg.result.events))).toBe(msg.after.mask!)
      }
      if (msg.type === "state" && msg.view.phase === "shop") sawShop = true
      if (msg.type === "state" && msg.view.phase === "over") {
        sawOver = true
        expect(msg.view.matchWinner).not.toBe(null)
      }
      if (msg.type === "state" && msg.view.phase === "lobby" && sawOver) sawLobby = true
    }
  }
  expect(sawVolley).toBeGreaterThan(1)
  expect(sawShop).toBe(true)
  expect(sawOver).toBe(true)
  expect(sawLobby).toBe(true)
  const v = m.view(false, now)
  expect(v.players.length).toBe(1)
  expect(v.players[0]!.host).toBe(true)
  expect(m.empty).toBe(false)
  m.leave("h", now)
  expect(m.empty).toBe(true)
})

test("mid-battle joiners spectate until the next battle; class passives apply at spawn", () => {
  const m = new Match("j", 77)
  let now = 0
  m.join("a", "Alpha", "crawler", 10, now)
  m.handle("a", { type: "start", mode: "teams", bots: 3, battles: 2 }, now)
  let v = m.view(false, now)
  expect(v.phase).toBe("aim")
  expect(v.units.length).toBe(4)
  const mine = v.units[v.players.find((p) => p.id === "a")!.unit]!
  expect(mine.shield).toBe(15)
  expect(new Set(v.units.map((u) => u.team)).size).toBe(2)
  m.join("b", "Bravo", "howitzer", 1, now)
  const welcome = m.drain().find((o) => o.to === "b" && o.msg.type === "welcome")
  expect(welcome && welcome.msg.type === "welcome" && typeof welcome.msg.view.mask).toBe("string")
  v = m.view(false, now)
  const b = v.players.find((p) => p.id === "b")!
  expect(b.spectator).toBe(true)
  expect(b.unit).toBe(-1)
  let joinedBattle = false
  for (let i = 0; i < 6000 && !joinedBattle; i++) {
    now += 250
    const cur = m.view(false, now)
    if (cur.phase === "aim") {
      m.handle("a", { type: "lock" }, now)
      m.handle("b", { type: "lock" }, now)
    }
    if (cur.phase === "shop") {
      m.handle("a", { type: "ready" }, now)
      m.handle("b", { type: "ready" }, now)
    }
    m.tick(now)
    m.drain()
    const after = m.view(false, now)
    const pb = after.players.find((p) => p.id === "b")!
    if (after.battle === 2 && pb.unit >= 0) {
      joinedBattle = true
      expect(pb.spectator).toBe(false)
      expect(after.units[pb.unit]!.ammo.cluster).toBe(WEAPONS.cluster.ammo + 1)
    }
  }
  expect(joinedBattle).toBe(true)
})
