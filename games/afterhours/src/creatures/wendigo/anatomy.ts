import { Anatomy, add, lerp3, madd, norm, sub, Tag, type V3 } from "../kit/anatomy"
import { fbm3, rng } from "../kit/noise"
import { RoundCone, SdfModel, smoothstep } from "../kit/sdf"

// The Wendigo's body in its bind pose: a starving quadruped (concept/monsters/wendigo-3.png and wendigo-sheet.png),
// facing +Z with its feet on y = 0 and its left side on +X. Hairless grey sinew over bone: a deep keel of too many
// ribs, a thorned spine, a tucked waist, long limbs of wrapped cords with knotted burl joints, backward hocks, finger-
// like forefeet with arched five-jointed fingers, and strings of dried tissue hanging from the belly and rump.

export const HEAD_POS: V3 = [0, 1.22, 1.02]
/** Skull pitch in the bind pose (snout down), radians. */
export const HEAD_PITCH = (80 * Math.PI) / 180

export type Side = 1 | -1
export const sideName = (s: Side) => (s > 0 ? "L" : "R")

/** Limb landmarks, also used by the animation for rest lengths. */
export function limbPoints(s: Side) {
  return {
    scap: [s * 0.1, 1.62, 0.36] as V3,
    S: [s * 0.25, 1.38, 0.47] as V3,
    E: [s * 0.34, 0.93, 0.35] as V3,
    W: [s * 0.39, 0.43, 0.5] as V3,
    M: [s * 0.42, 0.07, 0.58] as V3,
    H: [s * 0.18, 1.42, -0.5] as V3,
    K: [s * 0.27, 0.94, -0.1] as V3,
    A: [s * 0.3, 0.52, -0.74] as V3,
    F: [s * 0.32, 0.07, -0.5] as V3,
  }
}

