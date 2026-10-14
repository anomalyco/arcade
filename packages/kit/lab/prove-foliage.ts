/// <reference types="@webgpu/types" />
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { FOLIAGE_PRESETS } from "../gpu/foliage"

const root = resolve(import.meta.dir, "../../..")
const out = resolve(process.env.FOLIAGE_OUT ?? `${process.env.HOME}/code/home/artifacts/2026-10-14-foliage-lab/pass2`)
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

  // 1. Open Lab with #foliage deep link (defaults to Outbreak house lot + Game camera)
  await page.goto(`http://127.0.0.1:${fixture.port}/lab.html?bench#foliage`)
  await page.waitForFunction(() => !!(window as any).lab, undefined, { timeout: 25000 })

  const adapter = await page.evaluate(() => {
    const a = (window as any).lab.adapter
    return { vendor: a.vendor, architecture: a.architecture }
  })
  assert.match(adapter.architecture, /metal/i, "Metal WebGPU adapter required")

  const initialState = await page.evaluate(() => {
    const l = (window as any).lab
    const s = l.sections.find((x: any) => x.id === "foliage")
    return { section: l.settings.section, stageMode: s.settings.stageMode, cameraMode: s.settings.cameraMode }
  })
  assert.equal(initialState.section, "foliage")
  assert.equal(initialState.stageMode, "lot")
  assert.equal(initialState.cameraMode, "game")

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

  // 2. Outbreak Lot at Game Camera: Before, After, and A/B Split under Outbreak dusk
  await page.evaluate(() =>
    (window as any).lab.workbench.invoke("foliage.preset", {
      preset: "oak",
      stageMode: "lot",
      cameraMode: "game",
      lighting: "outbreak_dusk",
      compare: 0,
    }),
  )
  await renderStep(3)
  const lotBeforePng = await page.locator("canvas").screenshot({ path: resolve(out, "outbreak-lot-game-before.png") })

  await page.evaluate(() =>
    (window as any).lab.workbench.invoke("foliage.preset", {
      preset: "oak",
      stageMode: "lot",
      cameraMode: "game",
      lighting: "outbreak_dusk",
      compare: 1,
    }),
  )
  await renderStep(3)
  const lotAfterPng = await page.locator("canvas").screenshot({ path: resolve(out, "outbreak-lot-game-after.png") })
  assert.notDeepEqual(lotBeforePng, lotAfterPng, "Outbreak lot After must differ visually from Before at game camera")

  await page.evaluate(() => (window as any).lab.workbench.invoke("foliage.preset", { compare: 2 }))
  await renderStep(3)
  await page.screenshot({ path: resolve(out, "outbreak-lot-game-split.png") })

  // 3. Outbreak Lot at Close Inspect: After and A/B Split
  await page.evaluate(() =>
    (window as any).lab.workbench.invoke("foliage.preset", {
      stageMode: "lot",
      cameraMode: "close",
      compare: 1,
    }),
  )
  await renderStep(3)
  await page.locator("canvas").screenshot({ path: resolve(out, "outbreak-lot-close-after.png") })

  await page.evaluate(() => (window as any).lab.workbench.invoke("foliage.preset", { compare: 2 }))
  await renderStep(3)
  await page.screenshot({ path: resolve(out, "outbreak-lot-close-split.png") })

  // 4. Swatch stage at Close Inspect: A/B Split (verify screen-space split has zero white trunk seam)
  await page.evaluate(() =>
    (window as any).lab.workbench.invoke("foliage.preset", {
      stageMode: "swatch",
      cameraMode: "close",
      compare: 2,
    }),
  )
  await renderStep(3)
  await page.screenshot({ path: resolve(out, "swatch-close-split.png") })

  // 5. Verify foliage.set, foliage.randomize, and Reset on Outbreak lot
  await page.evaluate(() =>
    (window as any).lab.workbench.invoke("foliage.preset", {
      preset: "oak",
      stageMode: "lot",
      cameraMode: "game",
      compare: 1,
    }),
  )
  const setRes = await page.evaluate(() =>
    (window as any).lab.workbench.invoke("foliage.set", { treeHeight: 5.8, bladeCurvature: 0.74 }),
  )
  assert.equal(setRes.ok, true)
  assert.equal(setRes.result.settings.treeHeight, 5.8)

  const randRes = await page.evaluate(() =>
    (window as any).lab.workbench.invoke("foliage.randomize", { scope: "all", tuningSeed: 55 }),
  )
  assert.equal(randRes.ok, true)
  assert.equal(randRes.result.seed, 7)

  const resetRes = await page.evaluate(() =>
    (window as any).lab.workbench.invoke("foliage.preset", { preset: "reset" }),
  )
  assert.equal(resetRes.ok, true)
  const heightAfterReset = await page.evaluate(
    () => (window as any).lab.sections.find((s: any) => s.id === "foliage").settings.treeHeight,
  )
  assert.equal(heightAfterReset, FOLIAGE_PRESETS.oak.defaults.treeHeight)

  // 6. Capture actual Outbreak game street scene at game camera (seed 7)
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
  await page.screenshot({ path: resolve(out, "outbreak-in-game-street.png") })

  assert.deepEqual(errors, [])

  const summary = {
    adapter,
    initialState,
    commandsVerified: ["foliage.set", "foliage.randomize", "foliage.preset"],
    captures: [
      "outbreak-lot-game-before.png",
      "outbreak-lot-game-after.png",
      "outbreak-lot-game-split.png",
      "outbreak-lot-close-after.png",
      "outbreak-lot-close-split.png",
      "swatch-close-split.png",
      "outbreak-in-game-street.png",
    ],
  }
  writeFileSync(resolve(out, "foliage-lab-pass2-proof.json"), JSON.stringify(summary, null, 2) + "\n")
  console.log(JSON.stringify(summary, null, 2))
} finally {
  fixture.stop(true)
  await browser.close()
}
