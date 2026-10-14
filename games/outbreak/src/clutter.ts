import { MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import { distToRect, type Rect } from "@arcade/kit/sim/geom"
import { Rng } from "@arcade/kit/sim/rng"
import { frontageEnd, inBuildingFootprint, SIZE, type Town } from "../shared/map"
import { supportHeight } from "../shared/terrain"
import type { GroundSettings } from "./ground"

const rgb = (v: number): Rgb => [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]

/**
 * Authoritative world-space bounding rectangles for large abandoned street vehicles.
 * Positioned along outer street curbs with >= 4.5 m clear lane width so survivor traversal,
 * `bench-outbreak.ts` street runs, `prove.ts` paths, and `GridNav` zombie AI pathing never bottleneck.
 */
export const ABANDONED_VEHICLE_SPECS: readonly {
  x: number
  z: number
  yaw: number
  tint: Rgb
  rect: Rect
}[] = [
  { x: 12.2, z: 46.25, yaw: 0.24, tint: [0.88, 0.72, 0.68], rect: [10.25, 45.25, 14.15, 47.25] },
  { x: 55.4, z: 41.35, yaw: -0.18, tint: [0.72, 0.84, 0.78], rect: [53.45, 40.35, 57.35, 42.35] },
  { x: 46.45, z: 58.5, yaw: 1.42, tint: [0.86, 0.82, 0.70], rect: [45.45, 56.55, 47.45, 60.45] },
  { x: 41.55, z: 17.8, yaw: 1.72, tint: [0.68, 0.74, 0.86], rect: [40.55, 15.85, 42.55, 19.75] },
]

export function abandonedVehicleRects(): Rect[] {
  return ABANDONED_VEHICLE_SPECS.map(v => v.rect)
}

export type ClutterCategory = "rubble" | "clutter"

export type ClutterPlacement = {
  modelIndex: number
  category: ClutterCategory
  x: number
  y: number
  z: number
  yaw: number
  scale: number
  pitch: number
  roll: number
  threshold: number
}

/**
 * Checks whether a candidate exterior clutter point is inside a building or obstructing
 * a primary walk lane, doorway, or window climb path.
 */
export function isExteriorWalkPathBlocked(town: Town, x: number, z: number, radius = 0.35): boolean {
  if (x < 2.5 || x > SIZE - 2.5 || z < 2.5 || z > SIZE - 2.5) return true
  for (const b of town.buildings) {
    if (inBuildingFootprint(b, x, z)) return true
    // Keep building wall interior & immediate wall thickness clear
    if (x >= b.rect[0] - radius && x <= b.rect[2] + radius && z >= b.rect[1] - radius && z <= b.rect[3] + radius) {
      return true
    }
    // Keep the center of the front entrance walkway clear for survivor & zombie navigation
    if (b.kind === "house") {
      const walkCx = b.rect[0] + 5.7
      if (Math.abs(x - walkCx) < 0.48 + radius && z >= b.rect[3] - 0.4 && z <= frontageEnd(b) + 2.2) {
        return true
      }
      // Keep parked driveway sedan footprint clear [bx0-1.68, bz1-1.35]
      if (x > b.rect[0] - 2.75 - radius && x < b.rect[0] - 0.60 + radius && z > b.rect[3] - 3.65 - radius && z < b.rect[3] + 0.95 + radius) {
        return true
      }
      // Keep garden shed footprint clear [bx0-2.85..bx0-1.15, bz0+0.55..bz0+2.25]
      if (x > b.rect[0] - 3.0 - radius && x < b.rect[0] - 1.0 + radius && z > b.rect[1] + 0.4 - radius && z < b.rect[1] + 2.5 + radius) {
        return true
      }
    }
  }
  for (const d of town.doors) {
    if (distToRect(x, z, d.rect) < 1.35 + radius) return true
  }
  for (const w of town.windows) {
    if (distToRect(x, z, w.rect) < 0.90 + radius) return true
  }
  for (const v of ABANDONED_VEHICLE_SPECS) {
    if (distToRect(x, z, v.rect) < 0.25 + radius) return true
  }
  // Keep survivor's exact street-proof pose (30, 41) clear
  if (Math.hypot(x - 30.0, z - 41.0) < 0.85 + radius) return true
  return false
}

/**
 * Computes edge-affinity weight [0..1] for deterministic clutter scattering:
 * High near curbs/gutters, fences, building walls, driveway margins, and tree bases;
 * low in the middle of sidewalks and open lawns.
 */
export function exteriorEdgeAffinity(town: Town, x: number, z: number): number {
  let w = 0.08
  // Curb & gutter zones (z ~ 40, 48 and x ~ 40, 48)
  const dGutterZ = Math.min(Math.abs(z - 40.12), Math.abs(z - 47.88))
  const dGutterX = Math.min(Math.abs(x - 40.12), Math.abs(x - 47.88))
  const dGutter = Math.min(dGutterZ, dGutterX)
  if (dGutter < 1.35) w = Math.max(w, 0.95 * (1 - dGutter / 1.35))

  // Sidewalk-to-lawn outer edge (z ~ 38, 50)
  const dLawnEdge = Math.min(Math.abs(z - 38.0), Math.abs(z - 50.0))
  if (dLawnEdge < 0.85) w = Math.max(w, 0.82 * (1 - dLawnEdge / 0.85))

  // Near fences & exterior building walls
  for (const bar of town.barriers) {
    const d = distToRect(x, z, bar.rect)
    if (d < 1.4) {
      w = Math.max(w, (bar.kind === "fence" ? 0.90 : 0.78) * (1 - d / 1.4))
    }
  }

  // Driveway & front-walkway margins
  for (const b of town.buildings) {
    if (b.kind !== "house") continue
    const dWalkEdge = Math.min(Math.abs(x - (b.rect[0] + 4.95)), Math.abs(x - (b.rect[0] + 6.45)))
    if (z >= b.rect[3] && z <= frontageEnd(b) + 2.0 && dWalkEdge < 0.65) {
      w = Math.max(w, 0.85 * (1 - dWalkEdge / 0.65))
    }
    const dDriveEdge = Math.min(Math.abs(x - (b.rect[0] - 3.0)), Math.abs(x - (b.rect[0] - 0.35)))
    if (z >= b.rect[1] && z <= frontageEnd(b) + 2.0 && dDriveEdge < 0.75) {
      w = Math.max(w, 0.88 * (1 - dDriveEdge / 0.75))
    }
  }

  // Penalize the middle of the sidewalk walk lane so pedestrians have a clear path
  const inMidSidewalk = (z > 38.42 && z < 39.08) || (z > 48.92 && z < 49.58)
  if (inMidSidewalk) w *= 0.22

  return Math.min(1, w)
}

/**
 * Instanced 3D procedural rubble & exterior clutter renderer.
 * Draws 8 multi-part low-poly archetypes through the opaque `inst` pipeline (`fsSolid`),
 * frustum-culled per frame against `view` and controlled live by `clutterDensity`,
 * `rubbleAmount`, and `clutterSeed`.
 */
export class ExteriorClutterRenderer {
  private readonly models: number[] = []
  private readonly buffers: Float32Array<ArrayBuffer>[] = []
  private placements: ClutterPlacement[] = []
  private cachedKey = ""

  constructor(renderer: Pick<Renderer, "addModel">) {
    // Model 0 (rubble): Scattered clay bricks, half-brick & mortar chunk
    const brickMesh = new Mesh()
    brickMesh.bevelBox(-0.105, 0.0, -0.052, 0.105, 0.062, 0.052, 0.008, rgb(0x6e3d30), rgb(0x7e4839), MAT.brick, MAT.brick)
    brickMesh.yawBox(0.14, 0.07, 0.11, 0.09, 0.0, 0.055, 0.55, rgb(0x5c3428), MAT.brick, 0, rgb(0x6c3e30))
    brickMesh.yawBox(-0.09, 0.10, 0.09, 0.07, 0.0, 0.038, -0.42, rgb(0x52565e), MAT.lit, 0, rgb(0x626670))
    this.registerArchetype(renderer, brickMesh, 256)

    // Model 1 (rubble): Broken concrete stones, gravel chunks & glinting bottle-glass shards
    const stoneGlassMesh = new Mesh()
    stoneGlassMesh.bevelBox(-0.09, 0.0, -0.07, 0.09, 0.045, 0.07, 0.010, rgb(0x464a52), rgb(0x585c66), MAT.lit, MAT.lit)
    stoneGlassMesh.yawBox(0.11, -0.05, 0.08, 0.06, 0.0, 0.034, 0.72, rgb(0x3e4249), MAT.lit, 0, rgb(0x4c5058))
    stoneGlassMesh.yawBox(-0.08, 0.08, 0.06, 0.05, 0.0, 0.026, -0.65, rgb(0x504c44), MAT.lit)
    // Glinting broken glass shards (MAT.shiny catches flashlight & porch light)
    stoneGlassMesh.yawBox(0.05, 0.09, 0.065, 0.032, 0.0, 0.008, 0.38, rgb(0x648084), MAT.shiny)
    stoneGlassMesh.yawBox(-0.03, -0.09, 0.052, 0.026, 0.0, 0.007, 1.15, rgb(0x785830), MAT.shiny)
    this.registerArchetype(renderer, stoneGlassMesh, 256)

    // Model 2 (clutter): Slumped black/olive polyethylene trash bags with tied neck
    const bagMesh = new Mesh()
    bagMesh.prism(0, 0, 0.21, 0.15, 0.0, 0.22, 7, rgb(0x1a1e24), MAT.shiny, 0, true, 0.2)
    bagMesh.prism(0.04, 0.02, 0.14, 0.06, 0.16, 0.29, 6, rgb(0x232830), MAT.shiny, 0, true, 0.7)
    // Tied bag knot ears
    bagMesh.yawBox(0.04, 0.02, 0.08, 0.03, 0.28, 0.34, 0.4, rgb(0x2a3038), MAT.lit)
    // Companion smaller slumped bag
    bagMesh.prism(-0.18, 0.11, 0.14, 0.09, 0.0, 0.16, 6, rgb(0x1c241e), MAT.shiny, 0, true, 1.1)
    this.registerArchetype(renderer, bagMesh, 96)

    // Model 3 (clutter): Knocked-over ribbed trash bin with detached lid & spilled litter
    const binMesh = new Mesh()
    // Horizontal fallen bin body (aligned along X)
    binMesh.bevelBox(-0.34, 0.02, -0.21, 0.32, 0.42, 0.21, 0.05, rgb(0x2c3238), rgb(0x3a4149), MAT.lit, MAT.lit)
    // Ribbed reinforcing rings
    for (const rx of [-0.18, 0.04, 0.24]) {
      binMesh.box(rx - 0.02, 0.015, -0.225, rx + 0.02, 0.435, 0.225, rgb(0x22272c), MAT.lit)
    }
    // Dark hollow open mouth at +X end
    binMesh.box(0.30, 0.05, -0.18, 0.33, 0.39, 0.18, rgb(0x0d1014), MAT.lit)
    // Detached bin lid lying beside the mouth
    binMesh.prism(0.52, -0.16, 0.21, 0.19, 0.0, 0.035, 8, rgb(0x343b42), MAT.lit)
    // Spilled trash bag & crushed can outside bin mouth
    binMesh.prism(0.46, 0.12, 0.13, 0.08, 0.0, 0.14, 6, rgb(0x1b2026), MAT.shiny)
    binMesh.yawBox(0.62, 0.04, 0.11, 0.06, 0.0, 0.045, 0.5, rgb(0x88322c), MAT.shiny)
    this.registerArchetype(renderer, binMesh, 48)

    // Model 4 (clutter): Scattered newspapers, flyers, crushed soda cans & fallen bottle
    const paperCanMesh = new Mesh()
    // Weathered newsprint page with dark headline/column bars
    paperCanMesh.yawBox(-0.06, -0.02, 0.23, 0.17, 0.0, 0.008, 0.18, rgb(0x7c7668), MAT.lit, 0, rgb(0x8e8878))
    paperCanMesh.yawBox(-0.06, -0.02, 0.18, 0.03, 0.008, 0.011, 0.18, rgb(0x383632), MAT.lit)
    // Second angled flyer sheet
    paperCanMesh.yawBox(0.11, 0.08, 0.16, 0.12, 0.0, 0.007, -0.48, rgb(0x726d60), MAT.lit, 0, rgb(0x827c6e))
    // Crushed red/silver soda can + dark green glass bottle
    paperCanMesh.yawBox(-0.14, 0.11, 0.095, 0.055, 0.0, 0.042, 0.85, rgb(0x8a302a), MAT.shiny)
    paperCanMesh.yawBox(0.08, -0.13, 0.16, 0.052, 0.0, 0.048, -0.32, rgb(0x284232), MAT.shiny)
    this.registerArchetype(renderer, paperCanMesh, 192)

    // Model 5 (rubble): Broken picket-fence boards & splintered timber planks
    const plankMesh = new Mesh()
    plankMesh.yawBox(0, 0, 0.68, 0.105, 0.0, 0.024, 0.12, rgb(0x625c4e), MAT.timber, 0, rgb(0x746d5e))
    plankMesh.yawBox(0.08, 0.09, 0.52, 0.092, 0.012, 0.038, -0.38, rgb(0x565043), MAT.timber, 0, rgb(0x686152))
    plankMesh.yawBox(-0.18, -0.08, 0.28, 0.045, 0.0, 0.020, 0.75, rgb(0x4c463a), MAT.timber)
    this.registerArchetype(renderer, plankMesh, 96)

    // Model 6 (clutter): Abandoned rubber car tyre with weathered tread & rusty steel rim
    const tyreMesh = new Mesh()
    tyreMesh.prism(0, 0, 0.32, 0.31, 0.0, 0.19, 10, rgb(0x1c1f24), MAT.lit)
    tyreMesh.prism(0, 0, 0.20, 0.19, 0.01, 0.195, 10, rgb(0x3a3734), MAT.shiny)
    tyreMesh.prism(0, 0, 0.11, 0.11, 0.015, 0.20, 8, rgb(0x14161a), MAT.lit)
    this.registerArchetype(renderer, tyreMesh, 48)

    // Model 7 (clutter): Abandoned suburban items (overturned crate/toolbox, flattened cardboard box & toy/bucket)
    const itemMesh = new Mesh()
    // Flattened soggy cardboard carton
    itemMesh.yawBox(-0.08, 0.0, 0.38, 0.28, 0.0, 0.045, 0.15, rgb(0x5e4932), MAT.lit, 0, rgb(0x6e563c))
    // Overturned plastic crate / toolbox
    itemMesh.bevelBox(0.12, 0.0, -0.14, 0.38, 0.18, 0.08, 0.015, rgb(0x6e3428), rgb(0x823e30), MAT.lit, MAT.lit)
    // Knocked-over plastic bucket / toy wheel
    itemMesh.prism(-0.18, 0.18, 0.11, 0.09, 0.0, 0.14, 7, rgb(0x3c5468), MAT.lit)
    this.registerArchetype(renderer, itemMesh, 64)

    // Model 8 (clutter): Weathered abandoned 1980s sedan (+X forward) with popped hood/trunk & flat-tire list
    const carMesh = new Mesh()
    carMesh.quad([-1.95, 0.005, 0.90], [1.95, 0.005, 0.90], [1.95, 0.005, -0.90], [-1.95, 0.005, -0.90], [0, 1, 0], rgb(0x0d1015), MAT.lit)
    const bodyCol = rgb(0x524844)
    const topCol = rgb(0x665a54)
    const rustCol = rgb(0x4a3328)
    const glassCol = rgb(0x1e2630)
    for (const sx of [-1.22, 1.24]) {
      for (const sz of [-0.76, 0.76]) {
        carMesh.box(sx - 0.29, 0.01, sz - 0.11, sx + 0.29, 0.52, sz + 0.11, rgb(0x16181c), MAT.lit)
        carMesh.box(sx - 0.17, 0.13, sz + (sz < 0 ? -0.12 : 0.09), sx + 0.17, 0.40, sz + (sz < 0 ? -0.09 : 0.12), rgb(0x585c64), MAT.shiny)
      }
    }
    carMesh.bevelBox(-1.98, 0.20, -0.82, 1.98, 0.74, 0.82, 0.05, bodyCol, topCol, MAT.lit, MAT.lit)
    // Rusted quarter-panel patches & dark bumpers
    carMesh.box(-2.04, 0.18, -0.85, -1.82, 0.42, 0.85, rgb(0x22262c), MAT.lit)
    carMesh.box(1.82, 0.18, -0.85, 2.04, 0.42, 0.85, rgb(0x22262c), MAT.lit)
    carMesh.box(-0.95, 0.22, 0.80, 0.45, 0.52, 0.835, rustCol, MAT.lit)
    // Slightly popped-open hood at +X exposing dark engine bay
    carMesh.box(0.85, 0.68, -0.74, 1.92, 0.75, 0.74, rgb(0x14171c), MAT.lit)
    carMesh.yawBox(1.38, 0.0, 1.06, 1.50, 0.74, 0.79, 0.04, topCol, MAT.lit)
    // Tapered cabin greenhouse
    carMesh.bevelBox(-0.88, 0.72, -0.72, 0.68, 1.22, 0.72, 0.12, bodyCol, rgb(0x6e625c), MAT.lit, MAT.lit)
    carMesh.box(-0.90, 0.76, -0.62, 0.70, 1.14, 0.62, glassCol, MAT.shiny)
    for (const sz of [-0.56, 0.56]) {
      carMesh.box(-1.99, 0.46, sz - 0.18, -1.94, 0.62, sz + 0.18, rgb(0x6e2824), MAT.shiny)
      carMesh.box(1.94, 0.46, sz - 0.16, 1.99, 0.62, sz + 0.16, rgb(0x8c929c), MAT.shiny)
    }
    this.registerArchetype(renderer, carMesh, 16)

    // Model 9 (clutter): Knocked-over child's tricycle / scooter & scattered toy blocks
    const toyMesh = new Mesh()
    // Fallen tubular frame & handlebars
    toyMesh.yawBox(0.0, 0.0, 0.42, 0.045, 0.02, 0.08, 0.25, rgb(0x8e382c), MAT.shiny)
    toyMesh.yawBox(0.16, 0.04, 0.04, 0.32, 0.02, 0.14, 0.25, rgb(0x9ca2aa), MAT.shiny)
    // Front wheel + twin rear wheels lying tilted
    toyMesh.prism(0.18, 0.05, 0.13, 0.13, 0.01, 0.045, 8, rgb(0x1c2026), MAT.lit)
    toyMesh.prism(-0.18, -0.11, 0.09, 0.09, 0.01, 0.05, 8, rgb(0x1c2026), MAT.lit)
    toyMesh.prism(-0.14, 0.12, 0.09, 0.09, 0.06, 0.10, 8, rgb(0x1c2026), MAT.lit)
    // Small yellow/blue plastic toy beside it
    toyMesh.yawBox(-0.08, 0.22, 0.11, 0.09, 0.0, 0.065, -0.55, rgb(0x8c722c), MAT.lit)
    this.registerArchetype(renderer, toyMesh, 32)

    // Model 10 (rubble): Gutter leaf, brick & twig windrow cluster (breaks up straight curb & walkway seams)
    const windrowMesh = new Mesh()
    windrowMesh.yawBox(-0.18, 0.02, 0.26, 0.14, 0.0, 0.022, 0.18, rgb(0x4a2e16), MAT.lit)
    windrowMesh.yawBox(0.06, -0.02, 0.22, 0.12, 0.004, 0.026, -0.24, rgb(0x5c3a1a), MAT.lit)
    windrowMesh.yawBox(0.24, 0.03, 0.18, 0.10, 0.0, 0.020, 0.42, rgb(0x3a2614), MAT.lit)
    windrowMesh.bevelBox(-0.04, 0.0, 0.02, 0.12, 0.048, 0.10, 0.006, rgb(0x683a2e), rgb(0x784436), MAT.brick, MAT.brick)
    windrowMesh.yawBox(-0.26, -0.03, 0.09, 0.07, 0.0, 0.036, -0.52, rgb(0x4c5058), MAT.lit)
    windrowMesh.yawBox(0.14, -0.05, 0.28, 0.022, 0.005, 0.022, 0.35, rgb(0x3d2e20), MAT.timber)
    this.registerArchetype(renderer, windrowMesh, 256)
  }

  private registerArchetype(renderer: Pick<Renderer, "addModel">, mesh: Mesh, capacity: number): void {
    this.models.push(renderer.addModel(mesh))
    this.buffers.push(new Float32Array(capacity * INST_FLOATS))
  }

  private ensureScattered(town: Town, clutterSeed: number): void {
    const key = `${town.seed}:${town.houseSeed}:${town.terrain}:${clutterSeed}`
    if (this.cachedKey === key) return
    this.cachedKey = key

    const rng = new Rng((town.seed ^ (clutterSeed * 0x9e3779b9) ^ 0x6c8e9cf5) >>> 0)
    const list: ClutterPlacement[] = []

    const add = (
      modelIndex: number,
      category: ClutterCategory,
      x: number,
      z: number,
      yaw: number,
      scale: number,
      threshold: number,
      pitch = 0,
      roll = 0,
    ) => {
      if (isExteriorWalkPathBlocked(town, x, z, modelIndex === 3 ? 0.45 : 0.24)) return
      const y = supportHeight(town, x, z)
      list.push({ modelIndex, category, x, y, z, yaw, scale, pitch, roll, threshold })
    }

    // 1. Curated hero-frame & house-perimeter rubble/clutter anchors so the street & open shots
    // match the paint-over targets (rubble & leaves along gutters, walkway borders, driveway & fences)
    const heroAnchors: readonly [number, ClutterCategory, number, number, number, number, number][] = [
      // North gutter & curb rubble in hero street view (x = 20..37, z ~ 40.15)
      [0, "rubble", 26.25, 40.18, 0.42, 0.92, 0.15],
      [1, "rubble", 28.55, 40.22, -0.65, 0.88, 0.15],
      [4, "clutter", 29.10, 40.32, 0.28, 0.85, 0.20],
      [0, "rubble", 31.40, 40.16, 1.15, 0.90, 0.20],
      [1, "rubble", 32.85, 40.24, -0.35, 0.86, 0.25],
      [4, "clutter", 24.10, 40.28, 0.92, 0.90, 0.25],
      [2, "clutter", 22.15, 39.55, 0.35, 0.88, 0.30],
      [3, "clutter", 18.55, 39.42, 0.48, 0.92, 0.25],
      [6, "clutter", 21.85, 36.45, -0.25, 0.88, 0.35],
      [7, "clutter", 22.45, 35.82, 0.62, 0.82, 0.40],
      // Front walkway & porch steps edge rubble + porch corner boxes/crates (visible in street.png and open.png!)
      [7, "clutter", 26.48, 36.15, 0.18, 0.88, 0.15],
      [7, "clutter", 28.88, 36.22, -0.24, 0.85, 0.15],
      [2, "clutter", 26.35, 36.92, 0.55, 0.80, 0.20],
      [0, "rubble", 26.78, 36.95, 0.38, 0.78, 0.20],
      [1, "rubble", 28.62, 37.35, -0.52, 0.82, 0.20],
      [4, "clutter", 26.82, 38.25, 0.74, 0.76, 0.30],
      [1, "rubble", 28.58, 38.85, -0.88, 0.80, 0.25],
      [0, "rubble", 26.72, 35.85, 1.05, 0.75, 0.30],
      // East sidewalk leaf/brick clutter (visible in open.png under the east sodium streetlamp)
      [10, "rubble", 38.22, 26.80, 1.48, 0.92, 0.15],
      [10, "rubble", 39.45, 29.40, -1.52, 0.90, 0.15],
      [10, "rubble", 38.18, 32.10, 1.60, 0.94, 0.20],
      [4, "clutter", 38.85, 30.80, 0.42, 0.85, 0.20],
      [1, "rubble", 39.25, 27.90, -0.75, 0.88, 0.20],
      // Road & flashlight cone scattered grit/rubble/papers (x = 24..34, z = 41..47)
      [1, "rubble", 27.65, 42.35, 0.52, 0.82, 0.20],
      [4, "clutter", 28.85, 43.15, -0.44, 0.78, 0.25],
      [1, "rubble", 26.45, 44.10, 1.32, 0.85, 0.25],
      [0, "rubble", 29.55, 44.85, -0.78, 0.76, 0.35],
      [4, "clutter", 25.30, 43.45, 0.19, 0.82, 0.30],
      [1, "rubble", 31.15, 42.75, -1.10, 0.80, 0.30],
      // South gutter & sidewalk rubble (z ~ 47.85..49.85)
      [0, "rubble", 25.85, 47.82, 0.64, 0.90, 0.20],
      [4, "clutter", 28.40, 47.78, -0.55, 0.86, 0.25],
      [1, "rubble", 32.10, 47.84, 0.95, 0.88, 0.25],
      [2, "clutter", 34.65, 48.45, -0.22, 0.85, 0.35],
      [5, "rubble", 23.40, 49.75, 0.18, 0.88, 0.30],
      // Fence & side-yard debris (visible in open.png & yard.png)
      [5, "rubble", 18.45, 36.20, 1.42, 0.92, 0.25],
      [5, "rubble", 18.50, 31.80, 1.65, 0.88, 0.30],
      [6, "clutter", 19.25, 27.40, 0.45, 0.90, 0.30],
      [2, "clutter", 21.55, 29.80, -0.60, 0.86, 0.35],
      [7, "clutter", 19.35, 32.10, 0.28, 0.85, 0.35],
      // Knocked-over child's tricycle & toys by front yard / walkway corner
      [9, "clutter", 24.35, 37.65, 0.58, 0.92, 0.25],
      [9, "clutter", 31.65, 37.72, -0.74, 0.86, 0.45],
      // Gutter & walkway-border leaf/brick windrows (breaks up clean curb & walk edges)
      [10, "rubble", 23.20, 40.08, 0.08, 0.95, 0.15],
      [10, "rubble", 25.45, 40.10, -0.06, 1.02, 0.15],
      [10, "rubble", 27.05, 40.06, 0.12, 0.90, 0.15],
      [10, "rubble", 28.45, 40.08, -0.09, 0.94, 0.15],
      [10, "rubble", 30.85, 40.09, 0.05, 0.98, 0.15],
      [10, "rubble", 32.35, 40.07, -0.11, 0.92, 0.20],
      [10, "rubble", 34.70, 40.10, 0.07, 0.96, 0.20],
      [10, "rubble", 24.80, 47.90, 3.10, 0.95, 0.20],
      [10, "rubble", 27.30, 47.92, -3.05, 1.00, 0.20],
      [10, "rubble", 29.90, 47.91, 3.18, 0.92, 0.20],
      [10, "rubble", 33.10, 47.89, -3.12, 0.96, 0.25],
      [10, "rubble", 26.86, 36.35, 1.52, 0.82, 0.20],
      [10, "rubble", 28.54, 36.65, -1.55, 0.85, 0.20],
      [10, "rubble", 26.88, 37.75, 1.62, 0.84, 0.20],
      [10, "rubble", 28.52, 38.15, -1.48, 0.86, 0.20],
    ]
    for (const [mIdx, cat, x, z, yaw, sc, thr] of heroAnchors) {
      add(mIdx, cat, x, z, yaw, sc, thr)
    }

    // Abandoned vehicles elsewhere on the street & commercial frontages + surrounding spilled debris
    for (const [vIdx, v] of ABANDONED_VEHICLE_SPECS.entries()) {
      const y = supportHeight(town, v.x, v.z)
      list.push({
        modelIndex: 8,
        category: "clutter",
        x: v.x,
        y,
        z: v.z,
        yaw: v.yaw,
        scale: 1.0,
        pitch: 0.015,
        roll: vIdx % 2 === 0 ? 0.042 : -0.038,
        threshold: 0.25,
      })
      const c = Math.cos(v.yaw)
      const s = Math.sin(v.yaw)
      add(2, "clutter", v.x - c * 2.45 + s * 0.4, v.z - s * 2.45 - c * 0.4, v.yaw + 0.5, 0.92, 0.30)
      add(6, "clutter", v.x + c * 0.3 - s * 1.25, v.z + s * 0.3 + c * 1.25, v.yaw - 0.3, 0.90, 0.30)
      add(1, "rubble", v.x + c * 1.2 + s * 1.15, v.z + s * 1.2 - c * 1.15, v.yaw + 1.1, 0.95, 0.25)
    }

    // 2. Town-wide seeded procedural scattering along curbs, gutters, fences, walls & driveways
    // Curbs & gutters along E-W and N-S streets
    for (let v = 4.5; v < SIZE - 4.5; v += 1.45 + rng.next() * 1.35) {
      if (v > 38.5 && v < 49.5) continue
      for (const gCoord of [39.95 + rng.next() * 0.45, 47.60 + rng.next() * 0.45]) {
        if (rng.next() < 0.22) continue
        const x = v + (rng.next() - 0.5) * 0.65
        const z = gCoord
        const roll = rng.next()
        const [mIdx, cat]: [number, ClutterCategory] =
          roll < 0.24
            ? [0, "rubble"]
            : roll < 0.48
              ? [1, "rubble"]
              : roll < 0.70
                ? [10, "rubble"]
                : roll < 0.86
                  ? [4, "clutter"]
                  : roll < 0.94
                    ? [2, "clutter"]
                    : [5, "rubble"]
        add(mIdx, cat, x, z, rng.next() * Math.PI * 2, 0.72 + rng.next() * 0.42, rng.next() * 1.65)
      }
    }

    // Around every building's exterior walls, walkways, driveways & yard fences
    for (const [bIdx, b] of town.buildings.entries()) {
      const [bx0, bz0, bx1, bz1] = b.rect
      const bRng = new Rng((town.seed ^ (bIdx * 4999 + clutterSeed * 131)) >>> 0)
      // Overturned or upright bins + trash bags near building side/driveway corner
      add(3, "clutter", bx0 - 0.75, bz1 - 0.45, bRng.next() * Math.PI * 2, 0.88 + bRng.next() * 0.16, 0.35 + bRng.next() * 0.6)
      add(2, "clutter", bx0 - 0.55, bz1 + 0.35, bRng.next() * Math.PI * 2, 0.82 + bRng.next() * 0.22, 0.25 + bRng.next() * 0.5)
      add(6, "clutter", bx0 - 2.85, bz0 + 3.45, bRng.next() * Math.PI * 2, 0.85 + bRng.next() * 0.20, 0.40 + bRng.next() * 0.6)

      // Scatter 28 edge-weighted rubble/clutter items around each building lot
      for (let k = 0; k < 28; k++) {
        const px = bx0 - 4.2 + bRng.next() * (bx1 - bx0 + 7.5)
        const pz = bz0 - 1.5 + bRng.next() * (frontageEnd(b) + 4.5 - bz0)
        const affinity = exteriorEdgeAffinity(town, px, pz)
        if (bRng.next() > affinity * 1.15) continue
        const pick = bRng.next()
        const [mIdx, cat]: [number, ClutterCategory] =
          pick < 0.28
            ? [0, "rubble"]
            : pick < 0.54
              ? [1, "rubble"]
              : pick < 0.72
                ? [4, "clutter"]
                : pick < 0.84
                  ? [5, "rubble"]
                  : pick < 0.93
                    ? [7, "clutter"]
                    : [2, "clutter"]
        add(
          mIdx,
          cat,
          px,
          pz,
          bRng.next() * Math.PI * 2,
          0.70 + bRng.next() * 0.45,
          bRng.next() * 1.75,
          (bRng.next() - 0.5) * 0.08,
          (bRng.next() - 0.5) * 0.08,
        )
      }
    }

    // Along yard fences ([18, 20..39], [18, 52..71], [18..39, 20], [18..39, 71])
    for (const bar of town.barriers) {
      if (bar.kind !== "fence") continue
      const [fx0, fz0, fx1, fz1] = bar.rect
      const horiz = fx1 - fx0 > fz1 - fz0
      const len = horiz ? fx1 - fx0 : fz1 - fz0
      for (let d = 1.2; d < len - 1.2; d += 2.2 + rng.next() * 1.8) {
        const side = rng.next() < 0.65 ? 1 : -1
        const offset = 0.35 + rng.next() * 0.55
        const px = horiz ? fx0 + d : fx0 + side * offset
        const pz = horiz ? fz0 + side * offset : fz0 + d
        const pick = rng.next()
        const [mIdx, cat]: [number, ClutterCategory] =
          pick < 0.42 ? [5, "rubble"] : pick < 0.72 ? [0, "rubble"] : pick < 0.88 ? [7, "clutter"] : [6, "clutter"]
        add(mIdx, cat, px, pz, rng.next() * Math.PI * 2, 0.75 + rng.next() * 0.38, rng.next() * 1.65)
      }
    }

    this.placements = list
  }

  collectBatches(
    town: Town,
    view: readonly [number, number, number, number],
    settings: Pick<GroundSettings, "clutterDensity" | "rubbleAmount" | "clutterSeed">,
  ): Batch[] {
    this.ensureScattered(town, settings.clutterSeed)
    const [vx0, vy0, vx1, vy1] = view
    const clutterGate = Math.max(0, settings.clutterDensity)
    const rubbleGate = Math.max(0, settings.rubbleAmount)
    if (clutterGate <= 0.01 && rubbleGate <= 0.01) return []

    const counts = new Int32Array(this.models.length)
    for (let i = 0; i < this.placements.length; i++) {
      const it = this.placements[i]!
      const gate = it.category === "rubble" ? rubbleGate : clutterGate
      if (it.threshold > gate) continue
      if (it.x < vx0 - 1.2 || it.x > vx1 + 1.2 || it.z < vy0 - 1.2 || it.z > vy1 + 1.2) continue
      const m = it.modelIndex
      const buf = this.buffers[m]!
      const cap = Math.floor(buf.length / INST_FLOATS)
      const c = counts[m]!
      if (c >= cap) continue
      counts[m] = c + 1
      const o = c * INST_FLOATS
      buf[o] = it.x
      buf[o + 1] = it.y
      buf[o + 2] = it.z
      buf[o + 3] = it.yaw
      buf[o + 4] = 1
      buf[o + 5] = 1
      buf[o + 6] = 1
      buf[o + 7] = it.scale
      buf[o + 8] = it.pitch
      buf[o + 9] = it.roll
      buf[o + 10] = 1
      buf[o + 11] = 0
    }

    const batches: Batch[] = []
    for (let m = 0; m < this.models.length; m++) {
      const count = counts[m]!
      if (count > 0) {
        batches.push({ model: this.models[m]!, data: this.buffers[m]!, count })
      }
    }
    return batches
  }
}
