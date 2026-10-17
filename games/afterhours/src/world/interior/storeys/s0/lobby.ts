import * as THREE from "three/webgpu"
import { BUILDING, INTERIOR } from "../../../layout"
import { MODELS } from "../../../../render/models"
import {
  type Builder,
  CEIL_Y,
  FLOOR_Y,
  LAYER,
  M,
  PANEL_WARM,
  ROOM_BANDS,
  STYLES,
  T,
  TUBE_WARM,
  ceiling,
  exitSign,
  fluoroLamp,
  partition,
  placeModels,
  troffer,
  troffers,
  wastebasket,
  yawToward,
} from "../../api"
import { type Docs, LOBBY_BANDS } from "./common"

// Lobby 0-01 (concept r5-02, kept): terrazzo, tiled wainscot, one warm troffer left on, the L reception counter with
// the guard's desk behind it, beam seating, plants. The link north to the junction, and the junction landmark 0-02
// (dedication photo, plaque, floor directory) at the end of the sightline from the entrance.

const L = INTERIOR.lobby
const ST = STYLES[0]!

export function buildLobby(b: Builder, docs: Docs) {
  const [x0, z0] = L.min
  const [x1, z1] = L.max
  // Terrazzo runs out under the storefront to the door sill, flush with the entrance landing (no step).
  const fy = BUILDING.floorY + 0.005
  b.box("terrazzo", x0, fy - 0.012, z0, x1, fy, 21.81, { cast: false, skip: "y" })
  b.walk(x0, z0, x1, 21.81, fy)

  // North wall (z 8.85..9.0): badge room | link (double door, propped open) | ready room.
  partition(b, { axis: "x", at: z0 - 0.075, from: x0 - 0.15, to: -1.6, thickness: 0.15, finish: [ROOM_BANDS, LOBBY_BANDS] })
  partition(b, {
    axis: "x",
    at: z0 - 0.075,
    from: -1.6,
    to: 1.6,
    thickness: 0.15,
    finish: [ST, LOBBY_BANDS],
    openings: [{ kind: "door", at: 0, side: "b", door: { id: "0-01N", state: "open", double: true, width: 1.8, open: Math.PI / 2, room: "0-01" } }],
  })
  partition(b, { axis: "x", at: z0 - 0.075, from: 1.6, to: x1 + 0.15, thickness: 0.15, finish: [ROOM_BANDS, LOBBY_BANDS] })
  // West wall: personnel office door and its counter window; east wall: the security office door, standing open.
  partition(b, {
    axis: "z",
    at: x0 - 0.075,
    from: z0,
    to: z1,
    thickness: 0.15,
    finish: [ROOM_BANDS, LOBBY_BANDS],
    openings: [
      { kind: "door", at: 12, side: "b", door: { id: "0-36L", state: "closed", room: "0-36", sign: { number: "0-36", label: "PERSONNEL" } } },
      { kind: "glazed", from: 16.4, to: 18.2, sill: 1.05, head: 2.05, mullion: 0.9 },
    ],
  })
  // Counter ledge under the personnel window, both sides.
  b.rbox(M.laminateTop, T(x0 - 0.075, FLOOR_Y + 1.05, 17.3), 0.5, 0.035, 1.9, 0.008)
  b.collide(x0 - 0.33, FLOOR_Y, 16.35, x0 + 0.18, FLOOR_Y + 1.07, 18.25)
  partition(b, {
    axis: "z",
    at: x1 + 0.075,
    from: z0,
    to: z1,
    thickness: 0.15,
    finish: [LOBBY_BANDS, ROOM_BANDS],
    openings: [{ kind: "door", at: 12, side: "a", door: { id: "0-38L", state: "open", room: "0-38", open: 1.35, sign: { number: "0-38", label: "SECURITY" } } }],
  })

  ceiling(b, x0, z0, x1, z1)
  for (const x of [-4.8, 0, 4.8])
    for (const z of [12, 15.6, 19.2]) {
      const lit = x === 0 && z === 15.6
      troffer(b, x, z, lit ? "on" : "off", PANEL_WARM)
      if (lit) b.lamp({ ...fluoroLamp(x, z, 45), color: TUBE_WARM })
    }
  // Exit sign hung under the ceiling inside the storefront.
  b.rod(M.darkSteel, [0, CEIL_Y, 21.05], [0, FLOOR_Y + 2.76, 21.05], 0.008, 6)
  exitSign(b, 0, 21.0, 0, -1, FLOOR_Y + 2.62)

  reception(b, docs)
  chairs(b, -2.6, 14.6, 5, 1)
  plant(b, x0 + 0.45, z0 + 0.45)
  plant(b, x1 - 0.45, z0 + 0.45)
  plant(b, x1 - 0.5, z1 - 0.6)
  wastebasket(b, -2.5, 17.6)
  // The lobby's camera, high in the north-west corner looking at the doors.
  placeModels(b, "security_camera", [{ position: [x0 + 0.35, 2.62, z0 + 0.35], yaw: yawToward(0.55, 1) + Math.PI, collide: false }])
  // Notices beside the link doors.
  docs.wall("notice_nightshift", -2.3, FLOOR_Y + 1.55, z0 + 0.002, 0, 1, { pin: "tape" })
  docs.wall("map_evac_0", 2.35, FLOOR_Y + 1.5, z0 + 0.002, 0, 1, { pin: "tack", rotation: 0.01 })
  docs.wall("notice_north_lot", x1 - 0.002, FLOOR_Y + 1.55, 14.0, -1, 0, { pin: "tape" })
}

