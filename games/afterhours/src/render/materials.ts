import * as THREE from "three/webgpu"
import {
  abs,
  clamp,
  float,
  floor,
  fract,
  fwidth,
  hash,
  interleavedGradientNoise,
  log2,
  max,
  min,
  mix as tslMix,
  normalMap as tslNormalMap,
  normalWorldGeometry,
  positionWorld,
  screenCoordinate,
  sin,
  smoothstep as tslSmoothstep,
  sqrt,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
} from "three/tsl"
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js"
import type { LabControl, LabSettings } from "@arcade/kit/lab-panel"

// MIGRATION NOTE (shader count, docs/boot-architecture.md). Every library material is now a member of a shared
// surface class: all members of a class compile to ONE shader, because the per-material constants live in
// `SurfaceMaterial.surfaceParams` and its scans in `surfaceSlots`, read per object at draw time. No vertex or instance
// attribute is needed to pick a variant; the material object is the variant.
//   - `material(name)` works as before. Each name is a member of: ground (asphalt, asphalt_lot, road_line_*, gravel,
//     concrete_floor) · natural (forest_floor, grass, dirt) · scan (concrete_wall/dark/floor_dry/block, bark, wood_pole,
//     metal_galvanized, metal_dark, ceiling_tile, terrazzo, painted_wall) · paint (metal_painted, door_steel) ·
//     tile (tile_green, tile_green_dark) · flat (barbed_wire, rubber, plastic_orange, chrome, glass_dark) ·
//     emissive (glass_lit, emissive_sodium, emissive_fluorescent) · singletons linoleum, pine_needles, pine_foliage,
//     chainlink, car_paint (MeshPhysical).
//   - One-off colours/glows/thin glass: use `materialFor("flat", { color, roughness, metalness, emissive, intensity,
//     transparent, side })` or `materialFor("emissive", { color, emissive, intensity })` instead of
//     `new MeshStandardNodeMaterial({ color })`. Any number of these share one shader per flag set.
//   - The shader key still includes on/off material flags: `vertexColors`, `transparent`, `side`, `alphaTest`,
//     `polygonOffset`, `depthWrite`, `fog`, a replaced `positionNode`/`colorNode`, etc. Clones that set the same flags
//     share one shader (e.g. all `.clone()` + `vertexColors = true` road decals: one extra shader in total). Set flags
//     identically across your clones and don't give each clone its own node graph.
//   - Replacing a node (e.g. `colorNode`) on a clone makes that clone a new shader; build such graphs once and reuse
//     the material, or put the variation into a `materialFor` parameter.
//
// The one place surface materials come from. Builders ask for a material by name and give their geometry UVs in
// metres (1 UV unit = 1 m) so every material tiles at real-world scale; the material owns its texture repeat.
//
// Textured materials sample CC0 scans from public/textures/<set>/ as GPU-compressed KTX2 (albedo = colour + roughness,
// surface = normal XY + AO + metalness; built by scripts/fetch-textures.ts, sources in public/textures/CREDITS.md). Tile, linoleum, chain-link, glass,
// the pine card and the emissives are procedural. Outdoor ground (asphalt, lot, road paint, concrete floor, gravel)
// is wet: a world-space puddle mask from a tiling noise texture turns flat cavities into near-mirror water and leaves
// a darker, glossy film elsewhere, driven by the global `materials.*` settings below.

export type MaterialName =
  | "asphalt"
  | "asphalt_lot"
  | "road_line_yellow"
  | "road_line_white"
  | "gravel"
  | "forest_floor"
  | "grass"
  | "dirt"
  | "concrete_wall"
  | "concrete_dark"
  | "concrete_floor"
  /** Indoor concrete slab: same scan as `concrete_floor`, never wet. */
  | "concrete_floor_dry"
  /** Painted CMU block wall, 400×200 mm running bond with mortar joints (UV metres, U along the wall, V up). */
  | "concrete_block"
  | "bark"
  /** Alpha-tested pine branch card (UV 0..1 across the card, branch base at v = 0, tip at v = 1). Double-sided. */
  | "pine_needles"
  /** Opaque needle foliage for solid shrub/canopy blobs (no alpha). */
  | "pine_foliage"
  | "wood_pole"
  | "metal_painted"
  | "metal_galvanized"
  | "metal_dark"
  | "chainlink"
  | "barbed_wire"
  | "glass_lit"
  | "glass_dark"
  | "door_steel"
  | "tile_green"
  | "tile_green_dark"
  | "linoleum"
  | "ceiling_tile"
  | "terrazzo"
  | "painted_wall"
  | "rubber"
  | "car_paint"
  | "chrome"
  | "plastic_orange"
  | "emissive_sodium"
  | "emissive_fluorescent"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any
// Node graphs here mix typed and untyped (per-object) nodes; these three are used untyped.
const mix = tslMix as N
const smoothstep = tslSmoothstep as N
const normalMap = tslNormalMap as N

// ---------------------------------------------------------------------------------------------------------------
// Global tunables

export const MATERIAL_SETTINGS = {
  "materials.wetness": 1,
  "materials.puddles": 0.32,
  "materials.puddleScale": 1,
  "materials.groundVariation": 1,
} satisfies LabSettings

const U = {
  wetness: uniform(MATERIAL_SETTINGS["materials.wetness"]),
  puddles: uniform(MATERIAL_SETTINGS["materials.puddles"]),
  puddleScale: uniform(MATERIAL_SETTINGS["materials.puddleScale"]),
  variation: uniform(MATERIAL_SETTINGS["materials.groundVariation"]),
}
const KEYS: Record<keyof typeof MATERIAL_SETTINGS, keyof typeof U> = {
  "materials.wetness": "wetness",
  "materials.puddles": "puddles",
  "materials.puddleScale": "puddleScale",
  "materials.groundVariation": "variation",
}

let bound: LabSettings = MATERIAL_SETTINGS
/** Makes the material uniforms follow a live settings object (e.g. `ctx.settings` after merging MATERIAL_SETTINGS). */
export function bindMaterialSettings(settings: LabSettings) {
  bound = settings
}
for (const [key, name] of Object.entries(KEYS) as [keyof typeof MATERIAL_SETTINGS, keyof typeof U][]) {
  U[name].onFrameUpdate(() => {
    const v = bound[key]
    return typeof v === "number" ? v : MATERIAL_SETTINGS[key]
  })
}

const set = (key: keyof typeof MATERIAL_SETTINGS) => (v: number | string | boolean) => {
  if (typeof v === "number") U[KEYS[key]].value = v
}
export const MATERIAL_CONTROLS: LabControl[] = [
  { key: "materials.wetness", label: "Wetness", group: "Materials", min: 0, max: 1, step: 0.01, change: set("materials.wetness") },
  { key: "materials.puddles", label: "Puddle coverage", group: "Materials", min: 0, max: 0.9, step: 0.01, change: set("materials.puddles") },
  { key: "materials.puddleScale", label: "Puddle size", group: "Materials", unit: "×", min: 0.3, max: 3, step: 0.05, change: set("materials.puddleScale") },
  { key: "materials.groundVariation", label: "Ground macro variation", group: "Materials", min: 0, max: 2, step: 0.05, change: set("materials.groundVariation") },
]

// ---------------------------------------------------------------------------------------------------------------
// Textures

const BASE = `${import.meta.env.BASE_URL}textures/`
const textures = new Map<string, THREE.Texture>()
const ready = new Map<string, Promise<void>>()
let anisotropy = 8

type Kind = "albedo" | "surface"

/**
 * A scanned map from public/textures/<set>/<kind>.ktx2 (Basis UASTC, transcoded to BC7/ASTC in a worker). Returns a
 * placeholder texture at once and fills it with the compressed mip chain when it arrives, so node graphs can be built
 * before loading finishes; `loadMaterials` waits for all of them.
 *   albedo:  RGB colour (sRGB) + A roughness
 *   surface: RG normal XY (OpenGL) + B AO + A metalness
 */
function map(setName: SetName, kind: Kind): THREE.Texture {
  const key = `${setName}/${kind}`
  const hit = textures.get(key)
  if (hit) return hit
  const t = new THREE.CompressedTexture([], 1, 1)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = kind === "albedo" ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.anisotropy = anisotropy
  t.name = key
  textures.set(key, t)
  return t
}

