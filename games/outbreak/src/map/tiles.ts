import { CHUNK } from "../../shared/map"
import { chunkKey } from "../../shared/world"
import type { Ctx2D } from "./icons"
import { MAP_TILE, type MapBuilding, type MapChunk, type MapMemory } from "./memory"
import type { MapPalette } from "./style"

/**
 * One level of the tile pyramid: `d` device pixels per metre, `cpt` chunks per tile side. Levels halve in density so a
 * tile is never drawn smaller than half or larger than its own size, except past the finest level.
 */
export type TileLevel = { d: number; cpt: number; size: number }

export const LEVELS: readonly TileLevel[] = [16, 8, 4, 2, 1, 0.5, 0.25, 0.125, 0.0625].map((d) => {
  const cpt = Math.max(1, Math.round(4 / d))
  return { d, cpt, size: Math.round(CHUNK * d * cpt) }
})

/** Finest level whose density is at least `devicePxPerMetre`, or the finest level when zoomed past it. */
export function pickLevel(devicePxPerMetre: number): number {
  for (let i = LEVELS.length - 1; i >= 0; i--) if (LEVELS[i]!.d >= devicePxPerMetre) return i
  return 0
}

export type MapViewport = {
  /** World point at the centre of the view. */
  x: number
  y: number
  /** CSS pixels per metre. */
  zoom: number
  /** View size in CSS pixels. */
  w: number
  h: number
  dpr: number
}

type Tile = {
  key: string
  level: number
  tx: number
  ty: number
  canvas: OffscreenCanvas | HTMLCanvasElement | null
  dirty: boolean
  used: number
  bytes: number
}

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h)
  const c = document.createElement("canvas")
  c.width = w
  c.height = h
  return c
}

function context(c: AnyCanvas): Ctx2D {
  return c.getContext("2d") as Ctx2D
}

export type TileStats = { built: number; buildMs: number; maxBuildMs: number; cached: number; bytes: number; pending: number }

/**
 * Cached raster tiles of the explored map, built from `MapMemory`'s per-chunk data. A tile is rebuilt only when a chunk
 * inside it changes and the tile is on screen, within a per-frame time budget; until then the stale tile, or a coarser
 * level scaled up, stands in. Tiles with no explored chunk are never allocated, so memory follows what was explored.
 */
export class MapTiles {
  private readonly cache = new Map<string, Tile>()
  private readonly occupied: Set<string>[] = LEVELS.map(() => new Set())
  private readonly scratch = new Map<number, { ground: AnyCanvas; mask: AnyCanvas }>()
  private readonly maskCell = makeCanvas(MAP_TILE, MAP_TILE)
  private readonly maskImage = new ImageData(MAP_TILE, MAP_TILE)
  private bytes = 0
  private frame = 0
  palette: MapPalette
  /** Tile memory budget in bytes. Tiles not drawn this frame are evicted oldest first past it. */
  budgetBytes = 96 * 1024 * 1024
  readonly stats: TileStats = { built: 0, buildMs: 0, maxBuildMs: 0, cached: 0, bytes: 0, pending: 0 }

  constructor(
    private readonly memory: MapMemory,
    palette: MapPalette,
  ) {
    this.palette = palette
    for (const c of memory.chunks.values()) this.occupy(c)
  }

  setPalette(p: MapPalette): void {
    if (p === this.palette) return
    this.palette = p
    for (const t of this.cache.values()) t.dirty = true
  }

  clear(): void {
    this.cache.clear()
    for (const s of this.occupied) s.clear()
    this.bytes = 0
  }

  private tileKey(level: number, tx: number, ty: number): string {
    return `${level}:${tx},${ty}`
  }

  private occupy(c: MapChunk): void {
    for (let l = 0; l < LEVELS.length; l++) {
      const cpt = LEVELS[l]!.cpt
      this.occupied[l]!.add(this.tileKey(l, Math.floor(c.cx / cpt), Math.floor(c.cy / cpt)))
    }
  }

