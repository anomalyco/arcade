/// <reference types="@webgpu/types" />
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { FOLIAGE_PRESETS } from "../gpu/foliage"

const root = resolve(import.meta.dir, "../../..")
const out = resolve(process.env.FOLIAGE_OUT ?? `${process.env.HOME}/code/home/artifacts/2026-10-14-foliage-lab`)
mkdirSync(out, { recursive: true })

const dir = resolve(root, "games/outbreak")
assert.equal(Bun.spawnSync(["bun", "run", "build"], { cwd: dir, stdout: "inherit", stderr: "inherit" }).exitCode, 0)
const distRoot = resolve(dir, "dist/arcade/outbreak")
const fixture = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const p = new URL(req.url).pathname
    const f = Bun.file(resolve(distRoot, `.${p === "/" ? "/index.html" : p}`))
    return (await f.exists()) ? new Response(f) : new Response("Not found", { status: 404 })
  },
})

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter(n => /^chromium-\d+$/.test(n))
  .sort()
  .reverse()
  .map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)
  .find(existsSync)
assert(executablePath, "Playwright Chromium binary required")

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

const errors: string[] = []
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  page.setDefaultTimeout(15000)
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => {
    if (m.type() === "error") errors.push(m.text())
  })

  // 1. Open Lab with #foliage deep link
  await page.goto(`http://127.0.0.1:${fixture.port}/lab.html?bench#foliage`)
  await page.waitForFunction(() => !!(window as any).lab, undefined, { timeout: 25000 })

  const adapter = await page.evaluate(() => {
    const a = (window as any).lab.adapter
    return { vendor: a.vendor, architecture: a.architecture }
  })
  assert.match(adapter.architecture, /metal/i, "Metal WebGPU adapter required")

  const activeSection = await page.evaluate(() => (window as any).lab.settings.section)
  assert.equal(activeSection, "foliage", "Deep URL #foliage must open Foliage section directly")

  const renderStep = async (n = 3) => {
    for (let i = 0; i < n; i++) {
      await page.evaluate(async () => {
        ;(window as any).lab.advance(1 / 60)
        await (window as any).lab.render()
      })
    }
  }

  await renderStep(4)
  assert.deepEqual(errors, [])

  // 2. Capture Before, After, and A/B Split in Close Inspect under Outbreak dusk
  await page.evaluate(() => (window as any).lab.workbench.invoke("foliage.preset", { preset: "oak", lighting: "outbreak_dusk", cameraMode: "close", compare: 0 }))
  await renderStep(3)
  const beforePng = await page.locator("canvas").screenshot({ path: resolve(out, "foliage-lab-before-close.png") })

  await page.evaluate(() => (window as any).lab.workbench.invoke("foliage.preset", { preset: "oak", lighting: "outbreak_dusk", cameraMode: "close", compare: 1 }))
  await renderStep(3)
  const afterPng = await page.locator("canvas").screenshot({ path: resolve(out, "foliage-lab-after-close.png") })
  assert.notDeepEqual(beforePng, afterPng, "Improved foliage After must differ visually from shipped Before")

  await page.evaluate(() => (window as any).lab.workbench.invoke("foliage.preset", { compare: 2 }))
  await renderStep(3)
  await page.screenshot({ path: resolve(out, "foliage-lab-split-close.png") })

  // 3. Capture Game Camera (38 m) view
  await page.evaluate(() => (window as any).lab.workbench.invoke("foliage.preset", { cameraMode: "game", compare: 1 }))
  await renderStep(3)
  await page.screenshot({ path: resolve(out, "foliage-lab-game-camera.png") })

  // 4. Capture Autumn Maple under Outbreak Day and Silver Birch under Outbreak Night
  await page.evaluate(() => (window as any).lab.workbench.invoke("foliage.preset", { preset: "maple", lighting: "outbreak_day", cameraMode: "close", compare: 1 }))
  await renderStep(3)
  await page.screenshot({ path: resolve(out, "foliage-lab-maple-day.png") })

  await page.evaluate(() => (window as any).lab.workbench.invoke("foliage.preset", { preset: "birch", lighting: "outbreak_night", cameraMode: "close", compare: 1 }))
  await renderStep(3)
  await page.screenshot({ path: resolve(out, "foliage-lab-birch-night.png") })

  // 5. Verify foliage.set, foliage.randomize, Reset, and Preset JSON round-trip
  await page.evaluate(() => (window as any).lab.workbench.invoke("foliage.preset", { preset: "oak", lighting: "outbreak_dusk", cameraMode: "close", compare: 1 }))
  const setRes = await page.evaluate(() =>
    (window as any).lab.workbench.invoke("foliage.set", { treeHeight: 6.1, bladeCurvature: 0.78 }),
  )
  assert.equal(setRes.ok, true)
  assert.equal(setRes.result.settings.treeHeight, 6.1)
  assert.equal(setRes.result.settings.bladeCurvature, 0.78)

  const randRes = await page.evaluate(() =>
    (window as any).lab.workbench.invoke("foliage.randomize", { scope: "all", tuningSeed: 55 }),
  )
  assert.equal(randRes.ok, true)
  assert.equal(randRes.result.seed, 7, "foliage.randomize must preserve structural seed")
  assert.equal(randRes.result.nextTuningSeed, 56, "foliage.randomize increments tuningSeed")
  await renderStep(3)
  await page.screenshot({ path: resolve(out, "foliage-lab-randomized.png") })

  // Reset to oak defaults
  const resetRes = await page.evaluate(() =>
    (window as any).lab.workbench.invoke("foliage.preset", { preset: "reset" }),
  )
  assert.equal(resetRes.ok, true)
  const heightAfterReset = await page.evaluate(
    () => (window as any).lab.sections.find((s: any) => s.id === "foliage").settings.treeHeight,
  )
  assert.equal(heightAfterReset, FOLIAGE_PRESETS.oak.defaults.treeHeight)

  // Export and import preset JSON
  const presetJson = resetRes.result.json
  const importRes = await page.evaluate(
    (json: string) => (window as any).lab.workbench.invoke("foliage.preset", { json }),
    presetJson,
  )
  assert.equal(importRes.ok, true)

  // 6. Capture actual Outbreak game street scene with improved trees and curved grass blades
  await page.goto(`http://127.0.0.1:${fixture.port}/?seed=7&bench`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, undefined, { timeout: 25000 })
  await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    h.setLab("timeScale", 0)
    h.setLab("hour", 18)
    h.setLab("zoom", 38)
    h.pose(29.5, 40.5, -Math.PI / 2)
    await h.step(1 / 60)
  })
  await page.screenshot({ path: resolve(out, "foliage-outbreak-in-game.png") })

  assert.deepEqual(errors, [])

  const summary = {
    adapter,
    deepUrlVerified: true,
    commandsVerified: ["foliage.set", "foliage.randomize", "foliage.preset"],
    captures: [
      "foliage-lab-before-close.png",
      "foliage-lab-after-close.png",
      "foliage-lab-split-close.png",
      "foliage-lab-game-camera.png",
      "foliage-lab-maple-day.png",
      "foliage-lab-birch-night.png",
      "foliage-lab-randomized.png",
      "foliage-outbreak-in-game.png",
    ],
  }
  writeFileSync(resolve(out, "foliage-lab-proof.json"), JSON.stringify(summary, null, 2) + "\n")
  console.log(JSON.stringify(summary, null, 2))
} finally {
  fixture.stop(true)
  await browser.close()
}
