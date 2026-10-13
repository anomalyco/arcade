// The player's aircraft carrier ("layout A"): flared hull with a red waterline band, squared flight deck on stepped
// sponsons, starboard island with a mast and radomes, port deck-edge elevator and painted deck markings; the deck ships
// empty (`buildVehicle` builds the aircraft, vehicles and crew the game spawns). Dimensions and layout come from
// `shared/carrier-spec.ts`; ship-local frame: +Z bow, +Y up, +X port, −X starboard (the island side).
import {
  APRON_LINE_X,
  DRAFT,
  APRON_LINE_YELLOW_Z,
  BOW_NOTCH,
  BOW_Z,
  CENTERLINE_X,
  DASH,
  DECK_SLAB_Y,
  DECK_X0,
  DECK_X1,
  DECK_Y,
  ELEVATOR,
  GUIDE_X,
  ISLAND,
  NUMBER_DIGIT_L,
  NUMBER_DIGIT_W,
  NUMBER_GAP,
  NUMBER_Z0,
  PARKING,
  RUNWAY,
  STERN_Z,
  THRESHOLD,
  WEAPON_MOUNTS,
  type Box,
  type Rect,
  type VehicleKind,
} from "../../shared/carrier-spec"
import { beam, buildCart, buildCrew, buildHelicopter, buildJet, buildTractor, geoSphere, hex, loft, pitchAbout, mirrorX, placeYaw, polyFacing, polyOut, VEST, type V3 } from "./deck-vehicles"
import { MAT, Mesh, type Mat, type Rgb } from "./mesh"

export const PAL = {
  deck: hex(0x50525a),
  deckEdge: hex(0x6a6e77),
  hull: hex(0x6f757f),
  hullLight: hex(0x858b95),
  slab: hex(0x7c828c),
  under: hex(0x4a4f57),
  lowerHull: hex(0x30353c),
  red: hex(0x9a2a2c),
  island: hex(0x8c929b),
  islandRoof: hex(0x9da3ab),
  islandDark: hex(0x6c727b),
  window: hex(0x24344a),
  opening: hex(0x1d2026),
  openingDeep: hex(0x121418),
  white: hex(0xe6e6e3),
  yellow: hex(0xe7b534),
  red2: hex(0xc8302c),
  orange: hex(0xd8782c),
  radome: hex(0xe4e7eb),
  mast: hex(0x5d636c),
  radar: hex(0x4e596b),
  radarGrid: hex(0x9aa5b4),
  rail: hex(0x9aa0a8),
} as const

/** Hull paint by height: dark below the boot top, the red band straddling the waterline, grey above. */
const BANDS: { y0: number; y1: number; col: Rgb }[] = [
  { y0: -Infinity, y1: -3.4, col: PAL.lowerHull },
  { y0: -3.4, y1: 2.4, col: PAL.red },
  { y0: 2.4, y1: Infinity, col: PAL.hull },
]

/** Splits a triangle along the band planes and colours each piece; the normal faces away from `inside`. */
function bandFacet(m: Mesh, a: V3, b: V3, c: V3, inside: V3): void {
  for (const band of BANDS) {
    let poly: V3[] = [a, b, c]
    for (const [y, keepAbove] of [
      [band.y0, true],
      [band.y1, false],
    ] as const) {
      if (!Number.isFinite(y)) continue
      const out: V3[] = []
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i]!
        const q = poly[(i + 1) % poly.length]!
        const pin = keepAbove ? p[1] >= y : p[1] <= y
        const qin = keepAbove ? q[1] >= y : q[1] <= y
        if (pin) out.push(p)
        if (pin !== qin) {
          const t = (y - p[1]) / (q[1] - p[1])
          out.push([p[0] + (q[0] - p[0]) * t, y, p[2] + (q[2] - p[2]) * t])
        }
      }
      poly = out
      if (poly.length < 3) break
    }
    if (poly.length >= 3) polyOut(m, poly, inside, band.col)
  }
}

/** Upward-facing flat quad (deck markings, plates). */
function flat(m: Mesh, x0: number, z0: number, x1: number, z1: number, y: number, col: Rgb, mat: Mat = MAT.lit, aux = 0): void {
  m.quad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], [0, 1, 0], col, mat, aux)
}

/** Upward-facing quad from four plan corners (any winding). */
function flat4(m: Mesh, pts: [number, number][], y: number, col: Rgb): void {
  polyOut(
    m,
    pts.map(([x, z]): V3 => [x, y, z]),
    [pts.reduce((s, p) => s + p[0], 0) / 4, y - 1, pts.reduce((s, p) => s + p[1], 0) / 4],
    col,
  )
}

/** Small integer hash -> [0, 1). */
function hash(a: number, b: number): number {
  let h = (a * 374761393 + b * 668265263) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

const scale = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k]

// ---------------------------------------------------------------------------------------------------------------------
// Hull

type Station = { z: number; pts: [number, number][] }

/**
 * Starboard half-sections from the bottom centre up to the underside of the deck slab (mirrored to port). Midships: a
 * flat bottom, a near-vertical wall through the waterline (beam 51 m, between the turnaround's BOW/STERN elevations and
 * the hero, where the flank is almost a vertical wall), and a short flare to nearly the full deck width under the slab,
 * so the deck never reads as a slab floating on a thin hull. The bow follows the
 * hero concept (traced on its red band): a bluff, shovel-like bow that keeps ~90% of the deck width just under the
 * lip and about half of it at the waterline right up to the deck end, so the bow reads as a deep near-vertical wall
 * (the hero's red band runs ~200 px under the bow lip; the turnaround's PORT elevation rakes further, ~16 m). The forefoot is cut back below the water. The
 * transom is vertical down to just below the waterline.
 */
