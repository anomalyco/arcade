/**
 * CPU geometry of the night forest, built once per world into 16 m chunks with a near and a far detail level:
 *
 * - Trees are procedural trunks (root flare, buttress lobes, lean, taper) wrapped in scanned bark, with crowns of
 *   scanned needle sprays (Poly Haven's twig atlases) on whorled limbs. Card normals point out of the crown, not off
 *   the card, so a torch from below lights a crown like a volume (the standard foliage trick).
 * - The floor is a height-field mesh whose vertex colour carries the moss, trail and shore-mud weights the shader
 *   blends three scans with; ferns, rocks, roots, stumps, twigs and short logs are the scanned models scattered by
 *   rules (fern patches by a moisture field, deadfall by snags), long logs procedural.
 * - The camp (buildings, lit windows, dock boards, string lights, canoes) is procedural on the planks and roof scans.
 *
 * Vertex colour: terrain (moss, trail, mud, –); bark (moss, height share, branch share, –); cards and ferns (outer
 * crown, height share, branch share, flutter). Aux: texture layer (+ a wind phase in the fraction for baked
 * geometry; instances carry theirs).
 */
import type { ForestTree, ForestWorld, Vec2, Vec3 } from "../sim/forest-world"
import { deriveDeadfall, mulberry, segDist, smoothNoise } from "../sim/forest-demo"
import { LAYER, type ForestModels, type ModelPart } from "./assets"
import { VertexWriter, readVertex, type RGBA } from "./mesh"

export const MAT = { terrain: 40, bark: 41, needles: 42, prop: 43, fern: 44, water: 45, glow: 46, wood: 47, tape: 49, bulb: 50, paint: 51 } as const

export const CHUNK = 16
/** How far past the level's edge the backdrop forest goes (m). */
export const BACKDROP = 50
/** Floats per instance: (x, y, z, yaw), (scale xz, scale y, wind phase, param). */
export const INSTANCE_FLOATS = 8

export type ChunkMeshes = { opaque: ArrayBuffer; masked: ArrayBuffer }
export type TemplateKind = "tree" | "fern" | "rock" | "floor"
/**
 * One instanced mesh: a tree variant or a scanned model part, in its own space (+y up, base at 0). `near` draws up
 * to `nearDist`, `far` (if any) from there to `maxDist`.
 */
export type ForestTemplate = { name: string; kind: TemplateKind; near: ChunkMeshes; far: ChunkMeshes | null; nearDist: number; maxDist: number }
export type InstanceGroup = { template: number; data: Float32Array }
export type ForestChunk = {
  key: string
  x: number
  z: number
  /** Bounding box (x0, y0, z0, x1, y1, z1). */
  box: readonly number[]
  /** Procedural geometry baked in world space (terrain, logs, camp); `near` is empty past the level's edge. */
  near: ChunkMeshes
  far: ChunkMeshes
  groups: InstanceGroup[]
}

export type CampLight = { x: number; y: number; z: number; axis: Vec3; color: Vec3; power: number; range: number; cosOuter: number; kind: "window" | "bulb" | "porch" }

export type ForestBuild = {
  templates: ForestTemplate[]
  chunks: ForestChunk[]
  /** Static lights in the camp: lit windows, the porch lamp and the string-light bulbs (grouped). */
  campLights: CampLight[]
  /** Water surface (drawn by its own material, not chunked). */
  water: ArrayBuffer
  /** Ray targets for the torch's hit point: trunks (x, z, r, top y) and blobs (x, y, z, r) for rocks and logs. */
  trunks: Float32Array
  rocks: Float32Array
  /** Sky openness (r), mist pooling (g) and wetness (b) over the level, `fieldSize`² texels covering ±(half + BACKDROP). */
  field: Uint8Array
  fieldSize: number
  stats: { trees: number; ferns: number; instances: number; templateTriangles: number; staticTriangles: number }
  /** The deadfall as built (the world's, or derived when it had none): a game can collide with or aim at it. */
  logs: ForestWorld["logs"]
}

export type BuildOptions = { scatter: number; fernDensity: number; litter: number; smoothTrunks?: boolean }

type Rand = () => number
const TAU = Math.PI * 2
const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

/** Needle sprays in the fir atlas (u0, v0, u1, v1; stem at the bottom edge). */
const FIR_SPRAYS: readonly (readonly [number, number, number, number])[] = [[0.185, 0.05, 0.42, 0.31], [0.655, 0.05, 0.94, 0.37], [0.31, 0.4, 0.645, 0.775], [0.635, 0.46, 0.93, 0.83]]
const PINE_SPRAYS: readonly (readonly [number, number, number, number])[] = [[0.03, 0.05, 0.215, 0.44]]

/** Canonical size of each species' variants; instances scale trunk radius (xz) and height (y) from these. */
const SPECIES: Record<ForestTree["species"], { r: number; h: number; variants: number }> = {
  pine: { r: 0.42, h: 27, variants: 7 }, spruce: { r: 0.3, h: 21, variants: 7 }, birch: { r: 0.14, h: 15, variants: 5 }, snag: { r: 0.32, h: 12, variants: 4 },
}

class Chunks {
  map = new Map<string, { x: number; z: number; near: [VertexWriter, VertexWriter]; far: [VertexWriter, VertexWriter]; groups: Map<number, number[]>; y0: number; y1: number }>()
  at(x: number, z: number) {
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK), key = `${cx},${cz}`
    let c = this.map.get(key)
    if (!c) {
      c = { x: cx * CHUNK, z: cz * CHUNK, near: [new VertexWriter(), new VertexWriter()], far: [new VertexWriter(), new VertexWriter()], groups: new Map(), y0: Infinity, y1: -Infinity }
      this.map.set(key, c)
    }
    return c
  }
  extend(x: number, z: number, y0: number, y1: number) {
    const c = this.at(x, z)
    c.y0 = Math.min(c.y0, y0); c.y1 = Math.max(c.y1, y1)
  }
  instance(template: number, x: number, y: number, z: number, yaw: number, sxz: number, sy: number, phase: number, param: number) {
    const c = this.at(x, z)
    let list = c.groups.get(template)
    if (!list) c.groups.set(template, (list = []))
    list.push(x, y, z, yaw, sxz, sy, phase, param)
  }
}

/** Seeds as 31-bit integers: a world may give 0..1 hashes (the woods toy) or integers (the demo). */
const intSeed = (seed: number) => (Number.isInteger(seed) ? seed : Math.floor(Math.abs(seed) * 2147483647)) >>> 0

/**
 * Builds the forest. `ground` is the ground on the terrain mesh's grid (`forestHeightGrid`); pass it when it was sampled
 * elsewhere (the build worker gets it instead of the game's height function).
 */
