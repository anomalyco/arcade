import { BoxGeometry, CylinderGeometry, ExtrudeGeometry, Group, LatheGeometry, Mesh, Path, PlaneGeometry, Shape, TorusGeometry, Vector2, type BufferGeometry, type Material, type Object3D, type Vector3 } from "three/webgpu"
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js"
import { documentMesh, documentsByTag, type DocumentId, type DocumentPlacement } from "../../render/documents"
import { BROWSER, finish, labelMaterial, rng, type Finish } from "./finish"
import type { InteractiveProp, Item } from "./prop"

// What lives inside the interactive containers: upright manila files with pressboard dividers in the filing drawers,
// desk-drawer clutter, real keys on rings with stamped tags, badges, clipboards and plans from the documents atlas,
// and the locker interiors (hat shelf, hooks, a hanging coat). All local to the moving tray or door, so it travels.

export type V3 = [number, number, number]
export type AO = (p: Vector3, n: Vector3) => number
type Opts = { rot?: V3; ao?: AO; shadow?: boolean; keep?: boolean }

export function mesh(parent: Object3D, geometry: BufferGeometry, look: Finish | Material, at: V3 = [0, 0, 0], o: Opts = {}) {
  const m = new Mesh(geometry, typeof look === "string" ? finish(look) : look)
  m.position.set(...at)
  if (o.rot) m.rotation.set(...o.rot)
  m.castShadow = o.shadow ?? true
  m.receiveShadow = true
  if (o.ao) m.userData.ao = o.ao
  if (o.keep) m.userData.keep = true
  parent.add(m)
  return m
}

/** Bevelled sheet or block; `solid` ones also become colliders. */
export function box(prop: InteractiveProp, parent: Object3D, size: V3, at: V3, look: Finish | Material = "steel", solid = true, o: Opts = {}) {
  const m = mesh(parent, new RoundedBoxGeometry(...size, 2, Math.min(0.008, Math.min(...size) / 4)), look, at, o)
  if (solid) prop.solids.push(m)
  return m
}

/** Sharp-edged block for small parts. */
export function block(parent: Object3D, size: V3, at: V3, look: Finish | Material, o: Opts = {}) {
  return mesh(parent, new BoxGeometry(...size), look, at, o)
}

/** Printed face on a card backing: front at +z of `at`. */
export function plate(parent: Object3D, text: string, at: V3, w: number, h: number, style: "card" | "plate" | "tape" = "card") {
  block(parent, [w, h, 0.0015], at, style === "plate" ? "nickel" : style === "tape" ? "rubber" : "paper", { shadow: false })
  const face = new PlaneGeometry(w * 0.97, h * 0.92)
  return mesh(parent, face, labelMaterial(text, style), [at[0], at[1], at[2] + 0.0009], { shadow: false })
}

export function docs(parent: Object3D, placements: DocumentPlacement[]) {
  if (!BROWSER || !placements.length) return null
  const m = documentMesh(placements)
  m.userData.raw = true
  ;(m.material as Material).userData.shared = true
  parent.add(m)
  return m
}

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
const DESK_DOCS = documentsByTag("desk").filter(id => !id.startsWith("door_") && !id.startsWith("badge_") && !id.startsWith("chart_") && !id.startsWith("blotter"))

/** Tray-local filing run: hanging rails, upright manila folders with tabs and typed labels, pressboard dividers
 *  lettered from `range` ("A-G"), a follower plate and a few stained sheets standing proud. Floor at y = 0. */