const MID: [number, number][] = [[0, -DRAFT], [20, -DRAFT], [24.5, -4.5], [25.6, 0], [26.6, 5], [30.4, 11], [36.6, DECK_SLAB_Y]]
const STATIONS: Station[] = [
  { z: STERN_Z, pts: [[0, -1.8], [22, -1.8], [24.8, -0.6], [25.8, 2], [26.6, 6], [30.4, 11], [36.6, DECK_SLAB_Y]] },
  { z: -159, pts: [[0, -4.5], [21, -4.5], [24.6, -2.6], [25.6, 0.5], [26.6, 5], [30.4, 11], [36.6, DECK_SLAB_Y]] },
  { z: -149, pts: MID },
  { z: 104, pts: MID },
  { z: 128, pts: [[0, -DRAFT], [15, -DRAFT], [22, -4.5], [25, 0], [26.4, 5], [30.4, 11], [36.6, DECK_SLAB_Y]] },
  { z: 143, pts: [[0, -6], [12, -6], [20.5, -3], [24, 0], [25.6, 5], [30.2, 11.2], [36.4, DECK_SLAB_Y]] },
  { z: 153, pts: [[0, -3.5], [8, -3.5], [17.5, -1.5], [21.5, 0], [24.2, 5], [29.6, 11.4], [36, DECK_SLAB_Y]] },
  { z: 160, pts: [[0, -1.2], [3, -1.2], [13, -0.6], [17.5, 0.2], [22, 5], [28.6, 11.5], [35.5, DECK_SLAB_Y]] },
  { z: 164.6, pts: [[0, 2.5], [0, 2.5], [6, 2.6], [11, 2.9], [17, 6], [26, 12], [34.9, DECK_SLAB_Y]] },
]







/** Half-breadth of the hull at height y and station z (linear in the station table), for attaching sponsons. */
export function hullHalfWidth(y: number, z: number): number {
  let i = 0
  while (i + 2 < STATIONS.length && STATIONS[i + 1]!.z < z) i++
  const a = STATIONS[i]!
  const b = STATIONS[i + 1]!
  const t = Math.max(0, Math.min(1, (z - a.z) / (b.z - a.z)))
  const at = (s: Station) => {
    const p = s.pts
    for (let k = 0; k + 1 < p.length; k++) {
      const [x0, y0] = p[k]!
      const [x1, y1] = p[k + 1]!
      if (y >= y0 && y <= y1 && y1 > y0) return x0 + ((x1 - x0) * (y - y0)) / (y1 - y0)
    }
    return y < p[0]![1] ? 0 : p[p.length - 1]![0]
  }
  return at(a) * (1 - t) + at(b) * t
}

