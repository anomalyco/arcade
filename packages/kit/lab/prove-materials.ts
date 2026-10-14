/// <reference types="@webgpu/types" />
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { MATERIAL_RECIPES, MATERIAL_RECIPE_IDS } from "../gpu/surface-materials"

const root = resolve(import.meta.dir, "../../..")
const out = resolve(process.env.MATERIALS_OUT ?? resolve(root, "captures/materials-lab"))
mkdirSync(out, { recursive: true })

const dir = resolve(root, "games/lab")
assert.equal(Bun.spawnSync(["bun", "run", "build"], { cwd: dir, stdout: "inherit", stderr: "inherit" }).exitCode, 0)
const distRoot = resolve(dir, "dist/arcade/lab")
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
  page.setDefaultTimeout(10000)
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => {
    if (m.type() === "error") errors.push(m.text())
  })

  await page.goto(`http://127.0.0.1:${fixture.port}/?bench`)
  await page.waitForFunction(() => !!(window as any).lab, undefined, { timeout: 25000 })

  const adapter = await page.evaluate(() => {
    const a = (window as any).lab.adapter
    return { vendor: a.vendor, architecture: a.architecture }
  })
  assert.match(adapter.architecture, /metal/i, "Metal WebGPU adapter required")

  const renderStep = async (n = 2) => {
    for (let i = 0; i < n; i++) {
      await page.evaluate(async () => {
        ;(window as any).lab.advance(1 / 60)
        await (window as any).lab.render()
      })
    }
  }

  // 1. Open Materials section via the Library drawer's Materials category.
  await page.getByRole("button", { name: "Category Materials", exact: true }).click()
  await page.locator('[data-catalog-id="material-recipe:wood_planks"]').click()
  await renderStep(3)

  const initialSection = await page.evaluate(() => (window as any).lab.settings.section)
  assert.equal(initialSection, "materials")
  assert.deepEqual(errors, [])

  // Verify compact Inspector DOM for active recipe.
  const domAudit = await page.evaluate(() => {
    const sr = document.querySelector("[data-lab]")!.shadowRoot!
    const groups = [...sr.querySelectorAll("[data-controls] h3 .fold")].map(el => el.textContent?.trim())
    const inputs = [...sr.querySelectorAll("[data-controls] [data-key]")].map(el => el.getAttribute("data-key"))
    return { groups, inputCount: inputs.length, inputs }
  })
  assert.deepEqual(domAudit.groups, ["▾ Swatch", "▾ Wood planks", "▸ Game Catalog"])
  assert(domAudit.inputCount <= 28, `Expected compact control set, got ${domAudit.inputCount}`)

  // 2. Apply Outbreak dusk lighting preset and capture Room & walk vignette in A/B split mode.
  await page.getByRole("combobox", { name: "Lighting preset", exact: true }).selectOption("outbreak_dusk")
  await page.getByRole("combobox", { name: "Comparison", exact: true }).selectOption("2")
  await renderStep(3)
  await page.screenshot({ path: resolve(out, "lab-room-split.png") })

  // 3. Switch to Material ball & blocks swatch and capture Before / After / Split for Wood planks and Cobblestone.
  await page.getByRole("combobox", { name: "Swatch geometry", exact: true }).selectOption("ball")
  await page.getByRole("combobox", { name: "Comparison", exact: true }).selectOption("0")
  await renderStep(2)
  const woodBeforePng = await page.locator("canvas").screenshot({ path: resolve(out, "ball-wood-before.png") })

  await page.getByRole("combobox", { name: "Comparison", exact: true }).selectOption("1")
  await renderStep(2)
  const woodAfterPng = await page.locator("canvas").screenshot({ path: resolve(out, "ball-wood-after.png") })
  assert.notDeepEqual(woodBeforePng, woodAfterPng, "Wood planks After must differ visually from shiny Before")

  await page.getByRole("combobox", { name: "Comparison", exact: true }).selectOption("2")
  await renderStep(2)
  await page.screenshot({ path: resolve(out, "lab-ball-wood-split.png") })

  // Cobblestone on Material ball and Surface plane
  await page.locator('[data-catalog-id="material-recipe:cobblestone"]').click()
  await page.getByRole("combobox", { name: "Swatch geometry", exact: true }).selectOption("ball")
  await page.getByRole("combobox", { name: "Comparison", exact: true }).selectOption("2")
  await renderStep(2)
  await page.screenshot({ path: resolve(out, "lab-ball-cobblestone-split.png") })

  await page.getByRole("combobox", { name: "Swatch geometry", exact: true }).selectOption("plane")
  await page.getByRole("combobox", { name: "Comparison", exact: true }).selectOption("2")
  await renderStep(2)
  await page.screenshot({ path: resolve(out, "lab-plane-cobblestone-split.png") })

  // Capture each of the 6 recipes in After mode on the Ball swatch for the catalog strip.
  const recipeCaptures: Record<string, { gpuMs: number | null }> = {}
  await page.getByRole("combobox", { name: "Swatch geometry", exact: true }).selectOption("ball")
  await page.getByRole("combobox", { name: "Comparison", exact: true }).selectOption("1")
  for (const id of MATERIAL_RECIPE_IDS) {
    await page.locator(`[data-catalog-id="material-recipe:${id}"]`).click()
    await page.getByRole("combobox", { name: "Swatch geometry", exact: true }).selectOption("ball")
    await renderStep(3)
    await page.locator("canvas").screenshot({ path: resolve(out, `swatch-${id}.png`) })
    const gpuMs = await page.evaluate(() => (window as any).lab.context.stage.gpuMs)
    recipeCaptures[id] = { gpuMs }
  }

  // 4. Verify seeded Randomize (separate tuningSeed vs structural roomSeed), Reset, and Undo/Redo.
  await page.locator('[data-catalog-id="material-recipe:wood_planks"]').click()
  await renderStep(2)
  const beforeRandom = await page.evaluate(() => {
    const s = (window as any).lab.sections.find((x: any) => x.id === "materials").settings
    return {
      roomSeed: s.roomSeed,
      tuningSeed: s.tuningSeed,
      roughness: s["wood_planks.roughness"],
      scale: s["wood_planks.scale"],
    }
  })
  assert.equal(beforeRandom.roughness, MATERIAL_RECIPES.wood_planks.defaults.roughness)

  await page.getByRole("button", { name: "Randomize Wood planks", exact: true }).click()
  await renderStep(2)
  const afterRandom = await page.evaluate(() => {
    const s = (window as any).lab.sections.find((x: any) => x.id === "materials").settings
    return {
      roomSeed: s.roomSeed,
      tuningSeed: s.tuningSeed,
      roughness: s["wood_planks.roughness"],
      scale: s["wood_planks.scale"],
    }
  })
  assert.equal(afterRandom.roomSeed, beforeRandom.roomSeed, "Recipe randomize must not alter structural roomSeed")
  assert.equal(afterRandom.tuningSeed, beforeRandom.tuningSeed + 1, "Recipe randomize increments tuningSeed")
  assert(
    afterRandom.roughness !== beforeRandom.roughness || afterRandom.scale !== beforeRandom.scale,
    "Recipe randomize updates recipe parameters",
  )

  // Reset Wood planks group to defaults
  await page.getByRole("button", { name: "Reset Wood planks", exact: true }).click()
  await renderStep(2)
  const afterReset = await page.evaluate(
    () => (window as any).lab.sections.find((x: any) => x.id === "materials").settings["wood_planks.roughness"],
  )
  assert.equal(afterReset, MATERIAL_RECIPES.wood_planks.defaults.roughness, "Reset restores default matte roughness")

  // Undo & Redo
  await page.locator("canvas").focus()
  await page.keyboard.press("Meta+z")
  assert.equal(
    await page.evaluate(
      () => (window as any).lab.sections.find((x: any) => x.id === "materials").settings["wood_planks.roughness"],
    ),
    afterRandom.roughness,
    "Undo restores randomized roughness",
  )
  await page.keyboard.press("Meta+Shift+z")
  assert.equal(
    await page.evaluate(
      () => (window as any).lab.sections.find((x: any) => x.id === "materials").settings["wood_planks.roughness"],
    ),
    MATERIAL_RECIPES.wood_planks.defaults.roughness,
    "Redo restores reset roughness",
  )

  // 5. Export & Import preset round-trip
  const exported = await page.evaluate(() => (window as any).lab.workbench.exportPreset())
  const validImport = await page.evaluate((json: string) => (window as any).lab.workbench.importPreset(json), exported)
  assert.equal(validImport.ok, true)

  assert.deepEqual(errors, [])

  const report = {
    adapter,
    domAudit,
    recipeCaptures,
    randomization: { beforeRandom, afterRandom, afterReset },
    presetRoundTrip: validImport.ok,
  }
  writeFileSync(resolve(out, "materials-lab-proof.json"), JSON.stringify(report, null, 2) + "\n")
  console.log(JSON.stringify(report, null, 2))
} finally {
  fixture.stop(true)
  await browser.close()
}
