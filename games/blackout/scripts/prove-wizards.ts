// Bounded Metal proof against the named Nexus preview. No visible window or audio.
import { browserBudget } from "../../../scripts/browser-budget"
import { mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

await using budget = browserBudget()
const { chromium } = budget

const base = process.env.URL ?? "http://wizards.localhost:1355"
const out = process.env.OUT ?? "captures/wizards"
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell"), headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--mute-audio"] })
const page = await browser.newPage({ viewport: { width: 1000, height: 750 }, deviceScaleFactor: 1 })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
const advance = (ms: number) => page.evaluate(async (ms) => { await (window as unknown as { advance(ms: number): Promise<void> }).advance(ms) }, ms)
const wizard = async () => { await page.getByRole("checkbox", { name: "Wizards", exact: true }).check(); await page.getByRole("button", { name: "~ Lab", exact: true }).click() }
try {
  for (const [id, name, time, side] of [["a", "orange-walk", 600, 125], ["b", "cyan-walk", 600, 125], ["d", "violet-lantern", 600, -55], ["e", "green-ice", 600, -55], ["cast", "cast", 350, 125]] as const) {
    await page.goto(`${base}/anim.html?lab=1&manual&only=${id}&zoom=7&side=${side}&elev=18`)
    await page.waitForFunction(() => (window as unknown as { ready: boolean }).ready)
    await wizard()
    await advance(time)
    await page.screenshot({ path: join(out, `${name}.png`) })
  }
  await page.goto(`${base}/anim.html?lab=1&manual&zoom=26`)
  await page.waitForFunction(() => (window as unknown as { ready: boolean }).ready)
  await wizard()
  await advance(650)
  await page.screenshot({ path: join(out, "group.png") })
  await advance(1400) // Includes actor f's real ragdoll.
  await page.screenshot({ path: join(out, "ragdoll.png") })
  const adapter = await page.evaluate(async () => { const a = await navigator.gpu.requestAdapter(); return a ? { vendor: a.info.vendor, architecture: a.info.architecture, device: a.info.device } : null })
  if (!adapter || /swiftshader/i.test(JSON.stringify(adapter))) throw new Error("Metal adapter required")
  await page.goto(`${base}/anim.html?lab=1&manual&only=weapons&zoom=11&side=15&elev=18`)
  await page.waitForFunction(() => (window as unknown as { ready: boolean }).ready)
  await wizard()
  await advance(100)
  await page.screenshot({ path: join(out, "weapons.png") })
  await page.goto(`${base}/envlab.html?lab=1&fixture=room&x=8&y=5&zoom=30`)
  await page.waitForFunction(() => typeof (window as unknown as { stats?: unknown }).stats === "function")
  await wizard()
  await page.waitForTimeout(700)
  await page.screenshot({ path: join(out, "castle.png") })
  await page.goto(`${base}/?sandbox=1&lab=1&seed=1&peaceful=1`)
  await page.getByRole("checkbox", { name: "Wizards", exact: true }).waitFor()
  await wizard()
  await page.waitForTimeout(700)
  await page.screenshot({ path: join(out, "sandbox.png") })
  await page.keyboard.press("Backquote")
  await page.getByRole("checkbox", { name: "Wizards", exact: true }).uncheck()
  await page.waitForTimeout(300)
  await page.getByRole("checkbox", { name: "Wizards", exact: true }).check()
  await page.waitForTimeout(300)
  writeFileSync(join(out, "proof.json"), JSON.stringify({ adapter, errors }, null, 2))
  if (errors.length) throw new Error(errors.join("\n"))
} finally { await browser.close() }
