// Sample-rate check: with the output forced to 44.1 kHz and to 48 kHz (an init script wraps AudioContext, as a
// device at that rate would set it), decodes a test tone (1 kHz + 15 kHz, Ogg Opus at 48 kHz like every shipped file)
// through the engine's own decode path, plays it through the live context and reads an analyser: the tones' levels
// and frequencies, and the strongest spurious component (resampling images/aliasing). Also reports the context and
// buffer rates, the master's peak over a short walk with footsteps and doors, and page errors (a reverb impulse at the
// wrong rate throws). One headless browser at a time. Dev server on :5196. The tone file is written to
// public/__rate-test/ for the run and removed after.
//
//   bun scripts/audio-rate-check.ts
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"

const toneDir = `${import.meta.dir}/../public/__rate-test`
mkdirSync(toneDir, { recursive: true })
Bun.spawnSync([
  "ffmpeg", "-v", "error", "-y",
  "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000:duration=1.5",
  "-f", "lavfi", "-i", "sine=frequency=15000:sample_rate=48000:duration=1.5",
  "-filter_complex", "[0][1]amix=inputs=2:normalize=0,volume=0.25", "-c:a", "libopus", "-b:a", "48k", "-ac", "1", `${toneDir}/tone.ogg`,
])
process.on("exit", () => rmSync(toneDir, { recursive: true, force: true }))

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
for (const rate of [44100, 48000]) {
  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"],
  })
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 600 } })
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(e.message))
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
    await page.addInitScript((r) => {
      const Orig = globalThis.AudioContext
      globalThis.AudioContext = class extends Orig {
        constructor(o?: AudioContextOptions) {
          super({ ...o, sampleRate: r })
        }
      } as typeof AudioContext
    }, rate)
    await page.routeWebSocket(/.*/, () => {})
    await page.goto("http://localhost:5196/?view=corridor&only=terrain,interior")
    await page.waitForFunction(() => {
      const s = (globalThis as { __afterhours?: { ready: boolean; complete: boolean } }).__afterhours
      return !!s?.complete && s.ready
    }, null, { timeout: 240_000 })
    await page.keyboard.press("KeyQ")
    await page.waitForTimeout(2500)
    const r = await page.evaluate(async () => {
      const A = (globalThis as unknown as { __afterhoursAudio: { audioContext: AudioContext | null; sfx: { decoder(v: unknown): Promise<AudioBuffer | null> } } }).__afterhoursAudio
      const ctx = A.audioContext
      if (!ctx) return { error: "no context" }
      const buf = await A.sfx.decoder({ url: "__rate-test/tone.ogg", duration: 1.5, from: "test" })
      if (!buf) return { error: "decode failed" }
      const an = ctx.createAnalyser()
      an.fftSize = 32768
      an.smoothingTimeConstant = 0
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(an)
      src.start()
      await new Promise((res) => setTimeout(res, 700))
      const f = new Float32Array(an.frequencyBinCount)
      an.getFloatFrequencyData(f)
      const hz = ctx.sampleRate / an.fftSize
      const peakNear = (target: number, w: number) => {
        let best = -Infinity
        let at = 0
        for (let i = Math.floor((target - w) / hz); i <= Math.ceil((target + w) / hz); i++) if (f[i]! > best) [best, at] = [f[i]!, i * hz]
        return { db: +best.toFixed(1), hz: Math.round(at) }
      }
      // Strongest component away from the two tones (and their skirts) and below 20 kHz.
      let spur = -Infinity
      let spurHz = 0
      for (let i = Math.ceil(200 / hz); i < Math.floor(20000 / hz); i++) {
        const fr = i * hz
        if (Math.abs(fr - 1000) < 400 || Math.abs(fr - 15000) < 400) continue
        if (f[i]! > spur) [spur, spurHz] = [f[i]!, fr]
      }
      return { ctxRate: ctx.sampleRate, bufRate: buf.sampleRate, t1k: peakNear(1000, 60), t15k: peakNear(15000, 60), spur: { db: +spur.toFixed(1), hz: Math.round(spurHz) } }
    })
    if ("error" in r) {
      console.log(`output ${rate} Hz: ${r.error}`)
      console.log(errors.length ? `  page errors: ${errors.slice(0, 3).join(" | ")}` : "  no page errors")
      continue
    }
    // The master's peak while walking down the corridor (footsteps) for 6 s.
    const peak = await page.evaluate(async () => {
      const A = (globalThis as unknown as { __afterhoursAudio: { audioContext: AudioContext; tap(): MediaStream } }).__afterhoursAudio
      const ctx = A.audioContext
      const an = ctx.createAnalyser()
      an.fftSize = 2048
      ctx.createMediaStreamSource(A.tap()).connect(an)
      const g = globalThis as unknown as { __peak: number }
      g.__peak = 0
      const d = new Float32Array(an.fftSize)
      const id = setInterval(() => {
        an.getFloatTimeDomainData(d)
        for (const v of d) g.__peak = Math.max(g.__peak, Math.abs(v))
      }, 20)
      ;(globalThis as unknown as { __peakId: number }).__peakId = id as unknown as number
      return 0
    })
    void peak
    await page.keyboard.down("ShiftLeft")
    await page.keyboard.down("KeyW")
    await page.waitForTimeout(6000)
    await page.keyboard.up("KeyW")
    await page.keyboard.up("ShiftLeft")
    const masterPeak = await page.evaluate(() => (globalThis as unknown as { __peak: number }).__peak)
    console.log(`output ${rate} Hz: ${JSON.stringify(r)} · master peak while running ${(20 * Math.log10(masterPeak + 1e-9)).toFixed(1)} dBFS`)
    console.log(errors.length ? `  page errors: ${errors.slice(0, 3).join(" | ")}` : "  no page errors")
  } finally {
    await browser.close()
  }
}
