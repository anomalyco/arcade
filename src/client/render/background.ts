import { WORLD_H, WORLD_W, type Mask } from "../../sim/terrain"
import bgFarUrl from "./assets/bg-far.webp"
import { ctx2d, makeCanvas, noise1, rng, smokeSprite, type Rand } from "./util"

// world y of the far lake horizon
export const HORIZON = 432
// plate pixel row of the lake line in bg-far
const PLATE_HORIZON = 0.56
const LAYER_X0 = -260
const LAYER_W = WORLD_W + 520
const LAYER_Y0 = HORIZON - 260
const LAYER_H = 300
const LAYER_RES = 1.5

export interface Layer {
  canvas: HTMLCanvasElement
  parallax: number
}

export interface Pine {
  x: number
  y: number
  h: number
  lean: number
  alive: boolean
}

export class Backdrop {
  plate: HTMLImageElement
  plateReady = false
  layers: Layer[] = []
  pines: Pine[] = []
  private seed = -1
  private dots: CanvasPattern | null = null
  private streaks: Array<{ x: number; y: number; len: number; speed: number; a: number }> = []

  constructor() {
    this.plate = new Image()
    this.plate.onload = () => {
      this.plateReady = true
    }
    this.plate.src = bgFarUrl
  }

  setSeed(seed: number): void {
    if (seed === this.seed) return
    this.seed = seed
    const r = rng(seed ^ 0xbacd)
    this.layers = [
      { canvas: ridgeLayer(r, seed, 0, { peak: 150, base: "#1a2a3e", top: "#22354c", mist: 0.32, pines: 0 }), parallax: 0.2 },
      { canvas: ridgeLayer(r, seed, 1, { peak: 85, base: "#111c2a", top: "#17263a", mist: 0.26, pines: 0.5 }), parallax: 0.36 },
      { canvas: shoreLayer(r), parallax: 0.5 },
    ]
    const sr = rng(seed ^ 0x77)
    this.streaks = []
    for (let i = 0; i < 22; i++) {
      this.streaks.push({ x: sr() * 1600 - 200, y: -120 + sr() * 360, len: 30 + sr() * 70, speed: 0.6 + sr() * 0.8, a: 0.15 + sr() * 0.3 })
    }
  }

  // scatter small pine clumps along the battlefield surface, away from unit spawns
  placePines(mask: Mask, seed: number, avoid: number[]): void {
    const r = rng(seed ^ 0x9133)
    this.pines = []
    const clumps = 9 + Math.floor(r() * 5)
    for (let c = 0; c < clumps; c++) {
      const cx = 20 + r() * (WORLD_W - 40)
      const n = 1 + Math.floor(r() * 4)
      for (let k = 0; k < n; k++) {
        const x = Math.round(cx + (k - n / 2) * (4 + r() * 4))
        if (x < 2 || x >= WORLD_W - 2) continue
        if (avoid.some((a) => Math.abs(a - x) < 22)) continue
        let y = 0
        while (y < WORLD_H && mask[y * WORLD_W + x] !== 1) y++
        if (y >= WORLD_H - 100) continue
        // skip steep spots
        let y2 = 0
        while (y2 < WORLD_H && mask[y2 * WORLD_W + x + 2] !== 1) y2++
        if (Math.abs(y2 - y) > 3) continue
        this.pines.push({ x, y: y + 1, h: 7 + r() * 9, lean: (r() - 0.5) * 0.08, alive: true })
      }
    }
  }

  checkPines(mask: Mask, x0: number, y0: number, x1: number, y1: number): Pine[] {
    const lost: Pine[] = []
    for (const p of this.pines) {
      if (!p.alive || p.x < x0 - 2 || p.x > x1 + 2 || p.y < y0 - 20 || p.y > y1 + 4) continue
      const base = mask[Math.min(WORLD_H - 1, p.y + 1) * WORLD_W + p.x] === 1
      const clear = mask[Math.max(0, p.y - 4) * WORLD_W + p.x] !== 1
      if (!base || !clear) {
        p.alive = false
        lost.push(p)
      }
    }
    return lost
  }

  drawPlate(g: CanvasRenderingContext2D, viewX0: number, viewX1: number, viewY0: number, viewY1: number, plateW: number): void {
    const img = this.plate
    const cx = (viewX0 + viewX1) / 2
    const w = plateW
    const h = (w * 1024) / 1536
    const x = cx - w / 2
    const y = HORIZON - PLATE_HORIZON * h
    if (!this.plateReady) {
      g.fillStyle = "#0b1528"
      g.fillRect(viewX0, viewY0, viewX1 - viewX0, viewY1 - viewY0)
      return
    }
    if (y > viewY0) g.drawImage(img, 0, 0, 1536, 2, viewX0 - 2, viewY0, viewX1 - viewX0 + 4, y - viewY0 + 1)
    g.drawImage(img, x, y, w, h)
    if (y + h < viewY1) g.drawImage(img, 0, 1020, 1536, 4, viewX0 - 2, y + h - 1, viewX1 - viewX0 + 4, viewY1 - y - h + 2)
  }

