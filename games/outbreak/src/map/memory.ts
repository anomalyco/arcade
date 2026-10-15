import type { Rect } from "@arcade/kit/sim/geom"
import { hash3 } from "@arcade/kit/sim/rng"
import { buildingFootprint, CHUNK } from "../../shared/map"
import { FOG_CELL, FOG_SIZE } from "../../shared/vision"
import { chunkKey, districtAtBlock, MACRO_CHUNKS, MACRO_SIZE, type DistrictKind, type WorldChunk } from "../../shared/world"

/** Map cells are 1 m: a 2 × 2 block of the 0.5 m vision cells. */
export const MAP_CELL = 1
export const MAP_TILE = CHUNK / MAP_CELL
const SUB = MAP_CELL / FOG_CELL

export type PoiKind =
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
  | "safehouse"

export const POI_LABELS: Readonly<Record<PoiKind, string>> = {
  hardware: "Hardware",
  pharmacy: "Pharmacy",
  grocery: "Grocery",
  diner: "Diner",
  gas_station: "Gas station",
  police: "Police",
  clinic: "Clinic",
  church: "Church",
  warehouse: "Warehouse",
  cabin: "Ranger cabin",
  safehouse: "Safehouse",
}

export type MapBuilding = {
  id: string
  /** Icon category, or null for a plain house. */
  poi: PoiKind | null
  archetype: string
  footprint: readonly Rect[]
  rect: Rect
  x: number
  y: number
  /** Seen from outside or inside: its outline goes on the map in full. */
  known: boolean
}

export type MapChunk = {
  key: string
  cx: number
  cy: number
  lx: number
  ly: number
  bx: number
  by: number
  district: DistrictKind
  /** 32 × 32 one-metre cells, 255 where explored. */
  explored: Uint8Array
  count: number
  revision: number
  buildings: MapBuilding[]
  /** x, y, radius triples. */
  trees: Float32Array
  vehicles: readonly Rect[]
  fences: readonly Rect[]
}

export type Sighting = { key: number; x: number; y: number; count: number; seenAt: number }
export type MapMarker = { id: number; x: number; y: number; label: string }

/** What the map needs from the vision system: the 3 × 3 chunk window of 0.5 m explored cells. */
export type VisionWindow = {
  readonly explored: Uint8Array
  readonly originX: number
  readonly originY: number
  readonly x: number
  readonly y: number
  readonly settings: { range: number }
  /** 64 × 64 tiles Vision saved for chunks that left the window. */
  readonly chunkExplored?: ReadonlyMap<string, Uint8Array>
}

export type ChunkSource = (cx: number, cy: number) => WorldChunk | undefined

const SAFE_PROPS = new Set(["workbench", "stash"])

function poiOf(archetype: string): PoiKind | null {
  switch (archetype) {
    case "hardware":
    case "pharmacy":
    case "grocery":
    case "diner":
    case "gas_station":
    case "police":
    case "clinic":
    case "church":
    case "warehouse":
    case "cabin":
      return archetype
    default:
      return null
  }
}

/** Map-only summary of a generated chunk; the chunk itself can be dropped afterwards. */
export function chunkFeatures(chunk: WorldChunk): Omit<MapChunk, "explored" | "count" | "revision"> {
  const buildings: MapBuilding[] = chunk.buildings.map((b) => {
    const [x0, y0, x1, y1] = b.rect
    const safe = chunk.props.some((p) => SAFE_PROPS.has(p.kind) && p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1)
    const archetype = b.archetype ?? b.kind
    return {
      id: b.id,
      poi: safe ? "safehouse" : poiOf(archetype),
      archetype,
      footprint: buildingFootprint(b).map((r) => [...r] as Rect),
      rect: [...b.rect] as Rect,
      x: (x0 + x1) / 2,
      y: (y0 + y1) / 2,
      known: false,
    }
  })
  const treeList: number[] = []
  for (const p of chunk.props) if (p.kind === "tree") treeList.push(p.x, p.y, 1.8 + p.variant * 0.9)
  const bx = Math.floor(chunk.cx / MACRO_CHUNKS)
  const by = Math.floor(chunk.cy / MACRO_CHUNKS)
  return {
    key: chunk.key,
    cx: chunk.cx,
    cy: chunk.cy,
    lx: ((chunk.cx % MACRO_CHUNKS) + MACRO_CHUNKS) % MACRO_CHUNKS,
    ly: ((chunk.cy % MACRO_CHUNKS) + MACRO_CHUNKS) % MACRO_CHUNKS,
    bx,
    by,
    // The start block's chunks are tagged per building; the map tints the whole block as its district.
    district: bx === 0 && by === 0 ? "suburb" : chunk.district,
    buildings,
    trees: new Float32Array(treeList),
    vehicles: chunk.vehicles.map((v) => [...v] as Rect),
    fences: chunk.barriers.filter((b) => b.kind === "fence").map((b) => [...b.rect] as Rect),
  }
}

