import type { LabControl } from "@arcade/kit/lab-panel"
import { attachment, bodyBones, detach, type BoneId, type BonePose, type PartMotion } from "@arcade/kit/human-pose"
import { humanProfiles } from "@arcade/kit/human-profile"
import { at, emit, len, moved, RIG, scale, turn, type PushPart } from "@arcade/kit/rig"
import { animate, emitBody, newAvatar, type PartModels } from "../game/anim"
import { animation } from "../game/anim-settings"
import { Mesh } from "../render/mesh"
import { personModels, type PersonModels } from "../render/person"
import { wizardModels, wizardWeapon } from "../render/wizard"
import { zombieModels } from "../render/zombie"
import type { Batch, Renderer } from "../render/renderer"

export const rigDemoControls: LabControl[] = [
  { key: "rigDemo", label: "Demo", group: "Animation", options: [
    { label: "Actors", value: "off" }, { label: "Profile walk", value: "walk" }, { label: "Detached forearm", value: "detach" },
    { label: "Three profiles", value: "compare" },
  ] },
  { key: "rigDemoSpeed", label: "Demo speed · m/s", group: "Animation", min: 0, max: 6.3, step: 0.1, unit: "m/s" },
]

export function registerPartModels(renderer: Pick<Renderer, "addModel">, p: PersonModels): PartModels {
  const reg = (mesh: Mesh) => renderer.addModel(mesh)
  const guns = (r: typeof p.gun) => ({ rifle: reg(r.rifle), shotgun: reg(r.shotgun), sniper: reg(r.sniper) })
  return { pelvis: reg(p.pelvis), torso: reg(p.torso), head: reg(p.head), upperArm: reg(p.upperArm),
    foreArm: reg(p.foreArm), thigh: reg(p.thigh), shin: reg(p.shin), foot: reg(p.foot), pump: reg(p.pump),
    gun: guns(p.gun), mag: guns(p.mag), casing: guns(p.casing), hole: reg(p.hole) }
}

export function modelForBone(models: PartModels, bone: BoneId): number {
  if (bone === "pelvis") return models.pelvis
  if (bone === "torso") return models.torso
  if (bone === "head") return models.head
  if (bone.endsWith(".upperArm")) return models.upperArm
  if (bone.endsWith(".foreArm")) return models.foreArm
  if (bone.endsWith(".thigh")) return models.thigh
  if (bone.endsWith(".shin")) return models.shin
  return models.foot
}

/** Viewer-only visual debris. No world events, damage, movement or attack policy. */
export class RigDemo {
  avatar = newAvatar("rig-demo", 12, 10, 0, "rifle")
  previous: BonePose | undefined
  pieces: (PartMotion & { bone: BoneId })[] = []
  time = 0
  noPop = false
  private mode = "off"
  private models: PartModels
  private wizardParts: PartModels
  private zombieParts: PartModels
  private staff: number
  private comparison = [newAvatar("wizard-demo", 12, 8.2, 0, "rifle"), newAvatar("zombie-demo", 12, 11.8, 0, "rifle")]
  private distance = 0
  constructor(renderer: Renderer, private readonly onDetach?: (part: PartMotion & { bone: BoneId }) => void) {
    this.models = registerPartModels(renderer, personModels())
    this.wizardParts = registerPartModels(renderer, wizardModels())
    this.zombieParts = registerPartModels(renderer, zombieModels())
    this.staff = renderer.addModel(wizardWeapon("rifle"))
  }

