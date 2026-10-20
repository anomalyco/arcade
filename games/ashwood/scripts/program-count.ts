// Counts the shader programs and render pipelines the whole world compiles, grouped by material name.
//
//   bun scripts/program-count.ts                     # dev server :5196, view=road, waits for the complete world
//   bun scripts/program-count.ts --view corridor --top 40 --port 5197
//
// Prints totals and the material names with the most fragment programs (each distinct program costs ~15 ms of node
// building at 1×, ~60 ms on a loaded laptop; see docs/boot-architecture.md).
import { chromium } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i < 0 ? undefined : args[i + 1]
}
const view = flag("view") ?? "road"
const top = Number(flag("top") ?? 30)
const port = Number(flag("port") ?? 5196)
const extra = flag("q") ?? ""

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
  args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"],
})
const page = await browser.newPage({ viewport: { width: 1536, height: 1024 } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
await page.goto(`http://localhost:${port}/?shot=1&view=${view}${extra ? `&${extra}` : ""}`)
await page.waitForFunction(() => (globalThis as { __ashwood?: { complete: boolean; frames: number } }).__ashwood?.complete === true, undefined, { timeout: 180_000 })
await page.waitForTimeout(1500)
const result = await page.evaluate(() => {
  type Stage = { name: string; stage: string }
  const dbg = (globalThis as { __ashwoodDebug?: { renderer: { _pipelines: { programs: Record<string, Map<string, Stage>>; caches: Map<string, unknown> } }; scene: { traverse: (f: (o: { material?: unknown; isMesh?: boolean }) => void) => void } } }).__ashwoodDebug!
  const p = dbg.renderer._pipelines
  const byName = new Map<string, { v: number; f: number }>()
  for (const stage of ["vertex", "fragment"] as const) {
    for (const s of p.programs[stage]!.values()) {
      const e = byName.get(s.name) ?? { v: 0, f: 0 }
      e[stage === "vertex" ? "v" : "f"]++
      byName.set(s.name, e)
    }
  }
  const mats = new Set<unknown>()
  dbg.scene.traverse((o) => {
    if (!o.material) return
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) mats.add(m)
  })
  return {
    vertex: p.programs.vertex!.size,
    fragment: p.programs.fragment!.size,
    pipelines: p.caches.size,
    materials: mats.size,
    names: [...byName.entries()].sort((a, b) => b[1].f + b[1].v - a[1].f - a[1].v),
  }
})
console.log(`view=${view}: ${result.fragment} fragment / ${result.vertex} vertex programs, ${result.pipelines} pipelines, ${result.materials} materials in scene`)
for (const [name, c] of result.names.slice(0, top)) console.log(`  ${String(c.f).padStart(3)} f ${String(c.v).padStart(3)} v  ${name || "(unnamed)"}`)
if (errors.length) console.log("errors:", errors.slice(0, 5))
await browser.close()
process.exit(0)
