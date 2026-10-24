import { Box3, CylinderGeometry, Group, TorusGeometry, Vector3, type Mesh, type Object3D } from "three/webgpu"
import { floorWorldY } from "../interior/plan"
import { InteractiveProp, type Item } from "./prop"
import type { Terminal } from "./terminal"
import { box, block, deskClutter, docs, fileRun, itemModel, lockerFittings, louvres, mesh, plate, type AO, type V3 } from "./contents"
import { cavityAO, finishProp, hashString, rng, type Finish } from "./finish"

export type Placement = { id: string; storey: number; x: number; z: number; yaw?: number; height?: number }

function start(p: Placement) {
  const prop = new InteractiveProp(p.id, p.storey)
  prop.root.position.set(p.x, floorWorldY(p.storey) + (p.height ?? 0), p.z)
  prop.root.rotation.y = p.yaw ?? 0
  return prop
}

/** Chrome drawer pull on two posts, with a thumb latch under the bar; returns the bar (the aim target). */
function pull(prop: InteractiveProp, parent: Object3D, x: number, y: number, z: number, width = 0.15) {
  for (const dx of [-width / 2 + 0.01, width / 2 - 0.01]) box(prop, parent, [0.016, 0.016, 0.026], [x + dx, y, z], "chrome", false)
  block(parent, [width * 0.4, 0.006, 0.012], [x, y - 0.012, z + 0.002], "chrome")
  return box(prop, parent, [width, 0.016, 0.016], [x, y, z + 0.018], "chrome", false)
}

/** Open carcass: collision is the individual sheets, leaving a real accessible interior. Front faces local +Z. */
function carcass(prop: InteractiveProp, parent: Object3D, w: number, h: number, d: number, look: Finish = "steel", strength = 0.6) {
  const ao = cavityAO(w, h, d, 0, strength)
  for (const x of [-w / 2, w / 2]) box(prop, parent, [0.025, h, d], [x, h / 2, 0], look, true, { ao })
  for (const y of [0.025, h - 0.025]) box(prop, parent, [w, 0.025, d], [0, y, 0], look, true, { ao })
  box(prop, parent, [w, h, 0.025], [0, h / 2, -d / 2], look, true, { ao })
}

/** Socket geometry remains parented to the moving tray/door, so contents travel with it. */
export function itemSocket(prop: InteractiveProp, parent: Object3D, id: string, item: Item, at: V3, part?: string, hanging = false, rotation?: V3) {
  const node = new Group(); node.position.set(...at); parent.add(node)
  if (rotation) node.rotation.set(...rotation)
  itemModel(node, item, hashString(`${prop.id}/${id}`), hanging)
  return prop.socket(id, node, item, part)
}

function drawer(prop: InteractiveProp, parent: Object3D, id: string, text: string, x: number, y: number, w: number, h: number, d: number, card: boolean) {
  const tray = new Group(); tray.position.set(x, y, 0); parent.add(tray)
  const ao: AO = cavityAO(w, h, d, 0, 0.7)
  box(prop, tray, [w, 0.018, d], [0, 0, 0], "inside", true, { ao })
  for (const xx of [-w / 2, w / 2]) box(prop, tray, [0.014, h, d], [xx, h / 2, 0], "inside", true, { ao })
  box(prop, tray, [w, h, 0.018], [0, h / 2, -d / 2], "inside", true, { ao })
  box(prop, tray, [w + 0.02, h + 0.015, 0.025], [0, h / 2, d / 2])
  // Rolled lip along the top of the face.
  block(tray, [w + 0.012, 0.008, 0.012], [0, h + 0.002, d / 2 + 0.006], "steel")
  const handle = pull(prop, tray, 0, h * (card ? 0.68 : 0.55), d / 2 + 0.025)
  if (card) {
    // Card in a chrome holder under the pull.
    for (const [sx, sy, wx, hy] of [[0, 0.028, 0.15, 0.005], [0, -0.028, 0.15, 0.005], [-0.073, 0, 0.005, 0.06], [0.073, 0, 0.005, 0.06]] as const)
      block(tray, [wx, hy, 0.004], [sx, h * 0.38 + sy, d / 2 + 0.0145], "chrome", { shadow: false })
    plate(tray, text, [0, h * 0.38, d / 2 + 0.0135], 0.14, 0.05, "card")
  }
  prop.part(id, text, tray, { kind: "slide", offset: new Vector3(0, 0, d * 0.85) }, handle)
  return tray
}