let ktx2: KTX2Loader | null = null
function fill(key: string, t: THREE.Texture): Promise<void> {
  const loaded = ktx2!.loadAsync(`${BASE}${key}.ktx2`).then((src) => {
    const c = t as THREE.CompressedTexture
    c.mipmaps = src.mipmaps
    c.image = src.image
    c.format = src.format
    c.type = src.type
    c.generateMipmaps = false
    c.minFilter = THREE.LinearMipmapLinearFilter
    c.magFilter = THREE.LinearFilter
    c.flipY = false
    c.anisotropy = anisotropy
    c.needsUpdate = true
  })
  ready.set(key, loaded)
  return loaded
}

/**
 * Tiling value-noise fbm, four independent histogram-equalised channels (value = percentile, so thresholds are
 * coverage fractions). R: blobs (4 cells/tile), G: 8, B: 16, A: 32. Precomputed by scripts/fetch-textures.ts.
 */
const NOISE_SIZE = 512
let noiseTex: THREE.DataTexture | null = null
function noise(): THREE.DataTexture {
  if (noiseTex) return noiseTex
  const t = new THREE.DataTexture(new Uint8Array(NOISE_SIZE * NOISE_SIZE * 4), NOISE_SIZE, NOISE_SIZE, THREE.RGBAFormat)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.magFilter = THREE.LinearFilter
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.generateMipmaps = true
  t.colorSpace = THREE.NoColorSpace
  t.name = "materials/noise"
  noiseTex = t
  return t
}
/** World-space noise lookup: `period` metres per noise tile. */
const wnoise = (p: N, period: number): N => texture(noise(), p.mul(1 / period))

/** Pine branch card: RGBA canvas, branch base at the bottom (v = 0). */
let cardTex: THREE.Texture | null = null
function pineCard(): THREE.Texture {
  if (cardTex) return cardTex
  const W = 512
  const H = 1024
  const canvas = document.createElement("canvas")
  canvas.width = W
  canvas.height = H
  const g = canvas.getContext("2d")!
  let seed = 7
  const r = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
  const needle = (x: number, y: number, ang: number, len: number) => {
    const shade = 0.55 + r() * 0.45
    g.strokeStyle = `rgb(${Math.round(34 * shade + 6)},${Math.round(58 * shade + 8)},${Math.round(30 * shade + 6)})`
    g.lineWidth = 2.2 + r() * 1.4
    g.beginPath()
    g.moveTo(x, y)
    const bend = (r() - 0.5) * 0.25
    g.quadraticCurveTo(x + Math.cos(ang + bend) * len * 0.5, y - Math.sin(ang + bend) * len * 0.5, x + Math.cos(ang) * len, y - Math.sin(ang) * len)
    g.stroke()
  }
  const twig = (x0: number, y0: number, ang: number, len: number, width: number, depth: number) => {
    const steps = Math.ceil(len / 6)
    let x = x0
    let y = y0
    let a = ang
    const pts: [number, number, number][] = []
    for (let i = 0; i <= steps; i++) {
      pts.push([x, y, a])
      a += (r() - 0.5) * 0.06
      x += Math.cos(a) * (len / steps)
      y -= Math.sin(a) * (len / steps)
    }
    // Needles first so the twig reads on top near its base.
    for (const [px, py, pa] of pts) {
      const t = 1 - pts.indexOf(pts.find((q) => q[0] === px && q[1] === py)!) / pts.length
      const nl = (38 + r() * 26) * (0.55 + 0.45 * Math.min(1, t * 2.2))
      for (const side of [-1, 1]) {
        if (r() < 0.15) continue
        needle(px, py, pa + side * (0.75 + r() * 0.5), nl)
      }
      if (r() < 0.55) needle(px, py, pa + (r() - 0.5) * 0.5, nl * 0.7)
    }
    g.strokeStyle = "rgb(52,36,24)"
    g.lineCap = "round"
    g.lineWidth = width
    g.beginPath()
    g.moveTo(pts[0]![0], pts[0]![1])
    for (const [px, py] of pts) g.lineTo(px, py)
    g.stroke()
    if (depth > 0) {
      for (let i = 3; i < pts.length - 4; i += 5 + Math.floor(r() * 4)) {
        const [px, py, pa] = pts[i]!
        const side = (i / 5) % 2 < 1 ? 1 : -1
        twig(px, py, pa + side * (0.55 + r() * 0.35), len * (0.42 - (i / pts.length) * 0.3) * (0.8 + r() * 0.4), width * 0.55, depth - 1)
      }
    }
  }
  g.lineCap = "round"
  twig(W / 2, H - 6, Math.PI / 2, H * 0.94, 9, 1)
  const t = new THREE.CanvasTexture(canvas)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = anisotropy
  t.name = "materials/pine_card"
  cardTex = t
  return t
}

/**
 * Called once after the renderer exists. Starts every texture download (transcoded off the main thread) and resolves
 * when all are on their textures; materials can be built before that, their maps fill in when ready.
 */
export async function loadMaterials(renderer: THREE.WebGPURenderer) {
  anisotropy = Math.min(16, renderer.getMaxAnisotropy?.() ?? 8)
  for (const t of textures.values()) t.anisotropy = anisotropy
  ktx2 ??= new KTX2Loader().setTranscoderPath(`${BASE}basis/`).setWorkerLimit(Math.max(4, Math.min(8, navigator.hardwareConcurrency - 2))).detectSupport(renderer)
  for (const [setName, spec] of Object.entries(SETS) as [SetName, (typeof SETS)[SetName]][]) {
    for (const kind of spec.kinds) {
      const t = map(setName, kind)
      if (!ready.has(t.name)) fill(t.name, t)
    }
  }
  const tex = noise()
  const bytes = fetch(`${BASE}noise.bin`)
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`noise.bin: HTTP ${r.status}`))))
    .then((buf) => {
      ;(tex.image as { data: Uint8Array }).data = new Uint8Array(buf)
      tex.needsUpdate = true
    })
  await Promise.all([...ready.values(), bytes])
}

// ---------------------------------------------------------------------------------------------------------------
// Sampling helpers

/** Metres covered by one tile of each scanned set, and which of its maps exist. */
const BOTH = ["albedo", "surface"] as const
const SETS = {
  asphalt: { size: 3.5, kinds: BOTH },
  asphalt_lot: { size: 2.6, kinds: BOTH },
  gravel: { size: 1.5, kinds: BOTH },
  forest_floor: { size: 1.75, kinds: BOTH },
  forest_moss: { size: 2, kinds: BOTH },
  grass: { size: 2, kinds: BOTH },
  dirt: { size: 1.4, kinds: BOTH },
  concrete_wall: { size: 1.8, kinds: BOTH },
  concrete_dark: { size: 2, kinds: BOTH },
  concrete_floor: { size: 3, kinds: BOTH },
  bark: { size: 1.2, kinds: BOTH },
  wood_pole: { size: 1, kinds: BOTH },
  metal_painted: { size: 1.2, kinds: BOTH },
  metal_galvanized: { size: 1, kinds: BOTH },
  metal_dark: { size: 1, kinds: BOTH },
  ceiling_tile: { size: 3.66, kinds: BOTH },
  terrazzo: { size: 0.6, kinds: BOTH },
  plaster: { size: 2, kinds: BOTH },
  /** Roughness only (albedo alpha). */
  imperfections: { size: 1.5, kinds: ["albedo"] as const },
} as const
type SetName = keyof typeof SETS

// ---------------------------------------------------------------------------------------------------------------
// Surface classes
//
// Each class builds its TSL node graph once. Every material of the class is its own `SurfaceMaterial` object that
// shares those node instances and carries its constants in `surfaceParams` (vec4 slots) and its scanned maps in
// `surfaceSlots`; per-object uniforms and texture bindings read them when each object draws. three keys node builds
// on the graph's node ids plus the material's on/off flags, so all materials of a class (and their clones, as long
// as flags like vertexColors / side / transparent / polygonOffset / positionNode match) compile to one shader.

