import * as THREE from "three/webgpu"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"
import { rng, range, lerp, type Rng } from "./rng"
import { CELL, FOLIAGE, IMPOSTOR, cellRect, type ImpostorInput } from "./paint"

// Procedural conifers. Each variant is a trunk plus branch cards (one card per limb, bent to droop and rolled so the
// crown has volume), built at two detail levels from the same limb list so LODs keep the same silhouette, and painted
// side-on into an impostor atlas for the far forest.

export type Kind = "fir" | "firEdge" | "pine" | "young" | "sapling" | "snag"

type Spec = {
  kind: Kind
  height: number
  trunkRadius: number
  /** Fraction of height where the live crown starts. */
  crownBase: number
  /** Metres of dead twiggy limbs below the live crown. */
  deadZone: number
  maxBranch: number
  whorl: number
  perWhorl: number
  cell: number
  /** Card width as a fraction of limb length. */
  cardWidth: number
  /** Limb pitch (radians) at crown base and top. */
  pitch: [number, number]
  /** Tip droop as a fraction of limb length at crown base and top. */
  droop: [number, number]
  /** Crown profile exponent: limb length = max * (1 - t)^shape (with a rounded top). */
  shape: number
  /** Chance a limb is missing, for ragged, irregular crowns. */
  gaps: number
  /** Broken top (snags). */
  broken?: boolean
  radial: number
}

export const SPECS: Record<Kind, Spec> = {
  fir: {
    kind: "fir", height: 29, trunkRadius: 0.42, crownBase: 0.42, deadZone: 4.5, maxBranch: 3.6, whorl: 0.62, perWhorl: 4,
    cell: FOLIAGE.fir, cardWidth: 0.78, pitch: [-0.42, 0.38], droop: [0.34, 0.06], shape: 0.8, gaps: 0.2, radial: 9,
  },
  firEdge: {
    kind: "firEdge", height: 23, trunkRadius: 0.34, crownBase: 0.12, deadZone: 1.5, maxBranch: 3.4, whorl: 0.55, perWhorl: 4,
    cell: FOLIAGE.fir, cardWidth: 0.8, pitch: [-0.5, 0.4], droop: [0.36, 0.06], shape: 0.95, gaps: 0.14, radial: 8,
  },
  pine: {
    kind: "pine", height: 24, trunkRadius: 0.24, crownBase: 0.6, deadZone: 3.5, maxBranch: 1.9, whorl: 0.62, perWhorl: 4,
    cell: FOLIAGE.pine, cardWidth: 0.85, pitch: [-0.15, 0.45], droop: [0.12, 0.02], shape: 0.6, gaps: 0.28, radial: 7,
  },
  young: {
    kind: "young", height: 8.5, trunkRadius: 0.13, crownBase: 0.04, deadZone: 0, maxBranch: 2.1, whorl: 0.36, perWhorl: 5,
    cell: FOLIAGE.young, cardWidth: 1.05, pitch: [-0.3, 0.5], droop: [0.25, 0.03], shape: 1.05, gaps: 0.06, radial: 6,
  },
  sapling: {
    kind: "sapling", height: 2.4, trunkRadius: 0.04, crownBase: 0.05, deadZone: 0, maxBranch: 0.7, whorl: 0.2, perWhorl: 4,
    cell: FOLIAGE.young, cardWidth: 0.9, pitch: [-0.1, 0.6], droop: [0.15, 0.02], shape: 1.0, gaps: 0.05, radial: 5,
  },
  snag: {
    kind: "snag", height: 19, trunkRadius: 0.38, crownBase: 0.35, deadZone: 9, maxBranch: 1.3, whorl: 0.9, perWhorl: 2,
    cell: FOLIAGE.dead, cardWidth: 0.6, pitch: [-0.3, 0.2], droop: [0.1, 0.05], shape: 0.4, gaps: 0.55, broken: true, radial: 7,
  },
}

type Limb = {
  /** Attachment point on the trunk axis. */
  o: THREE.Vector3
  /** Unit direction of the limb (pitched). */
  d: THREE.Vector3
  /** Unit vector across the card. */
  s: THREE.Vector3
  len: number
  width: number
  droop: number
  cell: number
  /** Extra hanging card crossing the main one, for volume. */
  cross: boolean
  /** Importance (limb length). */
  weight: number
}

export type TreeModel = {
  kind: Kind
  spec: Spec
  height: number
  trunkTop: number
  baseRadius: number
  lod0: { trunk: THREE.BufferGeometry; foliage: THREE.BufferGeometry }
  lod1: { trunk: THREE.BufferGeometry; foliage: THREE.BufferGeometry }
  limbs: Limb[]
  radius: (y: number) => number
  /** Horizontal half-extent of the crown, for the impostor. */
  spread: number
}

const UP = new THREE.Vector3(0, 1, 0)

