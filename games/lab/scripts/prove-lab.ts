// Headless Metal proof for the single Lab app: every game's sections load from /arcade/lab/, assets resolve under the
// prefix, audio exists only after a gesture, and mute/volume persist. Never plays sound (muted browser, muted Lab).
//   bun games/lab/scripts/prove-lab.ts [--out dir] [--base http://127.0.0.1:5180]
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright-core"
import { createServer, type ViteDevServer } from "vite"

const root = resolve(import.meta.dir, "..")
const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
const out = resolve(arg("--out") ?? resolve(root, "../../captures/unified-lab"))
mkdirSync(out, { recursive: true })

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter(n => /^chromium-\d+$/.test(n)).reverse()
  .map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
assert(executablePath, "Playwright Chromium binary required")

let server: ViteDevServer | undefined
let base = arg("--base")
if (!base) {
  server = await createServer({ root, configFile: resolve(root, "vite.config.ts"), base: "/arcade/lab/", server: { host: "127.0.0.1", port: 0 }, logLevel: "warn" })
  await server.listen()
  const address = server.httpServer!.address()
  if (!address || typeof address === "string") throw new Error("No port")
  base = `http://127.0.0.1:${address.port}`
}
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const report: Record<string, unknown> = { base }
const errors: string[] = []

