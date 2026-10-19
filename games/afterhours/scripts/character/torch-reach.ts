// Flashlight reach check: first-person views at pitch 0 down the long storey-0 corridor, outdoors facing the treeline
// ~25 m away and on a dark stair landing, each with the torch off and on (rows = places, columns = off / on), plus a
// look-down column for blow-out.
//
//   bun scripts/character/torch-reach.ts [--tag t] [--q "flash.intensity=300"]
//
// Output: captures/character/torch-reach-<tag>.png, tiles in captures/character/torch-reach/.
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync } from "node:fs"

const args = process.argv.slice(2)
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args.splice(i, 2)[1]! : undefined
}
const tag = opt("tag") ?? "run"
const extra = opt("q") ?? ""
const out = `${import.meta.dir}/../../captures/character`
const tiles = `${out}/torch-reach`
mkdirSync(tiles, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
const context = await browser.newContext({ viewport: { width: 960, height: 600 } })
const page = await context.newPage()
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 300)))
await page.routeWebSocket(/.*/, () => {})
await page.goto(`http://localhost:5196/?view=corridor${extra ? `&${extra}` : ""}`)
await page.waitForFunction(() => (globalThis as { __afterhours?: { complete: boolean } }).__afterhours?.complete, null, { timeout: 240_000 })
await page.addStyleTag({ content: "#hud{display:none!important}" })
const ev = <T>(src: string): Promise<T> =>
  page.evaluate((src) => new Function("P", "B", "D", src)((globalThis as Record<string, unknown>).__afterhoursPlayer, (globalThis as Record<string, unknown>).__afterhoursBody, (globalThis as Record<string, unknown>).__afterhoursDebug), src) as Promise<T>
const wait = (ms: number) => page.waitForTimeout(ms)
const place = (x: number, y: number, z: number, yaw: number, pitch = 0) => ev(`P.pos.x=${x};P.pos.y=${y};P.pos.z=${z};P.yaw=${yaw};P.pitch=${pitch};P.resetMotion()`)

const PLACES: { name: string; at: [number, number, number, number] }[] = [
  // Ground-floor main corridor, looking west down its length: the end wall (x = -54.65) is ~29 m ahead.
  { name: "corridor", at: [-26, 0.1, 0.2, Math.PI / 2] },
  // West of the lot facing the woods: the fence (x = -80) ~22 m ahead, the first trees ~26 m.
  { name: "treeline", at: [-58, 0, 75, Math.PI / 2] },
  // The ground-floor stair landing.
  { name: "landing", at: [-41.4, 0.3, 17.2, Math.PI] },
]
const rows: string[][] = []
for (const p of PLACES) {
  const row: string[] = []
  await place(...p.at)
  await wait(900)
  for (const [label, on, pitch] of [
    ["off", false, 0],
    ["on", true, 0],
    ["down", true, -1.2],
  ] as const) {
    await ev(`P.flashlight = ${on}; P.pitch = ${pitch}`)
    await wait(900)
    const f = `${tiles}/${p.name}-${label}.png`
    await page.screenshot({ path: f })
    row.push(f)
  }
  rows.push(row)
}
await context.close()
await browser.close()
const files = rows.flat()
const cols = 3
const inputs = files.flatMap((f) => ["-i", f])
const at = (n: number, s: string) => (n ? Array.from({ length: n }, () => s).join("+") : "0")
const layout = files.map((_, i) => `${at(i % cols, "w0")}_${at(Math.floor(i / cols), "h0")}`).join("|")
const dest = `${out}/torch-reach-${tag}.png`
const r = Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", ...inputs, "-filter_complex", `xstack=inputs=${files.length}:layout=${layout},scale=iw*0.5:-1`, dest])
if (r.exitCode !== 0) errors.push(r.stderr.toString())
else console.log(dest)
console.log(JSON.stringify({ errors }))
