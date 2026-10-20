import * as THREE from "three/webgpu"
import { createCreatureMaterial } from "../kit/material"
import { buildCreature, loadCreatureData, type CreatureRig } from "../kit/runtime"
/** Must match build.ts BAKE_VERSION (kept here so the game doesn't import the generator). */
const WENDIGO_BAKE_VERSION = 4
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
/** `ceiling`: world Y of the ceiling over it indoors; it stoops (upright) or crouches (all fours) to fit its antlers under. */
export type WendigoUpdate = { mode: WendigoMode; stance?: WendigoStance; target?: THREE.Vector3; velocity?: THREE.Vector3; ceiling?: number }

export type Wendigo = {
  root: THREE.Object3D
  update(dt: number, s: WendigoUpdate): void
  ready: Promise<void>
  /** Current stance ("quad" until ready). */
  readonly stance: WendigoStance
  /** Available once ready. */
  rig: CreatureRig | null
  animator: WendigoAnimator | null
  /** 0..1 overall shade of the body (1 normal): darken it when it fills the lens. */
  setShade(v: number): void
  /** The close-up cut's uniforms (see kit/material.ts), set by death scenes. */
  cut: { cutOn: { value: number }; cutDir: { value: THREE.Vector3 }; cutCos: { value: number }; cutDist: { value: number }; nearCut: { value: number } } | null
}

export function createWendigo(opts: WendigoOpts = {}): Wendigo {
  const root = new THREE.Group()
  root.name = "wendigo"
  let shadeU: { value: number } | null = null
  const out: Wendigo = {
    root,
    rig: null,
    animator: null,
    update(dt, s) {
      out.animator?.update(dt, s)
    },
    ready: Promise.resolve(),
    cut: null,
    setShade(v) {
      if (shadeU) shadeU.value = v
    },
    get stance() {
      return out.animator?.stance ?? "quad"
    },
  }
  const url = opts.url ?? `${import.meta.env.BASE_URL}models/monsters/wendigo.bin`
  out.ready = (async () => {
    const data = await loadCreatureData(url, {
      version: WENDIGO_BAKE_VERSION,
      generate: () => new Worker(new URL("./generate.worker.ts", import.meta.url), { type: "module" }),
    })
    // Nothing usable: no creature (callers check `rig`); never generated on the main thread.
    if (!data) return
    const { material, uniforms } = createCreatureMaterial()
    const rig = buildCreature(data, material)
    rig.root.scale.setScalar(opts.scale ?? 1)
    root.add(rig.root)
    out.rig = rig
    out.animator = new WendigoAnimator(rig, root, opts.ground ?? (() => 0), opts.seed ?? 1)
    out.animator.sway = uniforms.sway
    shadeU = uniforms.shade
    out.cut = { cutOn: uniforms.cutOn, cutDir: uniforms.cutDir, cutCos: uniforms.cutCos, cutDist: uniforms.cutDist, nearCut: uniforms.nearCut }
  })()
  return out
}
