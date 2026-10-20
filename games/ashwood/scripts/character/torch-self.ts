// The flashlight must never light its own visible body (the first-person viewmodel): every frame, right before the
// frame renders, each viewmodel flashlight vertex is tested against the torch spotlight's cone and range. Its spot
// factor is smoothstep(cos outer, cos inner, cos θ), so a vertex outside the cone gets exactly 0; any vertex inside
// counts as lit. Standing, walking, running, sprinting (+ spins), crouching, pitch 0..−80°. Saves a mid-sprint strip.
//
//   bun scripts/character/torch-self.ts [--char remy] [--tag t]
//
// One browser, 960×600. Output: per-scenario lit-vertex counts and the worst cos margin; captures/character/self-<tag>.png.
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync } from "node:fs"

const args = process.argv.slice(2)
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args.splice(i, 2)[1]! : undefined
}
const char = flag("char") ?? "remy"
const tag = flag("tag") ?? "run"
const out = `${import.meta.dir}/../../captures/character`
mkdirSync(`${out}/self`, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
const page = await (await browser.newContext({ viewport: { width: 960, height: 600 } })).newPage()
const errors: string[] = []
page.on("pageerror", (e) => errors.length < 5 && errors.push(e.message))
await page.routeWebSocket(/.*/, () => {})
const files: string[] = []
let total = 0
try {
  await page.goto(`http://localhost:5196/?view=corridor&character=${char}`)
  await page.waitForFunction(() => (globalThis as { __afterhours?: { complete: boolean } }).__afterhours?.complete, null, { timeout: 240_000 })
  await page.addStyleTag({ content: "#hud{display:none!important}" })
  await page.evaluate(async () => {
    const G = globalThis as any
    const url = "/src/render/shared.ts"
    const RS = (await import(url)).renderState
    const { scene, camera } = G.__afterhoursDebug
    const body = G.__afterhoursBody.body
    const V = camera.position.constructor
    const M = (G.__self = { frames: 0, lit: 0, litFrames: 0, worst: -9, on: false })
    RS.beforeRender.push(() => {
      // (The game hides the viewmodel through the pre-render passes; `present` says it shows this frame.)
      if (!M.on || body.viewmodel.present < 0.5) return
      // The flashlight: the shadowed spot nearest the eye.
      let flash: any = null
      for (const o of scene.children) if (o.isSpotLight && o.castShadow && o.intensity > 0 && o.position.distanceTo(camera.position) < 1.2) flash = o
      if (!flash) return
      flash.updateMatrixWorld()
      flash.target.updateMatrixWorld()
      const pos = flash.getWorldPosition(new V())
      const dir = flash.target.getWorldPosition(new V()).sub(pos).normalize()
      const cosOuter = Math.cos(flash.angle)
      let litNow = 0
      const v = new V()
      body.viewmodel.root.updateMatrixWorld(true)
      body.viewmodel.root.traverse((o: any) => {
        if (!o.isMesh || !o.visible) return
        const p = o.geometry.attributes.position
        for (let i = 0; i < p.count; i++) {
          v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld)
          const d = v.clone().sub(pos)
          const len = d.length()
          if (len < 1e-6) continue
          const c = d.dot(dir) / len
          M.worst = Math.max(M.worst, c - cosOuter)
          if (c > cosOuter && len < flash.distance) litNow++
        }
      })
      M.frames++
      M.lit += litNow
      if (litNow) M.litFrames++
    })
  })
  const ev = (src: string) => page.evaluate((src) => new Function("P", "M", src)((globalThis as any).__afterhoursPlayer, (globalThis as any).__self), src)
  type Sc = [string, string[], boolean]
  const SC: Sc[] = [
    ["stand", [], false],
    ["walk", ["KeyW"], false],
    ["run", ["KeyW", "ShiftLeft"], false],
    ["sprint-spin", ["KeyW", "ShiftLeft"], true],
    ["crouch", ["KeyC", "KeyW"], false],
  ]
  for (const [name, keys, spin] of SC) {
    await ev(`P.pos.x=-16;P.pos.y=0.1;P.pos.z=0.2;P.yaw=Math.PI/2;P.pitch=0;P.resetMotion();P.flashlight=true;M.frames=0;M.lit=0;M.litFrames=0;M.worst=-9`)
    await page.waitForTimeout(600)
    await ev(`M.on=true`)
    for (const k of keys) await page.keyboard.down(k)
    for (const [i, p] of [0, -0.52, -1.05, -1.4].entries()) {
      for (let j = 0; j < 8; j++) {
        await ev(`P.pitch=${p}${spin ? `; P.yaw += ${j % 2 ? 0.25 : -0.25}` : ""}`)
        await page.waitForTimeout(90)
      }
      if (name === "run") {
        const f = `${out}/self/sprint-${i}.png`
        await page.screenshot({ path: f })
        files.push(f)
      }
    }
    for (const k of keys) await page.keyboard.up(k)
    const r = (await ev(`M.on=false; return { frames: M.frames, lit: M.lit, litFrames: M.litFrames, worst: M.worst }`)) as { frames: number; lit: number; litFrames: number; worst: number }
    total += r.lit
    console.log(`${name}: ${r.frames} frames, lit viewmodel vertices ${r.lit} (in ${r.litFrames} frames), worst cos margin to the cone ${r.worst.toFixed(3)} (< 0 = outside)`)
  }
} finally {
  await browser.close()
}
console.log(`${char}: TOTAL torch-lit viewmodel vertices ${total} (${total === 0 ? "PASS" : "FAIL"})`)
if (files.length) {
  const dest = `${out}/self-${tag}.png`
  Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", ...files.flatMap((f) => ["-i", f]), "-filter_complex", `hstack=inputs=${files.length},scale=iw/2:-1`, dest])
  console.log(dest)
}
console.log(JSON.stringify({ errors }))
