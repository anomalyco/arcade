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
  mix,
  normalMap,
  normalWorldGeometry,
  positionWorld,
  screenCoordinate,
  sin,
  smoothstep,
  sqrt,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
} from "three/tsl"
import type { LabControl, LabSettings } from "@arcade/kit/lab-panel"

// The one place surface materials come from. Builders ask for a material by name and give their geometry UVs in
// metres (1 UV unit = 1 m) so every material tiles at real-world scale; the material owns its texture repeat.
//
// Textured materials sample CC0 scans from public/textures/<set>/ (color sRGB, normal OpenGL, arm = AO/rough/metal;
// fetched by scripts/fetch-textures.ts, sources in public/textures/CREDITS.md). Tile, linoleum, chain-link, glass,
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
type Std = THREE.MeshStandardNodeMaterial

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
const loader = new THREE.TextureLoader()
const textures = new Map<string, THREE.Texture>()
const pending: Promise<unknown>[] = []
let anisotropy = 8

type Kind = "color" | "normal" | "arm"

/** A scanned map from public/textures/<set>/<kind>.jpg; `size` is the metres one tile covers (sets `repeat`). */
function map(setName: string, kind: Kind, size: number): THREE.Texture {
  const key = `${setName}/${kind}`
  const hit = textures.get(key)
  if (hit) return hit
  let t!: THREE.Texture
  pending.push(new Promise((resolve, reject) => (t = loader.load(`${BASE}${key}.jpg`, resolve, undefined, () => reject(new Error(`texture ${key}`))))))
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = kind === "color" ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.anisotropy = anisotropy
  // Consumers that sample `material.normalMap` with the texture matrix (terrain blend) get the same metre scale.
  t.repeat.set(1 / size, 1 / size)
  t.name = key
  textures.set(key, t)
  return t
}

/**
 * Tiling value-noise fbm, four independent histogram-equalised channels (value = percentile, so thresholds are
 * coverage fractions). R: blobs (4 cells/tile), G: 8, B: 16, A: 32.
 */
let noiseTex: THREE.DataTexture | null = null
function noise(): THREE.DataTexture {
  if (noiseTex) return noiseTex
  const S = 512
  const data = new Uint8Array(S * S * 4)
  const val = new Float32Array(S * S)
  const rnd = (x: number, y: number, s: number) => {
    let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296
  }
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)
  const BINS = 4096
  const hist = new Uint32Array(BINS)
  for (let c = 0; c < 4; c++) {
    const base = 4 << c
    let lo = Infinity
    let hi = -Infinity
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        let v = 0
        let amp = 1
        // Octaves stop at 4 px per cell so the finest layer never aliases into blocks.
        for (let n = base, o = 0; n <= S / 4; n *= 2, o++) {
          const fx = (x / S) * n
          const fy = (y / S) * n
          const ix = Math.floor(fx)
          const iy = Math.floor(fy)
          const tx = fade(fx - ix)
          const ty = fade(fy - iy)
          const sd = c * 16 + o
          const a = rnd(ix % n, iy % n, sd)
          const b = rnd((ix + 1) % n, iy % n, sd)
          const d = rnd(ix % n, (iy + 1) % n, sd)
          const e = rnd((ix + 1) % n, (iy + 1) % n, sd)
          v += amp * (a + (b - a) * tx + (d - a) * ty + (a - b - d + e) * tx * ty)
          amp *= 0.5
        }
        val[y * S + x] = v
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
    }
    // Histogram equalisation: each texel becomes its percentile.
    hist.fill(0)
    const k = (BINS - 1) / (hi - lo)
    for (let i = 0; i < S * S; i++) hist[Math.round((val[i]! - lo) * k)]!++
    let acc = 0
    for (let b = 0; b < BINS; b++) {
      const n = hist[b]!
      hist[b] = Math.round(((acc + n / 2) / (S * S)) * 255)
      acc += n
    }
    for (let i = 0; i < S * S; i++) data[i * 4 + c] = hist[Math.round((val[i]! - lo) * k)]!
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.magFilter = THREE.LinearFilter
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.generateMipmaps = true
  t.colorSpace = THREE.NoColorSpace
  t.name = "materials/noise"
  t.needsUpdate = true
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

