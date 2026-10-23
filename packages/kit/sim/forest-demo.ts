import type { CampBuilding, CampProp, CampStringLight, ForestClearing, ForestFlag, ForestLog, ForestPath, ForestRock, ForestTree, ForestWorld, TreeSpecies, Vec2, Vec3 } from "./forest-world"

/**
 * A seeded stand-in level for the forest renderer: old-growth pine and spruce with birch at the edges, clustered with
 * clearings and deadfall, gentle terrain with hollows, a lake and the summer camp on its south shore. Pure, so a
 * game's sim can walk it until it has its own level. Densities follow RESEARCH.md (200–450 trees/ha, deadfall near
 * snags, ferns derived by the renderer).
 */
export function demoForestWorld(seed = 7, half = 110): ForestWorld {
  const rand = mulberry(seed)
  const lake = { x: 38, z: 58, rx: 40, rz: 24, level: 1.2 }
  const camp = { x: 20, z: 12 }
  const paths: ForestPath[] = [
    { width: 1.6, points: [[-70, -78], [-52, -60], [-38, -50], [-30, -30], [-12, -18], [2, -6], [12, 8], [20, 16]] },
    { width: 1.3, points: [[20, 16], [36, 14], [50, 22], [62, 30], [78, 44]] },
    { width: 1.1, points: [[-30, -30], [-46, -14], [-58, 6], [-54, 30], [-40, 46]] },
  ]
  const clearings: ForestClearing[] = [
    { x: -38, z: -48, r: 9 }, { x: -56, z: 10, r: 7 }, { x: 4, z: -40, r: 6 }, { x: camp.x, z: camp.z, r: 26 },
  ]
  const lakeD = (x: number, z: number) => Math.hypot((x - lake.x) / lake.rx, (z - lake.z) / lake.rz)
  const height = (x: number, z: number) => {
    let h = 3 + 1.6 * smoothNoise(seed, x / 46, z / 46) + 0.7 * smoothNoise(seed + 1, x / 17, z / 17) + 0.2 * smoothNoise(seed + 2, x / 6, z / 6)
    // Hollows that hold the mist.
    for (const [hx, hz, r, d] of HOLLOWS) h -= d * Math.exp(-((x - hx) ** 2 + (z - hz) ** 2) / (r * r))
    // Camp terrace: the ground levels out where the buildings stand.
    const c = Math.exp(-((x - camp.x) ** 2 + (z - camp.z) ** 2) / (24 * 24))
    h = h * (1 - c * 0.8) + 2.6 * c * 0.8
    // Lake basin: the shore shelves down under the water.
    const ld = lakeD(x, z)
    const basin = 1 - smoothstep(0.75, 1.25, ld)
    h = h * (1 - basin) + (lake.level - 0.2 - 2.2 * (1 - smoothstep(0, 0.95, ld))) * basin
    return h
  }
  const nearPath = (x: number, z: number, pad: number) => paths.some(p => segDist(p.points, x, z) < p.width * 0.5 + pad)
  const inClearing = (x: number, z: number, pad = 0) => clearings.some(c => Math.hypot(x - c.x, z - c.z) < c.r + pad)

  const buildings: CampBuilding[] = [
    { kind: "mess-hall", x: camp.x, z: camp.z + 8, yaw: 0, w: 16, d: 9, h: 3.4, lit: 0.85, porch: true },
    { kind: "cabin", x: camp.x - 17, z: camp.z + 2, yaw: 0.5, w: 6, d: 5, h: 2.6, lit: 0.5 },
    { kind: "cabin", x: camp.x - 12, z: camp.z - 10, yaw: 0.2, w: 6, d: 5, h: 2.6, lit: 0 },
    { kind: "cabin", x: camp.x + 16, z: camp.z - 6, yaw: -0.35, w: 6, d: 5, h: 2.6, lit: 0.34 },
    { kind: "shed", x: camp.x + 18, z: camp.z + 8, yaw: -0.15, w: 3.5, d: 3, h: 2.2, lit: 0 },
  ]
  const dock = { x: camp.x + 4, z: lake.z - lake.rz * 0.93, yaw: 0.12, length: 14, width: 2 }
  const hallFront = camp.z + 8 + 4.5
  const stringLights: CampStringLight[] = [
    { bulbs: 18, points: [[camp.x - 8, 3.1, hallFront + 0.2], [camp.x - 2, 2.55, hallFront + 6], [dock.x, 2.4, hallFront + 11]] },
    { bulbs: 14, points: [[camp.x + 8, 3.1, hallFront + 0.2], [camp.x + 9, 2.5, hallFront + 7], [dock.x, 2.4, hallFront + 11]] },
  ].map(s => ({ bulbs: s.bulbs, points: s.points.map(([x, y, z]) => [x!, height(x!, z!) + y!, z!] as Vec3) }))
  const props: CampProp[] = [
    { kind: "picnic-table", x: camp.x - 4, z: hallFront + 4, yaw: 0.2 },
    { kind: "picnic-table", x: camp.x + 5, z: hallFront + 5, yaw: -0.4 },
    { kind: "picnic-table", x: camp.x - 9, z: camp.z - 2, yaw: 1.1 },
    { kind: "fire-pit", x: camp.x - 2, z: camp.z - 4, yaw: 0 },
    { kind: "flagpole", x: camp.x + 9, z: camp.z + 1, yaw: 0 },
    { kind: "canoe", x: dock.x - 3.5, z: hallFront + 8.5, yaw: 1.3 },
    { kind: "canoe", x: dock.x - 5.2, z: hallFront + 8.0, yaw: 1.45 },
    { kind: "bench", x: camp.x + 1, z: camp.z - 7, yaw: 0 },
  ]
  const campRect = (x: number, z: number, pad: number) => buildings.some(b => {
    const c = Math.cos(-b.yaw), s = Math.sin(-b.yaw), dx = x - b.x, dz = z - b.z
    return Math.abs(dx * c - dz * s) < b.w / 2 + pad && Math.abs(dx * s + dz * c) < b.d / 2 + pad
  })

  // Trees: a jittered grid thinned by a clustering field, so stands, gaps and edges read instead of an even orchard.
  const trees: ForestTree[] = []
  const cell = 4.6
  for (let gz = -half; gz < half; gz += cell) for (let gx = -half; gx < half; gx += cell) {
    const x = gx + rand() * cell, z = gz + rand() * cell
    const cluster = smoothNoise(seed + 9, x / 22, z / 22) * 0.5 + 0.5
    const keep = 0.25 + 0.95 * cluster
    if (rand() > keep) continue
    if (lakeD(x, z) < 1.08 || inClearing(x, z) || nearPath(x, z, 0.8) || campRect(x, z, 3)) continue
    const edge = Math.min(lakeD(x, z) - 1.08, ...clearings.map(c => (Math.hypot(x - c.x, z - c.z) - c.r) / 10))
    const r0 = rand()
    let species: TreeSpecies
    if (r0 < 0.05) species = "snag"
    else if (edge < 0.4 && r0 < 0.55) species = "birch"
    else if (r0 < 0.12 + 0.2 * (1 - cluster)) species = "birch"
    else species = smoothNoise(seed + 13, x / 35, z / 35) > -0.1 ? "pine" : "spruce"
    const size = 0.75 + 0.5 * rand()
    const dims = { pine: [0.42, 27], spruce: [0.3, 21], birch: [0.14, 15], snag: [0.32, 12] }[species]
    trees.push({ x, z, species, r: dims[0]! * size * (species === "pine" && rand() < 0.2 ? 1.35 : 1), h: dims[1]! * (0.82 + 0.3 * rand()), lean: species === "birch" ? rand() * 0.12 : species === "snag" ? rand() * 0.08 : rand() * 0.03, leanYaw: rand() * Math.PI * 2, seed: Math.floor(rand() * 1e9) })
  }
  // Birch clumps by the water.
  for (let i = 0; i < 26; i++) {
    const a = rand() * Math.PI * 2, d = 1.12 + rand() * 0.25
    const x = lake.x + Math.cos(a) * lake.rx * d, z = lake.z + Math.sin(a) * lake.rz * d
    if (campRect(x, z, 4) || nearPath(x, z, 1) || Math.hypot(x - dock.x, z - dock.z) < 8) continue
    for (let k = 0; k < 3; k++) trees.push({ x: x + (rand() - 0.5) * 1.6, z: z + (rand() - 0.5) * 1.6, species: "birch", r: 0.08 + rand() * 0.07, h: 11 + rand() * 6, lean: 0.05 + rand() * 0.15, leanYaw: a + (rand() - 0.5), seed: Math.floor(rand() * 1e9) })
  }

  const rocks: ForestRock[] = []
  for (let i = 0; i < 70; i++) {
    const cx = (rand() * 2 - 1) * half * 0.92, cz = (rand() * 2 - 1) * half * 0.92
    if (lakeD(cx, cz) < 1.0 || campRect(cx, cz, 4) || nearPath(cx, cz, 1.2)) continue
    const n = 1 + Math.floor(rand() * 4)
    for (let k = 0; k < n; k++) {
      const x = cx + (rand() - 0.5) * 5, z = cz + (rand() - 0.5) * 5, r = k ? 0.3 + rand() * 0.6 : 0.6 + rand() * 1.1
      if (nearPath(x, z, r) || lakeD(x, z) < 1.0) continue
      rocks.push({ x, z, r, h: r * (0.55 + rand() * 0.4), yaw: rand() * Math.PI * 2, seed: Math.floor(rand() * 1e9), moss: 0.4 + rand() * 0.6 })
    }
  }
  // Shore stones.
  for (let i = 0; i < 40; i++) {
    const a = rand() * Math.PI * 2, d = 0.97 + rand() * 0.08
    const x = lake.x + Math.cos(a) * lake.rx * d, z = lake.z + Math.sin(a) * lake.rz * d
    if (Math.hypot(x - dock.x, z - dock.z) < 4) continue
    const r = 0.25 + rand() * 0.6
    rocks.push({ x, z, r, h: r * 0.5, yaw: rand() * 6.28, seed: Math.floor(rand() * 1e9), moss: 0.1 })
  }

  const logs = deriveDeadfall({ seed, half, trees, paths, lake, camp: { buildings } }, 90)

  // Orange flagging tape along the first trail, every 25 m or so, on the nearest trunk.
  const flags: ForestFlag[] = []
  const trail = paths[0]!.points
  for (let i = 0; i < trail.length - 1; i++) {
    const [ax, az] = trail[i]!, [bx, bz] = trail[i + 1]!
    const steps = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / 25))
    for (let k = 0; k < steps; k++) {
      const px = ax + (bx - ax) * (k + 0.5) / steps, pz = az + (bz - az) * (k + 0.5) / steps
      let best: ForestTree | null = null, bd = 8
      for (const t of trees) { const d = Math.hypot(t.x - px, t.z - pz); if (d < bd && t.species !== "snag") { bd = d; best = t } }
      if (best) flags.push({ x: best.x, z: best.z, y: 1.5 + rand() * 0.3, yaw: Math.atan2(pz - best.z, px - best.x), r: best.r })
    }
  }

  return { seed, half, height, trees, rocks, logs, paths, clearings, lake, camp: { buildings, dock, stringLights, props }, flags }
}

