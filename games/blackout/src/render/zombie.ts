import { MAT, Mesh, type Mat, type Rgb } from "./mesh"
import { hex } from "./models"
import { personModels, type PersonModels } from "./person"

const SKIN = hex(0x6c7d60)
const SKIN_D = hex(0x4e5d45)
const RAG = hex(0x323834)
const RAG_D = hex(0x212623)
const DENIM = hex(0x28303a)
const DENIM_D = hex(0x1c222a)
const WOUND = hex(0x581416)
const BONE = hex(0xbcb296)
const SHOE = hex(0x201b18)
const SOLE = hex(0x110f0f)

class ZombiePart extends Mesh {
  override box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, col: Rgb, mat: Mat = MAT.actor, aux = 0, top?: Rgb, bottom = false): void {
    super.box(x0, y0, z0, x1, y1, z1, col, mat === MAT.lit ? MAT.actor : mat, aux, top, bottom)
  }
  override prism(cx: number, cz: number, r0: number, r1: number, y0: number, y1: number, sides: number, col: Rgb, mat: Mat = MAT.actor, aux = 0, cap = true): void {
    super.prism(cx, cz, r0, r1, y0, y1, sides, col, mat === MAT.lit ? MAT.actor : mat, aux, cap)
  }
}

/**
 * Distinct zombie meshes sharing the canonical RIG pivots and lengths:
 * gaunt unhelmeted head with sunken glowing eyes and slack jaw, torn dark shirt with exposed ribs
 * and asymmetric bare shoulder, necrotic forearms with clawed hands, and ripped trousers.
 */
export function zombieModels(): PersonModels {
  const p = personModels()

  const pelvis = new ZombiePart()
  pelvis.box(-0.11, -0.07, -0.165, 0.10, 0.09, 0.165, DENIM)
  pelvis.box(-0.115, 0.04, -0.17, 0.105, 0.095, 0.17, RAG_D)
  // Torn shirt tail hanging on the left hip.
  pelvis.box(-0.12, -0.04, -0.175, 0.06, 0.06, -0.11, RAG, MAT.actor)
  p.pelvis = pelvis

  const torso = new ZombiePart()
  // Gaunt waist/abdomen with exposed ribs on the right side.
  torso.box(-0.10, -0.02, -0.145, 0.095, 0.20, 0.145, SKIN_D)
  torso.box(-0.115, -0.01, -0.155, 0.10, 0.21, 0.03, RAG, MAT.actor)
  torso.box(0.03, 0.02, 0.02, 0.10, 0.17, 0.148, WOUND)
  for (const y of [0.05, 0.10, 0.15]) torso.box(0.035, y, 0.03, 0.105, y + 0.022, 0.142, BONE)
  // Upper chest in torn dark cloth with bloodstain and hunched spine ridge (no backpack or antenna).
  torso.bevelBox(-0.13, 0.16, -0.19, 0.13, 0.45, 0.19, 0.025, RAG, RAG_D, MAT.actor)
  torso.box(0.11, 0.20, -0.14, 0.138, 0.38, 0.04, WOUND)
  torso.box(-0.155, 0.14, -0.035, -0.115, 0.44, 0.035, RAG_D)
  for (const y of [0.20, 0.27, 0.34]) torso.box(-0.162, y, -0.022, -0.145, y + 0.028, 0.022, BONE)
  // Collar & asymmetric shoulders: left tattered cloth, right exposed necrotic shoulder.
  torso.box(-0.08, 0.42, -0.11, 0.08, 0.49, 0.11, SKIN_D)
  torso.box(-0.13, 0.41, -0.215, 0.12, 0.465, -0.11, RAG, MAT.actor)
  torso.box(-0.10, 0.40, 0.11, 0.10, 0.455, 0.195, SKIN)
  p.torso = torso

  const head = new ZombiePart()
  // Forward-jutting neck and gaunt skull, no helmet or visor.
  head.box(-0.045, -0.02, -0.045, 0.055, 0.07, 0.045, SKIN_D)
  head.bevelBox(-0.105, 0.06, -0.10, 0.115, 0.295, 0.10, 0.035, SKIN, SKIN_D, MAT.actor)
  // Cheekbone hollows and slack lower jaw with dark open mouth.
  head.box(0.02, 0.08, -0.104, 0.095, 0.14, 0.104, SKIN_D)
  head.box(0.0, 0.005, -0.075, 0.11, 0.065, 0.075, SKIN_D)
  head.box(0.055, 0.038, -0.058, 0.116, 0.078, 0.058, WOUND)
  // Heavy brow ridge and sunken eye sockets with subtle amber-green glow.
  head.box(0.08, 0.205, -0.096, 0.126, 0.24, 0.096, SKIN_D)
  for (const z of [-0.046, 0.046]) {
    head.box(0.092, 0.145, z - 0.03, 0.118, 0.205, z + 0.03, hex(0x10130e))
    head.box(0.114, 0.166, z - 0.013, 0.122, 0.184, z + 0.013, hex(0x98d838), MAT.glow, 0.55)
  }
  // Disheveled dark scalp hair patch.
  head.box(-0.112, 0.26, -0.088, 0.03, 0.308, 0.082, RAG_D)
  p.head = head

  const upperArm = new ZombiePart()
  upperArm.box(-0.072, -0.11, -0.072, 0.072, 0.045, 0.072, RAG, MAT.actor)
  upperArm.box(-0.052, -0.29, -0.052, 0.052, -0.09, 0.052, SKIN)
  upperArm.box(-0.056, -0.20, -0.056, 0.056, -0.15, 0.056, WOUND)
  p.upperArm = upperArm

  const foreArm = new ZombiePart()
  foreArm.box(-0.046, -0.22, -0.046, 0.046, 0.025, 0.046, SKIN_D)
  // Splayed, blood-tipped reaching hand.
  foreArm.box(-0.042, -0.29, -0.044, 0.052, -0.21, 0.044, SKIN)
  for (const z of [-0.03, 0, 0.03]) {
    foreArm.box(0.01, -0.335, z - 0.01, 0.062, -0.28, z + 0.01, WOUND)
  }
  p.foreArm = foreArm

  const thigh = new ZombiePart()
  thigh.box(-0.078, -0.42, -0.074, 0.078, 0.035, 0.074, DENIM)
  thigh.box(0.025, -0.37, -0.058, 0.082, -0.24, 0.058, SKIN_D)
  p.thigh = thigh

  const shin = new ZombiePart()
  shin.box(-0.064, -0.20, -0.064, 0.064, 0.02, 0.064, DENIM_D)
  shin.box(-0.05, -0.34, -0.05, 0.05, -0.18, 0.05, SKIN_D)
  shin.box(-0.068, -0.42, -0.066, 0.072, -0.31, 0.066, SHOE)
  p.shin = shin

  const foot = new ZombiePart()
  foot.box(-0.072, -0.07, -0.06, 0.125, 0.018, 0.06, SHOE)
  foot.box(-0.076, -0.085, -0.064, 0.128, -0.065, 0.064, SOLE)
  p.foot = foot

  const toe = new ZombiePart()
  toe.box(-0.008, 0.015, -0.058, 0.055, 0.078, 0.058, SHOE)
  toe.box(-0.006, 0, -0.062, 0.062, 0.02, 0.062, SOLE)
  p.toe = toe

  return p
}

