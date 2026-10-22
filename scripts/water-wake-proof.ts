/** Actual Carrier boat/ship/wake path, deterministic clock, muted headless Metal. */
import { createServer } from "vite"
import { chromium } from "playwright-core"
import { mkdirSync, unlinkSync } from "node:fs"
import { hostname } from "node:os"
import { resolve } from "node:path"
import { writeBuildId } from "./build-id"
import { installPage, type Clock, type Recorder } from "../games/carrier/scripts/video/page"

type Debug = {
  __vc: Clock; __rec: Recorder
  carrier: { ocean: { water: { mode: "today" | "continuous" } }
    driver: { boat: { t: number; x: number; z: number; heave: number; pitch: number; roll: number; heading: number } }
    camera: { viewProj: Float64Array }; ship: { x: number; z: number; heave: number }; autoRelaunch: boolean
    inspect: { yaw: number; pitch: number; dist: number }; place(ahead: number, side: number, knots: number): void }
}
if (!hostname().startsWith("aak2-2")) throw Error("Water proof must run on mini")
const out = resolve("captures/water/wake")
mkdirSync(out, { recursive: true })
writeBuildId(resolve("games/carrier"))
const server = await createServer({ root: "games/carrier", server: { host: "127.0.0.1", port: 0, strictPort: true } })
await server.listen()
const address = server.httpServer!.address()
if (!address || typeof address === "string") throw Error("No capture port")
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const traces: number[][][] = []
try {
  for (const mode of ["today", "continuous"] as const) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
    const errors: string[] = []
    page.on("pageerror", e => errors.push(e.message))
    page.on("console", m => { if (m.type() === "error" && /gpu|wgsl|shader|validation/i.test(m.text())) errors.push(m.text()) })
    await page.addInitScript(installPage)
    await page.goto(`http://127.0.0.1:${address.port}/boat.html?seed=7&water&t0=120&ship=0.6&drone=0&targets=0&tod=15`)
    await page.waitForFunction(() => !!(globalThis as unknown as Debug).carrier, null, { polling: 100, timeout: 90_000 })
    await page.evaluate(mode => {
      const w = globalThis as unknown as Debug, c = w.carrier
      w.__vc.depth = 1
      c.autoRelaunch = false
      c.ocean.water.mode = mode
      c.place(0, -250, 28)
      c.inspect = { yaw: 0.9, pitch: 0.32, dist: 95 }
    }, mode)
    await page.keyboard.down("w")
    const result = await page.evaluate(async () => {
      const w = globalThis as unknown as Debug, c = w.carrier
      for (let i = 0; i < 240; i++) await w.__vc.frame(1000 / 60, false, false)
      const chunks: Uint8Array[] = []
      let failure: Error | null = null
      const encoder = new VideoEncoder({ output: chunk => { const a = new Uint8Array(chunk.byteLength); chunk.copyTo(a); chunks.push(a) }, error: e => { failure = e } })
      encoder.configure({ codec: "avc1.64001f", width: 1280, height: 720, framerate: 30, bitrate: 8_000_000, hardwareAcceleration: "prefer-hardware", avc: { format: "annexb" } })
      let frame = 0
      w.__rec.frame = (canvas, key) => {
        const f = new VideoFrame(canvas, { timestamp: Math.round(frame++ * 1_000_000 / 30) })
        encoder.encode(f, { keyFrame: key }); f.close()
      }
      const trace: number[][] = []
      for (let i = 0; i < 180; i++) {
        if (!await w.__vc.frame(1000 / 30, true, i === 0)) throw Error(`No draw on frame ${i}`)
        const b = c.driver.boat, s = c.ship
        trace.push([b.t, b.x, b.z, b.heave, b.pitch, b.roll, b.heading, s.x, s.z, s.heave, ...c.camera.viewProj])
        if (encoder.encodeQueueSize > 8) await encoder.flush()
      }
      await encoder.flush(); encoder.close()
      if (failure) throw failure
      const data = chunks.map(a => {
        let text = ""
        for (let i = 0; i < a.length; i += 8192) text += String.fromCharCode(...a.subarray(i, i + 8192))
        return btoa(text)
      })
      return { data, trace, frames: frame }
    })
    if (errors.length) throw Error(errors.join("\n"))
    await Bun.write(`${out}/${mode}.h264`, Buffer.concat(result.data.map(s => Buffer.from(s, "base64"))))
    traces.push(result.trace)
    await page.locator("canvas").first().screenshot({ path: `${out}/${mode}.png` })
    await page.close()
  }
  if (JSON.stringify(traces[0]) !== JSON.stringify(traces[1])) throw Error("Boat, ship or camera diverged between water modes")
  await Bun.write(`${out}/manifest.json`, JSON.stringify({ hostname: hostname(), frames: traces[0]!.length, fps: 30, seed: 7, time: 120, hour: 15, simulationAndCameraIdentical: true, traces, note: "Actual Carrier boat hull, physics and wake field in both modes; shading-only candidate, no dispersive wake simulation. Today above, candidate below." }, null, 2))
  // Encode before closing Chromium: Bun can lose subprocess-exit notifications after browser shutdown on macOS.
  const encode = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-r", "30", "-i", `${out}/today.h264`, "-r", "30", "-i", `${out}/continuous.h264`,
    "-filter_complex", "[0:v][1:v]vstack,scale=960:1080[v]",
    "-map", "[v]", "-an", "-c:v", "libx264", "-threads", "2", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", `${out}/carrier-wake.mp4`], { stdout: "inherit", stderr: "inherit" })
  if (await encode.exited) throw Error("Wake encode failed")
  for (const mode of ["today", "continuous"]) unlinkSync(`${out}/${mode}.h264`)
} finally { await browser.close(); await server.close() }
