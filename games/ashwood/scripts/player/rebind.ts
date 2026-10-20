// Puts the janitor on the Quaternius Universal Animation Library skeleton, so UAL's clips play on him *verbatim*: no
// retargeting. (The old world-delta retarget could not recover finger/wrist twist between MakeHuman's and UAL's bone
// frames; hands came out as splayed claws.) Used by scripts/player/build-body.ts.
//
// Both skeletons use the same UE-style hierarchy and names (MakeHuman's game_engine rig: `head`/`Root` are `Head`/`root`
// in UAL). For every bone:
//   1. its new rest *orientation* is UAL's rest world orientation (so UAL's local rotation keys mean the same thing);
//   2. its new rest *position* keeps the janitor's proportions: each child joint sits along UAL's rest bone direction at
//      the janitor's own bone length;
//   3. the mesh is skinned (linear blend) into that new rest pose (UAL's T-pose with the janitor's proportions), using
//      the old bones swung onto the new directions with minimal rotation, and gets new inverse bind matrices.
// Clips are then copied over unchanged: every rotation channel, and the pelvis translation (scaled by hip height, as an
// offset from UAL's rest). Other translation channels (constant rest offsets in UAL's proportions) are dropped.
import { Matrix4, Quaternion, Vector3 } from "three"

type Doc = any
type Node = any

const RENAME: Record<string, string> = { head: "Head", Root: "root" }
const MAIN_CHILD = [/^spine_0\d$/, /^neck_01$/, /^Head$/, /^calf_/, /^foot_/, /^ball_[lr]$/, /^lowerarm_/, /^hand_/, /^middle_01_/, /^upperarm_/, /^(index|middle|ring|pinky|thumb)_0\d/, /^pelvis$/]

function worldOf(nodes: Node[], local: (n: Node) => Matrix4) {
  const w = new Map<Node, Matrix4>()
  const get = (n: Node): Matrix4 => {
    const c = w.get(n)
    if (c) return c
    const p = n.getParentNode?.()
    const m = p ? new Matrix4().multiplyMatrices(get(p), local(n)) : local(n).clone()
    w.set(n, m)
    return m
  }
  for (const n of nodes) get(n)
  return w
}
const trs = (n: Node) => new Matrix4().compose(new Vector3(...n.getTranslation()), new Quaternion(...n.getRotation()), new Vector3(...n.getScale()))
const pos = (m: Matrix4) => new Vector3().setFromMatrixPosition(m)
const rot = (m: Matrix4) => {
  const t = new Vector3()
  const q = new Quaternion()
  const s = new Vector3()
  m.decompose(t, q, s)
  return q
}
function mainChild(n: Node, has: (c: Node) => boolean) {
  const kids = n.listChildren().filter(has)
  for (const re of MAIN_CHILD) {
    const k = kids.find((c: Node) => re.test(c.getName()))
    if (k) return k
  }
  return kids[0] ?? null
}

const FINGER = /^(index|middle|ring|pinky|thumb)_0[123]_[lr]$/

export type RebindClip = {
  name: string
  clip: string
  /**
   * Fingers: "clip" keeps the clip's own finger keys (the torch grip); a number holds an authored relaxed hand instead,
   * that fraction of the way from the flat rest hand to the Idle_Loop's first-frame hand (UAL's mannequin hand is a
   * loose fist; 0.55 reads as fingers gently curled).
   */
  fingers?: "clip" | number
  /** Mirror left/right (UAL's rest skeleton is mirror-symmetric in X: local rotations map (x, y, z, w) → (x, −y, −z, w)). */
  mirror?: boolean
}

