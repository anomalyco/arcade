import { terrainHeight, type WoodsWorld } from "../../shared/world"
import { rng, scaleOf, SHEET, worldToSheet } from "./sheet"

/**
 * The printed sheet, drawn as vector graphics from the shared world so it matches the forest: hillshade, two woodland
 * tints from the real tree positions with a dotted vegetation boundary, contours by marching squares over
 * `terrainHeight` (1 ft interval, every fifth an index contour with its height), intermittent streams traced down the
 * terrain's own drainage, marsh where the shore is flat, the lake, the old path, boulders from the real rocks, camp
 * buildings, the radio mast, spot heights, red section lines with their numbers, grid ticks and a USGS-style collar
 * with title block and marginalia. Generated images only add the paper itself (`public/map/paper-wear.jpg`). Creases
 * wear the ink and the edges are torn in the alpha channel.
 *
 * Runs in a worker on an OffscreenCanvas (`print.worker.ts`). Palette after the USGS 7.5′ quadrangle.
 */

export type PrintImages = { wear?: CanvasImageSource | null }
type Ctx = OffscreenCanvasRenderingContext2D

const BROWN = "#a0602b"
const BROWN_INDEX = "#7a4216"
const BLUE = "#1f6fae"
const WATER = "#b9dcef"
const GREEN = "#c9e0b1"
const SCRUB = "#5f9a4c"
const BLACK = "#1d1b19"
const RED = "#c8322b"
const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif"
const SERIF = "Georgia, 'Times New Roman', serif"
const FT = 0.3048

type Pt = [number, number]

/** Contour lines at `level` over an (n+1)² height grid spanning the map square, chained into polylines (sheet mm). */
export function contourLines(hs: Float32Array, n: number, level: number, at: (i: number, j: number) => Pt): Pt[][] {
  const H = (i: number, j: number) => hs[j * (n + 1) + i]!
  // Edge ids: horizontal edge (i, j)→(i+1, j) is 2·(j·(n+1)+i), vertical (i, j)→(i, j+1) is that + 1.
  const point = new Map<number, Pt>()
  const edgePoint = (id: number): Pt => {
    let p = point.get(id)
    if (p) return p
    const k = id >> 1, i = k % (n + 1), j = (k / (n + 1)) | 0
    const [i2, j2] = id & 1 ? [i, j + 1] : [i + 1, j]
    const a = H(i, j), b = H(i2, j2), t = (level - a) / (b - a)
    const pa = at(i, j), pb = at(i2, j2)
    p = [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t]
    point.set(id, p)
    return p
  }
  const segA: number[] = [], segB: number[] = []
  const bySeg = new Map<number, number[]>()
  const link = (a: number, b: number) => {
    const id = segA.length
    segA.push(a); segB.push(b)
    let l = bySeg.get(a); if (!l) bySeg.set(a, (l = [])); l.push(id)
    let m = bySeg.get(b); if (!m) bySeg.set(b, (m = [])); m.push(id)
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const c0 = H(i, j), c1 = H(i + 1, j), c2 = H(i + 1, j + 1), c3 = H(i, j + 1)
    const b0 = c0 < level, b1 = c1 < level, b2 = c2 < level, b3 = c3 < level
    if (b0 === b1 && b1 === b2 && b2 === b3) continue
    const e0 = 2 * (j * (n + 1) + i), e1 = 2 * (j * (n + 1) + i + 1) + 1, e2 = 2 * ((j + 1) * (n + 1) + i), e3 = e0 + 1
    const hit: number[] = []
    if (b0 !== b1) hit.push(e0)
    if (b1 !== b2) hit.push(e1)
    if (b3 !== b2) hit.push(e2)
    if (b0 !== b3) hit.push(e3)
    if (hit.length === 2) link(hit[0]!, hit[1]!)
    else if (hit.length === 4) {
      const mid = (c0 + c1 + c2 + c3) / 4
      if ((mid < level) === b0) { link(e0, e1); link(e2, e3) } else { link(e0, e3); link(e1, e2) }
    }
  }
  const lines: Pt[][] = []
  const used = new Uint8Array(segA.length)
  const walk = (seg: number, from: number) => {
    const ids = [from]
    let cur = from, s = seg
    while (s >= 0 && !used[s]) {
      used[s] = 1
      cur = segA[s] === cur ? segB[s]! : segA[s]!
      ids.push(cur)
      const next = (bySeg.get(cur) ?? []).find((x) => !used[x])
      s = next === undefined ? -1 : next
    }
    if (ids.length > 1) lines.push(ids.map(edgePoint))
  }
  for (const [edge, l] of bySeg) if (l.length === 1 && !used[l[0]!]) walk(l[0]!, edge)
  for (let k = 0; k < segA.length; k++) if (!used[k]) walk(k, segA[k]!)
  return lines
}

/** Chaikin smoothing, keeping open ends. */
function smooth(line: Pt[], passes = 2): Pt[] {
  let p = line
  const closed = p.length > 2 && p[0]![0] === p[p.length - 1]![0] && p[0]![1] === p[p.length - 1]![1]
  for (let k = 0; k < passes; k++) {
    const out: Pt[] = closed ? [] : [p[0]!]
    for (let i = 0; i + 1 < p.length; i++) {
      const a = p[i]!, b = p[i + 1]!
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75])
    }
    if (closed) out.push(out[0]!)
    else out.push(p[p.length - 1]!)
    p = out
  }
  return p
}

function trace(g: Ctx, line: Pt[]) {
  g.moveTo(line[0]![0], line[0]![1])
  for (let i = 1; i < line.length; i++) g.lineTo(line[i]![0], line[i]![1])
}

const lengthOf = (l: Pt[]) => { let s = 0; for (let i = 1; i < l.length; i++) s += Math.hypot(l[i]![0] - l[i - 1]![0], l[i]![1] - l[i - 1]![1]); return s }

