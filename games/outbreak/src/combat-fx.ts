import { Splatter, splatterPresets, type SplatterImpact } from "@arcade/kit/fx/splatter"
import { SplatterSurfaces, type SplatterMaterial } from "@arcade/kit/fx/splatter-surfaces"
import type { LevelData } from "@arcade/kit/gpu/level"
import { MAT, Mesh } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, SPRITE_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import { attachment, limbIds, pointVelocity, type BonePose } from "@arcade/kit/human-pose"
import type { V3 } from "@arcade/kit/rig"
import type { OutbreakAISubsystem } from "../shared/ai"
import type { CombatShotEvent, SurvivorCombatState } from "../shared/combat"
import type { Town } from "../shared/map"
import { hex } from "./level"
import type { ZombieCrowdRenderer } from "./zombies"

const half = (h: number) => {
  const s = h & 0x8000 ? -1 : 1
  const e = (h >> 10) & 31
  const m = h & 1023
  return s * (e ? 2 ** (e - 15) * (1 + m / 1024) : 2 ** -14 * (m / 1024))
}

const splatterSurfaceCache = new WeakMap<LevelData, SplatterSurfaces>()

/** Extracts visible receiver triangles from Outbreak's compiled LevelData for blood splatter decals. */
export function outbreakSplatterSurfaces(level: LevelData): SplatterSurfaces {
  const cached = splatterSurfaceCache.get(level)
  if (cached) return cached
  const triangles: number[] = []
  for (const chunks of [level.chunks, level.glass]) {
    for (const chunk of chunks) {
      if (chunk.customCutaway) continue
      const p = new DataView(chunk.data)
      for (let i = 0; i < chunk.data.byteLength; i += 72) {
        const mat = Math.round(half(p.getUint16(i + 20, true)))
        const floor = Math.round(half(p.getUint16(i + 22, true)))
        if (mat === 21 || mat === 18 || mat === 22) continue // Skip roofs and foliage tufts
        const material: SplatterMaterial =
          mat === 6 || mat === 2 || mat === 3 ? 3 : mat === 10 ? 2 : mat === 1 && (floor === 0 || floor === 6) ? 1 : 0
        for (let v = 0; v < 3; v++) {
          for (let c = 0; c < 3; c++) {
            triangles.push(p.getFloat32(i + v * 24 + c * 4, true))
          }
        }
        triangles.push(material)
      }
    }
  }
  const surfaces = new SplatterSurfaces(triangles)
  splatterSurfaceCache.set(level, surfaces)
  return surfaces
}

const LEGACY_BLOOD_PRESET = {
  amount: 32,
  impulse: 5.5,
  spread: 0.65,
  sizeMin: 0.025,
  sizeMax: 0.115,
  drag: 0.7,
  gravity: 9.8,
  r: 0.12,
  g: 0.002,
  b: 0.006,
  opacity: 0.94,
  decalSize: 4,
  persistence: 22,
  pooling: 0.45,
  budget: 192,
} as const

export class OutbreakCombatFX {
  private readonly pistolModel: number
  private readonly plankModel: number
  private readonly pistolData = new Float32Array(INST_FLOATS)
  private readonly plankData = new Float32Array(64 * INST_FLOATS)
  private readonly seenShots = new Set<number>()
  private syntheticEventId = 100_000
  private levelData: LevelData | null = null
  splatter: Splatter | null = null
  hasEmitted = false
  legacyMode = false
  private lastFlash: { x: number; y: number; z: number; until: number } | null = null

  constructor(renderer: Pick<Renderer, "addModel">) {
    const pistol = new Mesh()
    // Compact semi-auto 9mm slide and grip
    pistol.box(-0.04, -0.09, -0.018, 0.03, 0.01, 0.018, hex(0x2b2d2f), MAT.actor)
    pistol.box(-0.05, 0.0, -0.022, 0.16, 0.048, 0.022, hex(0x3a3f42), MAT.actor)
    pistol.box(0.14, 0.048, -0.006, 0.155, 0.058, 0.006, hex(0xd8ccb8), MAT.actor)
    this.pistolModel = renderer.addModel(pistol)

    const plank = new Mesh()
    plank.box(-0.78, -0.065, -0.025, 0.78, 0.065, 0.025, hex(0x8e6f48), MAT.timber)
    plank.box(-0.68, -0.02, -0.032, -0.64, 0.02, 0.032, hex(0x353738), MAT.actor)
    plank.box(0.64, -0.02, -0.032, 0.68, 0.02, 0.032, hex(0x353738), MAT.actor)
    this.plankModel = renderer.addModel(plank)
  }

  setLevel(level: LevelData): void {
    this.levelData = level
    this.splatter = null
    this.hasEmitted = false
  }

