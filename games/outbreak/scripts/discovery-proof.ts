// Headless Metal proof for D-19 "Discovered, Not Told": state read from the world instead of labels. Stills of the
// low-battery beam against a full one, barricade boards at three wears, searched containers left open with what is
// inside, drops lying on the floor, the dock dimmed until the pack is held open, the workbench
// and corkboard, found pages, and the slice-4 verbs (crouch, tripwires, closet, peephole, bottle, car alarm, repair).
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
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
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
    // The dock never hides (Kit, AR-24): it settles dim when idle and brightens while the pack is open.
    await page.waitForTimeout(4500)
    await steps(page, 1)
    await page.waitForTimeout(1200)
    const hidden = await page.evaluate(() => getComputedStyle(document.querySelector("#dock")!).opacity)
    await snap(page, "belt-hidden", "Walking around: the supply belt sits dim")
    await page.keyboard.press("Tab")
    await steps(page, 2)
    await page.waitForTimeout(300)
    const shown = await page.evaluate(() => getComputedStyle(document.querySelector("#dock")!).opacity)
    console.log("dock opacity", hidden, "→", shown)
    assert(Math.abs(Number(hidden) - 0.5) < 0.02, `idle dock opacity ${hidden}`)
    assert(Number(shown) > 0.95, `open dock opacity ${shown}`)
    await snap(page, "belt-open", "Holding the pack open (Tab) shows the belt's counts")
  }

  if (want("bench")) {
    const benchState = () => run(page, `return h.state().discovery.bench["bench:ash"]`)
    const promptText = () => page.evaluate(() => document.querySelector("#prompt")?.textContent ?? "")
    const craftText = () => page.evaluate(() => document.querySelector("#craft")?.textContent ?? "")
    const make = async (recipe: string) => {
      const index = await run(page, `return h.session().view.progression.craftable().findIndex((r) => r.id === ${JSON.stringify(recipe)})`)
      await steps(page, 1, { pick: { mode: "craft", index } })
      await steps(page, 150)
    }

    await reset(page, 26)
    await run(page, `h.stageDiscovery("bench-board")`)
    await steps(page, 90)
    const board = await benchState()
    console.log("board", board, JSON.stringify(await promptText()), JSON.stringify(await craftText()))
    assert.deepEqual(board.sketches, ["bandage", "spiked-board"])
    assert.deepEqual(board.ideas, ["reinforced", "battery"])
    assert.match(await craftText(), /Spiked Board/)
    await snap(page, "bench-board", "At the bench the camera leans in: chem and scrap picked up fill in two sketches, with faint ideas waiting on the toolbox and the generator; E opened the board")

    await reset(page, 26)
    await run(page, `h.stageDiscovery("corkboard")`)
    await steps(page, 90)
    console.log("corkboard", await benchState())
    await snap(page, "corkboard", "Days in: three sketches pinned in three players' colours, and ideas waiting on the toolbox and the generator")

    await reset(page, 26)
    await run(page, `h.stageDiscovery("dark-bench")`)
    await steps(page, 60)
    await make("spiked-board")
    assert.equal(await run(page, `const v = h.session().view; return v.progression.ledger.count(v.actorId, "spiked-board")`), 0, "too dark to make it at night without a light")
    await snap(page, "bench-dark", "Night, flashlight off: the bench is barely visible and making a spiked board is refused")
    await run(page, `h.session().view.player.flashlightOn = true`)
    await steps(page, 20, { flashlight: false })
    await make("spiked-board")
    assert.equal(await run(page, `const v = h.session().view; return v.progression.ledger.count(v.actorId, "spiked-board")`), 1)
    await snap(page, "bench-dark-lit", "The flashlight on the bench is light enough: the spiked board gets made")

    await reset(page, 26)
    await run(page, `h.stageProgression("field-craft")`)
    await steps(page, 6)
    const craft = await craftText()
    console.log("craft text", JSON.stringify(craft))
    assert.match(craft, /Bandage/)
    await snap(page, "field-craft", "C: the recipe panel, every learned recipe with what it takes and have/need")
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
    await snap(page, "held-out", "A held-out window (streamed warehouses start with one; staged here on the hardware store): boarded from inside, steel straps bolted across the boards")
    await run(page, `h.setLab("studyTime", 1.5)`)
    await steps(page, 110)
    assert.equal(await run(page, `return h.session().view.progression.learned("reinforced")`), true, "standing and looking teaches it")
  }

  if (want("verbs")) {
    const verbs = () => run(page, `return h.state().discovery.verbs`)
    const learned = (r: string) => run(page, `return h.session().view.progression.learned("${r}")`)

    await reset(page, 24)
    await run(page, `h.stageDiscovery("crouch")`)
    await steps(page, 30)
    assert.deepEqual((await verbs()).lines, ["pharmacy-front"])
    // Snap mid-step, just over the line on the pharmacy's step.
    for (let i = 0; i < 80 && (await run(page, `return h.session().view.player.y`)) > 68.5; i++) await steps(page, 4, { my: -1, crouch: true })
    const low = await verbs()
    console.log("crouch", low, await run(page, `const p = h.session().view.player; return [p.x, p.y, p.noise]`))
    assert.equal(low.crouching, true)
    await snap(page, "crouch", "Ctrl held: the survivor drops into a crouch, slower and quieter, and steps over the cans strung across the pharmacy's step")
    await steps(page, 90, { my: -1, crouch: true })
    assert.deepEqual((await verbs()).lines, ["pharmacy-front"], "crouching steps over the line")

    await reset(page, 24)
    await run(page, `h.stageDiscovery("crouch")`)
    await steps(page, 75, { my: -1 })
    const sprung = await verbs()
    console.log("sprung", sprung)
    assert.deepEqual(sprung.sprung, ["pharmacy-front"])
    await snap(page, "tripwire-sprung", "Walking through upright springs them: the cans clatter across the step and every zombie in earshot hears it")

    await reset(page, 24)
    await run(page, `h.stageDiscovery("tripwire")`)
    await steps(page, 60)
    console.log("tripwire prompt", JSON.stringify(await page.evaluate(() => document.querySelector("#prompt")?.textContent ?? "")))
    await snap(page, "tripwire", "Cans strung across the pharmacy's front step at shin height, there to be seen by anyone who looks; E works them loose")
    await steps(page, 1, { interact: true })
    await steps(page, 130)
    assert.equal(await learned("tripwire"), true, "disarming teaches the tripwire")
    assert.deepEqual((await verbs()).lines, [])

    await reset(page, 24)
    await run(page, `h.stageDiscovery("closet")`)
    await steps(page, 40)
    assert.equal((await verbs()).hidden, true)
    await snap(page, "closet", "Hidden in the bedroom closet at night: the room through the louvres, the survivor out of sight; E steps out")

    await reset(page, 24)
    await run(page, `h.stageDiscovery("peephole")`)
    await steps(page, 50)
    const peek = await run(page, `return h.session().view.peek`)
    console.log("peek", peek)
    assert.equal(peek?.windowId, "ash-front")
    await snap(page, "peephole", "Shift+E at the shut front door: the view leans out through the peephole onto the porch and street")

    await reset(page, 24)
    await run(page, `h.stageDiscovery("bottle")`)
    await steps(page, 20)
    await snap(page, "bottle-held", "Bottles in hand on the street, a car down the road")
    // Vignettes leave glass of their own nearby; count the bottle's.
    const glassBefore = (await verbs()).glass
    await steps(page, 1, { fire: true })
    await steps(page, 20)
    for (let i = 0; i < 40 && !(await verbs()).flashing.length; i++) await steps(page, 2)
    const thrown = await verbs()
    console.log("bottle", thrown)
    assert.equal(thrown.glass, glassBefore + 1)
    assert.equal(thrown.flashing.length + (await run(page, `return h.session().view.progression.ledger.store("car:55.4,41.4")?.counts.alarm ?? 0`)) > 0, true, "the bottle sets the alarm off")
    await snap(page, "bottle", "One thrown: it breaks beside the car, glass on the road, and the car's alarm goes off (indicators flashing)")

    await reset(page, 24)
    await run(page, `h.stageDiscovery("car-alarm")`)
    for (let i = 0; i < 40 && !(await verbs()).flashing.length; i++) await steps(page, 2)
    const alarm = await verbs()
    console.log("alarm", alarm)
    assert.equal(alarm.smashed.length, 1)
    assert.equal(alarm.flashing.length, 1)
    await snap(page, "car-alarm", "A car with its window put in and its alarm wailing: indicators flashing, glass on the road")

    await reset(page, 24)
    await run(page, `h.stageDiscovery("repair")`)
    await steps(page, 40)
    const hp = () => run(page, `return h.session().ai.portalStates.get("ash-south-west").barricadeHp`)
    const worn = await hp()
    await snap(page, "repair-before", `A worn barricade (${Math.round(worn)} of 200), a crowbar in hand`)
    await steps(page, 1, { barricade: true })
    await steps(page, 120)
    const fixed = await hp()
    console.log("repair", worn, "→", fixed)
    assert.equal(fixed, 200)
    await snap(page, "repair-after", "B with the crowbar re-nails the boards to full instead of adding one: flush again")
  }

  if (want("vignettes")) {
    const drawn = () => run(page, `return h.state().discovery.vignettes`)
    const staged: [string, string, string][] = [
      ["broken-in", "vignette:broken-in:ash", "A house broken into through its side window: glass on the floor, a survivor down with a snapped bat (it left a scrap), the zombie that came through"],
      ["hid", "vignette:hid:elm", "The dead in front of a bedroom closet, spent casings at its door, a battery left behind: somebody hid in there and lived"],
      ["lured", "vignette:lured:pharmacy", "Bottles broken in a line away from the pharmacy door, the dead bunched at the last one, one bottle left unthrown"],
      ["spent-alarm", "vignette:alarm-car:55.4,41.4", "A car that wailed until its battery died, its window in and the dead it called piled round it"],
    ]
    for (const [scene, id, caption] of staged) {
      await reset(page, 24)
      await run(page, `h.stageDiscovery("${scene}")`)
      await steps(page, 40)
      const v = await drawn()
      console.log(scene, v)
      assert(v.scenes.includes(id), `${id} is drawn`)
      assert(v.bodies >= 2, "with its bodies")
      await snap(page, `vignette-${scene}`, caption)
    }

    // Walking over the broken-in glass upright crunches it.
    await reset(page, 24)
    await run(page, `h.stageDiscovery("broken-in")`)
    const glass = await run(page, `return h.session().view.progression.ledger.store("glass:v:broken-in:ash:0").at`)
    await run(page, `h.pose(${glass.x - 1.6}, ${glass.y}, 0)`)
    await steps(page, 50, { mx: 1 })
    const crunched = await run(page, `return h.session().view.progression.ledger.store("glass:v:broken-in:ash:0").counts.steps ?? 0`)
    console.log("crunched", crunched)
    assert(crunched > 0, "glass underfoot crunches")
  }

  assert.deepEqual(errors, [])
  writeFileSync(resolve(out, "index.json"), JSON.stringify({ adapter, shots }, null, 2))
} finally {
  await browser.close()
  await server.close()
}
