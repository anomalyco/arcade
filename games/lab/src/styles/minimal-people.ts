import { MAT, Mesh, hex, type Rgb } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import { boneIds } from "@arcade/kit/human-pose"
import { clamp, type Frame } from "@arcade/kit/rig"
import { supportHeight } from "../../../outbreak/shared/terrain"
import { Vision } from "../../../outbreak/shared/vision"
import { Survivor } from "../../../outbreak/src/survivor"
import { ZombieCrowdRenderer } from "../../../outbreak/src/zombies"
import type { ActiveShotSummary, StylePlaygroundSim } from "./sim-loop"
import type { PeopleStyleId } from "./types"

export type StyledBatch = Batch & {
  actorRole: 0 | 1 | 2 | 3
}

function frameToAngles(f: Frame): [number, number, number] {
  const p = Math.asin(clamp(f.x[1], -1, 1))
  const c = Math.cos(p)
  const yaw = c > 1e-4 ? Math.atan2(f.x[2], f.x[0]) : Math.atan2(-f.z[0], f.z[2])
  const r = c > 1e-4 ? Math.atan2(-f.z[1], f.y[1]) : 0
  return [yaw, p, r]
}

function buildBlockyPartMeshes(isZombie: boolean): Mesh[] {
  const box = (w: number, y0: number, h: number, d: number, col: Rgb) => {
    const m = new Mesh()
    m.bevelBox(-w / 2, y0, -d / 2, w / 2, y0 + h, d / 2, 0.025, col, col, MAT.actor)
    return m
  }
  const skin = isZombie ? hex(0x6eb854) : hex(0xe8b48a)
  const torsoCol = isZombie ? hex(0x52644a) : hex(0xd48c3b)
  const vestCol = isZombie ? hex(0x8c2424) : hex(0x3a6ea5)
  const legsCol = isZombie ? hex(0x363f48) : hex(0x323b44)
  const bootCol = hex(0x221e1b)

  const pelvis = box(0.30, -0.08, 0.20, 0.38, legsCol)
  const torso = box(0.34, -0.02, 0.50, 0.44, torsoCol)
  torso.box(-0.18, 0.08, -0.23, 0.18, 0.44, 0.23, vestCol, MAT.actor)
  const head = box(0.28, 0.0, 0.30, 0.28, skin)
  if (isZombie) {
    head.box(0.12, 0.14, -0.08, 0.15, 0.20, -0.03, hex(0xffe042), MAT.glow, 0.85)
    head.box(0.12, 0.14, 0.03, 0.15, 0.20, 0.08, hex(0xffe042), MAT.glow, 0.85)
  } else {
    head.box(-0.15, 0.22, -0.15, 0.15, 0.32, 0.15, hex(0x342a22), MAT.actor)
  }
  const upperArm = box(0.18, -0.29, 0.34, 0.18, torsoCol)
  const foreArm = box(0.15, -0.28, 0.30, 0.15, skin)
  const thigh = box(0.20, -0.42, 0.46, 0.20, legsCol)
  const shin = box(0.17, -0.41, 0.43, 0.17, legsCol)
  const foot = box(0.24, -0.08, 0.10, 0.17, bootCol)
  return [pelvis, torso, head, upperArm, foreArm, thigh, shin, foot]
}

function buildCapsulePartMeshes(isZombie: boolean): Mesh[] {
  const cyl = (r: number, y0: number, y1: number, col: Rgb, segs = 10) => {
    const m = new Mesh()
    m.prism(0, 0, r, r, y0, y1, segs, col, MAT.actor)
    return m
  }
  const skin = isZombie ? hex(0x68b050) : hex(0xe2ad84)
  const torsoCol = isZombie ? hex(0x55664e) : hex(0xc88238)
  const legsCol = isZombie ? hex(0x38414a) : hex(0x35404b)

  const pelvis = cyl(0.18, -0.07, 0.12, legsCol, 10)
  const torso = cyl(0.21, -0.02, 0.48, torsoCol, 12)
  const head = cyl(0.15, 0.01, 0.28, skin, 12)
  const upperArm = cyl(0.085, -0.29, 0.04, torsoCol, 8)
  const foreArm = cyl(0.072, -0.28, 0.02, skin, 8)
  const thigh = cyl(0.095, -0.42, 0.04, legsCol, 8)
  const shin = cyl(0.08, -0.41, 0.02, legsCol, 8)
  const foot = cyl(0.10, -0.075, 0.02, hex(0x241f1c), 8)
  return [pelvis, torso, head, upperArm, foreArm, thigh, shin, foot]
}

function buildPawnMesh(isZombie: boolean): Mesh {
  const m = new Mesh()
  const baseCol = isZombie ? hex(0xc83828) : hex(0x28b8d8)
  const bodyCol = isZombie ? hex(0x5c9648) : hex(0xd89238)
  const headCol = isZombie ? hex(0x7ac45a) : hex(0xedd0b0)
  // Tactile boardgame token base ring + tapered pillar + floating head sphere
  m.prism(0, 0, 0.34, 0.32, 0.0, 0.08, 14, baseCol, MAT.actor)
  m.prism(0, 0, 0.26, 0.17, 0.08, 0.88, 12, bodyCol, MAT.actor)
  m.prism(0, 0, 0.18, 0.14, 0.94, 1.32, 12, headCol, MAT.actor)
  // Forward direction nose/visor indicator
  m.box(0.12, 1.06, -0.10, 0.26, 1.20, 0.10, baseCol, MAT.actor)
  return m
}

