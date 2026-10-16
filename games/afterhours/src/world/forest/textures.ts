import * as THREE from "three/webgpu"
import { rng, range, type Rng } from "./rng"

// Procedural alpha-cutout textures painted on a 2D canvas at startup: conifer branch sprays for the tree cards,
// undergrowth (fern fronds, grass, salal) and the far-tree impostor atlas. Mip levels are built here with colour
// bleeding into transparent texels and alpha scaled per level to keep the same coverage at the cutout threshold,
// so foliage does not thin out or darken with distance.

export const CELL = 512
/** Cells in the foliage atlas (2 x 2). */
export const FOLIAGE = { fir: 0, pine: 1, dead: 2, young: 3 } as const
/** Cells in the undergrowth atlas (2 x 2). */
export const UNDER = { fern: 0, grass: 1, salal: 2, twigs: 3 } as const

/** UV rectangle [u0, v0, u1, v1] of a cell in a 2 x 2 atlas (v up, three.js convention). */
export function cellRect(cell: number): [number, number, number, number] {
  const cx = cell % 2
  const cy = Math.floor(cell / 2)
  // Canvas row 0 is the top of the image; with flipY off, v = 0 is the first row.
  return [cx * 0.5, cy * 0.5, cx * 0.5 + 0.5, cy * 0.5 + 0.5]
}

function canvas(w: number, h: number) {
  const c = document.createElement("canvas")
  c.width = w
  c.height = h
  const g = c.getContext("2d", { willReadFrequently: true })!
  return { c, g }
}

type G = CanvasRenderingContext2D

function needleColor(r: Rng, hue = 105, light = 0) {
  const h = hue + range(r, -12, 12)
  const s = range(r, 18, 36)
  const l = range(r, 15, 27) + light * 0.6
  return `hsl(${h.toFixed(0)} ${s.toFixed(0)}% ${l.toFixed(0)}%)`
}

function stroke(g: G, x0: number, y0: number, x1: number, y1: number, w: number, color: string) {
  g.strokeStyle = color
  g.lineWidth = w
  g.beginPath()
  g.moveTo(x0, y0)
  g.lineTo(x1, y1)
  g.stroke()
}

/** Douglas-fir style spray: a limb with pinnate branchlets densely clothed in short flat needles. */
function firSpray(g: G, r: Rng, ox: number, oy: number, dense: number, widthScale: number) {
  g.lineCap = "round"
  const L = CELL - 16
  const ax = (t: number) => ox + 8 + t * L
  const ay = (t: number) => oy + CELL / 2 + Math.sin(t * 5.1 + 1.3) * 4
  const half = (t: number) => 205 * widthScale * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.05 + 0.04)), 0.75) * (1 - 0.3 * t)
  for (let t = 0; t < 1; t += 0.01) stroke(g, ax(t), ay(t), ax(t + 0.01), ay(t + 0.01), 5 - t * 3.5, "#3a2e22")
  for (const side of [-1, 1]) {
    for (let t = 0.05 + r() * 0.02; t < 0.97; t += (0.03 + r() * 0.012) / dense) {
      if (r() < 0.1) continue
      const len = half(t) * (r() < 0.25 ? range(r, 0.45, 0.7) : range(r, 0.78, 1.02))
      const ang = side * range(r, 0.75, 1.05)
      const bx = ax(t)
      const by = ay(t)
      const dx = Math.cos(ang)
      const dy = Math.sin(ang)
      const ex = bx + dx * len
      const ey = by + dy * len
      stroke(g, bx, by, ex, ey, 2, "#3d3422")
      branchletNeedles(g, r, bx, by, dx, dy, len, 0, dense)
      if (len > 70 && r() < 0.75) {
        const s = range(r, 0.3, 0.6)
        const sx = bx + dx * len * s
        const sy = by + dy * len * s
        const sa = ang + side * range(r, 0.5, 0.8) * (r() < 0.5 ? 1 : -1)
        const sl = len * range(r, 0.25, 0.4)
        branchletNeedles(g, r, sx, sy, Math.cos(sa), Math.sin(sa), sl, 0, dense)
      }
    }
  }
  // Tip shoot.
  branchletNeedles(g, r, ax(0.94), ay(0.94), 1, 0, L * 0.08, 6, dense)
}

function branchletNeedles(g: G, r: Rng, x: number, y: number, dx: number, dy: number, len: number, light: number, dense: number) {
  const step = 4.2 / dense
  for (let s = 0; s < len; s += step + r() * 2) {
    const px = x + dx * s
    const py = y + dy * s
    const tipBoost = s > len * 0.8 ? 6 : 0
    for (const side of [-1, 1]) {
      const a = Math.atan2(dy, dx) + side * range(r, 0.9, 1.3)
      const nl = range(r, 9, 14) * (1 - 0.35 * (s / len))
      stroke(g, px, py, px + Math.cos(a) * nl, py + Math.sin(a) * nl, 2.3, needleColor(r, 105, light + tipBoost))
    }
  }
}

