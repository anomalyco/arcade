// Host side of the fast video renderer: serves a production build on localhost, opens it in headless Chrome on the real
// GPU with the page runtime (scripts/video/page.ts: virtual clock + in-page recorder) and receives the encoded streams
// the page sends back over a local WebSocket in binary batches. Scripts drive frames in page-side loops (one
// `page.evaluate` per run of frames, never per frame) and the page encodes them with WebCodecs on the GPU's media
// engine, so only compressed bitstream leaves the browser. Several sessions can run in parallel (one per page).
import { existsSync, openSync, writeSync, closeSync } from "node:fs"
import { join } from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { chromium, type Browser, type Page } from "playwright-core"
import { installPage, type EncoderSpec } from "./page"

export const ffmpeg = existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg"
export const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
export const CHROME_ARGS = [
  "--enable-unsafe-webgpu",
  "--use-angle=metal",
  "--enable-features=WebGPU",
  "--ignore-gpu-blocklist",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "--autoplay-policy=no-user-gesture-required",
]

/** Where a stream's bytes go, in post order. `write` may return a promise to apply backpressure to the page. */
export type Sink = { write(b: Uint8Array): void | Promise<void>; end(): Promise<void> }

/** Writes every batch to all the sinks. */
export function teeSink(...sinks: Sink[]): Sink {
  return {
    write: async (b) => void (await Promise.all(sinks.map((s) => s.write(b)))),
    end: async () => void (await Promise.all(sinks.map((s) => s.end()))),
  }
}

export function fileSink(path: string): Sink {
  const fd = openSync(path, "w")
  return {
    write: (b) => void writeSync(fd, b),
    end: async () => closeSync(fd),
  }
}

/**
 * A child process's stdin as a sink. By default writes queue in memory, so a slower consumer (a CPU encoder) never stalls
 * the page and catches up while the page runs unseen setup steps; `backpressure` waits for drain instead.
 */
export function procSink(p: ChildProcess, backpressure = false): Sink {
  const done = new Promise<number>((r) => p.on("close", (c) => r(c ?? 1)))
  return {
    write: (b) => (p.stdin!.write(b) || !backpressure ? undefined : new Promise<void>((r) => p.stdin!.once("drain", () => r()))),
    end: async () => {
      p.stdin!.end()
      const code = await done
      if (code !== 0) throw new Error(`${p.spawnfile} exited with ${code}`)
    },
  }
}

/** Reorders posted batches by sequence number before writing them to the sink. */
class Stream {
  private next = 0
  private held = new Map<number, Uint8Array>()
  private chain: Promise<void> = Promise.resolve()
  bytes = 0
  constructor(readonly sink: Sink) {}
  put(seq: number, b: Uint8Array): Promise<void> {
    this.held.set(seq, b)
    const ready: Uint8Array[] = []
    while (this.held.has(this.next)) {
      ready.push(this.held.get(this.next)!)
      this.held.delete(this.next++)
    }
    for (const r of ready) {
      this.bytes += r.length
      this.chain = this.chain.then(() => this.sink.write(r))
    }
    return this.chain
  }
  async end() {
    await this.chain
    if (this.held.size) throw new Error(`stream ended with ${this.held.size} batches missing`)
    await this.sink.end()
  }
}

export type Session = {
  browser: Browser
  page: Page
  base: string
  /** Routes the page's batches for stream `name` into `sink` until `close(name)`. */
  open(name: string, sink: Sink): void
  close(name: string): Promise<number>
  /** Starts the page recorder; returns its encoder description. */
  record(spec: EncoderSpec): Promise<string>
  /** Flushes the page recorder and closes its stream. */
  finish(stream: string): Promise<{ frames: number; bytes: number }>
  shutdown(): Promise<void>
}

export type LaunchOptions = { dist: string; width: number; height: number; path: string; logs?: string[]; quiet?: boolean }