async function open(path: string, options: { audioProbe?: boolean } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  page.on("pageerror", e => errors.push(`${path}: ${e.message}`))
  page.on("console", m => { if (m.type() === "error") errors.push(`${path}: ${m.text()}`) })
  const failed: string[] = []
  page.on("response", r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`) })
  if (options.audioProbe) await page.addInitScript(() => {
    const w = window as unknown as { __audioContexts: number; __audioStates: string[] }
    w.__audioContexts = 0; w.__audioStates = []
    const Native = window.AudioContext
    window.AudioContext = class extends Native {
      constructor(options?: AudioContextOptions) { super(options); w.__audioContexts++ }
    } as typeof AudioContext
  })
  await page.goto(`${base}${path}`)
  return { page, failed }
}

const ready = (page: Page) => page.waitForFunction(() => Boolean((window as unknown as { lab?: unknown }).lab), undefined, { timeout: 60000 })
const shot = (page: Page, name: string) => page.screenshot({ path: resolve(out, name) })

try {
  // 1. Every game's sections, loaded from the one app.
  const sectionsByGame: Record<string, string[]> = {}
  for (const game of ["all", "getaway", "blackout", "outbreak"]) {
    const { page, failed } = await open(`/arcade/lab/?bench${game === "all" ? "" : `&game=${game}`}`)
    await ready(page)
    const ids = await page.evaluate(() => (window as unknown as { lab: { sections: { id: string }[] } }).lab.sections.map(s => s.id))
    sectionsByGame[game] = ids
    for (const id of ids) {
      await page.evaluate(async id => {
        const lab = (window as unknown as { lab: { select(id: string): void; advance(dt: number): void; render(): Promise<number> } }).lab
        lab.select(id); for (let i = 0; i < 3; i++) { lab.advance(1 / 60); await lab.render() }
      }, id)
    }
    assert.deepEqual(failed, [], `${game}: failed requests`)
    await page.close()
  }
  report.sections = sectionsByGame
  for (const id of ["getaway-effects", "blackout-effects", "fire-water", "splatter", "outbreak-vignette", "audio", "looks", "materials", "foliage", "spawn"]) {
    assert(sectionsByGame.all!.includes(id), `all: missing ${id}`)
  }
  assert(!sectionsByGame.getaway!.includes("blackout-effects"), "getaway only loads its own adapters")
  assert(!sectionsByGame.outbreak!.includes("spawn"), "outbreak has no Playground")

  type Sound = { muted: boolean; volume: number; vehicles: number; effects: number; state: string; contexts: number; voices: number; loadedSamples: number; masterGain: number | null; events: number; characterTicks: number; gameEvents: number; sharedEvents: number; beds: string[]; adapters: Record<string, { attached?: boolean; ready?: boolean; live?: boolean }> }
  const telemetry = (page: Page) => page.evaluate(() => (window as unknown as { labSound: { telemetry(): Sound } }).labSound.telemetry())
  const contexts = (page: Page) => page.evaluate(() => (window as unknown as { __audioContexts: number }).__audioContexts)
  const invoke = (page: Page, id: string, args: Record<string, unknown>) => page.evaluate(([id, args]) => (window as unknown as { lab: { workbench: { invoke(id: string, args: unknown): unknown } } }).lab.workbench.invoke(id, args), [id, args] as const)

  // 2. Audio exists only after a gesture; automation starts muted; samples load from /arcade/lab/audio-assets/.
  {
    const { page, failed } = await open("/arcade/lab/?bench&sound", { audioProbe: true })
    const assets: { path: string; status: number; type: string }[] = []
    page.on("response", r => { if (/\/(audio-assets|sfx)\//.test(r.url())) assets.push({ path: new URL(r.url()).pathname, status: r.status(), type: r.headers()["content-type"] ?? "" }) })
    await ready(page)
    await page.waitForTimeout(500)
    const before = { contexts: await contexts(page), sound: await telemetry(page) }
    assert.equal(before.contexts, 0, "no AudioContext before a gesture")
    assert.equal(before.sound.state, "uninitialized")
    assert.equal(before.sound.muted, true, "automation starts muted")
    await page.locator("canvas").first().click({ position: { x: 640, y: 380 } })
    await page.waitForFunction(() => {
      const t = (window as unknown as { labSound: { telemetry(): Sound } }).labSound.telemetry()
      return t.loadedSamples >= 20 && t.adapters.getaway?.ready
    }, undefined, { timeout: 20000 })
    const after = { contexts: await contexts(page), sound: await telemetry(page) }
    assert.equal(after.contexts, 1, "one AudioContext after the first gesture, shared by every game's audio")
    assert.equal(after.sound.muted, true)
    assert.equal(after.sound.masterGain, 0, "muted master gain")
    const shared = assets.filter(a => a.path.startsWith("/arcade/lab/audio-assets/")), getaway = assets.filter(a => a.path.startsWith("/arcade/lab/sfx/"))
    assert(shared.length >= 20 && getaway.length >= 40 && assets.every(a => a.status === 200 && a.type.startsWith("audio/")), `audio assets: ${JSON.stringify(assets)}`)
    // Effects and the car feed the sound system even while muted.
    await page.evaluate(async () => {
      const lab = (window as unknown as { lab: { select(id: string): void; sections: { id: string; retrigger?(): void }[]; advance(dt: number): void; render(): Promise<number> } }).lab
      lab.select("getaway-effects"); lab.sections.find(s => s.id === "getaway-effects")!.retrigger!()
      lab.select("spawn"); for (let i = 0; i < 4; i++) { lab.advance(1 / 60); await lab.render() }
    })
    const drive = async (asset: string) => {
      await invoke(page, "ground.spawn-here", { asset, at: "0,8" })
      await page.evaluate(async () => {
        const lab = (window as unknown as { lab: { context: { input: { enabled: boolean; held: Set<string> } }; advance(dt: number): void; render(): Promise<number> } }).lab
        lab.context.input.enabled = true; lab.context.input.held.add("KeyW")
        for (let i = 0; i < 90; i++) { lab.advance(1 / 60); if (i % 10 === 0) await lab.render() }
        lab.context.input.held.clear()
      })
    }
    await drive("getaway:muscle")
    await drive("blackout:soldier")
    const fed = await telemetry(page)
    assert(fed.events >= 1, "effect events reach the sound system")
    assert(fed.characterTicks >= 160, "the car and the soldier report every simulated tick")
    assert.equal(fed.voices, 0, "muted: no voices")
    report.audio = { before, after: { ...after, events: fed.events, characterTicks: fed.characterTicks, voices: fed.voices }, assets: { shared: shared.length, getaway: getaway.length } }
    assert.deepEqual(failed, [])
    await page.close()
  }

  // 3. Unmuted, the scene drives real voices. The "live" context is an OfflineAudioContext that is never rendered,
  //    so nothing reaches an output device.
  {
    const { page } = await open("/arcade/lab/?bench&sound")
    await page.addInitScript(() => {
      localStorage.setItem("arcade.lab.audio.v1", JSON.stringify({ muted: false }))
      const w = window as unknown as { __oscillators: number }
      w.__oscillators = 0
      window.AudioContext = class extends OfflineAudioContext {
        constructor() { super(2, 48000 * 30, 48000) }
        override createOscillator() { w.__oscillators++; return super.createOscillator() }
        override get state() { return "running" as AudioContextState }
        override resume() { return Promise.resolve() }
      } as unknown as typeof AudioContext
    })
    await page.reload()
    await ready(page)
    await page.locator("canvas").first().click({ position: { x: 640, y: 380 } })
    await page.waitForFunction(() => (window as unknown as { labSound: { telemetry(): { contexts: number } } }).labSound.telemetry().contexts === 1)
    await page.evaluate(async () => {
      const lab = (window as unknown as { lab: { select(id: string): void; sections: { id: string; settings: Record<string, unknown>; retrigger?(): void }[] } }).lab
      lab.select("getaway-effects")
      const section = lab.sections.find(s => s.id === "getaway-effects")!
      section.settings.effect = "explosion"; section.retrigger!()
    })
    const boom = await telemetry(page)
    await page.evaluate(() => {
      const lab = (window as unknown as { lab: { select(id: string): void; sections: { id: string; settings: Record<string, unknown>; retrigger?(): void }[] } }).lab
      lab.select("blackout-effects")
      const section = lab.sections.find(s => s.id === "blackout-effects")!
      section.settings.effect = "glass"; section.retrigger!()
    })
    const glass = await telemetry(page)
    await page.evaluate(() => (window as unknown as { lab: { select(id: string): void } }).lab.select("fire-water"))
    await page.waitForTimeout(400)
    const fire = await telemetry(page) as Sound & { beds: string[] }
    await invoke(page, "ground.spawn-here", { asset: "getaway:muscle", at: "0,8" })
    await page.evaluate(async () => {
      const lab = (window as unknown as { lab: { context: { input: { enabled: boolean; held: Set<string> } }; advance(dt: number): void; render(): Promise<number> } }).lab
      lab.context.input.enabled = true; lab.context.input.held.add("KeyW")
      for (let i = 0; i < 30; i++) lab.advance(1 / 60)
    })
    const car = await telemetry(page)
    const oscillators = await page.evaluate(() => (window as unknown as { __oscillators: number }).__oscillators)
    assert(boom.gameEvents >= 1 && boom.sharedEvents === 0, `explosion is Blackout's: ${JSON.stringify(boom)}`)
    assert(glass.sharedEvents >= 1, "glass has no game sound, so the shared one plays")
    assert(fire.beds.includes("fire"), `fire bed: ${fire.beds}`)
    assert(car.adapters.getaway?.ready && car.adapters.blackout?.live, `game audio attached: ${JSON.stringify(car.adapters)}`)
    assert(oscillators >= 2, "Getaway's DriverVoice built its oscillators on the shared context")
    report.unmuted = { explosion: { game: boom.gameEvents, shared: boom.sharedEvents }, glassShared: glass.sharedEvents, fireBeds: fire.beds, adapters: car.adapters, oscillators }
    await page.evaluate(() => (window as unknown as { labSound: { set(p: object): void } }).labSound.set({ muted: true }))
    await page.close()
  }

  // 4. Mute and volume persist. Live audio is blocked on this page, so unmuting cannot make a sound.
  {
    const { page } = await open("/arcade/lab/?bench&sound")
    await page.addInitScript(() => { window.AudioContext = class { constructor() { throw new Error("Live audio is disabled in this proof") } } as unknown as typeof AudioContext })
    await page.reload()
    await ready(page)
    const speaker = page.getByRole("button", { name: /mute sound/i })
    assert.equal((await telemetry(page)).muted, true)
    await speaker.click()
    assert.equal((await telemetry(page)).muted, false, "speaker click unmutes")
    await page.locator("canvas").first().focus()
    await page.keyboard.press("KeyM")
    assert.equal((await telemetry(page)).muted, true, "M mutes in Edit mode")
    await page.keyboard.press("KeyM")
    assert.equal((await telemetry(page)).muted, false, "M unmutes")
    await page.getByRole("searchbox", { name: "Search details" }).click()
    await page.keyboard.press("KeyM")
    assert.equal((await telemetry(page)).muted, false, "M types in text fields")
    await page.keyboard.press("Escape")
    await page.evaluate(() => (window as unknown as { lab: { workbench: { setMode(m: string): void } } }).lab.workbench.setMode("play"))
    await page.keyboard.press("KeyM")
    const playMuted = (await telemetry(page)).muted
    await page.evaluate(() => (window as unknown as { lab: { workbench: { setMode(m: string): void } } }).lab.workbench.setMode("edit"))
    assert.equal(playMuted, false, "M is not mute in Play mode")
    await page.getByRole("slider", { name: "Master volume" }).fill("35")
    await page.evaluate(() => (window as unknown as { lab: { select(id: string): void } }).lab.select("audio"))
    await invoke(page, "scene.set-param", { key: "lab_vehicles", value: 40 })
    await page.screenshot({ path: resolve(out, "audio-section-volumes.png") })
    await page.reload()
    await ready(page)
    const persisted = await telemetry(page)
    assert.deepEqual({ muted: persisted.muted, volume: persisted.volume, vehicles: persisted.vehicles }, { muted: false, volume: 0.35, vehicles: 0.4 }, "mix persisted")
    assert.equal(await page.getByRole("slider", { name: "Master volume" }).inputValue(), "35")
    await page.keyboard.press("KeyM").catch(() => undefined)
    await page.evaluate(() => (window as unknown as { labSound: { set(p: object): void } }).labSound.set({ muted: true }))
    report.persistence = { persisted, playModeIgnoresM: true, textFieldIgnoresM: true }
    await page.close()
  }

  // 5. Screenshots of the shipped page (no bench) per game choice.
  for (const game of ["all", "getaway", "blackout", "outbreak"]) {
    const { page } = await open(`/arcade/lab/${game === "all" ? "" : `?game=${game}`}`)
    await page.waitForFunction(() => document.querySelector("[data-readout=stats]")?.textContent, undefined, { timeout: 60000 }).catch(() => undefined)
    await page.waitForTimeout(2500)
    await shot(page, `lab-${game}.png`)
    await page.close()
  }
  writeFileSync(resolve(out, "proof.json"), JSON.stringify(report, null, 2))
  assert.deepEqual(errors, [], "browser errors")
  console.log(JSON.stringify(report, null, 2))
} finally {
  writeFileSync(resolve(out, "proof.json"), JSON.stringify({ ...report, errors }, null, 2))
  await browser.close()
  await server?.close()
}
