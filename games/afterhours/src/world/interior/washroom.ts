import * as THREE from "three/webgpu"
import { atan, float, smoothstep, uv } from "three/tsl"
import { MODELS, type MergePlacement, type ModelName, mergeModels, modelColliders, yawToward } from "../../render/models"
import { decalBias, materialFor } from "../../render/materials"
import { createMirror } from "../../render/mirrors"
import { Builder, CEIL_Y, FLOOR_Y, LAYER, M, T, paint } from "./kit"
import type { Rect } from "./plan"
import { room } from "./room"
import { WET_BANDS } from "./styles"

// Commercial washrooms (docs/washroom-fixtures.md): library fixtures (toilet, urinal, lavatory, tp holder, towel
// dispenser, hand dryer, waste basket) baked with one mergeModels per washroom, kit-built overhead-braced steel stall
// partitions, nickel-bronze floor drain with its wet patch, stainless-framed plate mirror with a live reflection
// (render/mirrors.ts) and a glass-globe soap dispenser.
//
// Everything the mirror should reflect (room shell linings, floor, ceiling, fixtures, stalls) is built into a
// washroom builder whose meshes also carry WASHROOM_LAYER, so the reflection can be limited to the washroom (the
// mirror camera rendering only that layer halves its cost; see the note on WASHROOM_LAYER).

/**
 * Layer the washroom contents carry in addition to layer 0 (4 = player head, 5 = player/body.ts SPARE_LAYER). A mirror camera that renders `(1 << WASHROOM_LAYER) | (1 << HEAD_LAYER)` sees the room and
 * the player only.
 */
export const WASHROOM_LAYER = 6

export type WashroomOpts = {
  id: string
  name: string
  rect: Rect
  kind: "M" | "W"
  /** Stalls along the back (+z) wall; the first is the accessible one (0.91 m door). */
  stalls?: number
  /** Basins along the west wall from z0 + 0.65. */
  basins?: number
  /** Urinals along the east wall (men's rooms). */
  urinals?: number
  /** "OUT OF ORDER" tape across the stalls (storey 4). */
  refurb?: boolean
  /** Optional lit fitting (default none: dark at 3 a.m.). */
  lit?: boolean
  /** Spine door: centre x and id (its frame and leaf join the reflection layer). */
  door?: { x: number; id: string; width?: number }
}

const ENAMEL = { M: paint(0xa7a397, 0.35, 0.2), W: paint(0xcbbf9f, 0.35, 0.2) }
const CHROME = paint(0xc8ccce, 0.15, 1)
const BRONZE = paint(0x9a8a6a, 0.3, 0.9)
const SEAM = paint(0x59574f, 0.5, 0.2)
const LIQUID = materialFor("flat", { color: 0xd8a0a8, roughness: 0.2, transparent: 0.75, name: "interior_soap" })

/** Dark grout/rust ring and glossy wet patch round the drain (soft-edged decals, shared materials). */
const decal = (color: number, roughness: number, alpha: number, edge: number, name: string) => {
  const m = new THREE.MeshStandardNodeMaterial({ color, roughness, transparent: true, depthWrite: false })
  const p = uv().sub(0.5).mul(2)
  const a = atan(p.y, p.x)
  const d = p.length().div(a.mul(3).sin().mul(0.1).add(0.88))
  m.opacityNode = float(1).sub(smoothstep(edge, 1, d)).mul(alpha)
  decalBias(m, 3) // pulls the decal toward the camera whatever the depth convention (reversed-Z)
  m.name = `interior_${name}`
  return m
}
const WET = decal(0x222624, 0.12, 0.55, 0.3, "wet_patch")
const RING = decal(0x2a2014, 0.9, 0.8, 0.75, "drain_ring")

