import type { FogLamp } from "@arcade/kit/gpu/fog-scatter"
import type { FrameParts } from "@arcade/kit/gpu/frame-parts"
import { MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import type { Batch, Renderer } from "@arcade/kit/gpu/renderer"
import type { SceneLight } from "@arcade/kit/gpu/scene-frame"
import type { SpotShadowCaster } from "@arcade/kit/gpu/shadows/spot-shadows"
import { createForestView, type ForestFrameInput, type ForestGlow, type ForestTorch, type ForestView } from "@arcade/kit/forest/view"
import type { ForestStormView } from "@arcade/kit/forest/storm"
import type { QualityTier } from "@arcade/kit/quality"
import type { Rect } from "@arcade/kit/sim/geom"
import type { Feel, WoodsState } from "../shared/sim"
import { toForestWorld, type ForestWorld } from "../shared/forest-world"
import { boundaryMesh } from "./boundary-view"
import { TapeView } from "./tape-view"
import type { WoodsWorld } from "../shared/world"

/**
 * The only module that turns world data into pictures. The forest itself (terrain, trees, floor, rocks, camp, lake,
 * sky, mist, the flashlights and the camera) is the kit's night-forest renderer (`@arcade/kit/forest`), fed the world
 * through `toForestWorld`. What is the game's own stays here as small models drawn with the renderer: tapes (they
 * change every frame), survey markers and the ridge mast with its beacon. Entry points: `setWorld`, `lights`,
 * `occluders`, `draw`, plus `frame` to draw a frame.
 */

const ROCK: Rgb = [0.2, 0.2, 0.19]
const MOSS: Rgb = [0.07, 0.09, 0.045]
const mix3 = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

function marker(m: Mesh, x: number, z: number, y: number, id: number) {
  // Old concrete survey monument with a brass disc, a few stones around and a faded witness post.
  m.bevelBox(x - 0.16, y - 0.4, z - 0.16, x + 0.16, y + 0.75, z + 0.16, 0.03, [0.3, 0.29, 0.27], [0.34, 0.33, 0.3])
  m.prism(x, z, 0.07, 0.07, y + 0.75, y + 0.77, 10, [0.45, 0.32, 0.12], MAT.shiny)
  for (let i = 0; i < 6; i++) {
    const a = i * 1.05 + id
    m.yawBox(x + Math.cos(a) * 0.55, z + Math.sin(a) * 0.55, 0.25, 0.2, y - 0.2, y + 0.12, a, ROCK, MAT.lit, 0, mix3(ROCK, MOSS, 0.7))
  }
  const wx = x + 0.9, wz = z - 0.4
  m.box(wx - 0.05, y - 0.3, wz - 0.05, wx + 0.05, y + 1.2, wz + 0.05, [0.36, 0.34, 0.3])
  m.box(wx - 0.055, y + 0.95, wz - 0.055, wx + 0.055, y + 1.12, wz + 0.055, [0.6, 0.2, 0.05])
}

/** A lattice radio mast: four legs tapering to the top, cross-bracing every few metres. */
function mast(m: Mesh, x: number, z: number, y0: number, h: number) {
  const steel: Rgb = [0.16, 0.16, 0.17]
  const at = (f: number) => 1.1 * (1 - f) + 0.18 * f
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    for (let k = 0; k < 12; k++) {
      const f0 = k / 12, f1 = (k + 1) / 12
      const a = [x + sx * at(f0), y0 + h * f0, z + sz * at(f0)], b = [x + sx * at(f1), y0 + h * f1, z + sz * at(f1)]
      m.prism((a[0]! + b[0]!) / 2, (a[2]! + b[2]!) / 2, 0.05, 0.05, a[1]!, b[1]!, 4, steel)
    }
  }
  for (let k = 1; k < 12; k++) {
    const f = k / 12, r = at(f), y = y0 + h * f
    m.box(x - r, y - 0.03, z - r - 0.03, x + r, y + 0.03, z - r + 0.03, steel)
    m.box(x - r, y - 0.03, z + r - 0.03, x + r, y + 0.03, z + r + 0.03, steel)
    m.box(x - r - 0.03, y - 0.03, z - r, x - r + 0.03, y + 0.03, z + r, steel)
    m.box(x + r - 0.03, y - 0.03, z - r, x + r + 0.03, y + 0.03, z + r, steel)
  }
  m.box(x - 1.5, y0 - 0.5, z - 1.5, x + 1.5, y0 + 0.1, z + 1.5, [0.22, 0.22, 0.21])
}

