import { Anatomy, add, cross, len as len3, lerp3, madd, norm, sub, Tag, type V3 } from "../kit/anatomy"
import { fbm3, noise3, ridge3, rng } from "../kit/noise"
import { CustomShape, Ellipsoid, Op, RoundCone, SdfModel, smin, smoothstep } from "../kit/sdf"

// The Banshee's body in its bind pose (concept/monsters/banshee-sheet.png, banshee-3.png): it hangs in the air upside
// down and bent backwards. The hips are the highest point, folded up under the burial shroud; the torso arches
// forward and down, chest and ribs facing the viewer; the neck bends back so the head hangs face-forward and upside
// down, the screaming mouth above the sunken eyes; a curtain of long white hair falls from the crown almost to the
// ground; two very long, bony arms hang from the shoulders, elbows splayed wide, ending in huge clawed hands. Facing
// +Z, Y up, left side on +X. About 2.95 m from the shroud's peak to the hair tips.

export type Side = 1 | -1
export const sideName = (s: Side) => (s > 0 ? "L" : "R")

/** Spine from the hips (top) down the arched back to the base of the neck. */
export const SPINE: V3[] = [
  [0, 2.88, -0.44],
  [0, 2.78, -0.26],
  [0, 2.6, -0.09],
  [0, 2.4, 0.05],
  [0, 2.2, 0.15],
]
export const NECK: V3[] = [
  [0, 2.2, 0.15],
  [0, 2.07, 0.23],
  [0, 1.98, 0.3],
]
/** Head centre and its frame: face forward (+Z), crown down (upside down). */
export const HEAD: V3 = [0, 1.8, 0.36]
export const HEAD_FWD: V3 = norm([0, -0.12, 1])
export const HEAD_UP: V3 = norm([0, -1, -0.12])
/** Head scale (the skull is long and gaunt, ~30 cm crown to chin). */
const HS = 1.9

export function armPoints(s: Side) {
  return {
    clav: [s * 0.06, 2.24, 0.2] as V3,
    S: [s * 0.27, 2.25, 0.14] as V3,
    E: [s * 0.7, 1.86, 0.2] as V3,
    W: [s * 0.66, 1.26, 0.32] as V3,
    K: [s * 0.66, 1.0, 0.36] as V3,
  }
}

/** Head space (x right, y toward the crown, z forward, metres before scale) → bind-pose world. */
export function headToWorld(p: V3): V3 {
  const right = norm(cross(HEAD_UP, HEAD_FWD))
  const q = [p[0] * HS, p[1] * HS, p[2] * HS] as V3
  return [
    HEAD[0] + right[0] * q[0] + HEAD_UP[0] * q[1] + HEAD_FWD[0] * q[2],
    HEAD[1] + right[1] * q[0] + HEAD_UP[1] * q[1] + HEAD_FWD[1] * q[2],
    HEAD[2] + right[2] * q[0] + HEAD_UP[2] * q[1] + HEAD_FWD[2] * q[2],
  ]
}