export function rebind(doc: Doc, ual: Doc, clips: RebindClip[], log = console.log) {
  const root = doc.getRoot()
  for (const n of root.listNodes()) if (RENAME[n.getName()]) n.setName(RENAME[n.getName()])
  const ualNodes = new Map<string, Node>(ual.getRoot().listNodes().map((n: Node) => [n.getName(), n]))
  const skins = root.listSkins()
  const joints: Node[] = skins[0].listJoints()
  const jointSet = new Set(joints)
  const all: Node[] = root.listNodes()
  const oldW = worldOf(all, trs)
  const ualW = worldOf(ual.getRoot().listNodes(), trs)
  const U = (n: Node) => ualNodes.get(n.getName())
  const missing = joints.filter((j) => !U(j)).map((j) => j.getName())
  if (missing.length) throw new Error(`rebind: no UAL bone for ${missing.join(", ")}`)

  // New rest world matrices, parents first.
  const newW = new Map<Node, Matrix4>()
  const swing = new Map<Node, Quaternion>()
  const order: Node[] = []
  const visit = (n: Node) => {
    order.push(n)
    for (const c of n.listChildren()) if (jointSet.has(c)) visit(c)
  }
  for (const j of joints) if (!jointSet.has(j.getParentNode())) visit(j)
  for (const n of order) {
    const parent = n.getParentNode()
    let p: Vector3
    if (!jointSet.has(parent)) p = pos(oldW.get(n)!)
    else {
      const pp = pos(newW.get(parent)!)
      const len = pos(oldW.get(n)!).distanceTo(pos(oldW.get(parent)!))
      const dir = pos(ualW.get(U(n))!).sub(pos(ualW.get(U(parent))!)).normalize()
      p = pp.addScaledVector(dir, len)
    }
    newW.set(n, new Matrix4().compose(p, rot(ualW.get(U(n))!), new Vector3(1, 1, 1)))
  }
  // Swing of each old bone onto its new direction (minimal rotation), for skinning the mesh into the new rest pose.
  for (const n of order) {
    const c = mainChild(n, (k) => jointSet.has(k))
    if (c) {
      const dOld = pos(oldW.get(c)!).sub(pos(oldW.get(n)!)).normalize()
      const cu = U(c)
      const dNew = pos(ualW.get(cu)!).sub(pos(ualW.get(U(n))!)).normalize()
      swing.set(n, new Quaternion().setFromUnitVectors(dOld, dNew))
    } else swing.set(n, swing.get(n.getParentNode())?.clone() ?? new Quaternion())
  }
  // Posed-old joint matrices: old bone frames, swung, at the new joint positions.
  const posed = new Map<Node, Matrix4>()
  for (const n of order) {
    const q = swing.get(n)!.clone().multiply(rot(oldW.get(n)!))
    posed.set(n, new Matrix4().compose(pos(newW.get(n)!), q, new Vector3(1, 1, 1)))
  }

  // Re-skin every skinned primitive into the new rest pose. Skins may share one inverse-bind accessor (Blender does
  // that), so read every original first.
  const done = new Set<unknown>()
  const ibmOrig = new Map<unknown, Float32Array>()
  for (const node of all) {
    const ibm = node.getSkin()?.getInverseBindMatrices()
    if (ibm && !ibmOrig.has(ibm)) ibmOrig.set(ibm, new Float32Array(ibm.getArray()))
  }
  for (const node of all) {
    const skin = node.getSkin()
    const mesh = node.getMesh()
    if (!skin || !mesh) continue
    const js: Node[] = skin.listJoints()
    const ibmOld = ibmOrig.get(skin.getInverseBindMatrices())!
    const meshW = oldW.get(node)!
    const skinM = js.map((j, i) => new Matrix4().multiplyMatrices(posed.get(j)!, new Matrix4().fromArray(ibmOld, i * 16)).premultiply(meshW.clone().invert()).multiply(meshW))
    for (const prim of mesh.listPrimitives()) {
      const P = prim.getAttribute("POSITION")
      if (done.has(P)) continue
      done.add(P)
      const N = prim.getAttribute("NORMAL")
      const T = prim.getAttribute("TANGENT")
      const J = prim.getAttribute("JOINTS_0")
      const W = prim.getAttribute("WEIGHTS_0")
      const pa = P.getArray()
      const na = N?.getArray()
      const ta = T?.getArray()
      const ja = J.getArray()
      const wa = W.getArray()
      const v = new Vector3()
      const acc = new Vector3()
      const nacc = new Vector3()
      const tacc = new Vector3()
      const tmp = new Vector3()
      const tTan = new Vector3()
      for (let i = 0; i < P.getCount(); i++) {
        acc.set(0, 0, 0)
        nacc.set(0, 0, 0)
        tacc.set(0, 0, 0)
        v.fromArray(pa, i * 3)
        for (let k = 0; k < 4; k++) {
          const w = wa[i * 4 + k]
          if (!w) continue
          const m = skinM[ja[i * 4 + k]]!
          acc.addScaledVector(tmp.copy(v).applyMatrix4(m), w)
          if (na) nacc.addScaledVector(tmp.fromArray(na, i * 3).transformDirection(m), w)
          if (ta) tacc.addScaledVector(tTan.fromArray(ta, i * 4).transformDirection(m), w)
        }
        acc.toArray(pa, i * 3)
        if (na) nacc.normalize().toArray(na, i * 3)
        if (ta) {
          tacc.normalize()
          ta[i * 4] = tacc.x
          ta[i * 4 + 1] = tacc.y
          ta[i * 4 + 2] = tacc.z
        }
      }
      P.setArray(pa)
      if (N) N.setArray(na)
      if (T) T.setArray(ta)
    }
    const ibmNew = new Float32Array(js.length * 16)
    js.forEach((j, i) => new Matrix4().multiplyMatrices(newW.get(j)!.clone().invert(), meshW).toArray(ibmNew, i * 16))
    skin.getInverseBindMatrices().setArray(ibmNew)
  }

  // New local rest TRS.
  for (const n of order) {
    const parent = n.getParentNode()
    const pw = jointSet.has(parent) ? newW.get(parent)! : oldW.get(parent) ?? new Matrix4()
    const l = new Matrix4().multiplyMatrices(pw.clone().invert(), newW.get(n)!)
    const t = new Vector3()
    const q = new Quaternion()
    const s = new Vector3()
    l.decompose(t, q, s)
    n.setTranslation(t.toArray()).setRotation(q.toArray()).setScale([1, 1, 1])
  }

  // Clips: rotations verbatim; pelvis translation as a scaled offset from UAL's rest.
  const byName = new Map<string, Node>(order.map((n) => [n.getName(), n]))
  const pelvis = byName.get("pelvis")!
  const uPelvis = ualNodes.get("pelvis")!
  const hipRatio = pos(newW.get(pelvis)!).y / pos(ualW.get(uPelvis)!).y
  const uRestT = new Vector3(...uPelvis.getTranslation())
  const ourRestT = new Vector3(...pelvis.getTranslation())
  const buffer = root.listBuffers()[0]
  // The curled reference hand: Idle_Loop's first frame.
  const idle = ual.getRoot().listAnimations().find((a: Node) => a.getName() === "Idle_Loop")
  const curl = new Map<string, Quaternion>()
  for (const c of idle?.listChannels() ?? []) {
    const n = c.getTargetNode().getName()
    if (c.getTargetPath() === "rotation" && FINGER.test(n)) curl.set(n, new Quaternion().fromArray(c.getSampler().getOutput().getArray(), 0))
  }
  const swap = (n: string) => n.replace(/_l$/, "_§").replace(/_r$/, "_l").replace(/_§$/, "_r")
  for (const { name, clip, fingers = 0.55, mirror = false } of clips) {
    const src = ual.getRoot().listAnimations().find((a: Node) => a.getName() === clip)
    if (!src) throw new Error(`rebind: no UAL clip ${clip}`)
    const anim = doc.createAnimation(name)
    let channels = 0
    for (const c of src.listChannels()) {
      const target = byName.get(mirror ? swap(c.getTargetNode().getName()) : c.getTargetNode().getName())
      const path = c.getTargetPath()
      if (!target || path === "scale" || (path === "translation" && target !== pelvis)) continue
      if (path === "rotation" && typeof fingers === "number" && FINGER.test(target.getName())) {
        const rest = new Quaternion(...ualNodes.get(target.getName())!.getRotation())
        const q = rest.slerp(curl.get(target.getName()) ?? rest, fingers)
        const input = doc.createAccessor().setType("SCALAR").setArray(new Float32Array([0])).setBuffer(buffer)
        const output = doc.createAccessor().setType("VEC4").setArray(new Float32Array(q.toArray())).setBuffer(buffer)
        const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation("STEP")
        anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(target).setTargetPath(path).setSampler(sampler))
        channels++
        continue
      }
      const s = c.getSampler()
      const input = doc.createAccessor().setType("SCALAR").setArray(new Float32Array(s.getInput().getArray())).setBuffer(buffer)
      let out = new Float32Array(s.getOutput().getArray())
      if (mirror && path === "rotation")
        for (let i = 0; i < out.length; i += 4) {
          out[i + 1] = -out[i + 1]!
          out[i + 2] = -out[i + 2]!
        }
      if (mirror && path === "translation") for (let i = 0; i < out.length; i += 3) out[i] = -out[i]!
      if (path === "translation") {
        for (let i = 0; i < out.length; i += 3) {
          out[i] = ourRestT.x + (out[i]! - uRestT.x) * hipRatio
          out[i + 1] = ourRestT.y + (out[i + 1]! - uRestT.y) * hipRatio
          out[i + 2] = ourRestT.z + (out[i + 2]! - uRestT.z) * hipRatio
        }
      }
      const output = doc.createAccessor().setType(path === "rotation" ? "VEC4" : "VEC3").setArray(out).setBuffer(buffer)
      const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation(s.getInterpolation())
      anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(target).setTargetPath(path).setSampler(sampler))
      channels++
    }
    log(`clip ${name.padEnd(12)} = UAL ${clip} (${channels} channels, verbatim)`)
  }
  log(`rebind: ${order.length} bones on UAL rest frames, hip ratio ${hipRatio.toFixed(3)}`)
}