export function buildBody(an: Anatomy) {
  const m = an.model
  const r = an.r

  // ------------------------------------------------------------------ skeleton
  an.bone("root", null, [0, 0, 0])
  an.bone("hips", "root", [0, 1.47, -0.48], [0, 1.53, -0.3])
  an.bone("spine1", "hips", [0, 1.53, -0.3], [0, 1.58, -0.1])
  an.bone("spine2", "spine1", [0, 1.58, -0.1], [0, 1.62, 0.1])
  an.bone("spine3", "spine2", [0, 1.62, 0.1], [0, 1.61, 0.3])
  an.bone("spine4", "spine3", [0, 1.61, 0.3], [0, 1.57, 0.48])
  an.bone("neck1", "spine4", [0, 1.57, 0.48], [0, 1.58, 0.66])
  an.bone("neck2", "neck1", [0, 1.58, 0.66], [0, 1.47, 0.85])
  an.bone("neck3", "neck2", [0, 1.47, 0.85], HEAD_POS)
  const snout: V3 = [0, -Math.sin(HEAD_PITCH), Math.cos(HEAD_PITCH)]
  an.bone("head", "neck3", HEAD_POS, madd(HEAD_POS, snout, 0.3))
  const jawPivot = madd(madd(HEAD_POS, snout, 0.1), [0, Math.cos(HEAD_PITCH), Math.sin(HEAD_PITCH)], -0.01)
  an.bone("jaw", "head", jawPivot, madd(jawPivot, snout, 0.3))
  an.bone("ribs", "spine3", [0, 1.36, 0.14], [0, 1.1, 0.14])
  an.bone("belly", "spine1", [0, 1.4, -0.25], [0, 1.25, -0.25])
  an.bone("tail1", "hips", [0, 1.42, -0.68], [0, 1.22, -0.74])
  an.bone("tail2", "tail1", [0, 1.22, -0.74], [0, 0.95, -0.76])

  for (const s of [1, -1] as Side[]) {
    const n = sideName(s)
    const L = limbPoints(s)
    an.bone(`scap${n}`, "spine4", L.scap, L.S)
    an.bone(`uarm${n}`, `scap${n}`, L.S, L.E)
    an.bone(`farm${n}`, `uarm${n}`, L.E, L.W)
    an.bone(`hand${n}`, `farm${n}`, L.W, L.M)
    an.bone(`thigh${n}`, "hips", L.H, L.K)
    an.bone(`shin${n}`, `thigh${n}`, L.K, L.A)
    an.bone(`meta${n}`, `shin${n}`, L.A, L.F)
  }

  // ------------------------------------------------------------------ spine line helper
  const spinePts: V3[] = [
    [0, 1.44, -0.7],
    [0, 1.5, -0.5],
    [0, 1.55, -0.3],
    [0, 1.6, -0.1],
    [0, 1.63, 0.1],
    [0, 1.62, 0.3],
    [0, 1.57, 0.48],
  ]
  const spineAt = (z: number): V3 => {
    for (let i = 0; i < spinePts.length - 1; i++) {
      const a = spinePts[i]!
      const b = spinePts[i + 1]!
      if (z <= b[2] || i === spinePts.length - 2) return lerp3(a, b, Math.max(0, Math.min(1, (z - a[2]) / (b[2] - a[2]))))
    }
    return spinePts[0]!
  }
  const spineBone = (z: number) => (z < -0.36 ? "hips" : z < -0.12 ? "spine1" : z < 0.1 ? "spine2" : z < 0.3 ? "spine3" : "spine4")

  // ------------------------------------------------------------------ vertebral column (under the skin)
  for (let i = 0; i < spinePts.length - 1; i++) {
    const a = spinePts[i]!
    const b = spinePts[i + 1]!
    an.fiber(a, b, 0.055, 0.055, spineBone((a[2] + b[2]) / 2), { k: 0.05, amp: 0.003 })
    // Long back muscles either side, wasted to cords.
    for (const s of [1, -1]) an.fiber(add(a, [s * 0.055, -0.015, 0]), add(b, [s * 0.055, -0.015, 0]), 0.05, 0.05, spineBone((a[2] + b[2]) / 2), { k: 0.03, amp: 0.002 })
  }

  // ------------------------------------------------------------------ ribcage: sixteen pairs, a deep starved keel
  const NR = 16
  const ribFront: V3[] = []
  for (let i = 0; i < NR; i++) {
    const f = i / (NR - 1)
    const z0 = 0.42 - f * 0.6
    const top = spineAt(z0)
    const ay = 0.27 + 0.14 * Math.sin(Math.PI * Math.min(1, (i + 2) / 13)) - f * 0.06
    const ax = 0.19 + 0.07 * Math.sin(Math.PI * Math.min(1, (i + 1.5) / 14)) + (f > 0.6 ? (f - 0.6) * 0.05 : 0)
    const cy = top[1] - 0.03 - ay
    const thMax = i < 10 ? Math.PI : Math.PI * (0.95 - (i - 10) * 0.08)
    const slant = 0.05 + f * 0.04
    const rr = 0.014 - f * 0.002
    for (const s of [1, -1]) {
      let prev: V3 | null = null
      const segs = 9
      for (let k = 0; k <= segs; k++) {
        const th = 0.15 + (thMax - 0.15) * (k / segs)
        const p: V3 = [s * ax * Math.sin(th), cy + ay * Math.cos(th), z0 - slant * (1 - Math.cos(th)) * 0.5]
        if (prev) an.cap(prev, p, rr, rr * (k === segs ? 0.8 : 1), "ribs", { k: 0.012, tag: Tag.Skin })
        prev = p
      }
      if (s === 1 && i < 10) ribFront.push([0, cy - ay, z0 - slant])
    }
    // Intercostal flesh filled out to the ribs' centrelines, so the ribs read as ridges under skin, not bars.
    an.ell([0, cy + 0.004, z0 - slant * 0.4], [ax * 1.0, ay * 1.0, 0.058], "ribs", { k: 0.05 })
  }
  // Sternum keel.
  for (let i = 0; i < ribFront.length - 1; i++) an.cap(add(ribFront[i]!, [0, 0.01, 0]), add(ribFront[i + 1]!, [0, 0.01, 0]), 0.016, 0.016, "ribs", { k: 0.02 })

  // Shoulder blades riding high on the ribcage, and the wasted muscle sheets between them.
  for (const s of [1, -1] as Side[]) {
    const n = sideName(s)
    const L = limbPoints(s)
    const c: V3 = [s * 0.17, 1.55, 0.38]
    an.ellAlong([s * 0.12, 1.72, 0.32], [s * 0.22, 1.42, 0.45], 0.024, 0.1, `scap${n}`, { k: 0.035, up: [s, 0, 0] })
    an.cap([s * 0.1, 1.74, 0.29], [s * 0.23, 1.46, 0.46], 0.016, 0.02, `scap${n}`, { k: 0.018 })
    an.fiber(c, L.S, 0.1, 0.11, `scap${n}`, { k: 0.07, amp: 0.005 })
    an.ellAlong([s * 0.14, 1.66, 0.34], madd(L.S, [s, -0.4, 0], 0.03), 0.1, 0.11, `scap${n}`, { k: 0.07, up: [s, 0, 0] })
    an.cords([s * 0.08, 1.7, 0.3], madd(L.S, [s, -0.3, 0.2], 0.06), 0.07, 0.06, 6, 0.02, `scap${n}`, { twist: 0.8, k: 0.02 })
    // Trapezius hump from the neck to the blade.
    an.fiber([0, 1.68, 0.5], [s * 0.15, 1.73, 0.3], 0.085, 0.06, `scap${n}`, { k: 0.07, amp: 0.005 })
    // Pectoral cords from keel to arm.
    an.fiber([s * 0.03, 1.0, 0.36], madd(L.S, [0, -1, 0], 0.1), 0.03, 0.045, `uarm${n}`, { k: 0.04, amp: 0.004 })
    // Serratus cords fanning over the ribs.
    for (let k = 0; k < 4; k++) an.fiber([s * 0.2, 1.5 - k * 0.02, 0.38 - k * 0.02], [s * (0.2 + k * 0.01), 1.12 + k * 0.04, 0.22 - k * 0.08], 0.018, 0.012, "ribs", { k: 0.02, amp: 0.002 })
  }

  // Lats: wasted sheets from the spine down over the back ribs, so the chest is deep but not a bare cage.
  for (const sd of [1, -1] as Side[]) {
    an.cords([sd * 0.06, 1.6, -0.15], [sd * 0.16, 1.3, 0.25], 0.012, 0.012, 1, 0.022, "spine2", { twist: 0.3, k: 0.03, bone2: "ribs" })
    an.cords([sd * 0.06, 1.62, 0.0], [sd * 0.2, 1.42, 0.38], 0.012, 0.012, 1, 0.024, "spine3", { twist: 0.3, k: 0.03, bone2: `scap${sideName(sd)}` })
  }
  // Oblique and flank cords from the pelvis forward over the waist.
  for (const sd of [1, -1] as Side[]) {
    for (let k = 0; k < 4; k++) {
      an.cords([sd * (0.1 + k * 0.012), 1.48 - k * 0.04, -0.5], [sd * (0.14 + k * 0.01), 1.38 - k * 0.05, -0.05], 0.01, 0.01, 1, 0.013, "belly", { twist: 0.4, k: 0.02, bone2: "spine2" })
    }
  }
  // ------------------------------------------------------------------ waist and pelvis
  an.fiber([0, 1.34, -0.1], [0, 1.4, -0.42], 0.19, 0.165, "belly", { k: 0.08, amp: 0.003 })
  // A slack, sagging belly under the waist.
  an.ellAlong([0, 1.12, 0.08], [0, 1.16, -0.36], 0.13, 0.12, "belly", { k: 0.08, up: [0, 1, 0] })
  an.ell([0, 1.44, -0.53], [0.19, 0.14, 0.17], "hips", { k: 0.06 })
  for (const s of [1, -1]) an.ell([s * 0.15, 1.44, -0.55], [0.12, 0.15, 0.16], "hips", { k: 0.07 })
  for (const s of [1, -1] as Side[]) {
    // Iliac blades and the sit bones poking through.
    an.cap([s * 0.08, 1.6, -0.36], [s * 0.2, 1.52, -0.45], 0.026, 0.034, "hips", { k: 0.025 })
    an.knot([s * 0.1, 1.36, -0.68], 0.045, "hips", { k: 0.02, lumps: 4 })
    an.knot([s * 0.22, 1.42, -0.5], 0.055, "hips", { k: 0.025, lumps: 4 })
  }

  // ------------------------------------------------------------------ neck: long, corded, thorned
  const neckPts: V3[] = [[0, 1.6, 0.42], [0, 1.6, 0.62], [0, 1.52, 0.8], [0, 1.38, 0.94], HEAD_POS]
  const neckBones = ["spine4", "neck1", "neck2", "neck3"]
  for (let i = 0; i < neckPts.length - 1; i++) {
    const a = neckPts[i]!
    const b = neckPts[i + 1]!
    an.fiber(a, b, 0.115 - i * 0.012, 0.105 - i * 0.012, neckBones[i]!, { k: 0.06, amp: 0.004 })
    // Throat cords hanging under the neck.
    for (const s of [1, -1]) an.fiber(add(a, [s * 0.04, -0.07, 0.01]), add(b, [s * 0.03, -0.055, 0.01]), 0.024, 0.02, neckBones[i]!, { k: 0.02, amp: 0.0015 })
  }
  an.ell(madd(HEAD_POS, [0, -0.02, -0.05], 1), [0.075, 0.07, 0.075], "head", { k: 0.05 })
  for (let i = 0; i < neckPts.length - 1; i++) an.cords(neckPts[i]!, neckPts[i + 1]!, 0.12 - i * 0.013, 0.11 - i * 0.013, 9, 0.019, neckBones[i]!, { twist: 0.5, k: 0.015 })

  // ------------------------------------------------------------------ thorned spine: processes break the skin
  {
    const thorns: { base: V3; dir: V3; len: number; r: number; bone: string }[] = []
    for (let z = -0.72; z < 0.5; z += 0.05 + r() * 0.03) {
      const top = spineAt(z)
      const base = an.march([0, top[1] + 0.25, z], [0, -1, 0], 0.5)
      if (!base) continue
      const back = smoothstep(0.5, -0.2, z)
      const len = 0.015 + r() * 0.035 + (1 - Math.abs(z - 0.15) * 1.2) * 0.015
      const dir = norm([(r() - 0.5) * 0.4, 0.75, -0.55 - r() * 0.3 + back * 0.2])
      thorns.push({ base, dir, len: Math.max(0.02, len), r: 0.008 + r() * 0.004, bone: spineBone(z) })
      // A second, shorter row along the transverse processes.
      for (const s of [1, -1]) {
        if (r() < 0.75) continue
        const b2 = an.march([s * 0.06, top[1] + 0.25, z + 0.01], [0, -1, 0], 0.5)
        if (b2) thorns.push({ base: b2, dir: norm([s * (0.5 + r() * 0.3), 0.6, -0.4]), len: 0.015 + r() * 0.03, r: 0.006 + r() * 0.003, bone: spineBone(z) })
      }
    }
    // Along the neck too, smaller.
    for (let t = 0.05; t < 0.95; t += 0.09 + r() * 0.04) {
      const seg = Math.min(neckPts.length - 2, Math.floor(t * (neckPts.length - 1)))
      const f = t * (neckPts.length - 1) - seg
      const c = lerp3(neckPts[seg]!, neckPts[seg + 1]!, f)
      const base = an.march(add(c, [0, 0.2, 0]), [0, -1, 0], 0.4)
      if (base) thorns.push({ base, dir: norm([(r() - 0.5) * 0.3, 0.8, -0.5]), len: 0.025 + r() * 0.03, r: 0.007 + r() * 0.003, bone: neckBones[seg]! })
    }
    for (const t of thorns) {
      const root = madd(t.base, t.dir, -0.012)
      const mid = madd(madd(t.base, t.dir, t.len * 0.55), [r() - 0.5, r() - 0.5, r() - 0.5], t.len * 0.15)
      an.cap(root, mid, t.r, t.r * 0.55, t.bone, { k: 0.012, tag: Tag.Horn })
      an.cap(mid, madd(mid, norm(sub(mid, root)), t.len * 0.5), t.r * 0.55, 0.0025, t.bone, { k: 0.004, tag: Tag.Horn })
    }
  }

  // ------------------------------------------------------------------ limbs
  an.thick = 1.3
  for (const s of [1, -1] as Side[]) buildFrontLeg(an, s)
  for (const s of [1, -1] as Side[]) buildHindLeg(an, s)

  an.thick = 1
  // ------------------------------------------------------------------ skin detail
  m.margin = 0.006
  m.detailBand = 0.006
  m.detail = (x, y, z, d) => {
    // Soft leathery undulation and broad folds only (no ridge-line veins: their noise iso-lines read as contour maps).
    const leather = fbm3(x * 22, y * 22, z * 22, 2) * 0.0009
    const fold = fbm3(x * 7, y * 7, z * 7, 2) * 0.0016
    return d - leather - fold
  }
}

