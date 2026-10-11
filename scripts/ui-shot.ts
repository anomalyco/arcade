// Dev-only: screenshot UI harness screens. Usage: bun scripts/ui-shot.ts [port] [name=query ...]
// Example: bun scripts/ui-shot.ts 5391 game=screen=game shop=screen=shop
import { mkdirSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { chromium } = require("/home/thdxr/dev/projects/handy/node_modules/playwright-core") as typeof import("playwright-core")

const port = process.argv[2] ?? "5391"
const pairs = process.argv.slice(3)
const shots = pairs.length
  ? pairs.map((p) => {
      const i = p.indexOf("=")
      return { name: p.slice(0, i), query: p.slice(i + 1) }
    })
  : ["title", "lobby", "game", "shop", "results"].map((s) => ({ name: s, query: `screen=${s}` }))

const root = join(homedir(), ".cache/ms-playwright")
const shell = readdirSync(root)
  .filter((d) => d.startsWith("chromium_headless_shell-"))
  .sort()
  .reverse()[0]
const executablePath = join(root, shell, "chrome-headless-shell-linux64", "chrome-headless-shell")

const out = "/tmp/opencode/salvo-shots"
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ executablePath })
const [vw, vh] = (process.env.VIEWPORT ?? "1600x1000").split("x").map(Number)
const page = await browser.newPage({ viewport: { width: vw, height: vh } })
page.on("console", (m) => {
  if (m.type() === "error") console.log("console error:", m.text())
})
page.on("pageerror", (e) => console.log("page error:", e.message))
for (const s of shots) {
  await page.goto(`http://localhost:${port}/ui-harness.html?${s.query}`, { waitUntil: "networkidle" })
  await page.waitForTimeout(2600)
  const file = join(out, `${s.name}.png`)
  await page.screenshot({ path: file })
  console.log(file)
}
await browser.close()
