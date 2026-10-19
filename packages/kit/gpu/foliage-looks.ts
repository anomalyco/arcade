import { MAT, type Mesh, type Rgb } from "./mesh"
import { Rng } from "../sim/rng"
import { emitLeafMound, emitTaperedLimb, type FoliageBuildOptions } from "./foliage"

/**
 * Alternative tree looks for the D-41 round (Outbreak Lab › Vegetation › Tree look). Every look is one deterministic
 * function of the tree's seed, emits the same vertex conventions as `buildFoliageTree` (limbs `MAT.timber` with
 * aux = `FOLIAGE_LIMB_AUX` + flex so they sway with the gust field, leaves `MAT.foliage` with 0 < aux <= 1 as flex), and
 * stays opaque so trees keep the no-discard level pipeline (Apple TBDR hidden-surface removal):
 *
 * - 1 Deadwood (Diablo IV): gnarled, twisting, sprawling limbs, heavy dark trunks, a few sparse dark clumps or none.
 * - 2 Fluffy (Tiny Glade / Bruno Simon): rounded crowns built from clusters of small outward-facing leaf cards whose
 *   shading normals point out from the crown centre, over a dark inner core, so the crown lights like one soft volume.
 * - 3 Darkwood: Deadwood's structure carrying Fluffy's card clusters in rich greens and autumn ochres; the game's shader
 *   keeps the colour only where light lands (`TREE_LOOK_SHADE`).
 *
 * Leaf cards are real geometry (a six-point leaf, 4 triangles, 0.25–0.45 m), never sub-pixel at the game camera, so
 * they hold still under MSAA or TAA instead of glittering; flutter and normal rocking fade with distance in the wind.
 */
export const TREE_LOOK_OPTIONS: readonly { value: number; label: string }[] = [
  { value: 0, label: "Today (Lively, #273)" },
  { value: 1, label: "A · Diablo Deadwood" },
  { value: 2, label: "B · Tiny Glade Fluffy" },
  { value: 3, label: "C · Darkwood × Diablo" },
]

/** How far each look sinks toward near-black, grey canopy outside light (0 none, 1 full), indexed by tree look. */
export const TREE_LOOK_SHADE: readonly number[] = [0, 0.6, 0, 0.92]

type V3 = [number, number, number]
type Palette = { deep: Rgb; mid: Rgb; lit: Rgb }

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))
const norm = (x: number, y: number, z: number): V3 => {
  const l = Math.hypot(x, y, z) || 1
  return [x / l, y / l, z / l]
}
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const add = (a: V3, b: V3, k = 1): V3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k]
const scale = (c: Rgb, k: number): Rgb => [clamp01(c[0] * k), clamp01(c[1] * k), clamp01(c[2] * k)]
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const palette = (c: Rgb): Palette => ({ deep: scale(c, 0.5), mid: scale(c, 0.84), lit: scale(c, 1.22) })

/** Two unit vectors perpendicular to `d` and to each other. */
function basis(d: V3): [V3, V3] {
  const ref: V3 = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]
  const u = norm(...cross(d, ref))
  return [u, cross(d, u)]
}

/** `d` tilted by `angle` toward azimuth `phi` around it. */
function splay(d: V3, angle: number, phi: number): V3 {
  const [u, w] = basis(d)
  const s = Math.sin(angle)
  const c = Math.cos(angle)
  return norm(d[0] * c + (u[0] * Math.cos(phi) + w[0] * Math.sin(phi)) * s, d[1] * c + (u[1] * Math.cos(phi) + w[1] * Math.sin(phi)) * s, d[2] * c + (u[2] * Math.cos(phi) + w[2] * Math.sin(phi)) * s)
}

/** Seeds a look's generator through an integer hash, so neighbouring tree seeds don't start on correlated draws. */
function lookRng(seed: number, salt: number): Rng {
  let h = (seed ^ salt) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return new Rng((h ^ (h >>> 16)) >>> 0)
}

/** Same hero rule as `buildFoliageTree`: full detail on the start block's street and yard trees. */
const isHero = (x: number, z: number) => Math.abs(x) < 12 || (x > 11 && x < 46 && z > 18 && z < 56)

type Tip = { p: V3; dir: V3; level: number }