function buildHull(m: Mesh): void {
  const ring = (s: Station): V3[] => {
    const stbd = s.pts.slice(1).map(([x, y]): V3 => [x, y, s.z])
    const port = s.pts
      .slice(1)
      .map(([x, y]): V3 => [-x, y, s.z])
      .reverse()
    return [...port, ...stbd]
  }
  const rings = STATIONS.map(ring)
  for (let i = 0; i + 1 < rings.length; i++) {
    const a = rings[i]!
    const b = rings[i + 1]!
    const zc = (STATIONS[i]!.z + STATIONS[i + 1]!.z) / 2
    for (let j = 0; j + 1 < a.length; j++) {
      // Faces point away from a point on the centreline, pulled toward midships so bow and stern faces turn outward.
      const inside: V3 = [0, 3, zc * 0.8]
      bandFacet(m, a[j]!, a[j + 1]!, b[j + 1]!, inside)
      bandFacet(m, a[j]!, b[j + 1]!, b[j]!, inside)
    }
  }
  // Transom: flat stern face from the hull bottom up to the deck slab.
  const t = rings[0]!
  const z = STATIONS[0]!.z
  for (let j = 0; j + 1 < t.length; j++) bandFacet(m, [0, DECK_SLAB_Y, z], t[j]!, t[j + 1]!, [0, 6, z + 5])
  // Bow face: closes the last section up to the deck slab.
  const bow = rings[rings.length - 1]!
  const bz = STATIONS[STATIONS.length - 1]!.z
  for (let j = 0; j + 1 < bow.length; j++) bandFacet(m, [0, DECK_SLAB_Y, bz], bow[j]!, bow[j + 1]!, [0, 6, bz - 5])
  // Hangar opening in the transom (stern elevation: 35 m wide, from 4 m below the deck to 15 m above the waterline),
  // with a lighter rail panel and posts across its lower part.
  const ow = 17.7
  const y0 = 8.7
  const y1 = 17.4
  const back: V3 = [0, 0, -1]
  const zf = z - 0.08
  polyFacing(m, [[-ow, y0, zf], [ow, y0, zf], [ow, y1, zf], [-ow, y1, zf]], back, PAL.opening)
  polyFacing(m, [[-ow + 1.2, y0 + 1, zf - 0.02], [ow - 1.2, y0 + 1, zf - 0.02], [ow - 1.2, y1 - 1.2, zf - 0.02], [-ow + 1.2, y1 - 1.2, zf - 0.02]], back, PAL.openingDeep)
  m.box(-13, y0 + 3.6, zf - 0.5, 13, y0 + 4.3, zf - 0.1, PAL.rail)
  for (const px of [-12.6, -6.3, 0, 6.3, 12.6]) m.box(px - 0.35, y0, zf - 0.45, px + 0.35, y0 + 4.3, zf - 0.1, PAL.rail)
  m.box(-ow - 0.4, y0 - 0.6, zf - 0.6, ow + 0.4, y0, zf, PAL.hullLight)
  // Small square windows either side of the opening.
  for (const s of [-1, 1]) {
    for (const wx of [21, 24.5]) polyFacing(m, [[s * wx - 1, 13.6, zf], [s * wx + 1, 13.6, zf], [s * wx + 1, 15.4, zf], [s * wx - 1, 15.4, zf]], back, PAL.opening)
    for (const wx of [-4, 4]) polyFacing(m, [[wx - 1, 21, zf], [wx + 1, 21, zf], [wx + 1, 22.4, zf], [wx - 1, 22.4, zf]], back, PAL.opening)
  }
  // Hawse pipes: dark angled slots on the bow flare.
  for (const s of [-1, 1]) {
    const from = m.length
    polyFacing(m, [[-1.8, -0.6, 0], [1.8, -0.6, 0], [1.8, 0.6, 0], [-1.8, 0.6, 0]], [0, 0, 1], PAL.opening)
    placeYaw(m, from, s * 0.4, s * 19, 9.5, 161.4)
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Flight deck slab, plates and markings

const PLATE_X = 76 / 12
const PLATE_Z = 7.5

function buildDeck(m: Mesh): void {
  const y = DECK_Y
  // Plates with a faint per-plate tone change, as in the concepts.
  const zTop = BOW_Z - BOW_NOTCH
  const nx = Math.round((DECK_X1 - DECK_X0) / PLATE_X)
  const nz = Math.ceil((zTop - STERN_Z) / PLATE_Z)
  for (let i = 0; i < nx; i++)
    for (let k = 0; k < nz; k++) {
      const x0 = DECK_X0 + i * PLATE_X
      const z0 = STERN_Z + k * PLATE_Z
      const z1 = Math.min(zTop, z0 + PLATE_Z)
      const tone = 0.95 + hash(i, k) * 0.1
      flat(m, x0, z0, x0 + PLATE_X, z1, y, scale(PAL.deck, tone))
    }
  flat(m, DECK_X0 + BOW_NOTCH, zTop, DECK_X1 - BOW_NOTCH, BOW_Z, y, PAL.deck)
  // Slab edges (the lip seen under the deck-edge line) and the underside.
  const ol: [number, number][] = [
    [DECK_X0, STERN_Z],
    [DECK_X0, zTop],
    [DECK_X0 + BOW_NOTCH, zTop],
    [DECK_X0 + BOW_NOTCH, BOW_Z],
    [DECK_X1 - BOW_NOTCH, BOW_Z],
    [DECK_X1 - BOW_NOTCH, zTop],
    [DECK_X1, zTop],
    [DECK_X1, STERN_Z],
  ]
  for (let i = 0; i < ol.length; i++) {
    const [ax, az] = ol[i]!
    const [bx, bz] = ol[(i + 1) % ol.length]!
    const inside: V3 = [ax === bx ? (ax < 0 ? ax + 5 : ax - 5) : (ax + bx) / 2, 15, az === bz ? (az < 0 ? az + 5 : az - 5) : (az + bz) / 2]
    polyOut(m, [[ax, DECK_SLAB_Y, az], [bx, DECK_SLAB_Y, bz], [bx, y, bz], [ax, y, az]], inside, PAL.slab)
    // Lighter top bevel strip on the lip.
    polyOut(m, [[ax, y - 0.7, az], [bx, y - 0.7, bz], [bx, y, bz], [ax, y, az]], inside, PAL.hullLight)
  }
  m.quad([DECK_X0, DECK_SLAB_Y, STERN_Z], [DECK_X1, DECK_SLAB_Y, STERN_Z], [DECK_X1, DECK_SLAB_Y, zTop], [DECK_X0, DECK_SLAB_Y, zTop], [0, -1, 0], PAL.under)
  m.quad([DECK_X0 + BOW_NOTCH, DECK_SLAB_Y, zTop], [DECK_X1 - BOW_NOTCH, DECK_SLAB_Y, zTop], [DECK_X1 - BOW_NOTCH, DECK_SLAB_Y, BOW_Z], [DECK_X0 + BOW_NOTCH, DECK_SLAB_Y, BOW_Z], [0, -1, 0], PAL.under)
  // Square ports along the bow lip, as in the hero.
  for (const wx of [-30, -14, 4, 20, 31]) m.quad([wx - 1.1, 20.4, BOW_Z + 0.05], [wx + 1.1, 20.4, BOW_Z + 0.05], [wx + 1.1, 22.4, BOW_Z + 0.05], [wx - 1.1, 22.4, BOW_Z + 0.05], [0, 0, 1], PAL.opening)
}

function buildMarkings(m: Mesh): void {
  const yE = DECK_Y + 0.02
  const yL = DECK_Y + 0.03
  const zTop = BOW_Z - BOW_NOTCH
  // Deck-edge lines: the runway's port edge (+X), the starboard deck edge (−X), and across the bow and stern.
  // (`flat` takes x0 < x1, z0 < z1.)
  const portEdge = RUNWAY.x1
  const stbdEdge = DECK_X0 + 1.0
  flat(m, portEdge - 0.6, STERN_Z + 1.2, portEdge + 0.6, zTop - 1.0, yE, PAL.white)
  flat(m, stbdEdge, STERN_Z + 1.2, stbdEdge + 0.6, zTop - 1.0, yE, PAL.white)
  flat(m, stbdEdge, zTop - 2.0, portEdge + 0.6, zTop - 1.0, yE, PAL.white)
  flat(m, stbdEdge, STERN_Z + 1.2, portEdge + 0.6, STERN_Z + 2.2, yE, PAL.white)
  // Apron line: white aft of the island's lane, yellow forward.
  flat(m, APRON_LINE_X - 0.5, STERN_Z + 2.2, APRON_LINE_X + 0.5, APRON_LINE_YELLOW_Z, yL, PAL.white)
  flat(m, APRON_LINE_X - 0.5, APRON_LINE_YELLOW_Z, APRON_LINE_X + 0.5, zTop - 2.0, yL, PAL.yellow)
  // Thin yellow guide line.
  flat(m, GUIDE_X - 0.4, STERN_Z + 8, GUIDE_X + 0.4, NUMBER_Z0 - 4, yL, PAL.yellow)
  // Dashed centreline.
  for (let z = DASH.from; z + DASH.length <= DASH.to; z += DASH.period) flat(m, CENTERLINE_X - 0.6, z, CENTERLINE_X + 0.6, z + DASH.length, yL, PAL.white)
  // Threshold piano keys at the stern end.
  for (let i = 0; i < THRESHOLD.stripes; i++) {
    const cx = CENTERLINE_X + (i - (THRESHOLD.stripes - 1) / 2) * THRESHOLD.pitch
    flat(m, cx - THRESHOLD.width / 2, THRESHOLD.z0, cx + THRESHOLD.width / 2, THRESHOLD.z1, yL, PAL.white)
  }
  // "07": read by someone at the bow facing aft (port, +X, on their right): digit-local u runs to +X, v runs
  // aft-to-bow (the top of each digit is aft), so the "0" sits on the starboard side of the "7". Built in place, never
  // mirrored.
  const W = NUMBER_DIGIT_W
  const L = NUMBER_DIGIT_L
  const s = 3
  const left = CENTERLINE_X - (2 * W + NUMBER_GAP) / 2
  const seg = (ox: number, u0: number, v0: number, u1: number, v1: number) => flat(m, ox + u0, NUMBER_Z0 + v0, ox + u1, NUMBER_Z0 + v1, yL, PAL.white)
  // "0": an octagonal ring with equal chamfers on all four corners, so it reads as a zero from any side, not a "D".
  const oct = (inset: number, c: number): [number, number][] => [
    [left + inset + c, NUMBER_Z0 + inset],
    [left + W - inset - c, NUMBER_Z0 + inset],
    [left + W - inset, NUMBER_Z0 + inset + c],
    [left + W - inset, NUMBER_Z0 + L - inset - c],
    [left + W - inset - c, NUMBER_Z0 + L - inset],
    [left + inset + c, NUMBER_Z0 + L - inset],
    [left + inset, NUMBER_Z0 + L - inset - c],
    [left + inset, NUMBER_Z0 + inset + c],
  ]
  const outer = oct(0, 3.8)
  const inner = oct(s, 1.8)
  for (let k = 0; k < 8; k++) flat4(m, [outer[k]!, outer[(k + 1) % 8]!, inner[(k + 1) % 8]!, inner[k]!], yL, PAL.white)
  const o7 = left + W + NUMBER_GAP
  seg(o7, 0, 0, W, s)
  flat4(
    m,
    [
      [o7 + W - s - 0.2, NUMBER_Z0 + s],
      [o7 + W, NUMBER_Z0 + s],
      [o7 + 5.2, NUMBER_Z0 + L],
      [o7 + 5.2 - s - 0.4, NUMBER_Z0 + L],
    ],
    yL,
    PAL.white,
  )
  // Parking bays on the apron: separators with red-and-white ends, and a ring under the helicopter.
  for (const p of PARKING) {
    if (p.kind === "jet") {
      for (const dz of [-12.5, 12.5]) {
        const z0 = p.z + dz - 0.25
        const z1 = p.z + dz + 0.25
        // Across the apron, from near the starboard edge (−X) to just short of the apron line.
        flat(m, DECK_X0 + 2.6, z0, APRON_LINE_X - 1.6, z1, yE, PAL.white)
        for (const [a, b] of [
          [APRON_LINE_X - 3.6, APRON_LINE_X - 1.6],
          [DECK_X0 + 2.6, DECK_X0 + 4.6],
        ] as const)
          for (let k = 0; k < 4; k++) flat(m, a + (k * (b - a)) / 4, z0, a + ((k + 1) * (b - a)) / 4, z1, yL, k % 2 ? PAL.white : PAL.red2)
      }
    }
    if (p.kind === "helicopter") {
      const n = 20
      for (let k = 0; k < n; k++) {
        const a0 = (k / n) * Math.PI * 2
        const a1 = ((k + 1) / n) * Math.PI * 2
        const r0 = 5.0
        const r1 = 5.5
        flat4(
          m,
          [
            [p.x + Math.cos(a0) * r0, p.z + Math.sin(a0) * r0],
            [p.x + Math.cos(a0) * r1, p.z + Math.sin(a0) * r1],
            [p.x + Math.cos(a1) * r1, p.z + Math.sin(a1) * r1],
            [p.x + Math.cos(a1) * r0, p.z + Math.sin(a1) * r0],
          ],
          yE,
          PAL.white,
        )
      }
    }
  }
  // Short orange guide lines on the apron (taxi lead-ins seen in the hero).
  for (const z of [44, 50]) flat(m, APRON_LINE_X - 16, z - 0.15, APRON_LINE_X - 4, z + 0.15, yE, PAL.orange)
}

// ---------------------------------------------------------------------------------------------------------------------
// Sponsons, catwalks and the elevator

/** A catwalk/sponson box under the deck edge: z range, protrusion beyond the deck edge, top below the deck, height. */
type Sponson = { z0: number; z1: number; out: number; top: number; h: number; door?: boolean; rail?: boolean }

/** Port side, bow to stern: the stepping rhythm of the hero's port flank (the elevator's support sits in the gap). */
const PORT_SPONSONS: Sponson[] = [
  { z0: 146, z1: 158, out: 2.4, top: 0.7, h: 4.9, door: true },
  { z0: 124, z1: 140, out: 4.4, top: 0.4, h: 6.3, door: true, rail: true },
  { z0: 104, z1: 118, out: 2.8, top: 1.6, h: 4.9 },
  { z0: 80, z1: 98, out: 5, top: 0.4, h: 7, door: true, rail: true },
  { z0: 58, z1: 74, out: 3.4, top: 1.2, h: 5.6, door: true },
  { z0: 37, z1: 54, out: 5, top: 0.4, h: 6.3, rail: true },
  { z0: -16, z1: -3, out: 3, top: 1.2, h: 4.9, door: true },
  { z0: -40, z1: -24, out: 4, top: 0.8, h: 5.6, door: true },
  { z0: -64, z1: -44, out: 5, top: 0.4, h: 7, door: true, rail: true },
  { z0: -88, z1: -72, out: 3, top: 1.4, h: 4.9 },
  { z0: -114, z1: -94, out: 4.6, top: 0.4, h: 6.3, door: true, rail: true },
  { z0: -140, z1: -122, out: 3.4, top: 1, h: 5.6, door: true },
  { z0: -163, z1: -146, out: 4, top: 0.4, h: 5.6, rail: true },
]

/** Starboard side, bow to stern. */
const STBD_SPONSONS: Sponson[] = [
  { z0: 146, z1: 158, out: 2.4, top: 0.7, h: 4.9, door: true },
  { z0: 120, z1: 138, out: 4.6, top: 0.4, h: 6.3, door: true, rail: true },
  { z0: 98, z1: 112, out: 3, top: 1.4, h: 4.9, rail: true },
  { z0: 70, z1: 90, out: 5, top: 0.4, h: 7, door: true, rail: true },
  { z0: 46, z1: 62, out: 3.4, top: 1.2, h: 5.6, door: true },
  { z0: 16, z1: 38, out: 4.6, top: 0.4, h: 6.3, rail: true },
  { z0: -14, z1: 4, out: 3.2, top: 1, h: 5.6, door: true },
  { z0: -48, z1: -24, out: 5, top: 0.4, h: 7, door: true, rail: true },
  { z0: -74, z1: -58, out: 3, top: 1.4, h: 4.9 },
  { z0: -104, z1: -84, out: 4.6, top: 0.4, h: 6.3, door: true, rail: true },
  { z0: -132, z1: -114, out: 3.4, top: 1, h: 5.6, door: true },
  { z0: -163, z1: -142, out: 4, top: 0.4, h: 5.6, rail: true },
]

function railing(m: Mesh, pts: V3[], h: number): void {
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!
    const b = pts[i + 1]!
    beam(m, [a[0], a[1] + h, a[2]], [b[0], b[1] + h, b[2]], 0.18, PAL.rail)
    const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[2] - a[2]) / 4))
    for (let k = 0; k <= n; k++) {
      if (k === n && i + 2 < pts.length) continue
      const t = k / n
      const p: V3 = [a[0] + (b[0] - a[0]) * t, a[1], a[2] + (b[2] - a[2]) * t]
      beam(m, p, [p[0], p[1] + h, p[2]], 0.16, PAL.rail)
    }
  }
}

