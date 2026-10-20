import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { createServer } from "vite"

/**
 * Paired in-page GPU cost of Lab settings at 3456×1894: alternates variants A and B on the same page, same frozen
 * state, timing each with the renderer's timestamp queries, so cross-run drift on a shared machine cancels out.
 * AB_A / AB_B are JSON Lab overrides; AB_ROUNDS alternations (default 12) × 6 timed frames per variant per round.
 * AB_SCENES optionally replaces the street/interior poses: JSON `[{ name, x, y, zoom, hour }]`.
 */
const root = resolve(import.meta.dir, "..")
const A: Record<string, number | string> = JSON.parse(process.env.AB_A ?? "{}")
const B: Record<string, number | string> = JSON.parse(process.env.AB_B ?? "{}")
const rounds = Number(process.env.AB_ROUNDS ?? 12)
// Optional diagnostic hack applied to variant B after setup (e.g. "h.render.shadowLightCount = 0"); never shipped.
// Lamp fog on: `const m = globalThis.__abLampFog, v = h.render.volume; m.lampFog.settings.mode = "scatter";
// m.applyLampFog(h.render, Array.isArray(v) ? v[0] : v)` (and "today" in AB_HACK_A).
const hackB = process.env.AB_HACK_B ?? ""
// Optional hack applied to variant A after setup, e.g. to undo a persistent B hack.
const hackA = process.env.AB_HACK_A ?? ""
// Optional survivor aim in radians for every scene (default north, -PI/2).
const aim = Number(process.env.AB_AIM ?? -Math.PI / 2)
// AB_GPU=swiftshader times CI's software adapter (wall clock, submit to done); AB_VIEWPORT="1280x720" shrinks the 3456×1894 backbuffer.
const gpu = process.env.AB_GPU ?? "metal"
const viewport = (process.env.AB_VIEWPORT ?? "3456x1894").split("x").map(Number) as [number, number]
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "ab-gpu-hooks",
    enforce: "pre",
    transform(code, id) {
      if (id !== resolve(root, "src/main.ts")) return
      // Lab-panel-only settings (e.g. lamp fog) are not harness `setLab` keys; hacks reach them via this global.
      return `import * as __abLampFog from "./air/lamp-fog"\n;(globalThis as any).__abLampFog = __abLampFog\n${code}`
    },
  }],
})
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(executablePath)
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", `--use-angle=${gpu}`, ...(gpu === "swiftshader" ? ["--enable-unsafe-swiftshader"] : []), "--ignore-gpu-blocklist", "--mute-audio"] })
try {
  const page = await browser.newPage({ viewport: { width: Math.round(viewport[0] / 2), height: Math.round(viewport[1] / 2) }, deviceScaleFactor: 2 })
  await page.addInitScript(() => {
    const request = GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice = function (desc: GPUDeviceDescriptor = {}) {
      return request.call(this, { ...desc, requiredFeatures: this.features.has("timestamp-query") ? ["timestamp-query"] : [] })
    }
  })
  const errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  // A cold Vite transform of the whole game takes over 30 s on a loaded worker.
  await page.goto(`http://127.0.0.1:${port}/?seed=7&bench`, { timeout: 240_000 })
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, undefined, { timeout: 240_000 })
  const scenes: { name: string; x: number; y: number; zoom: number; hour: number; horde?: number }[] = JSON.parse(process.env.AB_SCENES ?? "null") ?? [
    { name: "street", x: 30, y: 41, zoom: 46, hour: 18 },
    { name: "interior", x: 27.7, y: 31, zoom: 34, hour: 19 },
  ]
  const wantDiff = process.env.AB_DIFF === "1"
  // AB_SHOT=<dir> (with AB_DIFF=1) also writes <scene>-a.png / <scene>-b.png after 32 settling frames each.
  const shotDir = process.env.AB_SHOT
  if (shotDir) mkdirSync(shotDir, { recursive: true })
  if (wantDiff) {
    await page.addStyleTag({ content: "#status, #hotbar, #stamina, #battery, .callouts, .callout, #hud, .hud, #markers, #prompt { visibility: hidden !important; }" })
  }
  const out: Record<string, unknown> = {}
  for (const scene of scenes) {
    let beautyDiff: Record<string, unknown> | undefined
    if (wantDiff) {
      beautyDiff = await page.evaluate(async ({ scene, A, aim, hackA, hackB, shoot }) => {
        const h = (window as any).__arcadeHarness
        h._savedLampGrid ??= h.render.lampGrid
        if (h._savedLampGrid) h.render.lampGrid = h._savedLampGrid
        h.freeze(true); h.reset(7); h.setLab("timeScale", 0); h.setLab("zoom", scene.zoom); h.setLab("hour", scene.hour)
        for (const [k, v] of Object.entries(A)) h.setLab(k, v)
        const t0 = performance.now()
        while (performance.now() - t0 < 8000) {
          await h.step(1 / 60)
          if (h.state().props?.ready) break
          await new Promise((r) => setTimeout(r, 20))
        }
        if (scene.horde) {
          h.setLab("cone", 180); h.setLab("range", 40)
          h.stageHordes("crossroads", scene.horde)
          h.setLab("hour", scene.hour)
          h.setLab("quality", "high")
          h.setLab("hordes.hordeWatch", false)
          h.setLab("hideUnseenZombies", true)
          h.hordeNoise()
          for (let i = 0; i < 360; i++) await h.step(1 / 60, { mx: 0, my: 0, aim, interact: false })
        } else {
          h.pose(scene.x, scene.y, aim)
          for (let i = 0; i < 12; i++) await h.step(1 / 60)
        }
        const canvas = document.querySelector("canvas")!
        const shots: string[] = []
        const capture = async (fn: string) => {
          new Function("h", fn)(h)
          // Stills settle the temporal histories first; the plain diff keeps its single frame.
          for (let i = shoot ? 32 : 1; i > 0; i--) {
            h.renderer.drawTo(h.render)
            if (i > 1) await h.renderer.device.queue.onSubmittedWorkDone()
          }
          const c = new OffscreenCanvas(canvas.width, canvas.height)
          const g = c.getContext("2d")!
          g.drawImage(canvas, 0, 0)
          if (shoot) {
            const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer())
            let bin = ""
            for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
            shots.push(btoa(bin))
          }
          return g.getImageData(0, 0, canvas.width, canvas.height)
        }
        const p = await capture(hackA)
        await new Promise((r) => setTimeout(r, 20))
        const q = await capture(hackB)
        const lg = h.render.lampGrid
        const gridStats = lg
          ? {
              lightCount: h.render.lightCount,
              directLightCount: lg.directLightCount,
              staticLampCount: lg.lightCount - lg.directLightCount,
              activeCellCount: lg.activeCellCount,
              overflowCount: lg.overflowCount,
            }
          : null
        const totalPixels = p.width * p.height
        let differOver6 = 0
        let differOver1 = 0
        let maxChannelDiff = 0
        let sumAbs = 0
        let sumSq = 0
        for (let i = 0; i < p.data.length; i += 4) {
          const dr = Math.abs(p.data[i]! - q.data[i]!)
          const dg = Math.abs(p.data[i + 1]! - q.data[i + 1]!)
          const db = Math.abs(p.data[i + 2]! - q.data[i + 2]!)
          const l1 = dr + dg + db
          const mx = Math.max(dr, dg, db)
          if (mx > maxChannelDiff) maxChannelDiff = mx
          if (mx > 1) differOver1++
          if (l1 > 6) differOver6++
          sumAbs += l1
          sumSq += dr * dr + dg * dg + db * db
        }
        return {
          ...gridStats,
          totalPixels,
          maxChannelDiff,
          meanAbsDiff: +(sumAbs / (totalPixels * 3)).toFixed(5),
          rmse: +Math.sqrt(sumSq / (totalPixels * 3)).toFixed(5),
          shareOver1Pct: +((differOver1 / totalPixels) * 100).toFixed(4),
          shareOver6Pct: +((differOver6 / totalPixels) * 100).toFixed(4),
          shots,
        }
      }, { scene, A, aim, hackA, hackB, shoot: !!shotDir })
      const { shots, ...stats } = beautyDiff as { shots: string[] }
      if (shotDir) shots.forEach((b64, i) => writeFileSync(`${shotDir}/${scene.name}-${"ab"[i]}.png`, Buffer.from(b64, "base64")))
      beautyDiff = stats
      console.log(`DIFF ${scene.name}:`, JSON.stringify(beautyDiff))
    }
    const res = await page.evaluate(async ({ scene, A, B, rounds, hackA, hackB, aim, wantDiff, wall }) => {
      const h = (window as any).__arcadeHarness
      const hack = new Function("h", hackB)
      const unhack = new Function("h", hackA)
      const sameLab = JSON.stringify(A) === JSON.stringify(B)
      const setup = async (lab: Record<string, number | string>) => {
        h._savedLampGrid ??= h.render.lampGrid
        if (h._savedLampGrid) h.render.lampGrid = h._savedLampGrid
        h.freeze(true); h.reset(7); h.setLab("timeScale", 0); h.setLab("zoom", scene.zoom); h.setLab("hour", scene.hour)
        for (const [k, v] of Object.entries(lab)) h.setLab(k, v)
        if (scene.horde) {
          h.setLab("cone", 180); h.setLab("range", 40)
          h.stageHordes("crossroads", scene.horde)
          h.setLab("hour", scene.hour)
          h.setLab("quality", "high")
          h.setLab("hordes.hordeWatch", false)
          h.setLab("hideUnseenZombies", true)
          h.hordeNoise()
          for (let i = 0; i < 360; i++) await h.step(1 / 60, { mx: 0, my: 0, aim, interact: false })
        } else {
          h.pose(scene.x, scene.y, aim)
          await h.step(1 / 60)
        }
      }
      if (sameLab && !wantDiff) await setup(A)
      const time = async () => {
        const v: number[] = []
        for (let i = 0; i < 8; i++) {
          if (!wall) { v.push(await h.renderer.measure(h.render)); continue }
          // SwiftShader's timestamps are garbage: time submit-to-done on the wall clock instead.
          const t0 = performance.now()
          h.renderer.drawTo(h.render)
          await h.renderer.device.queue.onSubmittedWorkDone()
          v.push(performance.now() - t0)
        }
        return v.slice(2).sort((a, b) => a - b)[3]!
      }
      const a: number[] = []
      const b: number[] = []
      for (let r = 0; r < rounds; r++) {
        const run = async (variant: "a" | "b") => {
          if (!sameLab) await setup(variant === "a" ? A : B)
          if (variant === "b") hack(h)
          else unhack(h)
          ;(variant === "a" ? a : b).push(await time())
        }
        if (r % 2) { await run("b"); await run("a") } else { await run("a"); await run("b") }
      }
      return { a, b }
    }, { scene, A, B, rounds, hackA, hackB, aim, wantDiff, wall: gpu === "swiftshader" })
    const med = (xs: number[]) => { const s = [...xs].sort((p, q) => p - q); return (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2 }
    const diffs = res.a.map((x, i) => res.b[i]! - x)
    out[scene.name] = { a: med(res.a), b: med(res.b), pairedDeltaMedian: med(diffs), pairedDeltaMad: med(diffs.map(d => Math.abs(d - med(diffs)))), beautyDiff, raw: res }
    console.log(`AB ${scene.name} A=${med(res.a).toFixed(3)} ms B=${med(res.b).toFixed(3)} ms paired Δ=${med(diffs).toFixed(3)} ms (MAD ${med(diffs.map(d => Math.abs(d - med(diffs)))).toFixed(3)})`)
  }
  assert.deepEqual(errors, [])
  if (process.env.AB_OUT) await Bun.write(process.env.AB_OUT, JSON.stringify({ A, B, rounds, out }, null, 2))
} finally {
  await browser.close()
  await server.close()
}
