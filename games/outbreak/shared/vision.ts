import { raycast, type Rect } from "@arcade/kit/sim/geom"
import { POLAR_RAYS } from "@arcade/kit/gpu/limits"
import type { PeekInfo } from "./interact"
import { SIZE } from "./map"

export type VisionSettings = { range: number; cone: number; awareness: number }
export const DEFAULT_VISION: VisionSettings = { range: 27, cone: 110, awareness: 2.5 }
export const FOG_CELL = .5
export const FOG_SIZE = SIZE / FOG_CELL
const TAU = Math.PI * 2

const RAY_COS = new Float64Array(POLAR_RAYS)
const RAY_SIN = new Float64Array(POLAR_RAYS)
for (let i = 0; i < POLAR_RAYS; i++) {
  const a = ((i + 0.5) / POLAR_RAYS) * TAU
  RAY_COS[i] = Math.cos(a)
  RAY_SIN[i] = Math.sin(a)
}

/** CPU counterpart to the shared polar compute pass, for persistent exploration (no GPU readback). */
export class Vision {
  readonly rays = new Float32Array(POLAR_RAYS)
  readonly explored = new Uint8Array(FOG_SIZE * FOG_SIZE)
  private readonly nearBlockers: Rect[] = []
  readonly chunkExplored = new Map<string, Uint8Array>()
  private readonly tilePool: Uint8Array[] = []
  private readonly maxCachedTiles = 64
  exploredCount = 0
  originX = 0
  originY = 0
  x = 0
  y = 0
  aim = 0
  settings: VisionSettings = { ...DEFAULT_VISION }

  setWindowOrigin(ox: number, oy: number): boolean {
    if (ox === this.originX && oy === this.originY) return false
    this.saveWindowToChunks()
    this.originX = ox
    this.originY = oy
    this.loadWindowFromChunks()
    return true
  }

  private saveWindowToChunks(): void {
    const baseCx = Math.round(this.originX / 32)
    const baseCy = Math.round(this.originY / 32)
    for (let dy = 0; dy < 3; dy++) {
      for (let dx = 0; dx < 3; dx++) {
        const key = `${baseCx + dx},${baseCy + dy}`
        let tile = this.chunkExplored.get(key)
        for (let ly = 0; ly < 64; ly++) {
          const wy = dy * 64 + ly
          for (let lx = 0; lx < 64; lx++) {
            const v = this.explored[wy * FOG_SIZE + (dx * 64 + lx)]!
            if (v > 0) {
              if (!tile) {
                tile = this.tilePool.pop() ?? new Uint8Array(64 * 64)
                tile.fill(0)
                if (this.chunkExplored.size >= this.maxCachedTiles) {
                  const oldest = this.chunkExplored.keys().next().value
                  if (oldest !== undefined) {
                    const ev = this.chunkExplored.get(oldest)
                    if (ev) this.tilePool.push(ev)
                    this.chunkExplored.delete(oldest)
                  }
                }
                this.chunkExplored.set(key, tile)
              }
              tile[ly * 64 + lx] = v
            }
          }
        }
      }
    }
  }

  private loadWindowFromChunks(): void {
    this.explored.fill(0)
    let count = 0
    const baseCx = Math.round(this.originX / 32)
    const baseCy = Math.round(this.originY / 32)
    for (let dy = 0; dy < 3; dy++) {
      for (let dx = 0; dx < 3; dx++) {
        const key = `${baseCx + dx},${baseCy + dy}`
        const tile = this.chunkExplored.get(key)
        if (!tile) continue
        // Refresh LRU order
        this.chunkExplored.delete(key)
        this.chunkExplored.set(key, tile)
        for (let ly = 0; ly < 64; ly++) {
          const wy = dy * 64 + ly
          const rowOff = wy * FOG_SIZE + dx * 64
          const tileOff = ly * 64
          for (let lx = 0; lx < 64; lx++) {
            const v = tile[tileOff + lx]!
            if (v > 0) {
              this.explored[rowOff + lx] = v
              count++
            }
          }
        }
      }
    }
    this.exploredCount = count
  }

  private aimCos = 1
  private aimSin = 0
  private coneCos = Math.cos((DEFAULT_VISION.cone * Math.PI) / 360)

