import { raycast, type Rect } from "@arcade/kit/sim/geom"
import { POLAR_RAYS } from "@arcade/kit/gpu/limits"
import type { PeekInfo } from "./interact"
import { SIZE } from "./map"

export type VisionSettings = { range: number; cone: number; awareness: number }
export const DEFAULT_VISION: VisionSettings = { range: 27, cone: 110, awareness: 2.5 }
export const FOG_CELL = .5
export const FOG_SIZE = SIZE / FOG_CELL
const TAU = Math.PI * 2

/** CPU counterpart to the shared polar compute pass, for persistent exploration (no GPU readback). */
export class Vision {
  readonly rays = new Float32Array(POLAR_RAYS)
  readonly explored = new Uint8Array(FOG_SIZE * FOG_SIZE)
  readonly chunkExplored = new Map<string, Uint8Array>()
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
                tile = new Uint8Array(64 * 64)
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
    const baseCx = Math.round(this.originX / 32)
    const baseCy = Math.round(this.originY / 32)
    for (let dy = 0; dy < 3; dy++) {
      for (let dx = 0; dx < 3; dx++) {
        const tile = this.chunkExplored.get(`${baseCx + dx},${baseCy + dy}`)
        if (!tile) continue
        for (let ly = 0; ly < 64; ly++) {
          const wy = dy * 64 + ly
          const rowOff = wy * FOG_SIZE + dx * 64
          const tileOff = ly * 64
          for (let lx = 0; lx < 64; lx++) {
            this.explored[rowOff + lx] = tile[tileOff + lx]!
          }
        }
      }
    }
  }

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
    const effectiveSettings = peek
      ? {
          range: settings.range,
          cone: Math.max(settings.cone, peek.cone),
          awareness: Math.max(settings.awareness, peek.awareness),
        }
      : settings
    this.x = ox; this.y = oy; this.aim = oAim; this.settings = effectiveSettings
    for (let i = 0; i < POLAR_RAYS; i++) {
      const a = (i + .5) / POLAR_RAYS * TAU
      this.rays[i] = Math.min(effectiveSettings.range, raycast(ox, oy, Math.cos(a), Math.sin(a), blockers, effectiveSettings.range))
    }
    let changed = false
    const r = effectiveSettings.range
    const minGy = Math.max(0, Math.floor((oy - this.originY - r) / FOG_CELL))
    const maxGy = Math.min(FOG_SIZE, Math.ceil((oy - this.originY + r) / FOG_CELL))
    const minGx = Math.max(0, Math.floor((ox - this.originX - r) / FOG_CELL))
    const maxGx = Math.min(FOG_SIZE, Math.ceil((ox - this.originX + r) / FOG_CELL))
    for (let gy = minGy; gy < maxGy; gy++) {
      for (let gx = minGx; gx < maxGx; gx++) {
        const idx = gy * FOG_SIZE + gx
        if (!this.explored[idx] && this.visible(this.originX + (gx + .5) * FOG_CELL, this.originY + (gy + .5) * FOG_CELL)) {
          this.explored[idx] = 255; changed = true
        }
      }
    }
    return changed
  }

  visible(x: number, y: number): boolean {
    const dx = x - this.x, dy = y - this.y, distance = Math.hypot(dx, dy)
    if (distance > this.settings.range) return false
    const a = (Math.atan2(dy, dx) + TAU) % TAU
    const ray = Math.floor(a / TAU * POLAR_RAYS) % POLAR_RAYS
    if (distance > this.rays[ray]! + .025) return false
    return distance <= this.settings.awareness || (dx * Math.cos(this.aim) + dy * Math.sin(this.aim)) / distance >= Math.cos(this.settings.cone * Math.PI / 360)
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
