import type { AIAgent, AIState } from "@arcade/kit/sim/ai"
import { distToRect, type Rect } from "@arcade/kit/sim/geom"
import { hash3, Rng } from "@arcade/kit/sim/rng"
import { DEFAULT_PROGRESSION_TUNING, lootSites, type LootSite } from "./progression"
import {
  CHUNK,
  EXTERIOR_VEHICLE_COLLIDERS,
  makeTown,
  propShape,
  SIZE,
  type Barrier,
  type Building,
  type Door,
  type Lamp,
  type Prop,
  type Town,
  type WindowOpening,
} from "./map"

export type LootContainer = LootSite

export type WorldMode = "classic" | "streaming" | "procedural"

export type DistrictKind = "suburb" | "commercial" | "civic" | "industrial" | "woodland"

export type BuildingArchetype =
  | "house"
  | "ranch"
  | "cottage"
  | "hardware"
  | "pharmacy"
  | "grocery"
  | "diner"
  | "gas_station"
  | "police"
  | "clinic"
  | "church"
  | "warehouse"
  | "cabin"

export type ChunkCoord = { cx: number; cy: number }

export type ZombieSpawnSpec = {
  id: number
  seed: number
  x: number
  y: number
  aim: number
}

export type WorldChunk = {
  key: string
  cx: number
  cy: number
  bx: number
  by: number
  lx: number
  ly: number
  district: DistrictKind
  bounds: Rect
  buildings: Building[]
  barriers: Barrier[]
  doors: Door[]
  windows: WindowOpening[]
  props: Prop[]
  lamps: Lamp[]
  vehicles: Rect[]
  containers: LootContainer[]
  zombieSpawns: ZombieSpawnSpec[]
  /** Deterministic 32-bit FNV-1a digest of the chunk's generated layout and entities. */
  hash: number
}

export type DoorDelta = {
  open: boolean
  locked?: boolean
  integrity?: number
  planks?: number
  plankHp?: number
}

export type WindowDelta = {
  open: boolean
  openable: boolean
  planks?: number
  plankHp?: number
}

export type SavedZombieState = {
  id: number
  seed: number
  x: number
  y: number
  aim: number
  state: AIState
  hp: number
  detachedLimbs: string[]
}

export type ChunkDelta = {
  key: string
  cx: number
  cy: number
  doors: Record<string, DoorDelta>
  windows: Record<string, WindowDelta>
  searched: Record<string, boolean>
  zombies: Record<number, SavedZombieState>
  /** Saved drivable vehicles currently parked/left in this chunk. */
  vehicles?: Record<number, import("./vehicles").SavedVehicleState>
  /** Native vehicle spawn IDs that were driven out of this chunk. */
  removedVehicles?: Record<number, boolean>
  /** Aggregate living zombie count while the chunk is unloaded (simulation LOD). */
  aggregateZombies: number
  visited: boolean
}

export const MACRO_CHUNKS = 3
export const MACRO_SIZE = CHUNK * MACRO_CHUNKS // 96 m