export function buildSkeleton(an: Anatomy) {
  an.bone("root", null, [0, 0, 0])
  an.bone("hips", "root", SPINE[0]!, SPINE[1]!)
  an.bone("spine1", "hips", SPINE[1]!, SPINE[2]!)
  an.bone("spine2", "spine1", SPINE[2]!, SPINE[3]!)
  an.bone("spine3", "spine2", SPINE[3]!, SPINE[4]!)
  an.bone("neck1", "spine3", NECK[0]!, NECK[1]!)
  an.bone("neck2", "neck1", NECK[1]!, NECK[2]!)
  an.bone("head", "neck2", NECK[2]!, HEAD)
  // The jaw is the top of the face (upside down): it opens upward-forward.
  const hinge = headToWorld([0, -0.02, -0.02])
  an.bone("jaw", "head", hinge, headToWorld([0, -0.14, 0.06]))
  an.bone("ribs", "spine2", [0, 2.4, 0.12], [0, 2.3, 0.2])
  for (const s of [1, -1] as Side[]) {
    const n = sideName(s)
    const A = armPoints(s)
    an.bone(`clav${n}`, "spine3", A.clav, A.S)
    an.bone(`uarm${n}`, `clav${n}`, A.S, A.E)
    an.bone(`farm${n}`, `uarm${n}`, A.E, A.W)
    an.bone(`hand${n}`, `farm${n}`, A.W, A.K)
  }
  // Hair hangs from the crown in three links; the animation keeps them hanging under gravity.
  const crown = headToWorld([0, 0.13, -0.03])
  an.bone("hair1", "head", crown, [0, 1.15, crown[2] - 0.01])
  an.bone("hair2", "hair1", [0, 1.15, crown[2] - 0.01], [0, 0.65, crown[2] - 0.02])
  an.bone("hair3", "hair2", [0, 0.65, crown[2] - 0.02], [0, 0.12, crown[2] - 0.03])
  // Shroud panels: back and both sides, two links each, hung from the hips and upper back.
  an.bone("clothB1", "hips", [0, 2.55, -0.42], [0, 1.85, -0.46])
  an.bone("clothB2", "clothB1", [0, 1.85, -0.46], [0, 0.95, -0.5])
  for (const s of [1, -1] as Side[]) {
    const n = sideName(s)
    an.bone(`cloth${n}1`, "spine1", [s * 0.36, 2.45, -0.08], [s * 0.4, 1.8, -0.06])
    an.bone(`cloth${n}2`, `cloth${n}1`, [s * 0.4, 1.8, -0.06], [s * 0.44, 1.05, -0.05])
  }
}

// ------------------------------------------------------------------------------------------------- body

export function buildBody(an: Anatomy) {
  const r = an.r
  const spineBone = (i: number) => (["hips", "spine1", "spine2", "spine3"] as const)[Math.min(3, i)]!
  // Spine and back muscles, arching.
  for (let i = 0; i < SPINE.length - 1; i++) {
    an.fiber(SPINE[i]!, SPINE[i + 1]!, 0.07, 0.068, spineBone(i), { k: 0.06, amp: 0.003 })
    for (const s of [1, -1]) an.fiber(add(SPINE[i]!, [s * 0.06, 0.02, -0.03]), add(SPINE[i + 1]!, [s * 0.06, 0.02, -0.03]), 0.045, 0.045, spineBone(i), { k: 0.04 })
  }
  // Pelvis and the folded legs bunched up under the shroud's peak.
  // Rump and the legs folded tight against it (hidden under the shroud's peak).
  an.ell([0, 2.9, -0.44], [0.19, 0.12, 0.16], "hips", { k: 0.07 })
  for (const s of [1, -1] as Side[]) an.ellAlong([s * 0.12, 2.93, -0.52], [s * 0.12, 2.88, -0.2], 0.075, 0.07, "hips", { k: 0.06 })

  // Ribcage: the chest faces forward and down. Ribs wrap from the spine (back, up) round to the sternum (front).
  const ax = norm(sub(SPINE[4]!, SPINE[1]!))
  const back = norm(cross(cross(ax, [0, 0, -1]), ax)) // perpendicular to the spine, toward the back
  const sideV = norm(cross(ax, back))
  const NR = 11
  const sternum: V3[] = []
  for (let i = 0; i < NR; i++) {
    const f = i / (NR - 1)
    const c = lerp3(SPINE[1]!, SPINE[4]!, 0.08 + f * 0.86)
    const ry = 0.15 + 0.05 * Math.sin(Math.PI * (0.3 + f * 0.7)) // front-back depth
    const rx = 0.13 + 0.05 * Math.sin(Math.PI * (0.2 + f * 0.6)) // half width
    const ctr = madd(c, back, -ry * 0.75)
    const rr = 0.007
    for (const s of [1, -1]) {
      let prev: V3 | null = null
      for (let k = 0; k <= 9; k++) {
        const th = 0.2 + (Math.PI - 0.3) * (k / 9)
        // Ribs slope toward the hips as they come round (a starved, hanging cage).
        const p = madd(madd(madd(ctr, back, Math.cos(th) * ry), sideV, s * Math.sin(th) * rx), ax, -0.03 * (1 - Math.cos(th)))
        if (prev) an.cap(prev, p, rr, rr, "ribs", { k: 0.012 })
        prev = p
      }
      if (s === 1 && i < 10) sternum.push(prev!)
    }
  }
  // The torso under the ribs: one smooth body, sunk just inside the ribs so they read as ridges under skin.
  {
    const a = lerp3(SPINE[1]!, SPINE[4]!, 0.02)
    const b = lerp3(SPINE[1]!, SPINE[4]!, 0.98)
    const c = madd(lerp3(a, b, 0.5), back, -0.12)
    an.ell(c, [0.19, len3(sub(b, a)) * 0.58, 0.17], "ribs", { k: 0.06, axes: [sideV, ax, back] })
  }
  for (let i = 0; i < sternum.length - 1; i++) an.cap([0, sternum[i]![1], sternum[i]![2]], [0, sternum[i + 1]![1], sternum[i + 1]![2]], 0.014, 0.014, "ribs", { k: 0.02 })
  // Sunken belly between the ribs and the hips, a hollow under the ribcage.
  an.fiber(lerp3(SPINE[0]!, SPINE[1]!, 0.5), SPINE[2]!, 0.13, 0.12, "spine1", { k: 0.07 })
  an.hole(an.ell(madd(lerp3(SPINE[1]!, SPINE[2]!, 0.3), back, -0.2), [0.12, 0.07, 0.09], "spine1", { k: 0.05 }))

  // Neck: long, corded, bending back.
  for (let i = 0; i < NECK.length - 1; i++) an.fiber(NECK[i]!, NECK[i + 1]!, 0.05, 0.047, i === 0 ? "neck1" : "neck2", { k: 0.04, amp: 0.003 })
  an.fiber(NECK[2]!, headToWorld([0, -0.05, -0.04]), 0.045, 0.04, "neck2", { k: 0.04 })
  for (const s of [1, -1]) an.fiber(add(NECK[0]!, [s * 0.04, 0, 0.03]), headToWorld([s * 0.04, -0.07, 0.0]), 0.014, 0.012, "neck2", { k: 0.02 })

  // Shoulders and arms.
  for (const s of [1, -1] as Side[]) buildArm(an, s)

  buildHead(an)

  // Skin detail: wrinkled, papery.
  const m = an.model
  m.margin = 0.005
  m.detailBand = 0.005
  m.detail = (x, y, z, d) => d - fbm3(x * 45, y * 45, z * 45, 3) * 0.001 - ridge3(x * 11, y * 11, z * 11, 12) * 0.0009
  void r
}

