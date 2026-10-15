import { describe, expect, test } from "bun:test"
import { mat4 } from "wgpu-matrix"
import {
  aabbInFrustum,
  boxIntersectsRect2D,
  drawContiguousChunks,
  drawContiguousChunksByMode,
  extractFrustumPlanes,
} from "./cull"
import { GrowableInstanceBuffer, uploadSplitSprites } from "./targets"

describe("gpu/cull & gpu/targets", () => {
  test("extractFrustumPlanes & aabbInFrustum cull boxes outside WebGPU 0..1 clip volume", () => {
    const proj = mat4.ortho(-50, 50, -40, 40, 1, 200)
    const view = mat4.lookAt([0, 0, 0], [0, 0, -10], [0, 1, 0])
    const vp = mat4.multiply(proj, view)
    const planes = new Float32Array(24)
    extractFrustumPlanes(vp, 0, planes)

    // Box centered in front of the camera inside frustum
    expect(aabbInFrustum(planes, -5, -5, -20, 5, 5, -10)).toBe(true)
    // Box completely to the left of x = -50
    expect(aabbInFrustum(planes, -80, -5, -20, -55, 5, -10)).toBe(false)
    // Box behind the near plane (z > -1)
    expect(aabbInFrustum(planes, -5, -5, 2, 5, 5, 10)).toBe(false)
    // Box beyond the far plane (z < -200)
    expect(aabbInFrustum(planes, -5, -5, -250, 5, 5, -210)).toBe(false)
  })

  test("boxIntersectsRect2D tests 2D plan bounds", () => {
    const view: [number, number, number, number] = [-10, -20, 30, 40]
    expect(boxIntersectsRect2D([-5, -5, 5, 5], view)).toBe(true)
    expect(boxIntersectsRect2D([30, 40, 35, 45], view)).toBe(true)
    expect(boxIntersectsRect2D([31, 0, 40, 10], view)).toBe(false)
    expect(boxIntersectsRect2D([-20, -30, -11, -21], view)).toBe(false)
  })

  test("drawContiguousChunks coalesces adjacent visible vertex ranges into single draw calls", () => {
    const draws: Array<[number, number, number, number]> = []
    const pass = {
      draw(vertexCount: number, instanceCount = 1, firstVertex = 0, firstInstance = 0) {
        draws.push([vertexCount, instanceCount, firstVertex, firstInstance])
      },
    }
    const chunks = [
      { first: 0, count: 120, visible: true },
      { first: 120, count: 80, visible: true },
      { first: 200, count: 60, visible: false },
      { first: 260, count: 90, visible: true },
      { first: 350, count: 50, visible: true },
    ]
    const stats = drawContiguousChunks(pass, chunks, (c) => c.visible)
    expect(stats).toEqual({ chunksDrawn: 4, vertsDrawn: 340, drawCalls: 2 })
    expect(draws).toEqual([
      [200, 1, 0, 0],
      [140, 1, 260, 0],
    ])
  })

  test("drawContiguousChunksByMode coalesces runs per pipeline mode and switches only on mode transitions", () => {
    const events: string[] = []
    const pass = {
      draw(vertexCount: number, _inst = 1, firstVertex = 0) {
        events.push(`draw:${firstVertex}+${vertexCount}`)
      },
    }
    const chunks = [
      { first: 0, count: 100, mode: false as boolean | null },
      { first: 100, count: 50, mode: false as boolean | null },
      { first: 150, count: 40, mode: null as boolean | null },
      { first: 190, count: 60, mode: true as boolean | null },
      { first: 250, count: 30, mode: true as boolean | null },
      { first: 280, count: 70, mode: false as boolean | null },
    ]
    const stats = drawContiguousChunksByMode(
      pass,
      chunks,
      (c) => c.mode,
      (m) => events.push(`mode:${m}`),
      false,
    )
    expect(stats).toEqual({ chunksDrawn: 5, vertsDrawn: 310, drawCalls: 3 })
    expect(events).toEqual([
      "draw:0+150",
      "mode:true",
      "draw:190+90",
      "mode:false",
      "draw:280+70",
    ])
  })

  test("GrowableInstanceBuffer coalesces contiguous backing slices and uploadSplitSprites splits halves", () => {
    const writes: Array<{ dstOffset: number; dataOffset: number; size: number }> = []
    let destroyed = 0
    const mockDevice = {
      createBuffer({ size }: { size: number }) {
        return {
          size,
          destroy() {
            destroyed++
          },
        } as unknown as GPUBuffer
      },
      queue: {
        writeBuffer(_buf: GPUBuffer, dstOffset: number, _data: ArrayBuffer, dataOffset = 0, size = 0) {
          writes.push({ dstOffset, dataOffset, size })
        },
      },
    } as unknown as GPUDevice

    const inst = new GrowableInstanceBuffer(mockDevice, 4, 12)
    const backing = new Float32Array(6 * 12)
    expect(inst.ensureCapacity(6)).toBe(true)
    expect(destroyed).toBe(1)
    expect(inst.cap).toBe(9)

    // Two contiguous subarrays of the same backing buffer -> 1 writeBuffer call
    const total = inst.uploadBatches([
      { data: backing.subarray(0, 2 * 12), count: 2 },
      { data: backing.subarray(2 * 12, 6 * 12), count: 4 },
    ])
    expect(total).toBe(6)
    expect(writes).toEqual([{ dstOffset: 0, dataOffset: 0, size: 6 * 48 }])

    writes.length = 0
    const spriteBuf = mockDevice.createBuffer({ size: 100 * 48, usage: 0 })
    const res = uploadSplitSprites(
      mockDevice,
      spriteBuf,
      100,
      12,
      new Float32Array(10 * 12),
      10,
      new Float32Array(5 * 12),
      5,
    )
    expect(res).toEqual({ alphaCount: 10, addCount: 5, addByteOffset: 50 * 48, halfCap: 50 })
    expect(writes).toEqual([
      { dstOffset: 0, dataOffset: 0, size: 10 * 48 },
      { dstOffset: 50 * 48, dataOffset: 0, size: 5 * 48 },
    ])
  })
})
