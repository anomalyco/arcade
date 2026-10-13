// One headless Metal browser, through hivemind. No authenticated pages or audio.
import { chromium } from "playwright-core"
import { createServer } from "vite"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { findChromeExecutable } from "./compare"

const out = join(import.meta.dir, "../../../captures/shared-human")
mkdirSync(out, { recursive: true })
const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } })
await server.listen()
const address = server.httpServer!.address()
if (!address || typeof address === "string") throw new Error("Missing Vite port")
const base = `http://127.0.0.1:${address.port}`
const browser = await chromium.launch({ executablePath: findChromeExecutable(), headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const errors: string[] = [], samples: unknown[] = []
try {
  const page = await browser.newPage({ viewport: { width: 1080, height: 720 }, deviceScaleFactor: 1 })
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  await page.goto(`${base}/anim.html?manual&lab=1&only=proof&zoom=7&side=35&elev=18`)
  await page.waitForFunction(() => (window as any).ready, null, { timeout: 30000 })
  const gpu = await page.evaluate(() => {
    const info = (window as any).animProof.adapter
    return { vendor: info.vendor, architecture: info.architecture, device: info.device }
  })
  if (!/metal/i.test(gpu.architecture) || /swiftshader/i.test(JSON.stringify(gpu))) throw new Error(`Not Metal: ${JSON.stringify(gpu)}`)
  const select = (key: string) => page.locator(`[data-lab] select[data-key="${key}"]`)
  for (const profile of ["soldier", "wizard", "zombie"]) {
    await select("rigDemo").selectOption("off")
    await page.evaluate(() => (window as any).advance(1000 / 60))
    await select("profilePreset").selectOption(profile)
    await select("rigDemo").selectOption("walk")
    await page.keyboard.press("Backquote")
    await page.evaluate(() => (window as any).advance(1500))
    await page.screenshot({ path: join(out, `${profile}.png`) })
    samples.push(await page.evaluate(profile => {
      const p = (window as any).animProof, a = p.rigDemo.avatar
      return { profile, body: a.body, durations: a.motion.durations, toes: a.motion.toes }
    }, profile))
    await page.keyboard.press("Backquote")
  }
  await select("rigDemo").selectOption("compare")
  await page.keyboard.press("Backquote")
  await page.evaluate(() => (window as any).advance(1800))
  await page.screenshot({ path: join(out, "comparison.png") })
  await page.keyboard.press("Backquote")
  // Exercise the existing Blood Lab switch and Game hook, not a second particle implementation.
  await page.locator('[data-lab] select[data-key="style"]').filter({ has: page.locator('option[value="1"]') }).last().selectOption("1")
  await select("rigDemo").selectOption("detach")
  await page.keyboard.press("Backquote")
  const frames = process.argv.includes("--video")
  if (frames) mkdirSync(join(out, "frames"), { recursive: true })
  let noPop = false, detached = 0, splatter = false
  for (let n = 0; n < 180; n++) {
    await page.evaluate(() => (window as any).advance(1000 / 30))
    // time 2.0 is reached on the first of two 60 Hz steps at n=60 on some clocks;
    // retain the first detachment pose directly in the demo for exact spawn verification.
    const state = await page.evaluate(() => {
      const proof = (window as any).animProof, p = proof.rigDemo
      return { hidden: [...(p.avatar.hiddenBones ?? [])], count: p.pieces.length, noPop: p.noPop, time: p.time,
        splatter: !!proof.game.splatterFx?.particles.some((v: number) => v !== 0) }
    })
    detached = Math.max(detached, state.count); noPop ||= state.noPop === true
    splatter ||= state.splatter
    if (frames) await page.screenshot({ path: join(out, "frames", `${String(n).padStart(4, "0")}.png`) })
    if ([54, 60, 66, 78, 105, 165].includes(n)) await page.screenshot({ path: join(out, `detach-${n}.png`) })
  }
  if (detached !== 1 || !noPop) throw new Error(`Detach failed: ${JSON.stringify({ detached, noPop })}`)
  if (!splatter) throw new Error("Detached wound did not reach Game.cosmeticSplatter")
  await page.keyboard.press("Backquote")
  await page.getByRole("button", { name: "Randomize Animation", exact: true }).click()
  const random = await page.evaluate(() => ({ ...(window as any).animProof.animation }))
  await page.getByRole("button", { name: "Reset Animation", exact: true }).click()
  const reset = await page.evaluate(() => ({ ...(window as any).animProof.animation }))
  if (reset.profilePreset !== "soldier" || reset.timingBias !== 0 || reset.handPose !== "weapon") throw new Error("Reset did not restore neutral profile")
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
    writeText: async (text: string) => { (window as any).copiedHuman = JSON.parse(text) },
  } }))
  await page.getByRole("button", { name: "Copy Animation JSON", exact: true }).click()
  await page.waitForFunction(() => (window as any).copiedHuman?.runPosture === 0.18)
  const copied = await page.evaluate(() => (window as any).copiedHuman)
  for (const key of Object.keys(reset)) if (copied[key] !== reset[key]) throw new Error(`Copy mismatch: ${key}`)
  // Keyboard profile editing and group reset share the pointer path.
  await select("profilePreset").focus()
  await page.keyboard.press("ArrowRight")
  if (await select("profilePreset").inputValue() !== "wizard") throw new Error("Keyboard preset failed")
  await page.keyboard.press("Shift+Digit0")
  if (await select("profilePreset").inputValue() !== "soldier") throw new Error("Keyboard group reset failed")
  await page.screenshot({ path: join(out, "lab.png") })
  await page.goto(`${base}/anim.html?manual&only=cast&zoom=7&side=35&elev=18`)
  await page.waitForFunction(() => (window as any).ready)
  await page.evaluate(() => { (window as any).animProof.settings.wizards = true })
  await page.evaluate(() => (window as any).advance(1800))
  const runtimeWizard = await page.evaluate(() => (window as any).animProof.game.avatars.get("cast")?.body)
  if (!runtimeWizard?.gun) throw new Error("Runtime wizard lost its staff frame")
  await page.screenshot({ path: join(out, "runtime-wizard.png") })
  writeFileSync(join(out, "proof.json"), JSON.stringify({ gpu, samples, detached, noPop, splatter, runtimeWizard, random, reset, copied, errors }, null, 2))
  if (errors.length) throw new Error(errors.join("\n"))
  console.log(JSON.stringify({ gpu, profiles: 3, detached, noPop, splatter, keyboard: true, frames: frames ? 180 : 0, errors }))
} finally {
  await browser.close()
  await server.close()
}