export function fileRun(parent: Object3D, w: number, h: number, d: number, range: string, seed: number) {
  const r = rng(seed)
  const files = new Group(); files.name = "files"; parent.add(files)
  for (const sx of [-1, 1]) block(files, [0.006, 0.012, d - 0.06], [sx * (w / 2 - 0.022), h - 0.03, 0], "chrome", { shadow: false })
  const [from, to] = range.split("-").map(s => s.charCodeAt(0) - 65)
  const z0 = -d / 2 + 0.03, z1 = d / 2 - 0.09
  let z = z0, i = 0, dividers = 0
  const papers: DocumentPlacement[] = []
  const fw = w - 0.05
  while (z < z1) {
    const lean = (r() - 0.5) * 0.1
    if (i % 7 === 3) {
      const letter = Math.min(to, from + dividers++)
      const hh = 0.255
      const div = new Group(); div.position.set(0, 0, z + 0.001); div.rotation.x = lean; files.add(div)
      block(div, [fw + 0.01, hh, 0.0018], [0, hh / 2 + 0.006, 0], "pressboard", { ao: p => 0.4 + 0.6 * smooth(0.02, hh, p.y) })
      const tx = (-0.5 + ((letter * 0.37) % 1)) * (fw - 0.06)
      block(div, [0.052, 0.026, 0.0018], [tx, hh + 0.006 + 0.013, 0], "pressboard")
      for (const side of [1, -1]) {
        const tab = new PlaneGeometry(0.046, 0.022)
        const uv = tab.getAttribute("uv")
        for (let k = 0; k < uv.count; k++) uv.setX(k, (letter + 0.08 + uv.getX(k) * 0.84) / 32)
        mesh(div, tab, "tabs", [tx, hh + 0.019, side * 0.0011], { rot: [0, side > 0 ? 0 : Math.PI, 0], shadow: false })
      }
      z += 0.006
    }
    const t = 0.003 + r() * r() * 0.016, hh = 0.235 + r() * 0.03, width = fw - r() * 0.02
    const tint = 0.72 + r() * 0.28
    const folder = new Group(); folder.position.set((r() - 0.5) * 0.008, 0, z + t / 2); folder.rotation.x = lean; files.add(folder)
    block(folder, [width, hh, t], [0, hh / 2 + 0.004, 0], "manila", { ao: p => tint * (0.35 + 0.65 * smooth(0.0, hh * 0.9, p.y)) })
    const third = i % 3, tx = (third - 1) * (width / 3)
    block(folder, [width / 3 - 0.012, 0.016, Math.max(0.0012, t * 0.4)], [tx, hh + 0.012, t * 0.3], "manila", { ao: () => tint })
    if (r() < 0.65) block(folder, [width / 3 - 0.03, 0.011, 0.0005], [tx, hh + 0.0125, t * 0.3 + Math.max(0.0012, t * 0.4) / 2 + 0.0003], "paper", { shadow: false })
    if (r() < 0.12 && papers.length < 3) papers.push({ id: DESK_DOCS[Math.floor(r() * DESK_DOCS.length)], position: [(r() - 0.5) * 0.06, 0.15 + r() * 0.03, z + t * 0.5], normal: [0, 0, 1], up: [0, 1, 0], rotation: (r() - 0.5) * 0.08, pin: "none", curl: 0.08, scale: 0.96, offset: 0 })
    z += t + 0.003 + r() * 0.004
    i++
  }
  // Follower plate: the sprung compressor that keeps the run upright.
  block(files, [fw - 0.02, 0.17, 0.003], [0, 0.09, z + 0.012], "inside", { rot: [0.22, 0, 0], ao: p => 0.5 + 0.5 * smooth(0, 0.17, p.y + 0.085) })
  docs(files, papers)
  return { node: files, top: 0.28 }
}