  dotPattern(g: CanvasRenderingContext2D): CanvasPattern | null {
    if (this.dots) return this.dots
    const c = makeCanvas(28, 28)
    const d = ctx2d(c)
    d.fillStyle = "rgba(150,190,230,0.16)"
    d.fillRect(13, 13, 1.6, 1.6)
    this.dots = g.createPattern(c, "repeat")
    return this.dots
  }

  drawStreaks(g: CanvasRenderingContext2D, now: number, wind: number, alpha: number): void {
    if (alpha <= 0.01 || Math.abs(wind) < 2) return
    const dir = Math.sign(wind)
    const sp = Math.abs(wind) / 40
    g.save()
    g.globalCompositeOperation = "lighter"
    g.lineCap = "round"
    for (const s of this.streaks) {
      const span = 1700
      const x = ((((s.x + now * 0.06 * s.speed * (0.4 + sp) * dir) % span) + span) % span) - 250
      const a = s.a * alpha * Math.min(1, 0.3 + sp)
      const grad = g.createLinearGradient(x, s.y, x - dir * s.len, s.y)
      grad.addColorStop(0, `rgba(170,220,255,${a})`)
      grad.addColorStop(1, "rgba(170,220,255,0)")
      g.strokeStyle = grad
      g.lineWidth = 0.8
      g.beginPath()
      g.moveTo(x, s.y)
      g.lineTo(x - dir * s.len, s.y + s.len * 0.02)
      g.stroke()
      g.fillStyle = `rgba(200,235,255,${a * 1.6})`
      g.fillRect(x - 0.7, s.y - 0.7, 1.4, 1.4)
    }
    g.restore()
  }

  drawPines(g: CanvasRenderingContext2D): void {
    g.fillStyle = "#06090d"
    g.strokeStyle = "rgba(120,200,255,0.18)"
    g.lineWidth = 0.4
    for (const p of this.pines) {
      if (!p.alive) continue
      pinePath(g, p.x, p.y, p.h, p.lean)
      g.fill()
      g.stroke()
    }
  }
}

export function layerRect(): { x: number; y: number; w: number; h: number } {
  return { x: LAYER_X0, y: LAYER_Y0, w: LAYER_W, h: LAYER_H }
}

function pinePath(g: CanvasRenderingContext2D, x: number, y: number, h: number, lean = 0): void {
  const w = h * 0.36
  g.beginPath()
  g.moveTo(x - 0.5, y)
  const tiers = 4
  const pts: Array<[number, number]> = []
  for (let i = 0; i < tiers; i++) {
    const t0 = 0.15 + (i / tiers) * 0.85
    const t1 = 0.15 + ((i + 1) / tiers) * 0.85
    const wb = w * (1 - i / tiers) + 0.6
    pts.push([wb, t0], [wb * 0.45, t1 - 0.02])
  }
  g.lineTo(x - w * 0.12, y - h * 0.15)
  for (const [wb, t] of pts) g.lineTo(x - wb + lean * h * t, y - h * t)
  g.lineTo(x + lean * h, y - h)
  for (let i = pts.length - 1; i >= 0; i--) {
    const [wb, t] = pts[i]!
    g.lineTo(x + wb + lean * h * t, y - h * t)
  }
  g.lineTo(x + w * 0.12, y - h * 0.15)
  g.lineTo(x + 0.5, y)
  g.closePath()
}

interface RidgeOpts {
  peak: number
  base: string
  top: string
  mist: number
  pines: number
}