function reception(b: Builder, docs: Docs) {
  const y = FLOOR_Y
  const fx0 = 2.8
  const fx1 = 7.6
  const fz0 = 15.2
  const fz1 = 15.75
  b.box(M.laminate, fx0, y, fz0, fx1, y + 1.08, fz1)
  b.box(M.laminateTop, fx0 - 0.03, y + 1.08, fz0 - 0.08, fx1 + 0.03, y + 1.12, fz1 + 0.06)
  b.box("rubber", fx0, y, fz1, fx1, y + 0.1, fz1 + 0.01, { cast: false })
  b.box(M.laminate, fx0, y, 12.6, fx0 + 0.55, y + 1.08, fz0)
  b.box(M.laminateTop, fx0 - 0.03, y + 1.08, 12.6, fx0 + 0.58, y + 1.12, fz0 - 0.08)
  b.collide(fx0 - 0.03, y, fz0 - 0.08, fx1, y + 1.12, fz1 + 0.06)
  b.collide(fx0 - 0.03, y, 12.6, fx0 + 0.58, y + 1.12, fz0)
  // Sign-in book (a clipboard with the night sheet), the memo taped to the counter, a mug.
  const top = y + 1.121
  const clip = T(5.2, top, 15.45, -0.15)
  b.boxM(M.clipboard, clip, 0.23, 0.006, 0.32, 0, 0.003, 0, { cast: false })
  b.boxM("metal_galvanized", clip, 0.08, 0.012, 0.025, 0, 0.012, -0.14)
  docs.flat("signin_sheet", 5.2, top + 0.0065, 15.46, -0.15, { scale: 0.95 })
  docs.flat("memo_signin", 6.6, top, 15.42, 0.08, { pin: "tape" })
  b.cyl(M.jugWhite, T(3.4, y + 1.17, 15.5), 0.04, 0.04, 0.1, 12)
  // Guard's desk behind the counter: terminal, phone, chair pushed back, filing cabinets on the east wall.
  const desk = { x: 5.5, z: 13.95 }
  const dtop = y + MODELS.office_desk.size[1]
  placeModels(b, "office_desk", [{ position: [desk.x, y, desk.z], yaw: 0 }])
  placeModels(b, "crt_terminal", [{ position: [desk.x - 0.3, dtop, desk.z + 0.05], yaw: 0.12, collide: false }])
  placeModels(b, "telephone", [{ position: [desk.x + 0.55, dtop, desk.z + 0.1], yaw: -0.4, collide: false }])
  placeModels(b, "office_chair", [{ position: [desk.x - 0.5, y, desk.z - 1.0], yaw: Math.PI + 0.9, inset: 0.12 }])
  placeModels(b, "filing_cabinet", [
    { position: [8.72, y, 13.4], yaw: yawToward(-1, 0) },
    { position: [8.72, y, 13.86], yaw: yawToward(-1, 0) },
  ])
  docs.flat("card_extensions", desk.x + 0.2, dtop + 0.001, desk.z + 0.25, 0.3)
  docs.flat("sticky_marge", desk.x - 0.62, dtop + 0.001, desk.z - 0.2, -0.2)
}