function buildArm(an: Anatomy, s: Side) {
  const n = sideName(s)
  const A = armPoints(s)
  const r = an.r
  an.cap(A.clav, A.S, 0.016, 0.018, `clav${n}`, { k: 0.02, tag: Tag.Skin })
  an.ell(lerp3(A.clav, A.S, 0.6), [0.07, 0.05, 0.05], `clav${n}`, { k: 0.05 })
  an.knot(A.S, 0.045, `uarm${n}`, { k: 0.025, lumps: 5, tag: Tag.Bone })
  // Upper arm: thin bone and wasted cords.
  an.fiber(A.S, A.E, 0.034, 0.024, `uarm${n}`, { k: 0.025, amp: 0.002 })
  an.ellAlong(lerp3(A.S, A.E, 0.05), lerp3(A.S, A.E, 0.6), 0.034, 0.032, `uarm${n}`, { k: 0.03 })
  an.knot(A.E, 0.035, `farm${n}`, { k: 0.015, lumps: 6, tag: Tag.Bone })
  // Forearm: radius and ulna visibly separate.
  for (const o of [-1, 1]) an.fiber(add(A.E, [0, 0, o * 0.012]), add(A.W, [o * 0.008 * s, 0, o * 0.01]), 0.016, 0.012, `farm${n}`, { k: 0.012, amp: 0.0015 })
  an.ellAlong(A.E, lerp3(A.E, A.W, 0.5), 0.024, 0.022, `farm${n}`, { k: 0.02 })
  an.knot(A.W, 0.026, `hand${n}`, { k: 0.012, lumps: 5, tag: Tag.Bone })
  // Hand: a long palm, then four long fingers and a thumb, knuckled, clawed. The fingers splay and curl.
  const palmDir = norm(sub(A.K, A.W))
  const across: V3 = norm(cross(palmDir, [0, 0, 1]))
  for (let f = 0; f < 4; f++) {
    const off = (f - 1.5) * 0.034
    const base = madd(A.K, across, off * s)
    an.fiber(madd(A.W, across, off * s * 0.4), base, 0.011, 0.011, `hand${n}`, { k: 0.012, amp: 0.001, count: 6 })
    let prev = base
    let parent = `hand${n}`
    const spread = (f - 1.5) * 0.3
    let dir = norm(add(add(palmDir, [Math.sin(spread) * s * 0.7, 0, 0]), [0, 0, 0.1]))
    const lens = [0.14, 0.11, 0.08]
    for (let j = 0; j < 3; j++) {
      dir = norm(add(dir, [0, 0, 0.08]))
      const p = madd(prev, dir, lens[j]! * (f === 0 ? 0.85 : 1))
      const name = `f${f}${n}${j}`
      an.bone(name, parent, prev, p)
      an.knot(prev, 0.014 - j * 0.0012, name, { k: 0.006, lumps: 3, tag: Tag.Bone })
      an.fiber(prev, p, 0.0125 - j * 0.0014, 0.0112 - j * 0.0014, name, { k: 0.008, amp: 0.0008, count: 6 })
      parent = name
      prev = p
    }
    // Long dark claw, hooked.
    let c = prev
    let cd = norm(add(dir, [0, 0, 0.3]))
    for (let k = 0; k < 3; k++) {
      const q = madd(c, cd, 0.028)
      an.cap(c, q, 0.0085 * (1 - k / 3) + 0.0015, 0.0075 * (1 - (k + 1) / 3) + 0.001, `f${f}${n}2`, { k: k === 0 ? 0.006 : 0.0015, tag: Tag.Horn })
      c = q
      cd = norm(add(cd, [0, 0, 0.3]))
    }
  }
  {
    let prev = madd(lerp3(A.W, A.K, 0.4), across, -s * 0.03)
    let parent = `hand${n}`
    let dir = norm([-s * 0.4, -0.7, 0.5])
    for (let j = 0; j < 3; j++) {
      const p = madd(prev, dir, 0.05 - j * 0.008)
      const name = `th${n}${j}`
      an.bone(name, parent, prev, p)
      an.knot(prev, 0.012, name, { k: 0.006, lumps: 2 })
      an.cap(prev, p, j === 2 ? 0.007 : 0.009, j === 2 ? 0.0018 : 0.008, name, { k: 0.006, tag: j === 2 ? Tag.Horn : Tag.Skin })
      parent = name
      prev = p
      dir = norm(add(dir, [0, -0.1, 0.35]))
    }
  }
  void r
}