/** Tray-local desk-drawer clutter: loose stained sheets, pencils, paper clips, a rubber stamp and an envelope. */
export function deskClutter(parent: Object3D, w: number, d: number, seed: number) {
  const r = rng(seed)
  const node = new Group(); node.name = "clutter"; parent.add(node)
  const sheets: DocumentPlacement[] = []
  for (let i = 0; i < 3; i++) sheets.push({ id: DESK_DOCS[Math.floor(r() * DESK_DOCS.length)], position: [(r() - 0.5) * 0.05, 0.001 + i * 0.0012, -d * 0.15 + (r() - 0.5) * 0.06], normal: [0, 1, 0], up: [0, 0, -1], rotation: (r() - 0.5) * 0.6, pin: i === 2 ? "staple" : "none", curl: 0.1, scale: 0.92, seed: seed + i })
  docs(node, sheets)
  for (let i = 0; i < 3; i++) {
    const x = (r() - 0.5) * (w - 0.14), z = d * 0.28 + (r() - 0.5) * 0.08, yaw = 1.4 + (r() - 0.5) * 0.5, len = 0.12 + r() * 0.06
    const pencil = new Group(); pencil.position.set(x, 0.0042, z); pencil.rotation.set(0, yaw, Math.PI / 2); node.add(pencil)
    mesh(pencil, new CylinderGeometry(0.0038, 0.0038, len, 6), "pencil", [0, 0, 0], { shadow: false })
    mesh(pencil, new CylinderGeometry(0.0039, 0.0039, 0.008, 8), "brass", [0, len / 2 + 0.004, 0], { shadow: false })
    mesh(pencil, new CylinderGeometry(0.0036, 0.0036, 0.007, 8), "eraser", [0, len / 2 + 0.0115, 0], { shadow: false })
    mesh(pencil, new CylinderGeometry(0.0038, 0.0006, 0.016, 6), "wood", [0, -len / 2 - 0.008, 0], { shadow: false })
  }
  for (let i = 0; i < 7; i++) mesh(node, new TorusGeometry(0.0065, 0.0006, 4, 12, Math.PI * 1.6), "nickel", [(r() - 0.5) * (w - 0.08), 0.0008, d * 0.05 + (r() - 0.5) * 0.2], { rot: [Math.PI / 2, 0, r() * 6], shadow: false })
  const stamp = new Group(); stamp.position.set(w / 2 - 0.07, 0, -d / 2 + 0.08); stamp.rotation.y = r(); node.add(stamp)
  block(stamp, [0.055, 0.012, 0.03], [0, 0.006, 0], "rubber")
  mesh(stamp, new CylinderGeometry(0.009, 0.012, 0.05, 10), "wood", [0, 0.037, 0])
  mesh(stamp, new TorusGeometry(0.011, 0.005, 6, 12), "wood", [0, 0.065, 0], { rot: [Math.PI / 2, 0, 0] })
  block(node, [0.23, 0.003, 0.11], [-(w / 2 - 0.13), 0.0055, -d / 2 + 0.07], "manila", { rot: [0, 0.12, 0], ao: () => 0.75 })
  // A spare ring with a stamped tag, and a stamped dog tag on its ball chain.
  if (r() < 0.7) {
    const spare = keyRing(node, { id: "spare", kind: "key", label: "spare" }, (["STORE 2", "BOILER", "No 14", "GATE B", "DOCK"] as const)[Math.floor(r() * 5)], seed + 5)
    spare.rotation.set(-Math.PI / 2, 0, r() * 6); spare.position.set(w / 2 - 0.1, 0.004, d * 0.12)
  }
  if (r() < 0.5) {
    const tag = new Group(); tag.position.set(-w / 2 + 0.09, 0.002, d * 0.3); tag.rotation.y = r() * 6; node.add(tag)
    mesh(tag, new RoundedBoxGeometry(0.05, 0.0012, 0.028, 2, 0.0005), "nickel", [0, 0, 0])
    mesh(tag, new PlaneGeometry(0.044, 0.022), labelMaterial((["HARGROVE R", "KESSLER D", "WHITLOCK C"] as const)[Math.floor(r() * 3)], "plate"), [0, 0.0007, 0], { rot: [-Math.PI / 2, 0, 0], shadow: false })
    for (let i = 0; i < 26; i++) { const a = i / 26 * Math.PI * 1.7 + 0.4; mesh(tag, new CylinderGeometry(0.0013, 0.0013, 0.0026, 5), "nickel", [Math.cos(a) * 0.045 - 0.03, 0.0013, Math.sin(a) * 0.035], { shadow: false }) }
  }
  return node
}

// ------------------------------------------------------------------------------------------------ items

