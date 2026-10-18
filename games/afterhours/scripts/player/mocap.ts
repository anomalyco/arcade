// Real human locomotion for the janitor: 100STYLE "Neutral" motion capture (Mason, Starke, Komura 2022, CC BY 4.0)
// cut into in-place loops and transferred onto the janitor's skeleton. Used by scripts/player/build-body.ts after
// rebind.ts has put the skeleton on UAL rest frames.
//
// Transfer: both skeletons rest in a T-pose facing +Z, and every BVH joint's rest rotation is identity, so a source
// joint's world rotation *is* its rotation from rest. Each target bone gets that rotation applied to its own rest
// orientation, first swung so the target bone points where the source bone points at rest (so small rest-pose
// differences don't become pose errors):   W_target(t) = W_source(t) · swing · W_target,rest
// Fingers are not captured (the hand-pose layer in src/player/hands.ts poses them). The pelvis gets the hips'
// translation, scaled by hip height, with the walk's forward travel removed (an in-place loop; the controller moves
// the body) but its bob and sway kept.
//
// Cutting a loop: a window where the actor walks straight and steadily, turned so travel is +Z; whole gait cycles
// from one left-foot contact to another; the small pose mismatch at the seam spread across the loop.
import { Matrix4, Quaternion, Vector3 } from "three"
import { frameWorld, parseBvh, type Bvh } from "./bvh"

type Doc = any
type Node = any

export const MOCAP_MAP: Record<string, string> = {
  pelvis: "Hips",
  spine_01: "Chest",
  spine_02: "Chest2",
  spine_03: "Chest4",
  neck_01: "Neck",
  Head: "Head",
  clavicle_l: "LeftCollar",
  upperarm_l: "LeftShoulder",
  lowerarm_l: "LeftElbow",
  hand_l: "LeftWrist",
  clavicle_r: "RightCollar",
  upperarm_r: "RightShoulder",
  lowerarm_r: "RightElbow",
  hand_r: "RightWrist",
  thigh_l: "LeftHip",
  calf_l: "LeftKnee",
  foot_l: "LeftAnkle",
  ball_l: "LeftToe",
  thigh_r: "RightHip",
  calf_r: "RightKnee",
  foot_r: "RightAnkle",
  ball_r: "RightToe",
}

export type MocapClip = {
  name: string
  file: string
  /** Search window (seconds) and how many gait cycles to keep. */
  from: number
  to: number
  cycles: number
  /** Not locomotion (idle): keep a fixed window [from, to) and only remove drift. */
  still?: boolean
  /** Mirror left/right (a strafe the other way). */
  mirror?: boolean
}

/** How much of the actor's own head/neck motion to keep relative to the chest (the 100STYLE actor looks at the floor). */
const HEAD_KEEP = 0.1
const ARM = /^(upperarm|lowerarm)_[lr]$/
/** Palm tipped back from facing the thigh (radians): relaxed arms carry the palms slightly backward. */
const PRONATE = 0.3

const trs = (n: Node) => new Matrix4().compose(new Vector3(...n.getTranslation()), new Quaternion(...n.getRotation()), new Vector3(...n.getScale()))
const rotOf = (m: Matrix4) => {
  const t = new Vector3()
  const q = new Quaternion()
  const s = new Vector3()
  m.decompose(t, q, s)
  return q
}

