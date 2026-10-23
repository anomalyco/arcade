// Offline jet-audio renders (captures/audio/). Build the page bundle here, then run this ON hailmary (headless Chrome):
//
//   bun build scripts/audio-demo.ts --target=browser --outfile=/tmp/carrier-audio/demo.js
//   cp -r public/sfx /tmp/carrier-audio/  &&  cp scripts/audio-render.ts /tmp/carrier-audio/
//   (copy /tmp/carrier-audio to hailmary, with node_modules/playwright-core)
//   ssh hailmary 'cd /tmp/carrier-audio && ~/.bun/bin/bun audio-render.ts --out=/tmp/carrier-audio/out'
//
// Serves the folder, opens it, renders every scene of scripts/audio-demo.ts (or --scenes=a,b) and writes <scene>.wav
// with a line of stats (peak, RMS, takes loaded). Spectrograms and MP3s are made from the WAVs with ffmpeg.
// Or anywhere, in place: --root=DIR serves the bundle and sfx/ from DIR instead of this script's folder.
import { browserBudget } from "../../../scripts/browser-budget"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

await using budget = browserBudget()
const { chromium } = budget

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const out = opt("out", "/tmp/carrier-audio/out")
const root = opt("root", import.meta.dir)
mkdirSync(out, { recursive: true })

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname
    if (path === "/") return new Response(`<!doctype html><meta charset="utf-8"><script type="module" src="demo.js"></script>`, { headers: { "content-type": "text/html" } })
    return new Response(Bun.file(join(root, path)))
  },
})
const base = `http://localhost:${server.port}/`

// Offline audio needs no GPU: Chrome on hailmary (macOS) or Playwright's bundled Chromium anywhere else.
const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const browser = await chromium.launch({ executablePath: existsSync(MAC_CHROME) ? MAC_CHROME : undefined, headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] })
const page = await browser.newPage()
page.on("console", (m) => console.log(`[page] ${m.text()}`))
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`))
await page.goto(base)
const all = await page.evaluate(() => (globalThis as unknown as { scenes: string[] }).scenes)
const want = opt("scenes", "").split(",").filter(Boolean)
for (const name of want.length ? want : all) {
  const t0 = performance.now()
  const r = await page.evaluate(
    ([n, b]) => (globalThis as unknown as { renderScene: (n: string, b: string) => Promise<{ wav: string; peak: number; rms: number; loaded: number; fired: string[] }> }).renderScene(n!, b!),
    [name, base],
  )
  writeFileSync(join(out, `${name}.wav`), Buffer.from(r.wav, "base64"))
  writeFileSync(join(out, `${name}.sounds.txt`), `${r.fired.join("\n")}\n`)
  const db = (v: number) => (20 * Math.log10(v + 1e-9)).toFixed(1)
  console.log(`${name.padEnd(20)} peak ${db(r.peak)} dBFS  rms ${db(r.rms)} dBFS  takes ${r.loaded}  (${((performance.now() - t0) / 1000).toFixed(1)} s)`)
}
await browser.close()
server.stop()
