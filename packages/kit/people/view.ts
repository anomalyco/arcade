/**
 * Realistic people for any kit game: lazy-loaded MakeHuman cast (CC0) skinned on the GPU and driven by the shared
 * human rig. A game keeps its avatars and `animate` calls; it feeds them rig-space positions (`world / scale`) and
 * hands each posed avatar to `People.drive`, which adds terrain under each foot, poses the skeleton and returns the
 * held torch's frame. See docs/people.md.
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
import { personHooks } from "./hooks"
import { PeoplePass, type PersonInstance, type PersonModel } from "./pass"
import { newPose, personRest, posePerson, skinMatrices, type HandPose, type PersonPose, type PersonRest } from "./retarget"
import { terrainFeet, type TerrainState } from "./terrain"

/** The cast: one GLB per person (scripts/people/cast.json). Vite emits each as a lazily fetched asset. */
export const PEOPLE_CAST = {
  "hiker-a": new URL("./assets/hiker-a.glb", import.meta.url).href,
} as const
export type CastId = keyof typeof PEOPLE_CAST

type Loaded = { model: PersonModel; rest: PersonRest }

export type Person = {
  readonly cast: CastId
  readonly inst: PersonInstance
  readonly rest: PersonRest
  readonly pose: PersonPose
  readonly terrain: TerrainState
  breath: Spring
}

export type DriveOptions = {
  dt: number
  /** Seconds, for breathing. */
  time: number
  /** World ground height. Omit for a flat floor at y = 0. */
  ground?: (x: number, z: number) => number
  torch?: { side: 0 | 1; dir: V3 }
  look?: { yaw: number; pitch: number }
  grip?: [HandPose | null, HandPose | null]
  /** Camera position, for the level of detail. */
  eye?: V3
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

export class People {
  readonly pass: PeoplePass
  private loads = new Map<CastId, Promise<Loaded>>()
  private ready = new Map<CastId, Loaded>()
  private spawned = 0

  constructor(ctx: PassContext, hooks: SceneHooks, readonly lodDistance = 9) {
    this.pass = new PeoplePass(ctx, personHooks(hooks))
  }

  /** Starts fetching a cast member; resolves when it can be drawn. Safe to call repeatedly. */
  load(cast: CastId): Promise<Loaded> {
    let p = this.loads.get(cast)
    if (!p) {
      p = (async () => {
        await MeshoptDecoder.ready
        const io = new WebIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder })
        const res = await fetch(PEOPLE_CAST[cast])
        if (!res.ok) throw new Error(`${cast}: HTTP ${res.status}`)
        const asset = readPerson(await io.readBinary(new Uint8Array(await res.arrayBuffer())), cast)
        const loaded = { model: await this.pass.upload(asset), rest: personRest(asset.skeleton) }
        this.ready.set(cast, loaded)
        return loaded
      })()
      this.loads.set(cast, p)
    }
    return p
  }

  /** Rig scale of a loaded cast member (world = rig × scale), or null while it loads. */
  scale(cast: CastId): number | null {
    return this.ready.get(cast)?.rest.scale ?? null
  }

  /** A new person, or null until the cast member has loaded (call `load` first). */
  spawn(cast: CastId): Person | null {
    const l = this.ready.get(cast)
    if (!l) return null
    return { cast, inst: this.pass.spawn(l.model), rest: l.rest, pose: newPose(l.rest), terrain: { drop: spring(), init: false }, breath: { x: (this.spawned++ * 2.39996) % (Math.PI * 2), v: 0 } }
  }

  remove(p: Person): void {
    this.pass.remove(p.inst)
  }

  /**
   * Poses a person from an avatar the rig animated in rig space (positions = world / `person.rest.scale`), lifts it
   * onto the ground under each foot and uploads its joints. Returns the torch frame (world) if it holds one.
   */
  drive(p: Person, a: Locomotion & { body: HumanBody | null }, o: DriveOptions): Frame | null {
    if (!a.body) { p.inst.visible = false; return null }
    p.inst.visible = true
    const ground = o.ground ?? (() => 0)
    const { lift, feet, tilt } = terrainFeet(p.terrain, a, a.body, p.rest.scale, ground, o.dt)
    // Breathing: ~15 breaths/min standing, faster when moving.
    const speed = Math.hypot(a.svx, a.svy) * p.rest.scale
    p.breath.x += o.dt * Math.PI * 2 * (0.25 + 0.12 * Math.min(1, speed / 3))
    posePerson(p.rest, {
      body: a.body, lift, feet, tilt, torch: o.torch, look: o.look, grip: o.grip,
      breath: 1, breathPhase: p.breath.x,
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