export function filingCabinet(p: Placement, contents: Item[] = []) {
  const prop = start(p)
  carcass(prop, prop.root, 0.52, 1.25, 0.66)
  block(prop.root, [0.49, 0.06, 0.012], [0, 0.04, 0.3], "inside")
  for (const [i, text] of ["A-G", "H-M", "N-Z"].entries()) {
    const id = `drawer-${i}`, tray = drawer(prop, prop.root, id, text, 0, 0.09 + (2 - i) * 0.38, 0.46, 0.33, 0.6, true)
    const run = fileRun(tray, 0.46, 0.33, 0.6, text, hashString(`${p.id}/${id}`))
    run.node.position.y = 0.009
    prop.reveal(run.node, id)
    if (contents[i]) itemSocket(prop, tray, id, contents[i], [0, 0.009 + run.top + 0.004, 0.03], id)
  }
  finishProp(prop)
  return prop
}

export function desk(p: Placement, contents: Item[] = []) {
  const prop = start(p)
  box(prop, prop.root, [1.5, 0.035, 0.78], [0, 0.765, 0], "wood")
  // Black vinyl T-moulding round the laminate top.
  for (const z of [-0.391, 0.391]) block(prop.root, [1.5, 0.037, 0.006], [0, 0.765, z], "rubber")
  for (const x of [-0.751, 0.751]) block(prop.root, [0.006, 0.037, 0.788], [x, 0.765, 0], "rubber")
  box(prop, prop.root, [1.44, 0.04, 0.72], [0, 0.73, 0], "steel", false)
  for (const z of [-0.33, 0.33]) box(prop, prop.root, [0.035, 0.72, 0.035], [0.69, 0.36, z])
  block(prop.root, [0.035, 0.035, 0.66], [0.69, 0.06, 0], "steel")
  block(prop.root, [0.9, 0.45, 0.012], [0.24, 0.45, -0.35], "steel", { ao: p => 0.55 + 0.45 * (p.y > 0 ? 1 : 0.4) })
  const pedestal = new Group(); pedestal.position.x = -0.48; prop.root.add(pedestal)
  carcass(prop, pedestal, 0.46, 0.72, 0.72)
  const names = ["bottom drawer", "middle drawer", "top drawer"]
  for (let i = 0; i < 3; i++) {
    const id = `drawer-${i}`, tray = drawer(prop, pedestal, id, names[i], 0, 0.08 + i * 0.21, 0.4, 0.17, 0.66, false)
    const clutter = deskClutter(tray, 0.4, 0.66, hashString(`${p.id}/${id}`))
    clutter.position.y = 0.009
    prop.reveal(clutter, id)
    if (i === 2) mesh(tray, new CylinderGeometry(0.009, 0.009, 0.012, 14), "chrome", [0.15, 0.13, 0.66 / 2 + 0.018], { rot: [Math.PI / 2, 0, 0] })
    if (contents[i]) itemSocket(prop, tray, id, contents[i], [0, 0.03, 0.05], id)
  }
  finishProp(prop)
  return prop
}

function swingingDoor(prop: InteractiveProp, w: number, h: number, d: number, text: string, look: Finish, key?: string, thick = 0.025) {
  const hinge = new Group(); hinge.position.set(-w / 2, 0, d / 2); prop.root.add(hinge)
  box(prop, hinge, [w - 0.025, h - 0.06, thick], [w / 2, h / 2, thick / 2 - 0.0125], look)
  for (const y of [0.12, h - 0.12]) mesh(prop.root, new CylinderGeometry(0.008, 0.008, 0.07, 10), "chrome", [-w / 2 - 0.004, y, d / 2 + 0.004])
  const handle = pull(prop, hinge, w - 0.13, h * 0.5, thick - 0.0125 + 0.01, Math.min(0.15, w * 0.3))
  plate(hinge, text, [w / 2, h * 0.82, thick - 0.0125 + 0.001], Math.min(w * 0.6, 0.25), 0.045, "tape")
  prop.part("door", text.toLowerCase(), hinge, { kind: "hinge", axis: "y", angle: -Math.PI * 0.62 }, handle, key)
  return hinge
}