/**
 * Outbreak civilian survivor / zombie mesh adapter sharing the canonical RIG pivots,
 * matching games/outbreak/src/survivor.ts so Outbreak characters can be inspected side-by-side.
 */
export function outbreakPersonModels(zombie = false): PersonModels {
  const p = personModels()
  const box = (w: number, y0: number, h: number, d: number, col: Rgb) => {
    const m = new ZombiePart()
    m.box(-w / 2, y0, -d / 2, w / 2, y0 + h, d / 2, col, MAT.actor)
    return m
  }
  const trousers = zombie ? hex(0x2b3136) : hex(0x41474b)
  const jacket = zombie ? hex(0x4a4236) : hex(0x8c6b42)
  const skin = zombie ? SKIN : hex(0xad8266)
  const forearmSkin = zombie ? SKIN_D : hex(0x9b7858)
  const hair = zombie ? RAG_D : hex(0x3b342d)
  const boot = hex(0x3b3029)

  p.pelvis = box(0.25, -0.07, 0.18, 0.34, trousers)
  p.torso = box(0.28, -0.02, 0.48, 0.4, jacket)
  if (!zombie) {
    p.torso.box(-0.29, 0.07, -0.15, -0.14, 0.4, 0.15, hex(0x4d6259), MAT.actor)
    p.torso.box(-0.3, 0.28, -0.14, -0.28, 0.32, 0.14, hex(0xa3a48a), MAT.actor)
  } else {
    p.torso.box(0.11, 0.12, -0.12, 0.145, 0.36, 0.08, WOUND, MAT.actor)
    p.torso.box(-0.145, 0.16, -0.10, -0.11, 0.38, 0.12, WOUND, MAT.actor)
  }
  p.head = box(0.18, 0.01, 0.24, 0.18, skin)
  p.head.box(-0.1, 0.19, -0.11, 0.1, 0.28, 0.11, hair, MAT.actor)
  if (zombie) {
    for (const z of [-0.042, 0.042]) {
      p.head.box(0.086, 0.13, z - 0.016, 0.095, 0.155, z + 0.016, hex(0x98d838), MAT.glow, 0.55)
    }
  }
  p.upperArm = box(0.15, -0.29, 0.33, 0.15, jacket)
  p.foreArm = box(0.11, -0.28, 0.3, 0.11, forearmSkin)
  if (zombie) {
    p.foreArm.box(-0.04, -0.31, -0.045, 0.055, -0.26, 0.045, WOUND, MAT.actor)
  }
  p.thigh = box(0.17, -0.42, 0.46, 0.17, trousers)
  p.shin = box(0.13, -0.41, 0.43, 0.14, trousers)
  const foot = new ZombiePart()
  foot.box(-0.075, -0.075, -0.068, 0.125, 0.015, 0.068, boot)
  foot.box(-0.078, -0.085, -0.07, 0.128, -0.065, 0.07, SOLE)
  p.foot = foot
  const toe = new ZombiePart()
  toe.box(-0.008, 0.015, -0.065, 0.06, 0.082, 0.065, boot)
  toe.box(-0.006, 0, -0.068, 0.065, 0.02, 0.068, SOLE)
  p.toe = toe
  return p
}