  reset(): void {
    this.seenShots.clear()
    this.splatter?.reset()
    this.hasEmitted = false
    this.lastFlash = null
  }

  stepAndCollect(
    dt: number,
    time: number,
    town: Town,
    player: { x: number; y: number; aim: number } & SurvivorCombatState,
    survivorBones: BonePose,
    ai: OutbreakAISubsystem,
    zombieCrowd: ZombieCrowdRenderer,
    support: (x: number, z: number) => number,
    addSprites: Float32Array,
    startAddCount: number,
  ): { batches: Batch[]; addCount: number; muzzleLight: [number, number, number, number] | null } {
    this.splatter?.update(dt)

    // Process new shots for blood splatter, limb detachment, and muzzle flash
    for (const shot of this.getRecentShots(ai, player)) {
      void shot
    }

    let addCount = startAddCount
    const maxAdd = Math.floor(addSprites.length / SPRITE_FLOATS)
    const pushAdd = (
      x: number,
      y: number,
      z: number,
      size: number,
      r: number,
      g: number,
      b: number,
      a: number,
      kind: number,
      rot: number,
      stretch: number,
      extra: number,
    ) => {
      if (addCount >= maxAdd) return
      const o = addCount++ * SPRITE_FLOATS
      addSprites[o] = x
      addSprites[o + 1] = y
      addSprites[o + 2] = z
      addSprites[o + 3] = size
      addSprites[o + 4] = r
      addSprites[o + 5] = g
      addSprites[o + 6] = b
      addSprites[o + 7] = a
      addSprites[o + 8] = kind
      addSprites[o + 9] = rot
      addSprites[o + 10] = stretch
      addSprites[o + 11] = extra
    }

    const batches: Batch[] = []

    // 1. Equipped 3D pistol in right hand
    if (player.equippedItem === "pistol") {
      const hand = attachment(survivorBones, "right.hand")
      const px = hand ? hand.p[0] : player.x + Math.cos(player.aim) * 0.32
      const py = hand ? hand.p[1] + 0.04 : support(player.x, player.y) + 1.18
      const pz = hand ? hand.p[2] : player.y + Math.sin(player.aim) * 0.32
      const recoilPitch = player.recoil * 0.38 - (player.reloadRemaining > 0 ? 0.55 : 0)
      this.pistolData.set([px, py, pz, player.aim, 1, 1, 1, 1, recoilPitch, 0, 1, 0])
      batches.push({ model: this.pistolModel, data: this.pistolData, count: 1 })
    }

    // 2. Barricade planks across doors and windows
    let plankCount = 0
    const addPortalPlanks = (id: string, rect: readonly [number, number, number, number], baseH: number) => {
      const n = ai.getBarricadePlanks(id)
      if (n <= 0) return
      const [x0, y0, x1, y1] = rect
      const horizontal = x1 - x0 > y1 - y0
      const cx = (x0 + x1) * 0.5
      const cz = (y0 + y1) * 0.5
      const yaw = horizontal ? 0 : Math.PI / 2
      const groundY = support(cx, cz)
      const heights = [baseH, baseH + 0.34, baseH - 0.32]
      const tilts = [0.06, -0.08, 0.03]
      for (let k = 0; k < Math.min(3, n); k++) {
        if (plankCount >= 64) break
        this.plankData.set(
          [cx, groundY + heights[k]!, cz, yaw, 1, 1, 1, 1, tilts[k]!, 0, 1, 0],
          plankCount++ * INST_FLOATS,
        )
      }
    }
    for (const d of town.doors) addPortalPlanks(d.id, d.rect, 1.25)
    for (const w of town.windows) addPortalPlanks(w.id, w.rect, 1.42)
    if (plankCount > 0) {
      batches.push({ model: this.plankModel, data: this.plankData, count: plankCount })
    }

    // 3. Muzzle flash, door/barricade bash impact splinters, & tracer sprites
    for (const d of town.doors) {
      const st = ai.portalStates.get(d.id)
      if (st && time - st.lastBashTime >= 0 && time - st.lastBashTime < 0.16) {
        const u = 1 - (time - st.lastBashTime) / 0.16
        const cx = (d.rect[0] + d.rect[2]) * 0.5
        const cz = (d.rect[1] + d.rect[3]) * 0.5
        const cy = support(cx, cz) + 1.15
        pushAdd(cx, cy, cz, 0.28 * u, 0.95, 0.68, 0.32, u * 0.75, 0, 0, 1, 0)
        pushAdd(cx, support(cx, cz) + 0.06, cz, 0.45 + (1 - u) * 0.85, 0.95, 0.62, 0.28, u * 0.65, 2, 0, 0.08, 0)
      }
    }
    for (const w of town.windows) {
      const st = ai.portalStates.get(w.id)
      if (st && time - st.lastBashTime >= 0 && time - st.lastBashTime < 0.16) {
        const u = 1 - (time - st.lastBashTime) / 0.16
        const cx = (w.rect[0] + w.rect[2]) * 0.5
        const cz = (w.rect[1] + w.rect[3]) * 0.5
        const cy = support(cx, cz) + 1.35
        pushAdd(cx, cy, cz, 0.28 * u, 0.95, 0.68, 0.32, u * 0.75, 0, 0, 1, 0)
        pushAdd(cx, support(cx, cz) + 0.06, cz, 0.45 + (1 - u) * 0.85, 0.95, 0.62, 0.28, u * 0.65, 2, 0, 0.08, 0)
      }
    }

    let muzzleLight: [number, number, number, number] | null = null
    if (this.lastFlash && time < this.lastFlash.until) {
      const strength = (this.lastFlash.until - time) / 0.08
      muzzleLight = [this.lastFlash.x, this.lastFlash.y, this.lastFlash.z, strength * 1.35]
      pushAdd(this.lastFlash.x, this.lastFlash.y, this.lastFlash.z, 0.26 * strength, 1.0, 0.78, 0.35, 0.95, 0, 0, 1, 0)
    }

    void zombieCrowd
    return { batches, addCount, muzzleLight }
  }

