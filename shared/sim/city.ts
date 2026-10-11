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
}

export type Park = { x0: number; x1: number; z0: number; z1: number }
export type Tree = { x: number; z: number; s: number }

export type City = {
  seed: number
  boxes: Box[]
  parks: Park[]
  trees: Tree[]
  alleys: Alley[]
  parked: Parked[]
  lamps: { x: number; z: number }[]
  nodes: { x: number; z: number }[]
  adj: number[][]
  sites: JobSite[]
  extraction: Extraction[]
  precinct: { x: number; z: number; h: number; spawnNode: number }
  helipad: { x: number; y: number; z: number }
  waterZ: number
  max: number
}

export const NODE_COUNT = (GRID + 1) * (GRID + 1)
export const nodeIndex = (k: number, m: number) => k * (GRID + 1) + m

const PALETTE: Rgb[] = [
  [0.42, 0.33, 0.27],
  [0.33, 0.31, 0.32],
  [0.5, 0.41, 0.32],
  [0.27, 0.27, 0.3],
  [0.55, 0.5, 0.43],
  [0.38, 0.27, 0.24],
  [0.3, 0.33, 0.33],
  [0.46, 0.44, 0.42],
]
const PARKED = ["compact", "muscle", "van", "cruiser"]
export const ALLEY = 7

export type Alley = { x0: number; x1: number; z0: number; z1: number }
export type Parked = { x: number; z: number; h: number; model: string }
const NEONS: Rgb[] = [
  [1.0, 0.2, 0.62],
  [0.25, 0.9, 0.95],
  [1.0, 0.7, 0.25],
  [1.0, 0.3, 0.3],
]

