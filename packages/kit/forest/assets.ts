/**
 * The woods look's scanned assets (Poly Haven, CC0; `scripts/woods/fetch-assets.ts` writes them under the host's
 * public `woods/` folder): every material is one layer of three texture arrays (base colour with cut-out alpha,
 * OpenGL normal, ORM), so all static forest geometry draws through one pipeline. Images decode off the main thread
 * (`createImageBitmap` with resize), upload with `copyExternalImageToTexture`, and the mip chains are box-filtered on
 * the GPU. Normal mips keep the averaged, unnormalised vector, whose shortening the shader reads as normal variance
 * (Toksvig), so far bark and needles turn rough instead of sparkling.
 */

/** Texture-array layers. Order is the vertex aux the meshes carry. */
export const LAYERS = [
  "bark-mossy", "bark-spruce", "bark-pine", "bark-birch", "ground-needles", "ground-moss", "ground-trail", "rock-moss",
  "rock-lichen", "planks", "roof", "twig-fir", "twig-pine", "fern", "rocks-a", "rocks-b", "log", "stump", "branches",
  "roots", "picnic-table",
] as const
export type LayerName = (typeof LAYERS)[number]
export const LAYER = Object.fromEntries(LAYERS.map((n, i) => [n, i])) as Record<LayerName, number>

/** Where each layer's images live (relative to the asset root) and whether its base carries cut-out alpha. */
const SOURCES: Record<LayerName, { dir: "tex" | "models" | null; orm: boolean; alpha?: boolean }> = {
  "bark-mossy": { dir: "tex", orm: true }, "bark-spruce": { dir: "tex", orm: true }, "bark-pine": { dir: "tex", orm: true },
  "bark-birch": { dir: null, orm: false }, "ground-needles": { dir: "tex", orm: true }, "ground-moss": { dir: "tex", orm: true },
  "ground-trail": { dir: "tex", orm: true }, "rock-moss": { dir: "tex", orm: true }, "rock-lichen": { dir: "tex", orm: true },
  planks: { dir: "tex", orm: true }, roof: { dir: "tex", orm: true }, "twig-fir": { dir: "tex", orm: true, alpha: true },
  "twig-pine": { dir: "tex", orm: true, alpha: true }, fern: { dir: "models", orm: true, alpha: true },
  "rocks-a": { dir: "models", orm: false }, "rocks-b": { dir: "models", orm: false }, log: { dir: "models", orm: true },
  stump: { dir: "models", orm: true }, branches: { dir: "models", orm: true }, roots: { dir: "models", orm: true },
  "picnic-table": { dir: "models", orm: true },
}

export const MODEL_NAMES = ["fern", "fern-lod1", "rocks-a", "rocks-b", "log", "stump", "branches", "roots", "picnic-table"] as const
export type ModelName = (typeof MODEL_NAMES)[number]
export type ModelPart = { name: string; vertices: ArrayBuffer; min: number[]; max: number[] }
export type ForestModels = Record<ModelName, ModelPart[]>

export type ForestTextures = {
  base: GPUTexture
  normal: GPUTexture
  orm: GPUTexture
  /** Texels per side of the base and normal layers. */
  size: number
}

const mips = (size: number) => 1 + Math.floor(Math.log2(size))

