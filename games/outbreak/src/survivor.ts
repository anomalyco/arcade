import { Mesh, MAT } from "@arcade/kit/gpu/mesh"
import { Renderer, type Batch } from "@arcade/kit/gpu/renderer"
import type { LabControl } from "@arcade/kit/lab-panel"
import {
  RIG,
  HIP,
  at,
  clamp,
  dirIn,
  dot,
  emit,
  ik,
  kick,
  lerp3,
  limb,
  moved,
  pitch,
  roll,
  smooth,
  spring,
  stepSpring,
  smoother,
   sub,
  yawFrame,
  type Frame,
  type Spring,
  type V3,
  type PushPart,
} from "@arcade/kit/rig"
import {
  angleSpring,
  backpedalling,
  gaitAt,
  stepHash,
  stiffness,
  strafeFootOffset,
  strafeFootOpen,
  strafeHipLimit,
  strafeLegGoal,
  strafeSeparate,
  strafeStance,
} from "@arcade/kit/human-locomotion"
import { humanProfiles, profileHands, profileTorso, type HumanProfile } from "@arcade/kit/human-profile"
import { kneePole, poseArms, poseUnarmedArms, unarmedHands, type BonePose } from "@arcade/kit/human-pose"
import { meleeTorsoModulation, poseMeleeArms } from "@arcade/kit/human-melee"
import { shambleHandsFK, shambleTorsoModulation } from "@arcade/kit/shamble-crouch"
import { angleDiff } from "@arcade/kit/sim/geom"
import {
  isMeleeWeapon,
  MELEE_WEAPON_IDS,
  MELEE_WEAPONS,
  PISTOL_RELOAD_TIME,
  type MeleeWeaponId,
} from "../shared/combat"
import type { Survivor as Pose } from "../shared/session"
import { hex } from "./level"
import { BEAN_AUX, beanTint, DEFAULT_HERO_LOOK, HERO_AUX, heroShape, heroTint, softBeanShape } from "./look/hero"
import {
  buildColourBlocksSurvivorMeshes,
  resolveSurvivorVariant,
  SURVIVORS,
  type SurvivorVariantSpec,
} from "./look/survivors"
import { SURVIVOR_COLOURS } from "./seat-colours"
import { simpleFigureMeshes, softBeanMeshes, type SimpleFigureBone } from "@arcade/kit/avatar/simple-figure"

export const PISTOL_MUZZLE = 0.20
export const PISTOL_HOLD = { fwd: 0.375, up: 1.35, side: 0.045 } as const
export const PISTOL_LOW_READY = { fwd: 0.28, up: 1.13, side: 0.165 } as const
const REST_SHOULDER_Y = HIP + RIG.waist + RIG.shoulderY
const BLADE_PISTOL = 0.235
/** The crouch (Ctrl): how far the hips drop (m), how far the pelvis tips and how far the chest leans over the knees (rad). */
const STEALTH_DROP = 0.3
const STEALTH_PELVIS = 0.28
const STEALTH_CHEST = 0.34

/** Lab-tunable parameters for the survivor's pistol ready, aim, recoil and upper-body twist. */
export const survivorAimTuning = {
  aimRaiseTime: 0.15,
  aimHoldTime: 2.5,
  aimRecoil: 1.0,
  aimTwistLimit: 1.05,
  sideStepTurn: humanProfiles.soldier.sideStepTurn,
  strafeHipTurn: humanProfiles.soldier.strafeHipTurn,
  crossoverSpeed: humanProfiles.soldier.crossoverSpeed,
  strafeGap: humanProfiles.soldier.strafeGap,
  ...DEFAULT_HERO_LOOK,
}
export type SurvivorAimTuning = typeof survivorAimTuning

export const survivorAimControls: LabControl[] = [
  { key: "aimRaiseTime", label: "Raise time", group: "Survivor aim", min: 0.08, max: 0.35, step: 0.01, unit: "s" },
  { key: "aimHoldTime", label: "Hold time", group: "Survivor aim", min: 0.5, max: 5.0, step: 0.1, unit: "s" },
  { key: "aimRecoil", label: "Recoil", group: "Survivor aim", min: 0, max: 2.5, step: 0.05, unit: "×" },
  { key: "aimTwistLimit", label: "Twist limit · rad", group: "Survivor aim", min: 0.45, max: 1.55, step: 0.05, unit: "rad" },
  { key: "sideStepTurn", label: "Side-step hip turn · rad", group: "Survivor strafe", min: 0, max: 0.8, step: 0.05, unit: "rad" },
  { key: "strafeHipTurn", label: "Strafe hip turn · rad", group: "Survivor strafe", min: 0.3, max: 1.05, step: 0.05, unit: "rad" },
  { key: "crossoverSpeed", label: "Crossover speed · m/s", group: "Survivor strafe", min: 1.2, max: 5, step: 0.1, unit: "m/s" },
  { key: "strafeGap", label: "Side-step boot gap · m", group: "Survivor strafe", min: 0.12, max: 0.32, step: 0.01, unit: "m" },
]

export type SurvivorDrawPose = Pick<Pose, "x" | "y" | "vx" | "vy" | "aim"> &
  Partial<
    Pick<
      Pose,
      | "equippedItem"
      | "meleeWeapon"
      | "meleeDurability"
      | "meleeMaxDurability"
      | "meleePhase"
      | "meleePhaseTime"
      | "meleePhaseDuration"
      | "meleeCombo"
      | "meleeCharge"
      | "meleeHeavy"
      | "meleeFinisher"
      | "fireCooldown"
      | "reloadRemaining"
      | "recoil"
      | "shoveAnim"
      | "stompAnim"
      | "sprinting"
      | "channel"
      | "crouching"
    >
  > & {
    /** Optional deterministic override to hold raised aim without firing a shot. */
    aiming?: boolean
  }

/** Maps remaining/max melee durability to a visual wear stage: 0 = fresh, 1 = bent/worn, 2 = cracked/failing. */
export function weaponWearStage(durability?: number, maxDurability?: number): 0 | 1 | 2 {
  if (maxDurability === undefined || maxDurability <= 0 || durability === undefined) return 0
  const ratio = clamp(durability / maxDurability, 0, 1)
  if (ratio <= 0.25) return 2
  if (ratio <= 0.6) return 1
  return 0
}

