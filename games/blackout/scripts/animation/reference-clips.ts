// Pose-diff of our procedural gaits against openly licensed reference clips (100STYLE mocap, CC BY 4.0, and
// Quaternius UAL keyframed game clips, CC0), so we can see where the walk, run, zombie shamble and sneak differ
// most. With --bake it also writes the reference cycles the Characters page's Lab-only reference ghost plays.
//
//   bun games/blackout/scripts/animation/reference-clips.ts [--tag after] [--out dir] [--no-render] [--bake]
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { animate, newAvatar } from "../../src/game/anim"
import { GUNPTS } from "../../src/render/person"
import { humanProfiles, type HumanProfile } from "@arcade/kit/human-profile"
import { poseLegs, poseUnarmedArms, unarmedHands } from "@arcade/kit/human-pose"
import {
  buildCycleFromJointFrames,
  compareCycles,
  extractBodyJoints,
  extractBonePoseJoints,
  POSE_JOINTS,
  RIG_SEGMENTS,
  type CycleComparison,
  type CycleData,
  type RigJointMap,
} from "@arcade/kit/pose-diff"
import { extractAsymmetricBvhCycle } from "@arcade/kit/shamble-crouch"
import { RIG } from "@arcade/kit/rig"
import { createAIAgent } from "@arcade/kit/sim/ai"
import { Survivor as OutbreakSurvivor } from "../../../outbreak/src/survivor"
import { ZombieCrowdRenderer } from "../../../outbreak/src/zombies"
import { BehaviourPoser } from "../../../outbreak/src/behaviour/pose"
import { zombiePersonality } from "../../../outbreak/shared/behaviour/personality"
import { zombieTuning } from "../../../outbreak/src/zombie-profile"
import { parseArgs, repoRoot } from "./common"
import {
  OPEN_MOCAP_CREDITS,
  clipGroundSpeed,
  findSteadyWindow,
  load100Style,
  loadUal,
  normaliseClip,
  parse100Style,
  ualClip,
} from "./open-mocap"

const dt = 1 / 60
const r2 = (n: number) => Math.round(n * 100) / 100

// ------------------------------------------------------------------------------------------------ our gaits
function cycleFrom(name: string, mode: "walk" | "run", speed: number, joints: RigJointMap[], planted: boolean[], warmup = 180): CycleData {
  const touch: number[] = []
  for (let n = warmup; n < joints.length; n++) if (!planted[n - 1] && planted[n]) touch.push(n)
  const a = touch[1] ?? touch[0] ?? warmup
  const b = touch[2] ?? a + (mode === "walk" ? 56 : 30)
  const slice = joints.slice(a, Math.max(a + 8, b))
  return buildCycleFromJointFrames(name, mode, speed, slice.length * dt, slice, 0)
}

function blackout(name: string, mode: "walk" | "run", speed: number, profile: HumanProfile, unarmed: boolean): CycleData {
  const a = newAvatar(name, 0, 0, 0, "rifle")
  a.profile = { ...profile, stepVariation: 0 }
  a.unarmed = unarmed
  const joints: RigJointMap[] = [], planted: boolean[] = []
  let x = 0
  for (let n = 0; n < 480; n++) {
    const t = n * dt
    x += speed * dt
    animate(a, dt, t, x, 0, speed, 0, 0, false)
    const b = a.body!
    if (unarmed) {
      const legs = poseLegs(a as never, b.pelvis)
      b.th = legs.th; b.sh = legs.sh; b.ft = legs.ft
      if (legs.toe) b.toe = legs.toe
      const [hL, hR] = unarmedHands(a, b.torso, t * 2)
      const arms = poseUnarmedArms(b.torso, hL, hR)
      b.ua = arms.ua; b.fa = arms.fa; b.gun = null
    }
    joints.push(extractBodyJoints(b, b.gun, GUNPTS.rifle.muzzle))
    planted.push(a.feet[0].planted)
  }
  return cycleFrom(name, mode, speed, joints, planted)
}