/** Link north to the junction, and the junction landmark on the spine's north wall. */
export function buildLink(b: Builder, docs: Docs) {
  const zs = 1.75
  const ze = L.min[1] - 0.15
  b.floor(ST.floor, -1.6, zs, 1.6, ze)
  const sy = FLOOR_Y + LAYER
  for (const x of [-1.18, 1.18]) b.box(M.stripe, x - 0.05, sy - 0.003, 1.24, x + 0.05, sy, ze - 0.1, { cast: false })
  partition(b, { axis: "z", at: -1.675, from: zs, to: ze, thickness: 0.15, finish: [ROOM_BANDS, ST] })
  partition(b, { axis: "z", at: 1.675, from: zs, to: ze, thickness: 0.15, finish: [ST, ROOM_BANDS] })
  ceiling(b, -1.6, 1.6, 1.6, ze)
  troffers(b, [{ x: 0, z: 3.6, on: true }, { x: 0, z: 7.2, on: true }], { intensity: 9, perLamp: 2 })
  docs.wall("map_evac_0", -1.6 + 0.002, FLOOR_Y + 1.5, 4.2, 1, 0, { pin: "tack" })
  docs.wall("notice_firedoors", 1.6 - 0.002, FLOOR_Y + 1.5, 6.6, -1, 0, { pin: "tape" })

  // 0-02: dedication photo (dish, 1979) in a heavy frame, bronze plaque under it, the floor directory board.
  const zw = -1.6
  const fm = T(-0.55, FLOOR_Y + 1.62, zw)
  b.rbox(M.veneerDark, fm, 0.78, 0.62, 0.035, 0.01, 0, 0, 0.0175)
  b.boxM(M.paper, fm, 0.66, 0.5, 0.004, 0, 0, 0.036, { cast: false })
  docs.add("polaroid_dish", [-0.55, FLOOR_Y + 1.63, zw + 0.0385], [0, 0, 1], { scale: 5.2, pin: "none", curl: 0, offset: 0.0005 })
  const BRONZE = M.clipboard
  b.rbox(BRONZE, T(-0.55, FLOOR_Y + 1.12, zw), 0.42, 0.26, 0.016, 0.006, 0, 0, 0.008)
  for (let k = 0; k < 5; k++) b.boxM(M.lampShade, T(-0.55, FLOOR_Y + 1.2 - k * 0.04, zw), k === 0 ? 0.26 : 0.18 + (k % 2) * 0.08, 0.012, 0.004, 0, 0, 0.018, { cast: false })
  for (const sx of [-1, 1]) for (const sy2 of [-1, 1]) b.cyl(M.lampShade, T(-0.55 + sx * 0.18, FLOOR_Y + 1.12 + sy2 * 0.1, zw + 0.018, 0, Math.PI / 2), 0.008, 0.008, 0.006, 8)
  directory(b, 0.72, zw)
}