/** Called once after the renderer exists, before any builder runs: loads every scanned set and builds procedural maps. */
export async function loadMaterials(renderer: THREE.WebGPURenderer) {
  anisotropy = Math.min(16, renderer.getMaxAnisotropy?.() ?? 8)
  for (const t of textures.values()) t.anisotropy = anisotropy
  for (const [setName, size] of Object.entries(SETS)) for (const kind of ["color", "normal", "arm"] as const) map(setName, kind, size)
  noise()
  pineCard()
  await Promise.all(pending)
}

// ---------------------------------------------------------------------------------------------------------------
// Sampling helpers

/** Metres covered by one tile of each scanned set. */
const SETS = {
  asphalt: 3.5,
  asphalt_lot: 2.6,
  gravel: 1.5,
  forest_floor: 1.75,
  forest_moss: 2,
  grass: 2,
  dirt: 1.4,
  concrete_wall: 1.8,
  concrete_dark: 2,
  concrete_floor: 3,
  bark: 1.2,
  wood_pole: 1,
  metal_painted: 1.2,
  metal_galvanized: 1,
  metal_dark: 1,
  ceiling_tile: 3.66,
  terrazzo: 0.6,
  plaster: 2,
  imperfections: 1.5,
} as const
type SetName = keyof typeof SETS

/** Surface channels: colour (linear), roughness, packed tangent-space normal (0..1), AO, metalness. */
type Surf = { color: N; rough: N; normal: N; ao: N; metal: N }

function sample(name: SetName, uvn: N = uv(), size: number = SETS[name]): Surf {
  const p = uvn.mul(1 / size)
  const c = texture(map(name, "color", SETS[name]), p)
  const n = texture(map(name, "normal", SETS[name]), p)
  const a = texture(map(name, "arm", SETS[name]), p)
  return { color: c.rgb, rough: a.g, normal: n.xyz, ao: a.r, metal: a.b }
}

/**
 * Breaks visible repetition: blends the set with a rotated, slightly rescaled copy of itself by a world-space noise
 * mask (the rotated normal is turned back into the surface's tangent frame).
 */
function antiTile(name: SetName, uvn: N = uv(), maskPeriod = SETS[name] * 2.7): Surf {
  const A = sample(name, uvn)
  const ang = 0.63
  const ca = Math.cos(ang)
  const sa = Math.sin(ang)
  const ruv = vec2(uvn.x.mul(ca).sub(uvn.y.mul(sa)), uvn.x.mul(sa).add(uvn.y.mul(ca))).add(vec2(13.7, 5.3))
  const B = sample(name, ruv, SETS[name] * 1.13)
  const bn = B.normal.mul(2).sub(1)
  const bnr = vec3(bn.x.mul(ca).add(bn.y.mul(sa)), bn.y.mul(ca).sub(bn.x.mul(sa)), bn.z).mul(0.5).add(0.5)
  const w = smoothstep(0.32, 0.68, wnoise(positionWorld.xz, maskPeriod).b)
  return {
    color: mix(A.color, B.color, w),
    rough: mix(A.rough, B.rough, w),
    normal: mix(A.normal, bnr, w),
    ao: mix(A.ao, B.ao, w),
    metal: mix(A.metal, B.metal, w),
  }
}

const luma = (c: N): N => c.dot(vec3(0.2126, 0.7152, 0.0722))
const saturate = (c: N, s: number): N => mix(vec3(luma(c)), c, s)
const FLAT = vec3(0.5, 0.5, 1)

/** Large-scale tint/brightness drift in world space so kilometre-scale ground never reads as a repeat. */
function macro(color: N, greenShift = 0): N {
  const p = positionWorld.xz
  const big = wnoise(p, 260).r
  const mid = wnoise(p, 70).g
  const k = U.variation
  const bright = mix(float(1), mix(float(0.62), float(1.32), big.mul(0.65).add(mid.mul(0.35))), k)
  const hue = mix(vec3(1), mix(vec3(1.06, 0.98, 0.9), vec3(0.9 + greenShift, 1.02 + greenShift, 0.94), mid), k)
  return color.mul(bright).mul(hue)
}

