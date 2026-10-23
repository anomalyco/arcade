import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { type Page } from "playwright-core"
import { browserBudget } from "./browser-budget"
import { serveDist } from "../games/lot/scripts/serve-dist"
import type { WalkAudioFrame } from "../games/lot/src/walk-audio"

await using budget = browserBudget()
const { chromium } = budget

// Lot weather proof, headless and muted (run through HiveMind browser admission; never plays audio):
//   bun scripts/lot-storm-proof.ts stills    one still per Weather mode at the gate, and one mid-strike
//   bun scripts/lot-storm-proof.ts strike    a strike clip, frames + its thunder rendered offline to WAV
//   bun scripts/lot-storm-proof.ts walk      Rain: open lot, past the wagon, under the booth edge, into the lobby, with sound
//   bun scripts/lot-storm-proof.ts measure   paired whole-frame GPU time, Today vs each mode, at the gate
//   bun scripts/lot-storm-proof.ts today     Today at the gate without touching weather; LOT_STORM_DIST=<main's dist> for the baseline
// Frames are JPEGs in $LOT_STORM_OUT; encode them on a render worker, not on Studio's display.
const mode = process.argv[2] ?? "stills"
const out = resolve(process.env.LOT_STORM_OUT ?? "captures/lot/storm")
mkdirSync(out, { recursive: true })
const server = serveDist(resolve(process.env.LOT_STORM_DIST ?? "games/lot/dist"))
const W = Number(process.env.LOT_STORM_W ?? 1280), H = Number(process.env.LOT_STORM_H ?? 720)
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter(n => /^chromium-\d+$/.test(n)).sort().reverse().map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
assert(executablePath, "Playwright Chromium is missing")
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio", "--autoplay-policy=no-user-gesture-required"] })
const errors: string[] = []

async function open(query = "", todayOnly = false): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  page.on("pageerror", e => errors.push(e.message)); page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  page.on("response", r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.url()}`) })
  await page.addInitScript(() => {
    const configure = GPUCanvasContext.prototype.configure
    GPUCanvasContext.prototype.configure = function (c) { return configure.call(this, { ...c, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }) }
  })
  if (todayOnly) await page.addInitScript(() => { (window as any).todayOnly = true })
  await page.goto(`http://127.0.0.1:${server.port}/arcade/lot/?time=8${query}`)
  await page.waitForFunction(() => (window as any).lot?.frames > 8, undefined, { timeout: 600000, polling: 100 })
  await page.addStyleTag({ content: "#hud,#credits,[data-lab-panel]{display:none!important}" })
  await page.evaluate(async () => {
    const a = (window as any).lot; a.paused = true
    if (!(window as any).todayOnly) await a.loadStorm()
    const c = document.querySelector<HTMLCanvasElement>("#view")!, ctx = c.getContext("webgpu")!, d = a.renderer.passContext.device
    const row = Math.ceil(c.width * 4 / 256) * 256, buffer = d.createBuffer({ size: row * c.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    const output = new OffscreenCanvas(c.width, c.height), g = output.getContext("2d")!
    ;(window as any).grab = async (type = "image/jpeg") => {
      const texture = ctx.getCurrentTexture(), enc = d.createCommandEncoder()
      enc.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, [c.width, c.height]); d.queue.submit([enc.finish()])
      await buffer.mapAsync(GPUMapMode.READ); const src = new Uint8Array(buffer.getMappedRange()), rgba = new Uint8ClampedArray(c.width * c.height * 4)
      for (let y = 0; y < c.height; y++) rgba.set(src.subarray(y * row, y * row + c.width * 4), y * c.width * 4)
      buffer.unmap()
      const bgra = navigator.gpu.getPreferredCanvasFormat().startsWith("bgra")
      for (let i = 0; i < rgba.length; i += 4) { if (bgra) { const b = rgba[i]!; rgba[i] = rgba[i + 2]!; rgba[i + 2] = b } rgba[i + 3] = 255 }
      g.putImageData(new ImageData(rgba, c.width, c.height), 0, 0)
      const blob = await output.convertToBlob({ type, quality: 0.92 }), bytes = new Uint8Array(await blob.arrayBuffer()), chunks = []
      for (let i = 0; i < bytes.length; i += 16384) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 16384)))
      return btoa(chunks.join(""))
    }
  })
  return page
}

