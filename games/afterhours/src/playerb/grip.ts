import * as THREE from "three/webgpu"

// Contact grip on a cylinder (the flashlight barrel): the palm's skin against it, each finger phalanx curled until it
// touches it, the thumb kept off it, all measured against the character's real mesh (skinned vertices), so every
// roster character closes its own hand round the same barrel. Same approach as the steering-wheel grip (seat.ts).

export type HandSkin = {
  mesh: THREE.SkinnedMesh
  /** Vertices whose dominant bone is the hand bone (palm and back), per side. */
  palm: { Left: number[]; Right: number[] }
  /** Every vertex of the hand (hand, fingers, thumb), per side. */
  all: { Left: number[]; Right: number[] }
  /** Finger half-thickness (m) per side + finger, measured from the mesh. */
  fingerR: Record<string, number>
}

/** Finds the body mesh with the hands and measures them (call once per character, in the bind or any pose). */
export function measureHands(model: THREE.Object3D): HandSkin | null {
  let mesh: THREE.SkinnedMesh | null = null
  let most = 0
  model.traverse((o) => {
    const m = o as THREE.SkinnedMesh
    if (!m.isSkinnedMesh || /head/i.test(m.name)) return
    const bi = m.skeleton.bones.findIndex((b) => b.name === "LeftHand")
    if (bi < 0) return
    const si = m.geometry.attributes.skinIndex!
    const sw = m.geometry.attributes.skinWeight!
    let n = 0
    for (let i = 0; i < si.count; i++) for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === bi && sw.getComponent(i, k) > 0.5) n++
    if (n > most) {
      most = n
      mesh = m
    }
  })
  if (!mesh) return null
  const m = mesh as THREE.SkinnedMesh
  m.updateMatrixWorld(true)
  m.skeleton.update()
  const bones = m.skeleton.bones
  const si = m.geometry.attributes.skinIndex!
  const sw = m.geometry.attributes.skinWeight!
  const out: HandSkin = { mesh: m, palm: { Left: [], Right: [] }, all: { Left: [], Right: [] }, fingerR: {} }
  const thick = new Map<string, number[]>()
  const v = new THREE.Vector3()
  for (let i = 0; i < si.count; i++) {
    let best = -1
    let bw = 0
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k)
      if (w > bw) {
        bw = w
        best = si.getComponent(i, k)
      }
    }
    const b = bones[best]
    if (!b) continue
    const hm = /^(Left|Right)Hand(.*)$/.exec(b.name)
    if (!hm) continue
    const side = hm[1] as "Left" | "Right"
    out.all[side].push(i)
    if (hm[2] === "") out.palm[side].push(i)
    const fm = /^(Index|Middle|Ring|Pinky)[123]$|^(Thumb)[23]$/.exec(hm[2]!)
    if (fm && b.children[0]) {
      m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld)
      const a = b.getWorldPosition(new THREE.Vector3())
      const c = b.children[0]!.getWorldPosition(new THREE.Vector3())
      const seg = c.clone().sub(a)
      const t = THREE.MathUtils.clamp(v.clone().sub(a).dot(seg) / seg.lengthSq(), 0, 1)
      const key = `${side}${fm[1] ?? fm[2]}`
      let arr = thick.get(key)
      if (!arr) thick.set(key, (arr = []))
      arr.push(v.distanceTo(a.addScaledVector(seg, t)))
    }
  }
  for (const [k, arr] of thick) {
    arr.sort((x, y) => x - y)
    out.fingerR[k] = arr[Math.floor(arr.length * 0.85)] ?? 0.009
  }
  return out
}

/** A cylinder: a point on its axis, the unit axis, the radius; distance from a point to its surface (− inside). */
export type Cyl = { p: THREE.Vector3; a: THREE.Vector3; r: number; lo?: number; hi?: number }
const _d = new THREE.Vector3()
/** Distance to the cylinder's side; past its ends (`lo`..`hi` along the axis from p) the distance to the end cap. */
export function cylDist(c: Cyl, x: THREE.Vector3) {
  _d.copy(x).sub(c.p)
  const t = _d.dot(c.a)
  _d.addScaledVector(c.a, -t)
  const radial = _d.length() - c.r
  const lo = c.lo ?? -Infinity
  const hi = c.hi ?? Infinity
  const out = t < lo ? lo - t : t > hi ? t - hi : 0
  if (out <= 0) return radial
  return radial <= 0 ? out : Math.hypot(radial, out)
}