  update(
    x: number,
    y: number,
    aim: number,
    blockers: readonly Rect[],
    settings = this.settings,
    peek?: PeekInfo | null,
  ): boolean {
    const ox = peek ? peek.eyeX : x
    const oy = peek ? peek.eyeY : y
    const oAim = peek ? peek.aim : aim
    const range = settings.range
    const cone = peek ? Math.max(settings.cone, peek.cone) : settings.cone
    const awareness = peek ? Math.max(settings.awareness, peek.awareness) : settings.awareness
    this.x = ox
    this.y = oy
    this.aim = oAim
    this.settings.range = range
    this.settings.cone = cone
    this.settings.awareness = awareness
    const aimCos = Math.cos(oAim)
    const aimSin = Math.sin(oAim)
    const coneCos = Math.cos((cone * Math.PI) / 360)
    this.aimCos = aimCos
    this.aimSin = aimSin
    this.coneCos = coneCos

    const minBx = ox - range
    const maxBx = ox + range
    const minBy = oy - range
    const maxBy = oy + range
    const near = this.nearBlockers
    near.length = 0
    for (let b = 0; b < blockers.length; b++) {
      const rect = blockers[b]!
      if (rect[2] >= minBx && rect[0] <= maxBx && rect[3] >= minBy && rect[1] <= maxBy) {
        near.push(rect)
      }
    }
    for (let i = 0; i < POLAR_RAYS; i++) {
      this.rays[i] = Math.min(range, raycast(ox, oy, RAY_COS[i]!, RAY_SIN[i]!, near, range))
    }
    let changed = false
    const r2 = range * range
    const aware2 = awareness * awareness
    const coneCos2 = coneCos * Math.abs(coneCos)
    const minGy = Math.max(0, Math.floor((oy - this.originY - range) / FOG_CELL))
    const maxGy = Math.min(FOG_SIZE, Math.ceil((oy - this.originY + range) / FOG_CELL))
    const minGx = Math.max(0, Math.floor((ox - this.originX - range) / FOG_CELL))
    const maxGx = Math.min(FOG_SIZE, Math.ceil((ox - this.originX + range) / FOG_CELL))
    const baseWx = this.originX + 0.5 * FOG_CELL - ox
    const baseWy = this.originY + 0.5 * FOG_CELL - oy
    const rays = this.rays
    const explored = this.explored
    const invTauRays = POLAR_RAYS / TAU

    for (let gy = minGy; gy < maxGy; gy++) {
      const dy = baseWy + gy * FOG_CELL
      const dy2 = dy * dy
      const rowOff = gy * FOG_SIZE
      const dySin = dy * aimSin
      for (let gx = minGx; gx < maxGx; gx++) {
        const idx = rowOff + gx
        if (explored[idx]) continue
        const dx = baseWx + gx * FOG_CELL
        const d2 = dx * dx + dy2
        if (d2 > r2) continue
        if (d2 > aware2) {
          const dot = dx * aimCos + dySin
          if (coneCos >= 0 ? dot < 0 || dot * dot < d2 * coneCos2 : dot < 0 && dot * dot > d2 * -coneCos2) {
            continue
          }
        }
        const distance = Math.sqrt(d2)
        const a = Math.atan2(dy, dx)
        const ray = Math.floor((a < 0 ? a + TAU : a) * invTauRays) % POLAR_RAYS
        if (distance <= rays[ray]! + 0.025) {
          explored[idx] = 255
          this.exploredCount++
          changed = true
        }
      }
    }
    return changed
  }

  visible(x: number, y: number): boolean {
    const dx = x - this.x
    const dy = y - this.y
    const d2 = dx * dx + dy * dy
    const r = this.settings.range
    if (d2 > r * r) return false
    const distance = Math.sqrt(d2)
    const a = Math.atan2(dy, dx)
    const ray = Math.floor(((a < 0 ? a + TAU : a) / TAU) * POLAR_RAYS) % POLAR_RAYS
    if (distance > this.rays[ray]! + 0.025) return false
    return distance <= this.settings.awareness || (dx * this.aimCos + dy * this.aimSin) / distance >= this.coneCos
  }

  /**
   * Authoritative actor LOS visibility weight in [0, 1].
   * Samples the actor's center and lateral shoulder disk against the polar blocker map so actors peeking through
   * doorways or straddling discrete polar ray bins are never falsely culled, while strictly blocking through walls/doors.
   */
  actorVisible(x: number, y: number, radius = 0.28): number {
    const dx = x - this.x
    const dy = y - this.y
    const distance = Math.hypot(dx, dy)
    if (distance > this.settings.range + radius) return 0
    if (distance <= 0.05) return 1
    const invD = 1 / distance
    const px = -dy * invD * radius * 0.85
    const py = dx * invD * radius * 0.85
    const aimCos = Math.cos(this.aim)
    const aimSin = Math.sin(this.aim)
    const cosHalf = Math.cos((this.settings.cone * Math.PI) / 360)
    const featherCos = cosHalf - 0.065
    let best = 0
    for (let k = -1; k <= 1; k++) {
      const sdx = dx + px * k
      const sdy = dy + py * k
      const sDist = Math.hypot(sdx, sdy)
      if (sDist > this.settings.range || sDist <= 1e-4) continue
      const a = (Math.atan2(sdy, sdx) + TAU) % TAU
      const ray = Math.floor((a / TAU) * POLAR_RAYS) % POLAR_RAYS
      if (sDist > this.rays[ray]! + 0.055) continue
      let coneWeight = 0
      if (sDist <= this.settings.awareness) {
        coneWeight = 1
      } else if (sDist <= this.settings.awareness + 0.35) {
        coneWeight = 1 - (sDist - this.settings.awareness) / 0.35
      }
      const facing = (sdx * aimCos + sdy * aimSin) / sDist
      if (facing >= cosHalf) {
        coneWeight = 1
      } else if (facing > featherCos) {
        coneWeight = Math.max(coneWeight, (facing - featherCos) / (cosHalf - featherCos))
      }
      if (coneWeight <= 0) continue
      const rangeWeight = sDist <= this.settings.range - 1.2 ? 1 : Math.max(0, (this.settings.range - sDist) / 1.2)
      const w = coneWeight * rangeWeight * (k === 0 ? 1 : 0.92)
      if (w > best) best = w
    }
    return Number(best.toFixed(4))
  }

  state(x: number, y: number): "visible" | "explored" | "unexplored" {
    if (this.visible(x, y)) return "visible"
    const lx = x - this.originX
    const ly = y - this.originY
    if (lx >= 0 && ly >= 0 && lx < SIZE && ly < SIZE) {
      return this.explored[Math.floor(ly / FOG_CELL) * FOG_SIZE + Math.floor(lx / FOG_CELL)] ? "explored" : "unexplored"
    }
    const cx = Math.floor(x / 32)
    const cy = Math.floor(y / 32)
    const tile = this.chunkExplored.get(`${cx},${cy}`)
    if (!tile) return "unexplored"
    const tx = Math.max(0, Math.min(63, Math.floor((x - cx * 32) / FOG_CELL)))
    const ty = Math.max(0, Math.min(63, Math.floor((y - cy * 32) / FOG_CELL)))
    return tile[ty * 64 + tx] ? "explored" : "unexplored"
  }
}
