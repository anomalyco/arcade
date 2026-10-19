import { emitBuildingRugs, emitInteriorDecor, emitWallCapMoulding } from "./interiors/mesh"
import { interiorSettings, interiorSignature, planInterior } from "./interiors/plan"
import { emitCraftWindow } from "./interiors/windows"
import { propDressingState, propLevelSignature } from "./props/state"
import { vegetationBuild, vegetationSignature } from "./vegetation/settings"
import type { LevelChunk, LevelData } from "@arcade/kit/gpu/level"
import { emitGrassClump, emitGrassTuft, foliageSettings, scatterGrassClumps } from "@arcade/kit/gpu/foliage"
import { MAT, Mesh, VERT_BYTES, type Mat, type Rgb } from "@arcade/kit/gpu/mesh"
import { distToRect, type Rect } from "@arcade/kit/sim/geom"
import { Rng } from "@arcade/kit/sim/rng"
import {
  BUILDING_RECTS,
  buildingFootprint,
  CHUNK,
  frontageEnd,
  inBuildingFootprint,
  makeTown,
  propShape,
  SIZE,
  type Building,
  type Prop,
  type Town,
} from "../shared/map"
import { supportHeight, terrainVertex } from "../shared/terrain"
import {
  generateWorldChunk,
  macroLocalCoord,
  selectActiveWindowCenter,
  type ChunkCoord,
  type WorldChunk,
  type WorldMode,
} from "../shared/world"
import { archSettings, house, houseFrontage, housePlanting, plant, plantFootprints, type HouseDecayState } from "./architecture"
import { emitGravelDriveway, emitLawnPatches, emitPathTufts, emitStreetVerge, emitTreeCollar } from "./yard"
import { buildLevel, type OriginChunk } from "./level"
import { bakedRoomLamp, DEFAULT_OUTBREAK_LIGHTING, resolveLampLight, stampOutbreakVertexTone } from "./lighting"
import { addLampPool, wallGrid } from "./lightbake"

const hex = (v: number): Rgb => [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]

const GROUND_COLOR: Rgb = hex(0x586044)
const ROAD_COLOR: Rgb = hex(0x545658)
const SIDEWALK_COLOR: Rgb = hex(0x78746a)
const CURB_COLOR: Rgb = hex(0x7c786e)

/** Precomputed IEEE-754 float16 bit patterns for integer global building IDs 0..15. */
const HALF_INT = new Uint16Array([
  0x0000, // 0
  0x3c00, // 1
  0x4000, // 2
  0x4200, // 3
  0x4400, // 4
  0x4500, // 5
  0x4600, // 6
  0x4700, // 7
  0x4800, // 8
  0x4880, // 9
  0x4900, // 10
  0x4980, // 11
  0x4a00, // 12
  0x4a80, // 13
  0x4b00, // 14
  0x4b80, // 15
])

/** float16 bit pattern of `MAT.roof` (21). */
const HALF_ROOF = 0x4d40

const floor = (m: Mesh, x: number, z: number, r: number, b: number, h: number, color: number, kind: number) =>
  m.quad(
    [x, h, b],
    [r, h, b],
    [r, h, z],
    [x, h, z],
    [0, 1, 0],
    hex(color),
    MAT.ground,
    kind === 8 ? 0 : kind === 5 ? 1 : kind === 2 ? 4 : kind === 7 ? 3 : kind === 3 ? 6 : 2,
  )

/** Push a single triangle into `v` without allocating temporary point or normal arrays. */
function pushFacetInline(
  v: number[],
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  col: Rgb,
  mat: Mat,
  aux: number,
): void {
  const ux = bx - ax
  const uy = by - ay
  const uz = bz - az
  const wx = cx - ax
  const wy = cy - ay
  const wz = cz - az
  const nx = uy * wz - uz * wy
  const ny = uz * wx - ux * wz
  const nz = ux * wy - uy * wx
  const invL = 1 / (Math.hypot(nx, ny, nz) || 1)
  const fnx = nx * invL
  const fny = ny * invL
  const fnz = nz * invL
  const cr = col[0]
  const cg = col[1]
  const cb = col[2]
  v.push(
    ax, ay, az, fnx, fny, fnz, cr, cg, cb, mat, aux,
    bx, by, bz, fnx, fny, fnz, cr, cg, cb, mat, aux,
    cx, cy, cz, fnx, fny, fnz, cr, cg, cb, mat, aux,
  )
}

export type CompiledRoofChunk = {
  data: ArrayBuffer
  box: readonly [number, number, number, number]
  cutBox: readonly number[]
  /** Index into the chunk's `buildings` (roofless buildings have no chunk, so this is not the array index). */
  buildingIndex: number
  lastGlobalId: number
  /** Retag only roof-material vertices (origin parts, whose other vertices keep their own aux meaning). */
  roofAuxOnly?: boolean
  /** How the renderer cuts it while the survivor is inside `cutBox`; default "outside" (skipped whole). */
  customCutaway?: true | "outside"
}

export type CompiledWorldChunk = {
  key: string
  cx: number
  cy: number
  hash: number
  staticOpaqueChunks: LevelChunk[]
  glassChunks: LevelChunk[]
  roofMeshes: Mesh[]
  roofChunks?: CompiledRoofChunk[]
  buildings: Building[]
  floorTile: Uint8Array<ArrayBuffer> // 128 × 128 × 2 (RG8)
  moonTile: Uint8Array<ArrayBuffer> // 256 × 256 (R8)
  bounceTile: Uint8Array<ArrayBuffer> // 64 × 64 × 4 (RGBA8)
  /** Wall-sconce lights, `SCONCE_FLOATS` each (see interiors/sconces.ts). */
  sconces: Float32Array<ArrayBuffer>
  compileMs: number
}

/**
 * Emits distinctive 3D architectural silhouettes and roofs (`MAT.roof` with `aux = buildingId`)
 * for procedural POI and building archetypes (`house`, `ranch`, `cottage`, `cabin`, `grocery`, `diner`,
 * `gas_station`, `police`, `clinic`, `church`, `warehouse`).
 */
export function emitPoiArchitecture(m: Mesh, b: Building, id: number, town: Town): void {
  const arch = b.archetype ?? b.kind
  const [x, z, r, e] = b.rect
  const midZ = (z + e) * 0.5
  const midX = (x + r) * 0.5

  // Exterior brick foundation plinth around walls
  for (const barrier of town.barriers) {
    const [a, c, d, f] = barrier.rect
    if (a < x - 0.05 || d > r + 0.05 || c < z - 0.05 || f > e + 0.05 || barrier.kind === "fence") continue
    m.box(a - 0.032, 0.025, c - 0.032, d + 0.032, 0.33, f + 0.032, hex(0x523027), MAT.brick)
    m.box(a - 0.036, 0.33, c - 0.036, d + 0.036, 0.37, f + 0.036, hex(0x6e685d), MAT.lit)
  }

  if (arch === "house" || arch === "ranch" || arch === "cottage" || arch === "cabin" || arch === "church") {
    // Pitched shingle gable roof (all tagged MAT.roof, aux = id so it cuts away cleanly when inside)
    const ridge = arch === "church" ? 5.15 : arch === "cabin" ? 3.85 : arch === "house" ? 4.35 : 4.15
    const roofCol = hex(arch === "church" ? 0x3e4248 : arch === "cabin" ? 0x3c3228 : 0x4e4b46)
    const eaveCol = hex(0x58534a)
    if (b.id === "ash" || b.id === "elm") {
      // Classic origin L-shaped bungalow roof matching the stepped-in north bedroom & NE wing walls
      m.quadAuto([x - 0.35, 2.82, e + 0.35], [r + 0.35, 2.82, e + 0.35], [r + 0.35, ridge, midZ], [x - 0.35, ridge, midZ], roofCol, MAT.roof, id)
      m.quadAuto([x + 9.75, 2.82, z - 0.35], [x + 1.85, 2.82, z - 0.35], [x + 1.85, ridge, midZ], [x + 9.75, ridge, midZ], roofCol, MAT.roof, id)
      m.quadAuto([x - 0.35, 2.84, z + 1.2], [x - 0.35, 2.84, z + 5.55], [x + 2.05, 3.48, z + 5.55], [x + 2.05, 3.48, z + 1.2], roofCol, MAT.roof, id)
      m.quadAuto([x + 9.45, 3.46, z + 5.55], [r - 0.35, 3.46, z + 5.55], [r - 0.35, 2.84, z + 1.45], [x + 9.45, 2.84, z + 1.45], roofCol, MAT.roof, id)
      m.facet([x - 0.01, 2.8, z + 5.5], [x - 0.01, ridge, midZ], [x - 0.01, 2.8, e], hex(b.color), MAT.roof, id)
      m.facet([r + 0.01, 2.8, e], [r + 0.01, ridge, midZ], [r + 0.01, 2.8, z + 5.5], hex(b.color), MAT.roof, id)
    } else {
      m.quadAuto([x - 0.35, 2.82, e + 0.35], [r + 0.35, 2.82, e + 0.35], [r + 0.35, ridge, midZ], [x - 0.35, ridge, midZ], roofCol, MAT.roof, id)
      m.quadAuto([r + 0.35, 2.82, z - 0.35], [x - 0.35, 2.82, z - 0.35], [x - 0.35, ridge, midZ], [r + 0.35, ridge, midZ], roofCol, MAT.roof, id)
      m.facet([x - 0.01, 2.8, z], [x - 0.01, ridge, midZ], [x - 0.01, 2.8, e], hex(b.color), MAT.roof, id)
      m.facet([r + 0.01, 2.8, e], [r + 0.01, ridge, midZ], [r + 0.01, 2.8, z], hex(b.color), MAT.roof, id)
    }
    m.box(x - 0.38, 2.72, e + 0.28, r + 0.38, 2.84, e + 0.38, eaveCol, MAT.roof, id)
    m.box(x - 0.38, ridge - 0.04, midZ - 0.12, r + 0.38, ridge + 0.05, midZ + 0.12, hex(0x666056), MAT.roof, id)

    if (arch === "church") {
      // Church bell-tower steeple + cross at front gable
      m.box(midX - 0.85, 3.6, e - 2.2, midX + 0.85, 6.1, e - 0.5, hex(0x9a9488), MAT.roof, id)
      m.box(midX - 0.95, 6.1, e - 2.3, midX + 0.95, 6.35, e - 0.4, hex(0x484c52), MAT.roof, id)
      m.box(midX - 0.08, 6.35, e - 1.42, midX + 0.08, 7.25, e - 1.26, hex(0xd2c8b0), MAT.roof, id)
      m.box(midX - 0.38, 6.82, e - 1.42, midX + 0.38, 6.96, e - 1.26, hex(0xd2c8b0), MAT.roof, id)
    } else {
      // Brick chimney stack
      m.box(r - 2.1, 3.1, midZ + 0.4, r - 1.2, ridge + 0.45, midZ + 1.3, hex(0x684536), MAT.brick, id)
    }
    return
  }

  // Commercial / Civic / Industrial flat roof deck + parapet wall (MAT.roof, id)
  const deckCol = hex(arch === "warehouse" ? 0x363a3e : arch === "police" ? 0x343c44 : 0x3a403d)
  const parapetCol = hex(arch === "warehouse" ? 0x484e54 : arch === "police" ? 0x46525e : 0x4a504c)
  m.box(x + 0.36, 2.8, z + 0.36, r - 0.36, 2.94, e - 0.36, deckCol, MAT.roof, id)
  m.box(x - 0.15, 2.8, z - 0.15, r + 0.15, 3.06, z + 0.36, parapetCol, MAT.roof, id)
  m.box(x - 0.15, 2.8, e - 0.36, r + 0.15, 3.06, e + 0.15, parapetCol, MAT.roof, id)
  m.box(x - 0.15, 2.8, z + 0.36, x + 0.36, 3.06, e - 0.36, parapetCol, MAT.roof, id)
  m.box(r - 0.36, 2.8, z + 0.36, r + 0.15, 3.06, e - 0.36, parapetCol, MAT.roof, id)

  // Rooftop HVAC box & vent duct
  m.box(midX - 1.1, 2.94, midZ - 0.8, midX + 0.9, 3.58, midZ + 0.7, hex(0x585c60), MAT.roof, id, hex(0x686c70))

  // Archetype-specific frontage signage & forecourt structures
  if (arch === "pharmacy" || arch === "clinic") {
    const bandCol = hex(arch === "clinic" ? 0x3c6e78 : 0x406d62)
    m.box(x + 0.3, 2.05, e + 0.01, r - 0.3, 2.62, e + 0.2, bandCol, MAT.wall)
    // Illuminated medical/pharmacy cross
    m.box(x + 1.2, 2.1, e + 0.21, x + 1.5, 2.55, e + 0.24, hex(0xcad8b7))
    m.box(x + 1.05, 2.23, e + 0.21, x + 1.65, 2.4, e + 0.24, hex(0xcad8b7))
  } else if (arch === "police") {
    // Police precinct blue fascia band + rooftop radio mast
    m.box(x + 0.3, 2.05, e + 0.01, r - 0.3, 2.65, e + 0.22, hex(0x283c54), MAT.wall)
    m.box(midX - 1.8, 2.22, e + 0.22, midX + 1.8, 2.48, e + 0.26, hex(0xb8c4d0), MAT.lit)
    m.prism(x + 2.2, z + 2.2, 0.08, 0.04, 2.94, 5.8, 6, hex(0x5a626a), MAT.roof, id)
  } else if (arch === "gas_station") {
    // Gas station fascia + forecourt canopy & two fuel pumps south of the kiosk
    m.box(x + 0.3, 2.08, e + 0.01, r - 0.3, 2.62, e + 0.22, hex(0x8c3a2b), MAT.wall)
    const canZ0 = e + 1.8
    const canZ1 = e + 5.2
    const canX0 = x + 1.2
    const canX1 = r - 1.2
    if (canZ1 < Math.ceil(e / CHUNK) * CHUNK - 0.5) {
      // Forecourt canopy roof (MAT.roof so it cuts away if needed) + twin columns + fuel pump islands
      m.box(canX0, 3.35, canZ0, canX1, 3.68, canZ1, hex(0x7c3426), MAT.roof, id)
      m.box(canX0 + 0.1, 3.28, canZ0 + 0.1, canX1 - 0.1, 3.35, canZ1 - 0.1, hex(0xc8c2b4), MAT.roof, id)
      for (const px of [canX0 + 1.2, canX1 - 1.2]) {
        m.box(px - 0.16, 0.02, (canZ0 + canZ1) * 0.5 - 0.16, px + 0.16, 3.35, (canZ0 + canZ1) * 0.5 + 0.16, hex(0x585c62), MAT.lit)
        m.box(px - 0.55, 0.02, (canZ0 + canZ1) * 0.5 - 0.28, px + 0.55, 1.42, (canZ0 + canZ1) * 0.5 + 0.28, hex(0x8e3828), MAT.lit)
      }
    }
  } else if (arch === "diner" || arch === "grocery") {
    const awningCol = hex(arch === "diner" ? 0x8e3c2e : 0x3e6248)
    m.box(x + 0.3, 2.05, e + 0.01, r - 0.3, 2.58, e + 0.2, awningCol, MAT.wall)
    m.quadAuto([x + 0.4, 2.12, e + 0.2], [r - 0.4, 2.12, e + 0.2], [r - 0.4, 1.82, e + 0.95], [x + 0.4, 1.82, e + 0.95], awningCol, MAT.lit)
  } else {
    // hardware / warehouse
    const signCol = hex(arch === "warehouse" ? 0x4c5258 : 0x8b593d)
    m.box(x + 0.3, 2.05, e + 0.01, r - 0.3, 2.6, e + 0.2, signCol, MAT.wall)
  }
}

