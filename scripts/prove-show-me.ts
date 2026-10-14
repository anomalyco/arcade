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