export function washroom(b: Builder, o: WashroomOpts) {
  const r = o.rect
  const y = FLOOR_Y
  const wb = new Builder(b.ctx, `wc-${o.id}`, b.storey)
  room(wb, { id: o.id, name: o.name, rect: r, floor: "terrazzo", lit: o.lit ? "all" : "none", windows: false, columns: false, troffers: { dx: 9, dz: 3.6 } })
  // Room-face tile linings (12 mm, back faces dropped) so the reflection layer has its own walls.
  const T12 = 0.012
  linings(wb, r, T12, o.door)
  // The door: its leaf (built later by the spine) joins the reflect layer when it is added; a reflect-only copy of the
  // frame (the real one is in the storey batch, which the mirror doesn't render).
  if (o.door) {
    const leafId = `s${b.storey}:${o.door.id}`
    const tag = (e: unknown) => {
      const c = (e as { child: THREE.Object3D }).child
      if (c.name === leafId || c.name === `${leafId}:b`) c.traverse((m) => m.layers.enable(WASHROOM_LAYER))
    }
    b.group.addEventListener("childadded", tag)
    const rb = new Builder(b.ctx, `wc-${o.id}-reflect`, b.storey)
    const w = o.door.width ?? 0.92
    const x = o.door.x
    const z = r.z0 - 0.075
    rb.box(M.frame, x - w / 2 - 0.05, FLOOR_Y, z - 0.095, x - w / 2, FLOOR_Y + 2.12, z + 0.095)
    rb.box(M.frame, x + w / 2, FLOOR_Y, z - 0.095, x + w / 2 + 0.05, FLOOR_Y + 2.12, z + 0.095)
    rb.box(M.frame, x - w / 2 - 0.05, FLOOR_Y + 2.12, z - 0.095, x + w / 2 + 0.05, FLOOR_Y + 2.17, z + 0.095)
    // The spine corridor seen through an open door: a dark backdrop at the far side of the opening.
    // Reflect-only stand-in for the corridor seen through the open door: floor, far wall and ceiling, wide enough for
    // any angle the mirror can see through the opening.
    const zc = r.z0 - 0.15
    rb.box("linoleum", x - 4, FLOOR_Y - 0.01, zc - 3.3, x + 4, FLOOR_Y, zc, { skip: "y" })
    rb.box(M.felt, x - 4, FLOOR_Y, zc - 3.3, x + 4, CEIL_Y, zc - 3.25)
    rb.box("ceiling_tile", x - 4, CEIL_Y, zc - 3.3, x + 4, CEIL_Y + 0.02, zc, { skip: "Y" })
    rb.flush(b.group)
    rb.group.traverse((m) => (m.layers.mask = 1 << WASHROOM_LAYER))
  }
  const placements: MergePlacement[] = []
  const put = (name: ModelName, x: number, py: number, z: number, yaw: number) => placements.push({ name, position: [x, py + b.oy, z], yaw })
  const ix0 = r.x0 + T12
  const ix1 = r.x1 - T12
  const iz1 = r.z1 - T12
  // ---- stalls along the back wall
  const n = o.stalls ?? (o.kind === "M" ? 2 : 3)
  const depth = 1.55
  const front = iz1 - depth
  const sw = (ix1 - ix0) / n
  const doorW = (k: number) => (k === 0 ? Math.min(0.91, sw - 0.24) : Math.min(0.61, sw - 0.2))
  const doors: [number, number][] = []
  for (let k = 0; k < n; k++) {
    const c = ix0 + sw * (k + 0.5)
    const w = doorW(k)
    doors.push([c - w / 2, c + w / 2])
  }
  const enamel = ENAMEL[o.kind]
  // Pilasters fill the front line between the doors (6 mm gaps), each with a stainless shoe.
  const pil: [number, number][] = []
  let cur = ix0
  for (const [d0, d1] of doors) {
    pil.push([cur, d0 - 0.006])
    cur = d1 + 0.006
  }
  pil.push([cur, ix1])
  const PT = 0.032
  for (const [p0, p1] of pil) {
    if (p1 - p0 < 0.02) continue
    wb.rbox(enamel, T((p0 + p1) / 2, y, front), p1 - p0, 1.88, PT, 0.006, 0, 0.94, 0)
    wb.box(CHROME, p0 - 0.004, y, front - PT / 2 - 0.004, p1 + 0.004, y + 0.1, front + PT / 2 + 0.004)
    for (const sx of [p0 + 0.02, p1 - 0.02]) wb.cyl(CHROME, T(sx, y + 0.05, front - PT / 2 - 0.005, 0, Math.PI / 2), 0.005, 0.005, 0.004, 8, { cast: false })
    wb.collide(p0, y, front - PT / 2, p1, y + 1.88, front + PT / 2)
  }
  // Headrail across the pilaster tops, flanged into the side walls.
  wb.rbox(CHROME, T((ix0 + ix1) / 2, y + 1.88 + 0.019, front), ix1 - ix0, 0.038, 0.025, 0.008)
  for (const x of [ix0, ix1]) wb.rbox(CHROME, T(x + (x === ix0 ? 0.004 : -0.004), y + 1.9, front), 0.008, 0.07, 0.07, 0.002)
  // Panels between stalls (bottom 0.30, top 1.77, 0.08 short of the back wall), seams, U-brackets.
  const PW = 0.025
  for (let k = 1; k < n; k++) {
    const x = ix0 + sw * k
    const z0 = front + PT / 2
    const z1 = iz1 - 0.08
    wb.rbox(enamel, T(x, y + 0.3, (z0 + z1) / 2), PW, 1.47, z1 - z0, 0.006, 0, 0.735, 0)
    for (const s of [-1, 1]) {
      const fx = x + s * (PW / 2 + 0.0015)
      wb.box(SEAM, fx - 0.0015, y + 0.312, z0 + 0.012, fx + 0.0015, y + 0.315, z1 - 0.012, { cast: false })
      wb.box(SEAM, fx - 0.0015, y + 1.755, z0 + 0.012, fx + 0.0015, y + 1.758, z1 - 0.012, { cast: false })
      for (const by of [0.45, 1.6]) {
        wb.box(CHROME, x - 0.03, y + by, z0, x + 0.03, y + by + 0.05, z0 + 0.03)
        wb.box(CHROME, x - 0.03, y + by, iz1 - 0.08, x + 0.03, y + by + 0.05, iz1)
      }
    }
    wb.collide(x - PW / 2, y + 0.3, z0, x + PW / 2, y + 1.77, z1)
    // Gap at the floor is open (0.30): no collider below, so the player's feet can't squeeze through anyway.
    wb.collide(x - PW / 2, y, z0, x + PW / 2, y + 0.3, z1)
  }
  // Doors: inward-swinging static leaves (one wide open, one ajar, the rest shut), gravity hinges, latch, hook.
  const opens = o.kind === "M" ? [1.2, 0.4] : [0, 0.45, 1.25]
  doors.forEach(([d0, d1], k) => {
    const a = opens[k] ?? 0
    const w = d1 - d0
    const L = T(d0, y + 0.3, front, -a)
    wb.rbox(enamel, L, w, 1.47, PW, 0.006, w / 2, 0.735, 0)
    for (const hy of [0.05, 1.32]) wb.boxM(CHROME, T(d0, y + 0.3, front), 0.05, 0.15, PT + 0.012, -0.012, hy + 0.075, 0)
    wb.boxM(CHROME, L, 0.09, 0.03, 0.012, w - 0.07, 0.7, PW / 2 + 0.006)
    wb.boxM(a > 0 ? paint(0x2a6a38, 0.4) : M.red, L, 0.04, 0.02, 0.006, w - 0.07, 0.7, -PW / 2 - 0.003, { cast: false })
    wb.boxM(CHROME, L, 0.03, 0.06, 0.04, w / 2, 1.25, PW / 2 + 0.02)
    wb.collideLocal(L, [0, 0, -PW / 2 - 0.01], [w, 1.47, PW / 2 + 0.01])
    // Fixtures inside the stall.
    const cx = ix0 + sw * (k + 0.5)
    put("toilet", cx, y, iz1 - 0.02 - MODELS.toilet.size[2] / 2, 0)
    const side = k === 0 ? ix0 : ix0 + sw * k + PW / 2
    put("tp_holder", side + MODELS.tp_holder.size[2] / 2 + 0.002, y + 0.62, iz1 - 0.65, yawToward(1, 0))
  })
  if (o.refurb) wb.box(M.safety, ix0 + 0.1, y + 1.0, front - PT / 2 - 0.02, ix1 - 0.1, y + 1.06, front - PT / 2 - 0.015, { cast: false })
  // ---- urinals on the east wall, with a modesty screen
  const nu = o.urinals ?? (o.kind === "M" ? 2 : 0)
  for (let k = 0; k < nu; k++) put("urinal", ix1 - MODELS.urinal.size[2] / 2, y, front - 1.0 - k * 0.75, yawToward(-1, 0))
  if (nu > 0) {
    const zs = front - 1.0 - nu * 0.75 + 0.35
    wb.rbox(enamel, T(ix1 - 0.3, y + 0.3, zs), 0.6, 1.2, PW, 0.006, 0, 0.6, 0)
    wb.collide(ix1 - 0.6, y, zs - PW / 2, ix1, y + 1.5, zs + PW / 2)
  }
  // ---- basins, mirror, soap, towels on the west wall
  const nb = o.basins ?? 2
  const bz0 = r.z0 + 0.95
  const bz = Array.from({ length: nb }, (_, k) => bz0 + k * 0.76)
  for (const z of bz) put("lavatory", ix0 + MODELS.lavatory.size[2] / 2, y + 0.49, z, yawToward(1, 0))
  const mz0 = bz[0]! - 0.38
  const mz1 = bz[nb - 1]! + 0.38
  mirror(b, wb, ix0, (mz0 + mz1) / 2, mz1 - mz0)
  const soapZ = mz1 + 0.18
  soap(wb, ix0, soapZ)
  const towelZ = soapZ + 0.42
  put("towel_dispenser", ix0 + MODELS.towel_dispenser.size[2] / 2 + 0.002, y + 1.12, towelZ, yawToward(1, 0))
  put("waste_basket", ix0 + MODELS.waste_basket.size[2] / 2 + 0.04, y, towelZ, 0)
  if (o.kind === "M") put("hand_dryer", ix0 + MODELS.hand_dryer.size[2] / 2 + 0.002, y + 1.0, towelZ + 0.55, yawToward(1, 0))
  // ---- floor drain in front of the basins, wet patch spreading towards it
  const dx = ix0 + 0.95
  const dz = (bz[0]! + bz[nb - 1]!) / 2
  drain(wb, dx, dz)
  // Bake fixtures; colliders now.
  for (const c of modelColliders(placements.filter((p) => p.name === "toilet" || p.name === "urinal" || p.name === "waste_basket"), 0.02)) b.ctx.colliders.push(c)
  for (const p of placements.filter((p) => p.name === "lavatory")) {
    const [w, , d] = MODELS.lavatory.size
    b.ctx.colliders.push({ min: [ix0, p.position[1], p.position[2] - w / 2], max: [ix0 + d, p.position[1] + 0.56, p.position[2] + w / 2] })
  }
  const fixtures = mergeModels(placements)
  fixtures.name = `wc-${o.id}-fixtures`
  // The merged meshes arrive after the models load; tag them as they are added (before the boot warmup's late-arrival
  // hook saves and zeroes their mask, so its restore brings the washroom layer back with layer 0).
  fixtures.addEventListener("childadded", (e) => (e as unknown as { child: THREE.Object3D }).child.traverse((m) => m.layers.enable(WASHROOM_LAYER)))
  b.small.add(fixtures)
  wb.flush(b.group)
  wb.group.traverse((m) => m.layers.enable(WASHROOM_LAYER))
}