export function buildForest(input: ForestWorld, models: ForestModels, opts: BuildOptions, ground: HeightGrid = forestHeightGrid(input)): ForestBuild {
  const world: ForestWorld & { logs: ForestWorld["logs"] } = {
    ...input,
    trees: input.trees.map(t => ({ ...t, seed: intSeed(t.seed) })),
    rocks: input.rocks.map(r => ({ ...r, seed: intSeed(r.seed) })),
    logs: input.logs.map(l => ({ ...l, seed: intSeed(l.seed) })),
  }
  // A level without deadfall gets the renderer's own (`deriveDeadfall`, pure: a game can collide with the same logs).
  // Long trunks rarely lie whole: derived ones snap into two pieces kinked at the break.
  if (!world.logs.length) world.logs = deriveDeadfall(world, Math.round((world.half * world.half) / 140)).flatMap(l => {
    if (l.length < 7) return [l]
    const r = mulberry(l.seed + 17), cut = 0.4 + r() * 0.2, kink = (r() - 0.5) * 0.4, gap = 0.2 + r() * 0.4
    const ca = Math.cos(l.yaw), sa = Math.sin(l.yaw)
    const a = l.length * cut, b = l.length - a - gap
    const x0 = l.x - ca * l.length / 2, z0 = l.z - sa * l.length / 2
    const bx = x0 + ca * (a + gap), bz = z0 + sa * (a + gap), yb = l.yaw + kink
    return [
      { ...l, x: x0 + ca * a / 2, z: z0 + sa * a / 2, length: a },
      { ...l, x: bx + Math.cos(yb) * b / 2, z: bz + Math.sin(yb) * b / 2, yaw: yb, length: b, r: l.r * 0.8, seed: l.seed + 1 },
    ]
  })
  const reach = world.half + BACKDROP
  // Everything stands on the terrain as drawn.
  world.height = gridHeight(ground, input.height)
  const rand = mulberry(world.seed * 31 + 5)
  const chunks = new Chunks()
  const H = world.height
  const stats = { trees: 0, ferns: 0, instances: 0, templateTriangles: 0, staticTriangles: 0 }
  const templates: ForestTemplate[] = []
  const addTemplate = (t: ForestTemplate) => { templates.push(t); return templates.length - 1 }

  // ---- Tree variants.
  const variants = {} as Record<ForestTree["species"], number[]>
  for (const species of Object.keys(SPECIES) as ForestTree["species"][]) {
    const spec = SPECIES[species]
    variants[species] = []
    for (let v = 0; v < spec.variants; v++) {
      const seed = (world.seed * 1009 + v * 7919 + species.length * 104729) >>> 0
      const vr = mulberry(seed)
      const t: ForestTree = { x: 0, z: 0, species, r: spec.r, h: spec.h, lean: species === "birch" ? 0.03 + vr() * 0.1 : species === "snag" ? vr() * 0.06 : vr() * 0.025, leanYaw: vr() * TAU, seed }
      const nearW: [VertexWriter, VertexWriter] = [new VertexWriter(), new VertexWriter()], farW: [VertexWriter, VertexWriter] = [new VertexWriter(), new VertexWriter()]
      tree(nearW[0], nearW[1], t, 0, true, opts.smoothTrunks)
      tree(farW[0], farW[1], t, 0, false)
      variants[species].push(addTemplate({ name: `${species}-${v}`, kind: "tree", near: { opaque: nearW[0].finish(), masked: nearW[1].finish() }, far: { opaque: farW[0].finish(), masked: farW[1].finish() }, nearDist: 40, maxDist: 400 }))
    }
  }
  const saplings: number[] = []
  for (let v = 0; v < 4; v++) {
    const seed = (world.seed * 2003 + v * 6151) >>> 0
    const t: ForestTree = { x: 0, z: 0, species: "spruce", r: 0.05, h: 3.2, lean: 0.02, leanYaw: v, seed }
    const w: [VertexWriter, VertexWriter] = [new VertexWriter(), new VertexWriter()]
    tree(w[0], w[1], t, 0, true)
    saplings.push(addTemplate({ name: `sapling-${v}`, kind: "fern", near: { opaque: w[0].finish(), masked: w[1].finish() }, far: null, nearDist: 70, maxDist: 70 }))
  }
  // ---- Model templates: the scanned parts with their wind and moss weights baked into vertex colour.
  const modelTemplate = (name: string, part: ModelPart, kind: TemplateKind, mat: number, layer: number, color: (p: readonly number[]) => RGBA, nearDist: number, maxDist: number) => {
    const w = new VertexWriter()
    placeModel(w, part, 0, -part.min[1]!, 0, 0, [1, 1, 1], mat, layer, color)
    return addTemplate({ name, kind, near: { opaque: mat === MAT.fern ? new ArrayBuffer(0) : w.finish(), masked: mat === MAT.fern ? w.finish() : new ArrayBuffer(0) }, far: null, nearDist, maxDist })
  }
  const fernColor = (part: ModelPart) => {
    const span = Math.max(0.01, part.max[1]! - part.min[1]!)
    return (p: readonly number[]): RGBA => { const f = Math.max(0, Math.min(1, (p[1]! - part.min[1]!) / span)); return [1, f, f, f] }
  }
  const ferns = models.fern.map((part, i) => ({ part, t: modelTemplate(`fern-${i}`, part, "fern", MAT.fern, LAYER.fern, fernColor(part), 30, 30) }))
  // Far ferns: the same clump decimated to about a quarter of its triangles (`fern-lod1`).
  for (const [i, f] of ferns.entries()) {
    const lod = models["fern-lod1"]?.[i]
    if (!lod) continue
    const w = new VertexWriter()
    placeModel(w, lod, 0, -f.part.min[1]!, 0, 0, [1, 1, 1], MAT.fern, LAYER.fern, fernColor(f.part))
    templates[f.t]!.far = { opaque: new ArrayBuffer(0), masked: w.finish() }
  }
  const rocksA = models["rocks-a"].map((part, i) => ({ part, t: modelTemplate(`rocks-a-${i}`, part, "rock", MAT.prop, LAYER["rocks-a"], () => [1, 0, 0, 0], 120, 120) }))
  const rocksB = models["rocks-b"].map((part, i) => ({ part, t: modelTemplate(`rocks-b-${i}`, part, "rock", MAT.prop, LAYER["rocks-b"], () => [1, 0, 0, 0], 90, 90) }))
  const roots = models.roots.map((part, i) => ({ part, t: modelTemplate(`roots-${i}`, part, "floor", MAT.prop, LAYER.roots, () => [0.6, 0, 0, 0], 45, 45) }))
  const twigsT = models.branches.map((part, i) => ({ part, t: modelTemplate(`twigs-${i}`, part, "floor", MAT.prop, LAYER.branches, () => [0.2, 0, 0, 0], 22, 22) }))
  const stumpT = { part: models.stump[0]!, t: modelTemplate("stump", models.stump[0]!, "floor", MAT.prop, LAYER.stump, () => [0.7, 0, 0, 0], 70, 70) }
  const tableT = { part: models["picnic-table"][0]!, t: modelTemplate("picnic-table", models["picnic-table"][0]!, "floor", MAT.wood, LAYER["picnic-table"], () => [0, 0, 0.35, 0], 70, 70) }

  // ---- Trees, including a backdrop ring past the level's edge so it never ends in a wall.
  const trees: ForestTree[] = [...world.trees]
  const brand = mulberry(world.seed * 7 + 1)
  for (let gz = -reach; gz < reach; gz += 5) for (let gx = -reach; gx < reach; gx += 5) {
    const x = gx + brand() * 5, z = gz + brand() * 5
    if (Math.max(Math.abs(x), Math.abs(z)) < world.half + 2) continue
    if (brand() > 0.75) continue
    const sp = brand() < 0.1 ? "birch" : brand() < 0.55 ? "pine" : "spruce"
    const spec = SPECIES[sp]
    trees.push({ x, z, species: sp, r: spec.r * (0.8 + brand() * 0.4), h: spec.h * (0.85 + brand() * 0.3), seed: Math.floor(brand() * 1e9) })
  }
  const trunkData: number[] = []
  for (const t of trees) {
    const y = H(t.x, t.z)
    const spec = SPECIES[t.species]
    const list = variants[t.species]
    const tpl = list[t.seed % list.length]!
    const yaw = ((t.seed >>> 8) % 6283) / 1000
    // Crown width follows height (and a little per tree); the trunk its own radius (packed, see `vsTree`).
    const crownScale = Math.pow(t.h / spec.h, 0.8) * (0.85 + 0.3 * (((t.seed >>> 16) % 1000) / 1000))
    const trunkPacked = Math.max(1, Math.round((t.r / spec.r) * 256)) + Math.min(0.999, ((t.seed >>> 12) % 1000) / 1000)
    chunks.instance(tpl, t.x, y - 0.05, t.z, yaw, crownScale, t.h / spec.h, ((t.seed >>> 4) % 1000) / 1000, trunkPacked)
    chunks.extend(t.x, t.z, y - 1, y + t.h + 1)
    trunkData.push(t.x, t.z, t.r, y + t.h)
    stats.trees++
  }

  // ---- Terrain: full detail inside the level, coarse everywhere. On the chunk grid, so each patch sits in its box.
  const grid0 = Math.floor(-reach / CHUNK) * CHUNK
  for (let cz = grid0; cz < reach; cz += CHUNK) for (let cx = grid0; cx < reach; cx += CHUNK) {
    const c = chunks.at(cx + 1, cz + 1)
    const inner = Math.max(Math.abs(cx + CHUNK / 2), Math.abs(cz + CHUNK / 2)) < world.half + CHUNK
    if (inner) terrain(c.near[0], world, cx, cz, 1)
    terrain(c.far[0], world, cx, cz, 4)
    for (const [x, z] of [[cx, cz], [cx + CHUNK, cz], [cx, cz + CHUNK], [cx + CHUNK, cz + CHUNK], [cx + CHUNK / 2, cz + CHUNK / 2]] as const) chunks.extend(cx + 1, cz + 1, H(x, z) - 2, H(x, z) + 1)
  }

  // ---- Rocks.
  const rockData: number[] = []
  for (const r of world.rocks) {
    const set = r.r > 0.7 ? rocksA : rocksB
    const pick = set[Math.floor(hash01(r.seed) * set.length)]!
    const part = pick.part
    const ext = [part.max[0]! - part.min[0]!, part.max[1]! - part.min[1]!, part.max[2]! - part.min[2]!]
    const sx = (2 * r.r) / Math.max(ext[0]!, ext[2]!), sy = r.h / ext[1]!
    const y = Math.min(H(r.x, r.z), H(r.x + r.r, r.z), H(r.x - r.r, r.z), H(r.x, r.z + r.r), H(r.x, r.z - r.r)) - r.h * 0.18
    chunks.instance(pick.t, r.x, y, r.z, r.yaw, sx, sy, 0, r.moss ?? 0.7)
    chunks.extend(r.x, r.z, y, y + r.h * 1.3)
    rockData.push(r.x, y + r.h * 0.45, r.z, Math.max(r.r * 0.9, r.h * 0.6))
  }

  // ---- Logs: stubby ones are the scanned trunk (baked, high-poly: it stretches), the rest procedural.
  for (const l of world.logs) {
    const c = chunks.at(l.x, l.z)
    const ca = Math.cos(l.yaw), sa = Math.sin(l.yaw)
    let ground = -Infinity
    for (let k = -2; k <= 2; k++) ground = Math.max(ground, H(l.x + ca * l.length * k / 4, l.z + sa * l.length * k / 4))
    const y = ground + l.r * 0.65
    if (l.length < 2.5) {
      const part = models.log[0]!
      const len = part.max[0]! - part.min[0]!, rad = (part.max[1]! - part.min[1]!) / 2
      const s: Vec3 = [l.length / len, l.r / rad, l.r / rad]
      const color: RGBA = [0.8, 0, 0, 0]
      placeModel(c.near[0], part, l.x, y - (part.min[1]! + rad) * s[1], l.z, -l.yaw, s, MAT.prop, LAYER.log, () => color)
    } else {
      logMesh(c.near[0], l.x, y, l.z, l.yaw, l.length, l.r, l.seed, 12, H)
      logMesh(c.far[0], l.x, y, l.z, l.yaw, l.length, l.r, l.seed, 5, H)
    }
    chunks.extend(l.x, l.z, y - l.r, y + l.r)
    for (let k = -1; k <= 1; k++) rockData.push(l.x + ca * l.length * k / 3, y, l.z + sa * l.length * k / 3, l.r * 1.2)
  }

  // ---- Floor scatter: ferns in moist patches, roots at big trunks, stumps, twigs.
  // Bucket trunks and rocks on a 4 m grid so the scatter's clearance tests stay local.
  const grid = new Map<number, number[]>()
  const cellOf = (x: number, z: number) => (Math.floor(x / 4) + 1000) * 4096 + Math.floor(z / 4) + 1000
  const bucket = (x: number, z: number, r: number) => {
    for (let gx = Math.floor((x - r - 1) / 4); gx <= Math.floor((x + r + 1) / 4); gx++) for (let gz = Math.floor((z - r - 1) / 4); gz <= Math.floor((z + r + 1) / 4); gz++) {
      const k = (gx + 1000) * 4096 + gz + 1000
      let list = grid.get(k)
      if (!list) grid.set(k, (list = []))
      list.push(x, z, r)
    }
  }
  for (let i = 0; i < trunkData.length; i += 4) bucket(trunkData[i]!, trunkData[i + 1]!, trunkData[i + 2]!)
  for (let i = 0; i < rockData.length; i += 4) bucket(rockData[i]!, rockData[i + 2]!, rockData[i + 3]! * 0.8)
  const occupied = (x: number, z: number, pad: number) => {
    const list = grid.get(cellOf(x, z))
    if (!list) return false
    for (let i = 0; i < list.length; i += 3) if (Math.hypot(list[i]! - x, list[i + 1]! - z) < list[i + 2]! + pad) return true
    return false
  }
  const onPath = (x: number, z: number, pad: number) => (world.paths ?? []).some(p => segDist(p.points, x, z) < p.width * 0.5 + pad)
  const lake = world.lake
  const lakeD = (x: number, z: number) => lake ? Math.hypot((x - lake.x) / lake.rx, (z - lake.z) / lake.rz) : 9
  const inCamp = (x: number, z: number, pad: number) => (world.camp?.buildings ?? []).some(b => Math.hypot(x - b.x, z - b.z) < Math.max(b.w, b.d) * 0.6 + pad)
  // Clearings (depth inside the nearest, negative outside): ferns thin in from the edge; no saplings or stumps.
  const clearingDepth = (x: number, z: number) => Math.max(-Infinity, ...(world.clearings ?? []).map(c => c.r - Math.hypot(x - c.x, z - c.z)))
  const fernLimit = world.half + 6
  const density = 0.45 * opts.fernDensity * opts.scatter
  // Logs keep the damp under them: ferns and litter crowd their sides and break their line.
  const logGrid = new Map<number, number[]>()
  world.logs.forEach((l, i) => {
    const ca = Math.cos(l.yaw), sa = Math.sin(l.yaw)
    for (let t = -l.length / 2; t <= l.length / 2 + 4; t += 4) {
      const k = cellOf(l.x + ca * Math.min(t, l.length / 2), l.z + sa * Math.min(t, l.length / 2))
      const list = logGrid.get(k) ?? []
      if (!list.includes(i)) list.push(i)
      logGrid.set(k, list)
    }
  })
  const logEdge = (x: number, z: number) => {
    let e = 0
    for (const gx of [-4, 0, 4]) for (const gz of [-4, 0, 4]) for (const i of logGrid.get(cellOf(x + gx, z + gz)) ?? []) {
      const l = world.logs[i]!, ca = Math.cos(l.yaw), sa = Math.sin(l.yaw)
      const along = Math.max(-l.length / 2, Math.min(l.length / 2, (x - l.x) * ca + (z - l.z) * sa))
      const d = Math.hypot(x - (l.x + ca * along), z - (l.z + sa * along)) - l.r
      e = Math.max(e, smooth(0.05, 0.4, d) * smooth(1.6, 0.6, d))
    }
    return e
  }
  const pathEdge = (x: number, z: number) => {
    let e = 0
    for (const p of world.paths ?? []) { const d = segDist(p.points, x, z) - p.width * 0.5; e = Math.max(e, smooth(0.2, 0.7, d) * smooth(3.5, 1.2, d)) }
    return e
  }
  for (let z = -fernLimit; z < fernLimit; z += 0.85) for (let x = -fernLimit; x < fernLimit; x += 0.85) {
    const px = x + rand() * 0.85, pz = z + rand() * 0.85
    // Ferns fill the moist patches and hollows and line the trail edges, where light reaches the floor.
    const patch = Math.min(1, smooth(-0.1, 0.45, smoothNoise(world.seed + 21, px / 9, pz / 9) * 0.6 + smoothNoise(world.seed + 22, px / 3.5, pz / 3.5) * 0.4 + hollowness(world, px, pz) * 0.5) + pathEdge(px, pz) * 0.7 + logEdge(px, pz) * 0.8)
    if (rand() > patch * density * 2.2 * smooth(3, 0, clearingDepth(px, pz))) continue
    if (lakeD(px, pz) < 1.06 || onPath(px, pz, 0.35) || occupied(px, pz, 0.25) || inCamp(px, pz, 3)) continue
    const big = rand() < 0.55
    const pick = ferns[big ? Math.floor(rand() * 2) : 2 + Math.floor(rand() * 2)]!
    const s = (big ? 0.9 : 1.3) * (0.75 + rand() * 0.75)
    chunks.instance(pick.t, px, H(px, pz) - 0.04, pz, rand() * TAU, s, s * (0.85 + rand() * 0.4), rand(), 0)
    stats.ferns++
  }
  // Young spruce in the gaps: the understorey that hides the far trunks at eye height.
  const sapRand = mulberry(world.seed + 91)
  for (let z = -fernLimit; z < fernLimit; z += 4) for (let x = -fernLimit; x < fernLimit; x += 4) {
    const px = x + sapRand() * 4, pz = z + sapRand() * 4
    const gap = smooth(0.0, 0.5, smoothNoise(world.seed + 41, px / 14, pz / 14))
    if (sapRand() > 0.12 + gap * 0.5 * opts.scatter) continue
    if (lakeD(px, pz) < 1.1 || onPath(px, pz, 1.2) || occupied(px, pz, 0.9) || inCamp(px, pz, 5) || clearingDepth(px, pz) > -2) continue
    const s = 0.45 + sapRand() * 1.1
    chunks.instance(saplings[Math.floor(sapRand() * saplings.length)]!, px, H(px, pz) - 0.05, pz, sapRand() * TAU, s, s, sapRand(), 0)
    bucket(px, pz, 0.3)
  }
  for (const t of world.trees) {
    if (t.r < 0.36 || t.species === "birch") continue
    const pick = roots[Math.floor(hash01(t.seed + 3) * roots.length)]!
    const s = t.r / 0.32
    chunks.instance(pick.t, t.x, H(t.x, t.z) - 0.05, t.z, hash01(t.seed + 4) * TAU, s, s * 0.8, 0, 0.6)
  }
  const stumpRand = mulberry(world.seed + 77)
  for (let i = 0; i < 40; i++) {
    const x = (stumpRand() * 2 - 1) * world.half * 0.9, z = (stumpRand() * 2 - 1) * world.half * 0.9
    if (lakeD(x, z) < 1.05 || onPath(x, z, 0.6) || occupied(x, z, 0.8) || inCamp(x, z, 3) || clearingDepth(x, z) > 0) continue
    const s = 0.5 + stumpRand() * 0.5
    chunks.instance(stumpT.t, x, H(x, z) - 0.1, z, stumpRand() * TAU, s, s, 0, 0.7)
    rockData.push(x, H(x, z) + 0.25 * s, z, 0.6 * s)
    bucket(x, z, 0.5 * s)
  }
  const twigs = Math.round(1400 * opts.litter * opts.scatter)
  for (let i = 0; i < twigs; i++) {
    const x = (rand() * 2 - 1) * world.half, z = (rand() * 2 - 1) * world.half
    if (lakeD(x, z) < 1.02 || onPath(x, z, 0.1) || inCamp(x, z, 1)) continue
    const pick = twigsT[Math.floor(rand() * twigsT.length)]!
    const s = 0.8 + rand() * 0.8
    chunks.instance(pick.t, x, H(x, z) - 0.02, z, rand() * TAU, s, s, 0, 0.2)
  }

  // ---- Flagging tape.
  for (const f of world.flags ?? []) tape(chunks.at(f.x, f.z).near[0], f.x, H(f.x, f.z) + f.y, f.z, f.r, f.yaw)

  // ---- Camp.
  const campLights: CampLight[] = []
  if (world.camp) camp(world, chunks, models, campLights, (x, y, z, yaw) => chunks.instance(tableT.t, x, y, z, yaw, 1, 1, 0, 0))

  // ---- Water.
  const water = new VertexWriter()
  if (lake) {
    const n = 64
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * TAU, a1 = ((i + 1) / n) * TAU
      const p = (a: number): Vec3 => [lake.x + Math.cos(a) * lake.rx * 1.3, lake.level, lake.z + Math.sin(a) * lake.rz * 1.3]
      for (const q of [[lake.x, lake.level, lake.z] as Vec3, p(a1), p(a0)]) water.vert(q[0], q[1], q[2], 0, 1, 0, [0, 0, 0, 0], MAT.water, 0, 0, 0)
    }
  }

  // ---- Field map: sky openness through the canopy, mist pooling, wetness.
  const fieldSize = 256
  const field = new Uint8Array(fieldSize * fieldSize * 4)
  const crown = new Float32Array(fieldSize * fieldSize)
  const texel = (2 * reach) / fieldSize
  for (const t of trees) {
    if (t.species === "snag") continue
    const rad = t.species === "pine" ? 3.6 : t.species === "spruce" ? 2.6 : 2.2
    const i0 = Math.floor((t.x - rad + reach) / texel), i1 = Math.ceil((t.x + rad + reach) / texel)
    const j0 = Math.floor((t.z - rad + reach) / texel), j1 = Math.ceil((t.z + rad + reach) / texel)
    for (let j = Math.max(0, j0); j < Math.min(fieldSize, j1); j++) for (let i = Math.max(0, i0); i < Math.min(fieldSize, i1); i++) {
      const x = -reach + (i + 0.5) * texel, z = -reach + (j + 0.5) * texel
      const d = Math.hypot(x - t.x, z - t.z) / rad
      if (d < 1) crown[j * fieldSize + i]! += (1 - d * d) * 0.55
    }
  }
  // Blur the canopy over ~8 m: openness is what the sky hemisphere sees, not the crown directly above.
  const blurred = blur(crown, fieldSize, 3)
  for (let j = 0; j < fieldSize; j++) for (let i = 0; i < fieldSize; i++) {
    const x = -reach + (i + 0.5) * texel, z = -reach + (j + 0.5) * texel
    const o = (j * fieldSize + i) * 4
    field[o] = Math.round(255 * Math.exp(-blurred[j * fieldSize + i]! * 1.2))
    field[o + 1] = Math.round(255 * Math.min(1, hollowness(world, x, z) + (lake ? Math.max(0, 1.4 - lakeD(x, z)) : 0)))
    field[o + 2] = Math.round(255 * (lake ? smooth(1.15, 0.95, lakeD(x, z)) : 0))
    field[o + 3] = 255
  }

  const out: ForestChunk[] = []
  for (const [key, c] of chunks.map) {
    const near: ChunkMeshes = { opaque: c.near[0].finish(), masked: c.near[1].finish() }
    const far: ChunkMeshes = { opaque: c.far[0].finish(), masked: c.far[1].finish() }
    stats.staticTriangles += (near.opaque.byteLength + near.masked.byteLength) / 96
    const groups = [...c.groups].map(([template, list]) => ({ template, data: new Float32Array(list) }))
    for (const g of groups) stats.instances += g.data.length / INSTANCE_FLOATS
    out.push({ key, x: c.x, z: c.z, box: [c.x, c.y0, c.z, c.x + CHUNK, c.y1, c.z + CHUNK], near, far, groups })
  }
  for (const t of templates) stats.templateTriangles += (t.near.opaque.byteLength + t.near.masked.byteLength + (t.far ? t.far.opaque.byteLength + t.far.masked.byteLength : 0)) / 96
  return { templates, chunks: out, campLights, water: water.finish(), trunks: new Float32Array(trunkData), rocks: new Float32Array(rockData), field, fieldSize, stats, logs: world.logs }
}

