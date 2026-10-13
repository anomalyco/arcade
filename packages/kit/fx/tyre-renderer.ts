import { SMOKE_CAPACITY, SMOKE_STRIDE, type SmokeTrail } from "./smoke-trail"

export const tyreShader = (common: string, cone = "if (li.dir.w > -1.0) { a *= smoothstep(li.dir.w, min(1.0, li.dir.w + 0.08), dot(-d / dist, normalize(li.dir.xyz))); }") => /* wgsl */ `
${common}
@group(1) @binding(0) var noiseTex: texture_3d<f32>;
@group(1) @binding(1) var noiseSampler: sampler;

fn billow(world: vec3f) -> f32 {
  let t = F.cam.w;
  let p = world * 0.045 + vec3f(-t * 0.013, -t * 0.019, t * 0.006);
  let warp = vec3f(sin(p.z * 12.0 + t * 0.18), cos(p.x * 11.0 - t * 0.14), sin(p.y * 9.0)) * 0.022;
  return textureSampleLevel(noiseTex, noiseSampler, p + warp, 0.0).r * 0.58
    + textureSampleLevel(noiseTex, noiseSampler, p * 2.07 - warp, 0.0).r * 0.28
    + textureSampleLevel(noiseTex, noiseSampler, p * 4.13 + warp, 0.0).r * 0.14;
}

// Evaluated at vertices, not at every smoke pixel. Cars/sirens precede street lamps in the packed list.
fn practical(world: vec3f) -> vec3f {
  var color = vec3f(0.0);
  for (var i = 0u; i < min(32u, u32(F.screen.z)); i++) {
    let li = lights[i]; let d = li.pos.xyz - world; let d2 = dot(d, d);
    if (d2 >= li.pos.w * li.pos.w) { continue; }
    let dist = sqrt(max(d2, 0.001));
    var a = pow(1.0 - dist / li.pos.w, 2.0) * li.color.w * 0.27;
    ${cone}
    color += li.color.rgb * a;
  }
  return min(color, vec3f(1.1));
}

struct SI { @location(0) pos: vec4f, @location(1) misc: vec4f }
struct SO {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) world: vec3f,
  @location(2) @interpolate(flat) density: f32,
  @location(3) light: vec3f,
}
@vertex fn vs(@builtin(vertex_index) vi: u32, s: SI) -> SO {
  let corners = array<vec2f, 6>(vec2f(-1,-1),vec2f(1,-1),vec2f(1,1),vec2f(-1,-1),vec2f(1,1),vec2f(-1,1));
  let c = corners[vi]; let toward = normalize(F.cam.xyz - s.pos.xyz);
  let right = normalize(cross(vec3f(0,1,0), toward)); let up = cross(toward, right);
  var o: SO;
  o.world = s.pos.xyz + (right * c.x + up * c.y) * s.pos.w;
  o.pos = F.viewProj * vec4f(o.world,1);
  o.uv = c; o.density = s.misc.x; o.light = practical(o.world);
  return o;
}
@fragment fn fs(o: SO) -> @location(0) vec4f {
  let r2 = dot(o.uv, o.uv);
  if (r2 > 1.0) { discard; }
  let n = billow(o.world);
  let shape = exp(-r2 * 2.2) * (1.0 - smoothstep(0.5, 1.0, r2));
  let erosion = smoothstep(0.18, 0.75, n);
  let ground = smoothstep(-0.1, 0.42, o.world.y);
  let alpha = 1.0 - exp(-shape * erosion * o.density * ground * 0.8);
  let color = vec3f(0.25, 0.28, 0.34) * (0.7 + n * 0.6) + o.light * 0.9;
  return vec4f(color * alpha, alpha);
}
`

/** Shipped billows. Both hosts provide the frame/light layout; only depth format varies. */
export class SmokeRenderer {
  private readonly instances: GPUBuffer
  private readonly group: GPUBindGroup
  private readonly pipeline: GPURenderPipeline
  private readonly noise: GPUTexture
  private count = 0
  constructor(private readonly device: GPUDevice, main: GPUBindGroupLayout, common: string, depthFormat: GPUTextureFormat = "depth24plus-stencil8", cone?: string) {
    const d = device
    this.instances = d.createBuffer({ size: SMOKE_CAPACITY * SMOKE_STRIDE * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    const noise = this.noise = d.createTexture({ size: [32,32,32], dimension: "3d", format: "r8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
    const data = new Uint8Array(32 ** 3)
    let seed = 1729
    for (let i = 0; i < data.length; i++) { seed = Math.imul(seed, 1664525) + 1013904223 | 0; data[i] = seed >>> 24 }
    d.queue.writeTexture({ texture: noise }, data, { bytesPerRow: 32, rowsPerImage: 32 }, [32,32,32])
    const layout = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "3d" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ] })
    this.group = d.createBindGroup({ layout, entries: [
      { binding: 0, resource: noise.createView() },
      { binding: 1, resource: d.createSampler({ minFilter: "linear", magFilter: "linear", addressModeU: "repeat", addressModeV: "repeat", addressModeW: "repeat" }) },
    ] })
    const module = d.createShaderModule({ code: tyreShader(common, cone) })
    this.pipeline = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [main, layout] }),
      vertex: { module, entryPoint: "vs", buffers: [{ arrayStride: 32, stepMode: "instance", attributes: [{ shaderLocation: 0, offset: 0, format: "float32x4" }, { shaderLocation: 1, offset: 16, format: "float32x4" }] }] },
      fragment: { module, entryPoint: "fs", targets: [{ format: "rgba16float", blend: { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } } }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: "less" }, multisample: { count: 4 },
    })
  }
  upload(trail: SmokeTrail, visible: boolean) {
    this.count = visible ? trail.drawn : 0
    if (this.count) this.device.queue.writeBuffer(this.instances, 0, trail.instances.buffer, 0, this.count * 32)
  }
  draw(pass: GPURenderPassEncoder) {
    if (!this.count) return
    pass.setBindGroup(1, this.group); pass.setPipeline(this.pipeline); pass.setVertexBuffer(0, this.instances); pass.draw(6, this.count)
  }
  destroy() { this.instances.destroy(); this.noise.destroy() }
}
