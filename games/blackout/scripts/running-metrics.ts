import { SPEED, SPRINT_SPEED } from "../shared/config"
import { animate, gunPoints, newAvatar } from "../src/game/anim"
import { animation } from "../src/game/anim-settings"
import { at, dot, type Frame } from "../src/game/rig"
import { HIP, RIG } from "../src/render/person"

const dt = 1 / 60, warmup = 120, count = 600
const pitch = (f: Frame) => Math.atan2(f.x[1], Math.hypot(f.x[0], f.x[2])) * 180 / Math.PI
const defaults = { ...animation }
const results = []
for (const variant of ["old", "current", "refined"] as const) for (const speed of [1.4, SPEED, SPRINT_SPEED]) {
  Object.assign(animation, defaults)
  animation.animationMode = variant === "old" ? "old" : "new"
  if (variant === "current") { animation.runPosture = 0; animation.crouchDepth = 0 }
  const a = newAvatar("running", 0, 0, 0, "rifle")
  const sums = { pelvisPitch: 0, chestPitch: 0, headPitch: 0, rootLean: 0, headForward: 0, pelvisForward: 0, pelvisHeight: 0, crouchDropCm: 0, kneeBendDeg: 0, gunFromShoulderX: 0 }
  let steps = 0, maxToeSlip = 0
  for (let n = 0; n < warmup + count; n++) {
    const previous = a.body
    const planted = a.feet.map(f => f.planted)
    animate(a, dt, n * dt, n * speed * dt, 0, speed, 0, 0)
    if (n < warmup) continue
    const b = a.body!, sh = at(b.torso, 0, RIG.shoulderY, 0), gp = gunPoints(a)
    sums.pelvisPitch += pitch(b.pelvis); sums.chestPitch += pitch(b.torso); sums.headPitch += pitch(b.head)
    sums.rootLean += a.leanX.x; sums.headForward += b.head.p[0] - a.x
    sums.pelvisForward += b.pelvis.p[0] - a.x; sums.pelvisHeight += b.pelvis.p[1]
    sums.crouchDropCm += (HIP - b.pelvis.p[1]) * 100
    sums.gunFromShoulderX += (b.gun?.p[0] ?? sh[0]) - sh[0]
    for (let i = 0; i < 2; i++) {
      sums.kneeBendDeg += Math.acos(Math.max(-1, Math.min(1, dot(b.th[i]!.y, b.sh[i]!.y)))) * 90 / Math.PI
      if (!planted[i] && a.feet[i]!.planted) steps++
      if (previous && planted[i] && a.feet[i]!.planted) {
        const before = at(previous.ft[i]!, 0.19, -RIG.ankle, 0), after = at(b.ft[i]!, 0.19, -RIG.ankle, 0)
        maxToeSlip = Math.max(maxToeSlip, Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]))
      }
    }
    void gp
  }
  results.push({ variant, speed, ...Object.fromEntries(Object.entries(sums).map(([key, sum]) => [key, sum / count])),
    stepsPerMinute: steps / (count * dt) * 60, maxToeSlip })
}
Object.assign(animation, defaults)
console.log(JSON.stringify({ dt, warmupSeconds: warmup * dt, sampledSeconds: count * dt, results }, null, 2))