/** Felt letter board with rows of white letters too small and blurred to read (the floor directory). */
function directory(b: Builder, x: number, zWall: number) {
  const y0 = FLOOR_Y + 1.0
  const w = 0.9
  const h = 1.2
  b.box(M.wood, x - w / 2 - 0.04, y0 - 0.04, zWall, x + w / 2 + 0.04, y0 + h + 0.04, zWall + 0.05)
  b.box(M.felt, x - w / 2, y0, zWall + 0.05, x + w / 2, y0 + h, zWall + 0.052, { cast: false })
  let seed = 3
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  for (let row = 0; row < 16; row++) {
    const ry = y0 + h - 0.12 - row * 0.066
    if (row === 1 || row === 6 || row === 11) continue
    let cx = x - w / 2 + 0.06
    const words = row === 0 ? 2 : 2 + Math.floor(rnd() * 3)
    for (let k = 0; k < words; k++) {
      const len = row === 0 ? 0.16 : 0.05 + rnd() * 0.13
      if (cx + len > x + w / 2 - 0.2) break
      b.box(M.feltText, cx, ry, zWall + 0.052, cx + len, ry + (row === 0 ? 0.03 : 0.018), zWall + 0.056, { cast: false })
      cx += len + 0.025
    }
    if (row > 1) b.box(M.feltText, x + w / 2 - 0.12, ry, zWall + 0.052, x + w / 2 - 0.06, ry + 0.018, zWall + 0.056, { cast: false })
  }
  b.box("metal_galvanized", x - w / 2 - 0.04, y0 + h + 0.04, zWall, x + w / 2 + 0.04, y0 + h + 0.06, zWall + 0.06)
}

// ---- moulded shell chairs on a beam and potted plants (copied from the original lobby so storey 0 owns them)

