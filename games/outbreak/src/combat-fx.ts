import { Splatter, splatterPresets, type SplatterImpact } from "@arcade/kit/fx/splatter"
import { SplatterSurfaces, type SplatterMaterial } from "@arcade/kit/fx/splatter-surfaces"
import type { LevelData } from "@arcade/kit/gpu/level"
import { MAT, Mesh } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, SPRITE_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import { attachment, limbIds, pointVelocity, type BonePose } from "@arcade/kit/human-pose"
import type { V3 } from "@arcade/kit/rig"
import type { OutbreakAISubsystem } from "../shared/ai"
import {
  findFinisherTarget,
  MELEE_WEAPONS,
  type CombatMeleeEvent,
  type CombatMeleeHit,
  type CombatShotEvent,
  type MeleeWeaponId,
  type SurvivorCombatState,
} from "../shared/combat"
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
      const p = new DataView(chunk.data, 0, chunk.byteLength ?? chunk.data.byteLength)
      for (let i = 0; i < p.byteLength; i += 72) {
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

export type BrokenWeaponPiece = {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  yaw: number
  pitch: number
  roll: number
  vyaw: number
  vpitch: number
  vroll: number
  r: number
  g: number
  b: number
  bornAt: number
  settled: boolean
}

const WEAPON_BREAK_PALETTES: Record<MeleeWeaponId, readonly (readonly [number, number, number])[]> = {
  crowbar: [hex(0xb5322a), hex(0x8c96a0), hex(0x6e7780), hex(0x942a24)],
  pipe: [hex(0x697279), hex(0x4e565d), hex(0x869098), hex(0x36393c)],
  hammer: [hex(0x4a5158), hex(0x9a6e42), hex(0x6e7780), hex(0x75522f)],
  knife: [hex(0xd8dfe4), hex(0x9aa2a8), hex(0x28231e), hex(0x7c8286)],
  machete: [hex(0xd8e0e6), hex(0xc2cbd2), hex(0x3a2a1d), hex(0x8c969e)],
  bat: [hex(0xc69862), hex(0xb88b58), hex(0x7a5634), hex(0x282a2c)],
  "spiked-board": [hex(0x8e6b44), hex(0x6b4f30), hex(0x9ca6ae), hex(0x524c44)],
  axe: [hex(0xc8d2da), hex(0x966a3e), hex(0x3a4046), hex(0x73502d)],
  "fire-axe": [hex(0x9e2420), hex(0xd8e2ea), hex(0xa87c4f), hex(0x761b18)],
}

export class OutbreakCombatFX {
  private readonly pistolModel: number
  private readonly shardModel: number
  private readonly pistolData = new Float32Array(INST_FLOATS)
  private readonly shardData = new Float32Array(32 * INST_FLOATS)
  private readonly seenShots = new Set<number>()
  private readonly seenMeleeSwings = new Set<number>()
  private readonly seenMeleeHits = new Set<string>()
  private readonly seenMeleeBreaks = new Set<number>()
  readonly brokenPieces: BrokenWeaponPiece[] = []
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

    const shard = new Mesh()
    shard.box(-0.14, -0.022, -0.02, 0.14, 0.022, 0.02, [1, 1, 1], MAT.shiny)
    shard.box(0.06, -0.014, -0.028, 0.19, 0.032, 0.016, [0.82, 0.84, 0.86], MAT.actor)
    this.shardModel = renderer.addModel(shard)
  }

  setLevel(level: LevelData): void {
    this.levelData = level
    this.splatter = null
    this.hasEmitted = false
  }

  reset(): void {
    this.seenShots.clear()
    this.seenMeleeSwings.clear()
    this.seenMeleeHits.clear()
    this.seenMeleeBreaks.clear()
    this.brokenPieces.length = 0
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

    // 1. Fallback pistol if caller did not draw a posed gun frame through Survivor.draw
    const posedGun = (survivorBones as BonePose & { gun?: unknown }).gun
    if (player.equippedItem === "pistol" && !posedGun) {
      const hand = attachment(survivorBones, "right.hand")
      const px = hand ? hand.p[0] : player.x + Math.cos(player.aim) * 0.32
      const py = hand ? hand.p[1] + 0.04 : support(player.x, player.y) + 1.18
      const pz = hand ? hand.p[2] : player.y + Math.sin(player.aim) * 0.32
      const recoilPitch = player.recoil * 0.38 - (player.reloadRemaining > 0 ? 0.55 : 0)
      this.pistolData.set([px, py, pz, player.aim, 1, 1, 1, 1, recoilPitch, 0, 1, 0])
      batches.push({ model: this.pistolModel, data: this.pistolData, count: 1 })
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

    // 4. Step & draw broken melee weapon pieces lying or bouncing on the ground
    let shardCount = 0
    for (let i = this.brokenPieces.length - 1; i >= 0; i--) {
      const p = this.brokenPieces[i]!
      const age = time - p.bornAt
      if (age > 18) {
        this.brokenPieces.splice(i, 1)
        continue
      }
      if (!p.settled && dt > 0) {
        p.x += p.vx * dt
        p.y += p.vy * dt
        p.z += p.vz * dt
        p.vy -= 14.0 * dt
        p.yaw += p.vyaw * dt
        p.pitch += p.vpitch * dt
        p.roll += p.vroll * dt
        const floorY = support(p.x, p.z) + 0.025
        if (p.y <= floorY) {
          p.y = floorY
          if (Math.abs(p.vy) > 0.85) {
            p.vy = -p.vy * 0.28
            p.vx *= 0.48
            p.vz *= 0.48
            p.vpitch *= 0.4
            p.vroll *= 0.4
          } else {
            p.vy = p.vx = p.vz = 0
            p.pitch = 0.04
            p.roll = 0.22
            p.settled = true
          }
        }
      }
      if (shardCount < 32) {
        const alpha = age > 15 ? Math.max(0, 1 - (age - 15) / 3) : 1
        this.shardData.set(
          [p.x, p.y, p.z, p.yaw, p.r, p.g, p.b, 1, p.pitch, p.roll, alpha, 0],
          shardCount++ * INST_FLOATS,
        )
      }
    }
    if (shardCount > 0) {
      batches.push({ model: this.shardModel, data: this.shardData, count: shardCount })
    }

    // 5. Subtle diegetic ground pulse under a downed zombie in finisher range
    const finTarget = findFinisherTarget(player, ai.agents)
    if (finTarget) {
      const gy = support(finTarget.x, finTarget.y) + 0.04
      const pulse = 0.42 + 0.04 * Math.sin(time * 5.2)
      pushAdd(finTarget.x, gy, finTarget.y, pulse, 0.72, 0.14, 0.1, 0.22, 2, 0, 0.08, 0)
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
      if (!s.confirmedLocal && age >= 0 && age <= 0.09) {
        const u = 1 - age / 0.09
        const mx = (s.fromX + s.toX) * 0.5
        const mz = (s.fromY + s.toY) * 0.5
        const my = support(mx, mz) + 1.35
        const len = Math.hypot(s.toX - s.fromX, s.toY - s.fromY)
        if (len > 0.3) {
          pushAdd(mx, my, mz, len * 0.5, 1.0, 0.84, 0.45, u * 0.85, 4, s.aim, 0.025 / Math.max(0.5, len * 0.5), 0)
        }
        if (s.tentativeHit) {
          const hy = support(s.toX, s.toY) + 1.12
          pushAdd(s.toX, hy, s.toY, 0.22 * u, 1.0, 0.86, 0.52, u * 0.65, 0, 0, 1, 0)
        }
      }

      if (this.seenShots.has(s.id)) continue
      this.seenShots.add(s.id)
      onNewShot?.(s)
      if (!s.confirmedLocal) {
        const fy = support(s.fromX, s.fromY) + 1.36
        this.lastFlash = { x: s.fromX, y: fy, z: s.fromY, until: time + 0.08 }
      }

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

  /**
   * Processes authoritative melee swing and hit events:
   * - Emits swing arc slash sprites (`pushAdd`) during the active window.
   * - Emits weapon-specific blood splatter (arterial slash fan for blades, concussive radial burst for blunt,
   *   puncture pool for spiked board) and detaches limbs (`head`, arms) on heavy/sharp hits.
   */
  processMeleeSwings(
    meleeSwings: readonly CombatMeleeEvent[],
    time: number,
    dt: number,
    ai: OutbreakAISubsystem,
    zombieCrowd: ZombieCrowdRenderer,
    support: (x: number, z: number) => number,
    addSprites: Float32Array,
    startAddCount: number,
    onNewSwing?: (swing: CombatMeleeEvent) => void,
    onNewHit?: (swing: CombatMeleeEvent, hit: CombatMeleeHit) => void,
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

    for (const m of meleeSwings) {
      const def = MELEE_WEAPONS[m.weapon] ?? MELEE_WEAPONS.crowbar
      const age = time - m.time
      if (!m.confirmedLocal && age >= 0 && age <= 0.14) {
        const u = Math.min(1, age / 0.14)
        const fade = Math.sin(u * Math.PI)
        const sweepDir = m.combo === 2 ? 1 : -1
        const ang = m.aim - sweepDir * m.arc * 0.42 + sweepDir * m.arc * 0.84 * u
        const rDist = Math.max(0.65, m.reach * 0.62)
        const sx = m.x + Math.cos(ang) * rDist
        const sz = m.y + Math.sin(ang) * rDist
        const sy = support(sx, sz) + 1.16
        const [cr, cg, cb] =
          def.material === "blade"
            ? [0.82, 0.92, 1.0]
            : def.material === "wood"
              ? [0.95, 0.76, 0.48]
              : [0.76, 0.82, 0.9]
        const boost = m.heavy ? 1.35 : m.combo === 3 ? 1.2 : 1.0
        pushAdd(
          sx,
          sy,
          sz,
          0.42 * boost,
          cr,
          cg,
          cb,
          fade * 0.62 * boost,
          4,
          ang + Math.PI * 0.5,
          0.16,
          0,
        )
      }

      if (!this.seenMeleeSwings.has(m.id)) {
        this.seenMeleeSwings.add(m.id)
        onNewSwing?.(m)
      }

      if (m.weaponBroke && !this.seenMeleeBreaks.has(m.id)) {
        this.seenMeleeBreaks.add(m.id)
        const hit0 = m.hits[0]
        const bx = hit0 ? hit0.x : m.x + Math.cos(m.aim) * 0.68
        const bz = hit0 ? hit0.y : m.y + Math.sin(m.aim) * 0.68
        const by = support(bx, bz) + 1.04
        const palette = WEAPON_BREAK_PALETTES[m.weapon] ?? WEAPON_BREAK_PALETTES.crowbar
        pushAdd(bx, by, bz, 0.44, 0.96, 0.78, 0.42, 0.9, 0, 0, 1, 0)
        for (let k = 0; k < 5; k++) {
          const h = ((m.seed ^ Math.imul(k + 1, 0x85ebca6b)) >>> 0) / 0xffffffff
          const h2 = ((m.seed ^ Math.imul(k + 7, 0xc2b2ae35)) >>> 0) / 0xffffffff
          const ang = m.aim + (k - 2) * 0.52 + (h - 0.5) * 0.35
          const spd = 1.6 + h2 * 2.1
          const col = palette[k % palette.length]!
          if (this.brokenPieces.length >= 32) this.brokenPieces.shift()
          this.brokenPieces.push({
            x: bx + Math.cos(ang) * 0.08,
            y: by + (k % 2) * 0.06,
            z: bz + Math.sin(ang) * 0.08,
            vx: Math.cos(ang) * spd,
            vy: 1.8 + h * 1.9,
            vz: Math.sin(ang) * spd,
            yaw: ang,
            pitch: (h - 0.5) * 1.2,
            roll: (h2 - 0.5) * 1.2,
            vyaw: (h - 0.5) * 9,
            vpitch: (h2 - 0.5) * 11,
            vroll: (h - h2) * 10,
            r: col[0],
            g: col[1],
            b: col[2],
            bornAt: time,
            settled: false,
          })
        }
      }

      for (const h of m.hits) {
        if (age >= 0 && age <= 0.16) {
          const uHit = 1 - age / 0.16
          const hy = support(h.x, h.y) + (h.finisher ? 0.36 : h.headshot ? 1.32 : 1.04)
          pushAdd(h.x, hy, h.y, (h.finisher ? 0.48 : 0.34) * (1.2 - 0.4 * uHit), 0.72, 0.06, 0.08, uHit * 0.85, 0, 0, 1, 0)
          if (h.finisher || h.knockdown || h.crawler) {
            pushAdd(h.x, support(h.x, h.y) + 0.08, h.y, 0.42 + (1 - uHit) * 0.45, 0.65, 0.04, 0.06, uHit * 0.78, 2, 0, 0.1, 0)
          }
        }
        const hitKey = `${m.id}:${h.zombieId}`
        if (this.seenMeleeHits.has(hitKey)) continue
        this.seenMeleeHits.add(hitKey)
        onNewHit?.(m, h)

        if (!this.levelData) continue
        this.splatter ??= new Splatter(outbreakSplatterSurfaces(this.levelData))
        this.hasEmitted = true
        const z = ai.agents.find((a) => a.id === h.zombieId)
        const groundY = support(h.x, h.y)
        const hitY = groundY + (h.finisher ? 0.34 : h.crawler ? 0.52 : h.headshot || h.detachBone === "head" ? 1.34 : 1.05)

        // Direction of blood spray: blades fan along the slash tangent + forward; blunt blasts radially away
        const sweepSign = m.combo === 2 ? 1 : -1
        const slashAngle =
          def.material === "blade"
            ? m.aim + sweepSign * 0.48
            : m.aim + sweepSign * 0.18
        const dx = Math.cos(slashAngle)
        const dz = Math.sin(slashAngle)

        const basePreset = this.legacyMode ? LEGACY_BLOOD_PRESET : splatterPresets.zombieBlood
        const weaponPreset =
          def.material === "blade"
            ? {
                ...basePreset,
                impulse: (m.heavy ? 6.8 : 5.6) * (h.headshot ? 1.2 : 1),
                spread: 0.42,
                sizeMin: 0.02,
                sizeMax: 0.11,
                decalSize: h.killed ? 4.4 : 3.5,
                pooling: h.killed ? 0.82 : 0.55,
              }
            : m.weapon === "spiked-board"
              ? {
                  ...basePreset,
                  impulse: m.heavy ? 5.8 : 4.8,
                  spread: 0.68,
                  sizeMin: 0.03,
                  sizeMax: 0.13,
                  decalSize: h.killed ? 4.6 : 3.8,
                  pooling: h.killed ? 0.85 : 0.65,
                }
              : {
                  // Blunt (bat, crowbar, pipe, hammer): concussive wide burst + dark pool
                  ...basePreset,
                  impulse: m.heavy ? 5.2 : 4.2,
                  spread: 0.82,
                  sizeMin: 0.028,
                  sizeMax: 0.135,
                  decalSize: h.killed ? 4.2 : 3.3,
                  pooling: h.killed ? 0.72 : 0.48,
                }

        const amountScale =
          (h.killed ? 1.15 : 0.75) *
          (h.finisher ? 1.45 : m.heavy ? 1.3 : m.combo === 3 ? 1.15 : 1.0) *
          (h.headshot ? 1.2 : 1.0) *
          (h.crawler || h.knockdown ? 1.25 : 1.0) *
          (def.material === "blade" ? 1.18 : 1.0)

        this.splatter.emit(
          {
            id: m.id * 16 + (h.zombieId & 15),
            limbId: 0,
            seed: h.seed,
            x: h.x,
            y: hitY,
            z: h.y,
            dx,
            dy: def.material === "blade" ? 0.08 : -0.06,
            dz,
            vx: dx * (m.heavy ? 1.8 : 1.3),
            vy: 0.18,
            vz: dz * (m.heavy ? 1.8 : 1.3),
            amount: amountScale,
          },
          weaponPreset,
        )

        // Immediate pool directly under the struck zombie
        this.splatter.emit(
          {
            id: m.id * 16 + (h.zombieId & 15),
            limbId: 99,
            seed: (h.seed ^ 0x9e3779b9) >>> 0,
            x: h.x,
            y: groundY + 0.18,
            z: h.y,
            dx: dx * 0.22,
            dy: -0.96,
            dz: dz * 0.22,
            amount: (h.killed ? 0.52 : 0.3) * (m.heavy ? 1.25 : 1.0),
          },
          weaponPreset,
        )

        if (z && h.detachBone) {
          const detached = zombieCrowd.detachAgentLimb(z, h.detachBone as never, dt, [
            dx * (m.heavy ? 1.35 : 1.0),
            0.32,
            dz * (m.heavy ? 1.35 : 1.0),
          ])
          const rootPiece = detached[0]
          if (rootPiece) {
            const [rvx, rvy, rvz] = pointVelocity(rootPiece, rootPiece.frame.p)
            const clampVel = (v: number, lim: number) => Math.max(-lim, Math.min(lim, Number.isFinite(v) ? v : 0))
            this.splatter.emit(
              {
                id: m.id * 16 + (h.zombieId & 15),
                limbId: limbIds[rootPiece.bone],
                seed: (h.seed ^ 0x517cc1b7) >>> 0,
                x: rootPiece.frame.p[0],
                y: Math.min(groundY + 1.3, rootPiece.frame.p[1]),
                z: rootPiece.frame.p[2],
                dx,
                dy: -0.18,
                dz,
                vx: clampVel(rvx, 4.8),
                vy: clampVel(rvy, 2.8) - 0.6,
                vz: clampVel(rvz, 4.8),
                amount: h.killed ? 0.78 : 0.55,
              },
              weaponPreset,
            )
          }
        }
      }
    }

    if (this.seenMeleeSwings.size > 256) {
      this.seenMeleeSwings.clear()
      for (const m of meleeSwings) this.seenMeleeSwings.add(m.id)
    }
    if (this.seenMeleeHits.size > 512) {
      this.seenMeleeHits.clear()
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
