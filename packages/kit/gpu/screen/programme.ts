import type { ScreenSource } from "./display"

/**
 * Something to put on a screen when a game has nothing of its own yet: colour bars, a test card, flat fields, or
 * `show`, a loop of short programme shots cut hard into one another (a sunset, the sea, a studio, a storm, a forest, a
 * cartoon, bars), each a different colour and brightness, so a room lit by the screen visibly follows the picture.
 * Painted on a 2D canvas at standard-definition size; deterministic in time.
 */
export type ProgrammeKind = "show" | "bars" | "card" | "white" | "black"

export const PROGRAMME_OPTIONS: readonly { value: ProgrammeKind; label: string }[] = [
  { value: "show", label: "Programme (scene cuts)" },
  { value: "bars", label: "Colour bars" },
  { value: "card", label: "Test card" },
  { value: "white", label: "White field" },
  { value: "black", label: "Black" },
]

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
const SHOTS: readonly { length: number; paint: (g: Ctx, w: number, h: number, t: number) => void }[] = [
  { length: 4, paint: sunset },
  { length: 3.5, paint: sea },
  { length: 4, paint: studio },
  { length: 2.6, paint: storm },
  { length: 3.5, paint: forest },
  { length: 3, paint: cartoon },
  { length: 2, paint: (g, w, h) => bars(g, w, h) },
]
const LOOP = SHOTS.reduce((s, x) => s + x.length, 0)

export class ScreenProgramme {
  kind: ProgrammeKind
  readonly width: number
  readonly height: number
  private readonly canvas: OffscreenCanvas | HTMLCanvasElement
  private readonly g: Ctx
  private painted = ""

  constructor(kind: ProgrammeKind = "show", width = 480, height = 360) {
    this.kind = kind
    this.width = width
    this.height = height
    if (typeof OffscreenCanvas !== "undefined") this.canvas = new OffscreenCanvas(width, height)
    else {
      const c = document.createElement("canvas")
      c.width = width; c.height = height
      this.canvas = c
    }
    this.g = this.canvas.getContext("2d") as Ctx
  }

  /** The canvas as a screen source; repaint it with `paint(time)` each frame before the display updates. */
  get source(): ScreenSource {
    return { image: this.canvas, width: this.width, height: this.height }
  }

  /** Which shot of the programme loop is on at `time`, and how far into it. */
  static shotAt(time: number): { index: number; t: number } {
    let t = ((time % LOOP) + LOOP) % LOOP
    for (let i = 0; i < SHOTS.length; i++) {
      if (t < SHOTS[i]!.length) return { index: i, t }
      t -= SHOTS[i]!.length
    }
    return { index: 0, t: 0 }
  }

  /** Repaints for `time` (s). Still pictures paint once. */
  paint(time: number): void {
    const { g, width: w, height: h } = this
    const kind = this.kind
    if (kind !== "show" && this.painted === kind) return
    this.painted = kind
    g.save()
    if (kind === "white") { g.fillStyle = "#ebebeb"; g.fillRect(0, 0, w, h) }
    else if (kind === "black") { g.fillStyle = "#000"; g.fillRect(0, 0, w, h) }
    else if (kind === "bars") bars(g, w, h)
    else if (kind === "card") card(g, w, h)
    else {
      const { index, t } = ScreenProgramme.shotAt(time)
      SHOTS[index]!.paint(g, w, h, t)
    }
    g.restore()
  }
}

function bars(g: Ctx, w: number, h: number) {
  const top = ["#c0c0c0", "#c0c000", "#00c0c0", "#00c000", "#c000c0", "#c00000", "#0000c0"]
  const mid = ["#0000c0", "#131313", "#c000c0", "#131313", "#00c0c0", "#131313", "#c0c0c0"]
  const bw = w / 7
  for (let i = 0; i < 7; i++) {
    g.fillStyle = top[i]!; g.fillRect(i * bw, 0, bw + 1, h * 0.67)
    g.fillStyle = mid[i]!; g.fillRect(i * bw, h * 0.67, bw + 1, h * 0.08)
  }
  const low = ["#00214c", "#ffffff", "#32006a", "#131313", "#090909", "#131313", "#1d1d1d", "#131313"]
  const lw = [1.25, 1.25, 1.25, 1.25, 0.33, 0.34, 0.33, 1]
  let x = 0
  for (let i = 0; i < low.length; i++) {
    const ww = (lw[i]! / 7) * w
    g.fillStyle = low[i]!; g.fillRect(x, h * 0.75, ww + 1, h * 0.25)
    x += ww
  }
}

