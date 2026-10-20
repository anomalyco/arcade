/**
 * Contact sheet for Characters (AR-88): every calling in a line-up (who they were, then Today's look), each habit
 * loop at two moments, and the empty lead. Staged through the harness (`stageCharacters`) on a local build, seed 7,
 * no wandering dead. The torch comes on for the last two frames only (a beam wakes a staged zombie, as it would any). Headless Metal Chromium, muted, no visible window. Run through `hivemind run --kind browser`.
 *
 *   bun run build && bun scripts/characters-sheet.ts [--out <dir>]
 *
 * Writes one PNG per shot, `meta.json`, and `sheet.png` (labelled montage, needs ImageMagick's `montage`).
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright-core"

const game = resolve(import.meta.dir, "..")
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const out = resolve(arg("out", resolve(game, "../../captures/characters"))!)
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const root = resolve(game, "dist/arcade/outbreak")
assert(existsSync(resolve(root, "index.html")), "run bun run build first")
const fixture = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname.replace(/^\/arcade\/outbreak/, "")
    const file = Bun.file(resolve(root, `.${path === "/" || path === "" ? "/index.html" : path}`))
    return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 })
  },
})
const base = `http://127.0.0.1:${fixture.port}/arcade/outbreak/`

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
assert(chrome)
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

type Shot = { name: string; label: string; scene: string; style: 0 | 1; hour: number; zoom: number; seconds: number }
const HUD = "#status, #hotbar, #stamina, #battery, .callouts, .callout, #hud, .hud, #markers, #prompt"

const shots: Shot[] = [
  { name: "01-callings", label: "Who they were: every calling", scene: "callings", style: 1, hour: 13, zoom: 13, seconds: 0.5 },
  { name: "02-callings-today", label: "Today: same line-up", scene: "callings", style: 0, hour: 13, zoom: 13, seconds: 0.5 },
  { name: "03-knock-a", label: "Knocking to be let in", scene: "knock", style: 1, hour: 13, zoom: 9, seconds: 0.7 },
  { name: "04-knock-b", label: "…and again", scene: "knock", style: 1, hour: 13, zoom: 9, seconds: 2.0 },
  { name: "05-stove-a", label: "Still cooking (behind its south wall from this camera)", scene: "stove", style: 1, hour: 13, zoom: 9, seconds: 0.8 },
  { name: "07-bed-a", label: "Standing over the bed", scene: "bed", style: 1, hour: 13, zoom: 9, seconds: 0.8 },
  { name: "08-bed-b", label: "Swaying", scene: "bed", style: 1, hour: 13, zoom: 9, seconds: 2.4 },
  { name: "09-fence-a", label: "Caught on a garden fence", scene: "fence", style: 1, hour: 13, zoom: 9, seconds: 0.8 },
  { name: "10-fence-b", label: "Pulling at it", scene: "fence", style: 1, hour: 13, zoom: 9, seconds: 2.2 },
  { name: "11-wedding", label: "Still dancing at the church", scene: "wedding", style: 1, hour: 13, zoom: 9, seconds: 1.2 },
  { name: "12-leash", label: "Out for a walk, empty lead", scene: "leash", style: 1, hour: 13, zoom: 8, seconds: 1.0 },
]

const errors: string[] = []
const meta: Record<string, unknown> = { base, viewport: [1280, 800], dpr: 1 }

async function still(page: Page, shot: Shot) {
  const info = await page.evaluate(async (shot) => {
    const h = (window as any).__arcadeHarness
    h.reset(7)
    h.setQuality("high")
    h.setLab("chStyle", shot.style)
    h.setLab("hour", shot.hour)
    h.setLab("timeScale", 0)
    h.setZoomRaw(shot.zoom)
    // Line-ups: in the street south of Ash's house, with a wide enough vision cone that nobody in the row is a ghost.
    h.setLab("cone", shot.scene === "callings" ? 180 : 110)
    // Part the canopy round the survivor wide enough that a yard tree does not hide the fence.
    h.setLab("vegCanopyOpen", 4)
    if (shot.scene === "callings" || shot.scene === "leash") h.pose(27.7, 49, -Math.PI / 2)
    // Stream the chunks round the start in first, so staging can choose among their sites.
    for (let i = 0; i < 90; i++) await h.step(1 / 60, { mx: 0, my: 0, aim: h.state().player.aim })
    const staged = h.stageCharacters(shot.scene)
    if ("error" in staged) return { staged }
    h.setLab("hour", shot.hour)
    const p = h.state().player
    p.flashlightOn = false
    const aim = p.aim
    const t0 = performance.now()
    // Let streamed chunks and interiors settle (the church is far from the start), then play the habit for a moment.
    while (performance.now() - t0 < 12000) {
      await h.step(1 / 60, { mx: 0, my: 0, aim })
      if (h.interiors?.()?.settled && performance.now() - t0 > 600) break
      await new Promise((r) => setTimeout(r, 20))
    }
    // Habits keep the survivor where staging put them (out of reach); line-ups get them a few steps back so the
    // follow camera centres on the row.
    let look = aim
    if (shot.scene === "callings" || shot.scene === "leash") {
      // Just behind the row (it faces south, toward the camera), so the follow camera centres on it.
      h.pose(staged.focus.x, staged.focus.y - 1.4, Math.PI / 2)
      look = Math.PI / 2
      const r = h.state().player
      r.flashlightOn = false
    }
    for (let i = 0; i < Math.round(shot.seconds * 60) + 45; i++) await h.step(1 / 60, { mx: 0, my: 0, aim: look })
    // The torch only for the last two frames: the dead take about half a second to notice a beam on them.
    const t = h.state().player
    t.flashlightOn = true
    t.flashlightOutput = 1
    for (let i = 0; i < 2; i++) await h.step(1 / 60, { mx: 0, my: 0, aim: look })
    const s = h.state()
    const live = Object.keys(s.characters?.habits ?? {}).map(Number)
    return { staged, inHabit: staged.ids.filter((id: number) => live.includes(id)).length, characters: s.characters, hour: s.hour, player: { x: s.player.x, y: s.player.y, aim: s.player.aim } }
  }, shot)
  await page.evaluate((sel) => {
    for (const el of document.querySelectorAll<HTMLElement>(sel)) el.style.visibility = "hidden"
  }, HUD)
  await page.screenshot({ path: resolve(out, `${shot.name}.png`) })
  meta[shot.name] = { ...shot, ...info }
  console.log(shot.name, JSON.stringify(info.staged), "in habit:", (info as { inHabit?: number }).inHabit)
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text())
  })
  await page.goto(`${base}?solo&seed=7&bench&peaceful=1`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 60000 })
  meta.adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  for (const shot of shots) {
    // A busy worker's GPU can stall a step for good; give each shot a minute, then reload and try it once more.
    const attempt = () => Promise.race([still(page, shot), new Promise<never>((_, no) => setTimeout(() => no(new Error(`${shot.name} timed out`)), 60000))])
    try {
      await attempt()
    } catch (e) {
      errors.push(String(e))
      await page.reload()
      await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 60000 })
      await attempt()
    }
  }
  meta.errors = errors
} finally {
  writeFileSync(resolve(out, "meta.json"), JSON.stringify(meta, null, 2))
  await browser.close()
  fixture.stop(true)
}

const montage = Bun.spawnSync([
  "montage",
  ...shots.flatMap((s) => ["-label", s.label, resolve(out, `${s.name}.png`)]),
  "-tile", "3x",
  "-geometry", "640x400+6+6",
  "-background", "#111",
  "-fill", "#ddd",
  "-pointsize", "18",
  resolve(out, "sheet.png"),
])
if (montage.exitCode !== 0) console.error("montage failed:", montage.stderr.toString())
if (errors.length) console.error(errors.slice(0, 10).join("\n"))
console.log(out)
