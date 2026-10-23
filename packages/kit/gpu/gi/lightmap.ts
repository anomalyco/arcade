import type { LabControl } from "../../lab-panel"
import { MAT, VERT_BYTES } from "../mesh"
import type { SceneLight } from "../scene-frame"
import type { LiveBounceSource } from "../screen/light"
import type { SceneHooks } from "../shaders"
import { HOUSE_LIGHTMAP_META, HOUSE_LIGHTMAP_RGB9E5_B64 } from "./house-lightmap-data"

export { HOUSE_LIGHTMAP_META, HOUSE_LIGHTMAP_RGB9E5_B64 }
export type { LiveBounceSource }

/**
 * Baked per-light indirect diffuse lightmaps (`rgb9e5ufloat` 2D texture array) and a 3D grid of L1 Spherical Harmonics
 * (SH) irradiance probes (`scripts/bake-room.py`, headless Blender 5.2 Cycles).
 *
 * Unit derivation (zero fudge factors):
 * - In `packages/kit/gpu/lights/physical.ts` + `packages/kit/gpu/shaders.ts`, direct diffuse lighting before surface
 *   albedo is `direct = ENGINE_LIGHT_GAIN * P_engine * cos(theta) / (pi * d^2)` with `ENGINE_LIGHT_GAIN = 5.0`
 *   (`const GAIN: f32 = 5.0` in `shaders.ts:16`).
 * - In Blender Cycles, a `POINT` or `SPOT` light with `energy = E_bl` has radiant intensity `I = E_bl / (4 * pi)`,
 *   and a cosine `AREA` (`panel`/`rect`) emitter has on-axis radiant intensity `I = E_bl / pi`.
 * - Setting `E_bl = 4 * pi * bakedPower` (spot/point) or `E_bl = pi * bakedPower` (panel/rect) in Cycles and
 *   multiplying the sampled `DIFFUSE` `INDIRECT` pass (`use_pass_color = False`) by `ENGINE_LIGHT_GAIN` (`5.0`) in
 *   WGSL places the baked bounce in exact engine units at `giIntensity = 1.0`.
 *
 * Surface vs dynamic object separation (no double-counting):
 * - Lightmapped static surfaces (`isLightmapped`) sample the UV2 `rgb9e5ufloat` lightmap array only (`lmIrr`).
 * - Dynamic objects (`MAT.actor`) sample the trilinearly interpolated 3D L1 SH probe volume only (`probeIrr`).
 */

/** Exact diffuse light gain (`const GAIN: f32 = 5.0` in `packages/kit/gpu/shaders.ts:16`). */
export const ENGINE_LIGHT_GAIN = 5.0

export type Aabb3 = {
  readonly min: readonly [number, number, number]
  readonly max: readonly [number, number, number]
}

export type BakedLightSpec = {
  readonly key: string
  readonly id: number
  /** Exact physical engine `SceneLight.power` at which this layer was baked in Cycles. */
  readonly bakedPower: number
  readonly defaultColor: readonly [number, number, number]
}

export type BakedProbeGridSpec = {
  readonly min: readonly [number, number, number]
  readonly max: readonly [number, number, number]
  readonly dims: readonly [number, number, number]
  /** Per light (`[lightIdx][probeIdx]`), 12 floats: `[L0.r, L0.g, L0.b, L1x.r, L1x.g, L1x.b, L1y.r, L1y.g, L1y.b, L1z.r, L1z.g, L1z.b]`. */
  readonly shByLight: readonly (readonly (readonly number[])[])[]
}

/**
 * Per-triangle UV2 coordinates unwrapped by Blender's `bpy.ops.uv.lightmap_pack`:
 * `[triIndex, u0, v0, u1, v1, u2, v2]`.
 */
export type BakedTriUv2 = readonly [
  triIndex: number,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  u2: number,
  v2: number,
]

export type AnalyticSpotFloorCheck = {
  readonly height: number
  readonly coneHalfAngleRad: number
  readonly floorAlbedo: number
  readonly power: number
  /** Cycles-baked 1-bounce diffuse irradiance multiplied by `ENGINE_LIGHT_GAIN`. */
  readonly cyclesBounce: number
  /** Closed-form analytic 1-bounce diffuse irradiance in engine units. */
  readonly analyticBounce: number
}

export type BakedLightmapMeta = {
  readonly version: number
  readonly blenderVersion: string
  readonly inputHash: string
  readonly size: number
  readonly format: "rgb9e5ufloat"
  readonly samples: number
  readonly bounces: number
  readonly bounds: Aabb3
  readonly lights: readonly BakedLightSpec[]
  readonly probes: BakedProbeGridSpec
  readonly uv2Tris: readonly BakedTriUv2[]
  readonly analyticSpotFloorCheck: AnalyticSpotFloorCheck
}

export type BakedGiMode = "today" | "baked"

export type BakedGiSettings = {
  /** `"today"` disables baked indirect bounce (byte-identical to baseline); `"baked"` enables Cycles per-light GI. */
  giMode: BakedGiMode
  /** Overall indirect lightmap scale (`1.0` = exact physical unit calibration). */
  giIntensity: number
  /** Probe-volume irradiance scale on dynamic actors (`1.0` = exact physical unit calibration). */
  giProbes: number
}

export const BAKED_GI_DEFAULTS: Readonly<BakedGiSettings> = {
  giMode: "today",
  giIntensity: 1,
  giProbes: 1,
}

// ---------------------------------------------------------------------------
// Pure synchronous SHA-256 (for scene export input-hash verification)
// ---------------------------------------------------------------------------

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n))
}

/** Computes the lowercase hex SHA-256 digest of a UTF-8 string (matches Python `hashlib.sha256`). */
export function sha256Hex(input: string): string {
  const utf8 = new TextEncoder().encode(input)
  const bitLen = utf8.length * 8
  const padLen = ((utf8.length + 9 + 63) & ~63)
  const buf = new Uint8Array(padLen)
  buf.set(utf8)
  buf[utf8.length] = 0x80
  const view = new DataView(buf.buffer)
  view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false)
  view.setUint32(padLen - 4, bitLen >>> 0, false)

  let h0 = 0x6a09e667
  let h1 = 0xbb67ae85
  let h2 = 0x3c6ef372
  let h3 = 0xa54ff53a
  let h4 = 0x510e527f
  let h5 = 0x9b05688c
  let h6 = 0x1f83d9ab
  let h7 = 0x5be0cd19
  const w = new Uint32Array(64)

  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) >>> 0
      h = g; g = f; f = e; e = (d + temp1) >>> 0
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((v) => v.toString(16).padStart(8, "0")).join("")
}

