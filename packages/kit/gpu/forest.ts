import type { LabControl } from "../lab-navigation"
import { compileShaderModuleWithLog, type PassContext, type ScenePass } from "./pass-graph"
import type { SceneHooks } from "./shaders"
import type { SpotShadowCaster } from "./shadows/spot-shadows"
import { TEXTURED_VERTEX_LAYOUT, texturedSceneShader } from "./textured-mesh"
import { bakeScatter } from "./scatter-mesh"

// Instanced forest: each tree variant at two card-model detail levels, and one camera-facing impostor per far tree.
// - LOD bands and instance lists follow Aiden's Ashwood forest (world/forest.ts, forest/render.ts): near and mid lists
//   are rebuilt nearest-first when the eye has moved a couple of metres, the far layer is static and its band is
//   evaluated per vertex, so out-of-band instances collapse and cost no fragments.
// - Cross-fades are complementary 4×4 Bayer screen-door masks shifted every frame, so TAA resolves them into a blend
//   with no holes and no double coverage (Tidewater src/materials/LODFade.js, MIT, © 2026 DRG Software Solutions LLC,
//   https://github.com/dgreenheck/tidewater).
// - Far thinning removes up to `thinFraction` of the far crowns between `thinStart` and `thinEnd` and grows the rest
//   about their base by 1/√(1−f) so the canopy keeps its coverage and reads as a few large masses instead of speckle
//   (Tidewater src/world/vegetation/Impostors.js, MIT). `crown` grows them further, to close gaps between masses.

/** Template vertices: kit's 32-byte textured layout (`packTexturedVerts`), in the tree's local space. Foliage aux = inner-crown depth 0..1. */
export type ForestLod = { trunk: ArrayBuffer; foliage: ArrayBuffer }
export type ForestModel = {
  lods: readonly [ForestLod, ForestLod]
  /** Impostor quad width and height at scale 1 (m). */
  impostor: { w: number; h: number }
  /** Linear foliage colour of this species (Ashwood `FOLIAGE_COLOR`). */
  colour: readonly [number, number, number]
  /** Saplings get no mid-detail model or impostor: past full detail they are lost in undergrowth and fog. */
  sapling?: boolean
}
export type ForestTrees = {
  count: number
  x: Float32Array; y: Float32Array; z: Float32Array
  scale: Float32Array; yaw: Float32Array; tint: Float32Array
  /** Stable 0..1 per tree: picks which far crowns thin out. */
  seed: Float32Array
  variant: Uint8Array
}

export type ForestSettings = {
  look: "massed" | "today"
  /** Full-detail model distance (m). */
  lod0: number
  /** Mid-detail model distance; impostors beyond (m). */
  lod1: number
  /** Width of each cross-fade band (m). 0 switches in one frame. */
  fade: number
  /** Far impostor cull distance (m). */
  far: number
  thinStart: number
  thinEnd: number
  /** Share of far crowns removed at `thinEnd`. */
  thinFraction: number
  /** Extra growth of the surviving far crowns at `thinEnd` (×). */
  crown: number
  /** Inner-crown shade: limb bases in the crown's own shadow (Ashwood foliage material). 0 = flat-lit cards. */
  inner: number
  /** Blend of each card's own face normal into the crown normal, so overlapping sprays shade apart. */
  face: number
  /** Per-species foliage colour (Ashwood `FOLIAGE_COLOR`); 0 = white cards. */
  species: number
}

export const FOREST_PRESETS = {
  massed: { lod0: 34, lod1: 110, fade: 5, far: 1000, thinStart: 140, thinEnd: 320, thinFraction: 0.5, crown: 1.15, inner: 1, face: 0.45, species: 1 },
  // Before forest LOD: the conversion froze every tree at its title-camera level (models within 107.5 m).
  today: { lod0: 65, lod1: 107.5, fade: 0, far: 1000, thinStart: 140, thinEnd: 320, thinFraction: 0, crown: 1, inner: 0, face: 0, species: 0 },
} as const satisfies Record<ForestSettings["look"], Omit<ForestSettings, "look">>

export const forestDefaults = (look: ForestSettings["look"] = "massed"): ForestSettings => ({ look, ...FOREST_PRESETS[look] })

