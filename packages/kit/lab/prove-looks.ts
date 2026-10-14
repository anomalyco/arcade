/// <reference types="@webgpu/types" />
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { LOOK_PRESETS, LOOK_PRESET_IDS } from "../gpu/look"

const root = resolve(import.meta.dir, "../../..")
const out = resolve(process.env.LOOKS_OUT ?? "/Users/kit/code/home/artifacts/2026-10-14-looks")
mkdirSync(out, { recursive: true })

const dir = resolve(root, "games/blackout")
assert.equal(Bun.spawnSync(["bun", "run", "build"], { cwd: dir, stdout: "inherit", stderr: "inherit" }).exitCode, 0)
const distRoot = resolve(dir, "dist/arcade/blackout")
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
  // Viewport <= 1280px so every capture is ready for direct inspection
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  page.setDefaultTimeout(12000)
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => {
    if (m.type() === "error") errors.push(m.text())
  })

  await page.goto(`http://127.0.0.1:${fixture.port}/lab.html?bench`)
  await page.waitForFunction(() => !!(window as any).lab, undefined, { timeout: 25000 })

  const adapter = await page.evaluate(() => {
    const a = (window as any).lab.adapter
    return { vendor: a.vendor, architecture: a.architecture }
  })
  assert.match(adapter.architecture, /metal/i, "Metal WebGPU adapter required")

  const renderStep = async (n = 3) => {
    for (let i = 0; i < n; i++) {
      await page.evaluate(async () => {
        ;(window as any).lab.advance(1 / 60)
        await (window as any).lab.render(true)
      })
    }
  }

  // 1. Open Looks section via Lighting -> Rendering Styles (Looks) in the Workbench Library
  await page.getByRole("button", { name: "Category Lighting", exact: true }).click()
  await page.locator('[data-catalog-id="section:looks"]').click()
  await renderStep(3)

  const initialSection = await page.evaluate(() => (window as any).lab.settings.section)
  assert.equal(initialSection, "looks")
  assert.deepEqual(errors, [])

  // 2. Capture each of the 6 presets in the Debug Room (both full workbench & canvas)
  const presetCaptures: Record<string, { label: string; gpuMs: number | null }> = {}
  for (const id of LOOK_PRESET_IDS) {
    const res = await page.evaluate((pid: string) => (window as any).lab.workbench.invoke("look.preset", { preset: pid }), id)
    assert.equal(res.ok, true, `look.preset(${id}) failed: ${JSON.stringify(res)}`)
    await renderStep(3)
    await page.locator("canvas").screenshot({ path: resolve(out, `room-${id}.png`) })
    if (id === "current" || id === "noir" || id === "painterly") {
      await page.screenshot({ path: resolve(out, `workbench-${id}.png`) })
    }
    const gpuMs = await page.evaluate(() => (window as any).lab.context.stage.gpuMs)
    presetCaptures[id] = { label: LOOK_PRESETS[id].label, gpuMs }
  }

  // 3. Capture A/B wipe vs Current for Noir / Limbo and Painterly
  await page.evaluate(() => {
    ;(window as any).lab.workbench.invoke("look.preset", { preset: "noir" })
    ;(window as any).lab.workbench.invoke("look.set", { key: "compare", value: 2 })
    ;(window as any).lab.workbench.invoke("look.set", { key: "wipeSplit", value: 0.5 })
  })
  await renderStep(3)
  await page.locator("canvas").screenshot({ path: resolve(out, "room-ab-noir-vs-current.png") })
  await page.screenshot({ path: resolve(out, "workbench-ab-noir-vs-current.png") })

  await page.evaluate(() => {
    ;(window as any).lab.workbench.invoke("look.preset", { preset: "painterly" })
    ;(window as any).lab.workbench.invoke("look.set", { key: "compare", value: 2 })
    ;(window as any).lab.workbench.invoke("look.set", { key: "wipeSplit", value: 0.5 })
  })
  await renderStep(3)
  await page.locator("canvas").screenshot({ path: resolve(out, "room-ab-painterly-vs-current.png") })

  // Restore compare = 1 (After)
  await page.evaluate(() => (window as any).lab.workbench.invoke("look.set", { key: "compare", value: 1 }))

  // 4. Verify look.set & look.randomize commands and separate tuningSeed vs roomSeed
  const randRes = await page.evaluate(() =>
    (window as any).lab.workbench.invoke("look.randomize", { group: "Atmosphere & Shafts", seed: 2026 }),
  )
  assert.equal(randRes.ok, true)
  assert.equal(randRes.result.roomSeed, 7, "look.randomize must not alter roomSeed")
  assert.equal(randRes.result.tuningSeed, 2026)

  // 5. Verify preset export & import round-trip
  const exportedJson = await page.evaluate(() => (window as any).lab.looks.exportPresetJson())
  const importedRes = await page.evaluate((raw: string) => (window as any).lab.workbench.importPreset(raw), exportedJson)
  assert.equal(importedRes.ok, true)

  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ adapter, presetCaptures, randRes: randRes.result }, null, 2))
} finally {
  fixture.stop(true)
  await browser.close()
}
