import * as THREE from "three/webgpu"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js"
import { HEAD_LAYER, type PlayerBody } from "../body"

// Body Lab pose inspector (body.html?inspect=1, automation and diagnosis): the janitor frozen on one raw clip at a phase,
// no blending/IK/overlays, optionally beside the clip's source character on its native skeleton (`ref=<url>` glb with
// the same clip names), with close-up cameras on the hands, feet and knees.
//
//   __bodyInspect.show(clip, phase, view)   view: side | front | hand_r | hand_l | hand_r_top | feet | knees

export type InspectView = "side" | "front" | "back" | "hand_r" | "hand_l" | "hand_r_top" | "hand_r_out" | "hand_r_in" | "hand_r_back" | "hand_l_out" | "hand_l_in" | "feet" | "knees" | "shoulders" | "shoulder_side"

export async function createInspector(scene: THREE.Scene, cam: THREE.PerspectiveCamera, body: PlayerBody, refUrl: string | null) {
  let ref: { root: THREE.Object3D; mixer: THREE.AnimationMixer; clips: Map<string, THREE.AnimationClip>; byName: (n: string) => THREE.Object3D | undefined } | null = null
  const REF_X = 1.1
  /** Clear of the stage's stairs, ramp and ladder. */
  const O = new THREE.Vector3(-8, 0, 7)
  if (refUrl) {
    const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(refUrl)
    const root = gltf.scene
    root.position.set(O.x + REF_X, 0, O.z)
    // UAL faces +Z; turn it to face -Z like the janitor.
    root.rotation.y = Math.PI
    root.traverse((o) => {
      o.layers.enable(HEAD_LAYER)
      const m = o as THREE.Mesh
      if (m.isMesh) {
        m.castShadow = true
        m.frustumCulled = false
      }
    })
    scene.add(root)
    ref = { root, mixer: new THREE.AnimationMixer(root), clips: new Map(gltf.animations.map((c) => [c.name, c])), byName: (n) => root.getObjectByName(n) ?? undefined }
  }
  const skel = new THREE.SkeletonHelper(body.model!)
  ;(skel.material as THREE.LineBasicMaterial).depthTest = false
  skel.renderOrder = 10
  skel.layers.set(HEAD_LAYER)
  skel.visible = false
  scene.add(skel)

  const p = new THREE.Vector3()
  const q = new THREE.Vector3()
  function aim(view: InspectView, target: THREE.Object3D | undefined | null, ownX: number) {
    if (!target) return
    target.getWorldPosition(p)
    const frame = (x: number, y: number, z: number, fov: number) => {
      cam.fov = fov
      cam.position.set(p.x + x, p.y + y, p.z + z)
      cam.lookAt(p)
      cam.updateProjectionMatrix()
    }
    // The model faces -Z (root yaw 0): front camera at -Z, its right side (+X) at +X.
    switch (view) {
      case "side":
        p.set(O.x + ownX, 0.9, O.z)
        frame(3.4, 0.1, 0, 32)
        break
      case "front":
        p.set(O.x + ownX + (ref ? REF_X / 2 : 0), 0.9, O.z)
        frame(0, 0.1, ref ? -4.4 : -3.4, 32)
        break
      case "back":
        p.set(O.x + ownX + (ref ? REF_X / 2 : 0), 0.9, O.z)
        frame(0, 0.1, 3.4, 32)
        break
      case "hand_r":
        frame(0.06, 0.04, -0.34, 32)
        break
      case "hand_l":
        frame(-0.06, 0.04, -0.34, 32)
        break
      case "hand_r_top":
        frame(0.25, 0.32, 0.05, 30)
        break
      case "hand_r_out":
        frame(0.34, 0.03, -0.03, 32)
        break
      case "hand_r_in":
        frame(-0.2, -0.12, -0.2, 32)
        break
      case "hand_l_out":
        frame(-0.34, 0.03, -0.03, 32)
        break
      case "hand_l_in":
        frame(0.2, -0.12, -0.2, 32)
        break
      case "hand_r_back":
        frame(0.05, 0.04, 0.34, 32)
        break
      case "shoulders":
        frame(0.9, 0.25, -1.1, 30)
        break
      case "shoulder_side":
        frame(1.0, 0.05, 0, 30)
        break
      case "feet":
        frame(0.45, 0.12, -0.4, 30)
        break
      case "knees":
        frame(0.9, 0.1, -0.5, 30)
        break
    }
    void q
  }

  return {
    clips: () => body.clipNames(),
    /** Poses both characters and points the camera. `who` picks which one a close-up looks at. */
    show(clip: string, phase: number, view: InspectView, who: "janitor" | "ref" = "janitor", skeleton = false) {
      body.inspect(clip, phase, O.x, 0, O.z, 0)
      if (ref) {
        ref.mixer.stopAllAction()
        const c = ref.clips.get(refClip(clip))
        if (c) {
          const a = ref.mixer.clipAction(c)
          a.play()
          a.time = phase * c.duration
          a.setEffectiveTimeScale(0)
          ref.mixer.update(0)
        }
        ref.root.updateMatrixWorld(true)
      }
      skel.visible = skeleton
      // Side views: the source character would stand in front of the janitor.
      if (ref) ref.root.visible = view !== "side"
      const close = view.startsWith("hand") || view === "feet" || view === "knees" || view.startsWith("shoulder")
      const bone = view.startsWith("hand_r") ? "hand_r" : view.startsWith("hand_l") ? "hand_l" : view === "feet" ? "foot_r" : view === "knees" ? "calf_r" : view.startsWith("shoulder") ? "upperarm_r" : "pelvis"
      const pick = (n: string) => (close && who === "ref" && ref ? ref.byName(n) : body.bone(n))
      let target = pick(bone)
      if (view.startsWith("hand")) {
        // The middle of the hand: halfway from the wrist to the middle finger's first joint.
        const side = view.startsWith("hand_l") ? "l" : "r"
        const a = pick(`hand_${side}`)!.getWorldPosition(new THREE.Vector3())
        const b = pick(`middle_02_${side}`)!.getWorldPosition(new THREE.Vector3())
        const o = new THREE.Object3D()
        o.position.copy(a.lerp(b, 0.55))
        o.updateMatrixWorld()
        target = o
      }
      aim(view, target, 0)
    },
  }
}

/** Our clip names → the source pack's. */
const SOURCE: Record<string, string> = {
  idle: "Idle_Loop",
  walk: "Walk_Loop",
  jog: "Jog_Fwd_Loop",
  sprint: "Sprint_Loop",
  crouch_idle: "Crouch_Idle_Loop",
  crouch_walk: "Crouch_Fwd_Loop",
  jump_start: "Jump_Start",
  jump_air: "Jump_Loop",
  jump_land: "Jump_Land",
  interact: "Interact",
  torch: "Idle_Torch_Loop",
}
export const refClip = (n: string) => SOURCE[n] ?? n
