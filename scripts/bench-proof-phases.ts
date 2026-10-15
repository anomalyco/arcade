// Times the phases every Playwright proof pays: browser launch, page creation, page load, harness readiness
// (WebGPU adapter + shader warmup + first frame) and screenshots, for Outbreak's production bundle.
//   bun scripts/bench-proof-phases.ts [--runs 5] [--swiftshader]
// Run on the fleet: hivemind run --kind browser -- bun scripts/bench-proof-phases.ts
import { existsSync, mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { chromium, type Browser } from "playwright-core"

const args = process.argv.slice(2)
const runs = Number(args[args.indexOf("--runs") + 1] || 5) || 5
const swiftshader = args.includes("--swiftshader")
const game = resolve(import.meta.dir, "../games/outbreak")
const root = resolve(game, "dist/arcade/outbreak")
const t0 = performance.now()
if (!existsSync(join(root, "index.html")) || args.includes("--build")) {
  Bun.spawnSync(["bun", "run", "build"], { cwd: game, stdout: "ignore", stderr: "inherit" })
}
console.log(`PHASE build ${(performance.now() - t0).toFixed(0)}ms`)
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname
    const file = resolve(root, `.${path === "/" ? "/index.html" : path}`)
    if (!file.startsWith(root + sep)) return new Response("Not found", { status: 404 })
    const f = Bun.file(file)
    return (await f.exists()) ? new Response(f) : new Response("Not found", { status: 404 })
  },
})
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const gpuArgs = swiftshader
  ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--enable-features=Vulkan", "--use-vulkan=swiftshader"]
  : ["--use-angle=metal", "--ignore-gpu-blocklist"]
const launch = () =>
  chromium.launch({ executablePath: swiftshader ? undefined : chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", ...gpuArgs] })

const samples: Record<string, number[]> = {}
const mark = (name: string, start: number) => {
  const ms = performance.now() - start
  ;(samples[name] ??= []).push(ms)
  return ms
}
const out = mkdtempSync(join(tmpdir(), "proof-phases-"))

async function load(browser: Browser, prefix: string, dpr: number) {
  let t = performance.now()
  const page = await browser.newPage({ viewport: { width: 1000, height: 680 }, deviceScaleFactor: dpr })
  mark(`${prefix}newPage`, t)
  t = performance.now()
  await page.goto(`http://127.0.0.1:${server.port}/?solo&seed=7&bench`, { waitUntil: "load" })
  mark(`${prefix}goto(load)`, t)
  t = performance.now()
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 60_000 })
  mark(`${prefix}harness ready`, t)
  t = performance.now()
  await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    for (let i = 0; i < 5; i++) await h.step()
  })
  mark(`${prefix}5 steps`, t)
  t = performance.now()
  await page.screenshot({ path: join(out, `${prefix}${dpr}.png`) })
  mark(`${prefix}screenshot dpr${dpr}`, t)
  return page
}

for (let run = 0; run < runs + 1; run++) {
  const warm = run === 0 ? "warmup:" : ""
  let t = performance.now()
  const browser = await launch()
  mark(`${warm}launch`, t)
  const page = await load(browser, warm, 1)
  t = performance.now()
  await page.screenshot({ path: join(out, `again.png`) })
  mark(`${warm}screenshot dpr1 (2nd)`, t)
  await page.close()
  // A second page in the same browser: what a reused browser saves.
  const page2 = await load(browser, `${warm}reused:`, 2)
  await page2.close()
  await browser.close()
}
server.stop()
for (const [name, xs] of Object.entries(samples)) {
  if (name.startsWith("warmup:")) continue
  const s = [...xs].sort((a, b) => a - b)
  console.log(`METRIC ${name.padEnd(28)} median=${s[s.length >> 1]!.toFixed(0)}ms min=${s[0]!.toFixed(0)} max=${s.at(-1)!.toFixed(0)} n=${s.length}`)
}
