import { FEEDBACK } from "./settings"

/** A crack in the glass: where (0..1 of the view), how big (0..1) and its seed. A chip is a small star, a web a spiderweb. */
type Crack = { x: number; y: number; size: number; seed: number; web: boolean }

/** At most this many cracks on the glass (older chips go first). */
const MAX_CRACKS = 14
/** Oil canvas resolution (fraction of the CSS size: it is soft anyway) and redraw rate. */
const OIL_SCALE = 0.5
const OIL_EVERY = 1 / 30

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 4294967296
  }
}

/**
 * The canopy glass in the cockpit view, screen space over the scene: cracks that accumulate with the hits taken this
 * sortie (gun hits chip it, heavy hits spiderweb it), and once health falls below `FEEDBACK.oilBelow` oil and hydraulic
 * fluid streaking up and over the glass in the airflow, thicker as it falls (it never wipes clean until the next
 * sortie). Two 2D canvases: the cracks redraw only when one is added or the view resizes, the oil at 30 Hz while it shows.
 */
export class Canopy {
  private cracksCanvas: HTMLCanvasElement
  private oilCanvas: HTMLCanvasElement
  private cg: CanvasRenderingContext2D | null
  private og: CanvasRenderingContext2D | null
  private cracks: Crack[] = []
  private dirty = true
  private w = 0
  private h = 0
  private oil = 0
  private oilTime = 0
  private oilIn = 0
  private shown = false
  private seed = 1

  constructor(parent: HTMLElement) {
    this.cracksCanvas = document.createElement("canvas")
    this.oilCanvas = document.createElement("canvas")
    this.cracksCanvas.hidden = this.oilCanvas.hidden = true
    parent.prepend(this.cracksCanvas)
    parent.prepend(this.oilCanvas)
    this.cg = this.cracksCanvas.getContext("2d")
    this.og = this.oilCanvas.getContext("2d")
  }

  /** A new sortie: clean glass. */
  clear(): void {
    this.cracks.length = 0
    this.oil = 0
    this.dirty = true
  }

  /** A hit on our jet for `amount` health: a chip, or a web for a heavy one (bigger with the damage). */
  hit(amount: number): void {
    if (amount <= 0) return
    const r = rng(++this.seed * 2654435761)
    const web = amount >= 9
    const n = web ? 1 : Math.min(3, Math.ceil(amount / 3))
    for (let i = 0; i < n; i++) {
      if (this.cracks.length >= MAX_CRACKS) {
        const chip = this.cracks.findIndex((c) => !c.web)
        this.cracks.splice(chip >= 0 ? chip : 0, 1)
      }
      this.cracks.push({ x: 0.1 + r() * 0.8, y: 0.06 + r() * 0.5, size: web ? Math.min(1, 0.45 + amount / 70) : 0.12 + r() * 0.12, seed: (r() * 4294967296) >>> 0, web })
    }
    this.dirty = true
  }

  get count(): number {
    return this.cracks.length
  }

  /** Per frame: `on` while the cockpit view shows; `hp` our jet's health. */
  update(dt: number, on: boolean, hp: number): void {
    const show = on && FEEDBACK.cracks
    const below = FEEDBACK.oilBelow
    if (below > 0 && hp < below) this.oil = Math.max(this.oil, Math.min(1, (below - hp) / below + 0.15))
    const cracks = show && this.cracks.length > 0
    const oil = show && this.oil > 0
    this.cracksCanvas.hidden = !cracks
    this.oilCanvas.hidden = !oil
    if (!show) {
      this.shown = false
      return
    }
    const dpr = Math.min(1.5, devicePixelRatio || 1)
    const w = Math.round(innerWidth * dpr)
    const h = Math.round(innerHeight * dpr)
    if (w !== this.w || h !== this.h) {
      this.w = w
      this.h = h
      this.cracksCanvas.width = w
      this.cracksCanvas.height = h
      this.oilCanvas.width = Math.round(w * OIL_SCALE)
      this.oilCanvas.height = Math.round(h * OIL_SCALE)
      this.dirty = true
    }
    this.cracksCanvas.style.opacity = FEEDBACK.crackOpacity.toFixed(2)
    if (cracks && (this.dirty || !this.shown)) this.drawCracks(dpr)
    this.shown = true
    if (oil) {
      this.oilTime += dt
      this.oilIn -= dt
      if (this.oilIn <= 0) {
        this.oilIn = OIL_EVERY
        this.drawOil()
      }
    }
  }