function radiusAt(spec: Spec, H: number, y: number) {
  const r0 = spec.trunkRadius
  const t = Math.min(1, Math.max(0, y / H))
  const flare = y < 1.2 ? r0 * 0.55 * Math.exp(-Math.max(0, y) / 0.35) : 0
  return Math.max(0.012, r0 * Math.pow(1 - t, 0.85) + flare)
}

function makeLimbs(spec: Spec, r: Rng, H: number, top: number): Limb[] {
  const limbs: Limb[] = []
  const crown0 = spec.crownBase * H
  const deadStart = Math.max(1.2, crown0 - spec.deadZone)
  let az = r() * Math.PI * 2
  const golden = 2.39996
  // Dead lower limbs (short, twiggy, below the live crown).
  for (let y = deadStart; y < crown0; y += spec.whorl * 1.6) {
    const n = 1 + Math.floor(r() * 3)
    for (let k = 0; k < n; k++) {
      az += golden + range(r, -0.4, 0.4)
      if (r() < 0.35) continue
      const len = range(r, 0.5, 1.6) * (spec.kind === "pine" ? 0.7 : 1)
      limbs.push(limb(new THREE.Vector3(0, y + range(r, -0.2, 0.2), 0), az, range(r, -0.5, -0.1), range(r, -0.6, 0.6), len, len * 0.4, 0.05, FOLIAGE.dead, false, 0.2))
    }
  }
  const liveTop = spec.broken ? top : H
  for (let y = crown0; y < liveTop - 0.15; y += spec.whorl * range(r, 0.85, 1.15)) {
    const t = (y - crown0) / Math.max(0.01, H - crown0)
    // Crown profile: long low limbs tapering to a spire, with a rounded shoulder at the very base.
    let L = spec.maxBranch * (Math.pow(1 - t, spec.shape) * 0.93 + 0.07) * Math.min(1, 0.55 + t * 6)
    L = Math.max(L, 0.25)
    const n = spec.perWhorl + (r() < 0.4 ? 1 : 0) - (t > 0.85 ? 1 : 0)
    for (let k = 0; k < n; k++) {
      az += golden + range(r, -0.35, 0.35)
      if (r() < spec.gaps * (t < 0.2 ? 1.3 : 0.8)) continue
      const len = L * range(r, 0.72, 1.18) * (r() < 0.08 ? 1.3 : 1)
      const pitch = lerp(spec.pitch[0], spec.pitch[1], t) + range(r, -0.22, 0.22)
      const droop = lerp(spec.droop[0], spec.droop[1], t) * range(r, 0.7, 1.3)
      const cell = spec.kind === "snag" ? FOLIAGE.dead : spec.cell
      const radiusHere = radiusAt(spec, H, y) * 0.6
      limbs.push(
        limb(new THREE.Vector3(0, y, 0), az, pitch, range(r, -0.7, 0.7), len, len * spec.cardWidth, droop, cell, len > 0.7 && r() < 0.8, len, radiusHere),
      )
    }
  }
  // Spire: a few short shoots angled up around the leader so the crown closes at the top instead of a bare spike.
  if (!spec.broken) {
    const tip = Math.max(0.6, spec.whorl * 2)
    for (let k = 0; k < 4; k++) {
      az += golden
      const len = tip * range(r, 0.8, 1.1)
      limbs.push(limb(new THREE.Vector3(0, H - tip * 1.0 + k * 0.1, 0), az, range(r, 0.75, 1.0), range(r, -0.6, 0.6), len, len * 0.55, 0.05, spec.cell, true, 2))
    }
  }
  return limbs
}

function limb(o: THREE.Vector3, az: number, pitch: number, roll: number, len: number, width: number, droop: number, cell: number, cross: boolean, weight: number, inset = 0): Limb {
  const h = new THREE.Vector3(Math.cos(az), 0, Math.sin(az))
  o.addScaledVector(h, inset)
  const d = h.clone().multiplyScalar(Math.cos(pitch)).addScaledVector(UP, Math.sin(pitch)).normalize()
  const s = new THREE.Vector3().crossVectors(d, UP).normalize()
  if (s.lengthSq() < 0.01) s.set(1, 0, 0)
  s.applyAxisAngle(d, roll)
  return { o, d, s, len, width, droop, cell, cross, weight }
}

/** Point along a drooping limb at u in [0, 1]. */
function limbPoint(l: Limb, u: number, out: THREE.Vector3) {
  return out.copy(l.o).addScaledVector(l.d, l.len * u).addScaledVector(UP, -l.droop * l.len * u * u)
}

type Buf = { pos: number[]; nor: number[]; uv: number[]; flex: number[]; idx: number[] }
const newBuf = (): Buf => ({ pos: [], nor: [], uv: [], flex: [], idx: [] })

