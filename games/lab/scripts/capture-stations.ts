// One still per Lab station in a single headless run, for judging how every lab looks today. Opens each station
// through the dev router (`bun run dev`), waits for it to settle, and writes `<order>-<id>.png` plus `stations.json`
// (section, variant, load time and any page errors per station).
//   hivemind run --kind browser --fetch captures/lab-station-stills -- bun games/lab/scripts/capture-stations.ts --serve
//   bun games/lab/scripts/capture-stations.ts --base http://127.0.0.1:5180 --only look-and-world --variants
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"

await using budget = browserBudget()
const { chromium } = budget

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
const root = resolve(import.meta.dir, "../../..")
let base = arg("--base") ?? "http://127.0.0.1:5180"
const only = arg("--only")?.split(",").filter(Boolean)
const withVariants = process.argv.includes("--variants")
const port = arg("--port") ?? String(5300 + Math.floor(Math.random() * 500))
const server = process.argv.includes("--serve")
  ? spawn("bun", ["scripts/dev.ts"], { cwd: root, env: { ...process.env, PORT: port, ARCADE_NO_GLOBAL_STATE: "1" }, stdio: ["ignore", "pipe", "inherit"] })
  : null
if (server) {
  base = `http://127.0.0.1:${port}`
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error("dev server did not start in 60 s")), 60_000)
    server.stdout!.on("data", (chunk: Buffer) => { if (chunk.toString().includes("Arcade dev:")) { clearTimeout(timer); done() } })
  })
}
const out = resolve(root, arg("--out") ?? "captures/lab-station-stills")
mkdirSync(out, { recursive: true })

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(executablePath, "Playwright Chromium binary required")

type Snapshot = { station: { id: string } | null; variant: { id: string } | null; section: string | null }
type W = {
  stations: { snapshot(): Snapshot; open(id: string): Promise<boolean> }
  labWorkbench: { invoke(id: string, args?: Record<string, unknown>): { ok: boolean; result?: unknown } }
  labs: { home: { hide(): void } }
}
type Row = { id: string; title: string; status: string; kind: string; section: string | null; variant: string | null; ms: number; errors: string[]; file: string }

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})
const rows: Row[] = []
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  let errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error" && !/favicon|status of (404|503)/.test(m.text())) errors.push(m.text().slice(0, 300)) })
  await page.goto(`${base}/arcade/lab/`)
  await page.waitForFunction(() => Boolean((window as unknown as W).stations), undefined, { timeout: 120000 })
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("arcade.lab.")) localStorage.removeItem(k) })
  await page.evaluate(() => (window as unknown as W).labs.home.hide())
  const list = await page.evaluate(() => {
    const res = (window as unknown as W).labWorkbench.invoke("station.list") as { ok: boolean; result?: { stations: { id: string; title: string; status: string }[] } }
    return res.ok ? res.result!.stations.map(s => ({ id: s.id, title: s.title, status: s.status })) : []
  })
  assert(list.length > 0, "station.list returned nothing")
  for (const s of list) {
    if (only && !only.includes(s.id)) continue
    errors = []
    const start = Date.now()
    let opened = false
    try {
      opened = await page.evaluate(id => (window as unknown as W).stations.open(id), s.id)
    } catch (e) {
      errors.push(`open: ${(e as Error).message.slice(0, 200)}`)
    }
    // Page labs load a whole game in a frame; section labs bake or warm up their first frames.
    const kind = await page.evaluate(() => (document.querySelector("iframe") ? "page" : "section"))
    await page.waitForTimeout(kind === "page" ? 9000 : 3500)
    const snap = await page.evaluate(() => (window as unknown as W).stations.snapshot()).catch(() => null)
    const file = `${String(rows.length + 1).padStart(2, "0")}-${s.id}.png`
    await page.screenshot({ path: resolve(out, file) })
    rows.push({ ...s, kind, section: snap?.section ?? null, variant: snap?.variant?.id ?? null, ms: Date.now() - start, errors: opened ? errors : ["did not open", ...errors], file })
    console.log(`${s.id}: ${opened ? "ok" : "FAILED"} ${errors.length ? `(${errors.length} errors)` : ""}`)
    if (!withVariants || !opened) continue
    const variants = await page.evaluate(() => {
      const st = (window as unknown as W).stations.snapshot().station as { variants?: { id: string }[] } | null
      return (st?.variants ?? []).map(v => v.id)
    })
    for (const v of variants) {
      errors = []
      await page.evaluate(id => (window as unknown as W).labWorkbench.invoke("station.variant", { id }), v)
      await page.waitForTimeout(kind === "page" ? 4000 : 2200)
      const vfile = `${String(rows.length + 1).padStart(2, "0")}-${s.id}--${v}.png`
      await page.screenshot({ path: resolve(out, vfile) })
      rows.push({ ...s, kind, section: null, variant: v, ms: 0, errors, file: vfile })
    }
  }
} finally {
  writeFileSync(resolve(out, "stations.json"), JSON.stringify({ base, stations: rows }, null, 2))
  await browser.close()
  server?.kill()
}