type Skeleton = {
  bark: Rgb
  /** Lateral kink per limb as a share of its length: 0 straight, 0.6 contorted. */
  gnarl: number
  /** Limb levels above the trunk. */
  depth: number
  leaders: number
  /** Splay from the parent limb, radians, per level (index 1 = leaders). */
  spread: readonly number[]
  /** Upward bias added to child directions (negative droops). */
  rise: number
  lenRatio: number
  taper: number
  minR: number
  /** Twigs per terminal limb. */
  twigs: number
  /** Chance of a short broken stub on a limb. */
  stubs: number
  /** Flex at the end of each level (0 trunk). */
  flex: readonly number[]
  /** Leader length, metres (the trunk's children). */
  lead: number
}

/**
 * One limb as two curved segments with a lateral kink between them (tangent-continuous, so it reads as a twisting
 * branch rather than a zig-zag). Returns its end point and end direction.
 */
function gnarledLimb(m: Mesh, rng: Rng, s: Skeleton, p0: V3, dir: V3, len: number, r0: number, r1: number, f0: number, f1: number, collar: number, level: number): { end: V3; dir: V3; at: (t: number) => V3 } {
  const [u, w] = basis(dir)
  // Trunks barely kink; limbs twist more the finer they get.
  const gnarl = s.gnarl * (level === 0 ? 0.2 : level === 1 ? 0.75 : 1)
  const kinkA = (rng.next() - 0.5) * 2 * gnarl
  const kinkB = (rng.next() - 0.5) * 2 * gnarl
  const kink = add(add([0, 0, 0], u, kinkA), w, kinkB)
  const pm = add(add(p0, dir, len * 0.5), kink, len * 0.5)
  const c1 = add(p0, dir, len * 0.26)
  const d2 = splay(norm(pm[0] - c1[0], pm[1] - c1[1], pm[2] - c1[2]), gnarl * (0.4 + rng.next() * 0.5), rng.next() * Math.PI * 2)
  const tan = norm(pm[0] - c1[0], pm[1] - c1[1], pm[2] - c1[2])
  const c2 = add(pm, tan, len * 0.22)
  const end = add(c2, d2, len * 0.3)
  const rm = (r0 + r1) * 0.5
  const fm = (f0 + f1) * 0.5
  const sides = r0 > 0.12 ? 7 : r0 > 0.06 ? 5 : r0 > 0.035 ? 4 : 3
  const fine = r0 <= 0.06
  emitTaperedLimb(m, p0, c1, pm, r0, rm, s.bark, fine ? 2 : 3, sides, collar, f0, fm)
  emitTaperedLimb(m, pm, c2, end, rm, r1, s.bark, fine ? 1 : 2, rm > 0.06 ? sides : Math.max(3, sides - 1), 0, fm, f1)
  const bez = (a: V3, b: V3, c: V3, t: number): V3 => {
    const k = 1 - t
    return [k * k * a[0] + 2 * k * t * b[0] + t * t * c[0], k * k * a[1] + 2 * k * t * b[1] + t * t * c[1], k * k * a[2] + 2 * k * t * b[2] + t * t * c[2]]
  }
  // A point on the limb's centre line, t 0..1 along it, for stubs and twigs to grow from.
  const at = (t: number): V3 => (t < 0.5 ? bez(p0, c1, pm, t * 2) : bez(pm, c2, end, t * 2 - 1))
  return { end, dir: norm(end[0] - c2[0], end[1] - c2[1], end[2] - c2[2]), at }
}