let keyGeometry: BufferGeometry | null = null
/** A pin-tumbler key in the XY plane, bow at the top (hole centre at the origin), blade hanging down −Y. */
function keyShape(): BufferGeometry {
  if (keyGeometry) return keyGeometry.clone()
  const s = new Shape()
  const R = 0.0115
  s.moveTo(-0.0038, -0.0105)
  s.absarc(0, 0.0, R, Math.atan2(-0.0105, -0.0038), Math.atan2(-0.0105, 0.0038), true)
  s.lineTo(0.0052, -0.0135)
  s.lineTo(0.0052, -0.0165)
  const cuts = [0.0068, 0.0046, 0.0062, 0.0042, 0.0066, 0.0048]
  cuts.forEach((x, i) => { const y = -0.019 - i * 0.0056; s.lineTo(x, y); s.lineTo(x, y - 0.0028); s.lineTo(Math.min(x, cuts[i + 1] ?? 0.004), y - 0.0056) })
  s.lineTo(0.0028, -0.0545)
  s.lineTo(-0.0005, -0.0565)
  s.lineTo(-0.0038, -0.0535)
  s.lineTo(-0.0038, -0.0105)
  const hole = new Path(); hole.absarc(0, 0.0045, 0.0028, 0, Math.PI * 2, false); s.holes.push(hole)
  keyGeometry = new ExtrudeGeometry(s, { depth: 0.0016, bevelEnabled: true, bevelThickness: 0.0003, bevelSize: 0.00025, bevelSegments: 1, curveSegments: 12 }).translate(0, -0.0045, -0.0008)
  return keyGeometry.clone()
}

/** A ring of keys with a stamped tag or plastic fob, hanging with the ring's top at the group origin. */
export function keyRing(parent: Object3D, item: Item, tagText: string, seed: number) {
  const r = rng(seed)
  const g = new Group(); parent.add(g)
  mesh(g, new TorusGeometry(0.011, 0.0008, 5, 20), "nickel", [0, -0.011, 0], { rot: [0, Math.PI / 2, 0] })
  const keys = item.id === "truck-keys" ? 2 : 1 + Math.floor(r() * 3)
  for (let i = 0; i < keys; i++) {
    const a = (i - (keys - 1) / 2) * 0.32 + (r() - 0.5) * 0.12
    const key = new Group(); key.position.set(0, -0.0215, (i - (keys - 1) / 2) * 0.0022); key.rotation.z = a; g.add(key)
    mesh(key, keyShape(), i % 2 ? "nickel" : "brass", [0, 0, 0])
  }
  const tag = new Group(); tag.position.set(0, -0.0215, 0.006); tag.rotation.z = -0.5 - r() * 0.3; g.add(tag)
  if (item.id === "truck-keys") {
    block(tag, [0.003, 0.012, 0.003], [0, -0.004, 0], "nickel")
    mesh(tag, new RoundedBoxGeometry(0.024, 0.042, 0.005, 2, 0.002), "redFob", [0, -0.03, 0])
    plate(tag, "TRUCK 2", [0, -0.032, 0.0026], 0.02, 0.012, "tape")
  } else {
    mesh(tag, new RoundedBoxGeometry(0.032, 0.018, 0.0012, 2, 0.0005), "nickel", [0, -0.012, 0])
    mesh(tag, new PlaneGeometry(0.028, 0.013), labelMaterial(tagText, "plate"), [0, -0.012, 0.0007], { shadow: false })
  }
  return g
}

const BADGES: Partial<Record<string, DocumentId>> = { "badge-hargrove": "badge_hargrove" }
const SHEETS: Partial<Record<string, DocumentId>> = { "note-shift": "work_order_night", "note-woods": "notice_north_array" }

/** Socket contents in the socket's frame, lying on a surface (+Y up, top of the sheet towards −Z); keys `hanging`
 *  from a hook at the origin instead. Orient the socket node to stand an item on a door. */