// ------------------------------------------------------------------------------------------------- head

/** The upside-down screaming head: a gaunt skull in thin skin, a huge open mouth above sunken, near-black eyes. */
function buildHead(an: Anatomy) {
  const m = an.model
  const H = headToWorld
  const head = an.b("head")
  const jaw = an.b("jaw")
  const right = norm(cross(HEAD_UP, HEAD_FWD))
  const axes: [V3, V3, V3] = [right, HEAD_UP, HEAD_FWD]
  const ell = (c: V3, rr: V3, o: { k?: number; op?: Op; bone?: number; tag?: number } = {}) =>
    m.add(new Ellipsoid(H(c), [rr[0] * HS, rr[1] * HS, rr[2] * HS], axes, { bone: o.bone ?? head, k: (o.k ?? 0.02) * HS, op: o.op, tag: o.tag }))
  const cap = (a: V3, b: V3, ra: number, rb: number, o: { k?: number; op?: Op; bone?: number; tag?: number } = {}) =>
    m.add(new RoundCone(H(a), H(b), ra * HS, rb * HS, { bone: o.bone ?? head, k: (o.k ?? 0.015) * HS, op: o.op, tag: o.tag }))
  // Cranium (crown down), temples hollowed.
  ell([0, 0.06, -0.02], [0.082, 0.085, 0.095], { k: 0.03 })
  for (const s of [1, -1]) ell([s * 0.085, 0.02, 0.03], [0.02, 0.04, 0.035], { k: 0.02, op: Op.Sub })
  // Brow ridge, cheekbones, gaunt cheeks.
  ell([0, 0.045, 0.075], [0.07, 0.022, 0.03], { k: 0.025 })
  for (const s of [1, -1]) {
    cap([s * 0.06, -0.015, 0.06], [s * 0.075, -0.01, 0.0], 0.016, 0.012, { k: 0.02 })
    ell([s * 0.045, -0.04, 0.06], [0.022, 0.03, 0.02], { k: 0.02, op: Op.Sub })
    // Sockets: deep, with small dark eyes far back.
    ell([s * 0.033, 0.018, 0.085], [0.024, 0.02, 0.025], { k: 0.012, op: Op.Sub })
    ell([s * 0.033, 0.018, 0.07], [0.012, 0.012, 0.012], { k: 0.004, tag: Tag.Horn })
  }
  // Nose: no cartilage, two slits.
  ell([0, -0.012, 0.088], [0.016, 0.022, 0.016], { k: 0.015 })
  for (const s of [1, -1]) ell([s * 0.007, -0.022, 0.1], [0.004, 0.011, 0.012], { k: 0.003, op: Op.Sub })
  // Upper jaw (below the nose here, i.e. toward the chin side) and the mouth: a tall oval gash.
  ell([0, -0.06, 0.06], [0.05, 0.035, 0.04], { k: 0.025 })
  // Lower jaw: hangs open upward (it's the top of the face), long and stretched.
  cap([0.052, -0.04, 0.02], [0.036, -0.17, 0.05], 0.016, 0.014, { bone: jaw, k: 0.025 })
  cap([-0.052, -0.04, 0.02], [-0.036, -0.17, 0.05], 0.016, 0.014, { bone: jaw, k: 0.025 })
  ell([0, -0.18, 0.05], [0.03, 0.022, 0.026], { bone: jaw, k: 0.025 })
  // Cheek skin stretched between the jaws (the mouth's sides).
  for (const s of [1, -1]) cap([s * 0.042, -0.06, 0.05], [s * 0.032, -0.15, 0.06], 0.011, 0.009, { bone: jaw, k: 0.02 })
  // The mouth: carved deep, with gums and teeth on both jaws.
  cap([0, -0.075, 0.12], [0, -0.155, 0.11], 0.037, 0.029, { k: 0.012, op: Op.Sub })
  ell([0, -0.11, 0.06], [0.03, 0.06, 0.04], { k: 0.01, op: Op.Sub })
  const r = an.r
  for (let i = 0; i < 9; i++) {
    const a = (i / 8 - 0.5) * 2.2
    const root: V3 = [Math.sin(a) * 0.03, -0.072 + Math.abs(Math.sin(a)) * 0.006, 0.075 + Math.cos(a) * 0.02]
    cap(root, add(root, [0, -0.012 - r() * 0.01, 0.004]), 0.0042, 0.0012, { k: 0.002, tag: Tag.Tooth })
    const root2: V3 = [Math.sin(a) * 0.026, -0.158 - Math.abs(Math.sin(a)) * 0.004, 0.08 + Math.cos(a) * 0.015]
    cap(root2, add(root2, [0, 0.011 + r() * 0.01, 0.004]), 0.004, 0.0012, { bone: jaw, k: 0.002, tag: Tag.Tooth })
  }
}

