import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import {
  buildCycleFromJointFrames,
  computePoseAngles,
  extractBonePoseJoints,
  type CycleData,
  type RigJointMap,
} from "@arcade/kit/pose-diff"
import { dist, HIP, sub, type V3 } from "@arcade/kit/rig"
import { MELEE_WEAPONS, type MeleeWeaponId } from "../../../outbreak/shared/combat"
import { Survivor as OutbreakSurvivor } from "../../../outbreak/src/survivor"
import { parseArgs } from "./common"

const dt = 1 / 60
const DEG = 180 / Math.PI
const r2 = (n: number) => Math.round(n * 100) / 100
const r3 = (n: number) => Math.round(n * 1000) / 1000

export type MeleeArcSummary = {
  weapon: MeleeWeaponId
  weaponClass: string
  combo: 1 | 2 | 3
  heavy: boolean
  speedMps: number
  windupTipAngleDeg: number
  apexTipReachM: number
  followThroughTipAngleDeg: number
  totalTipSweepDeg: number
  chestCoilDeg: number
  chestWhipDeg: number
  totalChestTwistDeg: number
  maxRightShoulderChordM: number
  maxLeftShoulderChordM: number
  meanWristGapCm: number
  maxPlantedToeSlipM: number
}

function sampleMeleeSwing(
  weapon: MeleeWeaponId,
  combo: 1 | 2 | 3,
  heavy: boolean,
  speedMps: number,
): { cycle: CycleData; summary: MeleeArcSummary; tipPathXZ: [number, number][]; handPathXZ: [number, number][] } {
  const def = MELEE_WEAPONS[weapon]
  const s = new OutbreakSurvivor({ addModel: () => 0 })
  const warmupFrames = speedMps > 0 ? 90 : 20
  let x = 0
  const y = 0

  for (let n = 0; n < warmupFrames; n++) {
    x += speedMps * dt
    s.draw(
      {
        x,
        y,
        vx: speedMps,
        vy: 0,
        aim: 0,
        equippedItem: weapon,
        meleeWeapon: weapon,
        meleePhase: "idle",
        meleeCombo: combo,
      },
      dt,
      n * dt,
      () => 0,
    )
  }

  // Schedule: 12 frames windup -> 16 frames active -> 12 frames recovery (40 frames total)
  const windupFrames = 12
  const activeFrames = 16
  const recoveryFrames = 12
  const totalSwingFrames = windupFrames + activeFrames + recoveryFrames

  const jointHistory: RigJointMap[] = []
  const tipPathXZ: [number, number][] = []
  const handPathXZ: [number, number][] = []
  let windupTipAngleDeg = 0
  let followThroughTipAngleDeg = 0
  let minTipAngle = Infinity
  let maxTipAngle = -Infinity
  let apexTipReachM = 0
  let chestCoilDeg = 0
  let chestWhipDeg = 0
  let maxRightChord = 0
  let maxLeftChord = 0
  let wristGapSum = 0
  let maxToeSlip = 0
  const prevPlantedPos: [V3 | null, V3 | null] = [null, null]

  let prevTipAngleDeg: number | null = null
  for (let k = 0; k < totalSwingFrames; k++) {
    x += speedMps * dt
    const t = (warmupFrames + k) * dt
    let phase: "windup" | "active" | "recovery"
    let phaseTime: number
    let phaseDuration: number
    if (k < windupFrames) {
      phase = "windup"
      phaseTime = (k + 1) * dt
      phaseDuration = windupFrames * dt
    } else if (k < windupFrames + activeFrames) {
      phase = "active"
      phaseTime = (k - windupFrames + 1) * dt
      phaseDuration = activeFrames * dt
    } else {
      phase = "recovery"
      phaseTime = (k - windupFrames - activeFrames + 1) * dt
      phaseDuration = recoveryFrames * dt
    }

    s.draw(
      {
        x,
        y,
        vx: speedMps,
        vy: 0,
        aim: 0,
        equippedItem: weapon,
        meleeWeapon: weapon,
        meleePhase: phase,
        meleePhaseTime: phaseTime,
        meleePhaseDuration: phaseDuration,
        meleeCombo: combo,
        meleeCharge: heavy ? 1.0 : 0,
        meleeHeavy: heavy,
      },
      dt,
      t,
      () => 0,
    )

    const j = extractBonePoseJoints(s.bones)
    const wFrame = s.meleeWeaponFrame!
    const tip = s.meleeTip!
    j.gunGrip = [...wFrame.p] as V3
    j.gunMuzzle = [...tip] as V3
    jointHistory.push(j)

    const relTipX = tip[0] - j.pelvis[0]
    const relTipZ = tip[2] - j.pelvis[2]
    const relHandX = wFrame.p[0] - j.pelvis[0]
    const relHandZ = wFrame.p[2] - j.pelvis[2]
    tipPathXZ.push([r3(relTipX), r3(relTipZ)])
    handPathXZ.push([r3(relHandX), r3(relHandZ)])

    let tipAngleDeg = Math.atan2(relTipZ, relTipX) * DEG
    if (prevTipAngleDeg !== null) {
      while (tipAngleDeg - prevTipAngleDeg > 180) tipAngleDeg -= 360
      while (tipAngleDeg - prevTipAngleDeg < -180) tipAngleDeg += 360
    }
    prevTipAngleDeg = tipAngleDeg
    const tipReach = Math.hypot(relTipX, relTipZ)
    const shBar = sub(j.shoulderR, j.shoulderL)
    const chestYawDeg = Math.atan2(-shBar[0], shBar[2]) * DEG

    if (k === windupFrames - 1) {
      windupTipAngleDeg = tipAngleDeg
      chestCoilDeg = chestYawDeg
    }
    if (phase === "active") {
      minTipAngle = Math.min(minTipAngle, tipAngleDeg)
      maxTipAngle = Math.max(maxTipAngle, tipAngleDeg)
      apexTipReachM = Math.max(apexTipReachM, tipReach)
    }
    if (k === windupFrames + activeFrames - 1) {
      followThroughTipAngleDeg = tipAngleDeg
      chestWhipDeg = chestYawDeg
    }

    const rChord = dist(j.shoulderR, j.wristR)
    const lChord = dist(j.shoulderL, j.wristL)
    maxRightChord = Math.max(maxRightChord, rChord)
    maxLeftChord = Math.max(maxLeftChord, lChord)
    wristGapSum += dist(j.wristL, j.wristR) * 100

    const feet = (s as unknown as { feet: { planted: boolean; p: V3 }[] }).feet
    for (let fIdx = 0; fIdx < 2; fIdx++) {
      const f = feet[fIdx]!
      if (f.planted) {
        if (prevPlantedPos[fIdx]) {
          const slip = Math.hypot(f.p[0] - prevPlantedPos[fIdx]![0], f.p[2] - prevPlantedPos[fIdx]![2])
          maxToeSlip = Math.max(maxToeSlip, slip)
        }
        prevPlantedPos[fIdx] = [...f.p] as V3
      } else {
        prevPlantedPos[fIdx] = null
      }
    }
  }

  const totalTipSweepDeg = Math.max(
    Math.abs(windupTipAngleDeg - followThroughTipAngleDeg),
    maxTipAngle - minTipAngle,
  )
  const summary: MeleeArcSummary = {
    weapon,
    weaponClass: def.weaponClass,
    combo,
    heavy,
    speedMps,
    windupTipAngleDeg: r2(windupTipAngleDeg),
    apexTipReachM: r3(apexTipReachM),
    followThroughTipAngleDeg: r2(followThroughTipAngleDeg),
    totalTipSweepDeg: r2(totalTipSweepDeg),
    chestCoilDeg: r2(chestCoilDeg),
    chestWhipDeg: r2(chestWhipDeg),
    totalChestTwistDeg: r2(Math.abs(chestCoilDeg - chestWhipDeg)),
    maxRightShoulderChordM: r3(maxRightChord),
    maxLeftShoulderChordM: r3(maxLeftChord),
    meanWristGapCm: r2(wristGapSum / totalSwingFrames),
    maxPlantedToeSlipM: maxToeSlip,
  }

  const cycleName = `melee-${weapon}-c${combo}${heavy ? "-heavy" : ""}-${speedMps > 0 ? "move" : "stand"}`
  const cycle = buildCycleFromJointFrames(
    cycleName,
    speedMps > 2 ? "run" : "walk",
    speedMps,
    totalSwingFrames * dt,
    jointHistory,
    0,
  )

  return { cycle, summary, tipPathXZ, handPathXZ }
}

