/**
 * Shared scene-pass plugin contract (`ScenePass`, `PassList`), depth-buffer convention
 * descriptors (`DepthMode`), directional shadow-map pass (`DirectionalShadowPass`),
 * stencil silhouette face states, and WGSL module compilation diagnostics across Arcade renderers.
 */

import { drawContiguousChunks, isShadowCasterVisible, type ContiguousChunkRange } from "./cull"

export type PassSlot = "sky" | "opaque" | "alpha"

export const PASS_SLOTS: readonly PassSlot[] = ["sky", "opaque", "alpha"] as const

/**
 * Depth-buffer convention for a renderer's main scene pass:
 * - `"standard"`: `depth24plus`, clear `1`, `less-equal` (top-down / three-quarter indoor & town scenes)
 * - `"stencil"`: `depth24plus-stencil8`, clear `1`, `less` (scenes with stencil-masked occluded silhouettes)
 * - `"reversed-z"`: `depth32float`, clear `0`, `greater-equal` (40 km ocean/flight horizons with zero Z-fighting)
 */
export type DepthMode = "standard" | "stencil" | "reversed-z"

export interface DepthModeConfig {
  readonly mode: DepthMode
  readonly format: GPUTextureFormat
  readonly clearValue: number
  readonly compare: GPUCompareFunction
  readonly hasStencil: boolean
}

export function depthConfigForMode(mode: DepthMode): DepthModeConfig {
  switch (mode) {
    case "stencil":
      return {
        mode,
        format: "depth24plus-stencil8",
        clearValue: 1,
        compare: "less",
        hasStencil: true,
      }
    case "reversed-z":
      return {
        mode,
        format: "depth32float",
        clearValue: 0,
        compare: "greater-equal",
        hasStencil: false,
      }
    case "standard":
    default:
      return {
        mode: "standard",
        format: "depth24plus",
        clearValue: 1,
        compare: "less-equal",
        hasStencil: false,
      }
  }
}

export interface PassContext {
  readonly device: GPUDevice
  /** Group 0: the Frame uniform bind group layout, visible to vertex + fragment. */
  readonly frameLayout: GPUBindGroupLayout
  /** `"rgba16float"` HDR color target format. */
  readonly color: GPUTextureFormat
  /** Depth attachment format (`"depth24plus"`, `"depth24plus-stencil8"`, or `"depth32float"`). */
  readonly depth: GPUTextureFormat
  /** Depth convention (`"standard"`, `"stencil"`, or `"reversed-z"`). */
  readonly depthMode?: DepthMode
  /** Default depth comparison function (`"less-equal"`, `"less"`, or `"greater-equal"`). */
  readonly depthCompare?: GPUCompareFunction
  /** Default depth clear value (`1` for standard/stencil, `0` for reversed-Z). */
  readonly depthClearValue?: number
  /** MSAA sample count (4). */
  readonly samples: number
  /** The scene shader the renderer draws this frame: its plain hooks, or a look variant. Read inside `draw`. */
  readonly sceneVariant?: () => SceneVariant
}

/** `"plain"` is the renderer's own scene shader; the others are `makeLookSceneShader` variants. */
export type SceneVariant = "plain" | "noir" | "painterly" | "generic"

export interface ScenePass {
  /** Called inside the main HDR render pass with group 0 (Frame) already bound. Set your own pipeline and group 1+. */
  draw(pass: GPURenderPassEncoder): void
  /** Optional: encode work (compute, offscreen passes) before the main HDR pass begins. */
  prepare?(enc: GPUCommandEncoder): void
  /**
   * Optional, for passes that draw what moves on its own (particles, motes, rain): under temporal AA, redraw it into the
   * reactive mask with group 0 (Frame) bound. Build the pipeline with `reactivePipelineDescriptor` from
   * `@arcade/kit/gpu/reactive` (rgba8 target, one sample, no depth).
   */
  drawReactive?(pass: GPURenderPassEncoder): void
}

/**
 * Ordered registry of `ScenePass` plugins grouped into `"sky"`, `"opaque"`, and `"alpha"` slots.
 */
export class PassList {
  private readonly slots: Record<PassSlot, ScenePass[]> = {
    sky: [],
    opaque: [],
    alpha: [],
  }

  add(slot: PassSlot, pass: ScenePass): void {
    this.slots[slot].push(pass)
  }

  remove(pass: ScenePass): boolean {
    for (const slot of PASS_SLOTS) {
      const list = this.slots[slot]
      const idx = list.indexOf(pass)
      if (idx >= 0) {
        list.splice(idx, 1)
        return true
      }
    }
    return false
  }

  prepareAll(enc: GPUCommandEncoder): void {
    for (const slot of PASS_SLOTS) {
      const list = this.slots[slot]
      for (let i = 0; i < list.length; i++) {
        list[i]!.prepare?.(enc)
      }
    }
  }

  drawSlot(slot: PassSlot, pass: GPURenderPassEncoder): void {
    const list = this.slots[slot]
    for (let i = 0; i < list.length; i++) {
      list[i]!.draw(pass)
    }
  }