const SHELL_T = 0.009
const SEAT_UNDER = 0.446
const shellGeo = (() => {
  // Centreline profile [z, y], front lip to top of the back.
  const raw: [number, number][] = [
    [0.222, 0.418], [0.212, 0.446], [0.17, 0.458], [0.08, 0.457], [-0.02, 0.452], [-0.11, 0.455], [-0.165, 0.472],
    [-0.2, 0.505], [-0.218, 0.56], [-0.233, 0.64], [-0.248, 0.72], [-0.262, 0.8], [-0.27, 0.845], [-0.268, 0.868],
  ]
  // Resample evenly along the arc.
  const len = [0]
  for (let k = 1; k < raw.length; k++) len.push(len[k - 1]! + Math.hypot(raw[k]![0] - raw[k - 1]![0], raw[k]![1] - raw[k - 1]![1]))
  const nv = 22
  const nu = 13
  const prof: [number, number][] = []
  for (let j = 0; j < nv; j++) {
    const d = (j / (nv - 1)) * len[len.length - 1]!
    let k = 1
    while (k < len.length - 1 && len[k]! < d) k++
    const t = (d - len[k - 1]!) / (len[k]! - len[k - 1]!)
    prof.push([raw[k - 1]![0] + (raw[k]![0] - raw[k - 1]![0]) * t, raw[k - 1]![1] + (raw[k]![1] - raw[k - 1]![1]) * t])
  }
  const pos: number[] = []
  const v = (i: number) => new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])
  // Top surface: dished across (sides of the seat rise, sides of the back wrap forward), corners rounded in plan.
  for (let j = 0; j < nv; j++) {
    const [pz, py] = prof[j]!
    const backness = THREE.MathUtils.smoothstep(py, 0.47, 0.56)
    const ends = Math.min(j, nv - 1 - j)
    const round = ends === 0 ? 0.84 : ends === 1 ? 0.95 : ends === 2 ? 0.985 : 1
    const hw = (0.232 - backness * 0.012) * round
    for (let i = 0; i < nu; i++) {
      const u = (i / (nu - 1)) * 2 - 1
      const dish = u * u * 0.028
      pos.push(u * hw, py + dish * (1 - backness), pz + dish * backness * 1.3)
    }
  }
  const at = (j: number, i: number) => j * nu + i
  // Normals of the top grid (finite differences), oriented up/forward.
  const nrm: THREE.Vector3[] = []
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      const du = v(at(j, Math.min(nu - 1, i + 1))).sub(v(at(j, Math.max(0, i - 1))))
      const dv = v(at(Math.min(nv - 1, j + 1), i)).sub(v(at(Math.max(0, j - 1), i)))
      nrm.push(new THREE.Vector3().crossVectors(dv, du).normalize())
    }
  const seatN = nrm[at(4, (nu - 1) / 2)]!
  if (seatN.y < 0) for (const n of nrm) n.negate()
  const nTop = nv * nu
  for (let k = 0; k < nTop; k++) {
    const p = v(k).addScaledVector(nrm[k]!, -SHELL_T)
    pos.push(p.x, p.y, p.z)
  }
  // Border loop and the rolled rim ring (half-way through the thickness, pushed outwards by half of it).
  const loop: [number, number][] = []
  for (let i = 0; i < nu; i++) loop.push([0, i])
  for (let j = 1; j < nv; j++) loop.push([j, nu - 1])
  for (let i = nu - 2; i >= 0; i--) loop.push([nv - 1, i])
  for (let j = nv - 2; j >= 1; j--) loop.push([j, 0])
  const rimStart = pos.length / 3
  for (const [j, i] of loop) {
    const ij = at(Math.min(nv - 2, Math.max(1, j)), Math.min(nu - 2, Math.max(1, i)))
    const out = v(at(j, i)).sub(v(ij))
    out.addScaledVector(nrm[at(j, i)]!, -out.dot(nrm[at(j, i)]!)).normalize()
    const p = v(at(j, i)).addScaledVector(nrm[at(j, i)]!, -SHELL_T / 2).addScaledVector(out, SHELL_T * 0.55)
    pos.push(p.x, p.y, p.z)
  }
  const idx: number[] = []
  const tri = (a: number, b: number, c: number, want: THREE.Vector3) => {
    const n = new THREE.Vector3().crossVectors(v(b).sub(v(a)), v(c).sub(v(a)))
    if (n.dot(want) >= 0) idx.push(a, b, c)
    else idx.push(a, c, b)
  }
  for (let j = 0; j < nv - 1; j++)
    for (let i = 0; i < nu - 1; i++) {
      const a = at(j, i), b2 = at(j, i + 1), c = at(j + 1, i), d = at(j + 1, i + 1)
      const n = nrm[a]!
      tri(a, b2, c, n)
      tri(b2, d, c, n)
      const m = n.clone().negate()
      tri(a + nTop, b2 + nTop, c + nTop, m)
      tri(b2 + nTop, d + nTop, c + nTop, m)
    }
  for (let k = 0; k < loop.length; k++) {
    const k1 = (k + 1) % loop.length
    const t0 = at(...loop[k]!), t1 = at(...loop[k1]!)
    const m0 = rimStart + k, m1 = rimStart + k1
    const out = v(m0).sub(v(t0).addScaledVector(nrm[t0]!, -SHELL_T / 2))
    tri(t0, t1, m1, out)
    tri(t0, m1, m0, out)
    tri(m0, m1, t1 + nTop, out)
    tri(m0, t1 + nTop, t0 + nTop, out)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
})()

/**
 * Airport-style beam seating along local x (row centred on `zStart…`), facing +X (`facing` 1) or -X: a rectangular
 * steel beam on two T-legs with rubber pads, each shell bolted down through a cast bracket (post + saddle plate) to
 * the beam. One seat is missing its shell (bare bracket and bolts), one hangs loose on a lost bolt.
 */
