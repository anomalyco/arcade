import { writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { extractBonePoseJoints, type RigJointMap } from "@arcade/kit/pose-diff"
import type { HumanBody } from "@arcade/kit/human-pose"
import { at, dot, RIG, type Frame, type V3 } from "@arcade/kit/rig"
import { parseArgs, repoRoot } from "./common"

// Outbreak survivor legs under WASD + mouse, the way the sim moves them: instant 8-way velocity at walk 3.4,
// sprint 5.6 and crouch 1.7 m/s, with the aim free. One scripted sequence (turn in place, starts and stops,
// strafes, backpedal, diagonals, a circle strafe, sprint, crouch-walk, speed changes, an aim sweep) measured per
// segment: ground skate, leg overstretch, leg intersections, knee pop, hip/torso twist, stride, cadence and how
// the hips blend between directions. `--baseline <checkout>` also runs another checkout's survivor as `before`.
//
//   bun games/blackout/scripts/animation/survivor-legs.ts --tag after [--baseline <checkout>] [--item pistol|none] [--no-render]
const { tag, out: OUT_DIR, values, flags } = parseArgs(process.argv.slice(2), { tag: "after", out: "survivor-legs" })
const dt = 1 / 60
const DEG = 180 / Math.PI
const WALK = 3.4, SPRINT = 5.6, CROUCH = 1.7
const item = values.item === "none" ? undefined : "pistol"
const actorKind = (values.actor ?? "outbreak") as "outbreak" | "blackout-survivor" | "soldier"

type Input = { mx: number; my: number; speed: number; aim: number; aiming?: boolean; crouching?: boolean; sprinting?: boolean }
type Segment = { name: string; seconds: number; input: (t: number, x: number, y: number) => Input }
const still = (aim: number): Input => ({ mx: 0, my: 0, speed: 0, aim })
const move = (dir: number, aim: number, speed = WALK, extra: Partial<Input> = {}): Input => ({ mx: Math.cos(dir), my: Math.sin(dir), speed, aim, ...extra })
const D = Math.PI / 4
// Aim 0 faces +X; plan +Y (+Z in the world) is the survivor's right, as in the sim.
const SEGMENTS: Segment[] = [
  { name: "idle", seconds: 1, input: () => still(0) },
  { name: "flick 180", seconds: 1.6, input: t => still(Math.PI * Math.min(1, t / 0.35)) },
  { name: "turn 360 slow", seconds: 4, input: t => still(Math.PI + Math.PI * 2 * Math.min(1, t / 3.5)) },
  { name: "start fwd", seconds: 0.8, input: () => move(Math.PI, Math.PI) },
  { name: "fwd", seconds: 1.4, input: () => move(Math.PI, Math.PI) },
  { name: "stop", seconds: 1.2, input: () => still(Math.PI) },
  { name: "strafe R", seconds: 2, input: () => move(-Math.PI / 2, Math.PI, WALK, { aiming: true }) },
  { name: "stop strafe", seconds: 1, input: () => still(Math.PI) },
  { name: "strafe L", seconds: 2, input: () => move(Math.PI / 2, Math.PI, WALK, { aiming: true }) },
  { name: "backpedal", seconds: 2, input: () => move(0, Math.PI, WALK, { aiming: true }) },
  { name: "diag fwd-R", seconds: 1.4, input: () => move(Math.PI + D, Math.PI, WALK, { aiming: true }) },
  { name: "diag back-R", seconds: 1.4, input: () => move(-D, Math.PI, WALK, { aiming: true }) },
  { name: "diag back-L", seconds: 1.4, input: () => move(D, Math.PI, WALK, { aiming: true }) },
  { name: "diag fwd-L", seconds: 1.4, input: () => move(Math.PI - D, Math.PI, WALK, { aiming: true }) },
  { name: "R↔L reversals", seconds: 2.4, input: t => move(Math.floor(t / 0.6) % 2 ? Math.PI / 2 : -Math.PI / 2, Math.PI, WALK, { aiming: true }) },
  { name: "circle strafe", seconds: 6, input: (_t, x, y) => circle(x, y) },
  { name: "sprint", seconds: 1.6, input: () => move(Math.PI, Math.PI, SPRINT, { sprinting: true }) },
  { name: "sprint strafe", seconds: 1.4, input: () => move(Math.PI / 2, Math.PI, SPRINT, { sprinting: true }) },
  { name: "walk→sprint→walk", seconds: 2.4, input: t => move(Math.PI, Math.PI, t > 0.8 && t < 1.6 ? SPRINT : WALK) },
  { name: "crouch fwd", seconds: 1.6, input: () => move(Math.PI, Math.PI, CROUCH, { crouching: true }) },
  { name: "crouch strafe", seconds: 1.6, input: () => move(-Math.PI / 2, Math.PI, CROUCH, { crouching: true, aiming: true }) },
  { name: "aim sweep running", seconds: 5, input: t => move(Math.PI, Math.PI - Math.PI * 2 * t / 5, WALK, { aiming: true }) },
  { name: "final stop", seconds: 1.2, input: () => still(Math.PI) },
]
// Circle strafe around a point 2.4 m away, anticlockwise, aiming at it (render-strafe-video.ts uses the same rule).
let centre: [number, number] | null = null
function circle(x: number, y: number): Input {
  if (!centre) centre = [x, y + 2.4]
  const dx = x - centre[0], dy = y - centre[1], r = Math.hypot(dx, dy) || 1
  let mx = -dy / r + (2.4 - r) * 1.5 * dx / r, my = dx / r + (2.4 - r) * 1.5 * dy / r
  const m = Math.hypot(mx, my) || 1
  mx /= m; my /= m
  return { mx, my, speed: WALK, aim: Math.atan2(-dy, -dx), aiming: true }
}

type SurvivorLike = { bones: Record<string, Frame | undefined>; draw(p: object, dt: number, t: number, support: (x: number, z: number) => number): unknown }
type Frame60 = { t: number; seg: number; x: number; y: number; vx: number; vy: number; aim: number; joints: RigJointMap; planted: [boolean, boolean]; sep: [number, number]; pelvisYaw: number; torsoYaw: number; footYaw: [number, number]; kneeSwivel: [number, number] }

type AnimModule = {
  newAvatar(id: string, x: number, y: number, aim: number, gun: string): { unarmed?: boolean; feet: { planted: boolean }[]; body?: HumanBody | null }
  animate(a: unknown, dt: number, now: number, x: number, y: number, vx: number, vy: number, aim: number, wizard?: boolean): number
}
/** Blackout's adapter (`animate` on the shared `locomotion` contact solver) behind the same `bones` interface. */
async function blackoutActor(root: string, unarmed: boolean): Promise<SurvivorLike & { feet: { planted: boolean }[] }> {
  const anim = await import(join(root, "packages/kit/avatar/anim.ts")) as AnimModule
  const a = anim.newAvatar("legs", 0, 0, 0, "rifle")
  a.unarmed = unarmed
  const actor = {
    bones: {} as Record<string, Frame | undefined>,
    feet: a.feet,
    draw(p: { x: number; y: number; vx: number; vy: number; aim: number }, dt: number, t: number) {
      anim.animate(a, dt, t, p.x, p.y, p.vx, p.vy, p.aim, false)
      const b = a.body!
      actor.bones = {
        pelvis: b.pelvis, torso: b.torso, head: b.head,
        "left.upperArm": b.ua[0], "right.upperArm": b.ua[1], "left.foreArm": b.fa[0], "right.foreArm": b.fa[1],
        "left.thigh": b.th[0], "right.thigh": b.th[1], "left.shin": b.sh[0], "right.shin": b.sh[1],
        "left.foot": b.ft[0], "right.foot": b.ft[1], "left.toe": b.toe?.[0], "right.toe": b.toe?.[1],
      }
    },
  }
  return actor
}

async function run(root: string): Promise<Frame60[]> {
  let s: SurvivorLike, feet: { planted: boolean }[]
  if (actorKind === "outbreak") {
    const mod = await import(join(root, "games/outbreak/src/survivor.ts")) as { Survivor: new (r: { addModel: () => number }) => SurvivorLike }
    s = new mod.Survivor({ addModel: () => 0 })
    // The shared-rig legs keep their contacts in `loco`; Today's (and older checkouts') in `feet`.
    const st = s as unknown as { feet: { planted: boolean }[]; loco?: { feet: { planted: boolean }[] }; aimTuning: { legs?: number } }
    if (values.legs !== undefined) st.aimTuning.legs = Number(values.legs)
    feet = st.loco && st.aimTuning.legs !== 0 ? st.loco.feet : st.feet
  } else {
    const b = await blackoutActor(root, actorKind === "blackout-survivor")
    s = b; feet = b.feet
  }
  centre = null
  const out: Frame60[] = []
  let x = 0, y = 0, t = 0
  SEGMENTS.forEach((seg, si) => {
    for (let n = 0; n < Math.round(seg.seconds / dt); n++) {
      const inp = seg.input(n * dt, x, y)
      const vx = inp.mx * inp.speed, vy = inp.my * inp.speed
      x += vx * dt; y += vy * dt; t += dt
      s.draw({ x, y, vx, vy, aim: inp.aim, equippedItem: item, aiming: Boolean(inp.aiming && item), crouching: inp.crouching, sprinting: inp.sprinting }, dt, t, () => 0)
      const b = s.bones
      const joints = extractBonePoseJoints(b as never)
      const yawOf = (f: Frame) => Math.atan2(f.x[2], f.x[0])
      const sep: [number, number] = [0, 0]
      const kneeSwivel: [number, number] = [0, 0]
      for (const i of [0, 1] as const) {
        const side = i ? "right" : "left"
        const shin = b[`${side}.shin`]!, foot = b[`${side}.foot`]!
        const end = at(shin, 0, -RIG.shin, 0)
        sep[i] = Math.hypot(end[0] - foot.p[0], end[1] - foot.p[1], end[2] - foot.p[2])
        // Knee direction around the hip→ankle axis, measured in the pelvis frame (0 = straight ahead of the hips).
        const hip = i ? joints.hipR : joints.hipL, knee = i ? joints.kneeR : joints.kneeL, ank = i ? joints.ankleR : joints.ankleL
        const ax: V3 = [ank[0] - hip[0], ank[1] - hip[1], ank[2] - hip[2]]
        const l2 = dot(ax, ax) || 1
        const u = ((knee[0] - hip[0]) * ax[0] + (knee[1] - hip[1]) * ax[1] + (knee[2] - hip[2]) * ax[2]) / l2
        const o: V3 = [knee[0] - hip[0] - ax[0] * u, knee[1] - hip[1] - ax[1] * u, knee[2] - hip[2] - ax[2] * u]
        const pel = b.pelvis!
        // A nearly straight leg has no defined knee direction; NaN marks it so knee pop ignores it.
        kneeSwivel[i] = Math.hypot(o[0], o[1], o[2]) > 0.04 ? Math.atan2(dot(o, pel.z), dot(o, pel.x)) : NaN
      }
      out.push({
        t, seg: si, x, y, vx, vy, aim: inp.aim, joints, planted: [feet[0]!.planted, feet[1]!.planted], sep,
        pelvisYaw: yawOf(b.pelvis!), torsoYaw: yawOf(b.torso!), footYaw: [yawOf(b["left.foot"]!), yawOf(b["right.foot"]!)], kneeSwivel,
      })
    }
  })
  return out
}

const wrap = (a: number) => {
  while (a > Math.PI) a -= Math.PI * 2
  while (a < -Math.PI) a += Math.PI * 2
  return a
}
const r1 = (n: number) => Math.round(n * 10) / 10
const mean = (xs: number[]) => xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0
const maxOf = (xs: number[]) => xs.reduce((m, v) => Math.max(m, v), 0)
function segDist(p1: V3, q1: V3, p2: V3, q2: V3): number {
  const d1: V3 = [q1[0] - p1[0], q1[1] - p1[1], q1[2] - p1[2]], d2: V3 = [q2[0] - p2[0], q2[1] - p2[1], q2[2] - p2[2]]
  const r: V3 = [p1[0] - p2[0], p1[1] - p2[1], p1[2] - p2[2]]
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r), c = dot(d1, r), b = dot(d1, d2), den = a * e - b * b
  let s = den > 1e-9 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0
  let t = (b * s + f) / e
  if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)) } else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)) }
  return Math.hypot(r[0] + d1[0] * s - d2[0] * t, r[1] + d1[1] * s - d2[1] * t, r[2] + d1[2] * s - d2[2] * t)
}
const heel = (ank: V3, ball: V3): V3 => {
  const fx = ball[0] - ank[0], fz = ball[2] - ank[2], l = Math.hypot(fx, fz) || 1
  return [ank[0] - fx / l * RIG.heel, Math.max(0, ank[1] - RIG.ankle), ank[2] - fz / l * RIG.heel]
}

