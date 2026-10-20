// Lift-ambush flow check in play mode: Play → skip the intro → into 3-08 (checkpoint, Wendigo warmed) → ride the lift
// → ambush → death screen → Restart from checkpoint (back in 3-08) → ride again → death → Start over (reload into the
// intro). Records the whole page and cuts the first jump scare to captures/ambush-scare.mp4, plus stills.
// Headless, muted, 1280×720, one page.
//
//   bun scripts/ambush-check.ts [--base http://localhost:5196/]
import { chromium, type Page } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs"

const args = process.argv.slice(2)
const base = args.includes("--base") ? args[args.indexOf("--base") + 1]! : "http://localhost:5196/"
const out = `${import.meta.dir}/../captures`
mkdirSync(out, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: out, size: { width: 1280, height: 720 } } })
const t0 = Date.now()
const page = await ctx.newPage()
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
const stubWarnings: string[] = []
page.on("console", (m) => m.text().includes("death path not wired") && stubWarnings.push(m.text()))
const failures: string[] = []
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) failures.push(what)
}
type Any = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const G = (page: Page, fn: string) => page.evaluate(fn)
const phase = () => G(page, "globalThis.__static?.flow.phase")
const shot = (name: string) => page.screenshot({ path: `${out}/ambush-${name}.png` })

/** Feet position (the controller's state object is live). */
const put = (x: number, y: number, z: number) =>
  G(page, `(() => { const p = globalThis.__afterhoursPlayer; p.pos.x = ${x}; p.pos.y = ${y}; p.pos.z = ${z}; p.resetMotion(); })()`)
const STOREY = (s: number) => 0.16 + s * 3.8

async function intoRun() {
  await page.waitForFunction(() => (globalThis as Any).__afterhours?.complete, null, { timeout: 180_000 })
  await page.waitForTimeout(1500)
  if ((await phase()) === "menu") await page.click("text=Play")
  // Skip the title card (Space) and the intro (hold Space) until explore.
  for (let k = 0; k < 40 && (await phase()) !== "explore"; k++) {
    await page.waitForTimeout(1000)
    const ph = await phase()
    if (ph === "title") await page.keyboard.press("Space")
    else if (ph === "intro") {
      await page.keyboard.down("Space")
      await page.waitForTimeout(1500)
      await page.keyboard.up("Space")
    }
  }
  await page.waitForFunction(() => (globalThis as Any).__static?.flow.phase === "explore", null, { timeout: 60_000 })
  await page.waitForTimeout(1500)
}

async function hunterDeath(tag: string) {
  await put(8, STOREY(3) + 0.02, 0)
  await page.waitForTimeout(600)
  // After a restore it has a grace period: let it run out before it's put on the player.
  await page.waitForFunction(() => ((globalThis as Any).__ashwoodHunter?.hunter.grace ?? 0) <= 0, null, { timeout: 20_000 })
  await G(page, "globalThis.__ashwoodHunter.handle.start(-3, 0, 3)")
  // The catch plays the picked death scene (src/game/death/variants.ts): the input locks, then the death screen.
  await page.waitForFunction(() => (globalThis as Any).__static?.flow.hold === true, null, { timeout: 60_000 })
  const at = Date.now() - t0
  check(true, `${tag}: caught by the hunter (+${(at / 1000).toFixed(1)} s)`)
  await page.waitForTimeout(700)
  await shot(`${tag}-scene`)
  await page.waitForFunction(() => document.body.dataset.modal === "death", null, { timeout: 10_000 })
  await page.waitForTimeout(2800)
  await shot(`${tag}-death`)
  const s = (await G(page, "({ paused: globalThis.__static.flow.paused, modal: document.body.dataset.modal, hunter: globalThis.__ashwoodHunter.hunter.mode, caught: !!document.querySelector('div[style*=\"CAUGHT\"]') || [...document.querySelectorAll('div')].some((d) => d.textContent === 'CAUGHT') })")) as Any
  check(s.paused && s.modal === "death" && s.hunter === "dormant" && !s.caught, `${tag}: death screen, hunter dormant, no stub flash (${JSON.stringify(s)})`)
  return at
}

