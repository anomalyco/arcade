import {
  RIG,
  aimFrame,
  at,
  clamp,
  dirIn,
  dot,
  ik,
  lerp3,
  limb,
  moved,
  norm,
  pitch,
  roll,
  smooth,
  smoother,
  sub,
  yawBy,
  type Frame,
  type V3,
} from "./rig"

export type MeleeWeaponClass = "one-blunt" | "one-blade" | "two-heavy"
export type MeleeSwingPhase = "idle" | "windup" | "active" | "recovery"

export type MeleePoseInput = {
  weaponClass: MeleeWeaponClass
  phase: MeleeSwingPhase
  /** Normalized progress within the current phase (0..1). */
  phaseProgress: number
  /** Combo step: 1 = forehand (right -> left), 2 = backhand (left -> right), 3 = overhead/wide finisher. */
  combo: 1 | 2 | 3
  /** Charge amount (0..1) built while holding the attack button during windup. */
  charge: number
  /** True when executing a charged heavy swing. */
  heavy: boolean
  /** Weapon length in metres from grip to tip (for tip trajectory & two-handed grip spacing). */
  weaponLength: number
  /** Locomotion gait blend (0 = idle, 1 = moving) and arm swing signal (-1..1). */
  gait?: number
  armSwing?: number
}

export type MeleeTorsoModulation = {
  /** Additional torso yaw twist in radians (positive turns chest right/+z, negative turns chest left/-z). */
  yawAdd: number
  /** Additional forward torso pitch in radians (positive leans chest forward/down toward +x). */
  pitchAdd: number
  /** Additional lateral torso roll in radians. */
  rollAdd: number
}

export type MeleePoseResult = {
  handL: V3
  handR: V3
  ua: [Frame, Frame]
  fa: [Frame, Frame]
  /** Weapon frame anchored to the right-hand grip (`+x` along shaft/blade, `+y` top/back, `+z` right). */
  weapon: Frame
  /** World-space position of the weapon tip (`at(weapon, weaponLength, 0, 0)`). */
  tip: V3
}

/**
 * Computes upper-body coil (windup) and whip (active/recovery) torso angles for a melee weapon class.
 * Designed so top-down cameras clearly read anticipation (shoulder coil), active arc whip, and follow-through.
 */
export function meleeTorsoModulation(input: MeleePoseInput): MeleeTorsoModulation {
  const { weaponClass, phase, combo, charge, heavy } = input
  const u = clamp(input.phaseProgress, 0, 1)
  const heavyBoost = heavy ? 1.25 + 0.25 * clamp(charge, 0, 1) : 1 + 0.35 * clamp(charge, 0, 1)
  const isTwoHand = weaponClass === "two-heavy"
  const isBlade = weaponClass === "one-blade"
  const classScale = isTwoHand ? 1.28 : isBlade ? 0.92 : 1.05
  // Combo 1 & 3 coil to the right (+yaw) and whip left (-yaw); Combo 2 coils left (-yaw) and whips right (+yaw).
  const dir = combo === 2 ? -1 : 1
  const isFinisher = combo === 3 || heavy

  const readyYaw = isTwoHand ? 0.28 : isBlade ? 0.22 : 0.18
  const readyPitch = isTwoHand ? 0.08 : 0.04

  if (phase === "idle") {
    return { yawAdd: readyYaw, pitchAdd: readyPitch, rollAdd: isTwoHand ? 0.04 : 0.02 }
  }

  const coilYaw = dir * (0.48 + (isFinisher ? 0.16 : 0)) * classScale * heavyBoost
  const whipYaw = -dir * (0.44 + (isFinisher ? 0.14 : 0)) * classScale * (heavy ? 1.2 : 1)
  const coilPitch = isFinisher ? -0.14 * heavyBoost : -0.06
  const lungePitch = (0.18 + (isFinisher ? 0.08 : 0)) * classScale * (heavy ? 1.2 : 1)

  if (phase === "windup") {
    const e = smooth(u)
    return {
      yawAdd: readyYaw + (coilYaw - readyYaw) * e,
      pitchAdd: readyPitch + (coilPitch - readyPitch) * e,
      rollAdd: dir * 0.09 * e * classScale,
    }
  }

  if (phase === "active") {
    // Fast whip through the center of the arc (steepest slope at u ≈ 0.45)
    const e = smoother(clamp(u * 1.08, 0, 1))
    const apex = Math.sin(u * Math.PI)
    return {
      yawAdd: coilYaw + (whipYaw - coilYaw) * e,
      pitchAdd: coilPitch + (lungePitch - coilPitch) * smooth(u) + 0.06 * apex,
      rollAdd: dir * (0.09 * (1 - 2 * e)) * classScale,
    }
  }

  // recovery
  const hold = u < 0.22 ? 0 : smoother((u - 0.22) / 0.78)
  return {
    yawAdd: whipYaw + (readyYaw - whipYaw) * hold,
    pitchAdd: lungePitch + (readyPitch - lungePitch) * hold,
    rollAdd: -dir * 0.08 * (1 - hold) * classScale,
  }
}

