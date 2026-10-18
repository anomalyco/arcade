import { LIGHT_FLOATS, MAX_LIGHTS } from "../limits"

/** Default world-space cell size (m) for the 2D static lamp light-list grid (`uLampGrid`). */
export const LAMP_GRID_CELL = 0.5
/** Default grid dimension in cells along X and Z (`192 * 0.5 m = 96 m`). */
export const LAMP_GRID_DIM = 192
/** Maximum candidate static lamp indices stored per grid cell (`rgba8uint` texel = 4 bytes). */
export const LAMP_GRID_SLOTS = 4

/** Boundary epsilon (m) so float32 UV rounding at cell edges never drops a lamp touching a cell border. */
const CELL_EPS = 1e-3

export interface LampGridDirtyRows {
  minRow: number
  rowCount: number
}

export interface LampGridOptions {
  width?: number
  height?: number
  cellSize?: number
  /** Whether spotlights with `0.5 < cone.w <= 1.125` are clipped to their forward half-space `dot(dv, cone.xy) > 0` (default true). */
  halfSpaceSpotlights?: boolean
}

/**
 * Priority score for a static lamp at cell center `(ccx, ccz)` when a cell has more than `LAMP_GRID_SLOTS` candidates.
 * Uses the windowed inverse-square irradiance proxy at the cell center with a 2× boost for shadow-casting lamps.
 */
export function scoreLampAtCell(lights: Float32Array, slot: number, ccx: number, ccz: number): number {
  const base = slot * LIGHT_FLOATS
  const lx = lights[base]!
  const ly = lights[base + 1]!
  const lz = lights[base + 2]!
  const r = lights[base + 3]!
  const power = lights[base + 7]!
  if (power <= 0.001 || r <= 0) return 0
  const dx = ccx - lx
  const dz = ccz - lz
  const d2 = dx * dx + dz * dz
  const r2 = r * r
  const shadowBoost = lights[base + 13]! > 0.5 ? 2.0 : 1.0
  if (d2 >= r2) {
    // Cell corner overlaps the circle even though the cell center is just outside `r`
    return (power * shadowBoost * 1e-4) / (1 + d2)
  }
  const win = 1 - d2 / r2
  const d32 = d2 + ly * ly
  return power * shadowBoost * win * win * (0.025 + 2.25 / (1 + d32 * 0.62))
}

/**
 * Spatial 2D light-list grid (`uLampGrid`) for static lamps in `[directLightCount .. lightCount)`.
 * Each `0.5 m × 0.5 m` cell stores up to 4 1-based light slot indices (`0` = empty terminator) in an `rgba8uint`
 * texture so `lightSum` only evaluates the few static lamps overlapping a fragment's cell.
 */
export class LampGrid {
  readonly width: number
  readonly height: number
  readonly cellSize: number
  readonly halfSpaceSpotlights: boolean
  readonly words: Uint32Array
  readonly data: Uint8Array<ArrayBuffer>

  originX = 0
  originZ = 0
  directLightCount = 0
  lightCount = 0
  overflowCount = 0
  activeCellCount = 0
  buildCount = 0
  dirtyRows: LampGridDirtyRows | null = null

  private prevMinCx = 0
  private prevMaxCx = -1
  private prevMinCz = 0
  private prevMaxCz = -1
  private prevSigLen = -1
  private prevOriginX = Number.NaN
  private prevOriginZ = Number.NaN
  private prevDirectCount = -1
  private prevLightCount = -1
  private readonly prevSig = new Float32Array(MAX_LIGHTS * 11)

  constructor(options: LampGridOptions = {}) {
    this.width = options.width ?? LAMP_GRID_DIM
    this.height = options.height ?? LAMP_GRID_DIM
    this.cellSize = options.cellSize ?? LAMP_GRID_CELL
    this.halfSpaceSpotlights = options.halfSpaceSpotlights ?? true
    const buf = new ArrayBuffer(this.width * this.height * 4)
    this.words = new Uint32Array(buf)
    this.data = new Uint8Array(buf)
    this.dirtyRows = { minRow: 0, rowCount: this.height }
  }