  /** Marks the tiles holding these chunks as stale. */
  invalidate(keys: readonly string[]): void {
    for (const key of keys) {
      const c = this.memory.chunks.get(key)
      if (!c) continue
      this.occupy(c)
      // Neighbouring tiles draw this chunk's overhang too.
      for (let l = 0; l < LEVELS.length; l++) {
        const cpt = LEVELS[l]!.cpt
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const t = this.cache.get(this.tileKey(l, Math.floor((c.cx + dx) / cpt), Math.floor((c.cy + dy) / cpt)))
            if (t) t.dirty = true
          }
        }
      }
    }
  }

  /** Draws the tiles covering `view` into `ctx` (CSS-pixel transform already set) and builds missing ones in budget. */
  draw(ctx: Ctx2D, view: MapViewport, budgetMs: number): boolean {
    this.frame++
    const level = pickLevel(view.zoom * view.dpr)
    const need = this.visible(view, level)
    const pending = this.build(need, budgetMs)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = "high"
    for (const n of need) {
      const t = this.cache.get(n.key)
      if (t?.canvas) this.blit(ctx, view, t, level)
      else this.fallback(ctx, view, level, n.tx, n.ty)
    }
    this.evict()
    return pending
  }

  /** Builds stale tiles a view would need without drawing, so opening the map finds them ready. */
  prewarm(view: MapViewport, budgetMs: number): boolean {
    this.frame++
    return this.build(this.visible(view, pickLevel(view.zoom * view.dpr)), budgetMs)
  }

  private visible(view: MapViewport, level: number): { key: string; tx: number; ty: number; d2: number }[] {
    const L = LEVELS[level]!
    const span = L.cpt * CHUNK
    const halfW = view.w / 2 / view.zoom
    const halfH = view.h / 2 / view.zoom
    const tx0 = Math.floor((view.x - halfW) / span)
    const tx1 = Math.floor((view.x + halfW) / span)
    const ty0 = Math.floor((view.y - halfH) / span)
    const ty1 = Math.floor((view.y + halfH) / span)
    const occ = this.occupied[level]!
    const out: { key: string; tx: number; ty: number; d2: number }[] = []
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const key = this.tileKey(level, tx, ty)
        if (!occ.has(key)) continue
        const mx = (tx + 0.5) * span - view.x
        const my = (ty + 0.5) * span - view.y
        out.push({ key, tx, ty, d2: mx * mx + my * my })
      }
    }
    return out
  }

  private build(need: { key: string; tx: number; ty: number; d2: number }[], budgetMs: number): boolean {
    const todo = need.filter((n) => {
      const t = this.cache.get(n.key)
      if (t) t.used = this.frame
      return !t || t.dirty
    })
    todo.sort((a, b) => a.d2 - b.d2)
    const start = performance.now()
    let i = 0
    for (; i < todo.length; i++) {
      if (i > 0 && performance.now() - start >= budgetMs) break
      const n = todo[i]!
      this.buildTile(Number(n.key.slice(0, n.key.indexOf(":"))), n.tx, n.ty)
    }
    this.stats.pending = todo.length - i
    this.stats.cached = this.cache.size
    this.stats.bytes = this.bytes
    return i < todo.length
  }

  private blit(ctx: Ctx2D, view: MapViewport, t: Tile, level: number): void {
    const L = LEVELS[level]!
    const span = L.cpt * CHUNK
    const r = this.screenRect(view, t.tx * span, t.ty * span, span)
    ctx.drawImage(t.canvas!, r[0], r[1], r[2], r[3])
  }

  /** Device-pixel-aligned screen rectangle of a world square, so neighbouring tiles meet without seams. */
  private screenRect(view: MapViewport, wx: number, wy: number, span: number): [number, number, number, number] {
    const s = view.zoom * view.dpr
    const x0 = Math.round((wx - view.x) * s + (view.w * view.dpr) / 2)
    const y0 = Math.round((wy - view.y) * s + (view.h * view.dpr) / 2)
    const x1 = Math.round((wx + span - view.x) * s + (view.w * view.dpr) / 2)
    const y1 = Math.round((wy + span - view.y) * s + (view.h * view.dpr) / 2)
    return [x0 / view.dpr, y0 / view.dpr, (x1 - x0) / view.dpr, (y1 - y0) / view.dpr]
  }

  /** Stands in for a tile that is not built yet with the part of a coarser cached tile that covers it. */
  private fallback(ctx: Ctx2D, view: MapViewport, level: number, tx: number, ty: number): void {
    const L = LEVELS[level]!
    const span = L.cpt * CHUNK
    for (let l = level + 1; l < LEVELS.length; l++) {
      const P = LEVELS[l]!
      const ratio = P.cpt / L.cpt
      const ptx = Math.floor(tx / ratio)
      const pty = Math.floor(ty / ratio)
      const t = this.cache.get(this.tileKey(l, ptx, pty))
      if (!t?.canvas) continue
      t.used = this.frame
      const sub = P.size / ratio
      const r = this.screenRect(view, tx * span, ty * span, span)
      ctx.drawImage(t.canvas, (tx - ptx * ratio) * sub, (ty - pty * ratio) * sub, sub, sub, r[0], r[1], r[2], r[3])
      return
    }
  }

  /** Chunks inside the tile plus a one-chunk ring, whose buildings, trees and fog edges reach across the border. */
  private chunksIn(tx: number, ty: number, cpt: number): MapChunk[] {
    const out: MapChunk[] = []
    const cx0 = tx * cpt - 1
    const cy0 = ty * cpt - 1
    const n = cpt + 2
    if (n * n > this.memory.chunks.size) {
      for (const c of this.memory.chunks.values()) if (c.cx >= cx0 && c.cx < cx0 + n && c.cy >= cy0 && c.cy < cy0 + n) out.push(c)
    } else {
      for (let cy = cy0; cy < cy0 + n; cy++) {
        for (let cx = cx0; cx < cx0 + n; cx++) {
          const c = this.memory.chunks.get(chunkKey(cx, cy))
          if (c) out.push(c)
        }
      }
    }
    return out
  }

  private scratchFor(size: number, pad: number): { ground: AnyCanvas; mask: AnyCanvas } {
    let s = this.scratch.get(size)
    if (!s) {
      s = { ground: makeCanvas(size, size), mask: makeCanvas(size + pad * 2, size + pad * 2) }
      this.scratch.set(size, s)
    }
    return s
  }

  private buildTile(level: number, tx: number, ty: number): void {
    const t0 = performance.now()
    const L = LEVELS[level]!
    const key = this.tileKey(level, tx, ty)
    let tile = this.cache.get(key)
    const chunks = this.chunksIn(tx, ty, L.cpt)
    const cx0 = tx * L.cpt
    const cy0 = ty * L.cpt
    const inside = chunks.some((c) => c.cx >= cx0 && c.cx < cx0 + L.cpt && c.cy >= cy0 && c.cy < cy0 + L.cpt)
    if (!tile) {
      tile = { key, level, tx, ty, canvas: null, dirty: true, used: this.frame, bytes: 0 }
      this.cache.set(key, tile)
    }
    tile.dirty = false
    tile.used = this.frame
    if (!inside) return
    if (!tile.canvas) {
      tile.canvas = makeCanvas(L.size, L.size)
      tile.bytes = L.size * L.size * 4
      this.bytes += tile.bytes
    }
    const P = this.palette
    const d = L.d
    const ox = tx * L.cpt * CHUNK
    const oy = ty * L.cpt * CHUNK
    // The fog edge is softened by about half a metre; the mask is padded so the blur doesn't fade at the tile seam.
    const blur = d >= 2 ? 0.55 * d : 0
    const pad = Math.ceil(blur * 3)
    const { ground, mask } = this.scratchFor(L.size, pad)
    const g = context(ground)
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.globalCompositeOperation = "source-over"
    g.clearRect(0, 0, L.size, L.size)
    g.setTransform(d, 0, 0, d, -ox * d, -oy * d)
    for (const c of chunks) drawGround(g, c, P, d)

    const m = context(mask)
    m.setTransform(1, 0, 0, 1, 0, 0)
    m.clearRect(0, 0, L.size + pad * 2, L.size + pad * 2)
    m.imageSmoothingEnabled = true
    m.imageSmoothingQuality = "high"
    m.setTransform(d, 0, 0, d, pad - ox * d, pad - oy * d)
    const cell = context(this.maskCell)
    const px = this.maskImage.data
    for (const c of chunks) {
      for (let i = 0; i < c.explored.length; i++) {
        px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = 0
        px[i * 4 + 3] = c.explored[i]!
      }
      cell.putImageData(this.maskImage, 0, 0)
      m.drawImage(this.maskCell, c.cx * CHUNK, c.cy * CHUNK, CHUNK, CHUNK)
    }
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.globalCompositeOperation = "destination-in"
    if (blur) g.filter = `blur(${blur.toFixed(2)}px)`
    g.drawImage(mask, -pad, -pad)
    g.filter = "none"
    g.globalCompositeOperation = "source-over"

    const ctx = context(tile.canvas)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, L.size, L.size)
    ctx.drawImage(ground, 0, 0)
    ctx.setTransform(d, 0, 0, d, -ox * d, -oy * d)
    for (const c of chunks) for (const b of c.buildings) if (b.known) drawBuilding(ctx, b, P, d)
    const ms = performance.now() - t0
    this.stats.built++
    this.stats.buildMs += ms
    this.stats.maxBuildMs = Math.max(this.stats.maxBuildMs, ms)
  }

  private evict(): void {
    if (this.bytes <= this.budgetBytes) return
    const old = [...this.cache.values()].filter((t) => t.canvas && t.used < this.frame).sort((a, b) => a.used - b.used)
    for (const t of old) {
      if (this.bytes <= this.budgetBytes * 0.85) break
      this.cache.delete(t.key)
      this.bytes -= t.bytes
    }
  }
}

