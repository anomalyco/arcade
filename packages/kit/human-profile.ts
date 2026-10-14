import type { LabControl } from "./lab-navigation"
import { at, clamp, pitch, roll, type Frame, type V3 } from "./rig"

/** Flat, serializable presentation values; metres, radians and Hz. */
export type HumanProfile = {
  strideScale: number; swayScale: number; twistScale: number; leanScale: number
  hipDrop: number; bobScale: number; turnBank: number; stepLift: number
  armSwing: number; transitionHz: number
  runPosture: number; crouchDepth: number; headStability: number
  bodyHz: number; footCentreHz: number; chestHz: number; headHz: number
  timingBias: number; footDrag: number; torsoLean: number; torsoRoll: number
  headTilt: number; armAsymmetry: number; armReach: number
  handPose: "weapon" | "staff" | "reach"
}
export type HumanPreset = "soldier" | "wizard" | "zombie"
const soldier: Readonly<HumanProfile> = Object.freeze({
  strideScale: 1, swayScale: 1.6, twistScale: 1.6, leanScale: 1.25,
  hipDrop: 0.095, bobScale: 1, turnBank: 1, stepLift: 1,
  armSwing: 1, transitionHz: 6,
  runPosture: 0.34, crouchDepth: 0.08, headStability: 0.8,
  bodyHz: 3, footCentreHz: 4, chestHz: 5, headHz: 7,
  timingBias: 0, footDrag: 0, torsoLean: 0, torsoRoll: 0,
  headTilt: 0, armAsymmetry: 0, armReach: 0.42, handPose: "weapon",
})
export const humanProfiles: Readonly<Record<HumanPreset, Readonly<HumanProfile>>> = Object.freeze({
  soldier,
  wizard: Object.freeze({ ...soldier, strideScale: 0.85, swayScale: 0.7, twistScale: 0.6, leanScale: 1,
    hipDrop: 0.06, bobScale: 0.7, turnBank: 0.8, stepLift: 0.85, armSwing: 0.8, transitionHz: 5.5,
    runPosture: 0.12, crouchDepth: 0.02, torsoLean: -0.04, handPose: "staff" }),
  zombie: Object.freeze({ ...soldier, strideScale: 0.8, leanScale: 1, hipDrop: 0.13, bobScale: 1.15, turnBank: 0.6, stepLift: 0.9,
    armSwing: 0.75, transitionHz: 4,
    runPosture: 0.18, crouchDepth: 0.03, headStability: 0.2, timingBias: 0.28, footDrag: 0.9,
    chestHz: 2, headHz: 1, torsoLean: 0.24, torsoRoll: 0.12, headTilt: 0.2,
    armAsymmetry: 0.13, handPose: "reach" }),
})

/** Apply before constructing shoulders/neck so their attachments never open a gap. */
export function profileTorso(frame: Frame, profile: HumanProfile): Frame {
  return roll(pitch(frame, -clamp(profile.torsoLean, -0.15, 0.35)), clamp(profile.torsoRoll, -0.2, 0.2))
}

/** Caller-owned action clips may replace these rest targets before IK. */
export function profileHands(torso: Frame, profile: HumanProfile): [V3, V3] | null {
  const asymmetry = clamp(profile.armAsymmetry, -0.18, 0.18)
  if (profile.handPose === "staff") return [at(torso, 0.22, 0.18, -0.24), at(torso, 0.30, 0.28, 0.28)]
  if (profile.handPose === "reach") {
    const reach = clamp(profile.armReach, 0.2, 0.52)
    return [
      at(torso, clamp(reach + asymmetry * 0.45, 0.2, 0.54), 0.35 + asymmetry, -0.15),
      at(torso, clamp(reach - asymmetry * 0.55, 0.18, 0.52), 0.27 - asymmetry * 0.85, 0.20),
    ]
  }
  return null
}

/** Live presentation controls; edits update the next animation step without resetting the scene. */
const range = (key: keyof HumanProfile, label: string, min: number, max: number, step: number, unit: string): LabControl => ({ key, label, group: "Animation", min, max, step, unit })
export const humanProfileControls: LabControl[] = [
  range("strideScale", "Stride", 0.6, 1.4, 0.05, "×"),
  range("swayScale", "Sway", 0, 2, 0.1, "×"), range("twistScale", "Twist", 0, 2, 0.1, "×"),
  range("leanScale", "Lean", 0, 2, 0.05, "×"),
  range("hipDrop", "Hip drop · rad", 0, 0.22, 0.01, "rad"),
  range("bobScale", "Bounce", 0, 2, 0.05, "×"),
  range("turnBank", "Turn bank", 0, 2, 0.05, "×"),
  range("stepLift", "Step lift", 0.5, 1.8, 0.05, "×"),
  range("armSwing", "Arm swing", 0, 2, 0.05, "×"),
  range("transitionHz", "Transition · Hz", 2, 14, 0.5, "Hz"),
  range("bodyHz", "Pelvis spring · Hz", 1, 8, 0.25, "Hz"),
  range("runPosture", "Run lean · rad", 0, 0.45, 0.01, "rad"),
  range("crouchDepth", "Crouch depth · m", 0, 0.16, 0.01, "m"),
  range("headStability", "Head stabilisation", 0, 1, 0.05, ""),
  range("footCentreHz", "Foot centre · Hz", 2, 8, 0.25, "Hz"), range("chestHz", "Chest spring · Hz", 1, 10, 0.25, "Hz"),
  range("headHz", "Head spring · Hz", 1, 12, 0.25, "Hz"),
  range("timingBias", "Uneven timing", -0.3, 0.3, 0.02, ""), range("footDrag", "Right foot drag", 0, 0.95, 0.05, ""),
  range("torsoLean", "Hunch", -0.15, 0.35, 0.02, "rad"), range("torsoRoll", "Torso cant", -0.2, 0.2, 0.02, "rad"),
  range("headTilt", "Head tilt", -0.3, 0.3, 0.02, "rad"), range("armAsymmetry", "Arm asymmetry", -0.18, 0.18, 0.02, "m"),
  range("armReach", "Reach", 0.2, 0.52, 0.02, "m"),
  { key: "handPose", label: "Hands", group: "Animation", options: [
    { label: "Weapon", value: "weapon" }, { label: "Staff", value: "staff" }, { label: "Reach", value: "reach" },
  ] },
]