function pushCard(b: Buf, l: Limb, segs: number, width: number, s: THREE.Vector3, vShift = 0) {
  const [u0, v0, u1, v1] = cellRect(l.cell)
  const pad = 4 / (CELL * 2)
  const base = b.pos.length / 3
  const p = new THREE.Vector3()
  const n = new THREE.Vector3()
  for (let k = 0; k <= segs; k++) {
    const u = k / segs
    limbPoint(l, u, p)
    for (let side = 0; side < 2; side++) {
      const v = side
      const q = p.clone().addScaledVector(s, (v - 0.5) * width).addScaledVector(UP, vShift * (v - 0.5) * width)
      b.pos.push(q.x, q.y, q.z)
      // Normals point out of the crown and up, so the tree shades like a volume, not a stack of flat cards.
      n.set(q.x, 0, q.z).normalize().multiplyScalar(0.85).addScaledVector(UP, 0.35 + 0.3 * u).normalize()
      b.nor.push(n.x, n.y, n.z)
      b.uv.push(lerp(u0 + pad, u1 - pad, u), lerp(v0 + pad, v1 - pad, v))
      b.flex.push(l.len * u)
    }
  }
  for (let k = 0; k < segs; k++) {
    const a = base + k * 2
    b.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
  }
}

function bufGeometry(b: Buf) {
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3))
  g.setAttribute("normal", new THREE.Float32BufferAttribute(b.nor, 3))
  g.setAttribute("uv", new THREE.Float32BufferAttribute(b.uv, 2))
  g.setAttribute("flex", new THREE.Float32BufferAttribute(b.flex, 1))
  g.setIndex(b.idx)
  return g
}

/**
 * Wooden limbs for the full-detail trunk: a tapered 5-sided tube from inside the trunk out along each limb's droop
 * curve, so every needle card hangs off a visible branch (dead lower limbs get their whole length, live limbs the
 * inner part the foliage doesn't cover).
 */
function limbWood(spec: Spec, H: number, limbs: Limb[], pos: number[], nor: number[], uv: number[], flex: number[], idx: number[]) {
  const sides = 5
  const p = new THREE.Vector3()
  const q = new THREE.Vector3()
  const t = new THREE.Vector3()
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  for (const l of limbs) {
    const dead = l.cell === FOLIAGE.dead
    if (l.weight >= 2 && !dead && l.d.y > 0.6) continue
    const reach = dead ? 0.85 : 0.45
    const r0 = Math.min(radiusAt(spec, H, l.o.y) * 0.45, 0.025 + l.len * (dead ? 0.018 : 0.022))
    const segs = 3
    const start = pos.length / 3
    for (let k = 0; k <= segs; k++) {
      const u = (k / segs) * reach
      limbPoint(l, u, p)
      if (k === 0) p.addScaledVector(l.d, -0.15)
      limbPoint(l, Math.min(1, u + 0.05), q)
      t.subVectors(q, p).normalize()
      a.crossVectors(t, UP).normalize()
      if (a.lengthSq() < 0.01) a.set(1, 0, 0)
      b.crossVectors(a, t).normalize()
      const r = r0 * (1 - (k / segs) * 0.75)
      for (let i = 0; i <= sides; i++) {
        const ang = (i / sides) * Math.PI * 2
        const c = Math.cos(ang)
        const sn = Math.sin(ang)
        const nx = a.x * c + b.x * sn
        const ny = a.y * c + b.y * sn
        const nz = a.z * c + b.z * sn
        pos.push(p.x + nx * r, p.y + ny * r, p.z + nz * r)
        nor.push(nx, ny, nz)
        uv.push((i / sides) * 0.3, u * l.len)
        flex.push(l.len * u)
      }
    }
    const cols = sides + 1
    for (let k = 0; k < segs; k++)
      for (let i = 0; i < sides; i++) {
        const v = start + k * cols + i
        idx.push(v, v + cols, v + 1, v + 1, v + cols, v + cols + 1)
      }
  }
}

