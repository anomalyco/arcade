/** Composite controls, written to the GPU once per frame. */
export type Grade = {
  /** Linear multiplier before the tonemap. */
  exposure: number
  /** How much of the bloom chain is added back. */
  bloom: number
  /** HDR brightness where bloom starts (soft knee around it). */
  threshold: number
  /** 1 = untouched. */
  saturation: number
  /** Corner darkening, 0..1. */
  vignette: number
  /** Film grain amplitude in display units. */
  grain: number
  /** Warm highlights / cool shadows split, 0..1. */
  warmth: number
}

/** Sunny, clean grade: filmic tonemap, gentle saturation, a slight vignette and very fine grain. */
export const DEFAULT_GRADE: Grade = { exposure: 1.0, bloom: 0.16, threshold: 1.4, saturation: 1.2, vignette: 0.2, grain: 0.008, warmth: 0.35 }

export const BLOOM_LEVELS = 5

/** G: exposure, bloom, threshold, saturation | vignette, grain, time, warmth */
const POST_WGSL = /* wgsl */ `
struct Grade { a: vec4f, b: vec4f }
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> P: vec4f; // texel size xy, z = first level
@group(0) @binding(3) var bloomTex: texture_2d<f32>;
@group(0) @binding(4) var<uniform> G: Grade;

struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f }

@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VO;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}

fn clean(c: vec4f) -> vec4f {
  let bad = any(c != c) || any(abs(c) > vec4f(6e4));
  return select(min(c, vec4f(64.0)), vec4f(0.0), bad);
}

/** 13-tap downsample (Jimenez 2014); the first level also applies a soft-knee threshold. */
@fragment fn down(o: VO) -> @location(0) vec4f {
  let t = P.xy;
  let uv = o.uv;
  let a = clean(textureSample(src, samp, uv + t * vec2f(-2.0, -2.0))).rgb;
  let b = clean(textureSample(src, samp, uv + t * vec2f(0.0, -2.0))).rgb;
  let c = clean(textureSample(src, samp, uv + t * vec2f(2.0, -2.0))).rgb;
  let d = clean(textureSample(src, samp, uv + t * vec2f(-2.0, 0.0))).rgb;
  let e = clean(textureSample(src, samp, uv)).rgb;
  let f = clean(textureSample(src, samp, uv + t * vec2f(2.0, 0.0))).rgb;
  let g = clean(textureSample(src, samp, uv + t * vec2f(-2.0, 2.0))).rgb;
  let h = clean(textureSample(src, samp, uv + t * vec2f(0.0, 2.0))).rgb;
  let i = clean(textureSample(src, samp, uv + t * vec2f(2.0, 2.0))).rgb;
  let j = clean(textureSample(src, samp, uv + t * vec2f(-1.0, -1.0))).rgb;
  let k = clean(textureSample(src, samp, uv + t * vec2f(1.0, -1.0))).rgb;
  let l = clean(textureSample(src, samp, uv + t * vec2f(-1.0, 1.0))).rgb;
  let m = clean(textureSample(src, samp, uv + t * vec2f(1.0, 1.0))).rgb;
  var col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  if (P.z > 0.5) {
    let br = max(col.r, max(col.g, col.b)) * G.a.x;
    let th = G.a.z;
    let knee = th * 0.5;
    var soft = clamp(br - th + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 1e-4);
    col *= max(soft, br - th) / max(br, 1e-4);
  }
  return vec4f(col, 1.0);
}

/** 3x3 tent upsample, added onto the next level up. */
@fragment fn up(o: VO) -> @location(0) vec4f {
  let t = P.xy;
  var c = textureSample(src, samp, o.uv).rgb * 4.0;
  c += (textureSample(src, samp, o.uv + vec2f(-t.x, 0.0)).rgb + textureSample(src, samp, o.uv + vec2f(t.x, 0.0)).rgb + textureSample(src, samp, o.uv + vec2f(0.0, -t.y)).rgb + textureSample(src, samp, o.uv + vec2f(0.0, t.y)).rgb) * 2.0;
  c += textureSample(src, samp, o.uv + vec2f(-t.x, -t.y)).rgb + textureSample(src, samp, o.uv + vec2f(t.x, -t.y)).rgb + textureSample(src, samp, o.uv + vec2f(-t.x, t.y)).rgb + textureSample(src, samp, o.uv + vec2f(t.x, t.y)).rgb;
  return vec4f(c / 16.0, 1.0);
}

// Stephen Hill's fitted ACES (sRGB -> ACEScg-ish RRT+ODT -> sRGB). Rows as columns so 'v * M' matches mul(M, v).
fn aces(x: vec3f) -> vec3f {
  let inM = mat3x3f(vec3f(0.59719, 0.35458, 0.04823), vec3f(0.07600, 0.90834, 0.01566), vec3f(0.02840, 0.13383, 0.83777));
  let outM = mat3x3f(vec3f(1.60475, -0.53108, -0.07367), vec3f(-0.10208, 1.10813, -0.00605), vec3f(-0.00327, -0.07276, 1.07602));
  let v = x * inM;
  let a = v * (v + 0.0245786) - 0.000090537;
  let b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return clamp((a / b) * outM, vec3f(0.0), vec3f(1.0));
}

fn srgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

fn hash(p: vec2f) -> f32 {
  let q = fract(p * vec2f(0.1031, 0.1030));
  let r = q + dot(q, q.yx + 33.33);
  return fract((r.x + r.y) * r.x);
}

@fragment fn composite(o: VO) -> @location(0) vec4f {
  let uv = o.uv;
  var hdr = clean(textureSample(src, samp, uv)).rgb;
  hdr += textureSample(bloomTex, samp, uv).rgb * G.a.y;
  // Hill's fit is darker than a plain curve; 1.6 puts exposure 1 at a natural midday brightness.
  var c = aces(hdr * G.a.x * 1.6);
  let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  c = max(mix(vec3f(l), c, G.a.w), vec3f(0.0));
  c *= mix(vec3f(1.0), mix(vec3f(0.97, 0.99, 1.03), vec3f(1.03, 1.0, 0.96), smoothstep(0.15, 0.85, l)), G.b.w);
  let fromC = uv - 0.5;
  let v = length(fromC * vec2f(1.0, 0.75));
  c *= 1.0 - G.b.x * smoothstep(0.35, 0.85, v);
  c = srgb(clamp(c, vec3f(0.0), vec3f(1.0)));
  let px = o.pos.xy;
  let grain = hash(px + fract(G.b.z * 13.7) * 1000.0) + hash(px * 1.37 + fract(G.b.z * 7.3) * 500.0) - 1.0;
  c += grain * G.b.y;
  return vec4f(c, 1.0);
}
`