// ---------------------------------------------------------------------------
// Analytic spot-floor 1-bounce reference (Blocker 2 verification)
// ---------------------------------------------------------------------------

/**
 * Closed-form 1-bounce diffuse indirect irradiance (in engine lighting units before receiver albedo) at a
 * downward-facing receiver at `(0, height, 0)` above a flat horizontal Lambertian floor (`y = 0`, albedo `floorAlbedo`)
 * illuminated by a downward spot light at `(0, height, 0)` with half-angle `coneHalfAngleRad` and engine `power`:
 *
 *   B = (2 * floorAlbedo * ENGINE_LIGHT_GAIN * power) / (5 * pi * height^2) * (1 - cos^5(coneHalfAngleRad))
 */
export function analyticSpotFloorBounce(opts: {
  height: number
  coneHalfAngleRad: number
  floorAlbedo: number
  power: number
}): number {
  const { height, coneHalfAngleRad, floorAlbedo, power } = opts
  const cosTheta = Math.cos(coneHalfAngleRad)
  const factor = 1 - cosTheta ** 5
  return ((2 * floorAlbedo * ENGINE_LIGHT_GAIN * power) / (5 * Math.PI * height * height)) * factor
}

// ---------------------------------------------------------------------------
// Engine Scene-to-JSON Exporter & Input Hash Verification (Blocker 5)
// ---------------------------------------------------------------------------

export type BakeSceneTriangle = {
  readonly triIndex: number
  readonly v0: readonly [number, number, number]
  readonly v1: readonly [number, number, number]
  readonly v2: readonly [number, number, number]
  readonly normal: readonly [number, number, number]
  /** Linear RGB reflectance (`srgb ^ 2.2`). */
  readonly color: readonly [number, number, number]
  readonly mat: number
  readonly aux: number
  readonly receiveLightmap: boolean
}

export type BakeSceneLight = {
  readonly key: string
  readonly id: number
  readonly pos: readonly [number, number, number]
  readonly r: number
  readonly size: number
  readonly bakedPower: number
  readonly defaultColor: readonly [number, number, number]
  readonly spot?: {
    readonly axis: readonly [number, number, number]
    readonly cosOuter: number
    readonly cosInner: number
  }
  readonly panel?: {
    readonly halfWidth: number
    readonly halfHeight: number
    readonly yaw: number
  }
}

export type BakeSceneSpec = {
  readonly version: 1
  readonly bounds: Aabb3
  readonly lightmapBounds: Aabb3
  readonly probes: {
    readonly min: readonly [number, number, number]
    readonly max: readonly [number, number, number]
    readonly dims: readonly [number, number, number]
  }
  readonly lights: readonly BakeSceneLight[]
  readonly triangles: readonly BakeSceneTriangle[]
}

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4
const r5 = (x: number): number => Math.round(x * 1e5) / 1e5

function decodeFloat16(bits: number): number {
  const s = (bits & 0x8000) ? -1 : 1
  const e = (bits >> 10) & 0x1f
  const f = bits & 0x3ff
  if (e === 0) return s * (2 ** -14) * (f / 1024)
  if (e === 31) return f ? NaN : s * Infinity
  return s * (2 ** (e - 15)) * (1 + f / 1024)
}

function encodeFloat16(val: number): number {
  if (!Number.isFinite(val) || val === 0) return 0
  const s = val < 0 ? 0x8000 : 0
  const a = Math.abs(val)
  const exp = Math.floor(Math.log2(a))
  if (exp < -14) {
    const f = Math.round(a / (2 ** -24))
    return s | Math.min(0x3ff, Math.max(0, f))
  }
  if (exp > 15) return s | 0x7c00
  const e = exp + 15
  const f = Math.round((a / (2 ** exp) - 1) * 1024)
  if (f >= 1024) return s | ((e + 1) << 10)
  return s | (e << 10) | Math.max(0, f)
}

function pointInAabb(p: readonly [number, number, number], box: Aabb3): boolean {
  return (
    p[0] >= box.min[0] && p[0] <= box.max[0] &&
    p[1] >= box.min[1] && p[1] <= box.max[1] &&
    p[2] >= box.min[2] && p[2] <= box.max[2]
  )
}

function triangleArea(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
): number {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
  const cx = uy * vz - uz * vy
  const cy = uz * vx - ux * vz
  const cz = ux * vy - uy * vx
  return 0.5 * Math.hypot(cx, cy, cz)
}

/**
 * Extracts a canonical `BakeSceneSpec` directly from a packed 24-byte/vertex kit mesh (`Mesh.pack()`) and live
 * physical `SceneLight`s so headless Blender Cycles (`scripts/bake-room.py`) bakes the engine's exact room geometry
 * and emitter parameters with zero hand-typed coordinates.
 */