/** Wet-tile linings on the room faces of the four walls (12 mm, room face only, door holes not needed: the spine
 *  wall's door opening is left uncovered). */
function linings(wb: Builder, r: Rect, t: number, door?: { x: number; width?: number }) {
  const y0 = FLOOR_Y - 0.005
  for (const [y0r, y1r, mat] of WET_BANDS) {
    const ya = Math.max(y0, FLOOR_Y + y0r)
    const yb = Math.min(CEIL_Y + 0.01, FLOOR_Y + y1r)
    if (yb <= ya) continue
    wb.box(mat, r.x0, ya, r.z1 - t, r.x1, yb, r.z1, { skip: "XxYyZ" })
    wb.box(mat, r.x0, ya, r.z0, r.x0 + t, yb, r.z1 - t, { skip: "xYyZz" })
    wb.box(mat, r.x1 - t, ya, r.z0, r.x1, yb, r.z1 - t, { skip: "XYyZz" })
    // Door wall (spine side), cut for the door.
    const dw = (door?.width ?? 0.92) / 2 + 0.05
    const spans: [number, number, number, number][] = door
      ? [[r.x0 + t, door.x - dw, ya, yb], [door.x + dw, r.x1 - t, ya, yb], [door.x - dw, door.x + dw, Math.max(ya, FLOOR_Y + 2.17), yb]]
      : [[r.x0 + t, r.x1 - t, ya, yb]]
    for (const [a0, a1, y0, y1] of spans) if (a1 > a0 && y1 > y0) wb.box(mat, a0, y0, r.z0, a1, y1, r.z0 + t, { skip: "xXyYz" })
  }
}

