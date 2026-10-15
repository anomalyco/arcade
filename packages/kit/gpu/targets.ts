/**
 * Shared WebGPU render targets (MSAA color, MSAA depth, resolved HDR),
 * 5-level Jimenez bloom pyramid, and dynamic instance/sprite buffer helpers.
 */

export const DEFAULT_BLOOM_LEVELS = 5

const TEX_RENDER_ATTACHMENT = globalThis.GPUTextureUsage?.RENDER_ATTACHMENT ?? 0x10
const TEX_TEXTURE_BINDING = globalThis.GPUTextureUsage?.TEXTURE_BINDING ?? 0x04
const BUF_COPY_DST = globalThis.GPUBufferUsage?.COPY_DST ?? 0x0008
const BUF_VERTEX = globalThis.GPUBufferUsage?.VERTEX ?? 0x0020
const BUF_UNIFORM = globalThis.GPUBufferUsage?.UNIFORM ?? 0x0040

export interface SceneTargetsOptions {
  readonly hdrFormat?: GPUTextureFormat
  readonly depthFormat: GPUTextureFormat
  readonly samples?: number
  readonly depthTextureBinding?: boolean
  readonly clearValue?: GPUColorDict
  readonly depthClearValue?: number
  readonly hasStencil?: boolean
}

/**
 * Manages the MSAA color target, MSAA depth-stencil target, resolved HDR color target,
 * and pre-allocated main render-pass descriptors (mutated in place on resize/render for
 * zero per-frame descriptor allocations).
 */
export class SceneTargets {
  width = 0
  height = 0
  msaa!: GPUTexture
  msaaView!: GPUTextureView
  depth!: GPUTexture
  depthView!: GPUTextureView
  hdr!: GPUTexture
  hdrView!: GPUTextureView

  readonly clearColor: GPUColorDict
  readonly colorAttachment: GPURenderPassColorAttachment
  readonly depthAttachment: GPURenderPassDepthStencilAttachment
  readonly mainPass: GPURenderPassDescriptor
  private readonly singleColorAttachments: [GPURenderPassColorAttachment]
  private readonly dualColorAttachments: [GPURenderPassColorAttachment, GPURenderPassColorAttachment]

  private readonly hdrFormat: GPUTextureFormat
  private readonly depthFormat: GPUTextureFormat
  private readonly samples: number
  private readonly depthUsage: GPUTextureUsageFlags

  constructor(
    private readonly device: GPUDevice,
    opts: SceneTargetsOptions,
  ) {
    this.hdrFormat = opts.hdrFormat ?? "rgba16float"
    this.depthFormat = opts.depthFormat
    this.samples = opts.samples ?? 4
    this.depthUsage =
      TEX_RENDER_ATTACHMENT | (opts.depthTextureBinding ? TEX_TEXTURE_BINDING : 0)
    this.clearColor = opts.clearValue ? { ...opts.clearValue } : { r: 0, g: 0, b: 0, a: 1 }
    this.colorAttachment = {
      view: null as unknown as GPUTextureView,
      resolveTarget: undefined,
      clearValue: this.clearColor,
      loadOp: "clear",
      storeOp: "discard",
    }
    this.depthAttachment = {
      view: null as unknown as GPUTextureView,
      depthClearValue: opts.depthClearValue ?? (opts.depthFormat === "depth32float" ? 0 : 1),
      depthLoadOp: "clear",
      depthStoreOp: "discard",
      ...(opts.hasStencil || opts.depthFormat.includes("stencil")
        ? {
            stencilClearValue: 0,
            stencilLoadOp: "clear" as const,
            stencilStoreOp: "discard" as const,
          }
        : {}),
    }
    this.singleColorAttachments = [this.colorAttachment]
    this.dualColorAttachments = [this.colorAttachment, this.colorAttachment]
    this.mainPass = {
      colorAttachments: this.singleColorAttachments,
      depthStencilAttachment: this.depthAttachment,
    }
  }

  resize(w: number, h: number): boolean {
    if (w === this.width && h === this.height && this.hdr) return false
    this.width = w
    this.height = h
    this.msaa?.destroy()
    this.depth?.destroy()
    this.hdr?.destroy()
    const d = this.device
    const hdrUsage = TEX_RENDER_ATTACHMENT | TEX_TEXTURE_BINDING
    this.msaa = d.createTexture({
      label: "msaa",
      size: [w, h],
      format: this.hdrFormat,
      sampleCount: this.samples,
      usage: TEX_RENDER_ATTACHMENT,
    })
    this.msaaView = this.msaa.createView()
    this.depth = d.createTexture({
      label: "depth",
      size: [w, h],
      format: this.depthFormat,
      sampleCount: this.samples,
      usage: this.depthUsage,
    })
    this.depthView = this.depth.createView()
    this.hdr = d.createTexture({
      label: "hdr",
      size: [w, h],
      format: this.hdrFormat,
      usage: hdrUsage,
    })
    this.hdrView = this.hdr.createView()
    this.colorAttachment.view = this.msaaView
    this.colorAttachment.resolveTarget = this.hdrView
    this.depthAttachment.view = this.depthView
    return true
  }

