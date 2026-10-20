import type { Camera } from "@arcade/kit/client/camera"
import type { Rect } from "@arcade/kit/sim/geom"
import type { InteractTarget } from "../../shared/interact"
import type { Town } from "../../shared/map"
import { supportHeight } from "../../shared/terrain"

/** Height band (metres above the ground) the outline wraps, by target kind; anything else gets 0–1 m. */
const BANDS: Readonly<Record<string, readonly [number, number]>> = {
  door: [0, 2.1],
  window: [0.85, 2.0],
  fence: [0, 1.1],
  closet: [0, 2.0],
  drop: [0, 0.3],
  body: [0, 0.4],
  fallen: [0, 0.4],
  downed: [0, 0.5],
  page: [0.75, 0.95],
  vehicle: [0, 1.4],
  car: [0, 1.4],
  dog: [0, 0.6],
  tripwire: [0, 0.5],
}

export type ScreenBox = { x0: number; y0: number; x1: number; y1: number }

/** The screen box around a target's plan rect raised through its height band; null if any corner is off camera. */
export function targetScreenBox(cam: Camera, town: Town, target: Pick<InteractTarget, "kind" | "rect" | "worldX" | "worldY">, w: number, h: number): ScreenBox | null {
  const [h0, h1] = BANDS[target.kind] ?? [0, 1]
  const ground = supportHeight(town, target.worldX, target.worldY)
  const r: Rect = target.rect
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const px of [r[0], r[2]]) {
    for (const pz of [r[1], r[3]]) {
      for (const py of [h0, h1]) {
        const p = cam.project(px, ground + py, pz, w, h)
        if (!p.ok) return null
        x0 = Math.min(x0, p.x)
        y0 = Math.min(y0, p.y)
        x1 = Math.max(x1, p.x)
        y1 = Math.max(y1, p.y)
      }
    }
  }
  return { x0, y0, x1, y1 }
}

/** Corner-bracket path for a box: each arm a fraction of the shorter side, capped. */
export function bracketPath(b: ScreenBox, pad: number): string {
  const x0 = b.x0 - pad
  const y0 = b.y0 - pad
  const x1 = b.x1 + pad
  const y1 = b.y1 + pad
  const arm = Math.max(4, Math.min(12, Math.min(x1 - x0, y1 - y0) * 0.3))
  const f = (n: number) => n.toFixed(1)
  return [
    `M${f(x0)} ${f(y0 + arm)}V${f(y0)}H${f(x0 + arm)}`,
    `M${f(x1 - arm)} ${f(y0)}H${f(x1)}V${f(y0 + arm)}`,
    `M${f(x1)} ${f(y1 - arm)}V${f(y1)}H${f(x1 - arm)}`,
    `M${f(x0 + arm)} ${f(y1)}H${f(x0)}V${f(y1 - arm)}`,
  ].join("")
}

/**
 * Corner brackets on the exact thing E will act on (AR-89). They ease to a new target instead of jumping, start a
 * little wide when a target first appears, and close in and warm as a hold fills, so the hold reads as "this, harder".
 */
export class TargetHighlight {
  readonly root: SVGSVGElement
  private readonly casing: SVGPathElement
  private readonly ink: SVGPathElement
  private box: ScreenBox | null = null
  private target = ""
  private appear = 0

  constructor(parent: HTMLElement = document.body) {
    const ns = "http://www.w3.org/2000/svg"
    this.root = document.createElementNS(ns, "svg")
    this.root.setAttribute("class", "ob-target-outline")
    this.root.setAttribute("aria-hidden", "true")
    this.casing = document.createElementNS(ns, "path")
    this.casing.setAttribute("class", "casing")
    this.ink = document.createElementNS(ns, "path")
    this.ink.setAttribute("class", "ink")
    this.root.append(this.casing, this.ink)
    parent.appendChild(this.root)
  }

  /** Draws the outline round `box` (null hides it); `hold` is the hold progress 0..1. */
  update(id: string, box: ScreenBox | null, hold: number, dt: number): void {
    if (!box) {
      this.root.style.opacity = "0"
      this.box = null
      this.target = ""
      return
    }
    const fresh = !this.box || id !== this.target
    if (!this.box) {
      this.box = { ...box }
      this.appear = 0
    }
    if (id !== this.target) this.target = id
    const k = fresh ? 0.45 : 1 - Math.exp(-dt * 22)
    const b = this.box
    b.x0 += (box.x0 - b.x0) * k
    b.y0 += (box.y0 - b.y0) * k
    b.x1 += (box.x1 - b.x1) * k
    b.y1 += (box.y1 - b.y1) * k
    this.appear = Math.min(1, this.appear + dt / 0.18)
    const ease = 1 - (1 - this.appear) ** 3
    const pad = 6 + (1 - ease) * 6 - hold * 4
    const d = bracketPath(b, pad)
    this.casing.setAttribute("d", d)
    this.ink.setAttribute("d", d)
    this.root.style.opacity = String(0.9 * ease)
    this.root.dataset.holding = String(hold > 0)
  }

  get shown(): boolean {
    return this.box !== null
  }
}
