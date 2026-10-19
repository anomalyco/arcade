// Canvas drawing for the map sheets, in millimetres on the sheet. Worker-safe (OffscreenCanvas only, no DOM).
// Techniques follow the set-dressing documents (scripts/documents/render.ts): per-word ballpoint wobble, rubber stamps
// with dropouts, toner speckle and grain, so the map reads as the same paperwork as the rest of the station.

export type Ctx = OffscreenCanvasRenderingContext2D
export const PT = 0.3528 // mm per point
export const INK = {
  toner: "#18181a",
  blueline: "#2d3a86",
  ballBlue: "#1f3384",
  ballBlack: "#1c1a20",
  red: "#a3241c",
  pencil: "#55565a",
  stamp: "#7a2a6e",
  stampRed: "#a8302a",
}
/** Fill "colour" that knocks the area back to bare paper (originals are ink on transparent). */
export const PAPER = "paper"
export const FONT = { hand: "Caveat Map", letter: "Franklin Map", title: "Oswald Map", stamp: "Archivo Map" }

/** Seeded random stream (Park–Miller), so a page always draws the same. */
export function rng(seed: number) {
  let s = Math.max(1, Math.floor(seed) % 2147483647)
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  return { r, rr: (a: number, b: number) => a + (b - a) * r() }
}

export function canvas(w: number, h: number) {
  const c = new OffscreenCanvas(w, h)
  return { c, g: c.getContext("2d")! }
}