  /**
   * Mutates and returns the pre-allocated `mainPass` descriptor in place for the current frame.
   */
  configureMainPass(opts?: {
    storeDepth?: boolean
    timestampWrites?: GPURenderPassTimestampWrites
    extraColorAttachment?: GPURenderPassColorAttachment | null
  }): GPURenderPassDescriptor {
    this.depthAttachment.depthStoreOp = opts?.storeDepth ? "store" : "discard"
    this.mainPass.timestampWrites = opts?.timestampWrites
    if (opts?.extraColorAttachment) {
      this.dualColorAttachments[1] = opts.extraColorAttachment
      this.mainPass.colorAttachments = this.dualColorAttachments
    } else {
      this.mainPass.colorAttachments = this.singleColorAttachments
    }
    return this.mainPass
  }

  destroy(): void {
    this.msaa?.destroy()
    this.depth?.destroy()
    this.hdr?.destroy()
  }
}

export interface BloomPyramidOptions {
  readonly levels?: number
  readonly format?: GPUTextureFormat
  /**
   * Controls which mip level's texel size is bound at binding 2 during the upsample pass:
   * - `"target"` (default, used by `@arcade/kit/gpu/renderer` and Carrier `Post`): reuses `downParams[i]` (`1 / bloom[i - 1].size`).
   * - `"source"` (used by Getaway `Renderer`): uses dedicated `upParams[i - 1]` (`1 / bloom[i].size`).
   */
  readonly upTexelSource?: "target" | "source"
}

export interface BloomBindGroupOptions {
  readonly hdr: GPUTexture
  readonly hdrView: GPUTextureView
  readonly layout: GPUBindGroupLayout
  readonly sampler: GPUSampler
  /** Optional uniform buffer for the final composite pass (defaults to `downParams[0]`). */
  readonly compositeParams?: GPUBuffer
  /** Optional extra binding 4 buffer (e.g. `gradeBuf`). */
  readonly gradeBuffer?: GPUBuffer
}

/**
 * Manages the 5-level half-resolution HDR bloom mip chain, texel-size parameter buffers,
 * downsample/upsample/composite bind groups, and render pass encoding.
 */
export class BloomPyramid {
  readonly levels: number
  readonly format: GPUTextureFormat
  readonly downParams: GPUBuffer[] = []
  readonly upParams: GPUBuffer[] = []
  textures: GPUTexture[] = []
  views: GPUTextureView[] = []
  downGroups: GPUBindGroup[] = []
  upGroups: GPUBindGroup[] = []
  compositeGroup!: GPUBindGroup

  private readonly upTexelSource: "target" | "source"
  private readonly paramScratch = new Float32Array(4)

  constructor(
    private readonly device: GPUDevice,
    opts: BloomPyramidOptions = {},
  ) {
    this.levels = opts.levels ?? DEFAULT_BLOOM_LEVELS
    this.format = opts.format ?? "rgba16float"
    this.upTexelSource = opts.upTexelSource ?? "target"
    for (let i = 0; i < this.levels; i++) {
      this.downParams.push(
        device.createBuffer({ size: 16, usage: BUF_UNIFORM | BUF_COPY_DST }),
      )
    }
    if (this.upTexelSource === "source") {
      for (let i = 0; i < this.levels - 1; i++) {
        this.upParams.push(
          device.createBuffer({ size: 16, usage: BUF_UNIFORM | BUF_COPY_DST }),
        )
      }
    }
  }