  /** Calls `drawReactive` on every pass in `slot` that has one. */
  drawReactiveSlot(slot: PassSlot, pass: GPURenderPassEncoder): void {
    const list = this.slots[slot]
    for (let i = 0; i < list.length; i++) list[i]!.drawReactive?.(pass)
  }

  count(slot?: PassSlot): number {
    if (slot) return this.slots[slot].length
    return this.slots.sky.length + this.slots.opaque.length + this.slots.alpha.length
  }
}

/**
 * Compiles a WGSL shader module and asynchronously logs any compilation errors with `[wgsl label:line:col]`.
 */
export function compileShaderModuleWithLog(device: GPUDevice, code: string, label: string): GPUShaderModule {
  const m = device.createShaderModule({ code, label })
  m.getCompilationInfo?.().then(
    (info) => {
      for (const msg of info.messages) {
        if (msg.type === "error") {
          console.error(`[wgsl ${label}:${msg.lineNum}:${msg.linePos}] ${msg.message}`)
        }
      }
    },
    () => undefined,
  )
  return m
}

/** Stencil face state for opaque actors/vehicles that mark their visible pixels with the stencil reference value. */
export const STENCIL_OCCLUDER_FACE: GPUStencilFaceState = {
  compare: "always",
  passOp: "replace",
}

/** Stencil face state for occluded ghost silhouettes (`depthCompare: "greater"`, `stencil != ref`). */
export const STENCIL_GHOST_FACE: GPUStencilFaceState = {
  compare: "not-equal",
  passOp: "keep",
}

export interface ShadowChunkAabb extends ContiguousChunkRange {
  readonly minX: number
  readonly minY: number
  readonly minZ: number
  readonly maxX: number
  readonly maxY: number
  readonly maxZ: number
}

export interface ShadowModelEntry {
  readonly vbuf: GPUBuffer
  readonly count: number
  readonly castsShadow?: boolean
}

export interface ShadowInstanceRange {
  readonly model: number
  readonly first: number
  readonly count: number
  readonly noShadow?: boolean
}

export interface DirectionalShadowEncodeInput<C extends ShadowChunkAabb = ShadowChunkAabb> {
  readonly staticMesh?: { vbuf: GPUBuffer; chunks: readonly C[] } | null
  readonly shadowPlanes: Float32Array
  readonly camPlanes: Float32Array
  readonly instBuf: GPUBuffer
  readonly models: readonly ShadowModelEntry[]
  readonly ranges: readonly ShadowInstanceRange[]
  readonly timestampWrites?: GPURenderPassTimestampWrites
  readonly sweepSlope?: number
  readonly minHeight?: number
}

/**
 * Reusable orthographic directional sun/moon shadow-map pass (`depth32float`, default `2048²`)
 * with shadow-sweep frustum culling (`isShadowCasterVisible`), contiguous chunk draw merging,
 * pre-allocated render-pass descriptor, and `ScenePass` (`prepare(enc)`) plugin compatibility.
 */
export class DirectionalShadowPass implements ScenePass {
  readonly size: number
  readonly texture: GPUTexture
  readonly view: GPUTextureView
  readonly sampler: GPUSampler
  readonly layout: GPUBindGroupLayout
  readonly group: GPUBindGroup
  readonly staticPipeline: GPURenderPipeline
  readonly instPipeline: GPURenderPipeline
  private readonly passDesc: GPURenderPassDescriptor
  private pendingInput: DirectionalShadowEncodeInput | null = null
  lastStats = { vertsDrawn: 0, chunksDrawn: 0 }