function growSkeleton(m: Mesh, rng: Rng, s: Skeleton, p0: V3, dir: V3, len: number, r0: number, level: number, tips: Tip[]): void {
  const f0 = level === 0 ? 0 : s.flex[level - 1]!
  const f1 = s.flex[Math.min(level, s.flex.length - 1)]!
  const r1 = Math.max(s.minR, r0 * s.taper)
  const { end, dir: d2, at } = gnarledLimb(m, rng, s, p0, dir, len, r0, r1, f0, f1, level === 0 ? 0.5 : 0, level)
  if (level > 0 && rng.next() < s.stubs) {
    // A snapped-off stub: horror trees are never whole.
    const t = 0.25 + rng.next() * 0.3
    const sp = at(t)
    const sd = splay(dir, 0.9 + rng.next() * 0.5, rng.next() * Math.PI * 2)
    const sr = Math.max(s.minR, (r0 + (r1 - r0) * t) * 0.6)
    emitTaperedLimb(m, sp, add(sp, sd, len * 0.12), add(sp, sd, len * 0.24), sr, sr * 0.75, s.bark, 2, 4, 0, f0 + (f1 - f0) * t, f1)
  }
  if (level >= s.depth) {
    tips.push({ p: end, dir: d2, level })
    for (let t = 0; t < s.twigs; t++) {
      const td = splay(d2, 0.5 + rng.next() * 0.6, rng.next() * Math.PI * 2)
      const tl = len * (0.45 + rng.next() * 0.35)
      const t0 = at(0.6 + rng.next() * 0.4)
      const t2 = add(t0, norm(td[0], td[1] + 0.15, td[2]), tl)
      emitTaperedLimb(m, t0, add(add(t0, td, tl * 0.5), [0, 0.04, 0]), t2, Math.max(s.minR, r1 * 0.8), s.minR, s.bark, 1, 3, 0, f1, 1)
    }
    return
  }
  if (level >= 1) tips.push({ p: end, dir: d2, level })
  const n = level === 0 ? s.leaders : rng.next() < 0.45 ? 3 : 2
  const phi0 = rng.next() * Math.PI * 2
  const spread = s.spread[Math.min(level + 1, s.spread.length - 1)]!
  for (let i = 0; i < n; i++) {
    const phi = phi0 + (i / n) * Math.PI * 2 + (rng.next() - 0.5) * 0.9
    const cd = splay(d2, spread * (0.8 + rng.next() * 0.45), phi)
    // Leaders climb; finer limbs may level out or (Deadwood) droop, but never dive into the ground.
    const child = norm(cd[0], Math.max(cd[1] + s.rise, level === 0 ? 0.35 : level === 1 ? 0.05 : -0.3), cd[2])
    const cl = (level === 0 ? s.lead : len * s.lenRatio) * (0.8 + rng.next() * 0.4)
    growSkeleton(m, rng, s, end, child, cl, r1 * (n === 2 ? 0.82 : 0.72), level + 1, tips)
  }
}

/**
 * A cluster of small leaf cards on an ellipsoid shell (golden-angle spiral, top-weighted), optionally over a dark inner
 * mound. Card planes face roughly outward with jitter, but their shading normals are pushed out from the crown centre
 * (`outward`), so neighbouring cards light together as one soft volume (the Tiny Glade / Bruno Simon technique).
 */
