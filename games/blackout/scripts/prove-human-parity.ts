// Explicit soldier posture + weapon-stability metric checks and deterministic 900-frame reference hashes.
// Optionally pass a baseline repository directory to include its before-change measurements in the report.
import { resolve } from "node:path"
import { angleDiff } from "../shared/geom"
import { animate, fire, hit, newAvatar } from "../src/game/anim"
import { animation } from "../src/game/anim-settings"
import { at, dot, type Frame } from "../src/game/rig"
import { HIP, RIG } from "../src/render/person"

const EXPECTED_HASHES = {
  old: "00bde28afe7d26930d81018826ee561968bf95508793210202b301ee80a6e9ac",
  // Deliberately updated from f5a333ae622e3df2042d99638c1010121ffdbf95edef6a7a0cca6d932670539b after the
  // walk/run gait audit: phase-locked anti-phase step scheduling (eliminating the 45% run / 12.5% walk L/R step
  // stagger and 3-step phase-wrap bob beat), smooth Williams Contact->Down->Passing->Up COM curve without
  // discontinuous touchdown dip impulse, terminal-stance heel-off roll + dorsiflexed heel-strike preparation
  // with near-zero contact foot velocity, and phase-compensated opposing arm swing.
  new: "756db0b50d8755b4941daa5d490e3ea669682932408842e857b86b3ecd7914ff",
} as const

type Api = {
  animate: typeof animate
  fire: typeof fire
  hit: typeof hit
  newAvatar: typeof newAvatar
  animation: typeof animation
}

const dt = 1 / 60
const deg = (f: Frame) => Math.atan2(f.x[1], Math.hypot(f.x[0], f.x[2])) * 180 / Math.PI
const round = (n: number, d = 4) => Number(n.toFixed(d))

function hash900(api: Api, mode: "old" | "new"): string {
  const saved = { ...api.animation }
  api.animation.animationMode = mode
  const a = api.newAvatar("parity", 0, 0, 0, "rifle"), hash = new Bun.CryptoHasher("sha256")
  let x = 0, y = 0
  for (let n = 0; n < 900; n++) {
    const speed = n < 300 ? 4.2 : n < 600 ? 6.3 : 1.4, direction = n / 150
    const vx = Math.cos(direction) * speed, vy = Math.sin(direction) * speed
    x += vx / 60; y += vy / 60
    if (n % 43 === 0) api.fire(a, n / 60)
    if (n === 380) api.hit(a, 0.2, 1)
    api.animate(a, 1 / 60, n / 60, x, y, vx, vy, n / 130)
    hash.update(JSON.stringify(a.body))
  }
  Object.assign(api.animation, saved)
  return hash.digest("hex")
}

function measurePosture(api: Api, mode: "old" | "new") {
  const saved = { ...api.animation }
  api.animation.animationMode = mode
  const rows: Record<string, {
    pelvisHeight: number; crouchDropCm: number; pelvisForward: number; shoulderForward: number; headForward: number
    headMinusPelvisForward: number; pelvisPitchDeg: number; chestPitchDeg: number; headPitchDeg: number
    kneeBendDeg: number; maxToeSlip: number; maxLockSlip: number
  }> = {}
  for (const [name, vx, vy] of [
    ["walk", 1.4, 0],
    ["run", 4.2, 0],
    ["sprint", 6.3, 0],
    ["strafe", 0, 4.2],
    ["backpedal", -4.2, 0],
  ] as const) {
    const a = api.newAvatar(`posture-${name}`, 0, 0, 0, "rifle")
    let x = 0, y = 0, pelY = 0, pelX = 0, shX = 0, headX = 0, pelPitch = 0, chestPitch = 0, headPitch = 0, kneeBend = 0
    let maxToeSlip = 0, maxLockSlip = 0
    const warmup = 120, count = 240
    for (let n = 0; n < warmup + count; n++) {
      const prevBody = a.body
      const prevFeet = a.feet.map(f => ({ planted: f.planted, p: [...f.p] }))
      x += vx * dt; y += vy * dt
      api.animate(a, dt, n * dt, x, y, vx, vy, 0)
      for (let i = 0; i < 2; i++) {
        if (prevBody && prevFeet[i]!.planted && a.feet[i]!.planted) {
          maxLockSlip = Math.max(maxLockSlip, Math.hypot(...a.feet[i]!.p.map((v, k) => v - prevFeet[i]!.p[k]!)))
          const beforeToe = at(prevBody.ft[i]!, 0.19, -RIG.ankle, 0), afterToe = at(a.body!.ft[i]!, 0.19, -RIG.ankle, 0)
          maxToeSlip = Math.max(maxToeSlip, Math.hypot(...afterToe.map((v, k) => v - beforeToe[k]!)))
        }
      }
      if (n < warmup) continue
      const b = a.body!, sh = at(b.torso, 0, RIG.shoulderY, 0)
      pelY += b.pelvis.p[1]; pelX += b.pelvis.p[0] - x; shX += sh[0] - x; headX += b.head.p[0] - x
      pelPitch += deg(b.pelvis); chestPitch += deg(b.torso); headPitch += deg(b.head)
      for (let i = 0; i < 2; i++) kneeBend += Math.acos(Math.max(-1, Math.min(1, dot(b.th[i]!.y, b.sh[i]!.y)))) * 90 / Math.PI
    }
    rows[name] = {
      pelvisHeight: round(pelY / count),
      crouchDropCm: round((HIP - pelY / count) * 100, 2),
      pelvisForward: round(pelX / count),
      shoulderForward: round(shX / count),
      headForward: round(headX / count),
      headMinusPelvisForward: round((headX - pelX) / count),
      pelvisPitchDeg: round(pelPitch / count, 2),
      chestPitchDeg: round(chestPitch / count, 2),
      headPitchDeg: round(headPitch / count, 2),
      kneeBendDeg: round(kneeBend / count, 2),
      maxToeSlip,
      maxLockSlip,
    }
  }
  Object.assign(api.animation, saved)
  return rows
}

