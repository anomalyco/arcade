// Gun and seeker reticle captures: the weapons harness (weapons.html) behind a drone, the gun's sight with its lead cue,
// then the AIM-9's seeker tracking and locked, in chase and cockpit views, for the Hornet and the F-35C.
//
//   bun scripts/reticle-shot.ts --base=http://localhost:5197/ --out=captures/reticles [--swiftshader]
//
// On a Mac (hailmary) it uses Chrome on Metal; --swiftshader runs Playwright's Chromium on SwiftShader anywhere.
import { type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

await using budget = browserBudget()
const { chromium } = budget

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const base = opt("base", "http://localhost:5197/")
const out = opt("out", "captures/reticles")
const [vw, vh] = opt("size", "1280x800").split("x").map(Number) as [number, number]
const swiftshader = args.includes("--swiftshader")
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({
  executablePath: swiftshader ? undefined : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--mute-audio",
    "--enable-features=WebGPU,Vulkan",
    "--ignore-gpu-blocklist",
    ...(swiftshader ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--use-vulkan=swiftshader"] : ["--use-angle=metal"]),
  ],
})
let failures = 0
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) failures++
}

async function open(query: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
  page.on("pageerror", (e) => console.log(`pageerror: ${e.message}`))
  await page.goto(`${base}weapons.html?${query}`, { waitUntil: "load" })
  await page.waitForFunction(() => !!(globalThis as unknown as { carrier?: { weapons?: unknown } }).carrier?.weapons, null, { timeout: 90_000 })
  await page.waitForTimeout(1500)
  return page
}

type S = { weapon: string; lock: number; locked: boolean; ret: string; dia: string; lead: boolean; cross: boolean }
const state = (p: Page): Promise<S> =>
  p.evaluate(() => {
    const c = (globalThis as unknown as { carrier: { weapons: { status: { weapon: string; lock: number; locked: boolean } } } }).carrier
    const q = (s: string) => document.querySelector<HTMLElement>(s)
    const vis = (s: string) => !!q(s) && !q(s)!.hidden
    const ret = vis("#wp .ret") ? (vis("#wp .ret .gun") ? "gun" : vis("#wp .ret .msl") ? `seeker ${q("#wp .ret .cone")!.style.width}` : "?") : "none"
    return {
      ...c.weapons.status,
      ret,
      dia: vis("#wp .dia") ? q("#wp .dia")!.className : "hidden",
      lead: vis("#wp .lead"),
      cross: getComputedStyle(q("#fl .nose")!).display !== "none",
    }
  })

async function until(p: Page, ok: (s: S) => boolean, ms: number): Promise<S> {
  const end = Date.now() + ms
  let s = await state(p)
  while (!ok(s) && Date.now() < end) {
    await p.waitForTimeout(50)
    s = await state(p)
  }
  return s
}

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({ path: join(out, `${name}.png`) })
  console.log(`${name}: ${JSON.stringify(await state(p))}`)
}

async function hornet(view: "chase" | "cockpit"): Promise<void> {
  const p = await open(`drone=3${view === "cockpit" ? "&cockpit" : ""}`)
  // Gun: a drone ahead and above, off the nose, so the lead cue stands apart from the pipper.
  await p.evaluate("carrier.behind(100, 520, 45)")
  await p.waitForTimeout(400)
  let s = await until(p, (s) => s.lead, 3000)
  check(s.weapon === "gun" && s.ret === "gun" && !s.cross, `${view}: gun reticle replaces the boresight cross: ${JSON.stringify(s)}`)
  check(s.lead, `${view}: lead cue on the drone`)
  await shot(p, `hornet-${view}-gun`)
  // Missile: the seeker tracking, then locked.
  await p.evaluate("carrier.behind(101, 1300, 30); carrier.aim = 101")
  await p.keyboard.press("Digit2")
  s = await until(p, (s) => s.lock === 101, 4000)
  await p.waitForTimeout(120)
  s = await state(p)
  check(s.ret.startsWith("seeker") && s.dia.includes("track"), `${view}: seeker circle, diamond tracking: ${JSON.stringify(s)}`)
  await shot(p, `hornet-${view}-missile-tracking`)
  s = await until(p, (s) => s.locked, 5000)
  await p.waitForTimeout(150)
  check(s.locked && (await state(p)).dia.includes("locked"), `${view}: diamond solid on lock`)
  await shot(p, `hornet-${view}-missile-locked`)
  await p.close()
}

async function f35(): Promise<void> {
  const p = await open("drone=3&f35")
  await p.evaluate("carrier.behind(101, 1300, 30); carrier.aim = 101")
  await p.waitForTimeout(500)
  let s = await state(p)
  check(s.weapon === "missile" && s.ret.startsWith("seeker"), `F-35C starts on the seeker: ${JSON.stringify(s)}`)
  s = await until(p, (s) => s.locked, 6000)
  await p.waitForTimeout(150)
  await shot(p, "f35-chase-missile-locked")
  await p.keyboard.press("Digit2")
  s = await until(p, (s) => s.weapon === "bomb", 1500)
  await p.waitForTimeout(400)
  s = await state(p)
  check(s.weapon === "bomb" && s.ret === "none", `bombs: no reticle (the bombsight's): ${JSON.stringify(s)}`)
  await p.close()
}

try {
  await hornet("chase")
  await hornet("cockpit")
  await f35()
} finally {
  await browser.close()
}
console.log(failures ? `${failures} failed` : "all ok")
process.exit(failures ? 1 : 0)