export function extractBakeSceneSpec(opts: {
  packed24: ArrayBuffer
  bounds: Aabb3
  lightmapBounds: Aabb3
  probes: { min: readonly [number, number, number]; max: readonly [number, number, number]; dims: readonly [number, number, number] }
  lights: readonly { key: string; light: SceneLight }[]
  minReceiverArea?: number
}): BakeSceneSpec {
  const { packed24, bounds, lightmapBounds, probes, lights } = opts
  const minArea = opts.minReceiverArea ?? 0.25
  const f32 = new Float32Array(packed24)
  const i8 = new Int8Array(packed24)
  const u8 = new Uint8Array(packed24)
  const u16 = new Uint16Array(packed24)
  const numVerts = Math.floor(packed24.byteLength / VERT_BYTES)
  const numTris = Math.floor(numVerts / 3)
  const triangles: BakeSceneTriangle[] = []

  for (let t = 0; t < numTris; t++) {
    const vBase0 = t * 3
    const f0 = (vBase0 + 0) * 6
    const f1 = (vBase0 + 1) * 6
    const f2 = (vBase0 + 2) * 6
    const v0: [number, number, number] = [r4(f32[f0]!), r4(f32[f0 + 1]!), r4(f32[f0 + 2]!)]
    const v1: [number, number, number] = [r4(f32[f1]!), r4(f32[f1 + 1]!), r4(f32[f1 + 2]!)]
    const v2: [number, number, number] = [r4(f32[f2]!), r4(f32[f2 + 1]!), r4(f32[f2 + 2]!)]
    const inBounds = pointInAabb(v0, bounds) && pointInAabb(v1, bounds) && pointInAabb(v2, bounds)
    if (!inBounds) continue

    const b0 = vBase0 * VERT_BYTES
    const nx = i8[b0 + 12]! / 127
    const ny = i8[b0 + 13]! / 127
    const nz = i8[b0 + 14]! / 127
    const nLen = Math.hypot(nx, ny, nz) || 1
    const normal: [number, number, number] = [r4(nx / nLen), r4(ny / nLen), r4(nz / nLen)]

    const sr = u8[b0 + 16]! / 255
    const sg = u8[b0 + 17]! / 255
    const sb = u8[b0 + 18]! / 255
    const color: [number, number, number] = [r5(sr ** 2.2), r5(sg ** 2.2), r5(sb ** 2.2)]

    const hOff = b0 >>> 1
    const mat = Math.round(decodeFloat16(u16[hOff + 10]!))
    const aux = Math.round(decodeFloat16(u16[hOff + 11]!))
    const area = triangleArea(v0, v1, v2)

    const isStaticOccluder =
      mat === MAT.wall || mat === MAT.floor || mat === MAT.lit || mat === MAT.roof || mat === MAT.shiny
    if (!isStaticOccluder || area < 0.035) continue

    const isStaticSurface = mat === MAT.wall || mat === MAT.floor || mat === MAT.lit
    const minY = Math.min(v0[1], v1[1], v2[1])
    const isHiddenAtticTop = minY >= 2.83 && normal[1] > 0.5
    const inLmBounds = pointInAabb(v0, lightmapBounds) && pointInAabb(v1, lightmapBounds) && pointInAabb(v2, lightmapBounds)
    const receiveLightmap = isStaticSurface && inLmBounds && !isHiddenAtticTop && area >= minArea

    triangles.push({
      triIndex: t,
      v0,
      v1,
      v2,
      normal,
      color,
      mat,
      aux,
      receiveLightmap,
    })
  }

  const bakeLights: BakeSceneLight[] = lights.map(({ key, light }) => {
    if (light.id === undefined) throw new Error(`Bake light "${key}" is missing SceneLight.id`)
    return {
      key,
      id: light.id,
      pos: [r4(light.x), r4(light.h), r4(light.y)],
      r: r4(light.r),
      size: r4(light.size ?? 0.2),
      bakedPower: r5(light.power),
      defaultColor: [r4(light.color[0]), r4(light.color[1]), r4(light.color[2])],
      ...(light.spot
        ? {
            spot: {
              axis: [r5(light.spot.axis[0]), r5(light.spot.axis[1]), r5(light.spot.axis[2])],
              cosOuter: r5(light.spot.cosOuter),
              cosInner: r5(light.spot.cosInner),
            },
          }
        : {}),
      ...(light.panel
        ? {
            panel: {
              halfWidth: r4(light.panel.halfWidth),
              halfHeight: r4(light.panel.halfHeight),
              yaw: r5(light.panel.yaw),
            },
          }
        : {}),
    }
  })

  return {
    version: 1,
    bounds: { min: [...bounds.min], max: [...bounds.max] },
    lightmapBounds: { min: [...lightmapBounds.min], max: [...lightmapBounds.max] },
    probes: { min: [...probes.min], max: [...probes.max], dims: [...probes.dims] },
    lights: bakeLights,
    triangles,
  }
}

/** Serializes a `BakeSceneSpec` deterministically for SHA-256 hashing and Blender input. */
export function canonicalBakeSceneJson(spec: BakeSceneSpec): string {
  return JSON.stringify(spec)
}

/** Computes the SHA-256 input hash of a `BakeSceneSpec`. */
export function computeBakeSceneInputHash(spec: BakeSceneSpec): string {
  return sha256Hex(canonicalBakeSceneJson(spec))
}

/**
 * Verifies that a baked lightmap asset's `inputHash` and `blenderVersion` match the current engine `BakeSceneSpec`.
 * Throws an error if the scene geometry or lights changed without re-running `scripts/bake-room.py`.
 */
export function assertBakedLightmapFresh(meta: BakedLightmapMeta, currentSpec: BakeSceneSpec): void {
  if (!meta.blenderVersion || meta.blenderVersion.trim().length === 0) {
    throw new Error("Baked lightmap metadata is missing blenderVersion.")
  }
  const expectedHash = computeBakeSceneInputHash(currentSpec)
  if (meta.inputHash !== expectedHash) {
    throw new Error(
      `Baked lightmap asset is stale: meta.inputHash (${meta.inputHash}) !== current scene hash (${expectedHash}). Re-run scripts/bake-room.py.`,
    )
  }
}

// ---------------------------------------------------------------------------
// IEEE / WebGPU rgb9e5ufloat codec (32-bit shared-exponent HDR RGB)
// ---------------------------------------------------------------------------

const RGB9E5_MAX = 65408.0

/** Packs linear HDR `(r, g, b)` into a 32-bit `rgb9e5ufloat` word (9-bit mantissas, 5-bit shared exponent, bias 15). */
export function packRgb9e5(r: number, g: number, b: number): number {
  const cr = Number.isFinite(r) ? Math.max(0, Math.min(RGB9E5_MAX, r)) : 0
  const cg = Number.isFinite(g) ? Math.max(0, Math.min(RGB9E5_MAX, g)) : 0
  const cb = Number.isFinite(b) ? Math.max(0, Math.min(RGB9E5_MAX, b)) : 0
  const maxC = Math.max(cr, cg, cb)
  if (maxC < 2 ** -24) return 0
  const exp0 = Math.max(0, Math.floor(Math.log2(maxC)) + 16)
  const maxM = Math.floor(maxC * 2 ** (24 - exp0) + 0.5)
  const exp = Math.min(31, exp0 + (maxM >= 512 ? 1 : 0))
  const scale = 2 ** (24 - exp)
  const mr = Math.min(511, Math.floor(cr * scale + 0.5))
  const mg = Math.min(511, Math.floor(cg * scale + 0.5))
  const mb = Math.min(511, Math.floor(cb * scale + 0.5))
  return (mr | (mg << 9) | (mb << 18) | (exp << 27)) >>> 0
}

