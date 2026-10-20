import { chromium } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"
const [tag, ...chars] = process.argv.slice(2)
const dir = "/Users/aidencline/development/arcade-afterhours/games/afterhours/captures/viewmodel"
Bun.spawnSync(["mkdir", "-p", dir])
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter((n) => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse().map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
page.on("pageerror", (e) => console.log("err", e.message))
await page.routeWebSocket(/.*/, () => {})
for (const c of chars) {
  await page.goto(`http://localhost:5196/?view=corridor&character=${c}`)
  await page.waitForFunction(() => (globalThis as any).__afterhours?.complete, null, { timeout: 240_000 })
  await page.addStyleTag({ content: "#hud{display:none!important}" })
  await page.evaluate(() => { const P = (globalThis as any).__afterhoursPlayer; P.teleport("corridor"); P.pitch = -0.25; P.flashlight = true })
  await page.waitForTimeout(2500)
  const info = await page.evaluate(() => {
    const B = (globalThis as any).__afterhoursBody.body
    const out: any[] = []
    B.viewmodel.root.traverse((o: any) => { if (o.isMesh && o.material?.map) { const t = o.material.map; out.push({ n: o.name, img: [t.image?.width, t.image?.height], min: t.minFilter, mip: t.generateMipmaps, mips: t.mipmaps?.length, an: t.anisotropy, cs: t.colorSpace, nm: o.material.normalMap ? [o.material.normalMap.image?.width, o.material.normalMap.anisotropy, o.material.normalMap.minFilter] : null }) } })
    return out
  })
  console.log(c, JSON.stringify(info))
  const f = `${dir}/${tag}-${c}.png`
  await page.screenshot({ path: f })
  console.log(f)
}
await browser.close()