export function emitPropFurniture(m: Mesh, p: Prop, town: Town): void {
  const { x, y: z, kind } = p
  if (kind === "tree") {
    plant(m, x, z, 4.6 + p.variant * 1.8, 2.05 + p.variant * 0.75, Math.floor(p.variant * 1e6), supportHeight(town, x, z))
    return
  }
  const wood = hex(0x64462a)
  const legs = hex(0x322920)
  if (kind === "bed") {
    m.box(x - 0.82, 0.12, z - 1.22, x + 0.82, 0.42, z + 1.22, wood, MAT.timber)
    m.box(x - 0.86, 0.15, z - 1.3, x + 0.86, 1.08, z - 1.16, hex(0x5c3e24), MAT.timber)
    m.bevelBox(x - 0.78, 0.42, z - 1.15, x + 0.78, 0.64, z + 1.15, 0.06, hex(0x887e6a), hex(0x988d78))
    m.bevelBox(x - 0.8, 0.44, z - 0.38, x + 0.8, 0.67, z + 1.15, 0.05, hex(0x3a4632), hex(0x48563e))
  } else if (kind === "sofa") {
    m.box(x - 0.56, 0.2, z - 1.26, x + 0.56, 0.45, z + 1.26, hex(0x3c4434))
    m.bevelBox(x - 0.62, 0.35, z - 1.32, x - 0.34, 1.02, z + 1.32, 0.06, hex(0x46503e), hex(0x56624c))
    for (const dz of [-0.74, 0, 0.74]) {
      m.bevelBox(x - 0.32, 0.44, z + dz - 0.35, x + 0.53, 0.62, z + dz + 0.35, 0.055, hex(0x4c5642), hex(0x5c6850))
    }
  } else if (kind === "coffee") {
    m.bevelBox(x - 0.52, 0.42, z - 0.78, x + 0.52, 0.52, z + 0.78, 0.035, hex(0x583e24), hex(0x6e4e2e), MAT.timber, MAT.timber)
  } else if (kind === "nightstand") {
    m.bevelBox(x - 0.28, 0.14, z - 0.28, x + 0.28, 0.66, z + 0.28, 0.02, wood, hex(0x6e4e30), MAT.timber, MAT.timber)
  } else if (kind === "stove") {
    m.box(x - 0.36, 0.13, z - 0.4, x + 0.36, 0.92, z + 0.4, hex(0x584028), MAT.timber)
    m.box(x - 0.38, 0.92, z - 0.42, x + 0.38, 0.96, z + 0.42, hex(0x685e50))
  } else if (kind === "counter" || kind === "dresser" || kind === "fridge") {
    const {
      rect: [a, c, r, e],
      height,
    } = propShape(p)!
    const pale = kind === "fridge" ? 0x5c4228 : 0x583e26
    m.box(a, 0.13, c, r, height - 0.06, e, hex(pale), MAT.timber)
    m.box(a - 0.02, height - 0.06, c - 0.02, r + 0.02, height, e + 0.02, hex(kind === "counter" ? 0x6c6050 : 0x6e4e30), MAT.timber)
  } else if (kind === "chair") {
    m.box(x - 0.26, 0.5, z - 0.26, x + 0.26, 0.58, z + 0.26, hex(0x5e4228), MAT.timber)
    m.box(x - 0.26, 0.58, z + 0.19, x + 0.26, 1.04, z + 0.26, hex(0x6a4c30), MAT.timber)
    for (const dx of [-0.21, 0.21])
      for (const dz of [-0.21, 0.21]) m.box(x + dx - 0.025, 0.13, z + dz - 0.025, x + dx + 0.025, 0.5, z + dz + 0.025, legs)
  } else if (kind === "table") {
    m.bevelBox(x - 0.72, 0.72, z - 0.95, x + 0.72, 0.82, z + 0.95, 0.03, hex(0x5c3e22), hex(0x724e2c), MAT.timber, MAT.timber)
    for (const dx of [-0.6, 0.6])
      for (const dz of [-0.8, 0.8]) m.box(x + dx - 0.045, 0.13, z + dz - 0.045, x + dx + 0.045, 0.72, z + dz + 0.045, legs)
  } else {
    // shelf
    m.box(x - 0.84, 0.13, z - 0.4, x + 0.84, 1.82, z - 0.34, hex(0x382616), MAT.timber)
    for (const dx of [-0.8, 0.8]) m.box(x + dx - 0.06, 0.13, z - 0.38, x + dx + 0.06, 1.82, z + 0.38, legs, MAT.timber)
    for (const h of [0.28, 0.76, 1.24, 1.72]) {
      m.box(x - 0.85, h, z - 0.4, x + 0.85, h + 0.06, z + 0.4, wood, MAT.timber)
    }
  }
}

type PackedPropTemplate = {
  u8: Uint8Array
  vertCount: number
  minX: number
  minZ: number
  maxX: number
  maxZ: number
}

const TREE_TEMPLATE_BUCKETS = 32
const GRASS_CLUSTER_BUCKETS = 16
const propTemplates = new Map<string, PackedPropTemplate>()
const grassClusterTemplates: PackedPropTemplate[] = []
const dummyTown: Town = {
  seed: 7,
  houseSeed: 7,
  terrain: 0,
  foliageDensity: 1,
  chunks: [[0, 0, 32, 32]],
  buildings: [],
  barriers: [],
  doors: [],
  windows: [],
  props: [],
  lamps: [],
}

/**
 * A yard plant from `housePlanting`, built once per (height, radius, seed bucket) and copied into place. Every lot
 * uses the same authored sizes, so a few dozen templates cover all of them and a streamed lot's 25 plants cost a copy
 * each instead of ~0.1 ms of `plant()` apiece. Seeds fold into `YARD_SEED_BUCKETS` variants.
 */
const YARD_SEED_BUCKETS = 4
const yardTemplates = new Map<string, PackedPropTemplate>()
function yardPlantTemplate(h: number, radius: number, seed: number): PackedPropTemplate {
  const bucket = (seed >>> 0) % YARD_SEED_BUCKETS
  const key = `${h}:${radius}:${bucket}`
  let tpl = yardTemplates.get(key)
  if (tpl) return tpl
  const m = new Mesh()
  const footprints = plantFootprints.length
  plant(m, 50, 50, h, radius, 7919 * (bucket + 1) + Math.round(h * 100), 0)
  plantFootprints.length = footprints
  tpl = packTemplate(m, 50, 50)
  yardTemplates.set(key, tpl)
  return tpl
}

function packTemplate(m: Mesh, ox: number, oz: number): PackedPropTemplate {
  let minX = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxZ = -Infinity
  for (let i = 0; i < m.v.length; i += 11) {
    const vx = (m.v[i]! -= ox)
    const vz = (m.v[i + 2]! -= oz)
    if (vx < minX) minX = vx
    if (vx > maxX) maxX = vx
    if (vz < minZ) minZ = vz
    if (vz > maxZ) maxZ = vz
  }
  return { u8: new Uint8Array(stampOutbreakVertexTone(m.pack())), vertCount: m.count, minX, minZ, maxX, maxZ }
}

const isResidential = (b: Building) => {
  const a = b.archetype ?? b.kind
  return a === "house" || a === "ranch" || a === "cottage" || a === "cabin"
}

/** Buildings and trees of recently generated neighbour chunks, by seed, coordinate and mode. */
const neighbourChunks = new Map<string, { buildings: Building[]; trees: Prop[] }>()
const NEIGHBOUR_CACHE = 64

/**
 * The eight surrounding chunks' buildings and trees. Residential chunks share neighbours, so each neighbour is
 * generated once while it stays among the last `NEIGHBOUR_CACHE` used (generation is a pure function of its key).
 */
function neighbourhood(chunk: WorldChunk, town: Town, mode: WorldMode): { buildings: Building[]; trees: Prop[] } {
  const buildings: Building[] = [], trees: Prop[] = []
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue
      const cx = chunk.cx + dx, cy = chunk.cy + dy
      const key = `${town.seed}:${town.houseSeed}:${cx}:${cy}:${mode}`
      let n = neighbourChunks.get(key)
      if (n) neighbourChunks.delete(key)
      else {
        const c = generateWorldChunk(town.seed, town.houseSeed, cx, cy, mode)
        n = { buildings: c.buildings, trees: c.props.filter((p) => p.kind === "tree") }
        if (neighbourChunks.size >= NEIGHBOUR_CACHE) neighbourChunks.delete(neighbourChunks.keys().next().value!)
      }
      neighbourChunks.set(key, n)
      buildings.push(...n.buildings)
      trees.push(...n.trees)
    }
  }
  return { buildings, trees }
}

/**
 * The origin lots' landscaping on a streamed lot, by the same rules (`architecture.ts`, `yard.ts`): L-plan bungalows
 * get the porch, shutters and shed; every house gets foundation shrubs, framing trees and the driveway hedge; every
 * lot gets lawn patches, walkway and driveway tufts and gravel. Seeded per lot. Plants become template placements;
 * the rest goes to `mainScratch` (porch roof is cut with the building) or `opaqueScratch`.
 */
function emitStreamedLot(b: Building, id: number, chunk: WorldChunk, town: Town, mode: WorldMode, x0: number, z0: number, x1: number, z1: number): void {
  const be = b.rect[3]
  const lotSeed = (Math.imul(town.houseSeed + 0x9e37, 0x85ebca6b) ^ Math.imul(chunk.cx, 0x27d4eb2f) ^ Math.imul(chunk.cy, 0x165667b1)) >>> 0
  const street = (x: number, z: number) => {
    const lx = macroLocalCoord(x), lz = macroLocalCoord(z)
    return (lx > 37.8 && lx < 50.2) || (lz > 37.8 && lz < 50.2)
  }
  if (isResidential(b)) {
    const windows: [number, number][] = []
    for (const w of chunk.windows) {
      if (w.buildingId === b.id && Math.abs(w.rect[3] - be) < 0.01 && w.rect[2] - w.rect[0] > 1) windows.push([w.rect[0], w.rect[2]])
    }
    const door = chunk.doors.find((d) => d.id === `${b.id}-front`)
    const decay = (archSettings.houseDecay >= 1 && archSettings.houseDecay <= 4 ? archSettings.houseDecay : (lotSeed % 4) + 1) as HouseDecayState
    if (b.kind === "house") houseFrontage(mainScratch, b, id, town, { windows, decay })
    // Framing plants may reach into neighbouring chunks (the authored lots spill 5 m past the driveway), so they
    // keep clear of every building and tree within a chunk, not just this lot's.
    const near = neighbourhood(chunk, town, mode)
    const others: Building[] = [...near.buildings]
    const trees = chunk.props.filter((p) => p.kind === "tree")
    trees.push(...near.trees)
    for (const o of chunk.buildings) if (o !== b) others.push(o)
    const clear = (r: Rect, px: number, pz: number, m: number) => px < r[0] - m || px > r[2] + m || pz < r[1] - m || pz > r[3] + m
    housePlanting(mainScratch, b, id, town, {
      doorX: door?.rect[0],
      windows,
      seed: lotSeed,
      keep: (px, pz, h) =>
        Math.abs(px - (x0 + x1) / 2) < CHUNK &&
        Math.abs(pz - (z0 + z1) / 2) < CHUNK &&
        !street(px, pz) &&
        clear(b.rect, px, pz, 0.25) &&
        others.every((o) => clear(o.rect, px, pz, h > 2.1 ? 1.2 : 0.25)) &&
        !trees.some((t) => Math.hypot(t.x - px, t.y - pz) < (h > 2.1 ? 3.2 : 1.4)),
      plant: (_m, px, pz, h, radius, seed, ground) => {
        yardPlacementsScratch.push({ x: px, y: ground, z: pz, tpl: yardPlantTemplate(h, radius, seed) })
      },
    })
  }
  const at = () => opaqueScratch
  const lawn = (x: number, z: number) => street(x, z) || x < x0 || x > x1 || z < z0 || z > z1
  emitLawnPatches(at, b, id, town, new Rng(lotSeed ^ 0x73c9), { hero: false, seed: lotSeed, west: x0 + 0.3, east: x1 - 0.3, avoid: lawn })
  emitPathTufts(at, b, town, new Rng(lotSeed ^ 0x91e1))
  emitGravelDriveway(opaqueScratch, b, lotSeed + 177)
}

