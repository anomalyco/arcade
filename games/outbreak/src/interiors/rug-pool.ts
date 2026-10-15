import { rugSpecKey, type RugSpec } from "@arcade/kit/textures/rug"
import { RUG_DIRECTORY_SLOTS } from "./wgsl"
import type { RugWorkerRequest, RugWorkerResponse } from "./rug-worker"

export type RugRequest = {
  /** Directory key (stream slot × 4 + rug index). */
  dirKey: number
  spec: RugSpec
  /** Lower is more urgent (metres from the survivor to the room). */
  priority: number
  /** Hand-painted manifest texture to use instead of the procedural bake. */
  imageUrl?: string
}

type Layer = { key: string | null; used: number }

/**
 * A small GPU texture array of baked rugs (layers 1..N) plus the packed interior tile masks (layer 0), filled by a
 * Worker off the main thread. Rugs near the survivor get layers first; the least recently needed layer is reused.
 * At most one finished bake is uploaded per `step`, so a bake never lands as a frame hitch.
 */
export class RugPool {
  readonly size: number
  readonly rugLayers: number
  readonly texture: GPUTexture
  readonly view: GPUTextureView
  /** Texture layer per directory key, -1 while unbaked. */
  readonly directory = new Float32Array(RUG_DIRECTORY_SLOTS * 4).fill(-1)
  readonly stats = { bakes: 0, uploads: 0, lastBakeMs: 0, maxBakeMs: 0, maxUploadMs: 0, pending: 0, resident: 0, tiles: false }
  private readonly layers: Layer[]
  private readonly worker: Worker | null
  private nextId = 1
  private readonly inflight = new Map<number, { key: string; tiles?: boolean }>()
  private readonly pendingKeys = new Set<string>()
  private readonly ready: { key: string; mips: ArrayBuffer[]; tiles?: boolean }[] = []
  private requests: (RugRequest & { key: string })[] = []
  private clock = 0
  private disposed = false

  constructor(private readonly device: GPUDevice, opts: { size?: number; rugLayers?: number; worker?: Worker | null } = {}) {
    this.size = opts.size ?? 1024
    this.rugLayers = Math.max(1, opts.rugLayers ?? 8)
    const mipLevelCount = Math.floor(Math.log2(this.size)) + 1
    this.texture = device.createTexture({
      label: "outbreak-rugs",
      size: [this.size, this.size, this.rugLayers + 1],
      mipLevelCount,
      format: "rgba8unorm-srgb",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    this.view = this.texture.createView({ dimension: "2d-array" })
    this.layers = Array.from({ length: this.rugLayers }, () => ({ key: null, used: 0 }))
    this.worker = opts.worker !== undefined ? opts.worker : typeof Worker !== "undefined" ? new Worker(new URL("./rug-worker.ts", import.meta.url), { type: "module" }) : null
    if (this.worker) {
      this.worker.onmessage = (ev: MessageEvent<RugWorkerResponse>) => this.receive(ev.data)
      this.post({ id: 0, kind: "tiles", size: this.size }, "tiles", true)
    }
  }

  /** GPU bytes held by the array (all layers and mips). */
  get bytes(): number {
    return Math.round(this.size * this.size * 4 * (this.rugLayers + 1) * (4 / 3))
  }

  private post(req: RugWorkerRequest, key: string, tiles = false): void {
    if (!this.worker) return
    const id = this.nextId++
    this.inflight.set(id, { key, tiles })
    this.pendingKeys.add(key)
    this.worker.postMessage({ ...req, id })
  }

  private receive(res: RugWorkerResponse): void {
    const job = this.inflight.get(res.id)
    this.inflight.delete(res.id)
    if (!job || this.disposed) return
    this.pendingKeys.delete(job.key)
    if (res.error || !res.mips.length) {
      console.warn(`[rugs] bake failed: ${res.error ?? "no data"}`)
      return
    }
    this.stats.bakes++
    this.stats.lastBakeMs = res.ms
    this.stats.maxBakeMs = Math.max(this.stats.maxBakeMs, res.ms)
    this.ready.push({ key: job.key, mips: res.mips, tiles: job.tiles })
  }

  /** Replaces the wanted rugs. Cheap; call whenever the survivor or the streamed window moves. */
  setRequests(reqs: readonly RugRequest[]): void {
    this.requests = reqs
      .map(r => ({ ...r, key: r.imageUrl ? `img|${r.imageUrl}|${this.size}` : rugSpecKey(r.spec, this.size) }))
      .sort((a, b) => a.priority - b.priority)
    this.refreshDirectory()
  }

  private refreshDirectory(): void {
    this.directory.fill(-1)
    let resident = 0
    const want = this.requests.slice(0, this.rugLayers)
    for (const r of want) {
      const li = this.layers.findIndex(l => l.key === r.key)
      if (li < 0 || r.dirKey < 0 || r.dirKey >= this.directory.length) continue
      this.layers[li]!.used = this.clock
      this.directory[r.dirKey] = li + 1
      resident++
    }
    this.stats.resident = resident
    this.stats.pending = this.pendingKeys.size
  }

  /** Uploads at most one finished bake and keeps up to two bakes in flight for the most urgent missing rugs. */
  step(): void {
    this.clock++
    const job = this.ready.shift()
    if (job) {
      const t0 = performance.now()
      if (job.tiles) {
        this.upload(0, job.mips)
        this.stats.tiles = true
      } else {
        const wanted = new Set(this.requests.slice(0, this.rugLayers).map(r => r.key))
        if (wanted.has(job.key) && !this.layers.some(l => l.key === job.key)) {
          let li = this.layers.findIndex(l => l.key === null)
          if (li < 0) {
            let oldest = Infinity
            this.layers.forEach((l, i) => {
              if (!wanted.has(l.key!) && l.used < oldest) { oldest = l.used; li = i }
            })
          }
          if (li >= 0) {
            this.upload(li + 1, job.mips)
            this.layers[li] = { key: job.key, used: this.clock }
          }
        }
      }
      this.stats.maxUploadMs = Math.max(this.stats.maxUploadMs, performance.now() - t0)
    }
    if (this.inflight.size < 2) {
      for (const r of this.requests.slice(0, this.rugLayers)) {
        if (this.inflight.size >= 2) break
        if (this.pendingKeys.has(r.key) || this.layers.some(l => l.key === r.key) || this.ready.some(j => j.key === r.key)) continue
        if (r.imageUrl) this.post({ id: 0, kind: "image", url: r.imageUrl, size: this.size }, r.key)
        else this.post({ id: 0, kind: "rug", spec: r.spec, size: this.size }, r.key)
      }
    }
    this.refreshDirectory()
  }

  /** True once every wanted rug (up to the layer count) and the tile masks are resident. */
  get settled(): boolean {
    return this.stats.tiles && this.stats.resident >= Math.min(this.rugLayers, this.requests.length) && this.ready.length === 0
  }

  private upload(layer: number, mips: ArrayBuffer[]): void {
    let s = this.size
    for (let level = 0; level < mips.length && s >= 1; level++) {
      this.device.queue.writeTexture({ texture: this.texture, mipLevel: level, origin: [0, 0, layer] }, mips[level]!, { bytesPerRow: s * 4, rowsPerImage: s }, [s, s, 1])
      s >>= 1
    }
    this.stats.uploads++
  }

  destroy(): void {
    this.disposed = true
    this.worker?.terminate()
    this.texture.destroy()
  }
}