/** Metrics over a frame range. Skate is the ball's ground travel while it is within 1.5 cm of the floor. */
function metrics(fr: Frame60[]) {
  const skates: number[] = [], skateRun = [0, 0], onGround = [false, false]
  const touchdowns: { i: number; t: number; p: V3 }[] = []
  const shinGap: number[] = [], thighShin: number[] = [], footGap: number[] = []
  let shinHit = 0, footHit = 0
  const sep: number[] = [], kneeRate: number[] = [], pelvisRate: number[] = [], pelvisAcc: number[] = []
  const pelvisVsAim: number[] = [], torsoVsPelvis: number[] = [], footVsTravel: number[] = [], footVsPelvis: number[] = []
  const stepDir: number[] = [], liftoff: (V3 | null)[] = [null, null]
  let dist = 0
  for (let k = 0; k < fr.length; k++) {
    const f = fr[k]!, j = f.joints, prev = fr[k - 1]
    if (prev) dist += Math.hypot(f.x - prev.x, f.y - prev.y)
    const speed = Math.hypot(f.vx, f.vy), travel = Math.atan2(f.vy, f.vx)
    for (const i of [0, 1] as const) {
      const ball = i ? j.ballR : j.ballL, pb = prev ? (i ? prev.joints.ballR : prev.joints.ballL) : ball
      const down = ball[1] < 0.015
      if (down && onGround[i] && prev) skateRun[i]! += Math.hypot(ball[0] - pb[0], ball[2] - pb[2])
      if (!down && onGround[i]) { skates.push(skateRun[i]!); skateRun[i] = 0 }
      onGround[i] = down
      sep.push(f.sep[i])
      if (prev && Number.isFinite(f.kneeSwivel[i]) && Number.isFinite(prev.kneeSwivel[i])) kneeRate.push(Math.abs(wrap(f.kneeSwivel[i] - prev.kneeSwivel[i])) / dt * DEG)
      if (f.planted[i] && prev && !prev.planted[i]) {
        touchdowns.push({ i, t: f.t, p: [...(i ? j.ankleR : j.ankleL)] as V3 })
        const lo = liftoff[i], p = i ? j.ankleR : j.ankleL
        if (lo && speed > 0.5 && Math.hypot(p[0] - lo[0], p[2] - lo[2]) > 0.1) stepDir.push(Math.abs(wrap(Math.atan2(p[2] - lo[2], p[0] - lo[0]) - travel)) * DEG)
      }
      if (!f.planted[i] && prev?.planted[i]) liftoff[i] = [...(i ? j.ankleR : j.ankleL)] as V3
      if (f.planted[i] && speed > 0.5) {
        const back = Math.abs(wrap(travel - f.pelvisYaw)) > Math.PI / 2
        footVsTravel.push(Math.abs(wrap(f.footYaw[i] - (back ? travel + Math.PI : travel))) * DEG)
      }
      if (f.planted[i]) footVsPelvis.push(Math.abs(wrap(f.footYaw[i] - f.pelvisYaw)) * DEG)
    }
    const sg = segDist(j.kneeL, j.ankleL, j.kneeR, j.ankleR)
    shinGap.push(sg); if (sg < 0.12) shinHit++
    thighShin.push(Math.min(segDist(j.hipL, j.kneeL, j.kneeR, j.ankleR), segDist(j.hipR, j.kneeR, j.kneeL, j.ankleL)))
    const fg = segDist(heel(j.ankleL, j.ballL), j.toeL, heel(j.ankleR, j.ballR), j.toeR)
    footGap.push(fg); if (fg < 0.12) footHit++
    pelvisVsAim.push(Math.abs(wrap(f.pelvisYaw - f.aim)) * DEG)
    torsoVsPelvis.push(Math.abs(wrap(f.torsoYaw - f.pelvisYaw)) * DEG)
    if (prev) pelvisRate.push(wrap(f.pelvisYaw - prev.pelvisYaw) / dt * DEG)
  }
  for (let k = 1; k < pelvisRate.length; k++) pelvisAcc.push(Math.abs(pelvisRate[k]! - pelvisRate[k - 1]!) / dt)
  const steps = touchdowns.length, span = fr.length * dt
  return {
    steps,
    cadence: r1(steps / span * 60),
    stepLengthCm: r1(steps ? dist / steps * 100 : 0),
    skateMeanCm: r1(mean(skates) * 100),
    skateMaxCm: r1(maxOf(skates) * 100),
    overstretchMaxCm: r1(maxOf(sep) * 100),
    shinHitPct: r1(100 * shinHit / fr.length),
    footHitPct: r1(100 * footHit / fr.length),
    minShinGapCm: r1(Math.min(...shinGap) * 100),
    minThighShinCm: r1(Math.min(...thighShin) * 100),
    minFootGapCm: r1(Math.min(...footGap) * 100),
    kneePopDps: r1(maxOf(kneeRate)),
    pelvisVsAimDeg: r1(mean(pelvisVsAim)),
    torsoVsPelvisDeg: r1(mean(torsoVsPelvis)),
    footVsTravelDeg: r1(mean(footVsTravel)),
    footVsPelvisMaxDeg: r1(maxOf(footVsPelvis)),
    stepDirErrDeg: r1(mean(stepDir)),
    maxPelvisRateDps: r1(maxOf(pelvisRate.map(Math.abs))),
    maxPelvisAccDps2: Math.round(maxOf(pelvisAcc)),
  }
}
export type LegMetrics = ReturnType<typeof metrics>

