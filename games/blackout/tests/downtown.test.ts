import { describe, expect, mock, test } from "bun:test"
import { PLAYER_RADIUS } from "../shared/config"
import { BUILD } from "../shared/build.gen"
import { distToRect, type Rect } from "../shared/geom"
import { getMap } from "../shared/maps"
import { LIGHT_BUDGET } from "../shared/maps/builder"
import { generateDowntown } from "../shared/maps/downtown"
import type { MapDef } from "../shared/maps/types"
import { decodeClient } from "../shared/protocol"
import { hostMaps } from "../shared/sim/host"
import type { ModeId } from "../shared/sim/modes"
import { Nav, navFor } from "../shared/sim/nav"
import { placesFor } from "../shared/sim/places"
import { buildSnapshot } from "../shared/sim/view"
import { World } from "../shared/sim/world"

/** A road's travel lanes: the asphalt less its parking lanes. */
const lanesOf = (r: NonNullable<MapDef["roads"]>[number]): Rect => (r.axis === "x" ? [r.rect[0], r.rect[1] + r.park[0], r.rect[2], r.rect[3] - r.park[1]] : [r.rect[0] + r.park[0], r.rect[1], r.rect[2] - r.park[1], r.rect[3]])

const solids0 = (m: MapDef) => [...m.walls.map((w) => w.rect), ...m.windows, ...m.glass, ...m.props.filter((p) => p.solid).map((p) => p.rect)]

const SEEDS = Array.from({ length: 40 }, (_, i) => i * 7919 + 13)
const maps = new Map(SEEDS.map((s) => [s, generateDowntown(s)]))

/** Independent loops in the road network: roads as nodes, touching or overlapping roads as edges. */
function loops(m: MapDef): number {
  const roads = m.roads ?? []
  const touch = (a: Rect, b: Rect) => a[0] <= b[2] + 1e-6 && a[2] >= b[0] - 1e-6 && a[1] <= b[3] + 1e-6 && a[3] >= b[1] - 1e-6
  // Junction boxes merge the roads meeting at them: count connections through the union-find of overlaps.
  let edges = 0
  roads.forEach((a, i) => roads.forEach((b, j) => j > i && touch(a.rect, b.rect) && edges++))
  const parent = roads.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)))
  roads.forEach((a, i) => roads.forEach((b, j) => j > i && touch(a.rect, b.rect) && (parent[find(i)] = find(j))))
  const parts = new Set(roads.map((_, i) => find(i))).size
  return edges - roads.length + parts
}

/** Asphalt cells clear of anything solid (parked cars, barriers, the wreck), and the size of the biggest connected stretch. */
function drivable(m: MapDef): { cells: number; reached: number } {
  const S = 0.5
  const [W, H] = m.size
  const w = Math.ceil(W / S)
  const h = Math.ceil(H / S)
  const road = new Uint8Array(w * h)
  for (const rd of m.roads ?? []) {
    const r = rd.rect
    for (let y = Math.floor(r[1] / S); y < Math.ceil(r[3] / S); y++) for (let x = Math.floor(r[0] / S); x < Math.ceil(r[2] / S); x++) if (x >= 0 && y >= 0 && x < w && y < h) road[y * w + x] = 1
  }
  // Solid things on the drivable part (barriers, the wreck) close it there.
  for (const wl of m.walls) for (let y = Math.floor(wl.rect[1] / S); y < Math.ceil(wl.rect[3] / S); y++) for (let x = Math.floor(wl.rect[0] / S); x < Math.ceil(wl.rect[2] / S); x++) if (x >= 0 && y >= 0 && x < w && y < h) road[y * w + x] = 0
  const seen = new Uint8Array(w * h)
  let best = 0
  let cells = 0
  for (let i = 0; i < w * h; i++) {
    if (!road[i]) continue
    cells++
    if (seen[i]) continue
    const q = [i]
    seen[i] = 1
    for (let k = 0; k < q.length; k++) {
      const c = q[k]!
      for (const n of [c + 1, c - 1, c + w, c - w]) {
        if (n < 0 || n >= w * h || seen[n] || !road[n] || Math.abs((n % w) - (c % w)) > 1) continue
        seen[n] = 1
        q.push(n)
      }
    }
    best = Math.max(best, q.length)
  }
  return { cells, reached: best }
}

