// Flight feel clip on a real GPU (src/flight/feel.ts). Runs ON hailmary: Chrome with WebGPU on Metal loads a dev
// server's weapons harness (weapons.html, airborne behind a drone) and records the page, DOM overlays included, through
// a scripted run: a hard roll into a turn, a sustained high-g pull (grey-out), a gun burst, a missile, and a pull in
// the cockpit. Writes <out>/feel.webm (convert with ffmpeg).
//
//   ssh -R 5197:localhost:5197 hailmary 'cd <copy>/games/carrier && ~/.bun/bin/bun scripts/feel-shot.ts --out=/tmp/feel'
//
// Options: --base=URL (default the local dev server)  --size=1280x720
import { renameSync, mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"

await using budget = browserBudget()
const { chromium } = budget

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const base = opt("base", "http://localhost:5197/")
const out = opt("out", "/tmp/carrier-feel")
const [vw, vh] = opt("size", "1280x720").split("x").map(Number) as [number, number]
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--enable-features=WebGPU", "--ignore-gpu-blocklist", "--mute-audio"],
})
const context = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1, recordVideo: { dir: out, size: { width: vw, height: vh } } })
const page = await context.newPage()
page.on("pageerror", (e) => console.log(`pageerror: ${e.message}`))
await page.goto(`${base}weapons.html?air&drone=1&tod=10&weather=clear`, { waitUntil: "load" })
await page.waitForFunction(() => !!(globalThis as unknown as { carrier?: { weapons?: unknown } }).carrier?.weapons, null, { timeout: 60_000 })
await page.waitForTimeout(2500)

const run = (js: string) => page.evaluate(js)
const stick = (pitch: number, roll: number) => run(`carrier.input.override = { pitch: ${pitch}, roll: ${roll} }`)
const caption = (text: string) =>
  run(`(() => {
    let el = document.getElementById("feel-cap")
    if (!el) {
      el = document.createElement("div")
      el.id = "feel-cap"
      el.style.cssText = "position:fixed;left:28px;top:52px;z-index:99;font:300 15px 'IBM Plex Mono',monospace;letter-spacing:.3em;color:#f4f7fb;text-shadow:0 1px 8px rgba(0,0,0,.6)"
      document.body.append(el)
    }
    el.textContent = ${JSON.stringify(text)}
  })()`)
const g = () => page.evaluate(() => {
  const c = (globalThis as unknown as { carrier: { flight: { draw: { g: number }; cam: { feel: { grey: number } } } } }).carrier
  return `g ${c.flight.draw.g.toFixed(1)} grey ${c.flight.cam.feel.grey.toFixed(2)}`
})

await run("carrier.behind(100, 600)")
await stick(0, 0)
await caption("CHASE")
await page.waitForTimeout(1200)

await caption("HARD ROLL INTO A TURN")
await stick(0, 1)
await page.waitForTimeout(650)
await stick(0.55, 0)
await page.waitForTimeout(1600)
console.log("turn", await g())

await caption("HIGH-G PULL")
await stick(1, 0)
await page.waitForTimeout(3600)
console.log("pull", await g())
await caption("UNLOAD")
await stick(0, 0)
await page.waitForTimeout(1600)

await run("carrier.behind(100, 450)")
await caption("GUN")
await page.waitForTimeout(500)
await run("carrier.winput.trigger = true")
await page.waitForTimeout(1500)
await run("carrier.winput.trigger = false")
await page.waitForTimeout(600)

await caption("MISSILE")
await page.keyboard.press("Digit2")
await page.waitForTimeout(1200)
await run("carrier.winput.trigger = true")
await page.waitForTimeout(150)
await run("carrier.winput.trigger = false")
await page.waitForTimeout(2200)

await caption("COCKPIT  HIGH-G PULL")
await page.keyboard.press("Digit1")
await page.keyboard.press("KeyC")
await stick(0, 0)
await page.waitForTimeout(800)
await stick(1, 0.15)
await page.waitForTimeout(3200)
console.log("cockpit pull", await g())
await stick(0, 0)
await page.waitForTimeout(800)
await run("carrier.winput.trigger = true")
await page.waitForTimeout(1000)
await run("carrier.winput.trigger = false")
await page.waitForTimeout(800)

await page.close()
await context.close()
const video = readdirSync(out).find((f) => f.endsWith(".webm") && f !== "feel.webm")
if (video) renameSync(join(out, video), join(out, "feel.webm"))
console.log(`wrote ${join(out, "feel.webm")}`)
