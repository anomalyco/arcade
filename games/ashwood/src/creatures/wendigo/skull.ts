import { Anatomy, add, cross, lerp3, norm, sub, Tag, type V3 } from "../kit/anatomy"
import { fbm3, ridge3 } from "../kit/noise"
import { Ellipsoid, Op, RoundCone, SdfModel, smoothstep } from "../kit/sdf"
import { HEAD_PITCH, HEAD_POS } from "./anatomy"

// The skull: a long deer/horse skull, eyeless from the front, split open vertically down the whole face from the brow
// to the snout, the split widening into a dark gash at the bottom with splintered edges; jagged teeth, a separate
// lower jaw, and pedicles for the antlers. Authored in skull space (origin at the neck joint, +Z down the snout, +Y up
// the forehead), then placed into the bind pose with the head pitched snout-down.

const c = Math.cos(HEAD_PITCH)
const s = Math.sin(HEAD_PITCH)
/** Skull scale: oversized against the body, as in the sheet. */
export const SK = 1.55
/** Skull space → bind-pose world. */
/** Lateral squeeze: a long, narrow face. */
const SKX = 0.8
export const toWorld = (p: V3): V3 => [HEAD_POS[0] + p[0] * SK * SKX, HEAD_POS[1] + (p[1] * c - p[2] * s) * SK, HEAD_POS[2] + (p[1] * s + p[2] * c) * SK]
export const dirW = (d: V3): V3 => [d[0], d[1] * c - d[2] * s, d[1] * s + d[2] * c]

