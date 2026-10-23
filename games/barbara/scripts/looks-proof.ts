// Headless, muted stills of every curated Look at one spot and time, a near strike at its peak, and rough GPU cost of
// Downpour at High and Low (run after `bun run build`, through HiveMind browser):
//   bun scripts/looks-proof.ts [--out <dir>] [--size 1600x900] [--looks id,id] [--no-perf]
// The spot is the camera lab's (70 m north of camp, your torch and two friends'), on a synthetic clock. Scheduled
// strikes are held off for the Look stills so each is comparable; Storm coming is taken at the peak of a far strike.
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve, sep } from "node:path"
import type { Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : fallback }
const out = resolve(arg("--out", process.env.LEASE_OUT ?? "captures/barbara-looks"))
const [w, h] = arg("--size", "1600x900").split("x").map(Number) as [number, number]
const only = arg("--looks", "")
const perf = !process.argv.includes("--no-perf")

type Woods = {
  frames: number; paused: boolean; autoplay: boolean
  step(ms: number): void
  setPose(x: number, z: number, yaw: number, pitch?: number): void
  looks: { pick(id: string): void; ids: readonly string[] }
  storm: { settings: Record<string, number | string>; settle(): void; strike(at: string): void; strikes: { live: readonly { t: number }[]; clock: number } }
  trigger(what: string): void
  world: { camp: { x: number; z: number } }
  state: { players: { id: number; x: number; z: number; yaw: number }[]; brains: { id: number; mode: string; timer: number; heading: number; sweep: number }[] }
  settings: Record<string, number>
  camera: { flashlight: boolean }
  quality: { setMode(mode: string, save?: boolean): void }
  measure(n?: number): Promise<{ median: number } | null>
  stats(): Record<string, number | string>
}
declare const woods: Woods

mkdirSync(out, { recursive: true })
const root = resolve("dist/arcade/barbara")
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
const page: Page = await browser.newPage({ viewport: { width: w, height: h } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
await page.goto(`http://127.0.0.1:${server.port}${prefix}?quality=high&lab=looks`, { waitUntil: "load" })
await page.waitForFunction(() => (window as unknown as { woods?: Woods }).woods && woods.frames > 2 && woods.state.players.filter((p) => p.id >= 100).length >= 2, null, { timeout: 120000 }).catch((e) => { console.log(errors.join("\n")); throw e })
// The camera lab spot, staged by `?lab=looks`; the panel closed for clean stills, the sim on the synthetic clock.
const spot = await page.evaluate(() => {
  woods.paused = true
  const p = woods.state.players[0]!
  ;(woods as unknown as { panel: { visible: boolean; toggle(): void } }).panel.visible && (woods as unknown as { panel: { toggle(): void } }).panel.toggle()
  return { x: p.x, z: p.z, yaw: p.yaw }
})
// Only the picture: no key strip, prompt, story card or subtitles.
await page.addStyleTag({ content: "body > *:not(#view) { visibility: hidden !important; }" })
const settle = async (n: number) => page.evaluate(async (n) => {
  for (let i = 0; i < n; i++) { woods.step(1000 / 60); if (i % 5 === 4) await new Promise((r) => setTimeout(r, 0)) }
}, n)
const shoot = async (name: string) => {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  await page.screenshot({ path: `${out}/${name}.png` })
  console.log("shot", name)
}
/** Pick a Look at the spot with scheduled strikes held off, rain and wet ground settled. */
const lookAt = async (id: string) => {
  await page.evaluate(({ id, spot }) => {
    woods.looks.pick(id)
    woods.storm.settings.strikes = 0
    woods.storm.settle()
    woods.setPose(spot.x, spot.z, 0.08, -0.07)
    woods.camera.flashlight = true
  }, { id, spot })
  await settle(150)
}
/** Steps to just after a strike's return stroke (its leader is 0.1 s): the first frames of the flash. */
const strikePeak = async (at: string) => {
  await page.evaluate((at) => woods.storm.strike(at), at)
  // 0.1 s leader + a couple of frames into the first stroke.
  await page.evaluate(async () => { for (let i = 0; i < 7; i++) woods.step(1000 / 60) })
  const t = await page.evaluate(() => ({ clock: woods.storm.strikes.clock, strikes: woods.storm.strikes.live.map((k) => k.t) }))
  console.log("strike", at, JSON.stringify(t))
}

const ids = (await page.evaluate(() => [...woods.looks.ids])).filter((id) => !only || only.split(",").includes(id))
const timing: Record<string, number> = {}
for (const id of ids) {
  const t0 = Date.now()
  await lookAt(id)
  if (id === "stormcoming") await strikePeak("far")
  await shoot(`look-${id}`)
  timing[id] = Date.now() - t0
}
// The near strike at its peak, in Downpour.
if (!only || only.includes("downpour")) {
  await lookAt("downpour")
  await settle(30)
  await strikePeak("near")
  await shoot("strike-near-peak")
  await settle(150)
  await shoot("strike-near-after")
}
const gpu: Record<string, number | null> = {}
if (perf) {
  for (const tier of ["high", "low"]) {
    await page.evaluate((tier) => woods.quality.setMode(tier, false), tier)
    for (const id of ["today", "downpour"]) {
      await lookAt(id)
      gpu[`${id}-${tier}`] = await page.evaluate(async () => (await woods.measure(12))?.median ?? null)
      console.log("gpu", id, tier, gpu[`${id}-${tier}`])
    }
  }
}
writeFileSync(`${out}/looks.json`, JSON.stringify({ spot, timing, gpu, errors: errors.slice(0, 20) }, null, 2))
if (errors.length) console.log("browser messages:", errors.slice(0, 10))
server.stop(true)
await budget.finish()