  build(dt: number, mode: string, speed = 1.1): Batch[] {
    dt = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.05)) : 0
    if (mode !== this.mode || this.time >= 6) {
      this.avatar = newAvatar("rig-demo", 12, 10, 0, "rifle")
      this.comparison = [newAvatar("wizard-demo", 12, 8.2, 0, "rifle"), newAvatar("zombie-demo", 12, 11.8, 0, "rifle")]
      this.previous = undefined; this.pieces = []; this.time = 0; this.distance = 0; this.noPop = false; this.mode = mode
    }
    if (mode === "off") return []
    // Integrate only previously detached pieces, preserving the exact first displayed pose.
    for (const piece of this.pieces) {
      piece.linear[1] -= 9.81 * dt
      const p = piece.frame.p.map((v, i) => v + piece.linear[i]! * dt) as [number, number, number]
      const speed = len(piece.angular)
      piece.frame = moved(speed > 0 ? turn(piece.frame, scale(piece.angular, 1 / speed), speed * dt) : piece.frame, p)
      const low = Math.min(piece.frame.p[1], at(piece.frame, 0, -RIG.fore, 0)[1]) - 0.055
      if (low < 0) {
        piece.frame.p[1] -= low
        piece.linear = [piece.linear[0] * 0.8, Math.abs(piece.linear[1]) * 0.15, piece.linear[2] * 0.8]
        piece.angular = scale(piece.angular, 0.75)
      }
    }
    this.time += dt
    const a = this.avatar
    const velocity = this.time < 5 ? speed : 0
    this.distance += velocity * dt
    const x = 12 + this.distance
    a.profile = mode === "compare" ? humanProfiles.soldier : undefined
    animate(a, dt, this.time, x, 10, velocity, 0, Math.sin(this.time * 0.7) * 0.35)
    const bones = bodyBones(a.body!)
    if (mode === "detach" && this.time >= 2 && !a.hiddenBones?.size) {
      a.hiddenBones = new Set()
      const pieces = detach(bones, this.previous, dt, "right.foreArm", a.hiddenBones)
      this.pieces = pieces
      if (pieces[0]) this.onDetach?.(pieces[0])
      this.noPop = JSON.stringify(this.pieces[0]?.frame) === JSON.stringify(bones["right.foreArm"])
    }
    this.previous = bones
    const batches: Batch[] = []
    const push: PushPart = (model, x, y, z, yaw, tint, pitch, roll, flash, alpha = 1) => {
      batches.push({ model, data: new Float32Array([x, y, z, yaw, ...tint, 1, pitch, roll, alpha, flash]), count: 1 })
    }
    const activeModels = mode === "compare" ? this.models
      : animation.profilePreset === "wizard" ? this.wizardParts
      : animation.profilePreset === "zombie" ? this.zombieParts : this.models
    const activeColor: readonly [number, number, number] = mode === "compare" ? [0.2, 0.8, 0.6]
      : animation.profilePreset === "wizard" ? [0.65, 0.35, 0.9]
      : animation.profilePreset === "zombie" ? [0.45, 0.72, 0.25] : [0.2, 0.8, 0.6]
    emitBody(push, a.body!, a.gun, activeColor, activeModels, 0, 1, a.hiddenBones)
    for (const piece of this.pieces) emit(push, modelForBone(activeModels, piece.bone), piece.frame, activeColor, 0)
    const staff = (actor: typeof a) => {
      const hand = attachment(bodyBones(actor.body!), "right.hand", actor.hiddenBones)
      if (hand && (actor.profile ?? animation).handPose === "staff") emit(push, this.staff, { ...actor.body!.torso, p: hand.p }, [1, 1, 1], 0)
    }
    staff(a)
    if (mode === "compare") this.comparison.forEach((actor, i) => {
      actor.profile = i === 0 ? humanProfiles.wizard : humanProfiles.zombie
      animate(actor, dt, this.time, x, i === 0 ? 8.2 : 11.8, velocity, 0, Math.sin(this.time * 0.7) * 0.35)
      emitBody(push, actor.body!, actor.gun, i === 0 ? [0.65, 0.35, 0.9] : [0.45, 0.72, 0.25], i === 0 ? this.wizardParts : this.zombieParts, 0)
      staff(actor)
    })
    return batches
  }
}
