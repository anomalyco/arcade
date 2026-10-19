import * as THREE from "three/webgpu"
import { createCreatureMaterial, type CreaturePalette } from "../kit/material"
import { buildCreature, loadCreatureData, type CreatureRig } from "../kit/runtime"
import { BansheeAnimator, type BansheeMode } from "./animate"

// The Banshee, built from scratch: SDF anatomy, hair and shroud baked to public/models/monsters/banshee.bin (see
// build.ts), one skinned mesh with three material slots (body, hair, shroud), fully procedural motion (animate.ts).
//
//   const b = createBanshee()
//   scene.add(b.root)            // root sits on the ground; the creature hangs ~0.15–2.95 m above it
//   await b.ready
//   b.update(dt, { mode: "drift", target: player.position })
//
// `velocity` is the world velocity the caller moves `root` with; leave it out and the Banshee moves itself.

export type { BansheeMode }
export type BansheeUpdate = { mode: BansheeMode; target?: THREE.Vector3; velocity?: THREE.Vector3 }
export type BansheeOpts = { url?: string; scale?: number; seed?: number }
export type Banshee = {
  root: THREE.Object3D
  update(dt: number, s: BansheeUpdate): void
  ready: Promise<void>
  rig: CreatureRig | null
  animator: BansheeAnimator | null
}

const SKIN: CreaturePalette = {
  skin: new THREE.Color(0.36, 0.35, 0.34),
  skinRaw: new THREE.Color(0.3, 0.22, 0.22),
  skinDark: new THREE.Color(0.06, 0.055, 0.055),
  bone: new THREE.Color(0.45, 0.43, 0.39),
  horn: new THREE.Color(0.02, 0.016, 0.014),
  hornLight: new THREE.Color(0.1, 0.085, 0.075),
}
const HAIR: CreaturePalette = {
  skin: new THREE.Color(0.34, 0.34, 0.33),
  skinRaw: new THREE.Color(0.28, 0.27, 0.25),
  skinDark: new THREE.Color(0.12, 0.12, 0.115),
  bone: new THREE.Color(0.5, 0.48, 0.43),
  horn: new THREE.Color(0.3, 0.28, 0.25),
  hornLight: new THREE.Color(0.5, 0.48, 0.43),
}
const SHROUD: CreaturePalette = {
  skin: new THREE.Color(0.36, 0.355, 0.33),
  skinRaw: new THREE.Color(0.26, 0.24, 0.19),
  skinDark: new THREE.Color(0.15, 0.14, 0.12),
  bone: new THREE.Color(0.46, 0.44, 0.38),
  horn: new THREE.Color(0.3, 0.28, 0.24),
  hornLight: new THREE.Color(0.46, 0.44, 0.38),
}

export function createBanshee(opts: BansheeOpts = {}): Banshee {
  const root = new THREE.Group()
  root.name = "banshee"
  const out: Banshee = {
    root,
    rig: null,
    animator: null,
    update(dt, s) {
      out.animator?.update(dt, s)
    },
    ready: Promise.resolve(),
  }
  const url = opts.url ?? `${import.meta.env.BASE_URL}models/monsters/banshee.bin`
  out.ready = (async () => {
    const data = await loadCreatureData(url, async () => (await import("./build")).generateBanshee())
    const mats = [createCreatureMaterial(SKIN, { sss: 2 }), createCreatureMaterial(HAIR, { fibreFreq: 170 }), createCreatureMaterial(SHROUD, { fibreFreq: 90, sss: 4 })]
    // Cloth is a single shell: render both sides.
    mats[2]!.material.side = THREE.DoubleSide
    const rig = buildCreature(
      data,
      mats.map((m) => m.material),
    )
    rig.root.scale.setScalar(opts.scale ?? 1)
    root.add(rig.root)
    out.rig = rig
    out.animator = new BansheeAnimator(rig, root, opts.seed ?? 3)
    out.animator.sway = mats.map((m) => m.uniforms.sway)
  })()
  return out
}
