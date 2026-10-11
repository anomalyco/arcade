import { CELL, GRID, ROAD_HALF, WATER_Z, WORLD_MAX, type Extraction, type JobSite } from "../config"
import { mulberry32 } from "./rng"

export type Rgb = [number, number, number]

export type Box = {
  x0: number
  x1: number
  z0: number
  z1: number
  h: number
  color: Rgb
  neon: Rgb | null
  kind: "building" | "wall" | "special"
  label: string | null
  /** Storeys above the ground floor (buildings only). */
  floors?: number
  /** What a non-building solid is, for the renderer. */
  use?: "container" | "crane" | "statue"
}

export type Park = { x0: number; x1: number; z0: number; z1: number; kind?: "park" | "plaza" }
export type Tree = { x: number; z: number; s: number; planter?: boolean }
/** Open lots inside blocks: parking lots, small paved courtyards, the container yard. */
export type Yard = { x0: number; x1: number; z0: number; z1: number; kind: "lot" | "court" | "containers" }

export type City = {
  seed: number
  boxes: Box[]
  parks: Park[]
  trees: Tree[]
  alleys: Alley[]
  parked: Parked[]
  /** Street lamp heads; (px, pz) is the foot of the pole when the head hangs out on an arm. */
  lamps: { x: number; z: number; px?: number; pz?: number }[]
  nodes: { x: number; z: number }[]
  adj: number[][]
  sites: JobSite[]
  extraction: Extraction[]
  precinct: { x: number; z: number; h: number; spawnNode: number }
  helipad: { x: number; y: number; z: number }
  waterZ: number
  max: number
  yards: Yard[]
  /** Sidewalk width between the curb and the building line. */
  sidewalk: number
}

export const NODE_COUNT = (GRID + 1) * (GRID + 1)
export const nodeIndex = (k: number, m: number) => k * (GRID + 1) + m

/** Facade colors: brick reds and browns, stone and a couple of painted greys. */
const PALETTE: Rgb[] = [
  [0.36, 0.2, 0.16],
  [0.42, 0.25, 0.19],
  [0.31, 0.18, 0.15],
  [0.36, 0.27, 0.21],
  [0.4, 0.36, 0.31],
  [0.34, 0.32, 0.31],
  [0.26, 0.25, 0.28],
  [0.29, 0.21, 0.19],
  [0.42, 0.37, 0.32],
]
const PARKED = ["compact", "muscle", "van", "cruiser"]
export const ALLEY = 7
/** Ground floor height plus plinth; each storey above adds STOREY. */
export const GROUND_FLOOR = 4.4
export const STOREY = 3.4
const SIDEWALK = 5

export type Alley = { x0: number; x1: number; z0: number; z1: number }
export type Parked = { x: number; z: number; h: number; model: string }
const NEONS: Rgb[] = [
  [1.0, 0.2, 0.62],
  [0.25, 0.9, 0.95],
  [1.0, 0.7, 0.25],
  [1.0, 0.3, 0.3],
  [0.3, 0.5, 1.0],
]
const CONTAINER_COLORS: Rgb[] = [
  [0.5, 0.18, 0.15],
  [0.22, 0.32, 0.46],
  [0.2, 0.36, 0.38],
  [0.58, 0.36, 0.16],
  [0.4, 0.41, 0.42],
  [0.42, 0.22, 0.18],
]