/** Locker door leaf on its pivot (hinge edge at local x = 0, face at +z): louvres, number plate, lift handle,
 *  stiffening channels inside. Returns the handle. */
function lockerLeaf(prop: InteractiveProp, pivot: Object3D, w: number, h: number, number: number, seed: number) {
  const r = rng(seed)
  box(prop, pivot, [w - 0.02, h, 0.02], [w / 2, h / 2 + 0.06, 0], "locker")
  louvres(pivot, w / 2, 1.5, 0.01, 5, w - 0.12)
  louvres(pivot, w / 2, 0.16, 0.01, 4, w - 0.12)
  plate(pivot, String(number), [w / 2, 1.73, 0.011], 0.07, 0.032, "plate")
  for (const sx of [0.03, w - 0.05]) block(pivot, [0.02, h - 0.1, 0.012], [sx, h / 2 + 0.06, -0.016], "lockerInside", { ao: () => 0.7 })
  block(pivot, [0.04, 0.15, 0.006], [w - 0.07, 1.05, 0.012], "slot", { shadow: false })
  block(pivot, [0.05, 0.06, 0.012], [w - 0.07, 1.16, 0.014], "chrome")
  if (r() < 0.5) docs(pivot, [{ id: (["polaroid_corridor", "polaroid_dish", "card_extensions", "sticky_marge", "notice_nightshift"] as const)[Math.floor(r() * 5)], position: [w / 2, 1.55, -0.0102], normal: [0, 0, -1], pin: "tape", curl: 0.15, seed }])
  return box(prop, pivot, [0.026, 0.13, 0.026], [w - 0.07, 1.05, 0.03], "chrome", false)
}

export function locker(p: Placement & { number: number }, contents: Item[] = []) {
  const prop = start(p)
  carcass(prop, prop.root, 0.9, 2.05, 0.9, "locker", 0.65)
  const leaf = swingingDoor(prop, 0.9, 2.05, 0.9, String(p.number).padStart(2, "0"), "locker")
  louvres(leaf, 0.45, 1.7, 0.0125, 4, 0.25)
  prop.hideVolume = new Box3(new Vector3(-0.4, -0.01, -0.4), new Vector3(0.4, 1.8, 0.39))
  lockerFittings(prop, prop.root, -0.43, 0.43, -0.4375, 0.42, hashString(p.id), cavityAO(0.9, 2.05, 0.9, 0, 0.65))
  contents.forEach((item, i) => itemSocket(prop, prop.root, `shelf-${i}`, item, [-0.23 + i * 0.23, 1.78, 0.08], "door"))
  // An inside pull can be reached without aiming through the closed door.
  const handle = pull(prop, leaf, 0.7, 0.95, -0.06)
  prop.targets.push({ id: `${p.id}/inside-pull`, node: handle, label: () => prop.parts.get("door")!.target ? "Close locker" : "Open locker", use: () => prop.toggle("door"), available: () => true })
  finishProp(prop)
  return prop
}

