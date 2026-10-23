import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"
import { createServer } from "vite"

await using budget = browserBudget()
const { chromium } = budget

const game = resolve(import.meta.dir, "..")
const out = resolve(game, "../../captures/game-feel")
const framesDir = resolve(out, "clip-frames")
mkdirSync(framesDir, { recursive: true })

const server = await createServer({
  root: game,
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "prove-feel-hooks",
      enforce: "pre",
      transform(code, id) {
        if (id !== resolve(game, "src/main.ts")) return
        return code.replace("Object.assign(harness, { map })", "Object.assign(harness, { map, renderer, render, lab })")
      },
    },
  ],
})
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
assert(chrome, "Playwright Chromium not found")

const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}
const mad = (xs: number[]): number => {
  const m = median(xs)
  return median(xs.map((x) => Math.abs(x - m)))
}

try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 680 }, deviceScaleFactor: 1 })
  await page.addInitScript(() => {
    const request = GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice = function (desc: GPUDeviceDescriptor = {}) {
      return request.call(this, {
        ...desc,
        requiredFeatures: this.features.has("timestamp-query") ? ["timestamp-query"] : [],
      })
    }
  })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text())
  })
  await page.goto(`http://127.0.0.1:${port}/?solo&seed=7&bench`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
  const adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  assert.match(adapter.architecture, /metal/)

  // 1. Verify reduced-motion accessibility in live browser runtime
  const reducedMotionCheck = await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    h.reset(7)
    h.setLab("reduceMotion", 1)
    h.setLab("shakeScale", 1)
    h.setLab("kickScale", 1)
    h.setLab("burst", 1)
    h.triggerImpulse("shot", { power: 1.5 })
    h.triggerImpulse("shove", { power: 1.5 })
    h.triggerImpulse("hit-taken", { damage: 35 })
    await h.step(1 / 60)
    const st = h.state().camera
    h.setLab("reduceMotion", 0)
    return st
  })
  assert.equal(reducedMotionCheck.reduceMotion, true)
  assert.equal(reducedMotionCheck.trauma, 0)
  assert.deepEqual(reducedMotionCheck.offset, { x: 0, z: 0, zoom: 0, roll: 0 })
  assert.deepEqual(reducedMotionCheck.burst, { dx: 0, dy: 0, radial: 0, shutterBoost: 0 })
  assert(reducedMotionCheck.damageFlash > 0 && reducedMotionCheck.damageFlash <= 1)

  // 2. Capture paired Feel OFF vs Feel ON stills for shot, shove, hit-taken, explosion
  const events = ["shot", "shove", "hit-taken", "explosion"] as const
  const eventSnapshots: Record<string, any> = {}

  for (const ev of events) {
    eventSnapshots[ev] = {}
    for (const mode of ["off", "on"] as const) {
      const info = await page.evaluate(
        async ({ ev, isOn }) => {
          const h = (window as any).__arcadeHarness
          h.reset(7)
          h.setLab("timeScale", 0)
          h.setLab("hour", 18)
          h.setLab("zoom", 36)
          h.setLab("zombieCount", 0)
          h.setLab("infiniteAmmo", 1)
          h.setLab("reduceMotion", 0)
          h.setLab("shakeScale", isOn ? 1.25 : 0)
          h.setLab("kickScale", isOn ? 1.25 : 0)
          h.setLab("damageFlashScale", isOn ? 1.25 : 0)
          h.setLab("burst", isOn ? 1.25 : 0)
          h.setLab("bloodStyle", isOn ? 1 : 2)
          const aim = -Math.PI / 2
          h.pose(30, 41, aim)
          await h.step(1 / 60, { aim })
          await h.step(1 / 60, { aim })

          if (ev === "shot") {
            const z = h.spawnZombie(30, 38.2, "chase", Math.PI / 2)
            z.hp = 45
            await h.step(1 / 60, { aim })
            await h.step(1 / 60, { aim })
            await h.step(1 / 60, { fire: true, aim })
            for (let i = 0; i < 16; i++) await h.step(1 / 60, { aim })
            if (isOn) h.triggerImpulse("shot", { power: 1.25 })
            await h.step(1 / 60, { aim })
          } else if (ev === "shove") {
            h.spawnZombie(30, 39.6, "chase", Math.PI / 2)
            await h.step(1 / 60, { aim })
            await h.step(1 / 60, { melee: true, aim })
            for (let i = 0; i < 12; i++) await h.step(1 / 60, { aim })
            if (isOn) h.triggerImpulse("shove", { power: 1.25 })
            await h.step(1 / 60, { aim })
          } else if (ev === "hit-taken") {
            h.spawnZombie(30, 40.0, "chase", Math.PI / 2)
            await h.step(1 / 60, { aim })
            for (let i = 0; i < 14; i++) await h.step(1 / 60, { aim })
            if (isOn) h.triggerImpulse("hit-taken", { damage: 28 })
            await h.step(1 / 60, { aim })
          } else if (ev === "explosion") {
            const z = h.spawnZombie(30, 37.8, "chase", Math.PI / 2)
            z.hp = 45
            await h.step(1 / 60, { aim })
            await h.step(1 / 60, { aim })
            await h.step(1 / 60, { fire: true, aim })
            for (let i = 0; i < 16; i++) await h.step(1 / 60, { aim })
            if (isOn) h.triggerImpulse("explosion", { power: 1.15 })
            await h.step(1 / 60, { aim })
          }
          return h.state().camera
        },
        { ev, isOn: mode === "on" },
      )
      eventSnapshots[ev][mode] = info
      await page.locator("#game").screenshot({ path: resolve(out, `feel-${ev}-${mode}.png`) })
    }
  }

  // 3. Paired GPU hardware timestamp measurement (1 warmup + 7 alternating pairs) at 1000x680
  const gpuPairs: { round: number; offMs: number; onMs: number; deltaMs: number }[] = []
  for (let round = 0; round < 8; round++) {
    const measureVariant = async (isOn: boolean) => {
      return page.evaluate(
        async ({ isOn }) => {
          const h = (window as any).__arcadeHarness
          h.reset(7)
          h.setLab("timeScale", 0)
          h.setLab("hour", 18)
          h.setLab("zoom", 36)
          h.setLab("zombieCount", 0)
          h.setLab("infiniteAmmo", 1)
          h.setLab("reduceMotion", 0)
          h.setLab("shakeScale", isOn ? 1.0 : 0)
          h.setLab("kickScale", isOn ? 1.0 : 0)
          h.setLab("burst", isOn ? 1.0 : 0)
          h.setLab("bloodStyle", isOn ? 1 : 0)
          const aim = -Math.PI / 2
          h.pose(30, 41, aim)
          const z = h.spawnZombie(30, 38.2, "chase", Math.PI / 2)
          z.hp = 45
          await h.step(1 / 60, { aim })
          await h.step(1 / 60, { fire: true, aim })
          for (let i = 0; i < 6; i++) await h.step(1 / 60, { aim })
          if (isOn) h.triggerImpulse("shot", { power: 1.0 })
          await h.step(1 / 60, { aim })
          const samples: number[] = []
          for (let i = 0; i < 10; i++) {
            const ms = await h.renderer.measure(h.render)
            if (i >= 2) samples.push(ms)
          }
          samples.sort((a, b) => a - b)
          return samples[Math.floor(samples.length / 2)]!
        },
        { isOn },
      )
    }
    const a = await measureVariant(round % 2 === 1)
    const b = await measureVariant(round % 2 === 0)
    const offMs = round % 2 === 1 ? b : a
    const onMs = round % 2 === 1 ? a : b
    if (round > 0) {
      gpuPairs.push({ round, offMs, onMs, deltaMs: onMs - offMs })
    }
  }

  const deltas = gpuPairs.map((p) => p.deltaMs)
  const summary = {
    adapter,
    reducedMotionCheck,
    eventSnapshots,
    gpuActiveShotBlurAndSplatter: {
      medianOffMs: Number(median(gpuPairs.map((p) => p.offMs)).toFixed(3)),
      medianOnMs: Number(median(gpuPairs.map((p) => p.onMs)).toFixed(3)),
      medianDeltaMs: Number(median(deltas).toFixed(3)),
      madDeltaMs: Number(mad(deltas).toFixed(3)),
      pairs: gpuPairs,
    },
    errors,
  }
  writeFileSync(resolve(out, "feel-proof.json"), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  await server.close()
}
