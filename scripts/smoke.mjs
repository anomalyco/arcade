// Run from a game directory after `bun run check` has built its production bundle.
import assert from "node:assert/strict"
import { basename, resolve, sep } from "node:path"
import { chromium } from "playwright-core"

const game = basename(process.cwd())
assert(["blackout", "getaway", "carrier"].includes(game), `Unknown game: ${game}`)
const prefix = `/arcade/${game}/`
const root = resolve(`dist/arcade/${game}`)
assert(await Bun.file(resolve(root, "index.html")).exists(), "Build the game before running smoke")
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    // This is a static-bundle check; optional lobby data needs no Worker.
    if (path === `${prefix}api/stats`) return Response.json({ players: 0, games: 0 })
    if (!path.startsWith(prefix)) return new Response("Not found", { status: 404 })
    const file = resolve(root, decodeURIComponent(path.slice(prefix.length)) || "index.html")
    if (!file.startsWith(root + sep)) return new Response("Not found", { status: 404 })
    const asset = Bun.file(file)
    return await asset.exists() ? new Response(asset) : new Response("Not found", { status: 404 })
  },
})
let browser
const deadline = setTimeout(() => {
  console.error(`${game}: smoke exceeded 45 seconds`)
  process.exit(1)
}, 45_000)
try {
  browser = await chromium.launch({
    headless: true,
    timeout: 10_000,
    args: ["--enable-unsafe-webgpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  })
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } })
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
  page.on("requestfailed", request => errors.push(`${request.url()}: ${request.failure()?.errorText}`))
  page.on("response", response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
  const response = await page.goto(`http://127.0.0.1:${server.port}${prefix}`, { waitUntil: "load", timeout: 15_000 })
  assert.equal(response.status(), 200)
  // Require JS-created UI, not the static HTML shell. A missing GPU is an explicit
  // supported outcome for these WebGPU-only games, never a blanket error waiver.
  const ready = await page.waitForFunction(game => {
    const sel = {
      blackout: ["#menu .notice", '#menu [data-act="practice"]'],
      getaway: ["#overlay .nogpu p", '#overlay [data-act="solo"]'],
      carrier: ["#hud .notice", '.mn [data-act="quick"]'],
    }[game]
    const failure = document.querySelector(sel[0])?.textContent
    if (failure && /needs WebGPU|No WebGPU adapter is available|WebGPU could not start/.test(failure)) return failure
    return document.querySelector(sel[1]) ? "lobby ready" : false
  }, game, { timeout: 20_000 })
  // Let initialization promises and the first presentation frames report errors.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.deepEqual(errors, [], `${game}: browser errors`)
  console.log(`${game}: production smoke passed (${await ready.jsonValue()})`)
} finally {
  await browser?.close()
  server.stop(true)
  clearTimeout(deadline)
}
