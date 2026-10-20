// Flashlight in the washroom mirrors (the reflection shows the third-person pose, the lit lens and the beam's light)
// plus a third-person debug view of the same moment.
//
//   bun scripts/character/mirror-shots.ts [--tag t] [--chars remy,kate]
//
// Output: captures/character/mirror-<tag>.png (rows: shots; columns: first person | third person), tiles in
// captures/character/mirror/.
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync } from "node:fs"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args.splice(i, 2)[1]! : undefined
}
const tag = flag("tag") ?? "run"
const chars = (flag("chars") ?? "remy,kate").split(",")
const out = `${import.meta.dir}/../../captures/character`
const tiles = `${out}/mirror`
mkdirSync(tiles, { recursive: true })
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
page.on("pageerror", (e) => errors.push(e.message))
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 300)))
await page.routeWebSocket(/.*/, () => {})
await page.goto(`http://localhost:5196/?view=corridor&perf=1&character=${chars[0]}`)
await page.waitForFunction(() => (globalThis as { __ashwood?: { complete: boolean } }).__ashwood?.complete, null, { timeout: 240_000 })
await page.addStyleTag({ content: "#hud{display:none!important}" })
const ev = <T>(src: string): Promise<T> =>
  page.evaluate((src) => new Function("P", "B", "M", src)((globalThis as Record<string, unknown>).__ashwoodPlayer, (globalThis as Record<string, unknown>).__ashwoodBody, (globalThis as Record<string, unknown>).__ashwoodMirrors), src) as Promise<T>
const wait = (ms: number) => page.waitForTimeout(ms)

// Washroom mirrors (they reflect a layer), ground floor first.
const glass = await ev<{ x: number; y: number; z: number; nx: number; nz: number }[]>(`
  return M.mirrors.filter(m => m.mesh.userData.reflectLayer !== undefined).map(m => ({ x: m.center.x, y: m.center.y, z: m.center.z, nx: m.normal.x, nz: m.normal.z })).sort((a, b) => a.y - b.y)`)
console.log(`${glass.length} washroom mirrors; using ${JSON.stringify(glass[0])}`)
const g = glass[0]!
const floorY = g.y - 1.4
const rows: string[][] = []
async function shot(name: string, dist: number, side: number, yawOff: number, pitch: number) {
  // Stand `dist` in front of the glass (`side` m along it), facing it.
  const tx = -g.nz
  const tz = g.nx
  const x = g.x + g.nx * dist + tx * side
  const z = g.z + g.nz * dist + tz * side
  const yaw = Math.atan2(g.nx, g.nz) + yawOff
  await ev(`P.pos.x=${x};P.pos.y=${floorY + 0.3};P.pos.z=${z};P.yaw=${yaw};P.pitch=${pitch};P.resetMotion();P.flashlight=true`)
  await wait(1300)
  const fp = `${tiles}/${name}-fp.png`
  const tp = `${tiles}/${name}-third.png`
  await page.screenshot({ path: fp })
  await ev(`B.settings["body.view"]=1;B.settings["body.thirdDist"]=1.6`)
  await wait(150)
  await page.screenshot({ path: tp })
  await ev(`B.settings["body.view"]=0`)
  rows.push([fp, tp])
}
for (const c of chars) {
  await ev(`B.settings["player.character"]=${JSON.stringify(c)}`)
  await page.waitForFunction((id) => (globalThis as unknown as { __ashwoodBody: { body: { character: string } } }).__ashwoodBody.body.character === id, c, { timeout: 60_000 })
  // At the basin, looking at yourself in the mirror, the torch lighting the basin (pointed down a little).
  await shot(`${c}-basin`, 1.3, 0.25, 0, -0.12)
  // Torch pointed straight into the mirror from further back.
  await shot(`${c}-into`, 2.2, 0, 0, 0.0)
  // Side-on, the reflection showing the arm in profile.
  await shot(`${c}-side`, 1.5, -0.6, 0.6, -0.1)
}
await browser.close()
const files = rows.flat()
const cols = 2
const at = (n: number, s: string) => (n ? Array.from({ length: n }, () => s).join("+") : "0")
const layout = files.map((_, i) => `${at(i % cols, "w0")}_${at(Math.floor(i / cols), "h0")}`).join("|")
const dest = `${out}/mirror-${tag}.png`
const p = Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", ...files.flatMap((f) => ["-i", f]), "-filter_complex", `xstack=inputs=${files.length}:layout=${layout},scale=iw*0.5:-1`, dest])
if (p.exitCode !== 0) errors.push(p.stderr.toString())
console.log(dest, JSON.stringify({ errors }))
