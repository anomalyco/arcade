// Page side of the video renderer, installed with `page.addInitScript(installPage)` before the game loads. Self-contained
// (it is serialised into the page): a virtual clock that owns performance.now, Date.now and requestAnimationFrame, and a
// recorder that turns canvas frames into an H.264 stream with WebCodecs (VideoToolbox on macOS) or raw BGRA readbacks,
// and posts the bytes to the host's local server in large binary batches (`POST /__rec/<stream>/<seq>`), so no frame
// data crosses the DevTools protocol.

export type EncoderSpec = {
  width: number
  height: number
  fps: number
  /** "h264": WebCodecs VideoEncoder; "raw": BGRA readback through the game's device. */
  mode: "h264" | "raw"
  codec: string
  bitrate: number
  /** Stream name the bytes are posted to. */
  stream: string
}

export type Recorder = {
  start(spec: EncoderSpec): Promise<{ hardware: string }>
  /** Encodes the canvas as it is now (call in the task that drew it). Raw mode needs the drawn texture and the device. */
  frame(canvas: HTMLCanvasElement, key: boolean, tex?: GPUTexture | null, device?: GPUDevice): void
  /** Resolves when the encoder can take another frame without growing an unbounded queue. */
  room(): Promise<void>
  /** Posts arbitrary bytes to `stream` (ordered per stream). */
  post(stream: string, bytes: Uint8Array): void
  end(): Promise<{ frames: number; bytes: number }>
  stats(): { frames: number; bytes: number; queue: number }
}

export type Clock = {
  readonly now: number
  /** Frames the GPU may still be working on when the next one starts (1 = draw only on an idle GPU). */
  depth: number
  /** Advances the clock and runs the queued animation-frame callbacks. */
  step(ms: number): number
  /**
   * One game frame of `ms`: waits until the renderer can draw (it drops frames while two are in flight), steps the clock,
   * lets the renderer's draw microtask run and, if `capture`, records the drawn canvas. Returns false when nothing drew.
   */
  frame(ms: number, capture: boolean, key: boolean): Promise<boolean>
}

