import { SPEED, SPRINT_SPEED } from "../shared/config"
import { animate, newAvatar } from "../src/game/anim"
import { animation } from "../src/game/anim-settings"
import { at, type Frame } from "../src/game/rig"
import { RIG } from "../src/render/person"

const dt = 1 / 60, warmup = 120, count = 600
const pitch = (f: Frame) => Math.atan2(f.x[1], Math.hypot(f.x[0], f.x[2])) * 180 / Math.PI
const results = []
for (const variant of ["old", "current", "refined"]) for (const speed of [1.4, SPEED, SPRINT_SPEED]) {
  animation.animationMode = variant === "old" ? "old" : "new"
  animation.runPosture = variant === "current" ? 0 : 0.18
  const a = newAvatar("running", 0, 0, 0, "rifle")
  const sums = { pelvisPitch: 0, chestPitch: 0, rootLean: 0, headForward: 0, pelvisForward: 0, pelvisHeight: 0 }
  let steps = 0, maxToeSlip = 0
  for (let n = 0; n < warmup + count; n++) {
    const previous = a.body
    const planted = a.feet.map(f => f.planted)
    animate(a, dt, n * dt, n * speed * dt, 0, speed, 0, 0)
    if (n < warmup) continue
    const b = a.body!
    sums.pelvisPitch += pitch(b.pelvis); sums.chestPitch += pitch(b.torso)
    sums.rootLean += a.leanX.x; sums.headForward += b.head.p[0] - a.x
    sums.pelvisForward += b.pelvis.p[0] - a.x; sums.pelvisHeight += b.pelvis.p[1]
    for (let i = 0; i < 2; i++) {
      if (!planted[i] && a.feet[i]!.planted) steps++
      if (previous && planted[i] && a.feet[i]!.planted) {
        const before = at(previous.ft[i]!, 0.19, -RIG.ankle, 0), after = at(b.ft[i]!, 0.19, -RIG.ankle, 0)
        maxToeSlip = Math.max(maxToeSlip, Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]))
      }
    }
  }
  results.push({ variant, speed, ...Object.fromEntries(Object.entries(sums).map(([key, sum]) => [key, sum / count])),
    stepsPerMinute: steps / (count * dt) * 60, maxToeSlip })
}
console.log(JSON.stringify({ dt, warmupSeconds: warmup * dt, sampledSeconds: count * dt, results }, null, 2))
