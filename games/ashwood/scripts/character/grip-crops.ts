// Close-up crops of the flashlight hand in first person in the real game, brightened (exposure +2 EV and a debug
// lamp at the hand), at 0 / −30 / −60° standing, walking and crouching, plus the grip contact numbers per crop.
//
//   bun scripts/character/grip-crops.ts [--chars remy,kate] [--tag t]
//
// One browser per character, 960×600. Output: captures/character/grip-<tag>.png (rows: characters).
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync } from "node:fs"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args.splice(i, 2)[1]! : undefined
}
const tag = flag("tag") ?? "crops"
const chars = (flag("chars") ?? "remy,kate").split(",")
const out = `${import.meta.dir}/../../captures/character`
const tiles = `${out}/grip`
mkdirSync(tiles, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const rows: string[][] = []
const errors: string[] = []
const SHOTS: [string, number, string[]][] = [
  ["stand0", 0, []],
  ["stand-30", -0.52, []],
  ["stand-60", -1.05, []],
  ["walk-30", -0.52, ["KeyW"]],
  ["crouch-30", -0.52, ["KeyC", "KeyW"]],
]
for (const char of chars) {
  const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
  const page = await (await browser.newContext({ viewport: { width: 960, height: 600 } })).newPage()
  page.on("pageerror", (e) => errors.length < 5 && errors.push(e.message))
  await page.routeWebSocket(/.*/, () => {})
  try {
    await page.goto(`http://localhost:5196/?view=corridor&character=${char}`)
    await page.waitForFunction(() => (globalThis as { __ashwood?: { complete: boolean } }).__ashwood?.complete, null, { timeout: 240_000 })
    await page.addStyleTag({ content: "#hud{display:none!important}" })
    await page.evaluate(() => {
      const G = globalThis as any
      const s = G.__ashwoodBody.settings
      s["post.exposure"] = Number(s["post.exposure"] ?? -2.2) + 2
      const b = G.__ashwoodBody.body
      const PL = G.__ashwoodDebug.scene.children.find((o: any) => o.isPointLight)?.constructor
      if (PL) {
        const l = new PL(0xffffff, 1.2, 1.5, 2)
        l.position.set(0.25, 0.25, 0.1)
        b.bones.LeftHand.add(l)
      }
    })
    const row: string[] = []
    for (const [name, pitch, keys] of SHOTS) {
      await page.evaluate((p) => {
        const P = (globalThis as any).__ashwoodPlayer
        P.pos.x = -14; P.pos.y = 0.1; P.pos.z = 0.2; P.yaw = 1.57; P.pitch = p; P.resetMotion(); P.flashlight = true
      }, pitch)
      for (const k of keys) await page.keyboard.down(k)
      await page.waitForTimeout(1300)
      const g = await page.evaluate(() => ({ grip: (globalThis as any).__ashwoodBody.body.debug.grip, wrist: (globalThis as any).__ashwoodBody.body.debug.wrist }))
      const f = `${tiles}/${char}-${name}.png`
      await page.screenshot({ path: f, clip: { x: 80, y: 330, width: 450, height: 270 } })
      for (const k of keys) await page.keyboard.up(k)
      console.log(`${char} ${name}: palmGap ${g.grip?.palmGap} mm, skin min ${g.grip?.skinMin} mm, hand verts inside barrel ${g.grip?.inside}/${g.grip?.verts}, wrist flex ${g.wrist?.flex}° barrelOff ${g.wrist?.barrelOff}°`)
      row.push(f)
    }
    rows.push(row)
  } finally {
    await browser.close()
  }
}
const files = rows.flat()
const cols = SHOTS.length
const at = (n: number, s: string) => (n ? Array.from({ length: n }, () => s).join("+") : "0")
const layout = files.map((_, i) => `${at(i % cols, "w0")}_${at(Math.floor(i / cols), "h0")}`).join("|")
const dest = `${out}/grip-${tag}.png`
const p = Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", ...files.flatMap((f) => ["-i", f]), "-filter_complex", `xstack=inputs=${files.length}:layout=${layout}`, dest])
if (p.exitCode !== 0) errors.push(p.stderr.toString())
else console.log(dest)
console.log(JSON.stringify({ errors }))