/** Unpacks a 32-bit `rgb9e5ufloat` word into linear HDR `[r, g, b]`. */
export function unpackRgb9e5(word: number): [number, number, number] {
  const u = word >>> 0
  const mr = u & 0x1ff
  const mg = (u >>> 9) & 0x1ff
  const mb = (u >>> 18) & 0x1ff
  const exp = (u >>> 27) & 0x1f
  const scale = 2 ** (exp - 24)
  return [mr * scale, mg * scale, mb * scale]
}

/** Decodes a base64-encoded `rgb9e5ufloat` array buffer into a `Uint32Array` of packed texels. */
export function decodeRgb9e5Base64(b64: string): Uint32Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 2)
}

/** Encodes a flat `Float32Array` of linear RGB triples (`length = 3 * texels`) into `rgb9e5ufloat` `Uint32Array`. */
export function encodeRgb9e5Words(rgb: Float32Array): Uint32Array {
  const n = Math.floor(rgb.length / 3)
  const out = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = packRgb9e5(rgb[i * 3]!, rgb[i * 3 + 1]!, rgb[i * 3 + 2]!)
  }
  return out
}

// ---------------------------------------------------------------------------
// Per-vertex Blender-unwrapped UV2 application (Blocker 3)
// ---------------------------------------------------------------------------

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x))

/** Extended 32-byte static mesh layout carrying `@location(4) uv: float32x2` (lightmap UV2 channel). */
export const MESH_UV2_BYTES = 32

export const MESH_UV2_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: MESH_UV2_BYTES,
  attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x3" },
    { shaderLocation: 1, offset: 12, format: "snorm8x4" },
    { shaderLocation: 2, offset: 16, format: "unorm8x4" },
    { shaderLocation: 3, offset: 20, format: "float16x2" },
    { shaderLocation: 4, offset: 24, format: "float32x2" },
  ],
}

function writeVertexBakedUv2InPlace(
  i8: Int8Array,
  u8: Uint8Array,
  u16: Uint16Array,
  vertIndex: number,
  u: number,
  v: number,
): void {
  const bOff = vertIndex * VERT_BYTES
  const hOff = bOff >>> 1
  const q = Math.round(clamp01(u) * 32511)
  const hi = 1 + (q >> 8) // 1..127 in snorm8 normal.w (0 = unlightmapped)
  const lo = q & 0xff // 0..255 in unorm8 color.a
  i8[bOff + 15] = hi
  u8[bOff + 19] = lo
  const floorKind = Math.round(decodeFloat16(u16[hOff + 11]!))
  const encodedAux = floorKind + (clamp01(v) - 0.5) * 0.4
  u16[hOff + 11] = encodeFloat16(encodedAux)
}

/**
 * Stamps the Blender-unwrapped (`bpy.ops.uv.lightmap_pack`) per-vertex UV2 coordinates from `meta.uv2Tris`
 * in-place into a 24-byte/vertex packed kit mesh (`packed24`).
 */
export function applyBakedUv2ToMesh(packed24: ArrayBuffer, meta: Pick<BakedLightmapMeta, "uv2Tris"> = HOUSE_LIGHTMAP_META): void {
  const i8 = new Int8Array(packed24)
  const u8 = new Uint8Array(packed24)
  const u16 = new Uint16Array(packed24)
  const numVerts = Math.floor(packed24.byteLength / VERT_BYTES)
  const numTris = Math.floor(numVerts / 3)

  for (const [triIdx, u0, v0, u1, v1, u2, v2] of meta.uv2Tris) {
    if (triIdx < 0 || triIdx >= numTris) continue
    const baseV = triIdx * 3
    writeVertexBakedUv2InPlace(i8, u8, u16, baseV + 0, u0, v0)
    writeVertexBakedUv2InPlace(i8, u8, u16, baseV + 1, u1, v1)
    writeVertexBakedUv2InPlace(i8, u8, u16, baseV + 2, u2, v2)
  }
}

/**
 * Takes a 24-byte/vertex packed kit mesh (`Mesh.pack()`) and returns a 32-byte/vertex buffer (`MESH_UV2_LAYOUT`)
 * populated with the Blender-unwrapped per-vertex UV2 coordinates from `meta.uv2Tris` at `@location(4)` (offset 24).
 */
export function packMeshWithUv2(
  packed24: ArrayBuffer,
  meta: Pick<BakedLightmapMeta, "uv2Tris"> = HOUSE_LIGHTMAP_META,
): ArrayBuffer {
  const count = Math.floor(packed24.byteLength / VERT_BYTES)
  const out = new ArrayBuffer(count * MESH_UV2_BYTES)
  const srcBytes = new Uint8Array(packed24)
  const dstBytes = new Uint8Array(out)
  const dstF32 = new Float32Array(out)

  for (let i = 0; i < count; i++) {
    const sOff = i * VERT_BYTES
    const dOff = i * MESH_UV2_BYTES
    dstBytes.set(srcBytes.subarray(sOff, sOff + VERT_BYTES), dOff)
    dstF32[(dOff >>> 2) + 6] = 0
    dstF32[(dOff >>> 2) + 7] = 0
  }

  const numTris = Math.floor(count / 3)
  for (const [triIdx, u0, v0, u1, v1, u2, v2] of meta.uv2Tris) {
    if (triIdx < 0 || triIdx >= numTris) continue
    const baseV = triIdx * 3
    dstF32[(baseV + 0) * 8 + 6] = u0
    dstF32[(baseV + 0) * 8 + 7] = v0
    dstF32[(baseV + 1) * 8 + 6] = u1
    dstF32[(baseV + 1) * 8 + 7] = v1
    dstF32[(baseV + 2) * 8 + 6] = u2
    dstF32[(baseV + 2) * 8 + 7] = v2
  }
  return out
}

// ---------------------------------------------------------------------------
// Per-light linear RGB weight evaluation & L1 SH probe grid interpolation (Blocker 1)
// ---------------------------------------------------------------------------

