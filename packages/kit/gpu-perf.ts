/** Device-side instrumentation, shared by old and new renderers without changing either renderer. */
export class GpuPerf {
  gpuMs: number | null = null
  readonly gpuKind: "timestamp" | "queue-wait"
  draws = 0
  verts = 0
  enabled = true

  constructor(device: GPUDevice) {
    const timestamps = device.features.has("timestamp-query")
    this.gpuKind = timestamps ? "timestamp" : "queue-wait"
    const count = 64
    const queries = timestamps ? device.createQuerySet({ type: "timestamp", count }) : null
    const resolve = queries ? device.createBuffer({ size: count * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }) : null
    const read = queries ? device.createBuffer({ size: count * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }) : null
    let pending = false
    let frame = 0
    type Sample = { draws: number; verts: number; slots: number; sampled: boolean }
    const buffers = new WeakMap<GPUCommandBuffer, Sample>()
    const create = device.createCommandEncoder.bind(device)
    device.createCommandEncoder = (descriptor) => {
      const encoder = create(descriptor)
      const sample: Sample = { draws: 0, verts: 0, slots: 0, sampled: false }
      let started = false
      const writes = () => {
        if (!started) {
          started = true
          sample.sampled = this.enabled && ++frame % 10 === 0 && !pending
          if (sample.sampled) pending = true
        }
        if (!sample.sampled || !queries || sample.slots + 2 > count) return undefined
        return { querySet: queries, beginningOfPassWriteIndex: sample.slots++, endOfPassWriteIndex: sample.slots++ }
      }
      const render = encoder.beginRenderPass.bind(encoder)
      encoder.beginRenderPass = (desc) => {
        const timestampWrites = writes()
        const pass = render(timestampWrites ? { ...desc, timestampWrites } : desc)
        const draw = pass.draw.bind(pass)
        pass.draw = (vertices, instances = 1, first = 0, firstInstance = 0) => {
          sample.draws++
          sample.verts += vertices * instances
          draw(vertices, instances, first, firstInstance)
        }
        const indexed = pass.drawIndexed.bind(pass)
        pass.drawIndexed = (indices, instances = 1, first = 0, base = 0, firstInstance = 0) => {
          sample.draws++
          sample.verts += indices * instances
          indexed(indices, instances, first, base, firstInstance)
        }
        return pass
      }
      const compute = encoder.beginComputePass.bind(encoder)
      encoder.beginComputePass = (desc) => {
        const timestampWrites = writes()
        return compute(timestampWrites ? { ...desc, timestampWrites } : desc)
      }
      const finish = encoder.finish.bind(encoder)
      encoder.finish = (desc) => {
        if (sample.slots && queries && resolve && read) {
          encoder.resolveQuerySet(queries, 0, sample.slots, resolve, 0)
          encoder.copyBufferToBuffer(resolve, 0, read, 0, sample.slots * 8)
        }
        const buffer = finish(desc)
        if (started) buffers.set(buffer, sample)
        return buffer
      }
      return encoder
    }
    const submit = device.queue.submit.bind(device.queue)
    device.queue.submit = (commands) => {
      const list = [...commands]
      submit(list)
      const samples = list.map((buffer) => buffers.get(buffer)).filter((s): s is Sample => !!s)
      if (!samples.length) return
      this.draws = samples.reduce((n, s) => n + s.draws, 0)
      this.verts = samples.reduce((n, s) => n + s.verts, 0)
      const sample = samples.find((s) => s.sampled)
      if (!sample) return
      const start = performance.now()
      const collect = async () => {
        if (sample.slots && read) {
          await read.mapAsync(GPUMapMode.READ)
          const times = new BigUint64Array(read.getMappedRange(0, sample.slots * 8))
          let ns = 0n
          for (let i = 0; i < sample.slots; i += 2) ns += times[i + 1]! - times[i]!
          read.unmap()
          this.gpuMs = Number(ns) / 1e6
        } else {
          await device.queue.onSubmittedWorkDone()
          this.gpuMs = performance.now() - start
        }
      }
      void collect().catch((error) => {
        this.gpuMs = null
        console.error("GPU telemetry failed", error)
      }).finally(() => { pending = false })
    }
  }
}

export type FramePerfSample = { fps: number; frameMs: number; p95Ms: number; gpuMs: number | null; gpuKind: string; draws: number; verts: number; chunks: number; lights: number }

/** Rolling frame-time percentile and GPU telemetry tracker for embedded game DebugOverlay panels. */
export class PerfSampler {
  private samples: number[] = []
  private lastReport = 0
  sample: FramePerfSample = { fps: 0, frameMs: 0, p95Ms: 0, gpuMs: null, gpuKind: "timestamp", draws: 0, verts: 0, chunks: 0, lights: 0 }

  constructor(private readonly windowSize = 180) {}

  reset(): void { this.samples.length = 0; this.lastReport = 0 }

  update(now: number, elapsedMs: number, stats: Pick<FramePerfSample, "gpuMs" | "gpuKind" | "draws" | "verts" | "chunks" | "lights">, headerEl?: HTMLElement | null): FramePerfSample | null {
    if (elapsedMs > 0 && elapsedMs < 1000 && Number.isFinite(elapsedMs)) this.samples.push(elapsedMs)
    if (this.samples.length > this.windowSize) this.samples.shift()
    if (typeof document !== "undefined" && document.hidden) { this.reset(); return null }
    if (now - this.lastReport < 150 || !this.samples.length) return null
    this.lastReport = now
    const sorted = [...this.samples].sort((a, b) => a - b), n = sorted.length
    const frameMs = sorted[Math.floor((n - 1) * 0.5)] ?? 0, p95Ms = sorted[Math.floor((n - 1) * 0.95)] ?? 0
    const fps = (1000 * n) / (this.samples.reduce((a, b) => a + b, 0) || 1)
    this.sample = { ...stats, fps, frameMs, p95Ms }
    if (headerEl) headerEl.textContent = `FPS ${fps.toFixed(0)} · Frame ms ${frameMs.toFixed(1)} / ${p95Ms.toFixed(1)}\nGPU ${stats.gpuKind === "timestamp" ? "HW" : "queue-wait"} ms ${stats.gpuMs?.toFixed(2) ?? "—"}`
    return this.sample
  }
}
