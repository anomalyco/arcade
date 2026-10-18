import * as THREE from "three/webgpu"

// Authored hand poses, built from anatomy rather than copied from the clips. UAL's finger keys were authored for its
// mannequin's chunky fingers; on the janitor's (MakeHuman) fingers they read as a claw or a cup. So the fingers are
// posed here, per joint, about each finger's real flexion axis measured from the bind pose:
//
//   flexion axis = bone direction × palm normal   (rotating by +θ bends the finger toward the palm)
//
// Angles are degrees at MCP / PIP / DIP (knuckle, middle, tip joint). The thumb has its own frame: opposition (swing
// across in front of the palm, about the axis along the index metacarpal), then flexion of its joints.

export type HandPose = {
  /** [MCP, PIP, DIP] per finger, degrees. */
  index: [number, number, number]
  middle: [number, number, number]
  ring: [number, number, number]
  pinky: [number, number, number]
  /** Thumb: opposition (toward the palm/index) at the base, then flexion of the three thumb bones, degrees. */
  thumbOppose: number
  /** Thumb swung in the palm's plane toward the index finger (radial adduction), degrees. */
  thumbAlong: number
  thumb: [number, number, number]
  /** Fingers drawn together (degrees each finger turns toward the middle finger, pinky most). */
  together: number
}

/** A relaxed, hanging human hand (real resting posture: flexion grows from index to pinky). */
export const RELAXED: HandPose = {
  index: [12, 26, 14],
  middle: [16, 32, 16],
  ring: [20, 36, 18],
  pinky: [24, 40, 20],
  thumbOppose: 28,
  thumbAlong: 0,
  thumb: [6, 10, 14],
  together: 4,
}

/** A runner's loose fist: fingers curled, not clenched, thumb resting on the index. */
export const LOOSE_FIST: HandPose = {
  index: [50, 60, 30],
  middle: [55, 64, 32],
  ring: [60, 66, 34],
  pinky: [64, 66, 36],
  thumbOppose: 45,
  thumbAlong: -40,
  thumb: [10, 20, 26],
  together: 6,
}

/** A fist round a flashlight barrel (~35 mm). */
export const TORCH_GRIP: HandPose = {
  index: [62, 78, 40],
  middle: [68, 80, 42],
  ring: [72, 80, 44],
  pinky: [76, 80, 46],
  thumbOppose: 60,
  thumbAlong: -45,
  thumb: [20, 30, 38],
  together: 2,
}

const FINGERS = ["index", "middle", "ring", "pinky"] as const
type Joint = { bone: THREE.Object3D; rest: THREE.Quaternion; flex: THREE.Vector3; spread: THREE.Vector3; finger: (typeof FINGERS)[number] | "thumb"; joint: number; oppose?: THREE.Vector3 }

/**
 * Measures one hand's joints at the bind pose (call before any animation has been applied). `side` "l" or "r".
 * Returns a setter that writes a pose (blendable: `apply(a, b, t)`).
 */
