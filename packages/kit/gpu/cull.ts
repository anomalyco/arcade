/**
 * Shared frustum plane extraction, 3D AABB / 2D plan-rect culling, and
 * contiguous vertex-range draw merging for WebGPU passes.
 */

export interface ContiguousChunkRange {
  readonly first: number
  readonly count: number
}

export interface ChunkDrawStats {
  chunksDrawn: number
  vertsDrawn: number
  drawCalls: number
}

export interface ChunkDrawEncoder {
  draw(vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number): void
}

/**
 * Extracts the 6 clip-space frustum planes (Left, Right, Bottom, Top, Near [0..1 WebGPU depth], Far)
 * from a column-major 4x4 view-projection matrix `m` starting at float offset `mOff` into `out` (24 floats).
 */
export function extractFrustumPlanes(m: Float32Array, mOff: number, out: Float32Array): void {
  const m0 = m[mOff]!,
    m1 = m[mOff + 1]!,
    m2 = m[mOff + 2]!,
    m3 = m[mOff + 3]!
  const m4 = m[mOff + 4]!,
    m5 = m[mOff + 5]!,
    m6 = m[mOff + 6]!,
    m7 = m[mOff + 7]!
  const m8 = m[mOff + 8]!,
    m9 = m[mOff + 9]!,
    m10 = m[mOff + 10]!,
    m11 = m[mOff + 11]!
  const m12 = m[mOff + 12]!,
    m13 = m[mOff + 13]!,
    m14 = m[mOff + 14]!,
    m15 = m[mOff + 15]!
  // Left
  out[0] = m3 + m0
  out[1] = m7 + m4
  out[2] = m11 + m8
  out[3] = m15 + m12
  // Right
  out[4] = m3 - m0
  out[5] = m7 - m4
  out[6] = m11 - m8
  out[7] = m15 - m12
  // Bottom
  out[8] = m3 + m1
  out[9] = m7 + m5
  out[10] = m11 + m9
  out[11] = m15 + m13
  // Top
  out[12] = m3 - m1
  out[13] = m7 - m5
  out[14] = m11 - m9
  out[15] = m15 - m13
  // Near (WebGPU 0..1 depth)
  out[16] = m2
  out[17] = m6
  out[18] = m10
  out[19] = m14
  // Far
  out[20] = m3 - m2
  out[21] = m7 - m6
  out[22] = m11 - m10
  out[23] = m15 - m14
}

/**
 * Tests whether the axis-aligned bounding box `[minX, minY, minZ]..[maxX, maxY, maxZ]`
 * is inside or intersecting all 6 frustum planes packed in `planes` (24 floats).
 */
export function aabbInFrustum(
  planes: Float32Array,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): boolean {
  for (let i = 0; i < 24; i += 4) {
    const px = planes[i]!,
      py = planes[i + 1]!,
      pz = planes[i + 2]!,
      pw = planes[i + 3]!
    const vx = px >= 0 ? maxX : minX
    const vy = py >= 0 ? maxY : minY
    const vz = pz >= 0 ? maxZ : minZ
    if (px * vx + py * vy + pz * vz + pw < 0) return false
  }
  return true
}

/**
 * Tests whether a 2D plan-space bounding box `[x0, z0, x1, z1]` intersects
 * the view rectangle `[vx0, vz0, vx1, vz1]`.
 */
export function boxIntersectsRect2D(
  box: readonly [number, number, number, number],
  rect: readonly [number, number, number, number],
): boolean {
  return !(box[0] > rect[2] || box[2] < rect[0] || box[1] > rect[3] || box[3] < rect[1])
}

/**
 * Tests whether a static chunk should be drawn into an orthographic directional shadow map:
 * the chunk must rise above `minHeight`, intersect `shadowPlanes`, and its swept shadow
 * (`maxX + maxY * sweepSlope`, `maxZ + maxY * sweepSlope`) must intersect `camPlanes`.
 */
export function isShadowCasterVisible(
  shadowPlanes: Float32Array,
  camPlanes: Float32Array,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  sweepSlope = 0.92,
  minHeight = 0.05,
): boolean {
  if (maxY <= minHeight) return false
  if (!aabbInFrustum(shadowPlanes, minX, minY, minZ, maxX, maxY, maxZ)) return false
  const sweep = Math.max(0, maxY) * sweepSlope
  return aabbInFrustum(camPlanes, minX, 0, minZ, maxX + sweep, maxY, maxZ + sweep)
}

/**
 * Culls `chunks` using `isVisible` and merges adjacent visible chunks whose vertex ranges
 * are contiguous (`runFirst + runCount === chunk.first`) into single `pass.draw` calls.
 */
export function drawContiguousChunks<C extends ContiguousChunkRange>(
  pass: ChunkDrawEncoder,
  chunks: readonly C[],
  isVisible: (chunk: C, index: number) => boolean,
): ChunkDrawStats {
  let chunksDrawn = 0
  let vertsDrawn = 0
  let drawCalls = 0
  let runFirst = -1
  let runCount = 0
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!
    if (!isVisible(c, i)) continue
    chunksDrawn++
    vertsDrawn += c.count
    if (runCount > 0 && runFirst + runCount === c.first) {
      runCount += c.count
    } else {
      if (runCount > 0) {
        pass.draw(runCount, 1, runFirst, 0)
        drawCalls++
      }
      runFirst = c.first
      runCount = c.count
    }
  }
  if (runCount > 0) {
    pass.draw(runCount, 1, runFirst, 0)
    drawCalls++
  }
  return { chunksDrawn, vertsDrawn, drawCalls }
}

/**
 * Culls and classifies `chunks` into a pipeline mode `M` (or `null` when culled),
 * merging contiguous runs that share the same mode `M` before switching pipelines.
 */
export function drawContiguousChunksByMode<C extends ContiguousChunkRange, M>(
  pass: ChunkDrawEncoder,
  chunks: readonly C[],
  classify: (chunk: C, index: number) => M | null,
  onModeChange: (mode: M) => void,
  initialMode: M,
): ChunkDrawStats {
  let chunksDrawn = 0
  let vertsDrawn = 0
  let drawCalls = 0
  let currentMode = initialMode
  let runFirst = -1
  let runCount = 0
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!
    const nextMode = classify(c, i)
    if (nextMode === null) continue
    chunksDrawn++
    vertsDrawn += c.count
    if (nextMode !== currentMode) {
      if (runCount > 0) {
        pass.draw(runCount, 1, runFirst, 0)
        drawCalls++
        runCount = 0
      }
      currentMode = nextMode
      onModeChange(currentMode)
    }
    if (runCount > 0 && runFirst + runCount === c.first) {
      runCount += c.count
    } else {
      if (runCount > 0) {
        pass.draw(runCount, 1, runFirst, 0)
        drawCalls++
      }
      runFirst = c.first
      runCount = c.count
    }
  }
  if (runCount > 0) {
    pass.draw(runCount, 1, runFirst, 0)
    drawCalls++
  }
  return { chunksDrawn, vertsDrawn, drawCalls }
}
