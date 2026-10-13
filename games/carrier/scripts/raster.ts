// A small CPU software rasterizer and PNG codec for previewing `Mesh` geometry without a GPU.
// Z-buffered flat-shaded triangles, perspective or orthographic cameras, supersampling, PNG in and out via node:zlib.
import { deflateSync, inflateSync } from "node:zlib"

export type Vec3 = [number, number, number]

// ---------------------------------------------------------------------------------------------------------------------
// Images

/** 8-bit RGBA image. */
export type Image = { w: number; h: number; data: Uint8Array }

export function makeImage(w: number, h: number, rgb: Vec3 = [255, 255, 255]): Image {
  const data = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rgb[0]
    data[i * 4 + 1] = rgb[1]
    data[i * 4 + 2] = rgb[2]
    data[i * 4 + 3] = 255
  }
  return { w, h, data }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, body.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(body, 8)
  dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)))
  return out
}

/** Encodes an RGBA image as an 8-bit RGB PNG (filter 0 rows). */
export function encodePng(img: Image): Uint8Array {
  const { w, h, data } = img
  const raw = new Uint8Array((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    const o = y * (w * 3 + 1)
    raw[o] = 0
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4
      raw[o + 1 + x * 3] = data[s]!
      raw[o + 2 + x * 3] = data[s + 1]!
      raw[o + 3 + x * 3] = data[s + 2]!
    }
  }
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, w)
  dv.setUint32(4, h)
  ihdr[8] = 8
  ihdr[9] = 2
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 6 }))), chunk("IEND", new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Decodes a non-interlaced 8-bit greyscale, RGB or RGBA PNG (all five filter types). */
export function decodePng(file: Uint8Array): Image {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength)
  let p = 8
  let w = 0
  let h = 0
  let colorType = 0
  const idat: Uint8Array[] = []
  while (p < file.length) {
    const len = dv.getUint32(p)
    const type = String.fromCharCode(file[p + 4]!, file[p + 5]!, file[p + 6]!, file[p + 7]!)
    const body = file.subarray(p + 8, p + 8 + len)
    if (type === "IHDR") {
      w = dv.getUint32(p + 8)
      h = dv.getUint32(p + 12)
      if (body[8] !== 8) throw new Error("only 8-bit PNGs are supported")
      colorType = body[9]!
      if (body[12] !== 0) throw new Error("interlaced PNGs are not supported")
    } else if (type === "IDAT") idat.push(body)
    else if (type === "IEND") break
    p += 12 + len
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : 0
  if (!bpp) throw new Error(`unsupported PNG colour type ${colorType}`)
  const joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0))
  let o = 0
  for (const c of idat) {
    joined.set(c, o)
    o += c.length
  }
  const raw = new Uint8Array(inflateSync(joined))
  const stride = w * bpp
  const px = new Uint8Array(stride * h)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!
    const src = y * (stride + 1) + 1
    const dst = y * stride
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp]! : 0
      const b = y > 0 ? px[dst - stride + x]! : 0
      const c = x >= bpp && y > 0 ? px[dst - stride + x - bpp]! : 0
      let v = raw[src + x]!
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) {
        const pp = a + b - c
        const pa = Math.abs(pp - a)
        const pb = Math.abs(pp - b)
        const pc = Math.abs(pp - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      px[dst + x] = v & 255
    }
  }
  const data = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const s = i * bpp
    if (bpp >= 3) {
      data[i * 4] = px[s]!
      data[i * 4 + 1] = px[s + 1]!
      data[i * 4 + 2] = px[s + 2]!
    } else data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = px[s]!
    data[i * 4 + 3] = bpp === 4 ? px[s + 3]! : bpp === 2 ? px[s + 1]! : 255
  }
  return { w, h, data }
}

export async function readPng(path: string): Promise<Image> {
  return decodePng(new Uint8Array(await Bun.file(path).arrayBuffer()))
}

export async function writePng(path: string, img: Image): Promise<void> {
  await Bun.write(path, encodePng(img))
}

