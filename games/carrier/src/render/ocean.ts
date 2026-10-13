import { SEA_MAX_WAVES, SEA_UNIFORM_FLOATS, SEA_UNIFORM_LAYOUT, makeSeaDetail, packSea, snapSeaOrigin, type Sea, type Wave } from "../../shared/sea"
import type { Seabed } from "../../shared/seabed"
import { TIME_WRAP } from "./frame"
import { OCEAN_FLOATS, OCEAN_LAYOUT as OL, OCEAN_LEVELS, OCEAN_LOOK, OCEAN_N, OCEAN_TILE, OCEAN_WAVES, OCEAN_WGSL } from "./ocean-shader"
import type { RelView } from "./ocean-view"
import { WAKE_SIZE, wakeTarget, type WakeTarget } from "./ocean-wake"
import type { Renderer, ScenePass } from "./renderer"

type Vec3 = [number, number, number]

/** Live-editable look (`globalThis.carrier.ocean.look`). Colours are linear HDR albedo / radiance factors. */
export type OceanLook = {
  /** Scattered colour of deep water, lit by sun + sky. */
  deep: Vec3
  /** Subsurface crest glow colour. */
  scatter: Vec3
  sand: Vec3
  coral: Vec3
  foam: Vec3
  /** Per-metre absorption (red dies first: turquoise, then cobalt). */
  absorb: Vec3
  facetTilt: number
  facetTint: number
  sss: number
  foamAmount: number
  glitter: number
  /** Sky reflection multiplier and the stylised Fresnel cap (keeps grazing water blue). */
  reflect: number
  fresnelCap: number
  /** Deep body lighting: sun and sky ambient weights. */
  bodySun: number
  bodySky: number
  surf: number
  specCap: number
  roughness: number
  coralAmount: number
  bedSun: number
  /** Multiplier on the Frame fog density for the sea. */
  haze: number
  /** Shading-only slope exaggeration so the gentle swell reads. */
  slopeBoost: number
  /** SoT subsurface: base (any sun angle) and backlit strength of the deep-to-scatter blend. */
  sssBase: number
  sssBack: number
  /** Stylised sun radius for the area specular, degrees. */
  sunRadius: number
  /** Multiplier on the swell slope the fragment band-split restores where the facets are too small (1 = physical). */
  swellBoost: number
  /** Crest foam starts this many deviations above the mean foam input (higher = less foam). */
  foamSigma: number
  /** Swell crest foam (per pixel, any distance) starts this many swell-Jacobian deviations up. */
  swellFoamSigma: number
  /** Bonus (in deviations) the top of a swell crest adds to the Jacobian foam input: higher ties foam to big crests. */
  crestWeight: number
  /** 0..1: how much the facet's tilt toward the sun lights the water body. */
  facetLight: number
  /** How much a cloud shadow blocks the sun on the sea. */
  cloudShadow: number
  /** Width (m) of the churning surf band where deep water meets rock and cliff. */
  surfReach: number
  /** Skip a lattice level once the camera is this many of its cells high (bigger = finer facets under the camera). */
  lodK: number
  /** A wave is drawn by the facets once its wavelength spans this many cells (fully at +1.2). */
  filterCells: number
  /** 0..1: how much of the facet tilt the Fresnel term sees (1 = all of it; SoT recreations flatten it). */
  fresnelFlat: number
  /** Strength of ship wake foam from the wake field (0 hides wakes). */
  wake: number
  /** Weather (src/render/weather-fx.ts): wind-streak foam 0..1, rain on the water 0..1, wind speed 0..1 and the unit
   *  plan direction the wind blows toward (the streaks and spindrift follow it). 0 = the sunny sea, untouched. */
  stormFoam: number
  rain: number
  wind: number
  windX: number
  windZ: number
  /** Debug bit flags: skip features (4 band split, 8 coral, 16 glitter, 32 bed warp, 128 surf) or show a debug view (64 height/slope, 256 surf/depth/bed slope). */
  debug: number
}