/** Paired doors share a walk-in compartment while retaining the original bank's width and numbering. */
export function lockerBank(p: Placement, count: number, first: number, contents: (number: number) => Item[]) {
  const prop = start(p), width = count * 0.38, depth = 0.8, height = 1.92
  const ao = cavityAO(width, height, depth, 0, 0.7)
  carcass(prop, prop.root, width, height, depth, "locker", 0.7)
  for (let i = 0; i < count; i++) {
    const number = first + count - 1 - i, id = `locker-${number}`, x = -width / 2 + i * 0.38
    const right = i % 2 === 1
    const pivot = new Group(); pivot.position.set(x + (right ? 0.38 : 0), 0, depth / 2); pivot.scale.x = right ? -1 : 1; prop.root.add(pivot)
    const handle = lockerLeaf(prop, pivot, 0.38, 1.82, number, hashString(`${p.id}/${id}`))
    prop.part(id, `locker ${number}`, pivot, { kind: "hinge", axis: "y", angle: (right ? 1 : -1) * Math.PI * 0.6 }, handle)
    const inside = box(prop, pivot, [0.026, 0.1, 0.02], [0.3, 1.05, -0.03], "chrome", false)
    prop.targets.push({ id: `${p.id}/${id}/inside`, node: inside, label: () => `${prop.parts.get(id)!.target ? "Close" : "Open"} locker ${number}`, use: () => prop.toggle(id), available: () => true })
    // Contents hang on the inside of the door; the node cancels a mirrored leaf so print reads the right way.
    contents(number).forEach((item, j) => {
      const at: V3 = [0.15 + j * 0.08, item.kind === "key" ? 1.42 : 1.28, -0.0105]
      if (item.kind === "key") block(pivot, [0.006, 0.006, 0.02], [at[0], at[1] + 0.003, -0.02], "chrome")
      const socket = itemSocket(prop, pivot, `${id}-${j}`, item, item.kind === "key" ? [at[0], at[1], -0.028] : at, id, item.kind === "key", item.kind === "key" ? undefined : [-Math.PI / 2, Math.PI, 0])
      if (right) socket.node.scale.x = -1
    })
    if (i % 2 === 0) {
      const x1 = i + 1 < count ? x + 0.76 : x + 0.38
      if (i + 1 < count) prop.hidingCompartments.push({ volume: new Box3(new Vector3(x + 0.026, -0.01, -0.36), new Vector3(x + 0.734, 1.84, 0.36)), doors: [id, `locker-${number - 1}`] })
      if (i > 0) box(prop, prop.root, [0.018, 1.84, depth], [x, 0.96, 0], "lockerInside", true, { ao })
      lockerFittings(prop, prop.root, x + 0.02, x1 - 0.02, -depth / 2 + 0.0125, depth / 2 - 0.02, hashString(`${p.id}/${i}`), ao)
    }
  }
  finishProp(prop)
  return prop
}

export function keyCabinet(p: Placement & { key?: string }, keys: { number: number; item: Item }[]) {
  if (new Set(keys.map(k => k.number)).size !== keys.length || keys.some(k => !Number.isInteger(k.number) || k.number < 1 || k.number > 10)) throw new Error("Key cabinet hooks must be unique numbers 1–10")
  const prop = start(p)
  carcass(prop, prop.root, 0.62, 0.75, 0.14, "enamel", 0.5)
  box(prop, prop.root, [0.57, 0.7, 0.008], [0, 0.375, -0.05], "board", false, { ao: cavityAO(0.62, 0.75, 0.14, 0, 0.4) })
  const leaf = swingingDoor(prop, 0.62, 0.75, 0.14, "KEY REGISTER", "enamel", p.key)
  mesh(leaf, new CylinderGeometry(0.011, 0.011, 0.012, 16), "chrome", [0.56, 0.42, 0.018], { rot: [Math.PI / 2, 0, 0] })
  for (let i = 0; i < 10; i++) {
    const x = -0.24 + (i % 5) * 0.12, y = 0.57 - Math.floor(i / 5) * 0.29
    plate(prop.root, String(i + 1), [x, y + 0.06, -0.045], 0.06, 0.024, "card")
    block(prop.root, [0.006, 0.006, 0.04], [x, y, -0.026], "brass")
    block(prop.root, [0.006, 0.012, 0.006], [x, y + 0.006, -0.006], "brass")
    const key = keys.find(k => k.number === i + 1)
    if (key) itemSocket(prop, prop.root, `hook-${i + 1}`, key.item, [x, y - 0.003, -0.012], "door", true)
  }
  finishProp(prop)
  return prop
}

