// Headless Metal proof for the interactive Characters page (characters.html). Run through hivemind.
import { chromium } from "playwright-core"
import { createServer } from "vite"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { findChromeExecutable } from "./compare"

const out = join(import.meta.dir, "../../../captures/rig-page")
mkdirSync(out, { recursive: true })
const framesDir = join(out, "frames")
mkdirSync(framesDir, { recursive: true })

const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } })
await server.listen()
const address = server.httpServer!.address()
if (!address || typeof address === "string") throw new Error("Missing Vite port")
const base = `http://127.0.0.1:${address.port}`

const browser = await chromium.launch({
  executablePath: findChromeExecutable(),
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

const errors: string[] = []
const check = (ok: unknown, msg: string) => {
  if (!ok) throw new Error(msg)
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => {
    if (m.type() === "error") errors.push(m.text())
  })
  await page.addInitScript(() => {
    const audio: AudioContext[] = []
    Object.assign(window, { __audioContexts: audio })
    const Orig = window.AudioContext
    window.AudioContext = class extends Orig {
      constructor(...args: ConstructorParameters<typeof AudioContext>) {
        super(...args)
        audio.push(this)
      }
    }
  })

  await page.goto(`${base}/characters.html?manual#soldier`)
  await page.waitForFunction(() => (window as any).ready === true, null, { timeout: 30000 })

  const gpu = await page.evaluate(() => {
    const info = (window as any).charactersProof.adapter
    return { vendor: info.vendor, architecture: info.architecture, device: info.device }
  })
  check(/metal/i.test(gpu.architecture) && !/swiftshader/i.test(JSON.stringify(gpu)), `Not Metal: ${JSON.stringify(gpu)}`)

  // Verify hub navigation links and visible Lab button state
  const navLinks = await page.locator(".hub-bar nav a").evaluateAll(els =>
    els.map(el => ({ id: (el as HTMLElement).dataset.page, text: el.textContent, current: el.getAttribute("aria-current") })),
  )
  check(navLinks.some(l => l.id === "characters" && l.current === "page"), `Missing active Characters nav link: ${JSON.stringify(navLinks)}`)
  const labBtn = page.locator('[data-action="toggle-lab"]')
  check((await labBtn.getAttribute("aria-pressed")) === "true", "Lab button should indicate open state initially")

  // Toggle Lab closed for clean close-up profile captures, then re-open
  await labBtn.click()
  check((await labBtn.getAttribute("aria-pressed")) === "false", "Lab button should indicate closed state after click")

  // Capture full lineup with all 5 characters on their marks
  await page.getByRole("button", { name: "Stop" }).click()
  await page.getByRole("button", { name: "Lineup" }).click()
  await page.evaluate(() => (window as any).advance(300))
  await page.screenshot({ path: join(out, "after-lineup.png") })

  // Capture each actor walking at close range
  const actorProfiles: Record<string, unknown> = {}
  for (const id of ["soldier", "wizard", "zombie", "survivor", "outbreak-zombie"] as const) {
    await page.locator(`[data-actor-id="${id}"]`).click()
    check(page.url().endsWith(`#${id}`), `Hash did not update to #${id}: ${page.url()}`)
    await page.getByRole("button", { name: "Walk loop" }).click()
    await page.locator('[data-action="frame"]').click()
    await page.evaluate(() => (window as any).advance(900))
    await page.screenshot({ path: join(out, `after-${id}-close.png`) })
    actorProfiles[id] = await page.evaluate(actorId => {
      const p = (window as any).charactersProof
      const a = p.actors.find((x: any) => x.id === actorId)
      return {
        preset: a.preset,
        handPose: a.profile.handPose,
        pos: [a.avatar.x, a.avatar.y],
        pelvisY: a.avatar.body.pelvis.p[1],
        headY: a.avatar.body.head.p[1],
      }
    }, id)
  }

  // Also capture gameplay scale on zombie and soldier
  await page.locator('[data-actor-id="zombie"]').click()
  await page.getByRole("button", { name: "Game scale" }).click()
  await page.evaluate(() => (window as any).advance(300))
  await page.screenshot({ path: join(out, "after-zombie-game-scale.png") })

  // Re-frame close on zombie and open Lab panel with Backquote
  await page.locator('[data-action="frame"]').click()
  await page.keyboard.press("Backquote")
  check((await labBtn.getAttribute("aria-pressed")) === "true", "Backquote should open Lab panel and update Lab button")
  await page.evaluate(() => (window as any).advance(100))
  await page.screenshot({ path: join(out, "after-zombie-lab-open.png") })

  // Verify Lab panel controls only modify the selected actor (zombie) and not soldier
  const beforeLabEdit = await page.evaluate(() => {
    const p = (window as any).charactersProof
    return {
      soldierDrag: p.actors.find((x: any) => x.id === "soldier").profile.footDrag,
      zombieDrag: p.actors.find((x: any) => x.id === "zombie").profile.footDrag,
    }
  })
  await page.evaluate(() => {
    const p = (window as any).charactersProof
    const c = p.labPanel.navigation.rows.find((r: any) => r.control?.key === "footDrag")!.control
    p.labPanel.navigation.set(c, 0.55)
    p.labPanel.refresh()
  })
  const afterLabEdit = await page.evaluate(() => {
    const p = (window as any).charactersProof
    return {
      soldierDrag: p.actors.find((x: any) => x.id === "soldier").profile.footDrag,
      zombieDrag: p.actors.find((x: any) => x.id === "zombie").profile.footDrag,
    }
  })
  check(afterLabEdit.soldierDrag === beforeLabEdit.soldierDrag && afterLabEdit.zombieDrag === 0.55, "Lab edit leaked across actors")
  await page.evaluate(() => {
    const p = (window as any).charactersProof
    p.labPanel.navigation.reset(true, "Profile")
    p.labPanel.refresh()
  })

  // Test camera gestures: drag orbit, Shift+drag pan, wheel zoom, F frame
  const canvas = page.locator("#view")
  const box = (await canvas.boundingBox())!
  const cx = box.x + box.width * 0.45
  const cy = box.y + box.height * 0.5
  const cam0 = await page.evaluate(() => (window as any).charactersProof.camera)
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 110, cy - 35, { steps: 6 })
  await page.mouse.up()
  await page.evaluate(() => (window as any).advance(1000 / 60))
  const cam1 = await page.evaluate(() => (window as any).charactersProof.camera)
  check(cam1.yaw !== cam0.yaw && cam1.pitch !== cam0.pitch, `Drag did not orbit camera: ${JSON.stringify({ cam0, cam1 })}`)

  await page.keyboard.down("Shift")
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 80, cy + 40, { steps: 6 })
  await page.mouse.up()
  await page.keyboard.up("Shift")
  await page.evaluate(() => (window as any).advance(1000 / 60))
  const cam2 = await page.evaluate(() => (window as any).charactersProof.camera)
  check(cam2.focus[0] !== cam1.focus[0] || cam2.focus[2] !== cam1.focus[2], "Shift-drag did not pan camera")

  await page.mouse.wheel(0, -120)
  await page.evaluate(() => (window as any).advance(1000 / 60))
  const cam3 = await page.evaluate(() => (window as any).charactersProof.camera)
  check(cam3.dist < cam2.dist, "Wheel did not zoom camera")

  await canvas.focus()
  await page.keyboard.press("f")
  await page.evaluate(() => (window as any).advance(1000 / 60))
  const camFramed = await page.evaluate(() => (window as any).charactersProof.camera)
  check(Math.abs(camFramed.dist - 4.6) < 0.01, `F key did not frame selected actor: ${camFramed.dist}`)

  // Test Pause / Step / Speed slider
  await page.getByRole("button", { name: "Pause" }).click()
  const posPaused0 = await page.evaluate(() => {
    const a = (window as any).charactersProof.actors.find((x: any) => x.id === "zombie").avatar
    return [a.x, a.y, a.t]
  })
  await page.evaluate(() => (window as any).advance(200))
  const posPaused1 = await page.evaluate(() => {
    const a = (window as any).charactersProof.actors.find((x: any) => x.id === "zombie").avatar
    return [a.x, a.y, a.t]
  })
  check(JSON.stringify(posPaused0) === JSON.stringify(posPaused1), "Paused simulation advanced unexpectedly")
  await page.getByRole("button", { name: "Step" }).click()
  const posStepped = await page.evaluate(() => {
    const a = (window as any).charactersProof.actors.find((x: any) => x.id === "zombie").avatar
    return [a.x, a.y, a.t]
  })
  check(posStepped[2]! > posPaused1[2]!, "Step button did not advance 1/60s")
  await page.getByRole("button", { name: "Resume" }).click()

  // Close Lab panel for the 180-frame video capture of Possess + Walk/Run + Detach + Orbit
  await page.keyboard.press("Backquote")
  await page.getByRole("button", { name: "Reset" }).click()
  await page.locator('[data-action="frame"]').click()

  let frameIndex = 0
  const recordStep = async (steps: number) => {
    for (let i = 0; i < steps; i++) {
      await page.evaluate(() => (window as any).advance(1000 / 30))
      await page.screenshot({ path: join(framesDir, `${String(frameIndex++).padStart(4, "0")}.png`) })
    }
  }

  // 1. 30 frames of Zombie walk loop
  await recordStep(30)

  // 2. Press P to possess zombie, walk & sprint with keys (including Dvorak-safe keys)
  await canvas.focus()
  await page.keyboard.press("p")
  const isPossessing = await page.evaluate(() => (window as any).charactersProof.possessing === true)
  check(isPossessing, "P key did not enter Possess mode")

  const posBeforeWalk = await page.evaluate(() => {
    const a = (window as any).charactersProof.actors.find((x: any) => x.id === "zombie").avatar
    return { x: a.x, y: a.y }
  })

  await page.keyboard.down("KeyD")
  await page.keyboard.down("KeyS")
  await recordStep(35)
  await page.keyboard.down("ShiftLeft")
  await page.keyboard.up("KeyS")
  await page.keyboard.down("Comma") // Dvorak forward (W)
  await recordStep(35)

  const posAfterWalk = await page.evaluate(() => {
    const a = (window as any).charactersProof.actors.find((x: any) => x.id === "zombie").avatar
    return { x: a.x, y: a.y }
  })
  const movedDist = Math.hypot(posAfterWalk.x - posBeforeWalk.x, posAfterWalk.y - posBeforeWalk.y)
  check(movedDist > 1.2, `Possessed walk did not move actor enough: ${movedDist}`)

  // 3. Press Escape while keys are still held -> exits Possess mode and releases keys!
  await page.keyboard.press("Escape")
  await page.keyboard.up("KeyD")
  await page.keyboard.up("Comma")
  await page.keyboard.up("ShiftLeft")
  const afterEscPossessing = await page.evaluate(() => (window as any).charactersProof.possessing)
  check(afterEscPossessing === false, "Escape did not exit Possess mode")

  const posAfterEsc0 = await page.evaluate(() => {
    const a = (window as any).charactersProof.actors.find((x: any) => x.id === "zombie").avatar
    return { x: a.x, y: a.y, vx: a.vx, vy: a.vy }
  })
  check(posAfterEsc0.vx === 0 && posAfterEsc0.vy === 0, "Escape did not release possessed velocity")

  // 4. Resume walk loop and detach right forearm, then left upperArm -> debris + blood splatter
  await page.getByRole("button", { name: "Walk loop" }).click()
  await recordStep(15)
  await page.getByRole("combobox", { name: "Limb" }).selectOption("right.foreArm")
  await page.getByRole("button", { name: "Detach limb" }).click()
  await page.screenshot({ path: join(out, "after-zombie-detach-spawn.png") })
  await recordStep(30)
  await page.getByRole("combobox", { name: "Limb" }).selectOption("left.upperArm")
  await page.getByRole("button", { name: "Detach limb" }).click()
  await recordStep(35)
  await page.screenshot({ path: join(out, "after-zombie-detach-settled.png") })

  const detachState = await page.evaluate(() => {
    const p = (window as any).charactersProof
    const z = p.actors.find((x: any) => x.id === "zombie")
    return {
      pieces: z.pieces.length,
      noPop: z.noPop,
      hidden: [...z.hiddenBones],
      splatterActive: p.splatterActive,
      splatterInspect: p.game.splatterFx?.inspect() ?? null,
    }
  })
  check(detachState.pieces === 3 && detachState.noPop === true, `Detach state failed: ${JSON.stringify(detachState)}`)
  check(detachState.splatterActive === true, `Detach did not produce blood splatter: ${JSON.stringify(detachState)}`)

  const audioCount = await page.evaluate(() => {
    const list = ((window as any).__audioContexts ?? []) as AudioContext[]
    return { total: list.length, running: list.filter(a => a.state === "running").length }
  })
  check(audioCount.running === 0, `Autoplay audio detected: ${JSON.stringify(audioCount)}`)

  const summary = {
    gpu,
    navLinks,
    actorProfiles,
    posBeforeWalk,
    posAfterWalk,
    movedDist,
    afterEscPossessing,
    cam0,
    cam1,
    cam2,
    cam3,
    camFramed,
    detachState,
    audioCount,
    framesRecorded: frameIndex,
    errors,
  }
  writeFileSync(join(out, "proof.json"), JSON.stringify(summary, null, 2))
  if (errors.length) throw new Error(errors.join("\n"))
  console.log(JSON.stringify(summary, null, 2))
} finally {
  await browser.close()
  await server.close()
}
