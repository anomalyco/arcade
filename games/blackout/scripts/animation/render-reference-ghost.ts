import { browserBudget } from "../../../../scripts/browser-budget"
import { createServer } from "vite"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { findChromeExecutable } from "../compare"
import { blackoutRoot, parseArgs } from "./common"

await using budget = browserBudget()
const { chromium } = budget

// Stills and a short muted clip of the Characters page's Lab-only reference ghost walking beside an actor,
// stepped deterministically with window.advance (no real-time stutter).
// Usage: bun games/blackout/scripts/animation/render-reference-ghost.ts [--out dir]
const { out: OUT_DIR } = parseArgs(process.argv.slice(2), { tag: "ghost", out: "reference-ghost" })

const SCENES = [
  { id: "zombie-100style", actor: "outbreak-zombie", action: "action.walk", clip: "style-zombie-walk" },
  { id: "zombie-ual", actor: "outbreak-zombie", action: "action.walk", clip: "ual-zombie-walk" },
  { id: "survivor-walk-100style", actor: "survivor", action: "action.walk", clip: "style-neutral-walk" },
  { id: "survivor-run-ual", actor: "survivor", action: "action.run", clip: "ual-jog" },
] as const

const server = await createServer({ root: blackoutRoot, optimizeDeps: { force: true }, server: { host: "127.0.0.1", port: 0, strictPort: false } })
await server.listen()
const address = server.httpServer!.address()
if (!address || typeof address === "string") throw new Error("Missing Vite port")
const base = `http://127.0.0.1:${address.port}`
const browser = await chromium.launch({
  executablePath: findChromeExecutable(),
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

try {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 2 })
  for (const scene of SCENES) {
    await page.goto(`${base}/characters.html?manual&nolab#${scene.actor}`)
    await page.waitForFunction(() => (window as any).ready === true, null, { timeout: 30000 })
    await page.addStyleTag({ content: `.hub-bar, .char-hud-top, .char-dock, .char-status, aside[data-lab] { display: none !important; }` })
    const dir = join(OUT_DIR, scene.id)
    mkdirSync(dir, { recursive: true })
    await page.evaluate(async ({ actor, action, clip }) => {
      const p = (window as any).charactersProof
      p.selectActor(actor, true)
      await p.invoke(action)
      await p.invoke("character.reference", { clip, offset: 0.9 })
      p.frameSelected("close")
    }, scene)
    await page.evaluate(() => (window as any).advance(2000))
    // 2 s at 30 fps.
    for (let f = 0; f < 60; f++) {
      await page.evaluate(() => (window as any).advance(1000 / 30))
      await page.screenshot({ path: join(dir, `f${String(f).padStart(3, "0")}.png`) })
    }
    const mp4 = join(OUT_DIR, `${scene.id}.mp4`)
    spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "30", "-i", join(dir, "f%03d.png"), "-an", "-vf", "scale=960:-2", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-crf", "22", mp4], { stdio: "inherit" })
    console.log(`wrote ${mp4}`)
  }
} finally {
  await browser.close()
  await server.close()
}