function outbreakSurvivor(name: string, mode: "walk" | "run", speed: number, crouching = false): CycleData {
  const s = new OutbreakSurvivor({ addModel: () => 0 })
  s.profile = { ...humanProfiles.soldier, stepVariation: 0 }
  const joints: RigJointMap[] = [], planted: boolean[] = []
  let x = 0
  for (let n = 0; n < 480; n++) {
    x += speed * dt
    s.draw({ x, y: 0, vx: speed, vy: 0, aim: 0, crouching } as never, dt, n * dt, () => 0)
    joints.push(extractBonePoseJoints(s.bones))
    planted.push((s as unknown as { feet: { planted: boolean }[] }).feet[0]!.planted)
  }
  return cycleFrom(name, mode, speed, joints, planted)
}

// An average personality for the behaviour gait (AR-91): the 100STYLE zombie's ~86 steps/min, arms well out.
const averageZombie = Object.assign(zombiePersonality(0), {
  cadence: 86, stride: 1, armsOut: 0.8, hunch: 0.22, lean: 0, limpSide: 0, headLoll: 0.3, shuffle: 0.5, curiosity: 0,
} as const)

function outbreakZombie(name: string, speed: number, alive = false): CycleData {
  const zr = new ZombieCrowdRenderer({ addModel: () => 0 })
  if (alive) {
    zr.behaviour = new BehaviourPoser()
    zr.behaviour.personalityOverride = averageZombie
  }
  const ag = createAIAgent(1, 7, 0, 0, 0)
  Object.assign(ag, { lurch: 0.85, asymmetry: 0.85, drag: 0.9, reach: 0.8, state: "wander", vx: speed, vy: 0, aim: 0 })
  const joints: RigJointMap[] = [], planted: boolean[] = []
  for (let n = 0; n < 480; n++) {
    ag.x += speed * dt
    zr.draw([ag], dt, () => 0, { visible: () => true, actorVisible: () => 1 } as never, [-200, -200, 200, 200], zombieTuning, false)
    const st = zr.getAgentBones(1)!
    const j = extractBonePoseJoints(st.bones)
    joints.push(j)
    planted.push(st.planted?.[0] ?? j.ankleL[1] <= RIG.ankle + 0.004)
  }
  return cycleFrom(name, "walk", speed, joints, planted)
}

// ------------------------------------------------------------------------------------------------ references
type RefSpec = { id: string; label: string; licence: "CC BY 4.0" | "CC0"; mode: "walk" | "run"; cycle: CycleData; source: string }

async function styleRef(id: string, label: string, take: string, mode: "walk" | "run", target: number): Promise<RefSpec> {
  const clip = parse100Style(await load100Style(take))
  const win = findSteadyWindow(clip, target)
  const norm = normaliseClip(clip, win.start, win.end)
  const cycle = extractAsymmetricBvhCycle(norm, id, mode, 0, norm.frames.length)
  return { id, label, licence: "CC BY 4.0", mode, cycle, source: `100STYLE ${take} frames ${win.start}–${win.end} (${win.speed} m/s window)` }
}

async function ualRef(id: string, label: string, pack: "ual1" | "ual2", clipName: string, mode: "walk" | "run"): Promise<RefSpec> {
  const raw = ualClip(await loadUal(pack), clipName)
  // Loops are short; tile them so heel-strike detection always finds two strikes.
  const tiled = { dt: raw.dt, frames: [...raw.frames, ...raw.frames.slice(1), ...raw.frames.slice(1)] }
  const norm = normaliseClip(tiled)
  const speed = r2(clipGroundSpeed(norm))
  const cycle = extractAsymmetricBvhCycle(norm, id, mode, 0, norm.frames.length)
  cycle.speed = speed
  return { id, label, licence: "CC0", mode, cycle, source: `Quaternius ${pack.toUpperCase()} ${clipName} (in place, ${speed} m/s from the planted foot)` }
}

const { tag, out: outDir, flags } = parseArgs(process.argv.slice(2), { tag: "after", out: "reference-clips" })

