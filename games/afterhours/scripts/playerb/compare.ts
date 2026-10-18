// Raw FBX vs converted glb contact sheets (scripts/playerb/compare.html) into captures/bodyb/compare/:
//   bun scripts/playerb/compare.ts bind [--chars remy,james]           one sheet: every character, bind pose, front
//   bun scripts/playerb/compare.ts clips [--chars remy] [--clips walking,...] [--view front] [--n 4]
//     one sheet per character × clip: n frames spread over the clip
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import ROSTER from "../../src/playerb/roster.json"

const args = process.argv.slice(2)
const flag = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`)
  return i < 0 ? def : args[i + 1]!
}
const meta = ROSTER as unknown as { characters: Record<string, unknown>; anims: { clips: Record<string, { duration: number }> } }
const chars = flag("chars", Object.keys(meta.characters).sort().join(",")).split(",")
const clips = flag("clips", Object.keys(meta.anims.clips).sort().join(",")).split(",")
const view = flag("view", "front")
const n = Number(flag("n", "4"))
const out = `${import.meta.dir}/../../captures/bodyb/compare`
mkdirSync(out, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((x) => /^chromium_headless_shell-\d+$/.test(x))
  .sort()
  .reverse()
  .map((x) => `${cache}/${x}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal"] })
const page = await browser.newPage({ viewport: { width: 640, height: 640 } })
page.on("pageerror", (e) => console.log("ERR", e.message))
await page.goto(`http://localhost:5196/scripts/playerb/compare.html?char=${chars[0]}&mode=bind`)
await page.waitForFunction(() => (globalThis as { __cmp?: { ready: boolean } }).__cmp?.ready, null, { timeout: 180_000 })
type C = { set(id: string, clip: string, frame: number, view: string, mode?: string, zoom?: string): Promise<void> }
const zoom = flag("zoom", "")
const shot = async (id: string, clip: string, frame: number, v: string, mode: string, file: string) => {
  await page.evaluate(([id, clip, frame, v, mode, zoom]) => (globalThis as unknown as { __cmp: C }).__cmp.set(id as string, clip as string, frame as number, v as string, mode as string, zoom as string), [id, clip, frame, v, mode, zoom] as const)
  await page.waitForTimeout(120)
  await page.screenshot({ path: file })
  return file
}
const sheet = (files: string[], cols: number, name: string) => {
  const inputs = files.flatMap((f) => ["-i", f])
  const at = (k: number, s: string) => (k ? Array.from({ length: k }, () => s).join("+") : "0")
  const layout = files.map((_, i) => `${at(i % cols, "w0")}_${at(Math.floor(i / cols), "h0")}`).join("|")
  Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", ...inputs, "-filter_complex", files.length > 1 ? `xstack=inputs=${files.length}:layout=${layout},scale=iw/2:-1` : "scale=iw/2:-1", name])
  console.log(name)
}
if (args[0] === "bind") {
  const files: string[] = []
  for (const id of chars) files.push(await shot(id, "", 0, view, "bind", `${out}/_bind-${id}.png`))
  sheet(files, files.length, `${out}/bind${zoom ? "-zoom" : ""}-${view}.png`)
} else if (args[0] === "mosaic") {
  // One image per character: a row per clip (n frames each), small, raw on the left of each cell.
  for (const id of chars) {
    const rows: string[] = []
    for (const clip of clips) {
      const frames = Math.round(meta.anims.clips[clip]!.duration * 30)
      const files: string[] = []
      for (let i = 0; i < n; i++) files.push(await shot(id, clip, Math.round((i * frames) / n), view, "pair", `${out}/_${id}-${clip}-${i}.png`))
      const row = `${out}/_row-${id}-${clip}.png`
      Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", ...files.flatMap((f) => ["-i", f]), "-filter_complex", `hstack=inputs=${files.length},scale=iw/4:-1`, row])
      rows.push(row)
    }
    for (let p = 0; p * 8 < rows.length; p++) {
      const part = rows.slice(p * 8, p * 8 + 8)
      Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", ...part.flatMap((f) => ["-i", f]), "-filter_complex", part.length > 1 ? `vstack=inputs=${part.length}` : "null", `${out}/mosaic-${id}-${view}-${p}.png`])
      console.log(`${out}/mosaic-${id}-${view}-${p}.png  ${clips.slice(p * 8, p * 8 + 8).join(",")}`)
    }
  }
} else {
  for (const id of chars) {
    for (const clip of clips) {
      const frames = Math.round(meta.anims.clips[clip]!.duration * 30)
      const files: string[] = []
      for (let i = 0; i < n; i++) files.push(await shot(id, clip, Math.round((i * frames) / n), view, "pair", `${out}/_${id}-${clip}-${i}.png`))
      sheet(files, n, `${out}/${id}-${clip}-${view}.png`)
    }
  }
}
await browser.close()
