// Mantles in the real game: test boxes in the lobby (a crate, a bookcase, a high ledge; they exist only in this page,
// as in movement-check) and the 1.25 m loading-dock edge. Each climb runs at 1/5 speed (the controller's clock) and
// is captured at t ≈ 0.2, 0.45, 0.65, 0.85 in first person and from the third-person debug camera; with --video one
// real-speed climb of each is recorded (first person for the lobby, third person for the dock).
//
//   bun scripts/character/mantle-shots.ts [--tag t] [--only crate,bookcase,high,dock] [--video]
//
// One browser, 960×600, closed at the end. Output: captures/character/mantle-<tag>.png (rows: case × view, columns: t),
// tiles in captures/character/mantle/, captures/character/mantle-<tag>.mp4.
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args.splice(i, 2)[1]! : undefined
}
const tag = flag("tag") ?? "run"
const only = flag("only")?.split(",")
const video = args.includes("--video")
const out = `${import.meta.dir}/../../captures/character`
const tiles = `${out}/mantle`
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
try {
  await page.goto(`http://localhost:5196/?view=lobby`)
  await page.waitForFunction(() => (globalThis as { __ashwood?: { complete: boolean } }).__ashwood?.complete, null, { timeout: 240_000 })
  await page.addStyleTag({ content: "#hud{display:none!important}" })
  const ev = <T>(src: string): Promise<T> =>
    page.evaluate((src) => new Function("P", "B", src)((globalThis as Record<string, unknown>).__ashwoodPlayer, (globalThis as Record<string, unknown>).__ashwoodBody), src) as Promise<T>
  const wait = (ms: number) => page.waitForTimeout(ms)
  // The controller's clock scale (the body reads mantle.t, so it follows).
  await ev(`const u = P.update.bind(P); P.__k = 1; P.update = (dt) => u(dt * P.__k)`)

  type Case = { name: string; setup: string; pitch: number; third: number }
  // Lobby test boxes north of (0, 14.1), as movement-check; the dock: walk at its north edge from the yard.
  const CASES: Case[] = [
    { name: "crate", setup: `F = P.pos.y; P.__rm = B.testBox([-0.4, F, 12.6], [0.4, F + 0.7, 13.4]); P.flashlight = true`, pitch: -0.35, third: 2.2 },
    { name: "bookcase", setup: `F = P.pos.y; P.__rm = B.testBox([-0.5, F, 13.0], [0.5, F + 1.0, 13.4])`, pitch: -0.25, third: 2.2 },
    { name: "high", setup: `F = P.pos.y; P.__rm = B.testBox([-0.6, F, 12.4], [0.6, F + 1.35, 13.4])`, pitch: -0.15, third: 2.4 },
    { name: "dock", setup: ``, pitch: -0.2, third: 2.8 },
  ]
  const start = async (c: Case) => {
    if (c.name === "dock") {
      // The dock's north (yard) face: the collider whose top is ~1.25 m near (-30, -31).
      const p = await ev<{ x: number; z: number; y: number } | null>(`
        let best = null
        for (const b of P.ctx.colliders) { const top = b.max[1]; if (Math.abs(top - 1.25 - Math.min(b.min[1], 0.2)) > 0.15 && Math.abs(top - 1.25) > 0.15) continue
          if (b.max[0] < -36 || b.min[0] > -24 || b.min[2] > -20 || b.min[2] < -40) continue
          if (!best || b.min[2] < best.min[2]) best = b }
        return best && { x: -27, z: best.min[2] - 0.5, y: best.min[1] }`)
      if (!p) throw new Error("dock face not found")
      await ev(`P.pos.x=${p.x};P.pos.y=0.5;P.pos.z=${p.z};P.yaw=Math.PI;P.pitch=${c.pitch};P.resetMotion();P.flashlight=true`)
    } else {
      await ev(`P.pos.x=0;P.pos.y=0.3;P.pos.z=14.1;P.yaw=0;P.pitch=${c.pitch};P.resetMotion();P.flashlight=false`)
      await wait(150)
      await ev(`let F; ${c.setup}; P.__boxes = 1`)
    }
    await wait(500)
  }
  const cleanup = async (c: Case) => {
    if (c.name !== "dock") await ev(`P.__rm?.(); P.__rm = null`)
  }
  const T = [0.2, 0.45, 0.65, 0.85]
  const rows: string[][] = []
  for (const c of CASES) {
    if (only && !only.includes(c.name)) continue
    const fp: string[] = []
    const tp: string[] = []
    await start(c)
    await ev(`P.__k = 0.2`)
    await page.keyboard.press("Space")
    let seen = false
    for (const t of T) {
      const ok = await page
        .waitForFunction((t) => {
          const m = (globalThis as unknown as { __ashwoodPlayer: { state: { mantle: { t: number } | null } } }).__ashwoodPlayer.state.mantle
          return m && m.t >= t
        }, t, { timeout: 8000 })
        .then(() => true)
        .catch(() => false)
      if (!ok) break
      seen = true
      await ev(`P.__k = 0`)
      await wait(120)
      const f = `${tiles}/${c.name}-${t}`
      await page.screenshot({ path: `${f}-fp.png` })
      fp.push(`${f}-fp.png`)
      await ev(`B.settings["body.view"]=1;B.settings["body.thirdDist"]=${c.third}`)
      await wait(120)
      await page.screenshot({ path: `${f}-third.png` })
      tp.push(`${f}-third.png`)
      await ev(`B.settings["body.view"]=0; P.__k = 0.2`)
    }
    await ev(`P.__k = 1`)
    await wait(800)
    const st = await ev<{ y: number; state: string }>(`return { y: P.pos.y, state: B.body.debug.state }`)
    console.log(`${c.name}: mantle ${seen ? "seen" : "NOT started"}, ended at y ${st.y.toFixed(2)} (${st.state})`)
    if (fp.length) rows.push(fp, tp)
    await cleanup(c)
  }

  if (video) {
    const frames: { file: string; t: number }[] = []
    const vdir = `${out}/_mvideo`
    rmSync(vdir, { recursive: true, force: true })
    mkdirSync(vdir, { recursive: true })
    const cdp = await context.newCDPSession(page)
    cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
      const file = `${vdir}/${String(frames.length).padStart(5, "0")}.jpg`
      frames.push({ file, t: f.metadata.timestamp ?? Date.now() / 1000 })
      void Bun.write(file, Buffer.from(f.data, "base64"))
      void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {})
    })
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 80, everyNthFrame: 1 })
    for (const [name, third] of [["bookcase", false], ["high", false], ["dock", true], ["dock", false]] as const) {
      const c = CASES.find((x) => x.name === name)!
      await start(c)
      if (third) await ev(`B.settings["body.view"]=1;B.settings["body.thirdDist"]=${c.third}`)
      await wait(400)
      await page.keyboard.press("Space")
      await wait(2200)
      await ev(`B.settings["body.view"]=0`)
      await cleanup(c)
    }
    await cdp.send("Page.stopScreencast")
    await Bun.sleep(300)
    const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(1 / 60, Math.min(0.5, (frames[i + 1]?.t ?? f.t + 1 / 30) - f.t)).toFixed(4)}`).join("\n")
    await Bun.write(`${vdir}/list.txt`, `${list}\nfile '${frames.at(-1)!.file}'\n`)
    const dest = `${out}/mantle-${tag}.mp4`
    const p = Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", `${vdir}/list.txt`, "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "25", dest])
    if (p.exitCode === 0) {
      rmSync(vdir, { recursive: true, force: true })
      console.log(dest)
    } else errors.push(p.stderr.toString())
  }

  const files = rows.flat()
  if (files.length) {
    const cols = T.length
    const at = (n: number, s: string) => (n ? Array.from({ length: n }, () => s).join("+") : "0")
    const layout = files.map((_, i) => `${at(i % cols, "w0")}_${at(Math.floor(i / cols), "h0")}`).join("|")
    const dest = `${out}/mantle-${tag}.png`
    const p = Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", ...files.flatMap((f) => ["-i", f]), "-filter_complex", `xstack=inputs=${files.length}:layout=${layout}${files.length % cols ? ":fill=black" : ""},scale=iw*0.5:-1`, dest])
    if (p.exitCode !== 0) errors.push(p.stderr.toString())
    else console.log(dest)
  }
} finally {
  await context.close()
  await browser.close()
}
console.log(JSON.stringify({ errors }))
