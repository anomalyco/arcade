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

async function rideAndDie(tag: string) {
  // Into the car at its current floor, then send it to storey 2.
  const st = (await G(page, "globalThis.__interior.lift.state()")) as Any
  await put(-37.85, STOREY(st.cur) + 0.02, 21.2)
  await page.waitForTimeout(800)
  const dest = st.cur === 2 ? 1 : 2
  await G(page, `globalThis.__interior.lift.press("${dest}")`)
  await page.waitForFunction(() => (globalThis as Any).__ashwoodAmbush?.phase === "waiting", null, { timeout: 60_000 })
  const at = Date.now() - t0
  console.log(`ambush triggered at storey ${dest} (+${(at / 1000).toFixed(1)} s)`)
  await page.waitForFunction(() => (globalThis as Any).__ashwoodAmbush?.phase === "beat", null, { timeout: 10_000 })
  await shot(`${tag}-beat`)
  await page.waitForFunction(() => (globalThis as Any).__ashwoodAmbush?.phase === "lunge", null, { timeout: 5_000 })
  await page.waitForTimeout(280)
  await shot(`${tag}-lunge`)
  await page.waitForFunction(() => (globalThis as Any).__ashwoodAmbush?.phase === "dead", null, { timeout: 5_000 })
  await page.waitForTimeout(150)
  await shot(`${tag}-flood`)
  await page.waitForTimeout(2600)
  await shot(`${tag}-death`)
  const s = (await G(page, "({ paused: globalThis.__static.flow.paused, modal: document.body.dataset.modal, lock: !!document.pointerLockElement, stats: globalThis.__ashwoodAmbush.stats })")) as Any
  check(s.paused === true && s.modal === "death" && !s.lock, `${tag}: world paused, death screen up, pointer free`)
  const fm = (s.stats.frameMs as number[]).slice(-200)
  console.log(`${tag}: warm ${s.stats.warmMs} ms; scare frames ${fm.length}, max ${Math.max(...fm)} ms, >33 ms: ${fm.filter((x) => x > 33).length}; ${fm.join(",")}`)
  await G(page, "globalThis.__ashwoodAmbush.stats.frameMs.length = 0")
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
  const scareAt = await rideAndDie("first")

  // Restart from checkpoint: back in 3-08, playing.
  await page.click("text=Restart from checkpoint")
  await page.waitForTimeout(1200)
  const r = (await G(page, "({ phase: globalThis.__static.flow.phase, paused: globalThis.__static.flow.paused, hold: globalThis.__static.flow.hold, pos: { ...globalThis.__afterhoursPlayer.pos }, amb: globalThis.__ashwoodAmbush.phase, modal: document.body.dataset.modal ?? null })")) as Any
  const inside = r.pos.x > 0.8 && r.pos.x < 11.6 && r.pos.z > -21.65 && r.pos.z < -1.75 && Math.abs(r.pos.y - STOREY(3)) < 0.5
  check(!r.paused && !r.hold && r.modal === null && inside && r.amb === "armed", `restart: back in 3-08 and playing (${JSON.stringify(r)})`)
  await shot("restart")
  await rideAndDie("second")

  // Start over: a fresh page straight into the intro.
  await page.click("text=Start over")
  await page.waitForFunction(() => (globalThis as Any).__afterhours?.complete, null, { timeout: 180_000 })
  await page.waitForFunction(() => (globalThis as Any).__static?.flow.phase === "intro" || (globalThis as Any).__static?.flow.phase === "title", null, { timeout: 60_000 })
  check(true, `start over: reloaded into ${await phase()}`)
  await page.waitForTimeout(3000)
  await shot("startover")
  check((await G(page, "sessionStorage.getItem('afterhours.checkpoint')")) === null, "start over cleared the checkpoint")

  check(errors.length === 0, `no page errors (${errors.slice(0, 3).join(" | ")})`)
  const raw = await page.video()!.path()
  await ctx.close()
  renameSync(raw, `${out}/ambush-raw.webm`)
  // The first scare: from 1.5 s before the doors open to the death screen.
  const ss = Math.max(0, scareAt / 1000 - 0.5)
  Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-ss", ss.toFixed(2), "-i", `${out}/ambush-raw.webm`, "-t", "9", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", `${out}/ambush-scare.mp4`])
  console.log(`video: ${out}/ambush-scare.mp4 (from +${ss.toFixed(1)} s of ambush-raw.webm)`)
} catch (e) {
  console.log("FAIL", e)
  failures.push(String(e))
  await shot("error").catch(() => {})
  await ctx.close().catch(() => {})
}
await browser.close()
console.log(failures.length ? `${failures.length} failure(s)` : "all ok")
process.exit(failures.length ? 1 : 0)