function getPropTemplate(p: Prop): PackedPropTemplate {
  const key = p.kind === "tree" ? `tree:${Math.min(TREE_TEMPLATE_BUCKETS - 1, Math.floor(p.variant * TREE_TEMPLATE_BUCKETS))}:${vegetationSignature()}` : p.kind
  let tpl = propTemplates.get(key)
  if (tpl) return tpl
  const m = new Mesh()
  if (p.kind === "tree") {
    const bucket = Math.min(TREE_TEMPLATE_BUCKETS - 1, Math.floor(p.variant * TREE_TEMPLATE_BUCKETS))
    const v = (bucket + 0.5) / TREE_TEMPLATE_BUCKETS
    // Build at x=50, z=50 so outer-lot tree LOD (2 sprigs/clump) applies consistently, then shift back to origin (0,0,0)
    plant(m, 50, 50, 4.6 + v * 1.8, 2.05 + v * 0.75, Math.floor(v * 1e6), 0)
    for (let i = 0; i < m.v.length; i += 11) {
      m.v[i]! -= 50
      m.v[i + 2]! -= 50
    }
  } else {
    emitPropFurniture(m, { x: 0, y: 0, kind: p.kind, variant: 0.5 }, dummyTown)
  }
  let minX = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxZ = -Infinity
  for (let i = 0; i < m.v.length; i += 11) {
    const vx = m.v[i]!
    const vz = m.v[i + 2]!
    if (vx < minX) minX = vx
    if (vx > maxX) maxX = vx
    if (vz < minZ) minZ = vz
    if (vz > maxZ) maxZ = vz
  }
  const buf = stampOutbreakVertexTone(m.pack())
  tpl = {
    u8: new Uint8Array(buf),
    vertCount: m.count,
    minX,
    minZ,
    maxX,
    maxZ,
  }
  propTemplates.set(key, tpl)
  return tpl
}

let templatesInitialized = false
export function ensurePropTemplates(): void {
  if (templatesInitialized) return
  templatesInitialized = true
  const kinds: readonly Prop["kind"][] = [
    "bed",
    "sofa",
    "coffee",
    "nightstand",
    "stove",
    "counter",
    "dresser",
    "fridge",
    "chair",
    "table",
    "shelf",
  ]
  for (const kind of kinds) {
    getPropTemplate({ x: 0, y: 0, kind, variant: 0.5 })
  }
  for (let b = 0; b < TREE_TEMPLATE_BUCKETS; b++) {
    getPropTemplate({ x: 0, y: 0, kind: "tree", variant: (b + 0.5) / TREE_TEMPLATE_BUCKETS })
  }
  for (let g = 0; g < GRASS_CLUSTER_BUCKETS; g++) {
    const m = new Mesh()
    const gRng = new Rng(((g + 1) * 0x73c9453a) >>> 0)
    const tufts = scatterGrassClumps({
      seed: ((g + 1) * 0x453a9e37) >>> 0,
      bounds: [-0.8, -0.8, 0.8, 0.8],
      clusterCount: 1,
      tuftsPerCluster: 3,
      params: foliageSettings,
    })
    for (let i = 0; i < tufts.length; i++) {
      const t = tufts[i]!
      if (t.weed) {
        emitGrassClump(m, t, 0, gRng)
        continue
      }
      emitGrassTuft(m, t.x, 0, t.z, {
        bladeCount: 2,
        radius: t.radius * 1.1,
        height: t.height,
        width: t.width,
        curvature: t.curvature,
        leanAngle: t.leanAngle,
        rootColor: t.rootColor,
        tipColor: t.tipColor,
        rng: gRng,
      })
    }
    const buf = stampOutbreakVertexTone(m.pack())
    grassClusterTemplates.push({
      u8: new Uint8Array(buf),
      vertCount: m.count,
      minX: -1.1,
      minZ: -1.1,
      maxX: 1.1,
      maxZ: 1.1,
    })
  }
}

// Reusable scratch buffers and meshes for zero-churn compilation
const POOL_OPAQUE_BYTES = 768 * 1024
const terrainGrid = new Float32Array(33 * 33)
const mainScratch = new Mesh()
const glassScratch = new Mesh()
const opaqueScratch = new Mesh()
const screenScratch = new Mesh()
const roofScratchPool: Mesh[] = []
const bandScratchPool: Mesh[] = []
const bandMap = new Map<number, Mesh>()
const grassPlacementsScratch: { x: number; y: number; z: number; tplIdx: number }[] = []
/** Yard bushes and trees placed by `housePlanting` as cached templates (see `yardPlantTemplate`). */
const yardPlacementsScratch: { x: number; y: number; z: number; tpl: PackedPropTemplate }[] = []

type TileSet = {
  floorTile: Uint8Array<ArrayBuffer>
  moonTile: Uint8Array<ArrayBuffer>
  bounceTile: Uint8Array<ArrayBuffer>
  opaqueBuf?: ArrayBuffer
}
const tilePool: TileSet[] = []
/** Pooled 768 KB opaque buffers set aside while a denser chunk used a larger one. */
const spareOpaque: ArrayBuffer[] = []
/** Larger opaque buffers by size class (whole multiples of 768 KB) for dressed lots and origin chunks. */
const largeOpaquePools = new Map<number, ArrayBuffer[]>()

/**
 * Opaque buffers come in 768 KB size classes. A tile set carries a base-size one; a denser chunk takes a buffer of
 * its own class and returns it to that class's pool, so the base pool never ratchets up to the largest chunk seen.
 */
const poolable = (buf?: ArrayBuffer) => (buf && buf.byteLength % POOL_OPAQUE_BYTES === 0 ? buf : undefined)

function opaqueBuffer(tiles: TileSet, bytes: number): ArrayBuffer {
  if (bytes <= POOL_OPAQUE_BYTES) return tiles.opaqueBuf ?? new ArrayBuffer(POOL_OPAQUE_BYTES)
  if (tiles.opaqueBuf && spareOpaque.length < 8) spareOpaque.push(tiles.opaqueBuf)
  const size = Math.ceil(bytes / POOL_OPAQUE_BYTES) * POOL_OPAQUE_BYTES
  return largeOpaquePools.get(size)?.pop() ?? new ArrayBuffer(size)
}

/** Returns a recycled opaque buffer to its pool; the base size rides with the tile set. */
function baseOpaque(buf?: ArrayBuffer): ArrayBuffer | undefined {
  if (!buf || buf.byteLength % POOL_OPAQUE_BYTES !== 0) return undefined
  if (buf.byteLength === POOL_OPAQUE_BYTES) return buf
  let pool = largeOpaquePools.get(buf.byteLength)
  if (!pool) largeOpaquePools.set(buf.byteLength, (pool = []))
  if (pool.length < 12) pool.push(buf)
  return undefined
}

function acquireTiles(): TileSet {
  const hit = tilePool.pop()
  if (hit) {
    hit.floorTile.fill(0)
    hit.moonTile.fill(255)
    hit.bounceTile.fill(0)
    hit.opaqueBuf ??= spareOpaque.pop()
    return hit
  }
  return {
    floorTile: new Uint8Array(128 * 128 * 2),
    moonTile: new Uint8Array(256 * 256).fill(255),
    bounceTile: new Uint8Array(64 * 64 * 4),
    opaqueBuf: new ArrayBuffer(POOL_OPAQUE_BYTES),
  }
}

export function recycleCompiledChunk(chunk: CompiledWorldChunk): void {
  const opaqueBuf = chunk.staticOpaqueChunks[0]?.data
  if (
    chunk.floorTile.byteLength === 128 * 128 * 2 &&
    chunk.moonTile.byteLength === 256 * 256 &&
    chunk.bounceTile.byteLength === 64 * 64 * 4 &&
    tilePool.length < 56
  ) {
    tilePool.push({
      floorTile: chunk.floorTile,
      moonTile: chunk.moonTile,
      bounceTile: chunk.bounceTile,
      opaqueBuf: baseOpaque(opaqueBuf),
    })
  }
}

export function recycleTileBuffers(
  floorBuf: ArrayBuffer,
  moonBuf: ArrayBuffer,
  bounceBuf: ArrayBuffer,
  opaqueBuf?: ArrayBuffer,
): void {
  if (
    floorBuf.byteLength === 128 * 128 * 2 &&
    moonBuf.byteLength === 256 * 256 &&
    bounceBuf.byteLength === 64 * 64 * 4 &&
    tilePool.length < 56
  ) {
    tilePool.push({
      floorTile: new Uint8Array(floorBuf),
      moonTile: new Uint8Array(moonBuf),
      bounceTile: new Uint8Array(bounceBuf),
      opaqueBuf: baseOpaque(opaqueBuf),
    })
  }
}

const f16Scratch = new Float32Array(1)
const f16Bits = new Uint32Array(f16Scratch.buffer)
function toHalfBits(v: number): number {
  f16Scratch[0] = v
  const x = f16Bits[0]!
  const sign = (x >>> 16) & 0x8000
  let exp = ((x >>> 23) & 0xff) - 127 + 15
  const mant = x & 0x7fffff
  if (exp <= 0) return sign
  if (exp >= 31) return sign | 0x7c00
  let m = mant >> 13
  if (mant & 0x1000) {
    m++
    if (m === 0x400) {
      m = 0
      exp++
    }
  }
  return sign | (exp << 10) | m
}

/** Packs `v` (11 floats/vert) directly into `dstBuf` at byte offset 0 and stamps Outbreak vertex tone in-place. */
function packAndStampInto(v: readonly number[], dstBuf: ArrayBuffer): void {
  const n = v.length / 11
  const f = new Float32Array(dstBuf)
  const b = new Uint8Array(dstBuf)
  const i8 = new Int8Array(dstBuf)
  const h = new Uint16Array(dstBuf)
  for (let k = 0; k < n; k++) {
    const s = k * 11
    const o = k * VERT_BYTES
    const vy = v[s + 1]!
    f[o >> 2] = v[s]!
    f[(o >> 2) + 1] = vy
    f[(o >> 2) + 2] = v[s + 2]!
    const snx = Math.max(-127, Math.min(127, Math.round(v[s + 3]! * 127)))
    const sny = Math.max(-127, Math.min(127, Math.round(v[s + 4]! * 127)))
    const snz = Math.max(-127, Math.min(127, Math.round(v[s + 5]! * 127)))
    i8[o + 12] = snx
    i8[o + 13] = sny
    i8[o + 14] = snz
    i8[o + 15] = 0
    b[o + 16] = Math.max(0, Math.min(255, Math.round(v[s + 6]! * 255)))
    b[o + 17] = Math.max(0, Math.min(255, Math.round(v[s + 7]! * 255)))
    b[o + 18] = Math.max(0, Math.min(255, Math.round(v[s + 8]! * 255)))
    const ny = sny / 127
    let tone = 1.0
    if (vy > 0.04 && vy < 0.24 && Math.abs(ny) < 0.45) {
      tone = 0.72 + (vy - 0.04) * 1.4
    } else if (ny > 0.35 && ny < 0.88 && vy > 0.35 && vy < 2.45) {
      tone = 1.16
    } else if (ny > 0.88 && vy > 0.38 && vy < 1.95) {
      tone = 1.06
    } else if (ny < -0.5 && vy > 2.2) {
      tone = 0.68
    }
    b[o + 19] = Math.max(1, Math.min(254, Math.round(tone * 128)))
    h[(o + 20) >> 1] = toHalfBits(v[s + 9]!)
    h[(o + 22) >> 1] = toHalfBits(v[s + 10]!)
  }
}

const originTowns = new Map<string, Town>()
function originTown(seed: number, houseSeed: number, terrain: number, foliageDensity: number): Town {
  const key = `${seed}:${houseSeed}:${terrain}:${foliageDensity}`
  let town = originTowns.get(key)
  if (!town) {
    town = makeTown(seed, houseSeed, terrain, foliageDensity)
    if (originTowns.size >= 4) originTowns.delete(originTowns.keys().next().value!)
    originTowns.set(key, town)
  }
  return town
}

const concatParts = (parts: readonly LevelChunk[], tiles?: TileSet): { data: ArrayBuffer; byteLength: number } => {
  let byteLength = 0
  for (const p of parts) byteLength += p.data.byteLength
  const data = tiles ? opaqueBuffer(tiles, byteLength) : new ArrayBuffer(byteLength)
  const dst = new Uint8Array(data)
  let off = 0
  for (const p of parts) {
    dst.set(new Uint8Array(p.data), off)
    off += p.data.byteLength
  }
  return { data, byteLength }
}

const unionBox = (parts: readonly LevelChunk[]): readonly [number, number, number, number] => {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity
  for (const p of parts) {
    x0 = Math.min(x0, p.box[0]); z0 = Math.min(z0, p.box[1]); x1 = Math.max(x1, p.box[2]); z1 = Math.max(z1, p.box[3])
  }
  return [x0, z0, x1, z1]
}

/**
 * A streamed chunk of the 96 m origin block, cut from the authored origin build (`buildLevel`) so the streamed window
 * and the origin build draw the same triangles and lighting tiles there and swapping between them is invisible.
 * The origin build is cached per settings key; every buffer is copied because compiled chunks are pooled and
 * transferred out of workers.
 */
