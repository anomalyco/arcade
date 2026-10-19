import * as THREE from "three/webgpu"
import { createCreatureMaterial } from "../kit/material"
import { buildCreature, loadCreatureData, type CreatureRig } from "../kit/runtime"
import { WendigoAnimator, type WendigoMode, type WendigoStance } from "./animate"

// The Wendigo, built from scratch: SDF anatomy baked to public/models/monsters/wendigo.bin (see build.ts), one skinned
// mesh with a procedural TSL material, and fully procedural motion (animate.ts).
//
//   const w = createWendigo({ ground: (x, z) => heightAt(x, z) })
//   scene.add(w.root)
//   await w.ready
//   w.update(dt, { mode: "stalk", target: player.position })              // on all fours
//   w.update(dt, { mode: "stalk-upright", target: player.position })      // walking upright (or stalk + stance "biped")
//   w.update(dt, { mode: "drop" })                                         // back down to all fours
//
// `velocity` is the world velocity the caller is moving `root` with. Leave it out and the Wendigo moves itself:
// it stalks toward `target` (or straight ahead), lunges forward, and turns to face the target when idle.

export type { WendigoMode, WendigoStance }

export type WendigoOpts = {
  /** Ground height under a point (feet plant on it). Default flat y = 0. */
  ground?: (x: number, z: number) => number
  /** Override the baked mesh URL. */
  url?: string
  /** Uniform scale (1 = 3.5 m reared, ~1.6 m at the shoulder). */
  scale?: number
  seed?: number
}

/** `stance` picks all fours or upright for idle/stalk/freeze/lunge; omit to keep the current one (see animate.ts). */
export type WendigoUpdate = { mode: WendigoMode; stance?: WendigoStance; target?: THREE.Vector3; velocity?: THREE.Vector3 }

export type Wendigo = {
  root: THREE.Object3D
  update(dt: number, s: WendigoUpdate): void
  ready: Promise<void>
  /** Current stance ("quad" until ready). */
  readonly stance: WendigoStance
  /** Available once ready. */
  rig: CreatureRig | null
  animator: WendigoAnimator | null
}

export function createWendigo(opts: WendigoOpts = {}): Wendigo {
  const root = new THREE.Group()
  root.name = "wendigo"
  const out: Wendigo = {
    root,
    rig: null,
    animator: null,
    update(dt, s) {
      out.animator?.update(dt, s)
    },
    ready: Promise.resolve(),
    get stance() {
      return out.animator?.stance ?? "quad"
    },
  }
  const url = opts.url ?? `${import.meta.env.BASE_URL}models/monsters/wendigo.bin`
  out.ready = (async () => {
    const data = await loadCreatureData(url, async () => (await import("./build")).generateWendigo())
    const { material, uniforms } = createCreatureMaterial()
    const rig = buildCreature(data, material)
    rig.root.scale.setScalar(opts.scale ?? 1)
    root.add(rig.root)
    out.rig = rig
    out.animator = new WendigoAnimator(rig, root, opts.ground ?? (() => 0), opts.seed ?? 1)
    out.animator.sway = uniforms.sway
  })()
  return out
}
