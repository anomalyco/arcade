// Footstep level check: records the footsteps bus alone (other buses muted) while the player crouch-walks, walks and
// runs east along the ground-floor corridor's linoleum (5 s measured each, after a second to get up to speed), then prints each gait's integrated loudness and its level relative
// to the walk. Target: crouch about −12 dB, walk 0 dB, run about +6 dB. One headless browser at 960×600, closed at the
// end. Expects the dev server on :5196.
//
//   bun scripts/audio-levels.ts
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"

const outDir = `${import.meta.dir}/../captures/audio-levels`
mkdirSync(outDir, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"],
})
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.routeWebSocket(/.*/, () => {})
  await page.goto("http://localhost:5196/?view=corridor&only=terrain,interior")
  await page.waitForFunction(() => {
    const s = (globalThis as { __afterhours?: { ready: boolean; complete: boolean } }).__afterhours
    return !!s?.complete && s.ready
  }, null, { timeout: 240_000 })
  const run = <T>(body: string) => page.evaluate(`(async () => { const p = globalThis.__afterhoursPlayer; const A = globalThis.__afterhoursAudio; ${body} })()`) as Promise<T>
  await page.keyboard.press("KeyQ")
  await page.waitForTimeout(2500)
  await run(`
    const s = p.ctx.settings
    for (const k of ["audio.doors", "audio.ambience", "audio.horror", "audio.ui"]) s[k] = 0
    const rec = new MediaRecorder(A.tap(), { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 160000 })
    globalThis.__chunks = []
    rec.ondataavailable = (e) => globalThis.__chunks.push(e.data)
    rec.start(500)
    globalThis.__rec = rec
    globalThis.__t0 = performance.now()
  `)
  const marks: { gait: string; a: number; b: number }[] = []
  for (const [gait, keys] of [
    ["crouch", ["KeyC", "KeyW"]],
    ["walk", ["KeyW"]],
    ["run", ["ShiftLeft", "KeyW"]],
  ] as const) {
    // The ground-floor corridor's west end, heading east: room for 25 m of running.
    await run("p.pos.x = -52; p.pos.y = 0.3; p.pos.z = 0; p.yaw = -Math.PI / 2; p.pitch = 0; p.resetMotion()")
    await page.waitForTimeout(600)
    for (const k of keys) await page.keyboard.down(k)
    // Measure after the first second (up to speed).
    await page.waitForTimeout(1000)
    const a = await run<number>("return (performance.now() - globalThis.__t0) / 1000")
    await page.waitForTimeout(5000)
    const b = await run<number>("return (performance.now() - globalThis.__t0) / 1000")
    for (const k of keys) await page.keyboard.up(k)
    marks.push({ gait, a, b })
    await page.waitForTimeout(800)
  }
  const b64 = await run<string>(`
    const rec = globalThis.__rec
    await new Promise((r) => { rec.onstop = r; rec.stop() })
    const buf = new Uint8Array(await new Blob(globalThis.__chunks).arrayBuffer())
    let s = ""
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
    return btoa(s)
  `)
  const webm = `${outDir}/levels.webm`
  writeFileSync(webm, Buffer.from(b64, "base64"))
  const lufs: Record<string, number> = {}
  for (const m of marks) {
    const out = Bun.spawnSync(["ffmpeg", "-hide_banner", "-ss", String(m.a), "-t", String(m.b - m.a), "-i", webm, "-af", "ebur128", "-f", "null", "-"]).stderr.toString()
    lufs[m.gait] = Number(/I:\s+(-?[\d.]+) LUFS/.exec(out.slice(out.lastIndexOf("Summary")))?.[1])
  }
  for (const g of Object.keys(lufs)) console.log(`${g.padEnd(7)} ${lufs[g]!.toFixed(1)} LUFS  ${(lufs[g]! - lufs.walk!).toFixed(1).padStart(5)} dB vs walk`)
  console.log(errors.length ? `page errors: ${errors.slice(0, 3).join(" | ")}` : "no page errors")
} finally {
  await browser.close()
}