function buildSponsons(m: Mesh): void {
  // side: +1 port (+X), −1 starboard (−X).
  for (const side of [-1, 1] as const) {
    for (const s of side > 0 ? PORT_SPONSONS : STBD_SPONSONS) {
      const y1 = DECK_Y - s.top
      const y0 = y1 - s.h
      const zc = (s.z0 + s.z1) / 2
      const xo = 38 + s.out
      const xi = Math.min(hullHalfWidth(y0, zc), hullHalfWidth(y0, s.z0), hullHalfWidth(y0, s.z1)) - 0.5
      const [x0, x1] = side > 0 ? [xi, xo] : [-xo, -xi]
      m.bevelBox(x0, y0, s.z0, x1, y1, s.z1, 0.35, PAL.hull, PAL.hullLight)
      m.quad([x0, y0, s.z0], [x1, y0, s.z0], [x1, y0, s.z1], [x0, y0, s.z1], [0, -1, 0], PAL.under)
      // A sloped underside block tying the box into the hull.
      const xf = side * (xo - 1.2)
      const xh = side * (hullHalfWidth(y0 - 5, zc) - 0.4)
      const zi0 = s.z0 + 1
      const zi1 = s.z1 - 1
      const inside: V3 = [side * 20, y0, zc]
      polyOut(m, [[xf, y0, zi0], [xf, y0, zi1], [xh, y0 - 5, zi1], [xh, y0 - 5, zi0]], inside, PAL.under)
      polyOut(m, [[xf, y0, zi0], [xh, y0 - 5, zi0], [xh, y0, zi0]], inside, PAL.hull)
      polyOut(m, [[xf, y0, zi1], [xh, y0 - 5, zi1], [xh, y0, zi1]], inside, PAL.hull)
      // A darker recessed band under the top (the catwalk's shadowed gallery).
      const xd = side * (xo + 0.05)
      const n: V3 = [side, 0, 0]
      if (s.door) {
        const w = Math.min(2.4, (s.z1 - s.z0) / 5)
        for (const dz of [-(s.z1 - s.z0) / 4, (s.z1 - s.z0) / 4]) polyFacing(m, [[xd, y1 - 4.6, zc + dz - w], [xd, y1 - 4.6, zc + dz + w], [xd, y1 - 1.6, zc + dz + w], [xd, y1 - 1.6, zc + dz - w]], n, PAL.opening)
      } else polyFacing(m, [[xd, y1 - 3.2, s.z0 + 1.5], [xd, y1 - 3.2, s.z1 - 1.5], [xd, y1 - 1.4, s.z1 - 1.5], [xd, y1 - 1.4, s.z0 + 1.5]], n, PAL.openingDeep)
      if (s.rail && !underWeapon(side, s)) {
        const xr = side * (xo - 0.25)
        railing(
          m,
          [
            [side * 38.2, y1, s.z0 + 0.3],
            [xr, y1, s.z0 + 0.3],
            [xr, y1, s.z1 - 0.3],
            [side * 38.2, y1, s.z1 - 0.3],
          ],
          1.1,
        )
      }
    }
  }
}

