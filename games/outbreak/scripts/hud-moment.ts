// Records a short scripted Outbreak moment for the HUD prototype (door hold, search, firing dry, reload, a zombie hit,
// sprint to exhaustion): real headless Metal frames with every HUD element
// hidden, plus a per-frame timeline of what the HUD needs (the survivor's screen box, its state, the callouts the game
// emitted, the interaction prompt, the hotbar and the summary). The prototype replays the timeline through the game's
// own HUD code over the frames. No visible window, no audio.
//
//   bun scripts/hud-moment.ts            # frames + timeline.json in captures/outbreak-hud-moment
//   then ffmpeg -framerate 30 -i frames/%04d.jpg … moment.mp4 (see the end of this file's output)
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright-core"
import { createServer } from "vite"

const root = resolve(import.meta.dir, "..")
const out = resolve(process.env.MOMENT_OUT ?? resolve(root, "../../captures/outbreak-hud-moment"))
rmSync(out, { recursive: true, force: true })
mkdirSync(resolve(out, "frames"), { recursive: true })
const FPS = 30
const STEPS_PER_FRAME = 60 / FPS

const server = await createServer({
  root,
  logLevel: "warn",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "hud-moment-hooks",
      enforce: "pre",
      transform(code, id) {
        if (id !== resolve(root, "src/main.ts")) return
        return code.replace("const harness = {", "const harness = { hud, renderer, session: () => session,")
      },
    },
  ],
})
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)
  .find(existsSync)
assert(chrome, "Playwright Chromium binary not found")
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

type Frame = Record<string, unknown>
const frames: Frame[] = []
const shots: { at: number; label: string }[] = []

async function stage(page: Page, s: { x: number; y: number; aim: number }) {
  await page.evaluate(async (s) => {
    const h = (window as any).__arcadeHarness
    h.freeze(true)
    h.reset(7)
    h.setLab("timeScale", 0)
    h.setLab("hour", 21)
    h.setLab("zoom", 34)
    h.setLab("zombieCount", 0)
    h.pose(s.x, s.y, s.aim)
    for (let i = 0; i < 4; i++) await h.step()
  }, s)
}

/** Steps the sim one frame's worth and records it; the screenshot is taken after. */
async function frame(page: Page, command: Record<string, unknown> = {}, held = false) {
  const f = await page.evaluate(
    async ({ command, n, held }) => {
      const h = (window as any).__arcadeHarness
      const w = window as any
      for (let i = 0; i < n; i++) {
        const p = h.state().player
        await h.step(1 / 60, { aim: p.aim, ...command })
        if (i === 0) for (const k of ["reload", "interact", "fire", "barricade", "flashlight"]) if (!(held && k === "interact")) delete command[k]
      }
      const st = h.state()
      const p = st.player
      const prompt = document.querySelector<HTMLElement>("#prompt")!
      const emits = w.__emits.splice(0)
      return {
        time: st.time,
        box: h.hud.localBox(),
        player: {
          health: p.health,
          maxHealth: p.maxHealth,
          stamina: p.stamina,
          sprinting: p.sprinting,
          exhausted: p.exhausted,
          reloadRemaining: p.reloadRemaining,
          equippedItem: p.equippedItem,
          magAmmo: p.magAmmo,
          reserveAmmo: p.reserveAmmo,
          flashlightOn: p.flashlightOn,
          battery: p.battery,
          batteryDepleted: p.batteryDepleted,
          flashlightOutput: p.flashlightOutput,
        },
        slot: st.inventory.selectedSlot,
        emits,
        prompt: prompt.hidden ? null : { html: prompt.innerHTML, transform: prompt.style.transform },
        hotbar: document.querySelector("#hotbar")!.innerHTML,
        belt: document.querySelector("#belt")?.innerHTML ?? "",
        pack: document.querySelector("#pack")?.innerHTML ?? "",
        status: document.querySelector("#status")!.textContent,
      }
    },
    { command, n: STEPS_PER_FRAME, held },
  )
  const index = frames.length
  await page.screenshot({ path: resolve(out, "frames", `${String(index).padStart(4, "0")}.jpg`), type: "jpeg", quality: 82 })
  frames.push(f)
  return f
}

