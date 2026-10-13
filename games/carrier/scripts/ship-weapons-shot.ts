// Ship viewer captures for the carrier's weapons (CIWS, SAM launchers, 5-inch gun) on a real GPU. Runs ON hailmary:
// Chrome with WebGPU on Metal loads ship.html from the live dev server and screenshots each preset on the sea backdrop.
//
//   ssh hailmary 'cd /tmp/carrier-shipweapons && ~/.bun/bin/bun ship-weapons-shot.ts --out=/tmp/carrier-shipweapons/out --tag=now'
//
// --presets=HERO,0°,...,TOP,PORT (default: HERO, the 8-yaw ring, TOP, PORT, STARBOARD, BOW), --weapons=0|1 (viewer
// toggle), --close=1 adds orbit close-ups of each weapon mount (camera poses below, in ship space).
import { chromium } from "playwright-core"
import { mkdirSync } from "node:fs"

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const base = opt("base", "https://carrier.lwoyjcaeyxv6.opentunnel.xyz/ship.html")
const out = opt("out", "/tmp/carrier-shipweapons/out")
const tag = opt("tag", "now")
const weapons = opt("weapons", "1")
const [vw, vh] = opt("size", "1536x1024").split("x").map(Number) as [number, number]
const YAWS = ["0°", "45°", "90°", "135°", "180°", "225°", "270°", "315°"]
const presets = opt("presets", ["HERO", ...YAWS, "TOP", "PORT", "STARBOARD", "BOW"].join(",")).split(",").filter(Boolean)
const close = opt("close", "0") === "1"
mkdirSync(out, { recursive: true })

/** Close-up orbit poses: target (ship space), yaw/pitch in degrees (yaw 0 = off the bow, 90 = off port), distance. */
const CLOSE: { name: string; target: [number, number, number]; yaw: number; pitch: number; dist: number }[] = JSON.parse(opt("poses", "[]"))

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--enable-features=WebGPU", "--ignore-gpu-blocklist"],
})
const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
page.on("pageerror", (e) => console.log(`pageerror: ${e.message}`))
page.on("console", (m) => {
  if (m.type() === "error") console.log(`console error: ${m.text().slice(0, 300)}`)
})
// Other agents edit files on the shared dev server: keep Vite's HMR socket from reloading the page mid-run.
await page.addInitScript(() => {
  const Real = WebSocket
  const Fake = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const p = Array.isArray(protocols) ? protocols : protocols ? [protocols] : []
    if (p.some((x) => x.startsWith("vite"))) return Object.assign(new EventTarget(), { readyState: 0, send() {}, close() {} })
    return new Real(url, protocols)
  } as unknown as typeof WebSocket
  Object.assign(Fake, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3, prototype: Real.prototype })
  globalThis.WebSocket = Fake
})

const safe = (s: string) => s.replace("°", "").replace(/[^A-Za-z0-9]+/g, "-")
const q = (preset: string) => `model=procedural&env=sea&ui=0&deck=0&weapons=${weapons}&preset=${encodeURIComponent(preset)}`
await page.goto(`${base}?${q(presets[0] ?? "HERO")}`, { waitUntil: "load" })
await page.waitForFunction(() => (globalThis as { shipViewer?: { ready: boolean } }).shipViewer?.ready, null, { timeout: 90_000 })
await page.waitForTimeout(1500)
// Freeze the radar so every view shows it the same way.
await page.evaluate(() => {
  const sv = (globalThis as unknown as { shipViewer: { settings: { spin: boolean } } }).shipViewer
  sv.settings.spin = false
})
for (const p of presets) {
  await page.evaluate((name) => (globalThis as unknown as { shipViewer: { setPreset(n: string, o: object): void } }).shipViewer.setPreset(name, { instant: true, syncRef: false }), p)
  await page.waitForTimeout(700)
  const file = `${out}/${tag}-${safe(p)}.png`
  await page.screenshot({ path: file })
  console.log(`shot ${file}`)
}
if (close)
  for (const c of CLOSE) {
    await page.evaluate((c) => {
      const v = (globalThis as unknown as { shipViewer: { view: { target: number[]; yaw: number; pitch: number; dist: number; ortho: boolean; preset: string | null } } }).shipViewer.view
      v.target = c.target
      v.yaw = c.yaw
      v.pitch = c.pitch
      v.dist = c.dist
      v.ortho = false
      v.preset = null
    }, c)
    await page.waitForTimeout(700)
    const file = `${out}/${tag}-close-${safe(c.name)}.png`
    await page.screenshot({ path: file })
    console.log(`shot ${file}`)
  }
await browser.close()