/** The ground sampled on the terrain mesh's 1 m grid: integer metres from −half to +half on both axes, row by row in z. */
export type HeightGrid = { half: number; data: Float32Array }

/**
 * Samples the game's height once on the terrain mesh's grid, out past the backdrop: the build reads the ground from it
 * (`gridHeight`), calling the game's height ~250 k times instead of ~4 M (a terrain function that costs 60 ns in Bun
 * can cost µs in a page).
 */
export function forestHeightGrid(world: Pick<ForestWorld, "half" | "height">): HeightGrid {
  // The terrain's last chunk ends on the chunk grid past the backdrop; its normals and mist hollows look 9.5 m further.
  const half = Math.ceil((world.half + BACKDROP) / CHUNK) * CHUNK + 12, n = 2 * half + 1
  const data = new Float32Array(n * n)
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) data[j * n + i] = world.height(i - half, j - half)
  return { half, data }
}

/**
 * The ground as the terrain mesh draws it: the grid read back over the same triangles (each quad split corner (i, j)
 * to (i + 1, j + 1)), so props sit on the surface you see; `outside` past the grid's edge.
 */
export function gridHeight(grid: HeightGrid, outside: (x: number, z: number) => number): (x: number, z: number) => number {
  const { half, data: g } = grid, n = 2 * half + 1
  return (x, z) => {
    const gx = x + half, gz = z + half
    const i = Math.floor(gx), j = Math.floor(gz)
    if (!(i >= 0 && j >= 0 && i < n - 1 && j < n - 1)) return outside(x, z)
    const fx = gx - i, fz = gz - j, k = j * n + i
    const a = g[k]!, b = g[k + 1]!, c = g[k + n + 1]!, d = g[k + n]!
    return fz > fx ? a + fz * (d - a) + fx * (c - d) : a + fx * (b - a) + fz * (c - b)
  }
}