/** Area-averaged (box filter) resample of a sub-rectangle into a w x h image. */
export function resample(src: Image, sx: number, sy: number, sw: number, sh: number, w: number, h: number): Image {
  const out = makeImage(w, h)
  for (let y = 0; y < h; y++) {
    const y0 = sy + (y * sh) / h
    const y1 = sy + ((y + 1) * sh) / h
    for (let x = 0; x < w; x++) {
      const x0 = sx + (x * sw) / w
      const x1 = sx + ((x + 1) * sw) / w
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let yy = Math.floor(y0); yy < Math.max(Math.floor(y0) + 1, Math.ceil(y1)); yy++) {
        for (let xx = Math.floor(x0); xx < Math.max(Math.floor(x0) + 1, Math.ceil(x1)); xx++) {
          const cx = Math.min(src.w - 1, Math.max(0, xx))
          const cy = Math.min(src.h - 1, Math.max(0, yy))
          const i = (cy * src.w + cx) * 4
          r += src.data[i]!
          g += src.data[i + 1]!
          b += src.data[i + 2]!
          n++
        }
      }
      const o = (y * w + x) * 4
      out.data[o] = r / n
      out.data[o + 1] = g / n
      out.data[o + 2] = b / n
    }
  }
  return out
}

export function blit(dst: Image, src: Image, dx: number, dy: number): void {
  for (let y = 0; y < src.h; y++) {
    const ty = dy + y
    if (ty < 0 || ty >= dst.h) continue
    for (let x = 0; x < src.w; x++) {
      const tx = dx + x
      if (tx < 0 || tx >= dst.w) continue
      const s = (y * src.w + x) * 4
      const d = (ty * dst.w + tx) * 4
      dst.data[d] = src.data[s]!
      dst.data[d + 1] = src.data[s + 1]!
      dst.data[d + 2] = src.data[s + 2]!
    }
  }
}

export function fillRect(img: Image, x0: number, y0: number, w: number, h: number, rgb: Vec3): void {
  for (let y = Math.max(0, y0); y < Math.min(img.h, y0 + h); y++)
    for (let x = Math.max(0, x0); x < Math.min(img.w, x0 + w); x++) {
      const o = (y * img.w + x) * 4
      img.data[o] = rgb[0]
      img.data[o + 1] = rgb[1]
      img.data[o + 2] = rgb[2]
    }
}

/** Overlays a grid every `step` pixels (for measuring references). */
export function grid(img: Image, step: number, rgb: Vec3 = [255, 0, 255]): void {
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++) {
      if (x % step && y % step) continue
      const o = (y * img.w + x) * 4
      const major = x % (step * 5) === 0 || y % (step * 5) === 0
      const k = major ? 0.75 : 0.35
      img.data[o] = img.data[o]! * (1 - k) + rgb[0] * k
      img.data[o + 1] = img.data[o + 1]! * (1 - k) + rgb[1] * k
      img.data[o + 2] = img.data[o + 2]! * (1 - k) + rgb[2] * k
    }
}

// 3x5 pixel font for labels (digits, upper-case letters, a few symbols).
const FONT: Record<string, string> = {
  "0": "111101101101111", "1": "010110010010111", "2": "111001111100111", "3": "111001111001111", "4": "101101111001001",
  "5": "111100111001111", "6": "111100111101111", "7": "111001010010010", "8": "111101111101111", "9": "111101111001111",
  A: "010101111101101", B: "110101110101110", C: "011100100100011", D: "110101101101110", E: "111100110100111",
  F: "111100110100100", G: "011100101101011", H: "101101111101101", I: "111010010010111", J: "001001001101010",
  K: "101101110101101", L: "100100100100111", M: "101111111101101", N: "110101101101101", O: "010101101101010",
  P: "110101110100100", Q: "010101101110011", R: "110101110101101", S: "011100010001110", T: "111010010010010",
  U: "101101101101111", V: "101101101101010", W: "101101111111101", X: "101101010101101", Y: "101101010010010",
  Z: "111001010100111", "°": "010101010000000", "-": "000000111000000", ".": "000000000000010", " ": "000000000000000",
  "|": "010010010010010", ":": "000010000010000",
}

