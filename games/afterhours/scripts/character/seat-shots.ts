// The seated driver in the intro car (src/playerb/seat.ts), in the real game: the car (src/game/intro/car.ts) parked
// under a lot lamp with test anchors for the hip, eye, door handle and door panel; first-person and third-person
// stills while steering (straight, left, right, a big turn with a re-grip) and through the door reach.
//
//   bun scripts/character/seat-shots.ts [--tag t] [--char remy]
//
// One browser, 960×600, closed at the end. Output: captures/character/seat-<tag>.png (rows: moments; columns: first
// person, windscreen view, door-side view), tiles in captures/character/seat/.
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync } from "node:fs"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args.splice(i, 2)[1]! : undefined
}
const tag = flag("tag") ?? "run"
const char = flag("char") ?? "remy"
const out = `${import.meta.dir}/../../captures/character`
const tiles = `${out}/seat`
mkdirSync(tiles, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
const context = await browser.newContext({ viewport: { width: 960, height: 600 } })
const page = await context.newPage()
const errors: string[] = []
page.on("pageerror", (e) => errors.length < 5 && errors.push(e.message))
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 300)))
await page.routeWebSocket(/.*/, () => {})
const rows: string[][] = []
try {
  await page.goto(`http://localhost:5196/?view=lot&character=${char}`)
  await page.waitForFunction(() => (globalThis as { __afterhours?: { complete: boolean } }).__afterhours?.complete, null, { timeout: 240_000 })
  await page.addStyleTag({ content: "#hud{display:none!important}" })
  const setupErr = await page.evaluate(async () => {
    try {
      const G = globalThis as unknown as Record<string, any>
      const P = G.__afterhoursPlayer
      const B = G.__afterhoursBody
      const { renderer, scene, camera } = G.__afterhoursDebug
      const url = "/src/game/intro/index.ts"
      const intro = await import(url)
      const world = { ctx: P.ctx, scene, warmup: { warm: (o: unknown) => renderer.compileAsync(o, camera, scene) } }
      await intro.prepareIntro(world)
      const c = intro.playerCar()
      // Under the lot's nearest bright lamp.
      let lamp = [-26, 0, 100]
      let bd = 1e9
      for (const l of P.ctx.lamps) {
        const d = Math.hypot(l.position[0] + 26, l.position[2] - 100)
        if ((l.intensity ?? 0) > 500 && d < bd) {
          bd = d
          lamp = l.position
        }
      }
      const x = lamp[0] + 2
      const z = lamp[2] + 3
      c.place(x, 0.04, z, 0.3)
      c.lights.dash = 1
      const V = c.root.position.constructor
      const O = c.root.constructor // THREE.Group
      const anchor = (parent: any, p: number[]) => {
        const o = new O()
        o.position.set(p[0], p[1], p[2])
        parent.add(o)
        return o
      }
      // Car model space: hip (H-point), eye (SEATS driver); door anchors relative to the door group (hinge).
      const hip = anchor(c.body, [-0.37, 0.53, 0.08])
      const eye = anchor(c.body, [-0.37, 1.18, 0.22])
      const hinge = c.door.position
      const handle = anchor(c.door, [-0.67 - hinge.x, 0.95, -0.36 - hinge.z])
      const edge = anchor(c.door, [-0.68 - hinge.x, 0.97, -0.1 - hinge.z])
      B.body.seat({ hip, eye, wheel: { object: c.steering, radius: 0.147 }, doorHandle: handle, doorEdge: edge })
      // Exposure up a little so the cabin reads in the capture.
      B.settings["post.exposure"] = Number(B.settings["post.exposure"] ?? -2.2) + 1.5
      const S = (G.__seatTest = { curvature: 0, door: 0, view: "fp", t: 0, eye })
      P.update = (dt: number) => {
        S.t += dt
        c.update(dt, S.t, 4, 0, S.curvature)
        // The swing the API doc recommends: pushed ~25° open by the palm (t 0.6–0.9), then swinging free.
        const ss = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v * v * (3 - 2 * v))
        c.doorAmount = 0.1 * ss((S.door - 0.6) / 0.3) + 0.9 * ss((S.door - 0.9) / 0.1)
        B.body.steer(c.wheelAngle)
        B.body.reachDoor(S.door)
        c.root.updateMatrixWorld(true)
        const v = new V()
        if (S.view === "fp") {
          camera.layers.disable(4)
          eye.getWorldPosition(v)
          camera.position.copy(v)
          camera.quaternion.copy(c.body.getWorldQuaternion(camera.quaternion.clone()))
          // The intro's driving pitch (-0.035) plus a slight glance down.
          camera.rotateX(-0.08)
        } else {
          camera.layers.enable(4)
          const p = S.view === "front" ? [-0.25, 1.22, -1.45] : [-1.85, 1.25, -0.45]
          const at = S.view === "front" ? [-0.37, 0.95, 0.05] : [-0.45, 0.95, -0.15]
          camera.position.set(p[0], p[1], p[2]).applyMatrix4(c.body.matrixWorld)
          camera.lookAt(new V(at[0], at[1], at[2]).applyMatrix4(c.body.matrixWorld))
        }
        camera.updateMatrixWorld()
      }
      return null
    } catch (e) {
      return String((e as Error).stack ?? e)
    }
  })
  if (setupErr) throw new Error(setupErr)
  const wait = (ms: number) => page.waitForTimeout(ms)
  const set = (src: string) => page.evaluate((src) => new Function("S", src)((globalThis as unknown as { __seatTest: unknown }).__seatTest), src)
  const onlyFp = process.argv.includes("--fp")
  const MOMENTS: [string, string, number][] = [
    ["straight", `S.curvature = 0; S.door = 0`, 1500],
    ["left", `S.curvature = 0.035`, 1500],
    ["right", `S.curvature = -0.035`, 1800],
    ["bigleft", `S.curvature = 0.09`, 2200],
    ["door-handle", `S.curvature = 0; S.door = 0.4`, 1500],
    ["door-push", `S.door = 0.8`, 900],
    ["door-out", `S.door = 1`, 900],
  ]
  for (const [name, src, ms] of MOMENTS) {
    await set(src)
    await wait(ms)
    const row: string[] = []
    if (onlyFp && name.startsWith("door")) continue
    for (const view of onlyFp ? ["fp"] : ["fp", "front", "side"]) {
      await set(`S.view = "${view}"`)
      await wait(150)
      if (view === "fp") console.log(name, JSON.stringify(await page.evaluate(() => (globalThis as any).__afterhoursBody.body.seatRig?.debug)))
      const f = `${tiles}/${name}-${view}.png`
      await page.screenshot({ path: f })
      row.push(f)
    }
    await set(`S.view = "fp"`)
    rows.push(row)
  }
} finally {
  await context.close()
  await browser.close()
}
const files = rows.flat()
if (files.length) {
  const cols = 3
  const at = (n: number, s: string) => (n ? Array.from({ length: n }, () => s).join("+") : "0")
  const layout = files.map((_, i) => `${at(i % cols, "w0")}_${at(Math.floor(i / cols), "h0")}`).join("|")
  const dest = `${out}/seat-${tag}.png`
  const p = Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", ...files.flatMap((f) => ["-i", f]), "-filter_complex", `xstack=inputs=${files.length}:layout=${layout},scale=iw*0.5:-1`, dest])
  if (p.exitCode !== 0) errors.push(p.stderr.toString())
  else console.log(dest)
}
console.log(JSON.stringify({ errors }))
