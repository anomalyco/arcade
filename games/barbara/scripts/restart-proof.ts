/** Real workerd + SQLite + two production OnlineSessions. Restart once unchanged, then roll a build with stale
 * assets for two reloads. Run through HiveMind browser; no GPU, visible windows, audio, or production test routes. */
import { strict as assert } from "node:assert"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import type { Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"
import { writeBuildId } from "../../../scripts/build-id"
import type { OnlineSession } from "../src/session"
import type { PlayerInput } from "../shared/sim"

declare const probe: { session: OnlineSession; input: PlayerInput; loads: number; build: string }
const root = resolve(import.meta.dir, ".."), buildFile = join(root, "shared/build.gen.ts")
writeBuildId(root)
const originalBuild = await readFile(buildFile, "utf8")
const scratch = await mkdtemp(join(tmpdir(), "barbara-restart-")), assets = join(scratch, "assets")
const fixture = join(assets, "arcade/barbara")
await mkdir(fixture, { recursive: true })
await writeFile(join(fixture, "index.html"), '<!doctype html><title>Room restart proof</title><script type="module" src="./client.js"></script>')
const buildClient = async () => {
  const result = await Bun.build({ entrypoints: [join(root, "scripts/restart-client.ts")], target: "browser", minify: false })
  if (!result.success) throw new Error(result.logs.join("\n"))
  await writeFile(join(fixture, "client.js"), await result.outputs[0]!.text())
}
await buildClient()
const config = JSON.parse(await readFile(join(root, "wrangler.jsonc"), "utf8"))
Object.assign(config, { name: "barbara-restart-proof", main: join(root, "server/index.ts"), routes: [], assets: { ...config.assets, directory: assets } })
const configFile = join(scratch, "wrangler.json")
await writeFile(configFile, JSON.stringify(config))
// Let the OS choose an unused port, then hand it to Wrangler.
const reservation = Bun.serve({ port: 0, fetch: () => new Response() })
const port = reservation.port!
reservation.stop(true)
const base = `http://127.0.0.1:${port}/arcade/barbara/`, url = `${base}?room=proof1`
let worker: ChildProcess | undefined, logs = ""
async function stop() {
  if (!worker) return
  const p = worker; worker = undefined
  if (p.exitCode !== null || p.signalCode !== null) return
  await new Promise<void>((resolve) => {
    const deadline = setTimeout(() => { try { process.kill(-p.pid!, "SIGKILL") } catch {} }, 5000)
    p.once("exit", () => { clearTimeout(deadline); resolve() })
    process.kill(-p.pid!, "SIGTERM")
  })
}
async function start() {
  worker = spawn(process.execPath, ["x", "--no-install", "wrangler", "dev", "--local", "--config", configFile, "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0", "--persist-to", join(scratch, "storage")], { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  const p = worker
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Wrangler start timeout: ${logs}`)), 30_000)
    const data = (chunk: Buffer) => { const text = chunk.toString(); logs += text; if (/Ready on/.test(text)) { clearTimeout(timeout); resolve() } }
    p.stdout!.on("data", data); p.stderr!.on("data", data)
    p.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Wrangler exited ${code}: ${logs}`)) })
  })
}
const ready = (p: Page, version = 1) => p.waitForFunction((v) => typeof probe !== "undefined" && probe.session.me > 0 && probe.session.poseVersion >= v && !probe.session.status(), version, { timeout: 30_000 })
const read = (p: Page) => p.evaluate(() => ({ me: probe.session.me, x: probe.session.self.x, z: probe.session.self.z, yaw: probe.session.self.yaw, pitch: probe.session.self.pitch, map: probe.session.self.map, t: probe.session.view.t, night: probe.session.view.night.seed, loads: probe.loads, build: probe.build }))
const check = (before: Awaited<ReturnType<typeof read>>, after: Awaited<ReturnType<typeof read>>) => {
  assert.equal(after.me, before.me)
  assert.ok(Math.hypot(after.x - before.x, after.z - before.z) < 0.08, "position restored")
  assert.ok(Math.abs(after.yaw - before.yaw) < 0.001 && Math.abs(after.pitch - before.pitch) < 0.001, "facing restored")
  assert.deepEqual(after.map, before.map)
  assert.equal(after.night, before.night, "night layout restored")
  assert.ok(after.t >= before.t - 2.1 && after.t < before.t + 10, "night clock continued")
}
await using budget = browserBudget()
try {
  await start()
  const browser = await budget.chromium.launch({ headless: true, args: ["--mute-audio"] })
  const pages = await Promise.all([1, 2].map(async () => {
    const c = await browser.newContext(), p = await c.newPage()
    p.on("pageerror", (e) => console.error("restart client:", e.message))
    await p.goto(url); await ready(p)
    return p
  }))
  const jumper = (await read(pages[0]!)).me
  await pages[1]!.waitForFunction((id) => probe.session.view.players.some((p) => p.id === id && p.air.y === 0 && p.charge > 0.9), jumper)
  await pages[0]!.evaluate(() => { probe.input.jump = true })
  await pages[1]!.waitForFunction((id) => probe.session.view.players.some((p) => p.id === id && p.air.y > 0.1 && p.charge > 0.9), jumper)
  await pages[1]!.waitForFunction((id) => probe.session.view.players.some((p) => p.id === id && p.air.y === 0), jumper)
  console.log("PASS remote hop height and torch charge decode independently")
  console.log("Both clients joined; walking until each records a path sample")
  // Concurrent pages can join in either order. Walk away from each other using seat order, not page order.
  await Promise.all(pages.map((p) => p.evaluate(() => {
    const right = probe.session.me === 2
    Object.assign(probe.input, { mx: right ? 1 : -1, yaw: right ? -0.7 : 0.8, pitch: right ? -0.2 : 0.25 })
  })))
  await Promise.all(pages.map(async (p) => {
    try { await p.waitForFunction(() => probe.session.self.map.trail.length >= 4) }
    catch (error) { console.error("walk stalled:", await read(p)); throw error }
  }))
  await Promise.all(pages.map((p) => p.evaluate(() => { probe.input.mx = 0 })))
  // Wait by the production room clock: movement settled and at least one periodic SQLite checkpoint committed.
  const t = (await read(pages[0]!)).t
  await pages[0]!.waitForFunction((t) => probe.session.view.t > t + 2.5, t)
  const before = await Promise.all(pages.map(read))
  await stop(); await start()
  await Promise.all(pages.map((p) => ready(p, 2)))
  const resumed = await Promise.all(pages.map(read))
  resumed.forEach((a, i) => check(before[i]!, a))
  assert.ok(resumed.every((a) => a.loads === 1), "same build rejoins without a page reload")
  console.log("PASS two clients resume their seats, positions, facing, map trails and night clock after a workerd restart")

  const beforeDeploy = await Promise.all(pages.map(read))
  await stop()
  await writeFile(buildFile, 'export const BUILD = "restart-new"\n')
  await start() // Server is new; deliberately keep the old client assets through two automatic reloads.
  await Promise.all(pages.map((p) => p.waitForFunction(() => typeof probe !== "undefined" && probe.loads >= 3, null, { timeout: 25_000 })))
  await buildClient()
  await Promise.all(pages.map((p) => p.waitForFunction(() => typeof probe !== "undefined" && probe.build === "restart-new" && probe.session.me > 0 && !probe.session.status(), null, { timeout: 30_000 })))
  const deployed = await Promise.all(pages.map(read))
  // BUILD hashes shared simulation/world code. Incompatible saves are discarded rather than misread.
  deployed.forEach((a, i) => {
    assert.notDeepEqual(a.map, beforeDeploy[i]!.map, "incompatible saved map discarded")
    assert.ok(a.map.trail.length <= 2, "new night starts with a fresh map")
    assert.ok(a.t < 5, "incompatible build starts a fresh night")
  })
  assert.ok(pages.every((p) => p.url() === url), "reload keeps the room URL")
  console.log("PASS two clients reload through stale assets; incompatible shared build starts a fresh night")
  const out = resolve(root, "../../captures/barbara-restart")
  await mkdir(out, { recursive: true })
  await writeFile(join(out, "restart.json"), JSON.stringify({ before, resumed, deployed }, null, 2))
} catch (e) {
  console.error(logs)
  throw e
} finally {
  await stop()
  await writeFile(buildFile, originalBuild)
  await rm(scratch, { recursive: true, force: true })
}