function measureWeapon(api: Api, mode: "old" | "new") {
  const saved = { ...api.animation }
  api.animation.animationMode = mode
  const scenarios = ["run", "sprint", "strafe", "circle", "stop", "aimSweep", "mux30In60"] as const
  const out: Record<string, {
    gripFromRootXMean: number; gripFromRootXRms: number; gripFromRootXDeltaRms: number
    gripFromRootZRms: number; gripFromRootZDeltaRms: number
    gripFromShoulderXMean: number; gripFromShoulderXP2P: number; gripFromShoulderZP2P: number
    muzzleFromRootZRms: number; muzzleFromRootZDeltaRms: number
    yawErrRms: number; yawErrDeltaRms: number; maxAbsYawErr: number
    pitchRms: number; pitchDeltaRms: number
  }> = {}
  const rms = (arr: number[]) => {
    const m = arr.reduce((s, v) => s + v, 0) / arr.length
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length)
  }
  const deltaRms = (arr: number[]) => {
    let s = 0
    for (let i = 1; i < arr.length; i++) s += (arr[i]! - arr[i - 1]!) ** 2
    return Math.sqrt(s / (arr.length - 1))
  }
  const mean = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length
  const p2p = (arr: number[]) => Math.max(...arr) - Math.min(...arr)

  for (const scenario of scenarios) {
    const a = api.newAvatar(`weapon-${scenario}`, 0, 0, 0, "rifle")
    let x = 0, y = 0, bodyX = 0
    const gx: number[] = [], gz: number[] = [], shX: number[] = [], shZ: number[] = [], mz: number[] = [], yaw: number[] = [], pitch: number[] = []
    for (let n = 0; n < 300; n++) {
      const t = n * dt
      let vx = 4.2, vy = 0, aim = 0
      if (scenario === "sprint") vx = 6.3
      else if (scenario === "strafe") { vx = 0; vy = Math.floor(t * 2) % 2 === 0 ? 4.2 : -4.2 }
      else if (scenario === "circle") { vx = -Math.sin(t * 2) * 4.2; vy = Math.cos(t * 2) * 4.2 }
      else if (scenario === "stop") vx = n < 150 ? 4.2 : 0
      else if (scenario === "aimSweep") aim = Math.sin(t * 3) * 0.8
      if (scenario === "mux30In60") {
        if (n % 2 === 0) bodyX += vx / 30
        x = bodyX
      } else {
        x += vx * dt; y += vy * dt
      }
      api.animate(a, dt, t, x, y, vx, vy, aim)
      if (scenario === "stop" ? n >= 140 && n < 210 : n >= 90) {
        const g = a.body!.gun!, sh = at(a.body!.torso, 0, RIG.shoulderY, 0), muzzle = at(g, 0.66, 0.03, 0)
        gx.push(g.p[0] - x); gz.push(g.p[2] - y)
        shX.push(g.p[0] - sh[0]); shZ.push(g.p[2] - sh[2])
        mz.push(muzzle[2] - y)
        yaw.push(angleDiff(Math.atan2(g.x[2], g.x[0]), aim))
        pitch.push(Math.asin(g.x[1]))
      }
    }
    out[scenario] = {
      gripFromRootXMean: round(mean(gx)),
      gripFromRootXRms: round(rms(gx)),
      gripFromRootXDeltaRms: round(deltaRms(gx)),
      gripFromRootZRms: round(rms(gz)),
      gripFromRootZDeltaRms: round(deltaRms(gz)),
      gripFromShoulderXMean: round(mean(shX)),
      gripFromShoulderXP2P: round(p2p(shX)),
      gripFromShoulderZP2P: round(p2p(shZ)),
      muzzleFromRootZRms: round(rms(mz)),
      muzzleFromRootZDeltaRms: round(deltaRms(mz)),
      yawErrRms: round(rms(yaw)),
      yawErrDeltaRms: round(deltaRms(yaw)),
      maxAbsYawErr: round(Math.max(...yaw.map(Math.abs))),
      pitchRms: round(rms(pitch)),
      pitchDeltaRms: round(deltaRms(pitch)),
    }
  }
  Object.assign(api.animation, saved)
  return out
}

