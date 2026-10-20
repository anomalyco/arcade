// Sprint steadiness check: holds Shift+W (physical keys) down long straight runs (the ground-floor corridor, the parking
// lot, the access road, the forest) and logs every controller frame: speed, Shift held, the `running` flag, the
// stairs slowdown, crouch, grounded and dt. Holding Shift must give a steady run: after the ramp-up, no frame drops out
// of `running` and the speed never falls to a walk. One headless browser (800×520), closed at the end. Dev server on
// :5196. Exits 1 on any failure.
//
//   bun scripts/sprint-check.ts            # per-run summary
//   bun scripts/sprint-check.ts --log f    # also writes the per-frame traces (JSON) to f
import { chromium } from "playwright-core"
import { existsSync, readdirSync, writeFileSync } from "node:fs"

const args = process.argv.slice(2)
const logIdx = args.indexOf("--log")
const logFile = logIdx >= 0 ? args[logIdx + 1] : undefined

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"],
})
type Sample = { t: number; dt: number; x: number; z: number; y: number; base: number; offset: number; speed: number; running: boolean; shift: boolean; stairs: number; blocked: boolean; crouch: number; grounded: boolean; input: boolean }
const logs: Record<string, Sample[]> = {}
let failed = 0
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 520 } })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.routeWebSocket(/.*/, () => {})
  await page.goto("http://localhost:5196/?view=corridor")
  await page.waitForFunction(() => {
    const s = (globalThis as { __ashwood?: { ready: boolean; complete: boolean } }).__ashwood
    return !!s?.complete && s.ready
  }, null, { timeout: 240_000 })
  type Flow = { phase: string; playerActive: boolean }
  const flow = () => page.evaluate(() => (globalThis as unknown as { __static?: { flow: Flow } }).__static?.flow ?? null)
  const walk = await page.evaluate(() => Number((globalThis as unknown as { __ashwoodPlayer: { ctx: { settings: Record<string, unknown> } } }).__ashwoodPlayer.ctx.settings["player.walk"]))

  async function sprint(name: string, x: number, z: number, yaw: number, ms: number) {
    await page.evaluate(
      ([x, z, yaw]) => {
        const p = (globalThis as unknown as { __ashwoodPlayer: { pos: { x: number; y: number; z: number }; yaw: number; pitch: number; resetMotion(): void; trace: unknown[] | null } }).__ashwoodPlayer
        p.pos.x = x!
        p.pos.z = z!
        // Outdoors: drop in from just above the terrain; indoors (the corridor view): stay on the floor.
        if (Math.hypot(x! + 11, z! - 0.2) > 1) p.pos.y = 6
        p.yaw = yaw!
        p.pitch = 0
        p.resetMotion()
      },
      [x, z, yaw],
    )
    // Fall to the ground and settle.
    await page.waitForTimeout(1500)
    await page.evaluate(() => ((globalThis as unknown as { __ashwoodPlayer: { trace: unknown[] | null } }).__ashwoodPlayer.trace = []))
    await page.keyboard.down("ShiftLeft")
    await page.keyboard.down("KeyW")
    await page.waitForTimeout(ms)
    await page.keyboard.up("KeyW")
    await page.keyboard.up("ShiftLeft")
    const tr = (await page.evaluate(() => {
      const p = (globalThis as unknown as { __ashwoodPlayer: { trace: unknown[] | null } }).__ashwoodPlayer
      const t = p.trace
      p.trace = null
      return t
    })) as Sample[]
    logs[name] = tr
    // Skip the ramp (first 1.2 s), stop at the first frame that went nowhere (a wall): judge the steady part.
    const t0 = tr[0]!.t
    const steady = tr.filter((s) => s.t - t0 > 1.2 && s.shift)
    let end = steady.length
    // (Running into a wall or a door: leave out the last half second before it.)
    for (let i = 0; i < steady.length; i++) if (steady[i]!.speed < 0.5) { const tw = steady[i]!.t - 0.5; end = steady.findIndex((s) => s.t > tw); break }
    const st = steady.slice(0, end)
    const drops = st.filter((s) => !s.running).length
    let flips = 0
    for (let i = 1; i < st.length; i++) if (st[i]!.running !== st[i - 1]!.running) flips++
    const sp = st.map((s) => s.speed)
    const min = Math.min(...sp)
    const mean = sp.reduce((a, b) => a + b, 0) / (sp.length || 1)
    // Under 90% of the run, apart from a real flight of stairs (the controller's 0.75× there) or brushing a collider
    // (a tree), and the half second it takes to get back up to speed after either.
    let excused = -1
    const slow = st.filter((s) => {
      if (s.stairs > 0 || s.blocked) excused = s.t
      return s.speed < 4.5 * 0.9 && s.t - excused > 0.5
    }).length
    const hits = st.filter((s) => s.blocked).length
    const stairs = st.filter((s) => s.stairs > 0).length
    const crouch = st.filter((s) => s.crouch > 0.5).length
    const air = st.filter((s) => !s.grounded).length
    const maxDt = Math.max(...st.map((s) => s.dt))
    const shiftLost = st.filter((s) => !s.shift || !s.input).length
    const ok = st.length > 60 && drops === 0 && slow === 0 && shiftLost === 0
    if (!ok) failed++
    console.log(
      `${ok ? "ok  " : "FAIL"} ${name.padEnd(16)} ${st.length} frames: mean ${mean.toFixed(2)} min ${min.toFixed(2)} m/s · <90% ${slow} · !running ${drops} (flips ${flips}) · stairs ${stairs} · blocked ${hits} · crouch ${crouch} · air ${air} · Shift lost ${shiftLost} · max dt ${(maxDt * 1000).toFixed(0)} ms`,
    )
  }
  console.log(`walk setting ${walk} m/s`)
  await sprint("corridor", -11, 0.2, Math.PI / 2, 9000)
  await sprint("lot", -26, 100, Math.PI / 2, 7000)
  await sprint("access road", -2, 250, 0.05, 9000)
  await sprint("forest", -70, 175, -0.7, 8000)
  await sprint("gate→entrance", -2.5, 142, -0.02, 9000)
  // Play mode (the real shell: the per-frame input gate, the run's hooks): the arrival chapter, by the car in the lot.
  await page.goto("http://localhost:5196/?play&start=arrival")
  await page.waitForFunction(() => (globalThis as unknown as { __ashwood?: { complete: boolean } }).__ashwood?.complete, null, { timeout: 240_000 })
  await page.waitForTimeout(1500)
  if ((await flow())?.phase === "menu") await page.click("text=Play")
  await page.waitForFunction(() => (globalThis as unknown as { __static?: { flow: Flow } }).__static?.flow.playerActive, null, { timeout: 60_000 })
  await page.waitForTimeout(1000)
  const at = await page.evaluate(() => ({ ...(globalThis as unknown as { __ashwoodPlayer: { pos: { x: number; z: number } } }).__ashwoodPlayer.pos }))
  await sprint("play: lot west", at.x, at.z, Math.PI / 2, 8000)
  await sprint("play: lot north", at.x, at.z, 0, 8000)
  await sprint("play: road", -2, 250, 0.05, 9000)
  console.log(errors.length ? `page errors: ${errors.slice(0, 3).join(" | ")}` : "no page errors")
} finally {
  await browser.close()
}
if (logFile) writeFileSync(logFile, JSON.stringify(logs))
process.exit(failed ? 1 : 0)
