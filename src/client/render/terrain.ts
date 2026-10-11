import { WORLD_H, WORLD_W, type Mask } from "../../sim/terrain"
import { ctx2d, hash2, makeCanvas, noise1, noise2 } from "./util"

// terrain is rasterised at 2x world resolution for a crisp rim line
export const TS = 2
const TW = WORLD_W * TS
const TH = WORLD_H * TS
// chamfer distance cap (hi-res px * 3)
const CAP = 3 * 9
// column depth range used for surface shading and contour lines (world px)
const DMAX = 34
// world padding around a dirty rect: rim reach plus column depth reach below
const PAD = 6

interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export class TerrainLayer {
  readonly canvas: HTMLCanvasElement
  // 1x world-res canvas containing only the rim light, used as bloom source
  readonly rim: HTMLCanvasElement
  // 1x world-res wider edge band, used to mask explosion heat onto rock faces
  readonly rimSoft: HTMLCanvasElement
  private sg: CanvasRenderingContext2D
  private softImg: ImageData
  private g: CanvasRenderingContext2D
  private rg: CanvasRenderingContext2D
  private img: ImageData
  private rimImg: ImageData
  private albedo = new Uint8Array(TW * TH)
  private mask: Mask | null = null
  private seed = -1
  private pending: Rect[] = []
  // scratch buffers sized for the largest region (whole map)
  private occ = new Uint8Array(TW * TH)
  private din = new Uint8Array(TW * TH)
  private dout = new Uint8Array(TW * TH)
  private face = new Float32Array(WORLD_W * WORLD_H)
  private depth = new Uint8Array(WORLD_W * WORLD_H)
  private smf = new Float32Array(WORLD_W * WORLD_H)
  private top = new Int16Array(WORLD_W)

  constructor() {
    this.canvas = makeCanvas(TW, TH)
    this.g = ctx2d(this.canvas)
    this.rim = makeCanvas(WORLD_W, WORLD_H)
    this.rg = ctx2d(this.rim)
    this.img = this.g.createImageData(TW, TH)
    this.rimImg = this.rg.createImageData(WORLD_W, WORLD_H)
    this.rimSoft = makeCanvas(WORLD_W, WORLD_H)
    this.sg = ctx2d(this.rimSoft)
    this.softImg = this.sg.createImageData(WORLD_W, WORLD_H)
    const sd = this.softImg.data
    for (let i = 0; i < sd.length; i += 4) {
      sd[i] = 255
      sd[i + 1] = 255
      sd[i + 2] = 255
    }
  }

  set(mask: Mask, seed: number): void {
    this.mask = mask
    if (seed !== this.seed) {
      this.seed = seed
      buildAlbedo(this.albedo, seed)
    }
    this.pending = []
    this.rebuild({ x0: 0, y0: 0, x1: WORLD_W - 1, y1: WORLD_H - 1 })
  }

  setSeed(seed: number): void {
    if (seed === this.seed || !this.mask) return
    this.seed = seed
    buildAlbedo(this.albedo, seed)
    this.pending = []
    this.rebuild({ x0: 0, y0: 0, x1: WORLD_W - 1, y1: WORLD_H - 1 })
  }

  changed(x0: number, y0: number, x1: number, y1: number): void {
    const r: Rect = {
      x0: Math.max(0, Math.floor(Math.min(x0, x1)) - PAD),
      y0: Math.max(0, Math.floor(Math.min(y0, y1)) - PAD),
      x1: Math.min(WORLD_W - 1, Math.ceil(Math.max(x0, x1)) + PAD),
      y1: Math.min(WORLD_H - 1, Math.ceil(Math.max(y0, y1)) + PAD + DMAX),
    }
    // merge with overlapping pending rects so a burst of carves rebuilds once
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i]!
      if (r.x0 <= p.x1 + 8 && r.x1 >= p.x0 - 8 && r.y0 <= p.y1 + 8 && r.y1 >= p.y0 - 8) {
        p.x0 = Math.min(p.x0, r.x0)
        p.y0 = Math.min(p.y0, r.y0)
        p.x1 = Math.max(p.x1, r.x1)
        p.y1 = Math.max(p.y1, r.y1)
        return
      }
    }
    this.pending.push(r)
  }

  flush(): void {
    if (!this.mask || this.pending.length === 0) return
    const list = this.pending
    this.pending = []
    for (const r of list) this.rebuild(r)
  }

  private rebuild(r: Rect): void {
    const mask = this.mask
    if (!mask) return
    // extended world rect for neighbourhood data
    const ex0 = Math.max(0, r.x0 - 6)
    const ex1 = Math.min(WORLD_W - 1, r.x1 + 6)
    const ey0 = Math.max(0, r.y0 - 6)
    const ey1 = Math.min(WORLD_H - 1, r.y1 + 6)
    const m = (x: number, y: number): number => {
      if (x < 0 || x >= WORLD_W || y < 0) return 0
      if (y >= WORLD_H) return 1
      return mask[y * WORLD_W + x]!
    }

    // column depth below the nearest empty pixel above (world res)
    const depth = this.depth
    for (let x = ex0; x <= ex1; x++) {
      let d = DMAX
      const start = Math.max(0, ey0 - DMAX)
      if (start === 0) d = 0
      for (let y = start; y <= ey1; y++) {
        if (mask[y * WORLD_W + x] === 1) d = d < DMAX ? d + 1 : DMAX
        else d = 0
        if (y >= ey0) depth[y * WORLD_W + x] = d
      }
    }
    // surface facing from a 3x3 sobel (world res): +1 = faces up, -1 = faces down
    const face = this.face
    for (let y = ey0; y <= ey1; y++) {
      for (let x = ex0; x <= ex1; x++) {
        const gy = m(x - 1, y + 1) + 2 * m(x, y + 1) + m(x + 1, y + 1) - m(x - 1, y - 1) - 2 * m(x, y - 1) - m(x + 1, y - 1)
        const gx = m(x + 1, y - 1) + 2 * m(x + 1, y) + m(x + 1, y + 1) - m(x - 1, y - 1) - 2 * m(x - 1, y) - m(x - 1, y + 1)
        const s = Math.abs(gx) + Math.abs(gy)
        face[y * WORLD_W + x] = s === 0 ? 0 : gy / s
      }
    }

    // hi-res occupancy: bilinear-thresholded 3x3-smoothed mask, which rounds the pixel staircase
    const smf = this.smf
    for (let y = ey0 - 1; y <= ey1 + 1; y++) {
      if (y < 0 || y >= WORLD_H) continue
      for (let x = ex0 - 1; x <= ex1 + 1; x++) {
        if (x < 0 || x >= WORLD_W) continue
        smf[y * WORLD_W + x] =
          (4 * m(x, y) + 2 * (m(x - 1, y) + m(x + 1, y) + m(x, y - 1) + m(x, y + 1)) + m(x - 1, y - 1) + m(x + 1, y - 1) + m(x - 1, y + 1) + m(x + 1, y + 1)) / 16
      }
    }
    const sm = (x: number, y: number): number => {
      if (x < 0 || x >= WORLD_W || y < 0) return 0
      if (y >= WORLD_H) return 1
      return smf[y * WORLD_W + x]!
    }
    // first solid row per column: edges below it are cave/tunnel walls and get a dimmer rim
    const top = this.top
    for (let x = ex0; x <= ex1; x++) {
      let y = 0
      while (y < WORLD_H && mask[y * WORLD_W + x] !== 1) y++
      top[x] = y
    }
    const X0 = ex0 * TS
    const X1 = (ex1 + 1) * TS - 1
    const Y0 = ey0 * TS
    const Y1 = (ey1 + 1) * TS - 1
    const occ = this.occ
    for (let Y = Y0; Y <= Y1; Y++) {
      const v = (Y + 0.5) / TS - 0.5
      const iy = Math.floor(v)
      const fy = v - iy
      for (let X = X0; X <= X1; X++) {
        const u = (X + 0.5) / TS - 0.5
        const ix = Math.floor(u)
        const fx = u - ix
        const a = sm(ix, iy)
        const b = sm(ix + 1, iy)
        const c = sm(ix, iy + 1)
        const d = sm(ix + 1, iy + 1)
        const f = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
        occ[Y * TW + X] = f >= 0.5 ? 1 : 0
      }
    }

    // chamfer distance transforms (3/4 metric), inside and outside, capped
    const din = this.din
    const dout = this.dout
    for (let Y = Y0; Y <= Y1; Y++) {
      for (let X = X0; X <= X1; X++) {
        const i = Y * TW + X
        const s = occ[i]
        din[i] = s ? CAP : 0
        dout[i] = s ? 0 : CAP
      }
    }
    const pass = (dist: Uint8Array) => {
      for (let Y = Y0; Y <= Y1; Y++) {
        for (let X = X0; X <= X1; X++) {
          const i = Y * TW + X
          let v = dist[i]!
          if (v === 0) continue
          if (X > X0) v = Math.min(v, dist[i - 1]! + 3)
          if (Y > Y0) {
            v = Math.min(v, dist[i - TW]! + 3)
            if (X > X0) v = Math.min(v, dist[i - TW - 1]! + 4)
            if (X < X1) v = Math.min(v, dist[i - TW + 1]! + 4)
          }
          dist[i] = v
        }
      }
      for (let Y = Y1; Y >= Y0; Y--) {
        for (let X = X1; X >= X0; X--) {
          const i = Y * TW + X
          let v = dist[i]!
          if (v === 0) continue
          if (X < X1) v = Math.min(v, dist[i + 1]! + 3)
          if (Y < Y1) {
            v = Math.min(v, dist[i + TW]! + 3)
            if (X < X1) v = Math.min(v, dist[i + TW + 1]! + 4)
            if (X > X0) v = Math.min(v, dist[i + TW - 1]! + 4)
          }
          dist[i] = v
        }
      }
    }
    pass(din)
    pass(dout)

    // shade the output rect
    const data = this.img.data
    const rim = this.rimImg.data
    const soft = this.softImg.data
    const alb = this.albedo
    const OX0 = r.x0 * TS
    const OX1 = (r.x1 + 1) * TS - 1
    const OY0 = r.y0 * TS
    const OY1 = (r.y1 + 1) * TS - 1
    for (let Y = OY0; Y <= OY1; Y++) {
      const wy = (Y / TS) | 0
      // deep rock darkens and cools toward the bottom
      const deep = Math.min(1, Math.max(0, (wy - 330) / 300))
      const dk = 1 - deep * 0.38
      for (let X = OX0; X <= OX1; X++) {
        const i = Y * TW + X
        const o = i * 4
        const wx = (X / TS) | 0
        const wi = wy * WORLD_W + wx
        const fu = face[wi]!
        const cave = wy > top[wx]! + 2
        const lightBase = fu >= 0 ? 0.55 + 0.45 * fu : 0.55 + 0.25 * fu
        const light = cave ? lightBase * (0.62 - deep * 0.25) : lightBase
        if (occ[i]) {
          const L = alb[i]!
          const dc = depth[wi]!
          // faint moonlit lift right under the surface
          const lift = dc < DMAX ? (1 - dc / DMAX) * (fu > 0.3 ? 12 : 6) : 0
          let cr = (L * 0.14 + lift * 0.45) * dk
          let cg = (L * 0.21 + lift * 0.85) * dk
          let cb = (L * 0.26 + lift * 1.1) * dk + deep * 3
          const d = din[i]! / 3
          let rv = 0
          if (d <= 1.01) rv = 1
          else if (d <= 2.01) rv = 0.45
          else if (d <= 3.01) rv = 0.16
          else if (d <= 5.01) rv = 0.05
          rv *= light
          if (rv > 0) {
            // ice-white core grading to cyan
            const hot = rv > 0.55
            const tr = hot ? (fu > 0.5 ? 200 : 150) : 30
            const tg = hot ? (fu > 0.5 ? 245 : 228) : 150
            const tb = hot ? 255 : 220
            const k = Math.min(1, rv)
            cr += (tr - cr) * k
            cg += (tg - cg) * k
            cb += (tb - cb) * k
          }
          data[o] = cr
          data[o + 1] = cg
          data[o + 2] = cb
          data[o + 3] = 255
          if ((X & 1) === 0 && (Y & 1) === 0) {
            const ro = wi * 4
            rim[ro] = 90
            rim[ro + 1] = 215
            rim[ro + 2] = 255
            rim[ro + 3] = d <= 2.01 ? Math.round(255 * light * light) : 0
            soft[ro + 3] = d < 10 ? Math.round(255 * (1 - d / 10) ** 1.5) : 0
          }
        } else {
          const d = dout[i]! / 3
          const t = d >= 7 ? 0 : 1 - d / 7
          const h = t * t * (cave ? 0.3 : 0.42) * light * light
          // enclosed hollows show a dim recessed back wall instead of the sky
          const below = wy - top[wx]!
          const bw = below > 0 ? Math.min(1, below / 26) * 0.92 : 0
          if (bw > 0) {
            const L = alb[i]! * 0.13
            const br = L * 0.6 + 3
            const bgc = L * 0.8 + 6
            const bb = L + 12
            const a = h + bw * (1 - h)
            data[o] = (70 * h + br * bw * (1 - h)) / a
            data[o + 1] = (200 * h + bgc * bw * (1 - h)) / a
            data[o + 2] = (255 * h + bb * bw * (1 - h)) / a
            data[o + 3] = Math.round(a * 255)
          } else {
            data[o] = 70
            data[o + 1] = 200
            data[o + 2] = 255
            data[o + 3] = Math.round(h * 255)
          }
          if ((X & 1) === 0 && (Y & 1) === 0) {
            rim[wi * 4 + 3] = 0
            soft[wi * 4 + 3] = d < 3 ? Math.round(110 * (1 - d / 3)) : 0
          }
        }
      }
    }
    const w = OX1 - OX0 + 1
    const h = OY1 - OY0 + 1
    this.g.putImageData(this.img, 0, 0, OX0, OY0, w, h)
    this.rg.putImageData(this.rimImg, 0, 0, r.x0, r.y0, r.x1 - r.x0 + 1, r.y1 - r.y0 + 1)
    this.sg.putImageData(this.softImg, 0, 0, r.x0, r.y0, r.x1 - r.x0 + 1, r.y1 - r.y0 + 1)
  }
}