const PARAM_SLOTS = 6

/** A library material: a shared class graph plus per-material constants. Clones keep both. */
export class SurfaceMaterial extends THREE.MeshStandardNodeMaterial {
  surfaceClass = ""
  surfaceParams = new Float32Array(PARAM_SLOTS * 4)
  surfaceSlots: THREE.Texture[] = []
  override copy(source: THREE.MeshStandardNodeMaterial): this {
    super.copy(source)
    if (source instanceof SurfaceMaterial) {
      this.surfaceClass = source.surfaceClass
      this.surfaceParams = source.surfaceParams.slice()
      this.surfaceSlots = [...source.surfaceSlots]
    }
    return this
  }
}

type ObjFrame = { material?: Partial<SurfaceMaterial> | null }

/** Per-object vec4 constants of one class: `p[i]` reads `material.surfaceParams[4i..4i+3]` for each object drawn. */
function classParams(): N[] {
  return Array.from({ length: PARAM_SLOTS }, (_, i) =>
    (uniform(new THREE.Vector4()) as N).onObjectUpdate((frame: ObjFrame, self: { value: THREE.Vector4 }) => {
      const p = frame.material?.surfaceParams
      if (p) self.value.fromArray(p, i * 4)
    }),
  )
}

/** Texture nodes of the class graph being built, per slot; `member` rebinds them for each object drawn. */
let slotNodes: N[][] = []

/**
 * Per-object texture slot: a sampler of `material.surfaceSlots[slot]` at `uvn`. `initial` decides the colour space
 * and must differ between slots of one class (bindings are shared by texture identity at build time).
 */
function slotSampler(slot: number, initial: THREE.Texture) {
  return (uvn: N): N => {
    const node = texture(initial, uvn) as N
    ;(slotNodes[slot] ??= []).push(node)
    return node
  }
}

/**
 * A uniform that stays 1 and, before each object draws, points the class's slot texture nodes at that object's
 * material textures (TextureNode manages its own update type, so the swap rides on this node instead).
 */
function slotBinder(nodes: N[][]): N {
  return (uniform(1) as N).onObjectUpdate((frame: ObjFrame) => {
    const slots = frame.material?.surfaceSlots
    if (!slots) return
    for (let i = 0; i < nodes.length; i++) {
      const t = slots[i]
      if (t) for (const n of nodes[i]!) n.value = t
    }
  })
}

/** Surface channels: colour (linear), roughness, packed tangent-space normal (0..1), AO, metalness. */
type Surf = { color: N; rough: N; normal: N; ao: N; metal: N }

/** Samples an albedo + surface slot pair at `uvn / size`. */
function sampleSlots(albedo: (u: N) => N, surface: ((u: N) => N) | null, uvn: N, size: N): Surf {
  const p = uvn.div(size)
  const a = albedo(p)
  if (!surface) return { color: a.rgb, rough: a.a, normal: FLAT, ao: float(1), metal: float(0) }
  const s = surface(p)
  const xy = s.rg.mul(2).sub(1)
  const z = sqrt(float(1).sub(xy.dot(xy)).max(0))
  return { color: a.rgb, rough: a.a, normal: vec3(s.rg, z.mul(0.5).add(0.5)), ao: s.b, metal: s.a }
}

/** A fixed set (same for every member of a class), sampled at `uvn / size`. */
function sample(name: SetName, uvn: N = uv(), size: N = float(SETS[name].size)): Surf {
  const hasSurface = (SETS[name].kinds as readonly Kind[]).includes("surface")
  return sampleSlots((p) => texture(map(name, "albedo"), p), hasSurface ? (p) => texture(map(name, "surface"), p) : null, uvn, size)
}

/**
 * Breaks visible repetition: blends a sample with a rotated, slightly rescaled copy of itself by a world-space noise
 * mask (the rotated normal is turned back into the surface's tangent frame). `amount` 0 = plain sample.
 */
function antiTile(albedo: (u: N) => N, surface: (u: N) => N, uvn: N, size: N, amount: N): Surf {
  const A = sampleSlots(albedo, surface, uvn, size)
  const ang = 0.63
  const ca = Math.cos(ang)
  const sa = Math.sin(ang)
  const ruv = vec2(uvn.x.mul(ca).sub(uvn.y.mul(sa)), uvn.x.mul(sa).add(uvn.y.mul(ca))).add(vec2(13.7, 5.3))
  const B = sampleSlots(albedo, surface, ruv, size.mul(1.13))
  const bn = B.normal.mul(2).sub(1)
  const bnr = vec3(bn.x.mul(ca).add(bn.y.mul(sa)), bn.y.mul(ca).sub(bn.x.mul(sa)), bn.z).mul(0.5).add(0.5)
  const w = smoothstep(0.32, 0.68, texture(noise(), positionWorld.xz.div(size.mul(2.7))).b).mul(amount)
  return {
    color: mix(A.color, B.color, w),
    rough: mix(A.rough, B.rough, w),
    normal: mix(A.normal, bnr, w),
    ao: mix(A.ao, B.ao, w),
    metal: mix(A.metal, B.metal, w),
  }
}

const luma = (c: N): N => c.dot(vec3(0.2126, 0.7152, 0.0722))
const saturate = (c: N, s: N): N => mix(vec3(luma(c)), c, s)
const FLAT = vec3(0.5, 0.5, 1)

/** Large-scale tint/brightness drift in world space so kilometre-scale ground never reads as a repeat. */
function macro(color: N, amount: N, greenShift: N): N {
  const p = positionWorld.xz
  const big = wnoise(p, 260).r
  const mid = wnoise(p, 70).g
  const k = U.variation.mul(amount)
  const bright = mix(float(1), mix(float(0.62), float(1.32), big.mul(0.65).add(mid.mul(0.35))), k)
  const green = vec3(float(0.9).add(greenShift), float(1.02).add(greenShift), 0.94)
  const hue = mix(vec3(1), mix(vec3(1.06, 0.98, 0.9), green, mid), k)
  return color.mul(bright).mul(hue)
}

/**
 * Wet ground: darker albedo and a glossy film everywhere, standing water (near-mirror, flat normal) where a
 * world-space noise mask plus surface cavities fall below the waterline, only on upward-facing surfaces.
 * porosity: albedo darkening under the film; film: film roughness; puddles: coverage multiplier.
 */
function wet(s: Surf, porosity: N, film: N, puddles: N): Surf {
  const w = U.wetness
  const p = positionWorld.xz.div(U.puddleScale)
  const up = smoothstep(0.82, 0.97, normalWorldGeometry.y)
  // Percentile-equalised noise; cavities (low AO) collect water first.
  const h = wnoise(p, 41).r.mul(0.62).add(wnoise(p, 13).g.mul(0.38)).add(s.ao.oneMinus().mul(0.35))
  const line = float(1.12).sub(U.puddles.mul(puddles).mul(0.82))
  const puddle = smoothstep(line, line.add(0.035), h).mul(up).mul(smoothstep(0.15, 0.6, w))
  // Damp edge around each puddle, and streaky drying elsewhere.
  const edge = smoothstep(line.sub(0.09), line, h).mul(up)
  const dry = wnoise(p, 9).b
  const filmAmt = w.mul(mix(float(0.8), float(1), dry)).max(edge.mul(w))
  const filmRough = mix(film, film.add(0.1), dry)
  let color = s.color.mul(mix(float(1), float(1).sub(porosity), filmAmt))
  color = mix(color, color.mul(0.55), puddle)
  // Wet aggregate tips: sparse near-mirror glints that keep the scan's micro normal, so lamps sparkle and streak.
  // Spots are ~11 mm: once a pixel covers several, blend to their average coverage instead of sparkling per frame.
  const gn = texture(noise(), positionWorld.xz.mul(1 / 0.35)).a
  const glintFade = smoothstep(0.003, 0.012, footprint(positionWorld.xz))
  const glint = mix(aaStep(float(0.9), gn, 0.03), float(0.1), glintFade).mul(filmAmt)
  let rough = mix(s.rough, min(s.rough, filmRough), filmAmt)
  rough = mix(rough, float(0.04), glint)
  rough = mix(rough, float(0.035), puddle)
  // The film fills some of the micro relief (the rest breaks reflections into streaks); standing water is flat.
  const normal = mix(mix(s.normal, FLAT, filmAmt.mul(0.3)), FLAT, puddle)
  return { ...s, color, rough, normal }
}