/** The grid's nearest edge sample past its edge (for a build without the game's height function). */
export function clampedGridHeight(grid: HeightGrid): (x: number, z: number) => number {
  const { half, data } = grid, n = 2 * half + 1
  return gridHeight(grid, (x, z) => {
    const i = Math.min(n - 1, Math.max(0, Math.round(x + half))), j = Math.min(n - 1, Math.max(0, Math.round(z + half)))
    return data[j * n + i]!
  })
}

function hollowness(world: ForestWorld, x: number, z: number): number {
  // Lower than the surroundings: the mist pools there.
  const h = world.height(x, z)
  const around = (world.height(x + 9, z) + world.height(x - 9, z) + world.height(x, z + 9) + world.height(x, z - 9)) / 4
  return Math.max(0, Math.min(1, (around - h) * 1.2))
}

function blur(src: Float32Array, n: number, r: number): Float32Array {
  let a = src, b = new Float32Array(src.length)
  for (const axis of [0, 1]) {
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      let s = 0, w = 0
      for (let k = -r; k <= r; k++) {
        const ii = axis ? i : Math.min(n - 1, Math.max(0, i + k)), jj = axis ? Math.min(n - 1, Math.max(0, j + k)) : j
        const wk = 1 - Math.abs(k) / (r + 1)
        s += a[jj * n + ii]! * wk; w += wk
      }
      b[j * n + i] = s / w
    }
    ;[a, b] = [b, new Float32Array(src.length)]
  }
  return a
}

const hash01 = (s: number) => mulberry(s >>> 0)()

// ------------------------------------------------------------------ trees

const BARK_TILE = 1.3

function barkLayer(t: ForestTree): number {
  return t.species === "birch" ? LAYER["bark-birch"] : t.species === "pine" ? LAYER["bark-pine"] : t.species === "spruce" ? LAYER["bark-spruce"] : LAYER["bark-mossy"]
}

/** Point on the (leaning, slightly wandering) trunk axis at height y above the base. */
function axisAt(t: ForestTree, base: number, y: number, seed: number): [number, number, number] {
  const lean = t.lean ?? 0, yaw = t.leanYaw ?? 0
  const bend = Math.sin(y * 0.21 + seed * 6.28) * t.r * 0.35
  return [t.x + Math.cos(yaw) * Math.sin(lean) * y + Math.cos(seed * 9) * bend, base + y * Math.cos(lean), t.z + Math.sin(yaw) * Math.sin(lean) * y + Math.sin(seed * 9) * bend]
}

function tree(opaque: VertexWriter, masked: VertexWriter, t: ForestTree, base: number, near: boolean, smoothTrunk = false) {
  const rand = mulberry(t.seed)
  const s01 = rand()
  const layer = barkLayer(t)
  const top = t.species === "snag" ? t.h * (0.55 + 0.3 * rand()) : t.h
  // Trunk: denser rings near the flare.
  const sides = near ? (smoothTrunk ? 32 : t.species === "birch" ? 8 : t.r > 0.3 ? 14 : 10) : t.r > 0.25 ? 6 : 5
  const rings = near ? Math.max(8, Math.min(24, Math.round(top / 1.3))) : 5
  const reps = Math.max(1, Math.round((TAU * t.r) / BARK_TILE))
  const mossAmount = t.species === "birch" ? 0.25 : 0.55 + 0.45 * rand()
  // Evaluate the same surface on either side of a ring: sharing its normal avoids
  // the horizontal lighting seams caused by each band's independent slope.
  const surface = (y: number, th: number) => {
    const f = y / top
    const taper = t.species === "snag" ? 1 - 0.45 * f : Math.pow(Math.max(0.01, 1 - 0.92 * f), 0.85)
    const flare = 1 + (t.species === "birch" ? 0.25 : 0.6) * Math.exp(-y / (0.7 * t.r + 0.25))
    const lobes = 1 + 0.13 * Math.exp(-y / 0.9) * Math.cos(4 * th + s01 * 7) + 0.03 * Math.cos(9 * th + y * 0.7)
    const r = Math.max(0.015, t.r * taper * flare) * lobes
    const c = axisAt(t, base - 0.25, y, s01)
    return [c[0] + Math.cos(th) * r, c[1], c[2] + Math.sin(th) * r]
  }
  const ringPts: { c: [number, number, number]; r: number; y: number }[] = []
  for (let k = 0; k <= rings; k++) {
    const f = Math.pow(k / rings, 1.35)
    const y = f * top
    const taper = t.species === "snag" ? 1 - 0.45 * f : Math.pow(1 - 0.92 * f, 0.85)
    const flare = 1 + (t.species === "birch" ? 0.25 : 0.6) * Math.exp(-y / (0.7 * t.r + 0.25))
    ringPts.push({ c: axisAt(t, base - 0.25, y, s01), r: Math.max(0.015, t.r * taper * flare), y })
  }
  for (let k = 0; k < rings; k++) {
    const a = ringPts[k]!, b = ringPts[k + 1]!
    for (let i = 0; i < sides; i++) {
      const quad = [[i, a], [i + 1, a], [i + 1, b], [i, b]] as const
      const verts = quad.map(([ii, ring]) => {
        const th = (ii / sides) * TAU
        const lobes = 1 + 0.13 * Math.exp(-ring.y / 0.9) * Math.cos(4 * th + s01 * 7) + 0.03 * Math.cos(9 * th + ring.y * 0.7)
        const rr = ring.r * lobes
        const nx = Math.cos(th), nz = Math.sin(th)
        const moss = mossAmount * Math.exp(-ring.y / 3.5) * (0.6 + 0.4 * Math.max(0, -nz))
        let n = [nx, (a.r - b.r) / Math.max(0.3, b.y - a.y), nz]
        if (smoothTrunk) {
          const left = surface(ring.y, th - 0.002), right = surface(ring.y, th + 0.002)
          const below = surface(ring.y - 0.002, th), above = surface(ring.y + 0.002, th)
          n = norm(cross(above.map((v, j) => v - below[j]!), right.map((v, j) => v - left[j]!)))
        }
        return { p: [ring.c[0] + nx * rr, ring.c[1], ring.c[2] + nz * rr], n, c: [moss, ring.y / t.h, 0, 0] as RGBA, uv: [(ii / sides) * reps, -ring.y / BARK_TILE] }
      })
      for (const idx of [0, 1, 2, 0, 2, 3]) {
        const v = verts[idx]!
        opaque.vert(v.p[0]!, v.p[1]!, v.p[2]!, v.n[0]!, v.n[1]!, v.n[2]!, v.c, MAT.bark, layer, v.uv[0]!, v.uv[1]!)
      }
    }
  }
  if (t.species === "snag") {
    // Broken top and a few dead stubs.
    for (let i = 0; i < (near ? 6 : 0); i++) {
      const y = top * (0.3 + 0.6 * rand()), yaw = rand() * TAU
      const a = axisAt(t, base, y, s01)
      limb(opaque, a, [Math.cos(yaw) * 0.9, 0.15 - rand() * 0.3, Math.sin(yaw) * 0.9], 0.6 + rand() * 1.4, t.r * 0.18, layer, y / t.h, 4)
    }
    return
  }
  crown(opaque, masked, t, base, near, rand)
}