const currentApi: Api = { animate, fire, hit, newAvatar, animation }
const baselineDir = process.argv[2]
let beforeApi: Api | null = null
if (baselineDir) {
  const origAnim = await import(resolve(baselineDir, "games/blackout/src/game/anim.ts")) as typeof import("../src/game/anim")
  const origSettings = await import(resolve(baselineDir, "games/blackout/src/game/anim-settings.ts")) as typeof import("../src/game/anim-settings")
  beforeApi = { ...origAnim, animation: origSettings.animation }
}

const hashes = {
  old: hash900(currentApi, "old"),
  new: hash900(currentApi, "new"),
}
const posture = {
  old: measurePosture(currentApi, "old"),
  ...(beforeApi ? { before: measurePosture(beforeApi, "new") } : {}),
  after: measurePosture(currentApi, "new"),
}
const weapon = {
  old: measureWeapon(currentApi, "old"),
  ...(beforeApi ? { before: measureWeapon(beforeApi, "new") } : {}),
  after: measureWeapon(currentApi, "new"),
}

const checks = {
  oldHashMatches8223033: hashes.old === EXPECTED_HASHES.old,
  newHashMatchesReference: hashes.new === EXPECTED_HASHES.new,
  crouchLeanIncreasesWithSpeed:
    -posture.after.walk!.chestPitchDeg < 10 &&
    -posture.after.run!.chestPitchDeg > 24 &&
    -posture.after.sprint!.chestPitchDeg > -posture.after.run!.chestPitchDeg + 6 &&
    posture.after.run!.crouchDropCm > posture.after.walk!.crouchDropCm + 8 &&
    posture.after.sprint!.crouchDropCm > posture.after.run!.crouchDropCm + 2 &&
    posture.after.run!.kneeBendDeg > posture.after.walk!.kneeBendDeg + 15,
  headStabilisedAndForward:
    posture.after.run!.headMinusPelvisForward > 0.25 &&
    posture.after.sprint!.headMinusPelvisForward > 0.32 &&
    Math.abs(posture.after.run!.headPitchDeg) < 8.5,
  strafeAndBackpedalSensible:
    Math.abs(posture.after.strafe!.pelvisPitchDeg) < 0.5 &&
    Math.abs(posture.after.backpedal!.pelvisPitchDeg) < 0.5 &&
    posture.after.backpedal!.chestPitchDeg > -5 &&
    posture.after.backpedal!.chestPitchDeg < 1,
  zeroFootSlide: Object.values(posture.after).every(row => row.maxLockSlip === 0 && row.maxToeSlip < 1e-12),
  weaponStabilityVsOld: (["run", "strafe", "circle", "stop", "aimSweep", "mux30In60"] as const).every(s =>
    weapon.after[s]!.gripFromRootXRms <= weapon.old[s]!.gripFromRootXRms + 1e-4 &&
    weapon.after[s]!.gripFromRootXDeltaRms <= weapon.old[s]!.gripFromRootXDeltaRms + 1e-4 &&
    weapon.after[s]!.muzzleFromRootZRms <= weapon.old[s]!.muzzleFromRootZRms + 1e-4 &&
    weapon.after[s]!.muzzleFromRootZDeltaRms <= weapon.old[s]!.muzzleFromRootZDeltaRms + 1e-4 &&
    weapon.after[s]!.yawErrRms <= weapon.old[s]!.yawErrRms + 1e-4 &&
    weapon.after[s]!.pitchRms <= weapon.old[s]!.pitchRms + 1e-4 &&
    weapon.after[s]!.maxAbsYawErr < 0.035),
}

console.log(JSON.stringify({ expectedHashes: EXPECTED_HASHES, hashes, checks, posture, weapon }, null, 2))
if (Object.values(checks).some(v => !v)) process.exit(1)