function trunkGeometry(spec: Spec, H: number, top: number, radial: number, rings: number[], limbs: Limb[] = []) {
  const pos: number[] = []
  const nor: number[] = []
  const uv: number[] = []
  const flex: number[] = []
  const idx: number[] = []
  const cols = radial + 1
  for (const y of rings) {
    const r = radiusAt(spec, H, y)
    for (let i = 0; i <= radial; i++) {
      const a = (i / radial) * Math.PI * 2
      const c = Math.cos(a)
      const s = Math.sin(a)
      // Slightly irregular cross-section so trunks don't look lathe-turned.
      const wob = 1 + 0.06 * Math.sin(a * 3 + y * 0.7) + 0.04 * Math.sin(a * 5 + 1.3)
      pos.push(c * r * wob, y, s * r * wob)
      nor.push(c, 0.08, s)
      uv.push((i / radial) * Math.max(0.6, Math.PI * 2 * spec.trunkRadius), y)
      flex.push(0)
    }
  }
  for (let j = 0; j < rings.length - 1; j++) {
    for (let i = 0; i < radial; i++) {
      const a = j * cols + i
      idx.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1)
    }
  }
  // Cap a broken top with a jagged cone.
  if (spec.broken) {
    const c = pos.length / 3
    pos.push(0.05, top + 0.9, 0)
    nor.push(0, 1, 0)
    uv.push(0, top + 1)
    flex.push(0)
    const last = (rings.length - 1) * cols
    for (let i = 0; i < radial; i++) idx.push(last + i, c, last + i + 1)
  }
  limbWood(spec, H, limbs, pos, nor, uv, flex, idx)
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3))
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2))
  g.setAttribute("flex", new THREE.Float32BufferAttribute(flex, 1))
  g.setIndex(idx)
  return g
}

export function buildTree(kind: Kind, seed: number): TreeModel {
  const spec = SPECS[kind]
  const r = rng(seed)
  const H = spec.height * range(r, 0.92, 1.08)
  const top = spec.broken ? H * range(r, 0.62, 0.82) : H
  const limbs = makeLimbs(spec, r, H, top)

  // LOD0: every limb, 3 bend segments, crossing hanging cards on big limbs.
  const f0 = newBuf()
  for (const l of limbs) {
    pushCard(f0, l, l.len > 1.2 ? 3 : 2, l.width, l.s)
    if (l.cross) {
      const s2 = l.s.clone().applyAxisAngle(l.d, Math.PI / 2 + range(r, -0.3, 0.3))
      pushCard(f0, l, 2, l.width * 0.6, s2)
    }
  }
  // LOD1: a third of the limbs, cards widened to keep the crown's density, fewer bend segments.
  const f1 = newBuf()
  // Every third limb up the stem (not the longest ones) so the spire keeps its foliage at a distance.
  const live = limbs.filter((l) => l.cell !== FOLIAGE.dead || kind === "snag")
  const keep = live.filter((l, i) => i % 3 === 0 || l.o.y > H * 0.9)
  for (const l of keep) {
    const wide = { ...l, width: l.width * 1.6, len: l.len * 1.06 }
    pushCard(f1, wide, 2, wide.width, l.s)
    if (l.cross && l.len > 1.2) pushCard(f1, wide, 1, wide.width * 0.6, l.s.clone().applyAxisAngle(l.d, Math.PI / 2))
  }

  const rings0 = [-0.7, 0, 0.25, 0.6, 1.2, 2.5]
  for (let y = 4.5; y < top - 0.5; y += Math.max(2.5, top / 8)) rings0.push(y)
  rings0.push(top)
  const rings1 = [-0.7, 0.4, top * 0.35, top]
  const radial = spec.radial
  return {
    kind,
    spec,
    height: H,
    trunkTop: top,
    baseRadius: radiusAt(spec, H, 0.5),
    lod0: { trunk: trunkGeometry(spec, H, top, radial, rings0, limbs), foliage: bufGeometry(f0) },
    lod1: { trunk: trunkGeometry(spec, H, top, Math.max(4, Math.round(radial * 0.6)), rings1), foliage: bufGeometry(f1) },
    limbs,
    radius: (y) => radiusAt(spec, H, y),
    spread: Math.max(...limbs.map((l) => Math.hypot(l.o.x + l.d.x * l.len, l.o.z + l.d.z * l.len) + l.width * 0.3), spec.trunkRadius * 2),
  }
}

/** Merges geometries (same attributes) into one, for the few one-off meshes that want it. */
export function merge(geos: THREE.BufferGeometry[]) {
  return mergeGeometries(geos, false)!
}

// ---------------------------------------------------------------------------------------------------------------
// Impostors (painted by paint.ts, usually in a Worker)

export { IMPOSTOR }

/** World size of a variant's impostor quad: width (m) and height (m), base at y = -0.7. */
export function impostorSize(m: TreeModel) {
  const h = m.trunkTop + 1.2
  return { w: Math.max(h * 0.5, m.spread * 2.2), h }
}

/** Plain, transferable description of a tree for the impostor painter. */
export function impostorInput(m: TreeModel): ImpostorInput {
  const { w, h } = impostorSize(m)
  const radii = [0, 0.25, 0.5, 0.75, 1].map((t) => m.radius(m.trunkTop * t))
  const v = (x: THREE.Vector3) => [x.x, x.y, x.z]
  return {
    w,
    h,
    trunkTop: m.trunkTop,
    radii,
    limbs: m.limbs.map((l) => ({ o: v(l.o), d: v(l.d), s: v(l.s), len: l.len, width: l.width, droop: l.droop, cell: l.cell })),
  }
}