/** A polyline with gaps cut at `cuts` (mm along it, ±gap/2); returns where each cut lands and the line's angle there. */
function strokeWithGaps(g: Ctx, l: Pt[], cuts: number[], gap: number): { x: number; y: number; a: number }[] {
  const out: { x: number; y: number; a: number }[] = []
  let acc = 0, ci = 0, drawing = true
  g.beginPath(); g.moveTo(l[0]![0], l[0]![1])
  for (let i = 1; i < l.length; i++) {
    const a = l[i - 1]!, b = l[i]!, d = Math.hypot(b[0] - a[0], b[1] - a[1])
    const cut = cuts[ci]
    if (cut !== undefined && drawing && acc + d >= cut - gap / 2) {
      g.lineTo(b[0], b[1]); g.stroke(); drawing = false
      let ang = Math.atan2(b[1] - a[1], b[0] - a[0])
      if (ang > Math.PI / 2) ang -= Math.PI
      if (ang < -Math.PI / 2) ang += Math.PI
      out.push({ x: b[0], y: b[1], a: ang })
    } else if (!drawing && cut !== undefined && acc >= cut + gap / 2) {
      drawing = true; ci++; g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1])
    } else if (drawing) g.lineTo(b[0], b[1])
    acc += d
  }
  if (drawing) g.stroke()
  return out
}

export type PrintResult = { canvas: OffscreenCanvas; ms: number; phases: Record<string, number> }

/** Elevation in feet for terrain metres (the lake sits at 1 240 ft). */
export const feetOf = (world: WoodsWorld, h: number) => 1240 + (h - world.lake.level) / FT

