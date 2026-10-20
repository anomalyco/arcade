// Door sound repeat check: a throwaway door in a wall (and a panic door with a closer), built only in this page, and
// the player walking or running into them and staying pressed against them. Every door sound event (DoorAudio.events:
// release, latch, bump, tick, rattle, control, creak loop start) is counted per scenario; a sustained contact must give
// at most one bump and never a run of them. One headless browser (960×600), closed at the end. Dev server on :5196.
//
//   bun scripts/doors-sound-check.ts
import { chromium } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"

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
  args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"],
})
let failed = 0
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.routeWebSocket(/.*/, () => {})
  await page.goto("http://localhost:5196/?view=lot&only=terrain")
  await page.waitForFunction(() => {
    const s = (globalThis as { __afterhours?: { ready: boolean; complete: boolean } }).__afterhours
    return !!s?.complete && s.ready
  }, null, { timeout: 240_000 })
  const run = <T>(body: string) => page.evaluate(`(async () => { const p = globalThis.__afterhoursPlayer; const D = globalThis.__afterhoursDoors; ${body} })()`) as Promise<T>
  // Two doors in walls: "snd" (steel, no closer) and "snd-panic" (panic bar + closer), hinges at z = hz, leaves along +x.
  const g = await run<{ hx: number; hz: number; y: number }>(`
    const Object3D = Object.getPrototypeOf(Object.getPrototypeOf(globalThis.__afterhoursDebug.scene)).constructor
    const hx = Math.round(p.pos.x) - 0.5, hz = Math.round(p.pos.z) - 4, y = p.pos.y
    const c = p.ctx.colliders
    c.push({ min: [hx - 4, y - 1, hz - 0.1], max: [hx, y + 3, hz + 0.1] }, { min: [hx + 1, y - 1, hz - 0.1], max: [hx + 7, y + 3, hz + 0.1] }, { min: [hx + 8, y - 1, hz - 0.1], max: [hx + 12, y + 3, hz + 0.1] })
    D.add({ id: "snd", leaf: new Object3D(), hinge: [hx, y, hz], width: 1, height: 2.05, thickness: 0.045, openAngle: Math.PI / 2, sound: "steel" })
    D.add({ id: "snd-panic", leaf: new Object3D(), hinge: [hx + 7, y, hz], width: 1, height: 2.05, thickness: 0.045, openAngle: Math.PI / 2, sound: "steel", panic: true })
    return { hx, hz, y }
  `)
  await page.keyboard.press("KeyQ")
  // (The doors' own procedural voice, creak loops included, starts on the first door use; start it as if E was used.)
  await run("D.audio?.unlock()")
  await page.waitForTimeout(2500)
  const setDoor = (id: string, t: number, dir: number) =>
    run(`const d = D.get("${id}"); Object.assign(d, { t: ${t}, target: ${t}, v: 0, dir: ${dir}, plan: null, free: false, touched: false, active: false, hold: 0, idle: 0 }); d.pose(${t}); d.apply()`)
  const stand = (x: number, z: number, yaw: number) => run(`p.pos.x = ${x}; p.pos.y = ${g.y + 0.05}; p.pos.z = ${z}; p.yaw = ${yaw}; p.pitch = 0; p.resetMotion()`)
  const events = () => run<{ t: number; kind: string }[]>("return [...D.soundEvents]")
  async function scenario(name: string, setup: () => Promise<unknown>, keys: string[], ms: number) {
    await setup()
    await page.waitForTimeout(300)
    const n0 = (await events()).length
    for (const k of keys) await page.keyboard.down(k)
    await page.waitForTimeout(ms)
    for (const k of keys) await page.keyboard.up(k)
    await page.waitForTimeout(600)
    const ev = (await events()).slice(n0)
    const count: Record<string, number> = {}
    for (const e of ev) count[e.kind] = (count[e.kind] ?? 0) + 1
    // A "run": three or more thuds (bump/latch) within 1.5 s.
    const thuds = ev.filter((e) => e.kind === "bump" || e.kind === "latch").map((e) => e.t)
    let burst = 0
    for (let i = 2; i < thuds.length; i++) if (thuds[i]! - thuds[i - 2]! < 1.5) burst++
    const ok = (count.bump ?? 0) <= 1 && (count.latch ?? 0) <= 1 && burst === 0
    if (!ok) failed++
    console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(58)} ${JSON.stringify(count)}`)
  }
  const { hx, hz } = g
  // n = +z; dir +1 swings the leaf towards −z, so the push side is +z.
  await scenario("walk into an ajar door (push side), hold W 5 s", () => Promise.all([setDoor("snd", 0.15, 1), stand(hx + 0.5, hz + 1.4, 0)]), ["KeyW"], 5000)
  await scenario("run into an ajar door (push side), hold 5 s", () => Promise.all([setDoor("snd", 0.15, 1), stand(hx + 0.5, hz + 2.5, 0)]), ["ShiftLeft", "KeyW"], 5000)
  await scenario("walk into an ajar door from its swing side, hold 5 s", () => Promise.all([setDoor("snd", 0.3, 1), stand(hx + 0.5, hz - 1.6, Math.PI)]), ["KeyW"], 5000)
  await scenario("press into the open leaf near its hinge (diagonal), hold 5 s", () => Promise.all([setDoor("snd", 0.6, 1), stand(hx + 0.9, hz + 0.9, 0.6)]), ["KeyW"], 5000)
  await scenario("run diagonally into the open leaf near its hinge, hold 5 s", () => Promise.all([setDoor("snd", 0.6, 1), stand(hx + 1.6, hz + 1.6, 0.75)]), ["ShiftLeft", "KeyW"], 5000)
  await scenario("strafe into an ajar leaf, hold D 5 s", () => Promise.all([setDoor("snd", 0.5, 1), stand(hx - 0.9, hz - 0.35, 0)]), ["KeyD"], 5000)
  await scenario("shut latched door: walk into it, hold 5 s", () => Promise.all([setDoor("snd", 0, 1), stand(hx + 0.5, hz + 1.4, 0)]), ["KeyW"], 5000)
  await scenario("panic door: push open, then stand in the doorway 7 s", () => Promise.all([setDoor("snd-panic", 0, 1), stand(hx + 7.5, hz + 1.4, 0)]), ["KeyW"], 900)
  // (Standing still now in the doorway, the closer comes for the leaf.)
  await scenario("  … still in the doorway while the closer works", async () => {}, [], 7000)
  await scenario("push a door half open, then stand in the doorway 6 s", () => Promise.all([setDoor("snd", 0.5, 1), stand(hx + 0.5, hz + 0.8, 0)]), ["KeyW"], 700)
  await scenario("  … still in the doorway", async () => {}, [], 6000)
  console.log(errors.length ? `page errors: ${errors.slice(0, 3).join(" | ")}` : "no page errors")
} finally {
  await browser.close()
}
process.exit(failed ? 1 : 0)