export function installPage(): void {
  const g = globalThis as unknown as { __vc: Clock; __rec: Recorder }
  let now = 0
  const d0 = Date.now()
  let queue: FrameRequestCallback[] = []
  performance.now = () => now
  Date.now = () => d0 + now
  globalThis.requestAnimationFrame = (cb) => {
    queue.push(cb)
    return queue.length
  }
  globalThis.cancelAnimationFrame = () => {}
  g.__vc = {
    depth: 2,
    get now() {
      return now
    },
    step(ms: number) {
      now += ms
      const q = queue
      queue = []
      for (const cb of q) cb(now)
      return q.length
    },
    async frame(ms, capture, key) {
      const c = (globalThis as unknown as { carrier: { renderer: Record<string, any> } }).carrier
      const r = c.renderer
      const device: GPUDevice = r.context.device
      const ctx: GPUCanvasContext = r.canvas
      if (!configured) {
        configured = true
        ctx.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: "opaque", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
      }
      while (r.inflight >= this.depth) await device.queue.onSubmittedWorkDone()
      let tex: GPUTexture | null = null
      const get = ctx.getCurrentTexture.bind(ctx)
      ctx.getCurrentTexture = () => (tex ??= get())
      this.step(ms)
      await Promise.resolve()
      ctx.getCurrentTexture = get
      if (capture && tex) g.__rec.frame(ctx.canvas as HTMLCanvasElement, key, tex, device)
      return tex !== null
    },
  }
  let configured = false

  const seqs = new Map<string, number>()
  const pending = new Set<Promise<unknown>>()
  const post = (stream: string, bytes: Uint8Array) => {
    const seq = seqs.get(stream) ?? 0
    seqs.set(stream, seq + 1)
    const p = fetch(`/__rec/${stream}/${seq}`, { method: "POST", body: bytes as Uint8Array<ArrayBuffer> }).then((r) => {
      if (!r.ok) throw new Error(`post ${stream}/${seq}: ${r.status}`)
    })
    pending.add(p)
    void p.finally(() => pending.delete(p))
  }

  let spec: EncoderSpec | null = null
  let enc: VideoEncoder | null = null
  let failure: unknown = null
  let frames = 0
  let bytes = 0
  // Encoded bytes are batched into ~4 MB posts.
  const BATCH = 4 << 20
  let buf = new Uint8Array(BATCH * 2)
  let len = 0
  const flushBuf = () => {
    if (!len || !spec) return
    post(spec.stream, buf.slice(0, len))
    len = 0
  }
  const append = (n: number, write: (dst: Uint8Array) => void) => {
    if (len + n > buf.length) {
      const nb = new Uint8Array(Math.max(buf.length * 2, len + n))
      nb.set(buf.subarray(0, len))
      buf = nb
    }
    write(buf.subarray(len, len + n))
    len += n
    bytes += n
    if (len >= BATCH) flushBuf()
  }
  // Raw readbacks in flight (copy now, map later, so the GPU and the page overlap).
  const reads: Promise<void>[] = []

  g.__rec = {
    async start(s) {
      spec = s
      seqs.set(s.stream, 0)
      frames = 0
      bytes = 0
      if (s.mode === "raw") return { hardware: "raw" }
      const config: VideoEncoderConfig = {
        codec: s.codec,
        width: s.width,
        height: s.height,
        framerate: s.fps,
        bitrate: s.bitrate,
        bitrateMode: "variable",
        latencyMode: "quality",
        hardwareAcceleration: "prefer-hardware",
        avc: { format: "annexb" },
      }
      const sup = await VideoEncoder.isConfigSupported(config)
      if (!sup.supported) throw new Error(`encoder config not supported: ${JSON.stringify(config)}`)
      const hw = await VideoEncoder.isConfigSupported({ ...config, hardwareAcceleration: "prefer-software" })
      enc = new VideoEncoder({
        output: (chunk) => append(chunk.byteLength, (dst) => chunk.copyTo(dst)),
        error: (e) => (failure = e),
      })
      enc.configure(config)
      return { hardware: `hardware supported; software ${hw.supported ? "also" : "not"} supported` }
    },
    frame(canvas, key, tex, device) {
      if (failure) throw failure
      if (!spec) throw new Error("recorder not started")
      const ts = Math.round((frames * 1e6) / spec.fps)
      frames++
      if (spec.mode === "h264") {
        const f = new VideoFrame(canvas, { timestamp: ts, duration: Math.round(1e6 / spec.fps) })
        enc!.encode(f, { keyFrame: key })
        f.close()
        return
      }
      if (!tex || !device) throw new Error("raw capture needs the drawn texture")
      const w = tex.width
      const h = tex.height
      const row = Math.ceil((w * 4) / 256) * 256
      const gb = device.createBuffer({ size: row * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
      const ce = device.createCommandEncoder()
      ce.copyTextureToBuffer({ texture: tex }, { buffer: gb, bytesPerRow: row }, [w, h])
      device.queue.submit([ce.finish()])
      const bgra = tex.format === "bgra8unorm"
      const prev = reads.at(-1) ?? Promise.resolve()
      const p = gb.mapAsync(GPUMapMode.READ).then(async () => {
        await prev
        const src = new Uint8Array(gb.getMappedRange())
        const out = new Uint8Array(w * h * 4)
        for (let y = 0; y < h; y++) out.set(src.subarray(y * row, y * row + w * 4), y * w * 4)
        gb.unmap()
        gb.destroy()
        if (!bgra) for (let i = 0; i < out.length; i += 4) [out[i], out[i + 2]] = [out[i + 2]!, out[i]!]
        bytes += out.length
        post(spec!.stream, out)
      })
      reads.push(p)
    },
    async room() {
      if (failure) throw failure
      if (enc) while (enc.encodeQueueSize > 4) await new Promise((r) => enc!.addEventListener("dequeue", r, { once: true }))
      while (reads.length > 3) await reads.shift()
      while (pending.size > 6) await Promise.race(pending)
    },
    post,
    async end() {
      if (enc) {
        await enc.flush()
        enc.close()
        enc = null
      }
      await Promise.all(reads.splice(0))
      flushBuf()
      while (pending.size) await Promise.all([...pending])
      if (failure) throw failure
      return { frames, bytes }
    },
    stats: () => ({ frames, bytes, queue: enc?.encodeQueueSize ?? reads.length }),
  }
}