function cardCluster(
  m: Mesh,
  rng: Rng,
  c: V3,
  rx: number,
  ry: number,
  crown: V3,
  cards: number,
  size: number,
  pal: Palette,
  flex: number,
  core: number,
  outward: number,
): void {
  if (core > 0) emitLeafMound(m, c[0], c[1] - ry * 0.08, c[2], rx * core, ry * core, pal.deep, scale(pal.mid, 0.82), rng, 0, flex, 6, { crown, lit: pal.mid })
  const out = (p: V3): V3 => {
    const a = norm(p[0] - crown[0], (p[1] - crown[1]) * 0.9 + 0.2, p[2] - crown[2])
    const b = norm(p[0] - c[0], p[1] - c[1] + 0.1 * ry, p[2] - c[2])
    return norm(a[0] * 0.55 + b[0] * 0.45, a[1] * 0.55 + b[1] * 0.45, a[2] * 0.55 + b[2] * 0.45)
  }
  const sun = norm(0.25, 1, 0.15)
  for (let i = 0; i < cards; i++) {
    const t = (i + 0.5) / cards
    const y = 1 - t * 1.72
    const rr = Math.sqrt(Math.max(0, 1 - y * y))
    const ang = i * 2.39996 + (rng.next() - 0.5) * 0.5
    const u = norm(Math.cos(ang) * rr + (rng.next() - 0.5) * 0.2, y, Math.sin(ang) * rr + (rng.next() - 0.5) * 0.2)
    const shell = 0.74 + rng.next() * 0.32
    const pos: V3 = [c[0] + u[0] * rx * shell, c[1] + u[1] * ry * shell, c[2] + u[2] * rx * shell]
    const cn = norm(u[0] + (rng.next() - 0.5) * 1.6, u[1] + 0.35 + (rng.next() - 0.5) * 1.2, u[2] + (rng.next() - 0.5) * 1.6)
    const [t1, t2] = basis(cn)
    const r = rng.next() * Math.PI * 2
    const ax = norm(t1[0] * Math.cos(r) + t2[0] * Math.sin(r), t1[1] * Math.cos(r) + t2[1] * Math.sin(r), t1[2] * Math.cos(r) + t2[2] * Math.sin(r))
    const side = cross(cn, ax)
    const L = size * (0.85 + rng.next() * 0.3)
    const W = L * 0.44
    const cup = -L * 0.06
    const at = (a: number, s: number, lift: number): V3 => [
      pos[0] + ax[0] * a * L + side[0] * s * W + cn[0] * lift,
      pos[1] + ax[1] * a * L + side[1] * s * W + cn[1] * lift,
      pos[2] + ax[2] * a * L + side[2] * s * W + cn[2] * lift,
    ]
    const ring: V3[] = [at(-0.45, 0, cup), at(-0.1, -1, 0), at(0.3, -0.7, 0), at(0.55, 0, cup), at(0.3, 0.7, 0), at(-0.1, 1, 0)]
    const tone = 0.9 + rng.next() * 0.2
    const nrm = ring.map((p) => {
      const o = out(p)
      const f: V3 = cn[0] * o[0] + cn[1] * o[1] + cn[2] * o[2] < 0 ? [-cn[0], -cn[1], -cn[2]] : cn
      return norm(f[0] + (o[0] - f[0]) * outward, f[1] + (o[1] - f[1]) * outward, f[2] + (o[2] - f[2]) * outward)
    })
    const col = ring.map((p, k) => {
      const o = out(p)
      const lit = clamp01(0.5 + 0.5 * (o[0] * sun[0] + o[1] * sun[1] + o[2] * sun[2]))
      const shade = lit < 0.5 ? mix(pal.deep, pal.mid, lit * 2) : mix(pal.mid, pal.lit, (lit - 0.5) * 2)
      return scale(shade, tone * (k === 3 ? 1.08 : 1))
    })
    const aux = (k: number) => clamp01(flex * (k === 0 ? 0.6 : k === 3 ? 1.05 : 0.85)) || 0.02
    for (const k of [1, 2, 3, 4]) {
      m.vert(ring[0]!, nrm[0]!, col[0]!, MAT.foliage, aux(0))
      m.vert(ring[k]!, nrm[k]!, col[k]!, MAT.foliage, aux(k))
      m.vert(ring[k + 1]!, nrm[k + 1]!, col[k + 1]!, MAT.foliage, aux(k + 1))
    }
  }
}

const flexAt = (y: number, ground: number, h: number) => 0.22 + 0.78 * clamp01((y - ground) / Math.max(1, h))

/** Picks a leaf colour for a tree: mostly greens, autumn ochres and rusts with `autumn` probability. */
function leafColour(rng: Rng, greens: readonly Rgb[], autumn: readonly Rgb[], autumnShare: number): Rgb {
  const list = rng.next() < autumnShare ? autumn : greens
  return list[Math.floor(rng.next() * list.length) % list.length]!
}

const DEADWOOD_LEAVES: readonly Rgb[] = [[0.2, 0.22, 0.13], [0.27, 0.22, 0.13], [0.23, 0.2, 0.14]]
const FLUFFY_GREENS: readonly Rgb[] = [[0.3, 0.4, 0.18], [0.34, 0.43, 0.17], [0.26, 0.37, 0.19], [0.4, 0.44, 0.18]]
const FLUFFY_AUTUMN: readonly Rgb[] = [[0.56, 0.41, 0.16], [0.52, 0.3, 0.13], [0.6, 0.5, 0.18]]
const DARKWOOD_GREENS: readonly Rgb[] = [[0.25, 0.39, 0.15], [0.35, 0.39, 0.14], [0.3, 0.42, 0.17]]
const DARKWOOD_AUTUMN: readonly Rgb[] = [[0.6, 0.42, 0.13], [0.56, 0.26, 0.1], [0.64, 0.53, 0.15], [0.48, 0.34, 0.12]]

function deadwoodSkeleton(bark: Rgb, quality: number, hero: boolean): Skeleton {
  return {
    bark,
    gnarl: 0.55,
    depth: hero && quality > 0 ? 3 : 2,
    leaders: 3,
    spread: [0, 0.9, 0.75, 0.7],
    rise: -0.05,
    lenRatio: 0.66,
    taper: 0.5,
    minR: 0.024,
    twigs: quality === 0 ? 1 : hero ? 3 : 2,
    stubs: 0.22,
    flex: [0.12, 0.45, 0.78, 1],
    lead: 1.6,
  }
}