export function wallSafe(p: Placement & { combination: readonly [number, number, number] }, contents: Item[] = []) {
  if (p.combination.some(n => !Number.isInteger(n) || n < 0 || n > 9)) throw new Error("Safe combination must contain three digits")
  const prop = start(p)
  carcass(prop, prop.root, 0.62, 0.6, 0.38, "safe", 0.75)
  block(prop.root, [0.55, 0.03, 0.33], [0, 0.04, -0.01], "safeInside")
  block(prop.root, [0.55, 0.012, 0.3], [0, 0.33, -0.025], "safeInside", { ao: () => 0.7 })
  box(prop, prop.root, [0.2, 0.08, 0.14], [-0.12, 0.376, -0.06], "board", false)
  const leaf = swingingDoor(prop, 0.62, 0.6, 0.38, "SECURITY", "safe", undefined, 0.06)
  for (const [x, y, w, h] of [[0.31, 0.05, 0.5, 0.012], [0.31, 0.55, 0.5, 0.012], [0.06, 0.3, 0.012, 0.5], [0.56, 0.3, 0.012, 0.5]] as const) block(leaf, [w, h, 0.006], [x, y, 0.05], "chrome")
  prop.combination = p.combination
  const wheels: Mesh[] = []
  for (let i = 0; i < 3; i++) {
    const wheel = mesh(leaf, new CylinderGeometry(0.028, 0.03, 0.03, 24), "chrome", [0.2 + i * 0.07, 0.3, 0.06], { rot: [Math.PI / 2, 0, 0], keep: true })
    mesh(leaf, new TorusGeometry(0.033, 0.003, 6, 24), "nickel", [0.2 + i * 0.07, 0.3, 0.05])
    block(wheel, [0.004, 0.006, 0.018], [0, 0.016, -0.02], "slot", { shadow: false })
    wheels.push(wheel)
    prop.targets.push({ id: `${p.id}/dial-${i}`, node: wheel, label: () => `Dial ${i + 1}: ${prop.digits[i]}`, available: () => prop.parts.get("door")!.amount < 0.08,
      use: () => { prop.digits[i] = (prop.digits[i] + 1) % 10; wheel.rotation.y = prop.digits[i] * Math.PI / 5; return true } })
  }
  prop.onRestore = () => wheels.forEach((wheel, i) => { wheel.rotation.y = prop.digits[i] * Math.PI / 5 })
  docs(prop.root, [0, 1, 2, 3].map(i => ({ id: (["memo_next_of_kin", "letter_regret", "roster_field_team", "work_order_halt"] as const)[i], position: [0.14 + (i % 2) * 0.01, 0.056 + i * 0.002, -0.04 + i * 0.006] as const, normal: [0, 1, 0] as const, up: [0, 0, -1] as const, rotation: (i - 1.5) * 0.08, pin: "none" as const, curl: 0.06, scale: 0.9, seed: 40 + i })))
  contents.forEach((item, i) => itemSocket(prop, prop.root, `safe-${i}`, item, [i ? 0.07 : -0.16, i ? 0.066 : 0.056, 0], "door"))
  finishProp(prop)
  return prop
}

export function breaker(p: Placement, onChange: (on: boolean) => void) {
  const prop = start(p)
  box(prop, prop.root, [0.36, 0.55, 0.1], [0, 0.275, 0], "enamel")
  plate(prop.root, `FLOOR ${p.storey}`, [0, 0.46, 0.0505], 0.25, 0.045, "tape")
  const pivot = new Group(); pivot.position.set(0, 0.25, 0.07); prop.root.add(pivot)
  const handle = box(prop, pivot, [0.11, 0.18, 0.06], [0, 0.06, 0.02], "rubber", false)
  prop.part("switch", "breaker", pivot, { kind: "hinge", axis: "x", angle: Math.PI / 3 }, handle)
  const target = prop.targets[0]
  target.label = () => prop.powered ? "Switch floor power off" : "Switch floor power on"
  target.use = () => { if (!prop.toggle("switch")) return false; prop.powered = prop.parts.get("switch")!.target === 0; onChange(prop.powered); return true }
  prop.onRestore = () => onChange(prop.powered)
  finishProp(prop)
  return prop
}