const { tag, out: outDir, flags } = parseArgs(process.argv.slice(2), { tag: "after", out: "melee-poses" })
const noRender = flags.has("no-render")
mkdirSync(outDir, { recursive: true })

const cases: { weapon: MeleeWeaponId; combo: 1 | 2 | 3; heavy: boolean; speedMps: number }[] = [
  { weapon: "crowbar", combo: 1, heavy: false, speedMps: 0 },
  { weapon: "crowbar", combo: 2, heavy: false, speedMps: 0 },
  { weapon: "crowbar", combo: 3, heavy: true, speedMps: 1.4 },
  { weapon: "machete", combo: 1, heavy: false, speedMps: 0 },
  { weapon: "machete", combo: 2, heavy: false, speedMps: 1.4 },
  { weapon: "knife", combo: 1, heavy: false, speedMps: 0 },
  { weapon: "bat", combo: 1, heavy: false, speedMps: 0 },
  { weapon: "bat", combo: 3, heavy: true, speedMps: 1.4 },
  { weapon: "spiked-board", combo: 1, heavy: true, speedMps: 0 },
  { weapon: "axe", combo: 1, heavy: false, speedMps: 0 },
  { weapon: "fire-axe", combo: 1, heavy: true, speedMps: 0 },
  { weapon: "fire-axe", combo: 1, heavy: false, speedMps: 4.2 },
]