export function generateCity(seed: number): City {
  const rng = mulberry32(seed)
  const boxes: Box[] = []
  const parks: Park[] = []
  const trees: Tree[] = []
  const alleys: Alley[] = []
  const parked: Parked[] = []
  const yards: Yard[] = []
  const lamps: City["lamps"] = []
  const nodes: { x: number; z: number }[] = []
  const adj: number[][] = []
  for (let k = 0; k <= GRID; k++)
    for (let m = 0; m <= GRID; m++) {
      nodes.push({ x: k * CELL, z: m * CELL })
      adj.push([])
    }
  const link = (a: number, b: number) => {
    adj[a]!.push(b)
    adj[b]!.push(a)
  }
  for (let k = 0; k <= GRID; k++)
    for (let m = 0; m <= GRID; m++) {
      const n = nodeIndex(k, m)
      if (k < GRID) link(n, nodeIndex(k + 1, m))
      if (m < GRID) link(n, nodeIndex(k, m + 1))
    }

  const parkBlocks = new Map<string, "park" | "plaza">([
    ["1,2", "park"],
    ["4,5", "plaza"],
  ])
  const bankBlock = [2, 2]
  const jewelryBlock = [4, 3]
  const galleryBlock = [1, 4]
  const precinctBlock = [5, 1]
  const yardBlock = [6, 6]
  const siteBlocks = new Set([`${bankBlock[0]},${bankBlock[1]}`, `${jewelryBlock[0]},${jewelryBlock[1]}`, `${galleryBlock[0]},${galleryBlock[1]}`])
  const color = () => PALETTE[Math.floor(rng() * PALETTE.length)]!
  const building = (x0: number, x1: number, z0: number, z1: number, floors: number, c: Rgb, neon: Rgb | null = null, label: string | null = null) =>
    boxes.push({ x0, x1, z0, z1, h: GROUND_FLOOR + floors * STOREY, color: c, neon, kind: "building", label, floors })

  const inset = SIDEWALK
  for (let i = 0; i < GRID; i++)
    for (let j = 0; j < GRID; j++) {
      const bx0 = i * CELL + ROAD_HALF
      const bx1 = (i + 1) * CELL - ROAD_HALF
      const bz0 = j * CELL + ROAD_HALF
      const bz1 = (j + 1) * CELL - ROAD_HALF
      const key = `${i},${j}`
      const blockAlleys: Alley[] = []
      const parkKind = parkBlocks.get(key)
      if (parkKind) {
        parks.push({ x0: bx0, x1: bx1, z0: bz0, z1: bz1, kind: parkKind })
        if (parkKind === "park") {
          for (let t = 0; t < 26; t++) {
            const x = bx0 + 5 + rng() * (bx1 - bx0 - 10)
            const z = bz0 + 5 + rng() * (bz1 - bz0 - 10)
            const cx = (bx0 + bx1) / 2
            const cz = (bz0 + bz1) / 2
            // Keep the paths and the fountain clear.
            if (Math.abs(x - cx) < 3.5 || Math.abs(z - cz) < 3.5 || Math.hypot(x - cx, z - cz) < 12) continue
            trees.push({ x, z, s: 0.9 + rng() * 0.6 })
          }
        } else {
          const cx = (bx0 + bx1) / 2
          const cz = (bz0 + bz1) / 2
          boxes.push({ x0: cx - 2.2, x1: cx + 2.2, z0: cz - 2.2, z1: cz + 2.2, h: 2, color: [0.5, 0.48, 0.45], neon: null, kind: "special", label: null, use: "statue" })
        }
        streetscape(bx0, bx1, bz0, bz1, [], parkKind === "park")
        continue
      }
      const x0 = bx0 + inset
      const x1 = bx1 - inset
      const z0 = bz0 + inset
      const z1 = bz1 - inset
      if (i === precinctBlock[0] && j === precinctBlock[1]) {
        boxes.push({ x0: x0 + 4, x1: x1 - 4, z0: z0 + 4, z1: z1 - 4, h: 14, color: [0.42, 0.43, 0.46], neon: null, kind: "building", label: "PRECINCT", floors: 3 })
        streetscape(bx0, bx1, bz0, bz1, [], false)
        continue
      }
      if (i === yardBlock[0] && j === yardBlock[1]) {
        containerYard(x0, x1, z0, z1)
        streetscape(bx0, bx1, bz0, bz1, [], false)
        continue
      }
      if (siteBlocks.has(key)) {
        const label = key === `${bankBlock[0]},${bankBlock[1]}` ? "bank" : key === `${jewelryBlock[0]},${jewelryBlock[1]}` ? "jewelry" : "gallery"
        // The job building fronts the west road; the rest of the block is two row buildings behind an alley.
        const mid = x0 + (x1 - x0) * 0.5
        const floors = label === "bank" ? 3 : 2
        building(x0, mid - ALLEY / 2, z0, z1, floors, label === "bank" ? [0.52, 0.49, 0.43] : label === "gallery" ? [0.47, 0.45, 0.43] : [0.3, 0.25, 0.28], label === "bank" ? [1, 0.25, 0.4] : [0.3, 0.95, 0.9], label)
        const al = { x0: mid - ALLEY / 2, x1: mid + ALLEY / 2, z0: bz0, z1: bz1 }
        alleys.push(al)
        blockAlleys.push(al)
        const zm = (z0 + z1) / 2
        building(mid + ALLEY / 2, x1, z0, zm, 2 + Math.floor(rng() * 3), color())
        building(mid + ALLEY / 2, x1, zm, z1, 2 + Math.floor(rng() * 3), color())
        streetscape(bx0, bx1, bz0, bz1, blockAlleys, false)
        continue
      }
      const central = Math.abs(i - 3) <= 1 && Math.abs(j - 3) <= 1
      // Blocks split into lots by drivable alleys (ALLEY m wide), like the dense mockup city.
      const r = rng()
      const lots: [number, number, number, number][] = []
      const half = ALLEY / 2
      if (r < 0.18) lots.push([x0, x1, z0, z1])
      else if (r < 0.5) {
        const cut = x0 + (x1 - x0) * (0.4 + rng() * 0.2)
        lots.push([x0, cut - half, z0, z1], [cut + half, x1, z0, z1])
        blockAlleys.push({ x0: cut - half, x1: cut + half, z0: bz0, z1: bz1 })
      } else {
        const cx = x0 + (x1 - x0) * (0.4 + rng() * 0.2)
        const cz = z0 + (z1 - z0) * (0.4 + rng() * 0.2)
        lots.push([x0, cx - half, z0, cz - half], [cx + half, x1, z0, cz - half], [x0, cx - half, cz + half, z1], [cx + half, x1, cz + half, z1])
        blockAlleys.push({ x0: cx - half, x1: cx + half, z0: bz0, z1: bz1 }, { x0: bx0, x1: bx1, z0: cz - half, z1: cz + half })
      }
      alleys.push(...blockAlleys)
      for (const [a, b, c, d] of lots) {
        const roll = rng()
        if (lots.length > 1 && roll < 0.1) {
          // Parking lot: a few parked cars as small solid obstacles.
          yards.push({ x0: a, x1: b, z0: c, z1: d, kind: "lot" })
          const cols = Math.max(1, Math.floor((b - a - 1) / 3.4))
          for (let k = 0; k < cols; k++) {
            if (rng() < 0.45) continue
            const px = a + 2.2 + k * 3.4
            for (const pz of [c + 3, d - 3]) {
              if (rng() < 0.4) continue
              parked.push({ x: px, z: pz, h: pz < (c + d) / 2 ? 0 : Math.PI, model: PARKED[Math.floor(rng() * PARKED.length)]! })
              boxes.push({ x0: px - 1, x1: px + 1, z0: pz - 2.3, z1: pz + 2.3, h: 1.4, color: [0, 0, 0], neon: null, kind: "special", label: "parked" })
            }
          }
          continue
        }
        if (lots.length > 1 && roll < 0.17) {
          // Small paved court with planted trees.
          yards.push({ x0: a, x1: b, z0: c, z1: d, kind: "court" })
          for (let tx = a + 4; tx < b - 3; tx += 7)
            for (let tz = c + 4; tz < d - 3; tz += 7) if (rng() < 0.7) trees.push({ x: tx + (rng() - 0.5) * 2, z: tz + (rng() - 0.5) * 2, s: 0.8 + rng() * 0.5, planter: true })
          continue
        }
        // Long lots become two or three row buildings of different heights with no gap between them.
        const long = Math.max(b - a, d - c)
        const parts = long > 34 ? 3 : long > 18 ? 2 : 1
        const alongX = b - a >= d - c
        for (let k = 0; k < parts; k++) {
          const s0 = k / parts
          const s1 = (k + 1) / parts
          const pa = alongX ? a + (b - a) * s0 : a
          const pb = alongX ? a + (b - a) * s1 : b
          const pc = alongX ? c : c + (d - c) * s0
          const pd = alongX ? d : c + (d - c) * s1
          // Deep lots become two buildings back to back, so footprints stay townhouse-sized.
          const deep = alongX ? pd - pc : pb - pa
          const pieces: [number, number, number, number][] =
            deep > 26
              ? alongX
                ? [
                    [pa, pb, pc, (pc + pd) / 2],
                    [pa, pb, (pc + pd) / 2, pd],
                  ]
                : [
                    [pa, (pa + pb) / 2, pc, pd],
                    [(pa + pb) / 2, pb, pc, pd],
                  ]
              : [[pa, pb, pc, pd]]
          for (const [qa, qb, qc, qd] of pieces) {
            const floors = central ? 3 + Math.floor(rng() * 4) : 2 + Math.floor(rng() * rng() * 4)
            const neon = rng() < 0.22 ? NEONS[Math.floor(rng() * NEONS.length)]! : null
            building(qa, qb, qc, qd, floors, color(), neon)
          }
        }
      }
      streetscape(bx0, bx1, bz0, bz1, blockAlleys, false)
    }

  /**
   * Lamps and planted trees along the four sidewalks of a block. Lamp poles stand at the curb with the head
   * on a short arm over the gutter; trees sit in planters between them. Alley mouths and corners stay clear.
   */
  function streetscape(bx0: number, bx1: number, bz0: number, bz1: number, gaps: Alley[], park: boolean) {
    const len = bx1 - bx0
    const sides = [
      // [foot of the side at t, outward normal]
      { at: (t: number) => [bx0 + t, bz0] as const, n: [0, -1] as const, cross: (a: Alley) => (a.z0 <= bz0 + 0.1 ? [a.x0 - bx0, a.x1 - bx0] : null) },
      { at: (t: number) => [bx0 + t, bz1] as const, n: [0, 1] as const, cross: (a: Alley) => (a.z1 >= bz1 - 0.1 ? [a.x0 - bx0, a.x1 - bx0] : null) },
      { at: (t: number) => [bx0, bz0 + t] as const, n: [-1, 0] as const, cross: (a: Alley) => (a.x0 <= bx0 + 0.1 ? [a.z0 - bz0, a.z1 - bz0] : null) },
      { at: (t: number) => [bx1, bz0 + t] as const, n: [1, 0] as const, cross: (a: Alley) => (a.x1 >= bx1 - 0.1 ? [a.z0 - bz0, a.z1 - bz0] : null) },
    ]
    for (const side of sides) {
      const blocked = gaps.map(side.cross).filter((g): g is number[] => g !== null)
      const clear = (t: number, pad: number) => t > 3 && t < len - 3 && blocked.every(([g0, g1]) => t < g0! - pad || t > g1! + pad)
      // Stagger lamps against the sidewalk across the road.
      const flip = side.n[0] + side.n[1] > 0
      const lampTs = flip ? [5, 30, 55] : [17.5, 42.5]
      const placed: number[] = []
      for (const t of lampTs) {
        if (!clear(t, 1.5)) continue
        const [fx, fz] = side.at(t)
        const px = fx + side.n[0] * -0.7
        const pz = fz + side.n[1] * -0.7
        lamps.push({ x: px + side.n[0] * 1.6, z: pz + side.n[1] * 1.6, px, pz })
        placed.push(t)
      }
      if (park) continue
      for (let t = 7.5; t < len - 6; t += 7.5) {
        if (!clear(t, 2.5) || placed.some((p) => Math.abs(p - t) < 3.5)) continue
        if (rng() < 0.15) continue
        const [fx, fz] = side.at(t)
        trees.push({ x: fx - side.n[0] * 2.1, z: fz - side.n[1] * 2.1, s: 0.75 + rng() * 0.3, planter: true })
      }
    }
  }

  /** Harbor container yard: rows of stacked containers with drive lanes and a gantry crane over two rows. */
  function containerYard(x0: number, x1: number, z0: number, z1: number) {
    yards.push({ x0, x1, z0, z1, kind: "containers" })
    const rowW = 5
    const lane = 7.5
    const cx = (x0 + x1) / 2
    let row = 0
    for (let rz = z0 + 1; rz + rowW <= z1 - 0.5; rz += rowW + lane, row++) {
      const craneRow = row === 1 || row === 2
      for (let sx = x0 + 1; sx + 12.2 <= x1 - 0.5; sx += 12.8) {
        if (craneRow && sx + 12.2 > cx - 8 && sx < cx + 8) continue
        if (rng() < 0.15) continue
        for (const half of [0, 1]) {
          const tiers = 1 + Math.floor(rng() * 3)
          const za = rz + half * 2.5
          boxes.push({ x0: sx, x1: sx + 12.2, z0: za, z1: za + 2.45, h: tiers * 2.6, color: CONTAINER_COLORS[Math.floor(rng() * CONTAINER_COLORS.length)]!, neon: null, kind: "building", label: null, use: "container" })
        }
      }
      if (craneRow) for (const lx of [cx - 6, cx + 6]) boxes.push({ x0: lx - 0.7, x1: lx + 0.7, z0: rz + 1.8, z1: rz + 3.2, h: 22, color: [0.62, 0.16, 0.12], neon: null, kind: "special", label: null, use: "crane" })
    }
  }

  const wall = (x0: number, x1: number, z0: number, z1: number) => boxes.push({ x0, x1, z0, z1, h: 40, color: [0, 0, 0], neon: null, kind: "wall", label: null })
  const edge = -ROAD_HALF
  wall(edge - 6, edge, edge - 6, WORLD_MAX + 6)
  wall(WORLD_MAX, WORLD_MAX + 6, edge - 6, WORLD_MAX + 6)
  wall(edge - 6, WORLD_MAX + 6, edge - 6, edge)
  wall(edge - 6, WORLD_MAX + 6, WATER_Z, WATER_Z + 6)

  const bankX = bankBlock[0]! * CELL
  const bankZ = bankBlock[1]! * CELL + CELL / 2
  const jewX = jewelryBlock[0]! * CELL
  const jewZ = jewelryBlock[1]! * CELL + CELL / 2
  const galX = galleryBlock[0]! * CELL
  const galZ = galleryBlock[1]! * CELL + CELL / 2
  const sites: JobSite[] = [
    { id: "bank", name: "First National Bank", kind: "bank", value: 412000, x: bankX, z: bankZ },
    { id: "jewelry", name: "Golden Mile Jewelers", kind: "jewelry", value: 236000, x: jewX, z: jewZ },
    { id: "gallery", name: "Halcyon Art Gallery", kind: "gallery", value: 980000, x: galX, z: galZ },
  ]
  const extraction: Extraction[] = [
    { id: "rail", name: "Rail Yard", x: 0, z: 0 },
    { id: "marina", name: "Marina", x: 3 * CELL, z: GRID * CELL },
    { id: "tunnel", name: "Tunnel", x: GRID * CELL, z: 2 * CELL },
  ]
  const pcx = precinctBlock[0]! * CELL + CELL / 2
  const pcz = precinctBlock[1]! * CELL + CELL / 2
  const precinctBox = boxes.find((b) => b.label === "PRECINCT")!
  return {
    seed,
    boxes,
    parks,
    trees,
    alleys,
    parked,
    lamps,
    nodes,
    adj,
    sites,
    extraction,
    precinct: { x: pcx, z: pcz, h: precinctBox.h, spawnNode: nodeIndex(6, 1) },
    helipad: { x: pcx, y: precinctBox.h + 0.6, z: pcz },
    waterZ: WATER_Z,
    max: WORLD_MAX,
    yards,
    sidewalk: SIDEWALK,
  }
}