export function itemModel(parent: Object3D, item: Item, seed: number, hanging = false) {
  const g = new Group(); parent.add(g)
  if (item.kind === "key") {
    const ring = keyRing(g, item, tagFor(item), seed)
    if (!hanging) { ring.rotation.x = -Math.PI / 2; ring.position.set(0, 0.0035, -0.03) }
  } else if (item.kind === "badge") {
    docs(g, [{ id: BADGES[item.id] ?? "badge_kessler", position: [0, 0.0012, 0], normal: [0, 1, 0], up: [0, 0, -1], curl: 0, pin: "none", offset: 0.0015 }])
    block(g, [0.058, 0.0012, 0.09], [0, 0.0008, 0], "board", { shadow: false })
    block(g, [0.016, 0.003, 0.02], [0, 0.003, -0.05], "chrome")
  } else if (item.kind === "clipboard") {
    mesh(g, new RoundedBoxGeometry(0.23, 0.005, 0.32, 2, 0.002), "hardboard", [0, 0.0025, 0])
    docs(g, [{ id: SHEETS[item.id] ?? "checklist_rounds", position: [0, 0.0055, 0.01], normal: [0, 1, 0], up: [0, 0, -1], curl: 0.05, pin: "none", seed }])
    block(g, [0.09, 0.008, 0.03], [0, 0.009, -0.142], "chrome")
    mesh(g, new TorusGeometry(0.008, 0.0016, 5, 12, Math.PI), "chrome", [0, 0.012, -0.128], { rot: [0, 0, 0] })
  } else {
    const storey = /(\d)$/.exec(item.id)?.[1] ?? "0"
    block(g, [0.24, 0.003, 0.31], [0.01, 0.0015, 0.005], "manila", { rot: [0, 0.05, 0], ao: () => 0.85 })
    docs(g, [{ id: `map_evac_${storey}` as DocumentId, position: [0, 0.0035, 0], normal: [0, 1, 0], up: [0, 0, -1], scale: 0.95, curl: 0.25, pin: "none", seed, rotation: -0.06 },
      { id: DESK_DOCS[seed % DESK_DOCS.length], position: [0.015, 0.0028, 0.03], normal: [0, 1, 0], up: [0, 0, -1], curl: 0.1, pin: "none", seed: seed + 1, rotation: 0.1 }])
  }
  return g
}

function tagFor(item: Item) {
  if (item.id === "cabinet-key") return "FAC CAB"
  const n = /(\d+)/.exec(item.label)?.[1]
  return n ? `No ${n}` : "SPARE"
}

// ------------------------------------------------------------------------------------------------ lockers

/** Stamped louvre: a dark slot with a pressed hood over it, on a door face at +z. */
export function louvres(parent: Object3D, x: number, y: number, z: number, n: number, w: number) {
  for (let k = 0; k < n; k++) {
    const yy = y + k * 0.03
    block(parent, [w, 0.007, 0.0012], [x, yy, z + 0.0004], "slot", { shadow: false })
    block(parent, [w + 0.006, 0.011, 0.004], [x, yy + 0.006, z + 0.0028], "locker", { rot: [-0.65, 0, 0] })
  }
}

let coatBody: BufferGeometry | null = null
/** A coat hung from a hook: lathe body (shoulders, chest, flared hem) with vertical drape folds, flattened to hang
 *  against a wall, and two sleeves. Hook at the origin; it hangs down −Y, back at −Z. */
function coatGeometry(length: number): { body: BufferGeometry; sleeve: BufferGeometry } {
  if (!coatBody) {
    const profile = [[0.225, -1], [0.2, -0.7], [0.19, -0.45], [0.205, -0.25], [0.2, -0.1], [0.16, -0.06], [0.06, -0.035], [0.035, -0.01], [0.001, 0]].map(([x, y]) => new Vector2(x, y))
    const g = new LatheGeometry(profile, 36)
    const p = g.getAttribute("position")
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i)
      const a = Math.atan2(z, x), drape = Math.min(1, Math.max(0, -y - 0.08) / 0.6)
      const fold = 1 + drape * (0.06 * Math.sin(a * 7 + y * 3) + 0.035 * Math.sin(a * 13 - y * 5))
      p.setXYZ(i, x * fold, y, z * fold * 0.45)
    }
    g.computeVertexNormals()
    coatBody = g
  }
  const sleeve = new CylinderGeometry(0.045, 0.055, 0.56, 12, 4).scale(1, 1, 0.7)
  return { body: coatBody.clone().scale(1, length, 1), sleeve }
}

/** One walk-in compartment's fittings, local to the bank: hat shelf, back hooks, an optional hanging coat or jacket,
 *  boots, a thermos and a taped note inside. `x0..x1` across, back at `back`, front at `front`. */
