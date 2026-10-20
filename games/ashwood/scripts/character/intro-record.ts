// Records the real intro cutscene (`?intro`, debug) in first person at 1280×720, real time: a stretch of the drive and
// the door beat, as the player sees it. Also writes a frame strip (one frame per second) for each segment.
//
//   bun scripts/character/intro-record.ts [--tag t] [--drive 25:20] [--door 1] [--char remy]
//     --drive start:secs   intro time to start at and seconds to record (default 25:20)
//     --door 0|1           also record the door beat (default 1)
//
// One browser at a time (a fresh one per segment), closed straight after. Output: captures/character/intro-<tag>.mp4,
// captures/character/intro-<tag>-drive.png / -door.png (frame strips, 4 per row).
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args.splice(i, 2)[1]! : undefined
}
const tag = flag("tag") ?? "run"
const [driveAt, driveSecs] = (flag("drive") ?? "25:20").split(":").map(Number) as [number, number]
const door = (flag("door") ?? "1") === "1"
const char = flag("char") ?? "remy"
/** Extra query (e.g. "introRig" for the rig markers). */
const extraQ = flag("q") ?? ""
const out = `${import.meta.dir}/../../captures/character`
mkdirSync(out, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const errors: string[] = []
const segments: string[] = []

/** The intro's park beat starts at route.duration; the reach at +5.2 s (PARK.reach in src/game/intro/index.ts). */
async function record(name: string, at: number | "door", secs: number) {
  const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await context.newPage()
  page.on("pageerror", (e) => errors.length < 8 && errors.push(e.message))
  page.on("console", (m) => m.type() === "error" && errors.length < 8 && errors.push(m.text().slice(0, 300)))
  await page.routeWebSocket(/.*/, () => {})
  const vdir = `${out}/_rec-${name}`
  rmSync(vdir, { recursive: true, force: true })
  mkdirSync(vdir, { recursive: true })
  const frames: { file: string; t: number }[] = []
  try {
    let startAt = at
    if (at === "door") {
      // Find the route's duration first (no cutscene), then start a little before the hand leaves the wheel.
      await page.goto(`http://localhost:5196/?view=lot&character=${char}`)
      await page.waitForFunction(() => (globalThis as { __ashwood?: { complete: boolean } }).__ashwood?.complete, null, { timeout: 240_000 })
      const dur = await page.evaluate(async () => {
        const url = "/src/game/intro/route.ts"
        const m = await import(url)
        return m.buildRoute().duration as number
      })
      startAt = dur + 3.6
    }
    await page.goto(`http://localhost:5196/?intro&introAt=${startAt}&character=${char}${extraQ ? `&${extraQ}` : ""}`)
    await page.waitForFunction(() => (globalThis as { __ashwood?: { complete: boolean } }).__ashwood?.complete, null, { timeout: 240_000 })
    await page.addStyleTag({ content: "#hud{display:none!important}" })
    // Let the fade-in finish.
    await page.waitForTimeout(2600)
    const cdp = await context.newCDPSession(page)
    cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
      const file = `${vdir}/${String(frames.length).padStart(5, "0")}.jpg`
      frames.push({ file, t: f.metadata.timestamp ?? Date.now() / 1000 })
      void Bun.write(file, Buffer.from(f.data, "base64"))
      void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {})
    })
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, everyNthFrame: 1, maxWidth: 1280, maxHeight: 720 })
    // Fist-vs-target misses (m) sampled through the segment.
    const misses: unknown[] = []
    for (let k = 0; k < secs; k++) {
      await page.waitForTimeout(1000)
      misses.push(await page.evaluate(() => {
        const b = (globalThis as any).__ashwoodBody?.body
        const d = b?.seatRig?.debug
        return d ? [d.Left?.miss, d.Right?.miss, d.Left?.clockDeg, d.Right?.clockDeg] : null
      }))
    }
    console.log(`${name} miss L/R (m), clock L/R:`, JSON.stringify(misses))
    await cdp.send("Page.stopScreencast")
    await Bun.sleep(300)
  } finally {
    await context.close()
    await browser.close()
  }
  if (frames.length < 2) {
    errors.push(`${name}: no frames`)
    return
  }
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(1 / 60, Math.min(0.5, (frames[i + 1]?.t ?? f.t + 1 / 30) - f.t)).toFixed(4)}`).join("\n")
  await Bun.write(`${vdir}/list.txt`, `${list}\nfile '${frames.at(-1)!.file}'\n`)
  const seg = `${vdir}/seg.mp4`
  const p = Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", `${vdir}/list.txt`, "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "22", seg])
  if (p.exitCode !== 0) return void errors.push(p.stderr.toString())
  // Frame strip: one per second (door: two per second), 4 per row, half size.
  const rate = name === "door" ? 2 : 1
  const n = Math.ceil(secs * rate)
  const rows = Math.ceil(n / 4)
  const strip = `${out}/intro-${tag}-${name}.png`
  Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", "-i", seg, "-vf", `fps=${rate},scale=640:-1,tile=4x${rows}`, "-frames:v", "1", strip])
  console.log(strip, `${frames.length} frames, ${(frames.length / secs).toFixed(0)} fps`)
  segments.push(seg)
}

await record("drive", driveAt, driveSecs)
if (door) await record("door", "door", 8)
if (segments.length) {
  const dest = `${out}/intro-${tag}.mp4`
  const list = `${out}/_rec-list.txt`
  await Bun.write(list, segments.map((s) => `file '${s}'`).join("\n") + "\n")
  const p = Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", dest])
  if (p.exitCode !== 0) errors.push(p.stderr.toString())
  else console.log(dest)
  rmSync(list, { force: true })
  for (const s of ["drive", "door"]) rmSync(`${out}/_rec-${s}`, { recursive: true, force: true })
}
console.log(JSON.stringify({ errors }))