/** Damp natural ground: darker and a little glossier, no standing water. */
function damp(s: Surf, amount: N, gloss: N): Surf {
  const f = U.wetness.mul(amount)
  return { ...s, color: s.color.mul(mix(float(1), float(0.72), f)), rough: mix(s.rough, s.rough.mul(gloss), f) }
}

type Graph = {
  color: N
  rough: N
  metal: N
  normal?: N
  normalScale?: N
  ao?: N
  emissive?: N
  opacity?: N
  alphaTest?: N
}

type ClassDef = {
  /** Builds the shared graph once; `p` are the per-object vec4 constants. */
  graph: (p: N[]) => Graph
  /** Texture slots each member fills (in order), and the texture each slot starts on. */
  slots?: () => THREE.Texture[]
  /** Material flags common to the class (they are part of the shader key). */
  flags?: (m: SurfaceMaterial) => void
  physical?: boolean
}

type ClassState = { def: ClassDef; graph: Graph | null; slots: THREE.Texture[] }
const classes = new Map<string, ClassState>()

function defineClass(name: string, def: ClassDef) {
  classes.set(name, { def, graph: null, slots: [] })
}

/** A new member of `cls` with the given constants (vec4 slots, flattened) and textures. */
function member(cls: string, params: readonly number[], slots: THREE.Texture[] = []): SurfaceMaterial {
  const c = classes.get(cls)
  if (!c) throw new Error(`unknown surface class ${cls}`)
  if (!c.graph) {
    c.slots = c.def.slots?.() ?? []
    slotNodes = []
    const g = c.def.graph(classParams())
    // Rides on colour, roughness and AO so a clone that replaces one of them still rebinds its textures.
    if (slotNodes.length) {
      const bind = slotBinder(slotNodes)
      g.color = g.color.mul(bind)
      g.rough = g.rough.mul(bind)
      if (g.ao) g.ao = g.ao.mul(bind)
    }
    slotNodes = []
    c.graph = g
  }
  const g = c.graph
  const m = new SurfaceMaterial()
  m.surfaceClass = cls
  m.surfaceParams.set(params.slice(0, PARAM_SLOTS * 4))
  m.surfaceSlots = slots.length ? slots : c.slots
  m.colorNode = g.color
  m.roughnessNode = g.rough
  m.metalnessNode = g.metal
  if (g.normal) m.normalNode = normalMap(g.normal, g.normalScale ? vec2(g.normalScale, g.normalScale) : null)
  if (g.ao) m.aoNode = g.ao
  if (g.emissive) m.emissiveNode = g.emissive
  if (g.opacity) m.opacityNode = g.opacity
  if (g.alphaTest) m.alphaTestNode = g.alphaTest
  c.def.flags?.(m)
  return m
}

const rgb = (c: THREE.ColorRepresentation) => {
  const k = new THREE.Color(c)
  return [k.r, k.g, k.b] as const
}

// ---- ground: wet outdoor ground and road paint ------------------------------------------------------------------
// p0 size, antiTile, saturation, macro   p1 tint rgb, normalScale   p2 roughA, roughB, porosity, film
// p3 puddles, paint amount              p4 paint rgb
defineClass("ground", {
  slots: () => [map("asphalt", "albedo"), map("asphalt", "surface")],
  graph: (p) => {
    const s0 = antiTile(slotSampler(0, map("asphalt", "albedo")), slotSampler(1, map("asphalt", "surface")), uv(), p[0].x, p[0].y)
    const wp = positionWorld.xz
    // Thermoplastic worn through by tyres: patches of asphalt show where the noise drops.
    const wear = smoothstep(0.06, 0.26, wnoise(wp, 7).r.mul(0.55).add(wnoise(wp, 1.3).a.mul(0.45))).mul(p[3].y)
    const base = macro(saturate(s0.color, p[0].z).mul(p[1].xyz), p[0].w, float(0))
    const color = mix(base, p[4].xyz.mul(mix(float(0.8), float(1), s0.ao)), wear)
    const rough = mix(s0.rough.mul(p[2].x).add(p[2].y), float(0.55), wear)
    const normal = mix(s0.normal, FLAT, wear.mul(0.6))
    const s = wet({ ...s0, color, rough, normal }, p[2].z, p[2].w, p[3].x)
    return { color: s.color, rough: clamp(s.rough, 0.02, 1), metal: float(0), normal: s.normal, normalScale: p[1].w, ao: s.ao }
  },
})
type GroundOpts = { set: SetName; antiTile: boolean; sat: number; macro: boolean; tint: number | readonly [number, number, number]; normalScale: number; rough: [number, number]; porosity: number; film: number; puddles: number; paint?: readonly [number, number, number] }
function ground(o: GroundOpts) {
  const t = typeof o.tint === "number" ? [o.tint, o.tint, o.tint] : o.tint
  const paint = o.paint ?? [0, 0, 0]
  return member(
    "ground",
    [SETS[o.set].size, o.antiTile ? 1 : 0, o.sat, o.macro ? 1 : 0, ...t, o.normalScale, ...o.rough, o.porosity, o.film, o.puddles, o.paint ? 1 : 0, 0, 0, ...paint, 0],
    [map(o.set, "albedo"), map(o.set, "surface")],
  )
}

// ---- natural: forest floor, grass, dirt (damp, macro variation, optional moss layer) ---------------------------
// p0 sizeA, sizeB, moss amount, green shift   p1 tintA rgb, satA   p2 tintB rgb, satB   p3 damp, gloss, normalScale
defineClass("natural", {
  slots: () => [map("forest_floor", "albedo"), map("forest_floor", "surface"), map("forest_moss", "albedo"), map("forest_moss", "surface")],
  graph: (p) => {
    const A = antiTile(slotSampler(0, map("forest_floor", "albedo")), slotSampler(1, map("forest_floor", "surface")), uv(), p[0].x, float(1))
    const B = sampleSlots(slotSampler(2, map("forest_moss", "albedo")), slotSampler(3, map("forest_moss", "surface")), uv(), p[0].y)
    const w = smoothstep(0.55, 0.8, wnoise(positionWorld.xz, 31).r.mul(0.7).add(wnoise(positionWorld.xz, 7).a.mul(0.3))).mul(p[0].z)
    const color = mix(saturate(A.color, p[1].w).mul(p[1].xyz), saturate(B.color, p[2].w).mul(p[2].xyz), w.mul(0.7))
    const s0: Surf = {
      color: macro(color, float(1), p[0].w),
      rough: mix(A.rough, B.rough, w),
      normal: mix(A.normal, B.normal, w),
      ao: mix(A.ao, B.ao.mul(0.5).add(0.5), w),
      metal: float(0),
    }
    const s = damp(s0, p[3].x, p[3].y)
    return { color: s.color, rough: clamp(s.rough, 0.02, 1), metal: float(0), normal: s.normal, normalScale: p[3].z, ao: s.ao }
  },
})
type NaturalOpts = { set: SetName; moss?: SetName; tint: readonly [number, number, number]; sat: number; mossTint?: readonly [number, number, number]; mossSat?: number; green: number; damp: number; gloss: number; normalScale: number }
function natural(o: NaturalOpts) {
  const moss = o.moss ?? o.set
  return member(
    "natural",
    [SETS[o.set].size, SETS[moss].size, o.moss ? 1 : 0, o.green, ...o.tint, o.sat, ...(o.mossTint ?? o.tint), o.mossSat ?? o.sat, o.damp, o.gloss, o.normalScale, 0],
    [map(o.set, "albedo"), map(o.set, "surface"), map(moss, "albedo"), map(moss, "surface")],
  )
}

/**
 * Box-filtered coverage of periodic joints: `t` in period units with a joint of width `k` (fraction of a period)
 * centred on every integer, averaged over a footprint of `w` periods. Exact integral of the pulse train, so a joint
 * thinner than a pixel fades to its average coverage `k` instead of crawling under TAA jitter.
 */
