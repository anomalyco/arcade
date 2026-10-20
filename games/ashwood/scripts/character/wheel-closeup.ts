// Steering-wheel grip close-ups in the real intro (play-mode lighting plus a neutral debug lamp over the wheel):
// per character, a first-person frame cropped 3× round the wheel, and a view of the hands from the dash. Also prints
// the palm/finger-to-rim-tube measurement (mesh vertices vs the tube surface) through a stretch of the drive.
//
//   bun scripts/character/wheel-closeup.ts [--chars remy,kate] [--at 30] [--tag t]
//
// One browser at a time (one per character), 1280×720. Output: captures/character/wheel-<tag>.png (rows: characters;
// columns: first-person 3× crop at two moments, dash view at two moments).
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync } from "node:fs"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args.splice(i, 2)[1]! : undefined
}
const tag = flag("tag") ?? "run"
const chars = (flag("chars") ?? "remy,kate").split(",")
const at = Number(flag("at") ?? 30)
const out = `${import.meta.dir}/../../captures/character`
const tiles = `${out}/wheel`
mkdirSync(tiles, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const errors: string[] = []
const rows: string[][] = []
const MEASURE = await Bun.file(`${import.meta.dir}/wheel-measure.js`).text()

for (const char of chars) {
  const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  page.on("pageerror", (e) => errors.length < 6 && errors.push(e.message))
  await page.routeWebSocket(/.*/, () => {})
  try {
    await page.goto(`http://localhost:5196/?intro&introAt=${at}&character=${char}`)
    await page.waitForFunction(() => (globalThis as { __ashwood?: { complete: boolean } }).__ashwood?.complete, null, { timeout: 240_000 })
    await page.addStyleTag({ content: "#hud{display:none!important}" })
    await page.waitForTimeout(2500)
    // Palm / fingers to the rim tube over ~8 s of driving.
    const series: unknown[] = []
    for (let i = 0; i < 16; i++) {
      series.push(await page.evaluate(MEASURE))
      await page.waitForTimeout(500)
    }
    const worst = (series as { Left: { palm: number; fing: number; inside: number }; Right: { palm: number; fing: number; inside: number } }[]).reduce(
      (a, m) => ({
        palmMax: Math.max(a.palmMax, Math.abs(m.Left.palm), Math.abs(m.Right.palm)),
        fingMin: Math.min(a.fingMin, m.Left.fing, m.Right.fing),
        inside: Math.max(a.inside, m.Left.inside, m.Right.inside),
      }),
      { palmMax: 0, fingMin: 9, inside: 0 },
    )
    console.log(`${char}: palm-to-rim |gap| max ${worst.palmMax.toFixed(1)} cm (${worst.palmMax < 1 ? "PASS" : "FAIL"} < 1 cm), finger skin min ${worst.fingMin.toFixed(1)} cm, finger verts > 4 mm inside: max ${worst.inside}`)
    // Debug lamp over the wheel, the intro frozen; first person then the dash view.
    await page.evaluate(async () => {
      const G = globalThis as any
      const { scene, camera } = G.__ashwoodDebug
      const I = G.__ashwoodIntro
      const url = "/src/render/shared.ts"
      const RS = (await import(url)).renderState
      const car = I.car
      const PL = scene.children.find((o: any) => o.isPointLight || o.isSpotLight)?.constructor
      const Lamp = scene.children.find((o: any) => o.isPointLight)?.constructor ?? PL
      const lamp = new Lamp(0xffffff, 6, 3, 2)
      lamp.position.set(-0.36, 1.25, -0.05)
      car.body.add(lamp)
      G.__wheelView = { mode: "fp" }
      RS.beforeRender.unshift(() => {
        const v = G.__wheelView
        if (v.mode !== "dash") return
        car.body.updateMatrixWorld(true)
        const V = camera.position.constructor
        camera.position.copy(new V(-0.36, 1.02, -0.72).applyMatrix4(car.body.matrixWorld))
        camera.lookAt(new V(-0.36, 0.86, -0.35).applyMatrix4(car.body.matrixWorld))
        camera.layers.enable(4)
        camera.updateMatrixWorld()
      })
    })
    const row: string[] = []
    for (const [k, rate] of [
      [0, 0],
      [1, 0],
    ] as const) {
      if (k === 1) {
        await page.evaluate(() => ((globalThis as any).__ashwoodIntro.rate = 1))
        await page.waitForTimeout(2200)
      }
      await page.evaluate((r) => ((globalThis as any).__ashwoodIntro.rate = r), rate)
      await page.waitForTimeout(500)
      const fp = `${tiles}/${char}-${k}-fp.png`
      await page.screenshot({ path: fp, clip: { x: 1280 / 2 - 427, y: 720 - 300, width: 427 * 2 - 160, height: 300 } })
      await page.evaluate(() => ((globalThis as any).__wheelView.mode = "dash"))
      await page.waitForTimeout(300)
      const dash = `${tiles}/${char}-${k}-dash.png`
      await page.screenshot({ path: dash, clip: { x: 0, y: 0, width: 1280, height: 720 } })
      await page.evaluate(() => {
        const G = globalThis as any
        G.__wheelView.mode = "fp"
        G.__ashwoodDebug.camera.layers.disable(4)
      })
      row.push(fp, dash)
    }
    rows.push(row)
  } finally {
    await browser.close()
  }
}
const files = rows.flat()
if (files.length) {
  // Scale every tile to 640×320 so the first-person crops (enlarged ~1.5×) sit beside the dash views.
  const inputs = files.flatMap((f) => ["-i", f])
  const scaled = files.map((_, i) => `[${i}]scale=640:320:force_original_aspect_ratio=decrease,pad=640:320:(ow-iw)/2:(oh-ih)/2[t${i}]`).join(";")
  const at2 = (n: number, s: string) => (n ? Array.from({ length: n }, () => s).join("+") : "0")
  const cols = 4
  const layout = files.map((_, i) => `${at2(i % cols, "w0")}_${at2(Math.floor(i / cols), "h0")}`).join("|")
  const dest = `${out}/wheel-${tag}.png`
  const p = Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", ...inputs, "-filter_complex", `${scaled};${files.map((_, i) => `[t${i}]`).join("")}xstack=inputs=${files.length}:layout=${layout}`, dest])
  if (p.exitCode !== 0) errors.push(p.stderr.toString())
  else console.log(dest)
}
console.log(JSON.stringify({ errors }))
