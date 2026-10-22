import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"

await using budget = browserBudget()
const { chromium } = budget

const game = resolve(import.meta.dir, "..")
const phase = process.env.LOOK_PHASE ?? "after"
// Optional Lab overrides for A/B experiments, e.g. LOOK_LAB='{"streetAirHaze":0}'.
const labOverrides: Record<string, number> = JSON.parse(process.env.LOOK_LAB ?? "{}")
const out = resolve(game, "../../captures/outbreak-look", phase)
mkdirSync(out, { recursive: true })
if (process.env.LOOK_SKIP_BUILD !== "1") assert.equal(Bun.spawnSync(["bun", "run", "build"], { cwd: game, stdout: "inherit", stderr: "inherit" }).exitCode, 0)
const root = resolve(game, "dist/arcade/outbreak")
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  const file = Bun.file(resolve(root, `.${path === "/" ? "/index.html" : path}`))
  return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 })
} })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse().map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(chrome)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 680 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${fixture.port}/?solo&seed=7&bench`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
  const adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  assert.match(adapter.architecture, /metal/)
  const scenes = [
    { name: "street", x: 30, y: 41, aim: -Math.PI / 2, hour: 18, zoom: 42 },
    { name: "closed", x: 27.7, y: 31, aim: -Math.PI / 2, hour: 19, zoom: 34 },
    { name: "open", x: 27.7, y: 31, aim: -Math.PI / 2, hour: 19, zoom: 34 },
    { name: "yard", x: 20, y: 35, aim: -1.6, hour: 23, zoom: 42 },
    { name: "day", x: 30, y: 41, aim: -Math.PI / 2, hour: 13, zoom: 42 },
    { name: "dusk", x: 30, y: 41, aim: -Math.PI / 2, hour: 17, zoom: 42 },
    { name: "night", x: 30, y: 41, aim: -Math.PI / 2, hour: 22, zoom: 42 },
  ]
  for (const scene of scenes) {
    await page.evaluate(async ({ s, labOverrides }) => {
      const h = (window as any).__arcadeHarness
      h.reset(7); h.setLab("timeScale", 0); h.setLab("hour", s.hour); h.setLab("zoom", s.zoom)
      for (const [key, value] of Object.entries(labOverrides)) h.setLab(key, value)
      // One short walk's memory around the house; identical staging in every capture.
      for (const [x,y,a] of [[30,41,-1.57],[20,35,-1.57],[20,26,0],[30,21,1.57],[38,32,3.14]]) {
        h.pose(x,y,a); await h.step()
      }
      h.pose(s.x,s.y,s.aim)
      if (s.name === "open") await h.step(1/60,{interact:true})
      for(let i=0;i<8;i++) await h.step()
    }, { s: scene, labOverrides })
    await page.screenshot({ path: resolve(out, `${scene.name}.png`) })
    await page.evaluate(() => {
      for (const el of document.querySelectorAll<HTMLElement>("#status, #hotbar, #stamina, #battery, #prompt, .callouts, .callout")) el.style.visibility = "hidden"
    })
    await page.locator("#game").screenshot({ path: resolve(out, `${scene.name}-canvas.png`) })
    await page.evaluate(() => {
      for (const el of document.querySelectorAll<HTMLElement>("#status, #hotbar, #stamina, #battery, #prompt, .callouts, .callout")) el.style.visibility = ""
    })
  }
  const state=await page.evaluate(()=>(window as any).__arcadeHarness.state())
  if(phase!=="before") {
    // Use real shared-Lab controls to regenerate without losing door state or teleporting.
    await page.keyboard.press("Backquote")
    const house=page.getByRole("slider",{name:"House seed",exact:true})
    await house.focus();await page.keyboard.type("12");await page.keyboard.press("Enter")
    const relief=page.getByRole("slider",{name:"Terrain relief",exact:true})
    await relief.focus();await page.keyboard.type("0.4");await page.keyboard.press("Enter")
    const regenerated=await page.evaluate(()=>(window as any).__arcadeHarness.state())
    assert.equal(regenerated.town.houseSeed,12);assert.equal(regenerated.town.terrain,.4)
    assert.deepEqual(regenerated.player,state.player)
    assert.deepEqual(regenerated.town.doors,state.town.doors)
    await page.keyboard.press("Backquote")
    // A second viewport catches cutaway assumptions tied to the original aspect ratio.
    await page.setViewportSize({width:720,height:900})
    await page.evaluate(async()=>{const h=(window as any).__arcadeHarness;h.setLab("houseSeed",7);h.setLab("terrain",.22);h.pose(30,41,-Math.PI/2);await h.step()})
    await page.screenshot({path:resolve(out,"portrait.png")})
  }
  assert.deepEqual(errors, [])
  await Bun.write(resolve(out, "proof.json"), JSON.stringify({ adapter, scenes, labOverrides, viewport: [1000,680], dpr:1, crop:[0,0,1000,680], vertices:state.vertices, generation:"real Lab sliders preserve player and doors",errors },null,2))
} finally { await browser.close(); fixture.stop(true) }