let pounceAt = 0
async function rideAndDie(tag: string, walkOut: boolean) {
  // Into the car at its current floor, facing the doors, then send it to another floor.
  const st = (await G(page, "globalThis.__interior.lift.state()")) as Any
  await put(-37.85, STOREY(st.cur) + 0.02, 20.3)
  await G(page, "(() => { const p = globalThis.__afterhoursPlayer; p.yaw = 0; p.pitch = -0.05 })()")
  await page.waitForTimeout(800)
  const dest = st.cur === 2 ? 1 : 2
  await G(page, `globalThis.__interior.lift.press("${dest}")`)
  await page.waitForFunction(() => (globalThis as Any).__ashwoodAmbush?.phase === "lurk", null, { timeout: 60_000 })
  const at = Date.now() - t0
  console.log(`${tag}: arrived at storey ${dest}, lurking (+${(at / 1000).toFixed(1)} s)`)
  const s0 = (await G(page, "({ hold: globalThis.__static.flow.hold, scare: document.body.dataset.scare ?? null, visible: globalThis.__ashwoodAmbush.visible })")) as Any
  check(!s0.hold && s0.scare === null && !s0.visible, `${tag}: arrival is ordinary (no hold, HUD up, creature not drawn) ${JSON.stringify(s0)}`)
  await page.waitForFunction(() => ((globalThis as Any).__interior.lift.state().doorT ?? 0) > 0.8, null, { timeout: 10_000 })
  await shot(`${tag}-open`)
  // Stills (second ride): hold the pounce part-way and just before the hit.
  if (!walkOut) await G(page, "globalThis.__ashwoodAmbush.freezeAt = 0.4")
  if (walkOut) await page.keyboard.down("KeyW")
  await page.waitForFunction(() => ["pounce", "dead"].includes((globalThis as Any).__ashwoodAmbush?.phase), null, { timeout: 15_000 })
  if (!pounceAt) pounceAt = Date.now() - t0
  const how = (await G(page, "({ z: globalThis.__afterhoursPlayer.pos.z, doorT: globalThis.__interior.lift.state().doorT })")) as Any
  console.log(`${tag}: pounce at player z ${how.z.toFixed(2)} (threshold 19.45), doorT ${how.doorT.toFixed(2)}`)
  if (walkOut) check(how.z < 19.6, `${tag}: it came as the player stepped out`)
  if (!walkOut) {
    await page.waitForTimeout(500)
    await shot(`${tag}-pounce`)
    await G(page, "globalThis.__ashwoodAmbush.freezeAt = 0.93")
    await page.waitForTimeout(500)
    await shot(`${tag}-near`)
    await G(page, "globalThis.__ashwoodAmbush.freezeAt = null")
  } else {
    await page.waitForTimeout(150)
    await shot(`${tag}-pounce`)
  }
  await page.waitForFunction(() => (globalThis as Any).__ashwoodAmbush?.phase === "dead", null, { timeout: 5_000 })
  if (walkOut) await page.keyboard.up("KeyW")
  await shot(`${tag}-contact`)
  await page.waitForTimeout(150)
  await shot(`${tag}-flood`)
  await page.waitForTimeout(2600)
  await shot(`${tag}-death`)
  const s = (await G(page, "({ paused: globalThis.__static.flow.paused, modal: document.body.dataset.modal, lock: !!document.pointerLockElement })")) as Any
  check(s.paused === true && s.modal === "death" && !s.lock, `${tag}: world paused, death screen up, pointer free`)
  return at
}

