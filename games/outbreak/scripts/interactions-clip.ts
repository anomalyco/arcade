import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"
import { createServer } from "vite"

await using budget = browserBudget()
const { chromium } = budget

/**
 * World interactions (AR-96): each staged scene (`src/interactions/stage.ts`) played with scripted input in the real
 * game in headless Metal Chromium (`--mute-audio`, no window), stepped at 60 Hz with `harness.step` and captured as
 * JPEG frames, plus a readout of what each scene left behind. Encode with ffmpeg afterwards.
 *
 *   bun scripts/interactions-clip.ts   frames in captures/interactions-clip/NNNN.jpg, readout in state.json
 *   SCENES=board,pry bun scripts/…     only those scenes
 */
const root = resolve(import.meta.dir, "..")
const out = resolve(root, "../../captures/interactions-clip")

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

type Cmd = Record<string, unknown>
/** `seconds` of one command, its first frame with `first` merged in (a press edge). */
type Segment = { seconds: number; cmd?: Cmd; first?: Cmd }
const E = Math.PI / 2
const hold = (seconds: number, aim: number): Segment[] => [
  { seconds, cmd: { aim, fireHeld: true }, first: { fire: true } },
  { seconds: 1 / 60, cmd: { aim, fireHeld: false } },
]

const scenes: { scene: string; label: string; zoom: number; segments: Segment[]; read: string }[] = [
  {
    scene: "baseball",
    zoom: 20,
    label: "1 · Baseball: hold to wind up (arc + landing ring), release — bonk",
    segments: [{ seconds: 0.2, cmd: { aim: 0 } }, ...hold(0.35, 0), { seconds: 1.4, cmd: { aim: 0 } }, ...hold(0.5, 0.08), { seconds: 1.4, cmd: { aim: 0.08 } }],
    read: `return { drops: [...h.session().sim.progression.ledger.stores.keys()].filter((k) => k.startsWith("drop:t:")).length }`,
  },
  {
    scene: "can",
    zoom: 21,
    label: "2 · Tin can lobbed over the crowd: they turn to the clatter",
    segments: [{ seconds: 0.3, cmd: { aim: 0 } }, ...hold(0.9, 0), { seconds: 2.6, cmd: { aim: 0 } }],
    read: `return { states: h.session().ai.agents.map((a) => a.state) }`,
  },
  {
    scene: "bottle",
    zoom: 21,
    label: "3 · Bottle: shatters where it lands, loud",
    segments: [{ seconds: 0.3, cmd: { aim: 0 } }, ...hold(0.8, 0), { seconds: 2.2, cmd: { aim: 0 } }],
    read: `return { states: h.session().ai.agents.map((a) => a.state) }`,
  },
  {
    scene: "brick",
    zoom: 15,
    label: "4 · Brick through a shut window",
    segments: [{ seconds: 0.3, cmd: { aim: -E } }, ...hold(0.5, -E), { seconds: 1.6, cmd: { aim: -E } }],
    read: `return { open: h.session().sim.town.windows.filter((w) => w.buildingId === "ash" && w.open).map((w) => w.id) }`,
  },
  {
    scene: "drag",
    zoom: 14,
    label: "5 · E drags the dresser (half pace), walk it to the door, E braces it",
    segments: [
      { seconds: 0.5, cmd: { aim: E } },
      { seconds: 0.2, cmd: { aim: E }, first: { interact: true } },
      { seconds: 1.1, cmd: { aim: E, my: 1 } },
      { seconds: 0.3, cmd: { aim: E } },
      { seconds: 1.2, cmd: { aim: E }, first: { interact: true } },
    ],
    read: `return h.session().sim.progression.ledger.store("furn:ash:0")?.counts`,
  },
  {
    scene: "brace",
    zoom: 14,
    label: "6 · The dead bash the braced dresser until it is shoved over",
    segments: [{ seconds: 7, cmd: { aim: E } }],
    read: `return h.session().sim.progression.ledger.store("furn:ash:0")?.counts`,
  },
  {
    scene: "board",
    zoom: 14,
    label: "7 · One B: board after board until the door is full",
    segments: [{ seconds: 0.4, cmd: { aim: E } }, { seconds: 2.9, cmd: { aim: E }, first: { barricade: true } }],
    read: `return { planks: h.session().ai.getBarricadePlanks("ash-front") }`,
  },
  {
    scene: "pry",
    zoom: 14,
    label: "8 · Hold E pries a board off; the plank goes back in the belt",
    segments: [
      { seconds: 0.5, cmd: { aim: E } },
      { seconds: 2.3, cmd: { aim: E, interactHeld: true }, first: { interact: true } },
      { seconds: 0.4, cmd: { aim: E } },
    ],
    read: `return { planks: h.session().ai.getBarricadePlanks("ash-front"), belt: h.session().view.player.planks }`,
  },
]

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${port}/?solo&seed=7&bench&quality=balanced`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 60_000 })
  const ev = (src: string) => page.evaluate(new Function(`const h = window.__arcadeHarness; ${src}`) as () => unknown)
  await ev(`h.freeze(); h.setLab("timeScale", 0); h.setLab("zombieCount", 0); h.session().ai.agents.length = 0`)
  await page.addStyleTag({
    content: `#clip-label{position:fixed;left:16px;top:12px;z-index:99;font:600 18px -apple-system,sans-serif;color:#fff;text-shadow:0 1px 3px #000;pointer-events:none}`,
  })
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  let shot = 0
  let frame = 0
  const readout: Record<string, unknown> = {}
  const only = process.env.SCENES?.split(",")
  for (const s of scenes.filter((x) => !only || only.includes(x.scene))) {
    await ev(`h.session().ai.agents.length = 0; h.stageInteraction(${JSON.stringify(s.scene)}); h.setZoomRaw(${s.zoom})`)
    await page.evaluate((label) => {
      document.querySelector("#clip-label")?.remove()
      document.body.append(Object.assign(document.createElement("div"), { id: "clip-label", textContent: label }))
    }, s.label)
    for (const seg of s.segments) {
      const n = Math.max(1, Math.round(seg.seconds * 60))
      for (let i = 0; i < n; i++) {
        const cmd = { mx: 0, my: 0, aim: 0, interact: false, ...seg.cmd, ...(i === 0 ? seg.first : {}) }
        await page.evaluate(async (c) => {
          await (window as any).__arcadeHarness.step(1 / 60, c)
        }, cmd)
        if (frame++ % 2 === 0) await page.screenshot({ path: resolve(out, `${String(shot++).padStart(4, "0")}.jpg`), type: "jpeg", quality: 88, timeout: 120_000 })
      }
    }
    readout[s.scene] = await ev(s.read)
  }
  writeFileSync(resolve(out, "state.json"), JSON.stringify(readout, null, 1))
  console.log(`interactions-clip: ${shot} frames`)
  console.log(JSON.stringify(readout))
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  await server.close()
}
