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
  x = 0
  y = 0
  aim = 0
  settings: VisionSettings = { ...DEFAULT_VISION }

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
    for (let gy = Math.max(0, Math.floor((oy - r) / FOG_CELL)); gy < Math.min(FOG_SIZE, Math.ceil((oy + r) / FOG_CELL)); gy++) {
      for (let gx = Math.max(0, Math.floor((ox - r) / FOG_CELL)); gx < Math.min(FOG_SIZE, Math.ceil((ox + r) / FOG_CELL)); gx++) {
        const idx = gy * FOG_SIZE + gx
        if (!this.explored[idx] && this.visible((gx + .5) * FOG_CELL, (gy + .5) * FOG_CELL)) {
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
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return "unexplored"
    return this.explored[Math.floor(y / FOG_CELL) * FOG_SIZE + Math.floor(x / FOG_CELL)] ? "explored" : "unexplored"
  }
}