/** Draws the sheet at `longSide` px on its long (400 mm) side. */
export function printSheet(world: WoodsWorld, longSide: number, images: PrintImages = {}): PrintResult {
  const t0 = performance.now()
  const phases: Record<string, number> = {}
  let tp = t0
  const phase = (name: string) => { const t = performance.now(); phases[name] = Math.round(t - tp); tp = t }
  const k = longSide / SHEET.h
  const W = Math.round(SHEET.w * k), H = longSide
  const canvas = new OffscreenCanvas(W, H)
  const g = canvas.getContext("2d")!
  g.setTransform(k, 0, 0, k, 0, 0)
  const half = world.params.half
  const M = SHEET.map
  const inMap = (fn: () => void) => { g.save(); g.beginPath(); g.rect(M.x, M.y, M.size, M.size); g.clip(); fn(); g.restore() }
  const mmPerM = M.size / (half * 2)

  // ---- Paper: the generated aged sheet (stains, coffee ring), lifted towards a cleaner survey stock.
  g.fillStyle = "#efe7d2"
  g.fillRect(0, 0, SHEET.w, SHEET.h)
  if (images.wear) {
    g.globalAlpha = 0.9
    g.drawImage(images.wear, 0, 0, SHEET.w, SHEET.h)
    g.globalAlpha = 0.28
    g.fillStyle = "#fbf6ea"
    g.fillRect(0, 0, SHEET.w, SHEET.h)
    g.globalAlpha = 1
  }
  g.globalCompositeOperation = "multiply"

  // ---- Height grid over the map square (0.75 mm cells: fine enough for 1 ft contours).
  const n = 400, step = (half * 2) / n
  const hs = new Float32Array((n + 1) * (n + 1))
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) hs[j * (n + 1) + i] = terrainHeight(world.terrain, -half + i * step, -half + j * step)
  const at = (i: number, j: number): Pt => worldToSheet(world, -half + i * step, -half + j * step)
  const Hs = (i: number, j: number) => hs[Math.min(n, Math.max(0, j)) * (n + 1) + Math.min(n, Math.max(0, i))]!
  const level = world.lake.level
  phase("grid")

  // ---- Woodland: density from the real trunks; dense woods tinted, thinner stands as scrub dots, clearings white.
  const R = 128, cell = (half * 2) / R
  const dens = new Float32Array((R + 1) * (R + 1))
  {
    const count = new Float32Array(R * R)
    for (const t of world.trees) {
      const i = Math.floor((t.x + half) / cell), j = Math.floor((t.z + half) / cell)
      if (i >= 0 && j >= 0 && i < R && j < R) count[j * R + i]! += 1
    }
    for (let j = 0; j <= R; j++) for (let i = 0; i <= R; i++) {
      let s = 0, w = 0
      for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
        const ii = i + di, jj = j + dj
        if (ii < 0 || jj < 0 || ii >= R || jj >= R) continue
        const wt = 1 / (1 + di * di + dj * dj)
        s += count[jj * R + ii]! * wt; w += wt
      }
      const per100 = (s / w) / (cell * cell) * 100
      const h = Hs(Math.round((i / R) * n), Math.round((j / R) * n))
      dens[j * (R + 1) + i] = h < level + 0.2 ? 0 : per100
    }
  }
  const atD = (i: number, j: number): Pt => [M.x + i * cell * mmPerM, M.y + j * cell * mmPerM]
  const WOODS = 1.5, OPEN = 0.7
  inMap(() => {
    // A sharp-edged tint: the density field thresholded with a narrow ramp, smoothed by the upscale.
    const c = new OffscreenCanvas(R + 1, R + 1)
    const cg = c.getContext("2d")!, img = cg.createImageData(R + 1, R + 1)
    for (let q = 0; q < dens.length; q++) {
      const a = Math.max(0, Math.min(1, (dens[q]! - WOODS) / 0.25 + 0.5))
      img.data[q * 4] = 201; img.data[q * 4 + 1] = 224; img.data[q * 4 + 2] = 177; img.data[q * 4 + 3] = Math.round(a * 255)
    }
    cg.putImageData(img, 0, 0)
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high"
    g.drawImage(c, M.x - cell * mmPerM * 0.5, M.y - cell * mmPerM * 0.5, (R + 1) * cell * mmPerM, (R + 1) * cell * mmPerM)
  })
  // Scrub: open stands get the green dot screen.
  inMap(() => {
    const r = rng(41)
    g.fillStyle = SCRUB
    for (let y = M.y; y < M.y + M.size; y += 1.1) for (let x = M.x + ((y * 7) % 1.1); x < M.x + M.size; x += 1.1) {
      const di = (x - M.x) / (cell * mmPerM), dj = (y - M.y) / (cell * mmPerM)
      const d = dens[Math.min(R, Math.round(dj)) * (R + 1) + Math.min(R, Math.round(di))]!
      if (d > OPEN && d < WOODS && r() < 0.8) { g.beginPath(); g.arc(x + (r() - 0.5) * 0.3, y + (r() - 0.5) * 0.3, 0.13, 0, Math.PI * 2); g.fill() }
    }
  })

  // ---- Hillshade from the north-west, faint (a modern quad's relief shading under the contours).
  inMap(() => {
    const c = new OffscreenCanvas(n, n)
    const cg = c.getContext("2d")!, img = cg.createImageData(n, n)
    const L = [-0.55, 0.6, -0.58]
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const dx = (Hs(i + 1, j) - Hs(i - 1, j)) / (2 * step), dz = (Hs(i, j + 1) - Hs(i, j - 1)) / (2 * step)
      const nl = Math.hypot(dx * 3, 1, dz * 3)
      const lam = (-dx * 3 * L[0]! + L[1]! - dz * 3 * L[2]!) / nl
      const v = Math.round(255 * Math.max(0, Math.min(1, 0.74 + 0.5 * (lam - 0.6))))
      const o = (j * n + i) * 4
      img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = Math.min(255, v + 4); img.data[o + 3] = 255
    }
    cg.putImageData(img, 0, 0)
    g.globalAlpha = 0.5
    g.drawImage(c, M.x, M.y, M.size, M.size)
    g.globalAlpha = 1
  })
  phase("woodland+hillshade")

  // ---- Water: the lake below its level, blue fill, then the shoreline and water lines.
  const shore = contourLines(hs, n, level, at).map((l) => smooth(l))
  inMap(() => {
    g.beginPath()
    for (const l of shore) { trace(g, l); g.closePath() }
    g.fillStyle = WATER
    g.fill("evenodd")
    g.save(); g.clip("evenodd")
    g.strokeStyle = "rgba(31,111,174,0.35)"; g.lineWidth = 0.07
    for (const off of [0.6, 1.3, 2.1, 3.0]) {
      g.beginPath()
      for (const l of contourLines(hs, n, level - off * 0.6, at).map((x) => smooth(x))) trace(g, l)
      g.stroke()
    }
    g.restore()
  })

  // ---- Streams: D8 drainage over a 2 m grid; channels with enough catchment, intermittent (dash, dot, dot).
  const streams: Pt[][] = []
  {
    const m = 200, s2 = (half * 2) / m
    const h2 = new Float32Array((m + 1) * (m + 1))
    for (let j = 0; j <= m; j++) for (let i = 0; i <= m; i++) h2[j * (m + 1) + i] = Hs(Math.round((i * n) / m), Math.round((j * n) / m))
    const N2 = (m + 1) * (m + 1)
    const down = new Int32Array(N2).fill(-1)
    for (let j = 0; j <= m; j++) for (let i = 0; i <= m; i++) {
      const q = j * (m + 1) + i, h = h2[q]!
      let best = 0, bq = -1
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue
        const ii = i + di, jj = j + dj
        if (ii < 0 || jj < 0 || ii > m || jj > m) continue
        const drop = (h - h2[jj * (m + 1) + ii]!) / Math.hypot(di, dj)
        if (drop > best) { best = drop; bq = jj * (m + 1) + ii }
      }
      down[q] = bq
    }
    const order = Array.from({ length: N2 }, (_, q) => q).sort((a, b) => h2[b]! - h2[a]!)
    const acc = new Float32Array(N2).fill(1)
    for (const q of order) { const d = down[q]!; if (d >= 0) acc[d]! += acc[q]! }
    const T = 260
    const upCount = new Uint8Array(N2)
    for (let q = 0; q < N2; q++) if (acc[q]! >= T && down[q]! >= 0) upCount[down[q]!]! += 1
    const pt = (q: number): Pt => worldToSheet(world, -half + (q % (m + 1)) * s2, -half + Math.floor(q / (m + 1)) * s2)
    const seen = new Uint8Array(N2)
    for (let q = 0; q < N2; q++) {
      if (acc[q]! < T || upCount[q]! > 0 || h2[q]! < level) continue
      const line: Pt[] = [pt(q)]
      let c = q
      while (c >= 0 && !seen[c] && h2[c]! >= level - 0.1 && line.length < 600) {
        seen[c] = 1
        c = down[c]!
        if (c >= 0) line.push(pt(c))
      }
      if (c >= 0 && seen[c]) line.push(pt(c))
      if (line.length > 6) streams.push(smooth(line, 3))
    }
  }
  inMap(() => {
    g.strokeStyle = BLUE; g.lineCap = "round"
    for (const l of streams) {
      g.lineWidth = 0.16
      g.setLineDash([2.2, 0.55, 0.12, 0.55, 0.12, 0.55])
      g.beginPath(); trace(g, l); g.stroke()
    }
    g.setLineDash([])
  })

  // ---- Marsh: tufts where the shore is flat and wet.
  inMap(() => {
    const r = rng(77)
    g.strokeStyle = BLUE; g.lineWidth = 0.09
    for (let y = M.y + 1; y < M.y + M.size; y += 2.1) for (let x = M.x + 1 + ((y * 3) % 2.1); x < M.x + M.size; x += 2.1) {
      const i = ((x - M.x) / M.size) * n, j = ((y - M.y) / M.size) * n
      const h = Hs(Math.round(i), Math.round(j))
      if (h < level + 0.02 || h > level + 0.55) continue
      const sl = Math.hypot(Hs(Math.round(i) + 2, Math.round(j)) - Hs(Math.round(i) - 2, Math.round(j)), Hs(Math.round(i), Math.round(j) + 2) - Hs(Math.round(i), Math.round(j) - 2)) / (4 * step)
      if (sl > 0.06 || r() < 0.35) continue
      const cx = x + (r() - 0.5) * 0.8, cy = y + (r() - 0.5) * 0.8
      g.beginPath()
      g.moveTo(cx - 0.75, cy); g.lineTo(cx + 0.75, cy)
      for (const dx of [-0.45, 0, 0.45]) { g.moveTo(cx + dx, cy - 0.08); g.lineTo(cx + dx * 1.3, cy - (dx ? 0.55 : 0.75)) }
      g.stroke()
    }
  })
  phase("water")

  // ---- Contours: 1 ft interval; every fifth an index contour, darker, labelled every ~70 mm (above water only).
  let top = -Infinity
  for (const h of hs) if (h > top) top = h
  const lo = Math.ceil(feetOf(world, level) + 0.5), hiFt = Math.floor(feetOf(world, top))
  inMap(() => {
    g.lineJoin = g.lineCap = "round"
    const labels: { x: number; y: number; a: number; text: string }[] = []
    for (let ft = lo; ft <= hiFt; ft++) {
      const index = ft % 5 === 0
      const lines = contourLines(hs, n, level + (ft - 1240) * FT, at).map((l) => smooth(l))
      g.strokeStyle = index ? BROWN_INDEX : BROWN
      g.lineWidth = index ? 0.2 : 0.085
      g.globalAlpha = index ? 0.95 : 0.8
      // One path per level for the plain lines (stroking each line alone is what made the 4K print slow).
      g.beginPath()
      const labelled: [Pt[], number[]][] = []
      for (const l of lines) {
        if (l.length < 3) continue
        const len = index && l.length > 8 ? lengthOf(l) : 0
        const cuts: number[] = []
        if (len > 25) for (let s = 12 + ((ft * 17) % 40); s < len - 8; s += 70) cuts.push(s)
        if (cuts.length) labelled.push([l, cuts]); else trace(g, l)
      }
      g.stroke()
      for (const [l, cuts] of labelled) for (const c of strokeWithGaps(g, l, cuts, 4.6)) labels.push({ ...c, text: `${ft}` })
    }
    g.globalAlpha = 1
    g.fillStyle = BROWN_INDEX
    g.font = `500 1.45px ${SANS}`
    g.textAlign = "center"; g.textBaseline = "middle"
    for (const lb of labels) { g.save(); g.translate(lb.x, lb.y); g.rotate(lb.a); g.fillText(lb.text, 0, 0); g.restore() }
  })
  phase("contours")

  // ---- Shoreline over the contours.
  inMap(() => {
    g.strokeStyle = BLUE; g.lineWidth = 0.2
    g.beginPath(); for (const l of shore) trace(g, l); g.stroke()
  })

  // ---- Vegetation boundary: a fine dotted line round the woodland tint.
  inMap(() => {
    g.strokeStyle = "rgba(40,80,30,0.8)"; g.lineWidth = 0.1; g.lineCap = "round"
    g.setLineDash([0.01, 0.55])
    g.beginPath()
    for (const l of contourLines(dens, R, WOODS, atD)) trace(g, smooth(l, 3))
    g.stroke()
    g.setLineDash([])
  })

  // ---- Section lines: red every 100 m, numbered boustrophedon like the public-land survey; 10 m ticks on them.
  const sec = 100
  const nSec = Math.round((half * 2) / sec)
  g.strokeStyle = RED; g.lineWidth = 0.17; g.globalAlpha = 0.9
  for (let v = -half + sec; v < half; v += sec) {
    const [x0, y0] = worldToSheet(world, v, -half), [x1, y1] = worldToSheet(world, v, half)
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke()
    const [a0, b0] = worldToSheet(world, -half, v), [a1, b1] = worldToSheet(world, half, v)
    g.beginPath(); g.moveTo(a0, b0); g.lineTo(a1, b1); g.stroke()
  }
  g.globalAlpha = 1
  g.fillStyle = RED; g.font = `600 4.2px ${SANS}`; g.textAlign = "center"; g.textBaseline = "middle"
  for (let r = 0; r < nSec; r++) for (let c = 0; c < nSec; c++) {
    const num = r * nSec + (r % 2 ? nSec - c : c + 1) + 8
    const [x, y] = worldToSheet(world, -half + (c + 0.5) * sec, -half + (r + 0.5) * sec)
    g.fillText(`${num}`, x + 9, y + 11)
  }
  // Grid crosses every 100 m and 50 m ticks in blue outside the neatline, 10 m ticks inside it in black.
  g.strokeStyle = BLACK; g.lineWidth = 0.12
  for (let a = -half + 100; a < half; a += 100) for (let b = -half + 100; b < half; b += 100) {
    const [x, y] = worldToSheet(world, a, b)
    g.beginPath(); g.moveTo(x - 1.2, y); g.lineTo(x + 1.2, y); g.moveTo(x, y - 1.2); g.lineTo(x, y + 1.2); g.stroke()
  }
  g.lineWidth = 0.1
  for (let v = -half; v <= half; v += 10) {
    const [x] = worldToSheet(world, v, 0), [, y] = worldToSheet(world, 0, v)
    const l = v % 50 === 0 ? 1.1 : 0.6
    g.beginPath()
    g.moveTo(x, M.y); g.lineTo(x, M.y + l); g.moveTo(x, M.y + M.size); g.lineTo(x, M.y + M.size - l)
    g.moveTo(M.x, y); g.lineTo(M.x + l, y); g.moveTo(M.x + M.size, y); g.lineTo(M.x + M.size - l, y)
    g.stroke()
  }
  g.strokeStyle = BLUE; g.lineWidth = 0.15
  for (let v = -half; v <= half; v += 50) {
    const [x] = worldToSheet(world, v, 0), [, y] = worldToSheet(world, 0, v)
    g.beginPath()
    g.moveTo(x, M.y); g.lineTo(x, M.y - 1.8); g.moveTo(x, M.y + M.size); g.lineTo(x, M.y + M.size + 1.8)
    g.moveTo(M.x, y); g.lineTo(M.x - 1.8, y); g.moveTo(M.x + M.size, y); g.lineTo(M.x + M.size + 1.8, y)
    g.stroke()
  }

  // ---- Culture: the old path (foot trail, black dashed), boulders, the camp, the dock and the mast, names.
  inMap(() => {
    const pts = world.trail.points
    const path: Pt[] = []
    for (let i = 0; i + 1 < pts.length; i++) {
      const p0 = pts[Math.max(0, i - 1)]!, p1 = pts[i]!, p2 = pts[i + 1]!, p3 = pts[Math.min(pts.length - 1, i + 2)]!
      for (let s = 0; s < 16; s++) {
        const t = s / 16, t2 = t * t, t3 = t2 * t
        const cr = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
        path.push(worldToSheet(world, cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1])))
      }
    }
    const last = pts[pts.length - 1]!
    path.push(worldToSheet(world, last[0], last[1]))
    g.strokeStyle = BLACK; g.lineWidth = 0.32; g.setLineDash([1.5, 0.75])
    g.beginPath(); trace(g, path); g.stroke(); g.setLineDash([])
    g.fillStyle = BLACK
    for (const rk of world.rocks) {
      const [x, y] = worldToSheet(world, rk.x, rk.z)
      const s = Math.max(0.35, Math.min(1.1, Math.max(rk.w, rk.d) * mmPerM * 0.6))
      g.beginPath(); g.ellipse(x, y, s * 0.6, s * 0.45, rk.yaw, 0, Math.PI * 2); g.fill()
    }
    for (const b of world.buildings) {
      const [ax, ay] = worldToSheet(world, b.rect[0], b.rect[1]), [bx, by] = worldToSheet(world, b.rect[2], b.rect[3])
      if (b.kind === "cabin" || b.kind === "mess-hall") g.fillRect(ax, ay, Math.max(0.9, bx - ax), Math.max(0.9, by - ay))
      if (b.kind === "dock") { g.lineWidth = 0.35; g.strokeStyle = BLACK; g.beginPath(); g.moveTo((ax + bx) / 2, ay); g.lineTo((ax + bx) / 2, by); g.stroke() }
    }
    const [mx, my] = worldToSheet(world, world.ridgeLight.x, world.ridgeLight.z)
    g.lineWidth = 0.22
    g.beginPath(); g.arc(mx, my, 0.55, 0, Math.PI * 2); g.fill()
    g.beginPath(); g.arc(mx, my, 1.4, 0, Math.PI * 2); g.stroke()
    g.font = `italic 2.1px ${SANS}`; g.textAlign = "left"; g.textBaseline = "middle"
    g.fillText("Radio Tower", mx + 2.4, my - 0.4)
    // Spot heights on every summit (local maxima), in feet.
    g.font = `1.6px ${SANS}`
    const peaks: Pt[] = []
    for (let j = 12; j <= n - 12; j += 6) for (let i = 12; i <= n - 12; i += 6) {
      const h = Hs(i, j)
      let top = h > level + 1.5
      for (let dj = -12; dj <= 12 && top; dj += 3) for (let di = -12; di <= 12 && top; di += 3) if ((di || dj) && Hs(i + di, j + dj) > h) top = false
      if (!top) continue
      const p = at(i, j)
      if (peaks.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 14)) continue
      peaks.push(p)
      g.fillText(`× ${Math.round(feetOf(world, h))}`, p[0] - 0.6, p[1])
    }
    const [cx, cy] = worldToSheet(world, world.camp.x, world.camp.z)
    g.font = `1.5px ${SANS}`
    g.fillText(`BM ⊗ ${Math.round(feetOf(world, terrainHeight(world.terrain, world.camp.x, world.camp.z)))}`, cx + 6, cy + 5)
    g.font = `italic 600 2.4px ${SANS}`; g.textAlign = "center"
    g.fillText("Camp Tamarack", cx + 2, cy - 9)
    const [lx, ly] = worldToSheet(world, world.lake.x, world.lake.z)
    g.fillStyle = BLUE; g.font = `italic 3.2px ${SERIF}`
    g.fillText("Tamarack Lake", lx, ly + 2)
    if (streams.length) {
      const s0 = [...streams].sort((a, b) => lengthOf(b) - lengthOf(a))[0]!
      const mid = s0[Math.floor(s0.length * 0.45)]!, nx = s0[Math.floor(s0.length * 0.45) + 2] ?? mid
      let a = Math.atan2(nx[1] - mid[1], nx[0] - mid[0]); if (a > Math.PI / 2) a -= Math.PI; if (a < -Math.PI / 2) a += Math.PI
      g.font = `italic 1.9px ${SERIF}`
      g.save(); g.translate(mid[0], mid[1]); g.rotate(a); g.fillText("Tamarack  Brook", 0, -1.3); g.restore()
    }
    g.fillStyle = BROWN_INDEX; g.font = `italic 3px ${SERIF}`
    const [rx, ry] = worldToSheet(world, -40, -168)
    g.save(); g.translate(rx, ry); g.rotate(-0.04)
    g.fillText("S  I  G  N  A  L     R  I  D  G  E", 0, 0)
    g.restore()
    g.fillStyle = BLACK; g.font = `italic 2px ${SERIF}`
    for (const [name, x, z] of [["Hemlock Hollow", -150, 60], ["Beaver Meadow", 120, 150], ["Bear Swamp", 150, -40]] as const) {
      const [px, py] = worldToSheet(world, x, z)
      g.fillText(name, px, py)
    }
  })
  phase("culture")

  // ---- Neatline and collar.
  g.strokeStyle = BLACK; g.lineWidth = 0.35
  g.strokeRect(M.x, M.y, M.size, M.size)
  g.fillStyle = BLACK; g.textBaseline = "alphabetic"
  g.font = `600 3.1px ${SANS}`; g.textAlign = "left"
  g.fillText("NEW YORK STATE CONSERVATION DEPARTMENT", M.x, 9.5)
  g.font = `2.2px ${SANS}`
  g.fillText("DIVISION OF LANDS AND FORESTS", M.x, 13.4)
  g.textAlign = "right"; g.font = `600 3.4px ${SANS}`
  g.fillText("TAMARACK STATE FOREST QUADRANGLE", M.x + M.size, 9.5)
  g.font = `2.2px ${SANS}`
  g.fillText("NEW YORK — HAMILTON CO.", M.x + M.size, 13.4)
  g.fillText("1:1 333 SERIES (TOPOGRAPHIC)", M.x + M.size, 16.6)
  g.font = `1.7px ${SANS}`; g.fillStyle = "#3a3632"
  for (let v = -half; v <= half; v += 100) {
    const [x] = worldToSheet(world, v, 0), [, y] = worldToSheet(world, 0, v)
    const e = `${431 + (v + half) / 100}`, nn = `${4877 - (v + half) / 100}`
    g.textAlign = "center"
    g.fillText(e, x, M.y - 2.6)
    g.fillText(e, x, M.y + M.size + 4.2)
    g.textAlign = "right"; g.fillText(nn, M.x - 2.4, y + 0.6)
    g.textAlign = "left"; g.fillText(nn, M.x + M.size + 2.4, y + 0.6)
  }
  // Corner coordinates and adjoining sheets.
  g.font = `1.6px ${SANS}`; g.fillStyle = BLACK
  g.textAlign = "left"; g.fillText("74°22′30″", M.x - 1, M.y - 5.6); g.fillText("43°52′30″", M.x - 1, M.y - 7.6)
  g.textAlign = "right"; g.fillText("22′15″", M.x + M.size + 1, M.y - 5.6); g.fillText("431 000m E.", M.x + M.size + 1, M.y - 7.6)
  g.textAlign = "left"; g.fillText("74°22′30″", M.x - 1, M.y + M.size + 7.2)
  g.textAlign = "right"; g.fillText("43°52′15″", M.x + M.size + 1, M.y + M.size + 7.2)
  g.font = `italic 1.8px ${SANS}`; g.textAlign = "center"
  for (const [name, x, y, a] of [["(HEMLOCK HOLLOW)", M.x - 9, M.y + M.size / 2, -Math.PI / 2], ["(BEAVER MEADOW)", M.x + M.size + 9, M.y + M.size / 2, Math.PI / 2]] as const) {
    g.save(); g.translate(x, y); g.rotate(a); g.fillText(name, 0, 0); g.restore()
  }

  // Bottom collar: declination, credits, scale, contour interval, legend, sheet index, title block.
  const yb = M.y + M.size + 11
  g.fillStyle = BLACK; g.strokeStyle = BLACK
  {
    const x = M.x + 64, y = yb + 40
    g.lineWidth = 0.25
    g.beginPath(); g.moveTo(x, y); g.lineTo(x, y - 30); g.stroke()
    star(g, x, y - 32, 1.6)
    const a = (-2 * Math.PI) / 180
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.sin(a) * 28, y - Math.cos(a) * 28); g.stroke()
    g.beginPath(); g.moveTo(x + Math.sin(a) * 28, y - Math.cos(a) * 28); g.lineTo(x + Math.sin(a) * 28 - 1.4, y - Math.cos(a) * 28 + 4); g.lineTo(x + Math.sin(a) * 25, y - Math.cos(a) * 25); g.fill()
    g.font = `1.8px ${SANS}`; g.textAlign = "center"
    g.fillText("MN", x - 4.2, y - 24)
    g.fillText("2°", x - 2.2, y - 8)
    g.font = `1.4px ${SANS}`
    g.fillText("APPROXIMATE MEAN", x + 1, y + 3.6)
    g.fillText("DECLINATION, 1984", x + 1, y + 5.4)
  }
  {
    // Credits, bottom left (the small print of a real quad).
    const lines = [
      "Mapped, edited and published by the Division of Lands and Forests",
      "Control by USC&GS and NYSDPW",
      "Topography by planetable surveys 1969–1971",
      "Field checked 1984. Map not field checked since",
      "Polyconic projection. 1927 North American datum",
      "100-metre grid based on New York coordinate",
      "system, east zone (red section lines)",
      "Fine red dashed lines indicate selected fence lines",
      "Unchecked elevations are shown in brown",
      "Woodland tint from 1983 aerial photographs",
    ]
    g.font = `1.35px ${SANS}`; g.textAlign = "left"
    lines.forEach((s, i) => g.fillText(s, M.x, yb + 1 + i * 2.05))
    g.font = `600 1.5px ${SANS}`
    g.fillText("THIS MAP COMPLIES WITH STATE MAP ACCURACY STANDARDS", M.x, yb + 24)
    g.font = `1.35px ${SANS}`
    g.fillText("FOR SALE BY THE CONSERVATION DEPARTMENT, ALBANY, NEW YORK 12224", M.x, yb + 26.2)
    g.fillText("A FOLDER DESCRIBING TOPOGRAPHIC MAPS AND SYMBOLS IS AVAILABLE ON REQUEST", M.x, yb + 28.2)
  }
  {
    const scale = scaleOf(world)
    const cx = SHEET.w / 2 + 12, y = yb + 1
    g.textAlign = "center"; g.font = `600 2.5px ${SANS}`
    g.fillText(`SCALE 1:${scale.toLocaleString("en-US").replace(",", " ")}`, cx, y)
    const mm = (m: number) => m * mmPerM
    const bar = (yy: number, units: number[], label: string, unitMm: number) => {
      const x0 = cx - mm(units[units.length - 1]!) / 2 * unitMm
      g.lineWidth = 0.2
      for (let i = 0; i + 1 < units.length; i++) {
        const a = x0 + mm(units[i]!) * unitMm, b = x0 + mm(units[i + 1]!) * unitMm
        if (i % 2 === 0) g.fillRect(a, yy, b - a, 1)
        g.strokeRect(a, yy, b - a, 1)
      }
      g.font = `1.6px ${SANS}`
      for (const u of units) g.fillText(`${u}`, x0 + mm(u) * unitMm, yy - 0.8)
      g.fillText(label, x0 + mm(units[units.length - 1]!) * unitMm + 7, yy + 0.9)
    }
    bar(y + 4.5, [0, 10, 20, 30, 40, 50, 100], "METRES", 1)
    bar(y + 11, [0, 50, 100, 150, 200, 250, 300], "FEET", FT)
    g.font = `2.1px ${SANS}`
    g.fillText("CONTOUR INTERVAL 1 FOOT", cx, y + 18.5)
    g.font = `1.45px ${SANS}`
    g.fillText("ELEVATIONS IN FEET ABOVE MEAN SEA LEVEL · INDEX CONTOURS EVERY 5 FEET", cx, y + 21.2)
    // Legend.
    const lx = cx - 26, ly = y + 27
    g.textAlign = "left"; g.font = `1.5px ${SANS}`
    g.fillRect(lx, ly - 0.9, 2, 1.5); g.fillText("Building", lx + 3.5, ly + 0.4)
    g.lineWidth = 0.3; g.setLineDash([1.5, 0.75]); g.beginPath(); g.moveTo(lx + 18, ly); g.lineTo(lx + 25, ly); g.stroke(); g.setLineDash([])
    g.fillText("Foot trail", lx + 26.5, ly + 0.4)
    g.strokeStyle = BLUE; g.lineWidth = 0.16; g.setLineDash([2.2, 0.55, 0.12, 0.55, 0.12, 0.55]); g.beginPath(); g.moveTo(lx + 38, ly); g.lineTo(lx + 45, ly); g.stroke(); g.setLineDash([]); g.strokeStyle = BLACK
    g.fillText("Intermittent stream", lx + 46.5, ly + 0.4)
    g.beginPath(); g.arc(lx + 1, ly + 4.4, 0.5, 0, Math.PI * 2); g.fill(); g.lineWidth = 0.2; g.beginPath(); g.arc(lx + 1, ly + 4.4, 1.1, 0, Math.PI * 2); g.stroke()
    g.fillText("Radio tower", lx + 3.5, ly + 5)
    g.fillStyle = GREEN; g.fillRect(lx + 18, ly + 3.6, 7, 1.8); g.fillStyle = BLACK
    g.fillText("Woodland", lx + 26.5, ly + 5)
    g.fillStyle = SCRUB; for (let i = 0; i < 6; i++) for (let j = 0; j < 2; j++) { g.beginPath(); g.arc(lx + 38.5 + i * 1.1, ly + 4 + j * 1, 0.13, 0, Math.PI * 2); g.fill() }
    g.fillStyle = BLACK; g.fillText("Scrub", lx + 46.5, ly + 5)
    g.beginPath(); g.ellipse(lx + 1, ly + 8.6, 0.6, 0.45, 0.3, 0, Math.PI * 2); g.fill(); g.fillText("Boulder", lx + 3.5, ly + 9.1)
    g.strokeStyle = BLUE; g.lineWidth = 0.09; g.beginPath(); g.moveTo(lx + 18.5, ly + 8.8); g.lineTo(lx + 20, ly + 8.8); for (const dx of [-0.45, 0, 0.45]) { g.moveTo(lx + 19.25 + dx, ly + 8.7); g.lineTo(lx + 19.25 + dx * 1.3, ly + 8.1) } g.stroke(); g.strokeStyle = BLACK
    g.fillText("Marsh", lx + 26.5, ly + 9.1)
    g.fillText("× 1287  Spot elevation", lx + 38, ly + 9.1)
  }
  {
    // Title block: a ruled box, bottom right, with the adjoining-sheet index beside it.
    const x1 = M.x + M.size, x0 = x1 - 52, y0 = yb + 15, y1 = yb + 40
    g.lineWidth = 0.3; g.strokeRect(x0, y0, x1 - x0, y1 - y0)
    g.lineWidth = 0.12; g.beginPath(); g.moveTo(x0, y0 + 11); g.lineTo(x1, y0 + 11); g.moveTo(x0, y0 + 18); g.lineTo(x1, y0 + 18); g.stroke()
    g.textAlign = "center"
    g.font = `700 4.3px ${SERIF}`
    g.fillText("TAMARACK STATE FOREST", (x0 + x1) / 2, y0 + 5.4)
    g.font = `2.3px ${SERIF}`
    g.fillText("NEW YORK", (x0 + x1) / 2, y0 + 9)
    g.font = `1.7px ${SANS}`
    g.fillText("SHEET 4 OF 9 · N4352.5—W7422.5/2.5", (x0 + x1) / 2, y0 + 15.2)
    g.font = `600 2.2px ${SANS}`
    g.fillText("1971", (x0 + x1) / 2, y0 + 21.4)
    g.font = `1.5px ${SANS}`
    g.fillText("PHOTOREVISED 1984 · AMS 6070 IV SW—SERIES V821", (x0 + x1) / 2, y0 + 23.8)
    // Sheet index: 3 × 3 with this sheet shaded.
    const ix = x0 - 16, iy = y0 + 2, c = 4.2
    g.lineWidth = 0.12
    for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) {
      if (r === 1 && q === 1) { g.fillStyle = "rgba(29,27,25,0.35)"; g.fillRect(ix + q * c, iy + r * c, c, c); g.fillStyle = BLACK }
      g.strokeRect(ix + q * c, iy + r * c, c, c)
    }
    g.font = `1.2px ${SANS}`
    g.fillText("QUADRANGLE LOCATION", ix + c * 1.5, iy + c * 3 + 2)
    g.fillText("CAMP TAMARACK ISSUE — RETURN TO OFFICE", (x0 + x1) / 2, y1 + 2.4)
  }
  phase("collar")

  g.globalCompositeOperation = "source-over"
  wearCreases(g, 3)
  if (images.wear) {
    g.globalCompositeOperation = "multiply"
    g.globalAlpha = 0.3
    g.drawImage(images.wear, 0, 0, SHEET.w, SHEET.h)
    g.globalAlpha = 1
    g.globalCompositeOperation = "source-over"
  }
  edgeGrime(g)
  tearEdges(g, 11)
  phase("wear")
  return { canvas, ms: performance.now() - t0, phases }
}