/** Lodgepole pine limb: a few forward twigs ending in bottlebrush tufts of long paired needles. */
function pineBranch(g: G, r: Rng, ox: number, oy: number) {
  g.lineCap = "round"
  const L = CELL - 20
  const ax = (t: number) => ox + 10 + t * L
  const ay = (t: number) => oy + CELL / 2 + Math.sin(t * 3.7) * 10
  for (let t = 0; t < 1; t += 0.01) stroke(g, ax(t), ay(t), ax(t + 0.01), ay(t + 0.01), 6 - t * 4, "#43362a")
  const tuft = (x: number, y: number, dx: number, dy: number, len: number) => {
    const base = Math.atan2(dy, dx)
    for (let s = len * 0.35; s < len; s += 3) {
      const px = x + dx * s
      const py = y + dy * s
      for (let k = 0; k < 4; k++) {
        const a = base + range(r, -1.25, 1.25)
        const nl = range(r, 26, 44) * (0.6 + 0.4 * (s / len))
        stroke(g, px, py, px + Math.cos(a) * nl, py + Math.sin(a) * nl, 2, needleColor(r, 95, 4))
      }
    }
  }
  for (let t = 0.25; t < 0.92; t += range(r, 0.09, 0.15)) {
    const side = r() < 0.5 ? -1 : 1
    const a = side * range(r, 0.5, 0.9)
    const len = range(r, 70, 140) * (1.1 - t * 0.5)
    const bx = ax(t)
    const by = ay(t)
    const dx = Math.cos(a)
    const dy = Math.sin(a)
    stroke(g, bx, by, bx + dx * len, by + dy * len, 3, "#45392b")
    tuft(bx, by, dx, dy, len)
  }
  tuft(ax(0.7), ay(0.7), 1, 0, L * 0.32)
}

/** Dead lower limb: grey bare twigs with a few clinging rusty needles. */
function deadTwigs(g: G, r: Rng, ox: number, oy: number) {
  g.lineCap = "round"
  const twig = (x: number, y: number, a: number, len: number, w: number, depth: number) => {
    let px = x
    let py = y
    const n = Math.max(2, Math.round(len / 14))
    for (let i = 0; i < n; i++) {
      a += range(r, -0.18, 0.18)
      const nx = px + (Math.cos(a) * len) / n
      const ny = py + (Math.sin(a) * len) / n
      stroke(g, px, py, nx, ny, w * (1 - (i / n) * 0.6), `hsl(30 ${range(r, 6, 14).toFixed(0)}% ${range(r, 22, 34).toFixed(0)}%)`)
      if (depth > 0 && r() < 0.32) twig(nx, ny, a + (r() < 0.5 ? 1 : -1) * range(r, 0.5, 1.1), len * range(r, 0.25, 0.45), w * 0.6, depth - 1)
      if (r() < 0.08) stroke(g, nx, ny, nx + range(r, -8, 8), ny + range(r, -8, 8), 2, `hsl(28 40% ${range(r, 22, 32).toFixed(0)}%)`)
      px = nx
      py = ny
    }
  }
  twig(ox + 8, oy + CELL / 2, 0, CELL - 30, 6, 3)
}

/** Sword-fern frond, base at u = 0, tip at u = 1. */
function fernFrond(g: G, r: Rng, ox: number, oy: number) {
  g.lineCap = "round"
  const L = CELL - 24
  const ax = (t: number) => ox + 10 + t * L
  const ay = (t: number) => oy + CELL / 2 + Math.sin(t * 2.4) * 8
  for (let t = 0; t < 1; t += 0.01) stroke(g, ax(t), ay(t), ax(t + 0.01), ay(t + 0.01), 3.5 - t * 2.5, "#2e3a1e")
  for (let t = 0.1; t < 0.98; t += 0.024) {
    const len = 95 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.95 + 0.06)), 0.6) * (1.05 - t * 0.55)
    for (const side of [-1, 1]) {
      const a = side * range(r, 1.0, 1.25)
      const x = ax(t)
      const y = ay(t)
      // Pinna: a slim leaf shape.
      g.fillStyle = `hsl(${range(r, 88, 108).toFixed(0)} ${range(r, 30, 45).toFixed(0)}% ${range(r, 24, 36).toFixed(0)}%)`
      g.beginPath()
      g.moveTo(x, y)
      const mx = x + Math.cos(a) * len * 0.5
      const my = y + Math.sin(a) * len * 0.5
      const ex = x + Math.cos(a + side * 0.12) * len
      const ey = y + Math.sin(a + side * 0.12) * len
      const nx = -Math.sin(a) * 7
      const ny = Math.cos(a) * 7
      g.quadraticCurveTo(mx + nx, my + ny, ex, ey)
      g.quadraticCurveTo(mx - nx, my - ny, x, y)
      g.fill()
    }
  }
}

