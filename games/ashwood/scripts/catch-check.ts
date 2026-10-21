// Hunter catch → kill transition, frame by frame (play mode, chapter after-reveal). The player stands in the storey-3
// spine facing the hunter ("face") or with their back to it ("behind"); the hunter is started 12 m west and called
// with a noise at the player. Every rendered frame logs which Wendigo bodies are drawn (the roaming hunter's, any
// kill body), where, and whether each is inside the view. Records the page; cuts captures/catch-<kind>.mp4 and a strip
// of the transition (from 1 s before the catch), and prints the per-frame trace around it.
//
//   bun scripts/catch-check.ts face|behind [--base http://localhost:5196/]
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs"

const args = process.argv.slice(2)
const kind = args.find((a) => a === "face" || a === "behind") ?? "face"
const base = args.includes("--base") ? args[args.indexOf("--base") + 1]! : "http://localhost:5196/"
const tag = args.includes("--tag") ? args[args.indexOf("--tag") + 1]! : ""
const out = `${import.meta.dir}/../captures`
mkdirSync(out, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: out, size: { width: 1280, height: 720 } } })
const t0 = Date.now()
const page = await ctx.newPage()
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
type Any = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const S3 = 0.16 + 3 * 3.8
let catchAt = 0
try {
  await page.goto(`${base}?play&start=after-reveal`)
  await page.waitForFunction(() => (globalThis as Any).__ashwood?.complete, null, { timeout: 240_000 })
  await page.waitForTimeout(1500)
  if ((await page.evaluate(() => (globalThis as Any).__static?.flow.phase)) === "menu") await page.click("text=Play")
  await page.waitForFunction(() => (globalThis as Any).__static?.flow.phase === "explore" && (globalThis as Any).__ashwoodHunter, null, { timeout: 60_000 })
  await page.waitForTimeout(2000)
  // Player in the spine at x = 8, facing west (face) or east (behind). The hunter: wait out its grace, then start it
  // 12 m west and call it with a noise at the player.
  await page.evaluate(
    ([y, yaw]) => {
      const p = (globalThis as Any).__ashwoodPlayer
      p.pos.x = 8
      p.pos.y = y
      p.pos.z = 0
      p.resetMotion()
      p.yaw = yaw
      p.pitch = 0
    },
    [S3 + 0.02, kind === "face" ? Math.PI / 2 : -Math.PI / 2],
  )
  await page.waitForFunction(() => ((globalThis as Any).__ashwoodHunter?.hunter.grace ?? 0) <= 0, null, { timeout: 20_000 })
  // Per-frame trace (installed before the hunter starts).
  await page.evaluate(() => {
    const g = globalThis as Any
    const trace: Any[] = []
    g.__catchTrace = trace
    const cam = g.__ashwoodPlayer.camera ?? null
    void cam
    const t00 = performance.now()
    const step = () => {
      const h = g.__ashwoodHunter?.hunter
      const k = g.__ashwoodAmbush?.creature?.()
      const camera = g.__ashwoodDebug?.camera ?? g.__ashwoodCamera
      const rec: Any = { t: +((performance.now() - t00) / 1000).toFixed(3), mode: h?.mode, hold: g.__static?.flow.hold, modal: document.body.dataset.modal ?? "" }
      for (const [name, body] of [
        ["hunt", h?.creature],
        ["kill", k],
      ] as const) {
        if (!body || body === (name === "kill" ? h?.creature : null)) continue
        const r = body.root
        const vis = r.visible && (r.parent ? true : false)
        rec[name] = { vis, x: +r.position.x.toFixed(2), z: +r.position.z.toFixed(2) }
        if (camera && vis) {
          const hips = body.rig?.byName.get("hips")
          const v = hips.getWorldPosition(new r.position.constructor())
          const d = v.distanceTo(camera.position)
          v.project(camera)
          rec[name].inView = v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1
          rec[name].d = +d.toFixed(2)
        }
      }
      trace.push(rec)
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
    g.__ashwoodHunter.handle.start(-4, 0, 3)
    const p = g.__ashwoodPlayer.pos
    g.__ashwoodHunter.noise({ x: p.x, y: p.y + 1.6, z: p.z }, 40, "voice")
  })
  await page.waitForFunction(() => (globalThis as Any).__static?.flow.hold === true, null, { timeout: 60_000 })
  catchAt = Date.now() - t0
  await page.waitForFunction(() => document.body.dataset.modal === "death", null, { timeout: 15_000 })
  await page.waitForTimeout(800)
  const trace = (await page.evaluate(() => (globalThis as Any).__catchTrace)) as Any[]
  const i = trace.findIndex((r) => r.hold)
  const win = trace.slice(Math.max(0, i - 25), i + 40)
  writeFileSync(`${out}/catch-${kind}${tag}-trace.json`, JSON.stringify(win, null, 0))
  const fmt = (b: Any) => (b ? `${b.vis ? "drawn" : "hidden"}${b.vis ? (b.inView ? " in view" : " OUT of view") : ""}${b.d !== undefined ? ` ${b.d} m` : ""} @${b.x},${b.z}` : "-")
  for (const r of win.filter((_, k) => k % 3 === 0 || Math.abs(k - Math.min(25, i)) < 6)) console.log(`${r.t.toFixed(3)} ${r.hold ? "KILL" : "    "} ${(r.mode ?? "").padEnd(6)} hunt: ${fmt(r.hunt)} | kill: ${fmt(r.kill)}`)
  // Gaps: frames in the transition where no body is drawn in view.
  const after = trace.slice(Math.max(0, i - 10), i + 30)
  const empty = after.filter((r) => !(r.hunt?.vis && r.hunt?.inView) && !(r.kill?.vis && r.kill?.inView)).length
  const both = after.filter((r) => r.hunt?.vis && r.kill?.vis).length
  console.log(JSON.stringify({ kind, framesAround: after.length, framesWithNoBodyInView: empty, framesWithTwoBodies: both, errors: errors.slice(0, 2) }))
} catch (e) {
  console.log("FAIL", e)
  await page.screenshot({ path: `${out}/catch-${kind}-error.png` }).catch(() => {})
}
const raw = await page.video()!.path()
await ctx.close()
await browser.close()
const base2 = `${out}/catch-${kind}${tag}`
renameSync(raw, `${base2}.webm`)
if (catchAt) {
  const ss = Math.max(0, catchAt / 1000 - 1.2)
  Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-ss", ss.toFixed(2), "-i", `${base2}.webm`, "-t", "3.4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", `${base2}.mp4`])
  Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-i", `${base2}.mp4`, "-t", "2.4", "-vf", "fps=7.5,scale=320:-1,tile=6x3", "-frames:v", "1", `${base2}-strip.png`])
  Bun.spawnSync(["rm", `${base2}.webm`])
  console.log(`strip: ${base2}-strip.png`)
}