export function forestControls(settings: ForestSettings, group = "Forest", prefix = "forest."): LabControl[] {
  const range = (k: Exclude<keyof ForestSettings, "look">, label: string, min: number, max: number, step: number, unit?: string, subsection?: string): LabControl =>
    ({ key: prefix + k, field: k, label, group, min, max, step, ...(unit ? { unit } : {}), ...(subsection ? { subsection } : {}) })
  return [
    { key: prefix + "look", field: "look", label: "Forest", group, type: "select", options: [{ value: "massed", label: "Massed crowns" }, { value: "today", label: "Today" }],
      change: value => Object.assign(settings, FOREST_PRESETS[value as ForestSettings["look"]]) },
    range("inner", "Inner crown shade", 0, 1, 0.05, "×", "Crowns"),
    range("face", "Card face normal", 0, 1, 0.05, "×", "Crowns"),
    range("species", "Species colour", 0, 1, 0.05, "×", "Crowns"),
    range("thinFraction", "Far crowns removed", 0, 0.8, 0.05, "×", "Far masses"),
    range("crown", "Far crown growth", 1, 1.6, 0.01, "×", "Far masses"),
    range("thinStart", "Thinning from", 50, 400, 5, "m", "Far masses"),
    range("thinEnd", "Thinning to", 60, 600, 5, "m", "Far masses"),
    range("lod0", "Full-detail distance", 10, 80, 1, "m", "Detail"),
    range("lod1", "Mid-detail distance", 40, 300, 2.5, "m", "Detail"),
    range("fade", "Cross-fade width", 0, 20, 0.5, "m", "Detail"),
    range("far", "Far cull distance", 150, 1400, 10, "m", "Detail"),
  ]
}

/** Band edges (m). A level is fully visible from `lo + fade` to `hi` and fades out over `[hi, hi + fade]`. */
export function forestBands(s: Pick<ForestSettings, "lod0" | "lod1" | "fade" | "far">) {
  const fade = Math.max(0, s.fade)
  const lod0 = Math.max(1, s.lod0), lod1 = Math.max(lod0 + 1, s.lod1)
  return { fade, near: lod0 - fade, mid: lod1 - fade, far: s.far }
}

const INSTANCE_FLOATS = 8
const GRID_CELL = 16
const MAX_VARIANTS = 16
const UNIFORM_FLOATS = 20 + MAX_VARIANTS * 8

/** Nearest-first spatial grid over the trees: lists come out roughly front to back, so cards behind fail early-Z. */
export class ForestGrid {
  readonly x0: number; readonly z0: number; readonly nx: number; readonly nz: number
  readonly cellStart: Uint32Array; readonly order: Uint32Array
  private ring: Int32Array
  constructor(readonly trees: ForestTrees, readonly cell = GRID_CELL) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity
    for (let i = 0; i < trees.count; i++) { x0 = Math.min(x0, trees.x[i]!); x1 = Math.max(x1, trees.x[i]!); z0 = Math.min(z0, trees.z[i]!); z1 = Math.max(z1, trees.z[i]!) }
    if (!trees.count) { x0 = z0 = x1 = z1 = 0 }
    this.x0 = x0; this.z0 = z0
    this.nx = Math.max(1, Math.ceil((x1 - x0) / cell) + 1); this.nz = Math.max(1, Math.ceil((z1 - z0) / cell) + 1)
    const cells = new Uint32Array(trees.count), counts = new Uint32Array(this.nx * this.nz + 1)
    for (let i = 0; i < trees.count; i++) { cells[i] = this.cellOf(trees.x[i]!, trees.z[i]!); counts[cells[i]! + 1]!++ }
    for (let c = 1; c < counts.length; c++) counts[c]! += counts[c - 1]!
    this.cellStart = counts.slice()
    this.order = new Uint32Array(trees.count)
    const cursor = counts.slice(0, -1)
    for (let i = 0; i < trees.count; i++) this.order[cursor[cells[i]!]!++] = i
    const R = Math.max(this.nx, this.nz), offsets: [number, number, number][] = []
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) offsets.push([dx, dz, dx * dx + dz * dz])
    offsets.sort((a, b) => a[2] - b[2])
    this.ring = new Int32Array(offsets.flat())
  }
  private cellOf(x: number, z: number) {
    const i = Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.x0) / this.cell)))
    const j = Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.z0) / this.cell)))
    return j * this.nx + i
  }
  /** Every tree in cells that may lie within `reach` of (x, z), nearest cells first. */
  near(x: number, z: number, reach: number, visit: (tree: number) => void) {
    const ci = Math.floor((x - this.x0) / this.cell), cj = Math.floor((z - this.z0) / this.cell)
    const maxD2 = (reach / this.cell + 1.5) ** 2
    for (let r = 0; r < this.ring.length; r += 3) {
      if (this.ring[r + 2]! > maxD2) break
      const i = ci + this.ring[r]!, j = cj + this.ring[r + 1]!
      if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) continue
      const c = j * this.nx + i
      for (let o = this.cellStart[c]!; o < this.cellStart[c + 1]!; o++) visit(this.order[o]!)
    }
  }
}

