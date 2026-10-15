// Noir look proof: captures the default (Noir) look in street and interior scenes plus flashlight profile probes,
// and records the screen position of world points along and across the beam so noir-profile.py can plot the pool's
// radial and angular luminance and the saturation across its edge. Headless Metal Chromium, no audio.
//   NOIR_PHASE=before|after  NOIR_LAB='{"flashlightRange":14}'  NOIR_DIAGS=7,8  NOIR_SKIP_BUILD=1
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"

const game = resolve(import.meta.dir, "..")
const phase = process.env.NOIR_PHASE ?? "after"
const labOverrides: Record<string, number> = JSON.parse(process.env.NOIR_LAB ?? "{}")
// Extra captures with the Lab's Contribution diagnostic, e.g. NOIR_DIAGS=7,8 (colour mask, visibility field).
const diags = (process.env.NOIR_DIAGS ?? "").split(",").filter(Boolean).map(Number)
// Optional look preset to capture instead of the default (Noir), e.g. NOIR_LOOK=current.
const look = process.env.NOIR_LOOK ?? ""
const out = resolve(game, "../../captures/outbreak-noir", phase)
mkdirSync(out, { recursive: true })
if (process.env.NOIR_SKIP_BUILD !== "1") assert.equal(Bun.spawnSync(["bun", "run", "build"], { cwd: game, stdout: "inherit", stderr: "inherit" }).exitCode, 0)
const root = resolve(game, "dist/arcade/outbreak")
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  const file = Bun.file(resolve(root, `.${path === "/" ? "/index.html" : path}`))
  return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 })
} })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter(n => /^chromium-\d+$/.test(n)).sort().reverse().map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
assert(chrome)

type Scene = { name: string; x: number; y: number; aim: number; hour: number; zoom: number; open?: boolean; zombies?: [number, number][] }
const scenes: Scene[] = [
  { name: "street", x: 30, y: 41, aim: -Math.PI / 2, hour: 18, zoom: 42, zombies: [[27.5, 37.6], [32.6, 37.4]] },
  { name: "street-long", x: 20, y: 44, aim: 0.12, hour: 22, zoom: 42 },
  { name: "interior", x: 27.7, y: 31, aim: -Math.PI / 2, hour: 19, zoom: 34, open: true },
  { name: "interior-wall", x: 27.7, y: 31, aim: Math.PI, hour: 19, zoom: 34, open: true },
  { name: "yard", x: 20, y: 35, aim: -1.6, hour: 23, zoom: 42 },
]

const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 680 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${fixture.port}/?solo&seed=7&bench`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
  const adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  assert.match(adapter.architecture, /metal/)
  const probes: Record<string, unknown> = {}
  for (const scene of scenes) {
    const probe = await page.evaluate(async ({ s, labOverrides, look }) => {
      const h = (window as any).__arcadeHarness
      h.reset(7)
      if (look) h.setLookPreset(look)
      h.setLab("timeScale", 0); h.setLab("hour", s.hour); h.setLab("zoom", s.zoom)
      h.setLab("zombieCount", 0)
      for (const [key, value] of Object.entries(labOverrides)) h.setLab(key, value)
      for (const [x, y, a] of [[30, 41, -1.57], [20, 35, -1.57], [20, 26, 0], [30, 21, 1.57], [38, 32, 3.14]]) {
        h.pose(x, y, a); await h.step()
      }
      h.pose(s.x, s.y, s.aim)
      if (s.open) await h.step(1 / 60, { interact: true })
      for (const [zx, zy] of s.zombies ?? []) h.spawnZombie(zx, zy, "wander", Math.PI / 2)
      for (let i = 0; i < 24; i++) await h.step()
      const st = h.state()
      const px = st.player.x, py = st.player.y, aim = st.player.aim
      const project = (wx: number, wz: number) => {
        const r = h.resolveTargetRect({ world: [wx, 0.02, wz] })
        return r ? [r.x + 42, r.y + 42] : null
      }
      const axial: [number, number, number | null][] = []
      for (let d = 0.25; d <= 18; d += 0.25) {
        const p = project(px + Math.cos(aim) * d, py + Math.sin(aim) * d)
        axial.push([d, p ? p[0] : -1, p ? p[1] : null])
      }
      const angular: Record<string, [number, number, number | null][]> = {}
      for (const ring of [3, 5, 8]) {
        const row: [number, number, number | null][] = []
        for (let deg = -75; deg <= 75; deg += 1.5) {
          const a = aim + (deg * Math.PI) / 180
          const p = project(px + Math.cos(a) * ring, py + Math.sin(a) * ring)
          row.push([deg, p ? p[0] : -1, p ? p[1] : null])
        }
        angular[String(ring)] = row
      }
      return { player: [px, py, aim], axial, angular }
    }, { s: scene, labOverrides, look })
    probes[scene.name] = probe
    await page.evaluate(() => {
      for (const el of document.querySelectorAll<HTMLElement>("#status, #hotbar, #stamina, #battery, #prompt")) el.style.visibility = "hidden"
    })
    await page.locator("#game").screenshot({ path: resolve(out, `${scene.name}.png`) })
    for (const diag of diags) {
      await page.evaluate(async (v) => { const h = (window as any).__arcadeHarness; h.setLab("diagnostic", v); await h.step() }, diag)
      await page.locator("#game").screenshot({ path: resolve(out, `${scene.name}-diag${diag}.png`) })
      await page.evaluate(async () => { const h = (window as any).__arcadeHarness; h.setLab("diagnostic", 0); await h.step() })
    }
    await page.evaluate(() => {
      for (const el of document.querySelectorAll<HTMLElement>("#status, #hotbar, #stamina, #battery, #prompt")) el.style.visibility = ""
    })
  }
  assert.deepEqual(errors, [])
  await Bun.write(resolve(out, "probes.json"), JSON.stringify({ adapter, phase, look, labOverrides, viewport: [1000, 680], scenes, probes }, null, 1))
  console.log(`wrote ${out}`)
} finally { await browser.close(); fixture.stop(true) }