export function bakeMocap(doc: Doc, dir: string, clips: MocapClip[], read: (f: string) => string, log = console.log) {
  const root = doc.getRoot()
  const nodes: Node[] = root.listNodes()
  const byName = new Map<string, Node>(nodes.map((n: Node) => [n.getName(), n]))
  const world = new Map<Node, Matrix4>()
  const W = (n: Node): Matrix4 => {
    const c = world.get(n)
    if (c) return c
    const p = n.getParentNode()
    const m = p ? new Matrix4().multiplyMatrices(W(p), trs(n)) : trs(n)
    world.set(n, m)
    return m
  }
  const pelvis = byName.get("pelvis")!
  const cache = new Map<string, Bvh>()
  for (const spec of clips) {
    const bvh = cache.get(spec.file) ?? parseBvh(read(`${dir}/${spec.file}`))
    cache.set(spec.file, bvh)
    const J0 = new Map(bvh.joints.map((j, i) => [j.name, i]))
    const swapLR = (n: string) => n.replace(/^Left/, "§").replace(/^Right/, "Left").replace(/^§/, "Right")
    // Swing etc. use the unmirrored map; sampling reads the opposite side's joint when mirrored.
    const J = J0
    const src = (name: string) => J0.get(spec.mirror ? swapLR(name) : name)!
    const reflect = (q: Quaternion) => (spec.mirror ? q.set(q.x, -q.y, -q.z, q.w) : q)
    const rest = frameWorld(bvh, -1)
    // Swing per mapped bone: target rest bone direction → source rest bone direction (model space; both face +Z).
    const swing = new Map<string, Quaternion>()
    const childOf: Record<string, string> = {
      pelvis: "spine_01", spine_01: "spine_02", spine_02: "spine_03", spine_03: "neck_01", neck_01: "Head",
      clavicle_l: "upperarm_l", upperarm_l: "lowerarm_l", lowerarm_l: "hand_l", hand_l: "middle_01_l",
      clavicle_r: "upperarm_r", upperarm_r: "lowerarm_r", lowerarm_r: "hand_r", hand_r: "middle_01_r",
      thigh_l: "calf_l", calf_l: "foot_l", foot_l: "ball_l", thigh_r: "calf_r", calf_r: "foot_r", foot_r: "ball_r",
    }
    const srcChild = (s: string) => {
      const i = J.get(s)!
      const k = bvh.joints.findIndex((j) => j.parent === i)
      return k >= 0 ? rest.wp[k]! : rest.wp[i]!.clone().add(bvh.joints[i]!.end ?? new Vector3(0, 1, 0))
    }
    for (const [t, s] of Object.entries(MOCAP_MAP)) {
      const tn = byName.get(t)
      const tc = byName.get(childOf[t] ?? "")
      if (!tn || !J.has(s) || !tc || t === "pelvis" || t === "Head") {
        swing.set(t, new Quaternion())
        continue
      }
      const dt = new Vector3().setFromMatrixPosition(W(tc)).sub(new Vector3().setFromMatrixPosition(W(tn))).normalize()
      const ds = srcChild(s).clone().sub(rest.wp[J.get(s)!]!).normalize()
      swing.set(t, new Quaternion().setFromUnitVectors(dt, ds))
    }

    // Palm normals at rest (model space), per side.
    const palmRest = new Map<string, Vector3>()
    for (const sfx of ["_l", "_r"]) {
      const P = (n: string) => new Vector3().setFromMatrixPosition(W(byName.get(n + sfx)!))
      const along = P("middle_01").sub(P("hand")).normalize()
      const across = P("pinky_01").sub(P("index_01")).normalize()
      palmRest.set(sfx, new Vector3().crossVectors(along, across).multiplyScalar(sfx === "_r" ? 1 : -1).normalize())
    }

    // ---- choose frames
    const fps = 1 / bvh.dt
    const hips = J.get("Hips")!
    const lAnk = src("LeftAnkle")
    const f0 = Math.round(spec.from * fps)
    const f1 = Math.min(bvh.frames - 1, Math.round(spec.to * fps))
    let a = f0
    let b = f1
    if (!spec.still) {
      // Left-foot contacts: the ankle at its lowest and nearly still (cm/frame).
      const h: number[] = []
      const sp: number[] = []
      let prev = frameWorld(bvh, f0 - 1).wp[lAnk]!
      for (let f = f0; f <= f1; f++) {
        const p = frameWorld(bvh, f).wp[lAnk]!
        h.push(p.y)
        sp.push(Math.hypot(p.x - prev.x, p.z - prev.z) * fps)
        prev = p
      }
      const minH = Math.min(...h)
      const contacts: number[] = []
      for (let k = 1; k < h.length; k++) {
        const on = h[k]! < minH + 3 && sp[k]! < 80
        const was = h[k - 1]! < minH + 3 && sp[k - 1]! < 80
        if (on && !was && (!contacts.length || k - contacts[contacts.length - 1]! > fps * 0.4)) contacts.push(k)
      }
      if (contacts.length < spec.cycles + 1) throw new Error(`${spec.name}: only ${contacts.length} left contacts in ${spec.from}..${spec.to}s`)
      a = f0 + contacts[0]!
      b = f0 + contacts[spec.cycles]!
    }
    const n = b - a
    // Heading: the travel direction over the loop, turned to +Z (travel offset for back/side clips).
    const pa = frameWorld(bvh, a).wp[hips]!
    const pb = frameWorld(bvh, b).wp[hips]!
    const travel = Math.atan2(pb.x - pa.x, pb.z - pa.z)
    const heading = facing(bvh, a, b)
    const unturn = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -heading)
    const scale = new Vector3().setFromMatrixPosition(W(pelvis)).y / (rest.wp[hips]!.y || 1)
    // Per-frame target local rotations.
    const targets = Object.keys(MOCAP_MAP).filter((t) => byName.has(t))
    const order = nodes.filter((nd) => targets.includes(nd.getName()))
    const restW = new Map(order.map((nd) => [nd.getName(), rotOf(W(nd))]))
    const tracks = new Map<string, Float32Array>(targets.map((t) => [t, new Float32Array((n + 1) * 4)]))
    const pos = new Float32Array((n + 1) * 3)
    const pelvisParentW = W(pelvis.getParentNode())
    const pelvisParentInvQ = rotOf(pelvisParentW).invert()
    const pelvisParentInv = pelvisParentW.clone().invert()
    for (let k = 0; k <= n; k++) {
      const fw = frameWorld(bvh, a + k)
      const worldQ = new Map<string, Quaternion>()
      for (const t of targets) {
        const sq = reflect(unturn.clone().multiply(fw.wq[src(MOCAP_MAP[t]!)]!))
        let q = sq.multiply(swing.get(t)!).multiply(restW.get(t)!)
        // Arms: 100STYLE has no forearm-roll markers, so the captured twist is unreliable (one palm faced forward, the
        // other back). Keep only the captured *direction* of the upper arm and forearm, reached from the rest T-pose by
        // the shortest swing: a T-pose palm-down hand that swings down to the side ends palm-in, against the thigh, the
        // way a relaxed arm hangs; then a little pronation (palm slightly back), as real relaxed arms carry.
        if (ARM.test(t)) {
          const nd = byName.get(t)!
          const child = byName.get(childOf[t]!)!
          const restDir = new Vector3().setFromMatrixPosition(W(child)).sub(new Vector3().setFromMatrixPosition(W(nd))).normalize()
          const dir = restDir.clone().applyQuaternion(q.clone().multiply(restW.get(t)!.clone().invert()))
          q = new Quaternion().setFromUnitVectors(restDir, dir).multiply(restW.get(t)!)
          if (t.startsWith("lowerarm")) {
            // Forearm roll: turn about the forearm until the palm faces the thigh, tipped back by PRONATE (both sides
            // the same, whatever path the swing took).
            const sfx = t.slice(-2)
            const palm = palmRest.get(sfx)!.clone().applyQuaternion(q.clone().multiply(restW.get(t)!.clone().invert()))
            const medial = new Vector3(sfx === "_r" ? 1 : -1, 0, 0)
            const want = medial.multiplyScalar(Math.cos(PRONATE)).add(new Vector3(0, 0, -Math.sin(PRONATE)))
            const flat = (v: Vector3) => v.addScaledVector(dir, -v.dot(dir)).normalize()
            const a = flat(palm.clone())
            const b = flat(want.clone())
            const ang = Math.atan2(new Vector3().crossVectors(a, b).dot(dir), a.dot(b))
            q = new Quaternion().setFromAxisAngle(dir, ang).multiply(q)
          }
        }
        worldQ.set(t, q)
      }
      for (const t of targets) {
        const nd = byName.get(t)!
        const p = nd.getParentNode()
        const pq = worldQ.get(p.getName()) ?? rotOf(W(p))
        let lq = pq.clone().invert().multiply(worldQ.get(t)!)
        if (t === "neck_01" || t === "Head") lq = new Quaternion(...nd.getRotation()).slerp(lq, HEAD_KEEP)
        // 100STYLE has no hand markers: its wrist channel is noise that bends the hand off the forearm. A relaxed
        // walking wrist is nearly straight, so keep the rest (straight) wrist; the runtime hand layer adds the rest.
        if (t === "hand_l" || t === "hand_r") lq = new Quaternion(...nd.getRotation())
        const arr = tracks.get(t)!
        if (k > 0 && arr[(k - 1) * 4]! * lq.x + arr[(k - 1) * 4 + 1]! * lq.y + arr[(k - 1) * 4 + 2]! * lq.z + arr[(k - 1) * 4 + 3]! * lq.w < 0) lq.set(-lq.x, -lq.y, -lq.z, -lq.w)
        lq.toArray(arr, k * 4)
      }
      // Hips: in place (travel trend removed), turned, scaled.
      const u = n ? k / n : 0
      const hp = fw.wp[hips]!.clone().sub(pa.clone().lerp(pb, u)).applyQuaternion(unturn)
      if (spec.mirror) hp.x = -hp.x
      hp.multiplyScalar(scale / 100)
      hp.y = (fw.wp[hips]!.y * scale) / 100
      hp.applyMatrix4(pelvisParentInv).toArray(pos, k * 3)
      void pelvisParentInvQ
    }
    // Seam: spread the end-vs-start mismatch over the loop so the last frame equals the first.
    for (const arr of tracks.values()) {
      const q0 = new Quaternion().fromArray(arr, 0)
      const qn = new Quaternion().fromArray(arr, n * 4)
      const err = q0.clone().multiply(qn.clone().invert()) // qn → q0
      for (let k = 0; k <= n; k++) {
        const c = new Quaternion().slerp(err, k / n)
        const q = c.multiply(new Quaternion().fromArray(arr, k * 4))
        q.toArray(arr, k * 4)
      }
    }
    for (let c = 0; c < 3; c++) {
      const e = pos[c]! - pos[n * 3 + c]!
      for (let k = 0; k <= n; k++) pos[k * 3 + c]! += (e * k) / n
    }
    // Write the clip.
    const buffer = root.listBuffers()[0]
    const anim = doc.createAnimation(spec.name)
    const times = new Float32Array(n + 1).map((_, k) => k / fps)
    const input = doc.createAccessor().setType("SCALAR").setArray(times).setBuffer(buffer)
    for (const [t, arr] of tracks) {
      const out = doc.createAccessor().setType("VEC4").setArray(arr).setBuffer(buffer)
      const s = doc.createAnimationSampler().setInput(input).setOutput(out).setInterpolation("LINEAR")
      anim.addSampler(s).addChannel(doc.createAnimationChannel().setTargetNode(byName.get(t)).setTargetPath("rotation").setSampler(s))
    }
    const out = doc.createAccessor().setType("VEC3").setArray(pos).setBuffer(buffer)
    const s = doc.createAnimationSampler().setInput(input).setOutput(out).setInterpolation("LINEAR")
    anim.addSampler(s).addChannel(doc.createAnimationChannel().setTargetNode(pelvis).setTargetPath("translation").setSampler(s))
    const dist = Math.hypot(pb.x - pa.x, pb.z - pa.z) / 100
    const rel = (((travel - heading) * 180) / Math.PI + 540) % 360 - 180
    log(`mocap ${spec.name.padEnd(12)} ← ${spec.file} ${(a / fps).toFixed(2)}–${(b / fps).toFixed(2)} s, ${spec.cycles} cycle(s), ${(dist / (n / fps)).toFixed(2)} m/s, travel ${rel.toFixed(0)}° from facing`)
  }
}

/** Mean facing (yaw of the hips' forward) over [a, b). */
function facing(bvh: Bvh, a: number, b: number) {
  const hips = bvh.joints.findIndex((j) => j.name === "Hips")
  let sx = 0
  let sz = 0
  for (let f = a; f < b; f += 4) {
    const fwd = new Vector3(0, 0, 1).applyQuaternion(frameWorld(bvh, f).wq[hips]!)
    sx += fwd.x
    sz += fwd.z
  }
  return Math.atan2(sx, sz)
}
