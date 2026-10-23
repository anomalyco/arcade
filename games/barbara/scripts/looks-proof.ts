// Headless, muted stills of every curated Look at one spot and time, a near strike at its peak, and rough GPU cost of
// Downpour at High and Low (run after `bun run build`, through HiveMind browser):
//   bun scripts/looks-proof.ts [--out <dir>] [--size 1600x900] [--looks id,id] [--no-perf] [--probe] [--sweep look:k=v,k=v;k=v]
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
/** View pitch for every Look (rad): level, so the ground, the trunks and the canopy gaps above share the frame. */
const PITCH = 0.02

type Woods = {
  frames: number; paused: boolean; autoplay: boolean
  step(ms: number): void
  setPose(x: number, z: number, yaw: number, pitch?: number): void
  looks: { pick(id: string): void; ids: readonly string[] }
  storm: { settings: Record<string, number | string>; settle(): void; strike(at: string): void; strikes: { live: readonly { t: number }[]; clock: number }; last: { view: { flash: number; flashSky: number } } | null }
  trigger(what: string): void
  world: { camp: { x: number; z: number }; buildings: { kind: string; rect: number[] }[] }
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
  await page.evaluate(({ id, spot, PITCH }) => {
    woods.looks.pick(id)
    woods.storm.settings.strikes = 0
    woods.storm.settle()
    woods.setPose(spot.x, spot.z, 0.08, PITCH)
    woods.camera.flashlight = true
  }, { id, spot, PITCH })
  await settle(150)
}
/** Steps frame by frame through the leader to the flash's peak (the first frame after which it dims). */
const strikePeak = async (at: string) => {
  await page.evaluate((at) => woods.storm.strike(at), at)
  const t = await page.evaluate(() => {
    const flash = () => woods.storm.last?.view.flash ?? 0
    let prev = 0, frames = 0
    for (; frames < 90; frames++) {
      woods.step(1000 / 60)
      const now = flash()
      if (prev > 0 && now < prev) break
      prev = now
    }
    return { clock: woods.storm.strikes.clock, frames, flash: flash(), sky: woods.storm.last?.view.flashSky ?? 0 }
  })
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
// `--sweep look:key=v,key=v;key=v`: extra stills of one Look with forest settings overridden, one per `;` group.
const sweep = arg("--sweep", "")
if (sweep) {
  const [id, sets] = sweep.split(":") as [string, string]
  for (const [i, set] of sets.split(";").entries()) {
    await lookAt(id)
    await page.evaluate((kv) => { for (const p of kv.split(",")) { const [k, v] = p.split("="); (woods as unknown as { look: Record<string, unknown> }).look[k!] = isNaN(Number(v)) ? v : Number(v) } }, set)
    await settle(150)
    await shoot(`sweep-${id}-${i}`)
    console.log("sweep", i, set)
  }
}
// Clear moonlit also from the dock, looking south over the lake toward the moon (its glitter path).
if (!only || only.includes("moonlit")) {
  await lookAt("moonlit")
  await page.evaluate(() => {
    const d = woods.world.buildings.find((b) => b.kind === "dock")
    if (d) woods.setPose((d.rect[0] + d.rect[2]) / 2, d.rect[3] - 2, Math.PI, -0.12)
  })
  await settle(150)
  await shoot("look-moonlit-lake")
}
// The near strike at its peak, in Downpour, then the eye 2.5 s later. `--probe` adds the same peak with the rain off
// and with the camera half a metre to the right (to tell weather sprites from forest geometry, and how near a thing is).
if (!only || only.includes("downpour")) {
  await lookAt("downpour")
  await settle(30)
  await strikePeak("near")
  await shoot("strike-near-peak")
  await settle(150)
  await shoot("strike-near-after")
  if (process.argv.includes("--probe")) {
    await page.evaluate(() => { woods.storm.settings.rain = 0; woods.storm.settings.drips = 0; woods.storm.settle() })
    await settle(200)
    await strikePeak("near")
    await shoot("probe-dry-peak")
    await page.evaluate(({ spot, PITCH }) => { woods.storm.settings.rain = 1; woods.storm.settings.drips = 2; woods.storm.settle(); woods.setPose(spot.x + Math.cos(0.08) * 0.5, spot.z - Math.sin(0.08) * 0.5, 0.08, PITCH) }, { spot, PITCH })
    await settle(200)
    await strikePeak("near")
    await shoot("probe-shift-peak")
  }
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
