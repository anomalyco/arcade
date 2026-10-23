import type { PassContext, ScenePass } from "@arcade/kit/gpu/pass-graph"
import { reactivePipelineDescriptor } from "@arcade/kit/gpu/reactive"
import { BOLT_SEGMENT_FLOATS, type Strike, type StrikeLight } from "./lightning"

/** Most segments one strike can draw (a strike is ~300–900 after midpoint displacement). */
export const MAX_BOLT_SEGMENTS = 2048
const UNIFORM_FLOATS = 24

/**
 * HDR emissive ribbons for the channel: a wide blue-violet glow layer and a thin white-hot core per segment, depth
 * tested against the scene (trees in front cut it) without writing depth, faded by the height fog between it and the
 * eye, and drawn into the temporal reactive mask so TAA neither smears nor averages the stroke flicker away.
 */
export const BOLT_WGSL = /* wgsl */ `
struct Frame { viewProj: mat4x4f, cam: vec4f, screen: vec4f }
@group(0) @binding(0) var<uniform> F: Frame;
struct BoltU {
  light: vec4f,  // channel, branches, leader front (0..1, >1 after the return stroke), leader glow
  light2: vec4f, // afterimage, fog density, fog falloff, fog base
  core: vec4f,   // core rgb, intensity
  glow: vec4f,   // glow rgb, intensity
  misc: vec4f,   // cloud-to-cloud (0/1), core width (m), glow width (m), segment count
  after: vec4f,  // afterimage rgb, 1 / tan(fov / 2)
}
@group(1) @binding(0) var<uniform> B: BoltU;
@group(1) @binding(1) var<storage, read> seg: array<vec4f>;

struct VO {
  @builtin(position) pos: vec4f,
  @location(0) q: vec2f,
  @location(1) @interpolate(flat) span: vec2f,
  @location(2) col: vec3f,
}

fn fogT(p: vec3f) -> f32 {
  let e = F.cam.xyz;
  let d = length(p - e);
  let f = max(B.light2.z, 1e-4);
  let y0 = e.y - B.light2.w; let y1 = p.y - B.light2.w;
  let dy = y1 - y0;
  let avg = select((exp(-f * y0) - exp(-f * y1)) / (f * dy), exp(-f * y0), abs(dy) < 0.5);
  return exp(-B.light2.y * d * avg);
}

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  var o: VO;
  o.pos = vec4f(0.0, 0.0, -2.0, 1.0);
  o.q = vec2f(0.0); o.span = vec2f(0.0); o.col = vec3f(0.0);
  let count = u32(B.misc.w);
  if (count == 0u) { return o; }
  let layer = ii / count;
  let i = ii % count;
  let s0 = seg[i * 3u]; let s1 = seg[i * 3u + 1u]; let s2 = seg[i * 3u + 2u];
  let main = s2.y < 0.5;
  let tl = s2.x;
  var lit = select(B.light.y * s1.w * s2.z, B.light.x, main);
  let front = B.light.z;
  // The leader glows behind its front, brightest at the tip.
  if (front <= 1.0 && tl <= front) { lit += B.light.w * 0.08 * (0.35 + 0.65 * smoothstep(front - 0.1, front, tl)) * select(0.6, 1.0, main); }
  // The channel's top is inside the cloud: it fades in over the first stretch below the base.
  lit *= select(1.0, smoothstep(0.0, 0.1, tl), B.misc.x < 0.5);
  let ghost = B.light2.x * select(0.25, 1.0, main);
  if (lit + ghost < 1e-4) { return o; }

  var a = s0.xyz; var b = s1.xyz;
  var ca = F.viewProj * vec4f(a, 1.0);
  var cb = F.viewProj * vec4f(b, 1.0);
  if (ca.w < 0.2 && cb.w < 0.2) { return o; }
  if (ca.w < 0.2) { ca = mix(ca, cb, (0.2 - ca.w) / (cb.w - ca.w)); }
  if (cb.w < 0.2) { cb = mix(cb, ca, (0.2 - cb.w) / (ca.w - cb.w)); }
  let vp = F.screen.xy;
  let sa = ca.xy / ca.w * vp * 0.5;
  let sb = cb.xy / cb.w * vp * 0.5;
  var d = sb - sa;
  let L = length(d);
  d = select(vec2f(0.0, 1.0), d / L, L > 1e-4);
  let n = vec2f(-d.y, d.x);
  let focal = B.after.w * vp.y * 0.5;
  let w = 0.5 * (ca.w + cb.w);
  let isGlow = layer == 0u;
  let cloud = B.misc.x > 0.5;
  let worldW = select(B.misc.y * s0.w, B.misc.z * sqrt(s0.w) * select(1.0, 2.2, cloud), isGlow);
  let minPx = select(select(1.6, 1.1, !main), 7.0 * sqrt(s0.w) * select(1.0, 1.8, cloud), isGlow);
  let hw = 0.5 * max(worldW * focal / max(w, 0.2), minPx);

  let corner = vi % 6u;
  let end = select(0.0, 1.0, corner == 1u || corner == 2u || corner == 4u);
  let side = select(-1.0, 1.0, corner == 2u || corner == 4u || corner == 5u);
  // The core gets round caps (no gaps at the kinks); the glow stays flat-ended so joints don't double up.
  let cap = select(hw, 0.0, isGlow);
  var c = select(ca, cb, end > 0.5);
  let px = d * (end * 2.0 - 1.0) * cap + n * side * hw;
  c = vec4f(c.xy + (px * 2.0 / vp) * c.w, c.z, c.w);
  o.pos = c;
  o.q = vec2f(select(-cap, L + cap, end > 0.5) / hw, side);
  o.span = vec2f(L / hw, select(1.0, 0.0, isGlow));
  let t = fogT(mix(a, b, 0.5));
  let tint = select(B.core.rgb * B.core.w, B.glow.rgb * B.glow.w, isGlow);
  o.col = (tint * lit + B.after.rgb * ghost * select(1.0, 0.4, isGlow)) * t;
  return o;
}

@fragment fn fs(o: VO) -> @location(0) vec4f {
  let u = o.q.x; let v = o.q.y;
  let along = select(0.0, max(0.0, max(-u, u - o.span.x)), o.span.y > 0.5);
  let r2 = along * along + v * v;
  let profile = select(exp(-r2 * 3.0) * (1.0 - smoothstep(0.75, 1.0, sqrt(r2))), exp(-v * v * 4.5) * (1.0 - smoothstep(0.8, 1.0, abs(v))), o.span.y < 0.5);
  return vec4f(o.col * profile, max(max(o.col.r, o.col.g), o.col.b) * profile);
}
`