function star(g: Ctx, x: number, y: number, r: number) {
  g.beginPath()
  for (let i = 0; i < 10; i++) {
    const a = (i * Math.PI) / 5 - Math.PI / 2, rr = i % 2 ? r * 0.42 : r
    if (i) g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); else g.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr)
  }
  g.closePath(); g.fill()
}

/** Ink worn off along the creases: broken pale strokes, and a faint grime line either side. */
function wearCreases(g: Ctx, seed: number) {
  const r = rng(seed)
  const line = (x0: number, y0: number, x1: number, y1: number) => {
    const len = Math.hypot(x1 - x0, y1 - y0), ux = (x1 - x0) / len, uy = (y1 - y0) / len
    g.globalCompositeOperation = "multiply"
    g.strokeStyle = "rgba(120,100,70,0.16)"; g.lineWidth = 1.4
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke()
    g.globalCompositeOperation = "source-over"
    for (let s = 0; s < len;) {
      const run = 2 + r() * 14, gap = r() * 5
      const w = 0.25 + r() * 0.55
      g.strokeStyle = `rgba(246,240,224,${0.55 + r() * 0.4})`; g.lineWidth = w
      const j = (r() - 0.5) * 0.3
      g.beginPath(); g.moveTo(x0 + ux * s - uy * j, y0 + uy * s + ux * j); g.lineTo(x0 + ux * Math.min(len, s + run) - uy * j, y0 + uy * Math.min(len, s + run) + ux * j); g.stroke()
      s += run + gap
    }
  }
  for (const u of SHEET.creasesU) line(u, 0, u, SHEET.h)
  for (const v of SHEET.creasesV) line(0, v, SHEET.w, v)
}

