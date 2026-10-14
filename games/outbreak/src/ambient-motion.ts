import { Emitter, Particles, type ParticleSpec } from "@arcade/kit/fx/particles"
import type { Wall } from "@arcade/kit/fx/volume"
import { MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, SPRITE_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import { Rng } from "@arcade/kit/sim/rng"
import { SIZE, type Town } from "../shared/map"
import { supportHeight } from "../shared/terrain"
import type { GroundSettings } from "./ground"

const rgb = (v: number): Rgb => [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]

const WIND_DIR_X = 0.88
const WIND_DIR_Z = 0.47
const CROSS_DIR_X = -0.47
const CROSS_DIR_Z = 0.88

const LEAF_PARTICLE_SPEC: ParticleSpec = {
  kind: "debris",
  life: 3.6,
  size: 0.08,
  growth: 0,
  gravity: 1.4,
  drag: 1.8,
  bounce: 0.35,
  r: 0.52,
  g: 0.30,
  b: 0.12,
  alpha: 1.0,
}

const PAPER_PARTICLE_SPEC: ParticleSpec = {
  kind: "debris",
  life: 4.2,
  size: 0.16,
  growth: 0,
  gravity: 1.1,
  drag: 2.2,
  bounce: 0.25,
  r: 0.56,
  g: 0.53,
  b: 0.47,
  alpha: 1.0,
}

type DrifterTrack = {
  kind: "leaf" | "paper" | "bag" | "can"
  anchorX: number
  anchorZ: number
  spanAlong: number
  spanAcross: number
  speed: number
  phase: number
  scale: number
  liftMax: number
}

type HingeProp = {
  kind: "gate" | "sign"
  x: number
  z: number
  baseYaw: number
  amp: number
  freq: number
  phase: number
}

/**
 * Evaluates the coherent wind-gust envelope [0..2.2] at `(x, z, time)` aligned with `(0.88, 0.47)`.
 */
export function evaluateWindGust(time: number, x: number, z: number, gustiness = 1.0): number {
  const along = x * WIND_DIR_X + z * WIND_DIR_Z
  const across = x * CROSS_DIR_X + z * CROSS_DIR_Z
  const w1 = Math.sin(time * 1.35 - along * 0.18 + across * 0.09)
  const w2 = Math.sin(time * 2.45 - along * 0.31 - across * 0.22 + 1.7)
  const w3 = Math.cos(time * 0.68 - along * 0.08 + 0.9)
  const raw = 0.52 + (w1 * 0.48 + w2 * 0.32 + w3 * 0.35) * Math.max(0.2, gustiness)
  return Math.max(0.08, Math.min(2.2, raw))
}

/**
 * Client-local decorative motion subsystem for Outbreak:
 * - Wind-gust drifting & swirling autumn leaves (`leafModel`)
 * - Tumbling newspapers & flyers skittering across the asphalt (`paperModel`)
 * - Billowing & tumbling polyethylene plastic bags (`bagModel`)
 * - Rolling tin cans in the gutters (`canModel`)
 * - Wind-swinging wooden/iron gates (`gatePostModel` + `gateLeafModel`)
 * - Wind-rocking tilted street/neighborhood warning signs (`signPostModel` + `signPlateModel`)
 * - Shared `@arcade/kit/fx/particles` (`Particles` + `Emitter`) gust spawns & subtle light-pool dust motes
 *
 * Purely visual and deterministic-ish from `time` and `clutterSeed`; never blocks navigation.
 */
export class OutbreakAmbientMotion {
  readonly particles = new Particles()
  private readonly leafEmitter = new Emitter()
  private readonly paperEmitter = new Emitter()

  private readonly leafModel: number
  private readonly paperModel: number
  private readonly bagModel: number
  private readonly canModel: number
  private readonly gatePostModel: number
  private readonly gateLeafModel: number
  private readonly signPostModel: number
  private readonly signPlateModel: number

  private readonly leafData = new Float32Array(128 * INST_FLOATS)
  private readonly paperData = new Float32Array(64 * INST_FLOATS)
  private readonly bagData = new Float32Array(32 * INST_FLOATS)
  private readonly canData = new Float32Array(32 * INST_FLOATS)
  private readonly gatePostData = new Float32Array(16 * INST_FLOATS)
  private readonly gateLeafData = new Float32Array(16 * INST_FLOATS)
  private readonly signPostData = new Float32Array(16 * INST_FLOATS)
  private readonly signPlateData = new Float32Array(16 * INST_FLOATS)

  private cachedKey = ""
  private drifters: DrifterTrack[] = []
  private hinges: HingeProp[] = []
  private wallRects: Wall[] = []
  private emitSeed = 1

  constructor(renderer: Pick<Renderer, "addModel">) {
    // 1. Cupped V-folded 3D autumn leaf
    const leaf = new Mesh()
    leaf.facet([-0.055, 0.0, 0.0], [0.01, 0.014, -0.042], [0.065, 0.004, 0.0], rgb(0x7c4218), MAT.lit)
    leaf.facet([-0.055, 0.0, 0.0], [0.065, 0.004, 0.0], [0.01, 0.014, 0.042], rgb(0x945220), MAT.lit)
    this.leafModel = renderer.addModel(leaf)

    // 2. Curved/folded newspaper sheet with headline bar
    const paper = new Mesh()
    paper.quadAuto([-0.11, 0.0, -0.08], [0.0, 0.018, -0.08], [0.0, 0.018, 0.08], [-0.11, 0.0, 0.08], rgb(0x888274), MAT.lit)
    paper.quadAuto([0.0, 0.018, -0.08], [0.11, 0.004, -0.08], [0.11, 0.004, 0.08], [0.0, 0.018, 0.08], rgb(0x7a7468), MAT.lit)
    paper.box(-0.08, 0.014, -0.06, -0.01, 0.021, 0.06, rgb(0x32302c), MAT.lit)
    this.paperModel = renderer.addModel(paper)

    // 3. Billowing crumpled polyethylene plastic bag
    const bag = new Mesh()
    bag.prism(0, 0, 0.13, 0.10, 0.01, 0.15, 6, rgb(0x6c7682), MAT.shiny, 0, true, 0.3)
    bag.prism(0.03, 0.02, 0.09, 0.05, 0.11, 0.21, 5, rgb(0x7a8490), MAT.shiny, 0, true, 1.0)
    // Loop handles
    bag.yawBox(0.06, 0.03, 0.07, 0.022, 0.18, 0.24, 0.3, rgb(0x727c88), MAT.lit)
    bag.yawBox(-0.04, -0.03, 0.07, 0.022, 0.17, 0.23, -0.4, rgb(0x727c88), MAT.lit)
    this.bagModel = renderer.addModel(bag)

    // 4. Rolling tin/soda can
    const can = new Mesh()
    can.box(-0.055, 0.0, -0.032, 0.055, 0.064, 0.032, rgb(0x88322a), MAT.shiny)
    can.box(-0.060, 0.004, -0.030, -0.048, 0.060, 0.030, rgb(0x989ea6), MAT.shiny)
    can.box(0.048, 0.004, -0.030, 0.060, 0.060, 0.030, rgb(0x989ea6), MAT.shiny)
    this.canModel = renderer.addModel(can)

    // 5. Swinging picket/yard gate: static hinge post (`gatePostModel`) + pivoting gate leaf (`gateLeafModel`, pivot at x=0, z=0)
    const gPost = new Mesh()
    gPost.box(-0.065, 0.0, -0.065, 0.065, 1.18, 0.065, rgb(0x6e6c62), MAT.timber)
    gPost.box(-0.075, 1.16, -0.075, 0.075, 1.22, 0.075, rgb(0x828076), MAT.lit)
    this.gatePostModel = renderer.addModel(gPost)

    const gLeaf = new Mesh()
    // Horizontal rails extending from hinge (x=0) to x=1.08m
    gLeaf.box(0.04, 0.28, -0.03, 1.06, 0.35, 0.03, rgb(0x76746a), MAT.timber)
    gLeaf.box(0.04, 0.84, -0.03, 1.06, 0.91, 0.03, rgb(0x76746a), MAT.timber)
    // Diagonal brace
    gLeaf.quadAuto([0.06, 0.34, 0.025], [1.02, 0.84, 0.025], [1.02, 0.89, 0.025], [0.06, 0.39, 0.025], rgb(0x6c6a60), MAT.timber)
    // Vertical pickets (with one slightly crooked picket for character)
    for (let i = 0; i < 4; i++) {
      const px = 0.12 + i * 0.25
      const tilt = i === 2 ? 0.08 : 0
      gLeaf.yawBox(px, 0, 0.12, 0.045, 0.08, 1.14, tilt, rgb(0x86847a), MAT.lit)
    }
    // Iron hinge straps
    gLeaf.box(0.0, 0.29, -0.04, 0.22, 0.34, 0.04, rgb(0x2b2f35), MAT.shiny)
    gLeaf.box(0.0, 0.85, -0.04, 0.22, 0.90, 0.04, rgb(0x2b2f35), MAT.shiny)
    this.gateLeafModel = renderer.addModel(gLeaf)

    // 6. Wind-rocking street warning sign: static tilted post (`signPostModel`) + rocking diamond sign plate (`signPlateModel`)
    const sPost = new Mesh()
    sPost.prism(0, 0, 0.08, 0.06, 0.0, 0.12, 6, rgb(0x464a52), MAT.lit)
    sPost.box(-0.024, 0.08, -0.024, 0.024, 2.08, 0.024, rgb(0x4a5058), MAT.shiny)
    this.signPostModel = renderer.addModel(sPost)

    const sPlate = new Mesh()
    // Diamond warning sign plate mounted at y = 1.65..2.18m
    sPlate.yawBox(0, 0.03, 0.44, 0.022, 1.66, 2.12, 0, rgb(0x8c6822), MAT.shiny, 0, rgb(0x9e7628))
    sPlate.yawBox(0, 0.042, 0.30, 0.015, 1.74, 2.04, 0, rgb(0x22252a), MAT.lit)
    this.signPlateModel = renderer.addModel(sPlate)
  }

  reset(): void {
    this.particles.reset()
    this.leafEmitter.reset()
    this.paperEmitter.reset()
  }

  private ensureTracks(town: Town, clutterSeed: number): void {
    const key = `${town.seed}:${clutterSeed}`
    if (this.cachedKey === key) return
    this.cachedKey = key
    this.wallRects = town.barriers.filter(b => b.kind === "wall").map(b => b.rect)
    const rng = new Rng((town.seed ^ (clutterSeed * 0x85ebca6b) ^ 0x27d4eb2d) >>> 0)

    const drifters: DrifterTrack[] = []
    // Curated hero-street drifters so leaves, papers, plastic bags, and cans are visibly moving across the street & sidewalks
    const heroDrifters: readonly [DrifterTrack["kind"], number, number, number, number, number, number, number][] = [
      // Tumbling papers across the street & flashlight cone
      ["paper", 26.8, 42.4, 4.8, 0.9, 1.25, 0.4, 0.95],
      ["paper", 31.2, 43.8, 5.2, 1.1, 1.15, 2.1, 0.90],
      ["paper", 24.5, 45.1, 4.6, 0.8, 1.32, 3.8, 0.88],
      ["paper", 33.8, 41.6, 4.4, 0.7, 1.18, 5.2, 0.92],
      ["paper", 28.2, 38.7, 3.4, 0.4, 0.95, 1.3, 0.85],
      // Billowing plastic bags drifting along road & sidewalk
      ["bag", 25.4, 44.2, 5.6, 1.3, 1.05, 0.9, 0.95],
      ["bag", 32.6, 42.8, 5.0, 1.1, 0.98, 3.4, 0.90],
      ["bag", 22.8, 40.4, 4.2, 0.6, 0.88, 4.9, 0.86],
      ["bag", 29.4, 47.4, 4.8, 0.8, 1.02, 2.6, 0.92],
      // Rolling tin/soda cans in the north & south gutters
      ["can", 27.1, 40.22, 0.85, 0.08, 1.45, 0.7, 0.95],
      ["can", 31.6, 40.20, 0.78, 0.06, 1.35, 2.9, 0.92],
      ["can", 26.4, 47.78, 0.82, 0.07, 1.40, 4.4, 0.94],
      ["can", 20.8, 36.85, 0.65, 0.08, 1.25, 1.8, 0.90],
    ]
    for (const [kind, ax, az, sAlong, sAcross, spd, ph, sc] of heroDrifters) {
      drifters.push({
        kind,
        anchorX: ax,
        anchorZ: az,
        spanAlong: sAlong,
        spanAcross: sAcross,
        speed: spd,
        phase: ph,
        scale: sc,
        liftMax: kind === "bag" ? 0.42 : kind === "paper" ? 0.28 : 0.01,
      })
    }

    // 48 wind-drifting autumn leaves across the hero street, sidewalks, front yard & town roads
    for (let i = 0; i < 48; i++) {
      const inHero = i < 24
      const ax = inHero ? 18.0 + rng.next() * 22.0 : 8.0 + rng.next() * (SIZE - 16.0)
      const az = inHero ? 35.8 + rng.next() * 14.2 : 8.0 + rng.next() * (SIZE - 16.0)
      drifters.push({
        kind: "leaf",
        anchorX: ax,
        anchorZ: az,
        spanAlong: 3.2 + rng.next() * 4.5,
        spanAcross: 0.6 + rng.next() * 1.2,
        speed: 0.95 + rng.next() * 0.85,
        phase: rng.next() * Math.PI * 2,
        scale: 0.75 + rng.next() * 0.55,
        liftMax: 0.22 + rng.next() * 0.38,
      })
    }

    // Town-wide papers, plastic bags & gutter cans
    for (let i = 0; i < 28; i++) {
      const onEW = rng.next() < 0.65
      const ax = onEW ? 8.0 + rng.next() * (SIZE - 16.0) : 38.5 + rng.next() * 11.0
      const az = onEW ? 38.5 + rng.next() * 11.0 : 8.0 + rng.next() * (SIZE - 16.0)
      const pick = rng.next()
      const kind: DrifterTrack["kind"] = pick < 0.52 ? "paper" : pick < 0.80 ? "bag" : "can"
      drifters.push({
        kind,
        anchorX: ax,
        anchorZ: az,
        spanAlong: kind === "can" ? 0.75 : 4.2 + rng.next() * 3.5,
        spanAcross: kind === "can" ? 0.08 : 0.7 + rng.next() * 1.1,
        speed: 0.90 + rng.next() * 0.65,
        phase: rng.next() * Math.PI * 2,
        scale: 0.80 + rng.next() * 0.35,
        liftMax: kind === "bag" ? 0.38 : kind === "paper" ? 0.24 : 0.01,
      })
    }
    this.drifters = drifters

    // Swinging gates & wind-rocking street signs (placed safely off walk paths so they never obstruct navigation)
    this.hinges = [
      // Front-yard / side-fence swinging picket gates
      { kind: "gate", x: 18.12, z: 38.05, baseYaw: 0.38, amp: 0.34, freq: 1.45, phase: 0.5 },
      { kind: "gate", x: 25.45, z: 38.02, baseYaw: -0.42, amp: 0.28, freq: 1.65, phase: 2.1 },
      { kind: "gate", x: 18.12, z: 68.05, baseYaw: 0.35, amp: 0.32, freq: 1.50, phase: 1.4 },
      // Tilted street warning signs at curb corners
      { kind: "sign", x: 35.35, z: 39.52, baseYaw: -0.25, amp: 0.22, freq: 2.35, phase: 0.8 },
      { kind: "sign", x: 39.42, z: 48.48, baseYaw: 2.85, amp: 0.24, freq: 2.15, phase: 3.2 },
      { kind: "sign", x: 50.45, z: 39.52, baseYaw: -0.35, amp: 0.20, freq: 2.45, phase: 1.9 },
    ]
  }

  stepAndCollect(
    dt: number,
    time: number,
    town: Town,
    player: { x: number; y: number; aim: number; flashlightOn: boolean; flashlightOutput: number },
    view: readonly [number, number, number, number],
    settings: Pick<GroundSettings, "motionStrength" | "windGustiness" | "clutterDensity" | "clutterSeed">,
    alphaSprites: Float32Array,
    startAlphaCount: number,
  ): { batches: Batch[]; alphaCount: number } {
    this.ensureTracks(town, settings.clutterSeed)
    const motion = Math.max(0, settings.motionStrength)
    const gustiness = Math.max(0, settings.windGustiness)
    const density = Math.max(0, settings.clutterDensity)
    const [vx0, vy0, vx1, vy1] = view

    // 1. Step shared `@arcade/kit/fx/particles` (`Particles` + `Emitter`) for live wind-gust births
    if (dt > 0 && motion > 0.01 && density > 0.01) {
      const gustHere = evaluateWindGust(time, player.x, player.y, gustiness)
      const effDt = dt * motion
      this.leafEmitter.step(
        player.x - WIND_DIR_X * 8.0,
        0.35,
        player.y - WIND_DIR_Z * 8.0,
        effDt,
        2.8 * density * gustHere,
        "rate",
        (ex, ey, ez) => {
          const s = (this.emitSeed = (this.emitSeed * 1664525 + 1013904223) >>> 0)
          const u1 = ((s & 0xffff) / 0xffff) - 0.5
          const u2 = (((s >>> 16) & 0xffff) / 0xffff) - 0.5
          const sx = ex + u1 * 18.0
          const sz = ez + u2 * 14.0
          const vx = (WIND_DIR_X * (2.2 + gustHere * 1.4) + CROSS_DIR_X * u1 * 1.2) * motion
          const vz = (WIND_DIR_Z * (2.2 + gustHere * 1.4) + CROSS_DIR_Z * u2 * 1.2) * motion
          const vy = 0.35 + Math.abs(u1) * 0.65
          this.particles.spawn(LEAF_PARTICLE_SPEC, sx, supportHeight(town, sx, sz) + ey, sz, vx, vy, vz, s & 1023)
        },
      )
      this.paperEmitter.step(
        player.x - WIND_DIR_X * 6.0,
        0.18,
        player.y - WIND_DIR_Z * 6.0,
        effDt,
        0.9 * density * gustHere,
        "rate",
        (ex, ey, ez) => {
          const s = (this.emitSeed = (this.emitSeed * 1664525 + 1013904223) >>> 0)
          const u1 = ((s & 0xffff) / 0xffff) - 0.5
          const u2 = (((s >>> 16) & 0xffff) / 0xffff) - 0.5
          const sx = ex + u1 * 16.0
          const sz = ez + u2 * 12.0
          const vx = (WIND_DIR_X * (1.8 + gustHere * 1.2) + CROSS_DIR_X * u2 * 0.9) * motion
          const vz = (WIND_DIR_Z * (1.8 + gustHere * 1.2) + CROSS_DIR_Z * u1 * 0.9) * motion
          this.particles.spawn(PAPER_PARTICLE_SPEC, sx, supportHeight(town, sx, sz) + ey, sz, vx, 0.25, vz, s & 1023)
        },
      )
      this.particles.update(effDt, this.wallRects, (x, z) => supportHeight(town, x, z))
    }

    let leafCount = 0
    let paperCount = 0
    let bagCount = 0
    let canCount = 0
    let gateCount = 0
    let signCount = 0

    const effTime = (time + 4.2) * (0.15 + 0.85 * motion)

    // 2. Evaluate deterministic wind-gust drifter tracks (leaves, papers, plastic bags, rolling cans)
    const maxTracks = Math.min(this.drifters.length, Math.round(this.drifters.length * Math.min(1.5, Math.max(0.25, density))))
    for (let i = 0; i < maxTracks; i++) {
      const tr = this.drifters[i]!
      if (tr.anchorX < vx0 - 6 || tr.anchorX > vx1 + 6 || tr.anchorZ < vy0 - 6 || tr.anchorZ > vy1 + 6) continue
      const gust = evaluateWindGust(effTime, tr.anchorX, tr.anchorZ, gustiness)
      const ph = effTime * tr.speed + tr.phase

      if (tr.kind === "can") {
        // Back-and-forth wind-driven roll along the gutter
        const rollDisp = (Math.sin(ph * 1.4) * 0.65 + Math.sin(ph * 0.55 + 1.1) * 0.35) * tr.spanAlong * Math.min(1.5, motion)
        const x = tr.anchorX + rollDisp
        const z = tr.anchorZ + Math.cos(ph * 1.9) * tr.spanAcross * Math.min(1.2, motion)
        if (x < vx0 - 1 || x > vx1 + 1 || z < vy0 - 1 || z > vy1 + 1) continue
        if (canCount >= 32) continue
        const y = supportHeight(town, x, z) + 0.004
        const o = canCount++ * INST_FLOATS
        this.canData[o] = x
        this.canData[o + 1] = y
        this.canData[o + 2] = z
        this.canData[o + 3] = 0.12 + Math.sin(ph * 0.7) * 0.18
        this.canData[o + 4] = 1
        this.canData[o + 5] = 1
        this.canData[o + 6] = 1
        this.canData[o + 7] = tr.scale
        this.canData[o + 8] = 0
        this.canData[o + 9] = rollDisp * 14.0
        this.canData[o + 10] = 1
        this.canData[o + 11] = 0
        continue
      }

      // Sawtooth-smoothed wind travel with gust acceleration & eddy swirl
      const cyc = (ph * 0.22) % 1
      const uTravel = (cyc < 0 ? cyc + 1 : cyc) - 0.5
      const gustSurge = Math.sin(ph * 1.65) * 0.22 * gust
      const along = (uTravel * tr.spanAlong + gustSurge) * (0.25 + 0.75 * Math.min(1.6, motion))
      const across = Math.sin(ph * 1.85 + tr.phase) * tr.spanAcross * (0.4 + 0.6 * gust) * Math.min(1.5, motion)

      const x = tr.anchorX + WIND_DIR_X * along + CROSS_DIR_X * across
      const z = tr.anchorZ + WIND_DIR_Z * along + CROSS_DIR_Z * across
      if (x < vx0 - 1 || x > vx1 + 1 || z < vy0 - 1 || z > vy1 + 1) continue

      const groundY = supportHeight(town, x, z)
      // Lift off the ground during wind gusts, skitter along ground in lulls
      const liftWave = Math.max(0, Math.sin(ph * 2.1 + tr.phase * 0.7) * 0.7 + (gust - 0.75) * 0.6)
      const edgeFade = 1 - Math.pow(Math.abs(uTravel) * 2, 4)
      const lift = tr.liftMax * liftWave * edgeFade * Math.min(1.6, motion)
      const y = groundY + 0.012 + lift

      const yaw = tr.phase + ph * (tr.kind === "bag" ? 1.15 : 2.1) * Math.min(1.5, motion)
      const pitch = Math.sin(ph * 3.1 + tr.phase) * (0.22 + 0.65 * liftWave) * Math.min(1.5, motion)
      const roll = Math.cos(ph * 2.7 - tr.phase) * (0.25 + 0.70 * liftWave) * Math.min(1.5, motion)

      if (tr.kind === "leaf") {
        if (leafCount >= 128) continue
        const o = leafCount++ * INST_FLOATS
        this.leafData[o] = x
        this.leafData[o + 1] = y
        this.leafData[o + 2] = z
        this.leafData[o + 3] = yaw
        this.leafData[o + 4] = 1
        this.leafData[o + 5] = 1
        this.leafData[o + 6] = 1
        this.leafData[o + 7] = tr.scale
        this.leafData[o + 8] = pitch
        this.leafData[o + 9] = roll
        this.leafData[o + 10] = 1
        this.leafData[o + 11] = 0
      } else if (tr.kind === "paper") {
        if (paperCount >= 64) continue
        const o = paperCount++ * INST_FLOATS
        this.paperData[o] = x
        this.paperData[o + 1] = y
        this.paperData[o + 2] = z
        this.paperData[o + 3] = yaw
        this.paperData[o + 4] = 1
        this.paperData[o + 5] = 1
        this.paperData[o + 6] = 1
        this.paperData[o + 7] = tr.scale
        this.paperData[o + 8] = pitch
        this.paperData[o + 9] = roll
        this.paperData[o + 10] = 1
        this.paperData[o + 11] = 0
      } else {
        if (bagCount >= 32) continue
        const billow = tr.scale * (0.92 + 0.16 * Math.sin(ph * 3.4) * Math.min(1.5, gust))
        const o = bagCount++ * INST_FLOATS
        this.bagData[o] = x
        this.bagData[o + 1] = y
        this.bagData[o + 2] = z
        this.bagData[o + 3] = yaw
        this.bagData[o + 4] = 1
        this.bagData[o + 5] = 1
        this.bagData[o + 6] = 1
        this.bagData[o + 7] = billow
        this.bagData[o + 8] = pitch * 0.65
        this.bagData[o + 9] = roll * 0.65
        this.bagData[o + 10] = 1
        this.bagData[o + 11] = 0
      }
    }

    // 3. Also append live `Particles` births into the 3D leaf & paper instance buffers
    const pData = this.particles.data
    for (let n = 0; n < this.particles.count; n++) {
      const idx = n * 24
      const px = pData[idx]!
      const py = pData[idx + 1]!
      const pz = pData[idx + 2]!
      if (px < vx0 - 1 || px > vx1 + 1 || pz < vy0 - 1 || pz > vy1 + 1) continue
      const pSize = pData[idx + 3]!
      const age = pData[idx + 7]!
      const seed = pData[idx + 18]!
      const yaw = seed + age * 3.2
      const pitch = Math.sin(age * 5.4 + seed) * 0.55
      const roll = Math.cos(age * 4.8 + seed) * 0.55
      if (pSize > 0.12) {
        if (paperCount < 64) {
          const o = paperCount++ * INST_FLOATS
          this.paperData.set([px, py, pz, yaw, 1, 1, 1, 0.85, pitch, roll, 1, 0], o)
        }
      } else if (leafCount < 128) {
        const o = leafCount++ * INST_FLOATS
        this.leafData.set([px, py, pz, yaw, 1, 1, 1, 0.90, pitch, roll, 1, 0], o)
      }
    }

    // 4. Evaluate wind-swinging gates & wind-rocking street signs
    for (const h of this.hinges) {
      if (h.x < vx0 - 2 || h.x > vx1 + 2 || h.z < vy0 - 2 || h.z > vy1 + 2) continue
      const y = supportHeight(town, h.x, h.z)
      const gust = evaluateWindGust(effTime, h.x, h.z, gustiness)
      const osc =
        (Math.sin(effTime * h.freq + h.phase) * 0.68 + Math.sin(effTime * h.freq * 2.1 + h.phase * 1.7) * 0.32) *
        h.amp *
        (0.45 + 0.55 * gust) *
        Math.min(1.8, motion)

      if (h.kind === "gate") {
        if (gateCount >= 16) continue
        const o = gateCount++ * INST_FLOATS
        this.gatePostData.set([h.x, y, h.z, h.baseYaw, 1, 1, 1, 1, 0, 0, 1, 0], o)
        this.gateLeafData.set([h.x, y, h.z, h.baseYaw + osc, 1, 1, 1, 1, 0, 0, 1, 0], o)
      } else {
        if (signCount >= 16) continue
        const o = signCount++ * INST_FLOATS
        const postLean = 0.08
        this.signPostData.set([h.x, y, h.z, h.baseYaw, 1, 1, 1, 1, postLean, -0.05, 1, 0], o)
        this.signPlateData.set([h.x, y, h.z, h.baseYaw + osc * 1.25, 1, 1, 1, 1, postLean, -0.05 + osc * 0.45, 1, 0], o)
      }
    }

    // 5. Optional subtle dust motes drifting in porch, streetlamp & flashlight pools
    let alphaCount = startAlphaCount
    const maxAlpha = Math.floor(alphaSprites.length / SPRITE_FLOATS)
    if (motion > 0.05 && density > 0.1) {
      for (let m = 0; m < 18 && alphaCount < maxAlpha; m++) {
        const ph = m * 2.39996 + settings.clutterSeed * 0.71
        const inBeam = m < 10 && player.flashlightOn && player.flashlightOutput > 0.1
        const dist = inBeam ? 1.4 + (m / 10) * 5.2 : 0.6 + ((m - 10) / 8) * 2.4
        const spread = Math.sin(effTime * 0.55 + ph) * (inBeam ? 0.85 : 1.15)
        const baseX = inBeam ? player.x + Math.cos(player.aim) * dist - Math.sin(player.aim) * spread : 27.7 + spread
        const baseZ = inBeam ? player.y + Math.sin(player.aim) * dist + Math.cos(player.aim) * spread : 36.6 + Math.cos(effTime * 0.42 + ph) * 1.4
        if (baseX < vx0 || baseX > vx1 || baseZ < vy0 || baseZ > vy1) continue
        const my = supportHeight(town, baseX, baseZ) + 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(effTime * 0.75 + ph * 1.9))
        const pulse = (0.5 + 0.5 * Math.sin(effTime * 1.6 + ph * 3.1)) * Math.min(1.2, motion)
        const o = alphaCount++ * SPRITE_FLOATS
        alphaSprites[o] = baseX
        alphaSprites[o + 1] = my
        alphaSprites[o + 2] = baseZ
        alphaSprites[o + 3] = 0.032 + (m % 3) * 0.008
        alphaSprites[o + 4] = inBeam ? 0.78 : 0.95
        alphaSprites[o + 5] = inBeam ? 0.82 : 0.74
        alphaSprites[o + 6] = inBeam ? 0.88 : 0.48
        alphaSprites[o + 7] = 0.038 * pulse * (inBeam ? player.flashlightOutput : 0.8)
        alphaSprites[o + 8] = 0
        alphaSprites[o + 9] = 0
        alphaSprites[o + 10] = 1
        alphaSprites[o + 11] = 0
      }
    }

    const batches: Batch[] = []
    if (leafCount > 0) batches.push({ model: this.leafModel, data: this.leafData, count: leafCount })
    if (paperCount > 0) batches.push({ model: this.paperModel, data: this.paperData, count: paperCount })
    if (bagCount > 0) batches.push({ model: this.bagModel, data: this.bagData, count: bagCount })
    if (canCount > 0) batches.push({ model: this.canModel, data: this.canData, count: canCount })
    if (gateCount > 0) {
      batches.push({ model: this.gatePostModel, data: this.gatePostData, count: gateCount })
      batches.push({ model: this.gateLeafModel, data: this.gateLeafData, count: gateCount })
    }
    if (signCount > 0) {
      batches.push({ model: this.signPostModel, data: this.signPostData, count: signCount })
      batches.push({ model: this.signPlateModel, data: this.signPlateData, count: signCount })
    }

    return { batches, alphaCount }
  }
}