const BLOCK_NAMES: Readonly<Record<DistrictKind, readonly string[]>> = {
  suburb: ["Linden Heights", "Maple Rise", "Orchard Hill", "Birch Lane", "Cedar Court", "Willow Green", "Hazel Park", "Juniper Row"],
  commercial: ["Market Row", "Main Street", "Union Strip", "Depot Square", "Exchange Street", "Merchant Way"],
  civic: ["Court Square", "Civic Centre", "Town Green", "Chapel Hill"],
  industrial: ["Rail Yards", "Mill Flats", "Freight Lots", "Tannery Lane", "Coal Wharf"],
  woodland: ["Pine Woods", "Hollow Wood", "Fox Run", "Ridge Copse", "Bracken Hill"],
}

export const DISTRICT_LABELS: Readonly<Record<DistrictKind, string>> = {
  suburb: "Residential",
  commercial: "Commercial",
  civic: "Civic",
  industrial: "Industrial",
  woodland: "Woodland",
}

const nameIndex = (seed: number, bx: number, by: number, n: number) => Math.floor(hash3(bx + 4096, by + 4096, seed ^ 0x2b9d4e1) * n) % n

/**
 * A stable name for the 96 m macro-block `(bx, by)`; block (0, 0) is the Ash and Elm street the game starts on. A block
 * steps past the name its west or north neighbour of the same district drew, so neighbours rarely share one.
 */
export function blockName(seed: number, bx: number, by: number, district: DistrictKind): string {
  if (bx === 0 && by === 0) return "Ash & Elm"
  const names = BLOCK_NAMES[district]
  let i = nameIndex(seed, bx, by, names.length)
  for (const [nx, ny] of [[bx - 1, by], [bx, by - 1]] as const) {
    if (!(nx === 0 && ny === 0) && districtAtBlock(seed, nx, ny) === district && nameIndex(seed, nx, ny, names.length) === i) i = (i + 1) % names.length
  }
  return names[i]!
}

/**
 * Everything the local survivor has learned about the world, kept per 32 m chunk so it scales with distance walked,
 * not world size: 1 m explored cells copied from `Vision`, a compact copy of each explored chunk's layout, last-known
 * zombie sightings and placed markers. Pure data; `MapTiles` turns it into pictures.
 */
export class MapMemory {
  readonly chunks = new Map<string, MapChunk>()
  readonly sightings = new Map<number, Sighting>()
  markers: MapMarker[] = []
  /** Increments when any chunk's explored cells or known buildings change. */
  revision = 0
  /** Chunk keys changed since the last `drainChanged`. */
  private readonly changed = new Set<string>()
  private nextMarker = 1

  clear(): void {
    this.chunks.clear()
    this.sightings.clear()
    this.changed.clear()
    this.revision++
  }

  drainChanged(): string[] {
    const keys = [...this.changed]
    this.changed.clear()
    return keys
  }

