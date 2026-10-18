// Headless Body B captures (bodyb.html) into captures/bodyb/:
//
//   bun scripts/playerb/shots.ts poses <clip,clip,…> [--cams side,front,3q] [--phases 0,0.25,0.5,0.75] [--tag t]
//     one contact sheet per clip: rows = cameras, columns = phases (clip held at that phase; 0 = left heel strike)
//   bun scripts/playerb/shots.ts run <script> [--cam side] [--speed 0.25] [--frames 8] [--every 120] [--tag t]
//     live frames of a scripted move (blends, transitions, stairs) as a contact sheet
//   bun scripts/playerb/shots.ts video <script> [--cam side] [--secs 6] [--slow 4]
//     a deterministic 30 fps mp4 of a scripted move (lab clock stepped 1/30 s per frame; --slow 4 = 0.25×)
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync } from "node:fs"

const args = process.argv.slice(2)
const flag = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return def
  const v = args[i + 1]!
  args.splice(i, 2)
  return v
}
const tag = flag("tag", "")
const [w, h] = flag("size", "900x900").split("x").map(Number) as [number, number]
const out = `${import.meta.dir}/../../captures/bodyb`
mkdirSync(out, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const mode = args[0]
const what = args[1] ?? ""
const video = mode === "video"
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
const ctx = await browser.newContext({ viewport: { width: w, height: h } })
const page = await ctx.newPage()
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
type B = { ready: boolean; errors: string[]; clips: unknown; body: { setPose(p: unknown): void }; setCam(c: string): void; startScript(n: string | null): void; settings: Record<string, unknown> }
const pitch = flag("pitch", "")
const q = mode === "poses" ? "shot=1&skeleton=0" : `shot=1&script=${what}&cam=${flag("cam", "side")}&speed=${flag("speed", "1")}${pitch ? `&pitch=${pitch}` : ""}${args.includes("--nohud") ? "&hud=0" : ""}`
await page.goto(`http://localhost:5196/bodyb.html?${q}`)
await page.waitForFunction(() => (globalThis as { __bodyB?: B }).__bodyB?.ready, null, { timeout: 90_000 })
await page.waitForTimeout(300)

const sheet = (files: string[], cols: number, name: string, scale = 0.5) => {
  const inputs = files.flatMap((f) => ["-i", f])
  const at = (n: number, s: string) => (n ? Array.from({ length: n }, () => s).join("+") : "0")
  const layout = files.map((_, i) => `${at(i % cols, "w0")}_${at(Math.floor(i / cols), "h0")}`).join("|")
  const p = Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", ...inputs, "-filter_complex", `xstack=inputs=${files.length}:layout=${layout},scale=iw*${scale}:-1`, name])
  if (p.exitCode !== 0) errors.push(p.stderr.toString())
  return name
}

if (mode === "poses") {
  const cams = flag("cams", "side,front,3q").split(",")
  const phases = flag("phases", "0,0.25,0.5,0.75").split(",").map(Number)
  for (const clip of what.split(",")) {
    const files: string[] = []
    for (const c of cams) {
      for (const ph of phases) {
        await page.evaluate(([clip, ph, c]) => {
          const b = (globalThis as unknown as { __bodyB: B }).__bodyB
          b.body.setPose({ clip, phase: ph })
          b.setCam(c as string)
        }, [clip, ph, c] as const)
        await page.waitForTimeout(120)
        const f = `${out}/_${clip}-${c}-${ph}.png`
        await page.screenshot({ path: f })
        files.push(f)
      }
    }
    console.log(sheet(files, phases.length, `${out}/${clip}${tag ? `-${tag}` : ""}.png`))
  }
} else if (mode === "run") {
  const frames = Number(flag("frames", "8"))
  const every = Number(flag("every", "120"))
  await page.evaluate((n) => (globalThis as unknown as { __bodyB: B }).__bodyB.startScript(n), what)
  await page.waitForTimeout(Number(flag("warm", "1500")))
  const files: string[] = []
  for (let i = 0; i < frames; i++) {
    const f = `${out}/_${what}-${i}.png`
    await page.screenshot({ path: f })
    files.push(f)
    await page.waitForTimeout(every)
  }
  const dest = `${out}/run-${what}${tag ? `-${tag}` : ""}.png`
  if (files.length === 1) Bun.spawnSync(["cp", files[0]!, dest])
  else sheet(files, Math.min(frames, 4), dest)
  console.log(dest)
} else if (video) {
  // Deterministic: pause the lab clock and step it 1/30 s per captured frame, then encode at 30 fps.
  const secs = Number(flag("secs", "6"))
  const slow = Number(flag("slow", "1"))
  const dir = `${out}/_video`
  mkdirSync(dir, { recursive: true })
  for (const f of readdirSync(dir)) Bun.spawnSync(["rm", `${dir}/${f}`])
  await page.evaluate((n) => {
    const b = (globalThis as unknown as { __bodyB: B & { pause(): void } }).__bodyB
    b.pause()
    b.startScript(n)
  }, what)
  const frames = Math.round(secs * 30 * slow)
  for (let i = 0; i < frames; i++) {
    await page.evaluate((s) => (globalThis as unknown as { __bodyB: B & { advance(n: number): void; settings: Record<string, unknown> } }).__bodyB.settings["lab.speed"] = s, 1 / slow)
    await page.evaluate(() => (globalThis as unknown as { __bodyB: { advance(n: number): void } }).__bodyB.advance(1))
    await page.waitForFunction(() => (globalThis as unknown as { __bodyB: { pending(): number } }).__bodyB.pending() === 0, null, { timeout: 120_000 })
    await page.waitForTimeout(20)
    await page.screenshot({ path: `${dir}/${String(i).padStart(5, "0")}.png` })
  }
  const name = `${out}/video-${what}${slow !== 1 ? `-x${(1 / slow).toFixed(2)}` : ""}${tag ? `-${tag}` : ""}.mp4`
  const p = Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", "-framerate", "30", "-i", `${dir}/%05d.png`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", name])
  if (p.exitCode !== 0) errors.push(p.stderr.toString())
  console.log(name)
}
const st = await page.evaluate(() => {
  const b = (globalThis as unknown as { __bodyB: B }).__bodyB
  return { errors: b.errors, clips: b.clips, slideAvg: (b as unknown as { slideAvg: number }).slideAvg, slideMax: (b as unknown as { slideMax: number }).slideMax }
})
await ctx.close()
await browser.close()
console.log(JSON.stringify({ errors: [...errors, ...st.errors], slide: mode === "poses" ? undefined : `${st.slideAvg} avg / ${st.slideMax} max cm/s`, clips: process.env.CLIPS ? st.clips : undefined }))
