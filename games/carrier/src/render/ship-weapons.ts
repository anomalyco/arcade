// The carrier's weapons (concept/weapons-*.png): two Phalanx-style CIWS (white dome, gatling), two 8-cell Sea Sparrow
// box launchers and a Mk 45-style 5-inch gun, on the deck-edge sponsons of `WEAPON_MOUNTS` (shared/carrier-spec.ts;
// carrier-mesh.ts builds the sponsons). Each weapon is three meshes so gameplay can aim it:
// - `mount`: the fixed pedestal, ship-local.
// - `turret`: trains about +Y; its own frame has the origin on the yaw axis at `yawPivot` (ship-local), bore along +Z.
// - `barrel`: elevates about +X; its own frame has the origin at `pitchPivot`, given in the TURRET's frame, bore +Z.
// Ship-local placement of a turret point p: yawPivot + rotY(yaw) p; of a barrel point q:
// yawPivot + rotY(yaw) (pitchPivot + rotX(−pitch) q), with rotY(a) taking +Z to (sin a, 0, cos a) (see `poseWeapon`).
import { WEAPON_MOUNTS, type WeaponKind, type WeaponMount } from "../../shared/carrier-spec"
import { hex, loft, polyFacing, type V3 } from "./deck-vehicles"
import { FLOATS_PER_VERT, Mesh, type Rgb } from "./mesh"

export const WPAL = {
  grey: hex(0x7c838e),
  greyLight: hex(0x9ba2ac),
  greyDark: hex(0x5b616b),
  white: hex(0xe9ebee),
  whiteShade: hex(0xcfd3d8),
  barrel: hex(0x2a2e34),
  barrelMid: hex(0x434851),
  slot: hex(0x1b1e23),
} as const

export type ShipWeapon = {
  kind: WeaponKind
  side: "port" | "starboard"
  /** Fixed pedestal, ship-local. */
  mount: Mesh
  /** Trains about +Y; turret frame (origin at `yawPivot`). */
  turret: Mesh
  /** Elevates about +X; barrel frame (origin at `pitchPivot`). */
  barrel: Mesh
  /** Mount base on the sponson, ship-local. */
  pos: [number, number, number]
  /** Turret origin, ship-local. */
  yawPivot: [number, number, number]
  /** Barrel origin in the turret frame. */
  pitchPivot: [number, number, number]
  restYaw: number
  restPitch: number
  /** Index into `WEAPON_MOUNTS`. */
  index: number
}

/** Closed ring of `sides` points round the Y axis at height y (x, z radius), starting at `phase`. */
const ringY = (r: number, y: number, sides: number, phase = 0, rz = r, z = 0): V3[] =>
  Array.from({ length: sides }, (_, i) => {
    const a = phase + (i / sides) * Math.PI * 2
    return [Math.cos(a) * r, y, z + Math.sin(a) * rz]
  })

/** Closed ring round the Z axis at depth z. */
const ringZ = (r: number, z: number, sides: number, phase = Math.PI / sides, x = 0, y = 0): V3[] =>
  Array.from({ length: sides }, (_, i) => {
    const a = phase + (i / sides) * Math.PI * 2
    return [x + Math.cos(a) * r, y + Math.sin(a) * r, z]
  })

/** Capped tube along +Z. */
function tube(m: Mesh, z0: number, z1: number, r0: number, r1: number, sides: number, col: Rgb, x = 0, y = 0): void {
  loft(m, [ringZ(r0, z0, sides, Math.PI / sides, x, y), ringZ(r1, z1, sides, Math.PI / sides, x, y)], col)
}

/** Upright cylinder with its own top colour. */
function drum(m: Mesh, r0: number, r1: number, y0: number, y1: number, sides: number, side: Rgb, top: Rgb = side): void {
  loft(m, [ringY(r0, y0, sides, Math.PI / sides), ringY(r1, y1, sides, Math.PI / sides)], side, [false, false])
  polyFacing(m, ringY(r1, y1, sides, Math.PI / sides), [0, 1, 0], top)
}

// ---------------------------------------------------------------------------------------------------------------------
// CIWS: square pedestal, base ring, white cylinder with a rounded dome, a dark electronics box on its side and the
// gatling hanging off a bracket at the front of the drum.

const CIWS = { pedestal: 1.4, ring: 2.0, pivot: [0, 1.75, 1.45] as V3 }

function ciwsMount(m: Mesh): void {
  m.bevelBox(-3, 0, -3, 3, CIWS.pedestal, 3, 0.3, WPAL.grey, WPAL.greyLight)
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) m.box(sx * 2.15 - 0.4, CIWS.pedestal, sz * 2.15 - 0.4, sx * 2.15 + 0.4, CIWS.pedestal + 0.45, sz * 2.15 + 0.4, WPAL.greyDark, undefined, 0, WPAL.grey)
  drum(m, 2.3, 2.1, CIWS.pedestal, CIWS.ring, 12, WPAL.greyDark, WPAL.grey)
}

