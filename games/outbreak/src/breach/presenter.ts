import { attenuateShake, type Camera } from "@arcade/kit/client/camera"
import type { ParticleSpec } from "@arcade/kit/fx/particles"
import type { Mesh } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import { LIGHT_FLOATS } from "@arcade/kit/limits"
import type { Rect } from "@arcade/kit/sim/geom"
import { samplePointLightLevel, type PortalState } from "../../shared/ai"
import {
  breachOn,
  DOOR_STAGE_NAMES,
  doorStage,
  GIVING_BOARDS,
  inwardSign,
  isBracing,
  isHorizontal,
  KIND_BOARDS,
  KIND_BURST,
  KIND_CRUSH,
  KIND_HINGES,
  KIND_SPLIT,
  BREACH_KIND_NAMES,
  type BreachState,
  type PortalWear,
} from "../../shared/breach/rules"
import type { Door, Town, WindowOpening } from "../../shared/map"
import { supportHeight } from "../../shared/terrain"
import { playAmbientSound, holdAmbientSound } from "../audio/soundscape/hooks"
import { currentFx } from "../scene/fx-particles"
import { DOOR_WIDTH, doorLeafMesh } from "../world/door-leaf"
import { armMesh, chunkMesh, cracksMesh, footShadowMesh, glassMesh, HOLE_AT, holeMesh, jambMesh, plankMesh, splinterMesh } from "./models"
import type { OutbreakBreachSettings } from "./settings"

/** What the presenter needs from a session (offline or co-op: both carry a `CoopSim`). */
export type BreachSessionView = {
  readonly sim: { readonly time: number; readonly hour: number; readonly town: Town; getFeatureState<T>(id: string): T | undefined }
  readonly ai: { readonly portalStates: ReadonlyMap<string, PortalState> }
  readonly view: { readonly player: { x: number; y: number; health: number; vehicleId?: number | null } }
}

export type BreachFrame = {
  readonly session: BreachSessionView
  readonly settings: OutbreakBreachSettings
  readonly cam: Camera | null
  readonly dt: number
}

/** How far from the listener doors are animated and drawn by us (m). */
const RANGE = 36
const MAX_DOORS = 48
const MAX_DEBRIS = 220
/** Seconds a hinged door takes to fall flat; a crushed one is flung faster. */
const FALL_T = 0.42
const CRUSH_FALL_T = 0.3

type DoorAnim = {
  x: number
  vx: number
  ajar: number
  va: number
  lastBash: number
  lastStage: number
  lastGivingAt: number
  lastBreachAt: number
  slammed: boolean
  light: number
  nextGroan: number
  fresh: boolean
}

type Piece = {
  model: number
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  yaw: number
  pitch: number
  roll: number
  wy: number
  wp: number
  wr: number
  born: number
  rest: boolean
  half: number
}

/** Seeded per event so every client throws the same pieces the same way. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function strHash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

const easeIn = (u: number) => u * u

/** Door frame: hinge origin, base yaw, inward normal, and the inward sign along the leaf's local z. */
function frameOf(town: Town, rect: Rect, wear: PortalWear | undefined) {
  const horizontal = isHorizontal(rect)
  const inward = wear?.outside ? -wear.outside : inwardSign(town, rect)
  const cx = (rect[0] + rect[2]) * 0.5
  const cz = (rect[1] + rect[3]) * 0.5
  return {
    horizontal,
    inward,
    cx,
    cz,
    hx: horizontal ? rect[0] : cx,
    hz: horizontal ? cz : rect[1],
    yaw: horizontal ? 0 : Math.PI / 2,
    nx: horizontal ? 0 : inward,
    nz: horizontal ? inward : 0,
    ux: horizontal ? 1 : 0,
    uz: horizontal ? 0 : 1,
    zs: horizontal ? inward : -inward,
  }
}

/** Leaf-local point (x along the leaf, y up, z through it) to world, for a leaf at (px, pz) with yaw. */
function leafToWorld(px: number, pz: number, yaw: number, lx: number, lz: number): [number, number] {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  return [px + lx * c - lz * s, pz + lx * s + lz * c]
}

const DUST: ParticleSpec = { kind: "smoke", life: 1.6, size: 0.22, growth: 0.32, gravity: -0.04, drag: 2.4, bounce: 0, r: 0.5, g: 0.46, b: 0.4, alpha: 0.45 }
const SPLINTER_FX: ParticleSpec = { kind: "debris", life: 0.9, size: 0.035, growth: 0, gravity: 9.8, drag: 0.6, bounce: 0.25, r: 0.62, g: 0.46, b: 0.3, alpha: 1 }