export const MAX_BAKED_LIGHTS = 4
export const PROBE_COUNT = 32
export const PROBE_VEC4S = PROBE_COUNT * 3 // 96 vec4f = 384 floats

/**
 * Evaluates the live linear RGB weight `[r, g, b]` for each baked light layer:
 *
 *   `weight_k = liveColor_k * (livePower_k / bakedPower_k) * giIntensity`
 *
 * - Strictly linear in `livePower_k / bakedPower_k` with no threshold jumps.
 * - When a `LiveBounceSource` is present for `spec.id`, it is authoritative: if `scale() <= 0`, returns `[0, 0, 0]`
 *   immediately without falling through to `sceneLights`.
 */
export function evaluateBakedLightWeights(
  meta: Pick<BakedLightmapMeta, "lights">,
  sceneLights: readonly SceneLight[],
  liveSources: readonly LiveBounceSource[] = [],
  settings: Pick<BakedGiSettings, "giMode" | "giIntensity"> = { giMode: "baked", giIntensity: 1 },
): [number, number, number][] {
  if (settings.giMode === "today" || !(settings.giIntensity > 0)) {
    return meta.lights.map(() => [0, 0, 0])
  }
  const gi = settings.giIntensity
  return meta.lights.map((spec) => {
    const bakedPower = Math.max(1e-6, spec.bakedPower)
    const live = liveSources.find((s) => s.id === spec.id)
    if (live !== undefined) {
      const s = live.scale()
      if (!(s > 0)) return [0, 0, 0]
      const c = live.color()
      const w = s * gi
      return [Math.max(0, c[0]) * w, Math.max(0, c[1]) * w, Math.max(0, c[2]) * w]
    }
    const sceneLight = sceneLights.find((l) => l.id === spec.id)
    if (!sceneLight || !(sceneLight.power > 0)) return [0, 0, 0]
    const w = (sceneLight.power / bakedPower) * gi
    return [
      Math.max(0, sceneLight.color[0]) * w,
      Math.max(0, sceneLight.color[1]) * w,
      Math.max(0, sceneLight.color[2]) * w,
    ]
  })
}

/**
 * Sums the per-light L1 SH probe grids on CPU weighted by each light's live RGB `[wr, wg, wb]`.
 * Writes `32 * 12 = 384` floats (96 `vec4f`s) into `out` at `offset`.
 */
export function sumProbeGridForWeights(
  probes: BakedProbeGridSpec,
  weights: readonly (readonly [number, number, number])[],
  out: Float32Array,
  offset = 0,
  probeScale = 1,
): void {
  const [nx, ny, nz] = probes.dims
  const total = Math.min(PROBE_COUNT, nx * ny * nz)
  out.fill(0, offset, offset + PROBE_VEC4S * 4)
  if (!(probeScale > 0)) return

  for (let l = 0; l < weights.length && l < probes.shByLight.length; l++) {
    const [wr, wg, wb] = weights[l]!
    if (wr + wg + wb <= 1e-7) continue
    const rw = wr * probeScale
    const gw = wg * probeScale
    const bw = wb * probeScale
    const grid = probes.shByLight[l]!
    for (let p = 0; p < total; p++) {
      const sh = grid[p]!
      const base = offset + p * 12
      out[base + 0]! += sh[0]! * rw
      out[base + 1]! += sh[1]! * gw
      out[base + 2]! += sh[2]! * bw
      out[base + 3]! += sh[3]! * rw
      out[base + 4]! += sh[4]! * gw
      out[base + 5]! += sh[5]! * bw
      out[base + 6]! += sh[6]! * rw
      out[base + 7]! += sh[7]! * gw
      out[base + 8]! += sh[8]! * bw
      out[base + 9]! += sh[9]! * rw
      out[base + 10]! += sh[10]! * gw
      out[base + 11]! += sh[11]! * bw
    }
  }
}

function evalProbeL1(sh: Float32Array, base: number, nx: number, ny: number, nz: number): [number, number, number] {
  const r = Math.max(0, sh[base + 0]! + sh[base + 3]! * nx + sh[base + 6]! * ny + sh[base + 9]! * nz)
  const g = Math.max(0, sh[base + 1]! + sh[base + 4]! * nx + sh[base + 7]! * ny + sh[base + 10]! * nz)
  const b = Math.max(0, sh[base + 2]! + sh[base + 5]! * nx + sh[base + 8]! * ny + sh[base + 11]! * nz)
  return [r * ENGINE_LIGHT_GAIN, g * ENGINE_LIGHT_GAIN, b * ENGINE_LIGHT_GAIN]
}

/**
 * CPU reference sampler for the 3D L1 SH irradiance probe grid (matches the WGSL `sampleBakedProbeVolume` function).
 */
export function sampleProbeGridCpu(
  summedProbes: Float32Array,
  probesMeta: Pick<BakedProbeGridSpec, "min" | "max" | "dims">,
  pos: readonly [number, number, number],
  normal: readonly [number, number, number],
  offset = 0,
): [number, number, number] {
  const [nx, ny, nz] = probesMeta.dims
  const [x0, y0, z0] = probesMeta.min
  const [x1, y1, z1] = probesMeta.max
  const gx = clamp01((pos[0] - x0) / Math.max(1e-5, x1 - x0)) * (nx - 1)
  const gy = clamp01((pos[1] - y0) / Math.max(1e-5, y1 - y0)) * (ny - 1)
  const gz = clamp01((pos[2] - z0) / Math.max(1e-5, z1 - z0)) * (nz - 1)

  const ix0 = Math.min(nx - 1, Math.floor(gx))
  const iy0 = Math.min(ny - 1, Math.floor(gy))
  const iz0 = Math.min(nz - 1, Math.floor(gz))
  const ix1 = Math.min(nx - 1, ix0 + 1)
  const iy1 = Math.min(ny - 1, iy0 + 1)
  const iz1 = Math.min(nz - 1, iz0 + 1)
  const fx = gx - ix0
  const fy = gy - iy0
  const fz = gz - iz0

  let r = 0, g = 0, b = 0
  for (let dz = 0; dz < 2; dz++) {
    const iz = dz ? iz1 : iz0
    const wz = dz ? fz : 1 - fz
    for (let dy = 0; dy < 2; dy++) {
      const iy = dy ? iy1 : iy0
      const wy = dy ? fy : 1 - fy
      for (let dx = 0; dx < 2; dx++) {
        const ix = dx ? ix1 : ix0
        const wx = dx ? fx : 1 - fx
        const w = wx * wy * wz
        const pIdx = (iz * ny + iy) * nx + ix
        const [pr, pg, pb] = evalProbeL1(summedProbes, offset + pIdx * 12, normal[0], normal[1], normal[2])
        r += pr * w
        g += pg * w
        b += pb * w
      }
    }
  }
  return [r, g, b]
}

