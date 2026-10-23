/** One warm, muted Metal session: vertex vs textured furniture inside Outbreak in each look mode, at game exposure.
 * hivemind run --kind browser --worker mini --fetch captures/textured-props -- bun scripts/props/textured-proof.ts
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { createServer } from "vite"
import { browserBudget } from "../browser-budget"

const out = resolve("captures/textured-props")
rmSync(out, { recursive: true, force: true })
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
await outbreak.listen()
const port = (outbreak.httpServer!.address() as { port: number }).port
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(executablePath)
await using budget = browserBudget()
const browser = await budget.chromium.launch({ executablePath, headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const errors: string[] = []
// One preset per look variant: noir (the game's default), painterly and generic. Outbreak keeps the look pipes on
// even for "current" (measured Oct 23), so it draws generic too; the plain variant is covered by the WGSL tests.
const LOOKS = [["current", "generic"], ["noir", "noir"], ["painterly", "painterly"], ["cinematic_dusk", "generic"]] as const
const report: Record<string, unknown> = { placement: "Production kitchen counter; TV and phone staged alongside it", looks: {} }
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.addInitScript(() => {
    const request = GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice = function (desc: GPUDeviceDescriptor = {}) {
      return request.call(this, { ...desc, requiredFeatures: [...(desc.requiredFeatures ?? []), "timestamp-query"] })
    }
  })
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${port}/arcade/outbreak/?solo&seed=7&bench&peaceful=1`, { timeout: 90000 })
  // A cold Vite dependency optimisation reloads the page once; settle before driving it.
  for (let settled = 0; settled < 2;) {
    await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 90000 })
    await page.waitForTimeout(3000)
    settled = await page.evaluate(() => Boolean((window as any).__arcadeHarness?.ready)).catch(() => false) ? settled + 1 : 0
  }
  errors.length = 0 // errors from the load the reload replaced
  await page.addStyleTag({ content: "#status,#hotbar,#stamina,#battery,.callouts,.callout,#hud,.hud,#markers,#prompt,#sound-cues {visibility:hidden!important}" })
  await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    h.freeze(true); h.reset(7); h.setQuality("high"); h.setLab("timeScale", 0)
    h.setLab("hour", 21); h.setLab("propsOn", true); h.setLab("propTextures", true)
    h.setZoomRaw(18); h.pose(33.2, 32.6, -Math.PI / 2)
    for (let i = 0; i < 400; i++) {
      Object.assign(h.state().player, { x: 33.2, y: 32.6, aim: -Math.PI / 2, flashlightOn: true, flashlightOutput: 1 })
      await h.step(1 / 60, { mx: 0, my: 0, aim: -Math.PI / 2 })
      const props = h.state().props
      if (props?.textured?.failed.length) throw new Error(JSON.stringify(props.textured))
      if (i > 90 && props?.textured?.loaded.length === 3 && props?.ready && (h.interiors?.()?.settled ?? true)) return
      await new Promise(r => setTimeout(r, 25))
    }
    throw new Error("Textured props did not finish loading")
  })
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!
  for (const [preset, expected] of LOOKS) {
    const times: number[][] = [[], []]
    const entry: Record<string, unknown> = {}
    // ABBA per look; the first of each side is the still.
    for (const textures of [false, true, true, false]) {
      const result = await page.evaluate(async ({ preset, textures }) => {
        const h = (window as any).__arcadeHarness
        h.setLookPreset(preset)
        h.setLab("propTextures", textures)
        // Hold the exact sim time and camera on both sides of the pair.
        h.pose(33.2, 32.6, -Math.PI / 2)
        for (let i = 0; i < 12; i++) await h.step(0, { mx: 0, my: 0, aim: -Math.PI / 2 })
        const samples = []
        for (let i = 0; i < 6; i++) samples.push(await h.bounceMeasure())
        return { samples, variant: h.renderer.passContext.sceneVariant?.() ?? "plain", props: h.state().props }
      }, { preset, textures })
      if (result.variant !== expected) errors.push(`${preset} drew the ${result.variant} scene variant, not ${expected}`)
      times[Number(textures)]!.push(...result.samples.slice(2))
      const file = `${preset}-${textures ? "textured" : "vertex"}.png`
      if (!existsSync(resolve(out, file))) await page.screenshot({ path: resolve(out, file) })
      entry[textures ? "textured" : "vertex"] = result.props
    }
    entry.expectedVariant = expected
    entry.gpu = { vertexMs: median(times[0]!), texturedMs: median(times[1]!), deltaMs: median(times[1]!) - median(times[0]!), samples: times }
    ;(report.looks as Record<string, unknown>)[preset] = entry
  }
  report.gpuNote = "Rough ABBA whole-frame GPU cost per look, 1280×900 Metal; includes changed geometry and materials"
  await page.close()
  assert.deepEqual(errors, [])
} finally {
  report.errors = errors
  writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2))
  await browser.close()
  await outbreak.close()
}