export function buildSkull(head: number, jaw: number, seed = 7) {
  const an = new Anatomy(seed)
  const skull = an.model
  const r = an.r
  const W = toWorld
  const bone = { bone: head, tag: Tag.Bone }
  const ell = (cc: V3, rr: V3, k = 0.02, op = Op.Add, axes?: [V3, V3, V3]) =>
    skull.add(new Ellipsoid(W(cc), [rr[0] * SK * SKX, rr[1] * SK, rr[2] * SK], axes ? (axes.map(dirW) as [V3, V3, V3]) : ([dirW([1, 0, 0]), dirW([0, 1, 0]), dirW([0, 0, 1])] as [V3, V3, V3]), { ...bone, k, op }))
  const cap = (a: V3, b: V3, ra: number, rb: number, k = 0.015, op = Op.Add, tag: number = Tag.Bone) => skull.add(new RoundCone(W(a), W(b), ra * SK, rb * SK, { bone: head, tag, k: k * SK, op }))

  // Cranium and the broad flat brow (the widest part of the face, as in the sheet).
  ell([0, 0.035, 0.02], [0.08, 0.072, 0.085], 0.02)
  ell([0, 0.07, 0.13], [0.085, 0.036, 0.08], 0.035)
  ell([0, 0.045, -0.035], [0.06, 0.05, 0.035], 0.03)
  // Brow ridges over closed, eyeless orbits; only a small shallow pit on each side.
  for (const sd of [1, -1]) {
    ell([sd * 0.072, 0.062, 0.14], [0.02, 0.026, 0.04], 0.02)
    ell([sd * 0.11, 0.052, 0.155], [0.017, 0.02, 0.024], 0.008, Op.Sub)
    // Cheekbones and zygomatic arch.
    cap([sd * 0.075, 0.02, 0.12], [sd * 0.055, -0.01, 0.24], 0.011, 0.008, 0.012)
    cap([sd * 0.08, 0.02, 0.12], [sd * 0.07, 0.0, 0.04], 0.011, 0.009, 0.015)
    // Long face: maxillae tapering to the snout.
    cap([sd * 0.04, 0.025, 0.18], [sd * 0.022, -0.03, 0.44], 0.03, 0.015, 0.02)
    // Long nasal ridge flanks: flat bony planes down the face.
    cap([sd * 0.05, 0.065, 0.2], [sd * 0.026, 0.02, 0.43], 0.016, 0.01, 0.02)
    // Nasal bones either side of the split.
    cap([sd * 0.03, 0.09, 0.15], [sd * 0.016, 0.03, 0.44], 0.02, 0.011, 0.02)
    // Preorbital pits.
    ell([sd * 0.06, 0.05, 0.22], [0.012, 0.016, 0.022], 0.006, Op.Sub)
  }
  ell([0, -0.03, 0.44], [0.026, 0.024, 0.035], 0.02)

  // The split: deep, flattened carves down the midline, hairline at the brow, gaping at the snout.
  const splitLine: V3[] = [
    [0, 0.115, 0.04],
    [0, 0.105, 0.12],
    [0, 0.085, 0.22],
    [0, 0.06, 0.31],
    [0, 0.03, 0.39],
    [0, 0.0, 0.47],
  ]
  for (let i = 0; i < splitLine.length - 1; i++) {
    const a = splitLine[i]!
    const b = splitLine[i + 1]!
    const t = i / (splitLine.length - 2)
    const w = 0.008 + Math.pow(t, 1.2) * 0.034
    const ax = norm(sub(b, a))
    const up = norm(cross([1, 0, 0], ax))
    ell(lerp3(a, b, 0.5), [w, 0.075, 0.07], 0.005, Op.Sub, [[1, 0, 0], ax, up].map((v) => v) as [V3, V3, V3])
  }
  // Hollow behind the split so it reads black.
  ell([0, 0.0, 0.28], [0.04, 0.05, 0.2], 0.01, Op.Sub)
  // Splinters along the split's edges.
  for (let i = 0; i < 9; i++) {
    const t = 0.2 + r() * 0.75
    const k = Math.min(splitLine.length - 2, Math.floor(t * (splitLine.length - 1)))
    const p = lerp3(splitLine[k]!, splitLine[k + 1]!, t * (splitLine.length - 1) - k)
    const sd = r() < 0.5 ? 1 : -1
    const w = 0.008 + Math.pow(t, 1.2) * 0.034
    const a: V3 = add(p, [sd * (w + 0.008), -0.006, 0])
    cap(a, add(a, [-sd * (0.006 + r() * 0.01), -0.004, (r() - 0.5) * 0.01]), 0.004, 0.0012, 0.004)
  }

  // Upper teeth: jagged, uneven, a few broken.
  for (const sd of [1, -1]) {
    // Long, crowded, needle-like; a pair of fangs a third of the way along.
    for (let z = 0.14; z < 0.45; z += 0.012 + r() * 0.004) {
      const f = (z - 0.14) / 0.31
      const root: V3 = [sd * (0.042 - f * 0.02), -0.028 - f * 0.012, z]
      const fang = Math.abs(f - 0.3) < 0.04
      const len = (fang ? 0.058 : 0.032 + r() * 0.035) + f * f * 0.022
      const tip = add(root, [sd * (r() - 0.6) * 0.012, -len, (r() - 0.1) * 0.02])
      cap(root, tip, fang ? 0.011 : 0.0078, 0.0015, 0.004, Op.Add, Tag.Tooth)
    }
  }
  // Pedicles.
  for (const sd of [1, -1]) cap([sd * 0.045, 0.03, 0.0], [sd * 0.075, 0.055, -0.035], 0.022, 0.024, 0.02)

  skull.margin = 0.004
  skull.detailBand = 0.004
  skull.detail = (x, y, z, d) => {
    const crack = ridge3(x * 14, y * 14, z * 14, 24) * 0.0008
    const pit = fbm3(x * 40, y * 40, z * 40, 2) * 0.00025
    return d + crack - pit
  }

  // Lower jaw (its own part, rigid on the jaw bone), hanging slightly open in the bind pose.
  const jm = new SdfModel()
  const jb = { bone: jaw, tag: Tag.Bone }
  const jcap = (a: V3, b: V3, ra: number, rb: number, k = 0.012, tag: number = Tag.Bone) => jm.add(new RoundCone(W(a), W(b), ra * SK, rb * SK, { ...jb, tag, k: k * SK }))
  for (const sd of [1, -1]) {
    // Ramus up to the hinge, then the body as a stacked plate to the chin.
    jcap([sd * 0.062, -0.005, 0.09], [sd * 0.056, -0.085, 0.085], 0.012, 0.014)
    jcap([sd * 0.056, -0.088, 0.085], [sd * 0.018, -0.085, 0.42], 0.011, 0.008)
    jcap([sd * 0.056, -0.06, 0.1], [sd * 0.02, -0.062, 0.42], 0.009, 0.007)
    for (let z = 0.16; z < 0.43; z += 0.012 + r() * 0.004) {
      const f = (z - 0.16) / 0.27
      const root: V3 = [sd * (0.048 - f * 0.028), -0.058, z]
      const len = (Math.abs(f - 0.35) < 0.05 ? 0.06 : 0.026 + r() * 0.032) + f * f * 0.022
      jcap(root, add(root, [sd * (r() - 0.5) * 0.01, len, (r() - 0.2) * 0.016]), 0.0072, 0.0015, 0.004, Tag.Tooth)
    }
  }
  jm.add(new Ellipsoid(W([0, -0.075, 0.43]), [0.025 * SK, 0.018 * SK, 0.022 * SK], undefined, { ...jb, k: 0.015 }))
  jm.margin = 0.004
  jm.detailBand = 0.004
  jm.detail = skull.detail

  return { skull, jaw: jm }
}