describe("procedural downtown", () => {
  test("is deterministic, and getMap builds it by kind and seed", () => {
    expect(JSON.stringify(generateDowntown(1234))).toBe(JSON.stringify(generateDowntown(1234)))
    expect(JSON.stringify(generateDowntown(1234))).not.toBe(JSON.stringify(generateDowntown(1235)))
    expect(getMap("downtown", 77).kind).toBe("downtown")
    expect(getMap("office", 77).kind).toBe("office")
    expect(JSON.stringify(getMap("downtown", 77))).toBe(JSON.stringify(generateDowntown(77)))
  })

  test("generates quickly", () => {
    generateDowntown(1)
    const t = performance.now()
    for (const s of SEEDS.slice(0, 10)) generateDowntown(s)
    expect((performance.now() - t) / 10).toBeLessThan(50)
  })

  test("varies: grid sizes, superblocks, stubs, parks and parking lots all turn up", () => {
    const all = [...maps.values()]
    expect(new Set(all.map((m) => `${m.size[0]}x${m.size[1]}`)).size).toBeGreaterThan(20)
    expect(all.filter((m) => m.floors.some((f) => f.kind === "grass")).length).toBeGreaterThan(5)
    expect(all.filter((m) => m.floors.some((f) => f.kind === "parking")).length).toBeGreaterThan(25)
    expect(all.filter((m) => m.walls.some((w) => w.style === "hoarding")).length).toBeGreaterThan(15)
    expect(all.filter((m) => m.walls.some((w) => w.style === "wreck")).length).toBeGreaterThan(15)
    expect(all.filter((m) => m.walls.some((w) => w.style === "subway")).length).toBeGreaterThan(25)
  })

  test("bots path across the whole map quickly", () => {
    const m = generateDowntown(99)
    const nav = new Nav(m)
    const far = [...m.spawns].sort((a, b) => a.x + a.y - (b.x + b.y))
    const t = performance.now()
    for (let k = 0; k < 20; k++) expect(nav.path(far[k % 4]!, far[far.length - 1 - (k % 4)]!)).not.toBeNull()
    expect((performance.now() - t) / 20).toBeLessThan(15)
  })

  for (const seed of SEEDS) {
    test(`downtown ${seed}: connected streets for cars and people, spread spawns, sparse lights, valid places`, () => {
      const m = maps.get(seed)!
      expect(m.kind).toBe("downtown")
      for (const s of m.size) {
        expect(s).toBeGreaterThanOrEqual(60)
        expect(s).toBeLessThanOrEqual(92)
      }

      // Roads: at least two 3.5 m lanes clear of parking, joined into one network with loops, and every bit a car can
      // be on reachable from the rest.
      const roads = m.roads ?? []
      expect(roads.length).toBeGreaterThanOrEqual(6)
      for (const r of roads) {
        const l = lanesOf(r)
        expect(r.axis === "x" ? l[3] - l[1] : l[2] - l[0]).toBeGreaterThanOrEqual(7 - 1e-6)
        expect(r.lanes).toBeGreaterThanOrEqual(2)
      }
      expect(loops(m)).toBeGreaterThanOrEqual(3)
      const d = drivable(m)
      expect(d.reached / d.cells).toBeGreaterThan(0.9)
      // Nothing solid parked on the drive lanes except the barriers and wreck closing a dead end.
      for (const w of m.walls) {
        if (w.style === "barrier" || w.style === "wreck" || w.style === "hoarding") continue
        for (const rd of roads) {
          const r = lanesOf(rd)
          const ox = Math.min(w.rect[2], r[2]) - Math.max(w.rect[0], r[0])
          const oy = Math.min(w.rect[3], r[3]) - Math.max(w.rect[1], r[1])
          expect(ox > 0.05 && oy > 0.05).toBe(false)
        }
      }

      // Drivable vehicles parked round the map (parking lanes, the lot, scooters by the curb), clear of anything solid
      // and with a road to drive off on.
      const vs = m.vehicles ?? []
      expect(vs.length).toBeGreaterThanOrEqual(2)
      for (const v of vs) {
        expect(solids0(m).every((r) => distToRect(v.x, v.y, r) > 0.4)).toBe(true)
        expect(new Nav(m).walkable(v)).toBe(true)
      }

      // People: spawns off the road, reachable, apart; nearly all the open ground connected.
      const nav = new Nav(m)
      expect(m.spawns.length).toBeGreaterThanOrEqual(16)
      const reach = nav.reachable(m.spawns[0]!)
      const solids = [...m.walls.map((w) => w.rect), ...m.windows, ...m.glass, ...m.props.filter((p) => p.solid).map((p) => p.rect)]
      for (const s of m.spawns) {
        expect(nav.inMask(reach, s)).toBe(true)
        expect(solids.every((r) => distToRect(s.x, s.y, r) >= PLAYER_RADIUS)).toBe(true)
        expect(roads.some((r) => s.x > r.rect[0] && s.x < r.rect[2] && s.y > r.rect[1] && s.y < r.rect[3])).toBe(false)
      }
      for (const a of m.spawns) for (const b of m.spawns) if (a !== b) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(8)
      let free = 0
      let reached = 0
      for (let i = 0; i < nav.grid.length; i++) {
        if (nav.grid[i]) continue
        free++
        if (reach[i]) reached++
      }
      expect(reached / free).toBeGreaterThan(0.97)
      // Walled in: nothing walkable reaches the map's edge except where a hoarding closes a dead end.
      for (let x = 0; x < nav.w; x++) {
        expect(nav.grid[x]).toBe(1)
        expect(nav.grid[(nav.h - 1) * nav.w + x]).toBe(1)
      }
      for (let y = 0; y < nav.h; y++) {
        expect(nav.grid[y * nav.w]).toBe(1)
        expect(nav.grid[y * nav.w + nav.w - 1]).toBe(1)
      }

      // Lights: ids match their index, within budget, and sparse: dark between the pools.
      m.lights.forEach((l, i) => expect(l.id).toBe(i))
      expect(m.lights.length).toBeLessThanOrEqual(LIGHT_BUDGET)
      expect(m.lights.length).toBeGreaterThanOrEqual(20)
      expect(m.lights.length).toBeLessThanOrEqual(90)
      for (const p of m.props) if (p.light !== undefined) expect(m.lights[p.light]).toBeDefined()
      expect(m.lights.some((l) => l.kind === "street")).toBe(true)
      expect(m.lights.some((l) => l.kind === "neon")).toBe(true)
      const lit = m.lights.reduce((s, l) => s + Math.PI * (l.r / 2) ** 2, 0)
      expect(lit / (m.size[0] * m.size[1])).toBeLessThan(0.6)

      // The city: shops to fight through, a plaza with a fountain, parked cars and street cover.
      expect(m.windows.length).toBeGreaterThan(0)
      expect(m.walls.filter((w) => w.style === "shop").length).toBeGreaterThan(6)
      expect(m.walls.some((w) => w.style === "fountain")).toBe(true)
      expect(m.walls.filter((w) => w.style === "car").length + vs.length).toBeGreaterThanOrEqual(4)
      expect(m.walls.filter((w) => w.style === "building").length).toBeGreaterThan(15)
      expect(m.paint?.length ?? 0).toBeGreaterThan(50)

      // Mode placements: reachable, apart, in order along the long axis, team ends at opposite ends.
      const pl = placesFor(m)
      const pr = navFor(m).reachable(m.spawns[0]!)
      for (const v of [...pl.points, ...pl.sites, ...pl.hills, ...pl.bases, ...pl.slots[0], ...pl.slots[1]]) expect(navFor(m).inMask(pr, v)).toBe(true)
      const dist = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y)
      const [a, b, c] = pl.points
      expect(Math.min(dist(a, b), dist(b, c), dist(a, c))).toBeGreaterThan(12)
      expect(dist(pl.sites[0], pl.sites[1])).toBeGreaterThan(10)
      expect(dist(pl.bases[0], pl.bases[1])).toBeGreaterThan(40)
      expect(pl.slots[0].length).toBeGreaterThanOrEqual(8)
      expect(pl.slots[1].length).toBeGreaterThanOrEqual(8)
      const along = (v: { x: number; y: number }) => (m.size[0] >= m.size[1] ? v.x : v.y)
      expect(along(pl.ends[0][0]!)).toBeLessThan(along(pl.ends[1][0]!) - 30)
    })
  }
})