/**
 * Opens each finger (and the thumb) joint by small steps, tip joint first, while any vertex skinned to that joint or
 * the ones beyond it is inside the cylinder: a vertex-exact clean-up after the bone-based curl (skin is thicker in
 * places than the measured half-thickness).
 */
export function unpenetrate(skin: HandSkin, bones: Record<string, THREE.Bone>, side: "Left" | "Right", c: Cyl) {
  const m = skin.mesh
  const bn = m.skeleton.bones
  const si = m.geometry.attributes.skinIndex!
  const sw = m.geometry.attributes.skinWeight!
  const domName = new Map<number, string>()
  for (const i of skin.all[side]) {
    let best = 0
    let bw = 0
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k)
      if (w > bw) {
        bw = w
        best = si.getComponent(i, k)
      }
    }
    domName.set(i, bn[best]!.name)
  }
  const v = new THREE.Vector3()
  const P = (n: string) => bones[n]!.getWorldPosition(new THREE.Vector3())
  const across = P(`${side}HandIndex1`).sub(P(`${side}HandPinky1`)).normalize()
  const fing = P(`${side}HandMiddle1`).sub(P(`${side}Hand`)).normalize()
  const pn = (side === "Left" ? new THREE.Vector3().crossVectors(fing, across) : new THREE.Vector3().crossVectors(across, fing)).normalize()
  for (const f of ["Index", "Middle", "Ring", "Pinky", "Thumb"]) {
    for (let j = 3; j >= 1; j--) {
      const b = bones[`${side}Hand${f}${j}`]
      const n = bones[`${side}Hand${f}${j + 1}`]
      if (!b || !n) continue
      const names = new Set([1, 2, 3].filter((x) => x >= j).map((x) => `${side}Hand${f}${x}`))
      const list = skin.all[side].filter((i) => names.has(domName.get(i)!))
      const worst = () => {
        m.skeleton.update()
        let min = Infinity
        for (const i of list) {
          m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld)
          min = Math.min(min, cylDist(c, v))
        }
        return min
      }
      // The opening direction: whichever way moves the child away from the palm side (thumb: away from the axis).
      const q0 = b.quaternion.clone()
      const axis = f === "Thumb" ? new THREE.Vector3() : across.clone()
      if (f === "Thumb") {
        const pa = b.getWorldPosition(new THREE.Vector3())
        const pb = n.getWorldPosition(new THREE.Vector3())
        const off = pb.clone().sub(c.p)
        off.addScaledVector(c.a, -off.dot(c.a))
        axis.crossVectors(pb.clone().sub(pa), off).normalize()
      } else {
        const c0 = n.getWorldPosition(new THREE.Vector3())
        turnWorld(b, axis, 0.1)
        const c1 = n.getWorldPosition(new THREE.Vector3())
        b.quaternion.copy(q0)
        b.updateWorldMatrix(false, true)
        if (c1.sub(c0).dot(pn) > 0) axis.negate()
      }
      for (let it = 0; it < 40 && worst() < 0.0003; it++) turnWorld(b, axis, 0.02)
    }
  }
  m.skeleton.update()
}

/** Smallest skin-to-surface distance (m) over a vertex list, and how many vertices are inside by more than `tol`. */
export function skinVsCyl(skin: HandSkin, list: number[], c: Cyl, tol = 0) {
  // Bone matrices are only refreshed at render: bring them up to this frame's pose first.
  skin.mesh.skeleton.update()
  const v = new THREE.Vector3()
  const mw = skin.mesh.matrixWorld
  let min = Infinity
  let inside = 0
  for (const i of list) {
    skin.mesh.getVertexPosition(i, v).applyMatrix4(mw)
    const d = cylDist(c, v)
    if (d < min) min = d
    if (d < -tol) inside++
  }
  return { min, inside }
}

function turnWorld(bone: THREE.Object3D, axis: THREE.Vector3, angle: number) {
  if (Math.abs(angle) < 1e-7) return
  const pq = bone.parent!.getWorldQuaternion(new THREE.Quaternion()).invert()
  bone.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis.clone().normalize().applyQuaternion(pq), angle))
  bone.updateWorldMatrix(false, true)
}

/**
 * Closes each finger of one hand onto the cylinder: per phalanx (knuckle, middle, tip), from open, the joint curls
 * about the knuckle line until the segment first touches the surface (its nearest point at the finger's measured
 * half-thickness + `skin`); the thumb is swung off the surface where it would cut in. `bones` by name.
 */
