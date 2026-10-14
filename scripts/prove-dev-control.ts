// End-to-end proof of the Arcade Dev Control bridge and `arcade` CLI.
// Exercises token/origin security, Hub, Catalogue, Lab Workbench, all 4 workspace games,
// live-input conflict handling, undo history, screenshots, and production build exclusion.
import { chromium } from "playwright-core"
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { createServer as createNetServer, connect as netConnect } from "node:net"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const outDir = join(root, "captures/dev-control")
mkdirSync(outDir, { recursive: true })

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

const controlFile = join(outDir, ".arcade-control-test.json")

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

function rawHttpUpgrade(port: number, path: string, headers: Record<string, string>): Promise<{ statusLine: string; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const socket = netConnect(port, "127.0.0.1", () => {
      const hdrLines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`)
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${hdrLines.join("\r\n")}\r\n\r\n`,
      )
    })
    let data = ""
    socket.on("data", chunk => {
      data += chunk.toString("utf8")
    })
    socket.on("end", () => {
      const [head, ...rest] = data.split("\r\n\r\n")
      const statusLine = head?.split("\r\n")[0] ?? ""
      resolvePromise({ statusLine, body: rest.join("\r\n\r\n") })
    })
    socket.on("error", reject)
  })
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
const report: Record<string, any> = {}

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

  // 1. Verify token file permissions (0600) and security checks
  check(existsSync(controlFile), "Control file was not created")
  const mode = statSync(controlFile).mode & 0o777
  check(mode === 0o600, `Control file mode must be 0600, got 0${mode.toString(8)}`)
  const controlData = JSON.parse(readFileSync(controlFile, "utf8")) as { token: string; origin: string }
  check(controlData.token.length === 64, "Expected 32-byte hex token")

  const noTokenRes = await fetch(`${origin}/__arcade/control/status`)
  check(noTokenRes.status === 403, `Expected 403 without token, got ${noTokenRes.status}`)

  const badTokenRes = await fetch(`${origin}/__arcade/control/status`, {
    headers: { authorization: "Bearer deadbeef" },
  })
  check(badTokenRes.status === 403, `Expected 403 with wrong token, got ${badTokenRes.status}`)

  const crossOriginHttpRes = await fetch(`${origin}/__arcade/control/status`, {
    headers: {
      authorization: `Bearer ${controlData.token}`,
      origin: "https://evil.example.com",
    },
  })
  check(crossOriginHttpRes.status === 403, `Expected 403 for cross-origin HTTP request, got ${crossOriginHttpRes.status}`)

  const wsCrossOrigin = await rawHttpUpgrade(port, "/__arcade/control?token=any", {
    Origin: "https://evil.example.com",
  })
  check(wsCrossOrigin.statusLine.includes("403"), `Expected 403 on cross-origin WS upgrade, got ${wsCrossOrigin.statusLine}`)

  const wsBadToken = await rawHttpUpgrade(port, "/__arcade/control?token=wrong", {
    Origin: origin,
  })
  check(wsBadToken.statusLine.includes("403"), `Expected 403 on invalid-token WS upgrade, got ${wsBadToken.statusLine}`)

  const statusEmpty = runArcade(["status", "--json"], 0).json
  check(statusEmpty.ok === true && statusEmpty.connectedPages === 0, "Expected 0 connected pages initially")
  const noPageErr = runArcade(["state", "--json"], 2).json
  check(noPageErr.ok === false && noPageErr.code === "no_page_connected", "Expected no_page_connected error when 0 pages open")
  const openNoNewErr = runArcade(["open", "lab", "--json"], 2).json
  check(openNoNewErr.ok === false && openNoNewErr.code === "no_page_connected", "open without --new must fail when 0 pages open")

  report.security = {
    tokenFilePermissions: `0${mode.toString(8)}`,
    noTokenStatus: noTokenRes.status,
    badTokenStatus: badTokenRes.status,
    crossOriginHttpStatus: crossOriginHttpRes.status,
    crossOriginWsStatus: wsCrossOrigin.statusLine,
    badTokenWsStatus: wsBadToken.statusLine,
    noPageExitCode: 2,
  }

  // 2. Connect headless Chromium page to Hub & drive Catalogue
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  page.on("pageerror", err => pageErrors.push(`${page.url()}: ${err.message}`))

  await page.goto(`${origin}/`)
  for (let i = 0; i < 40; i++) {
    const st = runArcade(["status", "--json"], 0).json
    if (st.connectedPages > 0) break
    await Bun.sleep(100)
  }
  const hubStatus = runArcade(["status", "--json"], 0).json
  check(hubStatus.connectedPages === 1 && hubStatus.pages[0].kind === "hub", `Expected 1 hub page, got ${JSON.stringify(hubStatus)}`)
  const pageId = hubStatus.pages[0].id

  const navCat = runArcade(["open", "catalogue", "--json"], 0).json
  check(navCat.ok === true, "Failed to open catalogue")
  await page.waitForSelector('[role=option][aria-selected="true"]')
  await Bun.sleep(150)

  const catState0 = runArcade(["state", "--json"], 0).json.result
  check(catState0.page.kind === "catalogue", `Expected catalogue kind, got ${catState0.page.kind}`)
  const catBeforeShot = join(outDir, "catalogue-before.png")
  const catShot0 = runArcade(["screenshot", "--out", catBeforeShot, "--json"], 0).json
  check(catShot0.bytes > 1000, "Catalogue before screenshot too small")

  const selMuscle = runArcade(["select", "getaway:muscle", "--json"], 0).json
  check(selMuscle.result.selected.id === "getaway:muscle", "Catalogue select muscle failed")
  const envNight = runArcade(["env", "night", "--json"], 0).json
  check(envNight.result.environment === "night", "Catalogue env night failed")
  const camCat = runArcade(["camera", "set", "--orbit", "42", "--elevation", "28", "--distance", "9.5", "--json"], 0).json
  check(camCat.result.orbit === 42 && camCat.result.elevation === 28 && camCat.result.distance === 9.5, "Catalogue camera set failed")

  const catAfterShot = join(outDir, "catalogue-after.png")
  const catShot1 = runArcade(["screenshot", "--out", catAfterShot, "--json"], 0).json
  check(
    Buffer.compare(readFileSync(catBeforeShot), readFileSync(catAfterShot)) !== 0,
    "Catalogue before and after screenshots must differ",
  )
  report.catalogue = {
    pageId,
    selectedAsset: selMuscle.result.selected.id,
    lighting: envNight.result.environment,
    camera: camCat.result,
    beforeBytes: catShot0.bytes,
    afterBytes: catShot1.bytes,
    screenshotsDiffer: true,
  }

  // 3. Navigate to Lab Workbench & drive full authoring workflow via CLI
  const navLab = runArcade(["open", "lab", "--json"], 0).json
  check(navLab.ok === true && navLab.page.kind === "lab", `Expected lab page after open lab, got ${JSON.stringify(navLab)}`)
  check(context.pages().length === 1, "arcade open must navigate the existing tab, never open a new tab")

  const cmdList = runArcade(["cmd", "list", "--json"], 0).json
  check(cmdList.commands.length >= 25, `Expected >= 25 registered Lab commands, got ${cmdList.commands.length}`)

  const labBeforeShot = join(outDir, "lab-before.png")
  const labShot0 = runArcade(["screenshot", "--out", labBeforeShot, "--json"], 0).json
  const labState0 = runArcade(["state", "--json"], 0).json.result
  check(Array.isArray(labState0.objects) && labState0.objects.length > 0, "Expected LabSceneState.objects")

  // Spawn hydrant at (2, -4) via ground.spawn-here
  const spawnHydrant = runArcade(["spawn", "hydrant", "--at", "2,-4", "--yaw", "30", "--seed", "11", "--json"], 0).json
  check(spawnHydrant.command === "ground.spawn-here" && spawnHydrant.result.spawned === "prop" && spawnHydrant.result.kind === "hydrant", "Failed to spawn hydrant")

  // Check unobtrusive CLI indicator appeared on page
  const indicatorText = await page.locator("[data-arcade-cli-indicator]").textContent()
  check(indicatorText?.includes("CLI: spawn hydrant"), `Expected CLI indicator on page, got "${indicatorText}"`)

  // Select active character via object.select
  const selChar = runArcade(["select", "character:active", "--json"], 0).json
  check(selChar.command === "object.select" && selChar.result.selected.id === "character:active", "Failed to select character:active")

  // Set camera orientation & target via camera.set
  const labCamSet = runArcade(
    ["camera", "set", "--orbit", "38", "--elevation", "24", "--distance", "13", "--target", "0,0.5,4", "--json"],
    0,
  ).json
  const labCamGet = runArcade(["camera", "get", "--json"], 0).json
  check(
    labCamGet.result.orbit === 38 &&
      labCamGet.result.elevation === 24 &&
      labCamGet.result.distance === 13 &&
      JSON.stringify(labCamGet.result.focus) === JSON.stringify([0, 0.5, 4]),
    `Camera get mismatch: ${JSON.stringify(labCamGet.result)}`,
  )

  // Lab parameter get/set via scene.set-param & lab.get
  const skidSet = runArcade(["lab", "set", "skidWidth", "0.32", "--json"], 0).json
  check(skidSet.command === "scene.set-param" && skidSet.result.value === 0.32, "lab set skidWidth failed")
  const skidGet = runArcade(["lab", "get", "skidWidth", "--json"], 0).json
  check(skidGet.result.value === 0.32, "lab get skidWidth mismatch")

  // Preset save (preset.export) & load (preset.import)
  const presetFile = join(outDir, "saved-preset.json")
  runArcade(["lab", "preset", "save", "cli-test-preset", "--out", presetFile, "--json"], 0)
  check(existsSync(presetFile), "Preset file was not written")
  runArcade(["lab", "set", "skidWidth", "0.18", "--json"], 0)
  runArcade(["lab", "preset", "load", presetFile, "--json"], 0)
  check(runArcade(["lab", "get", "skidWidth", "--json"], 0).json.result.value === 0.32, "Preset load did not restore skidWidth")

  // Environment & Transport
  const envStreet = runArcade(["env", "street", "--seed", "9", "--json"], 0).json
  check(envStreet.command === "scene.set-env" && envStreet.result.environment === "street" && envStreet.result.seed === 9, "env street failed")
  const trPause = runArcade(["transport", "pause", "--json"], 0).json
  check(trPause.command === "transport.toggle" && trPause.result.playing === false, "transport pause failed")
  const fBeforeStep = trPause.result.frames
  const trStep = runArcade(["transport", "step", "5", "--json"], 0).json
  check(trStep.command === "transport.step" && trStep.result.frames === fBeforeStep + 5, `Expected frames ${fBeforeStep + 5}, got ${trStep.result.frames}`)
  const trSpeed = runArcade(["transport", "speed", "0.5", "--json"], 0).json
  check(trSpeed.command === "transport.speed" && trSpeed.result.speed === 0.5, "transport speed 0.5 failed")

  // Screenshot after Lab changes
  const labAfterShot = join(outDir, "lab-after.png")
  const labShot1 = runArcade(["screenshot", "--out", labAfterShot, "--json"], 0).json
  check(
    Buffer.compare(readFileSync(labBeforeShot), readFileSync(labAfterShot)) !== 0,
    "Lab before and after screenshots must differ",
  )

  // Undo via CLI (same history stack as UI ⌘Z)
  const labStateBeforeUndo = runArcade(["state", "--json"], 0).json.result
  check(labStateBeforeUndo.history.canUndo === true && labStateBeforeUndo.history.undoDepth > 0, "Expected non-empty undo stack")
  const undoRes = runArcade(["run", "edit.undo", "--json"], 0).json
  check(undoRes.result.undone === true, "edit.undo failed")

  // Play mode possession & conflict protection
  const possessRes = runArcade(["possess", "getaway:muscle", "--json"], 0).json
  check(possessRes.result.mode === "play", "possess failed to enter play mode")
  const playConflictSpawn = runArcade(["spawn", "cone", "--at", "0,0", "--json"], 3).json
  check(playConflictSpawn.code === "unavailable" && /Play mode/i.test(playConflictSpawn.error), "Expected unavailable in Play mode")
  const playConflictCam = runArcade(["camera", "set", "--orbit", "15", "--json"], 3).json
  check(playConflictCam.code === "unavailable", "Expected camera set unavailable in Play mode")
  const releaseRes = runArcade(["release", "--json"], 0).json
  check(releaseRes.result.mode === "edit", "release failed to return to edit mode")

  // Live pointer drag conflict check
  const canvasBox = (await page.locator("canvas").boundingBox())!
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 200)
  await page.mouse.down()
  await page.mouse.move(canvasBox.x + 260, canvasBox.y + 220, { steps: 4 })
  const dragBusyRes = runArcade(["camera", "set", "--orbit", "10", "--timeout", "1500", "--json"], 3).json
  await page.mouse.up()
  check(dragBusyRes.code === "busy" && /live user input/i.test(dragBusyRes.error), `Expected busy code during live drag, got ${JSON.stringify(dragBusyRes)}`)

  // Invalid args & unknown command exit code 4
  const unknownCmdRes = runArcade(["run", "not.a.command", "--json"], 4).json
  check(unknownCmdRes.code === "unknown_command", "Expected unknown_command")
  const badArgRes = runArcade(["lab", "set", "skidWidth", "999", "--json"], 4).json
  check(badArgRes.code === "invalid_args", "Expected invalid_args for out-of-range setting")

  report.lab = {
    commandCount: cmdList.commands.length,
    indicatorText,
    initialObjects: labState0.objects.length,
    spawnedHydrant: spawnHydrant.result,
    cameraAfterSet: labCamSet.result,
    skidWidthAfterSet: skidGet.result.value,
    environmentAfterSet: envStreet.result,
    transportAfterStep: trStep.result,
    undoEntry: undoRes.result,
    playModeConflictCode: playConflictSpawn.code,
    liveDragConflictCode: dragBusyRes.code,
    beforeBytes: labShot0.bytes,
    afterBytes: labShot1.bytes,
    screenshotsDiffer: true,
  }

  // 4. Game pages coverage (navigate + screenshot + lab get/set)
  const gameProofs: Record<string, any> = {}
  const gameTestCases: { game: string; key: string; val: string; expected: unknown }[] = [
    { game: "getaway", key: "clutter", val: "false", expected: false },
    { game: "blackout", key: "volumes", val: "false", expected: false },
    { game: "outbreak", key: "exposure", val: "1.35", expected: 1.35 },
    { game: "carrier", key: "weather", val: "heavy", expected: "heavy" },
  ]
  for (const tc of gameTestCases) {
    const nav = runArcade(["open", tc.game, "--json"], 0).json
    check(nav.ok === true && nav.page.kind === "game", `Failed to navigate to ${tc.game}: ${JSON.stringify(nav)}`)
    await Bun.sleep(tc.game === "carrier" ? 1200 : 700)
    const setRes = runArcade(["lab", "set", tc.key, tc.val, "--json"], 0).json
    const getRes = runArcade(["lab", "get", tc.key, "--json"], 0).json
    check(getRes.result.value === tc.expected, `${tc.game} lab get ${tc.key} expected ${String(tc.expected)}, got ${String(getRes.result.value)}`)
    const shotPath = join(outDir, `game-${tc.game}.png`)
    const shotRes = runArcade(["screenshot", "--out", shotPath, "--json"], 0).json
    check(shotRes.bytes > 50000, `${tc.game} screenshot too small (${shotRes.bytes} bytes — expected non-blank WebGPU frame)`)
    gameProofs[tc.game] = {
      url: nav.page.url,
      settingChanged: { key: tc.key, before: setRes.result.before, after: getRes.result.value },
      screenshotBytes: shotRes.bytes,
      dimensions: `${shotRes.width}x${shotRes.height}`,
    }
  }
  report.games = gameProofs

  // 5. Production build & Worker verification
  execFileSync("bun", ["run", "--cwd", "games/getaway", "build"], { cwd: root, stdio: "inherit" })
  const distFiles: string[] = []
  function walkFiles(dir: string, out: string[]) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walkFiles(full, out)
      else if (/\.(js|html|css|mjs|ts)$/.test(entry.name)) out.push(full)
    }
  }
  walkFiles(join(root, "games/getaway/dist"), distFiles)
  check(distFiles.length > 0, "Expected built files in games/getaway/dist")
  for (const file of distFiles) {
    const content = readFileSync(file, "utf8")
    check(!content.includes("/__arcade/control"), `Production build file ${file} must not contain /__arcade/control`)
    check(!content.includes("arcade.control.pageId"), `Production build file ${file} must not contain dev-control WebSocket client`)
    if (file.endsWith(".html")) {
      check(!content.includes("arcade-dev-router"), `Production HTML file ${file} must not contain injected router meta`)
    }
  }
  const workerFiles: string[] = []
  for (const g of ["getaway", "blackout", "carrier"]) {
    const srvDir = join(root, "games", g, "server")
    if (existsSync(srvDir)) walkFiles(srvDir, workerFiles)
  }
  check(workerFiles.length > 0, "Expected Worker source files in games/*/server")
  for (const file of workerFiles) {
    const content = readFileSync(file, "utf8")
    check(!content.includes("/__arcade/control"), `Worker file ${file} must not contain /__arcade/control`)
  }
  report.productionExclusion = {
    checkedDistFiles: distFiles.length,
    checkedWorkerFiles: workerFiles.length,
    containsControlEndpoint: false,
    containsRouterMeta: false,
  }

  check(pageErrors.length === 0, `Browser page errors:\n${pageErrors.join("\n")}`)
  writeFileSync(join(outDir, "proof-report.json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  if (serverChild) serverChild.kill("SIGTERM")
  await browser.close()
}