function compileOriginChunk(chunk: WorldChunk, seed: number, houseSeed: number, terrain: number, foliageDensity: number, t0: number): CompiledWorldChunk {
  const town = originTown(seed, houseSeed, terrain, foliageDensity)
  const level = buildLevel(town)
  const idx = chunk.cy * 3 + chunk.cx
  const meshCount = town.chunks.length
  const propChunk = (p: Prop) => Math.max(0, Math.min(2, Math.floor(p.y / CHUNK))) * 3 + Math.max(0, Math.min(2, Math.floor(p.x / CHUNK)))
  const ownsSource = (src: number) => (src < meshCount ? src === idx : propChunk(town.props[src - meshCount]!) === idx)
  const opaque: LevelChunk[] = []
  const screens: LevelChunk[] = []
  const roofParts = chunk.buildings.map((): OriginChunk[] => [])
  for (const c of level.chunks) {
    const { src, role, building } = c.origin
    if (role === "custom" || role === "cap") {
      const id = town.buildings[building]?.id
      const local = chunk.buildings.findIndex((b) => b.id === id)
      if (local >= 0) roofParts[local]!.push({ ...c, origin: { ...c.origin, building: local } })
    } else if (ownsSource(src)) {
      ;(role === "screen" ? screens : opaque).push(c)
    }
  }
  const tiles = acquireTiles()
  const staticOpaqueChunks: LevelChunk[] = []
  if (opaque.length) staticOpaqueChunks.push({ ...concatParts(opaque, tiles), box: unionBox(opaque) })
  for (const s of screens) staticOpaqueChunks.push({ data: s.data.slice(0), box: s.box, cutBox: s.cutBox })
  const roofChunks: CompiledRoofChunk[] = []
  for (const c of roofParts.flat()) {
    roofChunks.push({
      data: c.data.slice(0),
      box: c.box,
      cutBox: c.cutBox!,
      buildingIndex: c.origin.building,
      // Origin roofs carry the town's building index in aux; force the first window pack to retag them.
      lastGlobalId: -1,
      roofAuxOnly: true,
      customCutaway: c.customCutaway === "outside" ? "outside" : true,
    })
  }
  const glass = level.glass.filter((c) => c.origin.src === idx)
  const glassChunks: LevelChunk[] = glass.length ? [{ ...concatParts(glass), box: unionBox(glass) }] : []
  const { floorTile, moonTile, bounceTile } = tiles
  const blit = (src: Uint8Array, srcW: number, dst: Uint8Array, tile: number, channels: number) => {
    const row = tile * channels
    for (let r = 0; r < tile; r++) {
      const from = ((chunk.cy * tile + r) * srcW + chunk.cx * tile) * channels
      dst.set(src.subarray(from, from + row), r * row)
    }
  }
  blit(level.floor.data, level.floor.w, floorTile, 128, 2)
  blit(level.floor.moon!.data, level.floor.moon!.w, moonTile, 256, 1)
  blit(level.bounce.data, level.bounce.w, bounceTile, 64, 4)
  // The origin build's sconces (collectSconces) for the buildings this chunk owns.
  const sconces: number[] = []
  mainScratch.v.length = 0
  for (const b of chunk.buildings) emitInteriorDecor(mainScratch, town.buildings.find((t) => t.id === b.id) ?? b, town, undefined, sconces)
  mainScratch.v.length = 0
  return {
    key: chunk.key,
    cx: chunk.cx,
    cy: chunk.cy,
    hash: chunk.hash,
    staticOpaqueChunks,
    glassChunks,
    roofMeshes: [],
    roofChunks,
    buildings: chunk.buildings,
    floorTile,
    moonTile,
    bounceTile,
    sconces: new Float32Array(sconces),
    compileMs: performance.now() - t0,
  }
}

/**
 * Compiles a single 32×32 m `WorldChunk` into meshes and per-chunk lighting tiles:
 * - `floorTile`: 128×128 RG8 (0.25 m/texel)
 * - `moonTile`: 256×256 R8 (0.125 m/texel)
 * - `bounceTile`: 64×64 RGBA8 (0.5 m/texel)
 */