function jointCoverage(t: N, k: N, w: N): N {
  const x: N = t.add(k.mul(0.5))
  const F = (v: N): N => floor(v).mul(k).add(min(fract(v), k))
  const fw: N = w.max(1e-4)
  return clamp(F(x.add(fw.mul(0.5))).sub(F(x.sub(fw.mul(0.5)))).div(fw), 0, 1)
}

/** Anti-aliased threshold of a procedural value: smoothstep over ± its screen-space derivative (at least `soft`). */
function aaStep(edge: N, x: N, soft = 0.01): N {
  const w: N = max(fwidth(x), float(soft))
  return smoothstep(edge.sub(w), edge.add(w), x)
}

/** Metres of surface under one pixel at `uvn` (UV metres). */
const footprint = (uvn: N): N => max(fwidth(uvn.x), fwidth(uvn.y))

/**
 * Rectangular unit grid in UV metres (blocks, tiles, slabs): `w`×`h` units with `joint`-wide joints, every other row
 * shifted by `bond` of a unit (0.5 = running bond). All inputs may be per-object nodes. Returns the unit id, a 0..1
 * joint mask (box-filtered: thin joints fade to their average), bevel normals that roll into each joint over `bevel`
 * metres (faded to flat once the bevel is smaller than a pixel), and `detail`, 1 near and → 0 once a whole unit spans
 * only a few pixels (for per-unit tilt/tint that would otherwise flicker at unit edges).
 */
function unitGrid(uvn: N, w: N, h: N, joint: N, bond: N, bevel: N) {
  const row: N = floor(uvn.y.div(h))
  const shift: N = fract(row.mul(0.5)).mul(2).mul(bond).mul(w)
  const q: N = vec2(uvn.x.add(shift), uvn.y)
  const cell: N = vec2(w, h)
  const id: N = floor(q.div(cell))
  const f: N = q.sub(id.mul(cell))
  const ex: N = min(f.x, w.sub(f.x))
  const ey: N = min(f.y, h.sub(f.y))
  const half: N = joint.mul(0.5)
  // Derivatives from the continuous UV (the row shift jumps at row edges).
  const ax: N = fwidth(uvn.x).max(1e-6)
  const ay: N = fwidth(uvn.y).max(1e-6)
  // 1.5 px box: wide enough that TAA's ±½ px jitter barely changes a joint's coverage from frame to frame.
  const cx: N = jointCoverage(q.x.div(w), joint.div(w), ax.mul(1.5).div(w))
  const cy: N = jointCoverage(q.y.div(h), joint.div(h), ay.mul(1.5).div(h))
  const mask: N = float(1).sub(float(1).sub(cx).mul(float(1).sub(cy)))
  const fp: N = max(ax, ay)
  const bevelFade: N = float(1).sub(smoothstep(bevel.mul(0.35), bevel.mul(1.5), fp))
  const sx: N = f.x.lessThan(w.mul(0.5)).select(float(-1), float(1))
  const sy: N = f.y.lessThan(h.mul(0.5)).select(float(-1), float(1))
  const bx: N = smoothstep(half.add(bevel), half, ex).mul(sx).mul(bevelFade)
  const by: N = smoothstep(half.add(bevel), half, ey).mul(sy).mul(bevelFade)
  const detail: N = float(1).sub(smoothstep(min(w, h).div(16), min(w, h).div(5), fp))
  const rnd: N = hash(id.x.add(311).mul(157.31).add(id.y.add(197).mul(91.7)))
  const rnd2: N = hash(id.x.add(53).mul(71.9).add(id.y.add(11).mul(213.3)))
  return { id, f, mask, bx, by, rnd, rnd2, detail }
}

/** Glazed/waxed tile normal: bevel roll-off plus a per-tile tilt that fades with distance. Packed 0..1. */
function tileNormal(g: ReturnType<typeof unitGrid>, bevel: number, tilt: number): N {
  const tx: N = g.rnd.sub(0.5).mul(tilt).mul(g.detail)
  const ty: N = g.rnd2.sub(0.5).mul(tilt).mul(g.detail)
  const nxy: N = vec2(g.bx.mul(bevel).add(tx), g.by.mul(bevel).add(ty)).mul(g.mask.oneMinus())
  return vec3(nxy, sqrt(float(1).sub(nxy.dot(nxy)).max(0.2))).normalize().mul(0.5).add(0.5)
}

// ---- scan: scanned walls, wood, bark, ceiling, terrazzo, bare metals --------------------------------------------
// p0 size, antiTile, saturation, normalScale   p1 tint rgb, metal from map   p2 roughA, roughB, metal, imperfection
// p3 imperfection size, streak stain, uv stain, spangle
defineClass("scan", {
  slots: () => [map("concrete_wall", "albedo"), map("concrete_wall", "surface")],
  graph: (p) => {
    const s = antiTile(slotSampler(0, map("concrete_wall", "albedo")), slotSampler(1, map("concrete_wall", "surface")), uv(), p[0].x, p[0].y)
    const wp = positionWorld
    // Rain-streaked staining running down every face (world space, so it ignores each wall's UV orientation).
    const streak = texture(noise(), vec2(wp.x.add(wp.z).div(2.3), wp.y.div(26))).g
    const blot = wnoise(vec2(wp.x.add(wp.z), wp.y), 9).r
    const worldStain = smoothstep(0.45, 0.95, streak).mul(0.38).add(smoothstep(0.6, 0.95, blot).mul(0.18)).mul(p[3].y)
    const uvStain = smoothstep(0.78, 0.97, wnoise(uv(), 5).r).mul(0.35).mul(p[3].z)
    const spangle = texture(noise(), uv().mul(9)).a
    const imp = sample("imperfections", uv(), p[3].x)
    // Optional unit grid (CMU blocks, terrazzo slabs): joints, per-unit tint, recessed joint normals. p4.x = 0 disables.
    const on = p[4].x.greaterThan(0).select(float(1), float(0))
    const g = unitGrid(uv(), p[4].x.max(0.01), p[4].y.max(0.01), p[4].z, p[4].w, p[5].y)
    const jm = g.mask.mul(on)
    const unitTint = mix(float(1), mix(float(1).sub(p[5].z), float(1).add(p[5].z), g.rnd), on)
    // Contrast around mid-grey (speckle punch for terrazzo); 1 = unchanged.
    const scanCol = max(mix(vec3(0.25), saturate(s.color, p[0].z), p[5].w), vec3(0))
    const color = scanCol
      .mul(p[1].xyz)
      .mul(unitTint)
      .mul(float(1).sub(worldStain))
      .mul(float(1).sub(uvStain))
      .mul(mix(float(1), mix(float(0.88), float(1.06), spangle), p[3].w))
      .mul(float(1).sub(jm.mul(p[5].x)))
    const rough = s.rough.mul(p[2].x).add(p[2].y).add(imp.rough.mul(p[2].w)).add(spangle.mul(0.18).mul(p[3].w)).add(jm.mul(0.4))
    const sn = s.normal.mul(2).sub(1)
    const bev = vec2(g.bx, g.by).mul(on).mul(0.7)
    const normal = vec3(sn.xy.add(bev), sn.z).normalize().mul(0.5).add(0.5)
    return { color, rough: clamp(rough, 0.02, 1), metal: mix(p[2].z, s.metal, p[1].w), normal, normalScale: p[0].w, ao: s.ao.mul(float(1).sub(jm.mul(0.45))) }
  },
})
type ScanOpts = {
  set: SetName
  /** Metres per scan tile (default: the set's). */
  size?: number
  antiTile?: boolean
  sat?: number
  tint: number | readonly [number, number, number]
  normalScale?: number
  rough: [number, number]
  metal?: number
  metalMap?: boolean
  imp?: [amount: number, size: number]
  streaks?: boolean
  stains?: boolean
  spangle?: boolean
  /** Unit grid in metres: block/slab size, joint width, row offset (0.5 = running bond), joint darkening, bevel, per-unit tint ±. */
  grid?: { w: number; h: number; joint: number; bond?: number; dark?: number; bevel?: number; vary?: number }
  /** Albedo contrast about mid-grey (1 = scan as is). */
  contrast?: number
}
function scan(o: ScanOpts) {
  const t = typeof o.tint === "number" ? [o.tint, o.tint, o.tint] : o.tint
  return member(
    "scan",
    [
      o.size ?? SETS[o.set].size, o.antiTile ? 1 : 0, o.sat ?? 1, o.normalScale ?? 1,
      ...t, o.metalMap ? 1 : 0,
      ...o.rough, o.metal ?? 0, o.imp?.[0] ?? 0,
      o.imp?.[1] ?? 1, o.streaks ? 1 : 0, o.stains ? 1 : 0, o.spangle ? 1 : 0,
      o.grid?.w ?? 0, o.grid?.h ?? 0, o.grid?.joint ?? 0, o.grid?.bond ?? 0,
      o.grid?.dark ?? 0, o.grid?.bevel ?? 0, o.grid?.vary ?? 0, o.contrast ?? 1,
    ],
    [map(o.set, "albedo"), map(o.set, "surface")],
  )
}