function buildAlbedo(out: Uint8Array, seed: number): void {
  const n1 = noise1(seed ^ 0x1234)
  const n1b = noise1(seed ^ 0x5678)
  const n1c = noise1(seed ^ 0x9abc)
  const n2 = noise2(seed ^ 0x2468)
  const n2b = noise2(seed ^ 0x1357)
  const period = 22 + (seed % 7)
  for (let Y = 0; Y < TH; Y++) {
    const wy = Y / TS
    for (let X = 0; X < TW; X++) {
      const wx = X / TS
      const s = wy + 9 * n1(wx / 80) + 3.6 * n1b(wx / 21) + 1.3 * n1c(wx / 5)
      const band = s / period
      const k = Math.floor(band)
      const fr = band - k
      // each stratum: a lit ledge line on top, a shadow below it, then a slow brightening toward the next ledge
      let L = 74 + (hash2(k, 7, seed) - 0.5) * 14 + fr * 12
      const broken = n2(wx / 15, k * 3.1) < 0.2
      const lw = 0.035 + n2(wx / 7, k * 5.3) * 0.035
      if (fr < lw) L += broken ? 4 : 30 + n2(wx / 40, k) * 40
      else if (fr < lw + 0.12) L -= 26 * (1 - (fr - lw) / 0.12)
      else if (fr > 0.94) L += 8
      L += (hash2(X, Y, seed) - 0.5) * 12
      L += (n2b(wx / 3.2, wy / 3.2) - 0.5) * 24
      L += (n2b(wx / 16 + 40, wy / 10) - 0.5) * 20
      // big lumpy boulder shading
      const bl = n2(wx / 26 + 100, wy / 18)
      L += (bl - 0.5) * 26
      // sparse short fracture marks
      if (n2(wx / 1.6, wy / 9) > 0.9) L -= 14
      out[Y * TW + X] = L < 0 ? 0 : L > 255 ? 255 : L
    }
  }
}

