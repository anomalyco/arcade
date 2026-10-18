// Retargets CC0 humanoid animation clips onto the janitor's skeleton (MPFB game_engine, UE-style names) and bakes them
// into the glTF document as ordinary node animations. Used by scripts/player/build-body.ts.
//
// Method: world-space rotation deltas from a direction-matched reference pose. For each target bone b mapped to source
// bone s:   W_t(b, t) = W_s(s, t) · W_s(s, rest)⁻¹ · W_t,ref(b),   where W_t,ref is the target's rest rotation swung so
// the bone points the way the source bone points at rest (so an A-pose target takes T-pose source clips correctly).
// Unmapped target bones (extra spine segments, clavicles under a source without them, fingers) follow their nearest
// mapped ancestor's delta. The pelvis also gets the source hips' translation, scaled by the ratio of hip heights.
import { Matrix4, Quaternion, Vector3 } from "three"

type Doc = any
type Node = any

export type ClipSpec = {
  /** Output clip name. */
  name: string
  /** Source document and clip name in it. */
  src: Doc
  clip: string
  /** Target bone → source bone. */
  map: Record<string, string>
  /** Seconds to keep [from, to) (default: the whole clip). */
  range?: [number, number]
  /** Mirror left/right (for a strafe the other way). */
  mirror?: boolean
}

const FPS = 30

/** Rest-pose world matrices and local TRS for every node of a document (scene roots at identity parents). */
function restOf(doc: Doc) {
  const local = new Map<Node, { t: Vector3; r: Quaternion; s: Vector3 }>()
  for (const n of doc.getRoot().listNodes()) {
    local.set(n, { t: new Vector3(...n.getTranslation()), r: new Quaternion(...n.getRotation()), s: new Vector3(...n.getScale()) })
  }
  return local
}

/** Samples a channel (LINEAR/STEP) at time t. */
function sample(sampler: any, t: number, size: number, out: number[]) {
  const input = sampler.getInput().getArray() as Float32Array
  const output = sampler.getOutput().getArray() as Float32Array
  const n = input.length
  if (t <= input[0]!) {
    for (let k = 0; k < size; k++) out[k] = output[k]!
    return out
  }
  if (t >= input[n - 1]!) {
    for (let k = 0; k < size; k++) out[k] = output[(n - 1) * size + k]!
    return out
  }
  let i = 0
  while (i < n - 2 && input[i + 1]! < t) i++
  const u = sampler.getInterpolation() === "STEP" ? 0 : (t - input[i]!) / (input[i + 1]! - input[i]!)
  if (size === 4) {
    const a = new Quaternion().fromArray(output, i * 4)
    const b = new Quaternion().fromArray(output, (i + 1) * 4)
    a.slerp(b, u)
    out[0] = a.x
    out[1] = a.y
    out[2] = a.z
    out[3] = a.w
  } else for (let k = 0; k < size; k++) out[k] = output[i * size + k]! * (1 - u) + output[(i + 1) * size + k]! * u
  return out
}

function parentOf(n: Node): Node | null {
  return n.getParentNode?.() ?? null
}

/** World matrices of every node, given per-node local TRS overrides. */
function fk(doc: Doc, local: Map<Node, { t: Vector3; r: Quaternion; s: Vector3 }>) {
  const world = new Map<Node, Matrix4>()
  const get = (n: Node): Matrix4 => {
    const w = world.get(n)
    if (w) return w
    const l = local.get(n)!
    const m = new Matrix4().compose(l.t, l.r, l.s)
    const p = parentOf(n)
    const r = p ? new Matrix4().multiplyMatrices(get(p), m) : m
    world.set(n, r)
    return r
  }
  for (const n of doc.getRoot().listNodes()) get(n)
  return world
}

const rotOf = (m: Matrix4) => {
  const t = new Vector3()
  const r = new Quaternion()
  const s = new Vector3()
  m.decompose(t, r, s)
  return r
}
const posOf = (m: Matrix4) => new Vector3().setFromMatrixPosition(m)