export const OCEAN_LOOK_DEFAULT: OceanLook = {
  deep: [0.004, 0.085, 0.19],
  scatter: [0.02, 0.42, 0.33],
  sand: [0.8, 0.76, 0.6],
  coral: [0.015, 0.09, 0.08],
  foam: [0.95, 0.98, 1.0],
  absorb: [0.42, 0.07, 0.045],
  facetTilt: 0.025,
  facetTint: 0.08,
  sss: 0.55,
  foamAmount: 1.0,
  glitter: 9,
  reflect: 0.8,
  fresnelCap: 0.65,
  bodySun: 0.3,
  bodySky: 0.8,
  surf: 1.3,
  specCap: 1.6,
  roughness: 0.002,
  coralAmount: 1.0,
  bedSun: 0.85,
  haze: 0.75,
  slopeBoost: 3,
  sssBase: 0.28,
  sssBack: 0.45,
  sunRadius: 0.6,
  swellBoost: 1,
  foamSigma: 2.0,
  crestWeight: 1.1,
  swellFoamSigma: 1.2,
  facetLight: 0.7,
  cloudShadow: 0.7,
  surfReach: 75,
  lodK: 28,
  filterCells: 2.5,
  fresnelFlat: 1,
  wake: 1,
  stormFoam: 0,
  rain: 0,
  wind: 0,
  windX: 1,
  windZ: 0,
  debug: 0,
}

/**
 * Seconds back in time for the crest-foam taps: one just ahead (the crest about to arrive: foam on the front face) and
 * three behind it. Short against the 6-7 s swell period, so the foam stays a band riding the crest and its back
 * slope instead of a sheet over the whole wave.
 */
const MEMORY = [-0.45, 0.5, 1.0, 1.6] as const
const TILES = (2 * OCEAN_N) / OCEAN_TILE
/** The finer level covers N of this level's cells: a whole block of N / T tiles, thanks to the snapping. */
const HOLE = OCEAN_N / OCEAN_TILE
const MAX_INSTANCES = OCEAN_LEVELS * TILES * TILES
const S0 = 0.5
/** Tile index buffer: 8 x 8 quads of a 9 x 9 vertex grid, triangles (v00, v10, v01) and (v11, v01, v10). */
function tileIndices(): Uint16Array<ArrayBuffer> {
  const out = new Uint16Array(OCEAN_TILE * OCEAN_TILE * 6)
  const w = OCEAN_TILE + 1
  let k = 0
  for (let j = 0; j < OCEAN_TILE; j++)
    for (let i = 0; i < OCEAN_TILE; i++) {
      const v00 = j * w + i
      const v10 = v00 + 1
      const v01 = v00 + w
      const v11 = v01 + 1
      out.set([v00, v10, v01, v11, v01, v10], k)
      k += 6
    }
  return out
}

/**
 * The sea (docs/ocean-research.md): 13 camera-centred, world-snapped lattice levels of 96 x 96 cells (0.5 m to
 * 2048 m), drawn as instanced 8 x 8-quad tiles with CDLOD geomorphing, real-triangle facets, per-vertex filtered
 * Gerstner waves, crest foam with memory, and seabed-driven shallows, coral and surf.
 */
export class Ocean implements ScenePass {
  readonly look: OceanLook = { ...OCEAN_LOOK_DEFAULT, deep: [...OCEAN_LOOK_DEFAULT.deep], scatter: [...OCEAN_LOOK_DEFAULT.scatter], sand: [...OCEAN_LOOK_DEFAULT.sand], coral: [...OCEAN_LOOK_DEFAULT.coral], foam: [...OCEAN_LOOK_DEFAULT.foam], absorb: [...OCEAN_LOOK_DEFAULT.absorb] }
  /** Tiles drawn last frame, for diagnostics. */
  tiles = 0
  private device: GPUDevice
  private pipe: GPURenderPipeline
  private layout: GPUBindGroupLayout
  private ubuf: GPUBuffer
  private ibuf: GPUBuffer
  private inst: GPUBuffer
  private group: GPUBindGroup
  private sampler: GPUSampler
  private bedTex: GPUTexture
  private wake: WakeTarget
  private u = new Float32Array(OCEAN_FLOATS)
  private ui = new Int32Array(this.u.buffer)
  private seaU = new Float32Array(SEA_UNIFORM_FLOATS)
  private instances = new Int32Array(MAX_INSTANCES * 4)
  private planes = new Float64Array(24)
  private sea: Sea | null = null
  private detail: Wave[] = []
  private all: Wave[] = []
  private hs = 1
  private maxAmp = 4
  private maxHoriz = 4
  private chopRms = 1
  private swellSd = 1
  private swellCount = 0
  private bed: Seabed | null = null
  private centre = new Float64Array(OCEAN_LEVELS * 2)

