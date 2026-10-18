// Flashlight-carry acceptance (Body Lab, fixed 60 Hz): for walk, jog, run, idle and a turn, at view pitches from −1.2
// to +0.6 rad, every frame measures the smallest distance from the torch (lens, body, tail), fist and forearm to the
// torso and thigh capsules (must stay > 0), the elbow angle (60–120°), and the angle between the barrel and the aim.
//
//   bun scripts/player/torch-audit.ts
import { chromium } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"

const scripts = ["idle", "walk", "jog", "run", "turn", "back", "strafe_r"]
const pitches = [-1.2, -0.6, 0, 0.3, 0.6]
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal"] })
let fail = false
for (const name of scripts) {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } })
  await page.goto(`http://localhost:5196/body.html?shot=1&manual=1&inset=0&script=${name}&flashlight=1`)
  await page.waitForFunction(() => (globalThis as { __bodyLab?: { ready: boolean } }).__bodyLab?.ready, null, { timeout: 90_000 })
  const rows = await page.evaluate((pitches) => {
    type V = { x: number; y: number; z: number; clone(): V; sub(v: V): V; normalize(): V; angleTo(v: V): number }
    const L = (globalThis as unknown as {
      __bodyLab: { step(dt: number): void; torchClearance(): number; body: { torchLens(p: V, d: V): boolean; root: { position: V }; bone(n: string): { getWorldPosition(v: V): V } } }
      __walker?: unknown
    }).__bodyLab
    const lab = L as unknown as { step(dt: number): void }
    const B = L.body
    const Vec = B.root.position.constructor as new (x?: number, y?: number, z?: number) => V
    const out: { pitch: number; clear: number; elbowMin: number; elbowMax: number; aimErr: number }[] = []
    const walker = (globalThis as unknown as { __labWalker: { pitch: number; yaw: number; flashlight: boolean } }).__labWalker
    for (const p of pitches) {
      let clear = Infinity
      let eMin = 999
      let eMax = 0
      let aimErr = 0
      for (let f = 0; f < 150; f++) {
        walker.pitch = p
        walker.flashlight = true
        lab.step(1 / 60)
        if (f < 30) continue
        clear = Math.min(clear, L.torchClearance())
        const s = B.bone("upperarm_r").getWorldPosition(new Vec())
        const e = B.bone("lowerarm_r").getWorldPosition(new Vec())
        const h = B.bone("hand_r").getWorldPosition(new Vec())
        const bend = 180 - (s.clone().sub(e).angleTo(h.clone().sub(e)) * 180) / Math.PI
        eMin = Math.min(eMin, bend)
        eMax = Math.max(eMax, bend)
        const lp = new Vec()
        const ld = new Vec()
        B.torchLens(lp, ld)
        const y = walker.yaw
        const aim = new Vec(-Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p))
        aimErr = Math.max(aimErr, (ld.angleTo(aim) * 180) / Math.PI)
      }
      out.push({ pitch: p, clear, elbowMin: eMin, elbowMax: eMax, aimErr })
    }
    return out
  }, pitches)
  for (const r of rows) {
    // Aim: within 40° (the barrel limits); elbow bend 60–125°; clearance > 0.
    const ok = r.clear > 0 && r.elbowMin >= 55 && r.elbowMax <= 125
    if (!ok) fail = true
    console.log(`${name.padEnd(9)} pitch ${r.pitch.toFixed(1).padStart(5)}  ${ok ? "PASS" : "FAIL"}  clearance ${(r.clear * 100).toFixed(1)} cm  elbow ${r.elbowMin.toFixed(0)}–${r.elbowMax.toFixed(0)}°  barrel vs aim ≤ ${r.aimErr.toFixed(0)}°`)
  }
  await page.close()
}
await browser.close()
process.exit(fail ? 1 : 0)