/** Clump of grass blades, roots at v = 0 (bottom), tips up. */
function grassTuft(g: G, r: Rng, ox: number, oy: number) {
  g.lineCap = "round"
  for (let i = 0; i < 90; i++) {
    const bx = ox + CELL / 2 + range(r, -150, 150)
    const by = oy + CELL - 4
    const h = range(r, 200, 470)
    const lean = range(r, -0.45, 0.45) + (bx - ox - CELL / 2) / 400
    const bend = range(r, -0.3, 0.3)
    const dry = r() < 0.55
    const col = dry
      ? `hsl(${range(r, 38, 52).toFixed(0)} ${range(r, 22, 38).toFixed(0)}% ${range(r, 30, 46).toFixed(0)}%)`
      : `hsl(${range(r, 70, 95).toFixed(0)} ${range(r, 22, 36).toFixed(0)}% ${range(r, 24, 36).toFixed(0)}%)`
    let px = bx
    let py = by
    const n = 10
    for (let k = 0; k < n; k++) {
      const t = (k + 1) / n
      const a = -Math.PI / 2 + lean * t + bend * t * t
      const nx = px + (Math.cos(a) * h) / n
      const ny = py + (Math.sin(a) * h) / n
      stroke(g, px, py, nx, ny, 5 * (1 - t * 0.8), col)
      px = nx
      py = ny
    }
  }
}

/** Salal / huckleberry sprig: woody stem with broad oval leaves. */
function salal(g: G, r: Rng, ox: number, oy: number) {
  g.lineCap = "round"
  const stem = (x: number, y: number, a: number, len: number, depth: number) => {
    const ex = x + Math.cos(a) * len
    const ey = y + Math.sin(a) * len
    stroke(g, x, y, ex, ey, 3, "#3a2e22")
    for (let s = 0.25; s < 1.0; s += range(r, 0.12, 0.2)) {
      const px = x + (ex - x) * s
      const py = y + (ey - y) * s
      const la = a + (r() < 0.5 ? 1 : -1) * range(r, 0.6, 1.2)
      const ll = range(r, 40, 62)
      g.save()
      g.translate(px + Math.cos(la) * ll * 0.5, py + Math.sin(la) * ll * 0.5)
      g.rotate(la)
      g.fillStyle = `hsl(${range(r, 85, 110).toFixed(0)} ${range(r, 25, 40).toFixed(0)}% ${range(r, 20, 32).toFixed(0)}%)`
      g.beginPath()
      g.ellipse(0, 0, ll * 0.5, ll * 0.3, 0, 0, Math.PI * 2)
      g.fill()
      g.restore()
    }
    if (depth > 0) stem(ex, ey, a + range(r, -0.6, 0.6), len * 0.7, depth - 1)
  }
  for (let i = 0; i < 5; i++) stem(ox + CELL / 2 + range(r, -60, 60), oy + CELL - 6, -Math.PI / 2 + range(r, -0.8, 0.8), range(r, 160, 240), 1)
}

// ---------------------------------------------------------------------------------------------------------------