const save = (name: string, b64: string) => writeFileSync(resolve(out, name), Buffer.from(b64, "base64"))
const step = (page: Page, n: number) => page.evaluate(n => { const a = (window as any).lot; for (let i = 0; i < n; i++) a.step(1000 / 60) }, n)
/** Renders one more frame and reads it back in the same task (the canvas texture is only valid until the task ends). */
const grab = (page: Page, type = "image/jpeg") => page.evaluate(type => { (window as any).lot.step(1000 / 60); return (window as any).grab(type) }, type)
/** A strike in view at the gate: fixed seed and place, so stills and clips are the same bolt. */
const PLAN = { seed: Number(process.env.LOT_STORM_SEED ?? 20261021), kind: "ground", distance: 330, power: 1 }
const viewBearing = "Math.atan2(lot.camera.direction[0],-lot.camera.direction[2])"

try {
  if (mode === "stills") {
    const page = await open()
    for (const m of ["today", "drizzle", "rain", "storm"]) {
      await page.evaluate(m => { const a = (window as any).lot; a.setWeather(m); a.weather.strikes = 0; a.renderer.resetTemporalHistory() }, m)
      await step(page, 360)
      save(`${m}.png`, await grab(page, "image/png"))
      console.log(m)
    }
    // Mid-strike: the return stroke a frame after it fires.
    await page.evaluate(([plan, bearing]) => { const a = (window as any).lot; a.strike({ ...plan, bearing: new Function("lot", `return ${bearing}`)(a) - 0.35 }) }, [PLAN, viewBearing] as const)
    for (let i = 0; i < 10; i++) {
      if (i >= 6 && i <= 9) save(`strike-${i}.png`, await grab(page, "image/png")); else await step(page, 1)
      console.log(i, JSON.stringify(await page.evaluate(() => (window as any).lot.stormFrame?.light)))
    }
  } else if (mode === "strike") {
    // 9 s at 60 fps: the leader, return stroke and restrikes, the afterimage, and the thunder arriving ~1 s later.
    const page = await open("&weather=storm")
    const frames = 540, tape: WalkAudioFrame[] = []
    mkdirSync(resolve(out, "strike"), { recursive: true })
    await page.evaluate(() => { const a = (window as any).lot; a.weather.strikes = 0; a.camera.pitch = 0.09 })
    await step(page, 300)
    for (let i = 0; i < frames; i++) {
      if (i === 20) await page.evaluate(([plan, bearing]) => { const a = (window as any).lot; a.strike({ ...plan, bearing: new Function("lot", `return ${bearing}`)(a) - 0.35 }) }, [PLAN, viewBearing] as const)
      const r = await page.evaluate(async () => { const a = (window as any).lot; a.step(1000 / 60); return { jpeg: await (window as any).grab(), audio: a.audioFrame, light: a.stormFrame?.light } })
      tape.push({ ...r.audio, active: true, time: i / 60, events: [] })
      save(`strike/${String(i).padStart(4, "0")}.jpg`, r.jpeg)
      if (i % 60 === 0) console.log(`strike ${i}/${frames}`)
    }
    const wav = await page.evaluate(async ({ tape, s }) => { const a = await (window as any).lot.renderWalkAudio(tape, s), c = []; for (let i = 0; i < a.length; i += 16384) c.push(String.fromCharCode(...a.subarray(i, i + 16384))); return btoa(c.join("")) }, { tape, s: frames / 60 })
    save("strike.wav", wav)
    writeFileSync(resolve(out, "strike.json"), JSON.stringify({ fps: 60, frames, plan: PLAN, strikeAtFrame: 20, thunder: tape.at(-1)?.storm?.thunder }, null, 1))
  } else if (mode === "walk") {
    // Three cuts, each walked for real with the keyboard in Rain: open lot past the wagon, under the booth's roof
    // edge, and through the entrance into the lobby. Audio renders offline from the frame tape.
    const page = await open("&weather=rain")
    mkdirSync(resolve(out, "walk"), { recursive: true })
    await page.evaluate(() => { const a = (window as any).lot; a.weather.strikes = 0; a.walking.walkMode = "grounded" })
    await step(page, 300)
    await page.locator("#view").click({ force: true })
    await page.waitForFunction(() => document.pointerLockElement?.id === "view", undefined, { polling: 100 })
    const cuts = [
      { at: 0, x: -2.5, z: 146, yaw: 0.55, pitch: -0.05 },
      { at: 270, x: 9, z: 133.2, yaw: 0, pitch: -0.02 },
      { at: 540, x: 0.5, z: 27, yaw: 0, pitch: -0.02 },
    ]
    const frames = 810, tape: WalkAudioFrame[] = []
    for (let i = 0; i < frames; i++) {
      const cut = cuts.find(c => c.at === i)
      if (cut) {
        await page.keyboard.up("KeyW")
        await page.evaluate(c => { const a = (window as any).lot, cam = a.camera; cam.release(); cam.body.x = c.x; cam.body.y = c.z; cam.body.vx = cam.body.vy = 0; cam.yaw = c.yaw; cam.pitch = c.pitch; a.renderer.resetTemporalHistory() }, cut)
        await page.keyboard.down("KeyW")
      }
      if (i === 120) await page.evaluate(() => { (window as any).lot.camera.yaw = 0.15 })
      const r = await page.evaluate(async () => { const a = (window as any).lot; a.step(1000 / 60); const jpeg = await (window as any).grab(); return { jpeg, audio: a.audioFrame } })
      tape.push({ ...r.audio, active: true, time: i / 60 })
      if (i % 2 === 0) save(`walk/${String(i / 2).padStart(4, "0")}.jpg`, r.jpeg)
      if (i % 120 === 0) console.log(`walk ${i}/${frames}`, r.audio.surface, r.audio.inside)
    }
    await page.keyboard.up("KeyW")
    const wav = await page.evaluate(async ({ tape, s }) => { const a = await (window as any).lot.renderWalkAudio(tape, s), c = []; for (let i = 0; i < a.length; i += 16384) c.push(String.fromCharCode(...a.subarray(i, i + 16384))); return btoa(c.join("")) }, { tape, s: frames / 60 })
    save("walk.wav", wav)
    const steps = tape.flatMap(f => f.events.filter(e => e.kind === "step").map(e => f.surface))
    writeFileSync(resolve(out, "walk.json"), JSON.stringify({ fps: 30, frames: frames / 2, cuts: cuts.map(c => c.at / 60), steps, inside: tape.map(f => f.inside) }, null, 1))
  } else if (mode === "today") {
    const page = await open("", true)
    await step(page, 360)
    save("today.png", await grab(page, "image/png"))
  } else if (mode === "measure") {
    const page = await open()
    const result = await page.evaluate(async () => {
      const a = (window as any).lot, out: Record<string, number[]> = { today: [], drizzle: [], rain: [], storm: [] }
      for (let round = 0; round < 10; round++) for (const m of round % 2 ? ["storm", "rain", "drizzle", "today"] : ["today", "drizzle", "rain", "storm"]) {
        a.setWeather(m); a.weather.strikes = 0
        for (let i = 0; i < 150; i++) a.step(1000 / 60)
        const r = await a.measureFrames(6, 2)
        if (round >= 2) out[m]!.push(r.median)
      }
      const med = (v: number[]) => [...v].sort((x, y) => x - y)[Math.floor(v.length / 2)]
      return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { median: med(v), samples: v }]))
    })
    writeFileSync(resolve(out, "cost.json"), JSON.stringify({ viewport: [W, H], result }, null, 1))
    console.log(JSON.stringify(result))
  }
  assert(errors.length === 0, errors.join("\n"))
} finally { await browser.close(); server.stop() }
