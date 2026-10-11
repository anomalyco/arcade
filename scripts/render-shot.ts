// Screenshot the render harness with headless Chromium.
// usage: bun scripts/render-shot.ts [port] [scene...]   (vite must be serving the project on the port)
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const { chromium } = require("/home/thdxr/dev/projects/handy/node_modules/playwright-core")

const port = Number(process.argv[2] ?? 5291)
const scenes = process.argv.slice(3)
const list = scenes.length ? scenes : ["impact", "aim", "collapse"]
const out = "/tmp/opencode/salvo-shots"
mkdirSync(out, { recursive: true })

function findChrome(): string {
  const base = join(homedir(), ".cache/ms-playwright")
  const dirs = readdirSync(base).filter((d) => d.startsWith("chromium-")).sort().reverse()
  for (const d of dirs) {
    const p = join(base, d, "chrome-linux64/chrome")
    if (existsSync(p)) return p
  }
  throw new Error("no chromium found")
}

const browser = await chromium.launch({ executablePath: findChrome(), args: ["--disable-gpu"] })
for (const spec of list) {
  // spec: scene[:query][@WxH]
  const [s0, size] = spec.split("@")
  const [scene, extra] = (s0 ?? "impact").split(":")
  const [w, h] = (size ?? "1920x1080").split("x").map(Number)
  const dsf = Number(/dpr=(\d+(?:\.\d+)?)/.exec(extra ?? "")?.[1] ?? 1)
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dsf })
  page.on("console", (m: { type(): string; text(): string }) => {
    if (m.type() === "error" || m.type() === "warning") console.log(`[${scene}] ${m.type()}: ${m.text()}`)
  })
  page.on("pageerror", (e: Error) => console.log(`[${scene}] pageerror: ${e.message}`))
  const t0 = Date.now()
  await page.goto(`http://localhost:${port}/render-harness.html?scene=${scene}${extra?.includes("dpr=") ? "" : "&dpr=1"}${extra ? "&" + extra : ""}`)
  await page.waitForFunction(() => document.title === "ready", null, { timeout: 60000 })
  const name = `render-${scene}${extra ? "-" + extra.replace(/[^a-z0-9]+/gi, "_") : ""}${size ? "-" + size : ""}.png`
  await page.screenshot({ path: join(out, name) })
  console.log(`${join(out, name)} (${Date.now() - t0}ms)`)
  await page.close()
}
await browser.close()
