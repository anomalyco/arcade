#!/usr/bin/env bun
import { parseArgs } from "node:util"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"
import { createHash } from "node:crypto"
import { prepareLabels, qualities, type Job } from "./compare-video/compose"

const root = resolve(import.meta.dir, "..")
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    game: { type: "string", default: "getaway" },
    version: { type: "string", multiple: true },
    layout: { type: "string", default: "stack" },
    frames: { type: "string", default: "360" },
    fps: { type: "string", default: "30" },
    seed: { type: "string", default: "7" },
    size: { type: "string", default: "900x800" },
    quality: { type: "string", default: "high" },
    zoom: { type: "string", default: "1" },
    scenario: { type: "string", default: "chase" },
    out: { type: "string" },
    "also-side": { type: "string" },
    keep: { type: "boolean" },
    help: { type: "boolean" },
    "input-only": { type: "boolean" },
  },
})
if (values.help) {
  console.log(`bun scripts/compare-video.ts --game getaway --version 'Before=ref:4495277' --version 'Now=url:http://getaway-smoke.localhost:1355' --layout stack --frames 360 --seed 7 --size 900x800 --out captures/compare/night.mp4
  --quality high|draft High (default): 2× capture, 1080-wide stack / 2560-wide side, 16 / 28 Mbps.
                       Draft: 1× capture, 720-wide stack / 1920-wide side, 6 / 9 Mbps.
  --zoom NUMBER        Camera magnification, 1–3 (default 1); try 1.35 for closer car detail.
  --also-side PATH.mp4 Compose a side-by-side version from the same frames.
  --scenario chase     Or a path to a module exporting {name,input(frame,fps,car)}.
  --input-only         Replay inputs only; by default the last version also supplies poses/camera.
  --keep               Keep captured frames, manifest and temporary ref worktrees (previews stop).
Requires macOS, Chromium, Getaway's bun install, ImageMagick, ffmpeg and hivemind.
Local capture is headless/muted; encoding runs on the fleet. Ref previews use Nexus.
Production URLs need a supported __getawayBench hook; otherwise use the deployed commit ref.`)
  process.exit(0)
}
if (values.game !== "getaway") throw new Error(`No adapter for ${values.game}; add one beside compare-video/getaway.ts`)
if (!["stack", "side"].includes(values.layout!)) throw new Error("--layout must be stack or side")
if (values.quality !== "draft" && values.quality !== "high") throw new Error("--quality must be draft or high")
const quality = values.quality
const deviceScaleFactor = qualities[quality].dpr
const zoom = Number(values.zoom)
if (!Number.isFinite(zoom) || zoom < 1 || zoom > 3) throw new Error("--zoom must be a number from 1 to 3")
const frames = Number(values.frames),
  fps = Number(values.fps),
  seed = Number(values.seed)
if (
  !Number.isInteger(frames) ||
  frames < 3 ||
  frames > 18000 ||
  !Number.isInteger(fps) ||
  fps < 1 ||
  fps > 120 ||
  !Number.isInteger(seed) ||
  seed < 0 ||
  seed > 0xffffffff
)
  throw new Error("Invalid frames (3–18000), fps (1–120), or uint32 seed")
const size = /^(\d+)x(\d+)$/.exec(values.size!)
if (!size) throw new Error("--size must be WIDTHxHEIGHT")
const width = Number(size[1]),
  height = Number(size[2])
if (width < 64 || height < 64 || width > 3840 || height > 3840) throw new Error("Capture dimensions must be 64–3840")
const versions = (values.version ?? []).map((value) => {
  const m = /^([^=\n]+)=(ref|url):(.+)$/.exec(value)
  if (!m) throw new Error(`Expected Label=ref:COMMIT or Label=url:URL: ${value}`)
  if (m[2] === "url" && !/^https?:$/.test(new URL(m[3]!).protocol)) throw new Error("URLs must be HTTP(S)")
  return { label: m[1]!, kind: m[2]!, source: m[3]!, url: "", sha: "" }
})
if (versions.length < 2) throw new Error("Pass at least two --version options")
const out = resolve(values.out ?? `captures/compare/${values.game}-${Date.now()}.mp4`)
const outputs = [
  { layout: values.layout as "stack" | "side", destination: out },
  ...(values["also-side"] ? [{ layout: "side" as const, destination: resolve(values["also-side"]) }] : []),
]
if (outputs.some((o) => !o.destination.endsWith(".mp4")) || new Set(outputs.map((o) => o.destination)).size !== outputs.length)
  throw new Error("Outputs must be distinct .mp4 paths")
for (const o of outputs) if (existsSync(o.destination)) throw new Error(`Output exists: ${o.destination}`)

