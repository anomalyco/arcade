/**
 * Realistic people for any kit game: lazy-loaded MakeHuman cast (CC0) skinned on the GPU, walking and running with
 * mocap cycles (`gait.ts`) and standing with the shared human rig. A game keeps its avatars and `animate` calls; it
 * feeds them rig-space positions (`world / scale`) and hands each posed avatar to `People.drive`, which picks the
 * gait, adds terrain under each foot, poses the skeleton and returns the held torch's frame. See docs/people.md.
 */
import { WebIO } from "@gltf-transform/core"
import { ALL_EXTENSIONS } from "@gltf-transform/extensions"
import { MeshoptDecoder } from "meshoptimizer"
import type { PassContext } from "../gpu/pass-graph"
import type { SceneHooks } from "../gpu/shaders"
import type { HumanBody } from "../human-pose"
import type { Locomotion } from "../human-locomotion"
import { spring, type Frame, type Spring, type V3 } from "../rig"
import { readPerson } from "./asset"
import { personHooks, type PeopleLook } from "./hooks"
import { PeoplePass, type PersonInstance, type PersonModel } from "./pass"
import { newPose, personRest, posePerson, skinMatrices, type HandPose, type PersonPose, type PersonRest } from "./retarget"
import { terrainFeet, type TerrainLoco, type TerrainState } from "./terrain"
import { gaitBody, newGait, type GaitState } from "./gait"

/**
 * One person in one look (`a-woods`, `c-office`, ...): a GLB from scripts/people/cast.json. Each look's members come
 * from its own generated module (`@arcade/kit/people/cast/woods`), so a game bundles only the looks it imports.
 */
export type CastMember = { readonly id: string; readonly url: string; readonly person: string; readonly look: string; readonly outfit: string }

type Loaded = { model: PersonModel; rest: PersonRest }

export type Person = {
  readonly cast: CastMember
  readonly inst: PersonInstance
  readonly rest: PersonRest
  readonly pose: PersonPose
  readonly terrain: TerrainState
  readonly gait: GaitState
  breath: Spring
  /** Standing idle: how still (0 moving .. 1 stood a while), its weight-shift phase and this person's rate. */
  idle: { still: number; phase: number; rate: number }
}

export type DriveOptions = {
  dt: number
  /** Seconds, for breathing. */
  time: number
  /** World ground height. Omit for a flat floor at y = 0. */
  ground?: (x: number, z: number) => number
  /** Whole-body rise above the terrain, e.g. an authoritative hop. Does not move foot-support springs. */
  rise?: number
  torch?: { side: 0 | 1; dir: V3 }
  look?: { yaw: number; pitch: number }
  grip?: [HandPose | null, HandPose | null]
  /** Camera position, for the level of detail. */
  eye?: V3
  /** "mocap" (default): walk and run with mocap cycles; "rig": the procedural rig's gait throughout. */
  gait?: "mocap" | "rig"
}

/**
 * Level of detail for a posed person seen from `eye`: 1 beyond `distance` from the pelvis (the bone that carries the
 * person's world transform; the skeleton root stays at its bind position), with 10% hysteresis.
 */
export function personLod(rest: PersonRest, pose: PersonPose, eye: V3, current: number, distance: number): number {
  const h = pose.pos[rest.idx.pelvis!]!
  const d = Math.hypot(h[0] - eye[0], h[1] - eye[1], h[2] - eye[2])
  return d > distance * (current === 1 ? 0.9 : 1) ? 1 : 0
}

const bothPlanted = (a: TerrainLoco) => a.feet[0].planted && a.feet[1].planted

/**
 * Standing weight shift (`PoseInput.shift`): after about a second stood still the person settles onto one leg,
 * dwells there 3 to 5 s and shifts across in about a second, at a rate of their own. Any step or movement eases it out
 * within a quarter second, so it never fights the rig's steps.
 */
export function idleShift(idle: Person["idle"], speed: number, planted: boolean, dt: number): number {
  const stood = planted && speed < 0.08
  const k = stood ? 1 - Math.exp(-dt / 0.9) : 1 - Math.exp(-dt / 0.12)
  idle.still += ((stood ? 1 : 0) - idle.still) * k
  // A full cycle (left, across, right, across) every ~9 s at rate 1.
  if (stood) idle.phase += dt * idle.rate * ((Math.PI * 2) / 9)
  const dwell = Math.tanh(2.4 * Math.sin(idle.phase)) / Math.tanh(2.4)
  return dwell * idle.still * idle.still
}

