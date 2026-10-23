import type { FoleyEvent } from "@arcade/kit/client/walk"
import type { Particles, ParticleSpec } from "@arcade/kit/fx/particles"
import type { SceneLight } from "@arcade/kit/gpu/scene-frame"
import type { CameraFeelSettings } from "./camera-feel"

/**
 * Small things in the air near you, into the road flares' particle pool (the one pool the forest draws, lit only by
 * the lights it is given): your breath fogging in front of your face, thicker and quicker after running, and dry
 * leaves kicked up by your boots when you run on the forest floor. Your torch is handed to that pool as a light, so
 * both only show where its beam catches them, as in the woods on a cold night.
 */
const BREATH: ParticleSpec = { kind: "smoke", life: 1.2, size: 0.022, growth: 0.09, gravity: -0.04, drag: 2.2, bounce: 0, r: 0.62, g: 0.63, b: 0.65, alpha: 0.03, turbulence: 1, ease: 1.2 }
/** Cos of the beam's half-angle for the particles (about 20°, the torch's spill). */
const TORCH_CONE = Math.cos((20 * Math.PI) / 180)
const LEAF: ParticleSpec = { kind: "debris", life: 1.1, size: 0.018, growth: 0, gravity: 9.81, drag: 1.8, bounce: 0.15, r: 0.16, g: 0.1, b: 0.05, alpha: 1 }

/** 1 within about 30° of the torch's axis, easing to 0 by 60° off it. */
function beamShare(t: { pos: readonly number[]; dir: readonly number[] }, x: number, y: number, z: number): number {
  const dx = x - t.pos[0]!, dy = y - t.pos[1]!, dz = z - t.pos[2]!
  const c = (dx * t.dir[0]! + dy * t.dir[1]! + dz * t.dir[2]!) / Math.max(1e-6, Math.hypot(dx, dy, dz))
  const k = Math.max(0, Math.min(1, (c - 0.5) / (0.866 - 0.5)))
  return k * k * (3 - 2 * k)
}

export type JuiceFrame = {
  dt: number
  pool: Particles
  eye: readonly number[]
  yaw: number
  /** Plan velocity (m/s). */
  vx: number
  vz: number
  walkSpeed: number
  /** Ground height under you (m). */
  ground: number
  /** This frame's step contacts and whether the ground under you is leaf litter. */
  steps: readonly FoleyEvent[]
  litter: boolean
  /** The road flares' particle lights this frame (flare view's own list: read, never changed). */
  flareLights: readonly SceneLight[]
  /** Your torch: its lens, axis and level, or null when it is off. */
  torch: { pos: readonly number[]; dir: readonly number[]; level: number } | null
  settings: CameraFeelSettings
  playing: boolean
}

export class Juice {
  /** 0 rested … 1 winded: how hard you are breathing (rises while running, falls over ~20 s). */
  winded = 0
  private nextBreath = 1.2
  private exhale = 0
  private carry = 0
  private seed = 1
  private readonly cone: [number, number, number] = [0, 0, 1]
  private readonly light: SceneLight = { x: 0, y: 0, h: 0, r: 6, color: [1, 0.93, 0.82], power: 0, size: 0.03 }
  private readonly spill: SceneLight = { x: 0, y: 0, h: 0, r: 1.2, color: [1, 0.93, 0.82], power: 0, size: 0.03 }
  private readonly pair: readonly SceneLight[] = [this.light, this.spill]
  /** This frame's particle lights: your torch (when on) then the flares'. Ours, refilled every frame. */
  private readonly lights: SceneLight[] = []

  /**
   * Spawns this frame's breath and leaves and returns every light for the particle pool: your torch first (so the
   * renderer's eight-light cap never drops it) then the flares'.
   */
  frame(f: JuiceFrame): readonly SceneLight[] {
    this.lights.length = 0
    this.spawn(f)
    if (f.torch) this.lights.push(...this.torchLights(f.torch))
    for (const l of f.flareLights) this.lights.push(l)
    return this.lights
  }