function ciwsTurret(m: Mesh): void {
  drum(m, 2.0, 1.9, 0, 0.7, 12, WPAL.grey, WPAL.greyLight)
  // White drum and dome (a capsule top).
  const s = 10
  const ph = Math.PI / s
  loft(
    m,
    [ringY(1.75, 0.7, s, ph), ringY(1.75, 5.3, s, ph), ringY(1.6, 6.2, s, ph), ringY(1.2, 6.85, s, ph), ringY(0.5, 7.2, s, ph)],
    (i) => (i === 0 ? WPAL.white : WPAL.whiteShade),
    [false, true],
  )
  // Electronics cabinet on the side.
  m.bevelBox(1.55, 2.4, -0.9, 2.55, 4.6, 0.9, 0.15, WPAL.greyDark, WPAL.grey)
  // Gun cradle: two cheek plates either side of the gatling, tied into the drum.
  for (const sx of [-1, 1]) {
    const x0 = sx > 0 ? 0.62 : -0.98
    const x1 = x0 + 0.36
    loft(
      m,
      [
        [
          [x0, 0.7, 0.6],
          [x0, 0.7, 2.1],
          [x0, 2.5, 1.9],
          [x0, 3.1, 0.6],
        ],
        [
          [x1, 0.7, 0.6],
          [x1, 0.7, 2.1],
          [x1, 2.5, 1.9],
          [x1, 3.1, 0.6],
        ],
      ],
      WPAL.grey,
    )
  }
}

function ciwsBarrel(m: Mesh): void {
  tube(m, -0.7, 0.9, 0.62, 0.62, 8, WPAL.barrelMid)
  tube(m, 0.9, 1.2, 0.62, 0.5, 8, WPAL.barrelMid)
  // Six barrels round a spindle, with a clamp near the muzzle.
  tube(m, 1.2, 4.9, 0.12, 0.12, 6, WPAL.barrel)
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2
    tube(m, 1.2, 5.0, 0.1, 0.1, 4, WPAL.barrel, Math.cos(a) * 0.3, Math.sin(a) * 0.3)
  }
  tube(m, 4.1, 4.45, 0.48, 0.48, 8, WPAL.barrelMid)
}

// ---------------------------------------------------------------------------------------------------------------------
// SAM launcher (Mk 29 style): flanged pedestal, a U yoke, and two 4-cell boxes side by side with 8 square cell doors.

const SAM = { pedestal: 1.8, pivot: [0, 3.2, 0] as V3 }

function samMount(m: Mesh): void {
  drum(m, 2.7, 2.6, 0, 0.4, 12, WPAL.greyDark, WPAL.grey)
  drum(m, 2.0, 1.8, 0.4, SAM.pedestal, 12, WPAL.grey, WPAL.greyLight)
}

function samTurret(m: Mesh): void {
  drum(m, 2.1, 2.0, 0, 0.5, 12, WPAL.greyDark, WPAL.grey)
  m.bevelBox(-3.5, 0.5, -1.3, 3.5, 1.1, 1.3, 0.2, WPAL.grey, WPAL.greyLight)
  for (const sx of [-1, 1]) {
    const [x0, x1] = sx > 0 ? [2.9, 3.5] : [-3.5, -2.9]
    m.bevelBox(x0, 1.1, -1.1, x1, SAM.pivot[1] + 1.1, 1.1, 0.2, WPAL.grey, WPAL.greyLight)
    // Trunnion boss.
    const xo = sx > 0 ? x1 : x0
    loft(m, [ringZ(0.75, 0, 6).map(([a, b]): V3 => [xo, SAM.pivot[1] + a, b]), ringZ(0.6, 0, 6).map(([a, b]): V3 => [xo + sx * 0.35, SAM.pivot[1] + a, b])], WPAL.greyDark)
  }
}

