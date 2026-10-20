// Stills from the debug world at chosen poses (stepped clock, fly camera), for scouting trailer shots.
//   bun scripts/trailer/probe.ts "<query>" "x,y,z,yaw,pitch[,flash]" ... [--tag t] [--story 3-08] [--settle 40]
// y is the eye height in world metres. Output captures/trailer/probe-<tag>/NNNNN.jpg.
import { ROOT, Recorder, launch, open, run, waitWorld, type Any } from "./lib"

const args = process.argv.slice(2)
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`)
  if (i < 0) return undefined
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}
const tag = flag("tag") ?? "probe"
const story = flag("story")
const settle = Number(flag("settle") ?? 40)
const [query, ...poses] = args
const browser = await launch()
try {
  const { page, errors, cdp } = await open(browser, `http://localhost:5196/?${query}${story ? `&story=${story}` : ""}`, (p) => waitWorld(p, "__ashwoodPlayer"))
  if (story) await page.waitForTimeout(6000)
  const rec = new Recorder(page, cdp, `${ROOT}/probe-${tag}`)
  await rec.start()
  for (const s of poses) {
    const parts = s.split(",")
    const ground = parts[1]!.startsWith("g")
    const [x, y, z, yaw, pitch, flash] = parts.map((v) => Number(v.replace(/^g/, ""))) as number[]
    await run(page, (a: number[]) => {
      const P = (globalThis as Any).__ashwoodPlayer
      const T = (globalThis as Any).__trailer
      const S = (globalThis as Any).__ashwoodRender?.settings
      if (S) S["body.show"] = false
      if (a[6]) a[1] = a[1]! + P.groundAt(a[0], a[2], 999)
      P.fly = true
      if (a[5] !== undefined && !Number.isNaN(a[5])) P.flashlight = !!a[5]
      T.hooks = [
        () => {
          P.pos.x = a[0]
          P.pos.y = a[1] - 1.65
          P.pos.z = a[2]
          P.yaw = a[3]
          P.pitch = a[4]
          P.vel.x = P.vel.y = P.vel.z = 0
        },
      ]
    }, [x!, y!, z!, yaw!, pitch!, flash!, ground ? 1 : 0])
    await rec.advance(settle)
    await rec.record(1)
    console.log(s, "->", rec.n - 1)
  }
  if (errors.length) console.log(errors.slice(0, 5))
} finally {
  await browser.close()
}
Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", "-i", `${ROOT}/probe-${tag}/%05d.jpg`, "-vf", "scale=640:-1,tile=2x4", "-frames:v", "1", `${ROOT}/probe-${tag}-sheet.jpg`])