// ------------------------------------------------------------------------------------------------- forelimb

function buildFrontLeg(an: Anatomy, s: Side) {
  const n = sideName(s)
  const L = limbPoints(s)
  const r = an.r
  // Humerus wrapped in stringy muscle, triceps cords behind.
  an.fiber(L.S, L.E, 0.065, 0.04, `uarm${n}`, { k: 0.035, amp: 0.004 })
  an.ellAlong(madd(L.S, [0, 1, 0], 0.04), lerp3(L.S, L.E, 0.8), 0.1, 0.12, `uarm${n}`, { k: 0.06, up: [0, 0, 1] })
  an.fiber(madd(L.S, [0, 0, -1], 0.045), madd(L.E, [0, 0, -1], 0.04), 0.05, 0.025, `uarm${n}`, { k: 0.03 })
  an.knot(madd(L.S, [s, 0, 0], 0.03), 0.08, `uarm${n}`, { k: 0.03, lumps: 4 })
  an.cords(lerp3(L.S, L.E, 0.05), lerp3(L.S, L.E, 0.92), 0.078, 0.042, 9, 0.02, `uarm${n}`, { twist: 1.6 })
  // Elbow: a burl of bone, olecranon jutting backwards.
  an.knot(L.E, 0.07, `farm${n}`, { k: 0.02, lumps: 8, tag: Tag.Bone })
  an.cap(L.E, add(L.E, [0, 0.03, -0.1]), 0.042, 0.022, `farm${n}`, { k: 0.02 })
  // Forearm: two twisted bones in sinew.
  for (const o of [-1, 1]) an.fiber(add(L.E, [o * 0.02, 0, o * 0.015]), add(L.W, [-o * 0.018, 0, o * 0.012]), 0.034, 0.026, `farm${n}`, { k: 0.02 })
  an.ellAlong(L.E, lerp3(L.E, L.W, 0.7), 0.065, 0.065, `farm${n}`, { k: 0.035, ext: 0.92 })
  an.cords(lerp3(L.E, L.W, 0.06), lerp3(L.E, L.W, 0.94), 0.064, 0.038, 8, 0.018, `farm${n}`, { twist: -1.4 })
  // Wrist knot, then the long metacarpus standing like a second forearm.
  an.knot(L.W, 0.058, `hand${n}`, { k: 0.018, lumps: 6 })
  const fingerBases: V3[] = []
  for (let f = 0; f < 4; f++) {
    const off = (f - 1.5) * 0.034
    const top = add(L.W, [off * 0.4, -0.02, 0])
    const bot = add(L.M, [off, 0.01, -0.005 + Math.abs(off) * -0.2])
    an.fiber(top, bot, 0.022, 0.023, `hand${n}`, { k: 0.016, amp: 0.0015 })
    fingerBases.push(bot)
  }
  an.knot(add(L.M, [0, 0.015, -0.01]), 0.042, `hand${n}`, { k: 0.02, lumps: 5 })
  // Fingers: four, five-jointed counting the claw, arched high like an insect's tarsus.
  const heights = [0.05, 0.075, 0.07, 0.05, 0.028]
  const lens = [0.085, 0.078, 0.07, 0.06]
  for (let f = 0; f < 4; f++) {
    const spread = (f - 1.5) * 0.28 * s
    const scaleF = f === 1 || f === 2 ? 1 : 0.85
    const dir = norm([Math.sin(spread), 0, Math.cos(spread)])
    let prev = fingerBases[f]!
    let parent = `hand${n}`
    let along = 0
    for (let j = 0; j < 4; j++) {
      along += lens[j]! * scaleF
      const p: V3 = [L.M[0] + (f - 1.5) * 0.034 + dir[0] * along, heights[j + 1]! * (0.9 + r() * 0.2), L.M[2] + dir[2] * along]
      const name = `f${f}${n}${j}`
      an.bone(name, parent, prev, p)
      an.knot(prev, 0.022 - j * 0.002, name, { k: 0.008, lumps: 3, tag: Tag.Bone })
      an.fiber(prev, p, 0.016 - j * 0.0015, 0.014 - j * 0.0015, name, { k: 0.01, amp: 0.0012, count: 7 })
      parent = name
      prev = p
    }
    // Claw: dark keratin hooking into the ground.
    const name = `f${f}${n}3`
    let c = prev
    let cd = norm([dir[0], -0.35, dir[2]])
    for (let k = 0; k < 4; k++) {
      const q = madd(c, cd, 0.03)
      an.cap(c, q, 0.012 * (1 - k / 4) + 0.002, 0.012 * (1 - (k + 1) / 4) + 0.0015, name, { k: k === 0 ? 0.008 : 0.002, tag: Tag.Horn })
      c = q
      cd = norm(add(cd, [0, -0.35, 0]))
    }
  }
  // Dewclaw thumb high on the inside of the metacarpus, pointing back.
  {
    let prev = lerp3(L.W, L.M, 0.35)
    prev = add(prev, [-s * 0.02, 0, -0.01])
    let parent = `hand${n}`
    let dir = norm([-s * 0.4, -0.5, -0.6])
    for (let j = 0; j < 3; j++) {
      const p = madd(prev, dir, 0.05 - j * 0.01)
      const name = `th${n}${j}`
      an.bone(name, parent, prev, p)
      an.knot(prev, 0.014, name, { k: 0.008, lumps: 2 })
      an.cap(prev, p, j === 2 ? 0.009 : 0.011, j === 2 ? 0.0025 : 0.01, name, { k: 0.008, tag: j === 2 ? Tag.Horn : Tag.Skin })
      parent = name
      prev = p
      dir = norm(add(dir, [0, -0.4, 0]))
    }
  }
}

