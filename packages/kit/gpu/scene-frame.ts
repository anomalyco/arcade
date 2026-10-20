import type { Rect } from "../sim/geom"
import { LIGHT_FLOATS, MAX_LIGHTS, MAX_OCCLUDERS, OCC_FLOATS } from "../limits"
import type { FloorMap } from "./level"
import { beamCone } from "./lights/beam"
import { physicalCone } from "./lights/physical"
import { FRAME_FLOATS } from "./shaders"

/**
 * The renderer's per-frame inputs for a small arena that has no baked map lights: a handful of placed lights, static
 * box occluders with heights, and round casters (people) added each frame. Every light sees every occluder in its
 * reach, so this suits stages up to a few hundred occluders; streaming maps keep their own culler.
 */
export type SceneLight = {
  x: number
  y: number
  /** Height above the floor. */
  h: number
  r: number
  color: readonly [number, number, number]
  power: number
  /** Shadow softness (fixture size). */
  size?: number
  /** Spot cone: plan direction and cos half-angle. */
  cone?: readonly [number, number, number]
  /**
   * Physical 3D spot (`lights/physical.ts`): axis pointing down or level, cos of the outer and inner half-angles.
   * Takes the cone slot instead of `cone`; only physical-light hooks shade it.
   */
  spot?: { axis: readonly [number, number, number]; cosOuter: number; cosInner: number }
  /**
   * Physical torch (`lights/beam.ts`): axis (any direction) and the half-angle the shared beam profile scales
   * to. Takes the cone slot; only physical-light hooks shade it.
   */
  beam?: { axis: readonly [number, number, number]; halfAngle: number }
  /** Skip shadows (cheap fill light). */
  unshadowed?: boolean
  /** Stable id, for finding the light's frame index after packing (`SceneLights.indexOf`), e.g. its spot shadow map. */
  id?: number
}

export type Caster = { x: number; y: number; r?: number; h?: number }

export class SceneLights {
  readonly lights = new Float32Array(MAX_LIGHTS * LIGHT_FLOATS)
  readonly occ = new Float32Array(MAX_OCCLUDERS * OCC_FLOATS)
  readonly power = new Float32Array(1)
  lightCount = 0
  shadowLightCount = 0
  occCount = 0
  private readonly ids: (number | undefined)[] = []
  private boxes: { rect: Rect; h: number }[] = []

  /** Static occluders (walls, pillars) with heights. */
  setBoxes(boxes: readonly { rect: Rect; h: number }[]): void {
    this.boxes = [...boxes]
  }

  /** Packs this frame: shadowed lights first, each referencing the occluders within its reach. */
  update(lights: readonly SceneLight[], casters: readonly Caster[], moving: readonly { rect: Rect; h: number }[] = []): void {
    const L = this.lights
    L.fill(0, 0, this.lightCount * LIGHT_FLOATS)
    let nl = 0
    let no = 0
    const sorted = [...lights].sort((a, b) => Number(!!a.unshadowed) - Number(!!b.unshadowed))
    this.ids.length = 0
    for (const l of sorted) {
      if (nl >= MAX_LIGHTS) break
      this.ids.push(l.id)
      const off = no
      if (!l.unshadowed) {
        const reach = l.r + 0.5
        for (const b of this.boxes.length || moving.length ? [...this.boxes, ...moving] : []) {
          const [x0, y0, x1, y1] = b.rect
          const dx = Math.max(x0 - l.x, 0, l.x - x1)
          const dy = Math.max(y0 - l.y, 0, l.y - y1)
          if (dx * dx + dy * dy > reach * reach || no >= MAX_OCCLUDERS) continue
          this.occ.set([x0, y0, x1, y1, b.h, 0, 0, 0], no * OCC_FLOATS)
          no++
        }
        for (const c of casters) {
          const cr = c.r ?? 0.2
          if (Math.hypot(c.x - l.x, c.y - l.y) > reach + cr || no >= MAX_OCCLUDERS) continue
          this.occ.set([c.x, c.y, cr, 0, c.h ?? 1.75, 1, 0, 0], no * OCC_FLOATS)
          no++
        }
      }
      const cnt = l.unshadowed ? 0 : no - off
      const cone = l.beam ? beamCone(l.beam.axis, l.beam.halfAngle) : l.spot ? physicalCone(l.spot.axis, l.spot.cosOuter, l.spot.cosInner) : [l.cone?.[0] ?? 0, l.cone?.[1] ?? 0, l.cone?.[2] ?? 0, l.cone ? 1 : 0]
      L.set([l.x, l.h, l.y, l.r, l.color[0], l.color[1], l.color[2], l.power, ...cone, off, cnt, l.size ?? 0.3, -1], nl * LIGHT_FLOATS)
      nl++
    }
    let shadowed = 0
    for (let i = 0; i < nl; i++) if (L[i * LIGHT_FLOATS + 13]! > 0) shadowed = i + 1
    this.lightCount = nl
    this.shadowLightCount = shadowed
    this.occCount = no
  }

  /** Frame index of the light packed with this `id`, or −1. */
  indexOf(id: number): number {
    return this.ids.indexOf(id)
  }
}

export type SceneFrameInput = {
  viewProj: Float32Array
  eye: readonly number[]
  time: number
  width: number
  height: number
  lightCount: number
  /** Sky colour (linear) and directional strength. */
  ambient: readonly [number, number, number, number]
  /** Plan size the floor/bounce maps cover. */
  mapSize: readonly [number, number]
  /** Multi-bounce AO strength. */
  ao?: number
}

export function newSceneFrame(): Float32Array<ArrayBuffer> {
  return new Float32Array(FRAME_FLOATS)
}

/** Writes the scene uniform (see `Frame` in `gpu/shaders.ts`) for a stage without cutaways or monitor lights. */
export function packSceneFrame(F: Float32Array, f: SceneFrameInput): Float32Array {
  F.fill(0)
  F.set(f.viewProj, 0)
  F.set([f.eye[0]!, f.eye[1]!, f.eye[2]!, f.time], 16)
  F.set([f.width, f.height, f.lightCount, 0], 20)
  F.set([0, 0, 0, 0.24], 24)
  F.set(f.ambient, 28)
  F.set([0, 0, 0.7, f.lightCount], 32)
  F.set([1e9, 1e9, -1e9, -1e9], 36)
  F.set([1 / f.mapSize[0], 1 / f.mapSize[1], f.mapSize[0], f.mapSize[1]], 40)
  F.set([f.ao ?? 0, 0, 0, 0], 44)
  return F
}

/** Uniform floor and bounce maps: no baked occlusion or moonlight, an even bounce of `bounce` (0..1 sRGB-ish). */
export function flatLighting(occlusion = 0, moon = 1, bounce: readonly [number, number, number] = [0.5, 0.5, 0.5]): { floor: FloorMap; bounce: FloorMap } {
  const w = 4
  const h = 4
  const floor = new Uint8Array(w * h * 2)
  const moonData = new Uint8Array(w * h)
  const b = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    floor[i * 2] = Math.round(occlusion * 255)
    floor[i * 2 + 1] = Math.round(moon * 255)
    moonData[i] = Math.round(moon * 255)
    b[i * 4] = Math.round(bounce[0] * 255)
    b[i * 4 + 1] = Math.round(bounce[1] * 255)
    b[i * 4 + 2] = Math.round(bounce[2] * 255)
    b[i * 4 + 3] = 255
  }
  return { floor: { data: floor, w, h, moon: { data: moonData, w, h } }, bounce: { data: b, w, h } }
}