function limb(w: VertexWriter, from: readonly number[], dir: readonly number[], len: number, r0: number, layer: number, h: number, sides: number) {
  const l = Math.hypot(dir[0]!, dir[1]!, dir[2]!) || 1
  const d = [dir[0]! / l, dir[1]! / l, dir[2]! / l]
  const up = Math.abs(d[1]!) > 0.9 ? [1, 0, 0] : [0, 1, 0]
  const ax = norm(cross(d, up)), ay = cross(ax, d)
  for (let i = 0; i < sides; i++) {
    const t0 = (i / sides) * TAU, t1 = ((i + 1) / sides) * TAU
    const ring = (t: number, f: number) => {
      const r = r0 * (1 - 0.8 * f)
      const n = [ax[0]! * Math.cos(t) + ay[0]! * Math.sin(t), ax[1]! * Math.cos(t) + ay[1]! * Math.sin(t), ax[2]! * Math.cos(t) + ay[2]! * Math.sin(t)]
      return { p: [from[0]! + d[0]! * len * f + n[0]! * r, from[1]! + d[1]! * len * f + n[1]! * r - f * f * len * 0.12, from[2]! + d[2]! * len * f + n[2]! * r], n, f }
    }
    const q = [ring(t0, 0), ring(t1, 0), ring(t1, 1), ring(t0, 1)]
    for (const idx of [0, 1, 2, 0, 2, 3]) {
      const v = q[idx]!
      w.vert(v.p[0]!, v.p[1]!, v.p[2]!, v.n[0]!, v.n[1]!, v.n[2]!, [0, h, v.f, 0], MAT.bark, layer, (i / sides) * 0.5, -v.f * len / BARK_TILE)
    }
  }
}

const cross = (a: readonly number[], b: readonly number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!]
const norm = (a: readonly number[]) => { const l = Math.hypot(a[0]!, a[1]!, a[2]!) || 1; return [a[0]! / l, a[1]! / l, a[2]! / l] }

function crown(opaque: VertexWriter, masked: VertexWriter, t: ForestTree, base: number, near: boolean, rand: Rand) {
  const sp = t.species
  const sapling = t.h < 6
  // Old growth self-prunes: the live crown starts high, with dead limbs and stubs below it.
  const start = sapling ? 0.06 : sp === "pine" ? 0.55 + 0.1 * rand() : sp === "spruce" ? 0.3 + 0.1 * rand() : 0.42 + 0.1 * rand()
  const radius = sapling ? t.h * 0.3 : sp === "pine" ? 3.2 + 1.4 * rand() : sp === "spruce" ? 2.2 + 0.8 * rand() : 1.8 + 0.8 * rand()
  const spacing = (sapling ? 0.32 : sp === "pine" ? 0.8 : sp === "spruce" ? 0.5 : 0.7) * (near ? 1 : 2.2)
  const perWhorl = near ? (sp === "pine" ? 6 : sp === "spruce" ? 7 : 5) : 4
  const sprays = sp === "pine" ? PINE_SPRAYS : FIR_SPRAYS
  const layer = sp === "pine" ? LAYER["twig-pine"] : LAYER["twig-fir"]
  const y0 = t.h * start
  if (near && !sapling) {
    // Dead limbs: thin, drooping, bare; denser just under the live crown.
    for (let y = 1.6 + rand(); y < y0; y += 0.35 + rand() * 0.5) {
      const share = y / y0
      if (rand() > 0.35 + 0.5 * share) continue
      const a = axisAt(t, base, y, 0)
      const yaw = rand() * TAU
      const L = (0.25 + rand() * 0.9) * (0.4 + 0.8 * share) * (sp === "pine" ? 1.3 : 1)
      limb(opaque, a, [Math.cos(yaw), -0.15 - rand() * 0.35, Math.sin(yaw)], L, Math.min(t.r * 0.08, 0.02 + L * 0.01), barkLayer(t), y / t.h, 3)
    }
  }
  let whorl = 0
  for (let y = y0; y < t.h - 0.3; y += spacing * (0.8 + 0.4 * rand()), whorl++) {
    const f = (y - y0) / (t.h - y0)
    // Spruce: a cone. Pine: an irregular flat-topped crown. Birch: an oval.
    const len = sp === "spruce" || sapling ? radius * Math.pow(1 - f, 0.95) + 0.2 : sp === "pine" ? radius * Math.pow(Math.sin(Math.PI * Math.min(1, f * 0.9 + 0.12)), 0.6) * (0.6 + 0.6 * rand()) : radius * Math.sin(Math.PI * Math.min(1, f + 0.08)) * (0.7 + 0.4 * rand())
    const twist = rand() * TAU
    // Spruce and saplings also grow short shoots between whorls: without them the crown reads as stacked tiers.
    const fill = near && (sp === "spruce" || sapling)
    const branches = fill ? perWhorl + 3 : perWhorl
    for (let b = 0; b < branches; b++) {
      if (sp === "pine" && rand() < 0.2) continue
      const minor = b >= perWhorl
      const yb = minor ? y + spacing * (0.35 + 0.3 * rand()) : y
      if (yb > t.h - 0.3) continue
      const a = axisAt(t, base, yb, 0)
      const yaw = minor ? rand() * TAU : twist + (b / perWhorl) * TAU + (rand() - 0.5) * 0.6
      const droop = (sp === "spruce" ? -0.25 - 0.25 * (1 - f) : sp === "pine" ? 0.35 * rand() : -0.1 - 0.3 * rand()) + (rand() - 0.5) * 0.35
      const dir = norm([Math.cos(yaw), droop, Math.sin(yaw)])
      const L = Math.max(sapling ? 0.15 : 0.4, len * (minor ? 0.45 + 0.25 * rand() : 0.7 + 0.45 * rand()))
      if (near && !sapling && !minor && (sp === "pine" || L > 1.6)) limb(opaque, a, dir, L * 0.9, Math.min(t.r * 0.22, 0.03 + L * 0.025), barkLayer(t), y / t.h, 4)
      const step = sapling ? 0.3 : sp === "pine" ? 0.55 : 0.42
      const cards = near ? Math.max(1, Math.round(L / step)) : 1 + (L > 2 ? 1 : 0)
      for (let k = 0; k < cards; k++) {
        const along = near ? (sp === "pine" ? 0.4 : 0.15) + (k + rand() * 0.6) / cards * (sp === "pine" ? 0.6 : 0.8) : 0.12 + k * 0.4
        const size = (sapling ? 0.5 : near ? (sp === "pine" ? 1.05 : 0.95) * (0.8 + 0.4 * rand()) : L * 0.75 + 0.6)
        const p = [a[0] + dir[0]! * L * along, a[1] + dir[1]! * L * along - along * along * L * 0.1, a[2] + dir[2]! * L * along]
        const crownN = norm([p[0]! - a[0], 0.55 + f * 0.4, p[2]! - a[2]])
        const outer = Math.min(1, along * 0.7 + 0.3)
        const rect = sprays[Math.floor(rand() * sprays.length)]!
        const flip = rand() < 0.5
        // Two crossed cards per spray, the first nearly flat, the second rolled up: volume from every side.
        const sway = (rand() - 0.5) * 0.5
        const d2 = norm([dir[0]! * Math.cos(sway) - dir[2]! * Math.sin(sway), dir[1]!, dir[0]! * Math.sin(sway) + dir[2]! * Math.cos(sway)])
        for (const roll of [0.25 + (rand() - 0.5) * 0.6, 1.3 + (rand() - 0.5) * 0.5]) {
          card(masked, p, d2, roll, size, rect, flip, crownN, [outer, y / t.h, along, 0], layer)
        }
      }
    }
  }
  // A leader spire on spruce and birch tops.
  if (sp !== "pine") {
    const a = axisAt(t, base, t.h - (sapling ? 0.4 : 1.2), 0)
    for (const roll of [0, Math.PI / 2]) card(masked, a, [0, 1, 0], roll, sapling ? 0.6 : 1.4, FIR_SPRAYS[0]!, false, [0, 1, 0], [1, 1, 0.5, 0], layer)
  }
}

/** One needle-spray card: stem at `p`, long axis along `dir`, rolled about it by `roll` (rad). */
function card(w: VertexWriter, p: readonly number[], dir: readonly number[], roll: number, size: number, rect: readonly number[], flip: boolean, normal: readonly number[], c: readonly number[], layer: number) {
  const up = Math.abs(dir[1]!) > 0.95 ? [1, 0, 0] : [0, 1, 0]
  const side0 = norm(cross(dir, up)), up0 = cross(side0, dir)
  const side = side0.map((v, i) => v * Math.cos(roll) + up0[i]! * Math.sin(roll))
  const [u0, v0, u1, v1] = rect as [number, number, number, number]
  const aspect = (u1 - u0) / (v1 - v0)
  const half = size * aspect * 0.5
  const corners = [[-1, 0], [1, 0], [1, 1], [-1, 1]] as const
  const verts = corners.map(([s, f]) => {
    const tipDrop = f * f * size * 0.08
    return {
      p: [p[0]! + side[0]! * s * half + dir[0]! * f * size, p[1]! + side[1]! * s * half + dir[1]! * f * size - tipDrop, p[2]! + side[2]! * s * half + dir[2]! * f * size],
      uv: [flip ? u1 - (s + 1) * 0.5 * (u1 - u0) : u0 + (s + 1) * 0.5 * (u1 - u0), v1 - f * (v1 - v0)],
      c: [c[0]!, c[1]!, Math.min(1, c[2]! + f * 0.3), f] as RGBA,
    }
  })
  for (const idx of [0, 1, 2, 0, 2, 3]) {
    const v = verts[idx]!
    w.vert(v.p[0]!, v.p[1]!, v.p[2]!, normal[0]!, normal[1]!, normal[2]!, v.c, MAT.needles, layer, v.uv[0]!, v.uv[1]!)
  }
}

// ------------------------------------------------------------------ floor

