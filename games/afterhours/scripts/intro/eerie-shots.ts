// Captures of the intro's woods details (src/game/intro/eerie.ts) as a passenger who looks: the cutscene plays in real
// time; whenever an eye pair starts shining the camera turns to it (shot), the figure is shot when first in range,
// looked away from and looked at again (it should be gone), and the hard hat is shot as the car passes it.
//
//   bun scripts/intro/eerie-shots.ts [--tag t] [--q extra]     # captures/intro/eerie-<tag>-*.png + a JSON log
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync } from "node:fs"

const args = process.argv.slice(2)
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`)
  return i < 0 ? undefined : args[i + 1]
}
const tag = flag("tag") ?? "a"
const extra = flag("q") ?? ""
const outDir = `${import.meta.dir}/../../captures/intro`
mkdirSync(outDir, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter((n) => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse().map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
type Info = { eyes: { pos: number[]; state: string }[]; figure: { pos: number[]; state: string } | null; hat: number[] }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const I = "(globalThis as any).__afterhoursIntro"
void I
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("crash", () => console.log("page crashed"))
  page.on("framenavigated", (f) => f === page.mainFrame() && console.log("navigated", f.url()))
  page.on("console", (m) => /vite|hmr|reload/i.test(m.text()) && console.log("console:", m.text()))
  await page.goto(`http://localhost:5196/?intro${extra ? `&${extra}` : ""}`)
  await page.waitForFunction(() => (globalThis as any).__afterhoursIntro && (globalThis as any).__afterhours?.complete, undefined, { timeout: 240000 })
  await page.evaluate(() => (globalThis as any).__afterhoursIntro.seek(0))
  const state = () =>
    page.evaluate(() => {
      const i = (globalThis as any).__afterhoursIntro
      const cam = (globalThis as any).__afterhoursDebug.camera.position
      return { t: i.time as number, cam: [cam.x, cam.y, cam.z], info: i.woods.info() as Info }
    })
  // Look at a point the way a passenger would: the head turned a little short of it (15° towards the car's nose), so it
  // sits off-centre in the side window rather than behind the A-pillar.
  const aim = (p: number[] | null, exact = false) =>
    page.evaluate(([p, exact]) => {
      const i = (globalThis as any).__afterhoursIntro
      if (!p) return i.aim(null)
      if (exact) return i.aim(p)
      const cam = (globalThis as any).__afterhoursDebug.camera.position
      const yaw = i.car.root.rotation.y
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw)
      const d = Math.hypot(p[0] - cam.x, p[2] - cam.z)
      i.aim([p[0] + fx * d * 0.27, p[1], p[2] + fz * d * 0.27])
    }, [p, exact] as const)
  const rate = (r: number) => page.evaluate((r) => ((globalThis as any).__afterhoursIntro.rate = r), r)
  const shot = async (name: string) => {
    await page.waitForTimeout(250)
    const f = `${outDir}/eerie-${tag}-${name}.png`
    await page.screenshot({ path: f })
    console.log(f)
  }
  const shotEyes = new Set<number>()
  let fig = 0
  let hat = false
  const dist = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[2]! - b[2]!)
  for (;;) {
    const s = await state()
    if (s.t > 50) break
    for (const [k, e] of s.info.eyes.entries()) {
      if (e.state === "shining" && !shotEyes.has(k)) {
        shotEyes.add(k)
        await aim(e.pos)
        await rate(0.0)
        await shot(`eyes${k}-t${s.t.toFixed(1)}-d${dist(e.pos, s.cam).toFixed(0)}`)
        await rate(1)
        await aim(null)
      }
    }
    const f = s.info.figure
    if (f && fig === 0 && dist(f.pos, s.cam) < 22) {
      fig = 1
      await rate(0)
      const p = [f.pos[0]!, f.pos[1]! + 1.4, f.pos[2]!]
      await aim(p, true)
      await shot(`figure-1-d${dist(f.pos, s.cam).toFixed(0)}`)
      await rate(1)
      await page.waitForTimeout(600)
      await aim([s.cam[0]! + (s.cam[0]! - f.pos[0]!), s.cam[1]!, s.cam[2]! - 20])
      await page.waitForTimeout(300)
      await aim(p, true)
      await shot(`figure-2-again`)
      await aim(null)
      console.log("figure state", JSON.stringify((await state()).info.figure))
    }
    if (!hat && dist(s.info.hat, s.cam) < 22) {
      hat = true
      await aim(s.info.hat)
      await rate(0)
      await shot(`hat-d${dist(s.info.hat, s.cam).toFixed(0)}`)
      await rate(1)
      await aim(null)
    }
    await page.waitForTimeout(60)
  }
  console.log(JSON.stringify((await state()).info), errors.slice(0, 4))
} finally {
  await browser.close()
}
