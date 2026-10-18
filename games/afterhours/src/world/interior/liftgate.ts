import * as THREE from "three/webgpu"
import { Builder, FLOOR_Y, M, T, paint } from "./kit"
import { type DoorState, openable } from "./plan"
import { registerDoor } from "./registry"

// Collapsible scissor gate (freight lifts, cages) as a real door: one sliding leaf in the shared door system, KeyE,
// its collider following the leaf. The lattice folds against the stacking jamb as the leaf slides (onMove), so the
// stack stays at the jamb while the leading edge travels. Static parts (head track, floor track, stack jamb post) go
// in the builder's batch.

export type LiftGateSpec = {
  /** "x": gate runs along x at z = at; "z": along z at x = at. */
  axis: "x" | "z"
  at: number
  from: number
  to: number
  /** Which end the gate folds to (default "to"). */
  stack?: "from" | "to"
  height?: number
  id: string
  state: DoorState
  room?: string
  sign?: { number: string; label?: string }
  /** Start open fraction 0..1. */
  open?: number
}

const LATTICE = paint(0x2a2c2b, 0.45, 0.8)
const KEY = paint(0x8a6a2a, 0.3, 0.9)

/** Builds the gate; returns its door id. */
export function liftGate(b: Builder, g: LiftGateSpec): string {
  const h = g.height ?? 2.3
  const y = FLOOR_Y
  const a0 = Math.min(g.from, g.to)
  const a1 = Math.max(g.from, g.to)
  const w = a1 - a0
  const toEnd = (g.stack ?? "to") === "to" ? g.to >= g.from : g.from > g.to
  // Leaf frame: origin at the leading jamb, local +x towards the stack jamb.
  const lead = toEnd ? a0 : a1
  const dirSign = toEnd ? 1 : -1
  const yaw = g.axis === "x" ? (dirSign > 0 ? 0 : Math.PI) : dirSign > 0 ? -Math.PI / 2 : Math.PI / 2
  const P = (u: number, d = 0): [number, number] => (g.axis === "x" ? [u, g.at + d] : [g.at + d, u])
  // Static tracks and stack post.
  const [t0x, t0z] = P(a0, -0.05)
  const [t1x, t1z] = P(a1, 0.05)
  b.box(M.darkSteel, Math.min(t0x, t1x), y + h - 0.06, Math.min(t0z, t1z), Math.max(t0x, t1x), y + h, Math.max(t0z, t1z))
  const [f0x, f0z] = P(a0, -0.03)
  const [f1x, f1z] = P(a1, 0.03)
  b.box(M.darkSteel, Math.min(f0x, f1x), y, Math.min(f0z, f1z), Math.max(f0x, f1x), y + 0.012, Math.max(f0z, f1z), { cast: false })
  const stackU = toEnd ? a1 : a0
  const [s0x, s0z] = P(stackU - 0.03, -0.03)
  const [s1x, s1z] = P(stackU + 0.03, 0.03)
  b.box(M.darkSteel, Math.min(s0x, s1x), y + 0.012, Math.min(s0z, s1z), Math.max(s0x, s1x), y + h - 0.06, Math.max(s0z, s1z))
  // Leaf: leading stile (with the latch), lattice group scaled by the fold.
  const lb = new Builder(b.ctx, `gate-${g.id}`, 0)
  // Stile 33 mm deep (lattice 24, jamb posts 40) and 5 mm short of the leading jamb line: no face coplanar with a jamb post it closes against.
  lb.box(M.darkSteel, 0.005, 0.012, -0.0165, 0.045, h - 0.06, 0.0165)
  if (!openable(g.state)) lb.rbox(KEY, T(0.06, 1.05, 0.03), 0.06, 0.07, 0.025, 0.008)
  const lat = new Builder(b.ctx, `gate-${g.id}-lattice`, 0)
  const n = Math.max(4, Math.round(w / 0.14))
  const pitch = w / n
  for (let k = 0; k <= n; k++) lat.box(LATTICE, k * pitch - 0.01, 0.03, -0.012, k * pitch + 0.01, h - 0.08, 0.012)
  for (let k = 0; k < n; k++)
    for (let t = 0; t < 3; t++) {
      const y0 = 0.15 + t * 0.7
      const s = k % 2 ? 1 : -1
      lat.rod(LATTICE, [k * pitch, y0, s * 0.016], [(k + 1) * pitch, y0 + 0.6, s * 0.016], 0.006, 4)
      lat.rod(LATTICE, [k * pitch, y0 + 0.6, -s * 0.016], [(k + 1) * pitch, y0, -s * 0.016], 0.006, 4)
    }
  const leaf = new THREE.Group()
  leaf.name = `gate:${g.id}`
  lb.flush(leaf)
  const latticeRoot = new THREE.Group()
  lat.flush(latticeRoot)
  for (const o of [...lb.group.children, ...lat.group.children]) o.matrixAutoUpdate = true
  leaf.add(latticeRoot)
  leaf.rotation.y = yaw
  b.group.add(leaf)
  const [hx, hz] = P(lead)
  const axisV: [number, number, number] = g.axis === "x" ? [dirSign, 0, 0] : [0, 0, dirSign]
  const id = `s${b.storey}:${g.id}`
  b.ctx.doors.add({
    id,
    leaf,
    hinge: [hx, y + b.oy, hz],
    width: w,
    height: h,
    thickness: 0.05,
    openAngle: 0,
    slide: { axis: axisV, distance: w * 0.85 },
    startOpen: g.open ?? 0,
    locked: !openable(g.state),
    sound: "gate",
    onMove: (t) => {
      latticeRoot.scale.x = Math.max(0.12, 1 - 0.85 * Math.min(1, Math.max(0, t)))
    },
  })
  registerDoor({ id, storey: b.storey, state: g.state, room: g.room, x: g.axis === "x" ? (a0 + a1) / 2 : g.at, z: g.axis === "x" ? g.at : (a0 + a1) / 2, sign: g.sign })
  return id
}
