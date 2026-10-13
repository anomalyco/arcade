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
      if (m.type() === "error") errors.push(`${game}: ${m.text()}`)
    })
    await page.addInitScript(() => {
      ;(window as any).__audioAttempts = 0
      window.AudioContext = class {
        constructor() {
          ;(window as any).__audioAttempts++
          throw new Error("Live audio is disabled in this proof")
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

    // 6. Radial Menu: 8 fixed compass sectors, disabled-in-place slots, <14px dead zone cancel, tap-to-latch + accelerator
    await page.getByRole("button", { name: "Category Effects", exact: true }).click()
    await page.locator('[data-catalog-id="fixture:car-cones"]').click()
    await step(4)
    await page.locator("canvas").focus()
    await page.keyboard.press("m")
    const radialAudit = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>("[data-lab-radial]")!
      const sectors = [...root.querySelectorAll<HTMLElement>(".lab-radial-sector")].map(el => ({
        slot: Number(el.dataset.sector),
        compass: el.dataset.compass,
        angle: Number(el.dataset.angle),
        disabled: el.getAttribute("aria-disabled") === "true",
      }))
      return { visible: !root.hidden, phase: root.dataset.phase, sectors }
    })
    assert.equal(radialAudit.visible, true, "Radial menu opened via M key")
    assert.equal(radialAudit.phase, "latched", "Keyboard M opens radial menu in latched state")
    assert.deepEqual(
      radialAudit.sectors.map(s => s.angle),
      [0, 45, 90, 135, 180, 225, 270, 315],
      "8 fixed compass angles never shift",
    )
    if (hostIdx === 0) await page.screenshot({ path: resolve(out, "after-radial-menu.png") })
    await page.keyboard.press("Escape")
    assert.equal(await page.evaluate(() => document.querySelector<HTMLElement>("[data-lab-radial]")!.hidden), true)

    // Hold RMB > 180ms inside <14px dead zone cancels with 0 actions
    const canvasBox = (await page.locator("canvas").boundingBox())!
    const cx = canvasBox.x + canvasBox.width * 0.5
    const cy = canvasBox.y + canvasBox.height * 0.5
    const propsBeforeDeadZone = await page.evaluate(() => (window as any).lab.spawn.inspect().items.props.length)
    await page.mouse.move(cx, cy)
    await page.mouse.down({ button: "right" })
    await page.mouse.move(cx + 5, cy - 4)
    await page.waitForTimeout(210)
    await page.mouse.up({ button: "right" })
    assert.equal(await page.evaluate(() => (window as any).lab.spawn.inspect().items.props.length), propsBeforeDeadZone, "Dead zone cancel executed 0 mutations")

    // Action-count acceptance test: RMB on ground -> 'a' (Spawn Here) places hydrant, P + W drives into it, Esc restores unbroken prePlayCheckpoint
    await page.evaluate(() => {
      const s = (window as any).lab.sections.find((x: any) => x.id === "spawn")
      s.settings.item = "hydrant"
      s.selectObjects?.([])
    })
    await page.mouse.click(cx, cy - 20, { button: "right" })
    await page.keyboard.press("a")
    await step(2)
    const propsAfterRadialSpawn = await page.evaluate(() => (window as any).lab.spawn.inspect().items.props.length)
    assert.equal(propsAfterRadialSpawn, propsBeforeDeadZone + 1, "Radial Spawn Here placed hydrant in 1 gesture")

    await page.keyboard.press("p")
    await page.keyboard.down("w")
    await step(38)
    await page.keyboard.press("Escape")
    await page.keyboard.up("w")
    await step(2)
    const postEscCheckpoint = await page.evaluate(() => {
      const insp = (window as any).lab.spawn.inspect()
      return {
        mode: (window as any).lab.workbench.getMode(),
        speed: insp.character.speed,
        brokenCount: insp.items.props.filter((p: any) => p.broken).length,
        totalProps: insp.items.props.length,
      }
    })
    assert.equal(postEscCheckpoint.mode, "edit")
    assert.equal(postEscCheckpoint.speed, 0, "Car velocity restored to 0 from pre-Play checkpoint")
    assert.equal(postEscCheckpoint.brokenCount, 0, "All props restored unbroken from pre-Play checkpoint")
    assert.equal(postEscCheckpoint.totalProps, propsAfterRadialSpawn, "Placed hydrant retained across Play/Esc checkpoint restore")

    // 7. Marquee Box Select (Alt+Drag) + Multi-Select Inspector + Group Duplicate/Delete + Single-Transaction Undo
    await page.mouse.move(canvasBox.x + 80, canvasBox.y + 80)
    await page.keyboard.down("Alt")
    await page.mouse.down({ button: "left" })
    await page.mouse.move(canvasBox.x + canvasBox.width - 80, canvasBox.y + canvasBox.height - 80, { steps: 5 })
    if (hostIdx === 0) await page.screenshot({ path: resolve(out, "after-marquee-multiselect.png") })
    await page.mouse.up({ button: "left" })
    await page.keyboard.up("Alt")
    await step(1)
    const marqueeSelectedIds = await page.evaluate(() => (window as any).lab.workbench.getSelectedIds())
    assert(marqueeSelectedIds.length >= 3, `Expected marquee to select >=3 props, got ${marqueeSelectedIds.length}`)

    // Group delete in 1 transaction and Undo in 1 keystroke
    const countBeforeGroupDelete = await page.evaluate(() => (window as any).lab.spawn.inspect().items.props.length)
    await page.locator("canvas").focus()
    await page.keyboard.press("Backspace")
    await step(1)
    const countAfterGroupDelete = await page.evaluate(() => (window as any).lab.spawn.inspect().items.props.length)
    assert(countAfterGroupDelete < countBeforeGroupDelete, "Group delete removed selected props")
    await page.keyboard.press("Meta+z")
    await step(1)
    assert.equal(
      await page.evaluate(() => (window as any).lab.spawn.inspect().items.props.length),
      countBeforeGroupDelete,
      "Single Meta+Z restored entire deleted group",
    )

    // 8. Transform Gizmo & Modal (G move + numeric entry + Shift+R rotate)
    await page.evaluate(() => {
      const s = (window as any).lab.sections.find((x: any) => x.id === "spawn")
      const firstProp = s.objects().find((o: any) => o.category === "prop")
      if (firstProp) s.selectObject(firstProp.id)
    })
    await step(2)
    if (hostIdx === 0) await page.screenshot({ path: resolve(out, "after-transform-gizmo.png") })
    await page.locator("canvas").focus()
    await page.keyboard.press("g")
    for (const ch of ["3", ".", "5"]) await page.keyboard.press(ch)
    await page.keyboard.press("Enter")
    await step(1)
    const movedX = await page.evaluate(() => {
      const s = (window as any).lab.sections.find((x: any) => x.id === "spawn")
      return s.settings.selectedX
    })
    assert.equal(movedX, 3.5, "Modal G + numeric entry set exact X = 3.5m")

    // 9. Trackpad gestures: Ctrl+wheel pinch zoom, two-finger scroll orbit, Shift+scroll pan, Meta+wheel ignored
    const camBeforeWheel = await page.evaluate(() => {
      const st = (window as any).lab.context.stage
      return { yaw: st.camYaw, dist: st.camDist, focusX: st.focus[0] }
    })
    const metaNotPrevented = await page.locator("canvas").evaluate(el =>
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: 60, metaKey: true, cancelable: true })),
    )
    assert.equal(metaNotPrevented, true, "Meta+wheel is never hijacked")
    await page.locator("canvas").evaluate(el => {
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: -50, ctrlKey: true, cancelable: true }))
      el.dispatchEvent(new WheelEvent("wheel", { deltaX: 40, deltaY: -20, cancelable: true }))
      el.dispatchEvent(new WheelEvent("wheel", { deltaX: 30, deltaY: 30, shiftKey: true, cancelable: true }))
    })
    await step(6)
    const camAfterWheel = await page.evaluate(() => {
      const st = (window as any).lab.context.stage
      return { yaw: st.camYaw, dist: st.camDist, focusX: st.focus[0] }
    })
    assert(camAfterWheel.dist < camBeforeWheel.dist, "Ctrl+wheel pinch zoomed camera in")
    assert.notEqual(camAfterWheel.yaw, camBeforeWheel.yaw, "Two-finger scroll orbited camera")
    assert.notEqual(camAfterWheel.focusX, camBeforeWheel.focusX, "Shift + two-finger scroll panned camera")

    // 10. Frozen-frame deterministic re-simulation + A/B Slot Flip (V) & Split Wipe (Shift+V) + Copy Game Recipe
    await page.locator('[data-catalog-id="fixture:smoke-room"]').click()
    await page.evaluate(() => {
      const s = (window as any).lab.sections.find((x: any) => x.id === "effects")
      s.settings.targetX = 0
      s.settings.targetZ = 0
      s.settings.size = 0.35
      s.settings.density = 0.25
      s.retrigger()
    })
    await step(35)
    await page.locator("canvas").focus()
    await page.keyboard.press("k") // Pause at f35
    await page.keyboard.press("b") // Pin Slot A at f35 (size=0.35, density=0.25)
    const sizeSlider = page.getByRole("slider", { name: "Size", exact: true })
    await sizeSlider.focus()
    for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowRight")
    const densitySlider = page.getByRole("slider", { name: "Density", exact: true })
    await densitySlider.focus()
    for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowRight")
    await page.locator("canvas").focus()
    const abAfterScrub = await page.evaluate(() => ({
      frames: (window as any).lab.workbench.compare.frames,
      diffs: (window as any).lab.workbench.compare.diffs,
      activeSlot: (window as any).lab.workbench.compare.activeSlot,
    }))
    assert.equal(abAfterScrub.frames, 35, "Scrubbing while paused kept frame locked at f35")
    assert(abAfterScrub.diffs.some((d: any) => d.key === "size"), "Slot B recorded parameter delta vs Slot A")

    await page.keyboard.press("v") // Flip to Slot A
    assert.equal(await page.evaluate(() => (window as any).lab.workbench.compare.activeSlot), "A")
    await page.keyboard.press("v") // Flip back to Slot B
    assert.equal(await page.evaluate(() => (window as any).lab.workbench.compare.activeSlot), "B")

    await page.keyboard.press("Shift+V") // Toggle Split-Screen Wipe
    await page.waitForTimeout(80)
    assert.equal(await page.evaluate(() => (window as any).lab.workbench.compare.wipeEnabled), true)
    if (hostIdx === 0) await page.screenshot({ path: resolve(out, "after-compare-ab-wipe.png") })
    await page.keyboard.press("Shift+V") // Turn off wipe before 1920x1080 capture

    const recipePayload = await page.evaluate(() => (window as any).lab.workbench.exportGameRecipe())
    assert.equal(recipePayload.schema, "arcade-game-recipe/v1")
    assert(!recipePayload.codeSnippet.includes("?"), "Game recipe exports typed settings with zero URL params")

    // 11. Responsive 1920x1080 check
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
      radialAngles: radialAudit.sectors.map(s => s.angle),
      postEscCheckpoint,
      marqueeSelectedCount: marqueeSelectedIds.length,
      transformNumericX: movedX,
      compareAB: {
        frozenFrame: abAfterScrub.frames,
        diffs: abAfterScrub.diffs,
        recipeTarget: recipePayload.target,
      },
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