/** Handling grime: darker towards the edges and where a thumb holds the sheet (lower left). */
function edgeGrime(g: Ctx) {
  g.globalCompositeOperation = "multiply"
  const e = 14
  for (const [x0, y0, x1, y1] of [[0, 0, e, 0], [SHEET.w, 0, SHEET.w - e, 0], [0, 0, 0, e], [0, SHEET.h, 0, SHEET.h - e]] as const) {
    const grad = g.createLinearGradient(x0, y0, x1 || x0, y1 || y0)
    grad.addColorStop(0, "rgba(150,120,80,0.32)"); grad.addColorStop(1, "rgba(255,255,255,0)")
    g.fillStyle = grad
    g.fillRect(0, 0, SHEET.w, SHEET.h)
  }
  const thumb = g.createRadialGradient(18, 300, 2, 18, 300, 40)
  thumb.addColorStop(0, "rgba(140,115,85,0.3)"); thumb.addColorStop(1, "rgba(255,255,255,0)")
  g.fillStyle = thumb; g.fillRect(0, 240, 70, 120)
  g.globalCompositeOperation = "source-over"
}

/** Torn, frayed edges in the alpha channel: an eroded margin, notches where creases meet the edge, a lost corner. */
function tearEdges(g: Ctx, seed: number) {
  const r = rng(seed)
  g.globalCompositeOperation = "destination-out"
  g.fillStyle = "#000"
  const W = SHEET.w, H = SHEET.h
  const nib = (x: number, y: number, s: number) => { g.beginPath(); g.ellipse(x, y, s, s * (0.5 + r()), r() * 3, 0, Math.PI * 2); g.fill() }
  for (let s = 0; s < W; s += 0.35) { if (r() < 0.55) nib(s, -0.15 + r() * 0.35, 0.18 + r() * 0.35); if (r() < 0.55) nib(s, H + 0.15 - r() * 0.35, 0.18 + r() * 0.35) }
  for (let s = 0; s < H; s += 0.35) { if (r() < 0.55) nib(-0.15 + r() * 0.35, s, 0.18 + r() * 0.35); if (r() < 0.55) nib(W + 0.15 - r() * 0.35, s, 0.18 + r() * 0.35) }
  const notch = (x: number, y: number, dx: number, dy: number, depth: number) => {
    g.beginPath(); g.moveTo(x - dy * 0.9, y - dx * 0.9)
    let px = x, py = y
    for (let i = 1; i <= 6; i++) { px = x + dx * depth * (i / 6) + (r() - 0.5) * 0.4; py = y + dy * depth * (i / 6) + (r() - 0.5) * 0.4; g.lineTo(px, py) }
    g.lineTo(x + dy * 0.9, y + dx * 0.9); g.closePath(); g.fill()
  }
  notch(SHEET.creasesU[0], 0, 0, 1, 4.5)
  notch(SHEET.creasesU[1], H, 0, -1, 3)
  notch(W, SHEET.creasesV[0], -1, 0, 6)
  notch(0, SHEET.creasesV[1], 1, 0, 2.5)
  g.beginPath(); g.ellipse(SHEET.creasesU[1], SHEET.creasesV[0], 0.9, 0.6, 0.4, 0, Math.PI * 2); g.fill()
  g.beginPath(); g.ellipse(SHEET.creasesU[0], SHEET.creasesV[1], 0.5, 0.35, 0.9, 0, Math.PI * 2); g.fill()
  g.beginPath(); g.moveTo(W - 9, -1); g.lineTo(W - 6, 1.2); g.lineTo(W - 3.5, 2.1); g.lineTo(W - 1.2, 5.5); g.lineTo(W + 1, 8); g.lineTo(W + 1, -1); g.fill()
  g.globalCompositeOperation = "source-over"
}