  /** Updates the grid for `lights[directLightCount .. lightCount)` anchored at `(originX, originZ)`. Returns true if cells changed. */
  update(
    lights: Float32Array,
    directLightCount: number,
    lightCount: number,
    originX = 0,
    originZ = 0,
  ): boolean {
    const start = Math.max(0, Math.min(directLightCount, lightCount))
    const end = Math.max(start, Math.min(lightCount, MAX_LIGHTS))
    const staticCount = end - start

    if (
      originX === this.prevOriginX &&
      originZ === this.prevOriginZ &&
      start === this.prevDirectCount &&
      end === this.prevLightCount &&
      this.matchesSignature(lights, start, end, this.overflowCount > 0)
    ) {
      return false
    }

    this.recordSignature(lights, start, end)
    this.prevOriginX = originX
    this.prevOriginZ = originZ
    this.prevDirectCount = start
    this.prevLightCount = end
    this.originX = originX
    this.originZ = originZ
    this.directLightCount = start
    this.lightCount = end
    this.buildCount++

    const w = this.width
    const h = this.height
    const words = this.words

    // Clear only the previously touched bounding box
    const oldMinCz = this.prevMinCz
    const oldMaxCz = this.prevMaxCz
    if (oldMaxCz >= oldMinCz) {
      const c0 = this.prevMinCx
      const c1 = this.prevMaxCx
      for (let cz = oldMinCz; cz <= oldMaxCz; cz++) {
        words.fill(0, cz * w + c0, cz * w + c1 + 1)
      }
    }

    this.overflowCount = 0
    this.activeCellCount = 0

    if (staticCount === 0) {
      if (oldMaxCz >= oldMinCz) {
        this.markDirtyRows(oldMinCz, oldMaxCz)
      }
      this.prevMinCx = 0
      this.prevMaxCx = -1
      this.prevMinCz = 0
      this.prevMaxCz = -1
      return true
    }

    const cs = this.cellSize
    const invCs = 1 / cs
    let minCx = w
    let maxCx = -1
    let minCz = h
    let maxCz = -1

    for (let li = start; li < end; li++) {
      const base = li * LIGHT_FLOATS
      const lx = lights[base]!
      const lz = lights[base + 2]!
      const r = lights[base + 3]!
      const power = lights[base + 7]!
      if (power <= 0.001 || r <= 0) continue

      const cxDir = lights[base + 8]!
      const czDir = lights[base + 9]!
      const cosHalf = lights[base + 10]!
      const coneW = lights[base + 11]!
      const extraX = lights[base + 12]!
      const extraY = lights[base + 13]!

      let x0 = lx - r
      let z0 = lz - r
      let x1 = lx + r
      let z1 = lz + r

      // Table lamp room clip rect (`cone.w < -2.5` in Outbreak `lightMask`)
      const isTableClip = coneW < -2.5
      if (isTableClip) {
        x0 = Math.max(x0, cxDir - 0.03)
        z0 = Math.max(z0, czDir - 0.03)
        x1 = Math.min(x1, cosHalf + 0.03)
        z1 = Math.min(z1, extraX + 0.03)
        if (x0 >= x1 || z0 >= z1) continue
      }

      const isSconce = coneW > 1.125 && coneW < 1.5
      const isHalfSpaceSpot =
        coneW > 0.5 && coneW <= 1.125 && (this.halfSpaceSpotlights || cosHalf >= 0)

      const gx0 = Math.max(0, Math.floor((x0 - originX - CELL_EPS) * invCs))
      const gz0 = Math.max(0, Math.floor((z0 - originZ - CELL_EPS) * invCs))
      const gx1 = Math.min(w - 1, Math.floor((x1 - originX + CELL_EPS) * invCs))
      const gz1 = Math.min(h - 1, Math.floor((z1 - originZ + CELL_EPS) * invCs))
      if (gx0 > gx1 || gz0 > gz1) continue

      const r2 = r * r
      const slot1 = (li + 1) & 0xff
      const absTx = Math.abs(czDir)
      const absTz = Math.abs(cxDir)
      const sconceBack = -extraX - CELL_EPS
      const sconceAlongMin = extraY + 1.0 - CELL_EPS
      const sconceAlongMax = -1.25 - cosHalf + CELL_EPS

      for (let cz = gz0; cz <= gz1; cz++) {
        const cellZ0 = originZ + cz * cs - CELL_EPS
        const cellZ1 = cellZ0 + cs + 2 * CELL_EPS
        const dz = lz < cellZ0 ? cellZ0 - lz : lz > cellZ1 ? lz - cellZ1 : 0
        const dz2 = dz * dz
        if (dz2 >= r2) continue

        const dvZ0 = cellZ0 - lz
        const dvZ1 = cellZ1 - lz
        const rowOff = cz * w

        for (let cx = gx0; cx <= gx1; cx++) {
          const cellX0 = originX + cx * cs - CELL_EPS
          const cellX1 = cellX0 + cs + 2 * CELL_EPS
          const dx = lx < cellX0 ? cellX0 - lx : lx > cellX1 ? lx - cellX1 : 0
          if (dx * dx + dz2 >= r2) continue

          if (isSconce) {
            const dvX0 = cellX0 - lx
            const dvX1 = cellX1 - lx
            const maxDotN = (cxDir >= 0 ? dvX1 : dvX0) * cxDir + (czDir >= 0 ? dvZ1 : dvZ0) * czDir
            if (maxDotN < sconceBack) continue
            const minAlong = dvX0 * absTx + dvZ0 * absTz
            const maxAlong = dvX1 * absTx + dvZ1 * absTz
            if (maxAlong < sconceAlongMin || minAlong > sconceAlongMax) continue
          } else if (isHalfSpaceSpot) {
            const dvX0 = cellX0 - lx
            const dvX1 = cellX1 - lx
            const maxDotN = (cxDir >= 0 ? dvX1 : dvX0) * cxDir + (czDir >= 0 ? dvZ1 : dvZ0) * czDir
            if (maxDotN <= -CELL_EPS) continue
          }

          const idx = rowOff + cx
          const word = words[idx]!
          if (word === 0) {
            words[idx] = slot1
            this.activeCellCount++
          } else if ((word & 0xff00) === 0) {
            words[idx] = (word | (slot1 << 8)) >>> 0
          } else if ((word & 0xff0000) === 0) {
            words[idx] = (word | (slot1 << 16)) >>> 0
          } else if ((word & 0xff000000) === 0) {
            words[idx] = (word | (slot1 << 24)) >>> 0
          } else {
            this.overflowCount++
            const ccx = originX + (cx + 0.5) * cs
            const ccz = originZ + (cz + 0.5) * cs
            const newScore = scoreLampAtCell(lights, li, ccx, ccz)
            const s0 = (word & 0xff) - 1
            const s1 = ((word >>> 8) & 0xff) - 1
            const s2 = ((word >>> 16) & 0xff) - 1
            const s3 = ((word >>> 24) & 0xff) - 1
            let minScore = scoreLampAtCell(lights, s0, ccx, ccz)
            let minIdx = 0
            const sc1 = scoreLampAtCell(lights, s1, ccx, ccz)
            if (sc1 < minScore) {
              minScore = sc1
              minIdx = 1
            }
            const sc2 = scoreLampAtCell(lights, s2, ccx, ccz)
            if (sc2 < minScore) {
              minScore = sc2
              minIdx = 2
            }
            const sc3 = scoreLampAtCell(lights, s3, ccx, ccz)
            if (sc3 < minScore) {
              minScore = sc3
              minIdx = 3
            }
            if (newScore > minScore) {
              // Evict `minIdx` and shift remaining bytes down so the 4 slots stay in ascending slot order
              if (minIdx === 0) {
                words[idx] = ((word >>> 8) | (slot1 << 24)) >>> 0
              } else if (minIdx === 1) {
                words[idx] = ((word & 0xff) | ((word >>> 8) & 0xffff00) | (slot1 << 24)) >>> 0
              } else if (minIdx === 2) {
                words[idx] = ((word & 0xffff) | ((word >>> 8) & 0xff0000) | (slot1 << 24)) >>> 0
              } else {
                words[idx] = ((word & 0xffffff) | (slot1 << 24)) >>> 0
              }
            }
          }

          if (cx < minCx) minCx = cx
          if (cx > maxCx) maxCx = cx
          if (cz < minCz) minCz = cz
          if (cz > maxCz) maxCz = cz
        }
      }
    }

    const dirtyMin = oldMaxCz >= oldMinCz ? Math.min(oldMinCz, minCz) : minCz
    const dirtyMax = oldMaxCz >= oldMinCz ? Math.max(oldMaxCz, maxCz) : maxCz
    if (dirtyMax >= dirtyMin && dirtyMin < h && dirtyMax >= 0) {
      this.markDirtyRows(Math.max(0, dirtyMin), Math.min(h - 1, dirtyMax))
    }

    if (maxCz >= minCz) {
      this.prevMinCx = minCx
      this.prevMaxCx = maxCx
      this.prevMinCz = minCz
      this.prevMaxCz = maxCz
    } else {
      this.prevMinCx = 0
      this.prevMaxCx = -1
      this.prevMinCz = 0
      this.prevMaxCz = -1
    }
    return true
  }

