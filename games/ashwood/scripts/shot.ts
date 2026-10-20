// Headless capture of named viewpoints on the Metal adapter (macOS), with frame and GPU timings.
//
//   bun scripts/shot.ts                       # every viewpoint
//   bun scripts/shot.ts gate lot --tag fence  # selected views, files named <view>-<tag>.png
//   bun scripts/shot.ts corridor --q "flashlight=1&only=facility,interior" --size 1600x900 --frames 120
//
// Expects the dev server on :5196 (`bun run dev`); starts one if nothing answers. Output: captures/<view>[-tag].png
// and a JSON line per view on stdout with frame ms, GPU ms and any page errors.
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { VIEWPOINTS } from "../src/world/layout"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return undefined
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}
const tag = flag("tag")
const extra = flag("q") ?? ""
const [w, h] = (flag("size") ?? "1536x1024").split("x").map(Number) as [number, number]
const frames = Number(flag("frames") ?? 90)
const outDir = flag("out") ?? `${import.meta.dir}/../captures`
const views = args.length ? args : Object.keys(VIEWPOINTS)
const port = 5196
const base = `http://localhost:${port}/`

const up = () =>
  fetch(base)
    .then((r) => r.ok)
    .catch(() => false)
if (!(await up())) {
  Bun.spawn(["bun", "run", "dev"], { cwd: `${import.meta.dir}/..`, stdout: "ignore", stderr: "ignore" })
  for (let i = 0; i < 60 && !(await up()); i++) await Bun.sleep(250)
}

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
  args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist", "--enable-features=Vulkan"],
})
mkdirSync(outDir, { recursive: true })

for (const view of views) {
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
  const started = performance.now()
  await page.goto(`${base}?shot=1&perf=1&view=${view}${extra ? `&${extra}` : ""}`)
  const result = await page
    .waitForFunction(
      (n) => {
        const s = (globalThis as { __ashwood?: { frames: number; errors: string[]; frameMs: number[]; gpuMs: number | null } }).__ashwood
        return s && (s.frames >= n || s.errors.length > 0) ? s : null
      },
      frames,
      { timeout: 120_000 },
    )
    .then((handle) => handle.jsonValue() as Promise<{ frameMs: number[]; gpuMs: number | null; errors: string[] }>)
    .catch((e: Error) => ({ frameMs: [], gpuMs: null, errors: [e.message] }))
  const file = `${outDir}/${view}${tag ? `-${tag}` : ""}.png`
  await page.screenshot({ path: file })
  const ms = [...result.frameMs.slice(-60)].sort((a, b) => a - b)
  console.log(
    JSON.stringify({
      view,
      file,
      loadS: +((performance.now() - started) / 1000).toFixed(1),
      frameMedianMs: ms.length ? +ms[ms.length >> 1]!.toFixed(2) : null,
      gpuMs: result.gpuMs === null ? null : +result.gpuMs.toFixed(2),
      errors: [...result.errors, ...errors].slice(0, 8),
    }),
  )
  await page.close()
}
await browser.close()
process.exit(0)