type WetOpts = {
  /** How much the dry albedo darkens under a water film (porous asphalt ≈ 0.55, dense concrete ≈ 0.35). */
  porosity: number
  /** Roughness of the wet film. */
  film: number
  /** Puddle coverage multiplier for this surface (0 = no standing water). */
  puddles: number
}

/**
 * Wet ground: darker albedo and a glossy film everywhere, standing water (near-mirror, flat normal) where a
 * world-space noise mask plus surface cavities fall below the waterline, only on upward-facing surfaces.
 */
function wet(s: Surf, o: WetOpts): Surf {
  const w = U.wetness
  const p = positionWorld.xz.div(U.puddleScale)
  const up = smoothstep(0.82, 0.97, normalWorldGeometry.y)
  // Percentile-equalised noise; cavities (low AO) collect water first.
  const h = wnoise(p, 41).r.mul(0.62).add(wnoise(p, 13).g.mul(0.38)).add(s.ao.oneMinus().mul(0.35))
  const line = float(1.12).sub(U.puddles.mul(o.puddles).mul(0.82))
  const puddle = smoothstep(line, line.add(0.035), h).mul(up).mul(smoothstep(0.15, 0.6, w))
  // Damp edge around each puddle, and streaky drying elsewhere.
  const edge = smoothstep(line.sub(0.09), line, h).mul(up)
  const dry = wnoise(p, 9).b
  const film = w.mul(mix(float(0.8), float(1), dry)).max(edge.mul(w))
  const filmRough = mix(float(o.film), float(o.film).add(0.1), dry)
  let color = s.color.mul(mix(float(1), float(1 - o.porosity), film))
  color = mix(color, color.mul(0.55), puddle)
  let rough = mix(s.rough, min(s.rough, filmRough), film)
  rough = mix(rough, float(0.035), puddle)
  // The film fills the micro relief; standing water is flat.
  const normal = mix(mix(s.normal, FLAT, film.mul(0.45)), FLAT, puddle)
  return { ...s, color, rough, normal }
}

/** Damp natural ground: darker and a little glossier, no standing water. */
function damp(s: Surf, amount: number, gloss: number): Surf {
  const f = U.wetness.mul(amount)
  return { ...s, color: s.color.mul(mix(float(1), float(0.72), f)), rough: mix(s.rough, s.rough.mul(gloss), f) }
}

type Finish = { normalScale?: number; metalness?: number; useMetalMap?: boolean; ao?: boolean }

function std(s: Surf, f: Finish = {}, ctor: typeof THREE.MeshStandardNodeMaterial = THREE.MeshStandardNodeMaterial): Std {
  const m = new ctor()
  m.colorNode = s.color
  m.roughnessNode = clamp(s.rough, 0.02, 1)
  m.metalnessNode = f.useMetalMap ? s.metal : float(f.metalness ?? 0)
  const k = f.normalScale ?? 1
  m.normalNode = normalMap(s.normal, vec2(k, k))
  if (f.ao !== false) m.aoNode = s.ao
  return m
}

/** Exposes the scanned normal map on the material too, for consumers that blend library materials themselves. */
function withNormalMap(m: Std, setName: SetName, scale = 1): Std {
  m.normalMap = map(setName, "normal", SETS[setName])
  m.normalScale = new THREE.Vector2(scale, scale)
  return m
}

// ---------------------------------------------------------------------------------------------------------------
// Procedural tiles