  private drawCracks(dpr: number): void {
    this.dirty = false
    const g = this.cg
    if (!g) return
    const w = this.w
    const h = this.h
    g.clearRect(0, 0, w, h)
    const u = Math.min(w, h)
    g.lineCap = "round"
    g.lineJoin = "round"
    for (const c of this.cracks) {
      const r = rng(c.seed)
      const cx = c.x * w
      const cy = c.y * h
      const R = u * (c.web ? 0.09 + c.size * 0.13 : 0.02 + c.size * 0.05)
      const rays = c.web ? 9 + Math.floor(r() * 6) : 4 + Math.floor(r() * 3)
      // Each ray: a jagged polyline outward; remember its points to hang the rings on.
      const pts: [number, number][][] = []
      for (let i = 0; i < rays; i++) {
        let a = (i / rays) * Math.PI * 2 + (r() - 0.5) * 0.5
        const len = R * (0.55 + r() * 0.75)
        const steps = c.web ? 7 : 3
        const line: [number, number][] = [[cx, cy]]
        let x = cx
        let y = cy
        for (let s = 1; s <= steps; s++) {
          a += (r() - 0.5) * 0.35
          const d = (len / steps) * (0.7 + r() * 0.6)
          x += Math.cos(a) * d
          y += Math.sin(a) * d
          line.push([x, y])
        }
        pts.push(line)
      }
      const path = new Path2D()
      for (const line of pts) {
        path.moveTo(line[0]![0], line[0]![1])
        for (const p of line) path.lineTo(p[0], p[1])
        // A branch off the outer half now and then.
        if (c.web && r() < 0.45) {
          const p = line[3 + Math.floor(r() * 3)]!
          const a = Math.atan2(p[1] - cy, p[0] - cx) + (r() < 0.5 ? -1 : 1) * (0.4 + r() * 0.4)
          const d = R * (0.15 + r() * 0.25)
          path.moveTo(p[0], p[1])
          path.lineTo(p[0] + Math.cos(a) * d * 0.5 + (r() - 0.5) * 3, p[1] + Math.sin(a) * d * 0.5 + (r() - 0.5) * 3)
          path.lineTo(p[0] + Math.cos(a) * d, p[1] + Math.sin(a) * d)
        }
      }
      if (c.web)
        // Concentric rings: jagged chords between neighbouring rays, a few missing.
        for (const k of [1, 2, 4]) {
          for (let i = 0; i < rays; i++) {
            if (r() < 0.22) continue
            const a = pts[i]![Math.min(k + (r() < 0.3 ? 1 : 0), pts[i]!.length - 1)]!
            const b = pts[(i + 1) % rays]![Math.min(k, pts[(i + 1) % rays]!.length - 1)]!
            const mx = (a[0] + b[0]) / 2 + (cx - (a[0] + b[0]) / 2) * 0.08 + (r() - 0.5) * 2
            const my = (a[1] + b[1]) / 2 + (cy - (a[1] + b[1]) / 2) * 0.08 + (r() - 0.5) * 2
            path.moveTo(a[0], a[1])
            path.lineTo(mx, my)
            path.lineTo(b[0], b[1])
          }
        }
      // Refraction: a dark offset line under a bright one.
      g.save()
      g.translate(dpr, dpr)
      g.strokeStyle = "rgba(0, 8, 16, 0.45)"
      g.lineWidth = 1.6 * dpr
      g.stroke(path)
      g.restore()
      g.strokeStyle = "rgba(235, 244, 255, 0.85)"
      g.lineWidth = (c.web ? 1.1 : 0.9) * dpr
      g.stroke(path)
      // The frosted impact point.
      const fr = R * (c.web ? 0.12 : 0.18)
      const grad = g.createRadialGradient(cx, cy, 0, cx, cy, fr)
      grad.addColorStop(0, "rgba(240, 246, 255, 0.85)")
      grad.addColorStop(0.5, "rgba(220, 232, 245, 0.4)")
      grad.addColorStop(1, "rgba(220, 232, 245, 0)")
      g.fillStyle = grad
      g.beginPath()
      g.arc(cx, cy, fr, 0, Math.PI * 2)
      g.fill()
    }
  }