export function compileSingleWorldChunk(
  chunk: WorldChunk,
  seed: number,
  houseSeed: number,
  terrain: number,
  foliageDensity = 1,
  mode: WorldMode = "streaming",
): CompiledWorldChunk {
  const t0 = performance.now()
  if (mode !== "procedural" && chunk.cx >= 0 && chunk.cx < 3 && chunk.cy >= 0 && chunk.cy < 3) {
    return compileOriginChunk(chunk, seed, houseSeed, terrain, foliageDensity, t0)
  }
  ensurePropTemplates()
  plantFootprints.length = 0
  yardPlacementsScratch.length = 0
  mainScratch.v.length = 0
  glassScratch.v.length = 0
  opaqueScratch.v.length = 0
  screenScratch.v.length = 0

  const [x0, z0, x1, z1] = chunk.bounds
  const chunkTown: Town = {
    seed,
    houseSeed,
    terrain,
    foliageDensity,
    chunks: [chunk.bounds],
    buildings: chunk.buildings,
    barriers: chunk.barriers,
    doors: chunk.doors,
    windows: chunk.windows,
    props: chunk.props,
    lamps: chunk.lamps,
    vehicles: chunk.vehicles,
    worldBounds: chunk.bounds,
    windowOrigin: [x0, z0],
    activeChunkKeys: [chunk.key],
  }

  const footprints = chunk.buildings.map(buildingFootprint)
  const sconces: number[] = []
  const isClassicOriginChunk =
    chunk.cx >= 0 &&
    chunk.cx < 3 &&
    chunk.cy >= 0 &&
    chunk.cy < 3 &&
    (chunk.buildings.length === 0 || !chunk.buildings[0]!.id.startsWith("c"))
  const terrainFootprints = isClassicOriginChunk
    ? BUILDING_RECTS.map((r, idx) =>
        buildingFootprint({ id: idx < 2 ? "house" : "store", kind: idx < 2 ? "house" : "hardware", rect: [...r] as Rect, color: 0 }),
      )
    : footprints

  // 1. Precompute 33×33 terrain height grid and emit 1×1m terrain cells directly into opaqueScratch
  for (let dz = 0; dz <= CHUNK; dz++) {
    const wz = z0 + dz
    const rowOff = dz * 33
    for (let dx = 0; dx <= CHUNK; dx++) {
      terrainGrid[rowOff + dx] = terrainVertex(chunkTown, x0 + dx, wz)
    }
  }
  const opV = opaqueScratch.v
  for (let dz = 0; dz < CHUNK; dz++) {
    const z = z0 + dz
    const lz = macroLocalCoord(z)
    if (lz >= 40 && lz < 48) continue
    const r0 = dz * 33
    const r1 = (dz + 1) * 33
    for (let dx = 0; dx < CHUNK; dx++) {
      const x = x0 + dx
      const lx = macroLocalCoord(x)
      if (lx >= 40 && lx < 48) continue
      let inFp = false
      for (let bIdx = 0; bIdx < terrainFootprints.length && !inFp; bIdx++) {
        const fp = terrainFootprints[bIdx]!
        for (let fIdx = 0; fIdx < fp.length; fIdx++) {
          const f = fp[fIdx]!
          if (x >= f[0] && x + 1 <= f[2] && z >= f[1] && z + 1 <= f[3]) {
            inFp = true
            break
          }
        }
      }
      if (inFp) continue
      const ya = terrainGrid[r0 + dx]!
      const yb = terrainGrid[r0 + dx + 1]!
      const yc = terrainGrid[r1 + dx + 1]!
      const yd = terrainGrid[r1 + dx]!
      pushFacetInline(opV, x, ya, z, x + 1, yc, z + 1, x + 1, yb, z, GROUND_COLOR, MAT.ground, 0)
      pushFacetInline(opV, x, ya, z, x, yd, z + 1, x + 1, yc, z + 1, GROUND_COLOR, MAT.ground, 0)
    }
  }

  // 2. Arterial streets, curbs & sidewalks in this chunk (emitted directly to opaqueScratch)
  if (chunk.lx === 1) {
    const roadX0 = x0 + 8
    const roadX1 = x0 + 16
    opaqueScratch.quad([roadX0, 0.014, z1], [roadX1, 0.014, z1], [roadX1, 0.014, z0], [roadX0, 0.014, z0], [0, 1, 0], ROAD_COLOR, MAT.ground, 1)
    for (let z = z0; z < z1; z++) {
      const lz = macroLocalCoord(z)
      if (lz >= 38 && lz < 50) continue
      for (const s of [6, 16] as const) {
        const a = x0 + (s === 6 ? 6 : 16.25)
        const b = x0 + (s === 6 ? 7.75 : 18)
        opaqueScratch.quad([a, 0.1, z + 1], [b, 0.1, z + 1], [b, 0.1, z], [a, 0.1, z], [0, 1, 0], SIDEWALK_COLOR, MAT.ground, 2)
        const edge = x0 + (s === 6 ? 8 : 16)
        const inner = x0 + (s === 6 ? 7.75 : 16.25)
        opaqueScratch.quadAuto([edge, 0.014, z], [edge, 0.014, z + 1], [inner, 0.1, z + 1], [inner, 0.1, z], CURB_COLOR, MAT.ground, 2)
      }
    }
  }
  if (chunk.ly === 1) {
    const roadZ0 = z0 + 8
    const roadZ1 = z0 + 16
    if (chunk.lx !== 1) {
      opaqueScratch.quad([x0, 0.014, roadZ1], [x1, 0.014, roadZ1], [x1, 0.014, roadZ0], [x0, 0.014, roadZ0], [0, 1, 0], ROAD_COLOR, MAT.ground, 1)
    } else {
      opaqueScratch.quad([x0, 0.014, roadZ1], [x0 + 8, 0.014, roadZ1], [x0 + 8, 0.014, roadZ0], [x0, 0.014, roadZ0], [0, 1, 0], ROAD_COLOR, MAT.ground, 1)
      opaqueScratch.quad([x0 + 16, 0.014, roadZ1], [x1, 0.014, roadZ1], [x1, 0.014, roadZ0], [x0 + 16, 0.014, roadZ0], [0, 1, 0], ROAD_COLOR, MAT.ground, 1)
    }
    for (let x = x0; x < x1; x++) {
      const lx = macroLocalCoord(x)
      if (lx >= 38 && lx < 50) continue
      for (const s of [6, 16] as const) {
        const a = z0 + (s === 6 ? 6 : 16.25)
        const b = z0 + (s === 6 ? 7.75 : 18)
        opaqueScratch.quad([x, 0.1, b], [x + 1, 0.1, b], [x + 1, 0.1, a], [x, 0.1, a], [0, 1, 0], SIDEWALK_COLOR, MAT.ground, 2)
        const edge = z0 + (s === 6 ? 8 : 16)
        const inner = z0 + (s === 6 ? 7.75 : 16.25)
        opaqueScratch.quadAuto([x, 0.014, edge], [x + 1, 0.014, edge], [x + 1, 0.1, inner], [x, 0.1, inner], CURB_COLOR, MAT.ground, 2)
      }
    }
  }

  // 3. Grass tufts scattered across chunk lawn (using pre-packed grass cluster templates)
  const grassRng = new Rng((seed ^ Math.imul(chunk.cx * 73 + chunk.cy * 151, 0x73c9)) >>> 0)
  const clusterTarget = Math.max(3, Math.round(9 * foliageDensity))
  grassPlacementsScratch.length = 0
  for (let attempt = 0; attempt < clusterTarget * 3 && grassPlacementsScratch.length < clusterTarget; attempt++) {
    const gx = x0 + 1.5 + grassRng.next() * (CHUNK - 3.0)
    const gz = z0 + 1.5 + grassRng.next() * (CHUNK - 3.0)
    const lx = macroLocalCoord(gx)
    const lz = macroLocalCoord(gz)
    if ((lx > 38 && lx < 50) || (lz > 38 && lz < 50)) continue
    let inBld = false
    for (let bIdx = 0; bIdx < chunk.buildings.length; bIdx++) {
      const b = chunk.buildings[bIdx]!
      if (gx >= b.rect[0] - 2.5 && gx <= b.rect[2] + 0.5 && gz >= b.rect[1] - 0.5 && gz <= b.rect[3] + 2.5) {
        inBld = true
        break
      }
    }
    if (inBld) continue
    grassPlacementsScratch.push({
      x: gx,
      y: supportHeight(chunkTown, gx, gz),
      z: gz,
      tplIdx: (attempt + chunk.cx * 3 + chunk.cy * 7) & (GRASS_CLUSTER_BUCKETS - 1),
    })
  }

  // 4. Buildings, floors, walkways & POI architecture
  for (let id = 0; id < chunk.buildings.length; id++) {
    const b = chunk.buildings[id]!
    const [bx, bz, br, bend] = b.rect
    const fp = footprints[id]!
    for (let fIdx = 0; fIdx < fp.length; fIdx++) {
      const [fx0, fz0, fx1, fz1] = fp[fIdx]!
      floor(opaqueScratch, fx0, fz0, fx1, fz1, 0.13, b.kind === "house" ? 0x5d442c : 0x89968b, b.kind === "house" ? 2 : 1)
    }
    floor(opaqueScratch, bx + 4.5, bend, Math.min(br - 0.5, bx + 7), bend + 1.3, 0.13, 0x6a6254, 6)
    floor(opaqueScratch, bx + 5, bend + 1.3, Math.min(br - 0.5, bx + 6.4), frontageEnd(b) + 2, 0.13, 0x6e6658, 6)
    floor(opaqueScratch, bx - 3, bz, bx - 0.35, frontageEnd(b) + 2, 0.035, 0x66625a, 7)
    emitPoiArchitecture(mainScratch, b, id, chunkTown)
    emitBuildingRugs(mainScratch, b, chunkTown)
    emitInteriorDecor(mainScratch, b, chunkTown, undefined, sconces)
    emitStreamedLot(b, id, chunk, chunkTown, mode, x0, z0, x1, z1)
  }
  // Root-collar tufts around the chunk's trees and rosettes along an east-west street's verges, as at the origin.
  const yardStreet = (x: number, z: number) => {
    const lx = macroLocalCoord(x), lz = macroLocalCoord(z)
    return (lx > 37.9 && lx < 50.1) || (lz > 37.9 && lz < 50.1)
  }
  for (let i = 0; i < chunk.props.length; i++) {
    const p = chunk.props[i]!
    if (p.kind === "tree") emitTreeCollar(() => opaqueScratch, p, chunkTown, new Rng((seed ^ Math.imul(i + 1, 2749) ^ Math.imul(chunk.cx * 31 + chunk.cy, 0x517c)) >>> 0), yardStreet)
  }
  if (chunk.ly === 1) {
    // The origin's verge rows sit 1.86..2.14 m either side of the 40..48 m street; lots face it from both sides.
    const lotX = x0 + (chunk.lx === 0 ? 13.5 : 3.5)
    emitStreetVerge(
      () => opaqueScratch,
      chunkTown,
      new Rng((seed ^ 0x91e1 ^ Math.imul(chunk.cx, 0x45d9f3b) ^ Math.imul(chunk.cy, 0x27d4eb2f)) >>> 0),
      x0 + 0.3,
      x1,
      [[z0 + 5.86, false], [z0 + 7.55, true], [z0 + 16.45, true], [z0 + 18.14, false]],
      (v) => {
        const lx = macroLocalCoord(v)
        return lx > 37.5 && lx < 50.5
      },
      (v) => chunk.lx !== 1 && (Math.abs(v - (lotX + 5.7)) < 0.95 || (v > lotX - 3.1 && v < lotX - 0.25)),
    )
  }

  // 5. Walls, windows & fences
  const wallTopCol = hex(0x4a4338)
  const wallCapCol = hex(0x28231d)
  const trimBaseCol = hex(0x3a2a1c)
  const sillCol = hex(0x787060)
  const glassWarmCol = hex(0x463626)
  const glassCoolCol = hex(0x6e888c)
  const fenceRailCol = hex(0x6e685a)
  const fencePostCol = hex(0x645e50)
  const fencePickCols: readonly Rgb[] = [hex(0x8a8272), hex(0x7c7566), hex(0x948c7b), hex(0x70695b)]

  for (let i = 0; i < chunk.barriers.length; i++) {
    const b = chunk.barriers[i]!
    const [x, z, r, end] = b.rect
    const color = hex(b.color)
    if (b.kind === "wall") {
      mainScratch.box(x, 0.13, z, r, 2.78, end, color, MAT.wall, 20, wallTopCol)
      mainScratch.box(x + 0.03, 2.78, z + 0.03, r - 0.03, 2.8, end - 0.03, wallCapCol, MAT.lit)
      opaqueScratch.box(x - 0.02, 0.14, z - 0.02, r + 0.02, 0.26, end + 0.02, trimBaseCol, MAT.timber)
      emitWallCapMoulding(mainScratch, x, z, r, end)
    } else if (b.kind === "window") {
      opaqueScratch.box(x, 0.13, z, r, 0.84, end, color, MAT.wall, 20)
      mainScratch.box(x, 2.16, z, r, 2.78, end, color, MAT.wall, 20, wallTopCol)
      mainScratch.box(x + 0.03, 2.78, z + 0.03, r - 0.03, 2.8, end - 0.03, wallCapCol, MAT.lit)
      emitWallCapMoulding(mainScratch, x, z, r, end)
      const owner = interiorSettings.craft ? chunk.buildings.find((o) => x >= o.rect[0] - 0.05 && r <= o.rect[2] + 0.05 && z >= o.rect[1] - 0.05 && end <= o.rect[3] + 0.05) : undefined
      if (owner) {
        const horizontal = r - x >= end - z
        const out = (horizontal ? inBuildingFootprint(owner, (x + r) * 0.5, z - 0.3) : inBuildingFootprint(owner, x - 0.3, (z + end) * 0.5)) ? 1 : -1
        emitCraftWindow({ low: opaqueScratch, high: mainScratch, glass: glassScratch }, b.rect, { out, theme: planInterior(owner, houseSeed).theme, cool: !horizontal })
      } else if (r - x > 1) {
        const zm = (z + end) * 0.5
        opaqueScratch.box(x - 0.06, 0.79, z - 0.06, r + 0.06, 0.86, end + 0.1, sillCol, MAT.wall)
        mainScratch.box(x - 0.06, 2.14, z - 0.05, r + 0.06, 2.22, end + 0.08, sillCol, MAT.wall)
        glassScratch.box(x + 0.06, 0.86, zm - 0.01, r - 0.06, 2.14, zm + 0.01, glassWarmCol, MAT.glass)
      } else {
        const xm = (x + r) * 0.5
        opaqueScratch.box(x - 0.06, 0.79, z - 0.06, r + 0.1, 0.86, end + 0.06, sillCol, MAT.wall)
        mainScratch.box(x - 0.05, 2.14, z - 0.06, r + 0.08, 2.22, end + 0.06, sillCol, MAT.wall)
        glassScratch.box(xm - 0.01, 0.86, z + 0.06, xm + 0.01, 2.14, end - 0.06, glassCoolCol, MAT.glass)
      }
    } else {
      // Fence (MAT.timber, never screen-cuttable or roof -> goes directly to opaqueScratch)
      const horizontal = r - x > end - z
      const length = horizontal ? r - x : end - z
      const fenceRng = new Rng((houseSeed ^ Math.floor(x * 31 + z * 59)) >>> 0)
      let pIdx = 0
      for (let d = 0; d < length; d += 0.34, pIdx++) {
        const px = x + (horizontal ? d : 0)
        const pz = z + (horizontal ? 0 : d)
        if (pIdx % 7 === 0) {
          opaqueScratch.box(px - 0.02, 0.03, pz - 0.02, px + 0.12, 1.22, pz + 0.12, fencePostCol, MAT.timber)
          continue
        }
        const pCol = fenceRng.pick(fencePickCols)
        const w = horizontal ? 0.14 : 0.07
        const dp = horizontal ? 0.07 : 0.14
        opaqueScratch.box(px, 0.04, pz, px + w, 1.08, pz + dp, pCol, MAT.timber)
      }
      for (const h of [0.3, 0.84]) opaqueScratch.box(x, h, z, r, h + 0.065, end, fenceRailCol, MAT.timber)
    }
  }

  // 7. Lamp fixtures (emitted directly to opaqueScratch)
  const streetPoleCol = hex(0x353d3c)
  const streetBulbCol = hex(0xffc980)
  const porchBulbCol = hex(0xffe0a6)
  const roomBulbCol = hex(0xe8b86b)
  for (let id = 0; id < chunk.lamps.length; id++) {
    const p = chunk.lamps[id]!
    if (p.kind === "window") continue
    if (p.kind === "street") {
      opaqueScratch.prism(p.x, p.y, 0.13, 0.07, 0.1, 3.8, 8, streetPoleCol)
      opaqueScratch.box(p.x - 0.08, 3.65, p.y - 0.08, p.x + 0.7, 3.8, p.y + 0.08, streetPoleCol)
      opaqueScratch.box(p.x + 0.3, 3.55, p.y - 0.18, p.x + 0.8, 3.65, p.y + 0.18, streetBulbCol, MAT.lamp, id)
    } else if (p.kind === "porch") {
      opaqueScratch.prism(p.x, p.y - 0.22, 0.1, 0.08, 2.24, 2.38, 7, porchBulbCol, MAT.lamp, id)
    } else if (p.kind === "room" && p.h <= 2.3) {
      opaqueScratch.prism(p.x, p.y, 0.23, 0.125, p.h - 0.13, p.h + 0.16, 9, roomBulbCol, MAT.lamp, id)
    }
  }

  // 8. Bake per-chunk 128×128 floor contact AO & indoor sky mask tile (0.25 m/texel)
  const tiles = acquireTiles()
  const { floorTile, moonTile, bounceTile } = tiles
  const fRes = 128
  const fScale = CHUNK / fRes // 0.25 m
  for (let i = 1; i < floorTile.length; i += 2) floorTile[i] = 255
  for (let bIdx = 0; bIdx < footprints.length; bIdx++) {
    const fp = footprints[bIdx]!
    for (let fIdx = 0; fIdx < fp.length; fIdx++) {
      const [fx0, fz0, fx1, fz1] = fp[fIdx]!
      const tx0 = Math.max(0, Math.floor((fx0 - x0) / fScale))
      const tx1 = Math.min(fRes - 1, Math.ceil((fx1 - x0) / fScale))
      const tz0 = Math.max(0, Math.floor((fz0 - z0) / fScale))
      const tz1 = Math.min(fRes - 1, Math.ceil((fz1 - z0) / fScale))
      for (let tz = tz0; tz <= tz1; tz++) {
        const pz = z0 + (tz + 0.5) * fScale
        if (pz < fz0 || pz > fz1) continue
        for (let tx = tx0; tx <= tx1; tx++) {
          const px = x0 + (tx + 0.5) * fScale
          if (px >= fx0 && px <= fx1) floorTile[(tz * fRes + tx) * 2 + 1] = 14
        }
      }
    }
  }
  const stampFloorRect = (r: Rect, decay: number, weight: number, pad: number) => {
    const tx0 = Math.max(0, Math.floor((r[0] - pad - x0) / fScale))
    const tx1 = Math.min(fRes - 1, Math.ceil((r[2] + pad - x0) / fScale))
    const tz0 = Math.max(0, Math.floor((r[1] - pad - z0) / fScale))
    const tz1 = Math.min(fRes - 1, Math.ceil((r[3] + pad - z0) / fScale))
    for (let tz = tz0; tz <= tz1; tz++) {
      const pz = z0 + (tz + 0.5) * fScale
      for (let tx = tx0; tx <= tx1; tx++) {
        const px = x0 + (tx + 0.5) * fScale
        const c = Math.round(Math.exp(-distToRect(px, pz, r) * decay) * weight * 255)
        const idx = (tz * fRes + tx) * 2
        if (c > floorTile[idx]!) floorTile[idx] = c
      }
    }
  }
  for (let i = 0; i < chunk.barriers.length; i++) {
    const wall = chunk.barriers[i]!
    if (wall.kind !== "fence") stampFloorRect(wall.rect, 4, 0.8, 1.6)
  }
  for (let i = 0; i < chunk.props.length; i++) {
    const p = chunk.props[i]!
    if (p.kind === "tree") {
      const tx0 = Math.max(0, Math.floor((p.x - 3.1 - x0) / fScale))
      const tx1 = Math.min(fRes - 1, Math.ceil((p.x + 3.1 - x0) / fScale))
      const tz0 = Math.max(0, Math.floor((p.y - 3.1 - z0) / fScale))
      const tz1 = Math.min(fRes - 1, Math.ceil((p.y + 3.1 - z0) / fScale))
      for (let tz = tz0; tz <= tz1; tz++) {
        const pz = z0 + (tz + 0.5) * fScale
        const dz2 = (pz - p.y) ** 2
        for (let tx = tx0; tx <= tx1; tx++) {
          const px = x0 + (tx + 0.5) * fScale
          const c = Math.round(Math.exp(-((px - p.x) ** 2 + dz2) / 1.5) * 0.65 * 255)
          const idx = (tz * fRes + tx) * 2
          if (c > floorTile[idx]!) floorTile[idx] = c
        }
      }
    } else {
      const s = propShape(p)
      if (s) stampFloorRect(s.rect, 5, 0.85, 1.3)
    }
  }

  // 9. Bake per-chunk 256×256 directional moon & tree-canopy mask tile (0.125 m/texel) via direct rect stamping
  const mRes = 256
  const mScale = CHUNK / mRes // 0.125 m
  for (let bIdx = 0; bIdx < footprints.length; bIdx++) {
    const fp = footprints[bIdx]!
    // First pass: exterior directional shadow (+1.15, +0.85)
    for (let fIdx = 0; fIdx < fp.length; fIdx++) {
      const [fx0, fz0, fx1, fz1] = fp[fIdx]!
      const sx0 = fx0 + 1.15
      const sz0 = fz0 + 0.85
      const sx1 = fx1 + 1.15
      const sz1 = fz1 + 0.85
      const tx0 = Math.max(0, Math.floor((sx0 - x0) / mScale))
      const tx1 = Math.min(mRes - 1, Math.ceil((sx1 - x0) / mScale))
      const tz0 = Math.max(0, Math.floor((sz0 - z0) / mScale))
      const tz1 = Math.min(mRes - 1, Math.ceil((sz1 - z0) / mScale))
      for (let tz = tz0; tz <= tz1; tz++) {
        const pz = z0 + (tz + 0.5) * mScale
        if (pz < sz0 || pz > sz1) continue
        const rowOff = tz * mRes
        for (let tx = tx0; tx <= tx1; tx++) {
          const px = x0 + (tx + 0.5) * mScale
          if (px >= sx0 && px <= sx1) {
            const idx = rowOff + tx
            if (moonTile[idx]! > 158) moonTile[idx] = 158
          }
        }
      }
    }
    // Second pass: indoor footprint (14)
    for (let fIdx = 0; fIdx < fp.length; fIdx++) {
      const [fx0, fz0, fx1, fz1] = fp[fIdx]!
      const tx0 = Math.max(0, Math.floor((fx0 - x0) / mScale))
      const tx1 = Math.min(mRes - 1, Math.ceil((fx1 - x0) / mScale))
      const tz0 = Math.max(0, Math.floor((fz0 - z0) / mScale))
      const tz1 = Math.min(mRes - 1, Math.ceil((fz1 - z0) / mScale))
      for (let tz = tz0; tz <= tz1; tz++) {
        const pz = z0 + (tz + 0.5) * mScale
        if (pz < fz0 || pz > fz1) continue
        const rowOff = tz * mRes
        for (let tx = tx0; tx <= tx1; tx++) {
          const px = x0 + (tx + 0.5) * mScale
          if (px >= fx0 && px <= fx1) moonTile[rowOff + tx] = 14
        }
      }
    }
  }
  for (let i = 0; i < chunk.props.length; i++) {
    const t = chunk.props[i]!
    if (t.kind !== "tree") continue
    const rCrown = 2.15 + t.variant * 0.75
    const cxT = t.x + 0.45
    const czT = t.y + 0.35
    const tx0 = Math.max(0, Math.floor((cxT - rCrown - x0) / mScale))
    const tx1 = Math.min(mRes - 1, Math.ceil((cxT + rCrown - x0) / mScale))
    const tz0 = Math.max(0, Math.floor((czT - rCrown - z0) / mScale))
    const tz1 = Math.min(mRes - 1, Math.ceil((czT + rCrown - z0) / mScale))
    const invR2 = 1 / (rCrown * rCrown)
    for (let tz = tz0; tz <= tz1; tz++) {
      const dz = z0 + (tz + 0.5) * mScale - czT
      const dz2 = dz * dz
      const rowOff = tz * mRes
      for (let tx = tx0; tx <= tx1; tx++) {
        const idx = rowOff + tx
        if (moonTile[idx]! <= 25) continue
        const dx = x0 + (tx + 0.5) * mScale - cxT
        const u2 = (dx * dx + dz2) * invR2
        if (u2 < 1.0) {
          const atten = Math.round((1 - (1 - u2) * 0.35) * 255)
          if (atten < moonTile[idx]!) moonTile[idx] = atten
        }
      }
    }
  }

  // 10. Bake per-chunk 64×64 indirect bounce tile (0.5 m/texel)
  const bRes = 64
  const bScale = CHUNK / bRes // 0.5 m
  for (let i = 0; i < bRes * bRes; i++) bounceTile[i * 4 + 3] = 255
  for (let i = 0; i < chunk.lamps.length; i++) {
    const lamp = chunk.lamps[i]!
    const res = resolveLampLight(lamp, chunk.buildings, 1, DEFAULT_OUTBREAK_LIGHTING, false)
    const reach = Math.min(9.5, res.r * 1.25)
    const tx0 = Math.max(0, Math.floor((res.lx - reach - x0) / bScale))
    const tx1 = Math.min(bRes - 1, Math.ceil((res.lx + reach - x0) / bScale))
    const tz0 = Math.max(0, Math.floor((res.ly - reach - z0) / bScale))
    const tz1 = Math.min(bRes - 1, Math.ceil((res.ly + reach - z0) / bScale))
    const k = res.power * 0.48
    for (let tz = tz0; tz <= tz1; tz++) {
      const pz = z0 + (tz + 0.5) * bScale
      for (let tx = tx0; tx <= tx1; tx++) {
        const px = x0 + (tx + 0.5) * bScale
        const d = Math.hypot(px - res.lx, pz - res.ly)
        if (d >= reach) continue
        const t = 1 - d / reach
        const f = t * t * k
        const idx = (tz * bRes + tx) * 4
        for (let c = 0; c < 3; c++) {
          const cur = (bounceTile[idx + c]! / 255) ** 2
          const next = Math.min(1, cur + res.color[c]! * f * 0.5)
          bounceTile[idx + c] = Math.round(Math.sqrt(next) * 255)
        }
      }
    }
  }
  // Baked pools of the room accent lamps (line of sight against this chunk's walls), as in the origin town's bake.
  let poolAcc: Float32Array | null = null
  let poolSolid: Uint8Array | null = null
  for (let i = 0; i < chunk.lamps.length; i++) {
    const pool = bakedRoomLamp(chunk.lamps[i]!, chunk.buildings)
    if (!pool) continue
    if (!poolAcc || !poolSolid) {
      poolAcc = new Float32Array(bRes * bRes * 3)
      poolSolid = wallGrid(chunk.barriers.filter(b => b.kind === "wall").map(b => b.rect), x0, z0, bRes, bScale)
    }
    addLampPool(poolAcc, poolSolid, bRes, x0, z0, bScale, pool)
  }
  if (poolAcc) {
    for (let i = 0; i < bRes * bRes; i++) {
      for (let c = 0; c < 3; c++) {
        const add = poolAcc[i * 3 + c]!
        if (add <= 0) continue
        const idx = i * 4 + c
        const cur = (bounceTile[idx]! / 255) ** 2
        bounceTile[idx] = Math.round(Math.sqrt(Math.min(1, cur + add * 0.5)) * 255)
      }
    }
  }

  const packSimple = (mesh: Mesh, cutBox?: readonly number[], customCutaway?: boolean | "outside"): LevelChunk[] => {
    if (!mesh.count) return []
    let bx0 = Infinity,
      bz0 = Infinity,
      bx1 = -Infinity,
      top = 0,
      bz1 = -Infinity
    for (let i = 0; i < mesh.v.length; i += 11) {
      bx0 = Math.min(bx0, mesh.v[i]!)
      bx1 = Math.max(bx1, mesh.v[i]!)
      top = Math.max(top, mesh.v[i + 1]!)
      bz0 = Math.min(bz0, mesh.v[i + 2]!)
      bz1 = Math.max(bz1, mesh.v[i + 2]!)
    }
    return [
      {
        data: stampOutbreakVertexTone(mesh.pack()),
        box: [bx0, bz0, bx1, bz1] as const,
        cutBox: cutBox ?? (customCutaway ? [bx0, 0, bz0, bx1, top, bz1] : undefined),
        customCutaway,
      },
    ]
  }

  // Split mainScratch into roofScratchPool, screenScratch, and opaqueScratch
  while (roofScratchPool.length < chunk.buildings.length) roofScratchPool.push(new Mesh())
  for (let i = 0; i < chunk.buildings.length; i++) roofScratchPool[i]!.v.length = 0

  if (mainScratch.count) {
    const mv = mainScratch.v
    for (let i = 0; i < mv.length; i += 33) {
      let minY = Infinity
      let maxY = -Infinity
      let hasRoof = false
      let hasScreen = false
      let hasFoliage = false
      for (let j = 0; j < 33; j += 11) {
        const vy = mv[i + j + 1]!
        const mat = Math.round(mv[i + j + 9]!)
        if (vy < minY) minY = vy
        if (vy > maxY) maxY = vy
        if (mat === 21) hasRoof = true
        if (mat === 22) hasFoliage = true
        if ((mat === 4 || mat === 9 || mat === 11) && vy > 1.0) hasScreen = true
      }
      if (minY > 2.801 && !hasFoliage) hasRoof = true
      let dst: number[]
      if (hasRoof && chunk.buildings.length > 0) {
        const localId = Math.max(0, Math.min(chunk.buildings.length - 1, Math.round(mv[i + 10]!)))
        dst = roofScratchPool[localId]!.v
      } else {
        dst = hasScreen ? screenScratch.v : opaqueScratch.v
      }
      for (let k = i; k < i + 33; k++) dst.push(mv[k]!)
    }
  }

  // Pack opaqueScratch + pre-packed prop/tree/grass templates into a single pooled LevelChunk per 32×32 m chunk
  const staticOpaqueChunks: LevelChunk[] = []
  let propVertsTotal = 0
  for (let i = 0; i < chunk.props.length; i++) {
    propVertsTotal += getPropTemplate(chunk.props[i]!).vertCount
  }
  for (let i = 0; i < grassPlacementsScratch.length; i++) {
    propVertsTotal += grassClusterTemplates[grassPlacementsScratch[i]!.tplIdx]!.vertCount
  }
  for (let i = 0; i < yardPlacementsScratch.length; i++) propVertsTotal += yardPlacementsScratch[i]!.tpl.vertCount
  const baseOpaqueVerts = opaqueScratch.count
  const totalOpaqueVerts = baseOpaqueVerts + propVertsTotal
  if (totalOpaqueVerts > 0) {
    let bx0 = x0,
      bz0 = z0,
      bx1 = x1,
      bz1 = z1
    const neededBytes = totalOpaqueVerts * VERT_BYTES
    const combinedBuf = opaqueBuffer(tiles, neededBytes)
    const combinedU8 = new Uint8Array(combinedBuf, 0, neededBytes)
    const combinedF32 = new Float32Array(combinedBuf, 0, totalOpaqueVerts * 6)
    if (baseOpaqueVerts > 0) {
      for (let i = 0; i < opaqueScratch.v.length; i += 11) {
        const vx = opaqueScratch.v[i]!
        const vz = opaqueScratch.v[i + 2]!
        if (vx < bx0) bx0 = vx
        if (vx > bx1) bx1 = vx
        if (vz < bz0) bz0 = vz
        if (vz > bz1) bz1 = vz
      }
      packAndStampInto(opaqueScratch.v, combinedBuf)
    }
    let vertCursor = baseOpaqueVerts
    for (let i = 0; i < grassPlacementsScratch.length; i++) {
      const gp = grassPlacementsScratch[i]!
      const tpl = grassClusterTemplates[gp.tplIdx]!
      combinedU8.set(tpl.u8, vertCursor * VERT_BYTES)
      const endVert = vertCursor + tpl.vertCount
      const gx = gp.x, gy = gp.y, gz = gp.z
      for (let v = vertCursor; v < endVert; v++) {
        const fOff = v * 6
        combinedF32[fOff] = combinedF32[fOff]! + gx
        combinedF32[fOff + 1] = combinedF32[fOff + 1]! + gy
        combinedF32[fOff + 2] = combinedF32[fOff + 2]! + gz
      }
      vertCursor = endVert
    }
    for (let i = 0; i < yardPlacementsScratch.length; i++) {
      const { x: px, y: py, z: pz, tpl } = yardPlacementsScratch[i]!
      if (px + tpl.minX < bx0) bx0 = px + tpl.minX
      if (px + tpl.maxX > bx1) bx1 = px + tpl.maxX
      if (pz + tpl.minZ < bz0) bz0 = pz + tpl.minZ
      if (pz + tpl.maxZ > bz1) bz1 = pz + tpl.maxZ
      combinedU8.set(tpl.u8, vertCursor * VERT_BYTES)
      const endVert = vertCursor + tpl.vertCount
      for (let v = vertCursor; v < endVert; v++) {
        const fOff = v * 6
        combinedF32[fOff] = combinedF32[fOff]! + px
        combinedF32[fOff + 1] = combinedF32[fOff + 1]! + py
        combinedF32[fOff + 2] = combinedF32[fOff + 2]! + pz
      }
      vertCursor = endVert
    }
    for (let i = 0; i < chunk.props.length; i++) {
      const p = chunk.props[i]!
      const tpl = getPropTemplate(p)
      const px = p.x
      const pz = p.y
      const py = p.kind === "tree" ? supportHeight(chunkTown, px, pz) : 0
      if (px + tpl.minX < bx0) bx0 = px + tpl.minX
      if (px + tpl.maxX > bx1) bx1 = px + tpl.maxX
      if (pz + tpl.minZ < bz0) bz0 = pz + tpl.minZ
      if (pz + tpl.maxZ > bz1) bz1 = pz + tpl.maxZ
      combinedU8.set(tpl.u8, vertCursor * VERT_BYTES)
      const endVert = vertCursor + tpl.vertCount
      for (let v = vertCursor; v < endVert; v++) {
        const fOff = v * 6
        combinedF32[fOff] = combinedF32[fOff]! + px
        combinedF32[fOff + 1] = combinedF32[fOff + 1]! + py
        combinedF32[fOff + 2] = combinedF32[fOff + 2]! + pz
      }
      vertCursor = endVert
    }
    staticOpaqueChunks.push({
      data: combinedBuf,
      byteLength: neededBytes,
      box: [bx0, bz0, bx1, bz1] as const,
    })
  }

  // Pack 4×4 m screen-cuttable wall bands using pooled band meshes
  if (screenScratch.count) {
    bandMap.clear()
    let bandPoolIdx = 0
    const sv = screenScratch.v
    for (let i = 0; i < sv.length; i += 33) {
      const xBand = Math.floor(Math.min(sv[i]!, sv[i + 11]!, sv[i + 22]!) / 4)
      const zBand = Math.floor(Math.min(sv[i + 2]!, sv[i + 13]!, sv[i + 24]!) / 4)
      const key = xBand * 1024 + zBand
      let bm = bandMap.get(key)
      if (!bm) {
        if (bandPoolIdx >= bandScratchPool.length) bandScratchPool.push(new Mesh())
        bm = bandScratchPool[bandPoolIdx++]!
        bm.v.length = 0
        bandMap.set(key, bm)
      }
      for (let k = i; k < i + 33; k++) bm.v.push(sv[k]!)
    }
    for (const bm of bandMap.values()) {
      for (const c of packSimple(bm)) {
        staticOpaqueChunks.push({ ...c, cutBox: [c.box[0], 0, c.box[1], c.box[2], 2.85, c.box[3]] })
      }
    }
  }

  // Pre-pack roof chunks once per building so window transitions never re-pack roof meshes
  const roofChunks: CompiledRoofChunk[] = []
  for (let localId = 0; localId < chunk.buildings.length; localId++) {
    const b = chunk.buildings[localId]!
    const rm = roofScratchPool[localId]!
    if (!rm.count) continue
    const isOriginHouse = b.id === "ash" || b.id === "elm"
    const southPad = isOriginHouse ? 1.7 : 0.1
    // "outside" chunks are skipped while the survivor stands inside this box, so it hugs the walls (no porch margin).
    const bounds = [b.rect[0] - 0.1, 0, b.rect[1] - 0.1, b.rect[2] + 0.1, 7.5, b.rect[3] + southPad] as const
    roofChunks.push({
      data: stampOutbreakVertexTone(rm.pack()),
      // L-plan bungalows carry the porch canopy (to e + 1.3) in their roof chunk.
      box: [b.rect[0] - 0.5, b.rect[1] - 0.5, b.rect[2] + 0.5, b.rect[3] + (b.kind === "house" ? 1.7 : southPad)] as const,
      cutBox: bounds,
      buildingIndex: localId,
      lastGlobalId: localId,
    })
  }

  const glassChunks = packSimple(glassScratch)

  return {
    key: chunk.key,
    cx: chunk.cx,
    cy: chunk.cy,
    hash: chunk.hash,
    staticOpaqueChunks,
    glassChunks,
    roofMeshes: [],
    roofChunks,
    buildings: chunk.buildings,
    floorTile,
    moonTile,
    bounceTile,
    sconces: new Float32Array(sconces),
    compileMs: performance.now() - t0,
  }
}