  constructor(opts: {
    device: GPUDevice
    frameBuf: GPUBuffer
    shadowShaderCode: string
    meshPosLayout: GPUVertexBufferLayout
    instLayout: GPUVertexBufferLayout
    size?: number
    depthBias?: number
    depthBiasSlopeScale?: number
    label?: string
  }) {
    const d = opts.device
    this.size = opts.size ?? 2048
    this.texture = d.createTexture({
      size: [this.size, this.size],
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    this.view = this.texture.createView()
    this.sampler = d.createSampler({ compare: "less", magFilter: "linear", minFilter: "linear" })
    this.layout = d.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
    })
    this.group = d.createBindGroup({
      layout: this.layout,
      entries: [{ binding: 0, resource: { buffer: opts.frameBuf } }],
    })
    this.passDesc = {
      colorAttachments: [],
      depthStencilAttachment: {
        view: this.view,
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    }
    const shadowMod = compileShaderModuleWithLog(d, opts.shadowShaderCode, opts.label ?? "directional-shadow")
    const pipeLayout = d.createPipelineLayout({ bindGroupLayouts: [this.layout] })
    const makePipe = (vs: string, buffers: GPUVertexBufferLayout[]) =>
      d.createRenderPipeline({
        layout: pipeLayout,
        vertex: { module: shadowMod, entryPoint: vs, buffers },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: {
          format: "depth32float",
          depthWriteEnabled: true,
          depthCompare: "less",
          depthBias: opts.depthBias ?? 1,
          depthBiasSlopeScale: opts.depthBiasSlopeScale ?? 1.2,
        },
      })
    this.staticPipeline = makePipe("vsStatic", [opts.meshPosLayout])
    this.instPipeline = makePipe("vsInst", [opts.meshPosLayout, opts.instLayout])
  }

  /** Queues the current frame's shadow casters when registered in a `PassList` via `addPass`. */
  setFrameInput<C extends ShadowChunkAabb>(input: DirectionalShadowEncodeInput<C>): void {
    this.pendingInput = input
  }

  prepare(enc: GPUCommandEncoder): void {
    if (!this.pendingInput) return
    const input = this.pendingInput
    this.pendingInput = null
    this.encode(enc, input)
  }

  draw(_pass: GPURenderPassEncoder): void {
    // Offscreen depth-only shadow pass runs during `prepare(enc)` or explicit `encode(enc, ...)`.
  }

  encode<C extends ShadowChunkAabb>(
    enc: GPUCommandEncoder,
    opts: DirectionalShadowEncodeInput<C>,
  ): { vertsDrawn: number; chunksDrawn: number } {
    this.passDesc.timestampWrites = opts.timestampWrites
    const sp = enc.beginRenderPass(this.passDesc)
    sp.setBindGroup(0, this.group)
    let vertsDrawn = 0
    let chunksDrawn = 0
    if (opts.staticMesh) {
      sp.setPipeline(this.staticPipeline)
      sp.setVertexBuffer(0, opts.staticMesh.vbuf)
      const stats = drawContiguousChunks(sp, opts.staticMesh.chunks, (c) =>
        isShadowCasterVisible(
          opts.shadowPlanes,
          opts.camPlanes,
          c.minX,
          c.minY,
          c.minZ,
          c.maxX,
          c.maxY,
          c.maxZ,
          opts.sweepSlope,
          opts.minHeight,
        ),
      )
      vertsDrawn = stats.vertsDrawn
      chunksDrawn = stats.chunksDrawn
    }
    sp.setPipeline(this.instPipeline)
    sp.setVertexBuffer(1, opts.instBuf)
    for (let i = 0; i < opts.ranges.length; i++) {
      const r = opts.ranges[i]!
      if (r.noShadow) continue
      const m = opts.models[r.model]!
      if (m.castsShadow === false) continue
      sp.setVertexBuffer(0, m.vbuf)
      sp.draw(m.count, r.count, 0, r.first)
    }
    sp.end()
    this.lastStats = { vertsDrawn, chunksDrawn }
    return this.lastStats
  }
}

/**
 * Computes a column-major WebGPU `[0..1]` orthographic directional light view-projection matrix
 * whose view-space translation (`tx`, `ty`) is snapped to shadow-map texel increments (`2 * halfExtent / shadowSize`),
 * eliminating sub-texel shadow edge shimmer as the camera pans.
 */
export function texelSnappedOrthoLightMatrix(
  eye: readonly number[],
  target: readonly number[],
  opts?: { halfExtent?: number; near?: number; far?: number; shadowSize?: number },
): number[] {
  const dx = eye[0]! - target[0]!
  const dy = eye[1]! - target[1]!
  const dz = eye[2]! - target[2]!
  const zLen = Math.hypot(dx, dy, dz) || 1
  const zx = dx / zLen
  const zy = dy / zLen
  const zz = dz / zLen
  const xLen = Math.hypot(zz, 0, -zx) || 1
  const xx = zz / xLen
  const xy = 0
  const xz = -zx / xLen
  const yx = zy * xz - zz * xy
  const yy = zz * xx - zx * xz
  const yz = zx * xy - zy * xx
  const S = opts?.halfExtent ?? 150
  const near = opts?.near ?? 50
  const far = opts?.far ?? 600
  const shadowSize = opts?.shadowSize ?? 2048
  const step = (2 * S) / shadowSize
  const dotX = xx * eye[0]! + xy * eye[1]! + xz * eye[2]!
  const dotY = yx * eye[0]! + yy * eye[1]! + yz * eye[2]!
  const dotZ = zx * eye[0]! + zy * eye[1]! + zz * eye[2]!
  const tx = Math.round(-dotX / step) * step
  const ty = Math.round(-dotY / step) * step
  const view = [xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0, tx, ty, -dotZ, 1]
  const proj = [1 / S, 0, 0, 0, 0, 1 / S, 0, 0, 0, 0, -1 / (far - near), 0, 0, 0, -near / (far - near), 1]
  const r = new Array<number>(16).fill(0)
  for (let c = 0; c < 4; c++) {
    for (let rr = 0; rr < 4; rr++) {
      for (let k = 0; k < 4; k++) {
        r[c * 4 + rr]! += proj[k * 4 + rr]! * view[c * 4 + k]!
      }
    }
  }
  return r
}