export function lockerFittings(prop: InteractiveProp, parent: Object3D, x0: number, x1: number, back: number, front: number, seed: number, ao: AO) {
  const r = rng(seed)
  const cx = (x0 + x1) / 2, w = x1 - x0, shelf = 1.76
  box(prop, parent, [w - 0.01, 0.018, front - back - 0.03], [cx, shelf, (back + front) / 2 - 0.01], "lockerInside", false, { ao })
  block(parent, [w - 0.01, 0.03, 0.012], [cx, shelf - 0.02, front - 0.03], "lockerInside", { ao: () => 0.7 })
  // Coat rod under the shelf, on flat brackets.
  mesh(parent, new CylinderGeometry(0.0095, 0.0095, w - 0.03, 10), "chrome", [cx, shelf - 0.075, (back + front) / 2 - 0.04], { rot: [0, 0, Math.PI / 2] })
  for (const s of [-1, 1]) block(parent, [0.004, 0.07, 0.03], [cx + s * (w / 2 - 0.012), shelf - 0.05, (back + front) / 2 - 0.04], "chrome")
  for (const hx of [cx - w * 0.25, cx + w * 0.25]) {
    block(parent, [0.02, 0.04, 0.004], [hx, 1.62, back + 0.002], "chrome")
    mesh(parent, new TorusGeometry(0.018, 0.003, 5, 10, Math.PI), "chrome", [hx, 1.6, back + 0.02], { rot: [0, Math.PI / 2, Math.PI] })
  }
  const kind = r()
  if (kind < 0.75) {
    const coat = new Group(); coat.position.set(cx + (r() - 0.5) * w * 0.3, shelf - 0.085, (back + front) / 2 - 0.04); coat.rotation.y = (r() - 0.5) * 0.15; parent.add(coat)
    const look: Finish = kind < 0.45 ? "coat" : "jacket", len = kind < 0.45 ? 1.0 : 0.72
    const { body, sleeve } = coatGeometry(len)
    mesh(coat, body, look, [0, 0, 0], { ao: p => 0.45 + 0.55 * smooth(-len, -0.1, p.y) })
    for (const s of [-1, 1]) mesh(coat, sleeve.clone(), look, [s * 0.17, -0.37, 0.005], { rot: [0, 0, s * 0.06], ao: p => 0.5 + 0.5 * smooth(-0.6, -0.1, p.y - 0.37) })
    // Wire hanger: hook over the rod, shoulders under the collar.
    mesh(coat, new TorusGeometry(0.013, 0.0016, 4, 10, Math.PI * 1.3), "nickel", [0, 0.002, 0], { rot: [0, Math.PI / 2, 0.4] })
    block(coat, [0.006, 0.03, 0.003], [0, -0.016, 0], "nickel")
    for (const s of [-1, 1]) block(coat, [0.2, 0.0035, 0.0035], [s * 0.09, -0.045, 0], "nickel", { rot: [0, 0, s * -0.32] })
  }
  if (r() < 0.6) for (const s of [-1, 1]) {
    const boot = new Group(); boot.position.set(cx + s * 0.07 + (r() - 0.5) * 0.04, 0.025, back + 0.16); boot.rotation.y = (r() - 0.5) * 0.4; parent.add(boot)
    mesh(boot, new RoundedBoxGeometry(0.1, 0.07, 0.28, 2, 0.03), "leather", [0, 0.035, 0])
    mesh(boot, new RoundedBoxGeometry(0.095, 0.16, 0.12, 2, 0.035), "leather", [0, 0.13, -0.07])
  }
  if (r() < 0.6) {
    const t = new Group(); t.position.set(cx + (r() - 0.5) * w * 0.6, shelf + 0.009, back + 0.12); parent.add(t)
    mesh(t, new CylinderGeometry(0.038, 0.038, 0.26, 16), "chrome", [0, 0.13, 0])
    mesh(t, new CylinderGeometry(0.036, 0.034, 0.05, 16), "redFob", [0, 0.285, 0])
  }
}