/**
 * Returns a compiled chunk's pre-packed static & glass chunks plus roof chunks tagged in-place with the window-wide `buildingId`.
 */
function packChunkMeshesForWindow(
  compiled: CompiledWorldChunk,
  windowBuildings: readonly Building[],
  isFading = false,
): { opaque: LevelChunk[]; glass: LevelChunk[] } {
  const slot = (((compiled.cy % 5) + 5) % 5) * 5 + (((compiled.cx % 5) + 5) % 5)
  const rChunks = compiled.roofChunks
  const globalIds =
    rChunks && rChunks.length > 0 && compiled.buildings.length > 0
      ? rChunks.map((rc) => {
          const id = compiled.buildings[rc.buildingIndex]?.id
          const s = id ? windowBuildings.findIndex((b) => b.id === id) : -1
          return s >= 0 ? Math.min(15, s) : 15
        })
      : []
  const streamKey = globalIds.length > 0 ? `${compiled.key}:${compiled.hash}:${globalIds.join(",")}` : `${compiled.key}:${compiled.hash}`
  const outOpaque: LevelChunk[] = []
  for (let i = 0; i < compiled.staticOpaqueChunks.length; i++) {
    const c = compiled.staticOpaqueChunks[i]!
    outOpaque.push({
      ...c,
      ...(isFading ? { customCutaway: "fade" as const } : {}),
      streamSlot: slot,
      streamKey,
    })
  }
  if (!rChunks || rChunks.length === 0 || compiled.buildings.length === 0) {
    return { opaque: outOpaque, glass: compiled.glassChunks }
  }
  for (let localId = 0; localId < rChunks.length; localId++) {
    const rc = rChunks[localId]!
    const globalId = globalIds[localId]!
    if (rc.lastGlobalId !== globalId) {
      rc.lastGlobalId = globalId
      const halfId = HALF_INT[globalId]!
      const u16 = new Uint16Array(rc.data)
      const nVerts = rc.data.byteLength / VERT_BYTES
      for (let v = 0; v < nVerts; v++) {
        if (!rc.roofAuxOnly || u16[v * 12 + 10] === HALF_ROOF) u16[v * 12 + 11] = halfId
      }
    }
    outOpaque.push({
      data: rc.data,
      box: rc.box,
      cutBox: rc.cutBox,
      // Skipped whole while inside (keeps fsSolid/HSR for the roof elsewhere); the peek bubble still uses roofCut.
      customCutaway: rc.customCutaway ?? "outside",
      streamSlot: slot,
      streamKey,
    })
  }
  return {
    opaque: outOpaque,
    glass: compiled.glassChunks,
  }
}

