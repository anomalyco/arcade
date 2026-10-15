import { drawGlyph } from "./icons"
import type { MapMemory, PoiKind } from "./memory"
import { drawPin, type MapActor, type MapPing } from "./screen"
import type { MapPalette } from "./style"
import type { MapTiles, MapViewport } from "./tiles"

export type Project = (x: number, y: number, z: number) => { x: number; y: number; ok: boolean }

export type CompassInput = {
  self: MapActor
  ground: number
  teammates: readonly MapActor[]
  pings: readonly MapPing[]
  project: Project
  radius: number
  opacity: number
  range: number
}

const RING_POINTS = 64
const INK = "#ece6d2"
const SHADOW = "rgba(8, 10, 12, 0.75)"
const MARKER_INK = "#d0583f"

/**
 * A thin ring on the ground around the survivor with bearings to marks, teammates, pings, safehouses and nearby known
 * places. It is projected through the game camera, so it sits in the world like the Diegetic HUD's ground meters and
 * needs no screen corner. Drawn into a small canvas that follows the survivor.
 */
export class MapCompass {
  private readonly canvas: HTMLCanvasElement
  private readonly pts = new Float32Array(RING_POINTS * 2)
  visible = false
  readonly stats = { ms: 0, maxMs: 0, bearings: 0 }

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement("canvas")
    this.canvas.className = "obmap-compass"
    this.canvas.setAttribute("aria-hidden", "true")
    this.canvas.hidden = true
    parent.appendChild(this.canvas)
  }

  hide(): void {
    if (!this.visible) return
    this.visible = false
    this.canvas.hidden = true
  }

  draw(memory: MapMemory, input: CompassInput): void {
    const t0 = performance.now()
    const { self, project, radius: R } = input
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let i = 0; i < RING_POINTS; i++) {
      const a = (i / RING_POINTS) * Math.PI * 2
      const p = project(self.x + Math.cos(a) * R, input.ground + 0.03, self.y + Math.sin(a) * R)
      if (!p.ok) {
        this.hide()
        return
      }
      this.pts[i * 2] = p.x
      this.pts[i * 2 + 1] = p.y
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y)
      maxY = Math.max(maxY, p.y)
    }
    const pad = 30
    const left = Math.floor(minX - pad)
    const top = Math.floor(minY - pad)
    const w = Math.ceil(maxX + pad) - left
    const h = Math.ceil(maxY + pad) - top
    const dpr = Math.min(devicePixelRatio || 1, 2)
    // Grow in 32 px steps so walking doesn't reallocate the canvas every frame.
    const cw = Math.ceil(w / 32) * 32
    const ch = Math.ceil(h / 32) * 32
    const c = this.canvas
    if (c.width !== cw * dpr || c.height !== ch * dpr) {
      c.width = cw * dpr
      c.height = ch * dpr
      c.style.width = `${cw}px`
      c.style.height = `${ch}px`
    }
    c.style.transform = `translate(${left}px, ${top}px)`
    if (!this.visible) {
      this.visible = true
      c.hidden = false
    }
    const ctx = c.getContext("2d")!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cw, ch)
    ctx.globalAlpha = input.opacity
    ctx.beginPath()
    for (let i = 0; i < RING_POINTS; i++) {
      const x = this.pts[i * 2]! - left
      const y = this.pts[i * 2 + 1]! - top
      if (i) ctx.lineTo(x, y)
      else ctx.moveTo(x, y)
    }
    ctx.closePath()
    ctx.lineWidth = 3
    ctx.strokeStyle = SHADOW
    ctx.stroke()
    ctx.lineWidth = 1.25
    ctx.strokeStyle = INK
    ctx.stroke()

    const at = (bearing: number, lift = 0) => {
      const p = project(self.x + Math.cos(bearing) * R, input.ground + 0.03 + lift, self.y + Math.sin(bearing) * R)
      return [p.x - left, p.y - top] as const
    }
    // North tick.
    const [nx, ny] = at(-Math.PI / 2)
    ctx.font = `700 10px ui-monospace, "SF Mono", Menlo, monospace`
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.lineWidth = 3
    ctx.strokeStyle = SHADOW
    ctx.strokeText("N", Math.round(nx), Math.round(ny - 9))
    ctx.fillStyle = INK
    ctx.fillText("N", Math.round(nx), Math.round(ny - 9))

    let bearings = 0
    const near = (x: number, y: number) => Math.hypot(x - self.x, y - self.y) < R * 1.4
    const bearing = (x: number, y: number) => Math.atan2(y - self.y, x - self.x)
    const distText = (x: number, y: number) => `${Math.round(Math.hypot(x - self.x, y - self.y))} m`
    const label = (text: string, x: number, y: number) => {
      ctx.font = `600 10px ui-monospace, "SF Mono", Menlo, monospace`
      ctx.lineWidth = 3
      ctx.strokeStyle = SHADOW
      ctx.strokeText(text, Math.round(x), Math.round(y))
      ctx.fillStyle = INK
      ctx.fillText(text, Math.round(x), Math.round(y))
    }

    // Known places within range: one of each kind, nearest first, faint.
    const kinds = new Set<PoiKind>()
    for (const b of memory.knownPois(self.x, self.y, input.range)) {
      if (kinds.has(b.poi!) || near(b.x, b.y)) continue
      kinds.add(b.poi!)
      const [x, y] = at(bearing(b.x, b.y))
      ctx.save()
      ctx.translate(Math.round(x), Math.round(y))
      ctx.globalAlpha = input.opacity * (b.poi === "safehouse" ? 1 : 0.75)
      ctx.fillStyle = SHADOW
      ctx.beginPath()
      ctx.arc(0, 0, 8.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = b.poi === "safehouse" ? "#e8b85a" : INK
      ctx.strokeStyle = ctx.fillStyle
      drawGlyph(ctx, b.poi!, 11.5, SHADOW)
      ctx.restore()
      bearings++
    }
    ctx.globalAlpha = input.opacity
    for (const m of memory.markers) {
      if (near(m.x, m.y)) continue
      const [x, y] = at(bearing(m.x, m.y))
      drawPin(ctx, x, y + 4, m.label, MARKER_INK, INK, 0.8)
      label(distText(m.x, m.y), x, y + 13)
      bearings++
    }
    for (const p of input.pings) {
      if (near(p.x, p.y)) continue
      const [x, y] = at(bearing(p.x, p.y))
      ctx.globalAlpha = input.opacity * Math.min(1, p.left / 1.5)
      ctx.beginPath()
      ctx.moveTo(x, y - 6.5)
      ctx.lineTo(x + 5.5, y)
      ctx.lineTo(x, y + 6.5)
      ctx.lineTo(x - 5.5, y)
      ctx.closePath()
      ctx.fillStyle = p.colour
      ctx.fill()
      ctx.lineWidth = 1
      ctx.strokeStyle = SHADOW
      ctx.stroke()
      label(distText(p.x, p.y), x, y + 13)
      bearings++
    }
    ctx.globalAlpha = input.opacity
    for (const t of input.teammates) {
      if (near(t.x, t.y)) continue
      const [x, y] = at(bearing(t.x, t.y))
      ctx.beginPath()
      ctx.arc(x, y, 5, 0, Math.PI * 2)
      ctx.fillStyle = t.colour
      ctx.fill()
      ctx.lineWidth = 1.2
      ctx.strokeStyle = SHADOW
      ctx.stroke()
      bearings++
    }
    ctx.globalAlpha = 1
    const ms = performance.now() - t0
    this.stats.ms = ms
    this.stats.maxMs = Math.max(this.stats.maxMs, ms)
    this.stats.bearings = bearings
  }
}