export type PlaceLights = { scene: SceneLight[]; fog: FogLamp[] }

/** Ridge beacon: a slow aircraft-warning blink, 0..1. */
export function ridgeBlink(t: number): number {
  const p = (t % 1.6) / 1.6
  return p < 0.3 ? Math.sin((p / 0.3) * Math.PI) ** 0.6 : 0
}

export type WorldFrame = {
  eye: readonly [number, number, number]
  viewProj: Float32Array
  width: number
  height: number
  time: number
  dt: number
  fovY: number
  torches: readonly ForestTorch[]
  fp: FrameParts
  place: PlaceLights
  /** Moving torch-shadow casters (realistic friends). */
  casters?: readonly SpotShadowCaster[]
  /** Batches drawn beside `fp`'s (the creature's, which go into the TAA reactive mask). */
  batches?: readonly Batch[]
  /** Road flares' far glows and fire (`FlareView`); their lights come in `place`. */
  flares?: { glows: readonly ForestGlow[]; particles: NonNullable<ForestFrameInput["particles"]> }
  /** The storm this frame (`ForestStorm.frame(...).view`). */
  storm?: ForestStormView | null
}

/**
 * The world as the forest renderer draws it: the toy's adapter plus what only the picture needs. The camp's string
 * lights hang between posts at the span ends (the toy lists every bulb); each survey marker stands in a small clearing.
 */
function forestWorld(world: WoodsWorld, campDetail = false): ForestWorld {
  const fw = toForestWorld(world)
  // Presentation-only gathering point. The old adapter never supplied a fire
  // pit, so the renderer's ring geometry and the paths to it could not appear.
  if (campDetail && fw.camp) fw.camp = { ...fw.camp, props: [...(fw.camp.props ?? []), { kind: "fire-pit", x: world.camp.x - 7, z: world.camp.z + 6.5, yaw: 0 }] }
  const bulbs = world.lamps.filter((l) => l.kind === "string").sort((a, b) => a.x - b.x)
  const camp = fw.camp && bulbs.length > 1 ? (() => {
    const x0 = bulbs[0]!.x, x1 = bulbs[bulbs.length - 1]!.x, z = bulbs[0]!.z, top = Math.max(...bulbs.map((b) => b.y))
    const spans = 4
    const points = Array.from({ length: spans + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / spans, top, z] as const)
    return { ...fw.camp, stringLights: [{ points, bulbs: bulbs.length }] }
  })() : fw.camp
  return { ...fw, camp, clearings: [...(fw.clearings ?? []), ...world.markers.map((m) => ({ x: m.x, z: m.z, r: 3.5 }))] }
}

export class WorldView {
  private markerModel = -1
  private mastModel = -1
  private fenceModel = -1
  private glows: ForestGlow[] = []
  private readonly tapes: TapeView

  private constructor(readonly forest: ForestView) {
    this.tapes = new TapeView(forest.renderer)
  }

  /** Loads the forest's scanned assets and builds `world`. */
  static async create(gpu: { device: GPUDevice; context: GPUCanvasContext; format: GPUTextureFormat }, world: WoodsWorld, opts: { smoke?: boolean; quality?: QualityTier } = {}): Promise<WorldView> {
    // The catalogue night sky is on here with a full moon through the canopy and eyes that dark-adapt over a minute
    // with the torch off (moonless, no adaptation: one setting each); the software-GPU smoke keeps the kit's Today.
    const settings = { highlightShoulder: true, campDetail: true, skyMode: opts.smoke ? "today" as const : "physical" as const, skyMoon: "full" as const, darkAdapt: 1 }
    const forest = await createForestView(gpu, forestWorld(world, settings.campDetail), { assetRoot: import.meta.env.BASE_URL + "forest-assets/", smoke: !!opts.smoke, quality: opts.quality ?? "balanced", markPrefix: "woods", settings })
    const view = new WorldView(forest)
    view.models(world)
    forest.setOccluders(view.occluders(world))
    return view
  }

  get renderer(): Renderer { return this.forest.renderer }

  private models(world: WoodsWorld) {
    const markers = new Mesh()
    for (const k of world.markers) marker(markers, k.x, k.z, k.y, k.id)
    this.markerModel = this.slot(this.markerModel, markers)
    const m = world.buildings.find((b) => b.kind === "mast")
    const tower = new Mesh()
    if (m) mast(tower, (m.rect[0] + m.rect[2]) / 2, (m.rect[1] + m.rect[3]) / 2, m.y, m.h)
    this.mastModel = this.slot(this.mastModel, tower)
    this.fenceModel = this.slot(this.fenceModel, boundaryMesh(world))
  }

