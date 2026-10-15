// Headless proof for a page-demo Lab station (one that embeds a game page): opens /arcade/lab/?station=<id> through the
// dev router, waits for the page's dev-control runtime, picks every variant through the workspace (station.variant),
// and records the toast, the page's body data attributes and any `--read` Lab settings after each, with a frame per
// variant. The page runtime only exists under the dev router, so --serve starts it in the same job:
//   hivemind run --kind browser --fetch captures/lab-station -- bun games/lab/scripts/prove-page-station.ts outbreak-hud --serve --read hudStyle
//   bun games/lab/scripts/prove-page-station.ts <id> --base http://127.0.0.1:5180      uses a running dev router
//   --only a,b proves just those variants; --wait <ms> holds each before its frame (default 2200) to see it play out.
// No visible window, no audio.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import type { LabStation } from "@arcade/kit/lab/stations/types"

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const id = process.argv[2]
assert(id && !id.startsWith("--"), "usage: prove-page-station.ts <station-id> [--serve | --base url] [--read key,key]")
const root = resolve(import.meta.dir, "../../..")
const station = (await import(resolve(import.meta.dir, `../src/stations/${id}.ts`))).default as LabStation
assert(station.demo.kind === "page", "this proof is for page demos; use prove-station.ts for section demos")
const reads = (arg("--read") ?? "").split(",").filter(Boolean)
const only = (arg("--only") ?? "").split(",").filter(Boolean)
const wait = Number(arg("--wait") ?? 2200)
const out = resolve(root, arg("--out") ?? `captures/lab-station/${id}`)
mkdirSync(out, { recursive: true })

let base = arg("--base") ?? "http://127.0.0.1:5180"
const port = String(5300 + Math.floor(Math.random() * 500))
const server = process.argv.includes("--serve")
  ? spawn("bun", ["scripts/dev.ts"], { cwd: root, env: { ...process.env, PORT: port, ARCADE_NO_GLOBAL_STATE: "1" }, stdio: ["ignore", "pipe", "inherit"] })
  : null
if (server) {
  base = `http://127.0.0.1:${port}`
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error("dev server did not start in 60 s")), 60_000)
    server.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("Arcade dev:")) {
        clearTimeout(timer)
        done()
      }
    })
  })
}

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
assert(executablePath, "Playwright Chromium binary required")
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

type Frame = { body: Record<string, string>; reads: Record<string, unknown>; toast: { text: string; error: boolean } | null }
const errors: string[] = []
const report: { station: string; base: string; opened?: unknown; variants: ({ id: string } & Frame)[] } = { station: id, base, variants: [] }
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon|status of (404|503)/.test(m.text())) errors.push(m.text())
  })
  await page.goto(`${base}/arcade/lab/?station=${id}`)
  await page.waitForFunction((id) => (window as any).stations?.snapshot().station?.id === id, id, { timeout: 120_000 })
  // The embedded page and its dev-control runtime.
  await page.waitForFunction(
    () => {
      const f = document.querySelector<HTMLIFrameElement>("[data-station-page] iframe")
      return Boolean((f?.contentWindow as any)?.__arcadeDevControl?.invokeLocal && f!.contentDocument?.readyState === "complete")
    },
    undefined,
    { timeout: 120_000 },
  )
  report.opened = await page.evaluate(() => (window as any).stations.snapshot())

  const state = (reads: string[]) =>
    page.evaluate(async (reads) => {
      const f = document.querySelector<HTMLIFrameElement>("[data-station-page] iframe")!
      const rt = (f.contentWindow as any).__arcadeDevControl
      const values: Record<string, unknown> = {}
      for (const key of reads) {
        const r = await rt.invokeLocal("lab.get", { path: key })
        values[key] = r.result?.value ?? r.value?.value ?? r.error ?? null
      }
      const toast = document.querySelector<HTMLElement>(".ls-toast")
      return {
        body: { ...f.contentDocument!.body.dataset } as Record<string, string>,
        reads: values,
        toast: toast && !toast.hidden ? { text: toast.textContent ?? "", error: toast.dataset.error === "true" } : null,
      }
    }, reads)

  for (const v of (station.variants ?? []).filter((v) => !only.length || only.includes(v.id))) {
    const res = await page.evaluate((v) => (window as any).labWorkbench.invoke("station.variant", { id: v }), v.id)
    assert(res.ok, `station.variant ${v.id}: ${res.error ?? "failed"}`)
    // Setup runs inside the page after a short settle; give it time, then read what it changed.
    await page.waitForTimeout(wait)
    const s = await state(reads)
    assert(!s.toast?.error, `${v.id}: ${s.toast?.text}`)
    report.variants.push({ id: v.id, ...s })
    await page.screenshot({ path: resolve(out, `${v.id}.png`) })
  }
  assert.deepEqual(errors, [])
  writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report.variants.map((v) => ({ id: v.id, ...v.reads, chrome: v.body.chrome, vitals: v.body.vitals }))))
  console.log(`${report.variants.length} variants proved; frames in ${out}`)
} finally {
  await browser.close()
  server?.kill()
}