  /**
   * Copies the explored cells around the viewer from the vision window into per-chunk 1 m tiles. Only chunks the
   * viewer's sight range can reach are read, so the cost is a few thousand cells regardless of how much is explored.
   */
  observe(vision: VisionWindow, source: ChunkSource): number {
    const range = vision.settings.range + 1
    const ocx = Math.round(vision.originX / CHUNK)
    const ocy = Math.round(vision.originY / CHUNK)
    const minCx = Math.max(ocx, Math.floor((vision.x - range) / CHUNK))
    const maxCx = Math.min(ocx + 2, Math.floor((vision.x + range) / CHUNK))
    const minCy = Math.max(ocy, Math.floor((vision.y - range) / CHUNK))
    const maxCy = Math.min(ocy + 2, Math.floor((vision.y + range) / CHUNK))
    let updated = 0
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        if (this.copyChunk(vision.explored, FOG_SIZE, (cx - ocx) * 64, (cy - ocy) * 64, cx, cy, source)) updated++
      }
    }
    return updated
  }

  /** Copies all nine chunks of the window, for a window shift or a reset. */
  observeWindow(vision: VisionWindow, source: ChunkSource): number {
    const ocx = Math.round(vision.originX / CHUNK)
    const ocy = Math.round(vision.originY / CHUNK)
    let updated = 0
    for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) if (this.copyChunk(vision.explored, FOG_SIZE, dx * 64, dy * 64, ocx + dx, ocy + dy, source)) updated++
    return updated
  }

  /** Copies the tiles Vision saved for the window at (ox, oy) when it moved away, so the last moments aren't lost. */
  observeSaved(vision: VisionWindow, ox: number, oy: number, source: ChunkSource): number {
    const saved = vision.chunkExplored
    if (!saved) return 0
    const ocx = Math.round(ox / CHUNK)
    const ocy = Math.round(oy / CHUNK)
    let updated = 0
    for (let dy = 0; dy < 3; dy++) {
      for (let dx = 0; dx < 3; dx++) {
        const tile = saved.get(chunkKey(ocx + dx, ocy + dy))
        if (tile && this.copyChunk(tile, 64, 0, 0, ocx + dx, ocy + dy, source)) updated++
      }
    }
    return updated
  }

  /** Max-pools 0.5 m cells from `explored` (row stride `stride`, chunk at baseX, baseY) into chunk (cx, cy). */
  private copyChunk(explored: Uint8Array, stride: number, baseX: number, baseY: number, cx: number, cy: number, source: ChunkSource): boolean {
    const key = chunkKey(cx, cy)
    let chunk = this.chunks.get(key)
    let added = 0
    for (let ty = 0; ty < MAP_TILE; ty++) {
      const row0 = (baseY + ty * SUB) * stride + baseX
      for (let tx = 0; tx < MAP_TILE; tx++) {
        if (chunk && chunk.explored[ty * MAP_TILE + tx]) continue
        const i = row0 + tx * SUB
        if (!(explored[i] || explored[i + 1] || explored[i + stride] || explored[i + stride + 1])) continue
        if (!chunk) {
          const world = source(cx, cy)
          if (!world) return false
          chunk = { ...chunkFeatures(world), explored: new Uint8Array(MAP_TILE * MAP_TILE), count: 0, revision: 0 }
          this.chunks.set(key, chunk)
        }
        chunk.explored[ty * MAP_TILE + tx] = 255
        added++
      }
    }
    if (!chunk || !added) return false
    chunk.count += added
    this.refreshKnown(chunk)
    chunk.revision++
    this.revision++
    this.changed.add(key)
    return true
  }

  /** Marks a disc explored directly, for the Lab station's demo. Play only explores through `observe`. */
  reveal(x: number, y: number, radius: number, source: ChunkSource): number {
    let added = 0
    for (let cy = Math.floor((y - radius) / CHUNK); cy <= Math.floor((y + radius) / CHUNK); cy++) {
      for (let cx = Math.floor((x - radius) / CHUNK); cx <= Math.floor((x + radius) / CHUNK); cx++) {
        const key = chunkKey(cx, cy)
        let chunk = this.chunks.get(key)
        if (!chunk) {
          const world = source(cx, cy)
          if (!world) continue
          chunk = { ...chunkFeatures(world), explored: new Uint8Array(MAP_TILE * MAP_TILE), count: 0, revision: 0 }
        }
        let n = 0
        for (let ty = 0; ty < MAP_TILE; ty++) {
          for (let tx = 0; tx < MAP_TILE; tx++) {
            const px = cx * CHUNK + tx + 0.5
            const py = cy * CHUNK + ty + 0.5
            // A ragged edge, like ground walked rather than a drawn circle.
            const edge = radius * (0.86 + 0.14 * hash3(Math.floor(px / 6), Math.floor(py / 6), 77))
            if (chunk.explored[ty * MAP_TILE + tx] || (px - x) ** 2 + (py - y) ** 2 > edge * edge) continue
            chunk.explored[ty * MAP_TILE + tx] = 255
            n++
          }
        }
        if (!n) continue
        this.chunks.set(key, chunk)
        chunk.count += n
        this.refreshKnown(chunk)
        chunk.revision++
        this.changed.add(key)
        added += n
      }
    }
    if (added) this.revision++
    return added
  }

  /** A building is known once any metre of ground touching its walls has been seen. */
  private refreshKnown(chunk: MapChunk): void {
    const x0 = chunk.cx * CHUNK
    const y0 = chunk.cy * CHUNK
    for (const b of chunk.buildings) {
      if (b.known) continue
      const ax = Math.max(0, Math.floor(b.rect[0] - x0 - 1))
      const ay = Math.max(0, Math.floor(b.rect[1] - y0 - 1))
      const bx = Math.min(MAP_TILE - 1, Math.floor(b.rect[2] - x0 + 1))
      const by = Math.min(MAP_TILE - 1, Math.floor(b.rect[3] - y0 + 1))
      let seen = 0
      for (let y = ay; y <= by && seen < 3; y++) for (let x = ax; x <= bx; x++) if (chunk.explored[y * MAP_TILE + x] && ++seen >= 3) break
      if (seen >= 3) b.known = true
    }
  }

  explored(x: number, y: number): boolean {
    const cx = Math.floor(x / CHUNK)
    const cy = Math.floor(y / CHUNK)
    const chunk = this.chunks.get(chunkKey(cx, cy))
    if (!chunk) return false
    const tx = Math.min(MAP_TILE - 1, Math.floor(x - cx * CHUNK))
    const ty = Math.min(MAP_TILE - 1, Math.floor(y - cy * CHUNK))
    return chunk.explored[ty * MAP_TILE + tx] !== 0
  }

  /** Known POI buildings, nearest first. */
  knownPois(x: number, y: number, range: number): MapBuilding[] {
    const out: MapBuilding[] = []
    const r2 = range * range
    for (const c of this.chunks.values()) {
      for (const b of c.buildings) if (b.known && b.poi && (b.x - x) ** 2 + (b.y - y) ** 2 <= r2) out.push(b)
    }
    return out.sort((a, b) => (a.x - x) ** 2 + (a.y - y) ** 2 - ((b.x - x) ** 2 + (b.y - y) ** 2))
  }

  /** Explored chunk count per macro-block, for district labels. */
  blocks(): Map<string, { bx: number; by: number; district: DistrictKind; chunks: number }> {
    const out = new Map<string, { bx: number; by: number; district: DistrictKind; chunks: number }>()
    for (const c of this.chunks.values()) {
      const k = `${c.bx},${c.by}`
      const b = out.get(k)
      if (b) b.chunks++
      else out.set(k, { bx: c.bx, by: c.by, district: c.district, chunks: 1 })
    }
    return out
  }

  /**
   * Records zombies the survivor can see now into 8 m cells and clears cells the survivor is looking at that are now
   * empty, so the map only ever shows the last place a group was actually seen.
   */
  observeZombies(
    zombies: readonly { x: number; y: number; state: string }[],
    seen: (x: number, y: number) => boolean,
    time: number,
    memory: number,
  ): void {
    const now = new Map<number, { x: number; y: number; count: number }>()
    for (const z of zombies) {
      if (z.state === "dead" || !seen(z.x, z.y)) continue
      const key = sightingKey(z.x, z.y)
      const s = now.get(key)
      if (s) {
        s.x += z.x
        s.y += z.y
        s.count++
      } else now.set(key, { x: z.x, y: z.y, count: 1 })
    }
    for (const [key, s] of this.sightings) {
      if (time - s.seenAt > memory) this.sightings.delete(key)
      else if (!now.has(key) && seen(s.x, s.y)) this.sightings.delete(key)
    }
    for (const [key, s] of now) this.sightings.set(key, { key, x: s.x / s.count, y: s.y / s.count, count: s.count, seenAt: time })
  }

  addMarker(x: number, y: number): MapMarker {
    const used = new Set(this.markers.map((m) => m.label))
    let label = "A"
    for (let i = 0; i < 26; i++) {
      label = String.fromCharCode(65 + i)
      if (!used.has(label)) break
    }
    const m = { id: this.nextMarker++, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, label }
    this.markers.push(m)
    if (this.markers.length > 26) this.markers.shift()
    return m
  }

  removeMarker(id: number): boolean {
    const i = this.markers.findIndex((m) => m.id === id)
    if (i < 0) return false
    this.markers.splice(i, 1)
    return true
  }

  setMarkers(markers: readonly { x: number; y: number; label?: string }[]): void {
    this.markers = []
    for (const m of markers) {
      if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) continue
      const added = this.addMarker(m.x, m.y)
      if (typeof m.label === "string" && /^[A-Z]$/.test(m.label)) added.label = m.label
    }
  }
}

export type Horde = { x: number; y: number; count: number; seenAt: number }

/** Groups 8 m sighting cells within `radius` metres of each other; the biggest cells seed the groups. */
export function groupSightings(sightings: Iterable<Sighting>, radius = 14): Horde[] {
  const cells = [...sightings].sort((a, b) => b.count - a.count)
  const out: Horde[] = []
  const r2 = radius * radius
  for (const s of cells) {
    const g = out.find((h) => (h.x - s.x) ** 2 + (h.y - s.y) ** 2 <= r2)
    if (!g) {
      out.push({ x: s.x, y: s.y, count: s.count, seenAt: s.seenAt })
      continue
    }
    g.x = (g.x * g.count + s.x * s.count) / (g.count + s.count)
    g.y = (g.y * g.count + s.y * s.count) / (g.count + s.count)
    g.count += s.count
    g.seenAt = Math.max(g.seenAt, s.seenAt)
  }
  return out
}

function sightingKey(x: number, y: number): number {
  return (Math.floor(y / 8) + 32768) * 65536 + (Math.floor(x / 8) + 32768)
}

export { CHUNK, MACRO_SIZE }
