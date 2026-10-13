import { chromium } from "playwright-core"
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "../.."), out = join(import.meta.dir, "proof-output")
mkdirSync(join(out, "frames"), { recursive: true })
// Bounded remote fixture. Interactive host previews use Nexus.
const fixture = process.argv.includes("--fixture") ? await (await import("vite")).createServer({ root, configFile: join(root, "vite.config.ts"), server: { host: "127.0.0.1", port: 0 } }) : null
await fixture?.listen()
const address = fixture?.httpServer?.address()
const host = address && typeof address === "object" ? `http://localhost:${address.port}` : "http://getaway-sound.localhost:1355"
const caches = join(process.env.HOME, "Library/Caches/ms-playwright")
const chrome = process.env.CHROME ?? readdirSync(caches).filter(n => n.startsWith("chromium-")).sort().reverse().map(n => join(caches, n, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")).find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 720, height: 1280 }, deviceScaleFactor: 1 })
  page.on("pageerror", e => errors.push(e.message))
  await page.addInitScript(() => {
    window.AudioContext = class { constructor() { throw new Error("Real-time audio prohibited in offline proof") } }
  })
  await page.goto(`${host}/?solo&bench=1&seed=7&nohud`)
  await page.waitForFunction(() => window.__getawayBench, null, { timeout: 60000 })
  await page.evaluate(async () => {
    await window.__getawayBench.ready; window.__getawayBench.reset(); window.__audioFrames = []
    const { audio } = await import("/src/audio/audio.ts")
    await audio.attachOffline(new OfflineAudioContext(2, 16 * 48000, 48000))
    audio.start = () => {}
    window.__proofAudio = audio
  })
  const frames = 450, fps = 30
  for (let i = 0; i < frames; i++) {
    await page.evaluate(async i => { window.__proofAudio.scheduleTime = i / 30; const f = await window.__getawayBench.step(i, 1 / 30, true); window.__audioFrames.push(structuredClone(f.audio)) }, i)
    await page.screenshot({ path: join(out, "frames", `${String(i).padStart(4, "0")}.jpg`), type: "jpeg", quality: 85 })
    if (i % 90 === 0) console.log(`Captured ${i}/${frames}`)
  }
  const report = { frames, fps, errors, adapter: await page.evaluate(() => window.__getawayBench.adapterInfo), versions: {} }
  // Exercise the real M handler and lab switch; block only hardware-context startup.
  report.controls = await page.evaluate(async () => {
    const { audio } = await import("/src/audio/audio.ts")
    audio.start = () => {}
    const before = audio.muted
    dispatchEvent(new KeyboardEvent("keydown", { key: "m", code: "KeyM" }))
    const toggled = audio.muted !== before
    dispatchEvent(new KeyboardEvent("keydown", { key: "m", code: "KeyM" }))
    const restored = audio.muted === before
    const checkbox = document.querySelector("[data-lab]").shadowRoot.querySelector('[data-key="proceduralAudio"]')
    checkbox.checked = false; checkbox.dispatchEvent(new Event("change"))
    const legacy = !window.__getawayBench.soundMode()
    checkbox.checked = true; checkbox.dispatchEvent(new Event("change"))
    return { muteToggle: toggled && restored, labToggle: legacy && window.__getawayBench.soundMode() }
  })
  for (const [name, procedural] of [["old", false], ["new", true]]) {
    const result = await page.evaluate(async procedural => {
      const { renderOffline } = await import("/src/audio/offline.ts")
      return renderOffline(window.__audioFrames, procedural)
    }, procedural)
    writeFileSync(join(out, `getaway-sound-${name}.wav`), Buffer.from(result.wav))
    report.versions[name] = result.stats
    console.log(name, result.stats)
  }
  writeFileSync(join(out, "proof.json"), JSON.stringify(report, null, 2))
  if (errors.length) throw new Error(errors.join("\n"))
  if (report.versions.new.clipped) throw new Error("New mixer clipped")
  if (!report.controls.muteToggle || !report.controls.labToggle) throw new Error("Audio controls failed")
} finally { await browser.close(); await fixture?.close() }

const run = async args => {
  const p = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" })
  if (await p.exited !== 0) throw new Error(args.join(" "))
}
await run(["ffmpeg", "-y", "-loglevel", "warning", "-framerate", "30", "-i", join(out, "frames/%04d.jpg"), "-i", join(out, "getaway-sound-new.wav"), "-vf", "scale=in_range=pc:out_range=tv,format=yuv420p", "-color_range", "tv", "-c:v", "h264_videotoolbox", "-profile:v", "main", "-pix_fmt", "yuv420p", "-b:v", "3500k", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-shortest", join(out, "getaway-sound-phone.mp4")])
await run(["ffmpeg", "-y", "-loglevel", "warning", "-i", join(out, "getaway-sound-old.wav"), "-i", join(out, "getaway-sound-new.wav"), "-filter_complex", "[0:a]showspectrumpic=s=1200x400:legend=1:scale=log:fscale=log:color=intensity[o];[1:a]showspectrumpic=s=1200x400:legend=1:scale=log:fscale=log:color=intensity[n];[o][n]vstack[v]", "-map", "[v]", "-frames:v", "1", join(out, "getaway-sound-spectrogram.jpg")])
for (const name of ["old", "new"]) {
  const p = Bun.spawn(["ffmpeg", "-hide_banner", "-i", join(out, `getaway-sound-${name}.wav`), "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"], { stdout: "ignore", stderr: "pipe" })
  const text = await new Response(p.stderr).text()
  if (await p.exited !== 0) throw new Error(text)
  writeFileSync(join(out, `loudness-${name}.txt`), text)
  console.log(name, text.slice(text.lastIndexOf("{")))
}