/** Square tile grid: per-tile id, distance to the nearest joint (m), and a tangent-space bevel/tilt normal. */
function tileGrid(size: number, joint: number, bevel: number, tilt: number, uvn: N = uv()) {
  const g: N = uvn.div(size)
  const id: N = floor(g)
  const f: N = fract(g).mul(size)
  const ex = min(f.x, float(size).sub(f.x))
  const ey = min(f.y, float(size).sub(f.y))
  const edge = min(ex, ey)
  const rnd: N = hash(id.x.add(311).mul(157.31).add(id.y.add(197).mul(91.7)))
  const rnd2: N = hash(id.x.add(53).mul(71.9).add(id.y.add(11).mul(213.3)))
  const aa = fwidth(uvn.x).add(fwidth(uvn.y)).mul(0.5)
  const groutMask = float(1).sub(smoothstep(float(joint * 0.5).sub(aa), float(joint * 0.5).add(aa), edge))
  // Rounded glaze edge: normal leans toward the nearest joint inside the bevel band.
  const sx = f.x.lessThan(float(size * 0.5)).select(float(-1), float(1))
  const sy = f.y.lessThan(float(size * 0.5)).select(float(-1), float(1))
  const bx = smoothstep(float(joint * 0.5 + bevel), float(joint * 0.5), ex).mul(sx)
  const by = smoothstep(float(joint * 0.5 + bevel), float(joint * 0.5), ey).mul(sy)
  const tx = rnd.sub(0.5).mul(tilt)
  const ty = rnd2.sub(0.5).mul(tilt)
  const nxy: N = vec2((bx as N).mul(0.55).add(tx), (by as N).mul(0.55).add(ty)).mul(groutMask.oneMinus())
  const normal = vec3(nxy as N, sqrt(float(1).sub(nxy.dot(nxy)).max(0.2)) as N).normalize().mul(0.5).add(0.5)
  return { id, f, edge, rnd, rnd2, groutMask, normal }
}

function ceramic(glaze: THREE.Color, groutColor: THREE.Color): Std {
  const size = 0.152
  const t = tileGrid(size, 0.003, 0.0045, 0.035)
  const imp = sample("imperfections", uv(), 1.7)
  const tileTint = mix(float(0.93), float(1.05), t.rnd).mul(mix(vec3(1.02, 0.99, 1), vec3(0.98, 1.01, 1), t.rnd2))
  const crazing = wnoise(uv(), 0.9).a
  const glazeCol = vec3(glaze.r, glaze.g, glaze.b).mul(tileTint).mul(mix(float(0.97), float(1.02), crazing))
  const groutCol = vec3(groutColor.r, groutColor.g, groutColor.b).mul(mix(float(0.6), float(1), wnoise(uv(), 0.7).b))
  const color = mix(glazeCol, groutCol, t.groutMask)
  const rough = mix(float(0.07).add(imp.rough.mul(0.25)), float(0.85), t.groutMask)
  return std({ color, rough, normal: t.normal, ao: mix(float(1), float(0.6), t.groutMask), metal: float(0) })
}

function linoleum(): Std {
  const size = 0.305
  const t = tileGrid(size, 0.0012, 0.0006, 0.012)
  // VCT chip marbling, quarter-turned on alternate tiles like a laid floor.
  const turn = fract(t.id.x.add(t.id.y).mul(0.5)).greaterThan(0.25)
  const local = turn.select(vec2(t.f.y, t.f.x), t.f)
  const chips = texture(noise(), local.mul(vec2(1.6, 0.55)).add(t.id.mul(0.37))).a
  const fleck = smoothstep(0.82, 0.86, texture(noise(), local.mul(9).add(t.id.mul(0.71))).b)
  const base = vec3(0.36, 0.38, 0.33)
  const tint = mix(float(0.92), float(1.05), t.rnd)
  let color = base.mul(tint).mul(mix(float(0.86), float(1.08), chips))
  color = mix(color, vec3(0.16, 0.17, 0.15), fleck.mul(0.6))
  color = mix(color, vec3(0.08, 0.08, 0.07), t.groutMask)
  const imp = sample("imperfections", uv(), 2.3)
  const scuff = wnoise(uv(), 3.1).g
  const rough = float(0.06).add(imp.rough.mul(0.32)).add(smoothstep(0.7, 0.95, scuff).mul(0.18)).add(t.groutMask.mul(0.5))
  return std({ color, rough, normal: t.normal, ao: float(1), metal: float(0) })
}

// ---------------------------------------------------------------------------------------------------------------
// Library

