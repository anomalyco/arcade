// Text sharpness of the character HUD: stages callouts and meters on a survivor at a fractional world position (plus a
// smaller teammate), captures each visible callout and meter at DPR 1 and 2, and writes crops and their boxes for
// scripts/hud-sharpness.py to score. Headless Metal, no visible window, no audio.
//   bun scripts/hud-sharpness.ts [--out captures/outbreak-hud-sharpness/after] [--style 4]
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { createServer } from "vite"

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const root = resolve(import.meta.dir, "..")
const out = resolve(root, "../..", arg("--out") ?? "captures/outbreak-hud-sharpness/after")
const style = Number(arg("--style") ?? 4)
mkdirSync(out, { recursive: true })

const server = await createServer({
  root,
  logLevel: "warn",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "hud-sharpness-hooks",
      enforce: "pre",
      transform(code, id) {
        if (id !== resolve(root, "src/main.ts")) return
        return code.replace("const harness = {", "const harness = { hud, renderer, session: () => session,")
      },
    },
  ],
})
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)
  .find(existsSync)
assert(chrome, "Playwright Chromium binary not found")
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

type Item = { kind: "callout" | "vital" | "control"; label: string; file: string; dpr: number; rect: { x: number; y: number; width: number; height: number }; transform: string }
const items: Item[] = []
try {
  for (const dpr of [1, 2]) {
    // One context per DPR, kept open: closing a WebGPU page and opening another has crashed headless Chromium here.
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: dpr })
    const page = await context.newPage()
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(e.message))
    await page.goto(`http://127.0.0.1:${port}/?seed=7&bench`)
    await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 120_000 })
    await page.evaluate(async (style) => {
      const h = (window as any).__arcadeHarness
      h.freeze(true)
      h.reset(7)
      h.setLab("timeScale", 0)
      h.setLab("hour", 21)
      h.setLab("zoom", 34)
      h.setLab("zombieCount", 0)
      h.setLab("hudStyle", style)
      h.setLab("calloutPlacement", -1)
      h.setLab("vitalsPlacement", -1)
      h.pose(30.37, 41.13, -0.7)
      const mate = h.session().sim.addSurvivor("Wren", 1)
      Object.assign(mate.survivor, { x: 32.41, y: 41.47, aim: Math.PI, flashlightOn: true, flashlightOutput: 1, health: 100 })
      for (let i = 0; i < 4; i++) await h.step()
      Object.assign(h.state().player, { stamina: 0.24, health: 70, magAmmo: 0 })
      Object.assign(mate.survivor, { health: 74, exhausted: true, reloadRemaining: 0.6 })
      const layer = h.hud.layer
      layer.callout("local", "Door locked", "result", { duration: 60 })
      layer.callout("local", "Reloading", "progress", { key: "reload", progress: 0.55, duration: 60 })
      layer.callout("local", "Empty, R to reload", "warning", { key: "ammo", duration: 60, keyCap: { code: "KeyR", label: "R" } })
      // A slow drift keeps the camera and anchors at fractional positions, as in play.
      for (let i = 0; i < 40; i++) await h.step(1 / 60, { aim: -0.7, mx: 0.002, sprint: true })
    }, style)
    await page.waitForTimeout(300)
    const found = await page.evaluate(() => {
      const pick = (sel: string, kind: string) =>
        [...document.querySelectorAll<HTMLElement>(sel)]
          .filter((e) => Number(getComputedStyle(e).opacity) > 0.5 && (e.querySelector(".callout-body") ?? e).getBoundingClientRect().width > 2)
          .map((e) => {
            const r = (e.querySelector(".callout-body") ?? e).getBoundingClientRect()
            return { kind, label: (e.textContent || e.dataset.meter || "").trim(), rect: { x: r.x, y: r.y, width: r.width, height: r.height }, transform: e.style.transform }
          })
      return [...pick(".callout", "callout"), ...pick(".vital", "vital"), ...pick("#status", "control")]
    })
    await page.screenshot({ path: resolve(out, `full-dpr${dpr}.png`) })
    for (const [i, f] of found.entries()) {
      const pad = 4
      const clip = { x: Math.max(0, f.rect.x - pad), y: Math.max(0, f.rect.y - pad), width: f.rect.width + pad * 2, height: f.rect.height + pad * 2 }
      const file = `dpr${dpr}-${String(i).padStart(2, "0")}-${f.kind}.png`
      await page.screenshot({ path: resolve(out, file), clip })
      items.push({ ...(f as Omit<Item, "file" | "dpr">), kind: f.kind as Item["kind"], file, dpr })
    }
    assert.deepEqual(errors, [])
  }
  writeFileSync(resolve(out, "items.json"), JSON.stringify(items, null, 2))
  console.log(`${items.length} crops in ${out}`)
} finally {
  await browser.close()
  await server.close()
}