// ---- paint: painted steel with chips and scratches (fixed scan) ---------------------------------------------------
// p0 paint rgb, chipping
defineClass("paint", {
  graph: (p) => {
    const s = sample("metal_painted")
    // The scan is yellow paint; keep only its luminance variation, recolour, and let scratches show steel.
    const scratch = smoothstep(0.55, 0.85, s.metal)
    const chip = smoothstep(float(1).sub(p[0].w.mul(0.3)), 1, wnoise(uv(), 0.7).a)
    const bare = scratch.max(chip)
    const lum = luma(s.color).div(0.45)
    const color = mix(p[0].xyz.mul(mix(float(0.85), float(1.08), lum)), vec3(0.32, 0.31, 0.3), bare)
    const rough = mix(float(0.42).add(s.rough.mul(0.45)), float(0.5), bare)
    return { color, rough: clamp(rough, 0.02, 1), metal: bare, normal: s.normal, normalScale: float(0.8), ao: s.ao }
  },
})

// ---- tile: glazed ceramic wall tile with grout -------------------------------------------------------------------
// p0 glaze rgb, tile size (m)   p1 grout rgb, joint (m)
defineClass("tile", {
  graph: (p) => {
    const g = unitGrid(uv(), p[0].w, p[0].w, p[1].w, float(0), float(0.005))
    const imp = sample("imperfections", uv(), float(1.7))
    const tileTint = mix(float(1), mix(float(0.92), float(1.06), g.rnd).mul(mix(vec3(1.02, 0.99, 1), vec3(0.98, 1.01, 1), g.rnd2)), g.detail.mul(0.6).add(0.4))
    const crazing = wnoise(uv(), 0.9).a
    const glazeCol = p[0].xyz.mul(tileTint).mul(mix(float(0.97), float(1.02), crazing))
    const groutCol = p[1].xyz.mul(mix(float(0.6), float(1), wnoise(uv(), 0.7).b))
    const color = mix(glazeCol, groutCol, g.mask)
    const rough = mix(float(0.05).add(imp.rough.mul(0.22)), float(0.85), g.mask)
    // Rounded glaze edge plus a slight per-tile tilt, so highlights break up tile by tile down a corridor.
    const normal = tileNormal(g, 0.6, 0.05)
    return { color, rough: clamp(rough, 0.02, 1), metal: float(0), normal, ao: mix(float(1), float(0.55), g.mask) }
  },
})

// ---- linoleum: waxed VCT floor -------------------------------------------------------------------------------------
defineClass("linoleum", {
  graph: () => {
    const t = unitGrid(uv(), float(0.305), float(0.305), float(0.0025), float(0), float(0.0008))
    // VCT chip marbling, quarter-turned on alternate tiles like a laid floor.
    const turn = fract(t.id.x.add(t.id.y).mul(0.5)).greaterThan(0.25)
    const local = turn.select(vec2(t.f.y, t.f.x), t.f)
    const chips = texture(noise(), local.mul(vec2(1.6, 0.55)).add(t.id.mul(0.37))).a
    const fleck = aaStep(float(0.84), texture(noise(), local.mul(9).add(t.id.mul(0.71))).b, 0.02)
    const tint = mix(float(0.84), float(1.1), t.rnd).mul(mix(vec3(1.02, 0.98, 0.97), vec3(0.97, 1.01, 1.02), t.rnd2))
    let color = vec3(0.36, 0.38, 0.33).mul(tint).mul(mix(float(0.86), float(1.08), chips))
    color = mix(color, vec3(0.16, 0.17, 0.15), fleck.mul(0.6))
    color = mix(color, vec3(0.05, 0.05, 0.045), t.mask)
    const imp = sample("imperfections", uv(), float(2.3))
    const scuff = wnoise(uv(), 3.1).g
    const rough = float(0.04).add(t.rnd2.mul(0.05)).add(imp.rough.mul(0.3)).add(smoothstep(0.7, 0.95, scuff).mul(0.18)).add(t.mask.mul(0.5))
    return { color, rough: clamp(rough, 0.02, 1), metal: float(0), normal: tileNormal(t, 0.55, 0.012), ao: float(1) }
  },
})

// ---- flat: untextured surfaces with optional noise variation, smudge roughness and glow ---------------------------
// p0 colour A rgb, noise scale   p1 colour B rgb, smudge size   p2 roughA, roughB, metalA, metalB
// p3 noise lo, hi, smooth (0/1), smudge roughness   p4 noise channel mask rgba   p5 emissive rgb (linear, × intensity)
defineClass("flat", {
  graph: (p) => {
    const n = texture(noise(), uv().mul(p[0].w)).dot(p[4])
    const span = p[3].y.sub(p[3].x).max(1e-4)
    const lin = clamp(n.sub(p[3].x).div(span), 0, 1)
    const t = mix(lin, lin.mul(lin).mul(float(3).sub(lin.mul(2))), p[3].z)
    const imp = sample("imperfections", uv(), p[1].w)
    return {
      color: mix(p[0].xyz, p[1].xyz, t),
      rough: clamp(mix(p[2].x, p[2].y, t).add(imp.rough.mul(p[3].w)), 0.02, 1),
      metal: mix(p[2].z, p[2].w, t),
      emissive: p[5].xyz,
    }
  },
})
type FlatOpts = {
  color: THREE.ColorRepresentation
  /** Second colour the noise blends toward (default: `color`). */
  color2?: THREE.ColorRepresentation
  roughness?: number
  roughness2?: number
  metalness?: number
  metalness2?: number
  /** Noise variation: tiles per metre, channel 0..3 (R 4, G 8, B 16, A 32 cells per tile), lo/hi window, smoothstep. */
  noise?: { scale: number; channel: 0 | 1 | 2 | 3; lo?: number; hi?: number; smooth?: boolean }
  /** Smudged gloss: roughness added from the imperfection scan, and its tile size (m). */
  smudge?: { amount: number; size: number }
  /** Glow in linear RGB, multiplied by `intensity`. */
  emissive?: THREE.ColorRepresentation
  intensity?: number
}
function flatParams(o: FlatOpts): number[] {
  const c = rgb(o.color)
  const c2 = o.color2 !== undefined ? rgb(o.color2) : c
  const r = o.roughness ?? 0.6
  const m = o.metalness ?? 0
  const mask = [0, 0, 0, 0]
  if (o.noise) mask[o.noise.channel] = 1
  const e = o.emissive !== undefined ? rgb(o.emissive).map((v) => v * (o.intensity ?? 1)) : [0, 0, 0]
  return [
    ...c, o.noise?.scale ?? 1,
    ...c2, o.smudge?.size ?? 1,
    r, o.roughness2 ?? r, m, o.metalness2 ?? m,
    o.noise?.lo ?? 0, o.noise?.hi ?? 1, o.noise?.smooth ? 1 : 0, o.smudge?.amount ?? 0,
    ...mask,
    ...e, 0,
  ]
}
/** Linear-RGB triple from 0..1 values (for colours already given in linear space). */
const lin = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace)