/** A catwalk whose z range meets a weapon sponson on the same side: its railing would poke through the weapon deck. */
const underWeapon = (side: 1 | -1, s: Sponson) => WEAPON_MOUNTS.some((w) => (w.side === "port" ? 1 : -1) === side && s.z0 < w.sponson.z1 && s.z1 > w.sponson.z0)

/** The weapon sponsons of `WEAPON_MOUNTS` (the weapons themselves are `render/ship-weapons.ts`): a deep box hung off
 *  the deck edge with a brace down to the hull, a gallery band and a railing round its outboard edges. */
function buildWeaponSponsons(m: Mesh): void {
  for (const w of WEAPON_MOUNTS) {
    const b = w.sponson
    const side = w.side === "port" ? 1 : -1
    const zc = (b.z0 + b.z1) / 2
    m.bevelBox(b.x0, b.y0, b.z0, b.x1, b.y1, b.z1, 0.35, PAL.hull, PAL.hullLight)
    m.quad([b.x0, b.y0, b.z0], [b.x1, b.y0, b.z0], [b.x1, b.y0, b.z1], [b.x0, b.y0, b.z1], [0, -1, 0], PAL.under)
    const xo = side > 0 ? b.x1 : b.x0
    const xf = xo - side * 1.4
    const yb = b.y0 - 7
    const xh = side * (hullHalfWidth(yb, zc) - 0.4)
    const zi0 = b.z0 + 1.2
    const zi1 = b.z1 - 1.2
    const inside: V3 = [side * 20, b.y0, zc]
    polyOut(m, [[xf, b.y0, zi0], [xf, b.y0, zi1], [xh, yb, zi1], [xh, yb, zi0]], inside, PAL.under)
    polyOut(m, [[xf, b.y0, zi0], [xh, yb, zi0], [xh, b.y0, zi0]], inside, PAL.hull)
    polyOut(m, [[xf, b.y0, zi1], [xh, yb, zi1], [xh, b.y0, zi1]], inside, PAL.hull)
    polyFacing(m, [[xo + side * 0.05, b.y1 - 3, b.z0 + 1.4], [xo + side * 0.05, b.y1 - 3, b.z1 - 1.4], [xo + side * 0.05, b.y1 - 1.5, b.z1 - 1.4], [xo + side * 0.05, b.y1 - 1.5, b.z0 + 1.4]], [side, 0, 0], PAL.openingDeep)
    const xr = xo - side * 0.3
    const xd = side * (DECK_X1 + 0.2)
    railing(
      m,
      [
        [xd, b.y1, b.z0 + 0.3],
        [xr, b.y1, b.z0 + 0.3],
        [xr, b.y1, b.z1 - 0.3],
        [xd, b.y1, b.z1 - 0.3],
      ],
      1.0,
    )
  }
}

/** Authoring rect on the −X side for geometry that is built there and then mirrored to its true +X/−X place. */
const mirrorRect = <R extends { x0: number; x1: number }>(r: R): R => ({ ...r, x0: -r.x1, x1: -r.x0 })

/** Port deck-edge elevator: authored on −X (its side faces −X), then mirrored onto the port side (+X). No lettering. */
function buildElevator(m: Mesh): void {
  const from = m.length
  buildElevatorAt(m, mirrorRect(ELEVATOR))
  mirrorX(m, from)
}

