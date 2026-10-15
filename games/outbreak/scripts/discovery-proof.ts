// Headless Metal proof for D-19 "Discovered, Not Told": state read from the world instead of labels. Stills of the
// low-battery beam against a full one, barricade boards at three wears, searched containers left open with what is
// inside, drops lying on the floor, and the belt hidden until the pack is held open.
// Run from games/outbreak: hivemind run --kind browser -- bun scripts/discovery-proof.ts
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright-core"
import { createServer } from "vite"

const root = resolve(import.meta.dir, "..")
const out = resolve(process.env.DISCOVERY_OUT ?? process.env.LEASE_OUT ?? resolve(root, "../../captures/outbreak-discovery"))
mkdirSync(out, { recursive: true })
const only = process.argv.slice(2)

const server = await createServer({ root, logLevel: "warn", server: { host: "127.0.0.1", port: 0 } })
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

const shots: { name: string; caption: string }[] = []

async function reset(page: Page, zoom = 26) {
  await page.evaluate(async (zoom) => {
    const h = (window as any).__arcadeHarness
    h.freeze(true)
    h.reset(7)
    h.setLab("timeScale", 0)
    h.setLab("zombieCount", 0)
    h.setLab("zoom", zoom)
    for (let i = 0; i < 3; i++) await h.step()
  }, zoom)
}

async function run(page: Page, js: string) {
  return page.evaluate((js) => new Function("h", js)((window as any).__arcadeHarness), js)
}

async function steps(page: Page, n: number, command: Record<string, unknown> = {}) {
  await page.evaluate(
    async ({ n, command }) => {
      const h = (window as any).__arcadeHarness
      for (let i = 0; i < n; i++) await h.step(1 / 60, command)
    },
    { n, command },
  )
}

async function snap(page: Page, name: string, caption: string) {
  await page.waitForTimeout(80)
  await page.screenshot({ path: resolve(out, `${name}.png`) })
  shots.push({ name, caption })
  console.log(`${name}: ${caption}`)
}

