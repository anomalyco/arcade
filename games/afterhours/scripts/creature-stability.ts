// Temporal stability of the Wendigo in the game renderer (TAA, post): the hunter's creature stood still in a storey-3
// corridor, the camera pinned, the creature's animation frozen; N consecutive screenshots, then the per-pixel temporal
// standard deviation of luminance inside the creature's screen box (frozen picture + still camera ⇒ anything left is
// shimmer/boiling). Also writes captures/stability-<tag>.png (one frame) and -<tag>-std.png (the std map, ×8).
//
//   bun scripts/creature-stability.ts [--tag t] [--base http://localhost:5196/] [--dist 3.5]
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"

const args = process.argv.slice(2)
const flag = (n: string, d: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1]! : d)
const tag = flag("tag", "now")
const base = flag("base", "http://localhost:5196/")
const dist = Number(flag("dist", "3.5"))
const probe = flag("probe", "")
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
const W = 1280
const H = 720
const page = await browser.newPage({ viewport: { width: W, height: H } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
// Creature at (-10, 0) on storey 3, facing -X (toward the camera); camera `dist` m west of it, looking east.
const S3 = 0.16 + 3 * 3.8
const cx = -10
await page.goto(`${base}?hunter=${cx},0,3&icam=${cx - dist},${S3 + 1.65},0,-90,2&only=terrain,interior`)
await page.waitForFunction(() => (globalThis as any).__afterhours?.complete, null, { timeout: 180_000 }) // eslint-disable-line @typescript-eslint/no-explicit-any
await page.waitForTimeout(4000)
// Put it in place, face the camera, freeze it (its body, its sway clock, the hunter's brain).
await page.evaluate(
  ([x, y, probe]) => {
    const g = globalThis as any // eslint-disable-line @typescript-eslint/no-explicit-any
    const h = g.__ashwoodHunter.hunter
    h.update = () => {}
    const c = h.creature
    c.root.position.set(x, y, 0)
    c.root.rotation.set(0, -Math.PI / 2, 0)
    c.root.visible = true
    for (let i = 0; i < 40; i++) c.update(1 / 30, { mode: "idle", stance: "quad" })
    c.update = () => {}
    if (probe === "noshadow") c.root.traverse((o: any) => { o.receiveShadow = false; o.castShadow = false }) // eslint-disable-line @typescript-eslint/no-explicit-any
    if (probe === "nosway") c.animator.sway.value = 0
  },
  [cx, S3, probe] as const,
)
await page.waitForTimeout(2500)
const N = 12
const frames: Buffer[] = []
for (let i = 0; i < N; i++) {
  frames.push(await page.screenshot())
  await page.waitForTimeout(60)
}
writeFileSync(`${out}/stability-${tag}.png`, frames[0]!)
const gray = (png: Buffer) => {
  const r = Bun.spawnSync(["ffmpeg", "-v", "error", "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], { stdin: png })
  return new Uint8Array(r.stdout)
}
const g = frames.map(gray)
// Box: the creature fills roughly the middle of the frame at 3.5 m.
const x0 = Math.round(W * 0.3)
const x1 = Math.round(W * 0.7)
const y0 = Math.round(H * 0.2)
const y1 = Math.round(H * 0.85)
const std = new Uint8Array(W * H)
let sum = 0
let n = 0
let hot = 0
for (let y = y0; y < y1; y++)
  for (let x = x0; x < x1; x++) {
    const i = y * W + x
    let m = 0
    for (const f of g) m += f[i]!
    m /= N
    let v = 0
    for (const f of g) v += (f[i]! - m) ** 2
    const s = Math.sqrt(v / N)
    std[i] = Math.min(255, s * 8)
    sum += s
    n++
    if (s > 4) hot++
  }
const raw = `${out}/stability-${tag}-std.gray`
writeFileSync(raw, std)
Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${W}x${H}`, "-i", raw, `${out}/stability-${tag}-std.png`])
Bun.spawnSync(["rm", raw])
console.log(JSON.stringify({ tag, meanStd: +(sum / n).toFixed(3), hotPct: +((100 * hot) / n).toFixed(2), errors: errors.slice(0, 3) }))
await browser.close()