export type ForestLists = { near: Float32Array; mid: Float32Array; nearCounts: Uint32Array; midCounts: Uint32Array; nearStart: Uint32Array; midStart: Uint32Array }

/**
 * Near (full-detail) and mid instance lists per variant around the eye, nearest first, including both levels inside each
 * cross-fade band. Instances are (x, y, z, scale, yaw, tint, seed, variant).
 */
export function forestLists(grid: ForestGrid, models: readonly ForestModel[], eye: readonly number[], s: Pick<ForestSettings, "lod0" | "lod1" | "fade" | "far">, margin = 4): ForestLists {
  const t = grid.trees, b = forestBands(s), V = models.length
  const reach = b.mid + b.fade + margin
  const nearCounts = new Uint32Array(V), midCounts = new Uint32Array(V)
  const nearIds: number[][] = Array.from({ length: V }, () => []), midIds: number[][] = Array.from({ length: V }, () => [])
  grid.near(eye[0]!, eye[2]!, reach, k => {
    const d = Math.hypot(t.x[k]! - eye[0]!, t.z[k]! - eye[2]!)
    if (d > reach) return
    const v = t.variant[k]!
    if (d < b.near + b.fade + margin) nearIds[v]!.push(k)
    if (!models[v]!.sapling && d > b.near - margin) midIds[v]!.push(k)
  })
  const pack = (ids: number[][], counts: Uint32Array) => {
    const start = new Uint32Array(V)
    let total = 0
    ids.forEach((list, v) => { start[v] = total; counts[v] = list.length; total += list.length })
    const out = new Float32Array(total * INSTANCE_FLOATS)
    ids.forEach((list, v) => list.forEach((k, n) => writeInstance(out, start[v]! + n, t, k)))
    return { out, start }
  }
  const near = pack(nearIds, nearCounts), mid = pack(midIds, midCounts)
  return { near: near.out, mid: mid.out, nearCounts, midCounts, nearStart: near.start, midStart: mid.start }
}

function writeInstance(out: Float32Array, i: number, t: ForestTrees, k: number) {
  const o = i * INSTANCE_FLOATS
  out[o] = t.x[k]!; out[o + 1] = t.y[k]!; out[o + 2] = t.z[k]!; out[o + 3] = t.scale[k]!
  out[o + 4] = t.yaw[k]!; out[o + 5] = t.tint[k]!; out[o + 6] = t.seed[k]!; out[o + 7] = t.variant[k]!
}

