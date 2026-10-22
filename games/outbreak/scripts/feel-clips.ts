import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"
import { createServer } from "vite"

await using budget = browserBudget()
const { chromium } = budget

/**
 * Deterministic feel clips for decisions and reviews: the real game in headless Metal Chromium (`--mute-audio`, no
 * window), stepped with `harness.step` at 60 Hz and captured as JPEG frames (encode them with ffmpeg afterwards).
 * Headless frame timing never shows up because every frame is stepped, not played live.
 *
 *   bun scripts/feel-clips.ts lead             camera lead options: today, move (0.3 s), aim (0.3 s + 1.5 m)
 *   bun scripts/feel-clips.ts strike           zombie strike lunge off / on, close up, half speed
 *   bun scripts/feel-clips.ts impact           bullet impact flash off / on at night, half speed
 *   bun scripts/feel-clips.ts oomph [fights]   the staged fights (melee, pistol, blast, car), Today then Physical;
 *                                              `blast,car` records only those
 *
 * Frames land in captures/feel-clips/<scene>-<variant>/NNNN.jpg.
 */
const root = resolve(import.meta.dir, "..")
const scene = process.argv[2] ?? "lead"
const out = resolve(root, "../../captures/feel-clips")

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

try {
  const page = await browser.newPage({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${port}/?solo&seed=7&bench&quality=balanced`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 60_000 })
  const ev = (src: string) => page.evaluate(new Function(`const h = window.__arcadeHarness; ${src}`) as () => unknown)
  await ev(`h.freeze(); h.setLab("timeScale", 0); h.setLab("zombieCount", 0); h.session().ai.agents.length = 0`)
  await page.addStyleTag({
    content: `#clip-label{position:fixed;left:16px;top:12px;z-index:99;font:600 18px -apple-system,sans-serif;color:#fff;text-shadow:0 1px 3px #000;pointer-events:none}
      #clip-centre{position:fixed;left:50%;top:50%;width:22px;height:22px;margin:-11px 0 0 -11px;z-index:99;pointer-events:none;opacity:.7}
      #clip-centre::before,#clip-centre::after{content:"";position:absolute;background:#fff;box-shadow:0 0 2px #000}
      #clip-centre::before{left:10px;top:0;width:2px;height:22px}#clip-centre::after{top:10px;left:0;height:2px;width:22px}`,
  })

  const record = async (name: string, label: string, setup: string, beats: Beat[], every = 2, centre = false) => {
    const dir = resolve(out, `${scene}-${name}`)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    await ev(setup)
    await page.evaluate(
      ({ label, centre }) => {
        document.querySelector("#clip-label")?.remove()
        document.querySelector("#clip-centre")?.remove()
        const l = Object.assign(document.createElement("div"), { id: "clip-label", textContent: label })
        document.body.append(l)
        if (centre) document.body.append(Object.assign(document.createElement("div"), { id: "clip-centre" }))
      },
      { label, centre },
    )
    let frame = 0
    let shot = 0
    for (const beat of beats) {
      for (let i = 0; i < beat.frames; i++) {
        const cmd = { ...(beat.cmd ?? {}), ...(i === 0 ? (beat.first ?? {}) : {}) }
        await page.evaluate(async (cmd) => {
          await (window as any).__arcadeHarness.step(1 / 60, cmd)
        }, cmd)
        if (frame++ % every === 0) await page.screenshot({ path: resolve(dir, `${String(shot++).padStart(4, "0")}.jpg`), type: "jpeg", quality: 88, timeout: 120_000 })
      }
    }
    console.log(`${name}: ${shot} frames`)
  }

  if (scene === "lead") {
    // Walk and sprint along the street, stop, sprint back, then stand and sweep the aim round.
    const E = 0
    const W = Math.PI
    const beats: Beat[] = [
      { frames: 30, cmd: { aim: E } },
      { frames: 90, cmd: { mx: 1, my: 0, aim: E } },
      { frames: 100, cmd: { mx: 1, my: 0, aim: E, sprint: true } },
      { frames: 45, cmd: { aim: E } },
      { frames: 110, cmd: { mx: -1, my: 0, aim: W, sprint: true } },
      { frames: 45, cmd: { aim: W } },
      ...Array.from({ length: 24 }, (_, i) => ({ frames: 5, cmd: { aim: W + ((i + 1) / 24) * Math.PI * 2 } })),
      { frames: 30, cmd: { aim: W } },
    ]
    const setup = (move: number, aim: number) =>
      `h.setLab("hour", 17.5); h.setLab("cameraMoveLead", ${move}); h.setLab("cameraAimLead", ${aim}); h.pose(18, 44.5, 0)`
    await record("1-today", "1 · Today (no lead)", setup(0, 0), beats, 2, true)
    await record("2-move", "2 · Lead movement 0.3 s", setup(0.3, 0), beats, 2, true)
    await record("3-aim", "3 · Lead movement 0.3 s + aim 1.5 m", setup(0.3, 1.5), beats, 2, true)
  } else if (scene === "strike") {
    const setup = (on: number) =>
      `h.setLab("hour", 13); h.setLab("strikeLunge", ${on}); h.session().ai.agents.length = 0; h.pose(44, 44, 0); h.setZoomRaw(14); h.stock(12, {}); const z = h.spawnZombie(46.4, 44, "chase", Math.PI); z.targetX = 44; z.targetY = 44`
    const beats: Beat[] = [{ frames: 150, cmd: { aim: 0 } }]
    await record("before", "Before · strike lands with no motion (½ speed)", setup(0), beats, 1)
    await record("after", "After · strike lunge (½ speed)", setup(1), beats, 1)
  } else if (scene === "impact") {
    const setup = (on: number) =>
      `h.setLab("hour", 21); h.setLab("impactFlash", ${on}); h.setLab("infiniteAmmo", 1); h.session().ai.agents.length = 0; h.stock(12, { ammo: 24 }); h.pose(31, 39.5, -Math.PI / 2); h.setZoomRaw(20)`
    const aim = -Math.PI / 2
    const beats: Beat[] = [
      { frames: 20, cmd: { aim } },
      { frames: 30, cmd: { aim }, first: { fire: true } },
      { frames: 30, cmd: { aim: aim - 0.25 }, first: { fire: true } },
      { frames: 30, cmd: { aim: aim + 0.25 }, first: { fire: true } },
    ]
    await record("before", "Before · a miss is sound only (½ speed)", setup(0), beats, 1)
    await record("after", "After · impact flash (½ speed)", setup(1), beats, 1)
  } else if (scene === "oomph") {
    // The same staged fights (`impact.stage`) and scripted inputs, Today then Physical (AR-90).
    const fights = [
      ["melee", "Fire axe", 204, 16],
      ["pistol", "Pistol", 240, 20],
      ["blast", "Dynamite", 420, 36],
      ["car", "Run-over", 216, 26],
    ] as const
    const only = process.argv[3]?.split(",")
    for (const [id, label, frames, zoom] of fights) {
      if (only && !only.includes(id)) continue
      for (const [style, name] of [[0, "today"], [1, "physical"]] as const) {
        const setup = `h.setLab("impactStyle", ${style}); h.clearBlood?.(); h.stageImpact("${id}"); h.setZoomRaw(${zoom})`
        await record(`${id}-${name}`, `${label} · ${style ? "Physical" : "Today"}`, setup, [{ frames }], 1)
      }
    }
  }
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  await server.close()
}