const want = (name: string) => !only.length || only.includes(name)

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5 })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text())
  })
  await page.goto(`http://127.0.0.1:${port}/?seed=7&peaceful=1`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 180_000 })
  const adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  assert.match(adapter.architecture, /metal/)

  if (only.includes("probe")) {
    await reset(page, 24)
    console.log(await run(page, `const v = h.session().view; const ash = v.town.buildings.find((b) => b.id === "ash"); return { ash, win: v.town.windows.filter((w) => w.buildingId === "ash").map((w) => [w.id, w.rect]), doors: v.town.doors.filter((d) => d.id.startsWith("ash")).map((d) => [d.id, d.rect]), mode: h.state().world, player: [v.player.x, v.player.y] }`))
  }

  if (want("beam")) {
    for (const [name, battery] of [["beam-full", 1], ["beam-low", 0.12]] as const) {
      await reset(page, 24)
      await run(page, `h.stageDiscovery("low-flashlight"); const p = h.session().view.player; p.battery = ${battery}`)
      await steps(page, 3, { flashlight: false })
      // Catch the sputtering beam between dropouts, so the still shows its narrowed, amber shape.
      for (let i = 0; i < 90 && (await run(page, `return h.session().view.player.flashlightOutput`)) < 0.4; i++) await steps(page, 1)
      console.log(name, await run(page, `const p = h.session().view.player; return { battery: p.battery, output: p.flashlightOutput, on: p.flashlightOn }`))
      await snap(page, name, battery === 1 ? "Full battery: a wide, cool-white beam" : "12% battery: the beam narrows, shortens and warms to amber, and sputters; no ring or 'Battery low'")
    }
  }

  if (want("barricade")) {
    for (const [name, wear] of [["barricade-fresh", 1], ["barricade-half", 0.5], ["barricade-failing", 0.22]] as const) {
      await reset(page, 24)
      await run(page, `h.stageDiscovery("weakened-barricade"); h.boardUp("ash-south-west", 3, ${wear})`)
      await steps(page, 3)
      const looks = await run(page, `return h.state().discovery.barricades["ash-south-west"]`)
      console.log(name, looks, await run(page, `const p = h.session().view.player; return [p.x, p.y]`))
      if (wear === 1) assert.deepEqual(looks, ["flush", "flush", "flush"])
      if (wear === 0.5) assert.deepEqual(looks, ["flush", "bowed", "hanging"])
      await snap(page, name, `Three boards at ${Math.round(wear * 100)}% wear: ${looks.join(", ")}`)
    }
  }

  if (want("containers")) {
    await reset(page, 24)
    await run(page, `h.stageDiscovery("open-containers")`)
    await steps(page, 3)
    const shown = await run(page, `return h.state().discovery.shown`)
    console.log("shown", shown)
    assert(Object.values(shown).some((v: any) => v.includes("medkit")), "the dresser shows its first aid kit")
    const prompt = await page.evaluate(() => document.querySelector("#prompt")?.textContent ?? "")
    assert(!/9mm ×|First Aid Kit|Take one/.test(prompt), `no contents list in the prompt: ${prompt}`)
    await snap(page, "containers", "Searched dresser left open: ammo, a first aid kit and scrap in the drawer; no list")
    await run(page, `const c = h.session().view.containers.find((c) => c.buildingId === "ash" && c.kind === "counter"); h.pose(c.x - 1.2, c.y + 0.6, 0)`)
    await steps(page, 3)
    await snap(page, "containers-kitchen", "Kitchen cabinet door swung open, what was inside on the worktop; the fridge door open beside it")
  }

  if (want("drops")) {
    await reset(page, 24)
    await run(page, `h.stageDiscovery("drops")`)
    await steps(page, 3)
    const markers = await page.evaluate(() => [...document.querySelectorAll("#markers .marker:not([hidden])")].map((m) => m.textContent))
    assert.deepEqual(markers, [], "drops are props, not labels")
    await snap(page, "drops", "Dropped supplies lie on the floor as props: no floating labels")
  }

  if (want("belt")) {
    await reset(page, 26)
    await run(page, `h.give("scrap", 3); h.give("chem", 2); h.pose(44, 44, 0)`)
    await steps(page, 3)
    const hidden = await page.evaluate(() => getComputedStyle(document.querySelector("#belt")!).opacity)
    await snap(page, "belt-hidden", "Walking around: no supply counters on screen")
    await page.keyboard.press("Tab")
    await steps(page, 2)
    await page.waitForTimeout(300)
    const shown = await page.evaluate(() => getComputedStyle(document.querySelector("#belt")!).opacity)
    console.log("belt opacity", hidden, "→", shown)
    assert.equal(hidden, "0")
    assert.equal(shown, "1")
    await snap(page, "belt-open", "Holding the pack open (Tab) shows the belt's counts")
  }

  if (want("bench")) {
    const hold = async () => {
      await steps(page, 1, { interact: true, interactHeld: true })
      await steps(page, 26, { interactHeld: true })
      await steps(page, 170)
    }
    const benchState = () => run(page, `return h.state().discovery.bench["bench:ash"]`)
    const promptText = () => page.evaluate(() => document.querySelector("#prompt")?.textContent ?? "")

    await reset(page, 26)
    await run(page, `h.stageDiscovery("bench-tinker")`)
    await steps(page, 90)
    const laid = await benchState()
    console.log("laid", laid, JSON.stringify(await promptText()))
    assert.deepEqual([...laid.mat].sort(), ["plank", "scrap"])
    assert(!/Research|Bandage|Spiked|Recipe|Tier/i.test(await promptText()), "no recipe words at the bench")
    await snap(page, "bench-pair", "At the bench the camera leans in: plank and scrap laid on the felt mat, an empty corkboard behind. Hold E to try them")

    await hold()
    const made = await benchState()
    console.log("made", made)
    assert.deepEqual(made.mat, ["spiked-board"])
    assert.deepEqual(made.sketches, ["spiked-board"])
    await snap(page, "bench-assembled", "They make a spiked board: it lies on the mat, and a pencil sketch (plank + scrap → spiked board) is pinned in the player's colour")

    await steps(page, 1, { interact: true })
    await run(page, `const v = h.session().view; v.progression.ledger.apply({ kind: "deposit", actor: v.actorId, to: "mat:ash", items: { scrap: 1, chem: 1 } }); v.progression.ledger.apply({ kind: "grant", actor: v.actorId, item: "plank", count: 2 })`)
    await steps(page, 2)
    await hold()
    const tier2 = await benchState()
    console.log("idea", tier2)
    assert.deepEqual(tier2.ideas, ["battery"])
    await run(page, `const v = h.session().view; v.progression.ledger.apply({ kind: "take", actor: v.actorId, from: "mat:ash" }); v.progression.ledger.apply({ kind: "deposit", actor: v.actorId, to: "mat:ash", items: { plank: 2 } })`)
    await steps(page, 2)
    await hold()
    const tried = await benchState()
    console.log("tried", tried)
    assert.deepEqual(tried.tried, ["plank+plank"])
    await snap(page, "bench-tried", "Scrap + chem needs the toolbox: a faint idea with a red toolbox goes up. Plank + plank clatters and a crossed-out scrap is pinned at the foot")

    await reset(page, 26)
    await run(page, `h.stageDiscovery("corkboard")`)
    await steps(page, 90)
    console.log("corkboard", await benchState())
    await snap(page, "corkboard", "Days in: three sketches pinned in three players' colours, an idea waiting on the toolbox, two crossed-out tries")

    await reset(page, 26)
    await run(page, `h.stageDiscovery("dark-bench")`)
    await steps(page, 60)
    await hold()
    const notices = await run(page, `return h.session().view.progression.learned("bandage")`)
    assert.equal(notices, false, "too dark to try at night without a light")
    await snap(page, "bench-dark", "Night, flashlight off: the mat is barely visible and the try is refused")
    await run(page, `h.session().view.player.flashlightOn = true`)
    await steps(page, 20, { flashlight: false })
    await hold()
    assert.equal(await run(page, `return h.session().view.progression.learned("bandage")`), true)
    await snap(page, "bench-dark-lit", "The flashlight on the mat is light enough: chem + chem makes a bandage")

    await reset(page, 26)
    await run(page, `h.stageProgression("field-craft")`)
    await steps(page, 6)
    const craft = await page.evaluate(() => document.querySelector("#craft")?.textContent ?? "")
    console.log("craft text", JSON.stringify(craft))
    assert(!/Bandage|Noisemaker|Spiked|Battery|Heals|Field craft/i.test(craft), `field craft has no words: ${craft}`)
    await snap(page, "field-craft", "Hold Q: what each learned recipe makes and what it takes, drawn in pencil; no names")
  }

  if (want("found")) {
    const state = () => run(page, `return h.state().discovery`)
    await reset(page, 26)
    await run(page, `h.stageDiscovery("page")`)
    await steps(page, 90)
    const before = await state()
    console.log("page", before.pages, before.shown, JSON.stringify(await page.evaluate(() => document.querySelector("#prompt")?.textContent ?? "")))
    assert.equal(before.pages.find((p: any) => p.buildingId === "hardware").unread, 1)
    assert.deepEqual(before.shown["page:hardware"], ["flyer:reinforced"])
    await snap(page, "page-flyer", "A printed flyer lies on a hardware-store shelf; walking up to it, the camera leans in")
    await steps(page, 1, { interact: true })
    await steps(page, 20)
    const read = await state()
    console.log("read", read.glance, read.bench["bench:ash"])
    assert.equal(read.glance, "flyer:reinforced")
    assert.equal(await run(page, `return h.session().view.progression.learned("reinforced")`), true)
    await snap(page, "page-glance", "E reads it: the flyer is held up for two seconds (scrap + scrap → reinforced boards), no words; the shelf is bare")
    await steps(page, 150)
    assert.equal((await state()).glance, null)

    await reset(page, 26)
    await run(page, `h.stageDiscovery("page-read")`)
    await steps(page, 30)
    await snap(page, "page-chart", "The pharmacy's page is a chart: each material boxed, what they make circled, a red cross in the corner")

    await reset(page, 26)
    await run(page, `h.stageDiscovery("found-pages")`)
    await steps(page, 90)
    const board = (await state()).bench["bench:ash"]
    console.log("found pages", board)
    assert.deepEqual([...board.found].sort(), ["chart:bandage", "flyer:reinforced", "photo:lure"])
    await snap(page, "found-pages", "The corkboard days in: a pencil sketch made at the bench beside a flyer, a chart and a photo found in town, each on its finder's pin")

    await reset(page, 24)
    await run(page, `h.stageDiscovery("held-out")`)
    // Let the camera settle with a long study time, then look for real.
    await run(page, `h.setLab("studyTime", 6)`)
    await steps(page, 90)
    const held = await state()
    console.log("held out", held.reinforced, held.barricades["hardware-south-east"])
    assert(held.reinforced.includes("hardware-south-east"), "the held-out window shows its straps")
    await snap(page, "held-out", "The hardware store's south-east window, boarded from inside before the game began, steel straps bolted across the boards")
    await run(page, `h.setLab("studyTime", 1.5)`)
    await steps(page, 110)
    assert.equal(await run(page, `return h.session().view.progression.learned("reinforced")`), true, "standing and looking teaches it")
  }

  assert.deepEqual(errors, [])
  writeFileSync(resolve(out, "index.json"), JSON.stringify({ adapter, shots }, null, 2))
} finally {
  await browser.close()
  await server.close()
}
