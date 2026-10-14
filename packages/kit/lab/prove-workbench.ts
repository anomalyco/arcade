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
    const dir = resolve(root, "games/lab") // One Lab app; both former hosts load the same sections
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

    await page.goto(`${url}/?bench`)
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
    await page.keyboard.press("ContextMenu")
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

    // RMB drag (>8px) orbits camera with 0 prop mutations and does not open radial menu
    const canvasBox = (await page.locator("canvas").boundingBox())!
    const cx = canvasBox.x + canvasBox.width * 0.5
    const cy = canvasBox.y + canvasBox.height * 0.5
    const propsBeforeDeadZone = await page.evaluate(() => (window as any).lab.spawn.inspect().items.props.length)
    await page.mouse.move(cx, cy)
    await page.mouse.down({ button: "right" })
    await page.mouse.move(cx + 35, cy - 20, { steps: 4 })
    await page.mouse.up({ button: "right" })
    assert.equal(await page.evaluate(() => (window as any).lab.spawn.inspect().items.props.length), propsBeforeDeadZone, "RMB drag orbited with 0 mutations")
    assert.equal(await page.evaluate(() => document.querySelector<HTMLElement>("[data-lab-radial]")!.hidden), true, "RMB drag did not open radial menu")

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

    // 8. Transform Gizmo & Modal (G move + numeric entry + Shift+R rotate) + Context-Aware Viewport Cursor States
    await page.evaluate(() => {
      const s = (window as any).lab.sections.find((x: any) => x.id === "spawn")
      const firstProp = s.objects().find((o: any) => o.category === "prop")
      if (firstProp) s.selectObject(firstProp.id)
    })
    await step(2)
    // Hover Rotate gizmo handle -> cursor state "rotate"
    const rotateHandleBox = (await page.locator('[data-gizmo-handle="rotate"]').boundingBox())!
    await page.mouse.move(rotateHandleBox.x + rotateHandleBox.width / 2, rotateHandleBox.y + rotateHandleBox.height / 2)
    assert.equal(await page.evaluate(() => (window as any).lab.workbench.cursor.state), "rotate", "Cursor adapts to rotate handle")
    if (hostIdx === 0) await page.screenshot({ path: resolve(out, "after-transform-gizmo.png") })

    // Select car, verify ground-plane ellipse rotate ring and drag rotate handle to 125° around ground ring
    const carRotateTarget = await page.evaluate(async () => {
      const s = (window as any).lab.sections.find((x: any) => x.id === "spawn")
      s.selectObject("character:active")
      const st = (window as any).lab.context.stage
      st.frameTarget(0, 0.4, 6, 15)
      ;(window as any).lab.context.sync()
      await (window as any).lab.render()
      const car = s.objects().find((o: any) => o.id === "character:active")!
      const ringRadius = car.radius ?? 0.75
      const ringY = car.y + 0.02 + 0.03 * ringRadius
      const targetRad = (125 * Math.PI) / 180
      const wx = car.x + Math.sin(targetRad) * ringRadius
      const wz = car.z + Math.cos(targetRad) * ringRadius
      const p = st.projectWorld(wx, ringY, wz)
      const rect = document.querySelector("canvas")!.getBoundingClientRect()
      return {
        targetScreenX: rect.left + p.u * rect.width,
        targetScreenY: rect.top + p.v * rect.height,
      }
    })
    await step(1)
    if (hostIdx === 0) await page.screenshot({ path: resolve(out, "after-car-rotate-ring-initial.png") })
    const carHandleBox0 = (await page.locator('[data-gizmo-handle="rotate"]').boundingBox())!
    await page.mouse.move(carHandleBox0.x + carHandleBox0.width / 2, carHandleBox0.y + carHandleBox0.height / 2)
    await page.mouse.down({ button: "left" })
    await page.mouse.move(carRotateTarget.targetScreenX, carRotateTarget.targetScreenY, { steps: 6 })
    await step(1)
    if (hostIdx === 0) await page.screenshot({ path: resolve(out, "after-car-rotate-ring-dragged.png") })
    const carHandleBox1 = (await page.locator('[data-gizmo-handle="rotate"]').boundingBox())!
    const handleCenter1 = {
      x: carHandleBox1.x + carHandleBox1.width / 2,
      y: carHandleBox1.y + carHandleBox1.height / 2,
    }
    const handleTrackErr = Math.hypot(handleCenter1.x - carRotateTarget.targetScreenX, handleCenter1.y - carRotateTarget.targetScreenY)
    assert(handleTrackErr < 4, `Expected rotate handle to stay under cursor (<4px), got ${handleTrackErr.toFixed(2)}px`)
    const liveYawInput = Number(await page.locator('[data-transform-input="yaw"]').inputValue())
    assert(Math.abs(liveYawInput - 125) <= 2, `Expected live numeric yaw input ~125°, got ${liveYawInput}°`)
    await page.mouse.up({ button: "left" })
    await page.keyboard.press("Meta+z") // Undo car rotation back to 180°
    await step(1)
    await page.evaluate(() => {
      const s = (window as any).lab.sections.find((x: any) => x.id === "spawn")
      const firstProp = s.objects().find((o: any) => o.category === "prop")
      if (firstProp) s.selectObject(firstProp.id)
    })
    await step(1)

    // Hover selectable car -> cursor state "hover" + delayed target label after 200ms
    const carScreen = await page.evaluate(() => {
      const st = (window as any).lab.context.stage
      const vp = document.querySelector("[data-lab-viewport]")!.getBoundingClientRect()
      const s = (window as any).lab.sections.find((x: any) => x.id === "spawn")
      const car = s.objects().find((o: any) => o.id === "character:active")!
      const p = st.projectWorld(car.x, car.y + 0.35, car.z)
      return { x: vp.left + p.u * vp.width, y: vp.top + p.v * vp.height }
    })
    await page.mouse.move(carScreen.x, carScreen.y)
    assert.equal(await page.evaluate(() => (window as any).lab.workbench.cursor.state), "hover", "Cursor state is hover over selectable object")
    await page.waitForFunction(() => (window as any).lab.workbench.cursor.labelVisible, undefined, { timeout: 2000 })
    if (hostIdx === 0) await page.screenshot({ path: resolve(out, "cursor-hover-object.png") })

    // Hover empty sloped ramp (x=10, z=-3) -> cursor state "default" with surface normal + 3D reticle marker
    const rampScreen = await page.evaluate(async () => {
      const st = (window as any).lab.context.stage
      st.frameTarget(10, 0.4, -3, 16)
      await (window as any).lab.render()
      const vp = document.querySelector("[data-lab-viewport]")!.getBoundingClientRect()
      const p = st.projectWorld(10, 0.5, -3)
      return { x: vp.left + p.u * vp.width, y: vp.top + p.v * vp.height }
    })
    await page.mouse.move(rampScreen.x, rampScreen.y)
    await step(1)
    const rampCursor = await page.evaluate(() => ({
      state: (window as any).lab.workbench.cursor.state,
      sample: (window as any).lab.workbench.cursor.groundSample,
      pointerLock: document.pointerLockElement,
    }))
    assert.equal(rampCursor.state, "default", "Cursor state is default reticle over empty ground")
    assert(rampCursor.sample && rampCursor.sample.slopeDeg > 4, "Ground reticle sampled sloped ramp surface normal")
    assert.equal(rampCursor.pointerLock, null, "Never uses pointer lock in Edit mode")
    if (hostIdx === 0) await page.screenshot({ path: resolve(out, "cursor-ground-reticle.png") })

    await page.evaluate(async () => {
      const st = (window as any).lab.context.stage
      st.frameTarget(0, 0.4, 2, 18)
      await (window as any).lab.render()
    })

    // Hover disabled radial sector (Possess on a prop) -> cursor state "disabled"
    const propScreen = await page.evaluate(() => {
      const st = (window as any).lab.context.stage
      const vp = document.querySelector("[data-lab-viewport]")!.getBoundingClientRect()
      const s = (window as any).lab.sections.find((x: any) => x.id === "spawn")
      const prop = s.objects().find((o: any) => o.category === "prop")!
      const p = st.projectWorld(prop.x, prop.y + 0.35, prop.z)
      return { x: vp.left + p.u * vp.width, y: vp.top + p.v * vp.height }
    })
    await page.mouse.click(propScreen.x, propScreen.y, { button: "right" })
    // Move NE (slot 1 = Possess, disabled on prop)
    await page.mouse.move(propScreen.x + 55, propScreen.y - 55)
    assert.equal(await page.evaluate(() => (window as any).lab.workbench.cursor.state), "disabled", "Cursor state is disabled over unavailable radial sector")
    if (hostIdx === 0) await page.screenshot({ path: resolve(out, "cursor-disabled-radial.png") })
    await page.keyboard.press("Escape")

    // Hover text input / sidebar -> cursor state "hidden" (native OS cursor)
    const searchBoxRect = (await page.getByRole("searchbox", { name: "Search library" }).boundingBox())!
    await page.mouse.move(searchBoxRect.x + 20, searchBoxRect.y + 10)
    assert.equal(await page.evaluate(() => (window as any).lab.workbench.cursor.state), "hidden", "Custom cursor hides over UI panels and text inputs")

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

    // Verify Shift+LMB drag grab-pan keeps ground point under cursor even when car is selected
    const grabStart = { x: canvasBox.x + canvasBox.width * 0.38, y: canvasBox.y + canvasBox.height * 0.58 }
    const grabEnd = { x: canvasBox.x + canvasBox.width * 0.62, y: canvasBox.y + canvasBox.height * 0.44 }
    const worldBeforeGrab = await page.evaluate(({ x, y }) => {
      const s = (window as any).lab.sections.find((sec: any) => sec.id === "spawn")
      s.selectObject("character:active")
      const c = document.querySelector("canvas")!.getBoundingClientRect()
      const st = (window as any).lab.context.stage
      return st.pickPlaneY((x - c.left) / c.width, (y - c.top) / c.height, st.focus[1])
    }, grabStart)
    await page.keyboard.down("Shift")
    await page.mouse.move(grabStart.x, grabStart.y)
    await page.mouse.down({ button: "left" })
    await page.mouse.move(grabEnd.x, grabEnd.y, { steps: 6 })
    await page.mouse.up({ button: "left" })
    await page.keyboard.up("Shift")
    await step(1)
    const worldAfterGrab = await page.evaluate(({ x, y }) => {
      const c = document.querySelector("canvas")!.getBoundingClientRect()
      const st = (window as any).lab.context.stage
      return st.pickPlaneY((x - c.left) / c.width, (y - c.top) / c.height, st.focus[1])
    }, grabEnd)
    const grabErr = Math.hypot(worldAfterGrab.x - worldBeforeGrab.x, worldAfterGrab.z - worldBeforeGrab.z)
    assert(grabErr < 0.05, `Expected Shift+drag grab-pan to keep ground point under cursor (<0.05m), got ${grabErr.toFixed(4)}m`)

    // 10. Frozen-frame deterministic re-simulation + A/B Slot Flip (V) & Split Wipe (Shift+V) + Copy Game Recipe
    await page.locator('[data-catalog-id="fixture:smoke-room"]').click()
    await page.evaluate(() => {
      const s = (window as any).lab.sections.find((x: any) => x.id === "effects")
      s.settings.targetX = 0
      s.settings.targetZ = 0
      s.settings.radius = 2.0
      s.settings.extinction = 0.5
      s.retrigger()
    })
    await step(35)
    await page.locator("canvas").focus()
    await page.keyboard.press("k") // Pause at f35
    await page.keyboard.press("b") // Pin Slot A at f35 (radius=2.0, extinction=0.5)
    const radiusSlider = page.getByRole("slider", { name: "Radius", exact: true })
    await radiusSlider.focus()
    for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowRight")
    const extinctionSlider = page.getByRole("slider", { name: "Extinction", exact: true })
    await extinctionSlider.focus()
    for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowRight")
    await page.locator("canvas").focus()
    const abAfterScrub = await page.evaluate(() => ({
      frames: (window as any).lab.workbench.compare.frames,
      diffs: (window as any).lab.workbench.compare.diffs,
      activeSlot: (window as any).lab.workbench.compare.activeSlot,
    }))
    assert.equal(abAfterScrub.frames, 35, "Scrubbing while paused kept frame locked at f35")
    assert(abAfterScrub.diffs.some((d: any) => d.key === "radius"), "Slot B recorded parameter delta vs Slot A")

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

    // 12. Outliner + Details + Library drawer + ⌘K + Watch, at 1920x1080 and 1280x800
    const layoutReport: Record<string, unknown> = {}
    for (const size of [{ width: 1920, height: 1080 }, { width: 1280, height: 800 }]) {
      await page.setViewportSize(size)
      layoutReport[`${size.width}x${size.height}`] = await layoutPass(page, step, size.width, hostIdx === 0)
    }

    report[game] = {
      layout: layoutReport,
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

type Page = Awaited<ReturnType<typeof browser.newPage>>

async function detailsGroups(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector("[data-lab]")!.shadowRoot!
    return [...root.querySelectorAll("[data-controls] h3 .fold")].map(el => (el.textContent ?? "").replace(/^[▾▸]\s*/, "").trim())
  })
}