describe("map kind in the room", () => {
  test("the world plays the room's setting, random picks both, and the snapshot carries kind and seed", () => {
    const off = new World(5)
    expect(off.map.kind).toBe("office")
    const dt = new World(5, null, "ffa", "downtown")
    expect(dt.map.kind).toBe("downtown")
    const s = buildSnapshot(dt, "")
    expect(s.mapKind).toBe("downtown")
    expect(s.maps).toBe("downtown")
    expect(JSON.stringify(getMap(s.mapKind, s.map))).toBe(JSON.stringify(dt.map))
    const rnd = new World(9, null, "ffa", "random")
    const kinds = new Set<string>()
    for (let k = 0; k < 12; k++) {
      rnd.restart("ffa")
      kinds.add(rnd.map.kind)
    }
    expect(kinds).toEqual(new Set(["office", "downtown"]))
  })

  test("the host's map setting applies from the next new floor; others are ignored", () => {
    const w = new World(3, null, "tdm", "office")
    w.addHuman("h", "h")
    w.addHuman("x", "x")
    expect(hostMaps(w, "x", "downtown")).toBe(false)
    expect(w.maps).toBe("office")
    expect(hostMaps(w, "h", "downtown")).toBe(true)
    expect(w.map.kind).toBe("office")
    w.restart("tdm", false)
    expect(w.map.kind).toBe("office")
    w.restart("tdm")
    expect(w.map.kind).toBe("downtown")
    // The vote between matches keeps to the setting too.
    w.endMatch()
    for (let i = 0; i < 30 * 20 && w.phase === "end"; i++) w.step()
    expect(w.map.kind).toBe("downtown")
  })

  test("protocol validates the map setting", () => {
    expect(decodeClient(JSON.stringify({ type: "host", action: "maps", maps: "downtown" }))).toEqual({ type: "host", action: "maps", maps: "downtown" })
    expect(decodeClient(JSON.stringify({ type: "host", action: "maps", maps: "moon" }))).toBeNull()
  })

  test("Create game's map is the first map, taken only while the room is empty", async () => {
    mock.module("cloudflare:workers", () => ({ DurableObject: class {} }))
    const { RoomCore } = await import("../server/room")
    const core = new RoomCore("wxyz")
    expect(core.world.map.kind).toBe("office")
    expect(core.setMaps("downtown")).toBe(true)
    expect(core.world.map.kind).toBe("downtown")
    core.message({ send() {}, close() {} }, JSON.stringify({ type: "hello", name: "x", gun: "rifle", equip: "frag", build: BUILD }))
    expect(core.setMaps("office")).toBe(false)
    expect(core.world.map.kind).toBe("downtown")
  })

  test("bots play downtown in every kind of mode", () => {
    for (const mode of ["tdm", "dom", "snd", "ctf", "hp"] as ModeId[]) {
      const w = new World(11, null, mode, "downtown")
      w.fill(8)
      for (let i = 0; i < 30 * 60 && w.phase === "play"; i++) w.step()
      const kills = [...w.players.values()].reduce((s, p) => s + p.kills, 0)
      expect(kills + Math.max(...w.mode.score)).toBeGreaterThan(0)
    }
  })
})
