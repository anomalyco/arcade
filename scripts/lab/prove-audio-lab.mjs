import { chromium } from "playwright-core"
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { createServer } from "vite"

const repoRoot = resolve(import.meta.dir, "../..")
const getawayRoot = join(repoRoot, "games/getaway")
const outDir = process.env.OUT_DIR ?? join(repoRoot, "captures/audio-lab")
mkdirSync(outDir, { recursive: true })

const virtualHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="icon" href="data:," />
  <title>Audio Lab</title>
  <style>html,body{margin:0;padding:0;background:#0b1014;overflow:hidden}</style>
</head>
<body>
  <script type="module">
    import { mountAudioLab } from "/@fs${join(repoRoot, "packages/kit/audio/lab.ts")}"
    void mountAudioLab(document.body)
  </script>
</body>
</html>`

const vite = await createServer({
  root: getawayRoot,
  configFile: join(getawayRoot, "vite.config.ts"),
  server: {
    host: "127.0.0.1",
    port: 0,
    fs: { allow: [repoRoot] },
  },
  plugins: [
    {
      name: "audio-lab-virtual-page",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.startsWith("/audio-lab.html")) {
            res.setHeader("Content-Type", "text/html; charset=utf-8")
            res.end(virtualHtml)
            return
          }
          next()
        })
      },
    },
  ],
})

await vite.listen()
const address = vite.httpServer?.address()
const port = address && typeof address === "object" ? address.port : 5199
const baseUrl = `http://127.0.0.1:${port}`

const caches = join(process.env.HOME ?? "", "Library/Caches/ms-playwright")
const chrome =
  process.env.CHROME ??
  (existsSync(caches)
    ? readdirSync(caches)
        .filter(n => n.startsWith("chromium-"))
        .sort()
        .reverse()
        .map(n => join(caches, n, "chrome-headless-shell-mac-arm64/chrome-headless-shell"))
        .find(existsSync)
    : undefined)

const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--mute-audio"],
})

const pageErrors = []
const consoleErrors = []