/** Mist hollows: (x, z, radius, depth) in metres. */
const HOLLOWS: readonly (readonly [number, number, number, number])[] = [
  [-34, -36, 16, 1.6], [-60, -10, 20, 1.3], [8, -52, 14, 1.4], [-20, 30, 18, 1.2], [70, -20, 22, 1.5], [-80, 60, 18, 1.4],
]

/**
 * Deadfall for a level that has none of its own: `count` tries at fallen trunks, most near snags, never across a path,
 * into the lake or camp, or through a standing trunk. Pure, so a game's sim can collide with the same logs.
 */
export function deriveDeadfall(world: Pick<ForestWorld, "seed" | "half" | "trees" | "paths" | "lake" | "camp">, count: number): ForestLog[] {
  const rand = mulberry(world.seed * 13 + 101)
  const lake = world.lake
  const lakeD = (x: number, z: number) => lake ? Math.hypot((x - lake.x) / lake.rx, (z - lake.z) / lake.rz) : 9
  const campRect = (x: number, z: number, pad: number) => (world.camp?.buildings ?? []).some(b => {
    const c = Math.cos(-b.yaw), s = Math.sin(-b.yaw), dx = x - b.x, dz = z - b.z
    return Math.abs(dx * c - dz * s) < b.w / 2 + pad && Math.abs(dx * s + dz * c) < b.d / 2 + pad
  })
  const grid = new Map<number, ForestTree[]>()
  const key = (x: number, z: number) => (Math.floor(x / 10) + 500) * 1000 + Math.floor(z / 10) + 500
  for (const t of world.trees) { const k = key(t.x, t.z); const l = grid.get(k); if (l) l.push(t); else grid.set(k, [t]) }
  const near = (x: number, z: number) => { const out: ForestTree[] = []; for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) out.push(...(grid.get(key(x + i * 10, z + j * 10)) ?? [])); return out }
  const snags = world.trees.filter(t => t.species === "snag")
  const logs: ForestLog[] = []
  for (let i = 0; i < count; i++) {
    const snag = snags.length && rand() < 0.6 ? snags[Math.floor(rand() * snags.length)]! : null
    const x = snag ? snag.x + (rand() - 0.5) * 8 : (rand() * 2 - 1) * world.half * 0.95
    const z = snag ? snag.z + (rand() - 0.5) * 8 : (rand() * 2 - 1) * world.half * 0.95
    const yaw = rand() * Math.PI, length = 4 + rand() * 10, r = 0.14 + rand() * 0.24
    const ends: Vec2[] = [[x - Math.cos(yaw) * length / 2, z - Math.sin(yaw) * length / 2], [x + Math.cos(yaw) * length / 2, z + Math.sin(yaw) * length / 2]]
    if (ends.some(([ex, ez]) => lakeD(ex, ez) < 1.08 || campRect(ex, ez, 3)) || (world.paths ?? []).some(p => segSegNear(p.points, ends, p.width / 2 + r + 0.6))) continue
    if (near(x, z).some(t => pointSegDist(t.x, t.z, ends[0]!, ends[1]!) < t.r + r + 0.05)) continue
    logs.push({ x, z, yaw, length, r, seed: Math.floor(rand() * 1e9) })
  }
  return logs
}