  processShots(
    shots: readonly CombatShotEvent[],
    time: number,
    dt: number,
    ai: OutbreakAISubsystem,
    zombieCrowd: ZombieCrowdRenderer,
    support: (x: number, z: number) => number,
    addSprites: Float32Array,
    startAddCount: number,
    onNewShot?: (shot: CombatShotEvent) => void,
  ): number {
    let addCount = startAddCount
    const maxAdd = Math.floor(addSprites.length / SPRITE_FLOATS)
    const pushAdd = (
      x: number,
      y: number,
      z: number,
      size: number,
      r: number,
      g: number,
      b: number,
      a: number,
      kind: number,
      rot: number,
      stretch: number,
      extra: number,
    ) => {
      if (addCount >= maxAdd) return
      const o = addCount++ * SPRITE_FLOATS
      addSprites[o] = x
      addSprites[o + 1] = y
      addSprites[o + 2] = z
      addSprites[o + 3] = size
      addSprites[o + 4] = r
      addSprites[o + 5] = g
      addSprites[o + 6] = b
      addSprites[o + 7] = a
      addSprites[o + 8] = kind
      addSprites[o + 9] = rot
      addSprites[o + 10] = stretch
      addSprites[o + 11] = extra
    }

    for (const s of shots) {
      const age = time - s.time
      if (age >= 0 && age <= 0.09) {
        const u = 1 - age / 0.09
        const mx = (s.fromX + s.toX) * 0.5
        const mz = (s.fromY + s.toY) * 0.5
        const my = support(mx, mz) + 1.18
        const len = Math.hypot(s.toX - s.fromX, s.toY - s.fromY)
        if (len > 0.3) {
          pushAdd(mx, my, mz, len * 0.5, 1.0, 0.84, 0.45, u * 0.85, 4, s.aim, 0.025 / Math.max(0.5, len * 0.5), 0)
        }
      }

      if (this.seenShots.has(s.id)) continue
      this.seenShots.add(s.id)
      onNewShot?.(s)
      const fy = support(s.fromX, s.fromY) + 1.2
      this.lastFlash = { x: s.fromX, y: fy, z: s.fromY, until: time + 0.08 }

      if (s.hitZombieId !== null && this.levelData) {
        this.splatter ??= new Splatter(outbreakSplatterSurfaces(this.levelData))
        this.hasEmitted = true
        const z = ai.agents.find((a) => a.id === s.hitZombieId)
        const dx = Math.cos(s.aim)
        const dz = Math.sin(s.aim)
        const groundY = support(s.toX, s.toY)

        if (this.legacyMode) {
          const legacyHitY = groundY + (s.detachBone === "head" ? 1.52 : 1.15)
          if (z && s.detachBone) {
            const detached = zombieCrowd.detachAgentLimb(z, s.detachBone, dt, [dx, 0.25, dz])
            const rootPiece = detached[0]
            if (rootPiece) {
              const [vx, vy, vz] = pointVelocity(rootPiece, rootPiece.frame.p)
              this.splatter.emit(
                {
                  id: s.id,
                  limbId: limbIds[rootPiece.bone],
                  seed: s.seed,
                  x: rootPiece.frame.p[0],
                  y: rootPiece.frame.p[1],
                  z: rootPiece.frame.p[2],
                  dx,
                  dy: 0.12,
                  dz,
                  vx,
                  vy,
                  vz,
                  amount: s.killed ? 1.35 : 1.0,
                },
                LEGACY_BLOOD_PRESET,
              )
              continue
            }
          }
          this.splatter.emit(
            {
              id: s.id,
              seed: s.seed,
              x: s.toX,
              y: legacyHitY,
              z: s.toY,
              dx,
              dy: 0.08,
              dz,
              amount: s.killed ? 1.25 : 0.85,
            },
            LEGACY_BLOOD_PRESET,
          )
          continue
        }

        const hitY = groundY + (s.detachBone === "head" ? 1.32 : 1.08)

        // Primary exit-wound ballistic spray fanning along the bullet vector onto floor and walls behind the zombie
        this.splatter.emit(
          {
            id: s.id,
            limbId: 0,
            seed: s.seed,
            x: s.toX,
            y: hitY,
            z: s.toY,
            dx,
            dy: 0.04,
            dz,
            vx: dx * 1.45,
            vy: 0.15,
            vz: dz * 1.45,
            amount: s.killed ? 1.05 : 0.72,
          },
          splatterPresets.zombieBlood,
        )

        // Immediate impact spatter & pool directly under the hit/collapsing zombie
        const zx = z ? z.x : s.toX
        const zz = z ? z.y : s.toY
        const zGround = support(zx, zz)
        this.splatter.emit(
          {
            id: s.id,
            limbId: 99,
            seed: (s.seed ^ 0x9e3779b9) >>> 0,
            x: zx,
            y: zGround + 0.18,
            z: zz,
            dx: dx * 0.18,
            dy: -0.98,
            dz: dz * 0.18,
            amount: s.killed ? 0.48 : 0.28,
          },
          {
            ...splatterPresets.zombieBlood,
            impulse: s.killed ? 1.5 : 1.1,
            spread: 0.65,
            decalSize: s.killed ? 4.4 : 3.4,
            pooling: s.killed ? 0.78 : 0.52,
          },
        )

        if (z && s.detachBone) {
          const detached = zombieCrowd.detachAgentLimb(z, s.detachBone, dt, [dx, 0.25, dz])
          const rootPiece = detached[0]
          if (rootPiece) {
            const [rvx, rvy, rvz] = pointVelocity(rootPiece, rootPiece.frame.p)
            const clampVel = (v: number, lim: number) => Math.max(-lim, Math.min(lim, Number.isFinite(v) ? v : 0))
            const impact: SplatterImpact = {
              id: s.id,
              limbId: limbIds[rootPiece.bone],
              seed: (s.seed ^ 0x517cc1b7) >>> 0,
              x: rootPiece.frame.p[0],
              y: Math.min(groundY + 1.25, rootPiece.frame.p[1]),
              z: rootPiece.frame.p[2],
              dx,
              dy: -0.22,
              dz,
              vx: clampVel(rvx, 4.5),
              vy: clampVel(rvy, 2.5) - 0.8,
              vz: clampVel(rvz, 4.5),
              amount: s.killed ? 0.65 : 0.45,
            }
            this.splatter.emit(impact, splatterPresets.zombieBlood)
          }
        }
      }
    }

    return addCount
  }