/**
 * Damaged doors and breaches, drawn and heard (AR-97). Reads the replicated wear (`shared/breach`), the AI's portal
 * states and bash times, so a co-op client and a late joiner see what the room has:
 *
 * - every hit jolts the door in its frame and pushes it ajar against the latch, rattles the handle, puffs dust and
 *   splinters, and stacks extra, deeper thuds for each extra pair of fists;
 * - cracks spread and a panel splits by stage, the hinges and the lock plate bend, arms reach through a punched
 *   panel, the door bulges and groans through the warning beat;
 * - light from the dead's side (when lit) shows through the growing gaps, with their feet's shadows under the door;
 * - breaches by kind: off the hinges and slammed flat, split down the middle, flung by a crush with the frame in
 *   pieces, boards flying in, a window bursting glass. Pieces are seeded by the breach, settle, and sink away later.
 */
export class BreachPresenter {
  private readonly anims = new Map<string, DoorAnim>()
  private readonly winBash = new Map<string, number>()
  private readonly winBreach = new Map<string, number>()
  private readonly pieces: Piece[] = []
  private readonly drawn = new Set<string>()
  private readonly models: number[] = []
  private readonly data: Float32Array<ArrayBuffer>[] = []
  private readonly counts: number[] = []
  private readonly batchList: Batch[] = []
  private readonly lightData = new Float32Array(8 * LIGHT_FLOATS)
  private lightCount = 0
  private time = 0
  private lastSimTime = -1
  /** Proof readout. */
  readonly stats = { doors: 0, debris: 0, lights: 0, stages: {} as Record<string, string>, breaches: [] as string[] }

  constructor(renderer: Pick<Renderer, "addModel">) {
    const meshes: [Mesh, number][] = [
      [doorLeafMesh(), MAX_DOORS],
      [doorLeafMesh(0, 0.71), MAX_DOORS],
      [doorLeafMesh(0.69, DOOR_WIDTH), MAX_DOORS],
      [cracksMesh(1), MAX_DOORS],
      [cracksMesh(2), MAX_DOORS],
      [cracksMesh(3), MAX_DOORS],
      [holeMesh(), MAX_DOORS],
      [armMesh(), MAX_DOORS * 2],
      [footShadowMesh(), MAX_DOORS * 4],
      [splinterMesh(), MAX_DEBRIS],
      [chunkMesh(), MAX_DEBRIS],
      [jambMesh(), MAX_DEBRIS],
      [plankMesh(), MAX_DEBRIS],
      [glassMesh(), MAX_DEBRIS],
    ]
    for (const [mesh, cap] of meshes) {
      this.models.push(renderer.addModel(mesh))
      this.data.push(new Float32Array(cap * INST_FLOATS))
      this.counts.push(0)
    }
  }

  /** Whether the plain door leaf should skip `door` (we draw it). */
  readonly drawsDoor = (door: Door): boolean => this.drawn.has(door.id)

  reset(): void {
    this.anims.clear()
    this.winBash.clear()
    this.winBreach.clear()
    this.pieces.length = 0
    this.drawn.clear()
    this.lastSimTime = -1
  }

  private put(m: number, x: number, y: number, z: number, yaw: number, pitch = 0, roll = 0, alpha = 1): void {
    const data = this.data[m]!
    const i = this.counts[m]!
    if ((i + 1) * INST_FLOATS > data.length) return
    const o = i * INST_FLOATS
    data[o] = x
    data[o + 1] = y
    data[o + 2] = z
    data[o + 3] = yaw
    data[o + 4] = 1
    data[o + 5] = 1
    data[o + 6] = 1
    data[o + 7] = 1
    data[o + 8] = pitch
    data[o + 9] = roll
    data[o + 10] = alpha
    data[o + 11] = 0
    this.counts[m] = i + 1
  }

  private throwPiece(model: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, r: () => number, half = 0.04): void {
    if (this.pieces.length >= MAX_DEBRIS * 2) {
      const i = this.pieces.findIndex((p) => p.rest)
      this.pieces.splice(i >= 0 ? i : 0, 1)
    }
    this.pieces.push({
      model,
      x,
      y,
      z,
      vx,
      vy,
      vz,
      yaw: r() * 6.283,
      pitch: (r() - 0.5) * 2,
      roll: (r() - 0.5) * 2,
      wy: (r() - 0.5) * 14,
      wp: (r() - 0.5) * 16,
      wr: (r() - 0.5) * 12,
      born: this.time,
      rest: false,
      half,
    })
  }

  private dust(x: number, y: number, z: number, n: number, spread: number, s: OutbreakBreachSettings, r: () => number, up = 0.25): void {
    const fx = currentFx()
    const count = Math.round(n * s.breachDust)
    if (!fx || count <= 0) return
    for (let i = 0; i < count; i++) {
      DUST.size = 0.16 + r() * 0.18
      DUST.life = 1.1 + r() * 1.0
      fx.particles.spawn(DUST, x + (r() - 0.5) * spread, y + (r() - 0.5) * 0.3, z + (r() - 0.5) * spread, (r() - 0.5) * 0.6, up * r(), (r() - 0.5) * 0.6, r() * 6.283)
    }
  }

