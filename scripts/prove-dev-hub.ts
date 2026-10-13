import { chromium } from "playwright-core"
import { createServer } from "vite"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, ".."), out = join(root, "captures/dev-hub")
mkdirSync(out, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter(name => /^chromium-\d+$/.test(name)).reverse().map(name => `${cache}/${name}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const errors: string[] = [], report: Record<string, unknown> = {}
try {
  for (const host of ["getaway", "blackout"]) {
    const dir = join(root, "games", host), server = await createServer({ root: dir, configFile: join(dir, "vite.config.ts"), server: { host: "127.0.0.1", port: 0 } })
    await server.listen()
    try {
      const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("No port")
      const page = await browser.newPage({ viewport: { width: 1200, height: 850 } })
      page.on("pageerror", error => errors.push(error.message))
      page.on("console", message => { if (message.type() === "error" && !message.text().includes("404")) errors.push(message.text()) })
      await page.addInitScript(() => {
        const state = { draws: 0, audio: 0 }; Object.assign(window, { hubProof: state })
        const submit = GPUQueue.prototype.submit
        GPUQueue.prototype.submit = function (...args) { state.draws++; return submit.apply(this, args) }
        const OriginalAudio = window.AudioContext
        window.AudioContext = class extends OriginalAudio { constructor(...args: ConstructorParameters<typeof AudioContext>) { super(...args); state.audio++ } }
      })
      await page.goto(`http://localhost:${address.port}/dev.html`)
      if (await page.locator("[data-games] a").count() !== 3 || await page.locator("[data-prototypes] a").count() !== 2) throw new Error("Game/prototype grouping")
      for (const link of await page.locator('[data-prototypes] a').all()) if (await link.isVisible()) throw new Error("Prototype promoted")
      await page.getByText("Local previews", { exact: true }).click()
      await page.getByLabel("Getaway", { exact: true }).fill("http://explicit-preview.localhost:1355/")
      await page.getByRole("button", { name: "Save", exact: true }).click()
      if (await page.locator('[data-games] a').first().getAttribute("href") !== "http://explicit-preview.localhost:1355/") throw new Error("Explicit preview not used")
      await page.getByRole("button", { name: "Use production" }).click()
      await page.screenshot({ path: join(out, `${host}-games.png`) })
      await page.getByRole("link", { name: "Catalogue", exact: true }).click()
      await page.getByText("Real game geometry · shared Lab shading", { exact: true }).waitFor()
      if (await page.locator(".asset-grid button").count() !== 25 || await page.locator("canvas").count() !== 1) throw new Error("Registry or canvas budget")
      for (const id of await page.locator(".asset-grid button").evaluateAll(buttons => buttons.map(button => (button as HTMLElement).dataset.assetId!))) {
        await page.locator(`[data-asset-id="${id}"]`).click()
        if (await page.locator("[data-asset-id]").last().textContent() !== id) throw new Error(`Registry selection failed: ${id}`)
      }
      await page.getByRole("searchbox", { name: "Search assets" }).fill("prop cone")
      if (await page.locator(".asset-grid button").count() !== 1) throw new Error("ID filter")
      await page.locator(".asset-grid button").click()
      if (await page.locator("[data-asset-id]").last().textContent() !== "getaway:prop:cone") throw new Error("Selection ID")
      await page.getByRole("searchbox", { name: "Search assets" }).fill("")
      await page.getByRole("combobox", { name: "Asset category" }).selectOption("character")
      if (await page.locator(".asset-grid button").count() !== 1) throw new Error("Category filter")
      await page.locator(".asset-grid button").click()
      await page.getByRole("combobox", { name: "Asset category" }).selectOption("all")
      await page.locator('[data-asset-id="getaway:compact"]').click()
      const light = page.getByRole("combobox", { name: "Setup", exact: true })
      for (const setup of ["neutral", "day", "night", "interior"]) {
        await light.selectOption(setup)
        await page.getByRole("button", { name: "Export feedback", exact: true }).click()
        const json = JSON.parse(await page.getByRole("textbox", { name: "Feedback JSON content" }).inputValue())
        if (json.assetId !== "getaway:compact" || json.lighting.setup !== setup || json.seed !== 7) throw new Error("Feedback identity or settings")
        await page.getByRole("button", { name: "Close", exact: true }).click()
      }
      await light.selectOption("neutral")
      const canvas = page.getByLabel("Asset viewer", { exact: true })
      await canvas.focus(); await page.keyboard.press("f")
      await page.getByRole("button", { name: "Zoom in" }).click()
      await canvas.click({ button: "right" })
      await page.getByRole("dialog", { name: "Asset actions" }).waitFor()
      await page.getByRole("button", { name: "Frame · F", exact: true }).last().click()
      await page.keyboard.press("Escape")
      if (!await page.getByRole("searchbox", { name: "Search assets" }).evaluate(el => el === document.activeElement)) throw new Error("Escape focus")
      await page.getByRole("textbox", { name: "Asset feedback", exact: true }).fill("Inspect rear wheel")
      await page.keyboard.press("f")
      if (!(await page.getByRole("textbox", { name: "Asset feedback", exact: true }).inputValue()).endsWith("f")) throw new Error("Canvas F hijacked text input")
      await page.getByRole("textbox", { name: "Asset feedback", exact: true }).fill("Inspect rear wheel")
      const ctrlWheelAllowed = await canvas.evaluate(element => { const event = new WheelEvent("wheel", { deltaY: 100, ctrlKey: true, cancelable: true }); return element.dispatchEvent(event) })
      if (!ctrlWheelAllowed) throw new Error("Native ctrl-wheel/pinch hijacked")
      await page.getByRole("button", { name: "Copy feedback", exact: true }).click()
      // Clipboard may require permission; its export fallback must retain the same asset.
      if (await page.getByRole("dialog", { name: "Feedback JSON" }).isVisible()) await page.getByRole("button", { name: "Close", exact: true }).click()
      await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: join(out, `${host}-catalogue.png`) })
      const state = () => page.evaluate(() => (window as unknown as { hubProof: { draws: number; audio: number } }).hubProof)
      await page.getByRole("link", { name: "Games", exact: true }).click()
      const before = await state(); await page.waitForTimeout(200); const after = await state()
      if (after.draws !== before.draws || after.audio !== 0) throw new Error("Hidden route rendering/audio")
      await page.getByRole("link", { name: "Catalogue", exact: true }).click()
      await page.waitForTimeout(100)
      await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")) })
      const hidden = await state(); await page.waitForTimeout(200)
      if ((await state()).draws !== hidden.draws) throw new Error("Hidden document rendered")
      await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: false }); document.dispatchEvent(new Event("visibilitychange")) })
      await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: join(out, `${host}-mobile.png`) })
      report[host] = { assets: 25, canvases: 1, audioContexts: after.audio, demandDrivenDraws: after.draws, hiddenRoutePaused: true, syntheticVisibilityPaused: true }
      await page.getByRole("link", { name: "Sandbox", exact: true }).click()
      await page.getByRole("link", { name: "Dev Hub" }).waitFor()
      await page.getByRole("link", { name: "Dev Hub" }).click()
      if (!page.url().endsWith("/dev.html#games")) throw new Error("Lab return navigation")
      await page.close()
    } finally { await server.close() }
  }
  if (errors.length) throw new Error(errors.join("\n"))
  writeFileSync(join(out, "report.json"), JSON.stringify({ ...report, errors }, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally { await browser.close() }
