// Headless Metal proof for soldier crouch-run posture and weapon stability.
// Run through hivemind: captures side-view + top-down close run-cycle contact sheet and a mux compare.html video.
import { chromium } from "playwright-core"
import { createServer } from "vite"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { findChromeExecutable } from "./compare"

const out = join(import.meta.dir, "../../../captures/soldier-run")
mkdirSync(out, { recursive: true })
mkdirSync(join(out, "frames"), { recursive: true })

const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } })
await server.listen()
const address = server.httpServer!.address()
if (!address || typeof address === "string") throw new Error("Missing port")
const base = `http://127.0.0.1:${address.port}`

const browser = await chromium.launch({
  executablePath: findChromeExecutable(),
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})
const errors: string[] = []

try {
  const page = await browser.newPage({ viewport: { width: 1080, height: 720 }, deviceScaleFactor: 1 })
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error" && !m.location().url.endsWith("favicon.ico")) errors.push(m.text()) })

  const views = [
    { id: "side", camera: "zoom=5.6&side=0&elev=10" },
    { id: "topclose", camera: "zoom=6.2&side=20&elev=52" },
    { id: "game", camera: "zoom=24" },
  ] as const
  const variants = [
    { id: "old", query: "animation=old" },
    { id: "before", query: "animation=new&runPosture=0.18&crouchDepth=0" },
    { id: "after", query: "animation=new&runPosture=0.34&crouchDepth=0.08" },
  ] as const
  const sampleTicks = [64, 68, 72, 76, 80, 84, 88, 92]
  const cycleEvidence: unknown[] = []

  for (const view of views) {
    for (const variant of variants) {
      const dir = join(out, `${view.id}-${variant.id}`)
      mkdirSync(dir, { recursive: true })
      await page.goto(`${base}/anim.html?manual&only=running&runRoute=run&${variant.query}&${view.camera}`)
      await page.waitForFunction(() => (window as any).ready, null, { timeout: 30000 })
      const gpu = await page.evaluate(() => ({ architecture: (window as any).animProof.adapter.architecture }))
      if (!/metal/i.test(gpu.architecture)) throw new Error(`Not Metal: ${JSON.stringify(gpu)}`)
      let prev = 0
      const samples: unknown[] = []
      for (const tick of sampleTicks) {
        await page.evaluate(ms => (window as any).advance(ms), (tick - prev) * 1000 / 60)
        prev = tick
        const sample = await page.evaluate(() => (window as any).animProof.sample())
        samples.push({ tick, ...sample })
        await page.screenshot({ path: join(dir, `${String(tick).padStart(4, "0")}.png`) })
      }
      cycleEvidence.push({ view: view.id, variant: variant.id, gpu, samples })
      console.log(`Captured ${view.id} ${variant.id} (${sampleTicks.length} frames)`)
    }
  }

  // Verify shared Lab controls: Run lean, Crouch depth, Head stabilisation.
  await page.goto(`${base}/anim.html?manual&lab=1&only=running&runRoute=run&zoom=6&side=0&elev=10`)
  await page.waitForFunction(() => (window as any).ready, null, { timeout: 30000 })
  await page.evaluate(() => (window as any).advance(1200))
  for (const key of ["runPosture", "crouchDepth", "headStability"]) {
    const row = page.locator(`[data-lab] [data-row="${key}"]`)
    await row.waitFor({ timeout: 10000 })
  }
  await page.locator('[data-lab] [data-row="runPosture"]').click()
  await page.screenshot({ path: join(out, "lab-controls.png") })

  // Capture a short before/after video at game camera using the real compare.html mux harness.
  const cmpPage = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
  cmpPage.on("pageerror", e => errors.push(e.message))
  cmpPage.on("console", m => { if (m.type() === "error" && !m.location().url.endsWith("favicon.ico")) errors.push(m.text()) })
  await cmpPage.addInitScript(() => {
    if (parent !== window || !location.pathname.endsWith("compare.html")) return
    const w = window as any
    let now = performance.now()
    const raf = window.requestAnimationFrame.bind(window)
    const completed = new MessageChannel()
    completed.port1.onmessage = () => w.__done?.()
    performance.now = () => now
    window.requestAnimationFrame = callback => {
      if (callback.name !== "clock") return raf(callback)
      w.__clock = callback
      return 1
    }
    w.__proof = { ready: [null, null], pairs: 0, mismatch: [], last: [null, null] }
    addEventListener("message", event => {
      const panes = [...document.querySelectorAll("iframe")]
      const i = panes.findIndex(p => p.contentWindow === event.source && new URL(p.src).origin === event.origin)
      if (i < 0 || event.data?.run !== new URL(panes[i]!.src).searchParams.get("muxRun")) return
      const p = w.__proof, m = event.data
      if (m.type === "mux-ready") p.ready[i] = m
      if (m.type === "mux-state" || m.type === "mux-done") p.last[i] = m
      if (m.type === "mux-done") {
        const keys = ["x", "y", "vx", "vy", "aim", "tx", "ty"]
        if (p.last[0]?.tick !== p.last[1]?.tick || keys.some(key => p.last[0]?.[key] !== p.last[1]?.[key])) {
          p.mismatch.push({ before: p.last[0], after: p.last[1] })
        }
        p.pairs++
        completed.port2.postMessage(null)
      }
    })
    w.__advance = async (count: number) => {
      for (let i = 0; i < count; i++) {
        await new Promise<void>(resolve => {
          w.__done = resolve
          now += 1000 / 60 + 0.001
          w.__clock(now)
        })
      }
      return w.__proof
    }
  })

  const beforeParam = encodeURIComponent("/?practice&animation=old")
  const afterParam = encodeURIComponent("/?practice&animation=new")
  await cmpPage.goto(`${base}/compare.html?before=${beforeParam}&after=${afterParam}`)
  await cmpPage.waitForFunction(() => (window as any).__proof?.ready.every(Boolean), null, { polling: 100, timeout: 30000 })
  // Close the Lab overlay in both panes via their toggle pills, then focus the left canvas for mux input.
  const cmpFrames = cmpPage.frames().filter(f => f !== cmpPage.mainFrame())
  await cmpFrames[0]!.locator("[data-lab] .pill").click()
  await cmpFrames[1]!.locator("[data-lab] .pill").click()
  await cmpFrames[0]!.locator("canvas").first().click({ position: { x: 140, y: 360 } })
  await cmpPage.evaluate(() => (window as any).__advance(2))

  // Choreographed mux input sequence in open room:
  // 1) Run north (w, f=2..45), 2) Sprint south (s+Shift, f=45..85), 3) Strafe west (a, f=85..120),
  // 4) Run east (d, f=120..160), 5) Hard stop (f=160..180).
  const initialPos = await cmpPage.evaluate(() => (window as any).__proof.ready[0])
  const totalVideoFrames = 180 // 6 seconds at 30 fps (360 60Hz mux ticks)
  const wantVideo = process.argv.includes("--video") || process.env.ARCADE_VIDEO === "1"
  for (let f = 0; f < totalVideoFrames; f++) {
    if (f === 2) await cmpPage.keyboard.down("w")
    if (f === 45) {
      await cmpPage.keyboard.up("w")
      await cmpPage.keyboard.down("Shift")
      await cmpPage.keyboard.down("s")
    }
    if (f === 85) {
      await cmpPage.keyboard.up("Shift")
      await cmpPage.keyboard.up("s")
      await cmpPage.keyboard.down("a")
    }
    if (f === 120) {
      await cmpPage.keyboard.up("a")
      await cmpPage.keyboard.down("d")
    }
    if (f === 160) await cmpPage.keyboard.up("d")
    await cmpPage.evaluate(() => (window as any).__advance(2))
    if (wantVideo) await cmpPage.screenshot({ path: join(out, "frames", `${String(f).padStart(4, "0")}.png`) })
    if (f === 28 || f === 65 || f === 105 || f === 145) {
      await cmpPage.screenshot({ path: join(out, `compare-frame-${String(f).padStart(3, "0")}.png`) })
    }
  }
  const cmpProof = await cmpPage.evaluate(() => (window as any).__proof)
  if (cmpProof.mismatch.length) throw new Error(`Compare mux mismatch: ${JSON.stringify(cmpProof.mismatch[0])}`)
  if (cmpProof.last[0].x === initialPos.x && cmpProof.last[0].y === initialPos.y) throw new Error("Compare player did not move")

  if (wantVideo) {
    const encode = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "warning", "-y",
      "-framerate", "30", "-i", join(out, "frames", "%04d.png"),
      "-an", "-c:v", "h264_videotoolbox", "-profile:v", "high", "-q:v", "75",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      join(out, "compare-mux.mp4"),
    ], { stdio: "inherit" })
    if (encode.status !== 0) throw new Error("ffmpeg h264_videotoolbox encode failed")
  }

  // Build contact sheets (<= 1280 px on the long edge) directly on an HTML5 canvas inside the headless page.
  for (const [view, crop] of [
    ["side", [330, 150, 420, 510]],
    ["topclose", [340, 150, 400, 500]],
    ["game", [420, 240, 240, 260]],
  ] as const) {
    const tiles: { varId: string; tick: number; b64: string }[] = []
    for (const v of variants) {
      for (const tick of sampleTicks) {
        const buf = await Bun.file(join(out, `${view}-${v.id}`, `${String(tick).padStart(4, "0")}.png`)).arrayBuffer()
        tiles.push({ varId: v.id, tick, b64: Buffer.from(buf).toString("base64") })
      }
    }
    const dataUrl = await page.evaluate(async ({ view, crop, tiles, ticks, vars }) => {
      const tw = 156, th = 190
      const canvas = document.createElement("canvas")
      canvas.width = tw * ticks.length
      canvas.height = 28 + (th + 24) * vars.length
      const g = canvas.getContext("2d")!
      g.fillStyle = "#111820"
      g.fillRect(0, 0, canvas.width, canvas.height)
      g.fillStyle = "#ffffff"
      g.font = "13px monospace"
      g.fillText(`Blackout soldier run cycle — ${view} view (old vs before-change vs after-change)`, 10, 19)
      for (const tile of tiles) {
        const r = vars.indexOf(tile.varId), c = ticks.indexOf(tile.tick)
        const img = new Image()
        await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = rej; img.src = `data:image/png;base64,${tile.b64}` })
        const [cx, cy, cw, ch] = crop
        const scale = Math.min((tw - 4) / cw, (th - 4) / ch)
        const dw = Math.round(cw * scale), dh = Math.round(ch * scale)
        const x = c * tw + Math.floor((tw - dw) / 2), y = 28 + r * (th + 24)
        g.drawImage(img, cx, cy, cw, ch, x, y, dw, dh)
        g.fillStyle = "#a6cbd6"
        g.font = "11px monospace"
        g.fillText(`${tile.varId} t=${(tile.tick / 60).toFixed(2)}s`, c * tw + 6, y + th + 12)
      }
      return canvas.toDataURL("image/jpeg", 0.92)
    }, { view, crop, tiles, ticks: [...sampleTicks], vars: variants.map((v): string => v.id) })
    writeFileSync(join(out, `contact-sheet-${view}.jpg`), Buffer.from(dataUrl.split(",")[1]!, "base64"))
  }

  // Combine side + topclose into contact-sheet.jpg <= 1280 px on the long edge.
  const sideB64 = Buffer.from(await Bun.file(join(out, "contact-sheet-side.jpg")).arrayBuffer()).toString("base64")
  const topB64 = Buffer.from(await Bun.file(join(out, "contact-sheet-topclose.jpg")).arrayBuffer()).toString("base64")
  const combinedUrl = await page.evaluate(async ({ sideB64, topB64 }) => {
    const load = (b64: string) => new Promise<HTMLImageElement>((res, rej) => {
      const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = `data:image/jpeg;base64,${b64}`
    })
    const [a, b] = await Promise.all([load(sideB64), load(topB64)])
    const rawW = Math.max(a.width, b.width), rawH = a.height + b.height
    const scale = Math.min(1, 1280 / Math.max(rawW, rawH))
    const canvas = document.createElement("canvas")
    canvas.width = Math.round(rawW * scale)
    canvas.height = Math.round(rawH * scale)
    const g = canvas.getContext("2d")!
    g.drawImage(a, 0, 0, Math.round(a.width * scale), Math.round(a.height * scale))
    g.drawImage(b, 0, Math.round(a.height * scale), Math.round(b.width * scale), Math.round(b.height * scale))
    return canvas.toDataURL("image/jpeg", 0.92)
  }, { sideB64, topB64 })
  writeFileSync(join(out, "contact-sheet.jpg"), Buffer.from(combinedUrl.split(",")[1]!, "base64"))

  writeFileSync(join(out, "proof.json"), JSON.stringify({
    errors,
    comparePairs: cmpProof.pairs,
    compareMismatches: cmpProof.mismatch.length,
    cycleEvidence,
  }, null, 2))
  if (errors.length) throw new Error(errors.join("\n"))
  console.log(JSON.stringify({ ok: true, comparePairs: cmpProof.pairs, compareMismatches: cmpProof.mismatch.length }))
} finally {
  await browser.close()
  await server.close()
}