/** Blood and grime at the mouth and the split; skull space distances from the snout. */
export function paintSkull(p: V3): [number, number, number] {
  const q = sub(p, HEAD_POS)
  const local: V3 = [q[0] / SK, (q[1] * c + q[2] * s) / SK, (-q[1] * s + q[2] * c) / SK]
  const nz = fbm3(p[0] * 18, p[1] * 18, p[2] * 18, 3)
  const mouth = smoothstep(0.2, 0.42, local[2]) * smoothstep(0.02, -0.06, local[1])
  const split = smoothstep(0.03, 0.0, Math.abs(local[0])) * smoothstep(0.15, 0.4, local[2])
  const blood = Math.max(0, Math.min(1, (mouth * 0.9 + split * 0.6) * (0.55 + nz * 1.3)))
  const dirt = Math.max(0, Math.min(1, 0.05 + nz * 0.25 + split * 0.5 + smoothstep(0.0, -0.05, local[1]) * 0.3))
  return [dirt, blood, mouth * 0.6]
}


/**
 * The inside of the mouth, as two parts painted near-black and wet (blood channel): on the head, the palate, the
 * upper gums and a gullet that fills the skull's hollow behind the split and runs back toward the neck; on the jaw,
 * the lower gums and the tongue. So the open jaw reads as a dark cavity with teeth rows, not grey neck behind it.
 */
export function buildMouth(head: number, jaw: number) {
  const W = toWorld
  const upper = new SdfModel()
  const lower = new SdfModel()
  const ell = (m: SdfModel, bone: number, c: V3, rr: V3, k = 0.01) => m.add(new Ellipsoid(W(c), [rr[0] * SK * 0.8, rr[1] * SK, rr[2] * SK], [dirW([1, 0, 0]), dirW([0, 1, 0]), dirW([0, 0, 1])], { bone, k: k * SK, tag: Tag.Skin }))
  const cap = (m: SdfModel, bone: number, a: V3, b: V3, ra: number, rb: number, k = 0.008) => m.add(new RoundCone(W(a), W(b), ra * SK, rb * SK, { bone, k: k * SK, tag: Tag.Skin }))
  // Palate and gullet.
  // Palate: a thin roof just above the tooth rows; the gullet deep behind it (inside the cranium, under the split).
  ell(upper, head, [0, -0.018, 0.3], [0.026, 0.008, 0.13])
  cap(upper, head, [0, -0.03, 0.16], [0, -0.04, 0.0], 0.022, 0.026, 0.015)
  // Upper gums along the tooth rows.
  for (const sd of [1, -1]) cap(upper, head, [sd * 0.043, -0.03, 0.13], [sd * 0.021, -0.043, 0.45], 0.008, 0.006)
  // Lower gums and the tongue.
  for (const sd of [1, -1]) cap(lower, jaw, [sd * 0.049, -0.06, 0.15], [sd * 0.019, -0.06, 0.43], 0.0075, 0.006)
  ell(lower, jaw, [0, -0.068, 0.27], [0.02, 0.007, 0.1])
  upper.margin = lower.margin = 0.003
  return { upper, lower }
}

/** Near-black, wet, red-black at the gums. */
export const paintMouth = (): [number, number, number] => [1, 1, 0]