  /** Marks all rows clean after `Renderer` uploads `dirtyRows` to `uLampGrid`. */
  markUploaded(): void {
    this.dirtyRows = null
  }

  /** Marks the entire grid dirty (e.g. when a new GPU texture is allocated). */
  markAllDirty(): void {
    this.dirtyRows = { minRow: 0, rowCount: this.height }
  }

  /** Returns the 4 0-based light slot indices at cell `(cx, cz)`, with `-1` for empty slots. */
  cellAt(cx: number, cz: number): [number, number, number, number] {
    if (cx < 0 || cx >= this.width || cz < 0 || cz >= this.height) return [-1, -1, -1, -1]
    const w = this.words[cz * this.width + cx]!
    return [
      (w & 0xff) - 1,
      ((w >>> 8) & 0xff) - 1,
      ((w >>> 16) & 0xff) - 1,
      ((w >>> 24) & 0xff) - 1,
    ]
  }

  /** Returns the non-empty 0-based light slot indices at world coordinates `(x, z)` matching WGSL `sampleLampGrid`. */
  slotsAtWorld(x: number, z: number): number[] {
    const mapW = this.width * this.cellSize
    const mapH = this.height * this.cellSize
    const u = (x - this.originX) / mapW
    const v = (z - this.originZ) / mapH
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return []
    const cx = Math.max(0, Math.min(this.width - 1, Math.floor(u * this.width)))
    const cz = Math.max(0, Math.min(this.height - 1, Math.floor(v * this.height)))
    const [s0, s1, s2, s3] = this.cellAt(cx, cz)
    const out: number[] = []
    if (s0 >= 0) out.push(s0)
    if (s1 >= 0) out.push(s1)
    if (s2 >= 0) out.push(s2)
    if (s3 >= 0) out.push(s3)
    return out
  }