export function createHand(byName: Map<string, THREE.Object3D>, side: "l" | "r") {
  const at = (n: string) => (byName.get(n) as THREE.Object3D).getWorldPosition(new THREE.Vector3())
  const wq = (o: THREE.Object3D) => o.getWorldQuaternion(new THREE.Quaternion())
  const hand = at(`hand_${side}`)
  const index1 = at(`index_01_${side}`)
  const pinky1 = at(`pinky_01_${side}`)
  const middle1 = at(`middle_01_${side}`)
  const along = middle1.clone().sub(hand).normalize()
  // Across the knuckles, index → pinky; palm normal = along × across for the right hand (checked against renders: the
  // fingers must curl toward the palm), mirrored for the left.
  const across = pinky1.clone().sub(index1).normalize()
  const palm = new THREE.Vector3().crossVectors(along, across).multiplyScalar(side === "r" ? 1 : -1).normalize()
  const joints: Joint[] = []
  for (const finger of [...FINGERS, "thumb"] as const) {
    for (let j = 1; j <= 3; j++) {
      const bone = byName.get(`${finger}_0${j}_${side}`)
      if (!bone) continue
      const next = byName.get(`${finger}_0${j + 1}_${side}`) ?? byName.get(`${finger}_04_leaf_${side}`)
      const p = bone.getWorldPosition(new THREE.Vector3())
      const dir = next ? next.getWorldPosition(new THREE.Vector3()).sub(p).normalize() : along.clone()
      const inv = wq(bone).invert()
      const flexW = new THREE.Vector3().crossVectors(dir, palm).normalize()
      // Spread axis: the palm normal (turning about it fans the finger sideways).
      const joint: Joint = { bone, rest: bone.quaternion.clone(), flex: flexW.clone().applyQuaternion(inv), spread: palm.clone().applyQuaternion(inv), finger, joint: j }
      if (finger === "thumb") {
        // Thumb flexion bends across the palm toward the pinky: about the thumb bone's own axis × (palm toward pinky).
        const toward = palm.clone().add(across.clone().multiplyScalar(0.6)).normalize()
        joint.flex = new THREE.Vector3().crossVectors(dir, toward).normalize().applyQuaternion(inv)
        // Opposition: swing the whole thumb about the index metacarpal's axis (the hand's "along" direction).
        joint.oppose = along.clone().multiplyScalar(side === "r" ? -1 : 1).applyQuaternion(inv)
      }
      joints.push(joint)
    }
  }
  const deg = Math.PI / 180
  const q = new THREE.Quaternion()
  const tmp = new THREE.Quaternion()
  const local = (p: HandPose, jt: Joint, out: THREE.Quaternion) => {
    out.copy(jt.rest)
    if (jt.finger === "thumb") {
      if (jt.joint === 1) {
        out.multiply(tmp.setFromAxisAngle(jt.spread, p.thumbAlong * deg * (side === "r" ? 1 : -1)))
        out.multiply(tmp.setFromAxisAngle(jt.oppose!, p.thumbOppose * deg))
      }
      out.multiply(tmp.setFromAxisAngle(jt.flex, p.thumb[jt.joint - 1]! * deg))
      return out
    }
    if (jt.joint === 1) {
      const fan = { index: 1, middle: 0, ring: -1, pinky: -2 }[jt.finger]
      out.multiply(tmp.setFromAxisAngle(jt.spread, fan * p.together * deg * (side === "r" ? 1 : -1)))
    }
    return out.multiply(tmp.setFromAxisAngle(jt.flex, p[jt.finger][jt.joint - 1]! * deg))
  }
  const q2 = new THREE.Quaternion()
  return {
    /** Writes pose `a` (blended toward `b` by `t`) into the finger bones' local rotations. */
    apply(a: HandPose, b?: HandPose, t = 0) {
      for (const jt of joints) {
        local(a, jt, q)
        if (b && t > 0) q.slerp(local(b, jt, q2), t)
        jt.bone.quaternion.copy(q)
      }
    },
  }
}

/** RELAXED adjusted by the Lab knobs: overall finger curl ×, thumb opposition and curl (degrees), fingers together. */
export function relaxedPose(curl: number, thumbOppose: number, thumbAlong: number, thumbCurl: number, together: number, out: HandPose): HandPose {
  out.thumbAlong = thumbAlong
  for (const f of FINGERS) for (let j = 0; j < 3; j++) out[f][j] = RELAXED[f][j]! * curl
  out.thumbOppose = thumbOppose
  for (let j = 0; j < 3; j++) out.thumb[j] = RELAXED.thumb[j]! * (thumbCurl / RELAXED.thumb[2])
  out.together = together
  return out
}
export const newPose = (): HandPose => structuredClone(RELAXED)

/** Scales one finger's flexion of `pose` (in place) to `k` × TORCH_GRIP's (thumb: its curl; opposition kept). */
export function scaleFinger(pose: HandPose, finger: "index" | "middle" | "ring" | "pinky" | "thumb", k: number) {
  for (let j = 0; j < 3; j++) pose[finger][j] = TORCH_GRIP[finger][j]! * k
}