// restyle a falling chunk canvas (any opaque pixel = rock) into terrain look at 2x
export function styleChunk(src: HTMLCanvasElement, seed: number): HTMLCanvasElement {
  const w = src.width
  const h = src.height
  const sd = ctx2d(src).getImageData(0, 0, w, h).data
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && sd[(y * w + x) * 4 + 3]! > 64
  const out = makeCanvas(w * TS, h * TS)
  const g = ctx2d(out)
  const img = g.createImageData(w * TS, h * TS)
  const d = img.data
  for (let Y = 0; Y < h * TS; Y++) {
    for (let X = 0; X < w * TS; X++) {
      const x = (X / TS) | 0
      const y = (Y / TS) | 0
      if (!solid(x, y)) continue
      const o = (Y * w * TS + X) * 4
      const edge = !solid(x - 1, y) || !solid(x + 1, y) || !solid(x, y - 1) || !solid(x, y + 1)
      const L = 50 + (hash2(X, Y, seed) - 0.5) * 14 + ((y + (seed & 7)) % 15 < 1 ? 22 : 0)
      if (edge) {
        d[o] = 150
        d[o + 1] = 228
        d[o + 2] = 255
      } else {
        d[o] = L * 0.25
        d[o + 1] = L * 0.28
        d[o + 2] = L * 0.34
      }
      d[o + 3] = 255
    }
  }
  g.putImageData(img, 0, 0)
  return out
}