/** Builds procedural 3D meshes for all 9 melee weapons (grip at origin, shaft/blade along +x) at a given wear stage. */
export function buildMeleeWeaponMeshes(wear: 0 | 1 | 2 = 0): Record<MeleeWeaponId, Mesh> {
  const dy = wear === 1 ? 0.042 : wear === 2 ? 0.088 : 0
  const dz = wear === 1 ? 0.026 : wear === 2 ? 0.056 : 0
  const gap = wear === 2 ? 0.014 : 0
  const crackCol = hex(0x161412)
  const rawSteel = hex(0x7d868e)
  const rawWood = hex(0x5e4328)

  const knife = new Mesh()
  knife.box(-0.04, -0.016, -0.014, 0.11, 0.018, 0.014, hex(0x28231e), MAT.actor)
  knife.box(0.11, -0.024, -0.018, 0.125, 0.026, 0.018, hex(0x7c8286), MAT.shiny)
  knife.box(0.125, -0.022, -0.005, 0.26, 0.02, 0.005, hex(wear === 2 ? 0x9aa2a8 : 0xd8dfe4), MAT.shiny)
  if (wear > 0) knife.box(0.25, -0.024, -0.008, 0.275, 0.012, 0.008, crackCol, MAT.actor)
  knife.box(0.26 + gap, -0.022 + dy * 0.6, -0.005 + dz * 0.6, 0.42, 0.02 + dy * 0.6, 0.005 + dz * 0.6, hex(wear > 0 ? 0xaeb6bc : 0xd8dfe4), MAT.shiny)

  const hammer = new Mesh()
  hammer.box(-0.05, -0.016, -0.015, 0.22, 0.016, 0.015, hex(0x9a6e42), MAT.timber)
  hammer.box(-0.05, -0.018, -0.017, 0.12, 0.018, 0.017, hex(0x2b2d30), MAT.actor)
  if (wear > 0) hammer.box(0.21, -0.019, -0.018, 0.24, 0.019, 0.018, crackCol, MAT.actor)
  hammer.box(0.22 + gap, -0.016 + dy * 0.7, -0.015 + dz * 0.7, 0.39, 0.016 + dy * 0.7, 0.015 + dz * 0.7, wear > 0 ? rawWood : hex(0x9a6e42), MAT.timber)
  hammer.box(0.36 + gap, -0.068 + dy * 0.7, -0.024 + dz * 0.7, 0.46 + gap, 0.068 + dy * 0.7, 0.024 + dz * 0.7, hex(0x4a5158), MAT.shiny)
  hammer.box(0.38 + gap, 0.068 + dy * 0.7, -0.02 + dz * 0.7, 0.44 + gap, 0.108 + dy * 0.7, 0.02 + dz * 0.7, hex(0x6e7780), MAT.shiny)

  const pipe = new Mesh()
  pipe.box(-0.06, -0.018, -0.018, 0.28, 0.018, 0.018, hex(0x697279), MAT.shiny)
  pipe.box(0.02, -0.021, -0.021, 0.16, 0.021, 0.021, hex(0x36393c), MAT.actor)
  if (wear > 0) pipe.box(0.27, -0.022, -0.022, 0.31, 0.022, 0.022, crackCol, MAT.actor)
  pipe.box(0.28 + gap, -0.018 + dy, -0.018 + dz, 0.58, 0.018 + dy, 0.018 + dz, hex(wear > 0 ? 0x555d63 : 0x697279), MAT.shiny)
  pipe.box(0.54, -0.032 + dy, -0.032 + dz, 0.64, 0.032 + dy, 0.032 + dz, hex(0x4e565d), MAT.shiny)

  const crowbarPaint = hex(wear === 2 ? 0x72221d : wear === 1 ? 0x942a24 : 0xb5322a)
  const crowbar = new Mesh()
  crowbar.box(-0.06, -0.021, -0.021, 0.28, 0.021, 0.021, crowbarPaint, MAT.actor)
  crowbar.box(0.02, -0.023, -0.023, 0.18, 0.023, 0.023, hex(0x2e3135), MAT.actor)
  crowbar.box(-0.09, -0.025, -0.015, -0.02, 0.025, 0.015, hex(0x7c8690), MAT.shiny)
  if (wear > 0) {
    // Visible stress bend & dark fracture notch mid-shaft where the crowbar is yielding
    crowbar.box(0.265, -0.025, -0.025, 0.305, 0.025, 0.025, crackCol, MAT.actor)
    crowbar.box(0.28, -0.018 + dy * 0.45, -0.018 + dz * 0.45, 0.46, 0.022 + dy * 0.45, 0.022 + dz * 0.45, rawSteel, MAT.shiny)
  }
  crowbar.box(0.28 + gap, -0.021 + dy, -0.021 + dz, 0.64, 0.021 + dy, 0.021 + dz, crowbarPaint, MAT.actor)
  crowbar.box(0.58 + gap, -0.025 + dy, -0.026 + dz, 0.72 + gap, 0.062 + dy, 0.028 + dz, hex(0x7c8690), MAT.shiny)
  crowbar.box(0.62 + gap, 0.055 + dy, -0.026 + dz, 0.71 + gap, 0.105 + dy, 0.036 + dz, hex(0x9ca8b2), MAT.shiny)

  const machete = new Mesh()
  machete.box(-0.05, -0.02, -0.016, 0.13, 0.02, 0.016, hex(0x3a2a1d), MAT.timber)
  machete.box(0.12, -0.03, -0.02, 0.145, 0.032, 0.02, hex(0x4a4e52), MAT.actor)
  machete.box(0.145, -0.028, -0.006, 0.36, 0.024, 0.006, hex(0xc2cbd2), MAT.shiny)
  if (wear > 0) machete.box(0.345, -0.03, -0.009, 0.38, 0.015, 0.009, crackCol, MAT.actor)
  machete.box(0.36 + gap, -0.028 + dy * 0.8, -0.006 + dz, 0.52, 0.024 + dy * 0.8, 0.006 + dz, hex(wear > 0 ? 0x9ca6ae : 0xc2cbd2), MAT.shiny)
  machete.box(0.48 + gap, -0.036 + dy, -0.006 + dz, 0.68, 0.028 + dy, 0.006 + dz, hex(wear > 0 ? 0xb0bac2 : 0xd8e0e6), MAT.shiny)

  const bat = new Mesh()
  bat.box(-0.08, -0.024, -0.024, -0.05, 0.024, 0.024, hex(0x8c663e), MAT.timber)
  bat.box(-0.05, -0.017, -0.017, 0.22, 0.017, 0.017, hex(0x282a2c), MAT.actor)
  bat.box(0.22, -0.024, -0.024, 0.42, 0.024, 0.024, hex(0xb88b58), MAT.timber)
  if (wear > 0) bat.box(0.40, -0.028, -0.028, 0.445, 0.028, 0.028, crackCol, MAT.actor)
  bat.box(0.42 + gap, -0.034 + dy, -0.034 + dz, 0.78, 0.034 + dy, 0.034 + dz, wear > 0 ? rawWood : hex(0xc69862), MAT.timber)

  const spikedBoard = new Mesh()
  spikedBoard.box(-0.08, -0.022, -0.016, 0.24, 0.022, 0.016, hex(0x524c44), MAT.actor)
  spikedBoard.box(0.2, -0.042, -0.022, 0.44, 0.042, 0.022, hex(0x8e6b44), MAT.timber)
  if (wear > 0) spikedBoard.box(0.42, -0.046, -0.025, 0.465, 0.046, 0.025, crackCol, MAT.actor)
  spikedBoard.box(0.44 + gap, -0.042 + dy, -0.022 + dz, 0.84, 0.042 + dy, 0.022 + dz, wear > 0 ? rawWood : hex(0x8e6b44), MAT.timber)
  for (const sx of [0.54, 0.64, 0.73, 0.8]) {
    spikedBoard.box(sx - 0.008 + gap, -0.095 + dy, -0.008 + dz, sx + 0.008 + gap, 0.095 + dy, 0.008 + dz, hex(0x9ca6ae), MAT.shiny)
  }

  const axe = new Mesh()
  axe.box(-0.08, -0.018, -0.015, 0.34, 0.018, 0.015, hex(0x966a3e), MAT.timber)
  if (wear > 0) axe.box(0.325, -0.022, -0.019, 0.365, 0.022, 0.019, crackCol, MAT.actor)
  axe.box(0.34 + gap, -0.018 + dy, -0.015 + dz, 0.66, 0.018 + dy, 0.015 + dz, wear > 0 ? rawWood : hex(0x966a3e), MAT.timber)
  axe.box(0.54 + gap, -0.055 + dy, -0.024 + dz, 0.68 + gap, 0.045 + dy, 0.024 + dz, hex(0x3a4046), MAT.actor)
  axe.box(0.52 + gap, -0.115 + dy, -0.012 + dz, 0.7 + gap, -0.045 + dy, 0.012 + dz, hex(0xc8d2da), MAT.shiny)

  const fireAxe = new Mesh()
  fireAxe.box(-0.1, -0.02, -0.016, 0.42, 0.02, 0.016, hex(0xa87c4f), MAT.timber)
  if (wear > 0) fireAxe.box(0.405, -0.025, -0.021, 0.445, 0.025, 0.021, crackCol, MAT.actor)
  fireAxe.box(0.42 + gap, -0.021 + dy, -0.017 + dz, 0.84, 0.021 + dy, 0.017 + dz, hex(wear > 0 ? 0x761b18 : 0x9e2420), MAT.actor)
  fireAxe.box(0.68 + gap, -0.065 + dy, -0.026 + dz, 0.84 + gap, 0.055 + dy, 0.026 + dz, hex(0x9e2420), MAT.actor)
  fireAxe.box(0.66 + gap, -0.135 + dy, -0.012 + dz, 0.88 + gap, -0.055 + dy, 0.012 + dz, hex(0xd8e2ea), MAT.shiny)
  fireAxe.box(0.72 + gap, 0.055 + dy, -0.014 + dz, 0.8 + gap, 0.125 + dy, 0.014 + dz, hex(0xb8c2ca), MAT.shiny)

  return {
    knife,
    hammer,
    pipe,
    crowbar,
    machete,
    bat,
    "spiked-board": spikedBoard,
    axe,
    "fire-axe": fireAxe,
  }
}

type ReloadGunKey = readonly [t: number, pitch: number, roll: number, pull: number, drop: number, yaw: number]
type ReloadHandKey =
  | readonly [t: number, space: "home"]
  | readonly [t: number, space: "gun" | "torso" | "pelvis", x: number, y: number, z: number]

const PISTOL_RELOAD_GUN: readonly ReloadGunKey[] = [
  [0.00, 0.00, 0.00, 0.00, 0.00, 0.00],
  [0.12, 0.24, 0.68, 0.11, 0.07, 0.32],
  [0.54, 0.28, 0.74, 0.12, 0.08, 0.36],
  [0.64, 0.14, 0.42, 0.09, 0.04, 0.22],
  [0.78, 0.06, 0.16, 0.13, 0.03, 0.12],
  [0.90, -0.02, 0.04, 0.03, 0.01, 0.02],
  [1.00, 0.00, 0.00, 0.00, 0.00, 0.00],
]

const PISTOL_RELOAD_LEFT: readonly ReloadHandKey[] = [
  [0.00, "home"],
  [0.12, "gun", -0.02, -0.11, -0.03],
  [0.26, "pelvis", -0.01, 0.01, -0.12],
  [0.38, "pelvis", 0.01, 0.02, -0.12],
  [0.52, "gun", -0.02, -0.13, -0.02],
  [0.62, "gun", 0.00, -0.045, -0.01],
  [0.74, "gun", 0.02, 0.048, -0.018],
  [0.82, "gun", -0.045, 0.048, -0.018],
  [0.94, "home"],
  [1.00, "home"],
]

function keyedReload<T extends readonly [number, ...unknown[]]>(keys: readonly T[], t: number): [T, T, number] {
  let i = 0
  while (i < keys.length - 1 && keys[i + 1]![0] <= t) i++
  const a = keys[i]!
  const b = keys[Math.min(i + 1, keys.length - 1)]!
  const span = b[0] - a[0]
  return [a, b, span > 0 ? smooth((t - a[0]) / span) : 1]
}

/**
 * Outbreak's survivor rig: planted-foot terrain gait + Blackout's stabilised shoulder weapon frame,
 * low-ready pistol carry, fast anticipation-free raise to two-handed aim on fire, per-shot recoil,
 * configurable post-shot aim hold, and keyframed magazine-to-grip reload.
 */
const OFFLINE_PALETTE = { torso: 0x8c6b42, legs: 0x41474b }

