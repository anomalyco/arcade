import type { LevelChunk, LevelData } from "@arcade/kit/gpu/level"
import { emitGrassClump, emitGrassTuft, foliageSettings, scatterGrassClumps } from "@arcade/kit/gpu/foliage"
import { MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import { distToRect, type Rect } from "@arcade/kit/sim/geom"
import { Rng } from "@arcade/kit/sim/rng"
import {
  buildingFootprint,
  CHUNK,
  frontageEnd,
  inBuildingFootprint,
  propShape,
  SIZE,
  type Building,
  type Prop,
  type Town,
} from "../shared/map"
import { supportHeight, terrainVertex } from "../shared/terrain"
import {
  chunkKey,
  generateWorldChunk,
  macroLocalCoord,
  selectActiveWindowCenter,
  type ChunkCoord,
  type WorldChunk,
  type WorldMode,
} from "../shared/world"
import { archSettings, house, plant, plantFootprints } from "./architecture"
import { DEFAULT_OUTBREAK_LIGHTING, resolveLampLight, stampOutbreakVertexTone } from "./lighting"

const hex = (v: number): Rgb => [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]

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

export type CompiledWorldChunk = {
  key: string
  cx: number
  cy: number
  hash: number
  staticOpaqueChunks: LevelChunk[]
  glassChunks: LevelChunk[]
  roofMeshes: Mesh[]
  buildings: Building[]
  floorTile: Uint8Array // 128 × 128 × 2 (RG8)
  moonTile: Uint8Array // 256 × 256 (R8)
  bounceTile: Uint8Array // 64 × 64 × 4 (RGBA8)
  compileMs: number
}

/**
 * Emits distinctive 3D architectural silhouettes and roofs (`MAT.roof` with `aux = buildingId`)
 * for procedural POI and building archetypes (`ranch`, `cottage`, `cabin`, `grocery`, `diner`,
 * `gas_station`, `police`, `clinic`, `church`, `warehouse`).
 */
export function emitPoiArchitecture(m: Mesh, b: Building, id: number, town: Town): void {
  const arch = b.archetype ?? b.kind
  if (b.kind === "house" && arch === "house") {
    house(m, b, id, town)
    return
  }

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

  if (arch === "ranch" || arch === "cottage" || arch === "cabin" || arch === "church") {
    // Pitched shingle gable roof (all tagged MAT.roof, aux = id so it cuts away cleanly when inside)
    const ridge = arch === "church" ? 5.15 : arch === "cabin" ? 3.85 : 4.15
    const roofCol = hex(arch === "church" ? 0x3e4248 : arch === "cabin" ? 0x3c3228 : 0x4e4b46)
    const eaveCol = hex(0x58534a)
    m.quadAuto([x - 0.35, 2.82, e + 0.35], [r + 0.35, 2.82, e + 0.35], [r + 0.35, ridge, midZ], [x - 0.35, ridge, midZ], roofCol, MAT.roof, id)
    m.quadAuto([r + 0.35, 2.82, z - 0.35], [x - 0.35, 2.82, z - 0.35], [x - 0.35, ridge, midZ], [r + 0.35, ridge, midZ], roofCol, MAT.roof, id)
    m.facet([x - 0.01, 2.8, z], [x - 0.01, ridge, midZ], [x - 0.01, 2.8, e], hex(b.color), MAT.roof, id)
    m.facet([r + 0.01, 2.8, e], [r + 0.01, ridge, midZ], [r + 0.01, 2.8, z], hex(b.color), MAT.roof, id)
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
): CompiledWorldChunk {
  const t0 = performance.now()
  plantFootprints.length = 0
  const m = new Mesh()
  const g = new Mesh()
  const propMeshes: Mesh[] = []

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

  // 1. Terrain cells (1×1 m) in this 32×32 m chunk
  for (let z = z0; z < z1; z++) {
    const lz = macroLocalCoord(z)
    for (let x = x0; x < x1; x++) {
      const lx = macroLocalCoord(x)
      if (
        (lx >= 40 && lx < 48) ||
        (lz >= 40 && lz < 48) ||
        footprints.some((fp) => fp.some((f) => x >= f[0] && x + 1 <= f[2] && z >= f[1] && z + 1 <= f[3]))
      )
        continue
      const a = [x, terrainVertex(chunkTown, x, z), z]
      const b = [x + 1, terrainVertex(chunkTown, x + 1, z), z]
      const c = [x + 1, terrainVertex(chunkTown, x + 1, z + 1), z + 1]
      const d = [x, terrainVertex(chunkTown, x, z + 1), z + 1]
      m.facet(a, c, b, hex(0x586044), MAT.ground, 0)
      m.facet(a, d, c, hex(0x586044), MAT.ground, 0)
    }
  }

  // 2. Arterial streets, curbs & sidewalks in this chunk (aligned to macro-block lx=1 / ly=1)
  if (chunk.lx === 1) {
    const roadX0 = x0 + 8
    const roadX1 = x0 + 16
    floor(m, roadX0, z0, roadX1, z1, 0.014, 0x545658, 5)
    for (let z = z0; z < z1; z++) {
      const lz = macroLocalCoord(z)
      if (lz >= 38 && lz < 50) continue
      for (const s of [6, 16] as const) {
        const a = x0 + (s === 6 ? 6 : 16.25)
        const b = x0 + (s === 6 ? 7.75 : 18)
        floor(m, a, z, b, z + 1, 0.1, 0x78746a, 6)
        const edge = x0 + (s === 6 ? 8 : 16)
        const inner = x0 + (s === 6 ? 7.75 : 16.25)
        m.quadAuto([edge, 0.014, z], [edge, 0.014, z + 1], [inner, 0.1, z + 1], [inner, 0.1, z], hex(0x7c786e), MAT.ground, 2)
      }
    }
  }
  if (chunk.ly === 1) {
    const roadZ0 = z0 + 8
    const roadZ1 = z0 + 16
    if (chunk.lx !== 1) {
      floor(m, x0, roadZ0, x1, roadZ1, 0.014, 0x545658, 5)
    } else {
      floor(m, x0, roadZ0, x0 + 8, roadZ1, 0.014, 0x545658, 5)
      floor(m, x0 + 16, roadZ0, x1, roadZ1, 0.014, 0x545658, 5)
    }
    for (let x = x0; x < x1; x++) {
      const lx = macroLocalCoord(x)
      if (lx >= 38 && lx < 50) continue
      for (const s of [6, 16] as const) {
        const a = z0 + (s === 6 ? 6 : 16.25)
        const b = z0 + (s === 6 ? 7.75 : 18)
        floor(m, x, a, x + 1, b, 0.1, 0x78746a, 6)
        const edge = z0 + (s === 6 ? 8 : 16)
        const inner = z0 + (s === 6 ? 7.75 : 16.25)
        m.quadAuto([x, 0.014, edge], [x + 1, 0.014, edge], [x + 1, 0.1, inner], [x, 0.1, inner], hex(0x7c786e), MAT.ground, 2)
      }
    }
  }

  // 3. Grass tufts scattered across chunk lawn
  const grassRng = new Rng((seed ^ Math.imul(chunk.cx * 73 + chunk.cy * 151, 0x73c9)) >>> 0)
  const tufts = scatterGrassClumps({
    seed: (seed ^ Math.imul(chunk.cx * 41 + chunk.cy * 97, 0x453a)) >>> 0,
    bounds: [x0 + 1.0, z0 + 1.0, x1 - 1.0, z1 - 1.0],
    clusterCount: Math.max(3, Math.round(9 * foliageDensity)),
    tuftsPerCluster: 3,
    params: foliageSettings,
    avoid: (gx, gz) => {
      const lx = macroLocalCoord(gx)
      const lz = macroLocalCoord(gz)
      if ((lx > 38 && lx < 50) || (lz > 38 && lz < 50)) return true
      return chunk.buildings.some((b) => gx >= b.rect[0] - 2.5 && gx <= b.rect[2] + 0.5 && gz >= b.rect[1] - 0.5 && gz <= b.rect[3] + 2.5)
    },
  })
  for (const t of tufts) {
    const y = supportHeight(chunkTown, t.x, t.z)
    if (t.weed) {
      emitGrassClump(m, t, y, grassRng)
      continue
    }
    emitGrassTuft(m, t.x, y, t.z, {
      bladeCount: 2,
      radius: t.radius * 1.1,
      height: t.height,
      width: t.width,
      curvature: t.curvature,
      leanAngle: t.leanAngle,
      rootColor: t.rootColor,
      tipColor: t.tipColor,
      rng: grassRng,
    })
  }

  // 4. Buildings, floors, walkways & POI architecture
  for (const [id, b] of chunk.buildings.entries()) {
    const [bx, bz, br, bend] = b.rect
    for (const [fx0, fz0, fx1, fz1] of buildingFootprint(b)) {
      floor(m, fx0, fz0, fx1, fz1, 0.13, b.kind === "house" ? 0x5d442c : 0x89968b, b.kind === "house" ? 2 : 1)
    }
    floor(m, bx + 4.5, bend, Math.min(br - 0.5, bx + 7), bend + 1.3, 0.13, 0x6a6254, 6)
    floor(m, bx + 5, bend + 1.3, Math.min(br - 0.5, bx + 6.4), frontageEnd(b) + 2, 0.13, 0x6e6658, 6)
    floor(m, bx - 3, bz, bx - 0.35, frontageEnd(b) + 2, 0.035, 0x66625a, 7)
    emitPoiArchitecture(m, b, id, chunkTown)
  }

  // 5. Walls, windows & fences
  for (const b of chunk.barriers) {
    const [x, z, r, end] = b.rect
    const color = hex(b.color)
    if (b.kind === "wall") {
      m.box(x, 0.13, z, r, 2.78, end, color, MAT.wall, 20, hex(0x4a4338))
      m.box(x + 0.03, 2.78, z + 0.03, r - 0.03, 2.8, end - 0.03, hex(0x28231d), MAT.lit)
      m.box(x - 0.02, 0.14, z - 0.02, r + 0.02, 0.26, end + 0.02, hex(0x3a2a1c), MAT.timber)
    } else if (b.kind === "window") {
      m.box(x, 0.13, z, r, 0.84, end, color, MAT.wall, 20)
      m.box(x, 2.16, z, r, 2.78, end, color, MAT.wall, 20, hex(0x4a4338))
      m.box(x + 0.03, 2.78, z + 0.03, r - 0.03, 2.8, end - 0.03, hex(0x28231d), MAT.lit)
      if (r - x > 1) {
        const zm = (z + end) * 0.5
        m.box(x - 0.06, 0.79, z - 0.06, r + 0.06, 0.86, end + 0.1, hex(0x787060), MAT.wall)
        m.box(x - 0.06, 2.14, z - 0.05, r + 0.06, 2.22, end + 0.08, hex(0x787060), MAT.wall)
        g.box(x + 0.06, 0.86, zm - 0.01, r - 0.06, 2.14, zm + 0.01, hex(0x463626), MAT.glass)
      } else {
        const xm = (x + r) * 0.5
        m.box(x - 0.06, 0.79, z - 0.06, r + 0.1, 0.86, end + 0.06, hex(0x787060), MAT.wall)
        m.box(x - 0.05, 2.14, z - 0.06, r + 0.08, 2.22, end + 0.06, hex(0x787060), MAT.wall)
        g.box(xm - 0.01, 0.86, z + 0.06, xm + 0.01, 2.14, end - 0.06, hex(0x6e888c), MAT.glass)
      }
    } else {
      // Fence
      const horizontal = r - x > end - z
      const length = horizontal ? r - x : end - z
      const fenceRng = new Rng((houseSeed ^ Math.floor(x * 31 + z * 59)) >>> 0)
      const railCol = hex(0x6e685a)
      let pIdx = 0
      for (let d = 0; d < length; d += 0.34, pIdx++) {
        const px = x + (horizontal ? d : 0)
        const pz = z + (horizontal ? 0 : d)
        if (pIdx % 7 === 0) {
          m.box(px - 0.02, 0.03, pz - 0.02, px + 0.12, 1.22, pz + 0.12, hex(0x645e50), MAT.timber)
          continue
        }
        const pCol = hex(fenceRng.pick([0x8a8272, 0x7c7566, 0x948c7b, 0x70695b]))
        const w = horizontal ? 0.14 : 0.07
        const dp = horizontal ? 0.07 : 0.14
        m.box(px, 0.04, pz, px + w, 1.08, pz + dp, pCol, MAT.timber)
      }
      for (const h of [0.3, 0.84]) m.box(x, h, z, r, h + 0.065, end, railCol, MAT.timber)
    }
  }

  // 6. Props & trees
  for (const p of chunk.props) {
    const pm = new Mesh()
    emitPropFurniture(pm, p, chunkTown)
    propMeshes.push(pm)
  }

  // 7. Lamp fixtures
  for (const [id, p] of chunk.lamps.entries()) {
    if (p.kind === "window") continue
    if (p.kind === "street") {
      m.prism(p.x, p.y, 0.13, 0.07, 0.1, 3.8, 8, hex(0x353d3c))
      m.box(p.x - 0.08, 3.65, p.y - 0.08, p.x + 0.7, 3.8, p.y + 0.08, hex(0x353d3c))
      m.box(p.x + 0.3, 3.55, p.y - 0.18, p.x + 0.8, 3.65, p.y + 0.18, hex(0xffc980), MAT.lamp, id)
    } else if (p.kind === "porch") {
      m.prism(p.x, p.y - 0.22, 0.1, 0.08, 2.24, 2.38, 7, hex(0xffe0a6), MAT.lamp, id)
    } else if (p.kind === "room" && p.h <= 2.3) {
      m.prism(p.x, p.y, 0.23, 0.125, p.h - 0.13, p.h + 0.16, 9, hex(0xe8b86b), MAT.lamp, id)
    }
  }

  // 8. Bake per-chunk 128×128 floor contact AO & indoor sky mask tile (0.25 m/texel)
  const fRes = 128
  const fScale = CHUNK / fRes // 0.25 m
  const floorTile = new Uint8Array(fRes * fRes * 2)
  for (let i = 1; i < floorTile.length; i += 2) floorTile[i] = 255
  for (const fp of footprints) {
    for (const [fx0, fz0, fx1, fz1] of fp) {
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
  for (const wall of chunk.barriers) if (wall.kind !== "fence") stampFloorRect(wall.rect, 4, 0.8, 1.6)
  for (const p of chunk.props) {
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

  // 9. Bake per-chunk 256×256 directional moon & tree-canopy mask tile (0.125 m/texel)
  const mRes = 256
  const mScale = CHUNK / mRes // 0.125 m
  const moonTile = new Uint8Array(mRes * mRes).fill(255)
  for (const b of chunk.buildings) {
    const [bx0, bz0, bx1, bz1] = b.rect
    const tx0 = Math.max(0, Math.floor((bx0 - 1.5 - x0) / mScale))
    const tx1 = Math.min(mRes - 1, Math.ceil((bx1 + 4.5 - x0) / mScale))
    const tz0 = Math.max(0, Math.floor((bz0 - 1.5 - z0) / mScale))
    const tz1 = Math.min(mRes - 1, Math.ceil((bz1 + 3.5 - z0) / mScale))
    for (let tz = tz0; tz <= tz1; tz++) {
      const pz = z0 + (tz + 0.5) * mScale
      for (let tx = tx0; tx <= tx1; tx++) {
        const px = x0 + (tx + 0.5) * mScale
        const idx = tz * mRes + tx
        if (inBuildingFootprint(b, px, pz)) {
          moonTile[idx] = 14
        } else if (inBuildingFootprint(b, px - 1.15, pz - 0.85)) {
          moonTile[idx] = Math.min(moonTile[idx]!, 158)
        }
      }
    }
  }
  for (const t of chunk.props) {
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
      for (let tx = tx0; tx <= tx1; tx++) {
        const idx = tz * mRes + tx
        if (moonTile[idx]! <= 25) continue
        const dx = x0 + (tx + 0.5) * mScale - cxT
        const u2 = (dx * dx + dz * dz) * invR2
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
  const bounceTile = new Uint8Array(bRes * bRes * 4)
  for (let i = 0; i < bRes * bRes; i++) bounceTile[i * 4 + 3] = 255
  for (const lamp of chunk.lamps) {
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

  const glassChunks = packSimple(g)
  const staticOpaqueChunks: LevelChunk[] = []
  for (const pm of propMeshes) {
    staticOpaqueChunks.push(...packSimple(pm))
  }

  const roofMeshes = chunk.buildings.map(() => new Mesh())
  if (m.count) {
    const opaque = new Mesh()
    const screen = new Mesh()
    for (let i = 0; i < m.v.length; i += 33) {
      let maxY = -Infinity
      let hasRoof = false
      let hasScreen = false
      for (const j of [0, 11, 22]) {
        const vy = m.v[i + j + 1]!
        const mat = Math.round(m.v[i + j + 9]!)
        maxY = Math.max(maxY, vy)
        if (mat === 21) hasRoof = true
        if ((mat === 4 || mat === 9 || mat === 11) && maxY > 1.0) hasScreen = true
      }
      if (hasRoof && chunk.buildings.length > 0) {
        const localId = Math.max(0, Math.min(chunk.buildings.length - 1, Math.round(m.v[i + 10]!)))
        const dst = roofMeshes[localId]!.v
        for (let k = i; k < i + 33; k++) dst.push(m.v[k]!)
      } else {
        const dst = hasScreen ? screen.v : opaque.v
        for (let k = i; k < i + 33; k++) dst.push(m.v[k]!)
      }
    }
    staticOpaqueChunks.push(...packSimple(opaque))
    if (screen.count) {
      const bands = new Map<number, Mesh>()
      for (let i = 0; i < screen.v.length; i += 33) {
        const xBand = Math.floor(Math.min(screen.v[i]!, screen.v[i + 11]!, screen.v[i + 22]!) / 4)
        const zBand = Math.floor(Math.min(screen.v[i + 2]!, screen.v[i + 13]!, screen.v[i + 24]!) / 4)
        const key = xBand * 1024 + zBand
        let bm = bands.get(key)
        if (!bm) {
          bm = new Mesh()
          bands.set(key, bm)
        }
        for (let k = i; k < i + 33; k++) bm.v.push(screen.v[k]!)
      }
      for (const bm of bands.values()) {
        for (const c of packSimple(bm)) {
          staticOpaqueChunks.push({ ...c, cutBox: [c.box[0], 0, c.box[1], c.box[2], 2.85, c.box[3]] })
        }
      }
    }
  }

  return {
    key: chunk.key,
    cx: chunk.cx,
    cy: chunk.cy,
    hash: chunk.hash,
    staticOpaqueChunks,
    glassChunks,
    roofMeshes,
    buildings: chunk.buildings,
    floorTile,
    moonTile,
    bounceTile,
    compileMs: performance.now() - t0,
  }
}

/**
 * Returns a compiled chunk's pre-packed static & glass chunks plus roof chunks tagged with the window-wide `buildingId`.
 */
function packChunkMeshesForWindow(
  compiled: CompiledWorldChunk,
  windowBuildings: readonly Building[],
): { opaque: LevelChunk[]; glass: LevelChunk[] } {
  if (compiled.buildings.length === 0) {
    return { opaque: compiled.staticOpaqueChunks, glass: compiled.glassChunks }
  }
  const bldIndexOffset = Math.max(
    0,
    windowBuildings.findIndex((b) => b.id === compiled.buildings[0]?.id),
  )
  const roofChunks: LevelChunk[] = []
  compiled.buildings.forEach((b, localId) => {
    const rm = compiled.roofMeshes[localId]!
    if (!rm.count) return
    const globalId = bldIndexOffset + localId
    const copy = new Mesh()
    for (let i = 0; i < rm.v.length; i += 11) {
      for (let k = 0; k < 10; k++) copy.v.push(rm.v[i + k]!)
      copy.v.push(globalId)
    }
    const bounds = [b.rect[0] - 0.1, 0, b.rect[1] - 0.1, b.rect[2] + 0.1, 6.5, b.rect[3] + 1.7] as const
    roofChunks.push({
      data: stampOutbreakVertexTone(copy.pack()),
      box: [b.rect[0] - 0.5, b.rect[1] - 0.5, b.rect[2] + 0.5, b.rect[3] + 1.7] as const,
      cutBox: bounds,
      customCutaway: true,
    })
  })
  return {
    opaque: [...compiled.staticOpaqueChunks, ...roofChunks],
    glass: compiled.glassChunks,
  }
}

/**
 * Client-side 3×3 chunk window streamer with an LRU cache of compiled chunk tiles
 * and a time-sliced pre-warm queue so chunk transitions never cause frame hitches.
 */
export class WorldClientStreamer {
  private readonly cache = new Map<string, CompiledWorldChunk>()
  private readonly bakeQueue: { cx: number; cy: number; seed: number; houseSeed: number; terrain: number; foliageDensity: number; mode: WorldMode }[] = []
  private readonly maxCachedChunks = 45

  private readonly stitchedFloor = new Uint8Array(384 * 384 * 2)
  private readonly stitchedMoon = new Uint8Array(768 * 768)
  private readonly stitchedBounce = new Uint8Array(192 * 192 * 4)

  center: ChunkCoord = { cx: 1, cy: 1 }
  windowOrigin: [number, number] = [0, 0]
  windowBuildings: Building[] = []
  lastWindowKey = ""
  bakeStepsCompleted = 0
  lastBakeMs = 0

  get cachedChunkCount(): number {
    return this.cache.size
  }

  get pendingBakeCount(): number {
    return this.bakeQueue.length
  }

  reset(): void {
    this.bakeQueue.length = 0
    this.center = { cx: 1, cy: 1 }
    this.windowOrigin = [0, 0]
    this.windowBuildings = []
    this.lastWindowKey = ""
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
    return `${seed}:${houseSeed}:${terrain}:${foliageDensity}:${mode}:${archSettings.houseDecay}:${archSettings.weathering}:${cx},${cy}`
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
      // Refresh LRU order
      this.cache.delete(k)
      this.cache.set(k, hit)
      return hit
    }
    const worldChunk = generateWorldChunk(seed, houseSeed, cx, cy, mode)
    const compiled = compileSingleWorldChunk(worldChunk, seed, houseSeed, terrain, foliageDensity)
    if (this.cache.size >= this.maxCachedChunks) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(k, compiled)
    this.lastBakeMs = compiled.compileMs
    this.bakeStepsCompleted++
    return compiled
  }

  /** Queues uncached chunks in a 5×5 lookahead ring around `(playerX, playerY)` for incremental background baking. */
  prewarmAround(
    playerX: number,
    playerY: number,
    seed: number,
    houseSeed: number,
    terrain: number,
    foliageDensity: number,
    mode: WorldMode,
  ): void {
    const cx0 = Math.floor(playerX / CHUNK)
    const cy0 = Math.floor(playerY / CHUNK)
    for (let ring = 1; ring <= 2; ring++) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
          const cx = cx0 + dx
          const cy = cy0 + dy
          const k = this.cacheKey(seed, houseSeed, terrain, foliageDensity, mode, cx, cy)
          if (this.cache.has(k)) continue
          if (this.bakeQueue.some((q) => q.cx === cx && q.cy === cy && q.seed === seed && q.mode === mode)) continue
          this.bakeQueue.push({ cx, cy, seed, houseSeed, terrain, foliageDensity, mode })
        }
      }
    }
  }

  /** Time-sliced incremental bake: compiles at most 1 queued chunk per frame within `budgetMs`. */
  stepBakeQueue(budgetMs = 2.5): number {
    if (this.bakeQueue.length === 0) return 0
    const start = performance.now()
    let compiledCount = 0
    while (this.bakeQueue.length > 0 && performance.now() - start < budgetMs && compiledCount < 1) {
      const item = this.bakeQueue.shift()!
      const k = this.cacheKey(item.seed, item.houseSeed, item.terrain, item.foliageDensity, item.mode, item.cx, item.cy)
      if (this.cache.has(k)) continue
      this.getOrCompileChunk(item.seed, item.houseSeed, item.terrain, item.foliageDensity, item.mode, item.cx, item.cy)
      compiledCount++
    }
    return compiledCount
  }

  /**
   * Updates the 3×3 render window centered on `(playerX, playerY)` and stitches the 9 cached chunk tiles
   * into `LevelData` whenever the window moves or generation settings change.
   */
  updateWindow(
    playerX: number,
    playerY: number,
    town: Town,
    mode: WorldMode,
  ): { changed: boolean; level?: LevelData; origin: [number, number]; buildings: Building[] } {
    const foliageDensity = town.foliageDensity ?? 1
    this.center = selectActiveWindowCenter(playerX, playerY, this.center)
    const originX = (this.center.cx - 1) * CHUNK
    const originZ = (this.center.cy - 1) * CHUNK
    this.windowOrigin = [originX, originZ]

    this.prewarmAround(playerX, playerY, town.seed, town.houseSeed, town.terrain, foliageDensity, mode)
    this.stepBakeQueue(2.2)

    const winKey = `${town.seed}:${town.houseSeed}:${town.terrain}:${foliageDensity}:${mode}:${archSettings.houseDecay}:${archSettings.clutterDensity}:${archSettings.weathering}:${archSettings.clutterSeed}:${this.center.cx},${this.center.cy}`
    if (winKey === this.lastWindowKey) {
      return { changed: false, origin: this.windowOrigin, buildings: this.windowBuildings }
    }
    this.lastWindowKey = winKey

    // Assemble the 3×3 chunks in row-major order
    const gridChunks: CompiledWorldChunk[] = []
    const windowBuildings: Building[] = []
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const c = this.getOrCompileChunk(
          town.seed,
          town.houseSeed,
          town.terrain,
          foliageDensity,
          mode,
          this.center.cx + dx,
          this.center.cy + dy,
        )
        gridChunks.push(c)
        for (const b of c.buildings) {
          if (windowBuildings.length < 8) windowBuildings.push(b)
        }
      }
    }
    this.windowBuildings = windowBuildings

    const allOpaque: LevelChunk[] = []
    const allGlass: LevelChunk[] = []

    for (let gy = 0; gy < 3; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        const c = gridChunks[gy * 3 + gx]!
        const packed = packChunkMeshesForWindow(c, windowBuildings)
        allOpaque.push(...packed.opaque)
        allGlass.push(...packed.glass)

        // Blit 128×128 floorTile into 384×384 stitchedFloor
        for (let row = 0; row < 128; row++) {
          const dstRow = (gy * 128 + row) * 384 * 2 + gx * 128 * 2
          const srcRow = row * 128 * 2
          this.stitchedFloor.set(c.floorTile.subarray(srcRow, srcRow + 128 * 2), dstRow)
        }
        // Blit 256×256 moonTile into 768×768 stitchedMoon
        for (let row = 0; row < 256; row++) {
          const dstRow = (gy * 256 + row) * 768 + gx * 256
          const srcRow = row * 256
          this.stitchedMoon.set(c.moonTile.subarray(srcRow, srcRow + 256), dstRow)
        }
        // Blit 64×64 bounceTile into 192×192 stitchedBounce
        for (let row = 0; row < 64; row++) {
          const dstRow = (gy * 64 + row) * 192 * 4 + gx * 64 * 4
          const srcRow = row * 64 * 4
          this.stitchedBounce.set(c.bounceTile.subarray(srcRow, srcRow + 64 * 4), dstRow)
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
    }

    return { changed: true, level, origin: this.windowOrigin, buildings: this.windowBuildings }
  }
}
