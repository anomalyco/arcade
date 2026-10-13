import { FIELD_SIZE, SMOKE_CAPACITY, SMOKE_STRIDE, type SmokeTrail } from "./smoke-trail"

export const tyreShader = (common: string) => /* wgsl */ `
${common}
@group(1) @binding(0) var noiseTex: texture_3d<f32>;
@group(1) @binding(1) var noiseSampler: sampler;
@group(1) @binding(2) var densityTex: texture_2d<f32>;
@group(1) @binding(3) var<uniform> B: array<vec4f, 2>;
@group(1) @binding(4) var fieldSampler: sampler;

fn billow(world: vec3f) -> f32 {
  let t = F.cam.w;
  let p = world * 0.045 + vec3f(-t * 0.013, -t * 0.019, t * 0.006);
  let warp = vec3f(sin(p.z * 12.0 + t * 0.18), cos(p.x * 11.0 - t * 0.14), sin(p.y * 9.0)) * 0.022;
  return textureSampleLevel(noiseTex, noiseSampler, p + warp, 0.0).r * 0.58
    + textureSampleLevel(noiseTex, noiseSampler, p * 2.07 - warp, 0.0).r * 0.28
    + textureSampleLevel(noiseTex, noiseSampler, p * 4.13 + warp, 0.0).r * 0.14;
}

struct Lit { color: vec3f, direction: vec3f }
fn practical(world: vec3f) -> Lit {
  var o: Lit;
  o.color = vec3f(0.0); o.direction = vec3f(0.0, 0.001, 0.0);
  for (var i = 0u; i < min(32u, u32(F.screen.z)); i++) {
    let li = lights[i]; let d = li.pos.xyz - world; let d2 = dot(d, d);
    if (d2 >= li.pos.w * li.pos.w) { continue; }
    let dist = sqrt(max(d2, 0.001));
    var a = pow(1.0 - dist / li.pos.w, 2.0) * li.color.w * 0.18;
    if (li.dir.w > -1.0) { a *= smoothstep(li.dir.w, min(1.0, li.dir.w + 0.08), dot(-d / dist, normalize(li.dir.xyz))); }
    o.color += li.color.rgb * a;
    o.direction += d / dist * a;
  }
  o.direction = normalize(o.direction);
  o.color = min(o.color, vec3f(1.1));
  return o;
}

struct SI { @location(0) pos: vec4f, @location(1) misc: vec4f }
struct SO {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) world: vec3f,
  @location(2) @interpolate(flat) misc: vec4f,
  @location(3) light: vec3f,
  @location(4) direction: vec3f,
}
@vertex fn vs(@builtin(vertex_index) vi: u32, s: SI) -> SO {
  let corners = array<vec2f, 6>(vec2f(-1,-1),vec2f(1,-1),vec2f(1,1),vec2f(-1,-1),vec2f(1,1),vec2f(-1,1));
  let c = corners[vi]; let toward = normalize(F.cam.xyz - s.pos.xyz);
  let right = normalize(cross(vec3f(0,1,0), toward)); let up = cross(toward, right);
  var o: SO;
  o.world = s.pos.xyz + (right * c.x + up * c.y) * s.pos.w;
  o.pos = F.viewProj * vec4f(o.world,1);
  o.uv = c; o.misc = s.misc;
  let light = practical(s.pos.xyz);
  o.light = light.color; o.direction = light.direction;
  return o;
}

@fragment fn fs(o: SO) -> @location(0) vec4f {
  let r2 = dot(o.uv, o.uv);
  if (r2 > 1.0) { discard; }
  let n = billow(o.world);
  let shape = exp(-r2 * 2.2) * (1.0 - smoothstep(0.5, 1.0, r2));
  let erosion = smoothstep(0.18, 0.75, n);
  let ground = smoothstep(-0.1, 0.42, o.world.y);
  let optical = shape * erosion * o.misc.x * ground * select(0.8, 1.2, o.misc.w == 7.0);
  let alpha = 1.0 - exp(-optical);
  var color = vec3f(0.25, 0.28, 0.34) * (0.7 + n * 0.6) + o.light * 0.7;
  if (o.misc.w == 7.0) {
    // Procedural scattering-gradient approximation, not a baked six-way lightmap.
    let p = o.world * 0.022 + vec3f(-F.cam.w * 0.009,-F.cam.w * 0.012,0.0);
    let base = textureSampleLevel(noiseTex, noiseSampler, p, 0.0).r;
    let gradient = vec3f(base - textureSampleLevel(noiseTex, noiseSampler, p + vec3f(0.012,0,0),0.0).r,
      base - textureSampleLevel(noiseTex, noiseSampler, p + vec3f(0,0.012,0),0.0).r,
      base - textureSampleLevel(noiseTex, noiseSampler, p + vec3f(0,0,0.012),0.0).r);
    let normal = normalize(gradient * 2.0 + vec3f(0.0, 0.3, 0.0));
    color = vec3f(0.10, 0.13, 0.19) + vec3f(0.30, 0.35, 0.45) * (0.3 + 0.7 * max(0.0, dot(normal, normalize(F.moonDir.xyz))));
    color += o.light * (0.25 + 0.75 * max(0.0, dot(normal, normalize(o.direction))));
  }
  return vec4f(color * alpha, alpha);
}

struct VO { @builtin(position) pos: vec4f, @location(0) world: vec3f }
@vertex fn volumeVs(@builtin(vertex_index) vi: u32) -> VO {
  let corners = array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(1,1),vec2f(0,0),vec2f(1,1),vec2f(0,1));
  let p = B[0].xy - 5.0 + corners[vi] * (B[0].zw + 10.0);
  var o: VO; o.world = vec3f(p.x, 2.0, p.y); o.pos = F.viewProj * vec4f(o.world,1); return o;
}
fn field(p: vec3f) -> vec4f {
  let uv = (p.xz - B[0].xy) / B[0].zw;
  if (any(uv < vec2f(0)) || any(uv > vec2f(1))) { return vec4f(0); }
  return textureSampleLevel(densityTex, fieldSampler, uv, 0.0);
}
struct VolumeOut { @location(0) color: vec4f, @builtin(frag_depth) depth: f32 }
@fragment fn volumeFs(o: VO) -> VolumeOut {
  if (field(o.world).a < 0.5) { discard; }
  let ray = normalize(o.world - F.cam.xyz);
  let near = max(0.0, (5.5 - F.cam.y) / ray.y);
  let far = (0.02 - F.cam.y) / ray.y;
  let stepSize = (far - near) / 12.0;
  var trans = 1.0; var color = vec3f(0); var hit = far;
  let lighting = practical(o.world);
  for (var i = 0; i < 12; i++) {
    let distance = near + (f32(i) + 0.5) * stepSize;
    let p = F.cam.xyz + ray * distance;
    let f = field(p);
    if (f.r < 0.001) { continue; }
    let height = f.g * 4.0; let radius = max(0.5, f.b * 4.0);
    let y = (p.y - height) / (radius * 0.78);
    let envelope = max(0.0, 1.0 - y * y);
    if (envelope < 0.001) { continue; }
    let n = billow(p);
    let density = f.r * 3.2 * envelope * envelope * smoothstep(0.18, 0.76, n) * smoothstep(0.0,0.35,p.y);
    let a = 1.0 - exp(-density * stepSize);
    if (a > 0.015 && hit == far) { hit = distance; }
    let sun = exp(-f.r * max(0.0, 1.0 - y) * 1.8);
    let lit = vec3f(0.10,0.13,0.19) + vec3f(0.43,0.48,0.58) * sun + lighting.color * (0.35 + 0.4 * sun);
    color += trans * a * lit;
    trans *= 1.0 - a;
    if (trans < 0.025) { break; }
  }
  if (trans > 0.997) { discard; }
  let clip = F.viewProj * vec4f(F.cam.xyz + ray * hit, 1.0);
  var result: VolumeOut; result.color = vec4f(color, 1.0-trans); result.depth = clip.z / clip.w; return result;
}
`