function terrain(w: VertexWriter, world: ForestWorld, x0: number, z0: number, step: number) {
  const H = world.height
  const n = Math.round(CHUNK / step)
  const lake = world.lake
  const weights = (x: number, z: number): RGBA => {
    const moss = smooth(0.1, 0.65, smoothNoise(world.seed + 31, x / 7, z / 7) * 0.6 + smoothNoise(world.seed + 32, x / 2.3, z / 2.3) * 0.25 + hollowness(world, x, z) * 0.6)
    let trail = 0
    for (const p of world.paths ?? []) trail = Math.max(trail, smooth(p.width * 0.5 + 0.6, p.width * 0.25, segDist(p.points, x, z) + smoothNoise(world.seed + 33, x / 1.7, z / 1.7) * 0.35))
    const camp = world.camp ? Math.max(...world.camp.buildings.map(b => smooth(Math.max(b.w, b.d) * 0.9 + 4, Math.max(b.w, b.d) * 0.5, Math.hypot(x - b.x, z - b.z)))) * 0.75 : 0
    const mud = lake ? smooth(lake.level + 0.9, lake.level + 0.1, H(x, z)) : 0
    return [moss * (1 - trail), Math.max(trail, camp), mud, 0]
  }
  const P = (i: number, j: number) => {
    const x = x0 + i * step, z = z0 + j * step, y = H(x, z)
    const e = 0.5
    const nx = H(x - e, z) - H(x + e, z), nz = H(x, z - e) - H(x, z + e)
    return { p: [x, y, z], n: [nx, 2 * e, nz], c: weights(x, z) }
  }
  const grid: ReturnType<typeof P>[] = []
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) grid.push(P(i, j))
  const at = (i: number, j: number) => grid[j * (n + 1) + i]!
  const emit = (v: ReturnType<typeof P>, dy = 0) => w.vert(v.p[0]!, v.p[1]! + dy, v.p[2]!, v.n[0]!, v.n[1]!, v.n[2]!, v.c, MAT.terrain, LAYER["ground-needles"], 0, 0)
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1)
    for (const v of [a, d, c, a, c, b]) emit(v)
  }
  // Skirts hide cracks where a near chunk meets a far one.
  const skirt = (a: ReturnType<typeof P>, b: ReturnType<typeof P>) => { emit(a); emit(b); emit(b, -1.2); emit(a); emit(b, -1.2); emit(a, -1.2) }
  for (let i = 0; i < n; i++) { skirt(at(i, 0), at(i + 1, 0)); skirt(at(i + 1, n), at(i, n)); skirt(at(0, i + 1), at(0, i)); skirt(at(n, i), at(n, i + 1)) }
}

/** Places a model part: scale, yaw about +y, translate; per-vertex colour from its model-space position. */
function placeModel(w: VertexWriter, part: ModelPart, x: number, y: number, z: number, yaw: number, s: readonly number[], mat: number, aux: number, color: (p: readonly number[]) => RGBA, decimate = 1) {
  const view = new DataView(part.vertices)
  const count = part.vertices.byteLength / 32
  const c = Math.cos(yaw), sn = Math.sin(yaw)
  for (let t = 0; t < count; t += 3) {
    if (decimate > 1 && (t / 3) % decimate) continue
    for (let k = 0; k < 3; k++) {
      const v = readVertex(view, t + k)
      const px = v.p[0] * s[0]!, py = v.p[1] * s[1]!, pz = v.p[2] * s[2]!
      const nx = v.n[0] / s[0]!, ny = v.n[1] / s[1]!, nz = v.n[2] / s[2]!
      w.vert(x + px * c - pz * sn, y + py, z + px * sn + pz * c, nx * c - nz * sn, ny, nx * sn + nz * c, color(v.p), mat, aux, v.uv[0], v.uv[1])
    }
  }
}

function logMesh(w: VertexWriter, x: number, y: number, z: number, yaw: number, length: number, r: number, seed: number, sides: number, ground?: (x: number, z: number) => number) {
  const ca = Math.cos(yaw), sa = Math.sin(yaw)
  const rand = mulberry(seed)
  const segs = Math.max(3, Math.round(length / (sides > 6 ? 0.6 : 1.5)))
  const layer = (rand() < 0.5 ? LAYER["bark-mossy"] : LAYER["bark-spruce"]) + 0.5
  const reps = Math.max(1, Math.round((TAU * r) / BARK_TILE))
  // A fallen trunk: tapering from the butt, bowed sideways, out of round, settled into the ground along its length
  // (rot lets it follow the terrain), with splintered ends rather than sawn ones.
  const butt = rand() < 0.5 ? -1 : 1
  const bow = (rand() - 0.5) * 0.06 * length, oval = 0.85 + rand() * 0.1, twist = rand() * TAU
  const centre = (f: number) => {
    const along = (f - 0.5) * length, side = Math.sin(f * Math.PI) * bow
    const px = x + ca * along - sa * side, pz = z + sa * along + ca * side
    const taper = 1 - 0.38 * (butt > 0 ? 1 - f : f)
    const rr = r * 1.12 * taper
    const settled = ground ? Math.min(y, ground(px, pz) + rr * 0.55) * 0.7 + y * 0.3 : y - Math.sin(f * Math.PI) * 0.06
    return { p: [px, settled, pz], r: rr }
  }
  const rings = Array.from({ length: segs + 1 }, (_, k) => centre(k / segs))
  // Splinters: the end rings pinch in unevenly over the last few centimetres.
  const endPinch = (f: number, th: number) => {
    const e = Math.min(f, 1 - f) * length
    if (e > 0.25) return 1
    const jag = 0.55 + 0.45 * Math.abs(Math.sin(th * 3 + seed)) * (0.6 + 0.4 * Math.sin(th * 7 + seed * 3))
    return 1 - (1 - jag) * (1 - e / 0.25)
  }
  const vertex = (k: number, i: number) => {
    const f = k / segs, ring = rings[k]!, th = (i / sides) * TAU + twist
    const lobe = 1 + 0.06 * Math.cos(3 * th + f * 4 + seed) + 0.03 * Math.cos(7 * th)
    const rr = ring.r * lobe * endPinch(f, th)
    const ly = Math.sin(th) * rr * oval, lw = Math.cos(th) * rr
    const along = (f - 0.5) * length
    return { p: [ring.p[0]! - sa * lw, ring.p[1]! + ly, ring.p[2]! + ca * lw], n: [-sa * Math.cos(th), Math.sin(th) / oval, ca * Math.cos(th)], uv: [(i / sides) * reps, -along / BARK_TILE] }
  }
  for (let k = 0; k < segs; k++) for (let i = 0; i < sides; i++) {
    const q = [vertex(k, i), vertex(k, i + 1), vertex(k + 1, i + 1), vertex(k + 1, i)]
    for (const idx of [0, 2, 1, 0, 3, 2]) {
      const v = q[idx]!
      w.vert(v.p[0]!, v.p[1]!, v.p[2]!, v.n[0]!, v.n[1]!, v.n[2]!, [0.9, 0, 0, 0], MAT.bark, layer, v.uv[0]!, v.uv[1]!)
    }
  }
  // Broken ends: a recessed, uneven cut of the stump scan's end grain inside the splinters.
  for (const end of [-1, 1]) {
    const k = end < 0 ? 0 : segs, ring = rings[k]!
    const inset = 0.08 * end
    const cx = ring.p[0]! - ca * inset, cy = ring.p[1]!, cz = ring.p[2]! - sa * inset
    for (let i = 0; i < sides; i++) {
      const pts = [0, i, i + 1].map((ii, j) => {
        if (!j) return { p: [cx, cy, cz], uv: [0.5, 0.5] }
        const v = vertex(k, ii), th = (ii / sides) * TAU
        return { p: [v.p[0]! - ca * inset * 0.5, v.p[1]!, v.p[2]! - sa * inset * 0.5], uv: [0.5 + Math.cos(th) * 0.3, 0.5 + Math.sin(th) * 0.3] }
      })
      for (const v of end < 0 ? pts : [pts[0]!, pts[2]!, pts[1]!]) w.vert(v.p[0]!, v.p[1]!, v.p[2]!, ca * end, 0, sa * end, [0.3, 0, 0, 0], MAT.prop, LAYER.stump, v.uv[0]!, v.uv[1]!)
    }
  }
  // Branch stubs: snapped limbs along the upper half, the lower ones pushed into the ground.
  if (sides > 6) {
    const stubs = Math.floor(length / 1.6)
    for (let i = 0; i < stubs; i++) {
      const f = 0.15 + rand() * 0.7, ring = centre(f)
      const th = (rand() - 0.5) * 2.2 + Math.PI / 2
      const out = [-sa * Math.cos(th), Math.sin(th), ca * Math.cos(th)]
      const from = [ring.p[0]! + out[0]! * ring.r * 0.8, ring.p[1]! + out[1]! * ring.r * 0.8, ring.p[2]! + out[2]! * ring.r * 0.8]
      limb(w, from, [out[0]! + ca * 0.4 * butt, out[1]!, out[2]! + sa * 0.4 * butt], 0.15 + rand() * 0.45, Math.max(0.02, ring.r * 0.18), Math.floor(layer), 0, 4)
    }
  }
}

function tape(w: VertexWriter, x: number, y: number, z: number, r: number, yaw: number) {
  const sides = 10, rr = r * 1.6 + 0.02, h = 0.035
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * TAU, a1 = ((i + 1) / sides) * TAU
    const p = (a: number, dy: number) => [x + Math.cos(a) * rr, y + dy, z + Math.sin(a) * rr]
    const q = [p(a0, 0), p(a1, 0), p(a1, h), p(a0, h)]
    for (const idx of [0, 1, 2, 0, 2, 3]) { const v = q[idx]!; const a = idx === 1 || idx === 2 ? a1 : a0; w.vert(v[0]!, v[1]!, v[2]!, Math.cos(a), 0, Math.sin(a), [1, 0.35, 0.05, 0], MAT.tape, 0, 0, 0) }
  }
  // Two loose tails that hang and flutter.
  for (const off of [-0.12, 0.12]) {
    const a = yaw + off, px = x + Math.cos(a) * rr, pz = z + Math.sin(a) * rr
    const q = [[px, y, pz], [px + Math.cos(a) * 0.04, y, pz + Math.sin(a) * 0.04], [px + Math.cos(a) * 0.08, y - 0.38, pz + Math.sin(a) * 0.08], [px + Math.cos(a) * 0.04, y - 0.4, pz + Math.sin(a) * 0.04]]
    for (const idx of [0, 1, 2, 0, 2, 3]) { const v = q[idx]!; w.vert(v[0]!, v[1]!, v[2]!, -Math.sin(a), 0, Math.cos(a), [1, 0.35, 0.05, idx >= 2 ? 1 : 0], MAT.tape, 0.5, 0, 0) }
  }
}