function card(g: Ctx, w: number, h: number) {
  g.fillStyle = "#6e6e6e"; g.fillRect(0, 0, w, h)
  g.strokeStyle = "#e8e8e8"; g.lineWidth = 1.5
  for (let x = w / 2 % 30; x < w; x += 30) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke() }
  for (let y = h / 2 % 30; y < h; y += 30) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke() }
  const r = h * 0.42
  g.fillStyle = "#1c1c1c"; g.beginPath(); g.arc(w / 2, h / 2, r, 0, Math.PI * 2); g.fill()
  // Grey steps, colour bars, frequency gratings and a white cross through the circle.
  for (let i = 0; i < 6; i++) { g.fillStyle = `rgb(${i * 51},${i * 51},${i * 51})`; g.fillRect(w / 2 - r * 0.8 + i * r * 0.267, h / 2 - r * 0.62, r * 0.267, r * 0.3) }
  const cols = ["#c0c000", "#00c0c0", "#00c000", "#c000c0", "#c00000", "#0000c0"]
  for (let i = 0; i < 6; i++) { g.fillStyle = cols[i]!; g.fillRect(w / 2 - r * 0.8 + i * r * 0.267, h / 2 - r * 0.3, r * 0.267, r * 0.28) }
  for (let k = 0; k < 4; k++) {
    const pitch = [6, 4, 3, 2][k]!
    for (let x = 0; x < r * 0.38; x += pitch) { g.fillStyle = (x / pitch) % 2 < 1 ? "#f0f0f0" : "#101010"; g.fillRect(w / 2 - r * 0.8 + k * r * 0.4 + x, h / 2 + 0.04 * r, pitch / 2, r * 0.3) }
  }
  g.fillStyle = "#f0f0f0"
  g.fillRect(w / 2 - r * 0.8, h / 2 + r * 0.4, r * 1.6, 2)
  g.fillRect(w / 2 - 1, h / 2 + r * 0.38, 2, r * 0.3)
  g.strokeStyle = "#f0f0f0"; g.lineWidth = 2; g.beginPath(); g.arc(w / 2, h / 2, r, 0, Math.PI * 2); g.stroke()
}

function sunset(g: Ctx, w: number, h: number, t: number) {
  const sky = g.createLinearGradient(0, 0, 0, h)
  sky.addColorStop(0, "#2b1d4a"); sky.addColorStop(0.45, "#c2483a"); sky.addColorStop(0.7, "#f5a742"); sky.addColorStop(1, "#ffd27a")
  g.fillStyle = sky; g.fillRect(0, 0, w, h)
  const sy = h * (0.5 + t * 0.03)
  g.fillStyle = "#fff0b0"; g.beginPath(); g.arc(w * 0.6, sy, h * 0.11, 0, Math.PI * 2); g.fill()
  g.fillStyle = "#1a0f14"
  g.beginPath(); g.moveTo(0, h)
  for (let x = 0; x <= w; x += 8) g.lineTo(x, h * 0.72 + Math.sin(x * 0.02 + 1) * h * 0.05 + Math.sin(x * 0.05) * h * 0.02)
  g.lineTo(w, h); g.fill()
  // A bird crossing.
  const bx = (t / 4) * w * 1.2 - w * 0.1, by = h * 0.3 + Math.sin(t * 3) * 6
  g.strokeStyle = "#1a0f14"; g.lineWidth = 2; g.beginPath(); g.moveTo(bx - 8, by - 3); g.lineTo(bx, by + 2); g.lineTo(bx + 8, by - 3); g.stroke()
}

function sea(g: Ctx, w: number, h: number, t: number) {
  const water = g.createLinearGradient(0, 0, 0, h)
  water.addColorStop(0, "#1f6fa8"); water.addColorStop(1, "#04182f")
  g.fillStyle = water; g.fillRect(0, 0, w, h)
  g.globalAlpha = 0.25
  for (let i = 0; i < 9; i++) {
    g.fillStyle = "#9fe3ff"
    const y = ((i * 41 + t * 30) % (h + 40)) - 20
    g.beginPath()
    for (let x = 0; x <= w; x += 12) g.lineTo(x, y + Math.sin(x * 0.04 + t * 2 + i) * 6)
    g.lineTo(w, y + 5); g.lineTo(0, y + 5); g.fill()
  }
  g.globalAlpha = 1
  // A fish.
  const fx = w * 0.15 + t * w * 0.2, fy = h * 0.6 + Math.sin(t * 2) * 10
  g.fillStyle = "#f2b23a"; g.beginPath(); g.ellipse(fx, fy, 22, 9, 0, 0, Math.PI * 2); g.fill()
  g.beginPath(); g.moveTo(fx - 20, fy); g.lineTo(fx - 34, fy - 10); g.lineTo(fx - 34, fy + 10); g.fill()
}