  private markDirtyRows(minRow: number, maxRow: number): void {
    if (this.dirtyRows) {
      const curMin = this.dirtyRows.minRow
      const curMax = curMin + this.dirtyRows.rowCount - 1
      const nextMin = Math.min(curMin, minRow)
      const nextMax = Math.max(curMax, maxRow)
      this.dirtyRows = { minRow: nextMin, rowCount: nextMax - nextMin + 1 }
    } else {
      this.dirtyRows = { minRow, rowCount: maxRow - minRow + 1 }
    }
  }

  private matchesSignature(lights: Float32Array, start: number, end: number, checkPower: boolean): boolean {
    const sigLen = (end - start) * 11
    if (sigLen !== this.prevSigLen) return false
    const sig = this.prevSig
    let o = 0
    for (let li = start; li < end; li++) {
      const b = li * LIGHT_FLOATS
      const power = lights[b + 7]!
      const active = power > 0.001 && lights[b + 3]! > 0 ? 1 : 0
      if (sig[o]! !== active) return false
      if (active) {
        if (
          sig[o + 1]! !== lights[b]! ||
          sig[o + 2]! !== lights[b + 2]! ||
          sig[o + 3]! !== lights[b + 3]! ||
          sig[o + 4]! !== lights[b + 8]! ||
          sig[o + 5]! !== lights[b + 9]! ||
          sig[o + 6]! !== lights[b + 10]! ||
          sig[o + 7]! !== lights[b + 11]! ||
          sig[o + 8]! !== lights[b + 12]! ||
          sig[o + 9]! !== lights[b + 13]!
        ) {
          return false
        }
        if (checkPower && sig[o + 10]! !== power) return false
      }
      o += 11
    }
    return true
  }

  private recordSignature(lights: Float32Array, start: number, end: number): void {
    const sig = this.prevSig
    let o = 0
    for (let li = start; li < end; li++) {
      const b = li * LIGHT_FLOATS
      const power = lights[b + 7]!
      const active = power > 0.001 && lights[b + 3]! > 0 ? 1 : 0
      sig[o] = active
      sig[o + 1] = lights[b]!
      sig[o + 2] = lights[b + 2]!
      sig[o + 3] = lights[b + 3]!
      sig[o + 4] = lights[b + 8]!
      sig[o + 5] = lights[b + 9]!
      sig[o + 6] = lights[b + 10]!
      sig[o + 7] = lights[b + 11]!
      sig[o + 8] = lights[b + 12]!
      sig[o + 9] = lights[b + 13]!
      sig[o + 10] = power
      o += 11
    }
    this.prevSigLen = o
  }
}