// ------------------------------------------------------------------ camp

function box(w: VertexWriter, cx: number, cy: number, cz: number, yaw: number, sx: number, sy: number, sz: number, mat: number, layer: number, tile = 1.2, color: RGBA = [0, 0, 0, 0]) {
  const c = Math.cos(yaw), s = Math.sin(yaw)
  const P = (x: number, y: number, z: number) => [cx + x * c - z * s, cy + y, cz + x * s + z * c]
  const N = (x: number, y: number, z: number) => [x * c - z * s, y, x * s + z * c]
  const faces: [number[], number[], number[], number[], number[], number, number][] = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0], [sx, sy, sz], [0, 0, 0], sz, sy], [[-1, 0, 0], [0, 0, 1], [0, 1, 0], [sx, sy, sz], [0, 0, 0], sz, sy],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0], [sx, sy, sz], [0, 0, 0], sx, sy], [[0, 0, -1], [-1, 0, 0], [0, 1, 0], [sx, sy, sz], [0, 0, 0], sx, sy],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1], [sx, sy, sz], [0, 0, 0], sx, sz], [[0, -1, 0], [1, 0, 0], [0, 0, 1], [sx, sy, sz], [0, 0, 0], sx, sz],
  ]
  for (const [n, u, v, size, , du, dv] of faces) {
    const hx = size[0]! / 2, hy = size[1]! / 2, hz = size[2]! / 2
    const corner = (a: number, b: number) => {
      const lx = n[0]! * hx + u[0]! * a * (du / 2) + v[0]! * b * (dv / 2)
      const ly = n[1]! * hy + u[1]! * a * (du / 2) + v[1]! * b * (dv / 2)
      const lz = n[2]! * hz + u[2]! * a * (du / 2) + v[2]! * b * (dv / 2)
      return { p: P(lx, ly, lz), uv: [(a * du / 2) / tile, -(b * dv / 2) / tile] }
    }
    const q = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]
    const nn = N(n[0]!, n[1]!, n[2]!)
    for (const idx of [0, 2, 1, 0, 3, 2]) { const vv = q[idx]!; w.vert(vv.p[0]!, vv.p[1]!, vv.p[2]!, nn[0]!, nn[1]!, nn[2]!, color, mat, layer, vv.uv[0]!, vv.uv[1]!) }
  }
}

function quad(w: VertexWriter, a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[], n: readonly number[], mat: number, aux: number, uv: readonly number[][], color: RGBA = [0, 0, 0, 0]) {
  const q = [a, b, c, d]
  for (const idx of [0, 1, 2, 0, 2, 3]) { const v = q[idx]!; w.vert(v[0]!, v[1]!, v[2]!, n[0]!, n[1]!, n[2]!, color, mat, aux, uv[idx]![0]!, uv[idx]![1]!) }
}

function camp(world: ForestWorld, chunks: Chunks, models: ForestModels, lights: CampLight[], table: (x: number, y: number, z: number, yaw: number) => void) {
  const H = world.height
  const cp = world.camp!
  const rand = mulberry(world.seed + 404)
  const warm: Vec3 = [1, 0.62, 0.3]
  for (const b of cp.buildings) {
    const ch = chunks.at(b.x, b.z)
    const w = ch.near[0], f = ch.far[0]
    const ground = Math.min(H(b.x - b.w / 2, b.z - b.d / 2), H(b.x + b.w / 2, b.z - b.d / 2), H(b.x - b.w / 2, b.z + b.d / 2), H(b.x + b.w / 2, b.z + b.d / 2))
    const floor = ground + 0.45
    const c = Math.cos(b.yaw), s = Math.sin(b.yaw)
    const L = (x: number, y: number, z: number) => [b.x + x * c - z * s, y, b.z + x * s + z * c]
    for (const target of [w, f]) {
      // Walls (thin boxes) leave a gap where every window goes; roof is a gable of two slabs.
      box(target, b.x, floor + b.h / 2, b.z, b.yaw, b.w, b.h, b.d, MAT.wood, LAYER.planks, 1.6)
      box(target, b.x, ground + 0.22, b.z, b.yaw, b.w + 0.2, 0.45, b.d + 0.2, MAT.prop, LAYER["rock-lichen"], 1.5)
      const pitch = 0.5, run = b.d / 2 + 0.5, rise = Math.tan(pitch) * run
      for (const side of [-1, 1]) {
        const slab = Math.hypot(run, rise)
        const mid = L(0, floor + b.h + rise / 2, side * run / 2)
        roofSlab(target, mid, b.yaw, b.w + 0.9, slab, side * pitch)
      }
      // Gable ends.
      for (const end of [-1, 1]) {
        const a = L(end * b.w / 2, floor + b.h, -b.d / 2), bb = L(end * b.w / 2, floor + b.h, b.d / 2), top = L(end * b.w / 2, floor + b.h + rise * (b.d / 2) / run, 0)
        const n = [end * c, 0, end * s]
        for (const v of end > 0 ? [a, top, bb] : [a, bb, top]) target.vert(v[0]!, v[1]!, v[2]!, n[0]!, n[1]!, n[2]!, [0, 0, 0, 0], MAT.wood, LAYER.planks, (v === a ? -b.d / 2 : v === bb ? b.d / 2 : 0) / 1.6, -(v[1]! - floor) / 1.6)
      }
    }
    if (b.porch) {
      const pd = 2.6
      box(w, ...(L(0, floor - 0.08, b.d / 2 + pd / 2) as [number, number, number]), b.yaw, b.w * 0.8, 0.16, pd, MAT.wood, LAYER.planks, 1.2, [0, 0, 0.3, 0])
      for (const px of [-0.4, -0.13, 0.13, 0.4]) box(w, ...(L(px * b.w, floor + 1.25, b.d / 2 + pd - 0.1) as [number, number, number]), b.yaw, 0.14, 2.5, 0.14, MAT.wood, LAYER.planks, 1)
      const p = L(0, floor + 2.55, b.d / 2 + pd / 2)
      roofSlab(w, p, b.yaw, b.w * 0.85, pd + 0.4, 0.18)
      // Porch lamp.
      const lamp = L(0, floor + 2.25, b.d / 2 + 0.25)
      bulb(w, lamp[0]!, lamp[1]!, lamp[2]!, 0.07, 3)
      lights.push({ x: lamp[0]!, y: lamp[1]!, z: lamp[2]!, axis: [0, -1, 0], color: [1, 0.68, 0.38], power: 2.4, range: 9, cosOuter: Math.cos(1.25), kind: "porch" })
    }
    // Windows on both long walls; the lit ones glow and throw a pool outside.
    const count = Math.max(1, Math.round(b.w / 3.2))
    for (const side of [-1, 1]) for (let i = 0; i < count; i++) {
      const wx = (i + 0.5) / count * b.w - b.w / 2
      if (b.porch && side > 0 && Math.abs(wx) < 1) continue
      const lit = rand() < b.lit ? 0.6 + 0.4 * rand() : 0
      const ww = b.kind === "mess-hall" ? 1.4 : 0.9, wh = b.kind === "mess-hall" ? 1.3 : 0.9
      const wy = floor + b.h * 0.55
      const zz = side * (b.d / 2 + 0.03)
      const n = [-s * side, 0, c * side]
      const corners = [[wx - ww / 2, wy - wh / 2], [wx + ww / 2, wy - wh / 2], [wx + ww / 2, wy + wh / 2], [wx - ww / 2, wy + wh / 2]].map(([x, y]) => L(x!, y!, zz))
      const ordered = side > 0 ? corners : [corners[1]!, corners[0]!, corners[3]!, corners[2]!]
      quad(w, ordered[0]!, ordered[1]!, ordered[2]!, ordered[3]!, n, MAT.glow, lit + rand() * 0.09, [[0, 1], [1, 1], [1, 0], [0, 0]])
      quad(f, ordered[0]!, ordered[1]!, ordered[2]!, ordered[3]!, n, MAT.glow, lit, [[0, 1], [1, 1], [1, 0], [0, 0]])
      // Frame.
      for (const [fx, fy, sx, sy] of [[wx, wy - wh / 2 - 0.05, ww + 0.2, 0.1], [wx, wy + wh / 2 + 0.05, ww + 0.2, 0.1], [wx - ww / 2 - 0.05, wy, 0.1, wh], [wx + ww / 2 + 0.05, wy, 0.1, wh]] as const) {
        const p = L(fx, fy, side * (b.d / 2 + 0.05))
        box(w, p[0]!, p[1]!, p[2]!, b.yaw, side > 0 ? sx : sx, sy, 0.08, MAT.wood, LAYER.planks, 0.8, [0, 0, 0.1, 0])
      }
      if (lit > 0) {
        const p = L(wx, wy, zz + side * 0.25)
        lights.push({ x: p[0]!, y: p[1]!, z: p[2]!, axis: [n[0]!, -0.35, n[2]!], color: warm, power: lit * (b.kind === "mess-hall" ? 2.6 : 1.4), range: 11, cosOuter: Math.cos(1.2), kind: "window" })
      }
    }
    chunks.extend(b.x, b.z, ground, floor + b.h + 3)
  }
  // Dock: boards with gaps on posts.
  if (cp.dock) {
    const d = cp.dock
    const ch = chunks.at(d.x, d.z)
    const level = (world.lake?.level ?? 0) + 0.45
    const boards = Math.floor(d.length / 0.17)
    for (let i = 0; i < boards; i++) {
      const along = i * 0.17 + 0.08
      const cx = d.x + Math.sin(d.yaw) * along, cz = d.z + Math.cos(d.yaw) * along
      box(ch.near[0], cx, level + (rand() - 0.5) * 0.012, cz, -d.yaw + Math.PI / 2 + (rand() - 0.5) * 0.02, 0.15, 0.04, d.width, MAT.wood, LAYER.planks, 0.9, [0, 0, 0.75, 0])
    }
    for (let i = 0; i <= Math.floor(d.length / 2.2); i++) for (const side of [-1, 1]) {
      const along = i * 2.2 + 0.2
      const cx = d.x + Math.sin(d.yaw) * along + Math.cos(d.yaw) * side * d.width * 0.45, cz = d.z + Math.cos(d.yaw) * along - Math.sin(d.yaw) * side * d.width * 0.45
      box(ch.near[0], cx, level - 1, cz, d.yaw, 0.16, 2, 0.16, MAT.wood, LAYER.log, 0.6, [0, 0, 1, 0])
    }
    box(ch.near[0], d.x + Math.sin(d.yaw) * d.length / 2, level - 0.12, d.z + Math.cos(d.yaw) * d.length / 2, -d.yaw, 0.16, 0.18, d.length, MAT.wood, LAYER.log, 0.8, [0, 0, 0.6, 0])
    chunks.extend(d.x, d.z, level - 2, level + 1)
  }
  // String lights: sagging wire with bulbs; every few bulbs share one light.
  for (const sl of cp.stringLights ?? []) {
    const pts = sl.points
    const ch = chunks.at(pts[0]![0], pts[0]![2])
    const sample = (f: number): Vec3 => {
      const seg = Math.min(pts.length - 2, Math.floor(f * (pts.length - 1)))
      const t = f * (pts.length - 1) - seg
      const a = pts[seg]!, b = pts[seg + 1]!
      const sag = Math.sin(t * Math.PI) * 0.45
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag, a[2] + (b[2] - a[2]) * t]
    }
    const steps = 60
    for (let i = 0; i < steps; i++) {
      const a = sample(i / steps), b = sample((i + 1) / steps)
      wire(ch.near[0], a, b, 0.006)
    }
    for (let i = 0; i < sl.bulbs; i++) {
      const p = sample((i + 0.5) / sl.bulbs)
      bulb(ch.near[0], p[0], p[1] - 0.06, p[2], 0.035, 1.6 + rand() * 0.5)
      if (i % 3 === 1) lights.push({ x: p[0], y: p[1] - 0.06, z: p[2], axis: [0, -1, 0], color: [1, 0.7, 0.4], power: 0.55, range: 7, cosOuter: -1, kind: "bulb" })
    }
    for (const p of pts) {
      const g = H(p[0], p[2])
      if (p[1] - g > 2) box(ch.near[0], p[0], (p[1] + g) / 2, p[2], 0, 0.12, p[1] - g + 0.2, 0.12, MAT.wood, LAYER.log, 0.6)
    }
  }
  // Props.
  for (const p of cp.props ?? []) {
    const ch = chunks.at(p.x, p.z)
    const y = H(p.x, p.z)
    if (p.kind === "picnic-table") table(p.x, y, p.z, p.yaw)
    else if (p.kind === "fire-pit") {
      const stones = models["rocks-b"]
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * TAU, part = stones[i % stones.length]!
        const ext = Math.max(part.max[0]! - part.min[0]!, part.max[2]! - part.min[2]!)
        const sc = 0.32 / ext
        placeModel(ch.near[0], part, p.x + Math.cos(a) * 0.75, y - part.min[1]! * sc - 0.05, p.z + Math.sin(a) * 0.75, a, [sc, sc, sc], MAT.prop, LAYER["rocks-b"], () => [0.1, 0, 0, 0])
      }
      for (let i = 0; i < 4; i++) {
        const a = rand() * TAU
        logMesh(ch.near[0], p.x + Math.cos(a) * 0.15, y + 0.06, p.z + Math.sin(a) * 0.15, a, 0.7, 0.05, Math.floor(rand() * 1e6), 6)
      }
    } else if (p.kind === "flagpole") {
      box(ch.near[0], p.x, y + 4, p.z, 0, 0.09, 8, 0.09, MAT.paint, 0, 1, [0.6, 0.6, 0.62, 0.4])
    } else if (p.kind === "canoe") {
      canoe(ch.near[0], p.x, y + 0.02, p.z, p.yaw, rand() < 0.5 ? [0.45, 0.07, 0.05, 0.5] : [0.08, 0.22, 0.12, 0.5])
    } else if (p.kind === "bench") {
      box(ch.near[0], p.x, y + 0.45, p.z, p.yaw, 1.8, 0.06, 0.35, MAT.wood, LAYER.planks, 1)
      for (const e of [-0.75, 0.75]) box(ch.near[0], p.x + Math.cos(p.yaw) * e, y + 0.22, p.z + Math.sin(p.yaw) * e, p.yaw, 0.08, 0.44, 0.35, MAT.wood, LAYER.planks, 1)
    }
  }
}