/**
 * Whether the hand-authored origin build (level.ts) should draw the origin block instead of the streamed window.
 * The streamed origin chunks are cut from the same build (`compileOriginChunk`), so the swap is invisible; the origin
 * build stays in use near spawn because it draws only the block. Leaving is held off until the camera footprint actually reaches past its edge, and
 * coming back needs the footprint 3 m inside it, so panning along the edge (walking down Ash House's hall on a wide
 * window) does not swap back and forth.
 */
export function useOriginBuild(
  usingOrigin: boolean,
  x: number,
  y: number,
  view: readonly [number, number, number, number],
  zoom: number,
): boolean {
  if (x < 14 || x > 82 || y < 14 || y > 82 || zoom > 50) return false
  const margin = usingOrigin ? 0 : 3
  return view[0] >= margin && view[1] >= margin && view[2] <= SIZE - margin && view[3] <= SIZE - margin
}

type BakeTask = {
  cx: number
  cy: number
  seed: number
  houseSeed: number
  terrain: number
  foliageDensity: number
  mode: WorldMode
  priority: number
}

const CHUNK_FADE_DURATION = 0.28

/**
 * Client-side 5×5 rendered / 3×3 lit chunk window streamer with a 25-slot toroidal GPU vertex buffer,
 * speed-scaled directional lookahead pre-warming, off-thread Web Worker compilation, and smooth late-chunk fade-in.
 */
export class WorldClientStreamer {
  private readonly cache = new Map<string, CompiledWorldChunk>()
  private readonly bakeQueue: BakeTask[] = []
  private readonly inflightKeys = new Set<string>()
  private readonly maxCachedChunks = 48

  private readonly stitchedFloor = new Uint8Array(384 * 384 * 2)
  private readonly stitchedMoon = new Uint8Array(768 * 768)
  private readonly stitchedBounce = new Uint8Array(192 * 192 * 4)
  private readonly stitchedFloorF64 = new Float64Array(this.stitchedFloor.buffer)
  private readonly stitchedMoonF64 = new Float64Array(this.stitchedMoon.buffer)
  private readonly stitchedBounceF64 = new Float64Array(this.stitchedBounce.buffer)

  private workers: Worker[] = []
  private workerBusy: boolean[] = []
  private nextReqId = 1
  private recycleWorkerIdx = 0
  private lastPlayerX = NaN
  private lastPlayerY = NaN
  private dirX = 1
  private dirY = 0
  private outerRingDirty = false
  private fastLookahead = false
  private lastViewRect: readonly [number, number, number, number] | undefined = undefined
  private readonly renderedChunkKeys = new Set<string>()
  private readonly chunkFadeStart = new Map<string, number>()

  center: ChunkCoord = { cx: 1, cy: 1 }
  windowOrigin: [number, number] = [0, 0]
  windowBuildings: Building[] = []
  /** Sconce lists of the chunks in the current window. */
  windowSconces: Float32Array[] = []
  private readonly buildingSlots: (Building | null)[] = [null, null, null, null, null, null, null, null]
  lastWindowKey = ""
  bakeStepsCompleted = 0
  lastBakeMs = 0
  chunkFadeAlpha = 0

  constructor() {
    this.initWorkers()
  }

  private initWorkers(): void {
    if (typeof Worker === "undefined" || typeof window === "undefined") return
    try {
      const count = 2
      for (let i = 0; i < count; i++) {
        const w = new Worker(new URL("./world-worker.ts", import.meta.url), { type: "module" })
        this.workerBusy.push(false)
        w.onmessage = (ev: MessageEvent<{ id: number; cacheKey: string; compiled: CompiledWorldChunk }>) => {
          this.workerBusy[i] = false
          const { cacheKey, compiled } = ev.data
          this.inflightKeys.delete(cacheKey)
          if (!this.cache.has(cacheKey)) {
            this.insertCachedChunk(cacheKey, compiled)
            if (Math.abs(compiled.cx - this.center.cx) <= 2 && Math.abs(compiled.cy - this.center.cy) <= 2) {
              this.outerRingDirty = true
            }
          } else {
            recycleCompiledChunk(compiled)
          }
          this.pumpWorkers()
        }
        w.onerror = () => {
          this.workerBusy[i] = false
        }
        this.workers.push(w)
      }
    } catch {
      this.workers.length = 0
      this.workerBusy.length = 0
    }
  }

  private evictChunk(oldKey: string, oldChunk: CompiledWorldChunk): void {
    this.cache.delete(oldKey)
    if (
      this.workers.length > 0 &&
      oldChunk.floorTile.byteLength === 128 * 128 * 2 &&
      oldChunk.moonTile.byteLength === 256 * 256 &&
      oldChunk.bounceTile.byteLength === 64 * 64 * 4
    ) {
      const fBuf = oldChunk.floorTile.buffer
      const mBuf = oldChunk.moonTile.buffer
      const bBuf = oldChunk.bounceTile.buffer
      const opBuf = oldChunk.staticOpaqueChunks[0]?.data
      const transfer: Transferable[] = [fBuf, mBuf, bBuf]
      if (poolable(opBuf)) transfer.push(opBuf!)
      const targetWorker = this.workers[this.recycleWorkerIdx++ % this.workers.length]!
      targetWorker.postMessage(
        {
          type: "recycle",
          floorBuf: fBuf,
          moonBuf: mBuf,
          bounceBuf: bBuf,
          opaqueBuf: poolable(opBuf),
        },
        transfer,
      )
    } else {
      recycleCompiledChunk(oldChunk)
    }
  }

  private insertCachedChunk(k: string, compiled: CompiledWorldChunk): void {
    if (this.cache.size >= this.maxCachedChunks && !this.cache.has(k)) {
      // Evict oldest chunk that is not inside the active 5×5 rendered window or lookahead corridor
      for (const [oldKey, oldChunk] of this.cache) {
        const dx = oldChunk.cx - this.center.cx
        const dy = oldChunk.cy - this.center.cy
        if (Math.abs(dx) <= 2 && Math.abs(dy) <= 2) continue
        if (dx * this.dirX + dy * this.dirY > 0 && Math.abs(dx) <= 5 && Math.abs(dy) <= 2) continue
        this.evictChunk(oldKey, oldChunk)
        break
      }
      if (this.cache.size >= this.maxCachedChunks) {
        const oldest = this.cache.keys().next().value
        if (oldest !== undefined) {
          const ev = this.cache.get(oldest)!
          this.evictChunk(oldest, ev)
        }
      }
    }
    this.cache.set(k, compiled)
    this.lastBakeMs = compiled.compileMs
    this.bakeStepsCompleted++
  }

  private pumpWorkers(): void {
    if (this.workers.length === 0 || this.bakeQueue.length === 0) return
    for (let i = 0; i < this.workers.length; i++) {
      if (this.workerBusy[i]) continue
      while (this.bakeQueue.length > 0) {
        const item = this.bakeQueue.shift()!
        const k = this.cacheKey(item.seed, item.houseSeed, item.terrain, item.foliageDensity, item.mode, item.cx, item.cy)
        if (this.cache.has(k) || this.inflightKeys.has(k)) continue
        this.inflightKeys.add(k)
        this.workerBusy[i] = true
        this.workers[i]!.postMessage({
          id: this.nextReqId++,
          cacheKey: k,
          seed: item.seed,
          houseSeed: item.houseSeed,
          terrain: item.terrain,
          foliageDensity: item.foliageDensity,
          mode: item.mode,
          cx: item.cx,
          cy: item.cy,
          houseDecay: archSettings.houseDecay,
          weathering: archSettings.weathering,
          clutterDensity: archSettings.clutterDensity,
          clutterSeed: archSettings.clutterSeed,
          interior: { ...interiorSettings },
          props: { ...propDressingState },
          veg: { ...vegetationBuild },
        })
        break
      }
    }
  }

  get cachedChunkCount(): number {
    return this.cache.size
  }

  get pendingBakeCount(): number {
    return this.bakeQueue.length + this.inflightKeys.size
  }

  /** Explicitly triggers a smooth 0.28s fade-in for a chunk key (used when a chunk arrives late inside view). */
  triggerChunkFade(chunkKeyStr: string, nowSec: number): void {
    this.chunkFadeStart.set(chunkKeyStr, nowSec)
    this.outerRingDirty = true
  }

  reset(): void {
    ensurePropTemplates()
    this.bakeQueue.length = 0
    this.center = { cx: 1, cy: 1 }
    this.windowOrigin = [0, 0]
    this.windowBuildings = []
    this.windowSconces = []
    this.buildingSlots.fill(null)
    this.lastWindowKey = ""
    this.lastPlayerX = NaN
    this.lastPlayerY = NaN
    this.dirX = 1
    this.dirY = 0
    this.outerRingDirty = false
    this.fastLookahead = false
    this.renderedChunkKeys.clear()
    this.chunkFadeStart.clear()
    this.chunkFadeAlpha = 0
  }

  private cacheKey(
    seed: number,
    houseSeed: number,
    terrain: number,
    foliageDensity: number,
    mode: WorldMode,
    cx: number,
    cy: number,
  ): string {
    return `${seed}:${houseSeed}:${terrain}:${foliageDensity}:${mode}:${archSettings.houseDecay}:${archSettings.clutterDensity}:${archSettings.weathering}:${archSettings.clutterSeed}:${interiorSignature()}:${propLevelSignature()}:${vegetationSignature()}:${cx},${cy}`
  }

  getOrCompileChunk(
    seed: number,
    houseSeed: number,
    terrain: number,
    foliageDensity: number,
    mode: WorldMode,
    cx: number,
    cy: number,
  ): CompiledWorldChunk {
    const k = this.cacheKey(seed, houseSeed, terrain, foliageDensity, mode, cx, cy)
    const hit = this.cache.get(k)
    if (hit) {
      this.cache.delete(k)
      this.cache.set(k, hit)
      return hit
    }
    const worldChunk = generateWorldChunk(seed, houseSeed, cx, cy, mode)
    const compiled = compileSingleWorldChunk(worldChunk, seed, houseSeed, terrain, foliageDensity, mode)
    this.insertCachedChunk(k, compiled)
    return compiled
  }