export async function launch(o: LaunchOptions): Promise<Session> {
  const streams = new Map<string, Stream>()
  const server = Bun.serve<{ key: string }>({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const p = new URL(req.url).pathname
      if (p === "/__rec/ws") return srv.upgrade(req, { data: { key: "" } }) ? undefined : new Response("upgrade failed", { status: 400 })
      const f = Bun.file(join(o.dist, p === "/" ? "index.html" : p))
      return (await f.exists()) ? new Response(f) : new Response("not found", { status: 404 })
    },
    websocket: {
      maxPayloadLength: 1 << 30,
      backpressureLimit: 1 << 30,
      message(ws, msg) {
        if (typeof msg === "string") {
          ws.data.key = msg
          return
        }
        const key = ws.data.key
        const [name, seq] = key.split(" ")
        const s = streams.get(name!)
        if (!s) throw new Error(`no stream ${name}`)
        void s.put(Number(seq), new Uint8Array(msg)).then(() => ws.send(key))
      },
    },
  })
  const base = `http://127.0.0.1:${server.port}/`
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS })
  const page = await browser.newPage({ viewport: { width: o.width, height: o.height }, deviceScaleFactor: 1 })
  const logs = o.logs ?? []
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()}: ${m.text()}`)
    if ((!o.quiet && m.text().startsWith("[video]")) || m.text().startsWith("[stall]")) console.log(m.text())
  })
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`))
  await page.addInitScript(installPage)
  await page.goto(base + o.path.replace(/^\//, ""), { waitUntil: "load" })
  const s: Session = {
    browser,
    page,
    base,
    open(name, sink) {
      streams.set(name, new Stream(sink))
    },
    async close(name) {
      const st = streams.get(name)
      if (!st) return 0
      streams.delete(name)
      await st.end()
      return st.bytes
    },
    record: (spec) => page.evaluate((spec) => (globalThis as unknown as { __rec: import("./page").Recorder }).__rec.start(spec), spec).then((r) => r.hardware),
    async finish(stream) {
      const r = await page.evaluate(() => (globalThis as unknown as { __rec: import("./page").Recorder }).__rec.end())
      await s.close(stream)
      return r
    },
    async shutdown() {
      await browser.close()
      void server.stop(true)
    },
  }
  return s
}

/** The page's WebGPU adapter description; exits when it is a software one. */
export async function requireGpu(page: Page): Promise<string> {
  const adapter = await page.evaluate(async () => {
    const a = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" })
    return a ? `${a.info.vendor} / ${a.info.architecture} / ${a.info.description}` : "no adapter"
  })
  if (/swiftshader/i.test(adapter) || adapter === "no adapter") throw new Error(`no hardware WebGPU adapter (${adapter})`)
  return adapter
}

/** Encoder spec for H.264 High (level 5.1, which allows 1080p60 and up) at `kbps`. */
export function h264(stream: string, width: number, height: number, fps: number, kbps: number): EncoderSpec {
  return { mode: "webcodecs", codec: "avc1.640033", width, height, fps, bitrate: kbps * 1000, stream }
}

/**
 * A master encoder from a spec string: `h264:<kbps>`, `h264:qp<N>`, `hevc:<kbps>` or `hevc:qp<N>` (constant quantizer).
 * HEVC Main (level 5.1) packs a given quality into fewer bits; both are hardware encodes on Apple silicon.
 */
export function masterSpec(spec: string, stream: string, width: number, height: number, fps: number): EncoderSpec {
  const [codec, rate] = spec.split(":") as [string, string]
  const qp = rate.startsWith("qp") ? Number(rate.slice(2)) : null
  return {
    mode: "webcodecs",
    codec: codec === "hevc" ? "hvc1.1.6.L153.B0" : "avc1.640033",
    width,
    height,
    fps,
    bitrate: qp === null ? Number(rate) * 1000 : 0,
    quantizer: qp,
    stream,
  }
}

/** The elementary stream format (ffmpeg demuxer) an encoder spec writes. */
export const streamFormat = (spec: EncoderSpec) => (spec.codec.startsWith("hvc1") || spec.codec.startsWith("hev1") ? "hevc" : "h264")

export function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((res, rej) =>
    spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] }).on("close", (c) => (c === 0 ? res() : rej(new Error(`${cmd} ${args.slice(0, 6).join(" ")}... exited with ${c}`)))),
  )
}

/** Wraps an Annex B H.264/HEVC elementary stream (constant frame rate, no B-frames) in MP4 without re-encoding. */
export function muxH264(input: string, output: string, fps: number, format: "h264" | "hevc" = "h264"): Promise<void> {
  return run(ffmpeg, ["-y", "-loglevel", "error", ...h264In(input, fps, format), "-c", "copy", ...(format === "hevc" ? ["-tag:v", "hvc1"] : []), "-movflags", "+faststart", output])
}

/**
 * ffmpeg input args for an Annex B stream: `-r` overrides the encoder's VUI timing (Chrome writes a 240 Hz clock);
 * `hwaccel` decodes on the media engine, leaving the CPU to the delivery encoder.
 */
export function h264In(input: string, fps: number, format: "h264" | "hevc" = "h264", hwaccel = false): string[] {
  return [...(hwaccel ? ["-hwaccel", "videotoolbox"] : []), "-r", String(fps), "-f", format, "-i", input]
}

export const sec = (t0: number) => ((performance.now() - t0) / 1000).toFixed(1)
