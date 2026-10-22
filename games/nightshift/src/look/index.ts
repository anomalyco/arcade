import { packVerts } from "@arcade/kit/gpu/mesh"
import type { Renderer } from "@arcade/kit/gpu/renderer"
import type { SceneHooks } from "@arcade/kit/gpu/shaders"
import type { SceneLight } from "@arcade/kit/gpu/scene-frame"
import type { FogLamp } from "@arcade/kit/gpu/fog-scatter"
import type { PlanBounceInput } from "@arcade/kit/gpu/gi/plan-bounce"
import type { SpotShadowCaster } from "@arcade/kit/gpu/shadows/spot-shadows"
import type { VolumeInput } from "@arcade/kit/gpu/volume-pass"
import type { ScenePass } from "@arcade/kit/gpu/pass-graph"
import { OCC_FLOATS } from "@arcade/kit/limits"
import type { FrameParts } from "@arcade/kit/gpu/frame-parts"
type PushPart = FrameParts["push"]
import { lampFlicker } from "@arcade/kit/gpu/lights/flicker"
import type { ChairState } from "../polish/props"
import { COLLEAGUES, occluders } from "../world"
import type { LookSettings } from "./settings"
import type { AdaptiveQualityController } from "@arcade/kit/quality"
import type { LookQuality } from "./quality"
import { LOOK_SURFACES_PATH, lookSurfaces } from "./textures"
import { coatMesh, dressingPlacements, loadDressing, partitionTrim, LOOK_PROP_PATHS } from "./dressing"
import { carLiner } from "./car"
import { BasementLight, basementDressing, basementFogLamps, tubeOut } from "./basement"
import { shaftInput, SHAFT_PARAM_FLOATS, type ShaftLamp } from "./shafts"

export const LOOK_FILES = [LOOK_SURFACES_PATH, ...LOOK_PROP_PATHS]

/** A pass that draws only while the look is on. */
class Gate implements ScenePass {
  on = false
  constructor(private inner: ScenePass) {}
  draw(pass: GPURenderPassEncoder) { if (this.on) this.inner.draw(pass) }
}

type Ctx = { settings: LookSettings & { fluorescent: number; crt: number; flicker: number }; time: number }

/** The dying tube by the elevator (troffer centre, metres) and how near you get before it goes out. */
const ELEVATOR_TUBE = { x: -.085, z: 5, reach: 3.4 }
/** The desk lamp left on in a far cubicle (Wrongness): the second dressed desk lamp, its bulb under the shade. */
const FAR_LAMP = dressingPlacements().filter(p => p.file === "desk-lamp")[1]!

/**
 * The office look (AR-129): one object the frame loop asks for its extra lights, fog lamps, bounce, shafts, uniforms and
 * parts. With `look` at Today it adds nothing, loads nothing and leaves the frame exactly as shipped.
 */
export class OfficeLook {
  /** Bumped when the set of shadow casters changes, so the spot-shadow picker re-renders. */
  version = 0
  private extraCasters: SpotShadowCaster[] = []
  private loading: Promise<void> | null = null
  private loaded = false
  private scans = false
  private dressing: Gate | null = null
  private dressingCasters: SpotShadowCaster[] = []
  private trim = -1
  private trimCaster: SpotShadowCaster | null = null
  private coats: number[] = []
  private car = -1
  private basement = -1
  private readonly basementLight = new BasementLight()
  /** Car origin x (the shell is shared by the office and the basement). */
  carX = 0
  private wasOn = false
  private chairsPushed = false
  private readonly shaftParams = new Float32Array(SHAFT_PARAM_FLOATS)
  /** Time the elevator tube went out (NaN while it still burns). */
  private tubeOutAt = NaN
  private tube = 1
  readonly occ: Float32Array<ArrayBuffer>
  readonly occCount: number

