import { batchHooks } from "@arcade/kit/forest/shaders"
import { loadGltf } from "@arcade/kit/gpu/gltf"
import type { Renderer } from "@arcade/kit/gpu/renderer"
import type { SceneLight } from "@arcade/kit/gpu/scene-frame"
import type { SpotShadowCaster } from "@arcade/kit/gpu/shadows/spot-shadows"
import { TexturedMeshPass } from "@arcade/kit/gpu/textured-mesh"
import type { Clue } from "../shared/night"
import { terrainHeight, type WoodsWorld } from "../shared/world"

/** Tyre contacts in the model (m): `scripts/car/build-car.py` stands the tyres on y = 0, nose to −z, driver at −x. */
const TRACK = 0.793, FRONT = -1.423, REAR = 1.222
/** How far the tyres settle into the gravel (m). */
const SETTLE = 0.012
/** Far beyond this the car draws its LOD1 (m); back inside `LOD_NEAR` the full model again. */
const LOD_FAR = 40, LOD_NEAR = 35
/** The courtesy light: in the headlining over the front seats (model m), drawn only within this of the eye (m). */
const DOME = [0, 1.25, -0.1] as const, DOME_SEEN = 45

/** Where the car stands: the clue's yaw (as the greybox's `turn`), pitched and rolled onto the ground under its tyres. */
export type CarPose = { m: Float32Array; at: (x: number, y: number, z: number) => [number, number, number]; turn: (x: number, y: number, z: number) => [number, number, number] }

export function carPose(c: Clue, world: WoodsWorld): CarPose {
  const yaw = Math.atan2(c.fx, -c.fz), cy = Math.cos(yaw), sy = Math.sin(yaw)
  const plan = (x: number, z: number) => [c.x + x * cy + z * sy, c.z - x * sy + z * cy] as const
  const h = (x: number, z: number) => { const [wx, wz] = plan(x, z); return terrainHeight(world.terrain, wx, wz) }
  const lf = h(-TRACK, FRONT), rf = h(TRACK, FRONT), lr = h(-TRACK, REAR), rr = h(TRACK, REAR)
  const pitch = Math.atan2((lf + rf - lr - rr) / 2, REAR - FRONT), roll = Math.atan2((rf + rr - lf - lr) / 2, 2 * TRACK)
  const y0 = (lf + rf + lr + rr) / 4 - SETTLE
  // R = Ry(yaw) · Rx(pitch) · Rz(roll), as rows.
  const cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll)
  const rx = [[1, 0, 0], [0, cp, -sp], [0, sp, cp]], rz = [[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]], ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]
  const mul = (a: number[][], b: number[][]) => a.map((r) => [0, 1, 2].map((j) => r[0]! * b[0]![j]! + r[1]! * b[1]![j]! + r[2]! * b[2]![j]!))
  const r = mul(ry, mul(rx, rz))
  const turn = (x: number, y: number, z: number): [number, number, number] => [r[0]![0]! * x + r[0]![1]! * y + r[0]![2]! * z, r[1]![0]! * x + r[1]![1]! * y + r[1]![2]! * z, r[2]![0]! * x + r[2]![1]! * y + r[2]![2]! * z]
  const at = (x: number, y: number, z: number): [number, number, number] => { const v = turn(x, y, z); return [v[0] + c.x, v[1] + y0, v[2] + c.z] }
  const m = new Float32Array([r[0]![0]!, r[1]![0]!, r[2]![0]!, 0, r[0]![1]!, r[1]![1]!, r[2]![1]!, 0, r[0]![2]!, r[1]![2]!, r[2]![2]!, 0, c.x, y0, c.z, 1])
  return { m, at, turn }
}

type Loaded = { seed: number; near: TexturedMeshPass; far: TexturedMeshPass; casters: { near: SpotShadowCaster[]; far: SpotShadowCaster[] }; dispose: () => void }

