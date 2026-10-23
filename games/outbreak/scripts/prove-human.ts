// Built-bundle terrain/profile adapter proof. Run through Hivemind after the Outbreak build.
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"

await using budget = browserBudget()
const { chromium } = budget

const root = resolve(import.meta.dir, "../dist/arcade/outbreak")
const out = resolve(import.meta.dir, "../../../captures/shared-human-outbreak")
mkdirSync(out, { recursive: true })
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  const file = Bun.file(resolve(root, `.${path === "/" ? "/index.html" : path}`))
  return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 })
} })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(chrome)
const browser = await chromium.launch({ executablePath: chrome, headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
try {
  const page = await browser.newPage({ viewport: { width: 1080, height: 720 } })
  const errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${fixture.port}/?solo&seed=7&bench&lab=1`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
  const gpu = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  assert.match(gpu.architecture, /metal/)
  const poses = []
  for (const profile of [0, 1]) {
    await page.locator('[data-lab] select[data-key="humanProfile"]').selectOption(String(profile))
    const pose = await page.evaluate(async () => {
      const h = (window as any).__arcadeHarness
      h.setLab("timeScale", 0); h.setLab("hour", 12); h.setLab("zoom", 24)
      h.pose(42, 43, 0)
      for (let n = 0; n < 90; n++) await h.step(1 / 60, { mx: 1, my: 0, aim: 0 })
      return h.human()
    })
    poses.push(pose)
    await page.keyboard.press("Backquote")
    await page.screenshot({ path: resolve(out, profile ? "zombie.png" : "survivor.png") })
    await page.keyboard.press("Backquote")
  }
  assert.equal(poses[1].profile.handPose, "reach")
  assert.notDeepEqual(poses[0].bones.torso, poses[1].bones.torso)
  const drag = page.getByRole("slider", { name: "Foot drag", exact: true })
  await drag.fill("0"); await drag.dispatchEvent("input")
  assert.equal(await page.evaluate(() => (window as any).__arcadeHarness.human().profile.footDrag), 0)
  await page.getByRole("button", { name: "Reset Zombie", exact: true }).click()
  assert.equal(await page.locator('[data-lab] select[data-key="humanProfile"]').inputValue(), "0")
  assert.deepEqual(errors, [])
  writeFileSync(resolve(out, "proof.json"), JSON.stringify({ gpu, poses, errors }, null, 2))
  console.log(JSON.stringify({ gpu, profiles: 2, controls: true, errors }))
} finally { await browser.close(); fixture.stop() }
