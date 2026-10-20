// First-person flashlight check in the real game at the default grade: for each place (lit tile corridor, a dark
// corridor, outside in fog) the view at pitches 0, −30, −60, −80°, standing, plus walking / crouching / stairs.
//
//   bun scripts/character/torch-shots.ts [--tag t] [--places tile,dark,fog,moves] [--video] [--q "extra=1"]
//
// Output: captures/character/torch-<tag>.png (rows = places, columns = pitches), tiles in captures/character/torch/,
// and with --video captures/character/torch-<tag>.mp4 (a walk with the flashlight).
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args.splice(i, 2)[1]! : undefined
}
const tag = flag("tag") ?? "run"
const places = (flag("places") ?? "tile,dark,fog,moves").split(",")
const extra = flag("q") ?? ""
const video = args.includes("--video")
const out = `${import.meta.dir}/../../captures/character`
const tiles = `${out}/torch`
mkdirSync(tiles, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
const W = 960
const H = 600
const context = await browser.newContext({ viewport: { width: W, height: H } })
const page = await context.newPage()
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 300)))
await page.routeWebSocket(/.*/, () => {})
await page.goto(`http://localhost:5196/?view=corridor${extra ? `&${extra}` : ""}`)
await page.waitForFunction(() => (globalThis as { __afterhours?: { complete: boolean } }).__afterhours?.complete, null, { timeout: 240_000 })
await page.addStyleTag({ content: "#hud{display:none!important}" })
const ev = <T>(src: string): Promise<T> =>
  page.evaluate((src) => new Function("P", "B", src)((globalThis as Record<string, unknown>).__afterhoursPlayer, (globalThis as Record<string, unknown>).__afterhoursBody), src) as Promise<T>
const wait = (ms: number) => page.waitForTimeout(ms)
const place = (x: number, y: number, z: number, yaw: number, pitch = 0) => ev(`P.pos.x=${x};P.pos.y=${y};P.pos.z=${z};P.yaw=${yaw};P.pitch=${pitch};P.resetMotion()`)

const frames: { file: string; t: number }[] = []
const vdir = `${out}/_tvideo`
if (video) {
  rmSync(vdir, { recursive: true, force: true })
  mkdirSync(vdir, { recursive: true })
  const cdp = await context.newCDPSession(page)
  cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    const file = `${vdir}/${String(frames.length).padStart(5, "0")}.jpg`
    frames.push({ file, t: f.metadata.timestamp ?? Date.now() / 1000 })
    void Bun.write(file, Buffer.from(f.data, "base64"))
    void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {})
  })
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, everyNthFrame: 1 })
}

await ev(`P.flashlight = true`)
const PITCHES = [0, -30, -60, -80]
const rows: string[][] = []
async function pitches(name: string) {
  const row: string[] = []
  for (const p of PITCHES) {
    await ev(`P.pitch=${(p * Math.PI) / 180}`)
    await wait(700)
    const f = `${tiles}/${name}${p}.png`
    await page.screenshot({ path: f })
    row.push(f)
  }
  rows.push(row)
}
const SPOTS: Record<string, () => Promise<void>> = {
  // The lit main corridor on the ground floor (pale tile, waxed linoleum).
  tile: async () => {
    await place(-11, 0.1, 0.2, Math.PI / 2)
    await wait(600)
    await pitches("tile")
  },
  // A dark spot indoors: the core hall with its lights off is not guaranteed, so the ground-floor stair landing.
  dark: async () => {
    await place(-41.4, 0.3, 17.2, Math.PI)
    await wait(600)
    await pitches("dark")
  },
  // Outside in the fog on the parking lot.
  fog: async () => {
    await place(-30, 0, 112, 0.4)
    await wait(900)
    await pitches("fog")
  },
  // Walking, crouch-walking and walking down the stairs, looking down 45° and 75°.
  moves: async () => {
    const row: string[] = []
    const shoot = async (n: string) => {
      const f = `${tiles}/${n}.png`
      await page.screenshot({ path: f })
      row.push(f)
    }
    await place(-16, 0.1, 0.2, Math.PI / 2, -0.8)
    await page.keyboard.down("KeyW")
    await wait(1500)
    await shoot("walk-45")
    await ev(`P.pitch=-1.3`)
    await wait(700)
    await shoot("walk-75")
    await page.keyboard.down("KeyC")
    await wait(1200)
    await shoot("crouchwalk-75")
    await page.keyboard.up("KeyC")
    await ev(`P.pitch=-0.25`)
    await page.keyboard.down("ShiftLeft")
    await wait(1000)
    await shoot("run-15")
    await page.keyboard.up("ShiftLeft")
    await page.keyboard.up("KeyW")
    await place(-40.5, 3.9, 17.6, Math.PI, -0.9)
    await wait(400)
    await page.keyboard.down("KeyW")
    await wait(1700)
    await shoot("stairs-down")
    await page.keyboard.up("KeyW")
    rows.push(row)
  },
}
for (const p of places) {
  try {
    await SPOTS[p]?.()
  } catch (e) {
    errors.push(`${p}: ${e instanceof Error ? e.message : e}`)
  }
}
if (video) {
  // A walk down the corridor with the flashlight, glancing down and back up.
  await place(-11, 0.1, 0.2, Math.PI / 2, -0.2)
  await page.keyboard.down("KeyW")
  for (let i = 0; i < 90; i++) {
    await ev(`P.pitch=${-0.2 - 0.9 * Math.max(0, Math.sin(i / 14))}; P.yaw=${Math.PI / 2 + 0.25 * Math.sin(i / 23)}`)
    await wait(60)
  }
  await page.keyboard.up("KeyW")
}
await context.close()
await browser.close()
if (video && frames.length > 1) {
  await Bun.sleep(300)
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(1 / 60, Math.min(0.5, (frames[i + 1]?.t ?? f.t + 1 / 30) - f.t)).toFixed(4)}`).join("\n")
  await Bun.write(`${vdir}/list.txt`, `${list}\nfile '${frames.at(-1)!.file}'\n`)
  const dest = `${out}/torch-${tag}.mp4`
  const p = Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", `${vdir}/list.txt`, "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "24", dest])
  if (p.exitCode === 0) {
    rmSync(vdir, { recursive: true, force: true })
    console.log(dest)
  } else errors.push(p.stderr.toString())
}
const files = rows.flat()
if (files.length) {
  const cols = 4
  const inputs = files.flatMap((f) => ["-i", f])
  const at = (n: number, s: string) => (n ? Array.from({ length: n }, () => s).join("+") : "0")
  const layout = files.map((_, i) => `${at(i % cols, "w0")}_${at(Math.floor(i / cols), "h0")}`).join("|")
  const dest = `${out}/torch-${tag}.png`
  const p = Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", ...inputs, "-filter_complex", `xstack=inputs=${files.length}:layout=${layout}${files.length % cols ? ":fill=black" : ""},scale=iw*0.5:-1`, dest])
  if (p.exitCode !== 0) errors.push(p.stderr.toString())
  else console.log(dest)
}
console.log(JSON.stringify({ errors }))
