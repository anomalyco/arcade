/**
 * Mip chains on the GPU: each level is a coverage-weighted 2×2 box of the one above (linear light for sRGB formats),
 * optionally only inside a dirty rectangle of level 0 (the pencil layer's new strokes). One bind group per level,
 * cached per texture, so updates allocate nothing.
 */

const SHADER = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let size = vec2i(textureDimensions(src));
  let base = vec2i(pos.xy) * 2;
  var rgb = vec3f(0.0);
  var a = 0.0;
  for (var k = 0; k < 4; k++) {
    let q = min(base + vec2i(k & 1, k >> 1), size - 1);
    let c = textureLoad(src, q, 0);
    rgb += c.rgb * c.a;
    a += c.a;
  }
  return vec4f(select(vec3f(0.0), rgb / a, a > 1e-5), a * 0.25);
}
`

export type Rect = { x: number; y: number; w: number; h: number }

export class MipGen {
  private pipes = new Map<GPUTextureFormat, GPURenderPipeline>()
  private module: GPUShaderModule
  private layout: GPUBindGroupLayout
  private groups = new WeakMap<GPUTexture, { src: GPUBindGroup; dst: GPUTextureView }[]>()

  constructor(private device: GPUDevice) {
    this.module = device.createShaderModule({ label: "held mips", code: SHADER })
    this.layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }] })
  }

  private pipe(format: GPUTextureFormat) {
    let p = this.pipes.get(format)
    if (!p) {
      p = this.device.createRenderPipeline({
        label: "held mips",
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
        vertex: { module: this.module, entryPoint: "vs" },
        fragment: { module: this.module, entryPoint: "fs", targets: [{ format }] },
        primitive: { topology: "triangle-list" },
      })
      this.pipes.set(format, p)
    }
    return p
  }

  /** Rebuilds levels 1.. from level 0 (only over `dirty`, in level-0 texels, when given). */
  generate(enc: GPUCommandEncoder, tex: GPUTexture, dirty?: Rect) {
    let levels = this.groups.get(tex)
    if (!levels) {
      levels = []
      for (let i = 1; i < tex.mipLevelCount; i++) {
        levels.push({
          src: this.device.createBindGroup({ layout: this.layout, entries: [{ binding: 0, resource: tex.createView({ baseMipLevel: i - 1, mipLevelCount: 1 }) }] }),
          dst: tex.createView({ baseMipLevel: i, mipLevelCount: 1 }),
        })
      }
      this.groups.set(tex, levels)
    }
    const pipe = this.pipe(tex.format)
    let x0 = dirty ? Math.max(0, Math.floor(dirty.x)) : 0, y0 = dirty ? Math.max(0, Math.floor(dirty.y)) : 0
    let x1 = dirty ? Math.min(tex.width, Math.ceil(dirty.x + dirty.w)) : tex.width, y1 = dirty ? Math.min(tex.height, Math.ceil(dirty.y + dirty.h)) : tex.height
    for (let i = 1; i < tex.mipLevelCount; i++) {
      const w = Math.max(1, tex.width >> i), h = Math.max(1, tex.height >> i)
      x0 = x0 >> 1; y0 = y0 >> 1; x1 = Math.min(w, (x1 + 1) >> 1); y1 = Math.min(h, (y1 + 1) >> 1)
      if (x1 <= x0 || y1 <= y0) break
      const L = levels[i - 1]!
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: L.dst, loadOp: "load", storeOp: "store" }] })
      pass.setPipeline(pipe)
      pass.setBindGroup(0, L.src)
      pass.setScissorRect(x0, y0, x1 - x0, y1 - y0)
      pass.draw(3)
      pass.end()
    }
  }
}

export const mipCount = (w: number, h: number) => Math.floor(Math.log2(Math.max(w, h))) + 1

/** A texture for a GPU-mipped image: sampled, copied into and rendered to. */
export function mippedTexture(device: GPUDevice, w: number, h: number, format: GPUTextureFormat, label: string): GPUTexture {
  return device.createTexture({ label, size: [w, h], format, mipLevelCount: mipCount(w, h), usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT })
}