const c3 = (hex: number) => {
  const c = new THREE.Color(hex)
  return vec3(c.r, c.g, c.b)
}

const BUILD: Record<MaterialName, () => THREE.Material> = {
  asphalt: () => {
    const s = antiTile("asphalt")
    const base = { ...s, color: macro(saturate(s.color, 0.6).mul(0.72)), rough: s.rough.mul(0.25).add(0.7) }
    return withNormalMap(std(wet(base, { porosity: 0.55, film: 0.26, puddles: 1 }), { normalScale: 1.2 }), "asphalt")
  },
  asphalt_lot: () => {
    const s = antiTile("asphalt_lot")
    const base = { ...s, color: macro(saturate(s.color, 0.35).mul(1.05)), rough: s.rough.mul(0.25).add(0.68) }
    return withNormalMap(std(wet(base, { porosity: 0.55, film: 0.28, puddles: 1.15 }), { normalScale: 1.1 }), "asphalt_lot")
  },
  road_line_yellow: () => roadPaint(new THREE.Color(0.55, 0.36, 0.06)),
  road_line_white: () => roadPaint(new THREE.Color(0.62, 0.62, 0.58)),
  gravel: () => {
    const s = antiTile("gravel")
    const base = { ...s, color: macro(saturate(s.color, 0.6).mul(0.55)) }
    return withNormalMap(std(wet(base, { porosity: 0.45, film: 0.38, puddles: 0.55 }), { normalScale: 1.3 }), "gravel")
  },
  forest_floor: () => {
    const needles = antiTile("forest_floor")
    const moss = sample("forest_moss")
    const w = smoothstep(0.55, 0.8, wnoise(positionWorld.xz, 31).r.mul(0.7).add(wnoise(positionWorld.xz, 7).a.mul(0.3)))
    const color = mix(saturate(needles.color, 0.8).mul(vec3(0.42, 0.4, 0.38)), saturate(moss.color, 0.75).mul(vec3(0.42, 0.46, 0.36)), w.mul(0.7))
    const s: Surf = {
      color: macro(color, 0.03),
      rough: mix(needles.rough, moss.rough, w),
      normal: mix(needles.normal, moss.normal, w),
      ao: mix(needles.ao, moss.ao.mul(0.5).add(0.5), w),
      metal: float(0),
    }
    return withNormalMap(std(damp(s, 0.6, 0.8), { normalScale: 1.2 }), "forest_floor", 1.2)
  },
  grass: () => {
    const s = antiTile("grass")
    const color = macro(saturate(s.color, 0.75).mul(vec3(0.34, 0.33, 0.24)), 0.04)
    return withNormalMap(std(damp({ ...s, color }, 0.5, 0.85), { normalScale: 1.1 }), "grass", 1.1)
  },
  dirt: () => {
    const s = antiTile("dirt")
    const color = macro(saturate(s.color, 0.7).mul(0.62))
    return withNormalMap(std(damp({ ...s, color }, 0.9, 0.7), { normalScale: 1.2 }), "dirt", 1.2)
  },
  concrete_wall: () => {
    const s = sample("concrete_wall")
    // Rain-streaked staining running down every face (world space, so it ignores each wall's UV orientation).
    const p = positionWorld
    const streak = texture(noise(), vec2(p.x.add(p.z).div(2.3), p.y.div(26))).g
    const blot = wnoise(vec2(p.x.add(p.z), p.y), 9).r
    const stain = smoothstep(0.45, 0.95, streak).mul(0.38).add(smoothstep(0.6, 0.95, blot).mul(0.18))
    const color = saturate(s.color, 0.3).mul(vec3(0.8, 0.83, 0.82)).mul(float(1).sub(stain))
    return withNormalMap(std({ ...s, color, rough: s.rough.mul(0.2).add(0.76) }, { normalScale: 1.4 }), "concrete_wall")
  },
  concrete_dark: () => {
    const s = antiTile("concrete_dark")
    const color = saturate(s.color, 0.35).mul(0.62)
    return withNormalMap(std({ ...s, color }, { normalScale: 1.2 }), "concrete_dark")
  },
  concrete_floor: () => {
    const s = antiTile("concrete_floor")
    const base = { ...s, color: saturate(s.color, 0.4).mul(0.9), rough: s.rough.mul(0.3).add(0.62) }
    return withNormalMap(std(wet(base, { porosity: 0.4, film: 0.3, puddles: 0.7 }), { normalScale: 1 }), "concrete_floor")
  },
  concrete_floor_dry: () => {
    const s = antiTile("concrete_floor")
    return withNormalMap(std({ ...s, color: saturate(s.color, 0.4).mul(0.9), rough: s.rough.mul(0.35).add(0.45) }), "concrete_floor")
  },
  bark: () => {
    const s = sample("bark")
    return withNormalMap(std({ ...s, color: saturate(s.color, 0.8).mul(vec3(0.5, 0.44, 0.4)), rough: s.rough.mul(0.3).add(0.68) }, { normalScale: 1.6 }), "bark")
  },
  pine_needles: () => {
    const t = texture(pineCard(), uv())
    // Keep coverage through the mip chain so distant cards don't evaporate.
    const lod = log2(max(fwidth(uv().x).mul(512), fwidth(uv().y).mul(1024)).max(1))
    const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, alphaTest: 0.45 })
    m.colorNode = t.rgb
    m.opacityNode = clamp(t.a.mul(lod.mul(0.35).add(1)), 0, 1)
    m.roughnessNode = float(0.72)
    m.metalnessNode = float(0)
    return m
  },
  pine_foliage: () => {
    const p = positionWorld
    const a = texture(noise(), vec2(p.x.add(p.y.mul(0.7)), p.z.sub(p.y.mul(0.4))).mul(3.1)).a
    const b = texture(noise(), vec2(p.z.add(p.y), p.x.sub(p.y)).mul(1.3)).b
    const clump = smoothstep(0.25, 0.75, a.mul(0.6).add(b.mul(0.4)))
    const color = mix(vec3(0.006, 0.012, 0.007), vec3(0.03, 0.055, 0.028), clump)
    const m = new THREE.MeshStandardNodeMaterial()
    m.colorNode = color
    m.roughnessNode = float(0.8)
    m.metalnessNode = float(0)
    m.aoNode = mix(float(0.45), float(1), clump)
    return m
  },
  wood_pole: () => {
    const s = sample("wood_pole")
    // Creosote-treated pole weathered grey-brown.
    const color = saturate(s.color, 0.6).mul(vec3(0.42, 0.33, 0.26))
    return withNormalMap(std({ ...s, color, rough: s.rough.mul(0.25).add(0.7) }, { normalScale: 1.6 }), "wood_pole")
  },
  metal_painted: () => paintedMetal(0x5c615c, 0.35),
  door_steel: () => paintedMetal(0x3d5a4b, 0.3),
  metal_galvanized: () => {
    const s = sample("metal_galvanized")
    const spangle = texture(noise(), uv().mul(9)).a
    const color = saturate(s.color, 0.15).mul(1.05).mul(mix(float(0.88), float(1.06), spangle))
    return std({ ...s, color, rough: s.rough.mul(0.6).add(spangle.mul(0.18)).add(0.12) }, { metalness: 1, normalScale: 0.6 })
  },
  metal_dark: () => {
    const s = sample("metal_dark")
    return std({ ...s, color: s.color.mul(0.7), rough: s.rough.mul(0.8).add(0.25) }, { useMetalMap: true })
  },
  chainlink: () => chainlink(),
  barbed_wire: () => {
    const rust = smoothstep(0.62, 0.9, texture(noise(), uv().mul(3)).r)
    const m = new THREE.MeshStandardNodeMaterial()
    m.colorNode = mix(vec3(0.42, 0.43, 0.42), vec3(0.16, 0.08, 0.04), rust)
    m.roughnessNode = mix(float(0.42), float(0.85), rust)
    m.metalnessNode = mix(float(1), float(0.2), rust)
    return m
  },
  glass_lit: () => {
    const p = uv()
    const room = wnoise(p, 6).r
    const lamp = wnoise(p, 2.2).g
    const blinds = sin(p.y.mul(Math.PI * 2 / 0.045)).mul(0.5).add(0.5)
    const hasBlinds = smoothstep(0.55, 0.6, wnoise(floor(p.div(1.8)).add(0.5).mul(1.8), 31).b)
    const glow = mix(float(0.55), float(1.25), room.mul(0.6).add(lamp.mul(0.4))).mul(mix(float(1), mix(float(0.55), float(1), blinds), hasBlinds.mul(0.8)))
    const m = new THREE.MeshStandardNodeMaterial()
    m.colorNode = vec3(0.02, 0.018, 0.014)
    m.roughnessNode = float(0.06)
    m.metalnessNode = float(0)
    m.emissiveNode = vec3(1.0, 0.66, 0.34).mul(glow).mul(2.2)
    return m
  },
  glass_dark: () => {
    const imp = sample("imperfections", uv(), 0.9)
    const m = new THREE.MeshStandardNodeMaterial()
    m.colorNode = vec3(0.006, 0.008, 0.008)
    m.roughnessNode = float(0.03).add(imp.rough.mul(0.22))
    m.metalnessNode = float(0)
    return m
  },
  tile_green: () => ceramic(new THREE.Color(0.42, 0.53, 0.45), new THREE.Color(0.36, 0.37, 0.33)),
  tile_green_dark: () => ceramic(new THREE.Color(0.055, 0.12, 0.085), new THREE.Color(0.2, 0.21, 0.19)),
  linoleum: () => linoleum(),
  ceiling_tile: () => {
    const s = sample("ceiling_tile")
    const stain = smoothstep(0.78, 0.97, wnoise(uv(), 5).r)
    const color = s.color.mul(vec3(0.7, 0.69, 0.63)).mul(float(1).sub(stain.mul(0.35)))
    return std({ ...s, color, rough: float(0.92) }, { normalScale: 0.8 })
  },
  terrazzo: () => {
    const s = sample("terrazzo")
    const imp = sample("imperfections", uv(), 2.1)
    return std({ ...s, color: s.color.mul(0.78), rough: float(0.08).add(imp.rough.mul(0.22)).add(s.rough.mul(0.1)) }, { normalScale: 0.4 })
  },
  painted_wall: () => {
    const s = sample("plaster")
    const color = saturate(s.color, 0.3).mul(c3(0xb8b8a8)).mul(0.82)
    return std({ ...s, color, rough: s.rough.mul(0.25).add(0.62) }, { normalScale: 0.6 })
  },
  rubber: () => {
    const n = texture(noise(), uv().mul(4)).a
    const m = new THREE.MeshStandardNodeMaterial()
    m.colorNode = vec3(0.012, 0.012, 0.012).mul(mix(float(0.8), float(1.4), n))
    m.roughnessNode = mix(float(0.72), float(0.9), n)
    m.metalnessNode = float(0)
    return m
  },
  car_paint: () => {
    const m = new THREE.MeshPhysicalNodeMaterial({ color: 0x3a4a3e, roughness: 0.38, metalness: 0.45, clearcoat: 1, clearcoatRoughness: 0.06 })
    const grime = smoothstep(0.55, 0.95, wnoise(uv(), 1.4).r)
    m.colorNode = c3(0x2f3d33).mul(mix(float(1), float(0.75), grime))
    m.clearcoatRoughnessNode = mix(float(0.04), float(0.25), grime)
    return m
  },
  chrome: () => {
    const imp = sample("imperfections", uv(), 0.5)
    const m = new THREE.MeshStandardNodeMaterial()
    m.colorNode = vec3(0.78, 0.78, 0.8)
    m.roughnessNode = float(0.05).add(imp.rough.mul(0.25))
    m.metalnessNode = float(1)
    return m
  },
  plastic_orange: () => {
    const n = texture(noise(), uv().mul(2)).g
    const m = new THREE.MeshStandardNodeMaterial()
    m.colorNode = c3(0xb5561a).mul(mix(float(0.85), float(1.05), n))
    m.roughnessNode = mix(float(0.38), float(0.55), n)
    m.metalnessNode = float(0)
    return m
  },
  emissive_sodium: () => {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.3, metalness: 0 })
    m.colorNode = vec3(0.05, 0.03, 0.01)
    m.emissiveNode = vec3(1.0, 0.5, 0.14).mul(9)
    return m
  },
  emissive_fluorescent: () => {
    // Prismatic acrylic lens: faint fine grid of brighter cells over a flat glow.
    const g = abs(fract(uv().div(0.012)).sub(0.5))
    const prism = mix(float(0.9), float(1.06), smoothstep(0.1, 0.4, max(g.x, g.y)))
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.4, metalness: 0 })
    m.colorNode = vec3(0.6, 0.62, 0.6)
    m.emissiveNode = vec3(0.92, 0.97, 1.0).mul(prism).mul(7)
    return m
  },
}

