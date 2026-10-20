// Headless side-by-side captures of every concept-matched camera in the Look Lab (render left, concept right).
//
//   bun scripts/look-shots.ts                         # every concept camera, game default look
//   bun scripts/look-shots.ts r3-01 r5-03 --look concept --tag concept
//   bun scripts/look-shots.ts --quality max --frames 120 --q "only=terrain,compound"
//
//   bun scripts/look-shots.ts --try cams.json        # camera tuning: {"r3-01": [{eye,yaw,pitch,fov}, ...]} → one grid
//                                                     # per view, concept first, candidates numbered from 1
//
// Boots look.html once (Metal adapter) and moves the camera between presets, so N views cost one boot. Output:
// captures/look/<id>[-tag].png (3072×1024 pair with labels) plus a JSON line per view with frame ms and page errors.
// Expects the dev server on :5196.
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { CAMERA_PRESETS, type CameraPreset } from "../src/look/presets"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return undefined
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}
const tag = flag("tag")
const look = flag("look") ?? ""
const quality = flag("quality") ?? "balanced"
const extra = flag("q") ?? ""
const frames = Number(flag("frames") ?? 60)
const tryFile = flag("try")
const outDir = flag("out") ?? `${import.meta.dir}/../captures/look`
const conceptDir = `${import.meta.dir}/../concept`
if (!existsSync(conceptDir)) {
  console.error("concept/ is missing: the concept art is local-only and not in git; copy it into games/ashwood/concept/")
  process.exit(1)
}
const cams = CAMERA_PRESETS.filter((c) => c.concept && (!args.length || args.includes(c.id)))
const W = 1536
const H = 1024
const base = "http://localhost:5196/"

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist", "--enable-features=Vulkan"],
})
mkdirSync(outDir, { recursive: true })

type Status = { frames: number; complete: boolean; errors: string[]; frameMs: number[] }
const page = await browser.newPage({ viewport: { width: W, height: H } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
const started = performance.now()
await page.goto(`${base}look.html?shot=1&cam=${cams[0]?.id ?? "r3-01"}&look=${look}&quality=${quality}${extra ? `&${extra}` : ""}`)
const status = () => page.evaluate(() => (globalThis as unknown as { __afterhours: Status }).__afterhours ?? { frames: 0, complete: false, errors: ["page reloaded"], frameMs: [] })
await page.waitForFunction((n) => {
  const s = (globalThis as { __afterhours?: Status }).__afterhours
  return !!s && ((s.complete && s.frames >= n) || s.errors.length > 0)
}, frames, { timeout: 180_000 }).catch((e: Error) => errors.push(e.message))
const bootS = (performance.now() - started) / 1000
// Other agents' edits make Vite reload the page mid-run: wait for the world to be back before each camera.
const ready = () =>
  page
    .waitForFunction(() => {
      const s = (globalThis as { __afterhours?: Status; __look?: unknown }).__afterhours
      return !!(globalThis as { __look?: unknown }).__look && !!s && s.complete && s.frames >= 10
    }, undefined, { timeout: 180_000 })
    .catch((e: Error) => errors.push(e.message))
const place = async (p: unknown) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    await ready()
    const ok = await page
      .evaluate((p) => {
        const look = (globalThis as unknown as { __look?: { setCamera(p: unknown): void } }).__look
        look?.setCamera(p)
        return !!look
      }, p)
      .catch(() => false)
    if (!ok) continue
    const from = (await status()).frames
    const done = await page
      .waitForFunction((n) => ((globalThis as { __afterhours?: Status }).__afterhours?.frames ?? 0) >= n, from + frames, { timeout: 60_000 })
      .then(() => true)
      .catch(() => false)
    if (done && (await status()).frames >= from + frames) return
  }
}

const pair = await browser.newPage({ viewport: { width: W * 2, height: H } })
const b64 = (b: Buffer | Uint8Array) => `data:image/png;base64,${Buffer.from(b).toString("base64")}`
if (tryFile) {
  const tries = JSON.parse(readFileSync(tryFile, "utf8")) as Record<string, Omit<CameraPreset, "id" | "label">[]>
  for (const [id, list] of Object.entries(tries)) {
    const cam = CAMERA_PRESETS.find((c) => c.id === id)!
    const shots: string[] = [b64(readFileSync(`${conceptDir}/${cam.concept}`))]
    for (const c of list) {
      await place({ ...cam, ...c })
      shots.push(b64(await page.screenshot({ type: "jpeg", quality: 80 })))
    }
    const cols = 3
    const cw = (W * 2) / cols
    const ch = Math.round(cw / 1.5)
    await pair.setViewportSize({ width: W * 2, height: Math.ceil(shots.length / cols) * ch })
    await pair.setContent(`<body style="margin:0;background:#000;display:grid;grid-template-columns:repeat(${cols},${cw}px);font:16px Menlo,monospace;color:#fff">${shots
      .map((s, i) => `<div style="position:relative"><img src="${s}" width="${cw}" height="${ch}" style="display:block"><span style="position:absolute;left:8px;top:8px;background:#000a;padding:2px 6px">${i ? `${i} ${JSON.stringify(list[i - 1])}` : cam.concept}</span></div>`)
      .join("")}</body>`)
    await pair.waitForFunction(() => Array.from(document.images).every((i) => i.complete))
    const file = `${outDir}/try-${id}.png`
    await pair.screenshot({ path: file, fullPage: true })
    console.log(JSON.stringify({ view: id, file }))
  }
  await browser.close()
  process.exit(0)
}
for (const cam of cams) {
  await place(cam.id)
  const shot = await page.screenshot({ type: "png" })
  const concept = readFileSync(`${conceptDir}/${cam.concept}`)
  const url = b64
  await pair.setContent(`<body style="margin:0;background:#000;display:flex;font:14px ui-monospace,Menlo,monospace;color:#fff">
    <div style="position:relative"><img src="${url(shot)}" width="${W}" height="${H}" style="display:block">
      <span style="position:absolute;left:10px;top:10px;background:#000a;padding:3px 8px">render · ${cam.label}${look ? ` · ${look}` : ""}</span></div>
    <div style="position:relative"><img src="${url(concept)}" width="${W}" height="${H}" style="display:block">
      <span style="position:absolute;left:10px;top:10px;background:#000a;padding:3px 8px">concept · ${cam.concept}</span></div></body>`)
  await pair.waitForFunction(() => Array.from(document.images).every((i) => i.complete))
  const file = `${outDir}/${cam.id}${tag ? `-${tag}` : ""}.png`
  await pair.screenshot({ path: file })
  const s = await status()
  const ms = [...s.frameMs.slice(-frames)].sort((a, b) => a - b)
  console.log(JSON.stringify({ view: cam.id, file, frameMedianMs: ms.length ? +ms[ms.length >> 1]!.toFixed(2) : null, errors: [...s.errors, ...errors].slice(0, 6) }))
  errors.length = 0
}
console.log(JSON.stringify({ bootS: +bootS.toFixed(1), views: cams.length }))
await browser.close()
process.exit(0)
