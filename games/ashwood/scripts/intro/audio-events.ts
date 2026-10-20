// Intro drive sound check: plays the cutscene (`/?intro`, debug) with audio unlocked, taps Space a few times during
// the drive (short presses: below the 1 s hold-to-skip) and logs every outdoor night one-shot that fires while the
// player is seated, plus any footstep/jump sound and whether the player moved. Then lists the same night log for 60 s
// on foot afterwards, for the rate outside the car. One headless browser (1280×720), closed at the end. Dev server on
// :5196.
//
//   bun scripts/intro/audio-events.ts
import { chromium } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"],
})
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.routeWebSocket(/.*/, () => {})
  await page.goto("http://localhost:5196/?view=road&intro&night=4")
  await page.waitForFunction(() => !!(globalThis as { __ashwoodIntro?: unknown }).__ashwoodIntro, null, { timeout: 300_000 })
  type Snap = { time: number; total: number; seated: boolean; night: { t: number; id: string; d: number; muffled: boolean }[]; played: Record<string, number>; pos: { x: number; y: number; z: number } }
  const snap = () =>
    page.evaluate(() => {
      const g = globalThis as unknown as {
        __ashwoodIntro: { time: number; total: number }
        __ashwoodPlayer: { locomotion: boolean; pos: { x: number; y: number; z: number } }
        __ashwoodAudio: { ambience: { night: { log: { t: number; id: string; d: number; muffled: boolean }[] } }; sfx: { stats: { played: Record<string, number> } } }
      }
      return {
        time: g.__ashwoodIntro.time,
        total: g.__ashwoodIntro.total,
        seated: !g.__ashwoodPlayer.locomotion,
        night: [...g.__ashwoodAudio.ambience.night.log],
        played: { ...g.__ashwoodAudio.sfx.stats.played },
        pos: { ...g.__ashwoodPlayer.pos },
      }
    }) as Promise<Snap>
  // A click unlocks the audio (a key could be read by the cutscene).
  await page.mouse.click(640, 360)
  const start = await snap()
  console.log(`intro: ${start.total.toFixed(0)} s, seated ${start.seated}`)
  const steps = (p: Record<string, number>) => Object.entries(p).filter(([k]) => k.startsWith("foot-")).reduce((s, [, n]) => s + n, 0)
  const steps0 = steps(start.played)
  let s = start
  let taps = 0
  while (s.seated && s.time < s.total + 5) {
    await page.waitForTimeout(4000)
    if (taps < 4 && s.time > 8) {
      await page.keyboard.down("Space")
      await page.waitForTimeout(150)
      await page.keyboard.up("Space")
      taps++
    }
    s = await snap()
  }
  const drive = s.night
  const seatedSteps = steps(s.played) - steps0
  console.log(`seated drive: ${s.time.toFixed(0)} s, ${taps} Space taps → ${seatedSteps} footstep/jump sounds, cutscene ${s.time < s.total ? "skipped early!" : "played through"}`)
  console.log(`night one-shots while seated: ${drive.length}`)
  for (const e of drive) console.log(`  ${e.t.toFixed(1).padStart(6)} s  ${e.id.padEnd(16)} ${String(e.d).padStart(4)} m  ${e.muffled ? "muffled" : ""}`)
  // On foot: 60 s standing by the car.
  const n0 = s.night.length
  await page.waitForTimeout(60_000)
  const after = (await snap()).night.slice(n0)
  const count = (id: string) => after.filter((e) => e.id === id).length
  console.log(`on foot, 60 s: ${after.length} night one-shots (rustle ${count("out-rustle")}, creak ${count("out-creak")}, twig ${count("out-twig")}, cone ${count("out-cone")}, owl ${count("out-owl")})`)
  console.log(errors.length ? `page errors: ${errors.slice(0, 3).join(" | ")}` : "no page errors")
} finally {
  await browser.close()
}