// ---- emissive: lamp lenses and lit windows -----------------------------------------------------------------------
// p0 base rgb, roughness   p1 emissive rgb (× intensity), prism lens   p2 lit-room variation
defineClass("emissive", {
  graph: (p) => {
    // Prismatic acrylic lens: faint fine grid of brighter cells over a flat glow.
    const g = abs(fract(uv().div(0.012)).sub(0.5))
    const prism = mix(mix(float(0.9), float(1.06), smoothstep(0.1, 0.4, max(g.x, g.y))), float(1.01), smoothstep(0.002, 0.006, footprint(uv())))
    // Lit window: warm interior with lamp pools and blinds on some windows.
    const q = uv()
    const room = wnoise(q, 6).r
    const lamp = wnoise(q, 2.2).g
    const blinds = mix(sin(q.y.mul((Math.PI * 2) / 0.045)).mul(0.5).add(0.5), float(0.5), smoothstep(0.008, 0.02, footprint(q)))
    const hasBlinds = smoothstep(0.55, 0.6, wnoise(floor(q.div(1.8)).add(0.5).mul(1.8), 31).b)
    const glow = mix(float(0.55), float(1.25), room.mul(0.6).add(lamp.mul(0.4))).mul(mix(float(1), mix(float(0.55), float(1), blinds), hasBlinds.mul(0.8)))
    const e = p[1].xyz.mul(mix(float(1), prism, p[1].w)).mul(mix(float(1), glow, p[2].x))
    return { color: p[0].xyz, rough: p[0].w, metal: float(0), emissive: e }
  },
})

// ---- singletons (one material each) ---------------------------------------------------------------------------------
defineClass("pine_needles", {
  graph: () => {
    const t = texture(pineCard(), uv())
    // Keep coverage through the mip chain so distant cards don't evaporate.
    const lod = log2(max(fwidth(uv().x).mul(512), fwidth(uv().y).mul(1024)).max(1))
    return { color: t.rgb, rough: float(0.72), metal: float(0), opacity: clamp(t.a.mul(lod.mul(0.35).add(1)), 0, 1) }
  },
  flags: (m) => {
    m.side = THREE.DoubleSide
    m.alphaTest = 0.45
  },
})
defineClass("pine_foliage", {
  graph: () => {
    const p = positionWorld
    const a = texture(noise(), vec2(p.x.add(p.y.mul(0.7)), p.z.sub(p.y.mul(0.4))).mul(3.1)).a
    const b = texture(noise(), vec2(p.z.add(p.y), p.x.sub(p.y)).mul(1.3)).b
    const clump = smoothstep(0.25, 0.75, a.mul(0.6).add(b.mul(0.4)))
    return { color: mix(vec3(0.006, 0.012, 0.007), vec3(0.03, 0.055, 0.028), clump), rough: float(0.8), metal: float(0), ao: mix(float(0.45), float(1), clump) }
  },
})
/**
 * Galvanised chain-link: analytic diamond mesh (2" / 50 mm between parallel wires, 3.6 mm wire) in UV metres.
 * Alpha-tested with screen-space dithering once the wire gets thinner than a pixel, so the far fence keeps its
 * average coverage instead of vanishing or turning into a solid sheet. Round-wire normals; double-sided.
 */
defineClass("chainlink", {
  graph: () => {
    const pitch = 0.05
    const hw = 0.0018
    const p = uv()
    const a = p.x.add(p.y).div(pitch * Math.SQRT2)
    const b = p.x.sub(p.y).div(pitch * Math.SQRT2)
    const da = fract(a).sub(0.5).mul(pitch) // signed perpendicular distance to wire centre (m)
    const db = fract(b).sub(0.5).mul(pitch)
    const fw = max(fwidth(da), float(1e-5))
    const hwe = max(float(hw), fw.mul(0.6))
    const cover = (d: N) => clamp(hwe.sub(abs(d)).div(fw).add(0.5), 0, 1).mul(float(hw).div(hwe))
    const opacity = max(cover(da), cover(db))
    // Round wire: lean the normal across the nearer wire.
    const ta = clamp(da.div(hw), -1, 1)
    const tb = clamp(db.div(hw), -1, 1)
    const useA = abs(da).lessThan(abs(db))
    const t = useA.select(ta, tb)
    const dir = useA.select(vec2(0.7071, 0.7071), vec2(0.7071, -0.7071))
    const nxy = dir.mul(t).mul(0.85)
    const normal = vec3(nxy, sqrt(float(1).sub(nxy.dot(nxy)))).mul(0.5).add(0.5)
    const n = wnoise(p, 2.5).r
    return {
      color: vec3(0.5, 0.52, 0.5).mul(mix(float(0.75), float(1.1), n)),
      rough: mix(float(0.38), float(0.6), n),
      metal: float(0.85),
      normal,
      opacity,
      alphaTest: interleavedGradientNoise(screenCoordinate).mul(0.96).add(0.02),
    }
  },
  flags: (m) => {
    m.side = THREE.DoubleSide
    m.alphaTest = 0.5
  },
})

// ---------------------------------------------------------------------------------------------------------------
// Library