const FOREST_WGSL = /* wgsl */ `
struct ForestU { cam: vec4f, bands: vec4f, thin: vec4f, look: vec4f, grid: vec4f, variants: array<vec4f, ${MAX_VARIANTS}>, colours: array<vec4f, ${MAX_VARIANTS}> }
@group(1) @binding(6) var<uniform> FU: ForestU;

// Bayer 4×4 threshold, shifted every frame (all 16 offsets over 16 frames) so TAA blends the screen door.
fn forestBayer(pixel: vec2f) -> f32 {
  let f = u32(FU.cam.w);
  let p = vec2u(pixel) + vec2u(f * 3u, f >> 2u);
  let x0 = p.x & 1u; let x1 = (p.x >> 1u) & 1u; let y0 = p.y & 1u; let y1 = (p.y >> 1u) & 1u;
  return (f32(((x0 ^ y0) << 3u) | (y0 << 2u) | ((x1 ^ y1) << 1u) | y1) + 0.5) / 16.0;
}

@vertex fn vsForest(v: VIn, @location(5) ip: vec4f, @location(6) id: vec4f) -> VOut {
  var o: VOut;
  let level = Mtl.flags.z;
  let hard = Mtl.flags.w > 0.5;
  let d = length(FU.cam.xz - ip.xz);
  let fw = max(FU.bands.z, 1e-3);
  let lo = select(select(-1e9, FU.bands.x, level > 0.5), FU.bands.y, level > 1.5);
  let hi = select(select(FU.bands.x, FU.bands.y, level > 0.5), FU.bands.w, level > 1.5);
  // Trunks switch at the middle of the band (no cut-out to dither); cards and impostors cross-fade across it.
  let inside = select(d >= lo - 1.0 && d <= hi + fw + 1.0, d >= lo + fw * 0.5 && d < hi + fw * 0.5, hard);
  let variant = u32(id.w);
  var world: vec3f;
  var nrm: vec3f;
  var keep = true;
  if (level > 1.5) {
    let thin = smoothstep(FU.thin.x, FU.thin.y, d);
    keep = fract(id.z * 91.7) >= thin * FU.thin.z;
    let s = ip.w * (1.0 + thin * FU.thin.w);
    let size = FU.variants[variant].xy;
    let toCam = normalize(F.cam.xz - ip.xz);
    let side = vec3f(toCam.y, 0.0, -toCam.x);
    world = ip.xyz + side * (v.pos.x * size.x * s) + vec3f(0.0, v.pos.y * size.y * s - 0.7 * ip.w, 0.0);
    nrm = normalize(vec3f(toCam.x, 0.55, toCam.y));
    // Atlas cell of this variant; the template quad carries its corner in pos.xy.
    let cols = FU.look.w;
    o.uv = vec2f((f32(variant % u32(cols)) + v.pos.x + 0.5) / cols, (floor(f32(variant) / cols) + 1.0 - v.pos.y) / FU.grid.x);
  } else {
    let c = cos(id.x); let sn = sin(id.x);
    let l = v.pos * ip.w;
    world = vec3f(l.x * c - l.z * sn, l.y, l.x * sn + l.z * c) + ip.xyz;
    nrm = vec3f(v.normal.x * c - v.normal.z * sn, v.normal.y, v.normal.x * sn + v.normal.z * c);
    o.uv = v.uv;
  }
  // Wind (grid.yzw: amplitude at 20 m, heading, clock; 0 = still): the tree bends with the square of its height, in
  // gusts that travel downwind across the stand, and the cards add a faster flutter.
  if (FU.grid.y > 0.0) {
    let h = max(world.y - ip.y, 0.0) / 20.0;
    let wd = vec2f(cos(FU.grid.z), sin(FU.grid.z));
    let along = dot(ip.xz, wd);
    let gust = 0.55 + 0.45 * sin(FU.grid.w * 0.9 - along * 0.035 + id.z * 6.0) + 0.25 * sin(FU.grid.w * 2.3 - along * 0.08 + id.z * 17.0);
    let bend = FU.grid.y * h * h * gust;
    let flutter = select(0.0, FU.grid.y * 0.08 * h * sin(FU.grid.w * 5.3 + dot(world.xz, vec2f(0.9, 0.7)) + id.z * 31.0), !hard);
    world += vec3f(wd.x * bend + wd.y * flutter, -0.15 * bend * h, wd.y * bend - wd.x * flutter);
  }
  o.world = world;
  o.normal = nrm;
  let card = !hard && level < 1.5;
  let species = select(vec3f(1.0), mix(vec3f(1.0), FU.colours[variant].rgb, FU.look.z), card);
  o.color = pow(v.color.rgb, vec3f(2.2)) * id.y * species;
  o.mat = v.matAux.x;
  o.aux = v.matAux.y;
  o.extra = vec4f(clamp((d - lo) / fw, 0.0, 1.0), clamp((d - hi) / fw, 0.0, 1.0), 1.0, 0.0);
  o.pos = select(vec4f(0.0, 0.0, -2.0, 1.0), F.viewProj * vec4f(world, 1.0), inside && keep);
  return o;
}
`

/**
 * Ashwood's foliage-card shading for `texturedSceneShader` hooks: limb bases darken toward the trunk (vertex aux holds the
 * inner-crown depth 0..1, `inner` scales it) and each card's own face normal blends into the crown normal by `face`, so
 * sprays at different angles shade apart instead of reading as one flat lit sheet. `when` limits it to card surfaces.
 */
