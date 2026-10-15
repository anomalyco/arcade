import { SKID_STRIDE, type SkidMarks } from "./skids"

export const skidShader = /* wgsl */ `
struct SkidFrame { viewProj: mat4x4f, time: vec4f }
@group(0) @binding(0) var<uniform> F: SkidFrame;

struct SI { @location(0) a: vec4f, @location(1) b: vec4f, @location(2) tint: vec4f, @location(3) life: vec4f }
struct SO {
  @builtin(position) pos: vec4f,
  @location(0) across: f32,
  @location(1) along: f32,
  @location(2) @interpolate(flat) tint: vec4f,
  @location(3) world: vec2f,
}

@vertex fn vs(@builtin(vertex_index) vi: u32, s: SI) -> SO {
  let corners = array<vec2f, 6>(vec2f(-1, 0), vec2f(1, 0), vec2f(1, 1), vec2f(-1, 0), vec2f(1, 1), vec2f(-1, 1));
  let c = corners[vi];
  let age = F.time.x - s.b.w;
  var o: SO;
  let fade = clamp((s.life.x - age) / max(s.life.y, 0.001), 0.0, 1.0);
  let d = s.b.xz - s.a.xz;
  let len = max(length(d), 0.0001);
  let right = vec2f(d.y, -d.x) / len;
  let p = mix(s.a.xyz, s.b.xyz, c.y);
  let xz = p.xz + right * c.x * s.a.w * 0.5;
  // Expired or future slots collapse to a degenerate triangle.
  let alive = select(0.0, 1.0, age >= 0.0 && age < s.life.x);
  o.pos = F.viewProj * vec4f(xz.x, p.y + 0.012, xz.y, 1.0) * alive;
  o.across = c.x;
  o.along = s.life.z + c.y * len;
  o.tint = vec4f(s.tint.rgb, s.tint.a * fade);
  o.world = xz;
  return o;
}

fn skidHash(p: vec2f) -> f32 {
  let q = fract(p * vec2f(0.1031, 0.1030));
  let r = q + dot(q, q.yx + 33.33);
  return fract((r.x + r.y) * r.x);
}

struct FO { @location(0) color: vec4f }
@fragment fn fs(o: SO) -> FO {
  let edge = 1.0 - smoothstep(0.55, 1.0, abs(o.across));
  let tread = 0.82 + 0.18 * step(0.5, fract(o.along * 9.0 + floor(abs(o.across) * 2.6) * 0.5));
  let grain = 0.72 + 0.28 * skidHash(floor(o.world * 38.0));
  let a = clamp(o.tint.a * edge * tread * grain, 0.0, 1.0);
  // Multiplies what is already lit: dark where light falls, invisible in the dark. Alpha (Look masks) is preserved.
  return FO(vec4f(mix(vec3f(1.0), o.tint.rgb, a), 1.0));
}
`

export type SkidRendererOptions = {
  depthFormat?: GPUTextureFormat
  depthCompare?: GPUCompareFunction
  samples?: number
  color?: GPUTextureFormat
}

/**
 * One instanced, multiplicative decal draw for `SkidMarks`, inside the host's HDR pass after opaque geometry.
 * Uploads only the slots written since the last frame. Binds its own group 0: hosts that rely on their own
 * group 0 afterwards must rebind it.
 */
export class SkidRenderer {
  private readonly instances: GPUBuffer
  private readonly uniform: GPUBuffer
  private readonly group: GPUBindGroup
  private readonly pipeline: GPURenderPipeline
  private readonly motionPipeline: GPURenderPipeline
  private readonly frame = new Float32Array(20)
  private count = 0
  private generation = -1
  private source: SkidMarks | null = null

  constructor(private readonly device: GPUDevice, readonly capacity = 4096, options: SkidRendererOptions = {}) {
    const d = device
    this.instances = d.createBuffer({ size: capacity * SKID_STRIDE * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    this.uniform = d.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const layout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: {} }] })
    this.group = d.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.uniform } }] })
    const module = d.createShaderModule({ code: skidShader, label: "skids" })
    const color = options.color ?? "rgba16float"
    const target: GPUColorTargetState = {
      format: color,
      blend: { color: { srcFactor: "dst", dstFactor: "zero" }, alpha: { srcFactor: "zero", dstFactor: "one" } },
    }
    const descriptor: GPURenderPipelineDescriptor = {
      label: "skids",
      layout: d.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: {
        module, entryPoint: "vs",
        buffers: [{ arrayStride: SKID_STRIDE * 4, stepMode: "instance", attributes: [0, 1, 2, 3].map(i => ({ shaderLocation: i, offset: i * 16, format: "float32x4" as const })) }],
      },
      fragment: { module, entryPoint: "fs", targets: [target] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: {
        format: options.depthFormat ?? "depth24plus", depthWriteEnabled: false, depthCompare: options.depthCompare ?? "less-equal",
        depthBias: -4, depthBiasSlopeScale: -1,
      },
      multisample: { count: options.samples ?? 4 },
    }
    this.pipeline = d.createRenderPipeline(descriptor)
    this.motionPipeline = d.createRenderPipeline({ ...descriptor, fragment: { module, entryPoint: "fs", targets: [target, { format: color, writeMask: 0 }] } })
  }

  /** Uploads new marks and the camera. `visible` false skips the draw without losing marks. */
  prepare(marks: SkidMarks, viewProj: ArrayLike<number>, visible = true) {
    if (marks !== this.source || marks.generation !== this.generation) {
      this.source = marks; this.generation = marks.generation
      marks.uploaded = marks.written - Math.min(marks.written, marks.capacity)
    }
    const n = marks.takeDirty(), cap = Math.min(this.capacity, marks.capacity)
    for (let r = 0; r < n; r++) {
      const [from, to] = marks.dirty[r]!
      const a = Math.min(from, cap), b = Math.min(to, cap)
      if (b > a) this.device.queue.writeBuffer(this.instances, a * SKID_STRIDE * 4, marks.data.buffer, a * SKID_STRIDE * 4, (b - a) * SKID_STRIDE * 4)
    }
    for (let i = 0; i < 16; i++) this.frame[i] = viewProj[i]!
    this.frame[16] = marks.time
    this.device.queue.writeBuffer(this.uniform, 0, this.frame)
    this.count = visible ? Math.min(marks.count, cap) : 0
  }

  draw(pass: GPURenderPassEncoder, motion = false) {
    if (!this.count) return
    pass.setPipeline(motion ? this.motionPipeline : this.pipeline)
    pass.setBindGroup(0, this.group)
    pass.setVertexBuffer(0, this.instances)
    pass.draw(6, this.count)
  }

  get drawn() { return this.count }

  destroy() { this.instances.destroy(); this.uniform.destroy() }
}