  private spawn(f: JuiceFrame): void {
    const dt = Math.max(0, Math.min(f.dt, 0.05)), s = f.settings
    const speed = Math.hypot(f.vx, f.vz)
    const running = speed > f.walkSpeed * 1.2
    this.winded += running ? dt / 12 * (1 - this.winded) : -dt / 20 * this.winded
    const sy = Math.sin(f.yaw), cy = Math.cos(f.yaw), fx = -sy, fz = -cy
    if (f.playing && s.breath > 0) {
      this.nextBreath -= dt
      if (this.nextBreath <= 0) {
        // 4 s between breaths at rest, about 1.6 s winded; each a little different.
        this.nextBreath = (4 - 2.4 * this.winded) * (0.85 + 0.3 * this.rand())
        this.exhale = 0.7 + 0.4 * this.winded
      }
      if (this.exhale > 0) {
        this.exhale -= dt
        this.carry += dt * 10 * s.breath * (0.6 + 0.8 * this.winded)
        // Only breath the beam passes through shows: fade it by how far the puff (most of a metre out, where it drifts into the beam) sits off the axis.
        const inBeam = f.torch ? beamShare(f.torch, f.eye[0]! + fx * 0.8, f.eye[1]! - 0.05, f.eye[2]! + fz * 0.8) : 0
        BREATH.alpha = Math.min(0.06, 0.022 * Math.sqrt(s.breath) * (1 + 0.5 * this.winded)) * inBeam
        if (inBeam < 0.05) this.carry = 0
        for (; this.carry >= 1; this.carry--) {
          const out = 1 + 0.6 * this.rand(), up = 0.05 + 0.1 * this.rand(), across = (this.rand() - 0.5) * 0.18
          f.pool.spawn(BREATH, f.eye[0]! + fx * 0.12, f.eye[1]! - 0.1, f.eye[2]! + fz * 0.12, f.vx + fx * out + cy * across, up, f.vz + fz * out - sy * across, this.seed++)
        }
      }
    }
    // Running on litter, each boot throws up a few dead leaves just ahead of it.
    if (f.playing && running && f.litter && s.kick > 0) {
      for (const e of f.steps) {
        if (e.kind !== "step") continue
        const n = Math.round((2 + 3 * this.rand()) * Math.min(2, s.kick))
        for (let i = 0; i < n; i++) {
          const side = e.pan * 1.3 + (this.rand() - 0.5) * 0.15, ahead = 0.25 + 0.2 * this.rand()
          const x = f.eye[0]! + fx * ahead + cy * side, z = f.eye[2]! + fz * ahead - sy * side
          const kick = 0.6 + 0.8 * this.rand()
          f.pool.spawn(LEAF, x, f.ground + 0.04, z, f.vx * 0.6 + fx * kick * 0.6 + (this.rand() - 0.5) * 0.6, 0.9 + 1.2 * this.rand(), f.vz * 0.6 + fz * kick * 0.6 + (this.rand() - 0.5) * 0.6, this.seed++)
        }
      }
    }
  }

  private torchLights(t: { pos: readonly number[]; dir: readonly number[]; level: number }): readonly SceneLight[] {
    // The torch as lights for the particles alone: the beam as a plan cone from just behind its lens (aimed
    // near-vertical a plan cone means nothing, so then a short point), and the lens's weak spill on what's at arm's length.
    const L = this.light
    L.x = t.pos[0]! - t.dir[0]! * 0.1; L.h = t.pos[1]! - t.dir[1]! * 0.1; L.y = t.pos[2]! - t.dir[2]! * 0.1
    const plan = Math.hypot(t.dir[0]!, t.dir[2]!)
    this.cone[0] = plan > 0.2 ? t.dir[0]! / plan : 0
    this.cone[1] = plan > 0.2 ? t.dir[2]! / plan : 0
    this.cone[2] = TORCH_CONE
    L.cone = plan > 0.2 ? this.cone : undefined
    L.r = plan > 0.2 ? 6 : 2
    L.power = 0.7 * t.level
    const S = this.spill
    S.x = t.pos[0]!; S.h = t.pos[1]!; S.y = t.pos[2]!
    S.power = 0.3 * t.level
    return this.pair
  }

  private rand(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0
    return this.seed / 4294967296
  }
}
