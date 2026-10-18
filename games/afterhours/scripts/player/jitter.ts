// Leg-glitch diagnosis: drives a Body Lab script at a fixed 60 Hz step (no wall-clock jitter), records every bone's
// world rotation each frame, and reports per-bone angular speed (deg/s): median, max, and spikes (frames above
// max(4 × median, 400°/s)), with the gait phase and state at each spike.
//
//   bun scripts/player/jitter.ts "walk|script=walk" "walk-noik|script=walk&set=body.footIK:false,…" [--seconds 3]
import { chromium } from "playwright-core"
import { existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs"

const args = process.argv.slice(2)
const i = args.indexOf("--seconds")
const seconds = i >= 0 ? Number(args.splice(i, 2)[1]) : 3
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal"] })
const out = `${import.meta.dir}/../../captures/body-lab/jitter`
mkdirSync(out, { recursive: true })
for (const setup of args) {
  const [name, query] = setup.split("|") as [string, string]
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
  await page.goto(`http://localhost:5196/body.html?shot=1&manual=1&${query}`)
  await page.waitForFunction(() => (globalThis as { __bodyLab?: { ready: boolean } }).__bodyLab?.ready, null, { timeout: 90_000 })
  const r = await page.evaluate((frames) => {
    const L = (globalThis as unknown as { __bodyLab: { step(dt: number): void; body: { model: import("three").Object3D; debug: { phase: number; state: string } } } }).__bodyLab
    const bones: import("three").Object3D[] = []
    L.body.model.traverse((o) => (o as { isBone?: boolean }).isBone && !/_0[123]_|leaf|thumb|index|middle|ring|pinky/.test(o.name) && bones.push(o))
    for (let k = 0; k < 90; k++) L.step(1 / 60) // warm-up
    const Q = bones[0]!.quaternion.constructor as new () => import("three").Quaternion
    const prev = bones.map(() => new Q())
    const speeds: number[][] = bones.map(() => [])
    const meta: string[] = []
    bones.forEach((b, j) => b.getWorldQuaternion(prev[j]!))
    const q = new Q()
    for (let f = 0; f < frames; f++) {
      L.step(1 / 60)
      meta.push(`${L.body.debug.phase.toFixed(3)} ${L.body.debug.state}`)
      bones.forEach((b, j) => {
        b.getWorldQuaternion(q)
        const d = Math.min(1, Math.abs(q.dot(prev[j]!)))
        speeds[j]!.push(((2 * Math.acos(d) * 180) / Math.PI) * 60)
        prev[j]!.copy(q)
      })
    }
    return { names: bones.map((b) => b.name), speeds, meta }
  }, Math.round(seconds * 60))
  const rows: string[] = []
  const csv = ["frame,phase," + r.names.join(",")]
  for (let f = 0; f < r.meta.length; f++) csv.push(`${f},${r.meta[f]!.split(" ")[0]},${r.speeds.map((s) => s[f]!.toFixed(1)).join(",")}`)
  writeFileSync(`${out}/${name}.csv`, csv.join("\n"))
  let spikes = 0
  r.names.forEach((n, j) => {
    const s = r.speeds[j]!
    const sorted = [...s].sort((a, b) => a - b)
    const med = sorted[sorted.length >> 1]!
    const max = sorted[sorted.length - 1]!
    const lim = Math.max(4 * med, 400)
    const at = s.map((v, f) => (v > lim ? `f${f}@${r.meta[f]}:${v.toFixed(0)}` : "")).filter(Boolean)
    spikes += at.length
    if (/thigh|calf|foot|ball|pelvis|spine_01|upperarm|lowerarm|hand_/.test(n)) rows.push(`${n.padEnd(12)} med ${med.toFixed(0).padStart(4)} max ${max.toFixed(0).padStart(5)}  ${at.slice(0, 4).join(" ")}${at.length > 4 ? ` …+${at.length - 4}` : ""}`)
  })
  console.log(`== ${name}: ${spikes} spikes (deg/s; spike = > max(4×median, 400))\n${rows.join("\n")}`)
  await page.close()
}
await browser.close()