/** First child of `n` (by name preference) used to aim a bone. */
function aimChild(n: Node, prefer: RegExp[]): Node | null {
  const kids = n.listChildren()
  for (const p of prefer) {
    const k = kids.find((c: Node) => p.test(c.getName()))
    if (k) return k
  }
  return kids[0] ?? null
}

const mirrorName = (n: string) => n.replace(/([_.])l$/, "$1§").replace(/([_.])r$/, "$1l").replace(/§$/, "r")

export function retarget(target: Doc, specs: ClipSpec[], log = console.log) {
  const tNodes = new Map<string, Node>(target.getRoot().listNodes().map((n: Node) => [n.getName(), n]))
  const tRest = restOf(target)
  const tWorldRest = fk(target, tRest)
  const bones: Node[] = target.getRoot().listSkins()[0].listJoints()
  const boneSet = new Set(bones)
  const pelvisT = tNodes.get("pelvis")!

  for (const spec of specs) {
    const src = spec.src
    const anim = src.getRoot().listAnimations().find((a: Node) => a.getName() === spec.clip)
    if (!anim) throw new Error(`no clip ${spec.clip}`)
    const sNodes = new Map<string, Node>(src.getRoot().listNodes().map((n: Node) => [n.getName(), n]))
    const sRest = restOf(src)
    const sWorldRest = fk(src, sRest)
    const map = new Map<Node, Node>()
    for (const [tb, sb] of Object.entries(spec.map)) {
      const tn = tNodes.get(tb)
      const sn = sNodes.get(spec.mirror ? mirrorName(sb) : sb)
      if (tn && sn) map.set(tn, sn)
    }
    // Direction-matched reference rotation per mapped target bone.
    const ref = new Map<Node, Quaternion>()
    for (const [tn, sn] of map) {
      const rest = rotOf(tWorldRest.get(tn)!)
      const tc = aimChild(tn, [/^middle_01/, /^neck/, /^calf/, /^foot/, /^ball/, /^lowerarm/, /^hand/])
      // Aim by the mapped child pairing where possible.
      let sc: Node | null = null
      if (tc) for (const [t2, s2] of map) if (t2 === tc) sc = s2
      const fingers = /^(index|middle|ring|pinky|thumb)/.test(tn.getName())
      if (tc && sc && !/^(pelvis|spine|Root|root)/.test(tn.getName()) && !fingers) {
        const dt = posOf(tWorldRest.get(tc)!).sub(posOf(tWorldRest.get(tn)!)).normalize()
        const ds = posOf(sWorldRest.get(sc)!).sub(posOf(sWorldRest.get(sn)!)).normalize()
        if (spec.mirror) ds.x = -ds.x
        ref.set(tn, new Quaternion().setFromUnitVectors(dt, ds).multiply(rest))
      } else ref.set(tn, rest)
    }

    const channels = new Map<Node, { r?: any; t?: any }>()
    for (const c of anim.listChannels()) {
      const n = c.getTargetNode()
      const e = channels.get(n) ?? {}
      if (c.getTargetPath() === "rotation") e.r = c.getSampler()
      if (c.getTargetPath() === "translation") e.t = c.getSampler()
      channels.set(n, e)
    }
    let t0 = 0
    let t1 = 0
    for (const s of anim.listSamplers()) t1 = Math.max(t1, s.getInput().getMax([])[0])
    if (spec.range) [t0, t1] = spec.range
    const frames = Math.max(2, Math.round((t1 - t0) * FPS) + 1)
    const times = new Float32Array(frames)
    const rotOut = new Map<Node, Float32Array>()
    const pelvisPos = new Float32Array(frames * 3)
    for (const b of bones) rotOut.set(b, new Float32Array(frames * 4))

    const sHip = map.get(pelvisT)!
    const hipScale = posOf(tWorldRest.get(pelvisT)!).y / posOf(sWorldRest.get(sHip)!).y
    const mirrorQ = (q: Quaternion) => q.set(q.x, -q.y, -q.z, q.w)
    const tmp = [0, 0, 0, 0]
    for (let f = 0; f < frames; f++) {
      const t = t0 + ((t1 - t0) * f) / (frames - 1)
      times[f] = (t1 - t0) * (f / (frames - 1))
      const local = new Map<Node, { t: Vector3; r: Quaternion; s: Vector3 }>()
      for (const [n, l] of sRest) {
        const ch = channels.get(n)
        const r = ch?.r ? new Quaternion().fromArray(sample(ch.r, t, 4, tmp)) : l.r.clone()
        const tr = ch?.t ? new Vector3().fromArray(sample(ch.t, t, 3, tmp)) : l.t.clone()
        local.set(n, { t: tr, r, s: l.s })
      }
      const sWorld = fk(src, local)
      // Target world rotations, parents first (joints are listed in skin order; walk hierarchy explicitly).
      const tWorld = new Map<Node, Quaternion>()
      const delta = (tn: Node): Quaternion => {
        const sn = map.get(tn)
        if (sn) {
          const d = rotOf(sWorld.get(sn)!).multiply(rotOf(sWorldRest.get(sn)!).invert())
          return spec.mirror ? mirrorQ(d) : d
        }
        const p = parentOf(tn)
        return p && boneSet.has(p) ? delta(p) : new Quaternion()
      }
      const solve = (tn: Node): Quaternion => {
        const w = tWorld.get(tn)
        if (w) return w
        const base = ref.get(tn) ?? rotOf(tWorldRest.get(tn)!)
        const r = delta(tn).multiply(base)
        tWorld.set(tn, r)
        return r
      }
      for (const b of bones) {
        const p = parentOf(b)
        const pw = p && boneSet.has(p) ? solve(p) : rotOf(p ? tWorldRest.get(p)! : new Matrix4())
        const lr = pw.clone().invert().multiply(solve(b))
        // Keep quaternion hemisphere continuous for clean interpolation.
        const arr = rotOut.get(b)!
        if (f > 0) {
          const dot = arr[(f - 1) * 4]! * lr.x + arr[(f - 1) * 4 + 1]! * lr.y + arr[(f - 1) * 4 + 2]! * lr.z + arr[(f - 1) * 4 + 3]! * lr.w
          if (dot < 0) lr.set(-lr.x, -lr.y, -lr.z, -lr.w)
        }
        lr.toArray(arr, f * 4)
      }
      // Pelvis translation: source hips displacement from rest, scaled; into the pelvis parent's space.
      const dp = posOf(sWorld.get(sHip)!).sub(posOf(sWorldRest.get(sHip)!)).multiplyScalar(hipScale)
      if (spec.mirror) dp.x = -dp.x
      const wp = posOf(tWorldRest.get(pelvisT)!).add(dp)
      const parentInv = tWorldRest.get(parentOf(pelvisT))!.clone().invert()
      wp.applyMatrix4(parentInv).toArray(pelvisPos, f * 3)
    }

    const buffer = target.getRoot().listBuffers()[0]
    const a = target.createAnimation(spec.name)
    const input = target.createAccessor().setType("SCALAR").setArray(times).setBuffer(buffer)
    for (const b of bones) {
      const out = target.createAccessor().setType("VEC4").setArray(rotOut.get(b)!).setBuffer(buffer)
      const s = target.createAnimationSampler().setInput(input).setOutput(out).setInterpolation("LINEAR")
      a.addSampler(s).addChannel(target.createAnimationChannel().setTargetNode(b).setTargetPath("rotation").setSampler(s))
    }
    const pout = target.createAccessor().setType("VEC3").setArray(pelvisPos).setBuffer(buffer)
    const ps = target.createAnimationSampler().setInput(input).setOutput(pout).setInterpolation("LINEAR")
    a.addSampler(ps).addChannel(target.createAnimationChannel().setTargetNode(pelvisT).setTargetPath("translation").setSampler(ps))
    log(`clip ${spec.name.padEnd(14)} ← ${spec.clip} (${(t1 - t0).toFixed(2)} s, ${frames} frames${spec.mirror ? ", mirrored" : ""})`)
  }
}

/** UAL (Quaternius) skeleton → janitor: the same UE-style names, except the head. */
export function ualMap(targetNames: string[]) {
  const m: Record<string, string> = {}
  for (const n of targetNames) m[n] = n === "head" ? "Head" : n
  delete m.Root
  return m
}