/**
 * CPU reference sampler for the per-light `rgb9e5ufloat` lightmap array at explicit unwrapped `(u, v)` coordinates.
 */
export function sampleUv2LightmapCpu(
  words: Uint32Array,
  meta: Pick<BakedLightmapMeta, "size" | "lights">,
  weights: readonly (readonly [number, number, number])[],
  uv2: readonly [number, number],
): [number, number, number] {
  const size = meta.size
  const x = Math.min(size - 1, Math.max(0, Math.floor(clamp01(uv2[0]) * size)))
  const y = Math.min(size - 1, Math.max(0, Math.floor(clamp01(uv2[1]) * size)))
  const layerStride = size * size
  let r = 0, g = 0, b = 0
  for (let l = 0; l < weights.length && l < meta.lights.length; l++) {
    const [wr, wg, wb] = weights[l]!
    if (wr + wg + wb <= 1e-7) continue
    const [lr, lg, lb] = unpackRgb9e5(words[l * layerStride + y * size + x]!)
    r += lr * wr * ENGINE_LIGHT_GAIN
    g += lg * wg * ENGINE_LIGHT_GAIN
    b += lb * wb * ENGINE_LIGHT_GAIN
  }
  return [r, g, b]
}

// ---------------------------------------------------------------------------
// WebGPU texture upload, uniform packing, and WGSL scene hooks
// ---------------------------------------------------------------------------

export type BakedLightmapGpu = {
  readonly texture: GPUTexture
  readonly view: GPUTextureView
  readonly sampler: GPUSampler
  readonly words: Uint32Array
  readonly byteLength: number
  readonly meta: BakedLightmapMeta
}

/**
 * Uploads a multi-layer `rgb9e5ufloat` baked lightmap texture array to the GPU and returns its `2d-array` view.
 */
