// The Mk VII fast interceptor (art/boat.glb, art/boat-README.md) as game meshes: the static body (hull, wheelhouse,
// glass, mast) and the moving parts in their own frames, drawn at their pivots: the radar bar (spins about +Y), the
// RWS turret (yaw about +Y), its 25 mm gun (elevation about +X, hung off the turret) and the two waterjet nozzles
// (steer about +Y). The BOAT_accent material (sheer stripe, mast cap) is tagged ACCENT and takes each boat's team
// colour in boat-pass.ts. Model space is the file's: +Y up, +Z bow, +X port, origin on the waterline amidships.

import boatUrl from "../../art/boat.glb?url"
import { type Glb, parseGlb } from "../dev/glb"
import { MAT, Mesh, type Rgb } from "./mesh"

/** Material id of team-accent faces (boat-pass.ts colours them per boat). */
export const BOAT_ACCENT = 3

type V3 = [number, number, number]

export type BoatPiece = { verts: number[]; pivot: V3 }

export type BoatModel = {
  /** Hull, wheelhouse, glass and mast, in model space. */
  body: number[]
  radar: BoatPiece
  turret: BoatPiece
  /** The gun in its own frame; `pivot` is its trunnion relative to the turret's pivot. */
  gun: BoatPiece
  jetL: BoatPiece
  jetR: BoatPiece
}

const srgb = (c: readonly number[]): Rgb => [c[0]! ** (1 / 2.2), c[1]! ** (1 / 2.2), c[2]! ** (1 / 2.2)]
const WHITE: Rgb = [1, 1, 1]

function transform(m: Float64Array, x: number, y: number, z: number): V3 {
  return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!]
}

/** Adds a node's triangles through `m` (null: node-local), flipping faces whose winding disagrees with the file's
 *  normals, glass shiny, accent faces tagged. */
function addNode(mesh: Mesh, node: Glb["nodes"][number], m: Float64Array | null): void {
  for (const prim of node.prims) {
    const accent = prim.material === "BOAT_accent"
    const col = accent ? WHITE : srgb(prim.color)
    const shiny = /glass/i.test(prim.material) ? 1 : /jet/i.test(prim.material) ? 0.4 : 0
    const P = prim.positions
    const Nn = prim.normals
    for (let i = 0; i + 9 <= P.length; i += 9) {
      const pt = (k: number): V3 => (m ? transform(m, P[i + k]!, P[i + k + 1]!, P[i + k + 2]!) : [P[i + k]!, P[i + k + 1]!, P[i + k + 2]!])
      const a = pt(0)
      let b = pt(3)
      let c = pt(6)
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
      const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
      let n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!]
      const len = Math.hypot(n[0]!, n[1]!, n[2]!)
      if (len < 1e-12) continue
      n = [n[0]! / len, n[1]! / len, n[2]! / len]
      if (Nn) {
        const fx = Nn[i]! + Nn[i + 3]! + Nn[i + 6]!
        const fy = Nn[i + 1]! + Nn[i + 4]! + Nn[i + 7]!
        const fz = Nn[i + 2]! + Nn[i + 5]! + Nn[i + 8]!
        const wn = m ? [m[0]! * fx + m[4]! * fy + m[8]! * fz, m[1]! * fx + m[5]! * fy + m[9]! * fz, m[2]! * fx + m[6]! * fy + m[10]! * fz] : [fx, fy, fz]
        if (n[0]! * wn[0]! + n[1]! * wn[1]! + n[2]! * wn[2]! < 0) {
          ;[b, c] = [c, b]
          n = [-n[0]!, -n[1]!, -n[2]!]
        }
      }
      for (const p of [a, b, c]) mesh.vert(p, n, col, (accent ? BOAT_ACCENT : MAT.lit) as 0, accent ? 0.3 : shiny)
    }
  }
}

const pivotOf = (node: Glb["nodes"][number]): V3 => [node.world[12]!, node.world[13]!, node.world[14]!]
const localOf = (node: Glb["nodes"][number]): V3 => [node.local[12]!, node.local[13]!, node.local[14]!]

export function buildBoatModel(glb: Glb): BoatModel {
  const body = new Mesh()
  const parts: Record<string, { mesh: Mesh; pivot: V3 }> = {}
  const own = (name: string, node: Glb["nodes"][number], pivot: V3) => {
    const mesh = new Mesh()
    addNode(mesh, node, null)
    parts[name] = { mesh, pivot }
  }
  for (const node of glb.nodes) {
    if (node.name === "BOAT_radar") own("radar", node, pivotOf(node))
    else if (node.name === "BOAT_turret") own("turret", node, pivotOf(node))
    else if (node.name === "BOAT_turret_gun") own("gun", node, localOf(node))
    else if (node.name === "BOAT_waterjet_L") own("jetL", node, pivotOf(node))
    else if (node.name === "BOAT_waterjet_R") own("jetR", node, pivotOf(node))
    else addNode(body, node, node.world)
  }
  const piece = (name: string, pivot: V3): BoatPiece => ({ verts: parts[name]?.mesh.v ?? [], pivot: parts[name]?.pivot ?? pivot })
  return {
    body: body.v,
    radar: piece("radar", [0, 4.5, -0.94]),
    turret: piece("turret", [0, 2.3, 4.97]),
    gun: piece("gun", [0, 0.18, 0.3]),
    jetL: piece("jetL", [1.21, 0.75, -8.35]),
    jetR: piece("jetR", [-1.21, 0.75, -8.35]),
  }
}

export async function loadBoatModel(): Promise<BoatModel> {
  const r = await fetch(boatUrl)
  if (!r.ok) throw new Error(`boat model: HTTP ${r.status}`)
  return buildBoatModel(parseGlb(await r.arrayBuffer()))
}
