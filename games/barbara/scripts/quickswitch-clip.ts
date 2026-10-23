// A short headless, muted clip of the Lab's quick switch while walking: ` opens the knobs and ` again goes straight
// back to the woods, then ] steps the Looks, \ flips back and forth, ' picks the camera looks and ] steps those, with
// the key-cap toast (run after `bun run build`, through HiveMind browser):
//   ARCADE_BROWSER_BUDGET_S=300 bun scripts/quickswitch-clip.ts [--out <dir>]
// Frames are screenshots taken as fast as the page allows while the steps run in real time, encoded at the measured
// rate with ffmpeg; the frames are deleted afterwards. The walk is the automation autopilot (real inputs, no pointer
// lock, which a headless page doesn't keep); the panel's one-key return to pointer lock is proven by
// scripts/lab/prove-panel-play.ts.
import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { resolve, sep } from "node:path"
import type { Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : fallback }
const out = resolve(arg("--out", process.env.LEASE_OUT ?? "captures/barbara-quickswitch"))
const frames = resolve(out, "frames")
rmSync(frames, { recursive: true, force: true })
mkdirSync(frames, { recursive: true })

type Woods = { frames: number; state: { players: { id: number; x: number; z: number }[] }; panel: { visible: boolean }; camera: { yaw: number }; walkTo(x: number, z: number): void }
declare const woods: Woods

const root = resolve(import.meta.dir, "../dist/arcade/barbara")
const prefix = "/arcade/barbara/"
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  if (!path.startsWith(prefix)) return new Response("no", { status: 404 })
  const file = resolve(root, decodeURIComponent(path.slice(prefix.length)) || "index.html")
  if (!file.startsWith(root + sep)) return new Response("no", { status: 404 })
  const f = Bun.file(file)
  return (await f.exists()) ? new Response(f) : new Response("no", { status: 404 })
} })

await using budget = browserBudget()
const browser = await budget.chromium.launch({ headless: true, timeout: 120000, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const page: Page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
// The camera lab's spot 70 m north of camp, two friends' torches out ahead; it opens the knobs, as a Lab user would.
await page.goto(`http://127.0.0.1:${server.port}${prefix}?quality=high&lab=looks`, { waitUntil: "load" })
await page.waitForFunction(() => (window as unknown as { woods?: Woods }).woods && woods.frames > 2 && woods.state.players.filter((p) => p.id >= 100).length >= 2, null, { timeout: 120000 })
await page.waitForTimeout(1500)
await page.evaluate(() => {
  const c = document.createElement("div")
  c.id = "proof-caption"
  c.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;padding:8px 14px;border-radius:10px;background:rgba(0,0,0,.72);color:#fff;font:600 15px system-ui;pointer-events:none"
  document.body.append(c)
})
const caption = (text: string) => page.evaluate((t) => { document.getElementById("proof-caption")!.textContent = t }, text)
const state = () => page.evaluate(() => ({ locked: Boolean(document.pointerLockElement), panel: woods.panel.visible, toast: document.querySelector("[data-lab-quickswitch] .lqs-main")?.textContent ?? "" }))
const steps: Record<string, unknown>[] = []
const note = async (step: string) => { steps.push({ step, ...(await state()) }) }

let stop = false, n = 0
const t0 = Date.now()
const capture = (async () => {
  while (!stop) await page.screenshot({ path: resolve(frames, `${String(n++).padStart(4, "0")}.jpg`), type: "jpeg", quality: 85, timeout: 60_000 })
})()
const wait = (ms: number) => page.waitForTimeout(ms)
const press = async (code: string, ms = 1400) => { await page.keyboard.press(code); await wait(ms) }

await caption("The knobs open on Looks")
await wait(1500)
await caption("` closes them: straight back to the woods")
await press("Backquote", 1400)
await note("back to the woods in one key")
await caption("Walking · ] steps the Look")
// Walk on, 45 m along the view.
await page.evaluate(() => { const p = woods.state.players[0]!, y = woods.camera.yaw; woods.walkTo(p.x - Math.sin(y) * 45, p.z - Math.cos(y) * 45) })
for (let i = 0; i < 4; i++) { await press("BracketRight", 1700); await note(`look ${i + 1}`) }
await caption("\\ flips back to the one before, and forward again")
await press("Backslash", 1500)
await note("back")
await press("Backslash", 1500)
await note("forward")
await caption("' picks the camera looks · ] steps them")
await press("Quote", 1200)
for (let i = 0; i < 4; i++) { await press("BracketRight", 1600); await note(`camera ${i + 1}`) }
await press("Backslash", 1500)
await note("camera back")
await wait(1800)
stop = true
await capture
const seconds = (Date.now() - t0) / 1000
await budget.finish()
server.stop(true)

const fps = Math.max(1, Math.round((n / seconds) * 100) / 100)
const path = resolve(out, "quickswitch.mp4")
execFileSync("ffmpeg", ["-v", "error", "-y", "-framerate", String(fps), "-i", resolve(frames, "%04d.jpg"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "24", "-movflags", "+faststart", path])
rmSync(frames, { recursive: true, force: true })
const report = { clip: path, frames: n, seconds, fps, steps, errors }
writeFileSync(resolve(out, "quickswitch.json"), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