/**
 * Solves right and left arm IK and weapon attachment frame for a posed torso.
 * Guarantees hand targets stay within natural two-bone reach (`<= 0.51 m` from shoulder) and
 * positions the weapon clearly outside the body silhouette for top-down readability.
 */
export function poseMeleeArms(torso: Frame, input: MeleePoseInput): MeleePoseResult {
  const { weaponClass, phase, combo, charge, heavy, weaponLength } = input
  const u = clamp(input.phaseProgress, 0, 1)
  const gait = clamp(input.gait ?? 0, 0, 1)
  const armSwing = clamp(input.armSwing ?? 0, -1, 1)
  const isTwoHand = weaponClass === "two-heavy"
  const isBlade = weaponClass === "one-blade"
  const isFinisher = combo === 3 || heavy
  const chargeAmt = clamp(charge, 0, 1)

  // Local coordinates relative to shoulder height (y = 0 at shoulder plane `RIG.shoulderY`)
  const shY = RIG.shoulderY
  const swingBob = 0.03 * armSwing * gait

  // Ready pose in torso space: weapon held out to the right side so its silhouette reads from overhead
  const readyR: V3 = isTwoHand
    ? [0.22 + swingBob, shY - 0.16, 0.28]
    : isBlade
      ? [0.28 + swingBob, shY - 0.13, 0.23]
      : [0.24 + swingBob, shY - 0.15, 0.26]
  const readyGuardL: V3 = [0.25 - swingBob * 0.8, shY - 0.18, -0.21]

  // Ready weapon angles in torso space (yaw relative to torso +x; positive yaw points out to the right/+z)
  const readyWpnYaw = isTwoHand ? 0.58 : isBlade ? 0.36 : 0.48
  const readyWpnPitch = isTwoHand ? 0.38 : isBlade ? 0.18 : 0.32
  const readyWpnRoll = isBlade ? 0.25 : 0.12

  // Windup / Active / Recovery key targets in torso space
  // Note: torso itself also coils by `meleeTorsoModulation`, so world-space arc = torso coil + local arm sweep!
  const c1WindR: V3 = isTwoHand
    ? [-0.14 - 0.06 * chargeAmt, shY + 0.04 + 0.06 * chargeAmt, 0.37 + 0.03 * chargeAmt]
    : [-0.12 - 0.06 * chargeAmt, shY + 0.02 + 0.05 * chargeAmt, 0.38 + 0.04 * chargeAmt]
  const c1EndR: V3 = isTwoHand
    ? [0.22, shY - 0.12, -0.24]
    : [0.24, shY - 0.10, -0.28]

  const c2WindR: V3 = isTwoHand
    ? [0.18, shY - 0.04, -0.26]
    : [0.18, shY - 0.04, -0.30]
  const c2EndR: V3 = isTwoHand
    ? [0.14, shY - 0.12, 0.38]
    : [0.12, shY - 0.10, 0.40]

  const c3WindR: V3 = isTwoHand
    ? [-0.16 - 0.05 * chargeAmt, shY + 0.16 + 0.06 * chargeAmt, 0.33]
    : [-0.14 - 0.05 * chargeAmt, shY + 0.14 + 0.06 * chargeAmt, 0.35]
  const c3EndR: V3 = isTwoHand
    ? [0.26, shY - 0.18, -0.22]
    : [0.28, shY - 0.16, -0.26]

  const windR = combo === 2 ? c2WindR : isFinisher ? c3WindR : c1WindR
  const endR = combo === 2 ? c2EndR : isFinisher ? c3EndR : c1EndR

  // Weapon orientation angles in torso space at windup and follow-through
  const windWpnYaw =
    combo === 2
      ? -(1.25 + 0.20 * chargeAmt)
      : (isTwoHand ? 1.58 : 1.42) + 0.28 * chargeAmt + (isFinisher ? 0.15 : 0)
  const endWpnYaw =
    combo === 2
      ? (isTwoHand ? 1.38 : 1.32)
      : -(isTwoHand ? 1.35 : 1.28) - (isFinisher ? 0.15 : 0)

  const windWpnPitch = isFinisher ? 0.62 + 0.18 * chargeAmt : combo === 2 ? 0.12 : 0.28 + 0.12 * chargeAmt
  const endWpnPitch = isFinisher ? -0.24 : -0.08

  let localR: V3
  let localGuardL: V3
  let wpnYaw = readyWpnYaw
  let wpnPitch = readyWpnPitch
  let wpnRoll = readyWpnRoll

  if (phase === "idle") {
    localR = readyR
    localGuardL = readyGuardL
  } else if (phase === "windup") {
    const e = smooth(u)
    localR = lerp3(readyR, windR, e)
    const windGuardL: V3 = combo === 2 ? [0.26, shY - 0.16, -0.26] : [0.32, shY - 0.12, -0.24]
    localGuardL = lerp3(readyGuardL, windGuardL, e)
    wpnYaw = readyWpnYaw + (windWpnYaw - readyWpnYaw) * e
    wpnPitch = readyWpnPitch + (windWpnPitch - readyWpnPitch) * e
    wpnRoll = combo === 2 ? -0.35 * e : (isFinisher ? 0.45 : 0.25) * e
  } else if (phase === "active") {
    // Circular arc interpolation in torso X/Z so the hand sweeps out in front (+x ≈ 0.44..0.48 m at u=0.5)
    // instead of cutting linearly through the chest!
    const e = smoother(u)
    const ang0 = Math.atan2(windR[2], windR[0])
    let ang1 = Math.atan2(endR[2], endR[0])
    if (combo === 2 && ang1 < ang0) ang1 += Math.PI * 2
    if (combo !== 2 && ang1 > ang0) ang1 -= Math.PI * 2
    const ang = ang0 + (ang1 - ang0) * e
    const r0 = Math.hypot(windR[0], windR[2])
    const r1 = Math.hypot(endR[0], endR[2])
    const apexExtend = Math.sin(u * Math.PI) * (isTwoHand ? 0.08 : 0.11)
    const rad = r0 + (r1 - r0) * e + apexExtend
    const y = windR[1] + (endR[1] - windR[1]) * e + (isFinisher ? 0.06 * Math.sin(u * Math.PI) : 0)
    localR = [Math.cos(ang) * rad, y, Math.sin(ang) * rad]

    const endGuardL: V3 = combo === 2 ? [0.22, shY - 0.18, -0.28] : [0.20, shY - 0.18, -0.22]
    localGuardL = lerp3([0.32, shY - 0.12, -0.24], endGuardL, e)

    wpnYaw = windWpnYaw + (endWpnYaw - windWpnYaw) * e
    // Flatten pitch near mid-swing (u = 0.5) so the blade/club sweeps horizontally through target chest/head height
    const midPitch = isFinisher ? 0.06 : 0.02
    wpnPitch =
      u < 0.5
        ? windWpnPitch + (midPitch - windWpnPitch) * smooth(u * 2)
        : midPitch + (endWpnPitch - midPitch) * smooth((u - 0.5) * 2)
    wpnRoll = combo === 2 ? -0.55 : isBlade ? 0.48 : 0.22
  } else {
    // recovery
    const hold = u < 0.20 ? 0 : smoother((u - 0.20) / 0.80)
    localR = lerp3(endR, readyR, hold)
    localGuardL = lerp3([0.20, shY - 0.18, -0.24], readyGuardL, hold)
    wpnYaw = endWpnYaw + (readyWpnYaw - endWpnYaw) * hold
    wpnPitch = endWpnPitch + (readyWpnPitch - endWpnPitch) * hold
    wpnRoll = (combo === 2 ? -0.55 : 0.25) * (1 - hold) + readyWpnRoll * hold
  }

  // Clamp right hand target distance from right shoulder so two-bone IK never overstretches
  const shRLocal: V3 = [0, shY, RIG.shoulderW]
  const shLLocal: V3 = [0, shY, -RIG.shoulderW]
  const clampToShoulder = (target: V3, sh: V3, maxReach = 0.50): V3 => {
    const dx = target[0] - sh[0]
    const dy = target[1] - sh[1]
    const dz = target[2] - sh[2]
    const d = Math.hypot(dx, dy, dz)
    if (d <= maxReach || d < 1e-5) return target
    const s = maxReach / d
    return [sh[0] + dx * s, sh[1] + dy * s, sh[2] + dz * s]
  }

  const clampedLocalR = clampToShoulder(localR, shRLocal, 0.50)
  const handR = at(torso, clampedLocalR[0], clampedLocalR[1], clampedLocalR[2])

  // Construct the weapon frame anchored at handR
  let weapon = moved(torso, handR)
  weapon = yawBy(weapon, wpnYaw)
  weapon = pitch(weapon, wpnPitch)
  weapon = roll(weapon, wpnRoll)

  // For two-handed weapons, anchor the left hand to the lower handle of the weapon (clamped to left-shoulder reach)
  let handL: V3
  if (isTwoHand) {
    const gripOffset = at(weapon, -0.09, -0.015, -0.02)
    const shLWorld = at(torso, shLLocal[0], shLLocal[1], shLLocal[2])
    const dVec = sub(gripOffset, shLWorld)
    const dLen = Math.hypot(dVec[0], dVec[1], dVec[2])
    if (dLen > 0.51) {
      const s = 0.51 / dLen
      handL = [shLWorld[0] + dVec[0] * s, shLWorld[1] + dVec[1] * s, shLWorld[2] + dVec[2] * s]
      // Re-aim weapon shaft cleanly through (handL -> handR) when two-handed
      const shaftDir = norm(sub(at(weapon, 0.45, 0, 0), handL))
      weapon = aimFrame(handR, shaftDir, torso.y)
    } else {
      handL = gripOffset
    }
  } else {
    const clampedLocalL = clampToShoulder(localGuardL, shLLocal, 0.48)
    handL = at(torso, clampedLocalL[0], clampedLocalL[1], clampedLocalL[2])
  }

  // Solve two-bone IK for both arms with chord-adaptive outward/posterior elbow poles
  const solveArm = (side: -1 | 1, target: V3) => {
    const sh = at(torso, 0, shY, side * RIG.shoulderW)
    const dWorld = sub(target, sh)
    const dx = dot(dWorld, torso.x)
    const dy = dot(dWorld, torso.y)
    const dz = dot(dWorld, torso.z) * side
    const lift = clamp((dy + 0.30) / 0.45, 0, 1)
    const crossIn = clamp((-dz + 0.15) / 0.35, 0, 1)
    const back = clamp((-dx + 0.10) / 0.35, 0, 1)
    const pole = dirIn(
      torso,
      -0.75 - 0.35 * lift + 0.35 * crossIn,
      -0.75 + 0.55 * back - 0.25 * crossIn,
      side * (0.55 + 0.35 * lift + 0.25 * (1 - crossIn)),
    )
    const [el, wr] = ik(sh, target, RIG.upper, RIG.fore, pole)
    return {
      ua: limb(sh, el, torso.x, torso.y),
      fa: limb(el, wr, [0, 1, 0], torso.x),
    }
  }

  const armL = solveArm(-1, handL)
  const armR = solveArm(1, handR)

  // Anchor weapon origin to the solved right wrist (`at(armR.fa, 0, -RIG.fore, 0)`) so it never detaches from the hand
  const wristR = at(armR.fa, 0, -RIG.fore, 0)
  weapon = moved(weapon, wristR)
  const tip = at(weapon, weaponLength, 0, 0)

  return {
    handL,
    handR: wristR,
    ua: [armL.ua, armR.ua],
    fa: [armL.fa, armR.fa],
    weapon,
    tip,
  }
}