/** Explored ground of one chunk in world units: district tint, trees, roads, cars and fences. Masked by the caller. */
function drawGround(ctx: Ctx2D, c: MapChunk, P: MapPalette, d: number): void {
  const x0 = c.cx * CHUNK
  const y0 = c.cy * CHUNK
  const px = 1 / d
  ctx.fillStyle = P.ground[c.district]
  ctx.fillRect(x0, y0, CHUNK, CHUNK)
  if (d >= 0.2 && c.trees.length) {
    ctx.fillStyle = P.tree
    ctx.beginPath()
    for (let i = 0; i < c.trees.length; i += 3) {
      ctx.moveTo(c.trees[i]! + c.trees[i + 2]!, c.trees[i + 1]!)
      ctx.arc(c.trees[i]!, c.trees[i + 1]!, c.trees[i + 2]!, 0, Math.PI * 2)
    }
    ctx.fill()
    if (d >= 1) {
      ctx.strokeStyle = P.treeEdge
      ctx.lineWidth = 0.9 * px
      ctx.stroke()
    }
  }
  const ns = c.lx === 1
  const ew = c.ly === 1
  ctx.fillStyle = P.sidewalk
  if (ns) ctx.fillRect(x0 + 6, y0, 12, CHUNK)
  if (ew) ctx.fillRect(x0, y0 + 6, CHUNK, 12)
  ctx.fillStyle = P.road
  if (ns) ctx.fillRect(x0 + 8, y0, 8, CHUNK)
  if (ew) ctx.fillRect(x0, y0 + 8, CHUNK, 8)
  if (ns || ew) {
    ctx.strokeStyle = P.roadEdge
    ctx.lineWidth = Math.max(0.1, 1.1 * px)
    ctx.beginPath()
    // Kerb lines stop at the crossing so the junction reads open.
    const along = (fixed: number, vertical: boolean) => {
      const spans: [number, number][] = (vertical ? ew : ns) ? [[0, 8], [16, CHUNK]] : [[0, CHUNK]]
      for (const [a, b] of spans) {
        if (vertical) {
          ctx.moveTo(x0 + fixed, y0 + a)
          ctx.lineTo(x0 + fixed, y0 + b)
        } else {
          ctx.moveTo(x0 + a, y0 + fixed)
          ctx.lineTo(x0 + b, y0 + fixed)
        }
      }
    }
    if (ns) {
      along(8, true)
      along(16, true)
    }
    if (ew) {
      along(8, false)
      along(16, false)
    }
    ctx.stroke()
    if (d >= 1) {
      ctx.strokeStyle = P.roadCentre
      ctx.lineWidth = Math.max(0.12, 1 * px)
      ctx.setLineDash([2, 2])
      ctx.beginPath()
      if (ns) along(12, true)
      if (ew) along(12, false)
      ctx.stroke()
      ctx.setLineDash([])
    }
  }
  if (d >= 0.5) {
    ctx.fillStyle = P.vehicle
    for (const v of c.vehicles) ctx.fillRect(v[0], v[1], v[2] - v[0], v[3] - v[1])
    ctx.fillStyle = P.fence
    for (const f of c.fences) {
      const w = Math.max(f[2] - f[0], 1.2 * px)
      const h = Math.max(f[3] - f[1], 1.2 * px)
      ctx.fillRect(f[0], f[1], w, h)
    }
  }
}