export type BoltLook = { core: readonly [number, number, number]; coreIntensity: number; glow: readonly [number, number, number]; glowIntensity: number;
  after: readonly [number, number, number]; coreWidth: number; glowWidth: number }
export const BOLT_LOOK: BoltLook = { core: [0.92, 0.95, 1], coreIntensity: 150, glow: [0.42, 0.45, 1], glowIntensity: 14, after: [0.6, 0.4, 1], coreWidth: 0.7, glowWidth: 10 }

export class BoltPass implements ScenePass {
  private readonly device: GPUDevice
  private readonly uniform: GPUBuffer
  private readonly segments: GPUBuffer
  private readonly group: GPUBindGroup
  private readonly descriptor: GPURenderPipelineDescriptor
  private readonly pipeline: GPURenderPipeline
  private reactive?: GPURenderPipeline
  private readonly u = new Float32Array(UNIFORM_FLOATS)
  private uploaded: Strike | null = null
  private count = 0
  private drawn = 0

  constructor(ctx: PassContext) {
    const d = ctx.device
    this.device = d
    this.uniform = d.createBuffer({ label: "bolt", size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.segments = d.createBuffer({ label: "bolt segments", size: MAX_BOLT_SEGMENTS * BOLT_SEGMENT_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    const layout = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    ] })
    this.group = d.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: { buffer: this.segments } }] })
    const module = d.createShaderModule({ code: BOLT_WGSL, label: "bolt" })
    this.descriptor = {
      label: "bolt",
      layout: d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout, layout] }),
      vertex: { module, entryPoint: "vs" },
      // Additive light; the HDR alpha carries the surfaces' roughness tag for reflections, so leave it alone.
      fragment: { module, entryPoint: "fs", targets: [{ format: ctx.color, writeMask: GPUColorWrite.RED | GPUColorWrite.GREEN | GPUColorWrite.BLUE,
        blend: { color: { srcFactor: "one", dstFactor: "one" }, alpha: { srcFactor: "zero", dstFactor: "one" } } }] },
      primitive: { topology: "triangle-list" },
      depthStencil: { format: ctx.depth, depthWriteEnabled: false, depthCompare: ctx.depthCompare ?? "less-equal" },
      multisample: { count: ctx.samples },
    }
    this.pipeline = d.createRenderPipeline(this.descriptor)
  }

  /** This frame's strike (or none) and its brightness; `fog` is the scene's height fog (density, falloff, base). */
  frame(strike: Strike | null, light: StrikeLight, look: BoltLook, fog: readonly [number, number, number], fovY: number) {
    if (!strike || light.channel + light.branches + light.leader + light.after < 1e-4) { this.drawn = 0; return }
    if (strike !== this.uploaded) {
      this.count = Math.min(MAX_BOLT_SEGMENTS, strike.shape.count)
      this.device.queue.writeBuffer(this.segments, 0, strike.shape.segments.buffer, strike.shape.segments.byteOffset, this.count * BOLT_SEGMENT_FLOATS * 4)
      this.uploaded = strike
    }
    this.u.set([light.channel, light.branches, light.front, light.leader, light.after, fog[0], fog[1], fog[2],
      ...look.core, look.coreIntensity, ...look.glow, look.glowIntensity,
      strike.kind === "cloud" ? 1 : 0, look.coreWidth, look.glowWidth, this.count, ...look.after, 1 / Math.tan(fovY / 2)])
    this.device.queue.writeBuffer(this.uniform, 0, this.u)
    this.drawn = this.count
  }

  draw(pass: GPURenderPassEncoder) {
    if (!this.drawn) return
    pass.setPipeline(this.pipeline)
    pass.setBindGroup(1, this.group)
    pass.draw(6, this.drawn * 2)
  }

  drawReactive(pass: GPURenderPassEncoder) {
    if (!this.drawn) return
    this.reactive ??= this.device.createRenderPipeline(reactivePipelineDescriptor(this.descriptor))
    pass.setPipeline(this.reactive)
    pass.setBindGroup(1, this.group)
    pass.draw(6, this.drawn * 2)
  }
}