const summaries: MeleeArcSummary[] = []
const cycles: Record<string, CycleData> = {}
const trajectories: Record<string, { tipPathXZ: [number, number][]; handPathXZ: [number, number][] }> = {}

for (const c of cases) {
  const res = sampleMeleeSwing(c.weapon, c.combo, c.heavy, c.speedMps)
  summaries.push(res.summary)
  cycles[res.cycle.name] = res.cycle
  trajectories[res.cycle.name] = { tipPathXZ: res.tipPathXZ, handPathXZ: res.handPathXZ }
}

const jsonPath = join(outDir, `melee-poses-${tag}.json`)
writeFileSync(jsonPath, JSON.stringify({ tag, summaries, cycles, trajectories }, null, 2))

console.log(`\n=== Melee Swing Arc & Line-Rig Metrics (${tag}) ===`)
console.log(
  "Weapon        | Class     | Combo | Speed | Windup° | End°    | Sweep° | Reach m | Twist° | R-Chord | WristGap | ToeSlip",
)
console.log("-".repeat(118))
for (const s of summaries) {
  const cLabel = `${s.combo}${s.heavy ? "H" : "L"}`
  console.log(
    `${s.weapon.padEnd(13)} | ${s.weaponClass.padEnd(9)} | ${cLabel.padEnd(5)} | ${s.speedMps.toFixed(1).padStart(5)} | ${s.windupTipAngleDeg.toFixed(1).padStart(7)} | ${s.followThroughTipAngleDeg.toFixed(1).padStart(7)} | ${s.totalTipSweepDeg.toFixed(1).padStart(6)} | ${s.apexTipReachM.toFixed(3).padStart(7)} | ${s.totalChestTwistDeg.toFixed(1).padStart(6)} | ${s.maxRightShoulderChordM.toFixed(3).padStart(7)} | ${(s.meanWristGapCm.toFixed(1) + "cm").padStart(8)} | ${s.maxPlantedToeSlipM.toExponential(1)}`,
  )
}