const BONE_INDEX_TO_PART = [0, 1, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7]

export class StyleMinimalPeople {
  readonly survivor: Survivor
  readonly zombies: ZombieCrowdRenderer
  private readonly vision = new Vision()
  private readonly blockySurvModels: number[]
  private readonly blockyZombModels: number[]
  private readonly capsuleSurvModels: number[]
  private readonly capsuleZombModels: number[]
  private readonly pawnSurvModel: number
  private readonly pawnZombModel: number
  private readonly pistolModel: number
  private readonly doorModel: number
  private readonly plankModel: number
  private readonly beamModel: number
  private readonly burstModel: number

  private readonly customData = new Float32Array(256 * INST_FLOATS)
  private readonly doorData = new Float32Array(8 * INST_FLOATS)
  private readonly plankData = new Float32Array(16 * INST_FLOATS)
  private readonly fxData = new Float32Array(8 * INST_FLOATS)
  private lastSteppedTick = -1
  private lastSteppedSeed = -1

  constructor(renderer: Renderer) {
    this.survivor = new Survivor(renderer, { torso: 0xc4823b, legs: 0x38424b })
    this.zombies = new ZombieCrowdRenderer(renderer, 32)

    this.blockySurvModels = buildBlockyPartMeshes(false).map(m => renderer.addModel(m))
    this.blockyZombModels = buildBlockyPartMeshes(true).map(m => renderer.addModel(m))
    this.capsuleSurvModels = buildCapsulePartMeshes(false).map(m => renderer.addModel(m))
    this.capsuleZombModels = buildCapsulePartMeshes(true).map(m => renderer.addModel(m))
    this.pawnSurvModel = renderer.addModel(buildPawnMesh(false))
    this.pawnZombModel = renderer.addModel(buildPawnMesh(true))

    const pistol = new Mesh()
    pistol.box(-0.04, -0.09, -0.022, 0.22, 0.06, 0.022, hex(0x2b3036), MAT.actor)
    this.pistolModel = renderer.addModel(pistol)

    const doorMesh = new Mesh()
    doorMesh.box(0, 0.13, -0.1, 1.4, 2.3, 0.1, hex(0x463322), MAT.timber)
    this.doorModel = renderer.addModel(doorMesh)

    const plankMesh = new Mesh()
    plankMesh.box(-0.06, -0.08, -0.65, 0.06, 0.08, 0.65, hex(0x8f683d), MAT.timber)
    this.plankModel = renderer.addModel(plankMesh)

    const beamMesh = new Mesh()
    beamMesh.box(0, -0.028, -0.028, 1.0, 0.028, 0.028, hex(0xffe066), MAT.glow, 1.8)
    this.beamModel = renderer.addModel(beamMesh)

    const burstMesh = new Mesh()
    burstMesh.bevelBox(-0.14, -0.14, -0.14, 0.14, 0.14, 0.14, 0.04, hex(0xffb833), hex(0xfff2a6), MAT.glow, MAT.glow)
    this.burstModel = renderer.addModel(burstMesh)
  }