  private sparks(x: number, y: number, z: number, nx: number, nz: number, n: number, s: OutbreakBreachSettings, r: () => number): void {
    const fx = currentFx()
    const count = Math.round(n * s.breachDebris)
    if (!fx || count <= 0) return
    for (let i = 0; i < count; i++) {
      const sp = 1.4 + r() * 2.2
      fx.particles.spawn(SPLINTER_FX, x, y, z, nx * sp + (r() - 0.5) * 1.6, 0.8 + r() * 1.8, nz * sp + (r() - 0.5) * 1.6, r() * 6.283)
    }
  }

  private sound(id: string, x: number, z: number, s: OutbreakBreachSettings, gain = 1, rate = 1, delay = 0): void {
    if (s.breachAudio <= 0) return
    playAmbientSound(id, x, z, { gain: gain * s.breachAudio, rate, delay })
  }

  /** Steps the doors, their sounds and the thrown pieces; call once a frame before `batches`/`lights`. */
  update(f: BreachFrame): void {
    const s = f.settings
    this.drawn.clear()
    this.lightCount = 0
    for (let m = 0; m < this.counts.length; m++) this.counts[m] = 0
    this.stats.doors = 0
    this.stats.stages = {}
    if (!breachOn(s)) {
      this.pieces.length = 0
      this.stats.debris = 0
      return
    }
    const dt = Math.max(0, Math.min(0.1, f.dt))
    this.time += dt
    const sim = f.session.sim
    const town = sim.town
    const state = sim.getFeatureState<BreachState>("breach")
    const now = sim.time
    // A rewound or restaged session: forget the old edges without replaying their effects.
    if (now + 0.5 < this.lastSimTime) this.reset()
    this.lastSimTime = now
    const me = f.session.view.player
    const support = (x: number, z: number) => supportHeight(town, x, z)

    for (const door of town.doors) {
      const [x0, y0, x1, y1] = door.rect
      if (Math.abs((x0 + x1) * 0.5 - me.x) > RANGE || Math.abs((y0 + y1) * 0.5 - me.y) > RANGE) continue
      this.door(door, state?.portals[door.id], f.session.ai.portalStates.get(door.id), f, now, dt, support)
    }
    for (const win of town.windows) {
      const [x0, y0, x1, y1] = win.rect
      if (Math.abs((x0 + x1) * 0.5 - me.x) > RANGE || Math.abs((y0 + y1) * 0.5 - me.y) > RANGE) continue
      this.window(win, state?.portals[win.id], f.session.ai.portalStates.get(win.id), f, now, support)
    }
    this.stepPieces(dt, s, support)
  }

