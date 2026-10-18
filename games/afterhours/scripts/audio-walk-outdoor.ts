// Headless outdoor audio walk: records the final mix while the player walks the parking lot towards the gate and the
// trees, stands at the fence looking round, then (cut) walks in through the entrance into the lobby, so the outdoor
// night (src/audio/night.ts) is heard in the open and then muffled by the building. Writes
// captures/audio-walk-outdoor/walk.mp3 (and .webm) and prints the night one-shots that fired, what was skipped and any
// page errors. Expects the dev server on :5196. Headless Chromium runs with --mute-audio (MediaRecorder taps the mix).
//
//   bun scripts/audio-walk-outdoor.ts [--out dir]
import { chromium, type Page } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"

const args = process.argv.slice(2)
const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1]! : `${import.meta.dir}/../captures/audio-walk-outdoor`
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
// The first night one-shot 2 s into the recording; no horror event (automation-only parameters).
await page.goto("http://localhost:5196/?view=entrance&night=5&horror=9999")
await page.waitForFunction(() => {
  const s = (globalThis as { __afterhours?: { ready: boolean; complete: boolean } }).__afterhours
  return !!s?.complete && s.ready
}, null, { timeout: 300_000 })

const evalP = <T>(body: string) => page.evaluate(`(async () => { const p = globalThis.__afterhoursPlayer; const A = globalThis.__afterhoursAudio; ${body} })()`) as Promise<T>
const pos = () => evalP<{ x: number; y: number; z: number }>("return { ...p.pos }")
const place = (x: number, y: number, z: number, yaw: number) =>
  evalP(`p.pos.x = ${x}; p.pos.y = ${y}; p.pos.z = ${z}; p.yaw = ${yaw}; p.pitch = 0; p.resetMotion()`)

await page.keyboard.press("KeyQ")
await page.waitForTimeout(3000)
await place(0, 0.5, 64, Math.PI)
await page.waitForTimeout(500)
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

mark("parking lot → down the access lane to the gate and the trees")
await hold(["KeyW"], (p) => p.z > 116, 40_000)
mark(`at the fence ${JSON.stringify(await pos())}: standing, looking round`)
for (let i = 0; i < 8; i++) {
  await evalP(`p.yaw += Math.PI / 4`)
  await page.waitForTimeout(2000)
}
mark("(cut) entrance → lobby")
await place(0, 0.5, 30, 0)
await page.waitForTimeout(500)
await hold(["KeyW"], (p) => p.z < 12, 14_000)
await page.waitForTimeout(8000)
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
const stats = await evalP<unknown>(`return { night: A.ambience.night.log, sfx: A.sfx.stats }`)
const probe = Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp3]).stdout.toString().trim()
const loud = Bun.spawnSync(["ffmpeg", "-hide_banner", "-i", mp3, "-af", "ebur128", "-f", "null", "-"]).stderr.toString()
const integrated = /I:\s+(-?[\d.]+) LUFS/.exec(loud.slice(loud.lastIndexOf("Summary")))?.[1]
console.log(JSON.stringify(stats, null, 1))
console.log(`recording: ${mp3} (${probe} s, integrated ${integrated} LUFS, ffmpeg ${ff.exitCode === 0 ? "ok" : "failed"})`)
console.log(errors.length ? `page errors: ${errors.slice(0, 5).join(" | ")}` : "no page errors")
await browser.close()
process.exit(errors.length || ff.exitCode !== 0 ? 1 : 0)
