// Outbreak sound proof: the production bundle in headless Metal Chromium launched with --mute-audio, so the audio
// graph really runs but nothing reaches a speaker. Checks that every library file the game ships is fetched and
// decoded, drives a scripted scene (walking, shooting, a door, a crowd of 100 zombies at night) and measures what the
// audio layer costs on the main thread and how many voices it holds.
//
//   bun scripts/prove-audio.ts            (from games/outbreak; through `hivemind run --kind browser`)
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { selectSfx } from "@arcade/kit/audio"

const game = resolve(import.meta.dir, "..")
const out = resolve(game, "../../captures/outbreak-audio")
mkdirSync(out, { recursive: true })
assert.equal(Bun.spawnSync(["bun", "run", "build"], { cwd: game, stdout: "inherit", stderr: "inherit" }).exitCode, 0)
const root = resolve(game, "dist/arcade/outbreak")
const shipped = selectSfx(["game:outbreak"]).flatMap((e) => e.files)
for (const f of shipped) assert(existsSync(resolve(root, "audio-assets/sfx", f.file)), `bundle is missing ${f.file}`)
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  const file = Bun.file(resolve(root, `.${path === "/" ? "/index.html" : path}`))
  return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 })
} })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter((n) => /^chromium-\d+$/.test(n)).sort().reverse()
  .map((n) => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
assert(chrome, "Install Chromium before the proof")
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 680 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${fixture.port}/?solo&seed=7&bench`, { waitUntil: "networkidle" })
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
  const audio = () => page.evaluate(() => (window as any).__arcadeHarness.audio())

  // Automation starts muted and locked; nothing has been fetched yet.
  const before = await audio()
  assert.equal(before.muted, true)
  assert.equal(before.unlocked, false)

  // A trusted key press is the first-input unlock; the Lab setting unmutes the graph (the browser itself stays muted).
  await page.keyboard.press("Shift")
  await page.evaluate(() => (window as any).__arcadeHarness.setLab("audioMuted", 0))
  await page.waitForFunction((n) => (window as any).__arcadeHarness.audio().loadedSamples >= n, shipped.length, { timeout: 30_000 })
  const step = (n: number, command: Record<string, unknown> = {}) => page.evaluate(async ({ n, command }) => {
    const h = (window as any).__arcadeHarness
    for (let i = 0; i < n; i++) await h.step(1 / 60, command)
  }, { n, command })
  await page.evaluate(() => { const h = (window as any).__arcadeHarness; h.freeze(); h.setLab("timeScale", 0); h.setLab("hour", 22) })

  // Walk across the lawn, then shoot down the street and open the front door.
  await page.evaluate(() => (window as any).__arcadeHarness.pose(20, 44, 0))
  await step(90, { mx: 1, my: 0, aim: 0 })
  const walked = await audio()
  assert(walked.footsteps >= 4, `expected footfalls while walking, got ${walked.footsteps}`)
  await step(1, { fire: true, aim: 0 })
  await step(30)
  const door = await page.evaluate(() => (window as any).__arcadeHarness.state().town.doors[0].rect[3])
  await page.evaluate((y) => (window as any).__arcadeHarness.pose(27.7, y + 1, -Math.PI / 2), door)
  await step(2)
  await step(1, { interact: true })
  await step(30)
  const scene = await audio()
  assert(scene.played > walked.played, "the shot and the door should play")

  // A miss into Ash's front wall from the lawn (wood siding), a reload in parts, a pickup, the pack and a dropped item.
  await page.evaluate(() => (window as any).__arcadeHarness.pose(31, 40, -Math.PI / 2))
  await step(2)
  await step(1, { fire: true, aim: -Math.PI / 2 })
  await step(20)
  await page.evaluate(() => (window as any).__arcadeHarness.stock(2, { ammo: 12 }))
  await step(1, { reload: true })
  await step(80)
  await page.evaluate(() => (window as any).__arcadeHarness.give("crowbar"))
  await step(2)
  await page.keyboard.press("Tab")
  await step(4)
  await page.keyboard.press("Tab")
  await step(4)
  await step(1, { drop: true })
  await step(10)
  const foley = await audio()
  const heard = (id: string) => foley.playedById[id] ?? 0
  assert(heard("impact.bullet.wood") >= 1, `the miss should strike wood: ${JSON.stringify(foley.playedById)}`)
  for (const id of ["gun.pistol.mag-release", "gun.pistol.mag-out", "gun.pistol.mag-in", "gun.pistol.slide", "pickup.tool", "pack.open", "pack.close", "item.drop"]) assert(heard(id) >= 1, `${id} should play`)

  // A crowd: 100 zombies around the survivor at night, chasing; measure main-thread cost and voices for 10 s.
  await page.evaluate(() => { const h = (window as any).__arcadeHarness; h.setLab("zombieCount", 100); h.pose(44, 44, 0) })
  await step(30)
  const zombies = await page.evaluate(() => (window as any).__arcadeHarness.state().zombies.filter((z: any) => z.state !== "dead").length)
  const crowdStart = await audio()
  let maxVoices = 0
  const timings: number[] = []
  for (let s = 0; s < 10; s++) {
    const t0 = Date.now()
    await step(60, { mx: Math.sin(s), my: Math.cos(s) })
    timings.push((Date.now() - t0) / 60)
    maxVoices = Math.max(maxVoices, (await audio()).voices)
  }
  const crowd = await audio()
  const crowdFeet = crowd.zombieFeet
  // The same 10 s with the audio graph muted, for the audio layer's share of frame time.
  await page.evaluate(() => (window as any).__arcadeHarness.setLab("audioMuted", 1))
  const mutedTimings: number[] = []
  for (let s = 0; s < 10; s++) {
    const t0 = Date.now()
    await step(60, { mx: Math.sin(s), my: Math.cos(s) })
    mutedTimings.push((Date.now() - t0) / 60)
  }
  const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1]!
  const result = {
    shippedFiles: shipped.length,
    shippedKB: Math.round(shipped.reduce((s, f) => s + f.bytes, 0) / 1024),
    loadedSamples: crowd.loadedSamples,
    zombies,
    walk: { footsteps: walked.footsteps, played: walked.played },
    scene: { events: scene.events, played: scene.played },
    crowd: {
      seconds: 10,
      events: crowd.events - crowdStart.events,
      played: crowd.played - crowdStart.played,
      maxVoices,
      voiceCap: crowd.maxVoices,
      stolen: crowd.stolen,
      dropped: crowd.dropped,
      meanAudioUpdateMs: Math.round(((crowd.updateMs - crowdStart.updateMs) / Math.max(1, crowd.updates - crowdStart.updates)) * 1000) / 1000,
      maxAudioUpdateMs: Math.round(crowd.maxUpdateMs * 1000) / 1000,
      medianFrameMsAudioOn: Math.round(median(timings) * 100) / 100,
      medianFrameMsAudioMuted: Math.round(median(mutedTimings) * 100) / 100,
      beds: crowd.beds,
      horde: crowd.horde,
      zombieSteps: crowd.zombieSteps - crowdStart.zombieSteps,
      zombieStepsPerSecond: (crowd.zombieSteps - crowdStart.zombieSteps) / 10,
      rigContacts: crowdFeet.contacts - crowdStart.zombieFeet.contacts,
      cadenceSteps: crowdFeet.cadence - crowdStart.zombieFeet.cadence,
      maxVoicesSeen: crowd.maxVoicesSeen,
    },
    foley: Object.fromEntries(Object.entries(foley.playedById).filter(([id]) => /^(impact|gun\.pistol\.(mag|slide)|pickup|pack|item)/.test(id))),
    errors,
  }
  writeFileSync(resolve(out, "audio-proof.json"), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
  assert.equal(crowd.loadedSamples, shipped.length, "every shipped file decodes")
  assert(maxVoices <= crowd.maxVoices + 3, "voices stay under the cap (beds excepted)")
  assert(result.crowd.zombieStepsPerSecond <= 9, "zombie feet stay within the crowd budget")
  assert(result.crowd.zombieSteps > 0, "a moving crowd is heard stepping")
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  fixture.stop()
}