const BUILD: Record<MaterialName, () => THREE.Material> = {
  asphalt: () => ground({ set: "asphalt", antiTile: true, sat: 0.5, macro: true, tint: 0.5, normalScale: 1.2, rough: [0.25, 0.7], porosity: 0.6, film: 0.13, puddles: 1 }),
  asphalt_lot: () => ground({ set: "asphalt_lot", antiTile: true, sat: 0.3, macro: true, tint: 0.78, normalScale: 1.1, rough: [0.25, 0.68], porosity: 0.6, film: 0.15, puddles: 1.15 }),
  road_line_yellow: () => ground({ set: "asphalt", antiTile: false, sat: 0.6, macro: false, tint: 0.6, normalScale: 1, rough: [0.25, 0.7], porosity: 0.3, film: 0.12, puddles: 1, paint: rgb(lin(0.55, 0.36, 0.06)) }),
  road_line_white: () => ground({ set: "asphalt", antiTile: false, sat: 0.6, macro: false, tint: 0.6, normalScale: 1, rough: [0.25, 0.7], porosity: 0.3, film: 0.12, puddles: 1, paint: rgb(lin(0.62, 0.62, 0.58)) }),
  gravel: () => ground({ set: "gravel", antiTile: true, sat: 0.6, macro: true, tint: 0.55, normalScale: 1.3, rough: [1, 0], porosity: 0.45, film: 0.38, puddles: 0.55 }),
  concrete_floor: () => ground({ set: "concrete_floor", antiTile: true, sat: 0.4, macro: false, tint: 0.9, normalScale: 1, rough: [0.3, 0.62], porosity: 0.4, film: 0.3, puddles: 0.7 }),
  forest_floor: () =>
    natural({ set: "forest_floor", moss: "forest_moss", tint: [0.42, 0.4, 0.38], sat: 0.8, mossTint: [0.42, 0.46, 0.36], mossSat: 0.75, green: 0.03, damp: 0.6, gloss: 0.8, normalScale: 1.2 }),
  grass: () => natural({ set: "grass", tint: [0.34, 0.33, 0.24], sat: 0.75, green: 0.04, damp: 0.5, gloss: 0.85, normalScale: 1.1 }),
  dirt: () => natural({ set: "dirt", tint: [0.62, 0.62, 0.62], sat: 0.7, green: 0, damp: 0.9, gloss: 0.7, normalScale: 1.2 }),
  concrete_wall: () => scan({ set: "concrete_wall", sat: 0.3, tint: [0.8, 0.83, 0.82], rough: [0.2, 0.76], normalScale: 1.4, streaks: true }),
  concrete_dark: () => scan({ set: "concrete_dark", antiTile: true, sat: 0.35, tint: 0.62, rough: [1, 0], normalScale: 1.2 }),
  concrete_floor_dry: () => scan({ set: "concrete_floor", antiTile: true, sat: 0.4, tint: 0.9, rough: [0.35, 0.45] }),
  bark: () => scan({ set: "bark", sat: 0.8, tint: [0.5, 0.44, 0.4], rough: [0.3, 0.68], normalScale: 1.6 }),
  // Creosote-treated pole weathered grey-brown.
  wood_pole: () => scan({ set: "wood_pole", sat: 0.6, tint: [0.42, 0.33, 0.26], rough: [0.25, 0.7], normalScale: 1.6 }),
  metal_galvanized: () => scan({ set: "metal_galvanized", sat: 0.15, tint: 1.05, rough: [0.6, 0.12], metal: 1, normalScale: 0.6, spangle: true }),
  metal_dark: () => scan({ set: "metal_dark", tint: 0.7, rough: [0.8, 0.25], metalMap: true }),
  ceiling_tile: () => scan({ set: "ceiling_tile", tint: [0.7, 0.69, 0.63], rough: [0, 0.92], normalScale: 0.8, stains: true }),
  // Polished terrazzo in 600 mm slabs with dark divider strips; speckle contrast up, waxed gloss (r5-02).
  terrazzo: () =>
    scan({ set: "terrazzo", size: 0.32, sat: 0.55, tint: [0.7, 0.7, 0.66], contrast: 1.8, rough: [0.06, 0.03], imp: [0.16, 2.1], normalScale: 0.25, grid: { w: 0.6, h: 0.6, joint: 0.004, dark: 0.75, bevel: 0.0015, vary: 0.04 } }),
  // 8×16" (400×200 mm) CMU in running bond, painted over, 10 mm recessed mortar joints (r5-06 dock wall).
  concrete_block: () =>
    scan({ set: "concrete_dark", antiTile: true, sat: 0.3, tint: [0.78, 0.72, 0.6], rough: [0.5, 0.45], normalScale: 1.1, streaks: true, grid: { w: 0.4, h: 0.2, joint: 0.01, bond: 0.5, dark: 0.45, bevel: 0.006, vary: 0.06 } }),
  painted_wall: () => {
    const c = new THREE.Color(0xb8b8a8).multiplyScalar(0.82)
    return scan({ set: "plaster", sat: 0.3, tint: [c.r, c.g, c.b], rough: [0.25, 0.62], normalScale: 0.6 })
  },
  metal_painted: () => member("paint", [...rgb(0x5c615c), 0.35]),
  door_steel: () => member("paint", [...rgb(0x3d5a4b), 0.3]),
  // 6" (152 mm) glazed tile, 4 mm grout: dark grey grout reads as a grid at corridor distances (r3-02, r5-05).
  tile_green: () => member("tile", [...rgb(lin(0.42, 0.53, 0.45)), 0.152, ...rgb(lin(0.11, 0.12, 0.11)), 0.004]),
  tile_green_dark: () => member("tile", [...rgb(lin(0.055, 0.12, 0.085)), 0.152, ...rgb(lin(0.2, 0.21, 0.19)), 0.004]),
  linoleum: () => member("linoleum", []),
  pine_needles: () => member("pine_needles", []),
  pine_foliage: () => member("pine_foliage", []),
  chainlink: () => member("chainlink", []),
  barbed_wire: () =>
    member("flat", flatParams({ color: lin(0.42, 0.43, 0.42), color2: lin(0.16, 0.08, 0.04), roughness: 0.42, roughness2: 0.85, metalness: 1, metalness2: 0.2, noise: { scale: 3, channel: 0, lo: 0.62, hi: 0.9, smooth: true } })),
  rubber: () => member("flat", flatParams({ color: lin(0.0096, 0.0096, 0.0096), color2: lin(0.0168, 0.0168, 0.0168), roughness: 0.72, roughness2: 0.9, noise: { scale: 4, channel: 3 } })),
  plastic_orange: () => {
    const o = new THREE.Color(0xb5561a)
    return member("flat", flatParams({ color: o.clone().multiplyScalar(0.85), color2: o.clone().multiplyScalar(1.05), roughness: 0.38, roughness2: 0.55, noise: { scale: 2, channel: 1 } }))
  },
  chrome: () => member("flat", flatParams({ color: lin(0.78, 0.78, 0.8), roughness: 0.05, metalness: 1, smudge: { amount: 0.25, size: 0.5 } })),
  glass_dark: () => member("flat", flatParams({ color: lin(0.006, 0.008, 0.008), roughness: 0.03, smudge: { amount: 0.22, size: 0.9 } })),
  glass_lit: () => member("emissive", [0.02, 0.018, 0.014, 0.06, 1 * 2.2, 0.66 * 2.2, 0.34 * 2.2, 0, 1, 0, 0, 0]),
  emissive_sodium: () => member("emissive", [0.05, 0.03, 0.01, 0.3, 1 * 9, 0.5 * 9, 0.14 * 9, 0, 0, 0, 0, 0]),
  emissive_fluorescent: () => member("emissive", [0.6, 0.62, 0.6, 0.4, 0.92 * 7, 0.97 * 7, 1 * 7, 1, 0, 0, 0, 0]),
  car_paint: () => {
    const m = new THREE.MeshPhysicalNodeMaterial({ color: 0x3a4a3e, roughness: 0.38, metalness: 0.45, clearcoat: 1, clearcoatRoughness: 0.06 })
    const grime = smoothstep(0.55, 0.95, wnoise(uv(), 1.4).r)
    const c = new THREE.Color(0x2f3d33)
    m.colorNode = vec3(c.r, c.g, c.b).mul(mix(float(1), float(0.75), grime))
    m.clearcoatRoughnessNode = mix(float(0.04), float(0.25), grime)
    return m
  },
}

const cache = new Map<MaterialName, THREE.Material>()

/** The library material `name` (shared; clone it before changing flags). See the migration note at the top. */
export function material(name: MaterialName): THREE.Material {
  const hit = cache.get(name)
  if (hit) return hit
  const build = BUILD[name]
  if (!build) throw new Error(`unknown material ${name}`)
  const m = build()
  m.name = name
  cache.set(name, m)
  return m
}

const forCache = new Map<string, SurfaceMaterial>()

/**
 * A shared-shader material for one-off surfaces that aren't in the library. All `flat` materials compile to one
 * shader (and one more per distinct flag set: `transparent`, `side`, `vertexColors`, ...), however many colours.
 *   materialFor("flat", { color: 0x4a5a48, roughness: 0.6 })                       plain paint/plastic
 *   materialFor("flat", { color: 0x000000, emissive: [1, 0.6, 0.28], intensity: 4 })  a glow
 *   materialFor("flat", { color, roughness: 0.08, transparent: 0.32 })             thin glass (opacity 0.32)
 *   materialFor("emissive", { color: 0x050302, emissive: [1, 0.5, 0.14], intensity: 9, prism: true })
 * Cached by parameters; returns the same object for the same arguments. Clone before changing flags.
 */
export function materialFor(cls: "flat", p: FlatOpts & { transparent?: number; side?: THREE.Side; name?: string }): SurfaceMaterial
export function materialFor(cls: "emissive", p: { color: THREE.ColorRepresentation; roughness?: number; emissive: THREE.ColorRepresentation; intensity?: number; prism?: boolean; litRoom?: boolean; name?: string }): SurfaceMaterial
export function materialFor(cls: "flat" | "emissive", p: Record<string, unknown>): SurfaceMaterial {
  const key = `${cls}:${JSON.stringify(p, (_, v) => (v instanceof THREE.Color ? v.getHex() : v))}`
  const hit = forCache.get(key)
  if (hit) return hit
  let m: SurfaceMaterial
  if (cls === "flat") {
    const o = p as FlatOpts & { transparent?: number; side?: THREE.Side }
    m = member("flat", flatParams(o))
    if (o.transparent !== undefined) {
      m.transparent = true
      m.opacity = o.transparent
      m.depthWrite = false
    }
    if (o.side !== undefined) m.side = o.side
  } else {
    const o = p as { color: THREE.ColorRepresentation; roughness?: number; emissive: THREE.ColorRepresentation; intensity?: number; prism?: boolean; litRoom?: boolean }
    const e = rgb(o.emissive).map((v) => v * (o.intensity ?? 1))
    m = member("emissive", [...rgb(o.color), o.roughness ?? 0.4, ...e, o.prism ? 1 : 0, o.litRoom ? 1 : 0, 0, 0, 0])
  }
  m.name = (p.name as string | undefined) ?? `${cls}_${forCache.size}`
  forCache.set(key, m)
  return m
}