function studio(g: Ctx, w: number, h: number, t: number) {
  const back = g.createRadialGradient(w * 0.5, h * 0.4, 10, w * 0.5, h * 0.5, w * 0.7)
  back.addColorStop(0, "#3a4f7a"); back.addColorStop(1, "#0c1222")
  g.fillStyle = back; g.fillRect(0, 0, w, h)
  // A presenter: shoulders and a head under a warm key light, nodding a little.
  const cx = w * 0.42, nod = Math.sin(t * 2.2) * 2
  g.fillStyle = "#2a2f3a"; g.beginPath(); g.ellipse(cx, h * 0.98, w * 0.22, h * 0.3, 0, Math.PI, 0); g.fill()
  g.fillStyle = "#d9a283"; g.beginPath(); g.ellipse(cx, h * 0.45 + nod, w * 0.07, h * 0.13, 0, 0, Math.PI * 2); g.fill()
  g.fillStyle = "#3a2618"; g.beginPath(); g.ellipse(cx, h * 0.37 + nod, w * 0.075, h * 0.07, 0, Math.PI, 0); g.fill()
  // A desk and a lower-third bar.
  g.fillStyle = "#1b2a4a"; g.fillRect(0, h * 0.78, w, h * 0.22)
  g.fillStyle = "#e9e6dc"; g.fillRect(w * 0.06, h * 0.82, w * 0.5, h * 0.06)
  g.fillStyle = "#b8332a"; g.fillRect(w * 0.06, h * 0.88, w * 0.32, h * 0.04)
  g.fillStyle = "#c9a227"; g.fillRect(w * 0.7, h * 0.12, w * 0.2, h * 0.2)
}

function storm(g: Ctx, w: number, h: number, t: number) {
  // Flashes at fixed beats, each with a short afterglow, over a dark wet street.
  const beats = [0.25, 0.4, 1.3, 2.05]
  let flash = 0
  for (const b of beats) if (t >= b) flash = Math.max(flash, Math.exp(-(t - b) / 0.09))
  const v = Math.round(18 + flash * 220)
  g.fillStyle = `rgb(${v},${v},${Math.min(255, v + 18)})`; g.fillRect(0, 0, w, h)
  g.fillStyle = flash > 0.3 ? "#0a0a10" : "#05050a"
  g.fillRect(w * 0.1, h * 0.35, w * 0.18, h * 0.65); g.fillRect(w * 0.62, h * 0.25, w * 0.24, h * 0.75)
  if (flash > 0.4) {
    g.strokeStyle = "#ffffff"; g.lineWidth = 3; g.beginPath()
    let x = w * 0.45, y = 0
    g.moveTo(x, y)
    for (let i = 0; i < 8; i++) { x += ((i * 37) % 7 - 3) * 6; y += h * 0.06; g.lineTo(x, y) }
    g.stroke()
  }
}

function forest(g: Ctx, w: number, h: number, t: number) {
  const sky = g.createLinearGradient(0, 0, 0, h)
  sky.addColorStop(0, "#a9d47a"); sky.addColorStop(1, "#1f3a17")
  g.fillStyle = sky; g.fillRect(0, 0, w, h)
  // Trunks panning past at two depths.
  for (const [speed, width, col] of [[30, 14, "#3f5a2a"], [70, 28, "#2a2015"]] as const) {
    for (let i = 0; i < 8; i++) {
      const x = ((i * 97 + t * speed) % (w + 60)) - 30
      g.fillStyle = col; g.fillRect(x, 0, width + (i % 3) * 4, h)
    }
  }
  g.fillStyle = "#4e7d2c"; g.fillRect(0, h * 0.86, w, h * 0.14)
}

function cartoon(g: Ctx, w: number, h: number, t: number) {
  g.fillStyle = "#ffd400"; g.fillRect(0, 0, w, h)
  g.fillStyle = "#ff3b8b"; g.fillRect(0, h * 0.75, w, h * 0.25)
  // A ball bouncing across: fast motion, so the afterglow shows a trail.
  const x = ((t * 0.45) % 1) * (w + 80) - 40
  const y = h * 0.75 - Math.abs(Math.sin(t * 5)) * h * 0.5 - 24
  g.fillStyle = "#1460ff"; g.beginPath(); g.arc(x, y, 24, 0, Math.PI * 2); g.fill()
  g.fillStyle = "#ffffff"; g.beginPath(); g.arc(x - 8, y - 8, 7, 0, Math.PI * 2); g.fill()
}
