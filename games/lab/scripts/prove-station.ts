// Runs one Lab station's demo setup and every variant against the production Lab build (headless Metal),
// asserts each command succeeds with no console errors, and captures a frame per variant.
//   bun games/lab/scripts/prove-station.ts <station-id> [--out dir]
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import type { LabStation, StationCommand } from "@arcade/kit/lab/stations/types"

const id = process.argv[2]
assert(id && !id.startsWith("--"), "usage: prove-station.ts <station-id> [--out dir]")
const outArg = process.argv.indexOf("--out")
const out = resolve(outArg > 0 ? process.argv[outArg + 1]! : resolve(import.meta.dir, `../../../captures/lab-station/${id}`))
mkdirSync(out, { recursive: true })
const lab = resolve(import.meta.dir, "..")
const station = (await import(resolve(lab, `src/stations/${id}.ts`))).default as LabStation
assert(station.demo.kind === "section", "only section demos are supported")
const demo = station.demo

if (!process.env.SKIP_BUILD) assert.equal(Bun.spawnSync(["bun", "run", "build"], { cwd: lab, stdout: "inherit", stderr: "inherit" }).exitCode, 0)
const dist = resolve(lab, "dist/arcade/lab")
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const p = new URL(req.url).pathname
    const f = Bun.file(resolve(dist, `.${p === "/" ? "/index.html" : p}`))
    return (await f.exists()) ? new Response(f) : new Response("Not found", { status: 404 })
  },
})
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter(n => /^chromium-\d+$/.test(n)).sort().reverse()
  .map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
assert(executablePath, "Playwright Chromium binary required")
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const errors: string[] = []
const results: { variant: string; commands: number }[] = []
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${server.port}/?bench${demo.game ? `&game=${demo.game}` : ""}#${demo.section}`)
  await page.waitForFunction(() => !!(window as any).lab, undefined, { timeout: 30000 })
  const run = async (steps: readonly StationCommand[] | undefined, label: string) => {
    for (const step of steps ?? []) {
      const res = await page.evaluate(([c, a]) => (window as any).lab.workbench.invoke(c, a), [step.command, step.args ?? {}] as const)
      assert.equal(res.ok, true, `${label}: ${step.command} ${JSON.stringify(step.args)} → ${JSON.stringify(res)}`)
    }
    for (let i = 0; i < 4; i++) await page.evaluate(async () => { (window as any).lab.advance(1 / 30); await (window as any).lab.render() })
    // Sections that bake off the main thread report busy until their results land.
    await page.waitForFunction(() => !(window as any).lab.busy?.(), undefined, { timeout: 30000 })
    for (let i = 0; i < 2; i++) await page.evaluate(async () => { (window as any).lab.advance(1 / 30); await (window as any).lab.render() })
  }
  await run(demo.setup, "demo")
  await page.locator("canvas").first().screenshot({ path: resolve(out, "demo.png") })
  for (const v of station.variants ?? []) {
    await run(demo.setup, `${v.id} (demo reset)`)
    await run(v.setup, v.id)
    await page.locator("canvas").first().screenshot({ path: resolve(out, `${v.id}.png`) })
    results.push({ variant: v.id, commands: v.setup?.length ?? 0 })
  }
  assert.deepEqual(errors, [])
  writeFileSync(resolve(out, "proof.json"), JSON.stringify({ station: id, results }, null, 2) + "\n")
  console.log(`station ${id}: demo + ${results.length} variants OK → ${out}`)
} finally {
  server.stop(true)
  await browser.close()
}