function roadPaint(paint: THREE.Color): Std {
  const s = sample("asphalt")
  const p = positionWorld.xz
  // Thermoplastic worn through by tyres: patches of asphalt show where the noise drops.
  const wear = smoothstep(0.06, 0.26, wnoise(p, 7).r.mul(0.55).add(wnoise(p, 1.3).a.mul(0.45)))
  const col = mix(saturate(s.color, 0.6).mul(0.6), vec3(paint.r, paint.g, paint.b).mul(mix(float(0.8), float(1), s.ao)), wear)
  const base: Surf = { ...s, color: col, rough: mix(s.rough.mul(0.25).add(0.7), float(0.55), wear), normal: mix(s.normal, FLAT, wear.mul(0.6)) }
  return std(wet(base, { porosity: 0.3, film: 0.25, puddles: 1 }))
}

function paintedMetal(hex: number, chipping: number): Std {
  const s = sample("metal_painted")
  // The scan is yellow paint; keep only its luminance variation, recolour, and let scratches show steel.
  const scratch = smoothstep(0.55, 0.85, s.metal)
  const chip = smoothstep(1 - chipping * 0.3, 1, wnoise(uv(), 0.7).a)
  const bare = scratch.max(chip)
  const lum = luma(s.color).div(0.45)
  const color = mix(c3(hex).mul(mix(float(0.85), float(1.08), lum)), vec3(0.32, 0.31, 0.3), bare)
  const rough = mix(float(0.42).add(s.rough.mul(0.45)), float(0.5), bare)
  return std({ ...s, color, rough, metal: bare }, { useMetalMap: true, normalScale: 0.8 })
}