/** Gnarled limb crown: trunk to a fork at 35–50% height, then 2–3 leaders and their children. */
function skeleton(m: Mesh, rng: Rng, s: Skeleton, x: number, z: number, h: number, radius: number, ground: number, trunkR: number): Tip[] {
  const tips: Tip[] = []
  const lean = norm((rng.next() - 0.5) * 0.35, 1, (rng.next() - 0.5) * 0.35)
  const forkH = h * (0.34 + rng.next() * 0.14)
  const lead = Math.max(radius * 0.66, h * 0.27)
  growSkeleton(m, rng, { ...s, lead }, [x, ground - 0.02, z], lean, forkH, trunkR, 0, tips)
  return tips
}

function buildDeadwood(m: Mesh, x: number, z: number, h: number, radius: number, seed: number, ground: number, opts: Readonly<FoliageBuildOptions>): void {
  const rng = lookRng(seed, 0xdead1)
  const hero = isHero(x, z)
  const quality = Math.round(Math.min(2, Math.max(0, opts.quality)))
  const bare = rng.next() < Math.max(0.35, opts.deadTrees * 2)
  const bark = scale([0.16, 0.14, 0.12], 0.9 + rng.next() * 0.25)
  const s = deadwoodSkeleton(bark, quality, hero)
  const trunkR = (0.22 + rng.next() * 0.08) * Math.max(0.8, Math.min(1.25, h / 5.2))
  const tips = skeleton(m, rng, s, x, z, h * 1.05, radius, ground, trunkR)
  if (bare) return
  const pal = palette(leafColour(rng, DEADWOOD_LEAVES, DEADWOOD_LEAVES, 0))
  const crown: V3 = [x, ground + h * 0.6, z]
  const size = 0.3 * Math.max(0.8, Math.min(1.2, radius / 2.4))
  for (const t of tips) {
    if (t.level < s.depth || rng.next() > (hero ? 0.32 : 0.22)) continue
    const rc = radius * (0.14 + rng.next() * 0.08)
    cardCluster(m, rng, add(t.p, t.dir, rc * 0.5), rc, rc * 0.7, crown, quality === 2 ? 10 : 7, size, pal, flexAt(t.p[1], ground, h), 0, 0.7)
  }
}

function buildFluffy(m: Mesh, x: number, z: number, h: number, radius: number, seed: number, ground: number, opts: Readonly<FoliageBuildOptions>): void {
  const rng = lookRng(seed, 0xf1f1)
  const hero = isHero(x, z)
  const quality = Math.round(Math.min(2, Math.max(0, opts.quality)))
  const bark: Rgb = scale([0.3, 0.25, 0.19], 0.9 + rng.next() * 0.2)
  if (rng.next() < opts.deadTrees) {
    // Bare variant: a calm (barely gnarled) winter skeleton.
    skeleton(m, rng, { ...deadwoodSkeleton(bark, quality, hero), gnarl: 0.18, rise: 0.12, stubs: 0, spread: [0, 0.62, 0.55, 0.5] }, x, z, h, radius, ground, 0.17)
    return
  }
  const leanX = (rng.next() - 0.5) * 0.3
  const leanZ = (rng.next() - 0.5) * 0.3
  const R = radius * (0.88 + rng.next() * 0.12)
  const Ry = h * (0.27 + rng.next() * 0.05)
  const crown: V3 = [x + leanX, ground + h * 0.63, z + leanZ]
  const trunkTop: V3 = [x + leanX * 0.8, crown[1] - Ry * 0.35, z + leanZ * 0.8]
  emitTaperedLimb(m, [x, ground - 0.02, z], [x + leanX * 0.3, ground + h * 0.3, z + leanZ * 0.3], trunkTop, 0.17, 0.08, bark, 4, 7, 0.45, 0, 0.12)
  const autumnShare = 0.12 + 0.25 * opts.variety
  const base = leafColour(rng, FLUFFY_GREENS, FLUFFY_AUTUMN, autumnShare)
  const centres: { c: V3; r: number }[] = [{ c: [crown[0], crown[1] + Ry * 0.5, crown[2]], r: R * (0.55 + rng.next() * 0.08) }]
  const ring = 4 + Math.floor(rng.next() * 2) + (hero ? 1 : 0)
  const phi0 = rng.next() * Math.PI * 2
  for (let i = 0; i < ring; i++) {
    const a = phi0 + (i / ring) * Math.PI * 2 + (rng.next() - 0.5) * 0.5
    const d = R * (0.48 + rng.next() * 0.14)
    centres.push({ c: [crown[0] + Math.cos(a) * d, crown[1] + Ry * (rng.next() * 0.3 - 0.08), crown[2] + Math.sin(a) * d], r: R * (0.46 + rng.next() * 0.1) })
  }
  if (hero) {
    for (let i = 0; i < 3; i++) {
      const a = phi0 + 0.6 + (i / 3) * Math.PI * 2
      centres.push({ c: [crown[0] + Math.cos(a) * R * 0.38, crown[1] - Ry * 0.42, crown[2] + Math.sin(a) * R * 0.38], r: R * 0.42 })
    }
  }
  const cards = Math.round((hero ? 28 : 15) * [0.7, 1, 1.35][quality]!)
  const size = 0.33 * Math.max(0.8, Math.min(1.25, radius / 2.4))
  for (const { c, r } of centres) {
    emitTaperedLimb(m, trunkTop, [(trunkTop[0] + c[0]) * 0.5, (trunkTop[1] + c[1]) * 0.5 + 0.1, (trunkTop[2] + c[2]) * 0.5], c, 0.07, 0.025, bark, 2, 4, 0, 0.12, 0.9)
    const tint = scale(base, 0.92 + rng.next() * 0.16)
    cardCluster(m, rng, c, r, r * 0.86, crown, cards, size, palette(tint), flexAt(c[1], ground, h), 0.72, 0.88)
  }
}

