// The listening room's radio (storeys/s3/listening.ts) along the way from the lot: records the mix standing still at
// the entrance, in the lobby, at the storey-3 stair door (hall side), in the corridor right outside 3-08 and inside
// 3-08, first with only the radio (the game's own ambience paused, every other bus muted), then with the ambience
// back, and prints the radio's loudness at each spot against the ambience there (−70 LUFS is the meter's floor:
// silent). The horror layer is set as in play mode (off) and its events are listed; the play-mode default is read from
// a `?play` page. One headless browser (960×600), closed at the end. Dev server on :5196.
//
//   bun scripts/audio-radio.ts
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"

const outDir = `${import.meta.dir}/../captures/audio-radio`
mkdirSync(outDir, { recursive: true })
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
  args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"],
})
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.routeWebSocket(/.*/, () => {})
  await page.goto("http://localhost:5196/?view=entrance&only=terrain,facility,interior")
  await page.waitForFunction(() => {
    const s = (globalThis as { __ashwood?: { ready: boolean; complete: boolean } }).__ashwood
    return !!s?.complete && s.ready
  }, null, { timeout: 240_000 })
  const run = <T>(body: string) => page.evaluate(`(async () => { const p = globalThis.__ashwoodPlayer; const A = globalThis.__ashwoodAudio; ${body} })()`) as Promise<T>
  const Y3 = 11.56
  const room = await run<{ x: number; z: number; door: { x: number; z: number } | null }>(`
    const { interiorRooms, interiorDoors } = await import("/src/world/interior/registry.ts")
    const r = interiorRooms.find((r) => r.storey === 3 && r.id === "3-08")
    const d = interiorDoors.filter((d) => d.storey === 3 && d.room === "3-08").sort((a, b) => Math.abs(a.z + 1.75) - Math.abs(b.z + 1.75))[0]
    return { x: (r.rect.x0 + r.rect.x1) / 2, z: (r.rect.z0 + r.rect.z1) / 2, door: d ? { x: d.x, z: d.z } : null }
  `)
  const door = room.door ?? { x: 8, z: -1.75 }
  const spots: [string, number, number, number][] = [
    ["entrance (outside)", 0, 0.2, 24.5],
    ["lobby", 0, 0.2, 15],
    ["storey-3 stair door", -40.0, Y3, 15.3],
    ["corridor outside 3-08", door.x, Y3, door.z + 0.9],
    ["inside 3-08", room.x, Y3, room.z],
  ]
  // Only the radio: the game's ambience paused before audio starts, every other bus muted (the radio's voices too).
  await run(`
    A.ambience.__update = A.ambience.update
    A.ambience.update = () => {}
    const s = p.ctx.settings
    for (const k of ["audio.footsteps", "audio.doors", "audio.horror", "audio.ui"]) s[k] = 0
    s["audio.horrorLayer"] = 0
    // No lightning: a thunder landing in a measurement window would swamp it.
    s["weather.lightning"] = 0
  `)
  await page.keyboard.press("KeyQ")
  await page.waitForTimeout(2500)
  await run(`
    const rec = new MediaRecorder(A.tap(), { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 160000 })
    globalThis.__chunks = []
    rec.ondataavailable = (e) => globalThis.__chunks.push(e.data)
    rec.start(500)
    globalThis.__rec = rec
    globalThis.__t0 = performance.now()
  `)
  const marks: { label: string; pass: string; a: number; b: number }[] = []
  const now = () => run<number>("return (performance.now() - globalThis.__t0) / 1000")
  for (const pass of ["radio", "radio + beds"]) {
    if (pass !== "radio") {
      await run("A.ambience.update = A.ambience.__update")
      await page.waitForTimeout(3000)
    }
    for (const [label, x, y, z] of spots) {
      await run(`p.pos.x = ${x}; p.pos.y = ${y + 0.05}; p.pos.z = ${z}; p.yaw = 0; p.pitch = 0; p.resetMotion()`)
      await page.waitForTimeout(1800)
      const a = await now()
      await page.waitForTimeout(4000)
      marks.push({ label, pass, a, b: await now() })
    }
  }
  const b64 = await run<string>(`
    const rec = globalThis.__rec
    await new Promise((r) => { rec.onstop = r; rec.stop() })
    const buf = new Uint8Array(await new Blob(globalThis.__chunks).arrayBuffer())
    let s = ""
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
    return btoa(s)
  `)
  const webm = `${outDir}/radio.webm`
  writeFileSync(webm, Buffer.from(b64, "base64"))
  const lufs = (a: number, b: number) => {
    const out = Bun.spawnSync(["ffmpeg", "-hide_banner", "-ss", String(a), "-t", String(b - a), "-i", webm, "-af", "ebur128", "-f", "null", "-"]).stderr.toString()
    return Number(/I:\s+(-?[\d.]+) LUFS/.exec(out.slice(out.lastIndexOf("Summary")))?.[1])
  }
  for (const [label] of spots) {
    const r = marks.find((m) => m.label === label && m.pass === "radio")!
    const t = marks.find((m) => m.label === label && m.pass !== "radio")!
    const radio = lufs(r.a, r.b)
    const total = lufs(t.a, t.b)
    if (radio <= -69.9) {
      console.log(`${label.padEnd(24)} radio silent · ambience ${total.toFixed(1)} LUFS`)
      continue
    }
    // The beds alone: the total's energy minus the radio's.
    const rest = 10 ** (total / 10) - 10 ** (radio / 10)
    // Within measurement noise of the radio alone: the beds are drowned (more than ~10 dB under it).
    if (rest <= 10 ** (radio / 10) * 0.12) console.log(`${label.padEnd(24)} radio ${radio.toFixed(1)} LUFS · beds drowned (total ${total.toFixed(1)}): radio > ~+9 dB over them`)
    else {
      const beds = 10 * Math.log10(rest)
      console.log(`${label.padEnd(24)} radio ${radio.toFixed(1)} LUFS · beds ${beds.toFixed(1)} · radio ${(radio - beds >= 0 ? "+" : "") + (radio - beds).toFixed(1)} dB over the beds`)
    }
  }
  const scares = await run<{ t: number; kind: string }[]>("return A.horror.log")
  console.log(`horror events during the walk (layer off, as in play): ${scares.length ? JSON.stringify(scares) : "none"}`)
  // The play-mode default of the horror layer.
  await page.goto("http://localhost:5196/?play")
  await page.waitForFunction(() => !!(globalThis as { __ashwoodAudio?: unknown }).__ashwoodAudio, null, { timeout: 240_000 })
  const playDefault = await page.evaluate(() => (globalThis as unknown as { __ashwoodPlayer: { ctx: { settings: Record<string, unknown> } } }).__ashwoodPlayer.ctx.settings["audio.horrorLayer"])
  console.log(`play mode: audio.horrorLayer = ${playDefault}`)
  console.log(errors.length ? `page errors: ${errors.slice(0, 3).join(" | ")}` : "no page errors")
} finally {
  await browser.close()
}
