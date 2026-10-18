// Character lab (bodyb.html) stills as one contact sheet: each spec is script:cam[:pitch[:character[:secs]]].
//   bun scripts/character/lab-shots.ts walk:fp:-1 torch_still:fp:-0.4:kate idle:3q --tag t
// Output: captures/character/lab-<tag>.png
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync } from "node:fs"

const args = process.argv.slice(2)
const ti = args.indexOf("--tag")
const tag = ti >= 0 ? args.splice(ti, 2)[1]! : "sheet"
const ci = args.indexOf("--cols")
const cols = ci >= 0 ? Number(args.splice(ci, 2)[1]) : 4
const out = `${import.meta.dir}/../../captures/character`
mkdirSync(`${out}/_tiles`, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
const page = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage()
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
await page.routeWebSocket(/.*/, () => {})
await page.goto("http://localhost:5196/bodyb.html?shot=1&inset=0&hud=0")
await page.waitForFunction(() => (globalThis as { __bodyB?: { ready: boolean } }).__bodyB?.ready, null, { timeout: 90_000 })
const files: string[] = []
for (const [i, spec] of args.entries()) {
  const [script, cam, pitch, character, secs] = spec.split(":")
  await page.evaluate(
    async ([script, cam, pitch, character]) => {
      const b = (globalThis as unknown as { __bodyB: { setCharacter(id: string): Promise<void>; body: { character: string }; startScript(n: string): void; setCam(c: string): void; walker: { pitch: number }; pitchHold?: number } }).__bodyB
      if (character && b.body.character !== character) await b.setCharacter(character)
      b.startScript(script!)
      b.setCam(cam!)
      b.pitchHold = pitch ? Number(pitch) : undefined
    },
    [script, cam, pitch, character] as const,
  )
  const end = Date.now() + Number(secs ?? 2) * 1000
  while (Date.now() < end) {
    await page.evaluate(() => {
      const b = (globalThis as unknown as { __bodyB: { walker: { pitch: number }; pitchHold?: number } }).__bodyB
      if (b.pitchHold !== undefined) b.walker.pitch = b.pitchHold
    })
    await page.waitForTimeout(50)
  }
  const f = `${out}/_tiles/${i}.png`
  await page.screenshot({ path: f })
  files.push(f)
}
const inputs = files.flatMap((f) => ["-i", f])
const at = (n: number, s: string) => (n ? Array.from({ length: n }, () => s).join("+") : "0")
const c = Math.min(cols, files.length)
const layout = files.map((_, i) => `${at(i % c, "w0")}_${at(Math.floor(i / c), "h0")}`).join("|")
const dest = `${out}/lab-${tag}.png`
const p = files.length === 1 ? Bun.spawnSync(["cp", files[0]!, dest]) : Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", ...inputs, "-filter_complex", `xstack=inputs=${files.length}:layout=${layout},scale=iw*0.5:-1`, dest])
if (p.exitCode !== 0) errors.push(p.stderr.toString())
console.log(dest, JSON.stringify({ errors }))
await browser.close()
