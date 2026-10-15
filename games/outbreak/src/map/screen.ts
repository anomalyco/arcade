import { keyCapHtml } from "@arcade/kit/client/key-cap"
import { hudMotion } from "../hud/motion"
import { CHUNK } from "../../shared/map"
import { MACRO_SIZE } from "../../shared/world"
import { drawBadge, type Ctx2D } from "./icons"
import { blockName, DISTRICT_LABELS, groupSightings, POI_LABELS, type MapBuilding, type MapMarker, type MapMemory } from "./memory"
import { LABEL_FONT, MONO_FONT, type MapPalette } from "./style"
import { MapTiles, type MapViewport } from "./tiles"

export type MapActor = { x: number; y: number; aim: number; colour: string; name: string; self?: boolean }
export type MapPing = { x: number; y: number; label: string; colour: string; left: number }
export type MapVehicle = { x: number; y: number; heading: number; length: number; width: number; colour?: string }

/** Moving things drawn over the explored map every frame. */
export type MapLive = {
  time: number
  actors: readonly MapActor[]
  pings: readonly MapPing[]
  vehicles: readonly MapVehicle[]
  hordeMemory: number
  place: string
}

/** Hordes are groups of at least this many zombies; smaller sightings are drawn as small marks up close. */
export const HORDE_SIZE = 5
export const MIN_ZOOM = 0.08
export const MAX_ZOOM = 10
const MARKER_INK = "#b23a26"

/** Keeps a CSS-pixel canvas at device resolution so text and lines stay sharp at DPR 2. */
function fit(canvas: HTMLCanvasElement, w: number, h: number, dpr: number): boolean {
  const W = Math.max(1, Math.round(w * dpr))
  const H = Math.max(1, Math.round(h * dpr))
  if (canvas.width === W && canvas.height === H) return false
  canvas.width = W
  canvas.height = H
  canvas.style.width = `${w}px`
  canvas.style.height = `${h}px`
  return true
}

/** Screen rectangles already taken by labels and badges, so later labels can step aside or drop out. */
class Placer {
  private readonly rects: number[] = []
  clear(): void {
    this.rects.length = 0
  }
  fits(x0: number, y0: number, x1: number, y1: number): boolean {
    const r = this.rects
    for (let i = 0; i < r.length; i += 4) if (x0 < r[i + 2]! && x1 > r[i]! && y0 < r[i + 3]! && y1 > r[i + 1]!) return false
    return true
  }
  add(x0: number, y0: number, x1: number, y1: number): void {
    this.rects.push(x0, y0, x1, y1)
  }
}

/** Paper grain: a small seeded noise tile used as a repeating pattern. */
function grainTile(colour: string): HTMLCanvasElement {
  const c = document.createElement("canvas")
  c.width = c.height = 128
  const g = c.getContext("2d")!
  let s = 0x9e3779b9
  const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 4294967296)
  g.fillStyle = colour
  for (let i = 0; i < 900; i++) g.fillRect(Math.floor(rnd() * 128), Math.floor(rnd() * 128), 1, 1 + Math.floor(rnd() * 2))
  return c
}

/**
 * The full-screen map sheet. It never pauses the game: movement keys keep working while it is open, and only mouse
 * input over the sheet is taken (so the survivor doesn't aim or fire at the map). The explored ground comes from
 * cached tiles; labels, icons and the moving layer are drawn in screen space each time so they stay crisp.
 */
export class MapScreen {
  readonly root: HTMLDivElement
  private readonly sheet: HTMLDivElement
  private readonly base: HTMLCanvasElement
  private readonly live: HTMLCanvasElement
  private readonly title: HTMLElement
  private readonly placeEl: HTMLElement
  private readonly scaleEl: HTMLElement
  private readonly scaleBar: HTMLElement
  private readonly legend: HTMLElement
  view: MapViewport = { x: 48, y: 48, zoom: 3, w: 1, h: 1, dpr: 1 }
  isOpen = false
  palette: MapPalette
  labels = true
  private baseDirty = true
  private grain: CanvasPattern | null = null
  private grainFor = ""
  private drag: { id: number; sx: number; sy: number; x: number; y: number; moved: boolean } | null = null
  private pois: MapBuilding[] = []
  private poisRevision = -1
  private lastLive: MapLive | null = null
  private readonly placer = new Placer()
  private readonly livePlacer = new Placer()
  private liveAt = -Infinity
  /** Called when the player places or removes a marker. */
  onMarkers: (() => void) | null = null
  readonly stats = { baseDraws: 0, baseMs: 0, maxBaseMs: 0, liveMs: 0, maxLiveMs: 0, opens: 0 }