/** A sheet in mm: `ctx` is pre-scaled so 1 unit = 1 mm. */
export class Sheet {
  readonly r: () => number
  readonly rr: (a: number, b: number) => number
  constructor(
    readonly g: Ctx,
    readonly mm: number,
    readonly wmm: number,
    readonly hmm: number,
    seed: number,
  ) {
    const q = rng(seed)
    this.r = q.r
    this.rr = q.rr
    g.setTransform(mm, 0, 0, mm, 0, 0)
    g.textBaseline = "alphabetic"
    g.lineCap = "butt"
    g.lineJoin = "miter"
  }
  font(f: string, pt: number, weight = 400) {
    this.g.font = `${weight} ${pt * PT}px "${f}"`
  }
  line(x0: number, y0: number, x1: number, y1: number, w = 0.18, color = INK.toner, dash?: number[]) {
    const g = this.g
    g.save()
    g.strokeStyle = color
    g.lineWidth = w
    if (dash) g.setLineDash(dash)
    g.beginPath()
    g.moveTo(x0, y0)
    g.lineTo(x1, y1)
    g.stroke()
    g.restore()
  }
  poly(pts: readonly (readonly [number, number])[], w = 0.18, color = INK.toner, o: { close?: boolean; dash?: number[]; fill?: string } = {}) {
    const g = this.g
    if (pts.length < 2) return
    g.save()
    g.beginPath()
    g.moveTo(pts[0]![0], pts[0]![1])
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i]![0], pts[i]![1])
    if (o.close) g.closePath()
    if (o.fill) {
      g.fillStyle = o.fill
      g.fill()
    }
    if (w > 0) {
      g.strokeStyle = color
      g.lineWidth = w
      if (o.dash) g.setLineDash(o.dash)
      g.stroke()
    }
    g.restore()
  }
  rect(x: number, y: number, w: number, h: number, lw = 0.18, color = INK.toner, fill?: string, dash?: number[]) {
    const g = this.g
    g.save()
    if (fill === PAPER) g.clearRect(x, y, w, h)
    else if (fill) {
      g.fillStyle = fill
      g.fillRect(x, y, w, h)
    }
    if (lw > 0) {
      g.strokeStyle = color
      g.lineWidth = lw
      if (dash) g.setLineDash(dash)
      g.strokeRect(x, y, w, h)
    }
    g.restore()
  }
  fill(x: number, y: number, w: number, h: number, color = INK.toner) {
    if (color === PAPER) return this.g.clearRect(x, y, w, h)
    this.g.fillStyle = color
    this.g.fillRect(x, y, w, h)
  }
  circle(x: number, y: number, r: number, lw = 0.18, color = INK.toner, fill?: string, dash?: number[]) {
    const g = this.g
    g.save()
    g.beginPath()
    g.arc(x, y, r, 0, Math.PI * 2)
    if (fill) {
      g.save()
      if (fill === PAPER) g.globalCompositeOperation = "destination-out"
      g.fillStyle = fill === PAPER ? "#000" : fill
      g.fill()
      g.restore()
    }
    if (lw > 0) {
      g.strokeStyle = color
      g.lineWidth = lw
      if (dash) g.setLineDash(dash)
      g.stroke()
    }
    g.restore()
  }
  arc(x: number, y: number, r: number, a0: number, a1: number, lw = 0.12, color = INK.toner, ccw = false) {
    const g = this.g
    g.save()
    g.strokeStyle = color
    g.lineWidth = lw
    g.beginPath()
    g.arc(x, y, r, a0, a1, ccw)
    g.stroke()
    g.restore()
  }
  /** Diagonal hatching clipped to a rectangle. */
  hatch(x: number, y: number, w: number, h: number, step = 0.8, lw = 0.1, color = INK.toner) {
    const g = this.g
    g.save()
    g.beginPath()
    g.rect(x, y, w, h)
    g.clip()
    g.strokeStyle = color
    g.lineWidth = lw
    g.beginPath()
    for (let t = -h; t < w; t += step) {
      g.moveTo(x + t, y + h)
      g.lineTo(x + t + h, y)
    }
    g.stroke()
    g.restore()
  }
  /** Lettering (template / typeset). */
  text(s: string, x: number, y: number, o: { pt?: number; font?: string; weight?: number; color?: string; align?: CanvasTextAlign; spacing?: number; rot?: number; alpha?: number } = {}) {
    const g = this.g
    g.save()
    this.font(o.font ?? FONT.letter, o.pt ?? 6, o.weight ?? 500)
    g.fillStyle = o.color ?? INK.toner
    g.globalAlpha = o.alpha ?? 1
    g.textAlign = o.align ?? "left"
    if (o.spacing) (g as Ctx & { letterSpacing: string }).letterSpacing = `${o.spacing}px`
    if (o.rot) {
      g.translate(x, y)
      g.rotate(o.rot)
      g.fillText(s, 0, 0)
    } else g.fillText(s, x, y)
    g.restore()
  }
  width(s: string, pt: number, font: string = FONT.letter, weight = 500) {
    this.font(font, pt, weight)
    return this.g.measureText(s).width
  }
  /** Wraps words to a width in mm. */
  wrap(s: string, maxW: number, pt: number, font: string = FONT.letter, weight = 500) {
    this.font(font, pt, weight)
    const out: string[] = []
    let line = ""
    for (const w of s.split(" ")) {
      const next = line ? `${line} ${w}` : w
      if (line && this.g.measureText(next).width > maxW) {
        out.push(line)
        line = w
      } else line = next
    }
    if (line) out.push(line)
    return out
  }
  /** Ballpoint handwriting: per-word wobble and drift, pressure variation. Returns the end x. */
  hand(s: string, x: number, y: number, o: { pt?: number; color?: string; slant?: number; drift?: number; weight?: number } = {}) {
    const g = this.g
    const pt = o.pt ?? 13
    g.save()
    this.font(FONT.hand, pt, o.weight ?? 640)
    g.fillStyle = o.color ?? INK.ballBlue
    let cx = x
    let cy = y
    const rot = o.slant ?? 0
    for (const w of s.split(" ")) {
      g.save()
      g.translate(cx, cy + this.rr(-0.2, 0.2))
      g.rotate(rot + this.rr(-0.025, 0.025))
      g.globalAlpha = this.rr(0.82, 0.97)
      g.fillText(w, 0, 0)
      g.restore()
      const adv = g.measureText(`${w} `).width * this.rr(0.98, 1.04)
      cx += adv * Math.cos(rot)
      cy += adv * Math.sin(rot) + (o.drift ?? 0) * adv
    }
    g.restore()
    return cx
  }
  /** A wobbly freehand stroke through points. */
  scribble(pts: readonly (readonly [number, number])[], w = 0.32, color = INK.ballBlue, jitter = 0.25) {
    const g = this.g
    g.save()
    g.strokeStyle = color
    g.lineWidth = w
    g.lineCap = "round"
    g.lineJoin = "round"
    g.globalAlpha = 0.88
    g.beginPath()
    pts.forEach(([px, py], i) => {
      const jx = px + this.rr(-jitter, jitter)
      const jy = py + this.rr(-jitter, jitter)
      i ? g.lineTo(jx, jy) : g.moveTo(jx, jy)
    })
    g.stroke()
    g.restore()
  }
  /** Freehand ring around something (overshoots its start, like a real pen loop). */
  ring(x: number, y: number, rx: number, ry: number, color = INK.ballBlue, w = 0.35) {
    const pts: [number, number][] = []
    const a0 = this.rr(0, Math.PI * 2)
    const turns = this.rr(1.08, 1.2)
    const n = 48
    for (let i = 0; i <= n; i++) {
      const t = a0 + (i / n) * Math.PI * 2 * turns
      const k = 1 + 0.05 * Math.sin(t * 3 + a0) + (i / n) * 0.06
      pts.push([x + Math.cos(t) * rx * k, y + Math.sin(t) * ry * k])
    }
    this.scribble(pts, w, color, 0.12)
  }
  /** Freehand arrow from (x0,y0) to (x1,y1), slightly bowed. */
  arrow(x0: number, y0: number, x1: number, y1: number, color = INK.ballBlue, bow = 0.12, w = 0.32) {
    const mx = (x0 + x1) / 2 - (y1 - y0) * bow
    const my = (y0 + y1) / 2 + (x1 - x0) * bow
    const pts: [number, number][] = []
    for (let i = 0; i <= 16; i++) {
      const t = i / 16
      pts.push([(1 - t) ** 2 * x0 + 2 * (1 - t) * t * mx + t * t * x1, (1 - t) ** 2 * y0 + 2 * (1 - t) * t * my + t * t * y1])
    }
    this.scribble(pts, w, color, 0.08)
    const [px, py] = pts[14]!
    const a = Math.atan2(y1 - py, x1 - px)
    const L = 2.4
    this.scribble([[x1 - Math.cos(a - 0.45) * L, y1 - Math.sin(a - 0.45) * L], [x1, y1], [x1 - Math.cos(a + 0.45) * L, y1 - Math.sin(a + 0.45) * L]], w, color, 0.05)
  }
  /** Rubber stamp: double-ruled box, uneven inking with dropouts. */
  stamp(lines: string[], x: number, y: number, rot: number, color = INK.stamp, pt = 9, alpha = 0.8) {
    const g = this.g
    const s = this.mm
    this.font(FONT.stamp, pt)
    const tw = Math.max(...lines.map((l) => g.measureText(l).width)) + 5
    const lh = pt * PT * 1.22
    const th = lines.length * lh + 3.4
    const off = new OffscreenCanvas(Math.ceil(tw * s), Math.ceil(th * s))
    const o = off.getContext("2d")!
    o.scale(s, s)
    o.strokeStyle = o.fillStyle = color
    o.lineWidth = 0.55
    o.strokeRect(0.5, 0.5, tw - 1, th - 1)
    o.lineWidth = 0.22
    o.strokeRect(1.3, 1.3, tw - 2.6, th - 2.6)
    o.font = `400 ${pt * PT}px "${FONT.stamp}"`
    o.textAlign = "center"
    lines.forEach((l, i) => o.fillText(l, tw / 2, 1.9 + (i + 0.8) * lh))
    o.setTransform(1, 0, 0, 1, 0, 0)
    o.globalCompositeOperation = "destination-out"
    const gr = o.createLinearGradient(0, 0, off.width, off.height * 0.3)
    gr.addColorStop(0, "rgba(0,0,0,0)")
    gr.addColorStop(1, `rgba(0,0,0,${this.rr(0.25, 0.55)})`)
    o.fillStyle = gr
    o.fillRect(0, 0, off.width, off.height)
    const n = off.width * off.height * 0.03
    for (let i = 0; i < n; i++) {
      o.fillStyle = `rgba(0,0,0,${this.rr(0.3, 1)})`
      o.fillRect(this.r() * off.width, this.r() * off.height, this.rr(0.5, 2.4), this.rr(0.5, 2.4))
    }
    g.save()
    g.translate(x, y)
    g.rotate(rot)
    g.globalAlpha = alpha
    g.globalCompositeOperation = "multiply"
    g.drawImage(off, -tw / 2, -th / 2, tw, th)
    g.restore()
  }
}