async function run(args: string[], cwd = root, quiet = false) {
  const p = Bun.spawn(args, { cwd, stdout: quiet ? "pipe" : "inherit", stderr: "inherit" })
  const text = quiet ? await new Response(p.stdout).text() : ""
  if (await p.exited) throw new Error(`Command failed: ${args.join(" ")}\n${text}`)
  return text.trim()
}
const { chromium } = await import("playwright-core")
const { getaway: adapter } = await import("./compare-video/getaway")
const scenarioPath = values.scenario!.includes("/")
  ? resolve(values.scenario!)
  : join(import.meta.dir, "compare-video/scenarios", `${values.scenario}.ts`)
const scenario = (await import(scenarioPath)).default
if (typeof scenario?.input !== "function") throw new Error("Scenario must export {name,input(frame,fps,car)}")
const chrome =
  process.env.CHROME_EXECUTABLE ??
  [
    chromium.executablePath(),
    ...(existsSync(join(homedir(), "Library/Caches/ms-playwright")) ? readdirSync(join(homedir(), "Library/Caches/ms-playwright")) : [])
      .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
      .map((n) =>
        join(
          homedir(),
          "Library/Caches/ms-playwright",
          n,
          "chrome-headless-shell-mac-arm64/chrome-headless-shell",
        ),
      ),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find(existsSync)
if (!chrome || !existsSync(chrome)) throw new Error("No Chromium found; set CHROME_EXECUTABLE")

// Unignored staging lets hivemind transfer only this job's frames with its normal worktree sync.
const work = mkdtempSync(join(root, ".compare-video-"))
const worktrees: string[] = [],
  previews: string[] = []
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let interrupted = false
const interrupt = () => {
  interrupted = true
  void browser?.close()
}
process.on("SIGINT", interrupt)
process.on("SIGTERM", interrupt)
try {
  for (const [i, v] of versions.entries()) {
    if (v.kind === "url") {
      v.url = v.source
      continue
    }
    v.sha = await run(["git", "rev-parse", "--verify", `${v.source}^{commit}`], root, true)
    const tempBase = join(tmpdir(), "opencode")
    mkdirSync(tempBase, { recursive: true })
    const dir = join(mkdtempSync(join(tempBase, "arcade-compare-")), v.sha.slice(0, 10))
    await run(["git", "worktree", "add", "--detach", dir, v.sha])
    worktrees.push(dir)
    const game = join(dir, "games", values.game!)
    const current = join(root, "games", values.game!)
    const workspace = existsSync(join(dir, "bun.lock")) && existsSync(join(dir, "package.json"))
    const lock = ["bun.lock", "bun.lockb"].find((f) => existsSync(join(game, f)))
    if (
      !workspace && lock &&
      existsSync(join(current, lock)) &&
      readFileSync(join(game, lock)).equals(readFileSync(join(current, lock))) &&
      existsSync(join(current, "node_modules"))
    )
      symlinkSync(join(current, "node_modules"), join(game, "node_modules"))
    else await run(["bun", "install", "--frozen-lockfile"], workspace ? dir : game)
    const name = `compare-${values.game}-${basename(work).slice(-6).toLowerCase()}-${i}`
    const entries = JSON.parse(await run(["nexus", "list", "--json"], root, true))
    if (entries.data.some((entry: { name: string }) => entry.name === name)) throw new Error(`Preview name already exists: ${name}`)
    try {
      const result = JSON.parse(
        await run(
          [
            "nexus",
            "run",
            name,
            "--json",
            "--cwd",
            game,
            "--",
            "sh",
            "-c",
            'exec bunx --no-install vite --host 127.0.0.1 --port "$PORT" --strictPort',
          ],
          root,
          true,
        ),
      )
      previews.push(name)
      v.url = result.data.url
    } catch (error) {
      // A readiness timeout leaves Nexus running. Stop only the entry tied to our new checkout.
      const status = await run(["nexus", "status", name, "--json"], root, true)
        .then(JSON.parse)
        .catch(() => null)
      if (status?.data?.cwd === game) previews.push(name)
      throw error
    }
  }
  if (interrupted) throw new Error("Interrupted")
  browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
  })
  const tape: { input: any; view: any; camera: any }[] = []
  const reports: any[] = []
  // The last pane owns the driving decisions and (normally) world/camera snapshots.
  const order = [versions.length - 1, ...versions.slice(0, -1).map((_, i) => i)]
  for (const index of order) {
    const v = versions[index]!
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor, serviceWorkers: "block" })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    const ready = await adapter.install(page, seed, zoom)
    const url = new URL(v.url)
    for (const key of ["stage", "freeze", "peaceful", "mux", "lab", "perf"]) url.searchParams.delete(key)
    for (const [key, value] of Object.entries({ solo: "1", bench: "1", seed: String(seed), nohud: "1" })) url.searchParams.set(key, value)
    await page.goto(url.href, { waitUntil: "networkidle", timeout: 60_000 })
    const { adapter: gpu, hookSourceSha256 } = await ready()
    const canvasSize = await page
      .locator(adapter.canvas)
      .evaluate((canvas: HTMLCanvasElement) => ({ width: canvas.width, height: canvas.height }))
    if (canvasSize.width !== width * deviceScaleFactor || canvasSize.height !== height * deviceScaleFactor)
      throw new Error(
        `Unexpected capture canvas: ${JSON.stringify(canvasSize)}; expected ${width * deviceScaleFactor}x${height * deviceScaleFactor}`,
      )
    if (!gpu || !/apple/i.test(JSON.stringify(gpu)) || /swiftshader|llvmpipe|software/i.test(JSON.stringify(gpu)))
      throw new Error(`Expected Apple Metal hardware adapter: ${JSON.stringify(gpu)}`)
    console.log(`${v.label}: ${JSON.stringify(gpu)}`)
    const dir = join(work, `pane-${index}`)
    mkdirSync(dir)
    let lastView: any
    for (let frame = 0; frame < frames; frame++) {
      if (interrupted) throw new Error("Interrupted")
      const leader = index === versions.length - 1
      const car = lastView?.cars.find((c: any) => c.ownerId === lastView.robberId && !c.ghost)
      const input = leader ? scenario.input(frame, fps, car) : tape[frame]!.input
      const state = await adapter.step(page, frame, fps, input, !leader && !values["input-only"] ? tape[frame] : undefined)
      lastView = state.view
      if (leader) tape.push({ input, ...state })
      else if (!values["input-only"] && JSON.stringify(state) !== JSON.stringify({ view: tape[frame]!.view, camera: tape[frame]!.camera }))
        throw new Error(`Replay mismatch: ${v.label} frame ${frame}`)
      await page
        .locator(adapter.canvas)
        .screenshot({ path: join(dir, `${String(frame).padStart(5, "0")}.png`), scale: "device", animations: "disabled", timeout: 30_000 })
      if (errors.length) throw new Error(`${v.label}: ${errors.join("\n")}`)
      if (frame % 60 === 0) console.log(`${v.label}: ${frame + 1}/${frames}`)
    }
    reports[index] = { label: v.label, source: v.kind === "ref" ? v.sha : v.source, hookSourceSha256, adapter: gpu, frames }
    await page.close()
  }
  await browser.close()
  browser = undefined
  const job: Job = {
    quality,
    frames,
    fps,
    width,
    height,
    panes: versions.map((v, i) => ({ label: v.label, dir: relative(root, join(work, `pane-${i}`)) })),
    outputs: outputs.map((o, i) => ({ layout: o.layout, path: relative(root, join(work, "result", `${i}.mp4`)) })),
  }
  const manifest = {
    quality,
    deviceScaleFactor,
    zoom,
    game: values.game,
    scenario: scenario.name,
    seed,
    frames,
    fps,
    width,
    height,
    motion: values["input-only"] ? "same-input" : "last-version-world-and-camera",
    versions: reports,
    inputSha256: createHash("sha256")
      .update(JSON.stringify(tape.map((f) => f.input)))
      .digest("hex"),
  }
  await Bun.write(join(work, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
  await Bun.write(join(work, "tape.json"), JSON.stringify(tape))
  await Bun.write(join(work, "job.json"), JSON.stringify(job))
  await prepareLabels({ ...job, panes: job.panes.map((p) => ({ ...p, dir: resolve(root, p.dir) })) })
  await run(["hivemind", "check", "--", "ffmpeg", "-c:v", "h264_videotoolbox"])
  await run([
    "hivemind",
    "run",
    "--kind",
    "render",
    "--fetch",
    relative(root, join(work, "result")),
    "--",
    "bun",
    "scripts/compare-video/compose.ts",
    relative(root, join(work, "job.json")),
  ])
  for (const [i, output] of outputs.entries()) {
    mkdirSync(dirname(output.destination), { recursive: true })
    for (const suffix of [".mp4", "-sheet.jpg"])
      copyFileSync(join(work, "result", `${i}${suffix}`), output.destination.replace(/\.mp4$/, suffix))
    copyFileSync(join(work, "manifest.json"), output.destination.replace(/\.mp4$/, ".json"))
    console.log(
      `${output.destination} (${(statSync(output.destination).size / 1e6).toFixed(2)} MB)\n${output.destination.replace(/\.mp4$/, "-sheet.jpg")}`,
    )
  }
} finally {
  await browser?.close().catch(console.error)
  for (const name of previews) await run(["nexus", "stop", name]).catch(console.error)
  if (values.keep) console.log(`Kept frames: ${work}\nWorktrees: ${worktrees.join(", ")}`)
  else {
    for (const dir of worktrees) await run(["git", "worktree", "remove", "--force", dir]).catch(console.error)
    rmSync(work, { recursive: true, force: true })
  }
  process.off("SIGINT", interrupt)
  process.off("SIGTERM", interrupt)
}