export function nearestNode(city: City, x: number, z: number): number {
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < city.nodes.length; i++) {
    const n = city.nodes[i]!
    const d = (n.x - x) ** 2 + (n.z - z) ** 2
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/**
 * Shortest road route between nodes (Dijkstra, the graph is tiny). Returns node indices from `from` to `to`, inclusive.
 * `blocked(a, b)` can close road segments (roadblocks).
 */
export function routeNodes(city: City, from: number, to: number, blocked?: (a: number, b: number) => boolean): number[] {
  const n = city.nodes.length
  const dist = new Array<number>(n).fill(Infinity)
  const prev = new Array<number>(n).fill(-1)
  const done = new Array<boolean>(n).fill(false)
  dist[from] = 0
  for (;;) {
    let u = -1
    for (let i = 0; i < n; i++) if (!done[i] && dist[i]! < Infinity && (u < 0 || dist[i]! < dist[u]!)) u = i
    if (u < 0 || u === to) break
    done[u] = true
    for (const v of city.adj[u]!) {
      if (blocked?.(u, v)) continue
      const a = city.nodes[u]!
      const b = city.nodes[v]!
      const d = dist[u]! + Math.hypot(a.x - b.x, a.z - b.z)
      if (d < dist[v]!) {
        dist[v] = d
        prev[v] = u
      }
    }
  }
  const path = [to]
  let cur = to
  while (cur !== from && prev[cur] >= 0) {
    cur = prev[cur]!
    path.unshift(cur)
  }
  return path[0] === from ? path : [from]
}