export function uploadBakedLightmapTexture(
  device: GPUDevice,
  meta: BakedLightmapMeta = HOUSE_LIGHTMAP_META,
  wordsOrB64: Uint32Array | string = HOUSE_LIGHTMAP_RGB9E5_B64,
): BakedLightmapGpu {
  const words = typeof wordsOrB64 === "string" ? decodeRgb9e5Base64(wordsOrB64) : wordsOrB64
  const size = meta.size
  const layers = meta.lights.length
  const texture = device.createTexture({
    label: "baked-lightmap-rgb9e5-array",
    size: [size, size, layers],
    format: "rgb9e5ufloat",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  device.queue.writeTexture(
    { texture },
    new Uint8Array(words.buffer as ArrayBuffer, words.byteOffset, words.byteLength),
    { bytesPerRow: size * 4, rowsPerImage: size },
    [size, size, layers],
  )
  const view = texture.createView({ dimension: "2d-array" })
  const sampler = device.createSampler({
    label: "baked-lightmap-linear",
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  })
  const probeBytes = meta.probes.dims[0] * meta.probes.dims[1] * meta.probes.dims[2] * 12 * 4
  return {
    texture,
    view,
    sampler,
    words,
    byteLength: words.byteLength + probeBytes,
    meta,
  }
}

export const BAKED_GI_UNIFORM_OFFSET = 12
export const BAKED_GI_UNIFORM_FLOATS = 432 // 1728 bytes (< 2048 bytes CUSTOM_UNIFORM_BYTES)

export function packBakedLightmapUniforms(
  out: Float32Array,
  meta: BakedLightmapMeta,
  sceneLights: readonly SceneLight[],
  settings: BakedGiSettings,
  liveSources: readonly LiveBounceSource[] = [],
  offset = BAKED_GI_UNIFORM_OFFSET,
): void {
  const active = settings.giMode === "baked" && (settings.giIntensity > 0 || settings.giProbes > 0)
  if (!active) {
    out.fill(0, offset, offset + (BAKED_GI_UNIFORM_FLOATS - BAKED_GI_UNIFORM_OFFSET))
    return
  }

  const weights = evaluateBakedLightWeights(meta, sceneLights, liveSources, settings)
  const b = meta.bounds
  const p = meta.probes

  // giParams: (enabled, probeScale, 0, 0)
  out[offset + 0] = 1
  out[offset + 1] = settings.giProbes
  out[offset + 2] = 0
  out[offset + 3] = 0

  // giWeights[0..3]
  for (let i = 0; i < MAX_BAKED_LIGHTS; i++) {
    const w = weights[i] ?? [0, 0, 0]
    const wo = offset + 4 + i * 4
    out[wo + 0] = w[0]
    out[wo + 1] = w[1]
    out[wo + 2] = w[2]
    out[wo + 3] = 0
  }

  // giRoomMin & giRoomMax
  out[offset + 20] = b.min[0]
  out[offset + 21] = b.min[1]
  out[offset + 22] = b.min[2]
  out[offset + 23] = 0

  out[offset + 24] = b.max[0]
  out[offset + 25] = b.max[1]
  out[offset + 26] = b.max[2]
  out[offset + 27] = 0

  // giProbeMin & giProbeMax
  out[offset + 28] = p.min[0]
  out[offset + 29] = p.min[1]
  out[offset + 30] = p.min[2]
  out[offset + 31] = p.dims[0]

  out[offset + 32] = p.max[0]
  out[offset + 33] = p.max[1]
  out[offset + 34] = p.max[2]
  out[offset + 35] = p.dims[2]

  // giProbes[0..95] (384 floats at offset + 36)
  const probeWeights = evaluateBakedLightWeights(meta, sceneLights, liveSources, {
    giMode: settings.giMode,
    giIntensity: 1,
  })
  sumProbeGridForWeights(p, probeWeights, out, offset + 36, settings.giProbes)
}

export type BakedLightmapHookOptions = {
  /** Uniform struct name bound at `@group(0) @binding(13)` (defaults to `"PK"`). */
  uniformName?: string
  /** If true, reads explicit `@location(4) uv: vec2f` from vertex buffer (`MESH_UV2_LAYOUT`). */
  useVertexUv2?: boolean
}

/**
 * WGSL declarations, `hooks.vertex`, and `hooks.bounce` expression for per-light Cycles lightmaps + L1 SH probe volume.
 * - Lightmapped static surfaces (`isLightmapped`) sample the Blender-unwrapped UV2 lightmap array ONLY (`lmIrr`).
 * - Dynamic objects (`MAT.actor`) sample the 3D L1 SH probe volume ONLY (`probeIrr`).
 */
export function bakedLightmapHooks(base: SceneHooks = {}, opts: BakedLightmapHookOptions = {}): SceneHooks {
  const U = opts.uniformName ?? "PK"
  const fnBlock = /* wgsl */ `
@group(0) @binding(15) var uDetailTex: texture_2d_array<f32>;
@group(0) @binding(16) var uDetailSampler: sampler;

const BAKED_ENGINE_GAIN: f32 = 5.0;

fn evalBakedProbeL1(pIdx: i32, n: vec3f) -> vec3f {
  let b = clamp(pIdx, 0, 31) * 3;
  let v0 = ${U}.giProbes[b];
  let v1 = ${U}.giProbes[b + 1];
  let v2 = ${U}.giProbes[b + 2];
  let l0 = v0.xyz;
  let l1x = vec3f(v0.w, v1.xy);
  let l1y = vec3f(v1.zw, v2.x);
  let l1z = v2.yzw;
  return max(vec3f(0.0), l0 + l1x * n.x + l1y * n.y + l1z * n.z);
}

fn sampleBakedProbeVolume(pos: vec3f, n: vec3f) -> vec3f {
  let pmin = ${U}.giProbeMin.xyz;
  let pmax = ${U}.giProbeMax.xyz;
  let g = clamp((pos - pmin) / max(vec3f(1e-4), pmax - pmin), vec3f(0.0), vec3f(1.0)) * vec3f(3.0, 1.0, 3.0);
  let i0 = vec3i(floor(g));
  let i1 = min(vec3i(3, 1, 3), i0 + vec3i(1, 1, 1));
  let f = g - vec3f(i0);
  var sum = vec3f(0.0);
  for (var dz = 0; dz < 2; dz++) {
    let iz = select(i0.z, i1.z, dz == 1);
    let wz = select(1.0 - f.z, f.z, dz == 1);
    for (var dy = 0; dy < 2; dy++) {
      let iy = select(i0.y, i1.y, dy == 1);
      let wy = select(1.0 - f.y, f.y, dy == 1);
      for (var dx = 0; dx < 2; dx++) {
        let ix = select(i0.x, i1.x, dx == 1);
        let wx = select(1.0 - f.x, f.x, dx == 1);
        let pIdx = (iz * 2 + iy) * 4 + ix;
        sum += evalBakedProbeL1(pIdx, n) * (wx * wy * wz);
      }
    }
  }
  return sum * BAKED_ENGINE_GAIN;
}

fn sampleBakedIndirect(pos: vec3f, n: vec3f, rawNormal: vec3f, aux: f32, explicitUv2: vec2f, mat: f32, prevBounce: vec3f) -> vec3f {
  if (${U}.giParams.x < 0.5) { return prevBounce; }

  // 1. Dynamic objects (MAT.actor) inside the probe grid use the 3D L1 SH probe volume ONLY.
  if (abs(mat - ${MAT.actor}.0) < 0.5) {
    let pmin = ${U}.giProbeMin.xyz;
    let pmax = ${U}.giProbeMax.xyz;
    let dOut = max(vec3f(0.0), max(pmin - pos, pos - pmax));
    let falloff = clamp(1.0 - length(dOut) / 1.25, 0.0, 1.0);
    if (falloff <= 0.0) { return prevBounce; }
    return mix(prevBounce, sampleBakedProbeVolume(pos, n), falloff);
  }

  // 2. Lightmapped static surfaces use their Blender-unwrapped per-vertex UV2 lightmap ONLY (no probe double-count).
  let nLen = length(rawNormal);
  let hasPackedUv2 = nLen >= 1.5;
  let hasExplicitUv2 = ${opts.useVertexUv2 ? "length(explicitUv2) > 1e-5" : "false"};
  if (!hasPackedUv2 && !hasExplicitUv2) {
    return prevBounce;
  }
  let packedUv2 = vec2f(clamp(nLen - 2.0, 0.0, 1.0), clamp((aux - round(aux)) * 2.5 + 0.5, 0.0, 1.0));
  let lmUv = select(packedUv2, explicitUv2, hasExplicitUv2);
  var lmIrr = vec3f(0.0);
  for (var l = 0; l < 4; l++) {
    let w = ${U}.giWeights[l].rgb;
    if (w.r + w.g + w.b > 1e-6) {
      lmIrr += textureSampleLevel(uDetailTex, uDetailSampler, lmUv, l, 0.0).rgb * w;
    }
  }
  return lmIrr * BAKED_ENGINE_GAIN;
}
`
  const vertHook = /* wgsl */ `
  let lmHi = round(max(0.0, v.normal.w) * 127.0);
  if (lmHi >= 0.5 && v.matAux.x != 13.0) {
    let lmLo = round(v.color.a * 255.0);
    let lmU = clamp(((lmHi - 1.0) * 256.0 + lmLo) / 32511.0, 0.0, 1.0);
    o.normal = normalize(v.normal.xyz) * (2.0 + lmU);
  }
`
  const prevBounce = base.bounce ?? "bounceAt(o.world.xz + n.xz * 0.3) * 0.32"
  const uvExpr = opts.useVertexUv2 ? "o.uv" : "vec2f(0.0)"
  return {
    ...base,
    ...(opts.useVertexUv2 ? { uv: true } : {}),
    vertex: `${base.vertex ?? ""}\n${vertHook}`,
    declarations: `${base.declarations ?? ""}\n${fnBlock}`,
    bounce: `sampleBakedIndirect(o.world, n, o.normal, o.aux, ${uvExpr}, o.mat, (${prevBounce}))`,
  }
}

export const BAKED_GI_STRUCT_FIELDS_WGSL = /* wgsl */ `
  giParams: vec4f,
  giWeights: array<vec4f, 4>,
  giRoomMin: vec4f,
  giRoomMax: vec4f,
  giProbeMin: vec4f,
  giProbeMax: vec4f,
  giProbes: array<vec4f, 96>,
`

/** Lab controls for baked per-light GI (`Today` vs `Cycles baked GI`). */
export function bakedLightmapControls(group = "Clock & light", subsection = "Baked GI"): LabControl[] {
  return [
    {
      key: "giMode",
      label: "Indirect bounce (GI)",
      group,
      subsection,
      type: "select",
      options: [
        { value: "today", label: "Today (flat bounce)" },
        { value: "baked", label: "Cycles per-light lightmap + L1 SH probes" },
      ],
    },
    { key: "giIntensity", label: "Lightmap bounce", group, subsection, type: "range", min: 0, max: 3, step: 0.05, unit: "×" },
    { key: "giProbes", label: "L1 SH probe grid", group, subsection, type: "range", min: 0, max: 3, step: 0.05, unit: "×" },
  ]
}

// ---------------------------------------------------------------------------
// Forest canopy-openness ambient baker (matches packages/kit/forest/build.ts)
// ---------------------------------------------------------------------------

export type CanopyOpennessTree = {
  readonly count: number
  readonly x: Float32Array
  readonly z: Float32Array
  readonly scale: Float32Array
  readonly variant: Uint8Array
}

export type CanopyOpennessModel = {
  readonly impostor: { readonly w: number; readonly h: number }
  readonly sapling?: boolean
}

export type CanopyOpennessMap = {
  readonly size: number
  readonly x0: number
  readonly z0: number
  readonly x1: number
  readonly z1: number
  /** Sky openness `0..255` (`255` = open clearing, lower = under dense canopy), matching `forest/build.ts` `field.r`. */
  readonly data: Uint8Array
}

function blurCanopyField(src: Float32Array, n: number, passes: number): Float32Array {
  let a = new Float32Array(src)
  let b = new Float32Array(src.length)
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < n; j++) {
      const row = j * n
      for (let i = 0; i < n; i++) {
        let s = 0, c = 0
        for (let d = -2; d <= 2; d++) {
          const ii = i + d
          if (ii >= 0 && ii < n) { s += a[row + ii]!; c++ }
        }
        b[row + i] = s / c
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        let s = 0, c = 0
        for (let d = -2; d <= 2; d++) {
          const jj = j + d
          if (jj >= 0 && jj < n) { s += b[jj * n + i]!; c++ }
        }
        a[j * n + i] = s / c
      }
    }
  }
  return a
}