  /** `quality` is the game shell's (Settings › Graphics); the look reads its tier and sizes the canvas from it. */
  constructor(private renderer: Renderer, private hooks: SceneHooks, private smoke: boolean, private bytes: (path: string) => Promise<Uint8Array>, readonly quality: AdaptiveQualityController<LookQuality>) {
    this.occ = new Float32Array(Math.max(1, occluders.length) * OCC_FLOATS)
    occluders.forEach((o, i) => this.occ.set([...o.rect, o.h, 0, 0, 0], i * OCC_FLOATS))
    this.occCount = occluders.length
  }

  on(s: LookSettings) { return !this.smoke && s.look > 0.5 }
  get profile(): LookQuality { return this.quality.getProfile() }

  /** Resolves once everything the current setting shows has loaded (proof scripts wait on it). */
  async ready(s: LookSettings) { if (this.on(s)) await this.ensure() }

  private ensure() {
    this.loading ??= (async () => {
      const device = this.renderer.passContext.device
      const [surfaces, dressing] = await Promise.all([
        this.bytes(LOOK_SURFACES_PATH).then(b => lookSurfaces(device, b)),
        loadDressing(this.renderer, this.hooks, this.bytes),
      ])
      this.renderer.setDetailTextureArray(surfaces.createView({ dimension: "2d-array" }))
      this.scans = true
      this.dressing = new Gate(dressing.pass)
      this.renderer.addPass("opaque", this.dressing)
      this.dressingCasters = dressing.casters
      const trim = partitionTrim()
      this.trim = this.renderer.addModel(trim)
      const data = packVerts(trim.v), buffer = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
      device.queue.writeBuffer(buffer, 0, data)
      this.trimCaster = { buffer, count: trim.v.length / 11, stride: 24 }
      this.coats = [0, 1, 2].map(i => this.renderer.addModel(coatMesh(i)))
      this.car = this.renderer.addModel(carLiner())
      this.basement = this.renderer.addModel(basementDressing())
      this.loaded = true
      this.version++
    })()
    return this.loading
  }

  /** Called once per frame before lights: toggles assets and chairs. */
  update(s: LookSettings & { flicker: number }, chairs: ChairState[], eye: readonly number[], time: number) {
    const on = this.on(s)
    // Wrongness: the dying tube by the elevator gutters out once you come near, and stays out.
    if (!on || !(s.wrongness > 0)) this.tubeOutAt = NaN
    else if (Number.isNaN(this.tubeOutAt) && Math.hypot(eye[0]! - ELEVATOR_TUBE.x, eye[2]! - ELEVATOR_TUBE.z) < ELEVATOR_TUBE.reach) this.tubeOutAt = time
    this.tube = this.dying(time, s.flicker) * tubeOut(time - this.tubeOutAt)
    if (on) void this.ensure()
    const gate = on && this.loaded
    if (this.dressing) this.dressing.on = gate && s.dressing
    const casters = gate ? [...(s.dressing ? this.dressingCasters : []), ...(this.trimCaster ? [this.trimCaster] : [])] : []
    if (casters.length !== this.extraCasters.length || on !== this.wasOn) { this.extraCasters = casters; this.version++ }
    this.wasOn = on
    const push = on && s.chairsPushed
    if (push !== this.chairsPushed) { this.chairsPushed = push; pushChairs(chairs, push) }
  }

  casters() { return this.extraCasters }

  /** Canvas size: Today keeps min(dpr, 1.5); the look follows its quality tier and dynamic resolution. */
  canvasSize(s: LookSettings, w: number, h: number, dpr: number) {
    if (!this.on(s)) { const r = Math.min(dpr, 1.5); return { width: Math.max(1, Math.round(w * r)), height: Math.max(1, Math.round(h * r)) } }
    return this.quality.canvasDimensions(w, h, dpr)
  }

