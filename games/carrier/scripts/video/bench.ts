// Capture-path benchmark for the video renderer (run on hailmary from a snapshot build, see scripts/video/remote.ts):
//
//   bun scripts/video/bench.ts --frames=600 --cases=cdp,step,h264,raw-null,raw-x264,h264-x264,par4
//
// Each case renders the same `?seed=7` scene for --frames 1/60 s steps at --size and reports wall time and fps.
//   cdp        the old path: one page.evaluate per frame, BGRA readback, base64 over the DevTools protocol, ffmpeg x264
//   step       in-page frame loop, no capture (the floor)
//   h264       in-page loop + WebCodecs H.264 (VideoToolbox), Annex B posted to the host
//   raw-null   in-page loop + BGRA readback posted to the host and discarded (transfer cost)
//   raw-x264   in-page loop + BGRA posted straight into ffmpeg libx264 (single generation, CPU encode)
//   h264-x264  h264 streamed into ffmpeg (decode, libx264 delivery encode) while rendering
//   parN       N pages in one browser, each the h264 case on its own share of the frames
import { mkdirSync, rmSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"
import { launch, requireGpu, h264, fileSink, procSink, muxH264, ffmpeg, sec, type Session, type Sink } from "./core"
import type { Clock, EncoderSpec, Recorder } from "./page"

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const root = resolve(import.meta.dir, "../..")
const dist = resolve(opt("dist", join(root, "dist/arcade/carrier")))
const out = resolve(opt("out", join(root, "video-out/bench")).replace(/^~/, process.env.HOME ?? "~"))
const N = Number(opt("frames", "600"))
const [W, H] = opt("size", "1920x1080").split("x").map(Number) as [number, number]
const kbps = Number(opt("kbps", "80000"))
const depth = Number(opt("depth", "2"))
const cases = opt("cases", "step,h264,raw-null,raw-x264,h264-x264,par2,par4,cdp").split(",")
mkdirSync(out, { recursive: true })

type G = { __vc: Clock; __rec: Recorder; carrier?: Record<string, any> }

async function ready(s: Session): Promise<void> {
  for (let i = 0; ; i++) {
    const ok = await s.page.evaluate(() => {
      const g = globalThis as unknown as G
      g.__vc.step(1000 / 60)
      const c = g.carrier
      return !!c?.weather?.view && (c.ocean?.tiles ?? 0) > 0 && !!c.game?.state.ship
    })
    if (ok) break
    if (i > 3000) throw new Error("the game never became ready")
    await s.page.waitForTimeout(i < 50 ? 50 : 10)
  }
  // Settle (pipelines compile), hide the HUD, then a fixed number of warm frames.
  for (let i = 0; i < 60; i++) {
    await s.page.evaluate(() => (globalThis as unknown as G).__vc.step(1000 / 60))
    await s.page.waitForTimeout(20)
  }
  await s.page.evaluate(async (depth) => {
    const g = globalThis as unknown as G
    document.getElementById("hud")!.style.display = "none"
    g.__vc.depth = depth
    for (let i = 0; i < 120; i++) await g.__vc.frame(1000 / 60, false, false)
  }, depth)
}

/** The in-page loop: n frames, capturing each when `cap`, a keyframe every 2 s. */
function loop(s: Session, n: number, cap: boolean): Promise<number> {
  return s.page.evaluate(
    async ({ n, cap }) => {
      const g = globalThis as unknown as G
      let drawn = 0
      for (let i = 0; i < n; i++) {
        if (cap) await g.__rec.room()
        if (await g.__vc.frame(1000 / 60, cap, i % 120 === 0)) drawn++
      }
      return drawn
    },
    { n, cap },
  )
}

async function open(): Promise<Session> {
  const s = await launch({ dist, width: W, height: H, path: "?seed=7&lab=0", quiet: true })
  await requireGpu(s.page)
  await ready(s)
  return s
}

const nullSink: Sink = { write: () => {}, end: async () => {} }
const x264 = (input: string[], file: string) =>
  spawn(ffmpeg, ["-y", "-loglevel", "error", ...input, "-c:v", "libx264", "-preset", "medium", "-profile:v", "high", "-pix_fmt", "yuv420p", "-b:v", "11400k", "-maxrate", "18240k", "-bufsize", "22800k", "-an", file], { stdio: ["pipe", "inherit", "inherit"] })

async function capture(s: Session, spec: EncoderSpec, sink: Sink, n = N): Promise<{ frames: number; bytes: number }> {
  s.open(spec.stream, sink)
  await s.record(spec)
  const drawn = await loop(s, n, true)
  if (drawn !== n) throw new Error(`${n - drawn} frames did not draw`)
  return s.finish(spec.stream)
}

const results: string[] = []
const report = (name: string, t0: number, frames: number, note = "") => {
  const t = (performance.now() - t0) / 1000
  const line = `${name.padEnd(10)} ${frames} frames ${t.toFixed(1)} s ${(frames / t).toFixed(1)} fps ${note}`
  console.log(line)
  results.push(line)
}

let shared = null as Session | null
const one = async () => (shared ??= await open())

for (const c of cases) {
  if (c === "step") {
    const s = await one()
    const t0 = performance.now()
    const d = await loop(s, N, false)
    report(c, t0, d)
  } else if (c === "h264") {
    const s = await one()
    const file = join(out, "h264.h264")
    const t0 = performance.now()
    const r = await capture(s, h264("v", W, H, 60, kbps), fileSink(file))
    report(c, t0, r.frames, `${(r.bytes / 1e6).toFixed(1)} MB`)
    await muxH264(file, join(out, "h264.mp4"), 60)
    rmSync(file)
  } else if (c === "raw-null") {
    const s = await one()
    const t0 = performance.now()
    const r = await capture(s, { mode: "raw", codec: "", width: W, height: H, fps: 60, bitrate: 0, stream: "v" }, nullSink)
    report(c, t0, r.frames, `${(r.bytes / 1e9).toFixed(1)} GB`)
  } else if (c === "raw-x264") {
    const s = await one()
    const file = join(out, "raw-x264.mp4")
    const t0 = performance.now()
    const p = x264(["-f", "rawvideo", "-pix_fmt", "bgra", "-s", `${W}x${H}`, "-r", "60", "-i", "-"], file)
    const r = await capture(s, { mode: "raw", codec: "", width: W, height: H, fps: 60, bitrate: 0, stream: "v" }, procSink(p))
    report(c, t0, r.frames, `${(statSync(file).size / 1e6).toFixed(1)} MB`)
  } else if (c === "h264-x264") {
    const s = await one()
    const file = join(out, "h264-x264.mp4")
    const t0 = performance.now()
    const p = x264(["-f", "h264", "-framerate", "60", "-i", "-"], file)
    const r = await capture(s, h264("v", W, H, 60, kbps), procSink(p))
    report(c, t0, r.frames, `${(statSync(file).size / 1e6).toFixed(1)} MB`)
  } else if (c.startsWith("par")) {
    const k = Number(c.slice(3))
    const t1 = performance.now()
    const ss = await Promise.all(Array.from({ length: k }, () => open()))
    console.log(`par${k}: ${k} pages ready in ${sec(t1)} s`)
    const t0 = performance.now()
    const per = Math.ceil(N / k)
    const rs = await Promise.all(ss.map((s, i) => capture(s, h264(`v${i}`, W, H, 60, kbps), fileSink(join(out, `par${i}.h264`)), per)))
    report(c, t0, rs.reduce((a, r) => a + r.frames, 0), `${k} pages x ${per}`)
    await Promise.all(ss.map((s) => s.shutdown()))
    for (let i = 0; i < k; i++) rmSync(join(out, `par${i}.h264`))
  } else if (c === "cdp") {
    // The old pipeline's per-frame path, for reference (fewer frames: it is slow).
    const s = await one()
    const n = Math.min(N, 240)
    const file = join(out, "cdp.mp4")
    const p = spawn(ffmpeg, ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgra", "-s", `${W}x${H}`, "-r", "60", "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "8", "-pix_fmt", "yuv444p", file], { stdio: ["pipe", "inherit", "inherit"] })
    const sink = procSink(p)
    const t0 = performance.now()
    for (let i = 0; i < n; i++) {
      const b64 = await s.page.evaluate(async () => {
        const g = globalThis as unknown as G
        const c = g.carrier!
        const device: GPUDevice = c.renderer.context.device
        const ctx: GPUCanvasContext = c.renderer.canvas
        await device.queue.onSubmittedWorkDone()
        while (c.renderer.inflight > 0) await new Promise((r) => setTimeout(r, 0))
        let tex: GPUTexture | null = null
        const get = ctx.getCurrentTexture.bind(ctx)
        ctx.getCurrentTexture = () => (tex ??= get())
        g.__vc.step(1000 / 60)
        await Promise.resolve()
        ctx.getCurrentTexture = get
        const t = tex as GPUTexture | null
        if (!t) throw new Error("no frame")
        const w = t.width
        const h = t.height
        const row = Math.ceil((w * 4) / 256) * 256
        const buf = device.createBuffer({ size: row * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
        const enc = device.createCommandEncoder()
        enc.copyTextureToBuffer({ texture: t }, { buffer: buf, bytesPerRow: row }, [w, h])
        device.queue.submit([enc.finish()])
        await buf.mapAsync(GPUMapMode.READ)
        const src = new Uint8Array(buf.getMappedRange())
        const bytes = new Uint8Array(w * h * 4)
        for (let y = 0; y < h; y++) bytes.set(src.subarray(y * row, y * row + w * 4), y * w * 4)
        buf.unmap()
        buf.destroy()
        let bin = ""
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        return btoa(bin)
      })
      await sink.write(Buffer.from(b64, "base64"))
    }
    await sink.end()
    report(c, t0, n)
  }
}
await shared?.shutdown()
console.log(`\n${results.join("\n")}`)