export function generateCity(seed: number): City {
  const rng = mulberry32(seed)
  const boxes: Box[] = []
  const parks: Park[] = []
  const trees: Tree[] = []
  const alleys: Alley[] = []
  const parked: Parked[] = []
  const lamps: { x: number; z: number }[] = []
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
      lamps.push({ x: k * CELL + ROAD_HALF + 1.5, z: m * CELL + ROAD_HALF + 1.5 })
    }

  const parkBlocks = new Set(["1,2", "4,5"])
  const bankBlock = [2, 2]
  const jewelryBlock = [4, 3]
  const galleryBlock = [1, 4]
  const precinctBlock = [5, 1]
  const siteBlocks = new Set([`${bankBlock[0]},${bankBlock[1]}`, `${jewelryBlock[0]},${jewelryBlock[1]}`, `${galleryBlock[0]},${galleryBlock[1]}`])

  const inset = 3.2
  for (let i = 0; i < GRID; i++)
    for (let j = 0; j < GRID; j++) {
      const bx0 = i * CELL + ROAD_HALF
      const bx1 = (i + 1) * CELL - ROAD_HALF
      const bz0 = j * CELL + ROAD_HALF
      const bz1 = (j + 1) * CELL - ROAD_HALF
      const key = `${i},${j}`
      if (parkBlocks.has(key)) {
        parks.push({ x0: bx0, x1: bx1, z0: bz0, z1: bz1 })
        for (let t = 0; t < 18; t++) trees.push({ x: bx0 + 4 + rng() * (bx1 - bx0 - 8), z: bz0 + 4 + rng() * (bz1 - bz0 - 8), s: 0.8 + rng() * 0.6 })
        continue
      }
      const x0 = bx0 + inset
      const x1 = bx1 - inset
      const z0 = bz0 + inset
      const z1 = bz1 - inset
      if (i === precinctBlock[0] && j === precinctBlock[1]) {
        boxes.push({ x0, x1, z0, z1, h: 14, color: [0.5, 0.52, 0.56], neon: null, kind: "building", label: "PRECINCT" })
        continue
      }
      if (siteBlocks.has(key)) {
        const label = key === `${bankBlock[0]},${bankBlock[1]}` ? "bank" : key === `${jewelryBlock[0]},${jewelryBlock[1]}` ? "jewelry" : "gallery"
        // The job building fronts the west road; the rest of the block is two row buildings behind an alley.
        const h = label === "bank" ? 20 : 11 + rng() * 5
        const mid = x0 + (x1 - x0) * 0.5
        boxes.push({ x0, x1: mid - ALLEY / 2, z0, z1, h, color: label === "bank" ? [0.62, 0.58, 0.5] : [0.32, 0.27, 0.3], neon: label === "bank" ? [1, 0.25, 0.4] : [0.3, 0.95, 0.9], kind: "building", label })
        alleys.push({ x0: mid - ALLEY / 2, x1: mid + ALLEY / 2, z0: bz0, z1: bz1 })
        const zm = (z0 + z1) / 2
        boxes.push({ x0: mid + ALLEY / 2, x1, z0, z1: zm, h: 9 + rng() * 8, color: PALETTE[Math.floor(rng() * PALETTE.length)]!, neon: null, kind: "building", label: null })
        boxes.push({ x0: mid + ALLEY / 2, x1, z0: zm, z1, h: 9 + rng() * 8, color: PALETTE[Math.floor(rng() * PALETTE.length)]!, neon: null, kind: "building", label: null })
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
        alleys.push({ x0: cut - half, x1: cut + half, z0: bz0, z1: bz1 })
      } else {
        const cx = x0 + (x1 - x0) * (0.4 + rng() * 0.2)
        const cz = z0 + (z1 - z0) * (0.4 + rng() * 0.2)
        lots.push([x0, cx - half, z0, cz - half], [cx + half, x1, z0, cz - half], [x0, cx - half, cz + half, z1], [cx + half, x1, cz + half, z1])
        alleys.push({ x0: cx - half, x1: cx + half, z0: bz0, z1: bz1 }, { x0: bx0, x1: bx1, z0: cz - half, z1: cz + half })
      }
      for (const [a, b, c, d] of lots) {
        if (lots.length > 1 && rng() < 0.1) {
          // Parking lot: a few parked cars as small solid obstacles.
          const cols = Math.max(1, Math.floor((b - a) / 3.4))
          for (let k = 0; k < cols; k++) {
            if (rng() < 0.45) continue
            const px = a + 1.7 + k * 3.4
            for (const pz of [c + 3, d - 3]) {
              if (rng() < 0.4) continue
              parked.push({ x: px, z: pz, h: pz < (c + d) / 2 ? 0 : Math.PI, model: PARKED[Math.floor(rng() * PARKED.length)]! })
              boxes.push({ x0: px - 1, x1: px + 1, z0: pz - 2.3, z1: pz + 2.3, h: 1.4, color: [0, 0, 0], neon: null, kind: "special", label: "parked" })
            }
          }
          continue
        }
        // Long lots become two or three row buildings of different heights with no gap between them.
        const long = Math.max(b - a, d - c)
        const parts = long > 34 ? 3 : long > 20 ? 2 : 1
        const alongX = b - a >= d - c
        for (let k = 0; k < parts; k++) {
          const s0 = k / parts
          const s1 = (k + 1) / parts
          const pa = alongX ? a + (b - a) * s0 : a
          const pb = alongX ? a + (b - a) * s1 : b
          const pc = alongX ? c : c + (d - c) * s0
          const pd = alongX ? d : c + (d - c) * s1
          const tall = central ? 13 + rng() * 20 : 0
          const h = tall > 0 ? tall : 7 + rng() * rng() * 18
          const color = PALETTE[Math.floor(rng() * PALETTE.length)]!
          const neon = rng() < 0.22 ? NEONS[Math.floor(rng() * NEONS.length)]! : null
          boxes.push({ x0: pa, x1: pb, z0: pc, z1: pd, h, color, neon, kind: "building", label: null })
        }
      }
      for (let t = 0; t < 4; t++) {
        const tx = rng() < 0.5 ? bx0 + 1.5 : bx1 - 1.5
        trees.push({ x: tx, z: bz0 + 6 + rng() * (bz1 - bz0 - 12), s: 0.7 + rng() * 0.5 })
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