try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  })
  page.on("pageerror", e => pageErrors.push(e.message))
  page.on("console", msg => {
    if (msg.type() === "error") consoleErrors.push(msg.text())
  })

  // Strictly block real-time AudioContext so zero audio can ever play aloud during proof.
  await page.addInitScript(() => {
    window.__realtimeAudioAttempts = 0
    window.AudioContext = class BlockedAudioContext {
      constructor() {
        window.__realtimeAudioAttempts++
        throw new Error("Real-time AudioContext is blocked in offline proof")
      }
    }
  })

  await page.goto(`${baseUrl}/audio-lab.html?bench=1`)
  await page.waitForFunction(() => Boolean(window.audioLab && window.audioLab.lastStats && window.audioLab.lastAb), null, {
    timeout: 30000,
  })

  // Load real project & ElevenLabs MP3 stems into the runtime's SampleBank via OfflineAudioContext
  const loadedSamples = await page.evaluate(async () => {
    const lab = window.audioLab
    const decodeCtx = new OfflineAudioContext(2, 48000, 48000)
    const count = await lab.runtime.sampleBank.loadAll(decodeCtx)
    await lab.triggerCurrent()
    return count
  })

  await page.screenshot({ path: join(outDir, "audio-lab-overview.jpg"), type: "jpeg", quality: 88 })

  // 1. Render A/B comparison (Dry Open vs Reverb + Occluded)
  const abReport = await page.evaluate(async () => {
    const lab = window.audioLab
    lab.settings.replay = "occlusion_ab"
    lab.settings.occluded = true
    const ab = await lab.renderAbComparison()
    lab.drawVisualizer(lab.canvas)
    lab.panel.header.textContent = lab.section.telemetry()
    lab.panel.sync()
    return {
      dryWav: Array.from(ab.dryOpen.wav),
      occludedWav: Array.from(ab.reverbOccluded.wav),
      dryStats: ab.dryOpen.stats,
      occludedStats: ab.reverbOccluded.stats,
      delta: ab.delta,
    }
  })

  await page.screenshot({ path: join(outDir, "audio-lab-occlusion-ab.jpg"), type: "jpeg", quality: 88 })

  writeFileSync(join(outDir, "audio-lab-dry-open.wav"), Buffer.from(abReport.dryWav))
  writeFileSync(join(outDir, "audio-lab-reverb-occluded.wav"), Buffer.from(abReport.occludedWav))

  // 2. Render Chase Replay
  const chaseReport = await page.evaluate(async () => {
    const lab = window.audioLab
    lab.settings.source = "emitter_vehicle"
    lab.settings.replay = "chase"
    const rep = await lab.renderReplay("chase")
    lab.drawVisualizer(lab.canvas)
    lab.panel.header.textContent = lab.section.telemetry()
    lab.panel.sync()
    return {
      wav: Array.from(rep.wav),
      stats: rep.stats,
      events: rep.events,
    }
  })

  await page.screenshot({ path: join(outDir, "audio-lab-chase-replay.jpg"), type: "jpeg", quality: 88 })
  writeFileSync(join(outDir, "audio-lab-chase-replay.wav"), Buffer.from(chaseReport.wav))

  // 3. Render Spell Cycle Replay
  const spellReport = await page.evaluate(async () => {
    const lab = window.audioLab
    lab.settings.source = "emitter_spell"
    lab.settings.replay = "spell_cycle"
    const rep = await lab.renderReplay("spell_cycle")
    lab.drawVisualizer(lab.canvas)
    lab.panel.header.textContent = lab.section.telemetry()
    lab.panel.sync()
    return {
      wav: Array.from(rep.wav),
      stats: rep.stats,
      events: rep.events,
    }
  })
  writeFileSync(join(outDir, "audio-lab-spell-cycle.wav"), Buffer.from(spellReport.wav))

  // 4. Verify LabPanel controls (Randomize, Reset, Copy, Audition blocked gracefully)
  const uiChecks = await page.evaluate(async () => {
    const lab = window.audioLab
    const root = lab.panel.host.shadowRoot
    const randomBtn = root.querySelector('button[aria-label="Randomize Variation"]')
    randomBtn.click()
    const randomizedSeed = lab.settings.seed
    // Reset group with Shift+0
    const row = root.querySelector('[data-row="seed"]')
    row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
    window.dispatchEvent(new KeyboardEvent("keydown", { key: ")", code: "Digit0", shiftKey: true, bubbles: true }))
    window.dispatchEvent(new KeyboardEvent("keyup", { key: ")", code: "Digit0", shiftKey: true, bubbles: true }))
    const resetSeed = lab.settings.seed

    const auditionBtn = root.querySelector('button[data-key="audition"]')
    auditionBtn.click()
    await new Promise(r => setTimeout(r, 30))

    return {
      randomizedSeed,
      resetSeed,
      auditionLabelAfterBlockedClick: auditionBtn.textContent,
      realtimeAudioAttempts: window.__realtimeAudioAttempts,
      panelVisible: lab.panel.visible,
    }
  })

  const summary = {
    loadedSamples,
    pageErrors,
    consoleErrors,
    uiChecks,
    abComparison: {
      dryPeakDb: abReport.dryStats.peakDb,
      dryLufs: abReport.dryStats.approxLufs,
      dryClipped: abReport.dryStats.clippedSamples,
      dryCentroidHz: abReport.dryStats.spectralCentroidHz,
      dryTailRms: abReport.dryStats.tailRms,
      occludedPeakDb: abReport.occludedStats.peakDb,
      occludedLufs: abReport.occludedStats.approxLufs,
      occludedClipped: abReport.occludedStats.clippedSamples,
      occludedCentroidHz: abReport.occludedStats.spectralCentroidHz,
      occludedTailRms: abReport.occludedStats.tailRms,
      delta: abReport.delta,
    },
    chaseReplay: {
      peakDb: chaseReport.stats.peakDb,
      approxLufs: chaseReport.stats.approxLufs,
      clippedSamples: chaseReport.stats.clippedSamples,
      quietWindowRms: chaseReport.stats.quietWindowRms,
      events: chaseReport.events,
    },
    spellReplay: {
      peakDb: spellReport.stats.peakDb,
      approxLufs: spellReport.stats.approxLufs,
      clippedSamples: spellReport.stats.clippedSamples,
      quietWindowRms: spellReport.stats.quietWindowRms,
      events: spellReport.events,
    },
  }

  writeFileSync(join(outDir, "audio-lab-proof.json"), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))

  if (pageErrors.length || consoleErrors.length) {
    throw new Error(`Browser errors: ${[...pageErrors, ...consoleErrors].join("; ")}`)
  }
  if (
    abReport.dryStats.clippedSamples > 0 ||
    abReport.occludedStats.clippedSamples > 0 ||
    chaseReport.stats.clippedSamples > 0 ||
    spellReport.stats.clippedSamples > 0
  ) {
    throw new Error("Clipped samples detected in offline render")
  }
  if (abReport.delta.centroidDropHz <= 100 || abReport.delta.reverbTailGainRatio <= 1.2) {
    throw new Error(`Occlusion/reverb delta insufficient: ${JSON.stringify(abReport.delta)}`)
  }
} finally {
  await browser.close()
  await vite.close()
}

// Generate stacked A/B spectrogram image via ffmpeg
const sp = Bun.spawnSync([
  "ffmpeg",
  "-y",
  "-loglevel",
  "warning",
  "-i",
  join(outDir, "audio-lab-dry-open.wav"),
  "-i",
  join(outDir, "audio-lab-reverb-occluded.wav"),
  "-filter_complex",
  "[0:a]showspectrumpic=s=1120x320:legend=1:scale=log:fscale=log:color=intensity[a];[1:a]showspectrumpic=s=1120x320:legend=1:scale=log:fscale=log:color=intensity[b];[a][b]vstack[v]",
  "-map",
  "[v]",
  "-frames:v",
  "1",
  join(outDir, "audio-lab-ab-spectrogram.jpg"),
])
if (sp.exitCode !== 0) {
  throw new Error(`ffmpeg spectrogram failed: ${new TextDecoder().decode(sp.stderr)}`)
}