function report(frames: Frame60[]) {
  const bySeg = SEGMENTS.map((s, i) => ({ name: s.name, ...metrics(frames.filter(f => f.seg === i)) }))
  return { segments: bySeg, total: metrics(frames) }
}

const passes: { tag: string; frames: Frame60[] }[] = []
if (values.baseline) passes.push({ tag: "before", frames: await run(resolve(values.baseline)) })
passes.push({ tag, frames: await run(repoRoot) })

const COLS = ["cadence", "stepLengthCm", "skateMaxCm", "overstretchMaxCm", "shinHitPct", "minShinGapCm", "footHitPct", "kneePopDps", "pelvisVsAimDeg", "torsoVsPelvisDeg", "footVsTravelDeg", "footVsPelvisMaxDeg", "stepDirErrDeg", "maxPelvisRateDps"] as const
const result: Record<string, ReturnType<typeof report>> = {}
for (const p of passes) {
  const r = result[p.tag] = report(p.frames)
  console.log(`\n=== legs (${actorKind}, ${p.tag}, item ${item ?? "none"}) ===`)
  console.log("".padEnd(20), COLS.map(c => c.replace(/Pct|Deg|Cm|Dps|Max/g, "").slice(0, 8).padStart(8)).join(" "))
  for (const s of [...r.segments, { name: "TOTAL", ...r.total }]) console.log(s.name.padEnd(20), COLS.map(c => String(s[c]).padStart(8)).join(" "))
}
const stem = `survivor-legs-${actorKind}-${item ?? "none"}`
writeFileSync(join(OUT_DIR, `${stem}-${tag}.json`), JSON.stringify({ item, segments: SEGMENTS.map(s => s.name), result }))
// Frames for the game-camera stick render: joints rounded to mm.
const q = (v: V3) => v.map(n => Math.round(n * 1000) / 1000)
writeFileSync(join(OUT_DIR, `${stem}-frames.json`), JSON.stringify({
  segments: SEGMENTS.map(s => s.name),
  passes: passes.map(p => ({ tag: p.tag, frames: p.frames.map(f => ({ seg: f.seg, x: f.x, y: f.y, aim: f.aim, vx: f.vx, vy: f.vy, planted: f.planted, j: Object.fromEntries(Object.entries(f.joints).map(([k, v]) => [k, q(v as V3)])) })) })),
}))
console.log(`Saved ${join(OUT_DIR, stem)}-*.json`)
if (!flags.has("no-render")) {
  const py = spawnSync("python3", [join(import.meta.dir, "survivor-legs-render.py"), OUT_DIR, stem, ...(flags.has("video") ? ["--video"] : [])], { stdio: "inherit" })
  if (py.status !== 0) process.exit(py.status ?? 1)
}
