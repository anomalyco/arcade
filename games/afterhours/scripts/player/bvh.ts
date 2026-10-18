// Minimal BVH reader for the 100STYLE mocap (scripts/player/mocap.ts): joint hierarchy, offsets, and per-frame local
// rotations/root positions with three.js math. Units are left as in the file (100STYLE: centimetres, Y up).
import { Euler, Matrix4, Quaternion, Vector3 } from "three"

export type BvhJoint = { name: string; parent: number; offset: Vector3; channels: string[]; end?: Vector3 }
export type Bvh = { joints: BvhJoint[]; frames: number; dt: number; data: Float32Array; stride: number }

export function parseBvh(text: string): Bvh {
  const tok = text.split(/\s+/).filter(Boolean)
  let i = 0
  const joints: BvhJoint[] = []
  const stack: number[] = []
  let stride = 0
  while (i < tok.length && tok[i] !== "MOTION") {
    const t = tok[i++]!
    if (t === "ROOT" || t === "JOINT") {
      const name = tok[i++]!
      joints.push({ name, parent: stack.length ? stack[stack.length - 1]! : -1, offset: new Vector3(), channels: [] })
      stack.push(joints.length - 1)
    } else if (t === "End") {
      i++ // "Site"
      stack.push(-2)
    } else if (t === "OFFSET") {
      const v = new Vector3(Number(tok[i]), Number(tok[i + 1]), Number(tok[i + 2]))
      i += 3
      const top = stack[stack.length - 1]!
      if (top === -2) joints[stack[stack.length - 2]!]!.end = v
      else joints[top]!.offset.copy(v)
    } else if (t === "CHANNELS") {
      const n = Number(tok[i++])
      const j = joints[stack[stack.length - 1]!]!
      j.channels = tok.slice(i, i + n)
      i += n
      stride += n
    } else if (t === "}") stack.pop()
  }
  i++ // MOTION
  i++ // Frames:
  const frames = Number(tok[i++])
  i += 2 // Frame Time:
  const dt = Number(tok[i++])
  const data = new Float32Array(frames * stride)
  for (let k = 0; k < data.length; k++) data[k] = Number(tok[i + k])
  return { joints, frames, dt, data, stride }
}

const DEG = Math.PI / 180

/** Local rotation and (root) position of every joint at frame f. */
export function frameLocal(b: Bvh, f: number) {
  const rot: Quaternion[] = []
  let rootPos = new Vector3()
  let c = f * b.stride
  const e = new Euler()
  const q = new Quaternion()
  for (const j of b.joints) {
    const r = new Quaternion()
    for (const ch of j.channels) {
      const v = b.data[c++]!
      if (ch === "Xposition") rootPos.x = v
      else if (ch === "Yposition") rootPos.y = v
      else if (ch === "Zposition") rootPos.z = v
      else {
        const axis = ch[0] === "X" ? new Vector3(1, 0, 0) : ch[0] === "Y" ? new Vector3(0, 1, 0) : new Vector3(0, 0, 1)
        r.multiply(q.setFromAxisAngle(axis, v * DEG))
      }
    }
    rot.push(r)
  }
  void e
  return { rot, rootPos }
}

/** World rotations and positions (file units) of every joint at frame f (rest pose when f < 0). */
export function frameWorld(b: Bvh, f: number) {
  const n = b.joints.length
  const loc = f >= 0 ? frameLocal(b, f) : { rot: b.joints.map(() => new Quaternion()), rootPos: new Vector3() }
  const wq: Quaternion[] = new Array(n)
  const wp: Vector3[] = new Array(n)
  b.joints.forEach((j, k) => {
    if (j.parent < 0) {
      wq[k] = loc.rot[k]!.clone()
      wp[k] = loc.rootPos.clone().add(j.offset)
    } else {
      wq[k] = wq[j.parent]!.clone().multiply(loc.rot[k]!)
      wp[k] = j.offset.clone().applyQuaternion(wq[j.parent]!).add(wp[j.parent]!)
    }
  })
  return { wq, wp }
}

export const _unused = Matrix4
