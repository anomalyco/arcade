/** Whole-frame interval, first shadow start through a dependent completion marker after the composite. Never sums passes. */
export class FrameTimer {
  readonly start: GPURenderPassTimestampWrites
  readonly end: GPURenderPassTimestampWrites
  private readonly query: GPUQuerySet
  private readonly resolve: GPUBuffer
  private readonly read: GPUBuffer
  private join: { format: GPUTextureFormat; pipe: GPURenderPipeline; view?: GPUTextureView; group?: GPUBindGroup } | null = null
  constructor(private readonly device: GPUDevice) {
    this.query = device.createQuerySet({ type: "timestamp", count: 2 })
    this.resolve = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC })
    this.read = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    this.start = { querySet: this.query, beginningOfPassWriteIndex: 0 }
    this.end = { querySet: this.query, endOfPassWriteIndex: 1 }
  }
  /**
   * `scene` (a sampled texture the scene wrote last, `format` the target's) joins the marker to the scene too, for
   * frames whose target does not depend on it (a final pass repeating its last picture).
   */
  finish(encoder: GPUCommandEncoder, compositeTarget: GPUTextureView, scene?: { view: GPUTextureView; format: GPUTextureFormat }) {
    // Benchmark-only marker keeps instrumentation independent of the selectable look composites.
    // Its fixed overhead is present in both members of every pair. Normal frames add no pass.
    // Load/store the SAME target: an independent 1px attachment may execute before the composite
    // on a tiler, producing invalid negative intervals. This dependency joins the entire frame.
    const pass = encoder.beginRenderPass({ timestampWrites: this.end, colorAttachments: [{ view: compositeTarget, loadOp: "load", storeOp: "store" }] })
    if (scene) {
      // One fragment that reads the scene and writes nothing.
      const join = this.joinFor(scene.format)
      if (join.view !== scene.view) {
        join.view = scene.view
        join.group = this.device.createBindGroup({ layout: join.pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: scene.view }] })
      }
      pass.setPipeline(join.pipe)
      pass.setBindGroup(0, join.group!)
      pass.setViewport(0, 0, 1, 1, 0, 1)
      pass.draw(3)
    }
    pass.end()
    encoder.resolveQuerySet(this.query, 0, 2, this.resolve, 0)
    encoder.copyBufferToBuffer(this.resolve, 0, this.read, 0, 16)
  }
  private joinFor(format: GPUTextureFormat) {
    if (this.join?.format === format) return this.join
    const module = this.device.createShaderModule({
      code: /* wgsl */ `
@group(0) @binding(0) var scene: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(f32(i & 1u) * 4.0 - 1.0, f32(i >> 1u) * 4.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4f { return textureLoad(scene, vec2i(0), 0); }
`,
    })
    const pipe = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format, writeMask: 0 }] },
      primitive: { topology: "triangle-list" },
    })
    return (this.join = { format, pipe })
  }
  async collect() {
    await this.read.mapAsync(GPUMapMode.READ)
    const stamps = new BigUint64Array(this.read.getMappedRange())
    const ms = Number(stamps[1]! - stamps[0]!) / 1e6
    this.read.unmap()
    if (!(ms > 0 && ms < 1000)) throw new Error(`Invalid total GPU interval: ${ms}`)
    return ms
  }
}
