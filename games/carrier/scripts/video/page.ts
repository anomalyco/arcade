// Page side of the video renderer, installed with `page.addInitScript(installPage)` before the game loads. Self-contained
// (it is serialised into the page): a seeded Math.random; a virtual clock that owns performance.now, Date.now and
// requestAnimationFrame and steps the game one frame at a time; and a recorder that turns canvas frames into an H.264 or
// HEVC stream with WebCodecs (VideoToolbox on macOS), or raw BGRA readbacks, and sends the bytes to the host's local
// server over a WebSocket in large binary batches, so no frame data crosses the DevTools protocol.

export type EncoderSpec = {
  width: number
  height: number
  fps: number
  /** "webcodecs": VideoEncoder (hardware); "raw": BGRA readback through the game's device; "frame": VideoFrame only (benchmark). */
  mode: "webcodecs" | "raw" | "frame"
  /** WebCodecs codec string: avc1.* (H.264) or hvc1.* (HEVC); either is written as Annex B. */
  codec: string
  /** Target bits per second ("variable" rate control), ignored when `quantizer` is set. */
  bitrate: number
  /** Constant quantizer (0-51) instead of a bitrate. */
  quantizer?: number | null
  /** Stream name the bytes are posted to. */
  stream: string
}

export type Recorder = {
  start(spec: EncoderSpec): Promise<{ hardware: string }>
  /** Encodes the canvas as it is now (call in the task that drew it). Raw mode needs the drawn texture and the device. */
  frame(canvas: HTMLCanvasElement, key: boolean, tex?: GPUTexture | null, device?: GPUDevice): void
  /** Resolves when the encoder can take another frame without growing an unbounded queue. */
  room(): Promise<void>
  /**
   * Ends the current stream at a frame boundary and continues in `stream` with a fresh encoder (so it starts on a
   * keyframe): flushes the encoder and waits until every batch of the old stream has been received.
   */
  cut(stream: string): Promise<void>
  /** Opens the socket to the host (`start` does this; call it before `post` on a page that records no video). */
  connect(): Promise<void>
  /** Posts arbitrary bytes to `stream` (ordered per stream). */
  post(stream: string, bytes: Uint8Array): void
  /** Resolves once every post has been received. */
  drain(): Promise<void>
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
  /** Page fetches and audio decodes still in flight. */
  busy(): number
  /** A real-time timeout that nothing in the page can wrap. */
  realTimeout(cb: () => void, ms: number): void
  /** Resolves once nothing has been in flight for `quietMs` of real time. */
  settle(quietMs: number, timeoutMs: number): Promise<boolean>
}