/**
 * Prints an "original" (black linework on a transparent canvas) onto the paper the way a 1984 office copier or diazo
 * printer would: ink tinted, slightly skewed and offset, uneven density, a grey edge where the original's border fell,
 * toner speckle and a faint drum streak. `paper` is the destination (already filled with the paper colour).
 */
export function reproduce(dst: Ctx, src: OffscreenCanvas, o: { ink: string; skew: number; dx: number; dy: number; seed: number; copy: boolean; density?: number }) {
  const W = src.width
  const H = src.height
  const { r, rr } = rng(o.seed)
  const tint = new OffscreenCanvas(W, H)
  const t = tint.getContext("2d")!
  t.drawImage(src, 0, 0)
  // Uneven toner/ammonia density at a few cm scale (a small noise field stretched up), knocked out of the ink.
  const nw = 12
  const nh = 9
  const nc = new OffscreenCanvas(nw, nh)
  const ng = nc.getContext("2d")!
  const img = ng.createImageData(nw, nh)
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 0
    img.data[i + 3] = Math.floor(rr(0, 0.12) * 255 * (o.density ?? 1))
  }
  ng.putImageData(img, 0, 0)
  t.globalCompositeOperation = "destination-out"
  t.imageSmoothingEnabled = true
  t.drawImage(nc, 0, 0, W, H)
  t.globalCompositeOperation = "source-in"
  t.fillStyle = o.ink
  t.fillRect(0, 0, W, H)
  dst.save()
  dst.setTransform(1, 0, 0, 1, 0, 0)
  dst.translate(W / 2 + o.dx, H / 2 + o.dy)
  dst.rotate(o.skew)
  dst.translate(-W / 2, -H / 2)
  if (o.copy) {
    // The original's own edge picked up by the copier: a faint grey frame, darker on the side away from the light.
    dst.strokeStyle = "rgba(40,40,44,0.16)"
    dst.lineWidth = W * 0.0012
    dst.strokeRect(W * 0.006, H * 0.006, W * 0.988, H * 0.988)
    const gr = dst.createLinearGradient(0, 0, W * 0.025, 0)
    gr.addColorStop(0, "rgba(30,30,34,0.12)")
    gr.addColorStop(1, "rgba(30,30,34,0)")
    dst.fillStyle = gr
    dst.fillRect(W * 0.006, H * 0.006, W * 0.025, H * 0.988)
  }
  dst.globalCompositeOperation = "multiply"
  dst.drawImage(tint, 0, 0)
  dst.restore()
  // Toner speckle and the drum streak (copies), or ammonia blotches (diazo).
  dst.save()
  dst.setTransform(1, 0, 0, 1, 0, 0)
  dst.fillStyle = o.ink
  const n = Math.floor((W * H) / (o.copy ? 9000 : 20000))
  for (let i = 0; i < n; i++) {
    dst.globalAlpha = rr(0.15, 0.7)
    const s = rr(0.6, 2.2)
    dst.fillRect(r() * W, r() * H, s, s * rr(0.6, 1.4))
  }
  if (o.copy) {
    const sx = rr(0.2, 0.8) * W
    dst.globalAlpha = 0.05
    dst.fillRect(sx, 0, W * 0.0015, H)
  }
  dst.restore()
}