  private door(door: Door, w: PortalWear | undefined, st: PortalState | undefined, f: BreachFrame, now: number, dt: number, support: (x: number, z: number) => number): void {
    const s = f.settings
    const town = f.session.sim.town
    let a = this.anims.get(door.id)
    if (!w && !a && (st?.integrity ?? 100) >= 100) return
    if (!a) {
      a = { x: 0, vx: 0, ajar: 0, va: 0, lastBash: st?.lastBashTime ?? -Infinity, lastStage: -1, lastGivingAt: w?.givingAt ?? -1, lastBreachAt: w?.breachAt ?? -1, slammed: (w?.breachAt ?? -1) >= 0 && now - (w?.breachAt ?? 0) > 1, light: 0, nextGroan: 0, fresh: true }
      this.anims.set(door.id, a)
    }
    const fr = frameOf(town, door.rect, w)
    const integrity = st?.integrity ?? 100
    const stage = doorStage(integrity, w)
    const planks = st?.barricadePlanks ?? 0
    const shut = !door.open && !w?.broken
    const me = f.session.view.player
    const dist = Math.hypot(fr.cx - me.x, fr.cz - me.y)
    const r = rng(strHash(door.id) ^ Math.round(now * 60))
    const ground = support(fr.cx, fr.cz)
    const hitX = fr.cx + fr.nx * 0.14
    const hitZ = fr.cz + fr.nz * 0.14

    // A new hit.
    const bash = st?.lastBashTime ?? -Infinity
    if (bash > a.lastBash + 1e-3) {
      if (!a.fresh && now - bash < 0.4 && shut) {
        const braced = Math.min(2, w?.braced ?? 0)
        const k = s.breachJolt * (1 - 0.32 * braced) * (planks > 0 ? 0.45 : 1) * (0.8 + 0.1 * Math.min(4, w?.pushers ?? 1))
        a.vx += 0.95 * k
        if (planks <= 0) a.va += 1.7 * k
        this.sparks(hitX, ground + 1.0 + r() * 0.4, hitZ, fr.nx, fr.nz, 2 + stage, s, r)
        this.dust(hitX, ground + 1.2, hitZ, 2 + stage, 0.6, s, r)
        if (stage >= 2 && s.breachDebris > 0 && r() < 0.5 * s.breachDebris) this.throwPiece(9, hitX, ground + 1.1, hitZ, fr.nx * 1.8 + (r() - 0.5), 1.2, fr.nz * 1.8 + (r() - 0.5), r)
        const pushers = Math.max(1, w?.pushers ?? 1)
        // More fists, deeper thuds; the handle and lock rattle on every hit.
        for (let i = 1; i < Math.min(4, pushers); i++) this.sound("door.bash", fr.cx, fr.cz, s, 0.5, 0.9 - 0.05 * i - 0.03 * pushers, 0.05 + 0.07 * i)
        if (planks <= 0) this.sound("door.locked", fr.cx, fr.cz, s, 0.45, 1.25 + r() * 0.2, 0.03)
        // Holding it shut: you feel every hit.
        if (braced > 0 && isBracing(me, door.rect, w ?? { outside: -fr.inward }, s) && f.cam) {
          f.cam.add(0.16 * s.breachShake, Math.atan2(fr.nz, fr.nx), 1.0 * s.breachShake)
        }
      }
      a.lastBash = bash
    }

    // A crack deeper.
    if (stage > a.lastStage) {
      if (a.lastStage >= 0 && !a.fresh && stage >= 1 && stage <= 3) {
        this.sound("melee.hit.wood", fr.cx, fr.cz, s, 1.0, 0.72 - 0.06 * stage)
        this.sound("scape.door.creak", fr.cx, fr.cz, s, 0.8, 0.8)
        for (let i = 0; i < stage + 1; i++) this.throwPiece(i % 2 ? 10 : 9, hitX, ground + 0.9 + r() * 0.8, hitZ, fr.nx * (1.2 + r() * 1.5) + (r() - 0.5), 0.6 + r() * 1.5, fr.nz * (1.2 + r() * 1.5) + (r() - 0.5), r)
        this.dust(hitX, ground + 1.0, hitZ, 4 + stage * 2, 0.9, s, r)
      }
      a.lastStage = stage
    } else if (stage < a.lastStage && stage < 4) a.lastStage = stage

    // The warning beat starts: a loud crack and the wood groaning.
    const giving = (w?.givingAt ?? -1) >= 0
    if (giving && w!.givingAt !== a.lastGivingAt) {
      if (!a.fresh && now - w!.givingAt < 0.5) {
        this.sound("melee.break", fr.cx, fr.cz, s, 1.3, 0.55)
        this.sound("melee.hit.wood", fr.cx, fr.cz, s, 1.2, 0.5, 0.06)
        this.dust(fr.cx, ground + 2.2, fr.cz, 6, 1.2, s, r, 0)
      }
      a.lastGivingAt = w!.givingAt
    }
    if (giving && dist < 24 && s.breachAudio > 0) holdAmbientSound(`breach:give:${door.id}`, "scape.door.creak", fr.cx, fr.cz, 1.1 * s.breachAudio, 0.62)

    // The breach.
    const breachAt = w?.breachAt ?? -1
    if (breachAt >= 0 && breachAt !== a.lastBreachAt) {
      if (!a.fresh && now - breachAt < 1.5) this.breach(w!, fr, ground, dist, f, r)
      a.slammed = a.fresh || now - breachAt > 1
      a.lastBreachAt = breachAt
    }

    // Groans and scratching through the wood, by how many are pushing.
    const pushers = w?.pushers ?? 0
    if (pushers > 0 && shut && dist < 20 && s.breachAudio > 0) {
      holdAmbientSound(`breach:scratch:${door.id}`, "door.pry.loop", fr.cx, fr.cz, Math.min(0.6, 0.11 * pushers) * s.breachAudio, 1.55)
      if (now >= a.nextGroan) {
        this.sound("zombie.groan.idle", fr.cx + fr.nx * -0.6, fr.cz + fr.nz * -0.6, s, 0.45 + 0.08 * pushers, 0.78 + r() * 0.2)
        a.nextGroan = now + (2.6 + r() * 1.6) / Math.sqrt(pushers)
      }
    }

    // Springs: the jolt (a quick shudder) and ajar against the latch (a slower swing back to shut).
    const wj = (2 * Math.PI) / 0.16
    a.vx += (-wj * wj * a.x - 2 * 0.32 * wj * a.vx) * dt
    a.x += a.vx * dt
    const wa = (2 * Math.PI) / 0.3
    a.va += (-wa * wa * a.ajar - 2 * 0.55 * wa * a.va) * dt
    a.ajar += a.va * dt
    if (a.ajar < 0) {
      a.ajar = 0
      a.va = -a.va * 0.3
    }
    if (!shut) {
      a.x = 0
      a.vx = 0
      a.ajar = 0
      a.va = 0
    }
    a.fresh = false
    this.stats.stages[door.id] = DOOR_STAGE_NAMES[stage]!

    // Light through the gaps from the dead's side, and their feet's shadows under the door.
    const gap = shut ? (stage >= 4 ? 0.85 : stage === 3 ? 0.6 : stage === 2 ? 0.35 : 0.12) + (w?.holed ? 0.4 : 0) + a.ajar * 5 : 0
    let target = 0
    if (gap > 0 && s.breachLight > 0) {
      const outside = samplePointLightLevel(town, f.session.sim.hour, fr.cx - fr.nx * 1.4, fr.cz - fr.nz * 1.4)
      const inside = samplePointLightLevel(town, f.session.sim.hour, fr.cx + fr.nx * 1.4, fr.cz + fr.nz * 1.4)
      target = Math.max(0, outside - inside - 0.08) * gap * s.breachLight
    }
    a.light += (target - a.light) * Math.min(1, dt * 5)
    if (a.light > 0.01 && this.lightCount < 8) {
      const o = this.lightCount++ * LIGHT_FLOATS
      const L = this.lightData
      L.fill(0, o, o + LIGHT_FLOATS)
      L[o] = fr.cx + fr.nx * 0.3
      L[o + 1] = ground + (w?.holed ? 1.3 : 0.5)
      L[o + 2] = fr.cz + fr.nz * 0.3
      L[o + 3] = 1.6 + gap * 1.4
      L[o + 4] = 1
      L[o + 5] = 0.84
      L[o + 6] = 0.62
      L[o + 7] = Math.min(1.2, a.light * 0.9)
      L[o + 14] = 0.2
      L[o + 15] = -1
    }
    if (a.light > 0.04 && pushers > 0 && shut) {
      for (let i = 0; i < Math.min(4, pushers); i++) {
        const along = -0.42 + (i + 0.5) * (0.84 / Math.min(4, pushers)) + 0.05 * Math.sin(this.time * (1.7 + i * 0.4) + i)
        this.put(8, fr.cx + fr.ux * along + fr.nx * (0.16 + 0.04 * Math.sin(this.time * 2.3 + i)), ground + 0.003, fr.cz + fr.uz * along + fr.nz * (0.16 + 0.04 * Math.sin(this.time * 2.3 + i)), fr.yaw + 0.3 * Math.sin(this.time + i))
      }
    }

    // The door itself.
    const draws = w?.broken || (shut && (stage > 0 || w?.holed || Math.abs(a.x) > 2e-4 || a.ajar > 2e-4 || a.vx * a.vx > 1e-6 || giving))
    if (!draws) return
    this.drawn.add(door.id)
    this.stats.doors++
    if (w?.broken) {
      this.brokenDoor(a, w, fr, ground, now, f, r, planks)
      return
    }
    let bulge = 0
    let shake = 0
    let ajar = a.ajar
    if (stage === 4) {
      // Bulging in the frame, shaking, ajar as far as the latch lets it.
      const u = Math.min(1, (now - (w?.givingAt ?? now)) / Math.max(0.2, s.breachWarn))
      bulge = 0.03 + 0.04 * u
      shake = (0.012 + 0.02 * u) * Math.sin(this.time * 47) * s.breachJolt
      ajar += (0.04 + 0.05 * u) * (0.6 + 0.4 * Math.sin(this.time * 19)) * s.breachJolt
    }
    const off = a.x + bulge + shake
    const px = fr.hx + fr.nx * off
    const pz = fr.hz + fr.nz * off
    const yaw = fr.yaw + fr.zs * ajar
    const roll = fr.zs * (a.x * 1.2 + (stage === 4 ? 0.02 : 0))
    const sag = stage === 3 && !w?.holed ? -0.03 : 0
    this.put(0, px, 0, pz, yaw, sag, roll)
    if (stage >= 1) this.put(3 + Math.min(3, stage) - 1, px, 0, pz, yaw, sag, roll)
    if (w?.holed) {
      this.put(6, px, 0, pz, yaw, sag, roll)
      // Arms through the hole, reaching and grabbing; more when more push.
      const arms = pushers > 0 ? Math.min(2, pushers) : 0
      for (let i = 0; i < arms; i++) {
        const reach = w.grabbing ? 0.55 + 0.25 * Math.abs(Math.sin(this.time * 7 + i * 2)) : 0.2 + 0.25 * (0.5 + 0.5 * Math.sin(this.time * 2.6 + i * 2.4))
        const lx = HOLE_AT.x + (i ? -0.1 : 0.08)
        const [ax, az] = leafToWorld(px, pz, yaw, lx, 0)
        const armYaw = Math.atan2(-fr.nx, fr.nz)
        this.put(7, ax + fr.nx * (reach - 0.35), ground + HOLE_AT.y + (i ? -0.08 : 0.06) + 0.05 * Math.sin(this.time * 5 + i), az + fr.nz * (reach - 0.35), armYaw + 0.25 * Math.sin(this.time * 3.3 + i), 0, -0.15 + 0.2 * Math.sin(this.time * 4.1 + i * 1.7))
      }
    }
  }