export function text(img: Image, s: string, x: number, y: number, scale: number, rgb: Vec3): void {
  let cx = x
  for (const ch of s.toUpperCase()) {
    const g = FONT[ch] ?? FONT[" "]!
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) if (g[r * 3 + c] === "1") fillRect(img, cx + c * scale, y + r * scale, scale, scale, rgb)
    cx += 4 * scale
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Cameras

export type Camera = {
  eye: Vec3
  /** Unit basis: right, up, forward (into the screen). */
  right: Vec3
  up: Vec3
  fwd: Vec3
  /** Perspective: vertical field of view in radians. Orthographic: 0. */
  fovY: number
  /** Orthographic: half the visible height in world units. */
  orthoHalf: number
  /** Screen-space shift of the principal point, in NDC units (x, y), for off-centre framing. */
  shift: [number, number]
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

export function lookAt(eye: Vec3, target: Vec3, fovYDeg: number, worldUp: Vec3 = [0, 1, 0]): Camera {
  const fwd = norm(sub(target, eye))
  let right = cross(fwd, worldUp)
  if (Math.hypot(...right) < 1e-6) right = cross(fwd, [0, 0, -1])
  right = norm(right)
  const up = cross(right, fwd)
  return { eye, right, up, fwd, fovY: (fovYDeg * Math.PI) / 180, orthoHalf: 0, shift: [0, 0] }
}

/** Orbit camera: azimuth measured from +Z (bow) toward +X, elevation above the horizon, both in degrees. */
export function orbit(target: Vec3, azimuthDeg: number, elevationDeg: number, dist: number, fovYDeg: number): Camera {
  const a = (azimuthDeg * Math.PI) / 180
  const e = (elevationDeg * Math.PI) / 180
  const eye: Vec3 = [target[0] + Math.sin(a) * Math.cos(e) * dist, target[1] + Math.sin(e) * dist, target[2] + Math.cos(a) * Math.cos(e) * dist]
  return lookAt(eye, target, fovYDeg)
}

export function ortho(dir: Vec3, target: Vec3, halfHeight: number, worldUp: Vec3 = [0, 1, 0]): Camera {
  const d = norm(dir)
  const eye: Vec3 = [target[0] - d[0] * 2000, target[1] - d[1] * 2000, target[2] - d[2] * 2000]
  const c = lookAt(eye, target, 0, worldUp)
  c.orthoHalf = halfHeight
  c.fovY = 0
  return c
}

/** Projects a world point to pixel coordinates in a w x h image (null if behind a perspective camera). */
export function project(cam: Camera, w: number, h: number, p: Vec3): [number, number] | null {
  const d = sub(p, cam.eye)
  const cx = dot(d, cam.right)
  const cy = dot(d, cam.up)
  const cz = dot(d, cam.fwd)
  const persp = cam.fovY > 0
  if (persp && cz < 0.1) return null
  const f = persp ? 1 / Math.tan(cam.fovY / 2) : 1 / cam.orthoHalf
  const ix = persp ? (cx * f) / (cz * (w / h)) : (cx * f) / (w / h)
  const iy = persp ? (cy * f) / cz : cy * f
  return [((ix + cam.shift[0]) * 0.5 + 0.5) * w, (0.5 - (iy + cam.shift[1]) * 0.5) * h]
}

/** Nelder-Mead minimiser (for fitting cameras to reference landmarks). */
export function minimize(f: (x: number[]) => number, x0: number[], step: number[], iters = 4000): number[] {
  const n = x0.length
  let pts = [x0.slice()]
  for (let i = 0; i < n; i++) {
    const p = x0.slice()
    p[i]! += step[i]!
    pts.push(p)
  }
  let vals = pts.map(f)
  for (let it = 0; it < iters; it++) {
    const order = vals.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0])
    pts = order.map(([, i]) => pts[i]!)
    vals = order.map(([v]) => v)
    const c = new Array(n).fill(0)
    for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) c[k] += pts[i]![k]! / n
    const at = (t: number) => c.map((ck, k) => ck + t * (pts[n]![k]! - ck))
    const r = at(-1)
    const fr = f(r)
    if (fr < vals[0]!) {
      const e = at(-2)
      const fe = f(e)
      if (fe < fr) {
        pts[n] = e
        vals[n] = fe
      } else {
        pts[n] = r
        vals[n] = fr
      }
    } else if (fr < vals[n - 1]!) {
      pts[n] = r
      vals[n] = fr
    } else {
      const k = at(0.5)
      const fk = f(k)
      if (fk < vals[n]!) {
        pts[n] = k
        vals[n] = fk
      } else {
        for (let i = 1; i <= n; i++) {
          pts[i] = pts[i]!.map((v, j) => pts[0]![j]! + (v - pts[0]![j]!) * 0.5)
          vals[i] = f(pts[i]!)
        }
      }
    }
  }
  return pts[vals.indexOf(Math.min(...vals))]!
}

