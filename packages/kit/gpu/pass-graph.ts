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
  /** MSAA sample count (4). */
  readonly samples: number
}

export interface ScenePass {
  /** Called inside the main HDR render pass with group 0 (Frame) already bound. Set your own pipeline and group 1+. */
  draw(pass: GPURenderPassEncoder): void
  /** Optional: encode work (compute, offscreen passes) before the main HDR pass begins. */
  prepare?(enc: GPUCommandEncoder): void
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

/**
 * Reusable orthographic directional sun/moon shadow-map pass (`depth32float`, default `2048²`)
 * with shadow-sweep frustum culling (`isShadowCasterVisible`) and contiguous chunk draw merging.
 */
export class DirectionalShadowPass {
  readonly size: number
  readonly texture: GPUTexture
  readonly view: GPUTextureView
  readonly sampler: GPUSampler
  readonly layout: GPUBindGroupLayout
  readonly group: GPUBindGroup
  readonly staticPipeline: GPURenderPipeline
  readonly instPipeline: GPURenderPipeline

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

  encode<C extends ShadowChunkAabb>(
    enc: GPUCommandEncoder,
    opts: {
      staticMesh?: { vbuf: GPUBuffer; chunks: readonly C[] } | null
      shadowPlanes: Float32Array
      camPlanes: Float32Array
      instBuf: GPUBuffer
      models: readonly ShadowModelEntry[]
      ranges: readonly ShadowInstanceRange[]
      timestampWrites?: GPURenderPassTimestampWrites
      sweepSlope?: number
      minHeight?: number
    },
  ): { vertsDrawn: number; chunksDrawn: number } {
    const sp = enc.beginRenderPass({
      timestampWrites: opts.timestampWrites,
      colorAttachments: [],
      depthStencilAttachment: {
        view: this.view,
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    })
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
    return { vertsDrawn, chunksDrawn }
  }
}