export function mobileShelving(p: Placement, travel = 1.15, length = 2.1) {
  if (!Number.isFinite(travel) || travel <= 0) throw new Error("Shelving travel must be positive")
  const prop = start(p)
  const r = rng(hashString(p.id))
  for (const z of [-length * 0.4, length * 0.4]) box(prop, prop.root, [travel + 0.85, 0.012, 0.035], [travel / 2, 0.008, z], "chrome", false)
  const carriage = new Group(); prop.root.add(carriage)
  for (const x of [-0.37, 0.37]) box(prop, carriage, [0.025, 2.2, length], [x, 1.13, 0], "enamel")
  for (let y = 0.05; y <= 2.2; y += 0.43) {
    box(prop, carriage, [0.74, 0.025, length], [0, y, 0], "inside")
    if (y < 2) for (let z = -length / 2 + 0.3; z < length / 2 - 0.2; z += 0.48) {
      const lean = (r() - 0.5) * 0.04
      box(prop, carriage, [0.56 - r() * 0.04, 0.27 + r() * 0.03, 0.4], [(r() - 0.5) * 0.04, y + 0.15, z + (r() - 0.5) * 0.03], "manila", false, { rot: [0, lean, 0], ao: q => 0.55 + 0.45 * Math.min(1, Math.max(0, (q.y - y) / 0.28)) })
    }
  }
  box(prop, carriage, [0.74, 2.2, 0.025], [0, 1.13, length / 2], "enamel")
  const wheel = mesh(carriage, new TorusGeometry(0.16, 0.012, 8, 32), "chrome", [0, 1.1, length / 2 + 0.07], { keep: true })
  for (let i = 0; i < 3; i++) { const spoke = block(wheel, [0.31, 0.012, 0.012], [0, 0, 0], "chrome"); spoke.rotation.z = i * Math.PI / 3 }
  prop.part("carriage", "shelving aisle", carriage, { kind: "slide", offset: new Vector3(travel, 0, 0) }, wheel)
  plate(carriage, "MOBILE RECORDS", [0, 1.55, length / 2 + 0.014], 0.5, 0.05, "tape")
  const update = prop.update.bind(prop)
  prop.update = dt => { update(dt); wheel.rotation.z = prop.parts.get("carriage")!.amount * Math.PI * 4 }
  finishProp(prop)
  return prop
}

/** Putty-plastic 1980s terminal: deep tube housing with a recessed bezel round the live screen, vents, a badge, a
 *  power lamp and a detached keyboard. The screen itself is drawn by ThreeTerminal on `glass`. */
export function terminalHousing(p: Placement, terminal: Terminal) {
  const prop = start(p)
  const putty: AO = q => 0.75 + 0.25 * Math.min(1, Math.max(0, q.y / 0.4))
  box(prop, prop.root, [0.54, 0.38, 0.32], [0, 0.26, 0.02], "putty", true, { ao: putty })
  box(prop, prop.root, [0.42, 0.3, 0.22], [0, 0.25, -0.2], "putty", false, { ao: q => 0.65 + 0.35 * (q.z > -0.25 ? 1 : 0.5) })
  box(prop, prop.root, [0.23, 0.07, 0.22], [0, 0.035, 0], "putty")
  for (let i = 0; i < 9; i++) block(prop.root, [0.3, 0.004, 0.012], [0, 0.451, -0.06 + i * 0.022], "slot", { shadow: false })
  // Bezel: thick frame proud of the glass, so the tube face sits recessed.
  for (const x of [-0.25, 0.25]) box(prop, prop.root, [0.04, 0.38, 0.06], [x, 0.25, 0.205], "putty", false)
  for (const y of [0.085, 0.415]) box(prop, prop.root, [0.54, 0.04, 0.06], [0, y, 0.205], "putty", false)
  block(prop.root, [0.012, 0.006, 0.004], [0.2, 0.08, 0.2365], "led", { shadow: false })
  plate(prop.root, "ASHWOOD VT-84", [-0.15, 0.08, 0.2355], 0.12, 0.018, "tape")
  const keyboard = box(prop, prop.root, [0.5, 0.035, 0.2], [0, 0.025, 0.39], "putty")
  for (let row = 0; row < 4; row++) for (let col = 0; col < 12; col++) {
    const dark = col === 0 || col === 11
    block(prop.root, [0.03, 0.012, 0.032], [-0.215 + col * 0.038 + row * 0.006, 0.048, 0.315 + row * 0.039], dark ? "keycapDark" : "keycap", { shadow: false, rot: [0.08, 0, 0] })
  }
  block(prop.root, [0.22, 0.012, 0.03], [0.01, 0.048, 0.47], "keycap", { shadow: false })
  prop.targets.push({ id: `${p.id}/terminal`, node: keyboard, label: () => "Use terminal", available: () => terminal.services.powered(), use: () => terminal.enter() })
  const glass = new Group(); glass.position.set(0, 0.25, 0.216); prop.root.add(glass)
  finishProp(prop)
  prop.root.updateWorldMatrix(true, true)
  return { prop, glass, terminal, placement: { center: glass.getWorldPosition(new Vector3()).toArray() as [number, number, number], yaw: Math.PI / 2 - (p.yaw ?? 0), width: 0.46, height: 0.29 } }
}