export function bakeCanopyOpenness(
  trees: CanopyOpennessTree,
  models: readonly CanopyOpennessModel[],
  opts: { size?: number; bounds?: readonly [number, number, number, number]; blurPasses?: number } = {},
): CanopyOpennessMap {
  const size = Math.max(8, opts.size ?? 256)
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity
  if (opts.bounds) {
    ;[x0, z0, x1, z1] = opts.bounds
  } else if (trees.count > 0) {
    for (let k = 0; k < trees.count; k++) {
      x0 = Math.min(x0, trees.x[k]!)
      x1 = Math.max(x1, trees.x[k]!)
      z0 = Math.min(z0, trees.z[k]!)
      z1 = Math.max(z1, trees.z[k]!)
    }
    x0 -= 12; z0 -= 12; x1 += 12; z1 += 12
  } else {
    x0 = -64; z0 = -64; x1 = 64; z1 = 64
  }

  const spanX = Math.max(1, x1 - x0)
  const spanZ = Math.max(1, z1 - z0)
  const texelX = spanX / size
  const texelZ = spanZ / size
  const crown = new Float32Array(size * size)

  for (let k = 0; k < trees.count; k++) {
    const v = trees.variant[k]!
    const m = models[v]
    if (!m) continue
    const rad = Math.max(0.8, 0.5 * m.impostor.w * trees.scale[k]!)
    const weight = m.sapling ? 0.22 : 0.55
    const tx = trees.x[k]!
    const tz = trees.z[k]!
    const i0 = Math.max(0, Math.floor((tx - rad - x0) / texelX))
    const i1 = Math.min(size, Math.ceil((tx + rad - x0) / texelX))
    const j0 = Math.max(0, Math.floor((tz - rad - z0) / texelZ))
    const j1 = Math.min(size, Math.ceil((tz + rad - z0) / texelZ))
    for (let j = j0; j < j1; j++) {
      const z = z0 + (j + 0.5) * texelZ
      const row = j * size
      for (let i = i0; i < i1; i++) {
        const x = x0 + (i + 0.5) * texelX
        const d = Math.hypot(x - tx, z - tz) / rad
        if (d < 1) crown[row + i]! += (1 - d * d) * weight
      }
    }
  }

  const blurred = blurCanopyField(crown, size, opts.blurPasses ?? 3)
  const data = new Uint8Array(size * size)
  for (let idx = 0; idx < data.length; idx++) {
    data[idx] = Math.round(255 * Math.exp(-blurred[idx]! * 1.2))
  }
  return { size, x0, z0, x1, z1, data }
}

export function sampleCanopyOpenness(map: CanopyOpennessMap, x: number, z: number): number {
  const { size, x0, z0, x1, z1, data } = map
  const u = clamp01((x - x0) / Math.max(1e-5, x1 - x0)) * (size - 1)
  const v = clamp01((z - z0) / Math.max(1e-5, z1 - z0)) * (size - 1)
  const i0 = Math.min(size - 1, Math.floor(u))
  const j0 = Math.min(size - 1, Math.floor(v))
  const i1 = Math.min(size - 1, i0 + 1)
  const j1 = Math.min(size - 1, j0 + 1)
  const fu = u - i0
  const fv = v - j0
  const s00 = data[j0 * size + i0]! / 255
  const s10 = data[j0 * size + i1]! / 255
  const s01 = data[j1 * size + i0]! / 255
  const s11 = data[j1 * size + i1]! / 255
  return (s00 * (1 - fu) + s10 * fu) * (1 - fv) + (s01 * (1 - fu) + s11 * fu) * fv
}