export class Survivor {
  /** Optional presentation override; does not change the Session's player or movement. */
  profile?: HumanProfile
  aimTuning: SurvivorAimTuning = { ...survivorAimTuning }
  /** Automation-only flag for before/after visual comparisons. */
  legacyUnarmedPistol = false
  seed = 17
  bones: BonePose = {}
  gun: Frame | null = null
  mag: Frame | null = null
  meleeWeaponFrame: Frame | null = null
  meleeTip: V3 | null = null
  meleeWearStage: 0 | 1 | 2 = 0
  /**
   * Where the flashlight sits this frame and the way it points: the pistol's light under the barrel when a pistol is
   * drawn (it follows low-ready, raised aim, recoil and reload), otherwise the right hand pointing along the aim.
   */
  readonly light: { p: V3; d: V3; mounted: boolean } = { p: [0, 1.3, 0], d: [1, 0, 0], mounted: false }
  aimWeight = 0
  holdRemaining = 0
  recBack = spring()
  recPitch = spring()
  recYaw = spring()
  recRoll = spring()
  torsoKick = spring()
  private chest = spring()
  private head = spring()
  private reachDrop = spring()
  /** 0 standing, 1 crouched low (Ctrl, D-19 verbs): knees bent, hips down, chest over the knees. */
  private stealth = spring()
  private twist = spring()
  private arms = [spring(), spring()] as const
  private hands = [spring(), spring()] as const
  private aimSpring = spring()
  private weaponYaw = spring()
  private gunPos: [Spring, Spring, Spring] = [spring(), spring(), spring()]
  private gunInit = false
  private prevSupportY = 0
  private prevAim = 0
  private prevFireCooldown = 0
  private prevRecoil = 0
  private prevReloadRemaining = 0
  private remoteReloadElapsed = 0
  private sinceShot = 10
  private shotCount = 0
  private back = false
  private backness = 0
  private yawOffset = spring()
  private pelvisYaw = spring()
  private strafeProfile: HumanProfile = { ...humanProfiles.soldier }
  private models: number[]
  /** Model ids per shape (today's boxes, mannequin, capsule, Soft Bean, today refined), in the same part order as `models`. */
  private shapes: number[][]
  /** Linear jacket colour of a co-op seat, tinting the simple styles; null offline. */
  private seat: [number, number, number] | null
  /** Co-op seat index (0 offline), picking Soft Bean's colour. */
  private seatIndex: number
  /** Character index in `SURVIVORS` (0 solo, seat index by default in co-op, or lobby-selected variant). */
  variantIndex: number
  private paletteOverride?: { torso: number; legs: number }
  private renderer: Pick<Renderer, "addModel"> & Partial<Pick<Renderer, "setModel">>
  /** Soft Bean's shape knobs its meshes were last built from; it is built on first use and rebuilt when they change. */
  private beanKey = ""
  private meleeModels: Record<MeleeWeaponId, [number, number, number]>
  private feet = [-1, 1].map(() => ({
    p: [0, 0, 0] as V3,
    lift: [0, 0, 0] as V3,
    target: [0, 0, 0] as V3,
    prevU: 0,
    planted: true,
    yaw: 0,
    stepReach: 1,
    stepLat: 0,
    stepLift: 1,
    stepToe: 0,
  }))
  private stepCount = 0
  private phase = 0
  private yaw = 0
  private last: [number, number] = [Infinity, Infinity]
  private svx = 0
  private svy = 0
  private leanX = spring()
  private leanY = spring()
  private data = new Float32Array(17 * 12)
  readonly batches: Batch[] = []
  /** Each foot contact (plan x, y and body speed in m/s): footstep sounds land on the rig's own gait. */
  onFootfall?: (x: number, y: number, speed: number) => void

  /**
   * `paletteOrSeat` recolours Today's jacket and trousers (or passes a co-op seat index directly);
   * `variant` selects the Colour Blocks character from `SURVIVORS` (defaults to 0 solo, or seat index in co-op).
   */
  constructor(
    renderer: Pick<Renderer, "addModel"> & Partial<Pick<Renderer, "setModel">>,
    paletteOrSeat: { torso: number; legs: number } | number = OFFLINE_PALETTE,
    variant?: number,
  ) {
    this.renderer = renderer
    const numericSeat = typeof paletteOrSeat === "number" ? Math.max(0, Math.trunc(paletteOrSeat)) : null
    const palette: { torso: number; legs: number } =
      typeof paletteOrSeat === "number"
        ? numericSeat === 0
          ? OFFLINE_PALETTE
          : SURVIVOR_COLOURS[numericSeat! % SURVIVOR_COLOURS.length]!
        : paletteOrSeat
    const colourIdx = SURVIVOR_COLOURS.indexOf(palette as (typeof SURVIVOR_COLOURS)[number])
    this.seat = palette === OFFLINE_PALETTE ? null : (hex(palette.torso).map(c => c ** 2.2) as [number, number, number])
    this.seatIndex = numericSeat !== null ? numericSeat : Math.max(0, colourIdx)
    const rawVariant = variant ?? this.seatIndex
    this.variantIndex = ((Math.trunc(rawVariant) % SURVIVORS.length) + SURVIVORS.length) % SURVIVORS.length
    const isStandardPalette = palette === OFFLINE_PALETTE || colourIdx >= 0
    this.paletteOverride = isStandardPalette ? undefined : palette
    const box = (w: number, y0: number, h: number, d: number, color: number) => {
      const m = new Mesh()
      m.box(-w / 2, y0, -d / 2, w / 2, y0 + h, d / 2, hex(color), MAT.actor)
      return m
    }
    const pelvis = box(0.25, -0.07, 0.18, 0.34, palette.legs)
    const torso = box(0.28, -0.02, 0.48, 0.4, palette.torso)
    torso.box(-0.29, 0.07, -0.15, -0.14, 0.4, 0.15, hex(0x4d6259), MAT.actor)
    torso.box(-0.3, 0.28, -0.14, -0.28, 0.32, 0.14, hex(0xa3a48a), MAT.actor)
    const head = box(0.18, 0.01, 0.24, 0.18, 0xad8266)
    head.box(-0.1, 0.19, -0.11, 0.1, 0.28, 0.11, hex(0x3b342d), MAT.actor)
    const foot = new Mesh()
    foot.box(-0.075, -0.075, -0.068, 0.125, 0.015, 0.068, hex(0x3b3029), MAT.actor)
    foot.box(-0.078, -0.085, -0.07, 0.128, -0.065, 0.07, hex(0x181412), MAT.actor)
    const toe = new Mesh()
    toe.box(-0.008, 0.015, -0.065, 0.06, 0.082, 0.065, hex(0x3b3029), MAT.actor)
    toe.box(-0.006, 0, -0.068, 0.065, 0.02, 0.068, hex(0x181412), MAT.actor)

    // Compact 9mm semi-auto pistol (grip at origin, barrel along +x, muzzle at +0.20 m)
    const pistol = new Mesh()
    pistol.box(-0.035, -0.095, -0.018, 0.03, 0.005, 0.018, hex(0x25282a), MAT.actor)
    pistol.box(-0.045, 0.005, -0.022, 0.18, 0.052, 0.022, hex(0x43494e), MAT.actor)
    pistol.box(0.18, 0.014, -0.012, 0.202, 0.042, 0.012, hex(0x222528), MAT.actor)
    pistol.box(0.155, 0.052, -0.006, 0.175, 0.064, 0.006, hex(0xe2d6c0), MAT.actor)
    pistol.box(-0.035, 0.052, -0.014, -0.015, 0.062, 0.014, hex(0x9ea49a), MAT.actor)

    // 9mm box magazine with brass top cartridge (visible in left hand during reload)
    const mag = new Mesh()
    mag.box(-0.022, -0.095, -0.014, 0.022, 0.0, 0.014, hex(0x2d3135), MAT.actor)
    mag.box(-0.018, 0.0, -0.011, 0.018, 0.012, 0.011, hex(0xd4a448), MAT.actor)

    this.models = [
      pelvis,
      torso,
      head,
      box(0.15, -0.29, 0.33, 0.15, palette.torso),
      box(0.11, -0.28, 0.3, 0.11, 0x9b7858),
      box(0.17, -0.42, 0.46, 0.17, palette.legs),
      box(0.13, -0.41, 0.43, 0.14, palette.legs),
      foot,
      pistol,
      mag,
      toe,
    ].map(m => renderer.addModel(m))
    const simple = (shape: "mannequin" | "capsule") => {
      const f = simpleFigureMeshes(shape, { aux: HERO_AUX })
      const ids = [f.pelvis, f.torso, f.head, f.upperArm, f.foreArm, f.thigh, f.shin, f.foot, null, null, f.toe]
      return ids.map((m, i) => (m ? renderer.addModel(m) : this.models[i]!))
    }
    const refined = buildColourBlocksSurvivorMeshes(this.variantIndex, this.paletteOverride)
    const refinedIds = [refined.pelvis, refined.torso, refined.head, refined.upperArm, refined.foreArm, refined.thigh, refined.shin, refined.foot, null, null, refined.toe]
      .map((m, i) => (m ? renderer.addModel(m) : this.models[i]!))
    this.shapes = [this.models, simple("mannequin"), simple("capsule"), [], refinedIds]
    const meleeMeshes0 = buildMeleeWeaponMeshes(0)
    const meleeMeshes1 = buildMeleeWeaponMeshes(1)
    const meleeMeshes2 = buildMeleeWeaponMeshes(2)
    this.meleeModels = Object.fromEntries(
      MELEE_WEAPON_IDS.map((id) => [
        id,
        [renderer.addModel(meleeMeshes0[id]), renderer.addModel(meleeMeshes1[id]), renderer.addModel(meleeMeshes2[id])],
      ]),
    ) as Record<MeleeWeaponId, [number, number, number]>
  }

  /** Resolved Colour Blocks character definition for this survivor's `variantIndex`. */
  get variant(): SurvivorVariantSpec {
    return resolveSurvivorVariant(this.variantIndex)
  }

  /** Switches this survivor's Colour Blocks character variant (`0..SURVIVORS.length - 1`) in place. */
  setVariant(variant: number): void {
    const next = ((Math.trunc(variant) % SURVIVORS.length) + SURVIVORS.length) % SURVIVORS.length
    if (next === this.variantIndex) return
    this.variantIndex = next
    const refined = buildColourBlocksSurvivorMeshes(this.variantIndex, this.paletteOverride)
    const order = [refined.pelvis, refined.torso, refined.head, refined.upperArm, refined.foreArm, refined.thigh, refined.shin, refined.foot, null, null, refined.toe]
    const ids = this.shapes[4]!
    const setModel = this.renderer.setModel?.bind(this.renderer)
    order.forEach((mesh, i) => {
      if (!mesh) ids[i] = this.models[i]!
      else if (setModel) setModel(ids[i]!, mesh)
      else ids[i] = this.renderer.addModel(mesh)
    })
  }