/** A known building: an ink outline just outside the footprint, the category fill and survey hatching up close. */
function drawBuilding(ctx: Ctx2D, b: MapBuilding, P: MapPalette, d: number): void {
  const lw = Math.max(0.15, 1.4 / d)
  ctx.fillStyle = P.ink
  for (const r of b.footprint) ctx.fillRect(r[0] - lw, r[1] - lw, r[2] - r[0] + lw * 2, r[3] - r[1] + lw * 2)
  ctx.fillStyle = b.poi ? P.poi[b.poi] : P.house
  for (const r of b.footprint) ctx.fillRect(r[0], r[1], r[2] - r[0], r[3] - r[1])
  if (d < 3) return
  ctx.save()
  ctx.beginPath()
  for (const r of b.footprint) ctx.rect(r[0], r[1], r[2] - r[0], r[3] - r[1])
  ctx.clip()
  ctx.strokeStyle = P.hatch
  ctx.lineWidth = 1 / d
  ctx.beginPath()
  const [x0, y0, x1, y1] = b.rect
  for (let k = x0 - (y1 - y0); k < x1; k += 1.2) {
    ctx.moveTo(k, y1)
    ctx.lineTo(k + (y1 - y0), y0)
  }
  ctx.stroke()
  ctx.restore()
}