if (!noRender) {
  const pyScript = `
import json, math, os, sys
from PIL import Image, ImageDraw, ImageFont

data = json.load(open(${JSON.stringify(jsonPath)}))
out_dir = ${JSON.stringify(outDir)}
tag = data["tag"]

W, H = 1360, 860
img = Image.new("RGB", (W, H), (15, 18, 23))
draw = ImageDraw.Draw(img)

try:
    font_title = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 18)
    font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 13)
except Exception:
    font_title = ImageFont.load_default()
    font = ImageFont.load_default()

draw.text((24, 16), f"Outbreak Melee Weapon Classes — Top-Down (X/Z) & Side (X/Y) Line-Rig Swing Arcs ({tag})", fill=(235, 240, 245), font=font_title)

featured = [
    ("melee-crowbar-c1-stand", "One-Handed Blunt (Crowbar · Combo 1 Forehand)"),
    ("melee-crowbar-c2-stand", "One-Handed Blunt (Crowbar · Combo 2 Backhand)"),
    ("melee-machete-c1-stand", "One-Handed Blade (Machete · Slash)"),
    ("melee-bat-c1-stand", "Two-Handed Heavy (Baseball Bat · Cleave)"),
    ("melee-fire-axe-c1-heavy-stand", "Two-Handed Heavy (Fire Axe · Charged Heavy)"),
    ("melee-fire-axe-c1-move", "Two-Handed Heavy (Fire Axe · Moving 4.2 m/s)"),
]

SEGMENTS = [
    ("pelvis", "waist", (220, 225, 230)),
    ("waist", "neck", (220, 225, 230)),
    ("neck", "headTop", (220, 225, 230)),
    ("neck", "shoulderL", (90, 175, 255)),
    ("shoulderL", "elbowL", (90, 175, 255)),
    ("elbowL", "wristL", (90, 175, 255)),
    ("neck", "shoulderR", (255, 150, 70)),
    ("shoulderR", "elbowR", (255, 150, 70)),
    ("elbowR", "wristR", (255, 150, 70)),
    ("gunGrip", "gunMuzzle", (255, 215, 70)),
]

for idx, (cname, title) in enumerate(featured):
    col = idx % 3
    row = idx // 3
    bx = 24 + col * 442
    by = 54 + row * 395
    draw.rectangle([bx, by, bx + 426, by + 378], outline=(45, 52, 64), fill=(20, 24, 30))
    draw.text((bx + 12, by + 10), title, fill=(230, 235, 242), font=font)

    cyc = data["cycles"][cname]
    traj = data["trajectories"][cname]
    frames = cyc["phases8"]
    summary = next(
        s for s in data["summaries"]
        if f"melee-{s['weapon']}-c{s['combo']}{'-heavy' if s['heavy'] else ''}-{'move' if s['speedMps'] > 0 else 'stand'}" == cname
    )

    # Top-down radar view of the 8 phases + weapon tip arc
    cx, cy = bx + 213, by + 195
    scale = 120.0
    for r_m in [0.5, 1.0, 1.5]:
        rr = int(r_m * scale)
        draw.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=(34, 40, 50))
    draw.line([cx - 150, cy, cx + 150, cy], fill=(40, 48, 58))
    draw.line([cx, cy - 150, cx, cy + 150], fill=(40, 48, 58))

    # Draw tip trajectory curve in gold
    pts = [(cx + p[0] * scale, cy + p[1] * scale) for p in traj["tipPathXZ"]]
    if len(pts) > 1:
        draw.line(pts, fill=(255, 215, 70), width=3)
    hpts = [(cx + p[0] * scale, cy + p[1] * scale) for p in traj["handPathXZ"]]
    if len(hpts) > 1:
        draw.line(hpts, fill=(255, 140, 60), width=2)

    # Overlay 8 phase poses in top-down (X forward = right, Z = down)
    for p_idx, f in enumerate(frames):
        j = f["joints"]
        px, pz = j["pelvis"][0], j["pelvis"][2]
        alpha = 0.4 + 0.6 * (p_idx / 7.0)
        for a, b, col_rgb in SEGMENTS:
            if a not in j or b not in j or j[a] is None or j[b] is None:
                continue
            x0 = cx + (j[a][0] - px) * scale
            y0 = cy + (j[a][2] - pz) * scale
            x1 = cx + (j[b][0] - px) * scale
            y1 = cy + (j[b][2] - pz) * scale
            c = tuple(int(v * alpha) for v in col_rgb)
            w = 3 if a == "gunGrip" else 2
            draw.line([x0, y0, x1, y1], fill=c, width=w)

    stats = f"Sweep {summary['totalTipSweepDeg']}° ({summary['windupTipAngleDeg']}°→{summary['followThroughTipAngleDeg']}°) · Reach {summary['apexTipReachM']}m · Twist {summary['totalChestTwistDeg']}° · Gap {summary['meanWristGapCm']}cm"
    draw.text((bx + 10, by + 352), stats, fill=(170, 185, 200), font=font)

sheet_path = os.path.join(out_dir, f"line-rig-melee-{tag}.png")
img.save(sheet_path)
print(f"Saved line-rig sheet: {sheet_path}")
`
  const res = spawnSync("python3", ["-c", pyScript], { stdio: "inherit" })
  if (res.status !== 0) {
    console.warn("Warning: python3 Pillow sheet render exited with non-zero status")
  }
}