/** Paper fibre and grain over the finished page, plus a little edge yellowing. */
export function grain(g: Ctx, seed: number, amount = 9, warm = 0.18) {
  const W = g.canvas.width
  const H = g.canvas.height
  const { r, rr } = rng(seed)
  g.save()
  g.setTransform(1, 0, 0, 1, 0, 0)
  // Soft fibre clouds at ~2 mm.
  const gw = 140
  const gh = 108
  const fc = new OffscreenCanvas(gw, gh)
  const fg = fc.getContext("2d")!
  const fi = fg.createImageData(gw, gh)
  for (let i = 0; i < fi.data.length; i += 4) {
    const v = 255 - r() * 14
    fi.data[i] = fi.data[i + 1] = v
    fi.data[i + 2] = v - 2
    fi.data[i + 3] = 255
  }
  fg.putImageData(fi, 0, 0)
  g.globalCompositeOperation = "multiply"
  g.imageSmoothingEnabled = true
  g.drawImage(fc, 0, 0, W, H)
  const vg = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) * 0.6)
  vg.addColorStop(0, "rgba(255,255,255,1)")
  vg.addColorStop(1, `rgba(${235},${222},${196},1)`)
  g.globalAlpha = warm
  g.fillStyle = vg
  g.fillRect(0, 0, W, H)
  g.restore()
  const img = g.getImageData(0, 0, W, H)
  const a = img.data
  for (let i = 0; i < a.length; i += 4) {
    const n = (r() - 0.5) * amount
    a[i] = a[i]! + n
    a[i + 1] = a[i + 1]! + n
    a[i + 2] = a[i + 2]! + n * 0.95
  }
  void rr
  g.putImageData(img, 0, 0)
}
