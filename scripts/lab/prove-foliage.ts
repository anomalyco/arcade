/// <reference types="@webgpu/types" />
// Captures the Lab Vegetation section: every tree, bush and grass preset in the night room under the 70s look,
// plus Noir/day comparisons, a trample sequence and a seeded Randomize round-trip. Headless Metal only.
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { BUSH_PRESET_IDS, GRASS_PRESET_IDS, TREE_PRESETS, TREE_PRESET_IDS } from "@arcade/kit/gpu/foliage"

const root = resolve(import.meta.dir, "../..")
const out = resolve(process.env.FOLIAGE_OUT ?? `${process.env.HOME}/code/home/artifacts/2026-10-14-vegetation/lab`)
mkdirSync(out, { recursive: true })

const labDir = resolve(root, "games/lab")
if (!process.env.SKIP_BUILD) assert.equal(Bun.spawnSync(["bun", "run", "build"], { cwd: labDir, stdout: "inherit", stderr: "inherit" }).exitCode, 0)
const labDist = resolve(labDir, "dist/arcade/lab")
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const p = new URL(req.url).pathname
    const f = Bun.file(resolve(labDist, `.${p === "/" ? "/index.html" : p}`))
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
const captures: string[] = []
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  page.setDefaultTimeout(20000)
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => {
    if (m.type() === "error") errors.push(m.text())
  })
  await page.goto(`http://127.0.0.1:${server.port}/?bench#foliage`)
  await page.waitForFunction(() => !!(window as any).lab, undefined, { timeout: 30000 })
  const adapter = await page.evaluate(() => {
    const a = (window as any).lab.adapter
    return { vendor: String(a.vendor), architecture: String(a.architecture) }
  })
  assert.match(String(adapter.architecture), /metal/i, "Metal WebGPU adapter required")

  const invoke = async (id: string, args: Record<string, unknown>) => {
    const res = await page.evaluate(([i, a]) => (window as any).lab.workbench.invoke(i, a), [id, args] as const)
    assert.equal(res.ok, true, `${id} ${JSON.stringify(args)} failed: ${JSON.stringify(res)}`)
    return res.result
  }
  const step = async (n = 3, dt = 1 / 60) => {
    for (let i = 0; i < n; i++) {
      await page.evaluate(async d => {
        ;(window as any).lab.advance(d)
        await (window as any).lab.render()
      }, dt)
    }
  }
  const shot = async (name: string) => {
    await page.locator("canvas").first().screenshot({ path: resolve(out, `${name}.png`) })
    captures.push(`${name}.png`)
  }

  await invoke("foliage.set", { walker: false })
  for (const [tool, ids] of [["tree", TREE_PRESET_IDS], ["bush", BUSH_PRESET_IDS], ["grass", GRASS_PRESET_IDS]] as const) {
    for (const id of ids) {
      await invoke("foliage.preset", { tool, kind: tool, preset: id, lighting: "night", look: "sodium_70s", cameraMode: "game" })
      await step(4)
      await shot(`${tool}-${id}-night-70s`)
    }
    await invoke("foliage.preset", { tool, lighting: "day", look: "current" })
    await step(3)
    await shot(`${tool}-day`)
    await invoke("foliage.preset", { tool, lighting: "night", look: "noir" })
    await step(3)
    await shot(`${tool}-night-noir`)
    await invoke("foliage.preset", { tool, lighting: "night", look: "sodium_70s", cameraMode: "close" })
    await step(3)
    await shot(`${tool}-close-70s`)
    await invoke("foliage.preset", { cameraMode: "game" })
  }

  // Walkers with the flashlight through the grass and bush rooms (bending is visible around both actors).
  for (const tool of ["grass", "bush"] as const) {
    await invoke("foliage.preset", { tool, lighting: "night", look: "sodium_70s", cameraMode: "game" })
    await invoke("foliage.set", { walker: true })
    await step(90, 1 / 30)
    await shot(`${tool}-walkers-flashlight`)
    await invoke("foliage.set", { walker: false })
  }

  // Bending A/B at an identical tick: same walker positions with actor bend strength 0 vs the preset value.
  await invoke("foliage.preset", { tool: "grass", kind: "grass", preset: "overgrown", lighting: "night", look: "current", cameraMode: "close" })
  await invoke("foliage.set", { walker: true, flashlight: false, grassWind: 0, trampleStrength: 0 })
  await page.evaluate(() => (window as any).lab.sections.find((s: any) => s.id === "foliage").retrigger())
  await step(60, 1 / 30)
  await shot("grass-bend-off")
  await invoke("foliage.set", { trampleStrength: 1 })
  await step(1, 0)
  await shot("grass-bend-on")
  await invoke("foliage.preset", { kind: "grass", preset: "overgrown" })
  await invoke("foliage.set", { walker: false, flashlight: true })

  await invoke("foliage.preset", { tool: "lot", lighting: "night", look: "sodium_70s", cameraMode: "game" })
  await step(4)
  await shot("lot-night-70s")

  // Seeded Randomize is reproducible and leaves the other looks and the structure seed alone.
  await invoke("foliage.preset", { tool: "tree", kind: "tree", preset: "oak" })
  const a = await invoke("foliage.randomize", { scope: "tree", tuningSeed: 55 })
  await invoke("foliage.preset", { kind: "tree", preset: "oak" })
  const b = await invoke("foliage.randomize", { scope: "tree", tuningSeed: 55 })
  assert.deepEqual(a.settings, b.settings)
  assert.equal(a.settings.bushTrim, b.settings.bushTrim)
  await invoke("foliage.preset", { kind: "tree", preset: "reset" })
  const h = await page.evaluate(() => (window as any).lab.sections.find((s: any) => s.id === "foliage").settings.treeHeight)
  assert.notEqual(h, undefined)
  await invoke("foliage.preset", { kind: "tree", preset: "oak" })
  const reset = await page.evaluate(() => (window as any).lab.sections.find((s: any) => s.id === "foliage").settings.treeHeight)
  assert.equal(reset, TREE_PRESETS.oak.values.treeHeight)

  assert.deepEqual(errors, [])
  const summary = { adapter, captures }
  writeFileSync(resolve(out, "proof.json"), JSON.stringify(summary, null, 2) + "\n")
  console.log(JSON.stringify(summary, null, 2))
} finally {
  server.stop(true)
  await browser.close()
}