  private brokenDoor(a: DoorAnim, w: PortalWear, fr: ReturnType<typeof frameOf>, ground: number, now: number, f: BreachFrame, r: () => number, planks: number): void {
    const s = f.settings
    const age = w.breachAt >= 0 ? now - w.breachAt : 99
    const doorKind = w.doorKind
    const me = f.session.view.player
    const dist = Math.hypot(fr.cx - me.x, fr.cz - me.y)
    if (w.wedged && planks > 0) {
      // Propped back across the frame from inside, leaning, crooked.
      const px = fr.hx + fr.nx * 0.16
      const pz = fr.hz + fr.nz * 0.16
      this.put(0, px, 0.02, pz, fr.yaw + fr.zs * 0.05, 0.05, -fr.zs * 0.1)
      this.put(5, px, 0.02, pz, fr.yaw + fr.zs * 0.05, 0.05, -fr.zs * 0.1)
      return
    }
    const lift = fr.zs < 0 ? 0.1 : 0.165
    const slab = (model: number, fallT: number, slide: number, twist: number, cracks: boolean) => {
      const u = Math.min(1, Math.max(0, age) / fallT)
      let theta = (Math.PI / 2) * easeIn(u)
      if (u >= 1) theta = Math.PI / 2 - 0.06 * Math.exp(-(age - fallT) * 9) * Math.abs(Math.sin((age - fallT) * 28))
      const sl = slide * (u < 1 ? u * 0.4 : 0.4 + 0.6 * Math.min(1, (age - fallT) / 0.25))
      const px = fr.hx + fr.nx * sl
      const pz = fr.hz + fr.nz * sl
      const y = lift * Math.sin(theta)
      const yaw = fr.yaw + twist * Math.min(1, u)
      this.put(model, px, y, pz, yaw, 0, fr.zs * theta)
      if (cracks) this.put(5, px, y, pz, yaw, 0, fr.zs * theta)
      return u >= 1
    }
    if (doorKind === KIND_SPLIT) {
      // The hinge half hangs swung in and sagging; the latch half fell flat.
      const swing = 1.15 - 0.35 * Math.exp(-age * 4) * Math.cos(age * 9)
      this.put(1, fr.hx, 0, fr.hz, fr.yaw + fr.zs * swing, -0.1, 0)
      const landed = slab(2, FALL_T, 0.15, ((strHash(String(w.breachAt)) % 100) / 100 - 0.5) * 0.4, false)
      this.slam(a, landed, fr, ground, dist, f, r, 0.6)
      return
    }
    if (!w.debris) return
    const crush = doorKind === KIND_CRUSH
    const landed = slab(0, crush ? CRUSH_FALL_T : FALL_T, crush ? 0.9 : 0.25, crush ? ((strHash(String(w.breachAt)) % 100) / 100 - 0.5) * 0.6 : 0, true)
    this.slam(a, landed, fr, ground, dist, f, r, crush ? 1.3 : 1)
  }