async function selected(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).lab.workbench.getSelectedIds())
}

async function invoke(page: Page, id: string, args?: Record<string, unknown>) {
  const res = await page.evaluate(([i, a]) => (window as any).lab.workbench.invoke(i, a, { source: "cli" }), [id, args] as const)
  assert.equal(res.ok, true, `${id} failed: ${res.error}`)
  return res.result
}

async function layoutPass(page: Page, step: (n: number) => Promise<void>, width: number, capture: boolean) {
  const shot = async (name: string) => {
    if (capture) await page.screenshot({ path: resolve(out, `layout-${name}-${width}.png`) })
  }
  const outRow = (text: string) => page.locator(".lab-trow", { hasText: text }).first()
  await invoke(page, "library.toggle", { open: true, category: "effects" })
  await page.locator('[data-catalog-id="fixture:car-cones"]').click()
  await step(3)
  await page.locator("canvas").focus()
  await page.keyboard.press("Escape")
  await step(1)

  // Outliner: only scene objects, grouped by type with counts, repeated kinds folded
  const tree = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-outliner-tree] .lab-trow")].map(el => ({
      type: el.dataset.rowType,
      text: [el.querySelector(".lab-tname")?.textContent, el.querySelector(".lab-tcount")?.textContent].filter(Boolean).join(" ").replace(/\s+/g, " ").trim(),
    })),
  )
  const groups = tree.filter(r => r.type === "group").map(r => r.text)
  assert(groups.includes("Vehicles 1"), `Vehicles group with count, got ${JSON.stringify(groups)}`)
  assert(groups.includes("Props 6"), `Props group with count 6, got ${JSON.stringify(groups)}`)
  assert(tree.some(r => r.type === "fold" && r.text === "Cone ×5"), "Five cones fold into one 'Cone ×5' row")
  assert(!tree.some(r => /Place |Fixture/.test(r.text ?? "")), "Outliner lists scene objects only, never Library items")
  assert.equal((await detailsGroups(page))[0], "Environment", "Nothing selected shows scene/environment settings first")
  await shot("outliner-scene")

  // Fold row selects all members; Details shows shared transform plus item settings only
  await page.locator(".lab-tfold", { hasText: "Cone" }).click()
  await step(1)
  const coneIds = await selected(page)
  assert.equal(coneIds.length, 5, "Clicking the fold selects all five cones")
  const multiGroups = await detailsGroups(page)
  assert.equal(multiGroups[0], "Transform", "Transform comes first for a selection")
  assert(multiGroups.includes("Items") && !multiGroups.includes("Vehicle & Skids"), `Multi-select Details stays relevant, got ${multiGroups}`)
  assert.equal(await page.locator(".lab-inspector-title").textContent(), "5 objects")
  await shot("multiselect")

  // Single vehicle selection: Transform, Character, Vehicle & Skids
  await outRow("Getaway · Muscle").click()
  await step(1)
  assert.deepEqual(await selected(page), ["character:active"])
  assert.deepEqual(await detailsGroups(page), ["Transform", "Character", "Vehicle & Skids"])
  await shot("select-vehicle")

  // Shift-click range from the vehicle to the propane tank
  await outRow("Propane").click({ modifiers: ["Shift"] })
  await step(1)
  const range = await selected(page)
  assert(range.length === 7 && range.includes("character:active"), `Shift range selects vehicle..propane, got ${range}`)

  // Viewport click selects a cone and the Outliner reveals and highlights it
  await page.locator("canvas").focus()
  await page.keyboard.press("Escape")
  await step(1)
  const conePoint = await page.evaluate(() => {
    const st = (window as any).lab.context.stage
    const s = (window as any).lab.sections.find((x: any) => x.id === "spawn")
    const cone = s.objects().find((o: any) => o.kind === "cone")
    const p = st.projectWorld(cone.x, cone.y + 0.35, cone.z)
    const r = document.querySelector("canvas")!.getBoundingClientRect()
    return { id: cone.id, x: r.left + p.u * r.width, y: r.top + p.v * r.height }
  })
  await page.mouse.click(conePoint.x, conePoint.y)
  await step(1)
  assert.deepEqual(await selected(page), [conePoint.id], "Viewport click selected the cone")
  assert.equal(await page.locator(`.lab-tobj[data-object-id="${conePoint.id}"]`).getAttribute("aria-selected"), "true", "Outliner reveals viewport selection")

  // Keyboard: Shift+Tab focuses the Outliner, arrows move the selection, Escape returns to the canvas
  await page.locator("canvas").focus()
  await page.keyboard.press("Shift+Tab")
  assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute("data-outliner-tree")), true, "Shift+Tab focuses the Outliner")
  await page.keyboard.press("ArrowDown")
  await step(1)
  const afterArrow = await selected(page)
  assert(afterArrow.length === 1 && afterArrow[0] !== conePoint.id, "ArrowDown moved the selection to the next row")
  await page.keyboard.press("Escape")
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "CANVAS")

  // Lock makes an object unpickable in the viewport
  await invoke(page, "outliner.lock", { id: conePoint.id, locked: true })
  await page.keyboard.press("Escape")
  await page.mouse.click(conePoint.x, conePoint.y)
  await step(1)
  assert(!(await selected(page)).includes(conePoint.id), "Locked cone is not pickable")
  await invoke(page, "outliner.lock", { id: conePoint.id, locked: false })

  // Modified highlight, Modified-only filter, per-field reset as one undo entry
  await invoke(page, "outliner.select", { id: "character:active" })
  await invoke(page, "scene.set-param", { key: "skidWidth", value: 0.3 })
  await step(1)
  const modifiedFlag = await page.evaluate(() => document.querySelector("[data-lab]")!.shadowRoot!.querySelector('label:has([data-key="skidWidth"])')!.getAttribute("data-modified"))
  assert.equal(modifiedFlag, "true", "Non-default value is highlighted")
  const filtered = await invoke(page, "details.filter", { modified: true })
  assert(filtered.visible.includes("skidWidth") && !filtered.visible.includes("skidLife"), `Modified only shows changed fields, got ${filtered.visible}`)
  await shot("modified-filter")
  await invoke(page, "details.filter", { modified: false })

  // Watch pin: pin from the row, live value, jump back
  const root = page.locator("[data-lab]")
  await root.locator('label:has([data-key="skidWidth"])').hover()
  await root.locator('[aria-label="Pin Skid width to Watch"]').click()
  await invoke(page, "watch.pin", { key: "exposure", section: "lighting", pinned: true })
  await page.waitForFunction(() => document.querySelectorAll("[data-lab-watch] .lab-watch-row").length === 2)
  const watchValue = await page.locator('[data-watch-key="spawn:skidWidth"] .lab-watch-value').textContent()
  assert.equal(watchValue, "0.3 m", "Watch shows the live pinned value")
  await root.locator('[aria-label="Reset Skid width to default"]').click()
  await step(1)
  assert.equal(await page.evaluate(() => (window as any).lab.sections.find((s: any) => s.id === "spawn").settings.skidWidth), 0.16, "Per-field reset restores the default")
  assert.equal(await page.locator('[data-watch-key="spawn:skidWidth"] .lab-watch-value').textContent(), "0.16 m", "Watch follows the reset")
  await page.locator("canvas").focus()
  await page.keyboard.press("Meta+z")
  assert.equal(await page.evaluate(() => (window as any).lab.sections.find((s: any) => s.id === "spawn").settings.skidWidth), 0.3, "Undo restores the value before the field reset")
  await shot("watch-pins")

  // ⌘K: scene objects, commands and settings in one search
  await page.keyboard.press("Meta+k")
  await page.keyboard.type("propane")
  await shot("palette")
  const paletteKinds = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".lab-palette-item")].map(el => el.dataset.kind))
  assert.equal(paletteKinds[0], "object", "Scene object ranks first for its name")
  await page.keyboard.press("Enter")
  await step(1)
  const propaneSel = await selected(page)
  assert(propaneSel.length === 1 && propaneSel[0]!.startsWith("prop:"), "⌘K selected the propane tank")
  await page.keyboard.press("Meta+k")
  await page.keyboard.type("skid life")
  await page.keyboard.press("Enter")
  await step(1)
  assert.equal(await page.evaluate(() => (window as any).lab.context && document.querySelector<any>("[data-lab]").shadowRoot.activeElement?.dataset.row), "skidLife", "⌘K setting jump focuses the field")
  await page.locator("canvas").focus()
  await page.keyboard.press("Meta+k")
  await page.keyboard.type(">toggle library")
  await page.keyboard.press("Enter")
  assert.equal((await page.evaluate(() => (window as any).lab.workbench.state().layout.library.open)), false, "⌘K ran the Library toggle command")
  await page.locator("canvas").focus()
  await shot("drawer-closed")
  await page.keyboard.press("Control+Space")
  assert.equal((await page.evaluate(() => (window as any).lab.workbench.state().layout.library.open)), true, "Ctrl+Space reopens the Library")

  // Library: drag a prop into the viewport to place it at the ground point
  await page.locator("canvas").focus()
  await page.getByRole("button", { name: "Category Objects", exact: true }).click()
  const propsBefore = await page.evaluate(() => (window as any).lab.spawn.inspect().items.props.length)
  const tile = page.locator('[data-catalog-id="spawn-prop:barrier"]')
  await tile.scrollIntoViewIfNeeded()
  const tb = (await tile.boundingBox())!
  const vb = (await page.locator("canvas").boundingBox())!
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2)
  await page.mouse.down()
  await page.mouse.move(vb.x + vb.width * 0.7, vb.y + vb.height * 0.4, { steps: 10 })
  await step(1)
  await shot("library-drag")
  await page.mouse.up()
  await step(1)
  assert.equal(await page.evaluate(() => (window as any).lab.spawn.inspect().items.props.length), propsBefore + 1, "Dragging a Library tile placed the prop")
  const dropped = await selected(page)
  assert.equal(dropped.length, 1, "Dropped prop is selected")

  // CLI-equivalent registry commands for the new layout
  const placed = await invoke(page, "library.place", { id: "spawn-prop:cone", at: "4,6" })
  assert.equal(placed.placed, true)
  const cones = await invoke(page, "outliner.select", { kind: "cone" })
  assert.equal(cones.selected.length, 6, "outliner.select kind=cone selects every cone")
  await shot("library-placed")
  await invoke(page, "watch.unpin", { all: true })
  await page.keyboard.press("Escape")
  return { groups, multiGroups, coneCount: coneIds.length, rangeCount: range.length, dropped: dropped[0] }
}
