/// <reference types="@webgpu/types" />
// Getaway pixel parity for the shared driving FX: renders the same seeded drift (tyre smoke, skids, sparks) with the
// shared modules from BASE_REF (default origin/main) and from the working tree, and requires identical screenshots.
// Headless Metal, muted, no visible window: `hivemind run --kind browser -- bun games/getaway/scripts/prove-driving-fx-parity.ts`
import { chromium } from "playwright-core"
import { createServer, type ViteDevServer } from "vite"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const root = resolve(import.meta.dir, "../../.."), out = join(root, "captures/driving-fx")
mkdirSync(out, { recursive: true })
const base = process.env.BASE_REF ?? "origin/main"
const shared = ["packages/kit/fx/smoke-trail.ts", "packages/kit/fx/tyre-renderer.ts", "packages/kit/vehicle/emissions.ts", "packages/kit/vehicle/fx.ts", "packages/kit/vehicle/types.ts"]
// Fleet workers sync the tree without .git or ignored files: `--snapshot` (run locally first) stores the base files in perf/.
const snapshot = join(root, "perf/driving-fx-baseline")
const baseline = new Map(shared.map(p => {
  const r = Bun.spawnSync(["git", "show", `${base}:${p}`], { cwd: root })
  if (r.exitCode === 0) {
    mkdirSync(dirname(join(snapshot, p)), { recursive: true }); writeFileSync(join(snapshot, p), r.stdout)
    return [join(root, p), r.stdout.toString()]
  }
  if (!existsSync(join(snapshot, p))) throw Error(`No ${base}:${p}; run once with git to snapshot it`)
  return [join(root, p), readFileSync(join(snapshot, p), "utf8")]
}))
if (process.argv.includes("--snapshot")) process.exit(0)
const servers: ViteDevServer[] = [], swapped = new Set<string>()
const fixture = async (useBase: boolean) => {
  const dir = join(root, "games/getaway")
  const server = await createServer({
    root: dir, configFile: join(dir, "vite.config.ts"), server: { host: "127.0.0.1", port: 0 }, logLevel: "error",
    plugins: useBase ? [{ name: "driving-fx-baseline", enforce: "pre", load: (id: string) => {
      const code = baseline.get(id.split("?")[0]!)
      if (code !== undefined) swapped.add(id)
      return code
    } }] : [],
  })
  servers.push(server); await server.listen()
  const a = server.httpServer!.address()
  if (!a || typeof a === "string") throw Error("No fixture port")
  return `http://localhost:${a.port}`
}
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter(n => /^chromium-\d+$/.test(n)).sort().reverse()
  .map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const report: Record<string, unknown> = { base }
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 640 } })
  const errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  const shots: Record<string, Buffer[]> = {}
  for (const useBase of [true, false]) {
    const url = await fixture(useBase)
    for (const study of ["drift", "burnout", "launch", "pops"]) {
      await page.goto(`${url}/?solo&peaceful=1&seed=7&bench&nohud`)
      await page.waitForFunction(() => (window as any).__getawayBench)
      await page.evaluate(async (study) => {
        const b = (window as any).__getawayBench; await b.ready
        const { motionBlur } = await import(/* @vite-ignore */ "/src/render/motion.ts"); motionBlur.enabled = false
        b.emissionStudy(study); b.distance(38); b.reset(true)
      }, study)
      const frames: number[] = []
      for (let i = 0; i <= 64; i++) {
        const t0 = Date.now()
        await page.evaluate(async (i) => { await (window as any).__getawayBench.step(i, 1 / 30, true) }, i)
        frames.push(Date.now() - t0)
      }
      const shot = await page.screenshot({ path: join(out, `getaway-${study}-${useBase ? "base" : "shared"}.png`) })
      ;(shots[study] ??= []).push(shot)
      report[`${study}-${useBase ? "base" : "shared"}-step-ms`] = frames.slice(8).reduce((a, b) => a + b, 0) / (frames.length - 8)
    }
  }
  for (const [study, [a, b]] of Object.entries(shots)) {
    const identical = a!.equals(b!)
    report[study] = { identical, bytes: [a!.length, b!.length] }
    if (!identical) throw Error(`Getaway ${study} differs from ${base}`)
  }
  report.baseModulesLoaded = swapped.size
  if (swapped.size < 3) throw Error(`Only ${swapped.size} base modules were swapped in`)
  if (errors.length) throw Error(errors.join("\n"))
  report.ok = true
} finally {
  writeFileSync(join(out, "getaway-parity.json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  await browser.close()
  await Promise.all(servers.map(s => s.close()))
}