  /** The slab hits the floor: dust out from under it, the slap, a jolt through the floor. */
  private slam(a: DoorAnim, landed: boolean, fr: ReturnType<typeof frameOf>, ground: number, dist: number, f: BreachFrame, r: () => number, size: number): void {
    if (a.slammed || !landed) return
    a.slammed = true
    const s = f.settings
    const mx = fr.cx + fr.nx * 1.2
    const mz = fr.cz + fr.nz * 1.2
    this.dust(mx, ground + 0.1, mz, 12 * size, 2.0, s, r, 0.5)
    this.sound("door.wood.close", mx, mz, s, 1.5 * size, 0.55)
    this.sound("door.bash", mx, mz, s, 1.0 * size, 0.6, 0.02)
    if (f.cam) {
      const att = attenuateShake(dist, 14)
      if (att > 0) f.cam.add(0.22 * size * att * s.breachShake, Math.atan2(f.session.view.player.y - mz, f.session.view.player.x - mx), 0.9 * att * s.breachShake)
    }
  }

  private breach(w: PortalWear, fr: ReturnType<typeof frameOf>, ground: number, dist: number, f: BreachFrame, r: () => number): void {
    const s = f.settings
    const kind = w.kind
    this.stats.breaches.push(BREACH_KIND_NAMES[kind] ?? "none")
    if (this.stats.breaches.length > 12) this.stats.breaches.shift()
    const n = s.breachDebris
    const out = (sp: number, spread = 1) => [fr.nx * sp + (r() - 0.5) * spread, fr.nz * sp + (r() - 0.5) * spread] as const
    const along = (u: number) => [fr.cx + fr.ux * u, fr.cz + fr.uz * u] as const
    const pieces = (model: number, count: number, y0: number, y1: number, speed: number, up: number) => {
      for (let i = 0; i < Math.round(count * n); i++) {
        const [x, z] = along((r() - 0.5) * 1.3)
        const [vx, vz] = out(speed * (0.6 + r() * 0.8), speed * 0.6)
        this.throwPiece(model, x, ground + y0 + r() * (y1 - y0), z, vx, up * (0.5 + r()), vz, r)
      }
    }
    if (kind === KIND_HINGES) {
      pieces(9, 7, 0.3, 2.1, 2.6, 2)
      pieces(10, 2, 0.3, 2.1, 1.8, 1.5)
      this.sound("barricade.break", fr.cx, fr.cz, s, 1.0, 0.8)
      this.sound("melee.break", fr.cx, fr.cz, s, 1.1, 0.65)
    } else if (kind === KIND_SPLIT) {
      pieces(9, 12, 0.3, 2.1, 3.0, 2.2)
      pieces(10, 3, 0.4, 1.9, 2.2, 1.6)
      this.sound("melee.break", fr.cx, fr.cz, s, 1.4, 0.7)
      this.sound("barricade.break", fr.cx, fr.cz, s, 1.0, 0.9, 0.04)
    } else if (kind === KIND_CRUSH) {
      // The frame bursts: jambs and the header come away with the door.
      for (const side of [-1, 1]) {
        const [x, z] = along(side * (DOOR_WIDTH * 0.5 + 0.05))
        const [vx, vz] = out(3.2 + r() * 1.5, 1.2)
        this.throwPiece(11, x, ground + 1.05, z, vx, 1.2 + r(), vz, r, 0.06)
      }
      const [hx, hz] = out(2.6, 0.8)
      this.throwPiece(11, fr.cx, ground + 2.3, fr.cz, hx, 1.0, hz, r, 0.06)
      pieces(9, 16, 0.2, 2.3, 3.8, 2.4)
      pieces(10, 5, 0.3, 2.2, 3.0, 2)
      this.sound("barricade.break", fr.cx, fr.cz, s, 1.6, 0.6)
      this.sound("melee.break", fr.cx, fr.cz, s, 1.3, 0.5, 0.08)
      this.sound("zombie.horde.shuffle", fr.cx, fr.cz, s, 1.2, 0.9, 0.2)
    } else if (kind === KIND_BOARDS) {
      pieces(12, 1 + (w.broken ? 0 : 0), 0.9, 1.6, 2.6, 2)
      pieces(9, 6, 0.6, 1.8, 2.4, 1.8)
      if (w.broken) pieces(10, 3, 0.4, 1.8, 2.4, 1.6)
      this.sound("melee.hit.wood", fr.cx, fr.cz, s, 1.2, 0.7)
    }
    this.dust(fr.cx + fr.nx * 0.4, ground + 1.0, fr.cz + fr.nz * 0.4, kind === KIND_CRUSH ? 22 : 12, 1.6, s, r, 0.4)
    this.sparks(fr.cx, ground + 1.1, fr.cz, fr.nx, fr.nz, kind === KIND_CRUSH ? 14 : 8, s, r)
    if (f.cam) {
      const att = attenuateShake(dist, 18)
      const me = f.session.view.player
      if (att > 0) {
        const k = kind === KIND_CRUSH ? 1.4 : kind === KIND_BOARDS ? 0.7 : 1
        f.cam.add(0.42 * k * att * s.breachShake, Math.atan2(me.y - fr.cz, me.x - fr.cx), 2.0 * k * att * s.breachShake)
        f.cam.punch(0.12 * k * att * s.breachShake, 0)
      }
    }
  }