/** A small north-up map in the top-right corner, drawn from the same cached tiles as the full map. */
export class MapMinimap {
  private readonly canvas: HTMLCanvasElement
  private lastAt = -Infinity
  private lastX = NaN
  private lastY = NaN
  visible = false
  readonly stats = { ms: 0, maxMs: 0 }

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement("canvas")
    this.canvas.className = "obmap-minimap"
    this.canvas.setAttribute("aria-hidden", "true")
    this.canvas.hidden = true
    parent.appendChild(this.canvas)
  }

  hide(): void {
    if (!this.visible) return
    this.visible = false
    this.canvas.hidden = true
  }

  invalidate(): void {
    this.lastAt = -Infinity
  }

  draw(
    tiles: MapTiles,
    memory: MapMemory,
    P: MapPalette,
    self: MapActor,
    teammates: readonly MapActor[],
    pings: readonly MapPing[],
    size: number,
    zoom: number,
    now: number,
  ): void {
    const moved = Math.hypot(self.x - this.lastX, self.y - this.lastY) * zoom > 0.75
    if (this.visible && !moved && now - this.lastAt < 250) return
    if (now - this.lastAt < 66) return
    const t0 = performance.now()
    this.lastAt = now
    this.lastX = self.x
    this.lastY = self.y
    const dpr = Math.min(devicePixelRatio || 1, 2)
    const c = this.canvas
    if (c.width !== Math.round(size * dpr)) {
      c.width = c.height = Math.round(size * dpr)
      c.style.width = c.style.height = `${size}px`
    }
    if (!this.visible) {
      this.visible = true
      c.hidden = false
    }
    const ctx = c.getContext("2d")!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size, size)
    ctx.save()
    ctx.beginPath()
    ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2)
    ctx.clip()
    ctx.fillStyle = P.paper
    ctx.fillRect(0, 0, size, size)
    const view: MapViewport = { x: self.x, y: self.y, zoom, w: size, h: size, dpr }
    tiles.draw(ctx, view, 0.75)
    const toScreen = (x: number, y: number) => [(x - self.x) * zoom + size / 2, (y - self.y) * zoom + size / 2] as const
    for (const m of memory.markers) {
      const [x, y] = toScreen(m.x, m.y)
      drawPin(ctx, x, y, m.label, MARKER_INK, P.badge, 0.7)
    }
    for (const p of pings) {
      const [x, y] = toScreen(p.x, p.y)
      ctx.fillStyle = p.colour
      ctx.beginPath()
      ctx.moveTo(x, y - 5)
      ctx.lineTo(x + 4, y)
      ctx.lineTo(x, y + 5)
      ctx.lineTo(x - 4, y)
      ctx.fill()
    }
    for (const a of [...teammates, self]) {
      const [x, y] = toScreen(a.x, a.y)
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(a.aim)
      ctx.beginPath()
      ctx.moveTo(7, 0)
      ctx.lineTo(-4.5, -5)
      ctx.lineTo(-2, 0)
      ctx.lineTo(-4.5, 5)
      ctx.closePath()
      ctx.fillStyle = a.colour
      ctx.fill()
      ctx.lineWidth = 1
      ctx.strokeStyle = P.ink
      ctx.stroke()
      ctx.restore()
    }
    ctx.restore()
    ctx.beginPath()
    ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2)
    ctx.lineWidth = 1.5
    ctx.strokeStyle = "rgba(10, 12, 14, 0.7)"
    ctx.stroke()
    ctx.font = `600 9px ui-monospace, "SF Mono", Menlo, monospace`
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillStyle = P.ink
    ctx.fillText("N", size / 2, 9)
    const ms = performance.now() - t0
    this.stats.ms = ms
    this.stats.maxMs = Math.max(this.stats.maxMs, ms)
  }
}
