/**
 * Contact sheet of every staged secret (AR-85): one still per `SECRET_SCENES` entry on seed 7, staged through the
 * harness `stageSecret`, and `sheet.png` laying them out in a labelled grid.
 *
 *   bun scripts/secrets-sheet.ts [--skip-build] [--viewport 960x640] [--out captures/secrets]
 *
 * Writes one PNG per scene, `sheet.png` and `report.json` (staged position, what the presenter showed, errors).
 * Headless Metal Chromium, muted, no visible window: run it through `hivemind run --kind browser`.
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"
import { SECRET_SCENES } from "../src/secrets/stage"

await using budget = browserBudget()
const { chromium } = budget

const game = resolve(import.meta.dir, "..")
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const out = resolve(game, "../..", arg("out", "captures/secrets")!)
const [vw, vh] = arg("viewport", "960x640")!.split("x").map(Number) as [number, number]
mkdirSync(out, { recursive: true })
if (!process.argv.includes("--skip-build")) assert.equal(Bun.spawnSync(["bun", "run", "build"], { cwd: game, stdout: "inherit", stderr: "inherit" }).exitCode, 0)
const root = resolve(game, "dist/arcade/outbreak")
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  const file = Bun.file(resolve(root, `.${path === "/" ? "/index.html" : path}`))
  return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 })
} })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse().map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(chrome, "Install Chromium first")

const LABEL: Record<(typeof SECRET_SCENES)[number], string> = {
  calendar: "Subtle · calendars",
  clock: "Subtle · clocks",
  photo: "Subtle · photos",
  chalk: "Subtle · chalk",
  "chalk-late": "Subtle · chalk, later",
  nod: "Subtle · moving box",
  tallMan: "Strange · edge of the light",
  audience: "Strange · the chairs",
  litWindow: "Strange · lit window",
  footprints: "Strange · footprints",
  phone: "Strange · wall phone",
  rockingChair: "Strange · porch rocker",
  cellar: "Hidden · the hatch",
  "cellar-open": "Hidden · the hatch, open",
  procession: "Event · down the road",
  visitor: "Event · at the door",
  tally: "Cards · the tally",
}
// Night scenes are lit only by lamps and windows; the still keeps the play look there.
const NIGHT = new Set(["tallMan", "litWindow", "rockingChair", "phone", "procession", "visitor"])
// Close on the indoor pieces; wider for what stands in a yard or down a street.
const ZOOM: Partial<Record<string, number>> = { chalk: 32, "chalk-late": 32, rockingChair: 32, footprints: 30, audience: 28, tallMan: 44, litWindow: 44, procession: 46, visitor: 30, tally: 30 }
const HUD = "#status, #hotbar, #stamina, #battery, #prompt, .callouts, .callout, #hud, #sound-cues"
const report: Record<string, unknown> = { viewport: [vw, vh], shots: {} as Record<string, unknown> }
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const shots: string[] = []
try {
  const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  for (const scene of SECRET_SCENES) {
    // A fresh page per scene: the tally's death and the forced apparitions never leak into the next still.
    await page.goto(`http://127.0.0.1:${fixture.port}/?solo&seed=7&bench&peaceful=1`)
    await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
    await page.evaluate(() => localStorage.removeItem("arcade.outbreak.secrets"))
    if (scene !== "tally") await page.evaluate(sel => { for (const el of document.querySelectorAll<HTMLElement>(sel)) el.style.visibility = "hidden" }, HUD)
    const s = await page.evaluate(async a => {
      try {
        const h = (window as any).__arcadeHarness
        h.freeze(true)
        h.setLab("timeScale", 0)
        if (!a.night) {
          h.setLab("cone", 180)
          h.setLab("range", 30)
        }
          h.setLab("zoom", a.zoom)
        const at = h.stageSecret(a.scene)
        const t0 = performance.now()
        for (let i = 0; performance.now() - t0 < 12000; i++) {
          if (a.scene !== "tally") h.session().ai.agents.length = 0
          await h.step()
          if (i > 90 && h.state().world.pendingBakes === 0) break
          await new Promise(r => setTimeout(r, 10))
        }
        const st = h.state()
        return { at, picked: st.secrets?.picked, shown: st.secrets?.shown, glance: st.secrets?.glance, tally: st.secrets?.tally }
      } catch (e) {
        return { error: String(e) }
      }
    }, { scene, night: NIGHT.has(scene), zoom: ZOOM[scene] ?? 24 })
    const file = resolve(out, `${String(shots.length + 1).padStart(2, "0")}-${scene}.png`)
    await page.waitForTimeout(80)
    await page.screenshot({ path: file, timeout: 90_000 })
    shots.push(file)
    ;(report.shots as Record<string, unknown>)[scene] = s
    console.log(scene, JSON.stringify(s))
  }
  report.errors = errors

  const cells = shots.map((f, i) => `<figure><img src="data:image/png;base64,${readFileSync(f).toString("base64")}"><figcaption>${i + 1}. ${LABEL[SECRET_SCENES[i]!]}</figcaption></figure>`).join("")
  const cols = 4
  const cw = 480
  const ch = Math.round(cw * vh / vw)
  const sheet = await browser.newPage({ viewport: { width: cols * (cw + 12) + 12, height: 400 }, deviceScaleFactor: 1 })
  await sheet.setContent(`<style>body{margin:0;padding:12px;background:#0d0f0e;font:13px ui-monospace,monospace;color:#c9cfc6;display:grid;grid-template-columns:repeat(${cols},${cw}px);gap:12px}figure{margin:0}img{width:${cw}px;height:${ch}px;display:block;border-radius:3px}figcaption{padding:5px 2px 0}</style>${cells}`)
  await sheet.screenshot({ path: resolve(out, "sheet.png"), fullPage: true })
} finally {
  writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2))
  await browser.close()
  fixture.stop()
}
console.log(out)