export function cardShadingHooks(hooks: SceneHooks, inner: string, face: string, when = "true"): SceneHooks {
  return { ...hooks,
    // Any vertex hook makes aux interpolate rather than stay flat per triangle.
    vertex: hooks.vertex || " ",
    declarations: `${hooks.declarations ?? ""}\nvar<private> cardFace: vec3f;`,
    fragmentStart: /* wgsl */ `${hooks.fragmentStart ?? ""}
      let cardF0 = normalize(cross(dp1, dp2));
      cardFace = select(cardF0, -cardF0, dot(cardF0, F.cam.xyz - o.world) < 0.0);`,
    material: /* wgsl */ `${hooks.material ?? ""}
      if (${when}) {
        albedo *= mix(1.0, 0.45 + 0.55 * clamp(o.aux, 0.0, 1.0), ${inner});
        n = normalize(mix(normalize(n), cardFace, ${face}));
      }`,
  }
}

/** The forest's draw hooks: the caller's scene hooks plus the LOD dither and card shading. */
export function forestHooks(hooks: SceneHooks): SceneHooks {
  const shaded = cardShadingHooks(hooks, "FU.look.x", "FU.look.y", "Mtl.flags.w < 0.5 && Mtl.flags.z < 1.5")
  return { ...shaded,
    declarations: `${shaded.declarations}\n${FOREST_WGSL}`,
    fragmentStart: /* wgsl */ `
      let forestDither = forestBayer(o.pos.xy);
      if (forestDither < 1.0 - o.extra.x || forestDither >= 1.0 - o.extra.y) { discard; }
      ${shaded.fragmentStart}`,
  }
}

export type ForestTextures = { leaves: GPUTexture; bark: GPUTexture; impostors: GPUTexture; normal: GPUTexture; orm: GPUTexture }
export type ForestOptions = {
  hooks: SceneHooks
  textures: ForestTextures
  /** Impostor atlas cells: columns × rows, cell index = variant. */
  impostorGrid: readonly [number, number]
  /** Rebuild near/mid lists after the eye moves this far (m). */
  rebuild?: number
}
export type ForestStats = { near: number; mid: number; far: number; draws: number; rebuildMs: number; rebuilds: number }

type Part = { level: 0 | 1 | 2; hard: boolean; buffer: GPUBuffer; count: number }

/** Instanced forest `ScenePass`: call `update(eye, settings)` once per frame before rendering. */
export class ForestPass implements ScenePass {
  readonly grid: ForestGrid
  private device: GPUDevice
  private pipeline: GPURenderPipeline
  private uniform: GPUBuffer
  private uniformData = new Float32Array(UNIFORM_FLOATS)
  private groups: GPUBindGroup[] = []
  private materials: GPUBuffer[] = []
  private parts: Part[][] = []
  private quad: GPUBuffer
  private near: GPUBuffer | null = null
  private mid: GPUBuffer | null = null
  private far: GPUBuffer
  private farCount = 0
  private lists: ForestLists | null = null
  private listEye = [Infinity, 0, Infinity]
  private listKey = ""
  private frame = 0
  private readonly statsData: ForestStats = { near: 0, mid: 0, far: 0, draws: 0, rebuildMs: 0, rebuilds: 0 }

