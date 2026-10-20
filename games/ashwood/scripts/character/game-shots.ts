// The player character in the real game (index.html, input on): walks outside and inside, climbs the core stair,
// calls the lift, opens a door, climbs the fire-escape ladder and cycles through every character, capturing each
// moment from the first-person view and the third-person debug camera, plus a short video.
//
//   bun scripts/character/game-shots.ts [--only lot,stairs,...] [--chars remy,kate] [--video] [--tag t]
//
// Output: captures/character/game-<tag>.png (contact sheet: fp | third per moment), the tiles in
// captures/character/game/, and with --video captures/character/game-<tag>.mp4.
import { chromium, type Page } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args.splice(i, 2)[1]! : undefined
}
const tag = flag("tag") ?? "run"
const only = flag("only")?.split(",")
const chars = (flag("chars") ?? "remy,louise,james,megan,kate").split(",")
const video = args.includes("--video")
/** Debug exposure added to the grade (EV) so the body reads in the night captures. */
const ev0 = Number(flag("ev") ?? 1.5)
const out = `${import.meta.dir}/../../captures/character`
const tiles = `${out}/game`
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
const t0 = Date.now()
await page.goto(`http://localhost:5196/?view=lot&character=${chars[0]}`)
await page.waitForFunction(() => (globalThis as { __ashwood?: { complete: boolean } }).__ashwood?.complete, null, { timeout: 240_000 })
console.log(`world complete in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
await page.addStyleTag({ content: "#hud{display:none!important}" })
await page.evaluate((ev) => {
  const s = (globalThis as unknown as { __ashwoodBody: { settings: Record<string, number> } }).__ashwoodBody.settings
  s["post.exposure"] = Number(s["post.exposure"] ?? -2.2) + ev
}, ev0)

type Ctx = { page: Page }
const ev = <T>(src: string, arg?: unknown): Promise<T> =>
  page.evaluate(({ src, arg }) => new Function("P", "B", "arg", src)((globalThis as Record<string, unknown>).__ashwoodPlayer, (globalThis as Record<string, unknown>).__ashwoodBody, arg), { src, arg }) as Promise<T>
const place = (x: number, y: number, z: number, yaw: number, pitch = 0) => ev(`P.pos.x=${x};P.pos.y=${y};P.pos.z=${z};P.yaw=${yaw};P.pitch=${pitch};P.resetMotion()`)
const pitch = (p: number) => ev(`P.pitch=${p}`)
const view = (third: boolean) => ev(`B.settings["body.view"]=${third ? 1 : 0}`)
const slides: Record<string, number[]> = {}
const pos = async () => {
  const p = await ev<{ x: number; y: number; z: number; grounded: boolean; onLadder: boolean; state: string; speed: number; slide: number[]; planted: boolean[]; eyeY: number; headY: number }>(
    `const b = B.body; const h = b.bones.Head; const v = h.getWorldPosition(b.root.position.clone()); return { ...P.pos, grounded: P.state.grounded, onLadder: P.state.onLadder, state: b.debug.state, speed: P.state.speed, slide: [...b.debug.slide], planted: [...b.debug.planted], eyeY: P.state.eye.y - P.pos.y, headY: v.y + 0.07 - P.pos.y }`,
  )
  // Planted-foot slide (cm/s) while moving on the flat, per gait state.
  if (p.grounded && p.speed > 0.5 && !p.state.startsWith("stairs")) {
    const key = `${current} ${p.state} ${p.speed.toFixed(1)} m/s`
    for (let i = 0; i < 2; i++) if (p.planted[i]) (slides[key] ??= []).push(p.slide[i]! * 100)
  }
  if (p.state.startsWith("crouch")) (slides[`${current} crouch eye ctrl ${p.eyeY.toFixed(2)} body ${p.headY.toFixed(2)}`] ??= []).push(0)
  return p
}
const wait = (ms: number) => page.waitForTimeout(ms)
const character = async (id: string) => {
  await ev(`B.settings["player.character"]=${JSON.stringify(id)}`)
  await page.waitForFunction((id) => {
    const b = (globalThis as unknown as { __ashwoodBody: { body: { character: string } } }).__ashwoodBody.body
    return b.character === id
  }, id, { timeout: 60_000 })
  await wait(400)
}
const shots: { name: string; files: string[] }[] = []
/** First person then third person of the same moment (the clock keeps running between the two, ~0.1 s). */
/** Video mode: no per-moment captures; each moment plays in one view (VIDEO_VIEW), the rest third person. */
const VIDEO_FP = new Set(["corridor", "door", "lift"])
let current = ""
async function snap(name: string, dist = 2.6) {
  await ev(`B.settings["body.thirdDist"]=${dist}`)
  if (video) {
    await view(!VIDEO_FP.has(current))
    return wait(250)
  }
  const fp = `${tiles}/${name}-fp.png`
  const tp = `${tiles}/${name}-third.png`
  await view(false)
  await wait(60)
  await page.screenshot({ path: fp })
  await view(true)
  await wait(60)
  await page.screenshot({ path: tp })
  await view(false)
  const st = await pos()
  console.log(`${name}: ${st.state} at ${st.x.toFixed(2)}, ${st.y.toFixed(2)}, ${st.z.toFixed(2)}`)
  shots.push({ name, files: [fp, tp] })
}
async function hold(keys: string[], until: (p: Awaited<ReturnType<typeof pos>>) => boolean, max: number, during?: () => Promise<void>) {
  for (const k of keys) await page.keyboard.down(k)
  const end = Date.now() + max
  while (Date.now() < end) {
    const p = await pos()
    if (until(p)) break
    if (during) await during()
    await wait(40)
  }
}
const release = async (keys: string[]) => {
  for (const k of keys) await page.keyboard.up(k)
}

// Video: CDP screencast frames (JPEG, with timestamps) encoded at their real timing.
const frames: { file: string; t: number }[] = []
const vdir = `${out}/_video`
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

let lotAt = { x: -24, z: 96 }
const MOMENTS: Record<string, () => Promise<void>> = {
  lot: async () => {
    // Under the parking lot's nearest working sodium lamp, walking past it.
    const lamp = await ev<{ x: number; z: number }>(`
      let best = null, bd = 1e9
      for (const l of P.ctx.lamps) { const p = l.position; const d = Math.hypot(p[0] + 24, p[2] - 96); if ((l.intensity ?? 0) > 500 && d < bd) { bd = d; best = { x: p[0], z: p[2] } } }
      return best ?? { x: -24, z: 96 }`)
    lotAt = { x: lamp.x + 2.5, z: lamp.z + 4 }
    await place(lotAt.x, 0, lotAt.z, -0.2, -0.35)
    await hold(["KeyW"], () => false, 1600)
    await snap("lot-walk")
    await pitch(-1.0)
    await wait(400)
    await snap("lot-walk-down")
    await release(["KeyW"])
    await page.keyboard.down("ShiftLeft")
    await hold(["KeyW"], () => false, 1500)
    await pitch(-0.3)
    await snap("lot-run")
    await release(["KeyW", "ShiftLeft"])
    await hold(["KeyA"], () => false, 1200)
    await snap("lot-strafe")
    await release(["KeyA"])
    await hold(["KeyC", "KeyS"], () => false, 1400)
    await snap("lot-crouch-back")
    await release(["KeyC", "KeyS"])
    await page.keyboard.press("Space")
    await wait(250)
    await snap("lot-jump")
  },
  corridor: async () => {
    await place(-11, 0.1, 0.2, Math.PI / 2, -0.2)
    await page.keyboard.press("KeyF")
    await hold(["KeyW"], () => false, 1500)
    await snap("corridor-torch-walk")
    await release(["KeyW"])
    await pitch(-0.7)
    await wait(900)
    await snap("corridor-torch-down")
    await page.keyboard.press("KeyF")
    await pitch(0)
  },
  door: async () => {
    // The tall door nearest the corridor viewpoint: stand a metre in front of it, facing it, and press E.
    const d = await ev<{ x: number; z: number; yaw: number; y: number } | null>(`
      const list = P.ctx.doors.list.filter(d => d.height > 1.8 && !d.spec.slide && !d.locked && !d.isOpen)
      let best = null, bd = 1e9
      for (const d of list) { const c = d.centre({x:0,y:0,z:0}); const dist = Math.hypot(c.x + 11, c.z - 0.2) + Math.abs(c.y - 1.05) * 10; if (dist < bd) { bd = dist; best = d } }
      if (!best) return null
      const c = best.centre({x:0,y:0,z:0})
      const side = Math.sign((-11 - best.hx) * Math.sin(best.yaw0) + (0.2 - best.hz) * Math.cos(best.yaw0)) || 1
      const nx = Math.sin(best.yaw0) * side, nz = Math.cos(best.yaw0) * side
      return { x: c.x + nx * 0.9, z: c.z + nz * 0.9, y: best.hy, yaw: Math.atan2(nx, nz) }`)
    if (!d) return console.log("door: none found")
    await place(d.x, d.y + 0.05, d.z, d.yaw, -0.25)
    await wait(500)
    await page.keyboard.press("KeyE")
    await wait(650)
    await snap("door-reach", 1.8)
    await wait(900)
    await snap("door-open", 1.8)
  },
  stairs: async () => {
    await place(-42.28, 0.3, 17.4, Math.PI, -0.3)
    await wait(300)
    await hold(["KeyW"], (p) => p.z >= 20.6, 6000)
    await snap("stairs-up", 1.5)
    await hold([], (p) => p.z >= 23.2, 4000)
    await ev(`P.yaw=-Math.PI/2`)
    await hold([], (p) => p.x >= -40.5, 4000)
    await ev(`P.yaw=0`)
    await hold([], (p) => p.z <= 20.5, 4000)
    await release(["KeyW"])
    // Down again.
    await ev(`P.yaw=Math.PI`)
    await wait(600)
    await hold(["KeyW"], (p) => p.z >= 23.2, 5000)
    await ev(`P.yaw=Math.PI/2`)
    await hold([], (p) => p.x <= -42.28, 4000)
    await ev(`P.yaw=0; P.pitch=-0.45`)
    await hold([], (p) => p.z <= 21, 4000)
    await snap("stairs-down", 1.5)
    await release(["KeyW"])
  },
  lift: async () => {
    // In the car, facing its panel: E sends it to the next floor.
    await place(-37.6, 0.1, 21.4, 0, -0.2)
    await wait(600)
    await page.keyboard.press("KeyE")
    await wait(550)
    await snap("lift-press", 1.2)
    await wait(3500)
    await pitch(0.05)
    await snap("lift-riding", 1.2)
    await wait(6000)
    await snap("lift-arrived", 1.2)
  },
  ladder: async () => {
    const l = await ev<{ min: number[]; max: number[] }>(`return P.ctx.ladders.find(l => l.min[0] < -55 && l.max[0] > -57.5) ?? P.ctx.ladders[0]`)
    const lz = (l.min[2] + l.max[2]) / 2
    await place(-57.2, 0.3, lz, -Math.PI / 2, 0.2)
    await wait(300)
    await hold(["KeyW"], (p) => p.y > 1.4, 6000)
    await snap("ladder-climb")
    await pitch(-0.6)
    await wait(300)
    await snap("ladder-climb-down")
    await pitch(0.1)
    await hold([], (p) => p.y > l.max[1] - 1.0, 6000)
    await snap("ladder-top")
    await hold([], (p) => p.grounded && !p.onLadder && p.x > l.max[0], 4000)
    await release(["KeyW"])
    await wait(350)
    await snap("ladder-off")
  },
  roster: async () => {
    // In the lit corridor, looking down at yourself; then walking with the torch.
    for (const c of chars) {
      await character(c)
      await place(-11, 0.1, 0.2, Math.PI / 2, -1.1)
      await wait(900)
      await snap(`roster-${c}`, 2.2)
    }
    await character(chars[0]!)
  },
}

for (const [name, fn] of Object.entries(MOMENTS)) {
  if (only && !only.includes(name)) continue
  current = name
  if (video) await view(!VIDEO_FP.has(name))
  try {
    await fn()
  } catch (e) {
    errors.push(`${name}: ${e instanceof Error ? e.message : e}`)
  }
}
const frame = await page.evaluate(() => {
  const a = (globalThis as unknown as { __ashwood: { frameMs: number[] } }).__ashwood.frameMs
  const s = [...a].sort((x, y) => x - y)
  return { median: s[s.length >> 1], p95: s[Math.floor(s.length * 0.95)] }
})
await context.close()
if (video && frames.length > 1) {
  await Bun.sleep(300)
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(1 / 60, Math.min(0.5, (frames[i + 1]?.t ?? f.t + 1 / 30) - f.t)).toFixed(4)}`).join("\n")
  await Bun.write(`${vdir}/list.txt`, `${list}\nfile '${frames.at(-1)!.file}'\n`)
  const dest = `${out}/game-${tag}.mp4`
  const p = Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", `${vdir}/list.txt`, "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "24", dest])
  if (p.exitCode === 0) {
    rmSync(vdir, { recursive: true, force: true })
    console.log(dest)
  } else errors.push(p.stderr.toString())
}
await browser.close()

// Contact sheet: one row per moment, first person | third person, half size.
const files = shots.flatMap((s) => s.files)
if (files.length) {
  const inputs = files.flatMap((f) => ["-i", f])
  const at = (n: number, s: string) => (n ? Array.from({ length: n }, () => s).join("+") : "0")
  const cols = 4
  const layout = files.map((_, i) => `${at(i % cols, "w0")}_${at(Math.floor(i / cols), "h0")}`).join("|")
  const dest = `${out}/game-${tag}.png`
  const p = Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", ...inputs, "-filter_complex", `xstack=inputs=${files.length}:layout=${layout}${files.length % cols ? `:fill=black` : ""},scale=iw*0.5:-1`, dest])
  if (p.exitCode !== 0) errors.push(p.stderr.toString())
  else console.log(dest)
}
for (const [k, v] of Object.entries(slides)) if (v.length > 2 || k.includes("eye")) console.log(`slide ${k}: ${v.length > 0 ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : "-"} cm/s avg, ${Math.max(...v).toFixed(1)} max (${v.length})`)
console.log(JSON.stringify({ frame, errors }))