export function installPage(): void {
  const g = globalThis as unknown as { __vc: Clock; __rec: Recorder }
  // A seeded Math.random (sfc32), so effects and sounds that use it repeat exactly from run to run and page to page.
  let r0 = 0x9e3779b9
  let r1 = 0x243f6a88
  let r2 = 0xb7e15162
  let r3 = 1
  Math.random = () => {
    r0 |= 0
    r1 |= 0
    r2 |= 0
    r3 |= 0
    const t = (((r0 + r1) | 0) + r3) | 0
    r3 = (r3 + 1) | 0
    r0 = r1 ^ (r1 >>> 9)
    r1 = (r2 + (r2 << 3)) | 0
    r2 = (r2 << 21) | (r2 >>> 11)
    r2 = (r2 + t) | 0
    return (t >>> 0) / 4294967296
  }
  // In-flight loads, so a render can wait for lazily loaded sounds instead of guessing a delay.
  let busy = 0
  const track = <T>(p: Promise<T>): Promise<T> => {
    busy++
    return p.finally(() => busy--)
  }
  const realFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => track(realFetch(input, init)), globalThis.fetch)
  const decode = BaseAudioContext.prototype.decodeAudioData
  BaseAudioContext.prototype.decodeAudioData = function (this: BaseAudioContext, ...a: Parameters<typeof decode>) {
    return track(decode.apply(this, a))
  }
  const realTimeout = globalThis.setTimeout.bind(globalThis)
  const realNow = performance.now.bind(performance)

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
    busy: () => busy,
    realTimeout: (cb, ms) => void realTimeout(cb, ms),
    async settle(quietMs, timeoutMs) {
      const start = realNow()
      let quiet = realNow()
      while (realNow() - start < timeoutMs) {
        await new Promise((r) => realTimeout(r, 20))
        if (busy > 0) quiet = realNow()
        else if (realNow() - quiet >= quietMs) return true
      }
      return false
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

  // Transport: one WebSocket to the host (each batch is a text header "<stream> <seq>" then the binary; the host acks
  // "<stream> <seq>" once written). Large fetch POST bodies crawl through Chrome's upload path (~30 MB/s measured);
  // the socket is the fallback-free fast path for raw frames as well as encoded ones.
  const seqs = new Map<string, number>()
  const pending = new Set<Promise<unknown>>()
  const acks = new Map<string, () => void>()
  let ws: WebSocket | null = null
  const connect = () =>
    new Promise<void>((res, rej) => {
      if (ws && ws.readyState === WebSocket.OPEN) return res()
      const s = new WebSocket(location.origin.replace(/^http/, "ws") + "/__rec/ws")
      s.binaryType = "arraybuffer"
      s.onopen = () => {
        ws = s
        res()
      }
      s.onerror = () => rej(new Error("recorder socket failed"))
      s.onmessage = (e) => {
        acks.get(String(e.data))?.()
        acks.delete(String(e.data))
      }
    })
  const post = (stream: string, bytes: Uint8Array) => {
    const seq = seqs.get(stream) ?? 0
    seqs.set(stream, seq + 1)
    const key = `${stream} ${seq}`
    const p = new Promise<void>((res) => acks.set(key, res))
    ws!.send(key)
    ws!.send(bytes as Uint8Array<ArrayBuffer>)
    pending.add(p)
    void p.finally(() => pending.delete(p))
  }

  let spec: EncoderSpec | null = null
  let encoderConfig: VideoEncoderConfig | null = null
  const newEncoder = () => {
    const e = new VideoEncoder({
      output: (chunk) => append(chunk.byteLength, (dst) => chunk.copyTo(dst)),
      error: (err) => (failure = err),
    })
    e.configure(encoderConfig!)
    return e
  }
  let hevc = false
  let encodeOpts = (key: boolean): VideoEncoderEncodeOptions => ({ keyFrame: key })
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
      await connect()
      spec = s
      seqs.set(s.stream, 0)
      frames = 0
      bytes = 0
      if (s.mode !== "webcodecs") return { hardware: s.mode }
      hevc = s.codec.startsWith("hvc1") || s.codec.startsWith("hev1")
      const q = s.quantizer == null ? {} : hevc ? { hevc: { quantizer: s.quantizer } } : { avc: { quantizer: s.quantizer } }
      encodeOpts = (key) => ({ keyFrame: key, ...q })
      const config: VideoEncoderConfig = {
        codec: s.codec,
        width: s.width,
        height: s.height,
        framerate: s.fps,
        ...(s.quantizer == null ? { bitrate: s.bitrate, bitrateMode: "variable" as const } : { bitrateMode: "quantizer" as const }),
        latencyMode: "quality",
        hardwareAcceleration: "prefer-hardware",
        ...(hevc ? { hevc: { format: "annexb" } } : { avc: { format: "annexb" as const } }),
      }
      const sup = await VideoEncoder.isConfigSupported(config)
      if (!sup.supported) throw new Error(`encoder config not supported: ${JSON.stringify(config)}`)
      const hw = await VideoEncoder.isConfigSupported({ ...config, hardwareAcceleration: "prefer-software" })
      encoderConfig = config
      enc = newEncoder()
      return { hardware: `hardware supported; software ${hw.supported ? "also" : "not"} supported` }
    },
    frame(canvas, key, tex, device) {
      if (failure) throw failure
      if (!spec) throw new Error("recorder not started")
      const ts = Math.round((frames * 1e6) / spec.fps)
      frames++
      if (spec.mode !== "raw") {
        const f = new VideoFrame(canvas, { timestamp: ts, duration: Math.round(1e6 / spec.fps) })
        if (enc) enc.encode(f, encodeOpts(key))
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
    async cut(stream) {
      // A fresh encoder per stream: its rate control starts from the same state wherever the stream falls in the run,
      // so a stream re-rendered alone (a single shot) is bit-identical to the same stream in a full run.
      if (enc) {
        await enc.flush()
        enc.close()
        enc = newEncoder()
      }
      flushBuf()
      while (pending.size) await Promise.all([...pending])
      if (failure) throw failure
      spec!.stream = stream
      seqs.set(stream, 0)
    },
    connect,
    post,
    async drain() {
      while (pending.size) await Promise.all([...pending])
    },
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