/**
 * Barbara's car, parked in the lot (`games/barbara/public/car/car.glb`, built by `scripts/car/build-car.ts`): a textured
 * pass on the forest batch's lighting, so the tail-light reflectors and plates catch your own torch (`MAT.retro`). It
 * loads once per night's layout; until then `ready` is false and `NightView` draws the greybox. Static shadow
 * casters keep one array per level, so the forest re-renders its shadow slots only when the level changes.
 */
export class CarView {
  private bytes: Promise<Uint8Array> | null = null
  private loaded: Loaded | null = null
  private want = NaN
  private far = false
  pose: CarPose | null = null

  constructor(private readonly renderer: Renderer) {}

  /** Whether the model for `seed` is drawing. */
  ready(seed: number): boolean { return this.loaded?.seed === seed }

  /** Places the car for tonight's layout (call when the seed changes); `onReady` runs once it draws. */
  place(seed: number, c: Clue, world: WoodsWorld, onReady: () => void): void {
    if (seed === this.want) return
    this.want = seed
    const pose = carPose(c, world)
    this.pose = pose
    this.bytes ??= fetch(import.meta.env.BASE_URL + "car/car.glb").then(async (r) => {
      if (!r.ok) throw new Error(`car: HTTP ${r.status}`)
      return new Uint8Array(await r.arrayBuffer())
    })
    void this.bytes.then((b) => loadGltf(this.renderer.passContext.device, b, pose.m, undefined, "all")).then((asset) => {
      if (this.want !== seed) { asset.dispose(); return }
      const level = (n: number) => asset.primitives.filter((_, i) => asset.lods[i] === n)
      const near = new TexturedMeshPass(this.renderer.passContext, level(0), batchHooks)
      const far = new TexturedMeshPass(this.renderer.passContext, level(1), batchHooks)
      this.drop()
      this.loaded = { seed, near, far, casters: { near: near.shadowCasters(), far: far.shadowCasters() }, dispose: () => { near.dispose(); far.dispose(); asset.dispose() } }
      this.renderer.addPass("opaque", this.far ? far : near)
      onReady()
    }).catch((e) => { this.bytes = null; this.want = NaN; console.warn("car: kept the greybox", e) })
  }

  private drop() {
    if (!this.loaded) return
    this.renderer.removePass(this.far ? this.loaded.far : this.loaded.near)
    this.loaded.dispose()
    this.loaded = null
  }

  /** Swaps LOD by distance from the eye; returns the static shadow casters to hand the forest (same array until a swap). */
  frame(eye: readonly number[]): readonly SpotShadowCaster[] | undefined {
    const l = this.loaded, p = this.pose
    if (!l || !p) return undefined
    const d = Math.hypot(eye[0]! - p.m[12]!, eye[2]! - p.m[14]!)
    const far = this.far ? d > LOD_NEAR : d > LOD_FAR
    if (far !== this.far) {
      this.renderer.removePass(this.far ? l.far : l.near)
      this.far = far
      this.renderer.addPass("opaque", far ? l.far : l.near)
    }
    return far ? l.casters.far : l.casters.near
  }

  /**
   * The courtesy light left on with the door open, its battery nearly flat: a dim warm bulb that browns out and
   * catches. `level` is the Lab's (0 is off, the default). Inside the body only the cab's inward faces and the ground
   * by the open door face it, so it needs no shadow.
   */
  light(t: number, level: number, eye: readonly number[]): SceneLight | null {
    const p = this.pose
    if (level <= 0 || !p) return null
    const [x, y, z] = p.at(DOME[0], DOME[1], DOME[2])
    if (Math.hypot(eye[0]! - x, eye[2]! - z) > DOME_SEEN) return null
    const sag = 0.72 + 0.18 * Math.sin(t * 1.7) + 0.1 * Math.sin(t * 5.3 + 1.1)
    const s = (t * 0.9) % 7
    const catchy = s < 0.35 ? 0.25 + 0.75 * Math.abs(Math.sin(s * 40)) : 1
    return { id: 951, x, y: z, h: y, r: 2.2, color: [1, 0.72, 0.42], power: 0.35 * level * sag * catchy, size: 0.05, unshadowed: true }
  }
}