/** Builds a DataTexture with a coverage-preserving, colour-bled mip chain from canvas pixels. */
export function alphaTexture(src: HTMLCanvasElement, threshold = 0.5) {
  const w = src.width
  const h = src.height
  const base = src.getContext("2d")!.getImageData(0, 0, w, h).data
  const levels: { data: Uint8Array; width: number; height: number }[] = []
  // Level 0 with colour bled into transparent texels (from a heavily blurred colour estimate).
  let cur = new Float32Array(w * h * 4)
  for (let i = 0; i < w * h * 4; i++) cur[i] = base[i]! / 255
  bleed(cur, w, h)
  let coverage = 0
  for (let i = 0; i < w * h; i++) if (cur[i * 4 + 3]! > threshold) coverage++
  coverage /= w * h
  levels.push({ data: toBytes(cur), width: w, height: h })
  let cw = w
  let ch = h
  while (cw > 1 || ch > 1) {
    const nw = Math.max(1, cw >> 1)
    const nh = Math.max(1, ch >> 1)
    const next = new Float32Array(nw * nh * 4)
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let r = 0
        let g = 0
        let b = 0
        let a = 0
        for (let k = 0; k < 4; k++) {
          const sx = Math.min(cw - 1, x * 2 + (k & 1))
          const sy = Math.min(ch - 1, y * 2 + (k >> 1))
          const o = (sy * cw + sx) * 4
          r += cur[o]!
          g += cur[o + 1]!
          b += cur[o + 2]!
          a += cur[o + 3]!
        }
        const o = (y * nw + x) * 4
        next[o] = r / 4
        next[o + 1] = g / 4
        next[o + 2] = b / 4
        next[o + 3] = a / 4
      }
    }
    // Scale alpha so the fraction above the threshold matches level 0.
    let lo = 0.5
    let hi = 8
    for (let it = 0; it < 12; it++) {
      const s = (lo + hi) / 2
      let c = 0
      for (let i = 0; i < nw * nh; i++) if (next[i * 4 + 3]! * s > threshold) c++
      if (c / (nw * nh) < coverage) lo = s
      else hi = s
    }
    const scaled = new Float32Array(next)
    for (let i = 0; i < nw * nh; i++) scaled[i * 4 + 3] = Math.min(1, next[i * 4 + 3]! * hi)
    levels.push({ data: toBytes(scaled), width: nw, height: nh })
    cur = next
    cw = nw
    ch = nh
  }
  const tex = new THREE.DataTexture(levels[0]!.data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.mipmaps = levels as unknown as THREE.DataTexture["mipmaps"]
  tex.generateMipmaps = false
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.anisotropy = 4
  tex.colorSpace = THREE.SRGBColorSpace
  tex.flipY = false
  tex.needsUpdate = true
  return tex
}

function toBytes(f: Float32Array) {
  const out = new Uint8Array(f.length)
  for (let i = 0; i < f.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(f[i]! * 255)))
  return out
}

/** Replaces the colour of transparent texels with the alpha-weighted colour of nearby opaque ones. */
function bleed(px: Float32Array, w: number, h: number) {
  const S = 16
  const gw = Math.ceil(w / S)
  const gh = Math.ceil(h / S)
  const acc = new Float32Array(gw * gh * 4)
  let tr = 0
  let tg = 0
  let tb = 0
  let ta = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const a = px[o + 3]!
      if (a <= 0) continue
      const c = (Math.floor(y / S) * gw + Math.floor(x / S)) * 4
      acc[c] += px[o]! * a
      acc[c + 1] += px[o + 1]! * a
      acc[c + 2] += px[o + 2]! * a
      acc[c + 3] += a
      tr += px[o]! * a
      tg += px[o + 1]! * a
      tb += px[o + 2]! * a
      ta += a
    }
  }
  const avg = [tr / (ta || 1), tg / (ta || 1), tb / (ta || 1)]
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const a = px[o + 3]!
      if (a >= 0.99) continue
      const c = (Math.floor(y / S) * gw + Math.floor(x / S)) * 4
      const ca = acc[c + 3]!
      const k = Math.min(1, ca / 20)
      for (let ch = 0; ch < 3; ch++) {
        const fill = ca > 0 ? acc[c + ch]! / ca : avg[ch]!
        const bled = fill * k + avg[ch]! * (1 - k)
        px[o + ch] = px[o + ch]! * a + bled * (1 - a)
      }
    }
  }
}

/** Un-premultiplies canvas pixels is unnecessary: getImageData already returns straight alpha. */
export function foliageAtlas() {
  const { c, g } = canvas(CELL * 2, CELL * 2)
  const at = (cell: number): [number, number] => [(cell % 2) * CELL, Math.floor(cell / 2) * CELL]
  firSpray(g, rng(11), ...at(FOLIAGE.fir), 1, 1)
  pineBranch(g, rng(12), ...at(FOLIAGE.pine))
  deadTwigs(g, rng(13), ...at(FOLIAGE.dead))
  firSpray(g, rng(14), ...at(FOLIAGE.young), 1.25, 1.0)
  return { canvas: c, texture: alphaTexture(c) }
}

export function undergrowthAtlas() {
  const { c, g } = canvas(CELL * 2, CELL * 2)
  const at = (cell: number): [number, number] => [(cell % 2) * CELL, Math.floor(cell / 2) * CELL]
  fernFrond(g, rng(21), ...at(UNDER.fern))
  grassTuft(g, rng(22), ...at(UNDER.grass))
  salal(g, rng(23), ...at(UNDER.salal))
  deadTwigs(g, rng(24), ...at(UNDER.twigs))
  return { canvas: c, texture: alphaTexture(c) }
}