  /** Builds Soft Bean's meshes, or rebuilds them in place when its shape knobs changed. */
  private ensureBean(tune: SurvivorAimTuning): void {
    const shape = softBeanShape(tune)
    const key = JSON.stringify(shape)
    if (key === this.beanKey) return
    const f = softBeanMeshes(shape, { aux: BEAN_AUX })
    const order: (SimpleFigureBone | null)[] = ["pelvis", "torso", "head", "upperArm", "foreArm", "thigh", "shin", "foot", null, null, "toe"]
    const ids = this.shapes[3]!
    const setModel = this.renderer.setModel?.bind(this.renderer)
    order.forEach((bone, i) => {
      if (!bone) ids[i] = this.models[i]!
      else if (ids.length > i && setModel) setModel(ids[i]!, f[bone])
      else ids[i] = this.renderer.addModel(f[bone])
    })
    this.beanKey = key
  }

  reset(): void {
    this.last = [Infinity, Infinity]
    this.phase = this.yaw = this.svx = this.svy = this.stepCount = 0
    this.leanX = spring()
    this.leanY = spring()
    this.reachDrop = spring()
    this.twist = spring()
    this.arms[0].x = this.arms[0].v = this.arms[1].x = this.arms[1].v = 0
    this.hands[0].x = this.hands[0].v = this.hands[1].x = this.hands[1].v = 0
    this.chest = spring()
    this.head = spring()
    this.aimSpring = spring()
    this.weaponYaw = spring()
    this.gunPos = [spring(), spring(), spring()]
    this.gunInit = false
    this.prevSupportY = 0
    this.prevAim = 0
    this.prevFireCooldown = 0
    this.prevRecoil = 0
    this.prevReloadRemaining = 0
    this.remoteReloadElapsed = 0
    this.sinceShot = 10
    this.shotCount = 0
    this.back = false
    this.yawOffset = spring()
    this.pelvisYaw = spring()
    this.aimWeight = 0
    this.holdRemaining = 0
    this.recBack = spring()
    this.recPitch = spring()
    this.recYaw = spring()
    this.recRoll = spring()
    this.torsoKick = spring()
    this.bones = {}
    this.gun = null
    this.mag = null
    this.meleeWeaponFrame = null
    this.meleeTip = null
  }

