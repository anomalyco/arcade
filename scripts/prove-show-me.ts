// Headless Metal end-to-end proof for `ui.note`, `arcade note`, and the 10-step `arcade tour` (.arcade-tours/overnight.json).
// Verifies every step connects, applies setup commands, renders the pinned Show Me card & target highlight ring,
// sets document.title to "▸ <title>", supports Esc/× dismissal without blocking input, and exports <=1280px screenshots.
import { chromium } from "playwright-core"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { createServer as createNetServer } from "node:net"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const artifactsDir = join(homedir(), "code/home/artifacts/2026-10-14-show-me")
mkdirSync(artifactsDir, { recursive: true })

const check = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`Assertion failed: ${msg}`)
}

function freePort(): Promise<number> {
  return new Promise(done => {
    const srv = createNetServer()
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => done(port))
    })
  })
}

const controlFile = join(artifactsDir, ".arcade-control-show-me.json")

function runArcade(args: string[], expectExit = 0): { status: number; stdout: string; stderr: string; json: any } {
  const proc = Bun.spawnSync(["bun", "scripts/arcade.ts", "--control-file", controlFile, ...args], {
    cwd: root,
    env: { ...process.env, ARCADE_CONTROL_FILE: controlFile, ARCADE_NO_GLOBAL_STATE: "1" },
  })
  const stdout = proc.stdout.toString("utf8").trim()
  const stderr = proc.stderr.toString("utf8").trim()
  let parsed: any = null
  try {
    parsed = JSON.parse(stdout)
  } catch {}
  if (proc.exitCode !== expectExit) {
    throw new Error(
      `Expected exit code ${expectExit} for 'arcade ${args.join(" ")}', got ${proc.exitCode}.\nstdout: ${stdout}\nstderr: ${stderr}`,
    )
  }
  return { status: proc.exitCode, stdout, stderr, json: parsed }
}

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter(name => /^chromium-\d+$/.test(name))
  .reverse()
  .map(name => `${cache}/${name}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)
  .find(existsSync)

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--use-angle=metal",
    "--ignore-gpu-blocklist",
    "--mute-audio",
    "--autoplay-policy=user-gesture-required",
  ],
})

let serverChild: ChildProcess | null = null
const pageErrors: string[] = []
const stepResults: Record<string, unknown>[] = []

try {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  serverChild = spawn("bun", ["scripts/dev.ts"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      ARCADE_CONTROL_FILE: controlFile,
      ARCADE_NO_GLOBAL_STATE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let serverLog = ""
  for (const s of [serverChild.stdout, serverChild.stderr]) {
    s?.on("data", (c: Buffer) => {
      serverLog += c.toString()
    })
  }
  for (let i = 0; i < 100 && !serverLog.includes("Arcade dev:"); i++) {
    await Bun.sleep(100)
  }
  check(serverLog.includes("Arcade dev:"), `Dev server failed to start:\n${serverLog}`)

  // 1. Register the 10-step overnight tour via `arcade tour .arcade-tours/overnight.json --no-open --json`
  const tourRes = runArcade(["tour", ".arcade-tours/overnight.json", "--no-open", "--base-url", origin, "--json"], 0).json
  check(tourRes.ok === true && tourRes.id === "overnight", `Failed to register overnight tour: ${JSON.stringify(tourRes)}`)
  check(Array.isArray(tourRes.steps) && tourRes.steps.length === 10, `Expected 10 steps in overnight tour, got ${tourRes.steps?.length}`)

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  page.on("pageerror", err => pageErrors.push(`${page.url()}: ${err.message}`))

  // 2. Verify each of the 10 tour steps headlessly
  for (const stepInfo of tourRes.steps as { step: number; title: string; body: string | null; url: string }[]) {
    const stepNum = stepInfo.step
    const slug = stepInfo.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
    const padded = String(stepNum).padStart(2, "0")

    await page.goto(stepInfo.url, { waitUntil: "domcontentloaded" })
    await page.bringToFront()

    // Wait for bridge to apply setup commands and render `[data-arcade-note]` with matching step counter
    const expectedStepBadge = `${stepNum}/10`
    let matchedNote = false
    for (let attempt = 0; attempt < 80; attempt++) {
      const domState = await page
        .evaluate(() => {
          const noteEl = document.querySelector<HTMLElement>("[data-arcade-note]")
          const stepEl = document.querySelector<HTMLElement>("[data-arcade-note-step]")
          const titleEl = document.querySelector<HTMLElement>("[data-arcade-note-title]")
          const ringEl = document.querySelector<HTMLElement>("[data-arcade-note-ring]")
          return {
            docTitle: document.title,
            noteVisible: Boolean(noteEl && !noteEl.hidden),
            stepText: stepEl?.textContent ?? "",
            titleText: titleEl?.textContent ?? "",
            ringVisible: Boolean(ringEl && !ringEl.hidden),
            ringRect: ringEl && !ringEl.hidden ? ringEl.getBoundingClientRect().toJSON() : null,
          }
        })
        .catch(() => null)
      if (domState?.noteVisible && domState.stepText === expectedStepBadge && domState.docTitle === `▸ ${stepInfo.title}`) {
        matchedNote = true
        break
      }
      await Bun.sleep(100)
    }
    check(matchedNote, `Step ${stepNum} (${stepInfo.title}) did not render expected Show Me note within timeout`)

    // Give dynamic effects/textures/animations a brief moment to settle
    await Bun.sleep(stepNum === 7 ? 350 : stepNum === 10 ? 450 : 250)

    const domDetails = await page.evaluate(() => {
      const noteEl = document.querySelector<HTMLElement>("[data-arcade-note]")!
      const ringEl = document.querySelector<HTMLElement>("[data-arcade-note-ring]")
      return {
        docTitle: document.title,
        windowName: window.name,
        pointerEvents: getComputedStyle(noteEl).pointerEvents,
        noteRect: noteEl.getBoundingClientRect().toJSON(),
        ringVisible: Boolean(ringEl && !ringEl.hidden),
        ringRect: ringEl && !ringEl.hidden ? ringEl.getBoundingClientRect().toJSON() : null,
      }
    })
    check(domDetails.docTitle === `▸ ${stepInfo.title}`, `Step ${stepNum} document.title mismatch: ${domDetails.docTitle}`)
    check(domDetails.pointerEvents === "none", `Step ${stepNum} note container must have pointer-events: none`)
    check(domDetails.ringVisible, `Step ${stepNum} (${stepInfo.title}) target highlight ring should be visible`)

    const outPng = join(artifactsDir, `step-${padded}-${slug}.png`)
    const rawCapture = runArcade(["run", "screenshot", '{"maxSize":1280,"raw":true}', "--page", `step=${stepNum}`, "--json"], 0).json
    const dataUrl = String(rawCapture.result?.dataUrl ?? "")
    check(dataUrl.startsWith("data:image/png;base64,"), `Step ${stepNum} did not return a valid canvas PNG dataUrl`)

    // Pin the captured WebGPU frame behind the live DOM chrome/overlays and take a 1280x800 page screenshot
    await page.evaluate((url: string) => {
      const c = document.querySelector<HTMLCanvasElement>("canvas")
      if (!c) return
      const r = c.getBoundingClientRect()
      const img = document.createElement("img")
      img.dataset.arcadeShotMirror = ""
      img.src = url
      img.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;pointer-events:none;z-index:1;object-fit:fill;`
      document.body.append(img)
    }, dataUrl)
    await page.screenshot({ path: outPng })
    await page.evaluate(() => {
      document.querySelectorAll("[data-arcade-shot-mirror]").forEach(el => el.remove())
    })
    const bytes = statSync(outPng).size
    check(existsSync(outPng) && bytes > 15000, `Step ${stepNum} screenshot too small (${bytes} bytes)`)

    console.log(
      `✓ Step ${padded}/10: ${domDetails.docTitle} (1280×800, ${bytes}B) -> ${outPng}`,
    )
    stepResults.push({
      step: stepNum,
      title: stepInfo.title,
      url: stepInfo.url,
      documentTitle: domDetails.docTitle,
      ringRect: domDetails.ringRect,
      screenshot: outPng,
      width: 1280,
      height: 800,
      bytes,
    })
  }

  // 3. Verify one-off `arcade note`, Esc dismissal, and non-blocking input
  const oneOffRes = runArcade(
    [
      "note",
      "Custom One-Off Label",
      "--body",
      "Checking Esc dismissal and non-blocking canvas input",
      "--rect",
      "240,180,200,120",
      "--accent",
      "emerald",
      "--json",
    ],
    0,
  ).json
  check(oneOffRes.ok === true && oneOffRes.result.documentTitle === "▸ Custom One-Off Label", "One-off arcade note failed")
  check(await page.evaluate(() => document.title === "▸ Custom One-Off Label"), "Expected document.title updated by arcade note")

  // Dismiss with Escape key
  await page.keyboard.press("Escape")
  await Bun.sleep(80)
  const afterEsc = await page.evaluate(() => {
    const noteEl = document.querySelector<HTMLElement>("[data-arcade-note]")
    return {
      hidden: !noteEl || noteEl.hidden,
      docTitle: document.title,
    }
  })
  check(afterEsc.hidden === true, "Expected Escape to dismiss the Show Me card")
  check(!afterEsc.docTitle.startsWith("▸ Custom One-Off Label"), `Expected Escape to restore document.title, got ${afterEsc.docTitle}`)

  // 4. Verify single-tab Studio Tab Strip & static `kind: "page"` landing page on `.arcade-tours/look-review.json`
  const lookTourRes = runArcade(["tour", ".arcade-tours/look-review.json", "--no-open", "--base-url", origin, "--json"], 0).json
  check(lookTourRes.ok === true && lookTourRes.id === "look-review" && lookTourRes.singleTab === true, "Expected single-tab look-review tour")
  check(lookTourRes.steps.length === 6, `Expected 6 steps in look-review, got ${lookTourRes.steps.length}`)

  // Open Step 1 (static comparison page with 6 images)
  await page.goto(lookTourRes.steps[0].url, { waitUntil: "domcontentloaded" })
  for (let i = 0; i < 60; i++) {
    const ready = await page.evaluate(() => {
      const strip = document.querySelector<HTMLElement>("[data-arcade-studio-strip]")
      const pageEl = document.querySelector<HTMLElement>("[data-arcade-studio-page]")
      const imgs = [...document.querySelectorAll<HTMLImageElement>("img[data-studio-image]")]
      return (
        Boolean(strip && !strip.hidden) &&
        Boolean(pageEl && !pageEl.hidden) &&
        imgs.length === 6 &&
        imgs.every(img => img.complete && img.naturalWidth > 0)
      )
    })
    if (ready) break
    await Bun.sleep(100)
  }
  const lookPageAudit = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll<HTMLElement>("[data-studio-step]")].map(el => ({
      step: Number(el.dataset.studioStep),
      selected: el.getAttribute("aria-selected") === "true",
      kind: el.dataset.stepKind,
      text: el.querySelector("[data-studio-step-title]")?.textContent ?? "",
    }))
    const imgs = [...document.querySelectorAll<HTMLImageElement>("img[data-studio-image]")].map(img => ({
      src: img.getAttribute("src"),
      w: img.naturalWidth,
      h: img.naturalHeight,
    }))
    return { tabCount: tabs.length, tabs, imgs }
  })
  check(lookPageAudit.tabCount === 6, `Expected 6 mini-tabs in studio strip, got ${lookPageAudit.tabCount}`)
  check(lookPageAudit.tabs[0]?.selected === true && lookPageAudit.tabs[0]?.kind === "page", "Step 1 mini-tab should be selected and kind=page")
  check(lookPageAudit.imgs.length === 6 && lookPageAudit.imgs.every(i => i.w > 100 && i.h > 100), "All 6 comparison images loaded from dev server")
  const lookPagePng = join(artifactsDir, "look-review-step-01-page.png")
  await page.screenshot({ path: lookPagePng })
  console.log(`✓ Look Review Step 1 (Studio Page with 6 comparison images): ${lookPagePng}`)

  // Click Mini-Tab 5 ("Vignette · Noir, game camera") -> navigates within the SAME browser tab
  await page.locator('[data-studio-step="5"]').click()
  for (let i = 0; i < 80; i++) {
    const st = await page
      .evaluate(() => ({
        path: location.pathname,
        stepText: document.querySelector("[data-arcade-note-step]")?.textContent ?? "",
        selectedStep: document.querySelector('[data-studio-step][aria-selected="true"]')?.getAttribute("data-studio-step"),
      }))
      .catch(() => null)
    if (st?.path === "/arcade/lab/" && st.stepText === "5/6" && st.selectedStep === "5") break
    await Bun.sleep(100)
  }
  check(context.pages().length === 1, "Studio Tab Strip must keep only 1 browser tab open")

  // Set a sentinel on window, then press Alt+] to switch from Step 5 (Noir) to Step 6 (Street close-up, Dusk) IN PLACE with zero reload!
  await page.evaluate(() => {
    ;(window as any).__inPlaceSentinel = "alive"
  })
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "BracketRight", key: "]", altKey: true, bubbles: true, cancelable: true }))
  })
  for (let i = 0; i < 50; i++) {
    const st = await page.evaluate(() => ({
      sentinel: (window as any).__inPlaceSentinel,
      selectedStep: document.querySelector('[data-studio-step][aria-selected="true"]')?.getAttribute("data-studio-step"),
      stepText: document.querySelector("[data-arcade-note-step]")?.textContent ?? "",
      preset: (document.querySelector("[data-lab]")?.shadowRoot?.querySelector('[data-key="directionPreset"]') as HTMLSelectElement | null)?.value,
    }))
    if (st.selectedStep === "6" && st.stepText === "6/6" && st.preset === "1") break
    await Bun.sleep(80)
  }
  const inPlaceAudit = await page.evaluate(() => ({
    sentinel: (window as any).__inPlaceSentinel,
    selectedStep: document.querySelector('[data-studio-step][aria-selected="true"]')?.getAttribute("data-studio-step"),
    stepText: document.querySelector("[data-arcade-note-step]")?.textContent ?? "",
    preset: (document.querySelector("[data-lab]")?.shadowRoot?.querySelector('[data-key="directionPreset"]') as HTMLSelectElement | null)?.value,
  }))
  check(inPlaceAudit.sentinel === "alive", "Switching between same-page Lab steps in Studio Tab Strip must not reload the page")
  check(inPlaceAudit.selectedStep === "6" && inPlaceAudit.preset === "1", `Expected in-place switch to step 6 (dusk=1), got ${JSON.stringify(inPlaceAudit)}`)
  console.log("✓ Studio Tab Strip: same-page in-place step switch verified (0 reloads, 1 tab)")

  // Close the studio tour strip
  await page.locator("[data-studio-close]").click()
  check(await page.evaluate(() => document.querySelector<HTMLElement>("[data-arcade-studio-strip]")?.hidden === true), "Studio strip should hide on close")

  // 5. Verify Lab Play mode on Getaway Lab & Blackout Lab for both QWERTY and Dvorak layouts
  for (const hostGame of ["getaway", "blackout"] as const) {
    await page.goto(`${origin}/arcade/lab/?game=${hostGame}`, { waitUntil: "domcontentloaded" })
    await page.waitForFunction(
      () => Boolean(document.querySelector('[data-action="mode-play"]') && document.querySelector("canvas")),
      undefined,
      { timeout: 30000 },
    )
    await Bun.sleep(250)

    // A. Default startup selects controllable character:active and shows ▶ Play
    const initialPlayBtn = await page.locator('[data-action="mode-play"]').textContent()
    check(initialPlayBtn?.includes("Play"), `${hostGame}: expected ▶ Play button on startup, got "${initialPlayBtn}"`)

    // B. Deselect everything (Escape), focus Details (LabPanel), then press Dvorak P (physical KeyR, logical key "p"):
    //    must enter Play mode even with nothing selected and Details focused, and must NOT reroll the room seed!
    await page.locator("canvas").focus()
    await page.keyboard.press("Escape")
    await page.evaluate(() => {
      document.querySelector<HTMLElement>("[data-lab]")?.focus()
    })
    const seedBeforePlay = await page.evaluate(() => document.querySelector("[data-readout='seed']")?.textContent)
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyR", key: "p", bubbles: true, cancelable: true }))
    })
    await Bun.sleep(80)
    const afterDvorakP = await page.evaluate(() => ({
      playPressed: document.querySelector('[data-action="mode-play"]')?.getAttribute("aria-pressed"),
      btnText: document.querySelector('[data-action="mode-play"]')?.textContent,
      seedText: document.querySelector("[data-readout='seed']")?.textContent,
      focusPill: document.querySelector("[data-focus-pill]")?.textContent,
    }))
    check(afterDvorakP.playPressed === "true", `${hostGame}: Dvorak P (KeyR/key="p") from Details with nothing selected failed to enter Play`)
    check(afterDvorakP.btnText?.includes("Stop"), `${hostGame}: Play button should read ■ Stop in Play mode, got "${afterDvorakP.btnText}"`)
    check(afterDvorakP.seedText === seedBeforePlay, `${hostGame}: Dvorak P (KeyR) must not reroll room seed`)

    // C. Drive / move using Dvorak physical WASD codes (KeyW=",", KeyD="e")
    const posBefore = await page.evaluate(() => {
      const nameEl = document.querySelector(".lab-details-meta")?.textContent ?? ""
      return nameEl
    })
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "ShiftLeft", key: "Shift", shiftKey: true, bubbles: true }))
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW", key: ",", bubbles: true }))
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD", key: "e", bubbles: true }))
    })
    await Bun.sleep(450)
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyW", key: ",", bubbles: true }))
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyD", key: "e", bubbles: true }))
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "ShiftLeft", key: "Shift", bubbles: true }))
    })
    const hintDuringDvorak = await page.locator("[data-hint-text]").textContent()
    check(hintDuringDvorak?.includes(",AOE") || hintDuringDvorak?.includes(",ASD"), `${hostGame}: expected Dvorak movement label in hint strip, got "${hintDuringDvorak}"`)

    // D. Press F8 to toggle Eject camera while simulation keeps running, then F8 again to re-possess
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "F8", key: "F8", bubbles: true, cancelable: true }))
    })
    await Bun.sleep(60)
    const ejectedPill = await page.locator("[data-focus-pill]").textContent()
    check(ejectedPill?.includes("Ejected"), `${hostGame}: expected F8 to toggle Ejected camera, got "${ejectedPill}"`)
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "F8", key: "F8", bubbles: true, cancelable: true }))
    })
    await Bun.sleep(60)
    check(!(await page.locator("[data-focus-pill]").textContent())?.includes("Ejected"), `${hostGame}: second F8 should re-possess`)

    // E. Click top-bar ■ Stop button -> must exit Play mode back to Edit mode and restore pre-Play checkpoint!
    await page.locator('[data-action="mode-play"]').click()
    await Bun.sleep(80)
    const afterStopClick = await page.evaluate(() => ({
      playPressed: document.querySelector('[data-action="mode-play"]')?.getAttribute("aria-pressed"),
      btnText: document.querySelector('[data-action="mode-play"]')?.textContent,
      posAfter: document.querySelector(".lab-details-meta")?.textContent ?? "",
    }))
    check(afterStopClick.playPressed === "false", `${hostGame}: clicking ■ Stop button must exit Play mode (got aria-pressed=${afterStopClick.playPressed})`)
    check(afterStopClick.btnText?.includes("Play"), `${hostGame}: button must return to ▶ Play after stopping`)
    check(afterStopClick.posAfter === posBefore, `${hostGame}: stopping Play must restore pre-Play checkpoint position`)

    // F. QWERTY P (code: KeyP, key: "p") while a <select> dropdown is focused -> enters Play, then Escape exits Play
    await page.locator('[data-control="environment"]').focus()
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyP", key: "p", bubbles: true, cancelable: true }))
    })
    await Bun.sleep(60)
    check(
      (await page.locator('[data-action="mode-play"]').getAttribute("aria-pressed")) === "true",
      `${hostGame}: QWERTY P (KeyP/key="p") with <select> focused failed to enter Play`,
    )
    await page.keyboard.press("Escape")
    await Bun.sleep(60)
    check(
      (await page.locator('[data-action="mode-play"]').getAttribute("aria-pressed")) === "false",
      `${hostGame}: Escape failed to exit Play mode`,
    )
    console.log(`✓ ${hostGame} Lab Play mode verified (QWERTY + Dvorak, unselected, Details/select focus, F8 eject, ■ Stop button, Esc checkpoint)`)
  }

  // 6. Verify Multi-Tile Variation Grid: 6-tile Looks grid & 4-tile Explosion variants grid
  await page.goto(`${origin}/arcade/lab/?section=looks`, { waitUntil: "domcontentloaded" })
  await page.waitForFunction(
    () => Boolean(document.querySelector('[data-action="compare-grid"]') && document.querySelector("canvas")),
    undefined,
    { timeout: 30000 },
  )
  await Bun.sleep(200)

  const gridLooksOpen = runArcade(["grid", "looks", "--json"], 0)
  check(gridLooksOpen.json?.ok === true, `arcade grid looks failed: ${gridLooksOpen.stderr || gridLooksOpen.stdout}`)
  check(gridLooksOpen.json?.result?.tileCount === 6, `Expected 6 tiles in looks grid, got ${gridLooksOpen.json?.result?.tileCount}`)
  await Bun.sleep(450)

  const looksGridState = runArcade(["state", "--json"], 0)
  const looksGridInfo = looksGridState.json?.state?.grid
  check(looksGridInfo?.active === true && looksGridInfo?.cols === 3 && looksGridInfo?.rows === 2, "Expected active 3x2 looks grid in state")
  check(typeof looksGridInfo?.frameCostMs === "number" && looksGridInfo.frameCostMs > 0, `Expected measured frameCostMs for 6-tile looks grid, got ${looksGridInfo?.frameCostMs}`)

  const looksGridShot = join(artifactsDir, "grid-looks-6.png")
  const shotLooksRes = runArcade(["screenshot", "--out", looksGridShot, "--json"], 0)
  check(shotLooksRes.status === 0 && existsSync(looksGridShot), "Failed to capture 6-tile looks grid screenshot")
  console.log(`✓ 6-tile Looks Variation Grid verified (3×2 single WebGPU canvas, frame cost: ${looksGridInfo.frameCostMs.toFixed(2)} ms, screenshot: ${looksGridShot})`)

  // Focus tile 2 (Noir) via keyboard '2', then return to grid via 'Escape'
  await page.locator("canvas").focus()
  await page.keyboard.press("2")
  await Bun.sleep(150)
  const focusedState = runArcade(["state", "--json"], 0).json?.state?.grid
  check(focusedState?.focusedTile === 2, `Expected focusedTile=2 after pressing '2', got ${focusedState?.focusedTile}`)
  await page.keyboard.press("Escape")
  await Bun.sleep(150)
  const unfocusedState = runArcade(["state", "--json"], 0).json?.state?.grid
  check(unfocusedState?.active === true && unfocusedState?.focusedTile === null, "Expected Escape from focused tile to return to multi-tile grid")

  // Switch to 4-tile Explosion variants grid
  const gridExpOpen = runArcade(["grid", "explosions", "--json"], 0)
  check(gridExpOpen.json?.ok === true, `arcade grid explosions failed: ${gridExpOpen.stderr || gridExpOpen.stdout}`)
  check(gridExpOpen.json?.result?.tileCount === 4, `Expected 4 tiles in explosions grid, got ${gridExpOpen.json?.result?.tileCount}`)
  await Bun.sleep(500)

  const expGridInfo = runArcade(["state", "--json"], 0).json?.state?.grid
  check(expGridInfo?.active === true && expGridInfo?.cols === 2 && expGridInfo?.rows === 2, "Expected active 2x2 explosions grid in state")
  const expGridShot = join(artifactsDir, "grid-explosions-4.png")
  const shotExpRes = runArcade(["screenshot", "--out", expGridShot, "--json"], 0)
  check(shotExpRes.status === 0 && existsSync(expGridShot), "Failed to capture 4-tile explosions grid screenshot")
  console.log(`✓ 4-tile Explosion Variants Grid verified (2×2 synchronized timeline, frame cost: ${expGridInfo.frameCostMs?.toFixed(2)} ms, screenshot: ${expGridShot})`)

  // Focus tile 3 via CLI 'arcade grid focus 3', then close via 'arcade grid close'
  const cliFocusRes = runArcade(["grid", "focus", "3", "--json"], 0)
  check(cliFocusRes.json?.result?.focusedTile === 3, "arcade grid focus 3 failed")
  const cliCloseRes = runArcade(["grid", "close", "--json"], 0)
  check(cliCloseRes.json?.result?.active === false, "arcade grid close failed")

  check(pageErrors.length === 0, `Unexpected page errors:\n${pageErrors.join("\n")}`)

  const summaryPath = join(artifactsDir, "summary.json")
  writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        ok: true,
        tourId: "overnight",
        stepCount: stepResults.length,
        steps: stepResults,
      },
      null,
      2,
    ) + "\n",
  )
  console.log(`\nAll 10 tour steps verified headlessly. Summary written to ${summaryPath}`)
} finally {
  if (serverChild) {
    serverChild.kill("SIGTERM")
  }
  await browser.close()
}