const refs: Record<string, RefSpec> = {}
for (const r of await Promise.all([
  styleRef("style-neutral-walk", "100STYLE Neutral walk", "Neutral_FW", "walk", 1.4),
  styleRef("style-zombie-walk", "100STYLE Zombie walk", "Zombie_FW", "walk", 0.95),
  styleRef("style-drag-left", "100STYLE Drag left leg", "DragLeftLeg_FW", "walk", 0.95),
  styleRef("style-crouched", "100STYLE Crouched walk", "Crouched_FW", "walk", 1.0),
  styleRef("style-swat", "100STYLE Swat walk", "Swat_FW", "walk", 1.4),
  ualRef("ual-walk", "Quaternius Walk", "ual1", "Walk_Loop", "walk"),
  ualRef("ual-jog", "Quaternius Jog", "ual1", "Jog_Fwd_Loop", "run"),
  ualRef("ual-sprint", "Quaternius Sprint", "ual1", "Sprint_Loop", "run"),
  ualRef("ual-crouch", "Quaternius Crouch walk", "ual1", "Crouch_Fwd_Loop", "walk"),
  ualRef("ual-zombie-walk", "Quaternius Zombie walk", "ual2", "Zombie_Walk_Fwd_Loop", "walk"),
])) refs[r.id] = r

// Each pair samples our gait at the reference's own ground speed, so cadence and stride compare like for like.
type Ours = (speed: number) => CycleData
const actors: Record<string, Ours> = {
  survivorWalk: v => blackout("survivor-walk", "walk", v, humanProfiles.soldier, true),
  survivorRun: v => blackout("survivor-run", "run", v, humanProfiles.soldier, true),
  soldierWalk: v => blackout("soldier-walk", "walk", v, humanProfiles.soldier, false),
  outbreakWalk: v => outbreakSurvivor("outbreak-walk", "walk", v),
  outbreakSneak: v => outbreakSurvivor("outbreak-sneak", "walk", v, true),
  outbreakZombie: v => outbreakZombie("outbreak-zombie", v),
  outbreakZombieAlive: v => outbreakZombie("outbreak-zombie-alive", v, true),
  blackoutZombie: v => blackout("blackout-zombie", "walk", v, humanProfiles.zombie, false),
}

const pairs: [string, keyof typeof actors, string][] = [
  ["survivorWalkVsStyleNeutral", "survivorWalk", "style-neutral-walk"],
  ["survivorWalkVsUalWalk", "survivorWalk", "ual-walk"],
  ["survivorRunVsUalJog", "survivorRun", "ual-jog"],
  ["survivorRunVsUalSprint", "survivorRun", "ual-sprint"],
  ["outbreakWalkVsStyleNeutral", "outbreakWalk", "style-neutral-walk"],
  ["soldierWalkVsStyleSwat", "soldierWalk", "style-swat"],
  ["outbreakSneakVsStyleCrouched", "outbreakSneak", "style-crouched"],
  ["outbreakSneakVsUalCrouch", "outbreakSneak", "ual-crouch"],
  ["outbreakZombieVsStyleZombie", "outbreakZombie", "style-zombie-walk"],
  ["outbreakZombieVsStyleDrag", "outbreakZombie", "style-drag-left"],
  ["outbreakZombieVsUalZombie", "outbreakZombie", "ual-zombie-walk"],
  ["outbreakZombieAliveVsStyleZombie", "outbreakZombieAlive", "style-zombie-walk"],
  ["outbreakZombieAliveVsUalZombie", "outbreakZombieAlive", "ual-zombie-walk"],
  ["blackoutZombieVsStyleZombie", "blackoutZombie", "style-zombie-walk"],
]
const ours: Record<string, CycleData> = {}
for (const [key, o, r] of pairs) ours[key] = actors[o]!(Math.max(0.4, refs[r]!.cycle.speed))

