/**
 * Growable writer for the kit's 32-byte textured vertices (`TEXTURED_VERTEX_LAYOUT`): position f32×3, normal
 * snorm8×4, colour unorm8×4, (material, aux) f16×2, uv f32×2. The forest packs its wind and blend weights into the
 * colour channels and the texture-array layer (plus a wind phase in its fraction) into aux.
 */
export type V3 = readonly [number, number, number]
export type RGBA = readonly [number, number, number, number]

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer)
export function toHalf(v: number): number {
  f32[0] = v
  const x = u32[0]!
  const sign = (x >>> 16) & 0x8000
  let e = ((x >>> 23) & 0xff) - 127 + 15
  let m = x & 0x7fffff
  if (e <= 0) {
    if (e < -10) return sign
    m = (m | 0x800000) >> (1 - e)
    return sign | ((m + 0x1000) >> 13)
  }
  if (e >= 31) return sign | 0x7c00
  m += 0x1000
  if (m & 0x800000) { m = 0; e++ }
  if (e >= 31) return sign | 0x7c00
  return sign | (e << 10) | (m >> 13)
}

export class VertexWriter {
  private buf = new ArrayBuffer(32 * 1024)
  private f = new Float32Array(this.buf)
  private b = new Uint8Array(this.buf)
  private s = new Int8Array(this.buf)
  private h = new Uint16Array(this.buf)
  count = 0

  private grow(n: number) {
    if ((this.count + n) * 32 <= this.buf.byteLength) return
    let size = this.buf.byteLength * 2
    while (size < (this.count + n) * 32) size *= 2
    const next = new ArrayBuffer(size)
    new Uint8Array(next).set(this.b)
    this.buf = next
    this.f = new Float32Array(next); this.b = new Uint8Array(next); this.s = new Int8Array(next); this.h = new Uint16Array(next)
  }

  vert(px: number, py: number, pz: number, nx: number, ny: number, nz: number, c: RGBA, mat: number, aux: number, u: number, v: number) {
    this.grow(1)
    const o = this.count * 32, fo = o / 4
    this.f[fo] = px; this.f[fo + 1] = py; this.f[fo + 2] = pz
    const l = Math.hypot(nx, ny, nz) || 1
    this.s[o + 12] = Math.round((nx / l) * 127); this.s[o + 13] = Math.round((ny / l) * 127); this.s[o + 14] = Math.round((nz / l) * 127); this.s[o + 15] = 0
    this.b[o + 16] = Math.round(clamp01(c[0]) * 255); this.b[o + 17] = Math.round(clamp01(c[1]) * 255); this.b[o + 18] = Math.round(clamp01(c[2]) * 255); this.b[o + 19] = Math.round(clamp01(c[3]) * 255)
    this.h[(o + 20) / 2] = toHalf(mat); this.h[(o + 22) / 2] = toHalf(aux)
    this.f[fo + 6] = u; this.f[fo + 7] = v
    this.count++
  }

  /** Appends raw textured vertices (already in world space). */
  raw(bytes: ArrayBuffer) {
    const n = bytes.byteLength / 32
    this.grow(n)
    this.b.set(new Uint8Array(bytes), this.count * 32)
    this.count += n
  }

  finish(): ArrayBuffer { return this.buf.slice(0, this.count * 32) }

  /** The live buffer, for editing written vertices in place (replaced when the writer grows). */
  get buffer(): ArrayBuffer { return this.buf }
}

/** Float of an IEEE half (material and aux are stored as f16). */
export function fromHalf(h: number): number {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023
  if (e === 0) return s * m * 2 ** -24
  if (e === 31) return m ? NaN : s * Infinity
  return s * (1 + m / 1024) * 2 ** (e - 15)
}

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

/** Reads a model part's vertex `i` (model space). */
export function readVertex(view: DataView, i: number) {
  const o = i * 32
  return {
    p: [view.getFloat32(o, true), view.getFloat32(o + 4, true), view.getFloat32(o + 8, true)] as [number, number, number],
    n: [view.getInt8(o + 12) / 127, view.getInt8(o + 13) / 127, view.getInt8(o + 14) / 127] as [number, number, number],
    uv: [view.getFloat32(o + 24, true), view.getFloat32(o + 28, true)] as [number, number],
  }
}