const seconds = (s: number) => Math.round(s * FPS)

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
  await page.goto(`http://127.0.0.1:${port}/?seed=7&bench`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 120_000 })
  // Hide every HUD element; the prototype draws them. Record what the game's feedback emits instead.
  await page.addStyleTag({ content: ".callouts,.vitals,.status-icons,#hud,#prompt,#coop,.coop-tag{visibility:hidden!important}" })
  await page.evaluate(() => {
    const h = (window as any).__arcadeHarness
    const w = window as any
    w.__emits = []
    const core = h.hud.core
    const orig = core.callout.bind(core)
    core.callout = (actor: string, text: string, kind: string, options?: unknown) => {
      if (actor === "local") w.__emits.push({ text, kind, options: options ?? null })
      return orig(actor, text, kind, options)
    }
  })

  // Shot 1, the front door: tap E is Open, holding E fills the hold ring and locks it.
  await stage(page, { x: 27.7, y: 37.1, aim: -Math.PI / 2 })
  shots.push({ at: 0, label: "Door" })
  for (let i = 0; i < seconds(0.25); i++) await frame(page, { my: -1 })
  for (let i = 0; i < seconds(0.6); i++) await frame(page)
  for (let i = 0; i < seconds(0.6); i++) await frame(page, { interact: true }, true)
  for (let i = 0; i < seconds(1.2); i++) await frame(page)

  // Shot 2, interior: walk to the supply shelf and search it.
  const c = await page.evaluate(() => {
    const st = (window as any).__arcadeHarness.state()
    const c = st.containers.find((x: any) => x.ammo > 0 && x.planks > 0) ?? st.containers.find((x: any) => x.ammo > 0)
    return { x: c.x, y: c.y }
  })
  await stage(page, { x: c.x, y: c.y + 1.9, aim: -Math.PI / 2 })
  shots.push({ at: frames.length, label: "Search" })
  for (let i = 0; i < seconds(0.6); i++) await frame(page)
  for (let i = 0; i < seconds(0.45); i++) await frame(page, { my: -1 })
  await frame(page, { interact: true })
  for (let i = 0; i < seconds(2.4); i++) await frame(page)

  // Shot 3, street: walk while firing the magazine dry into the yard ("Empty, R to reload"), reload, take a zombie
  // hit, sprint to exhaustion.
  await stage(page, { x: 23.5, y: 41, aim: -1.2 })
  shots.push({ at: frames.length, label: "Street" })
  await page.evaluate(() => (window as any).__arcadeHarness.spawnZombie(36, 41.1, "chase", Math.PI))
  for (let i = 0; i < seconds(2.4); i++) {
    const f = (await frame(page, { mx: 1, aim: -1.2, fire: i % 5 === 0 })) as any
    if (f.player.magAmmo === 0) break
  }
  for (let i = 0; i < seconds(0.7); i++) await frame(page, { mx: 1, aim: -0.6 })
  await frame(page, { mx: 1, aim: 0, reload: true })
  for (let i = 0; i < seconds(1.3); i++) await frame(page, { mx: 0.6, aim: 0 })
  let hurt = false
  for (let i = 0; i < seconds(3) && !hurt; i++) hurt = ((await frame(page, { aim: 0 })) as any).player.health < 100
  assert(hurt, "the zombie did not land a hit")
  for (let i = 0; i < seconds(0.35); i++) await frame(page, { aim: 0 })
  await page.evaluate(() => Object.assign((window as any).__arcadeHarness.state().player, { stamina: 0.42 }))
  let exhausted = false
  for (let i = 0; i < seconds(3) && !exhausted; i++) exhausted = ((await frame(page, { mx: -1, sprint: true, aim: Math.PI })) as any).player.exhausted
  assert(exhausted, "sprint did not exhaust")
  for (let i = 0; i < seconds(1.6); i++) await frame(page, { mx: -1, aim: Math.PI })
  for (let i = 0; i < seconds(0.8); i++) await frame(page, { aim: Math.PI })

  assert.deepEqual(errors, [])
  const all = frames.flatMap((f: any) => f.emits.map((e: any) => e.text))
  assert(all.includes("Door locked"), "the hold did not lock the door")
  assert(all.includes("Empty, R to reload"), "no QWERTY reload hint")
  const emitted = frames.flatMap((f: any) => f.emits.map((e: any) => e.text))
  writeFileSync(resolve(out, "timeline.json"), JSON.stringify({ fps: FPS, width: 1280, height: 800, shots, frames }))
  console.log(`${frames.length} frames (${(frames.length / FPS).toFixed(1)} s); callouts: ${[...new Set(emitted)].join(", ")}`)
} finally {
  await browser.close()
  await server.close()
}