/** Box-filter downsample, one level at a time (sRGB targets average in linear light). */
export const MIP_SHADER = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VO;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
@fragment fn fs(o: VO) -> @location(0) vec4f { return textureSampleLevel(src, samp, o.uv, 0.0); }
`

class MipMaker {
  private pipelines = new Map<GPUTextureFormat, GPURenderPipeline>()
  private sampler: GPUSampler
  private module: GPUShaderModule
  constructor(private device: GPUDevice) {
    this.sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" })
    this.module = device.createShaderModule({ code: MIP_SHADER, label: "forest mips" })
  }
  private pipeline(format: GPUTextureFormat) {
    let p = this.pipelines.get(format)
    if (!p) {
      p = this.device.createRenderPipeline({ layout: "auto", vertex: { module: this.module, entryPoint: "vs" }, fragment: { module: this.module, entryPoint: "fs", targets: [{ format }] }, primitive: { topology: "triangle-list" } })
      this.pipelines.set(format, p)
    }
    return p
  }
  generate(enc: GPUCommandEncoder, texture: GPUTexture, layer: number) {
    const pipe = this.pipeline(texture.format)
    for (let level = 1; level < texture.mipLevelCount; level++) {
      const group = this.device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [
        { binding: 0, resource: texture.createView({ dimension: "2d", baseMipLevel: level - 1, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 }) },
        { binding: 1, resource: this.sampler },
      ] })
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: texture.createView({ dimension: "2d", baseMipLevel: level, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 }), loadOp: "clear", storeOp: "store" }] })
      pass.setPipeline(pipe)
      pass.setBindGroup(0, group)
      pass.draw(3)
      pass.end()
    }
  }
}

async function bitmap(url: string, size: number): Promise<ImageBitmap> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return createImageBitmap(await res.blob(), { resizeWidth: size, resizeHeight: size, resizeQuality: "high", premultiplyAlpha: "none", colorSpaceConversion: "none" })
}

/** Birch bark has no CC0 scan on Poly Haven: paint its chalky white with dark lenticels and black fissures. */
function birchBark(size: number): { base: OffscreenCanvas; normal: OffscreenCanvas } {
  const base = new OffscreenCanvas(size, size), g = base.getContext("2d")!
  const rand = (() => { let a = 91; return () => ((a = (a * 16807) % 2147483647) / 2147483647) })()
  g.fillStyle = "#d9d6cc"
  g.fillRect(0, 0, size, size)
  for (let i = 0; i < 900; i++) {
    const x = rand() * size, y = rand() * size, w = size * (0.02 + rand() * 0.12), h = size * (0.002 + rand() * 0.006)
    g.fillStyle = `rgba(${40 + rand() * 40},${36 + rand() * 30},${30 + rand() * 30},${0.35 + rand() * 0.5})`
    g.fillRect(x, y, w, h)
    if (x + w > size) g.fillRect(x - size, y, w, h)
  }
  for (let i = 0; i < 26; i++) {
    const x = rand() * size, y = rand() * size, w = size * (0.05 + rand() * 0.25), h = size * (0.01 + rand() * 0.05)
    g.fillStyle = `rgba(20,18,16,${0.5 + rand() * 0.4})`
    g.beginPath()
    g.ellipse(x, y, w / 2, h / 2, 0, 0, Math.PI * 2)
    g.fill()
  }
  for (let i = 0; i < 400; i++) {
    g.fillStyle = `rgba(${150 + rand() * 60},${140 + rand() * 50},${110 + rand() * 40},0.25)`
    g.fillRect(rand() * size, rand() * size, size * 0.03 * rand(), size * 0.03 * rand())
  }
  const px = g.getImageData(0, 0, size, size).data
  const normal = new OffscreenCanvas(size, size), ng = normal.getContext("2d")!, out = ng.createImageData(size, size)
  const lum = (x: number, y: number) => { const i = (((y + size) % size) * size + ((x + size) % size)) * 4; return (px[i]! + px[i + 1]! + px[i + 2]!) / 765 }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (lum(x + 1, y) - lum(x - 1, y)) * 2.5, dy = (lum(x, y + 1) - lum(x, y - 1)) * 2.5
    const l = Math.hypot(dx, dy, 1), i = (y * size + x) * 4
    out.data[i] = (-dx / l * 0.5 + 0.5) * 255; out.data[i + 1] = (dy / l * 0.5 + 0.5) * 255; out.data[i + 2] = (1 / l * 0.5 + 0.5) * 255; out.data[i + 3] = 255
  }
  ng.putImageData(out, 0, 0)
  return { base, normal }
}

/** Loads every layer into three arrays. `size` 512 on the low tier, 1024 otherwise; ORM is half that. */
export async function loadForestTextures(device: GPUDevice, root: string, size = 1024): Promise<ForestTextures> {
  const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
  const ormSize = size / 2
  const make = (format: GPUTextureFormat, s: number, label: string) => device.createTexture({ label, size: [s, s, LAYERS.length], mipLevelCount: mips(s), format, usage, dimension: "2d" })
  const base = make("rgba8unorm-srgb", size, "forest base"), normal = make("rgba8unorm", size, "forest normal"), orm = make("rgba8unorm", ormSize, "forest orm")
  const mip = new MipMaker(device)
  const upload = (texture: GPUTexture, layer: number, source: ImageBitmap | OffscreenCanvas) =>
    device.queue.copyExternalImageToTexture({ source }, { texture, origin: [0, 0, layer], premultipliedAlpha: false }, [texture.width, texture.height])
  const fill = (texture: GPUTexture, layer: number, rgba: readonly number[]) => {
    const s = texture.width, data = new Uint8Array(s * s * 4)
    for (let i = 0; i < s * s; i++) data.set(rgba, i * 4)
    device.queue.writeTexture({ texture, origin: [0, 0, layer] }, data, { bytesPerRow: s * 4 }, [s, s])
  }
  await Promise.all(LAYERS.map(async (name, layer) => {
    const src = SOURCES[name]
    if (!src.dir) {
      const birch = birchBark(size)
      upload(base, layer, birch.base); upload(normal, layer, birch.normal); fill(orm, layer, [255, 200, 0, 255])
      return
    }
    const url = (kind: string) => `${root}${src.dir}/${name}-${kind}.webp`
    const [b, n, o] = await Promise.all([bitmap(url("base"), size), bitmap(url("normal"), size), src.orm ? bitmap(url("orm"), ormSize) : Promise.resolve(null)])
    upload(base, layer, b); upload(normal, layer, n)
    b.close(); n.close()
    if (o) { upload(orm, layer, o); o.close() } else fill(orm, layer, [255, 220, 0, 255])
  }))
  const enc = device.createCommandEncoder()
  for (let layer = 0; layer < LAYERS.length; layer++) for (const t of [base, normal, orm]) mip.generate(enc, t, layer)
  device.queue.submit([enc.finish()])
  return { base, normal, orm, size }
}

/** Gzipped kit textured vertices plus a part index (`fetch-assets.ts`). */
export async function loadForestModels(root: string): Promise<ForestModels> {
  const entries = await Promise.all(MODEL_NAMES.map(async name => {
    const [index, bin] = await Promise.all([
      fetch(`${root}models/${name}.json`).then(r => r.json() as Promise<{ parts: { name: string; offset: number; count: number; min: number[]; max: number[] }[] }>),
      fetch(`${root}models/${name}.bin.gz`).then(async r => {
        if (!r.ok) throw new Error(`${name}.bin.gz: ${r.status}`)
        // Static hosts may already have decoded a gzip Content-Encoding; only inflate what still starts with the magic.
        const bytes = new Uint8Array(await r.arrayBuffer())
        if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes.buffer
        return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()
      }),
    ])
    const parts = index.parts.map(p => ({ name: p.name, vertices: bin.slice(p.offset, p.offset + p.count * 32), min: p.min, max: p.max }))
    return [name, parts] as const
  }))
  return Object.fromEntries(entries) as ForestModels
}