  /** Streetlight power through the blinds, × Today's. */
  slat(s: LookSettings) { return this.on(s) ? s.slatLight : 1 }
  crt(s: LookSettings) { return this.on(s) ? 2.2 : 1 }
  /** The hero CRT's spill: Today's green throughout, or the phosphor's own colour once the screen turns red. */
  crtColor(s: LookSettings, red: boolean): readonly [number, number, number] { return this.on(s) && red ? [1, .2, .11] : [.16, 1, .48] }
  private dying(time: number, amount: number) { return lampFlicker("fluorescent", 88, time, Math.min(2, amount * 2)).level }
  /** Share of Today's teal ambient and floor fill. */
  fill(s: LookSettings) { return this.on(s) ? s.fill : 1 }
  /** The car's ceiling light: a steady glow that now and then stutters (Today: steady). */
  carLight(s: LookSettings, time: number) { return this.on(s) && s.car ? .75 + .25 * lampFlicker("fluorescent", 91, time, .35).level : 1 }
  /** Today's troffers, × this. */
  tubes(s: LookSettings) { return this.on(s) ? s.tubeLight : 1 }
  /** Colleague screens dip together, twice in quick succession, every 23 s (Wrongness). */
  private sync(s: LookSettings, time: number, basement = false) {
    const t = (time + (basement ? 9 : 0)) % 23, dip = (t > 11 && t < 11.09) || (t > 11.19 && t < 11.31)
    return dip ? 1 - .7 * s.wrongness : 1
  }

  lamps(c: Ctx): SceneLight[] {
    const s = c.settings
    if (!this.on(s)) return []
    const sync = this.sync(s, c.time)
    const out: SceneLight[] = COLLEAGUES.map((st, i) => ({ id: 20 + i, x: st.x, y: st.z - .19, h: 1.11, r: 2.8, color: [1, .2, .11] as const, power: s.screenSpill * sync, size: .2, unshadowed: true, spot: { axis: [0, -.3, -1] as const, cosOuter: .02, cosInner: .55 } }))
    if (s.tubes > .5) {
      out.push({ id: 30, x: -.085, y: 5, h: 2.79, r: 6, color: [.78, .89, .87], power: s.fluorescent * .55 * this.tube, size: .35, unshadowed: true, spot: { axis: [0, -1, 0], cosOuter: .15, cosInner: .5 } })
      out.push({ id: 31, x: 3.685, y: -4, h: 2.79, r: 5, color: [.62, .78, .70], power: s.fluorescent * .09, size: .35, unshadowed: true, spot: { axis: [0, -1, 0], cosOuter: .15, cosInner: .5 } })
    }
    if (s.wrongness > 0) out.push({ id: 32, x: FAR_LAMP.x, y: FAR_LAMP.z, h: FAR_LAMP.y + .33, r: 2.4, color: [1, .6, .28], power: .12 * s.wrongness, size: .05, unshadowed: true, spot: { axis: [0, -1, 0], cosOuter: .35, cosInner: .75 } })
    return out
  }

  /** Basement practicals fail and the screens carry the light (look on); Today leaves them as authored. */
  basementLamps(s: LookSettings, lamps: SceneLight[], time: number, eye: readonly number[]) {
    if (!this.on(s)) { this.basementLight.reset(); return }
    this.basementLight.apply(lamps, time, eye, s.wrongness, this.sync(s, time, true))
  }
  basementFog(s: LookSettings, time: number, budget: number): FogLamp[] {
    return this.on(s) ? basementFogLamps(time, this.sync(s, time, true), budget) : []
  }

  /** Extra lamps lighting the haze: the elevator car glowing through it. */
  fogLamps(s: LookSettings): FogLamp[] {
    if (!this.on(s)) return []
    return [{ id: 9, x: 0, y: 2.2, z: 9.7, range: 6, color: [1, .49, .16], intensity: 3 * s.elevatorGlow, size: .4 }]
  }

  /** Fog density and colour: Today's, or the far-end teal haze. */
  fog(s: LookSettings & { fog: number }, downstairs: boolean) {
    if (!this.on(s)) return { density: s.fog, brightness: .003 }
    return downstairs ? { density: s.basementHaze, brightness: .003 * s.hazeLight } : { density: s.haze, brightness: .003 * s.hazeLight }
  }

