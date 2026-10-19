import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright-core"
import { createServer } from "vite"

/**
 * Fire, smoke and beam dust at night (AR-68), in the real game in headless Metal Chromium (`--mute-audio`, no window),
 * stepped at 60 Hz with `harness.step`. Run through `hivemind run --kind browser`.
 *
 *   bun scripts/fire-smoke-proof.ts --mode stills   Today vs kit fire stills per scene, plus paired GPU (stills/, gpu.json)
 *   bun scripts/fire-smoke-proof.ts --mode clip     one labelled clip as JPEG frames (clip/NNNN.jpg, 30 fps)
 *   bun scripts/fire-smoke-proof.ts --mode all      both, on one page
 *
 * Output goes to captures/fire-smoke/. "Today" is `fireStyle` 0, `worldSmoke` 0 and `beamDustStyle` 0.
 */
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1]! : fallback
}
const mode = arg("mode", "stills")
const zoom = Number(arg("zoom", "19"))
const root = resolve(import.meta.dir, "..")
const out = resolve(root, "../../captures/fire-smoke")

const TODAY = { fireStyle: 0, worldSmoke: 0, beamDustStyle: 0 }
const KIT = { fireStyle: 1, worldSmoke: 1, beamDustStyle: 1 }

const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 } })
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
assert(executablePath, "Playwright Chromium not found")
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

type Beat = { frames: number; cmd?: Record<string, unknown>; first?: Record<string, unknown> }
type Scene = { name: string; label: string; setup: string; beats: Beat[]; still: number }

/** Each scene: harness setup, then 60 Hz beats; `still` is the frame its still is taken at. */
const SCENES: Scene[] = [
  {
    name: "flamethrower",
    label: "Flamethrower on a group",
    setup: `h.stageFire("flamethrower")`,
    beats: [
      { frames: 20, cmd: { aim: 0 } },
      { frames: 200, cmd: { aim: 0, fireHeld: true }, first: { fire: true } },
      { frames: 40, cmd: { aim: 0.22, fireHeld: true } },
      { frames: 50, cmd: { aim: 0 } },
    ],
    still: 150,
  },
  {
    name: "burning",
    label: "The dead burning",
    setup: `h.stageFire("burning"); for (const z of h.session().ai.agents) if (z.state !== "dead") z.state = "chase"`,
    beats: [{ frames: 240, cmd: { aim: 0 } }],
    still: 90,
  },
  {
    name: "molotov",
    label: "Molotov",
    setup: `h.stageFire("molotov")`,
    beats: [{ frames: 230, cmd: { aim: 0 } }],
    still: 40,
  },
  {
    name: "dynamite",
    label: "Dynamite",
    setup: `h.stageFire("dynamite")`,
    beats: [
      { frames: 20, cmd: { aim: 0 } },
      { frames: 300, cmd: { aim: 0 }, first: { fire: true } },
    ],
    still: 190,
  },
  {
    name: "steam",
    label: "Sewer steam in the beam",
    setup: `h.session().ai.agents.length = 0; const src = h.stageAir("steam"); window.__airAim = h.state().player.aim`,
    beats: [{ frames: 300 }],
    still: 200,
  },
]

const evalIn = (page: Page, src: string) => page.evaluate(new Function(`const h = window.__arcadeHarness; ${src}`) as () => unknown)

async function openPage(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
  await page.addInitScript(() => {
    const request = GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice = function (desc: GPUDeviceDescriptor = {}) {
      return request.call(this, { ...desc, requiredFeatures: this.features.has("timestamp-query") ? ["timestamp-query"] : [] })
    }
  })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => {
    if (m.type() === "error" || /wgsl|WGSL|validation/i.test(m.text())) errors.push(m.text())
  })
  ;(page as any).errors = errors
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") console.log(`[page:${m.type()}] ${m.text().slice(0, 300)}`)
  })
  await page.goto(`http://127.0.0.1:${port}/?solo&seed=7&bench&quality=balanced`, { timeout: 300_000 })
  try {
    // A cold Vite compile on a busy worker can take minutes.
    await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 420_000 })
  } catch (e) {
    console.log("harness never ready; page errors:", JSON.stringify(errors))
    throw e
  }
  await evalIn(page, `h.freeze(); h.setLab("timeScale", 0); h.setLab("zombieCount", 0); try { h.setLab("death.deathMode", 0) } catch {}; h.session().ai.agents.length = 0; h.setZoomRaw(${zoom})`)
  await page.addStyleTag({
    content: `#clip-label{position:fixed;left:16px;top:12px;z-index:99;font:600 18px -apple-system,sans-serif;color:#fff;text-shadow:0 1px 3px #000;pointer-events:none}`,
  })
  return page
}