export function wrapFingers(bones: Record<string, THREE.Bone>, side: "Left" | "Right", c: Cyl, fingerR: Record<string, number>, skin = 0.0028) {
  const P = (n: string) => bones[n]!.getWorldPosition(new THREE.Vector3())
  const across = P(`${side}HandIndex1`).sub(P(`${side}HandPinky1`)).normalize()
  const fing = P(`${side}HandMiddle1`).sub(P(`${side}Hand`)).normalize()
  // Out of the palm (the side the fingers close towards).
  const pn = (side === "Left" ? new THREE.Vector3().crossVectors(fing, across) : new THREE.Vector3().crossVectors(across, fing)).normalize()
  for (const f of ["Index", "Middle", "Ring", "Pinky"]) {
    const want = (fingerR[`${side}${f}`] ?? 0.009) * 1.25 + skin
    for (let i = 1; i <= 3; i++) {
      const b = bones[`${side}Hand${f}${i}`]
      const n = bones[`${side}Hand${f}${i + 1}`]
      if (!b || !n) continue
      const q0 = b.quaternion.clone()
      // The flex direction: the sign of the knuckle-line axis that moves this joint's child towards the palm side.
      const axis = across.clone()
      {
        const c0 = n.getWorldPosition(new THREE.Vector3())
        turnWorld(b, axis, 0.1)
        const c1 = n.getWorldPosition(new THREE.Vector3())
        b.quaternion.copy(q0)
        b.updateWorldMatrix(false, true)
        if (c1.sub(c0).dot(pn) < 0) axis.negate()
      }
      const err = (x: number) => {
        b.quaternion.copy(q0)
        turnWorld(b, axis, x)
        const pa = b.getWorldPosition(new THREE.Vector3())
        const pb = n.getWorldPosition(new THREE.Vector3())
        return Math.min(cylDist(c, pb), cylDist(c, pa.clone().lerp(pb, 0.25)), cylDist(c, pa.clone().lerp(pb, 0.5)), cylDist(c, pa.lerp(pb, 0.75))) - want
      }
      // From open, curl in steps until the first touch, then bisect it; never touching: the closest approach.
      let prev = -1.6
      let a = prev
      let bestA = prev
      let bestE = Math.abs(err(prev))
      if (err(prev) > 0) {
        let found = false
        for (let x = -1.5; x <= 1.8 + 1e-6; x += 0.1) {
          const e = err(x)
          if (Math.abs(e) < bestE) {
            bestE = Math.abs(e)
            bestA = x
          }
          if (e <= 0) {
            let lo = prev
            let hi = x
            for (let k = 0; k < 8; k++) {
              const mid = (lo + hi) / 2
              if (err(mid) > 0) lo = mid
              else hi = mid
            }
            a = lo
            found = true
            break
          }
          prev = x
        }
        if (!found) a = bestA
      }
      b.quaternion.copy(q0)
      turnWorld(b, axis, a)
    }
  }
  // Thumb: each joint turned towards the barrel until its segment touches it (closing the ring between thumb and
  // index onto the barrel), never into it.
  const want = (fingerR[`${side}Thumb`] ?? 0.009) + skin
  for (let i = 1; i <= 3; i++) {
    const b = bones[`${side}HandThumb${i}`]
    const n = bones[`${side}HandThumb${i + 1}`]
    if (!b || !n) continue
    const segD = () => {
      const pa = b.getWorldPosition(new THREE.Vector3())
      const pb = n.getWorldPosition(new THREE.Vector3())
      return Math.min(cylDist(c, pb), cylDist(c, pa.clone().lerp(pb, 0.5)), cylDist(c, pa.lerp(pb, 0.8))) - want
    }
    for (let it = 0; it < 60; it++) {
      const e = segD()
      if (Math.abs(e) < 0.0004) break
      const pa = b.getWorldPosition(new THREE.Vector3())
      const pb = n.getWorldPosition(new THREE.Vector3())
      const off = pb.clone().sub(c.p)
      off.addScaledVector(c.a, -off.dot(c.a))
      // Towards the axis when off it, away when in it.
      const ax = new THREE.Vector3().crossVectors(pb.clone().sub(pa), off.negate())
      if (ax.lengthSq() < 1e-12) break
      const step = THREE.MathUtils.clamp(e * 8, -0.1, 0.1)
      turnWorld(b, ax, step)
      if (i === 1 && Math.abs(step) < 1e-4) break
    }
  }
}