function chairs(b: Builder, xRow: number, zStart: number, n: number, facing: 1 | -1) {
  const y = FLOOR_Y
  const pitch = 0.58
  const zEnd = zStart + (n - 1) * pitch
  const F = T(xRow, y, 0, facing * (Math.PI / 2))
  const lx = (z: number) => -facing * z
  const xa = Math.min(lx(zStart), lx(zEnd)) - 0.2
  const xb = Math.max(lx(zStart), lx(zEnd)) + 0.2
  const steel = M.darkSteel
  // Beam: 80 × 50 mm box section, end caps.
  const beamY = 0.335
  b.rbox(steel, F, xb - xa, 0.05, 0.08, 0.006, (xa + xb) / 2, beamY, -0.04)
  for (const x of [xa, xb]) b.rbox(M.rubber, F, 0.006, 0.044, 0.074, 0.002, x - Math.sign(x - (xa + xb) / 2) * -0.003, beamY, -0.04)
  // T-legs in the gaps between the first two and last two seats: post, foot bar, pads.
  const legs = [lx(zStart + pitch / 2), lx(zEnd - pitch / 2)]
  for (const x of legs) {
    b.rbox(steel, F, 0.06, beamY - 0.025 - 0.03, 0.05, 0.006, x, (beamY - 0.025 + 0.03) / 2, -0.04)
    b.rbox(steel, F, 0.07, 0.03, 0.62, 0.006, x, 0.015 + 0.012, -0.04)
    for (const z of [-0.33, 0.25]) b.rbox(M.rubber, F, 0.08, 0.012, 0.08, 0.004, x, 0.006, z)
  }
  for (let i = 0; i < n; i++) {
    const x = lx(zStart + i * pitch)
    const missing = i === 2
    const loose = i === 4
    // Bracket: post from the beam top up to a saddle plate under the seat pan, two bolt heads on the plate.
    const plateY = SEAT_UNDER - 0.006
    b.rbox(steel, F, 0.05, plateY - (beamY + 0.025), 0.04, 0.005, x, (plateY + beamY + 0.025) / 2, -0.03)
    b.rbox(steel, F, 0.2, 0.012, 0.16, 0.004, x, plateY, -0.02)
    for (const bx of [-0.07, 0.07]) b.cyl(missing ? M.steel : steel, F.clone().multiply(T(x + bx, plateY + 0.009, -0.02)), 0.009, 0.009, 0.006, 8)
    if (missing) continue
    const S = F.clone().multiply(T(x, loose ? 0.004 : 0, 0, loose ? 0.06 : 0, loose ? -0.035 : 0, loose ? 0.025 : 0))
    b.add("plastic_orange", shellGeo.clone().applyMatrix4(S))
  }
  const z0 = Math.min(zStart, zEnd) - 0.4
  const z1 = Math.max(zStart, zEnd) + 0.4
  b.collide(xRow - 0.34, y, z0, xRow + 0.3, y + 0.9, z1)
}

function plant(b: Builder, x: number, z: number) {
  const y = FLOOR_Y
  b.cyl(M.potClay, T(x, y + 0.22, z), 0.21, 0.16, 0.44, 14)
  b.cyl(M.soil, T(x, y + 0.42, z), 0.19, 0.19, 0.02, 14, { cast: false })
  let seed = Math.round(Math.abs(x * 13 + z * 7)) + 1
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  b.cyl(M.wood, T(x, y + 0.75, z), 0.015, 0.02, 0.7, 6)
  for (let i = 0; i < 26; i++) {
    const yaw = rnd() * Math.PI * 2
    const tilt = 0.5 + rnd() * 0.8
    const len = 0.35 + rnd() * 0.3
    const h = y + 0.5 + rnd() * 0.75
    const m = T(x, h, z, yaw, tilt)
    b.boxM(M.leaf, m, 0.06 + rnd() * 0.04, 0.006, len, 0, 0, -len / 2)
  }
  b.collide(x - 0.22, y, z - 0.22, x + 0.22, y + 1.2, z + 0.22)
}