/**
 * Galvanised chain-link: analytic diamond mesh (2" / 50 mm between parallel wires, 3.6 mm wire) in UV metres.
 * Alpha-tested with screen-space dithering once the wire gets thinner than a pixel, so the far fence keeps its
 * average coverage instead of vanishing or turning into a solid sheet. Round-wire normals; double-sided.
 */
function chainlink(): Std {
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
  const oa = cover(da)
  const ob = cover(db)
  const opacity = max(oa, ob)
  // Round wire: lean the normal across the nearer wire.
  const ta = clamp(da.div(hw), -1, 1)
  const tb = clamp(db.div(hw), -1, 1)
  const useA = abs(da).lessThan(abs(db))
  const t = useA.select(ta, tb)
  const dir = useA.select(vec2(0.7071, 0.7071), vec2(0.7071, -0.7071))
  const nxy = dir.mul(t).mul(0.85)
  const normal = vec3(nxy, sqrt(float(1).sub(nxy.dot(nxy)))).mul(0.5).add(0.5)
  const n = wnoise(p, 2.5).r
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, alphaTest: 0.5 })
  m.colorNode = vec3(0.5, 0.52, 0.5).mul(mix(float(0.75), float(1.1), n))
  m.metalnessNode = float(0.85)
  m.roughnessNode = mix(float(0.38), float(0.6), n)
  m.normalNode = normalMap(normal)
  m.opacityNode = opacity
  m.alphaTestNode = interleavedGradientNoise(screenCoordinate).mul(0.96).add(0.02)
  return m
}

const cache = new Map<MaterialName, THREE.Material>()

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
