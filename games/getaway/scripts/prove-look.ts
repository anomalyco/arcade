/// <reference types="@webgpu/types" />
import { chromium } from "playwright-core"
import { mkdirSync, writeFileSync, existsSync, readdirSync, mkdtempSync, symlinkSync, rmSync } from "node:fs"
import { join } from "node:path"

const out = process.env.LOOK_OUT ?? join(import.meta.dir, "../../../captures/getaway-look")
mkdirSync(out, { recursive: true })
// Bounded remote proof fixture; the interactive local preview is owned by Nexus.
const fixture = process.argv.includes("--fixture") ? await (await import("vite")).createServer({ server: { host: "127.0.0.1", port: 0 }, configFile: join(import.meta.dir, "../vite.config.ts") }) : null
await fixture?.listen()
const address = fixture?.httpServer?.address()
const host = typeof address === "object" && address ? `http://localhost:${address.port}` : process.env.LOOK_URL ?? "http://getaway-look.localhost:1355"
const mode = process.argv[2] ?? "stills"
const archive = process.argv.find(a => a.startsWith("--baseline="))?.slice(11)
const baselineDir = archive ? mkdtempSync(join(out, "main-source-")) : null
let baselineFixture: Awaited<ReturnType<typeof import("vite").createServer>> | null = null
if (baselineDir && archive) {
  const unpack = Bun.spawn(["tar", "-xf", archive, "-C", baselineDir])
  if (await unpack.exited !== 0) throw new Error("Could not unpack baseline")
  const root = join(baselineDir, "games/getaway")
  symlinkSync(join(import.meta.dir, "../node_modules"), join(root, "node_modules"))
  baselineFixture = await (await import("vite")).createServer({ root, base: "./", cacheDir: join(baselineDir, ".vite"), configFile: false, server: { host: "127.0.0.1", port: 0, fs: { allow: [baselineDir, join(import.meta.dir, "../node_modules")] } } })
  await baselineFixture.listen()
}
const keys = ["tightPools", "flatGround", "shopSpill", "grounding", "wallGradients", "colourGrade"]
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter(n => /^chromium-\d+$/.test(n)).reverse().map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync) ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", e => { errors.push(e.message); console.error(e.message) })
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("404")) { errors.push(m.text()); console.error(m.text()) } })
  await page.addInitScript(() => {
    const samples: number[] = []
    ;(window as any).__gpuSamples = samples
    const range = GPUBuffer.prototype.getMappedRange
    GPUBuffer.prototype.getMappedRange = function (offset = 0, size?: number) {
      const result = range.call(this, offset, size)
      if (this.size === 512 && size && size % 16 === 0) {
        const times = new BigUint64Array(result)
        let ns = 0n
        for (let i = 0; i < times.length; i += 2) ns += times[i + 1]! - times[i]!
        samples.push(Number(ns) / 1e6)
      }
      return result
    }
  })
  const load = async (url: string) => {
    await page.goto(`${url}/?solo&peaceful=1&seed=7&bench&nohud&lab=1`)
    await page.waitForFunction(() => (window as any).__getawayBench)
    const adapter = await page.evaluate(async () => { await (window as any).__getawayBench.ready; return (window as any).__getawayBench.adapterInfo })
    await page.evaluate(() => { document.querySelector<HTMLElement>("[data-lab]")!.style.display = "none" })
    return adapter
  }
  const adapter = await load(host)
  if (adapter.vendor !== "apple" || !adapter.architecture.includes("metal")) throw new Error(JSON.stringify(adapter))
  console.log("Adapter", adapter)
  const set = async (enabled: string[]) => page.evaluate(async ({ keys, enabled }) => {
    const modulePath = performance.getEntriesByType("resource").find(e => new URL(e.name).pathname === "/src/ui/debug-overlay.ts")!.name
    const { juice } = await import(/* @vite-ignore */ modulePath)
    for (const key of keys) juice[key] = enabled.includes(key)
  }, { keys, enabled })
  const run = async (name: string, enabled: string[], frames = 90, video = false) => {
    await set(enabled)
    if (video) await page.evaluate((name) => {
      const label = document.createElement("div")
      label.textContent = name === "main-route" ? "MAIN" : "LOOK"
      label.style.cssText = "position:fixed;left:14px;top:12px;color:white;background:#101620c0;padding:5px 9px;font:600 16px system-ui;z-index:1001"
      document.body.append(label)
    }, name)
    await page.evaluate(() => { (window as any).__getawayBench.reset(); (window as any).__gpuSamples.length = 0 })
    const poses: unknown[] = []
    for (let i = 0; i < frames; i++) {
      const pose = await page.evaluate(async i => {
        await (window as any).__getawayBench.step(i, 1 / 30, true)
        const b = (window as any).__world.carOf("me").body
        return { x: b.x, y: b.y, z: b.z, h: b.h, vx: b.vx, vz: b.vz }
      }, i)
      poses.push(pose)
      if (!video && i === 11) await page.screenshot({ path: join(out, `${name}-12.png`) })
      if (video) await page.screenshot({ path: join(out, `${name}-${String(i).padStart(3, "0")}.png`) })
    }
    if (!video) await page.screenshot({ path: join(out, `${name}.png`) })
    const samples = await page.evaluate(() => (window as any).__gpuSamples as number[])
    console.log(name, samples)
    return { name, samples, poses }
  }
  const runs = []
  if (mode === "compare") {
    await page.goto(`${host}/compare.html?seed=7`)
    await page.waitForFunction(() => Array.from(document.querySelectorAll("#before-stats,#after-stats")).every(e => e.textContent?.includes("verts")), null, { timeout: 30000 })
    const state = await page.evaluate(() => Array.from(document.querySelectorAll("#before-stats,#after-stats")).map(e => e.textContent))
    await page.screenshot({ path: join(out, "compare.png") })
    runs.push({ name: "production-compare", state })
  } else if (mode === "ui") {
    runs.push(await page.evaluate(async (keys) => {
      const host = document.querySelector<HTMLElement>("[data-lab]")!
      host.style.display = ""
      const root = host.shadowRoot!
      const modulePath = performance.getEntriesByType("resource").find(e => new URL(e.name).pathname === "/src/ui/debug-overlay.ts")!.name
      const { juice } = await import(/* @vite-ignore */ modulePath)
      if (root.querySelector("h3")?.textContent !== "Look") throw new Error("Missing Look group")
      for (const key of keys) {
        const input = root.querySelector<HTMLInputElement>(`input[data-key=${key}]`)!
        if (!input.checked || !juice[key]) throw new Error(`Default off: ${key}`)
        input.click()
        if (juice[key]) throw new Error(`Failed off: ${key}`)
        input.click()
        if (!juice[key]) throw new Error(`Failed on: ${key}`)
      }
      root.querySelector<HTMLButtonElement>("[data-preset=off]")!.click()
      if (keys.some(key => juice[key])) throw new Error("All Off failed")
      root.querySelector<HTMLButtonElement>("[data-preset=on]")!.click()
      if (keys.some(key => !juice[key])) throw new Error("All On failed")
      // Restore the deliberately tight helicopter light after testing the existing effects preset.
      juice.spotlightRadius = juice.spotlightSoftness = 1
      return { name: "lab", keys, passed: true }
    }, keys))
    await page.evaluate(() => (window as any).__getawayBench.step(0, 1 / 30, true))
    await page.screenshot({ path: join(out, "lab.png") })
  } else if (mode === "baseline") runs.push(await run("main", [], 60))
  else if (mode === "stills") {
    runs.push(await run("off", [], 60), await run("all-on", keys, 60))
    for (const key of keys) runs.push(await run(key, [key], 60))
  } else if (mode === "video") {
    const baselineAddress = baselineFixture?.httpServer?.address()
    if (!baselineAddress || typeof baselineAddress === "string") throw new Error("Video needs --baseline=<pristine git archive>")
    await load(`http://localhost:${baselineAddress.port}`)
    const before = await run("main-route", [], 180, true)
    runs.push(before)
    await load(host)
    const after = await run("look-route", keys, 180, true)
    runs.push(after)
    if (JSON.stringify(before.poses) !== JSON.stringify(after.poses)) throw new Error("Main/look route pose mismatch")
    const encode = Bun.spawn(["ffmpeg", "-y", "-framerate", "30", "-i", join(out, "main-route-%03d.png"), "-framerate", "30", "-i", join(out, "look-route-%03d.png"), "-filter_complex", "hstack", "-c:v", "h264_videotoolbox", "-profile:v", "high", "-q:v", "75", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(out, "getaway-look.mp4")], { stdout: "ignore", stderr: "inherit" })
    if (await encode.exited !== 0) throw new Error("Video encode failed")
  } else if (mode === "paired") {
    await run("bench-view", [], 12)
    await page.evaluate(async () => {
      const modulePath = performance.getEntriesByType("resource").find(e => new URL(e.name).pathname === "/src/ui/debug-overlay.ts")!.name
      ;(window as any).__lookJuice = (await import(/* @vite-ignore */ modulePath)).juice
    })
    const targets = process.argv.includes("--individual") ? ["all", ...keys] : ["all"]
    for (const target of targets) for (let run = -1; run < 7; run++) {
      const pair = await page.evaluate(async ({ keys, target, run }) => {
        const w = window as any, b = w.__getawayBench
        const on: number[] = [], off: number[] = [], deltas: number[] = []
        for (let pair = 0; pair < 24; pair++) {
          const values: number[] = []
          for (const enabled of (pair + run) % 2 ? [true, false] : [false, true]) {
            for (const key of keys) w.__lookJuice[key] = enabled && (target === "all" || target === key)
            const before = w.__gpuSamples.length
            // Exactly one fresh hardware sample from this state, no queue-latency substitute.
            for (let frame = 0; w.__gpuSamples.length === before && frame < 20; frame++) await b.step(12, 0, true)
            if (w.__gpuSamples.length === before) throw new Error("Missing hardware timestamp")
            const value = w.__gpuSamples.at(-1)
            ;(enabled ? on : off).push(value)
            values[enabled ? 1 : 0] = value
          }
          deltas.push(values[1]! - values[0]!)
        }
        return { on, off, deltas }
      }, { keys, target, run })
      console.log(target, run, "paired median", pair.deltas.slice().sort((a, b) => a - b)[12])
      runs.push({ name: `${target}-${run < 0 ? "warmup" : run}`, ...pair })
    }
  } else if (mode === "bench") {
    // Freeze the same staged route frame, then measure device timestamps only.
    await run("bench-view", [], 60)
    const measure = async (name: string, enabled: string[]) => {
      await set(enabled)
      const samples = await page.evaluate(async () => {
        const b = (window as any).__getawayBench
        for (let i = 0; i < 40; i++) await b.step(60, 0, true)
        ;(window as any).__gpuSamples.length = 0
        for (let i = 0; i < 200; i++) await b.step(60, 0, true)
        return [...(window as any).__gpuSamples] as number[]
      })
      console.log(name, samples.slice().sort((a, b) => a - b)[Math.floor(samples.length / 2)])
      return { name, samples }
    }
    const targets = process.argv.includes("--individual") ? ["all", ...keys] : ["all"]
    for (const target of targets) for (let i = -1; i < 7; i++) for (const on of i % 2 ? [true, false] : [false, true]) {
      runs.push(await measure(`${target}-${i < 0 ? "warmup" : i}-${on ? "on" : "off"}`, on ? target === "all" ? keys : [target] : []))
    }
  }
  writeFileSync(join(out, `${mode}.json`), JSON.stringify({ adapter, errors, runs }, null, 2))
  if (errors.length) throw new Error(errors.join("\n"))
} finally {
  await browser.close()
  await fixture?.close()
  await baselineFixture?.close()
  if (baselineDir) rmSync(baselineDir, { recursive: true, force: true })
}
