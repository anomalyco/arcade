// Sequential, muted Metal proof. Run from the repository root against the two Nexus previews.
import { browserBudget } from "./browser-budget.ts"
import ts from "typescript"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve, join, dirname } from "node:path"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"

await using budget = browserBudget()
const { chromium } = budget

const game = process.argv[2] ?? "getaway", label = process.argv[3] ?? "after", before = label === "before"
const base = process.env.BASE_REF ?? "8dff83439c254a6a70daaf2f934c12e918941f5c"
const root = resolve(import.meta.dir, ".."), gameRoot = join(root, "games", game)
const out = resolve(process.env.OUT ?? "captures/vehicle-kit")
mkdirSync(out, { recursive: true })
const cache = join(process.env.HOME, "Library/Caches/ms-playwright")
const chrome = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .map(n => join(cache, n, "chrome-headless-shell-mac-arm64/chrome-headless-shell")).find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const report = { game, label, base, frames: [], errors: [] }
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 640 }, deviceScaleFactor: 1 })
  page.on("pageerror", e => report.errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") report.errors.push(m.text()) })
  const assertClean = () => { if (report.errors.length) throw Error(report.errors.slice(0, 5).join("\n")) }
  await page.addInitScript(({ game }) => {
    window.AudioContext = game === "blackout"
      ? class extends OfflineAudioContext { constructor() { super(2, 48000, 48000) } resume() { return Promise.resolve() } }
      : class { constructor() { throw Error("Real-time audio prohibited in vehicle proof") } }
    if (game !== "blackout") return
    let seed = 7, clock = 0, callbacks = []
    Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
    performance.now = () => clock
    window.requestAnimationFrame = cb => { callbacks.push(cb); return callbacks.length }
    window.proofFrame = () => { clock += 1000/60; const next = callbacks; callbacks = []; for (const cb of next) cb(clock) }
  }, { game })
  const files = game === "getaway"
    ? ["game/chassis", "game/car-pose", "game/vehicle-emissions", "game/smoke-trail", "game/fx", "game/scene", "render/car-lights", "render/smoke", "audio/synth", "audio/drivetrain", "audio/nitro"]
    : ["game/vehicles", "game/game", "render/camera", "render/shaders", "render/renderer", "ui/debug-overlay", "audio/vehicle-sound"]
  await page.route(/\/src\/.*\.ts(?:\?.*)?$/, async route => {
    const url = new URL(route.request().url()), file = url.pathname.slice(5, -3)
    if (!(before && files.includes(file)) && !(game === "blackout" && file === "main")) return route.fallback()
    const response = await route.fetch(), current = await response.text()
    let body = current
    if (before && files.includes(file)) {
      const source = execFileSync("git", ["show", `${base}:games/${game}/src/${file}.ts`], { cwd: root, encoding: "utf8" })
      body = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText
      body = body.replace(/from "([^"]+)"/g, (all, name) => {
        if (name.startsWith(".")) {
          const disk = resolve(gameRoot, `src/${dirname(file)}`, name)
          if (name.includes("packages/kit/")) return `from "/@fs${disk}.ts"`
          const resolved = new URL(name, url)
          return `from "${resolved.pathname}${existsSync(disk + ".ts") ? ".ts" : "/index.ts"}"`
        }
        const external = current.match(new RegExp(`from "([^"]*${name}[^"]*)"`))
        if (!external) throw Error(`Unresolved baseline import: ${name}`)
        return `from "${external[1]}"`
      })
    }
    if (game === "blackout" && file === "main") {
      const anchor = "const resize = () => {"
      if (!body.includes(anchor)) throw Error("Blackout proof anchor missing")
      body = body.replace(anchor, `globalThis.vehicleProof = { game, cam, input, settings, renderer, device: renderer.device }; ${anchor}`)
    }
    await route.fulfill({ response, body })
  })
  const host = process.env.URL ?? `http://vehicle-kit-${game}.localhost:1355`
  await page.goto(`${host}/?${game === "getaway" ? "solo&bench&nohud&seed=7" : "practice&map=lot&seed=7"}`)
  await page.waitForFunction(game => game === "getaway" ? !!window.__getawayBench : !!window.vehicleProof, game, { polling: 100, timeout: 60000 })
    .catch(async e => { throw Error(`${e}\n${report.errors.join("\n")}\n${await page.locator("body").innerText()}`) })
  const adapter = await page.evaluate(async () => { const a = await navigator.gpu.requestAdapter(); return { vendor: a.info.vendor, architecture: a.info.architecture } })
  if (/swiftshader/i.test(JSON.stringify(adapter)) || adapter.vendor !== "apple") throw Error(`Expected Apple Metal: ${JSON.stringify(adapter)}`)
  report.adapter = adapter
  const shot = async (name, stats) => {
    assertClean()
    const bytes = await page.locator("canvas").first().screenshot({ path: join(out, `${game}-${label}-${name}.png`) })
    report.frames.push({ name, sha256: createHash("sha256").update(bytes).digest("hex"), ...stats })
  }
  if (game === "getaway") {
    await page.evaluate(async () => { await window.__getawayBench.ready; window.__getawayBench.reset(); window.__frames = [] })
    for (let i = 0; i < 180; i++) {
      const result = await page.evaluate(async i => {
        const frame = await window.__getawayBench.step(i, 1/30, true)
        window.__frames.push(frame.audio)
        return { pose: frame.pose, smoke: frame.smoke }
      }, i)
      if (i === 60 || i === 119) await shot(`chase-${i}`, result)
    }
    const audio = await page.evaluate(async () => {
      const { renderOffline } = await import("/src/audio/offline.ts")
      return renderOffline(window.__frames, true)
    })
    const bytes = Buffer.from(audio.wav)
    writeFileSync(join(out, `getaway-${label}.wav`), bytes)
    report.audio = { ...audio.stats, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length }
    if (audio.stats.clipped) throw Error("Offline mixer clipped")
  } else {
    const frames = async n => { for (let i = 0; i < n; i++) { await page.evaluate(async () => { window.proofFrame(); await window.vehicleProof.device.queue.onSubmittedWorkDone() }); assertClean() } }
    const keys = async codes => page.evaluate(codes => { const i = window.vehicleProof.input; i.release(); for (const code of codes) i.keys.add(code) }, codes)
    await frames(3)
    await page.evaluate(() => {
      const w = window.practice, p = [...w.players.values()].find(p => !p.brain), v = w.vehicles[0]
      w.botFill = 1; for (const [id, q] of w.players) if (q !== p) w.remove(id)
      Object.assign(v, { x: 32, y: 18, h: 0, vx: 0, vy: 0, w: 0 })
      Object.assign(p, { x: 32, y: 18, veh: v.id, seat: 0 }); v.seats[0] = p.id
      w.phaseEnd = w.time + 3600; window.vehicleProof.cam.snap(32, 18)
      window.vehicleProof.game.veh.clear()
    })
    const stats = id => page.evaluate(id => {
      const v = id === undefined ? window.practice.vehicles[0] : window.practice.vehicles.find(v => v.id === id), fx = window.vehicleProof.game.veh, d = fx.draws.get(v.id)
      return { pose: { x: v.x, y: v.y, h: v.h, vx: v.vx, vy: v.vy }, smoke: fx.emissions?.trail.count ?? 0, skids: fx.fx?.skidCount ?? fx.marks.length,
        roll: d.roll, pitch: d.pitch, pops: fx.emissions?.pops ?? 0 }
    }, id)
    await frames(45); await shot("lamps", await stats())
    await keys(["KeyW"]); await frames(85); await keys([]); await frames(3); await shot("pop", await stats())
    await keys(["KeyW", "KeyD", "ShiftLeft"]); await frames(35); await shot("drift", await stats())
    await keys([]); await frames(30); await keys(["KeyS"]); await frames(12); await shot("brake", await stats())
    if (!before) report.switches = await page.evaluate(() => {
      const settings = window.vehicleProof.settings, root = document.querySelector("[data-lab]").shadowRoot
      const keys = ["vehicleSprings", "vehicleWheels", "vehicleLamps", "vehicleSkids", "tyreSmoke", "vehicleSparks", "backfire", "vehicleImpact", "vehicleAudio"]
      const defaults = Object.fromEntries(keys.map(k => [k, settings[k]]))
      for (const key of keys) if (!root.querySelector(`[data-key="${key}"]`)) throw Error(`Missing Lab switch ${key}`)
      root.querySelector('[data-preset="off"]').click()
      if (keys.some(k => settings[k])) throw Error("Vehicle All Off failed")
      root.querySelector('[data-preset="on"]').click()
      if (keys.some(k => !settings[k])) throw Error("Vehicle All On failed")
      return defaults
    })
    if (!before) {
      for (const kind of ["van", "scooter"]) {
        await keys([])
        const id = await page.evaluate(kind => {
          const w = window.practice, p = [...w.players.values()].find(p => !p.brain), v = w.vehicles.find(v => v.kind === kind)
          for (const other of w.vehicles) { other.seats.fill(""); other.vx = other.vy = other.w = 0 }
          Object.assign(v, { x: 32, y: 18, h: 0, vx: 0, vy: 0, w: 0 })
          Object.assign(p, { x: 32, y: 18, veh: v.id, seat: 0 }); v.seats[0] = p.id
          window.vehicleProof.game.veh.clear(); window.vehicleProof.cam.snap(32, 18)
          return v.id
        }, kind)
        await frames(10); await keys(["KeyW"]); await frames(60)
        await keys(["KeyW", "KeyD", "ShiftLeft"]); await frames(25)
        const result = await stats(id)
        if (!Object.values(result.pose).every(Number.isFinite) || !Number.isFinite(result.roll + result.pitch)) throw Error(`${kind}: invalid presentation`)
        await shot(kind, result)
      }
      report.audio = await page.evaluate(async () => {
        const { VehicleSound } = await import("/src/audio/vehicle-sound.ts")
        const ctx = new OfflineAudioContext(2, 48000 * 7, 48000), master = ctx.createGain()
        master.connect(ctx.destination)
        let clock = 0
        Object.defineProperty(ctx, "currentTime", { get: () => clock })
        const sound = new VehicleSound({ bus: () => ({ ctx, master }) })
        let maxVoices = 0
        for (let i = 0; i < 180; i++) {
          clock = i / 30
          sound.enabled = i < 150
          sound.update(["jeep", "van", "scooter", "jeep", "van"].map((kind, id) => ({
            id, kind, dx: id * 3, dy: id * 2, speed: Math.min(i * 0.25, 24), thr: i < 120 ? 1 : 0,
            slip: i > 80 && i < 120 ? 6 : 0, horn: false, mine: id === 0, handbrake: i > 80 && i < 120,
          })))
          if (i === 120) sound.pop(0)
          maxVoices = Math.max(maxVoices, sound.voices.filter(v => v.id >= 0).length)
        }
        const buffer = await ctx.startRendering()
        let peak = 0, clipped = 0, tailPeak = 0
        for (let c = 0; c < buffer.numberOfChannels; c++) for (const [i, s] of buffer.getChannelData(c).entries()) {
          if (!Number.isFinite(s)) throw Error("Nonfinite vehicle audio")
          peak = Math.max(peak, Math.abs(s)); clipped += Number(Math.abs(s) >= 1)
          if (i > 48000 * 6) tailPeak = Math.max(tailPeak, Math.abs(s))
        }
        if (maxVoices !== 4 || peak === 0 || clipped || tailPeak > 0.0001) throw Error(`Vehicle mix failed: ${JSON.stringify({ maxVoices, peak, clipped, tailPeak })}`)
        return { maxVoices, peak, clipped, tailPeak, kinds: ["jeep", "van", "scooter"] }
      })
    }
  }
  writeFileSync(join(out, `${game}-${label}.json`), JSON.stringify(report, null, 2))
  if (report.errors.length) throw Error(report.errors.join("\n"))
  console.log(JSON.stringify(report, null, 2))
} finally { await browser.close() }