  /**
   * Queues uncached chunks across the 5×5 resident window and ahead along the 2D movement direction
   * scaled by speed (4..8 chunks ahead = 128..256 m for walking, sprinting, and vehicles).
   */
  prewarmAround(
    playerX: number,
    playerY: number,
    seed: number,
    houseSeed: number,
    terrain: number,
    foliageDensity: number,
    mode: WorldMode,
    velX = 0,
    velY = 0,
  ): void {
    const vSpeed = Math.hypot(velX, velY)
    let frameDist = 0
    if (Number.isFinite(this.lastPlayerX)) {
      const dx = playerX - this.lastPlayerX
      const dy = playerY - this.lastPlayerY
      const rawDist = Math.hypot(dx, dy)
      if (rawDist < 16) {
        frameDist = rawDist
        if (vSpeed > 0.25) {
          this.dirX = velX / vSpeed
          this.dirY = velY / vSpeed
        } else if (rawDist > 0.05) {
          this.dirX = dx / rawDist
          this.dirY = dy / rawDist
        }
      } else {
        this.dirX = vSpeed > 0.25 ? velX / vSpeed : 1
        this.dirY = vSpeed > 0.25 ? velY / vSpeed : 0
      }
    }
    this.lastPlayerX = playerX
    this.lastPlayerY = playerY

    const speed = Math.max(vSpeed, Math.min(25, frameDist * 60))
    this.fastLookahead = vSpeed > 6.0
    const lookahead = 4 + Math.min(2, Math.ceil(Math.max(0, speed - 3.5) / 6.0))

    const cCx = this.center.cx
    const cCy = this.center.cy

    // Prune stale queue items that are behind the 5×5 window or from an old seed/mode
    for (let i = this.bakeQueue.length - 1; i >= 0; i--) {
      const q = this.bakeQueue[i]!
      const rx = q.cx - cCx
      const ry = q.cy - cCy
      const along = rx * this.dirX + ry * this.dirY
      if (
        (Math.abs(rx) > 2 && Math.abs(ry) > 2 && along < -0.5) ||
        Math.abs(rx) > lookahead + 1 ||
        Math.abs(ry) > lookahead + 1 ||
        q.seed !== seed ||
        q.mode !== mode
      ) {
        this.bakeQueue.splice(i, 1)
      } else {
        q.priority = 99
      }
    }

    let added = false
    const enqueue = (cx: number, cy: number, priority: number) => {
      const k = this.cacheKey(seed, houseSeed, terrain, foliageDensity, mode, cx, cy)
      const hit = this.cache.get(k)
      if (hit) {
        this.cache.delete(k)
        this.cache.set(k, hit)
        return
      }
      if (this.inflightKeys.has(k)) return
      const existing = this.bakeQueue.find((q) => q.cx === cx && q.cy === cy && q.seed === seed && q.mode === mode)
      if (existing) {
        if (priority < existing.priority) {
          existing.priority = priority
          added = true
        }
        return
      }
      this.bakeQueue.push({ cx, cy, seed, houseSeed, terrain, foliageDensity, mode, priority })
      added = true
    }

    // 1. Immediate 3×3 lighting/simulation ring (priority 0..4)
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const align = dx * this.dirX + dy * this.dirY
        enqueue(cCx + dx, cCy + dy, Math.max(0, 2 - align))
      }
    }

    // 2. Speed-scaled 2D directional lookahead corridor (steps 2..lookahead along dir, priority >= 8 so background Workers compile off-thread)
    const perpX = -this.dirY
    const perpY = this.dirX
    const wideFrustum = this.lastViewRect ? this.lastViewRect[2] - this.lastViewRect[0] > 56 : false
    const latRadius = wideFrustum ? 2 : 1
    for (let step = 2; step <= lookahead; step++) {
      for (let lat = -latRadius; lat <= latRadius; lat++) {
        const dx = Math.round(this.dirX * step + perpX * lat)
        const dy = Math.round(this.dirY * step + perpY * lat)
        const priority = 8 + (step - 2) * 4 + Math.abs(lat)
        enqueue(cCx + dx, cCy + dy, priority)
      }
    }

    // 3. Outer-ring chunks the camera can see (or nearly can): the corridor only looks along the walk, so a chunk off
    // to the side or behind stayed unbuilt (a hard black edge on screen) until the survivor walked toward it. When
    // zoomed out (5×5 frustum), pre-warm the whole outer ring.
    const vr = this.lastViewRect
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) continue
        const cx = cCx + dx
        const cy = cCy + dy
        const seen =
          wideFrustum ||
          (vr !== undefined && (cx + 1) * CHUNK >= vr[0] - 12 && cx * CHUNK <= vr[2] + 12 && (cy + 1) * CHUNK >= vr[1] - 12 && cy * CHUNK <= vr[3] + 12)
        if (seen) enqueue(cx, cy, 9 + Math.abs(dx) + Math.abs(dy))
      }
    }

    if (added && this.bakeQueue.length > 1) {
      this.bakeQueue.sort((a, b) => a.priority - b.priority)
    }
    this.pumpWorkers()
  }

  /** Time-sliced incremental bake: compiles at most `maxChunks` queued chunks within `budgetMs`. */
  stepBakeQueue(budgetMs = 2.0, maxChunks = 1): number {
    this.pumpWorkers()
    if (this.bakeQueue.length === 0) return 0
    // When background Web Workers are active, only fall back to main-thread compilation for urgent immediate-ring chunks
    // (expanded to priority <= 10 at vehicle speeds so the next 3×3 window's leading edge is always ready before transition).
    const urgentOnly = this.workers.length > 0
    const maxUrgentPriority = this.fastLookahead ? 10 : 6
    const start = performance.now()
    let compiledCount = 0
    while (this.bakeQueue.length > 0 && performance.now() - start < budgetMs && compiledCount < maxChunks) {
      if (urgentOnly && this.bakeQueue[0]!.priority > maxUrgentPriority) break
      const item = this.bakeQueue.shift()!
      const k = this.cacheKey(item.seed, item.houseSeed, item.terrain, item.foliageDensity, item.mode, item.cx, item.cy)
      if (this.cache.has(k) || this.inflightKeys.has(k)) continue
      this.getOrCompileChunk(item.seed, item.houseSeed, item.terrain, item.foliageDensity, item.mode, item.cx, item.cy)
      compiledCount++
    }
    this.pumpWorkers()
    return compiledCount
  }

  /**
   * Computes the chunk radius `(rx, ry)` required to cover the camera's visible ground footprint (`viewRect`)
   * across the 4 m center-chunk hysteresis range plus an off-screen safety margin.
   */
  static computeRenderRadius(viewRect?: readonly [number, number, number, number]): { rx: number; ry: number } {
    const halfW = viewRect ? (viewRect[2] - viewRect[0]) * 0.5 : 36
    const halfH = viewRect ? (viewRect[3] - viewRect[1]) * 0.5 : 22
    const rx = Math.max(2, Math.min(2, Math.ceil((20 + halfW + 12 - 16) / CHUNK)))
    const ry = Math.max(2, Math.min(2, Math.ceil((20 + halfH + 12 - 16) / CHUNK)))
    return { rx, ry }
  }

  /**
   * Updates the 5×5 resident render window (computed from camera frustum vs 32 m chunks) and 3×3 stitched lighting
   * textures centered on `(playerX, playerY)`.
   */
  updateWindow(
    playerX: number,
    playerY: number,
    town: Town,
    mode: WorldMode,
    viewRect?: readonly [number, number, number, number],
    velX = 0,
    velY = 0,
    timeSec = 0,
  ): { changed: boolean; geometryOnly?: boolean; level?: LevelData; origin: [number, number]; buildings: Building[] } {
    const foliageDensity = town.foliageDensity ?? 1
    const prevCenter = this.center
    this.center = selectActiveWindowCenter(playerX, playerY, this.center)
    const isTeleport = Math.abs(this.center.cx - prevCenter.cx) > 1 || Math.abs(this.center.cy - prevCenter.cy) > 1
    if (isTeleport) {
      this.renderedChunkKeys.clear()
      this.chunkFadeStart.clear()
      this.chunkFadeAlpha = 0
    }
    const originX = (this.center.cx - 1) * CHUNK
    const originZ = (this.center.cy - 1) * CHUNK
    this.windowOrigin = [originX, originZ]
    this.lastViewRect = viewRect

    this.prewarmAround(playerX, playerY, town.seed, town.houseSeed, town.terrain, foliageDensity, mode, velX, velY)

    // Advance any active late-chunk fades
    let maxFadeProgress = 0
    for (const [fKey, startSec] of this.chunkFadeStart) {
      const elapsed = Math.max(0, timeSec - startSec)
      if (elapsed >= CHUNK_FADE_DURATION) {
        this.chunkFadeStart.delete(fKey)
        this.outerRingDirty = true
      } else {
        const alpha = Math.max(0.03, elapsed / CHUNK_FADE_DURATION)
        if (alpha > maxFadeProgress) maxFadeProgress = alpha
      }
    }
    this.chunkFadeAlpha = maxFadeProgress

    const { rx, ry } = WorldClientStreamer.computeRenderRadius(viewRect)
    const winKey = `${town.seed}:${town.houseSeed}:${town.terrain}:${foliageDensity}:${mode}:${archSettings.houseDecay}:${archSettings.clutterDensity}:${archSettings.weathering}:${archSettings.clutterSeed}:${interiorSignature()}:${propLevelSignature()}:${vegetationSignature()}:${this.center.cx},${this.center.cy}:${rx},${ry}`
    const centerMoved = winKey !== this.lastWindowKey

    if (!centerMoved && !this.outerRingDirty) {
      // Non-transition frame: pre-warm up to 1 lookahead chunk on main thread if not already handled by Workers
      this.stepBakeQueue(1.8, 1)
      return { changed: false, origin: this.windowOrigin, buildings: this.windowBuildings }
    }
    const geometryOnly = !centerMoved && this.outerRingDirty
    this.lastWindowKey = winKey
    this.outerRingDirty = false

    const hadRenderedBefore = this.renderedChunkKeys.size > 0
    const isStepTransition = centerMoved && !isTeleport && hadRenderedBefore
    let nextOuterRingDirty = false
    const innerGridChunks: CompiledWorldChunk[] = []
    const allRenderedChunks: CompiledWorldChunk[] = []
    const candidateBlds: Building[] = []

    for (let dy = -ry; dy <= ry; dy++) {
      for (let dx = -rx; dx <= rx; dx++) {
        const cx = this.center.cx + dx
        const cy = this.center.cy + dy
        const isInner = Math.abs(dx) <= 1 && Math.abs(dy) <= 1
        let c: CompiledWorldChunk | undefined
        if (isInner) {
          c = this.getOrCompileChunk(town.seed, town.houseSeed, town.terrain, foliageDensity, mode, cx, cy)
          innerGridChunks.push(c)
        } else {
          const k = this.cacheKey(town.seed, town.houseSeed, town.terrain, foliageDensity, mode, cx, cy)
          const chunkKeyStr = `${cx},${cy}`
          if (this.workers.length === 0) {
            if (viewRect) {
              const [vx0, vz0, vx1, vz1] = viewRect
              const cx0 = cx * CHUNK, cz0 = cy * CHUNK, cx1 = cx0 + CHUNK, cz1 = cz0 + CHUNK
              if (cx1 >= vx0 - 14 && cx0 <= vx1 + 14 && cz1 >= vz0 - 14 && cz0 <= vz1 + 14) {
                c = this.getOrCompileChunk(town.seed, town.houseSeed, town.terrain, foliageDensity, mode, cx, cy)
              } else {
                c = this.cache.get(k)
              }
            } else {
              c = this.cache.get(k)
            }
          } else if (isTeleport) {
            c = this.cache.get(k)
            if (!c && viewRect) {
              const [vx0, vz0, vx1, vz1] = viewRect
              const cx0 = cx * CHUNK, cz0 = cy * CHUNK, cx1 = cx0 + CHUNK, cz1 = cz0 + CHUNK
              if (cx1 >= vx0 - 2 && cx0 <= vx1 + 2 && cz1 >= vz0 - 2 && cz0 <= vz1 + 2) {
                c = this.getOrCompileChunk(town.seed, town.houseSeed, town.terrain, foliageDensity, mode, cx, cy)
              }
            }
          } else if (isStepTransition && !this.renderedChunkKeys.has(chunkKeyStr)) {
            if (viewRect) {
              const [vx0, vz0, vx1, vz1] = viewRect
              const cx0 = cx * CHUNK, cz0 = cy * CHUNK, cx1 = cx0 + CHUNK, cz1 = cz0 + CHUNK
              if (cx1 >= vx0 - 2 && cx0 <= vx1 + 2 && cz1 >= vz0 - 2 && cz0 <= vz1 + 2) {
                c = this.cache.get(k)
              } else if (this.cache.has(k)) {
                nextOuterRingDirty = true
              }
            } else if (this.cache.has(k)) {
              nextOuterRingDirty = true
            }
          } else {
            c = this.cache.get(k)
          }
        }
        if (!c) continue
        allRenderedChunks.push(c)
        // If a chunk arrives late while its bounds are already well inside the visible ground frustum, fade it in smoothly
        if (!isTeleport && hadRenderedBefore && !this.renderedChunkKeys.has(c.key) && viewRect && timeSec > 0) {
          const [vx0, vz0, vx1, vz1] = viewRect
          const cx0 = cx * CHUNK, cz0 = cy * CHUNK, cx1 = cx0 + CHUNK, cz1 = cz0 + CHUNK
          if (cx1 > vx0 + 6 && cx0 < vx1 - 6 && cz1 > vz0 + 6 && cz0 < vz1 - 6) {
            this.chunkFadeStart.set(c.key, timeSec)
            if (this.chunkFadeAlpha <= 0) this.chunkFadeAlpha = 0.03
          }
        }
        for (let i = 0; i < c.buildings.length; i++) {
          candidateBlds.push(c.buildings[i]!)
        }
      }
    }
    if (nextOuterRingDirty) this.outerRingDirty = true

    this.renderedChunkKeys.clear()
    this.windowSconces = []
    for (let i = 0; i < allRenderedChunks.length; i++) {
      this.renderedChunkKeys.add(allRenderedChunks[i]!.key)
      if (allRenderedChunks[i]!.sconces?.length) this.windowSconces.push(allRenderedChunks[i]!.sconces)
    }

    // Select the 8 buildings closest to (playerX, playerY) so the building the survivor is inside (dist = 0)
    // and its immediate neighbours are always resident in OL.bldRects[0..7]
    candidateBlds.sort((a, b) => distToRect(playerX, playerY, a.rect) - distToRect(playerX, playerY, b.rect))
    const activeBlds = candidateBlds.slice(0, 8)

    // Evict buildings that left the closest-8 set
    for (let s = 0; s < 8; s++) {
      const cur = this.buildingSlots[s]
      if (cur && !activeBlds.some((b) => b.id === cur.id)) {
        this.buildingSlots[s] = null
      }
    }
    // Place newly entered buildings into free slots so surviving buildings keep their exact globalId
    for (let i = 0; i < activeBlds.length; i++) {
      const b = activeBlds[i]!
      const existingSlot = this.buildingSlots.findIndex((s) => s?.id === b.id)
      if (existingSlot >= 0) {
        this.buildingSlots[existingSlot] = b
      } else {
        const freeSlot = this.buildingSlots.indexOf(null)
        if (freeSlot >= 0) this.buildingSlots[freeSlot] = b
      }
    }
    const emptyBld: Building = { id: "", kind: "house", rect: [-99999, -99999, -99998, -99998], color: 0 }
    this.windowBuildings = this.buildingSlots.map((b) => b ?? emptyBld)
    const windowBuildings = this.windowBuildings

    const allOpaque: LevelChunk[] = []
    const allGlass: LevelChunk[] = []
    for (let i = 0; i < allRenderedChunks.length; i++) {
      const c = allRenderedChunks[i]!
      const isFading = this.chunkFadeStart.has(c.key)
      const packed = packChunkMeshesForWindow(c, windowBuildings, isFading)
      for (let j = 0; j < packed.opaque.length; j++) allOpaque.push(packed.opaque[j]!)
      for (let j = 0; j < packed.glass.length; j++) allGlass.push(packed.glass[j]!)
    }

    if (!geometryOnly) {
      const dstFloorF64 = this.stitchedFloorF64
      const dstMoonF64 = this.stitchedMoonF64
      const dstBounceF64 = this.stitchedBounceF64

      for (let gy = 0; gy < 3; gy++) {
        for (let gx = 0; gx < 3; gx++) {
          const c = innerGridChunks[gy * 3 + gx]!
          // Zero-allocation 64-bit row blits (32 Float64s = 256 bytes per row for floorTile, moonTile, and bounceTile)
          const srcFloorF64 = new Float64Array(c.floorTile.buffer, c.floorTile.byteOffset, 128 * 32)
          for (let row = 0; row < 128; row++) {
            const dstOff = (gy * 128 + row) * 96 + gx * 32
            const srcOff = row * 32
            for (let k = 0; k < 32; k++) dstFloorF64[dstOff + k] = srcFloorF64[srcOff + k]!
          }

          const srcMoonF64 = new Float64Array(c.moonTile.buffer, c.moonTile.byteOffset, 256 * 32)
          for (let row = 0; row < 256; row++) {
            const dstOff = (gy * 256 + row) * 96 + gx * 32
            const srcOff = row * 32
            for (let k = 0; k < 32; k++) dstMoonF64[dstOff + k] = srcMoonF64[srcOff + k]!
          }

          const srcBounceF64 = new Float64Array(c.bounceTile.buffer, c.bounceTile.byteOffset, 64 * 32)
          for (let row = 0; row < 64; row++) {
            const dstOff = (gy * 64 + row) * 96 + gx * 32
            const srcOff = row * 32
            for (let k = 0; k < 32; k++) dstBounceF64[dstOff + k] = srcBounceF64[srcOff + k]!
          }
        }
      }
    }

    const level: LevelData = {
      chunks: allOpaque,
      glass: allGlass,
      floor: {
        data: this.stitchedFloor,
        w: 384,
        h: 384,
        moon: { data: this.stitchedMoon, w: 768, h: 768 },
      },
      bounce: {
        data: this.stitchedBounce,
        w: 192,
        h: 192,
      },
      geometryOnly,
    }

    return { changed: true, geometryOnly, level, origin: this.windowOrigin, buildings: this.windowBuildings }
  }
}
