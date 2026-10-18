// Acceptance contact sheets and videos of the live PlayerBody (Body Lab, body.html?manual=1): the full runtime
// (blend space, IK, overlays), stepped at a fixed 1/60 s so each pose is frozen while several cameras look at it.
//
//   bun scripts/player/sheets.ts [names…] [--video]
//
// Per move: captures/body-lab/accept/<name>.png, 4 columns (phases) × rows: side, front, right hand, left hand, feet.
// --video: captures/body-lab/accept/walk-1x.mp4 and walk-0.25x.mp4 (3 s of walking each, side-front 3/4 view).
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i < 0 ? null : args.splice(i, 2)[1]!
}
const extra = flag("q") ?? ""
const tag = flag("tag")
const rowsOverride = flag("rows")
const phasesOverride = flag("phases")
const video = args.includes("--video")
const names = args.filter((a) => !a.startsWith("--"))
const out = `${import.meta.dir}/../../captures/body-lab/accept`
const tmp = `${out}/tiles`
mkdirSync(tmp, { recursive: true })

type Spec = { query: string; phases?: number[]; times?: number[]; views?: string[] }
const CYCLE = [0, 0.25, 0.5, 0.75]
const SPECS: Record<string, Spec> = {
  idle: { query: "script=idle", times: [1, 1.6, 2.2, 2.8] },
  walk: { query: "script=walk", phases: CYCLE },
  run: { query: "script=run", phases: CYCLE },
  jog_back: { query: "script=jog_back", phases: CYCLE },
  jog_strafe: { query: "script=run_strafe", phases: CYCLE },
  back: { query: "script=back", phases: CYCLE },
  strafe_l: { query: "script=strafe_l", phases: CYCLE },
  strafe_r: { query: "script=strafe_r", phases: CYCLE },
  crouch: { query: "script=crouch", times: [0.5, 1.6, 1.9, 2.2] },
  jump: { query: "script=jump", times: [1.85, 2.0, 2.2, 2.45] },
  torch: { query: "script=flashlight&pitch=-0.3", times: [1, 2.2, 3.4, 4.6], views: ["side", "front", "q34", "hand_r", "fp"] },
  torch_walk: { query: "script=walk&flashlight=1&pitch=-0.3", phases: CYCLE, views: ["side", "front", "q34", "hand_r", "fp"] },
  torch_jog: { query: "script=jog&flashlight=1&pitch=0", phases: CYCLE, views: ["side", "front", "q34", "hand_r", "fp"] },
  reach: { query: "script=reach", times: [2.1, 2.25, 2.4, 2.6] },
  stairs_up: { query: "script=stairs_up", times: [0.9, 1.3, 1.7, 2.1] },
  stairs_down: { query: "script=stairs_down", times: [0.9, 1.3, 1.7, 2.1] },
  stairs_up_run: { query: "script=stairs_up_run", times: [0.6, 0.8, 1.0, 1.2] },
  stairs_down_run: { query: "script=stairs_down_run", times: [0.6, 0.8, 1.0, 1.2] },
}
const ROWS = ["side", "front", "hand_r", "hand_l", "feet"]
const STAIR_ROWS = ["q34", "side", "feet", "hand_r", "hand_l"]

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
type Lab = { ready: boolean; step(dt: number): void; view(v: string | null): void; time(): number; body: { debug: { phase: number; state: string } } }
const lab = "(globalThis as any).__bodyLab"

async function open(query: string, w = 480, h = 360) {
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  page.on("pageerror", (e) => console.log("pageerror", e.message))
  await page.goto(`http://localhost:5196/body.html?shot=1&manual=1&inset=0&${query}`)
  await page.waitForFunction(() => (globalThis as { __bodyLab?: Lab }).__bodyLab?.ready, null, { timeout: 90_000 })
  await page.addStyleTag({ content: "#hud,#bar,.knobs-pill{display:none!important}" })
  return page
}
const frame = () => new Promise((r) => setTimeout(r, 0))
void frame
void lab

for (const name of names.length ? names : video ? [] : Object.keys(SPECS)) {
  const spec = SPECS[name]
  if (!spec) continue
  const page = await open(`${spec.query}${extra ? `&${extra}` : ""}`)
  const views = rowsOverride?.split(",") ?? spec.views ?? (name.startsWith("stairs") ? STAIR_ROWS : ROWS)
  if (phasesOverride && spec.phases) spec.phases = phasesOverride.split(",").map(Number)
  const files: string[][] = views.map(() => [])
  const points = spec.phases ?? spec.times!
  for (let i = 0; i < points.length; i++) {
    const target = points[i]!
    await page.evaluate(
      ([phased, target, first]) => {
        const L = (globalThis as unknown as { __bodyLab: Lab }).__bodyLab
        if (phased) {
          if (first) for (let k = 0; k < 120; k++) L.step(1 / 60)
          // Step until the gait phase passes the target.
          let prev = L.body.debug.phase
          for (let k = 0; k < 400; k++) {
            L.step(1 / 60)
            const p = L.body.debug.phase
            const crossed = prev <= p ? prev < target && p >= target : prev < target || p >= target
            prev = p
            if (crossed) break
          }
        } else while (L.time() < target) L.step(1 / 60)
      },
      [!!spec.phases, target, i === 0] as const,
    )
    for (let v = 0; v < views.length; v++) {
      await page.evaluate((view) => (globalThis as unknown as { __bodyLab: Lab }).__bodyLab.view(view), views[v]!)
      await page.waitForTimeout(150)
      const f = `${tmp}/${name}-${views[v]}-${i}.png`
      await page.screenshot({ path: f })
      files[v]!.push(f)
    }
  }
  const all = files.flat()
  const cols = points.length
  const at = (n: number, s: string) => (n ? Array.from({ length: n }, () => s).join("+") : "0")
  const layout = all.map((_, i) => `${at(i % cols, "w0")}_${at(Math.floor(i / cols), "h0")}`).join("|")
  const sheet = `${out}/${name}${tag ? `-${tag}` : ""}.png`
  const p = Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", ...all.flatMap((f) => ["-i", f]), "-filter_complex", `xstack=inputs=${all.length}:layout=${layout}`, sheet])
  if (p.exitCode !== 0) console.log(p.stderr.toString())
  console.log(JSON.stringify({ name, sheet, rows: views, columns: spec.phases ? "gait phase 0/.25/.5/.75" : `t=${spec.times!.join("/")}s` }))
  await page.close()
}

if (video) {
  for (const [label, speed] of [["1x", 1], ["0.25x", 0.25]] as const) {
    const page = await open("script=walk", 960, 600)
    await page.evaluate(() => {
      const L = (globalThis as unknown as { __bodyLab: Lab }).__bodyLab
      for (let k = 0; k < 90; k++) L.step(1 / 60)
      L.view("side")
    })
    const dir = `${tmp}/video-${label}`
    mkdirSync(dir, { recursive: true })
    const fps = 30
    const n = 3 * fps
    for (let f = 0; f < n; f++) {
      await page.evaluate((dt) => (globalThis as unknown as { __bodyLab: Lab }).__bodyLab.step(dt), speed / fps)
      await page.waitForTimeout(40)
      await page.screenshot({ path: `${dir}/${String(f).padStart(4, "0")}.png` })
    }
    const file = `${out}/walk-${label}.mp4`
    Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", "-framerate", String(fps), "-i", `${dir}/%04d.png`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", file])
    console.log(JSON.stringify({ video: file, speed: label, seconds: 3 }))
    await page.close()
  }
}
rmSync(tmp, { recursive: true, force: true })
await browser.close()
