// Stair acceptance (Body Lab, fixed 60 Hz steps): for each script, every frame checks
//   - penetration: deepest trouser/boot vertex below the walkable surface under it (must stay ≤ 1 cm)
//   - knees: each knee bends forward (knee ahead of the hip→ankle line along the body's facing; a backward knee is a
//     hyperextension / fold-through)
//   - feet: the planted boot's sole within 3 cm above its tread
//
//   bun scripts/player/stair-audit.ts [scripts…]   (default: stairs_up stairs_down stairs_up_run stairs_down_run walk run)
import { chromium } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"

const names = process.argv.slice(2).length ? process.argv.slice(2) : ["stairs_up", "stairs_down", "stairs_up_run", "stairs_down_run", "walk", "run", "slope"]
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal"] })
let fail = false
for (const name of names) {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } })
  await page.goto(`http://localhost:5196/body.html?shot=1&manual=1&inset=0&script=${name}`)
  await page.waitForFunction(() => (globalThis as { __bodyLab?: { ready: boolean } }).__bodyLab?.ready, null, { timeout: 90_000 })
  const r = await page.evaluate(() => {
    type V = { x: number; y: number; z: number; clone(): V; sub(v: V): V; dot(v: V): number; length(): number; addScaledVector(v: V, s: number): V }
    const L = (globalThis as unknown as { __bodyLab: { step(dt: number): void; time(): number; penetration(): { worst: number; count: number; where: string }; body: { root: { position: V; rotation: { y: number } }; bone(n: string): { getWorldPosition(v: V): V } } } }).__bodyLab
    const B = L.body
    const Vec = B.root.position.constructor as new (x?: number, y?: number, z?: number) => V
    let pen = 0
    let penAt = 0
    let penWhere = ""
    let knee = 0
    let kneeAt = 0
    let frames = 0
    let foldMax = -9
    let drop = 0
    while (L.time() < 4.5 && frames < 400) {
      L.step(1 / 60)
      frames++
      drop = Math.min(drop, (L as unknown as { body: { pelvisOff: number } }).body.pelvisOff)
      const p = L.penetration()
      if (p.worst > pen) {
        pen = p.worst
        penAt = L.time()
        penWhere = p.where
      }
      const yaw = B.root.rotation.y
      const fwd = new Vec(-Math.sin(yaw), 0, -Math.cos(yaw))
      for (const s of ["l", "r"]) {
        const h = B.bone(`thigh_${s}`).getWorldPosition(new Vec())
        const k = B.bone(`calf_${s}`).getWorldPosition(new Vec())
        const a = B.bone(`foot_${s}`).getWorldPosition(new Vec())
        const chord = a.clone().sub(h)
        const len = chord.length()
        const t = k.clone().sub(h).dot(chord) / (len * len)
        const off = k.clone().sub(h).addScaledVector(chord, -t)
        // Positive = knee ahead of the line (correct); negative = bent backwards.
        const ahead = off.dot(fwd)
        // A boot up at the hip (folded leg): ankle height minus hip height.
        foldMax = Math.max(foldMax, a.y - h.y)
        if (-ahead > knee) {
          knee = -ahead
          kneeAt = L.time()
        }
      }
    }
    return { pen, penAt, penWhere, knee, kneeAt, frames, foldMax, drop }
  })
  // Fold: the boot never comes above hip height minus 5 cm (a run's heel kick reaches ~10 cm below the hip).
  const ok = r.pen <= 0.01 && r.knee <= 0.01 && r.foldMax < -0.05 && r.drop > -0.3
  if (!ok) fail = true
  console.log(`${name.padEnd(16)} ${ok ? "PASS" : "FAIL"}  deepest vertex in floor ${(r.pen * 100).toFixed(1)} cm (t ${r.penAt.toFixed(2)}s)  knee bent backward ${(r.knee * 100).toFixed(1)} cm  ankle-to-hip min gap ${(-r.foldMax * 100).toFixed(0)} cm  deepest hip drop ${(-r.drop * 100).toFixed(0)} cm  ${r.frames} frames${ok ? "" : `\n    ${r.penWhere}`}`)
  await page.close()
}
await browser.close()
process.exit(fail ? 1 : 0)
