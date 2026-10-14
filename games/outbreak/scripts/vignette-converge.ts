import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"

const outDir = resolve("/Users/kit/code/home/artifacts/2026-10-14-outbreak-vignette")
const targetDir = resolve("/Users/kit/code/home/artifacts/2026-10-14-outbreak-directions")
mkdirSync(outDir, { recursive: true })

const roundName = process.env.ROUND ?? "round0"
const presetSlug = process.env.PRESET ?? "noir"
const targetPrefix = presetSlug === "painterly" ? "dir2" : "dir3"

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter(n => /^chromium-\d+$/.test(n))
  .sort()
  .reverse()
  .map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)
  .find(existsSync)
assert(chrome, "Playwright Chromium not found")

const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

try {
  // Collapse workbench sidebars with Backquote so the canvas is 1000x680 full-bleed, matching target captures 1:1
  const page = await browser.newPage({ viewport: { width: 1000, height: 680 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => {
    if (m.type() === "error") errors.push(m.text())
  })

  await page.goto("http://127.0.0.1:5188/arcade/lab/?game=outbreak&section=outbreak-vignette&bench")
  await page.waitForFunction(() => Boolean((window as any).lab && (window as any).__arcadeDevControl), undefined, {
    timeout: 30000,
  })

  // Hide workbench chrome so canvas is 1000x680
  await page.evaluate(() => {
    const wb = document.querySelector<HTMLElement>("[data-lab-workbench]")!
    wb.dataset.closed = "true"
    wb.style.gridTemplateColumns = "0px 1fr 0px"
    wb.style.gridTemplateRows = "0px 1fr 0px"
    const hud = document.querySelector<HTMLElement>(".lab-viewport-hud")
    if (hud) hud.style.display = "none"
  })

  await page.evaluate(
    async ({ slug }) => {
      const lab = (window as any).lab
      lab.workbench.invoke("vignette.preset", { direction: slug })
      await lab.render()
      await new Promise(r => setTimeout(r, 250))
      await lab.render()
    },
    { slug: presetSlug },
  )

  const shots = [
    {
      name: "street",
      cameraPreset: "target_street",
      targetFile: resolve(targetDir, `${targetPrefix}-street.png`),
    },
    {
      name: "interior",
      cameraPreset: "target_interior",
      targetFile: resolve(targetDir, `${targetPrefix}-interior.png`),
    },
  ] as const

  const results: Record<string, unknown> = {}

  for (const shot of shots) {
    const timing = await page.evaluate(async preset => {
      const lab = (window as any).lab
      lab.workbench.invoke("vignette.camera", { preset })
      for (let i = 0; i < 6; i++) {
        lab.advance(1 / 60)
        await lab.render()
      }
      const spans: number[] = []
      for (let i = 0; i < 15; i++) {
        const t0 = performance.now()
        lab.advance(1 / 60)
        await lab.render()
        await lab.context.device.queue.onSubmittedWorkDone()
        spans.push(performance.now() - t0)
      }
      spans.sort((a, b) => a - b)
      return {
        medianMs: Number(spans[Math.floor(spans.length / 2)]!.toFixed(2)),
        p95Ms: Number(spans[Math.floor(spans.length * 0.95)]!.toFixed(2)),
      }
    }, shot.cameraPreset)

    const outPath = resolve(outDir, `${roundName}-${shot.name}.png`)
    await page.locator("canvas").first().screenshot({ path: outPath })
    results[shot.name] = { outPath, targetFile: shot.targetFile, timing }
  }

  assert.deepEqual(errors, [])
  writeFileSync(resolve(outDir, `${roundName}-capture.json`), JSON.stringify({ roundName, presetSlug, results }, null, 2))
} finally {
  await browser.close()
}