export class People {
  readonly pass: PeoplePass
  private loads = new Map<CastMember, Promise<Loaded>>()
  private ready = new Map<CastMember, Loaded>()
  private spawned = 0

  /**
   * `material` is `MAT.lit` (lit only by the scene) unless a game wants its actors' fill and rim (`MAT.actor`);
   * `look` sets roughness per kind and the optional ambient sheen.
   */
  constructor(ctx: PassContext, hooks: SceneHooks, readonly lodDistance = 9, opts: { material?: number; look?: PeopleLook } = {}) {
    this.pass = new PeoplePass(ctx, personHooks(hooks, opts.look), opts.material)
  }

  /** Starts fetching a cast member; resolves when it can be drawn. Safe to call repeatedly. */
  load(cast: CastMember): Promise<Loaded> {
    let p = this.loads.get(cast)
    if (!p) {
      p = (async () => {
        await MeshoptDecoder.ready
        const io = new WebIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder })
        const res = await fetch(cast.url)
        if (!res.ok) throw new Error(`${cast}: HTTP ${res.status}`)
        const asset = readPerson(await io.readBinary(new Uint8Array(await res.arrayBuffer())), cast.id)
        const loaded = { model: await this.pass.upload(asset), rest: personRest(asset.skeleton) }
        this.ready.set(cast, loaded)
        return loaded
      })()
      this.loads.set(cast, p)
    }
    return p
  }

  /** Rig scale of a loaded cast member (world = rig × scale), or null while it loads. */
  scale(cast: CastMember): number | null {
    return this.ready.get(cast)?.rest.scale ?? null
  }

  /** A new person, or null until the cast member has loaded (call `load` first). */
  spawn(cast: CastMember): Person | null {
    const l = this.ready.get(cast)
    if (!l) return null
    return { cast, inst: this.pass.spawn(l.model), rest: l.rest, pose: newPose(l.rest), terrain: { drop: spring(), init: false }, gait: newGait(), breath: { x: (this.spawned * 2.39996) % (Math.PI * 2), v: 0 },
      idle: { still: 0, phase: (this.spawned * 1.7) % (Math.PI * 2), rate: 0.75 + ((this.spawned++ * 0.618034) % 1) * 0.5 } }
  }

  remove(p: Person): void {
    this.pass.remove(p.inst)
  }

  /**
   * Poses a person from an avatar the rig animated in rig space (positions = world / `person.rest.scale`), lifts it
   * onto the ground under each foot and uploads its joints. Returns the torch frame (world) if it holds one.
   */
  drive(p: Person, a: Locomotion & { body: HumanBody | null; reach?: { l?: V3; r?: V3; k: number } }, o: DriveOptions): Frame | null {
    if (!a.body) { p.inst.visible = false; return null }
    p.inst.visible = true
    const ground = o.ground ?? (() => 0)
    const { body, loco }: { body: HumanBody; loco: TerrainLoco } = o.gait === "rig" ? { body: a.body, loco: a } : gaitBody(p.gait, a, a.body, p.rest.scale, o.dt)
    const { lift, feet, tilt } = terrainFeet(p.terrain, loco, body, p.rest.scale, ground, o.dt, p.rest.sole)
    // Breathing: ~15 breaths/min standing, faster when moving.
    const speed = Math.hypot(a.svx, a.svy) * p.rest.scale
    p.breath.x += o.dt * Math.PI * 2 * (0.25 + 0.12 * Math.min(1, speed / 3))
    posePerson(p.rest, {
      body, lift: lift + (o.rise ?? 0), feet, tilt, torch: o.torch, look: o.look, grip: o.grip,
      breath: 1, breathPhase: p.breath.x, shift: idleShift(p.idle, speed, bothPlanted(loco), o.dt), dt: o.dt,
    }, p.pose)
    skinMatrices(p.rest, p.pose, p.inst.matrices)
    if (o.eye) p.inst.lod = personLod(p.rest, p.pose, o.eye, p.inst.lod, this.lodDistance)
    return p.pose.torch
  }

  dispose(): void {
    this.pass.dispose()
    for (const l of this.ready.values()) l.model.dispose()
  }
}