  draw(
    p: SurvivorDrawPose,
    dt: number,
    time: number,
    support: (x: number, z: number) => number,
    tuning?: Partial<SurvivorAimTuning>,
  ): Batch[] {
    dt = Math.max(0.0001, Math.min(0.2, dt))
    if (tuning) Object.assign(this.aimTuning, tuning)
    const tune = this.aimTuning
    const prevX = this.last[0]
    const prevY = this.last[1]
    const teleport = Math.hypot(p.x - prevX, p.y - prevY) > 2.5
    this.last = [p.x, p.y]

    const profile = this.profile
    const isZombie = Boolean(profile && profile.handPose === "reach")
    const isStaff = Boolean(profile && profile.handPose === "staff")
    const meleeId: MeleeWeaponId | null =
      !isZombie && !isStaff && (!p.channel || p.channel.kind === "pry")
        ? isMeleeWeapon(p.meleeWeapon)
          ? p.meleeWeapon
          : isMeleeWeapon(p.equippedItem)
            ? p.equippedItem
            : p.channel?.kind === "pry"
              ? "crowbar"
              : null
        : null
    const isMelee = meleeId !== null
    const isPistol =
      p.equippedItem === "pistol" && !isMelee && !isZombie && !isStaff && !p.channel && !this.legacyUnarmedPistol

    if (teleport) {
      this.yaw = p.aim
      this.prevAim = p.aim
      this.svx = p.vx
      this.svy = p.vy
      this.phase = 0
      this.back = false
      this.yawOffset = spring()
      this.pelvisYaw = { x: p.aim, v: 0 }
      this.chest = { x: p.aim, v: 0 }
      this.head = { x: p.aim, v: 0 }
      this.weaponYaw = { x: p.aim, v: 0 }
      this.reachDrop = spring()
      this.twist = spring()
      this.arms[0].x = this.arms[0].v = this.arms[1].x = this.arms[1].v = 0
      this.hands[0].x = this.hands[0].v = this.hands[1].x = this.hands[1].v = 0
      this.gunInit = false
    }

    const totalDAim = teleport ? 0 : angleDiff(p.aim, this.prevAim)
    this.prevAim = p.aim

    // Detect newly fired shots from either fireCooldown (local) or recoil jump (local & co-op remote snapshots)
    const cooldownNow = p.fireCooldown ?? 0
    const recoilNow = p.recoil ?? 0
    const reloadNow = p.reloadRemaining ?? 0
    const fired =
      isPistol &&
      (cooldownNow > this.prevFireCooldown + 0.01 ||
        (recoilNow > this.prevRecoil + 0.08 && this.sinceShot > 0.08) ||
        (recoilNow > 0.75 && this.prevRecoil <= 0.75 && this.sinceShot > 0.08))
    this.prevFireCooldown = cooldownNow
    this.prevRecoil = recoilNow

    const raiseTime = clamp(tune.aimRaiseTime, 0.08, 0.35)
    const holdTime = clamp(tune.aimHoldTime, 0.5, 5.0)
    const recoilScale = clamp(tune.aimRecoil, 0, 2.5)
    const twistLimit = clamp(tune.aimTwistLimit, 0.45, 1.55)
    this.strafeProfile.sideStepTurn = tune.sideStepTurn
    this.strafeProfile.strafeHipTurn = tune.strafeHipTurn
    this.strafeProfile.crossoverSpeed = tune.crossoverSpeed
    this.strafeProfile.strafeGap = tune.strafeGap

    if (fired) {
      const sc = ++this.shotCount
      const j = stepHash(this.seed, sc, 7)
      kick(this.recBack, recoilScale * 0.052, 1200)
      kick(this.recPitch, recoilScale * 0.24, 1100)
      kick(this.recYaw, recoilScale * j * 0.02, 1100)
      kick(this.recRoll, recoilScale * j * 0.038, 1100)
      kick(this.torsoKick, recoilScale * 0.038, 280)
      this.holdRemaining = holdTime
      this.sinceShot = 0
      if (this.aimSpring.x < 0.85) {
        this.aimSpring.v = Math.max(this.aimSpring.v, 0.85 / raiseTime)
      }
    }

    // Track reload clip progress (0..1) for both local countdown and remote co-op boolean snapshot
    let reloadClipT: number | null = null
    if (isPistol && reloadNow > 0) {
      if (this.prevReloadRemaining <= 0) {
        this.remoteReloadElapsed = 0
      } else if (Math.abs(reloadNow - this.prevReloadRemaining) < 1e-4) {
        this.remoteReloadElapsed += dt
      }
      if (Math.abs(reloadNow - 0.5) < 1e-4 && this.remoteReloadElapsed > 0) {
        reloadClipT = clamp((this.remoteReloadElapsed / PISTOL_RELOAD_TIME) % 1, 0, 0.999)
      } else {
        reloadClipT = clamp(1 - reloadNow / PISTOL_RELOAD_TIME, 0, 1)
      }
      this.holdRemaining = Math.max(this.holdRemaining, 0.9)
    } else {
      this.remoteReloadElapsed = 0
    }
    this.prevReloadRemaining = reloadNow

    if (p.aiming && isPistol) {
      if (this.holdRemaining <= 0 && this.aimSpring.x < 0.05) {
        this.aimSpring.v = Math.max(this.aimSpring.v, 0.95 / raiseTime)
      }
      this.holdRemaining = Math.max(this.holdRemaining, holdTime)
    } else if (!isPistol) {
      this.holdRemaining = 0
    }

    const steps = teleport ? 1 : Math.max(1, Math.ceil(dt / (1 / 60) - 1e-4))
    const h = dt / steps
    const dAimStep = totalDAim / steps
    let moving = 0

    for (let step = 1; step <= steps; step++) {
      const uStep = step / steps
      const sx = teleport ? p.x : prevX + (p.x - prevX) * uStep
      const sy = teleport ? p.y : prevY + (p.y - prevY) * uStep
      const k = 1 - Math.exp(-h * 14)
      const vx = this.svx + (p.vx - this.svx) * k
      const vy = this.svy + (p.vy - this.svy) * k
      const speed = Math.hypot(vx, vy)
      moving = Math.min(1, speed / 3.4)
      const activeProfile = profile ?? this.strafeProfile
      // Direction-aware stepping shared with Blackout: hips turn partly toward travel, side-steps never cross and
      // run-speed strafes cross over cleanly (strafeStance), with a continuous forward/backpedal flip.
      const travelDir = speed > 0.35 ? Math.atan2(vy, vx) : p.aim
      const stance = strafeStance(speed > 0.2 ? speed : 0, this.yaw, travelDir, activeProfile)
      const curGait = gaitAt(speed, stance.backness, stance.sideStep, activeProfile)
      this.backness = stance.backness
      const runBlend = curGait.run
      const leanScale = 0.25 + 0.75 * runBlend
      stepSpring(this.leanX, 90, 0.38, h, vx * 0.028 * leanScale + ((vx - this.svx) / h) * 0.003)
      stepSpring(this.leanY, 90, 0.38, h, vy * 0.028 * leanScale + ((vy - this.svy) / h) * 0.003)
      this.svx = vx
      this.svy = vy

      const effTwistLimit = isPistol ? twistLimit : 1.05
      const rel = angleDiff(travelDir, p.aim)
      const hipLimit = Math.min(strafeHipLimit(speed, activeProfile), effTwistLimit)
      if (speed > 0.35) {
        const wasBack = this.back
        this.back = backpedalling(rel, this.back)
        if (this.back !== wasBack) {
          // Inertialize the forward/backpedal flip so the hips keep their angular velocity.
          this.yawOffset.x = clamp(this.yawOffset.x + strafeLegGoal(rel, wasBack, hipLimit) - strafeLegGoal(rel, this.back, hipLimit), -0.85, 0.85)
        }
      } else this.back = false
      stepSpring(this.yawOffset, stiffness(clamp(activeProfile.transitionHz ?? 6, 2, 14)), 1, h, 0)
      const want = p.aim + clamp((speed > 0.35 ? strafeLegGoal(rel, this.back, hipLimit) : 0) + this.yawOffset.x, -effTwistLimit, effTwistLimit)
      this.yaw += angleDiff(want, this.yaw) * Math.min(1, h * 9)
      this.yaw = p.aim + clamp(angleDiff(this.yaw, p.aim), -effTwistLimit, effTwistLimit)

      const c = Math.cos(this.yaw)
      const s = Math.sin(this.yaw)
      const rest = (i: number): V3 => {
        const [ox, oz] = strafeFootOffset(stance, this.yaw, i, curGait.stride, activeProfile)
        const x = sx + ox
        const z = sy + oz
        return [x, support(x, z), z]
      }
      if (teleport && step === 1) {
        this.feet.forEach((f, i) => {
          f.p = rest(i)
          f.lift = [...f.p]
          f.target = [...f.p]
          f.prevU = 0
          f.planted = true
          f.yaw = this.yaw
        })
      }
      const isZombiePose = profile?.handPose === "reach"
      const needsStep = this.feet.some(
        (f, i) => Math.hypot(f.p[0] - rest(i)[0], f.p[2] - rest(i)[2]) > 0.2 || !f.planted,
      )
      const dragSlow = isZombiePose ? 1 - 0.22 * clamp(profile?.footDrag ?? 0, 0, 0.95) * (1 - 0.5 * runBlend) : 1
      const rate = speed > 0.2 ? Math.max(0.72, (speed / curGait.stride) * dragSlow) : needsStep ? 1.7 : 0
      this.phase = (this.phase + rate * h) % 1
      const duty = curGait.duty
      this.feet.forEach((f, i) => {
        const phase = (this.phase + i * (0.5 + (profile?.timingBias ?? 0) * 0.25)) % 1
        if (rate > 0 && phase >= duty) {
          const u = (phase - duty) / (1 - duty)
          const e = smoother(u)
          const firstSwingFrame = f.planted
          if (f.planted) {
            f.planted = false
            f.lift = [...f.p]
            f.prevU = 0
            const sc = ++this.stepCount
            const varAmt = clamp(profile?.stepVariation ?? 0.35, 0, 1)
            const blue = 0.65 * stepHash(this.seed, sc, 1) - 0.55 * stepHash(this.seed, sc - 2, 1)
            f.stepReach = 1 + varAmt * 0.065 * blue
            f.stepLat = varAmt * 0.016 * stepHash(this.seed, sc, 2)
            f.stepLift = 1 + varAmt * 0.15 * stepHash(this.seed, sc, 3)
            f.stepToe = varAmt * 0.06 * stepHash(this.seed, sc, 4)
          }
          if ( firstSwingFrame || u < 0.75) {
            const lead = Math.min(0.41, (1 - phase) / rate + (duty / rate) * 0.48) * f.stepReach
            const target = rest(i)
            target[0] += vx * lead - s * f.stepLat
            target[2] += vy * lead + c * f.stepLat
            const other = this.feet[1 - i]!
            ;[target[0], target[2]] = strafeSeparate(stance, this.yaw, i, [target[0], target[2]], [other.p[0], other.p[2]], activeProfile)
            target[1] = support(target[0], target[2])
            const ep = smoother(f.prevU)
            if (!firstSwingFrame && ep > 0 && ep < 0.95) {
              const curX = f.lift[0] + (f.target[0] - f.lift[0]) * ep
              const curY = f.lift[1] + (f.target[1] - f.lift[1]) * ep
              const curZ = f.lift[2] + (f.target[2] - f.lift[2]) * ep
              f.lift = [
                (curX - target[0] * ep) / (1 - ep),
                (curY - target[1] * ep) / (1 - ep),
                (curZ - target[2] * ep) / (1 - ep),
              ]
            }
            f.target = target
          }
          f.prevU = u
          const target = f.target
          const clearance = (i === 1 ? 1 - (profile?.footDrag ?? 0) : 1) * f.stepLift
          // Mid-swing terrain clearance boost & floor guard (Lamplight arachnid/mod.rs & walk.rs:1419, 1446)
          const midY = support((f.lift[0] + target[0]) * 0.5, (f.lift[2] + target[2]) * 0.5)
          const boost = Math.max(0, midY - Math.max(f.lift[1], target[1]))
          const px = f.lift[0] + (target[0] - f.lift[0]) * e
          const pz = f.lift[2] + (target[2] - f.lift[2]) * e
          const liftBell = 1.72 * Math.sin(Math.PI * u) ** 2 * (1 - u)
          const py = Math.max(
            support(px, pz),
            f.lift[1] + (target[1] - f.lift[1]) * e + liftBell * ((0.085 + 0.125 * runBlend) * clearance + boost),
          )
          f.p = [px, py, pz]
          f.yaw += angleDiff(this.yaw + strafeFootOpen(stance, i) + f.stepToe, f.yaw) * e
        } else if (!f.planted) {
          f.planted = true
          f.prevU = 0
          f.p[1] = support(f.p[0], f.p[2])
          this.onFootfall?.(f.p[0], f.p[2], speed)
        }
      })
      // The pelvis turns between the feet (Blackout's rule), so strafing boots that open toward travel take it along.
      const f0 = this.feet[0]!.yaw
      const midYaw = f0 + angleDiff(this.feet[1]!.yaw, f0) * 0.5
      angleSpring(this.pelvisYaw, p.aim + clamp(angleDiff(midYaw, p.aim), -effTwistLimit, effTwistLimit), activeProfile.bodyHz, h)
      // Anticipatory support floor: blend root terrain support with foot terrain heights (never airborne swing height).
      const footSupport =
        (support(this.feet[0]!.p[0], this.feet[0]!.p[2]) + support(this.feet[1]!.p[0], this.feet[1]!.p[2])) * 0.5
      const supportY = support(sx, sy) * 0.65 + footSupport * 0.35
      const bobPhase = this.phase * Math.PI * 4 + (1 - runBlend) * 0.45
      const baseHeight = supportY + HIP - 0.012 * moving - (0.021 + 0.008 * runBlend) * moving * Math.sin(bobPhase)
      let desiredDrop = 0
      for (const f of this.feet) {
        if (!f.planted) continue
        const effDist = Math.max(0, Math.hypot(f.p[0] - sx, f.p[2] - sy) - 0.10 * moving * (1 - 0.4 * runBlend))
        const distance = Math.min(0.72, effDist)
        const reachY = Math.sqrt(Math.max(0, 0.825 ** 2 - distance ** 2)) + RIG.ankle + f.p[1]
        desiredDrop = Math.max(desiredDrop, Math.max(0, Math.min(0.18, baseHeight - reachY)))
      }
      stepSpring(this.reachDrop, 140, 0.85, h, desiredDrop)
      const fdx = this.feet[1]!.p[0] - this.feet[0]!.p[0]
      const fdz = this.feet[1]!.p[2] - this.feet[0]!.p[2]
      const footFwd = fdx * c + fdz * s
      stepSpring(this.twist, 160, 0.85, h, clamp(footFwd * 0.32, -0.17, 0.17) * (profile?.twistScale ?? 1.2))
      const gait = smooth((speed - 0.15) / 0.35)
      const footNorm = clamp(footFwd / Math.max(0.35, curGait.stride * 0.44), -1, 1)
      const armLead = 0.22 + 1.06 * runBlend
      const phaseArm = -Math.cos(this.phase * Math.PI * 2 + armLead) * gait
      const armSignal = speed > 0.2 ? footNorm * 0.25 + phaseArm * 0.75 : footNorm
      const armAmp = (0.16 + 0.22 * runBlend) * (profile?.armSwing ?? 1) * gait
      for (let i = 0; i < 2; i++) {
        const side = i === 0 ? -1 : 1
        stepSpring(this.arms[i]!, 2400, 0.85, h, -side * armSignal * armAmp)
        stepSpring(this.hands[i]!, 1600, 0.82, h, this.arms[i]!.x)
      }

      // Step weapon raise/hold timer, recoil springs, and weapon yaw spring
      const prevSinceShot = this.sinceShot
      this.sinceShot += h
      if (this.holdRemaining > 0 && !p.aiming && reloadClipT === null) {
        this.holdRemaining = Math.max(0, this.holdRemaining - h)
      }
      const aimGoal = isPistol && (this.holdRemaining > 0 || reloadClipT !== null) ? 1 : 0
      if (aimGoal > 0) {
        const wRaise = 2.55 / raiseTime
        stepSpring(this.aimSpring, wRaise * wRaise, 0.74, h, 1)
      } else {
        stepSpring(this.aimSpring, 64, 0.96, h, 0)
      }

      if (prevSinceShot >= 1 / 60) {
        for (const sp of [this.recBack, this.recPitch, this.recYaw, this.recRoll]) {
          stepSpring(sp, 1100, 0.45, h, 0)
        }
      }
      stepSpring(this.torsoKick, 280, 0.50, h, 0)

      this.weaponYaw.x += dAimStep
      angleSpring(this.weaponYaw, p.aim, 16, h)
    }

    this.aimWeight = isPistol ? clamp(this.aimSpring.x, 0, 1.08) : 0
    const aimW = clamp(this.aimWeight, 0, 1)
    const settleOver = Math.max(0, this.aimWeight - 1)

    const curSpeed = Math.hypot(this.svx, this.svy)
    const gait = smooth((curSpeed - 0.15) / 0.35)
    const curGait = gaitAt(curSpeed, false, 0, profile ?? humanProfiles.soldier)
    const runBlend = curGait.run
    const shambleMod = isZombie && profile ? shambleTorsoModulation(this.phase, gait, profile, 0) : null
    const crouchT = clamp(((profile?.crouchDepth ?? 0) - 0.082) / 0.015, 0, 1) * runBlend
    stepSpring(this.stealth, 260, 1, dt, p.crouching ? 1 : 0)
    const stealthT = clamp(this.stealth.x, 0, 1)
    const crouchDrop = crouchT * 0.055 + stealthT * STEALTH_DROP
    const footSupport =
      (support(this.feet[0]!.p[0], this.feet[0]!.p[2]) + support(this.feet[1]!.p[0], this.feet[1]!.p[2])) * 0.5
    const curSupportY = support(p.x, p.y) * 0.65 + footSupport * 0.35
    const bobPhase = this.phase * Math.PI * 4 + (1 - runBlend) * 0.45
    const bobOffset = (0.021 + 0.008 * runBlend) * gait * Math.sin(bobPhase)
    const height =
      curSupportY +
      HIP -
      (0.008 + 0.022 * runBlend) * gait -
      crouchDrop +
      (shambleMod?.pelvisBobAdd ?? 0) * 0.45 -
      bobOffset -
      this.reachDrop.x
    let pelvis = roll(
      yawFrame([p.x, height, p.y], this.pelvisYaw.x + this.twist.x),
      Math.cos(this.phase * Math.PI * 2) * (0.07 + 0.03 * (profile?.hipDrop ?? 0)) * moving +
        (shambleMod?.pelvisRollAdd ?? 0),
    )
    if (crouchT > 0 || shambleMod || stealthT > 0) {
      pelvis = pitch(pelvis, -0.22 * crouchT - STEALTH_PELVIS * stealthT - 0.35 * (shambleMod?.torsoPitchAdd ?? 0))
    }

    const ca = Math.cos(p.aim)
    const sa = Math.sin(p.aim)
    const lean = this.leanX.x * ca + this.leanY.x * sa
    const sideLean = (-this.leanX.x * sa + this.leanY.x * ca) * (profile?.turnBank ?? 1)

    const meleeDef = meleeId ? MELEE_WEAPONS[meleeId] : null
    const meleePhase = p.meleePhase ?? "idle"
    const meleeProgress =
      meleePhase === "idle"
        ? 0
        : clamp((p.meleePhaseTime ?? 0) / Math.max(0.01, p.meleePhaseDuration ?? 0.12), 0, 1)
    const meleeMod =
      isMelee && meleeDef
        ? meleeTorsoModulation({
            weaponClass: meleeDef.weaponClass,
            phase: meleePhase,
            phaseProgress: meleeProgress,
            combo: p.meleeCombo ?? 1,
            charge: p.meleeCharge ?? 0,
            heavy: Boolean(p.meleeHeavy),
            weaponLength: meleeDef.length,
          })
        : null

    const blade = isPistol ? BLADE_PISTOL * (0.18 + 0.82 * aimW) : meleeMod ? meleeMod.yawAdd : 0
    const counterTwist = this.twist.x * 0.65 * (1 - 0.68 * aimW) * (meleePhase !== "idle" ? 0.25 : 1)
    const rawChestGoal = p.aim + blade - counterTwist + (shambleMod?.torsoYawAdd ?? 0)
    const clampedChestGoal = isPistol
      ? this.yaw + blade + clamp(angleDiff(rawChestGoal, this.yaw + blade), -twistLimit, twistLimit)
      : rawChestGoal

    if (profile) {
      angleSpring(this.chest, clampedChestGoal, profile.chestHz, dt)
      angleSpring(this.head, p.aim + (shambleMod?.headYawAdd ?? 0), profile.headHz, dt)
    } else {
      const chestHz = isMelee && meleePhase !== "idle" ? 18 : 7 + 4 * aimW
      angleSpring(this.chest, clampedChestGoal, chestHz, dt)
      angleSpring(this.head, p.aim, 9 + 4 * aimW, dt)
    }

    const torsoYaw =
      (profile
        ? this.chest.x
        : isPistol
          ? this.chest.x
          : isMelee
            ? meleePhase !== "idle"
              ? clampedChestGoal
              : this.chest.x
            : p.aim - this.twist.x * 0.65) +
      this.recYaw.x * 0.35
    const tb = torsoYaw - p.aim
    const reloadLook =
      reloadClipT !== null
        ? reloadClipT < 0.12
          ? smooth(reloadClipT / 0.12) * 0.28
          : reloadClipT < 0.78
            ? 0.28
            : (1 - smooth((reloadClipT - 0.78) / 0.22)) * 0.28
        : 0
    const reloadHunch = reloadLook * 0.22
    const posturePitch = 0.14 * runBlend * (profile?.runPosture ?? 0.18) * (1 - 0.35 * aimW)
    const stompRaw = p.stompAnim ?? 0
    const stompProg = stompRaw > 0 ? 1 - clamp(stompRaw / 0.38, 0, 1) : 0
    const stompWindup = stompRaw > 0 && stompProg < 0.44 ? Math.sin((stompProg / 0.44) * (Math.PI * 0.5)) : 0
    const stompSlam = stompRaw > 0 && stompProg >= 0.44 ? Math.sin(((stompProg - 0.44) / 0.56) * Math.PI) : 0
    const finisherPulse =
      p.meleeFinisher && meleePhase !== "idle" ? Math.sin(meleeProgress * Math.PI) : 0
    const finisherPitch = finisherPulse * 0.38 + stompSlam * 0.3 - stompWindup * 0.14
    const fwdPitch =
      0.05 +
      lean +
      (shambleMod?.torsoPitchAdd ?? 0) +
      (meleeMod?.pitchAdd ?? 0) +
      finisherPitch +
      posturePitch +
      0.24 * crouchT +
      STEALTH_CHEST * stealthT +
      reloadHunch -
      this.torsoKick.x
    const sideRoll = sideLean * 0.75 + (shambleMod?.torsoRollAdd ?? 0) + (meleeMod?.rollAdd ?? 0)

    let torso = yawFrame(at(pelvis, 0, RIG.waist, 0), torsoYaw)
    if (isPistol) {
      torso = pitch(torso, -(fwdPitch * Math.cos(tb) + sideRoll * Math.sin(tb)))
      torso = roll(torso, sideRoll * Math.cos(tb) - fwdPitch * Math.sin(tb) * 0.85)
    } else {
      torso = roll(pitch(torso, -fwdPitch), sideRoll)
    }
    if (profile) torso = profileTorso(torso, profile)

    let head = pitch(
      yawFrame(at(torso, 0.02, RIG.neckY, 0), profile ? this.head.x : p.aim),
      lean * 0.35 * (profile?.headStability ?? 0.75) -
        (shambleMod?.headPitchAdd ?? 0) -
        reloadLook -
        this.torsoKick.x * 0.55,
    )
    if (profile) head = roll(head, profile.headTilt + (shambleMod?.headRollAdd ?? 0))

    let arms: ReturnType<typeof poseArms>
    if (isPistol) {
      // Anchor the pistol to the stabilised shoulder frame (root + lean/posture, without hip sway, pelvic roll or gait twist)
      const steadyHeight =
        curSupportY +
        HIP -
        (0.008 + 0.022 * runBlend) * gait -
        crouchDrop -
        bobOffset * 0.2 -
        this.reachDrop.x
      const steadyPelvis = yawFrame([p.x, steadyHeight, p.y], this.yaw)
      const steadyYaw =
        this.yaw + blade + clamp(angleDiff(p.aim + blade, this.yaw + blade), -twistLimit, twistLimit) + this.recYaw.x * 0.35
      const steadyTb = steadyYaw - p.aim
      const steadyFwd = 0.05 + lean + posturePitch + 0.24 * crouchT + STEALTH_CHEST * stealthT + reloadHunch - this.torsoKick.x
      let steadyTorso = yawFrame(at(steadyPelvis, 0, RIG.waist, 0), steadyYaw)
      steadyTorso = pitch(steadyTorso, -(steadyFwd * Math.cos(steadyTb) + sideRoll * Math.sin(steadyTb)))
      steadyTorso = roll(steadyTorso, sideRoll * Math.cos(steadyTb) - steadyFwd * Math.sin(steadyTb) * 0.85)
      if (profile) steadyTorso = profileTorso(steadyTorso, profile)
      const gunShoulder = at(steadyTorso, 0, RIG.shoulderY, 0)

      const lowSwingFwd = 0.035 * this.arms[1]!.x * (1 - aimW)
      const holdFwd =
        PISTOL_LOW_READY.fwd + (PISTOL_HOLD.fwd - 0.02 * runBlend - PISTOL_LOW_READY.fwd) * aimW + lowSwingFwd
      const holdUp = PISTOL_LOW_READY.up + (PISTOL_HOLD.up - PISTOL_LOW_READY.up) * aimW + settleOver * 0.12
      const holdSide = PISTOL_LOW_READY.side + (PISTOL_HOLD.side - PISTOL_LOW_READY.side) * aimW

      const gy = this.weaponYaw.x
      const ga = Math.cos(gy)
      const gs = Math.sin(gy)
      const targetGunPos: V3 = [
        gunShoulder[0] + ga * holdFwd - gs * holdSide,
        gunShoulder[1] + holdUp - REST_SHOULDER_Y,
        gunShoulder[2] + gs * holdFwd + ga * holdSide,
      ]

      if (teleport || !this.gunInit) {
        for (let i = 0; i < 3; i++) {
          this.gunPos[i]!.x = targetGunPos[i]!
          this.gunPos[i]!.v = 0
        }
        this.gunInit = true
      } else {
        this.gunPos[0].x += p.x - prevX
        this.gunPos[1].x += curSupportY - this.prevSupportY
        this.gunPos[2].x += p.y - prevY
        const kGun = stiffness(14)
        for (let i = 0; i < 3; i++) {
          stepSpring(this.gunPos[i]!, kGun, 1, dt, targetGunPos[i]!)
        }
      }

      let gunPitch = 0
      let gunRoll = 0
      let gunPull = 0
      let gunDrop = 0
      let gunYaw = 0
      if (reloadClipT !== null) {
        const [k0, k1, u] = keyedReload(PISTOL_RELOAD_GUN, reloadClipT)
        gunPitch = k0[1] + (k1[1] - k0[1]) * u
        gunRoll = k0[2] + (k1[2] - k0[2]) * u
        gunPull = k0[3] + (k1[3] - k0[3]) * u
        gunDrop = k0[4] + (k1[4] - k0[4]) * u
        gunYaw = k0[5] + (k1[5] - k0[5]) * u
      }

      const lowPitch = (-0.48 + 0.14 * this.arms[1]!.x) * (1 - aimW)
      const lowYaw = (0.08 - 0.05 * this.arms[1]!.x) * (1 - aimW)
      const lowRoll = 0.16 * (1 - aimW)

      const yaw = gy + this.recYaw.x - gunYaw - lowYaw
      let gunF = yawFrame([this.gunPos[0].x, this.gunPos[1].x - gunDrop, this.gunPos[2].x], yaw)
      gunF = pitch(gunF, this.recPitch.x + gunPitch + lowPitch + settleOver * 0.25)
      gunF = roll(gunF, this.recRoll.x + gunRoll + lowRoll)
      gunF = moved(gunF, at(gunF, -this.recBack.x - gunPull, 0, 0))
      this.gun = gunF

      // Hand targets: right hand anchored to pistol grip; left hand cups grip in aim, swings/guards in low ready, or executes reload clip
      const handR = at(gunF, 0, -0.035, 0)
      const supportL = at(gunF, 0.025, -0.04, -0.022)
      let handL: V3
      let gripBlend = smooth(clamp((aimW - 0.05) / 0.85, 0, 1))

      if (reloadClipT !== null) {
        const [k0, k1, u] = keyedReload(PISTOL_RELOAD_LEFT, reloadClipT)
        const evalKey = (key: ReloadHandKey): V3 => {
          if (key[1] === "home") return supportL
          const [, sp, x, y, z] = key
          return at(sp === "gun" ? gunF : sp === "torso" ? torso : pelvis, x, y, z)
        }
        handL = lerp3(evalKey(k0), evalKey(k1), u)
        gripBlend = 1
      } else {
        const [unarmedL] = unarmedHands(
          {
            gait,
            motion: { run: runBlend, crouch: { x: crouchT * 0.09 }, arms: this.arms, hands: this.hands } as never,
          },
          torso,
          time * 2,
        )
        const guardL = at(torso, 0.20, RIG.shoulderY - 0.30, -0.17)
        const lowReadyL = lerp3(guardL, unarmedL, clamp(gait * 1.15, 0, 1))
        handL = lerp3(lowReadyL, supportL, gripBlend)
      }

      if ((p.shoveAnim ?? 0) > 0) {
        const shoveU = Math.sin(clamp((p.shoveAnim ?? 0) / 0.28, 0, 1) * Math.PI)
        handL = lerp3(handL, at(torso, 0.48, RIG.shoulderY - 0.04, -0.10), shoveU)
      }

      if (gripBlend >= 0.999) {
        arms = poseArms(torso, handL, handR)
      } else {
        const armedArms = poseArms(torso, handL, handR)
        const shL = at(torso, 0, RIG.shoulderY, -RIG.shoulderW)
        const dWorld = sub(handL, shL)
        const dx = dot(dWorld, torso.x)
        const dy = dot(dWorld, torso.y)
        const lift = clamp((dy + 0.35) / 0.45, 0, 1)
        const back = clamp((-dx + 0.10) / 0.35, 0, 1)
        const freePole = dirIn(torso, -0.95 - 0.25 * lift, -0.55 + 0.70 * back, -(0.24 + 0.14 * lift))
        const aimPole = dirIn(torso, -0.15, -1, -1.1)
        const poleL = lerp3(freePole, aimPole, gripBlend)
        const [eL, hL] = ik(shL, handL, RIG.upper, RIG.fore, poleL)
        const uaL = limb(shL, eL, torso.x, torso.y)
        const faL = limb(eL, hL, lerp3(torso.x, [0, 1, 0], gripBlend), lerp3(torso.y, torso.x, gripBlend))
        arms = {
          ua: [uaL, armedArms.ua[1]],
          fa: [faL, armedArms.fa[1]],
        }
      }

      if (reloadClipT !== null && reloadClipT >= 0.28 && reloadClipT < 0.64) {
        this.mag = moved(gunF, at(arms.fa[0], 0, -RIG.fore - 0.01, 0))
      } else {
        this.mag = null
      }
      this.meleeWeaponFrame = null
      this.meleeTip = null
    } else if (isMelee && meleeDef) {
      this.gun = null
      this.mag = null
      const posed = poseMeleeArms(torso, {
        weaponClass: meleeDef.weaponClass,
        phase: meleePhase,
        phaseProgress: meleeProgress,
        combo: p.meleeCombo ?? 1,
        charge: p.meleeCharge ?? 0,
        heavy: Boolean(p.meleeHeavy),
        weaponLength: meleeDef.length,
        gait,
        armSwing: this.arms[1]!.x,
      })
      if ((p.shoveAnim ?? 0) > 0 && meleePhase === "idle") {
        const shoveU = Math.sin(clamp((p.shoveAnim ?? 0) / 0.28, 0, 1) * Math.PI)
        const handL = lerp3(posed.handL, at(torso, 0.46, RIG.shoulderY - 0.04, -0.12), shoveU)
        arms = poseArms(torso, handL, posed.handR)
      } else {
        arms = { ua: posed.ua, fa: posed.fa }
      }
      if (finisherPulse > 0.01) {
        this.meleeWeaponFrame = pitch(posed.weapon, -0.58 * finisherPulse)
        this.meleeTip = at(this.meleeWeaponFrame, meleeDef.length, 0, 0)
      } else {
        this.meleeWeaponFrame = posed.weapon
        this.meleeTip = posed.tip
      }
    } else {
      this.gun = null
      this.mag = null
      this.meleeWeaponFrame = null
      this.meleeTip = null
      const rawHands = profile && profileHands(torso, profile)
      let hands = rawHands
      if (rawHands && profile?.handPose === "reach") {
        hands = shambleHandsFK(torso, this.phase, gait, runBlend, profile, 0)
      }
      let [unL, unR] = unarmedHands(
        {
          gait,
          motion: { run: runBlend, crouch: { x: crouchT * 0.09 }, arms: this.arms, hands: this.hands } as never,
        },
        torso,
        time * 2,
      )
      if ((p.shoveAnim ?? 0) > 0 && !hands) {
        const shoveU = Math.sin(clamp((p.shoveAnim ?? 0) / 0.28, 0, 1) * Math.PI)
        unL = lerp3(unL, at(torso, 0.46, RIG.shoulderY - 0.04, -0.12), shoveU)
        unR = lerp3(unR, at(torso, 0.46, RIG.shoulderY - 0.04, 0.12), shoveU)
      }
      const unarmed = poseUnarmedArms(torso, unL, unR)
      arms = hands ? (profile?.handPose === "reach" ? poseUnarmedArms(torso, ...hands) : poseArms(torso, ...hands)) : unarmed
    }

    this.prevSupportY = curSupportY
    if (this.gun) {
      this.light.p = at(this.gun, 0.15, -0.025, 0)
      this.light.d = [this.gun.x[0], this.gun.x[1], this.gun.x[2]]
      this.light.mounted = true
    } else {
      this.light.p = at(arms.fa[1]!, 0, -RIG.fore - 0.04, 0)
      this.light.d = [Math.cos(p.aim), 0, Math.sin(p.aim)]
      this.light.mounted = false
    }
    this.bones = { pelvis, torso, head }
    ;(this.bones as BonePose & { gun?: Frame | null; melee?: Frame | null }).gun = this.gun
    ;(this.bones as BonePose & { gun?: Frame | null; melee?: Frame | null }).melee = this.meleeWeaponFrame
    this.batches.length = 0
    let index = 0
    const push: PushPart = (model, x, y, z, yaw, tint, pitchAng, rollAng, flash, alpha = 1) => {
      const data = this.data.subarray(index * 12, ++index * 12)
      data.set([x, y, z, yaw, ...tint, 1, pitchAng, rollAng, alpha, flash])
      this.batches.push({ model, data, count: 1 })
    }
    const shape = heroShape(tune.heroStyle)
    if (shape === 3) this.ensureBean(tune)
    const models = this.shapes[shape]!
    const bodyTint: V3 = shape === 3 ? beanTint(tune, this.seatIndex) : shape === 1 || shape === 2 ? heroTint(tune, this.seat) : [1, 1, 1]
    const draw = (id: number, frame: ReturnType<typeof yawFrame>) =>
      emit(push, models[id]!, frame, id === 8 || id === 9 ? [1, 1, 1] : bodyTint, 0)
    draw(0, pelvis)
    draw(1, torso)
    draw(2, head)
    for (let i = 0; i < 2; i++) {
      const side = i ? 1 : -1
      const foot = this.feet[i]!
      const hip = at(pelvis, 0, 0, side * RIG.hipW)
      const u = foot.planted ? 0 : foot.prevU
      const isDrag = i === 1 && (profile?.footDrag ?? 0) > 0
      const drag = isDrag ? clamp(profile?.footDrag ?? 0, 0, 0.95) : 0
      const dragKeep = 1 - drag
      const fc = Math.cos(foot.yaw)
      const fs = Math.sin(foot.yaw)
      // Terrain-conforming boot pitch in stance + heel-strike -> foot-flat -> heel-rise -> toe-off roll on the ball.
      const groundSlope = clamp(
        (support(foot.p[0] + fc * 0.12, foot.p[2] + fs * 0.12) -
          support(foot.p[0] - fc * 0.08, foot.p[2] - fs * 0.08)) /
          0.20,
        -0.45,
        0.45,
      )
      const footPhase = (this.phase + i * (0.5 + (profile?.timingBias ?? 0) * 0.25)) % 1
      const dutyNow = curGait.duty
      const stanceFrac = foot.planted ? clamp(footPhase / Math.max(0.1, dutyNow), 0, 1) : 0
      const sFlat = 0.16 - 0.04 * runBlend
      const heelStrike0 = (1 - this.backness) * (0.26 - 0.04 * runBlend) * (1 - 0.55 * crouchT) * gait * dragKeep
      const heelStrikePitch = stanceFrac < sFlat ? heelStrike0 * (1 - smooth(stanceFrac / sFlat)) : 0
      const sHeelRise = 0.44 - 0.04 * runBlend
      const heelRiseMax = (0.44 + 0.08 * runBlend) * gait * (1 - 0.55 * drag)
      const riseU = smooth((stanceFrac - sHeelRise) / (1 - sHeelRise))
      const heelRisePitch = stanceFrac > sHeelRise ? -heelRiseMax * riseU : 0
      const stancePitch = groundSlope + heelStrikePitch + heelRisePitch

      let thigh: Frame
      let shin: Frame
      let boot: Frame
      let toeFrame: Frame
      if (i === 1 && stompRaw > 0) {
        const ac = Math.cos(p.aim)
        const as = Math.sin(p.aim)
        const stompFwd = 0.24 * stompWindup + 0.38 * (1 - stompWindup)
        const stompLift = 0.34 * stompWindup + 0.04 * stompSlam * (1 - clamp((stompProg - 0.44) / 0.28, 0, 1))
        const ankWorld: V3 = [
          p.x + ac * stompFwd - as * 0.11,
          curSupportY + RIG.ankle + stompLift,
          p.y + as * stompFwd + ac * 0.11,
        ]
        const pole = dirIn(pelvis, 1, 0.45, 0.22)
        const [knee, end] = ik(hip, ankWorld, RIG.thigh, RIG.shin, pole)
        thigh = limb(hip, knee, pole, pelvis.x)
        shin = limb(knee, end, pole, pelvis.x)
        const bootPitch = 0.22 * stompWindup - 0.32 * stompSlam
        boot = pitch(yawFrame(end, p.aim), bootPitch)
        toeFrame = pitch(yawFrame(at(boot, RIG.foot, -RIG.ankle, 0), p.aim), bootPitch * 0.5)
      } else if (foot.planted) {
        const ballWorld: V3 = [foot.p[0] + fc * RIG.foot, foot.p[1], foot.p[2] + fs * RIG.foot]
        const f0 = pitch(yawFrame([0, 0, 0], foot.yaw), stancePitch)
        const riseFrame = pitch(yawFrame([0, 0, 0], foot.yaw), groundSlope + heelRisePitch)
        const off = at(riseFrame, RIG.foot, -RIG.ankle, 0)
        boot = { ...f0, p: [ballWorld[0] - off[0], ballWorld[1] - off[1], ballWorld[2] - off[2]] }
        toeFrame = pitch(yawFrame(ballWorld, foot.yaw), groundSlope)
        const pole = kneePole(pelvis, foot.yaw, side)
        const [knee, end] = ik(hip, boot.p, RIG.thigh, RIG.shin, pole)
        thigh = limb(hip, knee, pole, pelvis.x)
        shin = limb(knee, end, pole, pelvis.x)
      } else {
        const liftOffBlend = (1 - smooth(u / (0.36 - 0.10 * runBlend))) * gait * dragKeep
        const toeOffPitch = -(0.44 + 0.08 * runBlend) * liftOffBlend * (1 - 0.55 * drag)
        const liftFrame = pitch(yawFrame([0, 0, 0], foot.yaw), toeOffPitch)
        const ballOff = at(liftFrame, RIG.foot, -RIG.ankle, 0)
        const liftAnkX = fc * RIG.foot - ballOff[0]
        const liftAnkY = Math.max(0, -ballOff[1] - RIG.ankle)
        const liftAnkZ = fs * RIG.foot - ballOff[2]

        const sinU = Math.sin(Math.PI * u)
        const uprightRun = 1 - crouchT
        const lateTaper = 1 - smoother((u - (0.74 + 0.08 * uprightRun)) / 0.16)
        const kickBell = sinU * sinU * (0.42 + 0.92 * Math.pow(u, 0.80)) * lateTaper
        const tuckBell = sinU * sinU * Math.pow(u, 0.95 - 0.10 * uprightRun) * (1.65 + 0.13 * uprightRun) * lateTaper
        const clearance = dragKeep * foot.stepLift
        const crouchKickScale = 1 - 0.55 * crouchT
        const earlyPushFwd = (0.085 * (1 - runBlend) + 0.025 * runBlend * uprightRun) * clearance * Math.sin(Math.PI * clamp(u / 0.46, 0, 1)) ** 2
        const lateWalkTuck = 0.125 * (1 - runBlend) * clearance * Math.sin(Math.PI * clamp((u - 0.42) / 0.52, 0, 1)) ** 2
        const heelKick = (0.022 * (1 - runBlend) * smooth((u - 0.22) / 0.35) + 0.22 * runBlend * crouchKickScale) * clearance * kickBell
        const heelTuck = (0.015 * (1 - runBlend) + (0.24 + 0.035 * uprightRun) * runBlend * (1 - 0.35 * crouchT)) * clearance * tuckBell + lateWalkTuck - earlyPushFwd
        const baseY = foot.p[1] - (foot.lift[1] + (foot.target[1] - foot.lift[1]) * smoother(u))
        const terrY = foot.p[1] - baseY
        const walkEarlyDamp = 1 - 0.62 * (1 - runBlend) * (1 - smooth((u - 0.15) / 0.32))
        const swingLiftY = baseY * walkEarlyDamp
        const ankle: V3 = [
          foot.p[0] + liftAnkX * liftOffBlend - fc * heelTuck,
          terrY + swingLiftY + RIG.ankle + liftAnkY * liftOffBlend * (0.25 + 0.75 * runBlend) + heelKick,
          foot.p[2] + liftAnkZ * liftOffBlend - fs * heelTuck,
        ]
        const chordX =
          (ankle[0] - hip[0]) * pelvis.x[0] + (ankle[1] - hip[1]) * pelvis.x[1] + (ankle[2] - hip[2]) * pelvis.x[2]
        const backKick = runBlend * kickBell * clamp(-chordX / 0.35, 0, 1) * dragKeep
        const pole = kneePole(pelvis, foot.yaw, side, 0.28 - 0.65 * backKick, 1 - 0.68 * runBlend * kickBell * dragKeep)
        const [knee, end] = ik(hip, ankle, RIG.thigh, RIG.shin, pole)
        thigh = limb(hip, knee, pole, pelvis.x)
        shin = limb(knee, end, pole, pelvis.x)
        const shinPitch = -Math.atan2(shin.y[0] * fc + shin.y[2] * fs, shin.y[1])
        const tdBlend = smoother((u - 0.72) / 0.28)
        const tdPitch = heelStrike0 * tdBlend
        const basePitch = groundSlope + toeOffPitch + tdPitch
        const swingRel =
          -(0.24 + 0.12 * runBlend) * (1 - smooth((u - 0.46) / 0.30)) +
          (0.04 + (0.16 + 0.08 * uprightRun) * runBlend) * smooth((u - (0.60 - 0.08 * uprightRun)) / 0.26)
        const relaxed = smooth(u / 0.12) * (1 - smooth((u - 0.74) / 0.20))
        let footPitch = basePitch + (shinPitch + swingRel - basePitch) * relaxed
        const liftOffToe = Math.max(0, -footPitch) * (1 - smooth(u / 0.34))
        const pushOffCurl = -0.12 * Math.sin(Math.PI * clamp((u - 0.18) / 0.26, 0, 1)) * gait * dragKeep
        const swingClearanceToe = (0.20 + 0.10 * runBlend) * Math.sin(Math.PI * clamp((u - 0.28) / 0.56, 0, 1)) * gait * dragKeep
        let toeRelPitch = liftOffToe + pushOffCurl + swingClearanceToe - tdPitch
        if (drag > 0) {
          const maxNoseDown = -Math.asin(clamp(Math.max(0, end[1] - terrY - RIG.ankle) / (RIG.foot + RIG.toe), 0, 0.95))
          footPitch = Math.max(footPitch, maxNoseDown * (1 - drag) + footPitch * (1 - drag))
          if (footPitch < groundSlope) toeRelPitch = (groundSlope - footPitch) * drag
        }
        boot = pitch(yawFrame(end, foot.yaw), footPitch)
        toeFrame = pitch(yawFrame(at(boot, RIG.foot, -RIG.ankle, 0), foot.yaw), footPitch + toeRelPitch)
      }
      const name = i === 0 ? "left" : "right"
      this.bones[`${name}.thigh`] = thigh
      this.bones[`${name}.shin`] = shin
      this.bones[`${name}.foot`] = boot
      this.bones[`${name}.toe`] = toeFrame
      draw(5, thigh)
      draw(6, shin)
      draw(7, boot)
      draw(10, toeFrame)
      const upper = arms.ua[i]!
      const fore = arms.fa[i]!
      this.bones[`${name}.upperArm`] = upper
      this.bones[`${name}.foreArm`] = fore
      draw(3, upper)
      draw(4, fore)
    }
    if (this.gun) draw(8, this.gun)
    if (this.mag) draw(9, this.mag)
    if (this.meleeWeaponFrame && meleeId) {
      const maxDur = p.meleeMaxDurability ?? meleeDef?.durability ?? 0
      const curDur = p.meleeDurability ?? maxDur
      const wear = maxDur > 0 ? clamp(1 - curDur / maxDur, 0, 1) : 0
      this.meleeWearStage = weaponWearStage(curDur, maxDur)
      const warpedFrame =
        wear > 0
          ? pitch(roll(this.meleeWeaponFrame, wear * 0.14), -wear * 0.11)
          : this.meleeWeaponFrame
      const tint: V3 = [1 - wear * 0.16, 1 - wear * 0.2, 1 - wear * 0.22]
      emit(push, this.meleeModels[meleeId][this.meleeWearStage], warpedFrame, tint, 0)
    } else {
      this.meleeWearStage = 0
    }
    return this.batches
  }
}