  constructor(
    parent: HTMLElement,
    private readonly memory: MapMemory,
    private readonly tiles: MapTiles,
    palette: MapPalette,
    private readonly seed: () => number,
  ) {
    this.palette = palette
    this.root = document.createElement("div")
    this.root.className = "obmap"
    this.root.hidden = true
    this.root.setAttribute("role", "dialog")
    this.root.setAttribute("aria-label", "Map")
    this.root.innerHTML = `
      <div class="obmap-sheet">
        <canvas class="obmap-base"></canvas>
        <canvas class="obmap-live" aria-hidden="true"></canvas>
        <header class="obmap-head"><b class="obmap-title"></b><span class="obmap-place"></span></header>
        <div class="obmap-zoom">
          <button type="button" data-zoom="in" aria-label="Zoom in">+</button>
          <button type="button" data-zoom="out" aria-label="Zoom out">−</button>
          <button type="button" data-zoom="me" aria-label="Centre on me">◎</button>
        </div>
        <footer class="obmap-foot">
          <span class="obmap-legend"></span>
          <span class="obmap-scale"><i></i><em></em></span>
        </footer>
      </div>`
    parent.appendChild(this.root)
    this.sheet = this.root.querySelector(".obmap-sheet")!
    this.base = this.root.querySelector(".obmap-base")!
    this.live = this.root.querySelector(".obmap-live")!
    this.title = this.root.querySelector(".obmap-title")!
    this.placeEl = this.root.querySelector(".obmap-place")!
    this.scaleEl = this.root.querySelector(".obmap-scale em")!
    this.scaleBar = this.root.querySelector(".obmap-scale i")!
    this.legend = this.root.querySelector(".obmap-legend")!
    this.renderLegend()
    this.bindInput()
  }

  renderLegend(): void {
    this.legend.innerHTML =
      `<span>${keyCapHtml("KeyN")} Close</span>` +
      `<span>Drag or two-finger swipe to pan</span>` +
      `<span>Pinch or scroll to zoom</span>` +
      `<span>${keyCapHtml("Mouse0")} Mark · click a mark to clear it</span>`
  }

  setPalette(p: MapPalette): void {
    if (p === this.palette) return
    this.palette = p
    this.tiles.setPalette(p)
    this.baseDirty = true
    this.applyChrome()
  }

  private applyChrome(): void {
    const c = this.palette.chrome
    this.sheet.style.setProperty("--map-sheet", c.sheet)
    this.sheet.style.setProperty("--map-text", c.text)
    this.sheet.style.setProperty("--map-soft", c.soft)
    this.sheet.style.setProperty("--map-edge", c.edge)
    this.title.textContent = this.palette.name === "Noir survey" ? "Night survey" : "Survey sheet"
  }

  markDirty(): void {
    this.baseDirty = true
  }

  open(x: number, y: number, zoom: number, backdrop: number): void {
    const reopening = !this.root.hidden
    this.isOpen = true
    this.root.hidden = false
    this.root.style.pointerEvents = ""
    // The sheet settles in from slightly small and soft; reopening mid-close reverses from where it is.
    const from = reopening ? Number(getComputedStyle(this.root).opacity) : 0
    for (const a of this.root.getAnimations()) a.cancel()
    for (const a of this.sheet.getAnimations()) a.cancel()
    hudMotion.animate(this.root, [{ opacity: from }, { opacity: 1 }], "smooth")
    hudMotion.animate(this.sheet, [{ transform: "scale(0.98)", filter: "blur(3px)" }, { transform: "none", filter: "blur(0px)" }], "smooth")
    this.root.style.setProperty("--map-backdrop", String(backdrop))
    this.view.x = x
    this.view.y = y
    this.view.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
    this.baseDirty = true
    this.stats.opens++
    this.applyChrome()
  }