try {
  await page.goto(base)
  await intoRun()
  check((await phase()) === "explore", "explore after the intro")
  const cps0 = (await G(page, "sessionStorage.getItem('afterhours.checkpoint')")) as string | null
  check(!!cps0 && JSON.parse(cps0).id === "arrival", `arrival checkpoint (${cps0 && JSON.parse(cps0).id})`)
  // Into 3-08 (storey 3): the objective advances, the checkpoint lands, the Wendigo loads and warms.
  await put(6, STOREY(3) + 0.02, 0)
  await page.waitForTimeout(2500)
  await put(5.5, STOREY(3) + 0.02, -10)
  await page.waitForTimeout(3000)
  console.log("after teleport", JSON.stringify(await G(page, "({ pos: { ...globalThis.__afterhoursPlayer.pos }, cam: globalThis.__afterhoursPlayer.state?.eye, amb: globalThis.__ashwoodAmbush?.phase, obj: document.querySelector('.objective')?.textContent, cp: sessionStorage.getItem('afterhours.checkpoint')?.slice(0, 60), active: globalThis.__static.flow.playerActive, paused: globalThis.__static.flow.paused })")))
  await shot("teleport")
  await page.waitForFunction(() => (globalThis as Any).__ashwoodAmbush?.phase === "armed", null, { timeout: 60_000 })
  const cp = JSON.parse(((await G(page, "sessionStorage.getItem('afterhours.checkpoint')")) as string) ?? "{}")
  check(cp.id === "3-08:entered", `3-08 checkpoint (${cp.id}), Wendigo warmed in ${await G(page, "globalThis.__ashwoodAmbush.stats.warmMs")} ms`)
  await shot("308")
  const scareAt = await rideAndDie("first", true)
  let hunterAt = 0

  // Restart from checkpoint: back in 3-08, playing.
  await page.click("text=Restart from checkpoint")
  await page.waitForTimeout(1200)
  const r = (await G(page, "({ phase: globalThis.__static.flow.phase, paused: globalThis.__static.flow.paused, hold: globalThis.__static.flow.hold, pos: { ...globalThis.__afterhoursPlayer.pos }, amb: globalThis.__ashwoodAmbush.phase, modal: document.body.dataset.modal ?? null })")) as Any
  const inside = r.pos.x > 0.8 && r.pos.x < 11.6 && r.pos.z > -21.65 && r.pos.z < -1.75 && Math.abs(r.pos.y - STOREY(3)) < 0.5
  check(!r.paused && !r.hold && r.modal === null && inside && r.amb === "armed", `restart: back in 3-08 and playing (${JSON.stringify(r)})`)
  await shot("restart")
  await rideAndDie("second", false)

  // Restart again (pre-reveal checkpoint): the hunter must be asleep.
  await page.click("text=Restart from checkpoint")
  await page.waitForTimeout(1200)
  check((await G(page, "globalThis.__ashwoodHunter?.hunter.mode")) === "dormant", `pre-reveal restart: hunter dormant (${await G(page, "globalThis.__ashwoodHunter?.hunter.mode")})`)
  // The reveal (as if the warning had been read): the checkpoint lands; then the hunter is put in the storey 3
  // corridor 10 m from the player and hunts them down.
  await G(page, `(() => { const t = globalThis.__ashwoodTransmitter; for (const p of ["warming", "on", "transmitting", "transmitted", "revealed"]) t.set(p) })()`)
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("afterhours.checkpoint") ?? "{}").id === "3-08:transmitted", null, { timeout: 20_000 })
  check(true, "reveal checkpoint 3-08:transmitted")
  hunterAt = await hunterDeath("hunter1")
  await page.click("text=Restart from checkpoint")
  await page.waitForTimeout(1500)
  const hr = (await G(page, "(() => { const h = globalThis.__ashwoodHunter.hunter; const p = globalThis.__afterhoursPlayer.pos; return { mode: h.mode, grace: h.grace, dist: Math.hypot(h.pos.x - p.x, h.pos.z - p.z), s: h.s, paused: globalThis.__static.flow.paused, amb: globalThis.__ashwoodAmbush.phase } })()")) as Any
  check(hr.mode !== "dormant" && hr.grace > 0 && hr.dist > 10 && !hr.paused && hr.amb === "armed", `post-reveal restart: hunter restored far away with grace (${JSON.stringify(hr)})`)
  await shot("hunter-restart")
  await hunterDeath("hunter2")

  // Start over: a fresh page straight into the intro.
  await page.click("text=Start over")
  await page.waitForFunction(() => (globalThis as Any).__afterhours?.complete, null, { timeout: 180_000 })
  await page.waitForFunction(() => (globalThis as Any).__static?.flow.phase === "intro" || (globalThis as Any).__static?.flow.phase === "title", null, { timeout: 60_000 })
  check(true, `start over: reloaded into ${await phase()}`)
  await page.waitForTimeout(3000)
  await shot("startover")
  check((await G(page, "sessionStorage.getItem('afterhours.checkpoint')")) === null, "start over cleared the checkpoint")

  check(stubWarnings.length === 0, `no "death path not wired yet" warning (${stubWarnings.length})`)
  check(errors.length === 0, `no page errors (${errors.slice(0, 3).join(" | ")})`)
  const raw = await page.video()!.path()
  await ctx.close()
  renameSync(raw, `${out}/ambush-raw.webm`)
  // The first scare: from 1.5 s before the doors open to the death screen.
  const ss = Math.max(0, pounceAt / 1000 - 4.5)
  void scareAt
  Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-ss", ss.toFixed(2), "-i", `${out}/ambush-raw.webm`, "-t", "8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", `${out}/ambush-scare.mp4`])
  console.log(`video: ${out}/ambush-scare.mp4 (from +${ss.toFixed(1)} s of ambush-raw.webm)`)
  const hs = Math.max(0, hunterAt / 1000 - 1.5)
  Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-ss", hs.toFixed(2), "-i", `${out}/ambush-raw.webm`, "-t", "7", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", `${out}/hunter-scare.mp4`])
  console.log(`video: ${out}/hunter-scare.mp4`)
} catch (e) {
  console.log("FAIL", e)
  failures.push(String(e))
  await shot("error").catch(() => {})
  await ctx.close().catch(() => {})
}
await browser.close()
console.log(failures.length ? `${failures.length} failure(s)` : "all ok")
process.exit(failures.length ? 1 : 0)