// ------------------------------------------------------------------------------------------------- hind limb

function buildHindLeg(an: Anatomy, s: Side) {
  const n = sideName(s)
  const L = limbPoints(s)
  const r = an.r
  // Thigh: femur in wasted cords, hamstrings from the sit bone.
  an.fiber(L.H, L.K, 0.065, 0.04, `thigh${n}`, { k: 0.04, amp: 0.004 })
  an.ellAlong(madd(L.H, [0, 1, 0], 0.03), lerp3(L.H, L.K, 0.78), 0.105, 0.125, `thigh${n}`, { k: 0.05, up: [0, 0, 1] })
  an.cords(lerp3(L.H, L.K, 0.08), lerp3(L.H, L.K, 0.93), 0.095, 0.045, 10, 0.019, `thigh${n}`, { twist: 1.3 })
  an.fiber([s * 0.11, 1.36, -0.68], madd(L.K, [0, 0, -1], 0.06), 0.05, 0.022, `thigh${n}`, { k: 0.03 })
  // Knee burl pointing forward.
  an.knot(L.K, 0.075, `shin${n}`, { k: 0.022, lumps: 8, tag: Tag.Bone })
  an.ell(add(L.K, [0, 0.01, 0.065]), [0.04, 0.045, 0.024], `shin${n}`, { k: 0.015 })
  // Shin raking back to the hock.
  an.fiber(L.K, L.A, 0.036, 0.026, `shin${n}`, { k: 0.025, amp: 0.0035 })
  an.fiber(add(L.K, [s * 0.03, -0.02, -0.045]), add(L.A, [s * 0.018, 0.02, 0]), 0.024, 0.016, `shin${n}`, { k: 0.015 })
  an.ellAlong(lerp3(L.K, L.A, 0.05), lerp3(L.K, L.A, 0.65), 0.055, 0.055, `shin${n}`, { k: 0.035, up: [0, 1, 0] })
  an.cords(lerp3(L.K, L.A, 0.07), lerp3(L.K, L.A, 0.93), 0.046, 0.03, 6, 0.014, `shin${n}`, { twist: -1.5 })
  // Hock: the backward joint, a knot with the heel bone spiking out behind.
  an.knot(L.A, 0.065, `meta${n}`, { k: 0.02, lumps: 8, tag: Tag.Bone })
  an.cap(L.A, add(L.A, [0, 0.05, -0.12]), 0.038, 0.014, `meta${n}`, { k: 0.02 })
  // Achilles cord from the calf to the heel spike.
  an.fiber(lerp3(L.K, L.A, 0.35), add(L.A, [0, 0.05, -0.1]), 0.024, 0.016, `shin${n}`, { k: 0.02, amp: 0.0015 })
  // Metatarsus: three bones bound together, standing almost upright.
  for (let b = 0; b < 3; b++) {
    const off = (b - 1) * 0.026
    an.fiber(add(L.A, [off * 0.5, -0.02, 0.005]), add(L.F, [off, 0.01, 0]), 0.025, 0.022, `meta${n}`, { k: 0.016, amp: 0.0015 })
  }
  an.knot(add(L.F, [0, 0.01, 0]), 0.045, `meta${n}`, { k: 0.02, lumps: 5, tag: Tag.Bone })
  // Toes: four long, arched, clawed.
  const heights = [0.055, 0.06, 0.045, 0.025]
  const lens = [0.085, 0.075, 0.06]
  for (let f = 0; f < 4; f++) {
    const spread = (f - 1.5) * 0.26 * s
    const dir = norm([Math.sin(spread), 0, Math.cos(spread)])
    const base: V3 = add(L.F, [(f - 1.5) * 0.03, -0.01, 0.025])
    let prev = base
    let parent = `meta${n}`
    let along = 0.02
    const scaleF = f === 1 || f === 2 ? 1 : 0.82
    for (let j = 0; j < 3; j++) {
      along += lens[j]! * scaleF
      const p: V3 = [base[0] + dir[0] * along, heights[j + 1]! * (0.9 + r() * 0.2), base[2] + dir[2] * along]
      const name = `t${f}${n}${j}`
      an.bone(name, parent, prev, p)
      an.knot(prev, 0.021 - j * 0.002, name, { k: 0.008, lumps: 3, tag: Tag.Bone })
      an.fiber(prev, p, 0.0155 - j * 0.0015, 0.0135 - j * 0.0015, name, { k: 0.01, amp: 0.0012, count: 7 })
      parent = name
      prev = p
    }
    const name = `t${f}${n}2`
    let c = prev
    let cd = norm([dir[0], -0.45, dir[2]])
    for (let k = 0; k < 3; k++) {
      const q = madd(c, cd, 0.028)
      an.cap(c, q, 0.0115 * (1 - k / 3) + 0.002, 0.0115 * (1 - (k + 1) / 3) + 0.0015, name, { k: k === 0 ? 0.008 : 0.002, tag: Tag.Horn })
      c = q
      cd = norm(add(cd, [0, -0.4, 0]))
    }
  }
}