function buildElevatorAt(m: Mesh, e: Rect): void {
  const y = DECK_Y
  m.box(e.x0, y - 1.2, e.z0, e.x1, y, e.z1, PAL.slab, MAT.lit, 0, PAL.deck, true)
  // Dashed yellow/white border and a centre stripe.
  const yb = y + 0.03
  const bw = 0.6
  const dash = (x0: number, z0: number, x1: number, z1: number) => {
    const along = x1 - x0 > z1 - z0
    const len = along ? x1 - x0 : z1 - z0
    const n = Math.max(2, Math.round(len / 1.6))
    for (let k = 0; k < n; k++) {
      const a = k / n
      const b = (k + 1) / n
      const col = k % 2 ? PAL.white : PAL.yellow
      if (along) flat(m, x0 + (x1 - x0) * a, z0, x0 + (x1 - x0) * b, z1, yb, col)
      else flat(m, x0, z0 + (z1 - z0) * a, x1, z0 + (z1 - z0) * b, yb, col)
    }
  }
  dash(e.x0 + 0.5, e.z0 + 0.5, e.x1 - 0.5, e.z0 + 0.5 + bw)
  dash(e.x0 + 0.5, e.z1 - 0.5 - bw, e.x1 - 0.5, e.z1 - 0.5)
  dash(e.x0 + 0.5, e.z0 + 0.5 + bw, e.x0 + 0.5 + bw, e.z1 - 0.5 - bw)
  dash(e.x1 - 0.5 - bw, e.z0 + 0.5 + bw, e.x1 - 0.5, e.z1 - 0.5 - bw)
  // Support below: a sponson box under the inboard part of the platform, with a dark hangar door in its side.
  const sy0 = y - 9
  const sx0 = e.x0 + 4
  const xi = -(hullHalfWidth(sy0, (e.z0 + e.z1) / 2) - 0.5)
  m.bevelBox(sx0, sy0, e.z0 + 2, xi, y - 1.2, e.z1 - 2, 0.3, PAL.hull, PAL.hullLight)
  m.quad([sx0, sy0, e.z0 + 2], [xi, sy0, e.z0 + 2], [xi, sy0, e.z1 - 2], [sx0, sy0, e.z1 - 2], [0, -1, 0], PAL.under)
  polyFacing(m, [[sx0 - 0.06, sy0 + 1.5, e.z0 + 7], [sx0 - 0.06, sy0 + 1.5, e.z1 - 7], [sx0 - 0.06, y - 2.6, e.z1 - 7], [sx0 - 0.06, y - 2.6, e.z0 + 7]], [-1, 0, 0], PAL.opening)
}

// ---------------------------------------------------------------------------------------------------------------------
// Island

/** Window band: dark glazed quads on the faces of a box between y0 and y1, inset from the corners. */
function windowBand(m: Mesh, x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, faces: ("n" | "s" | "e" | "w")[], panes = 0.9): void {
  const e = 0.06
  const step = 2.4
  const put = (a: V3, b: V3, n: V3) => {
    const len = Math.hypot(b[0] - a[0], b[2] - a[2])
    const k = Math.max(1, Math.round(len / step))
    for (let i = 0; i < k; i++) {
      const t0 = (i + (1 - panes) / 2) / k
      const t1 = (i + 1 - (1 - panes) / 2) / k
      const p0: V3 = [a[0] + (b[0] - a[0]) * t0, y0, a[2] + (b[2] - a[2]) * t0]
      const p1: V3 = [a[0] + (b[0] - a[0]) * t1, y0, a[2] + (b[2] - a[2]) * t1]
      polyOut(m, [p0, p1, [p1[0], y1, p1[2]], [p0[0], y1, p0[2]]], [p0[0] - n[0], (y0 + y1) / 2, p0[2] - n[2]], PAL.window, MAT.glow, 0)
    }
  }
  if (faces.includes("n")) put([x0 + 0.5, 0, z1 + e], [x1 - 0.5, 0, z1 + e], [0, 0, 1])
  if (faces.includes("s")) put([x0 + 0.5, 0, z0 - e], [x1 - 0.5, 0, z0 - e], [0, 0, -1])
  if (faces.includes("e")) put([x1 + e, 0, z0 + 0.5], [x1 + e, 0, z1 - 0.5], [1, 0, 0])
  if (faces.includes("w")) put([x0 - e, 0, z0 + 0.5], [x0 - e, 0, z1 - 0.5], [-1, 0, 0])
}

/** Dark door or hatch on a face. */
function hatch(m: Mesh, face: "n" | "s" | "e" | "w", u: number, at: number, y0: number, w: number, h: number): void {
  const e = 0.06
  const pts: V3[] =
    face === "n" || face === "s"
      ? [
          [u - w / 2, y0, at + (face === "n" ? e : -e)],
          [u + w / 2, y0, at + (face === "n" ? e : -e)],
          [u + w / 2, y0 + h, at + (face === "n" ? e : -e)],
          [u - w / 2, y0 + h, at + (face === "n" ? e : -e)],
        ]
      : [
          [at + (face === "e" ? e : -e), y0, u - w / 2],
          [at + (face === "e" ? e : -e), y0, u + w / 2],
          [at + (face === "e" ? e : -e), y0 + h, u + w / 2],
          [at + (face === "e" ? e : -e), y0 + h, u - w / 2],
        ]
  const n: V3 = face === "n" ? [0, 0, 1] : face === "s" ? [0, 0, -1] : face === "e" ? [1, 0, 0] : [-1, 0, 0]
  polyOut(m, pts, [pts[0]![0] - n[0], y0, pts[0]![2] - n[2]], PAL.opening)
}

/** Forward face of the island's main blocks (the lower radome sponson projects ahead of it to `ISLAND.z1`). */
const ISLAND_FWD = ISLAND.z1 - 6
/** Tower and radar heights (absolute), shared by the island and the radar pivot. `x` is in the island's authoring frame
 *  (mirrored, see `buildIsland`); the true position is −x. */
const MAST = { x: 31.4, z: ISLAND_FWD - 12, base: DECK_Y + 26.4, yard: DECK_Y + 35, top: DECK_Y + 39.6 }

/**
 * Island, measured on the hero (heights in metres above the deck, scaled from its 47 m radar top): a 12 m base block
 * with a lower radome cantilevered off its forward-outboard corner at mid height; the bridge tier (12-20 m) with a
 * full-width dark window band on its forward face and an overhanging roof; a narrower upper tier (to 26.4 m) with the
 * second radome on a box at its forward-outboard corner and railed platforms inboard; a solid tower to a wide yardarm
 * with whip antennas at 35 m; and the platform block carrying the spinning rectangular radar.
 *
 * Authored with the island on +X (outboard = +X, inboard faces "w"), then mirrored onto the starboard edge (−X). It
 * carries no lettering, so mirroring is exact.
 */
function buildIsland(m: Mesh): void {
  const from = m.length
  buildIslandAt(m, mirrorRect(ISLAND))
  mirrorX(m, from)
}