  constructor(r: Renderer) {
    const ctx = r.context
    const d = (this.device = ctx.device)
    const module = r.module(OCEAN_WGSL, "ocean")
    this.layout = d.createBindGroupLayout({
      label: "ocean",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    })
    this.pipe = d.createRenderPipeline({
      label: "ocean",
      layout: d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout, this.layout] }),
      vertex: { module, entryPoint: "vs", buffers: [{ arrayStride: 16, stepMode: "instance", attributes: [{ shaderLocation: 0, offset: 0, format: "sint32x4" }] }] },
      fragment: { module, entryPoint: "fs", targets: [{ format: ctx.color }] },
      // Seen from above the tile triangles wind clockwise; the sea is a height field, so back faces never show.
      primitive: { topology: "triangle-list", cullMode: "back", frontFace: "cw" },
      depthStencil: { format: ctx.depth, depthWriteEnabled: true, depthCompare: "greater-equal" },
      multisample: { count: ctx.samples },
    })
    this.ubuf = d.createBuffer({ label: "ocean-u", size: OCEAN_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const idx = tileIndices()
    this.ibuf = d.createBuffer({ label: "ocean-idx", size: idx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST })
    d.queue.writeBuffer(this.ibuf, 0, idx)
    this.inst = d.createBuffer({ label: "ocean-inst", size: this.instances.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    this.sampler = d.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" })
    this.wake = wakeTarget(d)
    this.bedTex = this.blankBed()
    this.group = this.makeGroup()
  }

  private blankBed(): GPUTexture {
    const t = this.device.createTexture({ size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
    this.device.queue.writeTexture({ texture: t }, new Uint8Array([255, 0, 255, 0]), { bytesPerRow: 4 }, [1, 1])
    return t
  }

  private makeGroup(): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.ubuf } },
        { binding: 1, resource: this.bedTex.createView() },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: this.wake.view },
      ],
    })
  }

  /** Unit plan direction the primary swell travels toward (for cameras and debugging). */
  get swell(): readonly [number, number] {
    return this.sea?.swell ?? [1, 0]
  }

  /**
   * The sea to draw. It may be a live view whose wave amplitudes change every frame (shared/weather.ts
   * makeWeatherSea): its waves are re-read each frame, only the wave list itself must stay the same.
   */
  setSea(sea: Sea): void {
    this.sea = sea
    this.detail = makeSeaDetail(sea)
    this.all = [...sea.waves.slice(0, SEA_MAX_WAVES), ...this.detail].slice(0, OCEAN_WAVES)
    this.seaStats()
  }

  /** Heights and bounds derived from the current amplitudes (allocation free; every frame, for the weather view). */
  private seaStats(): void {
    const sea = this.sea!
    let a2 = 0
    let amp = 0
    let horiz = 0
    let swell = 0
    let qa2 = 0
    for (const w of sea.waves) {
      if (w.k < 0.126) a2 += w.amp * w.amp
      qa2 += (w.steep * w.amp) ** 2
    }
    this.chopRms = Math.sqrt(qa2 / 2)
    for (const w of this.all) {
      amp += w.amp
      horiz += w.amp * w.steep
    }
    while (swell < sea.waves.length && sea.waves[swell]!.k < 0.126) swell++
    this.hs = 2 * Math.SQRT2 * Math.sqrt(a2)
    let sq = 0
    for (let i = 0; i < swell; i++) sq += 0.5 * (sea.waves[i]!.steep * sea.waves[i]!.k * sea.waves[i]!.amp) ** 2
    this.swellSd = Math.sqrt(sq) + 1e-3
    this.maxAmp = amp
    this.maxHoriz = horiz
    this.swellCount = swell
  }

  setSeabed(bed: Seabed): void {
    this.bed = bed
    const old = this.bedTex
    this.bedTex = this.device.createTexture({ label: "seabed", size: [bed.res, bed.res], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
    this.device.queue.writeTexture({ texture: this.bedTex }, bed.data, { bytesPerRow: bed.res * 4 }, [bed.res, bed.res])
    this.group = this.makeGroup()
    old.destroy()
  }

  /** Cloud field for shadows: its seed and its drift at the current sea time (from Clouds). */
  setClouds(seed: number, drift: (t: number, out: Float64Array) => void): void {
    this.cloudSeed = seed >>> 0
    this.cloudDrift = drift
  }
  private cloudSeed = 0
  private cloudDrift: ((t: number, out: Float64Array) => void) | null = null
  private driftOut = new Float64Array(2)

  /** Call every frame before render: t is the synced sea time (float64 seconds), sunView the sun disc direction. */
  update(t: number, view: RelView, sunView: readonly number[]): void {
    const sea = this.sea
    if (!sea) return
    this.seaStats()
    const u = this.u
    const ex = view.eye[0]!
    const ey = view.eye[1]!
    const ez = view.eye[2]!
    const ox = snapSeaOrigin(ex)
    const oz = snapSeaOrigin(ez)
    u.set(view.viewProjRel, OL.viewProjRel)
    u[OL.originToEye] = ox - ex
    u[OL.originToEye + 1] = -ey
    u[OL.originToEye + 2] = oz - ez
    u[OL.originToEye + 3] = this.hs
    const camH = Math.max(ey, 1)
    u[OL.cam] = ex - ox
    u[OL.cam + 1] = ez - oz
    // Altitude drives the morph too, scaled so a level is fully morphed (identical to the next) by the height where it
    // is skipped: climbing never pops.
    const skipAt = Math.max(1, Math.min(OCEAN_N - OCEAN_TILE, this.look.lodK))
    u[OL.cam + 2] = camH * ((OCEAN_N - OCEAN_TILE) / skipAt)
    u[OL.cam + 3] = ((t % TIME_WRAP) + TIME_WRAP) % TIME_WRAP
    const bed = this.bed
    u[OL.bed] = bed ? bed.x0 - ox : 0
    u[OL.bed + 1] = bed ? bed.z0 - oz : 0
    u[OL.bed + 2] = bed ? 1 / bed.size : 0
    u[OL.bed + 3] = bed ? 1 : 0
    u[OL.anchor] = ox
    u[OL.anchor + 1] = oz
    u[OL.anchor + 2] = this.all.length
    u[OL.anchor + 3] = sea.seed & 0xffffff
    u[OL.foam] = this.swellSd
    u[OL.foam + 1] = this.look.swellFoamSigma
    u[OL.foam + 2] = this.look.crestWeight
    u[OL.foam + 3] = this.look.foamSigma
    u[OL.sun] = bed ? bed.size / bed.res : 1
    u[OL.sun + 1] = this.chopRms
    u[OL.wind] = sea.wind[0]
    u[OL.wind + 1] = sea.wind[1]
    u[OL.wind + 2] = sea.swell[0]
    u[OL.wind + 3] = sea.swell[1]

    // Waves: the sea's own packing (float64 phases at the snapped origin), then the detail band the same way.
    packSea(sea, t, this.seaU, ox, oz)
    const main = Math.min(sea.waves.length, SEA_MAX_WAVES)
    u.set(this.seaU.subarray(SEA_UNIFORM_LAYOUT.waves, SEA_UNIFORM_LAYOUT.waves + main * 4), OL.waves)
    u.set(this.seaU.subarray(SEA_UNIFORM_LAYOUT.shape, SEA_UNIFORM_LAYOUT.shape + main * 4), OL.shape)
    const TAU = Math.PI * 2
    for (let i = 0; i < this.all.length; i++) {
      const w = this.all[i]!
      if (i >= main) {
        const phase = w.k * (w.dirX * ox + w.dirZ * oz) - w.omega * t + w.phase
        const o = OL.waves + i * 4
        u[o] = w.dirX
        u[o + 1] = w.dirZ
        u[o + 2] = w.k
        u[o + 3] = phase - TAU * Math.floor(phase / TAU)
        const s = OL.shape + i * 4
        const qa = w.steep * w.amp
        u[s] = w.amp
        u[s + 1] = qa
        u[s + 2] = qa * w.k
        u[s + 3] = w.amp * w.k
      }
      const m = OL.mem + i * 4
      u[m] = Math.cos(w.omega * MEMORY[0])
      u[m + 1] = Math.sin(w.omega * MEMORY[0])
      u[m + 2] = Math.cos(w.omega * MEMORY[1])
      u[m + 3] = Math.sin(w.omega * MEMORY[1])
      const m2 = OL.mem2 + i * 4
      u[m2] = Math.cos(w.omega * MEMORY[2])
      u[m2 + 1] = Math.sin(w.omega * MEMORY[2])
      u[m2 + 2] = Math.cos(w.omega * MEMORY[3])
      u[m2 + 3] = Math.sin(w.omega * MEMORY[3])
    }
    this.writeLook()
    u[OL.cloud + 4] = sunView[0]!
    u[OL.cloud + 5] = sunView[1]!
    u[OL.cloud + 6] = sunView[2]!
    u[OL.cloud + 8] = this.wake.centre[0]! - ox
    u[OL.cloud + 9] = this.wake.centre[1]! - oz
    u[OL.cloud + 10] = 1 / WAKE_SIZE
    u[OL.cloud + 11] = this.look.wake
    if (this.cloudDrift) {
      this.cloudDrift(t, this.driftOut)
      u[OL.cloud] = ox - this.driftOut[0]!
      u[OL.cloud + 1] = oz - this.driftOut[1]!
      this.ui[OL.cloud + 2] = this.cloudSeed | 0
      u[OL.cloud + 3] = this.look.cloudShadow
    } else u[OL.cloud + 3] = 0

    // Levels: centre C_L = round(cam / 16 s) * 16 s, lattice-aligned with the next coarser level's tiles.
    let first = 0
    // Skip levels whose facets would be tiny under the camera (the finest drawn level fills the hole; brief §1 skips
    // at 56 cells, this skips sooner so facets stay chunky like the concepts).
    while (first < OCEAN_LEVELS - 1 && camH >= skipAt * S0 * 2 ** first) first++
    const C = this.centre
    for (let L = 0; L < OCEAN_LEVELS; L++) {
      const s = S0 * 2 ** L
      const span = 2 * OCEAN_TILE * s
      const cx = Math.round(ex / span) * span
      const cz = Math.round(ez / span) * span
      C[L * 2] = cx
      C[L * 2 + 1] = cz
      const o = OL.level + L * 4
      u[o] = cx - ox
      u[o + 1] = cz - oz
      u[o + 2] = s
      const g = OL.levelG + L * 4
      this.ui[g] = Math.round(cx / s)
      this.ui[g + 1] = Math.round(cz / s)
    }
    this.device.queue.writeBuffer(this.ubuf, 0, u)

    // Tiles: everything of the first drawn level, then rings; frustum-culled.
    this.extractPlanes(view.viewProjRel64)
    const inst = this.instances
    let count = 0
    const pad = this.maxHoriz + 1
    for (let L = first; L < OCEAN_LEVELS; L++) {
      const s = S0 * 2 ** L
      const cx = C[L * 2]!
      const cz = C[L * 2 + 1]!
      const tile = OCEAN_TILE * s
      let hx = -100
      let hz = -100
      if (L > first) {
        hx = OCEAN_N / OCEAN_TILE / 2 + Math.round((C[(L - 1) * 2]! - cx) / tile)
        hz = OCEAN_N / OCEAN_TILE / 2 + Math.round((C[(L - 1) * 2 + 1]! - cz) / tile)
      }
      const jit = 0.6 * s * 2 + s
      for (let tz = 0; tz < TILES; tz++) {
        for (let tx = 0; tx < TILES; tx++) {
          if (tx >= hx && tx < hx + HOLE && tz >= hz && tz < hz + HOLE) continue
          const x0 = cx + (tx * OCEAN_TILE - OCEAN_N) * s - ex - jit - pad
          const z0 = cz + (tz * OCEAN_TILE - OCEAN_N) * s - ez - jit - pad
          if (!this.visible(x0, -this.maxAmp - ey, z0, x0 + tile + 2 * (jit + pad), this.maxAmp - ey, z0 + tile + 2 * (jit + pad))) continue
          const k = count * 4
          inst[k] = tx * OCEAN_TILE - OCEAN_N
          inst[k + 1] = tz * OCEAN_TILE - OCEAN_N
          inst[k + 2] = L
          inst[k + 3] = 0
          count++
        }
      }
    }
    this.tiles = count
    if (count) this.device.queue.writeBuffer(this.inst, 0, inst.buffer, 0, count * 16)
  }

  private writeLook(): void {
    const k = this.look
    this.vec(0, k.deep, k.facetTilt)
    this.vec(1, k.scatter, k.sss)
    this.vec(2, k.sand, k.facetTint)
    this.vec(3, k.coral, 0)
    this.vec(4, k.foam, k.foamAmount)
    this.vec(5, k.absorb, k.glitter)
    this.slot(6, k.reflect, k.fresnelCap, k.bodySun, k.bodySky)
    this.slot(7, k.surf, k.specCap, k.roughness, k.facetLight)
    this.slot(8, k.coralAmount, k.bedSun, k.haze, 0)
    this.slot(9, k.slopeBoost, k.sssBase, k.sssBack, 0)
    this.slot(10, k.surfReach, k.stormFoam, k.rain, k.wind)
    this.slot(11, k.windX, k.windZ, 0, k.filterCells)
    this.slot(12, k.debug, this.swellCount, k.fresnelFlat, 0)
    this.u[OL.sun + 2] = (k.sunRadius * Math.PI) / 180
    this.u[OL.sun + 3] = k.swellBoost
  }

  private vec(i: number, a: readonly number[], w: number): void {
    this.slot(i, a[0]!, a[1]!, a[2]!, w)
  }

  private slot(i: number, x: number, y: number, z: number, w: number): void {
    const o = OL.look + i * 4
    this.u[o] = x
    this.u[o + 1] = y
    this.u[o + 2] = z
    this.u[o + 3] = w
  }

  /** Six frustum planes (a, b, c, d) from a column-major view-projection, reversed Z (0 <= z <= w). */
  private extractPlanes(m: Float64Array): void {
    const P = this.planes
    for (let i = 0; i < 4; i++) {
      const r0 = m[i * 4]!
      const r1 = m[i * 4 + 1]!
      const r2 = m[i * 4 + 2]!
      const r3 = m[i * 4 + 3]!
      P[i] = r3 + r0
      P[4 + i] = r3 - r0
      P[8 + i] = r3 + r1
      P[12 + i] = r3 - r1
      P[16 + i] = r2
      P[20 + i] = r3 - r2
    }
  }

  /** Box relative to the eye against the eye-relative frustum (the far plane culls too). */
  private visible(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
    const P = this.planes
    for (let k = 0; k < 6; k++) {
      const a = P[k * 4]!
      const b = P[k * 4 + 1]!
      const c = P[k * 4 + 2]!
      const d = P[k * 4 + 3]!
      const x = a > 0 ? x1 : x0
      const y = b > 0 ? y1 : y0
      const z = c > 0 ? z1 : z0
      if (a * x + b * y + c * z + d < 0) return false
    }
    return true
  }

  draw(pass: GPURenderPassEncoder): void {
    if (!this.sea || !this.tiles) return
    pass.setPipeline(this.pipe)
    pass.setBindGroup(1, this.group)
    pass.setVertexBuffer(0, this.inst)
    pass.setIndexBuffer(this.ibuf, "uint16")
    pass.drawIndexed(OCEAN_TILE * OCEAN_TILE * 6, this.tiles)
  }
}