  private drawOil(): void {
    const g = this.og
    if (!g) return
    const w = this.oilCanvas.width
    const h = this.oilCanvas.height
    g.clearRect(0, 0, w, h)
    const k = this.oil
    const t = this.oilTime
    const r = rng(0x0115eed)
    const streaks = Math.round(4 + k * 10)
    const px = w / 640
    g.lineCap = "round"
    g.lineJoin = "round"
    g.filter = `blur(${(1.2 * px).toFixed(1)}px)`
    for (let i = 0; i < streaks; i++) {
      // Fluid from the nose (bottom centre), blown back over the canopy: it fans out and up, wavering in the airflow.
      const x0 = w * (0.5 + (r() - 0.5) * 0.5)
      const out = (x0 / w - 0.5) * 2 + (r() - 0.5) * 0.6
      const len = h * (0.3 + r() * 0.45) * (0.55 + 0.45 * k) * Math.min(1, t / (1.2 + r() * 2.5))
      const width = (3 + r() * 6) * (0.7 + k * 0.8) * px
      const phase = r() * 6.28
      const a = (0.1 + r() * 0.12) * (0.6 + k * 0.6)
      const path = new Path2D()
      const steps = 16
      const at = (u: number): [number, number] => {
        const wob = Math.sin(u * 5 + t * 1.6 + phase) * w * 0.005 * (0.5 + u * 2)
        return [x0 + out * u ** 1.5 * w * 0.4 + wob, h * 1.02 - u * len]
      }
      for (let s = 0; s <= steps; s++) {
        const [x, y] = at(s / steps)
        if (s === 0) path.moveTo(x, y)
        else path.lineTo(x, y)
      }
      const grad = g.createLinearGradient(0, h, 0, h - len)
      grad.addColorStop(0, `rgba(92, 60, 18, ${a.toFixed(3)})`)
      grad.addColorStop(0.6, `rgba(110, 76, 26, ${(a * 0.55).toFixed(3)})`)
      grad.addColorStop(1, "rgba(110, 76, 26, 0)")
      g.strokeStyle = grad
      // A wide faint smear under a narrower, darker run.
      g.globalAlpha = 0.45
      g.lineWidth = width * 3
      g.stroke(path)
      g.globalAlpha = 1
      g.lineWidth = width
      g.stroke(path)
      // Droplets running back along it.
      for (let d = 0; d < 2; d++) {
        const u = (t * (0.18 + r() * 0.25) + r()) % 1
        if (u * h > len) continue
        const [x, y] = at(u)
        g.fillStyle = `rgba(70, 44, 12, ${Math.min(0.4, a * 2.2).toFixed(3)})`
        g.beginPath()
        g.ellipse(x, y, width * 0.45, width * 1.3, -out * 0.5 * u, 0, Math.PI * 2)
        g.fill()
      }
    }
    g.filter = "none"
    // A thin amber film over the lower glass.
    const film = g.createLinearGradient(0, h, 0, h * 0.4)
    film.addColorStop(0, `rgba(80, 52, 14, ${(0.2 * k).toFixed(3)})`)
    film.addColorStop(1, "rgba(80, 52, 14, 0)")
    g.fillStyle = film
    g.fillRect(0, 0, w, h)
  }
}
