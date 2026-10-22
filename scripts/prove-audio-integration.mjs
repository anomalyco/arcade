/** Silent proof of the Lab app (/arcade/lab/) and native OfflineAudioContext. No live audio context is permitted. */
import assert from "node:assert/strict"
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { resolve, sep } from "node:path"
import { browserBudget } from "./browser-budget.ts"

await using budget = browserBudget()
const { chromium } = budget

const production = process.argv.includes("--production")
const out = resolve(process.env.OUT ?? "captures/audio-integration")
mkdirSync(out, { recursive: true })
const server = production ? Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  const game = path.match(/^\/arcade\/(lab)\//)?.[1]
  if (!game) return new Response("Not found", { status: 404 })
  const root = resolve(`games/${game}/dist`), file = resolve(root, `.${decodeURIComponent(path)}`)
  if (!file.startsWith(root + sep)) return new Response("Not found", { status: 404 })
  const asset = Bun.file(file)
  return await asset.exists() ? new Response(asset) : new Response("Not found", { status: 404 })
} }) : null
const base = game => server ? `http://127.0.0.1:${server.port}/arcade/${game}/` : `http://arcade-review-${game}.localhost:1355/`
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--mute-audio"] })
const results = {}
try {
  for (const game of ["lab"]) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
    const errors = [], assetRequests = []
    page.on("pageerror", e => errors.push(e.message))
    page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
    page.on("response", r => { if (r.url().includes("audio-assets/")) assetRequests.push({ path: new URL(r.url()).pathname, status: r.status() }) })
    await page.addInitScript(() => {
      window.audioProof = { realtimeAttempts: 0, offlineContexts: 0, nodes: [] }
      window.AudioContext = class BlockedAudioContext { constructor() { window.audioProof.realtimeAttempts++; throw new Error("Live audio is disabled in this proof") } }
      const NativeOffline = window.OfflineAudioContext
      window.OfflineAudioContext = class extends NativeOffline {
        constructor(...args) {
          super(...args); window.audioProof.offlineContexts++
          for (const key of ["createGain", "createBiquadFilter", "createStereoPanner", "createBufferSource", "createOscillator"]) {
            const original = this[key].bind(this)
            this[key] = (...params) => {
              const node = original(...params), item = { disconnected: false }
              window.audioProof.nodes.push(item)
              const disconnect = node.disconnect.bind(node)
              node.disconnect = (...args) => { item.disconnected = true; return disconnect(...args) }
              return node
            }
          }
        }
      }
    })
    await page.goto(`${base(game)}?bench`)
    await page.waitForFunction(() => window.lab && window.audioLab)
    await page.locator('[data-row="section"] select').selectOption("audio")
    const initial = await page.evaluate(() => ({ attempts: audioProof.realtimeAttempts, offline: audioProof.offlineContexts, state: audioLab.runtime.telemetry().state, playing: audioLab.settings.playing }))
    assert.deepEqual(initial, { attempts: 0, offline: 0, state: "uninitialized", playing: false })
    // A real user action is the only path that attempts to create live audio; the proof deliberately blocks it.
    await page.getByRole("button", { name: "Audition", exact: true }).click()
    await page.getByRole("button", { name: "Audition Blocked", exact: true }).waitFor()
    assert.equal(await page.evaluate(() => audioProof.realtimeAttempts), 1)
    await page.getByRole("button", { name: "Render offline", exact: true }).click()
    await page.waitForFunction(() => audioLab.lastStats)
    const decoded = await page.evaluate(async () => {
      const bank = audioLab.runtime.sampleBank
      const stats = audioLab.lastStats
      return { expected: bank.manifest.size, real: bank.decodedAssetCount, peak: stats.peak, clipped: stats.clippedSamples, realtimeAttempts: audioProof.realtimeAttempts }
    })
    assert.equal(decoded.real, decoded.expected)
    assert(decoded.peak > 0); assert.equal(decoded.clipped, 0); assert.equal(decoded.realtimeAttempts, 1)
    await page.evaluate(() => lab.render())
    await page.screenshot({ path: resolve(out, `${production ? "production" : "local"}-${game}-audio.png`) })

    const native = await page.evaluate(async () => {
      const Runtime = audioLab.runtime.constructor, Vehicle = audioLab.vehicleEmitter.constructor, Spell = audioLab.spellEmitter.constructor
      const one = new OfflineAudioContext(2, 48000, 48000), r = new Runtime({ context: one, reverbWet: 0 })
      audioLab.runtime.sampleBank.cloneDecodedTo(r.sampleBank)
      const nodeStart = audioProof.nodes.length
      r.playCue("ui_confirm", { time: .02 })
      const buffer = await one.startRendering()
      await new Promise(resolve => setTimeout(resolve, 0))
      const cleanup = { active: r.telemetry().activeVoices, nodes: audioProof.nodes.slice(nodeStart).length, connected: audioProof.nodes.slice(nodeStart).filter(n => !n.disconnected).length }
      r.dispose()

      const ctx = new OfflineAudioContext(2, 48000 * 2, 48000), runtime = new Runtime({ context: ctx, reverbWet: 0 })
      const vehicle = new Vehicle(runtime), spell = new Spell(runtime)
      audioLab.runtime.sampleBank.cloneDecodedTo(runtime.sampleBank)
      let reset
      for (let i = 0; i < 90; i++) {
        runtime.scheduleTime = i / 60
        vehicle.update({ speed: 15, throttle: 1, boost: true, fuel: i < 20 ? 1 : i < 40 ? 0 : 1 }, 1 / 60)
        spell.update({ active: i >= 10 && i < 30, mana: 1, charge: .3, autoCastOnRelease: false }, 1 / 60)
        if (i === 60) { runtime.reset(); reset = { vehicle: vehicle.isActive, spell: spell.isActive, nitro: vehicle.nitroState.active } }
      }
      const exhaustion = vehicle.nitroState.ignitions
      runtime.scheduleTime = 1.5; runtime.suspend()
      const suspended = { vehicle: vehicle.isActive, nitro: vehicle.nitroState.active }
      const audio = await ctx.startRendering()
      let tail = 0, peak = 0
      for (let c = 0; c < audio.numberOfChannels; c++) {
        const data = audio.getChannelData(c)
        for (let i = 0; i < data.length; i++) { peak = Math.max(peak, Math.abs(data[i])); if (i > 1.9 * audio.sampleRate) tail = Math.max(tail, Math.abs(data[i])) }
      }
      runtime.dispose()
      return { native: buffer instanceof AudioBuffer, cleanup, exhaustion, reset, suspended, tail, peak, disposed: runtime.ctx === null && !vehicle.isActive && !spell.isActive }
    })
    assert.equal(native.native, true)
    assert.equal(native.cleanup.active, 0); assert.equal(native.cleanup.connected, 0)
    assert.equal(native.exhaustion, 1)
    assert.deepEqual(native.reset, { vehicle: false, spell: false, nitro: false })
    assert.deepEqual(native.suspended, { vehicle: false, nitro: false })
    assert(native.peak > 0 && native.peak < 1)
    assert(native.tail < 1e-4)
    assert.equal(native.disposed, true)
    await page.locator('[data-row="section"] select').selectOption("effects")
    assert.equal(await page.locator('canvas[aria-label="Audio waveform and spectrum"]').count(), 0)
    await page.locator('[data-row="section"] select').selectOption("audio")
    assert.equal(await page.evaluate(() => audioLab.settings.playing), false)
    assert.equal(await page.evaluate(() => audioProof.realtimeAttempts), 1)
    if (production && game === "blackout") {
      const outbreak = await page.evaluate(async root => {
        const bank = new audioLab.runtime.sampleBank.constructor([...audioLab.runtime.sampleBank.manifest.values()], root)
        await bank.loadAll(new OfflineAudioContext(2, 1, 48000))
        return { expected: bank.manifest.size, real: bank.decodedAssetCount }
      }, `${base("outbreak")}audio-assets/`)
      assert.equal(outbreak.real, outbreak.expected)
      results.outbreakAssets = outbreak
    }
    assert(assetRequests.length >= decoded.expected)
    const prefix = production ? `/arcade/${game}/audio-assets/` : "/audio-assets/"
    assert.equal(assetRequests.filter(r => r.path.startsWith(prefix)).length, decoded.expected)
    assert(assetRequests.every(r => r.status === 200))
    assert.deepEqual(errors, [])
    results[game] = { initial, decoded, native, assets: assetRequests, errors }
    await page.close()
  }
  if (production) {
    for (const game of ["lab"]) {
      const assets = resolve(`games/${game}/dist/arcade/${game}/assets`)
      for (const file of readdirSync(assets).filter(f => f.endsWith(".js"))) {
        assert(!/DeterministicOfflineAudioContext|OfflineParam|test-context/.test(readFileSync(resolve(assets, file), "utf8")), `Test context in ${game}/${file}`)
      }
    }
  }
  writeFileSync(resolve(out, `${production ? "production" : "local"}-audio-proof.json`), JSON.stringify(results, null, 2) + "\n")
  console.log(JSON.stringify(results, null, 2))
} finally { await browser.close(); server?.stop(true) }