/** One draw in the existing main pass. All GPU resources and upload scratch are persistent. */
export class SmokeRenderer {
  private readonly instances: GPUBuffer
  private readonly bounds: GPUBuffer
  private readonly group: GPUBindGroup
  private readonly sprite: GPURenderPipeline
  private readonly volume: GPURenderPipeline
  private readonly destination: GPUTexelCopyTextureInfo
  private readonly layout: GPUTexelCopyBufferLayout = { bytesPerRow: FIELD_SIZE * 4, rowsPerImage: FIELD_SIZE }
  private readonly extent: GPUExtent3DDict = { width: FIELD_SIZE, height: FIELD_SIZE, depthOrArrayLayers: 1 }
  private count = 0
  private style = 0
  constructor(private readonly device: GPUDevice, main: GPUBindGroupLayout, common: string, depthFormat: GPUTextureFormat = "depth24plus-stencil8") {
    const d = device
    this.instances = d.createBuffer({ size: SMOKE_CAPACITY * SMOKE_STRIDE * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    this.bounds = d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const noise = d.createTexture({ size: [32,32,32], dimension: "3d", format: "r8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
    const data = new Uint8Array(32 ** 3)
    let seed = 1729
    for (let i = 0; i < data.length; i++) { seed = Math.imul(seed, 1664525) + 1013904223 | 0; data[i] = seed >>> 24 }
    d.queue.writeTexture({ texture: noise }, data, { bytesPerRow: 32, rowsPerImage: 32 }, [32,32,32])
    const field = d.createTexture({ size: [FIELD_SIZE, FIELD_SIZE], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
    this.destination = { texture: field }
    const layout = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "3d" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 3, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ] })
    this.group = d.createBindGroup({ layout, entries: [
      { binding: 0, resource: noise.createView() },
      { binding: 1, resource: d.createSampler({ minFilter: "linear", magFilter: "linear", addressModeU: "repeat", addressModeV: "repeat", addressModeW: "repeat" }) },
      { binding: 2, resource: field.createView() }, { binding: 3, resource: { buffer: this.bounds } },
      { binding: 4, resource: d.createSampler({ minFilter: "linear", magFilter: "linear" }) },
    ] })
    const module = d.createShaderModule({ code: tyreShader(common) })
    const pipelineLayout = d.createPipelineLayout({ bindGroupLayouts: [main, layout] })
    const pipe = (volume: boolean) => d.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: volume ? "volumeVs" : "vs", buffers: volume ? [] : [{ arrayStride: 32, stepMode: "instance", attributes: [{ shaderLocation: 0, offset: 0, format: "float32x4" }, { shaderLocation: 1, offset: 16, format: "float32x4" }] }] },
      fragment: { module, entryPoint: volume ? "volumeFs" : "fs", targets: [{ format: "rgba16float", blend: { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } } }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: "less" }, multisample: { count: 4 },
    })
    this.sprite = pipe(false); this.volume = pipe(true)
  }
  upload(trail: SmokeTrail, style: number, visible: boolean) {
    this.style = style
    this.count = visible && style >= 6 ? trail.drawn : 0
    if (!this.count) return
    if (style === 8) {
      this.device.queue.writeBuffer(this.bounds, 0, trail.bounds)
      this.device.queue.writeTexture(this.destination, trail.field, this.layout, this.extent)
    } else this.device.queue.writeBuffer(this.instances, 0, trail.instances.buffer, 0, this.count * 32)
  }
  draw(pass: GPURenderPassEncoder) {
    if (!this.count) return
    pass.setBindGroup(1, this.group)
    pass.setPipeline(this.style === 8 ? this.volume : this.sprite)
    if (this.style !== 8) pass.setVertexBuffer(0, this.instances)
    pass.draw(6, this.style === 8 ? 1 : this.count)
  }
}
