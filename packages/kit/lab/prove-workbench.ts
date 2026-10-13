/// <reference types="@webgpu/types" />
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { createServer, type ViteDevServer } from "vite"

const root = resolve(import.meta.dir, "../../..")
const out = resolve(process.env.WORKBENCH_OUT ?? resolve(root, "captures/lab-workbench"))
mkdirSync(out, { recursive: true })

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter(n => /^chromium-\d+$/.test(n))
  .reverse()
  .map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)
  .find(existsSync)

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

const servers: ViteDevServer[] = []
const errors: string[] = []
const report: Record<string, unknown> = {}

try {
  const hosts: { game: string; url: string }[] = []
  for (const game of ["getaway", "blackout"] as const) {
    const dir = resolve(root, "games", game)
    const server = await createServer({
      root: dir,
      configFile: resolve(dir, "vite.config.ts"),
      server: { host: "127.0.0.1", port: 0 },
    })
    servers.push(server)
    await server.listen()
    const addr = server.httpServer!.address()
    if (!addr || typeof addr === "string") throw new Error("No fixture port")
    hosts.push({ game, url: `http://127.0.0.1:${addr.port}` })
  }

  for (const [hostIdx, { game, url }] of hosts.entries()) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    page.on("pageerror", e => errors.push(`${game}: ${e.message}`))
    page.on("console", m => {
      if (m.type() === "error" && !m.text().includes("404")) errors.push(`${game}: ${m.text()}`)
    })
    await page.addInitScript(() => {
      ;(window as any).__audioAttempts = 0
      const OrigAudio = window.AudioContext
      window.AudioContext = class extends OrigAudio {
        constructor(...args: any[]) {
          ;(window as any).__audioAttempts++
          super(...args)
        }
      } as any
    })

    await page.goto(`${url}/lab.html?bench`)
    await page.waitForFunction(() => !!(window as any).lab, undefined, { timeout: 45000 })

    const adapter = await page.evaluate(() => {
      const a = (window as any).lab.adapter
      return { vendor: a.vendor, architecture: a.architecture }
    })
    assert.match(adapter.architecture, /metal/i, "Metal WebGPU adapter required")

    const step = async (n: number) => {
      for (let i = 0; i < n; i++) {
        await page.evaluate(async () => {
          ;(window as any).lab.advance(1 / 60)
          await (window as any).lab.render()
        })
      }
    }

    // 1. Verify true canvas dimensions match center viewport at 1280x800
    await page.evaluate(() => (window as any).lab.workbench.frame())
    await step(35)
    const dims1280 = await page.evaluate(() => {
      const c = document.querySelector("canvas")!
      const vp = document.querySelector("[data-lab-viewport]")!
      return { cw: c.width, ch: c.height, vw: vp.clientWidth, vh: vp.clientHeight }
    })
    assert.equal(dims1280.cw, dims1280.vw, "Canvas width matches viewport width at 1280x800")
    assert.equal(dims1280.ch, dims1280.vh, "Canvas height matches viewport height at 1280x800")
    assert(dims1280.cw < 1280 && dims1280.cw > 600, "Sidebars reserve width cleanly without stretching canvas")
    if (hostIdx === 0) await page.screenshot({ path: resolve(out, "after-default-1280x800.png") })

    // 2. Select Glass with keyboard, frame target, retrigger, change shard size, reroll room keeping effect, reset, undo
    await page.keyboard.press("Meta+k")
    await page.getByRole("searchbox", { name: "Search library" }).fill("Glass shards")
    await page.keyboard.press("Enter")
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('[data-control="library-search"]')!
      input.value = ""
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await page.getByRole("combobox", { name: "Environment", exact: true }).selectOption("meeting")
    await page.evaluate(() => {
      const l = (window as any).lab
      const s = l.sections.find((x: any) => x.id === "blackout-effects")
      s.settings.targetX = 8.5
      s.settings.targetZ = 9
      l.context.sync()
    })
    await page.locator("canvas").focus()
    await page.keyboard.press("f")
    await page.keyboard.press(" ")
    await step(14)

    // Verify ONLY selected effect controls are mounted in Inspector DOM
    const glassDomAudit = await page.evaluate(() => {
      const root = document.querySelector("[data-lab]")!.shadowRoot!
      const groups = [...root.querySelectorAll("[data-controls] h3 .fold")].map(el => el.textContent?.trim())
      const inputs = [...root.querySelectorAll("[data-controls] [data-key]")].map(el => el.getAttribute("data-key"))
      return { groups, inputCount: inputs.length, inputs }
    })
    assert.deepEqual(glassDomAudit.groups, ["▾ Emitter", "▾ Glass shards", "▾ Environment"])
    assert(glassDomAudit.inputCount <= 24, `Expected compact control set, got ${glassDomAudit.inputCount}`)
    if (hostIdx === 0) await page.screenshot({ path: resolve(out, "after-glass-default.png") })

    // Change Shard size via keyboard Shift+ArrowRight
    const shardSlider = page.getByRole("slider", { name: "Shard size", exact: true })
    await shardSlider.focus()
    for (let i = 0; i < 12; i++) await page.keyboard.press("Shift+ArrowRight")
    const enlargedSize = await page.evaluate(() => (window as any).lab.sections.find((s: any) => s.id === "blackout-effects").settings["glass.size"])
    assert(enlargedSize > 1.8, "Shard size increased")
    await page.locator("canvas").focus()
    await page.keyboard.press(" ")
    await step(14)
    if (hostIdx === 0) await page.screenshot({ path: resolve(out, "after-glass-shard-size.png") })

    // Reroll room keeping effect locked
    const seedBefore = await page.evaluate(() => (window as any).lab.sections.find((s: any) => s.id === "blackout-effects").settings.seed)
    await page.keyboard.press("r")
    await step(14)
    const afterReroll = await page.evaluate(() => {
      const s = (window as any).lab.sections.find((x: any) => x.id === "blackout-effects")
      const tel = JSON.parse(s.telemetry().split("\n")[1])
      return { seed: s.settings.seed, effect: s.settings.effect, size: s.settings["glass.size"], sheets: tel.sheets }
    })
    assert.notEqual(afterReroll.seed, seedBefore, "Room seed rerolled")
    assert.equal(afterReroll.effect, "glass", "Effect remained glass")
    assert.equal(afterReroll.size, enlargedSize, "Shard size preserved across room reroll")
    assert(afterReroll.sheets > 0, "Glass shards retriggered in rerolled room")
    if (hostIdx === 0) await page.screenshot({ path: resolve(out, "after-glass-rerolled.png") })

    // Reset Glass shards group and Undo / Redo
    await page.getByRole("button", { name: "Reset Glass shards", exact: true }).click()
    assert.equal(await page.evaluate(() => (window as any).lab.sections.find((s: any) => s.id === "blackout-effects").settings["glass.size"]), 1)
    await page.locator("canvas").focus()
    await page.keyboard.press("Meta+z")
    assert.equal(await page.evaluate(() => (window as any).lab.sections.find((s: any) => s.id === "blackout-effects").settings["glass.size"]), enlargedSize)
    await page.keyboard.press("Meta+Shift+z")
    assert.equal(await page.evaluate(() => (window as any).lab.sections.find((s: any) => s.id === "blackout-effects").settings["glass.size"]), 1)

    // 3. World interaction: Ghost placement, selection, move, delete, Undo/Redo, and Car Play/Edit transition
    await page.locator('[data-catalog-id="fixture:car-cones"]').click()
    await step(4)
    const propsBeforePlace = await page.evaluate(() => (window as any).lab.spawn.inspect().items.props.length)
    await page.getByRole("button", { name: "Category Objects", exact: true }).click()
    await page.locator('[data-catalog-id="spawn-prop:hydrant"]').click()
    await page.locator("canvas").focus()
    await page.keyboard.press("]")
    await page.keyboard.press("ArrowRight")
    await page.keyboard.press("Enter")
    await step(2)
    const propsAfterPlace = await page.evaluate(() => (window as any).lab.spawn.inspect().items.props.length)
    assert.equal(propsAfterPlace, propsBeforePlace + 1, "Ghost placement committed hydrant at ground")
    await page.keyboard.press("Meta+z")
    await step(1)
    assert.equal(await page.evaluate(() => (window as any).lab.spawn.inspect().items.props.length), propsBeforePlace, "Undo removed placed hydrant")
    await page.keyboard.press("Meta+Shift+z")
    await step(1)
    assert.equal(await page.evaluate(() => (window as any).lab.spawn.inspect().items.props.length), propsBeforePlace + 1, "Redo restored placed hydrant")

    // Enter Play (P), drive into cones, exit Play (Esc) while holding W, then adjust Inspector without stuck movement
    await page.locator("canvas").focus()
    await page.keyboard.press("p")
    assert.equal(await page.evaluate(() => (window as any).lab.workbench.getMode()), "play")
    await page.keyboard.down("w")
    await step(45)
    const playState = await page.evaluate(() => (window as any).lab.spawn.inspect())
    assert(playState.character.speed > 5, "Car drove forward in Play mode")
    if (hostIdx === 0) await page.screenshot({ path: resolve(out, "after-spawn-play.png") })

    await page.keyboard.press("Escape")
    await step(1)
    await page.keyboard.up("w")
    const editState = await page.evaluate(() => ({
      mode: (window as any).lab.workbench.getMode(),
      throttle: (window as any).lab.spawn.inspect().character.input.throttle,
    }))
    assert.equal(editState.mode, "edit")
    assert.equal(editState.throttle, 0, "Esc released throttle with zero stuck movement")

    // Adjust inspector in Edit mode after exiting Play
    await page.getByRole("slider", { name: "Position X", exact: true }).focus()
    await page.keyboard.press("ArrowRight")
    await step(2)
    assert.equal(await page.evaluate(() => (window as any).lab.spawn.inspect().character.input.throttle), 0)
    if (hostIdx === 0) await page.screenshot({ path: resolve(out, "after-spawn-edit.png") })

    // 4. Audio selected but silent until explicit Audition
    await page.getByRole("button", { name: "Category Audio", exact: true }).click()
    await page.locator('[data-catalog-id="audio-source:impact_crash_layered"]').click()
    const audioInitial = await page.evaluate(() => ({
      attempts: (window as any).__audioAttempts,
      playing: (window as any).audioLab.settings.playing,
      state: (window as any).audioLab.runtime.telemetry().state,
    }))
    assert.deepEqual(audioInitial, { attempts: 0, playing: false, state: "uninitialized" })
    await page.getByRole("button", { name: "Render offline", exact: true }).click()
    await page.waitForFunction(() => !!(window as any).audioLab.lastStats)
    await step(1)
    assert.equal(await page.evaluate(() => (window as any).__audioAttempts), 0, "Still silent after offline render")
    if (hostIdx === 0) await page.screenshot({ path: resolve(out, "after-audio-silent.png") })

    // 5. Unified preset export/import validation (reject invalid, keep scene intact)
    const exported = await page.evaluate(() => (window as any).lab.workbench.exportPreset())
    const invalidRes = await page.evaluate(() => (window as any).lab.workbench.importPreset('{"version": 99, "section": "unknown"}'))
    assert.equal(invalidRes.ok, false, "Invalid preset schema rejected")
    assert.equal(await page.evaluate(() => (window as any).lab.settings.section), "audio", "Scene retained after invalid preset")
    const validRes = await page.evaluate((json: string) => (window as any).lab.workbench.importPreset(json), exported)
    assert.equal(validRes.ok, true, "Valid preset imported")

    // 6. Responsive 1920x1080 check
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.getByRole("button", { name: "Category Effects", exact: true }).click()
    await page.locator('[data-catalog-id="fixture:flame-hydrant"]').click()
    await step(45)
    const dims1920 = await page.evaluate(() => {
      const c = document.querySelector("canvas")!
      const vp = document.querySelector("[data-lab-viewport]")!
      return { cw: c.width, ch: c.height, vw: vp.clientWidth, vh: vp.clientHeight }
    })
    assert.equal(dims1920.cw, dims1920.vw)
    assert.equal(dims1920.ch, dims1920.vh)
    if (hostIdx === 0) await page.screenshot({ path: resolve(out, "after-flame-hydrant-1920x1080.png") })

    report[game] = {
      adapter,
      dims1280,
      dims1920,
      glassDomAudit: { groups: glassDomAudit.groups, inputCount: glassDomAudit.inputCount },
      enlargedSize,
      rerolledSeed: afterReroll.seed,
      propsPlaced: propsAfterPlace,
      playSpeed: +playState.character.speed.toFixed(2),
      throttleAfterEsc: editState.throttle,
      audioSilent: audioInitial,
      presetValidation: { invalidRejected: !invalidRes.ok, validAccepted: validRes.ok },
    }
    await page.close()
  }

  if (errors.length) throw new Error(errors.join("\n"))
  writeFileSync(resolve(out, "workbench-proof.json"), JSON.stringify(report, null, 2) + "\n")
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser.close()
  for (const s of servers) await s.close()
}
