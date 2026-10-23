/** One warm, muted Metal session: three props inside Outbreak, then the camp cooler in BARBARA.
 * hivemind run --kind browser --worker mini --fetch captures/textured-props -- bun scripts/props/textured-proof.ts
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { createServer } from "vite"
import { browserBudget } from "../browser-budget"

const out = resolve("captures/textured-props")
mkdirSync(out, { recursive: true })
const root = resolve(import.meta.dir, "../..")
const outbreak = await createServer({ root: resolve(root, "games/outbreak"), logLevel: "error", server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "textured-proof-placement", enforce: "pre", transform(code, id) {
    if (!id.endsWith("/src/props/dressing.ts")) return
    // Stage two catalogue props beside the existing counter. This changes placements only, not shaders or exposure.
    return code.replace("this.instances = houses.flatMap(instancesOf)", `this.instances = houses.flatMap(instancesOf)
      this.instances.push({id:"tv-set",x:34.1,y:0,z:33,yaw:0,scale:1}, {id:"rotary-phone",x:36.2,y:1.06,z:33.7,yaw:0,scale:1})`)
  } }],
})
const barbara = await createServer({ root: resolve(root, "games/barbara"), logLevel: "error", server: { host: "127.0.0.1", port: 0 } })
await outbreak.listen()
await barbara.listen()
const port = (server: typeof outbreak) => (server.httpServer!.address() as { port: number }).port
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(executablePath)
await using budget = browserBudget()
const browser = await budget.chromium.launch({ executablePath, headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const errors: string[] = []
const report: Record<string, unknown> = { placement: "Production kitchen counter; TV and phone staged alongside it", images: [] }
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${port(outbreak)}/arcade/outbreak/?solo&seed=7&bench&peaceful=1`, { timeout: 90000 })
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 90000 })
  await page.addStyleTag({ content: "#status,#hotbar,#stamina,#battery,.callouts,.callout,#hud,.hud,#markers,#prompt,#sound-cues {visibility:hidden!important}" })
  await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    h.freeze(true); h.reset(7); h.setQuality("high"); h.setLab("timeScale", 0)
    h.setLab("hour", 21); h.setLab("propsOn", true); h.setLab("propTextures", true)
    h.setZoomRaw(12); h.pose(34, 35, -Math.PI / 2)
    for (let i = 0; i < 400; i++) {
      Object.assign(h.state().player, { x: 34, y: 35, aim: -Math.PI / 2, flashlightOn: true, flashlightOutput: 1 })
      await h.step(1 / 60, { mx: 0, my: 0, aim: -Math.PI / 2 })
      const props = h.state().props
      if (props?.textured?.failed.length) throw new Error(JSON.stringify(props.textured))
      if (props?.textured?.loaded.length === 3 && props?.ready && (h.interiors?.()?.settled ?? true)) return
      await new Promise(r => setTimeout(r, 25))
    }
    throw new Error("Textured props did not finish loading")
  })
  const times: number[][] = [[], []]
  for (const textures of [false, true, true, false]) {
    const result = await page.evaluate(async textures => {
      const h = (window as any).__arcadeHarness
      h.setLab("propTextures", textures)
      for (let i = 0; i < 30; i++) await h.step(1 / 60, { mx: 0, my: 0, aim: -Math.PI / 2 })
      const samples = []
      for (let i = 0; i < 10; i++) samples.push(await h.bounceMeasure())
      return { samples, props: h.state().props }
    }, textures)
    times[Number(textures)]!.push(...result.samples.slice(2))
    const file = textures ? "outbreak-textured.png" : "outbreak-vertex.png"
    if (!existsSync(resolve(out, file))) await page.screenshot({ path: resolve(out, file) })
    report[textures ? "textured" : "vertex"] = result.props
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!
  report.gpu = { vertexMs: median(times[0]!), texturedMs: median(times[1]!), deltaMs: median(times[1]!) - median(times[0]!), samples: times,
    note: "Rough ABBA whole-frame GPU cost, 1280×900 Metal; includes changed geometry and materials" }
  await page.close()

  const camp = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  camp.on("pageerror", e => errors.push(e.message))
  camp.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  await camp.goto(`http://127.0.0.1:${port(barbara)}/arcade/barbara/?solo&bench&quality=high&people=blocky`, { timeout: 90000 })
  await camp.waitForFunction(() => (window as any).woods?.view, null, { timeout: 90000 })
  report.camp = await camp.evaluate(() => {
    const w = (window as any).woods
    w.paused = true
    const table = w.world.buildings.find((b: any) => b.kind === "table")
    const x = table.rect[2] + 0.55, z = (table.rect[1] + table.rect[3]) / 2
    w.setPose(x, z + 2.1, 0, -0.6)
    w.camera.flashlight = true
    for (let i = 0; i < 90; i++) w.step(1000 / 60)
    return { x, z, exposure: w.view.forest.camera?.exposure }
  })
  await camp.screenshot({ path: resolve(out, "barbara-cooler.png") })
  assert.deepEqual(errors, [])
} finally {
  report.errors = errors
  writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2))
  await browser.close()
  await Promise.all([outbreak.close(), barbara.close()])
}