// ---------------------------------------------------------------------------------------------------------------------
// Rendering

export type Light = {
  /** Unit vector toward the sun. */
  sun: Vec3
  sunColor: Vec3
  sky: Vec3
  ground: Vec3
  /** Ambient strength. */
  ambient: number
}

export const DEFAULT_LIGHT: Light = {
  sun: norm([0.45, 0.8, 0.55]),
  sunColor: [1.0, 0.97, 0.9],
  sky: [0.62, 0.7, 0.82],
  ground: [0.3, 0.32, 0.36],
  ambient: 0.62,
}

/** Linear HDR framebuffer with a depth buffer. Colours are written in linear space and tone mapped on resolve. */
export class Target {
  readonly color: Float32Array
  readonly depth: Float32Array
  constructor(
    readonly w: number,
    readonly h: number,
    bg: Vec3,
  ) {
    this.color = new Float32Array(w * h * 3)
    this.depth = new Float32Array(w * h).fill(Infinity)
    const lin = bg.map((c) => Math.pow(c / 255, 2.2)) as Vec3
    for (let i = 0; i < w * h; i++) this.color.set(lin, i * 3)
  }

  /** Downsamples by `ss` and converts to sRGB bytes. */
  resolve(ss: number): Image {
    const w = Math.floor(this.w / ss)
    const h = Math.floor(this.h / ss)
    const img = makeImage(w, h)
    const n = ss * ss
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let r = 0
        let g = 0
        let b = 0
        for (let j = 0; j < ss; j++)
          for (let i = 0; i < ss; i++) {
            const s = ((y * ss + j) * this.w + x * ss + i) * 3
            r += this.color[s]!
            g += this.color[s + 1]!
            b += this.color[s + 2]!
          }
        const o = (y * w + x) * 4
        img.data[o] = toSrgb(r / n)
        img.data[o + 1] = toSrgb(g / n)
        img.data[o + 2] = toSrgb(b / n)
      }
    return img
  }
}

const toSrgb = (v: number) => Math.round(255 * Math.pow(Math.min(1, Math.max(0, v)), 1 / 2.2))

/** A rigid transform applied to mesh vertices before projection: yaw about Y, then translate. */
export type Xform = { x: number; y: number; z: number; yaw: number }

/**
 * Draws build-time `Mesh` vertices (11 floats each: position, normal, colour, material, aux) as flat-shaded triangles.
 * Back faces (clockwise on screen) are culled like the game's solid pipeline; with `cull = false` triangles are
 * double-sided and the normal is flipped toward the camera.
 * `clipBelow`: discard fragments whose world y is below this (water plane hides the underwater hull).
 */