const setKnobs = (page: Page, knobs: Record<string, number>) =>
  evalIn(page, Object.entries(knobs).map(([k, v]) => `h.setLab(${JSON.stringify(k)}, ${v});`).join(""))

/** Plays a scene, calling `onFrame(i)` after each 60 Hz step. Steam pans its aim slowly across the vent. */
async function play(page: Page, s: Scene, onFrame: (i: number) => Promise<void>) {
  await evalIn(page, `h.session().ai.agents.length = 0; ${s.setup}`)
  let i = 0
  for (const beat of s.beats) {
    for (let j = 0; j < beat.frames; j++, i++) {
      const cmd: Record<string, unknown> = { ...(beat.cmd ?? {}), ...(j === 0 ? (beat.first ?? {}) : {}) }
      if (s.name === "steam") cmd.aim = (await page.evaluate(() => (window as any).__airAim as number)) + 0.32 * Math.sin(i / 70)
      await page.evaluate(async (cmd) => {
        const h = (window as any).__arcadeHarness
        // Keep the survivor up with the beam on through the whole reel.
        Object.assign(h.state().player, { health: h.state().player.maxHealth ?? 100, battery: 1, batteryDepleted: false, flashlightOn: true })
        await h.step(1 / 60, cmd)
      }, cmd)
      await onFrame(i)
    }
  }
}

async function frameMs(page: Page): Promise<number> {
  return (await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    const v: number[] = []
    for (let i = 0; i < 10; i++) v.push(await h.renderer.measure(h.render))
    return v.slice(2).sort((x: number, y: number) => x - y)[3]!
  })) as number
}

const med = (xs: number[]) => {
  const s = [...xs].sort((p, q) => p - q)
  return (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2
}

try {
  const page = await openPage()
  if (mode === "stills" || mode === "all") {
    const dir = resolve(out, "stills")
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const gpu: Record<string, unknown> = {}
    for (const s of SCENES) {
      // One run per scene: at the still frame, the kit look, then the same frozen moment redrawn as Today (its sprites
      // and scorch are analytic, so they draw at once; Today also drops the kit pool). GPU: that frame both ways.
      await setKnobs(page, KIT)
      let done = false
      await play(page, s, async (i) => {
        if (i !== s.still || done) return
        done = true
        await page.screenshot({ path: resolve(dir, `${s.name}-kit.jpg`), type: "jpeg", quality: 90 })
        const fx = await evalIn(page, `return h.state().fx`)
        const b: number[] = []
        for (let r = 0; r < 3; r++) b.push(await frameMs(page))
        await setKnobs(page, TODAY)
        await page.evaluate(async () => (window as any).__arcadeHarness.step(0, {}))
        await page.screenshot({ path: resolve(dir, `${s.name}-today.jpg`), type: "jpeg", quality: 90 })
        const a: number[] = []
        for (let r = 0; r < 3; r++) a.push(await frameMs(page))
        await setKnobs(page, KIT)
        gpu[s.name] = { todayMs: +med(a).toFixed(3), kitMs: +med(b).toFixed(3), deltaMs: +(med(b) - med(a)).toFixed(3), fx }
        console.log(s.name, JSON.stringify(gpu[s.name]))
      })
    }
    writeFileSync(resolve(out, "gpu.json"), JSON.stringify(gpu, null, 2))
  }
  if (mode === "clip" || mode === "all") {
    const dir = resolve(out, "clip")
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    await setKnobs(page, KIT)
    let shot = 0
    for (const s of SCENES) {
      await page.evaluate((label) => {
        document.querySelector("#clip-label")?.remove()
        document.body.append(Object.assign(document.createElement("div"), { id: "clip-label", textContent: label }))
      }, s.label)
      await play(page, s, async (i) => {
        if (i % 2 === 0) await page.screenshot({ path: resolve(dir, `${String(shot++).padStart(4, "0")}.jpg`), type: "jpeg", quality: 88, timeout: 120_000 })
      })
    }
    console.log(`fire-smoke clip: ${shot} frames`, JSON.stringify(await evalIn(page, `return h.state().fx`)))
  }
  assert.deepEqual((page as any).errors, [])
} finally {
  await browser.close()
  await server.close()
}