// ------------------------------------------------------------------------------------------------- hair

/**
 * A curtain of long white hair falling from the crown nearly to the ground: ~220 wavy clumps of different lengths,
 * thick at the roots and splitting into wisps toward ragged tips, over a hidden core so it never reads see-through.
 */
export function buildHair(an: Anatomy): SdfModel {
  const m = new SdfModel()
  const r = rng(303)
  const bone = (y: number) => an.b(y > 1.15 ? "hair1" : y > 0.65 ? "hair2" : "hair3")
  const crown = headToWorld([0, 0.13, -0.03])
  // Roots all round the crown and the back of the skull. Each clump falls to its own place in a full curtain that
  // widens to ~0.5 m by mid-length and frays at the tips, waving and crossing its neighbours.
  for (let i = 0; i < 330; i++) {
    const a = r() * Math.PI * 2
    const rr = 0.025 + Math.sqrt(r()) * 0.05
    const root = headToWorld([Math.cos(a) * rr, 0.08 + r() * 0.05, Math.sin(a) * rr * 0.8 - 0.02])
    const ang = Math.atan2(root[0] - crown[0], (root[2] - crown[2]) * 1.4) + (r() - 0.5) * 0.5
    const rad = 0.55 + r() * 0.5
    const len = 1.05 + r() * 0.55
    const r0 = 0.006 + r() * 0.006
    const segs = Math.round(len / 0.04)
    let p = root
    const phase = r() * 6.28
    const wav = 0.012 + r() * 0.025
    const freq = 5 + r() * 6
    for (let k = 0; k < segs; k++) {
      const t = (k + 1) / segs
      const R = (0.06 + 0.24 * Math.sqrt(t) * (1 - 0.25 * t)) * rad
      const q: V3 = [crown[0] + Math.sin(ang) * R + Math.sin(t * freq + phase) * wav, root[1] - len * t, crown[2] + Math.cos(ang) * R * 0.45 + Math.cos(t * freq * 0.8 + phase) * wav * 0.6]
      const ra = Math.max(0.0028, r0 * (1 - (k / segs) * 0.7))
      const rb = Math.max(0.0028, r0 * (1 - t * 0.7))
      m.add(new RoundCone(p, q, ra, rb, { bone: bone((p[1] + q[1]) / 2), tag: Tag.Skin, k: 0.005 }))
      p = q
      if (t > 0.45 && r() < 0.07) {
        let w = p
        const wd: V3 = norm([r() - 0.5, -2.5, r() - 0.5])
        for (let j = 0; j < 4; j++) {
          const wq = madd(w, wd, 0.05)
          m.add(new RoundCone(w, wq, 0.0029, 0.0028, { bone: bone(w[1]), tag: Tag.Skin, k: 0.002 }))
          w = wq
        }
      }
    }
  }
  // Hidden core (keeps the curtain opaque between clumps), slimmer than the clumps' spread.
  const core = new CustomShape(
    (x, y, z) => {
      const t = Math.max(0, Math.min(1, (crown[1] - y) / 1.1))
      const w = 0.06 + 0.17 * Math.sqrt(t)
      const dz = 0.04 + 0.06 * Math.sqrt(t)
      const q = Math.hypot(x / w, (z - crown[2] + 0.01) / dz)
      return Math.max((q - 1) * Math.min(w, dz), y - crown[1] + 0.02, 0.45 - y)
    },
    [-0.25, 0.4, crown[2] - 0.12],
    [0.25, crown[1], crown[2] + 0.12],
    { bone: an.b("hair2"), k: 0.01, axis: [0, 1, 0], fibre: 1 },
  )
  m.add(core)
  m.margin = 0.003
  return m
}