  constructor(ctx: PassContext, readonly models: readonly ForestModel[], readonly trees: ForestTrees, private options: ForestOptions) {
    if (models.length > MAX_VARIANTS) throw new Error(`Forest supports ${MAX_VARIANTS} variants`)
    const d = this.device = ctx.device
    this.grid = new ForestGrid(trees)
    const layout = d.createBindGroupLayout({ entries: [
      ...[0, 1, 2, 5].map(binding => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: {} })),
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 4, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
      { binding: 6, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
    ] })
    const module = compileShaderModuleWithLog(d, texturedSceneShader(forestHooks(options.hooks), true), "forest")
    this.pipeline = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout, layout] }),
      vertex: { module, entryPoint: "vsForest", buffers: [TEXTURED_VERTEX_LAYOUT, { arrayStride: INSTANCE_FLOATS * 4, stepMode: "instance", attributes: [
        { shaderLocation: 5, offset: 0, format: "float32x4" }, { shaderLocation: 6, offset: 16, format: "float32x4" },
      ] }] },
      fragment: { module, entryPoint: "fsSolid", targets: [{ format: ctx.color }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: ctx.depth, depthWriteEnabled: true, depthCompare: ctx.depthCompare ?? "less-equal" },
      multisample: { count: ctx.samples },
    })
    this.uniform = d.createBuffer({ size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const sampler = d.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", maxAnisotropy: 8 })
    const t = options.textures
    // One material per (level, part): flags.z = level, flags.w = hard switch (trunks).
    const material = (base: GPUTexture, level: number, hard: boolean, cutoff: number) => {
      const buffer = d.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      d.queue.writeBuffer(buffer, 0, new Float32Array([1, 1, 1, 1, hard ? 0.9 : 0.88, 0, 0, cutoff, 0, 0, level, Number(hard)]))
      this.materials.push(buffer)
      this.groups.push(d.createBindGroup({ layout, entries: [
        { binding: 0, resource: base.createView() }, { binding: 1, resource: t.normal.createView() }, { binding: 2, resource: t.orm.createView() },
        { binding: 3, resource: sampler }, { binding: 4, resource: { buffer } }, { binding: 5, resource: t.orm.createView() },
        { binding: 6, resource: { buffer: this.uniform } },
      ] }))
    }
    material(t.bark, 0, true, 0); material(t.leaves, 0, false, 0.5); material(t.bark, 1, true, 0); material(t.leaves, 1, false, 0.5); material(t.impostors, 2, false, 0.5)
    const upload = (bytes: ArrayBuffer) => {
      const buffer = d.createBuffer({ size: Math.max(32, bytes.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
      if (bytes.byteLength) d.queue.writeBuffer(buffer, 0, bytes)
      return buffer
    }
    this.parts = models.map(m => m.lods.flatMap((lod, level) => [
      { level: level as 0 | 1, hard: true, buffer: upload(lod.trunk), count: lod.trunk.byteLength / 32 },
      { level: level as 0 | 1, hard: false, buffer: upload(lod.foliage), count: lod.foliage.byteLength / 32 },
    ]))
    // Impostor template: corners in pos.xy (x across −0.5..0.5, y up 0..1); UVs come from the variant's atlas cell.
    const quad = new ArrayBuffer(6 * 32), qf = new Float32Array(quad), qb = new Uint8Array(quad)
    ;[[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 0], [0.5, 1], [-0.5, 1]].forEach(([x, y], i) => {
      qf[i * 8] = x!; qf[i * 8 + 1] = y!; qf[i * 8 + 2] = 0
      qb.set([0, 0, 127, 0, 255, 255, 255, 255], i * 32 + 12)
      new Uint16Array(quad, i * 32 + 20, 2).set([0, 0])
    })
    this.quad = upload(quad)
    this.far = d.createBuffer({ size: Math.max(32, trees.count * INSTANCE_FLOATS * 4), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
  }

  private sortFar(eye: readonly number[]) {
    const out = new Float32Array(this.trees.count * INSTANCE_FLOATS)
    let n = 0
    this.grid.near(eye[0]!, eye[2]!, 1e6, k => { if (!this.models[this.trees.variant[k]!]!.sapling) writeInstance(out, n++, this.trees, k) })
    this.device.queue.writeBuffer(this.far, 0, out.buffer, 0, n * INSTANCE_FLOATS * 4)
    this.farCount = n
  }

  private writeList(data: Float32Array, current: GPUBuffer | null) {
    let buffer = current
    if (!buffer || buffer.size < data.byteLength) {
      buffer?.destroy()
      buffer = this.device.createBuffer({ size: Math.max(256, Math.ceil(data.byteLength * 1.5)), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    }
    if (data.byteLength) this.device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength)
    return buffer
  }

  /** `wind`: sway amplitude at 20 m (m), heading (rad, 0 = +x), clock (s); omitted or 0 keeps the forest still. */
  update(eye: readonly number[], s: ForestSettings, wind?: readonly [amplitude: number, heading: number, time: number]) {
    const b = forestBands(s)
    const key = [s.lod0, s.lod1, s.fade].join()
    const moved = Math.hypot(eye[0]! - this.listEye[0]!, eye[2]! - this.listEye[2]!)
    if (!this.lists || key !== this.listKey || moved > (this.options.rebuild ?? 2)) {
      const t0 = performance.now()
      if (!this.lists || moved > 60) this.sortFar(eye)
      this.lists = forestLists(this.grid, this.models, eye, s)
      this.near = this.writeList(this.lists.near, this.near)
      this.mid = this.writeList(this.lists.mid, this.mid)
      this.listEye = [eye[0]!, eye[1]!, eye[2]!]
      this.listKey = key
      this.statsData.rebuildMs = performance.now() - t0
      this.statsData.rebuilds++
    }
    const f = Math.min(0.95, Math.max(0, s.thinFraction))
    const u = this.uniformData
    u.set([eye[0]!, eye[1]!, eye[2]!, this.frame++ % 65536, b.near, b.mid, b.fade, b.far,
      s.thinStart, Math.max(s.thinStart + 1e-3, s.thinEnd), f, s.crown / Math.sqrt(1 - f) - 1,
      s.inner, s.face, s.species, this.options.impostorGrid[0], this.options.impostorGrid[1], wind?.[0] ?? 0, wind?.[1] ?? 0, wind?.[2] ?? 0])
    this.models.forEach((m, v) => {
      u.set([m.impostor.w, m.impostor.h, Number(m.sapling ?? false), 0], 20 + v * 4)
      u.set([...m.colour, 0], 20 + MAX_VARIANTS * 4 + v * 4)
    })
    this.device.queue.writeBuffer(this.uniform, 0, u)
  }

  draw(pass: GPURenderPassEncoder) {
    const l = this.lists
    if (!l || !this.near || !this.mid) return
    pass.setPipeline(this.pipeline)
    let draws = 0, near = 0, mid = 0
    for (let level = 0; level < 2; level++) {
      const counts = level ? l.midCounts : l.nearCounts, starts = level ? l.midStart : l.nearStart
      const instances = level ? this.mid : this.near
      for (const hard of [false, true]) {
        pass.setBindGroup(1, this.groups[level * 2 + (hard ? 0 : 1)]!)
        this.parts.forEach((parts, v) => {
          const n = counts[v]!, part = parts[level * 2 + (hard ? 0 : 1)]!
          if (!n || !part.count) return
          pass.setVertexBuffer(0, part.buffer); pass.setVertexBuffer(1, instances, starts[v]! * INSTANCE_FLOATS * 4)
          pass.draw(part.count, n)
          draws++
          if (!hard) { if (level) mid += n; else near += n }
        })
      }
    }
    if (this.farCount) {
      pass.setBindGroup(1, this.groups[4]!)
      pass.setVertexBuffer(0, this.quad); pass.setVertexBuffer(1, this.far)
      pass.draw(6, this.farCount)
      draws++
    }
    Object.assign(this.statsData, { near, mid, far: this.farCount, draws })
  }

  stats(): Readonly<ForestStats> { return this.statsData }

  /**
   * Full-detail trunks near the given points as one static, non-instanced buffer, for spot-shadow casters (shadow
   * passes draw plain vertex buffers). Built once; trunks only, since cut-out cards need an alpha-aware depth shader.
   */
  staticCasters(points: readonly { x: number; z: number }[], radius: number): SpotShadowCaster[] {
    const t = this.trees, chunks: ArrayBuffer[] = []
    for (let k = 0; k < t.count; k++) {
      if (!points.some(p => Math.hypot(t.x[k]! - p.x, t.z[k]! - p.z) < radius)) continue
      chunks.push(bakeScatter(this.models[t.variant[k]!]!.lods[0].trunk, [{ x: t.x[k]!, y: t.y[k]!, z: t.z[k]!, yaw: t.yaw[k]!, scale: t.scale[k]! }]))
    }
    const bytes = chunks.reduce((sum, c) => sum + c.byteLength, 0)
    if (!bytes) return []
    const buffer = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    let offset = 0
    for (const c of chunks) { this.device.queue.writeBuffer(buffer, offset, c); offset += c.byteLength }
    return [{ buffer, count: bytes / 32, stride: 32 }]
  }

  dispose() {
    for (const parts of this.parts) for (const p of parts) p.buffer.destroy()
    for (const m of this.materials) m.destroy()
    this.quad.destroy(); this.far.destroy(); this.near?.destroy(); this.mid?.destroy(); this.uniform.destroy()
  }
}