const trunk = (c: CycleData) => {
  const v = c.denseSamples.map(s => s.angles.trunkPitchDeg)
  return { mean: r2(v.reduce((a, b) => a + b, 0) / v.length), range: r2(Math.max(...v) - Math.min(...v)) }
}
const comparisons: Record<string, CycleComparison & { ref: string; ours: string }> = {}
const summary: Record<string, unknown>[] = []
for (const [key, o, r] of pairs) {
  const mine = ours[key]!
  const c = compareCycles(mine, refs[r]!.cycle)
  comparisons[key] = { ...c, ref: r, ours: o }
  // Which angle differs most is what to look at first.
  const angles = Object.entries(c.angleRmseDeg).filter(([k]) => !k.startsWith("mean") && k !== "overallAngleRmse") as [string, number][]
  const worst = angles.sort((a, b) => b[1] - a[1]).slice(0, 3)
  summary.push({
    key,
    ref: refs[r]!.label,
    overall: c.angleRmseDeg.overallAngleRmse,
    arm: c.angleRmseDeg.meanArmAngleRmse,
    leg: c.angleRmseDeg.meanLegAngleRmse,
    worst: worst.map(([k, v]) => `${k} ${v}°`).join(", "),
    speed: refs[r]!.cycle.speed,
    cadence: `${mine.cadenceStepsPerMin} vs ${refs[r]!.cycle.cadenceStepsPerMin} spm`,
    trunk: `${trunk(mine).mean}° (Δ${trunk(mine).range}) vs ${trunk(refs[r]!.cycle).mean}° (Δ${trunk(refs[r]!.cycle).range})`,
    footLift: `${c.kinematics.ours.footLiftMaxCm} vs ${c.kinematics.ref.footLiftMaxCm} cm`,
    knee: `${c.kinematics.ours.kneeFlexMinDeg}..${c.kinematics.ours.kneeFlexMaxDeg}° vs ${c.kinematics.ref.kneeFlexMinDeg}..${c.kinematics.ref.kneeFlexMaxDeg}°`,
    side2D: c.positionRmse.side2DNorm,
  })
}

writeFileSync(
  join(outDir, `reference-clips-${tag}.json`),
  JSON.stringify(
    {
      tag,
      timestamp: new Date().toISOString(),
      credits: OPEN_MOCAP_CREDITS,
      joints: POSE_JOINTS,
      segments: RIG_SEGMENTS,
      references: Object.fromEntries(Object.entries(refs).map(([k, v]) => [k, { ...v.cycle, label: v.label, licence: v.licence, source: v.source }])),
      cycles: ours,
      comparisons,
      summary,
    },
    null,
    1,
  ),
)

console.log(`\n=== Reference clips (${tag}) ===`)
for (const r of Object.values(refs)) console.log(`  ${r.id}: ${r.source}, ${r.cycle.cadenceStepsPerMin} spm, ${r.cycle.cycleDurationSec}s cycle`)
for (const s of summary) console.log(`${s.key} [${s.ref} @ ${s.speed} m/s]: overall ${s.overall}° arm ${s.arm}° leg ${s.leg}° | worst ${s.worst} | cadence ${s.cadence} | trunk ${s.trunk} | lift ${s.footLift} | knee ${s.knee}`)

if (flags.has("bake")) {
  // Compact cycles for the Characters page's reference ghost: 32 phase samples of the 21 joints, pelvis at the
  // origin (in place), metres, 3 decimals. Only CC0 / CC BY sources; credits travel with the data.
  const baked = Object.values(refs).map(r => {
    const n = 32
    const frames = Array.from({ length: n }, (_, k) => {
      const s = r.cycle.denseSamples[Math.floor((k / n) * r.cycle.denseSamples.length)]!
      const p = s.joints.pelvis
      return POSE_JOINTS.flatMap(id => {
        const j = s.joints[id]
        return [j[0] - p[0], j[1], j[2] - p[2]].map(v => Math.round(v * 1000) / 1000)
      })
    })
    return { id: r.id, label: r.label, licence: r.licence, source: r.source, speed: r.cycle.speed, cycleSec: r.cycle.cycleDurationSec, frames }
  })
  const path = join(repoRoot, "games/blackout/src/dev/reference-clips.json")
  writeFileSync(path, JSON.stringify({ joints: POSE_JOINTS, credits: OPEN_MOCAP_CREDITS, clips: baked }))
  console.log(`baked ${baked.length} clips → ${path}`)
}

if (!flags.has("no-render")) {
  const py = spawnSync("python3", [join(import.meta.dir, "reference-clips-render.py"), outDir, tag], { stdio: "inherit" })
  if (py.status !== 0) process.exit(py.status ?? 1)
}