/** Hair hangs freely below the crown. */
export function hairDangle(p: V3) {
  return smoothstep(1.6, 0.4, p[1])
}

// ------------------------------------------------------------------------------------------------- shroud

/**
 * The burial shroud: one cloth shell draped over the folded hips and down the back and sides, open at the front
 * where the chest, arms and head come out. Vertical drape folds, a ragged hem of long torn strips, rents and holes.
 * Split into overlapping bands per shroud bone so it skins to the hanging links.
 */
export function buildShroud(an: Anatomy): SdfModel {
  const m = new SdfModel()
  const T = 0.0045
  const top: V3 = [0, 2.86, -0.18]
  const field = (x: number, y: number, z: number) => {
    // Envelope: a dome over the hips flowing into a flared, flattened tube.
    // The body arches forward as it goes down: the shroud follows the spine, then falls straight below the head.
    const zc = shroudZ(y)
    const yy = Math.min(y, 2.85)
    const fall = Math.max(0, 2.2 - y)
    const rx = 0.32 + Math.min(0.2, Math.max(0, 3.0 - y) * 0.3) + fall * 0.08
    const rz = 0.36 + fall * 0.03
    const dx = x / rx
    const dz = (z - zc) / rz
    const dy = Math.max(0, y - yy) / 0.36
    const q = Math.sqrt(dx * dx + dz * dz + dy * dy)
    let d = (q - 1) * Math.min(rx, rz)
    const th = Math.atan2(x, z - zc)
    // Drape folds, deeper toward the hem.
    const fold = Math.sin(th * 7 + noise3(th * 1.5, y * 1.2, 3.1) * 2.5) * (0.014 + fall * 0.035) + noise3(th * 3, y * 2, 7) * (0.012 + fall * 0.02)
    d -= fold
    let shell = Math.abs(d) - T
    // Front opening: wide at the chest, closing over the hips.
    // The chest, arms and face show through a front opening that starts just above the chest.
    const open = Math.max(0, Math.min(0.85, (2.3 - y) * 2.2)) + noise3(y * 6, 1, 2) * 0.12
    shell = Math.max(shell, (open - Math.abs(th)) * 0.25)
    // Ragged hem: long torn strips at the sides, longer down the back.
    const back = Math.abs(th) / Math.PI
    const strip = Math.abs(Math.sin(th * 14 + noise3(th * 3, 0, 5) * 3))
    const hem = 1.5 - back * 0.5 - Math.pow(strip, 3) * 0.6 + noise3(th * 5, 2, 9) * 0.08
    shell = Math.max(shell, hem - y)
    // Rents and holes.
    const tear = fbm3(th * 2.2, y * 2.6, 4.4, 3)
    shell = Math.max(shell, (tear - 0.38) * 0.06 * smoothstep(2.6, 2.0, y))
    void top
    return shell
  }
  const bands: [number, number, string][] = [
    [1.85, 3.25, "clothB1"],
    [0.6, 1.92, "clothB2"],
  ]
  // Back panel bands vs side panels: split by angle too, so each panel follows its own bone.
  for (const [y0, y1, boneB] of bands) {
    for (const panel of ["B", "L", "R"] as const) {
      const bName = panel === "B" ? boneB : `cloth${panel}${boneB.endsWith("1") ? 1 : 2}`
      const lo = panel === "B" ? 0.62 : 0
      const hi = panel === "B" ? 1.01 : 0.68
      const sgn = panel === "L" ? 1 : panel === "R" ? -1 : 0
      m.add(
        new CustomShape(
          (x, y, z) => {
            const th = Math.atan2(x, z - shroudZ(y)) / Math.PI
            const a = panel === "B" ? Math.abs(th) : sgn * th
            const clipA = Math.max(lo - 0.04 - a, a - hi - 0.04) * 0.3
            const clipY = Math.max(y0 - 0.04 - y, y - y1 - 0.04)
            return Math.max(field(x, y, z), clipA, clipY)
          },
          [panel === "R" ? -0.7 : panel === "L" ? -0.05 : -0.7, Math.max(0.6, y0 - 0.05), -0.75],
          [panel === "L" ? 0.7 : panel === "R" ? 0.05 : 0.7, Math.min(3.25, y1 + 0.05), 0.7],
          { bone: an.b(bName), k: 0, axis: [0, 1, 0], fibre: 0.2, tag: Tag.Skin },
        ),
      )
    }
  }
  m.margin = 0.004
  void smin
  return m
}