  makeBindGroup(
    layout: GPUBindGroupLayout,
    sampler: GPUSampler,
    srcView: GPUTextureView,
    params: GPUBuffer,
    extraView: GPUTextureView = srcView,
    gradeBuffer?: GPUBuffer,
  ): GPUBindGroup {
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: srcView },
      { binding: 1, resource: sampler },
      { binding: 2, resource: { buffer: params } },
      { binding: 3, resource: extraView },
    ]
    if (gradeBuffer) entries.push({ binding: 4, resource: { buffer: gradeBuffer } })
    return this.device.createBindGroup({ layout, entries })
  }

  resize(opts: BloomBindGroupOptions): void {
    const d = this.device
    for (const b of this.textures) b.destroy()
    this.textures = []
    this.views = []
    const w = opts.hdr.width
    const h = opts.hdr.height
    const usage = TEX_RENDER_ATTACHMENT | TEX_TEXTURE_BINDING
    for (let i = 0; i < this.levels; i++) {
      const s = 2 ** (i + 1)
      const tex = d.createTexture({
        size: [Math.max(1, Math.floor(w / s)), Math.max(1, Math.floor(h / s))],
        format: this.format,
        usage,
      })
      this.textures.push(tex)
      this.views.push(tex.createView())
    }
    this.downGroups = []
    this.upGroups = []
    for (let i = 0; i < this.levels; i++) {
      const src = i === 0 ? opts.hdr : this.textures[i - 1]!
      const srcView = i === 0 ? opts.hdrView : this.views[i - 1]!
      this.downGroups.push(
        this.makeBindGroup(opts.layout, opts.sampler, srcView, this.downParams[i]!, srcView, opts.gradeBuffer),
      )
      this.paramScratch[0] = 1 / src.width
      this.paramScratch[1] = 1 / src.height
      this.paramScratch[2] = i === 0 ? 1 : 0
      this.paramScratch[3] = 0
      d.queue.writeBuffer(this.downParams[i]!, 0, this.paramScratch)
    }
    for (let i = this.levels - 1; i > 0; i--) {
      if (this.upTexelSource === "source") {
        const bTex = this.textures[i]!
        const upBuf = this.upParams[i - 1]!
        this.paramScratch[0] = 1 / bTex.width
        this.paramScratch[1] = 1 / bTex.height
        this.paramScratch[2] = 0
        this.paramScratch[3] = 0
        d.queue.writeBuffer(upBuf, 0, this.paramScratch)
        this.upGroups.push(
          this.makeBindGroup(opts.layout, opts.sampler, this.views[i]!, upBuf, this.views[i]!, opts.gradeBuffer),
        )
      } else {
        this.upGroups.push(
          this.makeBindGroup(
            opts.layout,
            opts.sampler,
            this.views[i]!,
            this.downParams[i]!,
            this.views[i]!,
            opts.gradeBuffer,
          ),
        )
      }
    }
    this.compositeGroup = this.makeBindGroup(
      opts.layout,
      opts.sampler,
      opts.hdrView,
      opts.compositeParams ?? this.downParams[0]!,
      this.views[0]!,
      opts.gradeBuffer,
    )
  }

  encode(
    enc: GPUCommandEncoder,
    downPipe: GPURenderPipeline,
    upPipe: GPURenderPipeline,
    firstDownGroup?: GPUBindGroup,
  ): void {
    for (let i = 0; i < this.levels; i++) {
      const p = enc.beginRenderPass({
        colorAttachments: [
          {
            view: this.views[i]!,
            loadOp: "clear",
            storeOp: "store",
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
      })
      p.setPipeline(downPipe)
      p.setBindGroup(0, i === 0 && firstDownGroup ? firstDownGroup : this.downGroups[i]!)
      p.draw(3)
      p.end()
    }
    for (let k = 0; k < this.levels - 1; k++) {
      const p = enc.beginRenderPass({
        colorAttachments: [
          {
            view: this.views[this.levels - 2 - k]!,
            loadOp: "load",
            storeOp: "store",
          },
        ],
      })
      p.setPipeline(upPipe)
      p.setBindGroup(0, this.upGroups[k]!)
      p.draw(3)
      p.end()
    }
  }
}

export interface InstanceBatchSlice {
  readonly data: Float32Array<ArrayBuffer> | Float32Array
  readonly count: number
}

/**
 * Growable GPU vertex buffer for instanced draws that coalesces uploads into a single
 * `queue.writeBuffer` call when all non-empty batches share a contiguous `ArrayBuffer` slice.
 */
export class GrowableInstanceBuffer {
  buf: GPUBuffer
  cap: number
  count = 0
  private readonly strideBytes: number

  constructor(
    private readonly device: GPUDevice,
    initialCap: number,
    readonly strideFloats = 12,
  ) {
    this.cap = initialCap
    this.strideBytes = strideFloats * 4
    this.buf = device.createBuffer({
      size: this.cap * this.strideBytes,
      usage: BUF_VERTEX | BUF_COPY_DST,
    })
  }

  ensureCapacity(requiredCount: number): boolean {
    if (requiredCount <= this.cap) return false
    this.buf.destroy()
    this.cap = Math.ceil(requiredCount * 1.5)
    this.buf = this.device.createBuffer({
      size: this.cap * this.strideBytes,
      usage: BUF_VERTEX | BUF_COPY_DST,
    })
    return true
  }

  uploadBatches(batches: readonly InstanceBatchSlice[]): number {
    let total = 0
    let firstBuf: ArrayBufferLike | null = null
    let firstByteOff = 0
    let contiguous = true
    for (let i = 0; i < batches.length; i++) {
      const b = batches[i]!
      if (!b.count) continue
      if (firstBuf === null) {
        firstBuf = b.data.buffer
        firstByteOff = b.data.byteOffset
      } else if (b.data.buffer !== firstBuf || b.data.byteOffset !== firstByteOff + total * this.strideBytes) {
        contiguous = false
      }
      total += b.count
    }
    this.count = total
    if (total === 0) return 0
    if (contiguous && firstBuf) {
      this.device.queue.writeBuffer(this.buf, 0, firstBuf as ArrayBuffer, firstByteOff, total * this.strideBytes)
    } else {
      let cur = 0
      for (let i = 0; i < batches.length; i++) {
        const b = batches[i]!
        if (!b.count) continue
        this.device.queue.writeBuffer(
          this.buf,
          cur * this.strideBytes,
          b.data.buffer as ArrayBuffer,
          b.data.byteOffset,
          b.count * this.strideBytes,
        )
        cur += b.count
      }
    }
    return total
  }
}

export interface SplitSpriteUploadResult {
  readonly alphaCount: number
  readonly addCount: number
  readonly addByteOffset: number
  readonly halfCap: number
}

/**
 * Uploads alpha-blended sprites into the lower half of `spriteBuf` and additive sprites
 * into the upper half (`(maxSprites / 2) * spriteFloats * 4`).
 */
export function uploadSplitSprites(
  device: GPUDevice,
  spriteBuf: GPUBuffer,
  maxSprites: number,
  spriteFloats: number,
  alphaSprites: Float32Array,
  rawAlphaCount: number,
  addSprites: Float32Array,
  rawAddCount: number,
): SplitSpriteUploadResult {
  const halfCap = maxSprites >> 1
  const strideBytes = spriteFloats * 4
  const alphaCount = Math.min(rawAlphaCount, halfCap)
  const addCount = Math.min(rawAddCount, halfCap)
  const addByteOffset = halfCap * strideBytes
  if (alphaCount > 0) {
    device.queue.writeBuffer(spriteBuf, 0, alphaSprites.buffer as ArrayBuffer, alphaSprites.byteOffset, alphaCount * strideBytes)
  }
  if (addCount > 0) {
    device.queue.writeBuffer(
      spriteBuf,
      addByteOffset,
      addSprites.buffer as ArrayBuffer,
      addSprites.byteOffset,
      addCount * strideBytes,
    )
  }
  return { alphaCount, addCount, addByteOffset, halfCap }
}

/**
 * Uploads a square RGBA8 decal/signage atlas texture and generates its full mip chain on the CPU
 * using an alpha-weighted 2×2 box filter (with a `1.1×` alpha coverage boost so thin lettering and
 * crosswalk stripes stay legible under alpha testing at oblique angles).
 */
export function uploadAlphaWeightedMipChain(
  device: GPUDevice,
  texture: GPUTexture,
  img: { width: number; data: Uint8ClampedArray | Uint8Array },
  alphaBoost = 1.1,
): void {
  let w = img.width
  let level: Uint8Array<ArrayBuffer> = new Uint8Array(
    (img.data.buffer as ArrayBuffer).slice(img.data.byteOffset, img.data.byteOffset + img.data.byteLength),
  )
  for (let mip = 0; w >= 1; mip++) {
    device.queue.writeTexture({ texture, mipLevel: mip }, level, { bytesPerRow: w * 4 }, [w, w])
    if (w === 1) break
    const n = w >> 1
    const next: Uint8Array<ArrayBuffer> = new Uint8Array(n * n * 4)
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        let r = 0
        let g = 0
        let b = 0
        let a = 0
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ] as const) {
          const i = ((y * 2 + dy) * w + x * 2 + dx) * 4
          const al = level[i + 3]!
          r += level[i]! * al
          g += level[i + 1]! * al
          b += level[i + 2]! * al
          a += al
        }
        const o = (y * n + x) * 4
        next[o] = a ? r / a : 0
        next[o + 1] = a ? g / a : 0
        next[o + 2] = a ? b / a : 0
        next[o + 3] = Math.min(255, (a / 4) * alphaBoost)
      }
    }
    level = next
    w = n
  }
}