function mirror(b: Builder, wb: Builder, xWall: number, z: number, w: number) {
  framedMirror(b, { at: xWall, u: z, face: "x+", width: w }, wb)
}

/**
 * Stainless-framed plate mirror with a live reflection on a wall face: `face` "x+" = wall at x = at facing +x, "x-",
 * "z+", "z-"; `u` is the centre along the wall. Glass 5 mm off the wall, bottom edge at 1.02 m. The frame goes into
 * `frameB` (default `b`); the glass joins the storey group so it hides with the storey.
 */
export function framedMirror(b: Builder, o: { at: number; u: number; face: "x+" | "x-" | "z+" | "z-"; width: number; height?: number; age?: number }, frameB: Builder = b) {
  const w = o.width
  const h = o.height ?? 0.76
  const yc = FLOOR_Y + 1.02 + h / 2
  const f = 0.019
  const s = o.face.endsWith("+") ? 1 : -1
  const alongZ = o.face.startsWith("x")
  const bx = (u0: number, u1: number, y0: number, y1: number) => {
    const c0 = o.at
    const c1 = o.at + s * f
    if (alongZ) frameB.box(CHROME, Math.min(c0, c1), y0, u0, Math.max(c0, c1), y1, u1)
    else frameB.box(CHROME, u0, y0, Math.min(c0, c1), u1, y1, Math.max(c0, c1))
  }
  const u = o.u
  bx(u - w / 2 - f, u + w / 2 + f, yc - h / 2 - f, yc - h / 2)
  bx(u - w / 2 - f, u + w / 2 + f, yc + h / 2, yc + h / 2 + f)
  bx(u - w / 2 - f, u - w / 2, yc - h / 2, yc + h / 2)
  bx(u + w / 2, u + w / 2 + f, yc - h / 2, yc + h / 2)
  const p: [number, number, number] = alongZ ? [o.at + s * 0.005, yc + b.oy, u] : [u, yc + b.oy, o.at + s * 0.005]
  const n: [number, number, number] = alongZ ? [s, 0, 0] : [0, 0, s]
  const glass = createMirror(b.ctx, { width: w, height: h, position: p, normal: n, age: o.age ?? 0.55 })
  glass.layers.enable(WASHROOM_LAYER)
  // Hint for render/mirrors.ts: reflect only this layer (+ the player) instead of the whole world.
  glass.userData.reflectLayer = WASHROOM_LAYER
  // Storey groups sit at the origin, so re-parenting keeps the world transform.
  b.group.add(glass)
  return glass
}