  private window(win: WindowOpening, w: PortalWear | undefined, st: PortalState | undefined, f: BreachFrame, now: number, support: (x: number, z: number) => number): void {
    if (!st) return
    const s = f.settings
    const fr = frameOf(f.session.sim.town, win.rect, w)
    const ground = support(fr.cx, fr.cz)
    const r = rng(strHash(win.id) ^ Math.round(now * 60))
    const last = this.winBash.get(win.id)
    if (last !== undefined && st.lastBashTime > last + 1e-3 && now - st.lastBashTime < 0.4 && st.barricadePlanks > 0) {
      this.sparks(fr.cx + fr.nx * 0.1, ground + 1.4, fr.cz + fr.nz * 0.1, fr.nx, fr.nz, 3, s, r)
      this.dust(fr.cx + fr.nx * 0.1, ground + 1.4, fr.cz + fr.nz * 0.1, 3, 0.8, s, r)
      const pushers = Math.max(1, w?.pushers ?? 1)
      for (let i = 1; i < Math.min(4, pushers); i++) this.sound("door.bash", fr.cx, fr.cz, s, 0.45, 0.95 - 0.05 * i, 0.06 * i)
      if (w?.givingAt !== undefined && w.givingAt >= 0 && w.giving === GIVING_BOARDS) this.sound("scape.door.creak", fr.cx, fr.cz, s, 0.9, 0.9)
    }
    this.winBash.set(win.id, st.lastBashTime)
    const breachAt = w?.breachAt ?? -1
    const seen = this.winBreach.get(win.id)
    if (seen !== undefined && breachAt >= 0 && breachAt !== seen && now - breachAt < 1.5 && w?.kind === KIND_BURST) {
      const n = s.breachDebris
      for (let i = 0; i < Math.round(18 * n); i++) {
        const u = (r() - 0.5) * 1.8
        this.throwPiece(13, fr.cx + fr.ux * u, ground + 1.0 + r() * 1.0, fr.cz + fr.uz * u, fr.nx * (2 + r() * 3) + (r() - 0.5), 0.8 + r() * 2, fr.nz * (2 + r() * 3) + (r() - 0.5), r, 0.01)
      }
      for (let i = 0; i < Math.max(1, Math.round(n)); i++) this.throwPiece(12, fr.cx, ground + 1.42, fr.cz, fr.nx * (2.4 + r()), 1.5 + r(), fr.nz * (2.4 + r()), r, 0.03)
      this.dust(fr.cx + fr.nx * 0.4, ground + 1.3, fr.cz + fr.nz * 0.4, 8, 1.4, s, r)
      this.sound("glass.break", fr.cx, fr.cz, s, 1.4, 0.92)
      this.sound("glass.break", fr.cx, fr.cz, s, 1.0, 0.7, 0.09)
      this.sound("barricade.break", fr.cx, fr.cz, s, 0.9, 1.0, 0.03)
      if (f.cam) {
        const me = f.session.view.player
        const att = attenuateShake(Math.hypot(fr.cx - me.x, fr.cz - me.y), 16)
        if (att > 0) f.cam.add(0.3 * att * s.breachShake, Math.atan2(me.y - fr.cz, me.x - fr.cx), 1.4 * att * s.breachShake)
      }
      this.stats.breaches.push("burst")
    }
    this.winBreach.set(win.id, breachAt)
  }