  bounce(s: LookSettings, x: number, z: number): PlanBounceInput | null {
    const texel = this.profile.bounceTexel
    if (!this.on(s) || !(s.lookBounce > 0) || !texel) return null
    return { centerX: x, centerZ: z, strength: s.lookBounce, range: s.bounceRange, texel, albedo: .3, walls: 1.2, floorY: .05 }
  }

  shafts(s: LookSettings, lamps: readonly ShaftLamp[]): VolumeInput | null {
    const p = this.profile
    if (!this.on(s) || !(s.shafts > 0) || !p.shaftDownscale) return null
    return shaftInput(this.shaftParams, lamps, p.shaftSteps, s.shafts, p.shaftDownscale)
  }

  /** O.lookA–D (floats 40–55 of the custom uniform). */
  pack(custom: Float32Array, s: LookSettings, time: number, red: boolean) {
    const on = this.on(s), contact = this.profile.contactShading ? s.contact : 0
    custom.set([Number(on), s.screenSpill, s.screenGlass, s.wear, Number(this.scans), s.ceiling, s.tubes, this.tube, s.elevatorGlow, Number(red), this.sync(s, time, this.carX > 0), this.basementLight.levels[0], this.basementLight.levels[1], contact, this.carX, this.carLight(s, time)], 40)
  }

  /** Partition trim and coats over chair backs (following the chairs as they roll). */
  parts(s: LookSettings, push: PushPart, chairs: ChairState[], chairYaw: (c: ChairState) => number, cars: readonly number[]) {
    if (!this.on(s) || !this.loaded) return
    push(this.trim, 0, 0, 0, 0, [1, 1, 1], 0, 0, 0)
    if (s.car) for (const x of cars) push(this.car, x, 0, 0, 0, [1, 1, 1], 0, 0, 0)
    if (this.carX > 0) push(this.basement, 0, 0, 0, 0, [1, 1, 1], 0, 0, 0)
    if (!s.dressing) return
    COAT_CHAIRS.forEach((home, i) => {
      const c = chairs.find(c => Math.hypot(c.homeX - home[0], c.homeZ - home[1]) < .01)
      if (c) push(this.coats[i % this.coats.length]!, c.x, 0, c.z, -chairYaw(c), [1, 1, 1], 0, 0, 0)
    })
  }
}

/** Colleague chairs that carry a coat (home positions). */
const COAT_CHAIRS: [number, number][] = [[-2.3, 2.7], [2.75, -3.3], [-2.3, -.3]]
/** Pushed back from the desk and turned, as if their owners stood up fast. Home again when the look is off. */
function pushChairs(chairs: ChairState[], push: boolean) {
  const poses: Record<string, [number, number, number]> = {
    "-2.3,2.7": [.12, -.28, .7], "2.75,2.7": [-.1, -.18, -.45], "-2.3,-0.3": [.18, -.32, -.9],
    "2.75,-0.3": [-.05, -.2, .35], "-2.3,-3.3": [.08, -.15, .25], "2.75,-3.3": [-.2, -.34, -1.1], "4.6,-8.65": [-.15, .05, .6],
  }
  for (const c of chairs) {
    const pose = poses[`${+c.homeX.toFixed(2)},${+c.homeZ.toFixed(2)}`]
    if (!pose) continue
    c.vx = c.vz = c.spin = 0
    c.x = c.homeX + (push ? pose[0] : 0); c.z = c.homeZ + (push ? pose[1] : 0); c.yaw = push ? pose[2] : 0
    const w = (c.collider[2] - c.collider[0]) / 2, d = (c.collider[3] - c.collider[1]) / 2
    c.collider[0] = c.x - w; c.collider[2] = c.x + w; c.collider[1] = c.z - d; c.collider[3] = c.z + d
  }
}