function buildDarkwood(m: Mesh, x: number, z: number, h: number, radius: number, seed: number, ground: number, opts: Readonly<FoliageBuildOptions>): void {
  const rng = lookRng(seed, 0xda4c)
  const hero = isHero(x, z)
  const quality = Math.round(Math.min(2, Math.max(0, opts.quality)))
  const bark = scale([0.19, 0.16, 0.12], 0.9 + rng.next() * 0.2)
  const bare = rng.next() < opts.deadTrees
  const s: Skeleton = { ...deadwoodSkeleton(bark, quality, hero), gnarl: 0.42, rise: 0.08, twigs: bare ? 3 : quality === 0 ? 0 : 1, stubs: 0.12, depth: 2 }
  const trunkR = (0.2 + rng.next() * 0.06) * Math.max(0.8, Math.min(1.25, h / 5.2))
  const tips = skeleton(m, rng, s, x, z, h, radius, ground, trunkR)
  if (bare) return
  const autumnShare = 0.25 + 0.35 * opts.variety
  const base = leafColour(rng, DARKWOOD_GREENS, DARKWOOD_AUTUMN, autumnShare)
  const crown: V3 = [x, ground + h * 0.62, z]
  const cards = Math.round((hero ? 24 : 15) * [0.7, 1, 1.3][quality]!)
  const size = 0.34 * Math.max(0.8, Math.min(1.2, radius / 2.4))
  let leafy = 0
  for (const t of tips) {
    // Clumps sit on the limb ends, with gaps between them so the gnarled limbs show through the crown.
    const inner = t.level < s.depth
    if (leafy > 0 && rng.next() < (inner ? 0.5 : 0.18)) continue
    leafy++
    const rc = radius * (0.38 + rng.next() * 0.12) * (inner ? 0.8 : 1)
    const tint = scale(mix(base, leafColour(rng, DARKWOOD_GREENS, DARKWOOD_AUTUMN, autumnShare), 0.25), 0.9 + rng.next() * 0.2)
    cardCluster(m, rng, add(t.p, t.dir, rc * 0.3), rc, rc * 0.72, crown, cards, size, palette(tint), flexAt(t.p[1], ground, h), 0.68, 0.85)
  }
}

/**
 * Builds one tree in `look` (1 Deadwood, 2 Fluffy, 3 Darkwood); look 0 is `buildFoliageTree`'s lively crown, which the
 * caller builds itself. Deterministic per seed. Bare trees follow `opts.deadTrees` (Deadwood is at least a third bare).
 */
export function buildTreeLook(m: Mesh, look: number, x: number, z: number, h: number, radius: number, seed: number, ground: number, opts: Readonly<FoliageBuildOptions>): void {
  if (look === 1) buildDeadwood(m, x, z, h, radius, seed, ground, opts)
  else if (look === 2) buildFluffy(m, x, z, h, radius, seed, ground, opts)
  else buildDarkwood(m, x, z, h, radius, seed, ground, opts)
}