  private stepPieces(dt: number, s: OutbreakBreachSettings, support: (x: number, z: number) => number): void {
    const life = Math.max(1, s.breachDebrisLife)
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i]!
      const age = this.time - p.born
      if (age > life + 1.5) {
        this.pieces.splice(i, 1)
        continue
      }
      if (!p.rest) {
        p.vy -= 13 * dt
        p.x += p.vx * dt
        p.y += p.vy * dt
        p.z += p.vz * dt
        p.yaw += p.wy * dt
        p.pitch += p.wp * dt
        p.roll += p.wr * dt
        const g = support(p.x, p.z) + p.half
        if (p.y < g) {
          p.y = g
          if (Math.abs(p.vy) < 1.2) {
            p.vy = 0
            p.vx *= 0.5
            p.vz *= 0.5
            p.wy *= 0.4
            p.wp = 0
            p.wr = 0
            // Settle flat-ish.
            p.pitch *= 0.4
            p.roll = Math.round(p.roll / Math.PI) * Math.PI
            if (Math.hypot(p.vx, p.vz) < 0.15) p.rest = true
          } else {
            p.vy = -p.vy * 0.28
            p.vx *= 0.6
            p.vz *= 0.6
            p.wy *= 0.6
            p.wp *= 0.5
            p.wr *= 0.5
          }
        }
      }
      // Pieces don't vanish: they fade out after lying a while.
      const alpha = age > life ? Math.max(0, 1 - (age - life) / 1.5) : 1
      this.put(p.model, p.x, p.y, p.z, p.yaw, p.pitch, p.roll, alpha)
    }
    this.stats.debris = this.pieces.length
  }

  batches(): readonly Batch[] {
    this.batchList.length = 0
    for (let m = 0; m < this.models.length; m++) {
      if (this.counts[m]! > 0) this.batchList.push({ model: this.models[m]!, data: this.data[m]!, count: this.counts[m]! })
    }
    return this.batchList
  }

  /** Packs the gap lights after `count`; returns the new count. */
  writeLights(lights: Float32Array, count: number, max: number): number {
    const n = Math.min(this.lightCount, Math.max(0, max - count))
    lights.set(this.lightData.subarray(0, n * LIGHT_FLOATS), count * LIGHT_FLOATS)
    this.stats.lights = n
    return count + n
  }
}
