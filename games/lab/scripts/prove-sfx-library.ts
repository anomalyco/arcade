// Renders every shared-library sound offline through the Lab Audio section (production build, headless Metal
// Chromium with --mute-audio). Checks that every file is fetched and decoded (not a synthesized fallback) and that
// each id renders unclipped and audible. Never auditions: only Render offline.
//   bun games/lab/scripts/prove-sfx-library.ts      (through `hivemind run --kind browser`)
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { SFX_LIBRARY } from "@arcade/kit/audio"

const lab = resolve(import.meta.dir, "..")
const out = resolve(import.meta.dir, "../../../captures/lab-sfx-library")
mkdirSync(out, { recursive: true })
if (!process.env.SKIP_BUILD) assert.equal(Bun.spawnSync(["bun", "run", "build"], { cwd: lab, stdout: "inherit", stderr: "inherit" }).exitCode, 0)
const dist = resolve(lab, "dist/arcade/lab")
const requested = new Set<string>()
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const p = new URL(req.url).pathname
  if (p.includes("/audio-assets/sfx/")) requested.add(p.split("/").pop()!)
  const f = Bun.file(resolve(dist, `.${p === "/" ? "/index.html" : p}`))
  return (await f.exists()) ? new Response(f) : new Response("Not found", { status: 404 })
} })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter((n) => /^chromium-\d+$/.test(n)).reverse()
  .map((n) => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
assert(executablePath, "Playwright Chromium binary required")
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => { if (m.type() === "error" && !/favicon/.test(m.text())) errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${server.port}/?bench#audio`)
  await page.waitForFunction(() => Boolean((window as any).audioLab), undefined, { timeout: 90_000 })
  const rows: Record<string, unknown>[] = []
  for (const entry of SFX_LIBRARY) {
    const stats = await page.evaluate(async (id) => {
      const a = (window as any).audioLab
      Object.assign(a.settings, { source: "library", librarySound: id, libraryVariant: 1, libraryDistance: 0 })
      const s = await a.triggerCurrent()
      return { peakDb: s.peakDb, lufs: s.approxLufs, clipped: s.clippedSamples, centroid: s.spectralCentroidHz, state: a.runtime.telemetry().state }
    }, entry.id)
    rows.push({ id: entry.id, ...stats })
    assert.notEqual(stats.state, "running", "rendering must not start a live context")
    assert.equal(stats.clipped, 0, `${entry.id} clips`)
    assert(stats.peakDb > -45, `${entry.id} renders silent (${stats.peakDb} dBFS)`)
  }
  const decoded = await page.evaluate(() => (window as any).audioLab.runtime.sampleBank.decodedAssetCount)
  const files = SFX_LIBRARY.reduce((n, e) => n + e.files.length, 0)
  const result = { files, requested: requested.size, decoded, rows, errors }
  writeFileSync(resolve(out, "proof.json"), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ files, requested: requested.size, decoded, errors }, null, 2))
  for (const r of rows) console.log(`${String(r.id).padEnd(24)} peak ${Number(r.peakDb).toFixed(1)} dBFS  ${Number(r.lufs).toFixed(1)} LUFS  ${Math.round(Number(r.centroid))} Hz`)
  assert.equal(requested.size, files, "every library file is fetched")
  assert(decoded >= files, "every library file decodes")
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  server.stop()
}