function buildIslandAt(m: Mesh, I: Box): void {
  const y = DECK_Y
  const col = PAL.island
  const roof = PAL.islandRoof
  const dark = PAL.islandDark
  const a = I.z0
  const F = ISLAND_FWD
  // Base block, with a lower darker annex aft.
  const b0 = a + 7
  m.bevelBox(I.x0, y, b0, I.x1, y + 12, F, 0.35, col, roof)
  m.bevelBox(I.x0 + 2.5, y, a, I.x1, y + 8, b0, 0.35, dark, roof)
  // Vertical panel seams and hatches on the base.
  for (const u of [I.x0 + 5, I.x0 + 10.5]) polyFacing(m, [[u - 0.1, y + 0.3, F + 0.05], [u + 0.1, y + 0.3, F + 0.05], [u + 0.1, y + 11.6, F + 0.05], [u - 0.1, y + 11.6, F + 0.05]], [0, 0, 1], dark)
  hatch(m, "n", I.x0 + 2.5, F, y, 2, 3.4)
  hatch(m, "w", F - 6, I.x0, y, 2.2, 3.4)
  hatch(m, "w", b0 + 9, I.x0, y, 2.2, 3.4)
  hatch(m, "s", I.x0 + 8, a, y, 2.2, 3.4)
  windowBand(m, I.x0, b0, I.x1, F, y + 8.4, y + 9.4, ["w", "e"], 0.4)
  // Lower radome: a bracketed platform off the forward-starboard corner, above a small deck-house.
  const rz = F + 3.2
  m.bevelBox(32.4, y, F, 38.2, y + 4.4, F + 5.2, 0.25, col, roof)
  m.box(30.6, y + 4.4, F - 1, 39.4, y + 5.6, I.z1, dark, MAT.lit, 0, roof, true)
  geoSphere(m, [34.9, y + 9.2, rz], 3.6, PAL.radome, 1, y + 5.8)
  m.prism(34.9, rz, 2.2, 2.2, y + 5.6, y + 6.4, 8, dark)
  railing(
    m,
    [
      [30.8, y + 5.6, F - 0.8],
      [30.8, y + 5.6, I.z1 - 0.2],
      [39.2, y + 5.6, I.z1 - 0.2],
      [39.2, y + 5.6, F - 0.8],
    ],
    1.0,
  )
  // Bridge tier: full-width window band on the forward face, wrapping the sides; overhanging roof.
  const t0 = b0 + 3
  m.bevelBox(I.x0 + 0.3, y + 12, t0, I.x1, y + 20, F + 0.5, 0.3, col, roof)
  windowBand(m, I.x0 + 0.3, t0, I.x1, F + 0.5, y + 14.4, y + 17.2, ["n"], 0.86)
  windowBand(m, I.x0 + 0.3, F - 9, I.x1, F + 0.5, y + 14.4, y + 17.2, ["w", "e"], 0.8)
  m.box(I.x0, y + 20, t0 - 0.4, I.x1 + 0.3, y + 20.7, F + 1.3, dark, MAT.lit, 0, roof, true)
  // Bridge wing with a rail off the port side.
  m.box(I.x0 - 2.4, y + 12.4, F - 7, I.x0 + 0.4, y + 13, F - 0.5, dark, MAT.lit, 0, roof, true)
  railing(
    m,
    [
      [I.x0 - 2.2, y + 13, F - 6.8],
      [I.x0 - 2.2, y + 13, F - 0.7],
    ],
    1.0,
  )
  // Upper tier, set in from port; the second radome sits on a box at its forward-starboard corner.
  const u0 = t0 + 4
  const ux0 = I.x0 + 3
  m.bevelBox(ux0, y + 20.7, u0, I.x1 - 0.6, y + 26.4, F - 1, 0.3, col, roof)
  windowBand(m, ux0, u0, I.x1 - 0.6, F - 1, y + 23, y + 24, ["n", "w"], 0.45)
  const r2z = F - 4
  m.box(31.8, y + 20.7, F - 8, 38.2, y + 23.2, F, col, MAT.lit, 0, roof)
  m.box(31.4, y + 23.2, F - 8.4, 38.6, y + 23.8, F + 0.4, dark, MAT.lit, 0, roof, true)
  geoSphere(m, [35, y + 26.8, r2z], 3.1, PAL.radome, 1, y + 23.6)
  m.prism(35, r2z, 1.8, 1.8, y + 23.8, y + 24.5, 8, dark)
  // Railed platforms on the port side of the upper tier and the tower base.
  m.box(I.x0 + 0.6, y + 20.7, F - 9, ux0, y + 21.3, F - 1.5, dark, MAT.lit, 0, roof, true)
  railing(
    m,
    [
      [I.x0 + 0.8, y + 21.3, F - 8.8],
      [I.x0 + 0.8, y + 21.3, F - 1.7],
    ],
    1.0,
  )
  m.box(ux0 - 1.6, y + 26.4, MAST.z - 4, MAST.x - 3, y + 27, MAST.z + 4, dark, MAT.lit, 0, roof, true)
  railing(
    m,
    [
      [ux0 - 1.4, y + 27, MAST.z - 3.8],
      [ux0 - 1.4, y + 27, MAST.z + 3.8],
    ],
    1.0,
  )
  // Solid tower, a little narrower at the top, with a hatch and a small box.
  const tw = 3
  loft(
    m,
    [
      [
        [MAST.x - tw, MAST.base, MAST.z - 3.6],
        [MAST.x + tw, MAST.base, MAST.z - 3.6],
        [MAST.x + tw, MAST.base, MAST.z + 3.6],
        [MAST.x - tw, MAST.base, MAST.z + 3.6],
      ],
      [
        [MAST.x - 2.4, MAST.yard, MAST.z - 2.8],
        [MAST.x + 2.4, MAST.yard, MAST.z - 2.8],
        [MAST.x + 2.4, MAST.yard, MAST.z + 2.8],
        [MAST.x - 2.4, MAST.yard, MAST.z + 2.8],
      ],
    ],
    col,
  )
  hatch(m, "w", MAST.z, MAST.x - tw + 0.08, MAST.base + 0.6, 1.4, 2.2)
  m.box(MAST.x - 1.6, MAST.base + 3.8, MAST.z + 3.0, MAST.x + 1.6, MAST.base + 5.6, MAST.z + 3.8, dark)
  // Yardarm with whip antennas at both ends and a few short ones.
  const ya = MAST.yard
  m.box(MAST.x - 10, ya, MAST.z - 0.4, MAST.x + 10, ya + 0.7, MAST.z + 0.4, roof)
  m.box(MAST.x - 3.2, ya - 0.4, MAST.z - 1.8, MAST.x + 3.2, ya + 1, MAST.z + 1.8, col, MAT.lit, 0, roof)
  for (const dx of [-9.3, 9.3]) beam(m, [MAST.x + dx, ya - 2.6, MAST.z], [MAST.x + dx, ya + 5.4, MAST.z], 0.24, PAL.mast)
  for (const dx of [-6.4, -4.8, 4.8, 6.4]) beam(m, [MAST.x + dx, ya + 0.7, MAST.z], [MAST.x + dx, ya + 2.1, MAST.z], 0.2, PAL.mast)
  // Short mast up to the platform block that carries the radar pedestal.
  m.box(MAST.x - 1.4, ya + 1, MAST.z - 1.4, MAST.x + 1.4, MAST.top - 2.2, MAST.z + 1.4, PAL.mast)
  m.bevelBox(MAST.x - 4.4, MAST.top - 2.2, MAST.z - 2.8, MAST.x + 4.4, MAST.top, MAST.z + 2.8, 0.25, col, roof)
  m.prism(MAST.x, MAST.z, 1, 0.8, MAST.top, MAST.top + 0.8, 8, PAL.mast)
  // Small antennas on the bridge roof, a stub on the aft annex.
  beam(m, [I.x0 + 1.8, y + 20.7, F - 2], [I.x0 + 1.8, y + 25.4, F - 2], 0.22, PAL.mast)
  beam(m, [I.x1 - 1, y + 20.7, t0 + 2], [I.x1 - 1, y + 23.5, t0 + 2], 0.2, PAL.mast)
  beam(m, [I.x0 + 5, y + 8, a + 1.5], [I.x0 + 5, y + 11.5, a + 1.5], 0.2, PAL.mast)
  // Yellow deck equipment at the island's foot, against the port face.
  m.bevelBox(I.x0 - 3, y, F - 16, I.x0 - 0.4, y + 2.4, F - 12.5, 0.15, hex(0xe2b22c), hex(0xecc040))
  m.bevelBox(I.x0 - 2.8, y, F - 10.5, I.x0 - 0.4, y + 2.2, F - 7, 0.15, hex(0xe2b22c), hex(0xecc040))
}