function roofSlab(w: VertexWriter, mid: readonly number[], yaw: number, width: number, depth: number, pitch: number) {
  const c = Math.cos(yaw), s = Math.sin(yaw)
  const cp = Math.cos(pitch), sp = Math.sin(pitch)
  // Local slab axes: x along the ridge, z down the slope.
  const ax = [c, 0, s], az = [-s * cp, -sp, c * cp]
  const n = norm(cross(az, ax)).map(v => v * (pitch >= 0 ? 1 : 1))
  const nUp = n[1]! < 0 ? n.map(v => -v) : n
  const corner = (u: number, v: number) => [mid[0]! + ax[0]! * u * width / 2 + az[0]! * v * depth / 2, mid[1]! + az[1]! * v * depth / 2 + 0.02, mid[2]! + ax[2]! * u * width / 2 + az[2]! * v * depth / 2]
  const q = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]
  const uv = [[-width / 2 / 2, -depth / 2 / 2], [width / 2 / 2, -depth / 2 / 2], [width / 2 / 2, depth / 2 / 2], [-width / 2 / 2, depth / 2 / 2]]
  for (const flip of [false, true]) {
    const order = flip ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3]
    for (const idx of order) { const v = q[idx]!; const nn = flip ? nUp.map(x => -x) : nUp; w.vert(v[0]!, v[1]! - (flip ? 0.08 : 0), v[2]!, nn[0]!, nn[1]!, nn[2]!, [0, 0, 0, 0], MAT.wood, flip ? LAYER.planks : LAYER.roof, uv[idx]![0]!, uv[idx]![1]!) }
  }
}

function wire(w: VertexWriter, a: Vec3, b: Vec3, r: number) {
  const d = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]])
  const side = norm(cross(d, [0, 1, 0])), up = cross(side, d)
  for (const axis of [side, up]) {
    const q = [[a[0] - axis[0]! * r, a[1] - axis[1]! * r, a[2] - axis[2]! * r], [b[0] - axis[0]! * r, b[1] - axis[1]! * r, b[2] - axis[2]! * r], [b[0] + axis[0]! * r, b[1] + axis[1]! * r, b[2] + axis[2]! * r], [a[0] + axis[0]! * r, a[1] + axis[1]! * r, a[2] + axis[2]! * r]]
    const n = axis === side ? up : side
    quad(w, q[0]!, q[1]!, q[2]!, q[3]!, n, MAT.paint, 0, [[0, 0], [1, 0], [1, 1], [0, 1]], [0.02, 0.02, 0.02, 0.6])
  }
}

function bulb(w: VertexWriter, x: number, y: number, z: number, r: number, glow: number) {
  const lat = 4, lon = 6
  for (let i = 0; i < lat; i++) for (let j = 0; j < lon; j++) {
    const p = (ii: number, jj: number) => { const th = (ii / lat) * Math.PI, ph = (jj / lon) * TAU; return [Math.sin(th) * Math.cos(ph), Math.cos(th) * 1.25, Math.sin(th) * Math.sin(ph)] }
    const q = [p(i, j), p(i + 1, j), p(i + 1, j + 1), p(i, j + 1)]
    for (const idx of [0, 1, 2, 0, 2, 3]) { const v = q[idx]!; w.vert(x + v[0]! * r, y + v[1]! * r, z + v[2]! * r, v[0]!, v[1]!, v[2]!, [1, 0.7, 0.4, 0], MAT.bulb, glow, 0, 0) }
  }
}

function canoe(w: VertexWriter, x: number, y: number, z: number, yaw: number, color: RGBA) {
  const len = 4.8, beam = 0.42, depth = 0.34, n = 16, m = 6
  const c = Math.cos(yaw), s = Math.sin(yaw)
  const P = (u: number, v: number) => {
    // u along the hull −1..1, v round the section 0 (gunwale) .. 1 (keel) .. 2 (other gunwale); upside down on the bank.
    const width = beam * Math.sqrt(Math.max(0, 1 - u * u)) * 1.02
    const th = (v / 2) * Math.PI
    const lx = u * len / 2, lz = -Math.cos(th) * width, ly = depth * Math.sin(th) * (0.6 + 0.4 * (1 - u * u)) + u * u * 0.18
    return [x + lx * c - lz * s, y + ly, z + lx * s + lz * c]
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
    const u0 = -1 + (2 * i) / n, u1 = -1 + (2 * (i + 1)) / n, v0 = (2 * j) / m, v1 = (2 * (j + 1)) / m
    const q = [P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)]
    const nrm = norm(cross([q[1]![0]! - q[0]![0]!, q[1]![1]! - q[0]![1]!, q[1]![2]! - q[0]![2]!], [q[3]![0]! - q[0]![0]!, q[3]![1]! - q[0]![1]!, q[3]![2]! - q[0]![2]!]))
    quad(w, q[0]!, q[1]!, q[2]!, q[3]!, nrm[1]! < 0 ? nrm.map(v => -v) : nrm, MAT.paint, 0, [[0, 0], [1, 0], [1, 1], [0, 1]], color)
  }
}

export type { Vec2 }