function ridgeLayer(r: Rand, seed: number, idx: number, o: RidgeOpts): HTMLCanvasElement {
  const c = makeCanvas(LAYER_W * LAYER_RES, LAYER_H * LAYER_RES)
  const g = ctx2d(c)
  g.scale(LAYER_RES, LAYER_RES)
  g.translate(-LAYER_X0, -LAYER_Y0)
  const n = noise1(seed * 13 + idx * 101)
  const n2 = noise1(seed * 7 + idx * 31)
  // a handful of distinct peaks plus fractal roughness
  const peaks: Array<{ x: number; h: number; w: number }> = []
  const count = 5 + Math.floor(r() * 4)
  for (let i = 0; i < count; i++) {
    peaks.push({ x: LAYER_X0 + r() * LAYER_W, h: o.peak * (0.45 + r() * 0.55), w: 90 + r() * 160 })
  }
  const step = 1 / LAYER_RES
  const heights: number[] = []
  for (let x = LAYER_X0; x <= LAYER_X0 + LAYER_W; x += step) {
    let h = o.peak * 0.18 + n(x / 140) * o.peak * 0.12
    for (const p of peaks) {
      const d = Math.abs(x - p.x) / p.w
      if (d < 1) h = Math.max(h, p.h * (1 - d) ** 1.25)
    }
    h += Math.abs(n2(x / 18)) * o.peak * 0.09 + n2(x / 5) * 1.5
    heights.push(h)
  }
  const grad = g.createLinearGradient(0, HORIZON - o.peak, 0, HORIZON + 4)
  grad.addColorStop(0, o.top)
  grad.addColorStop(1, o.base)
  g.fillStyle = grad
  g.beginPath()
  g.moveTo(LAYER_X0, HORIZON + 6)
  heights.forEach((h, i) => g.lineTo(LAYER_X0 + i * step, HORIZON - h))
  g.lineTo(LAYER_X0 + LAYER_W, HORIZON + 6)
  g.closePath()
  g.fill()
  // moonlit faces: lighten slopes that face the moon (upper right), darken the others
  g.save()
  g.clip()
  for (let i = 1; i < heights.length; i++) {
    const slope = heights[i]! - heights[i - 1]!
    const x = LAYER_X0 + i * step
    const top = HORIZON - heights[i]!
    if (slope < -0.05) {
      g.fillStyle = `rgba(150,190,235,${Math.min(0.12, -slope * 0.08)})`
      g.fillRect(x, top, step + 0.1, heights[i]! * 0.7)
    } else if (slope > 0.05) {
      g.fillStyle = `rgba(4,8,16,${Math.min(0.25, slope * 0.12)})`
      g.fillRect(x, top, step + 0.1, heights[i]!)
    }
  }
  // mist rising from the base
  const mg = g.createLinearGradient(0, HORIZON - o.peak * 0.55, 0, HORIZON + 6)
  mg.addColorStop(0, "rgba(90,140,190,0)")
  mg.addColorStop(1, `rgba(90,140,190,${o.mist})`)
  g.fillStyle = mg
  g.fillRect(LAYER_X0, HORIZON - o.peak, LAYER_W, o.peak + 10)
  g.restore()
  // faint rim along the ridge line
  g.strokeStyle = "rgba(150,200,255,0.10)"
  g.lineWidth = 0.7
  g.beginPath()
  heights.forEach((h, i) => (i === 0 ? g.moveTo(LAYER_X0, HORIZON - h) : g.lineTo(LAYER_X0 + i * step, HORIZON - h)))
  g.stroke()
  if (o.pines > 0) {
    g.fillStyle = o.base
    for (let i = 0; i < heights.length; i += Math.round(3 * LAYER_RES)) {
      const h = heights[i]!
      if (h > o.peak * 0.5 || r() > o.pines) continue
      const x = LAYER_X0 + i * step
      pinePath(g, x, HORIZON - h + 2, 5 + r() * 7)
      g.fill()
    }
  }
  // drifting mist bands
  const ms = smokeSprite("#7fa9d6")
  for (let i = 0; i < 30; i++) {
    const x = LAYER_X0 + r() * LAYER_W
    const y = HORIZON - r() * o.peak * 0.5
    const w = 120 + r() * 200
    g.globalAlpha = 0.25 + r() * 0.3
    g.drawImage(ms, x - w / 2, y - 10, w, 22)
  }
  g.globalAlpha = 1
  return c
}

function shoreLayer(r: Rand): HTMLCanvasElement {
  const c = makeCanvas(LAYER_W * LAYER_RES, LAYER_H * LAYER_RES)
  const g = ctx2d(c)
  g.scale(LAYER_RES, LAYER_RES)
  g.translate(-LAYER_X0, -LAYER_Y0)
  // forested shore spits leaving open water in between
  const spits = 4 + Math.floor(r() * 3)
  for (let s = 0; s < spits; s++) {
    const cx = LAYER_X0 + ((s + 0.2 + r() * 0.6) / spits) * LAYER_W
    const w = 90 + r() * 170
    const base = HORIZON + 6 + r() * 14
    g.fillStyle = "#0a131d"
    g.beginPath()
    g.moveTo(cx - w / 2 - 20, base + 2)
    g.quadraticCurveTo(cx, base - 10 - r() * 10, cx + w / 2 + 20, base + 2)
    g.closePath()
    g.fill()
    for (let x = cx - w / 2; x < cx + w / 2; x += 2 + r() * 4) {
      const e = 1 - Math.abs(x - cx) / (w / 2)
      const h = (6 + r() * 12) * (0.4 + e * 0.8)
      g.fillStyle = r() < 0.5 ? "#0a131d" : "#0c1622"
      pinePath(g, x, base - e * 6, h)
      g.fill()
    }
    // a few ruined towers like the plate
    if (r() < 0.3) {
      const tx = cx + (r() - 0.5) * w * 0.5
      g.fillStyle = "#0a131d"
      g.fillRect(tx, base - 26, 6, 26)
      g.fillRect(tx - 6, base - 15, 18, 15)
      g.fillRect(tx + 1, base - 30, 2, 4)
    }
  }
  const ms = smokeSprite("#6d95c2")
  for (let i = 0; i < 26; i++) {
    const x = LAYER_X0 + r() * LAYER_W
    const y = HORIZON + 4 + r() * 18
    const w = 160 + r() * 260
    g.globalAlpha = 0.25 + r() * 0.25
    g.drawImage(ms, x - w / 2, y - 9, w, 18)
  }
  g.globalAlpha = 1
  return c
}
