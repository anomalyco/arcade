// Headless audio walk: records the game's final mix while the player walks from the parking lot through the
// entrance into the lobby, (cut) up the core stair to storey 1, (cut) to the lift lobby, calls the lift, steps in and
// rides it up (opening and shutting the stair door on the way). Writes captures/audio-walk/walk.mp3 (and .webm) and prints what played, what was skipped (not yet
// decoded), the horror events and any page errors. Expects the dev server on :5196. Headless Chromium runs with
// --mute-audio, so nothing is heard while it records (MediaRecorder taps the mix before the output).
//
//   bun scripts/audio-walk.ts [--out dir]
import { chromium, type Page } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"

const args = process.argv.slice(2)
const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1]! : `${import.meta.dir}/../captures/audio-walk`
mkdirSync(outDir, { recursive: true })

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"],
})
const page: Page = await browser.newPage({ viewport: { width: 960, height: 600 } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
await page.routeWebSocket(/.*/, () => {})
// A thunder early and one horror event inside the recording, so both are heard (automation-only parameters).
await page.goto("http://localhost:5196/?view=entrance&thunder=6&horror=24")
await page.waitForFunction(() => {
  const s = (globalThis as { __afterhours?: { ready: boolean; complete: boolean } }).__afterhours
  return !!s?.complete && s.ready
}, null, { timeout: 300_000 })

const evalP = <T>(body: string) => page.evaluate(`(async () => { const p = globalThis.__afterhoursPlayer; const A = globalThis.__afterhoursAudio; ${body} })()`) as Promise<T>
const pos = () => evalP<{ x: number; y: number; z: number }>("return { ...p.pos }")
const place = (x: number, y: number, z: number, yaw: number) =>
  evalP(`p.pos.x = ${x}; p.pos.y = ${y}; p.pos.z = ${z}; p.yaw = ${yaw}; p.pitch = 0; p.resetMotion()`)

// Unlock with a key (a user gesture), let the one-shots decode.
await page.keyboard.press("KeyQ")
await page.waitForTimeout(3000)
await evalP(`
  const stream = A.tap()
  const rec = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 160000 })
  globalThis.__chunks = []
  rec.ondataavailable = (e) => globalThis.__chunks.push(e.data)
  rec.start(1000)
  globalThis.__rec = rec
`)
const t0 = Date.now()
const mark = (what: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s  ${what}`)

async function hold(keys: string[], until: (p: { x: number; y: number; z: number }) => boolean, ms: number) {
  for (const k of keys) await page.keyboard.down(k)
  const s = Date.now()
  while (!until(await pos()) && Date.now() - s < ms) await page.waitForTimeout(40)
  for (const k of keys) await page.keyboard.up(k)
}

// A: the lot to the lobby, through the open entrance doors (wet asphalt, then the lobby floor).
mark("lot → entrance (pushing the glass doors) → lobby")
await place(0, 0.5, 40, 0)
await page.waitForTimeout(800)
await hold(["KeyW"], (p) => p.z < 11, 18_000)
await page.waitForTimeout(800)

// B: (cut) the core stair, ground floor to storey 1.
mark("stairs: ground floor → storey 1")
await place(-42.28, 0.3, 17.2, Math.PI)
await page.waitForTimeout(600)
await hold(["KeyW"], (p) => p.z >= 23.2, 8000)
await evalP("p.yaw = -Math.PI / 2")
await hold(["KeyW"], (p) => p.x >= -40.5, 3000)
await evalP("p.yaw = 0")
await hold(["KeyW"], (p) => p.z <= 17.4, 8000)
// Out through the stair door (E opens it wider), then turn round and shut it behind you (the fire door's latch).
mark("stair door: open, through, close")
const door = () => evalP<string>("const D = globalThis.__afterhoursDoors; return JSON.stringify({ focus: D.focused?.id ?? null, s1: D.get('s1:STAIR')?.amount })")
await evalP("p.pitch = -0.25")
await page.waitForTimeout(300)
mark(`facing the stair door ${await door()}`)
await page.keyboard.press("KeyE")
await page.waitForTimeout(2200)
await hold(["KeyW"], (p) => p.z < 14.4, 4000)
// Turn round and aim at the open leaf (hinged at x −40.44, swung into the hall).
await evalP(`
  const c = globalThis.__afterhoursDoors.centreOf("s1:STAIR")
  const dx = c.x - p.pos.x, dz = c.z - p.pos.z
  p.yaw = Math.atan2(-dx, -dz)
  p.pitch = -Math.atan2(p.pos.y + 1.65 - c.y, Math.hypot(dx, dz))
`)
await page.waitForTimeout(400)
mark(`turned to shut it ${await door()}`)
// The leaf stood ajar (under half open), so the first E swings it open; the second shuts it.
await page.keyboard.press("KeyE")
await page.waitForTimeout(900)
await page.keyboard.press("KeyE")
await page.waitForTimeout(3500)
mark(`after closing ${await door()}`)

// C: (cut) the storey-1 lift lobby: call the lift, wait for it, step in, ride up a floor.
mark("lift lobby: call")
await place(-36.82, 4.0, 18.6, Math.PI)
await page.waitForTimeout(700)
await page.keyboard.press("KeyE")
await page.waitForTimeout(13_500)
mark("step into the car")
// From the call button, across to the doors (centre x −37.85), then in.
await evalP("p.yaw = Math.PI / 2")
await hold(["KeyW"], (p) => p.x < -37.75, 2000)
await evalP("p.yaw = Math.PI")
await hold(["KeyW"], (p) => p.z > 21.3, 3000)
mark(`in the car? ${JSON.stringify(await pos())}`)
await page.waitForTimeout(800)
mark("ride up")
await page.keyboard.press("KeyE")
await page.waitForTimeout(12_000)
mark("end")

const b64 = await evalP<string>(`
  const rec = globalThis.__rec
  await new Promise((r) => { rec.onstop = r; rec.stop() })
  const blob = new Blob(globalThis.__chunks, { type: "audio/webm" })
  const buf = new Uint8Array(await blob.arrayBuffer())
  let s = ""
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  return btoa(s)
`)
const webm = `${outDir}/walk.webm`
writeFileSync(webm, Buffer.from(b64, "base64"))
const mp3 = `${outDir}/walk.mp3`
const ff = Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-i", webm, "-c:a", "libmp3lame", "-q:a", "2", mp3])
const stats = await evalP<unknown>(`return { sfx: A.sfx.stats, steps: A.footsteps.stats, horror: A.horror.log, ctx: A.sfx && (await Promise.resolve(0)) }`)
const probe = Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp3]).stdout.toString().trim()
// Loudness of the recording (so a silent capture is caught).
const loud = Bun.spawnSync(["ffmpeg", "-hide_banner", "-i", mp3, "-af", "ebur128", "-f", "null", "-"]).stderr.toString()
const integrated = /I:\s+(-?[\d.]+) LUFS/.exec(loud.slice(loud.lastIndexOf("Summary")))?.[1]
console.log(JSON.stringify(stats, null, 1))
console.log(`recording: ${mp3} (${probe} s, integrated ${integrated} LUFS, ffmpeg ${ff.exitCode === 0 ? "ok" : "failed"})`)
console.log(errors.length ? `page errors: ${errors.slice(0, 5).join(" | ")}` : "no page errors")
await browser.close()
process.exit(errors.length || ff.exitCode !== 0 ? 1 : 0)
