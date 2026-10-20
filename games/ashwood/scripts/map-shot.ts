// First-person captures of the clipboard map (src/game/map) on every page, in a few lighting situations, plus the
// drawn sheets themselves as flat PNGs. One headless browser, one page load per situation.
//
//   bun scripts/map-shot.ts                    # lit, dark, outdoor; every page
//   bun scripts/map-shot.ts dark --pages 1,4   # one situation, some pages
//   bun scripts/map-shot.ts --sheets           # also write the flat sheets (captures/map/sheet-<n>.png)
//   bun scripts/map-shot.ts lit --study        # held close (right mouse)
//   bun scripts/map-shot.ts lit --flip         # plus one frame mid page-flip
//   bun scripts/map-shot.ts dark --fov 90      # at another field of view
//
// Debug pages create the map in main.ts; if a page has none, the script injects it (same module instances as the game).
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return undefined
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}
const has = (name: string) => {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return false
  args.splice(i, 1)
  return true
}
const sheets = has("sheets")
const study = has("study")
const flipShot = has("flip")
const fov = Number(flag("fov") ?? 0)
const pagesArg = flag("pages")
const [w, h] = (flag("size") ?? "1280x720").split("x").map(Number) as [number, number]
const pages = pagesArg ? pagesArg.split(",").map(Number) : [0, 1, 2, 3, 4, 5, 6]

/** Situations: where the player stands (feet x, y, z), facing (yaw), flashlight. */
const SITUATIONS: Record<string, { view: string; at?: [number, number, number, number, number]; flashlight: boolean; label: string }> = {
  lit: { view: "lobby", flashlight: false, label: "lit lobby (storey 0)" },
  dark: { view: "lobby", at: [-28, 7.76, 15, 0.4, -0.15], flashlight: true, label: "dark teaching lab 2-24 (storey 2), flashlight" },
  outdoor: { view: "gate", flashlight: false, label: "outdoors at the gate, night" },
}
const which = args.length ? args : Object.keys(SITUATIONS)
const out = `${import.meta.dir}/../captures/map`
mkdirSync(out, { recursive: true })

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })

for (const name of which) {
  const s = SITUATIONS[name]!
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => (m.type() === "error" || m.text().startsWith("map")) && errors.push(m.text()))
  const t0 = performance.now()
  await page.goto(`http://localhost:5196/?shot=1&view=${s.view}${s.flashlight ? "&flashlight=1" : ""}`)
  await page.waitForFunction(() => ((globalThis as { __ashwood?: { frames: number } }).__ashwood?.frames ?? 0) > 20, null, { timeout: 180_000 })
  await page.evaluate(async ([at, studyOn, fovDeg]) => {
    const g = globalThis as Record<string, any>
    if (fovDeg) {
      g.__ashwoodDebug.camera.fov = fovDeg
      g.__ashwoodDebug.camera.updateProjectionMatrix()
    }
    const p = g.__ashwoodPlayer
    if (at) {
      p.pos.x = at[0]
      p.pos.y = at[1]
      p.pos.z = at[2]
      p.yaw = at[3]
      p.pitch = at[4]
      p.resetMotion()
      p.apply()
    }
    if (!g.__ashwoodMap) {
      const m = await import(/* @vite-ignore */ `${location.origin}/src/game/map/index.ts`)
      const d = g.__ashwoodDebug
      const handle = m.createMap({ ctx: g.__interior.ctx, camera: d.camera, player: p, streaming: false })
      g.__mapInjected = true
      let last = performance.now()
      const loop = () => {
        const now = performance.now()
        handle.update(Math.min(0.1, (now - last) / 1000))
        last = now
        requestAnimationFrame(loop)
      }
      requestAnimationFrame(loop)
    }
    // The play shell's objective line, as explore starts it (debug pages have no objectives of their own).
    const ob = await import(/* @vite-ignore */ `${location.origin}/src/game/objective.ts`)
    const obs = await import(/* @vite-ignore */ `${location.origin}/src/game/objectives.ts`)
    ob.setObjective(obs.OBJECTIVES.transmission)
    g.__ashwoodMap.request()
    if (studyOn) g.__ashwoodMap.study = true
  }, [s.at ?? null, study, fov] as const)
  await page.waitForFunction(() => (globalThis as Record<string, any>).__ashwoodMap.ready(), null, { timeout: 120_000 })
  const stats = await page.evaluate(() => (globalThis as Record<string, any>).__ashwoodMap.stats)
  if (sheets && name === which[0]) {
    for (const p of pages) {
      const url: string = await page.evaluate((i) => (globalThis as Record<string, any>).__ashwoodMap.dump(i), p)
      writeFileSync(`${out}/sheet-${p}.png`, Buffer.from(url.split(",")[1]!, "base64"))
    }
  }
  for (const p of pages) {
    await page.evaluate((i) => (globalThis as Record<string, any>).__ashwoodMap.raise(i), p)
    await page.waitForTimeout(900)
    await page.screenshot({ path: `${out}/${name}${study ? "-study" : ""}${fov ? `-fov${fov}` : ""}-p${p}.png` })
  }
  if (flipShot) {
    // Mid-flip: from the first page forward.
    await page.evaluate((i) => (globalThis as Record<string, any>).__ashwoodMap.raise(i), pages[0]!)
    await page.waitForTimeout(500)
    await page.evaluate(() => (globalThis as Record<string, any>).__ashwoodMap.flip(1))
    await page.waitForTimeout(170)
    await page.screenshot({ path: `${out}/${name}-flip.png` })
  }
  // Frame cost with the clipboard up vs down (median of the last 60 frames each).
  const median = async () => page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 1500))
    const f = [...(globalThis as Record<string, any>).__ashwood.frameMs.slice(-60)].sort((a: number, b: number) => a - b)
    return +f[f.length >> 1].toFixed(2)
  })
  const upMs = await median()
  await page.evaluate(() => (globalThis as Record<string, any>).__ashwoodMap.lower())
  const downMs = await median()
  console.log(JSON.stringify({ situation: name, frameMs: { up: upMs, down: downMs }, label: s.label, loadS: +((performance.now() - t0) / 1000).toFixed(1), sheetMs: stats.pages, errors: errors.slice(0, 8) }))
  await page.close()
}
await browser.close()
process.exit(0)