  buildBatches(
    sim: StylePlaygroundSim,
    peopleStyle: PeopleStyleId,
    shot: ActiveShotSummary,
  ): StyledBatch[] {
    const view = sim.view
    const town = view.town
    const support = (x: number, z: number) => supportHeight(town, x, z)

    // Step the shared rig poses once per sim tick so all 9 tiles in a grid share identical bone matrices
    if (sim.seed !== this.lastSteppedSeed) {
      this.survivor.reset()
      this.zombies.reset()
      this.lastSteppedSeed = sim.seed
      this.lastSteppedTick = -1
    }
    const dt = sim.tick !== this.lastSteppedTick ? 1 / 60 : 0.0001
    this.lastSteppedTick = sim.tick

    const rigSurvBatches = this.survivor.draw(
      { ...view.player, aiming: true },
      dt,
      view.time,
      support,
    )
    const rigZombBatches = this.zombies.draw(
      view.zombies,
      dt,
      support,
      this.vision,
      [14, 20, 42, 46],
      {
        zombieVariant: 0,
        zombieLurch: 0.65,
        zombieAsymmetry: 0.55,
        zombieDrag: 0.5,
        zombieReach: 0.75,
        fogGhostDuration: 0,
      },
      true,
      view.time,
    )

    const out: StyledBatch[] = []

    // 1. Doors & barricade planks
    town.doors.forEach((door, i) => {
      this.doorData.set(
        [door.rect[0], 0, (door.rect[1] + door.rect[3]) / 2, door.open ? -Math.PI / 2 : 0, 1, 1, 1, 1, 0, 0, 1, 0],
        i * INST_FLOATS,
      )
    })
    if (town.doors.length > 0) {
      out.push({ model: this.doorModel, data: this.doorData, count: town.doors.length, actorRole: 0 })
    }

    let plankCount = 0
    for (const w of town.windows) {
      const n = sim.session.ai.getBarricadePlanks(w.id)
      const cx = (w.rect[0] + w.rect[2]) * 0.5
      const cz = (w.rect[1] + w.rect[3]) * 0.5
      const horiz = w.rect[2] - w.rect[0] > w.rect[3] - w.rect[1]
      for (let pIdx = 0; pIdx < n && plankCount < 16; pIdx++) {
        this.plankData.set(
          [cx, 1.05 + pIdx * 0.34, cz, horiz ? Math.PI / 2 : 0, 1, 1, 1, 1, 0, (pIdx - 1) * 0.06, 1, 0],
          plankCount++ * INST_FLOATS,
        )
      }
    }
    if (plankCount > 0) {
      out.push({ model: this.plankModel, data: this.plankData, count: plankCount, actorRole: 0 })
    }

    // 2. Survivor & Zombie batches driven by the shared rig BonePose
    if (peopleStyle === "rig") {
      for (const b of rigSurvBatches) out.push({ ...b, actorRole: 1 })
      for (const b of rigZombBatches) out.push({ ...b, actorRole: 2 })
    } else if (peopleStyle === "pawn") {
      let cursor = 0
      const pushInst = (
        model: number,
        x: number,
        y: number,
        z: number,
        yaw: number,
        pitch: number,
        roll: number,
        scale: number,
        flash: number,
        actorRole: 1 | 2,
      ) => {
        const sub = this.customData.subarray(cursor * INST_FLOATS, (cursor + 1) * INST_FLOATS)
        sub.set([x, y, z, yaw, 1, 1, 1, scale, pitch, roll, 1, flash])
        out.push({ model, data: sub, count: 1, actorRole })
        cursor++
      }
      const pTorso = this.survivor.bones.torso
      const [pYaw, pPitch, pRoll] = pTorso ? frameToAngles(pTorso) : [view.player.aim, 0, 0]
      const py = support(view.player.x, view.player.y)
      pushInst(this.pawnSurvModel, view.player.x, py, view.player.y, pYaw, pPitch * 0.35, pRoll * 0.35, 1, 0, 1)
      if (this.survivor.gun) {
        const [gy, gp, gr] = frameToAngles(this.survivor.gun)
        pushInst(this.pistolModel, this.survivor.gun.p[0], this.survivor.gun.p[1], this.survivor.gun.p[2], gy, gp, gr, 1.15, 0, 1)
      }
      for (const z of view.zombies) {
        const pose = this.zombies.getAgentBones(z.id)
        const zTorso = pose?.bones.torso
        const [zy, zp, zr] = zTorso ? frameToAngles(zTorso) : [z.aim, 0, 0]
        const zyFloor = support(z.x, z.y)
        pushInst(this.pawnZombModel, z.x, zyFloor, z.y, zy, zp, zr, 1, z.hitFlash, 2)
      }
    } else {
      const survModels = peopleStyle === "capsule" ? this.capsuleSurvModels : this.blockySurvModels
      const zombModels = peopleStyle === "capsule" ? this.capsuleZombModels : this.blockyZombModels
      let cursor = 0
      const emitBoneFrame = (model: number, f: Frame | undefined, flash: number, scale: number, role: 1 | 2) => {
        if (!f || cursor >= 250) return
        const [yaw, pitch, roll] = frameToAngles(f)
        const sub = this.customData.subarray(cursor * INST_FLOATS, (cursor + 1) * INST_FLOATS)
        sub.set([f.p[0], f.p[1], f.p[2], yaw, 1, 1, 1, scale, pitch, roll, 1, flash])
        out.push({ model, data: sub, count: 1, actorRole: role })
        cursor++
      }
      for (let bIdx = 0; bIdx < boneIds.length; bIdx++) {
        const bid = boneIds[bIdx]!
        const partIdx = BONE_INDEX_TO_PART[bIdx]!
        emitBoneFrame(survModels[partIdx]!, this.survivor.bones[bid], 0, 1.0, 1)
      }
      if (this.survivor.gun) {
        emitBoneFrame(this.pistolModel, this.survivor.gun, 0, 1.1, 1)
      }
      for (const z of view.zombies) {
        const pose = this.zombies.getAgentBones(z.id)
        if (!pose) continue
        for (let bIdx = 0; bIdx < boneIds.length; bIdx++) {
          const bid = boneIds[bIdx]!
          if (pose.hiddenBones.has(bid)) continue
          const partIdx = BONE_INDEX_TO_PART[bIdx]!
          emitBoneFrame(zombModels[partIdx]!, pose.bones[bid], z.hitFlash, 1.0, 2)
        }
      }
    }

    // Style shaders draw their own authentic 2D/3D gunfire & impact marks from SU.shotScreen,
    // so we omit 3D box beams from the G-buffer to keep depth/normal silhouettes clean.
    void shot

    return out
  }
}