/** Dirt on the feet and lower limbs, dried blood on the forefeet's claws and fingers, wet in nothing yet. */
export function paintBody(p: V3): [number, number, number] {
  const [x, y, z] = p
  const nz = fbm3(x * 6, y * 6, z * 6, 3)
  const dirt = Math.min(1, smoothstep(0.55, 0.04, y) * (0.65 + 0.5 * nz) + smoothstep(1.15, 1.0, y) * 0.25 * (0.5 + nz))
  const fore = smoothstep(0.32, 0.4, z) * smoothstep(0.35, 0.03, y)
  const blood = Math.max(0, Math.min(1, fore * (0.5 + fbm3(x * 14, y * 14, z * 14, 3) * 1.2)))
  return [Math.max(0, dirt), blood, 0]
}

// ------------------------------------------------------------------------------------------------- strands

/**
 * Root-like tendrils and strips of dried tissue hanging off the spine, belly, rump and limbs (the sheet's ragged
 * silhouette). A separate, finer part: thin enough that the body's voxel size would break them up. Every shape
 * carries `dangle` (0 at the root, 1 at the tip), which the material uses to sway them.
 */
export function buildStrands(an: Anatomy): SdfModel {
  const m = new SdfModel()
  const r = rng(77)
  const hit = (o: V3, d: V3) => an.march(o, d, 0.8)
  const strand = (base: V3, dir0: V3, length: number, r0: number, bone: string, droop: number, rootlets: number) => {
    const b = an.b(bone)
    let p = madd(base, norm(dir0), -0.012)
    let dir = norm(dir0)
    const segs = Math.max(4, Math.round(length / 0.035))
    for (let k = 0; k < segs; k++) {
      const t0 = k / segs
      const t1 = (k + 1) / segs
      dir = norm(add(dir, [(r() - 0.5) * 0.35, -droop * (0.5 + t1), (r() - 0.5) * 0.35]))
      const q = madd(p, dir, length / segs)
      const ra = Math.max(0.0055, r0 * (1 - t0 * 0.6))
      const rb = Math.max(0.0052, r0 * (1 - t1 * 0.6))
      m.add(new RoundCone(p, q, ra, rb, { bone: b, tag: t0 < 0.15 ? Tag.Skin : Tag.Horn, k: k === 0 ? 0 : 0.002, dangle: t1 }))
      p = q
      if (k > 0 && r() < rootlets) {
        const sd = norm(add(dir, [(r() - 0.5) * 1.6, (r() - 0.5) * 0.5, (r() - 0.5) * 1.6]))
        let pp = p
        let dd = sd
        const n2 = 2 + Math.floor(r() * 3)
        for (let j = 0; j < n2; j++) {
          dd = norm(add(dd, [(r() - 0.5) * 0.5, -droop, (r() - 0.5) * 0.5]))
          const qq = madd(pp, dd, 0.03)
          m.add(new RoundCone(pp, qq, Math.max(0.005, rb * 0.75), 0.0048, { bone: b, tag: Tag.Horn, k: 0.0015, dangle: Math.min(1, t1 + 0.1 * (j + 1)) }))
          pp = qq
        }
      }
    }
  }
  const spineBone = (z: number) => (z < -0.36 ? "hips" : z < -0.12 ? "spine1" : z < 0.1 ? "spine2" : z < 0.3 ? "spine3" : "spine4")
  // Back and flanks: roots arch off the spine and fall down the sides.
  for (let i = 0; i < 34; i++) {
    const z = -0.62 + r() * 1.08
    const sd = r() < 0.5 ? 1 : -1
    const x = sd * r() * 0.16
    const base = hit([x, 2.1, z], [0, -1, 0])
    if (!base) continue
    strand(base, [sd * (0.6 + r() * 0.5), 0.15 + r() * 0.3, -0.3 - r() * 0.3], 0.18 + r() * 0.35, 0.007 + r() * 0.006, spineBone(z), 0.16, 0.25)
  }
  // Neck: a mane of short roots along the top, strips hanging under the throat.
  for (let i = 0; i < 26; i++) {
    const z = 0.45 + r() * 0.5
    const base = hit([(r() - 0.5) * 0.1, 2.1, z], [0, -1, 0])
    if (!base) continue
    strand(base, [(r() - 0.5) * 0.8, 0.5, -0.4], 0.06 + r() * 0.12, 0.006 + r() * 0.004, z < 0.66 ? "neck1" : z < 0.85 ? "neck2" : "neck3", 0.1, 0.15)
  }
  for (let i = 0; i < 16; i++) {
    const z = 0.5 + r() * 0.45
    const base = hit([(r() - 0.5) * 0.1, 0.9, z], [0, 1, 0])
    if (!base) continue
    strand(base, [0, -1, 0], 0.1 + r() * 0.2, 0.006 + r() * 0.005, z < 0.66 ? "neck1" : z < 0.85 ? "neck2" : "neck3", 0.15, 0.1)
  }
  // Belly and keel: hanging strips.
  for (let i = 0; i < 24; i++) {
    const z = -0.42 + r() * 0.85
    const base = hit([(r() - 0.5) * 0.3, 0.6, z], [0, 1, 0])
    if (!base) continue
    strand(base, [(r() - 0.5) * 0.3, -1, (r() - 0.5) * 0.3], 0.1 + r() * 0.35, 0.009 + r() * 0.008, z < -0.12 ? "belly" : "ribs", 0.15, 0.12)
  }
  // Rump and tail: a long ragged tail of roots.
  for (let i = 0; i < 46; i++) {
    const a = (r() - 0.5) * 2.4
    const o: V3 = [Math.sin(a) * 0.4, 1.42 + (r() - 0.5) * 0.25, -1.2]
    const base = hit(o, [-o[0] * 0.5, 0, 1])
    if (!base) continue
    strand(base, [Math.sin(a) * 0.5, 0.15 - r() * 0.3, -1], 0.35 + r() * 0.6, 0.008 + r() * 0.007, r() < 0.5 ? "tail1" : "tail2", 0.06, 0.25)
  }
  // Limbs: strips off the backs of the thighs and upper arms, a few lower down.
  for (const sd of [1, -1] as Side[]) {
    const n = sideName(sd)
    const L = limbPoints(sd)
    const limb = (a: V3, b: V3, bone: string, count: number, out: V3, len: number) => {
      for (let i = 0; i < count; i++) {
        const c = lerp3(a, b, 0.15 + r() * 0.7)
        const base = hit(madd(c, out, 0.35), scaleN(out, -1))
        if (!base) continue
        strand(base, add(out, [0, -0.6, 0]), len * (0.5 + r()), 0.006 + r() * 0.004, bone, 0.16, 0.15)
      }
    }
    limb(L.H, L.K, `thigh${n}`, 12, norm([sd * 0.4, 0, -1]), 0.2)
    limb(L.S, L.E, `uarm${n}`, 10, norm([sd * 0.5, 0, -1]), 0.18)
    limb(L.K, L.A, `shin${n}`, 5, norm([sd * 0.3, 0, -1]), 0.12)
    limb(L.E, L.W, `farm${n}`, 5, norm([sd * 0.4, 0, -1]), 0.12)
  }
  m.margin = 0.003
  return m
}

const scaleN = (v: V3, s: number): V3 => [v[0] * s, v[1] * s, v[2] * s]
