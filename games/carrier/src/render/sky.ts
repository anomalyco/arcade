import { ATMOSPHERE_WGSL } from "./atmosphere"
import { FRAME_BINDING_WGSL } from "./frame"
import type { RelView } from "./ocean-view"
import type { Renderer, ScenePass } from "./renderer"

const SKY_WGSL = /* wgsl */ `
${FRAME_BINDING_WGSL}
${ATMOSPHERE_WGSL}
struct SkyU { invViewProj: mat4x4f, sunView: vec4f }
@group(1) @binding(0) var<uniform> U: SkyU;

struct VO { @builtin(position) pos: vec4f, @location(0) ndc: vec2f }

@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  var o: VO;
  o.pos = vec4f(p, 0.0, 1.0);
  o.ndc = p;
  return o;
}

@fragment fn fs(o: VO) -> @location(0) vec4f {
  let h = U.invViewProj * vec4f(o.ndc, 0.5, 1.0);
  let dir = normalize(h.xyz / h.w);
  // Above the horizon: the sky. Below: the same distant-sea haze the ocean fades to, so the 40 km far-plane cut and
  // the band past it are seamless, and the horizon is the crisp line between the two.
  let edge = smoothstep(-0.0006, 0.0006, dir.y);
  let s = U.sunView.xyz;
  let c = mix(seaHazeAt(dir, s), skyColorAt(dir, s), edge);
  return vec4f(c, 1.0);
}
`

/** Sky gradient, sun disc and halo, and the sea haze below the horizon. One fullscreen triangle at the far plane. */
export class Sky implements ScenePass {
  private pipe: GPURenderPipeline
  private buf: GPUBuffer
  private group: GPUBindGroup
  private device: GPUDevice

  constructor(r: Renderer) {
    const ctx = r.context
    const d = (this.device = ctx.device)
    const module = r.module(SKY_WGSL, "sky")
    const layout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }] })
    this.pipe = d.createRenderPipeline({
      label: "sky",
      layout: d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout, layout] }),
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format: ctx.color }] },
      primitive: { topology: "triangle-list" },
      depthStencil: { format: ctx.depth, depthWriteEnabled: false, depthCompare: "always" },
      multisample: { count: ctx.samples },
    })
    this.buf = d.createBuffer({ label: "sky-u", size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.group = d.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.buf } }] })
  }

  private data = new Float32Array(20)

  update(view: RelView, sunView: readonly number[]): void {
    this.data.set(view.invViewProjRel)
    this.data[16] = sunView[0]!
    this.data[17] = sunView[1]!
    this.data[18] = sunView[2]!
    this.device.queue.writeBuffer(this.buf, 0, this.data)
  }

  draw(pass: GPURenderPassEncoder): void {
    pass.setPipeline(this.pipe)
    pass.setBindGroup(1, this.group)
    pass.draw(3)
  }
}