/** Pivot of the spinning radar array, ship-local. */
export const RADAR_PIVOT: [number, number, number] = [-MAST.x, MAST.top + 0.8, MAST.z]

/** Rectangular phased-array radar, built around its pivot (origin = top of the pedestal), facing ±Z, tilted back. */
function buildRadar(m: Mesh): void {
  const w = 4.3
  const h0 = 0.6
  const h1 = 5.4
  m.box(-0.5, 0, -0.5, 0.5, h0 + 0.2, 0.5, PAL.mast)
  const from = m.length
  // Panel: frame plus a dark grid face on both sides.
  m.box(-w, h0, -0.35, w, h1, 0.35, PAL.islandDark, MAT.lit, 0, PAL.islandRoof, true)
  for (const s of [-1, 1]) {
    const zf = s * 0.38
    const n: V3 = [0, 0, s]
    polyFacing(m, [[-w + 0.35, h0 + 0.35, zf], [w - 0.35, h0 + 0.35, zf], [w - 0.35, h1 - 0.35, zf], [-w + 0.35, h1 - 0.35, zf]], n, PAL.radar)
    for (let i = 1; i < 6; i++) {
      const x = -w + 0.35 + (i * (2 * w - 0.7)) / 6
      polyFacing(m, [[x - 0.07, h0 + 0.35, zf * 1.05], [x + 0.07, h0 + 0.35, zf * 1.05], [x + 0.07, h1 - 0.35, zf * 1.05], [x - 0.07, h1 - 0.35, zf * 1.05]], n, PAL.radarGrid)
    }
    for (let j = 1; j < 4; j++) {
      const yy = h0 + 0.35 + (j * (h1 - h0 - 0.7)) / 4
      polyFacing(m, [[-w + 0.35, yy - 0.07, zf * 1.08], [w - 0.35, yy - 0.07, zf * 1.08], [w - 0.35, yy + 0.07, zf * 1.08], [-w + 0.35, yy + 0.07, zf * 1.08]], n, PAL.radarGrid)
    }
  }
  beam(m, [0.8, h1, 0], [0.8, h1 + 2.2, 0], 0.18, PAL.mast)
  pitchAbout(m, from, 0.26, h0, 0)
}

// ---------------------------------------------------------------------------------------------------------------------

export type CarrierVehicle = { kind: VehicleKind; mesh: Mesh; x: number; z: number; yaw: number }
export type Carrier = {
  /** Hull, deck, markings, sponsons, elevator and island, ship-local. */
  hull: Mesh
  /** Rectangular radar array in its own frame; draw it rotated about +Y and translated to `radarPivot`. */
  radar: Mesh
  radarPivot: [number, number, number]
  /** Always empty: the deck is populated by the game at runtime (see `PARKING` and `buildVehicle`). Kept so viewers
   *  that draw vehicles keep working. */
  vehicles: CarrierVehicle[]
  triangles: number
}

const vehicleCache = new Map<VehicleKind, Mesh>()

/** A deck vehicle or crew member in its own frame (ground at y = 0, nose +Z), for spawning at a `PARKING` spot. */
export function buildVehicle(kind: VehicleKind): Mesh {
  const hit = vehicleCache.get(kind)
  if (hit) return hit
  const m = new Mesh()
  if (kind === "jet") buildJet(m)
  else if (kind === "helicopter") buildHelicopter(m)
  else if (kind === "tractor") buildTractor(m)
  else if (kind === "cart") buildCart(m)
  else buildCrew(m, VEST[kind])
  vehicleCache.set(kind, m)
  return m
}

export function buildCarrier(): Carrier {
  const hull = new Mesh()
  buildHull(hull)
  buildDeck(hull)
  buildSponsons(hull)
  buildWeaponSponsons(hull)
  buildElevator(hull)
  buildMarkings(hull)
  buildIsland(hull)
  const radar = new Mesh()
  buildRadar(radar)
  // The deck ships empty: the game spawns aircraft, vehicles and crew at the spec's PARKING spots (use buildVehicle).
  const vehicles: CarrierVehicle[] = []
  const triangles = (hull.count + radar.count) / 3
  return { hull, radar, radarPivot: RADAR_PIVOT, vehicles, triangles }
}