function samBarrel(m: Mesh): void {
  const h = 1.55
  const z0 = -3.4
  const z1 = 3.1
  for (const [x0, x1] of [
    [-2.85, -0.06],
    [0.06, 2.85],
  ] as const) {
    m.box(x0, -h, z0, x1, h, z1, WPAL.grey, undefined, 0, WPAL.greyLight, true)
    polyFacing(m, [[x0 + 0.08, -h + 0.08, z1 + 0.02], [x1 - 0.08, -h + 0.08, z1 + 0.02], [x1 - 0.08, h - 0.08, z1 + 0.02], [x0 + 0.08, h - 0.08, z1 + 0.02]], [0, 0, 1], WPAL.slot)
    // Rear lid.
    polyFacing(m, [[x0 + 0.3, -h + 0.3, z0 - 0.02], [x1 - 0.3, -h + 0.3, z0 - 0.02], [x1 - 0.3, h - 0.3, z0 - 0.02], [x0 + 0.3, h - 0.3, z0 - 0.02]], [0, 0, -1], WPAL.greyDark)
    // Four cell doors, raised.
    const w = (x1 - x0 - 0.36) / 2
    for (const c of [0, 1])
      for (const r of [0, 1]) {
        const cx = x0 + 0.12 + c * (w + 0.12)
        const cy = -h + 0.12 + r * (h - 0.06)
        m.box(cx, cy, z1, cx + w, cy + h - 0.18, z1 + 0.16, WPAL.greyLight, undefined, 0, WPAL.greyLight)
      }
  }
  // Seam band round the middle of the boxes.
  m.box(-2.95, -h - 0.06, -0.3, 2.95, h + 0.06, 0.3, WPAL.greyDark, undefined, 0, WPAL.grey, true)
}

// ---------------------------------------------------------------------------------------------------------------------
// 5-inch gun (Mk 45 style): a faceted angular shell on a base ring, a dark slot down its sloped front and one long barrel.

const GUN_S = 1.2
const GUN = { ring: 0.7, pivot: [0, 1.5 * GUN_S, 3.6 * GUN_S] as V3 }

function gunMount(m: Mesh): void {
  drum(m, 3.6, 3.4, 0, GUN.ring, 14, WPAL.greyDark, WPAL.grey)
}

/** Shell rings (x, z in plan, 8 points round from the back-left), scaled by GUN_S. */
const SHELL: { y: number; pts: [number, number][] }[] = [
  { y: 0, pts: [[-2.5, -4.0], [2.5, -4.0], [3.0, -2.0], [3.0, 1.8], [1.7, 4.2], [-1.7, 4.2], [-3.0, 1.8], [-3.0, -2.0]] },
  { y: 1.4, pts: [[-2.7, -4.2], [2.7, -4.2], [3.3, -1.9], [3.3, 1.8], [1.8, 4.3], [-1.8, 4.3], [-3.3, 1.8], [-3.3, -1.9]] },
  { y: 2.7, pts: [[-2.3, -4.0], [2.3, -4.0], [2.8, -1.7], [2.7, 0.8], [1.4, 2.2], [-1.4, 2.2], [-2.7, 0.8], [-2.8, -1.7]] },
  { y: 3.3, pts: [[-1.6, -3.5], [1.6, -3.5], [2.0, -1.6], [1.9, 0.1], [0.9, 0.9], [-0.9, 0.9], [-1.9, 0.1], [-2.0, -1.6]] },
]

function gunTurret(m: Mesh): void {
  const rings = SHELL.map((r) => r.pts.map(([x, z]): V3 => [x * GUN_S, r.y * GUN_S, z * GUN_S]))
  loft(m, rings, (i, j) => (j === 4 || j === 0 ? (i === 1 ? WPAL.grey : WPAL.greyLight) : i === 2 ? WPAL.greyLight : WPAL.grey), [false, true])
  // Dark slot up the front face round the barrel (between rings 1 and 2: the plane through their front edges).
  const [a, b] = [SHELL[1]!, SHELL[2]!]
  const zAt = (y: number) => (a.pts[4]![1] + ((b.pts[4]![1] - a.pts[4]![1]) * (y - a.y)) / (b.y - a.y)) * GUN_S + 0.05
  const n: V3 = [0, (a.pts[4]![1] - b.pts[4]![1]) / (b.y - a.y), 1]
  polyFacing(m, [[-0.5, 1.45 * GUN_S, zAt(1.45)], [0.5, 1.45 * GUN_S, zAt(1.45)], [0.5, 2.5 * GUN_S, zAt(2.5)], [-0.5, 2.5 * GUN_S, zAt(2.5)]], n, WPAL.slot)
  // A sighting hood on the roof.
  m.bevelBox(-1.4 * GUN_S, 3.3 * GUN_S, -2.8 * GUN_S, -0.4 * GUN_S, 3.65 * GUN_S, -1.8 * GUN_S, 0.12, WPAL.greyDark, WPAL.grey)
}

function gunBarrel(m: Mesh): void {
  tube(m, -0.6, 1.3, 0.55, 0.5, 8, WPAL.barrelMid)
  tube(m, 1.3, 10.6, 0.3, 0.26, 8, WPAL.barrel)
  tube(m, 10.0, 10.7, 0.34, 0.34, 8, WPAL.barrel)
}

// ---------------------------------------------------------------------------------------------------------------------