/** Wall glass-globe soap dispenser: chrome bracket, inverted globe with pink fill at 60 %, push valve. */
function soap(wb: Builder, xWall: number, z: number) {
  const y = FLOOR_Y + 1.05
  wb.rbox(CHROME, T(xWall + 0.006, y, z), 0.012, 0.06, 0.08, 0.003)
  wb.box(CHROME, xWall + 0.012, y - 0.01, z - 0.012, xWall + 0.07, y + 0.01, z + 0.012)
  const cx = xWall + 0.075
  const globe = new THREE.SphereGeometry(0.055, 18, 12)
  globe.translate(cx, y + 0.07, z)
  wb.add(M.glass, globe, { cast: false })
  const fill = new THREE.SphereGeometry(0.05, 16, 10, 0, Math.PI * 2, Math.PI * 0.4, Math.PI * 0.6)
  fill.translate(cx, y + 0.07, z)
  wb.add(LIQUID, fill, { cast: false, worldUV: false })
  wb.cyl(CHROME, T(cx, y + 0.005, z), 0.012, 0.016, 0.03, 12)
  wb.cyl(CHROME, T(cx, y - 0.02, z), 0.008, 0.008, 0.02, 8)
}

/** 0.15 m nickel-bronze strainer flush with the tile (slots, corner screws), stain ring and wet patch. */
function drain(wb: Builder, x: number, z: number) {
  const y = FLOOR_Y
  wb.box(BRONZE, x - 0.075, y, z - 0.075, x + 0.075, y + LAYER, z + 0.075, { cast: false, skip: "y" })
  for (let k = 0; k < 5; k++) for (let j = 0; j < 4; j++) wb.box(M.darkSteel, x - 0.06 + k * 0.026, y + LAYER, z - 0.05 + j * 0.03, x - 0.06 + k * 0.026 + 0.012, y + LAYER + 0.0008, z - 0.05 + j * 0.03 + 0.022, { cast: false })
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) wb.cyl(CHROME, T(x + sx! * 0.062, y + LAYER + 0.0005, z + sz! * 0.062), 0.005, 0.005, 0.001, 8, { cast: false })
  wb.quad(RING, T(x, y + 0.0015, z, 0, -Math.PI / 2), 0.21, 0.21, { cast: false })
  wb.quad(WET, T(x - 0.15, y + 0.001, z, 0.3, -Math.PI / 2), 1.0, 0.8, { cast: false })
}
