/** Whole-frame interval, first shadow start through a dependent completion marker after the composite. Never sums passes. */
export class FrameTimer {
  readonly start: GPURenderPassTimestampWrites
  readonly end: GPURenderPassTimestampWrites
  private readonly query: GPUQuerySet
  private readonly resolve: GPUBuffer
  private readonly read: GPUBuffer
  constructor(device: GPUDevice) {
    this.query = device.createQuerySet({ type: "timestamp", count: 2 })
    this.resolve = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC })
    this.read = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    this.start = { querySet: this.query, beginningOfPassWriteIndex: 0 }
    this.end = { querySet: this.query, endOfPassWriteIndex: 1 }
  }
  finish(encoder: GPUCommandEncoder, compositeTarget: GPUTextureView) {
    // Benchmark-only marker keeps instrumentation independent of the selectable look composites.
    // Its fixed overhead is present in both members of every pair. Normal frames add no pass.
    // Load/store the SAME target: an independent 1px attachment may execute before the composite
    // on a tiler, producing invalid negative intervals. This dependency joins the entire frame.
    encoder.beginRenderPass({ timestampWrites: this.end, colorAttachments: [{ view: compositeTarget, loadOp: "load", storeOp: "store" }] }).end()
    encoder.resolveQuerySet(this.query, 0, 2, this.resolve, 0)
    encoder.copyBufferToBuffer(this.resolve, 0, this.read, 0, 16)
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