export function mulberry(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const smoothstep = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
const hash = (s: number, x: number, z: number) => {
  let h = (Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(s, 982451653)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
/** Value noise in −1..1. */
export function smoothNoise(seed: number, x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz)
  const a = hash(seed, ix, iz), b = hash(seed, ix + 1, iz), c = hash(seed, ix, iz + 1), d = hash(seed, ix + 1, iz + 1)
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1
}
function pointSegDist(x: number, z: number, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0], dz = b[1] - a[1], l = dx * dx + dz * dz
  const t = l ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l)) : 0
  return Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t)
}
/** Distance from (x, z) to a polyline. */
export function segDist(points: readonly Vec2[], x: number, z: number): number {
  let d = Infinity
  for (let i = 0; i < points.length - 1; i++) d = Math.min(d, pointSegDist(x, z, points[i]!, points[i + 1]!))
  return d
}
function segSegNear(points: readonly Vec2[], seg: readonly Vec2[], pad: number): boolean {
  for (let k = 0; k <= 8; k++) {
    const t = k / 8, x = seg[0]![0] + (seg[1]![0] - seg[0]![0]) * t, z = seg[0]![1] + (seg[1]![1] - seg[0]![1]) * t
    if (segDist(points, x, z) < pad) return true
  }
  return false
}