/** The shroud's centre line: over the rump at the top, coming forward over the back, falling behind the head. */
function shroudZ(y: number) {
  return -0.44 + Math.min(0.4, Math.max(0, 3.0 - y) * 0.55)
}

export function shroudDangle(p: V3) {
  return smoothstep(2.5, 1.0, p[1])
}

/** Stains: earth and rot toward the hem, blood near the mouth and on the claws. */
export function paintBody(p: V3): [number, number, number] {
  const nz = fbm3(p[0] * 8, p[1] * 8, p[2] * 8, 3)
  const mouth = Math.max(0, 1 - Math.hypot(p[0], p[1] - 1.85, p[2] - 0.38) / 0.1)
  const hands = smoothstep(1.05, 0.85, p[1]) * smoothstep(0.4, 0.5, Math.abs(p[0]))
  return [Math.max(0, Math.min(1, 0.2 + nz * 0.4)), Math.max(0, Math.min(1, (mouth * 1.2 + hands * 0.7) * (0.5 + nz))), 0]
}

export function paintShroud(p: V3): [number, number, number] {
  const nz = fbm3(p[0] * 5, p[1] * 5, p[2] * 5, 4)
  const hem = smoothstep(1.6, 0.8, p[1])
  return [Math.max(0, Math.min(1, 0.15 + nz * 0.7 + hem * 0.5)), 0, 0]
}

export function paintHair(p: V3): [number, number, number] {
  const nz = fbm3(p[0] * 6, p[1] * 3, p[2] * 6, 3)
  return [Math.max(0, Math.min(1, smoothstep(0.9, 0.2, p[1]) * 0.6 + nz * 0.25)), 0, 0]
}