export function drawMesh(t: Target, cam: Camera, v: ArrayLike<number>, light: Light = DEFAULT_LIGHT, xf?: Xform, clipBelow = -Infinity, cull = true): void {
  const W = t.w
  const H = t.h
  const aspect = W / H
  const persp = cam.fovY > 0
  const f = persp ? 1 / Math.tan(cam.fovY / 2) : 1 / cam.orthoHalf
  const c = xf ? Math.cos(xf.yaw) : 1
  const s = xf ? Math.sin(xf.yaw) : 0
  const tx = xf?.x ?? 0
  const ty = xf?.y ?? 0
  const tz = xf?.z ?? 0
  const n = v.length / 11
  const sx = new Float64Array(3)
  const sy = new Float64Array(3)
  const sz = new Float64Array(3)
  const wy = new Float64Array(3)
  const lin = (x: number) => Math.pow(x, 2.2)
  for (let k = 0; k + 2 < n; k += 3) {
    let behind = false
    for (let j = 0; j < 3; j++) {
      const o = (k + j) * 11
      const lx = v[o]!
      const lz = v[o + 2]!
      const px = lx * c + lz * s + tx
      const py = v[o + 1]! + ty
      const pz = -lx * s + lz * c + tz
      wy[j] = py
      const d: Vec3 = [px - cam.eye[0], py - cam.eye[1], pz - cam.eye[2]]
      const cx = dot(d, cam.right)
      const cy = dot(d, cam.up)
      const cz = dot(d, cam.fwd)
      if (persp && cz < 0.5) behind = true
      const ix = persp ? (cx * f) / (cz * aspect) : (cx * f) / aspect
      const iy = persp ? (cy * f) / cz : cy * f
      sx[j] = ((ix + cam.shift[0]) * 0.5 + 0.5) * W
      sy[j] = (0.5 - (iy + cam.shift[1]) * 0.5) * H
      sz[j] = cz
    }
    if (behind) continue
    if (Math.max(wy[0]!, wy[1]!, wy[2]!) < clipBelow) continue
    const o = k * 11
    const nlx = v[o + 3]!
    const nlz = v[o + 5]!
    let nrm: Vec3 = [nlx * c + nlz * s, v[o + 4]!, -nlx * s + nlz * c]
    const wp = (j: number): Vec3 => {
      const q = (k + j) * 11
      return [v[q]! * c + v[q + 2]! * s + tx, v[q + 1]! + ty, -v[q]! * s + v[q + 2]! * c + tz]
    }
    const p0 = wp(0)
    const view: Vec3 = persp ? sub(p0, cam.eye) : cam.fwd
    if (cull) {
      // Like the GPU pipeline: counter-clockwise front faces, back faces culled.
      const wn = cross(sub(wp(1), p0), sub(wp(2), p0))
      if (dot(wn, view) >= 0) continue
    } else if (dot(nrm, view) > 0) nrm = [-nrm[0], -nrm[1], -nrm[2]]
    const albedo: Vec3 = [lin(v[o + 6]!), lin(v[o + 7]!), lin(v[o + 8]!)]
    const mat = v[o + 9]!
    let col: Vec3
    if (mat === 1) {
      const g = 1 + v[o + 10]!
      col = [albedo[0] * g, albedo[1] * g, albedo[2] * g]
    } else {
      const ndl = Math.max(0, dot(nrm, light.sun))
      const hk = nrm[1] * 0.5 + 0.5
      col = [0, 1, 2].map((i) => {
        const amb = (light.ground[i]! * (1 - hk) + light.sky[i]! * hk) * light.ambient
        return albedo[i]! * (light.sunColor[i]! * ndl + amb)
      }) as Vec3
    }
    rasterTri(t, sx, sy, sz, persp, col, wy, clipBelow)
  }
}

function rasterTri(t: Target, sx: Float64Array, sy: Float64Array, sz: Float64Array, persp: boolean, col: Vec3, wy: Float64Array, clipBelow: number): void {
  const x0 = sx[0]!, y0 = sy[0]!, x1 = sx[1]!, y1 = sy[1]!, x2 = sx[2]!, y2 = sy[2]!
  const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
  if (Math.abs(area) < 1e-9) return
  const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)))
  const maxX = Math.min(t.w - 1, Math.ceil(Math.max(x0, x1, x2)))
  const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)))
  const maxY = Math.min(t.h - 1, Math.ceil(Math.max(y0, y1, y2)))
  if (minX > maxX || minY > maxY) return
  // Interpolate 1/z (perspective) or z (ortho) for depth, and world y for the water clip.
  const iz0 = persp ? 1 / sz[0]! : sz[0]!
  const iz1 = persp ? 1 / sz[1]! : sz[1]!
  const iz2 = persp ? 1 / sz[2]! : sz[2]!
  const clip = clipBelow > -Infinity && Math.min(wy[0]!, wy[1]!, wy[2]!) < clipBelow
  const inv = 1 / area
  for (let py = minY; py <= maxY; py++) {
    const cy = py + 0.5
    for (let px = minX; px <= maxX; px++) {
      const cx = px + 0.5
      let w0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) * inv
      let w1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) * inv
      let w2 = 1 - w0 - w1
      if (w0 < 0 || w1 < 0 || w2 < 0) continue
      const iz = w0 * iz0 + w1 * iz1 + w2 * iz2
      const depth = persp ? 1 / iz : iz
      const i = py * t.w + px
      if (depth >= t.depth[i]!) continue
      if (clip) {
        let wyy: number
        if (persp) {
          const a = (w0 * iz0) / iz
          const b = (w1 * iz1) / iz
          wyy = a * wy[0]! + b * wy[1]! + (1 - a - b) * wy[2]!
        } else wyy = w0 * wy[0]! + w1 * wy[1]! + w2 * wy[2]!
        if (wyy < clipBelow) continue
      }
      t.depth[i] = depth
      t.color[i * 3] = col[0]
      t.color[i * 3 + 1] = col[1]
      t.color[i * 3 + 2] = col[2]
      void w2
    }
  }
}
