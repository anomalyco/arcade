/** Real pointer/keyboard checks for the production Water Lab boat adapter. */
import { createServer } from "vite"
import { chromium } from "playwright-core"
import { mkdirSync } from "node:fs"
import { hostname } from "node:os"
import { resolve } from "node:path"
import { writeBuildId } from "./build-id"
import { installPage, type Clock } from "../games/carrier/scripts/video/page"

type Debug = { __vc: Clock; carrier: {
  driver: { boat: { x: number; z: number; heave: number } }
  camera: { viewProj: Float64Array }; ocean: { water: { mode: "today" | "continuous" } }
} }
if (!hostname().startsWith("aak2-2")) throw Error("Water proof must run on mini")
const out = resolve("captures/water/editor")
mkdirSync(out, { recursive: true })
writeBuildId(resolve("games/carrier"))
const server = await createServer({ root: "games/carrier", server: { host: "127.0.0.1", port: 0, strictPort: true } })
await server.listen()
const address = server.httpServer!.address()
if (!address || typeof address === "string") throw Error("No capture port")
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error" && /gpu|wgsl|shader|validation/i.test(m.text())) errors.push(m.text()) })
  await page.addInitScript(installPage)
  await page.goto(`http://127.0.0.1:${address.port}/water.html?seed=7&waterLook=continuous`)
  await page.getByRole("radio", { name: "Play", exact: true }).waitFor()
  const frames = (n: number) => page.evaluate(async n => {
    const w = globalThis as unknown as Debug
    w.__vc.depth = 1
    for (let i = 0; i < n; i++) await w.__vc.frame(1000 / 60, false, false)
  }, n)
  const position = () => page.evaluate(() => {
    const b = (globalThis as unknown as Debug).carrier.driver.boat
    return { x: b.x, z: b.z }
  })
  const distance = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z)
  await frames(60)
  const initial = await position()
  const point = await page.evaluate(() => {
    const c = (globalThis as unknown as Debug).carrier, b = c.driver.boat, m = c.camera.viewProj
    const p = [b.x, b.heave, b.z, 1]
    const clip = [0, 1, 2, 3].map(row => p.reduce((sum, value, i) => sum + value * m[i * 4 + row]!, 0))
    return { x: (clip[0]! / clip[3]! + 1) * innerWidth / 2, y: (1 - clip[1]! / clip[3]!) * innerHeight / 2 }
  })
  if (point.x < 40 || point.x > 1400 || point.y < 40 || point.y > 860) throw Error(`Boat outside drag viewport: ${JSON.stringify(point)}`)
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.move(point.x + 70, point.y + 30, { steps: 8 })
  await frames(2)
  const dragged = await position()
  await page.mouse.up()
  if (distance(initial, dragged) < 2) throw Error("Real pointer drag did not move boat")
  await page.keyboard.down("w")
  await frames(60)
  await page.keyboard.up("w")
  if (distance(dragged, await position()) > 0.001) throw Error("Edit mode accepted gameplay movement")
  await page.screenshot({ path: `${out}/edit.png` })
  await page.getByRole("radio", { name: "Play", exact: true }).click()
  // Give the canvas keyboard ownership without taking pointer lock.
  await page.locator("canvas#view").click({ position: { x: 720, y: 600 } })
  await page.keyboard.down("w")
  await frames(180)
  await page.keyboard.up("w")
  const played = await position()
  if (distance(dragged, played) < 1) throw Error("Play mode did not drive the boat")
  if (await page.evaluate(() => !!document.pointerLockElement)) throw Error("Water Lab stole pointer lock")
  await page.getByRole("radio", { name: "Today", exact: true }).click()
  await frames(3)
  if (await page.evaluate(() => (globalThis as unknown as Debug).carrier.ocean.water.mode) !== "today") throw Error("Today control did not restore baseline")
  await page.screenshot({ path: `${out}/today.png` })
  if (errors.length) throw Error(errors.join("\n"))
  await Bun.write(`${out}/manifest.json`, JSON.stringify({ hostname: hostname(), initial, dragged, played, pointerLock: false, errors }, null, 2))
} finally { await browser.close(); await server.close() }