  /** Emits a close-range dark venous splatter when a shove connects with zombies. */
  emitShoveHit(x: number, z: number, aim: number, groundY: number, hits = 1, seed = 101): void {
    if (!this.levelData || hits <= 0) return
    this.splatter ??= new Splatter(outbreakSplatterSurfaces(this.levelData))
    this.hasEmitted = true
    const dx = Math.cos(aim)
    const dz = Math.sin(aim)
    const id = ++this.syntheticEventId
    this.splatter.emit(
      {
        id,
        seed: (seed ^ id) >>> 0,
        x: x + dx * 0.75,
        y: groundY + 0.88,
        z: z + dz * 0.75,
        dx,
        dy: -0.35,
        dz,
        amount: Math.min(1.2, 0.55 + hits * 0.25),
      },
      splatterPresets.zombieBlood,
    )
  }

  /** Emits brighter oxygenated arterial blood when the survivor takes a hit from a zombie. */
  emitSurvivorHit(x: number, z: number, dirX: number, dirZ: number, groundY: number, damage = 20, seed = 202): void {
    if (!this.levelData) return
    this.splatter ??= new Splatter(outbreakSplatterSurfaces(this.levelData))
    this.hasEmitted = true
    const id = ++this.syntheticEventId
    this.splatter.emit(
      {
        id,
        seed: (seed ^ id) >>> 0,
        x,
        y: groundY + 0.92,
        z,
        dx: dirX,
        dy: -0.32,
        dz: dirZ,
        amount: Math.max(0.6, Math.min(1.4, damage / 22)),
      },
      splatterPresets.survivorBlood,
    )
  }

  private getRecentShots(_ai: OutbreakAISubsystem, _player: SurvivorCombatState): CombatShotEvent[] {
    return []
  }
}