  close(): void {
    if (!this.isOpen) return
    this.isOpen = false
    this.drag = null
    // Input passes through to the game while the sheet fades.
    this.root.style.pointerEvents = "none"
    const a = hudMotion.animate(this.root, [{ opacity: Number(getComputedStyle(this.root).opacity) }, { opacity: 0 }], "snappy", { fill: "forwards" })
    hudMotion.animate(this.sheet, [{ transform: "none", filter: "blur(0px)" }, { transform: "scale(0.98)", filter: "blur(3px)" }], "snappy", { fill: "forwards" })
    const done = () => {
      if (this.isOpen) return
      this.root.hidden = true
      for (const x of this.root.getAnimations()) x.cancel()
      for (const x of this.sheet.getAnimations()) x.cancel()
    }
    if (a) void a.finished.then(done, () => undefined)
    else done()
  }

  centreOn(x: number, y: number): void {
    this.view.x = x
    this.view.y = y
    this.baseDirty = true
  }

  /** Zooms by `factor` keeping the world point under screen point (sx, sy) in place. */
  zoomAt(factor: number, sx = this.view.w / 2, sy = this.view.h / 2): void {
    const v = this.view
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor))
    if (next === v.zoom) return
    const wx = v.x + (sx - v.w / 2) / v.zoom
    const wy = v.y + (sy - v.h / 2) / v.zoom
    v.zoom = next
    v.x = wx - (sx - v.w / 2) / next
    v.y = wy - (sy - v.h / 2) / next
    this.baseDirty = true
  }

  /** Moves the view by a screen delta in CSS pixels; positive moves the content up and left. */
  panBy(dx: number, dy: number): void {
    this.view.x += dx / this.view.zoom
    this.view.y += dy / this.view.zoom
    this.baseDirty = true
  }

  toScreen(x: number, y: number): [number, number] {
    const v = this.view
    return [(x - v.x) * v.zoom + v.w / 2, (y - v.y) * v.zoom + v.h / 2]
  }

  toWorld(sx: number, sy: number): [number, number] {
    const v = this.view
    return [v.x + (sx - v.w / 2) / v.zoom, v.y + (sy - v.h / 2) / v.zoom]
  }

  private local(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.live.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }

  private markerAt(sx: number, sy: number, radius: number): MapMarker | undefined {
    let best: MapMarker | undefined
    let bestD = radius * radius
    for (const m of this.memory.markers) {
      const [mx, my] = this.toScreen(m.x, m.y)
      const d = (mx - sx) ** 2 + (my - 10 - sy) ** 2
      if (d <= bestD) {
        bestD = d
        best = m
      }
    }
    return best
  }

  /** A click on the sheet: clears the mark under the cursor, or places a new one. */
  click(sx: number, sy: number): void {
    const hit = this.markerAt(sx, sy, 14)
    if (hit) this.memory.removeMarker(hit.id)
    else {
      const [x, y] = this.toWorld(sx, sy)
      this.memory.addMarker(x, y)
    }
    this.onMarkers?.()
  }

  private bindInput(): void {
    const stop = (e: Event) => e.stopPropagation()
    // The game aims at the cursor from window-level mouse events; keep the cursor over the sheet to the map.
    this.root.addEventListener("mousemove", stop)
    this.root.addEventListener("mousedown", stop)
    this.root.addEventListener("contextmenu", (e) => e.preventDefault())
    this.root.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-zoom]")
      if (!b) return
      const z = b.dataset.zoom
      if (z === "in") this.zoomAt(1.6)
      else if (z === "out") this.zoomAt(1 / 1.6)
      else if (z === "me" && this.lastLive) {
        const me = this.lastLive.actors.find((a) => a.self)
        if (me) this.centreOn(me.x, me.y)
      }
    })
    this.live.addEventListener("pointerdown", (e) => {
      const [sx, sy] = this.local(e)
      if (e.button === 2) {
        const hit = this.markerAt(sx, sy, 16)
        if (hit && this.memory.removeMarker(hit.id)) this.onMarkers?.()
        return
      }
      if (e.button !== 0) return
      this.live.setPointerCapture(e.pointerId)
      this.drag = { id: e.pointerId, sx, sy, x: sx, y: sy, moved: false }
      this.live.dataset.drag = "true"
    })
    this.live.addEventListener("pointermove", (e) => {
      const d = this.drag
      if (!d || d.id !== e.pointerId) return
      const [sx, sy] = this.local(e)
      if (!d.moved && Math.hypot(sx - d.sx, sy - d.sy) > 4) d.moved = true
      if (d.moved) this.panBy(d.x - sx, d.y - sy)
      d.x = sx
      d.y = sy
    })
    const end = (e: PointerEvent) => {
      const d = this.drag
      if (!d || d.id !== e.pointerId) return
      this.drag = null
      delete this.live.dataset.drag
      if (!d.moved && e.type === "pointerup") this.click(d.sx, d.sy)
    }
    this.live.addEventListener("pointerup", end)
    this.live.addEventListener("pointercancel", end)
    this.live.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault()
        e.stopPropagation()
        this.wheel(e)
      },
      { passive: false },
    )
  }

  /**
   * Trackpad pinches arrive as ctrl+wheel and zoom. Two-finger swipes arrive as pixel wheel deltas and pan so the
   * sheet moves with the fingers (the browser already applies the system's natural-scrolling direction). A mouse
   * wheel (line deltas, or whole notches with no sideways part) zooms around the cursor.
   */
  wheel(e: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "ctrlKey" | "clientX" | "clientY">): void {
    const [sx, sy] = this.local(e)
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.view.h : 1
    const dx = e.deltaX * unit
    const dy = e.deltaY * unit
    const notch = e.deltaMode !== 0 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY))
    if (e.ctrlKey) this.zoomAt(Math.exp(-dy * 0.01), sx, sy)
    else if (notch) this.zoomAt(Math.exp(-Math.sign(dy) * Math.min(Math.abs(dy), 200) * 0.0035), sx, sy)
    else this.panBy(dx, dy)
  }

  private paperPattern(ctx: Ctx2D): CanvasPattern | null {
    if (this.grainFor !== this.palette.grain) {
      this.grain = ctx.createPattern(grainTile(this.palette.grain), "repeat")
      this.grainFor = this.palette.grain
    }
    return this.grain
  }

  /** Draws the sheet. Returns true while tiles are still building, so the caller keeps calling. */
  render(live: MapLive, budgetMs: number): boolean {
    if (!this.isOpen) return false
    this.lastLive = live
    const w = this.live.clientWidth || this.sheet.clientWidth
    const h = this.live.clientHeight || this.sheet.clientHeight
    const dpr = Math.min(devicePixelRatio || 1, 2)
    const v = this.view
    if (v.w !== w || v.h !== h || v.dpr !== dpr) {
      v.w = w
      v.h = h
      v.dpr = dpr
      this.baseDirty = true
    }
    if (fit(this.base, w, h, dpr)) this.baseDirty = true
    fit(this.live, w, h, dpr)
    if (this.poisRevision !== this.memory.revision) {
      this.poisRevision = this.memory.revision
      this.pois = []
      for (const c of this.memory.chunks.values()) for (const b of c.buildings) if (b.known && b.poi) this.pois.push(b)
    }
    let pending = false
    const drewBase = this.baseDirty
    if (this.baseDirty) {
      const t0 = performance.now()
      this.baseDirty = false
      pending = this.drawBase(budgetMs)
      if (pending) this.baseDirty = true
      const ms = performance.now() - t0
      this.stats.baseDraws++
      this.stats.baseMs = ms
      this.stats.maxBaseMs = Math.max(this.stats.maxBaseMs, ms)
    }
    // The moving layer runs at up to 30 Hz; pulses don't need more and the sheet is a large layer to recomposite.
    const t1 = performance.now()
    if (!drewBase && t1 - this.liveAt < 30) return pending
    this.liveAt = t1
    this.drawLive(live)
    const ms = performance.now() - t1
    this.stats.liveMs = ms
    this.stats.maxLiveMs = Math.max(this.stats.maxLiveMs, ms)
    this.placeEl.textContent = live.place
    this.updateScale()
    return pending
  }

  private updateScale(): void {
    const target = 110 / this.view.zoom
    const steps = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000]
    const m = steps.find((s) => s >= target * 0.6) ?? 5000
    this.scaleBar.style.width = `${Math.round(m * this.view.zoom)}px`
    this.scaleEl.textContent = m >= 1000 ? `${m / 1000} km` : `${m} m`
  }

  private drawBase(budgetMs: number): boolean {
    const ctx = this.base.getContext("2d")!
    const v = this.view
    const P = this.palette
    ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0)
    ctx.fillStyle = P.paper
    ctx.fillRect(0, 0, v.w, v.h)
    const grain = this.paperPattern(ctx)
    if (grain) {
      ctx.fillStyle = grain
      ctx.fillRect(0, 0, v.w, v.h)
    }
    this.drawGrid(ctx, false)
    const pending = this.tiles.draw(ctx, v, budgetMs)
    this.drawGrid(ctx, true)
    // Badges first, then district names where they fit around them, then POI names where there's room left.
    this.placer.clear()
    const named = this.drawPois(ctx)
    if (this.labels) {
      this.drawDistricts(ctx)
      this.drawPoiNames(ctx, named)
    }
    return pending
  }

  /** Survey grid: chunk lines under the explored ground, macro-block lines faintly over it. */
  private drawGrid(ctx: Ctx2D, over: boolean): void {
    const v = this.view
    const P = this.palette
    let step = over ? MACRO_SIZE : CHUNK
    while (step * v.zoom < (over ? 40 : 16)) step *= 4
    const [x0, y0] = this.toWorld(0, 0)
    const [x1, y1] = this.toWorld(v.w, v.h)
    ctx.save()
    ctx.strokeStyle = over ? P.grid : P.gridMajor
    ctx.globalAlpha = over ? 0.6 : 1
    ctx.lineWidth = 1 / v.dpr
    ctx.beginPath()
    const half = 0.5 / v.dpr
    for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) {
      const sx = Math.round(this.toScreen(x, 0)[0] * v.dpr) / v.dpr + half
      ctx.moveTo(sx, 0)
      ctx.lineTo(sx, v.h)
    }
    for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
      const sy = Math.round(this.toScreen(0, y)[1] * v.dpr) / v.dpr + half
      ctx.moveTo(0, sy)
      ctx.lineTo(v.w, sy)
    }
    ctx.stroke()
    ctx.restore()
  }

  private drawDistricts(ctx: Ctx2D): void {
    const v = this.view
    if (MACRO_SIZE * v.zoom < 70) return
    const P = this.palette
    const seed = this.seed()
    const centroid = new Map<string, { x: number; y: number; n: number }>()
    for (const c of this.memory.chunks.values()) {
      const k = `${c.bx},${c.by}`
      const e = centroid.get(k) ?? { x: 0, y: 0, n: 0 }
      e.x += (c.cx * CHUNK + CHUNK / 2) * c.count
      e.y += (c.cy * CHUNK + CHUNK / 2) * c.count
      e.n += c.count
      centroid.set(k, e)
    }
    ctx.save()
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.lineJoin = "round"
    for (const b of this.memory.blocks().values()) {
      const e = centroid.get(`${b.bx},${b.by}`)
      if (!e || e.n < 60) continue
      // Pull the label off the crossroads toward the block's explored ground.
      const bx = b.bx * MACRO_SIZE + MACRO_SIZE / 2
      const by = b.by * MACRO_SIZE + MACRO_SIZE / 2
      const wx = e.x / e.n
      const wy = e.y / e.n
      const [cx, cy] = this.toScreen(wx + (wx - bx) * 0.15, wy + (wy - by) * 0.15)
      if (cx < -160 || cy < -60 || cx > v.w + 160 || cy > v.h + 60) continue
      const name = blockName(seed, b.bx, b.by, b.district).toUpperCase()
      const size = Math.round(Math.min(17, Math.max(12, MACRO_SIZE * v.zoom * 0.05)))
      ctx.font = `600 ${size}px ${LABEL_FONT}`
      ctx.letterSpacing = "0.14em"
      const halfW = ctx.measureText(name).width / 2 + 4
      const step = MACRO_SIZE * v.zoom * 0.22
      const spot = [[0, 0], [0, -step], [0, step], [-step, 0], [step, 0], [-step, -step], [step, step]].find(([dx, dy]) =>
        this.placer.fits(cx + dx! - halfW, cy + dy! - size * 0.7, cx + dx! + halfW, cy + dy! + size * 1.6),
      )
      if (!spot) continue
      const sx = Math.round(cx + spot[0]!)
      const sy = Math.round(cy + spot[1]!)
      this.placer.add(sx - halfW, sy - size * 0.7, sx + halfW, sy + size * 1.6)
      ctx.lineWidth = 4
      ctx.strokeStyle = P.halo
      ctx.strokeText(name, sx, sy)
      ctx.fillStyle = P.label
      ctx.fillText(name, sx, sy)
      ctx.font = `italic ${size - 3}px ${LABEL_FONT}`
      ctx.letterSpacing = "0.04em"
      const sub = DISTRICT_LABELS[b.district]
      ctx.lineWidth = 3
      ctx.strokeText(sub, sx, sy + size)
      ctx.fillStyle = P.labelSoft
      ctx.fillText(sub, sx, sy + size)
    }
    ctx.restore()
  }

  /** POI badges at a constant screen size. Far out, plain POIs that would overlap give way. Returns the drawn ones. */
  private drawPois(ctx: Ctx2D): { b: MapBuilding; x: number; y: number; size: number }[] {
    const v = this.view
    const P = this.palette
    const size = v.zoom < 1.2 ? 15 : 19
    const drawn: { b: MapBuilding; x: number; y: number; size: number }[] = []
    // Safehouses first so they always win a crowded spot.
    const order = [...this.pois].sort((a, b) => Number(b.poi === "safehouse") - Number(a.poi === "safehouse"))
    for (const b of order) {
      const [sx, sy] = this.toScreen(b.x, b.y)
      if (sx < -30 || sy < -30 || sx > v.w + 30 || sy > v.h + 30) continue
      const safe = b.poi === "safehouse"
      const s = safe ? size + 3 : size
      const r = s / 2 + 1
      if (!safe && !this.placer.fits(sx - r, sy - r, sx + r, sy + r)) continue
      this.placer.add(sx - r, sy - r, sx + r, sy + r)
      drawBadge(ctx, b.poi!, sx, sy, s, {
        badge: P.badge,
        ink: P.ink,
        fill: safe ? P.poi.safehouse : P.badgeInk,
        accent: safe ? P.poi.safehouse : undefined,
      })
      drawn.push({ b, x: sx, y: sy, size: s })
    }
    return drawn
  }

  private drawPoiNames(ctx: Ctx2D, drawn: readonly { b: MapBuilding; x: number; y: number; size: number }[]): void {
    if (this.view.zoom < 2.4) return
    const P = this.palette
    ctx.save()
    ctx.textAlign = "center"
    ctx.textBaseline = "top"
    ctx.lineJoin = "round"
    ctx.font = `italic 11.5px ${LABEL_FONT}`
    ctx.letterSpacing = "0px"
    for (const d of drawn) {
      const text = POI_LABELS[d.b.poi!]
      const half = ctx.measureText(text).width / 2 + 2
      const x = Math.round(d.x)
      const y = Math.round(d.y + d.size / 2 + 3)
      if (!this.placer.fits(x - half, y, x + half, y + 13)) continue
      this.placer.add(x - half, y, x + half, y + 13)
      ctx.lineWidth = 3
      ctx.strokeStyle = P.halo
      ctx.strokeText(text, x, y)
      ctx.fillStyle = P.label
      ctx.fillText(text, x, y)
    }
    ctx.restore()
  }

  private drawLive(live: MapLive): void {
    const ctx = this.live.getContext("2d")!
    const v = this.view
    const P = this.palette
    ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0)
    ctx.clearRect(0, 0, v.w, v.h)
    ctx.lineJoin = "round"
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    // Last-known zombie groups, fading with age. Stragglers are small marks, only up close.
    this.livePlacer.clear()
    for (const g of groupSightings(this.memory.sightings.values())) {
      const age = live.time - g.seenAt
      const [sx, sy] = this.toScreen(g.x, g.y)
      if (sx < -40 || sy < -40 || sx > v.w + 40 || sy > v.h + 40) continue
      const fade = Math.max(0.35, 1 - (age / Math.max(1, live.hordeMemory)) * 0.65)
      if (g.count < HORDE_SIZE) {
        if (v.zoom < 3) continue
        ctx.globalAlpha = fade * 0.8
        ctx.strokeStyle = P.horde
        ctx.lineWidth = 1.6
        ctx.beginPath()
        for (let i = 0; i < g.count; i++) {
          const ox = sx + (i - (g.count - 1) / 2) * 7
          ctx.moveTo(ox - 2.5, sy - 2.5)
          ctx.lineTo(ox + 2.5, sy + 2.5)
          ctx.moveTo(ox + 2.5, sy - 2.5)
          ctx.lineTo(ox - 2.5, sy + 2.5)
        }
        ctx.stroke()
        continue
      }
      const r = Math.max(9, (3 + Math.sqrt(g.count) * 1.8) * v.zoom)
      ctx.beginPath()
      ctx.arc(sx, sy, r, 0, Math.PI * 2)
      ctx.fillStyle = P.horde
      ctx.globalAlpha = fade * 0.2
      ctx.fill()
      ctx.globalAlpha = fade
      ctx.setLineDash([3, 2.5])
      ctx.lineWidth = 1.4
      ctx.strokeStyle = P.horde
      ctx.stroke()
      ctx.setLineDash([])
      ctx.font = `700 11px ${MONO_FONT}`
      const text = `${g.count}`
      ctx.lineWidth = 3
      ctx.strokeStyle = P.halo
      ctx.strokeText(text, Math.round(sx), Math.round(sy))
      ctx.fillStyle = P.horde
      ctx.fillText(text, Math.round(sx), Math.round(sy))
      if (v.zoom >= 0.8) {
        const ago = age < 20 ? "seen now" : age >= 60 ? `seen ${Math.floor(age / 60)} min ago` : `seen ${Math.floor(age)} s ago`
        ctx.font = `italic 10.5px ${LABEL_FONT}`
        const half = ctx.measureText(ago).width / 2 + 2
        const ly = Math.round(sy + r + 8)
        if (this.livePlacer.fits(sx - half, ly - 7, sx + half, ly + 7)) {
          this.livePlacer.add(sx - half, ly - 7, sx + half, ly + 7)
          ctx.strokeText(ago, Math.round(sx), ly)
          ctx.fillStyle = P.horde
          ctx.fillText(ago, Math.round(sx), ly)
        }
      }
    }
    ctx.globalAlpha = 1
    for (const veh of live.vehicles) {
      const [sx, sy] = this.toScreen(veh.x, veh.y)
      if (sx < -40 || sy < -40 || sx > v.w + 40 || sy > v.h + 40) continue
      ctx.save()
      ctx.translate(sx, sy)
      ctx.rotate(veh.heading)
      const L = Math.max(8, veh.length * v.zoom)
      const W = Math.max(4, veh.width * v.zoom)
      ctx.fillStyle = veh.colour ?? P.vehicle
      ctx.strokeStyle = P.halo
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.roundRect(-L / 2, -W / 2, L, W, Math.min(3, W / 3))
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = P.halo
      ctx.fillRect(L / 2 - Math.max(2, L * 0.22), -W / 2 + 1, Math.max(1.5, L * 0.08), W - 2)
      ctx.restore()
    }
    for (const p of live.pings) {
      const [sx, sy] = this.toScreen(p.x, p.y)
      const pulse = (live.time * 1.4) % 1
      ctx.globalAlpha = Math.min(1, p.left / 1.5)
      ctx.beginPath()
      ctx.arc(sx, sy, 7 + pulse * 12, 0, Math.PI * 2)
      ctx.strokeStyle = p.colour
      ctx.lineWidth = 1.5
      ctx.globalAlpha *= 1 - pulse
      ctx.stroke()
      ctx.globalAlpha = Math.min(1, p.left / 1.5)
      ctx.beginPath()
      ctx.moveTo(sx, sy - 7)
      ctx.lineTo(sx + 6, sy)
      ctx.lineTo(sx, sy + 7)
      ctx.lineTo(sx - 6, sy)
      ctx.closePath()
      ctx.fillStyle = p.colour
      ctx.fill()
      ctx.strokeStyle = P.ink
      ctx.lineWidth = 1.2
      ctx.stroke()
      ctx.font = `600 11px ${MONO_FONT}`
      ctx.lineWidth = 3
      ctx.strokeStyle = P.halo
      ctx.strokeText(p.label, Math.round(sx), Math.round(sy - 15))
      ctx.fillStyle = P.label
      ctx.fillText(p.label, Math.round(sx), Math.round(sy - 15))
    }
    ctx.globalAlpha = 1
    for (const m of this.memory.markers) {
      const [sx, sy] = this.toScreen(m.x, m.y)
      if (sx < -20 || sy < -30 || sx > v.w + 20 || sy > v.h + 20) continue
      drawPin(ctx, sx, sy, m.label, MARKER_INK, P.badge)
    }
    const actors = [...live.actors].sort((a, b) => Number(Boolean(a.self)) - Number(Boolean(b.self)))
    for (const a of actors) this.drawActor(ctx, a, live.time)
  }

  private drawActor(ctx: Ctx2D, a: MapActor, time: number): void {
    const v = this.view
    const P = this.palette
    let [sx, sy] = this.toScreen(a.x, a.y)
    const pad = 18
    const off = sx < pad || sy < pad || sx > v.w - pad || sy > v.h - pad
    if (off) {
      // Pin to the sheet edge, pointing the way to them.
      const cx = v.w / 2
      const cy = v.h / 2
      const dx = sx - cx
      const dy = sy - cy
      const k = Math.min((cx - pad) / Math.max(1e-6, Math.abs(dx)), (cy - pad) / Math.max(1e-6, Math.abs(dy)))
      sx = cx + dx * k
      sy = cy + dy * k
      ctx.save()
      ctx.translate(sx, sy)
      ctx.rotate(Math.atan2(dy, dx))
      ctx.beginPath()
      ctx.moveTo(9, 0)
      ctx.lineTo(-5, -6)
      ctx.lineTo(-5, 6)
      ctx.closePath()
      ctx.fillStyle = a.colour
      ctx.strokeStyle = P.ink
      ctx.lineWidth = 1.2
      ctx.fill()
      ctx.stroke()
      ctx.restore()
      return
    }
    if (a.self) {
      const pulse = (time * 0.9) % 1
      ctx.beginPath()
      ctx.arc(sx, sy, 9 + pulse * 14, 0, Math.PI * 2)
      ctx.strokeStyle = a.colour
      ctx.globalAlpha = 0.7 * (1 - pulse)
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.globalAlpha = 1
    }
    const s = a.self ? 1.15 : 0.95
    ctx.save()
    ctx.translate(sx, sy)
    ctx.rotate(a.aim)
    ctx.beginPath()
    ctx.moveTo(11 * s, 0)
    ctx.lineTo(-7 * s, -7.5 * s)
    ctx.lineTo(-3.5 * s, 0)
    ctx.lineTo(-7 * s, 7.5 * s)
    ctx.closePath()
    ctx.lineWidth = 3.5
    ctx.strokeStyle = P.halo
    ctx.stroke()
    ctx.fillStyle = a.colour
    ctx.fill()
    ctx.lineWidth = 1.3
    ctx.strokeStyle = P.ink
    ctx.stroke()
    ctx.restore()
    ctx.font = `600 11px ${MONO_FONT}`
    ctx.lineWidth = 3
    ctx.strokeStyle = P.halo
    const label = a.self ? "You" : a.name
    ctx.strokeText(label, Math.round(sx), Math.round(sy + 18))
    ctx.fillStyle = P.label
    ctx.fillText(label, Math.round(sx), Math.round(sy + 18))
  }
}

/** A map pin with its letter, tip at (x, y). */
export function drawPin(ctx: Ctx2D, x: number, y: number, label: string, ink: string, face: string, scale = 1): void {
  ctx.save()
  ctx.translate(Math.round(x), Math.round(y))
  ctx.scale(scale, scale)
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.bezierCurveTo(-3, -6, -8, -9, -8, -15)
  ctx.arc(0, -15, 8, Math.PI, 0)
  ctx.bezierCurveTo(8, -9, 3, -6, 0, 0)
  ctx.closePath()
  ctx.fillStyle = ink
  ctx.fill()
  ctx.lineWidth = 1.5
  ctx.strokeStyle = face
  ctx.stroke()
  ctx.fillStyle = face
  ctx.font = `700 10px ${MONO_FONT}`
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.fillText(label, 0, -14.5)
  ctx.restore()
}