/**
 * Bloom (five half-resolution levels, 13-tap down, tent up) and the tone-mapped composite to the canvas. Views and
 * bind groups are rebuilt only on resize; per frame it writes the grade uniform and encodes seven small passes.
 */
export class Post {
  private layout: GPUBindGroupLayout
  private sampler: GPUSampler
  private gradeBuf: GPUBuffer
  private gradeData = new Float32Array(8)
  private params: GPUBuffer[] = []
  private down: GPURenderPipeline
  private up: GPURenderPipeline
  private composite: GPURenderPipeline
  private bloom: GPUTexture[] = []
  private bloomViews: GPUTextureView[] = []
  private downGroups: GPUBindGroup[] = []
  private upGroups: GPUBindGroup[] = []
  private compositeGroup: GPUBindGroup | null = null
  private downPass: GPURenderPassDescriptor[] = []
  private upPass: GPURenderPassDescriptor[] = []
  private finalAttachment: GPURenderPassColorAttachment | null = null
  private finalPass: GPURenderPassDescriptor | null = null

  constructor(
    private device: GPUDevice,
    hdr: GPUTextureFormat,
    canvas: GPUTextureFormat,
    module: (code: string, label: string) => GPUShaderModule,
  ) {
    const d = device
    const S = GPUShaderStage
    this.layout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: S.FRAGMENT, texture: {} },
        { binding: 1, visibility: S.FRAGMENT, sampler: {} },
        { binding: 2, visibility: S.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 3, visibility: S.FRAGMENT, texture: {} },
        { binding: 4, visibility: S.FRAGMENT, buffer: { type: "uniform" } },
      ],
    })
    this.sampler = d.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" })
    this.gradeBuf = d.createBuffer({ size: this.gradeData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    for (let i = 0; i < BLOOM_LEVELS; i++) this.params.push(d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }))
    const m = module(POST_WGSL, "post")
    const layout = d.createPipelineLayout({ bindGroupLayouts: [this.layout] })
    const additive: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one" }, alpha: { srcFactor: "one", dstFactor: "one" } }
    const pipe = (fs: string, format: GPUTextureFormat, blend?: GPUBlendState) =>
      d.createRenderPipeline({ label: `post-${fs}`, layout, vertex: { module: m, entryPoint: "vs" }, fragment: { module: m, entryPoint: fs, targets: [{ format, blend }] }, primitive: { topology: "triangle-list" } })
    this.down = pipe("down", hdr)
    this.up = pipe("up", hdr, additive)
    this.composite = pipe("composite", canvas)
  }

  /** Rebuilds the bloom chain for a new HDR target. */
  resize(hdr: GPUTexture, hdrView: GPUTextureView, hdrFormat: GPUTextureFormat): void {
    const d = this.device
    for (const b of this.bloom) b.destroy()
    this.bloom = []
    this.bloomViews = []
    const w = hdr.width
    const h = hdr.height
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const s = 2 ** (i + 1)
      const tex = d.createTexture({ size: [Math.max(1, Math.floor(w / s)), Math.max(1, Math.floor(h / s))], format: hdrFormat, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING })
      this.bloom.push(tex)
      this.bloomViews.push(tex.createView())
    }
    const group = (srcView: GPUTextureView, params: GPUBuffer, extra: GPUTextureView = srcView) =>
      d.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: srcView },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: { buffer: params } },
          { binding: 3, resource: extra },
          { binding: 4, resource: { buffer: this.gradeBuf } },
        ],
      })
    this.downGroups = []
    this.downPass = []
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const src = i === 0 ? hdr : this.bloom[i - 1]!
      this.downGroups.push(group(i === 0 ? hdrView : this.bloomViews[i - 1]!, this.params[i]!))
      d.queue.writeBuffer(this.params[i]!, 0, new Float32Array([1 / src.width, 1 / src.height, i === 0 ? 1 : 0, 0]))
      this.downPass.push({ colorAttachments: [{ view: this.bloomViews[i]!, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] })
    }
    this.upGroups = []
    this.upPass = []
    for (let i = BLOOM_LEVELS - 1; i > 0; i--) {
      this.upGroups.push(group(this.bloomViews[i]!, this.params[i]!))
      this.upPass.push({ colorAttachments: [{ view: this.bloomViews[i - 1]!, loadOp: "load", storeOp: "store" }] })
    }
    this.compositeGroup = group(hdrView, this.params[0]!, this.bloomViews[0]!)
  }

  /** Writes the grade and encodes bloom plus the composite into `target`. */
  encode(enc: GPUCommandEncoder, target: GPUTextureView, g: Grade, time: number): void {
    const gd = this.gradeData
    gd[0] = g.exposure
    gd[1] = g.bloom
    gd[2] = g.threshold
    gd[3] = g.saturation
    gd[4] = g.vignette
    gd[5] = g.grain
    gd[6] = time
    gd[7] = g.warmth
    this.device.queue.writeBuffer(this.gradeBuf, 0, gd)
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const p = enc.beginRenderPass(this.downPass[i]!)
      p.setPipeline(this.down)
      p.setBindGroup(0, this.downGroups[i]!)
      p.draw(3)
      p.end()
    }
    for (let k = 0; k < BLOOM_LEVELS - 1; k++) {
      const p = enc.beginRenderPass(this.upPass[k]!)
      p.setPipeline(this.up)
      p.setBindGroup(0, this.upGroups[k]!)
      p.draw(3)
      p.end()
    }
    if (!this.finalAttachment) this.finalAttachment = { view: target, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }
    this.finalAttachment.view = target
    this.finalPass ??= { colorAttachments: [this.finalAttachment] }
    const fp = enc.beginRenderPass(this.finalPass)
    fp.setPipeline(this.composite)
    fp.setBindGroup(0, this.compositeGroup!)
    fp.draw(3)
    fp.end()
  }
}