export function chunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`
}

export function parseChunkKey(key: string): ChunkCoord {
  const [x, y] = key.split(",")
  return { cx: Number(x), cy: Number(y) }
}

export function worldToChunk(x: number, y: number): ChunkCoord {
  return {
    cx: Math.floor(x / CHUNK),
    cy: Math.floor(y / CHUNK),
  }
}

export function worldToMacroBlock(x: number, y: number): { bx: number; by: number; lx: number; ly: number } {
  const cx = Math.floor(x / CHUNK)
  const cy = Math.floor(y / CHUNK)
  const bx = Math.floor(cx / MACRO_CHUNKS)
  const by = Math.floor(cy / MACRO_CHUNKS)
  const lx = ((cx % MACRO_CHUNKS) + MACRO_CHUNKS) % MACRO_CHUNKS
  const ly = ((cy % MACRO_CHUNKS) + MACRO_CHUNKS) % MACRO_CHUNKS
  return { bx, by, lx, ly }
}

/** Folds a world coordinate into its [0, 96) macro-block local coordinate. */
export function macroLocalCoord(v: number): number {
  if (v >= 0 && v < MACRO_SIZE) return v
  return ((v % MACRO_SIZE) + MACRO_SIZE) % MACRO_SIZE
}

/**
 * Deterministic district zoning per 96×96 m macro-block `(bx, by)`.
 * Guarantees that all 5 districts (`suburb`, `commercial`, `civic`, `industrial`, `woodland`)
 * appear in the immediate macro-blocks surrounding `(0, 0)` and across any 1+ km traversal.
 */
export function districtAtBlock(seed: number, bx: number, by: number): DistrictKind {
  if (bx === 0 && by === 0) return "suburb"
  // Curated ring around (0, 0) so walking in any cardinal direction within 300 m hits distinct districts
  if (bx === 1 && by === 0) return "commercial"
  if (bx === 2 && by === 0) return "civic"
  if (bx === 3 && by === 0) return "industrial"
  if (bx === 4 && by === 0) return "woodland"
  if (bx === -1 && by === 0) return "commercial"
  if (bx === 0 && by === 1) return "civic"
  if (bx === 0 && by === -1) return "industrial"
  if (bx === 1 && by === 1) return "woodland"

  const h = hash3(seed ^ 0x6a09e667, bx + 1024, by + 1024)
  const districts: readonly DistrictKind[] = ["suburb", "commercial", "civic", "industrial", "woodland"]
  return districts[Math.floor(h * districts.length) % districts.length]!
}

export function districtAtChunk(seed: number, cx: number, cy: number): DistrictKind {
  const bx = Math.floor(cx / MACRO_CHUNKS)
  const by = Math.floor(cy / MACRO_CHUNKS)
  return districtAtBlock(seed, bx, by)
}

/** Deterministic 32-bit FNV-1a digest of a generated chunk for client/server parity proofs. */
export function hashWorldChunk(c: Omit<WorldChunk, "hash">): number {
  let h = 2166136261 >>> 0
  const mix = (v: number) => {
    h ^= (Math.round(v * 100) | 0) & 0xffffffff
    h = Math.imul(h, 16777619) >>> 0
  }
  const mixStr = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619) >>> 0
    }
  }
  mix(c.cx)
  mix(c.cy)
  mixStr(c.district)
  for (const b of c.buildings) {
    mixStr(b.id)
    mixStr(b.kind)
    mixStr(b.archetype ?? b.kind)
    mix(b.rect[0])
    mix(b.rect[1])
    mix(b.rect[2])
    mix(b.rect[3])
    mix(b.color)
  }
  for (const bar of c.barriers) {
    mixStr(bar.kind)
    mix(bar.rect[0])
    mix(bar.rect[1])
    mix(bar.rect[2])
    mix(bar.rect[3])
  }
  for (const d of c.doors) {
    mixStr(d.id)
    mix(d.rect[0])
    mix(d.rect[1])
    mix(d.rect[2])
    mix(d.rect[3])
    mix(d.open ? 1 : 0)
    mix(d.locked ? 1 : 0)
  }
  for (const w of c.windows) {
    mixStr(w.id)
    mix(w.rect[0])
    mix(w.rect[1])
    mix(w.rect[2])
    mix(w.rect[3])
  }
  for (const p of c.props) {
    mixStr(p.kind)
    mix(p.x)
    mix(p.y)
  }
  for (const l of c.lamps) {
    mixStr(l.kind)
    mix(l.x)
    mix(l.y)
  }
  for (const ct of c.containers) {
    mixStr(ct.id)
    mix(ct.ammo ?? 0)
    mix(ct.planks ?? 0)
  }
  return h >>> 0
}

/** Deterministic stable integer ID base for a chunk `(cx, cy)` so zombie IDs never collide across chunks. */
export function chunkZombieIdBase(cx: number, cy: number): number {
  if (cx >= 0 && cx < 3 && cy >= 0 && cy < 3) {
    return 1 + (cy * 3 + cx) * 16
  }
  const hx = ((cx + 512) & 1023)
  const hy = ((cy + 512) & 1023)
  return 200 + ((hx * 37 + hy * 101) % 7500) * 8
}

/**
 * Partitions the Classic 96×96 m `makeTown(seed, houseSeed, terrain)` into 9 `WorldChunk`s `(0..2, 0..2)`.
 * Building 0 (`ash`) belongs to chunk `(0, 1)`, building 1 (`elm`) to `(0, 1)`, building 2 (`hardware`) to `(1, 1)`,
 * building 3 (`pharmacy`) to `(1, 1)`, or we assign each item to the chunk containing its midpoint while keeping
 * the exact array order when all 9 classic chunks `(0..2, 0..2)` are active.
 */
const classicTownCache = new Map<string, Town>()
function getClassicTown(seed: number, houseSeed: number, terrain = 0.22): Town {
  const key = `${seed}:${houseSeed}:${terrain}`
  let t = classicTownCache.get(key)
  if (!t) {
    t = makeTown(seed, houseSeed, terrain)
    if (classicTownCache.size >= 8) classicTownCache.delete(classicTownCache.keys().next().value!)
    classicTownCache.set(key, t)
  }
  return t
}

function cloneClassicChunk(seed: number, houseSeed: number, cx: number, cy: number): WorldChunk {
  const base = getClassicTown(seed, houseSeed)
  const x0 = cx * CHUNK
  const y0 = cy * CHUNK
  const x1 = x0 + CHUNK
  const y1 = y0 + CHUNK
  const inChunk = (px: number, py: number) => {
    const ccx = Math.max(0, Math.min(2, Math.floor(px / CHUNK)))
    const ccy = Math.max(0, Math.min(2, Math.floor(py / CHUNK)))
    return ccx === cx && ccy === cy
  }

  const buildings = base.buildings
    .filter((b) => inChunk((b.rect[0] + b.rect[2]) * 0.5, (b.rect[1] + b.rect[3]) * 0.5))
    .map((b) => ({
      ...b,
      archetype: b.kind as BuildingArchetype,
      district: (b.kind === "house" ? "suburb" : "commercial") as DistrictKind,
      chunkKey: chunkKey(cx, cy),
    }))
  const barriers = base.barriers
    .filter((b) => inChunk((b.rect[0] + b.rect[2]) * 0.5, (b.rect[1] + b.rect[3]) * 0.5))
    .map((b) => ({ ...b, rect: [...b.rect] as Rect }))
  const doors = base.doors
    .filter((d) => inChunk((d.rect[0] + d.rect[2]) * 0.5, (d.rect[1] + d.rect[3]) * 0.5))
    .map((d) => ({ ...d, rect: [...d.rect] as Rect }))
  const windows = base.windows
    .filter((w) => inChunk((w.rect[0] + w.rect[2]) * 0.5, (w.rect[1] + w.rect[3]) * 0.5))
    .map((w) => ({ ...w, rect: [...w.rect] as Rect }))
  const props = base.props
    .filter((p) => inChunk(p.x, p.y))
    .map((p) => ({ ...p }))
  const lamps = base.lamps
    .filter((l) => inChunk(l.x, l.y))
    .map((l) => ({ ...l }))
  const vehicles = EXTERIOR_VEHICLE_COLLIDERS.filter((v) =>
    inChunk((v[0] + v[2]) * 0.5, (v[1] + v[3]) * 0.5),
  ).map((v) => [...v] as Rect)

  const allContainers = lootSites(base, DEFAULT_PROGRESSION_TUNING).sites
  const containers: LootContainer[] = allContainers
    .filter((c) => inChunk(c.x, c.y))
    .map((c) => ({ ...c, rect: [...c.rect] as Rect, searched: Boolean(c.searched), ammo: c.ammo ?? 4, planks: c.planks ?? 1 }))

  const zRng = new Rng((seed ^ Math.imul(cx * 31 + cy * 97 + 1, 0x7a4f9b13)) >>> 0)
  const baseId = chunkZombieIdBase(cx, cy)
  const zombieSpawns: ZombieSpawnSpec[] = []
  for (let i = 0; i < 3; i++) {
    const zx = x0 + 6 + zRng.next() * 20
    const zy = y0 + 6 + zRng.next() * 20
    if (Math.hypot(zx - 27.7, zy - 41) < 6.5) continue
    if (buildings.some((b) => zx >= b.rect[0] - 0.4 && zx <= b.rect[2] + 0.4 && zy >= b.rect[1] - 0.4 && zy <= b.rect[3] + 0.4)) continue
    zombieSpawns.push({
      id: baseId + i,
      seed: (seed ^ Math.imul(baseId + i + 17, 0x85ebca6b)) >>> 0,
      x: Number(zx.toFixed(2)),
      y: Number(zy.toFixed(2)),
      aim: Number(zRng.range(-Math.PI, Math.PI).toFixed(3)),
    })
  }

  const partial: Omit<WorldChunk, "hash"> = {
    key: chunkKey(cx, cy),
    cx,
    cy,
    bx: 0,
    by: 0,
    lx: cx,
    ly: cy,
    district: cx === 0 ? "suburb" : "commercial",
    bounds: [x0, y0, x1, y1],
    buildings,
    barriers,
    doors,
    windows,
    props,
    lamps,
    vehicles,
    containers,
    zombieSpawns,
  }
  return { ...partial, hash: hashWorldChunk(partial) }
}

const ARCHETYPE_PALETTES: Record<BuildingArchetype, readonly number[]> = {
  house: [0xb3afa0, 0x899d95, 0xb4a181, 0x9caaa9],
  ranch: [0xa69b88, 0x8e9a8c, 0xb29e84, 0x92989e],
  cottage: [0x9e9482, 0x849488, 0xa89278, 0x8c9698],
  hardware: [0x8e7564, 0x947862, 0x826c5c],
  pharmacy: [0x718b82, 0x6a8680, 0x78928a],
  grocery: [0x868e78, 0x7e8872, 0x928a74],
  diner: [0x9c8274, 0xa48878, 0x8e786c],
  gas_station: [0x78848e, 0x828c94, 0x6e7c86],
  police: [0x6e7884, 0x66707c, 0x76808c],
  clinic: [0x829492, 0x7a8e8c, 0x8a9a98],
  church: [0xa8a296, 0x9e988c, 0xb0aa9e],
  warehouse: [0x686c70, 0x5e6468, 0x72767a],
  cabin: [0x6e5844, 0x64503c, 0x78604a],
}

function chooseArchetype(district: DistrictKind, lx: number, ly: number, rng: Rng): BuildingArchetype | null {
  // Center crossroads chunk (1, 1) in every 96×96 m macro-block is the arterial intersection
  if (lx === 1 && ly === 1) return null

  const isRoadChunk = lx === 1 || ly === 1
  if (district === "suburb") {
    if (isRoadChunk) return rng.pick(["house", "ranch", "cottage"] as const)
    return rng.next() < 0.72 ? rng.pick(["cottage", "ranch", "house"] as const) : null
  }
  if (district === "commercial") {
    if (isRoadChunk) return rng.pick(["hardware", "pharmacy", "grocery", "diner", "gas_station"] as const)
    return rng.next() < 0.65 ? rng.pick(["grocery", "hardware", "ranch"] as const) : null
  }
  if (district === "civic") {
    if (lx === 1 && ly === 0) return "police"
    if (lx === 0 && ly === 1) return "clinic"
    if (lx === 2 && ly === 1) return "church"
    if (lx === 1 && ly === 2) return rng.pick(["pharmacy", "diner"] as const)
    return rng.next() < 0.55 ? rng.pick(["house", "cottage"] as const) : null
  }
  if (district === "industrial") {
    if (isRoadChunk) return rng.pick(["warehouse", "gas_station", "hardware"] as const)
    return rng.next() < 0.75 ? "warehouse" : null
  }
  // woodland
  if (lx === 1 && ly === 0) return "cabin"
  if (lx === 0 && ly === 1 && rng.next() < 0.6) return "cottage"
  return null
}

/**
 * Generates a single 32×32 m chunk `(cx, cy)` deterministically from `(seed, houseSeed, cx, cy)`.
 * Every building, wall, door, window, prop, lamp, vehicle, loot container, and zombie spawn inside
 * chunk `(cx, cy)` is a pure function of `(seed, houseSeed, cx, cy)` with zero dependency on chunk load order.
 */
export function generateWorldChunk(
  seed: number,
  houseSeed: number,
  cx: number,
  cy: number,
  mode: WorldMode = "streaming",
): WorldChunk {
  if (mode !== "procedural" && cx >= 0 && cx < 3 && cy >= 0 && cy < 3) {
    return cloneClassicChunk(seed, houseSeed, cx, cy)
  }

  const bx = Math.floor(cx / MACRO_CHUNKS)
  const by = Math.floor(cy / MACRO_CHUNKS)
  const lx = ((cx % MACRO_CHUNKS) + MACRO_CHUNKS) % MACRO_CHUNKS
  const ly = ((cy % MACRO_CHUNKS) + MACRO_CHUNKS) % MACRO_CHUNKS
  const district = districtAtBlock(seed, bx, by)

  const chunkSeed = (seed ^ Math.imul(cx + 2048, 0x9e3779b1) ^ Math.imul(cy + 2048, 0x85ebca6b)) >>> 0
  const chunkHouseSeed = (houseSeed ^ Math.imul(cx + 1024, 0xc2b2ae35) ^ Math.imul(cy + 1024, 0x27d4eb2f)) >>> 0
  const rng = new Rng(chunkSeed)
  const hRng = new Rng(chunkHouseSeed)

  const x0 = cx * CHUNK
  const z0 = cy * CHUNK
  const x1 = x0 + CHUNK
  const z1 = z0 + CHUNK
  const cKey = chunkKey(cx, cy)
  const prefix = `c${cx}_${cy}`

  const buildings: Building[] = []
  const barriers: Barrier[] = []
  const doors: Door[] = []
  const windows: WindowOpening[] = []
  const props: Prop[] = []
  const lamps: Lamp[] = []
  const vehicles: Rect[] = []

  // Road corridors in this chunk:
  // If lx === 1, North-South road runs along local X = [6..18] (carriageway [8..16], sidewalks [6..8] & [16..18]).
  // If ly === 1, East-West road runs along local Z = [6..18] (carriageway [8..16], sidewalks [6..8] & [16..18]).
  const inRoadBand = (px: number, pz: number, pad = 0): boolean => {
    const locX = px - x0
    const locZ = pz - z0
    if (lx === 1 && locX >= 6 - pad && locX <= 18 + pad) return true
    if (ly === 1 && locZ >= 6 - pad && locZ <= 18 + pad) return true
    return false
  }

  // 1. Streetlamps along arterial roads in this chunk
  if (lx === 1 && ly === 1) {
    lamps.push({ x: x0 + 6.2, y: z0 + 5.8, h: 3.55, radius: 5.8, power: 0.28, kind: "street" })
    lamps.push({ x: x0 + 18.2, y: z0 + 18.2, h: 3.55, radius: 5.8, power: 0.28, kind: "street" })
  } else if (lx === 1) {
    lamps.push({ x: x0 + 6.2, y: z0 + 10.0, h: 3.55, radius: 5.8, power: 0.28, kind: "street" })
    lamps.push({ x: x0 + 18.2, y: z0 + 22.0, h: 3.55, radius: 5.8, power: 0.28, kind: "street" })
  } else if (ly === 1) {
    lamps.push({ x: x0 + 10.0, y: z0 + 6.2, h: 3.55, radius: 5.8, power: 0.28, kind: "street" })
    lamps.push({ x: x0 + 22.0, y: z0 + 18.2, h: 3.55, radius: 5.8, power: 0.28, kind: "street" })
  }

  // 2. Building / POI placement in the chunk's buildable lot
  const archetype = chooseArchetype(district, lx, ly, rng)
  if (archetype) {
    // Choose a buildable rectangle inside [x0+3 .. x1-3, z0+3 .. z1-3] that stays clear of the road corridor!
    let bx0 = x0 + 5
    let bz0 = z0 + 4.5
    let bw = 15
    let bd = 11.5

    if (lx === 1) {
      // N-S road uses local X [6..18]; place building on the east side [19.2 .. 29.5]
      bx0 = x0 + 19.2
      bw = 10.2
      bz0 = ly === 0 ? z0 + 17.5 : z0 + 4.5
      bd = 12.0
    } else if (ly === 1) {
      // E-W road uses local Z [6..18]; place building on the south side [19.2 .. 29.6]
      bx0 = lx === 0 ? x0 + 13.5 : x0 + 3.5
      bw = archetype === "warehouse" || archetype === "diner" || archetype === "hardware" ? 16.0 : 15.0
      bz0 = z0 + 19.2
      bd = 10.4
    } else if (ly === 0) {
      // North of E-W street: place building at south of chunk (z0 + 18..30) so its frontage faces the main E-W street!
      bx0 = lx === 0 ? x0 + 13.5 : x0 + 3.5
      bw = archetype === "warehouse" ? 16.0 : 15.0
      bz0 = z0 + 18.2
      bd = 11.4
    } else {
      // South corner chunk (ly === 2): place near north of chunk
      bx0 = lx === 0 ? x0 + 13.5 : x0 + 3.5
      bw = archetype === "warehouse" ? 16.0 : 15.0
      bz0 = z0 + 4.5
      bd = 11.4
    }

    const bRect: Rect = [bx0, bz0, bx0 + bw, bz0 + bd]
    const bId = `${prefix}-${archetype}`
    const color = hRng.pick(ARCHETYPE_PALETTES[archetype])
    const structuralKind: Building["kind"] =
      archetype === "house" || archetype === "ranch" || archetype === "cottage" || archetype === "cabin"
        ? "house"
        : archetype === "pharmacy" || archetype === "clinic" || archetype === "police"
          ? "pharmacy"
          : "hardware"

    // Use rectangular footprint for smaller or commercial lots so walls and roofs align cleanly
    const useLPlan = structuralKind === "house" && bw >= 14.5 && bd >= 11.0
    const footprint: readonly Rect[] = useLPlan
      ? [
          [bRect[0], bRect[1] + 5.5, bRect[2], bRect[3]],
          [bRect[0] + 2, bRect[1], bRect[0] + 9.5, bRect[1] + 5.5],
          [bRect[0] + 9.5, bRect[1] + 1.5, bRect[2], bRect[1] + 5.5],
        ]
      : [bRect]

    buildings.push({
      id: bId,
      kind: useLPlan ? "house" : structuralKind === "house" ? "hardware" : structuralKind,
      archetype,
      district,
      rect: bRect,
      color,
      footprint,
      chunkKey: cKey,
    })

    const wall = (rect: Rect, kind: Barrier["kind"] = "wall", col = color) => barriers.push({ rect, color: col, kind })
    const addWindow = (winSuffix: string, wRect: Rect, openable = true) => {
      wall(wRect, "window")
      windows.push({
        id: `${bId}-${winSuffix}`,
        buildingId: bId,
        buildingIndex: 0,
        rect: wRect,
        open: false,
        openable,
      })
    }

    const [x, y, r, b] = bRect
    const doorX = x + Math.min(5.0, Math.max(2.6, (r - x) * 0.42))
    const split = y + Math.min(5.5, (b - y) * 0.5)

    // South façade (frontage with front door and windows)
    wall([x, b - 0.22, x + 1.2, b])
    addWindow("south-west", [x + 1.2, b - 0.22, Math.max(x + 2.4, doorX - 0.4), b], true)
    wall([Math.max(x + 2.4, doorX - 0.4), b - 0.22, doorX, b])
    doors.push({
      id: `${bId}-front`,
      rect: [doorX, b - 0.22, doorX + 1.4, b],
      open: false,
      ...(archetype === "police" || archetype === "warehouse" ? { locked: rng.next() < 0.35 } : {}),
    })
    const winEast0 = Math.min(r - 3.2, doorX + 2.0)
    wall([doorX + 1.4, b - 0.22, winEast0, b])
    addWindow("south-east", [winEast0, b - 0.22, r - 1.2, b], true)
    wall([r - 1.2, b - 0.22, r, b])

    if (useLPlan) {
      const bxL0 = x + 2
      const bxL1 = x + 9.5
      wall([bxL0, y, bxL1, y + 0.22])
      wall([bxL0, y, bxL0 + 0.22, split])
      wall([bxL1 - 0.22, y, bxL1, split])
      wall([bxL1, y + 1.5, r, y + 1.72])
      wall([x, split, bxL0 + 0.22, split + 0.2])
      wall([bxL0 + 0.22, split, doorX, split + 0.2])
      doors.push({ id: `${bId}-room`, rect: [doorX, split, doorX + 1.4, split + 0.2], open: false })
      wall([doorX + 1.4, split, bxL1, split + 0.2])
      wall([bxL1 - 0.22, split, r - 0.22, split + 0.22])
      wall([x, split, x + 0.22, b])
      wall([r - 0.22, y + 1.5, r, y + 4])
      addWindow("east", [r - 0.22, y + 4, r, y + 6.5], true)
      wall([r - 0.22, y + 6.5, r, b])
    } else {
      // Rectangular multi-room plan with north back door or east window
      wall([x, y, r, y + 0.22])
      wall([x, y, x + 0.22, b])
      wall([r - 0.22, y, r, y + 3.2])
      addWindow("east", [r - 0.22, y + 3.2, r, Math.min(b - 1.5, y + 5.6)], true)
      wall([r - 0.22, Math.min(b - 1.5, y + 5.6), r, b])
      wall([x, split, doorX, split + 0.2])
      doors.push({ id: `${bId}-room`, rect: [doorX, split, doorX + 1.4, split + 0.2], open: false })
      wall([doorX + 1.4, split, r, split + 0.2])
    }

    // Interior furniture & lootable props tailored to building archetype
    const addProp = (px: number, py: number, kind: Prop["kind"]) => {
      props.push({ x: Number(px.toFixed(2)), y: Number(py.toFixed(2)), kind, variant: rng.next() })
    }

    if (archetype === "house" || archetype === "ranch" || archetype === "cottage" || archetype === "cabin") {
      const northX = useLPlan ? x + 3.85 : x + 2.2
      addProp(northX, y + 2.0, "bed")
      addProp(Math.min(r - 1.8, northX + 3.4), y + 0.95, "dresser")
      addProp(northX - 1.1, y + 1.1, "nightstand")
      addProp(x + 1.35, split + 0.85, "shelf")
      addProp(x + 1.2, b - 2.2, "sofa")
      addProp(x + 2.6, b - 2.2, "coffee")
      addProp(r - 0.9, b - 2.0, "counter")
      addProp(r - 0.9, b - 3.8, "fridge")
      addProp(r - 0.9, b - 0.75, "stove")
      addProp(Math.max(x + 4.2, r - 3.1), b - 2.6, "table")
      addProp(Math.max(x + 4.2, r - 3.1), b - 1.6, "chair")
    } else if (archetype === "diner") {
      // Diner booths, kitchen counter, stoves & fridges
      addProp(x + 2.0, b - 2.0, "table")
      addProp(x + 2.0, b - 1.1, "chair")
      addProp(x + 2.0, b - 2.9, "chair")
      addProp(Math.min(r - 2.2, x + 5.4), b - 2.0, "table")
      addProp(r - 1.0, b - 2.2, "counter")
      addProp(r - 1.0, y + 1.8, "fridge")
      addProp(x + 2.0, y + 1.4, "stove")
      addProp(Math.min(r - 2.0, x + 4.8), y + 1.4, "shelf")
    } else if (archetype === "police" || archetype === "clinic") {
      // Front desk counter, evidence/medical lockers (shelves + dressers), cots (beds)
      addProp(x + 2.2, b - 2.2, "counter")
      addProp(r - 1.6, b - 2.2, "table")
      addProp(r - 1.6, b - 1.2, "chair")
      addProp(x + 2.0, y + 1.5, "shelf")
      addProp(Math.min(r - 2.0, x + 4.8), y + 1.5, "dresser")
      if (archetype === "clinic") addProp(Math.min(r - 1.8, x + 7.4), y + 2.0, "bed")
      else addProp(Math.min(r - 1.8, x + 7.4), y + 1.5, "shelf")
    } else if (archetype === "church") {
      // Rows of nave benches/tables + altar counter + vestry shelf
      for (const px of [x + 2.2, Math.min(r - 2.2, x + 6.4)]) {
        addProp(px, b - 2.0, "table")
        addProp(px, b - 3.6, "table")
      }
      addProp((x + r) * 0.5, y + 1.6, "counter")
      addProp(r - 1.5, y + 1.4, "shelf")
    } else {
      // hardware, pharmacy, grocery, gas_station, warehouse: stocked aisles & counters
      for (let px = x + 2.0; px < r - 1.4; px += 3.1) {
        addProp(px, y + 1.8, "shelf")
        if (b - split > 4.2) addProp(px, b - 2.8, "shelf")
      }
      addProp(r - 1.1, b - 1.8, "counter")
      if (archetype === "grocery" || archetype === "gas_station") {
        addProp(x + 1.2, b - 1.8, "fridge")
      }
    }

    // Practical lamps for the building
    lamps.push({ x: doorX + 0.7, y: b + 0.55, h: 2.42, radius: 8.8, power: 1.05, kind: "porch" })
    lamps.push({ x: x + 2.4, y: y + 1.4, h: 1.08, radius: 3.6, power: 0.3, kind: "room" })
    lamps.push({ x: x + 2.1, y: b - 1.8, h: 2.32, radius: 4.6, power: 0.44, kind: "room" })
    lamps.push({ x: r - 2.4, y: b - 2.6, h: 2.38, radius: 4.5, power: 0.36, kind: "room" })
    lamps.push({ x: (x + r) * 0.5, y: y + 2.5, h: 2.38, radius: 4.2, power: 0.32, kind: "room" })
    lamps.push({ x: x + 2.2, y: b + 0.12, h: 1.45, radius: 3.5, power: 0.44, kind: "window" })

    // Yard / perimeter fence segment
    if (district === "suburb" || district === "industrial" || archetype === "church") {
      const fy = Math.max(z0 + 1.8, y - 2.2)
      if (!inRoadBand(x, fy, 1.0)) {
        wall([x - 1.2, fy, Math.min(x1 - 2.0, r + 1.2), fy + 0.12], "fence", 0x756b51)
      }
    }
  }

  // 3. Parked or abandoned vehicles on roads / driveways (staying clear of main driving lane center)
  if ((lx === 1 || ly === 1) && rng.next() < 0.55) {
    if (ly === 1 && lx !== 1) {
      const vx = x0 + 8 + rng.next() * 14
      const vz = z0 + (rng.next() < 0.5 ? 8.4 : 13.8)
      vehicles.push([Number(vx.toFixed(2)), Number(vz.toFixed(2)), Number((vx + 3.9).toFixed(2)), Number((vz + 2.0).toFixed(2))])
    } else if (lx === 1 && ly !== 1) {
      const vx = x0 + (rng.next() < 0.5 ? 8.4 : 13.8)
      const vz = z0 + 8 + rng.next() * 14
      vehicles.push([Number(vx.toFixed(2)), Number(vz.toFixed(2)), Number((vx + 2.0).toFixed(2)), Number((vz + 3.9).toFixed(2))])
    }
  }

  // 4. Exterior trees (denser in woodland & suburb, sparser in industrial/commercial)
  const treeTarget =
    district === "woodland" ? 14 : district === "suburb" ? 8 : district === "civic" ? 6 : district === "commercial" ? 4 : 3
  for (let i = 0; i < treeTarget * 2 && props.filter((p) => p.kind === "tree").length < treeTarget; i++) {
    const tx = x0 + 2.5 + rng.next() * (CHUNK - 5.0)
    const tz = z0 + 2.5 + rng.next() * (CHUNK - 5.0)
    if (inRoadBand(tx, tz, 1.8)) continue
    if (buildings.some((b) => distToRect(tx, tz, b.rect) < 3.6)) continue
    if (vehicles.some((v) => distToRect(tx, tz, v) < 2.2)) continue
    props.push({ x: Number(tx.toFixed(2)), y: Number(tz.toFixed(2)), kind: "tree", variant: Number(rng.next().toFixed(4)) })
  }

  // 5. Build deterministic loot containers for this chunk with chunk-prefixed IDs
  const searchableKinds = new Set<Prop["kind"]>(["dresser", "shelf", "nightstand", "counter", "fridge"])
  const labelMap: Partial<Record<Prop["kind"], string>> = {
    dresser: "dresser drawers",
    shelf: "supply shelf",
    nightstand: "nightstand",
    counter: "kitchen cabinet",
    fridge: "refrigerator",
  }
  const lootRng = new Rng((chunkSeed ^ 0x5c3e19a7) >>> 0)
  const containers: LootContainer[] = []
  for (let i = 0; i < props.length; i++) {
    const p = props[i]!
    if (!searchableKinds.has(p.kind)) continue
    const shape = propShape(p)
    if (!shape) continue
    const bld = buildings.find((b) => p.x >= b.rect[0] && p.x <= b.rect[2] && p.y >= b.rect[1] && p.y <= b.rect[3])
    const arch = bld?.archetype ?? bld?.kind
    const roll = lootRng.next()
    let ammo = 0
    let planks = 0
    if (arch === "police") {
      ammo = roll < 0.85 ? 5 + lootRng.int(6) : 2
      planks = roll > 0.65 ? 1 : 0
    } else if (arch === "warehouse" || arch === "hardware") {
      planks = roll < 0.85 ? 2 + lootRng.int(3) : 1
      ammo = roll > 0.45 ? 3 + lootRng.int(4) : 0
    } else if (arch === "pharmacy" || arch === "clinic") {
      ammo = roll < 0.75 ? 4 + lootRng.int(5) : 0
      planks = roll > 0.65 ? 1 : 0
    } else {
      ammo = roll < 0.65 ? 3 + lootRng.int(5) : 0
      planks = roll > 0.55 ? 1 + lootRng.int(2) : 0
    }
    containers.push({
      id: `${prefix}-loot-${i}`,
      propIndex: i,
      kind: p.kind,
      label: labelMap[p.kind] ?? p.kind,
      rect: shape.rect,
      x: p.x,
      y: p.y,
      buildingId: bld?.id ?? null,
      searched: false,
      ammo,
      planks,
    })
  }

  // 6. Deterministic per-chunk zombie spawns (outside buildings, clear of obstacles)
  const zRng = new Rng((chunkSeed ^ 0x7a4f9b13) >>> 0)
  const baseId = chunkZombieIdBase(cx, cy)
  const zombieTarget = district === "commercial" || district === "civic" ? 4 : district === "woodland" ? 2 : 3
  const zombieSpawns: ZombieSpawnSpec[] = []
  for (let attempt = 0; attempt < zombieTarget * 5 && zombieSpawns.length < zombieTarget; attempt++) {
    const zx = x0 + 4 + zRng.next() * (CHUNK - 8)
    const zy = z0 + 4 + zRng.next() * (CHUNK - 8)
    if (buildings.some((b) => zx >= b.rect[0] - 0.6 && zx <= b.rect[2] + 0.6 && zy >= b.rect[1] - 0.6 && zy <= b.rect[3] + 0.6)) continue
    if (vehicles.some((v) => distToRect(zx, zy, v) < 0.8)) continue
    const id = baseId + zombieSpawns.length
    zombieSpawns.push({
      id,
      seed: (seed ^ Math.imul(id + 17, 0x85ebca6b)) >>> 0,
      x: Number(zx.toFixed(2)),
      y: Number(zy.toFixed(2)),
      aim: Number(zRng.range(-Math.PI, Math.PI).toFixed(3)),
    })
  }

  const partial: Omit<WorldChunk, "hash"> = {
    key: cKey,
    cx,
    cy,
    bx,
    by,
    lx,
    ly,
    district,
    bounds: [x0, z0, x1, z1],
    buildings,
    barriers,
    doors,
    windows,
    props,
    lamps,
    vehicles,
    containers,
    zombieSpawns,
  }
  return { ...partial, hash: hashWorldChunk(partial) }
}

const CELL_FREE = 0
const CELL_BLOCKED = 1
const CELL_CLOSED_DOOR = 2
const CELL_OPEN_WINDOW = 3
const CELL_BARRICADED = 4

/**
 * Rasterizes a single 32×32 m chunk's obstacles and portals into a 64×64 (`0.5 m` cell) walkability tile.
 */
export function buildChunkNavTile(
  chunk: WorldChunk,
  portalPlanks: (id: string) => number,
  agentRadius = 0.28,
  out: Uint8Array<ArrayBuffer> = new Uint8Array(64 * 64),
): Uint8Array<ArrayBuffer> {
  out.fill(CELL_FREE)
  const cell = 0.5
  const pad = agentRadius + 0.02
  const ox = chunk.cx * CHUNK
  const oy = chunk.cy * CHUNK

  const stampBlocked = (r: Rect) => {
    const x0 = Math.max(0, Math.ceil((r[0] - ox - pad) / cell - 0.5))
    const x1 = Math.min(63, Math.floor((r[2] - ox + pad) / cell - 0.5))
    const y0 = Math.max(0, Math.ceil((r[1] - oy - pad) / cell - 0.5))
    const y1 = Math.min(63, Math.floor((r[3] - oy + pad) / cell - 0.5))
    for (let cy = y0; cy <= y1; cy++) {
      out.fill(CELL_BLOCKED, cy * 64 + x0, cy * 64 + x1 + 1)
    }
  }

  for (const b of chunk.barriers) stampBlocked(b.rect)
  for (const p of chunk.props) {
    const s = propShape(p)
    if (s) stampBlocked(s.rect)
  }
  for (const v of chunk.vehicles) stampBlocked(v)

  const carvePortal = (rect: Rect, kind: "door" | "window", open: boolean, planks: number) => {
    const horizontal = rect[2] - rect[0] > rect[3] - rect[1]
    const barricaded = planks > 0
    let code = CELL_BLOCKED
    if (kind === "door") code = barricaded ? CELL_BARRICADED : open ? CELL_FREE : CELL_CLOSED_DOOR
    else code = barricaded ? CELL_BARRICADED : open ? CELL_OPEN_WINDOW : CELL_BLOCKED
    if (code === CELL_BLOCKED) return
    const box: Rect = horizontal
      ? [rect[0] + 0.18, rect[1] - 0.42, rect[2] - 0.18, rect[3] + 0.42]
      : [rect[0] - 0.42, rect[1] + 0.18, rect[2] + 0.42, rect[3] - 0.18]
    const x0 = Math.max(0, Math.floor((box[0] - ox) / cell))
    const x1 = Math.min(63, Math.floor((box[2] - ox) / cell))
    const y0 = Math.max(0, Math.floor((box[1] - oy) / cell))
    const y1 = Math.min(63, Math.floor((box[3] - oy) / cell))
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        out[cy * 64 + cx] = code
      }
    }
  }

  for (const d of chunk.doors) carvePortal(d.rect, "door", d.open, portalPlanks(d.id))
  for (const w of chunk.windows) carvePortal(w.rect, "window", w.open, portalPlanks(w.id))
  return out
}

/**
 * Computes the set of active chunk coordinates for a list of survivor centers.
 * Uses a 4 m hysteresis margin around the current center chunk per survivor so crossing a boundary does not thrash.
 */
export function selectActiveWindowCenter(
  x: number,
  y: number,
  prevCenter?: ChunkCoord,
  edgeMargin = 10.0,
): ChunkCoord {
  const inOrigin = x >= edgeMargin && x <= MACRO_SIZE - edgeMargin && y >= edgeMargin && y <= MACRO_SIZE - edgeMargin
  if (!prevCenter) {
    return inOrigin ? { cx: 1, cy: 1 } : worldToChunk(x, y)
  }
  const winMinX = (prevCenter.cx - 1) * CHUNK + edgeMargin
  const winMaxX = (prevCenter.cx + 2) * CHUNK - edgeMargin
  const winMinY = (prevCenter.cy - 1) * CHUNK + edgeMargin
  const winMaxY = (prevCenter.cy + 2) * CHUNK - edgeMargin
  const outX = x < winMinX || x > winMaxX
  const outY = y < winMinY || y > winMaxY
  if ((outX || outY) && inOrigin) return { cx: 1, cy: 1 }
  const cx = outX ? Math.floor(x / CHUNK) : prevCenter.cx
  const cy = outY ? Math.floor(y / CHUNK) : prevCenter.cy
  return { cx, cy }
}

/**
 * Authoritative & client-side chunk streaming state manager.
 * Keeps active chunks loaded around all survivors, persists modified-chunk deltas (`doors`, `windows`,
 * `barricades`, `searched` containers, and `zombies` / aggregate population), and updates `Town` in place.
 */
export class StreamingWorld {
  mode: WorldMode
  readonly activeChunks = new Map<string, WorldChunk>()
  readonly deltas = new Map<string, ChunkDelta>()
  readonly navTiles = new Map<string, Uint8Array<ArrayBuffer>>()
  private readonly navTilePool: Uint8Array<ArrayBuffer>[] = []
  private readonly navTileDigests = new Map<string, number>()
  private readonly centers = new Map<string, ChunkCoord>()
  private readonly chunkCache = new Map<string, WorldChunk>()
  private readonly maxTemplateCache = 36
  /** Increments whenever the active chunk set changes. */
  windowRevision = 0

  constructor(
    readonly seed: number,
    public houseSeed = seed,
    public terrain = 0.22,
    mode: WorldMode = "streaming",
  ) {
    this.mode = mode
    // Pre-populate the initial 3×3 block (0..2, 0..2)
    for (let cy = 0; cy < 3; cy++) {
      for (let cx = 0; cx < 3; cx++) {
        const ch = this.getOrGenerateChunk(cx, cy)
        this.activeChunks.set(ch.key, ch)
      }
    }
  }

  get isClassicFixed(): boolean {
    return this.mode === "classic" && this.activeChunks.size === 9 && this.isOriginNineOnly()
  }

  isOriginNineOnly(): boolean {
    if (this.activeChunks.size !== 9 || this.mode === "procedural") return false
    for (let cy = 0; cy < 3; cy++) {
      for (let cx = 0; cx < 3; cx++) {
        if (!this.activeChunks.has(chunkKey(cx, cy))) return false
      }
    }
    return true
  }

  getOrGenerateChunk(cx: number, cy: number): WorldChunk {
    const cacheKey = `${this.seed}:${this.houseSeed}:${this.mode}:${cx},${cy}`
    let base = this.chunkCache.get(cacheKey)
    if (base) {
      this.chunkCache.delete(cacheKey)
      this.chunkCache.set(cacheKey, base)
    } else {
      base = generateWorldChunk(this.seed, this.houseSeed, cx, cy, this.mode)
      if (this.chunkCache.size >= this.maxTemplateCache) {
        this.chunkCache.delete(this.chunkCache.keys().next().value!)
      }
      this.chunkCache.set(cacheKey, base)
    }
    // Share immutable structural arrays; only clone mutable door/window/container records
    return {
      ...base,
      doors: base.doors.map((d) => ({ ...d })),
      windows: base.windows.map((w) => ({ ...w })),
      containers: base.containers.map((c) => ({ ...c })),
    }
  }

  private getBaseChunk(cx: number, cy: number): WorldChunk {
    const cacheKey = `${this.seed}:${this.houseSeed}:${this.mode}:${cx},${cy}`
    let base = this.chunkCache.get(cacheKey)
    if (!base) {
      base = generateWorldChunk(this.seed, this.houseSeed, cx, cy, this.mode)
      if (this.chunkCache.size >= this.maxTemplateCache) {
        this.chunkCache.delete(this.chunkCache.keys().next().value!)
      }
      this.chunkCache.set(cacheKey, base)
    }
    return base
  }

  private computeChunkPortalDigest(
    ch: WorldChunk,
    portalStates: ReadonlyMap<string, { barricadePlanks: number }>,
  ): number {
    let h = 2166136261 >>> 0
    for (let i = 0; i < ch.doors.length; i++) {
      const d = ch.doors[i]!
      const p = portalStates.get(d.id)?.barricadePlanks ?? 0
      h = Math.imul(h ^ ((d.open ? 1 : 0) | ((d.locked ? 1 : 0) << 1) | (p << 2)), 16777619) >>> 0
    }
    for (let i = 0; i < ch.windows.length; i++) {
      const w = ch.windows[i]!
      const p = portalStates.get(w.id)?.barricadePlanks ?? 0
      h = Math.imul(h ^ ((w.open ? 1 : 0) | ((w.openable ? 1 : 0) << 1) | (p << 2)), 16777619) >>> 0
    }
    return h >>> 0
  }

  private updateChunkNavTile(
    ch: WorldChunk,
    portalStates: ReadonlyMap<string, { barricadePlanks: number }>,
  ): void {
    const digest = this.computeChunkPortalDigest(ch, portalStates)
    const existing = this.navTiles.get(ch.key)
    if (existing && this.navTileDigests.get(ch.key) === digest) return
    const out = existing ?? this.navTilePool.pop() ?? new Uint8Array(64 * 64)
    this.navTiles.set(
      ch.key,
      buildChunkNavTile(ch, (id) => portalStates.get(id)?.barricadePlanks ?? 0, 0.28, out),
    )
    this.navTileDigests.set(ch.key, digest)
  }

  private clearNavTiles(): void {
    for (const tile of this.navTiles.values()) this.navTilePool.push(tile)
    this.navTiles.clear()
    this.navTileDigests.clear()
  }

  ensureDelta(cx: number, cy: number): ChunkDelta {
    const key = chunkKey(cx, cy)
    let d = this.deltas.get(key)
    if (!d) {
      d = {
        key,
        cx,
        cy,
        doors: {},
        windows: {},
        searched: {},
        zombies: {},
        aggregateZombies: 0,
        visited: false,
      }
      this.deltas.set(key, d)
    }
    return d
  }

  /** Captures live modifications from an active chunk into `this.deltas` before unloading or snapshotting. */
  captureChunkDelta(
    chunk: WorldChunk,
    town: Town,
    containers: readonly LootContainer[],
    portalStates: ReadonlyMap<string, { integrity: number; barricadePlanks: number; barricadeHp: number }>,
    agents: readonly AIAgent[],
  ): ChunkDelta | undefined {
    const base = this.getBaseChunk(chunk.cx, chunk.cy)
    const existingDelta = this.deltas.get(chunk.key)
    let modified = existingDelta !== undefined

    for (let i = 0; i < chunk.doors.length; i++) {
      const cd = chunk.doors[i]!
      const bd = base.doors[i] ?? cd
      const liveDoor = town.doors.find((d) => d.id === cd.id) ?? cd
      const pst = portalStates.get(cd.id)
      const planks = pst?.barricadePlanks ?? 0
      const integrity = pst?.integrity ?? 100
      if (liveDoor.open !== bd.open || liveDoor.locked !== bd.locked || planks > 0 || integrity < 100) {
        modified = true
        break
      }
    }

    if (!modified) {
      for (let i = 0; i < chunk.windows.length; i++) {
        const cw = chunk.windows[i]!
        const bw = base.windows[i] ?? cw
        const liveWin = town.windows.find((w) => w.id === cw.id) ?? cw
        const pst = portalStates.get(cw.id)
        const planks = pst?.barricadePlanks ?? 0
        if (liveWin.open !== bw.open || liveWin.openable !== bw.openable || planks > 0) {
          modified = true
          break
        }
      }
    }

    if (!modified) {
      for (let i = 0; i < chunk.containers.length; i++) {
        const cc = chunk.containers[i]!
        const liveC = containers.find((c) => c.id === cc.id) ?? cc
        if (liveC.searched) {
          modified = true
          break
        }
      }
    }

    const [x0, y0, x1, y1] = chunk.bounds
    if (!modified) {
      for (let i = 0; i < agents.length; i++) {
        const a = agents[i]!
        const inBounds = a.x >= x0 && a.x < x1 && a.y >= y0 && a.y < y1
        const spawnSpec = chunk.zombieSpawns.find((s) => s.id === a.id)
        if (!inBounds && !spawnSpec) continue
        if (
          !spawnSpec ||
          a.state === "dead" ||
          a.hp < a.maxHp ||
          a.detachedLimbs.length > 0
        ) {
          modified = true
          break
        }
      }
    }

    if (!modified) return undefined

    const delta = this.ensureDelta(chunk.cx, chunk.cy)
    delta.visited = true

    for (let i = 0; i < chunk.doors.length; i++) {
      const cd = chunk.doors[i]!
      const bd = base.doors[i] ?? cd
      const liveDoor = town.doors.find((d) => d.id === cd.id) ?? cd
      const pst = portalStates.get(cd.id)
      const planks = pst?.barricadePlanks ?? 0
      const integrity = pst?.integrity ?? 100
      if (liveDoor.open !== bd.open || liveDoor.locked !== bd.locked || planks > 0 || integrity < 100) {
        delta.doors[cd.id] = {
          open: liveDoor.open,
          ...(liveDoor.locked !== undefined ? { locked: liveDoor.locked } : {}),
          ...(planks > 0 ? { planks, plankHp: pst?.barricadeHp ?? planks * 100 } : {}),
          ...(integrity < 100 ? { integrity } : {}),
        }
      } else {
        delete delta.doors[cd.id]
      }
    }

    for (let i = 0; i < chunk.windows.length; i++) {
      const cw = chunk.windows[i]!
      const bw = base.windows[i] ?? cw
      const liveWin = town.windows.find((w) => w.id === cw.id) ?? cw
      const pst = portalStates.get(cw.id)
      const planks = pst?.barricadePlanks ?? 0
      if (liveWin.open !== bw.open || liveWin.openable !== bw.openable || planks > 0) {
        delta.windows[cw.id] = {
          open: liveWin.open,
          openable: liveWin.openable,
          ...(planks > 0 ? { planks, plankHp: pst?.barricadeHp ?? planks * 100 } : {}),
        }
      } else {
        delete delta.windows[cw.id]
      }
    }

    for (let i = 0; i < chunk.containers.length; i++) {
      const cc = chunk.containers[i]!
      const liveC = containers.find((c) => c.id === cc.id) ?? cc
      if (liveC.searched) {
        delta.searched[cc.id] = true
      }
    }

    let livingCount = 0
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i]!
      const inBounds = a.x >= x0 && a.x < x1 && a.y >= y0 && a.y < y1
      const isSpawnedHere = chunk.zombieSpawns.some((s) => s.id === a.id)
      if (!inBounds && !isSpawnedHere) continue
      if (a.state !== "dead") livingCount++
      delta.zombies[a.id] = {
        id: a.id,
        seed: a.seed,
        x: Number(a.x.toFixed(2)),
        y: Number(a.y.toFixed(2)),
        aim: Number(a.aim.toFixed(3)),
        state: a.state,
        hp: a.hp,
        detachedLimbs: a.detachedLimbs.length > 0 ? [...a.detachedLimbs] : [],
      }
    }
    delta.aggregateZombies = livingCount
    return delta
  }

  /** Applies saved `ChunkDelta` state onto a freshly loaded `WorldChunk`. */
  applyDeltaToChunk(
    chunk: WorldChunk,
    portalStates: Map<string, { integrity: number; barricadePlanks: number; barricadeHp: number; lastBashTime: number }>,
  ): void {
    const delta = this.deltas.get(chunk.key)
    for (const d of chunk.doors) {
      const dd = delta?.doors[d.id]
      if (dd) {
        d.open = dd.open
        if (dd.locked !== undefined) d.locked = dd.locked
      }
      portalStates.set(d.id, {
        integrity: dd?.integrity ?? 100,
        barricadePlanks: dd?.planks ?? 0,
        barricadeHp: dd?.plankHp ?? (dd?.planks ?? 0) * 100,
        lastBashTime: portalStates.get(d.id)?.lastBashTime ?? -Infinity,
      })
    }
    for (const w of chunk.windows) {
      const wd = delta?.windows[w.id]
      if (wd) {
        w.open = wd.open
        w.openable = wd.openable
      }
      portalStates.set(w.id, {
        integrity: 100,
        barricadePlanks: wd?.planks ?? 0,
        barricadeHp: wd?.plankHp ?? (wd?.planks ?? 0) * 100,
        lastBashTime: portalStates.get(w.id)?.lastBashTime ?? -Infinity,
      })
    }
    for (const c of chunk.containers) {
      if (delta?.searched[c.id]) c.searched = true
    }
  }

  getSurvivorWindowCenter(id: string, x: number, y: number): ChunkCoord {
    return this.centers.get(id) ?? selectActiveWindowCenter(x, y)
  }

  /** Fast zero-allocation check whether any survivor has crossed their active 3×3 chunk window hysteresis boundary. */
  wouldWindowsChange(survivors: readonly { id: string; x: number; y: number }[]): boolean {
    if (this.mode === "classic") {
      const outsideClassic = survivors.some((s) => s.x < 4 || s.x > SIZE - 4 || s.y < 4 || s.y > SIZE - 4)
      if (!outsideClassic && this.isOriginNineOnly()) return false
    }
    if (survivors.length === 0) return !this.isOriginNineOnly()
    if (survivors.length !== this.centers.size) return true
    for (const s of survivors) {
      const prev = this.centers.get(s.id)
      if (!prev) return true
      const next = selectActiveWindowCenter(s.x, s.y, prev)
      if (next.cx !== prev.cx || next.cy !== prev.cy) return true
    }
    return false
  }

  /**
   * Updates the active chunk set around `survivors` (`3×3` window per survivor).
   * Returns `{ changed, loaded, unloaded }` when chunks enter or leave the active set.
   */
  updateActiveWindows(
    survivors: readonly { id: string; x: number; y: number }[],
    town: Town,
    containers: LootContainer[],
    portalStates: Map<string, { integrity: number; barricadePlanks: number; barricadeHp: number; lastBashTime: number }>,
    agents: AIAgent[],
    spawnAgent: (id: number, seed: number, x: number, y: number, aim: number) => AIAgent,
    radiusChunks = 1,
  ): { changed: boolean; loaded: WorldChunk[]; unloaded: string[] } {
    if (this.mode === "classic") {
      // Check if any survivor walked outside [4..92]; if not, stay in fixed classic mode
      const outsideClassic = survivors.some((s) => s.x < 4 || s.x > SIZE - 4 || s.y < 4 || s.y > SIZE - 4)
      if (!outsideClassic && this.isOriginNineOnly()) {
        return { changed: false, loaded: [], unloaded: [] }
      }
    }

    const desiredKeys = new Set<string>()
    const desiredCoords: ChunkCoord[] = []
    if (survivors.length === 0) {
      for (let cy = 0; cy < 3; cy++) {
        for (let cx = 0; cx < 3; cx++) {
          const k = chunkKey(cx, cy)
          desiredKeys.add(k)
          desiredCoords.push({ cx, cy })
        }
      }
    } else {
      for (const s of survivors) {
        const prev = this.centers.get(s.id)
        const center = selectActiveWindowCenter(s.x, s.y, prev)
        this.centers.set(s.id, center)
        for (let dy = -radiusChunks; dy <= radiusChunks; dy++) {
          for (let dx = -radiusChunks; dx <= radiusChunks; dx++) {
            const cx = center.cx + dx
            const cy = center.cy + dy
            const k = chunkKey(cx, cy)
            if (!desiredKeys.has(k)) {
              desiredKeys.add(k)
              desiredCoords.push({ cx, cy })
            }
          }
        }
      }
    }

    // Check if the active chunk set actually changed
    if (desiredKeys.size === this.activeChunks.size && [...desiredKeys].every((k) => this.activeChunks.has(k))) {
      return { changed: false, loaded: [], unloaded: [] }
    }

    const unloaded: string[] = []
    for (const [key, chunk] of this.activeChunks) {
      if (!desiredKeys.has(key)) {
        this.captureChunkDelta(chunk, town, containers, portalStates, agents)
        // Remove agents belonging to this unloaded chunk
        const [x0, y0, x1, y1] = chunk.bounds
        for (let i = agents.length - 1; i >= 0; i--) {
          const a = agents[i]!
          const inChunk = a.x >= x0 && a.x < x1 && a.y >= y0 && a.y < y1
          const spawnedInChunk = chunk.zombieSpawns.some((s) => s.id === a.id)
          if (inChunk || spawnedInChunk) {
            agents.splice(i, 1)
          }
        }
        // Clean up unmodified portalStates for unloaded chunks so the map stays bounded
        const hasDelta = this.deltas.has(key)
        if (!hasDelta) {
          for (const d of chunk.doors) portalStates.delete(d.id)
          for (const w of chunk.windows) portalStates.delete(w.id)
        }
        const navTile = this.navTiles.get(key)
        if (navTile) this.navTilePool.push(navTile)
        this.navTiles.delete(key)
        this.navTileDigests.delete(key)
        this.activeChunks.delete(key)
        unloaded.push(key)
      }
    }

    // Also snapshot deltas on currently active chunks if modified
    for (const chunk of this.activeChunks.values()) {
      this.captureChunkDelta(chunk, town, containers, portalStates, agents)
    }

    const loaded: WorldChunk[] = []
    for (const { cx, cy } of desiredCoords) {
      const k = chunkKey(cx, cy)
      if (!this.activeChunks.has(k)) {
        const ch = this.getOrGenerateChunk(cx, cy)
        this.applyDeltaToChunk(ch, portalStates)
        this.activeChunks.set(k, ch)
        loaded.push(ch)

        // Materialize or restore zombies for this newly loaded chunk (outside the classic (0..2,0..2) initial spawn)
        const isClassicOriginChunk = this.mode !== "procedural" && cx >= 0 && cx < 3 && cy >= 0 && cy < 3
        const delta = this.deltas.get(k)
        if (delta?.visited) {
          for (const sz of Object.values(delta.zombies)) {
            if (agents.some((a) => a.id === sz.id)) continue
            const agent = spawnAgent(sz.id, sz.seed, sz.x, sz.y, sz.aim)
            agent.state = sz.state
            agent.hp = sz.hp
            agent.detachedLimbs = sz.detachedLimbs.length > 0 ? [...sz.detachedLimbs] : []
            agents.push(agent)
          }
        } else if (!isClassicOriginChunk) {
          for (const sp of ch.zombieSpawns) {
            if (agents.some((a) => a.id === sp.id)) continue
            if (survivors.some((s) => Math.hypot(s.x - sp.x, s.y - sp.y) < 6.0)) continue
            agents.push(spawnAgent(sp.id, sp.seed, sp.x, sp.y, sp.aim))
          }
        }
      }
    }

    this.syncTownFromActiveChunks(town, containers, portalStates)
    this.windowRevision++
    return { changed: true, loaded, unloaded }
  }

  /** Rebuilds `town` arrays and per-chunk `64×64` nav tiles from the active chunk set. */
  syncTownFromActiveChunks(
    town: Town,
    containers: LootContainer[],
    portalStates: Map<string, { integrity: number; barricadePlanks: number; barricadeHp: number; lastBashTime: number }>,
  ): void {
    // If we are on the exact 9 classic origin chunks (0..2, 0..2) in non-procedural mode, preserve exact `makeTown` ordering!
    if (this.isOriginNineOnly()) {
      const base = makeTown(this.seed, this.houseSeed, this.terrain, town.foliageDensity)
      const prevDoors = new Map(town.doors.map((d) => [d.id, d]))
      const prevWins = new Map(town.windows.map((w) => [w.id, w]))
      for (const ch of this.activeChunks.values()) {
        const delta = this.deltas.get(ch.key)
        if (!delta) continue
        for (const [id, dd] of Object.entries(delta.doors)) {
          if (!prevDoors.has(id)) prevDoors.set(id, { id, rect: [0, 0, 0, 0], open: dd.open, locked: dd.locked })
        }
      }
      town.chunks = base.chunks
      town.buildings = base.buildings
      town.barriers = base.barriers
      town.doors = base.doors.map((d) => {
        const prev = prevDoors.get(d.id)
        const dd = this.deltas.get(chunkKey(Math.floor(d.rect[0] / CHUNK), Math.floor(d.rect[1] / CHUNK)))?.doors[d.id]
        if (prev && prev.rect[2] > prev.rect[0]) {
          if (dd) {
            prev.open = dd.open
            if (dd.locked !== undefined) prev.locked = dd.locked
          }
          return prev
        }
        return {
          ...d,
          open: dd ? dd.open : prev ? prev.open : d.open,
          ...(dd?.locked !== undefined ? { locked: dd.locked } : prev?.locked !== undefined ? { locked: prev.locked } : {}),
        }
      })
      town.windows = base.windows.map((w) => {
        const prev = prevWins.get(w.id)
        const wd = this.deltas.get(chunkKey(Math.floor(w.rect[0] / CHUNK), Math.floor(w.rect[1] / CHUNK)))?.windows[w.id]
        if (prev) {
          if (wd) {
            prev.open = wd.open
            prev.openable = wd.openable
          }
          return prev
        }
        return {
          ...w,
          open: wd ? wd.open : w.open,
          openable: wd ? wd.openable : w.openable,
        }
      })
      town.props = base.props
      town.lamps = base.lamps
      delete town.vehicles
      town.worldBounds = [0, 0, SIZE, SIZE]
      town.windowOrigin = [0, 0]
      delete town.activeChunkKeys

      const prevById = new Map(containers.map((c) => [c.id, c]))
      const prevSearched = new Set(containers.filter((c) => c.searched).map((c) => c.id))
      for (const d of this.deltas.values()) {
        for (const [cid, s] of Object.entries(d.searched)) if (s) prevSearched.add(cid)
      }
      const freshContainers = lootSites(town, DEFAULT_PROGRESSION_TUNING).sites.map((c) => {
        const existing = prevById.get(c.id)
        if (existing) {
          if (prevSearched.has(c.id)) existing.searched = true
          return existing
        }
        if (prevSearched.has(c.id)) c.searched = true
        return { ...c, searched: Boolean(c.searched), ammo: c.ammo ?? 4, planks: c.planks ?? 1 }
      })
      containers.length = 0
      containers.push(...freshContainers)
      this.clearNavTiles()
      return
    }

    const sorted = [...this.activeChunks.values()].sort((a, b) => a.cy - b.cy || a.cx - b.cx)
    const chunks: Rect[] = []
    const buildings: Building[] = []
    const barriers: Barrier[] = []
    const doors: Door[] = []
    const windows: WindowOpening[] = []
    const props: Prop[] = []
    const lamps: Lamp[] = []
    const vehicles: Rect[] = []
    const nextContainers: LootContainer[] = []

    const prevDoors = new Map(town.doors.map((d) => [d.id, d]))
    const prevWins = new Map(town.windows.map((w) => [w.id, w]))
    const prevContainers = new Map(containers.map((c) => [c.id, c]))
    const prevSearched = new Set(containers.filter((c) => c.searched).map((c) => c.id))

    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity

    for (const ch of sorted) {
      chunks.push(ch.bounds)
      minX = Math.min(minX, ch.bounds[0])
      minY = Math.min(minY, ch.bounds[1])
      maxX = Math.max(maxX, ch.bounds[2])
      maxY = Math.max(maxY, ch.bounds[3])

      const delta = this.deltas.get(ch.key)
      for (const b of ch.buildings) {
        buildings.push(b)
      }
      for (const bar of ch.barriers) barriers.push(bar)
      for (const d of ch.doors) {
        const live = prevDoors.get(d.id)
        const dd = delta?.doors[d.id]
        if (live) {
          doors.push(live)
        } else {
          if (dd) {
            d.open = dd.open
            if (dd.locked !== undefined) d.locked = dd.locked
          }
          doors.push(d)
        }
      }
      for (const w of ch.windows) {
        const live = prevWins.get(w.id)
        const wd = delta?.windows[w.id]
        const bIdx = Math.max(0, buildings.findIndex((b) => b.id === w.buildingId))
        if (live) {
          live.buildingIndex = bIdx
          windows.push(live)
        } else {
          w.buildingIndex = bIdx
          if (wd) {
            w.open = wd.open
            w.openable = wd.openable
          }
          windows.push(w)
        }
      }
      for (const p of ch.props) props.push(p)
      for (const l of ch.lamps) lamps.push(l)
      for (const v of ch.vehicles) vehicles.push(v)
      for (const c of ch.containers) {
        const liveC = prevContainers.get(c.id)
        if (liveC) {
          if (delta?.searched[c.id]) liveC.searched = true
          nextContainers.push(liveC)
        } else {
          if (prevSearched.has(c.id) || delta?.searched[c.id]) c.searched = true
          nextContainers.push(c)
        }
      }

      this.updateChunkNavTile(ch, portalStates)
    }

    town.chunks = chunks
    town.buildings = buildings
    town.barriers = barriers
    town.doors = doors
    town.windows = windows
    town.props = props
    town.lamps = lamps
    town.vehicles = vehicles
    town.worldBounds = [minX, minY, maxX, maxY]
    town.windowOrigin = [minX, minY]
    town.activeChunkKeys = sorted.map((c) => c.key)

    containers.length = 0
    containers.push(...nextContainers)
  }

  /** Rebuilds the `64×64` nav tiles for active chunks whose door/window/barricade state changed. */
  rebuildActiveNavTiles(
    town: Town,
    portalStates: ReadonlyMap<string, { barricadePlanks: number }>,
  ): void {
    if (this.isOriginNineOnly()) {
      this.clearNavTiles()
      return
    }
    const doorMap = new Map(town.doors.map((d) => [d.id, d]))
    const winMap = new Map(town.windows.map((w) => [w.id, w]))
    for (const ch of this.activeChunks.values()) {
      for (const d of ch.doors) {
        const live = doorMap.get(d.id)
        if (live) {
          d.open = live.open
          d.locked = live.locked
        }
      }
      for (const w of ch.windows) {
        const live = winMap.get(w.id)
        if (live) {
          w.open = live.open
          w.openable = live.openable
        }
      }
      this.updateChunkNavTile(ch, portalStates)
    }
  }
}