const PARTS: Record<WeaponKind, { mount(m: Mesh): void; turret(m: Mesh): void; barrel(m: Mesh): void; yawY: number; pivot: V3 }> = {
  ciws: { mount: ciwsMount, turret: ciwsTurret, barrel: ciwsBarrel, yawY: CIWS.ring, pivot: CIWS.pivot },
  sam: { mount: samMount, turret: samTurret, barrel: samBarrel, yawY: SAM.pedestal, pivot: SAM.pivot },
  gun: { mount: gunMount, turret: gunTurret, barrel: gunBarrel, yawY: GUN.ring, pivot: GUN.pivot },
}

/** The weapons are drawn ~1.5x life size (a Phalanx is ~4.7 m tall) so they read from the chase camera, as in the
 *  concepts. Pieces are authored life-size and scaled here. */
export const WEAPON_SCALE = 1.5

/** Scales positions by `WEAPON_SCALE` (uniform, so normals stay), then translates. */
function place(m: Mesh, t: readonly number[] = [0, 0, 0]): Mesh {
  for (let i = 0; i < m.v.length; i += FLOATS_PER_VERT) {
    m.v[i] = m.v[i]! * WEAPON_SCALE + t[0]!
    m.v[i + 1] = m.v[i + 1]! * WEAPON_SCALE + t[1]!
    m.v[i + 2] = m.v[i + 2]! * WEAPON_SCALE + t[2]!
  }
  return m
}

function buildWeapon(w: WeaponMount, index: number): ShipWeapon {
  const p = PARTS[w.kind]
  const mount = new Mesh()
  p.mount(mount)
  place(mount, w.pos)
  const turret = new Mesh()
  p.turret(turret)
  place(turret)
  const barrel = new Mesh()
  p.barrel(barrel)
  place(barrel)
  return {
    kind: w.kind,
    side: w.side,
    mount,
    turret,
    barrel,
    pos: [w.pos[0], w.pos[1], w.pos[2]],
    yawPivot: [w.pos[0], w.pos[1] + p.yawY * WEAPON_SCALE, w.pos[2]],
    pitchPivot: [p.pivot[0] * WEAPON_SCALE, p.pivot[1] * WEAPON_SCALE, p.pivot[2] * WEAPON_SCALE],
    restYaw: w.restYaw,
    restPitch: w.restPitch,
    index,
  }
}

let cache: ShipWeapon[] | null = null

/** Every weapon of `WEAPON_MOUNTS`, in that order (built once; treat the meshes as read-only). */
export function buildShipWeapons(): ShipWeapon[] {
  cache ??= WEAPON_MOUNTS.map(buildWeapon)
  return cache
}

/** Appends a mesh's vertices to `out`, pitched (about +X, positive = bore up), yawed (about +Y) and translated. */
function appendPosed(out: number[], v: readonly number[], yaw: number, pitch: number, pre: readonly number[], post: readonly number[]): void {
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  const F = FLOATS_PER_VERT
  for (let i = 0; i < v.length; i += F) {
    const rot = (x: number, y: number, z: number, t: number): V3 => {
      // Pitch: +Z toward +Y. Then yaw: +Z toward (sin, 0, cos).
      const y1 = y * cp + z * sp
      const z1 = -y * sp + z * cp
      const xa = x + pre[0]! * t
      const ya = y1 + pre[1]! * t
      const za = z1 + pre[2]! * t
      return [xa * cy + za * sy + post[0]! * t, ya + post[1]! * t, -xa * sy + za * cy + post[2]! * t]
    }
    const p = rot(v[i]!, v[i + 1]!, v[i + 2]!, 1)
    const n = rot(v[i + 3]!, v[i + 4]!, v[i + 5]!, 0)
    out.push(p[0], p[1], p[2], n[0], n[1], n[2])
    for (let k = 6; k < F; k++) out.push(v[i + k]!)
  }
}

/** One weapon's turret and barrel at (yaw, pitch), ship-local vertices. */
export function poseWeapon(w: ShipWeapon, yaw: number, pitch: number, out: number[] = []): number[] {
  appendPosed(out, w.turret.v, yaw, 0, [0, 0, 0], w.yawPivot)
  appendPosed(out, w.barrel.v, yaw, pitch, w.pitchPivot, w.yawPivot)
  return out
}

/** Every weapon (mount, turret, barrel) in its rest pose as one ship-local vertex list, for drawing with the hull. */
export function shipWeaponsRestVerts(): number[] {
  const out: number[] = []
  for (const w of buildShipWeapons()) {
    out.push(...w.mount.v)
    poseWeapon(w, w.restYaw, w.restPitch, out)
  }
  return out
}

export const shipWeaponsTriangles = (): number => shipWeaponsRestVerts().length / FLOATS_PER_VERT / 3
