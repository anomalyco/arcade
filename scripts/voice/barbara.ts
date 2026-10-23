import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import type { Browser } from "playwright-core"
import type { VoiceChat } from "../../packages/kit/voice"
import type { WoodsAudio } from "../../games/barbara/src/audio"
import type { OnlineSession } from "../../games/barbara/src/session"

type Woods = { voice: VoiceChat; audio: WoodsAudio; session: OnlineSession; frames: number; autoplay: boolean; drop(): void }
declare const woods: Woods
declare global {
  interface Window {
    woods?: Woods
    voiceProbe: { requests: number; tracks: MediaStreamTrack[]; level(): number }
  }
}

/** The real BARBARA bundle and Worker: catches adapter identity, input and paused-context regressions. */
export async function proveBarbaraVoice(browser: Browser, base: string, out: string): Promise<void> {
  const contexts = await Promise.all([browser.newContext({ viewport: { width: 1280, height: 720 } }), browser.newContext({ viewport: { width: 1280, height: 720 } })])
  const pages = await Promise.all(contexts.map((c) => c.newPage()))
  const errors: string[] = []
  const room = (await (await fetch(`${base}api/create`, { method: "POST" })).json() as { room: string }).room
  for (const [i, page] of pages.entries()) {
    page.setDefaultTimeout(30_000)
    page.on("pageerror", (e) => errors.push(e.message))
    await page.addInitScript(() => {
      const tracks: MediaStreamTrack[] = [], taps: AnalyserNode[] = []
      const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      window.voiceProbe = { requests: 0, tracks, level: () => {
        let energy = 0
        for (const tap of taps) {
          const data = new Float32Array(tap.fftSize); tap.getFloatTimeDomainData(data)
          energy += data.reduce((s, v) => s + v * v, 0) / data.length
        }
        return Math.sqrt(energy)
      } }
      navigator.mediaDevices.getUserMedia = async (c) => {
        window.voiceProbe.requests++
        const stream = await get(c); tracks.push(...stream.getTracks()); return stream
      }
      // Tap the actual terminal audio nodes without substituting the production graph or playing sound.
      const connect = AudioNode.prototype.connect
      AudioNode.prototype.connect = function(this: AudioNode, destination: AudioNode | AudioParam, output?: number, input?: number) {
        if (destination instanceof AudioDestinationNode) {
          const tap = this.context.createAnalyser(); tap.fftSize = 2048; taps.push(tap)
          Reflect.apply(connect, this, [tap, 0, 0])
        }
        return destination instanceof AudioNode
          ? Reflect.apply(connect, this, [destination, output ?? 0, input ?? 0])
          : Reflect.apply(connect, this, [destination, output ?? 0])
      } as typeof connect
      localStorage.setItem("barbara.name", "Voice proof")
    })
    await page.goto(`${base}?shell&room=${room}&people=blocky&quality=low`)
    await page.waitForFunction(() => window.woods && woods.frames > 2 && woods.session.me > 0)
    assert.equal(await page.evaluate(() => window.voiceProbe.requests), 0, "joining never asks for a microphone")
    await page.locator('[data-voice="enabled"]').check()
    await page.locator('[data-act="mute"]').click()
    // Separate contexts can lose focus while the other joins; restore the production focus gate explicitly.
    await page.evaluate(() => dispatchEvent(new Event("focus")))
    console.log(`BARBARA voice client ${i + 1} opted in`)
  }
  for (const page of pages) await page.evaluate(() => dispatchEvent(new Event("focus")))
  for (const page of pages) await page.waitForFunction(() => woods.voice.diagnostics().peers.some((p) => p.connection === "connected" && p.level > 0.005)).catch(async (error) => {
    console.error("BARBARA peer readiness:", JSON.stringify(await Promise.all(pages.map((p) => p.evaluate(() => ({ voice: woods.voice.diagnostics(), frames: woods.frames, hidden: document.hidden, requests: window.voiceProbe.requests, level: window.voiceProbe.level() })))), null, 2), errors)
    throw error
  })
  const [sender, receiver] = pages
  await receiver!.waitForFunction(() => window.voiceProbe.level() > 0.003)
  const lobby = await receiver!.evaluate(() => ({ level: window.voiceProbe.level(), context: woods.audio.bank.runtime.ctx?.state, worldMix: !!woods.audio.mix }))
  assert.equal(lobby.context, "running")
  assert.equal(lobby.worldMix, false, "lobby voice doesn't start the forest soundscape")
  console.log("BARBARA lobby audio passed")

  // Mute uses public seat identity, not the game's numeric actor ID.
  await receiver!.locator('[data-act="settings"]').click()
  await receiver!.locator('[data-voice-player]').check()
  await receiver!.waitForFunction(() => window.voiceProbe.level() < 0.0001, null, { timeout: 10_000 })
  await receiver!.screenshot({ path: `${out}/barbara-voice-settings.png` })
  await receiver!.locator('[data-voice-player]').uncheck()
  await receiver!.waitForFunction(() => window.voiceProbe.level() > 0.003)
  await receiver!.locator('[data-act="back"]').click()
  await receiver!.locator('[data-act="mute"]').click()
  await receiver!.waitForFunction(() => window.voiceProbe.level() < 0.0001)
  assert.equal(await receiver!.evaluate(() => woods.voice.micMuted), false, "output mute leaves microphone state alone")
  await receiver!.locator('[data-act="mute"]').click()
  await receiver!.waitForFunction(() => window.voiceProbe.level() > 0.003)
  console.log("BARBARA player and master mute passed")

  // The game's existing autoplay hook makes play input available without headless pointer lock.
  await sender!.evaluate(() => { dispatchEvent(new Event("focus")); woods.voice.setMode("push"); woods.autoplay = true; woods.audio.begin(); (document.activeElement as HTMLElement)?.blur() })
  await sender!.waitForFunction(() => !woods.voice.diagnostics().transmitting)
  await sender!.keyboard.down("KeyV")
  await sender!.waitForFunction(() => woods.voice.transmitting)
  await sender!.keyboard.up("KeyV")
  await sender!.waitForFunction(() => !woods.voice.diagnostics().transmitting)
  await sender!.keyboard.down("KeyB")
  await sender!.waitForFunction(() => woods.voice.diagnostics().transmitting && !woods.voice.transmitting)
  await sender!.keyboard.press("KeyN")
  await sender!.waitForFunction(() => woods.voice.micMuted && !woods.voice.diagnostics().transmitting)
  await sender!.keyboard.up("KeyB")
  await sender!.keyboard.press("KeyN")
  await sender!.evaluate(() => { woods.voice.setMode("open"); woods.autoplay = false })
  await sender!.waitForFunction(() => woods.audio.bank.runtime.ctx?.state === "running" && woods.voice.diagnostics().transmitting)
  console.log("BARBARA V/B/N and paused voice passed")

  const before = await sender!.evaluate(() => woods.session.me)
  await sender!.evaluate(() => woods.drop())
  await sender!.waitForFunction(() => woods.voice.diagnostics().peers.length === 0)
  await sender!.waitForFunction(() => woods.voice.diagnostics().peers.some((p) => p.connection === "connected" && p.level > 0.005))
  assert.equal(await sender!.evaluate(() => woods.session.me), before)
  assert.equal(await sender!.evaluate(() => window.voiceProbe.requests), 1, "reconnect reuses the consented microphone")
  await sender!.evaluate(() => woods.voice.setEnabled(false))
  await receiver!.waitForFunction(() => woods.voice.diagnostics().peers.length === 0)
  assert(await sender!.evaluate(() => window.voiceProbe.tracks.every((t) => t.readyState === "ended")))
  assert.deepEqual(errors, [])
  const report = { passed: true, surface: "BARBARA built bundle + local Wrangler Worker", lobby, playerMute: true, masterMute: true, radioAndNearbyKeys: true, micMute: true, reconnect: true, optOutStopsTracks: true, errors }
  await writeFile(`${out}/barbara-voice.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  for (const page of pages) await page.evaluate(() => { woods.voice.dispose(); woods.session.close() })
}