  /** A model slot: allocated once, refilled when the world is regenerated. */
  private slot(id: number, mesh: Mesh): number {
    if (id < 0) return this.renderer.addModel(mesh)
    this.renderer.setModel(id, mesh)
    return id
  }

  /** Rebuilds the static world. Call again when the world is regenerated (trunk density, seed). */
  setWorld(world: WoodsWorld): void {
    this.forest.setWorld(forestWorld(world, this.forest.settings.campDetail))
    this.forest.setOccluders(this.occluders(world))
    this.models(world)
    this.tapes.reset()
  }

  /** Footprints of trunks, rocks and buildings with their top heights: the trunk shadows a flare on the ground casts. */
  occluders(world: WoodsWorld): { rect: Rect; h: number }[] {
    const out: { rect: Rect; h: number }[] = []
    for (const t of world.trees) {
      const s = t.radius * 0.85
      out.push({ rect: [t.x - s, t.z - s, t.x + s, t.z + s], h: t.y + t.height * 0.8 })
    }
    for (const k of world.rocks) if (k.h > 0.5) {
      const e = Math.min(k.w, k.d) * 0.4
      out.push({ rect: [k.x - e, k.z - e, k.x + e, k.z + e], h: k.y + k.h })
    }
    for (const b of world.buildings) if (b.kind === "cabin" || b.kind === "mess-hall") out.push({ rect: b.rect, h: b.y + b.h + 1.5 })
    return out
  }

  /**
   * The place's lights beyond the forest's own (its camp windows, porches and string lights come from the buildings):
   * the ridge beacon, a point source that lights its mast and a tight halo of air, not the treetops.
   */
  lights(world: WoodsWorld, t: number, feel: Feel): PlaceLights {
    const scene: SceneLight[] = [], fog: FogLamp[] = []
    const blink = ridgeBlink(t) * feel.ridgeGlow
    const r = world.ridgeLight
    this.glows.length = 0
    if (blink > 0) {
      scene.push({ id: 950, x: r.x, y: r.z, h: r.y, r: 6, color: [1, 0.05, 0.02], power: 4 * blink, size: 0.1, unshadowed: true })
      fog.push({ id: 950, x: r.x, y: r.y, z: r.z, range: 10, color: [1, 0.05, 0.02], intensity: 40 * blink, size: 0.15, visibility: 1 })
      this.glows.push({ x: r.x, y: r.y, z: r.z, radius: 1.6, color: [400 * blink, 22 * blink, 8 * blink] })
    }
    return { scene, fog }
  }

  /** Per-frame world content: tapes (`TapeView`), survey markers, the mast and the boundary fence. */
  draw(fp: FrameParts, world: WoodsWorld, state: WoodsState, t: number, eye: readonly number[], feel: Feel): void {
    this.tapes.draw(fp, world, state.tapes, t, eye, feel, this.forest.settings, this.forest.quality.near)
    if (this.markerModel >= 0) fp.push(this.markerModel, 0, 0, 0, 0, [1, 1, 1], 0, 0, 0)
    if (this.mastModel >= 0) fp.push(this.mastModel, 0, 0, 0, 0, [1, 1, 1], 0, 0, 0)
    if (this.fenceModel >= 0) fp.push(this.fenceModel, 0, 0, 0, 0, [1, 1, 1], 0, 0, 0)
  }

  /**
   * Lights, shadows, mist and camera for this frame, then draws it. `sync` encodes it at once (automation stepping,
   * where the caller copies the canvas in the same task), or into `target` offscreen (the software-GPU smoke).
   */
  frame(f: WorldFrame, sync = false, target?: GPUTextureView): void {
    this.forest[sync || target ? "update" : "frame"]({
      eye: f.eye, viewProj: f.viewProj, width: f.width, height: f.height, time: f.time, dt: f.dt, fovY: f.fovY, torches: f.torches,
      batches: f.batches?.length ? [...f.fp.batches(), ...f.batches] : f.fp.batches(), sprites: { alpha: f.fp.alpha, alphaCount: f.fp.nAlpha, add: f.fp.add, addCount: f.fp.nAdd },
      lights: f.place.scene, fogLamps: f.place.fog, glows: f.flares?.glows.length ? [...this.glows, ...f.flares.glows] : this.glows, casters: f.casters, storm: f.storm ?? null,
      ...(f.flares ? { particles: f.flares.particles } : {}),
    })
    if (sync || target) this.forest.drawTo(target)
  }
}
